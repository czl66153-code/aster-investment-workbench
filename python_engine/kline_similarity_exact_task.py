"""Aster adapter for the exact machine-stock-picker similarity engine.

The scoring, cache, quality and market-provider implementations are copied
from the U-disk migration package.  This file only adapts process lifecycle,
the Aster security master and durable progress/result files to the existing
single Node HTTP engine.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENDOR_RUNTIME = (
    PROJECT_ROOT
    / "python_engine"
    / "vendor_exact"
    / "machine_stock_picker_similarity"
    / "runtime"
)
sys.path.insert(0, str(VENDOR_RUNTIME))

from signal_desk.aia.api import similarity as similarity_api  # noqa: E402
from signal_desk.aia.similarity_cache import (  # noqa: E402
    refresh_similarity_cache,
    similarity_cache_status,
)
from signal_desk.aia.vision import GeminiVisionService, VisionConfig  # noqa: E402


SHANGHAI = timezone(timedelta(hours=8))


def _json_default(value: Any) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, default=_json_default),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _data_root() -> Path:
    return Path(os.environ.get("ASTER_DATA_ROOT") or PROJECT_ROOT / "data").resolve()


def _database_path() -> Path:
    return Path(os.environ.get("ASTER_DB_PATH") or _data_root() / "aster.db").resolve()


def _ticker(code: str) -> str:
    return (
        f"{code}.BJ"
        if code.startswith(("8", "4", "92"))
        else f"{code}.SH"
        if code.startswith(("6", "9"))
        else f"{code}.SZ"
    )


class AsterMarketHistoryProvider:
    """Expose the site's governed market warehouse to the migrated scanner.

    The similarity formulas remain the exact U-disk copy.  Only its market
    adapter is replaced: completed daily bars come from the site's reconciled
    BigQuant/Tushare publication and intraday bars/quotes come from AKShare
    materializations.  Existing migrated cache files remain a read-only
    historical fallback until a governed local tail is available.
    """

    name = "aster_governed_market_history"
    cache_version = "aster-market-history.v1.bigquant-tushare+akshare"

    def __init__(self, database: Path | None = None, market_database: Path | None = None) -> None:
        self.database = (database or _database_path()).resolve()
        self.market_database = (
            market_database
            or Path(os.environ.get("ASTER_MARKET_DB") or _data_root() / "market.duckdb")
        ).resolve()

    @staticmethod
    def _code(ticker: str) -> str:
        code, separator, exchange = str(ticker).upper().partition(".")
        if not separator or exchange not in {"SH", "SZ", "BJ"} or len(code) != 6:
            raise ValueError("invalid_aster_ticker")
        return f"{code}.{exchange}"

    def daily_history(self, ticker: str, start: Any, end: Any) -> list[dict[str, Any]]:
        code = self._code(ticker)
        connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro", uri=True, timeout=20)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                """SELECT trade_date,open,high,low,close,volume,amount,source,
                          COALESCE(unit_version,''),COALESCE(volume_unit,''),COALESCE(amount_unit,'')
                   FROM bars_daily WHERE code=? AND trade_date>=? AND trade_date<=?
                   ORDER BY trade_date""",
                (code, start.isoformat(), end.isoformat()),
            ).fetchall()
        finally:
            connection.close()
        output = []
        for row in rows:
            volume = float(row[5] or 0)
            amount = float(row[6] or 0)
            if str(row[9]).lower() == "lot":
                volume *= 100.0
            if str(row[10]).lower() == "thousand_cny":
                amount *= 1000.0
            output.append({
                "ticker": ticker, "trade_date": str(row[0]),
                "open": float(row[1]), "high": float(row[2]), "low": float(row[3]), "close": float(row[4]),
                "volume": volume, "amount": amount,
                "source": "aster_bigquant_tushare_formal",
                "upstream_source": str(row[7] or ""), "unit_version": str(row[8] or ""),
            })
        return output

    research_daily_history = daily_history

    @staticmethod
    def _bucket_30m(value: datetime) -> datetime | None:
        minute = value.hour * 60 + value.minute
        for start_minute, end_minute in ((9 * 60 + 30, 11 * 60 + 30), (13 * 60, 15 * 60)):
            if start_minute < minute <= end_minute:
                elapsed = minute - start_minute
                bucket = start_minute + ((elapsed + 29) // 30) * 30
                return value.replace(hour=bucket // 60, minute=bucket % 60, second=0, microsecond=0)
            if minute == start_minute:
                return value.replace(hour=(start_minute + 30) // 60, minute=(start_minute + 30) % 60, second=0, microsecond=0)
        return None

    def _duckdb_m30(self, ticker: str, start: Any, end: Any) -> list[dict[str, Any]]:
        if not self.market_database.exists():
            return []
        try:
            import duckdb

            connection = duckdb.connect(str(self.market_database), read_only=True)
            try:
                columns = {row[0] for row in connection.execute("DESCRIBE realtime_bar5m").fetchall()}
                unit_gate = "AND unit_version='aster_intraday_units_v1'" if "unit_version" in columns else ""
                rows = connection.execute(
                    f"""SELECT trade_time,open,high,low,close,volume,amount,data_source
                        FROM realtime_bar5m WHERE instrument=? AND trade_date>=? AND trade_date<=?
                          AND lower(COALESCE(data_source,'')) LIKE 'akshare%' {unit_gate}
                        ORDER BY trade_time""",
                    [self._code(ticker), start.isoformat(), end.isoformat()],
                ).fetchall()
            finally:
                connection.close()
        except Exception:
            return []
        grouped: dict[datetime, dict[str, Any]] = {}
        for raw_time, open_price, high, low, close, volume, amount, source in rows:
            trade_time = raw_time if isinstance(raw_time, datetime) else datetime.fromisoformat(str(raw_time))
            bucket = self._bucket_30m(trade_time)
            if bucket is None or any(value is None for value in (open_price, high, low, close)):
                continue
            item = grouped.setdefault(bucket, {
                "ticker": ticker, "trade_time": bucket.isoformat(sep=" "),
                "open": float(open_price), "high": float(high), "low": float(low), "close": float(close),
                "volume": 0.0, "amount": 0.0, "source": "aster_akshare_5m_aggregated_30m",
                "upstream_sources": set(),
            })
            item["high"] = max(float(item["high"]), float(high))
            item["low"] = min(float(item["low"]), float(low))
            item["close"] = float(close)
            item["volume"] += max(0.0, float(volume or 0))
            item["amount"] += max(0.0, float(amount or 0))
            item["upstream_sources"].add(str(source or ""))
        output = []
        for item in grouped.values():
            item["upstream_sources"] = sorted(item["upstream_sources"])
            output.append(item)
        return sorted(output, key=lambda item: item["trade_time"])

    def intraday_history(self, ticker: str, start: Any, end: Any, *, period: str = "30") -> list[dict[str, Any]]:
        if str(period) != "30":
            raise ValueError("aster_similarity_supports_30m_only")
        code = self._code(ticker)
        combined = {row["trade_time"]: row for row in self._duckdb_m30(ticker, start, end)}
        connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro", uri=True, timeout=20)
        connection.row_factory = sqlite3.Row
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(bars_30m)")}
            unit_gate = "AND unit_version='aster_intraday_units_v1'" if "unit_version" in columns else ""
            rows = connection.execute(
                f"""SELECT trade_time,open,high,low,close,volume,amount,source
                    FROM bars_30m WHERE code=? AND substr(trade_time,1,10)>=? AND substr(trade_time,1,10)<=?
                      AND lower(COALESCE(source,'')) LIKE 'akshare%' {unit_gate}
                    ORDER BY trade_time""",
                (code, start.isoformat(), end.isoformat()),
            ).fetchall()
        finally:
            connection.close()
        for row in rows:
            combined[str(row[0])] = {
                "ticker": ticker, "trade_time": str(row[0]),
                "open": float(row[1]), "high": float(row[2]), "low": float(row[3]), "close": float(row[4]),
                "volume": float(row[5] or 0), "amount": float(row[6] or 0),
                "source": "aster_akshare_30m", "upstream_source": str(row[7] or ""),
            }
        return [combined[key] for key in sorted(combined)]

    def daily_quotes(self, tickers: list[str]) -> dict[str, dict[str, Any]]:
        if not tickers or not self.market_database.exists():
            return {}
        codes = [self._code(ticker) for ticker in dict.fromkeys(tickers)]
        try:
            import duckdb

            connection = duckdb.connect(str(self.market_database), read_only=True)
            try:
                columns = {row[0] for row in connection.execute("DESCRIBE realtime_bar5m").fetchall()}
                unit_gate = "AND unit_version='aster_intraday_units_v1'" if "unit_version" in columns else ""
                placeholders = ",".join("?" for _ in codes)
                rows = connection.execute(
                    f"""SELECT instrument,arg_min(open,trade_time),arg_max(close,trade_time),max(high),min(low),
                               sum(volume),sum(amount),max(trade_time)
                        FROM realtime_bar5m WHERE trade_date=? AND instrument IN ({placeholders})
                          AND lower(COALESCE(data_source,'')) LIKE 'akshare%' {unit_gate}
                        GROUP BY instrument""",
                    [datetime.now(SHANGHAI).date().isoformat(), *codes],
                ).fetchall()
            finally:
                connection.close()
        except Exception:
            return {}
        names: dict[str, str] = {}
        try:
            sqlite_connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro", uri=True, timeout=20)
            placeholders = ",".join("?" for _ in codes)
            names = {str(code): str(name or code) for code, name in sqlite_connection.execute(
                f"SELECT code,name FROM securities WHERE code IN ({placeholders})", codes
            )}
            sqlite_connection.close()
        except sqlite3.Error:
            names = {}
        output = {}
        for code, open_price, close, high, low, volume, amount, observed in rows:
            if any(value is None for value in (open_price, close, high, low)):
                continue
            output[str(code)] = {
                "ticker": str(code), "name": names.get(str(code), str(code)),
                "trade_date": observed.date(), "open": float(open_price), "close": float(close),
                "high": float(high), "low": float(low), "volume": float(volume or 0), "amount": float(amount or 0),
                "source": "aster_akshare_intraday_daily_quote", "adjustment": "none",
                "volume_unit": "shares", "volume_shares": float(volume or 0),
                "similarity_unit_version": "aster_similarity_shares_v1",
                "as_of": observed.replace(tzinfo=SHANGHAI).isoformat() if observed.tzinfo is None else observed.astimezone(SHANGHAI).isoformat(),
            }
        return output


def _security_universe(data_root: Path) -> list[dict[str, str]]:
    names: dict[str, str] = {}
    database = _database_path()
    if database.exists():
        try:
            connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
            for raw_code, raw_name in connection.execute("SELECT code,name FROM securities"):
                code = str(raw_code or "").split(".", 1)[0].zfill(6)
                if len(code) == 6 and code.isdigit():
                    names[code] = str(raw_name or code)
            connection.close()
        except (sqlite3.Error, OSError):
            names = {}

    matrix_path = data_root / "aia" / "cache" / "daily-close-matrix.json"
    try:
        closes = json.loads(matrix_path.read_text("utf-8")).get("closes") or {}
    except (OSError, ValueError, AttributeError):
        closes = {}
    universe: list[dict[str, str]] = []
    for ticker in closes:
        code, separator, market = str(ticker).partition(".")
        if separator != "." or market not in {"SH", "SZ", "BJ"}:
            continue
        if len(code) != 6 or not code.isdigit():
            continue
        if code not in names:
            # The migrated close matrix also contains indices, B-shares and
            # delisted instruments.  They are not members of Aster's governed
            # A-share master and must not enter results protected by a FK.
            continue
        universe.append(
            {
                "code": code,
                "ticker": f"{code}.{market}",
                "name": names.get(code, code),
                "source": "Aster security master + AIA daily-close-matrix",
            }
        )
    if universe:
        return universe

    daily_cache = data_root / "aia" / "cache" / "similarity_kline" / "daily"
    for path in daily_cache.glob("*.json.gz"):
        code, _, market = path.stem.replace(".json", "").partition("_")
        if len(code) == 6 and code.isdigit() and market in {"SH", "SZ", "BJ"}:
            universe.append(
                {
                    "code": code,
                    "ticker": f"{code}.{market}",
                    "name": names.get(code, code),
                    "source": "AIA similarity cache",
                }
            )
    return universe


class _NoCredentialStore:
    storage_label = "not_migrated_reconfigure_on_target"

    def load(self) -> dict[str, str]:
        return {}

    def save(self, _payload: dict[str, str]) -> None:
        raise RuntimeError("credential_store_unavailable")

    def clear(self) -> None:
        return None


def _vision_service() -> GeminiVisionService:
    import httpx

    key = os.environ.get("ASTER_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
    enabled = os.environ.get("ASTER_AIA_VISION_ENABLED") == "1" and bool(key)
    scan_enabled = os.environ.get("ASTER_AIA_VISION_SCAN_ENABLED") == "1" and enabled
    config = VisionConfig(
        enabled=enabled,
        scan_enabled=scan_enabled,
        gemini_api_key=key,
        gemini_model=os.environ.get("ASTER_AIA_VISION_MODEL", "gemini-2.5-flash"),
        gemini_base_url=os.environ.get(
            "ASTER_AIA_VISION_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        timeout_seconds=float(os.environ.get("ASTER_AIA_VISION_TIMEOUT_SECONDS", "12")),
    )
    return GeminiVisionService(
        config,
        transport=httpx.Client(),
        credential_store=_NoCredentialStore(),
    )


def _app() -> Any:
    data_root = _data_root()
    state = SimpleNamespace(
        aia_data_root=data_root,
        aia_similarity_universe=_security_universe(data_root),
        market_history_provider=AsterMarketHistoryProvider(),
        aia_vision_service=_vision_service(),
        scheduler=None,
        akshare_provider=None,
    )
    return SimpleNamespace(state=state)


def _job_path(scan_id: str) -> Path:
    return _data_root() / "similarity" / "jobs" / f"{scan_id}.json"


def _result_path(scan_id: str) -> Path:
    return _data_root() / "similarity" / "results" / f"{scan_id}.json.gz"


def _write_job(scan_id: str, **values: Any) -> None:
    path = _job_path(scan_id)
    try:
        current = json.loads(path.read_text("utf-8")) if path.exists() else {}
    except (OSError, ValueError):
        current = {}
    current.update(values)
    current.update({"scan_id": scan_id, "updated_at": datetime.now(SHANGHAI).isoformat()})
    _atomic_json(path, current)


def _cancelled(scan_id: str) -> bool:
    return (_data_root() / "similarity" / "jobs" / f"{scan_id}.cancel").exists()


def _complete_chart_warmup(
    data: dict[str, Any],
    app: Any,
    *,
    period: str,
    end: Any,
) -> None:
    """Hydrate rendering history for returned charts without changing scores.

    Similarity ranking still uses the exact migrated window and formulas.  This
    bounded pass only extends the local history of the reference and published
    Top-N candidates so MA5/MA30/MA250 can be drawn across every visible bar.
    """
    charts = [data.get("reference") or {}, *(data.get("items") or [])]
    required = 249
    for chart in charts:
        visible = chart.get("bars") or []
        existing = chart.get("warmup_bars") or []
        if not visible:
            continue
        if len(existing) >= required:
            chart["indicator_quality"] = {
                "required_warmup": required,
                "actual_warmup": len(existing),
                "complete": True,
            }
            continue
        ticker = str(chart.get("ticker") or "").strip()
        if not ticker:
            code = str(chart.get("code") or "").split(".", 1)[0].zfill(6)
            ticker = _ticker(code)
        try:
            lookback_days = 180 if period == "m30" else 900
            rows = similarity_api._rows(
                app.state.market_history_provider,
                ticker,
                end - timedelta(days=lookback_days),
                end,
                period,
                app.state.aia_data_root,
            )
            warmup = similarity_api._indicator_warmup(rows, visible, limit=required)
            if len(warmup) > len(existing):
                chart["warmup_bars"] = warmup
                existing = warmup
        except Exception as exc:
            chart["indicator_warmup_error"] = f"{type(exc).__name__}:{exc}"
        chart["indicator_quality"] = {
            "required_warmup": required,
            "actual_warmup": len(existing),
            "complete": len(existing) >= required,
        }


def run_scan(arguments: argparse.Namespace) -> dict[str, Any]:
    scan_id = arguments.scan_id
    _write_job(
        scan_id,
        status="running",
        processed=0,
        total=0,
        missing=0,
        started_at=datetime.now(SHANGHAI).isoformat(),
    )
    original_set_job = similarity_api._set_job
    original_cancelled = similarity_api._cancelled

    def progress(_job_id: str, **values: Any) -> None:
        _write_job(scan_id, **values)

    similarity_api._set_job = progress
    similarity_api._cancelled = lambda _job_id=None: _cancelled(scan_id)
    similarity_api._SCAN_CONTEXT.job_id = scan_id
    try:
        payload = similarity_api.SimilarityScanRequest(
            reference_code=arguments.reference_code,
            start=arguments.start,
            end=arguments.end,
            period=arguments.period,
            top_n=arguments.top_n,
            vision_enabled=arguments.vision_enabled,
        )
        app = _app()
        request = SimpleNamespace(app=app)
        result = similarity_api.scan(payload, request)
        data = result.get("data") or {}
        _complete_chart_warmup(
            data,
            app,
            period=payload.period,
            end=payload.end,
        )
        result_path = _result_path(scan_id)
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_bytes(
            gzip.compress(
                json.dumps(result, ensure_ascii=False, default=_json_default).encode("utf-8")
            )
        )
        items = data.get("items") or []
        progress = data.get("progress") or {}
        cancelled = progress.get("status") == "cancelled" or _cancelled(scan_id)
        _write_job(
            scan_id,
            status="cancelled" if cancelled else "completed",
            processed=int(progress.get("processed") or len(items)),
            total=int(progress.get("total") or len(items)),
            missing=int(progress.get("missing") or 0),
            percent=100.0 if not cancelled else None,
            result_count=len(items),
            result_path=str(result_path),
            finished_at=datetime.now(SHANGHAI).isoformat(),
        )
        return {
            "status": "cancelled" if cancelled else "completed",
            "scan_id": scan_id,
            "result_path": str(result_path),
            "result": result,
        }
    except Exception as exc:
        _write_job(
            scan_id,
            status="failed",
            error=f"{type(exc).__name__}:{exc}",
            finished_at=datetime.now(SHANGHAI).isoformat(),
        )
        raise
    finally:
        similarity_api._SCAN_CONTEXT.job_id = None
        similarity_api._set_job = original_set_job
        similarity_api._cancelled = original_cancelled


def cache_status(force: bool = False) -> dict[str, Any]:
    cache_path = _data_root() / "similarity" / "cache_status.json"
    if not force and cache_path.exists():
        age = datetime.now().timestamp() - cache_path.stat().st_mtime
        if age < 300:
            try:
                return json.loads(cache_path.read_text("utf-8"))
            except (OSError, ValueError):
                pass
    status = similarity_cache_status(_data_root())
    _atomic_json(cache_path, status)
    return status


def run_refresh(batch_size: int) -> dict[str, Any]:
    result = refresh_similarity_cache(_app(), batch_size=batch_size)
    # Refresh status after bars and feature snapshots have been committed.
    cache_status(force=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(prog="aster-kline-similarity-exact")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan")
    scan_parser.add_argument("--scan-id", required=True)
    scan_parser.add_argument("--reference-code", required=True)
    scan_parser.add_argument("--start", required=True)
    scan_parser.add_argument("--end", required=True)
    scan_parser.add_argument("--period", choices=("daily", "m30"), default="daily")
    scan_parser.add_argument("--top-n", type=int, default=50)
    scan_parser.add_argument("--vision-enabled", action="store_true")

    status_parser = subparsers.add_parser("cache-status")
    status_parser.add_argument("--force", action="store_true")

    refresh_parser = subparsers.add_parser("cache-refresh")
    refresh_parser.add_argument("--batch-size", type=int, default=120)

    subparsers.add_parser("status")
    arguments = parser.parse_args()

    if arguments.command == "scan":
        result = run_scan(arguments)
    elif arguments.command == "cache-status":
        result = cache_status(force=arguments.force)
    elif arguments.command == "cache-refresh":
        result = run_refresh(max(1, min(120, arguments.batch_size)))
    else:
        app = _app()
        result = {
            "local_enabled": True,
            "universe_count": len(app.state.aia_similarity_universe),
            "realtime_quotes": callable(
                getattr(app.state.market_history_provider, "daily_quotes", None)
            ),
            "intraday_history": callable(
                getattr(app.state.market_history_provider, "intraday_history", None)
            ),
            "vision": app.state.aia_vision_service.status(),
            "cache": cache_status(),
            "automatic_refresh": {
                "enabled": True,
                "interval_minutes": 15,
                "max_instances": 1,
            },
        }
    print(json.dumps(result, ensure_ascii=False, default=_json_default))
    sys.stdout.flush()
    if arguments.command == "cache-refresh":
        # The copied U-drive cache module owns long-lived thread pools because
        # it normally runs inside a web process.  In Aster this command is a
        # short-lived scheduler adapter; timed-out provider futures can keep
        # Python alive after every atomic cache commit.  Exit only after the
        # final JSON and status snapshot have been flushed so the five-minute
        # single-instance scheduler can advance to the next incremental batch.
        os._exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
