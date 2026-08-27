import process from "node:process";
import { randomUUID } from "node:crypto";

const dateIndex = process.argv.indexOf("--date");
const targetDate = dateIndex >= 0 ? String(process.argv[dateIndex + 1] || "") : "";
if (targetDate && !/^20\d{2}-\d{2}-\d{2}$/.test(targetDate)) throw new Error("开盘啦日期格式无效");

const body = new URLSearchParams({
  a: "GetPlateInfo_w38",
  st: "100",
  c: "DailyLimitResumption",
  PhoneOSNew: "1",
  DeviceID: randomUUID(),
  VerSion: "5.21.0.2",
  Index: "0",
  apiv: "w42",
});
if (targetDate) body.set("Day", targetDate);

const response = await fetch("https://apphwhq.longhuvip.com/w1/api/index.php", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent": "Dalvik/2.1.0 (Linux; Android 9) Aster/1.0",
    Accept: "application/json",
  },
  body,
  signal: AbortSignal.timeout(18_000),
});
if (!response.ok) throw new Error(`开盘啦接口 HTTP ${response.status}`);
const payload = await response.json();
if (String(payload?.errcode ?? "") !== "0") throw new Error(`开盘啦接口错误 ${payload?.errcode ?? "unknown"}`);

const candidates = [];
const seen = new Set();
for (const [sectorIndex, sector] of (Array.isArray(payload.list) ? payload.list : []).entries()) {
  const sectorName = String(sector?.ZSName || "").trim();
  for (const [stockIndex, stock] of (Array.isArray(sector?.StockList) ? sector.StockList : []).entries()) {
    if (!Array.isArray(stock) || stock.length < 2) continue;
    const code = String(stock[0] || "").replace(/\D/g, "").slice(-6);
    const name = String(stock[1] || "").trim();
    if (!code || !name || seen.has(code)) continue;
    seen.add(code);
    candidates.push({
      code,
      name,
      sector: sectorName,
      sectorIndex,
      stockIndex,
      mainFund: Number(stock[13] || 0),
    });
  }
}
candidates.sort((left, right) => left.sectorIndex - right.sectorIndex || right.mainFund - left.mainFund || left.stockIndex - right.stockIndex);
const items = candidates.slice(0, 10).map((stock, index) => ({
  rank: index + 1,
  name: stock.name,
  code: stock.code,
  heat: stock.mainFund ? `${(stock.mainFund / 100_000_000).toFixed(2)}亿主力` : stock.sector,
  change: stock.sector,
}));
if (!items.length) throw new Error("开盘啦接口未返回可用股票");

process.stdout.write(JSON.stringify({
  ok: true,
  source_date: String(payload.date || payload.Day || targetDate),
  items,
}));
