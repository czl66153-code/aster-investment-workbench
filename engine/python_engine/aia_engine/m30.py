"""Exact standalone port of AIA's M30 early-breakout matcher."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import fmean, mean, median
from typing import Any, Iterable, Sequence

from .assets import load_asset_manifest, resolve_asset_path


REQUIRED_FIELDS = ("open", "high", "low", "close", "volume")
MIN_TEMPLATE_CONFIDENCE = 0.65
MAX_TEMPLATE_SCORE_DELTA = 0.05


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _normalized_profile(values: Iterable[float], target_size: int = 64) -> list[float]:
    source = [float(value) for value in values]
    if not source:
        return []
    if len(source) == 1:
        sampled = [source[0]] * target_size
    else:
        sampled = []
        for index in range(target_size):
            position = index * (len(source) - 1) / (target_size - 1)
            left = int(math.floor(position))
            right = min(left + 1, len(source) - 1)
            ratio = position - left
            sampled.append(source[left] * (1.0 - ratio) + source[right] * ratio)
    low, high = min(sampled), max(sampled)
    if high - low < 1e-12:
        return [0.5] * target_size
    return [(value - low) / (high - low) for value in sampled]


def load_template_profile(path: str | Path | None = None) -> dict[str, Any]:
    if path:
        profile_path = Path(path).resolve()
    else:
        manifest = load_asset_manifest()
        manifest_path = Path(manifest["_manifest_path"])
        entry = next(item for item in manifest["assets"] if item["id"] == "m30_template_profile")
        profile_path = resolve_asset_path(entry["path"], manifest_path)
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    profile.pop("image_path", None)
    profile["profile_path"] = str(profile_path)
    return profile


def calibrate_with_template(base_score: float, core_hit: bool, closes: list[float], profile: dict[str, Any]) -> dict[str, Any]:
    confidence = _safe_float(profile.get("confidence")) or 0.0
    reference = [_safe_float(value) for value in profile.get("vector", [])]
    if not profile.get("enabled", True) or confidence < MIN_TEMPLATE_CONFIDENCE or not reference or any(value is None for value in reference):
        return {"status": "skipped", "reason": "template_disabled_or_low_confidence", "score": base_score, "hit": core_hit, "delta": 0.0}
    candidate = _normalized_profile(closes, len(reference))
    if not candidate:
        return {"status": "skipped", "reason": "empty_candidate", "score": base_score, "hit": core_hit, "delta": 0.0}
    rmse = math.sqrt(fmean((candidate[index] - float(reference[index])) ** 2 for index in range(len(reference))))
    similarity = _clamp(1.0 - rmse)
    delta = _clamp((similarity - 0.5) * 0.1, -MAX_TEMPLATE_SCORE_DELTA, MAX_TEMPLATE_SCORE_DELTA) * confidence
    return {
        "status": "applied",
        "template_id": profile.get("template_id"),
        "extractor_version": profile.get("extractor_version"),
        "confidence": round(confidence, 8),
        "similarity": round(similarity, 8),
        "delta": round(delta, 8),
        "score": round(_clamp(base_score + delta), 8),
        "hit": core_hit,
        "preserved_core_hit": True,
    }


def evaluate_m30(
    bars: Sequence[dict[str, Any]],
    *,
    template_profile: dict[str, Any] | None = None,
    ma_window: int = 20,
    platform_window: int = 24,
    breakout_lookback: int = 3,
    threshold: float = 0.72,
) -> dict[str, Any]:
    result = evaluate_m30_core(bars, ma_window=ma_window, platform_window=platform_window, breakout_lookback=breakout_lookback, threshold=threshold)
    core_hit = bool(result.get("hit"))
    core_score = result.get("score")
    calibration = None
    if template_profile is not None and core_score is not None:
        calibration = calibrate_with_template(float(core_score), core_hit, [float(row["close"]) for row in bars], template_profile)
    return {
        **result,
        "module": "m30",
        "rule_version": "aia.m30.early-breakout.v1",
        "core_hit": core_hit,
        "base_score": core_score,
        "score": calibration["score"] if calibration else core_score,
        "hit": calibration["hit"] if calibration else core_hit,
        "calibration": calibration,
    }


def evaluate_m30_core(
    bars: Sequence[dict[str, Any]],
    *,
    ma_window: int = 20,
    platform_window: int = 24,
    breakout_lookback: int = 3,
    threshold: float = 0.72,
) -> dict[str, Any]:
    required_bars = max(30, platform_window + breakout_lookback, ma_window + 7)
    if len(bars) < required_bars:
        return _unavailable(status="partial", reason="insufficient_history", required_bars=required_bars, available_bars=len(bars), threshold=threshold)
    missing = next((field for field in REQUIRED_FIELDS if any(bar.get(field) is None for bar in bars)), None)
    if missing is not None:
        return _unavailable(status="blocked", reason=f"missing_{missing}", required_bars=required_bars, available_bars=len(bars), threshold=threshold)
    time_problem = _trade_time_problem(bars)
    if time_problem is not None:
        return _unavailable(status="blocked", reason=time_problem, required_bars=required_bars, available_bars=len(bars), threshold=threshold)

    rows = [{**bar, **{field: float(bar[field]) for field in REQUIRED_FIELDS}} for bar in bars]
    closes = [row["close"] for row in rows]
    platform = rows[-(platform_window + breakout_lookback) : -breakout_lookback]
    recent = rows[-breakout_lookback:]
    platform_closes = [row["close"] for row in platform]
    platform_high = max(row["high"] for row in platform)
    platform_low = min(row["low"] for row in platform)
    platform_mid = mean(platform_closes)
    platform_width = _ratio(platform_high - platform_low, platform_mid)
    platform_slope = _linear_regression_change(platform_closes)
    close_concentration = sum(1 for close in platform_closes if _ratio(abs(close - platform_mid), platform_mid) <= 0.03) / len(platform_closes)

    breakout_level = platform_high * 1.0015
    breakout_index = next((index for index, row in enumerate(recent) if row["close"] >= breakout_level), None)
    breakout_row = recent[breakout_index] if breakout_index is not None else recent[-1]
    breakout_age = len(recent) - 1 - breakout_index if breakout_index is not None else None
    current = rows[-1]
    extension = _ratio(current["close"] - platform_high, platform_high)
    signal_range = max(breakout_row["high"] - breakout_row["low"], 0.0)
    close_position = _ratio(breakout_row["close"] - breakout_row["low"], signal_range) if signal_range > 0 else 0.0
    upper_shadow = _ratio(breakout_row["high"] - max(breakout_row["open"], breakout_row["close"]), signal_range) if signal_range > 0 else 1.0

    moving_average = _rolling_mean(closes, ma_window)
    ma20 = float(moving_average[-1])
    ma20_slope_3 = _ratio(ma20 - float(moving_average[-4]), float(moving_average[-4]))
    ma20_turn_age = _ma_turn_age(moving_average, lookback=4)
    distance_to_ma20 = _ratio(current["close"] - ma20, ma20)
    volume_baseline, volume_baseline_kind = _volume_baseline(platform, breakout_row)
    volume_ratio = _ratio(breakout_row["volume"], volume_baseline)
    recent_return_3 = _ratio(recent[-1]["close"] - recent[0]["close"], recent[0]["close"])
    consecutive_above = 0
    for row in reversed(rows):
        if row["close"] <= platform_high:
            break
        consecutive_above += 1

    mandatory_gates = {
        "platform_width_ok": platform_width <= 0.07,
        "platform_slope_ok": abs(platform_slope) <= 0.025,
        "platform_concentration_ok": close_concentration >= 0.70,
        "breakout_confirmed": breakout_index is not None and current["close"] > platform_high and breakout_age is not None and breakout_age <= 2,
        "breakout_candle_ok": close_position >= 0.65,
        "ma20_just_turned_up": 0.0005 <= ma20_slope_3 <= 0.012 and ma20_turn_age is not None and ma20_turn_age <= 4 and current["close"] >= ma20,
        "volume_confirmed": volume_ratio >= 1.15,
    }
    anti_chase_gates = {
        "extension_ok": 0.0015 <= extension <= 0.035,
        "ma20_distance_ok": 0.0 <= distance_to_ma20 <= 0.045,
        "recent_return_ok": recent_return_3 <= 0.07,
        "fresh_breakout_ok": consecutive_above <= 3,
        "volume_not_blowoff": volume_ratio <= 3.5,
        "upper_shadow_ok": upper_shadow <= 0.45,
        "breakout_holding": current["close"] > platform_high,
    }
    component_scores = {
        "platform": mean((_descending_score(platform_width, full=0.04, limit=0.07), _descending_score(abs(platform_slope), full=0.01, limit=0.025), _ascending_score(close_concentration, minimum=0.70, full=0.90))),
        "ma20_turn": mean((_band_score(ma20_slope_3, 0.0005, 0.001, 0.006, 0.012), 0.0 if ma20_turn_age is None else _descending_score(float(ma20_turn_age), 1.0, 4.0), _descending_score(max(distance_to_ma20, 0.0), 0.02, 0.045))),
        "breakout": mean((_band_score(extension, 0.0015, 0.003, 0.02, 0.035), _ascending_score(close_position, 0.65, 0.85), 0.0 if breakout_age is None else _descending_score(float(breakout_age), 0.0, 3.0))),
        "anti_chase": mean((_descending_score(max(extension, 0.0), 0.02, 0.035), _descending_score(max(recent_return_3, 0.0), 0.035, 0.07), _descending_score(float(consecutive_above), 1.0, 4.0), _descending_score(upper_shadow, 0.25, 0.45))),
        "volume": _band_score(volume_ratio, 1.15, 1.30, 2.50, 3.50),
    }
    score = component_scores["platform"] * 0.25 + component_scores["ma20_turn"] * 0.25 + component_scores["breakout"] * 0.20 + component_scores["anti_chase"] * 0.15 + component_scores["volume"] * 0.15
    rejection_reasons = _rejection_reasons(mandatory_gates, anti_chase_gates)
    hit = not rejection_reasons and score >= threshold
    return {
        "rule_status": "pass", "pattern_type": "m30_platform_breakout_ma20_turn", "required_bars": required_bars, "available_bars": len(rows),
        "ma_window": ma_window, "platform_window": platform_window, "breakout_lookback": breakout_lookback, "threshold": threshold,
        "platform_start_time": _bar_time(platform[0]), "platform_end_time": _bar_time(platform[-1]), "signal_bar_time": _bar_time(current),
        "breakout_bar_time": _bar_time(breakout_row) if breakout_index is not None else None, "platform_high": round(platform_high, 6),
        "platform_low": round(platform_low, 6), "platform_width_pct": round(platform_width, 6), "platform_slope_pct": round(platform_slope, 6),
        "close_concentration_ratio": round(close_concentration, 6), "breakout_level": round(breakout_level, 6), "breakout_age_bars": breakout_age,
        "extension_from_platform_high": round(extension, 6), "breakout_close_position": round(close_position, 6),
        "breakout_upper_shadow_ratio": round(upper_shadow, 6), "ma20": round(ma20, 6), "ma20_slope_3": round(ma20_slope_3, 6),
        "ma20_turn_age_bars": ma20_turn_age, "distance_to_ma20": round(distance_to_ma20, 6), "volume_ratio": round(volume_ratio, 6),
        "volume_baseline": round(volume_baseline, 6), "volume_baseline_kind": volume_baseline_kind, "recent_return_3": round(recent_return_3, 6),
        "consecutive_closes_above_platform": consecutive_above, "mandatory_gates": mandatory_gates, "anti_chase_gates": anti_chase_gates,
        "anti_chase_passed": all(anti_chase_gates.values()), "component_scores": {key: round(value, 6) for key, value in component_scores.items()},
        "rejection_reasons": rejection_reasons, "score": round(score, 6), "hit": hit,
    }


def _unavailable(*, status: str, reason: str, required_bars: int, available_bars: int, threshold: float) -> dict[str, Any]:
    return {"rule_status": status, "reason": reason, "required_bars": required_bars, "available_bars": available_bars, "threshold": threshold, "rejection_reasons": [reason], "score": None, "hit": False}


def _rolling_mean(values: Sequence[float], window: int) -> list[float | None]:
    result: list[float | None] = []
    total = 0.0
    for index, value in enumerate(values):
        total += value
        if index >= window:
            total -= values[index - window]
        result.append(total / window if index >= window - 1 else None)
    return result


def _ma_turn_age(values: Sequence[float | None], *, lookback: int) -> int | None:
    start = max(1, len(values) - lookback)
    for index in range(start, len(values)):
        current, previous = values[index], values[index - 1]
        if current is None or previous is None or previous == 0:
            continue
        current_change = (current - previous) / abs(previous)
        prior_changes = []
        for prior_index in range(max(1, index - 3), index):
            left, right = values[prior_index - 1], values[prior_index]
            if left is not None and right is not None and left != 0:
                prior_changes.append((right - left) / abs(left))
        if current_change > 0 and (not prior_changes or mean(prior_changes) <= 0.0002):
            return len(values) - 1 - index
    return None


def _linear_regression_change(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    x_mean, y_mean = (len(values) - 1) / 2, mean(values)
    denominator = sum((index - x_mean) ** 2 for index in range(len(values)))
    if denominator == 0 or y_mean == 0:
        return 0.0
    slope = sum((index - x_mean) * (value - y_mean) for index, value in enumerate(values)) / denominator
    return slope * (len(values) - 1) / abs(y_mean)


def _volume_baseline(platform: Sequence[dict[str, Any]], signal: dict[str, Any]) -> tuple[float, str]:
    signal_slot = _time_slot(signal)
    same_slot = [row["volume"] for row in platform if signal_slot is not None and _time_slot(row) == signal_slot]
    if len(same_slot) >= 2:
        return float(median(same_slot)), "same_time_slot_median"
    return float(median(row["volume"] for row in platform)), "platform_median"


def _time_slot(row: dict[str, Any]) -> str | None:
    raw = row.get("trade_time")
    if raw is None:
        return None
    text = str(raw)
    try:
        return datetime.fromisoformat(text).strftime("%H:%M")
    except ValueError:
        return text[11:16] if len(text) >= 16 else None


def _trade_time_problem(bars: Sequence[dict[str, Any]]) -> str | None:
    normalized: list[datetime] = []
    shanghai = timezone(timedelta(hours=8))
    for row in bars:
        raw = row.get("trade_time")
        if raw is None:
            return "missing_trade_time"
        try:
            parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return "invalid_trade_time"
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=shanghai)
        normalized.append(parsed.astimezone(timezone.utc))
    for previous, current in zip(normalized, normalized[1:]):
        if current == previous:
            return "duplicate_trade_time"
        if current < previous:
            return "trade_time_not_ordered"
    return None


def _bar_time(row: dict[str, Any]) -> Any:
    return row.get("trade_time", row.get("trade_date"))


def _rejection_reasons(mandatory: dict[str, bool], anti_chase: dict[str, bool]) -> list[str]:
    labels = {
        "platform_width_ok": "platform_not_compact", "platform_slope_ok": "platform_trending", "platform_concentration_ok": "platform_closes_not_concentrated",
        "breakout_confirmed": "breakout_not_confirmed", "breakout_candle_ok": "breakout_candle_weak", "ma20_just_turned_up": "ma20_not_just_turning_up",
        "volume_confirmed": "volume_not_confirmed", "extension_ok": "breakout_overextended", "ma20_distance_ok": "too_far_above_ma20",
        "recent_return_ok": "recent_return_too_high", "fresh_breakout_ok": "breakout_not_fresh", "volume_not_blowoff": "volume_blowoff",
        "upper_shadow_ok": "long_upper_shadow", "breakout_holding": "failed_breakout",
    }
    return [labels[name] for name, passed in {**mandatory, **anti_chase}.items() if not passed]


def _ratio(numerator: float, denominator: float) -> float:
    return 0.0 if denominator == 0 else numerator / abs(denominator)


def _ascending_score(value: float, minimum: float, full: float) -> float:
    if value <= minimum:
        return 0.0
    if value >= full:
        return 1.0
    return (value - minimum) / (full - minimum)


def _descending_score(value: float, full: float, limit: float) -> float:
    if value <= full:
        return 1.0
    if value >= limit:
        return 0.0
    return (limit - value) / (limit - full)


def _band_score(value: float, minimum: float, ideal_low: float, ideal_high: float, maximum: float) -> float:
    if value < minimum or value > maximum:
        return 0.0
    if ideal_low <= value <= ideal_high:
        return 1.0
    if value < ideal_low:
        return (value - minimum) / (ideal_low - minimum)
    return (maximum - value) / (maximum - ideal_high)
