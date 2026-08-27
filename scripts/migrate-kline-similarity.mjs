import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = new URL("../", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:").replaceAll("/", "\\");
const databasePath = join(projectRoot, "data", "aster.db");
const archiveRoot = join(projectRoot, "data", "kline_similarity");
const publicRoot = join(projectRoot, "public", "kline-similarity");
const sources = [
  {
    package: "machine-stock-selection-full-20260813",
    root: String.raw`E:\机器选股核心实时服务完整迁移包-20260813\data\aia\cache\history`,
    destination: join(archiveRoot, "source-20260813", "history"),
  },
  {
    package: "machine-stock-selection-sync-20260819",
    root: String.raw`E:\机器选股-20260819\data\aia\cache\history`,
    destination: join(archiveRoot, "source-20260819", "history"),
  },
];
const latestRoot = String.raw`E:\机器选股-20260819`;

function files(root) {
  const output = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else output.push(path);
    }
  };
  walk(root);
  return output.sort();
}

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function unix(path) { return relative(projectRoot, path).replaceAll("\\", "/"); }
function sourceRelative(root, path) { return relative(root, path).replaceAll("\\", "/"); }

function historyMetadata(path) {
  const name = basename(path);
  const assetModule = name.endsWith("-m30.json") ? "m30" : name.endsWith("-daily.json") ? "daily" : null;
  const snapshotDate = basename(dirname(path));
  let rowCount = null;
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const rows = Array.isArray(payload) ? payload : payload?.bars || payload?.data || payload?.items;
    rowCount = Array.isArray(rows) ? rows.length : null;
  } catch {}
  return { module: assetModule, snapshotDate, rowCount };
}

function record(sourcePackage, sourceRoot, sourcePath, localPath, sourceKind, metadata = {}) {
  const sourceHash = sha256(sourcePath);
  const localHash = sha256(localPath);
  if (sourceHash !== localHash) throw new Error(`hash mismatch: ${sourcePath}`);
  return {
    assetId: createHash("sha256").update(`${sourcePackage}|${sourceRelative(sourceRoot, sourcePath)}`).digest("hex"),
    sourcePackage,
    sourceRelativePath: sourceRelative(sourceRoot, sourcePath),
    localRelativePath: unix(localPath),
    module: metadata.module || null,
    snapshotDate: metadata.snapshotDate || null,
    sourceKind,
    sizeBytes: statSync(sourcePath).size,
    rowCount: metadata.rowCount ?? null,
    sha256: sourceHash,
  };
}

for (const source of sources) {
  if (!existsSync(source.root)) throw new Error(`missing U-drive history: ${source.root}`);
}
mkdirSync(archiveRoot, { recursive: true });
mkdirSync(publicRoot, { recursive: true });

const records = [];
for (const source of sources) {
  for (const sourcePath of files(source.root)) {
    const destination = join(source.destination, relative(source.root, sourcePath));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(sourcePath, destination);
    records.push(record(source.package, source.root, sourcePath, destination, "frozen_history", historyMetadata(sourcePath)));
  }
}

const templatesRoot = join(latestRoot, "public", "aia-templates");
for (const sourcePath of files(templatesRoot)) {
  const destination = join(publicRoot, basename(sourcePath));
  copyFileSync(sourcePath, destination);
  const assetModule = basename(sourcePath).startsWith("m30") ? "m30" : basename(sourcePath).startsWith("daily") ? "daily" : "chip";
  records.push(record("machine-stock-selection-sync-20260819", latestRoot, sourcePath, destination, "template_image", { module: assetModule }));
}

const standardManifest = join(latestRoot, "scripts", "aia", "standard_images_manifest.json");
const localStandardManifest = join(archiveRoot, "standard_images_manifest.json");
copyFileSync(standardManifest, localStandardManifest);
records.push(record("machine-stock-selection-sync-20260819", latestRoot, standardManifest, localStandardManifest, "template_manifest"));

const algorithmFiles = ["daily_shapes.py", "m30_early_breakout.py", "features.py", "matchers.py", "aggregation.py", "scanner.py", "models.py", "candles.py", "presentation.py", "template_calibration.py"];
for (const name of algorithmFiles) {
  const sourcePath = join(latestRoot, "backend", "signal_desk", "aia", "patterns", name);
  const localPath = join(projectRoot, "python_engine", "vendor_exact", "signal_desk", "aia", "patterns", name);
  if (!existsSync(localPath)) throw new Error(`missing target algorithm copy: ${localPath}`);
  records.push(record("machine-stock-selection-sync-20260819", latestRoot, sourcePath, localPath, "algorithm_source", { module: name.startsWith("m30") ? "m30" : name.startsWith("daily") ? "daily" : null }));
}

const sourceCalendar = join(latestRoot, "data", "aia", "trade_calendar.json");
const localCalendar = join(projectRoot, "engine", "models", "aia", "trade_calendar.json");
records.push(record("machine-stock-selection-sync-20260819", latestRoot, sourceCalendar, localCalendar, "trade_calendar"));

const generatedAt = new Date().toISOString();
const summary = {
  copied_files: records.length,
  bytes: records.reduce((sum, item) => sum + item.sizeBytes, 0),
  history_rows: records.reduce((sum, item) => sum + Number(item.rowCount || 0), 0),
  m30_files: records.filter((item) => item.module === "m30" && item.sourceKind === "frozen_history").length,
  daily_files: records.filter((item) => item.module === "daily" && item.sourceKind === "frozen_history").length,
  hash_mismatches: 0,
};
const sourcePackages = sources.map((source) => ({
  package: source.package,
  source: source.root,
  files: records.filter((item) => item.sourcePackage === source.package && item.sourceKind === "frozen_history").length,
  bytes: records.filter((item) => item.sourcePackage === source.package && item.sourceKind === "frozen_history").reduce((sum, item) => sum + item.sizeBytes, 0),
}));
const manifest = { schema_version: "aster.kline-similarity.migration.v1", generated_at: generatedAt, verified: true, source_packages: sourcePackages, summary };
writeFileSync(join(archiveRoot, "migration_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const db = new DatabaseSync(databasePath);
db.exec(readFileSync(join(projectRoot, "engine", "schema.sql"), "utf8"));
const upsert = db.prepare(`INSERT INTO kline_similarity_assets(asset_id,source_package,source_relative_path,local_relative_path,module,snapshot_date,source_kind,size_bytes,row_count,sha256,verified_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_package,source_relative_path) DO UPDATE SET local_relative_path=excluded.local_relative_path,module=excluded.module,snapshot_date=excluded.snapshot_date,source_kind=excluded.source_kind,size_bytes=excluded.size_bytes,row_count=excluded.row_count,sha256=excluded.sha256,verified_at=excluded.verified_at`);
db.exec("BEGIN IMMEDIATE");
try {
  for (const item of records) upsert.run(item.assetId, item.sourcePackage, item.sourceRelativePath, item.localRelativePath, item.module, item.snapshotDate, item.sourceKind, item.sizeBytes, item.rowCount, item.sha256, generatedAt);
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
db.exec("PRAGMA optimize");
db.close();

console.log(JSON.stringify({ ok: true, manifest: unix(join(archiveRoot, "migration_manifest.json")), summary, source_packages: sourcePackages }, null, 2));
