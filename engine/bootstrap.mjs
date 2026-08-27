import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(engineDir);
const dataDir = join(projectDir, "data");
const databasePath = join(dataDir, "aster.db");
const legacyNewsPath = String.raw`C:\Users\ROG\Documents\Codex\2026-08-18\xu\work\site_deploy\网站便携包_20260818\ai_agent\PythonProject\data\news.sqlite`;
const endpoints = {
  abcd: "http://127.0.0.1:8010/api/realtime/abcd?limit=8",
  factors: "http://127.0.0.1:8010/api/screen/quant?limit=500",
  chips: "http://127.0.0.1:8010/api/chip-model/samples?include_points=false",
  aia: "http://127.0.0.1:8000/api/aia/top10?trade_date=2026-08-20",
  heat: "http://127.0.0.1:8002/api/optimized-stock-picks?date=2026-08-20",
};

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function normalizeCode(value) {
  const raw = String(value || "").toUpperCase().trim();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "").slice(-6);
  if (!/^\d{6}$/.test(digits)) return "";
  const market = digits.startsWith("6") ? "SH" : /^[489]/.test(digits) ? "BJ" : "SZ";
  return `${digits}.${market}`;
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textValue(value, fallback = "") {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(Boolean).join("；");
  if (value && typeof value === "object") return value.summary || value.message || value.reason || JSON.stringify(value);
  return fallback;
}

async function fetchJson(url, timeout = 20_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

function percentileMap(rows, field, higherBetter = true) {
  const values = rows.map((row) => ({ code: row.ts_code, value: number(row[field]) })).filter((item) => item.value !== null).sort((a, b) => a.value - b.value);
  const output = new Map();
  const denominator = Math.max(1, values.length - 1);
  values.forEach((item, index) => output.set(item.code, (higherBetter ? index : denominator - index) * 100 / denominator));
  return output;
}

function latestRowsByIndustry(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.industry || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function initializeDatabase() {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(readFileSync(join(engineDir, "schema.sql"), "utf8"));
  return db;
}

function upsertMetadata(db, key, value) {
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(key, String(value));
}

function upsertSecurity(db, row) {
  const code = normalizeCode(row.ts_code || row.code || row.symbol || row.stock_code);
  if (!code) return "";
  const symbol = code.slice(0, 6);
  db.prepare(`INSERT INTO securities(code,symbol,name,market,industry,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE securities.name END,industry=COALESCE(excluded.industry,securities.industry),updated_at=CURRENT_TIMESTAMP`)
    .run(code, symbol, row.name || row.stock_name || row.security_name || symbol, code.slice(-2), row.industry || row.sector_name || null);
  return code;
}

function importFactors(db, payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const tradeDate = payload?.meta?.latest_daily || shanghaiDate();
  const pctRank = percentileMap(rows, "pct_chg");
  const amountRank = percentileMap(rows, "amount");
  const volumeRank = percentileMap(rows, "volume_ratio_20");
  const ret20Rank = percentileMap(rows, "ret_20d");
  const industries = latestRowsByIndustry(rows);
  const industryReturn = [...industries].map(([industry, group]) => ({ industry, value: group.reduce((sum, row) => sum + (number(row.industry_ret_4d) || 0), 0) / group.length })).sort((a, b) => a.value - b.value);
  const industryPercentile = new Map(industryReturn.map((row, index) => [row.industry, industryReturn.length <= 1 ? 50 : index * 100 / (industryReturn.length - 1)]));
  const withinIndustry = new Map();
  for (const [, group] of industries) {
    const ordered = [...group].sort((a, b) => (number(a.ret_20d) || 0) - (number(b.ret_20d) || 0));
    ordered.forEach((row, index) => withinIndustry.set(row.ts_code, ordered.length <= 1 ? 50 : index * 100 / (ordered.length - 1)));
  }
  const insert = db.prepare(`INSERT INTO factor_snapshot(
    code,trade_date,name,industry,close,pct_chg,amount,turnover_rate,volume_ratio_20,ret_5d,ret_20d,bias_ma20,breakout_20,volatility_20,drawdown_20,industry_ret_4d,previous_heat_score,previous_heat_rank_pct,
    formal_model_score,formal_model_rank,formal_model_rank_pct,candidate_model_score,candidate_model_rank,candidate_model_rank_pct,
    abcd_a_score,abcd_b_score,abcd_c_score,abcd_d_score,aia_sector_heat,aia_stock_heat,aia_leadership,aia_technical_pattern,m30_similarity,
    five_platform_heat,four_agent_score,taoguba_sentiment,daily_breakout_score,source_payload,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(code,trade_date) DO UPDATE SET name=excluded.name,industry=excluded.industry,close=excluded.close,pct_chg=excluded.pct_chg,amount=excluded.amount,turnover_rate=excluded.turnover_rate,
    volume_ratio_20=excluded.volume_ratio_20,ret_5d=excluded.ret_5d,ret_20d=excluded.ret_20d,bias_ma20=excluded.bias_ma20,breakout_20=excluded.breakout_20,volatility_20=excluded.volatility_20,drawdown_20=excluded.drawdown_20,
    industry_ret_4d=excluded.industry_ret_4d,previous_heat_score=excluded.previous_heat_score,previous_heat_rank_pct=excluded.previous_heat_rank_pct,formal_model_score=excluded.formal_model_score,formal_model_rank=excluded.formal_model_rank,
    formal_model_rank_pct=excluded.formal_model_rank_pct,candidate_model_score=excluded.candidate_model_score,candidate_model_rank=excluded.candidate_model_rank,candidate_model_rank_pct=excluded.candidate_model_rank_pct,
    aia_sector_heat=excluded.aia_sector_heat,aia_stock_heat=excluded.aia_stock_heat,aia_leadership=excluded.aia_leadership,aia_technical_pattern=excluded.aia_technical_pattern,five_platform_heat=excluded.five_platform_heat,
    four_agent_score=excluded.four_agent_score,daily_breakout_score=excluded.daily_breakout_score,source_payload=excluded.source_payload,updated_at=CURRENT_TIMESTAMP`);
  for (const row of rows) {
    const code = upsertSecurity(db, row);
    if (!code) continue;
    const formalRankPct = row.chip_shape_rank == null ? null : Math.min(100, Number(row.chip_shape_rank) * 100 / Math.max(rows.length, 5541));
    const heatScore = number(row.previous_heat_score, 50);
    const technical = 0.40 * (ret20Rank.get(row.ts_code) ?? 50) + 0.25 * (pctRank.get(row.ts_code) ?? 50) + 0.20 * (volumeRank.get(row.ts_code) ?? 50) + 0.15 * (number(row.breakout_20) ? 100 : 0);
    insert.run(
      code, tradeDate, row.name || code, row.industry || "其他", number(row.close), number(row.pct_chg), number(row.amount), number(row.turnover_rate), number(row.volume_ratio_20), number(row.ret_5d), number(row.ret_20d), number(row.bias_ma20), number(row.breakout_20), number(row.volatility_20), number(row.drawdown_20), number(row.industry_ret_4d), heatScore, number(row.previous_heat_rank_pct),
      number(row.chip_shape_score), number(row.chip_shape_rank), formalRankPct, number(row.candidate_chip_shape_score), number(row.candidate_chip_shape_rank), number(row.candidate_chip_shape_rank_pct),
      null, null, null, formalRankPct == null ? null : 100 - formalRankPct, industryPercentile.get(row.industry || "其他") ?? 50, heatScore, withinIndustry.get(row.ts_code) ?? 50, technical, null,
      heatScore, 0.45 * technical + 0.35 * (industryPercentile.get(row.industry || "其他") ?? 50) + 0.20 * (amountRank.get(row.ts_code) ?? 50), 50, number(row.breakout_20) ? 100 : 0, JSON.stringify(row)
    );
  }
  upsertMetadata(db, "factor_trade_date", tradeDate);
  upsertMetadata(db, "factor_row_count", rows.length);
  upsertMetadata(db, "formal_model_version", payload?.meta?.formal_chip_shape_model_version || "v16");
  upsertMetadata(db, "candidate_model_version", payload?.meta?.candidate_chip_shape_model_version || "v17");
  return rows.length;
}

function createBatch(db, modelKey, tradeDate, triggerType, version, items, sourceMode = "legacy_migration") {
  const batchId = `${modelKey}-${tradeDate}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO recommendation_batches(batch_id,model_key,trade_date,status,trigger_type,source_mode,item_count,model_version,message,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(batchId, modelKey, tradeDate, "published", triggerType, sourceMode, items.length, version, "一次性迁移旧站有效结果；后续由独立引擎计算", now, now);
  const insert = db.prepare("INSERT INTO recommendations(batch_id,model_key,trade_date,code,rank,score,reason,risk,confidence,payload_json,generated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  items.forEach((item, index) => {
    const code = upsertSecurity(db, item);
    if (!code) return;
    insert.run(batchId, modelKey, tradeDate, code, number(item.rank, index + 1), number(item.score), textValue(item.reason, "模型命中"), textValue(item.risk, "需结合市场环境确认"), number(item.confidence, 0.7), JSON.stringify(item.payload || item), item.generatedAt || now);
  });
  return batchId;
}

function importRecommendations(db, abcdPayload, aiaPayload, heatPayload) {
  const tradeDate = shanghaiDate();
  const abcdRows = (abcdPayload?.rows || []).map((row) => ({ ...row, code: row.ts_code, score: row.abcd_score, reason: [row.a_reason, row.b_reason, row.c_reason, row.d_reason].filter(Boolean).join("；"), risk: row.risk_note, payload: row }));
  const aiaRows = (aiaPayload?.data?.items || []).map((row) => ({ ...row, code: row.symbol, score: row.total_score, reason: row.summary || row.reason || `命中${(row.matched_modules || []).join("、")}`, risk: row.risk?.summary || row.risk || "关注形态失效", payload: row }));
  const heatRows = (heatPayload?.items || []).map((row) => ({ ...row, code: row.stock_code, name: row.stock_name, score: row.optimized_score, reason: row.four_agent_reason || row.original_reason_ex_size || "热度模型命中", risk: row.data_warning || "热度衰减风险", payload: row }));
  createBatch(db, "abcd", tradeDate, "migration", "realtime-abcd-v3", abcdRows);
  createBatch(db, "aia", tradeDate, "migration", "aia.ranking.33ec9b0fba6f", aiaRows);
  createBatch(db, "heat", tradeDate, "migration", "optimized-heat-v4-independent", heatRows);
  const update = db.prepare(`UPDATE factor_snapshot SET abcd_a_score=COALESCE(?,abcd_a_score),abcd_b_score=COALESCE(?,abcd_b_score),abcd_c_score=COALESCE(?,abcd_c_score),abcd_d_score=COALESCE(?,abcd_d_score),m30_similarity=COALESCE(?,m30_similarity),five_platform_heat=COALESCE(?,five_platform_heat),four_agent_score=COALESCE(?,four_agent_score),taoguba_sentiment=COALESCE(?,taoguba_sentiment),daily_breakout_score=COALESCE(?,daily_breakout_score) WHERE code=? AND trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)`);
  for (const row of abcdPayload?.rows || []) update.run(number(row.a_score), number(row.b_score), number(row.c_score), number(row.d_score), null, null, null, null, null, normalizeCode(row.ts_code));
  for (const row of aiaPayload?.data?.items || []) {
    const m30 = row?.features?.m30?.template_calibration || row?.features?.pattern_results?.m30 || {};
    update.run(null, null, null, null, number(m30.similarity), null, null, null, null, normalizeCode(row.symbol));
  }
  for (const row of heatPayload?.items || []) {
    const factors = row.factor_scores || {};
    update.run(null, null, null, null, null, number(factors.five_platform_heat), number(factors.four_agent_rank), number(factors.taoguba_sentiment), number(factors.daily_breakout), normalizeCode(row.stock_code));
  }
  return { abcd: abcdRows.length, aia: aiaRows.length, heat: heatRows.length };
}

function importChipRegistry(db, payload) {
  const registry = payload || {};
  const upsertModel = db.prepare(`INSERT INTO model_registry(scope,display_name,model_version,model_path,sample_count,ready_count,revision,applied_revision,pending_retrain,status,last_error,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(scope) DO UPDATE SET display_name=excluded.display_name,model_version=excluded.model_version,sample_count=excluded.sample_count,ready_count=excluded.ready_count,revision=excluded.revision,applied_revision=excluded.applied_revision,pending_retrain=excluded.pending_retrain,status=excluded.status,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP`);
  const insertSample = db.prepare(`INSERT INTO chip_samples(sample_id,scope,code,trade_date,name,reason,source,profile_ready,main_peak_price,second_peak_price,profit_ratio,peak2_ratio,peak_width_70,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(sample_id) DO UPDATE SET name=excluded.name,reason=excluded.reason,profile_ready=excluded.profile_ready,main_peak_price=excluded.main_peak_price,second_peak_price=excluded.second_peak_price,profit_ratio=excluded.profit_ratio,peak2_ratio=excluded.peak2_ratio,peak_width_70=excluded.peak_width_70,updated_at=CURRENT_TIMESTAMP`);
  for (const scope of ["formal", "candidate"]) {
    const data = registry?.scopes?.[scope] || {};
    const modelPath = scope === "formal" ? "engine/models/chip_formal/model.joblib" : "engine/models/chip_candidate/model.joblib";
    upsertModel.run(scope, scope === "formal" ? "正式筹码模型" : "候选筹码模型", data.model_version || "unknown", modelPath, data.sample_count || 0, data.ready_count || 0, data.revision || 0, data.applied_revision || 0, data.pending_retrain ? 1 : 0, registry.retrain_status || data.last_status || "unknown", data.last_error || registry.last_error || null);
    for (const sample of data.samples || []) {
      insertSample.run(sample.sample_id, scope, normalizeCode(sample.ts_code), String(sample.trade_date || "").slice(0, 10), sample.security_name || sample.name || "", sample.reason || "正样本", sample.source || "legacy_migration", sample.profile_ready ? 1 : 0, sample.main_peak_price ?? null, sample.second_peak_price ?? null, sample.profit_ratio ?? null, sample.peak2_ratio ?? null, sample.peak_width_70 ?? null, sample.created_at || new Date().toISOString());
    }
  }
}

async function importBars(db, codes) {
  const insert = db.prepare(`INSERT INTO bars_30m(code,trade_time,open,high,low,close,volume,amount,source) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code,trade_time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,amount=excluded.amount,source=excluded.source`);
  let total = 0;
  for (let start = 0; start < codes.length; start += 6) {
    const chunk = codes.slice(start, start + 6);
    const results = await Promise.allSettled(chunk.map((code) => fetchJson(`http://127.0.0.1:8010/api/minute30/${encodeURIComponent(code)}?days=30`, 15_000)));
    results.forEach((result, index) => {
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) return;
      const code = chunk[index];
      for (const bar of result.value) {
        insert.run(code, bar.trade_time, number(bar.open, 0), number(bar.high, 0), number(bar.low, 0), number(bar.close, 0), number(bar.volume), number(bar.amount), "8010_migration");
        total += 1;
      }
    });
  }
  return total;
}

function importTemplate(db) {
  const sourcePath = String.raw`D:\机器选股\data\aia\templates\tmpl-m30-197f6460.json`;
  const profile = JSON.parse(readFileSync(sourcePath, "utf8"));
  db.prepare(`INSERT INTO template_profiles(template_id,module,display_name,confidence,enabled,vector_json,image_path,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(template_id) DO UPDATE SET confidence=excluded.confidence,enabled=excluded.enabled,vector_json=excluded.vector_json,image_path=excluded.image_path,updated_at=CURRENT_TIMESTAMP`)
    .run(profile.template_id, profile.module, "30分钟平台突破 · MA20转强", profile.confidence, profile.enabled ? 1 : 0, JSON.stringify(profile.vector), "engine/models/aia/tmpl-m30-197f6460.png", profile.extractor_version, profile.created_at);
}

function importNews(db) {
  let source;
  try { source = new DatabaseSync(legacyNewsPath, { readOnly: true }); } catch { return 0; }
  const rows = source.prepare(`SELECT CAST(id AS TEXT) AS id,title,content,COALESCE(source,provider) AS source,url,publish_time,raw_json FROM news
    WHERE publish_time >= '2025-01-01' AND publish_time < '2027-01-01' ORDER BY publish_time DESC LIMIT 2500`).all();
  const posts = source.prepare(`SELECT CAST(article_id AS TEXT) AS id,title,content,source,url,publish_time,raw_json FROM taoguba_articles
    WHERE publish_time >= '2025-01-01' AND publish_time < '2027-01-01' ORDER BY publish_time DESC LIMIT 800`).all();
  const insert = db.prepare(`INSERT INTO news_evidence(evidence_id,title,content,source,url,published_at,related_codes,industry,sentiment,relevance,raw_json,imported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(evidence_id) DO NOTHING`);
  for (const row of [...rows, ...posts]) {
    const sourceName = row.source || "历史新闻库";
    const id = createHash("sha1").update(`${sourceName}|${row.id}|${row.url || row.title}`).digest("hex");
    insert.run(id, row.title || String(row.content || "").slice(0, 80), row.content || "", sourceName, row.url || "", row.publish_time || "", "[]", null, null, 0.5, row.raw_json || "{}");
  }
  source.close();
  return rows.length + posts.length;
}

function seedDefinitions(db) {
  const models = [
    ["abcd", "盘中ABCD", "independent-abcd-v1", "scheduled_0945+manual", null, { A: "板块强度", B: "个股量价与热度", C: "行业龙头性", D: "正式筹码模型横截面分", total: "A/B/C/D等权" }],
    ["aia", "AIA Top10", "aia.ranking.33ec9b0fba6f", "manual", null, { sector_heat: 0.31818, stock_heat: 0.31818, leadership: 0.18182, technical_pattern: 0.18182, m30: "规则命中后最多按模板置信度调整±5分" }],
    ["heat", "热度优先", "optimized-heat-v4-independent", "manual", null, { five_platform_heat: 0.35, four_agent: 0.25, industry_momentum: 0.15, original_score: 0.10, taoguba_sentiment: 0.075, daily_breakout: 0.075, gate: "热度命中或至少2个Agent确认" }],
  ];
  const insertModel = db.prepare(`INSERT INTO model_definitions(model_key,display_name,version,refresh_mode,refresh_seconds,logic_json,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(model_key) DO UPDATE SET display_name=excluded.display_name,version=excluded.version,refresh_mode=excluded.refresh_mode,refresh_seconds=excluded.refresh_seconds,logic_json=excluded.logic_json,updated_at=CURRENT_TIMESTAMP`);
  for (const [key, name, version, mode, seconds, logic] of models) insertModel.run(key, name, version, mode, seconds, JSON.stringify(logic));
  const schedules = [
    ["intraday_quotes", "盘中行情与ABCD", "intraday", "交易日09:25预热；AKShare行情盘中持续更新；ABCD于09:45自动生成首批，其后按需手动重算", 420, 1, "仅AKShare；覆盖率≥95%；同步沉淀ABCD五分钟筹码线；手动重算不改写模拟账户09:45快照；旧快照可回滚"],
    ["after_close", "收盘行情与基础因子", "after_close", "交易日 15:15、16:10", 90000, 3, "交易日一致；500只研究池覆盖≥400；关键字段完整率≥92%"],
    ["night_models", "夜间双模型排名与模板", "night", "交易日 20:30、22:00", 90000, 2, "两模型全市场同截面；模型文件哈希通过；模板输入≥30根K线"],
    ["night_evidence", "夜间新闻与行业证据", "night", "每日 19:30、23:15", 54000, 3, "日期合法；URL去重；来源和发布时间必填"],
    ["backup_integrity", "备份与完整性检查", "maintenance", "每日 23:50", 172800, 2, "PRAGMA integrity_check=ok；备份可打开；保留7个日备份"],
  ];
  const insertSchedule = db.prepare(`INSERT INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at) VALUES(?,?,?,?,1,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(schedule_key) DO UPDATE SET display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`);
  for (const row of schedules) insertSchedule.run(...row);
}

function recordInitialQuality(db, counts) {
  const now = new Date().toISOString();
  const checks = [
    ["factor_snapshot", counts.factors >= 400 ? "pass" : "fail", counts.factors, ">=400"],
    ["recommendations", counts.recommendations >= 20 ? "pass" : "warn", counts.recommendations, ">=20"],
    ["bars_30m", counts.bars >= 300 ? "pass" : "warn", counts.bars, ">=300"],
    ["news_evidence", counts.news >= 1000 ? "pass" : "warn", counts.news, ">=1000"],
  ];
  const insert = db.prepare("INSERT INTO data_quality_checks(check_id,dataset_key,version_id,check_name,severity,status,observed_value,expected_value,message,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (const [dataset, status, observed, expected] of checks) insert.run(randomUUID(), dataset, "bootstrap", "初始迁移完整性", status === "fail" ? "critical" : "warning", status, String(observed), expected, status === "pass" ? "通过质量门禁" : "保留上一可用版本并告警", now);
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES(?,?,?,?,?,'published','legacy_one_time_migration',?,?,?)")
    .run("independent_bootstrap", "bootstrap", shanghaiDate(), Object.values(counts).reduce((sum, value) => sum + value, 0), createHash("sha256").update(JSON.stringify(counts)).digest("hex"), 95, now, now);
}

async function main() {
  const db = initializeDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const [factors, abcd, aia, heat, chips] = await Promise.all([
      fetchJson(endpoints.factors, 30_000), fetchJson(endpoints.abcd), fetchJson(endpoints.aia), fetchJson(endpoints.heat), fetchJson(endpoints.chips),
    ]);
    const factorCount = importFactors(db, factors);
    const recommendationCounts = importRecommendations(db, abcd, aia, heat);
    importChipRegistry(db, chips);
    importTemplate(db);
    const newsCount = importNews(db);
    seedDefinitions(db);
    db.exec("COMMIT");
    const codes = db.prepare("SELECT DISTINCT code FROM recommendations ORDER BY code").all().map((row) => row.code);
    const barCount = await importBars(db, codes);
    db.exec("BEGIN IMMEDIATE");
    recordInitialQuality(db, { factors: factorCount, recommendations: Object.values(recommendationCounts).reduce((sum, value) => sum + value, 0), bars: barCount, news: newsCount });
    upsertMetadata(db, "bootstrap_completed_at", new Date().toISOString());
    upsertMetadata(db, "runtime_dependency", "independent_database_and_engine");
    db.exec("COMMIT");
    db.exec("PRAGMA optimize");
    console.log(JSON.stringify({ databasePath, factorCount, recommendationCounts, barCount, newsCount, codes: codes.length }, null, 2));
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
import "./env.mjs";
