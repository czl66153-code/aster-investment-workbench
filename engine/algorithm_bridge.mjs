import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { databasePath, projectDir } from "./core.mjs";
import { resolveMarketPython, runProviderBridge } from "./provider_bridge.mjs";
import { loadAuthoritativeAia } from "./aia_authoritative.mjs";

function dataPath(name) { return join(projectDir, "data", name); }

function parseJsonOutput(output) {
  const trimmed = output.trim();
  const start = trimmed.indexOf("{"); const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("算法任务没有返回JSON结果");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function runPythonAlgorithm(args, options = {}) {
  const executable = resolveMarketPython();
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs || 12 * 60_000));
  const vendorPath = join(projectDir, "python_engine", "vendor_exact");
  const enginePythonPath = join(projectDir, "engine", "python_engine");
  const localPackages = join(projectDir, "python_packages");
  const pythonPath = [projectDir, enginePythonPath, vendorPath, localPackages, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  const environment = {
    ...process.env,
    ASTER_DB_PATH: databasePath,
    ASTER_DATA_ROOT: join(projectDir, "data"),
    ASTER_8002_DATA_ROOT: process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data"),
    ASTER_MARKET_DB: process.env.ASTER_MARKET_DB || dataPath("market.duckdb"),
    QUANT_DB_PATH: process.env.ASTER_MARKET_DB || dataPath("market.duckdb"),
    QUANT_DATA_ROOT: join(projectDir, "data"),
    ASTER_NODE_ABCD_WRITEBACK: "1",
    PYTHONPATH: pythonPath,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: projectDir, env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let size = 0; let settled = false;
    const maximumBytes = Number(options.maximumBytes || 32 * 1024 * 1024);
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error(`算法任务超过${Math.round(timeoutMs / 1000)}秒`))); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > maximumBytes) { child.kill(); finish(() => reject(new Error("算法任务输出超过质量门禁"))); } else stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.reduce((sum, value) => sum + value.length, 0) < 2 * 1024 * 1024) stderr.push(chunk); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const result = parseJsonOutput(Buffer.concat(stdout).toString("utf8"));
        if (![0, ...(options.acceptExitCodes || [])].includes(code) && !result) throw new Error(`exit ${code}`);
        finish(() => resolve({ ...result, processExitCode: code }));
      } catch (error) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-2_000);
        finish(() => reject(new Error(`${error.message}${detail ? `：${detail}` : ""}`)));
      }
    });
  });
}

export function runHeatRecommendation({ mode = "legacy", refresh = false, sourcePolicy = "fresh" } = {}) {
  const args = ["-m", "python_engine.vendor8002.cli", "run-heat-task", "--db", databasePath, "--source-root", process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data"), "--cache-root", process.env.ASTER_8002_CACHE_ROOT || dataPath("source8002_data_cache"), "--mode", mode, "--source-policy", sourcePolicy];
  if (refresh) args.push("--refresh-hot");
  return runPythonAlgorithm(args, { timeoutMs: refresh ? 8 * 60_000 : 90_000, acceptExitCodes: [2] });
}

export function runAbcdRecommendation({ refresh = true } = {}) {
  const script = join(projectDir, "python_engine", "abcd_task.py");
  const args = [script, "--wait-seconds", "420"];
  if (refresh) args.push("--refresh");
  return runPythonAlgorithm(args, { timeoutMs: 9 * 60_000 });
}

export function runAbcdWarmup() {
  const script = join(projectDir, "python_engine", "abcd_task.py");
  return runPythonAlgorithm([script, "--warmup-only"], { timeoutMs: 2 * 60_000 });
}

export function runForwardExecutionPrices({ codes, tradeDate, executionTime = "09:50" } = {}) {
  return runProviderBridge("intraday-execution-prices", {
    codes,
    trade_date: tradeDate,
    execution_time: executionTime,
  }, { timeoutMs: 90_000, maximumBytes: 4 * 1024 * 1024 });
}

export async function runAiaRecommendation() {
  return loadAuthoritativeAia();
}

export function runNightlyMarketSync({ end = null, includeChips = true, chipsOnly = false } = {}) {
  const script = join(projectDir, "python_engine", "market_sync.py");
  const args = [script, "--days", "1"];
  if (end) args.push("--end", end);
  if (includeChips) args.push("--include-chips");
  if (chipsOnly) args.push("--chips-only");
  return runPythonAlgorithm(args, { timeoutMs: 45 * 60_000, maximumBytes: 128 * 1024 * 1024 });
}

export function runNewsCollectors() {
  const script = join(projectDir, "python_engine", "news_task.py");
  return runPythonAlgorithm([script, "--data-root", process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data"), "--days", "2", "--aster-db", databasePath], { timeoutMs: 30 * 60_000 });
}

let aiFreshNewsPromise = null;
let aiFreshNewsCache = null;

export function runAiFreshNews({ force = false } = {}) {
  const now = Date.now();
  if (!force && aiFreshNewsCache && now - aiFreshNewsCache.cachedAt < 5 * 60_000) return Promise.resolve(aiFreshNewsCache.payload);
  if (aiFreshNewsPromise) return aiFreshNewsPromise;
  const script = join(projectDir, "python_engine", "ai_minishare_task.py");
  aiFreshNewsPromise = runPythonAlgorithm([
    script,
    "--source-root", process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data"),
    "--days", "2",
    "--limit", "500",
  ], { timeoutMs: 3 * 60_000, maximumBytes: 16 * 1024 * 1024, acceptExitCodes: [2] })
    .then((payload) => {
      aiFreshNewsCache = { cachedAt: Date.now(), payload };
      return payload;
    })
    .finally(() => { aiFreshNewsPromise = null; });
  return aiFreshNewsPromise;
}

export function runFivePlatformRefresh() {
  const script = join(projectDir, "python_engine", "five_platform_task.py");
  return runPythonAlgorithm([script, "--data-root", process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data")], { timeoutMs: 90_000 });
}

export function runChipRetrain() {
  const script = join(projectDir, "python_engine", "chip_retrain_task.py");
  return runPythonAlgorithm([script, "--db", databasePath], { timeoutMs: 3 * 60 * 60_000, maximumBytes: 32 * 1024 * 1024 });
}

const preopenDailyRuns = new Map();

export function runPreopenDailyPanel({ targetDate = null, skipNewsRefresh = false, taogubaOnly = false } = {}) {
  const script = join(projectDir, "python_engine", "preopen_daily_task.py");
  const args = [script, "--db", databasePath, "--source-root", process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data")];
  if (targetDate) args.push("--date", targetDate);
  if (skipNewsRefresh) args.push("--skip-news-refresh");
  if (taogubaOnly) args.push("--taoguba-only");
  const key = `${targetDate || "today"}:${skipNewsRefresh ? 1 : 0}:${taogubaOnly ? 1 : 0}`;
  const running = preopenDailyRuns.get(key);
  if (running) return running;
  const task = runPythonAlgorithm(args, { timeoutMs: 30 * 60_000, maximumBytes: 32 * 1024 * 1024 });
  preopenDailyRuns.set(key, task);
  task.finally(() => preopenDailyRuns.delete(key)).catch(() => undefined);
  return task;
}

const communityTopicRuns = new Map();

export function runCommunityHotTopics({ targetDate = null } = {}) {
  const script = join(projectDir, "python_engine", "community_hot_topics_task.py");
  const args = [script, "--source-root", process.env.ASTER_8002_DATA_ROOT || dataPath("source8002_data")];
  if (targetDate) args.push("--date", targetDate);
  const key = targetDate || "today";
  const running = communityTopicRuns.get(key);
  if (running) return running;
  const task = runPythonAlgorithm(args, { timeoutMs: 8 * 60_000, maximumBytes: 24 * 1024 * 1024 });
  communityTopicRuns.set(key, task);
  task.finally(() => communityTopicRuns.delete(key)).catch(() => undefined);
  return task;
}

function klineSimilarityArgs({ modules = ["m30", "daily"], limit = 80, m30Threshold = 0.72, dailyThreshold = 0.70, signalTime = null, planOnly = false } = {}) {
  // Run as a package module so the scanner can use the same relative imports as
  // the production AIA engine (a direct file invocation has no package context).
  const args = ["-m", "aia_engine.kline_similarity", "--db", databasePath, "--modules", modules.join(","), "--limit", String(limit), "--m30-threshold", String(m30Threshold), "--daily-threshold", String(dailyThreshold)];
  if (signalTime) args.push("--signal-time", signalTime);
  if (planOnly) args.push("--plan-only");
  return args;
}

export function planKlineSimilarity(options = {}) {
  return runPythonAlgorithm(klineSimilarityArgs({ ...options, planOnly: true }), { timeoutMs: 90_000, maximumBytes: 4 * 1024 * 1024 });
}

export function runKlineSimilarity(options = {}) {
  return runPythonAlgorithm(klineSimilarityArgs(options), { timeoutMs: 8 * 60_000, maximumBytes: 32 * 1024 * 1024 });
}

function exactSimilarityScript() {
  return join(projectDir, "python_engine", "kline_similarity_exact_task.py");
}

export function runExactKlineSimilarity({ scanId, referenceCode, start, end, period = "daily", topN = 50, visionEnabled = false } = {}) {
  const args = [exactSimilarityScript(), "scan", "--scan-id", String(scanId), "--reference-code", String(referenceCode), "--start", String(start), "--end", String(end), "--period", String(period), "--top-n", String(topN)];
  if (visionEnabled) args.push("--vision-enabled");
  return runPythonAlgorithm(args, { timeoutMs: 15 * 60_000, maximumBytes: 96 * 1024 * 1024 });
}

export function exactKlineSimilarityStatus({ force = false } = {}) {
  const args = [exactSimilarityScript(), "cache-status"];
  if (force) args.push("--force");
  return runPythonAlgorithm(args, { timeoutMs: 4 * 60_000, maximumBytes: 8 * 1024 * 1024 });
}

export function exactKlineSimilarityRuntimeStatus() {
  return runPythonAlgorithm([exactSimilarityScript(), "status"], { timeoutMs: 4 * 60_000, maximumBytes: 12 * 1024 * 1024 });
}

export function refreshExactKlineSimilarityCache({ batchSize = 120 } = {}) {
  return runPythonAlgorithm([exactSimilarityScript(), "cache-refresh", "--batch-size", String(batchSize)], { timeoutMs: 25 * 60_000, maximumBytes: 12 * 1024 * 1024 });
}

export function algorithmCapabilities() {
  return {
    python: resolveMarketPython(),
    abcd: existsSync(join(projectDir, "python_engine", "abcd_task.py")),
    aia: existsSync(join(projectDir, "engine", "python_engine", "run.py")),
    heat: existsSync(join(projectDir, "python_engine", "vendor8002", "cli.py")),
    news: existsSync(join(projectDir, "python_engine", "news_task.py")),
    aiFreshNews: existsSync(join(projectDir, "python_engine", "ai_minishare_task.py")),
    fivePlatform: existsSync(join(projectDir, "python_engine", "five_platform_task.py")),
    nightlyMarket: existsSync(join(projectDir, "python_engine", "market_sync.py")),
    chipRetrain: existsSync(join(projectDir, "python_engine", "chip_retrain_task.py")),
    preopen: existsSync(join(projectDir, "python_engine", "preopen_daily_task.py")),
    klineSimilarity: existsSync(join(projectDir, "engine", "python_engine", "aia_engine", "kline_similarity.py")),
    exactKlineSimilarity: existsSync(exactSimilarityScript()),
    modes: { abcd: "8010-original", aia: "AIA-authoritative-read-only", heat: "8002-legacy" },
  };
}
