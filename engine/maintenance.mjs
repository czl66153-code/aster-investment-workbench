import { randomUUID } from "node:crypto";

function shanghaiParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function dateKey(parts) { return `${parts.year}-${parts.month}-${parts.day}`; }

function shiftDate(value, days) {
  const date = new Date(`${value}T04:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousWeekday(value, includeDate = false) {
  let cursor = includeDate ? value : shiftDate(value, -1);
  for (let index = 0; index < 10; index += 1) {
    const weekday = new Date(`${cursor}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return cursor;
    cursor = shiftDate(cursor, -1);
  }
  return cursor;
}

function metadata(db, key, value) {
  db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .run(key, String(value));
}

export function upsertOpenAlert(db, { severity = "warning", source, title, message }) {
  const existing = db.prepare("SELECT alert_id FROM alerts WHERE source=? AND title=? AND status='open' ORDER BY created_at DESC LIMIT 1").get(source, title);
  if (existing) {
    db.prepare("UPDATE alerts SET severity=?,message=? WHERE alert_id=?").run(severity, message, existing.alert_id);
    return existing.alert_id;
  }
  const alertId = randomUUID();
  db.prepare("INSERT INTO alerts(alert_id,severity,source,title,message,status,created_at) VALUES(?,?,?,?,?,'open',?)")
    .run(alertId, severity, source, title, message, new Date().toISOString());
  return alertId;
}

export function resolveOpenAlert(db, source, title) {
  return Number(db.prepare("UPDATE alerts SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE source=? AND title=? AND status='open'").run(source, title).changes || 0);
}

export function recordAcquisitionBatch(db, input) {
  const now = new Date().toISOString();
  const batchId = input.batchId || `${input.datasetKey}-${input.tradeDate || "na"}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO data_acquisition_batches(batch_id,dataset_key,provider_key,session_type,trade_date,as_of,row_count,checksum,status,storage_layer,metadata_json,started_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(batch_id) DO UPDATE SET row_count=excluded.row_count,checksum=excluded.checksum,status=excluded.status,storage_layer=excluded.storage_layer,metadata_json=excluded.metadata_json,completed_at=excluded.completed_at`)
    .run(batchId, input.datasetKey, input.providerKey, input.sessionType, input.tradeDate || null, input.asOf || now,
      Number(input.rowCount || 0), input.checksum || null, input.status || "published", input.storageLayer || "sqlite",
      JSON.stringify(input.metadata || {}), input.startedAt || now, input.completedAt || now);
  return batchId;
}

export function linkDatasetVersion(db, childDataset, childVersion, parentDataset, parentVersion, relationType = "derived_from") {
  if (!childVersion || !parentVersion) return false;
  db.prepare(`INSERT OR IGNORE INTO dataset_dependencies(child_dataset_key,child_version_id,parent_dataset_key,parent_version_id,relation_type,created_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)`).run(childDataset, childVersion, parentDataset, parentVersion, relationType);
  return true;
}

export function latestPublishedVersion(db, datasetKey) {
  return db.prepare("SELECT * FROM dataset_versions WHERE dataset_key=? AND status='published' ORDER BY created_at DESC LIMIT 1").get(datasetKey) || null;
}

export function pruneOperationalHistory(db, retentionDays = 30) {
  const days = Math.max(7, Math.min(365, Number(retentionDays) || 30));
  const deleted = {};
  deleted.quality = Number(db.prepare(`DELETE FROM data_quality_checks WHERE checked_at<datetime('now',?)`).run(`-${days} days`).changes || 0);
  deleted.clientErrors = Number(db.prepare(`DELETE FROM client_error_events WHERE created_at<datetime('now',?)`).run(`-${days} days`).changes || 0);
  deleted.resolvedAlerts = Number(db.prepare(`DELETE FROM alerts WHERE status='resolved' AND resolved_at<datetime('now',?)`).run(`-${days} days`).changes || 0);
  deleted.jobs = Number(db.prepare(`DELETE FROM sync_jobs WHERE status IN ('success','failed','interrupted') AND finished_at<datetime('now',?)`).run(`-${days} days`).changes || 0);
  deleted.maintenance = Number(db.prepare("DELETE FROM maintenance_events WHERE created_at<datetime('now','-180 days')").run().changes || 0);
  return deleted;
}

function enforceSourceGovernance(db) {
  const invalid = db.prepare(`SELECT f.version_id,f.trade_date,f.source FROM dataset_versions f
    WHERE f.dataset_key='factor_snapshot' AND f.status='published'
      AND NOT EXISTS (
        SELECT 1 FROM dataset_dependencies d
        JOIN dataset_versions p ON p.dataset_key=d.parent_dataset_key AND p.version_id=d.parent_version_id
        WHERE d.child_dataset_key=f.dataset_key AND d.child_version_id=f.version_id
          AND d.parent_dataset_key='formal_daily' AND p.status='published'
          AND p.source LIKE '%bigquant%' AND p.source LIKE '%tushare%'
          AND p.trade_date=f.trade_date
      )`).all();
  for (const row of invalid) {
    db.prepare("UPDATE dataset_versions SET status='rejected' WHERE dataset_key='factor_snapshot' AND version_id=?").run(row.version_id);
    recordMaintenanceEvent(db, "source_governance_rejection", "critical", "rejected", row.trade_date,
      `因子版本${row.version_id}没有可验证的BigQuant+Tushare正式日线血缘，已停止用于新推荐`, { source: row.source, versionId: row.version_id });
  }
  if (invalid.length) upsertOpenAlert(db, { severity: "critical", source: "source_governance", title: "正式因子数据源不合规", message: `已隔离${invalid.length}个无法证明BigQuant+Tushare双源血缘的因子版本；历史数据保留，新推荐暂停到正式双源更新成功。` });
  return invalid.length;
}

function deduplicateOpenAlerts(db) {
  const duplicates = db.prepare(`SELECT source,title,COUNT(*) AS count FROM alerts WHERE status='open' GROUP BY source,title HAVING COUNT(*)>1`).all();
  let resolved = 0;
  for (const item of duplicates) {
    const rows = db.prepare("SELECT alert_id FROM alerts WHERE status='open' AND source=? AND title=? ORDER BY created_at DESC").all(item.source, item.title);
    for (const row of rows.slice(1)) resolved += Number(db.prepare("UPDATE alerts SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE alert_id=?").run(row.alert_id).changes || 0);
  }
  return resolved;
}

function recordMaintenanceEvent(db, type, severity, status, eventDate, message, details = {}) {
  const existing = db.prepare("SELECT event_id FROM maintenance_events WHERE event_type=? AND event_date=? ORDER BY created_at DESC LIMIT 1").get(type, eventDate || "");
  if (existing) return existing.event_id;
  const id = randomUUID();
  db.prepare("INSERT INTO maintenance_events(event_id,event_type,severity,status,event_date,message,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, type, severity, status, eventDate || null, message, JSON.stringify(details), new Date().toISOString());
  return id;
}

export function runStartupMaintenance(db) {
  const now = new Date();
  const parts = shanghaiParts(now);
  const today = dateKey(parts);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = !["Sat", "Sun"].includes(parts.weekday);
  const priorHeartbeat = db.prepare("SELECT last_heartbeat_at FROM watchdog_heartbeats WHERE service_key='scheduler'").get()?.last_heartbeat_at || null;
  const gapSeconds = priorHeartbeat ? Math.max(0, Math.round((Date.now() - Date.parse(priorHeartbeat)) / 1000)) : null;
  const interrupted = Number(db.prepare("UPDATE sync_jobs SET status='interrupted',message=CASE WHEN length(trim(coalesce(message,'')))>0 THEN message||'；服务重启后标记为中断' ELSE '服务重启后标记为中断' END,finished_at=? WHERE status='running'").run(now.toISOString()).changes || 0);
  const rejectedFactors = enforceSourceGovernance(db);
  const deduplicatedAlerts = deduplicateOpenAlerts(db);
  if (interrupted) upsertOpenAlert(db, { source: "startup_recovery", title: "中断任务已收敛", message: `服务启动时发现${interrupted}个未完成任务，已标记为中断并允许调度器重新执行。` });
  else resolveOpenAlert(db, "startup_recovery", "中断任务已收敛");
  if (gapSeconds != null && gapSeconds > 600) {
    recordMaintenanceEvent(db, "service_downtime", "warning", "recovered", today, `检测到服务中断约${Math.round(gapSeconds / 60)}分钟`, { priorHeartbeat, recoveredAt: now.toISOString(), gapSeconds });
  }
  if (weekday && minutes > 9 * 60 + 14 && !db.prepare("SELECT 1 FROM preopen_daily_summaries WHERE summary_date=?").get(today)) {
    recordMaintenanceEvent(db, "missed_preopen", "warning", "missed", today, "服务错过08:20—09:14盘前生成窗口；不伪造历史盘前结果", { detectedAt: now.toISOString() });
  }
  if (weekday && minutes > 9 * 60 + 40 && !db.prepare("SELECT 1 FROM forward_cohorts WHERE entry_trade_date=? AND account_key IN ('aia','heat')").get(today)) {
    recordMaintenanceEvent(db, "missed_forward_open", "warning", "missed", today, "服务错过AIA/热度账户开盘成交窗口；按审计规则不补造成交", { detectedAt: now.toISOString() });
  }
  const targetOfficialDate = previousWeekday(today, weekday && minutes >= 16 * 60 + 30);
  const formal = latestPublishedVersion(db, "formal_daily");
  const officialCatchUpRequired = !formal?.trade_date || formal.trade_date < targetOfficialDate;
  if (officialCatchUpRequired) metadata(db, "recovery_official_target", targetOfficialDate);
  else db.prepare("DELETE FROM metadata WHERE key='recovery_official_target'").run();
  const latestBackup = db.prepare("SELECT created_at FROM backup_registry WHERE status='verified' ORDER BY created_at DESC LIMIT 1").get()?.created_at || null;
  const backupCatchUpRequired = !latestBackup || Date.now() - Date.parse(latestBackup) > 36 * 60 * 60 * 1000;
  if (backupCatchUpRequired) metadata(db, "recovery_backup_due", "true");
  const deleted = pruneOperationalHistory(db, 30);
  metadata(db, "startup_recovery_last_run", now.toISOString());
  metadata(db, "startup_recovery_status", JSON.stringify({ interrupted, rejectedFactors, deduplicatedAlerts, gapSeconds, officialCatchUpRequired, targetOfficialDate, backupCatchUpRequired, deleted }));
  return { interrupted, rejectedFactors, deduplicatedAlerts, gapSeconds, officialCatchUpRequired, targetOfficialDate, backupCatchUpRequired, deleted };
}
