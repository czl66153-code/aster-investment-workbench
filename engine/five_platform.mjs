import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./core.mjs";

const PLATFORM_ORDER = ["xueqiu", "eastmoney", "tonghuashun", "taoguba", "kaipanla"];
const PLATFORM_NAMES = {
  xueqiu: "雪球热股榜", eastmoney: "东方财富个股人气榜", tonghuashun: "同花顺热股榜",
  taoguba: "淘股吧24小时搜索热度", kaipanla: "开盘啦股票热度榜",
};

function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function asArray(value) { return Array.isArray(value) ? value : []; }
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

function canonicalCode(raw) {
  const matched = String(raw || "").toUpperCase().match(/(\d{6})/);
  if (!matched) return "";
  const symbol = matched[1];
  return `${symbol}.${symbol.startsWith("6") || symbol.startsWith("5") || symbol.startsWith("9") ? "SH" : symbol.startsWith("4") || symbol.startsWith("8") ? "BJ" : "SZ"}`;
}

function normalizedName(raw) {
  return String(raw || "").toUpperCase().replace(/\s+/g, "").replace(/[-－]?W$/, "");
}

function snapshotId(payload) {
  const stable = JSON.stringify([payload.date, payload.generated_at, asArray(payload.platforms).map((source) => [source.key, source.ok, source.source_date, asArray(source.items).map((item) => [item.rank, item.name, item.code])])]);
  return `five-${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

export function saveFivePlatformSnapshot(db, payload, sourcePath = "collector") {
  if (!payload || !payload.date || !asArray(payload.platforms).length) throw new Error("五平台任务没有返回有效榜单结构");
  const id = snapshotId(payload); const generatedAt = String(payload.generated_at || new Date().toISOString());
  const platforms = PLATFORM_ORDER.map((key) => asArray(payload.platforms).find((item) => item?.key === key) || { key, name: PLATFORM_NAMES[key], ok: false, items: [], error: "本次任务未返回该平台" });
  const weights = payload.weights || { xueqiu: .25, eastmoney: .25, tonghuashun: .20, taoguba: .15, kaipanla: .15 };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO five_platform_snapshots(snapshot_id,trade_date,generated_at,success_count,failed_count,weights_json,refresh_failed,source_path)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, String(payload.date), generatedAt, platforms.filter((row) => row.ok).length, platforms.filter((row) => !row.ok).length, JSON.stringify(weights), payload.refresh_failed ? 1 : 0, sourcePath);
    const sourceInsert = db.prepare(`INSERT OR REPLACE INTO five_platform_sources(snapshot_id,platform_key,platform_name,ok,source_date,stale_date,stale_used,error,item_count)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const itemInsert = db.prepare("INSERT OR REPLACE INTO five_platform_items(snapshot_id,platform_key,rank,name,code,heat,change_value) VALUES(?,?,?,?,?,?,?)");
    for (const source of platforms) {
      const items = asArray(source.items).slice(0, 10);
      const sourceDate = String(source.source_date || "").slice(0, 10);
      const snapshotDate = String(payload.date || "").slice(0, 10);
      const staleUsed = Boolean(source.stale_used || (source.ok && sourceDate && snapshotDate && sourceDate !== snapshotDate));
      sourceInsert.run(id, source.key, source.name || PLATFORM_NAMES[source.key] || source.key, source.ok ? 1 : 0, sourceDate, source.stale_date || (staleUsed ? sourceDate : ""), staleUsed ? 1 : 0, String(source.error || ""), items.length);
      items.forEach((item, index) => itemInsert.run(id, source.key, number(item.rank, index + 1), String(item.name || "未命名股票"), canonicalCode(item.code), String(item.heat ?? ""), String(item.change ?? "")));
    }
    const combinedInsert = db.prepare("INSERT OR REPLACE INTO five_platform_combined(snapshot_id,rank,name,code,score,platform_count,contributions_json) VALUES(?,?,?,?,?,?,?)");
    asArray(payload.combined).slice(0, 30).forEach((item, index) => combinedInsert.run(id, number(item.rank, index + 1), String(item.name || "未命名股票"), canonicalCode(item.code), number(item.score), number(item.platform_count), JSON.stringify(asArray(item.contributions))));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { snapshotId: id, tradeDate: String(payload.date), successCount: platforms.filter((row) => row.ok).length };
}

function cacheRoots() {
  const sourceRoot = process.env.ASTER_8002_DATA_ROOT || join(projectDir, "data", "source8002_data");
  const cacheRoot = process.env.ASTER_8002_CACHE_ROOT || join(projectDir, "data", "source8002_data_cache");
  return [join(sourceRoot, "hot_stock_rankings"), join(cacheRoot, "hot_stock_rankings")];
}

export function syncLatestFivePlatformCache(db) {
  const candidates = [];
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((value) => /^20\d{2}-\d{2}-\d{2}(?:\.success)?\.json$/.test(value))) candidates.push(join(root, name));
  }
  candidates.sort().reverse();
  for (const path of candidates) {
    const payload = json(readFileSync(path, "utf8"), null);
    if (!payload?.platforms?.length) continue;
    return saveFivePlatformSnapshot(db, payload, path);
  }
  return null;
}

function enrichCode(db, code, name) {
  if (code) return db.prepare("SELECT code,name,industry FROM securities WHERE code=?").get(code) || { code, name, industry: "" };
  return db.prepare("SELECT code,name,industry FROM securities WHERE name=? ORDER BY code LIMIT 1").get(name) || { code: "", name, industry: "" };
}

function latestPctChange(db, code) {
  if (!code) return null;
  const realtime = db.prepare("SELECT pct_chg FROM realtime_quotes WHERE code=? LIMIT 1").get(code);
  if (Number.isFinite(Number(realtime?.pct_chg))) return Number(realtime.pct_chg);
  const factor = db.prepare("SELECT pct_chg FROM factor_snapshot WHERE code=? ORDER BY trade_date DESC LIMIT 1").get(code);
  return Number.isFinite(Number(factor?.pct_chg)) ? Number(factor.pct_chg) : null;
}

export function fivePlatformDashboard(db, { syncCache = true } = {}) {
  if (syncCache) try { syncLatestFivePlatformCache(db); } catch {}
  const snapshot = db.prepare("SELECT * FROM five_platform_snapshots ORDER BY trade_date DESC,generated_at DESC LIMIT 1").get();
  if (!snapshot) return { ready: false, platforms: [], combined: [], history: [], message: "尚无五平台榜单，请先刷新" };
  const sources = db.prepare("SELECT * FROM five_platform_sources WHERE snapshot_id=?").all(snapshot.snapshot_id);
  const sourceMap = new Map(sources.map((row) => [row.platform_key, row]));
  const rawItems = db.prepare("SELECT * FROM five_platform_items WHERE snapshot_id=? ORDER BY platform_key,rank").all(snapshot.snapshot_id);
  const aliasToCode = new Map();
  for (const item of rawItems) {
    const security = enrichCode(db, item.code, item.name);
    if (security.code) aliasToCode.set(normalizedName(item.name), security.code);
  }
  const resolvedItems = rawItems.map((item) => {
    let security = enrichCode(db, item.code, item.name);
    if (!security.code) {
      const aliasCode = aliasToCode.get(normalizedName(item.name));
      if (aliasCode) security = enrichCode(db, aliasCode, item.name);
    }
    return { ...item, security, identity: security.code || `NAME:${normalizedName(item.name)}` };
  });
  const identityPlatforms = new Map();
  for (const item of resolvedItems) {
    const platforms = identityPlatforms.get(item.identity) || new Set();
    platforms.add(item.platform_key); identityPlatforms.set(item.identity, platforms);
  }
  const duplicateOrder = [...identityPlatforms.entries()].filter(([, keys]) => keys.size >= 2).sort((left, right) => right[1].size - left[1].size).map(([identity]) => identity);
  const highlightByIdentity = new Map(duplicateOrder.map((identity, index) => [identity, index % 7]));
  const platforms = PLATFORM_ORDER.map((key) => {
    const source = sourceMap.get(key) || { platform_key: key, platform_name: PLATFORM_NAMES[key], ok: 0, error: "无数据", item_count: 0 };
    const items = resolvedItems.filter((item) => item.platform_key === key).slice(0, 10).map((item) => ({
      ...item,
      consensus_count: identityPlatforms.get(item.identity)?.size || 1,
      highlight_index: highlightByIdentity.has(item.identity) ? highlightByIdentity.get(item.identity) : null,
    }));
    return { ...source, items };
  });
  const combined = db.prepare("SELECT * FROM five_platform_combined WHERE snapshot_id=? ORDER BY rank LIMIT 20").all(snapshot.snapshot_id).map((row) => {
    let security = enrichCode(db, row.code, row.name);
    if (!security.code) {
      const aliasCode = aliasToCode.get(normalizedName(row.name));
      if (aliasCode) security = enrichCode(db, aliasCode, row.name);
    }
    const identity = security.code || `NAME:${normalizedName(row.name)}`;
    return { ...row, contributions: json(row.contributions_json, []), security, identity, pct_chg: latestPctChange(db, security.code), highlight_index: highlightByIdentity.get(identity) ?? null };
  });
  const history = db.prepare("SELECT snapshot_id,trade_date,generated_at,success_count,failed_count,refresh_failed FROM five_platform_snapshots ORDER BY trade_date DESC,generated_at DESC LIMIT 20").all();
  return { ready: true, snapshot: { ...snapshot, weights: json(snapshot.weights_json, {}) }, platforms, combined, history, duplicateCount: duplicateOrder.length, methodology: "沿用8002原口径：雪球25%、东方财富25%、同花顺20%、淘股吧15%、开盘啦15%；单平台贡献=权重×(11-名次)×10。" };
}
