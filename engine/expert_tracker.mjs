import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectDir, shanghaiDate } from "./core.mjs";
import { upsertOpenAlert } from "./maintenance.mjs";

const trackerRoot = join(projectDir, "web", "expert-tracker");
const trackerDataRoot = join(trackerRoot, "data");
const updateStatusPath = join(trackerDataRoot, "update_status.json");
const nextHoldingDbPath = join(projectDir, "data", "experiments", "expert_next_holding_shadow.db");

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clean(value, limit = 2_000) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:cookie|authorization|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, limit);
}

function number(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function round(value, digits = 4) { return Number(number(value).toFixed(digits)); }

export function ensureExpertTrackerSchedules(db) {
  const insert = db.prepare(`INSERT INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES(?,?,?,?,1,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(schedule_key) DO UPDATE SET display_name=excluded.display_name,session_type=excluded.session_type,cron_text=excluded.cron_text,max_age_seconds=excluded.max_age_seconds,retry_limit=excluded.retry_limit,quality_gate=excluded.quality_gate,updated_at=CURRENT_TIMESTAMP`);
  insert.run("expert_tracker_after_close", "高手持仓共识收盘更新", "after_close", "A股工作日 18:40", 172800, 1, "全部已建档顽主杯选手逐人刷新；重点高手至少一个声明来源达到当日；逐来源新鲜度与建档覆盖率写入质量状态");
  insert.run("expert_tracker_recovery", "高手持仓共识失败补救", "night", "A股工作日 20:30", 172800, 1, "当日未健康发布则逐人重新拉取完整赛季历史并重试最近5个交易日缺档；未披露不视为空仓或卖出");
  insert.run("expert_next_holding_prediction", "高手次日持仓持续预测", "night", "A股交易日 21:15起独立重试", 172800, 3, "必须使用当日正式行情与筹码截面；冻结后不可改写；仅目标日前冻结批次计入真实准确率");
  return db.prepare("SELECT * FROM schedule_definitions WHERE schedule_key IN ('expert_tracker_after_close','expert_tracker_recovery','expert_next_holding_prediction') ORDER BY schedule_key").all();
}

export function expertTrackerStatus() {
  const required = ["expert_profiles.json", "public_sources.json", "tgb_people.json", "update_status.json"];
  const files = required.map((name) => {
    const path = join(trackerDataRoot, name);
    return { name, exists: existsSync(path), bytes: existsSync(path) ? statSync(path).size : 0 };
  });
  if (files.some((item) => !item.exists || item.bytes <= 0)) throw new Error("高手持仓共识数据文件不完整");
  const status = parseJson(updateStatusPath);
  const profiles = parseJson(join(trackerDataRoot, "expert_profiles.json"));
  const publicSources = parseJson(join(trackerDataRoot, "public_sources.json"));
  const profileRows = profiles.profiles || [];
  const xueqiuRows = publicSources.xueqiu?.portfolios || [];
  const profileWithTrades = profileRows.filter((item) => (item.transactions || []).length > 0).length;
  const xueqiuTraceablePortfolios = xueqiuRows.filter((item) => [...(item.localRebalances || []), ...(item.recentRebalances || [])].some((record) => (record.trades || []).length > 0)).length;
  const stages = Object.fromEntries(Object.entries(status.stages || {}).map(([key, value]) => [key, {
    status: value?.status || "unknown", attempts: Number(value?.attempts || 0), lastSuccessDate: value?.lastSuccessDate || null,
  }]));
  return {
    module: "expert-tracker", businessDate: status.targetDate || profiles.date || publicSources.date || null,
    generatedAt: status.generatedAt || null, overall: status.overall || "unknown", deployed: status.deployed === true,
    healthy: status.overall === "healthy" && status.deployed === true, recovery: clean(status.recovery, 500), stages,
    quality: status.quality || {},
    counts: { profiles: profileRows.length, profileWithTrades, xueqiuPortfolios: xueqiuRows.length, xueqiuTraceablePortfolios, visibleExperts: profileWithTrades + xueqiuTraceablePortfolios },
    files,
  };
}

export function expertNextHoldingForecast() {
  if (!existsSync(nextHoldingDbPath) || statSync(nextHoldingDbPath).size <= 0) return {
    available: false, status: "waiting", message: "持续预测账本尚未建立", experts: [], participants: [],
  };
  const db = new DatabaseSync(nextHoldingDbPath, { readOnly: true });
  try {
    const run = db.prepare("SELECT * FROM shadow_runs WHERE status!='invalidated_preflight' ORDER BY frozen_at DESC LIMIT 1").get();
    const participants = db.prepare("SELECT * FROM shadow_participants ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'probation' THEN 1 WHEN 'watch' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END,total_return_pct DESC").all();
    if (!run) return { available: false, status: "waiting", message: "尚无已冻结预测", experts: [], participants };
    const liveRows = db.prepare(`SELECT e.expert_key,e.expert_name,e.source,COUNT(*) AS evaluated_count,SUM(v.hit_count) AS hit_count,
      SUM(v.actual_count) AS actual_count,SUM(v.retained_hit_count) AS retained_hit_count,SUM(v.new_buy_hit_count) AS new_buy_hit_count,AVG(v.brier_score) AS brier_score
      FROM shadow_evaluations v JOIN shadow_experts e ON e.run_id=v.run_id AND e.expert_key=v.expert_key
      JOIN shadow_runs r ON r.run_id=v.run_id
      WHERE v.actual_available=1 AND r.score_eligible=1 GROUP BY e.expert_key,e.expert_name,e.source`).all();
    const liveByKey = new Map(liveRows.map((row) => [row.expert_key, row]));
    const latestExperts = db.prepare("SELECT * FROM shadow_experts WHERE run_id=? ORDER BY expert_name").all(run.run_id);
    const experts = latestExperts.map((expert) => {
      const calibration = parseJsonText(expert.calibration_json) || { transitions: 0, hits: [] };
      const calibrationHits = (calibration.hits || []).reduce((sum, value) => sum + number(value), 0);
      const backtestTransitions = number(calibration.transitions);
      const live = liveByKey.get(expert.expert_key);
      const participant = participants.find((item) => item.participant_key === expert.expert_key);
      const predictions = db.prepare("SELECT * FROM shadow_predictions WHERE run_id=? AND expert_key=? ORDER BY rank").all(run.run_id, expert.expert_key).map((prediction) => ({
        rank: prediction.rank, stockCode: prediction.stock_code, stockName: prediction.stock_name,
        probabilityPct: round(number(prediction.probability) * 100, 1), currentHolding: prediction.current_holding === 1,
        score: round(prediction.score), historyComponent: round(prediction.history_component), recentStyleComponent: round(prediction.recent_style_component), siteComponent: round(prediction.site_component),
        reasons: (parseJsonText(prediction.reasons_json) || {}).reasons || [],
      }));
      return {
        expertKey: expert.expert_key, expertName: expert.expert_name, source: expert.source,
        status: participant?.status || "active", statusReason: participant?.status_reason || "当前预测批次正式选手",
        latestHoldingDate: expert.latest_holding_date, historyDays: expert.history_days, transitionCount: expert.transition_count,
        mappingPct: round(expert.mapping_pct, 1), styleShift: round(expert.style_shift, 3),
        historicalAccuracy: {
          sampleCount: backtestTransitions, averageHits: backtestTransitions ? round(calibrationHits / backtestTransitions, 2) : null,
          precisionAt5Pct: backtestTransitions ? round(100 * calibrationHits / (backtestTransitions * 5), 1) : null,
        },
        liveAccuracy: {
          sampleCount: number(live?.evaluated_count), averageHits: live?.evaluated_count ? round(number(live.hit_count) / number(live.evaluated_count), 2) : null,
          precisionAt5Pct: live?.evaluated_count ? round(100 * number(live.hit_count) / (number(live.evaluated_count) * 5), 1) : null,
          actualRecallPct: live?.actual_count ? round(100 * number(live.hit_count) / number(live.actual_count), 1) : null,
          retainedHits: number(live?.retained_hit_count), newBuyHits: number(live?.new_buy_hit_count), brierScore: live?.brier_score == null ? null : round(live.brier_score, 4),
        },
        predictions,
      };
    });
    const backtestSamples = experts.reduce((sum, expert) => sum + expert.historicalAccuracy.sampleCount, 0);
    const backtestHits = experts.reduce((sum, expert) => sum + expert.historicalAccuracy.averageHits * expert.historicalAccuracy.sampleCount, 0);
    const liveSamples = experts.reduce((sum, expert) => sum + expert.liveAccuracy.sampleCount, 0);
    const liveHits = experts.reduce((sum, expert) => sum + number(expert.liveAccuracy.averageHits) * expert.liveAccuracy.sampleCount, 0);
    const lifecycleCounts = Object.fromEntries(["active", "probation", "watch", "paused", "retired"].map((status) => [status, participants.filter((item) => item.status === status).length]));
    const manifest = parseJsonText(run.feature_manifest_json) || {};
    return {
      available: true, status: run.status, generatedAt: run.frozen_at, modelVersion: run.model_version,
      run: {
        runId: run.run_id, asOfDate: run.as_of_date, targetDate: run.target_date, status: run.status,
        marketFeatureDate: run.market_feature_date, chipFeatureDate: run.chip_feature_date,
        scoreEligible: run.score_eligible === 1, scoreEligibilityReason: run.score_eligibility_reason,
      },
      summary: {
        expertCount: experts.length, predictionCount: experts.reduce((sum, expert) => sum + expert.predictions.length, 0),
        historicalSampleCount: backtestSamples, historicalAverageHits: backtestSamples ? round(backtestHits / backtestSamples, 2) : null,
        historicalPrecisionAt5Pct: backtestSamples ? round(100 * backtestHits / (backtestSamples * 5), 1) : null,
        liveSampleCount: liveSamples, liveAverageHits: liveSamples ? round(liveHits / liveSamples, 2) : null,
        livePrecisionAt5Pct: liveSamples ? round(100 * liveHits / (liveSamples * 5), 1) : null,
        lifecycleCounts,
      },
      continuity: {
        updateOrder: ["18:40核验真实持仓", "夜间正式行情/筹码/AIA/ABCD/热度完成", "滚动重算个人校准", "冻结下一交易日预测"],
        participantPolicy: manifest.participantLifecycle?.policy || null,
        aiPolicy: manifest.aiPolicy || { predictionProvider: "none", allowedOptionalProvider: "deepseek-chat" },
        immutablePredictions: true, missingHoldingsAreNotEmpty: true,
      },
      experts,
      participants: participants.map((item) => ({
        expertKey: item.participant_key, expertName: item.expert_name, source: item.source, status: item.status,
        manualSeed: item.manual_seed === 1, latestHoldingDate: item.last_holding_date, observationDays: item.observation_days,
        transitionCount: item.transition_count, mappingPct: round(item.mapping_pct, 1), totalReturnPct: item.total_return_pct,
        qualifyingStreak: item.qualifying_streak, staleTradingDays: item.stale_trading_days, reason: item.status_reason,
      })),
      note: "概率为目标日出现于公开持仓中的独立概率；仅供模型验证，不构成投资建议。",
    };
  } finally { db.close(); }
}

export function syncExpertTrackerHeartbeat(db) {
  try {
    const status = expertTrackerStatus();
    const heartbeat = status.deployed ? (status.healthy ? "healthy" : "degraded") : "failed";
    db.prepare(`INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json)
      VALUES('expert_tracker',?,?,?, ?,0,?) ON CONFLICT(service_key) DO UPDATE SET status=excluded.status,pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=excluded.last_error,details_json=excluded.details_json`)
      .run(heartbeat, process.pid, new Date().toISOString(), heartbeat === "healthy" ? null : status.recovery, JSON.stringify(status));
    return status;
  } catch (error) {
    db.prepare(`INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json)
      VALUES('expert_tracker','failed',?,?,?,0,'{}') ON CONFLICT(service_key) DO UPDATE SET status='failed',pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=excluded.last_error`)
      .run(process.pid, new Date().toISOString(), clean(error.message, 500));
    throw error;
  }
}

function runScript(script, args = [], timeoutMs = 45 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectDir, script), ...args], { cwd: projectDir, windowsHide: true, env: process.env });
    const stdout = []; const stderr = []; let size = 0; let settled = false;
    const finish = (action) => { if (settled) return; settled = true; clearTimeout(timer); action(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error(`高手持仓更新超过${Math.round(timeoutMs / 60_000)}分钟，已终止并保留上一发布版`))); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= 8 * 1024 * 1024) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.reduce((sum, value) => sum + value.length, 0) < 2 * 1024 * 1024) stderr.push(chunk); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => finish(() => resolve({ code: Number(code ?? 1), stdout: clean(Buffer.concat(stdout).toString("utf8"), 4_000), stderr: clean(Buffer.concat(stderr).toString("utf8"), 4_000) })));
  });
}

export async function runExpertTrackerUpdate({ recovery = false, targetDate = shanghaiDate() } = {}) {
  const script = recovery ? "tools/expert_tracking_sources/run_recovery_update.mjs" : "tools/expert_tracking_sources/run_stable_update.mjs";
  const args = recovery ? [] : ["--date", targetDate];
  const result = await runScript(script, args);
  if (![0, 2].includes(result.code)) throw new Error(result.stderr.split("\n").filter(Boolean).at(-1) || `高手持仓更新退出码 ${result.code}`);
  const status = expertTrackerStatus();
  if (!status.deployed) throw new Error("高手持仓数据未通过发布门禁，旧版本继续生效");
  return { count: status.counts.visibleExperts, message: `${status.businessDate} 高手持仓已${status.healthy ? "健康发布" : "降级发布"}，${status.counts.visibleExperts}个具有交易明细的选手/组合`, status };
}

export async function runExpertShadowExperiment({ asOf = shanghaiDate(), targetDate = null, evaluateOnly = false, predictOnly = false, requireCurrentFeatures = false } = {}) {
  const args = ["--as-of", asOf];
  if (targetDate) args.push("--target", targetDate);
  if (evaluateOnly) args.push("--evaluate-only");
  if (predictOnly) args.push("--predict-only");
  if (requireCurrentFeatures) args.push("--require-current-features");
  const result = await runScript("tools/expert_tracking_sources/run_next_holding_shadow.mjs", args, 5 * 60_000);
  if (result.code !== 0) {
    const lines = result.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
    const reason = (lines.find((line) => /^Error:\s*/.test(line)) || lines[0] || `次日持仓暗测退出码 ${result.code}`).replace(/^Error:\s*/, "");
    throw new Error(reason);
  }
  const payload = parseJsonText(result.stdout);
  return {
    count: payload?.prediction ? number(payload.prediction.predictionCount) : Number(payload?.evaluations?.reduce((sum, item) => sum + Number(item.available || 0), 0) || 0),
    message: payload?.prediction ? `${asOf} 截面已冻结${number(payload.prediction.expertCount)}人共${number(payload.prediction.predictionCount)}只次日持仓候选` : `${asOf} 暗测核验完成`,
    payload,
  };
}

function parseJsonText(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function recordClientError(db, payload = {}, userAgent = "") {
  const eventId = randomUUID();
  const message = clean(payload.message || "未知前端错误");
  db.prepare(`INSERT INTO client_error_events(event_id,module_key,route,phase,message,source,stack,user_agent,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(eventId, "expert_tracker", clean(payload.route, 300), clean(payload.phase, 100), message, clean(payload.source, 300), clean(payload.stack, 4_000), clean(userAgent, 500), new Date().toISOString());
  upsertOpenAlert(db, {
    severity: "warning",
    source: "expert_tracker_client",
    title: "高手持仓页面前端错误",
    message,
  });
  return { ok: true, eventId };
}
