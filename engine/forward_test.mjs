import { createHash, randomUUID } from "node:crypto";

const ACCOUNT_SPECS = [
  ["abcd", "ABCD 策略账户"],
  ["aia", "AIA 策略账户"],
  ["heat", "热度优先账户"],
  ["consensus", "三策略共识前五"],
];
const ACCOUNT_KEYS = ACCOUNT_SPECS.map(([key]) => key);
const RULES_VERSION = "forward-abcd-0945-t1-limit-filter-v4";
const ABCD_SIGNAL_CLOCK = "09:45";
const ABCD_EXECUTION_TIME = "09:50";
const ABCD_MAX_DAILY_BUYS = 5;
const ABCD_MAX_POSITIONS = 10;

const DEFAULTS = {
  initialCapital: 1_000_000,
  allocationRatio: 0.5,
  feeRate: 0.0003,
  stampTaxRate: 0.0005,
  lotSize: 100,
  rulesVersion: RULES_VERSION,
};

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", weekday: "short", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function nextEntryDate(date = new Date()) {
  const parts = shanghaiParts(date);
  const current = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 9 * 60 + 45) current.setUTCDate(current.getUTCDate() + 1);
  while ([0, 6].includes(current.getUTCDay())) current.setUTCDate(current.getUTCDate() + 1);
  return current.toISOString().slice(0, 10);
}

function shanghaiDateKey(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nowIso() { return new Date().toISOString(); }
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function round(value, digits = 4) { const scale = 10 ** digits; return Math.round((number(value) + Number.EPSILON) * scale) / scale; }

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function auditHash(row) {
  return createHash("sha256").update([
    row.sequence_no, row.event_time, row.account_key || "", row.event_type,
    row.previous_hash || "", stableStringify(JSON.parse(row.payload_json)),
  ].join("|")).digest("hex");
}

function appendAudit(db, accountKey, eventType, payload, eventTime = nowIso()) {
  const last = db.prepare("SELECT sequence_no,event_hash FROM forward_audit_events ORDER BY sequence_no DESC LIMIT 1").get();
  const row = {
    sequence_no: Number(last?.sequence_no || 0) + 1,
    event_time: eventTime,
    account_key: accountKey || null,
    event_type: eventType,
    previous_hash: String(last?.event_hash || "GENESIS"),
    payload_json: stableStringify(payload),
  };
  const hash = auditHash(row);
  db.prepare("INSERT INTO forward_audit_events(event_id,sequence_no,account_key,event_type,event_time,payload_json,previous_hash,event_hash) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), row.sequence_no, row.account_key, row.event_type, row.event_time, row.payload_json, row.previous_hash, hash);
  return hash;
}

export function ensureForwardTest(db, { startDate = null } = {}) {
  const existing = db.prepare("SELECT * FROM forward_test_settings WHERE settings_id='default'").get();
  const rules = {
    startPolicy: "仅向前运行，不回填历史；休市、推荐或行情未通过门禁时保留失败证据",
    preopen: "AIA与热度优先盘前计算；允许使用当时可见的上一交易日正式数据，09:30按AKShare开盘价买入",
    entry: "ABCD只接受09:45档不可变信号，取综合排名前5；计算可以延后完成，但不得改用更晚档信号；按09:50 AKShare分钟收盘价成交；执行价触及涨停则过滤并保留审计事件",
    limitFilter: "四个模拟账户均执行涨停不可买入过滤：AIA与热度优先按09:30开盘价，ABCD按09:50分钟价，共识账户按其实际执行快照；过滤只影响成交，不修改推荐信号",
    consensus: "共识账户只引用已经锁定的09:45 ABCD批次，再合并盘前AIA与热度优先批次取前五",
    exit: "买入后的下一个实际交易日15:00，以BigQuant与Tushare正式日线收盘价卖出；跌停则顺延",
    rolling: "与8010 ABCD T+1一致：每日批次使用当时账户权益50%，最多5只等额分配、最多同时10个持仓档位",
    fee: "佣金买卖各0.03%，卖出印花税0.05%；沿用原正测口径，不设最低佣金",
    immutability: "信号、执行价、买卖动作和审计事件只追加不覆盖；更正通过作废记录保留原动作",
  };
  if (!existing) {
    const createdAt = nowIso();
    const effectiveStart = startDate || nextEntryDate();
    db.prepare(`INSERT INTO forward_test_settings(settings_id,enabled,start_date,entry_time,initial_capital,daily_allocation_ratio,fee_rate,stamp_tax_rate,lot_size,rules_version,rules_json,created_at)
      VALUES('default',1,?,?,?,?,?,?,?,?,?,?)`).run(effectiveStart, "09:30 / ABCD 09:45信号→09:50成交", DEFAULTS.initialCapital, DEFAULTS.allocationRatio, DEFAULTS.feeRate, DEFAULTS.stampTaxRate, DEFAULTS.lotSize, DEFAULTS.rulesVersion, stableStringify(rules), createdAt);
    appendAudit(db, null, "TEST_ARMED", { startDate: effectiveStart, ...DEFAULTS, rules });
  } else if (existing.rules_version !== RULES_VERSION) {
    db.prepare("UPDATE forward_test_settings SET entry_time=?,rules_version=?,rules_json=?,updated_at=CURRENT_TIMESTAMP WHERE settings_id='default'")
      .run("09:30 / ABCD 09:45信号→09:50成交", RULES_VERSION, stableStringify(rules));
    appendAudit(db, null, "RULES_UPDATED", { from: existing.rules_version, to: RULES_VERSION, rules });
  }
  const settings = db.prepare("SELECT * FROM forward_test_settings WHERE settings_id='default'").get();
  const insert = db.prepare("INSERT OR IGNORE INTO forward_accounts(account_key,display_name,initial_capital,cash,status,created_at) VALUES(?,?,?,?, 'active', ?)");
  for (const [key, name] of ACCOUNT_SPECS) insert.run(key, name, number(settings.initial_capital), number(settings.initial_capital), settings.created_at);
  const schedule = db.prepare(`INSERT INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES(?,?,?,?,1,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(schedule_key) DO UPDATE SET display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,enabled=1,max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`);
  schedule.run("forward_preopen", "AIA与热度优先盘前批次", "preopen", "交易日08:30盘前计算", 3600, 1, "只使用当时已可见数据；允许上一交易日正式数据；失败保留最近已发布批次并标注日期");
  schedule.run("forward_open_0930", "AIA与热度优先开盘成交", "intraday", "交易日09:30起持续重试至收盘", 600, 10, "必须是盘前已锁定批次；仅使用AKShare当日开盘价；行情延迟时继续重试，不因09:40超时作废；开盘涨停候选过滤并留痕");
  schedule.run("forward_0945", "ABCD 09:45锁定信号与T+1账户", "intraday", "交易日09:45启动唯一信号档；计算完成后补取09:50成交价", 600, 6, "只接受09:45信号档；AKShare 09:50分钟价；涨停过滤；半仓等权；动作只追加不可覆盖");
  const scheduleResetKey = `forward_schedule_reset_${RULES_VERSION}`;
  if (!db.prepare("SELECT 1 FROM metadata WHERE key=?").get(scheduleResetKey)) {
    db.prepare("UPDATE schedule_definitions SET last_started_at=NULL,last_success_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE schedule_key IN ('forward_preopen','forward_open_0930','forward_0945')").run();
    db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)").run(scheduleResetKey, "旧版单时点成功状态已清除；等待新版真实成交结果");
  }
  return settings;
}

function parseJson(value, fallback = {}) { try { return JSON.parse(value || ""); } catch { return fallback; } }

function stageMetadataKey(tradeDate, stage) { return `forward_stage_${tradeDate}_${stage}`; }

export function saveForwardStage(db, tradeDate, stage, payload) {
  const value = { ...payload, tradeDate, stage, updatedAt: nowIso() };
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .run(stageMetadataKey(tradeDate, stage), stableStringify(value));
  return value;
}

export function readForwardStage(db, tradeDate, stage) {
  const row = db.prepare("SELECT value FROM metadata WHERE key=?").get(stageMetadataKey(tradeDate, stage));
  return row ? parseJson(row.value, null) : null;
}

function signalBucketText(value) {
  const text = String(value || "").trim();
  const compact = text.match(/(20\d{2})(\d{2})(\d{2})[ T]?(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}`;
  const normal = text.match(/(20\d{2}-\d{2}-\d{2}).*?(\d{2}):(\d{2})/);
  return normal ? `${normal[1]} ${normal[2]}:${normal[3]}` : "";
}

export function isLockedAbcdSignalBucket(value, tradeDate) {
  return signalBucketText(value) === `${tradeDate} ${ABCD_SIGNAL_CLOCK}`;
}

export function readForwardSignalSnapshot(db, accountKey, tradeDate, signalClock = ABCD_SIGNAL_CLOCK) {
  return db.prepare("SELECT * FROM forward_signal_snapshots WHERE account_key=? AND trade_date=? AND signal_clock=?")
    .get(accountKey, tradeDate, signalClock) || null;
}

export function lockForwardSignalSnapshot(db, {
  accountKey = "abcd", tradeDate, signalClock = ABCD_SIGNAL_CLOCK, signalBucket = null,
  status, recommendationBatchId = null, sourceAsOf = null, generatedAt = nowIso(), payload = {}, createdAt = nowIso(),
} = {}) {
  const existing = readForwardSignalSnapshot(db, accountKey, tradeDate, signalClock);
  if (existing) return existing;
  if (!tradeDate || !["ready", "empty", "missed", "error"].includes(status)) throw new Error("无效的向前信号锁定请求");
  if (status === "ready" && (!recommendationBatchId || !isLockedAbcdSignalBucket(signalBucket, tradeDate))) {
    throw new Error("ABCD账户只允许锁定09:45信号档");
  }
  const serialized = stableStringify(payload || {});
  const checksum = createHash("sha256").update(stableStringify({ accountKey, tradeDate, signalClock, signalBucket, status, recommendationBatchId, sourceAsOf, payload: parseJson(serialized) })).digest("hex");
  const signalId = randomUUID();
  db.prepare(`INSERT INTO forward_signal_snapshots(signal_id,account_key,trade_date,signal_clock,signal_bucket,status,recommendation_batch_id,source_as_of,generated_at,checksum,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(signalId, accountKey, tradeDate, signalClock, signalBucket, status, recommendationBatchId, sourceAsOf, generatedAt, checksum, serialized, createdAt);
  appendAudit(db, accountKey, "SIGNAL_LOCKED", { signalId, tradeDate, signalClock, signalBucket, status, recommendationBatchId, sourceAsOf, checksum }, createdAt);
  return readForwardSignalSnapshot(db, accountKey, tradeDate, signalClock);
}

export function saveForwardExecutionQuotes(db, { tradeDate, executionTime = ABCD_EXECUTION_TIME, prices = [], capturedAt = nowIso() } = {}) {
  if (!tradeDate || executionTime !== ABCD_EXECUTION_TIME) throw new Error("ABCD执行价必须是09:50分钟收盘价");
  const insert = db.prepare(`INSERT OR IGNORE INTO forward_execution_quotes(trade_date,execution_time,code,price,prev_close,source,source_as_of,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of prices || []) {
      const price = positiveNumber(row.price); const code = String(row.code || "").toUpperCase();
      if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code) || !price || !/^akshare/i.test(String(row.source || ""))) continue;
      const previous = db.prepare("SELECT prev_close FROM realtime_quotes WHERE code=?").get(code)?.prev_close;
      count += Number(insert.run(tradeDate, executionTime, code, price, positiveNumber(row.prev_close) || positiveNumber(previous), row.source, row.source_as_of || `${tradeDate}T${executionTime}:00+08:00`, stableStringify(row), capturedAt).changes || 0);
    }
    if (count) appendAudit(db, "abcd", "EXECUTION_QUOTES_LOCKED", { tradeDate, executionTime, count, sourcePolicy: "akshare_minute_only" }, capturedAt);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { tradeDate, executionTime, count };
}

export function latestForwardBatches(db, { tradeDate, finishedBefore = nowIso(), models = ["abcd", "aia", "heat"], exactTradeDate = false } = {}) {
  const maximumTradeDate = tradeDate || shanghaiDateKey();
  const batches = {}; const details = {};
  for (const model of models) {
    const row = db.prepare(`SELECT batch_id,model_key,trade_date,finished_at,model_version,item_count,trigger_type,source_mode
      FROM recommendation_batches WHERE model_key=? AND status='published' AND trade_date${exactTradeDate ? "=" : "<="}? AND finished_at<=?
      ORDER BY finished_at DESC LIMIT 1`).get(model, maximumTradeDate, finishedBefore);
    batches[model] = row?.batch_id || null;
    details[model] = row || null;
  }
  return { batches, details, tradeDate: maximumTradeDate, finishedBefore };
}

function batchRows(db, modelKey, batchId) {
  if (!batchId) return [];
  return db.prepare(`SELECT r.*,s.name,s.industry,b.status AS batch_status,b.trade_date AS batch_trade_date,b.finished_at,b.model_version
    FROM recommendations r JOIN recommendation_batches b ON b.batch_id=r.batch_id
    JOIN securities s ON s.code=r.code WHERE r.batch_id=? AND r.model_key=?
      AND b.status IN ('published','superseded') ORDER BY r.rank`).all(batchId, modelKey);
}

function buildCandidateSets(db, batchIds) {
  const modelRows = {};
  for (const key of ["abcd", "aia", "heat"]) modelRows[key] = batchRows(db, key, batchIds?.[key]);
  const aggregate = new Map();
  for (const [model, rows] of Object.entries(modelRows)) {
    for (const row of rows) {
      if (!aggregate.has(row.code)) aggregate.set(row.code, { ...row, models: [], batchIds: [], scores: [], ranks: [] });
      const item = aggregate.get(row.code);
      item.models.push(model); item.batchIds.push(row.batch_id); item.scores.push(number(row.score)); item.ranks.push(number(row.rank, 999));
    }
  }
  const consensus = [...aggregate.values()].map((row) => ({ ...row,
    consensus_count: row.models.length,
    score: row.scores.reduce((sum, value) => sum + value, 0) / row.scores.length,
    rank_sum: row.ranks.reduce((sum, value) => sum + value, 0),
  })).sort((left, right) => right.consensus_count - left.consensus_count || right.score - left.score || left.rank_sum - right.rank_sum || left.code.localeCompare(right.code)).slice(0, 5);
  return { ...modelRows, consensus };
}

function quoteDateTime(row) {
  const raw = String(row?.quote_time || row?.received_at || "");
  const compact = raw.match(/(20\d{2})(\d{2})(\d{2})[ T]?(\d{2})(\d{2})(\d{2})?/);
  if (compact) return { date: `${compact[1]}-${compact[2]}-${compact[3]}`, time: `${compact[4]}:${compact[5]}:${compact[6] || "00"}` };
  const iso = raw.match(/(20\d{2}-\d{2}-\d{2}).*?(\d{2}:\d{2}(?::\d{2})?)/);
  return iso ? { date: iso[1], time: iso[2].length === 5 ? `${iso[2]}:00` : iso[2] } : { date: "", time: "" };
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function priceLimitRate(code, name = "") {
  if (/ST/i.test(String(name || ""))) return 0.05;
  if (String(code).endsWith(".BJ")) return 0.30;
  if (/^(300|301|688|689)/.test(String(code))) return 0.20;
  return 0.10;
}

function limitPrice(previousClose, rate, direction) {
  const previous = positiveNumber(previousClose);
  return previous ? Math.round(previous * (1 + direction * rate) * 100) / 100 : null;
}

function isLimitUp(code, name, price, previousClose) {
  const value = limitPrice(previousClose, priceLimitRate(code, name), 1);
  return value !== null && number(price) >= value - 0.001;
}

function isLimitDown(code, name, price, previousClose) {
  const value = limitPrice(previousClose, priceLimitRate(code, name), -1);
  return value !== null && number(price) <= value + 0.001;
}

function executionQuote(row, tradeDate, { executionMode = "dynamic", signalReadyAt = null } = {}) {
  if (executionMode === "abcd_t1") {
    const price = positiveNumber(row?.price);
    if (!price || row?.trade_date !== tradeDate || row?.execution_time !== ABCD_EXECUTION_TIME || !/^akshare/i.test(String(row?.source || ""))) return null;
    return {
      price, time: ABCD_EXECUTION_TIME, source: row.source,
      stamp: { date: tradeDate, time: `${ABCD_EXECUTION_TIME}:00` },
      previousClose: positiveNumber(row.prev_close), sourceAsOf: row.source_as_of,
    };
  }
  const stamp = quoteDateTime(row);
  const sourceOk = /^akshare/i.test(String(row?.source || ""));
  if (!row || !sourceOk || stamp.date !== tradeDate) return null;
  if (executionMode === "open") {
    const openPrice = positiveNumber(row.open_price);
    // The open price remains the valid execution price even when the quote
    // arrives late. Keep retrying the provider instead of expiring at 09:40.
    if (!openPrice || stamp.time < "09:29:00") return null;
    return { price: openPrice, time: "09:30:00", stamp, source: `${row.source}:official_open`, previousClose: positiveNumber(row.prev_close) };
  }
  const price = positiveNumber(row.price);
  const inSession = (stamp.time >= "09:44:00" && stamp.time <= "11:30:59") || (stamp.time >= "13:00:00" && stamp.time <= "14:59:59");
  if (!price || !inSession) return null;
  const quoteMillis = Date.parse(`${stamp.date}T${stamp.time}+08:00`);
  const readyMillis = signalReadyAt ? Date.parse(signalReadyAt) : NaN;
  if (Number.isFinite(readyMillis) && (!Number.isFinite(quoteMillis) || quoteMillis < readyMillis)) return null;
  return { price, time: stamp.time, stamp, source: row.source, previousClose: positiveNumber(row.prev_close) };
}

function createSkippedCohort(db, accountKey, tradeDate, batchIds, reason, openedAt) {
  const existing = db.prepare("SELECT * FROM forward_cohorts WHERE account_key=? AND entry_trade_date=?").get(accountKey, tradeDate);
  if (existing) return existing;
  const cohortId = randomUUID();
  db.prepare(`INSERT INTO forward_cohorts(cohort_id,account_key,entry_trade_date,target_exit_rule,entry_batch_ids_json,status,opened_at,skip_reason)
    VALUES(?,?,?,'next_trade_day_close',?,'skipped',?,?)`).run(cohortId, accountKey, tradeDate, stableStringify(batchIds || {}), openedAt, reason);
  appendAudit(db, accountKey, "COHORT_SKIPPED", { cohortId, tradeDate, reason, batchIds }, openedAt);
  return db.prepare("SELECT * FROM forward_cohorts WHERE cohort_id=?").get(cohortId);
}

export function openForwardCohorts(db, { tradeDate, batches, openedAt = nowIso(), accountKeys = ACCOUNT_KEYS, executionMode = "dynamic", signalReadyAt = null, signalReadyAtByAccount = {}, finalizeMissing = true } = {}) {
  const settings = ensureForwardTest(db);
  if (!number(settings.enabled)) return { status: "disabled", tradeDate, accounts: [] };
  if (!tradeDate || tradeDate < settings.start_date) return { status: "not_started", startDate: settings.start_date, tradeDate, accounts: [] };
  const candidates = buildCandidateSets(db, batches || {});
  const output = [];
  const selected = new Set((accountKeys || ACCOUNT_KEYS).filter((key) => ACCOUNT_KEYS.includes(key)));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [accountKey] of ACCOUNT_SPECS.filter(([key]) => selected.has(key))) {
      const accountExecutionMode = accountKey === "abcd" ? "abcd_t1" : executionMode;
      const duplicate = db.prepare("SELECT * FROM forward_cohorts WHERE account_key=? AND entry_trade_date=?").get(accountKey, tradeDate);
      if (duplicate && !(accountExecutionMode === "open" && duplicate.status === "skipped" && /AKShare开盘价未通过/.test(String(duplicate.skip_reason || "")))) { output.push({ accountKey, status: "duplicate", cohortId: duplicate.cohort_id }); continue; }
      if (duplicate) db.prepare("DELETE FROM forward_cohorts WHERE cohort_id=?").run(duplicate.cohort_id);
      let picks = candidates[accountKey] || [];
      if (accountKey === "abcd") {
        const availableSlots = Math.max(0, ABCD_MAX_POSITIONS - openPositions(db, accountKey).length);
        picks = picks.slice(0, Math.min(ABCD_MAX_DAILY_BUYS, availableSlots));
      }
      const neededModels = accountKey === "consensus" ? Object.values(batches || {}).filter(Boolean).length : (batches?.[accountKey] ? 1 : 0);
      if (accountKey === "abcd") {
        const locked = readForwardSignalSnapshot(db, "abcd", tradeDate);
        const validLock = locked?.status === "ready" && locked.recommendation_batch_id === batches?.abcd && isLockedAbcdSignalBucket(locked.signal_bucket, tradeDate);
        if (!validLock) {
          if (!finalizeMissing) { output.push({ accountKey, status: "waiting", reason: "等待09:45不可变ABCD信号档" }); continue; }
          const reason = locked ? `09:45信号状态为${locked.status}，禁止使用更晚信号补买` : "09:45信号快照缺失，禁止使用更晚信号补买";
          const skipped = createSkippedCohort(db, accountKey, tradeDate, batches, reason, openedAt);
          output.push({ accountKey, status: "skipped", cohortId: skipped.cohort_id, reason }); continue;
        }
      }
      if (!neededModels || !picks.length) {
        if (!finalizeMissing) { output.push({ accountKey, status: "waiting", reason: neededModels ? "新推荐批次尚无可买候选" : "对应策略批次仍在计算" }); continue; }
        const missingReason = accountExecutionMode === "open" ? "对应策略盘前推荐批次未成功" : accountKey === "abcd" ? "09:45信号档未形成" : "对应策略09:45后仍未完成计算";
        const skipped = createSkippedCohort(db, accountKey, tradeDate, batches, neededModels ? "新推荐批次无可买候选" : missingReason, openedAt);
        output.push({ accountKey, status: "skipped", cohortId: skipped.cohort_id, reason: skipped.skip_reason }); continue;
      }
      if (accountKey === "consensus" && neededModels < 3) {
        if (!finalizeMissing) { output.push({ accountKey, status: "waiting", reason: "等待ABCD、AIA、热度优先三个批次全部就绪" }); continue; }
        const skipped = createSkippedCohort(db, accountKey, tradeDate, batches, "ABCD、AIA、热度优先未全部成功发布，三策略共识账户不成交", openedAt);
        output.push({ accountKey, status: "skipped", cohortId: skipped.cohort_id, reason: skipped.skip_reason }); continue;
      }
      const codes = picks.map((row) => row.code);
      const quoteSql = accountExecutionMode === "abcd_t1"
        ? `SELECT * FROM forward_execution_quotes WHERE trade_date=? AND execution_time=? AND code IN (${codes.map(() => "?").join(",")})`
        : `SELECT * FROM realtime_quotes WHERE code IN (${codes.map(() => "?").join(",")})`;
      const quoteRows = accountExecutionMode === "abcd_t1"
        ? db.prepare(quoteSql).all(tradeDate, ABCD_EXECUTION_TIME, ...codes)
        : db.prepare(quoteSql).all(...codes);
      const quotes = new Map(quoteRows.map((row) => [row.code, row]));
      const accountSignalReadyAt = signalReadyAtByAccount?.[accountKey] || signalReadyAt;
      const evaluated = picks.map((row) => {
        const quote = quotes.get(row.code); const execution = executionQuote(quote, tradeDate, { executionMode: accountExecutionMode, signalReadyAt: accountSignalReadyAt });
        const blockedAtLimit = Boolean(execution && isLimitUp(row.code, row.name, execution.price, execution.previousClose));
        return { row, quote, execution: blockedAtLimit ? null : execution, blockedAtLimit, rejectedExecution: blockedAtLimit ? execution : null };
      });
      const valid = evaluated.filter(({ execution }) => execution);
      const limitBlocked = evaluated.filter(({ blockedAtLimit }) => blockedAtLimit);
      const missingQuotes = evaluated.filter(({ execution, blockedAtLimit }) => !execution && !blockedAtLimit);
      if (accountExecutionMode === "abcd_t1" && missingQuotes.length && !finalizeMissing) {
        const missingCodes = missingQuotes.map((item) => item.row.code);
        output.push({ accountKey, status: "waiting", reason: `等待全部ABCD候选的AKShare 09:50分钟价：${missingCodes.join("、")}` });
        continue;
      }
      if (!valid.length) {
        if (missingQuotes.length && !finalizeMissing) { output.push({ accountKey, status: "waiting", reason: accountExecutionMode === "open" ? "等待AKShare当日开盘价" : accountExecutionMode === "abcd_t1" ? "等待AKShare 09:50分钟收盘价" : "等待不早于信号完成时刻的AKShare盘中行情" }); continue; }
        const allLimitUp = limitBlocked.length === picks.length;
        const reason = allLimitUp
          ? `全部${limitBlocked.length}只候选在执行时点涨停，不做虚拟买入`
          : accountExecutionMode === "open" ? "AKShare开盘价未通过日期、时间或价格门禁" : accountExecutionMode === "abcd_t1" ? "AKShare 09:50分钟价缺失或候选涨停不可买入" : "AKShare动态成交快照未通过日期、时点或价格门禁";
        const skipped = createSkippedCohort(db, accountKey, tradeDate, batches, reason, openedAt);
        for (const item of limitBlocked) appendAudit(db, accountKey, "BUY_FILTERED_LIMIT_UP", { cohortId: skipped.cohort_id, tradeDate, code: item.row.code, name: item.row.name, executionMode: accountExecutionMode, price: item.rejectedExecution?.price, previousClose: item.rejectedExecution?.previousClose, limitRate: priceLimitRate(item.row.code, item.row.name), reason: "执行价达到涨停价，不计入买入" }, openedAt);
        output.push({ accountKey, status: "skipped", cohortId: skipped.cohort_id, reason: skipped.skip_reason }); continue;
      }
      const account = db.prepare("SELECT * FROM forward_accounts WHERE account_key=?").get(accountKey);
      const currentPositions = openPositions(db, accountKey);
      const markedValue = currentPositions.reduce((sum, position) => {
        const quote = db.prepare("SELECT price FROM realtime_quotes WHERE code=?").get(position.code);
        const bar = db.prepare("SELECT close FROM bars_daily WHERE code=? ORDER BY trade_date DESC LIMIT 1").get(position.code);
        return sum + number(position.quantity) * number(quote?.price, bar?.close);
      }, 0);
      const equity = number(account.cash) + markedValue;
      const budget = Math.min(equity * number(settings.daily_allocation_ratio), number(account.cash) * 0.999);
      const perPick = budget / (accountKey === "abcd" ? ABCD_MAX_DAILY_BUYS : valid.length);
      const orders = [];
      let totalCost = 0;
      for (const { row, quote, execution } of valid) {
        const price = execution.price; const lot = Math.max(1, number(settings.lot_size, 100));
        let quantity = Math.floor(perPick / price / lot) * lot;
        let gross = quantity * price; let commission = gross * number(settings.fee_rate);
        while (quantity >= lot && totalCost + gross + commission > number(account.cash)) { quantity -= lot; gross = quantity * price; commission = gross * number(settings.fee_rate); }
        if (quantity < lot) continue;
        totalCost += gross + commission;
        orders.push({ row, quote, execution, price, quantity, gross, commission, sourceAsOf: execution.sourceAsOf || `${execution.stamp.date}T${execution.stamp.time}+08:00` });
      }
      if (!orders.length) {
        if (!finalizeMissing) { output.push({ accountKey, status: "waiting", reason: "等待价格满足整手成交条件" }); continue; }
        const skipped = createSkippedCohort(db, accountKey, tradeDate, batches, "资金不足整手或候选价格不可成交", openedAt);
        output.push({ accountKey, status: "skipped", cohortId: skipped.cohort_id, reason: skipped.skip_reason }); continue;
      }
      const cohortId = randomUUID();
      const entryValue = orders.reduce((sum, item) => sum + item.gross + item.commission, 0);
      db.prepare(`INSERT INTO forward_cohorts(cohort_id,account_key,entry_trade_date,target_exit_rule,entry_batch_ids_json,status,allocated_cash,entry_value,opened_at)
        VALUES(?,?,?,'next_trade_day_close',?,'open',?,?,?)`).run(cohortId, accountKey, tradeDate, stableStringify(batches || {}), budget, entryValue, openedAt);
      for (const item of limitBlocked) appendAudit(db, accountKey, "BUY_FILTERED_LIMIT_UP", { cohortId, tradeDate, code: item.row.code, name: item.row.name, executionMode: accountExecutionMode, price: item.rejectedExecution?.price, previousClose: item.rejectedExecution?.previousClose, limitRate: priceLimitRate(item.row.code, item.row.name), reason: "执行价达到涨停价，不计入买入" }, openedAt);
      for (const order of orders) {
        const recommendationModel = accountKey === "consensus" ? order.row.models.join("+") : accountKey;
        const batchId = accountKey === "consensus" ? order.row.batchIds.join("+") : order.row.batch_id;
        const tradeId = randomUUID();
        const payload = { industry: order.row.industry, reason: order.row.reason, risk: order.row.risk, entryMode: accountExecutionMode, signalClock: accountExecutionMode === "abcd_t1" ? ABCD_SIGNAL_CLOCK : null, executionClock: accountExecutionMode === "abcd_t1" ? ABCD_EXECUTION_TIME : null, signalReadyAt: signalReadyAtByAccount?.[accountKey] || signalReadyAt || null, batchIds: accountKey === "consensus" ? order.row.batchIds : [order.row.batch_id], models: accountKey === "consensus" ? order.row.models : [accountKey] };
        db.prepare(`INSERT INTO forward_trades(trade_id,account_key,cohort_id,side,trade_date,trade_time,code,name,quantity,price,gross_amount,commission,stamp_tax,net_cash_flow,source,source_as_of,recommendation_model,recommendation_batch_id,recommendation_rank,recommendation_score,consensus_count,payload_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tradeId, accountKey, cohortId, "BUY", tradeDate, accountExecutionMode === "open" ? "09:30" : order.execution.time, order.row.code, order.row.name, order.quantity, order.price, order.gross, order.commission, 0, -(order.gross + order.commission), order.execution.source, order.sourceAsOf, recommendationModel, batchId, number(order.row.rank, null), number(order.row.score, null), number(order.row.consensus_count, accountKey === "consensus" ? 0 : 1), stableStringify(payload), openedAt);
        appendAudit(db, accountKey, "BUY", { tradeId, cohortId, tradeDate, tradeTime: accountExecutionMode === "open" ? "09:30" : order.execution.time, entryMode: accountExecutionMode, signalClock: accountExecutionMode === "abcd_t1" ? ABCD_SIGNAL_CLOCK : null, code: order.row.code, quantity: order.quantity, price: order.price, gross: round(order.gross), commission: round(order.commission), source: order.execution.source, sourceAsOf: order.sourceAsOf, recommendationModel, batchId }, openedAt);
      }
      db.prepare("UPDATE forward_accounts SET cash=cash-?,total_fees=total_fees+?,updated_at=? WHERE account_key=?")
        .run(entryValue, orders.reduce((sum, item) => sum + item.commission, 0), openedAt, accountKey);
      appendAudit(db, accountKey, "COHORT_OPENED", { cohortId, tradeDate, entryMode: accountExecutionMode, signalReadyAt: signalReadyAtByAccount?.[accountKey] || signalReadyAt || null, pickCount: orders.length, budget: round(budget), entryValue: round(entryValue), batchIds: batches }, openedAt);
      output.push({ accountKey, status: "open", cohortId, count: orders.length, filteredLimitUp: limitBlocked.length, filteredCodes: limitBlocked.map((item) => item.row.code), entryValue: round(entryValue) });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  recordForwardEquity(db, tradeDate, executionMode === "open" ? "akshare_open" : executionMode === "abcd_t1" ? "akshare_0950_locked" : "akshare_signal_ready");
  return { status: "completed", tradeDate, executionMode, accounts: output, batchIds: batches };
}

function openPositions(db, accountKey = null) {
  const condition = accountKey ? "AND t.account_key=?" : "";
  const args = accountKey ? [accountKey] : [];
  return db.prepare(`SELECT t.account_key,t.cohort_id,t.code,MAX(t.name) AS name,
    SUM(CASE WHEN t.side='BUY' THEN t.quantity ELSE -t.quantity END) AS quantity,
    SUM(CASE WHEN t.side='BUY' THEN t.gross_amount+t.commission ELSE 0 END) AS cost,
    MIN(CASE WHEN t.side='BUY' THEN t.trade_date END) AS buy_date
    FROM forward_trades t JOIN forward_cohorts c ON c.cohort_id=t.cohort_id
    LEFT JOIN forward_trade_voids v ON v.trade_id=t.trade_id
    WHERE c.status IN ('open','partial') AND v.trade_id IS NULL ${condition} GROUP BY t.account_key,t.cohort_id,t.code
    HAVING SUM(CASE WHEN t.side='BUY' THEN t.quantity ELSE -t.quantity END)>0`).all(...args);
}

export function closeDueForwardCohorts(db, { tradeDate, closedAt = nowIso() }) {
  ensureForwardTest(db);
  const cohorts = db.prepare("SELECT * FROM forward_cohorts WHERE status IN ('open','partial') AND entry_trade_date<? ORDER BY entry_trade_date,account_key").all(tradeDate);
  const output = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const cohort of cohorts) {
      const positions = openPositions(db, cohort.account_key).filter((row) => row.cohort_id === cohort.cohort_id);
      let proceeds = 0; let sellFees = 0; let realized = 0; const missing = [];
      for (const position of positions) {
        const bar = db.prepare("SELECT * FROM bars_daily WHERE code=? AND trade_date=? AND lower(source) LIKE '%bigquant%' AND lower(source) LIKE '%tushare%'").get(position.code, tradeDate);
        if (!bar || number(bar.close) <= 0) { missing.push(position.code); continue; }
        const prior = db.prepare("SELECT close FROM bars_daily WHERE code=? AND trade_date<? AND lower(source) LIKE '%bigquant%' AND lower(source) LIKE '%tushare%' ORDER BY trade_date DESC LIMIT 1").get(position.code, tradeDate);
        if (isLimitDown(position.code, position.name, bar.close, prior?.close)) { missing.push(`${position.code}(跌停顺延)`); continue; }
        const quantity = number(position.quantity); const price = number(bar.close); const gross = quantity * price;
        const settings = db.prepare("SELECT * FROM forward_test_settings WHERE settings_id='default'").get();
        const commission = gross * number(settings.fee_rate); const tax = gross * number(settings.stamp_tax_rate); const net = gross - commission - tax;
        const tradeId = randomUUID();
        db.prepare(`INSERT INTO forward_trades(trade_id,account_key,cohort_id,side,trade_date,trade_time,code,name,quantity,price,gross_amount,commission,stamp_tax,net_cash_flow,source,source_as_of,payload_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tradeId, cohort.account_key, cohort.cohort_id, "SELL", tradeDate, "15:00", position.code, position.name, quantity, price, gross, commission, tax, net, `bars_daily:${bar.source}`, `${tradeDate}T15:00:00+08:00`, stableStringify({ exitRule: "next_trade_day_close", buyDate: position.buy_date }), closedAt);
        proceeds += net; sellFees += commission + tax; realized += net - number(position.cost);
        appendAudit(db, cohort.account_key, "SELL", { tradeId, cohortId: cohort.cohort_id, tradeDate, code: position.code, quantity, price, gross: round(gross), commission: round(commission), stampTax: round(tax), source: bar.source }, closedAt);
      }
      db.prepare("UPDATE forward_accounts SET cash=cash+?,realized_pnl=realized_pnl+?,total_fees=total_fees+?,updated_at=? WHERE account_key=?")
        .run(proceeds, realized, sellFees, closedAt, cohort.account_key);
      const totals = db.prepare(`SELECT
        SUM(CASE WHEN side='SELL' THEN net_cash_flow ELSE 0 END) AS exit_value,
        SUM(CASE WHEN side='BUY' THEN -net_cash_flow ELSE 0 END) AS entry_value,
        SUM(CASE WHEN side='BUY' THEN quantity ELSE -quantity END) AS remaining
        FROM forward_trades t LEFT JOIN forward_trade_voids v ON v.trade_id=t.trade_id
        WHERE t.cohort_id=? AND v.trade_id IS NULL`).get(cohort.cohort_id);
      const closed = number(totals.remaining) <= 0;
      const pnl = number(totals.exit_value) - number(totals.entry_value);
      db.prepare("UPDATE forward_cohorts SET status=?,exit_value=?,pnl=?,return_pct=?,closed_at=?,skip_reason=? WHERE cohort_id=?")
        .run(closed ? "closed" : "partial", number(totals.exit_value), pnl, number(totals.entry_value) ? pnl / number(totals.entry_value) : 0, closed ? closedAt : null, missing.length ? `以下证券当日无双源正式收盘价，继续持有：${missing.join("、")}` : null, cohort.cohort_id);
      appendAudit(db, cohort.account_key, closed ? "COHORT_CLOSED" : "COHORT_PARTIAL", { cohortId: cohort.cohort_id, tradeDate, pnl: round(pnl), returnPct: number(totals.entry_value) ? round(pnl / number(totals.entry_value), 8) : 0, missing }, closedAt);
      output.push({ accountKey: cohort.account_key, cohortId: cohort.cohort_id, status: closed ? "closed" : "partial", pnl: round(pnl), missing });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  recordForwardEquity(db, tradeDate, "bigquant+tushare_official_close");
  return { status: "completed", tradeDate, cohorts: output, count: output.length };
}

export function voidForwardCohort(db, { accountKey, tradeDate, reason, correctedAt = nowIso(), evidence = {} } = {}) {
  ensureForwardTest(db);
  const cohort = db.prepare("SELECT * FROM forward_cohorts WHERE account_key=? AND entry_trade_date=?").get(accountKey, tradeDate);
  if (!cohort) return { status: "missing", accountKey, tradeDate };
  const activeTrades = db.prepare(`SELECT t.* FROM forward_trades t
    LEFT JOIN forward_trade_voids v ON v.trade_id=t.trade_id
    WHERE t.cohort_id=? AND v.trade_id IS NULL ORDER BY t.created_at`).all(cohort.cohort_id);
  if (!activeTrades.length && cohort.status === "skipped") return { status: "already_voided", accountKey, tradeDate, cohortId: cohort.cohort_id };
  if (activeTrades.some((row) => row.side !== "BUY")) throw new Error("已有卖出动作的批次不能自动作废，需人工逐笔冲正");
  const restoredCash = activeTrades.reduce((sum, row) => sum - number(row.net_cash_flow), 0);
  const restoredFees = activeTrades.reduce((sum, row) => sum + number(row.commission) + number(row.stamp_tax), 0);
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertVoid = db.prepare("INSERT INTO forward_trade_voids(trade_id,reason,replacement_trade_ids_json,voided_at,payload_json) VALUES(?,?, '[]', ?,?)");
    for (const trade of activeTrades) {
      insertVoid.run(trade.trade_id, reason, correctedAt, stableStringify({ evidence, originalAction: { side: trade.side, tradeDate: trade.trade_date, tradeTime: trade.trade_time, code: trade.code, quantity: trade.quantity } }));
      appendAudit(db, accountKey, "TRADE_VOIDED", { tradeId: trade.trade_id, cohortId: cohort.cohort_id, reason, evidence }, correctedAt);
    }
    db.prepare("UPDATE forward_accounts SET cash=cash+?,total_fees=max(0,total_fees-?),updated_at=? WHERE account_key=?")
      .run(restoredCash, restoredFees, correctedAt, accountKey);
    db.prepare("UPDATE forward_cohorts SET status='skipped',allocated_cash=0,entry_value=0,exit_value=0,pnl=NULL,return_pct=NULL,closed_at=?,skip_reason=? WHERE cohort_id=?")
      .run(correctedAt, reason, cohort.cohort_id);
    appendAudit(db, accountKey, "COHORT_CORRECTED", { cohortId: cohort.cohort_id, tradeDate, reason, voidedTradeIds: activeTrades.map((row) => row.trade_id), restoredCash: round(restoredCash), restoredFees: round(restoredFees), evidence }, correctedAt);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  recordForwardEquity(db, tradeDate, "ledger_correction_append_only");
  return { status: "voided", accountKey, tradeDate, cohortId: cohort.cohort_id, voidedTrades: activeTrades.length, restoredCash: round(restoredCash), restoredFees: round(restoredFees) };
}

export function recordForwardEquity(db, tradeDate, source = "latest_available") {
  const settings = ensureForwardTest(db); const computedAt = nowIso();
  const accounts = db.prepare("SELECT * FROM forward_accounts ORDER BY account_key").all();
  const insert = db.prepare(`INSERT INTO forward_equity_daily(account_key,trade_date,cash,market_value,total_equity,realized_pnl,unrealized_pnl,return_pct,source,computed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_key,trade_date) DO UPDATE SET cash=excluded.cash,market_value=excluded.market_value,total_equity=excluded.total_equity,realized_pnl=excluded.realized_pnl,unrealized_pnl=excluded.unrealized_pnl,return_pct=excluded.return_pct,source=excluded.source,computed_at=excluded.computed_at`);
  for (const account of accounts) {
    const positions = openPositions(db, account.account_key); let marketValue = 0; let openCost = 0;
    for (const position of positions) {
      const bar = db.prepare("SELECT close FROM bars_daily WHERE code=? AND trade_date<=? ORDER BY trade_date DESC LIMIT 1").get(position.code, tradeDate);
      const quote = db.prepare("SELECT price FROM realtime_quotes WHERE code=?").get(position.code);
      const price = source.startsWith("akshare") ? number(quote?.price, bar?.close) : number(bar?.close, quote?.price);
      marketValue += number(position.quantity) * price; openCost += number(position.cost);
    }
    const equity = number(account.cash) + marketValue; const unrealized = marketValue - openCost;
    insert.run(account.account_key, tradeDate, number(account.cash), marketValue, equity, number(account.realized_pnl), unrealized, (equity - number(settings.initial_capital)) / number(settings.initial_capital), source, computedAt);
  }
}

export function verifyForwardAudit(db) {
  const rows = db.prepare("SELECT * FROM forward_audit_events ORDER BY sequence_no").all();
  let previous = "GENESIS"; const failures = [];
  rows.forEach((row, index) => {
    if (number(row.sequence_no) !== index + 1) failures.push(`序号断裂：${row.sequence_no}`);
    if (row.previous_hash !== previous) failures.push(`前序哈希不匹配：${row.sequence_no}`);
    if (auditHash(row) !== row.event_hash) failures.push(`事件内容被改变：${row.sequence_no}`);
    previous = row.event_hash;
  });
  return { valid: failures.length === 0, eventCount: rows.length, failures, genesis: rows[0]?.event_hash || null, latestHash: rows.at(-1)?.event_hash || null, verifiedAt: nowIso() };
}

export function forwardPreview(db) {
  const tradeDate = shanghaiDateKey();
  const fallback = latestForwardBatches(db, { tradeDate });
  const preopen = readForwardStage(db, tradeDate, "preopen");
  const lockedAbcd = readForwardSignalSnapshot(db, "abcd", tradeDate);
  const latest = {
    abcd: lockedAbcd?.status === "ready" ? lockedAbcd.recommendation_batch_id : null,
    aia: preopen?.batches?.aia || fallback.batches.aia,
    heat: preopen?.batches?.heat || fallback.batches.heat,
  };
  const sets = buildCandidateSets(db, latest);
  return { note: "AIA与热度优先锁定盘前可见批次并在09:30成交；ABCD只使用09:45锁定信号，完成后按09:50分钟价形成T+1买单。", tradeDate, batchIds: latest, preopenDetails: preopen?.details || fallback.details, models: Object.fromEntries(["abcd", "aia", "heat"].map((key) => [key, sets[key].slice(0, 12)])), consensus: sets.consensus };
}

export function forwardDashboard(db) {
  const settings = ensureForwardTest(db);
  const audit = verifyForwardAudit(db);
  const tradeDate = shanghaiDateKey();
  const accounts = db.prepare("SELECT * FROM forward_accounts ORDER BY CASE account_key WHEN 'abcd' THEN 1 WHEN 'aia' THEN 2 WHEN 'heat' THEN 3 ELSE 4 END").all().map((account) => {
    const equity = db.prepare("SELECT * FROM forward_equity_daily WHERE account_key=? ORDER BY trade_date DESC LIMIT 1").get(account.account_key);
    const positions = openPositions(db, account.account_key).map((row) => {
      const quote = db.prepare("SELECT price,quote_time,source FROM realtime_quotes WHERE code=?").get(row.code);
      const bar = db.prepare("SELECT close,trade_date,source FROM bars_daily WHERE code=? ORDER BY trade_date DESC LIMIT 1").get(row.code);
      const price = number(quote?.price, bar?.close); return { ...row, currentPrice: price, marketValue: price * number(row.quantity), quoteSource: quote?.source || bar?.source, quoteAsOf: quote?.quote_time || bar?.trade_date };
    });
    return { ...account, latestEquity: equity || { cash: account.cash, market_value: positions.reduce((sum, row) => sum + row.marketValue, 0), total_equity: number(account.cash) + positions.reduce((sum, row) => sum + row.marketValue, 0), return_pct: 0 }, positions,
      closedCohorts: db.prepare("SELECT * FROM forward_cohorts WHERE account_key=? AND status='closed' ORDER BY closed_at DESC LIMIT 20").all(account.account_key) };
  });
  return {
    settings: { ...settings, rules: parseJson(settings.rules_json), initial_capital: number(settings.initial_capital), daily_allocation_ratio: number(settings.daily_allocation_ratio) },
    accounts,
    openCohorts: db.prepare("SELECT * FROM forward_cohorts WHERE status IN ('open','partial') ORDER BY entry_trade_date DESC,account_key").all(),
    recentTrades: db.prepare(`SELECT t.*,v.voided_at,v.reason AS void_reason,
      CASE WHEN v.trade_id IS NULL THEN 0 ELSE 1 END AS voided
      FROM forward_trades t LEFT JOIN forward_trade_voids v ON v.trade_id=t.trade_id
      ORDER BY t.trade_date DESC,t.trade_time DESC,t.created_at DESC LIMIT 100`).all(),
    recentCohorts: db.prepare("SELECT * FROM forward_cohorts ORDER BY opened_at DESC LIMIT 40").all(),
    signalSnapshots: db.prepare("SELECT * FROM forward_signal_snapshots ORDER BY trade_date DESC,signal_clock DESC LIMIT 40").all(),
    execution: {
      tradeDate,
      preopen: readForwardStage(db, tradeDate, "preopen"),
      open: readForwardStage(db, tradeDate, "open"),
      abcd: { ...(readForwardStage(db, tradeDate, "abcd") || {}), signalSnapshot: readForwardSignalSnapshot(db, "abcd", tradeDate) },
      plan: [
        { key: "preopen", time: "08:30", label: "锁定AIA与热度优先", rule: "允许使用当时可见的上一交易日正式数据" },
        { key: "open", time: "09:30", label: "AIA与热度优先开盘成交", rule: "使用AKShare当日开盘价" },
        { key: "abcd", time: "09:45 → 09:50", label: "锁定ABCD并按T+1规则成交", rule: "只接受09:45信号档；计算可延后，成交价固定取AKShare 09:50分钟收盘；半仓5只等权" },
      ],
    },
    audit,
  };
}

function csvCell(value) { const text = typeof value === "string" ? value : JSON.stringify(value ?? ""); return `"${text.replaceAll('"', '""')}"`; }

export function forwardAuditExport(db, format = "json") {
  const audit = verifyForwardAudit(db);
  const settings = db.prepare("SELECT * FROM forward_test_settings WHERE settings_id='default'").get();
  const accounts = db.prepare("SELECT * FROM forward_accounts ORDER BY account_key").all();
  const cohorts = db.prepare("SELECT * FROM forward_cohorts ORDER BY opened_at").all();
  const trades = db.prepare("SELECT * FROM forward_trades ORDER BY trade_date,trade_time,created_at").all();
  const tradeVoids = db.prepare("SELECT * FROM forward_trade_voids ORDER BY voided_at").all();
  const signalSnapshots = db.prepare("SELECT * FROM forward_signal_snapshots ORDER BY trade_date,signal_clock").all();
  const executionQuotes = db.prepare("SELECT * FROM forward_execution_quotes ORDER BY trade_date,execution_time,code").all();
  const events = db.prepare("SELECT * FROM forward_audit_events ORDER BY sequence_no").all();
  const payload = { exportedAt: nowIso(), audit, settings, accounts, cohorts, trades, tradeVoids, signalSnapshots, executionQuotes, events };
  if (format !== "csv") return { contentType: "application/json; charset=utf-8", filename: `aster-forward-audit-${nowIso().slice(0, 10)}.json`, content: JSON.stringify(payload, null, 2) };
  const columns = ["trade_id","account_key","cohort_id","side","trade_date","trade_time","code","name","quantity","price","gross_amount","commission","stamp_tax","net_cash_flow","source","source_as_of","recommendation_model","recommendation_batch_id","recommendation_rank","recommendation_score","consensus_count"];
  const lines = [columns.map(csvCell).join(","), ...trades.map((row) => columns.map((key) => csvCell(row[key])).join(","))];
  return { contentType: "text/csv; charset=utf-8", filename: `aster-forward-trades-${nowIso().slice(0, 10)}.csv`, content: `\uFEFF${lines.join("\r\n")}` };
}
