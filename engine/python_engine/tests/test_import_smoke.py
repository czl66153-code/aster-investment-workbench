from __future__ import annotations

import unittest
import sqlite3
import tempfile
from pathlib import Path

import aia_engine
from aia_engine.m30 import calibrate_with_template, evaluate_m30_core, load_template_profile
from aia_engine.sources import resolve_refresh_failure, source_plan
from aia_engine.aster_top10 import _accepted_sources, _completed_daily_cutoff, _parse_sqlite_utc, _signal_at, _write_staging
from aia_engine.tasks import _smoke_bars, _smoke_candidates, run_smoke


class IndependentAiaSmokeTest(unittest.TestCase):
    def test_public_package_import_and_assets(self) -> None:
        self.assertEqual(aia_engine.__version__, "0.1.0")
        self.assertTrue(aia_engine.validate_assets()["ok"])

    def test_m30_matches_locked_legacy_oracle(self) -> None:
        # Values were produced by the original 8000 module for the same fixture.
        result = evaluate_m30_core(_smoke_bars())
        self.assertEqual(result["rule_status"], "pass")
        self.assertTrue(result["hit"])
        self.assertEqual(result["score"], 0.854031)
        self.assertEqual(result["rejection_reasons"], [])
        self.assertEqual(
            result["component_scores"],
            {"platform": 1.0, "ma20_turn": 0.84348, "breakout": 0.658116, "anti_chase": 0.743587, "volume": 1.0},
        )
        self.assertEqual(result["volume_baseline_kind"], "platform_median")
        self.assertEqual(result["ma20_slope_3"], 0.002535)

    def test_template_never_promotes_a_core_miss(self) -> None:
        result = calibrate_with_template(0.71, False, [10 + index / 100 for index in range(40)], load_template_profile())
        self.assertFalse(result["hit"])
        self.assertTrue(result["preserved_core_hit"])

    def test_top10_exact_count_gate(self) -> None:
        ready = aia_engine.rank_top10(_smoke_candidates())
        self.assertTrue(ready["publishable"])
        self.assertEqual(len(ready["items"]), 10)
        # Locked legacy weight-config oracle: 91.5 weighted + two-hit bonus 3.
        self.assertEqual(ready["items"][0]["weighted_score"], 91.5)
        self.assertEqual(ready["items"][0]["score"], 94.5)
        self.assertEqual(ready["items"][0]["evidence_coverage"], 1.0)
        blocked = aia_engine.rank_top10(_smoke_candidates()[:9])
        self.assertFalse(blocked["publishable"])
        self.assertEqual(blocked["reason"], "exactly_ten_qualified_required")

    def test_intraday_policy_is_akshare_only(self) -> None:
        plan = source_plan("intraday")
        self.assertEqual(plan["bar_sources"], ["akshare"])
        self.assertIn("no_tencent_fallback", plan["rule"])
        self.assertEqual(plan["failure_mode"], "stale_last_published_only")
        stale = resolve_refresh_failure(session="intraday", last_published={"batch_id": "previous"}, error="akshare_timeout")
        self.assertEqual(stale["batch_id"], "previous")
        self.assertEqual(stale["status"], "stale")

    def test_combined_smoke(self) -> None:
        self.assertTrue(run_smoke()["ok"])

    def test_aster_source_and_point_in_time_gates(self) -> None:
        from datetime import datetime, timedelta, timezone

        shanghai = timezone(timedelta(hours=8))
        self.assertTrue(_accepted_sources(["akshare:eastmoney"], ("akshare",)))
        self.assertFalse(_accepted_sources(["tencent_direct"], ("akshare",)))
        self.assertEqual(_completed_daily_cutoff("2026-08-20", datetime(2026, 8, 20, 8, 30, tzinfo=shanghai)), "2026-08-19")

    def test_sqlite_current_timestamp_is_converted_from_utc(self) -> None:
        converted = _parse_sqlite_utc("2026-08-24 01:18:00")
        self.assertEqual(converted.isoformat(), "2026-08-24T09:18:00+08:00")
        inferred = _signal_at([{"updated_at": "2026-08-24 01:18:00"}], None)
        self.assertEqual(inferred.isoformat(), "2026-08-24T09:18:00+08:00")

    def test_staging_write_never_replaces_published(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.db"
            connection = sqlite3.connect(path)
            connection.executescript(
                """
                CREATE TABLE recommendation_batches(batch_id TEXT PRIMARY KEY,model_key TEXT,trade_date TEXT,status TEXT,trigger_type TEXT,source_mode TEXT,item_count INTEGER,model_version TEXT,message TEXT,started_at TEXT,finished_at TEXT);
                CREATE TABLE recommendations(batch_id TEXT,model_key TEXT,trade_date TEXT,code TEXT,rank INTEGER,score REAL,reason TEXT,risk TEXT,confidence REAL,payload_json TEXT,generated_at TEXT,PRIMARY KEY(batch_id,code));
                CREATE TABLE dataset_versions(dataset_key TEXT,version_id TEXT,trade_date TEXT,row_count INTEGER,checksum TEXT,status TEXT,source TEXT,quality_score REAL,created_at TEXT,published_at TEXT,PRIMARY KEY(dataset_key,version_id));
                INSERT INTO dataset_versions VALUES('recommendation_aia','published-v1','2026-08-20',10,'old','published','fixture',100,'2026-08-20','2026-08-20');
                """
            )
            items = [{"symbol": f"600{index:03d}.SH", "rank": index + 1, "score": 80 - index, "pattern_hits": ["daily"], "risk": "ok", "evidence_coverage": 1.0} for index in range(10)]
            result = _write_staging(connection, {"trade_date": "2026-08-20", "top10": items, "ranking": {"config_version": "test"}})
            self.assertTrue(result["written"])
            self.assertFalse(result["published_replaced"])
            published = connection.execute("SELECT status FROM dataset_versions WHERE version_id='published-v1'").fetchone()
            self.assertEqual(published[0], "published")
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM dataset_versions WHERE status='staging'").fetchone()[0], 1)
            connection.close()


if __name__ == "__main__":
    unittest.main()
