import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fivePlatformDashboard, saveFivePlatformSnapshot } from "../engine/five_platform.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES('600519.SH','600519','贵州茅台','主板','白酒')").run();
  db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES('000001.SZ','000001','平安银行','主板','银行')").run();
  db.prepare("INSERT INTO realtime_quotes(code,name,price,prev_close,pct_chg,source,received_at) VALUES('600519.SH','贵州茅台',1418,1400,1.29,'test','2026-08-21T10:00:00+08:00')").run();
  return db;
}

test("five platform snapshot keeps raw source status and weighted aggregate", () => {
  const db = database();
  const payload = {
    date: "2026-08-21", generated_at: "2026-08-21T09:45:12+08:00", success_count: 3,
    weights: { xueqiu: .25, eastmoney: .25, tonghuashun: .2, taoguba: .15, kaipanla: .15 },
    platforms: [
      { key: "xueqiu", name: "雪球热股榜", ok: true, source_date: "2026-08-21", items: [{ rank: 1, name: "贵州茅台", code: "SH600519", heat: "99", change: "1.2" }] },
      { key: "eastmoney", name: "东方财富个股人气榜", ok: true, source_date: "2026-08-21", items: [{ rank: 1, name: "平安银行", code: "000001", heat: "1", change: "0.8" }] },
      { key: "tonghuashun", name: "同花顺热股榜", ok: true, source_date: "2026-08-21", items: [{ rank: 2, name: "贵州茅台", code: "600519", heat: "2", change: "1.2" }] },
      { key: "taoguba", name: "淘股吧24小时搜索热度", ok: false, items: [], error: "上游限流" },
      { key: "kaipanla", name: "开盘啦股票热度榜", ok: false, items: [], error: "接口调整" },
    ],
    combined: [{ rank: 1, name: "贵州茅台", code: "600519", score: 43, platform_count: 2, contributions: [{ key: "xueqiu", platform: "雪球热股榜", rank: 1, score: 25 }, { key: "tonghuashun", platform: "同花顺热股榜", rank: 2, score: 18 }] }],
  };
  const saved = saveFivePlatformSnapshot(db, payload, "test");
  assert.equal(saved.successCount, 3);
  const dashboard = fivePlatformDashboard(db, { syncCache: false });
  assert.equal(dashboard.ready, true);
  assert.equal(dashboard.platforms.length, 5);
  assert.equal(dashboard.platforms.find((row) => row.platform_key === "taoguba").error, "上游限流");
  assert.equal(dashboard.combined[0].security.code, "600519.SH");
  assert.equal(dashboard.combined[0].platform_count, 2);
  assert.equal(dashboard.combined[0].pct_chg, 1.29);
  assert.equal(dashboard.platforms.find((row) => row.platform_key === "xueqiu").items[0].consensus_count, 2);
  assert.equal(typeof dashboard.platforms.find((row) => row.platform_key === "xueqiu").items[0].highlight_index, "number");
  assert.equal(dashboard.history.length, 1);
  db.close();
});

test("a successful older platform row is explicitly marked stale", () => {
  const db = database();
  saveFivePlatformSnapshot(db, {
    date: "2026-08-21", generated_at: "2026-08-21T08:30:00+08:00",
    platforms: [{ key: "tonghuashun", name: "同花顺热股榜", ok: true, source_date: "2026-08-20", items: [{ rank: 1, name: "贵州茅台", code: "600519" }] }],
    combined: [],
  }, "test-stale");
  const source = fivePlatformDashboard(db, { syncCache: false }).platforms.find((row) => row.platform_key === "tonghuashun");
  assert.equal(source.ok, 1);
  assert.equal(source.stale_used, 1);
  assert.equal(source.stale_date, "2026-08-20");
  db.close();
});
