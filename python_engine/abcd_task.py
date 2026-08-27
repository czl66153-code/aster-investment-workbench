"""Run the copied 8010 ABCD pipeline against the independent market database.

The original scoring, gates, chip reconstruction and ranking code are imported
from ``vendor_exact.quant_mvp``.  Only the transport policy is overridden:
intraday snapshots come from AkShare and may never fall back to Tencent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, time as clock_time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "python_engine" / "vendor_exact"
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))


def _market_session(now: datetime) -> bool:
    if now.weekday() >= 5:
        return False
    return clock_time(9, 25) <= now.time() <= clock_time(11, 35) or clock_time(12, 55) <= now.time() <= clock_time(15, 5)


def _fetch_akshare_only() -> Any:
    """Read the centrally acquired AKShare snapshot; never fetch a second copy."""
    import pandas as pd

    path = Path(os.environ.get("ASTER_DB_PATH") or "")
    if not path.is_file():
        raise RuntimeError("canonical Aster database is unavailable")
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
    try:
        expected = int(connection.execute("SELECT count(*) FROM securities").fetchone()[0] or 0)
        rows = connection.execute(
            """SELECT code,price,volume,amount,quote_time,source FROM realtime_quotes
               WHERE substr(quote_time,1,10)=? AND lower(source) LIKE 'akshare_%'
               ORDER BY code""",
            (datetime.now().strftime("%Y-%m-%d"),),
        ).fetchall()
    finally:
        connection.close()
    minimum = max(1, int(expected * 0.95 + 0.999999))
    if len(rows) < minimum:
        raise RuntimeError(f"canonical AKShare snapshot covers only {len(rows)}/{expected}; require {minimum}")
    frame = pd.DataFrame(rows, columns=["instrument", "latest", "cum_volume", "cum_amount", "quote_time", "source"])
    frame["symbol"] = frame["instrument"].astype(str).str[:6]
    frame["change_5m"] = float("nan")
    frame.attrs["realtime_source"] = "aster_canonical_akshare_snapshot"
    frame.attrs["volume_unit"] = "shares"
    return frame[["symbol", "latest", "cum_volume", "cum_amount", "change_5m"]]


def _first(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if row.get(key) is not None:
            return row.get(key)
    return None


def _weight_control() -> dict[str, Any]:
    fallback = {"mode": "original", "revision": 1, "weights": {"ranking": {"a": 25, "b": 25, "c": 25, "d": 25}}}
    path = Path(os.environ.get("ASTER_DB_PATH") or "")
    if not path.is_file():
        return fallback
    try:
        connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
        connection.row_factory = sqlite3.Row
        row = connection.execute("SELECT mode,weights_json,revision,updated_at FROM model_weight_configs WHERE model_key='abcd'").fetchone()
        connection.close()
        if not row:
            return fallback
        return {"mode": str(row["mode"]), "revision": int(row["revision"]), "weights": json.loads(str(row["weights_json"])), "updated_at": row["updated_at"]}
    except (OSError, sqlite3.Error, TypeError, ValueError, json.JSONDecodeError):
        return fallback


def _adopt_audited_imported_chip_cache(original: Any) -> dict[str, Any]:
    """Load an imported 8010 PIT cache only for its audited snapshot date.

    The vendor code normally rejects a cache produced by an older model asset
    revision and rebuilds it.  For a one-time 8010 migration that would change
    the historical D ranking.  Aster therefore adopts the already-ranked
    payload only when the SQLite lineage explicitly identifies the imported
    snapshot, coverage is at least 95%, and every row carries the D score/rank
    fields.  Future dates continue through the normal current-model path.
    """
    aster_path = Path(os.environ.get("ASTER_DB_PATH") or "")
    market_path = Path(os.environ.get("QUANT_DB_PATH") or "")
    if not aster_path.is_file() or not market_path.is_file():
        return {"used": False, "reason": "database path unavailable"}
    try:
        connection = sqlite3.connect(f"{aster_path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
        row = connection.execute("SELECT value FROM metadata WHERE key='market_data_state'").fetchone()
        connection.close()
        state = json.loads(str(row[0])) if row else {}
        migration = state.get("migration") if isinstance(state, dict) else {}
        trade_date = str((migration or {}).get("tradeDate") or "")[:10]
        if not trade_date or (migration or {}).get("runtimeDependency") is not False:
            return {"used": False, "reason": "no audited one-time migration"}
        requested_key = str(original.realtime_market.status().get("latest_update") or "")
        if requested_key[:10] != trade_date:
            return {"used": False, "reason": "snapshot date differs from migration lineage"}

        import duckdb
        import pandas as pd

        duck = duckdb.connect(str(market_path), read_only=True)
        factor_time = duck.execute(
            "SELECT max(factor_time) FROM realtime_chip_factor_cache WHERE trade_date=?",
            [trade_date],
        ).fetchone()[0]
        rows = duck.execute(
            "SELECT payload_json FROM realtime_chip_factor_cache WHERE factor_time=? ORDER BY ts_code",
            [factor_time],
        ).fetchall()
        duck.close()
        expected = int((state.get("coverage") or {}).get("expected") or 0)
        minimum = max(1, int(expected * 0.95 + 0.999999))
        if len(rows) < minimum:
            return {"used": False, "reason": f"imported chip coverage {len(rows)}/{expected}"}
        records = [json.loads(item[0]) for item in rows]
        factors = pd.DataFrame(records)
        required = {"ts_code", "chip_shape_score", "chip_shape_rank", "chip_shape_rank_pct"}
        if factors.empty or not required.issubset(factors.columns) or factors[list(required)].isna().any().any():
            return {"used": False, "reason": "imported D fields are incomplete"}
        with original._REALTIME_CHIP_CACHE_LOCK:
            original._REALTIME_CHIP_CACHE = factors
            original._REALTIME_CHIP_CACHE_KEY = requested_key
            original._REALTIME_CHIP_CACHE_ERROR = ""
        return {"used": True, "trade_date": trade_date, "factor_time": str(factor_time), "rows": len(factors), "source": "audited_8010_realtime_chip_factor_cache"}
    except Exception as exc:
        return {"used": False, "reason": f"{type(exc).__name__}: {exc}"}


def _adopt_audited_imported_observation_seed(original: Any) -> dict[str, Any]:
    """Restore the exact read-only 8010 seed used with the migrated snapshot."""

    aster_path = Path(os.environ.get("ASTER_DB_PATH") or "")
    market_path = Path(os.environ.get("QUANT_DB_PATH") or "")
    if not aster_path.is_file() or not market_path.is_file():
        return {"used": False, "rows": 0, "reason": "database path unavailable"}
    try:
        connection = sqlite3.connect(f"{aster_path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
        row = connection.execute("SELECT value FROM metadata WHERE key='market_data_state'").fetchone()
        connection.close()
        state = json.loads(str(row[0])) if row else {}
        migration = state.get("migration") if isinstance(state, dict) else {}
        trade_date = str((migration or {}).get("tradeDate") or "")[:10]
        current_date = str(original.realtime_market.status().get("data_trade_date") or "")[:10]
        if not trade_date or current_date != trade_date or (migration or {}).get("runtimeDependency") is not False:
            return {"used": False, "rows": 0, "reason": "snapshot does not match audited migration"}

        import duckdb

        duck = duckdb.connect(str(market_path), read_only=True)
        panel = duck.execute("SELECT * FROM legacy_8010_observation_seed ORDER BY ts_code").fetchdf()
        duck.close()
        expected = int((state.get("coverage") or {}).get("expected") or 0)
        minimum = max(1, int(expected * 0.95 + 0.999999))
        if len(panel) < minimum:
            return {"used": False, "rows": len(panel), "reason": f"seed coverage {len(panel)}/{expected}"}
        with original._REALTIME_OBSERVATION_SEED_LOCK:
            original._REALTIME_OBSERVATION_SEED = panel.copy()
            original._REALTIME_OBSERVATION_SEED_VERSION += 1
        return {
            "used": True,
            "loaded": True,
            "rows": len(panel),
            "trade_date": trade_date,
            "factor_date": str(panel["trade_date"].max())[:10],
            "error": "",
            "source": "audited_8010_observation_seed",
        }
    except Exception as exc:
        return {"used": False, "loaded": False, "rows": 0, "reason": f"{type(exc).__name__}: {exc}", "error": f"{type(exc).__name__}: {exc}"}


def _compact_row(row: dict[str, Any]) -> dict[str, Any]:
    code = str(row.get("ts_code") or row.get("code") or "")
    return {
        "code": code,
        "name": row.get("name"),
        "industry": row.get("industry"),
        "rank": _first(row, "rank", "abcd_rank", "grid_rank"),
        "score": _first(row, "score", "abcd_score", "core_score", "grid_score"),
        "a_score": _first(row, "a_score", "a"),
        "b_score": _first(row, "b_core_score", "b_score", "b"),
        "c_score": _first(row, "c_score", "c"),
        "d_score": _first(row, "d_score", "grid_d_score", "d"),
        "d_rank": row.get("d_rank"),
        "reason": row.get("reason") or row.get("selection_reason"),
        "raw": row,
    }


def _compact_score_panel(
    original: Any,
    trade_date: str,
    factor_time: Any,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Export the exact 8010 full-market ABCD panel for SQLite writeback.

    The recommendation rows are only the small hard-gate result set.  The
    copied 8010 implementation also keeps the complete score panel in memory;
    returning this compact projection prevents the screener from seeing NULL
    for every non-recommended stock without reimplementing the scoring logic.
    """
    meta = dict(meta or {})
    lineage = {
        "chip_model_version": str(getattr(original, "RAW_PEAK_MODEL_VERSION", "") or ""),
        "shape_score_version": str(getattr(original, "_REALTIME_SHAPE_SCORE_VERSION", "") or ""),
        "distribution_mode": str(getattr(original, "REALTIME_CHIP_DISTRIBUTION_MODE", "") or ""),
        "source_quote_time": str(factor_time or ""),
        "chip_factor_age_minutes": meta.get("chip_factor_age_minutes"),
        "chip_factor_ready": bool(meta.get("chip_ready")),
        "chip_factor_building": bool(meta.get("chip_factor_building")),
        "chip_factor_stale": bool(meta.get("chip_factor_stale")),
    }
    panel = getattr(original, "_REALTIME_ABCD_SCORE_CACHE", None)
    if panel is None or getattr(panel, "empty", True):
        return {
            "trade_date": str(trade_date or "")[:10],
            "factor_time": factor_time,
            "source": "quant_mvp.app._REALTIME_ABCD_SCORE_CACHE",
            "eligible_universe_count": 0,
            "row_count": 0,
            "items": [],
            **lineage,
        }

    import math
    import numbers

    def scalar(value: Any) -> Any:
        if value is None:
            return None
        try:
            if bool(value != value):
                return None
        except (TypeError, ValueError):
            pass
        if isinstance(value, bool):
            return bool(value)
        if isinstance(value, numbers.Integral):
            return int(value)
        if isinstance(value, numbers.Real):
            number = float(value)
            return number if math.isfinite(number) else None
        return str(value)

    universe_values = panel.get("market_universe_count")
    eligible_universe_count = int(universe_values.dropna().max()) if universe_values is not None and not universe_values.dropna().empty else int(len(panel))
    rows: list[dict[str, Any]] = []
    available = [column for column in ("ts_code", "a_score", "b_score", "c_score", "d_score", "d_available") if column in panel.columns]
    for raw in panel.reindex(columns=available).drop_duplicates("ts_code").to_dict(orient="records"):
        code = str(raw.get("ts_code") or "").upper()
        if not code:
            continue
        d_available = scalar(raw.get("d_available"))
        rows.append({
            "code": code,
            "a_score": scalar(raw.get("a_score")),
            "b_score": scalar(raw.get("b_score")),
            "c_score": scalar(raw.get("c_score")),
            "d_score": scalar(raw.get("d_score")),
            "d_available": bool(d_available) if isinstance(d_available, (bool, int, float)) else False,
        })
    return {
        "trade_date": str(trade_date or "")[:10],
        "factor_time": factor_time,
        "source": "quant_mvp.app._REALTIME_ABCD_SCORE_CACHE",
        "algorithm": "quant_mvp.realtime_abcd.build_abcd_recommendations",
        "eligibility_policy": "close>0; amount>0; pct_chg[-40,40]; non-ST; industry-present",
        "eligible_universe_count": eligible_universe_count,
        "row_count": len(rows),
        "items": rows,
        **lineage,
    }


def _chip_payload_is_publishable(payload: dict[str, Any]) -> bool:
    """Only publish the latest completed, version-compatible chip panel.

    The copied 8010 UI deliberately keeps a recent prior panel visible while
    the expensive full-market reconstruction runs.  That is useful for a
    screen, but a short-lived publication worker must not turn that visual
    fallback into a new recommendation batch before any valid model result
    exists.  A completed latest panel may remain in use while the next panel
    is building; its actual factor time is preserved for the frontend.
    """
    meta = dict(payload.get("meta") or {})
    factor_time = str(meta.get("factor_time") or "").strip()
    return bool(factor_time and meta.get("chip_ready"))


def _writeback_score_panel_compat(score_panel: dict[str, Any]) -> dict[str, Any]:
    """Compatibility writeback for an already-running pre-upgrade scheduler.

    New Node workers set ``ASTER_NODE_ABCD_WRITEBACK=1`` and use the richer
    transactional writer in ``engine/core.mjs``.  A scheduler process that was
    already alive before this deployment does not set that flag, so this
    backend fallback guarantees that tonight's job still fills the latest
    screener snapshot.  Both paths enforce the same point-in-time and coverage
    gates and neither path computes scores.
    """
    if os.environ.get("ASTER_NODE_ABCD_WRITEBACK") == "1":
        return {"status": "delegated_to_node", "applied": False}
    path = Path(os.environ.get("ASTER_DB_PATH") or "")
    if not path.is_file():
        return {"status": "skipped", "applied": False, "message": "Aster数据库不存在"}
    panel_date = str(score_panel.get("trade_date") or "")[:10]
    items = list(score_panel.get("items") or [])
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        governed = connection.execute(
            """SELECT f.version_id,f.trade_date FROM dataset_versions f
               JOIN dataset_dependencies d ON d.child_dataset_key='factor_snapshot' AND d.child_version_id=f.version_id
               JOIN dataset_versions p ON p.dataset_key=d.parent_dataset_key AND p.version_id=d.parent_version_id
               WHERE f.dataset_key='factor_snapshot' AND f.status='published'
                 AND d.parent_dataset_key='formal_daily' AND p.status='published'
                 AND lower(p.source) LIKE '%bigquant%' AND lower(p.source) LIKE '%tushare%'
                 AND f.trade_date=p.trade_date
               ORDER BY f.created_at DESC LIMIT 1"""
        ).fetchone()
        factor_date = str(governed["trade_date"] or "")[:10] if governed else ""
        if not factor_date or panel_date != factor_date:
            return {
                "status": "skipped_date_mismatch",
                "applied": False,
                "factor_date": factor_date,
                "panel_date": panel_date,
                "message": "仅回写最新正式交易日，历史或盘中跨日面板已跳过",
            }
        universe = {str(row[0]) for row in connection.execute("SELECT code FROM factor_snapshot WHERE trade_date=?", (factor_date,))}
        total = len(universe)
        eligible_total = int(score_panel.get("eligible_universe_count") or total)

        def valid(value: Any) -> float | None:
            if value is None or value == "":
                return None
            try:
                number = float(value)
            except (TypeError, ValueError):
                return None
            return number if 0 <= number <= 100 else None

        deduplicated: dict[str, tuple[float | None, float | None, float | None, float | None]] = {}
        for item in items:
            code = str(item.get("code") or item.get("ts_code") or "").upper()
            if code not in universe:
                continue
            deduplicated[code] = (
                valid(item.get("a_score")), valid(item.get("b_score")),
                valid(item.get("c_score")), valid(item.get("d_score")),
            )
        counts = {
            "matched": len(deduplicated),
            "a": sum(value[0] is not None for value in deduplicated.values()),
            "b": sum(value[1] is not None for value in deduplicated.values()),
            "c": sum(value[2] is not None for value in deduplicated.values()),
            "d": sum(value[3] is not None for value in deduplicated.values()),
        }
        coverage = {
            "formalUniverse": counts["matched"] / total if total else 0,
            "eligibleMatch": counts["matched"] / eligible_total if eligible_total else 0,
            **{key: counts[key] / eligible_total if eligible_total else 0 for key in ("a", "b", "c", "d")},
        }
        observed = {
            "factorDate": factor_date, "panelDate": panel_date, "total": total,
            "eligibleTotal": eligible_total, "panelRows": len(items), "counts": counts,
            "coverage": coverage, "eligibilityPolicy": score_panel.get("eligibility_policy"),
        }
        failures = [key for key in ("eligibleMatch", "a", "b", "c", "d") if coverage[key] < 0.95]
        if coverage["formalUniverse"] < 0.85:
            failures.insert(0, "formalUniverse")
        if failures:
            connection.execute(
                """INSERT INTO data_quality_checks(check_id,dataset_key,version_id,check_name,severity,status,observed_value,expected_value,message,checked_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), "factor_abcd_scores", governed["version_id"], "latest_factor_abcd_full_market_coverage", "critical", "fail", json.dumps(observed, ensure_ascii=False), json.dumps({"minimumEligibleCoverage": 0.95, "minimumFormalUniverseCoverage": 0.85}), f"覆盖门禁未通过：{'/'.join(failures)}", datetime.now().isoformat()),
            )
            connection.commit()
            return {"status": "failed", "applied": False, "message": f"覆盖门禁未通过：{'/'.join(failures)}", **observed}

        ordered = sorted((code, *values) for code, values in deduplicated.items())
        checksum = hashlib.sha256(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        version_id = f"factor-abcd-{factor_date}-{int(time.time() * 1000)}-compat"
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("UPDATE factor_snapshot SET abcd_a_score=NULL,abcd_b_score=NULL,abcd_c_score=NULL,abcd_d_score=NULL WHERE trade_date=?", (factor_date,))
        connection.executemany(
            """UPDATE factor_snapshot SET abcd_a_score=?,abcd_b_score=?,abcd_c_score=?,abcd_d_score=?,updated_at=CURRENT_TIMESTAMP
               WHERE code=? AND trade_date=?""",
            [(a, b, c, d, code, factor_date) for code, a, b, c, d in ordered],
        )
        connection.execute("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='factor_abcd_scores' AND status='published'")
        connection.execute(
            """INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at)
               VALUES('factor_abcd_scores',?,?,?,?, 'published','8010_original_exact_full_market_score_panel_compat',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)""",
            (version_id, factor_date, len(ordered), checksum, min(coverage[key] for key in ("eligibleMatch", "a", "b", "c", "d")) * 100),
        )
        connection.execute(
            """INSERT INTO dataset_dependencies(child_dataset_key,child_version_id,parent_dataset_key,parent_version_id,relation_type)
               VALUES('factor_abcd_scores',?,'factor_snapshot',?,'enriches')""",
            (version_id, governed["version_id"]),
        )
        state = {**observed, "source": score_panel.get("source"), "algorithm": score_panel.get("algorithm"), "factorTime": score_panel.get("factor_time"), "versionId": version_id, "updatedAt": datetime.now().isoformat(), "compatibilityWriter": True}
        connection.execute(
            """INSERT INTO metadata(key,value,updated_at) VALUES('abcd_factor_coverage_state',?,CURRENT_TIMESTAMP)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP""",
            (json.dumps(state, ensure_ascii=False),),
        )
        connection.execute(
            """INSERT INTO data_quality_checks(check_id,dataset_key,version_id,check_name,severity,status,observed_value,expected_value,message,checked_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), "factor_abcd_scores", version_id, "latest_factor_abcd_full_market_coverage", "critical", "pass", json.dumps(observed, ensure_ascii=False), json.dumps({"minimumEligibleCoverage": 0.95, "minimumFormalUniverseCoverage": 0.85}), f"最新正式因子日{factor_date}的ABCD四项覆盖通过", datetime.now().isoformat()),
        )
        connection.commit()
        return {"status": "applied", "applied": True, "trade_date": factor_date, "version_id": version_id, "row_count": len(ordered), "counts": counts, "coverage": coverage}
    except Exception as exc:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        return {"status": "failed", "applied": False, "message": f"{type(exc).__name__}: {exc}"}
    finally:
        connection.close()


def warmup() -> dict[str, Any]:
    """Advance the copied 8010 five-minute collector without running scores."""
    started = time.monotonic()
    from quant_mvp import app as original

    original.realtime_market._fetcher = _fetch_akshare_only
    original.realtime_market._use_database = True
    original.realtime_market._load_latest_cache()
    now = datetime.now().replace(microsecond=0)
    if not _market_session(now):
        return {
            "ok": False,
            "status": "outside_market_session",
            "task": "abcd_5m_warmup",
            "message": "当前不在A股盘中采集时段",
            "duration_ms": round((time.monotonic() - started) * 1000, 2),
        }
    original.realtime_market.refresh_market(now)
    status = original.realtime_market.status(now)
    ok = bool(
        str(status.get("data_trade_date") or "") == now.strftime("%Y-%m-%d")
        and not status.get("last_error")
    )
    return {
        "ok": ok,
        "status": "ready" if ok else "kept_previous",
        "task": "abcd_5m_warmup",
        "source_policy": "shared_canonical_intraday_akshare_only; no_tencent_fallback",
        "items": [],
        "count": int(status.get("market_symbols") or 0),
        "market_status": status,
        "message": (
            f"ABCD五分钟筹码线已从09:30连续沉淀；完成栏记录{int(status.get('completed_bars') or 0)}条"
            if ok
            else str(status.get("last_error") or "AKShare盘中快照尚未就绪")
        ),
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
    }


def run(refresh: bool, wait_seconds: int) -> dict[str, Any]:
    started = time.monotonic()
    from quant_mvp import app as original

    original.realtime_market._fetcher = _fetch_akshare_only
    original.realtime_market._use_database = True
    original.realtime_market._load_latest_cache()
    observation_seed = _adopt_audited_imported_observation_seed(original)
    if not observation_seed.get("used"):
        try:
            # Normal future dates use the independent formal factor store.
            seed_panel = original._refresh_realtime_observation_seed()
            observation_seed.update({"loaded": bool(len(seed_panel)), "rows": int(len(seed_panel)), "error": ""})
        except Exception as exc:
            observation_seed["error"] = f"{type(exc).__name__}: {exc}"
    imported_chip_cache = _adopt_audited_imported_chip_cache(original)
    refreshed = False
    refresh_error = ""
    now = datetime.now()
    if refresh and _market_session(now):
        try:
            original.realtime_market.refresh_market(now.replace(microsecond=0))
            refreshed = True
        except Exception as exc:  # pragma: no cover - provider dependent
            refresh_error = f"{type(exc).__name__}: {exc}"

    # The original website keeps this service alive in the web process.  Aster
    # runs a short-lived worker, so a manual/intraday refresh must complete the
    # same existing free-signal collection synchronously before ABCD scoring;
    # otherwise every enhancement would silently fall back to neutral 50.
    data_trade_date = str(original.realtime_market.status().get("data_trade_date") or "")
    refresh_free_signals = bool(
        refresh
        and _market_session(now)
        and data_trade_date == now.strftime("%Y-%m-%d")
    )
    free_signal_refresh: dict[str, Any] = {
        "requested": bool(refresh),
        "performed": False,
        "error": "",
        "skipped_reason": "" if refresh_free_signals else "historical_or_outside_market_session",
    }
    if refresh_free_signals:
        try:
            original.free_intraday_signals._refresh_once_guarded()
            free_signal_refresh["performed"] = True
        except Exception as exc:  # pragma: no cover - provider dependent
            free_signal_refresh["error"] = f"{type(exc).__name__}: {exc}"
        # _realtime_abcd_payload normally asks the resident service to refresh
        # again after scoring.  This worker has already done so synchronously.
        original.free_intraday_signals.refresh_async = lambda: None
    else:
        # Historical imported snapshots must remain point-in-time stable.  A
        # weekend refresh of today's heat/LHB data against an older price date
        # would mutate the recommendation universe and break comparability.
        original.free_intraday_signals.refresh_async = lambda: None

    # This is the old 8010 full-market chip and ABCD path.  The first call may
    # queue the expensive chip reconstruction; keep it inside this background
    # worker until the original cache is publishable or the deadline is reached.
    weight_control = _weight_control()
    payload = original._realtime_abcd_payload(limit=8, refresh=True)
    deadline = time.monotonic() + max(0, wait_seconds)
    while not _chip_payload_is_publishable(payload) and time.monotonic() < deadline:
        time.sleep(2)
        payload = original._realtime_abcd_payload(limit=8, refresh=True)

    publishable_chip = _chip_payload_is_publishable(payload)
    if not publishable_chip:
        stale_meta = dict(payload.get("meta") or {})
        stale_meta["ready"] = False
        stale_meta["message"] = "当天尚无已完成且版本一致的盘中筹码模型分；本轮保留上一正式批次"
        payload = {**payload, "rows": [], "meta": stale_meta}

    source_rows = list(payload.get("rows") or [])
    if weight_control.get("mode") == "custom" and getattr(original, "_REALTIME_ABCD_SCORE_CACHE", None) is not None:
        try:
            import pandas as pd

            panel = original._REALTIME_ABCD_SCORE_CACHE.copy()
            snapshot = pd.DataFrame(original.realtime_market.market_snapshot())
            keep = [column for column in ("ts_code", "name", "industry", "close", "pct_chg", "amount") if column in snapshot.columns]
            panel = panel.merge(snapshot[keep].drop_duplicates("ts_code"), on="ts_code", how="left")
            weights = dict((weight_control.get("weights") or {}).get("ranking") or {})
            total = sum(max(0.0, float(weights.get(key, 0))) for key in ("a", "b", "c", "d"))
            if total > 0:
                panel["custom_abcd_score"] = sum(panel[f"{key}_score"].fillna(0) * max(0.0, float(weights.get(key, 0))) / total for key in ("a", "b", "c", "d"))
                leader = panel["leader_flag"].fillna("").ne("强势跟随")
                eligible = panel.loc[
                    panel["pct_chg"].fillna(0).gt(0)
                    & panel["d_available"].fillna(False).astype(bool)
                    & panel["d_score"].gt(float(original.D_MIN_SCORE))
                    & panel["a_score"].ge(float(original.A_MIN_SCORE))
                    & panel["b_score"].ge(float(original.B_MIN_SCORE))
                    & (leader | panel["c_score"].ge(float(original.C_MIN_SCORE)))
                ].copy()
                eligible = eligible.sort_values(["custom_abcd_score", "c_score", "b_score", "amount"], ascending=False, na_position="last")
                eligible["sector_pick_order"] = eligible.groupby("industry").cumcount() + 1
                selected = eligible.loc[eligible["sector_pick_order"] <= 2].head(8).copy()
                selected["rank"] = range(1, len(selected) + 1)
                selected["score"] = selected["custom_abcd_score"]
                selected["reason"] = selected.apply(lambda row: f"自定义权重：A板块{row['a_score']:.1f}、B量价热度{row['b_score']:.1f}、C龙头{row['c_score']:.1f}、D筹码{row['d_score']:.1f}", axis=1)
                selected["risk"] = "原版ABCD硬门槛保持不变；权重仅改变合格池排序"
                source_rows = selected.to_dict(orient="records")
        except Exception as exc:
            weight_control["warning"] = f"自定义权重重排失败，保留原版排序：{type(exc).__name__}: {exc}"
    rows = [_compact_row(row) for row in source_rows]
    meta = dict(payload.get("meta") or {})
    score_panel = _compact_score_panel(
        original,
        str(meta.get("data_trade_date") or original.realtime_market.status().get("data_trade_date") or ""),
        meta.get("factor_time"),
        meta,
    )
    if not publishable_chip:
        score_panel["items"] = []
        score_panel["row_count"] = 0
    score_panel_writeback = _writeback_score_panel_compat(score_panel)
    return {
        "ok": bool(rows),
        "status": "ready" if rows else "kept_previous",
        "task": "abcd_original_8010",
        "algorithm": "quant_mvp.app._realtime_abcd_payload",
        "source_policy": "shared_canonical_intraday_akshare_only; audited_one_time_8010_snapshot; no_tencent_fallback",
        "database": os.environ.get("QUANT_DB_PATH", ""),
        "refresh": {"requested": refresh, "performed": refreshed, "error": refresh_error},
        "free_signal_refresh": free_signal_refresh,
        "observation_seed": observation_seed,
        "imported_chip_cache": imported_chip_cache,
        "weight_config": weight_control,
        "items": rows,
        "score_panel": score_panel,
        "score_panel_writeback": score_panel_writeback,
        "meta": meta,
        "message": meta.get("message") or ("原版ABCD生成完成" if rows else "原版ABCD未产生新结果，保留上一发布版"),
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--warmup-only", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=420)
    args = parser.parse_args()
    print(json.dumps(warmup() if args.warmup_only else run(args.refresh, args.wait_seconds), ensure_ascii=False))
