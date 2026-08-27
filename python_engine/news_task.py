"""Run the copied 8002 news, five-platform and sentiment collectors independently."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
VENDOR8002 = ROOT / "python_engine" / "vendor_exact" / "ai8002_runtime"
if str(VENDOR8002) not in sys.path:
    sys.path.insert(0, str(VENDOR8002))


def _run_stage(name: str, action: Callable[[], Any]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        value = action()
        if hasattr(value, "__dict__"):
            value = {key: str(item) if isinstance(item, Path) else item for key, item in value.__dict__.items()}
        return {"name": name, "ok": True, "duration_ms": round((time.monotonic() - started) * 1000, 2), "result": value}
    except Exception as exc:  # provider failures are recorded independently
        return {"name": name, "ok": False, "duration_ms": round((time.monotonic() - started) * 1000, 2), "error": f"{type(exc).__name__}: {exc}"}


def _import_recent_evidence(source: Path, target: Path, days: int) -> dict[str, Any]:
    if not target.exists():
        return {"ok": False, "count": 0, "error": f"Aster database missing: {target}"}
    lower = (datetime.now() - timedelta(days=max(1, days))).strftime("%Y-%m-%d")
    upper = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d 23:59:59")
    source_db = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True, timeout=30)
    target_db = sqlite3.connect(target, timeout=60)
    changed = 0
    try:
        rows = source_db.execute(
            "SELECT title,content,COALESCE(source,provider),url,publish_time FROM news WHERE publish_time>=? AND publish_time<=? ORDER BY publish_time",
            (lower, upper),
        ).fetchall()
        rows += source_db.execute(
            "SELECT title,content,source,url,publish_time FROM taoguba_articles WHERE publish_time>=? AND publish_time<=? ORDER BY publish_time",
            (lower, upper),
        ).fetchall()
        insert = """INSERT OR IGNORE INTO news_evidence(
          evidence_id,title,content,source,url,published_at,related_codes,industry,sentiment,relevance,raw_json,imported_at
        ) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,0.5,?,CURRENT_TIMESTAMP)"""
        for title, content, provider, url, published_at in rows:
            evidence_id = hashlib.sha1(f"{provider}|{url}|{title}".encode("utf-8", "ignore")).hexdigest()
            cursor = target_db.execute(insert, (evidence_id, title or "未命名资讯", content or "", provider or "8002原采集器", url or "", str(published_at or ""), json.dumps({"import": "8002_original_collectors"}, ensure_ascii=False)))
            changed += max(0, int(cursor.rowcount or 0))
        target_db.commit()
        return {"ok": True, "count": changed, "scanned": len(rows), "from": lower, "to": upper}
    finally:
        source_db.close()
        target_db.close()


def _generate_stock_sentiment_snapshot(service: Any) -> dict[str, Any]:
    """Materialize the same-day stock report required by the heat gate."""
    result = service.generate_stock_top10_report()
    service._write_snapshots()
    report = result.get("report") if isinstance(result, dict) else {}
    return {
        "ok": bool(result.get("ok")) if isinstance(result, dict) else False,
        "period_end": (report or {}).get("period_end"),
        "count": len((report or {}).get("top10") or []),
    }


def run(data_root: Path, days: int, aster_db: Path | None = None) -> dict[str, Any]:
    # The cross-platform discussion panel ranks at most the hottest 100 valid
    # records from each source before either stage of AI summarisation.
    # Fetch a wider raw pool first.  The downstream community task applies the
    # time window, deduplicates, then ranks the hottest 100 per platform.
    os.environ.setdefault("SENTIMENT_TAOGUBA_FETCH_LIMIT", "400")
    os.environ.setdefault("SENTIMENT_KAIPANLA_FETCH_LIMIT", "400")
    os.environ.setdefault("SENTIMENT_XUEQIU_FETCH_LIMIT", "300")
    sentiment_deepseek = os.getenv("ASTER_SENTIMENT_USE_DEEPSEEK", "false").strip().lower() in {"1", "true", "yes", "on"}
    if not sentiment_deepseek:
        # Keep scheduled collection deterministic and cheap. This only affects
        # the collector subprocess; the interactive enhanced AI endpoint keeps
        # its own DeepSeek configuration.
        os.environ["DEEPSEEK_API_KEY"] = ""
    from app.services.news_cache import NewsCache
    from app.services.multi_platform_hot_stocks import MultiPlatformHotStockService
    from app.services import market_sentiment as market_sentiment_module

    started = time.monotonic()
    news_db = data_root / "news.sqlite"
    sentiment_db = data_root / "sentiment_market" / "market_sentiment.db"
    hot_dir = data_root / "hot_stock_rankings"
    stages = []
    stages.append(_run_stage("minishare_news", lambda: NewsCache(news_db).fetch_recent_days(days=max(1, days), per_day_limit=500)))
    stages.append(_run_stage("five_platform_heat", lambda: MultiPlatformHotStockService(cache_dir=hot_dir).dashboard(refresh=True, target_day=date.today(), allow_stale=False)))
    # The original service imports DEFAULT_DB_PATH at module load. Point that
    # constant at the independent news copy before the same collectors run.
    market_sentiment_module.DEFAULT_DB_PATH = news_db
    sentiment_service = market_sentiment_module.MarketSentimentService(sentiment_db)
    stages.append(_run_stage("community_sentiment", sentiment_service.refresh))
    stages.append(_run_stage("community_stock_top10", lambda: _generate_stock_sentiment_snapshot(sentiment_service)))
    if aster_db is not None:
        stages.append(_run_stage("aster_evidence_import", lambda: _import_recent_evidence(news_db, aster_db, days)))
    return {
        "ok": any(stage["ok"] for stage in stages),
        "status": "success" if all(stage["ok"] for stage in stages) else "partial",
        "task": "news_8002_original_collectors",
        "algorithm": "NewsCache+MultiPlatformHotStockService+MarketSentimentService",
        "sentiment_mode": "deepseek_optional" if sentiment_deepseek else "local_dictionary",
        "data_root": str(data_root),
        "stages": stages,
        "count": sum(int((stage.get("result") or {}).get("count") or 0) for stage in stages if isinstance(stage.get("result"), dict)),
        "message": "8002原新闻、五平台热度、社区情绪采集完成；情绪默认由本地词典评分，新证据已写入独立数据库",
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", default=os.getenv("ASTER_8002_DATA_ROOT", str(ROOT / "data" / "source8002_data")))
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--aster-db", default=os.getenv("ASTER_DB_PATH", ""))
    args = parser.parse_args()
    print(json.dumps(run(Path(args.data_root), args.days, Path(args.aster_db) if args.aster_db else None), ensure_ascii=False, default=str))
