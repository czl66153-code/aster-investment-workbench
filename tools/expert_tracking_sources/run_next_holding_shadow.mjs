#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const workspace = path.resolve(import.meta.dirname, "..", "..");
const MODEL_VERSION = "expert-next-holding-continuous-v1.1.0";
const DEFAULT_PROFILES = path.join(workspace, "web", "expert-tracker", "data", "expert_profiles.json");
const DEFAULT_ASTER_DB = path.join(workspace, "data", "aster.db");
const DEFAULT_SHADOW_DB = path.join(workspace, "data", "experiments", "expert_next_holding_shadow.db");
const DEFAULT_OUTPUT = path.join(workspace, "outputs", "expert_tracking", "next_holding_shadow");
const TRADE_CALENDAR_PATH = path.join(workspace, "engine", "models", "aia", "trade_calendar.json");
const TRADE_CALENDAR = JSON.parse(fs.readFileSync(TRADE_CALENDAR_PATH, "utf8"));

const SEED_EXPERTS = [
  { name: "菜鸟123456", source: "复利笔记" },
  { name: "皮韭炒家", source: "复利笔记" },
  { name: "冰冰watermelon", source: "复利笔记" },
  { name: "素贼兄弟", source: "复利笔记" },
  { name: "在座的各位都是", source: "复利笔记" },
  { name: "提高审美不做杂毛", source: "复利笔记" },
  { name: "第四维度的保佑", source: "复利笔记" },
  { name: "干锅鸡尾虾", source: "复利笔记" },
  { name: "乌江望月", source: "复利笔记", auxiliarySources: ["顽主杯"] },
];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) { return process.argv.includes(name); }
function cleanCode(value) { return String(value || "").replace(/\D/g, "").slice(0, 6); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function value100(value) { return Number.isFinite(Number(value)) ? clamp(Number(value) / 100) : null; }
function round(value, digits = 6) { return Number(Number(value).toFixed(digits)); }
function json(value) { return JSON.stringify(value); }
function parseJson(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isoNow() { return new Date().toISOString(); }

function nextWeekday(dateText) {
  const date = new Date(`${dateText}T12:00:00+08:00`);
  for (let attempts = 0; attempts < 20; attempts += 1) {
    date.setUTCDate(date.getUTCDate() + 1);
    const candidate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    if (Object.hasOwn(TRADE_CALENDAR, candidate) ? TRADE_CALENDAR[candidate] === true : ![0, 6].includes(date.getUTCDay())) return candidate;
  }
  throw new Error(`${dateText}之后20天内找不到A股交易日`);
}

function weightedMean(entries) {
  const valid = entries.filter(([value, weight]) => Number.isFinite(value) && weight > 0);
  const denominator = valid.reduce((sum, [, weight]) => sum + weight, 0);
  return denominator ? valid.reduce((sum, [value, weight]) => sum + value * weight, 0) / denominator : 0.5;
}

function sigmoid(value) { return 1 / (1 + Math.exp(-value)); }

function schema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS shadow_runs (
      run_id TEXT PRIMARY KEY,
      as_of_date TEXT NOT NULL,
      target_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      model_version TEXT NOT NULL,
      status TEXT NOT NULL,
      profile_hash TEXT NOT NULL,
      market_feature_date TEXT,
      chip_feature_date TEXT,
      feature_manifest_json TEXT NOT NULL,
      note TEXT NOT NULL,
      UNIQUE(as_of_date, target_date, model_version)
    );
    CREATE TABLE IF NOT EXISTS shadow_experts (
      run_id TEXT NOT NULL REFERENCES shadow_runs(run_id),
      expert_key TEXT NOT NULL,
      expert_name TEXT NOT NULL,
      source TEXT NOT NULL,
      latest_holding_date TEXT NOT NULL,
      history_days INTEGER NOT NULL,
      transition_count INTEGER NOT NULL,
      unique_stock_count INTEGER NOT NULL,
      mapping_pct REAL NOT NULL,
      style_shift REAL NOT NULL,
      baseline_holdings_json TEXT NOT NULL,
      calibration_json TEXT NOT NULL,
      PRIMARY KEY(run_id, expert_key)
    );
    CREATE TABLE IF NOT EXISTS shadow_predictions (
      run_id TEXT NOT NULL REFERENCES shadow_runs(run_id),
      expert_key TEXT NOT NULL,
      expert_name TEXT NOT NULL,
      source TEXT NOT NULL,
      rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 5),
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      probability REAL NOT NULL CHECK(probability BETWEEN 0 AND 1),
      score REAL NOT NULL,
      current_holding INTEGER NOT NULL CHECK(current_holding IN (0,1)),
      history_component REAL NOT NULL,
      recent_style_component REAL NOT NULL,
      site_component REAL NOT NULL,
      reasons_json TEXT NOT NULL,
      PRIMARY KEY(run_id, expert_key, rank),
      UNIQUE(run_id, expert_key, stock_code)
    );
    CREATE TABLE IF NOT EXISTS shadow_actuals (
      run_id TEXT NOT NULL REFERENCES shadow_runs(run_id),
      expert_key TEXT NOT NULL,
      target_date TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      amount_wan REAL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(run_id, expert_key, stock_code)
    );
    CREATE TABLE IF NOT EXISTS shadow_evaluations (
      run_id TEXT NOT NULL REFERENCES shadow_runs(run_id),
      expert_key TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      actual_available INTEGER NOT NULL CHECK(actual_available IN (0,1)),
      actual_count INTEGER,
      hit_count INTEGER,
      retained_hit_count INTEGER,
      new_buy_hit_count INTEGER,
      precision_at_5 REAL,
      actual_recall REAL,
      brier_score REAL,
      detail_json TEXT NOT NULL,
      PRIMARY KEY(run_id, expert_key)
    );
    CREATE TABLE IF NOT EXISTS shadow_participants (
      participant_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      person_id TEXT NOT NULL,
      expert_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('watch','probation','active','paused','retired')),
      manual_seed INTEGER NOT NULL DEFAULT 0 CHECK(manual_seed IN (0,1)),
      discovered_at TEXT NOT NULL,
      activated_at TEXT,
      paused_at TEXT,
      retired_at TEXT,
      last_profile_date TEXT,
      last_holding_date TEXT,
      observation_days INTEGER NOT NULL DEFAULT 0,
      transition_count INTEGER NOT NULL DEFAULT 0,
      unique_stock_count INTEGER NOT NULL DEFAULT 0,
      mapping_pct REAL NOT NULL DEFAULT 0,
      total_return_pct REAL,
      qualifying_streak INTEGER NOT NULL DEFAULT 0,
      stale_trading_days INTEGER NOT NULL DEFAULT 0,
      status_reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shadow_participant_observations (
      participant_key TEXT NOT NULL REFERENCES shadow_participants(participant_key),
      as_of_date TEXT NOT NULL,
      qualifies INTEGER NOT NULL CHECK(qualifies IN (0,1)),
      is_fresh INTEGER NOT NULL CHECK(is_fresh IN (0,1)),
      observation_days INTEGER NOT NULL,
      transition_count INTEGER NOT NULL,
      mapping_pct REAL NOT NULL,
      total_return_pct REAL,
      latest_holding_date TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(participant_key, as_of_date)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_runs_target_status ON shadow_runs(target_date, status);
    CREATE INDEX IF NOT EXISTS idx_shadow_predictions_expert ON shadow_predictions(expert_name, run_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_actuals_target_expert ON shadow_actuals(target_date, expert_key);
    CREATE INDEX IF NOT EXISTS idx_shadow_evaluations_run_available ON shadow_evaluations(run_id, actual_available);
    CREATE INDEX IF NOT EXISTS idx_shadow_participants_status_updated ON shadow_participants(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_shadow_participant_observations_date ON shadow_participant_observations(as_of_date, qualifies);
    PRAGMA optimize;
  `);
  const runColumns = new Set(db.prepare("PRAGMA table_info(shadow_runs)").all().map((column) => column.name));
  if (!runColumns.has("score_eligible")) db.exec("ALTER TABLE shadow_runs ADD COLUMN score_eligible INTEGER NOT NULL DEFAULT 1 CHECK(score_eligible IN (0,1))");
  if (!runColumns.has("score_eligibility_reason")) db.exec("ALTER TABLE shadow_runs ADD COLUMN score_eligibility_reason TEXT NOT NULL DEFAULT '目标交易日前冻结'");
  db.prepare("UPDATE shadow_runs SET score_eligible=0,score_eligibility_reason='目标交易日开盘后冻结，仅作试运行，不计入正式盲测' WHERE date(frozen_at,'+8 hours')>=target_date").run();
  db.exec("CREATE INDEX IF NOT EXISTS idx_shadow_runs_score_target ON shadow_runs(score_eligible,target_date,status)");
}

function securityMaps(db, profiles, asOf = "9999-12-31") {
  const securities = db.prepare("SELECT code,symbol,name,industry,market FROM securities").all();
  const byCode = new Map();
  const byName = new Map();
  for (const security of securities) {
    byCode.set(cleanCode(security.code), security);
    byCode.set(cleanCode(security.symbol), security);
    if (security.name) byName.set(String(security.name).trim(), security);
  }
  for (const profile of profiles) {
    for (const snapshot of profile.history || []) {
      if (snapshot.date > asOf) continue;
      for (const holding of snapshot.holdings || []) {
        const code = cleanCode(holding.stockCode);
        const name = String(holding.stockName || "").trim();
        if (code && name && byCode.has(code)) byName.set(name, byCode.get(code));
      }
    }
  }
  return { securities, byCode, byName };
}

function resolveStock(holding, maps) {
  const code = cleanCode(holding?.stockCode);
  const name = String(holding?.stockName || "").trim();
  return (code && maps.byCode.get(code)) || (name && maps.byName.get(name)) || null;
}

function snapshotSets(profile, asOf, maps) {
  return (profile.history || [])
    .filter((snapshot) => snapshot.date <= asOf && (snapshot.holdings || []).length > 0)
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((snapshot) => {
      const holdings = new Map();
      for (const item of snapshot.holdings || []) {
        const security = resolveStock(item, maps);
        if (security) holdings.set(security.code, { ...security, amountWan: Number(item.amountWan) || 0 });
      }
      return { date: snapshot.date, holdings };
    })
    .filter((snapshot) => snapshot.holdings.size > 0);
}

function tradingDaysBetween(fromDate, toDate) {
  if (!fromDate || !toDate || fromDate >= toDate) return 0;
  const cursor = new Date(`${fromDate}T12:00:00+08:00`);
  const end = new Date(`${toDate}T12:00:00+08:00`);
  let count = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(cursor);
    const isOpen = Object.hasOwn(TRADE_CALENDAR, candidate) ? TRADE_CALENDAR[candidate] === true : ![0, 6].includes(cursor.getUTCDay());
    if (isOpen && cursor <= end) count += 1;
  }
  return count;
}

function percentile(values, fraction) {
  const rows = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return 0;
  return rows[Math.min(rows.length - 1, Math.max(0, Math.floor((rows.length - 1) * fraction)))];
}

function profileLifecycleMetrics(profile, asOf, maps) {
  const snapshots = snapshotSets(profile, asOf, maps);
  const rawItems = (profile.history || []).filter((snapshot) => snapshot.date <= asOf).flatMap((snapshot) => snapshot.holdings || []);
  const resolvedItems = snapshots.flatMap((snapshot) => [...snapshot.holdings.values()]);
  const latestProfile = (profile.history || []).filter((snapshot) => snapshot.date <= asOf).sort((left, right) => left.date.localeCompare(right.date)).at(-1);
  const latestHolding = snapshots.at(-1);
  const latestValidDisclosure = (profile.history || []).filter((snapshot) => snapshot.date <= asOf && ((snapshot.holdings || []).length > 0
    || ((Number(snapshot.positionPct) || 0) <= 5 && (Number(snapshot.investedAmountWan) || 0) <= 0))).sort((left, right) => left.date.localeCompare(right.date)).at(-1);
  const totalReturnPct = Number(latestProfile?.totalReturnPct ?? profile.latestSnapshot?.totalReturnPct);
  return {
    participantKey: `${profile.source}:${profile.personId}`,
    source: profile.source,
    personId: String(profile.personId || ""),
    expertName: profile.personName,
    latestProfileDate: latestProfile?.date || null,
    latestHoldingDate: latestValidDisclosure?.date || latestHolding?.date || null,
    observationDays: snapshots.length,
    transitionCount: Math.max(0, snapshots.length - 1),
    uniqueStockCount: new Set(resolvedItems.map((item) => item.code)).size,
    mappingPct: rawItems.length ? round(100 * resolvedItems.length / rawItems.length, 2) : 0,
    totalReturnPct: Number.isFinite(totalReturnPct) ? totalReturnPct : null,
    staleTradingDays: tradingDaysBetween(latestValidDisclosure?.date || latestHolding?.date, asOf),
  };
}

function recentQualifyingStreak(db, participantKey) {
  const rows = db.prepare("SELECT qualifies FROM shadow_participant_observations WHERE participant_key=? ORDER BY as_of_date DESC LIMIT 6").all(participantKey);
  let streak = 0;
  for (const row of rows) { if (row.qualifies !== 1) break; streak += 1; }
  return streak;
}

function updateParticipantLifecycle(shadowDb, profiles, asOf, maps) {
  const competitionProfiles = profiles.filter((profile) => ["复利笔记", "顽主杯"].includes(profile.source) && (profile.transactions || []).length > 0);
  const metrics = competitionProfiles.map((profile) => ({ profile, metrics: profileLifecycleMetrics(profile, asOf, maps) }));
  const returnThresholds = new Map();
  for (const source of ["复利笔记", "顽主杯"]) {
    const returns = metrics.filter((item) => item.metrics.source === source && item.metrics.observationDays >= 10).map((item) => item.metrics.totalReturnPct);
    returnThresholds.set(source, Math.max(10, percentile(returns, 0.85)));
  }
  const seedKeys = new Set(SEED_EXPERTS.map((seed) => {
    const match = competitionProfiles.find((profile) => profile.source === seed.source && profile.personName === seed.name);
    return match ? `${match.source}:${match.personId}` : `${seed.source}:missing:${seed.name}`;
  }));
  const existingRows = new Map(shadowDb.prepare("SELECT * FROM shadow_participants").all().map((row) => [row.participant_key, row]));
  const now = isoNow();
  const upsert = shadowDb.prepare(`INSERT INTO shadow_participants(participant_key,source,person_id,expert_name,status,manual_seed,discovered_at,activated_at,paused_at,retired_at,last_profile_date,last_holding_date,observation_days,transition_count,unique_stock_count,mapping_pct,total_return_pct,qualifying_streak,stale_trading_days,status_reason,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(participant_key) DO UPDATE SET source=excluded.source,person_id=excluded.person_id,expert_name=excluded.expert_name,status=excluded.status,manual_seed=excluded.manual_seed,activated_at=excluded.activated_at,paused_at=excluded.paused_at,retired_at=excluded.retired_at,last_profile_date=excluded.last_profile_date,last_holding_date=excluded.last_holding_date,observation_days=excluded.observation_days,transition_count=excluded.transition_count,unique_stock_count=excluded.unique_stock_count,mapping_pct=excluded.mapping_pct,total_return_pct=excluded.total_return_pct,qualifying_streak=excluded.qualifying_streak,stale_trading_days=excluded.stale_trading_days,status_reason=excluded.status_reason,updated_at=excluded.updated_at`);
  const observe = shadowDb.prepare(`INSERT OR IGNORE INTO shadow_participant_observations(participant_key,as_of_date,qualifies,is_fresh,observation_days,transition_count,mapping_pct,total_return_pct,latest_holding_date,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const tracked = [];
  for (const item of metrics) {
    const m = item.metrics;
    const current = existingRows.get(m.participantKey);
    const manualSeed = seedKeys.has(m.participantKey) || current?.manual_seed === 1;
    const returnThreshold = returnThresholds.get(m.source) || 10;
    const qualifies = m.observationDays >= 10 && m.transitionCount >= 8 && m.uniqueStockCount >= 5 && m.mappingPct >= 85 && m.staleTradingDays <= 1 && Number(m.totalReturnPct) >= returnThreshold;
    if (!manualSeed && !current && !qualifies) continue;
    const initialStatus = manualSeed ? "active" : "probation";
    upsert.run(m.participantKey, m.source, m.personId, m.expertName, current?.status || initialStatus, Number(manualSeed), current?.discovered_at || now, current?.activated_at || (manualSeed ? now : null), current?.paused_at || null, current?.retired_at || null, m.latestProfileDate, m.latestHoldingDate, m.observationDays, m.transitionCount, m.uniqueStockCount, m.mappingPct, m.totalReturnPct, current?.qualifying_streak || 0, m.staleTradingDays, current?.status_reason || (manualSeed ? "首轮人工确认种子选手" : "高收益新人进入连续观察"), now);
    observe.run(m.participantKey, asOf, Number(qualifies), Number(m.staleTradingDays <= 1), m.observationDays, m.transitionCount, m.mappingPct, m.totalReturnPct, m.latestHoldingDate, now);
    const streak = recentQualifyingStreak(shadowDb, m.participantKey);
    let status = current?.status || initialStatus;
    let reason = current?.status_reason || "等待状态评估";
    let activatedAt = current?.activated_at || (manualSeed ? now : null);
    let pausedAt = current?.paused_at || null;
    let retiredAt = current?.retired_at || null;
    if (m.staleTradingDays >= 10 && !manualSeed && m.source === "复利笔记") {
      status = "retired"; reason = `连续${m.staleTradingDays}个交易日无有效持仓披露，退出预测名单`; retiredAt ||= now;
    } else if (m.staleTradingDays >= 3) {
      status = "paused"; reason = `连续${m.staleTradingDays}个交易日无有效持仓披露或未被榜单覆盖，暂停预测但保留历史`; pausedAt ||= now;
    } else if (["paused", "retired"].includes(status) && m.staleTradingDays <= 1 && m.observationDays >= 20 && m.mappingPct >= 90) {
      status = "active"; reason = "恢复有效披露且数据质量达标，重新进入预测"; activatedAt ||= now; pausedAt = null; retiredAt = null;
    } else if (!manualSeed && status !== "active" && streak >= 3 && m.observationDays >= 20 && m.transitionCount >= 15 && m.mappingPct >= 90) {
      status = "active"; reason = `连续${streak}次满足高收益、新鲜度和数据质量门槛`; activatedAt ||= now;
    } else if (!manualSeed && !["active", "paused", "retired"].includes(status)) {
      status = qualifies ? "probation" : "watch";
      reason = qualifies ? `已连续满足${streak}次，满3次且样本达标后转正式预测` : "收益、样本或数据新鲜度暂未同时达标";
    } else if (status === "active") {
      reason = manualSeed ? "种子选手持续披露，保留正式预测" : "自动入选选手持续满足预测门槛";
    }
    upsert.run(m.participantKey, m.source, m.personId, m.expertName, status, Number(manualSeed), current?.discovered_at || now, activatedAt, pausedAt, retiredAt, m.latestProfileDate, m.latestHoldingDate, m.observationDays, m.transitionCount, m.uniqueStockCount, m.mappingPct, m.totalReturnPct, streak, m.staleTradingDays, reason, now);
    tracked.push({ ...m, status, manualSeed, qualifyingStreak: streak, statusReason: reason });
  }
  return {
    tracked,
    active: tracked.filter((item) => item.status === "active"),
    thresholds: Object.fromEntries(returnThresholds),
    policy: {
      newcomer: "来源内累计收益前15%且不低于10%，至少10个有效持仓日、8次相邻变化、映射率85%，连续3次达标且满20日后激活",
      pause: "连续3个交易日无有效持仓披露",
      retire: "连续10个交易日无有效持仓披露",
      reactivate: "恢复披露且至少20日样本、映射率90%",
      historyRetention: "暂停或退出不删除历史预测和准确度",
    },
  };
}

function styleState(snapshots) {
  const recentIndustries = new Set(snapshots.slice(-5).flatMap((snapshot) => [...snapshot.holdings.values()].map((item) => item.industry).filter(Boolean)));
  const olderIndustries = new Set(snapshots.slice(0, -5).flatMap((snapshot) => [...snapshot.holdings.values()].map((item) => item.industry).filter(Boolean)));
  const intersection = [...recentIndustries].filter((industry) => olderIndustries.has(industry)).length;
  const union = new Set([...recentIndustries, ...olderIndustries]).size;
  const styleShift = union ? 1 - intersection / union : 0;
  return { recentIndustries, olderIndustries, styleShift: clamp(styleShift) };
}

function historyScores(snapshots) {
  const allCodes = new Set(snapshots.flatMap((snapshot) => [...snapshot.holdings.keys()]));
  const current = snapshots.at(-1)?.holdings || new Map();
  const state = styleState(snapshots);
  const totalRecent3 = snapshots.reduce((sum, _, index) => sum + 2 ** (-(snapshots.length - 1 - index) / 3), 0);
  const totalRecent10 = snapshots.reduce((sum, _, index) => sum + 2 ** (-(snapshots.length - 1 - index) / 10), 0);
  const longWeight = 0.06 * (1 - 0.7 * state.styleShift);
  const recentWeight = 0.42 + (0.06 - longWeight);
  const scores = new Map();
  for (const code of allCodes) {
    let recent3 = 0;
    let recent10 = 0;
    let occurrences = 0;
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.holdings.has(code)) return;
      const age = snapshots.length - 1 - index;
      recent3 += 2 ** (-age / 3);
      recent10 += 2 ** (-age / 10);
      occurrences += 1;
    });
    const recent = totalRecent3 ? recent3 / totalRecent3 : 0;
    const medium = totalRecent10 ? recent10 / totalRecent10 : 0;
    const lifetime = snapshots.length ? occurrences / snapshots.length : 0;
    const isCurrent = current.has(code);
    const score = 0.4 * Number(isCurrent) + recentWeight * recent + 0.12 * medium + longWeight * lifetime;
    scores.set(code, { score: clamp(score), recent, medium, lifetime, occurrences, isCurrent });
  }
  return { scores, current, styleShift: state.styleShift };
}

function industryPreference(snapshots) {
  const values = new Map();
  let denominator = 0;
  snapshots.forEach((snapshot, index) => {
    const weight = 2 ** (-(snapshots.length - 1 - index) / 4);
    const industries = new Set([...snapshot.holdings.values()].map((item) => item.industry).filter(Boolean));
    denominator += weight;
    for (const industry of industries) values.set(industry, (values.get(industry) || 0) + weight);
  });
  if (denominator) for (const [industry, value] of values) values.set(industry, value / denominator);
  return values;
}

function factorSiteScore(row, context) {
  const aia = weightedMean([
    [value100(row?.aia_sector_heat), 1], [value100(row?.aia_stock_heat), 1],
    [value100(row?.aia_leadership), 1], [value100(row?.aia_technical_pattern), 1],
  ]);
  const abcdValues = [row?.abcd_a_score, row?.abcd_b_score, row?.abcd_c_score, row?.abcd_d_score]
    .map(value100).filter(Number.isFinite);
  const abcd = abcdValues.length ? abcdValues.reduce((sum, value) => sum + value, 0) / abcdValues.length : null;
  const formal = Number.isFinite(Number(row?.formal_model_rank_pct)) ? 1 - clamp(Number(row.formal_model_rank_pct) / 100) : value100(row?.formal_model_score);
  const candidate = Number.isFinite(Number(row?.candidate_model_rank_pct)) ? 1 - clamp(Number(row.candidate_model_rank_pct) / 100) : value100(row?.candidate_model_score);
  const momentum = weightedMean([
    [sigmoid((Number(row?.pct_chg) || 0) / 3), 0.25],
    [sigmoid((Number(row?.ret_5d) || 0) * 12), 0.25],
    [sigmoid((Number(row?.ret_20d) || 0) * 7), 0.2],
    [sigmoid(((Number(row?.volume_ratio_20) || 1) - 1) / 2), 0.15],
    [sigmoid(((Number(row?.turnover_rate) || 0) - 3) / 5), 0.15],
  ]);
  const chip = context.chip.get(row?.code);
  const chipScore = chip ? weightedMean([
    [Number.isFinite(Number(chip.formal_rank_pct)) ? 1 - clamp(Number(chip.formal_rank_pct) / 100) : value100(chip.formal_score), 1],
    [Number.isFinite(Number(chip.candidate_rank_pct)) ? 1 - clamp(Number(chip.candidate_rank_pct) / 100) : value100(chip.candidate_score), 1],
  ]) : null;
  const recommendation = context.recommendations.get(row?.code) ?? null;
  const fivePlatform = context.fivePlatform.get(row?.code) ?? null;
  const taoguba = context.taoguba.get(row?.code) ?? null;
  const news = context.news.get(row?.code) ?? null;
  return {
    score: clamp(weightedMean([
      [formal, 0.1], [candidate, 0.1], [aia, 0.12], [abcd, 0.12],
      [value100(row?.five_platform_heat), 0.06], [value100(row?.four_agent_score), 0.07],
      [value100(row?.taoguba_sentiment), 0.05], [value100(row?.daily_breakout_score), 0.05],
      [momentum, 0.08], [chipScore, 0.09], [recommendation, 0.08],
      [fivePlatform, 0.04], [taoguba, 0.02], [news, 0.02],
    ])),
    components: { formal, candidate, aia, abcd, momentum, chip: chipScore, recommendation, fivePlatform, taoguba, news },
  };
}

function loadContext(db, asOf, cutoffAt = isoNow()) {
  const dayEnd = new Date(`${asOf}T23:59:59+08:00`).toISOString();
  const effectiveCutoff = cutoffAt < dayEnd ? cutoffAt : dayEnd;
  const factorDate = db.prepare("SELECT MAX(trade_date) AS date FROM factor_snapshot WHERE trade_date<=? AND datetime(updated_at)<=datetime(?)").get(asOf, effectiveCutoff)?.date || null;
  const factorRows = factorDate ? db.prepare("SELECT * FROM factor_snapshot WHERE trade_date=? AND datetime(updated_at)<=datetime(?)").all(factorDate, effectiveCutoff) : [];
  const factors = new Map(factorRows.map((row) => [row.code, row]));
  const chipDate = db.prepare("SELECT MAX(trade_date) AS date FROM chip_model_rank_daily WHERE trade_date<=? AND datetime(updated_at)<=datetime(?)").get(asOf, effectiveCutoff)?.date || null;
  const chipRows = chipDate ? db.prepare("SELECT * FROM chip_model_rank_daily WHERE trade_date=? AND datetime(updated_at)<=datetime(?)").all(chipDate, effectiveCutoff) : [];
  const chip = new Map(chipRows.map((row) => [row.code, row]));

  const recommendations = new Map();
  const batches = db.prepare(`SELECT * FROM recommendation_batches
    WHERE trade_date<=? AND datetime(finished_at)<=datetime(?) AND status IN ('published','superseded') AND item_count>0
    ORDER BY trade_date DESC, CASE status WHEN 'published' THEN 0 ELSE 1 END, finished_at DESC`).all(asOf, effectiveCutoff);
  const selectedBatches = [];
  const seenModels = new Set();
  for (const batch of batches) {
    if (seenModels.has(batch.model_key)) continue;
    seenModels.add(batch.model_key);
    selectedBatches.push(batch);
    const items = db.prepare("SELECT code,rank,score FROM recommendations WHERE batch_id=? ORDER BY rank").all(batch.batch_id);
    const maximum = Math.max(1, ...items.map((item) => Number(item.rank) || 1));
    for (const item of items) recommendations.set(item.code, Math.max(recommendations.get(item.code) || 0, 1 - ((Number(item.rank) || 1) - 1) / maximum));
  }

  const fiveSnapshot = db.prepare("SELECT * FROM five_platform_snapshots WHERE trade_date<=? AND datetime(generated_at)<=datetime(?) ORDER BY trade_date DESC,generated_at DESC LIMIT 1").get(asOf, effectiveCutoff) || null;
  const fivePlatform = new Map();
  if (fiveSnapshot) {
    const items = db.prepare("SELECT code,rank,score,platform_count FROM five_platform_combined WHERE snapshot_id=?").all(fiveSnapshot.snapshot_id);
    const maximum = Math.max(1, ...items.map((item) => Number(item.rank) || 1));
    for (const item of items) fivePlatform.set(item.code, clamp(0.7 * (1 - ((Number(item.rank) || 1) - 1) / maximum) + 0.3 * Math.min(1, (Number(item.platform_count) || 0) / 3)));
  }

  const taogubaCounts = new Map();
  const tgbRows = db.prepare(`SELECT e.stock_mentions_json,p.post_hot_score FROM taoguba_post_enrichment e
    JOIN taoguba_posts p ON p.post_id=e.post_id WHERE substr(p.post_publish_time,1,10)<=? AND datetime(p.imported_at)<=datetime(?) AND datetime(e.updated_at)<=datetime(?)`).all(asOf, effectiveCutoff, effectiveCutoff);
  for (const row of tgbRows) {
    for (const mention of parseJson(row.stock_mentions_json, []) || []) {
      const code = String(mention.code || "");
      if (code) taogubaCounts.set(code, (taogubaCounts.get(code) || 0) + Math.max(0.1, Number(row.post_hot_score) || 0.1));
    }
  }
  const maxTgb = Math.max(1, ...taogubaCounts.values());
  const taoguba = new Map([...taogubaCounts].map(([code, value]) => [code, clamp(value / maxTgb)]));

  const newsCounts = new Map();
  const newsRows = db.prepare("SELECT related_codes,relevance,sentiment FROM news_evidence WHERE substr(published_at,1,10)<=? AND datetime(imported_at)<=datetime(?)").all(asOf, effectiveCutoff);
  for (const row of newsRows) {
    const parsed = parseJson(row.related_codes, null);
    const codes = Array.isArray(parsed) ? parsed : String(row.related_codes || "").match(/\d{6}(?:\.(?:SH|SZ|BJ))?/g) || [];
    for (const rawCode of codes) {
      const code = String(rawCode).includes(".") ? String(rawCode) : null;
      if (!code) continue;
      newsCounts.set(code, (newsCounts.get(code) || 0) + clamp(Number(row.relevance) || 0.5) * (0.75 + 0.25 * clamp((Number(row.sentiment) || 0) + 0.5)));
    }
  }
  const maxNews = Math.max(1, ...newsCounts.values());
  const news = new Map([...newsCounts].map(([code, value]) => [code, clamp(value / maxNews)]));

  return {
    factorDate, factors, factorRows, chipDate, chip, chipRows, recommendations, selectedBatches,
    fiveSnapshot, fivePlatform, taoguba, news,
    manifest: {
      factorDate, factorRows: factorRows.length, chipDate, chipRows: chipRows.length,
      recommendationBatches: selectedBatches.map((batch) => ({ batchId: batch.batch_id, model: batch.model_key, date: batch.trade_date, status: batch.status })),
      fivePlatformSnapshot: fiveSnapshot ? { id: fiveSnapshot.snapshot_id, date: fiveSnapshot.trade_date, generatedAt: fiveSnapshot.generated_at } : null,
      taogubaMentionedStocks: taoguba.size, newsRelatedStocks: news.size,
      cutoffAt: effectiveCutoff,
      cutoffRule: `business dates <= ${asOf} AND database visibility timestamps <= ${effectiveCutoff}`,
      inputHashes: {
        factors: sha256(json(factorRows)), chips: sha256(json(chipRows)),
        recommendations: sha256(json(selectedBatches.map((batch) => batch.batch_id))),
        fivePlatform: sha256(json(fiveSnapshot?.snapshot_id || null)), taoguba: sha256(json([...taoguba])), news: sha256(json([...news])),
      },
    },
  };
}

function calibration(snapshots) {
  const priors = [0.42, 0.3, 0.23, 0.18, 0.14];
  const hits = [0, 0, 0, 0, 0];
  let transitions = 0;
  for (let index = 9; index < snapshots.length - 1; index += 1) {
    const train = snapshots.slice(0, index + 1);
    const actual = snapshots[index + 1].holdings;
    const ranked = [...historyScores(train).scores.entries()].sort((left, right) => right[1].score - left[1].score).slice(0, 5);
    ranked.forEach(([code], rank) => { if (actual.has(code)) hits[rank] += 1; });
    transitions += 1;
  }
  const probabilities = priors.map((prior, rank) => (hits[rank] + 8 * prior) / (transitions + 8));
  return { transitions, hits, probabilities: probabilities.map((value) => round(value)) };
}

function reasonList(candidate) {
  const reasons = [];
  if (candidate.history?.isCurrent) reasons.push("最近披露仍在持仓");
  if ((candidate.history?.recent || 0) >= 0.35) reasons.push("近5个披露日重复出现");
  if (candidate.industryPreference >= 0.35 && candidate.security.industry) reasons.push(`近期偏好${candidate.security.industry}`);
  const c = candidate.site.components;
  if ((c.aia || 0) >= 0.65) reasons.push("AIA因子较强");
  if ((c.abcd || 0) >= 0.65) reasons.push("ABCD因子较强");
  if ((c.recommendation || 0) >= 0.5) reasons.push("进入网站推荐候选");
  if ((c.fivePlatform || 0) >= 0.5) reasons.push("五平台热度靠前");
  if ((c.taoguba || 0) >= 0.5) reasons.push("淘股吧讨论度较高");
  if ((c.chip || 0) >= 0.65) reasons.push("双筹码模型分靠前");
  if ((c.momentum || 0) >= 0.65) reasons.push("量价动量较强");
  return reasons.slice(0, 4);
}

function buildExpertPrediction(config, profile, auxiliaryProfiles, asOf, maps, context) {
  const snapshots = snapshotSets(profile, asOf, maps);
  if (snapshots.length < 20) throw new Error(`${config.name} 有效持仓日不足20天`);
  const history = historyScores(snapshots);
  const industry = industryPreference(snapshots);
  const auxiliary = new Map();
  for (const auxiliaryProfile of auxiliaryProfiles) {
    const auxiliarySnapshots = snapshotSets(auxiliaryProfile, asOf, maps);
    for (const [code, item] of historyScores(auxiliarySnapshots).scores) auxiliary.set(code, Math.max(auxiliary.get(code) || 0, item.score));
  }
  const allItems = snapshots.flatMap((snapshot) => [...snapshot.holdings.values()]);
  const allRawItems = (profile.history || []).filter((snapshot) => snapshot.date <= asOf).flatMap((snapshot) => snapshot.holdings || []);
  const uniqueCodes = new Set(allItems.map((item) => item.code));
  const calibrationResult = calibration(snapshots);
  const latestHoldingDate = snapshots.at(-1).date;
  const stalenessDays = Math.max(0, Math.round((new Date(`${asOf}T12:00:00Z`) - new Date(`${latestHoldingDate}T12:00:00Z`)) / 86_400_000));

  const candidates = [];
  const universe = new Map(context.factorRows.map((row) => [row.code, maps.byCode.get(cleanCode(row.code)) || { code: row.code, symbol: cleanCode(row.code), name: row.name, industry: row.industry, market: "" }]));
  for (const item of allItems) universe.set(item.code, item);
  for (const code of context.recommendations.keys()) if (maps.byCode.has(cleanCode(code))) universe.set(code, maps.byCode.get(cleanCode(code)));
  for (const code of context.fivePlatform.keys()) if (maps.byCode.has(cleanCode(code))) universe.set(code, maps.byCode.get(cleanCode(code)));

  for (const security of universe.values()) {
    if (!security?.code || !security?.name) continue;
    const primary = history.scores.get(security.code) || { score: 0, recent: 0, medium: 0, lifetime: 0, occurrences: 0, isCurrent: false };
    const auxiliaryScore = auxiliary.get(security.code) || 0;
    const historyComponent = clamp(0.92 * primary.score + 0.08 * auxiliaryScore);
    const industryScore = clamp(industry.get(security.industry) || 0);
    const factor = context.factors.get(security.code) || { code: security.code };
    const site = factorSiteScore(factor, context);
    const newStockPenalty = primary.occurrences || primary.isCurrent ? 0 : 0.11;
    const total = clamp(0.57 * historyComponent + 0.13 * industryScore + 0.3 * site.score - newStockPenalty);
    candidates.push({ security, history: primary, auxiliaryScore, historyComponent, industryPreference: industryScore, site, total });
  }

  const ranked = candidates.sort((left, right) => right.total - left.total || right.historyComponent - left.historyComponent).slice(0, 5);
  const predictions = ranked.map((candidate, index) => {
    const prior = calibrationResult.probabilities[index] ?? 0.12;
    const isHistorical = candidate.history.occurrences > 0 || candidate.history.isCurrent;
    let probability = isHistorical
      ? prior + 0.08 * (candidate.site.score - 0.5) + 0.035 * Number(candidate.history.isCurrent)
      : 0.03 + 0.13 * candidate.site.score + 0.05 * candidate.industryPreference;
    probability *= Math.max(0.82, 1 - stalenessDays * 0.06);
    return {
      rank: index + 1,
      stockCode: candidate.security.code,
      stockName: candidate.security.name,
      probability: round(clamp(probability, 0.025, 0.92), 4),
      score: round(candidate.total),
      currentHolding: candidate.history.isCurrent,
      historyComponent: round(candidate.historyComponent),
      recentStyleComponent: round(candidate.history.recent || candidate.auxiliaryScore),
      siteComponent: round(candidate.site.score),
      reasons: reasonList(candidate),
      components: candidate.site.components,
    };
  });
  for (let index = 1; index < predictions.length; index += 1) {
    predictions[index].probability = round(Math.min(predictions[index].probability, Math.max(0.025, predictions[index - 1].probability - 0.005)), 4);
  }

  return {
    expertKey: `${config.source}:${profile.personId}`,
    expertName: config.name,
    source: config.source,
    latestHoldingDate,
    historyDays: snapshots.length,
    transitionCount: Math.max(0, snapshots.length - 1),
    uniqueStockCount: uniqueCodes.size,
    mappingPct: allRawItems.length ? round(100 * allItems.length / allRawItems.length, 2) : 0,
    styleShift: round(history.styleShift),
    baselineHoldings: [...history.current.keys()],
    calibration: calibrationResult,
    predictions,
  };
}

function predictionPayload(shadowDb, runId) {
  const run = shadowDb.prepare("SELECT * FROM shadow_runs WHERE run_id=?").get(runId);
  const experts = shadowDb.prepare("SELECT * FROM shadow_experts WHERE run_id=? ORDER BY expert_name").all(runId).map((expert) => ({
    expertName: expert.expert_name, source: expert.source, latestHoldingDate: expert.latest_holding_date,
    historyDays: expert.history_days, transitionCount: expert.transition_count, mappingPct: expert.mapping_pct,
    styleShift: expert.style_shift, calibration: parseJson(expert.calibration_json, {}),
    predictions: shadowDb.prepare("SELECT rank,stock_code AS stockCode,stock_name AS stockName,probability,score,current_holding AS currentHolding,history_component AS historyComponent,recent_style_component AS recentStyleComponent,site_component AS siteComponent,reasons_json AS reasons FROM shadow_predictions WHERE run_id=? AND expert_key=? ORDER BY rank").all(runId, expert.expert_key)
      .map((row) => ({ ...row, currentHolding: Boolean(row.currentHolding), reasons: parseJson(row.reasons, {})?.reasons || [] })),
  }));
  return {
    experiment: "高手次日持仓两日暗测", runId, modelVersion: run.model_version, status: run.status,
    asOfDate: run.as_of_date, targetDate: run.target_date, frozenAt: run.frozen_at,
    featureManifest: parseJson(run.feature_manifest_json, {}), experts,
    note: run.note,
  };
}

async function exportRun(shadowDb, runId, outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const payload = predictionPayload(shadowDb, runId);
  const safeVersion = payload.modelVersion.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const file = path.join(outputDir, `predictions_${payload.targetDate}_${safeVersion}_${runId.slice(-8)}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file).catch(async () => { await fsp.rm(file, { force: true }); await fsp.rename(temporary, file); });
  await fsp.writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

async function createPrediction({ profilesText, profilesData, marketDb, shadowDb, asOf, target, outputDir, maps, lifecycle, requireCurrentFeatures = false }) {
  const existing = shadowDb.prepare("SELECT * FROM shadow_runs WHERE as_of_date=? AND target_date=? AND model_version=?").get(asOf, target, MODEL_VERSION);
  if (existing) {
    if (requireCurrentFeatures && (existing.market_feature_date !== asOf || existing.chip_feature_date !== asOf)) throw new Error(`已有冻结批次未通过当日特征门禁：量价${existing.market_feature_date || "缺失"}、筹码${existing.chip_feature_date || "缺失"}，要求${asOf}`);
    const counts = shadowDb.prepare("SELECT COUNT(DISTINCT expert_key) AS experts,COUNT(*) AS predictions FROM shadow_predictions WHERE run_id=?").get(existing.run_id);
    return { runId: existing.run_id, created: false, expertCount: counts.experts, predictionCount: counts.predictions, output: await exportRun(shadowDb, existing.run_id, outputDir) };
  }
  const context = loadContext(marketDb, asOf);
  if (requireCurrentFeatures && (context.factorDate !== asOf || context.chipDate !== asOf)) throw new Error(`正式预测门禁未通过：量价${context.factorDate || "缺失"}、筹码${context.chipDate || "缺失"}，要求${asOf}`);
  context.manifest.participantLifecycle = { activeCount: lifecycle.active.length, statuses: Object.fromEntries(["active", "probation", "watch", "paused", "retired"].map((status) => [status, lifecycle.tracked.filter((item) => item.status === status).length])), policy: lifecycle.policy, thresholds: lifecycle.thresholds };
  context.manifest.aiPolicy = { predictionProvider: "none", allowedOptionalProvider: "deepseek-chat", rule: "持仓事实、评分和状态机均为确定性代码；若未来增加自然语言解释，仅允许DeepSeek且不得覆盖事实。" };
  const results = [];
  for (const participant of lifecycle.active) {
    const profile = (profilesData.profiles || []).find((item) => `${item.source}:${item.personId}` === participant.participantKey);
    if (!profile) throw new Error(`找不到正式预测选手：${participant.source}/${participant.expertName}`);
    const seed = SEED_EXPERTS.find((item) => item.name === participant.expertName && item.source === participant.source);
    const config = { name: participant.expertName, source: participant.source, auxiliarySources: seed?.auxiliarySources || [] };
    const auxiliaryProfiles = (profilesData.profiles || []).filter((item) => item.personName === config.name && (config.auxiliarySources || []).includes(item.source));
    results.push(buildExpertPrediction(config, profile, auxiliaryProfiles, asOf, maps, context));
  }
  if (!results.length || results.some((result) => result.predictions.length !== 5)) throw new Error("正式预测名单为空或有选手未生成恰好5只候选，拒绝冻结实验");
  const runId = `${MODEL_VERSION}-${asOf}-${target}-${sha256(profilesText).slice(0, 8)}`;
  const createdAt = isoNow();
  const shanghaiCreatedDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(createdAt));
  const scoreEligible = Number(shanghaiCreatedDate < target);
  const scoreEligibilityReason = scoreEligible ? "目标交易日前冻结，计入正式盲测" : "目标交易日开始后冻结，仅作试运行，不计入正式盲测";
  shadowDb.exec("BEGIN IMMEDIATE");
  try {
    shadowDb.prepare(`INSERT INTO shadow_runs(run_id,as_of_date,target_date,created_at,frozen_at,model_version,status,profile_hash,market_feature_date,chip_feature_date,feature_manifest_json,note,score_eligible,score_eligibility_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, asOf, target, createdAt, createdAt, MODEL_VERSION, "frozen", sha256(profilesText), context.factorDate, context.chipDate, json(context.manifest), "持续预测实验；概率为单只股票出现在目标日持仓中的独立概率，仅供模型验证，不构成投资建议。", scoreEligible, scoreEligibilityReason);
    const insertExpert = shadowDb.prepare(`INSERT INTO shadow_experts(run_id,expert_key,expert_name,source,latest_holding_date,history_days,transition_count,unique_stock_count,mapping_pct,style_shift,baseline_holdings_json,calibration_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertPrediction = shadowDb.prepare(`INSERT INTO shadow_predictions(run_id,expert_key,expert_name,source,rank,stock_code,stock_name,probability,score,current_holding,history_component,recent_style_component,site_component,reasons_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const result of results) {
      insertExpert.run(runId, result.expertKey, result.expertName, result.source, result.latestHoldingDate, result.historyDays, result.transitionCount, result.uniqueStockCount, result.mappingPct, result.styleShift, json(result.baselineHoldings), json(result.calibration));
      for (const prediction of result.predictions) insertPrediction.run(runId, result.expertKey, result.expertName, result.source, prediction.rank, prediction.stockCode, prediction.stockName, prediction.probability, prediction.score, Number(prediction.currentHolding), prediction.historyComponent, prediction.recentStyleComponent, prediction.siteComponent, json({ reasons: prediction.reasons, siteComponents: prediction.components }));
    }
    shadowDb.exec("COMMIT");
  } catch (error) {
    shadowDb.exec("ROLLBACK");
    throw error;
  }
  return { runId, created: true, expertCount: results.length, predictionCount: results.length * 5, scoreEligible: Boolean(scoreEligible), scoreEligibilityReason, output: await exportRun(shadowDb, runId, outputDir) };
}

function evaluateRun({ run, profilesData, marketDb, shadowDb }) {
  const maps = securityMaps(marketDb, profilesData.profiles || [], run.target_date);
  const experts = shadowDb.prepare("SELECT * FROM shadow_experts WHERE run_id=?").all(run.run_id);
  let available = 0;
  for (const expert of experts) {
    const profile = (profilesData.profiles || []).find((item) => item.personName === expert.expert_name && item.source === expert.source);
    const snapshot = (profile?.history || []).find((item) => item.date === run.target_date);
    const rawHoldings = snapshot?.holdings || [];
    const hasPositionField = snapshot && snapshot.positionPct !== null && snapshot.positionPct !== undefined && snapshot.positionPct !== "";
    const hasInvestedField = snapshot && snapshot.investedAmountWan !== null && snapshot.investedAmountWan !== undefined && snapshot.investedAmountWan !== "";
    const explicitEmpty = snapshot && !rawHoldings.length && (hasPositionField || hasInvestedField) && (Number(snapshot.positionPct) || 0) <= 5 && (Number(snapshot.investedAmountWan) || 0) <= 0;
    const structurallyMissing = !snapshot || (!rawHoldings.length && !explicitEmpty);
    if (structurallyMissing) {
      shadowDb.prepare(`INSERT INTO shadow_evaluations(run_id,expert_key,evaluated_at,actual_available,detail_json)
        VALUES(?,?,?,?,?) ON CONFLICT(run_id,expert_key) DO UPDATE SET evaluated_at=excluded.evaluated_at,actual_available=0,detail_json=excluded.detail_json`)
        .run(run.run_id, expert.expert_key, isoNow(), 0, json({ reason: snapshot ? "目标日持仓字段不完整" : "目标日尚无披露快照" }));
      continue;
    }
    available += 1;
    const actual = new Map();
    for (const holding of rawHoldings) {
      const security = resolveStock(holding, maps);
      if (security) actual.set(security.code, { ...security, amountWan: Number(holding.amountWan) || 0 });
    }
    const actualMappingPct = rawHoldings.length ? 100 * actual.size / rawHoldings.length : 100;
    if (rawHoldings.length && actualMappingPct < 80) {
      shadowDb.prepare(`INSERT INTO shadow_evaluations(run_id,expert_key,evaluated_at,actual_available,detail_json)
        VALUES(?,?,?,?,?) ON CONFLICT(run_id,expert_key) DO UPDATE SET evaluated_at=excluded.evaluated_at,actual_available=0,detail_json=excluded.detail_json`)
        .run(run.run_id, expert.expert_key, isoNow(), 0, json({ reason: "目标日持仓股票映射率低于80%，拒绝计分", rawHoldingCount: rawHoldings.length, mappedHoldingCount: actual.size, mappingPct: round(actualMappingPct, 2) }));
      continue;
    }
    const baseline = new Set(parseJson(expert.baseline_holdings_json, []));
    const predictions = shadowDb.prepare("SELECT * FROM shadow_predictions WHERE run_id=? AND expert_key=? ORDER BY rank").all(run.run_id, expert.expert_key);
    const actualCodes = new Set(actual.keys());
    const hitRows = predictions.filter((prediction) => actualCodes.has(prediction.stock_code));
    const retainedHits = hitRows.filter((prediction) => baseline.has(prediction.stock_code)).length;
    const newBuyHits = hitRows.filter((prediction) => !baseline.has(prediction.stock_code)).length;
    const brier = predictions.reduce((sum, prediction) => sum + (Number(prediction.probability) - Number(actualCodes.has(prediction.stock_code))) ** 2, 0) / Math.max(1, predictions.length);
    shadowDb.prepare("DELETE FROM shadow_actuals WHERE run_id=? AND expert_key=?").run(run.run_id, expert.expert_key);
    const insertActual = shadowDb.prepare("INSERT INTO shadow_actuals(run_id,expert_key,target_date,stock_code,stock_name,amount_wan,observed_at) VALUES(?,?,?,?,?,?,?)");
    for (const holding of actual.values()) insertActual.run(run.run_id, expert.expert_key, run.target_date, holding.code, holding.name, holding.amountWan, isoNow());
    shadowDb.prepare(`INSERT INTO shadow_evaluations(run_id,expert_key,evaluated_at,actual_available,actual_count,hit_count,retained_hit_count,new_buy_hit_count,precision_at_5,actual_recall,brier_score,detail_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,expert_key) DO UPDATE SET evaluated_at=excluded.evaluated_at,actual_available=excluded.actual_available,actual_count=excluded.actual_count,hit_count=excluded.hit_count,retained_hit_count=excluded.retained_hit_count,new_buy_hit_count=excluded.new_buy_hit_count,precision_at_5=excluded.precision_at_5,actual_recall=excluded.actual_recall,brier_score=excluded.brier_score,detail_json=excluded.detail_json`)
      .run(run.run_id, expert.expert_key, isoNow(), 1, actual.size, hitRows.length, retainedHits, newBuyHits, hitRows.length / 5, actual.size ? hitRows.length / actual.size : null, brier, json({ hits: hitRows.map((row) => ({ rank: row.rank, code: row.stock_code, name: row.stock_name })), actualCodes: [...actualCodes], rawHoldingCount: rawHoldings.length, mappedHoldingCount: actual.size, mappingPct: round(actualMappingPct, 2), profileHash: sha256(json(snapshot)) }));
  }
  shadowDb.prepare("UPDATE shadow_runs SET status=? WHERE run_id=?").run(available === experts.length ? "evaluated" : available ? "partially_evaluated" : "frozen", run.run_id);
  return { runId: run.run_id, targetDate: run.target_date, available, total: experts.length };
}

async function main() {
  const profilesPath = path.resolve(option("--profiles", DEFAULT_PROFILES));
  const marketDbPath = path.resolve(option("--market-db", DEFAULT_ASTER_DB));
  const shadowDbPath = path.resolve(option("--db", DEFAULT_SHADOW_DB));
  const outputDir = path.resolve(option("--out", DEFAULT_OUTPUT));
  const profilesText = fs.readFileSync(profilesPath, "utf8");
  const profilesData = JSON.parse(profilesText);
  const asOf = option("--as-of", profilesData.date || profilesData.businessDate || (profilesData.profiles || []).flatMap((profile) => profile.history || []).map((snapshot) => snapshot.date).sort().at(-1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || "")) throw new Error("缺少有效 --as-of YYYY-MM-DD");
  const target = option("--target", nextWeekday(asOf));
  await fsp.mkdir(path.dirname(shadowDbPath), { recursive: true });
  const marketDb = new DatabaseSync(marketDbPath, { readOnly: true });
  const shadowDb = new DatabaseSync(shadowDbPath);
  schema(shadowDb);
  const maps = securityMaps(marketDb, profilesData.profiles || [], asOf);
  const lifecycle = updateParticipantLifecycle(shadowDb, profilesData.profiles || [], asOf, maps);
  const summary = {
    modelVersion: MODEL_VERSION, asOf, target, evaluations: [], prediction: null,
    lifecycle: { active: lifecycle.active.length, tracked: lifecycle.tracked.length, statuses: Object.fromEntries(["active", "probation", "watch", "paused", "retired"].map((status) => [status, lifecycle.tracked.filter((item) => item.status === status).length])), policy: lifecycle.policy },
  };
  if (!hasFlag("--predict-only")) {
    const runs = shadowDb.prepare("SELECT * FROM shadow_runs WHERE target_date<=? AND status IN ('frozen','partially_evaluated') ORDER BY target_date").all(asOf);
    for (const run of runs) summary.evaluations.push(evaluateRun({ run, profilesData, marketDb, shadowDb }));
  }
  if (!hasFlag("--evaluate-only") && !hasFlag("--lifecycle-only")) summary.prediction = await createPrediction({ profilesText, profilesData, marketDb, shadowDb, asOf, target, outputDir, maps, lifecycle, requireCurrentFeatures: hasFlag("--require-current-features") });
  shadowDb.exec("PRAGMA optimize");
  marketDb.close();
  shadowDb.close();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
