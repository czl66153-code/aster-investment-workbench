import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectDir } from "./core.mjs";

const MANIFEST_SCHEMA = "aster.aia.authoritative.manifest.v1";
const RANKING_VERSION = "aia.top10.ranking.v6";
const DEFAULT_ROOT = join(projectDir, "data", "aia_authoritative");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifiedJson(root, relativePath, manifest) {
  const entry = manifest.files?.[relativePath.replaceAll("\\", "/")];
  if (!entry?.sha256) throw new Error(`AIA权威清单缺少文件：${relativePath}`);
  const path = resolve(root, relativePath);
  const expectedRoot = `${resolve(root)}\\`.toLowerCase();
  if (!`${path}\\`.toLowerCase().startsWith(expectedRoot)) throw new Error("AIA权威文件越出只读数据根");
  const actual = sha256(path);
  if (actual !== String(entry.sha256).toLowerCase()) throw new Error(`AIA权威文件哈希不一致：${relativePath}`);
  return readJson(path);
}

function validateBatch(batch, candidate) {
  if (batch?.status !== "pass") throw new Error(`AIA权威批次不可发布：${batch?.status || "missing"}`);
  if (batch?.ranking_version !== RANKING_VERSION) throw new Error(`AIA权威排名版本不是${RANKING_VERSION}`);
  if (!/^top10-20\d{2}-\d{2}-\d{2}-[\w-]+$/.test(String(batch?.batch_id || ""))) throw new Error("AIA权威批次ID无效");
  if (candidate?.snapshot_id !== batch?.candidate_snapshot_id) throw new Error("AIA权威候选快照引用不一致");
  if (candidate?.trade_date !== batch?.trade_date) throw new Error("AIA权威批次与候选交易日不一致");
  if (candidate?.metadata?.status !== "complete") throw new Error("AIA权威候选快照不完整");
  if (!Array.isArray(batch.items) || batch.items.length !== 10) throw new Error("AIA权威批次必须恰好包含10只股票");
  const symbols = new Set();
  batch.items.forEach((item, index) => {
    if (Number(item.rank) !== index + 1) throw new Error("AIA权威位次顺序不连续");
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(String(item.symbol || ""))) throw new Error(`AIA权威证券代码无效：${item.symbol}`);
    if (symbols.has(item.symbol)) throw new Error(`AIA权威批次存在重复股票：${item.symbol}`);
    if (!Number.isFinite(Number(item.total_score))) throw new Error(`AIA权威分数无效：${item.symbol}`);
    if (item.versions?.engine !== RANKING_VERSION) throw new Error(`AIA权威股票引擎版本不一致：${item.symbol}`);
    symbols.add(item.symbol);
  });
}

function freshness(generatedAt, synchronizedAt, now) {
  const generated = Date.parse(generatedAt);
  const synchronized = Date.parse(synchronizedAt);
  const latest = Math.max(Number.isFinite(generated) ? generated : 0, Number.isFinite(synchronized) ? synchronized : 0);
  const maxAgeMs = Math.max(60_000, Number(process.env.ASTER_AIA_AUTHORITATIVE_MAX_AGE_MS || 30 * 60_000));
  const ageMs = Math.max(0, now.getTime() - latest);
  return { status: ageMs <= maxAgeMs ? "fresh" : "stale", ageMs, maxAgeMs };
}

export function loadAuthoritativeAia({ root = process.env.ASTER_AIA_AUTHORITATIVE_ROOT || DEFAULT_ROOT, now = new Date() } = {}) {
  const resolvedRoot = resolve(root);
  const manifest = readJson(join(resolvedRoot, "AUTHORITATIVE_MANIFEST.json"));
  if (manifest.schema_version !== MANIFEST_SCHEMA) throw new Error("AIA权威同步清单版本无效");
  const batchId = String(manifest.current_batch_id || "");
  const batchRelative = `top10_batches/${batchId}.json`;
  const batch = verifiedJson(resolvedRoot, batchRelative, manifest);
  if (batch.batch_id !== batchId) throw new Error("AIA权威批次文件名与内容不一致");
  const candidateRelative = `ranking_candidates/${batch.candidate_snapshot_id}.json`;
  const candidate = verifiedJson(resolvedRoot, candidateRelative, manifest);
  validateBatch(batch, candidate);
  const state = freshness(batch.generated_at, manifest.synchronized_at, now);
  const configVersion = String(batch.items[0]?.breakdown?.ranking_config_version || batch.items[0]?.versions?.ranking || "unknown");
  const items = batch.items.map((item) => ({
    ...item,
    score: Number(item.total_score),
    pattern_hits: [...(item.matched_modules || [])],
    evidence_coverage: Number(item.breakdown?.evidence_weight_coverage || 0),
    factor_audit: item.breakdown?.factors || {},
    risk: item.risk?.status || "clear",
    authoritative_batch_id: batch.batch_id,
    authoritative_candidate_snapshot_id: batch.candidate_snapshot_id,
  }));
  return {
    ok: true,
    status: "ready_read_only",
    publishable: true,
    trade_date: batch.trade_date,
    message: state.status === "fresh"
      ? `已导入权威AIA Top10批次 ${batch.batch_id}`
      : `已导入最后一次校验通过的权威AIA Top10；同步数据已陈旧`,
    result: { model: RANKING_VERSION, trade_date: batch.trade_date, items },
    ranking: { config_version: configVersion, ranking_version: batch.ranking_version },
    meta: {
      trade_date: batch.trade_date,
      data_trade_date: candidate.trade_date,
      generated_at: batch.generated_at,
      synchronized_at: manifest.synchronized_at,
      freshness: state.status,
      stale: state.status === "stale",
      warning: state.status === "stale" ? "权威源同步已超过新鲜度阈值；未执行本地重算" : null,
    },
    authoritative: {
      mode: "read_only_consumer",
      batch_id: batch.batch_id,
      candidate_snapshot_id: batch.candidate_snapshot_id,
      ranking_config_version: configVersion,
      ranking_version: batch.ranking_version,
      factor_version: batch.items[0]?.versions?.factor || null,
      data_version: candidate.data_version || candidate.metadata?.data_version || null,
      source: manifest.source,
      synchronized_at: manifest.synchronized_at,
      freshness: state.status,
      warnings: batch.warnings || [],
    },
  };
}

export function authoritativeAiaStatus(options = {}) {
  const task = loadAuthoritativeAia(options);
  return { ...task.authoritative, trade_date: task.trade_date, item_count: task.result.items.length, items: task.result.items };
}
