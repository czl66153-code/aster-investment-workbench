"""Task implementations used by the command-line scheduler entry point."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .assets import validate_assets
from .m30 import evaluate_m30, load_template_profile
from .ranking import load_current_config, rank_top10
from .sources import source_plan


def _smoke_bars() -> list[dict[str, Any]]:
    start = datetime(2026, 8, 19, 9, 30, tzinfo=timezone(timedelta(hours=8)))
    closes = []
    for index in range(40):
        if index < 37:
            closes.append(10.0 + ((index % 5) - 2) * 0.001)
        else:
            closes.append(10.08 + (index - 37) * 0.09)
    rows = []
    for index, close in enumerate(closes):
        previous = closes[index - 1] if index else close
        open_price = min(previous, close - 0.002)
        rows.append(
            {
                "trade_time": (start + timedelta(minutes=30 * index)).isoformat(),
                "open": round(open_price, 4),
                "high": round(close + 0.004, 4),
                "low": round(min(open_price, close) - 0.004, 4),
                "close": round(close, 4),
                "volume": 210000 if index >= 37 else 100000 + (index % 4) * 1000,
            }
        )
    return rows


def _smoke_candidates() -> list[dict[str, Any]]:
    results = []
    for index in range(12):
        score = 92.0 - index * 1.5
        results.append(
            {
                "symbol": f"600{index:03d}.SH",
                "name": f"AIA smoke {index + 1}",
                "risk": {"status": "ok"},
                "patterns": {
                    "m30": {"hit": True, "quality_status": "pass", "score": 0.82, "threshold": 0.72},
                    "early_breakout": {"hit": index < 4, "quality_status": "pass", "score": 0.79, "threshold": 0.72},
                },
                "factors": {
                    "leadership_status": {"score": score - 3, "source": "smoke", "as_of": "2026-08-19T15:00:00+08:00"},
                    "sector_heat": {"score": score, "source": "smoke", "as_of": "2026-08-19T15:00:00+08:00"},
                    "stock_popularity": {"score": score - 1, "source": "smoke", "as_of": "2026-08-19T15:00:00+08:00"},
                    "technical_pattern": {"score": score + 2, "source": "smoke", "as_of": "2026-08-19T15:00:00+08:00"},
                },
                "provenance": {"mode": "synthetic_import_smoke"},
            }
        )
    return results


def run_smoke() -> dict[str, Any]:
    assets = validate_assets()
    profile = load_template_profile()
    m30 = evaluate_m30(_smoke_bars(), template_profile=profile)
    ranking = rank_top10(_smoke_candidates(), load_current_config())
    ok = bool(
        assets["ok"]
        and m30.get("core_hit") is True
        and m30.get("calibration", {}).get("status") == "applied"
        and ranking.get("publishable")
        and len(ranking.get("items", [])) == 10
    )
    return {
        "ok": ok,
        "python_engine_version": "0.1.0",
        "assets_ok": assets["ok"],
        "m30": {
            "quality": m30.get("rule_status"),
            "core_hit": m30.get("core_hit"),
            "score": m30.get("score"),
            "template_status": (m30.get("calibration") or {}).get("status"),
        },
        "top10": {
            "status": ranking.get("status"),
            "count": len(ranking.get("items", [])),
            "config_version": ranking.get("config_version"),
        },
        "sources": {
            "intraday": source_plan("intraday"),
            "night": source_plan("night"),
        },
    }
