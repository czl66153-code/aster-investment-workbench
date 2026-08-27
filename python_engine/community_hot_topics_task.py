from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
from dataclasses import replace
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "python_engine" / "vendor_exact" / "ai8002_runtime"
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))

SHANGHAI = ZoneInfo("Asia/Shanghai")
PLATFORMS = ("taoguba", "kaipanla", "xueqiu")
PLATFORM_NAMES = {"taoguba": "淘股吧", "kaipanla": "开盘啦", "xueqiu": "雪球"}
RISK_NOTE = "仅供参考，不构成投资建议"
PLATFORM_SYSTEM_PROMPT = """你是严谨的A股平台舆情编辑。输入是单个平台在指定时间窗内按真实互动热度排名的前100条以内帖子或公开资讯。
请逐条覆盖输入后把语义相同的讨论合并，提炼最多20个平台话题；内容可以是个股、板块、政策、新闻、市场情绪或交易方法。
只能使用输入材料，不得补充外部事实，不得把开盘啦的source_kind=public_information写成用户观点，不得把单篇帖子夸大成跨平台共识。
准入采用宽口径：短句、口语、情绪表达、看多看空、盘感、传闻讨论和纯盈亏晒单只要能反映股民正在讨论什么就保留；只丢弃广告拉群、完全空白、机器重复和与证券市场毫无关系的内容。每个话题至少引用一个真实source_id。
输出严格JSON对象：{"topics":[{"topic":"短标题","category":"个股|板块|政策|新闻|市场|交易方法|其他","summary":"2-4句合并摘要","why_hot":"热度来源与分歧","sentiment":"偏多|中性|偏空|分歧","source_ids":["输入中的source_id"]}]}。
topics按重要性降序，最多20项，不要markdown，不要风险提示，不要输出输入中不存在的source_id。"""
FUSION_SYSTEM_PROMPT = """你是A股跨平台舆情总编。输入是淘股吧、开盘啦、雪球各自前100条高热内容经第一阶段AI提炼出的平台话题。
请合并语义相同的话题，按原帖互动热度、引用数量、时效性与跨平台覆盖排序，输出全局热点Top10；不足10个有效话题时返回实际数量。
当某个平台存在有效且有交易参考价值的平台话题时，最终Top10至少保留该平台最重要的一条，避免单一平台样本量压制其余真实来源；不得为了凑平台数保留广告或无价值内容。
只能依据输入，不得新增事实或source_id。开盘啦source_kind=public_information只能称公开资讯，不能冒充股民观点；单平台话题不能称跨平台共识。
输出严格JSON对象：{"topics":[{"topic":"短标题","category":"个股|板块|政策|新闻|市场|交易方法|其他","summary":"2-4句合并摘要","why_hot":"热度来源与分歧","sentiment":"偏多|中性|偏空|分歧","source_ids":["第一阶段中的真实source_id"]}]}。
不要markdown，不要风险提示。"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--date")
    return parser.parse_args()


def parse_timestamp(value: Any) -> datetime | None:
    text_value = str(value or "").strip()
    if not text_value:
        return None
    try:
        if text_value.isdigit():
            stamp = int(text_value)
            if stamp > 10_000_000_000:
                stamp //= 1000
            return datetime.fromtimestamp(stamp, SHANGHAI)
        normalized = text_value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=SHANGHAI)
        return parsed.astimezone(SHANGHAI)
    except (ValueError, OverflowError, OSError):
        return None


def number(value: Any) -> float:
    try:
        parsed = float(value or 0)
        return parsed if math.isfinite(parsed) else 0.0
    except (TypeError, ValueError):
        return 0.0


def first_number(raw: dict[str, Any], keys: tuple[str, ...]) -> float:
    for key in keys:
        if key in raw and raw[key] not in (None, ""):
            return number(raw[key])
    return 0.0


def clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def candidate_score(row: sqlite3.Row, raw: dict[str, Any]) -> float:
    replies = max(number(row["comment_count"]), first_number(raw, ("replyNum", "reply_count", "comment_count", "comments", "retweet_count")))
    likes = max(number(row["like_count"]), first_number(raw, ("likeNum", "like_count", "likes", "praiseNum", "usefulnum", "fav_count")))
    views = first_number(raw, ("viewNum", "view_count", "readNum", "clickNum", "views"))
    heat = max(number(row["heat"]), first_number(raw, ("heat", "hot_score", "hotScore")))
    quality_bonus = 10.0 if str(raw.get("bestFlag") or "").upper() == "Y" else 0.0
    quality_bonus += min(10.0, number(raw.get("auth")))
    return round(heat + math.log1p(replies) * 12 + math.log1p(likes) * 8 + math.log1p(views) * 2 + quality_bonus, 2)


def window_for(target: date) -> tuple[datetime, datetime]:
    now = datetime.now(SHANGHAI)
    start = datetime.combine(target - timedelta(days=1), time.min, SHANGHAI)
    end = now if target == now.date() else datetime.combine(target, time.max, SHANGHAI)
    return start, end


def load_candidates(db_path: Path, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not db_path.exists():
        raise FileNotFoundError(f"三平台舆情数据库不存在：{db_path}")
    connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        status_rows = {row["platform"]: dict(row) for row in connection.execute("SELECT platform,status,message,checked_at FROM source_status").fetchall()}
        rows = connection.execute(
            """SELECT platform,post_id,url,title,published_at,fetched_at,text,cleaned_text,
                      comment_count,like_count,heat,raw_json
               FROM posts WHERE platform IN ('taoguba','kaipanla','xueqiu')
               ORDER BY fetched_at DESC LIMIT 12000"""
        ).fetchall()
    finally:
        connection.close()

    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    counts = {platform: 0 for platform in PLATFORMS}
    latest: dict[str, str] = {platform: "" for platform in PLATFORMS}
    kinds: dict[str, dict[str, int]] = {platform: {"community_post": 0, "public_information": 0} for platform in PLATFORMS}
    for row in rows:
        published = parse_timestamp(row["published_at"])
        if not published or published < start or published > end:
            continue
        platform = str(row["platform"])
        try:
            raw = json.loads(str(row["raw_json"] or "{}"))
        except json.JSONDecodeError:
            raw = {}
        source_kind = str(raw.get("source_kind") or ("public_information" if platform == "kaipanla" and raw.get("CID") else "community_post"))
        source_kind = source_kind if source_kind in {"community_post", "public_information"} else "community_post"
        text_value = clean_text(row["cleaned_text"] or row["text"], 900)
        title = clean_text(row["title"], 180)
        # Community speech is often terse.  Keep short but meaningful market
        # reactions; the AI stage removes only ads, blank noise and duplicates.
        if len(title + text_value) < 6:
            continue
        fingerprint = (platform, re.sub(r"\W+", "", (title or text_value)[:80]).lower())
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        counts[platform] += 1
        kinds[platform][source_kind] += 1
        stamp = published.isoformat(timespec="seconds")
        if stamp > latest[platform]:
            latest[platform] = stamp
        candidates.append({
            "source_id": f"{platform}:{row['post_id']}",
            "platform": platform,
            "platform_name": PLATFORM_NAMES[platform],
            "source_kind": source_kind,
            "title": title,
            "content": text_value[:650],
            "published_at": stamp,
            "url": clean_text(row["url"], 500),
            "heat_score": candidate_score(row, raw),
        })

    candidates.sort(key=lambda item: (item["heat_score"], item["published_at"]), reverse=True)
    quotas = {"taoguba": 100, "kaipanla": 100, "xueqiu": 100}
    selected: list[dict[str, Any]] = []
    for platform in PLATFORMS:
        selected.extend([item for item in candidates if item["platform"] == platform][:quotas[platform]])
    selected.sort(key=lambda item: (item["heat_score"], item["published_at"]), reverse=True)
    selected = selected[:300]

    quality: dict[str, Any] = {}
    for platform in PLATFORMS:
        source_state = status_rows.get(platform, {})
        in_window = counts[platform]
        quality[platform] = {
            "platform": platform,
            "platform_name": PLATFORM_NAMES[platform],
            "status": "fresh" if in_window else ("unavailable" if source_state.get("status") == "unavailable" else "empty"),
            "source_status": str(source_state.get("status") or "unknown"),
            "message": str(source_state.get("message") or "尚未记录采集状态"),
            "checked_at": str(source_state.get("checked_at") or ""),
            "in_window_count": in_window,
            "candidate_count": sum(1 for item in selected if item["platform"] == platform),
            "community_post_count": kinds[platform]["community_post"],
            "public_information_count": kinds[platform]["public_information"],
            "latest_publish_time": latest[platform],
        }
    return selected, quality


def _clean_ai_topics(output: Any, allowed: dict[str, dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    raw_topics = output.get("topics", []) if isinstance(output, dict) else output if isinstance(output, list) else []
    topics = []
    for item in raw_topics:
        if not isinstance(item, dict):
            continue
        source_ids = list(dict.fromkeys(str(value) for value in item.get("source_ids", []) if str(value) in allowed))
        topic = clean_text(item.get("topic"), 80)
        summary = clean_text(item.get("summary"), 700)
        if not topic or not summary or not source_ids:
            continue
        topics.append({
            "topic": topic,
            "category": str(item.get("category")) if str(item.get("category")) in {"个股", "板块", "政策", "新闻", "市场", "交易方法", "其他"} else "其他",
            "summary": summary,
            "why_hot": clean_text(item.get("why_hot"), 360),
            "sentiment": str(item.get("sentiment")) if str(item.get("sentiment")) in {"偏多", "中性", "偏空", "分歧"} else "中性",
            "source_ids": source_ids[:12],
        })
    return topics[:limit]


def summarize(candidates: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    if not candidates:
        return [], {}
    from app.api.deepseek_client import DeepSeekClient, DeepSeekConfig

    configured = DeepSeekConfig.from_env()
    client = DeepSeekClient(replace(configured, model="deepseek-chat"))
    allowed = {item["source_id"]: item for item in candidates}
    stage_errors: dict[str, str] = {}
    platform_topics: list[dict[str, Any]] = []
    for platform in PLATFORMS:
        platform_rows = [item for item in candidates if item["platform"] == platform][:100]
        if not platform_rows:
            continue
        platform_allowed = {item["source_id"]: item for item in platform_rows}
        prompt_rows = [{key: value for key, value in item.items() if key not in {"url", "content"}} | {"content": item["content"][:460]} for item in platform_rows]
        try:
            output = client.chat_json(PLATFORM_SYSTEM_PROMPT, json.dumps({"platform": platform, "platform_name": PLATFORM_NAMES[platform], "ranked_top_posts": prompt_rows}, ensure_ascii=False), temperature=0.1)
            for topic in _clean_ai_topics(output, platform_allowed, 20):
                topic["platform"] = platform
                topic["source_heat"] = round(sum(number(allowed[source_id]["heat_score"]) for source_id in topic["source_ids"]), 2)
                platform_topics.append(topic)
        except Exception as exc:
            stage_errors[f"deepseek_{platform}"] = f"{type(exc).__name__}: {exc}"[:500]
    if not platform_topics:
        return [], stage_errors
    fusion_rows = [{"platform": item["platform"], "topic": item["topic"], "category": item["category"], "summary": item["summary"], "why_hot": item["why_hot"], "sentiment": item["sentiment"], "source_ids": item["source_ids"], "source_heat": item["source_heat"]} for item in platform_topics]
    try:
        fused_output = client.chat_json(FUSION_SYSTEM_PROMPT, json.dumps({"platform_topics": fusion_rows}, ensure_ascii=False), temperature=0.1)
        fused_topics = _clean_ai_topics(fused_output, allowed, 10)
    except Exception as exc:
        stage_errors["deepseek_fusion"] = f"{type(exc).__name__}: {exc}"[:500]
        return [], stage_errors
    topics: list[dict[str, Any]] = []
    for item in fused_topics:
        source_posts = [allowed[source_id] for source_id in item["source_ids"][:8]]
        platform_keys = list(dict.fromkeys(source["platform"] for source in source_posts))
        total_heat = sum(number(source["heat_score"]) for source in source_posts)
        discussion_heat = round(total_heat + len(source_posts) * 6 + max(0, len(platform_keys) - 1) * 20, 2)
        topics.append({
            "rank": 0,
            "topic": item["topic"],
            "category": item["category"],
            "summary": item["summary"],
            "why_hot": item["why_hot"],
            "sentiment": item["sentiment"],
            "discussion_heat": discussion_heat,
            "platforms": platform_keys,
            "reference_post_count": len(source_posts),
            "source_posts": source_posts,
        })
    topics.sort(key=lambda item: (len(item["platforms"]), item["discussion_heat"], item["reference_post_count"]), reverse=True)
    for index, item in enumerate(topics[:10], 1):
        item["rank"] = index
    return topics[:10], stage_errors


def main() -> int:
    args = parse_args()
    target = date.fromisoformat(args.date) if args.date else datetime.now(SHANGHAI).date()
    start, end = window_for(target)
    db_path = Path(args.source_root) / "sentiment_market" / "market_sentiment.db"
    errors: dict[str, str] = {}
    try:
        candidates, source_quality = load_candidates(db_path, start, end)
    except Exception as exc:  # overall endpoint must remain readable
        candidates = []
        source_quality = {platform: {"platform": platform, "platform_name": PLATFORM_NAMES[platform], "status": "unavailable", "source_status": "error", "message": str(exc)[:300], "checked_at": "", "in_window_count": 0, "candidate_count": 0, "community_post_count": 0, "public_information_count": 0, "latest_publish_time": ""} for platform in PLATFORMS}
        errors["source_database"] = f"{type(exc).__name__}: {exc}"[:500]
    try:
        topics, llm_errors = summarize(candidates)
        errors.update(llm_errors)
    except Exception as exc:
        topics = []
        errors["deepseek"] = f"{type(exc).__name__}: {exc}"[:500]
    payload = {
        "summary_date": target.isoformat(),
        "generate_datetime": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        "time_window": {"start": start.isoformat(timespec="seconds"), "end": end.isoformat(timespec="seconds")},
        "topics": topics,
        "source_quality": source_quality,
        "candidate_count": len(candidates),
        "model": "deepseek-chat",
        "methodology": "每个平台先按真实发布时间与互动热度独立选取最多100条；第一阶段DeepSeek分别提炼平台话题，第二阶段再按引用量、热度与跨平台覆盖合并为全局Top10，来源链接由程序回填。",
        "note": RISK_NOTE,
    }
    print(json.dumps({"status": "success" if topics and not errors else "partial" if topics or candidates else "failed", "payload": payload, "source_counts": {platform: source_quality[platform]["in_window_count"] for platform in PLATFORMS}, "errors": errors}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
