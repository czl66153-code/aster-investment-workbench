import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the independent Chinese research workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Aster 独立投研工作台<\/title>/);
  assert.match(html, /新闻总览/);
  assert.match(html, /三套独立算法/);
  assert.match(html, /硬筛与加权评分/);
  assert.match(html, /筹码与K线分布/);
  assert.match(html, /双筹码模型与K线扫描/);
  assert.match(html, /双筹码模型与K线扫描/);
  assert.match(html, /全量新鲜证据分析/);
  assert.match(html, /接口连接失败/);
  assert.match(html, /高手蒸馏/);
  assert.match(html, /公开持仓共识与策略风格/);
});

test("community time window is formatted in Shanghai time without raw offsets", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const community = page.slice(page.indexOf("function CommunityHotTopics"), page.indexOf("function NewsOverview"));
  assert.match(page, /function formatWindowTime/);
  assert.match(community, /className="community-time-window"/);
  assert.match(community, /formatWindowTime\(data\.time_window\?\.start\)/);
  assert.match(community, /formatWindowTime\(data\.time_window\?\.end\)/);
  assert.doesNotMatch(community, /time_window\?\.(?:start|end)\?\.replace/);
  assert.match(css, /\.community-time-window>span\{display:grid/);
});

test("renders the formal native expert-tracker route", async () => {
  const response = await render("/expert-tracker");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /高手持仓与持续预测 \| ASTER/);
  assert.match(html, /data-mount-state="checking"/);
  assert.match(html, /高手蒸馏/);
});

test("runtime has no dependency on the three legacy website ports", async () => {
  const files = ["core.mjs", "server.mjs", "scheduler.mjs", "data_sources.mjs"];
  const sources = await Promise.all(files.map((file) => readFile(new URL(`../engine/${file}`, import.meta.url), "utf8")));
  for (const source of sources) assert.doesNotMatch(source, /(?:localhost|127\.0\.0\.1):(?:8000|8002|8010)/);
});

test("browser data requests use the same-origin web gateway", async () => {
  const [page, webServer] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../engine/web_server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const API = "\/api"/);
  assert.match(page, /fetch\("\/api\/runtime-status"/);
  assert.doesNotMatch(page, /127\.0\.0\.1:8035/);
  assert.match(webServer, /proxyEngineRequest/);
  assert.match(webServer, /ASTER 数据接口仅允许本机访问/);
});

test("AI research is a formal left navigation entry and tool icons are removed", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /primaryPages[^\n]*"forward", "ai"/);
  assert.doesNotMatch(page, /utilityPages|rail-tools/);
  assert.match(page, /接口状态正常/);
  const aiSection = page.slice(page.indexOf("function AIResearch"), page.indexOf("function PreopenNewsColumn"));
  assert.ok(aiSection.indexOf("支持证据") < aiSection.indexOf("数据来源与接口状态"));
  assert.match(aiSection, /item\.title\|\|item\.type/);
});

test("all public factors have unique keys and Chinese meanings", async () => {
  const { factorDefinitions } = await import("../engine/core.mjs");
  assert.equal(factorDefinitions.length, 50);
  assert.equal(new Set(factorDefinitions.map((item) => item.key)).size, factorDefinitions.length);
  for (const factor of factorDefinitions) {
    assert.match(factor.name, /[\u3400-\u9fff]/);
    assert.ok(factor.group);
    assert.ok(factor.unit);
  }
});

test("chip workspace replaces the legacy panel with the exact migrated similarity scanner", async () => {
  const [page, adapter, algorithm, provider, scheduler, referenceBridge] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../python_engine/kline_similarity_exact_task.py", import.meta.url), "utf8"),
    readFile(new URL("../python_engine/vendor_exact/machine_stock_picker_similarity/runtime/signal_desk/aia/similarity.py", import.meta.url), "utf8"),
    readFile(new URL("../python_engine/vendor_exact/machine_stock_picker_similarity/runtime/signal_desk/adapters/sources/market_history.py", import.meta.url), "utf8"),
    readFile(new URL("../engine/scheduler.mjs", import.meta.url), "utf8"),
    readFile(new URL("../engine/reference_similarity.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /筹码与K线分布/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /筹码模型/);
  assert.match(page, /筹码正负样本与训练管理/);
  assert.match(page, /当前没有正样本/);
  assert.match(page, /未训练·未上线/);
  assert.match(page, /选择筹码模型/);
  assert.match(page, /按正负标签筛选样本/);
  assert.match(page, /此操作只影响该模型的样本库/);
  assert.doesNotMatch(page, /\/chip\/rankings\?scope=/);
  assert.doesNotMatch(page, /FULL MARKET RANK/);
  assert.match(page, /K线相似度/);
  assert.match(page, /chip-workspace-panel/);
  assert.match(page, /kline-workspace-panel/);
  assert.match(page, /kline-workspace-panel[^]*?<UsbKline\/>/);
  assert.match(page, /当前相似走势选股/);
  const usbPage = page.slice(page.indexOf("function UsbKline"), page.indexOf("function AIResearch"));
  assert.match(usbPage, /<option value="50">Top 50<\/option>/);
  assert.match(page, /type="date"/);
  assert.match(usbPage, /name="start_date" type="date"/);
  assert.match(usbPage, /name="end_date" type="date"/);
  assert.match(page, /data-ma-period/);
  assert.match(page, /MA250年线/);
  assert.match(page, /拖动平移 \/ 滚轮缩放/);
  assert.match(page, /new ResizeObserver\(sync\)/);
  assert.match(page, /height:`\$\{plotHeight\}px`/);
  assert.doesNotMatch(page, /人工复核评分|similarity-rating/);
  assert.doesNotMatch(usbPage, /similarityQa/);
  assert.doesNotMatch(page, /utilityPages[^\n]*"kline"/);
  assert.match(adapter, /_complete_chart_warmup/);
  assert.match(algorithm, /def score_window/);
  assert.match(algorithm, /def constrained_elastic_similarity/);
  assert.match(provider, /tencent_thirty_minute_limit = 640/);
  assert.match(scheduler, /similarity_cache_incremental_refresh','K线相似度自动增量缓存'/);
  assert.match(scheduler, /每15分钟；单实例；每批120只/);
  assert.match(referenceBridge, /if \(!securityCode \|\| !knownSecurity\.get\(securityCode\)\) return/);
});

test("chip charts use the stock-detail percentage scale and all runtime chips are independently recurred", async () => {
  const [page, marketSync, provider, realtimeApp, dataSources] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../python_engine/market_sync.py", import.meta.url), "utf8"),
    readFile(new URL("../engine/market_provider_bridge.py", import.meta.url), "utf8"),
    readFile(new URL("../python_engine/vendor_exact/quant_mvp/app.py", import.meta.url), "utf8"),
    readFile(new URL("../engine/data_sources.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /横轴为真实筹码占比/);
  assert.match(page, /\(tick \* 100\)\.toFixed\(percentDigits\).*%/);
  assert.doesNotMatch(page, /ratio \/ peak/);
  assert.match(marketSync, /independent_close_chip_recurrence/);
  assert.doesNotMatch(marketSync, /ingest_bigquant_chips/);
  assert.match(provider, /refusing sparse BigQuant point fallback/);
  assert.match(provider, /reconstruct_chip_distribution/);
  const realtimeSeedLoader = realtimeApp.slice(
    realtimeApp.indexOf("def _load_realtime_chip_seed_inputs"),
    realtimeApp.indexOf("def _compute_live_observation_chip_factors_isolated"),
  );
  assert.match(realtimeSeedLoader, /FROM current_chip_distribution/);
  assert.doesNotMatch(realtimeSeedLoader, /FROM chip_distribution\b/);
  assert.doesNotMatch(realtimeApp, /akshare_realtime\+bigquant_seed/);
  assert.match(dataSources, /DELETE FROM chip_axes_snapshot WHERE trade_date=/);
  assert.match(dataSources, /DELETE FROM chip_model_rank_daily WHERE trade_date=/);
});
