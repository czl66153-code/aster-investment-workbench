"""Nightly updater for the independent copy of the original 8010 database."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "python_engine" / "vendor_exact"
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))


def _result_rows(results: object) -> list[dict[str, object]]:
    output = []
    for item in results or []:
        output.append({"table": getattr(item, "table", ""), "rows": int(getattr(item, "rows", 0))})
    return output


def _build_independent_chip_close_panel(end: str) -> dict[str, object]:
    """Recurse the complete close profile from official OHLCV; never ingest provider chips."""
    database = Path(
        os.environ.get("ASTER_MARKET_DB")
        or os.environ.get("QUANT_DB_PATH")
        or ROOT / "data" / "market.duckdb"
    ).resolve()
    data_root = Path(os.environ.get("ASTER_DATA_ROOT") or ROOT / "data").resolve()
    output_root = data_root / "independent_chip_hybridfloat_v8"
    script = VENDOR / "scripts" / "build_independent_chip_recent_market.py"
    command = [
        sys.executable,
        str(script),
        "--db", str(database),
        "--output-root", str(output_root),
        "--trading-days", "1",
        "--warmup-days", "10000",
        "--workers", str(min(6, max(2, (os.cpu_count() or 4) // 2))),
        "--chunk-size", "64",
        "--replace",
    ]
    completed = subprocess.run(
        command,
        cwd=VENDOR,
        env={**os.environ, "QUANT_DB_PATH": str(database), "QUANT_DATA_ROOT": str(data_root)},
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=3 * 60 * 60,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout)[-4000:]
        raise RuntimeError(f"independent close chip recurrence failed: {detail}")
    # The builder publishes the recent parquet relation. Refresh the stable
    # current_* views as a separate atomic step so scoring cannot keep reading
    # the previously vendored incremental path.
    os.environ["QUANT_DB_PATH"] = str(database)
    os.environ["QUANT_DATA_ROOT"] = str(data_root)
    from quant_mvp.current_chip import register_current_chip_views

    register_current_chip_views()
    manifest_path = output_root / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError("independent close chip recurrence did not publish a manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    factors = dict(manifest.get("factor_stats") or {})
    distributions = dict(manifest.get("distribution_stats") or {})
    if str(factors.get("max_date")) != str(end):
        raise RuntimeError(
            f"independent close chip date {factors.get('max_date')} does not match official date {end}"
        )
    requested = max(1, int(manifest.get("requested_stocks") or 0))
    factor_stocks = int(factors.get("stocks") or 0)
    distribution_stocks = int(distributions.get("stocks") or 0)
    if factor_stocks / requested < 0.95 or distribution_stocks / requested < 0.95:
        raise RuntimeError(
            "independent close chip coverage failed: "
            f"factors={factor_stocks}/{requested}, distributions={distribution_stocks}/{requested}"
        )
    if (manifest.get("registration") or {}).get("status") != "ready":
        raise RuntimeError(f"independent close chip view registration failed: {manifest.get('registration')}")
    import duckdb

    with duckdb.connect(str(database), read_only=True) as connection:
        current_date, current_count = connection.execute(
            "SELECT max(trade_date),count(*) FILTER (WHERE trade_date=(SELECT max(trade_date) FROM current_chip_factor_daily)) FROM current_chip_factor_daily"
        ).fetchone()
    if str(current_date) != str(end) or int(current_count or 0) != factor_stocks:
        raise RuntimeError(
            f"current chip view still points to {current_date} ({current_count} rows), expected {end} ({factor_stocks} rows)"
        )
    return {
        "mode": "official_ohlcv_independent_recurrence",
        "trade_date": str(factors.get("max_date")),
        "requested_stocks": requested,
        "factor_stocks": factor_stocks,
        "distribution_stocks": distribution_stocks,
        "distribution_rows": int(distributions.get("rows") or 0),
        "model_version": manifest.get("model_version"),
        "registration": manifest.get("registration"),
    }


def nightly(end: str, days: int, include_chips: bool, chips_only: bool = False) -> dict[str, object]:
    from quant_mvp.factors import compute_daily_factors
    from quant_mvp.ingest import (
        ingest_bigquant_daily_full_market,
        ingest_tushare_daily,
    )

    started = time.monotonic()
    end_day = date.fromisoformat(end)
    start = (end_day - timedelta(days=max(7, days))).isoformat()
    stages: dict[str, object] = {}
    # The nightly copy only fetches the latest completed official session.
    # Intraday and 30-minute bars belong exclusively to AkShare in Aster.
    if not chips_only:
        stages["bigquant_daily"] = _result_rows(
            ingest_bigquant_daily_full_market(
                start=start,
                end=end,
                last_trading_days=1,
                include_security_master=False,
                refresh=True,
            )
        )
        stages["tushare_daily"] = _result_rows(
            ingest_tushare_daily(
                start=start,
                end=end,
                last_trading_days=1,
                refresh=True,
            )
        )
    stages["factors"] = compute_daily_factors()
    if include_chips:
        stages["independent_close_chip_recurrence"] = _build_independent_chip_close_panel(end)
    return {
        "ok": True,
        "status": "success",
        "task": "market_nightly_original_8010",
        "source_policy": "bigquant+tushare_ohlcv_to_independent_chip_recurrence",
        "mode": "recurrence_only" if chips_only else "official_daily_and_recurrence",
        "start": start,
        "end": end,
        "stages": stages,
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--end", default=date.today().isoformat())
    parser.add_argument("--days", type=int, default=10)
    parser.add_argument("--include-chips", action="store_true")
    parser.add_argument("--chips-only", action="store_true")
    arguments = parser.parse_args()
    print(json.dumps(nightly(arguments.end, arguments.days, arguments.include_chips, arguments.chips_only), ensure_ascii=False))
