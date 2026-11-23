"""Run ABCD Core V3 on deterministic synthetic, point-in-time inputs."""

from __future__ import annotations

import numpy as np
import pandas as pd

from abcd_core_v3 import DEFAULT_CONFIG, RULE_VERSION, score_abcd_snapshot, select_abcd_candidates


def make_synthetic_snapshot() -> pd.DataFrame:
    """Create artificial symbols and prices without using market observations."""
    rows = []
    for number in range(1, 21):
        sector = (number - 1) // 4
        rows.append(
            {
                "trade_time": pd.Timestamp("2030-01-08 09:35:00"),
                "factor_time": pd.Timestamp("2030-01-08 09:35:00"),
                "heat_source_time": pd.Timestamp("2030-01-08 09:30:00"),
                "previous_source_time": pd.Timestamp("2030-01-07 15:00:00"),
                "ts_code": f"SYNTH_{number:02d}",
                "industry": f"SECTOR_{sector + 1}",
                "industry_return_rt": 0.002 * (sector + 1),
                "industry_breadth_rt": 0.45 + 0.08 * sector,
                "industry_return_5m": 0.0005 * (5 - sector),
                "industry_amount_ratio": 1.0 + 0.2 * sector,
                "industry_return_4d": 0.01 * (sector + 1),
                "previous_heat_score": 40.0 + number,
                "ths_heat_score_asof": 45.0 + 2 * number,
                "stock_return_rt": 0.001 * number,
                "stock_cum_amount": 1_000_000.0 * (number + 1),
                "limit_event_score": 60.0 if number % 3 == 0 else 50.0,
                "lhb_logic_score": 65.0 if number % 4 == 0 else 50.0,
                "d_rank": number,
                "d_rank_pct": 100.0 * number / 1_000,
                "is_st": number == 1,
                "is_suspended": number == 2,
                "entry_limit_up": number == 3,
            }
        )
    return pd.DataFrame(rows)


def require_asof_inputs(panel: pd.DataFrame) -> None:
    """The caller checks source times before passing the panel to the scorer."""
    for column in ("factor_time", "heat_source_time"):
        if panel[column].isna().any() or panel[column].gt(panel["trade_time"]).any():
            raise ValueError(f"{column} must be known by the signal time")
    previous_day = panel["trade_time"].dt.normalize()
    if panel["previous_source_time"].isna().any() or panel["previous_source_time"].ge(previous_day).any():
        raise ValueError("Previous-day inputs must predate the signal date")


def verify_example(panel: pd.DataFrame, scored: pd.DataFrame, selected: pd.DataFrame) -> None:
    """Check the scoring and selection contract on this synthetic snapshot."""
    expected_d = (100.0 * (15 - scored["d_rank"]) / 14).clip(0, 100).round(2)
    np.testing.assert_allclose(scored["d_score"], expected_d)
    expected_core = (
        0.10 * scored["a_score"]
        + 0.10 * scored["b_core_score"]
        + 0.10 * scored["c_score"]
        + 0.70 * scored["d_score"]
    ).round(2)
    np.testing.assert_allclose(scored["core_score"], expected_core)
    assert len(selected) == DEFAULT_CONFIG.output_count
    assert selected["d_rank"].between(1, 15).all()
    assert selected.groupby("industry").size().le(2).all()
    assert not selected[["is_st", "is_suspended", "entry_limit_up"]].any().any()
    assert selected["rule_version"].eq(RULE_VERSION).all()

    # Outcome labels must never influence the candidate set or its order.
    with_outcomes = panel.assign(future_return=np.linspace(-0.25, 0.25, len(panel)))
    reordered = select_abcd_candidates(score_abcd_snapshot(with_outcomes))
    assert selected["ts_code"].tolist() == reordered["ts_code"].tolist()
    assert "live_heat_consensus" not in panel
    np.testing.assert_allclose(scored["live_score"], scored["core_score"])

    late_panel = panel.copy()
    late_panel.loc[0, "factor_time"] = pd.Timestamp("2030-01-08 09:40:00")
    try:
        require_asof_inputs(late_panel)
    except ValueError:
        pass
    else:
        raise AssertionError("A post-signal input was accepted")


def main() -> None:
    panel = make_synthetic_snapshot()
    require_asof_inputs(panel)
    scored = score_abcd_snapshot(panel)
    selected = select_abcd_candidates(scored)
    verify_example(panel, scored, selected)
    columns = ["abcd_rank", "ts_code", "industry", "a_score", "b_core_score", "c_score", "d_score", "core_score"]
    print(RULE_VERSION)
    print(selected[columns].to_string(index=False))
    print("Synthetic checks passed: as-of times, formula, D gate, exclusions, diversification, outcome independence.")


if __name__ == "__main__":
    main()
