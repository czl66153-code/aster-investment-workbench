from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd


RULE_VERSION = "abcd_core_v3_validated_20260815"


@dataclass(frozen=True)
class AbcdRuleConfig:
    """Auditable weights for the point-in-time ABCD ranking rule."""

    d_candidate_rank: int = 15
    output_count: int = 5
    max_per_industry: int = 2
    a_weight: float = 0.10
    b_weight: float = 0.10
    c_weight: float = 0.10
    d_weight: float = 0.70
    live_overlay_weight: float = 0.15


DEFAULT_CONFIG = AbcdRuleConfig()


def scoring_contract(config: AbcdRuleConfig = DEFAULT_CONFIG) -> dict[str, Any]:
    """Return the formal rule and data-timing contract used by research and live code."""

    return {
        "version": RULE_VERSION,
        "candidate_pool": f"latest completed five-minute D rank top {config.d_candidate_rank}",
        "core_formula": (
            f"Core = {config.a_weight:.0%}*A + {config.b_weight:.0%}*B_core + "
            f"{config.c_weight:.0%}*C + {config.d_weight:.0%}*D"
        ),
        "live_formula": (
            f"Live = {(1.0 - config.live_overlay_weight):.0%}*Core + "
            f"{config.live_overlay_weight:.0%}*B_live"
        ),
        "selection": {
            "count": config.output_count,
            "max_per_industry": config.max_per_industry,
            "sort": "core_score, d_score descending",
            "live_overlay_policy": "display-only until enough archived history exists",
        },
        "A": {
            "name": "sector strength",
            "weights": {
                "realtime_sector_return": 0.30,
                "realtime_sector_breadth": 0.20,
                "sector_5m_acceleration": 0.15,
                "sector_amount_acceleration": 0.15,
                "previous_sector_4d_return": 0.20,
            },
            "timing": "current bars through snapshot; 4-day return ends on T-1",
        },
        "B_core": {
            "name": "backtestable attention",
            "weights": {
                "previous_bigquant_full_market_heat": 0.55,
                "tushare_ths_rank_asof_snapshot": 0.30,
                "heat_acceleration": 0.15,
            },
            "timing": "T-1 BigQuant plus Tushare THS rows whose source_time <= snapshot",
        },
        "B_live": {
            "name": "multi-source live attention overlay",
            "sources": [
                "previous BigQuant heat",
                "Tushare/THS intraday history",
                "THS live",
                "Eastmoney Guba",
                "Taoguba",
                "Xueqiu",
                "Kaipanla when a lawful stable adapter is available",
            ],
            "timing": "only snapshots observed no later than the score time",
            "backtest_policy": (
                "short-history sources are archived separately and never backfilled with today's values; "
                "the two-year core score remains reproducible without them"
            ),
        },
        "C": {
            "name": "leadership and event logic",
            "weights": {
                "industry_relative_return_rank": 0.30,
                "industry_relative_amount_rank": 0.20,
                "return_lead_over_industry": 0.20,
                "limit_or_market_event": 0.10,
                "previous_day_lhb": 0.20,
            },
            "timing": "intraday fields through snapshot; LHB must be published by T-1 close",
        },
        "D": {
            "name": "chip shape",
            "formula": (
                f"first keep current v16 rank top {config.d_candidate_rank}; then D = "
                f"100*({config.d_candidate_rank}-rank)/({config.d_candidate_rank}-1) inside that pool"
            ),
            "timing": "latest completed five-minute factor snapshot only",
        },
        "hard_guards": [
            "exclude ST and suspended securities",
            "exclude entries locked at the upper price limit",
            "require fresh D model version and factor_time <= signal_time",
            "never use target-day close, future heat snapshots, or same-day post-close LHB",
        ],
    }


def _numeric(frame: pd.DataFrame, column: str, default: float = np.nan) -> pd.Series:
    if column not in frame:
        return pd.Series(default, index=frame.index, dtype=float)
    return pd.to_numeric(frame[column], errors="coerce")


def _neutral(values: pd.Series, neutral: float = 50.0) -> pd.Series:
    return pd.to_numeric(values, errors="coerce").fillna(neutral).clip(0, 100)


def _percentile(
    frame: pd.DataFrame,
    values: pd.Series,
    *,
    snapshot_column: str,
    higher_is_better: bool = True,
) -> pd.Series:
    numeric = pd.to_numeric(values, errors="coerce")
    rank = numeric.groupby(frame[snapshot_column], sort=False).rank(
        method="average", pct=True, ascending=higher_is_better
    )
    return (100.0 * rank).fillna(50.0).clip(0, 100)


def _industry_percentile(
    frame: pd.DataFrame,
    value_column: str,
    *,
    snapshot_column: str,
) -> pd.Series:
    compact = frame[[snapshot_column, "industry"]].copy()
    compact["_value"] = _numeric(frame, value_column)
    compact = compact.drop_duplicates([snapshot_column, "industry"], keep="last")
    compact["_score"] = _percentile(
        compact,
        compact["_value"],
        snapshot_column=snapshot_column,
    )
    key = pd.MultiIndex.from_frame(frame[[snapshot_column, "industry"]])
    lookup = compact.set_index([snapshot_column, "industry"])["_score"]
    return pd.Series(lookup.reindex(key).to_numpy(), index=frame.index).fillna(50.0)


def score_abcd_snapshot(
    frame: pd.DataFrame,
    *,
    snapshot_column: str = "trade_time",
    config: AbcdRuleConfig = DEFAULT_CONFIG,
) -> pd.DataFrame:
    """Score a point-in-time candidate panel without reading future data.

    The caller supplies raw as-of fields. Missing optional sources receive a
    neutral score, while D is mandatory and controls the candidate universe.
    """

    required = {snapshot_column, "ts_code", "industry"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"ABCD panel is missing required columns: {', '.join(missing)}")

    result = frame.copy()
    result["industry"] = result["industry"].fillna("unclassified").astype(str)

    a_sector_return = _industry_percentile(
        result, "industry_return_rt", snapshot_column=snapshot_column
    )
    a_breadth = _industry_percentile(
        result, "industry_breadth_rt", snapshot_column=snapshot_column
    )
    a_acceleration = _industry_percentile(
        result, "industry_return_5m", snapshot_column=snapshot_column
    )
    a_amount = _industry_percentile(
        result, "industry_amount_ratio", snapshot_column=snapshot_column
    )
    a_recent = _industry_percentile(
        result, "industry_return_4d", snapshot_column=snapshot_column
    )
    result["a_score"] = (
        0.30 * a_sector_return
        + 0.20 * a_breadth
        + 0.15 * a_acceleration
        + 0.15 * a_amount
        + 0.20 * a_recent
    ).round(2)

    previous_heat = _neutral(_numeric(result, "previous_heat_score"))
    ths_heat = _neutral(_numeric(result, "ths_heat_score_asof"))
    heat_change = _percentile(
        result,
        ths_heat - previous_heat,
        snapshot_column=snapshot_column,
    )
    result["b_core_score"] = (
        0.55 * previous_heat + 0.30 * ths_heat + 0.15 * heat_change
    ).round(2)

    stock_return = _numeric(result, "stock_return_rt")
    stock_amount = _numeric(result, "stock_cum_amount")
    industry_keys = [result[snapshot_column], result["industry"]]
    leader_return = (
        100.0
        * stock_return.groupby(industry_keys, sort=False).rank(method="average", pct=True)
    ).fillna(50.0)
    leader_amount = (
        100.0
        * stock_amount.groupby(industry_keys, sort=False).rank(method="average", pct=True)
    ).fillna(50.0)
    lead_gap = stock_return - _numeric(result, "industry_return_rt")
    lead_gap_score = _percentile(
        result, lead_gap, snapshot_column=snapshot_column
    )
    if "industry_relative_return_score" in result:
        leader_return = _neutral(result["industry_relative_return_score"])
    if "industry_relative_amount_score" in result:
        leader_amount = _neutral(result["industry_relative_amount_score"])
    if "lead_gap_score" in result:
        lead_gap_score = _neutral(result["lead_gap_score"])
    event_score = _neutral(_numeric(result, "limit_event_score"))
    lhb_score = _neutral(_numeric(result, "lhb_logic_score"))
    result["c_score"] = (
        0.30 * leader_return
        + 0.20 * leader_amount
        + 0.20 * lead_gap_score
        + 0.10 * event_score
        + 0.20 * lhb_score
    ).round(2)

    d_rank_pct = _numeric(result, "d_rank_pct")
    d_rank = _numeric(result, "d_rank")
    result["d_market_score"] = (100.0 - d_rank_pct).clip(0, 100).round(2)
    if d_rank.notna().any():
        denominator = max(config.d_candidate_rank - 1, 1)
        result["d_score"] = (
            100.0 * (config.d_candidate_rank - d_rank) / denominator
        ).clip(0, 100).round(2)
    else:
        # Fallback for panels that only carry a full-market rank percentile.
        result["d_score"] = result["d_market_score"]
    result["core_score"] = (
        config.a_weight * result["a_score"]
        + config.b_weight * result["b_core_score"]
        + config.c_weight * result["c_score"]
        + config.d_weight * result["d_score"]
    ).where(d_rank_pct.notna()).round(2)

    live_heat = _numeric(result, "live_heat_consensus")
    live_available = live_heat.notna()
    result["b_live_score"] = live_heat.where(live_available, result["b_core_score"]).clip(0, 100)
    result["live_score"] = np.where(
        live_available,
        (1.0 - config.live_overlay_weight) * result["core_score"]
        + config.live_overlay_weight * result["b_live_score"],
        result["core_score"],
    ).round(2)

    d_gate = d_rank.le(config.d_candidate_rank) if d_rank.notna().any() else d_rank_pct.le(2.0)
    is_st = result.get("is_st", pd.Series(False, index=result.index)).fillna(False).astype(bool)
    suspended = result.get("is_suspended", pd.Series(False, index=result.index)).fillna(False).astype(bool)
    locked = result.get("entry_limit_up", pd.Series(False, index=result.index)).fillna(False).astype(bool)
    result["eligible"] = d_gate & result["core_score"].notna() & ~is_st & ~suspended & ~locked
    result["rule_version"] = RULE_VERSION
    return result


def select_abcd_candidates(
    scored: pd.DataFrame,
    *,
    snapshot_column: str = "trade_time",
    config: AbcdRuleConfig = DEFAULT_CONFIG,
) -> pd.DataFrame:
    """Select the diversified top names independently at each snapshot."""

    eligible = scored.loc[scored["eligible"]].copy()
    if eligible.empty:
        return eligible
    eligible = eligible.sort_values(
        [snapshot_column, "core_score", "d_score"],
        ascending=[True, False, False],
    )
    eligible["industry_pick_order"] = eligible.groupby(
        [snapshot_column, "industry"], sort=False
    ).cumcount() + 1
    eligible = eligible.loc[eligible["industry_pick_order"].le(config.max_per_industry)]
    eligible["abcd_rank"] = eligible.groupby(snapshot_column, sort=False).cumcount() + 1
    return eligible.loc[eligible["abcd_rank"].le(config.output_count)].copy()
