import { randomUUID } from "node:crypto";
import { factorDefinitions, runScreener, shanghaiDate } from "./core.mjs";

const DEFAULT_STRATEGY_ID = "daily-custom";
const TIMEZONE = "Asia/Shanghai";
const allowedFactors = new Set(factorDefinitions.map((item) => item.key));
const filterOnlyFactors = new Set(factorDefinitions.filter((item) => item.filterOnly).map((item) => item.key));
const allowedOperators = new Set([">=", ">", "<=", "<", "="]);
const strictDailyFactors = new Set([
  "ret_5d", "ret_10d", "ret_20d", "ret_30d", "ret_60d",
  "stock_ret_5d_rank", "stock_ret_10d_rank", "stock_ret_30d_rank", "stock_ret_60d_rank", "stock_top50_5_10_30",
  "sector_ret_5d", "sector_ret_5d_rank", "sector_ret_5d_rank_pct", "sector_4d_streak",
  "bigquant_heat_score", "bigquant_heat_rank", "bigquant_heat_rank_pct",
  "formal_model_score", "formal_model_rank_pct", "candidate_model_score", "candidate_model_rank_pct",
]);

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function shanghaiClock(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function factorKeys(config) {
  return [...new Set([
    ...config.filters.map((item) => item.key),
    ...Object.keys(config.weights).filter((key) => Number(config.weights[key]) !== 0),
    config.sort?.key,
  ].filter((key) => allowedFactors.has(key)))];
}

function validateConfig(input = {}, existing = null) {
  const source = input.config || input;
  const filters = (source.filters || []).flatMap((item) => {
    const value = Number(item?.value);
    if (!allowedFactors.has(item?.key) || !allowedOperators.has(item?.operator) || !Number.isFinite(value)) return [];
    return [{ key: item.key, operator: item.operator, value }];
  });
  const weights = Object.fromEntries(Object.entries(source.weights || {}).flatMap(([key, value]) => {
    const numeric = Number(value);
    if (filterOnlyFactors.has(key) && Number.isFinite(numeric) && numeric !== 0) throw new Error(`${key}只能作为硬筛条件，不能加入权重`);
    return allowedFactors.has(key) && Number.isFinite(numeric) && numeric !== 0 ? [[key, numeric]] : [];
  }));
  const weightDirections = Object.fromEntries(Object.keys(weights).map((key) => [key, source.weightDirections?.[key] === "asc" ? "asc" : "desc"]));
  if (!filters.length && !Object.keys(weights).length) throw new Error("至少保留一项硬筛或一项非零加权因子后才能保存每日候选规则");
  const runTime = String(input.runTime ?? existing?.run_time ?? "08:10");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(runTime)) throw new Error("执行时间必须为 HH:MM");
  const sortKey = source.sort?.key === "composite_score" || allowedFactors.has(source.sort?.key)
    ? source.sort.key : Object.keys(weights).length ? "composite_score" : filters[0].key;
  return {
    strategyId: String(input.strategyId || existing?.strategy_id || DEFAULT_STRATEGY_ID),
    name: String(input.name ?? existing?.name ?? "自定义每日候选").trim().slice(0, 40) || "自定义每日候选",
    ruleTag: String(input.ruleTag ?? input.rule_tag ?? existing?.rule_tag ?? "自定义").trim().slice(0, 24) || "自定义",
    enabled: Boolean(input.enabled ?? existing?.enabled ?? false),
    runTime,
    timezone: TIMEZONE,
    tradingDaysOnly: input.tradingDaysOnly === undefined ? Boolean(existing?.trading_days_only ?? true) : Boolean(input.tradingDaysOnly),
    filters,
    weights,
    weightDirections,
    sort: { key: sortKey, direction: source.sort?.direction === "asc" ? "asc" : "desc" },
    limit: Math.max(1, Math.min(100, Number(input.limit ?? existing?.limit_count ?? source.limit ?? 20) || 20)),
  };
}

function decodeStrategy(row) {
  if (!row) return null;
  return {
    strategyId: row.strategy_id, name: row.name, ruleTag: row.rule_tag || "自定义", enabled: Boolean(row.enabled), archived: Boolean(row.archived_at), runTime: row.run_time, timezone: row.timezone,
    tradingDaysOnly: Boolean(row.trading_days_only), filters: parseJson(row.filters_json, []), weights: parseJson(row.weights_json, {}),
    weightDirections: parseJson(row.weight_directions_json, {}), sort: parseJson(row.sort_json, {}), limit: Number(row.limit_count),
    revision: Number(row.revision), lastRunDate: row.last_run_date, lastSuccessAt: row.last_success_at, lastError: row.last_error, updatedAt: row.updated_at,
  };
}

export function ensureScheduledScreenerSchedule(db) {
  db.prepare(`INSERT INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES('daily_custom_screener','自定义量价每日候选','preopen','用户指定Asia/Shanghai时间；交易日；失败每15分钟重试',1,86400,1,
      '规则版本固化；正式BigQuant+Tushare因子截面；若使用BigQuant热度则热度日期必须与因子日一致；关键因子覆盖率≥90%；历史候选批次不可覆盖',CURRENT_TIMESTAMP)
    ON CONFLICT(schedule_key) DO UPDATE SET display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,
      max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`).run();
}

export function saveScheduledScreener(db, input = {}) {
  const requestedId = input.strategyId || (input.createNew ? `daily-${randomUUID().replaceAll("-", "").slice(0, 12)}` : DEFAULT_STRATEGY_ID);
  const existing = db.prepare("SELECT * FROM saved_screener_strategies WHERE strategy_id=?").get(requestedId);
  const config = validateConfig({ ...input, strategyId: requestedId }, existing);
  db.prepare(`INSERT INTO saved_screener_strategies(strategy_id,name,rule_tag,enabled,run_time,timezone,trading_days_only,filters_json,weights_json,weight_directions_json,sort_json,limit_count,revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(strategy_id) DO UPDATE SET name=excluded.name,rule_tag=excluded.rule_tag,enabled=excluded.enabled,run_time=excluded.run_time,
      timezone=excluded.timezone,trading_days_only=excluded.trading_days_only,filters_json=excluded.filters_json,weights_json=excluded.weights_json,
      weight_directions_json=excluded.weight_directions_json,sort_json=excluded.sort_json,limit_count=excluded.limit_count,revision=saved_screener_strategies.revision+1,
      last_error=NULL,updated_at=CURRENT_TIMESTAMP`).run(
    config.strategyId, config.name, config.ruleTag, Number(config.enabled), config.runTime, TIMEZONE, Number(config.tradingDaysOnly), JSON.stringify(config.filters),
    JSON.stringify(config.weights), JSON.stringify(config.weightDirections), JSON.stringify(config.sort), config.limit,
  );
  return scheduledScreenerDashboard(db, config.strategyId);
}

export function archiveScheduledScreener(db, strategyId) {
  const id = String(strategyId || "").trim();
  if (!id) throw new Error("缺少规则标识");
  if (id === DEFAULT_STRATEGY_ID) throw new Error("默认规则不能删除，只能停用");
  const row = db.prepare("SELECT strategy_id FROM saved_screener_strategies WHERE strategy_id=? AND archived_at IS NULL").get(id);
  if (!row) throw new Error("规则不存在或已删除");
  db.prepare("UPDATE saved_screener_strategies SET enabled=0,archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE strategy_id=?").run(id);
  return scheduledScreenerDashboard(db, DEFAULT_STRATEGY_ID);
}

function modelSnapshot(db, rankDate = null) {
  const effectiveDate = rankDate || db.prepare("SELECT MAX(trade_date) AS date FROM chip_model_rank_daily").get()?.date || null;
  const row = effectiveDate ? db.prepare(`SELECT trade_date,
      MAX(formal_model_version) AS formal_model_version,
      MAX(candidate_model_version) AS candidate_model_version,
      MAX(multi_period_model_version) AS multi_period_model_version
    FROM chip_model_rank_daily WHERE trade_date=?`).get(effectiveDate) : null;
  const experimental = db.prepare("SELECT model_version,production_enabled,status FROM experimental_chip_models WHERE scope='multi_period'").get() || {};
  return {
    rankDate: effectiveDate,
    formalModelVersion: row?.formal_model_version || null,
    candidateModelVersion: row?.candidate_model_version || null,
    multiPeriodModelVersion: row?.multi_period_model_version || experimental.model_version || "not_trained",
    multiPeriodAvailable: Boolean(experimental.production_enabled && experimental.model_version && experimental.model_version !== "not_trained"),
    multiPeriodStatus: experimental.status || "sample_collection",
  };
}

function factorDataStatus(db, config, result) {
  const formal = db.prepare("SELECT trade_date,version_id,published_at,source,row_count FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get();
  const factor = db.prepare("SELECT trade_date,version_id,published_at,source,row_count FROM dataset_versions WHERE dataset_key='factor_snapshot' AND status='published' ORDER BY created_at DESC LIMIT 1").get();
  const factorDate = result.factorDate || factor?.trade_date || null;
  const columns = new Set(db.prepare("PRAGMA table_info(factor_snapshot)").all().map((item) => item.name));
  const keys = factorKeys(config);
  const coverage = {};
  const count = factorDate ? Number(db.prepare("SELECT COUNT(*) AS count FROM factor_snapshot WHERE trade_date=?").get(factorDate)?.count || 0) : 0;
  for (const key of keys) {
    if (!columns.has(key) || !factorDate || !count) continue;
    const present = Number(db.prepare(`SELECT COUNT(${key}) AS count FROM factor_snapshot WHERE trade_date=?`).get(factorDate)?.count || 0);
    coverage[key] = { present, total: count, ratio: present / count };
  }
  const heatDate = factorDate ? db.prepare("SELECT MAX(bigquant_heat_date) AS date FROM factor_snapshot WHERE trade_date=?").get(factorDate)?.date || null : null;
  const usesHeat = keys.some((key) => key.startsWith("bigquant_heat_"));
  const failures = [];
  if (result.unavailableFactors?.length) failures.push(result.message || `模型因子不可用：${result.unavailableFactors.join(",")}`);
  if (!formal || !factor || !factorDate || formal.trade_date !== factorDate || factor.trade_date !== factorDate) failures.push("正式BigQuant+Tushare日线与因子截面未同日发布");
  if (usesHeat && heatDate !== factorDate) failures.push(`BigQuant热度截止${heatDate || "无"}，尚未追平正式因子日${factorDate || "无"}`);
  for (const key of keys.filter((item) => strictDailyFactors.has(item))) {
    if (!coverage[key] || coverage[key].ratio < .9) failures.push(`${factorDefinitions.find((item) => item.key === key)?.name || key}覆盖率低于90%`);
  }
  return { pass: failures.length === 0, failures, factorDate, formalVersionId: formal?.version_id || null, factorVersionId: factor?.version_id || null, heatDate, usesHeat, rowCount: count, coverage, modelSnapshot: modelSnapshot(db, result.modelRankDate) };
}

export function runScheduledScreener(db, strategyId = DEFAULT_STRATEGY_ID, triggerType = "manual", runDate = shanghaiDate()) {
  const strategyRow = db.prepare("SELECT * FROM saved_screener_strategies WHERE strategy_id=? AND archived_at IS NULL").get(strategyId);
  if (!strategyRow) throw new Error("请先保存当前自定义筛选规则");
  const config = validateConfig({
    strategyId: strategyRow.strategy_id, name: strategyRow.name, ruleTag: strategyRow.rule_tag, enabled: Boolean(strategyRow.enabled), runTime: strategyRow.run_time,
    tradingDaysOnly: Boolean(strategyRow.trading_days_only), limit: strategyRow.limit_count,
    config: { filters: parseJson(strategyRow.filters_json, []), weights: parseJson(strategyRow.weights_json, {}), weightDirections: parseJson(strategyRow.weight_directions_json, {}), sort: parseJson(strategyRow.sort_json, {}) },
  }, strategyRow);
  const result = runScreener(db, { filters: config.filters, weights: config.weights, weightDirections: config.weightDirections, sort: config.sort, limit: config.limit });
  const dataStatus = factorDataStatus(db, config, result);
  const generatedAt = new Date().toISOString();
  const batchId = `screener-${runDate}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const status = dataStatus.pass ? "published" : "rejected";
  const rows = dataStatus.pass ? result.rows : [];
  const message = dataStatus.pass ? `按第${strategyRow.revision}版规则生成${rows.length}只候选` : dataStatus.failures.join("；");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO screener_candidate_batches(batch_id,strategy_id,run_date,factor_date,trigger_type,status,item_count,strategy_revision,rule_snapshot_json,data_status_json,message,generated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId, strategyId, runDate, dataStatus.factorDate, triggerType, status, rows.length, strategyRow.revision, JSON.stringify(config), JSON.stringify(dataStatus), message, generatedAt);
    const insert = db.prepare("INSERT INTO screener_candidate_items(batch_id,code,rank,composite_score,factor_payload_json) VALUES(?,?,?,?,?)");
    rows.forEach((row, index) => insert.run(batchId, row.code, index + 1, row.composite_score, JSON.stringify(row)));
    db.prepare(`UPDATE saved_screener_strategies SET last_run_date=?,last_success_at=CASE WHEN ?='published' THEN ? ELSE last_success_at END,
      last_error=CASE WHEN ?='published' THEN NULL ELSE ? END,updated_at=CURRENT_TIMESTAMP WHERE strategy_id=?`).run(runDate, status, generatedAt, status, message, strategyId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { batchId, status, message, generatedAt, dataStatus, rows, total: result.total, config };
}

function latestBatch(db, strategyId, onlyPublished = false) {
  const row = db.prepare(`SELECT * FROM screener_candidate_batches WHERE strategy_id=?${onlyPublished ? " AND status='published'" : ""} ORDER BY generated_at DESC LIMIT 1`).get(strategyId);
  if (!row) return null;
  const items = db.prepare("SELECT * FROM screener_candidate_items WHERE batch_id=? ORDER BY rank").all(row.batch_id).map((item) => ({
    ...parseJson(item.factor_payload_json, {}), rank: item.rank, composite_score: item.composite_score,
  }));
  return { batchId: row.batch_id, runDate: row.run_date, factorDate: row.factor_date, triggerType: row.trigger_type, status: row.status,
    itemCount: Number(row.item_count), strategyRevision: Number(row.strategy_revision), dataStatus: parseJson(row.data_status_json, {}), message: row.message,
    generatedAt: row.generated_at, rows: items };
}

export function scheduledScreenerDashboard(db, strategyId = DEFAULT_STRATEGY_ID) {
  const strategies = db.prepare("SELECT * FROM saved_screener_strategies WHERE archived_at IS NULL ORDER BY enabled DESC, updated_at DESC, strategy_id").all().map(decodeStrategy);
  const selectedId = strategyId || DEFAULT_STRATEGY_ID;
  const strategy = strategies.find((item) => item.strategyId === selectedId) || strategies[0] || null;
  const activeId = strategy?.strategyId || selectedId;
  return { strategy, strategies, latestAttempt: latestBatch(db, activeId, false), latestPublished: latestBatch(db, activeId, true), timezone: TIMEZONE, riskNote: "仅供参考，不构成投资建议" };
}

export function runDueScheduledScreeners(db, { isTradingDate = () => true, now = new Date() } = {}) {
  const clock = shanghaiClock(now);
  const strategies = db.prepare("SELECT * FROM saved_screener_strategies WHERE enabled=1 AND archived_at IS NULL AND run_time<=? ORDER BY run_time,strategy_id").all(clock.time);
  const results = [];
  for (const strategy of strategies) {
    if (strategy.trading_days_only && !isTradingDate(clock.date)) continue;
    const published = db.prepare("SELECT 1 FROM screener_candidate_batches WHERE strategy_id=? AND run_date=? AND trigger_type='scheduled' AND status='published' LIMIT 1").get(strategy.strategy_id, clock.date);
    if (published) continue;
    const attempt = db.prepare("SELECT generated_at FROM screener_candidate_batches WHERE strategy_id=? AND run_date=? AND trigger_type='scheduled' ORDER BY generated_at DESC LIMIT 1").get(strategy.strategy_id, clock.date);
    if (attempt && now.getTime() - Date.parse(attempt.generated_at) < 15 * 60_000) continue;
    results.push(runScheduledScreener(db, strategy.strategy_id, "scheduled", clock.date));
  }
  return results;
}
