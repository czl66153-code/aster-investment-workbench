import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestPublishedVersion, linkDatasetVersion, resolveOpenAlert, upsertOpenAlert } from "./maintenance.mjs";

const engineDir = dirname(fileURLToPath(import.meta.url));
export const projectDir = dirname(engineDir);
export const databasePath = process.env.ASTER_DB_PATH || join(projectDir, "data", "aster.db");
const newsSearchPath = process.env.ASTER_NEWS_SEARCH_DB || join(projectDir, "data", "news_search.sqlite");
let newsSearchDatabase = null;

export const factorDefinitions = [
  { key: "close", name: "最新价", group: "基础量价", unit: "元", direction: "desc", usedBy: [] },
  { key: "pct_chg", name: "当日涨跌幅", group: "基础量价", unit: "%", direction: "desc", usedBy: ["ABCD"] },
  { key: "amount", name: "成交额", group: "基础量价", unit: "元", direction: "desc", usedBy: ["ABCD"] },
  { key: "turnover_rate", name: "换手率", group: "基础量价", unit: "%", direction: "desc", usedBy: ["AIA"] },
  { key: "volume_ratio_20", name: "20日量比", group: "基础量价", unit: "倍", direction: "desc", usedBy: ["ABCD", "热度优先"] }, // gitleaks:allow -- public factor identifier, not a credential
  { key: "ret_5d", name: "5日动量", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["AIA"] },
  { key: "ret_10d", name: "10日动量", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["每日候选"] },
  { key: "ret_20d", name: "20日动量", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["AIA", "热度优先"] },
  { key: "ret_30d", name: "30日动量", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["每日候选"] },
  { key: "ret_60d", name: "60日涨幅", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["每日候选"] },
  { key: "stock_ret_5d_rank", name: "全市场5日涨幅排名", group: "横截面排名", unit: "名", direction: "asc", usedBy: ["每日候选"] },
  { key: "stock_ret_10d_rank", name: "全市场10日涨幅排名", group: "横截面排名", unit: "名", direction: "asc", usedBy: ["每日候选"] }, // gitleaks:allow -- public factor identifier, not a credential
  { key: "stock_ret_30d_rank", name: "全市场30日涨幅排名", group: "横截面排名", unit: "名", direction: "asc", usedBy: ["每日候选"] }, // gitleaks:allow -- public factor identifier, not a credential
  { key: "stock_ret_60d_rank", name: "全市场60日涨幅排名", group: "横截面排名", unit: "名", direction: "asc", usedBy: ["每日候选"] }, // gitleaks:allow -- public factor identifier, not a credential
  { key: "stock_top50_5_10_30", name: "5/10/30日涨幅前50交集", group: "横截面排名", unit: "布尔", direction: "desc", usedBy: ["每日候选"] },
  { key: "sector_ret_5d", name: "所属板块5日涨幅", group: "板块与热度", unit: "%", direction: "desc", usedBy: ["每日候选"] },
  { key: "sector_ret_5d_rank", name: "所属板块5日涨幅排名", group: "板块与热度", unit: "名", direction: "asc", usedBy: ["每日候选"] },
  { key: "sector_ret_5d_rank_pct", name: "所属板块5日排名百分位", group: "板块与热度", unit: "%", direction: "asc", usedBy: ["每日候选"] },
  { key: "sector_4d_streak", name: "板块四日连涨", group: "板块与热度", unit: "是/否", direction: "desc", usedBy: ["每日候选"], filterOnly: true },
  { key: "bigquant_heat_rank", name: "BigQuant热度排名", group: "板块与热度", unit: "名", direction: "asc", usedBy: ["每日候选", "热度优先"] },
  { key: "bigquant_heat_rank_pct", name: "BigQuant热度排名百分位", group: "板块与热度", unit: "%", direction: "asc", usedBy: ["每日候选", "热度优先"] },
  { key: "bigquant_heat_score", name: "BigQuant热度分", group: "板块与热度", unit: "分", direction: "desc", usedBy: ["每日候选", "热度优先"] },
  { key: "bias_ma20", name: "相对20日均线偏离", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["AIA"] },
  { key: "breakout_20", name: "20日突破", group: "趋势与风险", unit: "布尔", direction: "desc", usedBy: ["AIA", "热度优先"] },
  { key: "volatility_20", name: "20日波动率", group: "趋势与风险", unit: "%", direction: "asc", usedBy: ["风控"] },
  { key: "drawdown_20", name: "20日最大回撤", group: "趋势与风险", unit: "%", direction: "desc", usedBy: ["风控"] },
  { key: "formal_model_score", name: "正式筹码模型分", group: "双筹码模型", unit: "分", direction: "desc", usedBy: ["ABCD"] },
  { key: "formal_model_rank_pct", name: "正式筹码模型排名百分位", group: "双筹码模型", unit: "%", direction: "asc", usedBy: ["ABCD"] },
  { key: "candidate_model_score", name: "候选筹码模型分", group: "双筹码模型", unit: "分", direction: "desc", usedBy: ["研究"] },
  { key: "candidate_model_rank_pct", name: "候选筹码模型排名百分位", group: "双筹码模型", unit: "%", direction: "asc", usedBy: ["研究"] },
  { key: "multi_period_model_score", name: "多周期候选筹码模型分", group: "待建筹码模型", unit: "分", direction: "desc", usedBy: ["量价筛选"], availability: "training_required" },
  { key: "multi_period_model_rank_pct", name: "多周期候选筹码模型排名百分位", group: "待建筹码模型", unit: "%", direction: "asc", usedBy: ["量价筛选"], availability: "training_required" },
  { key: "chip_cost_peak_distance_pct", name: "成本均线与主峰有向距离", group: "双筹码模型", unit: "%", direction: "asc", usedBy: ["正式筹码模型", "候选筹码模型"] },
  { key: "chip_cost_peak_abs_distance_rank_pct", name: "成本均线与主峰绝对距离排名百分位", group: "双筹码模型", unit: "%", direction: "asc", usedBy: ["正式筹码模型", "候选筹码模型"] },
  { key: "abcd_a_score", name: "A·板块强度分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["ABCD"] },
  { key: "abcd_b_score", name: "B·个股量价热度分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["ABCD"] },
  { key: "abcd_c_score", name: "C·行业龙头分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["ABCD"] },
  { key: "abcd_d_score", name: "D·筹码形态分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["ABCD"] },
  { key: "latest_signal_score", name: "最新ABCD全市场综合分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["ABCD", "盘中筛选"] },
  { key: "latest_signal_rank_pct", name: "最新ABCD全市场排名百分位", group: "推荐判断因子", unit: "%", direction: "asc", usedBy: ["ABCD", "盘中筛选"] },
  { key: "aia_sector_heat", name: "板块热度（AIA）", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["AIA"] },
  { key: "aia_stock_heat", name: "个股热度（AIA）", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["AIA"] },
  { key: "aia_leadership", name: "龙头地位（AIA）", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["AIA"] },
  { key: "aia_technical_pattern", name: "技术形态（AIA）", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["AIA"] },
  { key: "m30_similarity", name: "30分钟模板相似度", group: "推荐判断因子", unit: "%", direction: "desc", usedBy: ["AIA"] },
  { key: "five_platform_heat", name: "五平台综合热度", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["热度优先"] },
  { key: "four_agent_score", name: "四策略确认分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["热度优先"] },
  { key: "industry_ret_4d", name: "板块4日动量", group: "推荐判断因子", unit: "%", direction: "desc", usedBy: ["热度优先"] },
  { key: "taoguba_sentiment", name: "淘股吧社区情绪", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["热度优先"] },
  { key: "daily_breakout_score", name: "日线启动突破分", group: "推荐判断因子", unit: "分", direction: "desc", usedBy: ["热度优先"] },
];
const filterOnlyFactors = new Set(factorDefinitions.filter((item) => item.filterOnly).map((item) => item.key));

export const modelWeightSpecs = {
  abcd: {
    displayName: "盘中 ABCD",
    groups: {
      ranking: { label: "ABCD 总分构成", items: { a: "A·板块强度", b: "B·个股量价热度", c: "C·行业龙头", d: "D·筹码形态" } },
    },
    defaults: { ranking: { a: 25, b: 25, c: 25, d: 25 } },
  },
  aia: {
    displayName: "AIA Top10",
    groups: {
      ranking: { label: "AIA 基础得分", items: { sector_heat: "板块热度", stock_popularity: "个股热度", leadership_status: "龙头地位", technical_pattern: "技术形态" } },
      bonuses: { label: "形态命中奖励分", allowZero: true, items: { two_hit_bonus: "命中2种形态", three_hit_bonus: "命中3种及以上" } },
    },
    defaults: { ranking: { sector_heat: 31.818182, stock_popularity: 31.818182, leadership_status: 18.181818, technical_pattern: 18.181818 }, bonuses: { two_hit_bonus: 3, three_hit_bonus: 5 } },
  },
  heat: {
    displayName: "热度优先",
    groups: {
      platforms: { label: "五平台热度构成", items: { xueqiu: "雪球", eastmoney: "东方财富", tonghuashun: "同花顺", taoguba: "淘股吧", kaipanla: "开盘啦" } },
      stage_one: { label: "第一阶段候选分", items: { five_platform_heat: "五平台热度", four_agent_rank: "四策略排名", yesterday_sector_momentum: "昨日板块动量", original_8002_ex_size: "8002原选股分（剔除市值）", taoguba_sentiment: "淘股吧情绪", daily_breakout: "日线启动突破" } },
      agents: { label: "第二阶段四策略分", items: { logic: "逻辑策略", technical: "技术策略", sector_heat: "板块热度策略", five_platform_heat: "五平台热度策略" } },
    },
    defaults: {
      platforms: { xueqiu: 25, eastmoney: 25, tonghuashun: 20, taoguba: 15, kaipanla: 15 },
      stage_one: { five_platform_heat: 35, four_agent_rank: 25, yesterday_sector_momentum: 15, original_8002_ex_size: 10, taoguba_sentiment: 7.5, daily_breakout: 7.5 },
      agents: { logic: 25, technical: 25, sector_heat: 25, five_platform_heat: 25 },
    },
  },
};

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
}

function activeIntradayWindow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", weekday: "short", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((part) => [part.type, part.value]));
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 5;
}

function normalizedTimestampDate(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/[^0-9]/g, "");
  if (/^20\d{6}/.test(compact)) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const match = text.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function openDatabase() {
  if (!existsSync(databasePath)) throw new Error(`独立数据库不存在：${databasePath}`);
  const db = new DatabaseSync(databasePath);
  db.exec(readFileSync(join(engineDir, "schema.sql"), "utf8"));
  const quoteColumns = new Set(db.prepare("PRAGMA table_info(realtime_quotes)").all().map((column) => column.name));
  if (!quoteColumns.has("open_price")) db.exec("ALTER TABLE realtime_quotes ADD COLUMN open_price REAL");
  if (!quoteColumns.has("volume")) db.exec("ALTER TABLE realtime_quotes ADD COLUMN volume REAL");
  if (!quoteColumns.has("unit_version")) db.exec("ALTER TABLE realtime_quotes ADD COLUMN unit_version TEXT");
  if (!quoteColumns.has("turnover_source")) db.exec("ALTER TABLE realtime_quotes ADD COLUMN turnover_source TEXT");
  if (!quoteColumns.has("unit_audit_json")) db.exec("ALTER TABLE realtime_quotes ADD COLUMN unit_audit_json TEXT");
  const rawDailyColumns = new Set(db.prepare("PRAGMA table_info(raw_daily_bars)").all().map((column) => column.name));
  if (!rawDailyColumns.has("unit_version")) db.exec("ALTER TABLE raw_daily_bars ADD COLUMN unit_version TEXT");
  if (!rawDailyColumns.has("volume_unit")) db.exec("ALTER TABLE raw_daily_bars ADD COLUMN volume_unit TEXT");
  if (!rawDailyColumns.has("amount_unit")) db.exec("ALTER TABLE raw_daily_bars ADD COLUMN amount_unit TEXT");
  const dailyColumns = new Set(db.prepare("PRAGMA table_info(bars_daily)").all().map((column) => column.name));
  if (!dailyColumns.has("unit_version")) db.exec("ALTER TABLE bars_daily ADD COLUMN unit_version TEXT");
  if (!dailyColumns.has("volume_unit")) db.exec("ALTER TABLE bars_daily ADD COLUMN volume_unit TEXT");
  if (!dailyColumns.has("amount_unit")) db.exec("ALTER TABLE bars_daily ADD COLUMN amount_unit TEXT");
  const m30Columns = new Set(db.prepare("PRAGMA table_info(bars_30m)").all().map((column) => column.name));
  if (!m30Columns.has("unit_version")) db.exec("ALTER TABLE bars_30m ADD COLUMN unit_version TEXT");
  if (!m30Columns.has("volume_unit")) db.exec("ALTER TABLE bars_30m ADD COLUMN volume_unit TEXT");
  if (!m30Columns.has("amount_unit")) db.exec("ALTER TABLE bars_30m ADD COLUMN amount_unit TEXT");
  if (!m30Columns.has("unit_repair_note")) db.exec("ALTER TABLE bars_30m ADD COLUMN unit_repair_note TEXT");
  const batchColumns = new Set(db.prepare("PRAGMA table_info(recommendation_batches)").all().map((column) => column.name));
  if (!batchColumns.has("factor_version_id")) db.exec("ALTER TABLE recommendation_batches ADD COLUMN factor_version_id TEXT");
  if (!batchColumns.has("quote_version_id")) db.exec("ALTER TABLE recommendation_batches ADD COLUMN quote_version_id TEXT");
  const chipSampleColumns = new Set(db.prepare("PRAGMA table_info(chip_samples)").all().map((column) => column.name));
  if (!chipSampleColumns.has("sample_label")) db.exec("ALTER TABLE chip_samples ADD COLUMN sample_label INTEGER NOT NULL DEFAULT 1");
  for (const column of ["main_peak_price", "second_peak_price", "profit_ratio", "peak2_ratio", "peak_width_70"]) {
    if (!chipSampleColumns.has(column)) db.exec(`ALTER TABLE chip_samples ADD COLUMN ${column} REAL`);
  }
  const experimentalChipSampleColumns = new Set(db.prepare("PRAGMA table_info(experimental_chip_samples)").all().map((column) => column.name));
  if (!experimentalChipSampleColumns.has("sample_label")) db.exec("ALTER TABLE experimental_chip_samples ADD COLUMN sample_label INTEGER NOT NULL DEFAULT 1");
  const screenerStrategyColumns = new Set(db.prepare("PRAGMA table_info(saved_screener_strategies)").all().map((column) => column.name));
  if (!screenerStrategyColumns.has("rule_tag")) db.exec("ALTER TABLE saved_screener_strategies ADD COLUMN rule_tag TEXT NOT NULL DEFAULT '自定义'");
  if (!screenerStrategyColumns.has("archived_at")) db.exec("ALTER TABLE saved_screener_strategies ADD COLUMN archived_at TEXT");
  const chipRankColumns = new Set(db.prepare("PRAGMA table_info(chip_model_rank_daily)").all().map((column) => column.name));
  for (const [column, type] of [["multi_period_score", "REAL"], ["multi_period_rank", "INTEGER"], ["multi_period_rank_pct", "REAL"], ["multi_period_model_version", "TEXT"]]) {
    if (!chipRankColumns.has(column)) db.exec(`ALTER TABLE chip_model_rank_daily ADD COLUMN ${column} ${type}`);
  }
  const intradayFactorColumns = new Set(db.prepare("PRAGMA table_info(intraday_factor_score_snapshot)").all().map((column) => column.name));
  for (const column of ["chip_model_version", "shape_score_version", "distribution_mode", "source_quote_time"]) {
    if (!intradayFactorColumns.has(column)) db.exec(`ALTER TABLE intraday_factor_score_snapshot ADD COLUMN ${column} TEXT`);
  }
  const extendedFactors = {
    ret_10d: "REAL", ret_30d: "REAL", ret_60d: "REAL",
    stock_ret_5d_rank: "INTEGER", stock_ret_10d_rank: "INTEGER", stock_ret_30d_rank: "INTEGER", stock_ret_60d_rank: "INTEGER",
    stock_top50_5_10_30: "INTEGER NOT NULL DEFAULT 0",
    sector_ret_5d: "REAL", sector_ret_5d_rank: "INTEGER", sector_ret_5d_rank_pct: "REAL", sector_4d_streak: "INTEGER NOT NULL DEFAULT 0",
    bigquant_heat_score: "REAL", bigquant_heat_rank: "INTEGER", bigquant_heat_rank_pct: "REAL", bigquant_heat_date: "TEXT",
    chip_cost_peak_distance_pct: "REAL", chip_cost_peak_abs_distance_rank_pct: "REAL",
  };
  for (const table of ["factor_snapshot", "market_factor_snapshot"]) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [column, type] of Object.entries(extendedFactors)) {
      if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const insertWeight = db.prepare("INSERT OR IGNORE INTO model_weight_configs(model_key,display_name,mode,weights_json,default_weights_json,metadata_json,revision) VALUES(?,?,'original',?,?,?,1)");
  for (const [modelKey, spec] of Object.entries(modelWeightSpecs)) {
    insertWeight.run(modelKey, spec.displayName, JSON.stringify(spec.defaults), JSON.stringify(spec.defaults), JSON.stringify(spec.groups));
  }
  db.prepare(`INSERT OR IGNORE INTO experimental_chip_models(scope,display_name,model_version,factor_spec_json,sample_count,ready_count,revision,applied_revision,pending_retrain,production_enabled,status)
    VALUES('multi_period','多周期候选筹码模型','not_trained',?,0,0,1,0,0,0,'sample_collection')`).run(JSON.stringify({
      intendedUse: "5/10/30日涨幅前50交集+板块5日强势+BigQuant热度前200后的筹码形态排序",
      candidateFactor: "成本均线与主峰距离",
      trainingGate: "独立正样本库建立并完成逐交易日样本外验证后方可申请上线",
    }));
  db.exec("PRAGMA optimize");
  db.exec("PRAGMA user_version=2");
  db.prepare("UPDATE schedule_definitions SET cron_text='交易日收盘后16:30起，每30分钟检查；双源就绪即停止',retry_limit=1,quality_gate='BigQuant与Tushare必须为同一最新交易日且各自覆盖≥95%；正式采集层强制股/元，8010兼容层强制手/千元；两层VWAP均须落在日内高低价±5%，复权因子同日覆盖；任一失败不发布',updated_at=CURRENT_TIMESTAMP WHERE schedule_key='after_close'").run();
  db.prepare("UPDATE schedule_definitions SET cron_text='交易日09:25预热；AKShare行情盘中持续更新；ABCD于09:45自动生成首批，其后按需手动重算',retry_limit=1,quality_gate='仅AKShare当日行情；证券主表覆盖率≥95%；所有源强制归一为价格元/股、成交量股、成交额元、涨跌幅/换手率百分点；ABCD手动重算不改写模拟账户09:45快照；异常批次不发布',updated_at=CURRENT_TIMESTAMP WHERE schedule_key='intraday_quotes'").run();
  db.prepare("UPDATE model_definitions SET refresh_mode='scheduled_0945+manual',refresh_seconds=NULL,updated_at=CURRENT_TIMESTAMP WHERE model_key='abcd'").run();
  db.prepare("UPDATE schedule_definitions SET cron_text='正式日线发布后20:30起；失败每2小时最多重试',retry_limit=1,quality_gate='正式日线已由BigQuant+Tushare同日确认；筹码与双模型同截面发布；8010原版可评分池占正式池≥85%，池内ABCD四项各覆盖≥95%',updated_at=CURRENT_TIMESTAMP WHERE schedule_key='night_models'").run();
  if (!newsSearchDatabase && existsSync(newsSearchPath)) {
    newsSearchDatabase = new DatabaseSync(newsSearchPath, { readOnly: true });
    newsSearchDatabase.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000");
  }
  return db;
}

function governedFactorVersion(db) {
  return db.prepare(`SELECT f.* FROM dataset_versions f
    JOIN dataset_dependencies d ON d.child_dataset_key='factor_snapshot' AND d.child_version_id=f.version_id
    JOIN dataset_versions p ON p.dataset_key=d.parent_dataset_key AND p.version_id=d.parent_version_id
    WHERE f.dataset_key='factor_snapshot' AND f.status='published'
      AND d.parent_dataset_key='formal_daily' AND p.status='published'
      AND p.source LIKE '%bigquant%' AND p.source LIKE '%tushare%'
      AND f.trade_date=p.trade_date
    ORDER BY f.created_at DESC LIMIT 1`).get() || null;
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, value)); }

function percentile(values, value, higherBetter = true) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length || !Number.isFinite(Number(value))) return 50;
  let below = 0;
  while (below < clean.length && clean[below] <= Number(value)) below += 1;
  const score = clean.length <= 1 ? 50 : (below - 1) * 100 / (clean.length - 1);
  return higherBetter ? score : 100 - score;
}

function percentileLookup(values, higherBetter = true) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length <= 1) return () => 50;
  const denominator = clean.length - 1;
  const scores = new Map();
  for (let index = 0; index < clean.length; index += 1) {
    if (index === clean.length - 1 || clean[index + 1] !== clean[index]) {
      const score = index * 100 / denominator;
      scores.set(clean[index], higherBetter ? score : 100 - score);
    }
  }
  return (value) => scores.get(Number(value)) ?? 50;
}

function abcdScoreWeights(db) {
  const fallback = { a: 25, b: 25, c: 25, d: 25 };
  try {
    const row = db.prepare("SELECT weights_json FROM model_weight_configs WHERE model_key='abcd'").get();
    const configured = JSON.parse(row?.weights_json || "{}").ranking || {};
    const weights = Object.fromEntries(Object.keys(fallback).map((key) => [key, Math.max(0, numeric(configured[key], fallback[key]))]));
    return Object.values(weights).some((value) => value > 0) ? weights : fallback;
  } catch { return fallback; }
}

function latestFactors(db) {
  const useRealtime = activeIntradayWindow();
  const today = shanghaiDate();
  const governed = governedFactorVersion(db);
  const factorDate = normalizedTimestampDate(governed?.trade_date);
  const rankDate = governed
    ? db.prepare("SELECT MAX(trade_date) AS date FROM chip_model_rank_daily WHERE trade_date<=?").get(governed.trade_date)?.date || null
    : db.prepare("SELECT MAX(trade_date) AS date FROM chip_model_rank_daily").get()?.date || null;
  const intradayState = db.prepare(`SELECT trade_date,MAX(score_time) AS score_time,MAX(source) AS source,
      MAX(chip_model_version) AS chip_model_version,MAX(shape_score_version) AS shape_score_version,
      MAX(distribution_mode) AS distribution_mode,MAX(source_quote_time) AS source_quote_time,COUNT(*) AS rows
    FROM intraday_factor_score_snapshot`).get();
  const intradayDate = normalizedTimestampDate(intradayState?.trade_date);
  const hasIntradayLineage = Boolean(intradayState?.chip_model_version && intradayState?.shape_score_version && intradayState?.distribution_mode);
  const useIntradayScores = intradayDate === today && (!factorDate || intradayDate > factorDate)
    && Number(intradayState?.rows || 0) > 0 && hasIntradayLineage;
  const weights = abcdScoreWeights(db);
  const scoreColumns = `i.trade_date AS intraday_score_trade_date,i.score_time AS intraday_score_time,i.source AS intraday_score_source,
      i.abcd_a_score AS intraday_abcd_a_score,i.abcd_b_score AS intraday_abcd_b_score,
      i.abcd_c_score AS intraday_abcd_c_score,i.abcd_d_score AS intraday_abcd_d_score`;
  const enrich = (row, canonical = false) => {
    const quoteOverlay = useRealtime && normalizedTimestampDate(row.quote_time) === today;
    const scoreOverlay = useIntradayScores && normalizedTimestampDate(row.intraday_score_trade_date) === intradayDate;
    const scores = Object.fromEntries(["a", "b", "c", "d"].map((key) => {
      const intraday = row[`intraday_abcd_${key}_score`];
      if (useIntradayScores) return [key, scoreOverlay && Number.isFinite(Number(intraday)) ? Number(intraday) : null];
      return [key, row[`abcd_${key}_score`]];
    }));
    const activeWeight = Object.entries(weights).filter(([, value]) => Number(value) > 0);
    const complete = activeWeight.every(([key]) => scores[key] !== null && scores[key] !== undefined && scores[key] !== "" && Number.isFinite(Number(scores[key])));
    const totalWeight = activeWeight.reduce((sum, [, value]) => sum + Number(value), 0);
    const latestScore = complete && totalWeight > 0
      ? activeWeight.reduce((sum, [key, value]) => sum + Number(scores[key]) * Number(value), 0) / totalWeight
      : null;
    return {
      ...row,
      formal_model_score: canonical ? (row.canonical_formal_model_score ?? row.formal_model_score) : row.formal_model_score,
      formal_model_rank: canonical ? (row.canonical_formal_model_rank ?? row.formal_model_rank) : row.formal_model_rank,
      formal_model_rank_pct: canonical ? (row.canonical_formal_model_rank_pct ?? row.formal_model_rank_pct) : row.formal_model_rank_pct,
      candidate_model_score: canonical ? (row.canonical_candidate_model_score ?? row.candidate_model_score) : row.candidate_model_score,
      candidate_model_rank: canonical ? (row.canonical_candidate_model_rank ?? row.candidate_model_rank) : row.candidate_model_rank,
      candidate_model_rank_pct: canonical ? (row.canonical_candidate_model_rank_pct ?? row.candidate_model_rank_pct) : row.candidate_model_rank_pct,
      multi_period_model_score: canonical ? (row.canonical_multi_period_model_score ?? row.multi_period_model_score) : row.multi_period_model_score,
      multi_period_model_rank: canonical ? (row.canonical_multi_period_model_rank ?? row.multi_period_model_rank) : row.multi_period_model_rank,
      multi_period_model_rank_pct: canonical ? (row.canonical_multi_period_model_rank_pct ?? row.multi_period_model_rank_pct) : row.multi_period_model_rank_pct,
      model_rank_trade_date: rankDate,
      abcd_a_score: scores.a, abcd_b_score: scores.b, abcd_c_score: scores.c, abcd_d_score: scores.d,
      latest_signal_score: latestScore,
      latest_score_trade_date: useIntradayScores ? intradayDate : factorDate,
      latest_score_as_of: useIntradayScores ? intradayState.score_time : governed?.published_at || factorDate,
      latest_score_source: useIntradayScores ? intradayState.source : "formal_bigquant_tushare_abcd_snapshot",
      latest_score_mode: useIntradayScores ? "intraday" : "official",
      latest_score_lineage: useIntradayScores ? {
        chipModelVersion: intradayState.chip_model_version,
        shapeScoreVersion: intradayState.shape_score_version,
        distributionMode: intradayState.distribution_mode,
        sourceQuoteTime: intradayState.source_quote_time,
      } : null,
      close: quoteOverlay ? (row.realtime_price ?? row.close) : row.close,
      pct_chg: quoteOverlay ? (row.realtime_pct_chg ?? row.pct_chg) : row.pct_chg,
      amount: quoteOverlay ? (row.realtime_amount ?? row.amount) : row.amount,
      turnover_rate: quoteOverlay ? (row.realtime_turnover ?? row.turnover_rate) : row.turnover_rate,
      quote_time: quoteOverlay ? row.quote_time : null,
    };
  };
  const research = governed ? db.prepare(`SELECT f.*,
      c.formal_score AS canonical_formal_model_score,c.formal_rank AS canonical_formal_model_rank,c.formal_rank_pct AS canonical_formal_model_rank_pct,
      c.candidate_score AS canonical_candidate_model_score,c.candidate_rank AS canonical_candidate_model_rank,c.candidate_rank_pct AS canonical_candidate_model_rank_pct,
      c.multi_period_score AS canonical_multi_period_model_score,c.multi_period_rank AS canonical_multi_period_model_rank,c.multi_period_rank_pct AS canonical_multi_period_model_rank_pct,
      ${scoreColumns},q.price AS realtime_price,q.pct_chg AS realtime_pct_chg,q.amount AS realtime_amount,q.turnover_rate AS realtime_turnover,q.quote_time
    FROM factor_snapshot f
    LEFT JOIN chip_model_rank_daily c ON c.code=f.code AND c.trade_date=?
    LEFT JOIN intraday_factor_score_snapshot i ON i.code=f.code
    LEFT JOIN realtime_quotes q ON q.code=f.code
    WHERE f.trade_date=?`).all(rankDate, governed.trade_date).map((row) => enrich(row, true)) : [];
  const researchCodes = new Set(research.map((row) => row.code));
  const market = db.prepare(`SELECT m.*,
      c.formal_score AS formal_model_score,c.formal_rank AS formal_model_rank,c.formal_rank_pct AS formal_model_rank_pct,
      c.candidate_score AS candidate_model_score,c.candidate_rank AS candidate_model_rank,c.candidate_rank_pct AS candidate_model_rank_pct,
      c.multi_period_score AS multi_period_model_score,c.multi_period_rank AS multi_period_model_rank,c.multi_period_rank_pct AS multi_period_model_rank_pct,
      CASE WHEN c.formal_rank_pct IS NULL THEN NULL ELSE 100-c.formal_rank_pct END AS abcd_d_score,
      ${scoreColumns},q.price AS realtime_price,q.pct_chg AS realtime_pct_chg,q.amount AS realtime_amount,q.turnover_rate AS realtime_turnover,q.quote_time
    FROM market_factor_snapshot m
    LEFT JOIN chip_model_rank_daily c ON c.code=m.code AND c.trade_date=?
    LEFT JOIN intraday_factor_score_snapshot i ON i.code=m.code
    LEFT JOIN realtime_quotes q ON q.code=m.code
    WHERE m.trade_date=(SELECT MAX(trade_date) FROM market_factor_snapshot)`).all(rankDate)
    .filter((row) => !researchCodes.has(row.code)).map((row) => enrich(row, false));
  const combined = [...research, ...market];
  const ranked = combined.filter((row) => row.latest_signal_score !== null && row.latest_signal_score !== undefined && Number.isFinite(Number(row.latest_signal_score)))
    .sort((left, right) => Number(right.latest_signal_score) - Number(left.latest_signal_score) || String(left.code).localeCompare(String(right.code)));
  const rankByCode = new Map(ranked.map((row, index) => [row.code, index + 1]));
  return combined.map((row) => {
    const rank = rankByCode.get(row.code) || null;
    return { ...row, latest_signal_rank: rank, latest_signal_rank_pct: rank ? rank * 100 / ranked.length : null };
  });
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key] || "其他";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function modelInfo(db, modelKey) {
  return db.prepare("SELECT * FROM model_definitions WHERE model_key=?").get(modelKey);
}

function recommendationGate(db, modelKey, items) {
  // ABCD's original D>99.5 hard gate is intentionally sparse: one qualified
  // symbol is still a complete and publishable original-model result.
  const minimum = { abcd: 1, aia: 8, heat: 5 }[modelKey] || 1;
  const factor = db.prepare("SELECT COUNT(*) AS count,SUM(CASE WHEN close IS NULL OR ret_20d IS NULL THEN 1 ELSE 0 END) AS missing FROM factor_snapshot WHERE trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)").get();
  const codes = new Set(items.map((item) => item.code));
  const validCodes = new Set(db.prepare(`SELECT code FROM securities WHERE code IN (${items.map(() => "?").join(",") || "NULL"})`).all(...items.map((item) => item.code)).map((row) => row.code));
  const failures = [];
  const governed = governedFactorVersion(db);
  if (!governed) failures.push("没有通过BigQuant+Tushare双源血缘门禁的正式因子版本");
  if (items.length < minimum) failures.push(`结果数${items.length}低于${minimum}`);
  if (codes.size !== items.length) failures.push("存在重复股票");
  if (validCodes.size !== items.length) failures.push("存在非A股证券主表代码");
  if (items.some((item) => !Number.isFinite(Number(item.score)) || Number(item.score) < 0 || Number(item.score) > 100)) failures.push("模型分超出0–100范围");
  if (Number(factor?.count || 0) < 400) failures.push("因子覆盖少于400只");
  if (!factor?.count || Number(factor.missing || 0) / Number(factor.count) > .08) failures.push("关键因子空值率超过8%");
  return { pass: failures.length === 0, failures, minimum, factorCount: Number(factor?.count || 0) };
}

function recordRejectedBatch(db, modelKey, items, triggerType, failures) {
  const info = modelInfo(db, modelKey) || {};
  const now = new Date().toISOString();
  const batchId = `${modelKey}-${shanghaiDate()}-rejected-${Date.now()}-${randomUUID().slice(0, 6)}`;
  db.prepare("INSERT INTO recommendation_batches(batch_id,model_key,trade_date,status,trigger_type,source_mode,item_count,model_version,message,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(batchId, modelKey, shanghaiDate(), "rejected", triggerType, "independent_engine", items.length, info.version || "independent-v1", failures.join("；"), now, now);
  upsertOpenAlert(db, {
    severity: "warning",
    source: `recommendation_${modelKey}`,
    title: `${modelKey.toUpperCase()}推荐未发布`,
    message: `${failures.join("；")}；上一已发布版本继续生效。`,
  });
  return batchId;
}

function createPublishedBatch(db, modelKey, items, triggerType = "manual", sourceMode = "independent_engine", modelVersion = null, tradeDateOverride = null) {
  const info = modelInfo(db, modelKey) || {};
  const requestedTradeDate = String(tradeDateOverride || "").slice(0, 10);
  const tradeDate = /^20\d{2}-\d{2}-\d{2}$/.test(requestedTradeDate) ? requestedTradeDate : shanghaiDate();
  const now = new Date().toISOString();
  const batchId = `${modelKey}-${tradeDate}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const factorVersion = governedFactorVersion(db);
  const quoteVersion = latestPublishedVersion(db, "intraday_quotes");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE recommendation_batches SET status='superseded' WHERE model_key=? AND status='published'").run(modelKey);
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key=? AND status='published'").run(`recommendation_${modelKey}`);
    db.prepare("INSERT INTO recommendation_batches(batch_id,model_key,trade_date,status,trigger_type,source_mode,item_count,model_version,factor_version_id,quote_version_id,message,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(batchId, modelKey, tradeDate, "published", triggerType, sourceMode, items.length, modelVersion || info.version || "independent-v1", factorVersion?.version_id || null, quoteVersion?.version_id || null, "模型计算并通过完整性及数据血缘门禁", now, now);
    const insert = db.prepare("INSERT INTO recommendations(batch_id,model_key,trade_date,code,rank,score,reason,risk,confidence,payload_json,generated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    items.forEach((item, index) => insert.run(batchId, modelKey, tradeDate, item.code, index + 1, item.score, item.reason, item.risk, item.confidence || 0.72, JSON.stringify(item), now));
    const checksum = createHash("sha256").update(JSON.stringify(items.map((item) => [item.code, Number(item.score).toFixed(6)]))).digest("hex");
    db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at) VALUES(?,?,?,?,?,'published',?,100,?,?)")
      .run(`recommendation_${modelKey}`, batchId, tradeDate, items.length, checksum, sourceMode, now, now);
    linkDatasetVersion(db, `recommendation_${modelKey}`, batchId, "factor_snapshot", factorVersion?.version_id, "scored_from");
    if (quoteVersion && normalizedTimestampDate(quoteVersion.published_at) === tradeDate) linkDatasetVersion(db, `recommendation_${modelKey}`, batchId, "intraday_quotes", quoteVersion.version_id, "overlaid_with");
    resolveOpenAlert(db, `recommendation_${modelKey}`, `${modelKey.toUpperCase()}推荐未发布`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { batchId, modelKey, tradeDate, count: items.length, generatedAt: now };
}

function enrichIndustryStats(rows) {
  const groups = groupBy(rows, "industry");
  const stats = [];
  for (const [industry, items] of groups) {
    if (items.length < 2) continue;
    stats.push({
      industry,
      count: items.length,
      meanPct: items.reduce((sum, row) => sum + numeric(row.pct_chg), 0) / items.length,
      medianPct: [...items].map((row) => numeric(row.pct_chg)).sort((a, b) => a - b)[Math.floor(items.length / 2)],
      upRatio: items.filter((row) => numeric(row.pct_chg) > 0).length * 100 / items.length,
      meanAmount: items.reduce((sum, row) => sum + numeric(row.amount), 0) / items.length,
      heat: items.reduce((sum, row) => sum + numeric(row.previous_heat_score, 50), 0) / items.length,
    });
  }
  const meanPcts = stats.map((row) => row.meanPct);
  const medians = stats.map((row) => row.medianPct);
  const ratios = stats.map((row) => row.upRatio);
  const amounts = stats.map((row) => Math.log1p(row.meanAmount));
  stats.forEach((row) => { row.a = 0.34 * percentile(meanPcts, row.meanPct) + 0.18 * percentile(medians, row.medianPct) + 0.18 * percentile(ratios, row.upRatio) + 0.08 * percentile(amounts, Math.log1p(row.meanAmount)) + 0.22 * row.heat; });
  return new Map(stats.map((row) => [row.industry, row]));
}

function computeAbcd(db) {
  const rows = latestFactors(db);
  const industries = enrichIndustryStats(rows);
  const pctValues = rows.map((row) => row.pct_chg);
  const amountValues = rows.map((row) => Math.log1p(numeric(row.amount)));
  const volumeValues = rows.map((row) => row.volume_ratio_20);
  const candidates = [];
  for (const row of rows) {
    const sector = industries.get(row.industry);
    if (!sector) continue;
    const group = rows.filter((item) => item.industry === row.industry);
    const relativeReturn = percentile(group.map((item) => item.pct_chg), row.pct_chg);
    const relativeAmount = percentile(group.map((item) => item.amount), row.amount);
    const event = numeric(row.breakout_20) ? 92 : clamp(45 + numeric(row.pct_chg) * 4);
    const a = clamp(sector.a);
    const b = clamp(0.20 * percentile(pctValues, row.pct_chg) + 0.16 * percentile(amountValues, Math.log1p(numeric(row.amount))) + 0.12 * percentile(volumeValues, row.volume_ratio_20) + 0.08 * event + 0.44 * numeric(row.previous_heat_score, 50));
    const c = clamp(0.42 * relativeReturn + 0.23 * relativeAmount + 0.15 * numeric(row.aia_leadership, 50) + 0.20 * event);
    const d = clamp(100 - numeric(row.formal_model_rank_pct, 100));
    const score = (a + b + c + d) / 4;
    if (numeric(row.pct_chg) <= 0 || d < 55 || a < 45 || b < 45) continue;
    candidates.push({ ...row, a, b, c, d, score, reason: `${row.industry}板块强度${a.toFixed(1)}，量价热度${b.toFixed(1)}，龙头性${c.toFixed(1)}，正式筹码模型${d.toFixed(1)}`, risk: numeric(row.volatility_20) > 0.45 ? "波动率偏高，控制追涨风险" : "若板块强度或量能回落，信号将失效", confidence: clamp(score / 100, .45, .92) });
  }
  const diversified = [];
  const industryCount = new Map();
  for (const item of candidates.sort((a, b) => b.score - a.score)) {
    if ((industryCount.get(item.industry) || 0) >= 2) continue;
    diversified.push(item); industryCount.set(item.industry, (industryCount.get(item.industry) || 0) + 1);
    if (diversified.length >= 8) break;
  }
  const update = db.prepare("UPDATE factor_snapshot SET abcd_a_score=?,abcd_b_score=?,abcd_c_score=?,abcd_d_score=?,updated_at=CURRENT_TIMESTAMP WHERE code=? AND trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)");
  candidates.forEach((row) => update.run(row.a, row.b, row.c, row.d, row.code));
  return diversified;
}

function computeAia(db) {
  const rows = latestFactors(db);
  return rows.map((row) => {
    const base = 0.31818 * numeric(row.aia_sector_heat, 50) + 0.31818 * numeric(row.aia_stock_heat, 50) + 0.18182 * numeric(row.aia_leadership, 50) + 0.18182 * numeric(row.aia_technical_pattern, 50);
    const similarity = numeric(row.m30_similarity, 0);
    const templateDelta = similarity >= 0.72 ? Math.min(5, (similarity - 0.72) * 18 + 1.5) * 0.6576557487 : 0;
    const score = clamp(base + templateDelta);
    return { ...row, score, reason: `板块热度${numeric(row.aia_sector_heat, 50).toFixed(1)}、个股热度${numeric(row.aia_stock_heat, 50).toFixed(1)}、龙头地位${numeric(row.aia_leadership, 50).toFixed(1)}、技术形态${numeric(row.aia_technical_pattern, 50).toFixed(1)}${similarity ? `，M30相似度${(similarity * 100).toFixed(1)}%` : ""}`, risk: numeric(row.drawdown_20) < -0.12 ? "20日回撤偏大，形态确认前不宜激进" : "模板只做校准，不替代基础规则", confidence: clamp(score / 100, .45, .9) };
  }).filter((row) => row.score >= 48 && numeric(row.amount) > 0).sort((a, b) => b.score - a.score).slice(0, 10);
}

function computeHeat(db) {
  const rows = latestFactors(db);
  const industryValues = rows.map((row) => row.industry_ret_4d);
  const momentumValues = rows.map((row) => row.ret_20d);
  const stageOne = rows.map((row) => {
    const five = numeric(row.five_platform_heat, numeric(row.previous_heat_score, 35));
    const agents = numeric(row.four_agent_score, 0);
    const sector = percentile(industryValues, row.industry_ret_4d);
    const original = 0.55 * percentile(momentumValues, row.ret_20d) + 0.45 * clamp(numeric(row.volume_ratio_20) * 35);
    const taoguba = numeric(row.taoguba_sentiment, 50);
    const breakout = numeric(row.daily_breakout_score, numeric(row.breakout_20) ? 100 : 0);
    const score1 = .35 * five + .25 * agents + .15 * sector + .10 * original + .075 * taoguba + .075 * breakout;
    const agentHits = [agents >= 55, sector >= 60, five >= 55, breakout >= 70].filter(Boolean).length;
    return { ...row, five, agents, sector, original, taoguba, breakout, score1, agentHits };
  }).sort((a, b) => b.score1 - a.score1).slice(0, 30);
  return stageOne.map((row) => ({ ...row, score: .65 * row.score1 + .35 * row.agents, reason: `五平台热度${row.five.toFixed(1)}、四Agent${row.agents.toFixed(1)}、板块动量${row.sector.toFixed(1)}，${row.agentHits}项确认`, risk: row.agentHits < 2 ? "仅单一信号命中，只进入观察池" : "热度衰减时排名可能快速回落", confidence: row.agentHits >= 2 ? .78 : .55 })).filter((row) => row.five >= 40 || row.agentHits >= 2).sort((a, b) => b.score - a.score).slice(0, 8);
}

export function refreshRecommendations(db, modelKey, triggerType = "manual") {
  const items = modelKey === "abcd" ? computeAbcd(db) : modelKey === "aia" ? computeAia(db) : modelKey === "heat" ? computeHeat(db) : null;
  if (!items) throw new Error("未知推荐模型");
  if (!items.length) throw new Error("本轮没有结果，已保留上一批次");
  const gate = recommendationGate(db, modelKey, items);
  if (!gate.pass) {
    recordRejectedBatch(db, modelKey, items, triggerType, gate.failures);
    throw new Error(`质量门禁未通过：${gate.failures.join("；")}。已保留上一批次`);
  }
  return { ...createPublishedBatch(db, modelKey, items, triggerType), items: items.map((row, index) => ({ ...row, rank: index + 1 })) };
}

function recordAbcdCoverageCheck(db, { versionId, status, observed, expected, message }) {
  db.prepare(`INSERT INTO data_quality_checks(
      check_id,dataset_key,version_id,check_name,severity,status,observed_value,expected_value,message,checked_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), "factor_abcd_scores", versionId || null, "latest_factor_abcd_full_market_coverage", "critical", status, JSON.stringify(observed || {}), JSON.stringify(expected || {}), message, new Date().toISOString());
}

function persistIntradayAbcdScoreSnapshot(db, scorePanel, { minimumCoverage = .95, minimumFormalUniverseCoverage = .85 } = {}) {
  const panelDate = normalizedTimestampDate(scorePanel?.trade_date);
  const rawItems = Array.isArray(scorePanel?.items) ? scorePanel.items : [];
  const skipped = (message, observed = {}) => ({ status: "skipped", applied: false, tradeDate: panelDate, message, observed });
  if (!panelDate || !rawItems.length) return skipped("盘中全市场评分面板为空", { panelDate, panelRows: rawItems.length });
  const lineage = {
    chipModelVersion: String(scorePanel?.chip_model_version || "").trim(),
    shapeScoreVersion: String(scorePanel?.shape_score_version || "").trim(),
    distributionMode: String(scorePanel?.distribution_mode || "").trim(),
    sourceQuoteTime: String(scorePanel?.source_quote_time || scorePanel?.factor_time || "").trim(),
    chipFactorAgeMinutes: Number(scorePanel?.chip_factor_age_minutes),
    chipFactorReady: Boolean(scorePanel?.chip_factor_ready),
    chipFactorBuilding: Boolean(scorePanel?.chip_factor_building),
    chipFactorStale: Boolean(scorePanel?.chip_factor_stale),
  };
  if (!lineage.chipModelVersion || !lineage.shapeScoreVersion || !lineage.distributionMode) {
    return skipped("盘中筹码评分缺少新版模型血缘，拒绝发布", { panelDate, panelRows: rawItems.length, lineage });
  }
  if (!lineage.chipFactorReady || !lineage.sourceQuoteTime) {
    return skipped("当天没有已完成且版本一致的盘中筹码模型分，拒绝发布", { panelDate, panelRows: rawItems.length, lineage });
  }
  const governed = governedFactorVersion(db);
  const factorDate = normalizedTimestampDate(governed?.trade_date);
  const universeRows = factorDate ? db.prepare("SELECT code FROM factor_snapshot WHERE trade_date=?").all(factorDate) : [];
  const universe = new Set(universeRows.map((row) => row.code));
  const total = universe.size;
  if (!total) return skipped("没有可校验的正式证券池", { panelDate, factorDate, panelRows: rawItems.length });
  const validScore = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;
  const deduplicated = new Map();
  for (const item of rawItems) {
    const code = String(item?.code || item?.ts_code || "").toUpperCase();
    if (!universe.has(code)) continue;
    deduplicated.set(code, {
      code,
      a: validScore(item?.a_score) ? Number(item.a_score) : null,
      b: validScore(item?.b_score) ? Number(item.b_score) : null,
      c: validScore(item?.c_score) ? Number(item.c_score) : null,
      d: validScore(item?.d_score) ? Number(item.d_score) : null,
      dAvailable: Boolean(item?.d_available) && validScore(item?.d_score),
    });
  }
  const rows = [...deduplicated.values()];
  const declaredEligible = Number(scorePanel?.eligible_universe_count);
  const eligibleTotal = Number.isInteger(declaredEligible) && declaredEligible > 0 ? declaredEligible : rows.length;
  const counts = Object.fromEntries(["a", "b", "c", "d"].map((key) => [key, rows.filter((row) => row[key] !== null).length]));
  const coverage = {
    formalUniverse: rows.length / Math.max(1, total), eligibleMatch: rows.length / Math.max(1, eligibleTotal),
    ...Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, Number(count) / Math.max(1, eligibleTotal)])),
  };
  const failed = ["eligibleMatch", "a", "b", "c", "d"].filter((key) => coverage[key] < minimumCoverage);
  if (coverage.formalUniverse < minimumFormalUniverseCoverage) failed.unshift("formalUniverse");
  const observed = { panelDate, factorDate, total, eligibleTotal, panelRows: rawItems.length, matched: rows.length, counts, coverage, lineage };
  if (failed.length) return skipped(`盘中评分覆盖门禁未通过：${failed.join("/")}`, observed);
  const scoreTime = String(scorePanel?.factor_time || new Date().toISOString());
  const existing = db.prepare("SELECT trade_date,MAX(score_time) AS score_time,COUNT(*) AS rows FROM intraday_factor_score_snapshot").get();
  const existingStamp = Date.parse(String(existing?.score_time || ""));
  const incomingStamp = Date.parse(scoreTime);
  if (normalizedTimestampDate(existing?.trade_date) === panelDate && Number(existing?.rows || 0) > 0
      && Number.isFinite(existingStamp) && Number.isFinite(incomingStamp) && existingStamp > incomingStamp) {
    return { status: "already_newer", applied: false, tradeDate: panelDate, scoreTime: existing.score_time, rowCount: existing.rows, observed };
  }
  const source = String(scorePanel?.source || "quant_mvp.app._REALTIME_ABCD_SCORE_CACHE");
  const versionId = `intraday-factor-scores-${panelDate}-${Date.now()}`;
  const checksum = createHash("sha256").update(JSON.stringify(rows.map((row) => [row.code, row.a, row.b, row.c, row.d]))).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM intraday_factor_score_snapshot").run();
    const insert = db.prepare(`INSERT INTO intraday_factor_score_snapshot(
      code,trade_date,score_time,abcd_a_score,abcd_b_score,abcd_c_score,abcd_d_score,d_available,
      chip_model_version,shape_score_version,distribution_mode,source_quote_time,source
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) insert.run(
      row.code, panelDate, scoreTime, row.a, row.b, row.c, row.d, row.dAvailable ? 1 : 0,
      lineage.chipModelVersion, lineage.shapeScoreVersion, lineage.distributionMode, lineage.sourceQuoteTime, source,
    );
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='intraday_factor_scores' AND status='published'").run();
    db.prepare(`INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at)
      VALUES('intraday_factor_scores',?,?,?,?,'published',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .run(versionId, panelDate, rows.length, checksum, "8010_original_exact_intraday_score_panel", Math.min(coverage.eligibleMatch, coverage.a, coverage.b, coverage.c, coverage.d) * 100);
    const quoteVersion = latestPublishedVersion(db, "intraday_quotes");
    if (normalizedTimestampDate(quoteVersion?.trade_date) === panelDate) linkDatasetVersion(db, "intraday_factor_scores", versionId, "intraday_quotes", quoteVersion.version_id, "scored_from");
    const state = { ...observed, scoreTime, source, versionId, updatedAt: new Date().toISOString() };
    db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('intraday_factor_score_state',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(state));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return skipped(error.message, observed);
  }
  return { status: "applied", applied: true, tradeDate: panelDate, scoreTime, versionId, rowCount: rows.length, observed };
}

/**
 * Persist the copied 8010 engine's exact full-market score panel.
 *
 * Only the latest governed factor date is eligible.  All four columns are
 * cleared and rewritten in one transaction after the complete panel passes
 * the coverage gate, so a partial/old worker response can never mix with the
 * current nightly snapshot.
 */
export function persistAbcdFactorScores(db, scorePanel, { required = false, minimumCoverage = .95, minimumFormalUniverseCoverage = .85 } = {}) {
  const governed = governedFactorVersion(db);
  const factorDate = normalizedTimestampDate(governed?.trade_date);
  const panelDate = normalizedTimestampDate(scorePanel?.trade_date);
  const rawItems = Array.isArray(scorePanel?.items) ? scorePanel.items : [];
  const intradaySnapshot = persistIntradayAbcdScoreSnapshot(db, scorePanel, { minimumCoverage, minimumFormalUniverseCoverage });
  const expected = { latestOnly: true, minimumEligibleCoverage: minimumCoverage, minimumFormalUniverseCoverage, factorDate, source: "8010_original_exact" };
  const reject = (message, observed = {}) => {
    const acceptedAsNewerIntraday = ["applied", "already_newer"].includes(intradaySnapshot.status) && panelDate && factorDate && panelDate > factorDate;
    const result = { status: acceptedAsNewerIntraday ? "intraday_applied" : "skipped", applied: false, tradeDate: factorDate, message, observed, expected, intradaySnapshot };
    if (required && !acceptedAsNewerIntraday) {
      recordAbcdCoverageCheck(db, { versionId: governed?.version_id, status: "fail", observed, expected, message });
      throw new Error(`ABCD全市场因子回写失败：${message}`);
    }
    return result;
  };
  if (!governed || !factorDate) return reject("最新正式因子版本不存在", { panelDate, panelRows: rawItems.length });
  if (!panelDate || panelDate !== factorDate) return reject(`评分日${panelDate || "缺失"}与最新正式因子日${factorDate}不一致`, { panelDate, factorDate, panelRows: rawItems.length });
  if (!rawItems.length) return reject("原8010任务没有返回全市场评分面板", { panelDate, panelRows: 0 });

  const universeRows = db.prepare("SELECT code FROM factor_snapshot WHERE trade_date=? ORDER BY code").all(factorDate);
  const universe = new Set(universeRows.map((row) => row.code));
  const total = universe.size;
  if (!total) return reject(`最新正式因子日${factorDate}没有股票`, { panelDate, panelRows: rawItems.length, total });
  const declaredEligible = Number(scorePanel?.eligible_universe_count);
  const eligibleTotal = Number.isInteger(declaredEligible) && declaredEligible > 0 ? declaredEligible : total;
  if (eligibleTotal > total * 1.05) return reject(`8010可评分池${eligibleTotal}大于正式证券池${total}`, { panelDate, panelRows: rawItems.length, total, eligibleTotal });
  const validScore = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;
  const deduplicated = new Map();
  for (const item of rawItems) {
    const code = String(item?.code || item?.ts_code || "").toUpperCase();
    if (!universe.has(code)) continue;
    deduplicated.set(code, {
      code,
      a: validScore(item?.a_score) ? Number(item.a_score) : null,
      b: validScore(item?.b_score) ? Number(item.b_score) : null,
      c: validScore(item?.c_score) ? Number(item.c_score) : null,
      d: validScore(item?.d_score) ? Number(item.d_score) : null,
    });
  }
  const rows = [...deduplicated.values()];
  const counts = {
    matched: rows.length,
    excludedByOriginal: Math.max(0, total - rows.length),
    a: rows.filter((row) => row.a !== null).length,
    b: rows.filter((row) => row.b !== null).length,
    c: rows.filter((row) => row.c !== null).length,
    d: rows.filter((row) => row.d !== null).length,
  };
  const coverage = {
    formalUniverse: total ? rows.length / total : 0,
    eligibleMatch: eligibleTotal ? rows.length / eligibleTotal : 0,
    a: eligibleTotal ? counts.a / eligibleTotal : 0,
    b: eligibleTotal ? counts.b / eligibleTotal : 0,
    c: eligibleTotal ? counts.c / eligibleTotal : 0,
    d: eligibleTotal ? counts.d / eligibleTotal : 0,
  };
  const observed = { factorDate, panelDate, total, eligibleTotal, panelRows: rawItems.length, counts, coverage, eligibilityPolicy: scorePanel?.eligibility_policy || null };
  const failedComponents = ["eligibleMatch", "a", "b", "c", "d"].filter((key) => coverage[key] < minimumCoverage);
  if (coverage.formalUniverse < minimumFormalUniverseCoverage) failedComponents.unshift("formalUniverse");
  if (failedComponents.length === 1 && failedComponents[0] === "d") {
    const existingVersion = latestPublishedVersion(db, "factor_abcd_scores");
    const existingCounts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(abcd_a_score IS NOT NULL) AS a,SUM(abcd_b_score IS NOT NULL) AS b,
      SUM(abcd_c_score IS NOT NULL) AS c,SUM(abcd_d_score IS NOT NULL) AS d
      FROM factor_snapshot WHERE trade_date=?`).get(factorDate);
    const existingEligible = Number(existingVersion?.row_count || 0);
    const exactExisting = existingVersion?.trade_date === factorDate
      && String(existingVersion?.source || "").includes("8010_original_exact")
      && existingEligible > 0
      && ["a", "b", "c", "d"].every((key) => Number(existingCounts?.[key] || 0) / existingEligible >= minimumCoverage)
      && existingEligible / Math.max(1, Number(existingCounts?.total || 0)) >= minimumFormalUniverseCoverage;
    if (exactExisting) {
      const existingObserved = {
        ...observed,
        existingVersionId: existingVersion.version_id,
        existingRows: existingEligible,
        existingCounts,
        keptVerifiedSameDaySnapshot: true,
      };
      recordAbcdCoverageCheck(db, {
        versionId: existingVersion.version_id,
        status: "pass",
        observed: existingObserved,
        expected,
        message: `最新正式因子日${factorDate}已有通过门禁的8010原版ABCD全市场评分；本次缺少新的完整D截面，继续使用该日最后一次可验证评分`,
      });
      return {
        status: "already_current", applied: false, tradeDate: factorDate,
        versionId: existingVersion.version_id, rowCount: existingEligible,
        counts: existingCounts, coverage, observed: existingObserved, intradaySnapshot,
        message: `最新正式因子日${factorDate}已有通过门禁的8010原版ABCD全市场评分；收盘后没有新的完整5分钟D截面，沿用该日最后一次可验证评分`,
      };
    }
  }
  if (failedComponents.length) return reject(`覆盖门禁未通过：${failedComponents.join("/")}（正式池要求≥${Math.round(minimumFormalUniverseCoverage * 100)}%，8010可评分池及ABCD四项要求≥${Math.round(minimumCoverage * 100)}%）`, observed);

  const scoreVersionId = `factor-abcd-${factorDate}-${Date.now()}`;
  const checksum = createHash("sha256").update(JSON.stringify(rows.map((row) => [row.code, row.a, row.b, row.c, row.d]))).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE factor_snapshot SET abcd_a_score=NULL,abcd_b_score=NULL,abcd_c_score=NULL,abcd_d_score=NULL WHERE trade_date=?").run(factorDate);
    const update = db.prepare(`UPDATE factor_snapshot
      SET abcd_a_score=?,abcd_b_score=?,abcd_c_score=?,abcd_d_score=?,updated_at=CURRENT_TIMESTAMP
      WHERE code=? AND trade_date=?`);
    let matched = 0;
    for (const row of rows) matched += Number(update.run(row.a, row.b, row.c, row.d, row.code, factorDate).changes || 0);
    if (matched < Math.ceil(eligibleTotal * minimumCoverage)) throw new Error(`事务内仅匹配${matched}/${eligibleTotal}只8010可评分股票`);
    db.prepare("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='factor_abcd_scores' AND status='published'").run();
    db.prepare(`INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at)
      VALUES('factor_abcd_scores',?,?,?,?, 'published','8010_original_exact_full_market_score_panel',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .run(scoreVersionId, factorDate, matched, checksum, Math.min(coverage.eligibleMatch, coverage.a, coverage.b, coverage.c, coverage.d) * 100);
    linkDatasetVersion(db, "factor_abcd_scores", scoreVersionId, "factor_snapshot", governed.version_id, "enriches");
    const state = { ...observed, source: scorePanel?.source || "quant_mvp.app._REALTIME_ABCD_SCORE_CACHE", algorithm: scorePanel?.algorithm || null, factorTime: scorePanel?.factor_time || null, versionId: scoreVersionId, updatedAt: new Date().toISOString() };
    db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('abcd_factor_coverage_state',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(state));
    recordAbcdCoverageCheck(db, { versionId: scoreVersionId, status: "pass", observed, expected, message: `最新正式因子日${factorDate}的ABCD四项覆盖通过` });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (required) throw new Error(`ABCD全市场因子回写失败：${error.message}`);
    return { status: "skipped", applied: false, tradeDate: factorDate, message: error.message, observed, expected, intradaySnapshot };
  }
  return { status: "applied", applied: true, tradeDate: factorDate, versionId: scoreVersionId, rowCount: rows.length, counts, coverage, intradaySnapshot, message: `ABCD原版全市场评分已回写${rows.length}/${total}只` };
}

export function publishAlgorithmTask(db, modelKey, task, triggerType = "manual", options = {}) {
  const factorWriteback = modelKey === "abcd"
    ? persistAbcdFactorScores(db, task?.score_panel, { required: options.requireFactorWriteback === true })
    : null;
  const rawItems = task?.result?.items || task?.top10 || task?.items || [];
  const sourceMode = modelKey === "heat" ? "8002_legacy_exact" : modelKey === "aia" ? "aia_authoritative_read_only" : "8010_abcd_original";
  const patternLabels = { chip: "双筹码模型", daily: "日线形态", m30: "30分钟形态", early_breakout: "早盘突破" };
  const items = rawItems.map((item) => {
    const code = String(item.canonical_code || item.symbol || item.code || item.ts_code || "").toUpperCase();
    const score = Number(item.optimized_score ?? item.score ?? item.total_score ?? item.grid_score ?? item.core_score);
    const factorSummary = item.factor_scores ? Object.entries(item.factor_scores).slice(0, 5).map(([key, value]) => `${key} ${Number(value).toFixed(1)}`).join("、") : "";
    return {
      code,
      score,
      reason: item.reason || (modelKey === "heat" ? `8002热度优先两阶段口径：${factorSummary}` : modelKey === "aia" ? `命中${(item.pattern_hits || []).map((key) => patternLabels[key] || key).join("、") || "AIA形态"}；证据覆盖${(Number(item.evidence_coverage || 0) * 100).toFixed(0)}%` : `A/B/C/D ${[item.a_score, item.b_score, item.c_score, item.d_score].map((value) => Number(value || 0).toFixed(1)).join(" / ")}`),
      risk: item.risk || "模型条件失效或热度衰减时应退出观察",
      confidence: Number(item.evidence_coverage || item.confidence || .78),
      algorithmPayload: item,
    };
  }).filter((item) => /^\d{6}\.(SH|SZ|BJ)$/.test(item.code) && Number.isFinite(item.score));
  const taskReady = modelKey === "aia"
    ? task?.publishable === true && ["ready_read_only", "ready_to_stage", "staged"].includes(String(task?.status))
    : task?.ok === true && ["ready", "success"].includes(String(task.status || "ready"));
  if (!taskReady || !items.length) {
    if (modelKey === "abcd" && options.allowKeptPrevious === true && ["applied", "already_current"].includes(factorWriteback?.status)) {
      const previous = db.prepare("SELECT batch_id,model_key,trade_date,item_count,finished_at FROM recommendation_batches WHERE model_key='abcd' AND status='published' ORDER BY finished_at DESC LIMIT 1").get();
      if (previous) {
        resolveOpenAlert(db, "recommendation_abcd", "ABCD推荐未发布");
        return {
          batchId: previous.batch_id, modelKey: previous.model_key, tradeDate: previous.trade_date,
          count: Number(previous.item_count || 0), generatedAt: previous.finished_at,
          keptPrevious: true, factorWriteback,
          sourceMessage: task?.message || "本轮原版ABCD硬门槛下无新候选，已保留上一发布批次",
        };
      }
    }
    const gateLabels = {
      published_factor_version: "因子快照尚未通过正式版本校验",
      candidate_universe_size: "候选池数量不足",
      ranking_factor_coverage: "AIA四项排名因子覆盖不足90%",
      dual_chip_score_coverage: "正式/候选筹码模型覆盖不足90%",
      daily_shape_history_coverage: "AIA正式日线历史覆盖不足95%",
      daily_formal_source_date: "正式日线日期未通过时点校验",
      daily_source_policy: "日线来源不是BigQuant/Tushare正式层",
      m30_source_policy: "30分钟线来源不是AkShare",
      minimum_score_pool: "形态命中且达到最低分的股票不足10只",
      exact_ten: "合格股票未达到恰好10只的发布门槛",
    };
    const sourceLabels = { taoguba_sentiment: "淘股吧个股情绪", original_8002_ex_size: "8002非市值评分", five_platform_heat: "五平台热度", sector_graph_cache: "行业图谱缓存" };
    const localizeFailure = (failure) => {
      const text = String(failure || "");
      if (text === "same-day Taoguba stock sentiment is missing") return "缺少当日淘股吧个股情绪";
      if (text === "same-day five-platform cache/refresh is missing or degraded") return "当日五平台热榜缺失或有效来源不足";
      if (text.startsWith("required source ")) {
        const match = text.match(/^required source (\S+) status=(\S+)$/);
        if (match) return `必需数据源“${sourceLabels[match[1]] || match[1]}”状态异常（${match[2]}）`;
      }
      if (text.startsWith("candidate_count=")) return `热度候选股票不足：${text}`;
      if (text.startsWith("factor snapshot is stale or future-dated")) return `因子快照日期异常：${text.split(": ").at(-1)}`;
      if (text.startsWith("recommendation_count=")) return `合格推荐数量不足：${text}`;
      if (text === "recommendation score is outside 0-100") return "推荐分数超出0至100范围";
      return text;
    };
    const rawFailures = task?.gate?.failures || task?.gates?.filter((item) => !item.pass).map((item) => gateLabels[item.key] || item.reason || item.key) || [task?.message || "原版算法本轮未产生可发布结果"];
    const failures = rawFailures.map(localizeFailure);
    recordRejectedBatch(db, modelKey, items, triggerType, failures);
    throw new Error(`${failures.join("；")}。已保留上一批次`);
  }
  const gate = recommendationGate(db, modelKey, items);
  if (!gate.pass) {
    recordRejectedBatch(db, modelKey, items, triggerType, gate.failures);
    throw new Error(`质量门禁未通过：${gate.failures.join("；")}。已保留上一批次`);
  }
  const baseVersion = task?.result?.model || task?.ranking?.config_version || task?.config_version || task?.algorithm || sourceMode;
  const weightRevision = task?.weight_config?.revision;
  const version = weightRevision ? `${baseVersion}|weights-r${weightRevision}` : baseVersion;
  const taskTradeDate = firstValue(task?.meta?.data_trade_date, task?.meta?.trade_date, task?.trade_date, task?.result?.trade_date, task?.ranking?.trade_date);
  const published = createPublishedBatch(db, modelKey, items, triggerType, sourceMode, version, taskTradeDate);
  const taskSummary = task?.score_panel ? { ...task, score_panel: { ...task.score_panel, items: undefined } } : task;
  return { ...published, source: sourceMode, sourceMessage: task.message || `${modelKey.toUpperCase()}原版兼容任务已发布`, items: items.map((item, index) => ({ ...item, rank: index + 1 })), factorWriteback, task: taskSummary };
}

function parsePayload(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "" && (typeof value !== "number" || Number.isFinite(value));
}

function firstValue(...values) {
  return values.find(hasValue);
}

function latestTimestamp(values) {
  const ranked = values.filter(hasValue).map((value) => {
    const text = String(value);
    const compact = text.replace(/[^0-9]/g, "").slice(0, 14).padEnd(14, "0");
    return { value: text, rank: /^20\d{12}$/.test(compact) ? compact : "" };
  }).filter((item) => item.rank);
  return ranked.sort((left, right) => left.rank.localeCompare(right.rank)).at(-1)?.value || null;
}

function payloadMarketRaw(payload) {
  return payload?.algorithmPayload?.raw || payload?.raw?.raw || payload?.raw || payload?.algorithmPayload || {};
}

function modelComponentValues(modelKey, payload) {
  const raw = modelKey === "abcd" ? payloadMarketRaw(payload) : payload.raw || payload.algorithmPayload || {};
  if (modelKey === "abcd") return ["a", "b", "c", "d"].map((key) => firstValue(payload[key], payload[`${key}_score`], raw[key], raw[`${key}_score`]));
  if (modelKey === "aia") return [
    firstValue(payload.aia_sector_heat, raw.sector_heat, raw.factor_scores?.sector_heat, raw.factor_audit?.sector_heat?.score),
    firstValue(payload.aia_stock_heat, raw.stock_popularity, raw.factor_scores?.stock_popularity, raw.factor_audit?.stock_popularity?.score),
    firstValue(payload.aia_leadership, raw.leadership_status, raw.factor_scores?.leadership_status, raw.factor_audit?.leadership_status?.score),
    firstValue(payload.aia_technical_pattern, raw.technical_pattern, raw.factor_scores?.technical_pattern, raw.factor_audit?.technical_pattern?.score),
  ];
  return ["five_platform_heat", "four_agent_rank", "yesterday_sector_momentum", "original_8002_ex_size", "taoguba_sentiment", "daily_breakout"]
    .map((key) => firstValue(payload[key], raw.factor_scores?.[key]));
}

function sourceFidelity(modelKey, batch) {
  const accepted = {
    abcd: new Set(["8010_abcd_original"]),
    aia: new Set(["aia_authoritative_read_only"]),
    heat: new Set(["8002_legacy_exact"]),
  }[modelKey] || new Set();
  return accepted.has(String(batch?.source_mode || ""));
}

function isWeekdayTradeDate(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const weekday = new Date(`${value}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function recommendationStatus(db, modelKey, batch, batchRows, context) {
  const recentAttempts = db.prepare("SELECT * FROM recommendation_batches WHERE model_key=? ORDER BY finished_at DESC LIMIT 40").all(modelKey);
  const latestSystemAttempt = recentAttempts[0] || null;
  // Historical scheduler builds could create a rejected batch stamped with a
  // weekend calendar date.  Such a row is useful for audit, but it must never
  // advance the market's expected trading date.
  const latestAttempt = recentAttempts.find((item) => isWeekdayTradeDate(item.trade_date)) || latestSystemAttempt;
  const payloads = batchRows.map((row) => parsePayload(row.payload_json));
  let requiredCells = 0; let presentCells = 0; let componentCells = 0; let componentPresent = 0; let quotePresent = 0;
  batchRows.forEach((row, index) => {
    const basic = [row.code, row.score, row.reason, row.generated_at];
    requiredCells += basic.length; presentCells += basic.filter(hasValue).length;
    const components = modelComponentValues(modelKey, payloads[index]);
    componentCells += components.length; componentPresent += components.filter(hasValue).length;
    const marketRaw = payloadMarketRaw(payloads[index]);
    if (
      hasValue(firstValue(payloads[index].quote_time, payloads[index].factor_time, marketRaw.quote_time, marketRaw.factor_time))
      || (hasValue(firstValue(row.close, marketRaw.close)) && hasValue(firstValue(row.pct_chg, marketRaw.pct_chg)))
    ) quotePresent += 1;
  });
  const basicCoverage = requiredCells ? presentCells / requiredCells : 0;
  const componentCoverage = componentCells ? componentPresent / componentCells : 0;
  const fieldCoverage = batchRows.length ? (basicCoverage + componentCoverage) / 2 : 0;
  const originalCompatible = sourceFidelity(modelKey, batch);
  const factorVersion = batch?.factor_version_id ? db.prepare("SELECT trade_date,published_at,row_count,source,quality_score FROM dataset_versions WHERE version_id=?").get(batch.factor_version_id) : null;
  const quoteVersion = batch?.quote_version_id ? db.prepare("SELECT trade_date,published_at,row_count,source,quality_score FROM dataset_versions WHERE version_id=?").get(batch.quote_version_id) : null;
  const quoteAcquisition = batch?.quote_version_id ? db.prepare("SELECT trade_date,as_of,row_count,provider_key,metadata_json FROM data_acquisition_batches WHERE batch_id=? AND status='published'").get(batch.quote_version_id) : null;
  const expectedTradeDate = [latestAttempt?.trade_date, context.factorDate, context.formalDate, context.marketState?.official?.targetTradeDate, context.marketState?.official?.tradeDate]
    .filter(hasValue).sort().at(-1) || batch?.trade_date || null;
  const newerRejected = latestAttempt && latestAttempt.status !== "published" && String(latestAttempt.finished_at || "") > String(batch?.finished_at || "");
  const quoteSnapshotStale = ["abcd", "heat"].includes(modelKey) && quoteVersion?.trade_date && batch?.trade_date && quoteVersion.trade_date < batch.trade_date;
  const freshness = batch?.trade_date && expectedTradeDate && batch.trade_date < expectedTradeDate ? "stale" : newerRejected || quoteSnapshotStale ? "degraded" : "fresh";
  const completeness = fieldCoverage >= .95 && originalCompatible ? "complete" : fieldCoverage >= .8 ? "partial" : "incomplete";
  const factorAsOf = factorVersion?.trade_date || latestTimestamp(payloads.flatMap((payload) => [payload.updated_at, payload.factor_time, payload.data_as_of, payload.algorithmPayload?.data_as_of, payloadMarketRaw(payload).factor_time])) || batch?.trade_date || null;
  const payloadQuoteAsOf = latestTimestamp(payloads.flatMap((payload) => [payload.quote_time, payloadMarketRaw(payload).quote_time, payloadMarketRaw(payload).factor_time]));
  // Bind the label to the exact dataset version recorded by this batch.  The
  // current market snapshot may be newer and must never be presented as data
  // that an older recommendation had already used.
  const quoteAsOf = payloadQuoteAsOf || quoteAcquisition?.as_of || quoteVersion?.trade_date || (quotePresent ? batch?.trade_date : null);
  const warnings = [];
  if (freshness === "stale") warnings.push(`已发布${batch.trade_date}，当前应检查至${expectedTradeDate}`);
  if (newerRejected) warnings.push(`最近一次${latestAttempt.trade_date}刷新未发布：${latestAttempt.message}`);
  if (quoteSnapshotStale) warnings.push(`行情快照仅截至${quoteVersion.trade_date}，早于推荐交易日${batch.trade_date}`);
  if (!originalCompatible) warnings.push("当前批次不是原网站精确兼容任务生成");
  if (fieldCoverage < .95) warnings.push(`关键字段完备率${Math.round(fieldCoverage * 100)}%`);
  return {
    modelKey,
    displayName: modelWeightSpecs[modelKey]?.displayName || modelKey.toUpperCase(),
    status: freshness === "fresh" && completeness === "complete" ? "ready" : freshness === "stale" || completeness === "incomplete" ? "critical" : "warning",
    freshness,
    completeness,
    publishedTradeDate: batch?.trade_date || null,
    publishedAt: batch?.finished_at || null,
    expectedTradeDate,
    factorAsOf,
    quoteAsOf,
    itemCount: batchRows.length,
    batchItemCount: Number(batch?.item_count || 0),
    fieldCoverage: Math.round(fieldCoverage * 1000) / 10,
    componentCoverage: Math.round(componentCoverage * 1000) / 10,
    quoteCoverage: batchRows.length ? Math.round(quotePresent * 1000 / batchRows.length) / 10 : 0,
    inputVersions: {
      factor: factorVersion ? { versionId: batch.factor_version_id, tradeDate: factorVersion.trade_date, publishedAt: factorVersion.published_at, rowCount: factorVersion.row_count, source: factorVersion.source, qualityScore: factorVersion.quality_score } : null,
      quote: quoteVersion ? { versionId: batch.quote_version_id, tradeDate: quoteVersion.trade_date, asOf: quoteAsOf, publishedAt: quoteVersion.published_at, rowCount: quoteVersion.row_count, source: quoteVersion.source, qualityScore: quoteVersion.quality_score } : null,
    },
    sourceMode: batch?.source_mode || null,
    modelVersion: batch?.model_version || null,
    originalCompatible,
    latestAttempt: latestAttempt ? { tradeDate: latestAttempt.trade_date, status: latestAttempt.status, at: latestAttempt.finished_at, message: latestAttempt.message } : null,
    latestSystemAttempt: latestSystemAttempt ? { tradeDate: latestSystemAttempt.trade_date, status: latestSystemAttempt.status, at: latestSystemAttempt.finished_at, message: latestSystemAttempt.message } : null,
    warnings,
  };
}

function recommendationBatchSelection(db, modelKey, options = {}) {
  if (modelKey !== "abcd") {
    const batch = db.prepare("SELECT * FROM recommendation_batches WHERE model_key=? AND status='published' ORDER BY finished_at DESC LIMIT 1").get(modelKey);
    return { batch, mode: "latest_published", label: "最新发布批次", signalBucket: null, signalTradeDate: null };
  }
  if (options.abcdBatchId) {
    const batch = db.prepare("SELECT * FROM recommendation_batches WHERE batch_id=? AND model_key='abcd' AND status IN ('published','superseded') LIMIT 1").get(options.abcdBatchId);
    return { batch, mode: "manual_refresh", label: "本页手动刷新批次", signalBucket: null, signalTradeDate: batch?.trade_date || null };
  }
  if (options.abcdMode === "locked_0945") {
    const targetDate = /^20\d{2}-\d{2}-\d{2}$/.test(String(options.abcdTradeDate || "")) ? String(options.abcdTradeDate) : null;
    const signal = db.prepare(`SELECT s.*,b.* FROM forward_signal_snapshots s
      JOIN recommendation_batches b ON b.batch_id=s.recommendation_batch_id
      WHERE s.account_key='abcd' AND s.signal_clock='09:45' AND s.status='ready'
        AND b.model_key='abcd' AND b.status IN ('published','superseded')
        AND (? IS NULL OR s.trade_date=?)
      ORDER BY s.trade_date DESC,s.created_at DESC LIMIT 1`).get(targetDate, targetDate);
    return {
      batch: signal || null,
      mode: "locked_0945",
      label: "09:45锁定批次",
      signalBucket: signal?.signal_bucket || null,
      signalTradeDate: signal?.trade_date || targetDate,
    };
  }
  const batch = db.prepare("SELECT * FROM recommendation_batches WHERE model_key='abcd' AND status='published' ORDER BY finished_at DESC LIMIT 1").get();
  return { batch, mode: "latest_published", label: "最新发布批次", signalBucket: null, signalTradeDate: batch?.trade_date || null };
}

export function getRecommendations(db, modelKey = "all", options = {}) {
  const models = modelKey === "all" ? ["abcd", "aia", "heat"] : [modelKey];
  const rows = [];
  const batches = [];
  const rowsByBatch = new Map();
  const selections = {};
  for (const key of models) {
    const selected = recommendationBatchSelection(db, key, options);
    const batch = selected.batch;
    selections[key] = {
      mode: selected.mode,
      label: selected.label,
      batchId: batch?.batch_id || null,
      tradeDate: batch?.trade_date || selected.signalTradeDate || null,
      publishedAt: batch?.finished_at || null,
      signalBucket: selected.signalBucket,
    };
    if (!batch) continue;
    batches.push(batch);
    const batchRows = db.prepare(`SELECT r.*,s.name,s.industry,f.close,f.pct_chg,f.formal_model_score,f.candidate_model_score,f.m30_similarity
      FROM recommendations r JOIN securities s ON s.code=r.code LEFT JOIN factor_snapshot f ON f.code=r.code AND f.trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)
      WHERE r.batch_id=? ORDER BY r.rank`).all(batch.batch_id).map((row) => {
        const payload = parsePayload(row.payload_json);
        const marketRaw = payloadMarketRaw(payload);
        const algorithm = payload?.algorithmPayload || payload?.algorithm_payload || {};
        return {
          ...row,
          close: firstValue(marketRaw.close, row.close),
          pct_chg: firstValue(marketRaw.pct_chg, row.pct_chg),
          a_score: firstValue(algorithm.a_score, marketRaw.a_score),
          b_score: firstValue(algorithm.b_score, algorithm.b_core_score, marketRaw.b_score),
          c_score: firstValue(algorithm.c_score, marketRaw.c_score),
          d_score: firstValue(algorithm.d_score, marketRaw.d_score),
        };
      });
    rowsByBatch.set(batch.batch_id, batchRows);
    rows.push(...batchRows);
  }
  const merged = new Map();
  for (const row of rows) {
    if (!merged.has(row.code)) merged.set(row.code, { ...row, sources: [], consensus: 0, modelScores: {} });
    const target = merged.get(row.code);
    target.sources.push(row.model_key); target.consensus += 1; target.modelScores[row.model_key] = row.score;
    if (row.score > target.score) Object.assign(target, { score: row.score, reason: row.reason, risk: row.risk });
  }
  const items = [...merged.values()].sort((a, b) => b.consensus - a.consensus || b.score - a.score);
  let marketState = {}; try { marketState = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='market_data_state'").get()?.value || "{}"); } catch {}
  const factorDate = db.prepare("SELECT MAX(trade_date) AS date FROM factor_snapshot").get()?.date || null;
  const formal = db.prepare("SELECT trade_date,row_count,source,published_at FROM dataset_versions WHERE dataset_key='formal_daily' AND status='published' ORDER BY created_at DESC LIMIT 1").get() || null;
  const intraday = db.prepare("SELECT trade_date,row_count,source,quality_score,published_at FROM dataset_versions WHERE dataset_key='intraday_quotes' AND status='published' ORDER BY created_at DESC LIMIT 1").get() || null;
  const context = { factorDate, formalDate: formal?.trade_date || null, marketState };
  const batchByModel = new Map(batches.map((batch) => [batch.model_key, batch]));
  const modelStatuses = models.map((key) => {
    const batch = batchByModel.get(key);
    if (batch) return {
      ...recommendationStatus(db, key, batch, rowsByBatch.get(batch.batch_id) || [], context),
      selectionMode: selections[key]?.mode || "latest_published",
      selectionLabel: selections[key]?.label || "最新发布批次",
      signalBucket: selections[key]?.signalBucket || null,
    };
    return {
      modelKey: key,
      displayName: modelWeightSpecs[key]?.displayName || key.toUpperCase(),
      status: "warning",
      freshness: "waiting",
      completeness: "incomplete",
      publishedTradeDate: null,
      publishedAt: null,
      expectedTradeDate: selections[key]?.tradeDate || context.factorDate || null,
      factorAsOf: context.factorDate || null,
      quoteAsOf: context.marketState?.quoteAsOf || null,
      itemCount: 0,
      batchItemCount: 0,
      fieldCoverage: 0,
      componentCoverage: 0,
      quoteCoverage: 0,
      inputVersions: { factor: null, quote: null },
      sourceMode: null,
      modelVersion: null,
      originalCompatible: false,
      latestAttempt: null,
      latestSystemAttempt: null,
      selectionMode: selections[key]?.mode || "latest_published",
      selectionLabel: selections[key]?.label || "最新发布批次",
      signalBucket: null,
      warnings: [key === "abcd" && selections[key]?.mode === "locked_0945" ? `${selections[key]?.tradeDate || "当天"} 09:45锁定批次尚未形成；不会回退到旧批次或改用更晚信号` : "尚无可展示的发布批次"],
    };
  });
  const overall = modelStatuses.some((item) => item.status === "critical") ? "critical" : modelStatuses.some((item) => item.status === "warning") ? "warning" : "ready";
  return {
    items: modelKey === "all" ? items : rows,
    batches,
    selection: selections,
    dataStatus: {
      overall,
      checkedAt: new Date().toISOString(),
      market: {
        mode: marketState.mode || (activeIntradayWindow() ? "intraday" : "official"),
        modeLabel: marketState.modeLabel || (activeIntradayWindow() ? "AKShare盘中临时行情" : "BigQuant + Tushare正式日线"),
        activeTradeDate: marketState.activeTradeDate || formal?.trade_date || factorDate,
        quoteTradeDate: marketState.quoteTradeDate || intraday?.trade_date || null,
        quoteAsOf: marketState.quoteAsOf || intraday?.published_at || null,
        updatedAt: marketState.updatedAt || formal?.published_at || null,
        coverage: marketState.coverage || (intraday ? { received: intraday.row_count, ratio: Number(intraday.quality_score || 0) / 100 } : formal ? { received: formal.row_count, ratio: 1 } : null),
        official: marketState.official || { status: formal ? "ready" : "missing", tradeDate: formal?.trade_date || null, source: formal?.source || null },
      },
      models: modelStatuses,
    },
    generatedAt: new Date().toISOString(),
  };
}

export function runScreener(db, input = {}) {
  const allow = new Set(factorDefinitions.map((item) => item.key));
  const factorRows = latestFactors(db);
  const latestScoreRow = factorRows.find((row) => row.latest_score_trade_date) || null;
  const latestScoreCoverage = factorRows.filter((row) => row.latest_signal_score !== null && row.latest_signal_score !== undefined && Number.isFinite(Number(row.latest_signal_score))).length;
  let rows = factorRows.map((row) => ({ ...row }));
  for (const filter of input.filters || []) {
    if (!allow.has(filter.key)) continue;
    const threshold = Number(filter.value);
    if (!Number.isFinite(threshold)) continue;
    rows = rows.filter((row) => {
      const rawValue = row[filter.key];
      if (rawValue === null || rawValue === undefined || rawValue === "") return false;
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return false;
      return filter.operator === "<=" ? value <= threshold : filter.operator === "<" ? value < threshold : filter.operator === "=" ? value === threshold : filter.operator === ">" ? value > threshold : value >= threshold;
    });
  }
  const weights = input.weights || {};
  const activeWeights = Object.entries(weights).filter(([key, value]) => allow.has(key) && !filterOnlyFactors.has(key) && Number(value) !== 0);
  const experimentalModel = db.prepare("SELECT scope,display_name,model_version,revision,applied_revision,pending_retrain,production_enabled,status FROM experimental_chip_models WHERE scope='multi_period'").get() || null;
  const experimentalKeys = new Set(["multi_period_model_score", "multi_period_model_rank_pct"]);
  const selectedExperimentalKeys = [...new Set([
    ...(input.filters || []).map((filter) => filter.key),
    ...activeWeights.map(([key]) => key),
    input.sort?.key,
  ].filter((key) => experimentalKeys.has(key)))];
  const unavailableExperimentalFactors = selectedExperimentalKeys.filter((key) => !factorRows.some((row) => Number.isFinite(Number(row[key]))));
  const experimentalReady = Boolean(experimentalModel?.production_enabled && experimentalModel?.model_version && experimentalModel.model_version !== "not_trained");
  const experimentalStatus = {
    scope: "multi_period",
    displayName: experimentalModel?.display_name || "多周期候选筹码模型",
    available: experimentalReady && unavailableExperimentalFactors.length === 0,
    modelVersion: experimentalModel?.model_version || "not_trained",
    productionEnabled: Boolean(experimentalModel?.production_enabled),
    revision: Number(experimentalModel?.revision || 1),
    appliedRevision: Number(experimentalModel?.applied_revision || 0),
    status: experimentalModel?.status || "sample_collection",
    unavailableFactors: unavailableExperimentalFactors,
    message: experimentalReady && unavailableExperimentalFactors.length === 0
      ? "多周期候选筹码模型已发布，可用于量价筛选"
      : "多周期候选筹码模型尚未完成正样本夜间训练，当前不会参与筛选结果",
  };
  if (unavailableExperimentalFactors.length) {
    return {
      rows: [], total: 0, factorDate: factorRows[0]?.trade_date || null, modelRankDate: null,
      modelRankSource: "chip_model_rank_daily", modelRankSources: { formal: "chip_model_rank_daily", candidate: "chip_model_rank_daily", multi_period: "chip_model_rank_daily" },
      latestScoreDate: latestScoreRow?.latest_score_trade_date || null, latestScoreAsOf: latestScoreRow?.latest_score_as_of || null,
      latestScoreSource: latestScoreRow?.latest_score_source || null, latestScoreMode: latestScoreRow?.latest_score_mode || "official",
      latestScoreCoverage, sortKey: input.sort?.key || null, activeFactors: activeWeights.map(([key]) => key),
      unavailableFactors: unavailableExperimentalFactors, experimentalModel: experimentalStatus,
      message: experimentalStatus.message,
    };
  }
  const percentileByFactor = new Map(activeWeights.map(([key]) => {
    const definition = factorDefinitions.find((item) => item.key === key);
    const requestedDirection = input.weightDirections?.[key];
    const direction = requestedDirection === "asc" || requestedDirection === "desc" ? requestedDirection : definition?.direction;
    return [key, percentileLookup(rows.map((item) => item[key]), direction !== "asc")];
  }));
  for (const row of rows) {
    let weighted = 0; let total = 0;
    for (const [key, rawWeight] of activeWeights) {
      const score = percentileByFactor.get(key)(row[key]);
      weighted += score * Math.abs(Number(rawWeight)); total += Math.abs(Number(rawWeight));
    }
    row.composite_score = total ? weighted / total : null;
  }
  const sortable = new Set([...allow, "formal_model_rank", "candidate_model_rank", "multi_period_model_rank", "composite_score"]);
  const sortKey = sortable.has(input.sort?.key) ? input.sort.key : activeWeights.length ? "composite_score" : "ret_20d";
  const direction = input.sort?.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => (numeric(a[sortKey], -Infinity) - numeric(b[sortKey], -Infinity)) * direction);
  return {
    rows: rows.slice(0, Math.min(500, Math.max(1, Number(input.limit) || 100))),
    total: rows.length,
    factorDate: rows[0]?.trade_date || null,
    modelRankDate: rows.find((row) => row.model_rank_trade_date)?.model_rank_trade_date || null,
    modelRankSource: "chip_model_rank_daily",
    modelRankSources: { formal: "chip_model_rank_daily", candidate: "chip_model_rank_daily", multi_period: "chip_model_rank_daily" },
    latestScoreDate: latestScoreRow?.latest_score_trade_date || null,
    latestScoreAsOf: latestScoreRow?.latest_score_as_of || null,
    latestScoreSource: latestScoreRow?.latest_score_source || null,
    latestScoreMode: latestScoreRow?.latest_score_mode || "official",
    latestScoreCoverage,
    sortKey,
    activeFactors: activeWeights.map(([key]) => key),
    unavailableFactors: [], experimentalModel: experimentalStatus,
  };
}

function decodeWeightRow(row) {
  return {
    modelKey: row.model_key,
    displayName: row.display_name,
    mode: row.mode,
    weights: JSON.parse(row.weights_json),
    defaults: JSON.parse(row.default_weights_json),
    groups: JSON.parse(row.metadata_json),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  };
}

export function modelWeightConfigs(db) {
  return { items: db.prepare("SELECT * FROM model_weight_configs ORDER BY CASE model_key WHEN 'abcd' THEN 1 WHEN 'aia' THEN 2 ELSE 3 END").all().map(decodeWeightRow) };
}

function validatedWeights(modelKey, input) {
  const spec = modelWeightSpecs[modelKey];
  if (!spec) throw new Error("未知推荐模型");
  const submitted = input?.weights;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) throw new Error("权重设置格式不正确");
  const output = {};
  for (const [groupKey, group] of Object.entries(spec.groups)) {
    const source = submitted[groupKey];
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`缺少${group.label}`);
    output[groupKey] = {};
    for (const itemKey of Object.keys(group.items)) {
      const value = Number(source[itemKey]);
      if (!Number.isFinite(value) || value < 0 || value > 1000) throw new Error(`${group.items[itemKey]}权重需要在0到1000之间`);
      output[groupKey][itemKey] = Math.round(value * 1_000_000) / 1_000_000;
    }
    if (!group.allowZero && Object.values(output[groupKey]).reduce((sum, value) => sum + value, 0) <= 0) throw new Error(`${group.label}至少保留一项非零权重`);
  }
  return output;
}

function writeWeightHistory(db, modelKey, mode, weights, revision) {
  db.prepare("INSERT INTO model_weight_config_history(history_id,model_key,mode,weights_json,revision,changed_by) VALUES(?,?,?,?,?,'local_ui')")
    .run(randomUUID(), modelKey, mode, JSON.stringify(weights), revision);
}

export function saveModelWeightConfig(db, modelKey, input) {
  const weights = validatedWeights(modelKey, input);
  const current = db.prepare("SELECT * FROM model_weight_configs WHERE model_key=?").get(modelKey);
  if (!current) throw new Error("权重配置尚未初始化");
  const revision = Number(current.revision) + 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE model_weight_configs SET mode='custom',weights_json=?,revision=?,updated_at=CURRENT_TIMESTAMP WHERE model_key=?").run(JSON.stringify(weights), revision, modelKey);
    writeWeightHistory(db, modelKey, "custom", weights, revision);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return decodeWeightRow(db.prepare("SELECT * FROM model_weight_configs WHERE model_key=?").get(modelKey));
}

export function resetModelWeightConfig(db, modelKey) {
  const current = db.prepare("SELECT * FROM model_weight_configs WHERE model_key=?").get(modelKey);
  if (!current) throw new Error("权重配置尚未初始化");
  const weights = JSON.parse(current.default_weights_json);
  const revision = Number(current.revision) + 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE model_weight_configs SET mode='original',weights_json=default_weights_json,revision=?,updated_at=CURRENT_TIMESTAMP WHERE model_key=?").run(revision, modelKey);
    writeWeightHistory(db, modelKey, "original", weights, revision);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return decodeWeightRow(db.prepare("SELECT * FROM model_weight_configs WHERE model_key=?").get(modelKey));
}

function resolveScope(db, target, requestedScope) {
  const cleaned = String(target || "").trim();
  const stock = db.prepare("SELECT * FROM securities WHERE code=? OR symbol=? OR name=? LIMIT 1").get(cleaned.toUpperCase(), cleaned.replace(/\D/g, ""), cleaned);
  if (stock) return { scope: "stock", stock, target: stock.code };
  const industry = db.prepare("SELECT industry,COUNT(*) AS count FROM securities WHERE industry=? GROUP BY industry").get(cleaned);
  if (industry || requestedScope === "industry") return { scope: "industry", target: cleaned };
  return { scope: requestedScope === "market" ? "market" : "market", target: "A股市场" };
}

function newsFor(db, terms, limit = 8) {
  const clauses = terms.filter(Boolean).slice(0, 3).map(() => "(title LIKE ? OR content LIKE ?)");
  let localRows;
  if (!clauses.length) localRows = db.prepare("SELECT * FROM news_evidence ORDER BY published_at DESC LIMIT ?").all(limit);
  else {
    const params = [];
    terms.filter(Boolean).slice(0, 3).forEach((term) => params.push(`%${term}%`, `%${term}%`));
    params.push(limit);
    localRows = db.prepare(`SELECT * FROM news_evidence WHERE ${clauses.join(" OR ")} ORDER BY published_at DESC LIMIT ?`).all(...params);
  }
  if (!newsSearchDatabase) return localRows;
  const cleanTerms = terms.filter(Boolean).slice(0, 4).map((term) => String(term).replace(/[^\p{L}\p{N}.]+/gu, "").slice(0, 40)).filter(Boolean);
  let archiveRows = [];
  if (cleanTerms.length) {
    const match = cleanTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    try {
      archiveRows = newsSearchDatabase.prepare(`SELECT d.id AS evidence_id,d.title,d.content,d.source,d.url,d.published_at,d.document_type,bm25(news_fts,5.0,1.0) AS search_rank
        FROM news_fts JOIN news_documents d ON d.rowid=news_fts.rowid WHERE news_fts MATCH ?
        ORDER BY search_rank ASC,d.published_at DESC LIMIT ?`).all(match, Math.max(limit * 3, 20));
    } catch {}
  } else {
    archiveRows = newsSearchDatabase.prepare("SELECT id AS evidence_id,title,content,source,url,published_at,document_type FROM news_documents ORDER BY published_at DESC LIMIT ?").all(limit);
  }
  const merged = new Map();
  for (const row of [...localRows, ...archiveRows]) {
    const key = row.url || `${row.source}|${row.title}|${row.published_at}`;
    if (!merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()].slice(0, limit);
}

// Retained as the deterministic fallback contract for regression comparison.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildOfflineAnalysis(db, target, requestedScope, question) {
  const resolved = resolveScope(db, target, requestedScope);
  const factorDate = db.prepare("SELECT MAX(trade_date) AS date FROM (SELECT trade_date FROM factor_snapshot UNION ALL SELECT trade_date FROM market_factor_snapshot)").get()?.date;
  const evidence = [];
  if (resolved.scope === "stock") {
    const factor = db.prepare("SELECT * FROM factor_snapshot WHERE code=? ORDER BY trade_date DESC LIMIT 1").get(resolved.stock.code)
      || db.prepare(`SELECT m.*,c.formal_score AS formal_model_score,c.formal_rank AS formal_model_rank,c.formal_rank_pct AS formal_model_rank_pct,
          c.candidate_score AS candidate_model_score,c.candidate_rank AS candidate_model_rank,c.candidate_rank_pct AS candidate_model_rank_pct
        FROM market_factor_snapshot m LEFT JOIN chip_model_rank_daily c ON c.code=m.code AND c.trade_date=(SELECT MAX(trade_date) FROM chip_model_rank_daily)
        WHERE m.code=? ORDER BY m.trade_date DESC LIMIT 1`).get(resolved.stock.code);
    const stockFactorDate = factor?.trade_date || factorDate;
    const recommendations = db.prepare(`SELECT r.model_key,r.score,r.reason,r.risk,r.generated_at FROM recommendations r
      JOIN recommendation_batches b ON b.batch_id=r.batch_id WHERE r.code=? AND b.status='published' ORDER BY r.generated_at DESC LIMIT 6`).all(resolved.stock.code);
    evidence.push({ id: "E1", source: "BigQuant/Tushare独立因子库", type: "factor", title: `${resolved.stock.name}量价与模型快照`, excerpt: `20日动量${(numeric(factor?.ret_20d) * 100).toFixed(1)}%，量比${numeric(factor?.volume_ratio_20).toFixed(2)}，正式/候选模型分${numeric(factor?.formal_model_score).toFixed(1)}/${numeric(factor?.candidate_model_score).toFixed(1)}`, published_at: stockFactorDate, data_as_of: stockFactorDate, status: "verified", relevance: 1 });
    recommendations.forEach((row, index) => evidence.push({ id: `E${index + 2}`, source: `${row.model_key.toUpperCase()}独立模型`, type: "model", title: `模型分${numeric(row.score).toFixed(1)}`, excerpt: row.reason, published_at: row.generated_at, data_as_of: row.generated_at, status: "verified", relevance: .9 }));
    const news = newsFor(db, [resolved.stock.name, resolved.stock.symbol, resolved.stock.industry], 10).map((row) => {
      const title = String(row.title || ""); const content = String(row.content || "");
      const relevance = title.includes(resolved.stock.name) ? 1 : title.includes(resolved.stock.symbol) ? .95 : content.includes(resolved.stock.name) ? .85 : content.includes(resolved.stock.symbol) ? .8 : .55;
      return { ...row, relevance };
    }).filter((row) => row.relevance >= .55).sort((a, b) => b.relevance - a.relevance).slice(0, 6);
    news.forEach((row, index) => evidence.push({ id: `N${index + 1}`, source: row.source || "新闻库", type: "news", title: row.title, excerpt: String(row.content || "").slice(0, 180), url: row.url, published_at: row.published_at, data_as_of: row.published_at, status: "cached", relevance: row.relevance }));
    const momentum = numeric(factor?.ret_20d);
    const conclusion = `${resolved.stock.name}当前20日动量${momentum >= 0 ? "为正" : "为负"}，正式筹码模型排名百分位${numeric(factor?.formal_model_rank_pct, 100).toFixed(1)}%，候选模型${numeric(factor?.candidate_model_rank_pct, 100).toFixed(1)}%。${recommendations.length ? `近期命中${[...new Set(recommendations.map((row) => row.model_key))].join("、")}模型。` : "近期未进入模型正式推荐。"}`;
    return { resolved, headline: `${resolved.stock.name} · 数据证据分析`, conclusion, confidence: factor ? (news.length ? .82 : .72) : .35, support: evidence.slice(0, 8).map((item) => ({ title: `[${item.id}] ${item.title}`, detail: item.excerpt })), risks: [numeric(factor?.volatility_20) > .45 ? "20日波动率偏高，价格路径不稳定。" : "当前波动率未触发高风险门槛。", numeric(factor?.drawdown_20) < -.12 ? "20日回撤较深，需确认是否为弱势反抽。" : "仍需观察量能能否持续。", "新闻证据来自本地缓存，离线模式不会自动补充未入库的新事件。"], watchConditions: [`20日动量维持在${(momentum * 100).toFixed(1)}%以上`, `量比保持在${Math.max(1.2, numeric(factor?.volume_ratio_20)).toFixed(2)}以上`, "正式与候选筹码模型排名不要同步恶化"], missingData: [!factor ? "该股票没有最新因子截面" : null, news.length ? null : "未找到高相关本地新闻"].filter(Boolean), sourceStatus: [{ source: "market_factor_snapshot", status: factor ? "ok" : "missing", data_as_of: stockFactorDate }, { source: "recommendations", status: recommendations.length ? "ok" : "empty", count: recommendations.length }, { source: "news_evidence", status: news.length ? "cached" : "empty", count: news.length }], uncertainty: `本回答为离线证据归纳，量价截止${stockFactorDate}；没有把旧AI结论作为证据。`, evidence };
  }
  const allRows = latestFactors(db);
  const rows = resolved.scope === "industry" ? allRows.filter((row) => row.industry === resolved.target) : allRows;
  const label = resolved.scope === "industry" ? resolved.target : "A股市场";
  const positive = rows.filter((row) => numeric(row.pct_chg) > 0).length;
  const avg5 = rows.length ? rows.reduce((sum, row) => sum + numeric(row.ret_5d), 0) / rows.length : 0;
  const avg20 = rows.length ? rows.reduce((sum, row) => sum + numeric(row.ret_20d), 0) / rows.length : 0;
  const avgVolatility = rows.length ? rows.reduce((sum, row) => sum + numeric(row.volatility_20), 0) / rows.length : 0;
  const amount = rows.reduce((sum, row) => sum + numeric(row.amount), 0);
  const leaders = [...rows].sort((a, b) => numeric(b.ret_20d) - numeric(a.ret_20d)).slice(0, 5);
  evidence.push({ id: "E1", source: "独立因子库", type: resolved.scope, title: `${label}截面`, excerpt: `${rows.length}只样本，上涨家数${positive}，5/20日平均动量${(avg5 * 100).toFixed(1)}%/${(avg20 * 100).toFixed(1)}%，成交额${(amount / 1e8).toFixed(1)}亿元`, published_at: factorDate, data_as_of: factorDate, status: "verified", relevance: 1 });
  leaders.forEach((row, index) => evidence.push({ id: `E${index + 2}`, source: "横截面排名", type: "leader", title: `${row.name} ${row.industry}`, excerpt: `20日动量${(numeric(row.ret_20d) * 100).toFixed(1)}%，正式模型分${numeric(row.formal_model_score).toFixed(1)}`, published_at: factorDate, data_as_of: factorDate, status: "verified", relevance: .8 }));
  const questionTerms = String(question || "").split(/[，。！？、\s,!?]+/).filter((term) => term.length >= 3).slice(0, 1);
  const localNews = newsFor(db, resolved.scope === "industry" ? [label, ...questionTerms] : ["A股", "市场", ...questionTerms], 6);
  localNews.forEach((row, index) => evidence.push({ id: `N${index + 1}`, source: row.source || "新闻库", type: "news", title: row.title, excerpt: String(row.content || "").slice(0, 180), url: row.url, published_at: row.published_at, data_as_of: row.published_at, status: "cached", relevance: resolved.scope === "industry" ? .8 : .65 }));
  const breadth = rows.length ? positive / rows.length : 0;
  const directionText = [...new Set(leaders.map((row) => row.industry))].slice(0, 3).join("、") || "暂无";
  return { resolved, headline: `${label} · 市场结构分析`, conclusion: `${label}当前样本上涨比例${(breadth * 100).toFixed(1)}%，5日/20日平均动量${(avg5 * 100).toFixed(1)}%/${(avg20 * 100).toFixed(1)}%。强势方向集中在${directionText}，本地证据库补充了${localNews.length}条相关事件。`, confidence: rows.length >= 20 ? (localNews.length ? .8 : .7) : .5, support: evidence.slice(0, 10).map((item) => ({ title: `[${item.id}] ${item.title}`, detail: item.excerpt })), risks: [breadth < .4 ? "市场宽度偏弱，个股信号容错率较低。" : "市场宽度尚可，但需防止热点集中度过高。", avgVolatility > .08 ? "样本平均20日波动率偏高，仓位和追涨风险需收紧。" : "样本波动率未触发高风险阈值。", "新闻来自本地缓存，未入库的新事件不会被离线模式引用。"], watchConditions: ["上涨家数占比是否继续改善", "强势行业成交额与5/20日动量是否共振", "双筹码模型高分股数量是否扩散"], missingData: [rows.length ? null : "该范围没有最新因子样本", localNews.length ? null : "没有命中本地新闻证据"].filter(Boolean), sourceStatus: [{ source: "factor_snapshot", status: rows.length ? "ok" : "empty", count: rows.length, data_as_of: factorDate }, { source: "news_evidence", status: localNews.length ? "cached" : "empty", count: localNews.length }], uncertainty: `覆盖${rows.length}只数据库样本，量价截止${factorDate}；新闻按各自发布时间显示。`, evidence };
}

function parseResearchTimestamp(value) {
  const text = String(value || "").trim().replaceAll("/", "-");
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?)?/);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const calendarCheck = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendarCheck.getUTCFullYear() !== Number(year) || calendarCheck.getUTCMonth() !== Number(month) - 1 || calendarCheck.getUTCDate() !== Number(day)) return null;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}${/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text.match(/([zZ]|[+-]\d{2}:?\d{2})$/)?.[1] || "+08:00" : "+08:00"}`;
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) return null;
  const parsed = new Date(epoch);
  if (parsed.getUTCFullYear() !== Number(year) && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return null;
  if (epoch > Date.now() + 10 * 60_000) return null;
  const shanghai = new Date(epoch + 8 * 60 * 60_000).toISOString().replace("Z", "+08:00");
  return { epoch, iso: shanghai };
}

function readJson(value, fallback = {}) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function researchTerms(question, extras = []) {
  return [...new Set([
    ...extras,
    ...String(question || "").split(/[，。！？、；：\s,!?;:]+/).filter((term) => term.length >= 2 && term.length <= 24),
  ].map((term) => String(term || "").trim()).filter(Boolean))].slice(0, 10);
}

function contentRelevance(row, terms) {
  if (!terms.length) return .55;
  const title = String(row.title || "").toLowerCase();
  const content = String(row.content || row.summary || "").toLowerCase();
  let score = 0;
  for (const raw of terms) {
    const term = String(raw).toLowerCase();
    if (!term) continue;
    if (title.includes(term)) score = Math.max(score, 1);
    else if (content.includes(term)) score = Math.max(score, .78);
  }
  return score;
}

function freshNewsFor(db, terms, liveNews, limit = 10) {
  const localRows = db.prepare("SELECT * FROM news_evidence ORDER BY imported_at DESC LIMIT 2500").all();
  let archiveRows = [];
  if (newsSearchDatabase) {
    const cleanTerms = terms.slice(0, 5).map((term) => String(term).replace(/[^\p{L}\p{N}.]+/gu, "").slice(0, 40)).filter(Boolean);
    try {
      if (cleanTerms.length) {
        const match = cleanTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
        archiveRows = newsSearchDatabase.prepare(`SELECT d.id AS evidence_id,d.title,d.content,d.source,d.url,d.published_at,d.document_type
          FROM news_fts JOIN news_documents d ON d.rowid=news_fts.rowid WHERE news_fts MATCH ? LIMIT 400`).all(match);
      } else {
        archiveRows = newsSearchDatabase.prepare("SELECT id AS evidence_id,title,content,source,url,published_at,document_type FROM news_documents ORDER BY rowid DESC LIMIT 800").all();
      }
    } catch {}
  }
  const liveRows = Array.isArray(liveNews?.items) ? liveNews.items : [];
  const merged = new Map();
  for (const raw of [...liveRows, ...localRows, ...archiveRows]) {
    const title = String(raw.title || "").trim();
    const content = String(raw.content || raw.summary || "").trim();
    if (!title && !content) continue;
    const time = parseResearchTimestamp(raw.published_at || raw.publish_time);
    if (!time) continue;
    const relevance = contentRelevance(raw, terms);
    if (terms.length && relevance <= 0) continue;
    const key = String(raw.url || "").trim() || `${title}|${time.iso}`;
    const row = {
      evidence_id: raw.evidence_id,
      title: title || content.slice(0, 80), content, source: String(raw.source || raw.provider || "新闻库"),
      url: String(raw.url || raw.original_url || ""), published_at: time.iso, epoch: time.epoch,
      relevance, freshness: liveRows.includes(raw) ? "live_api" : "local_cache",
    };
    const previous = merged.get(key);
    if (!previous || row.relevance > previous.relevance || row.epoch > previous.epoch) merged.set(key, row);
  }
  return [...merged.values()].sort((left, right) => {
    const relevanceGap = right.relevance - left.relevance;
    return Math.abs(relevanceGap) >= .15 ? relevanceGap : right.epoch - left.epoch;
  }).slice(0, limit);
}

function communityEvidence(db, terms, scope, limit = 5) {
  const row = db.prepare("SELECT summary_date,generate_datetime,payload_json FROM community_hot_topic_summaries ORDER BY summary_date DESC,generate_datetime DESC LIMIT 1").get();
  const payload = readJson(row?.payload_json, {});
  const topics = Array.isArray(payload.topics) ? payload.topics : [];
  const selected = topics.map((item) => ({ ...item, relevance: contentRelevance({ title: item.topic, content: `${item.summary || ""} ${item.why_hot || ""}` }, terms) }))
    .filter((item) => scope === "market" || item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || Number(b.discussion_heat || 0) - Number(a.discussion_heat || 0)).slice(0, limit);
  return { row, payload, selected };
}

function preopenEvidence(db, terms, scope, limit = 5) {
  const row = db.prepare("SELECT summary_date,generate_datetime,payload_json FROM preopen_daily_summaries ORDER BY summary_date DESC,generate_datetime DESC LIMIT 1").get();
  const payload = readJson(row?.payload_json, {});
  const newsPart = payload.news_part && typeof payload.news_part === "object" ? payload.news_part : {};
  const items = [...(Array.isArray(newsPart.cn_news) ? newsPart.cn_news : []), ...(Array.isArray(newsPart.us_news) ? newsPart.us_news : [])];
  const selected = items.map((item) => ({ ...item, relevance: contentRelevance({ title: item.title, content: item.summary || item.content }, terms) }))
    .filter((item) => scope === "market" || item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || (parseResearchTimestamp(b.publish_time)?.epoch || 0) - (parseResearchTimestamp(a.publish_time)?.epoch || 0)).slice(0, limit);
  return { row, payload, selected };
}

function fivePlatformEvidence(db, resolved, terms, limit = 5) {
  const snapshot = db.prepare("SELECT snapshot_id,trade_date,generated_at,success_count,failed_count FROM five_platform_snapshots ORDER BY trade_date DESC,generated_at DESC LIMIT 1").get();
  if (!snapshot) return { snapshot: null, selected: [] };
  const combined = db.prepare("SELECT * FROM five_platform_combined WHERE snapshot_id=? ORDER BY rank LIMIT 30").all(snapshot.snapshot_id);
  const selected = combined.map((item) => {
    const security = item.code ? db.prepare("SELECT name,industry FROM securities WHERE code=? OR symbol=? LIMIT 1").get(item.code, String(item.code).replace(/\D/g, "")) : null;
    const relevance = resolved.scope === "stock"
      ? (String(item.code || "").includes(resolved.stock.symbol) || item.name === resolved.stock.name ? 1 : 0)
      : resolved.scope === "industry" ? (security?.industry === resolved.target ? 1 : contentRelevance({ title: item.name }, terms)) : .7;
    return { ...item, security, relevance };
  }).filter((item) => resolved.scope === "market" || item.relevance > 0).slice(0, limit);
  return { snapshot, selected };
}

function recommendationEvidence(db, resolved, limit = 8) {
  if (resolved.scope === "stock") return db.prepare(`SELECT r.model_key,r.code,r.rank,r.score,r.reason,r.risk,r.generated_at,b.trade_date
    FROM recommendations r JOIN recommendation_batches b ON b.batch_id=r.batch_id
    WHERE r.code=? AND b.status='published' ORDER BY r.generated_at DESC LIMIT ?`).all(resolved.stock.code, limit);
  const latest = db.prepare("SELECT MAX(finished_at) AS value FROM recommendation_batches WHERE status='published'").get()?.value;
  if (!latest) return [];
  return db.prepare(`SELECT r.model_key,r.code,r.rank,r.score,r.reason,r.risk,r.generated_at,b.trade_date,s.name,s.industry
    FROM recommendations r JOIN recommendation_batches b ON b.batch_id=r.batch_id JOIN securities s ON s.code=r.code
    WHERE b.status='published' AND b.finished_at>=datetime(?,'-12 hours') ORDER BY r.generated_at DESC,r.rank LIMIT ?`).all(latest, limit * 4)
    .filter((row) => resolved.scope === "market" || row.industry === resolved.target).slice(0, limit);
}

function assignEvidenceIds(items) {
  const counts = {};
  return items.map((item) => {
    const prefix = item.type === "news" ? "N" : item.type === "community" ? "C" : item.type === "preopen" ? "P" : item.type === "platform" ? "H" : "E";
    counts[prefix] = (counts[prefix] || 0) + 1;
    const normalized = parseResearchTimestamp(item.data_as_of || item.published_at);
    return { ...item, published_at: normalized?.iso || item.published_at, data_as_of: normalized?.iso || item.data_as_of, id: `${prefix}${counts[prefix]}` };
  });
}

function latestEvidenceAsOf(evidence, fallback) {
  const newest = evidence.map((item) => parseResearchTimestamp(item.data_as_of || item.published_at)).filter(Boolean).sort((a, b) => b.epoch - a.epoch)[0];
  return newest?.iso || fallback || null;
}

function buildResearchAnalysis(db, target, requestedScope, question, liveNews = {}) {
  const resolved = resolveScope(db, target, requestedScope);
  const allRows = latestFactors(db);
  const factorDate = db.prepare("SELECT MAX(trade_date) AS date FROM (SELECT trade_date FROM factor_snapshot UNION ALL SELECT trade_date FROM market_factor_snapshot)").get()?.date;
  const evidence = [];
  const sourceStatus = [];
  const recommendations = recommendationEvidence(db, resolved);
  const baseTerms = resolved.scope === "stock" ? [resolved.stock.name, resolved.stock.symbol, resolved.stock.industry] : resolved.scope === "industry" ? [resolved.target] : ["A股", "市场"];
  const terms = researchTerms(question, baseTerms);
  let rows = resolved.scope === "stock" ? allRows.filter((row) => row.code === resolved.stock.code) : resolved.scope === "industry" ? allRows.filter((row) => row.industry === resolved.target) : allRows;
  const factor = rows[0] || null;
  const latestQuote = resolved.scope === "stock" ? db.prepare("SELECT * FROM realtime_quotes WHERE code=? LIMIT 1").get(resolved.stock.code) : db.prepare("SELECT MAX(quote_time) AS quote_time,COUNT(*) AS count FROM realtime_quotes").get();
  const quoteTime = parseResearchTimestamp(latestQuote?.quote_time);

  if (resolved.scope === "stock") {
    if (latestQuote && quoteTime) {
      evidence.push({ source: latestQuote.source || "AKShare盘中行情", type: "quote", title: `${resolved.stock.name}最新行情`, excerpt: `最新价${numeric(latestQuote.price).toFixed(2)}元，涨跌幅${numeric(latestQuote.pct_chg).toFixed(2)}%，成交额${(numeric(latestQuote.amount) / 1e8).toFixed(2)}亿元，换手率${numeric(latestQuote.turnover_rate).toFixed(2)}%`, published_at: quoteTime.iso, data_as_of: quoteTime.iso, status: "live", relevance: 1 });
    }
    if (factor) {
      evidence.push({ source: "BigQuant/Tushare正式因子库", type: "factor", title: `${resolved.stock.name}量价与双筹码模型`, excerpt: `20日动量${(numeric(factor.ret_20d) * 100).toFixed(1)}%，量比${numeric(factor.volume_ratio_20).toFixed(2)}，正式/候选模型分${numeric(factor.formal_model_score).toFixed(1)}/${numeric(factor.candidate_model_score).toFixed(1)}`, published_at: factor.trade_date || factorDate, data_as_of: factor.trade_date || factorDate, status: "verified", relevance: 1 });
      if (factor.latest_signal_score !== null && factor.latest_signal_score !== undefined) evidence.push({ source: factor.latest_score_source || "ABCD独立引擎", type: "intraday_score", title: "最新ABCD综合分", excerpt: `A/B/C/D分${numeric(factor.abcd_a_score).toFixed(1)}/${numeric(factor.abcd_b_score).toFixed(1)}/${numeric(factor.abcd_c_score).toFixed(1)}/${numeric(factor.abcd_d_score).toFixed(1)}，加权总分${numeric(factor.latest_signal_score).toFixed(1)}，全市场排名#${factor.latest_signal_rank || "—"}`, published_at: factor.latest_score_as_of, data_as_of: factor.latest_score_as_of, status: factor.latest_score_mode || "official", relevance: 1 });
    }
  } else {
    const positive = rows.filter((row) => numeric(row.pct_chg) > 0).length;
    const avg5 = rows.length ? rows.reduce((sum, row) => sum + numeric(row.ret_5d), 0) / rows.length : 0;
    const avg20 = rows.length ? rows.reduce((sum, row) => sum + numeric(row.ret_20d), 0) / rows.length : 0;
    const amount = rows.reduce((sum, row) => sum + numeric(row.amount), 0);
    evidence.push({ source: "BigQuant/Tushare正式因子库+AKShare盘中覆盖", type: resolved.scope, title: `${resolved.target}最新市场截面`, excerpt: `${rows.length}只样本，上涨${positive}只，5/20日平均动量${(avg5 * 100).toFixed(1)}%/${(avg20 * 100).toFixed(1)}%，成交额${(amount / 1e8).toFixed(1)}亿元`, published_at: quoteTime?.iso || factorDate, data_as_of: quoteTime?.iso || factorDate, status: "verified", relevance: 1 });
    [...rows].sort((a, b) => numeric(b.ret_20d) - numeric(a.ret_20d)).slice(0, 5).forEach((row) => evidence.push({ source: "横截面排名", type: "leader", title: `${row.name} · ${row.industry}`, excerpt: `20日动量${(numeric(row.ret_20d) * 100).toFixed(1)}%，当日涨跌${numeric(row.pct_chg).toFixed(2)}%，正式模型分${numeric(row.formal_model_score).toFixed(1)}`, published_at: row.quote_time || factorDate, data_as_of: row.quote_time || factorDate, status: row.quote_time ? "live" : "verified", relevance: .85 }));
  }

  recommendations.forEach((row) => evidence.push({ source: `${String(row.model_key).toUpperCase()}独立推荐`, type: "model", title: `${row.name || resolved.stock?.name || row.code} · 排名#${row.rank}`, excerpt: `模型分${numeric(row.score).toFixed(1)}。${row.reason || ""}${row.risk ? ` 风险：${row.risk}` : ""}`, published_at: row.generated_at, data_as_of: row.generated_at, status: "published", relevance: .9 }));
  const news = freshNewsFor(db, resolved.scope === "market" ? [] : terms, liveNews, resolved.scope === "market" ? 10 : 8);
  news.forEach((row) => evidence.push({ source: row.source, type: "news", title: row.title, excerpt: row.content.slice(0, 220), url: row.url, published_at: row.published_at, data_as_of: row.published_at, status: row.freshness, relevance: row.relevance }));
  const community = communityEvidence(db, terms, resolved.scope);
  community.selected.forEach((row) => evidence.push({ source: `三平台股民讨论（${(row.platforms || []).join("/") || "社区"}）`, type: "community", title: row.topic, excerpt: `${row.summary || ""}${row.why_hot ? ` 热度原因：${row.why_hot}` : ""}`.slice(0, 260), published_at: community.row?.generate_datetime, data_as_of: community.row?.generate_datetime, status: "ai_summary", relevance: row.relevance || .7 }));
  const preopen = preopenEvidence(db, terms, resolved.scope);
  preopen.selected.forEach((row) => evidence.push({ source: row.source || "盘前新闻总览", type: "preopen", title: row.title || "盘前要闻", excerpt: String(row.summary || row.content || "").slice(0, 220), url: row.original_url, published_at: row.publish_time || preopen.row?.generate_datetime, data_as_of: row.publish_time || preopen.row?.generate_datetime, status: "ai_summary", relevance: row.relevance || .65 }));
  const platforms = fivePlatformEvidence(db, resolved, terms);
  platforms.selected.forEach((row) => evidence.push({ source: "五平台热股", type: "platform", title: `${row.name} · 综合热度#${row.rank}`, excerpt: `综合分${numeric(row.score).toFixed(1)}，覆盖${row.platform_count}个平台。`, published_at: platforms.snapshot?.generated_at, data_as_of: platforms.snapshot?.generated_at, status: "ranked", relevance: row.relevance || .7 }));

  sourceStatus.push(
    { key: "formal_factors", source: "BigQuant/Tushare正式因子", status: rows.length ? "ok" : "empty", count: rows.length, data_as_of: factorDate },
    { key: "akshare_realtime_quotes", source: "AKShare盘中行情", status: quoteTime ? "ok" : "missing", count: Number(latestQuote?.count || (latestQuote ? 1 : 0)), data_as_of: quoteTime?.iso || null },
    { key: "intraday_abcd_scores", source: "ABCD盘中分", status: rows.some((row) => row.latest_score_mode === "intraday") ? "ok" : "official_close", data_as_of: rows.find((row) => row.latest_score_as_of)?.latest_score_as_of || factorDate },
    { key: "published_recommendations", source: "已发布推荐", status: recommendations.length ? "ok" : "empty", count: recommendations.length, data_as_of: recommendations[0]?.generated_at || null },
    { key: "minishare_news_api", source: "MiniShare最新资讯", status: liveNews?.status || "unavailable", count: Number(liveNews?.item_count || 0), data_as_of: liveNews?.latest_publish_time || liveNews?.generated_at || null, error: liveNews?.error || "" },
    { key: "local_news_archive", source: "本地新闻与研报", status: news.length ? "ok" : "empty", count: news.length, data_as_of: news[0]?.published_at || null },
    { key: "community_hot_topics", source: "三平台股民热议", status: community.selected.length ? "ok" : "empty", count: community.selected.length, data_as_of: community.row?.generate_datetime || null },
    { key: "preopen_daily_summary", source: "盘前专题", status: preopen.selected.length ? "ok" : "empty", count: preopen.selected.length, data_as_of: preopen.row?.generate_datetime || null },
    { key: "five_platform_rank", source: "五平台热股", status: platforms.selected.length ? "ok" : "empty", count: platforms.selected.length, data_as_of: platforms.snapshot?.generated_at || null },
  );
  const finalized = assignEvidenceIds(evidence).sort((a, b) => numeric(b.relevance) - numeric(a.relevance) || (parseResearchTimestamp(b.data_as_of)?.epoch || 0) - (parseResearchTimestamp(a.data_as_of)?.epoch || 0));
  const normalizedSourceStatus = sourceStatus.map((item) => ({ ...item, data_as_of: parseResearchTimestamp(item.data_as_of)?.iso || item.data_as_of }));
  const dataAsOf = latestEvidenceAsOf([...finalized, ...normalizedSourceStatus], factorDate);
  const label = resolved.scope === "stock" ? resolved.stock.name : resolved.target;
  const positive = rows.filter((row) => numeric(row.pct_chg) > 0).length;
  const breadth = rows.length ? positive / rows.length : 0;
  const momentum = resolved.scope === "stock" ? numeric(factor?.ret_20d) : rows.length ? rows.reduce((sum, row) => sum + numeric(row.ret_20d), 0) / rows.length : 0;
  const conclusion = resolved.scope === "stock"
    ? `${label}最新价${quoteTime ? `${numeric(latestQuote.price).toFixed(2)}元、涨跌${numeric(latestQuote.pct_chg).toFixed(2)}%` : "暂缺可核验盘中报价"}；20日动量${(momentum * 100).toFixed(1)}%，正式/候选筹码模型分${numeric(factor?.formal_model_score).toFixed(1)}/${numeric(factor?.candidate_model_score).toFixed(1)}。${recommendations.length ? `近期命中${[...new Set(recommendations.map((row) => String(row.model_key).toUpperCase()))].join("、")}推荐。` : "近期未命中已发布推荐。"}`
    : `${label}覆盖${rows.length}只股票，当前上涨比例${(breadth * 100).toFixed(1)}%，20日平均动量${(momentum * 100).toFixed(1)}%；结合${news.length}条最新资讯、${community.selected.length}条三平台热点及${platforms.selected.length}条五平台热度证据判断。`;
  return {
    resolved, headline: `${label} · 全量新鲜证据分析`, conclusion,
    confidence: rows.length ? Math.min(.9, .62 + (quoteTime ? .08 : 0) + (news.length ? .07 : 0) + (community.selected.length ? .05 : 0)) : .35,
    support: finalized.slice(0, 12).map((item) => ({ title: `[${item.id}] ${item.title}`, detail: item.excerpt })),
    risks: [!quoteTime ? "当前缺少可核验的最新盘中行情，短线判断需降低置信度。" : "盘中行情变化快，成交额与涨跌幅需要结合报价时间判断。", numeric(factor?.volatility_20) > .45 ? "20日波动率偏高，价格路径不稳定。" : "模型分与热点证据不等于确定收益，需设置失效条件。", liveNews?.status === "unavailable" ? "MiniShare本次刷新不可用，新闻部分已降级为本地近期缓存。" : "社区热度可能包含情绪和传闻，已作为舆情证据而非事实公告。"],
    watchConditions: resolved.scope === "stock" ? [`量比是否维持在${Math.max(1.2, numeric(factor?.volume_ratio_20)).toFixed(2)}以上`, "ABCD盘中综合分与全市场排名是否继续改善", "正式与候选筹码模型排名是否同步恶化", "最新新闻或公告是否改变当前催化逻辑"] : ["上涨家数占比是否继续改善", "强势行业成交额与5/20日动量是否共振", "三平台讨论热点能否转化为五平台热股共识", "盘中推荐与双筹码模型高分股是否扩散"],
    missingData: [rows.length ? null : "该范围没有正式因子样本", quoteTime ? null : "缺少最新行情", news.length ? null : "没有命中有效新闻", community.selected.length ? null : "没有命中三平台热点"].filter(Boolean),
    sourceStatus: normalizedSourceStatus, uncertainty: `正式量价截止${factorDate || "未知"}，盘中行情截止${quoteTime?.iso || "缺失"}，资讯截止${parseResearchTimestamp(liveNews?.latest_publish_time || news[0]?.published_at)?.iso || "缺失"}；无效日期和未来日期已剔除，旧AI结论不作为证据。`, evidence: finalized, latestDataAsOf: dataAsOf,
  };
}

async function enhanceWithDeepSeek(base, question) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  const prompt = `你是A股证据分析助手。只能使用给定证据，不得编造价格、波动、日期或事件。回答问题：${question}\n对象：${base.resolved.target}\n数据源状态：${JSON.stringify(base.sourceStatus)}\n证据：${JSON.stringify(base.evidence.slice(0, 20))}\n请输出JSON，字段为 conclusion、support(数组)、risks(数组)、watchConditions(数组)、uncertainty。结论必须引用证据编号；区分事实新闻、股民讨论与模型信号；若数据缺失要明确说明。`;
  const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-chat", temperature: .15, response_format: { type: "json_object" }, messages: [{ role: "system", content: "你是严谨的本地投研证据编排器。" }, { role: "user", content: prompt }] }), signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error(`增强模型返回${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || "{}");
}

export function normalizeEnhancedAnswer(base, enhanced) {
  if (!enhanced || typeof enhanced !== "object") return null;
  const evidence = base.evidence || [];
  const validIds = new Set(evidence.map((item) => item.id));
  const typeAliases = {
    community: { label: "股民讨论", types: ["community"] }, news: { label: "新闻", types: ["news"] }, preopen: { label: "盘前专题", types: ["preopen"] },
    quote: { label: "行情", types: ["quote", "market", "industry"] }, market: { label: "行情", types: ["quote", "market", "industry"] }, 行情: { label: "行情", types: ["quote", "market", "industry"] },
    factor: { label: "量价与模型", types: ["factor", "leader"] }, model: { label: "模型信号", types: ["model", "intraday_score", "factor"] }, 模型信号: { label: "模型信号", types: ["model", "intraday_score", "factor"] },
    股民讨论: { label: "股民讨论", types: ["community"] }, 新闻: { label: "新闻", types: ["news"] }, 盘前: { label: "盘前专题", types: ["preopen"] },
  };
  const similarity = (left, right) => {
    const source = String(left || "").replace(/\s+/g, ""); const target = String(right || "").replace(/\s+/g, "");
    if (!source || !target) return 0;
    const grams = new Set(); for (let index = 0; index < source.length - 1; index += 1) grams.add(source.slice(index, index + 2));
    let score = 0; for (let index = 0; index < target.length - 1; index += 1) if (grams.has(target.slice(index, index + 2))) score += 1;
    return score;
  };
  const support = (Array.isArray(enhanced.support) ? enhanced.support : []).map((item, index) => {
    if (typeof item === "string") {
      const submitted = [...new Set(item.match(/\b[ENCPH]\d+\b/g) || [])].filter((id) => validIds.has(id));
      const ranked = evidence.map((row) => ({ id: row.id, score: similarity(item, `${row.title || ""}${row.excerpt || ""}`) })).sort((left, right) => right.score - left.score);
      const evidenceIds = submitted.length ? submitted : ranked[0] ? [ranked[0].id] : [];
      return { title: evidenceIds.length ? `支持证据 · ${evidenceIds.join("、")}` : `支持证据 ${index + 1}`, detail: item, evidenceIds };
    }
    if (!item || typeof item !== "object") return null;
    const detail = String(item.detail || item.summary || item.content || "").trim();
    const rawType = String(item.type || item.title || "支持证据").trim();
    const alias = typeAliases[rawType] || typeAliases[rawType.toLowerCase()] || { label: rawType, types: [] };
    const submittedIds = [
      ...(Array.isArray(item.evidence_ids) ? item.evidence_ids : []), ...(Array.isArray(item.evidenceIds) ? item.evidenceIds : []),
      ...(Array.isArray(item.reference_ids) ? item.reference_ids : []), item.evidence_id, item.evidenceId,
      ...(detail.match(/\b[ENCPH]\d+\b/g) || []),
    ].filter(Boolean).map(String);
    let evidenceIds = [...new Set(submittedIds.filter((id) => validIds.has(id)))];
    if (!evidenceIds.length && alias.types.length) {
      const candidates = evidence.filter((row) => alias.types.includes(row.type)).map((row) => ({ id: row.id, score: similarity(detail, `${row.title || ""}${row.excerpt || ""}`) })).sort((left, right) => right.score - left.score);
      if (candidates[0]) evidenceIds = [candidates[0].id];
    }
    const title = evidenceIds.length ? `${alias.label} · ${evidenceIds.join("、")}` : alias.label;
    return detail ? { title, detail, evidenceIds } : null;
  }).filter(Boolean);
  const stringList = (value, fallback) => {
    const items = (Array.isArray(value) ? value : []).map((item) => typeof item === "string" ? item.trim() : String(item?.detail || item?.summary || item?.content || "").trim()).filter(Boolean);
    return items.length ? items : fallback;
  };
  return {
    ...enhanced,
    conclusion: String(enhanced.conclusion || base.conclusion).trim(),
    support: support.length ? support : base.support,
    risks: stringList(enhanced.risks, base.risks),
    watchConditions: stringList(enhanced.watchConditions, base.watchConditions),
    uncertainty: String(enhanced.uncertainty || base.uncertainty).trim(),
  };
}

export async function analyze(db, input = {}) {
  const question = String(input.question || "请分析当前情况").slice(0, 1200);
  const base = buildResearchAnalysis(db, input.target, input.scope, question, input.liveNews || {});
  let enhanced = null; let mode = "offline"; let enhanceError = "";
  if (input.mode === "enhanced") {
    try { enhanced = normalizeEnhancedAnswer(base, await enhanceWithDeepSeek(base, question)); if (enhanced) mode = "enhanced"; } catch (error) { enhanceError = error.message; }
  }
  const answer = enhanced ? { ...base, ...enhanced, evidence: base.evidence, resolved: base.resolved } : base;
  const sessionId = input.sessionId || randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO ai_sessions(session_id,scope,target,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at").run(sessionId, base.resolved.scope, base.resolved.target, now, now);
  db.prepare("INSERT INTO ai_messages(message_id,session_id,role,content,evidence_json,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), sessionId, "user", question, null, now);
  db.prepare("INSERT INTO ai_messages(message_id,session_id,role,content,evidence_json,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), sessionId, "assistant", answer.conclusion, JSON.stringify(answer.evidence), now);
  return { sessionId, mode, enhanceError, question, answer, dataAsOf: base.latestDataAsOf, generatedAt: now };
}

export function chipRankings(db, scope = "formal", limit = 100) {
  const fields = scope === "candidate"
    ? { score: "candidate_score", rank: "candidate_rank", rankPct: "candidate_rank_pct", registry: "model_registry" }
    : scope === "multi_period"
      ? { score: "multi_period_score", rank: "multi_period_rank", rankPct: "multi_period_rank_pct", registry: "experimental_chip_models" }
      : { score: "formal_score", rank: "formal_rank", rankPct: "formal_rank_pct", registry: "model_registry" };
  const { score, rank, rankPct, registry } = fields;
  const rows = db.prepare(`SELECT c.code,s.name,s.industry,c.trade_date,m.close,m.pct_chg,c.${score} AS score,c.${rank} AS rank,c.${rankPct} AS rank_pct
    FROM chip_model_rank_daily c JOIN securities s ON s.code=c.code
    LEFT JOIN market_factor_snapshot m ON m.code=c.code AND m.trade_date=(SELECT MAX(trade_date) FROM market_factor_snapshot)
    WHERE c.trade_date=(SELECT MAX(trade_date) FROM chip_model_rank_daily) AND c.${score} IS NOT NULL ORDER BY c.${rank} ASC LIMIT ?`).all(Math.min(500, Number(limit) || 100));
  const registryRow = db.prepare(`SELECT * FROM ${registry} WHERE scope=?`).get(scope);
  const snapshot = db.prepare(`SELECT trade_date,COUNT(*) AS universe_count,MIN(source) AS source,MAX(updated_at) AS updated_at FROM chip_model_rank_daily WHERE trade_date=(SELECT MAX(trade_date) FROM chip_model_rank_daily)`).get();
  return { scope, registry: registryRow, rows, snapshot };
}

export function chipSamples(db) {
  const productionRegistry = db.prepare("SELECT r.*,1 AS production_enabled FROM model_registry r ORDER BY scope").all();
  const experimentalRegistry = db.prepare("SELECT * FROM experimental_chip_models ORDER BY scope").all();
  const productionSamples = db.prepare(`SELECT s.*,0 AS experimental,(SELECT COUNT(*) FROM chip_distribution_points p WHERE p.code=s.code AND p.trade_date=s.trade_date) AS distribution_points FROM chip_samples s`).all();
  const experimentalSamples = db.prepare(`SELECT s.*,1 AS experimental,(SELECT COUNT(*) FROM chip_distribution_points p WHERE p.code=s.code AND p.trade_date=s.trade_date) AS distribution_points FROM experimental_chip_samples s`).all();
  const samples = [...productionSamples, ...experimentalSamples].sort((left, right) => String(left.scope).localeCompare(String(right.scope)) || Number(right.sample_label) - Number(left.sample_label) || String(right.trade_date).localeCompare(String(left.trade_date)) || String(left.name).localeCompare(String(right.name), "zh-CN"));
  const registry = [...productionRegistry, ...experimentalRegistry].map((model) => {
    const scoped = samples.filter((sample) => sample.scope === model.scope);
    return { ...model, sample_count: scoped.length, positive_count: scoped.filter((sample) => Number(sample.sample_label) === 1).length, negative_count: scoped.filter((sample) => Number(sample.sample_label) === 0).length };
  });
  return { registry, samples };
}

export function storedChipDistributions(db) {
  const samples = chipSamples(db).samples;
  const unique = new Map();
  for (const sample of samples) if (!unique.has(`${sample.code}|${sample.trade_date}`)) unique.set(`${sample.code}|${sample.trade_date}`, sample);
  const profiles = [...unique.values()].map((sample) => ({
    sampleId: sample.sample_id,
    code: sample.code,
    name: sample.name,
    tradeDate: sample.trade_date,
    close: db.prepare("SELECT close FROM chip_distribution_points WHERE code=? AND trade_date=? LIMIT 1").get(sample.code, sample.trade_date)?.close ?? null,
    main_peak_price: sample.main_peak_price,
    second_peak_price: sample.second_peak_price,
    profit_ratio: sample.profit_ratio,
    peak2_ratio: sample.peak2_ratio,
    peak_width_70: sample.peak_width_70,
    source: db.prepare("SELECT source FROM chip_distribution_points WHERE code=? AND trade_date=? LIMIT 1").get(sample.code, sample.trade_date)?.source ?? null,
    points: db.prepare("SELECT price,chips_ratio FROM chip_distribution_points WHERE code=? AND trade_date=? ORDER BY point_index").all(sample.code, sample.trade_date),
  }));
  return { profiles, missing: profiles.filter((profile) => !profile.points.length || !String(profile.source || "").includes("independent_recurrence_v10")).map(({ code, tradeDate }) => ({ code, trade_date: tradeDate })) };
}

export function saveChipDistributions(db, profiles = []) {
  const remove = db.prepare("DELETE FROM chip_distribution_points WHERE code=? AND trade_date=?");
  const insert = db.prepare("INSERT INTO chip_distribution_points(code,trade_date,point_index,price,chips_ratio,close,source) VALUES(?,?,?,?,?,?,?)");
  const updateMetrics = db.prepare("UPDATE chip_samples SET main_peak_price=?,second_peak_price=?,profit_ratio=?,peak2_ratio=?,peak_width_70=?,profile_ready=1,updated_at=CURRENT_TIMESTAMP WHERE code=? AND trade_date=?");
  const updateExperimentalMetrics = db.prepare("UPDATE experimental_chip_samples SET main_peak_price=?,second_peak_price=?,profit_ratio=?,peak2_ratio=?,peak_width_70=?,profile_ready=1,updated_at=CURRENT_TIMESTAMP WHERE code=? AND trade_date=?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const profile of profiles) {
      const code = String(profile.code || "").toUpperCase(); const tradeDate = String(profile.trade_date || profile.tradeDate || "");
      if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) continue;
      remove.run(code, tradeDate);
      (profile.points || []).slice(0, 20_000).forEach((point, index) => {
        const price = Number(point.price); const ratio = Number(point.chips_ratio);
        if (Number.isFinite(price) && Number.isFinite(ratio) && ratio >= 0) insert.run(code, tradeDate, index, price, ratio, Number.isFinite(Number(profile.close)) ? Number(profile.close) : null, profile.source || "independent_market_duckdb");
      });
      const metric = (snake, camel = snake) => Number.isFinite(Number(profile[snake] ?? profile[camel])) ? Number(profile[snake] ?? profile[camel]) : null;
      const metrics = [metric("main_peak_price", "mainPeakPrice"), metric("second_peak_price", "secondPeakPrice"), metric("profit_ratio", "profitRatio"), metric("peak2_ratio", "peak2Ratio"), metric("peak_width_70", "peakWidth70"), code, tradeDate];
      updateMetrics.run(...metrics);
      updateExperimentalMetrics.run(...metrics);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return storedChipDistributions(db);
}

export function addChipSample(db, input) {
  const scope = input.scope === "formal" ? "formal" : input.scope === "multi_period" ? "multi_period" : "candidate";
  const sampleLabel = Number(input.sampleLabel ?? input.sample_label ?? 1) === 0 ? 0 : 1;
  const code = String(input.code || "").toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate || "")) throw new Error("需要标准证券代码和YYYY-MM-DD交易日");
  const security = db.prepare("SELECT * FROM securities WHERE code=?").get(code);
  if (!security) throw new Error("证券不在独立证券主表中");
  const sampleId = createHash("sha1").update(`${scope}|${code}|${input.tradeDate}`).digest("hex").slice(0, 16);
  const experimental = scope === "multi_period";
  const exists = db.prepare(`SELECT 1 FROM ${experimental ? "experimental_chip_samples" : "chip_samples"} WHERE sample_id=?`).get(sampleId);
  const ready = db.prepare("SELECT 1 FROM chip_axes_snapshot WHERE code=? AND trade_date=?").get(code, input.tradeDate) ? 1 : 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (experimental) {
      db.prepare("INSERT INTO experimental_chip_samples(sample_id,scope,sample_label,code,trade_date,name,reason,source,profile_ready,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(sample_id) DO UPDATE SET sample_label=excluded.sample_label,reason=excluded.reason,profile_ready=excluded.profile_ready,updated_at=CURRENT_TIMESTAMP")
        .run(sampleId, scope, sampleLabel, code, input.tradeDate, security.name, input.reason || `人工确认的第三模型${sampleLabel ? "正" : "负"}样本`, "independent_ui", ready);
      db.prepare(`UPDATE experimental_chip_models SET sample_count=sample_count+?,ready_count=ready_count+?,revision=revision+1,status='sample_collection',updated_at=CURRENT_TIMESTAMP WHERE scope=?`).run(exists ? 0 : 1, exists ? 0 : ready, scope);
    } else {
      db.prepare("INSERT INTO chip_samples(sample_id,scope,sample_label,code,trade_date,name,reason,source,profile_ready,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(sample_id) DO UPDATE SET sample_label=excluded.sample_label,reason=excluded.reason,profile_ready=excluded.profile_ready,updated_at=CURRENT_TIMESTAMP")
        .run(sampleId, scope, sampleLabel, code, input.tradeDate, security.name, input.reason || `人工确认${sampleLabel ? "正" : "负"}样本`, "independent_ui", ready);
      db.prepare("UPDATE model_registry SET sample_count=sample_count+?,revision=revision+1,pending_retrain=1,status='pending_retrain',updated_at=CURRENT_TIMESTAMP WHERE scope=?").run(exists ? 0 : 1, scope);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { sampleId, scope, sampleLabel, code, created: !exists, profileReady: Boolean(ready) };
}

export function deleteChipSample(db, sampleId) {
  const sample = db.prepare("SELECT *,0 AS experimental FROM chip_samples WHERE sample_id=?").get(sampleId)
    || db.prepare("SELECT *,1 AS experimental FROM experimental_chip_samples WHERE sample_id=?").get(sampleId);
  if (!sample) throw new Error("样本不存在");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (sample.experimental) {
      db.prepare("DELETE FROM experimental_chip_samples WHERE sample_id=?").run(sampleId);
      db.prepare("UPDATE experimental_chip_models SET sample_count=MAX(0,sample_count-1),ready_count=MAX(0,ready_count-?),revision=revision+1,status='sample_collection',updated_at=CURRENT_TIMESTAMP WHERE scope=?").run(Number(Boolean(sample.profile_ready)), sample.scope);
    } else {
      db.prepare("DELETE FROM chip_samples WHERE sample_id=?").run(sampleId);
      db.prepare("UPDATE model_registry SET sample_count=MAX(0,sample_count-1),revision=revision+1,pending_retrain=1,status='pending_retrain',updated_at=CURRENT_TIMESTAMP WHERE scope=?").run(sample.scope);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return sample;
}

function resample(values, size = 64) {
  if (values.length === size) return values;
  const output = [];
  for (let index = 0; index < size; index += 1) {
    const position = index * (values.length - 1) / (size - 1);
    const left = Math.floor(position); const right = Math.min(values.length - 1, Math.ceil(position)); const weight = position - left;
    output.push(values[left] * (1 - weight) + values[right] * weight);
  }
  return output;
}

export function runTemplateMatching(db, code) {
  const bars = db.prepare("SELECT * FROM bars_30m WHERE code=? ORDER BY trade_time DESC LIMIT 80").all(code).reverse();
  if (bars.length < 30) throw new Error("30分钟K线不足30根");
  const profile = db.prepare("SELECT * FROM template_profiles WHERE module='m30' AND enabled=1 ORDER BY updated_at DESC LIMIT 1").get();
  if (!profile) throw new Error("没有启用的30分钟模板");
  const closes = resample(bars.slice(-64).map((bar) => numeric(bar.close)), 64);
  const min = Math.min(...closes); const max = Math.max(...closes); const span = Math.max(.0001, max - min);
  const normalized = closes.map((value) => (value - min) / span);
  const vector = JSON.parse(profile.vector_json);
  const rmse = Math.sqrt(normalized.reduce((sum, value, index) => sum + (value - vector[index]) ** 2, 0) / vector.length);
  const similarity = clamp(1 - rmse, 0, 1);
  const platform = bars.slice(-27, -3); const breakout = bars.slice(-3);
  const platformHigh = Math.max(...platform.map((bar) => numeric(bar.high))); const platformLow = Math.min(...platform.map((bar) => numeric(bar.low)));
  const last = breakout.at(-1); const volumeBase = platform.reduce((sum, bar) => sum + numeric(bar.volume), 0) / platform.length;
  const ma20now = bars.slice(-20).reduce((sum, bar) => sum + numeric(bar.close), 0) / 20; const ma20prev = bars.slice(-21, -1).reduce((sum, bar) => sum + numeric(bar.close), 0) / 20;
  const platformCompact = (platformHigh - platformLow) / Math.max(platformLow, .01) <= .16;
  const breakoutHit = numeric(last.close) > platformHigh && numeric(last.volume) >= volumeBase * 1.1;
  const maTurn = ma20now > ma20prev;
  const noChase = numeric(last.close) / Math.max(platformHigh, .01) - 1 <= .08;
  const ruleScore = 100 * (0.30 * Number(platformCompact) + 0.35 * Number(breakoutHit) + 0.20 * Number(maTurn) + 0.15 * Number(noChase));
  const hit = ruleScore >= 72;
  const adjusted = clamp(ruleScore + (similarity - .5) * 10 * numeric(profile.confidence, .65));
  const tradeTime = last.trade_time;
  db.prepare("INSERT INTO template_matches(code,trade_time,template_id,similarity,rule_score,adjusted_score,hit,evidence_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(code,trade_time,template_id) DO UPDATE SET similarity=excluded.similarity,rule_score=excluded.rule_score,adjusted_score=excluded.adjusted_score,hit=excluded.hit,evidence_json=excluded.evidence_json")
    .run(code, tradeTime, profile.template_id, similarity, ruleScore, adjusted, hit ? 1 : 0, JSON.stringify({ platformCompact, breakoutHit, maTurn, noChase, bars: bars.length }));
  db.prepare("UPDATE factor_snapshot SET m30_similarity=? WHERE code=? AND trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)").run(similarity, code);
  return { code, template: profile, similarity, ruleScore, adjustedScore: adjusted, hit, tradeTime, evidence: { platformCompact, breakoutHit, maTurn, noChase }, bars };
}

export function dashboard(db) {
  const recommendations = getRecommendations(db, "all");
  const marketRows = latestFactors(db);
  const factorMeta = { trade_date: marketRows.map((row) => row.trade_date).sort().at(-1) || null, count: marketRows.length, advances: marketRows.filter((row) => numeric(row.pct_chg) > 0).length, amount: marketRows.reduce((sum, row) => sum + numeric(row.amount), 0) };
  const quality = db.prepare("SELECT status,COUNT(*) AS count FROM data_quality_checks WHERE checked_at=(SELECT MAX(checked_at) FROM data_quality_checks) GROUP BY status").all();
  return { recommendations: recommendations.items.slice(0, 8), batches: recommendations.batches, market: factorMeta, models: db.prepare("SELECT * FROM model_registry ORDER BY scope").all(), quality, alerts: db.prepare("SELECT * FROM alerts WHERE status='open' ORDER BY created_at DESC LIMIT 8").all(), generatedAt: new Date().toISOString() };
}

export function dataStatus(db) {
  const latestWatchdog = db.prepare("SELECT version_id FROM data_quality_checks WHERE version_id LIKE 'watchdog-%' ORDER BY checked_at DESC LIMIT 1").get()?.version_id;
  const quality = latestWatchdog ? db.prepare("SELECT * FROM data_quality_checks WHERE version_id=? ORDER BY checked_at DESC").all(latestWatchdog) : db.prepare("SELECT * FROM data_quality_checks ORDER BY checked_at DESC LIMIT 30").all();
  const formal = latestPublishedVersion(db, "formal_daily");
  const factor = governedFactorVersion(db);
  const intraday = latestPublishedVersion(db, "intraday_quotes");
  const lineage = db.prepare(`SELECT d.*,c.trade_date AS child_trade_date,c.status AS child_status,p.trade_date AS parent_trade_date,p.status AS parent_status,p.source AS parent_source
    FROM dataset_dependencies d
    LEFT JOIN dataset_versions c ON c.dataset_key=d.child_dataset_key AND c.version_id=d.child_version_id
    LEFT JOIN dataset_versions p ON p.dataset_key=d.parent_dataset_key AND p.version_id=d.parent_version_id
    ORDER BY d.created_at DESC LIMIT 30`).all();
  return {
    metadata: Object.fromEntries(db.prepare("SELECT key,value FROM metadata").all().map((row) => [row.key, row.value])),
    schedules: db.prepare("SELECT * FROM schedule_definitions ORDER BY session_type,schedule_key").all(), jobs: db.prepare("SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT 20").all(),
    quality, heartbeats: db.prepare("SELECT * FROM watchdog_heartbeats ORDER BY service_key").all(), alerts: db.prepare("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20").all(),
    versions: db.prepare("SELECT * FROM dataset_versions ORDER BY created_at DESC LIMIT 20").all(), lineage,
    dataGovernance: {
      status: formal && factor ? "healthy" : "critical",
      formal: formal || null, factor: factor || null, intraday: intraday || null,
      message: formal && factor ? "正式因子已具备BigQuant+Tushare双源血缘" : "没有可验证的BigQuant+Tushare双源正式因子；禁止发布新推荐",
    },
    acquisitions: db.prepare("SELECT * FROM data_acquisition_batches ORDER BY completed_at DESC LIMIT 20").all(),
    maintenance: db.prepare("SELECT * FROM maintenance_events ORDER BY created_at DESC LIMIT 20").all(),
  };
}

function qualityCheck(db, dataset, name, severity, pass, observed, expected, message, versionId = "watchdog") {
  db.prepare("INSERT INTO data_quality_checks(check_id,dataset_key,version_id,check_name,severity,status,observed_value,expected_value,message,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), dataset, versionId, name, severity, pass ? "pass" : "fail", String(observed), String(expected), message, new Date().toISOString());
  const title = `${dataset}质量门禁失败`;
  if (!pass && severity === "critical" && !db.prepare("SELECT 1 FROM alerts WHERE source='watchdog' AND title=? AND status='open'").get(title)) {
    db.prepare("INSERT INTO alerts(alert_id,severity,source,title,message,status,created_at) VALUES(?,?,?,?,?,'open',?)").run(randomUUID(), severity, "watchdog", title, message, new Date().toISOString());
  }
  if (pass) db.prepare("UPDATE alerts SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE source='watchdog' AND title=? AND status='open'").run(title);
  return pass;
}

export function runWatchdog(db) {
  const now = new Date().toISOString();
  const runId = `watchdog-${Date.now()}-${randomUUID().slice(0, 6)}`;
  let criticalFailures = 0;
  const factor = db.prepare("SELECT COUNT(*) AS count,SUM(CASE WHEN close IS NULL OR ret_20d IS NULL THEN 1 ELSE 0 END) AS missing FROM factor_snapshot WHERE trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)").get();
  const governed = governedFactorVersion(db);
  if (!qualityCheck(db, "factor_snapshot", "正式双源血缘", "critical", Boolean(governed), governed?.version_id || "missing", "BigQuant+Tushare formal_daily -> factor_snapshot", governed ? `正式因子${governed.trade_date}血缘可追溯` : "当前因子未关联已发布的BigQuant+Tushare正式日线，禁止新推荐", runId)) criticalFailures += 1;
  if (!qualityCheck(db, "factor_snapshot", "股票覆盖数", "critical", factor.count >= 400, factor.count, ">=400", factor.count >= 400 ? "覆盖正常" : "股票覆盖骤降，禁止发布新版本", runId)) criticalFailures += 1;
  const missingRate = factor.count ? factor.missing / factor.count : 1;
  if (!qualityCheck(db, "factor_snapshot", "关键字段空值率", "critical", missingRate <= .08, `${(missingRate * 100).toFixed(2)}%`, "<=8%", missingRate <= .08 ? "完整率正常" : "空值率超限，保留旧快照", runId)) criticalFailures += 1;
  const history = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT b.code FROM bars_daily b
    JOIN factor_snapshot f ON f.code=b.code AND f.trade_date=(SELECT MAX(trade_date) FROM factor_snapshot)
    GROUP BY b.code HAVING COUNT(*)>=80
  )`).get();
  const historyCoverage = factor.count ? numeric(history?.count) / factor.count : 0;
  if (!qualityCheck(db, "bars_daily", "AIA日线历史覆盖", "critical", historyCoverage >= .95, `${numeric(history?.count)}/${factor.count} (${(historyCoverage * 100).toFixed(2)}%)`, ">=95%股票具备80根", historyCoverage >= .95 ? "AIA日线形态历史覆盖正常" : "AIA历史缓存未覆盖当前正式因子池，禁止发布新AIA批次", runId)) criticalFailures += 1;
  const quoteDate = db.prepare("SELECT MAX(substr(quote_time,1,10)) AS date FROM realtime_quotes").get()?.date || null;
  const quoteQuality = quoteDate ? db.prepare(`SELECT COUNT(*) AS count,
    SUM(CASE WHEN unit_version='aster_intraday_units_v1' THEN 1 ELSE 0 END) AS canonical_count,
    SUM(CASE WHEN turnover_rate IS NOT NULL AND turnover_rate>=0 AND turnover_rate<=300 THEN 1 ELSE 0 END) AS turnover_count,
    SUM(CASE WHEN price IS NULL OR price<=0 OR volume IS NULL OR volume<0 OR amount IS NULL OR amount<0
      OR (pct_chg IS NOT NULL AND (pct_chg < -1000 OR pct_chg > 1000))
      OR (volume>0 AND amount>0 AND ((amount/volume/price)<0.2 OR (amount/volume/price)>5.0))
      THEN 1 ELSE 0 END) AS invalid_count
    FROM realtime_quotes WHERE substr(quote_time,1,10)=?`).get(quoteDate) : { count: 0, canonical_count: 0, turnover_count: 0, invalid_count: 0 };
  const quoteCount = numeric(quoteQuality.count);
  const enforceIntraday = activeIntradayWindow();
  const unitCoverage = quoteCount ? numeric(quoteQuality.canonical_count) / quoteCount : 0;
  const turnoverCoverage = quoteCount ? numeric(quoteQuality.turnover_count) / quoteCount : 0;
  const unitPass = quoteCount > 0 ? unitCoverage >= .999 : !enforceIntraday;
  const turnoverPass = quoteCount > 0 ? turnoverCoverage >= .95 : !enforceIntraday;
  const rangePass = quoteCount > 0 ? numeric(quoteQuality.invalid_count) === 0 : !enforceIntraday;
  if (!qualityCheck(db, "realtime_quotes", "盘中单位契约", "critical", unitPass, `${quoteDate || "missing"} ${numeric(quoteQuality.canonical_count)}/${quoteCount} (${(unitCoverage * 100).toFixed(2)}%)`, "aster_intraday_units_v1=100%", unitPass ? "盘中价/量/额/百分比已统一为标准口径" : "发现无单位版本或旧口径快照，禁止继续发布", runId)) criticalFailures += 1;
  if (!qualityCheck(db, "realtime_quotes", "换手率覆盖", "critical", turnoverPass, `${numeric(quoteQuality.turnover_count)}/${quoteCount} (${(turnoverCoverage * 100).toFixed(2)}%)`, ">=95%", turnoverPass ? "换手率已用正式流通股本反算或经核验的源值补齐" : "换手率缺失过多，禁止下游筹码递推", runId)) criticalFailures += 1;
  if (!qualityCheck(db, "realtime_quotes", "金额成交量一致性", "critical", rangePass, numeric(quoteQuality.invalid_count), "0", rangePass ? "金额÷股数与价格数量级一致" : "金额/成交量反算均价异常，疑似手/股或元/万元混用", runId)) criticalFailures += 1;
  const securityCount = numeric(db.prepare("SELECT COUNT(*) AS count FROM securities").get()?.count);
  const chipDate = db.prepare("SELECT MAX(trade_date) AS date FROM chip_axes_snapshot").get()?.date;
  const chipAxes = chipDate ? db.prepare(`SELECT COUNT(*) AS count,COUNT(DISTINCT source) AS source_count,MIN(source) AS source,
    SUM(CASE WHEN source LIKE '%chip_distribution+chip_factor_daily%' OR lower(source) LIKE '%bigquant%chip%' THEN 1 ELSE 0 END) AS contaminated
    FROM chip_axes_snapshot WHERE trade_date=?`).get(chipDate) : { count: 0, source_count: 0, source: "missing", contaminated: 0 };
  const chipCoverage = securityCount ? numeric(chipAxes.count) / securityCount : 0;
  const cleanChipSource = numeric(chipAxes.contaminated) === 0
    && numeric(chipAxes.source_count) === 1
    && String(chipAxes.source || "").includes("current_chip_factor_daily");
  if (!qualityCheck(db, "chip_axes_snapshot", "独立递推覆盖", "critical", chipCoverage >= .95, `${numeric(chipAxes.count)}/${securityCount} (${(chipCoverage * 100).toFixed(2)}%)`, ">=95%", chipCoverage >= .95 ? `收盘递推截面${chipDate}覆盖正常` : "独立递推筹码覆盖不足，禁止发布排名", runId)) criticalFailures += 1;
  if (!qualityCheck(db, "chip_axes_snapshot", "筹码来源无污染", "critical", cleanChipSource, `${chipAxes.source || "missing"}; contaminated=${numeric(chipAxes.contaminated)}`, "仅current_chip_factor_daily独立递推", cleanChipSource ? "未读取BigQuant筹码字段或稀疏回退" : "发现非独立递推筹码来源，禁止发布排名", runId)) criticalFailures += 1;
  const chipRank = db.prepare("SELECT MAX(trade_date) AS date,COUNT(*) AS count FROM chip_model_rank_daily WHERE trade_date=(SELECT MAX(trade_date) FROM chip_model_rank_daily)").get();
  const chipRankAligned = Boolean(chipDate) && chipRank?.date === chipDate && numeric(chipRank?.count) === numeric(chipAxes.count);
  if (!qualityCheck(db, "chip_model_rank_daily", "筹码排名同截面", "critical", chipRankAligned, `${chipRank?.date || "missing"}/${numeric(chipRank?.count)}`, `${chipDate || "missing"}/${numeric(chipAxes.count)}`, chipRankAligned ? "双模型排名与独立递推截面完全一致" : "排名日期或股票集合与递推截面不一致", runId)) criticalFailures += 1;
  // ABCD's original D>99.5 hard gate may validly publish a single stock;
  // AIA, by contrast, is an exact Top10 contract.  Keep watchdog thresholds
  // aligned with each model's actual publication gate.
  for (const [key, minimum] of [["abcd", 1], ["aia", 10], ["heat", 5]]) {
    const batch = db.prepare("SELECT item_count,finished_at FROM recommendation_batches WHERE model_key=? AND status='published' ORDER BY finished_at DESC LIMIT 1").get(key);
    qualityCheck(db, `recommendation_${key}`, "最新批次数量", "warning", numeric(batch?.item_count) >= minimum, numeric(batch?.item_count), `>=${minimum}`, numeric(batch?.item_count) >= minimum ? "推荐批次正常" : "推荐数不足，不替换上一批次", runId);
  }
  const lastFullIntegrity = db.prepare("SELECT value FROM metadata WHERE key='watchdog_full_integrity_at'").get()?.value;
  const useFullIntegrity = !lastFullIntegrity || Date.now() - Date.parse(lastFullIntegrity) > 23 * 60 * 60 * 1000;
  const integrity = useFullIntegrity ? db.prepare("PRAGMA integrity_check").get()?.integrity_check : db.prepare("PRAGMA quick_check").get()?.quick_check;
  if (useFullIntegrity) db.prepare("INSERT INTO metadata(key,value,updated_at) VALUES('watchdog_full_integrity_at',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(now);
  if (!qualityCheck(db, "database", useFullIntegrity ? "SQLite完整性" : "SQLite快速完整性", "critical", integrity === "ok", integrity, "ok", integrity === "ok" ? "数据库完整" : "数据库损坏风险", runId)) criticalFailures += 1;
  for (const registry of db.prepare("SELECT * FROM model_registry").all()) {
    const path = join(projectDir, registry.model_path || "");
    const metadataPath = path.replace(/model\.joblib$/i, "model.json");
    const canonicalPath = join(projectDir, "data", registry.scope === "formal" ? "chip_shape_model_current" : "chip_shape_model_candidate_current", "model.joblib");
    let metadata = null; try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); } catch {}
    const featureColumns = Array.isArray(metadata?.feature_columns) ? metadata.feature_columns : [];
    const valid = existsSync(path) && statSync(path).size > 0 && existsSync(canonicalPath)
      && featureColumns.length === 24 && featureColumns.includes("cost_line_main_peak_abs_distance_rank_pct")
      && metadata?.model_version === registry.model_version
      && createHash("sha256").update(readFileSync(path)).digest("hex") === createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
    const digest = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : "missing";
    const observed = existsSync(path) ? `${statSync(path).size}B / ${digest} / ${featureColumns.length}维` : "missing";
    if (!qualityCheck(db, `model_${registry.scope}`, "双镜像24维模型契约", "critical", valid, observed, "joblib双镜像一致 + 元数据版本一致 + 24维成本峰距", valid ? "正式运行时与数据目录模型完全一致" : "模型缺失、版本/维度错误或双镜像不一致", runId)) criticalFailures += 1;
  }
  const stuck = db.prepare("SELECT COUNT(*) AS count FROM sync_jobs WHERE status='running' AND started_at<datetime('now','-30 minutes')").get()?.count || 0;
  qualityCheck(db, "scheduler", "超时任务", "warning", stuck === 0, stuck, "0", stuck ? "存在运行超过30分钟的任务" : "无超时任务", runId);
  const latestBackup = db.prepare("SELECT created_at,status FROM backup_registry ORDER BY created_at DESC LIMIT 1").get();
  const backupAgeHours = latestBackup ? (Date.now() - Date.parse(latestBackup.created_at)) / 3_600_000 : Infinity;
  qualityCheck(db, "backup", "最近备份", "warning", latestBackup?.status === "verified" && backupAgeHours <= 36, latestBackup ? `${latestBackup.status}/${backupAgeHours.toFixed(1)}h` : "尚未备份", "verified且<=36h", latestBackup ? "最近备份状态与时效已核验" : "启动恢复会安排补备份", runId);
  const status = criticalFailures ? "degraded" : "healthy";
  db.prepare("INSERT INTO watchdog_heartbeats(service_key,status,pid,last_heartbeat_at,last_error,restart_count,details_json) VALUES('engine',?,?,?, ?,0,?) ON CONFLICT(service_key) DO UPDATE SET status=excluded.status,pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error=excluded.last_error,details_json=excluded.details_json")
    .run(status, process.pid, now, criticalFailures ? `${criticalFailures}项关键门禁失败` : null, JSON.stringify({ databasePath, factorCount: factor.count, history80Count: numeric(history?.count), history80Coverage: historyCoverage, governedFactorVersion: governed?.version_id || null, intraday: { quoteDate, quoteCount, unitCoverage, turnoverCoverage, invalidCount: numeric(quoteQuality.invalid_count) }, integrityMode: useFullIntegrity ? "full" : "quick", integrity, criticalFailures }));
  return { status, checkedAt: now, factorCount: factor.count, history80Count: numeric(history?.count), history80Coverage: historyCoverage, intraday: { quoteDate, quoteCount, unitCoverage, turnoverCoverage, invalidCount: numeric(quoteQuality.invalid_count) }, integrity, criticalFailures };
}

export async function backupDatabase(db) {
  const backupDir = join(projectDir, "data", "backups"); mkdirSync(backupDir, { recursive: true });
  const backupId = `aster-${shanghaiDate()}-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
  const target = join(backupDir, `${backupId}.db`);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  await sqliteBackup(db, target);
  const size = statSync(target).size; const checksum = createHash("sha256").update(readFileSync(target)).digest("hex");
  db.prepare("INSERT INTO backup_registry(backup_id,database_path,backup_path,size_bytes,checksum,status,created_at,verified_at) VALUES(?,?,?,?,?,'verified',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(backupId, databasePath, target, size, checksum);
  const retention = pruneBackupRetention(db, backupDir);
  return { backupId, target, size, checksum, retention };
}

export function pruneBackupRetention(db, backupDir = join(projectDir, "data", "backups")) {
  if (!existsSync(backupDir)) return { removed: [], kept: [] };
  const root = resolve(backupDir).toLowerCase();
  const rows = db.prepare("SELECT * FROM backup_registry WHERE status='verified' ORDER BY created_at DESC").all();
  const byDate = new Map();
  for (const row of rows) {
    const date = normalizedTimestampDate(row.created_at) || String(row.backup_id).match(/20\d{2}-\d{2}-\d{2}/)?.[0];
    if (date && !byDate.has(date)) byDate.set(date, row);
  }
  const dates = [...byDate.keys()].sort().reverse();
  const keepIds = new Set(dates.slice(0, 7).map((date) => byDate.get(date).backup_id));
  const weekKeys = new Set();
  for (const date of dates.slice(7)) {
    const cursor = new Date(`${date}T12:00:00Z`);
    const monday = new Date(cursor); monday.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
    const week = monday.toISOString().slice(0, 10);
    if (weekKeys.size >= 4 && !weekKeys.has(week)) continue;
    if (!weekKeys.has(week)) { weekKeys.add(week); keepIds.add(byDate.get(date).backup_id); }
  }
  const removed = [];
  for (const row of rows) {
    if (keepIds.has(row.backup_id)) continue;
    const target = resolve(String(row.backup_path || ""));
    if (!target.toLowerCase().startsWith(`${root}\\`) || target.toLowerCase() === root) continue;
    if (existsSync(target) && readdirSync(backupDir).includes(target.split(/[\\/]/).at(-1))) unlinkSync(target);
    db.prepare("DELETE FROM backup_registry WHERE backup_id=?").run(row.backup_id);
    removed.push(row.backup_id);
  }
  return { removed, kept: [...keepIds] };
}

export function withJob(db, jobType, source, action) {
  const jobId = randomUUID(); const started = new Date().toISOString();
  db.prepare("INSERT INTO sync_jobs(job_id,job_type,status,source,rows_changed,message,started_at) VALUES(?,?,'running',?,0,'',?)").run(jobId, jobType, source, started);
  try {
    const result = action();
    db.prepare("UPDATE sync_jobs SET status='success',rows_changed=?,message=?,finished_at=? WHERE job_id=?").run(numeric(result?.count), result?.message || "任务完成", new Date().toISOString(), jobId);
    return { jobId, ...result };
  } catch (error) {
    db.prepare("UPDATE sync_jobs SET status='failed',message=?,finished_at=? WHERE job_id=?").run(error.message, new Date().toISOString(), jobId);
    throw error;
  }
}
