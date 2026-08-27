const trackerRoot = document.querySelector(".tracker-embed");
const state = {
  profiles: [], publicSources: {}, experts: [], selectedKey: "", expertSource: "全部", query: "", ranking: "consensus", rankings: {},
  forecast: null, asOfDate: "", detailOpen: false,
  dataBaseUrl: trackerRoot?.dataset.dataBase || new URL("./data/", import.meta.url).href,
};
const $ = (selector, root = trackerRoot) => root?.querySelector(selector) || null;
const $$ = (selector, root = trackerRoot) => root ? [...root.querySelectorAll(selector)] : [];

function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function num(value, digits = 2) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—"; }
function pct(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${num(value)}%` : "—"; }
function shortDate(value) { return String(value || "—").slice(0, 10); }
function isStaleExpert(expert) {
  const disclosed = shortDate(expert?.latestSnapshot?.date);
  const asOf = shortDate(state.asOfDate);
  return /^20\d{2}-\d{2}-\d{2}$/.test(asOf) && (!/^20\d{2}-\d{2}-\d{2}$/.test(disclosed) || disclosed < asOf);
}
function tradeTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !String(value).includes("T")) return shortDate(value);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}
function normName(value) { return String(value || "").normalize("NFKC").replace(/^XD/i, "").replaceAll(/\s+/g, "").toUpperCase(); }
function normCode(value) { return String(value || "").replace(/^(SH|SZ|BJ)/i, "").match(/\d{6}/)?.[0] || ""; }
async function loadJson(file) {
  const url = new URL(String(file).replace(/^\.\/data\//, ""), state.dataBaseUrl);
  url.searchParams.set("t", Date.now());
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} HTTP ${response.status}`);
  return response.json();
}

function currentCompetitionProfiles(profiles) {
  const latest = {};
  for (const profile of profiles) latest[profile.source] = [latest[profile.source] || "", profile.latestSnapshot?.date || ""].sort().at(-1);
  return profiles.filter((profile) => profile.latestSnapshot?.date === latest[profile.source]);
}

function rawPositionRows(profiles, publicSources) {
  const rows = [];
  for (const profile of currentCompetitionProfiles(profiles)) for (const holding of profile.latestSnapshot?.holdings || []) rows.push({
    platform: profile.source, holder: profile.personName, code: normCode(holding.stockCode), name: holding.stockName,
    amountWan: Number.isFinite(Number(holding.amountWan)) ? Number(holding.amountWan) : null, weightPct: null,
  });
  for (const portfolio of publicSources.xueqiu?.portfolios || []) for (const holding of portfolio.currentHoldings || []) rows.push({
    platform: "雪球", holder: `${portfolio.manager}·${portfolio.name}`, code: normCode(holding.stockCode), name: holding.stockName,
    amountWan: null, weightPct: Number.isFinite(Number(holding.weightPct)) ? Number(holding.weightPct) : null,
  });
  const codeByName = new Map(rows.filter((row) => row.code).map((row) => [normName(row.name), row.code]));
  return rows.map((row) => ({ ...row, key: row.code || codeByName.get(normName(row.name)) || `N:${normName(row.name)}` }));
}

function aggregatePositions(rows) {
  const map = new Map();
  for (const row of rows) {
    const item = map.get(row.key) || { key: row.key, code: row.code, name: row.name, platforms: new Set(), holders: new Set(), amountWan: 0, amountCount: 0, weightPct: 0, weightCount: 0 };
    if (!item.code && row.code) item.code = row.code;
    item.platforms.add(row.platform); item.holders.add(`${row.platform}-${row.holder}`);
    if (row.amountWan !== null) item.amountWan += row.amountWan, item.amountCount += 1;
    if (row.weightPct !== null) item.weightPct += row.weightPct, item.weightCount += 1;
    map.set(row.key, item);
  }
  return [...map.values()].map((item) => ({
    ...item, platforms: [...item.platforms], holders: [...item.holders], platformCount: item.platforms.size, holderCount: item.holders.size,
  })).sort((a, b) => b.platformCount - a.platformCount || b.holderCount - a.holderCount || b.amountWan - a.amountWan || a.name.localeCompare(b.name, "zh-CN"));
}

function makeXueqiuExpert(item) {
  const style = item.styleProfile || {};
  const rebalanceMap = new Map();
  for (const record of [...(item.localRebalances || []), ...(item.recentRebalances || [])]) rebalanceMap.set(record.id || `${record.createdAt}:${record.category}`, record);
  const transactions = [...rebalanceMap.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).flatMap((record) => (record.trades || []).map((trade) => ({
    fromDate: record.createdAt, toDate: record.createdAt, stockCode: normCode(trade.stockCode), stockName: trade.stockName,
    action: trade.action, previousAmountWan: null, currentAmountWan: null, changeWan: null,
    previousWeightPct: trade.previousWeightPct, targetWeightPct: trade.targetWeightPct, tradePrice: trade.price,
    rebalanceId: record.id, rebalanceCategory: record.category, confidence: "公开组合调仓",
  })));
  return {
    key: `雪球:${item.symbol}`, source: "雪球", personId: item.symbol, personName: `${item.manager} · ${item.name}`,
    latestSnapshot: { date: shortDate(item.holdingSnapshotAt), match: "公开模拟组合", group: item.market || "沪深", totalAssetsWan: null, positionPct: Number.isFinite(Number(item.cashPct)) ? 100 - Number(item.cashPct) : null, totalReturnPct: item.totalGain, holdings: (item.currentHoldings || []).map((holding) => ({ ...holding, amountWan: null })) },
    history: item.localHistory || [], transactions,
    style: { observationDays: item.localHistory?.length || 1, sampleGrade: "公开组合", isQualified: true, tradingStyle: style.tradeStyle, stockSelectionStyle: style.stockSelectionStyle, labels: style.labels || [], averagePositionPct: Number.isFinite(Number(item.cashPct)) ? 100 - Number(item.cashPct) : null, averageHoldingCount: style.holdingCount, averageTop1ConcentrationPct: style.top3WeightPct, inferredSwitchEvents: transactions.filter((row) => /买入|卖出/.test(row.action)).length, caveat: "雪球公开模拟组合，不等同于主理人真实证券账户。" },
    recommendation: item.publicRecommendation || "未公开组合说明。", isXueqiu: true,
  };
}

function buildExpertUniverse(profiles, publicSources) {
  return [
    ...profiles,
    ...(publicSources.xueqiu?.portfolios || []).map(makeXueqiuExpert),
  ].filter((expert) => (expert.transactions || []).length > 0).sort((a, b) => {
    if (a.personName === "乌江望月" && b.personName !== "乌江望月") return -1;
    if (b.personName === "乌江望月" && a.personName !== "乌江望月") return 1;
    if (a.personName === "乌江望月" && b.personName === "乌江望月") {
      return String(b.latestSnapshot?.date || "").localeCompare(String(a.latestSnapshot?.date || ""));
    }
    if (a.source === "雪球" && b.source === "雪球") return (b.transactions?.length || 0) - (a.transactions?.length || 0) || (b.latestSnapshot?.holdings?.length || 0) - (a.latestSnapshot?.holdings?.length || 0);
    return (b.style?.observationDays || 0) - (a.style?.observationDays || 0) || a.personName.localeCompare(b.personName, "zh-CN");
  });
}

function renderRanking() {
  const isConsensus = state.ranking === "consensus";
  const all = isConsensus ? state.rankings.consensus.filter((row) => row.platformCount >= 2) : state.rankings[state.ranking] || [];
  const rows = all.slice(0, 15);
  const holderTotal = all.reduce((sum, row) => sum + row.holderCount, 0);
  const crossCount = state.rankings.consensus.filter((row) => row.platformCount >= 2).length;
  const platformCount = new Set(all.flatMap((row) => row.platforms)).size;
  $("#rankSummary").innerHTML = [
    [isConsensus ? "共识股票" : "上榜股票", isConsensus ? crossCount : all.length, isConsensus ? "至少两个平台同时持有" : "当前可识别持仓"],
    ["覆盖平台", platformCount, "具有股票身份的数据源"],
    ["持有关系", holderTotal, "选手/组合与股票关系"],
    ["榜单显示", Math.min(15, all.length), `共 ${all.length} 只`],
  ].map(([label, value, note]) => `<div><span>${esc(label)}</span><strong>${num(value, 0)}</strong><small>${esc(note)}</small></div>`).join("");
  $("#rankingRows").innerHTML = rows.length ? rows.map((row, index) => `<div class="rank-row">
    <div class="stock-identity"><b class="rank-no">${index + 1}</b><span><strong>${esc(row.name)}</strong><small>${esc(row.code || "代码未披露")}</small></span></div>
    <span class="platform-badges">${row.platforms.map((platform) => `<i>${esc(platform)}</i>`).join("")}</span>
    <span class="holder-count">${row.holderCount}</span>
    <span class="exposure"><strong>${row.amountCount ? `${num(row.amountWan)} 万元` : "金额未披露"}</strong><small>${row.weightCount ? `雪球合计权重 ${num(row.weightPct, 1)}%` : "结构化收盘持仓"}</small></span>
    <span class="holder-names">${esc(row.holders.slice(0, 5).join("、"))}${row.holders.length > 5 ? ` 等${row.holders.length}人` : ""}</span>
  </div>`).join("") : '<div class="empty">当前口径没有可识别持仓。</div>';
  $("#rankingBoundary").textContent = isConsensus
    ? "共识榜按覆盖平台数优先、持有人数次优排序；只合并具有明确股票名称或代码的公开持仓。"
    : `${state.ranking}榜按持有人数优先、披露敞口次优排序；仅使用该平台最近有效披露日。`;
  $$(".rank-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.ranking === state.ranking));
}

function renderFilters() {
  const sources = ["全部", "顽主杯", "复利笔记", "雪球"];
  $("#sourceFilters").innerHTML = sources.map((source) => `<button class="source-filter ${state.expertSource === source ? "is-active" : ""}" data-source="${esc(source)}" type="button">${esc(source)}</button>`).join("");
  $$(".source-filter").forEach((button) => button.addEventListener("click", () => {
    state.expertSource = button.dataset.source;
    const visible = filteredExperts();
    if (!visible.some((expert) => expert.key === state.selectedKey)) state.selectedKey = visible[0]?.key || "";
    renderFilters(); renderExpertList(); renderDossier();
  }));
}

function accuracyText(accuracy, emptyText = "等待盲测") {
  if (!accuracy || !Number(accuracy.sampleCount)) return emptyText;
  return `${num(accuracy.precisionAt5Pct, 1)}% · ${accuracy.sampleCount}次`;
}

function renderForecast() {
  const forecast = state.forecast;
  if (!forecast?.available) {
    $("#forecastStatus").textContent = forecast?.message || "预测账本等待建立";
    $("#forecastSummary").innerHTML = '<div><span>运行状态</span><strong>等待数据</strong><small>不会使用空数据生成预测</small></div>';
    $("#forecastRows").innerHTML = '<div class="empty">当前没有可展示的冻结预测。</div>';
    $("#participantWatchlist").innerHTML = '<div class="empty">观察名单正在建立。</div>';
    return;
  }
  const summary = forecast.summary || {};
  const runLabel = forecast.run?.scoreEligible === false ? "试运行 · 不计入准确率" : forecast.status === "evaluated" ? "已核验" : forecast.status === "partially_evaluated" ? "部分核验" : "正式预测已冻结";
  $("#forecastStatus").innerHTML = `<i></i><span>${esc(forecast.run?.targetDate || "—")} 目标日 · ${esc(runLabel)}</span>`;
  $("#forecastSummary").innerHTML = [
    ["正式预测", summary.expertCount || 0, `${summary.predictionCount || 0}只概率候选`],
    ["历史近期风格基线", summary.historicalPrecisionAt5Pct == null ? "—" : `${num(summary.historicalPrecisionAt5Pct, 1)}%`, `${summary.historicalSampleCount || 0}次历史截面`],
    ["真实盲测准确度", summary.livePrecisionAt5Pct == null ? "待首批核验" : `${num(summary.livePrecisionAt5Pct, 1)}%`, `${summary.liveSampleCount || 0}次已公布结果`],
    ["名单状态", `${summary.lifecycleCounts?.active || 0}/${summary.lifecycleCounts?.probation || 0}`, "正式 / 观察"],
  ].map(([label, value, note]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
  $("#forecastRows").innerHTML = (forecast.experts || []).map((expert) => `<article class="forecast-row">
    <div class="forecast-person"><strong>${esc(expert.expertName)}</strong><small>${esc(expert.source)} · 近期风格基线 ${accuracyText(expert.historicalAccuracy, "样本不足")}<br>真实盲测 ${accuracyText(expert.liveAccuracy)}</small></div>
    <div class="forecast-picks">${(expert.predictions || []).map((pick) => `<span class="${pick.currentHolding ? "is-retention" : ""}" title="${esc((pick.reasons || []).join("；"))}"><b>${esc(pick.stockName)}</b><i>${num(pick.probabilityPct, 1)}%</i></span>`).join("")}</div>
    <div class="forecast-data-state"><b>${esc(expert.status === "active" ? "正式" : expert.status)}</b><small>${esc(expert.latestHoldingDate || "—")}<br>映射 ${num(expert.mappingPct, 1)}%</small></div>
  </article>`).join("") || '<div class="empty">当前没有正式预测选手。</div>';
  const watch = (forecast.participants || []).filter((item) => item.status !== "active");
  $("#participantWatchlist").innerHTML = watch.slice(0, 10).map((item) => `<article class="watch-row"><div><strong>${esc(item.expertName)}</strong><small>${esc(item.source)} · 收益 ${pct(item.totalReturnPct)}</small></div><span class="status-${esc(item.status)}">${esc(item.status === "probation" ? `观察 ${item.qualifyingStreak}/3` : item.status === "paused" ? "暂停" : item.status === "retired" ? "退出" : "候选")}</span><p>${esc(item.reason)}</p></article>`).join("") || '<div class="empty">暂无观察或暂停对象。</div>';
  const aiPolicy = forecast.continuity?.aiPolicy;
  $("#forecastBoundary").textContent = `更新顺序：${(forecast.continuity?.updateOrder || []).join(" → ")}。核心预测AI=${aiPolicy?.predictionProvider || "none"}；如增加解释，只允许 ${aiPolicy?.allowedOptionalProvider || "deepseek-chat"}。预测不可覆盖，缺失持仓不当成空仓。仅供模型验证，不构成投资建议。`;
}

function filteredExperts() {
  const query = state.query.trim().toLowerCase();
  return state.experts.filter((expert) => (state.expertSource === "全部" || expert.source === state.expertSource)
    && (!query || [expert.personName, expert.personId, expert.source, ...(expert.style?.labels || [])].join(" ").toLowerCase().includes(query)));
}

function renderExpertList() {
  const experts = filteredExperts();
  $("#expertList").innerHTML = experts.map((expert, index) => `<button class="expert-option ${expert.key === state.selectedKey && state.detailOpen ? "is-active" : ""} ${isStaleExpert(expert) ? "is-stale" : ""}" data-key="${esc(expert.key)}" type="button" role="option" aria-selected="${expert.key === state.selectedKey && state.detailOpen}"><b class="expert-place">${String(index + 1).padStart(2,"0")}</b><span><strong>${esc(expert.personName)}${isStaleExpert(expert) ? '<i class="stale-badge">非最近披露日</i>' : ""}</strong><small>${esc(expert.source)} · 披露 ${esc(shortDate(expert.latestSnapshot?.date))} · ${expert.style?.observationDays || 0}个观察日</small></span><em class="expert-return ${Number(expert.latestSnapshot?.totalReturnPct) >= 0 ? "positive" : "negative"}">${pct(expert.latestSnapshot?.totalReturnPct)}<small>累计收益</small></em></button>`).join("") || '<div class="empty">没有匹配的选手或组合。</div>';
  $$(".expert-option").forEach((button) => button.addEventListener("click", () => { state.selectedKey = button.dataset.key; state.detailOpen = true; renderExpertList(); renderDossier(); }));
}

function chartSvg(history) {
  const rows = history.filter((row) => Number.isFinite(Number(row.totalReturnPct)) || Number.isFinite(Number(row.positionPct)));
  if (rows.length < 2) return '<div class="empty">历史快照正在积累。</div>';
  const width = 720, height = 180, left = 34, right = 10, top = 12, bottom = 24;
  const returns = rows.map((row) => Number(row.totalReturnPct)).filter(Number.isFinite);
  const min = Math.min(...returns, 0), max = Math.max(...returns, 0), span = max - min || 1;
  const x = (index) => left + index / Math.max(1, rows.length - 1) * (width - left - right);
  const yReturn = (value) => top + (max - value) / span * (height - top - bottom);
  const yPosition = (value) => top + (120 - Math.max(0, Math.min(120, value))) / 120 * (height - top - bottom);
  const pathFor = (field, y) => rows.map((row, index) => Number.isFinite(Number(row[field])) ? `${index ? "L" : "M"}${x(index).toFixed(1)},${y(Number(row[field])).toFixed(1)}` : "").filter(Boolean).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="收益与仓位历史"><line class="chart-grid" x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}"/><line class="chart-grid" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"/><line class="chart-grid" x1="${left}" y1="${top+(height-top-bottom)/2}" x2="${width-right}" y2="${top+(height-top-bottom)/2}"/><path class="chart-return" d="${pathFor("totalReturnPct", yReturn)}"/><path class="chart-position" d="${pathFor("positionPct", yPosition)}"/><text class="chart-label" x="${left}" y="${height-6}">${esc(shortDate(rows[0].date).slice(5))}</text><text class="chart-label" text-anchor="end" x="${width-right}" y="${height-6}">${esc(shortDate(rows.at(-1).date).slice(5))}</text><text class="chart-label" x="2" y="${top+4}">${num(max,1)}%</text><text class="chart-label" x="2" y="${height-bottom}">${num(min,1)}%</text></svg>`;
}

function renderDossier() {
  const layout = $(".expert-layout");
  const dossier = $("#expertDossier");
  layout?.classList.toggle("is-detail-open", state.detailOpen);
  if (dossier) dossier.hidden = !state.detailOpen;
  if (!state.detailOpen) { if (dossier) dossier.replaceChildren(); return; }
  const expert = state.experts.find((item) => item.key === state.selectedKey) || state.experts[0];
  if (!expert) return;
  const latest = expert.latestSnapshot || {}, style = expert.style || {};
  const holdings = [...(latest.holdings || [])].sort((a, b) => (Number(b.amountWan) || Number(b.weightPct) || 0) - (Number(a.amountWan) || Number(a.weightPct) || 0));
  const allTrades = [...(expert.transactions || [])].reverse();
  const trades = expert.isXueqiu ? allTrades : allTrades.slice(0, 14);
  const tradeStyle = style.tradingStyle || style.tradeStyle || "样本不足，暂不输出稳定交易风格。";
  const stockStyle = style.stockSelectionStyle || "选股风格待积累。";
  const forecast = state.forecast?.experts?.find((item) => item.expertKey === expert.key);
  const tradeDetail = (trade) => {
    if (Number.isFinite(Number(trade.previousWeightPct)) || Number.isFinite(Number(trade.targetWeightPct)) || Number.isFinite(Number(trade.tradePrice))) {
      const weights = `${Number.isFinite(Number(trade.previousWeightPct)) ? `${num(trade.previousWeightPct, 2)}%` : "新进"} → ${Number.isFinite(Number(trade.targetWeightPct)) ? `${num(trade.targetWeightPct, 2)}%` : "退出"}`;
      return `${weights}${Number.isFinite(Number(trade.tradePrice)) ? `<br><small>成交价 ${num(trade.tradePrice, 2)}</small>` : ""}`;
    }
    if (Number.isFinite(Number(trade.transactionAmountWan))) return `成交 ${num(trade.transactionAmountWan)}万`;
    if (Number.isFinite(Number(trade.previousAmountWan))) return `前值 ${num(trade.previousAmountWan)}万`;
    return "—";
  };
  $("#expertDossier").innerHTML = `${isStaleExpert(expert) ? `<div class="stale-notice">该选手最新可验证披露日为 ${esc(shortDate(latest.date))}，早于本页数据日 ${esc(shortDate(state.asOfDate))}；未披露不等同于空仓，且该快照不进入当前持仓排行榜。</div>` : ""}<header class="dossier-hero"><div><span class="section-code">${esc(expert.source)} / VERIFIED PROFILE</span><h3>${esc(expert.personName)}</h3><p>披露日 ${esc(shortDate(latest.date))} · ID ${esc(expert.personId || "未公开")} · ${esc(latest.group || latest.match || "公开组合")}</p></div><div class="dossier-head-actions"><b class="dossier-grade">${esc(style.sampleGrade || "档案")}</b><button class="dossier-close" type="button">返回选手榜</button></div></header>
    <div class="dossier-kpis"><div><span>累计收益</span><strong>${pct(latest.totalReturnPct)}</strong></div><div><span>最新仓位</span><strong>${Number.isFinite(Number(latest.positionPct)) ? `${num(latest.positionPct,1)}%` : "—"}</strong></div><div><span>观察日数</span><strong>${style.observationDays || 0}</strong></div><div><span>当前持股</span><strong>${holdings.length}</strong></div></div>
    ${forecast ? `<section class="dossier-forecast"><header><div><span>下一披露日预测</span><strong>${esc(state.forecast.run?.targetDate || "—")}</strong></div><div><span>历史近期风格基线</span><strong>${accuracyText(forecast.historicalAccuracy, "样本不足")}</strong></div><div><span>真实盲测准确度</span><strong>${accuracyText(forecast.liveAccuracy)}</strong></div></header><div>${forecast.predictions.map((pick) => `<article><b>${pick.rank}</b><span><strong>${esc(pick.stockName)}</strong><small>${esc(pick.stockCode)}${pick.currentHolding ? " · 续持候选" : " · 新进候选"}</small></span><i>${num(pick.probabilityPct,1)}%</i></article>`).join("")}</div></section>` : ""}
    <div class="dossier-grid">
      <section class="dossier-panel"><h4>收益与仓位轨迹</h4><div class="history-chart">${chartSvg(expert.history || [])}</div></section>
      <section class="dossier-panel"><h4>策略风格</h4><div class="style-verdict"><strong>${esc(tradeStyle)}</strong><p>${esc(stockStyle)}</p></div><div class="style-tags">${(style.labels || []).map((tag) => `<span>${esc(tag)}</span>`).join("") || "<span>待积累</span>"}</div><div class="style-stats"><div><span>平均仓位</span><strong>${Number.isFinite(Number(style.averagePositionPct)) ? `${num(style.averagePositionPct,1)}%` : "—"}</strong></div><div><span>平均持股</span><strong>${num(style.averageHoldingCount,1)}只</strong></div><div><span>集中度</span><strong>${Number.isFinite(Number(style.averageTop1ConcentrationPct)) ? `${num(style.averageTop1ConcentrationPct,1)}%` : "—"}</strong></div><div><span>换入换出</span><strong>${num(style.inferredSwitchEvents,0)}</strong></div></div></section>
      <section class="dossier-panel dossier-wide split-detail">
        <div><h4>当前持仓</h4>${holdings.length ? `<table class="holding-table"><thead><tr><th>股票</th><th>代码</th><th>金额/权重</th><th>买入标记</th></tr></thead><tbody>${holdings.map((holding) => `<tr><td><strong>${esc(holding.stockName)}</strong></td><td>${esc(normCode(holding.stockCode) || "—")}</td><td>${Number.isFinite(Number(holding.amountWan)) ? `${num(holding.amountWan)}万` : Number.isFinite(Number(holding.weightPct)) ? `${num(holding.weightPct,1)}%` : "—"}</td><td>${holding.buyTime ? `${esc(shortDate(holding.buyTime))}<br><small>${esc(holding.buyTimeEvidence || "")}</small>` : "—"}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">当前空仓或未披露持仓。</div>'}</div>
        <div><h4>最近买卖${expert.isXueqiu ? ` · ${expert.transactions.length}笔调仓` : ""}</h4>${trades.length ? `<div class="${expert.isXueqiu ? "trade-scroll" : ""}"><table class="trade-table"><thead><tr><th>确认时间</th><th>动作</th><th>股票</th><th>交易细节</th></tr></thead><tbody>${trades.map((trade) => `<tr><td>${esc(tradeTime(trade.toDate || trade.fromDate))}</td><td class="${/卖出|退出|减仓/.test(trade.action) ? "trade-sell" : /买入|新进|加仓/.test(trade.action) ? "trade-buy" : ""}">${esc(trade.action)}</td><td>${esc(trade.stockName || trade.stockCode || "—")}</td><td>${tradeDetail(trade)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${expert.isXueqiu ? "该公开组合当前没有可回溯的逐笔调仓记录；持仓快照仍保留。" : "暂没有连续披露日可推断买卖。"}</div>`}</div>
      </section>
    </div>`;
  $(".dossier-close")?.addEventListener("click", () => { state.detailOpen = false; renderExpertList(); renderDossier(); $("#expertTitle")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
}

async function init() {
  try {
    const [profiles, publicSources, updateStatus, forecast] = await Promise.all([
      loadJson("./data/expert_profiles.json"),
      loadJson("./data/public_sources.json"),
      loadJson("./data/update_status.json").catch(() => null),
      fetch("/api/expert-next-holding", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]);
    state.profiles = profiles.profiles || []; state.publicSources = publicSources; state.forecast = forecast; state.asOfDate = profiles.date || publicSources.date || "";
    const raw = rawPositionRows(state.profiles, publicSources);
    state.rankings.consensus = aggregatePositions(raw);
    for (const platform of ["顽主杯", "复利笔记", "雪球"]) state.rankings[platform] = aggregatePositions(raw.filter((row) => row.platform === platform));
    state.experts = buildExpertUniverse(state.profiles, publicSources);
    state.selectedKey = state.experts.find((item) => item.personName === "乌江望月")?.key || state.experts[0]?.key || "";
    $("#asOfDate").textContent = profiles.date || publicSources.date || "—";
    const healthText = updateStatus?.overall === "degraded" ? " · 部分来源沿用最近有效数据" : updateStatus?.overall === "failed" ? " · 更新异常" : "";
    $("#coverageText").textContent = `${state.experts.length} 个选手/组合 · ${state.rankings.consensus.filter((row) => row.platformCount >= 2).length} 只跨平台共识股${healthText}`;
    renderRanking(); renderForecast(); renderFilters(); renderExpertList(); renderDossier();
  } catch (error) {
    trackerRoot?.dispatchEvent(new CustomEvent("expert-tracker-error", { bubbles: true, detail: { phase: "data-load", message: String(error?.message || error) } }));
    $("#coverageText").textContent = "数据载入失败"; $("#rankingRows").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

$$('.rank-tab').forEach((button) => button.addEventListener('click', () => { state.ranking = button.dataset.ranking; renderRanking(); }));
$("#expertSearch")?.addEventListener("input", (event) => {
  state.query = event.target.value;
  const visible = filteredExperts();
  if (!visible.some((expert) => expert.key === state.selectedKey)) state.selectedKey = visible[0]?.key || "";
  renderExpertList(); renderDossier();
});
if (trackerRoot) init();
