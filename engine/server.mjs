import "./env.mjs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
  addChipSample, analyze, backupDatabase, chipRankings, chipSamples, dashboard, dataStatus, deleteChipSample,
  factorDefinitions, getRecommendations, modelWeightConfigs, openDatabase, publishAlgorithmTask, resetModelWeightConfig,
  runScreener, runTemplateMatching, runWatchdog, saveChipDistributions, saveModelWeightConfig, storedChipDistributions,
} from "./core.mjs";
import { purgeNonAkshareM30, rebuildDailyFactors, refreshAkshareM30, refreshAkshareQuotes, refreshOfficialDailyBars, scoreChipModels, syncChipAxes, syncMarketFactorSnapshot, syncRecommendationDailyHistory } from "./data_sources.mjs";
import { providerCapabilities, runProviderBridge } from "./provider_bridge.mjs";
import { algorithmCapabilities, exactKlineSimilarityRuntimeStatus, exactKlineSimilarityStatus, refreshExactKlineSimilarityCache, runAbcdRecommendation, runAiFreshNews, runAiaRecommendation, runChipRetrain, runCommunityHotTopics, runFivePlatformRefresh, runHeatRecommendation, runNewsCollectors, runPreopenDailyPanel } from "./algorithm_bridge.mjs";
import { createKlineSimilarityScan, executeKlineSimilarityScan, klineSimilarityDashboard, recoverInterruptedKlineScans } from "./kline_similarity.mjs";
import { cancelReferenceSimilarityScan, createReferenceSimilarityScan, executeReferenceSimilarityScan, latestReferenceSimilarityResult, recoverInterruptedReferenceSimilarityScans, referenceSimilarityCacheStatus, referenceSimilarityProgress, referenceSimilarityResult, referenceSimilarityStatus, saveReferenceSimilarityRating } from "./reference_similarity.mjs";
import { startScheduler } from "./scheduler.mjs";
import { ensureForwardTest, forwardAuditExport, forwardDashboard, forwardPreview, verifyForwardAudit } from "./forward_test.mjs";
import { fivePlatformDashboard, saveFivePlatformSnapshot, syncLatestFivePlatformCache } from "./five_platform.mjs";
import { ensurePreopenSchedule, getPreopenSummary, preopenStatus, savePreopenSummary } from "./preopen.mjs";
import { communityTopicsStatus, ensureCommunityTopicSchedule, getCommunityTopics, saveCommunityTopics } from "./community_topics.mjs";
import { ensureSectorStockRankSchedule, getSectorStockRank, refreshSectorStockRank } from "./sector_stock_rank.mjs";
import { ensureExpertTrackerSchedules, expertNextHoldingForecast, expertTrackerStatus, recordClientError, syncExpertTrackerHeartbeat } from "./expert_tracker.mjs";
import { resolveOpenAlert, runStartupMaintenance } from "./maintenance.mjs";
import { normalizeXueqiuCookie, persistXueqiuCookie } from "./local_secrets.mjs";
import { archiveScheduledScreener, ensureScheduledScreenerSchedule, runScheduledScreener, saveScheduledScreener, scheduledScreenerDashboard } from "./scheduled_screener.mjs";
import { authoritativeAiaStatus } from "./aia_authoritative.mjs";

const port = Number(process.env.ASTER_ENGINE_PORT || 8035);
const host = process.env.ASTER_ENGINE_HOST || "127.0.0.1";
const db = openDatabase();
const startupRecovery = runStartupMaintenance(db);
recoverInterruptedKlineScans(db);
recoverInterruptedReferenceSimilarityScans(db);
ensureForwardTest(db);
ensurePreopenSchedule(db);
const recoveredPreopen = preopenStatus(db);
if (recoveredPreopen.status === "success" && recoveredPreopen.updated_at) {
  db.prepare("UPDATE schedule_definitions SET last_success_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='stock_market_preopen_daily_panel'").run(recoveredPreopen.updated_at);
  db.prepare(`UPDATE alerts SET status='resolved',resolved_at=CURRENT_TIMESTAMP
    WHERE source='stock_market_preopen_daily_panel' AND title='stock_market_preopen_daily_panel任务失败' AND status='open'
      AND julianday(?)>=julianday(created_at)`).run(recoveredPreopen.updated_at);
}
ensureCommunityTopicSchedule(db);
ensureSectorStockRankSchedule(db);
ensureExpertTrackerSchedules(db);
ensureScheduledScreenerSchedule(db);
try { syncExpertTrackerHeartbeat(db); } catch {}
try { syncLatestFivePlatformCache(db); } catch {}
const stopScheduler = process.env.ASTER_SCHEDULER_DISABLED === "1" ? () => {} : startScheduler(db);
const manualJobs = new Map();

function headers(extra = {}) {
  return { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Aster-Local-Gateway", "Cache-Control": "no-store", ...extra };
}

function send(response, status, payload) {
  response.writeHead(status, headers()); response.end(JSON.stringify(payload));
}

function sendDownload(response, artifact) {
  response.writeHead(200, headers({ "Content-Type": artifact.contentType, "Content-Disposition": `attachment; filename="${artifact.filename}"` }));
  response.end(artifact.content);
}

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1_500_000) throw new Error("请求过大"); chunks.push(chunk); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function refreshModel(modelKey, trigger = "manual") {
  const started = Date.now(); let task;
  if (modelKey === "abcd") {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", weekday: "short", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (!["Sat", "Sun"].includes(parts.weekday) && ((minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 35) || (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 5))) await refreshAkshareQuotes(db);
    task = await runAbcdRecommendation({ refresh: true });
  }
  if (modelKey === "aia") {
    task = await runAiaRecommendation();
  }
  if (modelKey === "heat") {
    const evidence = await runNewsCollectors();
    const platformPayload = evidence?.stages?.find((stage) => stage.name === "five_platform_heat" && stage.ok)?.result;
    if (platformPayload?.platforms) saveFivePlatformSnapshot(db, platformPayload, "manual_heat_sources");
    // Heat is the original 8002-compatible selector: legacy two-stage ranking
    // with the same-day source contract. Strict mode is an audit variant only.
    task = await runHeatRecommendation({ mode: "legacy", refresh: false, sourcePolicy: "fresh" });
  }
  if (!task) throw new Error("未知推荐模型");
  return { ...publishAlgorithmTask(db, modelKey, task, trigger), latencyMs: Date.now() - started };
}

function queueModelRefresh(modelKey) {
  if (!['abcd', 'aia', 'heat'].includes(modelKey)) throw new Error("未知推荐模型");
  const running = [...manualJobs.values()].find((job) => job.modelKey === modelKey && job.status === "running");
  if (running) return { jobId: running.jobId, model: modelKey, status: "running", reused: true };
  const jobId = randomUUID(); const startedAt = new Date().toISOString();
  const state = { jobId, modelKey, status: "running", startedAt, result: null, error: null };
  manualJobs.set(jobId, state);
  db.prepare("INSERT INTO sync_jobs(job_id,job_type,status,source,rows_changed,message,started_at) VALUES(?,?,'running',?,0,?,?)")
    .run(jobId, `manual_recommendation_${modelKey}`, `${modelKey}_original_compatible`, "原版算法已进入后台队列", startedAt);
  setImmediate(async () => {
    try {
      const result = await refreshModel(modelKey, "manual");
      Object.assign(state, { status: "success", result, finishedAt: new Date().toISOString() });
      db.prepare("UPDATE sync_jobs SET status='success',rows_changed=?,message=?,finished_at=? WHERE job_id=?")
        .run(Number(result.count || 0), result.sourceMessage || `${modelKey.toUpperCase()}原版任务完成`, state.finishedAt, jobId);
    } catch (error) {
      Object.assign(state, { status: "failed", error: error.message, finishedAt: new Date().toISOString() });
      db.prepare("UPDATE sync_jobs SET status='failed',message=?,finished_at=? WHERE job_id=?").run(error.message, state.finishedAt, jobId);
    }
  });
  return { jobId, model: modelKey, status: "running", reused: false };
}

function modelJob(jobId) {
  const memory = manualJobs.get(jobId);
  const row = db.prepare("SELECT * FROM sync_jobs WHERE job_id=?").get(jobId);
  if (!row) throw new Error("任务不存在");
  return { ...row, model: memory?.modelKey || String(row.job_type || "").replace("manual_recommendation_", ""), result: memory?.result || null, error: memory?.error || (row.status === "failed" ? row.message : null) };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") { response.writeHead(204, headers()); response.end(); return; }
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (!["GET", "HEAD"].includes(request.method || "GET") && process.env.ASTER_ALLOW_DIRECT_MUTATION !== "1" && request.headers["x-aster-local-gateway"] !== "1") return send(response, 403, { error: "写操作仅允许通过本机Aster网关" });
    if (request.method === "GET" && ["/health", "/api/runtime-status"].includes(url.pathname)) return send(response, 200, { ok: true, service: "aster-independent-engine", database: "online", pid: process.pid, startupRecovery, now: new Date().toISOString() });
    if (request.method === "GET" && url.pathname === "/api/dashboard") return send(response, 200, dashboard(db));
    if (request.method === "GET" && url.pathname === "/api/expert-tracker/status") return send(response, 200, expertTrackerStatus());
    if (request.method === "GET" && url.pathname === "/api/expert-next-holding") return send(response, 200, expertNextHoldingForecast());
    if (request.method === "POST" && url.pathname === "/api/monitor/client-error") return send(response, 202, recordClientError(db, await body(request), request.headers["user-agent"] || ""));
    if (request.method === "GET" && url.pathname === "/api/preopen-daily-summary/status") return send(response, 200, preopenStatus(db, url.searchParams.get("date") || undefined));
    if (request.method === "GET" && ["/api/preopen-daily-summary", "/api/preopen‑daily‑summary"].includes(decodeURIComponent(url.pathname))) return send(response, 200, getPreopenSummary(db, url.searchParams.get("date") || undefined));
    if (request.method === "POST" && url.pathname === "/api/preopen-daily-summary/refresh") {
      const input = await body(request);
      const targetDate = input.date || undefined;
      const startedAt = new Date().toISOString();
      db.prepare("UPDATE schedule_definitions SET last_started_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='stock_market_preopen_daily_panel'").run(startedAt);
      const task = await runPreopenDailyPanel({ targetDate, skipNewsRefresh: input.skipNewsRefresh === true, taogubaOnly: input.taogubaOnly === true });
      const payload = savePreopenSummary(db, task, targetDate);
      if (task.status === "success") {
        db.prepare("UPDATE schedule_definitions SET last_success_at=?,updated_at=CURRENT_TIMESTAMP WHERE schedule_key='stock_market_preopen_daily_panel'").run(new Date().toISOString());
        resolveOpenAlert(db, "stock_market_preopen_daily_panel", "stock_market_preopen_daily_panel任务失败");
      }
      return send(response, 200, { task: { status: task.status, source_counts: task.source_counts, errors: task.errors }, payload });
    }
    if (request.method === "GET" && url.pathname === "/api/community-hot-topics/status") return send(response, 200, communityTopicsStatus(db, url.searchParams.get("date") || undefined));
    if (request.method === "GET" && url.pathname === "/api/community-hot-topics") return send(response, 200, getCommunityTopics(db, url.searchParams.get("date") || undefined));
    if (request.method === "POST" && url.pathname === "/api/community-hot-topics/refresh") {
      const input = await body(request);
      const targetDate = input.date || undefined;
      let sourceRefresh = null;
      if (input.refreshSources === true) {
        try { sourceRefresh = await runNewsCollectors(); }
        catch (error) { sourceRefresh = { status: "failed", error: error.message }; }
      }
      const task = await runCommunityHotTopics({ targetDate });
      return send(response, 200, { sourceRefresh, task: { status: task.status, source_counts: task.source_counts, errors: task.errors }, payload: saveCommunityTopics(db, task, targetDate) });
    }
    if (request.method === "GET" && url.pathname === "/api/sector_stock_multi_rank") return send(response, 200, await getSectorStockRank(db, {
      sectorPage: url.searchParams.get("sector_page"), sectorPageSize: url.searchParams.get("sector_page_size"),
      stockPage: url.searchParams.get("stock_page"), stockPageSize: url.searchParams.get("stock_page_size"),
    }));
    if (request.method === "POST" && url.pathname === "/api/sector_stock_multi_rank/refresh") {
      const result = await refreshSectorStockRank(db);
      return send(response, 200, { ...result, payload: undefined, data: result.payload });
    }
    if (request.method === "GET" && url.pathname === "/api/five-platform") return send(response, 200, fivePlatformDashboard(db, { syncCache: false }));
    if (request.method === "POST" && url.pathname === "/api/five-platform/refresh") {
      const task = await runFivePlatformRefresh();
      if (!task?.payload) throw new Error(task?.message || "五平台刷新没有返回榜单");
      const saved = saveFivePlatformSnapshot(db, task.payload, "manual_refresh");
      return send(response, 200, { ...task, saved, dashboard: fivePlatformDashboard(db, { syncCache: false }) });
    }
    if (request.method === "POST" && url.pathname === "/api/five-platform/xueqiu-session") {
      const input = await body(request);
      const cookie = normalizeXueqiuCookie(input.cookie);
      const previous = process.env.XUEQIU_COOKIE;
      process.env.XUEQIU_COOKIE = cookie;
      try {
        const task = await runFivePlatformRefresh();
        const source = task?.payload?.platforms?.find((item) => item.key === "xueqiu");
        if (!source?.ok || !source.items?.length) throw new Error(source?.error || "雪球 Cookie 未通过接口验证");
        persistXueqiuCookie(cookie);
        const saved = saveFivePlatformSnapshot(db, task.payload, "xueqiu_session_refresh");
        return send(response, 200, { configured: true, saved, dashboard: fivePlatformDashboard(db, { syncCache: false }) });
      } catch (error) {
        if (previous === undefined) delete process.env.XUEQIU_COOKIE;
        else process.env.XUEQIU_COOKIE = previous;
        throw new Error(`雪球登录态验证失败：${error.message}`);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/forward-test") return send(response, 200, forwardDashboard(db));
    if (request.method === "GET" && url.pathname === "/api/forward-test/preview") return send(response, 200, forwardPreview(db));
    if (request.method === "POST" && url.pathname === "/api/forward-test/verify") return send(response, 200, verifyForwardAudit(db));
    if (request.method === "GET" && url.pathname === "/api/forward-test/audit") return sendDownload(response, forwardAuditExport(db, url.searchParams.get("format") || "json"));
    if (request.method === "GET" && url.pathname === "/api/recommendations") return send(response, 200, getRecommendations(db, url.searchParams.get("model") || "all", {
      abcdMode: url.searchParams.get("abcd_mode") || "latest",
      abcdBatchId: url.searchParams.get("abcd_batch_id") || null,
      abcdTradeDate: url.searchParams.get("abcd_trade_date") || null,
    }));
    if (request.method === "GET" && url.pathname === "/api/aia-authoritative/current") return send(response, 200, authoritativeAiaStatus());
    if (request.method === "POST" && url.pathname === "/api/recommendations/refresh") {
      const input = await body(request); return send(response, 202, queueModelRefresh(input.model || "abcd"));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) return send(response, 200, modelJob(decodeURIComponent(url.pathname.split("/").at(-1))));
    if (request.method === "GET" && url.pathname === "/api/factors") return send(response, 200, { items: factorDefinitions, count: factorDefinitions.length });
    if (request.method === "POST" && url.pathname === "/api/screener") return send(response, 200, runScreener(db, await body(request)));
    if (request.method === "GET" && url.pathname === "/api/screener/daily") return send(response, 200, scheduledScreenerDashboard(db, url.searchParams.get("strategy_id") || undefined));
    if (request.method === "POST" && url.pathname === "/api/screener/daily/config") return send(response, 200, saveScheduledScreener(db, await body(request)));
    if (request.method === "DELETE" && /^\/api\/screener\/daily\/[^/]+$/.test(url.pathname)) return send(response, 200, archiveScheduledScreener(db, decodeURIComponent(url.pathname.split("/").at(-1))));
    if (request.method === "POST" && url.pathname === "/api/screener/daily/run") {
      const input = await body(request);
      return send(response, 200, runScheduledScreener(db, input.strategyId || undefined, "manual"));
    }
    if (request.method === "GET" && url.pathname === "/api/model-weights") return send(response, 200, modelWeightConfigs(db));
    if (request.method === "POST" && /^\/api\/model-weights\/[^/]+$/.test(url.pathname)) {
      const modelKey = decodeURIComponent(url.pathname.split("/").at(-1));
      if (modelKey === "aia") return send(response, 409, { error: "AIA排行是权威源只读批次，本机禁止修改权重" });
      return send(response, 200, saveModelWeightConfig(db, modelKey, await body(request)));
    }
    if (request.method === "POST" && /^\/api\/model-weights\/[^/]+\/reset$/.test(url.pathname)) {
      const modelKey = decodeURIComponent(url.pathname.split("/").at(-2));
      if (modelKey === "aia") return send(response, 409, { error: "AIA排行是权威源只读批次，本机禁止重置权重" });
      return send(response, 200, resetModelWeightConfig(db, modelKey));
    }
    if (request.method === "GET" && url.pathname === "/api/aia/similarity/status") return send(response, 200, referenceSimilarityStatus(await exactKlineSimilarityRuntimeStatus()));
    if (request.method === "GET" && url.pathname === "/api/aia/similarity/cache/status") return send(response, 200, referenceSimilarityCacheStatus(await exactKlineSimilarityStatus()));
    if (request.method === "POST" && url.pathname === "/api/aia/similarity/cache/refresh") {
      const input = await body(request);
      const refreshed = await refreshExactKlineSimilarityCache({ batchSize: input.batch_size || 120 });
      return send(response, 200, { data: refreshed, meta: { request_id: randomUUID(), warnings: [] }, error: null });
    }
    if (request.method === "POST" && url.pathname === "/api/aia/similarity/scan/start") {
      const created = createReferenceSimilarityScan(db, await body(request));
      if (!created.data.reused) setImmediate(() => executeReferenceSimilarityScan(db, created.data.scan_id).catch(() => undefined));
      return send(response, 200, created);
    }
    if (request.method === "POST" && url.pathname === "/api/aia/similarity/scan") {
      const created = createReferenceSimilarityScan(db, await body(request));
      if (!created.data.reused) await executeReferenceSimilarityScan(db, created.data.scan_id);
      return send(response, 200, referenceSimilarityResult(db, created.data.scan_id));
    }
    if (request.method === "GET" && url.pathname === "/api/aia/similarity/scan/latest") return send(response, 200, latestReferenceSimilarityResult(db));
    if (request.method === "GET" && /^\/api\/aia\/similarity\/scan\/progress\/[^/]+$/.test(url.pathname)) return send(response, 200, referenceSimilarityProgress(db, decodeURIComponent(url.pathname.split("/").at(-1))));
    if (request.method === "GET" && /^\/api\/aia\/similarity\/scan\/result\/[^/]+$/.test(url.pathname)) return send(response, 200, referenceSimilarityResult(db, decodeURIComponent(url.pathname.split("/").at(-1))));
    if (request.method === "POST" && /^\/api\/aia\/similarity\/scan\/cancel\/[^/]+$/.test(url.pathname)) return send(response, 200, cancelReferenceSimilarityScan(db, decodeURIComponent(url.pathname.split("/").at(-1))));
    if (request.method === "POST" && url.pathname === "/api/aia/similarity/ratings") return send(response, 200, saveReferenceSimilarityRating(await body(request)));
    if (request.method === "GET" && url.pathname === "/api/kline-similarity") return send(response, 200, klineSimilarityDashboard(db, {
      scanId: url.searchParams.get("scan_id") || undefined, limit: url.searchParams.get("limit") || 50, filter: url.searchParams.get("filter") || "all",
    }));
    if (request.method === "GET" && /^\/api\/kline-similarity\/scans\/[^/]+$/.test(url.pathname)) {
      const scanId = decodeURIComponent(url.pathname.split("/").at(-1));
      return send(response, 200, klineSimilarityDashboard(db, { scanId, limit: url.searchParams.get("limit") || 50, filter: url.searchParams.get("filter") || "all" }));
    }
    if (request.method === "POST" && url.pathname === "/api/kline-similarity/scans") {
      const input = await body(request);
      const created = createKlineSimilarityScan(db, input);
      if (!created.reused) setImmediate(() => executeKlineSimilarityScan(db, created.scanId, created.config).catch(() => undefined));
      return send(response, 202, created);
    }
    if (request.method === "GET" && url.pathname === "/api/chip/rankings") return send(response, 200, chipRankings(db, url.searchParams.get("scope") || "formal", url.searchParams.get("limit") || 100));
    if (request.method === "GET" && url.pathname === "/api/chip/samples") return send(response, 200, chipSamples(db));
    if (request.method === "GET" && url.pathname === "/api/chip/sample-distributions") {
      let profiles = storedChipDistributions(db);
      if (profiles.missing.length) {
        try {
          const fetched = await runProviderBridge("chip-sample-distributions", { database: process.env.ASTER_MARKET_DB || process.env.QUANT_DB_PATH, samples: profiles.missing, max_points: 4096 }, { timeoutMs: 90_000, maximumBytes: 32 * 1024 * 1024 });
          profiles = saveChipDistributions(db, fetched.profiles || []);
        } catch (error) {
          profiles.warning = `部分历史样本暂缺筹码点位：${error.message}`;
        }
      }
      return send(response, 200, profiles);
    }
    if (request.method === "POST" && url.pathname === "/api/chip/samples") return send(response, 201, addChipSample(db, await body(request)));
    if (request.method === "DELETE" && url.pathname.startsWith("/api/chip/samples/")) return send(response, 200, deleteChipSample(db, decodeURIComponent(url.pathname.split("/").at(-1))));
    if (request.method === "POST" && url.pathname === "/api/ai/analyze") {
      const input = await body(request);
      let liveNews;
      try { liveNews = await runAiFreshNews({ force: input.refreshNews === true }); }
      catch (error) { liveNews = { status: "unavailable", generated_at: new Date().toISOString(), error: error.message, items: [], item_count: 0 }; }
      return send(response, 200, await analyze(db, { ...input, liveNews }));
    }
    if (request.method === "GET" && url.pathname === "/api/templates") return send(response, 200, { profiles: db.prepare("SELECT * FROM template_profiles ORDER BY module,updated_at DESC").all(), matches: db.prepare("SELECT m.*,s.name,s.industry FROM template_matches m JOIN securities s ON s.code=m.code ORDER BY m.trade_time DESC,m.similarity DESC LIMIT 100").all() });
    if (request.method === "GET" && url.pathname === "/api/kline") {
      const code = String(url.searchParams.get("code") || "").toUpperCase();
      const bars = db.prepare("SELECT * FROM bars_30m WHERE code=? ORDER BY trade_time DESC LIMIT 120").all(code).reverse();
      const match = db.prepare("SELECT * FROM template_matches WHERE code=? ORDER BY trade_time DESC LIMIT 1").get(code);
      return send(response, 200, { code, bars, match });
    }
    if (request.method === "POST" && url.pathname === "/api/kline/analyze") {
      const input = await body(request); const code = String(input.code || "").toUpperCase();
      if (input.refresh !== false) { try { await refreshAkshareM30(db, [code]); } catch {} }
      return send(response, 200, runTemplateMatching(db, code));
    }
    if (request.method === "GET" && url.pathname === "/api/data/status") return send(response, 200, dataStatus(db));
    if (request.method === "POST" && url.pathname === "/api/data/watchdog") return send(response, 200, runWatchdog(db));
    if (request.method === "POST" && url.pathname === "/api/data/maintenance") return send(response, 200, { startup: runStartupMaintenance(db), watchdog: runWatchdog(db) });
    if (request.method === "POST" && url.pathname === "/api/data/backup") return send(response, 200, await backupDatabase(db));
    if (request.method === "GET" && url.pathname === "/api/data/provider-capabilities") return send(response, 200, await providerCapabilities());
    if (request.method === "GET" && url.pathname === "/api/data/algorithm-capabilities") return send(response, 200, algorithmCapabilities());
    if (request.method === "POST" && url.pathname === "/api/data/quotes") return send(response, 200, await refreshAkshareQuotes(db));
    if (request.method === "POST" && url.pathname === "/api/data/daily-bars") { const input = await body(request); return send(response, 200, await refreshOfficialDailyBars(db, null, { startDate: input.startDate, endDate: input.endDate })); }
    if (request.method === "POST" && url.pathname === "/api/data/market-factors") return send(response, 200, await syncMarketFactorSnapshot(db));
    if (request.method === "POST" && url.pathname === "/api/data/research-history") return send(response, 200, await syncRecommendationDailyHistory(db));
    if (request.method === "POST" && url.pathname === "/api/data/enforce-intraday-source") return send(response, 200, purgeNonAkshareM30(db));
    if (request.method === "POST" && url.pathname === "/api/data/rebuild-factors") return send(response, 200, rebuildDailyFactors(db, (await body(request)).tradeDate || null));
    if (request.method === "POST" && url.pathname === "/api/data/chip-models") {
      const sync = await syncChipAxes(db); const retrain = await runChipRetrain(); const scoring = await scoreChipModels(db, sync.tradeDate); return send(response, 200, { sync, retrain, scoring });
    }
    if (request.method === "POST" && url.pathname === "/api/data/chip-scores") { const sync = await syncChipAxes(db); const scoring = await scoreChipModels(db, sync.tradeDate); return send(response, 200, { sync, scoring }); }
    return send(response, 404, { error: "接口不存在" });
  } catch (error) { return send(response, error.message?.includes("不存在") || error.message?.includes("需要") || error.message?.includes("门禁") || error.message?.includes("Cookie") ? 400 : 500, { error: error.message, traceId: randomUUID() }); }
});

server.listen(port, host, () => console.log(`Aster independent engine http://${host}:${port}`));

function shutdown() {
  stopScheduler();
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
