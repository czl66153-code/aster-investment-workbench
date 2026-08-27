import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateRankPayload, enhanceSectorsWithGraph, getSectorStockRank, nextTradingCutoff, paginateRankPayload } from "../engine/sector_stock_rank.mjs";

const dates = (() => {
  const result = [];
  let cursor = new Date("2026-08-21T12:00:00Z");
  while (result.length < 61) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) result.unshift(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return result;
})();

function fixture() {
  const securities = [];
  const bars = [];
  for (let group = 0; group < 2; group += 1) {
    for (let index = 1; index <= 6; index += 1) {
      const symbol = `${group + 1}${String(index).padStart(5, "0")}`;
      const code = `${symbol}.${group ? "SZ" : "SH"}`;
      securities.push({ code, symbol, name: group === 0 && index === 6 ? "*ST样本" : `样本${group}-${index}`, industry: group ? "高弹性" : "稳健制造" });
      dates.forEach((trade_date, day) => bars.push({ code, trade_date, close: 10 * (1 + (group + 1) / 100) ** day }));
    }
  }
  return { securities, bars };
}

test("uses exact trading-date bars, exposes four daily gains, and filters ST stocks", () => {
  const { securities, bars } = fixture();
  const sectors = [
    { sector_code: "A", sector_name: "稳健制造", stock_members: securities.slice(0, 6).map((row) => row.code), stock_member_count: 6, sector_main_industry: "制造", sector_chain_tag: "中游" },
    { sector_code: "B", sector_name: "高弹性", stock_members: securities.slice(6).map((row) => row.code), stock_member_count: 6, sector_main_industry: "科技", sector_chain_tag: "上游" },
  ];
  const payload = calculateRankPayload({ tradeDates: dates, bars, securities, sectors, updateTime: "2026-08-21T07:35:00.000Z" });
  assert.equal(payload.calc_trade_date, "2026-08-21");
  assert.equal(payload.sector_rank.sector_3d_gain_list[0].sector_code, "B");
  assert.equal(payload.sector_rank.sector_4d_streak_top10[0].sector_4d_avg_gain, 2);
  assert.deepEqual(payload.sector_rank.sector_4d_streak_top10[0].sector_4d_daily_gains, dates.slice(-4).map((trade_date) => ({ trade_date, gain: 2 })));
  assert.equal(payload.sector_rank.sector_4d_streak_top10.every((row) => row.sector_4d_daily_gains.every((day) => day.gain > 0)), true);
  assert.equal(payload.sector_rank.sector_3d_gain_list[0].sector_3d_gain, 6.1208);
  assert.equal(payload.stock_rank.stock_10d_gain_list.length, 11);
  assert.equal(payload.stock_rank.stock_30d_gain_list.length, 11);
  assert.equal(payload.stock_rank.stock_60d_gain_list.length, 11);
  assert.equal(payload.sector_rank.sector_60d_gain_list[0].sector_code, "B");
  assert.equal(payload.stock_rank.stock_10d_gain_list.some((row) => row.stock_name.includes("ST")), false);
  assert.deepEqual(Object.keys(payload.stock_rank.stock_3d_gain_list[0]).sort(), ["stock_10d_gain", "stock_30d_gain", "stock_3d_gain", "stock_5d_gain", "stock_60d_gain", "stock_code", "stock_name"].sort());
  assert.equal(payload.data_source_note.includes("不构成投资建议"), true);
});

test("excludes a sector whose four-day average is positive but one day declined", () => {
  const { securities, bars } = fixture();
  const firstSectorCodes = new Set(securities.slice(0, 6).map((row) => row.code));
  const barsWithOneDecline = bars.map((row) => firstSectorCodes.has(row.code) && row.trade_date === dates.at(-2)
    ? { ...row, close: 10 * 1.01 ** 8 * .99 }
    : row);
  const sectors = [
    { sector_code: "A", sector_name: "稳健制造", stock_members: securities.slice(0, 6).map((row) => row.code), stock_member_count: 6 },
    { sector_code: "B", sector_name: "高弹性", stock_members: securities.slice(6).map((row) => row.code), stock_member_count: 6 },
  ];
  const payload = calculateRankPayload({ tradeDates: dates, bars: barsWithOneDecline, securities, sectors });
  const ordinary = payload.sector_rank.sector_3d_gain_list.find((row) => row.sector_code === "A");
  assert.ok(ordinary.sector_4d_avg_gain > 0);
  assert.equal(ordinary.sector_4d_daily_gains.some((day) => day.gain < 0), true);
  assert.equal(payload.sector_rank.sector_4d_streak_top10.some((row) => row.sector_code === "A"), false);
  assert.equal(payload.sector_rank.sector_4d_streak_top10.some((row) => row.sector_code === "B"), true);
});

test("normalizes 8002 graph members, attaches tags, and removes undersized sectors", async () => {
  const { securities } = fixture();
  const raw = [
    { sector_code: "RAW-A", sector_name: "稳健制造", stock_members: securities.slice(0, 6).map((row) => row.code), stock_member_count: 6, sector_main_industry: "", sector_chain_tag: "" },
  ];
  const result = await enhanceSectorsWithGraph(raw, securities, {
    endpoint: "http://graph.test/enhance",
    fetchImpl: async () => ({ ok: true, json: async () => ({ sectors: [
      { sector_code: "KG-A", sector_name: "先进制造", aliases: ["稳健制造"], stock_codes: securities.slice(0, 6).map((row) => row.symbol), sector_main_industry: "高端制造", sector_chain_tag: "中游设备" },
      { sector_code: "KG-X", sector_name: "无效概念", stock_codes: securities.slice(0, 4).map((row) => row.symbol) },
    ] }) }),
  });
  assert.equal(result.status, "success");
  assert.equal(result.sectors.length, 1);
  assert.equal(result.sectors[0].sector_name, "先进制造");
  assert.equal(result.sectors[0].sector_main_industry, "高端制造");
  assert.equal(result.sectors[0].stock_members[0].includes("."), true);
});

test("graph failure degrades to raw sectors and pagination keeps four-day list at top 10", async () => {
  const { securities, bars } = fixture();
  const raw = [{ sector_code: "RAW-A", sector_name: "稳健制造", stock_members: securities.slice(0, 6).map((row) => row.code), stock_member_count: 6, sector_main_industry: "", sector_chain_tag: "" }];
  const graph = await enhanceSectorsWithGraph(raw, securities, { endpoint: "http://graph.test", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(graph.status, "degraded");
  assert.equal(graph.sectors, raw);
  const payload = calculateRankPayload({ tradeDates: dates, bars, securities, sectors: raw });
  const page = paginateRankPayload(payload, { stockPage: 2, stockPageSize: 4, sectorPageSize: 1 });
  assert.equal(page.stock_rank.stock_3d_gain_list.length, 4);
  assert.equal(page.stock_rank.stock_30d_gain_list.length, 4);
  assert.equal(page.stock_rank.stock_60d_gain_list.length, 4);
  assert.ok(page.sector_rank.sector_4d_streak_top10.length <= 10);
  assert.ok(page.sector_rank.sector_4d_avg_top10.length <= 10);
  assert.equal(nextTradingCutoff("2026-08-21").toISOString(), "2026-08-24T07:35:00.000Z");
});

test("GET repairs a legacy cache whose stock cumulative lists are missing", async () => {
  const { securities, bars } = fixture();
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "engine", "schema.sql"), "utf8"));
  const insertSecurity = db.prepare("INSERT INTO securities(code,symbol,name,market,industry) VALUES(?,?,?,'测试市场',?)");
  securities.forEach((row) => insertSecurity.run(row.code, row.symbol, row.name, row.industry));
  const insertBar = db.prepare("INSERT INTO bars_daily(code,trade_date,open,high,low,close,volume,amount,source) VALUES(?,?,?,?,?,?,100,1000,'bigquant+tushare')");
  bars.forEach((row) => insertBar.run(row.code, row.trade_date, row.close, row.close, row.close, row.close));
  db.prepare("INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,status,source,quality_score,created_at,published_at) VALUES('formal_daily','formal-rank','2026-08-21',12,'published','bigquant+tushare',100,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  const legacy = { ...emptyLegacyPayload(), calc_trade_date: "2026-08-21", stock_rank: {} };
  db.prepare("INSERT INTO sector_stock_rank_cache(cache_key,calc_trade_date,update_time,expires_at,payload_json) VALUES('aster:sector_stock_multi_rank:latest','2026-08-21',CURRENT_TIMESTAMP,'2026-08-24T07:35:00.000Z',?)").run(JSON.stringify(legacy));

  const repaired = await getSectorStockRank(db, { stockPageSize: 50 });
  assert.equal(repaired.stock_rank.stock_3d_gain_list.length, 11);
  assert.equal(repaired.stock_rank.stock_5d_gain_list.length, 11);
  assert.equal(repaired.stock_rank.stock_10d_gain_list.length, 11);
  assert.equal(repaired.stock_rank.stock_30d_gain_list.length, 11);
  assert.equal(repaired.stock_rank.stock_60d_gain_list.length, 11);
  const stored = JSON.parse(db.prepare("SELECT payload_json FROM sector_stock_rank_cache WHERE cache_key='aster:sector_stock_multi_rank:latest'").get().payload_json);
  assert.equal(stored.stock_rank.stock_3d_gain_list.length, 11);
  db.close();
});

function emptyLegacyPayload() {
  return {
    calc_trade_date: "2026-08-21",
    update_time: "2026-08-21T07:35:00.000Z",
    sector_rank: { sector_3d_gain_list: [], sector_5d_gain_list: [], sector_10d_gain_list: [], sector_30d_gain_list: [], sector_60d_gain_list: [], sector_4d_streak_top10: [], sector_4d_avg_top10: [] },
    stock_rank: { stock_3d_gain_list: [], stock_5d_gain_list: [], stock_10d_gain_list: [], stock_30d_gain_list: [], stock_60d_gain_list: [] },
    data_source_note: "测试",
  };
}

test("adapts the existing 8002 industry graph snapshot without replacing unmatched raw sectors", async () => {
  const { securities } = fixture();
  const raw = [
    { sector_code: "RAW-A", sector_name: "稳健制造", stock_members: securities.slice(0, 6).map((row) => row.code), stock_member_count: 6, sector_main_industry: "", sector_chain_tag: "" },
    { sector_code: "RAW-B", sector_name: "高弹性", stock_members: securities.slice(6).map((row) => row.code), stock_member_count: 6, sector_main_industry: "", sector_chain_tag: "" },
  ];
  const result = await enhanceSectorsWithGraph(raw, securities, {
    endpoint: "http://127.0.0.1:8002/api/industry-knowledge-graphs",
    tradeDate: "2026-08-21",
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "GET");
      assert.match(String(url), /date=20260821/);
      return { ok: true, json: async () => ({ industries: [{ name: "先进制造", recommended_stocks: [{ stock_code: securities[0].symbol }], chain: [{ stage: "上游" }, { stage: "中游" }] }] }) };
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.sectors.length, 2);
  const enhanced = result.sectors.find((row) => row.sector_name === "先进制造");
  assert.equal(enhanced.sector_main_industry, "先进制造");
  assert.equal(enhanced.sector_chain_tag, "上游 / 中游");
  assert.equal(result.sectors.some((row) => row.sector_code === "RAW-B"), true);
});
