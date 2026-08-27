from __future__ import annotations

import argparse
import os
import sqlite3
import time
from pathlib import Path


def build(source: Path, target: Path) -> tuple[int, float]:
    started = time.monotonic()
    temporary = target.with_suffix(target.suffix + ".building")
    if temporary.exists():
        temporary.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    source_db = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    output = sqlite3.connect(temporary)
    output.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA temp_store=MEMORY;
        CREATE TABLE news_documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT,
          source TEXT,
          url TEXT,
          published_at TEXT,
          document_type TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE news_fts USING fts5(
          title,
          content,
          content='news_documents',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        """
    )
    total = 0
    insert = "INSERT OR IGNORE INTO news_documents(id,title,content,source,url,published_at,document_type) VALUES(?,?,?,?,?,?,?)"
    queries = (
        (
            "news",
            "SELECT 'news:' || fingerprint,title,content,COALESCE(source,provider),url,publish_time,'news' FROM news ORDER BY publish_time",
        ),
        (
            "taoguba",
            "SELECT 'taoguba:' || article_id,title,content,source,url,publish_time,'community' FROM taoguba_articles ORDER BY publish_time",
        ),
        (
            "flash",
            "SELECT 'flash:' || fingerprint,substr(content,1,120),content,src,'',datetime,'flash' FROM global_flash_news ORDER BY datetime",
        ),
    )
    for _label, query in queries:
        cursor = source_db.execute(query)
        while True:
            rows = cursor.fetchmany(5_000)
            if not rows:
                break
            output.executemany(insert, rows)
            output.commit()
            total += len(rows)
    output.execute("INSERT INTO news_fts(news_fts) VALUES('rebuild')")
    output.executescript(
        """
        CREATE INDEX idx_news_documents_published ON news_documents(published_at DESC);
        CREATE INDEX idx_news_documents_source ON news_documents(source,published_at DESC);
        PRAGMA optimize;
        """
    )
    integrity = output.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"news index integrity check failed: {integrity}")
    output.close()
    source_db.close()
    os.replace(temporary, target)
    return total, time.monotonic() - started


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    rows, seconds = build(args.source, args.target)
    print(f"rows={rows} seconds={seconds:.1f} target={args.target}")
