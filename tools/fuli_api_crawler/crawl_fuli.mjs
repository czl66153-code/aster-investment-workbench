#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "https://www.fuyinkeji.top";

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    date: "",
    session: "",
    limit: 10,
    topPlayers: 3,
    rankType: 2,
    outDir: path.resolve("outputs", "fuli"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--base-url") args.baseUrl = value, index += 1;
    else if (key === "--date") args.date = value, index += 1;
    else if (key === "--session") args.session = value, index += 1;
    else if (key === "--limit") args.limit = Number(value), index += 1;
    else if (key === "--top-players") args.topPlayers = Number(value), index += 1;
    else if (key === "--rank-type") args.rankType = Number(value), index += 1;
    else if (key === "--out") args.outDir = path.resolve(value), index += 1;
    else if (key === "--help" || key === "-h") {
      console.log(
        [
          "Usage: node crawl_fuli.mjs [options]",
          "  --date YYYY-MM-DD       Trading date (default: API business date)",
          "  --session ID            Competition session (default: current session)",
          "  --limit N               Number of hot stocks (default: 10)",
          "  --top-players N         Players per group (default: 3)",
          "  --rank-type 1|2         1=daily ranking, 2=total ranking (default: 2)",
          "  --out DIR               Output directory",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  for (const [name, value] of [
    ["--limit", args.limit],
    ["--top-players", args.topPlayers],
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (![1, 2].includes(args.rankType)) {
    throw new Error("--rank-type must be 1 (daily) or 2 (total)");
  }
  return args;
}

async function apiGet(args, endpoint, query = {}) {
  const url = new URL(endpoint, args.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "fuli-report-crawler/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.code !== 200) {
    throw new Error(`${endpoint} failed: code=${payload.code} ${payload.message || ""}`.trim());
  }
  return payload.data;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function previousCalendarDate(dateText, daysBack) {
  const date = new Date(`${dateText}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() - daysBack);
  return isoDate(date);
}

async function getRankList(args, { date, session, groupType }) {
  const data = await apiGet(args, "/sys/umsExplodeOrder/rankList", {
    type: args.rankType,
    groupType,
    openId: "",
    holdDate: date,
    gameSession: session,
    gameTeamId: "",
    searchType: "top",
  });
  return Array.isArray(data) ? data : [];
}

async function findPreviousTradingDate(args, { date, session, groupType }) {
  for (let daysBack = 1; daysBack <= 12; daysBack += 1) {
    const candidate = previousCalendarDate(date, daysBack);
    const rankList = await getRankList(args, { date: candidate, session, groupType });
    if (rankList.length > 0) return candidate;
  }
  return "";
}

function normalizeStockName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replaceAll(/\s+/g, "")
    .toUpperCase();
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function stockRows(orderDetails) {
  return Array.isArray(orderDetails?.holdStockVos) ? orderDetails.holdStockVos : [];
}

function matchingRows(orderDetails, stockName) {
  const key = normalizeStockName(stockName);
  return stockRows(orderDetails).filter((item) => normalizeStockName(item.stockName) === key);
}

function sumAmount(rows) {
  return rows.reduce((total, item) => total + parseAmount(item.holdPrice), 0);
}

function normalizedHoldings(order) {
  return stockRows(order).map((item) => ({
    stockCode: String(item.stockCode || item.stcokCode || item.code || "").match(/\d{6}/)?.[0] || "",
    stockName: String(item.stockName || "").trim(),
    amount: parseAmount(item.holdPrice),
    amountWan: parseAmount(item.holdPrice) / 10_000,
  })).filter((item) => item.stockName && !/发债|转债|可转债/.test(item.stockName));
}

function currentHoldingSummary(players) {
  const holdingsByPlayerAndStock = new Map();
  for (const player of players) {
    for (const item of stockRows(player.todayOrder)) {
      const amount = parseAmount(item.holdPrice);
      const stockName = String(item.stockName || "").trim();
      const stockCode = String(
        item.stockCode || item.stcokCode || item.code || "",
      ).match(/\d{6}/)?.[0] || "";
      if (amount <= 0 || !stockName || /发债|转债|可转债/.test(stockName)) continue;
      const stockKey = stockCode || normalizeStockName(stockName);
      const key = `${player.openId}|${stockKey}`;
      const existing = holdingsByPlayerAndStock.get(key);
      if (existing) {
        existing.amount += amount;
      } else {
        holdingsByPlayerAndStock.set(key, {
          stockCode,
          stockName,
          amount,
          player: player.gameName,
          group: player.groupName,
        });
      }
    }
  }

  const summary = new Map();
  for (const holding of holdingsByPlayerAndStock.values()) {
    const stockKey = holding.stockCode || normalizeStockName(holding.stockName);
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
    row.totalAmountWan += holding.amount / 10_000;
    row.holders.push(`${holding.group}-${holding.player}`);
  }
  return [...summary.values()]
    .sort(
      (a, b) =>
        b.holdingCount - a.holdingCount ||
        b.totalAmountWan - a.totalAmountWan ||
        a.stockName.localeCompare(b.stockName, "zh-CN"),
    )
    .map((row, index) => ({
      holdingRank: index + 1,
      ...row,
      totalAmountWan: Math.round(row.totalAmountWan * 100) / 100,
    }));
}

function classifyPlayerStock(player, stock) {
  const todayRows = matchingRows(player.todayOrder, stock.stockName);
  const yesterdayRows = matchingRows(player.previousOrder, stock.stockName);
  const todayAmount = sumAmount(todayRows);
  const yesterdayAmount = sumAmount(yesterdayRows);

  if (todayRows.some((item) => parseAmount(item.holdPrice) > 0)) {
    return {
      status: "正在持有",
      yesterdayAmount,
      todayAmount,
    };
  }
  if (
    todayRows.some((item) => parseAmount(item.holdPrice) <= 0)
    || yesterdayRows.some((item) => parseAmount(item.holdPrice) > 0)
  ) {
    return {
      status: "今天已卖掉",
      yesterdayAmount,
      todayAmount,
    };
  }
  return {
    status: "不涉及",
    yesterdayAmount,
    todayAmount,
  };
}

async function fetchOrder(args, { date, openId, session }) {
  const data = await apiGet(args, "/sys/umsExplodeOrder/getExplodeOrderDetail", {
    holdDate: date,
    openId,
    gameSession: session,
  });
  return data?.orderDetails || {};
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

function namesForStatus(details, status) {
  const values = details
    .filter((item) => item.status === status)
    .map((item) => `${item.group}-${item.player}`);
  return values.length ? values.join("、") : "无";
}

function stockLabel(stock) {
  return stock.stockCode ? `${stock.stockName}（${stock.stockCode}）` : stock.stockName;
}

function buildMarkdown(result) {
  const lines = [
    `# 复利笔记热门股与各组选手收盘持仓分析报告（${result.date}）`,
    "",
    "## 摘要",
    "",
    `本报告由纯 HTTP 爬虫直接读取“复利笔记/复利杯”小程序后台接口生成。样本为 ${result.match.name} 的 ${result.players.length} 名选手（${result.groups.length} 个有效组、每组前 ${result.topPlayersPerGroup} 名）与当日热股榜前 ${result.hotStocks.length} 名。`,
    "",
    "## 1. 样本与方法",
    "",
    `- 统计日期：${result.date}`,
    `- 对比日期：${result.previousTradingDate || "无可用历史日期"}`,
    `- 排名口径：${result.rankType === 2 ? "累计收益排名" : "当日收益排名"}`,
    `- 选手范围：${result.groups.map((group) => `${group.name}前${result.topPlayersPerGroup}名`).join("、")}`,
    "- 分类口径：统计日仍有正持仓金额记为“正在持有”；对比日有正持仓但统计日已无正持仓，或统计日存在零持仓记录，记为“今天已卖掉”；其他记为“不涉及”。",
    `- 完整性校验：每只股票三类人数之和必须等于 ${result.players.length}。`,
    "",
    "## 2. 各组前三名",
    "",
    "| 组别 | 第1名 | 第2名 | 第3名 |",
    "|---|---|---|---|",
  ];

  for (const group of result.groups) {
    const names = group.players.map((player) => player.gameName);
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
      `| ${stock.holdingRank} | ${stockLabel(stock)} | ${stock.holdingCount} | ${stock.totalAmountWan.toFixed(2)} | ${stock.holders.join("、")} |`,
    );
  }

  lines.push(
    "",
    "## 4. 热门股统计结论",
    "",
    "| 热门排名 | 股票 | 热度人数 | 前日人数 | 今天已卖掉 | 正在持有 | 不涉及 | 校验 |",
    "|---:|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const stock of result.stockSummary) {
    lines.push(
      `| ${stock.hotRank} | ${stockLabel(stock)} | ${stock.hotCount} | ${stock.previousHotCount} | ${stock.soldCount} | ${stock.holdingCount} | ${stock.uninvolvedCount} | ${stock.totalChecked} |`,
    );
  }

  lines.push("", "## 5. 个股明细", "");
  for (const stock of result.stockSummary) {
    lines.push(
      `### 5.${stock.hotRank} ${stockLabel(stock)}`,
      "",
      `- 今天已卖掉（${stock.soldCount} 人）：${namesForStatus(stock.details, "今天已卖掉")}`,
      `- 正在持有（${stock.holdingCount} 人）：${namesForStatus(stock.details, "正在持有")}`,
      `- 不涉及（${stock.uninvolvedCount} 人）：${namesForStatus(stock.details, "不涉及")}`,
      "",
    );
  }

  lines.push(
    "## 6. 解释边界",
    "",
    "本报告比较两个收盘日的结构化报单，适合判断统计日收盘后的持仓暴露与可识别的隔日退出。它不能还原同一交易日内先买后卖的完整盘中路径；若个别选手只上传截图、系统未识别出股票明细，则只能依据接口中可识别的结构化股票记录分类。",
    "",
    "## 7. 数据来源",
    "",
    "- 复利笔记/复利杯小程序后台：赛季配置、热股榜、分组排名、选手报单详情接口。",
    `- 抓取时间：${result.generatedAt}`,
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startup = await apiGet(args, "/gameConfig/getGameConfigStartupBundle");
  const current = startup?.gameConfigByCurrentSession || {};
  const session = args.session || startup?.currentGameSession?.gameSession || current.gameSession;
  if (!session) throw new Error("Could not determine the competition session");

  let gameConfig = current;
  if (String(gameConfig.gameSession) !== String(session)) {
    gameConfig = await apiGet(
      args,
      `/gameConfig/getUmsGameConfigBySession?gameSession=${encodeURIComponent(session)}`,
    );
  }
  const date = args.date || gameConfig.todayTime;
  if (!date) throw new Error("Could not determine the trading date; pass --date YYYY-MM-DD");

  const groupsConfig = (gameConfig.groupTypeList || []).filter((item) => Number(item.isValid) === 1);
  if (!groupsConfig.length) throw new Error(`No valid groups returned for session ${session}`);

  const previousTradingDate = await findPreviousTradingDate(args, {
    date,
    session,
    groupType: groupsConfig[0].groupType,
  });
  if (!previousTradingDate) {
    throw new Error(`Could not find a previous trading date before ${date}`);
  }

  const [hotList, ...rankLists] = await Promise.all([
    apiGet(args, "/hold/selectHoldHoldStocks", { holdDate: date }),
    ...groupsConfig.map((group) => getRankList(args, {
      date,
      session,
      groupType: group.groupType,
    })),
  ]);

  const hotStocks = (Array.isArray(hotList) ? hotList : [])
    .slice(0, args.limit)
    .map((stock, index) => ({
      hotRank: index + 1,
      stockCode: stock.stcokCode || stock.stockCode || "",
      stockName: stock.stockName || "",
      hotCount: Number(stock.stockUser) || 0,
      previousHotCount: Number(stock.prevDayStockUser) || 0,
      rankChange: Number(stock.rankChange) || 0,
      aggregateHoldPrice: stock.holdPrice || "",
    }));
  if (hotStocks.length !== args.limit) {
    throw new Error(`Expected ${args.limit} hot stocks, got ${hotStocks.length}`);
  }

  const groups = groupsConfig.map((group, groupIndex) => {
    const players = rankLists[groupIndex].slice(0, args.topPlayers).map((player, index) => ({
      groupRank: index + 1,
      openId: player.openId,
      gameName: player.gameName || player.nickname || "",
      totalEarningRate: player.totalEarningRate,
      todayEarningRate: player.todayEarningRate,
      notebookId: player.notebookId,
    }));
    if (players.length !== args.topPlayers) {
      throw new Error(
        `${group.groupTypeName || group.groupType} returned only ${players.length} ranked players`,
      );
    }
    return {
      id: group.id,
      type: String(group.groupType),
      name: group.groupTypeName || String(group.groupType),
      players,
    };
  });

  const players = groups.flatMap((group) => group.players.map((player) => ({
    ...player,
    groupType: group.type,
    groupName: group.name,
  })));

  await Promise.all(players.map(async (player) => {
    const [previousOrder, todayOrder] = await Promise.all([
      fetchOrder(args, {
        date: previousTradingDate,
        openId: player.openId,
        session,
      }),
      fetchOrder(args, {
        date,
        openId: player.openId,
        session,
      }),
    ]);
    player.previousOrder = previousOrder;
    player.todayOrder = todayOrder;
  }));

  const detailRows = [];
  const stockSummary = hotStocks.map((stock) => {
    const details = players.map((player) => {
      const classification = classifyPlayerStock(player, stock);
      const detail = {
        hotRank: stock.hotRank,
        stockCode: stock.stockCode,
        stockName: stock.stockName,
        group: player.groupName,
        groupRank: player.groupRank,
        player: player.gameName,
        openId: player.openId,
        status: classification.status,
        yesterdayAmount: classification.yesterdayAmount,
        todayAmount: classification.todayAmount,
        yesterdayAmountWan: classification.yesterdayAmount / 10_000,
        todayAmountWan: classification.todayAmount / 10_000,
      };
      detailRows.push(detail);
      return detail;
    });
    const soldCount = details.filter((item) => item.status === "今天已卖掉").length;
    const holdingCount = details.filter((item) => item.status === "正在持有").length;
    const uninvolvedCount = details.filter((item) => item.status === "不涉及").length;
    const totalChecked = soldCount + holdingCount + uninvolvedCount;
    if (totalChecked !== players.length) {
      throw new Error(
        `Validation failed for ${stock.stockName}: ${totalChecked} != ${players.length}`,
      );
    }
    return {
      ...stock,
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
    appName: "复利笔记",
    date,
    previousTradingDate,
    rankType: args.rankType,
    topPlayersPerGroup: args.topPlayers,
    match: {
      id: session,
      name: gameConfig.gameSessionName || `赛季 ${session}`,
      startDate: gameConfig.gameStartTime,
      endDate: gameConfig.gameEndTime,
    },
    hotStocks,
    groups,
    players: players.map((player) => ({
      group: player.groupName,
      groupType: player.groupType,
      groupRank: player.groupRank,
      gameName: player.gameName,
      openId: player.openId,
      totalEarningRate: player.totalEarningRate,
      todayEarningRate: player.todayEarningRate,
      previousStockCount: stockRows(player.previousOrder).length,
      todayStockCount: stockRows(player.todayOrder).length,
      previousStockPercent: player.previousOrder?.stockPercent ?? null,
      todayStockPercent: player.todayOrder?.stockPercent ?? null,
      previousHoldings: normalizedHoldings(player.previousOrder),
      todayHoldings: normalizedHoldings(player.todayOrder),
    })),
    currentHoldingSummary: holdingSummary,
    currentHoldingTop3: holdingSummary.slice(0, 3),
    stockSummary,
    validation: {
      groupCount: groups.length,
      playerCount: players.length,
      hotStockCount: hotStocks.length,
      classificationCount: detailRows.length,
      allStockTotalsEqualPlayerCount: stockSummary.every(
        (stock) => stock.totalChecked === players.length,
      ),
    },
    endpoints: [
      "/gameConfig/getGameConfigStartupBundle",
      "/hold/selectHoldHoldStocks",
      "/sys/umsExplodeOrder/rankList",
      "/sys/umsExplodeOrder/getExplodeOrderDetail",
    ],
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const prefix = `fuli_${date}`;
  const jsonPath = path.join(args.outDir, `${prefix}.json`);
  const summaryCsvPath = path.join(args.outDir, `${prefix}_summary.csv`);
  const detailCsvPath = path.join(args.outDir, `${prefix}_details.csv`);
  const holdingTop3CsvPath = path.join(args.outDir, `${prefix}_holding_top3.csv`);
  const reportPath = path.join(args.outDir, `${prefix}_report.md`);

  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    fs.writeFile(summaryCsvPath, toCsv(stockSummary, [
      { key: "hotRank", label: "热股排名" },
      { key: "stockCode", label: "股票代码" },
      { key: "stockName", label: "股票名称" },
      { key: "hotCount", label: "热度人数" },
      { key: "previousHotCount", label: "前日热度人数" },
      { key: "soldCount", label: "今天已卖掉" },
      { key: "holdingCount", label: "正在持有" },
      { key: "uninvolvedCount", label: "不涉及" },
      { key: "totalChecked", label: "校验人数" },
    ]), "utf8"),
    fs.writeFile(detailCsvPath, toCsv(detailRows, [
      { key: "hotRank", label: "热股排名" },
      { key: "stockCode", label: "股票代码" },
      { key: "stockName", label: "股票名称" },
      { key: "group", label: "组别" },
      { key: "groupRank", label: "组内排名" },
      { key: "player", label: "选手" },
      { key: "status", label: "状态" },
      { key: "yesterdayAmountWan", label: `${previousTradingDate}持仓金额(万)` },
      { key: "todayAmountWan", label: `${date}持仓金额(万)` },
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
    previousTradingDate,
    match: result.match,
    groups: groups.length,
    players: players.length,
    hotStocks: hotStocks.length,
    classificationCount: detailRows.length,
    validation: result.validation,
    outputs: {
      jsonPath,
      summaryCsvPath,
      detailCsvPath,
      holdingTop3CsvPath,
      reportPath,
    },
    currentHoldingTop3: result.currentHoldingTop3,
    stockSummary: stockSummary.map(({ details, ...summary }) => summary),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
