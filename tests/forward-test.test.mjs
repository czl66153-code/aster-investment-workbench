import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureForwardTest, openForwardCohorts, closeDueForwardCohorts, forwardDashboard, lockForwardSignalSnapshot, saveForwardExecutionQuotes, verifyForwardAudit, voidForwardCohort } from "../engine/forward_test.mjs";
import { getRecommendations, persistAbcdFactorScores, publishAlgorithmTask } from "../engine/core.mjs";

function fixture({ executionCodes = null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  ensureForwardTest(db, { startDate: "2026-08-21" });
  const securities = [
    ["000001.SZ", "000001", "平安银行"], ["000002.SZ", "000002", "万科A"], ["000333.SZ", "000333", "美的集团"],
    ["600000.SH", "600000", "浦发银行"], ["600036.SH", "600036", "招商银行"], ["600519.SH", "600519", "贵州茅台"],
  ];
  const insertSecurity = db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES(?,?,?,'主板','测试')");
  securities.forEach((row) => insertSecurity.run(...row));
  const batches = { abcd: "abcd-1", aia: "aia-1", heat: "heat-1" };
  const batchInsert = db.prepare("INSERT INTO recommendation_batches(batch_id,model_key,trade_date,status,trigger_type,source_mode,item_count,started_at,finished_at) VALUES(?,?,?,'published','forward_0945','test',3,?,?)");
  const recommendationInsert = db.prepare("INSERT INTO recommendations(batch_id,model_key,trade_date,code,rank,score,reason,risk,confidence,payload_json,generated_at) VALUES(?,?,?,?,?,?,?,'测试风险',.8,'{}',?)");
  const modelCodes = {
    abcd: ["000001.SZ", "000002.SZ", "000333.SZ"],
    aia: ["000001.SZ", "600000.SH", "600036.SH"],
    heat: ["000001.SZ", "000002.SZ", "600519.SH"],
  };
  for (const [model, batchId] of Object.entries(batches)) {
    batchInsert.run(batchId, model, "2026-08-21", "2026-08-21T01:45:00Z", "2026-08-21T01:45:10Z");
    modelCodes[model].forEach((code, index) => recommendationInsert.run(batchId, model, "2026-08-21", code, index + 1, 90 - index, "测试推荐", "2026-08-21T01:45:10Z"));
  }
  const quote = db.prepare("INSERT INTO realtime_quotes(code,name,price,open_price,quote_time,source,received_at) VALUES(?,?,?,?,'2026-08-21 09:45:10','akshare_eastmoney','2026-08-21T01:45:12Z')");
  securities.forEach((row, index) => quote.run(row[0], row[2], 10 + index, 9 + index));
  lockForwardSignalSnapshot(db, { accountKey: "abcd", tradeDate: "2026-08-21", signalBucket: "2026-08-21 09:45:00", status: "ready", recommendationBatchId: batches.abcd, sourceAsOf: "2026-08-21T09:45:10+08:00", generatedAt: "2026-08-21T01:55:00Z", createdAt: "2026-08-21T01:55:00Z", payload: { fixture: true } });
  saveForwardExecutionQuotes(db, { tradeDate: "2026-08-21", prices: securities.filter((row) => !executionCodes || executionCodes.includes(row[0])).map((row, index) => ({ code: row[0], price: 10.5 + index, prev_close: 10 + index, source: "akshare_sina_minute", source_as_of: "2026-08-21T09:50:00+08:00" })), capturedAt: "2026-08-21T02:00:00Z" });
  return { db, batches, securities };
}

test("four forward accounts open once and consensus takes top five", () => {
  const { db, batches } = fixture();
  const first = openForwardCohorts(db, { tradeDate: "2026-08-21", batches, openedAt: "2026-08-21T01:45:15Z" });
  assert.equal(first.status, "completed");
  assert.equal(first.accounts.length, 4);
  assert.ok(first.accounts.every((row) => row.status === "open"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_cohorts WHERE status='open'").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_trades WHERE side='BUY' AND account_key='consensus'").get().count, 5);
  const duplicate = openForwardCohorts(db, { tradeDate: "2026-08-21", batches });
  assert.ok(duplicate.accounts.every((row) => row.status === "duplicate"));
  assert.equal(verifyForwardAudit(db).valid, true);
  db.close();
});

test("recommendation page shows latest ABCD while the simulated account can still read its immutable 09:45 batch", () => {
  const { db, batches } = fixture();
  db.prepare("UPDATE recommendation_batches SET status='superseded' WHERE batch_id=?").run(batches.abcd);
  db.prepare("INSERT INTO recommendation_batches(batch_id,model_key,trade_date,status,trigger_type,source_mode,item_count,started_at,finished_at) VALUES('abcd-later','abcd','2026-08-21','published','schedule','test',1,'2026-08-21T02:05:00Z','2026-08-21T02:05:10Z')").run();
  db.prepare("INSERT INTO recommendations(batch_id,model_key,trade_date,code,rank,score,reason,risk,confidence,payload_json,generated_at) VALUES('abcd-later','abcd','2026-08-21','600519.SH',1,99,'更晚盘中推荐','测试风险',.8,'{}','2026-08-21T02:05:10Z')").run();

  const latest = getRecommendations(db, "abcd");
  assert.equal(latest.selection.abcd.mode, "latest_published");
  assert.equal(latest.selection.abcd.batchId, "abcd-later");
  assert.deepEqual(latest.items.map((row) => row.code), ["600519.SH"]);

  const locked = getRecommendations(db, "abcd", { abcdMode: "locked_0945" });
  assert.equal(locked.selection.abcd.mode, "locked_0945");
  assert.equal(locked.selection.abcd.batchId, batches.abcd);
  assert.deepEqual(locked.items.map((row) => row.code), ["000001.SZ", "000002.SZ", "000333.SZ"]);

  const manual = getRecommendations(db, "abcd", { abcdBatchId: "abcd-later" });
  assert.equal(manual.selection.abcd.mode, "manual_refresh");
  assert.deepEqual(manual.items.map((row) => row.code), ["600519.SH"]);

  const missingToday = getRecommendations(db, "abcd", { abcdMode: "locked_0945", abcdTradeDate: "2026-08-22" });
  assert.equal(missingToday.selection.abcd.batchId, null);
  assert.equal(missingToday.items.length, 0);
  assert.equal(missingToday.dataStatus.models[0].freshness, "waiting");
  assert.match(missingToday.dataStatus.models[0].warnings[0], /不会回退到旧批次/);
  db.close();
});

test("all simulated accounts filter limit-up buys without deleting recommendation signals", () => {
  const { db, batches } = fixture();
  db.prepare("UPDATE realtime_quotes SET quote_time='2026-08-21 09:30:08',received_at='2026-08-21T01:30:08Z'").run();
  db.prepare("UPDATE realtime_quotes SET prev_close=10,open_price=11 WHERE code='000001.SZ'").run();
  const result = openForwardCohorts(db, { tradeDate: "2026-08-21", batches, accountKeys: ["aia"], executionMode: "open", openedAt: "2026-08-21T01:31:00Z" });
  assert.equal(result.accounts[0].status, "open");
  assert.equal(result.accounts[0].filteredLimitUp, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_trades WHERE account_key='aia' AND side='BUY' AND code='000001.SZ'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recommendations WHERE batch_id=? AND code='000001.SZ'").get(batches.aia).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_audit_events WHERE account_key='aia' AND event_type='BUY_FILTERED_LIMIT_UP'").get().count, 1);
  assert.equal(verifyForwardAudit(db).valid, true);
  db.close();
});

test("ABCD uses half-equity five-way slots and ledger corrections never overwrite actions", () => {
  const { db, batches } = fixture();
  const opened = openForwardCohorts(db, { tradeDate: "2026-08-21", batches, accountKeys: ["abcd"], executionMode: "abcd_t1", openedAt: "2026-08-21T02:05:00Z" });
  assert.equal(opened.accounts[0].status, "open");
  const buys = db.prepare("SELECT * FROM forward_trades WHERE account_key='abcd' AND side='BUY' ORDER BY recommendation_rank").all();
  assert.equal(buys.length, 3);
  assert.ok(buys.every((row) => row.trade_time === "09:50"));
  assert.ok(buys.every((row) => row.gross_amount <= 100_000));
  assert.ok(buys.reduce((sum, row) => sum + row.gross_amount + row.commission, 0) < 310_000);
  assert.throws(() => db.prepare("UPDATE forward_trades SET trade_time='11:00' WHERE trade_id=?").run(buys[0].trade_id), /append-only/);

  const corrected = voidForwardCohort(db, { accountKey: "abcd", tradeDate: "2026-08-21", reason: "测试：信号时点不合规", correctedAt: "2026-08-21T03:00:00Z" });
  assert.equal(corrected.voidedTrades, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_trades WHERE account_key='abcd'").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_trade_voids").get().count, 3);
  assert.equal(forwardDashboard(db).accounts.find((row) => row.account_key === "abcd").positions.length, 0);
  assert.equal(db.prepare("SELECT status FROM forward_cohorts WHERE account_key='abcd'").get().status, "skipped");
  assert.equal(verifyForwardAudit(db).valid, true);
  db.close();
});

test("next official trading close sells all cohorts and keeps audit chain valid", () => {
  const { db, batches, securities } = fixture();
  openForwardCohorts(db, { tradeDate: "2026-08-21", batches });
  const daily = db.prepare("INSERT INTO bars_daily(code,trade_date,open,high,low,close,source) VALUES(?,'2026-08-24',10,12,9,?,'bigquant+tushare_reconciled')");
  securities.forEach((row, index) => daily.run(row[0], 11 + index));
  const result = closeDueForwardCohorts(db, { tradeDate: "2026-08-24", closedAt: "2026-08-24T07:15:00Z" });
  assert.equal(result.count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_cohorts WHERE status='closed'").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_trades WHERE side='SELL'").get().count, db.prepare("SELECT COUNT(*) AS count FROM forward_trades WHERE side='BUY'").get().count);
  const dashboard = forwardDashboard(db);
  assert.equal(dashboard.accounts.length, 4);
  assert.ok(dashboard.accounts.every((account) => account.positions.length === 0));
  assert.equal(dashboard.audit.valid, true);
  db.close();
});

test("one original ABCD hard-gate result remains publishable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  const security = db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES(?,?,?,'主板','测试')");
  const factor = db.prepare("INSERT INTO factor_snapshot(code,trade_date,name,close,ret_20d) VALUES(?,'2026-08-21',?,10,1)");
  for (let index = 1; index <= 401; index += 1) {
    const symbol = String(index).padStart(6, "0");
    const code = `${symbol}.SZ`;
    security.run(code, symbol, `测试${index}`);
    factor.run(code, `测试${index}`);
  }
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,status,source,quality_score,created_at,published_at) VALUES('formal_daily','formal-1','2026-08-21',401,'published','bigquant_official+tushare_official',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,status,source,quality_score,created_at,published_at) VALUES('factor_snapshot','factor-1','2026-08-21',401,'published','formal_bigquant_tushare_factor_rebuild',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO dataset_dependencies(child_dataset_key,child_version_id,parent_dataset_key,parent_version_id) VALUES('factor_snapshot','factor-1','formal_daily','formal-1')").run();
  const published = publishAlgorithmTask(db, "abcd", {
    ok: true,
    status: "ready",
    items: [{ code: "000001.SZ", score: 73.2, a_score: 55, b_score: 60, c_score: 70, d_score: 99.8 }],
  }, "forward_0945");
  assert.equal(published.count, 1);
  assert.equal(db.prepare("SELECT item_count FROM recommendation_batches WHERE batch_id=?").get(published.batchId).item_count, 1);
  db.close();
});

test("exact ABCD panel writes only the latest governed factor date and rejects partial overwrite", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  const security = db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES(?,?,?,'主板','测试')");
  const factor = db.prepare("INSERT INTO factor_snapshot(code,trade_date,name,abcd_a_score,abcd_b_score,abcd_c_score,abcd_d_score) VALUES(?,?,?,?,?,?,?)");
  const panel = [];
  for (let index = 1; index <= 20; index += 1) {
    const symbol = String(index).padStart(6, "0");
    const code = `${symbol}.SZ`;
    security.run(code, symbol, `测试${index}`);
    factor.run(code, "2026-08-20", `测试${index}`, 77, 77, 77, 77);
    factor.run(code, "2026-08-21", `测试${index}`, null, null, null, null);
    panel.push({ code, a_score: 40 + index, b_score: 50 + index, c_score: 60 + index, d_score: index === 20 ? null : 70 + index });
  }
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,status,source,quality_score,created_at,published_at) VALUES('formal_daily','formal-1','2026-08-21',20,'published','bigquant_official+tushare_official',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,status,source,quality_score,created_at,published_at) VALUES('factor_snapshot','factor-1','2026-08-21',20,'published','formal_bigquant_tushare_factor_rebuild',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO dataset_dependencies(child_dataset_key,child_version_id,parent_dataset_key,parent_version_id) VALUES('factor_snapshot','factor-1','formal_daily','formal-1')").run();

  const written = persistAbcdFactorScores(db, { trade_date: "2026-08-21", factor_time: "2026-08-21 15:00:00", eligible_universe_count: 20, items: panel }, { required: true });
  assert.equal(written.applied, true);
  assert.equal(written.counts.a, 20);
  assert.equal(written.counts.d, 19);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM factor_snapshot WHERE trade_date='2026-08-21' AND abcd_a_score IS NOT NULL").get().count, 20);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM factor_snapshot WHERE trade_date='2026-08-21' AND abcd_d_score IS NOT NULL").get().count, 19);
  assert.equal(db.prepare("SELECT MIN(abcd_a_score) AS score FROM factor_snapshot WHERE trade_date='2026-08-20'").get().score, 77);
  assert.equal(db.prepare("SELECT status FROM data_quality_checks WHERE dataset_key='factor_abcd_scores' ORDER BY checked_at DESC LIMIT 1").get().status, "pass");

  const afterClose = persistAbcdFactorScores(db, {
    trade_date: "2026-08-21", eligible_universe_count: 20,
    items: panel.map((row) => ({ ...row, d_score: null })),
  }, { required: true });
  assert.equal(afterClose.status, "already_current");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM factor_snapshot WHERE trade_date='2026-08-21' AND abcd_d_score IS NOT NULL").get().count, 19);

  assert.throws(() => persistAbcdFactorScores(db, { trade_date: "2026-08-21", eligible_universe_count: 20, items: panel.slice(0, 10) }, { required: true }), /覆盖门禁未通过/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM factor_snapshot WHERE trade_date='2026-08-21' AND abcd_a_score IS NOT NULL").get().count, 20);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM data_quality_checks WHERE dataset_key='factor_abcd_scores' AND status='fail'").get().count, 1);
  db.close();
});

test("premarket accounts buy the opening price while ABCD only uses locked 09:45 signal and 09:50 price", () => {
  const { db, batches } = fixture();
  db.prepare("UPDATE realtime_quotes SET quote_time='2026-08-21 09:30:08',received_at='2026-08-21T01:30:08Z'").run();
  const preopen = openForwardCohorts(db, {
    tradeDate: "2026-08-21", batches, accountKeys: ["aia", "heat"], executionMode: "open",
    openedAt: "2026-08-21T01:30:10Z", finalizeMissing: false,
  });
  assert.ok(preopen.accounts.every((row) => row.status === "open"));
  const openingBuys = db.prepare("SELECT account_key,trade_time,price,source FROM forward_trades WHERE side='BUY' AND account_key IN ('aia','heat')").all();
  assert.ok(openingBuys.length > 0);
  assert.ok(openingBuys.every((row) => row.trade_time === "09:30" && row.source.endsWith(":official_open")));
  assert.equal(db.prepare("SELECT price FROM forward_trades WHERE account_key='aia' AND code='000001.SZ'").get().price, 9);

  db.prepare("UPDATE realtime_quotes SET price=price+1,quote_time='2026-08-21 10:01:05',received_at='2026-08-21T02:01:05Z'").run();
  const delayed = openForwardCohorts(db, {
    tradeDate: "2026-08-21", batches, accountKeys: ["abcd", "consensus"], executionMode: "dynamic",
    signalReadyAt: "2026-08-21T02:00:00Z", openedAt: "2026-08-21T02:01:06Z", finalizeMissing: false,
  });
  assert.ok(delayed.accounts.every((row) => row.status === "open"));
  assert.ok(db.prepare("SELECT trade_time FROM forward_trades WHERE account_key='abcd'").all().every((row) => row.trade_time === "09:50"));
  assert.equal(db.prepare("SELECT price FROM forward_trades WHERE account_key='abcd' AND code='000001.SZ'").get().price, 10.5);
  assert.ok(db.prepare("SELECT trade_time FROM forward_trades WHERE account_key='consensus'").all().every((row) => row.trade_time === "10:01:05"));
  assert.equal(verifyForwardAudit(db).valid, true);
  db.close();
});

test("ABCD waits for every locked pick instead of opening a partial cohort", () => {
  const { db, batches } = fixture({ executionCodes: ["000001.SZ", "000002.SZ"] });
  const waiting = openForwardCohorts(db, {
    tradeDate: "2026-08-21", batches, accountKeys: ["abcd"], executionMode: "abcd_t1",
    signalReadyAt: "2026-08-21T02:00:00Z", openedAt: "2026-08-21T02:01:00Z", finalizeMissing: false,
  });
  assert.equal(waiting.accounts[0].status, "waiting");
  assert.match(waiting.accounts[0].reason, /000333\.SZ/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_cohorts WHERE account_key='abcd'").get().count, 0);
  db.close();
});

test("a locked ABCD batch remains tradable after a newer refresh supersedes it", () => {
  const { db, batches } = fixture();
  db.prepare("UPDATE recommendation_batches SET status='superseded' WHERE batch_id=?").run(batches.abcd);
  db.prepare("UPDATE realtime_quotes SET quote_time='2026-08-21 10:02:05',received_at='2026-08-21T02:02:05Z'").run();
  const result = openForwardCohorts(db, {
    tradeDate: "2026-08-21", batches, accountKeys: ["abcd"], executionMode: "dynamic",
    signalReadyAt: "2026-08-21T02:00:00Z", openedAt: "2026-08-21T02:02:06Z", finalizeMissing: false,
  });
  assert.equal(result.accounts[0].status, "open");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forward_trades WHERE account_key='abcd' AND side='BUY'").get().count, 3);
  assert.ok(db.prepare("SELECT trade_time FROM forward_trades WHERE account_key='abcd'").all().every((row) => row.trade_time === "09:50"));
  assert.equal(verifyForwardAudit(db).valid, true);
  db.close();
});

test("scheduler keeps premarket and delayed ABCD execution as separate automated stages", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "engine", "scheduler.mjs"), "utf8");
  assert.match(source, /forward_open_attempt_\$\{dateKey\}/);
  assert.match(source, /executionMode: "open"/);
  assert.match(source, /forward_abcd_attempt_\$\{dateKey\}/);
  assert.match(source, /signalReadyAt: abcd\.signalReadyAt/);
  assert.match(source, /sourcePolicy: "fresh"/);
  assert.match(source, /runNewsCollectors/);
  assert.match(source, /minutes >= 10 \* 60 \+ 5/);
  assert.match(source, /ABCD 09:45锁定批次缺失/);
  assert.match(source, /intraday_abcd_default_\$\{dateKey\}/);
  assert.match(source, /taskDue\(db, defaultAbcdTaskKey, 86_400\)/);
  assert.match(source, /night_abcd[\s\S]*requireFactorWriteback: true/);
});
