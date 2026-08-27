"""Provider SDK bridge for the independent research engine.

The module deliberately has no provider imports at module import time.  Secrets
are never accepted in request payloads; BigQuant and Tushare authenticate only
from the child process environment or their own local SDK credential store.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import re
import sys
import time
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


VENDOR_ROOT = Path(__file__).resolve().parents[1] / "python_engine" / "vendor_exact"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from quant_mvp.intraday_units import (  # noqa: E402
    CANONICAL_UNITS,
    UNIT_VERSION,
    IntradayUnitError,
    normalize_quote_units,
    source_unit_metadata,
)
from quant_mvp.daily_units import (  # noqa: E402
    CANONICAL_DAILY_UNIT_VERSION,
    CANONICAL_DAILY_UNITS,
    LEGACY_DAILY_UNIT_VERSION,
    LEGACY_DAILY_UNITS,
)


OUTPUT_MARKER = "ASTER_PROVIDER_JSON:"
CODE_PATTERN = re.compile(r"^(\d{6})\.(SH|SZ|BJ)$")
CHIP_FEATURE_COLUMNS = (
    "win_percent",
    "chip_density_70",
    "avg_window_density_4pct",
    "avg_window_density_10pct",
    "raw_main_peak_height",
    "raw_peak_width_70",
    "raw_peak2_ratio",
    "raw_peak_valley_ratio",
    "raw_peak_valley_depth",
    "raw_peak_separation_ratio",
    "raw_peak_separation_widths",
    "raw_peak_count",
    "raw_peak_mass_1pct",
    "raw_peak_mass_2pct",
    "raw_peak_mass_4pct",
    "raw_peak_symmetry_1pct",
    "raw_peak_symmetry_2pct",
    "raw_peak_symmetry_4pct",
    "raw_main_peak_local_share_2pct",
    "raw_profile_hhi",
    "raw_profile_entropy",
    "raw_peak_global_balance",
    "raw_close_main_peak_gap_ratio",
)
CHIP_AXIS_COLUMNS = (
    "shape_sharpness",
    "shape_compactness",
    "shape_symmetry",
    "shape_single_peak",
    "shape_profit_quality",
)
CHIP_OPTIONAL_FEATURE_COLUMNS = ("raw_main_peak_profit",)
CHIP_COST_PEAK_COLUMNS = (
    "cost_line_price",
    "main_peak_price_for_distance",
    "cost_line_main_peak_signed_distance_ratio",
    "cost_line_main_peak_abs_distance_ratio",
    "cost_line_main_peak_abs_distance_rank_pct",
)


def _number(value: Any, fallback: float | None = None) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _iso_date(value: Any) -> str:
    text = _text(value).replace("/", "-")[:10]
    compact = text.replace("-", "")
    if re.fullmatch(r"20\d{6}", compact):
        return f"{compact[:4]}-{compact[4:6]}-{compact[6:8]}"
    raise ValueError(f"invalid trade date: {value!r}")


def _valid_codes(values: Any) -> list[str]:
    result: list[str] = []
    for raw in values or []:
        code = _text(raw).upper()
        if CODE_PATTERN.fullmatch(code) and code not in result:
            result.append(code)
    return result


def _retry(label: str, action: Callable[[], Any], attempts: int = 3) -> Any:
    error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return action()
        except Exception as exc:  # provider SDK exception types are not stable
            error = exc
            if attempt < attempts:
                time.sleep(min(5.0, 1.25 * attempt))
    raise RuntimeError(f"{label} failed after {attempts} attempts: {error}") from error


def _records(frame: Any) -> list[dict[str, Any]]:
    if frame is None or getattr(frame, "empty", True):
        return []
    return list(frame.to_dict(orient="records"))


def capabilities(_: dict[str, Any] | None = None) -> dict[str, Any]:
    packages = {
        name: importlib.util.find_spec(name) is not None
        for name in ("bigquant", "tushare", "akshare", "pandas", "joblib", "sklearn")
    }
    return {
        "ok": True,
        "commands": ["capabilities", "formal-daily", "warehouse-publish-official", "intraday-quotes", "intraday-execution-prices", "intraday-m30", "market-daily-history", "market-factor-snapshot", "refresh-bigquant-heat", "market-chip-axes", "score-chip-models", "chip-sample-distributions"],
        "packages": packages,
        "credentials": {
            "bigquant_environment": bool(os.getenv("BIGQUANT_TOKEN")),
            "tushare_environment": bool(os.getenv("TUSHARE_TOKEN")),
        },
        "credential_policy": "environment_or_sdk_store_only",
    }


def _bigquant_daily(start: str, end: str, codes: list[str]) -> dict[str, Any]:
    from bigquant import dai

    token = os.getenv("BIGQUANT_TOKEN")
    if token and hasattr(dai, "login"):
        _retry("BigQuant login", lambda: dai.login(token), attempts=2)
    code_filter = ""
    if codes:
        quoted = ",".join(f"'{code}'" for code in codes)
        code_filter = f" AND instrument IN ({quoted})"
    sql = f"""
        SELECT date, instrument, name, adjust_factor, pre_close,
               open, close, high, low, volume, amount, change_ratio, turn
        FROM cn_stock_bar1d
        WHERE date >= '{start}' AND date <= '{end}'{code_filter}
        ORDER BY date, instrument
    """
    frame = _retry(
        "BigQuant cn_stock_bar1d",
        lambda: dai.query(sql, filters={"date": [start, end]}).df(),
        attempts=1,
    )
    bars: list[dict[str, Any]] = []
    basics: list[dict[str, Any]] = []
    for row in _records(frame):
        code = _text(row.get("instrument")).upper()
        if not CODE_PATTERN.fullmatch(code):
            continue
        factor = _number(row.get("adjust_factor"), 1.0) or 1.0
        close = (_number(row.get("close")) or 0.0) / factor
        pre_close = (_number(row.get("pre_close")) or 0.0) / factor
        if close <= 0:
            continue
        trade_date = _iso_date(row.get("date"))
        change_ratio = _number(row.get("change_ratio"))
        bars.append(
            {
                "provider": "bigquant_official",
                "code": code,
                "name": _text(row.get("name")),
                "trade_date": trade_date,
                "open": (_number(row.get("open")) or 0.0) / factor,
                "high": (_number(row.get("high")) or 0.0) / factor,
                "low": (_number(row.get("low")) or 0.0) / factor,
                "close": close,
                "pre_close": pre_close or None,
                "pct_chg": change_ratio * 100.0 if change_ratio is not None else (
                    (close / pre_close - 1.0) * 100.0 if pre_close else None
                ),
                "volume": _number(row.get("volume")),
                "amount": _number(row.get("amount")),
                "adj_factor": factor,
            }
        )
        basics.append(
            {
                "provider": "bigquant_official",
                "code": code,
                "trade_date": trade_date,
                "close": close,
                "turnover_rate": (_number(row.get("turn")) or 0.0) * 100.0,
                "turnover_rate_f": None,
                "volume_ratio": None,
                "float_share": None,
                "free_share": None,
                "total_mv": None,
                "circ_mv": None,
            }
        )
    if not bars:
        raise RuntimeError("BigQuant returned no valid official daily bars")
    return {"bars": bars, "basics": basics}


def _tushare_client() -> Any:
    import tushare as ts

    token = os.getenv("TUSHARE_TOKEN")
    if token:
        ts.set_token(token)
        return ts.pro_api(token)
    return ts.pro_api()


def _tushare_daily(start: str, end: str, codes: list[str]) -> dict[str, Any]:
    pro = _tushare_client()
    compact_start = start.replace("-", "")
    compact_end = end.replace("-", "")
    calendar = _retry(
        "Tushare trade_cal",
        lambda: pro.trade_cal(
            exchange="SSE",
            start_date=compact_start,
            end_date=compact_end,
            fields="cal_date,is_open",
        ),
    )
    days = [
        _text(row.get("cal_date"))
        for row in _records(calendar)
        if int(_number(row.get("is_open"), 0) or 0) == 1
    ]
    allowed = set(codes)
    bars: list[dict[str, Any]] = []
    basics: list[dict[str, Any]] = []
    for day in sorted(days):
        daily = _retry(
            f"Tushare daily {day}",
            lambda day=day: pro.daily(
                trade_date=day,
                fields="ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount",
            ),
        )
        basic = _retry(
            f"Tushare daily_basic {day}",
            lambda day=day: pro.daily_basic(
                trade_date=day,
                fields=(
                    "ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,"
                    "pe,pe_ttm,pb,ps,ps_ttm,dv_ratio,dv_ttm,total_share,"
                    "float_share,free_share,total_mv,circ_mv"
                ),
            ),
        )
        for row in _records(daily):
            code = _text(row.get("ts_code")).upper()
            if not CODE_PATTERN.fullmatch(code) or (allowed and code not in allowed):
                continue
            close = _number(row.get("close"))
            if close is None or close <= 0:
                continue
            bars.append(
                {
                    "provider": "tushare_official",
                    "code": code,
                    "trade_date": _iso_date(row.get("trade_date")),
                    "open": _number(row.get("open")),
                    "high": _number(row.get("high")),
                    "low": _number(row.get("low")),
                    "close": close,
                    "pre_close": _number(row.get("pre_close")),
                    "pct_chg": _number(row.get("pct_chg")),
                    # Tushare daily uses hands and thousand CNY.
                    "volume": (_number(row.get("vol")) or 0.0) * 100.0,
                    "amount": (_number(row.get("amount")) or 0.0) * 1000.0,
                    "adj_factor": None,
                }
            )
        for row in _records(basic):
            code = _text(row.get("ts_code")).upper()
            if not CODE_PATTERN.fullmatch(code) or (allowed and code not in allowed):
                continue
            basics.append(
                {
                    "provider": "tushare_official",
                    "code": code,
                    "trade_date": _iso_date(row.get("trade_date")),
                    "close": _number(row.get("close")),
                    "turnover_rate": _number(row.get("turnover_rate")),
                    "turnover_rate_f": _number(row.get("turnover_rate_f")),
                    "volume_ratio": _number(row.get("volume_ratio")),
                    "pe": _number(row.get("pe")),
                    "pe_ttm": _number(row.get("pe_ttm")),
                    "pb": _number(row.get("pb")),
                    "ps": _number(row.get("ps")),
                    "ps_ttm": _number(row.get("ps_ttm")),
                    "dv_ratio": _number(row.get("dv_ratio")),
                    "dv_ttm": _number(row.get("dv_ttm")),
                    "total_share": _number(row.get("total_share")),
                    "float_share": _number(row.get("float_share")),
                    "free_share": _number(row.get("free_share")),
                    # Tushare daily_basic market value is ten-thousand CNY.
                    "total_mv": (_number(row.get("total_mv")) or 0.0) * 10_000.0,
                    "circ_mv": (_number(row.get("circ_mv")) or 0.0) * 10_000.0,
                }
            )
        time.sleep(float(os.getenv("ASTER_TUSHARE_CALL_PAUSE", "0.12")))
    if not bars or not basics:
        raise RuntimeError(
            f"Tushare returned incomplete official daily data: bars={len(bars)}, basics={len(basics)}"
        )
    return {"bars": bars, "basics": basics}


def formal_daily(payload: dict[str, Any]) -> dict[str, Any]:
    end = _iso_date(payload.get("end") or date.today().isoformat())
    start = _iso_date(payload.get("start") or (date.fromisoformat(end) - timedelta(days=14)))
    if start > end:
        raise ValueError("formal daily start is after end")
    codes = _valid_codes(payload.get("codes"))
    tushare = _tushare_daily(start, end, codes)
    latest_tushare_date = max(row["trade_date"] for row in tushare["bars"])
    # Tushare's official calendar decides the latest completed A-share session.
    # BigQuant is then queried for that single day only.  This preserves the
    # two-source same-day gate without repeatedly consuming a multi-day quota.
    tushare = {
        "bars": [row for row in tushare["bars"] if row["trade_date"] == latest_tushare_date],
        "basics": [row for row in tushare["basics"] if row["trade_date"] == latest_tushare_date],
    }
    bigquant = _bigquant_daily(latest_tushare_date, latest_tushare_date, codes)
    return {
        "ok": True,
        "mode": "formal_daily",
        "start": start,
        "end": end,
        "trade_date": latest_tushare_date,
        "bars": [*bigquant["bars"], *tushare["bars"]],
        "basics": [*bigquant["basics"], *tushare["basics"]],
        "providers": {
            "bigquant": {
                "ok": True,
                "bars": len(bigquant["bars"]),
                "basics": len(bigquant["basics"]),
            },
            "tushare": {
                "ok": True,
                "bars": len(tushare["bars"]),
                "basics": len(tushare["basics"]),
            },
        },
    }


def warehouse_publish_official(payload: dict[str, Any]) -> dict[str, Any]:
    """Publish one already-fetched, dual-source batch into the site-owned DuckDB.

    No provider call occurs here.  The same verified payload that is committed
    to SQLite is reused, eliminating the former second BigQuant/Tushare pull.
    """
    import duckdb
    import pandas as pd
    from pathlib import Path

    database_text = _text(payload.get("database")) or os.environ.get("ASTER_MARKET_DB") or os.environ.get("QUANT_DB_PATH") or ""
    if not database_text:
        raise ValueError("official warehouse publish requires an independent database path")
    database = Path(database_text)
    if not database.exists():
        raise FileNotFoundError(f"independent market database not found: {database}")
    raw_bars = pd.DataFrame(payload.get("bars") or [])
    raw_basics = pd.DataFrame(payload.get("basics") or [])
    if raw_bars.empty or raw_basics.empty:
        raise ValueError("official warehouse publish requires bars and basics")
    raw_bars["trade_date"] = pd.to_datetime(raw_bars["trade_date"]).dt.date
    raw_basics["trade_date"] = pd.to_datetime(raw_basics["trade_date"]).dt.date
    trade_date = max(raw_bars["trade_date"])
    bigquant = raw_bars[(raw_bars["provider"] == "bigquant_official") & (raw_bars["trade_date"] == trade_date)].copy()
    tushare = raw_bars[(raw_bars["provider"] == "tushare_official") & (raw_bars["trade_date"] == trade_date)].copy()
    basics = raw_basics[(raw_basics["provider"] == "tushare_official") & (raw_basics["trade_date"] == trade_date)].copy()
    if min(len(bigquant), len(tushare), len(basics)) < 1:
        raise ValueError("official warehouse batch lacks one of the required provider slices")

    def daily_unit_quality(frame: Any, provider: str, *, legacy: bool = False) -> dict[str, Any]:
        work = frame.copy()
        volume_column = "vol" if legacy else "volume"
        for column in ("low", "high", volume_column, "amount"):
            work[column] = pd.to_numeric(work[column], errors="coerce")
        active = work[
            (work["low"] > 0)
            & (work["high"] > 0)
            & (work[volume_column] > 0)
            & (work["amount"] > 0)
        ].copy()
        if active.empty:
            raise ValueError(f"{provider} daily unit gate has no active rows")
        active["vwap"] = (
            active["amount"] * 10.0 / active[volume_column]
            if legacy
            else active["amount"] / active[volume_column]
        )
        invalid = active[
            (active["vwap"] < active["low"] * 0.95)
            | (active["vwap"] > active["high"] * 1.05)
        ]
        if not invalid.empty:
            examples = invalid[["code", "low", "high", "vwap"]].head(8).to_dict(orient="records")
            raise ValueError(
                f"{provider} daily amount/volume unit gate failed for {len(invalid)}/{len(active)} rows: {examples}"
            )
        return {
            "provider": provider,
            "active_rows": int(len(active)),
            "invalid_rows": 0,
            "vwap_ratio_median": float((active["vwap"] / active["close"]).median()),
        }

    raw_unit_quality = [
        daily_unit_quality(bigquant, "bigquant_official:share+CNY"),
        daily_unit_quality(tushare, "tushare_official:normalized_share+CNY"),
    ]

    connection = duckdb.connect(str(database))
    try:
        connection.execute("""CREATE TABLE IF NOT EXISTS raw_official_daily_bar(
          provider VARCHAR,ts_code VARCHAR,trade_date DATE,open DOUBLE,high DOUBLE,low DOUBLE,close DOUBLE,
          pre_close DOUBLE,pct_chg DOUBLE,vol DOUBLE,amount DOUBLE,adj_factor DOUBLE,
          received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(provider,ts_code,trade_date))""")
        connection.execute("ALTER TABLE raw_official_daily_bar ADD COLUMN IF NOT EXISTS unit_version VARCHAR")
        connection.execute("ALTER TABLE raw_official_daily_bar ADD COLUMN IF NOT EXISTS volume_unit VARCHAR")
        connection.execute("ALTER TABLE raw_official_daily_bar ADD COLUMN IF NOT EXISTS amount_unit VARCHAR")
        connection.execute("""CREATE TABLE IF NOT EXISTS raw_official_daily_basic(
          provider VARCHAR,ts_code VARCHAR,trade_date DATE,close DOUBLE,turnover_rate DOUBLE,turnover_rate_f DOUBLE,
          volume_ratio DOUBLE,pe DOUBLE,pe_ttm DOUBLE,pb DOUBLE,ps DOUBLE,ps_ttm DOUBLE,dv_ratio DOUBLE,dv_ttm DOUBLE,
          total_share DOUBLE,float_share DOUBLE,free_share DOUBLE,total_mv DOUBLE,circ_mv DOUBLE,
          received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(provider,ts_code,trade_date))""")
        bar_stage = raw_bars.rename(columns={"code": "ts_code", "volume": "vol"})
        bar_stage["unit_version"] = CANONICAL_DAILY_UNIT_VERSION
        bar_stage["volume_unit"] = CANONICAL_DAILY_UNITS["volume"]
        bar_stage["amount_unit"] = CANONICAL_DAILY_UNITS["amount"]
        basic_stage = raw_basics.rename(columns={"code": "ts_code"})
        for column in ("pe", "pe_ttm", "pb", "ps", "ps_ttm", "dv_ratio", "dv_ttm", "total_share"):
            if column not in basic_stage:
                basic_stage[column] = None
        connection.register("official_bar_stage", bar_stage)
        connection.register("official_basic_stage", basic_stage)
        connection.execute("BEGIN TRANSACTION")
        connection.execute("DELETE FROM raw_official_daily_bar WHERE trade_date=?", [trade_date])
        connection.execute("""INSERT INTO raw_official_daily_bar BY NAME
          SELECT provider,ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount,adj_factor,
                 CURRENT_TIMESTAMP AS received_at,unit_version,volume_unit,amount_unit
          FROM official_bar_stage""")
        connection.execute("DELETE FROM raw_official_daily_basic WHERE trade_date=?", [trade_date])
        connection.execute("""INSERT INTO raw_official_daily_basic BY NAME
          SELECT provider,ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,pe,pe_ttm,pb,ps,ps_ttm,dv_ratio,dv_ttm,
                 total_share,float_share,free_share,total_mv,circ_mv,CURRENT_TIMESTAMP AS received_at
          FROM official_basic_stage""")
        connection.execute("COMMIT")
    except Exception:
        try:
            connection.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        connection.close()

    vendor = Path(__file__).resolve().parents[1] / "python_engine" / "vendor_exact"
    if str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    os.environ["QUANT_DB_PATH"] = str(database)
    from quant_mvp import db as market_db
    from quant_mvp.factors import compute_daily_factors

    daily = pd.DataFrame({
        "ts_code": bigquant["code"], "trade_date": bigquant["trade_date"], "open": bigquant["open"],
        "high": bigquant["high"], "low": bigquant["low"], "close": bigquant["close"],
        "pre_close": bigquant["pre_close"], "change": bigquant["close"] - bigquant["pre_close"],
        "pct_chg": bigquant["pct_chg"],
        # quant_mvp.daily_bar intentionally preserves the original 8010/Tushare
        # contract: volume=lots and amount=thousand CNY.
        "vol": pd.to_numeric(bigquant["volume"], errors="coerce") / 100.0,
        "amount": pd.to_numeric(bigquant["amount"], errors="coerce") / 1000.0,
    })
    daily_unit_quality(daily.rename(columns={"ts_code": "code"}), "daily_bar:lot+thousand_CNY", legacy=True)
    adjustments = pd.DataFrame({
        "ts_code": bigquant["code"],
        "trade_date": bigquant["trade_date"],
        "adj_factor": bigquant["adj_factor"],
    })
    daily_basic = basics.rename(columns={"code": "ts_code"}).copy()
    for column in ("total_mv", "circ_mv"):
        if column in daily_basic:
            daily_basic[column] = pd.to_numeric(daily_basic[column], errors="coerce") / 10_000.0
    basic_columns = ["ts_code", "trade_date", "close", "turnover_rate", "turnover_rate_f", "volume_ratio", "pe", "pe_ttm", "pb", "ps", "ps_ttm", "dv_ratio", "dv_ttm", "total_share", "float_share", "free_share", "total_mv", "circ_mv"]
    market_db.init_schema()
    daily_rows = market_db.replace_dates("daily_bar", daily, "trade_date", [trade_date])
    basic_rows = market_db.replace_dates("daily_basic", daily_basic[basic_columns], "trade_date", [trade_date])
    adjustment_rows = market_db.replace_dates("adj_factor", adjustments, "trade_date", [trade_date])
    factors = compute_daily_factors()
    return {"ok": True, "mode": "warehouse_publish_official", "database": str(database), "trade_date": trade_date.isoformat(),
            "daily_rows": int(daily_rows), "basic_rows": int(basic_rows), "adjustment_rows": int(adjustment_rows), "factors": factors,
            "raw_unit_version": CANONICAL_DAILY_UNIT_VERSION, "raw_units": dict(CANONICAL_DAILY_UNITS),
            "daily_bar_unit_version": LEGACY_DAILY_UNIT_VERSION, "daily_bar_units": dict(LEGACY_DAILY_UNITS),
            "unit_quality": raw_unit_quality,
            "source": "bigquant_official+tushare_official:shared_batch"}


def _pick(row: Any, *names: str) -> Any:
    for name in names:
        try:
            value = row.get(name)
        except AttributeError:
            continue
        if value is not None and _text(value).lower() not in {"", "nan", "none"}:
            return value
    return None


def _market_code(value: Any) -> str | None:
    matched = re.search(r"(\d{6})$", _text(value))
    if not matched:
        return None
    symbol = matched.group(1)
    # Beijing Stock Exchange migrated listed-company symbols to the 920xxx
    # range.  Check that range before the generic Shanghai 9xx branch.
    market = "BJ" if symbol.startswith(("4", "8", "920")) else "SH" if symbol.startswith(("5", "6", "9")) else "SZ"
    return f"{symbol}.{market}"


def _local_akshare_quotes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Read a fresh AKShare snapshot already persisted in the site-owned warehouse.

    This is a same-day, short-TTL continuity cache.  It never accepts another
    provider label and never turns a prior-day close into a live quote.
    """
    from pathlib import Path

    import duckdb

    requested = set(_valid_codes(payload.get("codes")))
    today = date.today().isoformat()
    rows: list[dict[str, Any]] = []
    database_text = _text(payload.get("database")) or os.environ.get("ASTER_MARKET_DB") or os.environ.get("QUANT_DB_PATH") or ""
    database = Path(database_text) if database_text else None
    if database and database.is_file():
        connection = duckdb.connect(str(database), read_only=True)
        try:
            latest = connection.execute(
                """SELECT MAX(updated_at) FROM realtime_market_snapshot
                   WHERE trade_date=? AND lower(COALESCE(data_source,'')) LIKE 'akshare%'""",
                [today],
            ).fetchone()[0]
            if latest is not None:
                observed = latest if isinstance(latest, datetime) else datetime.fromisoformat(str(latest))
                if abs((datetime.now() - observed.replace(tzinfo=None)).total_seconds()) <= 15 * 60:
                    frame = connection.execute(
                        """
                        WITH prior AS (
                          SELECT ts_code,arg_max(close,trade_date) AS prev_close
                          FROM daily_bar WHERE trade_date<? GROUP BY ts_code
                        )
                        SELECT s.instrument AS code,s.latest AS price,p.prev_close,
                               s.cum_volume AS volume,s.cum_amount AS amount,
                               s.observed_at AS quote_time,s.updated_at
                        FROM realtime_market_snapshot s
                        LEFT JOIN prior p ON p.ts_code=s.instrument
                        WHERE s.trade_date=? AND lower(COALESCE(s.data_source,'')) LIKE 'akshare%'
                        """,
                        [today, today],
                    ).fetchdf()
                    for item in frame.to_dict(orient="records"):
                        code = _text(item.get("code")).upper()
                        price = _number(item.get("price"))
                        previous = _number(item.get("prev_close"))
                        if not CODE_PATTERN.fullmatch(code) or (requested and code not in requested) or price is None or price <= 0:
                            continue
                        quote_time = item.get("quote_time")
                        pct_chg = (price / previous - 1.0) * 100.0 if previous else None
                        try:
                            unit_values = normalize_quote_units(
                                "akshare_local_warehouse_snapshot",
                                price=price,
                                volume=item.get("volume"),
                                amount=item.get("amount"),
                                pct_chg=pct_chg,
                            )
                        except IntradayUnitError:
                            continue
                        rows.append({
                            "code": code, "name": "", "price": price, "open_price": None, "prev_close": previous,
                            "pct_chg": unit_values["pct_chg"],
                            "volume": unit_values["volume"], "amount": unit_values["amount"], "turnover_rate": None,
                            "quote_time": quote_time.isoformat(sep=" ", timespec="seconds") if isinstance(quote_time, datetime) else _text(quote_time),
                            "source": "akshare_local_warehouse_snapshot", "received_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                            "unit_version": UNIT_VERSION, "units": dict(CANONICAL_UNITS),
                            "raw_unit_contract": source_unit_metadata("akshare_local_warehouse_snapshot")["raw"],
                        })
        finally:
            connection.close()

    sqlite_text = _text(payload.get("sqlite_database"))
    sqlite_path = Path(sqlite_text) if sqlite_text else None
    if sqlite_path and sqlite_path.is_file():
        import sqlite3

        connection = sqlite3.connect(f"file:{sqlite_path.as_posix()}?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            quote_columns = {item[1] for item in connection.execute("PRAGMA table_info(realtime_quotes)")}
            if "unit_version" not in quote_columns:
                return rows
            latest = connection.execute(
                "SELECT MAX(received_at) FROM realtime_quotes WHERE substr(quote_time,1,10)=? AND lower(COALESCE(source,'')) LIKE 'akshare%' AND unit_version=?",
                (today, UNIT_VERSION),
            ).fetchone()[0]
            if latest:
                observed = datetime.fromisoformat(str(latest).replace("Z", "+00:00"))
                if observed.tzinfo is None:
                    observed = observed.replace(tzinfo=timezone.utc)
                if abs((datetime.now().astimezone() - observed.astimezone()).total_seconds()) <= 15 * 60:
                    existing = {row["code"] for row in rows}
                    for item in connection.execute(
                        "SELECT code,name,price,open_price,prev_close,pct_chg,volume,amount,turnover_rate,quote_time FROM realtime_quotes WHERE substr(quote_time,1,10)=? AND lower(COALESCE(source,'')) LIKE 'akshare%' AND unit_version=?",
                        (today, UNIT_VERSION),
                    ):
                        code = _text(item["code"]).upper()
                        price = _number(item["price"])
                        if code in existing or not CODE_PATTERN.fullmatch(code) or (requested and code not in requested) or price is None or price <= 0:
                            continue
                        try:
                            unit_values = normalize_quote_units(
                                "akshare_local_sqlite_snapshot",
                                price=price,
                                volume=item["volume"],
                                amount=item["amount"],
                                pct_chg=item["pct_chg"],
                                turnover_rate=item["turnover_rate"],
                            )
                        except IntradayUnitError:
                            continue
                        rows.append({
                            "code": code, "name": _text(item["name"]), "price": price, "open_price": _number(item["open_price"]),
                            "prev_close": _number(item["prev_close"]), "pct_chg": unit_values["pct_chg"],
                            "volume": unit_values["volume"], "amount": unit_values["amount"], "turnover_rate": unit_values["turnover_rate"],
                            "quote_time": _text(item["quote_time"]), "source": "akshare_local_sqlite_snapshot",
                            "received_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                            "unit_version": UNIT_VERSION, "units": dict(CANONICAL_UNITS),
                            "raw_unit_contract": source_unit_metadata("akshare_local_sqlite_snapshot")["raw"],
                        })
        finally:
            connection.close()
    return rows


def intraday_quotes(payload: dict[str, Any]) -> dict[str, Any]:
    import akshare as ak

    codes = set(_valid_codes(payload.get("codes")))
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    expected = len(codes)
    minimum = math.ceil(expected * 0.95) if expected else 1
    unit_rejections: list[str] = []

    def normalize(frame: Any, source: str) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for row in _records(frame):
            code = _market_code(_pick(row, "代码", "symbol", "code"))
            if not code or (codes and code not in codes):
                continue
            price = _number(_pick(row, "最新价", "trade", "price"))
            open_price = _number(_pick(row, "今开", "开盘", "open"))
            previous = _number(_pick(row, "昨收", "settlement", "pre_close"))
            if price is None or price <= 0:
                continue
            pct = _number(_pick(row, "涨跌幅", "changepercent", "pct_chg"))
            if pct is None and previous:
                pct = (price / previous - 1.0) * 100.0
            try:
                unit_values = normalize_quote_units(
                    source,
                    price=price,
                    volume=_pick(row, "成交量", "volume"),
                    amount=_pick(row, "成交额", "amount"),
                    pct_chg=pct,
                    turnover_rate=_pick(row, "换手率", "turnoverratio", "turnover_rate"),
                )
            except IntradayUnitError as error:
                if len(unit_rejections) < 20:
                    unit_rejections.append(f"{source}:{code}:{error}")
                continue
            tick = _text(_pick(row, "更新时间", "数据时间", "ticktime", "time"))
            if re.fullmatch(r"\d{2}:\d{2}:\d{2}", tick):
                tick = f"{date.today().isoformat()}T{tick}"
            normalized.append(
                {
                    "code": code,
                    "name": _text(_pick(row, "名称", "name")),
                    "price": price,
                    "open_price": open_price,
                    "prev_close": previous,
                    "pct_chg": unit_values["pct_chg"],
                    "volume": unit_values["volume"],
                    "amount": unit_values["amount"],
                    "turnover_rate": unit_values["turnover_rate"],
                    "quote_time": tick or now,
                    "source": source,
                    "received_at": now,
                    "unit_version": unit_values["unit_version"],
                    "units": unit_values["units"],
                    "raw_unit_contract": unit_values["raw_unit_contract"],
                }
            )
        return normalized

    rows: list[dict[str, Any]] = []
    source = "akshare_eastmoney_spot"
    errors: list[str] = []
    try:
        rows = normalize(_retry("AKShare Eastmoney spot", ak.stock_zh_a_spot_em, attempts=4), source)
        if expected and len(rows) < minimum:
            errors.append(f"Eastmoney coverage={len(rows)}/{expected}")
    except Exception as error:
        errors.append(f"Eastmoney={error}")

    # A successful HTTP response can still omit an entire exchange segment.
    # Treat sub-gate coverage as a provider failure and try the second AKShare
    # connector before rejecting the batch.
    if expected and len(rows) < minimum:
        try:
            sina_rows = normalize(_retry("AKShare Sina spot", ak.stock_zh_a_spot, attempts=3), "akshare_sina_spot")
            if len(sina_rows) > len(rows):
                rows = sina_rows
                source = "akshare_sina_spot"
            if len(sina_rows) < minimum:
                errors.append(f"Sina coverage={len(sina_rows)}/{expected}")
        except Exception as error:
            errors.append(f"Sina={error}")

    provider_error: Exception | None = RuntimeError("AKShare intraday endpoints incomplete; " + "; ".join(errors)) if errors else None
    if expected and len(rows) < minimum:
        cached = _local_akshare_quotes(payload)
        live_codes = {row["code"] for row in rows}
        rows.extend(row for row in cached if row["code"] not in live_codes)
        if len(rows) > len(live_codes):
            source = f"{source}+akshare_local_continuity_cache"
    if not rows:
        raise provider_error or RuntimeError("AKShare returned no valid A-share quotes")
    contracts = {
        row["source"]: {
            "version": row.get("unit_version"),
            "raw": row.get("raw_unit_contract"),
            "canonical": row.get("units"),
        }
        for row in rows
    }
    return {
        "ok": True,
        "mode": "intraday_quotes",
        "source": source,
        "quotes": rows,
        "unit_version": UNIT_VERSION,
        "unit_contracts": contracts,
        "unit_rejections": unit_rejections,
        "live_provider_error": str(provider_error) if provider_error else None,
    }


def _local_akshare_execution_prices(
    payload: dict[str, Any], codes: list[str], trade_date: str, execution_time: str
) -> dict[str, dict[str, Any]]:
    """Read the immutable 5-minute bucket already written by the AKShare watcher."""
    database = Path(
        _text(payload.get("database"))
        or os.environ.get("ASTER_MARKET_DB")
        or os.environ.get("QUANT_DB_PATH")
        or ""
    )
    if not database.is_file() or not codes:
        return {}
    try:
        import duckdb

        placeholders = ",".join("?" for _ in codes)
        connection = duckdb.connect(str(database), read_only=True)
        try:
            rows = connection.execute(
                f"""
                SELECT instrument,close,data_source,trade_time,observed_at
                FROM realtime_bar5m
                WHERE trade_date=? AND strftime(trade_time, '%H:%M')=?
                  AND instrument IN ({placeholders})
                  AND lower(coalesce(data_source,'')) LIKE 'akshare%'
                  AND close>0
                QUALIFY row_number() OVER (PARTITION BY instrument ORDER BY updated_at DESC)=1
                """,
                [trade_date, execution_time, *codes],
            ).fetchall()
        finally:
            connection.close()
    except Exception:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for code, close, source, trade_time, observed_at in rows:
        if close is None or float(close) <= 0:
            continue
        result[str(code)] = {
            "code": str(code),
            "trade_date": trade_date,
            "execution_time": execution_time,
            "price": float(close),
            "source": "akshare_local_realtime_5m_close",
            "source_as_of": f"{trade_date}T{execution_time}:00+08:00",
            "evidence": {
                "upstream": str(source or ""),
                "trade_time": _text(trade_time),
                "observed_at": _text(observed_at),
            },
        }
    return result


def intraday_execution_prices(payload: dict[str, Any]) -> dict[str, Any]:
    """Load an already-finished AKShare minute close for a locked trade action.

    This endpoint is deliberately limited to a handful of locked candidates. It
    never uses the current spot price as a historical fill and never falls back
    to BigQuant, Tushare, Tencent, or another intraday provider.
    """
    import akshare as ak

    codes = _valid_codes(payload.get("codes"))[:10]
    if not codes:
        raise ValueError("intraday-execution-prices requires at least one valid code")
    trade_date = _iso_date(payload.get("trade_date") or date.today().isoformat())
    execution_time = _text(payload.get("execution_time") or "09:50")[:5]
    if not re.fullmatch(r"\d{2}:\d{2}", execution_time):
        raise ValueError("execution_time must use HH:MM")

    local_prices = _local_akshare_execution_prices(payload, codes, trade_date, execution_time)
    prices: list[dict[str, Any]] = [local_prices[code] for code in codes if code in local_prices]
    failures: list[dict[str, str]] = []
    for code in codes:
        if code in local_prices:
            continue
        symbol = code.split(".", 1)[0]
        prefix = "sh" if code.endswith(".SH") else "bj" if code.endswith(".BJ") else "sz"
        try:
            frame = _retry(
                f"AKShare Sina minute execution {code}",
                lambda symbol=symbol, prefix=prefix: ak.stock_zh_a_minute(
                    symbol=f"{prefix}{symbol}", period="1", adjust=""
                ),
                attempts=3,
            )
            match = None
            for row in _records(frame):
                stamp = _text(_pick(row, "时间", "day", "datetime"))[:19]
                if stamp[:10] == trade_date and stamp[11:16] == execution_time:
                    match = row
            price = _number(_pick(match or {}, "收盘", "close"))
            if price is None or price <= 0:
                raise RuntimeError(f"AKShare minute close missing at {trade_date} {execution_time}")
            prices.append(
                {
                    "code": code,
                    "trade_date": trade_date,
                    "execution_time": execution_time,
                    "price": price,
                    "source": "akshare_sina_minute",
                    "source_as_of": f"{trade_date}T{execution_time}:00+08:00",
                }
            )
        except Exception as exc:
            failures.append({"code": code, "error": str(exc)})
    if not prices:
        raise RuntimeError(f"AKShare returned no locked execution prices: {failures[:2]}")
    return {
        "ok": True,
        "mode": "intraday_execution_prices",
        "trade_date": trade_date,
        "execution_time": execution_time,
        "prices": prices,
        "failures": failures,
        "source_policy": "akshare_local_5m_then_sina_minute",
    }


def _akshare_m30_one(ak: Any, code: str, start: str, end: str) -> tuple[list[dict[str, Any]], str]:
    symbol = code.split(".", 1)[0]
    source = "akshare_eastmoney_m30"
    try:
        frame = _retry(
            f"AKShare Eastmoney m30 {code}",
            lambda: ak.stock_zh_a_hist_min_em(
                symbol=symbol,
                start_date=f"{start} 09:20:00",
                end_date=f"{end} 15:10:00",
                period="30",
                adjust="",
            ),
            attempts=2,
        )
    except Exception:
        prefix = "sh" if code.endswith(".SH") else "bj" if code.endswith(".BJ") else "sz"
        frame = _retry(
            f"AKShare Sina m30 {code}",
            lambda: ak.stock_zh_a_minute(symbol=f"{prefix}{symbol}", period="30", adjust=""),
            attempts=2,
        )
        source = "akshare_sina_m30"
    rows: list[dict[str, Any]] = []
    for row in _records(frame):
        trade_time = _text(_pick(row, "时间", "day", "datetime"))[:19]
        open_price = _number(_pick(row, "开盘", "open"))
        close = _number(_pick(row, "收盘", "close"))
        if not trade_time or open_price is None or close is None:
            continue
        try:
            unit_values = normalize_quote_units(
                source,
                price=close,
                volume=_pick(row, "成交量", "volume"),
                amount=_pick(row, "成交额", "amount"),
            )
        except IntradayUnitError:
            continue
        rows.append(
            {
                "code": code,
                "trade_time": trade_time,
                "open": open_price,
                "high": _number(_pick(row, "最高", "high")),
                "low": _number(_pick(row, "最低", "low")),
                "close": close,
                "volume": unit_values["volume"],
                "amount": unit_values["amount"],
                "source": source,
                "unit_version": unit_values["unit_version"],
                "units": unit_values["units"],
            }
        )
    return rows, source


def intraday_m30(payload: dict[str, Any]) -> dict[str, Any]:
    import akshare as ak

    codes = _valid_codes(payload.get("codes"))[:80]
    if not codes:
        raise ValueError("intraday-m30 requires at least one valid code")
    end = _iso_date(payload.get("end") or date.today().isoformat())
    days = max(7, min(120, int(payload.get("days") or 60)))
    start = (date.fromisoformat(end) - timedelta(days=days)).isoformat()
    rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    sources: set[str] = set()
    for code in codes:
        try:
            bars, source = _akshare_m30_one(ak, code, start, end)
            rows.extend(bars)
            sources.add(source)
        except Exception as exc:
            failures.append({"code": code, "error": str(exc)})
    if not rows:
        raise RuntimeError(f"AKShare returned no valid m30 bars: {failures[:1]}")
    return {
        "ok": True,
        "mode": "intraday_m30",
        "sources": sorted(sources),
        "unit_version": UNIT_VERSION,
        "units": dict(CANONICAL_UNITS),
        "bars": rows,
        "failures": failures,
    }


def score_chip_models(payload: dict[str, Any]) -> dict[str, Any]:
    import pandas as pd
    from pathlib import Path

    flattened: list[dict[str, Any]] = []
    for item in payload.get("rows") or []:
        features = dict(item.get("features") or {})
        row = {
            "code": _text(item.get("code") or item.get("ts_code")).upper(),
            "trade_date": _iso_date(item.get("trade_date")),
            **{column: _number(item.get(column)) for column in CHIP_AXIS_COLUMNS},
            **{column: _number(features.get(column, item.get(column))) for column in CHIP_FEATURE_COLUMNS},
            **{column: _number(features.get(column, item.get(column))) for column in CHIP_COST_PEAK_COLUMNS},
        }
        for column in CHIP_OPTIONAL_FEATURE_COLUMNS:
            if column in features:
                row[column] = bool(features[column])
        flattened.append(row)
    frame = pd.DataFrame(flattened)
    required = ("code", "trade_date", *CHIP_AXIS_COLUMNS, *CHIP_FEATURE_COLUMNS)
    missing = [column for column in required if column not in frame or frame[column].isna().any()]
    if missing:
        raise ValueError(f"chip model panel lacks complete internal features: {missing}")
    if frame.empty:
        raise ValueError("chip model panel is empty")
    # One canonical scorer owns both the 23-column rollback format and the
    # active 24-column model.  A former duplicate implementation was removed
    # because it could silently diverge from the deployed artifact contract.
    import joblib
    from quant_mvp.chip_shape_score import _score_shape_panel_with_model

    data_root = Path(
        os.environ.get("ASTER_DATA_ROOT")
        or os.environ.get("QUANT_DATA_ROOT")
        or Path(__file__).resolve().parents[1] / "data"
    )
    formal_path = data_root / "chip_shape_model_current" / "model.joblib"
    candidate_path = data_root / "chip_shape_model_candidate_current" / "model.joblib"
    multi_period_path = data_root / "chip_shape_model_multi_period_current" / "model.joblib"
    canonical_panel = frame.rename(columns={"code": "ts_code"})
    formal = _score_shape_panel_with_model(canonical_panel, formal_path)
    candidate = _score_shape_panel_with_model(canonical_panel, candidate_path)
    formal_version = str(joblib.load(formal_path).get("model_version") or "unknown")
    candidate_version = str(joblib.load(candidate_path).get("model_version") or "unknown")
    multi_period = None
    multi_period_version = None
    if payload.get("enable_multi_period") and multi_period_path.exists():
        multi_period = _score_shape_panel_with_model(canonical_panel, multi_period_path)
        multi_period_version = str(joblib.load(multi_period_path).get("model_version") or "unknown")
    formal_rows = {row["ts_code"]: row for row in formal.to_dict(orient="records")}
    candidate_rows = {row["ts_code"]: row for row in candidate.to_dict(orient="records")}
    multi_period_rows = {row["ts_code"]: row for row in multi_period.to_dict(orient="records")} if multi_period is not None else {}
    rows = []
    for code in sorted(set(formal_rows).intersection(candidate_rows)):
        left = formal_rows[code]
        right = candidate_rows[code]
        rows.append(
            {
                "code": code,
                "trade_date": _iso_date(left["trade_date"]),
                "formal_score": float(left["shape_score"]) * 100.0,
                "formal_rank": int(left["shape_rank"]),
                "formal_rank_pct": float(left["shape_rank_pct"]),
                "candidate_score": float(right["shape_score"]) * 100.0,
                "candidate_rank": int(right["shape_rank"]),
                "candidate_rank_pct": float(right["shape_rank_pct"]),
                "multi_period_score": float(multi_period_rows[code]["shape_score"]) * 100.0 if code in multi_period_rows else None,
                "multi_period_rank": int(multi_period_rows[code]["shape_rank"]) if code in multi_period_rows else None,
                "multi_period_rank_pct": float(multi_period_rows[code]["shape_rank_pct"]) if code in multi_period_rows else None,
            }
        )
    return {
        "ok": True,
        "mode": "dual_chip_models",
        "formal_model_version": formal_version,
        "candidate_model_version": candidate_version,
        "multi_period_model_version": multi_period_version,
        "rows": rows,
    }


def market_chip_axes(payload: dict[str, Any]) -> dict[str, Any]:
    """Export one complete chip-feature cross section from the independent DuckDB.

    The five public axes use the exact percentile construction from 8010's
    ``quant_mvp.chip_shape_template.build_shape_axes``.  The original 23 shape
    inputs plus the governed cost/main-peak distance percentile are retained
    for the active joblib scorers; only the two interpretable distance values
    are exposed to the public screener.
    """
    import duckdb
    import pandas as pd
    from pathlib import Path

    database = Path(
        _text(payload.get("database"))
        or os.environ.get("ASTER_MARKET_DB")
        or os.environ.get("QUANT_DB_PATH")
        or ""
    )
    if not database.exists():
        raise FileNotFoundError(f"independent market database not found: {database}")
    requested = _text(payload.get("trade_date"))
    source_relation = "current_chip_factor_daily"
    connection = duckdb.connect(str(database), read_only=True)
    try:
        table = connection.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name='current_chip_factor_daily'"
        ).fetchone()[0]
        if not table:
            raise RuntimeError("current_chip_factor_daily is missing")
        latest_current = connection.execute("SELECT max(trade_date) FROM current_chip_factor_daily").fetchone()[0]
        if latest_current is None:
            raise RuntimeError("current_chip_factor_daily has no completed independent recurrence")
        latest = requested or str(latest_current)
        select_columns = ",".join([
            "ts_code", "trade_date", "chip_avg_price", "avg_cost", "raw_main_peak_price",
            *CHIP_FEATURE_COLUMNS, *CHIP_OPTIONAL_FEATURE_COLUMNS,
        ])
        frame = connection.execute(
            f"SELECT {select_columns} FROM current_chip_factor_daily WHERE trade_date=? ORDER BY ts_code",
            [latest],
        ).fetchdf()
    finally:
        connection.close()
    if frame.empty:
        raise RuntimeError(f"chip feature cross section is empty for {requested or 'latest'}")
    for column in CHIP_FEATURE_COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    incomplete = [column for column in CHIP_FEATURE_COLUMNS if frame[column].isna().any()]
    if incomplete:
        raise ValueError(f"chip feature cross section has missing values: {incomplete}")
    zero_width_ratio = float((frame["raw_peak_width_70"] <= 0).mean())
    single_peak_ratio = float((frame["raw_peak_count"] <= 1).mean())
    if zero_width_ratio > 0.05 or single_peak_ratio > 0.10:
        raise RuntimeError(
            "independent chip recurrence quality gate failed: "
            f"zero_width={zero_width_ratio:.2%}, single_peak={single_peak_ratio:.2%}; "
            "refusing sparse BigQuant point fallback"
        )
    frame["cost_line_price"] = pd.to_numeric(frame["chip_avg_price"], errors="coerce").fillna(
        pd.to_numeric(frame["avg_cost"], errors="coerce")
    )
    frame["main_peak_price_for_distance"] = pd.to_numeric(
        frame["raw_main_peak_price"], errors="coerce"
    )
    valid_cost = frame["cost_line_price"] > 0
    distance_coverage = float(
        (valid_cost & frame["main_peak_price_for_distance"].notna()).mean()
    )
    if distance_coverage < 0.99:
        raise RuntimeError(
            f"cost/main-peak distance coverage {distance_coverage:.2%} is below 99%"
        )
    frame["cost_line_main_peak_signed_distance_ratio"] = (
        frame["main_peak_price_for_distance"] - frame["cost_line_price"]
    ) / frame["cost_line_price"]
    frame["cost_line_main_peak_abs_distance_ratio"] = frame[
        "cost_line_main_peak_signed_distance_ratio"
    ].abs()
    frame["cost_line_main_peak_abs_distance_rank_pct"] = frame[
        "cost_line_main_peak_abs_distance_ratio"
    ].groupby(frame["trade_date"]).rank(pct=True, method="average").fillna(0.5).clip(0.0, 1.0)

    def percentile(column: str, *, high_is_good: bool = True) -> Any:
        ranked = frame[column].groupby(frame["trade_date"]).rank(pct=True, method="average")
        if not high_is_good:
            ranked = 1.0 - ranked
        return ranked.fillna(0.5).clip(0.0, 1.0)

    ranked = pd.DataFrame(index=frame.index)
    ranked["height"] = percentile("raw_main_peak_height")
    ranked["hhi"] = percentile("raw_profile_hhi")
    ranked["local_share"] = percentile("raw_main_peak_local_share_2pct")
    ranked["mass_1"] = percentile("raw_peak_mass_1pct")
    ranked["entropy"] = percentile("raw_profile_entropy", high_is_good=False)
    ranked["mass_2"] = percentile("raw_peak_mass_2pct")
    ranked["mass_4"] = percentile("raw_peak_mass_4pct")
    ranked["density_70"] = percentile("chip_density_70")
    ranked["density_4"] = percentile("avg_window_density_4pct")
    ranked["density_10"] = percentile("avg_window_density_10pct")
    ranked["width_70"] = percentile("raw_peak_width_70", high_is_good=False)
    ranked["symmetry_1"] = percentile("raw_peak_symmetry_1pct")
    ranked["symmetry_2"] = percentile("raw_peak_symmetry_2pct")
    ranked["symmetry_4"] = percentile("raw_peak_symmetry_4pct")
    ranked["global_balance"] = percentile("raw_peak_global_balance")
    ranked["peak_2"] = percentile("raw_peak2_ratio", high_is_good=False)
    ranked["peak_count"] = percentile("raw_peak_count", high_is_good=False)
    ranked["valley_depth"] = percentile("raw_peak_valley_depth")
    ranked["peak_separation"] = percentile("raw_peak_separation_ratio")
    ranked["peak_separation_widths"] = percentile("raw_peak_separation_widths")
    ranked["profit"] = percentile("win_percent")
    ranked["close_peak_gap"] = percentile("raw_close_main_peak_gap_ratio")
    axes = pd.DataFrame(index=frame.index)
    axes["shape_sharpness"] = ranked[["height", "hhi", "local_share", "mass_1", "entropy"]].mean(axis=1)
    axes["shape_compactness"] = ranked[["mass_2", "mass_4", "density_70", "density_4", "density_10", "width_70"]].mean(axis=1)
    axes["shape_symmetry"] = ranked[["symmetry_1", "symmetry_2", "symmetry_4", "global_balance"]].mean(axis=1)
    axes["shape_single_peak"] = 0.40 * ranked["peak_2"] + 0.25 * ranked["peak_count"] + 0.12 * ranked["valley_depth"] + 0.12 * ranked["peak_separation"] + 0.11 * ranked["peak_separation_widths"]
    axes["shape_profit_quality"] = ranked[["profit", "close_peak_gap"]].mean(axis=1)
    complete = pd.concat([frame, axes.clip(0.0, 1.0)], axis=1)
    rows = []
    for row in complete.to_dict(orient="records"):
        rows.append({
            "code": _text(row["ts_code"]).upper(),
            "trade_date": _iso_date(row["trade_date"]),
            **{column: float(row[column]) for column in CHIP_AXIS_COLUMNS},
            "internal_features": {
                **{column: float(row[column]) for column in CHIP_FEATURE_COLUMNS},
                **{column: float(row[column]) for column in CHIP_COST_PEAK_COLUMNS},
                **{column: bool(row[column]) for column in CHIP_OPTIONAL_FEATURE_COLUMNS},
            },
            "source": f"independent_market_duckdb:{source_relation}:8010_exact_axes",
        })
    return {
        "ok": True,
        "mode": "market_chip_axes",
        "database": str(database),
        "trade_date": _iso_date(latest),
        "source_relation": source_relation,
        "quality": {
            "zero_width_ratio": zero_width_ratio,
            "single_peak_ratio": single_peak_ratio,
            "gate": "independent_recurrence_only",
            "cost_peak_distance_coverage": distance_coverage,
        },
        "rows": rows,
    }


def market_factor_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    """Read the compact all-A-share factor layer from the independent DuckDB."""
    import duckdb
    from pathlib import Path

    database = Path(_text(payload.get("database")) or os.environ.get("ASTER_MARKET_DB") or os.environ.get("QUANT_DB_PATH") or "")
    if not database.exists():
        raise FileNotFoundError(f"independent market database not found: {database}")
    connection = duckdb.connect(str(database), read_only=True)
    try:
        latest = connection.execute("SELECT max(trade_date) FROM factor_daily").fetchone()[0]
        if latest is None:
            raise RuntimeError("factor_daily has no completed trade date")
        frame = connection.execute(
            """
            WITH recent AS (
              SELECT ts_code,trade_date,close,
                     row_number() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS rn
              FROM daily_bar
              WHERE trade_date<=? AND trade_date>=?-INTERVAL 120 DAY
            ), history_returns AS (
              SELECT ts_code,
                     max(CASE WHEN rn=1 THEN close END) AS current_close,
                     max(CASE WHEN rn=5 THEN close END) AS close_4d,
                     max(CASE WHEN rn=11 THEN close END) AS close_10d,
                     max(CASE WHEN rn=31 THEN close END) AS close_30d,
                     max(CASE WHEN rn=61 THEN close END) AS close_60d
              FROM recent GROUP BY ts_code
            ), derived_returns AS (
              SELECT ts_code,
                     current_close/nullif(close_4d,0)-1 AS ret_4d,
                     current_close/nullif(close_10d,0)-1 AS ret_10d,
                     current_close/nullif(close_30d,0)-1 AS ret_30d,
                     current_close/nullif(close_60d,0)-1 AS ret_60d
              FROM history_returns
            ), industry4 AS (
              SELECT f.industry,avg(r.ret_4d) AS industry_ret_4d
              FROM factor_daily f LEFT JOIN derived_returns r USING(ts_code)
              WHERE f.trade_date=? GROUP BY f.industry
            )
            SELECT f.ts_code,f.trade_date,coalesce(nullif(f.name,''),s.name) AS name,
                   coalesce(nullif(f.industry,''),s.industry) AS industry,
                   f.close,f.pct_chg,f.amount,f.turnover_rate,f.volume_ratio_20,
                   f.ret_5d,r.ret_10d,f.ret_20d,r.ret_30d,r.ret_60d,f.bias_ma20,f.breakout_20,f.volatility_20,
                   f.drawdown_20,i.industry_ret_4d
            FROM factor_daily f
            LEFT JOIN security_master s USING(ts_code)
            LEFT JOIN derived_returns r USING(ts_code)
            LEFT JOIN industry4 i ON i.industry=f.industry
            WHERE f.trade_date=? ORDER BY f.ts_code
            """,
            [latest, latest, latest, latest],
        ).fetchdf()
        heat_date = None
        heat_source = None
        heat_rows = 0
        has_heat_relation = connection.execute(
            "SELECT count(*) FROM information_schema.tables WHERE lower(table_name)='stock_heat_rank_daily'"
        ).fetchone()[0] > 0
        if has_heat_relation:
            heat_date = connection.execute(
                "SELECT max(heat_date) FROM stock_heat_rank_daily WHERE heat_date<=?", [latest]
            ).fetchone()[0]
            if heat_date is not None:
                heat = connection.execute(
                    """SELECT ts_code,heat_rank,heat_rank_pct,
                              coalesce(heat_rank_score,heat_score_raw) AS bigquant_heat_score,
                              source AS bigquant_heat_source
                       FROM stock_heat_rank_daily WHERE heat_date=?""",
                    [heat_date],
                ).fetchdf()
                heat_rows = int(len(heat))
                if heat_rows:
                    heat_source = ",".join(sorted(set(heat["bigquant_heat_source"].dropna().astype(str))))
                    frame = frame.merge(heat, how="left", on="ts_code")
        for column in ("heat_rank", "heat_rank_pct", "bigquant_heat_score"):
            if column not in frame:
                frame[column] = None
        securities = connection.execute(
            "SELECT ts_code,symbol,name,market,industry FROM security_master WHERE delist_date IS NULL OR delist_date>? ORDER BY ts_code",
            [latest],
        ).fetchdf()
    finally:
        connection.close()
    official_master: dict[str, dict[str, str]] = {}
    try:
        stock_basic = _retry(
            "Tushare stock_basic",
            lambda: _tushare_client().stock_basic(
                exchange="", list_status="L",
                fields="ts_code,symbol,name,market,industry,list_date",
            ),
        )
        for item in _records(stock_basic):
            code = _text(item.get("ts_code")).upper()
            if CODE_PATTERN.fullmatch(code):
                official_master[code] = {
                    "symbol": _text(item.get("symbol")), "name": _text(item.get("name")),
                    "market": _text(item.get("market")), "industry": _text(item.get("industry")) or "其他",
                }
    except Exception:
        official_master = {}
    rows = []
    numeric_columns = ("close", "pct_chg", "amount", "turnover_rate", "volume_ratio_20", "ret_5d", "ret_10d", "ret_20d", "ret_30d", "ret_60d", "bias_ma20", "volatility_20", "drawdown_20", "industry_ret_4d")
    for row in frame.to_dict(orient="records"):
        rows.append({
            "ts_code": _text(row.get("ts_code")).upper(),
            "trade_date": _iso_date(row.get("trade_date")),
            "name": official_master.get(_text(row.get("ts_code")).upper(), {}).get("name") or _text(row.get("name")),
            "industry": official_master.get(_text(row.get("ts_code")).upper(), {}).get("industry") or _text(row.get("industry")) or "其他",
            **{column: _number(row.get(column)) for column in numeric_columns},
            "bigquant_heat_rank": _number(row.get("heat_rank")),
            "bigquant_heat_rank_pct": _number(row.get("heat_rank_pct")),
            "bigquant_heat_score": _number(row.get("bigquant_heat_score")),
            "bigquant_heat_date": _iso_date(heat_date) if heat_date is not None else None,
            "breakout_20": bool(row.get("breakout_20")),
        })
    masters = []
    for row in securities.to_dict(orient="records"):
        code = _text(row.get("ts_code")).upper(); official = official_master.get(code, {})
        masters.append({
            "ts_code": code,
            "symbol": official.get("symbol") or _text(row.get("symbol")),
            "name": official.get("name") or _text(row.get("name")),
            "market": official.get("market") or _text(row.get("market")),
            "industry": official.get("industry") or _text(row.get("industry")) or "其他",
        })
    return {"ok": True, "mode": "market_factor_snapshot", "database": str(database), "trade_date": _iso_date(latest), "source": "bigquant+tushare:independent_market_duckdb", "security_master_source": "tushare_official" if official_master else "independent_market_duckdb", "heat_date": _iso_date(heat_date) if heat_date is not None else None, "heat_rows": heat_rows, "heat_source": heat_source, "securities": masters, "rows": rows}


def refresh_bigquant_heat(payload: dict[str, Any]) -> dict[str, Any]:
    """Fetch one completed BigQuant heat cross-section and atomically merge its monthly parquet.

    This is intentionally scriptable and independent from any LLM.  It reuses
    the same BigQuant relation and normalization contract already bundled with
    the original 8010/8002 logic.
    """
    import pandas as pd

    target = pd.Timestamp(_iso_date(payload.get("trade_date"))).normalize()
    vendor = Path(__file__).resolve().parents[1] / "python_engine" / "vendor_exact"
    if str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    database_text = _text(payload.get("database")) or os.environ.get("ASTER_MARKET_DB") or os.environ.get("QUANT_DB_PATH") or ""
    if database_text:
        os.environ["QUANT_DB_PATH"] = database_text
    from quant_mvp.heat_sources import HEAT_HISTORY_ROOT, normalize_ts_code, register_heat_history_view
    from quant_mvp.providers import get_bigquant_dai

    raw = get_bigquant_dai().query(
        f"""SELECT date,instrument,rank,score,rank_change FROM cn_stock_hot_rank
            WHERE date='{target:%Y-%m-%d}' ORDER BY rank""",
        filters={"date": [target.strftime("%Y-%m-%d"), target.strftime("%Y-%m-%d")]},
    ).df()
    if raw is None or raw.empty:
        raise RuntimeError(f"BigQuant heat cross-section {target:%Y-%m-%d} is not ready")
    rows = pd.DataFrame()
    rows["heat_date"] = pd.to_datetime(raw["date"], errors="coerce").dt.date
    rows["ts_code"] = raw["instrument"].map(normalize_ts_code)
    rows["heat_rank"] = pd.to_numeric(raw["rank"], errors="coerce")
    rows["heat_score_raw"] = pd.to_numeric(raw.get("score"), errors="coerce")
    rows["rank_change"] = pd.to_numeric(raw.get("rank_change"), errors="coerce")
    rows = rows.loc[rows["heat_date"].notna() & rows["ts_code"].ne("") & rows["heat_rank"].gt(0)].copy()
    universe = rows.groupby("heat_date")["heat_rank"].transform("max").clip(lower=1)
    rows["heat_rank_pct"] = 100.0 * rows["heat_rank"] / universe
    rows["heat_rank_score"] = (100.0 * (universe - rows["heat_rank"]) / (universe - 1.0).clip(lower=1.0)).clip(0, 100)
    rows["source"] = "bigquant_cn_stock_hot_rank"
    rows = rows.drop_duplicates(["heat_date", "ts_code"], keep="last").sort_values(["heat_date", "heat_rank", "ts_code"])
    if len(rows) < 4000:
        raise RuntimeError(f"BigQuant heat cross-section {target:%Y-%m-%d} covers only {len(rows)} stocks")
    HEAT_HISTORY_ROOT.mkdir(parents=True, exist_ok=True)
    destination = HEAT_HISTORY_ROOT / f"heat_{target:%Y%m}.parquet"
    existing = pd.read_parquet(destination) if destination.exists() else pd.DataFrame()
    if not existing.empty:
        existing_dates = pd.to_datetime(existing["heat_date"], errors="coerce").dt.date
        existing = existing.loc[existing_dates.ne(target.date())]
        rows = pd.concat([existing, rows], ignore_index=True)
    rows = rows.drop_duplicates(["heat_date", "ts_code"], keep="last").sort_values(["heat_date", "heat_rank", "ts_code"])
    temporary = destination.with_suffix(".tmp.parquet")
    rows.to_parquet(temporary, index=False, compression="zstd")
    temporary.replace(destination)
    register_heat_history_view()
    target_rows = int((pd.to_datetime(rows["heat_date"], errors="coerce").dt.date == target.date()).sum())
    return {"ok": True, "mode": "refresh_bigquant_heat", "trade_date": target.strftime("%Y-%m-%d"), "rows": target_rows, "source": "bigquant_cn_stock_hot_rank", "output": str(destination)}


def market_daily_history(payload: dict[str, Any]) -> dict[str, Any]:
    """Export audited official daily history for the recommendation universe."""
    import duckdb
    import pandas as pd
    from pathlib import Path

    database = Path(_text(payload.get("database")) or os.environ.get("ASTER_MARKET_DB") or os.environ.get("QUANT_DB_PATH") or "")
    codes = _valid_codes(payload.get("codes"))
    limit = max(80, min(500, int(_number(payload.get("limit"), 360) or 360)))
    if not database.exists() or not codes:
        raise ValueError("market daily history requires an independent database and valid codes")
    connection = duckdb.connect(str(database), read_only=True)
    try:
        code_frame = pd.DataFrame({"ts_code": codes})
        connection.register("requested_codes", code_frame)
        frame = connection.execute(
            """
            SELECT ts_code,trade_date,open,high,low,close,vol,amount FROM (
              SELECT d.*,row_number() OVER(PARTITION BY d.ts_code ORDER BY d.trade_date DESC) AS rn
              FROM daily_bar d JOIN requested_codes r USING(ts_code)
              WHERE d.open IS NOT NULL AND d.high IS NOT NULL AND d.low IS NOT NULL
                AND d.close IS NOT NULL AND d.close>0
            ) WHERE rn<=? ORDER BY ts_code,trade_date
            """, [limit]
        ).fetchdf()
    finally:
        connection.close()
    rows = []
    for row in frame.to_dict(orient="records"):
        rows.append({
            "code": _text(row.get("ts_code")).upper(), "trade_date": _iso_date(row.get("trade_date")),
            "open": _number(row.get("open")), "high": _number(row.get("high")), "low": _number(row.get("low")),
            "close": _number(row.get("close")), "volume": _number(row.get("vol")), "amount": _number(row.get("amount")),
            "unit_version": LEGACY_DAILY_UNIT_VERSION,
            "volume_unit": LEGACY_DAILY_UNITS["volume"],
            "amount_unit": LEGACY_DAILY_UNITS["amount"],
            "source": "bigquant_official:tushare_reconciled:independent_market_snapshot",
        })
    covered = len({row["code"] for row in rows})
    if covered < max(1, int(len(codes) * 0.95)):
        raise RuntimeError(f"official history covers only {covered}/{len(codes)} requested securities")
    return {"ok": True, "mode": "market_daily_history", "database": str(database), "codes": covered, "rows": rows, "source": "bigquant_official:tushare_reconciled:independent_market_snapshot"}


def chip_sample_distributions(payload: dict[str, Any]) -> dict[str, Any]:
    """Materialize the exact independent recurrence used by the 8010 stock page."""
    import numpy as np
    from pathlib import Path

    database = Path(_text(payload.get("database")) or os.environ.get("ASTER_MARKET_DB") or os.environ.get("QUANT_DB_PATH") or "")
    requested = []
    for item in payload.get("samples") or []:
        code = _text(item.get("code")).upper()
        trade_date = _iso_date(item.get("trade_date") or item.get("tradeDate"))
        if CODE_PATTERN.fullmatch(code) and {"code": code, "trade_date": trade_date} not in requested:
            requested.append({"code": code, "trade_date": trade_date})
    if not database.exists() or not requested:
        return {"ok": True, "mode": "chip_sample_distributions", "profiles": [], "requested": len(requested), "source": str(database)}
    os.environ["QUANT_DB_PATH"] = str(database.resolve())
    os.environ.setdefault("QUANT_DATA_ROOT", str(database.resolve().parent))
    vendor = Path(__file__).resolve().parents[1] / "python_engine" / "vendor_exact"
    if str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    from quant_mvp.current_chip import read_web_chip_distribution, reconstruct_chip_distribution
    from quant_mvp.raw_chip_peaks import raw_chip_peak_features

    profiles = []
    for item in requested:
        code = item["code"]
        trade_date = item["trade_date"]
        frame = read_web_chip_distribution(code, trade_date)
        source = "quant_mvp_web_chip_recent:independent_recurrence_v10"
        if frame.empty:
            frame = reconstruct_chip_distribution(code, trade_date)
            source = "quant_mvp_reconstruct_chip_distribution:independent_recurrence_v10"
        if frame.empty:
            continue
        work = frame[["price", "chips_ratio"]].copy().sort_values("price")
        work["price"] = work["price"].astype("float64")
        work["chips_ratio"] = work["chips_ratio"].astype("float64")
        work = work.replace([np.inf, -np.inf], np.nan).dropna()
        work = work[(work["price"] > 0) & (work["chips_ratio"] > 0)]
        total = float(work["chips_ratio"].sum()) if not work.empty else 0.0
        if total <= 0:
            continue
        work["chips_ratio"] = work["chips_ratio"] / total
        close_values = frame.get("close")
        close = None
        if close_values is not None:
            valid_close = close_values.dropna()
            close = float(valid_close.iloc[0]) if not valid_close.empty else None
        prices = work["price"].to_numpy(dtype="float64")
        ratios = work["chips_ratio"].to_numpy(dtype="float64")
        features = raw_chip_peak_features(
            prices,
            ratios,
            close=close if close is not None and math.isfinite(close) else math.nan,
        )
        points = [
            {"price": float(row.price), "chips_ratio": float(row.chips_ratio)}
            for row in work.itertuples(index=False)
        ]
        profit_ratio = float(ratios[prices <= close].sum()) if close is not None and math.isfinite(close) else None
        profiles.append({
            "code": code,
            "trade_date": trade_date,
            "close": close,
            "main_peak_price": _number(features.get("raw_main_peak_price")),
            "second_peak_price": _number(features.get("raw_second_peak_price")),
            "profit_ratio": profit_ratio,
            "peak2_ratio": _number(features.get("raw_peak2_ratio")),
            "peak_width_70": _number(features.get("raw_peak_width_70")),
            "points": points,
            "source": source,
        })
    return {"ok": True, "mode": "chip_sample_distributions", "profiles": profiles, "requested": len(requested), "covered": len(profiles), "source": str(database)}


COMMANDS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "capabilities": capabilities,
    "formal-daily": formal_daily,
    "warehouse-publish-official": warehouse_publish_official,
    "intraday-quotes": intraday_quotes,
    "intraday-execution-prices": intraday_execution_prices,
    "intraday-m30": intraday_m30,
    "market-daily-history": market_daily_history,
    "market-factor-snapshot": market_factor_snapshot,
    "refresh-bigquant-heat": refresh_bigquant_heat,
    "market-chip-axes": market_chip_axes,
    "score-chip-models": score_chip_models,
    "chip-sample-distributions": chip_sample_distributions,
}


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "capabilities"
    if command not in COMMANDS:
        raise ValueError(f"unknown provider command: {command}")
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    # Some SDKs print progress to stdout. Keep stdout machine-readable.
    with redirect_stdout(sys.stderr):
        result = COMMANDS[command](payload)
    print(OUTPUT_MARKER + json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        error = {"ok": False, "error": str(exc), "error_type": type(exc).__name__}
        print(OUTPUT_MARKER + json.dumps(error, ensure_ascii=False, separators=(",", ":")))
        raise SystemExit(2)
