import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthoritativeAia } from "../engine/aia_authoritative.mjs";

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aster-aia-authoritative-"));
  mkdirSync(join(root, "top10_batches"));
  mkdirSync(join(root, "ranking_candidates"));
  const batchId = "top10-2026-08-25-test-authoritative";
  const snapshotId = "candidate-2026-08-25-test-authoritative";
  const items = Array.from({ length: 10 }, (_, index) => ({
    rank: index + 1,
    symbol: `${String(600001 + index).padStart(6, "0")}.SH`,
    name: `测试${index + 1}`,
    total_score: 90 - index,
    matched_modules: ["chip"],
    breakdown: { ranking_config_version: "aia.ranking.test", evidence_weight_coverage: 1, factors: {} },
    risk: { status: "clear", penalty: 0, reasons: [] },
    versions: { engine: "aia.top10.ranking.v6", ranking: "aia.ranking.test", factor: "scanner.features.v1" },
  }));
  const batch = { batch_id: batchId, trade_date: "2026-08-25", status: "pass", generated_at: "2026-08-25T15:20:00+08:00", items, warnings: [], audit: [], ranking_version: "aia.top10.ranking.v6", candidate_snapshot_id: snapshotId };
  const candidate = { snapshot_id: snapshotId, data_version: "quotes.test", trade_date: "2026-08-25", created_at: "2026-08-25T15:19:00+08:00", metadata: { status: "complete", data_version: "quotes.test" }, candidates: [] };
  const batchRelative = `top10_batches/${batchId}.json`;
  const candidateRelative = `ranking_candidates/${snapshotId}.json`;
  const batchPath = join(root, batchRelative);
  const candidatePath = join(root, candidateRelative);
  writeFileSync(batchPath, JSON.stringify(batch));
  writeFileSync(candidatePath, JSON.stringify(candidate));
  writeFileSync(join(root, "AUTHORITATIVE_MANIFEST.json"), JSON.stringify({
    schema_version: "aster.aia.authoritative.manifest.v1",
    source: "test-read-only-source",
    synchronized_at: "2026-08-25T15:21:00+08:00",
    current_batch_id: batchId,
    files: {
      [batchRelative]: { sha256: hash(batchPath) },
      [candidateRelative]: { sha256: hash(candidatePath) },
    },
  }));
  return { root, batchPath, batchId, snapshotId };
}

test("authoritative AIA adapter preserves source order, scores and IDs without reranking", () => {
  const data = fixture();
  try {
    const task = loadAuthoritativeAia({ root: data.root, now: new Date("2026-08-25T15:25:00+08:00") });
    assert.equal(task.status, "ready_read_only");
    assert.equal(task.publishable, true);
    assert.equal(task.authoritative.batch_id, data.batchId);
    assert.equal(task.authoritative.candidate_snapshot_id, data.snapshotId);
    assert.deepEqual(task.result.items.map((item) => item.score), [90, 89, 88, 87, 86, 85, 84, 83, 82, 81]);
    assert.deepEqual(task.result.items.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(task.meta.freshness, "fresh");
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("authoritative AIA adapter rejects a tampered batch and never falls back to local ranking", () => {
  const data = fixture();
  try {
    writeFileSync(data.batchPath, "{}", "utf8");
    assert.throws(() => loadAuthoritativeAia({ root: data.root }), /哈希不一致/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
