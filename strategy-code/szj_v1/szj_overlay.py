"""SZJ-v1 close-based loss and trailing-exit signal example.

Adapted from a frozen personal-research risk overlay. The component accepts
continuous adjusted marks and emits close-based decisions.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def first_exit_signal(
    features: pd.DataFrame,
    signal_date: pd.Timestamp,
    original_exit_date: pd.Timestamp | None = None,
    *,
    loss_limit: float = 0.20,
    trail_activation: float = 0.40,
    trail_distance: float = 0.25,
) -> pd.Timestamp:
    """Return the first additional exit-signal date, or pd.NaT.

    features must use a unique, increasing DatetimeIndex, numeric mark
    (continuous adjusted close) and boolean valid (observed price).
    Stale observations must carry forward the last known mark and be invalid.

    The reference is the confirmation-day close, not an average fill cost.
    Only later valid observations can trigger. An original exit on the same
    or an earlier date takes precedence. Returned dates represent decisions.
    """
    if not isinstance(features.index, pd.DatetimeIndex):
        raise TypeError("features must use a DatetimeIndex")
    if not features.index.is_unique or not features.index.is_monotonic_increasing:
        raise ValueError("price dates must be unique and increasing")
    if not {"mark", "valid"}.issubset(features.columns):
        raise ValueError("features must contain mark and valid")
    if not pd.api.types.is_numeric_dtype(features["mark"]):
        raise TypeError("mark must be numeric")
    if not pd.api.types.is_bool_dtype(features["valid"]) or features["valid"].isna().any():
        raise TypeError("valid must contain non-missing booleans")
    if not (
        0 < loss_limit < 1
        and 0 <= trail_activation
        and np.isfinite(trail_activation)
        and 0 < trail_distance < 1
    ):
        raise ValueError("exit thresholds must be finite and within their stated ranges")

    signal_date = pd.Timestamp(signal_date)
    if pd.isna(signal_date) or signal_date not in features.index:
        return pd.NaT
    window = features.loc[signal_date:]
    reference = window["mark"].iloc[0]
    if not np.isfinite(reference) or reference <= 0:
        return pd.NaT

    marks = window["mark"]
    running_peak = marks.cummax()
    loss_hit = marks.le(reference * (1 - loss_limit))
    armed = running_peak.ge(reference * (1 + trail_activation))
    trailing_hit = armed & marks.le(running_peak * (1 - trail_distance))
    eligible = window["valid"] & marks.gt(0) & np.isfinite(marks)
    eligible &= window.index > signal_date
    if original_exit_date is not None and pd.notna(original_exit_date):
        eligible &= window.index < pd.Timestamp(original_exit_date)
    hits = window.index[(loss_hit | trailing_hit) & eligible]
    return hits[0] if len(hits) else pd.NaT
