import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { archiveScheduledScreener, ensureScheduledScreenerSchedule, runDueScheduledScreeners, runScheduledScreener, saveScheduledScreener, scheduledScreenerDashboard } from "../engine/scheduled_screener.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../engine/schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES('000001.SZ','000001','平安银行','SZ','银行')").run();
  db.prepare(`INSERT INTO factor_snapshot(code,trade_date,name,industry,close,pct_chg,amount,turnover_rate,volume_ratio_20,ret_5d,ret_10d,ret_20d,ret_30d,
    stock_ret_5d_rank,stock_ret_10d_rank,stock_ret_30d_rank,stock_top50_5_10_30,sector_ret_5d,sector_ret_5d_rank,sector_ret_5d_rank_pct,
    bigquant_heat_score,bigquant_heat_rank,bigquant_heat_rank_pct,bigquant_heat_date)
    VALUES('000001.SZ','2026-08-24','平安银行','银行',12,1,1000000,2,1.5,.1,.12,.2,.3,10,11,12,1,.08,3,5,99,8,.2,'2026-08-24')`).run();
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES('formal_daily','formal-test','2026-08-24',1,'a','published','bigquant+tushare',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES('factor_snapshot','factor-test','2026-08-24',1,'b','published','formal_factor',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO dataset_dependencies(child_dataset_key,child_version_id,parent_dataset_key,parent_version_id,relation_type) VALUES('factor_snapshot','factor-test','formal_daily','formal-test','derived_from')").run();
  ensureScheduledScreenerSchedule(db);
  return db;
}

test("saved screener rules generate immutable manual and scheduled candidate batches", () => {
  const db = database();
  try {
    saveScheduledScreener(db, {
      name: "早盘交集候选", ruleTag: "突破", enabled: true, runTime: "08:10", limit: 10,
      config: { filters: [{ key: "close", operator: ">=", value: 1 }], weights: { close: 100 }, weightDirections: { close: "desc" }, sort: { key: "composite_score", direction: "desc" } },
    });
    const first = runScheduledScreener(db, undefined, "manual", "2026-08-25");
    const second = runScheduledScreener(db, undefined, "manual", "2026-08-25");
    assert.equal(first.status, "published");
    assert.equal(first.rows.length, 1);
    assert.notEqual(first.batchId, second.batchId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM screener_candidate_batches").get().count, 2);
    const scheduled = runDueScheduledScreeners(db, { isTradingDate: () => true, now: new Date("2026-08-25T01:00:00Z") });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].status, "published");
    const dashboard = scheduledScreenerDashboard(db);
    assert.equal(dashboard.strategy.runTime, "08:10");
    assert.equal(dashboard.strategy.ruleTag, "突破");
    assert.equal(dashboard.strategies.length, 1);
    assert.equal(dashboard.latestPublished.rows[0].code, "000001.SZ");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM screener_candidate_batches").get().count, 3);
  } finally { db.close(); }
});

test("multiple named rules remain independent and experimental model cannot publish stale results", () => {
  const db = database();
  try {
    saveScheduledScreener(db, {
      strategyId: "daily-breakout", name: "突破规则", ruleTag: "突破", enabled: true,
      config: { filters: [{ key: "close", operator: ">=", value: 1 }], weights: { close: 10 }, weightDirections: { close: "desc" }, sort: { key: "composite_score", direction: "desc" } },
    });
    saveScheduledScreener(db, {
      strategyId: "daily-low-risk", name: "低回撤规则", ruleTag: "低回撤", enabled: false,
      config: { filters: [{ key: "ret_20d", operator: ">=", value: 0 }], weights: { ret_20d: 10 }, weightDirections: { ret_20d: "desc" }, sort: { key: "composite_score", direction: "desc" } },
    });
    const dashboard = scheduledScreenerDashboard(db, "daily-low-risk");
    assert.equal(dashboard.strategy.strategyId, "daily-low-risk");
    assert.equal(dashboard.strategies.length, 2);
    assert.equal(runScheduledScreener(db, "daily-breakout", "manual", "2026-08-26").status, "published");
    saveScheduledScreener(db, {
      strategyId: "daily-experimental", name: "待建模型规则", ruleTag: "实验", enabled: false,
      config: { filters: [{ key: "multi_period_model_score", operator: ">=", value: 0 }], weights: {}, sort: { key: "multi_period_model_score", direction: "desc" } },
    });
    const rejected = runScheduledScreener(db, "daily-experimental", "manual", "2026-08-26");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rows.length, 0);
    assert.match(rejected.message, /尚未完成正样本夜间训练/);
    assert.equal(db.prepare("SELECT status FROM screener_candidate_batches WHERE strategy_id='daily-breakout'").get().status, "published");
    archiveScheduledScreener(db, "daily-low-risk");
    assert.equal(scheduledScreenerDashboard(db).strategies.some((item) => item.strategyId === "daily-low-risk"), false);
    assert.equal(db.prepare("SELECT archived_at FROM saved_screener_strategies WHERE strategy_id='daily-low-risk'").get().archived_at != null, true);
  } finally { db.close(); }
});
