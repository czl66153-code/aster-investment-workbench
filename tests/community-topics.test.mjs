import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { communityTopicsStatus, ensureCommunityTopicSchedule, getCommunityTopics, saveCommunityTopics } from "../engine/community_topics.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  return db;
}

test("community topics persist AI summaries with program-controlled provenance", () => {
  const db = database();
  assert.equal(ensureCommunityTopicSchedule(db).schedule_key, "community_hot_topics_daily");
  const payload = saveCommunityTopics(db, {
    status: "success", source_counts: { taoguba: 12, kaipanla: 2, xueqiu: 3 }, errors: {},
    payload: {
      generate_datetime: "2026-08-25T08:22:00+08:00",
      time_window: { start: "2026-08-24T00:00:00+08:00", end: "2026-08-25T08:22:00+08:00" },
      candidate_count: 17,
      source_quality: { taoguba: { status: "fresh", in_window_count: 12 }, kaipanla: { status: "fresh", in_window_count: 2, public_information_count: 2 }, xueqiu: { status: "fresh", in_window_count: 3 } },
      topics: [{ topic: "医药与黄金热度升温", category: "板块", summary: "多篇材料围绕医药和黄金展开讨论。", why_hot: "跨平台出现。", sentiment: "分歧", discussion_heat: 88, source_posts: [
        { source_id: "taoguba:1", platform: "taoguba", source_kind: "community_post", title: "复盘", published_at: "2026-08-24T18:00:00+08:00", url: "https://example.test/post", heat_score: 40 },
        { source_id: "kaipanla:2", platform: "kaipanla", source_kind: "public_information", title: "公开快讯", published_at: "2026-08-25T08:00:00+08:00", url: "javascript:bad", heat_score: 10 },
      ] }], note: "污染提示",
    },
  }, "2026-08-25");
  assert.equal(payload.topics.length, 1);
  assert.deepEqual(payload.topics[0].platforms, ["taoguba", "kaipanla"]);
  assert.equal(payload.topics[0].source_posts[1].source_kind, "public_information");
  assert.equal(payload.topics[0].source_posts[1].url, "");
  assert.equal(payload.note, "仅供参考，不构成投资建议");
  assert.deepEqual(getCommunityTopics(db, "2026-08-25"), payload);
  assert.equal(communityTopicsStatus(db, "2026-08-25").status, "success");
  db.close();
});

test("community topics return an explicit empty three-source contract", () => {
  const db = database();
  const payload = getCommunityTopics(db, "2026-08-25");
  assert.deepEqual(payload.topics, []);
  assert.deepEqual(Object.keys(payload.source_quality), ["taoguba", "kaipanla", "xueqiu"]);
  assert.equal(payload.note, "仅供参考，不构成投资建议");
  db.close();
});
