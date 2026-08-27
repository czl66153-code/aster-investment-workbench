import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePreopenSchedule, getPreopenSummary, preopenStatus, savePreopenSummary } from "../engine/preopen.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  return db;
}

test("preopen panel persists one canonical daily payload and enforces risk and links", () => {
  const db = database();
  const schedule = ensurePreopenSchedule(db);
  assert.equal(schedule.schedule_key, "stock_market_preopen_daily_panel");
  assert.equal(schedule.cron_text, "A股交易日 08:20；失败每15分钟补抓至10:30");
  const saved = savePreopenSummary(db, {
    status: "success", source_counts: { news: 2, taoguba: 1 }, errors: {},
    payload: {
      generate_datetime: "2026-08-21 08:20:11",
      time_window: { start: "2026-08-20 00:00:00", end: "2026-08-21 09:14:59" },
      news_part: {
        cn_news: [{ title: "政策", summary: "行业可能受益。", publish_time: "2026-08-21 08:10:00", original_url: "https://example.test/cn", type: "wrong" }, { summary: "无链接应丢弃" }],
        us_news: [{ title: "美股", summary: "风险偏好改善。", publish_time: "2026-08-20 23:00:00", original_url: "https://example.test/us" }],
      },
      taoguba_top10: [{ summary: "资金讨论集中。", hot_point: "机器人", post_origin_url: "https://example.test/post", reference_post_count: 3 }],
      taoguba_part: {
        industry_consensus: [{ industry: "化学制药", summary: "创新药讨论集中。", consensus_view: "资金关注临床催化。", divergence: "持续性存在分歧。", sentiment: "分歧", catalysts: ["临床进展"], risks: ["冲高回落"], representative_stocks: [{ code: "600000.SH", name: "测试制药", mention_count: 4 }], reference_post_count: 6, source_posts: [{ author: "认证作者", verified: true, publish_time: "2026-08-20 08:00:00", post_origin_url: "https://example.test/industry" }] }],
        influencer_stock_views: [{ stock_name: "测试制药", stock_code: "600000.SH", industry: "化学制药", overall_stance: "看多", author_count: 1, combined_summary: "认证作者：关注临床催化。", attention_score: 220, viewpoints: [{ author: "认证作者", author_badge: "平台认证", stance: "看多", summary: "关注临床催化。", catalysts: ["数据公布"], risks: ["不及预期"], publish_time: "2026-08-20 08:00:00", post_origin_url: "https://example.test/view", metrics: { views: 100, likes: 8, replies: 3 } }] }],
        quality: { source_post_count: 540, candidate_post_count: 300, industry_group_count: 10, verified_stock_post_count: 20, latest_post_time: "2026-08-20 17:09:00", classification: "本地证券主表行业映射" },
      },
      note: "被污染的提示",
    },
  }, "2026-08-21");
  assert.deepEqual(Object.keys(saved), ["generate_datetime", "time_window", "news_part", "source_quality", "taoguba_top10", "taoguba_part", "note"]);
  assert.equal(saved.news_part.cn_news.length, 1);
  assert.equal(saved.news_part.cn_news[0].type, "cn_news");
  assert.equal(saved.news_part.us_news[0].type, "us_news");
  assert.equal(saved.source_quality.news.status, "fresh");
  assert.equal(saved.source_quality.news.same_day_summary_count, 1);
  assert.equal(saved.taoguba_top10[0].reference_post_count, 3);
  assert.equal(saved.taoguba_part.industry_consensus[0].representative_stocks[0].mention_count, 4);
  assert.equal(saved.taoguba_part.influencer_stock_views[0].viewpoints[0].author, "认证作者");
  assert.equal(saved.taoguba_part.quality.source_post_count, 540);
  assert.equal(saved.note, "所有内容由AI总结，仅供参考，不构成投资建议");
  assert.deepEqual(getPreopenSummary(db, "2026-08-21"), saved);
  assert.equal(preopenStatus(db, "2026-08-21").llm_model, "deepseek-chat");
  db.close();
});

test("preopen missing data returns valid empty arrays for the exact window", () => {
  const db = database();
  const payload = getPreopenSummary(db, "2026-08-21");
  assert.equal(payload.time_window.start, "2026-08-20 00:00:00");
  assert.equal(payload.time_window.end, "2026-08-21 09:14:59");
  assert.deepEqual(payload.news_part, { cn_news: [], us_news: [] });
  assert.equal(payload.source_quality.news.status, "missing");
  assert.deepEqual(payload.taoguba_top10, []);
  assert.deepEqual(payload.taoguba_part.industry_consensus, []);
  assert.deepEqual(payload.taoguba_part.influencer_stock_views, []);
  db.close();
});

test("preopen marks yesterday-only cache partial instead of reporting false success", () => {
  const db = database();
  savePreopenSummary(db, {
    status: "success", source_counts: { news: 1, taoguba: 0 }, errors: {},
    payload: {
      generate_datetime: "2026-08-25 08:20:00",
      time_window: { start: "2026-08-24 00:00:00", end: "2026-08-25 09:14:59" },
      news_part: { cn_news: [{ title: "昨日新闻", summary: "昨日观点。", publish_time: "2026-08-24 18:00:00", original_url: "https://example.test/yesterday" }], us_news: [] },
    },
  }, "2026-08-25");
  const status = preopenStatus(db, "2026-08-25");
  assert.equal(status.status, "partial");
  assert.equal(status.source_quality.news.status, "stale");
  assert.match(status.errors.news_freshness, /没有可展示的当日新闻/);
  db.close();
});
