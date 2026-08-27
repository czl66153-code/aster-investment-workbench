#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUT = path.resolve("outputs", "expert_tracking");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { date: "", limit: 20, outDir: DEFAULT_OUT, xueqiuHistoryDepth: 12, skipTonghuashun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--date") args.date = value, index += 1;
    else if (key === "--limit") args.limit = Number(value), index += 1;
    else if (key === "--out") args.outDir = path.resolve(value), index += 1;
    else if (key === "--xueqiu-history-depth") args.xueqiuHistoryDepth = Number(value), index += 1;
    else if (key === "--skip-tonghuashun") args.skipTonghuashun = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  if (!Number.isInteger(args.xueqiuHistoryDepth) || args.xueqiuHistoryDepth < 0 || args.xueqiuHistoryDepth > 100) {
    throw new Error("--xueqiu-history-depth must be an integer from 0 to 100");
  }
  return args;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchResponse(url, { headers = {}, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  return values
    .flatMap((value) => value.split(/,(?=\s*[\w-]+=)/))
    .map((value) => value.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<[^>]*>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function firstMatch(text, pattern, fallback = "") {
  return text.match(pattern)?.[1] ?? fallback;
}

function numberValue(value) {
  const normalized = String(value ?? "").replaceAll(",", "").replaceAll("%", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFromMillis(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toISOString() : "";
}

function normalizedHolding(item) {
  return {
    stockCode: item.stock_symbol || "",
    stockName: item.stock_name || "",
    weightPct: numberValue(item.weight),
    sector: item.segment_name || "未分类",
    sectorId: item.segment_id || null,
  };
}

function normalizedRebalance(payload) {
  const rebalance = payload?.rebalancing || payload || {};
  const histories = Array.isArray(rebalance.rebalancing_histories) ? rebalance.rebalancing_histories : [];
  return {
    id: rebalance.id ?? null,
    previousId: rebalance.prev_bebalancing_id ?? rebalance.prev_rebalancing_id ?? null,
    createdAt: isoFromMillis(rebalance.created_at),
    category: rebalance.category ?? null,
    status: rebalance.status ?? null,
    trades: histories.map((entry) => {
      const targetWeightPct = numberValue(entry.target_weight);
      const previousWeightPct = numberValue(entry.prev_target_weight ?? entry.prev_weight_adjusted ?? entry.prev_weight);
      let action = "调整";
      if (targetWeightPct > 0 && (previousWeightPct ?? 0) <= 0) action = "买入";
      else if ((targetWeightPct ?? 0) <= 0 && previousWeightPct > 0) action = "卖出";
      else if (targetWeightPct > previousWeightPct) action = "加仓";
      else if (targetWeightPct < previousWeightPct) action = "减仓";
      return {
        stockCode: entry.stock_symbol || "",
        stockName: entry.stock_name || "",
        action,
        targetWeightPct,
        previousWeightPct,
        price: numberValue(entry.price),
      };
    }),
  };
}

async function fetchXueqiuRebalanceChain(item, lastId, apiCookie, depth) {
  const records = [];
  const visited = new Set();
  let currentId = lastId;
  while (currentId && records.length < depth && !visited.has(String(currentId))) {
    visited.add(String(currentId));
    const result = await fetchOptionalJson(
      `https://xueqiu.com/cubes/rebalancing/show_origin.json?rb_id=${encodeURIComponent(currentId)}&cube_symbol=${encodeURIComponent(item.symbol)}`,
      { headers: { accept: "application/json", referer: item.profileUrl, ...(apiCookie ? { cookie: apiCookie } : {}) }, attempts: 2 },
    );
    if (!result.ok || !result.payload?.rebalancing) break;
    const record = normalizedRebalance(result.payload);
    if (!record.id) break;
    records.push(record);
    currentId = record.previousId;
    if (currentId && records.length < depth) await sleep(130);
  }
  return records;
}

function xueqiuStyleProfile(item) {
  const description = item.publicRecommendation || "";
  const holdings = item.currentHoldings || [];
  const top3WeightPct = holdings
    .map((holding) => Number(holding.weightPct) || 0)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, weight) => sum + weight, 0);
  const sectorWeights = new Map();
  for (const holding of holdings) {
    sectorWeights.set(holding.sector, (sectorWeights.get(holding.sector) || 0) + (Number(holding.weightPct) || 0));
  }
  const preferredSectors = [...sectorWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, weightPct]) => ({ name, weightPct: Number(weightPct.toFixed(2)) }));
  const labels = [];
  const rules = [
    [/科技|AI|算力|芯片|半导体|机器人/i, "科技成长"],
    [/价值|低估值|红利|股息|基本面/i, "价值/红利"],
    [/长期|长线|不调仓|低频|被动/i, "长期低换手"],
    [/量化|指数|等权|规则|模型/i, "规则/量化"],
    [/趋势|新高|强势|龙头|量价/i, "趋势强势"],
  ];
  for (const [pattern, label] of rules) if (pattern.test(description)) labels.push(label);
  if (top3WeightPct >= 60) labels.push("高集中");
  else if (holdings.length >= 15) labels.push("分散持仓");
  const tradeStyle = /不调仓|低频|被动|长期|长线/i.test(description)
    ? "偏低换手/长期持有"
    : /每月|定期|平衡|等权|规则/i.test(description)
      ? "规则化再平衡"
      : "需结合连续快照观察换手";
  const selectionStyle = labels.find((label) => ["科技成长", "价值/红利", "趋势强势", "规则/量化"].includes(label))
    || (preferredSectors.length ? `偏${preferredSectors.map((sector) => sector.name).join("、")}` : "选股风格待积累");
  return {
    evidence: holdings.length ? "公开组合说明 + 当前公开持仓" : "公开组合说明",
    labels: [...new Set(labels)],
    tradeStyle,
    stockSelectionStyle: selectionStyle,
    holdingCount: holdings.length,
    top3WeightPct: Number(top3WeightPct.toFixed(2)),
    preferredSectors,
  };
}

async function fetchOptionalJson(url, { headers = {}, attempts = 3 } = {}) {
  let last = { ok: false, status: 0, payload: null, error: "请求未执行" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      last = { ok: response.ok && payload !== null, status: response.status, payload, error: response.ok ? "非JSON响应" : `HTTP ${response.status}` };
      if (last.ok) return last;
    } catch (error) {
      last = { ok: false, status: 0, payload: null, error: error.message };
    }
    if (attempt < attempts) await sleep(500 * attempt);
  }
  return last;
}

async function updateXueqiuArchive(item, outDir) {
  const archiveDir = path.join(outDir, "xueqiu_local");
  const archivePath = path.join(archiveDir, `${item.symbol}.json`);
  let archive = { symbol: item.symbol, name: item.name, manager: item.manager, snapshots: [], rebalances: [] };
  try { archive = JSON.parse(await fs.readFile(archivePath, "utf8")); } catch {}
  const snapshot = {
    capturedAt: new Date().toISOString(),
    sourceUpdatedAt: item.holdingSnapshotAt,
    holdings: item.currentHoldings,
    cashPct: item.cashPct,
    netValue: item.netValue,
    totalGain: item.totalGain,
  };
  const fingerprint = JSON.stringify([snapshot.sourceUpdatedAt, snapshot.holdings.map((holding) => [holding.stockCode, holding.weightPct])]);
  const last = archive.snapshots.at(-1);
  const lastFingerprint = last ? JSON.stringify([last.sourceUpdatedAt, (last.holdings || []).map((holding) => [holding.stockCode, holding.weightPct])]) : "";
  if (item.currentHoldings.length && fingerprint !== lastFingerprint) archive.snapshots.push(snapshot);
  const knownRebalances = new Set((archive.rebalances || []).map((record) => String(record.id)));
  for (const record of item.recentRebalances || []) {
    if (!knownRebalances.has(String(record.id))) archive.rebalances.push(record), knownRebalances.add(String(record.id));
  }
  archive.name = item.name;
  archive.manager = item.manager;
  archive.updatedAt = new Date().toISOString();
  archive.snapshots = archive.snapshots.slice(-365);
  archive.rebalances = archive.rebalances
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-500);
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  item.localHistory = archive.snapshots.slice(-30);
  item.localRebalances = archive.rebalances.slice(-100);
  for (const holding of item.currentHoldings) {
    const buyEvent = [...archive.rebalances].reverse().find((record) =>
      (record.trades || []).some((trade) => trade.stockCode === holding.stockCode && trade.action === "买入"));
    if (buyEvent) {
      const trade = buyEvent.trades.find((entry) => entry.stockCode === holding.stockCode && entry.action === "买入");
      holding.buyTime = buyEvent.createdAt;
      holding.buyTimeEvidence = "明确调仓";
      holding.buyPrice = trade?.price ?? null;
      holding.buyRebalanceId = buyEvent.id;
      continue;
    }
    const firstSnapshot = archive.snapshots.find((record) =>
      (record.holdings || []).some((entry) => entry.stockCode === holding.stockCode));
    if (firstSnapshot) {
      holding.buyTime = firstSnapshot.sourceUpdatedAt || firstSnapshot.capturedAt;
      holding.buyTimeEvidence = "首次快照下限";
    } else {
      holding.buyTime = "";
      holding.buyTimeEvidence = "待继续回溯";
    }
  }
  item.localArchive = path.relative(outDir, archivePath).replaceAll("\\", "/");
}

function parseXueqiuCards(html, limit) {
  return html
    .split('<div class="cube-card fn-clear">')
    .slice(1)
    .map((segment) => {
      const symbol = firstMatch(segment, /href="\/p\/(ZH\d+)"/i);
      if (!symbol) return null;
      const description = decodeHtml(firstMatch(segment, /class="cube-desc[^"]*">([\s\S]*?)<\/div>/i));
      const managerId = firstMatch(segment, /cube-creator"><a href="\/(\d+)"/i);
      return {
        source: "雪球热门组合",
        symbol,
        name: decodeHtml(firstMatch(segment, /class="cube-name[^"]*">([\s\S]*?)<\/a>/i)),
        market: decodeHtml(firstMatch(segment, /class="cube-market[^"]*">([\s\S]*?)<\/span>/i)),
        manager: decodeHtml(firstMatch(segment, /class="name">([\s\S]*?)<\/a>/i)),
        managerId,
        followers: numberValue(firstMatch(segment, /cube-follower">[\s\S]*?class="num">([\d,]+)/i)),
        totalGain: numberValue(firstMatch(segment, /class="rate">[\s\S]*?class="num">([-\d.]+)/i)),
        netValueFromPage: numberValue(firstMatch(segment, /data-current="([^"]+)"/i)),
        publicRecommendation: description === "暂无投资建议哦。" || description === "暂无建议"
          ? ""
          : description,
        profileUrl: `https://xueqiu.com/P/${symbol}`,
        managerUrl: managerId ? `https://xueqiu.com/u/${managerId}` : "",
        publicPostAvailability: "用户动态接口触发站点验证；可在授权浏览器会话中补充，不绕过风控",
        holdingDisclosure: "组合详情触发滑块验证，本次不抓取持仓明细",
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

async function crawlXueqiu(limit, outDir, historyDepth) {
  const discoverUrl = "https://xueqiu.com/p/discover";
  let cookies = "";
  let html = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetchResponse(discoverUrl, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    cookies = cookieHeader(response);
    html = await response.text();
    if (html.includes('<div class="cube-card fn-clear">')) break;
    if (attempt < 5) await sleep(700 * attempt);
  }
  const portfolios = parseXueqiuCards(html, limit);
  if (!portfolios.length) throw new Error("雪球热门组合页面未解析到组合卡片");

  const codes = portfolios.map((item) => item.symbol).join(",");
  const quoteResponse = await fetchResponse(
    `https://xueqiu.com/cubes/quote.json?code=${encodeURIComponent(codes)}`,
    {
      headers: {
        accept: "application/json",
        referer: discoverUrl,
        ...(cookies ? { cookie: cookies } : {}),
      },
    },
  );
  const quotes = await quoteResponse.json();
  const authCookie = String(process.env.XUEQIU_COOKIE || "").trim();
  const apiCookie = authCookie || cookies;
  for (const item of portfolios) {
    const quote = quotes[item.symbol] || {};
    item.netValue = numberValue(quote.net_value) ?? item.netValueFromPage;
    item.dailyGain = numberValue(quote.daily_gain);
    item.monthlyGain = numberValue(quote.monthly_gain);
    item.totalGain = numberValue(quote.total_gain) ?? item.totalGain;
    item.annualizedGain = numberValue(quote.annualized_gain);
    const show = await fetchOptionalJson(
      `https://xueqiu.com/cubes/show.json?symbol=${encodeURIComponent(item.symbol)}`,
      { headers: { accept: "application/json", referer: discoverUrl, ...(apiCookie ? { cookie: apiCookie } : {}) } },
    );
    const view = show.payload?.view_rebalancing || {};
    item.currentHoldings = Array.isArray(view.holdings) ? view.holdings.map(normalizedHolding).filter((holding) => holding.stockCode || holding.stockName) : [];
    item.currentHoldingCount = item.currentHoldings.length;
    item.cashPct = numberValue(view.cash);
    item.holdingSnapshotAt = isoFromMillis(view.updated_at || show.payload?.updated_at);
    item.holdingStatus = item.currentHoldings.length ? "公开接口已缓存" : show.ok ? "当前未披露或空仓" : `抓取受限（${show.error}）`;
    item.holdingDisclosure = item.currentHoldings.length
      ? `已将 ${item.currentHoldings.length} 只当前公开持仓缓存到本地`
      : "当前公开接口未返回可核验持仓";
    item.recentRebalances = await fetchXueqiuRebalanceChain(
      item,
      show.payload?.last_rb_id,
      apiCookie,
      historyDepth,
    );
    item.rebalanceStatus = item.recentRebalances.length
      ? `免登录已回溯 ${item.recentRebalances.length} 次调仓`
      : historyDepth ? "调仓链暂未返回" : "未启用调仓回溯";
    item.styleProfile = xueqiuStyleProfile(item);
    await updateXueqiuArchive(item, outDir);
    delete item.netValueFromPage;
    await sleep(180);
  }
  return {
    page: discoverUrl,
    portfolios,
    validation: {
      parsedCount: portfolios.length,
      quoteCount: portfolios.filter((item) => item.netValue !== null).length,
      recommendationCount: portfolios.filter((item) => item.publicRecommendation).length,
      holdingCount: portfolios.filter((item) => item.currentHoldings.length).length,
      holdingRows: portfolios.reduce((sum, item) => sum + item.currentHoldings.length, 0),
      rebalanceRows: portfolios.reduce((sum, item) => sum + item.recentRebalances.length, 0),
      buyTimeResolved: portfolios.reduce((sum, item) => sum + item.currentHoldings.filter((holding) => holding.buyTimeEvidence === "明确调仓").length, 0),
      authCookieProvided: Boolean(authCookie),
      complete: portfolios.length === Math.min(limit, 20),
    },
  };
}

function parseTonghuashunRows(html, limit) {
  const rows = [...html.matchAll(/<tr class="custom_color\d+">([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1])
    .filter((row) => /moni\.10jqka\.com\.cn\/\d+/i.test(row))
    .map((row, index) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => decodeHtml(match[1]));
      const profile = row.match(/href="http:\/\/moni\.10jqka\.com\.cn\/(\d+)"[^>]*target="_blank"[^>]*>([^<]+)<\/a>/i);
      if (!profile || cells.length < 10) return null;
      return {
        source: "同花顺模拟炒股百强榜",
        rank: index + 1,
        userId: profile[1],
        username: decodeHtml(profile[2]),
        grade: cells[2],
        totalReturn: numberValue(cells[3]),
        monthlyReturn: numberValue(cells[4]),
        weeklyReturn: numberValue(cells[5]),
        dailyReturn: numberValue(cells[6]),
        stockPickSuccessRate: numberValue(cells[7]),
        totalAssets: numberValue(cells[8]),
        trackedCount: numberValue(cells[9]),
        profileUrl: `https://moni.10jqka.com.cn/${profile[1]}`,
        holdingDisclosure: "未登录可见仓位和交易金额，但股票代码与名称被隐藏",
      };
    })
    .filter(Boolean);
  return rows.slice(0, limit);
}

function tableRowsById(html, tableId) {
  const body = firstMatch(html, new RegExp(`<table[^>]+id=["']${tableId}["'][\\s\\S]*?<tbody[^>]*>([\\s\\S]*?)<\\/tbody>`, "i"));
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => ({
    html: match[1],
    rawCells: [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]),
  }));
}

function tonghuashunIdentity(rawCode, rawName) {
  const combined = `${rawCode} ${rawName}`;
  const stockCode = firstMatch(combined, /stockpage\.10jqka\.com\.cn\/(\d{6})/i)
    || firstMatch(combined, /\b(\d{6})\b/);
  let stockName = decodeHtml(rawName);
  if (/zhuikaen|tips_dl|###|登录/i.test(rawName) || !stockName) stockName = "";
  return { stockCode, stockName, identityStatus: stockCode || stockName ? "公开" : "需登录" };
}

function parseTonghuashunProfile(html) {
  const holdings = tableRowsById(html, "ccqk_tbl").map(({ rawCells }, index) => {
    if (rawCells.length < 8) return null;
    const cells = rawCells.map(decodeHtml);
    return {
      row: index + 1,
      ...tonghuashunIdentity(rawCells[0], rawCells[1]),
      quantity: numberValue(cells[2]),
      buyTime: cells[3] || "",
      buyTimeEvidence: cells[3] ? "明确建仓时间" : "未披露",
      costPrice: numberValue(cells[4]),
      currentPrice: numberValue(cells[5]),
      dailyChangePct: numberValue(cells[6]),
      marketValue: numberValue(cells[7]),
      profitRatePct: numberValue(cells[8]),
      floatingPnl: numberValue(cells[9]),
    };
  }).filter(Boolean);
  const trades = tableRowsById(html, "jyjl_tbl").map(({ rawCells }, index) => {
    if (rawCells.length < 7) return null;
    const cells = rawCells.map(decodeHtml);
    return {
      row: index + 1,
      tradeTime: cells[0] || "",
      ...tonghuashunIdentity(rawCells[1], rawCells[2]),
      action: cells[3] || "",
      quantity: numberValue(cells[4]),
      price: numberValue(cells[5]),
      amount: numberValue(cells[6]),
      status: cells[7] || "",
    };
  }).filter(Boolean);
  return { holdings, trades };
}

async function crawlTonghuashun(limit) {
  const rankingUrl = "https://moni.10jqka.com.cn/dw.shtml";
  const response = await fetchResponse(rankingUrl, {
    headers: { accept: "text/html,application/xhtml+xml", referer: "https://moni.10jqka.com.cn/" },
  });
  const html = await response.text();
  const players = parseTonghuashunRows(html, limit);
  if (!players.length) throw new Error("同花顺百强榜未解析到选手");
  const authCookie = String(process.env.TONGHUASHUN_COOKIE || "").trim();
  for (const player of players) {
    try {
      const detailResponse = await fetchResponse(player.profileUrl, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          referer: rankingUrl,
          ...(authCookie ? { cookie: authCookie } : {}),
        },
        attempts: 2,
      });
      const detail = parseTonghuashunProfile(await detailResponse.text());
      player.holdings = detail.holdings;
      player.trades = detail.trades;
      player.holdingCount = detail.holdings.length;
      player.tradeCount = detail.trades.length;
      player.detailFetchedAt = new Date().toISOString();
      player.detailStatus = detail.holdings.length || detail.trades.length ? "持仓与交易字段已缓存" : "页面未返回持仓或交易记录";
      player.holdingDisclosure = detail.holdings.some((holding) => holding.identityStatus === "公开")
        ? "已缓存含股票身份的持仓"
        : "已缓存建仓日、数量、市值和交易；股票身份需授权登录";
    } catch (error) {
      player.holdings = [];
      player.trades = [];
      player.holdingCount = 0;
      player.tradeCount = 0;
      player.detailStatus = `详情抓取失败（${error.message}）`;
    }
    await sleep(150);
  }
  return {
    page: rankingUrl,
    players,
    validation: {
      parsedCount: players.length,
      complete: players.length === limit,
      detailsParsed: players.filter((item) => item.holdingCount || item.tradeCount).length,
      holdingRows: players.reduce((sum, item) => sum + item.holdingCount, 0),
      tradeRows: players.reduce((sum, item) => sum + item.tradeCount, 0),
      identityRows: players.reduce((sum, item) => sum + item.holdings.filter((holding) => holding.identityStatus === "公开").length, 0),
      authCookieProvided: Boolean(authCookie),
    },
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows, fields) {
  return [
    fields.map(([label]) => csvCell(label)).join(","),
    ...rows.map((row) => fields.map(([, key]) => csvCell(row[key])).join(",")),
  ].join("\n") + "\n";
}

function markdownReport(result) {
  const lines = [
    `# 新增高手来源试抓报告（${result.date}）`,
    "",
    "## 雪球热门组合",
    "",
    `抓取 ${result.xueqiu.portfolios.length} 个公开组合，其中 ${result.xueqiu.validation.recommendationCount} 个带有公开投资建议，${result.xueqiu.validation.holdingCount} 个已缓存当前持仓。通过公开调仓链回溯 ${result.xueqiu.validation.rebalanceRows} 次调仓，已为 ${result.xueqiu.validation.buyTimeResolved} 条当前持仓定位明确买入时间。`,
    "",
    "| 组合 | 主理人 | 关注人数 | 总收益 | 日收益 | 年化收益 | 公开建议 |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...result.xueqiu.portfolios.slice(0, 10).map((item) =>
      `| ${item.name} | ${item.manager} | ${item.followers ?? ""} | ${item.totalGain ?? ""}% | ${item.dailyGain ?? ""}% | ${item.annualizedGain ?? ""}% | ${item.publicRecommendation || "未公开"} |`,
    ),
    "",
    "## 同花顺模拟炒股百强榜",
    "",
    `抓取 ${result.tonghuashun.players.length} 名排行榜选手；${result.tonghuashun.validation.detailsParsed} 人的详情已缓存，共 ${result.tonghuashun.validation.holdingRows} 条持仓、${result.tonghuashun.validation.tradeRows} 条交易。未登录时股票代码和名称被遮挡，但建仓日、数量、市值及交易金额仍会保存并展示。`,
    "",
    "| 排名 | 选手 | 段位 | 总收益 | 月收益 | 选股成功率 | 被追踪数 |",
    "|---:|---|---:|---:|---:|---:|---:|",
    ...result.tonghuashun.players.slice(0, 10).map((item) =>
      `| ${item.rank} | ${item.username} | ${item.grade} | ${item.totalReturn ?? ""}% | ${item.monthlyReturn ?? ""}% | ${item.stockPickSuccessRate ?? ""}% | ${item.trackedCount ?? ""} |`,
    ),
    "",
    "## 数据边界",
    "",
    "- 雪球组合持仓是公开模拟组合仓位，不等同于主理人的真实证券账户。",
    "- 同花顺数据属于模拟炒股成绩；未取得股票身份时以“身份受限持仓”展示，不能据此生成个股推荐。",
    "- 爬虫不会绕过登录、追踪权限或滑块验证；受限字段统一明确标记。",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date || shanghaiDate();
  const [xueqiu, tonghuashun] = await Promise.all([
    crawlXueqiu(args.limit, args.outDir, args.xueqiuHistoryDepth),
    args.skipTonghuashun ? Promise.resolve({
      skipped: true,
      players: [],
      validation: { parsedCount: 0, complete: true, detailsParsed: 0, holdingRows: 0, tradeRows: 0, identityRows: 0, authCookieProvided: false },
    }) : crawlTonghuashun(args.limit),
  ]);
  const result = {
    generatedAt: new Date().toISOString(),
    date,
    scope: "仅抓取无需登录即可访问的公开信息",
    xueqiu,
    tonghuashun,
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const base = path.join(args.outDir, `public_sources_${date}`);
  const jsonPath = `${base}.json`;
  const reportPath = `${base}_report.md`;
  const xueqiuCsvPath = `${base}_xueqiu.csv`;
  const tonghuashunCsvPath = `${base}_tonghuashun.csv`;
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    fs.writeFile(reportPath, markdownReport(result), "utf8"),
    fs.writeFile(xueqiuCsvPath, toCsv(xueqiu.portfolios, [
      ["组合代码", "symbol"], ["组合名称", "name"], ["主理人", "manager"],
      ["关注人数", "followers"], ["净值", "netValue"], ["日收益%", "dailyGain"],
      ["月收益%", "monthlyGain"], ["总收益%", "totalGain"], ["年化收益%", "annualizedGain"],
      ["当前持仓数", "currentHoldingCount"], ["持仓缓存状态", "holdingStatus"],
      ["调仓回溯状态", "rebalanceStatus"],
      ["公开投资建议", "publicRecommendation"], ["页面", "profileUrl"],
    ]), "utf8"),
    fs.writeFile(tonghuashunCsvPath, toCsv(tonghuashun.players, [
      ["排名", "rank"], ["选手", "username"], ["段位", "grade"],
      ["总收益%", "totalReturn"], ["月收益%", "monthlyReturn"],
      ["周收益%", "weeklyReturn"], ["日收益%", "dailyReturn"],
      ["选股成功率%", "stockPickSuccessRate"], ["总资产", "totalAssets"],
      ["被追踪数", "trackedCount"], ["持仓行数", "holdingCount"],
      ["交易行数", "tradeCount"], ["详情状态", "detailStatus"], ["页面", "profileUrl"],
    ]), "utf8"),
  ]);

  console.log(JSON.stringify({
    date,
    outputs: { jsonPath, reportPath, xueqiuCsvPath, tonghuashunCsvPath },
    validation: { xueqiu: xueqiu.validation, tonghuashun: tonghuashun.validation },
    sample: {
      xueqiu: xueqiu.portfolios.slice(0, 3),
      tonghuashun: tonghuashun.players.slice(0, 3),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
