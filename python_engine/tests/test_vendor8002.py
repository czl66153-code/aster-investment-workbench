from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from python_engine.vendor8002.collectors import MultiPlatformHotCollector
from python_engine.vendor8002.config import Vendor8002Settings
from python_engine.vendor8002.importers import import_community_cache, import_news_cache
from python_engine.vendor8002.ranking import combine_platform_rankings, score_optimized_candidates
from python_engine.vendor8002.tasks import run_heat_recommendation_task


def _target_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE securities(code TEXT PRIMARY KEY,symbol TEXT,name TEXT);
        CREATE TABLE news_evidence(
          evidence_id TEXT PRIMARY KEY,title TEXT,content TEXT,source TEXT,url TEXT,
          published_at TEXT,related_codes TEXT,industry TEXT,sentiment REAL,
          relevance REAL,raw_json TEXT,imported_at TEXT
        );
        INSERT INTO securities VALUES('000001.SZ','000001','平安银行');
        """
    )
    connection.commit()
    connection.close()


def _task_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE securities(code TEXT PRIMARY KEY,symbol TEXT,name TEXT,industry TEXT);
        CREATE TABLE factor_snapshot(
          code TEXT,trade_date TEXT,name TEXT,industry TEXT,ret_20d REAL,
          volume_ratio_20 REAL,amount REAL,turnover_rate REAL,volatility_20 REAL,
          drawdown_20 REAL,five_platform_heat REAL,four_agent_score REAL,
          industry_ret_4d REAL,taoguba_sentiment REAL,daily_breakout_score REAL,
          aia_leadership REAL,aia_technical_pattern REAL,aia_sector_heat REAL,
          PRIMARY KEY(code,trade_date)
        );
        CREATE TABLE recommendation_batches(
          batch_id TEXT PRIMARY KEY,model_key TEXT,trade_date TEXT,status TEXT,
          trigger_type TEXT,source_mode TEXT,item_count INTEGER,model_version TEXT,
          message TEXT,started_at TEXT,finished_at TEXT
        );
        CREATE TABLE recommendations(
          batch_id TEXT,model_key TEXT,trade_date TEXT,code TEXT,rank INTEGER,
          score REAL,reason TEXT,risk TEXT,confidence REAL,payload_json TEXT,
          generated_at TEXT,PRIMARY KEY(batch_id,code),
          FOREIGN KEY(batch_id) REFERENCES recommendation_batches(batch_id),
          FOREIGN KEY(code) REFERENCES securities(code)
        );
        CREATE TABLE dataset_versions(
          dataset_key TEXT,version_id TEXT,trade_date TEXT,row_count INTEGER,
          checksum TEXT,status TEXT,source TEXT,quality_score REAL,created_at TEXT,
          published_at TEXT,PRIMARY KEY(dataset_key,version_id)
        );
        """
    )
    for index in range(1, 41):
        symbol = f"{index:06d}"
        code = f"{symbol}.SZ"
        connection.execute("INSERT INTO securities VALUES(?,?,?,?)", (code, symbol, f"测试{index}", f"行业{index % 5}"))
        connection.execute(
            "INSERT INTO factor_snapshot VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                code,
                "2026-08-19",
                f"测试{index}",
                f"行业{index % 5}",
                index / 100,
                1 + index / 50,
                index * 1_000_000,
                index / 5,
                0.1 + index / 1000,
                -0.2 + index / 500,
                50 + index / 2,
                40 + index,
                index / 1000,
                50,
                100 if index % 11 == 0 else 0,
                65 + index / 2,
                62 + index / 2,
                64 + index / 2,
            ),
        )
    connection.commit()
    connection.close()


def _task_source_root(path: Path) -> None:
    hot_dir = path / "hot_stock_rankings"
    sentiment_dir = path / "sentiment_market"
    hot_dir.mkdir(parents=True)
    sentiment_dir.mkdir(parents=True)
    ranked = [{"rank": index, "name": f"测试{index}", "code": f"{index:06d}"} for index in range(1, 11)]
    platforms = [
        {"key": "xueqiu", "name": "雪球", "ok": True, "source_date": "2026-08-20", "items": ranked},
        {"key": "eastmoney", "name": "东财", "ok": True, "source_date": "2026-08-20", "items": ranked},
        {"key": "tonghuashun", "name": "同花顺", "ok": True, "source_date": "2026-08-20", "items": ranked},
        {"key": "taoguba", "name": "淘股吧", "ok": False, "source_date": "", "items": [], "error": "test unavailable"},
        {"key": "kaipanla", "name": "开盘啦", "ok": False, "source_date": "", "items": [], "error": "test unavailable"},
    ]
    combined = [
        {"rank": index, "name": f"测试{index}", "code": f"{index:06d}", "score": 31 - index, "platform_count": 3, "contributions": []}
        for index in range(1, 11)
    ]
    (hot_dir / "2026-08-20.json").write_text(json.dumps({"date": "2026-08-20", "success_count": 3, "platforms": platforms, "combined": combined}, ensure_ascii=False), encoding="utf-8")
    top10 = [{"name": f"测试{index}", "code": f"{index:06d}", "sentiment_score": 55 + index} for index in range(1, 11)]
    (sentiment_dir / "stock-top10-2026-08-20.json").write_text(json.dumps([{"report": {"period_end": "2026-08-20T15:00:00+08:00", "top10": top10}}], ensure_ascii=False), encoding="utf-8")


class RankingTests(unittest.TestCase):
    def test_kaipanla_bridge_preserves_source_date_and_top10(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = root / "engine" / "kaipanla_source.mjs"
            bridge.parent.mkdir(parents=True)
            bridge.write_text("// test bridge", encoding="utf-8")
            collector = MultiPlatformHotCollector(Vendor8002Settings.from_env(env={}, project_dir=root))
            output = {
                "ok": True,
                "source_date": "2026-08-20",
                "items": [{"rank": 1, "name": "誉衡药业", "code": "002437", "heat": "22.22亿主力", "change": "医药"}],
            }
            with patch("python_engine.vendor8002.collectors.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(output, ensure_ascii=False), stderr="")):
                items = collector.fetch_kaipanla(date(2026, 8, 21))
            self.assertEqual(items[0]["name"], "誉衡药业")
            self.assertEqual(items[0]["code"], "002437")
            self.assertEqual(collector._source_dates["kaipanla"], "2026-08-20")

    def test_legacy_platform_formula_and_strict_code_filter(self) -> None:
        platforms = [
            {"key": "xueqiu", "name": "雪球", "ok": True, "items": [{"rank": 1, "name": "平安银行", "code": "SZ000001"}, {"rank": 2, "name": "港股", "code": "01952"}]},
            {"key": "eastmoney", "name": "东财", "ok": True, "items": [{"rank": 2, "name": "平安银行", "code": "000001"}]},
        ]
        legacy = combine_platform_rankings(platforms)
        self.assertEqual(legacy["mode"], "legacy")
        self.assertEqual(legacy["items"][0]["code"], "000001")
        self.assertEqual(legacy["items"][0]["score"], 47.5)
        self.assertTrue(any(row["code"] == "01952" for row in legacy["items"]))

        strict = combine_platform_rankings(platforms, mode="strict", valid_codes={"000001.SZ"})
        self.assertEqual([row["code"] for row in strict["items"]], ["000001"])
        self.assertTrue(any(row["reason"] == "not_in_a_share_master" for row in strict["rejected"]))

    def test_legacy_keeps_single_agent_while_strict_moves_it_to_watchlist(self) -> None:
        candidates = [
            {
                "stock_code": "600001",
                "stock_name": "单板块",
                "factor_scores": {"five_platform_heat": 80, "four_agent_rank": 50, "yesterday_sector_momentum": 90, "original_8002_ex_size": 60, "taoguba_sentiment": 50, "daily_breakout": 30},
                "agent_scores": {"logic": 0, "technical": 0, "sector_heat": 100, "five_platform_heat": 0},
            },
            {
                "stock_code": "000001",
                "stock_name": "双确认",
                "factor_scores": {"five_platform_heat": 70, "four_agent_rank": 60, "yesterday_sector_momentum": 60, "original_8002_ex_size": 50, "taoguba_sentiment": 50, "daily_breakout": 50},
                "agent_scores": {"logic": 45, "technical": 45, "sector_heat": 0, "five_platform_heat": 0},
            },
        ]
        legacy = score_optimized_candidates(candidates)
        self.assertEqual(legacy["items"][0]["stock_code"], "600001")
        self.assertEqual(legacy["items"][0]["optimized_score"], 25.0)

        strict = score_optimized_candidates(candidates, mode="strict", valid_codes={"600001.SH", "000001.SZ"})
        self.assertEqual([row["stock_code"] for row in strict["items"]], ["000001"])
        self.assertEqual(strict["watchlist"][0]["stock_code"], "600001")


class ImportTests(unittest.TestCase):
    def test_news_and_community_importers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.db"
            news = root / "news.db"
            community = root / "community.db"
            _target_database(target)

            connection = sqlite3.connect(news)
            connection.executescript(
                """
                CREATE TABLE news(
                  id INTEGER PRIMARY KEY,fingerprint TEXT,title TEXT,content TEXT,
                  source TEXT,publish_time TEXT,url TEXT,raw_json TEXT,created_at TEXT
                );
                """
            )
            connection.execute("INSERT INTO news VALUES(1,?,?,?,?,?,?,?,?)", ("a" * 64, "平安银行公告", "代码000001", "测试源", "2026-08-20T10:00:00+08:00", "https://example/news", "{}", "2026-08-20T10:01:00+08:00"))
            connection.execute("INSERT INTO news VALUES(2,?,?,?,?,?,?,?,?)", ("b" * 64, "坏日期", "", "测试源", "2098-70-00", "", "{}", "2098-70-00"))
            connection.commit()
            connection.close()

            dry = import_news_cache(news, target)
            self.assertEqual(dry.eligible, 1)
            self.assertEqual(dry.inserted, 0)
            committed = import_news_cache(news, target, dry_run=False)
            self.assertEqual(committed.inserted, 1)
            self.assertEqual(committed.invalid_dates, 1)

            connection = sqlite3.connect(community)
            connection.execute(
                """
                CREATE TABLE posts(
                  platform TEXT,post_id TEXT,url TEXT,title TEXT,published_at TEXT,
                  fetched_at TEXT,text TEXT,cleaned_text TEXT,final_score REAL,
                  raw_json TEXT,stock_mentions_json TEXT
                )
                """
            )
            connection.execute("INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?,?,?)", ("taoguba", "p1", "https://example/post", "讨论平安银行", "2026-08-20T11:00:00+08:00", "2026-08-20T11:01:00+08:00", "看多000001", "看多000001", 72, "{}", json.dumps(["000001"])))
            connection.commit()
            connection.close()
            result = import_community_cache(community, target, dry_run=False)
            self.assertEqual(result.inserted, 1)

            connection = sqlite3.connect(target)
            rows = connection.execute("SELECT source,related_codes FROM news_evidence ORDER BY source").fetchall()
            connection.close()
            self.assertEqual(len(rows), 2)
            self.assertTrue(any("000001.SZ" in row[1] for row in rows))


class TaskTests(unittest.TestCase):
    def test_complete_heat_task_writes_only_staging_and_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "aster.db"
            source = root / "source8002_data"
            output = root / "result.json"
            _task_database(database)
            _task_source_root(source)
            result = run_heat_recommendation_task(
                database_path=database,
                source8002_data_dir=source,
                as_of="2026-08-20",
                output_path=output,
                write_staging=True,
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "ready")
            self.assertEqual(len(result["result"]["items"]), 8)
            self.assertTrue(result["writes"]["staging"]["written"])
            self.assertTrue(output.is_file())
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertTrue(saved["writes"]["result_file"]["written"])

            connection = sqlite3.connect(database)
            batch = connection.execute("SELECT status,item_count FROM recommendation_batches").fetchone()
            published = connection.execute("SELECT COUNT(*) FROM recommendation_batches WHERE status='published'").fetchone()[0]
            version = connection.execute("SELECT status FROM dataset_versions").fetchone()[0]
            connection.close()
            self.assertEqual(batch, ("staging", 8))
            self.assertEqual(published, 0)
            self.assertEqual(version, "staging")

    def test_missing_current_sources_rejects_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "aster.db"
            empty_source = root / "empty_source"
            empty_source.mkdir()
            _task_database(database)
            result = run_heat_recommendation_task(
                database_path=database,
                source8002_data_dir=empty_source,
                as_of="2026-08-20",
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "rejected")
            self.assertEqual(result["result"]["items"], [])
            self.assertTrue(any("five-platform" in failure for failure in result["gate"]["failures"]))

    def test_current_sentiment_filename_with_old_report_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "aster.db"
            source = root / "source8002_data"
            _task_database(database)
            _task_source_root(source)
            sentiment = source / "sentiment_market" / "stock-top10-2026-08-20.json"
            payload = json.loads(sentiment.read_text(encoding="utf-8"))
            payload[0]["report"]["period_end"] = "2026-08-19T15:00:00+08:00"
            sentiment.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            result = run_heat_recommendation_task(
                database_path=database,
                source8002_data_dir=source,
                as_of="2026-08-20",
            )
            self.assertFalse(result["ok"])
            self.assertTrue(any("Taoguba" in failure for failure in result["gate"]["failures"]))

    def test_old_platform_source_date_does_not_count_as_same_day(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "aster.db"
            source = root / "source8002_data"
            _task_database(database)
            _task_source_root(source)
            hot = source / "hot_stock_rankings" / "2026-08-20.json"
            payload = json.loads(hot.read_text(encoding="utf-8"))
            payload["platforms"][2]["source_date"] = "2026-08-19"
            hot.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            result = run_heat_recommendation_task(
                database_path=database,
                source8002_data_dir=source,
                as_of="2026-08-20",
            )
            self.assertFalse(result["ok"])
            self.assertTrue(any("success count" in failure for failure in result["gate"]["failures"]))

    def test_local_policy_rebuilds_missing_sources_and_runs_strict_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "aster.db"
            empty_source = root / "empty_source"
            empty_cache = root / "empty_cache"
            empty_source.mkdir()
            empty_cache.mkdir()
            _task_database(database)
            result = run_heat_recommendation_task(
                database_path=database,
                source8002_data_dir=empty_source,
                source8002_cache_dir=empty_cache,
                as_of="2026-08-20",
                mode="strict",
                source_policy="local",
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "ready")
            self.assertEqual(len(result["result"]["items"]), 8)
            self.assertTrue(all(row["hit_agent_count"] >= 2 for row in result["result"]["items"]))
            self.assertTrue(all("65%" in row["score_formula"] for row in result["result"]["items"]))
            fallback_sources = [item["key"] for item in result["sources"] if item.get("details", {}).get("local_fallback")]
            self.assertEqual(fallback_sources, ["five_platform_heat", "taoguba_sentiment", "original_8002_ex_size"])


if __name__ == "__main__":
    unittest.main()
