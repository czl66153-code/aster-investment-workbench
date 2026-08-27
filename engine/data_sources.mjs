import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { databasePath, projectDir, shanghaiDate } from "./core.mjs";
import { runProviderBridge } from "./provider_bridge.mjs";
import { latestPublishedVersion, linkDatasetVersion, recordAcquisitionBatch, resolveOpenAlert } from "./maintenance.mjs";

const marketDatabasePath = process.env.ASTER_MARKET_DB || process.env.QUANT_DB_PATH || join(projectDir, "data", "market.duckdb");
const INTRADAY_UNIT_VERSION = "aster_intraday_units_v1";
const DAILY_CANONICAL_UNIT_VERSION = "aster_daily_share_cny_v1";
const DAILY_LEGACY_UNIT_VERSION = "tushare_daily_lot_thousand_cny_v1";
const INTRADAY_CANONICAL_UNITS = Object.freeze({
  price: "CNY_per_share",
  pct_chg: "percentage_point",
  volume: "share",
  amount: "CNY",
  turnover_rate: "percentage_point",
});

function numeric(value, fallback = null) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nullableNumeric(value) {
  if (value == null || String(value).trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function legacyDailyUnits(volumeShares, amountCny) {
  const volume = nullableNumeric(volumeShares);
  const amount = nullableNumeric(amountCny);
  return {
    volume: volume == null ? null : volume / 100,
    amount: amount == null ? null : amount / 1000,
  };
}

function normalizedDate(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/[^0-9]/g, "");
  if (/^20\d{6}/.test(compact)) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const match = text.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function addDailyCandidateRanks(rows, rankPayload = null) {
  const eligible = rows.filter((row) => !/^\*?ST|退市|退\b/i.test(String(row.name || "")));
  const rankMap = (key, days) => {
    const cached = rankPayload?.stock_rank?.[`stock_${days}d_gain_list`];
    if (Array.isArray(cached) && cached.length) return new Map(cached.map((row, index) => [String(row.stock_code), index + 1]));
    return new Map(eligible
      .filter((row) => Number.isFinite(Number(row[key])))
      .sort((left, right) => Number(right[key]) - Number(left[key]) || String(left.code || left.ts_code).localeCompare(String(right.code || right.ts_code)))
      .map((row, index) => [String(row.code || row.ts_code), index + 1]));
  };
  const rank5 = rankMap("ret_5d", 5);
  const rank10 = rankMap("ret_10d", 10);
  const rank30 = rankMap("ret_30d", 30);
  const rank60 = rankMap("ret_60d", 60);
  const streakRows = rankPayload?.sector_rank?.sector_4d_streak_list || rankPayload?.sector_rank?.sector_4d_streak_top10 || [];
  const streakIndustries = new Set(streakRows.flatMap((item) => [item.sector_name, item.sector_main_industry, item.industry].filter(Boolean).map(String)));
  const sectorGroups = new Map();
  for (const row of eligible) {
    const industry = String(row.industry || "其他");
    if (!sectorGroups.has(industry)) sectorGroups.set(industry, []);
    if (Number.isFinite(Number(row.ret_5d))) sectorGroups.get(industry).push(Number(row.ret_5d));
  }
  const sectorStats = [...sectorGroups].filter(([, values]) => values.length >= 5).map(([industry, values]) => ({
    industry,
    ret: values.reduce((sum, value) => sum + value, 0) / values.length,
  })).sort((left, right) => right.ret - left.ret || left.industry.localeCompare(right.industry, "zh-CN"));
  const sectorByName = new Map(sectorStats.map((item, index) => [item.industry, { ret: item.ret, rank: index + 1, rankPct: (index + 1) * 100 / sectorStats.length }]));
  return rows.map((row) => {
    const code = String(row.code || row.ts_code);
    const stockRank5 = rank5.get(code) || null;
    const stockRank10 = rank10.get(code) || null;
    const stockRank30 = rank30.get(code) || null;
    const stockRank60 = rank60.get(code) || null;
    const sector = sectorByName.get(String(row.industry || "其他")) || {};
    return {
      ...row,
      stock_ret_5d_rank: stockRank5,
      stock_ret_10d_rank: stockRank10,
      stock_ret_30d_rank: stockRank30,
      stock_ret_60d_rank: stockRank60,
      stock_top50_5_10_30: Number(Boolean(stockRank5 && stockRank5 <= 50 && stockRank10 && stockRank10 <= 50 && stockRank30 && stockRank30 <= 50)),
      sector_ret_5d: sector.ret ?? null,
      sector_ret_5d_rank: sector.rank ?? null,
      sector_ret_5d_rank_pct: sector.rankPct ?? null,
      sector_4d_streak: streakIndustries.has(String(row.industry || "其他")) ? 1 : 0,
    };
  });
}

function readMetadataJson(db, key, fallback = {}) {
  const raw = db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value;
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function writeMetadataJson(db, key, value) {
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .run(key, JSON.stringify(value));
}

export function marketDataState(db) {
  return readMetadataJson(db, "market_data_state", {});
}

export function markOfficialMarketDataPending(db, { targetDate, attempt = 0, error = "", nextRetryAt = null } = {}) {
  const previous = marketDataState(db);
  const state = {
    ...previous,
    updatedAt: new Date().toISOString(),
    official: {
      ...(previous.official || {}),
      status: error ? "retrying" : "waiting",
      targetTradeDate: targetDate || previous.official?.targetTradeDate || null,
      attempt,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt,
      error: error || "",
    },
  };
  writeMetadataJson(db, "market_data_state", state);
  return state;
}

export function activateOfficialMarketData(db, { tradeDate, coverage, providers, cycle } = {}) {
  const now = new Date().toISOString();
  const state = {
    mode: "official",
    modeLabel: "BigQuant + Tushare正式日线",
    activeTradeDate: tradeDate,
    quoteTradeDate: null,
    quoteAsOf: null,
    updatedAt: now,
    coverage: coverage || null,
    source: "bigquant_official+tushare_official",
    official: {
      status: "ready",
      targetTradeDate: tradeDate,
      tradeDate,
      publishedAt: now,
      providers: providers || {},
      cycle: cycle || {},
      attempt: 0,
      lastAttemptAt: now,
      nextRetryAt: null,
      error: "",
    },
  };
  writeMetadataJson(db, "market_data_state", state);
  return state;
}

export async function refreshAkshareQuotes(db) {
  const securities = db.prepare("SELECT code,name FROM securities ORDER BY code").all();
  const allowed = new Map(securities.map((row) => [row.code, row]));
  const payload = await runProviderBridge("intraday-quotes", {
    codes: [...allowed.keys()],
    database: marketDatabasePath,
    sqlite_database: databasePath,
  }, { timeoutMs: 90_000 });
  const quoteTradeDate = shanghaiDate();
  const latestFloatShareDate = db.prepare("SELECT MAX(trade_date) AS date FROM daily_basic WHERE float_share>0").get()?.date || null;
  const floatShares = new Map((latestFloatShareDate
    ? db.prepare("SELECT code,float_share FROM daily_basic WHERE trade_date=? AND float_share>0").all(latestFloatShareDate)
    : []).map((row) => [row.code, nullableNumeric(row.float_share)]));
  const rejected = [...(payload.unit_rejections || [])];
  const rawRows = (payload.quotes || []).filter((row) => {
    const source = String(row.source || payload.source || "").toLowerCase();
    return allowed.has(row.code) && numeric(row.price, 0) > 0 && source.startsWith("akshare_") && normalizedDate(row.quote_time || row.received_at) === quoteTradeDate;
  });
  const rows = [];
  let turnoverOverrides = 0;
  for (const row of rawRows) {
    const units = row.units || {};
    const unitContractValid = row.unit_version === INTRADAY_UNIT_VERSION
      && Object.entries(INTRADAY_CANONICAL_UNITS).every(([field, unit]) => units[field] === unit);
    const price = nullableNumeric(row.price);
    const volume = nullableNumeric(row.volume);
    const amount = nullableNumeric(row.amount);
    const pctChg = nullableNumeric(row.pct_chg);
    if (!unitContractValid || price == null || price <= 0 || price > 100_000
      || volume == null || volume < 0 || volume > 1e13
      || amount == null || amount < 0 || amount > 1e16
      || (pctChg != null && (pctChg < -1_000 || pctChg > 1_000))) {
      if (rejected.length < 50) rejected.push(`${row.source || payload.source}:${row.code}:canonical unit/range gate failed`);
      continue;
    }
    if (volume > 0 && amount > 0) {
      const vwapRatio = amount / volume / price;
      if (vwapRatio < .2 || vwapRatio > 5) {
        if (rejected.length < 50) rejected.push(`${row.source || payload.source}:${row.code}:amount/volume ratio=${vwapRatio.toFixed(4)}`);
        continue;
      }
    }
    const providerTurnover = nullableNumeric(row.turnover_rate);
    const floatShare10k = floatShares.get(row.code);
    const calculatedTurnover = floatShare10k > 0 ? volume / (floatShare10k * 10_000) * 100 : null;
    if (calculatedTurnover != null && (calculatedTurnover < 0 || calculatedTurnover > 300)) {
      if (rejected.length < 50) rejected.push(`${row.source || payload.source}:${row.code}:calculated turnover=${calculatedTurnover}`);
      continue;
    }
    const providerTurnoverValid = providerTurnover != null && providerTurnover >= 0 && providerTurnover <= 300;
    const providerMatches = calculatedTurnover != null && providerTurnoverValid
      ? Math.abs(providerTurnover - calculatedTurnover) <= Math.max(.15, calculatedTurnover * .05)
      : false;
    if (calculatedTurnover != null && providerTurnoverValid && !providerMatches) turnoverOverrides += 1;
    const turnoverRate = calculatedTurnover ?? (providerTurnoverValid ? providerTurnover : null);
    rows.push({
      ...row,
      price,
      volume,
      amount,
      pct_chg: pctChg,
      turnover_rate: turnoverRate,
      unit_version: INTRADAY_UNIT_VERSION,
      turnover_source: calculatedTurnover != null
        ? (providerMatches ? "provider_verified_by_formal_float_share" : "formal_float_share_recomputed")
        : (providerTurnoverValid ? "provider_canonical_fallback" : "missing_float_share"),
      unit_audit_json: JSON.stringify({
        unitVersion: INTRADAY_UNIT_VERSION,
        sourceContract: row.raw_unit_contract || null,
        providerTurnover,
        calculatedTurnover,
        floatShare10k: floatShare10k || null,
        floatShareTradeDate: latestFloatShareDate,
      }),
    });
  }
  const minimum = Math.max(1, Math.ceil(securities.length * .95));
  if (rows.length < minimum) throw new Error(`AKShare当日盘中行情仅${rows.length}/${securities.length}只，低于95%发布门禁${minimum}`);
  const turnoverCount = rows.filter((row) => nullableNumeric(row.turnover_rate) != null).length;
  if (turnoverCount < minimum) throw new Error(`盘中换手率统一口径仅${turnoverCount}/${securities.length}只，低于95%发布门禁${minimum}`);
  const receivedAt = new Date().toISOString();
  const quoteAsOf = rows.map((row) => String(row.quote_time || row.received_at || "")).filter(Boolean).map((value) => ({
    value,
    rank: value.replace(/[^0-9]/g, "").slice(0, 14).padEnd(14, "0"),
  })).filter((item) => /^20\d{12}$/.test(item.rank)).sort((left, right) => left.rank.localeCompare(right.rank)).at(-1)?.value || receivedAt;
  const sourceNames = [...new Set(rows.map((row) => String(row.source || payload.source || "akshare_spot")))].sort();
  const checksum = createHash("sha256").update(JSON.stringify(rows.map((row) => [row.code, row.price, row.quote_time]).sort())).digest("hex");
  const official = db.prepare("SELECT trade_date,published_at,row_count,source FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get();
  const previousState = marketDataState(db);
  const upsert = db.prepare(`INSERT INTO realtime_quotes(code,name,price,open_price,prev_close,pct_chg,volume,amount,turnover_rate,unit_version,turnover_source,unit_audit_json,quote_time,source,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,price=excluded.price,open_price=excluded.open_price,prev_close=excluded.prev_close,pct_chg=excluded.pct_chg,volume=excluded.volume,amount=excluded.amount,turnover_rate=excluded.turnover_rate,unit_version=excluded.unit_version,turnover_source=excluded.turnover_source,unit_audit_json=excluded.unit_audit_json,quote_time=excluded.quote_time,source=excluded.source,received_at=excluded.received_at`);
  const versionId = `intraday-akshare-${quoteTradeDate}-${Date.now()}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const security = allowed.get(row.code);
      upsert.run(row.code, row.name || security.name, row.price, row.open_price, row.prev_close, row.pct_chg, row.volume, row.amount, row.turnover_rate, row.unit_version, row.turnover_source, row.unit_audit_json, row.quote_time, row.source || payload.source || "akshare_spot", row.received_at || receivedAt);
    }
    // realtime_quotes is a current-snapshot table, not a historical ledger.
    // Remove prior-session holdovers only after the new batch passed both
    // coverage gates and was fully upserted inside this transaction.
    db.prepare("DELETE FROM realtime_quotes WHERE substr(quote_time,1,10)<>?").run(quoteTradeDate);
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='intraday_quotes' AND status='published'").run();
    db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES('intraday_quotes',?,?,?,?,'published',?, ?,?,?)")
      .run(versionId, quoteTradeDate, rows.length, checksum, sourceNames.join("+"), rows.length * 100 / securities.length, receivedAt, receivedAt);
    recordAcquisitionBatch(db, { batchId: versionId, datasetKey: "intraday_quotes", providerKey: sourceNames.join("+"), sessionType: "intraday", tradeDate: quoteTradeDate, asOf: quoteAsOf, rowCount: rows.length, checksum, storageLayer: "sqlite:realtime_quotes", metadata: { expected: securities.length, coverage: rows.length / securities.length, unitVersion: INTRADAY_UNIT_VERSION, canonicalUnits: INTRADAY_CANONICAL_UNITS, sourceContracts: payload.unit_contracts || {}, rejectedRows: rejected.length, turnoverCoverage: turnoverCount / securities.length, turnoverOverrides, floatShareTradeDate: latestFloatShareDate } });
    writeMetadataJson(db, "market_data_state", {
      ...previousState,
      mode: "intraday",
      modeLabel: "AKShare盘中临时行情",
      activeTradeDate: official?.trade_date || previousState.activeTradeDate || null,
      quoteTradeDate,
      quoteAsOf,
      updatedAt: receivedAt,
      coverage: { received: rows.length, expected: securities.length, ratio: rows.length / securities.length, turnover: turnoverCount, turnoverRatio: turnoverCount / securities.length },
      source: sourceNames.join("+"),
      official: { ...(previousState.official || {}), tradeDate: official?.trade_date || previousState.official?.tradeDate || null },
    });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { count: rows.length, versionId, source: sourceNames, tradeDate: quoteTradeDate, quoteAsOf, coverage: rows.length / securities.length, turnoverCoverage: turnoverCount / securities.length, turnoverOverrides, unitVersion: INTRADAY_UNIT_VERSION, rejected: rejected.length, message: `AKShare盘中行情更新${rows.length}只，单位及换手率覆盖双门禁通过` };
}

export async function refreshAkshareM30(db, codes, limit = 80) {
  const allowed = new Set(db.prepare("SELECT code FROM securities").all().map((row) => row.code));
  const requested = [...new Set(codes)].filter((code) => allowed.has(code)).slice(0, 80);
  if (!requested.length) return { count: 0, failures: [], message: "没有需要更新的30分钟K线" };
  const payload = await runProviderBridge("intraday-m30", { codes: requested, days: 60 }, { timeoutMs: 5 * 60_000 });
  if (payload.unit_version !== INTRADAY_UNIT_VERSION) throw new Error(`AKShare 30分钟K线单位契约缺失：${payload.unit_version || "missing"}`);
  const byCode = new Map(requested.map((code) => [code, []]));
  for (const row of payload.bars || []) {
    const volume = nullableNumeric(row.volume);
    const amount = nullableNumeric(row.amount);
    if (byCode.has(row.code) && row.unit_version === INTRADAY_UNIT_VERSION && volume != null && volume >= 0 && amount != null && amount >= 0) byCode.get(row.code).push(row);
  }
  const selected = [];
  for (const rows of byCode.values()) selected.push(...rows.sort((a, b) => String(a.trade_time).localeCompare(String(b.trade_time))).slice(-Math.max(30, Math.min(160, limit))));
  if (!selected.length) throw new Error("AKShare未返回有效30分钟K线");
  const upsert = db.prepare(`INSERT INTO bars_30m(code,trade_time,open,high,low,close,volume,amount,source,unit_version,volume_unit,amount_unit,unit_repair_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(code,trade_time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,amount=excluded.amount,source=excluded.source,unit_version=excluded.unit_version,volume_unit=excluded.volume_unit,amount_unit=excluded.amount_unit,unit_repair_note=NULL`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of selected) upsert.run(row.code, row.trade_time, row.open, row.high, row.low, row.close, row.volume, row.amount, row.source || "akshare_m30", INTRADAY_UNIT_VERSION, "share", "CNY");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { count: selected.length, failures: payload.failures || [], sources: payload.sources || [], message: `AKShare 30分钟K线更新${selected.length}根` };
}

export async function syncPublicNews(db) {
  // 公开源适配器的最小可用实现：RSSHub/官方源可通过环境变量替换，失败时不污染已发布证据库。
  const endpoint = process.env.ASTER_NEWS_JSON_URL;
  if (!endpoint) return { count: 0, message: "未配置独立新闻采集地址，继续使用本地证据库" };
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`新闻源返回${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.items || payload.rows || [];
  const insert = db.prepare(`INSERT INTO news_evidence(evidence_id,title,content,source,url,published_at,related_codes,industry,sentiment,relevance,raw_json,imported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(evidence_id) DO NOTHING`);
  let changed = 0;
  for (const row of rows) {
    const published = String(row.published_at || row.publish_time || "");
    if (!/^20\d{2}-\d{2}-\d{2}/.test(published)) continue;
    const id = createHash("sha1").update(`${row.source}|${row.url}|${row.title}`).digest("hex");
    const result = insert.run(id, row.title || "未命名资讯", row.content || row.summary || "", row.source || "独立新闻源", row.url || "", published, JSON.stringify(row.related_codes || []), row.industry || null, numeric(row.sentiment), numeric(row.relevance, .5), JSON.stringify(row));
    changed += Number(result.changes || 0);
  }
  return { count: changed, message: `独立新闻源新增${changed}条` };
}

function shiftedIsoDate(value, offsetDays) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function betterProvider(current, candidate, priorities) {
  if (!current) return candidate;
  return Number(priorities[candidate.provider] || 0) > Number(priorities[current.provider] || 0) ? candidate : current;
}

export async function refreshOfficialDailyBars(db, codes = null, options = {}) {
  const universe = codes?.length ? [...new Set(codes)] : db.prepare("SELECT code FROM securities ORDER BY code").all().map((row) => row.code);
  const allowed = new Set(universe);
  const latest = db.prepare("SELECT MAX(trade_date) AS date,COUNT(*) AS count FROM bars_daily").get();
  const end = options.endDate || shanghaiDate();
  const start = options.startDate || shiftedIsoDate(latest?.date || end, latest?.count ? -10 : -220);
  const payload = await runProviderBridge("formal-daily", { start, end, codes: universe }, { timeoutMs: 20 * 60_000 });
  if (!payload.providers?.bigquant?.ok || !payload.providers?.tushare?.ok) throw new Error("正式日线要求BigQuant与Tushare同时成功，当前批次拒绝发布");
  const rawBars = (payload.bars || []).filter((row) => allowed.has(row.code) && numeric(row.close, 0) > 0 && /^20\d{2}-\d{2}-\d{2}$/.test(row.trade_date));
  const rawBasics = (payload.basics || []).filter((row) => allowed.has(row.code) && /^20\d{2}-\d{2}-\d{2}$/.test(row.trade_date));
  const bars = new Map();
  const basics = new Map();
  const barPriority = { tushare_official: 1, bigquant_official: 2 };
  const basicPriority = { bigquant_official: 1, tushare_official: 2 };
  for (const row of rawBars) { const key = `${row.code}|${row.trade_date}`; bars.set(key, betterProvider(bars.get(key), row, barPriority)); }
  for (const row of rawBasics) { const key = `${row.code}|${row.trade_date}`; basics.set(key, betterProvider(basics.get(key), row, basicPriority)); }
  const latestDate = [...bars.values()].map((row) => row.trade_date).sort().at(-1);
  const latestCoverage = [...bars.values()].filter((row) => row.trade_date === latestDate).length;
  const minimum = Math.max(1, Math.ceil(universe.length * .95));
  if (!latestDate || latestCoverage < minimum) throw new Error(`正式日线最新截面${latestDate || "无"}仅${latestCoverage}/${universe.length}只，低于发布门禁${minimum}`);
  const bigquantLatest = rawBars.filter((row) => row.provider === "bigquant_official" && row.trade_date === latestDate).length;
  const tushareLatest = rawBars.filter((row) => row.provider === "tushare_official" && row.trade_date === latestDate).length;
  const tushareBasicLatest = rawBasics.filter((row) => row.provider === "tushare_official" && row.trade_date === latestDate && numeric(row.turnover_rate) != null).length;
  if (bigquantLatest < minimum || tushareLatest < minimum || tushareBasicLatest < minimum) {
    throw new Error(`正式日线双源同截面门禁失败：${latestDate} BigQuant=${bigquantLatest}、Tushare日线=${tushareLatest}、Tushare基础=${tushareBasicLatest}，要求各≥${minimum}`);
  }
  const warehouse = await runProviderBridge("warehouse-publish-official", { database: marketDatabasePath, bars: rawBars, basics: rawBasics }, { timeoutMs: 10 * 60_000, maximumBytes: 8 * 1024 * 1024 });
  if (warehouse.trade_date !== latestDate || Number(warehouse.daily_rows || 0) < minimum || Number(warehouse.basic_rows || 0) < minimum) throw new Error(`共享仓库发布校验失败：${JSON.stringify({ latestDate, warehouseDate: warehouse.trade_date, daily: warehouse.daily_rows, basic: warehouse.basic_rows, minimum })}`);

  const insertRawBar = db.prepare(`INSERT INTO raw_daily_bars(provider,code,trade_date,open,high,low,close,pre_close,pct_chg,volume,amount,adj_factor,unit_version,volume_unit,amount_unit,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(provider,code,trade_date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,pre_close=excluded.pre_close,pct_chg=excluded.pct_chg,volume=excluded.volume,amount=excluded.amount,adj_factor=excluded.adj_factor,unit_version=excluded.unit_version,volume_unit=excluded.volume_unit,amount_unit=excluded.amount_unit,received_at=CURRENT_TIMESTAMP`);
  const insertRawBasic = db.prepare(`INSERT INTO raw_daily_basic(provider,code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,float_share,free_share,total_mv,circ_mv,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(provider,code,trade_date) DO UPDATE SET close=excluded.close,turnover_rate=excluded.turnover_rate,turnover_rate_f=excluded.turnover_rate_f,volume_ratio=excluded.volume_ratio,float_share=excluded.float_share,free_share=excluded.free_share,total_mv=excluded.total_mv,circ_mv=excluded.circ_mv,received_at=CURRENT_TIMESTAMP`);
  const publishBar = db.prepare(`INSERT INTO bars_daily(code,trade_date,open,high,low,close,volume,amount,unit_version,volume_unit,amount_unit,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code,trade_date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,amount=excluded.amount,unit_version=excluded.unit_version,volume_unit=excluded.volume_unit,amount_unit=excluded.amount_unit,source=excluded.source,imported_at=CURRENT_TIMESTAMP`);
  const publishBasic = db.prepare(`INSERT INTO daily_basic(code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,float_share,free_share,total_mv,circ_mv,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code,trade_date) DO UPDATE SET close=excluded.close,turnover_rate=excluded.turnover_rate,turnover_rate_f=excluded.turnover_rate_f,volume_ratio=excluded.volume_ratio,float_share=excluded.float_share,free_share=excluded.free_share,total_mv=excluded.total_mv,circ_mv=excluded.circ_mv,source=excluded.source,imported_at=CURRENT_TIMESTAMP`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rawBars) insertRawBar.run(row.provider, row.code, row.trade_date, row.open, row.high, row.low, row.close, row.pre_close, row.pct_chg, row.volume, row.amount, row.adj_factor, DAILY_CANONICAL_UNIT_VERSION, "share", "CNY");
    for (const row of rawBasics) insertRawBasic.run(row.provider, row.code, row.trade_date, row.close, row.turnover_rate, row.turnover_rate_f, row.volume_ratio, row.float_share, row.free_share, row.total_mv, row.circ_mv);
    for (const row of bars.values()) {
      const units = legacyDailyUnits(row.volume, row.amount);
      publishBar.run(row.code, row.trade_date, row.open, row.high, row.low, row.close, units.volume, units.amount, DAILY_LEGACY_UNIT_VERSION, "lot", "thousand_CNY", "bigquant_official+tushare_verified");
    }
    for (const row of basics.values()) publishBasic.run(row.code, row.trade_date, row.close, row.turnover_rate, row.turnover_rate_f, row.volume_ratio, row.float_share, row.free_share, row.total_mv, row.circ_mv, "tushare_official+bigquant_verified");
    const versionId = `formal-daily-${latestDate}-${Date.now()}`;
    const checksum = createHash("sha256").update(JSON.stringify([...bars.values()].filter((row) => row.trade_date === latestDate).map((row) => [row.code, row.close, row.provider]))).digest("hex");
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='formal_daily' AND status='published'").run();
    db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES('formal_daily',?,?,?,?,'published','bigquant_official+tushare_official',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(versionId, latestDate, latestCoverage, checksum);
    recordAcquisitionBatch(db, { batchId: versionId, datasetKey: "formal_daily", providerKey: "bigquant_official+tushare_official", sessionType: "after_close", tradeDate: latestDate, rowCount: latestCoverage, checksum, storageLayer: "duckdb+sqlite", metadata: { providers: payload.providers, warehouse, rawBars: rawBars.length, rawBasics: rawBasics.length } });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { count: bars.size, basics: basics.size, latestDate, latestCoverage, providers: payload.providers, warehouse, versionId: latestPublishedVersion(db, "formal_daily")?.version_id, message: `BigQuant+Tushare共享批次一次采集，已同步发布至DuckDB与SQLite；最新截面${latestCoverage}只` };
}

export async function syncMarketFactorSnapshot(db) {
  const payload = await runProviderBridge("market-factor-snapshot", { database: marketDatabasePath }, { timeoutMs: 8 * 60_000, maximumBytes: 96 * 1024 * 1024 });
  let rankPayload = null;
  try {
    const cached = db.prepare("SELECT calc_trade_date,payload_json FROM sector_stock_rank_cache WHERE cache_key='aster:sector_stock_multi_rank:latest'").get();
    if (cached?.calc_trade_date === payload.trade_date) rankPayload = JSON.parse(cached.payload_json);
  } catch {}
  const securities = payload.securities || []; const rows = addDailyCandidateRanks(payload.rows || [], rankPayload);
  const formal = latestPublishedVersion(db, "formal_daily");
  if (!formal || payload.trade_date !== formal.trade_date) throw new Error(`全市场因子截面${payload.trade_date || "无"}与正式双源日线${formal?.trade_date || "无"}不一致，拒绝发布`);
  if (securities.length < 4000 || rows.length < 4000) throw new Error(`全市场精简因子覆盖不足：证券${securities.length}、因子${rows.length}`);
  const security = db.prepare(`INSERT INTO securities(code,symbol,name,market,industry,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,market=excluded.market,industry=excluded.industry,updated_at=CURRENT_TIMESTAMP`);
  const factor = db.prepare(`INSERT INTO market_factor_snapshot(code,trade_date,name,industry,close,pct_chg,amount,turnover_rate,volume_ratio_20,ret_5d,ret_10d,ret_20d,ret_30d,ret_60d,stock_ret_5d_rank,stock_ret_10d_rank,stock_ret_30d_rank,stock_ret_60d_rank,stock_top50_5_10_30,sector_ret_5d,sector_ret_5d_rank,sector_ret_5d_rank_pct,sector_4d_streak,bigquant_heat_score,bigquant_heat_rank,bigquant_heat_rank_pct,bigquant_heat_date,bias_ma20,breakout_20,volatility_20,drawdown_20,industry_ret_4d,source)
    VALUES(${Array.from({ length: 33 }, () => "?").join(",")}) ON CONFLICT(code,trade_date) DO UPDATE SET name=excluded.name,industry=excluded.industry,close=excluded.close,pct_chg=excluded.pct_chg,amount=excluded.amount,turnover_rate=excluded.turnover_rate,volume_ratio_20=excluded.volume_ratio_20,ret_5d=excluded.ret_5d,ret_10d=excluded.ret_10d,ret_20d=excluded.ret_20d,ret_30d=excluded.ret_30d,ret_60d=excluded.ret_60d,stock_ret_5d_rank=excluded.stock_ret_5d_rank,stock_ret_10d_rank=excluded.stock_ret_10d_rank,stock_ret_30d_rank=excluded.stock_ret_30d_rank,stock_ret_60d_rank=excluded.stock_ret_60d_rank,stock_top50_5_10_30=excluded.stock_top50_5_10_30,sector_ret_5d=excluded.sector_ret_5d,sector_ret_5d_rank=excluded.sector_ret_5d_rank,sector_ret_5d_rank_pct=excluded.sector_ret_5d_rank_pct,sector_4d_streak=excluded.sector_4d_streak,bigquant_heat_score=excluded.bigquant_heat_score,bigquant_heat_rank=excluded.bigquant_heat_rank,bigquant_heat_rank_pct=excluded.bigquant_heat_rank_pct,bigquant_heat_date=excluded.bigquant_heat_date,bias_ma20=excluded.bias_ma20,breakout_20=excluded.breakout_20,volatility_20=excluded.volatility_20,drawdown_20=excluded.drawdown_20,industry_ret_4d=excluded.industry_ret_4d,source=excluded.source,updated_at=CURRENT_TIMESTAMP`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of securities) if (/^\d{6}\.(SH|SZ|BJ)$/.test(String(row.ts_code || ""))) security.run(row.ts_code, row.symbol || String(row.ts_code).slice(0, 6), row.name || row.symbol, row.market || String(row.ts_code).slice(-2), row.industry || "其他");
    for (const row of rows) factor.run(row.ts_code, String(row.trade_date).slice(0, 10), row.name || row.ts_code, row.industry || "其他", row.close, row.pct_chg, row.amount, row.turnover_rate, row.volume_ratio_20, row.ret_5d, row.ret_10d, row.ret_20d, row.ret_30d, row.ret_60d, row.stock_ret_5d_rank, row.stock_ret_10d_rank, row.stock_ret_30d_rank, row.stock_ret_60d_rank, row.stock_top50_5_10_30, row.sector_ret_5d, row.sector_ret_5d_rank, row.sector_ret_5d_rank_pct, row.sector_4d_streak, row.bigquant_heat_score, row.bigquant_heat_rank, row.bigquant_heat_rank_pct, row.bigquant_heat_date, row.bias_ma20, row.breakout_20 ? 1 : 0, row.volatility_20, row.drawdown_20, row.industry_ret_4d, payload.source);
    const checksum = createHash("sha256").update(JSON.stringify(rows.map((row) => [row.ts_code, row.close]))).digest("hex");
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='market_factor_snapshot' AND status='published'").run();
    const versionId = `market-factor-${payload.trade_date}-${Date.now()}`;
    db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES('market_factor_snapshot',?,?,?,?, 'published',?,100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .run(versionId, payload.trade_date, rows.length, checksum, payload.source);
    linkDatasetVersion(db, "market_factor_snapshot", versionId, "formal_daily", formal.version_id, "materialized_from");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { count: rows.length, securities: securities.length, tradeDate: payload.trade_date, source: payload.source, heatDate: payload.heat_date || null, heatRows: Number(payload.heat_rows || 0), message: `全A股精简因子${rows.length}只、证券主表${securities.length}只已独立物化；BigQuant热度${payload.heat_date || "尚无可用日期"} ${Number(payload.heat_rows || 0)}只` };
}

export async function refreshBigquantHeatRank(db, targetDate = null) {
  const tradeDate = targetDate || latestPublishedVersion(db, "formal_daily")?.trade_date;
  if (!tradeDate) throw new Error("没有正式日线日期，不能刷新BigQuant热度");
  const payload = await runProviderBridge("refresh-bigquant-heat", { database: marketDatabasePath, trade_date: tradeDate }, { timeoutMs: 8 * 60_000, maximumBytes: 8 * 1024 * 1024 });
  if (payload.trade_date !== tradeDate || Number(payload.rows || 0) < 4000) throw new Error(`BigQuant热度${payload.trade_date || "无日期"}仅${Number(payload.rows || 0)}只，拒绝发布`);
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('bigquant_heat_status',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .run(JSON.stringify({ tradeDate, rows: Number(payload.rows), source: payload.source, output: payload.output, completedAt: new Date().toISOString() }));
  return { count: Number(payload.rows), tradeDate, source: payload.source, message: `BigQuant ${tradeDate}全市场热度${Number(payload.rows)}只已原子发布` };
}

export async function syncRecommendationDailyHistory(db, limit = 360) {
  const formal = latestPublishedVersion(db, "formal_daily");
  if (!formal?.trade_date) throw new Error("正式日线尚未发布，不能同步AIA历史");
  const codes = db.prepare(`SELECT code FROM market_factor_snapshot
    WHERE trade_date=(SELECT MAX(trade_date) FROM market_factor_snapshot)
    UNION SELECT code FROM bars_daily WHERE trade_date=?
    ORDER BY code`).all(formal.trade_date).map((row) => row.code);
  if (!codes.length) throw new Error(`正式交易日${formal.trade_date}没有可同步的AIA股票池`);
  const insert = db.prepare(`INSERT INTO bars_daily(code,trade_date,open,high,low,close,volume,amount,unit_version,volume_unit,amount_unit,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code,trade_date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,amount=excluded.amount,unit_version=excluded.unit_version,volume_unit=excluded.volume_unit,amount_unit=excluded.amount_unit,source=excluded.source,imported_at=CURRENT_TIMESTAMP`);
  const chunkSize = 300;
  let rowCount = 0;
  const covered = new Set();
  const sources = new Set();
  for (let offset = 0; offset < codes.length; offset += chunkSize) {
    const requested = codes.slice(offset, offset + chunkSize);
    const payload = await runProviderBridge("market-daily-history", {
      database: marketDatabasePath,
      codes: requested,
      limit,
    }, { timeoutMs: 10 * 60_000, maximumBytes: 64 * 1024 * 1024 });
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of payload.rows || []) {
        if (row.unit_version !== DAILY_LEGACY_UNIT_VERSION || row.volume_unit !== "lot" || row.amount_unit !== "thousand_CNY") throw new Error(`AIA日线单位契约错误：${row.code} ${row.trade_date}`);
        insert.run(row.code, row.trade_date, row.open, row.high, row.low, row.close, row.volume, row.amount, row.unit_version, row.volume_unit, row.amount_unit, row.source);
        rowCount += 1;
        covered.add(row.code);
        sources.add(row.source || payload.source);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const minimumCovered = Math.ceil(codes.length * .95);
  if (covered.size < minimumCovered) throw new Error(`AIA正式历史仅覆盖${covered.size}/${codes.length}只，低于95%门禁${minimumCovered}`);
  const codeSet = new Set(codes);
  const historyCounts = db.prepare("SELECT code,COUNT(*) AS bars FROM bars_daily GROUP BY code").all().filter((row) => codeSet.has(row.code));
  const historyGate = {
    total: historyCounts.length,
    history80: historyCounts.filter((row) => Number(row.bars) >= 80).length,
    history310: historyCounts.filter((row) => Number(row.bars) >= 310).length,
  };
  if (Number(historyGate?.history80 || 0) < minimumCovered) {
    throw new Error(`AIA至少80根正式日线仅覆盖${Number(historyGate?.history80 || 0)}/${codes.length}只，低于95%门禁${minimumCovered}`);
  }
  db.prepare("DELETE FROM bars_daily WHERE lower(COALESCE(source,'')) NOT LIKE 'bigquant%' AND lower(COALESCE(source,'')) NOT LIKE 'tushare%'").run();
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('aia_history_status',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .run(JSON.stringify({ tradeDate: formal.trade_date, requested: codes.length, covered: covered.size, rows: rowCount, history80: Number(historyGate.history80 || 0), history310: Number(historyGate.history310 || 0), source: [...sources].sort(), completedAt: new Date().toISOString() }));
  return { count: rowCount, codes: covered.size, source: [...sources].sort(), history80: Number(historyGate.history80 || 0), history310: Number(historyGate.history310 || 0), message: `AIA全市场BigQuant/Tushare正式历史写入${rowCount}根，80日覆盖${Number(historyGate.history80 || 0)}/${codes.length}只` };
}

export function purgeNonAkshareM30(db) {
  const result = db.prepare("DELETE FROM bars_30m WHERE lower(COALESCE(source,'')) NOT LIKE 'akshare%'").run();
  return { count: Number(result.changes || 0), message: `已移除${Number(result.changes || 0)}根非AkShare盘中K线；原始副本仍保留在独立DuckDB` };
}

function pctRanker(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length < 2) return () => 50;
  return (value) => {
    const target = Number(value);
    if (!Number.isFinite(target)) return 50;
    let low = 0; let high = clean.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (clean[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, Math.min(100, (low - 1) * 100 / (clean.length - 1)));
  };
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function rebuildDailyFactors(db, targetDate = null) {
  const tradeDate = targetDate || db.prepare("SELECT MAX(trade_date) AS date FROM bars_daily").get()?.date || shanghaiDate();
  const formal = latestPublishedVersion(db, "formal_daily");
  if (!formal || formal.trade_date !== tradeDate || !String(formal.source || "").includes("bigquant") || !String(formal.source || "").includes("tushare")) throw new Error(`目标日${tradeDate}没有同日BigQuant+Tushare正式版本，拒绝重建因子`);
  const officialCoverage = db.prepare("SELECT COUNT(*) AS count FROM bars_daily WHERE trade_date=? AND source LIKE '%bigquant%' AND source LIKE '%tushare%'").get(tradeDate)?.count || 0;
  const basicCoverage = db.prepare("SELECT COUNT(*) AS count FROM daily_basic WHERE trade_date=? AND source LIKE '%tushare%' AND source LIKE '%bigquant%'").get(tradeDate)?.count || 0;
  const minimumCoverage = Math.max(400, Math.ceil(Number(formal.row_count || 0) * .95));
  if (officialCoverage < minimumCoverage || basicCoverage < minimumCoverage) throw new Error(`正式因子输入覆盖不足：日线${officialCoverage}、基础量价${basicCoverage}，要求各≥${minimumCoverage}`);
  const securities = db.prepare("SELECT * FROM securities ORDER BY code").all();
  const priorDate = db.prepare("SELECT MAX(trade_date) AS date FROM factor_snapshot WHERE trade_date<?").get(tradeDate)?.date || db.prepare("SELECT MAX(trade_date) AS date FROM factor_snapshot").get()?.date;
  const prior = new Map(db.prepare("SELECT * FROM factor_snapshot WHERE trade_date=?").all(priorDate).map((row) => [row.code, row]));
  const chipDate = db.prepare("SELECT MAX(trade_date) AS date FROM chip_model_rank_daily WHERE trade_date<=?").get(tradeDate)?.date;
  const chip = new Map((chipDate ? db.prepare("SELECT * FROM chip_model_rank_daily WHERE trade_date=?").all(chipDate) : []).map((row) => [row.code, row]));
  const chipFeatures = new Map((chipDate ? db.prepare("SELECT code,internal_features_json FROM chip_axes_snapshot WHERE trade_date=?").all(chipDate) : []).map((row) => {
    let features = {}; try { features = JSON.parse(row.internal_features_json || "{}"); } catch {}
    return [row.code, features];
  }));
  const dailyBasic = new Map(db.prepare("SELECT * FROM daily_basic WHERE trade_date=?").all(tradeDate).map((row) => [row.code, row]));
  const sharedMarketFactors = new Map(db.prepare("SELECT * FROM market_factor_snapshot WHERE trade_date=?").all(tradeDate).map((row) => [row.code, row]));
  const rows = [];
  for (const security of securities) {
    const market = sharedMarketFactors.get(security.code);
    const old = prior.get(security.code) || {}; const rank = chip.get(security.code) || {}; const chipFeature = chipFeatures.get(security.code) || {}; const basic = dailyBasic.get(security.code) || {};
    if (market) {
      rows.push({
        code: security.code, name: market.name || security.name, industry: market.industry || security.industry || "其他", trade_date: tradeDate,
        close: numeric(market.close), pct_chg: numeric(market.pct_chg), amount: numeric(market.amount, 0), turnover_rate: numeric(market.turnover_rate, numeric(basic.turnover_rate, 0)),
        volume_ratio_20: numeric(market.volume_ratio_20), ret_5d: numeric(market.ret_5d), ret_10d: numeric(market.ret_10d), ret_20d: numeric(market.ret_20d), ret_30d: numeric(market.ret_30d), ret_60d: numeric(market.ret_60d),
        stock_ret_5d_rank: numeric(market.stock_ret_5d_rank), stock_ret_10d_rank: numeric(market.stock_ret_10d_rank), stock_ret_30d_rank: numeric(market.stock_ret_30d_rank), stock_ret_60d_rank: numeric(market.stock_ret_60d_rank), stock_top50_5_10_30: Number(Boolean(market.stock_top50_5_10_30)),
        sector_ret_5d: numeric(market.sector_ret_5d), sector_ret_5d_rank: numeric(market.sector_ret_5d_rank), sector_ret_5d_rank_pct: numeric(market.sector_ret_5d_rank_pct), sector_4d_streak: Number(Boolean(market.sector_4d_streak)),
        bigquant_heat_score: numeric(market.bigquant_heat_score), bigquant_heat_rank: numeric(market.bigquant_heat_rank), bigquant_heat_rank_pct: numeric(market.bigquant_heat_rank_pct), bigquant_heat_date: market.bigquant_heat_date || null,
        bias_ma20: numeric(market.bias_ma20), breakout_20: Number(Boolean(market.breakout_20)), volatility_20: numeric(market.volatility_20), drawdown_20: numeric(market.drawdown_20),
        range_20: null, ret_4d: numeric(market.industry_ret_4d), direct_industry_ret_4d: numeric(market.industry_ret_4d), daily_basic_source: basic.source || market.source || null,
        formal_model_score: rank.formal_score ?? old.formal_model_score ?? null, formal_model_rank: rank.formal_rank ?? old.formal_model_rank ?? null, formal_model_rank_pct: rank.formal_rank_pct ?? old.formal_model_rank_pct ?? null,
        candidate_model_score: rank.candidate_score ?? old.candidate_model_score ?? null, candidate_model_rank: rank.candidate_rank ?? old.candidate_model_rank ?? null, candidate_model_rank_pct: rank.candidate_rank_pct ?? old.candidate_model_rank_pct ?? null,
        chip_cost_peak_distance_pct: Number.isFinite(Number(chipFeature.cost_line_main_peak_signed_distance_ratio)) ? Number(chipFeature.cost_line_main_peak_signed_distance_ratio) * 100 : old.chip_cost_peak_distance_pct ?? null,
        chip_cost_peak_abs_distance_rank_pct: Number.isFinite(Number(chipFeature.cost_line_main_peak_abs_distance_rank_pct)) ? Number(chipFeature.cost_line_main_peak_abs_distance_rank_pct) * 100 : old.chip_cost_peak_abs_distance_rank_pct ?? null,
        old, factorSource: "shared_official_market_factor_snapshot",
      });
      continue;
    }
    const bars = db.prepare("SELECT * FROM bars_daily WHERE code=? AND trade_date<=? ORDER BY trade_date DESC LIMIT 80").all(security.code, tradeDate).reverse();
    if (bars.length < 21) continue;
    const current = bars.at(-1); if (current.trade_date !== tradeDate) continue;
    const closes = bars.map((bar) => Number(bar.close)); const volumes = bars.map((bar) => Number(bar.volume || 0));
    const returns = closes.slice(-20).map((value, index, array) => index ? Math.log(value / array[index - 1]) : null).filter(Number.isFinite);
    const peak = Math.max(...closes.slice(-20)); const floor = Math.min(...closes.slice(-20));
    rows.push({
      code: security.code, name: security.name, industry: security.industry || "其他", trade_date: tradeDate,
      close: current.close, pct_chg: (current.close / bars.at(-2).close - 1) * 100, amount: current.amount || old.amount || 0, turnover_rate: basic.turnover_rate ?? old.turnover_rate ?? 0,
      volume_ratio_20: volumes.at(-1) / Math.max(1, volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20),
      ret_5d: closes.length >= 6 ? closes.at(-1) / closes.at(-6) - 1 : null,
      ret_10d: closes.length >= 11 ? closes.at(-1) / closes.at(-11) - 1 : null,
      ret_20d: closes.length >= 21 ? closes.at(-1) / closes.at(-21) - 1 : null,
      ret_30d: closes.length >= 31 ? closes.at(-1) / closes.at(-31) - 1 : null,
      ret_60d: closes.length >= 61 ? closes.at(-1) / closes.at(-61) - 1 : null,
      bigquant_heat_score: old.bigquant_heat_score ?? null, bigquant_heat_rank: old.bigquant_heat_rank ?? null,
      bigquant_heat_rank_pct: old.bigquant_heat_rank_pct ?? null, bigquant_heat_date: old.bigquant_heat_date ?? null,
      bias_ma20: closes.at(-1) / (closes.slice(-20).reduce((a, b) => a + b, 0) / 20) - 1,
      breakout_20: closes.at(-1) > Math.max(...closes.slice(-21, -1)) ? 1 : 0,
      volatility_20: stdev(returns) * Math.sqrt(20), drawdown_20: closes.at(-1) / Math.max(peak, .001) - 1,
      range_20: peak / Math.max(floor, .001) - 1, ret_4d: closes.at(-1) / closes.at(-5) - 1, daily_basic_source: basic.source || null,
      formal_model_score: rank.formal_score ?? old.formal_model_score ?? null, formal_model_rank: rank.formal_rank ?? old.formal_model_rank ?? null, formal_model_rank_pct: rank.formal_rank_pct ?? old.formal_model_rank_pct ?? null,
      candidate_model_score: rank.candidate_score ?? old.candidate_model_score ?? null, candidate_model_rank: rank.candidate_rank ?? old.candidate_model_rank ?? null, candidate_model_rank_pct: rank.candidate_rank_pct ?? old.candidate_model_rank_pct ?? null,
      chip_cost_peak_distance_pct: Number.isFinite(Number(chipFeature.cost_line_main_peak_signed_distance_ratio)) ? Number(chipFeature.cost_line_main_peak_signed_distance_ratio) * 100 : old.chip_cost_peak_distance_pct ?? null,
      chip_cost_peak_abs_distance_rank_pct: Number.isFinite(Number(chipFeature.cost_line_main_peak_abs_distance_rank_pct)) ? Number(chipFeature.cost_line_main_peak_abs_distance_rank_pct) * 100 : old.chip_cost_peak_abs_distance_rank_pct ?? null,
      sector_4d_streak: Number(old.sector_4d_streak || 0),
      old, factorSource: "sqlite_official_bar_history_fallback",
    });
  }
  let rankPayload = null;
  try {
    const cached = db.prepare("SELECT calc_trade_date,payload_json FROM sector_stock_rank_cache WHERE cache_key='aster:sector_stock_multi_rank:latest'").get();
    if (cached?.calc_trade_date === tradeDate) rankPayload = JSON.parse(cached.payload_json);
  } catch {}
  rows.splice(0, rows.length, ...addDailyCandidateRanks(rows, rankPayload));
  if (rows.length < minimumCoverage) throw new Error(`日因子候选仅${rows.length}只，低于正式截面95%门禁${minimumCoverage}，旧版本继续生效`);
  const industryGroups = new Map();
  for (const row of rows) { if (!industryGroups.has(row.industry)) industryGroups.set(row.industry, []); industryGroups.get(row.industry).push(row); }
  const industryMomentum = new Map([...industryGroups].map(([key, items]) => {
    const direct = items.map((row) => numeric(row.direct_industry_ret_4d)).filter(Number.isFinite);
    return [key, direct.length ? direct.reduce((sum, value) => sum + value, 0) / direct.length : items.reduce((sum, row) => sum + numeric(row.ret_4d, 0), 0) / items.length];
  }));
  const industryValues = [...industryMomentum.values()]; const retValues = rows.map((row) => row.ret_20d); const ret5Values = rows.map((row) => row.ret_5d); const volumeValues = rows.map((row) => row.volume_ratio_20); const pctValues = rows.map((row) => row.pct_chg); const biasValues = rows.map((row) => row.bias_ma20);
  const evidenceRows = db.prepare("SELECT source,related_codes FROM news_evidence WHERE published_at>=date(?, '-7 day')").all(tradeDate);
  const evidenceCount = new Map(); const communityCount = new Map();
  for (const item of evidenceRows) {
    let codes = []; try { codes = JSON.parse(item.related_codes || "[]"); } catch {}
    for (const code of codes) { const normalized = String(code).includes(".") ? String(code) : securities.find((row) => row.symbol === String(code))?.code; if (!normalized) continue; evidenceCount.set(normalized, (evidenceCount.get(normalized) || 0) + 1); if (/taoguba|淘股吧/i.test(item.source || "")) communityCount.set(normalized, (communityCount.get(normalized) || 0) + 1); }
  }
  const evidenceValues = rows.map((row) => evidenceCount.get(row.code) || 0); const communityValues = rows.map((row) => communityCount.get(row.code) || 0);
  const industryRank = pctRanker(industryValues); const retRank = pctRanker(retValues); const ret5Rank = pctRanker(ret5Values);
  const volumeRank = pctRanker(volumeValues); const pctChangeRank = pctRanker(pctValues); const biasRank = pctRanker(biasValues);
  const evidenceRank = pctRanker(evidenceValues); const communityRank = pctRanker(communityValues);
  const leadershipRanks = new Map([...industryGroups].map(([key, items]) => [key, pctRanker(items.map((item) => item.ret_20d))]));
  const hasCommunityEvidence = communityValues.some((value) => value > 0);
  const factorColumns = [
    "code", "trade_date", "name", "industry", "close", "pct_chg", "amount", "turnover_rate", "volume_ratio_20",
    "ret_5d", "ret_10d", "ret_20d", "ret_30d", "ret_60d", "stock_ret_5d_rank", "stock_ret_10d_rank", "stock_ret_30d_rank", "stock_ret_60d_rank", "stock_top50_5_10_30",
    "sector_ret_5d", "sector_ret_5d_rank", "sector_ret_5d_rank_pct", "sector_4d_streak", "bigquant_heat_score", "bigquant_heat_rank", "bigquant_heat_rank_pct", "bigquant_heat_date",
    "bias_ma20", "breakout_20", "volatility_20", "drawdown_20", "industry_ret_4d", "previous_heat_score", "previous_heat_rank_pct",
    "formal_model_score", "formal_model_rank", "formal_model_rank_pct", "candidate_model_score", "candidate_model_rank", "candidate_model_rank_pct",
    "chip_cost_peak_distance_pct", "chip_cost_peak_abs_distance_rank_pct",
    "abcd_a_score", "abcd_b_score", "abcd_c_score", "abcd_d_score", "aia_sector_heat", "aia_stock_heat", "aia_leadership", "aia_technical_pattern",
    "m30_similarity", "five_platform_heat", "four_agent_score", "taoguba_sentiment", "daily_breakout_score", "source_payload",
  ];
  const mutableColumns = factorColumns.filter((column) => !["code", "trade_date"].includes(column));
  const insert = db.prepare(`INSERT INTO factor_snapshot(${factorColumns.join(",")}) VALUES(${factorColumns.map(() => "?").join(",")})
    ON CONFLICT(code,trade_date) DO UPDATE SET ${mutableColumns.map((column) => `${column}=excluded.${column}`).join(",")},updated_at=CURRENT_TIMESTAMP`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const industryRet = industryMomentum.get(row.industry) || 0;
      const sectorHeat = industryRank(industryRet); const stockHeat = .45 * retRank(row.ret_20d) + .35 * volumeRank(row.volume_ratio_20) + .20 * pctChangeRank(row.pct_chg);
      const leadership = leadershipRanks.get(row.industry)(row.ret_20d); const technical = .4 * row.breakout_20 * 100 + .3 * biasRank(row.bias_ma20) + .3 * ret5Rank(row.ret_5d);
      const fiveHeat = .65 * evidenceRank(evidenceCount.get(row.code) || 0) + .35 * Number(row.old.five_platform_heat || row.old.previous_heat_score || 35);
      const agentHits = [technical >= 60, leadership >= 60, sectorHeat >= 60, fiveHeat >= 55].filter(Boolean).length; const fourAgent = agentHits * 25;
      const taoguba = hasCommunityEvidence ? communityRank(communityCount.get(row.code) || 0) : Number(row.old.taoguba_sentiment || 50);
      const breakout = row.breakout_20 ? 100 : Math.max(0, technical * .4);
      insert.run(
        row.code, tradeDate, row.name, row.industry, row.close, row.pct_chg, row.amount, row.turnover_rate, row.volume_ratio_20,
        row.ret_5d, row.ret_10d, row.ret_20d, row.ret_30d, row.ret_60d, row.stock_ret_5d_rank, row.stock_ret_10d_rank, row.stock_ret_30d_rank, row.stock_ret_60d_rank, row.stock_top50_5_10_30,
        row.sector_ret_5d, row.sector_ret_5d_rank, row.sector_ret_5d_rank_pct, row.sector_4d_streak, row.bigquant_heat_score, row.bigquant_heat_rank, row.bigquant_heat_rank_pct, row.bigquant_heat_date,
        row.bias_ma20, row.breakout_20, row.volatility_20, row.drawdown_20, industryRet, fiveHeat, 100 - evidenceRank(evidenceCount.get(row.code) || 0),
        row.formal_model_score, row.formal_model_rank, row.formal_model_rank_pct, row.candidate_model_score, row.candidate_model_rank, row.candidate_model_rank_pct,
        row.chip_cost_peak_distance_pct, row.chip_cost_peak_abs_distance_rank_pct,
        null, null, null, null, sectorHeat, stockHeat, leadership, technical, row.old.m30_similarity || 0, fiveHeat, fourAgent, taoguba, breakout,
        JSON.stringify({ source: "formal_bigquant_tushare_factor_rebuild", factorSource: row.factorSource, formalVersionId: formal.version_id, bars: row.factorSource === "shared_official_market_factor_snapshot" ? "shared_duckdb_factor_daily" : 80, dailyBasicSource: row.daily_basic_source, chipDate, bigquantHeatDate: row.bigquant_heat_date, evidenceDays: 7 }),
      );
    }
    const checksum = createHash("sha256").update(JSON.stringify(rows.map((row) => [row.code, row.close, row.ret_20d]))).digest("hex");
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='factor_snapshot' AND status='published'").run();
    const factorVersionId = `factor-${tradeDate}-${Date.now()}`;
    db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES('factor_snapshot',?,?,?,?, 'published','formal_bigquant_tushare_factor_rebuild',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .run(factorVersionId, tradeDate, rows.length, checksum);
    linkDatasetVersion(db, "factor_snapshot", factorVersionId, "formal_daily", formal.version_id, "derived_from");
    db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('factor_trade_date',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(tradeDate);
    db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('factor_row_count',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(String(rows.length));
    resolveOpenAlert(db, "source_governance", "正式因子数据源不合规");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { count: rows.length, tradeDate, message: `独立日因子重建${rows.length}只并通过发布门禁` };
}

async function readChipAxesPayload() {
  const endpoint = process.env.ASTER_CHIP_AXES_JSON_URL;
  if (endpoint) {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`筹码特征源返回${response.status}`);
    return response.json();
  }
  const path = process.env.ASTER_CHIP_AXES_PATH || join(projectDir, "data", "inbox", "chip_axes.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function syncChipAxes(db) {
  const external = await readChipAxesPayload();
  const payload = external || await runProviderBridge("market-chip-axes", { database: marketDatabasePath }, { timeoutMs: 8 * 60_000, maximumBytes: 128 * 1024 * 1024 });
  const rows = Array.isArray(payload) ? payload : payload.items || payload.rows || [];
  const securities = new Set(db.prepare("SELECT code FROM securities").all().map((row) => row.code));
  const axes = ["shape_sharpness", "shape_compactness", "shape_symmetry", "shape_single_peak", "shape_profit_quality"];
  const validRows = rows.flatMap((row) => {
    const code = String(row.code || row.ts_code || "").toUpperCase();
    const date = String(row.trade_date || row.tradeDate || shanghaiDate()).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
    if (!securities.has(code) || !axes.every((key) => Number.isFinite(Number(row[key])))) return [];
    return [{ row, code, date }];
  });
  const minimumCoverage = Math.min(400, Math.floor(securities.size * .8));
  if (validRows.length < minimumCoverage) throw new Error(`筹码递推截面仅${validRows.length}只，未通过覆盖率门禁，保留原快照`);
  const insert = db.prepare(`INSERT INTO chip_axes_snapshot(code,trade_date,shape_sharpness,shape_compactness,shape_symmetry,shape_single_peak,shape_profit_quality,internal_features_json,source)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(code,trade_date) DO UPDATE SET shape_sharpness=excluded.shape_sharpness,shape_compactness=excluded.shape_compactness,shape_symmetry=excluded.shape_symmetry,shape_single_peak=excluded.shape_single_peak,shape_profit_quality=excluded.shape_profit_quality,internal_features_json=excluded.internal_features_json,source=excluded.source,imported_at=CURRENT_TIMESTAMP`);
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const date of new Set(validRows.map(({ date }) => date))) db.prepare("DELETE FROM chip_axes_snapshot WHERE trade_date=?").run(date);
    for (const { row, code, date } of validRows) {
      insert.run(code, date, ...axes.map((key) => Number(row[key])), JSON.stringify(row.internal_features || row.features || {}), row.source || "independent_chip_adapter"); changed += 1;
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { count: changed, tradeDate: payload.trade_date || null, source: external ? "configured_chip_input" : "independent_market_duckdb", message: `独立筹码特征写入${changed}只（8010原轴逻辑；复杂特征仅内部保存）` };
}

export async function scoreChipModels(db, targetDate = null) {
  const tradeDate = targetDate || db.prepare("SELECT MAX(trade_date) AS date FROM chip_axes_snapshot").get()?.date;
  if (!tradeDate) return { count: 0, message: "没有筹码特征新截面，双模型继续使用已发布排名" };
  const rows = db.prepare("SELECT * FROM chip_axes_snapshot WHERE trade_date=?").all(tradeDate);
  if (rows.length < Math.min(400, Math.floor(db.prepare("SELECT COUNT(*) AS count FROM securities").get().count * .8))) throw new Error(`筹码截面仅${rows.length}只，未通过覆盖率门禁`);
  const input = rows.map((row) => {
    let features = {};
    try { features = JSON.parse(row.internal_features_json || "{}"); } catch {}
    return { code: row.code, trade_date: row.trade_date, shape_sharpness: row.shape_sharpness, shape_compactness: row.shape_compactness, shape_symmetry: row.shape_symmetry, shape_single_peak: row.shape_single_peak, shape_profit_quality: row.shape_profit_quality, features };
  });
  const multiPeriodRegistry = db.prepare("SELECT production_enabled,model_version FROM experimental_chip_models WHERE scope='multi_period'").get() || {};
  const payload = await runProviderBridge("score-chip-models", { rows: input, enable_multi_period: Boolean(multiPeriodRegistry.production_enabled && multiPeriodRegistry.model_version && multiPeriodRegistry.model_version !== "not_trained") }, { timeoutMs: 5 * 60_000, maximumBytes: 64 * 1024 * 1024 });
  const scored = payload.rows || [];
  if (scored.length !== rows.length) throw new Error(`双筹码模型仅返回${scored.length}/${rows.length}只，拒绝发布部分截面`);
  const insert = db.prepare(`INSERT INTO chip_model_rank_daily(code,trade_date,formal_score,formal_rank,formal_rank_pct,formal_model_version,candidate_score,candidate_rank,candidate_rank_pct,candidate_model_version,multi_period_score,multi_period_rank,multi_period_rank_pct,multi_period_model_version,source)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code,trade_date) DO UPDATE SET formal_score=excluded.formal_score,formal_rank=excluded.formal_rank,formal_rank_pct=excluded.formal_rank_pct,formal_model_version=excluded.formal_model_version,candidate_score=excluded.candidate_score,candidate_rank=excluded.candidate_rank,candidate_rank_pct=excluded.candidate_rank_pct,candidate_model_version=excluded.candidate_model_version,multi_period_score=excluded.multi_period_score,multi_period_rank=excluded.multi_period_rank,multi_period_rank_pct=excluded.multi_period_rank_pct,multi_period_model_version=excluded.multi_period_model_version,source=excluded.source,updated_at=CURRENT_TIMESTAMP`);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM chip_model_rank_daily WHERE trade_date=?").run(tradeDate);
    for (const row of scored) {
      insert.run(row.code, tradeDate, row.formal_score, row.formal_rank, row.formal_rank_pct, payload.formal_model_version, row.candidate_score, row.candidate_rank, row.candidate_rank_pct, payload.candidate_model_version, row.multi_period_score ?? null, row.multi_period_rank ?? null, row.multi_period_rank_pct ?? null, payload.multi_period_model_version || null, payload.multi_period_model_version ? "independent_multi_chip_model_joblib" : "independent_dual_model_joblib");
    }
    // factor_snapshot is a materialized convenience table used by several
    // consumers.  Keep its duplicated public score columns byte-for-byte in
    // sync with the canonical rank publication in the same transaction.
    db.prepare(`UPDATE factor_snapshot AS f SET
      formal_model_score=(SELECT r.formal_score FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date),
      formal_model_rank=(SELECT r.formal_rank FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date),
      formal_model_rank_pct=(SELECT r.formal_rank_pct FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date),
      candidate_model_score=(SELECT r.candidate_score FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date),
      candidate_model_rank=(SELECT r.candidate_rank FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date),
      candidate_model_rank_pct=(SELECT r.candidate_rank_pct FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date),
      chip_cost_peak_distance_pct=(SELECT json_extract(a.internal_features_json,'$.cost_line_main_peak_signed_distance_ratio')*100 FROM chip_axes_snapshot a WHERE a.code=f.code AND a.trade_date=f.trade_date),
      chip_cost_peak_abs_distance_rank_pct=(SELECT json_extract(a.internal_features_json,'$.cost_line_main_peak_abs_distance_rank_pct')*100 FROM chip_axes_snapshot a WHERE a.code=f.code AND a.trade_date=f.trade_date),
      updated_at=CURRENT_TIMESTAMP
      WHERE f.trade_date=? AND EXISTS (
        SELECT 1 FROM chip_model_rank_daily r WHERE r.code=f.code AND r.trade_date=f.trade_date
      )`).run(tradeDate);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const synchronizedFactors = Number(db.prepare(`SELECT COUNT(*) AS count FROM factor_snapshot f JOIN chip_model_rank_daily r
    ON r.code=f.code AND r.trade_date=f.trade_date WHERE f.trade_date=?
      AND f.formal_model_score IS r.formal_score AND f.formal_model_rank IS r.formal_rank
      AND f.candidate_model_score IS r.candidate_score AND f.candidate_model_rank IS r.candidate_rank`).get(tradeDate)?.count || 0);
  return { count: scored.length, synchronizedFactors, tradeDate, formalModelVersion: payload.formal_model_version, candidateModelVersion: payload.candidate_model_version, message: `正式与候选joblib模型完成${scored.length}只全截面排名；同步量价筛选器${synchronizedFactors}只` };
}
