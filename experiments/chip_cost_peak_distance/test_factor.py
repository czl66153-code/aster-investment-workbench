from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd


MODULE_PATH = Path(__file__).with_name("run_experiment.py")
SPEC = importlib.util.spec_from_file_location("chip_cost_peak_distance_experiment", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_distance_factor_uses_same_date_cross_section_and_fallbacks() -> None:
    frame = pd.DataFrame(
        [
            {
                "ts_code": "A",
                "trade_date": "2026-08-24",
                "chip_avg_price": 10.0,
                "avg_cost": 99.0,
                "raw_main_peak_price": 11.0,
            },
            {
                "ts_code": "B",
                "trade_date": "2026-08-24",
                "chip_avg_price": np.nan,
                "avg_cost": 20.0,
                "raw_main_peak_price": np.nan,
                "chip_main_peak_price": 20.0,
            },
            {
                "ts_code": "C",
                "trade_date": "2026-08-25",
                "chip_avg_price": 30.0,
                "avg_cost": 88.0,
                "raw_main_peak_price": 33.0,
            },
        ]
    )
    result = MODULE._attach_distance_factor(frame)
    assert result.loc[0, "cost_line_price"] == 10.0
    assert result.loc[1, "cost_line_price"] == 20.0
    assert result.loc[1, "main_peak_price_for_distance"] == 20.0
    assert result.loc[0, "cost_line_main_peak_signed_distance_ratio"] == 0.1
    assert result.loc[1, "cost_line_main_peak_abs_distance_ratio"] == 0.0
    # A and B rank only against 2026-08-24; C is the sole 2026-08-25 row.
    assert result.loc[0, MODULE.NEW_FEATURE] == 1.0
    assert result.loc[1, MODULE.NEW_FEATURE] == 0.5
    assert result.loc[2, MODULE.NEW_FEATURE] == 1.0
