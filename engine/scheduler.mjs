import { randomUUID } from "node:crypto";
import { backupDatabase, publishAlgorithmTask, runWatchdog, shanghaiDate } from "./core.mjs";
import { activateOfficialMarketData, markOfficialMarketDataPending, marketDataState, rebuildDailyFactors, refreshAkshareQuotes, refreshBigquantHeatRank, refreshOfficialDailyBars, scoreChipModels, syncChipAxes, syncMarketFactorSnapshot, syncRecommendationDailyHistory } from "./data_sources.mjs";
import { refreshExactKlineSimilarityCache, runAbcdRecommendation, runAbcdWarmup, runAiaRecommendation, runChipRetrain, runCommunityHotTopics, runForwardExecutionPrices, runHeatRecommendation, runNewsCollectors, runNightlyMarketSync, runPreopenDailyPanel } from "./algorithm_bridge.mjs";
import { closeDueForwardCohorts, ensureForwardTest, isLockedAbcdSignalBucket, lockForwardSignalSnapshot, openForwardCohorts, readForwardSignalSnapshot, readForwardStage, saveForwardExecutionQuotes, saveForwardStage } from "./forward_test.mjs";
import { saveFivePlatformSnapshot, syncLatestFivePlatformCache } from "./five_platform.mjs";
import { ensurePreopenSchedule, savePreopenSummary } from "./preopen.mjs";
import { ensureCommunityTopicSchedule, saveCommunityTopics } from "./community_topics.mjs";
import { ensureSectorStockRankSchedule, isAshareTradingDate, latestMarketTradeDate, refreshSectorStockRank } from "./sector_stock_rank.mjs";
import { ensureExpertTrackerSchedules, runExpertShadowExperiment, runExpertTrackerUpdate, syncExpertTrackerHeartbeat } from "./expert_tracker.mjs";
import { resolveOpenAlert, upsertOpenAlert } from "./maintenance.mjs";
import { ensureScheduledScreenerSchedule, runDueScheduledScreeners } from "./scheduled_screener.mjs";

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", weekday: "short", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function isTradingSession(parts) {
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return (minutes >= 9 * 60 + 25 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60);
}

function completedM30Window(parts) {
  if (["Sat", "Sun"].includes(parts.weekday)) return null;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const closes = [10 * 60, 10 * 60 + 30, 11 * 60, 11 * 60 + 30, 13 * 60 + 30, 14 * 60, 14 * 60 + 30, 15 * 60];
  const close = closes.find((value) => minutes >= value && minutes <= value + 4);
  return close == null ? null : `${String(Math.floor(close / 60)).padStart(2, "0")}${String(close % 60).padStart(2, "0")}`;
}

function taskDue(db, key, intervalSeconds) {
  const value = db.prepare("SELECT value FROM metadata WHERE key=?").get(`scheduler_${key}`)?.value;
  if (!value) return true;
  return Date.now() - Date.parse(value) >= intervalSeconds * 1000;
}

function markTask(db, key, when = new Date().toISOString()) {
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(`scheduler_${key}`, when);
}

function ensureSimilarityCacheSchedule(db) {
  db.prepare(`INSERT INTO schedule_definitions(
    schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at
  ) VALUES(
    'similarity_cache_incremental_refresh','K线相似度自动增量缓存','continuous','每15分钟；单实例；每批120只；仅读取本站正式日线与AKShare盘中仓库',1,900,1,
    '日线与30分钟K线、特征快照及收盘矩阵增量提交；旧缓存失败时保留',CURRENT_TIMESTAMP
  ) ON CONFLICT(schedule_key) DO UPDATE SET
    display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,
    enabled=excluded.enabled,max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,
    quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`).run();
}

function ensureBigquantHeatSchedule(db) {
  db.prepare(`INSERT INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES('bigquant_daily_heat','BigQuant全市场热度','preopen','正式日线次日00:05起每15分钟检查，成功后停止',1,86400,1,
      '脚本直连既有BigQuant cn_stock_hot_rank；与最新正式因子日同日且覆盖≥4000只；原子更新月度Parquet后再重发SQLite因子；失败保留旧截面并禁止热度规则发布',CURRENT_TIMESTAMP)
    ON CONFLICT(schedule_key) DO UPDATE SET display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,
      max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`).run();
}

let similarityCacheRefresh = null;

function fivePlatformSnapshotNeedsRecovery(db, tradeDate) {
  const snapshot = db.prepare("SELECT snapshot_id FROM five_platform_snapshots WHERE trade_date=? ORDER BY generated_at DESC LIMIT 1").get(tradeDate);
  if (!snapshot) return true;
  const rows = db.prepare("SELECT ok,source_date,item_count FROM five_platform_sources WHERE snapshot_id=?").all(snapshot.snapshot_id);
  if (rows.length !== 5) return true;
  return rows.some((row) => Number(row.ok) !== 1 || String(row.source_date || "") !== tradeDate || Number(row.item_count || 0) < 10);
}

function metadataNumber(db, key) {
  return Number(db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value || 0);
}

function setMetadataNumber(db, key, value) {
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(key, String(value));
}

function shiftDate(dateKey, days) {
  const value = new Date(`${dateKey}T04:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousTradingDate(dateKey, includeDate = true) {
  let cursor = includeDate ? dateKey : shiftDate(dateKey, -1);
  for (let count = 0; count < 20; count += 1) {
    if (isAshareTradingDate(cursor)) return cursor;
    cursor = shiftDate(cursor, -1);
  }
  return cursor;
}

function officialTargetDate(dateKey, parts, minutes) {
  const todayCanBeComplete = !["Sat", "Sun"].includes(parts.weekday) && isAshareTradingDate(dateKey) && minutes >= 16 * 60 + 30;
  return previousTradingDate(dateKey, todayCanBeComplete);
}

function quotaExceeded(error) {
  return /周配额|配额不足|quota/i.test(String(error?.message || error || ""));
}

function schedulerErrorMessage(error) {
  const text = String(error?.message || error || "").replace(/\s+/g, " ").trim();
  if (quotaExceeded(text)) return "BigQuant周配额已达上限；脚本已暂停正式源任务，将在周日24:00（周一00:00，Asia/Shanghai）自动重试";
  return text.slice(0, 360) || "数据任务失败，上一发布版本继续生效";
}

export function nextSundayMidnight(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  let days = (8 - weekday) % 7;
  if (days === 0) days = 7;
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days));
  return new Date(localDate.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function quotaHoldFromRecentJobs(db) {
  const row = db.prepare("SELECT status,message,finished_at FROM sync_jobs WHERE job_type IN ('after_close_bars','after_close_market_db','night_market_chips') ORDER BY finished_at DESC LIMIT 1").get();
  if (!row || row.status !== "failed" || !quotaExceeded(row.message)) return null;
  return { nextRetryAt: nextSundayMidnight(new Date(row.finished_at)), error: schedulerErrorMessage(row.message) };
}

async function scheduledJob(db, type, source, action, scheduleKey = type) {
  const jobId = randomUUID(); const startedAt = new Date().toISOString();
  const schedule = db.prepare("SELECT retry_limit FROM schedule_definitions WHERE schedule_key=? AND enabled=1").get(scheduleKey);
  const retryLimit = Math.max(1, Number(schedule?.retry_limit || 1));
  db.prepare("INSERT INTO sync_jobs(job_id,job_type,status,source,rows_changed,message,started_at) VALUES(?,?,'running',?,0,'',?)").run(jobId, type, source, startedAt);
  db.prepare("UPDATE schedule_definitions SET last_started_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key=?").run(startedAt, scheduleKey);
  let lastError;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      const result = await action();
      const finishedAt = new Date().toISOString();
      const partial = type === "stock_market_preopen_daily_panel" && result?.status === "partial";
      db.prepare("UPDATE sync_jobs SET status=?,rows_changed=?,message=?,finished_at=? WHERE job_id=?").run(partial ? "partial" : "success", Number(result?.count || 0), `${result?.message || "任务完成"}${partial ? "；当日新闻不完整，等待自动补抓" : ""}（第${attempt}次执行）`, finishedAt, jobId);
      if (!partial) db.prepare("UPDATE schedule_definitions SET last_success_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key=?").run(finishedAt, scheduleKey);
      if (partial) upsertOpenAlert(db, { severity: "warning", source: type, title: `${type}任务失败`, message: "盘前专题已降级发布昨日缓存；现有新闻接口恢复后将自动补抓。" });
      else resolveOpenAlert(db, type, `${type}任务失败`);
      if (["intraday_quotes", "forward_quotes_open", "forward_quotes_signal_ready", "forward_abcd_shared_quotes"].includes(type)) {
        for (const quoteType of ["intraday_quotes", "forward_quotes_open", "forward_quotes_signal_ready", "forward_abcd_shared_quotes"]) {
          resolveOpenAlert(db, quoteType, `${quoteType}任务失败`);
        }
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retryLimit) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, attempt * 1000)));
    }
  }
  db.prepare("UPDATE sync_jobs SET status='failed',message=?,finished_at=? WHERE job_id=?").run(`${lastError.message}（已重试${retryLimit}次）`, new Date().toISOString(), jobId);
  upsertOpenAlert(db, { severity: "warning", source: type, title: `${type}任务失败`, message: `${lastError.message}；已重试${retryLimit}次，旧版本继续生效。` });
  throw lastError;
}

function hasForwardCohort(db, accountKey, tradeDate) {
  const row = db.prepare("SELECT status,skip_reason FROM forward_cohorts WHERE account_key=? AND entry_trade_date=?").get(accountKey, tradeDate);
  return Boolean(row && !(row.status === "skipped" && /AKShare开盘价未通过/.test(String(row.skip_reason || ""))));
}

function previousFormalTradeDate(db, tradeDate) {
  const version = db.prepare("SELECT trade_date FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' AND trade_date<? ORDER BY trade_date DESC LIMIT 1").get(tradeDate);
  if (version?.trade_date) return version.trade_date;
  return db.prepare("SELECT MAX(trade_date) AS trade_date FROM bars_daily WHERE trade_date<? AND lower(source) LIKE '%bigquant%' AND lower(source) LIKE '%tushare%'").get(tradeDate)?.trade_date || null;
}

function expertPredictionFeatureReadiness(db, tradeDate) {
  const cutoff = new Date(`${tradeDate}T23:59:59+08:00`).toISOString();
  const factorDate = db.prepare("SELECT MAX(trade_date) AS date FROM factor_snapshot WHERE trade_date<=? AND datetime(updated_at)<=datetime(?)").get(tradeDate, cutoff)?.date || null;
  const chipDate = db.prepare("SELECT MAX(trade_date) AS date FROM chip_model_rank_daily WHERE trade_date<=? AND datetime(updated_at)<=datetime(?)").get(tradeDate, cutoff)?.date || null;
  return { ready: factorDate === tradeDate && chipDate === tradeDate, factorDate, chipDate, cutoff };
}

function visiblePreopenBatches(db, tradeDate) {
  const sourceTradeDate = previousFormalTradeDate(db, tradeDate);
  if (!sourceTradeDate) return { batches: { aia: null, heat: null }, details: { aia: null, heat: null }, tradeDate: null, finishedBefore: new Date().toISOString() };
  const finishedBefore = new Date().toISOString();
  const batches = {}; const details = {};
  for (const model of ["aia", "heat"]) {
    const currentSignal = db.prepare(`SELECT b.batch_id,b.model_key,b.trade_date,b.finished_at,b.model_version,b.item_count,b.trigger_type,b.source_mode,b.factor_version_id
      FROM recommendation_batches b
      JOIN dataset_versions f ON f.dataset_key='factor_snapshot' AND f.version_id=b.factor_version_id AND f.status='published'
      WHERE b.model_key=? AND b.status='published' AND b.trade_date=? AND b.finished_at<=? AND f.trade_date=?
      ORDER BY b.finished_at DESC LIMIT 1`).get(model, tradeDate, finishedBefore, sourceTradeDate);
    const priorSignal = currentSignal || db.prepare(`SELECT batch_id,model_key,trade_date,finished_at,model_version,item_count,trigger_type,source_mode,factor_version_id
      FROM recommendation_batches WHERE model_key=? AND status='published' AND trade_date=? AND finished_at<=?
      ORDER BY finished_at DESC LIMIT 1`).get(model, sourceTradeDate, finishedBefore);
    batches[model] = priorSignal?.batch_id || null;
    details[model] = priorSignal || null;
  }
  return { batches, details, tradeDate: sourceTradeDate, signalTradeDate: tradeDate, finishedBefore };
}

function preopenStageOrFallback(db, tradeDate) {
  const existing = readForwardStage(db, tradeDate, "preopen");
  if (existing?.batches?.aia || existing?.batches?.heat) return existing;
  const selected = visiblePreopenBatches(db, tradeDate);
  return saveForwardStage(db, tradeDate, "preopen", { status: selected.batches.aia && selected.batches.heat ? "fallback_ready" : "blocked", sourceTradeDate: selected.tradeDate, batches: selected.batches, details: selected.details, results: { aia: { status: "previous_trade_day_batch" }, heat: { status: "previous_trade_day_batch" } }, message: selected.tradeDate ? `盘前调度未完成，已锁定上一交易日${selected.tradeDate}实际可见批次` : "找不到上一交易日的BigQuant与Tushare正式数据，禁止开盘成交" });
}

async function prepareForwardPreopen(db, tradeDate) {
  const results = {};
  try {
    const result = await scheduledJob(db, "forward_aia_preopen", "aia_previous_close", async () => publishAlgorithmTask(db, "aia", await runAiaRecommendation(), "forward_preopen"), "forward_preopen_model");
    results.aia = { status: "published", batchId: result.batchId, tradeDate: result.tradeDate, generatedAt: result.generatedAt };
  } catch (error) { results.aia = { status: "fallback", error: error.message }; }
  try {
    const result = await scheduledJob(db, "forward_heat_preopen", "8002_same_day_sources", async () => {
      const evidence = await runNewsCollectors();
      const platformPayload = evidence?.stages?.find((stage) => stage.name === "five_platform_heat" && stage.ok)?.result;
      if (platformPayload?.platforms) saveFivePlatformSnapshot(db, platformPayload, "forward_preopen_sources");
      return publishAlgorithmTask(db, "heat", await runHeatRecommendation({ mode: "legacy", refresh: false, sourcePolicy: "fresh" }), "forward_preopen");
    }, "forward_preopen_model");
    results.heat = { status: "published", batchId: result.batchId, tradeDate: result.tradeDate, generatedAt: result.generatedAt };
  } catch (error) { results.heat = { status: "fallback", error: error.message }; }
  const selected = visiblePreopenBatches(db, tradeDate);
  const ready = Boolean(selected.batches.aia && selected.batches.heat);
  return saveForwardStage(db, tradeDate, "preopen", { status: ready ? "ready" : "blocked", sourceTradeDate: selected.tradeDate, batches: selected.batches, details: selected.details, results, message: ready ? `已锁定上一交易日${selected.tradeDate}批次，等待09:30开盘成交` : "上一交易日没有足够的AIA与热度优先推荐批次" });
}

async function ensureForwardAbcdBatch(db, tradeDate) {
  const locked = readForwardSignalSnapshot(db, "abcd", tradeDate);
  if (locked) {
    return saveForwardStage(db, tradeDate, "abcd", {
      status: locked.status === "ready" ? "signal_locked" : locked.status === "empty" ? "ready_empty" : "signal_missed",
      batchId: locked.recommendation_batch_id || null,
      batchTradeDate: tradeDate,
      signalBucket: locked.signal_bucket,
      signalReadyAt: locked.generated_at,
      sourceAsOf: locked.source_as_of,
      lastError: locked.status === "ready" ? null : parseJsonSafe(locked.payload_json)?.reason || "09:45信号不可用",
      message: locked.status === "ready" ? "ABCD 09:45信号已锁定，等待09:50执行价" : "09:45信号缺失或为空，禁止使用更晚信号补买",
    });
  }
  let observedTask = null;
  try {
    await scheduledJob(db, "forward_abcd_shared_quotes", "akshare_canonical_snapshot", () => refreshAkshareQuotes(db), "forward_dynamic_quotes");
    const result = await scheduledJob(db, "forward_abcd_0945_locked", "8010_original+akshare_0945_snapshot", async () => {
      observedTask = await runAbcdRecommendation({ refresh: true });
      const signalBucket = observedTask?.meta?.recommendation_bucket || observedTask?.meta?.latest_update || "";
      if (!isLockedAbcdSignalBucket(signalBucket, tradeDate)) throw new Error(`只接受${tradeDate} 09:45信号档，实际为${signalBucket || "缺失"}`);
      const published = publishAlgorithmTask(db, "abcd", observedTask, "forward_0945");
      lockForwardSignalSnapshot(db, {
        accountKey: "abcd", tradeDate, signalBucket, status: "ready", recommendationBatchId: published.batchId,
        sourceAsOf: observedTask?.meta?.latest_update || observedTask?.meta?.factor_time || signalBucket,
        generatedAt: published.generatedAt || new Date().toISOString(),
        payload: { rule: "8010_abcd_t1_close_v1", itemCount: published.count, modelVersion: published.modelVersion, sourcePolicy: observedTask?.source_policy || null },
      });
      return published;
    }, "forward_abcd_model");
    return saveForwardStage(db, tradeDate, "abcd", { status: "signal_locked", batchId: result.batchId, batchTradeDate: result.tradeDate, signalBucket: observedTask?.meta?.recommendation_bucket, signalReadyAt: result.generatedAt || new Date().toISOString(), sourceAsOf: observedTask?.meta?.latest_update || observedTask?.meta?.factor_time, lastError: null, message: "ABCD 09:45信号已锁定；计算完成后按09:50 AKShare分钟价补记买入" });
  } catch (error) {
    const parts = shanghaiParts(); const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    const observedBucket = observedTask?.meta?.recommendation_bucket || observedTask?.meta?.latest_update || null;
    const exactBucket = isLockedAbcdSignalBucket(observedBucket, tradeDate);
    const readyEmpty = /排名已同步.*暂无候选|本轮暂无候选|未产生新结果|结果数/.test(String(error.message || ""));
    if (minutes >= 10 * 60) {
      const status = exactBucket && readyEmpty ? "empty" : "missed";
      const snapshot = lockForwardSignalSnapshot(db, {
        accountKey: "abcd", tradeDate, signalBucket: observedBucket, status,
        sourceAsOf: observedTask?.meta?.latest_update || observedTask?.meta?.factor_time || null,
        generatedAt: new Date().toISOString(),
        payload: { reason: status === "empty" ? "09:45档严格门槛下无合格股票" : "09:45信号快照未在时限内形成，拒绝使用更晚档信号", error: error.message, observedBucket },
      });
      return saveForwardStage(db, tradeDate, "abcd", { status: status === "empty" ? "ready_empty" : "signal_missed", batchId: null, signalBucket: snapshot.signal_bucket, signalReadyAt: snapshot.generated_at, sourceAsOf: snapshot.source_as_of, lastError: error.message, message: status === "empty" ? "09:45档无合格股票，当日ABCD账户不买入" : "09:45信号未保存，已禁止更晚信号补买" });
    }
    return saveForwardStage(db, tradeDate, "abcd", { status: readyEmpty ? "calculating" : "calculating", batchId: null, signalBucket: observedBucket, signalReadyAt: null, lastError: error.message, message: exactBucket ? "09:45档仍在计算；只重试该信号档" : "等待09:45信号档，不接受更晚行情" });
  }
}

function parseJsonSafe(value, fallback = {}) { try { return JSON.parse(value || ""); } catch { return fallback; } }

async function ensureForwardAbcdExecutionQuotes(db, tradeDate, batchId) {
  const codes = db.prepare("SELECT code FROM recommendations WHERE batch_id=? AND model_key='abcd' ORDER BY rank LIMIT 5").all(batchId).map((row) => row.code);
  if (!codes.length) return { count: 0, codes: [], missing: [] };
  const existing = new Set(db.prepare(`SELECT code FROM forward_execution_quotes WHERE trade_date=? AND execution_time='09:50' AND code IN (${codes.map(() => "?").join(",")})`).all(tradeDate, ...codes).map((row) => row.code));
  const missing = codes.filter((code) => !existing.has(code));
  if (missing.length) {
    const payload = await runForwardExecutionPrices({ codes: missing, tradeDate, executionTime: "09:50" });
    saveForwardExecutionQuotes(db, { tradeDate, executionTime: "09:50", prices: payload.prices || [] });
  }
  const count = db.prepare(`SELECT COUNT(*) AS count FROM forward_execution_quotes WHERE trade_date=? AND execution_time='09:50' AND code IN (${codes.map(() => "?").join(",")})`).get(tradeDate, ...codes)?.count || 0;
  return { count, codes, missing: codes.filter((code) => !db.prepare("SELECT 1 FROM forward_execution_quotes WHERE trade_date=? AND execution_time='09:50' AND code=?").get(tradeDate, code)) };
}

async function refreshOfficialCycle(db, targetDate) {
  const cycle = {};
  const cycleStartedAt = new Date().toISOString();
  db.prepare("UPDATE schedule_definitions SET last_started_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='after_close'").run(cycleStartedAt);
  let formal = db.prepare("SELECT trade_date,row_count,source,published_at FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get();
  if (!formal || formal.trade_date < targetDate) {
    cycle.formal = await scheduledJob(db, "after_close_bars", "bigquant_official+tushare_official", () => refreshOfficialDailyBars(db, null, { endDate: targetDate }), "after_close_step");
    formal = { trade_date: cycle.formal.latestDate, row_count: cycle.formal.latestCoverage, source: "bigquant_official+tushare_official" };
  } else {
    cycle.formal = { count: formal.row_count, latestDate: formal.trade_date, latestCoverage: formal.row_count, source: formal.source, reused: true, message: `正式日线${formal.trade_date}已发布，跳过重复抓取` };
  }
  const tradeDate = cycle.formal.latestDate || formal.trade_date;
  cycle.market = cycle.formal.warehouse || { reused: true, message: "正式双源共享批次已同步写入DuckDB，无二次网络抓取" };
  cycle.marketFactors = await scheduledJob(db, "after_close_market_factors", "shared_official_duckdb", () => syncMarketFactorSnapshot(db), "after_close_step");
  cycle.history = await scheduledJob(db, "after_close_research_history", "shared_official_duckdb", () => syncRecommendationDailyHistory(db), "after_close_step");
  cycle.factors = await scheduledJob(db, "after_close_factors", "formal_bigquant_tushare_factor_engine", () => rebuildDailyFactors(db, tradeDate), "after_close_step");
  cycle.forward = await scheduledJob(db, "forward_t1_close", "bigquant+tushare_official_close", () => closeDueForwardCohorts(db, { tradeDate }), "after_close_step");
  activateOfficialMarketData(db, { tradeDate, coverage: { received: cycle.formal.latestCoverage, ratio: 1 }, providers: cycle.formal.providers || {}, cycle: { factors: cycle.factors.count, marketFactors: cycle.marketFactors.count, history: cycle.history.count } });
  runWatchdog(db);
  return { count: cycle.factors.count, tradeDate, cycle, message: `${tradeDate}正式数据已由BigQuant与Tushare确认并替换盘中临时层` };
}

async function schedulerTick(db) {
  ensureForwardTest(db);
  ensurePreopenSchedule(db);
  ensureCommunityTopicSchedule(db);
  ensureSectorStockRankSchedule(db);
  ensureExpertTrackerSchedules(db);
  ensureSimilarityCacheSchedule(db);
  ensureScheduledScreenerSchedule(db);
  ensureBigquantHeatSchedule(db);
  if (!similarityCacheRefresh && taskDue(db, "similarity_cache_incremental_refresh", 900)) {
    // Claim the cadence before launching. This promise is the in-process
    // max_instances=1 guard; the copied Python cache lease covers restarts.
    markTask(db, "similarity_cache_incremental_refresh");
    similarityCacheRefresh = scheduledJob(
      db,
      "similarity_cache_incremental_refresh",
      "original_market_history_provider+local_similarity_cache",
      () => refreshExactKlineSimilarityCache({ batchSize: 120 }),
      "similarity_cache_incremental_refresh",
    ).catch(() => undefined).finally(() => { similarityCacheRefresh = null; });
  }
  const parts = shanghaiParts();
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (taskDue(db, "watchdog", 300)) {
    try { runWatchdog(db); try { syncExpertTrackerHeartbeat(db); } catch {} } finally { markTask(db, "watchdog"); }
  }
  const dateKey = shanghaiDate();
  const previousHeatDate = previousTradingDate(dateKey, false);
  // A previous-day hot list is provisional until all five platforms return a
  // dated top-10. Recheck every 15 minutes and keep the last complete snapshot
  // visible while recovery is in progress.
  if (!['Sat', 'Sun'].includes(parts.weekday) && minutes >= 8 * 60 && minutes <= 14 * 60 + 45
    && fivePlatformSnapshotNeedsRecovery(db, previousHeatDate)
    && taskDue(db, `five_platform_recovery_${previousHeatDate}`, 900)) {
    try {
      syncLatestFivePlatformCache(db);
      if (fivePlatformSnapshotNeedsRecovery(db, previousHeatDate)) {
        const evidence = await scheduledJob(db, "five_platform_recovery", "8002_five_platform_previous_day", () => runNewsCollectors(), "five_platform_recovery");
        const platformPayload = evidence?.stages?.find((stage) => stage.name === "five_platform_heat" && stage.ok)?.result;
        if (platformPayload?.platforms) saveFivePlatformSnapshot(db, platformPayload, "five_platform_recovery");
      }
      if (!fivePlatformSnapshotNeedsRecovery(db, previousHeatDate)) resolveOpenAlert(db, "five_platform_recovery", "前一日五平台热榜补拉失败");
    } catch (error) {
      upsertOpenAlert(db, { severity: "warning", source: "five_platform_recovery", title: "前一日五平台热榜不完整", message: `${schedulerErrorMessage(error)}；将在15分钟后继续补拉，完整快照前不宣称五平台齐全。` });
    } finally { markTask(db, `five_platform_recovery_${previousHeatDate}`); }
  }
  const formalForHeat = db.prepare("SELECT trade_date FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get()?.trade_date || null;
  const heatCompleteKey = formalForHeat ? `bigquant_daily_heat_${formalForHeat}` : null;
  const heatAttemptKey = formalForHeat ? `bigquant_daily_heat_attempt_${formalForHeat}` : null;
  const publishedHeat = formalForHeat
    ? db.prepare("SELECT MAX(bigquant_heat_date) AS heat_date, COUNT(*) AS rows FROM factor_snapshot WHERE trade_date=? AND bigquant_heat_rank IS NOT NULL AND bigquant_heat_date=?").get(formalForHeat, formalForHeat)
    : null;
  const publishedHeatDate = Number(publishedHeat?.rows || 0) >= 4000 ? publishedHeat.heat_date : null;
  // A restart must not consume BigQuant quota again when the same-day heat
  // snapshot has already passed the publication gate.
  if (heatCompleteKey && publishedHeatDate === formalForHeat && taskDue(db, heatCompleteKey, 86_400)) markTask(db, heatCompleteKey);
  if (formalForHeat && formalForHeat < dateKey && minutes >= 5 && taskDue(db, heatCompleteKey, 86_400) && taskDue(db, heatAttemptKey, 900)) {
    try {
      await scheduledJob(db, "bigquant_daily_heat", "bigquant_cn_stock_hot_rank", () => refreshBigquantHeatRank(db, formalForHeat), "bigquant_daily_heat");
      await scheduledJob(db, "bigquant_heat_factor_sync", "shared_duckdb+sqlite_factor_layer", () => syncMarketFactorSnapshot(db), "bigquant_daily_heat");
      await scheduledJob(db, "bigquant_heat_factor_republish", "formal_factor_rebuild", () => rebuildDailyFactors(db, formalForHeat), "bigquant_daily_heat");
      markTask(db, heatCompleteKey);
      resolveOpenAlert(db, "bigquant_daily_heat", "BigQuant热度更新失败");
    } catch (error) {
      upsertOpenAlert(db, { severity: "warning", source: "bigquant_daily_heat", title: "BigQuant热度更新失败", message: `${schedulerErrorMessage(error)}；旧热度只展示日期，不允许每日候选规则冒充当日数据。` });
    } finally { markTask(db, heatAttemptKey); }
  }
  try {
    const generated = runDueScheduledScreeners(db, { isTradingDate: isAshareTradingDate });
    if (generated.length) {
      const allPublished = generated.every((item) => item.status === "published");
      db.prepare(`UPDATE schedule_definitions SET last_started_at=CURRENT_TIMESTAMP,
        last_success_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_success_at END,updated_at=CURRENT_TIMESTAMP
        WHERE schedule_key='daily_custom_screener'`).run(Number(allPublished));
      if (allPublished) resolveOpenAlert(db, "daily_custom_screener", "自定义每日候选生成失败");
    }
  } catch (error) {
    upsertOpenAlert(db, { severity: "warning", source: "daily_custom_screener", title: "自定义每日候选生成失败", message: `${schedulerErrorMessage(error)}；上一已发布候选批次保持不变。` });
  }
  let forwardRan = false;
  if (!['Sat', 'Sun'].includes(parts.weekday) && minutes >= 7 * 60 + 50 && minutes <= 9 * 60 + 14 && taskDue(db, `preopen_sources_attempt_${dateKey}`, 900)) {
    try {
      const evidence = await scheduledJob(db, "preopen_same_day_sources", "existing_8002_news+taoguba+five_platform", () => runNewsCollectors(), "preopen_same_day_sources");
      const platformPayload = evidence?.stages?.find((stage) => stage.name === "five_platform_heat" && stage.ok)?.result;
      if (platformPayload?.platforms) saveFivePlatformSnapshot(db, platformPayload, "preopen_same_day_sources");
    } catch {} finally { markTask(db, `preopen_sources_attempt_${dateKey}`); }
  }
  const preopenRow = db.prepare("SELECT status,payload_json FROM preopen_daily_summaries WHERE summary_date=?").get(dateKey);
  const preopenPayload = parseJsonSafe(preopenRow?.payload_json, {});
  const displayedNews = [...(preopenPayload?.news_part?.cn_news || []), ...(preopenPayload?.news_part?.us_news || [])];
  const preopenHasToday = displayedNews.some((item) => String(item?.publish_time || "").slice(0, 10) === dateKey);
  const preopenNeedsRecovery = preopenRow?.status !== "success" || !preopenHasToday;
  if (!["Sat", "Sun"].includes(parts.weekday) && minutes >= 8 * 60 + 20 && minutes <= 10 * 60 + 30 && preopenNeedsRecovery && taskDue(db, `preopen_${dateKey}`, 900)) {
    try {
      const task = await scheduledJob(db, "stock_market_preopen_daily_panel", "minishare_existing_api+local_taoguba+deepseek-chat", () => runPreopenDailyPanel({ targetDate: dateKey }), "stock_market_preopen_daily_panel");
      savePreopenSummary(db, task, dateKey);
    } catch (error) {
      savePreopenSummary(db, { status: "partial", payload: null, source_counts: {}, errors: { task: error.message } }, dateKey);
    } finally { markTask(db, `preopen_${dateKey}`); }
  }
  const communityRow = db.prepare("SELECT status FROM community_hot_topic_summaries WHERE summary_date=?").get(dateKey);
  if (!["Sat", "Sun"].includes(parts.weekday) && minutes >= 8 * 60 + 20 && minutes <= 10 * 60 + 30 && communityRow?.status !== "success" && taskDue(db, `community_topics_${dateKey}`, 900)) {
    try {
      const task = await scheduledJob(db, "community_hot_topics_daily", "taoguba+kaipanla+xueqiu+deepseek-chat", () => runCommunityHotTopics({ targetDate: dateKey }), "community_hot_topics_daily");
      saveCommunityTopics(db, task, dateKey);
    } catch (error) {
      saveCommunityTopics(db, { status: "partial", payload: null, source_counts: {}, errors: { task: error.message } }, dateKey);
    } finally { markTask(db, `community_topics_${dateKey}`); }
  }
  const forwardTradingDay = !["Sat", "Sun"].includes(parts.weekday) && isAshareTradingDate(dateKey);
  if (forwardTradingDay && minutes >= 10 * 60 + 5) {
    const lockedSignal = readForwardSignalSnapshot(db, "abcd", dateKey);
    if (lockedSignal?.status === "ready" || lockedSignal?.status === "empty") resolveOpenAlert(db, "forward_abcd_0945", "ABCD 09:45锁定批次缺失");
    else upsertOpenAlert(db, { severity: "critical", source: "forward_abcd_0945", title: "ABCD 09:45锁定批次缺失", message: lockedSignal ? `当天信号状态为${lockedSignal.status}；推荐页不会用旧批次或更晚信号冒充` : "10:05后仍未形成当天09:45锁定信号；调度器将继续重试并保留告警" });
  }
  const preopenCompleteKey = `forward_preopen_complete_${dateKey}`;
  const preopenAttemptKey = `forward_preopen_attempt_${dateKey}`;
  const preopenComplete = db.prepare("SELECT value FROM metadata WHERE key=?").get(`scheduler_${preopenCompleteKey}`)?.value;
  if (forwardTradingDay && minutes >= 8 * 60 + 30 && minutes <= 9 * 60 + 24 && !preopenComplete && taskDue(db, preopenAttemptKey, 300)) {
    const settings = ensureForwardTest(db);
    if (Number(settings.enabled) && dateKey >= settings.start_date) {
      db.prepare("UPDATE schedule_definitions SET last_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='forward_preopen'").run();
      try {
        const stage = await prepareForwardPreopen(db, dateKey);
        if (stage.status === "ready" && stage.batches?.aia && stage.batches?.heat) {
          markTask(db, preopenCompleteKey);
          db.prepare("UPDATE schedule_definitions SET last_success_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='forward_preopen'").run();
        }
      } finally { markTask(db, preopenAttemptKey); }
    }
  }
  const openPending = ["aia", "heat"].filter((key) => !hasForwardCohort(db, key, dateKey));
  if (forwardTradingDay && minutes >= 9 * 60 + 30 && minutes <= 14 * 60 + 59 && openPending.length && taskDue(db, `forward_open_attempt_${dateKey}`, 60)) {
    const settings = ensureForwardTest(db); forwardRan = true;
    if (Number(settings.enabled) && dateKey >= settings.start_date) {
      const startedAt = new Date().toISOString();
      db.prepare("UPDATE schedule_definitions SET last_started_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='forward_open_0930'").run(startedAt);
      try {
        const preopen = preopenStageOrFallback(db, dateKey);
        await scheduledJob(db, "forward_quotes_open", "akshare_realtime_open", () => refreshAkshareQuotes(db), "forward_open_quotes");
        try {
          await scheduledJob(db, "intraday_abcd_warmup", "8010_5m_collector+akshare", () => runAbcdWarmup(), "intraday_quotes");
        } catch {}
        const opened = openForwardCohorts(db, { tradeDate: dateKey, batches: preopen.batches, accountKeys: openPending, executionMode: "open", openedAt: new Date().toISOString(), finalizeMissing: false });
        const terminal = ["aia", "heat"].every((key) => hasForwardCohort(db, key, dateKey));
        const successful = ["aia", "heat"].every((key) => db.prepare("SELECT status FROM forward_cohorts WHERE account_key=? AND entry_trade_date=?").get(key, dateKey)?.status === "open");
        saveForwardStage(db, dateKey, "open", { status: terminal ? successful ? "completed" : "completed_with_skips" : "waiting", batches: preopen.batches, accounts: opened.accounts, openedAt: new Date().toISOString(), message: terminal ? successful ? "AIA与热度优先已按开盘价成交" : "开盘阶段已结束，部分账户未成交" : "等待合格的AKShare开盘价" });
        if (successful) db.prepare("UPDATE schedule_definitions SET last_success_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='forward_open_0930'").run();
      } catch (error) {
        saveForwardStage(db, dateKey, "open", { status: "waiting", lastError: error.message, message: "开盘行情暂不可用，推荐已锁定；将继续重试并在取得开盘价后成交" });
      } finally { markTask(db, `forward_open_attempt_${dateKey}`); }
    }
  }
  const defaultAbcdTaskKey = `intraday_abcd_default_${dateKey}`;
  const dynamicPending = ["abcd", "consensus"].filter((key) => !hasForwardCohort(db, key, dateKey));
  if (forwardTradingDay && isTradingSession(parts) && minutes >= 9 * 60 + 45 && minutes <= 14 * 60 + 59 && dynamicPending.length && taskDue(db, `forward_abcd_attempt_${dateKey}`, 300)) {
    const settings = ensureForwardTest(db); forwardRan = true;
    if (Number(settings.enabled) && dateKey >= settings.start_date) {
      const startedAt = new Date().toISOString();
      db.prepare("UPDATE schedule_definitions SET last_started_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='forward_0945'").run(startedAt);
      try {
        const abcd = await ensureForwardAbcdBatch(db, dateKey);
        if (abcd.batchId || abcd.status === "ready_empty") markTask(db, defaultAbcdTaskKey);
        const preopen = preopenStageOrFallback(db, dateKey);
        const batches = { abcd: abcd.batchId || null, aia: preopen.batches?.aia || null, heat: preopen.batches?.heat || null };
        const opened = { accounts: [] };
        const after = shanghaiParts(); const afterMinutes = Number(after.hour) * 60 + Number(after.minute);
        if (dynamicPending.includes("abcd")) {
          if (abcd.batchId) {
            await scheduledJob(db, "forward_abcd_0950_prices", "akshare_locked_minute_close", () => ensureForwardAbcdExecutionQuotes(db, dateKey, abcd.batchId), "forward_dynamic_quotes");
            const result = openForwardCohorts(db, { tradeDate: dateKey, batches, accountKeys: ["abcd"], executionMode: "abcd_t1", signalReadyAt: abcd.signalReadyAt, openedAt: new Date().toISOString(), finalizeMissing: afterMinutes >= 14 * 60 + 55 });
            opened.accounts.push(...result.accounts);
          } else if (["ready_empty", "signal_missed"].includes(abcd.status) || afterMinutes >= 14 * 60 + 55) {
            const result = openForwardCohorts(db, { tradeDate: dateKey, batches, accountKeys: ["abcd"], executionMode: "abcd_t1", openedAt: new Date().toISOString(), finalizeMissing: true });
            opened.accounts.push(...result.accounts);
          } else opened.accounts.push({ accountKey: "abcd", status: "waiting", reason: "09:45档仍在计算" });
        }
        if (dynamicPending.includes("consensus")) {
          if (abcd.batchId && batches.aia && batches.heat) {
            await scheduledJob(db, "forward_quotes_signal_ready", "akshare_realtime_after_locked_signal", () => refreshAkshareQuotes(db), "forward_dynamic_quotes");
            const result = openForwardCohorts(db, { tradeDate: dateKey, batches, accountKeys: ["consensus"], executionMode: "dynamic", signalReadyAt: abcd.signalReadyAt, openedAt: new Date().toISOString(), finalizeMissing: afterMinutes >= 14 * 60 + 55 });
            opened.accounts.push(...result.accounts);
          } else if (afterMinutes >= 14 * 60 + 55) {
            const result = openForwardCohorts(db, { tradeDate: dateKey, batches, accountKeys: ["consensus"], executionMode: "dynamic", openedAt: new Date().toISOString(), finalizeMissing: true });
            opened.accounts.push(...result.accounts);
          } else opened.accounts.push({ accountKey: "consensus", status: "waiting", reason: "等待09:45 ABCD锁定批次与两个盘前批次" });
        }
        const terminal = ["abcd", "consensus"].every((key) => hasForwardCohort(db, key, dateKey));
        const abcdCompleted = hasForwardCohort(db, "abcd", dateKey);
        const successful = ["abcd", "consensus"].every((key) => db.prepare("SELECT status FROM forward_cohorts WHERE account_key=? AND entry_trade_date=?").get(key, dateKey)?.status === "open");
        const readyEmpty = abcd.status === "ready_empty";
        const stage = saveForwardStage(db, dateKey, "abcd", { ...abcd, status: terminal ? successful ? "completed" : "completed_with_skips" : abcdCompleted ? "abcd_completed_consensus_waiting" : abcd.batchId ? "signal_locked_waiting_0950" : readyEmpty ? "ready_empty" : abcd.status === "signal_missed" ? "signal_missed" : "calculating", batches, accounts: opened.accounts, message: terminal ? successful ? "ABCD与共识账户成交完成" : "当日账户已按规则形成成交或跳过记录" : abcdCompleted ? "ABCD账户已按09:45信号与09:50价格处理；共识账户等待三批次" : abcd.batchId ? "ABCD 09:45信号已锁定，等待AKShare 09:50分钟价" : readyEmpty ? "09:45档无合格股票，当日不买入" : abcd.status === "signal_missed" ? "09:45信号缺失，当日禁止补买" : "ABCD 09:45档仍在计算" });
        if (successful) db.prepare("UPDATE schedule_definitions SET last_success_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='forward_0945'").run();
        void stage;
      } catch (error) {
        const previous = readForwardStage(db, dateKey, "abcd") || {};
        saveForwardStage(db, dateKey, "abcd", { ...previous, status: previous.batchId ? "signal_locked_waiting_0950" : previous.status || "calculating", lastError: error.message, message: previous.batchId ? "09:45信号保持锁定；AKShare 09:50成交价暂未取到，将继续补取" : "ABCD 09:45档暂未就绪，将继续重试但不接受更晚信号" });
      } finally { markTask(db, `forward_abcd_attempt_${dateKey}`); }
    }
  }
  const intradayCadenceSeconds = minutes < 9 * 60 + 45 ? 60 : 300;
  if (isTradingSession(parts) && isAshareTradingDate(dateKey) && !forwardRan && taskDue(db, "intraday", intradayCadenceSeconds)) {
    try {
      await scheduledJob(db, "intraday_quotes", "akshare_realtime", () => refreshAkshareQuotes(db), "intraday_quotes");
      if (minutes < 9 * 60 + 45) {
        await scheduledJob(db, "intraday_abcd_warmup", "8010_5m_collector+akshare", () => runAbcdWarmup(), "intraday_quotes");
      } else if (taskDue(db, defaultAbcdTaskKey, 86_400)) {
        await scheduledJob(db, "intraday_abcd", "8010_original+akshare", async () => {
          const task = await runAbcdRecommendation({ refresh: true });
          return publishAlgorithmTask(db, "abcd", task, "schedule");
        }, "intraday_quotes");
        markTask(db, defaultAbcdTaskKey);
      }
    } finally { markTask(db, "intraday"); }
  }
  const m30Window = completedM30Window(parts);
  const m30TaskKey = m30Window ? `intraday_m30_${dateKey}_${m30Window}` : null;
  if (m30Window && isAshareTradingDate(dateKey) && taskDue(db, m30TaskKey, 86_400)) {
    try {
      await scheduledJob(db, "intraday_aia_authoritative", "aia_authoritative_read_only", async () => {
        const task = await runAiaRecommendation();
        const published = publishAlgorithmTask(db, "aia", task, "schedule");
        return { ...published, message: `权威AIA批次只读导入${published.count}只；未在本机重算或重排` };
      }, "recommendation_aia");
      markTask(db, m30TaskKey);
    } catch {}
  }
  const officialTarget = officialTargetDate(dateKey, parts, minutes);
  const officialCompleteKey = `official_cycle_complete_${officialTarget}`;
  const officialAttemptKey = `official_attempt_${officialTarget}`;
  const officialAttemptsKey = `official_attempt_count_${officialTarget}`;
  const currentMarketState = marketDataState(db);
  const officialAttempts = metadataNumber(db, officialAttemptsKey);
  const publishedFormal = db.prepare("SELECT trade_date,published_at FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get();
  const formalReadyForTarget = Boolean(publishedFormal?.trade_date && publishedFormal.trade_date >= officialTarget);
  const lastOfficialAttemptAt = db.prepare("SELECT value FROM metadata WHERE key=?").get(`scheduler_${officialAttemptKey}`)?.value || null;
  const formalRecoveredAfterFailure = formalReadyForTarget && (!lastOfficialAttemptAt || Date.parse(publishedFormal.published_at) > Date.parse(lastOfficialAttemptAt));
  const recentQuota = quotaHoldFromRecentJobs(db);
  const storedQuotaHold = db.prepare("SELECT value FROM metadata WHERE key='scheduler_provider_quota_hold'").get()?.value || null;
  const inheritedQuotaHold = currentMarketState.official?.nextRetryAt || storedQuotaHold || recentQuota?.nextRetryAt || null;
  const quotaWaiting = inheritedQuotaHold && Date.now() < Date.parse(inheritedQuotaHold);
  const quotaResetDue = inheritedQuotaHold && Date.now() >= Date.parse(inheritedQuotaHold);
  const recoveryOfficialTarget = db.prepare("SELECT value FROM metadata WHERE key='recovery_official_target'").get()?.value || null;
  if (quotaWaiting && !storedQuotaHold) markTask(db, "provider_quota_hold", inheritedQuotaHold);
  if (quotaWaiting && currentMarketState.official?.status !== "ready" && (!currentMarketState.official?.nextRetryAt || String(currentMarketState.official?.error || "").length > 360)) markOfficialMarketDataPending(db, { targetDate: officialTarget, attempt: officialAttempts, error: recentQuota?.error || schedulerErrorMessage("BigQuant周配额已达上限"), nextRetryAt: inheritedQuotaHold });
  const officialWindowOpen = minutes >= 16 * 60 + 30 || quotaResetDue || Boolean(recoveryOfficialTarget);
  const retrySeconds = currentMarketState.official?.error && quotaExceeded(currentMarketState.official.error) ? 21_600 : 1_800;
  const officialAttemptDue = formalRecoveredAfterFailure || taskDue(db, officialAttemptKey, retrySeconds);
  if (officialWindowOpen && !quotaWaiting && !db.prepare("SELECT value FROM metadata WHERE key=?").get(`scheduler_${officialCompleteKey}`)?.value && (formalReadyForTarget || officialAttempts < 12) && officialAttemptDue) {
    markOfficialMarketDataPending(db, { targetDate: officialTarget, attempt: officialAttempts + 1 });
    try {
      const result = await refreshOfficialCycle(db, officialTarget);
      markTask(db, officialCompleteKey);
      setMetadataNumber(db, officialAttemptsKey, 0);
      db.prepare("DELETE FROM metadata WHERE key='scheduler_provider_quota_hold'").run();
      db.prepare("DELETE FROM metadata WHERE key='recovery_official_target'").run();
      markTask(db, officialAttemptKey);
      db.prepare("UPDATE schedule_definitions SET last_success_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='after_close'").run();
      void result;
    } catch (error) {
      const attempt = officialAttempts + 1;
      setMetadataNumber(db, officialAttemptsKey, attempt);
      const nextRetryAt = quotaExceeded(error) ? nextSundayMidnight() : new Date(Date.now() + 30 * 60_000).toISOString();
      if (quotaExceeded(error)) markTask(db, "provider_quota_hold", nextRetryAt);
      markOfficialMarketDataPending(db, { targetDate: officialTarget, attempt, error: schedulerErrorMessage(error), nextRetryAt });
      markTask(db, officialAttemptKey);
    }
  }
  if (minutes >= 15 * 60 + 35 && isAshareTradingDate(dateKey) && latestMarketTradeDate(db) === dateKey && taskDue(db, `sector_stock_rank_${dateKey}`, 86_400)) {
    try {
      await scheduledJob(db, "stock_sector_stock_rank_panel", "official_daily+8002_knowledge_graph+redis", () => refreshSectorStockRank(db), "stock_sector_stock_rank_panel");
      markTask(db, `sector_stock_rank_${dateKey}`);
    } catch {}
  }
  if (minutes >= 18 * 60 + 40 && isAshareTradingDate(dateKey) && taskDue(db, `expert_tracker_primary_${dateKey}`, 86_400)) {
    try {
      await scheduledJob(db, "expert_tracker_after_close", "public_competitions+taoguba+xueqiu", async () => {
        const result = await runExpertTrackerUpdate({ targetDate: dateKey });
        syncExpertTrackerHeartbeat(db);
        return result;
      }, "expert_tracker_after_close");
    } catch {} finally { markTask(db, `expert_tracker_primary_${dateKey}`); }
  }
  if (minutes >= 19 * 60 + 30 && taskDue(db, `night_news_${dateKey}`, 86_400)) {
    try {
      const evidence = await scheduledJob(db, "night_evidence", "8002_original_collectors", () => runNewsCollectors(), "night_evidence");
      const platformPayload = evidence?.stages?.find((stage) => stage.name === "five_platform_heat" && stage.ok)?.result;
      if (platformPayload?.platforms) saveFivePlatformSnapshot(db, platformPayload, "night_evidence");
      else try { syncLatestFivePlatformCache(db); } catch {}
      const heatTask = await runHeatRecommendation({ mode: "legacy", refresh: false });
      publishAlgorithmTask(db, "heat", heatTask, "schedule");
    } finally { markTask(db, `night_news_${dateKey}`); }
  }
  if (minutes >= 20 * 60 + 30 && isAshareTradingDate(dateKey) && taskDue(db, `expert_tracker_recovery_${dateKey}`, 86_400)) {
    try {
      await scheduledJob(db, "expert_tracker_recovery", "public_sources_recovery", async () => {
        const result = await runExpertTrackerUpdate({ recovery: true, targetDate: dateKey });
        syncExpertTrackerHeartbeat(db);
        return result;
      }, "expert_tracker_recovery");
    } catch {} finally { markTask(db, `expert_tracker_recovery_${dateKey}`); }
  }
  const officialState = marketDataState(db);
  const officialTradeDate = officialState.official?.status === "ready" ? officialState.official.tradeDate : null;
  const catchUpModels = officialTradeDate && officialTradeDate < dateKey;
  const nightAttemptKey = officialTradeDate ? `night_models_attempt_${officialTradeDate}` : "night_models_attempt_missing";
  if (officialTradeDate && !quotaWaiting && (minutes >= 20 * 60 + 30 || catchUpModels) && taskDue(db, nightAttemptKey, 7_200) && taskDue(db, `night_models_${officialTradeDate}`, 86_400)) {
    db.prepare("UPDATE schedule_definitions SET last_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='night_models'").run();
    try {
      await scheduledJob(db, "night_market_chips", "official_ohlcv+independent_close_recurrence", () => runNightlyMarketSync({ end: officialTradeDate, includeChips: true, chipsOnly: true }), "night_models_step");
      const chipSync = await scheduledJob(db, "night_chip_axes", "independent_recurrence_quality_gate", () => syncChipAxes(db), "night_models_step");
      await scheduledJob(db, "night_chip_retrain", "aster_24d_managed_chip_retrainer", () => runChipRetrain(), "night_models_step");
      await scheduledJob(db, "night_chip_models", "local_model_assets", async () => scoreChipModels(db, chipSync.tradeDate), "night_models_step");
      await scheduledJob(db, "night_factor_republish", "bigquant+tushare+dual_chip", async () => rebuildDailyFactors(db, officialTradeDate), "night_models_step");
      const abcd = await scheduledJob(db, "night_abcd", "8010_original_exact+official_close+full_market_factor_writeback", async () => publishAlgorithmTask(
        db,
        "abcd",
        await runAbcdRecommendation({ refresh: false }),
        "schedule",
        { requireFactorWriteback: true, allowKeptPrevious: true },
      ), "night_models_step");
      const aia = await scheduledJob(db, "night_aia", "aia_authoritative_read_only", async () => publishAlgorithmTask(db, "aia", await runAiaRecommendation(), "schedule"), "night_models_step");
      const heat = await scheduledJob(db, "night_heat", "8002_legacy_exact", async () => publishAlgorithmTask(db, "heat", await runHeatRecommendation({ mode: "legacy", refresh: false }), "schedule"), "night_models_step");
      markTask(db, `night_models_${officialTradeDate}`);
      db.prepare("UPDATE schedule_definitions SET last_success_at=CURRENT_TIMESTAMP WHERE schedule_key='night_models'").run();
      void ({ abcd, aia, heat });
    } catch (error) {
      if (quotaExceeded(error)) markTask(db, "provider_quota_hold", nextSundayMidnight());
    } finally { markTask(db, nightAttemptKey); }
  }
  const forecastCompleteKey = officialTradeDate ? `expert_next_holding_prediction_${officialTradeDate}` : "expert_next_holding_prediction_missing";
  const forecastAttemptKey = officialTradeDate ? `expert_next_holding_prediction_attempt_${officialTradeDate}` : "expert_next_holding_prediction_attempt_missing";
  if (officialTradeDate && (minutes >= 21 * 60 + 15 || catchUpModels) && taskDue(db, forecastAttemptKey, 1_800) && taskDue(db, forecastCompleteKey, 86_400)) {
    const readiness = expertPredictionFeatureReadiness(db, officialTradeDate);
    if (!readiness.ready) {
      resolveOpenAlert(db, "expert_next_holding_prediction", "expert_next_holding_prediction任务失败");
      db.prepare(`INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json)
        VALUES('expert_next_holding_prediction','waiting',?,?,NULL,0,?)
        ON CONFLICT(service_key) DO UPDATE SET status='waiting',pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=NULL,details_json=excluded.details_json`)
        .run(process.pid, new Date().toISOString(), JSON.stringify({ officialTradeDate, factorDate: readiness.factorDate, chipDate: readiness.chipDate, pointInTimeCutoff: readiness.cutoff, message: "等待可验证的同日量价与筹码截面；不回填未来可见时间" }));
      markTask(db, forecastAttemptKey);
    } else try {
      const result = await scheduledJob(db, "expert_next_holding_prediction", "expert_history+aster_point_in_time_features", () => runExpertShadowExperiment({ asOf: officialTradeDate, predictOnly: true, requireCurrentFeatures: true }), "expert_next_holding_prediction");
      markTask(db, forecastCompleteKey);
      db.prepare(`INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json)
        VALUES('expert_next_holding_prediction','healthy',?,?,NULL,0,?)
        ON CONFLICT(service_key) DO UPDATE SET status='healthy',pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=NULL,details_json=excluded.details_json`)
        .run(process.pid, new Date().toISOString(), JSON.stringify({ officialTradeDate, count: result.count, immutable: true }));
    } catch (error) {
      db.prepare(`INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json)
        VALUES('expert_next_holding_prediction','degraded',?,?,?,0,?)
        ON CONFLICT(service_key) DO UPDATE SET status='degraded',pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=excluded.last_error,details_json=excluded.details_json`)
        .run(process.pid, new Date().toISOString(), schedulerErrorMessage(error), JSON.stringify({ officialTradeDate, nextRetryMinutes: 30, previousFrozenBatchPreserved: true }));
    } finally { markTask(db, forecastAttemptKey); }
  }
  const recoveryBackupDue = db.prepare("SELECT value FROM metadata WHERE key='recovery_backup_due'").get()?.value === "true";
  if ((minutes >= 23 * 60 + 50 || recoveryBackupDue) && taskDue(db, `backup_${dateKey}`, 86_400)) {
    try {
      await scheduledJob(db, "backup_integrity", "sqlite", async () => { const result = await backupDatabase(db); return { count: 1, message: `备份已验证 ${result.backupId}` }; }, "backup_integrity");
      db.prepare("DELETE FROM metadata WHERE key='recovery_backup_due'").run();
    } finally { markTask(db, `backup_${dateKey}`); }
  }
}

export function startScheduler(db) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await schedulerTick(db);
      db.prepare("INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json) VALUES('scheduler','healthy',?,?,NULL,0,'{}') ON CONFLICT(service_key) DO UPDATE SET status='healthy',pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=NULL").run(process.pid, new Date().toISOString());
    } catch (error) {
      db.prepare("INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json) VALUES('scheduler','degraded',?,?,?,0,'{}') ON CONFLICT(service_key) DO UPDATE SET status='degraded',pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=excluded.last_error").run(process.pid, new Date().toISOString(), error.message);
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
}
