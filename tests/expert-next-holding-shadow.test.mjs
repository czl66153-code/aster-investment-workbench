import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { projectDir } from "../engine/core.mjs";

test("next-holding shadow experiment freezes five picks for all nine experts", () => {
  const temporary = mkdtempSync(join(tmpdir(), "aster-expert-shadow-"));
  const database = join(temporary, "shadow.db");
  const output = join(temporary, "output");
  try {
    const args = [
      "tools/expert_tracking_sources/run_next_holding_shadow.mjs",
      "--as-of", "2026-08-21", "--target", "2026-08-24",
      "--db", database, "--out", output, "--predict-only",
    ];
    const first = spawnSync(process.execPath, args, { cwd: projectDir, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, args, { cwd: projectDir, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    const db = new DatabaseSync(database, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shadow_runs").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shadow_experts").get().count, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shadow_predictions").get().count, 45);
    const wujiang = db.prepare("SELECT * FROM shadow_experts WHERE expert_name='乌江望月'").get();
    assert.equal(wujiang.history_days >= 30, true);
    assert.equal(wujiang.mapping_pct >= 90, true);
    const invalid = db.prepare("SELECT COUNT(*) AS count FROM shadow_predictions WHERE probability<=0 OR probability>=1 OR rank NOT BETWEEN 1 AND 5").get().count;
    assert.equal(invalid, 0);
    for (const expert of db.prepare("SELECT expert_key FROM shadow_experts").all()) {
      const probabilities = db.prepare("SELECT probability FROM shadow_predictions WHERE expert_key=? ORDER BY rank").all(expert.expert_key).map((row) => row.probability);
      assert.equal(probabilities.every((probability, index) => index === 0 || probability < probabilities[index - 1]), true);
    }
    db.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("shadow evaluator records only structurally available target-day holdings", () => {
  const temporary = mkdtempSync(join(tmpdir(), "aster-expert-shadow-eval-"));
  const database = join(temporary, "shadow.db");
  const output = join(temporary, "output");
  try {
    const predict = spawnSync(process.execPath, [
      "tools/expert_tracking_sources/run_next_holding_shadow.mjs",
      "--as-of", "2026-08-20", "--target", "2026-08-21",
      "--db", database, "--out", output, "--predict-only",
    ], { cwd: projectDir, encoding: "utf8" });
    assert.equal(predict.status, 0, predict.stderr);
    const evaluate = spawnSync(process.execPath, [
      "tools/expert_tracking_sources/run_next_holding_shadow.mjs",
      "--as-of", "2026-08-21", "--db", database, "--out", output, "--evaluate-only",
    ], { cwd: projectDir, encoding: "utf8" });
    assert.equal(evaluate.status, 0, evaluate.stderr);
    const db = new DatabaseSync(database, { readOnly: true });
    const available = db.prepare("SELECT COUNT(*) AS count FROM shadow_evaluations WHERE actual_available=1").get().count;
    const unavailable = db.prepare("SELECT COUNT(*) AS count FROM shadow_evaluations WHERE actual_available=0").get().count;
    assert.equal(available > 0, true);
    assert.equal(available + unavailable, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shadow_actuals").get().count > 0, true);
    assert.equal(["partially_evaluated", "evaluated"].includes(db.prepare("SELECT status FROM shadow_runs").get().status), true);
    db.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
