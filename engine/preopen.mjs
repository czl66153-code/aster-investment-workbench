import { shanghaiDate } from "./core.mjs";

const RISK_NOTE = "所有内容由AI总结，仅供参考，不构成投资建议";

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

export function emptyPreopenPayload(targetDate = shanghaiDate()) {
  const date = new Date(`${targetDate}T00:00:00+08:00`);
  date.setDate(date.getDate() - 1);
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
  return {
    generate_datetime: new Date().toISOString(),
    time_window: { start: `${yesterday} 00:00:00`, end: `${targetDate} 09:14:59` },
    news_part: { cn_news: [], us_news: [] },
    source_quality: { news: { status: "missing", source_record_count: 0, same_day_source_count: 0, previous_day_source_count: 0, same_day_summary_count: 0, latest_source_publish_time: "", latest_summary_publish_time: "", refresh: { status: "not_run", fetched: 0, inserted: 0, successful_calls: 0, failed_calls: 0, failure_kinds: [] }, message: "今日盘前新闻尚未生成" } },
    taoguba_top10: [],
    taoguba_part: { industry_consensus: [], influencer_stock_views: [], quality: { source_post_count: 0, candidate_post_count: 0, industry_group_count: 0, verified_stock_post_count: 0, latest_post_time: "", classification: "" } },
    note: RISK_NOTE,
  };
}

export function ensurePreopenSchedule(db) {
  db.prepare(`INSERT OR IGNORE INTO schedule_definitions(schedule_key,display_name,session_type,cron_text,enabled,max_age_seconds,retry_limit,quality_gate,updated_at)
    VALUES('stock_market_preopen_daily_panel','每日盘前专题','preopen','A股交易日 08:20；失败每15分钟补抓至10:30',1,90000,2,'新闻与帖子严格限定昨日00:00至当日09:14:59；当日新闻为空必须标记降级并重试；必须包含风险提示',CURRENT_TIMESTAMP)`).run();
  db.prepare(`UPDATE schedule_definitions SET cron_text='A股交易日 08:20；失败每15分钟补抓至10:30',quality_gate='新闻与帖子严格限定昨日00:00至当日09:14:59；当日新闻为空必须标记降级并重试；必须包含风险提示',updated_at=CURRENT_TIMESTAMP WHERE schedule_key='stock_market_preopen_daily_panel'`).run();
  return db.prepare("SELECT * FROM schedule_definitions WHERE schedule_key='stock_market_preopen_daily_panel'").get();
}

function normalizedPayload(payload, targetDate) {
  const fallback = emptyPreopenPayload(targetDate);
  const result = payload && typeof payload === "object" ? payload : fallback;
  const news = result.news_part && typeof result.news_part === "object" ? result.news_part : {};
  const normalizeNews = (items, type) => (Array.isArray(items) ? items : []).filter((item) => item && typeof item === "object" && String(item.original_url || "").trim()).map((item) => ({
    title: String(item.title || "").trim(),
    summary: String(item.summary || "").trim(),
    publish_time: String(item.publish_time || "").trim(),
    source: String(item.source || "").trim(),
    original_url: String(item.original_url).trim(),
    type,
  })).filter((item) => item.summary);
  const normalizeTaoguba = (items) => (Array.isArray(items) ? items : []).filter((item) => item && typeof item === "object" && String(item.post_origin_url || "").trim()).map((item) => ({
    summary: String(item.summary || "").trim(),
    hot_point: String(item.hot_point || "").trim(),
    post_origin_url: String(item.post_origin_url).trim(),
    reference_post_count: Math.max(1, Number(item.reference_post_count || 1)),
  })).filter((item) => item.summary).slice(0, 10);
  const taogubaPart = result.taoguba_part && typeof result.taoguba_part === "object" ? result.taoguba_part : {};
  const normalizeIndustry = (items) => (Array.isArray(items) ? items : []).filter((item) => item && typeof item === "object").map((item) => {
    const sourcePosts = (Array.isArray(item.source_posts) ? item.source_posts : []).filter((source) => source && String(source.post_origin_url || "").trim()).map((source) => ({ author: String(source.author || "匿名用户").trim(), verified: Boolean(source.verified), publish_time: String(source.publish_time || "").trim(), post_origin_url: String(source.post_origin_url).trim() })).slice(0, 5);
    return {
      industry: String(item.industry || "").trim(), summary: String(item.summary || "").trim(), consensus_view: String(item.consensus_view || "").trim(), divergence: String(item.divergence || "").trim(),
      sentiment: ["偏多", "中性", "偏空", "分歧"].includes(item.sentiment) ? item.sentiment : "中性",
      catalysts: (Array.isArray(item.catalysts) ? item.catalysts : []).map(String).filter(Boolean).slice(0, 5), risks: (Array.isArray(item.risks) ? item.risks : []).map(String).filter(Boolean).slice(0, 5),
      representative_stocks: (Array.isArray(item.representative_stocks) ? item.representative_stocks : []).filter((stock) => stock && stock.code && stock.name).map((stock) => ({ code: String(stock.code), name: String(stock.name), industry: String(stock.industry || item.industry || ""), mention_count: Math.max(1, Number(stock.mention_count || 1)) })).slice(0, 5),
      reference_post_count: Math.max(sourcePosts.length, Number(item.reference_post_count || 0)), source_posts: sourcePosts,
    };
  }).filter((item) => item.industry && item.summary && item.source_posts.length).slice(0, 8);
  const normalizeInfluencers = (items) => (Array.isArray(items) ? items : []).filter((item) => item && typeof item === "object").map((item) => {
    const viewpoints = (Array.isArray(item.viewpoints) ? item.viewpoints : []).filter((view) => view && view.post_origin_url).map((view) => ({ author: String(view.author || "").trim(), author_badge: String(view.author_badge || "平台认证").trim(), stance: ["看多", "中性", "谨慎", "看空"].includes(view.stance) ? view.stance : "中性", summary: String(view.summary || "").trim(), catalysts: (Array.isArray(view.catalysts) ? view.catalysts : []).map(String).filter(Boolean).slice(0, 4), risks: (Array.isArray(view.risks) ? view.risks : []).map(String).filter(Boolean).slice(0, 4), publish_time: String(view.publish_time || "").trim(), post_origin_url: String(view.post_origin_url).trim(), metrics: { views: Math.max(0, Number(view.metrics?.views || 0)), likes: Math.max(0, Number(view.metrics?.likes || 0)), replies: Math.max(0, Number(view.metrics?.replies || 0)) } })).filter((view) => view.author && view.summary).slice(0, 5);
    return { stock_name: String(item.stock_name || "").trim(), stock_code: String(item.stock_code || "").trim(), industry: String(item.industry || "").trim(), overall_stance: ["看多", "中性", "谨慎", "看空", "分歧"].includes(item.overall_stance) ? item.overall_stance : "中性", author_count: viewpoints.length, combined_summary: String(item.combined_summary || "").trim(), viewpoints, attention_score: Math.max(0, Number(item.attention_score || 0)) };
  }).filter((item) => item.stock_name && item.stock_code && item.combined_summary && item.viewpoints.length).slice(0, 8);
  const quality = taogubaPart.quality && typeof taogubaPart.quality === "object" ? taogubaPart.quality : {};
  const cnNews = normalizeNews(news.cn_news, "cn_news");
  const usNews = normalizeNews(news.us_news, "us_news");
  const allNews = [...cnNews, ...usNews];
  const sameDaySummaries = allNews.filter((item) => item.publish_time.slice(0, 10) === targetDate).length;
  const previousDate = fallback.time_window.start.slice(0, 10);
  const previousDaySummaries = allNews.filter((item) => item.publish_time.slice(0, 10) === previousDate).length;
  const latestSummary = allNews.map((item) => item.publish_time).filter(Boolean).sort().at(-1) || "";
  const suppliedSourceQuality = result.source_quality?.news && typeof result.source_quality.news === "object" ? result.source_quality.news : {};
  const suppliedRefresh = suppliedSourceQuality.refresh && typeof suppliedSourceQuality.refresh === "object" ? suppliedSourceQuality.refresh : {};
  const newsQualityStatus = sameDaySummaries > 0 ? "fresh" : allNews.length ? "stale" : "empty";
  const sourceQuality = {
    status: newsQualityStatus,
    source_record_count: Math.max(allNews.length, Number(suppliedSourceQuality.source_record_count || 0)),
    same_day_source_count: Math.max(0, Number(suppliedSourceQuality.same_day_source_count || 0)),
    previous_day_source_count: Math.max(previousDaySummaries, Number(suppliedSourceQuality.previous_day_source_count || 0)),
    same_day_summary_count: sameDaySummaries,
    latest_source_publish_time: String(suppliedSourceQuality.latest_source_publish_time || latestSummary),
    latest_summary_publish_time: latestSummary,
    refresh: {
      status: String(suppliedRefresh.status || "unknown"),
      fetched: Math.max(0, Number(suppliedRefresh.fetched || 0)), inserted: Math.max(0, Number(suppliedRefresh.inserted || 0)),
      successful_calls: Math.max(0, Number(suppliedRefresh.successful_calls || 0)), failed_calls: Math.max(0, Number(suppliedRefresh.failed_calls || 0)),
      failure_kinds: (Array.isArray(suppliedRefresh.failure_kinds) ? suppliedRefresh.failure_kinds : []).map(String).slice(0, 8),
    },
    message: newsQualityStatus === "fresh" ? `今日已展示${sameDaySummaries}条，最新原文${latestSummary}` : allNews.length ? `今日暂无可展示新闻；当前最新原文${latestSummary}` : "时间窗内没有可展示新闻",
  };
  return {
    generate_datetime: String(result.generate_datetime || fallback.generate_datetime),
    time_window: {
      start: String(result.time_window?.start || fallback.time_window.start),
      end: String(result.time_window?.end || fallback.time_window.end),
    },
    news_part: {
      cn_news: cnNews,
      us_news: usNews,
    },
    source_quality: { news: sourceQuality },
    taoguba_top10: normalizeTaoguba(result.taoguba_top10),
    taoguba_part: {
      industry_consensus: normalizeIndustry(taogubaPart.industry_consensus),
      influencer_stock_views: normalizeInfluencers(taogubaPart.influencer_stock_views),
      quality: { source_post_count: Math.max(0, Number(quality.source_post_count || 0)), candidate_post_count: Math.max(0, Number(quality.candidate_post_count || 0)), industry_group_count: Math.max(0, Number(quality.industry_group_count || 0)), verified_stock_post_count: Math.max(0, Number(quality.verified_stock_post_count || 0)), latest_post_time: String(quality.latest_post_time || ""), classification: String(quality.classification || "") },
    },
    note: RISK_NOTE,
  };
}

export function savePreopenSummary(db, task, targetDate = shanghaiDate()) {
  const payload = normalizedPayload(task?.payload, targetDate);
  const errors = task?.errors && typeof task.errors === "object" ? { ...task.errors } : {};
  const fresh = payload.source_quality.news.status === "fresh" && payload.source_quality.news.same_day_summary_count > 0;
  if (!fresh && !errors.news_freshness) errors.news_freshness = `${targetDate}没有可展示的当日新闻，已保留昨日缓存并等待自动补抓`;
  const requestedStatus = String(task?.status || "partial");
  const effectiveStatus = requestedStatus === "success" && !fresh ? "partial" : requestedStatus;
  db.prepare(`INSERT INTO preopen_daily_summaries(summary_date,generate_datetime,window_start,window_end,status,payload_json,news_source_count,taoguba_source_count,llm_model,error_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(summary_date) DO UPDATE SET generate_datetime=excluded.generate_datetime,window_start=excluded.window_start,window_end=excluded.window_end,status=excluded.status,payload_json=excluded.payload_json,news_source_count=excluded.news_source_count,taoguba_source_count=excluded.taoguba_source_count,llm_model=excluded.llm_model,error_json=excluded.error_json,updated_at=CURRENT_TIMESTAMP`)
    .run(targetDate, payload.generate_datetime, payload.time_window.start, payload.time_window.end, effectiveStatus, JSON.stringify(payload), Number(task?.source_counts?.news || 0), Number(task?.source_counts?.taoguba || 0), "deepseek-chat", JSON.stringify(errors));
  return getPreopenSummary(db, targetDate);
}

export function getPreopenSummary(db, targetDate = shanghaiDate()) {
  ensurePreopenSchedule(db);
  const row = db.prepare("SELECT * FROM preopen_daily_summaries WHERE summary_date=?").get(targetDate);
  if (!row) return emptyPreopenPayload(targetDate);
  return normalizedPayload(parseJson(row.payload_json, null), targetDate);
}

export function preopenStatus(db, targetDate = shanghaiDate()) {
  const row = db.prepare("SELECT summary_date,generate_datetime,status,news_source_count,taoguba_source_count,llm_model,error_json,payload_json,updated_at FROM preopen_daily_summaries WHERE summary_date=?").get(targetDate);
  if (!row) return { summary_date: targetDate, status: "missing", news_source_count: 0, taoguba_source_count: 0, llm_model: "deepseek-chat", errors: {}, source_quality: emptyPreopenPayload(targetDate).source_quality };
  const payload = normalizedPayload(parseJson(row.payload_json, null), targetDate);
  const publicRow = { ...row };
  delete publicRow.payload_json;
  return { ...publicRow, errors: parseJson(row.error_json, {}), source_quality: payload.source_quality };
}
