"""Read Aster SQLite data and produce an audited AIA Top10 JSON envelope."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sqlite3
import sys
import zoneinfo
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import quote
from uuid import uuid4

from .m30 import evaluate_m30, load_template_profile
from .ranking import load_current_config, rank_top10, score_candidate


SCHEMA_VERSION = "aster.aia.top10.cli.v1"
SHANGHAI = timezone(timedelta(hours=8))
PROJECT_ROOT = Path(__file__).resolve().parents[3]
VENDOR_DAILY_SHAPES = PROJECT_ROOT / "python_engine" / "vendor_exact" / "signal_desk" / "aia" / "patterns" / "daily_shapes.py"
REQUIRED_TABLES = {"factor_snapshot", "bars_daily", "bars_30m", "securities", "dataset_versions"}
NIGHTLY_DAILY_SOURCE_PREFIXES = ("bigquant", "tushare")
INTRADAY_M30_SOURCE_PREFIXES = ("akshare",)
MOMENTUM_THRESHOLDS = {3: 5.0, 5: 8.0, 10: 12.0, 20: 18.0}
AIA_HEAVY_SCAN_LIMIT = 220


def _json_default(value: Any) -> Any:
    if isinstance(value, (date, datetime, Path)):
        return str(value)
    raise TypeError(type(value).__name__)


def _as_json(payload: dict[str, Any], *, indent: int | None = None) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=False, indent=indent, default=_json_default)


def _connect(path: Path, *, writable: bool) -> sqlite3.Connection:
    mode = "rw" if writable else "ro"
    uri = f"file:{quote(path.resolve().as_posix(), safe='/:')}?mode={mode}"
    connection = sqlite3.connect(uri, uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    if not writable:
        connection.execute("PRAGMA query_only=ON")
    return connection


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _active_ranking_config(connection: sqlite3.Connection) -> tuple[dict[str, Any], dict[str, Any]]:
    """Overlay the durable local AIA controls without changing original defaults."""
    config = load_current_config()
    control = {"mode": "original", "revision": 1, "weights": {"ranking": dict(config.get("normalized_weights") or {}), "bonuses": {"two_hit_bonus": config.get("two_hit_bonus", 3), "three_hit_bonus": config.get("three_hit_bonus", 5)}}}
    if "model_weight_configs" not in _tables(connection):
        return config, control
    row = connection.execute("SELECT mode,weights_json,revision,updated_at FROM model_weight_configs WHERE model_key='aia'").fetchone()
    if not row:
        return config, control
    try:
        weights = json.loads(str(row["weights_json"]))
    except (TypeError, ValueError, json.JSONDecodeError):
        return config, control
    control = {"mode": str(row["mode"]), "revision": int(row["revision"]), "weights": weights, "updated_at": row["updated_at"]}
    if str(row["mode"]) != "custom":
        return config, control
    ranking = {key: max(0.0, float(value)) for key, value in dict(weights.get("ranking") or {}).items() if key in {"sector_heat", "stock_popularity", "leadership_status", "technical_pattern"}}
    total = sum(ranking.values())
    if total <= 0:
        return config, {**control, "warning": "custom ranking total is zero; original config retained"}
    config["normalized_weights"] = {key: value * 100.0 / total for key, value in ranking.items()}
    bonuses = dict(weights.get("bonuses") or {})
    config["two_hit_bonus"] = max(0.0, float(bonuses.get("two_hit_bonus", config.get("two_hit_bonus", 3))))
    config["three_hit_bonus"] = max(0.0, float(bonuses.get("three_hit_bonus", config.get("three_hit_bonus", 5))))
    config["config_version"] = f"aia.local.custom.r{int(row['revision'])}"
    config["preset"] = "local_custom"
    return config, control


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and result not in (float("inf"), float("-inf")) else None


def _parse_datetime(value: Any) -> datetime:
    text = str(value or "").strip()
    if len(text) == 14 and text.isdigit():
        parsed = datetime.strptime(text, "%Y%m%d%H%M%S")
    else:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=SHANGHAI) if parsed.tzinfo is None else parsed.astimezone(SHANGHAI)


def _parse_sqlite_utc(value: Any) -> datetime:
    """Parse SQLite CURRENT_TIMESTAMP values, which are UTC but timezone-naive."""
    text = str(value or "").strip()
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(SHANGHAI)


def _iso_m30_time(value: Any) -> str:
    return _parse_datetime(value).isoformat()


@lru_cache(maxsize=1)
def _daily_shape_evaluator() -> Callable[..., dict[str, Any]]:
    if not VENDOR_DAILY_SHAPES.is_file():
        raise RuntimeError(f"vendor daily_shapes missing: {VENDOR_DAILY_SHAPES}")
    spec = importlib.util.spec_from_file_location("aster_vendor_daily_shapes", VENDOR_DAILY_SHAPES)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load vendor daily_shapes")
    module = importlib.util.module_from_spec(spec)
    original_zoneinfo = zoneinfo.ZoneInfo
    try:
        try:
            original_zoneinfo("Asia/Shanghai")
        except zoneinfo.ZoneInfoNotFoundError:
            # Windows' base Python can omit the IANA tzdata package. Shanghai
            # has no DST in the covered market period, so UTC+8 is exact here.
            zoneinfo.ZoneInfo = lambda key: SHANGHAI if key == "Asia/Shanghai" else original_zoneinfo(key)  # type: ignore[misc]
        spec.loader.exec_module(module)
    finally:
        zoneinfo.ZoneInfo = original_zoneinfo  # type: ignore[misc]
    return module.evaluate_daily_shapes


def _latest_factor_date(connection: sqlite3.Connection) -> str | None:
    row = connection.execute(
        """
        SELECT MAX(f.trade_date)
        FROM factor_snapshot f
        JOIN dataset_versions v
          ON v.dataset_key='factor_snapshot'
         AND v.trade_date=f.trade_date
         AND v.status='published'
        """
    ).fetchone()
    return str(row[0]) if row and row[0] else None


def _factor_version(connection: sqlite3.Connection, trade_date: str) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT * FROM dataset_versions
        WHERE dataset_key='factor_snapshot' AND trade_date=? AND status='published'
        ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1
        """,
        (trade_date,),
    ).fetchone()
    return dict(row) if row else None


def _load_factors(connection: sqlite3.Connection, trade_date: str) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute("SELECT * FROM factor_snapshot WHERE trade_date=? ORDER BY code", (trade_date,))]


def _signal_at(rows: list[dict[str, Any]], override: str | None) -> datetime:
    if override:
        return _parse_datetime(override)
    latest = max((str(row.get("updated_at") or "") for row in rows), default="")
    return _parse_sqlite_utc(latest) if latest else datetime.now(SHANGHAI)


def _completed_daily_cutoff(trade_date: str, signal_at: datetime) -> str:
    target = date.fromisoformat(trade_date)
    if signal_at.date() < target or (signal_at.date() == target and signal_at.timetz().replace(tzinfo=None) < time(15, 0)):
        return (target - timedelta(days=1)).isoformat()
    return target.isoformat()


def _load_daily_bars(connection: sqlite3.Connection, codes: list[str], cutoff: str) -> tuple[dict[str, list[dict[str, Any]]], set[str], str | None]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if not codes:
        return grouped, set(), None
    placeholders = ",".join("?" for _ in codes)
    query = f"SELECT * FROM bars_daily WHERE trade_date<=? AND code IN ({placeholders}) ORDER BY code, trade_date"
    sources: set[str] = set()
    latest = None
    for raw in connection.execute(query, (cutoff, *codes)):
        row = dict(raw)
        grouped[row["code"]].append(row)
        sources.add(str(row.get("source") or "unknown"))
        latest = max(latest or str(row["trade_date"]), str(row["trade_date"]))
    return grouped, sources, latest


def _load_m30_bars(connection: sqlite3.Connection, codes: list[str], signal_at: datetime) -> tuple[dict[str, list[dict[str, Any]]], set[str], str | None]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if not codes:
        return grouped, set(), None
    placeholders = ",".join("?" for _ in codes)
    query = f"SELECT * FROM bars_30m WHERE code IN ({placeholders}) ORDER BY code, trade_time"
    sources: set[str] = set()
    latest = None
    for raw in connection.execute(query, codes):
        row = dict(raw)
        try:
            parsed = _parse_datetime(row["trade_time"])
        except (TypeError, ValueError):
            continue
        if parsed > signal_at:
            continue
        row["trade_time"] = parsed.isoformat()
        grouped[row["code"]].append(row)
        sources.add(str(row.get("source") or "unknown"))
        latest = max(latest or row["trade_time"], row["trade_time"])
    return grouped, sources, latest


def _load_chip_overrides(connection: sqlite3.Connection, trade_date: str) -> tuple[dict[str, dict[str, Any]], str | None]:
    chip_date_row = connection.execute("SELECT MAX(trade_date) FROM chip_model_rank_daily WHERE trade_date<=?", (trade_date,)).fetchone()
    chip_date = str(chip_date_row[0]) if chip_date_row and chip_date_row[0] else None
    if not chip_date:
        return {}, None
    return {
        str(row["code"]): dict(row)
        for row in connection.execute("SELECT * FROM chip_model_rank_daily WHERE trade_date=?", (chip_date,))
    }, chip_date


def _accepted_sources(sources: Iterable[str], prefixes: tuple[str, ...]) -> bool:
    values = [str(source).strip().lower() for source in sources]
    return bool(values) and all(any(value.startswith(prefix) for prefix in prefixes) for value in values)


def _coverage(rows: list[dict[str, Any]], keys: Iterable[str]) -> dict[str, float]:
    total = max(1, len(rows))
    return {key: sum(_number(row.get(key)) is not None for row in rows) / total for key in keys}


def _gate(key: str, passed: bool, *, actual: Any, required: Any, reason: str) -> dict[str, Any]:
    return {"key": key, "pass": bool(passed), "actual": actual, "required": required, "reason": None if passed else reason}


def _risk(row: dict[str, Any]) -> dict[str, Any]:
    reasons = []
    name = str(row.get("name") or "")
    if name.upper().startswith("ST") or "*ST" in name.upper():
        reasons.append("st_security")
    if (_number(row.get("close")) or 0) <= 0:
        reasons.append("invalid_close")
    if _number(row.get("amount")) is None or float(row.get("amount") or 0) < 0:
        reasons.append("invalid_amount")
    return {"status": "data_abnormal" if reasons else "ok", "penalty": 0.0, "reasons": reasons}


def _funnel_scan_rows(
    rows: list[dict[str, Any]],
    daily_bars: dict[str, list[dict[str, Any]]],
    *,
    limit: int = AIA_HEAVY_SCAN_LIMIT,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Reproduce the E-drive AIA cheap/momentum/pre-heavy funnel locally.

    The source funnel requires at least two of 3/5/10/20-day momentum gates,
    RMB 50m liquidity for the ordinary channel, then caps heavy pattern work at
    220 securities.  Listing-age data is not present in the independent
    warehouse, so the conservative ordinary-channel floor is used for all
    securities instead of silently granting a lower new-stock floor.
    """
    admitted: list[dict[str, Any]] = []
    rejected = Counter()
    for row in rows:
        code = str(row["code"])
        amount = _number(row.get("amount"))
        if amount is None or amount < 50_000_000:
            rejected["liquidity_below_ordinary_floor"] += 1
            continue
        bars = daily_bars.get(code, [])
        if len(bars) < 21:
            rejected["momentum_history_insufficient"] += 1
            continue
        closes = [_number(item.get("close")) for item in bars[-21:]]
        if any(value is None or value <= 0 for value in closes):
            rejected["momentum_history_invalid"] += 1
            continue
        latest = float(closes[-1])
        returns = {
            days: (latest / float(closes[-days - 1]) - 1.0) * 100.0
            for days in MOMENTUM_THRESHOLDS
        }
        hits = [days for days, threshold in MOMENTUM_THRESHOLDS.items() if returns[days] >= threshold]
        if len(hits) < 2:
            rejected["multi_horizon_momentum_failed"] += 1
            continue
        excess_values = [max(0.0, returns[days] - MOMENTUM_THRESHOLDS[days]) for days in MOMENTUM_THRESHOLDS]
        excess = min(100.0, sum(excess_values) / len(excess_values) * 5.0)
        turnover = min(100.0, max(0.0, float(_number(row.get("turnover_rate")) or 0.0) * 10.0))
        last_bar = bars[-1]
        high = _number(last_bar.get("high"))
        low = _number(last_bar.get("low"))
        close_position = 50.0 if high is None or low is None or high <= low else max(0.0, min(100.0, (latest - low) / (high - low) * 100.0))
        pre_score = excess * 0.50 + 100.0 * 0.20 + turnover * 0.10 + close_position * 0.10 + 100.0 * 0.10
        enriched = dict(row)
        enriched["_aia_funnel"] = {
            "returns": {f"{days}d": round(value, 6) for days, value in returns.items()},
            "hits": [f"{days}d" for days in hits],
            "pre_score": round(pre_score, 6),
            "liquidity_floor": 50_000_000,
        }
        admitted.append(enriched)
    admitted.sort(key=lambda item: (-float(item["_aia_funnel"]["pre_score"]), str(item["code"])))
    selected = admitted[: max(1, int(limit))]
    return selected, {
        "rule": "E-drive AIA funnel: liquidity>=RMB50m; at least 2 momentum hits; pre-heavy limit=220",
        "thresholds": {f"{days}d": threshold for days, threshold in MOMENTUM_THRESHOLDS.items()},
        "minimum_hits": 2,
        "eligible_before_limit": len(admitted),
        "selected": len(selected),
        "limit": limit,
        "rejections": dict(sorted(rejected.items())),
        "listing_age_policy": "conservative_ordinary_floor_when_listing_age_missing",
    }


def _dual_model_pattern(row: dict[str, Any], chip_override: dict[str, Any] | None) -> dict[str, Any]:
    """Map the retained formal/candidate chip models to AIA's chip module.

    The integrated site intentionally retains only these two chip models.  A
    mean score of 68 preserves the original chip-module threshold while
    avoiding a second, divergent chip topology implementation.
    """
    formal = _number((chip_override or {}).get("formal_score"))
    candidate = _number((chip_override or {}).get("candidate_score"))
    if formal is None:
        formal = _number(row.get("formal_model_score"))
    if candidate is None:
        candidate = _number(row.get("candidate_model_score"))
    available = [value for value in (formal, candidate) if value is not None]
    score = sum(available) / len(available) / 100.0 if len(available) == 2 else None
    return {
        "module": "chip",
        "score": score,
        "threshold": 0.68,
        "hit": score is not None and score >= 0.68,
        "quality_status": "pass" if score is not None else "blocked",
        "formal_score": formal,
        "candidate_score": candidate,
        "source": "retained_dual_chip_models",
    }


def _factor_payload(score: Any, source: str, as_of: str) -> dict[str, Any]:
    value = _number(score)
    if value is None:
        return {"score": None, "unavailable_reason": "factor_evidence_missing"}
    return {"score": max(0.0, min(100.0, value)), "source": source, "as_of": as_of}


def _candidate(
    row: dict[str, Any],
    *,
    daily: dict[str, Any],
    m30: dict[str, Any],
    daily_sources: set[str],
    m30_sources: set[str],
    chip_override: dict[str, Any] | None,
    as_of: str,
) -> dict[str, Any]:
    formal_score = _number((chip_override or {}).get("formal_score"))
    candidate_score = _number((chip_override or {}).get("candidate_score"))
    if formal_score is None:
        formal_score = _number(row.get("formal_model_score"))
    if candidate_score is None:
        candidate_score = _number(row.get("candidate_model_score"))
    daily_score = _number(daily.get("score"))
    m30_score = _number(m30.get("base_score"))
    chip_pattern = _dual_model_pattern(row, chip_override)
    patterns = {
        "daily": {
            "module": "daily",
            "score": daily_score,
            "threshold": float(daily.get("threshold") or 0.70),
            "hit": bool(daily.get("hit")),
            "quality_status": daily.get("quality_status") or daily.get("rule_status") or "blocked",
        },
        "m30": {
            "module": "m30",
            "score": m30_score,
            "threshold": float(m30.get("threshold") or 0.72),
            "hit": bool(m30.get("core_hit")),
            "quality_status": "blocked" if m30.get("rule_status") in {"blocked", "partial"} else "pass",
        },
        "chip": chip_pattern,
    }
    return {
        "symbol": row["code"],
        "name": row.get("name") or row["code"],
        "risk": _risk(row),
        "patterns": patterns,
        "factors": {
            "leadership_status": _factor_payload(row.get("aia_leadership"), "aster.factor_snapshot.aia_leadership", as_of),
            "sector_heat": _factor_payload(row.get("aia_sector_heat"), "aster.factor_snapshot.aia_sector_heat", as_of),
            "stock_popularity": _factor_payload(row.get("aia_stock_heat"), "aster.factor_snapshot.aia_stock_heat", as_of),
            "technical_pattern": _factor_payload(row.get("aia_technical_pattern"), "aster.factor_snapshot.aia_technical_pattern", as_of),
        },
        "provenance": {
            "candidate_source": "aster.factor_snapshot",
            "factor_trade_date": row["trade_date"],
            "daily_sources": sorted(daily_sources),
            "m30_sources": sorted(m30_sources),
            "daily_pattern": {"hit": bool(daily.get("hit")), "score": daily_score, "pattern_code": daily.get("pattern_code"), "last_complete_bar_time": daily.get("last_complete_bar_time")},
            "m30_pattern": {"hit": bool(m30.get("core_hit")), "core_score": m30_score, "adjusted_score": m30.get("score"), "as_of": m30.get("signal_bar_time")},
            "dual_chip_scores": {
                "formal": formal_score,
                "candidate": candidate_score,
                "source": (chip_override or {}).get("source") or "aster.factor_snapshot",
                "model_versions": {
                    "formal": (chip_override or {}).get("formal_model_version"),
                    "candidate": (chip_override or {}).get("candidate_model_version"),
                },
            },
            "funnel": row.get("_aia_funnel") or {},
        },
    }


def _summarize_rejections(rejections: list[dict[str, Any]], limit: int = 20) -> dict[str, Any]:
    counts = Counter(str(item.get("reason") or "unknown") for item in rejections)
    return {"count": len(rejections), "by_reason": dict(sorted(counts.items())), "examples": rejections[:limit]}


def _write_staging(connection: sqlite3.Connection, envelope: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    trade_date = envelope["trade_date"]
    batch_id = f"aia-aster-{trade_date}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid4().hex[:6]}"
    items = envelope["top10"]
    encoded = json.dumps(items, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    checksum = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    with connection:
        connection.execute(
            """
            INSERT INTO recommendation_batches(batch_id,model_key,trade_date,status,trigger_type,source_mode,item_count,model_version,message,started_at,finished_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            """,
            (batch_id, "aia_aster", trade_date, "staging", "cli_staging", "independent_python_engine", len(items), envelope["ranking"]["config_version"], "AIA Aster staging only; published version unchanged", now, now),
        )
        for item in items:
            connection.execute(
                """
                INSERT INTO recommendations(batch_id,model_key,trade_date,code,rank,score,reason,risk,confidence,payload_json,generated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (batch_id, "aia_aster", trade_date, item["symbol"], item["rank"], item["score"], "+".join(item.get("pattern_hits") or []), item.get("risk"), item.get("evidence_coverage"), json.dumps(item, ensure_ascii=False, separators=(",", ":")), now),
            )
        connection.execute(
            """
            INSERT INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at)
            VALUES(?,?,?,?,?,?,?,?,?,NULL)
            """,
            ("recommendation_aia_aster_staging", batch_id, trade_date, len(items), checksum, "staging", "independent_python_engine", 100.0, now),
        )
    return {"written": True, "batch_id": batch_id, "status": "staging", "published_replaced": False, "checksum": checksum}


def build_top10_envelope(
    db_path: Path,
    *,
    trade_date: str | None = None,
    signal_time: str | None = None,
    minimum_candidates: int = 400,
    minimum_score: float = 60.0,
    staging: bool = False,
) -> dict[str, Any]:
    if not db_path.is_file():
        raise FileNotFoundError(str(db_path))
    connection = _connect(db_path, writable=staging)
    try:
        tables = _tables(connection)
        missing_tables = sorted(REQUIRED_TABLES - tables)
        if missing_tables:
            return {"schema_version": SCHEMA_VERSION, "status": "blocked", "publishable": False, "mode": "staging" if staging else "read_only", "db": str(db_path.resolve()), "gates": [_gate("required_tables", False, actual=sorted(tables), required=sorted(REQUIRED_TABLES), reason=f"missing tables: {', '.join(missing_tables)}")], "top10": [], "rejections": {"count": 0, "by_reason": {}, "examples": []}}

        target_date = trade_date or _latest_factor_date(connection)
        if not target_date:
            raise RuntimeError("no published factor_snapshot trade date")
        date.fromisoformat(target_date)
        factors = _load_factors(connection, target_date)
        factor_version = _factor_version(connection, target_date)
        signal_at = _signal_at(factors, signal_time)
        daily_cutoff = _completed_daily_cutoff(target_date, signal_at)
        codes = [str(row["code"]) for row in factors]
        daily_bars, daily_sources, daily_source_date = _load_daily_bars(connection, codes, daily_cutoff)
        m30_bars, m30_sources, m30_source_time = _load_m30_bars(connection, codes, signal_at)
        history80 = sum(len(daily_bars.get(code, [])) >= 80 for code in codes)
        history310 = sum(len(daily_bars.get(code, [])) >= 310 for code in codes)
        history80_coverage = history80 / max(1, len(codes))
        history310_coverage = history310 / max(1, len(codes))
        chip_overrides, chip_date = _load_chip_overrides(connection, target_date)
        factor_coverage = _coverage(factors, ("aia_sector_heat", "aia_stock_heat", "aia_leadership", "aia_technical_pattern", "formal_model_score", "candidate_model_score"))
        profile = load_template_profile()
        evaluate_daily = _daily_shape_evaluator()
        scan_factors, funnel_audit = _funnel_scan_rows(factors, daily_bars)
        candidates = []
        initial_rejections = []
        daily_hit_count = 0
        m30_hit_count = 0
        chip_hit_count = 0
        for row in scan_factors:
            code = str(row["code"])
            daily_rows = daily_bars.get(code, [])[-320:]
            daily_result = evaluate_daily(daily_rows, signal_time=signal_at)
            m30_rows = m30_bars.get(code, [])[-120:]
            m30_result = evaluate_m30(m30_rows, template_profile=profile) if m30_rows else {"rule_status": "partial", "threshold": 0.72, "score": None, "base_score": None, "core_hit": False, "hit": False, "rejection_reasons": ["insufficient_history"]}
            daily_hit_count += int(bool(daily_result.get("hit")))
            m30_hit_count += int(bool(m30_result.get("core_hit")))
            candidate = _candidate(row, daily=daily_result, m30=m30_result, daily_sources={str(item.get("source") or "unknown") for item in daily_rows}, m30_sources={str(item.get("source") or "unknown") for item in m30_rows}, chip_override=chip_overrides.get(code), as_of=signal_at.isoformat())
            chip_hit_count += int(bool(candidate["patterns"]["chip"].get("hit")))
            candidates.append(candidate)

        config, weight_control = _active_ranking_config(connection)
        score_qualified = []
        for candidate in candidates:
            scored = score_candidate(candidate, config)
            if not scored.get("eligible"):
                initial_rejections.append(scored)
            elif float(scored["score"]) < minimum_score:
                initial_rejections.append({"symbol": scored["symbol"], "reason": "below_minimum_score", "score": scored["score"], "minimum_score": minimum_score})
            else:
                score_qualified.append(candidate)
        ranking = rank_top10(score_qualified, config)
        all_rejections = initial_rejections + list(ranking.get("rejected") or [])

        published_rows_match = bool(factor_version and int(factor_version.get("row_count") or 0) == len(factors))
        coverage_key_by_weight = {"sector_heat": "aia_sector_heat", "stock_popularity": "aia_stock_heat", "leadership_status": "aia_leadership", "technical_pattern": "aia_technical_pattern"}
        active_coverage_keys = [coverage_key_by_weight[key] for key, value in (config.get("normalized_weights") or {}).items() if key in coverage_key_by_weight and float(value) > 0]
        factor_weight_min = min((factor_coverage[key] for key in active_coverage_keys), default=0.0)
        chip_coverage_min = min((factor_coverage["formal_model_score"], factor_coverage["candidate_model_score"]), default=0.0)
        gates = [
            _gate("published_factor_version", bool(factor_version and published_rows_match), actual=factor_version, required={"status": "published", "trade_date": target_date, "row_count": len(factors)}, reason="factor snapshot is not the matching published version"),
            _gate("candidate_universe_size", len(factors) >= minimum_candidates, actual=len(factors), required=f">={minimum_candidates}", reason="candidate universe below formal minimum"),
            _gate("ranking_factor_coverage", factor_weight_min >= 0.90, actual=round(factor_weight_min, 6), required=">=0.90", reason="weighted AIA factor coverage below 90%"),
            _gate("dual_chip_score_coverage", chip_coverage_min >= 0.90, actual=round(chip_coverage_min, 6), required=">=0.90", reason="formal/candidate chip score coverage below 90%"),
            _gate("daily_shape_history_coverage", history80_coverage >= 0.95, actual={"history80": history80, "history310": history310, "universe": len(codes), "coverage80": round(history80_coverage, 6), "coverage310": round(history310_coverage, 6)}, required="80-bar coverage>=0.95", reason="too few securities have enough official daily history for AIA shapes"),
            _gate("daily_formal_source_date", daily_source_date is not None and daily_source_date <= daily_cutoff, actual={"source_date": daily_source_date, "cutoff": daily_cutoff}, required="source_date<=completed_daily_cutoff", reason="daily source date is missing or ahead of point-in-time cutoff"),
            _gate("daily_source_policy", _accepted_sources(daily_sources, NIGHTLY_DAILY_SOURCE_PREFIXES), actual=sorted(daily_sources), required=list(NIGHTLY_DAILY_SOURCE_PREFIXES), reason="daily bars must come from nightly BigQuant/Tushare formal sources"),
            _gate("m30_source_policy", _accepted_sources(m30_sources, INTRADAY_M30_SOURCE_PREFIXES), actual=sorted(m30_sources), required=["akshare only; no Tencent fallback"], reason="M30 bars must come from AkShare and preserve prior publication on failure"),
            _gate("minimum_score_pool", len(score_qualified) >= 10, actual={"qualified": len(score_qualified), "minimum_score": minimum_score}, required=">=10", reason="fewer than 10 pattern-hit candidates passed the score gate"),
            _gate("exact_ten", ranking.get("publishable") is True and len(ranking.get("items") or []) == 10, actual=len(ranking.get("items") or []), required=10, reason="ranking did not produce exactly ten qualified securities"),
        ]
        publishable = all(item["pass"] for item in gates)
        envelope = {
            "schema_version": SCHEMA_VERSION,
            "status": "ready_read_only" if publishable and not staging else "ready_to_stage" if publishable else "blocked",
            "publishable": publishable,
            "mode": "staging" if staging else "read_only",
            "db": str(db_path.resolve()),
            "trade_date": target_date,
            "signal_time": signal_at.isoformat(),
            "source_policy": {"daily": "BigQuant/Tushare nightly", "m30": "AkShare only", "on_intraday_failure": "keep_last_published; no Tencent fallback"},
            "sources": {
                "factor_snapshot": {"rows": len(factors), "version": factor_version, "coverage": {key: round(value, 6) for key, value in factor_coverage.items()}},
                "bars_daily": {"completed_cutoff": daily_cutoff, "source_date": daily_source_date, "codes": len(daily_bars), "rows": sum(len(value) for value in daily_bars.values()), "sources": sorted(daily_sources), "history80": history80, "history310": history310, "coverage80": round(history80_coverage, 6), "coverage310": round(history310_coverage, 6)},
                "bars_30m": {"source_time": m30_source_time, "codes": len(m30_bars), "rows": sum(len(value) for value in m30_bars.values()), "sources": sorted(m30_sources)},
                "dual_chip": {"override_trade_date": chip_date, "override_rows": len(chip_overrides), "fallback": "factor_snapshot formal_model_score + candidate_model_score" if not chip_overrides else None},
                "funnel": funnel_audit,
                "daily_shapes": {"implementation": str(VENDOR_DAILY_SHAPES), "mode": "vendor_exact_read_only_import"},
            },
            "gates": gates,
            "candidate_summary": {"universe": len(factors), "pattern_scanned": len(scan_factors), "daily_hits": daily_hit_count, "m30_hits": m30_hit_count, "chip_hits": chip_hit_count, "score_qualified": len(score_qualified), "minimum_score": minimum_score},
            "ranking": {key: value for key, value in ranking.items() if key not in {"items", "rejected", "qualified_preview"}},
            "weight_config": weight_control,
            "top10": ranking.get("items") if ranking.get("publishable") is True else [],
            "ranking_preview": [] if ranking.get("publishable") is True else ranking.get("qualified_preview", [])[:10],
            "top10_release_status": "eligible" if publishable else "preview_only_blocked_by_gates",
            "rejections": _summarize_rejections(all_rejections),
            "staging": {"requested": staging, "written": False, "published_replaced": False},
        }
        if staging and publishable:
            envelope["staging"] = {"requested": True, **_write_staging(connection, envelope)}
            envelope["status"] = "staged"
        return envelope
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aster-top10", description="Run the independent AIA Top10 task against Aster SQLite")
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--trade-date", help="YYYY-MM-DD; defaults to the latest published factor snapshot")
    parser.add_argument("--signal-time", help="point-in-time ISO timestamp; defaults to factor_snapshot.updated_at")
    parser.add_argument("--minimum-candidates", type=int, default=400)
    parser.add_argument("--minimum-score", type=float, default=60.0)
    parser.add_argument("--staging", action="store_true", help="write a separate staging batch; never supersedes published data")
    parser.add_argument("--indent", type=int, choices=[2, 4], help="pretty-print JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build_top10_envelope(args.db, trade_date=args.trade_date, signal_time=args.signal_time, minimum_candidates=args.minimum_candidates, minimum_score=args.minimum_score, staging=args.staging)
        sys.stdout.write(_as_json(result, indent=args.indent) + "\n")
        return 0
    except Exception as error:
        sys.stdout.write(_as_json({"schema_version": SCHEMA_VERSION, "status": "error", "publishable": False, "error": {"type": type(error).__name__, "message": str(error)}}) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
