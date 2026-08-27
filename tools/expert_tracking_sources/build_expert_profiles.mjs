#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("outputs");
const DEFAULT_OUT = path.join(ROOT, "expert_tracking", "people_profiles");

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT, date: shanghaiDate(), focus: ["乌江望月"] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--out") args.outDir = path.resolve(value), index += 1;
    else if (key === "--date") args.date = value, index += 1;
    else if (key === "--focus") args.focus.push(value), index += 1;
    else throw new Error(`Unknown argument: ${key}`);
  }
  args.focus = [...new Set(args.focus.filter(Boolean))];
  return args;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function datedFiles(dir, prefix) {
  try {
    return (await fs.readdir(dir))
      .filter((name) => new RegExp(`^${prefix}_\\d{4}-\\d{2}-\\d{2}\\.json$`).test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch { return []; }
}

async function matchingFiles(dir, pattern) {
  try {
    return (await fs.readdir(dir)).filter((name) => pattern.test(name)).sort().map((name) => path.join(dir, name));
  } catch { return []; }
}

async function latestDatedFile(dir, prefix, onOrBefore) {
  const files = await datedFiles(dir, prefix);
  const eligible = files.filter((file) => path.basename(file).slice(prefix.length + 1, prefix.length + 11) <= onOrBefore);
  return eligible.at(-1) || null;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try { return JSON.parse(value); } catch { return []; }
}

function numberValue(value) {
  if (String(value ?? "").includes("*")) return null;
  const normalized = String(value ?? "").replace(/[%,]/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const mean = average(valid);
  return Math.sqrt(valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length);
}

function percent(part, total) {
  return total > 0 ? round(part / total * 100) : null;
}

function boardOf(code) {
  const value = String(code || "");
  if (/^(300|301)/.test(value)) return "创业板";
  if (/^688/.test(value)) return "科创板";
  if (/^(8|4|92)/.test(value)) return "北交所";
  if (/^(600|601|603|605|000|001|002|003)/.test(value)) return "主板";
  return "其他/未识别";
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

function personKey(source, id, name) {
  return `${source}:${id || name}`;
}

function wanzhuSnapshot(data, group, player) {
  const holdings = parseArray(player.today_stock).map((item) => ({
    stockCode: String(item.code || ""), stockName: String(item.name || ""),
    amountWan: numberValue(item.fund) || 0, dailyPnlWan: numberValue(item.money),
  })).filter((item) => item.stockName && item.amountWan > 0 && !/转债|可转债/.test(item.stockName));
  return {
    source: "顽主杯", date: data.date, match: data.match?.name || "", group: group.name,
    rank: numberValue(player.group_rank), personId: String(player.user_id || ""),
    personName: player.username || "", totalAssetsWan: numberValue(player.today_fund),
    investedAmountWan: numberValue(player.today_stock_total), positionPct: numberValue(player.today_cangwei),
    dailyReturnPct: numberValue(player.today_income), totalReturnPct: numberValue(player.total_income),
    platformStyle: Array.isArray(player.style) ? player.style : [player.zq, player.cw, player.df, player.pz].filter(Boolean),
    note: player.experience || "", holdings,
    evidence: "比赛账户结构化披露",
  };
}

function fuliSnapshots(data) {
  const holdingByPerson = new Map();
  for (const stock of data.currentHoldingSummary || []) {
    for (const holder of stock.holders || []) {
      const split = holder.indexOf("-");
      const group = split >= 0 ? holder.slice(0, split) : "";
      const name = split >= 0 ? holder.slice(split + 1) : holder;
      const key = `${group}:${name}`;
      if (!holdingByPerson.has(key)) holdingByPerson.set(key, []);
      holdingByPerson.get(key).push({
        stockCode: stock.stockCode || "", stockName: stock.stockName || "",
        amountWan: stock.holdingCount === 1 ? numberValue(stock.totalAmountWan) : null,
        amountDisclosure: stock.holdingCount === 1 ? "可由单一持有人合计值确定" : "多人合计，个人金额未导出",
      });
    }
  }
  return (data.players || []).map((player) => ({
    source: "复利笔记", date: data.date, match: data.match?.name || "", group: player.group,
    rank: numberValue(player.groupRank), personId: String(player.openId || ""), personName: player.gameName || "",
    totalAssetsWan: null, investedAmountWan: null, positionPct: numberValue(player.todayStockPercent),
    dailyReturnPct: numberValue(player.todayEarningRate), totalReturnPct: numberValue(player.totalEarningRate),
    platformStyle: [], note: "", holdings: player.todayHoldings || holdingByPerson.get(`${player.group}:${player.gameName}`) || [],
    evidence: player.todayHoldings ? "比赛账户结构化披露" : "历史导出中的持有人名单；多人持仓金额不可拆分",
  }));
}

function deriveTransactions(snapshots) {
  const rows = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    if (!Number.isInteger(previous.sourceSequence)
      || !Number.isInteger(current.sourceSequence)
      || current.sourceSequence !== previous.sourceSequence + 1) continue;
    const before = new Map(previous.holdings.map((item) => [item.stockCode || item.stockName, item]));
    const after = new Map(current.holdings.map((item) => [item.stockCode || item.stockName, item]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const from = before.get(key);
      const to = after.get(key);
      let action = "持有";
      let confidence = "低（仅相邻披露日金额变化）";
      if (!from && to) action = "新进", confidence = "高（前无后有）";
      else if (from && !to) action = "卖出/退出", confidence = "高（前有后无）";
      else if (Number.isFinite(from?.amountWan) && Number.isFinite(to?.amountWan) && from.amountWan > 0) {
        const ratio = to.amountWan / from.amountWan;
        if (ratio >= 1.2) action = "疑似加仓";
        else if (ratio <= 0.8) action = "疑似减仓";
        else action = "持有/市值波动";
      }
      rows.push({
        source: current.source, personName: current.personName, personId: current.personId,
        fromDate: previous.date, toDate: current.date, stockCode: to?.stockCode || from?.stockCode || "",
        stockName: to?.stockName || from?.stockName || "", action,
        previousAmountWan: from?.amountWan ?? null, currentAmountWan: to?.amountWan ?? null,
        changeWan: Number.isFinite(from?.amountWan) && Number.isFinite(to?.amountWan)
          ? round(to.amountWan - from.amountWan) : null,
        confidence,
      });
    }
  }
  return rows;
}

function styleAnalysis(snapshots, transactions) {
  const holdingCounts = snapshots.map((item) => item.holdings.length);
  const positionPcts = snapshots.map((item) => item.positionPct).filter(Number.isFinite);
  const concentrations = snapshots.map((item) => {
    const amounts = item.holdings.map((holding) => holding.amountWan).filter(Number.isFinite);
    const total = amounts.reduce((sum, value) => sum + value, 0);
    return total > 0 ? Math.max(...amounts) / total * 100 : null;
  }).filter(Number.isFinite);
  const labels = new Set(snapshots
    .flatMap((item) => item.platformStyle || [])
    .flatMap((item) => String(item).split(/[，,、/]/))
    .map((item) => item.trim())
    .filter(Boolean));
  const avgCount = average(holdingCounts);
  const avgPosition = average(positionPcts);
  const avgTop1 = average(concentrations);
  const switches = transactions.filter((item) => ["新进", "卖出/退出"].includes(item.action)).length;
  const intervals = Math.max(0, snapshots.length - 1);
  const switchRate = intervals ? switches / intervals : null;
  const positionVolatility = standardDeviation(positionPcts);
  const holdingObservations = snapshots.flatMap((item) => item.holdings);
  const stockFrequencyMap = new Map();
  const boardCounts = new Map();
  for (const holding of holdingObservations) {
    const key = holding.stockCode || holding.stockName;
    if (!key) continue;
    const current = stockFrequencyMap.get(key) || {
      stockCode: holding.stockCode || "", stockName: holding.stockName || "", days: 0,
    };
    current.days += 1;
    stockFrequencyMap.set(key, current);
    const board = boardOf(holding.stockCode);
    boardCounts.set(board, (boardCounts.get(board) || 0) + 1);
  }
  const uniqueStocks = stockFrequencyMap.size;
  const repeatObservationRate = percent(Math.max(0, holdingObservations.length - uniqueStocks), holdingObservations.length);
  const boardDistribution = [...boardCounts.entries()]
    .map(([board, count]) => ({ board, count, pct: percent(count, holdingObservations.length) }))
    .sort((a, b) => b.count - a.count);
  const dominantBoard = boardDistribution[0];
  const frequentStocks = [...stockFrequencyMap.values()]
    .sort((a, b) => b.days - a.days || a.stockName.localeCompare(b.stockName, "zh-CN"))
    .slice(0, 5);
  const sampleGrade = snapshots.length >= 15 ? "较高" : snapshots.length >= 8 ? "中等" : snapshots.length >= 5 ? "初步" : "不足";
  const isQualified = snapshots.length >= 5;
  if (avgCount !== null) labels.add(avgCount <= 2 ? "集中持股" : avgCount >= 5 ? "分散持股" : "适度分散");
  if (avgPosition !== null) labels.add(avgPosition >= 90 ? "高仓位" : avgPosition <= 40 ? "低仓位/择时" : "中高仓位");
  if (avgTop1 !== null && avgTop1 >= 55) labels.add("头寸集中");
  if (isQualified && switchRate >= 1.5) labels.add("高换手短线");
  if (isQualified && dominantBoard?.pct >= 40 && dominantBoard.board !== "其他/未识别") labels.add(`${dominantBoard.board}偏好`);

  let tradingStyle = "样本不足，暂不形成稳定交易风格结论。";
  let stockSelectionStyle = "样本不足，暂不形成稳定选股风格结论。";
  if (isQualified) {
    const tempo = switchRate >= 1.5 ? "高频轮动、偏短线" : switchRate >= 0.6 ? "主动轮动、偏波段" : "低换手、偏持有";
    const timing = positionVolatility >= 28 ? "仓位波动大，择时动作明显" : avgPosition >= 85 ? "长期保持高仓位" : avgPosition <= 45 ? "现金仓位较高，重视择时" : "仓位控制中性";
    const concentration = avgTop1 >= 60 ? "单票集中" : avgCount >= 5 ? "分散配置" : "适度集中";
    tradingStyle = `${tempo}；${timing}；${concentration}。`;
    const technique = [...labels].filter((item) => /低吸|接力|首板|半路|打板|趋势|价值|T加0|核按钮/.test(item)).slice(0, 4);
    const boardText = dominantBoard?.pct >= 35 ? `历史持仓以${dominantBoard.board}为主（${dominantBoard.pct}%）` : "板块分布较均衡";
    const reuseText = repeatObservationRate >= 55 ? "会反复跟踪熟悉标的" : "标的轮换较快";
    stockSelectionStyle = `${boardText}；${reuseText}${technique.length ? `；常见手法：${technique.join("、")}` : ""}。`;
  }
  return {
    observationDays: snapshots.length,
    firstDate: snapshots[0]?.date || "", latestDate: snapshots.at(-1)?.date || "",
    averagePositionPct: round(avgPosition), averageHoldingCount: round(avgCount),
    averageTop1ConcentrationPct: round(avgTop1), inferredSwitchEvents: switches,
    switchEventsPerInterval: round(switchRate), positionVolatilityPct: round(positionVolatility),
    fullPositionDayPct: percent(positionPcts.filter((value) => value >= 85).length, positionPcts.length),
    lowPositionDayPct: percent(positionPcts.filter((value) => value <= 30).length, positionPcts.length),
    uniqueStocks, repeatObservationRatePct: repeatObservationRate,
    boardDistribution, frequentStocks, isQualified, sampleGrade,
    tradingStyle, stockSelectionStyle,
    labels: [...labels],
    caveat: isQualified
      ? `基于 ${snapshots.length} 个离散收盘披露日，置信度${sampleGrade}；盘中交易、价格波动和融资会影响推断。`
      : `仅有 ${snapshots.length} 个披露日，低于 5 日门槛；当前只展示事实，不输出稳定风格判断。`,
  };
}

function buildProfiles(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const key = personKey(snapshot.source, snapshot.personId, snapshot.personName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(snapshot);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const byDate = new Map();
    for (const row of rows.sort((a, b) => a.date.localeCompare(b.date))) {
      const existing = byDate.get(row.date);
      byDate.set(row.date, existing ? {
        ...existing,
        ...row,
        rank: row.rank ?? existing.rank,
        group: row.group || existing.group,
        personName: row.personName || existing.personName,
      } : row);
    }
    const history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
      .map((row, index) => ({ ...row, sourceSequence: index }));
    const transactions = deriveTransactions(history);
    const latest = history.at(-1);
    return {
      key, source: latest.source, personId: latest.personId, personName: latest.personName,
      latestSnapshot: latest, history, transactions, style: styleAnalysis(history, transactions),
    };
  }).sort((a, b) => b.style.observationDays - a.style.observationDays || a.personName.localeCompare(b.personName, "zh-CN"));
}

function profileRichness(profile) {
  return {
    observationDays: profile.history?.length || 0,
    transactions: profile.transactions?.length || 0,
    latestDate: profile.latestSnapshot?.date || "",
    holdingRows: (profile.history || []).reduce((sum, snapshot) => sum + (snapshot.holdings?.length || 0), 0),
  };
}

function compareProfileRichness(left, right) {
  const a = profileRichness(left);
  const b = profileRichness(right);
  return b.observationDays - a.observationDays
    || b.transactions - a.transactions
    || b.latestDate.localeCompare(a.latestDate)
    || b.holdingRows - a.holdingRows
    || left.source.localeCompare(right.source, "zh-CN");
}

function dedupeProfilesByName(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const normalizedName = String(profile.personName || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
    const key = normalizedName || profile.key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(profile);
  }
  return [...groups.values()].map((rows) => {
    const ranked = [...rows].sort(compareProfileRichness);
    const selected = ranked[0];
    return {
      ...selected,
      sourceVariants: ranked.map((profile, index) => ({
        source: profile.source,
        personId: profile.personId,
        latestDate: profile.latestSnapshot?.date || null,
        ...profileRichness(profile),
        selected: index === 0,
      })),
      hiddenAlternativeCount: Math.max(0, ranked.length - 1),
    };
  }).sort((a, b) => b.style.observationDays - a.style.observationDays || a.personName.localeCompare(b.personName, "zh-CN"));
}

function stockFrequency(profile) {
  const map = new Map();
  for (const snapshot of profile.history) {
    for (const holding of snapshot.holdings) {
      const key = holding.stockCode || holding.stockName;
      const row = map.get(key) || { stockCode: holding.stockCode, stockName: holding.stockName, days: 0, maxAmountWan: null };
      row.days += 1;
      if (Number.isFinite(holding.amountWan)) row.maxAmountWan = Math.max(row.maxAmountWan || 0, holding.amountWan);
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => b.days - a.days || (b.maxAmountWan || 0) - (a.maxAmountWan || 0));
}

function sourceMatrix(result) {
  return [
    { source: "顽主杯", people: result.sourceStats.wanzhuTrackedPeople ?? result.sourceStats.wanzhuPeople, history: `${result.sourceStats.wanzhuDates} 个收盘日`, holdings: "有，含个股金额（万元）", style: "平台标签 + 交易序列提取" },
    { source: "复利笔记", people: result.sourceStats.fuliPeople, history: `${result.sourceStats.fuliDates} 个收盘日`, holdings: "有；旧导出多人合计时个人金额不可拆", style: "仓位/持股数量/换仓提取" },
    { source: "淘股吧", people: result.tgbPeople.length, history: `${result.sourceStats.tgbPosts} 篇公开文章`, holdings: "多数无结构化持仓；观点与持仓分栏", style: "文章交易措辞与主题提取" },
    { source: "雪球热门组合", people: result.sourceStats.xueqiuPeople, history: "当前公开榜单", holdings: "详情触发验证，暂不绕过", style: "组合说明与收益标签" },
  ];
}

function report(result) {
  const candidates = result.profiles
    .filter((item) => item.style.observationDays >= 5)
    .sort((a, b) => (b.latestSnapshot.totalReturnPct ?? -Infinity) - (a.latestSnapshot.totalReturnPct ?? -Infinity)
      || b.style.observationDays - a.style.observationDays)
    .slice(0, 15);
  const lines = [
    `# 高手跟踪档案库首版（${result.date}）`, "",
    "## 覆盖概览", "",
    "| 信息源 | 明确对象数 | 历史覆盖 | 持仓可用性 | 风格提取 |", "|---|---:|---|---|---|",
    ...sourceMatrix(result).map((row) => `| ${row.source} | ${row.people} | ${row.history} | ${row.holdings} | ${row.style} |`), "",
    "## 已建档的代表性候选人", "",
    "以下按当前披露样本中的累计收益排序，只是研究候选池，不是人员评级或买入建议。", "",
    "| 来源 | 选手 | 披露日数 | 最新累计收益 | 最新仓位 | 最新持股数 | 风格标签 |", "|---|---|---:|---:|---:|---:|---|",
    ...candidates.map((profile) => `| ${profile.source} | ${profile.personName} | ${profile.style.observationDays} | ${profile.latestSnapshot.totalReturnPct ?? "未公开"}% | ${profile.latestSnapshot.positionPct ?? "未公开"}% | ${profile.latestSnapshot.holdings.length} | ${profile.style.labels.slice(0, 4).join("、")} |`), "",
  ];
  for (const name of result.focusNames) {
    const profiles = result.profiles.filter((item) => item.personName === name);
    lines.push(`## 核心跟踪：${name}`, "");
    if (!profiles.length) { lines.push("当前数据中未定位到该选手。", ""); continue; }
    for (const profile of profiles) {
      const latest = profile.latestSnapshot;
      const top = stockFrequency(profile).slice(0, 8);
      lines.push(`- 来源：${profile.source}；ID：${profile.personId}`);
      lines.push(`- 覆盖：${profile.style.firstDate} 至 ${profile.style.latestDate}，${profile.style.observationDays} 个披露日`);
      lines.push(`- 最新总资产：${latest.totalAssetsWan ?? "未公开"} 万元；仓位：${latest.positionPct ?? "未公开"}%；累计收益：${latest.totalReturnPct ?? "未公开"}%`);
      lines.push(`- 风格标签：${profile.style.labels.join("、") || "样本不足"}`);
      lines.push(`- 样本统计：平均持股 ${profile.style.averageHoldingCount ?? "-"} 只，平均仓位 ${profile.style.averagePositionPct ?? "-"}%，前一大平均集中度 ${profile.style.averageTop1ConcentrationPct ?? "-"}%`);
      lines.push(`- 最新自述：${latest.note || "无"}`, "");
      lines.push("### 最近持仓", "", "| 股票 | 代码 | 金额(万元) | 当日盈亏(万元) |", "|---|---|---:|---:|");
      if (!latest.holdings.length) lines.push("| 空仓/未披露 | | | |");
      for (const holding of latest.holdings) lines.push(`| ${holding.stockName} | ${holding.stockCode} | ${holding.amountWan ?? "未拆分"} | ${holding.dailyPnlWan ?? ""} |`);
      lines.push("", "### 历史高频持仓", "", "| 股票 | 代码 | 出现披露日数 | 最大披露金额(万元) |", "|---|---|---:|---:|");
      for (const stock of top) lines.push(`| ${stock.stockName} | ${stock.stockCode} | ${stock.days} | ${stock.maxAmountWan ?? "未拆分"} |`);
      lines.push("");
    }
    if (profiles.length > 1) lines.push("> 同名跨平台账号暂未完成身份核验，以上档案保持分离，不能直接视为同一自然人。", "");
  }
  lines.push("## 给基金经理的使用方法", "",
    "1. 先以比赛账户的结构化持仓和完整交易序列作为高置信事实层。",
    "2. 再用淘股吧/雪球等公开观点解释其题材偏好与交易理由，不把发帖提及直接当成持仓。",
    "3. 建议只把高手信号用于候选池、交易拥挤度和风格轮动参考；下单前仍需基本面、流动性、合规与风险预算复核。", "",
    "## 数据限制", "",
    "- 顽主杯与复利笔记均对网站已建档选手按 ID 回填当前赛季公开报单，不代表选手完整职业生涯。",
    "- 相邻收盘日从无到有/从有到无可较可靠识别新进与卖出/退出；金额变化可能混入价格波动，因此只标为疑似加减仓。",
    "- 登录、付费、验证码或非公开数据不绕过；受限字段保留不可得状态。", "");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [wanzhuFiles, fuliFiles] = await Promise.all([
    datedFiles(path.join(ROOT, "wanzhu"), "wanzhu"), datedFiles(path.join(ROOT, "fuli"), "fuli"),
  ]);
  const snapshots = [];
  for (let fileIndex = 0; fileIndex < wanzhuFiles.length; fileIndex += 1) {
    const file = wanzhuFiles[fileIndex];
    const data = await readJson(file);
    for (const group of data.groups || []) for (const player of group.players || []) {
      snapshots.push({ ...wanzhuSnapshot(data, group, player), sourceSequence: fileIndex });
    }
  }
  for (let fileIndex = 0; fileIndex < fuliFiles.length; fileIndex += 1) {
    snapshots.push(...fuliSnapshots(await readJson(fuliFiles[fileIndex])).map((item) => ({ ...item, sourceSequence: fileIndex })));
  }
  const wanzhuArchiveFiles = await matchingFiles(path.join(ROOT, "expert_tracking", "competition_history", "wanzhu"), /^[^.]+\.json$/);
  const wanzhuArchiveDates = new Set();
  for (const file of wanzhuArchiveFiles) {
    const archive = await readJson(file);
    for (const snapshot of archive.snapshots || []) wanzhuArchiveDates.add(snapshot.date);
    // Direct histories are appended after ranking snapshots so their complete
    // disclosure replaces the abbreviated leaderboard row on duplicate dates.
    snapshots.push(...(archive.snapshots || []));
  }
  const fuliArchiveFiles = await matchingFiles(path.join(ROOT, "expert_tracking", "competition_history", "fuli"), /^[^.]+\.json$/);
  const fuliArchiveDates = new Set();
  for (const file of fuliArchiveFiles) {
    const archive = await readJson(file);
    for (const snapshot of archive.snapshots || []) fuliArchiveDates.add(snapshot.date);
    snapshots.push(...(archive.snapshots || []));
  }
  const profiles = dedupeProfilesByName(buildProfiles(snapshots));

  const tgbFile = await latestDatedFile(path.join(ROOT, "expert_tracking", "tgb_people"), "tgb_people", args.date);
  const publicSourcesFile = await latestDatedFile(path.join(ROOT, "expert_tracking"), "public_sources", args.date);
  let tgbPeople = [];
  if (tgbFile) {
    try { tgbPeople = (await readJson(tgbFile)).people || []; } catch {}
  }
  let publicSources = {};
  if (publicSourcesFile) {
    try { publicSources = await readJson(publicSourcesFile); } catch {}
  }

  const result = {
    generatedAt: new Date().toISOString(), date: args.date, focusNames: args.focus,
    profiles, tgbPeople,
    sourceStats: {
      wanzhuDates: Math.max(wanzhuFiles.length, wanzhuArchiveDates.size), fuliDates: Math.max(fuliFiles.length, fuliArchiveDates.size),
      wanzhuPeople: profiles.filter((item) => item.source === "顽主杯").length,
      wanzhuTrackedPeople: wanzhuArchiveFiles.length,
      fuliPeople: profiles.filter((item) => item.source === "复利笔记").length,
      tgbPosts: tgbPeople.reduce((sum, person) => sum + person.posts.length, 0),
      xueqiuPeople: publicSources.xueqiu?.portfolios?.length || 0,
      tgbSourceDate: tgbFile ? path.basename(tgbFile).slice(11, 21) : null,
      publicSourcesDate: publicSourcesFile ? path.basename(publicSourcesFile).slice(15, 25) : null,
    },
  };
  await fs.mkdir(args.outDir, { recursive: true });
  const prefix = path.join(args.outDir, `expert_profiles_${args.date}`);
  const holdingRows = profiles.flatMap((profile) => profile.history.flatMap((snapshot) => snapshot.holdings.map((holding) => ({
    source: profile.source, personName: profile.personName, personId: profile.personId, date: snapshot.date,
    group: snapshot.group, rank: snapshot.rank, positionPct: snapshot.positionPct,
    stockCode: holding.stockCode, stockName: holding.stockName, amountWan: holding.amountWan,
    dailyPnlWan: holding.dailyPnlWan ?? null, evidence: snapshot.evidence,
  }))));
  const transactionRows = profiles.flatMap((profile) => profile.transactions);
  const styleRows = profiles.map((profile) => ({
    source: profile.source, personName: profile.personName, personId: profile.personId,
    ...profile.style,
    labels: profile.style.labels.join("、"),
    boardDistributionText: profile.style.boardDistribution.map((item) => `${item.board}:${item.pct}%`).join("、"),
    frequentStocksText: profile.style.frequentStocks.map((item) => `${item.stockName}(${item.days}日)`).join("、"),
  }));
  await Promise.all([
    fs.writeFile(`${prefix}.json`, JSON.stringify(result, null, 2), "utf8"),
    fs.writeFile(`${prefix}_holdings.csv`, "\ufeff" + toCsv(holdingRows, [
      ["来源", "source"], ["选手", "personName"], ["选手ID", "personId"], ["日期", "date"],
      ["组别", "group"], ["排名", "rank"], ["仓位%", "positionPct"], ["代码", "stockCode"],
      ["股票", "stockName"], ["持仓金额(万)", "amountWan"], ["当日盈亏(万)", "dailyPnlWan"], ["证据口径", "evidence"],
    ]), "utf8"),
    fs.writeFile(`${prefix}_transactions.csv`, "\ufeff" + toCsv(transactionRows, [
      ["来源", "source"], ["选手", "personName"], ["选手ID", "personId"], ["前一披露日", "fromDate"],
      ["当前披露日", "toDate"], ["代码", "stockCode"], ["股票", "stockName"], ["动作", "action"],
      ["前金额(万)", "previousAmountWan"], ["当前金额(万)", "currentAmountWan"], ["变化(万)", "changeWan"], ["置信度", "confidence"],
    ]), "utf8"),
    fs.writeFile(`${prefix}_styles.csv`, "\ufeff" + toCsv(styleRows, [
      ["来源", "source"], ["选手", "personName"], ["选手ID", "personId"], ["首日", "firstDate"], ["最新日", "latestDate"],
      ["观察日数", "observationDays"], ["平均仓位%", "averagePositionPct"], ["平均持股数", "averageHoldingCount"],
      ["前一大平均集中度%", "averageTop1ConcentrationPct"], ["换入换出事件", "inferredSwitchEvents"],
      ["每期换入换出", "switchEventsPerInterval"], ["仓位波动%", "positionVolatilityPct"],
      ["高仓位日占比%", "fullPositionDayPct"], ["低仓位日占比%", "lowPositionDayPct"],
      ["历史独立股票数", "uniqueStocks"], ["重复持仓观察占比%", "repeatObservationRatePct"],
      ["风格样本达标", "isQualified"], ["风格置信度", "sampleGrade"],
      ["交易风格", "tradingStyle"], ["选股风格", "stockSelectionStyle"],
      ["板块分布", "boardDistributionText"], ["高频持仓", "frequentStocksText"],
      ["风格标签", "labels"], ["限制", "caveat"],
    ]), "utf8"),
    fs.writeFile(`${prefix}_report.md`, report(result), "utf8"),
  ]);
  console.log(JSON.stringify({ prefix, sourceStats: result.sourceStats, focusFound: profiles.filter((item) => args.focus.includes(item.personName)).map((item) => `${item.source}:${item.personName}`) }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
