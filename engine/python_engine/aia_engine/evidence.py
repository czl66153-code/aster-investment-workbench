"""Original AIA catalyst, leadership and heat scoring primitives."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any


POSITIVE_EVENTS = {
    "重大订单": ("重大订单", "中标", "合同"),
    "业绩增长": ("预增", "扭亏", "业绩快报"),
    "并购重组": ("并购", "重组", "资产注入"),
    "政策与许可": ("获批", "取得许可", "政策支持"),
    "产品与合作": ("战略合作", "新产品", "技术突破", "涨价"),
    "回购增持": ("回购", "增持"),
}
NEGATIVE_TERMS = ("风险提示", "减持", "问询", "处罚", "立案调查", "终止")


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        result = datetime.fromisoformat(text)
    except ValueError:
        try:
            result = datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError:
            return None
    return result if result.tzinfo else result.replace(tzinfo=timezone.utc)


def score_catalyst(
    announcements: list[dict[str, Any]],
    *,
    cutoff: str | datetime,
    query_complete: bool = True,
    momentum: float = 50.0,
) -> dict[str, Any]:
    """Score public-announcement catalysts using the AIA keyword/recency rule."""
    cutoff_at = _datetime(cutoff)
    if cutoff_at is None:
        raise ValueError("cutoff must be an ISO timestamp")
    if not query_complete:
        return {
            "score": None,
            "status": "unavailable",
            "reason": "announcement_query_incomplete",
            "evidence": [],
        }
    matched: list[dict[str, Any]] = []
    for item in announcements:
        title = str(item.get("title") or item.get("headline") or "")
        published_at = _datetime(item.get("as_of") or item.get("published_at") or item.get("date"))
        if published_at is None or published_at > cutoff_at:
            continue
        event_names = [event for event, terms in POSITIVE_EVENTS.items() if any(term in title for term in terms)]
        if event_names:
            matched.append(
                {
                    "component": "announcement",
                    "source": item.get("source") or "announcement_provider",
                    "as_of": published_at.isoformat(),
                    "title": title,
                    "events": event_names[:1],
                }
            )
    if not matched:
        return {
            "score": 20.0,
            "status": "available",
            "reason": "no_positive_event",
            "evidence": [],
            "negative_count": 0,
        }
    latest = max(_datetime(item["as_of"]) for item in matched)
    age_days = max(0.0, (cutoff_at - latest).total_seconds() / 86400.0)
    recency = max(20.0, 100.0 - age_days * 4.0)
    event_count = len(matched)
    negative_count = sum(any(term in item["title"] for term in NEGATIVE_TERMS) for item in matched)
    penalty = min(30.0, negative_count * 10.0)
    score = (
        100.0 * 0.25
        + recency * 0.20
        + 95.0 * 0.20
        + min(100.0, 75.0 + event_count * 15.0) * 0.20
        + clamp(momentum) * 0.15
        - penalty
    )
    return {
        "score": round(clamp(score), 6),
        "status": "available",
        "event_count": event_count,
        "negative_count": negative_count,
        "exhaustion_penalty": penalty,
        "recency_score": round(recency, 6),
        "evidence": matched,
    }


def _leadership_observation(provider: str, payload: dict[str, Any]) -> tuple[float | None, float, dict[str, Any] | None]:
    if provider == "kaipanla":
        height = _float(payload.get("height") or payload.get("limit_height"))
        rank = _float(payload.get("rank"))
        if height is not None:
            rank_value = rank if rank is not None else 5.0
            score = min(100.0, 72.0 + height * 8.0 + max(0.0, 5.0 - rank_value) * 2.0)
            return score, 0.38, {"provider": provider, "kind": "limit_ladder", "height": height, "rank": rank}
        if payload.get("sector_leader"):
            return 88.0, 0.28, {"provider": provider, "kind": "sector_leader"}
    elif provider == "eastmoney":
        rank = _float(payload.get("board_rank") or payload.get("rank"))
        if rank is not None:
            return max(70.0, 98.0 - rank * 3.0), 0.25, {"provider": provider, "kind": "board_rank", "rank": rank}
    elif provider == "tonghuashun":
        rank = _float(payload.get("hot_rank") or payload.get("rank"))
        if rank is not None:
            score = 105.0 - rank * 5.0 if rank <= 10 else max(1.0, 60.0 - rank * 0.5)
            return clamp(score), 0.22, {"provider": provider, "kind": "hot_rank", "rank": rank}
    return None, 0.0, None


def score_leadership(provider_results: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    """Fuse Kaipanla/Eastmoney/Tonghuashun leadership evidence."""
    providers = ("kaipanla", "eastmoney", "tonghuashun")
    returned = 0
    weighted = 0.0
    total_confidence = 0.0
    evidence: list[dict[str, Any]] = []
    failures: list[str] = []
    for provider in providers:
        payload = provider_results.get(provider)
        if payload is None or payload.get("status") in {"error", "unavailable"}:
            failures.append(provider)
            continue
        returned += 1
        score, confidence, observation = _leadership_observation(provider, payload)
        if score is not None and observation is not None:
            weighted += score * confidence
            total_confidence += confidence
            observation["score"] = round(score, 6)
            observation["confidence_weight"] = confidence
            observation["as_of"] = payload.get("as_of")
            evidence.append(observation)
    if evidence:
        source_count = len({item["provider"] for item in evidence})
        return {
            "score": round(weighted / total_confidence, 6),
            "status": "available",
            "confidence": 1.0 if returned == len(providers) else round(source_count / len(providers), 6),
            "evidence": evidence,
            "failures": failures,
        }
    if returned == len(providers):
        return {"score": 0.0, "status": "available", "confidence": 1.0, "evidence": [], "failures": []}
    return {
        "score": None,
        "status": "unavailable",
        "confidence": 0.0,
        "evidence": [],
        "failures": failures,
        "reason": "no_evidence_with_provider_failures",
    }


def rescore_leadership_evidence(evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Reapply the exact THS curve while preserving persisted evidence."""
    refreshed = []
    weighted_score = 0.0
    confidence_total = 0.0
    providers = set()
    for raw_item in evidence:
        item = dict(raw_item)
        source = str(item.get("source") or item.get("provider") or "")
        provider = str(item.get("provider") or source).lower()
        value = str(item.get("value") or "")
        rank = None
        if value.startswith("hot_rank:"):
            rank = _float(value.split(":", 1)[1])
        elif item.get("kind") == "hot_rank":
            rank = _float(item.get("rank"))
        if rank is not None and any(marker in provider for marker in ("同花顺", "ths", "tonghuashun", "10jqka")):
            item["score"] = clamp(105.0 - rank * 5.0 if rank <= 10 else max(1.0, 60.0 - rank * 0.5))
        score = _float(item.get("score"))
        confidence = _float(item.get("confidence") if item.get("confidence") is not None else item.get("confidence_weight"))
        if score is not None and confidence is not None and confidence > 0:
            weighted_score += score * confidence
            confidence_total += confidence
            providers.add(source or provider)
        refreshed.append(item)
    if confidence_total <= 0:
        return {"score": None, "status": "unavailable", "confidence": 0.0, "evidence": refreshed, "reason": "leadership_evidence_missing"}
    return {
        "score": round(weighted_score / confidence_total, 6),
        "status": "available",
        "confidence": round(min(1.0, len(providers) / 3.0), 6),
        "evidence": refreshed,
    }


def score_sector_heat(row: dict[str, Any], *, rank: int | None = None) -> dict[str, Any]:
    components: list[tuple[str, float, float]] = []
    rank_value = _float(rank if rank is not None else row.get("rank"))
    change_pct = _float(row.get("change_pct"))
    main_pct = _float(row.get("main_pct"))
    main_net = _float(row.get("main_net"))
    advance_ratio = _float(row.get("advance_ratio"))
    if rank_value is not None:
        components.append(("rank", max(0.0, 104.0 - rank_value * 4.0), 0.35))
    if change_pct is not None:
        components.append(("change_pct", clamp(50.0 + change_pct * 7.0), 0.30))
    if main_pct is not None:
        components.append(("main_pct", clamp(50.0 + main_pct * 4.0), 0.20))
    if main_net is not None:
        components.append(("main_net", clamp(50.0 + main_net / 100_000_000.0 * 2.0), 0.15))
    if advance_ratio is not None:
        components.append(("advance_ratio", clamp(advance_ratio), 0.15))
    total_weight = sum(item[2] for item in components)
    if total_weight <= 0:
        return {"score": None, "status": "unavailable", "components": {}}
    return {
        "score": round(sum(score * weight for _, score, weight in components) / total_weight, 2),
        "status": "available",
        "components": {name: round(score, 6) for name, score, _ in components},
    }


def score_stock_popularity(row: dict[str, Any], *, rank: int | None = None) -> dict[str, Any]:
    rank_value = _float(rank if rank is not None else row.get("rank"))
    if rank_value is None:
        return {"score": None, "status": "unavailable", "components": {}}
    rank_change = _float(row.get("rank_change")) or 0.0
    consensus_count = max(1, int(_float(row.get("consensus_count")) or 1))
    components = [
        ("rank", clamp(105.0 - rank_value * 5.0), 0.65),
        ("rank_change", clamp(50.0 + rank_change * 5.0), 0.15),
        ("consensus", clamp(60.0 + (consensus_count - 1.0) * 20.0), 0.20),
    ]
    return {
        "score": round(sum(score * weight for _, score, weight in components), 2),
        "status": "available",
        "components": {name: round(score, 6) for name, score, _ in components},
    }
