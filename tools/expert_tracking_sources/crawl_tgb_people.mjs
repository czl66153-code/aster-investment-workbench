#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const BASE = "https://www.tgb.cn";
const DEFAULT_OUT = path.resolve("outputs", "expert_tracking", "tgb_people");
const DEFAULT_USERS = [
  { userId: "13145799", label: "橘子洲炒家实战" },
  { userId: "13378280", label: "情绪定成胜" },
  { userId: "6440493", label: "复盘实录" },
];
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { users: [], posts: 8, outDir: DEFAULT_OUT, date: shanghaiDate() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--user") {
      const [userId, ...labelParts] = String(value || "").split(":");
      if (!/^\d+$/.test(userId)) throw new Error("--user format must be numericID[:label]");
      args.users.push({ userId, label: labelParts.join(":") });
      index += 1;
    } else if (key === "--posts") args.posts = Number(value), index += 1;
    else if (key === "--out") args.outDir = path.resolve(value), index += 1;
    else if (key === "--date") args.date = value, index += 1;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(args.posts) || args.posts < 1 || args.posts > 30) {
    throw new Error("--posts must be an integer from 1 to 30");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must be YYYY-MM-DD");
  return args;
}

async function rosterUsers() {
  try {
    const rosterPath = path.join(import.meta.dirname, "expert_roster.json");
    const roster = JSON.parse(await fs.readFile(rosterPath, "utf8"));
    const users = (roster.tgbUsers || []).map((item) => ({
      userId: String(item.userId || ""), label: item.displayName || "",
    })).filter((item) => /^\d+$/.test(item.userId));
    return users.length ? users : DEFAULT_USERS;
  } catch {
    return DEFAULT_USERS;
  }
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/json",
          referer: BASE,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstMatch(text, pattern, fallback = "") {
  return text.match(pattern)?.[1] ?? fallback;
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} did not return JSON`); }
}

function parseBlogPosts(html, limit) {
  return html.split('<div class="article_tittle">').slice(1).map((segment) => {
    const href = firstMatch(segment, /href="(\/a\/[^"?#]+)"/i);
    const title = decodeHtml(firstMatch(segment, /title="([\s\S]*?)"/i));
    const date = decodeHtml(firstMatch(segment, /tittle_fbshijian left">([\s\S]*?)<\/div>/i));
    const metric = decodeHtml(firstMatch(segment, /tittle_llhf left">([\s\S]*?)<\/div>/i));
    if (!href || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const [views, replies] = metric.split("/").map((value) => Number(value));
    return { title, date, views: views || 0, replies: replies || 0, url: `${BASE}${href}` };
  }).filter(Boolean).slice(0, limit);
}

function articleBody(html) {
  const start = html.search(/<div class="article-text p_coten" id="first">/i);
  if (start < 0) return { bodyHtml: "", text: "" };
  const tail = html.slice(start);
  const end = tail.search(/<div class="article-topic">|<div class="article-img">/i);
  const bodyHtml = end > 0 ? tail.slice(0, end) : tail.slice(0, 200000);
  return { bodyHtml, text: decodeHtml(bodyHtml) };
}

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractStockNames(bodyHtml) {
  const names = [];
  for (const match of bodyHtml.matchAll(/stockName=([^'"&>\s]+)/gi)) {
    try { names.push(decodeURIComponent(match[1])); } catch { names.push(match[1]); }
  }
  for (const match of bodyHtml.matchAll(/name=['"]T([^'"]+)['"]/gi)) {
    try { names.push(decodeURIComponent(match[1])); } catch { names.push(match[1]); }
  }
  for (const match of bodyHtml.matchAll(/href=['"](?:https:\/\/www\.tgb\.cn)?\/quotes\/(?:sh|sz|bj)?\d+['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    names.push(decodeHtml(match[1]));
  }
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && !/指数$/.test(name)))];
}

const STANCE_RULES = [
  ["卖出", /(清仓|卖出|止损|割肉|兑现|离场|卖掉|核按钮)/],
  ["减仓", /(减仓|降低仓位|卖一半|高抛)/],
  ["加仓", /(加仓|补仓|扩大仓位)/],
  ["买入", /(买入|上车|打板|低吸|半路|介入|开仓|重仓上|梭哈)/],
  ["持有", /(持有|继续持有|锁仓|躺赢|格局|在手|持仓)/],
  ["看好/关注", /(看好|关注|机会|核心|龙头|预期|备选|股票池|观察)/],
  ["看空/回避", /(看空|回避|风险|不碰|不参与|弱势|持续性存疑)/],
];

const STYLE_RULES = [
  { label: "首板打板", kind: "trade", pattern: /首板|打板|封板|炸板/ },
  { label: "龙头接力", kind: "trade", pattern: /龙头|接力|连板|高标|卡位/ },
  { label: "情绪周期", kind: "trade", pattern: /情绪|周期|退潮|冰点|高潮/ },
  { label: "分歧低吸", kind: "trade", pattern: /低吸|分歧|逆势|承接/ },
  { label: "趋势交易", kind: "trade", pattern: /趋势|主升|突破|均线/ },
  { label: "仓位风控", kind: "trade", pattern: /仓位|空仓|回撤|风控|止损/ },
  { label: "盘中信号", kind: "trade", pattern: /竞价|盘口|量能|信号|节点|窗口/ },
  { label: "科技成长", kind: "selection", pattern: /科技|算力|芯片|半导体|人工智能|机器人/ },
  { label: "医药题材", kind: "selection", pattern: /医药|创新药|医疗/ },
  { label: "题材主线", kind: "selection", pattern: /题材|主线|热点|板块|核心辨识度/ },
  { label: "价值基本面", kind: "selection", pattern: /价值投资|基本面|低估值|产业趋势/ },
];

function articleStyleTags(text) {
  return STYLE_RULES.filter((item) => item.pattern.test(text)).map((item) => item.label);
}

function aggregateVoiceStyle(posts) {
  const counts = new Map();
  for (const post of posts) for (const label of post.strategyTags || []) counts.set(label, (counts.get(label) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  const labeledPosts = posts.filter((post) => post.strategyTags?.length).length;
  const qualified = posts.length >= 5 && labeledPosts >= 3;
  const confidence = posts.length >= 15 ? "较高" : posts.length >= 8 ? "中等" : posts.length >= 5 ? "初步" : "不足";
  const tradeLabels = ranked.filter(([label]) => STYLE_RULES.find((item) => item.label === label)?.kind === "trade").slice(0, 4);
  const selectionLabels = ranked.filter(([label]) => STYLE_RULES.find((item) => item.label === label)?.kind === "selection").slice(0, 3);
  return {
    qualified, confidence, postCount: posts.length, labeledPostCount: labeledPosts,
    labels: ranked.map(([label]) => label),
    tagCounts: Object.fromEntries(ranked),
    tradingStyle: qualified && tradeLabels.length
      ? `公开文章高频出现${tradeLabels.map(([label, count]) => `${label}（${count}/${posts.length}篇）`).join("、")}。`
      : "公开文章样本不足，暂不形成稳定交易风格结论。",
    stockSelectionStyle: qualified && selectionLabels.length
      ? `公开选股表达集中于${selectionLabels.map(([label, count]) => `${label}（${count}/${posts.length}篇）`).join("、")}。`
      : "公开文章样本不足，暂不形成稳定选股风格结论。",
    caveat: "来自公开文章语义频次，只代表作者表达的策略偏好，不等同于真实账户持仓或实际成交。",
  };
}

function classifyStockMentions(text, stocks) {
  return stocks.map((stock) => {
    const positions = [];
    let offset = 0;
    while ((offset = text.indexOf(stock, offset)) >= 0) positions.push(offset), offset += stock.length;
    const evidence = positions.slice(0, 3).map((position) => {
      const left = Math.max(0, text.lastIndexOf("。", position - 1) + 1, position - 90);
      const rightPunctuation = text.indexOf("。", position + stock.length);
      const right = Math.min(text.length, rightPunctuation >= 0 ? rightPunctuation + 1 : position + stock.length + 110);
      return text.slice(left, right).replace(/\s+/g, " ").trim();
    });
    const context = evidence.join(" ");
    const matched = STANCE_RULES.find(([, rule]) => rule.test(context));
    return {
      stockName: stock,
      stance: matched?.[0] || "仅提及",
      evidenceLevel: matched && ["买入", "卖出", "加仓", "减仓", "持有"].includes(matched[0])
        ? "明确交易措辞"
        : matched ? "观点措辞" : "仅提及",
      evidence: evidence.slice(0, 2),
    };
  });
}

function aggregateStockSignals(posts, focusStocks) {
  const byStock = new Map();
  const codeByName = new Map(focusStocks.map((item) => [item.stockName, item.stockCode]));
  for (const post of posts) {
    for (const signal of post.stockSignals) {
      const item = byStock.get(signal.stockName) || {
        stockName: signal.stockName,
        stockCode: codeByName.get(signal.stockName) || "",
        mentionCount: 0,
        latestDate: "",
        stances: {},
        evidence: [],
      };
      item.mentionCount += 1;
      if (post.date > item.latestDate) item.latestDate = post.date;
      item.stances[signal.stance] = (item.stances[signal.stance] || 0) + 1;
      if (signal.evidence[0] && item.evidence.length < 3) {
        item.evidence.push({ date: post.date, stance: signal.stance, text: signal.evidence[0], url: post.url });
      }
      byStock.set(signal.stockName, item);
    }
  }
  return [...byStock.values()].sort((a, b) => b.latestDate.localeCompare(a.latestDate) || b.mentionCount - a.mentionCount);
}

async function crawlUser(input, postLimit) {
  const profileUrl = `${BASE}/blog/${input.userId}`;
  const [profileRaw, focusRaw, blogHtml] = await Promise.all([
    fetchText(`${BASE}/user/getBlogerInfo?userID=${input.userId}`),
    fetchText(`${BASE}/user/blog/blogerfocus?blogID=${input.userId}`),
    fetchText(profileUrl),
  ]);
  const profile = parseJson(profileRaw, "profile").dto || {};
  const focus = parseJson(focusRaw, "recent stocks").dto || [];
  const postRefs = parseBlogPosts(blogHtml, postLimit);
  const posts = [];
  for (const post of postRefs) {
    const html = await fetchText(post.url);
    const { bodyHtml, text } = articleBody(html);
    const stocks = extractStockNames(bodyHtml);
    posts.push({
      ...post,
      authorUserId: firstMatch(html, /<div id="gioMsg"[^>]*userID="(\d+)"/i, input.userId),
      textLength: text.length,
      strategyTags: articleStyleTags(text),
      stockSignals: classifyStockMentions(text, stocks),
    });
    await sleep(120);
  }
  const focusStocks = unique(focus.map((item) => ({
    stockName: item.keywordName || "",
    stockCode: String(item.stockCode || "").replace(/^(sh|sz|bj)/i, ""),
  })), (item) => `${item.stockCode}:${item.stockName}`);
  return {
    source: "淘股吧",
    userId: String(profile.userID || input.userId),
    username: profile.userName || input.label || "",
    profileUrl,
    isVerified: profile.isUserCert === "Y",
    isDav: Boolean(profile.isDav),
    fans: Number(profile.fansNum || 0),
    follows: Number(profile.friendNum || 0),
    bio: profile.pe || "",
    region: profile.ipAddress || "",
    publicHoldingAvailability: profile.isOpenStock ? "主页标记公开股票" : "未发现结构化公开持仓",
    recentDiscussedStocks: focusStocks,
    posts,
    stockSignals: aggregateStockSignals(posts, focusStocks),
    voiceStyle: aggregateVoiceStyle(posts),
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

function markdown(result) {
  const lines = [
    `# 淘股吧具体用户跟踪（${result.date}）`, "",
    `本次抓取 ${result.people.length} 个明确用户、${result.validation.posts} 篇公开文章、${result.validation.signals} 条个股级信号。`, "",
    "> 口径：文章中的股票链接先记为“提及”；只有上下文出现买入、持有、加仓、卖出等明确措辞，才升级为交易信号。文章观点不是账户持仓。", "",
  ];
  for (const person of result.people) {
    lines.push(`## ${person.username}（用户ID ${person.userId}）`, "");
    lines.push(`- 主页：${person.profileUrl}`);
    lines.push(`- 粉丝：${person.fans}；认证：${person.isVerified ? "是" : "否"}；大V：${person.isDav ? "是" : "否"}`);
    lines.push(`- 简介：${person.bio || "未填写"}`);
    lines.push(`- 结构化持仓：${person.publicHoldingAvailability}`, "");
    lines.push("| 最近日期 | 股票 | 代码 | 提及次数 | 观点/动作 | 证据等级 |", "|---|---|---|---:|---|---|");
    const rows = person.stockSignals.slice(0, 12);
    if (!rows.length) lines.push("| - | 未解析到个股 | - | - | - | - |");
    for (const item of rows) {
      const topStance = Object.entries(item.stances).sort((a, b) => b[1] - a[1])[0]?.[0] || "仅提及";
      const evidenceLevel = item.evidence.find((entry) => ["买入", "卖出", "加仓", "减仓", "持有"].includes(entry.stance))
        ? "明确交易措辞" : item.evidence.length ? "观点/提及" : "近期讨论接口";
      lines.push(`| ${item.latestDate || "接口未给日期"} | ${item.stockName} | ${item.stockCode} | ${item.mentionCount} | ${topStance} | ${evidenceLevel} |`);
    }
    lines.push("");
  }
  lines.push("## 风险边界", "", "- 不绕过登录、付费墙、验证码或关注权限。", "- 未公开的真实持仓统一记为不可得，不由文章提及反推。", "- 语义结果保留文章链接与短证据，进入投资流程前必须人工复核。", "");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.users.length) args.users = await rosterUsers();
  await fs.mkdir(args.outDir, { recursive: true });
  const people = [];
  const errors = [];
  for (const user of args.users) {
    try { people.push(await crawlUser(user, args.posts)); }
    catch (error) { errors.push({ user, error: String(error.message || error) }); }
  }
  const result = {
    generatedAt: new Date().toISOString(), date: args.date, source: BASE, people, errors,
    validation: {
      requestedUsers: args.users.length,
      parsedUsers: people.length,
      posts: people.reduce((sum, item) => sum + item.posts.length, 0),
      signals: people.reduce((sum, item) => sum + item.posts.reduce((n, post) => n + post.stockSignals.length, 0), 0),
      explicitTradeSignals: people.reduce((sum, item) => sum + item.posts.reduce((n, post) => n + post.stockSignals.filter((signal) => signal.evidenceLevel === "明确交易措辞").length, 0), 0),
    },
  };
  const prefix = path.join(args.outDir, `tgb_people_${args.date}`);
  const signalRows = people.flatMap((person) => person.posts.flatMap((post) => post.stockSignals.map((signal) => ({
    username: person.username, userId: person.userId, date: post.date, title: post.title,
    stockName: signal.stockName, stance: signal.stance, evidenceLevel: signal.evidenceLevel,
    evidence: signal.evidence.join(" / "), url: post.url,
  }))));
  await Promise.all([
    fs.writeFile(`${prefix}.json`, JSON.stringify(result, null, 2), "utf8"),
    fs.writeFile(`${prefix}_signals.csv`, "\ufeff" + toCsv(signalRows, [
      ["用户", "username"], ["用户ID", "userId"], ["日期", "date"], ["文章", "title"],
      ["股票", "stockName"], ["观点/动作", "stance"], ["证据等级", "evidenceLevel"],
      ["上下文证据", "evidence"], ["原文", "url"],
    ]), "utf8"),
    fs.writeFile(`${prefix}_report.md`, markdown(result), "utf8"),
  ]);
  console.log(JSON.stringify({ prefix, validation: result.validation, errors }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
