import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { projectDir } from "./core.mjs";
import { runExactKlineSimilarity } from "./algorithm_bridge.mjs";

const dataRoot = join(projectDir, "data");
const jobRoot = join(dataRoot, "similarity", "jobs");
const resultRoot = join(dataRoot, "similarity", "results");
const ratingPath = join(dataRoot, "similarity", "ratings.json");
const migrationPath = join(dataRoot, "similarity", "migration_manifest.json");

function parse(value, fallback = null) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function envelope(data, warnings = []) {
  return { data, meta: { request_id: randomUUID(), warnings }, error: null };
}

function normalizedInput(input = {}) {
  const referenceCode = String(input.reference_code || input.referenceCode || "").trim().split(".", 1)[0];
  const start = String(input.start || "").trim();
  const end = String(input.end || "").trim();
  const period = String(input.period || "daily");
  const topN = Math.max(1, Math.min(50, Math.trunc(Number(input.top_n ?? input.topN ?? 50))));
  if (!/^\d{6}$/.test(referenceCode)) throw new Error("参考股票代码必须是6位数字");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(start) || !/^20\d{2}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("参考区间无效");
  if (!new Set(["daily", "m30"]).has(period)) throw new Error("比较周期只支持日线或30分钟线");
  return { referenceCode, start, end, period, topN, visionEnabled: input.vision_enabled === true || input.visionEnabled === true };
}

function exactConfig(row) {
  const config = parse(row?.modules_json, {});
  return config?.mode === "reference_similarity" ? config : null;
}

function exactScanRow(row) {
  if (!row) return null;
  const config = exactConfig(row);
  if (!config) return null;
  return {
    scan_id: row.scan_id,
    status: row.status,
    processed: Number((parse(row.coverage_json, {}) || {}).processed || 0),
    total: Number((parse(row.coverage_json, {}) || {}).total || 0),
    missing: Number((parse(row.coverage_json, {}) || {}).missing || 0),
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
    ...config,
  };
}

function readJob(scanId) {
  const path = join(jobRoot, `${scanId}.json`);
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8"), {}) || {};
}

function atomicJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
  renameSync(temporary, path);
}

export function recoverInterruptedReferenceSimilarityScans(db) {
  return db.prepare(`UPDATE kline_similarity_scans SET status='failed',error='engine restarted before exact similarity scan completed',
    message='相似走势扫描被服务重启中断，可安全重新执行',finished_at=CURRENT_TIMESTAMP
    WHERE status='running' AND json_extract(modules_json,'$.mode')='reference_similarity'`).run();
}

export function createReferenceSimilarityScan(db, rawInput = {}) {
  const config = normalizedInput(rawInput);
  const running = db.prepare(`SELECT * FROM kline_similarity_scans
    WHERE status='running' AND json_extract(modules_json,'$.mode')='reference_similarity'
    ORDER BY started_at DESC LIMIT 1`).get();
  if (running) return envelope({ ...exactScanRow(running), reused: true });
  const scanId = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare(`INSERT INTO kline_similarity_scans(scan_id,status,modules_json,thresholds_json,scope_limit,refresh_intraday,message,started_at)
    VALUES(?,'running',?,'{}',?,0,?,?)`).run(
      scanId,
      JSON.stringify({ mode: "reference_similarity", ...config }),
      config.topN,
      "已进入当前相似走势全市场扫描队列",
      startedAt,
    );
  return envelope({ scan_id: scanId, status: "queued", reused: false });
}

export async function executeReferenceSimilarityScan(db, scanId) {
  const row = db.prepare("SELECT * FROM kline_similarity_scans WHERE scan_id=?").get(scanId);
  const config = exactConfig(row);
  if (!config) throw new Error("相似走势扫描任务不存在");
  try {
    const task = await runExactKlineSimilarity({ scanId, ...config });
    const current = db.prepare("SELECT status FROM kline_similarity_scans WHERE scan_id=?").get(scanId);
    if (current?.status === "cancelled") return referenceSimilarityProgress(db, scanId);
    if (task.status !== "completed" || !task.result?.data) throw new Error(task.error || "精确相似度引擎未返回结果");
    const data = task.result.data;
    const items = Array.isArray(data.items) ? data.items : [];
    const progress = data.progress || {};
    const sourcePolicy = {
      mode: "u_disk_exact_reference_similarity",
      result_path: task.result_path,
      daily: "Aster BigQuant+Tushare formal warehouse; migrated cache is historical fallback only",
      m30: "Aster AKShare 30m/5m warehouse; migrated cache is historical fallback only",
      cache_root: "data/aia/cache/similarity_kline",
      feature_root: "data/aia/cache/similarity_features",
    };
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO kline_similarity_results(scan_id,code,name,industry,rank,matched,best_score,combined_score,module_hits_json,payload_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const knownSecurity = db.prepare("SELECT 1 AS ok FROM securities WHERE code=?");
    const securityBySymbol = db.prepare("SELECT code FROM securities WHERE substr(code,1,6)=? ORDER BY code LIMIT 1");
    let mirroredItems = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM kline_similarity_results WHERE scan_id=?").run(scanId);
      items.forEach((item, index) => {
        const score = Number(item.similarity || 0);
        const rawCode = String(item.code || item.ticker || "").split(".", 1)[0].padStart(6, "0");
        const proposed = String(item.ticker || "").toUpperCase();
        const securityCode = (proposed && knownSecurity.get(proposed) ? proposed : securityBySymbol.get(rawCode)?.code) || null;
        // The U-drive universe intentionally contains indices and B shares as
        // valid shape candidates.  Keep all of them in the canonical gzipped
        // result, while mirroring only codes present in Aster's A-share master
        // table so this compatibility index cannot reject the whole Top50.
        if (!securityCode || !knownSecurity.get(securityCode)) return;
        insert.run(scanId, securityCode, item.name || item.code, null, index + 1, 1, score / 100, score / 100, JSON.stringify([config.period]), JSON.stringify(item));
        mirroredItems += 1;
      });
      db.prepare(`UPDATE kline_similarity_scans SET status='completed',trade_date=?,signal_time=?,source_policy_json=?,coverage_json=?,funnel_json=?,
        result_count=?,hit_count=?,message=?,error=NULL,finished_at=? WHERE scan_id=?`).run(
          data.reference?.data_asof ? String(data.reference.data_asof).slice(0, 10) : config.end,
          now,
          JSON.stringify(sourcePolicy),
          JSON.stringify({ ...data.data_quality, processed: progress.processed, total: progress.total, missing: progress.missing, canonical_result_rows: mirroredItems, excluded_non_master_rows: items.length - mirroredItems }),
          JSON.stringify(data.prefilter || {}),
          mirroredItems,
          mirroredItems,
          `完成全市场相似走势扫描，返回Top ${mirroredItems}`,
          now,
          scanId,
        );
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return task.result;
  } catch (error) {
    const current = db.prepare("SELECT status FROM kline_similarity_scans WHERE scan_id=?").get(scanId);
    if (current?.status !== "cancelled") db.prepare("UPDATE kline_similarity_scans SET status='failed',error=?,message='扫描失败；已有缓存和历史结果均未删除',finished_at=? WHERE scan_id=?")
      .run(String(error.message || error), new Date().toISOString(), scanId);
    throw error;
  }
}

export function referenceSimilarityProgress(db, scanId) {
  const row = db.prepare("SELECT * FROM kline_similarity_scans WHERE scan_id=?").get(scanId);
  const scan = exactScanRow(row);
  if (!scan) throw new Error("similarity_scan_not_found");
  const job = readJob(scanId);
  const total = Number(job.total || scan.total || 0);
  const workTotal = Number(job.work_total || total || 0);
  const processed = Number(job.processed || scan.processed || 0);
  return envelope({
    ...scan,
    ...job,
    status: row.status === "running" ? (job.status || "running") : row.status,
    total,
    work_total: workTotal,
    processed,
    percent: Number.isFinite(Number(job.percent)) ? Number(job.percent) : workTotal ? Math.round(Math.min(processed, workTotal) / workTotal * 1000) / 10 : 0,
  });
}

export function referenceSimilarityResult(db, scanId) {
  const row = db.prepare("SELECT * FROM kline_similarity_scans WHERE scan_id=?").get(scanId);
  const scan = exactScanRow(row);
  if (!scan) throw new Error("similarity_scan_not_found");
  if (row.status !== "completed") throw new Error("similarity_scan_not_completed");
  const path = join(resultRoot, `${scanId}.json.gz`);
  if (!existsSync(path)) throw new Error("similarity_scan_result_missing");
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
}

export function latestReferenceSimilarityResult(db) {
  const rows = db.prepare(`SELECT * FROM kline_similarity_scans
    WHERE status='completed' ORDER BY finished_at DESC LIMIT 100`).all();
  const row = rows.find((candidate) => exactConfig(candidate) && existsSync(join(resultRoot, `${candidate.scan_id}.json.gz`)));
  return row ? referenceSimilarityResult(db, row.scan_id) : envelope(null, ["similarity_scan_missing"]);
}

export function cancelReferenceSimilarityScan(db, scanId) {
  const row = db.prepare("SELECT * FROM kline_similarity_scans WHERE scan_id=?").get(scanId);
  if (!exactConfig(row)) throw new Error("similarity_scan_not_found");
  mkdirSync(jobRoot, { recursive: true });
  writeFileSync(join(jobRoot, `${scanId}.cancel`), new Date().toISOString(), "utf8");
  if (["running", "queued"].includes(row.status)) db.prepare("UPDATE kline_similarity_scans SET status='cancelled',message='用户已取消扫描',finished_at=? WHERE scan_id=?").run(new Date().toISOString(), scanId);
  return envelope({ scan_id: scanId, status: "cancelled" });
}

export function saveReferenceSimilarityRating(input = {}) {
  const candidateCode = String(input.candidate_code || "").trim();
  const referenceCode = String(input.reference_code || "").trim();
  const period = String(input.period || "daily");
  const score = Number(input.score);
  if (!/^\d{6}$/.test(candidateCode) || !/^\d{6}$/.test(referenceCode) || !new Set(["daily", "m30"]).has(period) || !Number.isInteger(score) || score < 0 || score > 10) throw new Error("invalid_similarity_rating");
  const values = existsSync(ratingPath) ? parse(readFileSync(ratingPath, "utf8"), {}) : {};
  const key = `${referenceCode}:${period}:${candidateCode}`;
  values[key] = score;
  atomicJson(ratingPath, values);
  return envelope({ key, score, saved_at: new Date().toISOString() });
}

export function referenceSimilarityStatus(runtimeStatus) {
  let migration = null;
  if (existsSync(migrationPath)) migration = parse(readFileSync(migrationPath, "utf8"), null);
  return envelope({ ...runtimeStatus, migration });
}

export function referenceSimilarityCacheStatus(cacheStatus) {
  return envelope(cacheStatus);
}
