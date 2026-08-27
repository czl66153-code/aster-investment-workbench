import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planKlineSimilarity, runKlineSimilarity } from "./algorithm_bridge.mjs";
import { projectDir } from "./core.mjs";
import { refreshAkshareM30 } from "./data_sources.mjs";

const allowedModules = new Set(["m30", "daily"]);
const migrationManifestPath = join(projectDir, "data", "kline_similarity", "migration_manifest.json");

function json(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeInput(input = {}) {
  const modules = [...new Set((Array.isArray(input.modules) ? input.modules : ["m30", "daily"]).map(String).filter((module) => allowedModules.has(module)))];
  if (!modules.length) throw new Error("至少启用一种K线形态");
  return {
    modules,
    limit: Math.max(10, Math.min(220, Math.trunc(finite(input.limit, 80)))),
    m30Threshold: Math.max(.5, Math.min(.95, finite(input.m30Threshold, .72))),
    dailyThreshold: Math.max(.5, Math.min(.95, finite(input.dailyThreshold, .70))),
    refreshIntraday: input.refreshIntraday !== false,
    signalTime: input.signalTime ? String(input.signalTime) : null,
  };
}

function scanRow(row) {
  if (!row) return null;
  return {
    scanId: row.scan_id,
    status: row.status,
    tradeDate: row.trade_date,
    signalTime: row.signal_time,
    modules: json(row.modules_json, []),
    thresholds: json(row.thresholds_json, {}),
    scopeLimit: Number(row.scope_limit),
    refreshIntraday: Boolean(row.refresh_intraday),
    sourcePolicy: json(row.source_policy_json, {}),
    coverage: json(row.coverage_json, {}),
    funnel: json(row.funnel_json, {}),
    resultCount: Number(row.result_count || 0),
    hitCount: Number(row.hit_count || 0),
    message: row.message,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function migrationSummary(db) {
  const aggregate = db.prepare(`SELECT COUNT(*) AS files,COALESCE(SUM(size_bytes),0) AS bytes,COALESCE(SUM(row_count),0) AS rows,
    COUNT(DISTINCT snapshot_date) AS snapshot_dates,MIN(snapshot_date) AS first_snapshot,MAX(snapshot_date) AS last_snapshot
    FROM kline_similarity_assets`).get();
  const modules = db.prepare(`SELECT COALESCE(module,'other') AS module,COUNT(*) AS files,COALESCE(SUM(size_bytes),0) AS bytes,COALESCE(SUM(row_count),0) AS rows
    FROM kline_similarity_assets GROUP BY COALESCE(module,'other') ORDER BY module`).all().map((row) => ({ ...row, files: Number(row.files), bytes: Number(row.bytes), rows: Number(row.rows) }));
  let manifest = null;
  if (existsSync(migrationManifestPath)) manifest = json(readFileSync(migrationManifestPath, "utf8"), null);
  return {
    verified: Boolean(manifest?.verified) && Number(aggregate.files || 0) === Number(manifest?.summary?.copied_files || 0),
    files: Number(aggregate.files || 0), bytes: Number(aggregate.bytes || 0), rows: Number(aggregate.rows || 0),
    snapshotDates: Number(aggregate.snapshot_dates || 0), firstSnapshot: aggregate.first_snapshot, lastSnapshot: aggregate.last_snapshot,
    modules, manifestGeneratedAt: manifest?.generated_at || null, sourcePackages: manifest?.source_packages || [],
  };
}

function marketStatus(db) {
  const daily = db.prepare("SELECT COUNT(*) AS rows,COUNT(DISTINCT code) AS codes,MAX(trade_date) AS as_of FROM bars_daily").get();
  const m30 = db.prepare("SELECT COUNT(*) AS rows,COUNT(DISTINCT code) AS codes,MAX(trade_time) AS as_of FROM bars_30m").get();
  const dailyDepth = db.prepare(`SELECT COUNT(*) AS codes,
    SUM(CASE WHEN bars>=5 THEN 1 ELSE 0 END) AS ma5_ready,
    SUM(CASE WHEN bars>=30 THEN 1 ELSE 0 END) AS ma30_ready,
    SUM(CASE WHEN bars>=250 THEN 1 ELSE 0 END) AS ma250_ready,
    SUM(CASE WHEN bars>=310 THEN 1 ELSE 0 END) AS ma250_rule_ready
    FROM (SELECT code,COUNT(*) AS bars FROM bars_daily GROUP BY code)`).get();
  const m30Depth = db.prepare(`SELECT COUNT(*) AS codes,
    SUM(CASE WHEN bars>=30 THEN 1 ELSE 0 END) AS score_ready,
    SUM(CASE WHEN bars>=49 THEN 1 ELSE 0 END) AS full_rule_ready
    FROM (SELECT code,COUNT(*) AS bars FROM bars_30m GROUP BY code)`).get();
  const dailySource = db.prepare("SELECT source,COUNT(*) AS rows FROM bars_daily WHERE trade_date=(SELECT MAX(trade_date) FROM bars_daily) GROUP BY source ORDER BY rows DESC").all();
  const m30Source = db.prepare("SELECT source,COUNT(*) AS rows FROM bars_30m WHERE substr(trade_time,1,10)=(SELECT substr(MAX(trade_time),1,10) FROM bars_30m) GROUP BY source ORDER BY rows DESC").all();
  return {
    daily: { rows: Number(daily.rows), codes: Number(daily.codes), asOf: daily.as_of, sources: dailySource,
      ma5Ready: Number(dailyDepth.ma5_ready || 0), ma30Ready: Number(dailyDepth.ma30_ready || 0), ma250Ready: Number(dailyDepth.ma250_ready || 0), ma250RuleReady: Number(dailyDepth.ma250_rule_ready || 0) },
    m30: { rows: Number(m30.rows), codes: Number(m30.codes), asOf: m30.as_of, sources: m30Source,
      scoreReady: Number(m30Depth.score_ready || 0), fullRuleReady: Number(m30Depth.full_rule_ready || 0) },
  };
}

export function recoverInterruptedKlineScans(db) {
  return db.prepare("UPDATE kline_similarity_scans SET status='failed',error='engine restarted before scan completed',message='扫描被服务重启中断，可安全重新执行',finished_at=CURRENT_TIMESTAMP WHERE status='running' AND json_type(modules_json)='array'").run();
}

export function createKlineSimilarityScan(db, input = {}) {
  const config = normalizeInput(input);
  const running = db.prepare("SELECT * FROM kline_similarity_scans WHERE status='running' AND json_type(modules_json)='array' ORDER BY started_at DESC LIMIT 1").get();
  if (running) return { ...scanRow(running), reused: true };
  const scanId = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare(`INSERT INTO kline_similarity_scans(scan_id,status,modules_json,thresholds_json,scope_limit,refresh_intraday,message,started_at)
    VALUES(?,'running',?,?,?,?,?,?)`).run(
      scanId, JSON.stringify(config.modules), JSON.stringify({ m30: config.m30Threshold, daily: config.dailyThreshold }),
      config.limit, config.refreshIntraday ? 1 : 0, "正在生成精确候选池", startedAt,
    );
  return { ...scanRow(db.prepare("SELECT * FROM kline_similarity_scans WHERE scan_id=?").get(scanId)), config, reused: false };
}

export async function executeKlineSimilarityScan(db, scanId, rawConfig) {
  const config = normalizeInput(rawConfig);
  try {
    const plan = await planKlineSimilarity(config);
    if (plan.status !== "planned" || !Array.isArray(plan.codes)) throw new Error(plan.error || "K线扫描候选池生成失败");
    db.prepare("UPDATE kline_similarity_scans SET trade_date=?,signal_time=?,message=? WHERE scan_id=?")
      .run(plan.trade_date || null, plan.signal_time || null, `候选池${plan.codes.length}只，正在读取K线`, scanId);

    const refreshAudit = { requested: config.refreshIntraday, batches: [], failures: [], rows: 0 };
    if (config.refreshIntraday && config.modules.includes("m30")) {
      for (let offset = 0; offset < plan.codes.length; offset += 80) {
        const codes = plan.codes.slice(offset, offset + 80);
        try {
          const result = await refreshAkshareM30(db, codes);
          refreshAudit.batches.push({ codes: codes.length, rows: Number(result.count || 0), sources: result.sources || [] });
          refreshAudit.rows += Number(result.count || 0);
          refreshAudit.failures.push(...(result.failures || []));
        } catch (error) {
          refreshAudit.batches.push({ codes: codes.length, rows: 0, error: error.message });
          refreshAudit.failures.push({ batch: offset / 80 + 1, error: error.message });
        }
      }
    }

    db.prepare("UPDATE kline_similarity_scans SET message=? WHERE scan_id=?").run("行情读取完成，正在执行30分钟与日线规则", scanId);
    const task = await runKlineSimilarity(config);
    if (task.status !== "completed" || !Array.isArray(task.results)) throw new Error(task.error || "K线扫描没有返回正式结果");
    const now = new Date().toISOString();
    const coverage = { ...(task.coverage || {}), intraday_refresh: refreshAudit };
    const insert = db.prepare(`INSERT INTO kline_similarity_results(scan_id,code,name,industry,rank,matched,best_score,combined_score,module_hits_json,payload_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM kline_similarity_results WHERE scan_id=?").run(scanId);
      for (const row of task.results) insert.run(scanId, row.code, row.name, row.industry || null, row.rank, row.matched ? 1 : 0, row.best_score, row.combined_score, JSON.stringify(row.module_hits || []), JSON.stringify(row));
      db.prepare(`UPDATE kline_similarity_scans SET status='completed',trade_date=?,signal_time=?,source_policy_json=?,coverage_json=?,funnel_json=?,
        result_count=?,hit_count=?,message=?,error=NULL,finished_at=? WHERE scan_id=?`).run(
          task.trade_date, task.signal_time, JSON.stringify(task.source_policy || {}), JSON.stringify(coverage), JSON.stringify(task.funnel || {}),
          task.results.length, Number(task.summary?.matched || 0), `完成${task.results.length}只扫描，OR命中${Number(task.summary?.matched || 0)}只`, now, scanId,
        );
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return klineSimilarityDashboard(db, { scanId, limit: config.limit });
  } catch (error) {
    db.prepare("UPDATE kline_similarity_scans SET status='failed',error=?,message='扫描失败，上一批正式结果未受影响',finished_at=? WHERE scan_id=?")
      .run(String(error.message || error), new Date().toISOString(), scanId);
    throw error;
  }
}

export function klineSimilarityDashboard(db, options = {}) {
  const requestedScanId = options.scanId ? String(options.scanId) : null;
  const row = requestedScanId
    ? db.prepare("SELECT * FROM kline_similarity_scans WHERE scan_id=?").get(requestedScanId)
    : db.prepare("SELECT * FROM kline_similarity_scans ORDER BY started_at DESC LIMIT 1").get();
  const scan = scanRow(row);
  const limit = Math.max(1, Math.min(220, Math.trunc(finite(options.limit, 50))));
  let results = [];
  if (scan?.status === "completed") {
    const matchedOnly = String(options.filter || "all") === "matched";
    const records = matchedOnly
      ? db.prepare("SELECT payload_json FROM kline_similarity_results WHERE scan_id=? AND matched=1 ORDER BY rank LIMIT ?").all(scan.scanId, limit)
      : db.prepare("SELECT payload_json FROM kline_similarity_results WHERE scan_id=? ORDER BY rank LIMIT ?").all(scan.scanId, limit);
    results = records.map((item) => json(item.payload_json, null)).filter(Boolean);
  }
  const history = db.prepare("SELECT scan_id,status,trade_date,result_count,hit_count,message,error,started_at,finished_at FROM kline_similarity_scans ORDER BY started_at DESC LIMIT 8").all().map((item) => ({
    scanId: item.scan_id, status: item.status, tradeDate: item.trade_date, resultCount: Number(item.result_count), hitCount: Number(item.hit_count), message: item.message, error: item.error, startedAt: item.started_at, finishedAt: item.finished_at,
  }));
  const templates = db.prepare("SELECT template_id,module,display_name,confidence,enabled,image_path,version,updated_at FROM template_profiles WHERE module IN ('m30','daily') ORDER BY module,updated_at DESC").all().map((item) => ({
    templateId: item.template_id, module: item.module, displayName: item.display_name, confidence: item.confidence, enabled: Boolean(item.enabled), version: item.version, updatedAt: item.updated_at,
    previewUrl: item.module === "m30" ? "/kline-similarity/m30-early-breakout-reference.png" : "/kline-similarity/daily-standard.png",
  }));
  return {
    ready: Boolean(scan), scan, results, history, templates, migration: migrationSummary(db), market: marketStatus(db),
    logic: { eligibility: "OR", copy: "30分钟或日线任一模块命中即可入选", coreRuleProtected: true, archiveUsedForSignals: false },
  };
}
