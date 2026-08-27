import { shanghaiDate } from "./core.mjs";

const RISK_NOTE = "仅供参考，不构成投资建议";
const PLATFORM_NAMES = { taoguba: "淘股吧", kaipanla: "开盘啦", xueqiu: "雪球" };

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function windowFor(targetDate) {
  const current = new Date(`${targetDate}T00:00:00Z`);
  current.setUTCDate(current.getUTCDate() - 1);
  return { start: `${current.toISOString().slice(0, 10)}T00:00:00+08:00`, end: `${targetDate}T23:59:59+08:00` };
}

function emptySource(platform) {
  return { platform, platform_name: PLATFORM_NAMES[platform], status: "missing", source_status: "unknown", message: "尚未生成", checked_at: "", in_window_count: 0, candidate_count: 0, community_post_count: 0, public_information_count: 0, latest_publish_time: "" };
}

export function emptyCommunityTopics(targetDate = shanghaiDate()) {
  return { summary_date: targetDate, generate_datetime: "", time_window: windowFor(targetDate), topics: [], source_quality: { taoguba: emptySource("taoguba"), kaipanla: emptySource("kaipanla"), xueqiu: emptySource("xueqiu") }, candidate_count: 0, model: "deepseek-chat", methodology: "", note: RISK_NOTE };
}

export function ensureCommunityTopicSchedule(db) {
  db.prepare(`INSERT OR IGNORE INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES('community_hot_topics_daily','三平台热议AI蒸馏','preopen','A股交易日 08:20；随盘前专题生成',1,90000,2,'淘股吧/开盘啦/雪球逐源标记；仅纳入真实时间窗；AI结果必须保留可回溯来源；缺源不得冒充',CURRENT_TIMESTAMP)`).run();
  return db.prepare("SELECT * FROM schedule_definitions WHERE schedule_key='community_hot_topics_daily'").get();
}

function normalizedPayload(value, targetDate) {
  const fallback = emptyCommunityTopics(targetDate);
  const input = value && typeof value === "object" ? value : fallback;
  const sourceQuality = {};
  for (const platform of Object.keys(PLATFORM_NAMES)) {
    const source = input.source_quality?.[platform] && typeof input.source_quality[platform] === "object" ? input.source_quality[platform] : {};
    sourceQuality[platform] = {
      ...emptySource(platform),
      status: ["fresh", "empty", "unavailable", "missing"].includes(source.status) ? source.status : "missing",
      source_status: String(source.source_status || "unknown"), message: String(source.message || ""), checked_at: String(source.checked_at || ""),
      in_window_count: Math.max(0, Number(source.in_window_count || 0)), candidate_count: Math.max(0, Number(source.candidate_count || 0)), community_post_count: Math.max(0, Number(source.community_post_count || 0)), public_information_count: Math.max(0, Number(source.public_information_count || 0)), latest_publish_time: String(source.latest_publish_time || ""),
    };
  }
  const topics = (Array.isArray(input.topics) ? input.topics : []).filter((item) => item && typeof item === "object").map((item) => {
    const sources = (Array.isArray(item.source_posts) ? item.source_posts : []).filter((source) => source && PLATFORM_NAMES[source.platform]).map((source) => ({
      source_id: String(source.source_id || ""), platform: String(source.platform), platform_name: PLATFORM_NAMES[source.platform], source_kind: source.source_kind === "public_information" ? "public_information" : "community_post", title: String(source.title || ""), content: String(source.content || "").slice(0, 900), published_at: String(source.published_at || ""), url: /^https?:\/\//.test(String(source.url || "")) ? String(source.url) : "", heat_score: Math.max(0, Number(source.heat_score || 0)),
    })).filter((source) => source.source_id && source.title).slice(0, 8);
    const platforms = [...new Set(sources.map((source) => source.platform))];
    return { rank: 0, topic: String(item.topic || "").trim().slice(0, 80), category: ["个股", "板块", "政策", "新闻", "市场", "交易方法", "其他"].includes(item.category) ? item.category : "其他", summary: String(item.summary || "").trim().slice(0, 700), why_hot: String(item.why_hot || "").trim().slice(0, 360), sentiment: ["偏多", "中性", "偏空", "分歧"].includes(item.sentiment) ? item.sentiment : "中性", discussion_heat: Math.max(0, Number(item.discussion_heat || 0)), platforms, reference_post_count: sources.length, source_posts: sources };
  }).filter((item) => item.topic && item.summary && item.source_posts.length).sort((a, b) => b.platforms.length - a.platforms.length || b.discussion_heat - a.discussion_heat).slice(0, 10).map((item, index) => ({ ...item, rank: index + 1 }));
  return { summary_date: targetDate, generate_datetime: String(input.generate_datetime || ""), time_window: { start: String(input.time_window?.start || fallback.time_window.start), end: String(input.time_window?.end || fallback.time_window.end) }, topics, source_quality: sourceQuality, candidate_count: Math.max(0, Number(input.candidate_count || 0)), model: "deepseek-chat", methodology: String(input.methodology || ""), note: RISK_NOTE };
}

export function saveCommunityTopics(db, task, targetDate = shanghaiDate()) {
  ensureCommunityTopicSchedule(db);
  const payload = normalizedPayload(task?.payload, targetDate);
  const errors = task?.errors && typeof task.errors === "object" ? task.errors : {};
  const counts = task?.source_counts && typeof task.source_counts === "object" ? task.source_counts : {};
  const status = payload.topics.length ? (Object.keys(errors).length ? "partial" : "success") : "partial";
  db.prepare(`INSERT INTO community_hot_topic_summaries(summary_date,generate_datetime,window_start,window_end,status,payload_json,candidate_count,taoguba_source_count,kaipanla_source_count,xueqiu_source_count,llm_model,error_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(summary_date) DO UPDATE SET generate_datetime=excluded.generate_datetime,window_start=excluded.window_start,window_end=excluded.window_end,status=excluded.status,payload_json=excluded.payload_json,candidate_count=excluded.candidate_count,taoguba_source_count=excluded.taoguba_source_count,kaipanla_source_count=excluded.kaipanla_source_count,xueqiu_source_count=excluded.xueqiu_source_count,llm_model=excluded.llm_model,error_json=excluded.error_json,updated_at=CURRENT_TIMESTAMP`)
    .run(targetDate, payload.generate_datetime || new Date().toISOString(), payload.time_window.start, payload.time_window.end, status, JSON.stringify(payload), payload.candidate_count, Number(counts.taoguba || 0), Number(counts.kaipanla || 0), Number(counts.xueqiu || 0), "deepseek-chat", JSON.stringify(errors));
  return getCommunityTopics(db, targetDate);
}

export function getCommunityTopics(db, targetDate = shanghaiDate()) {
  ensureCommunityTopicSchedule(db);
  const row = db.prepare("SELECT payload_json FROM community_hot_topic_summaries WHERE summary_date=?").get(targetDate);
  return row ? normalizedPayload(parseJson(row.payload_json, null), targetDate) : emptyCommunityTopics(targetDate);
}

export function communityTopicsStatus(db, targetDate = shanghaiDate()) {
  ensureCommunityTopicSchedule(db);
  const row = db.prepare("SELECT summary_date,generate_datetime,status,candidate_count,taoguba_source_count,kaipanla_source_count,xueqiu_source_count,llm_model,error_json,updated_at FROM community_hot_topic_summaries WHERE summary_date=?").get(targetDate);
  return row ? { ...row, errors: parseJson(row.error_json, {}) } : { summary_date: targetDate, status: "missing", candidate_count: 0, taoguba_source_count: 0, kaipanla_source_count: 0, xueqiu_source_count: 0, llm_model: "deepseek-chat", errors: {} };
}
