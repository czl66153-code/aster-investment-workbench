import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { normalizeEnhancedAnswer } from "../engine/core.mjs";

const port = 8036;
const base = `http://127.0.0.1:${port}`;
const gatewayHeaders = { "content-type": "application/json", "x-aster-local-gateway": "1" };

test("enhanced AI evidence groups are normalized for the visible support list", () => {
  const base = { conclusion: "基础结论", support: [{ title: "基础证据", detail: "基础详情" }], risks: ["基础风险"], watchConditions: ["基础观察"], uncertainty: "基础边界", evidence: [{ id: "E1", type: "quote", title: "最新行情", excerpt: "上涨1%" }, { id: "N1", type: "news", title: "机器人融资", excerpt: "完成九亿美元融资" }, { id: "C1", type: "community", title: "机器人热议", excerpt: "股民讨论机器人" }] };
  const answer = normalizeEnhancedAnswer(base, { conclusion: "增强结论", support: [{ type: "新闻", evidence_ids: ["N1", "BAD"], detail: "最新新闻证据" }], risks: [], watchConditions: [], uncertainty: "" });
  assert.deepEqual(answer.support, [{ title: "新闻 · N1", detail: "最新新闻证据", evidenceIds: ["N1"] }]);
  assert.deepEqual(answer.risks, base.risks);
  assert.deepEqual(answer.watchConditions, base.watchConditions);
  const inferred = normalizeEnhancedAnswer(base, { support: [{ type: "community", detail: "股民正在讨论机器人" }] });
  assert.deepEqual(inferred.support, [{ title: "股民讨论 · C1", detail: "股民正在讨论机器人", evidenceIds: ["C1"] }]);
  const stringSupport = normalizeEnhancedAnswer(base, { support: ["机器人融资消息受到关注"] });
  assert.deepEqual(stringSupport.support, [{ title: "支持证据 · N1", detail: "机器人融资消息受到关注", evidenceIds: ["N1"] }]);
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) return response.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("测试引擎未能启动");
}

test("independent engine serves recommendations, screener, offline AI and watchdog", async () => {
  const child = spawn(process.execPath, ["engine/server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, ASTER_ENGINE_PORT: String(port), ASTER_SCHEDULER_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const health = await waitForHealth();
    assert.equal(health.ok, true);

    const factors = await fetch(`${base}/api/factors`).then((response) => response.json());
    assert.equal(factors.count, 50);
    assert.equal(new Set(factors.items.map((item) => item.key)).size, 50);
    assert.ok(factors.items.some((item) => item.key === "latest_signal_score" && item.name === "最新ABCD全市场综合分"));
    assert.ok(factors.items.some((item) => item.key === "stock_top50_5_10_30" && item.name.includes("前50交集")));
    assert.ok(factors.items.some((item) => item.key === "sector_ret_5d_rank" && item.name === "所属板块5日涨幅排名"));
    assert.ok(factors.items.some((item) => item.key === "bigquant_heat_rank" && item.name === "BigQuant热度排名"));
    assert.ok(factors.items.some((item) => item.key === "multi_period_model_score" && item.name === "多周期候选筹码模型分"));
    assert.ok(factors.items.some((item) => item.key === "multi_period_model_rank_pct" && item.name === "多周期候选筹码模型排名百分位"));
    assert.ok(factors.items.some((item) => item.key === "ret_60d" && item.name === "60日涨幅"));
    assert.ok(factors.items.some((item) => item.key === "stock_ret_60d_rank" && item.name === "全市场60日涨幅排名")); // gitleaks:allow -- factor identifier assertion
    assert.ok(factors.items.some((item) => item.key === "sector_4d_streak" && item.filterOnly === true));

    const kline = await fetch(`${base}/api/kline-similarity?limit=5`).then((response) => response.json());
    assert.equal(kline.logic.eligibility, "OR");
    assert.equal(kline.logic.archiveUsedForSignals, false);
    assert.equal(kline.migration.verified, true);
    assert.ok(kline.migration.files >= 4700);
    assert.ok(kline.market.daily.codes >= 5000);

    const weightConfigs = await fetch(`${base}/api/model-weights`).then((response) => response.json());
    assert.deepEqual(weightConfigs.items.map((item) => item.modelKey), ["abcd", "aia", "heat"]);
    assert.equal(weightConfigs.items.find((item) => item.modelKey === "abcd").groups.ranking.items.d, "D·筹码形态");

    const recommendations = await fetch(`${base}/api/recommendations?model=all`).then((response) => response.json());
    assert.ok(recommendations.items.length >= 8);
    assert.ok(recommendations.batches.length >= 3);
    assert.ok(["ready", "warning", "critical"].includes(recommendations.dataStatus.overall));
    assert.ok(["official", "intraday"].includes(recommendations.dataStatus.market.mode));
    assert.equal(recommendations.dataStatus.models.length, 3);
    assert.ok(recommendations.dataStatus.models.every((item) => Number.isFinite(item.fieldCoverage)));
    assert.ok(recommendations.dataStatus.models.every((item) => item.publishedTradeDate && item.expectedTradeDate));

    const directMutation = await fetch(`${base}/api/screener`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(directMutation.status, 403);
    const screened = await fetch(`${base}/api/screener`, { method: "POST", headers: gatewayHeaders, body: JSON.stringify({ filters: [{ key: "ret_20d", operator: ">=", value: 0 }, { key: "abcd_d_score", operator: ">=", value: 0 }], weights: { formal_model_score: 2, ret_20d: 1, candidate_model_rank_pct: 1 }, weightDirections: { candidate_model_rank_pct: "asc" }, limit: 12 }) }).then((response) => response.json());
    assert.ok(screened.total > 0);
    assert.ok(screened.rows.every((row) => row.ret_20d >= 0));
    assert.ok(screened.rows.every((row) => Number.isFinite(row.composite_score)));
    assert.deepEqual(screened.activeFactors, ["formal_model_score", "ret_20d", "candidate_model_rank_pct"]);
    assert.equal(screened.modelRankSource, "chip_model_rank_daily");
    assert.ok(screened.latestScoreDate);
    assert.ok(["official", "intraday"].includes(screened.latestScoreMode));
    assert.ok(screened.latestScoreCoverage > 0);
    assert.ok(screened.rows.some((row) => Number.isFinite(row.latest_signal_score) && Number.isInteger(row.latest_signal_rank)));
    const formalRanking = await fetch(`${base}/api/chip/rankings?scope=formal&limit=100`).then((response) => response.json());
    const formalScreen = await fetch(`${base}/api/screener`, { method: "POST", headers: gatewayHeaders, body: JSON.stringify({ filters: [], weights: {}, sort: { key: "formal_model_rank", direction: "asc" }, limit: 50 }) }).then((response) => response.json());
    assert.equal(formalScreen.modelRankDate, formalRanking.snapshot.trade_date);
    assert.deepEqual(formalScreen.rows.slice(0, 30).map((row) => [row.code, row.formal_model_rank, row.formal_model_score]), formalRanking.rows.slice(0, 30).map((row) => [row.code, row.rank, row.score]));

    const ai = await fetch(`${base}/api/ai/analyze`, { method: "POST", headers: gatewayHeaders, body: JSON.stringify({ target: "沃森生物", scope: "stock", question: "量价、筹码模型和风险如何？", enhanced: false }) }).then((response) => response.json());
    assert.equal(ai.mode, "offline");
    assert.ok(ai.answer.evidence.length >= 1);
    assert.match(ai.answer.uncertainty, /截止|离线/);
    assert.ok(ai.answer.sourceStatus.some((item) => item.key === "akshare_realtime_quotes"));
    assert.ok(ai.answer.sourceStatus.some((item) => item.key === "minishare_news_api" && ["healthy", "degraded"].includes(item.status)));
    assert.ok(ai.answer.evidence.every((item) => !String(item.published_at || "").startsWith("2099-")));

    const watchdog = await fetch(`${base}/api/data/watchdog`, { method: "POST", headers: { "x-aster-local-gateway": "1" } }).then((response) => response.json());
    assert.equal(watchdog.integrity, "ok");
    assert.ok(watchdog.factorCount >= 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
});
