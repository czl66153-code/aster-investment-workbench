"""Source scheduling and normalization contracts for the standalone AIA engine."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .evidence import score_sector_heat, score_stock_popularity


SOURCE_POLICY_VERSION = "aia.source-policy.v1"
VALID_SESSIONS = {"intraday", "night"}


def source_plan(session: str) -> dict[str, Any]:
    if session not in VALID_SESSIONS:
        raise ValueError("session must be intraday or night")
    if session == "intraday":
        return {
            "policy_version": SOURCE_POLICY_VERSION,
            "session": session,
            "authoritative": ["akshare"],
            "bar_sources": ["akshare"],
            "akshare_provider_subsources": ["eastmoney", "tonghuashun", "sina"],
            "heat_methods": [
                "stock_board_industry_summary_ths",
                "stock_board_industry_name_em",
                "stock_hot_rank_em",
            ],
            "freshness": "same_trade_day_intraday",
            "rule": "akshare_only; no_tencent_fallback; on_failure_keep_last_published_version",
            "failure_mode": "stale_last_published_only",
        }
    return {
        "policy_version": SOURCE_POLICY_VERSION,
        "session": session,
        "authoritative": ["bigquant", "tushare"],
        "reconciliation": ["akshare_close"],
        "purpose": ["next_session_precompute", "sector_heat_snapshot", "factor_snapshot"],
        "freshness": "completed_trade_day",
        "rule": "persist_provider_as_of_and_trade_date_before_merge",
    }


def _require_timestamp(value: Any, field: str) -> str:
    if not value:
        raise ValueError(f"{field} is required")
    text = str(value).replace("Z", "+00:00")
    try:
        datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{field} must be ISO-8601") from exc
    return str(value)


def validate_source_payload(payload: dict[str, Any], *, session: str, provider: str) -> dict[str, Any]:
    plan = source_plan(session)
    if provider not in plan["authoritative"] and provider not in plan.get("reconciliation", []):
        raise ValueError(f"provider {provider} is not allowed for {session}")
    trade_date = str(payload.get("trade_date") or "")
    if len(trade_date) != 10:
        raise ValueError("trade_date must be YYYY-MM-DD")
    as_of = _require_timestamp(payload.get("as_of"), "as_of")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("rows must be a list")
    return {
        "provider": provider,
        "session": session,
        "trade_date": trade_date,
        "as_of": as_of,
        "rows": rows,
    }


def normalize_heat_payloads(
    provider_payloads: dict[str, dict[str, Any]],
    *,
    session: str,
    kind: str,
) -> dict[str, Any]:
    """Merge already-fetched provider rows while retaining every provenance tag.

    This function does not call provider SDKs, read tokens, or silently mix
    different trade dates.  Schedulers may pass AkShare intraday results or
    BigQuant/Tushare nightly results through the same contract.
    """
    if kind not in {"sector_heat", "stock_popularity"}:
        raise ValueError("kind must be sector_heat or stock_popularity")
    validated = [
        validate_source_payload(payload, session=session, provider=provider)
        for provider, payload in provider_payloads.items()
    ]
    trade_dates = {item["trade_date"] for item in validated}
    if len(trade_dates) > 1:
        raise ValueError("cross_trade_date_merge_is_forbidden")
    merged: dict[str, dict[str, Any]] = {}
    for batch in validated:
        for index, row in enumerate(batch["rows"], start=1):
            identity = str(row.get("code") or row.get("symbol") or row.get("name") or "").strip()
            if not identity:
                continue
            bucket = merged.setdefault(identity, {"observations": []})
            bucket["observations"].append(
                {
                    "provider": batch["provider"],
                    "as_of": batch["as_of"],
                    "trade_date": batch["trade_date"],
                    "raw": {**row, "rank": row.get("rank") or index},
                }
            )
    results = []
    scorer = score_sector_heat if kind == "sector_heat" else score_stock_popularity
    for identity, item in merged.items():
        scored = []
        for observation in item["observations"]:
            result = scorer(observation["raw"])
            if result["score"] is not None:
                scored.append(result["score"])
        score = round(sum(scored) / len(scored), 6) if scored else None
        results.append(
            {
                "identity": identity,
                "score": score,
                "status": "available" if score is not None else "unavailable",
                "consensus_count": len(scored),
                "evidence": item["observations"],
            }
        )
    results.sort(key=lambda row: (row["score"] is not None, row["score"] or -1.0), reverse=True)
    return {
        "policy_version": SOURCE_POLICY_VERSION,
        "session": session,
        "kind": kind,
        "trade_date": next(iter(trade_dates), None),
        "providers": [item["provider"] for item in validated],
        "items": results,
    }


def resolve_refresh_failure(
    *,
    session: str,
    last_published: dict[str, Any] | None,
    error: str,
) -> dict[str, Any]:
    """Apply the fail-closed publication rule without changing old output."""
    source_plan(session)
    if last_published is None:
        return {
            "status": "blocked",
            "publishable": False,
            "reason": "refresh_failed_and_no_published_version",
            "error": error,
        }
    return {
        **last_published,
        "status": "stale",
        "publishable": True,
        "refresh_error": error,
        "refresh_policy": "keep_last_published_version",
        "source_policy_version": SOURCE_POLICY_VERSION,
    }
