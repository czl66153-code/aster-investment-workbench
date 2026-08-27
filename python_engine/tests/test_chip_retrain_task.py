from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from python_engine import chip_retrain_task


class ChipRetrainRegistryIsolationTests(unittest.TestCase):
    def test_negative_labels_are_preserved_and_multi_period_is_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "aster.db"
            data = root / "data"
            data.mkdir()
            connection = sqlite3.connect(database)
            try:
                connection.executescript(
                    """
                    CREATE TABLE model_registry (
                      scope TEXT PRIMARY KEY,
                      revision INTEGER,
                      applied_revision INTEGER,
                      pending_retrain INTEGER
                    );
                    CREATE TABLE chip_samples (
                      sample_id TEXT PRIMARY KEY,
                      scope TEXT,
                      sample_label INTEGER,
                      code TEXT,
                      trade_date TEXT,
                      name TEXT,
                      reason TEXT,
                      source TEXT,
                      created_at TEXT,
                      updated_at TEXT
                    );
                    CREATE TABLE experimental_chip_samples (
                      sample_id TEXT PRIMARY KEY,
                      scope TEXT,
                      sample_label INTEGER,
                      code TEXT,
                      trade_date TEXT,
                      name TEXT
                    );
                    INSERT INTO model_registry VALUES('formal',2,1,1);
                    INSERT INTO model_registry VALUES('candidate',3,1,1);
                    INSERT INTO chip_samples VALUES(
                      'formal-negative','formal',0,'000001.SZ','2026-08-24',
                      '平安银行','正式反例','independent_ui','2026-08-25','2026-08-25'
                    );
                    INSERT INTO chip_samples VALUES(
                      'candidate-negative','candidate',0,'000002.SZ','2026-08-24',
                      '万科A','候选反例','independent_ui','2026-08-25','2026-08-25'
                    );
                    INSERT INTO experimental_chip_samples VALUES(
                      'multi-period-only','multi_period',1,'000003.SZ','2026-08-24','测试股票'
                    );
                    """
                )
                connection.commit()
            finally:
                connection.close()

            with patch.object(chip_retrain_task, "DATA", data):
                registry = chip_retrain_task._sync_registry(database)

            payload = json.loads(
                (data / "chip_shape_model_positive_samples.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(set(payload["scopes"]), {"formal", "candidate"})
            self.assertEqual(registry["formal"]["samples"], 1)
            self.assertEqual(registry["candidate"]["samples"], 1)
            for scope in ("formal", "candidate"):
                sample = payload["scopes"][scope]["samples"][0]
                self.assertEqual(sample["label"], 0)
                self.assertEqual(sample["source"], "aster_reviewed_negative")
            self.assertNotIn("multi_period", payload["scopes"])
            self.assertNotIn("multi-period-only", json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
