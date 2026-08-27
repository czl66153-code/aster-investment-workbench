import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir, shanghaiDate } from "./core.mjs";

const CACHE_KEY = "aster:sector_stock_multi_rank:latest";
const REQUIRED_CLOSE_DAYS = 61;
const NOTE = "板块分类与四日连涨规则已内置于独立站点；数据仅供参考，不构成投资建议";
const calendarPath = join(projectDir, "engine", "models", "aia", "trade_calendar.json");
let redisPromise = null;
let calendarCache = null;

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value) {
  return Math.round(value * 10_000) / 10_000;
}

function sectorCode(name) {
  return `IND-${createHash("sha256").update(String(name)).digest("hex").slice(0, 8).toUpperCase()}`;
}

function normalizeCode(value, symbols) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) return raw;
  if (/^\d{6}$/.test(raw)) return symbols.get(raw) || raw;
  return raw;
}

function average(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function compound(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  return (values.reduce((result, value) => result * (1 + value / 100), 1) - 1) * 100;
}

function sortedBy(items, key) {
  return [...items].sort((left, right) => Number(right[key]) - Number(left[key]) || String(left.sector_code || left.stock_code).localeCompare(String(right.sector_code || right.stock_code)));
}

function tradeCalendar() {
  if (calendarCache) return calendarCache;
  try { calendarCache = JSON.parse(readFileSync(calendarPath, "utf8")); }
  catch { calendarCache = {}; }
  return calendarCache;
}

export function isAshareTradingDate(date) {
  const calendar = tradeCalendar();
  if (Object.hasOwn(calendar, date)) return calendar[date] === true;
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function nextTradingCutoff(fromDate) {
  let cursor = new Date(`${fromDate}T12:00:00+08:00`);
  for (let count = 0; count < 370; count += 1) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const candidate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(cursor);
    if (isAshareTradingDate(candidate)) return new Date(`${candidate}T15:35:00+08:00`);
  }
  return new Date(Date.now() + 86_400_000);
}

export function ensureSectorStockRankSchedule(db) {
  db.prepare(`INSERT INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES('stock_sector_stock_rank_panel','板块与个股多周期涨幅排行','after_close','A股交易日 15:35',1,345600,1,'严格使用最近61个交易日收盘价计算3/5/10/30/60日复合涨幅；四日连涨榜要求最近4个交易日每日板块涨幅均大于0；板块成分股不少于5只；ST、*ST及退市股不得进入个股榜单',CURRENT_TIMESTAMP)
    ON CONFLICT(schedule_key) DO UPDATE SET display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`).run();
  return db.prepare("SELECT * FROM schedule_definitions WHERE schedule_key='stock_sector_stock_rank_panel'").get();
}

export function emptyRankPayload(calcTradeDate = "") {
  return {
    calc_trade_date: calcTradeDate,
    update_time: new Date().toISOString(),
    sector_rank: { sector_3d_gain_list: [], sector_5d_gain_list: [], sector_10d_gain_list: [], sector_30d_gain_list: [], sector_60d_gain_list: [], sector_4d_streak_top10: [], sector_4d_avg_top10: [] },
    stock_rank: { stock_3d_gain_list: [], stock_5d_gain_list: [], stock_10d_gain_list: [], stock_30d_gain_list: [], stock_60d_gain_list: [] },
    data_source_note: NOTE,
  };
}

function rawSectorRows(securities) {
  const groups = new Map();
  for (const security of securities) {
    const name = String(security.industry || "").trim();
    if (!name || name === "其他") continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(security.code);
  }
  return [...groups].map(([sector_name, stock_members]) => ({
    sector_code: sectorCode(sector_name), sector_name, stock_members,
    sector_main_industry: "", sector_chain_tag: "", stock_member_count: stock_members.length,
  }));
}

function graphRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const candidate of [payload?.sectors, payload?.industries, payload?.items, payload?.data?.sectors, payload?.data?.industries, payload?.data?.items, payload?.data]) if (Array.isArray(candidate)) return candidate;
  return [];
}

export async function enhanceSectorsWithGraph(rawSectors, securities, options = {}) {
  const endpoint = options.endpoint ?? process.env.ASTER_8002_KNOWLEDGE_GRAPH_URL ?? null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!endpoint || typeof fetchImpl !== "function") return { sectors: rawSectors, status: "degraded", error: "knowledge graph endpoint unavailable" };
  try {
    const legacySnapshot = /\/api\/industry-knowledge-graphs\/?(?:\?|$)/.test(endpoint);
    const target = legacySnapshot ? new URL(endpoint) : endpoint;
    if (legacySnapshot) {
      target.searchParams.set("date", String(options.tradeDate || shanghaiDate()).replaceAll("-", ""));
      target.searchParams.set("dimension", "sw_l1");
    }
    const response = await fetchImpl(target, legacySnapshot ? {
      method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(Math.min(5_000, Number(options.timeoutMs || 5_000))),
    } : {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sectors: rawSectors.map((sector) => ({ sector_code: sector.sector_code, sector_name: sector.sector_name, stock_members: sector.stock_members })) }),
      signal: AbortSignal.timeout(Math.min(5_000, Number(options.timeoutMs || 5_000))),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = graphRows(payload);
    const symbols = new Map(securities.map((row) => [String(row.symbol || row.code).slice(0, 6), row.code]));
    const rawByCode = new Map(rawSectors.map((row) => [row.sector_code, row]));
    const rawByName = new Map(rawSectors.map((row) => [row.sector_name, row]));
    const sectors = [];
    const usedRawCodes = new Set();
    for (const row of rows) {
      if (row.active === false || row.valid === false || row.deprecated === true || row.is_deprecated === true) continue;
      const name = String(row.sector_name || row.canonical_name || row.name || "").trim();
      if (!name) continue;
      const aliases = [name, ...(row.aliases || []), ...(row.source_sector_names || [])];
      const sources = [row.sector_code, ...(row.source_sector_codes || [])].map((value) => rawByCode.get(String(value))).filter(Boolean);
      for (const alias of aliases) if (rawByName.has(alias)) sources.push(rawByName.get(alias));
      let members = row.stock_members || row.members || row.stock_codes || row.constituents || row.recommended_stocks || row.core_stocks || [];
      members = members.map((value) => normalizeCode(typeof value === "object" ? value.stock_code || value.code || value.symbol : value, symbols)).filter(Boolean);
      if (legacySnapshot && members.length) {
        const memberSet = new Set(members);
        for (const raw of rawSectors) if (raw.stock_members.some((code) => memberSet.has(code)) && !sources.includes(raw)) sources.push(raw);
      }
      if (!members.length) members = sources.flatMap((source) => source.stock_members);
      members = [...new Set(members)];
      const sourceMembers = sources.flatMap((source) => source.stock_members);
      if (legacySnapshot && sourceMembers.length) members = [...new Set([...sourceMembers, ...members])];
      const memberCount = Math.max(members.length, Number(row.stock_member_count || row.member_count || 0), ...sources.map((source) => Number(source.stock_member_count || 0)));
      if (memberCount < 5) continue;
      for (const source of sources) usedRawCodes.add(source.sector_code);
      const stages = [...new Set((row.chain || []).map((item) => String(item.stage || "").trim()).filter(Boolean))];
      sectors.push({
        sector_code: String(row.sector_code || row.canonical_code || sectorCode(name)), sector_name: name, stock_members: members,
        sector_main_industry: String(legacySnapshot ? name : row.sector_main_industry || row.main_industry || row.large_industry || row.industry_class || ""),
        sector_chain_tag: String(row.sector_chain_tag || row.chain_tag || row.industry_chain_tag || (Array.isArray(row.chain_tags) ? row.chain_tags.join(" / ") : stages.join(" / ") || (row.benefit_segments || []).slice(0, 3).join(" / "))),
        stock_member_count: memberCount,
      });
    }
    const result = legacySnapshot ? [...rawSectors.filter((row) => !usedRawCodes.has(row.sector_code)), ...sectors] : sectors;
    return { sectors: result, status: "success", error: null };
  } catch (error) {
    return { sectors: rawSectors, status: "degraded", error: error.message };
  }
}

export function calculateRankPayload({ tradeDates, bars, securities, sectors, updateTime = new Date().toISOString() }) {
  if (tradeDates.length < REQUIRED_CLOSE_DAYS) return emptyRankPayload(tradeDates.at(-1) || "");
  const dates = tradeDates.slice(-REQUIRED_CLOSE_DAYS);
  const latest = dates.at(-1);
  const byCode = new Map();
  for (const row of bars) {
    if (!dates.includes(row.trade_date)) continue;
    if (!byCode.has(row.code)) byCode.set(row.code, new Map());
    byCode.get(row.code).set(row.trade_date, number(row.close));
  }
  const securityByCode = new Map(securities.map((row) => [row.code, row]));
  const stockMetrics = new Map();
  for (const [code, observations] of byCode) {
    const closes = dates.map((date) => observations.get(date));
    if (closes.some((value) => !Number.isFinite(value) || value <= 0)) continue;
    const daily = closes.slice(1).map((value, index) => (value / closes[index] - 1) * 100);
    stockMetrics.set(code, {
      daily,
      stock_code: code,
      stock_name: securityByCode.get(code)?.name || code,
      stock_3d_gain: rounded(compound(daily.slice(-3))),
      stock_5d_gain: rounded(compound(daily.slice(-5))),
      stock_10d_gain: rounded(compound(daily.slice(-10))),
      stock_30d_gain: rounded(compound(daily.slice(-30))),
      stock_60d_gain: rounded(compound(daily.slice(-60))),
    });
  }
  const stockItems = [...stockMetrics.values()]
    .filter((row) => !/^\*?ST|退市|退\b/i.test(String(row.stock_name || "")))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- daily is intentionally omitted from the public payload.
    .map(({ daily: _daily, ...row }) => row);
  const sectorItems = [];
  for (const sector of sectors) {
    const members = [...new Set(sector.stock_members || [])].map((code) => stockMetrics.get(code)).filter(Boolean);
    if (Number(sector.stock_member_count || members.length) < 5 || members.length < 5) continue;
    const daily = Array.from({ length: 60 }, (_, index) => average(members.map((row) => row.daily[index])));
    if (daily.some((value) => !Number.isFinite(value))) continue;
    const lastFourDaily = daily.slice(-4);
    sectorItems.push({
      sector_code: sector.sector_code,
      sector_name: sector.sector_name,
      sector_3d_gain: rounded(compound(daily.slice(-3))),
      sector_5d_gain: rounded(compound(daily.slice(-5))),
      sector_10d_gain: rounded(compound(daily.slice(-10))),
      sector_30d_gain: rounded(compound(daily.slice(-30))),
      sector_60d_gain: rounded(compound(daily.slice(-60))),
      sector_4d_avg_gain: rounded(average(lastFourDaily)),
      sector_4d_compound_gain: rounded(compound(lastFourDaily)),
      sector_4d_is_streak: lastFourDaily.every((gain) => gain > 0),
      sector_4d_daily_gains: lastFourDaily.map((gain, index) => ({ trade_date: dates.slice(-4)[index], gain: rounded(gain) })),
      sector_main_industry: sector.sector_main_industry || "",
      sector_chain_tag: sector.sector_chain_tag || "",
      stock_member_count: Number(sector.stock_member_count || members.length),
    });
  }
  const fourDayStreakTop10 = sortedBy(sectorItems.filter((row) => row.sector_4d_is_streak), "sector_4d_avg_gain").slice(0, 10);
  return {
    calc_trade_date: latest,
    update_time: updateTime,
    sector_rank: {
      sector_3d_gain_list: sortedBy(sectorItems, "sector_3d_gain"),
      sector_5d_gain_list: sortedBy(sectorItems, "sector_5d_gain"),
      sector_10d_gain_list: sortedBy(sectorItems, "sector_10d_gain"),
      sector_30d_gain_list: sortedBy(sectorItems, "sector_30d_gain"),
      sector_60d_gain_list: sortedBy(sectorItems, "sector_60d_gain"),
      sector_4d_streak_top10: fourDayStreakTop10,
      sector_4d_streak_list: sectorItems.filter((row) => row.sector_4d_is_streak),
      // Backward-compatible alias. Its semantics now match the strict four-day streak list.
      sector_4d_avg_top10: fourDayStreakTop10,
    },
    stock_rank: {
      stock_3d_gain_list: sortedBy(stockItems, "stock_3d_gain"),
      stock_5d_gain_list: sortedBy(stockItems, "stock_5d_gain"),
      stock_10d_gain_list: sortedBy(stockItems, "stock_10d_gain"),
      stock_30d_gain_list: sortedBy(stockItems, "stock_30d_gain"),
      stock_60d_gain_list: sortedBy(stockItems, "stock_60d_gain"),
    },
    data_source_note: NOTE,
  };
}

async function redisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisPromise) {
    redisPromise = import("redis").then(async ({ createClient }) => {
      const client = createClient({ url, socket: { connectTimeout: 1_500, reconnectStrategy: false } });
      client.on("error", () => {});
      await client.connect();
      return client;
    }).catch(() => null);
  }
  return redisPromise;
}

async function writeCache(db, payload) {
  const expiresAt = nextTradingCutoff(payload.calc_trade_date);
  const ttl = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const serialized = JSON.stringify(payload);
  db.prepare(`INSERT INTO sector_stock_rank_cache(cache_key,calc_trade_date,update_time,expires_at,payload_json)
    VALUES(?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET calc_trade_date=excluded.calc_trade_date,update_time=excluded.update_time,expires_at=excluded.expires_at,payload_json=excluded.payload_json`).run(CACHE_KEY, payload.calc_trade_date, payload.update_time, expiresAt.toISOString(), serialized);
  const client = await redisClient();
  if (client) { try { await client.set(CACHE_KEY, serialized, { EX: ttl }); } catch {} }
  return { ttl, expiresAt: expiresAt.toISOString(), redis: Boolean(client) };
}

function readSqliteCache(db) {
  const row = db.prepare("SELECT payload_json FROM sector_stock_rank_cache WHERE cache_key=?").get(CACHE_KEY);
  if (!row) return null;
  try { return JSON.parse(row.payload_json); } catch { return null; }
}

function stockRankCacheComplete(payload) {
  const stock = payload?.stock_rank;
  return ["stock_3d_gain_list", "stock_5d_gain_list", "stock_10d_gain_list", "stock_30d_gain_list", "stock_60d_gain_list"]
    .every((key) => Array.isArray(stock?.[key]) && stock[key].length > 0);
}

async function readCache(db) {
  const client = await redisClient();
  if (client) {
    try { const serialized = await client.get(CACHE_KEY); if (serialized) return JSON.parse(serialized); }
    catch {}
  }
  return readSqliteCache(db);
}

export function paginateRankPayload(payload, options = {}) {
  const sectorPage = Math.max(1, Number(options.sectorPage || 1));
  const stockPage = Math.max(1, Number(options.stockPage || 1));
  const sectorSize = Math.max(1, Math.min(100, Number(options.sectorPageSize || 50)));
  const stockSize = Math.max(1, Math.min(100, Number(options.stockPageSize || 50)));
  const sectorStart = (sectorPage - 1) * sectorSize;
  const stockStart = (stockPage - 1) * stockSize;
  const sector = payload.sector_rank || {};
  const stock = payload.stock_rank || {};
  return {
    ...payload,
    sector_rank: {
      sector_3d_gain_list: (sector.sector_3d_gain_list || []).slice(sectorStart, sectorStart + sectorSize),
      sector_5d_gain_list: (sector.sector_5d_gain_list || []).slice(sectorStart, sectorStart + sectorSize),
      sector_10d_gain_list: (sector.sector_10d_gain_list || []).slice(sectorStart, sectorStart + sectorSize),
      sector_30d_gain_list: (sector.sector_30d_gain_list || []).slice(sectorStart, sectorStart + sectorSize),
      sector_60d_gain_list: (sector.sector_60d_gain_list || []).slice(sectorStart, sectorStart + sectorSize),
      sector_4d_streak_top10: (sector.sector_4d_streak_top10 || sector.sector_4d_avg_top10 || []).slice(0, 10),
      sector_4d_streak_list: (sector.sector_4d_streak_list || sector.sector_4d_streak_top10 || sector.sector_4d_avg_top10 || []),
      sector_4d_avg_top10: (sector.sector_4d_avg_top10 || []).slice(0, 10),
    },
    stock_rank: {
      stock_3d_gain_list: (stock.stock_3d_gain_list || []).slice(stockStart, stockStart + stockSize),
      stock_5d_gain_list: (stock.stock_5d_gain_list || []).slice(stockStart, stockStart + stockSize),
      stock_10d_gain_list: (stock.stock_10d_gain_list || []).slice(stockStart, stockStart + stockSize),
      stock_30d_gain_list: (stock.stock_30d_gain_list || []).slice(stockStart, stockStart + stockSize),
      stock_60d_gain_list: (stock.stock_60d_gain_list || []).slice(stockStart, stockStart + stockSize),
    },
  };
}

export async function getSectorStockRank(db, options = {}) {
  let cached = await readCache(db);
  const latest = db.prepare("SELECT trade_date AS date FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get()?.date
    || db.prepare("SELECT MAX(trade_date) AS date FROM bars_daily").get()?.date || "";
  const tradingDays = latest ? Number(db.prepare("SELECT COUNT(DISTINCT trade_date) AS count FROM bars_daily WHERE trade_date<=?").get(latest)?.count || 0) : 0;
  const cacheStale = Boolean(latest && cached?.calc_trade_date && cached.calc_trade_date < latest);
  if (tradingDays >= REQUIRED_CLOSE_DAYS && (!cached || cacheStale || !stockRankCacheComplete(cached))) {
    try {
      // A read should repair a structurally old/partial cache without waiting
      // for the next 15:35 scheduler run.  Keep this recovery local and fast;
      // the scheduled refresh may still add the optional 8002 graph labels.
      cached = (await refreshSectorStockRank(db, { endpoint: "", targetDate: latest })).payload;
    } catch {
      // Serving the previous cache is safer than turning a temporary rebuild
      // failure into an outage for the otherwise independent ranking page.
    }
  }
  return paginateRankPayload(cached || emptyRankPayload(latest), options);
}

export async function refreshSectorStockRank(db, options = {}) {
  const targetDate = String(options.targetDate || db.prepare("SELECT MAX(trade_date) AS date FROM bars_daily").get()?.date || "");
  const dates = db.prepare(`SELECT DISTINCT trade_date FROM bars_daily WHERE trade_date<=? ORDER BY trade_date DESC LIMIT ${REQUIRED_CLOSE_DAYS}`).all(targetDate).map((row) => row.trade_date).reverse();
  if (dates.length < REQUIRED_CLOSE_DAYS) {
    const payload = emptyRankPayload(dates.at(-1) || shanghaiDate());
    await writeCache(db, payload);
    return { payload, graphStatus: "skipped", graphError: null, count: 0, message: `有效交易日不足${REQUIRED_CLOSE_DAYS}个，已缓存空榜单` };
  }
  const placeholders = dates.map(() => "?").join(",");
  const securities = db.prepare("SELECT code,symbol,name,industry FROM securities ORDER BY code").all();
  const bars = db.prepare(`SELECT code,trade_date,close FROM bars_daily WHERE trade_date IN (${placeholders}) ORDER BY code,trade_date`).all(...dates);
  if (!bars.length) throw new Error("行情源未返回有效日线数据");
  const rawSectors = rawSectorRows(securities);
  const graph = await enhanceSectorsWithGraph(rawSectors, securities, { ...options, tradeDate: dates.at(-1) });
  const payload = calculateRankPayload({ tradeDates: dates, bars, securities, sectors: graph.sectors });
  const cache = await writeCache(db, payload);
  return {
    payload, graphStatus: graph.status, graphError: graph.error, cache,
    count: payload.sector_rank.sector_3d_gain_list.length + payload.stock_rank.stock_3d_gain_list.length,
    message: `排行已更新：${payload.sector_rank.sector_3d_gain_list.length}个板块、${payload.stock_rank.stock_3d_gain_list.length}只个股；8002图谱${graph.status === "success" ? "已增强" : "不可达，已降级"}`,
  };
}

export function latestMarketTradeDate(db) {
  return db.prepare("SELECT MAX(trade_date) AS date FROM bars_daily").get()?.date || "";
}
