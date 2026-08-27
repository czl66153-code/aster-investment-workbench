"""Repair historical hand/share contamination in Aster intraday stores.

Dry-run is the default.  ``--apply`` requires a caller-created backup
directory and writes the exact pre-repair rows there before either database is
changed.  The deterministic signature is amount / (volume * close): canonical
share/CNY rows cluster around 1, while the affected hand/CNY rows cluster
around 100 and therefore need volume multiplied by 100.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import duckdb


UNIT_VERSION = "aster_intraday_units_v1"
REPAIR_VERSION = "aster_intraday_unit_repair_v1"
CANONICAL_MIN = 0.2
CANONICAL_MAX = 5.0
HAND_MIN = 20.0
HAND_MAX = 200.0


def _json_default(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _sqlite_bad_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """SELECT * FROM bars_30m
           WHERE volume>0 AND amount>0 AND close>0
             AND amount/(volume*close)>=? AND amount/(volume*close)<=?
           ORDER BY trade_time,code""",
        (HAND_MIN, HAND_MAX),
    ).fetchall()
    return [dict(row) for row in rows]


def _write_json_gz(path: Path, rows: list[dict[str, Any]]) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False, default=_json_default)


def _duck_columns(connection: duckdb.DuckDBPyConnection, table: str) -> set[str]:
    return {str(row[0]) for row in connection.execute(f"DESCRIBE {table}").fetchall()}


def _ratio_predicate(price: str, volume: str, amount: str) -> str:
    return f"{volume}>0 AND {amount}>0 AND {price}>0"


def inspect(sqlite_path: Path, duckdb_path: Path) -> dict[str, Any]:
    sqlite_connection = sqlite3.connect(sqlite_path)
    try:
        sqlite_bad = len(_sqlite_bad_rows(sqlite_connection))
        sqlite_ambiguous = int(sqlite_connection.execute(
            """SELECT COUNT(*) FROM bars_30m WHERE volume>0 AND amount>0 AND close>0
               AND (amount/(volume*close)<? OR (amount/(volume*close)>? AND amount/(volume*close)<?) OR amount/(volume*close)>?)""",
            (CANONICAL_MIN, CANONICAL_MAX, HAND_MIN, HAND_MAX),
        ).fetchone()[0])
    finally:
        sqlite_connection.close()
    duck = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        result: dict[str, Any] = {"sqlite_bars_30m_hand_rows": sqlite_bad, "sqlite_bars_30m_ambiguous_rows": sqlite_ambiguous}
        for table, price, volume, amount in (
            ("realtime_market_snapshot", "latest", "cum_volume", "cum_amount"),
            ("realtime_bar5m", "close", "volume", "amount"),
        ):
            eligible = _ratio_predicate(price, volume, amount)
            hand, ambiguous = duck.execute(
                f"""SELECT
                    SUM(CASE WHEN {eligible} AND {amount}/({volume}*{price}) BETWEEN ? AND ? THEN 1 ELSE 0 END),
                    SUM(CASE WHEN {eligible} AND ({amount}/({volume}*{price})<? OR ({amount}/({volume}*{price})>? AND {amount}/({volume}*{price})<?) OR {amount}/({volume}*{price})>?) THEN 1 ELSE 0 END)
                    FROM {table}""",
                [HAND_MIN, HAND_MAX, CANONICAL_MIN, CANONICAL_MAX, HAND_MIN, HAND_MAX],
            ).fetchone()
            result[f"{table}_hand_rows"] = int(hand or 0)
            result[f"{table}_ambiguous_rows"] = int(ambiguous or 0)
        return result
    finally:
        duck.close()


def repair_sqlite(sqlite_path: Path, backup_dir: Path, run_id: str) -> dict[str, Any]:
    connection = sqlite3.connect(sqlite_path, timeout=60)
    try:
        bad_rows = _sqlite_bad_rows(connection)
        _write_json_gz(backup_dir / "sqlite_bars_30m_pre_repair.json.gz", bad_rows)
        connection.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(bars_30m)")}
        for name in ("unit_version", "volume_unit", "amount_unit", "unit_repair_note"):
            if name not in columns:
                connection.execute(f"ALTER TABLE bars_30m ADD COLUMN {name} TEXT")
        repaired = connection.execute(
            """UPDATE bars_30m SET volume=volume*100,
                 unit_version=?,volume_unit='share',amount_unit='CNY',unit_repair_note=?
               WHERE volume>0 AND amount>0 AND close>0
                 AND amount/(volume*close)>=? AND amount/(volume*close)<=?""",
            (UNIT_VERSION, f"{REPAIR_VERSION}:{run_id}:hand_to_share_x100", HAND_MIN, HAND_MAX),
        ).rowcount
        connection.execute(
            """UPDATE bars_30m SET unit_version=?,volume_unit='share',amount_unit='CNY'
               WHERE lower(COALESCE(source,'')) LIKE 'akshare%'
                 AND (volume IS NULL OR amount IS NULL OR volume=0 OR amount=0 OR close<=0
                      OR amount/(volume*close) BETWEEN ? AND ?)""",
            (UNIT_VERSION, CANONICAL_MIN, CANONICAL_MAX),
        )
        remaining = int(connection.execute(
            """SELECT COUNT(*) FROM bars_30m WHERE volume>0 AND amount>0 AND close>0
               AND (amount/(volume*close)<? OR amount/(volume*close)>?)""",
            (CANONICAL_MIN, CANONICAL_MAX),
        ).fetchone()[0])
        if remaining:
            raise RuntimeError(f"SQLite bars_30m still has {remaining} invalid unit rows")
        connection.commit()
        return {"repaired": int(repaired), "remaining_invalid": remaining}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _escaped(path: Path) -> str:
    return str(path.resolve()).replace("'", "''")


def repair_duckdb(duckdb_path: Path, backup_dir: Path, run_id: str) -> dict[str, Any]:
    connection = duckdb.connect(str(duckdb_path))
    results: dict[str, Any] = {}
    try:
        connection.execute("BEGIN TRANSACTION")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS intraday_unit_repair_audit(
                 run_id VARCHAR PRIMARY KEY,repair_version VARCHAR,started_at TIMESTAMP,finished_at TIMESTAMP,
                 snapshot_rows BIGINT,bar_rows BIGINT,quarantined_rows BIGINT,status VARCHAR,details_json VARCHAR)"""
        )
        for table in ("realtime_market_snapshot", "realtime_bar5m"):
            for name in ("unit_version", "volume_unit", "amount_unit", "unit_repair_note"):
                if name not in _duck_columns(connection, table):
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} VARCHAR")

        snapshot_predicate = f"cum_volume>0 AND cum_amount>0 AND latest>0 AND cum_amount/(cum_volume*latest) BETWEEN {HAND_MIN} AND {HAND_MAX}"
        bar_predicate = f"volume>0 AND amount>0 AND close>0 AND amount/(volume*close) BETWEEN {HAND_MIN} AND {HAND_MAX}"
        ambiguous_bar = (
            f"volume>0 AND amount>0 AND close>0 AND (amount/(volume*close)<{CANONICAL_MIN} "
            f"OR (amount/(volume*close)>{CANONICAL_MAX} AND amount/(volume*close)<{HAND_MIN}) "
            f"OR amount/(volume*close)>{HAND_MAX})"
        )
        connection.execute(
            f"COPY (SELECT * FROM realtime_market_snapshot WHERE {snapshot_predicate}) TO '{_escaped(backup_dir / 'duck_snapshot_pre_repair.parquet')}' (FORMAT PARQUET)"
        )
        connection.execute(
            f"COPY (SELECT * FROM realtime_bar5m WHERE {bar_predicate} OR {ambiguous_bar}) TO '{_escaped(backup_dir / 'duck_bar5m_pre_repair.parquet')}' (FORMAT PARQUET)"
        )
        snapshot_rows = int(connection.execute(f"SELECT COUNT(*) FROM realtime_market_snapshot WHERE {snapshot_predicate}").fetchone()[0])
        bar_rows = int(connection.execute(f"SELECT COUNT(*) FROM realtime_bar5m WHERE {bar_predicate}").fetchone()[0])
        quarantined = int(connection.execute(f"SELECT COUNT(*) FROM realtime_bar5m WHERE {ambiguous_bar}").fetchone()[0])
        connection.execute(
            f"""UPDATE realtime_market_snapshot SET cum_volume=cum_volume*100,
                   unit_version=?,volume_unit='share',amount_unit='CNY',unit_repair_note=?
                 WHERE {snapshot_predicate}""",
            [UNIT_VERSION, f"{REPAIR_VERSION}:{run_id}:hand_to_share_x100"],
        )
        connection.execute(
            f"""UPDATE realtime_bar5m SET volume=volume*100,
                   unit_version=?,volume_unit='share',amount_unit='CNY',unit_repair_note=?
                 WHERE {bar_predicate}""",
            [UNIT_VERSION, f"{REPAIR_VERSION}:{run_id}:hand_to_share_x100"],
        )
        # An impossible low-liquidity row cannot be safely inferred.  It is
        # preserved in the Parquet quarantine above and excluded from signals.
        connection.execute(f"DELETE FROM realtime_bar5m WHERE {ambiguous_bar}")
        for table, price, volume, amount in (
            ("realtime_market_snapshot", "latest", "cum_volume", "cum_amount"),
            ("realtime_bar5m", "close", "volume", "amount"),
        ):
            connection.execute(
                f"""UPDATE {table} SET unit_version=?,volume_unit='share',amount_unit='CNY'
                    WHERE lower(COALESCE(data_source,'')) LIKE 'akshare%'
                      AND ({volume} IS NULL OR {amount} IS NULL OR {volume}=0 OR {amount}=0 OR {price}<=0
                           OR {amount}/({volume}*{price}) BETWEEN ? AND ?)""",
                [UNIT_VERSION, CANONICAL_MIN, CANONICAL_MAX],
            )
            remaining = int(connection.execute(
                f"""SELECT COUNT(*) FROM {table} WHERE {volume}>0 AND {amount}>0 AND {price}>0
                    AND ({amount}/({volume}*{price})<? OR {amount}/({volume}*{price})>?)""",
                [CANONICAL_MIN, CANONICAL_MAX],
            ).fetchone()[0])
            if remaining:
                raise RuntimeError(f"{table} still has {remaining} invalid unit rows")
            results[f"{table}_remaining_invalid"] = remaining
        finished = datetime.now(timezone.utc).isoformat()
        details = {"snapshot_rows": snapshot_rows, "bar_rows": bar_rows, "quarantined_rows": quarantined}
        connection.execute(
            "INSERT INTO intraday_unit_repair_audit VALUES(?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?)",
            [run_id, REPAIR_VERSION, finished, snapshot_rows, bar_rows, quarantined, "success", json.dumps(details)],
        )
        connection.execute("COMMIT")
        return {**results, **details}
    except Exception:
        connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--duckdb", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    before = inspect(args.sqlite, args.duckdb)
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "before": before}, ensure_ascii=False))
        return 0
    if args.backup_dir is None:
        raise SystemExit("--backup-dir is required with --apply")
    args.backup_dir.mkdir(parents=True, exist_ok=True)
    run_id = uuid4().hex
    sqlite_result = repair_sqlite(args.sqlite, args.backup_dir, run_id)
    duck_result = repair_duckdb(args.duckdb, args.backup_dir, run_id)
    after = inspect(args.sqlite, args.duckdb)
    manifest = {
        "run_id": run_id, "repair_version": REPAIR_VERSION,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "before": before, "sqlite": sqlite_result, "duckdb": duck_result, "after": after,
    }
    (args.backup_dir / "repair_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
