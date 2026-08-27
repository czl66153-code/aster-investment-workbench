import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providerCapabilities, runProviderBridge } from "../engine/provider_bridge.mjs";
import { nextSundayMidnight } from "../engine/scheduler.mjs";

const featureColumns = [
  "win_percent", "chip_density_70", "avg_window_density_4pct", "avg_window_density_10pct",
  "raw_main_peak_height", "raw_peak_width_70", "raw_peak2_ratio", "raw_peak_valley_ratio",
  "raw_peak_valley_depth", "raw_peak_separation_ratio", "raw_peak_separation_widths", "raw_peak_count",
  "raw_peak_mass_1pct", "raw_peak_mass_2pct", "raw_peak_mass_4pct", "raw_peak_symmetry_1pct",
  "raw_peak_symmetry_2pct", "raw_peak_symmetry_4pct", "raw_main_peak_local_share_2pct",
  "raw_profile_hhi", "raw_profile_entropy", "raw_peak_global_balance", "raw_close_main_peak_gap_ratio",
];

test("provider bridge imports without network and never returns credential values", async () => {
  const payload = await providerCapabilities();
  assert.equal(payload.ok, true);
  assert.ok(payload.commands.includes("formal-daily"));
  assert.ok(payload.commands.includes("warehouse-publish-official"));
  assert.ok(payload.commands.includes("intraday-quotes"));
  assert.ok(payload.commands.includes("score-chip-models"));
  assert.equal(payload.credential_policy, "environment_or_sdk_store_only");
  assert.deepEqual(Object.keys(payload.credentials).sort(), ["bigquant_environment", "tushare_environment"]);
});

test("weekly provider quota resumes at Sunday 24:00 Shanghai without AI", () => {
  assert.equal(nextSundayMidnight(new Date("2026-08-22T04:00:00.000Z")), "2026-08-23T16:00:00.000Z");
  assert.equal(nextSundayMidnight(new Date("2026-08-23T15:59:00.000Z")), "2026-08-23T16:00:00.000Z");
});

test("chip production keeps one scorer and one managed retrainer entry", async () => {
  const bridge = await readFile(new URL("../engine/market_provider_bridge.py", import.meta.url), "utf8");
  const core = await readFile(new URL("../engine/core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bridge, /def _score_chip_scope\b/);
  assert.doesNotMatch(core, /export function retrainChipModels\b/);
  assert.match(bridge, /from quant_mvp\.chip_shape_score import _score_shape_panel_with_model/);
});

test("formal and candidate joblib assets score the same complete panel", async (context) => {
  const capabilities = await providerCapabilities();
  if (!capabilities.packages.joblib || !capabilities.packages.sklearn || !capabilities.packages.pandas) {
    context.skip("market Python does not include local model runtime");
    return;
  }
  const rows = Array.from({ length: 24 }, (_, index) => {
    const features = Object.fromEntries(featureColumns.map((column, offset) => [column, column === "raw_peak_count" ? 1 + index % 5 : ((index * 13 + offset * 7) % 97 + 1) / 100]));
    return {
      code: `${String(index + 1).padStart(6, "0")}.SZ`, trade_date: "2026-08-20",
      shape_sharpness: .2 + index / 100, shape_compactness: .3 + index / 120,
      shape_symmetry: .4 + index / 140, shape_single_peak: .5 + index / 160,
      shape_profit_quality: .35 + index / 110, features,
    };
  });
  const payload = await runProviderBridge("score-chip-models", { rows }, { timeoutMs: 60_000 });
  assert.equal(payload.rows.length, rows.length);
  assert.match(payload.formal_model_version, /extratrees/i);
  assert.match(payload.candidate_model_version, /extratrees/i);
  assert.equal(new Set(payload.rows.map((row) => row.formal_rank)).size, rows.length);
  assert.equal(new Set(payload.rows.map((row) => row.candidate_rank)).size, rows.length);
  assert.ok(payload.rows.every((row) => Number.isFinite(row.formal_score) && Number.isFinite(row.candidate_score)));
});
