import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureExpertTrackerSchedules, expertTrackerStatus, recordClientError } from "../engine/expert_tracker.mjs";
import { projectDir } from "../engine/core.mjs";

const webRoot = join(projectDir, "web", "expert-tracker");

test("published expert data exposes per-source freshness without hiding partial disclosure", () => {
  const status = expertTrackerStatus();
  assert.match(status.businessDate, /^20\d{2}-\d{2}-\d{2}$/);
  assert.equal(status.overall, "healthy");
  assert.equal(status.deployed, true);
  assert.equal(status.healthy, true);
  assert.ok(status.counts.profiles > 0);
  assert.ok(status.counts.xueqiuPortfolios > 0);
  assert.ok(status.counts.profileWithTrades > 0);
  assert.equal(status.counts.xueqiuTraceablePortfolios, 3);
  assert.equal(status.counts.visibleExperts, status.counts.profileWithTrades + status.counts.xueqiuTraceablePortfolios);
  assert.equal(Object.values(status.stages).every((stage) => stage.status === "success"), true);
  const focus = status.quality.focusFreshness.focus.find((item) => item.displayName === "乌江望月");
  assert.equal(focus.current, true);
  assert.equal(focus.sourceDates["复利笔记"], status.businessDate);
  assert.equal(focus.sourceDates["顽主杯"], status.businessDate);
  assert.deepEqual(focus.currentSources, ["顽主杯", "复利笔记"]);
  assert.deepEqual(focus.staleSources, []);
  assert.equal(status.quality.wanzhuRoster.complete, true);
  assert.equal(status.quality.wanzhuRoster.archived, status.quality.wanzhuRoster.roster);
  assert.ok(status.quality.wanzhuRoster.roster >= 82);
});

test("v2 excludes Tonghuashun and keeps only experts with transaction evidence", () => {
  const publicSources = JSON.parse(readFileSync(join(webRoot, "data", "public_sources.json"), "utf8"));
  const profiles = JSON.parse(readFileSync(join(webRoot, "data", "expert_profiles.json"), "utf8"));
  const script = readFileSync(join(webRoot, "embed.js"), "utf8");
  assert.equal(Object.hasOwn(publicSources, "tonghuashun"), false);
  assert.equal((profiles.profiles || []).filter((profile) => (profile.transactions || []).length > 0).length, expertTrackerStatus().counts.profileWithTrades);
  const traceable = (publicSources.xueqiu?.portfolios || []).filter((portfolio) => [...(portfolio.localRebalances || []), ...(portfolio.recentRebalances || [])].some((record) => (record.trades || []).length > 0));
  assert.equal(traceable.length, 3);
  assert.match(script, /filter\(\(expert\) => \(expert\.transactions \|\| \[\]\)\.length > 0\)/);
  assert.match(script, /previousWeightPct/);
  assert.match(script, /targetWeightPct/);
  assert.match(script, /tradePrice/);
  assert.doesNotMatch(script, /personName === "乌江望月" && item\.source === "顽主杯"/);
  assert.match(script, /披露日.*shortDate\(latest\.date\)/);
  assert.match(script, /非最近披露日/);
  assert.match(script, /不进入当前持仓排行榜/);
  const duplicateNames = [...new Set((profiles.profiles || []).map((profile) => profile.personName))];
  assert.equal(duplicateNames.length, (profiles.profiles || []).length);
});

test("native template keeps ranking and opens forecast only through player detail", () => {
  const template = readFileSync(join(webRoot, "native-template.html"), "utf8");
  const script = readFileSync(join(webRoot, "embed.js"), "utf8");
  assert.equal((template.match(/<section\b/g) || []).length, 3);
  assert.match(template, /ranking-module/);
  assert.match(template, /forecast-module[^>]+hidden/);
  assert.match(template, /participantWatchlist/);
  assert.match(template, /expert-module/);
  assert.match(template, /expertSearch/);
  assert.match(template, /expertDossier" hidden/);
  assert.match(script, /detailOpen: false/);
  assert.match(script, /class="expert-return/);
  assert.match(script, /返回选手榜/);
});

test("embedded stylesheet cannot leak into the Aster host", () => {
  const css = readFileSync(join(webRoot, "embed.scoped.css"), "utf8");
  const selectors = css.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes("{") && !line.startsWith("@"));
  assert.ok(selectors.length > 40);
  for (const line of selectors) assert.match(line.slice(0, line.indexOf("{")), /\.tracker-embed/);
});

test("sell or exit rows always come from two dated disclosure snapshots", () => {
  const data = JSON.parse(readFileSync(join(webRoot, "data", "expert_profiles.json"), "utf8"));
  const sells = data.profiles.flatMap((profile) => profile.transactions || []).filter((row) => /卖出|退出/.test(row.action));
  assert.ok(sells.length > 0);
  for (const row of sells) {
    assert.match(row.fromDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.toDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.toDate > row.fromDate);
  }
});

test("Wujian Wangyue latest disclosures and the 2026-08-21 recovery archive remain verifiable", () => {
  const data = JSON.parse(readFileSync(join(webRoot, "data", "expert_profiles.json"), "utf8"));
  const matches = data.profiles.filter((profile) => profile.personName === "乌江望月");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, "复利笔记");
  assert.equal(matches[0].latestSnapshot.date, data.date);
  assert.ok(matches[0].latestSnapshot.holdings.length > 0);
  assert.deepEqual(matches[0].sourceVariants.map((variant) => variant.source), ["复利笔记", "顽主杯"]);
  assert.equal(matches[0].sourceVariants[0].selected, true);

  const wanzhuArchive = JSON.parse(readFileSync(join(projectDir, "outputs", "expert_tracking", "competition_history", "wanzhu", "127166.json"), "utf8"));
  const wanzhu = wanzhuArchive.snapshots.find((snapshot) => snapshot.date === "2026-08-21");
  assert.deepEqual(wanzhu.holdings.map((row) => row.stockName), ["湖南白银", "共进股份", "大中矿业", "旭光电子", "湖南裕能", "蓝盾光电", "东田微"]);

  const backfill = readFileSync(join(projectDir, "tools", "expert_tracking_sources", "backfill_competition_history.mjs"), "utf8");
  assert.match(backfill, /RECENT_MISSING_RETRY_DAYS = 5/);
  assert.match(backfill, /not_disclosed_yet/);
  assert.match(backfill, /pendingDates/);
  assert.match(backfill, /\/api\/wx\/player\/match\/record\/list/);
  assert.match(backfill, /WANZHU_AUTHORIZATION/);
  assert.match(backfill, /item\.amountWan > 0/);
});

test("schedules are formal and client error monitoring redacts secrets", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE schedule_definitions(schedule_key TEXT PRIMARY KEY,display_name TEXT,session_type TEXT,cron_text TEXT,enabled INTEGER,max_age_seconds INTEGER,retry_limit INTEGER,quality_gate TEXT,last_started_at TEXT,last_success_at TEXT,updated_at TEXT);
    CREATE TABLE client_error_events(event_id TEXT PRIMARY KEY,module_key TEXT,route TEXT,phase TEXT,message TEXT,source TEXT,stack TEXT,user_agent TEXT,created_at TEXT);
    CREATE TABLE alerts(alert_id TEXT PRIMARY KEY,severity TEXT,source TEXT,title TEXT,message TEXT,status TEXT,created_at TEXT);
  `);
  const schedules = ensureExpertTrackerSchedules(db);
  assert.deepEqual(schedules.map((row) => row.schedule_key).sort(), ["expert_next_holding_prediction", "expert_tracker_after_close", "expert_tracker_recovery"]);
  assert.equal(schedules.find((row) => row.schedule_key === "expert_next_holding_prediction").retry_limit, 3);
  assert.match(schedules.find((row) => row.schedule_key === "expert_tracker_recovery").quality_gate, /最近5个交易日/);
  assert.match(schedules.find((row) => row.schedule_key === "expert_tracker_recovery").quality_gate, /不视为空仓或卖出/);
  recordClientError(db, { route: "/expert-tracker", phase: "mount", message: "Authorization: Bearer secret-value", stack: "api_key=hidden" }, "qa");
  const row = db.prepare("SELECT * FROM client_error_events").get();
  assert.equal(row.module_key, "expert_tracker");
  assert.equal(String(row.message).includes("secret-value"), false);
  assert.equal(String(row.stack).includes("hidden"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM alerts").get().count, 1);
  db.close();
});
