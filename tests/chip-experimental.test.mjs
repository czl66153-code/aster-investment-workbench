import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { addChipSample, chipSamples, deleteChipSample } from "../engine/core.mjs";

test("third chip model collects isolated samples without touching production registries", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("../engine/schema.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES('000001.SZ','000001','平安银行','SZ','银行')").run();
    db.prepare("INSERT INTO model_registry(scope,display_name,model_version,model_path,sample_count,ready_count,revision,applied_revision,pending_retrain,status) VALUES('formal','正式筹码模型','formal-v1','formal',0,0,1,1,0,'active')").run();
    db.prepare("INSERT INTO model_registry(scope,display_name,model_version,model_path,sample_count,ready_count,revision,applied_revision,pending_retrain,status) VALUES('candidate','候选筹码模型','candidate-v1','candidate',0,0,1,1,0,'active')").run();
    db.prepare("INSERT INTO experimental_chip_models(scope,display_name,factor_spec_json) VALUES('multi_period','多周期候选筹码模型','{}')").run();
    const initial = chipSamples(db);
    const initialThirdModel = initial.registry.find((model) => model.scope === "multi_period");
    assert.equal(initialThirdModel.positive_count, 0);
    assert.equal(initialThirdModel.negative_count, 0);
    const productionBefore = db.prepare("SELECT * FROM model_registry ORDER BY scope").all();

    const created = addChipSample(db, { scope: "multi_period", sampleLabel: 0, code: "000001.SZ", tradeDate: "2026-08-24", reason: "审查负样本" });
    assert.equal(created.scope, "multi_period");
    assert.equal(created.sampleLabel, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chip_samples").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experimental_chip_samples").get().count, 1);
    const dashboard = chipSamples(db);
    const thirdModel = dashboard.registry.find((model) => model.scope === "multi_period");
    assert.equal(thirdModel.production_enabled, 0);
    assert.equal(thirdModel.pending_retrain, 0);
    assert.equal(thirdModel.model_version, "not_trained");
    assert.equal(thirdModel.positive_count, 0);
    assert.equal(thirdModel.negative_count, 1);
    assert.deepEqual(db.prepare("SELECT * FROM model_registry ORDER BY scope").all(), productionBefore);
    deleteChipSample(db, created.sampleId);
    assert.equal(db.prepare("SELECT sample_count FROM experimental_chip_models WHERE scope='multi_period'").get().sample_count, 0);
  } finally { db.close(); }
});

test("production chip models isolate labels by model and queue nightly retraining", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("../engine/schema.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES('000001.SZ','000001','平安银行','SZ','银行')").run();
    db.prepare("INSERT INTO model_registry(scope,display_name,model_version,model_path,sample_count,ready_count,revision,applied_revision,pending_retrain,status) VALUES('formal','正式筹码模型','v1','formal',0,0,1,1,0,'active')").run();
    db.prepare("INSERT INTO model_registry(scope,display_name,model_version,model_path,sample_count,ready_count,revision,applied_revision,pending_retrain,status) VALUES('candidate','候选筹码模型','v1','candidate',0,0,1,1,0,'active')").run();
    const created = addChipSample(db, { scope: "formal", sampleLabel: 0, code: "000001.SZ", tradeDate: "2026-08-24", reason: "反例" });
    assert.equal(created.sampleLabel, 0);
    const dashboard = chipSamples(db);
    const formal = dashboard.registry.find((model) => model.scope === "formal");
    const candidate = dashboard.registry.find((model) => model.scope === "candidate");
    assert.equal(formal.positive_count, 0);
    assert.equal(formal.negative_count, 1);
    assert.equal(formal.pending_retrain, 1);
    assert.equal(candidate.sample_count, 0);
    assert.equal(dashboard.samples[0].sample_label, 0);
  } finally { db.close(); }
});
