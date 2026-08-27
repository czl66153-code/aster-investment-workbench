"""Evidence-aware AIA ranking and the exactly-ten publish gate."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .assets import load_asset_manifest, resolve_asset_path
from .evidence import rescore_leadership_evidence, score_catalyst


BLOCKED_RISK_STATES = {"blocked", "st", "suspended", "prohibited", "data_abnormal", "major_event"}


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _score(value: Any) -> float | None:
    if isinstance(value, dict):
        value = value.get("score")
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return _clamp(number) if math.isfinite(number) else None


def load_current_config(path: str | Path | None = None) -> dict[str, Any]:
    if path:
        config_path = Path(path).resolve()
    else:
        manifest = load_asset_manifest()
        manifest_path = Path(manifest["_manifest_path"])
        item = next(asset for asset in manifest["assets"] if asset["id"] == "ranking_config_versions")
        config_path = resolve_asset_path(item["path"], manifest_path)
    history = json.loads(config_path.read_text(encoding="utf-8"))
    version = history["current_version"]
    config = dict(history["versions"][version])
    config["config_path"] = str(config_path)
    return config


def _matched_patterns(candidate: dict[str, Any]) -> list[dict[str, Any]]:
    patterns = candidate.get("patterns") or []
    if isinstance(patterns, dict):
        patterns = [dict(value, module=key) if isinstance(value, dict) else {"module": key, "hit": bool(value)} for key, value in patterns.items()]
    return [
        pattern
        for pattern in patterns
        if isinstance(pattern, dict)
        and pattern.get("hit") is True
        and pattern.get("quality_status", pattern.get("quality", "pass")) != "blocked"
        and (_score(pattern.get("score")) or 0.0) >= float(pattern.get("threshold", 0.0))
    ]


def _risk_state(candidate: dict[str, Any]) -> str:
    risk = candidate.get("risk")
    if isinstance(risk, dict):
        return str(risk.get("status") or "ok").lower()
    return str(risk or "ok").lower()


def _risk_penalty(candidate: dict[str, Any]) -> float:
    risk = candidate.get("risk")
    return _score(risk.get("penalty")) or 0.0 if isinstance(risk, dict) else 0.0


def _prepare_factors(candidate: dict[str, Any]) -> dict[str, Any]:
    factors = dict(candidate.get("factors") or {})
    leadership = factors.get("leadership_status")
    if isinstance(leadership, dict) and leadership.get("evidence"):
        rescored = rescore_leadership_evidence(leadership["evidence"])
        rescored["source"] = "aia_original_leadership_rescore"
        factors["leadership_status"] = rescored
    catalyst = candidate.get("catalyst")
    if catalyst and "catalyst_logic" not in factors:
        factors["catalyst_logic"] = score_catalyst(
            catalyst.get("announcements", []),
            cutoff=catalyst["cutoff"],
            query_complete=bool(catalyst.get("query_complete", True)),
            momentum=float(catalyst.get("momentum", 50.0)),
        )
    return factors


def score_candidate(candidate: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    symbol = str(candidate.get("symbol") or candidate.get("code") or "").strip()
    if not symbol:
        return {"eligible": False, "reason": "missing_symbol"}
    risk_state = _risk_state(candidate)
    if risk_state in BLOCKED_RISK_STATES:
        return {"eligible": False, "symbol": symbol, "reason": f"risk:{risk_state}"}
    patterns = _matched_patterns(candidate)
    if not patterns:
        return {"eligible": False, "symbol": symbol, "reason": "pattern_hit_required"}
    factors = _prepare_factors(candidate)
    normalized_weights = config.get("normalized_weights") or {}
    positive_weights = {key: float(weight) for key, weight in normalized_weights.items() if float(weight) > 0}
    weight_total = sum(positive_weights.values())
    weighted_score = 0.0
    covered_weight = 0.0
    factor_audit: dict[str, Any] = {}
    for key, weight in positive_weights.items():
        payload = factors.get(key)
        value = _score(payload)
        if value is None:
            reason = payload.get("unavailable_reason") or payload.get("reason") if isinstance(payload, dict) else "factor_evidence_missing"
            factor_audit[key] = {"score": None, "weight": weight, "status": "unavailable", "reason": reason}
            continue
        weighted_score += value * weight / 100.0
        covered_weight += weight
        factor_audit[key] = {
            "score": round(value, 6),
            "weight": weight,
            "status": "available",
            "source": payload.get("source") if isinstance(payload, dict) else None,
            "as_of": payload.get("as_of") if isinstance(payload, dict) else None,
        }
    coverage = covered_weight / 100.0 if weight_total > 0 else 0.0
    if coverage < float(config.get("minimum_evidence_coverage", 0.7)):
        return {
            "eligible": False,
            "symbol": symbol,
            "reason": "insufficient_evidence_coverage",
            "evidence_coverage": round(coverage, 6),
            "factor_audit": factor_audit,
        }
    hit_count = len(patterns)
    bonus = float(config.get("three_hit_bonus", 5.0)) if hit_count >= 3 else float(config.get("two_hit_bonus", 3.0)) if hit_count >= 2 else 0.0
    risk_penalty = _risk_penalty(candidate)
    final_score = _clamp(weighted_score + bonus - risk_penalty)
    return {
        "eligible": True,
        "symbol": symbol,
        "name": candidate.get("name") or symbol,
        "score": round(final_score, 6),
        "weighted_score": round(weighted_score, 6),
        "pattern_bonus": bonus,
        "risk_penalty": risk_penalty,
        "pattern_hits": [pattern.get("module") or pattern.get("pattern") or "unknown" for pattern in patterns],
        "evidence_coverage": round(coverage, 6),
        "factor_audit": factor_audit,
        "risk": risk_state,
        "provenance": candidate.get("provenance") or {},
    }


def rank_top10(candidates: list[dict[str, Any]], config: dict[str, Any] | None = None) -> dict[str, Any]:
    active_config = config or load_current_config()
    accepted = []
    rejected = []
    for candidate in candidates:
        result = score_candidate(candidate, active_config)
        if result.get("eligible"):
            accepted.append(result)
        else:
            rejected.append(result)
    accepted.sort(key=lambda item: (item["score"], item["evidence_coverage"], item["symbol"]), reverse=True)
    if len(accepted) < 10:
        return {
            "status": "blocked",
            "publishable": False,
            "reason": "exactly_ten_qualified_required",
            "qualified_count": len(accepted),
            "required_count": 10,
            "items": [],
            "qualified_preview": accepted,
            "rejected": rejected,
            "config_version": active_config["config_version"],
        }
    items = []
    for rank, item in enumerate(accepted[:10], start=1):
        items.append({**item, "rank": rank})
    return {
        "status": "ready",
        "publishable": True,
        "qualified_count": len(accepted),
        "required_count": 10,
        "items": items,
        "overflow_count": max(0, len(accepted) - 10),
        "rejected": rejected,
        "config_version": active_config["config_version"],
    }
