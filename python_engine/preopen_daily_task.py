"""Generate the cached A-share pre-open daily panel.

Only the already integrated MiniShare news client may use the network. Taoguba
inputs are read from copied local SQLite databases and materialized into the
independent Aster database; this task never starts a Taoguba crawler.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
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
RISK_NOTE = "所有内容由AI总结，仅供参考，不构成投资建议"
NEWS_SYSTEM_PROMPT = """你是职业A股盘前分析师，面向短线+中线股民。基于给到的多条新闻原文，输出交易视角提炼，不要复述完整新闻。
输出要求：
1.每条新闻输出：简短核心交易观点（1-3句话，直接讲对A股/板块/个股的潜在影响）
2.必须携带字段 original_url 原始新闻链接，不可丢失
3.区分标签：type:"cn_news"｜"us_news"
4.不要编造信息，全部基于输入新闻；无价值新闻直接丢弃不要输出
每项严格使用字段 title,summary,publish_time,source,original_url,type。输出格式严格JSON数组，不要markdown，不要多余解释。"""
TAOGUBA_INDUSTRY_PROMPT = """你是A股舆情研究员。输入已经由本地证券主表按行业归组，每组包含多篇淘股吧原帖和确定性的股票提及。
任务：输出最多8个最重要的行业/题材共识，不要逐篇复述。
每项严格包含：industry,summary,consensus_view,divergence,sentiment,catalysts,risks,source_urls。
要求：
1.sentiment只能是“偏多”“中性”“偏空”“分歧”；
2.summary说明讨论焦点，consensus_view说明多数帖子共同逻辑，divergence说明分歧；
3.catalysts和risks均为字符串数组；source_urls必须只使用输入原帖链接，至少1条；
4.不得新增输入中没有的行业、股票、事实或链接；灌水和情绪宣泄不进入结果。
输出严格JSON数组，不要markdown，不要解释。"""
TAOGUBA_INFLUENCER_PROMPT = """你是A股舆情研究员。输入是淘股吧平台认证作者的帖子，已由本地证券主表标出帖子实际提及的股票。
任务：提炼最多12条“认证作者—具体股票”观点。
每项严格包含：author,stock_code,stance,summary,catalysts,risks,post_origin_url。
要求：
1.stance只能是“看多”“中性”“谨慎”“看空”；
2.只提炼作者对该股票有明确判断、持仓逻辑、催化或风险描述的内容；仅罗列股票名称的不输出；
3.author、stock_code、post_origin_url必须来自同一条输入记录，链接不可改写；
4.catalysts和risks均为字符串数组；不得推断作者身份、收益或未表达的观点；
5.优先覆盖不同作者和不同股票，每位作者最多输出3条；“某股是连板股”“某股未知”等没有分析逻辑的句子不算观点。
输出严格JSON数组，不要markdown，不要解释。"""

KEEP_TERMS = (
    "宏观", "政策", "央行", "货币", "利率", "降准", "降息", "财政", "监管", "证监会", "国务院", "发改委",
    "产业", "行业", "公告", "并购", "重组", "回购", "增持", "业绩", "订单", "关税", "出口", "进口", "制裁",
    "美联储", "美股", "纳斯达克", "标普", "道琼斯", "中概股", "原油", "黄金", "铜", "大宗商品", "美元",
    "芯片", "半导体", "人工智能", "机器人", "新能源", "光伏", "医药", "消费", "金融", "房地产", "军工", "航运",
)
US_TITLE_TERMS = (
    "美股", "美联储", "纳斯达克", "标普", "道琼斯", "华尔街", "中概股", "纽交所", "美债", "美国财政部",
    "美国联邦", "美元指数", "英伟达", "特斯拉", "苹果公司", "微软", "亚马逊", "meta", "openai", "莫德纳", "纽约金", "comex", "wti",
)
DOMESTIC_TITLE_TERMS = ("A股", "沪指", "深成指", "创业板", "科创板", "港股", "券商", "午报", "收评", "早盘", "主板")
DROP_TERMS = (
    "娱乐", "明星", "综艺", "电视剧", "电影票房", "婚礼", "离婚", "出轨", "社会新闻", "民生热线", "天气预报",
    "旅游攻略", "养生", "招聘", "抽奖", "优惠券", "推广", "广告", "软文", "课程报名", "点击购买", "反诈", "诈骗集团", "虚拟角色",
)
AMBIGUOUS_STOCK_NAMES = {"机器人"}


def _window(target_day: date) -> tuple[datetime, datetime]:
    return (
        datetime.combine(target_day - timedelta(days=1), time.min, SHANGHAI),
        datetime.combine(target_day, time(9, 14, 59), SHANGHAI),
    )


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip().replace("/", "-")
    if not text:
        return None
    text = re.sub(r"\s+", " ", text)
    parsed: datetime | None = None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y%m%d%H%M%S"):
            try:
                parsed = datetime.strptime(text[:19], pattern)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    return parsed.replace(tzinfo=SHANGHAI) if parsed.tzinfo is None else parsed.astimezone(SHANGHAI)


def _in_window(value: Any, start: datetime, end: datetime) -> bool:
    parsed = _parse_time(value)
    return bool(parsed and start <= parsed <= end)


def _read_json(value: Any) -> dict[str, Any]:
    try:
        result = json.loads(str(value or "{}"))
        return result if isinstance(result, dict) else {}
    except (TypeError, ValueError):
        return {}


def _author(raw: Any) -> str:
    payload = _read_json(raw)
    for key in ("author", "nickname", "user_name", "username", "userName", "user"):
        value = payload.get(key)
        if isinstance(value, dict):
            value = value.get("name") or value.get("nickname")
        if str(value or "").strip():
            return str(value).strip()[:120]
    return ""


def _number(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _author_metadata(raw: Any) -> dict[str, Any]:
    payload = _read_json(raw)
    title = payload.get("userTitle") if isinstance(payload.get("userTitle"), dict) else {}
    badges = [str(title.get(key) or "").strip() for key in ("title", "secTitle")]
    badges = list(dict.fromkeys(value for value in badges if value))
    verified = bool(_number(payload.get("auth")) or badges)
    return {
        "author": _author(raw),
        "author_id": str(payload.get("userID") or title.get("userID") or "").strip(),
        "author_verified": verified,
        "author_badge": " / ".join(badges)[:160] or ("平台认证" if verified else ""),
        "view_count": _number(payload.get("viewNum") or payload.get("view_count")),
        "like_count": _number(payload.get("usefulnum") or payload.get("like_count")),
        "reply_count": _number(payload.get("replyNum") or payload.get("comment_count")),
        "hot_flag": str(payload.get("hotFlag") or "").upper() == "Y",
    }


def _normalized_publish_time(value: Any, start: datetime, end: datetime) -> str | None:
    parsed = _parse_time(value)
    if parsed is None or not start <= parsed <= end:
        return None
    raw = str(value or "").strip()
    # A date-only row from the current day cannot prove it was published before
    # 09:14:59. Yesterday's date-only rows are safe because the whole day is in scope.
    if parsed.date() == end.date() and not re.search(r"\d{1,2}:\d{2}", raw):
        return None
    return parsed.strftime("%Y-%m-%d %H:%M:%S")


def _day_prefixes(value: date) -> list[str]:
    return list(dict.fromkeys((value.strftime("%Y-%m-%d"), f"{value.year}-{value.month}-{value.day}")))


def _security_universe(aster_db: Path) -> dict[str, Any]:
    with _open_readonly(aster_db) as connection:
        rows = connection.execute("SELECT code,name,COALESCE(industry,'未分类') FROM securities WHERE length(trim(name))>=3").fetchall()
    securities = [{"code": str(row[0]), "symbol": str(row[0]).split(".")[0], "name": str(row[1]).strip(), "industry": str(row[2] or "未分类").strip()} for row in rows]
    securities.sort(key=lambda row: len(row["name"]), reverse=True)
    return {"by_name": {row["name"]: row for row in securities}, "by_symbol": {row["symbol"]: row for row in securities}, "name_pattern": re.compile("|".join(re.escape(row["name"]) for row in securities))}


def _stock_mentions(text: str, securities: dict[str, Any]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    for match in securities["name_pattern"].finditer(text):
        security = securities["by_name"].get(match.group(0))
        if not security or security["name"] in AMBIGUOUS_STOCK_NAMES or security["code"] in seen:
            continue
        seen.add(security["code"])
        found.append({"code": security["code"], "name": security["name"], "industry": security["industry"]})
        if len(found) >= 24:
            return found
    for symbol in re.findall(r"(?<!\d)\d{6}(?!\d)", text):
        security = securities["by_symbol"].get(symbol)
        if not security or security["code"] in seen:
            continue
        seen.add(security["code"])
        found.append({"code": security["code"], "name": security["name"], "industry": security["industry"]})
        if len(found) >= 24:
            break
    return found


def _heat_score(metadata: dict[str, Any], source_heat: Any = 0, sentiment_score: Any = 50) -> float:
    score = float(source_heat or 0)
    score += 0.7 * math.log1p(metadata["view_count"])
    score += 2.0 * math.log1p(metadata["like_count"])
    score += 1.7 * math.log1p(metadata["reply_count"])
    score += 1.0 if metadata["author_verified"] else 0.0
    score += 0.5 if metadata["hot_flag"] else 0.0
    score += max(0.0, float(sentiment_score or 50) - 50) / 20
    return round(score, 6)


def _open_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def sync_taoguba_posts(aster_db: Path, source_root: Path, start: datetime, end: datetime) -> int:
    """Materialize only existing local Taoguba rows into the requested table."""
    sentiment_path = source_root / "sentiment_market" / "market_sentiment.db"
    news_path = source_root / "news.sqlite"
    securities = _security_universe(aster_db)
    collected: dict[str, dict[str, Any]] = {}
    prefixes = list(dict.fromkeys(_day_prefixes(start.date()) + _day_prefixes(end.date())))
    time_clause = " OR ".join("{} LIKE ?" for _ in prefixes)
    like_values = tuple(f"{prefix}%" for prefix in prefixes)

    def collect(*, post_id: Any, url: Any, title: Any, content: Any, publish_time: Any, raw: Any, source_heat: Any, sentiment_score: Any, source_table: str) -> None:
        clean_url = str(url or "").strip()
        normalized_time = _normalized_publish_time(publish_time, start, end)
        if not clean_url or not normalized_time:
            return
        clean_title = str(title or "").strip()
        clean_content = re.sub(r"\s+", " ", str(content or "")).strip()
        metadata = _author_metadata(raw)
        mentions = _stock_mentions(f"{clean_title} {clean_content}", securities)
        industries = list(dict.fromkeys(item["industry"] for item in mentions if item["industry"]))
        item = {
            "post_id": str(post_id or hashlib.sha256(clean_url.encode()).hexdigest()),
            "title": clean_title, "content": clean_content, "author": metadata["author"],
            "publish_time": normalized_time, "url": clean_url,
            "hot_score": _heat_score(metadata, source_heat, sentiment_score), "source_table": source_table,
            "metadata": metadata, "mentions": mentions, "industries": industries,
            "quality": {"raw_publish_time": str(publish_time or ""), "date_precision": "minute" if re.search(r"\d{1,2}:\d{2}", str(publish_time or "")) else "date", "hot_flag": metadata["hot_flag"]},
        }
        previous = collected.get(clean_url)
        if previous is None or item["hot_score"] > previous["hot_score"] or (not previous["author"] and item["author"]):
            collected[clean_url] = item

    if sentiment_path.exists():
        with _open_readonly(sentiment_path) as source:
            rows = source.execute(
                f"""SELECT post_id,url,title,published_at,COALESCE(cleaned_text,text,''),heat,final_score,raw_json
                   FROM posts WHERE platform='taoguba' AND ({time_clause.format(*(['published_at'] * len(prefixes)))})
                   ORDER BY fetched_at DESC LIMIT 5000""",
                like_values,
            ).fetchall()
        for row in rows:
            collect(post_id=row[0], url=row[1], title=row[2], publish_time=row[3], content=row[4], source_heat=row[5], sentiment_score=row[6], raw=row[7], source_table="market_sentiment.posts")
    if news_path.exists():
        with _open_readonly(news_path) as source:
            rows = source.execute(
                f"""SELECT article_id,title,content,publish_time,url,raw_json FROM taoguba_articles
                   WHERE ({time_clause.format(*(['publish_time'] * len(prefixes)))}) ORDER BY fetched_at DESC LIMIT 5000""",
                like_values,
            ).fetchall()
        for row in rows:
            collect(post_id=row[0], url=row[4], title=row[1], publish_time=row[3], content=row[2], source_heat=0, sentiment_score=50, raw=row[5], source_table="news.taoguba_articles")
    with sqlite3.connect(aster_db, timeout=60) as target:
        target.execute("PRAGMA busy_timeout=60000")
        target.execute("PRAGMA foreign_keys=ON")
        target.executemany(
            """INSERT INTO taoguba_posts(post_id,post_title,post_content,post_author,post_publish_time,post_origin_url,post_hot_score,source_table)
               VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET post_title=excluded.post_title,post_content=excluded.post_content,post_author=excluded.post_author,post_publish_time=excluded.post_publish_time,post_origin_url=excluded.post_origin_url,post_hot_score=excluded.post_hot_score,source_table=excluded.source_table,imported_at=CURRENT_TIMESTAMP""",
            [(row["post_id"], row["title"], row["content"], row["author"], row["publish_time"], row["url"], row["hot_score"], row["source_table"]) for row in collected.values()],
        )
        target.executemany(
            """INSERT INTO taoguba_post_enrichment(post_id,author_id,author_verified,author_badge,view_count,like_count,reply_count,stock_mentions_json,industry_mentions_json,raw_quality_json)
               VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET author_id=excluded.author_id,author_verified=excluded.author_verified,author_badge=excluded.author_badge,view_count=excluded.view_count,like_count=excluded.like_count,reply_count=excluded.reply_count,stock_mentions_json=excluded.stock_mentions_json,industry_mentions_json=excluded.industry_mentions_json,raw_quality_json=excluded.raw_quality_json,updated_at=CURRENT_TIMESTAMP""",
            [(row["post_id"], row["metadata"]["author_id"], int(row["metadata"]["author_verified"]), row["metadata"]["author_badge"], row["metadata"]["view_count"], row["metadata"]["like_count"], row["metadata"]["reply_count"], json.dumps(row["mentions"], ensure_ascii=False), json.dumps(row["industries"], ensure_ascii=False), json.dumps(row["quality"], ensure_ascii=False)) for row in collected.values()],
        )
    return len(collected)


def _safe_news_source_error(exc: Exception) -> str:
    """Return a useful source failure class without leaking URLs or tokens."""
    text = str(exc or "")
    status = re.search(r"\b([45]\d{2})\b", text)
    if status:
        return f"HTTP {status.group(1)}"
    lowered = text.lower()
    if "timed out" in lowered or "timeout" in lowered or "超时" in text:
        return "timeout"
    if "connection" in lowered or "连接" in text:
        return "connection_error"
    return type(exc).__name__


class _ObservedMiniShareClient:
    """Observe the existing MiniShare client while preserving its exact calls."""

    def __init__(self) -> None:
        from app.api.minishare_client import MiniShareClient

        self._client = MiniShareClient()
        self.success_calls = 0
        self.failures: list[dict[str, str]] = []

    def _call(self, endpoint: str, method: Any, **kwargs: Any) -> Any:
        try:
            result = method(**kwargs)
            self.success_calls += 1
            return result
        except Exception as exc:
            self.failures.append({"endpoint": endpoint, "error": _safe_news_source_error(exc)})
            raise

    def major_news(self, **kwargs: Any) -> Any:
        return self._call("major_news", self._client.major_news, **kwargs)

    def news(self, **kwargs: Any) -> Any:
        return self._call("news", self._client.news, **kwargs)


def refresh_existing_news_api(source_root: Path, target_day: date) -> dict[str, Any]:
    from app.services.news_cache import NewsCache

    observed = _ObservedMiniShareClient()
    cache = NewsCache(source_root / "news.sqlite", client=observed)
    result = cache.fetch_recent_days(days=2, per_day_limit=500, end_day=target_day)
    with _open_readonly(source_root / "news.sqlite") as connection:
        row = connection.execute(
            "SELECT COUNT(*),MAX(publish_time) FROM news WHERE publish_time>=? AND publish_time<=?",
            (f"{target_day.isoformat()} 00:00:00", f"{target_day.isoformat()} 23:59:59"),
        ).fetchone()
    failure_kinds = sorted({item["error"] for item in observed.failures})
    if observed.failures and not observed.success_calls:
        status = "unavailable"
    elif observed.failures:
        status = "degraded"
    else:
        status = "healthy"
    return {
        "status": status,
        "fetched": result.fetched,
        "inserted": result.inserted,
        "skipped": result.skipped,
        "successful_calls": observed.success_calls,
        "failed_calls": len(observed.failures),
        "failure_kinds": failure_kinds,
        "same_day_cached": int(row[0] or 0),
        "same_day_latest": str(row[1] or ""),
    }


def load_cached_news_summary(aster_db: Path, target_day: date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with _open_readonly(aster_db) as connection:
        row = connection.execute("SELECT payload_json FROM preopen_daily_summaries WHERE summary_date=?", (target_day.isoformat(),)).fetchone()
    payload = _read_json(row[0] if row else "{}")
    news = payload.get("news_part") if isinstance(payload.get("news_part"), dict) else {}
    return (news.get("cn_news") if isinstance(news.get("cn_news"), list) else [], news.get("us_news") if isinstance(news.get("us_news"), list) else [])


def load_news(source_root: Path, start: datetime, end: datetime) -> list[dict[str, Any]]:
    path = source_root / "news.sqlite"
    if not path.exists():
        return []
    with _open_readonly(path) as connection:
        rows = connection.execute(
            """SELECT title,content,publish_time,COALESCE(source,provider,''),url
               FROM news WHERE publish_time>=? AND publish_time<=?
               ORDER BY publish_time DESC LIMIT 3000""",
            (start.strftime("%Y-%m-%d 00:00:00"), end.strftime("%Y-%m-%d 23:59:59")),
        ).fetchall()
    result = []
    for row in rows:
        if not _in_window(row[2], start, end):
            continue
        item = {"title": str(row[0] or "").strip(), "content": str(row[1] or "").strip(), "publish_time": str(row[2] or ""), "source": str(row[3] or ""), "original_url": str(row[4] or "").strip()}
        text = f"{item['title']} {item['content']}".lower()
        if not item["title"] or not item["original_url"] or any(term.lower() in text for term in DROP_TERMS):
            continue
        score = sum(1 for term in KEEP_TERMS if term.lower() in text)
        if score <= 0 or re.search(r"(广告|推广|报名|购买|优惠|返现)", text):
            continue
        item["_score"] = score
        result.append(item)
    return result


def split_news(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cn, us = [], []
    for row in rows:
        title = str(row["title"] or "").lower()
        text = f"{row['title']} {row['content']}".lower()
        title_is_us = any(term.lower() in title for term in US_TITLE_TERMS)
        title_is_domestic = any(term.lower() in title for term in DOMESTIC_TITLE_TERMS)
        target = us if title_is_us and not title_is_domestic else cn
        target.append(row)
    key = lambda item: (int(item.get("_score") or 0), item.get("publish_time") or "")
    return sorted(cn, key=key, reverse=True)[:40], sorted(us, key=key, reverse=True)[:30]


def load_taoguba_candidates(aster_db: Path, start: datetime, end: datetime) -> list[dict[str, Any]]:
    with _open_readonly(aster_db) as connection:
        rows = connection.execute(
            """SELECT p.post_title,p.post_content,p.post_author,p.post_publish_time,p.post_origin_url,p.post_hot_score,
                      COALESCE(e.author_verified,0),COALESCE(e.author_badge,''),COALESCE(e.view_count,0),
                      COALESCE(e.like_count,0),COALESCE(e.reply_count,0),COALESCE(e.stock_mentions_json,'[]'),COALESCE(e.industry_mentions_json,'[]')
               FROM taoguba_posts p LEFT JOIN taoguba_post_enrichment e ON e.post_id=p.post_id
               WHERE p.post_publish_time>=? AND p.post_publish_time<=?
               ORDER BY p.post_hot_score DESC,p.post_publish_time DESC LIMIT 600""",
            (start.strftime("%Y-%m-%d 00:00:00"), end.strftime("%Y-%m-%d 23:59:59")),
        ).fetchall()
    candidates = []
    for row in rows:
        if not _in_window(row[3], start, end) or not str(row[4] or "").strip():
            continue
        content = re.sub(r"\s+", " ", str(row[1] or "")).strip()
        title = str(row[0] or "").strip()
        if len(title + content) < 30:
            continue
        mentions = json.loads(str(row[11] or "[]"))
        industries = json.loads(str(row[12] or "[]"))
        candidates.append({"post_title": title, "post_content": content[:1200], "post_author": str(row[2] or ""), "post_publish_time": str(row[3]), "post_origin_url": str(row[4]), "post_hot_score": float(row[5] or 0), "author_verified": bool(row[6]), "author_badge": str(row[7] or ""), "view_count": int(row[8] or 0), "like_count": int(row[9] or 0), "reply_count": int(row[10] or 0), "stock_mentions": mentions if isinstance(mentions, list) else [], "industry_mentions": industries if isinstance(industries, list) else []})
        if len(candidates) >= 300:
            break
    return candidates


def _client():
    from app.api.deepseek_client import DeepSeekClient, DeepSeekConfig

    configured = DeepSeekConfig.from_env()
    return DeepSeekClient(replace(configured, model="deepseek-chat"))


def summarize_news(client: Any, rows: list[dict[str, Any]], news_type: str) -> list[dict[str, Any]]:
    if not rows:
        return []
    inputs = [{key: (value[:1100] if key == "content" else value) for key, value in row.items() if not key.startswith("_")} for row in rows]
    output = client.chat_json(NEWS_SYSTEM_PROMPT, json.dumps({"type": news_type, "news": inputs}, ensure_ascii=False), temperature=0.1)
    allowed = {row["original_url"]: row for row in inputs}
    cleaned = []
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("original_url") or "").strip()
        source = allowed.get(url)
        summary = str(item.get("summary") or item.get("core_view") or "").strip()
        if not source or not summary:
            continue
        cleaned.append({"title": str(item.get("title") or source["title"])[:240], "summary": summary[:700], "publish_time": source["publish_time"], "source": source["source"], "original_url": url, "type": news_type})
    return cleaned


def build_industry_buckets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        for industry in row.get("industry_mentions") or []:
            if not industry or industry == "未分类":
                continue
            bucket = buckets.setdefault(industry, {"industry": industry, "posts": [], "stocks": {}})
            if not any(post["post_origin_url"] == row["post_origin_url"] for post in bucket["posts"]):
                bucket["posts"].append(row)
            for stock in row.get("stock_mentions") or []:
                if stock.get("industry") != industry:
                    continue
                record = bucket["stocks"].setdefault(stock["code"], {**stock, "mention_count": 0})
                record["mention_count"] += 1
    ranked = []
    for bucket in buckets.values():
        if len(bucket["posts"]) < 2:
            continue
        bucket["posts"].sort(key=lambda row: (row["post_hot_score"], row["view_count"] + row["like_count"] * 5 + row["reply_count"] * 3), reverse=True)
        bucket["stock_rank"] = sorted(bucket["stocks"].values(), key=lambda row: (row["mention_count"], row["name"]), reverse=True)[:8]
        bucket["rank_score"] = len(bucket["posts"]) * 4 + sum(row["post_hot_score"] for row in bucket["posts"][:8])
        ranked.append(bucket)
    return sorted(ranked, key=lambda row: row["rank_score"], reverse=True)[:10]


def _industry_prompt_input(buckets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for bucket in buckets:
        result.append({
            "industry": bucket["industry"],
            "deterministic_stock_mentions": bucket["stock_rank"],
            "posts": [{"author": row["post_author"], "verified": row["author_verified"], "publish_time": row["post_publish_time"], "heat_score": row["post_hot_score"], "title": row["post_title"], "content": row["post_content"][:700], "post_origin_url": row["post_origin_url"]} for row in bucket["posts"][:8]],
        })
    return result


def summarize_taoguba_industries(client: Any, buckets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not buckets:
        return []
    output = client.chat_json(TAOGUBA_INDUSTRY_PROMPT, json.dumps({"industry_groups": _industry_prompt_input(buckets)}, ensure_ascii=False), temperature=0.1)
    allowed = {bucket["industry"]: bucket for bucket in buckets}
    cleaned = []
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            continue
        industry = str(item.get("industry") or "").strip()
        bucket = allowed.get(industry)
        if not bucket:
            continue
        valid_urls = {row["post_origin_url"] for row in bucket["posts"]}
        urls = list(dict.fromkeys(str(url).strip() for url in (item.get("source_urls") or []) if str(url).strip() in valid_urls))
        summary = str(item.get("summary") or "").strip()
        if not summary or not urls:
            continue
        sources = []
        by_url = {row["post_origin_url"]: row for row in bucket["posts"]}
        for url in urls[:5]:
            row = by_url[url]
            sources.append({"author": row["post_author"] or "匿名用户", "verified": row["author_verified"], "publish_time": row["post_publish_time"], "post_origin_url": url})
        sentiment = str(item.get("sentiment") or "中性").strip()
        if sentiment not in {"偏多", "中性", "偏空", "分歧"}:
            sentiment = "中性"
        cleaned.append({
            "industry": industry, "summary": summary[:700],
            "consensus_view": str(item.get("consensus_view") or "").strip()[:700],
            "divergence": str(item.get("divergence") or "").strip()[:500], "sentiment": sentiment,
            "catalysts": [str(value).strip()[:240] for value in (item.get("catalysts") or []) if str(value).strip()][:5],
            "risks": [str(value).strip()[:240] for value in (item.get("risks") or []) if str(value).strip()][:5],
            "representative_stocks": bucket["stock_rank"][:5], "reference_post_count": len(bucket["posts"]), "source_posts": sources,
        })
        if len(cleaned) >= 8:
            break
    return cleaned


def influencer_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates = []
    for row in rows:
        if not row.get("author_verified") or not row.get("post_author") or not row.get("stock_mentions"):
            continue
        influence = row["view_count"] + row["like_count"] * 12 + row["reply_count"] * 8
        candidates.append({**row, "influence_score": influence})
    return sorted(candidates, key=lambda row: (row["influence_score"], row["post_hot_score"]), reverse=True)[:30]


def summarize_influencer_stock_views(client: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    inputs = [{"author": row["post_author"], "author_badge": row["author_badge"], "publish_time": row["post_publish_time"], "views": row["view_count"], "likes": row["like_count"], "replies": row["reply_count"], "stocks": row["stock_mentions"][:10], "title": row["post_title"], "content": row["post_content"][:1200], "post_origin_url": row["post_origin_url"]} for row in rows]
    output = client.chat_json(TAOGUBA_INFLUENCER_PROMPT, json.dumps({"verified_author_posts": inputs}, ensure_ascii=False), temperature=0.1)
    allowed: dict[tuple[str, str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
    for row in rows:
        for stock in row["stock_mentions"]:
            allowed[(row["post_author"], stock["code"], row["post_origin_url"])] = (row, stock)
    cleaned = []
    author_counts: dict[str, int] = {}
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            continue
        key = (str(item.get("author") or "").strip(), str(item.get("stock_code") or "").strip(), str(item.get("post_origin_url") or "").strip())
        source = allowed.get(key)
        summary = str(item.get("summary") or "").strip()
        if not source or not summary:
            continue
        row, stock = source
        if author_counts.get(row["post_author"], 0) >= 3:
            continue
        stance = str(item.get("stance") or "中性").strip()
        if stance not in {"看多", "中性", "谨慎", "看空"}:
            stance = "中性"
        cleaned.append({"author": row["post_author"], "author_badge": row["author_badge"] or "平台认证", "stock_name": stock["name"], "stock_code": stock["code"], "industry": stock["industry"], "stance": stance, "summary": summary[:700], "catalysts": [str(value).strip()[:240] for value in (item.get("catalysts") or []) if str(value).strip()][:4], "risks": [str(value).strip()[:240] for value in (item.get("risks") or []) if str(value).strip()][:4], "publish_time": row["post_publish_time"], "post_origin_url": row["post_origin_url"], "metrics": {"views": row["view_count"], "likes": row["like_count"], "replies": row["reply_count"]}})
        author_counts[row["post_author"]] = author_counts.get(row["post_author"], 0) + 1
        if len(cleaned) >= 18:
            break
    return group_influencer_stock_views(cleaned)


def group_influencer_stock_views(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        group = groups.setdefault(row["stock_code"], {"stock_name": row["stock_name"], "stock_code": row["stock_code"], "industry": row["industry"], "viewpoints": [], "authors": set(), "attention_score": 0})
        if row["author"] in group["authors"]:
            continue
        group["authors"].add(row["author"])
        group["viewpoints"].append(row)
        group["attention_score"] += row["metrics"]["views"] + row["metrics"]["likes"] * 12 + row["metrics"]["replies"] * 8
    results = []
    for group in groups.values():
        viewpoints = sorted(group["viewpoints"], key=lambda row: row["metrics"]["views"] + row["metrics"]["likes"] * 12 + row["metrics"]["replies"] * 8, reverse=True)
        stance_counts: dict[str, int] = {}
        for viewpoint in viewpoints:
            stance_counts[viewpoint["stance"]] = stance_counts.get(viewpoint["stance"], 0) + 1
        sorted_stances = sorted(stance_counts.items(), key=lambda item: item[1], reverse=True)
        overall_stance = "分歧" if len(sorted_stances) > 1 and sorted_stances[0][1] == sorted_stances[1][1] else sorted_stances[0][0]
        results.append({"stock_name": group["stock_name"], "stock_code": group["stock_code"], "industry": group["industry"], "overall_stance": overall_stance, "author_count": len(viewpoints), "combined_summary": "；".join(f"{row['author']}：{row['summary']}" for row in viewpoints[:3])[:1200], "viewpoints": viewpoints[:5], "attention_score": group["attention_score"]})
    return sorted(results, key=lambda row: (row["author_count"], row["attention_score"]), reverse=True)[:8]


def legacy_taoguba_top10(industry_views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for item in industry_views[:10]:
        sources = item.get("source_posts") or []
        if not sources:
            continue
        result.append({"summary": item["summary"], "hot_point": item["industry"], "post_origin_url": sources[0]["post_origin_url"], "reference_post_count": item["reference_post_count"]})
    return result


def run(aster_db: Path, source_root: Path, target_day: date, *, skip_news_refresh: bool = False, taoguba_only: bool = False) -> dict[str, Any]:
    started = datetime.now(SHANGHAI)
    start, end = _window(target_day)
    errors: dict[str, str] = {}
    taoguba_synced = 0
    news_refresh: dict[str, Any] = {"status": "skipped", "fetched": 0, "inserted": 0, "skipped": 0, "successful_calls": 0, "failed_calls": 0, "failure_kinds": [], "same_day_cached": 0, "same_day_latest": ""}
    if not skip_news_refresh and not taoguba_only:
        try:
            news_refresh = refresh_existing_news_api(source_root, target_day)
            if news_refresh["status"] == "unavailable":
                kinds = ",".join(news_refresh.get("failure_kinds") or ["source_unavailable"])
                errors["news_api"] = f"现有MiniShare新闻接口全部失败（{kinds}），仅保留时间窗内缓存"
        except Exception as exc:
            errors["news_api"] = f"{type(exc).__name__}: {exc}"[:500]
            news_refresh = {**news_refresh, "status": "unavailable", "failure_kinds": [_safe_news_source_error(exc)], "failed_calls": 1}
    try:
        taoguba_synced = sync_taoguba_posts(aster_db, source_root, start, end)
    except Exception as exc:
        errors["taoguba_local_sync"] = f"{type(exc).__name__}: {exc}"[:500]
    if taoguba_only:
        news = []
    else:
        try:
            news = load_news(source_root, start, end)
        except Exception as exc:
            errors["news_database"] = f"{type(exc).__name__}: {exc}"[:500]
            news = []
    news_times = [parsed for parsed in (_parse_time(row.get("publish_time")) for row in news) if parsed]
    same_day_news = sum(1 for parsed in news_times if parsed.date() == target_day)
    previous_day_news = sum(1 for parsed in news_times if parsed.date() == target_day - timedelta(days=1))
    latest_news_time = max(news_times).strftime("%Y-%m-%d %H:%M:%S") if news_times else ""
    try:
        taoguba = load_taoguba_candidates(aster_db, start, end)
    except Exception as exc:
        errors["taoguba_database"] = f"{type(exc).__name__}: {exc}"[:500]
        taoguba = []
    cn_rows, us_rows = split_news(news)
    industry_buckets = build_industry_buckets(taoguba)
    verified_stock_posts = influencer_candidates(taoguba)
    try:
        client = _client()
    except Exception as exc:
        errors["deepseek"] = f"{type(exc).__name__}: {exc}"[:500]
        client = None
    cn_news, us_news = load_cached_news_summary(aster_db, target_day) if taoguba_only else ([], [])
    industry_consensus: list[dict[str, Any]] = []
    influencer_stock_views: list[dict[str, Any]] = []
    if client:
        if not taoguba_only:
            for key, rows, news_type in (("cn_news_llm", cn_rows, "cn_news"), ("us_news_llm", us_rows, "us_news")):
                try:
                    value = summarize_news(client, rows, news_type)
                    if news_type == "cn_news": cn_news = value
                    else: us_news = value
                except Exception as exc:
                    errors[key] = f"{type(exc).__name__}: {exc}"[:500]
        try:
            industry_consensus = summarize_taoguba_industries(client, industry_buckets)
        except Exception as exc:
            errors["taoguba_industry_llm"] = f"{type(exc).__name__}: {exc}"[:500]
        try:
            influencer_stock_views = summarize_influencer_stock_views(client, verified_stock_posts)
        except Exception as exc:
            errors["taoguba_influencer_llm"] = f"{type(exc).__name__}: {exc}"[:500]
    summarized_news = [*cn_news, *us_news]
    summarized_times = [parsed for parsed in (_parse_time(row.get("publish_time")) for row in summarized_news) if parsed]
    same_day_summaries = sum(1 for parsed in summarized_times if parsed.date() == target_day)
    latest_summary_time = max(summarized_times).strftime("%Y-%m-%d %H:%M:%S") if summarized_times else ""
    if not taoguba_only and same_day_news == 0:
        errors.setdefault("news_freshness", f"{target_day.isoformat()}原始新闻为0条，当前展示上一日缓存")
    elif not taoguba_only and same_day_summaries == 0:
        errors.setdefault("news_freshness", f"{target_day.isoformat()}原始新闻已到库，但没有形成可展示的当日交易摘要")
    news_quality_status = "fresh" if same_day_summaries > 0 else "stale" if summarized_news else "empty"
    news_quality_message = (
        f"今日已展示{same_day_summaries}条，最新原文{latest_summary_time}" if news_quality_status == "fresh"
        else f"今日暂无可展示新闻；当前最新原文{latest_summary_time or latest_news_time or '无'}"
    )
    taoguba_top10 = legacy_taoguba_top10(industry_consensus)
    latest_taoguba = max((row["post_publish_time"] for row in taoguba), default="")
    generated = datetime.now(SHANGHAI).isoformat(timespec="seconds")
    payload = {
        "generate_datetime": generated,
        "time_window": {"start": start.strftime("%Y-%m-%d %H:%M:%S"), "end": end.strftime("%Y-%m-%d %H:%M:%S")},
        "news_part": {"cn_news": cn_news, "us_news": us_news},
        "source_quality": {"news": {
            "status": news_quality_status,
            "source_record_count": len(news),
            "same_day_source_count": same_day_news,
            "previous_day_source_count": previous_day_news,
            "same_day_summary_count": same_day_summaries,
            "latest_source_publish_time": latest_news_time,
            "latest_summary_publish_time": latest_summary_time,
            "refresh": news_refresh,
            "message": news_quality_message,
        }},
        "taoguba_top10": taoguba_top10,
        "taoguba_part": {
            "industry_consensus": industry_consensus,
            "influencer_stock_views": influencer_stock_views,
            "quality": {"source_post_count": taoguba_synced, "candidate_post_count": len(taoguba), "industry_group_count": len(industry_buckets), "verified_stock_post_count": len(verified_stock_posts), "latest_post_time": latest_taoguba, "classification": "本地证券主表行业映射 + deepseek-chat观点归纳"},
        },
        "note": RISK_NOTE,
    }
    return {
        "ok": True, "status": "success" if not errors else "partial", "task": "stock_market_preopen_daily_panel",
        "model": "deepseek-chat", "payload": payload, "source_counts": {"news": len(news), "news_same_day": same_day_news, "news_previous_day": previous_day_news, "cn_candidates": len(cn_rows), "us_candidates": len(us_rows), "taoguba": taoguba_synced, "taoguba_candidates": len(taoguba)},
        "errors": errors, "count": len(cn_news) + len(us_news) + len(industry_consensus) + len(influencer_stock_views),
        "message": f"盘前专题已生成：国内{len(cn_news)}条、美股{len(us_news)}条、行业共识{len(industry_consensus)}组、大V个股观点{len(influencer_stock_views)}条",
        "duration_ms": round((datetime.now(SHANGHAI) - started).total_seconds() * 1000, 2),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.getenv("ASTER_DB_PATH", str(ROOT / "data" / "aster.db")))
    parser.add_argument("--source-root", default=os.getenv("ASTER_8002_DATA_ROOT", str(ROOT / "data" / "source8002_data")))
    parser.add_argument("--date", default="")
    parser.add_argument("--skip-news-refresh", action="store_true")
    parser.add_argument("--taoguba-only", action="store_true")
    args = parser.parse_args()
    target = date.fromisoformat(args.date) if args.date else datetime.now(SHANGHAI).date()
    print(json.dumps(run(Path(args.db), Path(args.source_root), target, skip_news_refresh=args.skip_news_refresh, taoguba_only=args.taoguba_only), ensure_ascii=False, default=str))
