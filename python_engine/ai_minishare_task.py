"""Refresh and expose the existing 8002 MiniShare news cache for Aster AI.

This adapter deliberately reuses the copied 8002 client and its configured
token.  It does not add another news provider.  A failed network refresh falls
back to the valid, recent rows already present in the same local cache.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "python_engine" / "vendor_exact" / "ai8002_runtime"
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))

SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip().replace("/", "-")
    if not text:
        return None
    text = re.sub(r"\s+", " ", text)
    match = re.match(
        r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?",
        text,
    )
    if not match:
        return None
    try:
        parts = [int(value or 0) for value in match.groups()]
        return datetime(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], tzinfo=SHANGHAI)
    except ValueError:
        return None


def _safe_error(exc: Exception) -> str:
    text = str(exc or "")
    status = re.search(r"\b([45]\d{2})\b", text)
    if status:
        return f"HTTP {status.group(1)}"
    lowered = text.lower()
    if "timeout" in lowered or "timed out" in lowered or "超时" in text:
        return "timeout"
    if "token" in lowered or "授权" in text:
        return "authorization_error"
    if "connection" in lowered or "连接" in text:
        return "connection_error"
    return type(exc).__name__


def _read_cache(path: Path, start: datetime, end: datetime, limit: int) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """SELECT id,title,content,source,publish_time,url,provider
               FROM news ORDER BY id DESC LIMIT ?""",
            (max(limit * 12, 3000),),
        ).fetchall()
    finally:
        connection.close()
    valid: list[tuple[datetime, dict[str, Any]]] = []
    seen: set[str] = set()
    for row in rows:
        published = _parse_time(row["publish_time"])
        if not published or published < start or published > end:
            continue
        title = str(row["title"] or "").strip()
        content = str(row["content"] or "").strip()
        if not title and not content:
            continue
        key = str(row["url"] or "").strip() or f"{title}|{published.isoformat()}"
        if key in seen:
            continue
        seen.add(key)
        valid.append((published, {
            "evidence_id": f"minishare-{row['id']}",
            "title": title or content[:80],
            "content": content,
            "source": str(row["source"] or row["provider"] or "MiniShare").strip(),
            "provider": "MiniShare",
            "published_at": published.isoformat(timespec="seconds"),
            "url": str(row["url"] or "").strip(),
        }))
    valid.sort(key=lambda item: item[0], reverse=True)
    return [item for _, item in valid[:limit]]


def run(source_root: Path, days: int, limit: int) -> dict[str, Any]:
    from app.services.news_cache import NewsCache

    now = datetime.now(SHANGHAI)
    start = datetime.combine(now.date() - timedelta(days=days - 1), datetime.min.time(), SHANGHAI)
    end = now + timedelta(minutes=2)
    cache_path = source_root / "news.sqlite"
    refresh = {"fetched": 0, "inserted": 0, "skipped": 0}
    error = ""
    try:
        result = NewsCache(cache_path).fetch_recent_days(days=days, per_day_limit=500, end_day=now.date())
        refresh = {"fetched": result.fetched, "inserted": result.inserted, "skipped": result.skipped}
    except Exception as exc:
        error = _safe_error(exc)
    items = _read_cache(cache_path, start, end, limit)
    status = "healthy" if not error else ("degraded" if items else "unavailable")
    return {
        "status": status,
        "generated_at": now.isoformat(timespec="seconds"),
        "time_window": {"start": start.isoformat(timespec="seconds"), "end": end.isoformat(timespec="seconds")},
        "refresh": refresh,
        "error": error,
        "item_count": len(items),
        "latest_publish_time": items[0]["published_at"] if items else "",
        "items": items,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args()
    try:
        payload = run(Path(args.source_root), max(1, min(args.days, 7)), max(20, min(args.limit, 2000)))
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "unavailable", "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"), "error": _safe_error(exc), "items": [], "item_count": 0}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
