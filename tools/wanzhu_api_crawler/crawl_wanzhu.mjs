#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "https://api.hunanwanzhu.com";

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    authorization: process.env.WANZHU_AUTHORIZATION || "",
    date: "",
    matchId: "",
    limit: 10,
    topPlayers: 10,
    outDir: path.resolve("outputs", "wanzhu"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--base-url") args.baseUrl = value, index += 1;
    else if (key === "--authorization") args.authorization = value, index += 1;
    else if (key === "--date") args.date = value, index += 1;
    else if (key === "--match-id") args.matchId = value, index += 1;
    else if (key === "--limit") args.limit = Number(value), index += 1;
    else if (key === "--top-players") args.topPlayers = Number(value), index += 1;
    else if (key === "--out") args.outDir = path.resolve(value), index += 1;
    else if (key === "--help" || key === "-h") {
      console.log(
        [
          "Usage: node crawl_wanzhu.mjs [options]",
          "  --date YYYY-MM-DD       Trading date (default: API current date)",
          "  --match-id ID           Match ID (default: current match)",
          "  --limit N               Number of hot stocks (default: 10)",
          "  --top-players N         Players per group (default: 10)",
          "  --out DIR               Output directory",
          "  --authorization TOKEN   Optional existing mini-program token",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1 || !Number.isInteger(args.topPlayers) || args.topPlayers < 3) {
    throw new Error("--limit and --top-players must be positive integers; --top-players must be at least 3");
  }
  return args;
}

async function apiGet(args, endpoint, query = {}) {
  const url = new URL(endpoint, args.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== "" && value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { accept: "application/json" };
  if (args.authorization) headers.Authorization = args.authorization;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.code !== 0 && payload.errno !== 0) {
    throw new Error(`${endpoint} failed: ${payload.message || JSON.stringify(payload)}`);
  }
  return payload.data;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stockMatches(holding, stock) {
  if (holding.code && stock.stock_code) return String(holding.code) === String(stock.stock_code);
  if (holding.stock_id && stock.id) return Number(holding.stock_id) === Number(stock.id);
  return String(holding.name || "").trim() === String(stock.stock_name || "").trim();
}

function sumFund(items) {
  return items.reduce((sum, item) => sum + (Number(item.fund) || 0), 0);
}

function currentHoldingSummary(players) {
  const holdingsByPlayerAndStock = new Map();
  for (const player of players) {
    for (const item of parseJsonArray(player.today_stock)) {
      const amountWan = Number(item.fund) || 0;
      const stockCode = String(item.code || "").match(/\d{6}/)?.[0] || "";
      const stockName = String(item.name || "").trim();
      if (amountWan <= 0 || !stockName || /发债|转债|可转债/.test(stockName)) continue;
      const stockKey = stockCode || stockName;
      const key = `${player.user_id}|${stockKey}`;
      const existing = holdingsByPlayerAndStock.get(key);
      if (existing) {
        existing.amountWan += amountWan;
      } else {
        holdingsByPlayerAndStock.set(key, {
          stockCode,
          stockName,
          amountWan,
          player: player.username || player.nickname,
          group: player.groupName,
        });
      }
    }
  }

  const summary = new Map();
  for (const holding of holdingsByPlayerAndStock.values()) {
    const stockKey = holding.stockCode || holding.stockName;
    if (!summary.has(stockKey)) {
      summary.set(stockKey, {
        stockCode: holding.stockCode,
        stockName: holding.stockName,
        holdingCount: 0,
        totalAmountWan: 0,
        holders: [],
      });
    }
    const row = summary.get(stockKey);
    row.holdingCount += 1;
    row.totalAmountWan += holding.amountWan;
    row.holders.push(`${holding.group}-${holding.player}`);
  }
  return [...summary.values()]
    .sort(
      (a, b) =>
        b.holdingCount - a.holdingCount ||
        b.totalAmountWan - a.totalAmountWan ||
        a.stockCode.localeCompare(b.stockCode),
    )
    .map((row, index) => ({
      holdingRank: index + 1,
      ...row,
      totalAmountWan: Math.round(row.totalAmountWan * 100) / 100,
    }));
}

function classifyPlayerStock(player, stock) {
  const today = parseJsonArray(player.today_stock).filter((item) => stockMatches(item, stock));
  const yesterday = parseJsonArray(player.yesterday_stock).filter((item) => stockMatches(item, stock));
  const todayFund = sumFund(today);
  const yesterdayFund = sumFund(yesterday);

  if (today.some((item) => Number(item.fund) > 0)) {
    return { status: "正在持有", todayFund, yesterdayFund };
  }
  if (
    today.some((item) => Number(item.fund) <= 0) ||
    yesterday.some((item) => Number(item.fund) > 0)
  ) {
    return { status: "今天已卖掉", todayFund, yesterdayFund };
  }
  return { status: "不涉及", todayFund, yesterdayFund };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, columns) {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function statusNames(details, status) {
  return details
    .filter((item) => item.status === status)
    .map((item) => `${item.group}-${item.player}`)
    .join("、") || "无";
}

function buildMarkdown(result) {
  const lines = [
    `# 热门股与各组选手收盘持仓分析报告（${result.date}）`,
    "",
    "## 摘要",
    "",
    `本报告由纯 HTTP 爬虫直接读取小程序后台接口生成。样本为“${result.match.name}”的 ${result.players.length} 名选手（${result.groups.length} 个组、每组前 3 名）与当日热门股前 ${result.hotStocks.length} 名。`,
    "",
    "## 1. 样本与方法",
    "",
    `- 统计日期：${result.date}`,
    `- 上一交易日：${result.previousTradingDate || "无可用数据"}`,
    `- 选手范围：${result.groups.map((group) => `${group.name}前3名`).join("、")}`,
    "- 分类口径：今日持仓金额大于 0 记为“正在持有”；今日记录明确为 0，或昨日持有但今日已不在持仓中，记为“今天已卖掉”；其余记为“不涉及”。",
    "- 校验规则：每只股票“今天已卖掉 + 正在持有 + 不涉及”必须等于样本选手总数。",
    "",
    "## 2. 各组前三名",
    "",
    "| 组别 | 第1名 | 第2名 | 第3名 |",
    "|---|---|---|---|",
  ];

  for (const group of result.groups) {
    const names = group.players.map((player) => player.username || player.nickname);
    lines.push(`| ${group.name} | ${names[0] || ""} | ${names[1] || ""} | ${names[2] || ""} |`);
  }

  lines.push(
    "",
    "## 3. 入选选手收盘持仓前三名",
    "",
    "| 持仓排名 | 股票 | 持有人数 | 合计持仓金额(万) | 持有人 |",
    "|---:|---|---:|---:|---|",
  );
  for (const stock of result.currentHoldingTop3) {
    lines.push(
      `| ${stock.holdingRank} | ${stock.stockName}（${stock.stockCode}） | ${stock.holdingCount} | ${stock.totalAmountWan.toFixed(2)} | ${stock.holders.join("、")} |`,
    );
  }

  lines.push(
    "",
    "## 4. 热门股统计结论",
    "",
    "| 热门排名 | 股票 | 热度人数 | 今天已卖掉 | 正在持有 | 不涉及 | 校验 |",
    "|---:|---|---:|---:|---:|---:|---:|",
  );
  for (const stock of result.stockSummary) {
    lines.push(
      `| ${stock.hotRank} | ${stock.stockName}（${stock.stockCode}） | ${stock.hotCount} | ${stock.soldCount} | ${stock.holdingCount} | ${stock.uninvolvedCount} | ${stock.totalChecked} |`,
    );
  }

  lines.push("", "## 5. 个股明细", "");
  for (const stock of result.stockSummary) {
    lines.push(
      `### 5.${stock.hotRank} ${stock.stockName}（${stock.stockCode}）`,
      "",
      `- 今天已卖掉（${stock.soldCount} 人）：${statusNames(stock.details, "今天已卖掉")}`,
      `- 正在持有（${stock.holdingCount} 人）：${statusNames(stock.details, "正在持有")}`,
      `- 不涉及（${stock.uninvolvedCount} 人）：${statusNames(stock.details, "不涉及")}`,
      "",
    );
  }

  lines.push(
    "## 6. 结论与限制",
    "",
    "本报告反映参赛选手在统计日收盘后提交到比赛系统的持仓记录。它适合回答“各组前三名在热门股上的收盘暴露情况”，但不能识别同一交易日内买入后又卖出的完整盘中路径；未及时提交、自动补全或人工录入误差也可能影响单个选手状态。所有汇总均保留逐选手明细，便于复核。",
    "",
    "## 7. 数据来源",
    "",
    "- 顽主杯小程序后台：默认交易日、比赛列表、热门买入股票、分组排行榜接口。",
    `- 抓取时间：${result.generatedAt}`,
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matches = await apiGet(args, "/api/wx/v2/match/list");
  if (!Array.isArray(matches) || matches.length === 0) throw new Error("No matches returned");

  const match = args.matchId
    ? matches.find((item) => String(item.id) === String(args.matchId))
    : matches.find((item) => Number(item.match_status) === 3) || matches[0];
  if (!match) throw new Error(`Match not found: ${args.matchId}`);

  const date = args.date || await apiGet(args, "/api/wx/v2/default/date", { match_id: match.id });
  const [hotData, rankData] = await Promise.all([
    apiGet(args, "/api/wx/v2/hot/stock/buy/list", {
      stock_date: date,
      page: 1,
      page_size: Math.max(args.limit, 20),
      fund_rank: 0,
    }),
    apiGet(args, "/api/wx/group/rank/list", {
      stock_date: date,
      match_id: match.id,
    }),
  ]);

  const hotStocks = (hotData.list || []).slice(0, args.limit).map((stock, index) => ({
    ...stock,
    hotRank: index + 1,
  }));
  const groups = (rankData.groups || []).map((group) => ({
    id: group.id,
    name: group.name,
    players: [...(group.players || [])]
      .sort((a, b) => Number(a.group_rank) - Number(b.group_rank))
      .slice(0, args.topPlayers),
  }));
  const players = groups.flatMap((group) => group.players.map((player) => ({
    ...player,
    groupName: group.name,
  })));
  if (groups.length === 0 || players.length === 0) throw new Error("No ranked players returned");

  const validDates = parseJsonArray(match.valid_dates);
  const previousTradingDate = [...new Set(validDates)]
    .filter((item) => item < date)
    .sort()
    .at(-1) || "";

  const detailRows = [];
  const stockSummary = hotStocks.map((stock) => {
    const details = players.map((player) => {
      const classification = classifyPlayerStock(player, stock);
      const detail = {
        hotRank: stock.hotRank,
        stockCode: stock.stock_code,
        stockName: stock.stock_name,
        group: player.groupName,
        groupRank: player.group_rank,
        player: player.username || player.nickname,
        userId: player.user_id,
        status: classification.status,
        yesterdayFund: classification.yesterdayFund,
        todayFund: classification.todayFund,
      };
      detailRows.push(detail);
      return detail;
    });
    const soldCount = details.filter((item) => item.status === "今天已卖掉").length;
    const holdingCount = details.filter((item) => item.status === "正在持有").length;
    const uninvolvedCount = details.filter((item) => item.status === "不涉及").length;
    const totalChecked = soldCount + holdingCount + uninvolvedCount;
    if (totalChecked !== players.length) {
      throw new Error(`Validation failed for ${stock.stock_code}: ${totalChecked} != ${players.length}`);
    }
    return {
      hotRank: stock.hotRank,
      stockCode: stock.stock_code,
      stockName: stock.stock_name,
      hotCount: stock.count,
      soldCount,
      holdingCount,
      uninvolvedCount,
      totalChecked,
      details,
    };
  });

  const holdingSummary = currentHoldingSummary(players);
  const result = {
    generatedAt: new Date().toISOString(),
    source: args.baseUrl,
    date,
    previousTradingDate,
    match: { id: match.id, name: match.name },
    hotStocks,
    groups,
    players: players.map((player) => ({
      group: player.groupName,
      groupRank: player.group_rank,
      username: player.username || player.nickname,
      userId: player.user_id,
    })),
    currentHoldingSummary: holdingSummary,
    currentHoldingTop3: holdingSummary.slice(0, 3),
    stockSummary,
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const prefix = `wanzhu_${date}`;
  const jsonPath = path.join(args.outDir, `${prefix}.json`);
  const summaryCsvPath = path.join(args.outDir, `${prefix}_summary.csv`);
  const detailCsvPath = path.join(args.outDir, `${prefix}_details.csv`);
  const holdingTop3CsvPath = path.join(args.outDir, `${prefix}_holding_top3.csv`);
  const reportPath = path.join(args.outDir, `${prefix}_report.md`);

  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    fs.writeFile(summaryCsvPath, toCsv(stockSummary, [
      { key: "hotRank", label: "热门排名" },
      { key: "stockCode", label: "股票代码" },
      { key: "stockName", label: "股票名称" },
      { key: "hotCount", label: "热度人数" },
      { key: "soldCount", label: "今天已卖掉" },
      { key: "holdingCount", label: "正在持有" },
      { key: "uninvolvedCount", label: "不涉及" },
      { key: "totalChecked", label: "校验人数" },
    ]), "utf8"),
    fs.writeFile(detailCsvPath, toCsv(detailRows, [
      { key: "hotRank", label: "热门排名" },
      { key: "stockCode", label: "股票代码" },
      { key: "stockName", label: "股票名称" },
      { key: "group", label: "组别" },
      { key: "groupRank", label: "组内排名" },
      { key: "player", label: "选手" },
      { key: "status", label: "状态" },
      { key: "yesterdayFund", label: "昨日持仓金额(万)" },
      { key: "todayFund", label: "今日持仓金额(万)" },
    ]), "utf8"),
    fs.writeFile(holdingTop3CsvPath, toCsv(result.currentHoldingTop3, [
      { key: "holdingRank", label: "持仓排名" },
      { key: "stockCode", label: "股票代码" },
      { key: "stockName", label: "股票名称" },
      { key: "holdingCount", label: "持有人数" },
      { key: "totalAmountWan", label: "合计持仓金额(万)" },
      { key: "holders", label: "持有人" },
    ]), "utf8"),
    fs.writeFile(reportPath, `${buildMarkdown(result)}\n`, "utf8"),
  ]);

  console.log(JSON.stringify({
    date,
    match: result.match,
    groups: groups.length,
    players: players.length,
    hotStocks: hotStocks.length,
    outputs: { jsonPath, summaryCsvPath, detailCsvPath, holdingTop3CsvPath, reportPath },
    currentHoldingTop3: result.currentHoldingTop3,
    stockSummary: stockSummary.map(({ details, ...summary }) => summary),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
