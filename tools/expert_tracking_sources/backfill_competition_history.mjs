#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve("outputs");
const ARCHIVE_ROOT = path.join(ROOT, "expert_tracking", "competition_history");
const FULI_BASE = "https://www.fuyinkeji.top";
const WANZHU_BASE = "https://api.hunanwanzhu.com";
const RECENT_MISSING_RETRY_DAYS = 5;

function parseArgs(argv) {
  const args = { date: shanghaiDate(), concurrency: 12 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--date") args.date = value, index += 1;
    else if (key === "--concurrency") args.concurrency = Number(value), index += 1;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 24) {
    throw new Error("--concurrency must be an integer from 1 to 24");
  }
  return args;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function jsonFiles(dir, pattern) {
  try {
    return (await fs.readdir(dir)).filter((name) => pattern.test(name)).sort().map((name) => path.join(dir, name));
  } catch { return []; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function apiJson(url, attempts = 2, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.code !== 200 && payload.code !== 0 && payload.errno !== 0) {
        throw new Error(payload.message || `API code ${payload.code}`);
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError;
}

function weekdays(startText, endText) {
  const rows = [];
  const current = new Date(`${startText}T12:00:00+08:00`);
  const end = new Date(`${endText}T12:00:00+08:00`);
  while (current <= end) {
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) rows.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return rows;
}

function amount(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function fuliSnapshot(order, roster, match) {
  const holdings = (order.holdStockVos || []).map((item) => ({
    stockCode: String(item.stockCode || item.stcokCode || item.code || "").match(/\d{6}/)?.[0] || "",
    stockName: String(item.stockName || "").trim(),
    amountWan: amount(item.holdPrice) === null ? null : amount(item.holdPrice) / 10_000,
    dailyPnlWan: amount(item.profitAndLossPrice) === null ? null : amount(item.profitAndLossPrice) / 10_000,
  })).filter((item) => item.stockName && !/转债|可转债/.test(item.stockName));
  const investedAmountWan = holdings.reduce((sum, item) => sum + (item.amountWan || 0), 0);
  return {
    source: "复利笔记",
    date: order.holdDate,
    match: match.name,
    group: roster.group,
    rank: null,
    personId: roster.openId,
    personName: order.gameName || roster.gameName,
    totalAssetsWan: amount(order.totalAssets) === null ? null : amount(order.totalAssets) / 10_000,
    investedAmountWan,
    positionPct: amount(order.stockPercent),
    dailyReturnPct: amount(order.todayEarningRate),
    totalReturnPct: amount(order.totalEarningRate),
    platformStyle: [],
    note: "",
    holdings,
    evidence: "比赛账户结构化披露（选手历史报单直取）",
  };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try { return JSON.parse(value); } catch { return []; }
}

function wanzhuDirectSnapshot(record, roster, match) {
  const holdings = parseArray(record.today_stock).map((item) => ({
    stockCode: String(item.code || "").match(/\d{6}/)?.[0] || "",
    stockName: String(item.name || "").trim(),
    amountWan: amount(item.fund),
    dailyPnlWan: amount(item.money),
  })).filter((item) => item.stockName && Number.isFinite(item.amountWan) && item.amountWan > 0 && !/转债|可转债/.test(item.stockName));
  return {
    source: "顽主杯",
    date: record.stock_date,
    match: record.match_name || match.name,
    group: roster.groupName || roster.groupId || "",
    rank: amount(record.group_rank),
    personId: String(record.user_id || roster.userId),
    personName: record.username || roster.personName,
    totalAssetsWan: amount(record.today_fund),
    investedAmountWan: amount(record.today_stock_total),
    positionPct: amount(record.today_cangwei),
    dailyReturnPct: amount(record.today_income),
    totalReturnPct: amount(record.total_income),
    platformStyle: [record.zq, record.cw, record.df, record.pz].filter(Boolean),
    note: record.experience || "",
    holdings,
    evidence: "比赛账户结构化披露（选手历史记录直取）",
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function backfillFuli(args) {
  const files = await jsonFiles(path.join(ROOT, "fuli"), /^fuli_\d{4}-\d{2}-\d{2}\.json$/);
  if (!files.length) return { roster: 0, requested: 0, snapshots: 0 };
  const sourceRows = await Promise.all(files.map(readJson));
  const latest = sourceRows.at(-1);
  const roster = new Map();
  for (const data of sourceRows) for (const player of data.players || []) {
    if (!player.openId) continue;
    roster.set(String(player.openId), {
      openId: String(player.openId), gameName: player.gameName || "", group: player.group || "", groupType: player.groupType || "",
    });
  }
  const match = {
    id: String(latest.match?.id || ""),
    name: latest.match?.name || "复利杯",
    startDate: latest.match?.startDate || sourceRows[0].date,
    endDate: [args.date, latest.match?.endDate || args.date].sort()[0],
  };
  const dates = weekdays(match.startDate, match.endDate);
  const recentRetryDates = new Set(dates.slice(-RECENT_MISSING_RETRY_DAYS));
  const archiveDir = path.join(ARCHIVE_ROOT, "fuli");
  await fs.mkdir(archiveDir, { recursive: true });
  const archives = new Map();
  const jobs = [];
  for (const player of roster.values()) {
    const archivePath = path.join(archiveDir, `${player.openId}.json`);
    let archive = { source: "复利笔记", ...player, match, checkedDates: [], snapshots: [] };
    try { archive = await readJson(archivePath); } catch {}
    archives.set(player.openId, { archivePath, archive, player });
    const checked = new Set(archive.checkedDates || []);
    const snapshotted = new Set((archive.snapshots || []).map((row) => row.date));
    for (const date of dates) {
      if (snapshotted.has(date)) continue;
      // A successful HTTP response without orderDetails only means the player
      // had not disclosed yet.  Retry recent gaps so a later disclosure is
      // caught by the recovery run instead of being permanently marked done.
      if (!checked.has(date) || recentRetryDates.has(date)) jobs.push({ player, date, retryMissing: checked.has(date) });
    }
  }
  let recoveredSnapshots = 0;
  await mapLimit(jobs, args.concurrency, async ({ player, date, retryMissing }) => {
    const url = new URL("/sys/umsExplodeOrder/getExplodeOrderDetail", FULI_BASE);
    url.searchParams.set("holdDate", date);
    url.searchParams.set("openId", player.openId);
    url.searchParams.set("gameSession", match.id);
    const slot = archives.get(player.openId);
    try {
      const data = await apiJson(url);
      const order = data?.orderDetails;
      if (order?.holdDate) {
        slot.archive.snapshots.push(fuliSnapshot(order, player, match));
        if (retryMissing) recoveredSnapshots += 1;
        if (slot.archive.pendingDates) delete slot.archive.pendingDates[date];
      } else {
        slot.archive.pendingDates ||= {};
        slot.archive.pendingDates[date] = { status: "not_disclosed_yet", lastAttemptAt: new Date().toISOString() };
      }
      slot.archive.checkedDates.push(date);
    } catch (error) {
      slot.archive.lastError = `${date}: ${error.message}`;
    }
  });
  let snapshotCount = 0;
  for (const { archivePath, archive, player } of archives.values()) {
    const unique = new Map((archive.snapshots || []).map((row) => [row.date, row]));
    archive.source = "复利笔记";
    archive.openId = player.openId;
    archive.gameName = player.gameName;
    archive.group = player.group;
    archive.groupType = player.groupType;
    archive.match = match;
    archive.updatedAt = new Date().toISOString();
    archive.checkedDates = [...new Set(archive.checkedDates || [])].sort();
    archive.snapshots = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
    const snapshotDates = new Set(archive.snapshots.map((row) => row.date));
    for (const date of Object.keys(archive.pendingDates || {})) if (snapshotDates.has(date)) delete archive.pendingDates[date];
    snapshotCount += archive.snapshots.length;
    await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  }
  const pendingRecent = [...archives.values()].reduce((sum, { archive }) => sum + Object.keys(archive.pendingDates || {}).filter((date) => recentRetryDates.has(date)).length, 0);
  return { roster: roster.size, requested: jobs.length, recoveredSnapshots, pendingRecent, snapshots: snapshotCount, dates: dates.length, recentRetryDays: RECENT_MISSING_RETRY_DAYS };
}

async function backfillWanzhu(args) {
  const data = await apiJson(`${WANZHU_BASE}/api/wx/v2/match/list`);
  const match = data.find((item) => Number(item.match_status) === 3) || data[0];
  if (!match) return { datesAvailable: 0, datesFetched: 0, roster: 0, requestedPlayers: 0, status: "no_match" };
  const validDates = Array.isArray(match.valid_dates)
    ? match.valid_dates
    : String(match.valid_dates || "").split(",").map((item) => item.trim()).filter(Boolean);
  const dates = validDates.filter((date) => date <= args.date);
  const existing = new Set((await jsonFiles(path.join(ROOT, "wanzhu"), /^wanzhu_\d{4}-\d{2}-\d{2}\.json$/))
    .map((file) => path.basename(file).slice(7, 17)));
  const missing = dates.filter((date) => !existing.has(date));
  const crawler = path.resolve("tools", "wanzhu_api_crawler", "crawl_wanzhu.mjs");
  await mapLimit(missing, 3, async (date) => {
    await execFileAsync(process.execPath, [crawler, "--date", date, "--match-id", String(match.id)], {
      cwd: process.cwd(), windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  });

  // The public rank endpoint only exposes the leading rows. Use every player
  // already discovered by the site as the durable roster, then fetch official
  // per-player history so a ranking change cannot make someone disappear.
  const sourceFiles = await jsonFiles(path.join(ROOT, "wanzhu"), /^wanzhu_\d{4}-\d{2}-\d{2}\.json$/);
  const roster = new Map();
  for (const file of sourceFiles) {
    const daily = await readJson(file);
    if (String(daily.match?.id || "") !== String(match.id)) continue;
    for (const group of daily.groups || []) for (const player of group.players || []) {
      const userId = String(player.user_id || "");
      if (!userId) continue;
      roster.set(userId, {
        userId,
        personName: player.username || "",
        groupId: String(group.id || player.match_group || ""),
        groupName: group.name || "",
      });
    }
  }

  const authorization = String(process.env.WANZHU_AUTHORIZATION || "").trim();
  if (!authorization) {
    return {
      datesAvailable: dates.length,
      datesFetched: missing.length,
      roster: roster.size,
      requestedPlayers: 0,
      status: "authorization_missing",
      note: "Set WANZHU_AUTHORIZATION in the service environment; rank snapshots remain available as fallback.",
    };
  }

  const archiveDir = path.join(ARCHIVE_ROOT, "wanzhu");
  await fs.mkdir(archiveDir, { recursive: true });
  const headers = {
    Authorization: authorization,
    "User-Agent": "wanzhubei/1.9.3 (Android; UnifiedResearchWorkbench read-only updater)",
  };
  const recentRetryDates = new Set(dates.slice(-RECENT_MISSING_RETRY_DAYS));
  let recoveredSnapshots = 0;
  let snapshotCount = 0;
  let failedPlayers = 0;
  let pendingRecent = 0;
  let latestSnapshotDate = null;
  const results = await mapLimit([...roster.values()], Math.min(args.concurrency, 12), async (player) => {
    const archivePath = path.join(archiveDir, `${player.userId}.json`);
    let archive = {
      source: "顽主杯", userId: player.userId, personName: player.personName,
      groupId: player.groupId, groupName: player.groupName, match: {}, snapshots: [], pendingDates: {},
    };
    try { archive = await readJson(archivePath); } catch {}
    const existingDates = new Set((archive.snapshots || []).map((row) => row.date));
    try {
      const records = [];
      let page = 1;
      let total = Infinity;
      while (records.length < total && page <= 20) {
        const url = new URL("/api/wx/player/match/record/list", WANZHU_BASE);
        url.searchParams.set("id", String(match.id));
        url.searchParams.set("user_id", player.userId);
        url.searchParams.set("page", String(page));
        url.searchParams.set("page_size", "100");
        const response = await apiJson(url, 2, headers);
        const list = Array.isArray(response?.list) ? response.list : [];
        total = Number(response?.total || list.length);
        records.push(...list);
        if (!list.length || list.length < 100) break;
        page += 1;
      }
      const currentMatchRecords = records.filter((record) => String(record.match_id || "") === String(match.id)
        && record.stock_date && record.stock_date <= args.date);
      const fetched = currentMatchRecords.map((record) => wanzhuDirectSnapshot(record, player, {
        id: String(match.id), name: match.name || match.match_name || "顽主杯",
      }));
      recoveredSnapshots += new Set(fetched.filter((row) => !existingDates.has(row.date)).map((row) => row.date)).size;
      const unique = new Map((archive.snapshots || []).map((row) => [row.date, row]));
      for (const row of fetched) unique.set(row.date, row);
      archive.snapshots = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
      archive.lastError = null;
      archive.lastSuccessfulFetchAt = new Date().toISOString();
    } catch (error) {
      failedPlayers += 1;
      archive.lastError = error.message;
    }
    const snapshotDates = new Set((archive.snapshots || []).map((row) => row.date));
    archive.pendingDates ||= {};
    for (const date of recentRetryDates) {
      if (snapshotDates.has(date)) delete archive.pendingDates[date];
      else archive.pendingDates[date] = { status: "not_disclosed_yet", lastAttemptAt: new Date().toISOString() };
    }
    archive.source = "顽主杯";
    archive.userId = player.userId;
    archive.personName = archive.snapshots.at(-1)?.personName || player.personName;
    archive.groupId = player.groupId;
    archive.groupName = player.groupName;
    archive.match = {
      id: String(match.id), name: match.name || match.match_name || "顽主杯",
      startDate: validDates[0] || "", endDate: dates.at(-1) || args.date,
    };
    archive.updatedAt = new Date().toISOString();
    snapshotCount += archive.snapshots.length;
    pendingRecent += Object.keys(archive.pendingDates).filter((date) => recentRetryDates.has(date)).length;
    const playerLatest = archive.snapshots.at(-1)?.date || null;
    if (playerLatest && (!latestSnapshotDate || playerLatest > latestSnapshotDate)) latestSnapshotDate = playerLatest;
    await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
    return archive;
  });
  const playersCurrent = results.filter((archive) => archive.snapshots?.at(-1)?.date === dates.at(-1)).length;
  return {
    datesAvailable: dates.length,
    datesFetched: missing.length,
    roster: roster.size,
    requestedPlayers: roster.size,
    failedPlayers,
    recoveredSnapshots,
    snapshots: snapshotCount,
    latestSnapshotDate,
    playersCurrent,
    pendingRecent,
    recentRetryDays: RECENT_MISSING_RETRY_DAYS,
    status: failedPlayers ? "partial" : "complete",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(ARCHIVE_ROOT, { recursive: true });
  const wanzhu = await backfillWanzhu(args);
  const fuli = await backfillFuli(args);
  console.log(JSON.stringify({ date: args.date, wanzhu, fuli, archiveRoot: ARCHIVE_ROOT }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
