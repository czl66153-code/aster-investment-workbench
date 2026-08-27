const state = {
  data: null,
  tgb: null,
  publicSources: null,
  profiles: [],
  filtered: [],
  selectedKey: "",
  source: "all",
  query: "",
  signalUserId: "",
  rankingSource: "顽主杯",
  publicSource: "tgb",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value, digits = 2) {
  if (!hasNumber(value)) return "—";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function formatPct(value) {
  if (!hasNumber(value)) return "—";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${formatNumber(number)}%`;
}

function formatShanghaiDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "时间未披露";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function monogram(name) {
  const text = String(name || "—").replace(/[^\p{L}\p{N}]/gu, "");
  return text.length > 2 ? text.slice(-2) : text || "—";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

async function loadJson(url) {
  const response = await fetch(`${url}?t=${Date.now()}`);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function loadData({ announce = false } = {}) {
  try {
    const [data, tgb, publicSources] = await Promise.all([
      loadJson("./data/expert_profiles.json"),
      loadJson("./data/tgb_people.json"),
      loadJson("./data/public_sources.json"),
    ]);
    state.data = data;
    state.tgb = tgb;
    state.publicSources = publicSources;
    state.profiles = [...(data.profiles || [])].sort((a, b) => {
      if (a.personName === "乌江望月" && a.source === "顽主杯") return -1;
      if (b.personName === "乌江望月" && b.source === "顽主杯") return 1;
      return (b.latestSnapshot?.totalReturnPct ?? -Infinity) - (a.latestSnapshot?.totalReturnPct ?? -Infinity);
    });
    if (!state.selectedKey || !state.profiles.some((item) => item.key === state.selectedKey)) {
      state.selectedKey = state.profiles[0]?.key || "";
    }
    if (!state.signalUserId) state.signalUserId = String(tgb.people?.[0]?.userId || "");
    renderAll();
    if (announce) showToast("数据已从本地档案重新载入");
  } catch (error) {
    console.error(error);
    $("#expertList").innerHTML = `<div class="empty-cell">数据未载入。请先运行同步脚本，再通过本地服务器打开页面。</div>`;
    showToast("数据载入失败，请检查 data 目录");
  }
}

function renderAll() {
  const data = state.data;
  const tgb = state.tgb;
  $("#sidebarDate").textContent = data.date || "—";
  $("#metricExperts").textContent = formatNumber(data.profiles?.length || 0, 0);
  $("#metricDays").textContent = formatNumber((data.sourceStats?.wanzhuDates || 0) + (data.sourceStats?.fuliDates || 0), 0);
  $("#metricHoldings").textContent = formatNumber(data.profiles?.reduce((sum, profile) => sum + profile.history.reduce((n, snap) => n + snap.holdings.length, 0), 0) || 0, 0);
  const tgbSignals = tgb.people?.reduce((sum, person) => sum + person.posts.reduce((n, post) => n + post.stockSignals.length, 0), 0) || 0;
  const xueqiuStrategies = state.publicSources?.xueqiu?.portfolios?.filter((item) => item.publicRecommendation).length || 0;
  $("#metricSignals").textContent = formatNumber(tgbSignals + xueqiuStrategies, 0);
  renderExpertList();
  renderProfile();
  renderRankings();
  renderSignals();
  renderSources();
}

function renderExpertList() {
  const query = state.query.trim().toLowerCase();
  state.filtered = state.profiles.filter((profile) => {
    if (state.source === "qualified" && !profile.style?.isQualified) return false;
    if (!["all", "qualified"].includes(state.source) && profile.source !== state.source) return false;
    const haystack = [profile.personName, profile.personId, profile.source, ...(profile.style?.labels || [])].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });
  $("#expertCount").textContent = state.filtered.length;
  $("#expertList").innerHTML = state.filtered.length ? state.filtered.map((profile) => {
    const latest = profile.latestSnapshot || {};
    return `<button class="expert-card ${profile.key === state.selectedKey ? "is-active" : ""}" data-key="${escapeHtml(profile.key)}" type="button" role="option" aria-selected="${profile.key === state.selectedKey}">
      <span class="expert-card-head"><strong>${escapeHtml(profile.personName)}</strong><span class="return">${escapeHtml(formatPct(latest.totalReturnPct))}</span></span>
      <span class="expert-card-meta"><span class="source-mini">${escapeHtml(profile.source)}</span><span>${profile.style?.observationDays || 0}日 · ${profile.style?.isQualified ? `${escapeHtml(profile.style.sampleGrade)}画像` : "积累中"}</span></span>
    </button>`;
  }).join("") : '<div class="empty-cell">没有符合条件的高手。调整来源或搜索词。</div>';
  $$(".expert-card", $("#expertList")).forEach((button) => button.addEventListener("click", () => {
    state.selectedKey = button.dataset.key;
    renderExpertList();
    renderProfile();
  }));
}

function selectedProfile() {
  return state.profiles.find((profile) => profile.key === state.selectedKey) || state.profiles[0];
}

function renderProfile() {
  const profile = selectedProfile();
  if (!profile) return;
  const latest = profile.latestSnapshot || {};
  $("#avatarMonogram").textContent = monogram(profile.personName);
  $("#profileSource").textContent = profile.source;
  $("#profileName").textContent = profile.personName;
  $("#profileMeta").textContent = `ID ${profile.personId || "未公开"} · ${latest.group || "未分组"} · ${latest.match || "当前赛季"}`;
  $("#profileReturn").textContent = formatPct(latest.totalReturnPct);
  $("#returnDate").textContent = `截至 ${latest.date || "—"}`;
  $("#profileAssets").textContent = formatNumber(latest.totalAssetsWan);
  $("#profilePosition").textContent = hasNumber(latest.positionPct) ? `${formatNumber(latest.positionPct)}%` : "—";
  $("#positionTone").textContent = positionLabel(latest.positionPct);
  $("#profileDays").textContent = profile.style?.observationDays || 0;
  $("#profileNote").textContent = latest.note || "暂无公开自述";
  renderChart(profile.history || []);
  renderHoldings(latest.holdings || []);
  renderTransactions(profile.transactions || []);
  renderStyle(profile.style || {});
}

function positionLabel(value) {
  if (!hasNumber(value)) return "未公开";
  const number = Number(value);
  if (number >= 120) return "融资/高杠杆";
  if (number >= 85) return "高仓位";
  if (number >= 45) return "中等仓位";
  return "低仓位/择时";
}

function renderHoldings(holdings) {
  const total = holdings.reduce((sum, item) => sum + (Number(item.amountWan) || 0), 0);
  $("#holdingSummary").textContent = holdings.length ? `${holdings.length} 只股票，披露金额合计 ${formatNumber(total)} 万元` : "当期空仓或未披露持仓";
  $("#holdingsBody").innerHTML = holdings.length ? [...holdings]
    .sort((a, b) => (Number(b.amountWan) || 0) - (Number(a.amountWan) || 0))
    .map((holding) => {
      const pnl = Number(holding.dailyPnlWan);
      const weight = total > 0 && hasNumber(holding.amountWan) ? Number(holding.amountWan) / total * 100 : null;
      return `<tr>
        <td><strong>${escapeHtml(holding.stockName)}</strong></td>
        <td>${escapeHtml(holding.stockCode || "—")}</td>
        <td>${escapeHtml(formatNumber(holding.amountWan))}</td>
        <td>${weight === null ? "—" : `${formatNumber(weight, 1)}%`}</td>
        <td class="${pnl > 0 ? "positive" : pnl < 0 ? "negative" : ""}">${escapeHtml(formatNumber(holding.dailyPnlWan))}</td>
      </tr>`;
    }).join("") : '<tr><td class="empty-cell" colspan="5">没有可展示的结构化持仓。</td></tr>';
}

function renderTransactions(transactions) {
  const rows = [...transactions].reverse().slice(0, 18);
  $("#transactionTape").innerHTML = rows.length ? rows.map((item) => {
    const exit = item.action.includes("退出") || item.action.includes("减仓");
    const amount = item.currentAmountWan ?? item.previousAmountWan;
    return `<div class="tape-item ${exit ? "is-exit" : ""}">
      <time>${escapeHtml(item.toDate)}</time>
      <span class="tape-action">${escapeHtml(item.action)}</span>
      <strong>${escapeHtml(item.stockName)} <small>${escapeHtml(item.stockCode || "")}</small></strong>
      <span class="tape-amount">${formatNumber(amount)} 万</span>
    </div>`;
  }).join("") : '<div class="empty-cell">相邻有效披露日不足，暂不推断交易变化。</div>';
}

function renderStyle(style) {
  const qualified = Boolean(style.isQualified);
  $("#styleConfidence").textContent = qualified ? `${style.sampleGrade || "初步"}置信度 · 样本达标` : "样本不足 · 暂不定型";
  $("#styleNarrative").textContent = qualified
    ? `已覆盖 ${style.observationDays || 0} 个收盘披露日，可用于形成行为画像。所有结论均可回溯到持仓序列。`
    : `当前仅 ${style.observationDays || 0} 个收盘披露日，低于 5 日门槛；先展示事实，继续积累样本。`;
  $("#styleTags").innerHTML = qualified && (style.labels || []).length
    ? style.labels.map((label) => `<span class="style-tag">${escapeHtml(label)}</span>`).join("")
    : '<span class="style-tag">样本积累中</span>';
  const facts = [
    ["平均仓位", style.averagePositionPct, "%"],
    ["平均持股", style.averageHoldingCount, "只"],
    ["前一大集中度", style.averageTop1ConcentrationPct, "%"],
    ["换入换出", style.inferredSwitchEvents, "次"],
    ["仓位波动", style.positionVolatilityPct, "%"],
    ["历史独立标的", style.uniqueStocks, "只"],
  ];
  $("#styleFacts").innerHTML = facts.map(([label, value, suffix]) => `<div class="style-fact"><span>${label}</span><strong>${formatNumber(value)}${value === null || value === undefined ? "" : suffix}</strong></div>`).join("");
  $("#tradingStyleText").textContent = style.tradingStyle || "样本不足，暂不形成稳定交易风格结论。";
  $("#selectionStyleText").textContent = style.stockSelectionStyle || "样本不足，暂不形成稳定选股风格结论。";
  $("#frequentStocks").innerHTML = (style.frequentStocks || []).length
    ? style.frequentStocks.map((item) => `<span><strong>${escapeHtml(item.stockName)}</strong><small>${item.days}日</small></span>`).join("")
    : '<span class="style-stock-empty">暂无足够的重复持仓</span>';
  $("#styleCaveat").textContent = style.caveat || "风格指标来自离散收盘披露，仅用于研究参考。";
}

function renderChart(history) {
  const wrap = $("#profileChart");
  if (history.length < 2) {
    wrap.innerHTML = '<div class="empty-cell">至少需要两个披露日才能绘制轨迹。</div>';
    return;
  }
  const width = 760;
  const height = 185;
  const pad = { left: 38, right: 22, top: 18, bottom: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const returns = history.map((row) => hasNumber(row.totalReturnPct) ? Number(row.totalReturnPct) : null).filter(hasNumber);
  const positions = history.map((row) => hasNumber(row.positionPct) ? Number(row.positionPct) : null).filter(hasNumber);
  if (!returns.length || !positions.length) {
    wrap.innerHTML = '<div class="empty-cell">收益或仓位为脱敏数据，暂不绘制轨迹。</div>';
    return;
  }
  let minR = Math.min(...returns);
  let maxR = Math.max(...returns);
  if (minR === maxR) minR -= 1, maxR += 1;
  const margin = (maxR - minR) * .14;
  minR -= margin;
  maxR += margin;
  const maxP = Math.max(100, ...positions, 1);
  const x = (index) => pad.left + plotW * index / Math.max(1, history.length - 1);
  const yR = (value) => pad.top + plotH * (1 - (value - minR) / (maxR - minR));
  const yP = (value) => pad.top + plotH * (1 - value / maxP);
  const returnPoints = history.map((row, index) => hasNumber(row.totalReturnPct) ? [x(index), yR(Number(row.totalReturnPct))] : null).filter(Boolean);
  const positionPoints = history.map((row, index) => hasNumber(row.positionPct) ? [x(index), yP(Number(row.positionPct))] : null).filter(Boolean);
  const path = (points) => points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = returnPoints.length ? `${path(returnPoints)} L${returnPoints.at(-1)[0]},${pad.top + plotH} L${returnPoints[0][0]},${pad.top + plotH} Z` : "";
  const labels = [...new Set([0, Math.floor((history.length - 1) / 2), history.length - 1])];
  wrap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="returnGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c94b4b" stop-opacity=".16"/><stop offset="1" stop-color="#c94b4b" stop-opacity="0"/></linearGradient></defs>
    ${[0, .5, 1].map((ratio) => `<line class="chart-grid" x1="${pad.left}" y1="${pad.top + plotH * ratio}" x2="${width - pad.right}" y2="${pad.top + plotH * ratio}"/>`).join("")}
    <text class="chart-axis" x="0" y="${pad.top + 3}">${formatNumber(maxR, 1)}%</text>
    <text class="chart-axis" x="0" y="${pad.top + plotH + 3}">${formatNumber(minR, 1)}%</text>
    ${area ? `<path class="chart-area" d="${area}"/>` : ""}
    <path class="chart-position" d="${path(positionPoints)}"/>
    <path class="chart-return" d="${path(returnPoints)}"/>
    ${returnPoints.map(([px, py]) => `<circle class="chart-dot" cx="${px}" cy="${py}" r="2.8"/>`).join("")}
    ${labels.map((index) => `<text class="chart-axis" text-anchor="${index === 0 ? "start" : index === history.length - 1 ? "end" : "middle"}" x="${x(index)}" y="${height - 7}">${escapeHtml(history[index].date.slice(5))}</text>`).join("")}
  </svg>`;
}

function latestCompetitionDate(source) {
  return state.profiles
    .filter((profile) => profile.source === source)
    .flatMap((profile) => profile.history.map((snapshot) => snapshot.date))
    .sort()
    .at(-1) || "";
}

function competitionRows(source, date) {
  return state.profiles.flatMap((profile) => {
    if (profile.source !== source) return [];
    const snapshot = profile.history.find((item) => item.date === date);
    return snapshot ? [{ profile, snapshot }] : [];
  });
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = row.snapshot.group || "未分组";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  for (const items of groups.values()) items.sort((a, b) => (a.snapshot.rank ?? 999) - (b.snapshot.rank ?? 999));
  const order = ["千万组", "百万组", "十万组", "六一组", "菜鸟组"];
  return [...groups.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a[0].localeCompare(b[0], "zh-CN");
  });
}

function denseStocks(rows) {
  const stocks = new Map();
  for (const { profile, snapshot } of rows) {
    for (const holding of snapshot.holdings || []) {
      const key = holding.stockCode || holding.stockName;
      const current = stocks.get(key) || {
        stockCode: holding.stockCode || "",
        stockName: holding.stockName || "",
        holders: new Set(),
        knownAmountWan: 0,
        knownAmountCount: 0,
      };
      current.holders.add(profile.personName);
      if (hasNumber(holding.amountWan)) {
        current.knownAmountWan += Number(holding.amountWan);
        current.knownAmountCount += 1;
      }
      stocks.set(key, current);
    }
  }
  return [...stocks.values()]
    .map((item) => ({ ...item, holders: [...item.holders], holdingCount: item.holders.size }))
    .sort((a, b) => b.holdingCount - a.holdingCount || b.knownAmountWan - a.knownAmountWan || a.stockName.localeCompare(b.stockName, "zh-CN"));
}

function renderRankings() {
  if (!state.data) return;
  const source = state.rankingSource;
  const date = latestCompetitionDate(source);
  const rows = competitionRows(source, date);
  const groups = groupRows(rows);
  $("#rankingDate").textContent = date || "—";
  $("#leaderBoard").innerHTML = groups.length ? groups.map(([group, people]) => `<section class="leader-group">
    <div class="leader-group-head"><h3>${escapeHtml(group)}</h3><span>TOP ${people.length} / ${escapeHtml(source)}</span></div>
    ${people.slice(0, 3).map(({ profile, snapshot }, index) => {
      const topHolding = [...(snapshot.holdings || [])].sort((a, b) => (Number(b.amountWan) || 0) - (Number(a.amountWan) || 0))[0];
      return `<div class="leader-row">
        <span class="rank-medal">${snapshot.rank || index + 1}</span>
        <button class="leader-name" data-profile-key="${escapeHtml(profile.key)}" type="button"><strong>${escapeHtml(profile.personName)}</strong><small>${escapeHtml(profile.personId || "ID未公开")} · ${snapshot.holdings.length}只</small></button>
        <span class="leader-stat return"><span>累计收益</span><strong>${escapeHtml(formatPct(snapshot.totalReturnPct))}</strong></span>
        <span class="leader-stat position"><span>仓位</span><strong>${hasNumber(snapshot.positionPct) ? `${formatNumber(snapshot.positionPct)}%` : "—"}</strong></span>
        <span class="leader-holding"><span>第一大持仓</span><strong>${escapeHtml(topHolding?.stockName || "空仓")}</strong></span>
      </div>`;
    }).join("")}
  </section>`).join("") : '<div class="empty-cell">该比赛当前没有可用榜单快照。</div>';

  $("#densityGrid").innerHTML = groups.length ? groups.map(([group, people]) => {
    const stocks = denseStocks(people.slice(0, 3)).slice(0, 6);
    const maxCount = Math.max(1, ...stocks.map((item) => item.holdingCount));
    return `<section class="density-card">
      <div class="density-card-head"><h3>${escapeHtml(group)}</h3><span>${people.slice(0, 3).length}名选手 · ${stocks.length}只密集股</span></div>
      ${stocks.length ? stocks.map((stock, index) => `<div class="density-stock">
        <span class="density-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="density-name"><strong>${escapeHtml(stock.stockName)}</strong><small>${escapeHtml(stock.stockCode || "代码未公开")}</small></span>
        <span class="density-count"><b>${stock.holdingCount}</b> / ${people.slice(0, 3).length} 人</span>
        <span class="density-holders">${escapeHtml(stock.holders.join("、"))}${stock.knownAmountCount ? `<br>已披露 ${formatNumber(stock.knownAmountWan)} 万` : ""}</span>
        <span class="density-bar"><i style="width:${stock.holdingCount / maxCount * 100}%"></i></span>
      </div>`).join("") : '<div class="empty-cell">前三名当期空仓或未披露个股。</div>'}
    </section>`;
  }).join("") : "";
  $$(".leader-name", $("#leaderBoard")).forEach((button) => button.addEventListener("click", () => {
    state.selectedKey = button.dataset.profileKey;
    renderExpertList();
    renderProfile();
    switchView("workspace");
  }));
}

function strategyTags(text) {
  const value = String(text || "").replaceAll("反量化", "");
  const rules = [
    [/科技|AI|算力|芯片|半导体|机器人/i, "科技成长"],
    [/价值投资|价值选股|低估值|红利|股息|基本面/i, "价值/红利"],
    [/长期|长线|不调仓|低频|被动/i, "长期低换手"],
    [/量化|指数|等权|规则|模型/i, "规则/量化"],
    [/趋势|新高|强势|龙头|接力|涨停/i, "趋势强势"],
    [/低吸|分歧|逆势|承接/i, "分歧低吸"],
    [/信号|节点|窗口|竞价/i, "信号驱动"],
    [/空仓|止损|回避|风控|去弱留强/i, "风险控制"],
  ];
  return rules.filter(([pattern]) => pattern.test(value)).map(([, label]) => label);
}

function tgbVoiceStyle(person) {
  const signals = (person.posts || []).flatMap((post) => post.stockSignals || []);
  const explicit = signals.filter((item) => item.evidenceLevel === "明确交易措辞").length;
  const bullish = signals.filter((item) => item.stance === "看好/关注").length;
  const bearish = signals.filter((item) => item.stance === "看空/回避").length;
  const evidenceText = signals.flatMap((item) => item.evidence || []).join(" ");
  const corpus = [person.bio, ...(person.posts || []).map((post) => post.title), evidenceText].join(" ");
  const extracted = person.voiceStyle || {};
  const tags = extracted.labels?.length ? extracted.labels : strategyTags(corpus);
  const qualified = extracted.qualified ?? ((person.posts?.length || 0) >= 5 && signals.length >= 5);
  const dominant = tags.includes("盘中信号") || tags.includes("信号驱动") ? "偏盘中信号与节点确认" : tags.includes("龙头接力") || tags.includes("趋势强势") ? "偏强势题材与核心标的" : "公开表达尚未形成单一主线";
  return {
    signals, explicit, bullish, bearish, tags, qualified,
    summary: qualified
      ? `${dominant}；${extracted.stockSelectionStyle || (bullish > bearish * 2 ? "看多关注明显多于回避观点。" : "多空表达相对均衡。")}`
      : "文章或逐股语义样本不足，暂不输出稳定风格。",
  };
}

function renderSignals() {
  const people = state.tgb?.people || [];
  $("#voiceStyleGrid").innerHTML = people.map((person) => {
    const style = tgbVoiceStyle(person);
    return `<article class="voice-style-card ${style.qualified ? "is-qualified" : ""}">
      <div class="voice-card-head"><span>${style.qualified ? `${escapeHtml(person.voiceStyle?.confidence || "初步")}画像` : "样本积累中"}</span><small>${person.posts.length}篇文章 · ${style.signals.length}条逐股语义</small></div>
      <h3>${escapeHtml(person.username)}</h3>
      <p>${escapeHtml(style.summary)}</p>
      <div class="voice-tags">${style.tags.slice(0, 5).map((tag) => `<i>${escapeHtml(tag)}</i>`).join("") || "<i>待积累</i>"}</div>
      <div class="voice-metrics"><span>动作措辞 <b>${style.explicit}</b></span><span>看好 <b>${style.bullish}</b></span><span>回避 <b>${style.bearish}</b></span></div>
    </article>`;
  }).join("");
  $("#signalPeople").innerHTML = people.map((person) => `<button class="signal-person ${String(person.userId) === state.signalUserId ? "is-active" : ""}" data-user-id="${escapeHtml(person.userId)}" type="button"><strong>${escapeHtml(person.username)}</strong><small>${person.posts.length}篇 · ${person.stockSignals.length}只相关标的</small></button>`).join("");
  $$(".signal-person").forEach((button) => button.addEventListener("click", () => {
    state.signalUserId = button.dataset.userId;
    renderSignals();
  }));
  const selected = people.find((person) => String(person.userId) === state.signalUserId) || people[0];
  if (!selected) return;
  const rows = selected.posts.flatMap((post) => post.stockSignals.map((signal) => ({ ...signal, date: post.date, title: post.title, url: post.url })))
    .sort((a, b) => b.date.localeCompare(a.date));
  $("#signalFeed").innerHTML = rows.length ? rows.map((row) => {
    const gradeClass = row.evidenceLevel === "明确交易措辞" ? "explicit" : row.evidenceLevel === "观点措辞" ? "opinion" : "mention";
    const grade = row.evidenceLevel === "明确交易措辞" ? "B · 动作措辞" : row.evidenceLevel === "观点措辞" ? "C · 观点" : "C · 仅提及";
    return `<article class="signal-entry">
      <time class="signal-date">${escapeHtml(row.date)}</time>
      <div class="signal-main"><h3>${escapeHtml(row.stockName)} · ${escapeHtml(row.stance)}</h3><p>${escapeHtml(row.evidence?.[0] || row.title)} <span class="cache-badge">· 本地证据</span></p></div>
      <span class="signal-grade ${gradeClass}">${grade}</span>
    </article>`;
  }).join("") : '<div class="empty-cell">该用户近期文章未解析到个股证据。</div>';

  const portfolios = state.publicSources?.xueqiu?.portfolios || [];
  $("#xueqiuStrategies").innerHTML = portfolios.length ? portfolios.map((item) => {
    const tags = item.styleProfile?.labels?.length ? item.styleProfile.labels : strategyTags(item.publicRecommendation);
    return `<article class="strategy-card">
      <div class="strategy-source"><span>${item.currentHoldings?.length ? "B · 公开组合" : "C · 公开策略"}</span><small>${escapeHtml(item.market || "沪深")}</small></div>
      <h3>${escapeHtml(item.name)}</h3>
      <p class="strategy-manager">${escapeHtml(item.manager)} 主理 · ${formatNumber(item.followers, 0)} 人关注</p>
      <blockquote>${escapeHtml(item.publicRecommendation || "未公开策略说明，仅保留公开组合成绩标签。")}</blockquote>
      <div class="strategy-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("") || "<span>待识别</span>"}</div>
      <div class="strategy-stats"><span>总收益 <b>${formatPct(item.totalGain)}</b></span><span>年化 <b>${formatPct(item.annualizedGain)}</b></span><span>月度 <b>${formatPct(item.monthlyGain)}</b></span></div>
      <div class="holding-preview">${(item.currentHoldings || []).slice(0, 3).map((holding) => `<span>${escapeHtml(holding.stockName)} ${formatNumber(holding.weightPct, 1)}%</span>`).join("") || `<span>${escapeHtml(item.holdingStatus || "持仓待同步")}</span>`}</div>
      <button class="local-open" data-cube-symbol="${escapeHtml(item.symbol)}" type="button"><span>本地查看持仓与风格</span><span>${item.currentHoldings?.length || 0}只 →</span></button>
    </article>`;
  }).join("") : '<div class="empty-cell">没有已同步的雪球公开组合。</div>';

  $$(".local-open", $("#xueqiuStrategies")).forEach((button) => button.addEventListener("click", () => {
    const item = portfolios.find((portfolio) => portfolio.symbol === button.dataset.cubeSymbol);
    if (item) openLocalDossier(item);
  }));

  const thsPlayers = state.publicSources?.tonghuashun?.players || [];
  $("#thsRanking").innerHTML = thsPlayers.length ? `<div class="public-ranking-head"><span>排名</span><span>选手</span><span>总收益</span><span>选股成功率</span><span>资产</span><span>本地持仓</span></div>${thsPlayers.map((item) => `<div class="public-ranking-row">
    <b>${item.rank}</b><span><strong>${escapeHtml(item.username)}</strong><small>${escapeHtml(item.grade || "未分级")}</small></span><span class="return">${formatPct(item.totalReturn)}</span><span>${hasNumber(item.stockPickSuccessRate) ? `${formatNumber(item.stockPickSuccessRate)}%` : "—"}</span><span>${formatNumber(item.totalAssets)}</span><button class="ths-local-open" data-ths-user="${escapeHtml(item.userId)}" type="button">${item.holdingCount || 0}笔持仓 · ${item.tradeCount || 0}笔交易 →</button>
  </div>`).join("")}` : '<div class="empty-cell">没有已同步的同花顺公开榜单。</div>';
  $$(".ths-local-open", $("#thsRanking")).forEach((button) => button.addEventListener("click", () => {
    const item = thsPlayers.find((player) => String(player.userId) === button.dataset.thsUser);
    if (item) openThsDossier(item);
  }));
}

function openLocalDossier(item) {
  const style = item.styleProfile || {};
  const holdings = [...(item.currentHoldings || [])].sort((a, b) => (Number(b.weightPct) || 0) - (Number(a.weightPct) || 0));
  const history = [...(item.localHistory || [])].reverse();
  const topNames = (snapshot) => [...(snapshot.holdings || [])]
    .sort((a, b) => (Number(b.weightPct) || 0) - (Number(a.weightPct) || 0))
    .slice(0, 4)
    .map((holding) => `${holding.stockName} ${formatNumber(holding.weightPct, 1)}%`)
    .join(" · ") || "未披露";
  $("#localDossierBody").innerHTML = `<header class="local-dossier-head">
    <span class="eyebrow">LOCAL STRATEGY DOSSIER / 本地策略档案</span>
    <h2 id="localDossierTitle">${escapeHtml(item.name)}</h2>
    <p>${escapeHtml(item.manager)} 主理 · ${escapeHtml(item.symbol)} · 本页数据来自本地缓存，不需要跳转外站</p>
    <div class="local-status-row"><span>${escapeHtml(item.holdingStatus || "状态未知")}</span><span>${escapeHtml(item.holdingSnapshotAt ? `源更新 ${formatShanghaiDateTime(item.holdingSnapshotAt).slice(0, 10)}` : "更新时间未披露")}</span><span class="${item.recentRebalances?.length ? "" : "is-limited"}">${escapeHtml(item.rebalanceStatus || "调仓历史未同步")}</span></div>
  </header>
  <div class="local-dossier-grid">
    <section class="local-section"><h3>当前公开持仓</h3><p class="local-section-note">雪球公开模拟组合仓位，不代表主理人的真实证券账户。</p>
      ${holdings.length ? holdings.map((holding) => `<div class="local-holding-row"><span><strong>${escapeHtml(holding.stockName)}</strong><small>${escapeHtml(holding.stockCode)}</small></span><span class="local-sector">${escapeHtml(holding.sector)}</span><span class="buy-time"><b>${escapeHtml(holding.buyTime ? formatShanghaiDateTime(holding.buyTime).slice(0, 10) : "待回溯")}</b><small>${escapeHtml(holding.buyTimeEvidence || "待继续回溯")}${hasNumber(holding.buyPrice) ? ` · ¥${formatNumber(holding.buyPrice)}` : ""}</small></span><span class="local-weight">${formatNumber(holding.weightPct, 2)}%</span></div>`).join("") : '<div class="empty-cell">当前接口未返回可核验持仓。</div>'}
    </section>
    <section class="local-section"><h3>本地风格提取</h3>
      <div class="local-style-hero"><strong>${escapeHtml(style.tradeStyle || "风格待积累")}</strong><small>${escapeHtml(style.stockSelectionStyle || "选股风格待积累")}</small></div>
      <div class="strategy-tags">${(style.labels || strategyTags(item.publicRecommendation)).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("") || "<span>待识别</span>"}</div>
      <div class="local-style-facts"><div><span>当前持仓</span><b>${style.holdingCount ?? holdings.length}只</b></div><div><span>前三集中度</span><b>${formatNumber(style.top3WeightPct, 1)}%</b></div><div><span>现金</span><b>${formatNumber(item.cashPct, 1)}%</b></div><div><span>本地快照</span><b>${history.length}期</b></div></div>
      <blockquote>${escapeHtml(item.publicRecommendation || "没有公开策略说明；仅依据持仓结构积累观察，不输出强结论。")}</blockquote>
    </section>
    <section class="local-section local-history"><h3>本地持仓历史</h3><p class="local-section-note">每次爬虫运行只在持仓变化时追加快照；因此会逐日形成历史，不重复写入相同仓位。</p>
      ${history.length ? history.slice(0, 12).map((snapshot) => `<div class="local-history-row"><time>${escapeHtml(formatShanghaiDateTime(snapshot.sourceUpdatedAt || snapshot.capturedAt))}</time><strong>${snapshot.holdings?.length || 0}只 · ${formatPct(snapshot.totalGain)}</strong><span>${escapeHtml(topNames(snapshot))}</span></div>`).join("") : '<div class="empty-cell">首次同步后开始积累历史快照。</div>'}
    </section>
  </div>`;
  $("#localDossier").showModal();
}

function openThsDossier(item) {
  const holdings = item.holdings || [];
  const trades = (item.trades || []).slice(0, 30);
  const identityAvailable = holdings.some((holding) => holding.identityStatus === "公开");
  const stockLabel = (row, index) => row.stockName || row.stockCode || `身份受限持仓 #${index + 1}`;
  $("#localDossierBody").innerHTML = `<header class="local-dossier-head">
    <span class="eyebrow">LOCAL TRADING DOSSIER / 同花顺本地档案</span>
    <h2 id="localDossierTitle">${escapeHtml(item.username)}</h2>
    <p>同花顺模拟炒股百强榜第 ${item.rank} 名 · 本地缓存详情，不跳转外站</p>
    <div class="local-status-row"><span>${escapeHtml(item.detailStatus || "详情状态未知")}</span><span>${holdings.length} 条持仓</span><span>${trades.length} 条近期交易</span><span class="${identityAvailable ? "" : "is-limited"}">${identityAvailable ? "股票身份已公开" : "股票代码与名称需授权登录"}</span></div>
  </header>
  <div class="local-dossier-grid">
    <section class="local-section local-history"><h3>当前模拟持仓</h3><p class="local-section-note">未登录仍可核验建仓日、数量、市值与浮盈亏；股票名称被站点遮挡时按序号展示。</p>
      ${holdings.length ? holdings.map((holding, index) => `<div class="ths-holding-row"><span><strong>${escapeHtml(stockLabel(holding, index))}</strong><small>${escapeHtml(holding.stockCode || "股票身份需登录")}</small></span><span class="buy-time"><b>${escapeHtml(holding.buyTime || "未披露")}</b><small>${escapeHtml(holding.buyTimeEvidence || "未披露")}</small></span><span><small>持仓量</small><b>${formatNumber(holding.quantity, 0)}</b></span><span><small>市值</small><b>${formatNumber(holding.marketValue)}</b></span><span class="${Number(holding.floatingPnl) >= 0 ? "positive" : "negative"}"><small>浮动盈亏</small><b>${formatNumber(holding.floatingPnl)}</b></span></div>`).join("") : '<div class="empty-cell">该选手当前空仓或详情页未披露持仓。</div>'}
    </section>
    <section class="local-section local-history"><h3>近期交易明细</h3><p class="local-section-note">成交日期、方向、数量、价格和金额均来自公开详情页；身份受限行不猜测股票名称。</p>
      ${trades.length ? `<div class="table-scroll"><table class="ths-trade-table"><thead><tr><th>日期</th><th>股票</th><th>操作</th><th>数量</th><th>成交价</th><th>成交金额</th><th>状态</th></tr></thead><tbody>${trades.map((trade, index) => `<tr><td>${escapeHtml(trade.tradeTime || "—")}</td><td><strong>${escapeHtml(stockLabel(trade, index))}</strong><small>${escapeHtml(trade.stockCode || "需登录")}</small></td><td class="${trade.action === "买入" ? "positive" : trade.action === "卖出" ? "negative" : ""}">${escapeHtml(trade.action || "—")}</td><td>${formatNumber(trade.quantity, 0)}</td><td>${formatNumber(trade.price)}</td><td>${formatNumber(trade.amount)}</td><td>${escapeHtml(trade.status || "—")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-cell">没有公开交易记录。</div>'}
    </section>
  </div>`;
  $("#localDossier").showModal();
}

function switchPublicSource(name) {
  state.publicSource = name;
  $$(".public-source-chip").forEach((button) => button.classList.toggle("is-active", button.dataset.publicSource === name));
  $$(".public-source-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.publicPanel === name));
  const contexts = {
    tgb: "逐篇缓存观点证据；发言不等同于真实持仓。样本达标后才提取表达型交易风格。",
    xueqiu: "当前组合与持仓已缓存到本地；公开调仓链可免登录回溯并标记明确买入时间。Cookie 仅用于补充更完整的批量历史和用户动态。",
    ths: "榜单成绩、建仓日、数量、市值和逐笔交易均缓存到本地；未授权登录时仅遮挡股票代码与名称。",
  };
  $("#publicContext").textContent = contexts[name] || contexts.tgb;
}

function renderSources() {
  const stats = state.data?.sourceStats || {};
  const qualified = state.profiles.filter((profile) => profile.style?.isQualified).length;
  const cards = [
    ["顽主杯", "比赛账户结构化披露", stats.wanzhuPeople, `${stats.wanzhuDates || 0}个收盘日`, "A级"],
    ["复利笔记", "排名、仓位及公开持仓", stats.fuliPeople, `${stats.fuliDates || 0}个收盘日`, "A级/部分B级"],
    ["淘股吧", "具体用户文章与逐股语义", state.tgb?.people?.length || 0, `${stats.tgbPosts || 0}篇文章`, "C级"],
    ["雪球", "公开组合持仓、策略说明与收益", stats.xueqiuPeople, `${state.publicSources?.xueqiu?.validation?.holdingRows || 0}条持仓`, "B级/本地缓存"],
    ["同花顺", "模拟高手榜、持仓与交易明细", stats.thsPeople, `${state.publicSources?.tonghuashun?.validation?.holdingRows || 0}条持仓`, "B级/身份部分受限"],
    ["风格画像", "达到5个披露日后才输出稳定画像", qualified, "持仓序列", "模型推断"],
  ];
  $("#sourceGrid").innerHTML = cards.map(([name, description, people, coverage, grade]) => `<article class="source-card">
    <div class="source-card-head"><span class="eyebrow">SOURCE</span><span class="health">可访问</span></div>
    <h3>${escapeHtml(name)}</h3><p>${escapeHtml(description)}</p>
    <div class="source-foot"><span><strong>${formatNumber(people, 0)}</strong> 人</span><span>${escapeHtml(coverage)}</span><span>${escapeHtml(grade)}</span></div>
  </article>`).join("");
}

function switchView(name) {
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === name));
  $$(".view-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === name));
  const titles = { workspace: "高手跟踪工作台", rankings: "比赛榜单与持仓密集度", signals: "公开策略与观点雷达", sources: "数据源健康" };
  $("#pageTitle").textContent = titles[name] || titles.workspace;
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".filter-chip").forEach((button) => button.addEventListener("click", () => {
    state.source = button.dataset.source;
    $$(".filter-chip").forEach((chip) => chip.classList.toggle("is-active", chip === button));
    renderExpertList();
  }));
  $("#expertSearch").addEventListener("input", (event) => { state.query = event.target.value; renderExpertList(); });
  $$(".detail-tab").forEach((button) => button.addEventListener("click", () => {
    $$(".detail-tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
    $$(".detail-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.detail === button.dataset.tab));
  }));
  $$(".competition-chip").forEach((button) => button.addEventListener("click", () => {
    state.rankingSource = button.dataset.competition;
    $$(".competition-chip").forEach((chip) => chip.classList.toggle("is-active", chip === button));
    renderRankings();
  }));
  $$(".public-source-chip").forEach((button) => button.addEventListener("click", () => switchPublicSource(button.dataset.publicSource)));
  $("#refreshButton").addEventListener("click", () => loadData({ announce: true }));
  $("#localDossierClose").addEventListener("click", () => $("#localDossier").close());
  $("#localDossier").addEventListener("click", (event) => { if (event.target === $("#localDossier")) $("#localDossier").close(); });
  $("#exportButton").addEventListener("click", () => {
    const profile = selectedProfile();
    if (!profile) return;
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${profile.source}_${profile.personName}_${profile.latestSnapshot?.date || "profile"}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("当前高手档案已导出");
  });
  window.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea")) return;
    if (["1", "2", "3", "4"].includes(event.key)) switchView(["workspace", "rankings", "signals", "sources"][Number(event.key) - 1]);
  });
}

bindEvents();
loadData();
