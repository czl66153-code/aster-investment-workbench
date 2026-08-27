"""Durable K-line similarity scan backed by Aster's canonical market tables.

The scoring path deliberately reuses the exact M30 early-breakout port and the
vendored daily-shape evaluator copied from the machine-stock-selection project.
It never reads the legacy web service and never treats archived Tencent bars as
current formal data.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from signal_desk.aia.patterns.candles import candlestick_patterns
from signal_desk.aia.patterns.features import candle_features, zhuang_kline_features

from .aster_top10 import (
    _completed_daily_cutoff,
    _daily_shape_evaluator,
    _funnel_scan_rows,
    _latest_factor_date,
    _load_daily_bars,
    _load_factors,
    _load_m30_bars,
    _parse_datetime,
)
from .m30 import evaluate_m30, load_template_profile


SCHEMA_VERSION = "aster.kline-similarity.v1"
SHANGHAI = timezone(timedelta(hours=8))
MODULES = ("m30", "daily")
PATTERN_LABELS = {
    "m30_platform_breakout_ma20_turn": "30分钟平台突破与MA20转强",
    "rising_narrow_base": "日线上升窄幅平台",
    "breakout_pullback_restart": "日线突破回踩再启动",
    "ma250_convergence": "日线年线收敛启动",
    "daily_shape_unconfirmed": "日线形态尚未确认",
    "daily_shape_unavailable": "日线数据不足",
}


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and result not in (float("inf"), float("-inf")) else None


def _module_names(raw: str) -> list[str]:
    requested = [value.strip().lower() for value in raw.split(",") if value.strip()]
    selected = [module for module in MODULES if module in requested]
    if not selected:
        raise ValueError("at least one K-line module must be selected")
    return selected


def _source_allowed(source: str, prefixes: tuple[str, ...]) -> bool:
    normalized = source.strip().lower()
    return any(normalized.startswith(prefix) for prefix in prefixes)


def _rolling_average(values: list[float], window: int) -> list[float | None]:
    output: list[float | None] = []
    running = 0.0
    for index, value in enumerate(values):
        running += value
        if index >= window:
            running -= values[index - window]
        output.append(round(running / window, 6) if index >= window - 1 else None)
    return output


def _chart_rows(rows: list[dict[str, Any]], module: str) -> list[dict[str, Any]]:
    # Moving averages must be calculated against the complete scoring history,
    # then clipped for display.  Calculating MA250 after slicing the chart made
    # the year line disappear even when the formal daily cache was complete.
    count = 96 if module == "m30" else 160
    key = "trade_time" if module == "m30" else "trade_date"
    closes = [float(row["close"]) for row in rows]
    windows = (5, 20, 30) if module == "m30" else (5, 20, 30, 60, 250)
    averages = {window: _rolling_average(closes, window) for window in windows}
    start = max(0, len(rows) - count)
    return [
        {
            "time": row.get(key),
            "open": _number(row.get("open")),
            "high": _number(row.get("high")),
            "low": _number(row.get("low")),
            "close": _number(row.get("close")),
            "volume": _number(row.get("volume")),
            **{f"ma{window}": averages[window][index] for window in windows},
        }
        for index, row in enumerate(rows)
        if index >= start
    ]


def _legacy_feature_summary(rows: list[dict[str, Any]], module: str) -> dict[str, Any]:
    if not rows or any(row.get(field) is None for row in rows for field in ("open", "high", "low", "close", "volume")):
        return {}
    candle = candle_features(rows)
    if module == "m30":
        zhuang = zhuang_kline_features(rows, ma_window=48, base_window=24, breakout_window=6, near_ma_tolerance=0.10)
    else:
        zhuang = zhuang_kline_features(rows, ma_window=250, base_window=120, breakout_window=20, near_ma_tolerance=0.12)
    return {
        "normalized_return_total": candle.get("normalized_return_total"),
        "body_to_range_avg": candle.get("body_to_range_avg"),
        "upper_shadow_to_range_avg": candle.get("upper_shadow_to_range_avg"),
        "lower_shadow_to_range_avg": candle.get("lower_shadow_to_range_avg"),
        "volume_trend": candle.get("volume_trend"),
        "price_trend": candle.get("price_trend"),
        "candlestick_patterns": candlestick_patterns(rows),
        "zhuang_kline": zhuang,
    }


def _daily_payload(rows: list[dict[str, Any]], signal_at: datetime, threshold: float) -> dict[str, Any]:
    if not rows:
        return {
            "module": "daily", "score": None, "threshold": threshold, "hit": False,
            "quality_status": "blocked", "pattern_code": "daily_shape_unavailable",
            "pattern_label": PATTERN_LABELS["daily_shape_unavailable"],
            "risk_reason_codes": ["insufficient_history"], "bars": [], "features": {},
        }
    result = _daily_shape_evaluator()(rows, signal_time=signal_at, threshold=threshold)
    pattern_code = str(result.get("pattern_code") or "daily_shape_unconfirmed")
    score = _number(result.get("score"))
    return {
        "module": "daily",
        "score": score,
        "threshold": threshold,
        "hit": bool(result.get("hit")),
        "quality_status": str(result.get("quality_status") or result.get("rule_status") or "blocked"),
        "pattern_code": pattern_code,
        "pattern_label": PATTERN_LABELS.get(pattern_code, pattern_code),
        "risk_reason_codes": list(result.get("risk_reason_codes") or []),
        "last_complete_bar_time": result.get("last_complete_bar_time"),
        "template_hits": list(result.get("template_hits") or []),
        "shape_details": result.get("templates") or result.get("shape_details") or {},
        "evaluation_features": result.get("features") or {},
        "available_bars": len(rows),
        "required_bars": 310,
        "features": _legacy_feature_summary(rows, "daily"),
        "bars": _chart_rows(rows, "daily"),
    }


def _m30_payload(rows: list[dict[str, Any]], threshold: float, profile: dict[str, Any]) -> dict[str, Any]:
    result = evaluate_m30(rows, template_profile=profile, threshold=threshold) if rows else {
        "rule_status": "partial", "score": None, "base_score": None, "core_hit": False,
        "hit": False, "rejection_reasons": ["insufficient_history"], "threshold": threshold,
    }
    score = _number(result.get("score"))
    calibration = dict(result.get("calibration") or {})
    return {
        "module": "m30",
        "score": score,
        "base_score": _number(result.get("base_score")),
        "threshold": threshold,
        "hit": bool(result.get("core_hit")),
        "quality_status": "blocked" if result.get("rule_status") in {"blocked", "partial"} else "pass",
        "pattern_code": str(result.get("pattern_type") or "m30_platform_breakout_ma20_turn"),
        "pattern_label": PATTERN_LABELS["m30_platform_breakout_ma20_turn"],
        "signal_bar_time": result.get("signal_bar_time"),
        "breakout_bar_time": result.get("breakout_bar_time"),
        "rejection_reasons": list(result.get("rejection_reasons") or []),
        "mandatory_gates": dict(result.get("mandatory_gates") or {}),
        "anti_chase_gates": dict(result.get("anti_chase_gates") or {}),
        "component_scores": dict(result.get("component_scores") or {}),
        "available_bars": len(rows),
        "required_bars": 30,
        "template": {
            "template_id": calibration.get("template_id") or profile.get("template_id"),
            "confidence": calibration.get("confidence") or profile.get("confidence"),
            "similarity": calibration.get("similarity"),
            "delta": calibration.get("delta"),
            "status": calibration.get("status", "not_applied"),
        },
        "features": _legacy_feature_summary(rows, "m30"),
        "bars": _chart_rows(rows, "m30"),
    }


def _latest_signal_time(factors: list[dict[str, Any]], override: str | None) -> datetime:
    if override:
        return _parse_datetime(override)
    latest = max((str(row.get("updated_at") or "") for row in factors), default="")
    if latest:
        try:
            parsed = datetime.fromisoformat(latest.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(SHANGHAI)
        except ValueError:
            pass
    return datetime.now(SHANGHAI)


def _prepare(connection: sqlite3.Connection, trade_date: str | None, signal_time: str | None, limit: int) -> dict[str, Any]:
    target_date = trade_date or _latest_factor_date(connection)
    if not target_date:
        raise RuntimeError("no published factor snapshot")
    factors = _load_factors(connection, target_date)
    signal_at = _latest_signal_time(factors, signal_time)
    daily_cutoff = _completed_daily_cutoff(target_date, signal_at)
    codes = [str(row["code"]) for row in factors]
    daily_bars, daily_sources, daily_as_of = _load_daily_bars(connection, codes, daily_cutoff)
    selected, funnel = _funnel_scan_rows(factors, daily_bars, limit=limit)
    selected_codes = [str(row["code"]) for row in selected]
    m30_bars, m30_sources, m30_as_of = _load_m30_bars(connection, selected_codes, signal_at)
    return {
        "trade_date": target_date,
        "signal_at": signal_at,
        "daily_cutoff": daily_cutoff,
        "factors": factors,
        "selected": selected,
        "daily_bars": daily_bars,
        "daily_sources": daily_sources,
        "daily_as_of": daily_as_of,
        "m30_bars": m30_bars,
        "m30_sources": m30_sources,
        "m30_as_of": m30_as_of,
        "funnel": funnel,
    }


def build_scan(
    db_path: Path,
    *,
    modules: list[str],
    limit: int,
    m30_threshold: float,
    daily_threshold: float,
    trade_date: str | None = None,
    signal_time: str | None = None,
    plan_only: bool = False,
) -> dict[str, Any]:
    connection = _connect(db_path)
    try:
        prepared = _prepare(connection, trade_date, signal_time, limit)
        selected_codes = [str(row["code"]) for row in prepared["selected"]]
        if plan_only:
            return {
                "schema_version": SCHEMA_VERSION,
                "status": "planned",
                "trade_date": prepared["trade_date"],
                "signal_time": prepared["signal_at"].isoformat(),
                "codes": selected_codes,
                "funnel": prepared["funnel"],
            }

        profile = load_template_profile()
        rows = []
        quality_counts: Counter[str] = Counter()
        for factor in prepared["selected"]:
            code = str(factor["code"])
            daily_rows = prepared["daily_bars"].get(code, [])[-320:]
            m30_rows = prepared["m30_bars"].get(code, [])[-120:]
            module_results: dict[str, dict[str, Any]] = {}
            if "daily" in modules:
                module_results["daily"] = _daily_payload(daily_rows, prepared["signal_at"], daily_threshold)
                module_results["daily"]["source"] = sorted(prepared["daily_sources"])
                module_results["daily"]["as_of"] = prepared["daily_as_of"]
            if "m30" in modules:
                module_results["m30"] = _m30_payload(m30_rows, m30_threshold, profile)
                module_results["m30"]["source"] = sorted(prepared["m30_sources"])
                module_results["m30"]["as_of"] = prepared["m30_as_of"]
            hits = [module for module, result in module_results.items() if result["hit"]]
            usable_scores = [float(result["score"]) for result in module_results.values() if result.get("score") is not None]
            matched = bool(hits)
            kline_shape_score = sum(usable_scores) / len(usable_scores) if usable_scores else None
            dual_hit_bonus = 3.0 if {"m30", "daily"}.issubset(hits) else 0.0
            kline_total_score = min(100.0, (kline_shape_score or 0.0) * 100.0 + dual_hit_bonus)
            effective_weight = 1.0 / len(usable_scores) if usable_scores else 0.0
            for module, result in module_results.items():
                quality_counts[f"{module}:{result['quality_status']}"] += 1
            rows.append({
                "code": code,
                "name": str(factor.get("name") or code),
                "industry": str(factor.get("industry") or "未分类"),
                "matched": matched,
                "module_hits": hits,
                "best_score": max(usable_scores) if usable_scores else None,
                "combined_score": sum(usable_scores) / len(usable_scores) if usable_scores else None,
                "score_breakdown": {
                    "kline_shape_score": round(kline_shape_score, 8) if kline_shape_score is not None else None,
                    "dual_hit_bonus_points": dual_hit_bonus,
                    "kline_total_score": round(kline_total_score, 6),
                    "module_attribution": {
                        module: {
                            "raw_score": result.get("score"),
                            "threshold": result.get("threshold"),
                            "original_aia_weight": 0.25,
                            "page_effective_weight": effective_weight if result.get("score") is not None else 0.0,
                            "normalized_contribution": round(float(result["score"]) * effective_weight, 8) if result.get("score") is not None else None,
                            "hit": bool(result.get("hit")),
                        }
                        for module, result in module_results.items()
                    },
                    "scope_note": "K线独立页只汇总30分钟和日线；筹码仍由双筹码模型独立排名，不混入本页得分",
                },
                "funnel": factor.get("_aia_funnel") or {},
                "modules": module_results,
            })
        rows.sort(key=lambda row: (not row["matched"], -(row["best_score"] or -1), -(row["combined_score"] or -1), row["code"]))
        for index, row in enumerate(rows, start=1):
            row["rank"] = index

        daily_source_ok = bool(prepared["daily_sources"]) and all(
            _source_allowed(source, ("bigquant", "tushare")) for source in prepared["daily_sources"]
        )
        m30_source_ok = bool(prepared["m30_sources"]) and all(
            _source_allowed(source, ("akshare",)) for source in prepared["m30_sources"]
        )
        daily_ready = sum(len(prepared["daily_bars"].get(code, [])) >= 80 for code in selected_codes)
        daily_ma250_ready = sum(len(prepared["daily_bars"].get(code, [])) >= 310 for code in selected_codes)
        m30_ready = sum(len(prepared["m30_bars"].get(code, [])) >= 30 for code in selected_codes)
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "completed",
            "trade_date": prepared["trade_date"],
            "signal_time": prepared["signal_at"].isoformat(),
            "logic": "selected K-line modules use OR eligibility; core rule hits are never changed by template calibration",
            "modules": modules,
            "thresholds": {"m30": m30_threshold, "daily": daily_threshold},
            "source_policy": {"daily": "BigQuant+Tushare formal nightly", "m30": "AKShare intraday only", "legacy_archive": "audit-only; excluded from current signals"},
            "coverage": {
                "market_universe": len(prepared["factors"]),
                "funnel_selected": len(selected_codes),
                "daily_ready": daily_ready,
                "daily_ratio": daily_ready / max(1, len(selected_codes)),
                "daily_ma250_ready": daily_ma250_ready,
                "daily_ma250_ratio": daily_ma250_ready / max(1, len(selected_codes)),
                "m30_ready": m30_ready,
                "m30_ratio": m30_ready / max(1, len(selected_codes)),
                "daily_as_of": prepared["daily_as_of"],
                "m30_as_of": prepared["m30_as_of"],
                "daily_sources": sorted(prepared["daily_sources"]),
                "m30_sources": sorted(prepared["m30_sources"]),
                "daily_source_policy_pass": daily_source_ok,
                "m30_source_policy_pass": m30_source_ok,
                "quality_counts": dict(sorted(quality_counts.items())),
            },
            "funnel": prepared["funnel"],
            "summary": {
                "scanned": len(rows),
                "matched": sum(bool(row["matched"]) for row in rows),
                "daily_hits": sum("daily" in row["module_hits"] for row in rows),
                "m30_hits": sum("m30" in row["module_hits"] for row in rows),
            },
            "results": rows,
        }
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aster-kline-similarity")
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--modules", default="m30,daily")
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--m30-threshold", type=float, default=0.72)
    parser.add_argument("--daily-threshold", type=float, default=0.70)
    parser.add_argument("--trade-date")
    parser.add_argument("--signal-time")
    parser.add_argument("--plan-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build_scan(
            args.db,
            modules=_module_names(args.modules),
            limit=max(10, min(220, args.limit)),
            m30_threshold=max(0.50, min(0.95, args.m30_threshold)),
            daily_threshold=max(0.50, min(0.95, args.daily_threshold)),
            trade_date=args.trade_date,
            signal_time=args.signal_time,
            plan_only=args.plan_only,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"schema_version": SCHEMA_VERSION, "status": "error", "error": str(error), "error_type": type(error).__name__}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
