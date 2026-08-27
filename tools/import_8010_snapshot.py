"""One-time, audited import of a complete 8010 AkShare closing snapshot.

This is a migration tool, not a runtime dependency.  It copies only the
requested trade date from the legacy DuckDB into Aster's independent DuckDB,
then registers the same snapshot in Aster SQLite.  It never reads credentials
and never marks AkShare data as BigQuant/Tushare official data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import duckdb


DATE_TABLES = {
    "realtime_market_snapshot": "trade_date = ?",
    "realtime_bar5m": "trade_date = ?",
    "realtime_chip_factor_cache": "trade_date = ?",
    "abcd_heat_snapshot": "CAST(snapshot_bucket AS DATE) = ?",
    "abcd_recommendation_event": "recommendation_date = ?",
    "abcd_recommendation_memory": "memory_date = ?",
}


OBSERVATION_SEED_SQL = """
WITH latest_daily AS (SELECT max(trade_date) AS trade_date FROM legacy.factor_daily),
latest_chip AS (SELECT max(trade_date) AS trade_date FROM legacy.current_chip_factor_daily),
recent_dates AS (
    SELECT DISTINCT trade_date FROM legacy.factor_daily
    WHERE trade_date <= (SELECT trade_date FROM latest_daily)
    ORDER BY trade_date DESC LIMIT 5
),
stock_ret4 AS (
    SELECT trade_date, ts_code, industry,
           close / nullif(lag(close, 4) OVER (PARTITION BY ts_code ORDER BY trade_date), 0) - 1 AS ret4
    FROM legacy.factor_daily WHERE trade_date IN (SELECT trade_date FROM recent_dates)
),
industry_ret4 AS (
    SELECT industry, median(ret4) AS industry_ret_4d
    FROM stock_ret4
    WHERE trade_date = (SELECT trade_date FROM latest_daily) AND ret4 IS NOT NULL
    GROUP BY industry
),
industry_heat AS (
    SELECT industry,
           row_number() OVER (ORDER BY total_amount DESC NULLS LAST, industry) AS industry_heat_rank
    FROM legacy.industry_daily
    WHERE trade_date = (SELECT trade_date FROM latest_daily)
),
chips AS (
    SELECT c.*,
           row_number() OVER (ORDER BY chip_density_70 DESC NULLS LAST, ts_code) AS chip_rank,
           100.0 * row_number() OVER (ORDER BY chip_density_70 DESC NULLS LAST, ts_code)
             / nullif(count(*) OVER (), 0) AS chip_rank_pct,
           row_number() OVER (ORDER BY avg_window_density_4pct DESC NULLS LAST, ts_code) AS chip_window_rank,
           100.0 * row_number() OVER (ORDER BY avg_window_density_4pct DESC NULLS LAST, ts_code)
             / nullif(count(*) OVER (), 0) AS chip_window_rank_pct,
           row_number() OVER (ORDER BY avg_window_density_10pct DESC NULLS LAST, ts_code) AS chip_large_window_rank,
           100.0 * row_number() OVER (ORDER BY avg_window_density_10pct DESC NULLS LAST, ts_code)
             / nullif(count(*) OVER (), 0) AS chip_large_window_rank_pct
    FROM legacy.current_chip_factor_daily c
    WHERE trade_date = (SELECT trade_date FROM latest_chip)
)
SELECT
    f.trade_date,
    f.ts_code,
    coalesce(s.name, f.name) AS name,
    coalesce(s.industry, f.industry) AS industry,
    f.close,
    f.pct_chg,
    d.vol,
    f.amount,
    f.turnover_rate,
    f.ret_5d,
    f.ret_20d,
    f.ret_60d,
    f.ret_63d,
    f.volume_ratio_20,
    f.amount_ratio_20,
    f.turnover_ratio_20,
    f.rsi14,
    f.drawdown_20,
    f.volatility_20,
    f.breakout_20,
    f.low_60d,
    ir.industry_ret_4d,
    ih.industry_heat_rank,
    c.trade_date AS chip_date,
    c.chip_density_70,
    c.chip_rank,
    c.chip_rank_pct,
    c.avg_window_density_4pct,
    c.avg_window_density_4pct_end,
    c.avg_window_density_10pct,
    c.chip_window_rank,
    c.chip_window_rank_pct,
    c.chip_large_window_rank,
    c.chip_large_window_rank_pct,
    c.chip_peak2_ratio,
    c.chip_peak_width_70,
    c.chip_profit_ratio_calc,
    c.chip_peak_balance_score,
    c.chip_main_peak_price,
    c.chip_template_score,
    c.new_chip_factor
FROM legacy.factor_daily f
JOIN latest_daily ld ON ld.trade_date = f.trade_date
LEFT JOIN legacy.daily_bar d ON d.ts_code = f.ts_code AND d.trade_date = f.trade_date
LEFT JOIN legacy.security_master s ON s.ts_code = f.ts_code
LEFT JOIN industry_ret4 ir ON ir.industry = coalesce(s.industry, f.industry)
LEFT JOIN industry_heat ih ON ih.industry = coalesce(s.industry, f.industry)
LEFT JOIN chips c ON c.ts_code = f.ts_code
"""


def _columns(connection: duckdb.DuckDBPyConnection, schema: str, table: str) -> list[str]:
    if schema not in {"main", "legacy"} or table not in {"security_master", *DATE_TABLES}:
        raise ValueError("unexpected schema inspection target")
    return [row[0] for row in connection.execute(f"DESCRIBE {schema}.{table}").fetchall()]


def _validate(connection: duckdb.DuckDBPyConnection, trade_date: str) -> dict[str, object]:
    master_count = int(connection.execute("SELECT count(*) FROM legacy.security_master").fetchone()[0])
    eligible_master = int(connection.execute(
        """SELECT count(*) FROM legacy.security_master
           WHERE (delist_date IS NULL OR delist_date>?)
             AND (list_date IS NULL OR list_date<=?)
             AND right(ts_code,2) IN ('SH','SZ')""",
        [trade_date, trade_date],
    ).fetchone()[0])
    snapshot = connection.execute(
        """
        SELECT count(*) AS rows,
               count(DISTINCT instrument) AS instruments,
               count(*) FILTER (WHERE latest IS NULL OR cum_volume IS NULL OR cum_amount IS NULL) AS missing,
               min(observed_at)::VARCHAR,max(observed_at)::VARCHAR,
               string_agg(DISTINCT data_source, ',')
        FROM legacy.realtime_market_snapshot WHERE trade_date=?
        """,
        [trade_date],
    ).fetchone()
    daily = connection.execute(
        """
        SELECT count(*) AS rows,
               count(*) FILTER (WHERE open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL OR vol IS NULL OR amount IS NULL) AS missing,
               string_agg(DISTINCT data_source, ',')
        FROM legacy.current_daily_bar WHERE trade_date=?
        """,
        [trade_date],
    ).fetchone()
    bar5m = connection.execute(
        """
        SELECT count(*) AS rows,count(DISTINCT instrument) AS instruments,
               count(*) FILTER (WHERE open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL OR volume IS NULL OR amount IS NULL) AS missing,
               max(trade_time)::VARCHAR,string_agg(DISTINCT data_source, ',')
        FROM legacy.realtime_bar5m WHERE trade_date=?
        """,
        [trade_date],
    ).fetchone()
    chip = connection.execute(
        """
        WITH latest AS (
          SELECT max(factor_time) AS factor_time
          FROM legacy.realtime_chip_factor_cache WHERE trade_date=?
        )
        SELECT latest.factor_time::VARCHAR,count(cache.ts_code),
               count(*) FILTER (WHERE cache.payload_json IS NULL OR cache.payload_json=''),
               string_agg(DISTINCT cache.chip_peak_model_version, ','),
               string_agg(DISTINCT cache.shape_score_version, ',')
        FROM latest LEFT JOIN legacy.realtime_chip_factor_cache cache
          ON cache.factor_time=latest.factor_time
        GROUP BY latest.factor_time
        """,
        [trade_date],
    ).fetchone()
    minimum = max(1, math.ceil(eligible_master * 0.95))
    sources = f"{snapshot[5] or ''},{daily[2] or ''},{bar5m[4] or ''}".lower()
    failures: list[str] = []
    if int(snapshot[1] or 0) < minimum or int(snapshot[2] or 0):
        failures.append(f"行情快照{snapshot[1]}/{master_count}，缺失{snapshot[2]}，要求至少{minimum}且零缺失")
    if int(daily[0] or 0) < minimum or int(daily[1] or 0):
        failures.append(f"日内OHLCV{daily[0]}/{master_count}，缺失{daily[1]}，要求至少{minimum}且零缺失")
    if int(bar5m[1] or 0) < minimum or int(bar5m[2] or 0):
        failures.append(f"5分钟线覆盖{bar5m[1]}/{master_count}，缺失{bar5m[2]}")
    if int(chip[1] or 0) < minimum or int(chip[2] or 0):
        failures.append(f"最新筹码截面{chip[1]}/{master_count}，空载荷{chip[2]}")
    if "akshare" not in sources or "tencent" in sources:
        failures.append(f"来源门禁失败：{sources}")
    if not str(snapshot[4] or "").startswith(trade_date) or str(snapshot[4] or "")[11:16] < "14:55":
        failures.append(f"收盘时点不足：{snapshot[4]}")
    return {
        "pass": not failures,
        "failures": failures,
        "master_count": master_count,
        "eligible_master": eligible_master,
        "minimum": minimum,
        "snapshot": {"rows": snapshot[0], "instruments": snapshot[1], "missing": snapshot[2], "first": snapshot[3], "last": snapshot[4], "sources": snapshot[5]},
        "current_daily": {"rows": daily[0], "missing": daily[1], "sources": daily[2]},
        "bar5m": {"rows": bar5m[0], "instruments": bar5m[1], "missing": bar5m[2], "last": bar5m[3], "sources": bar5m[4]},
        "chip": {"factor_time": chip[0], "rows": chip[1], "empty_payloads": chip[2], "peak_model": chip[3], "shape_model": chip[4]},
    }


def _checksum(rows: list[tuple[object, ...]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(json.dumps(row, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def _register_sqlite(aster_db: Path, duck: duckdb.DuckDBPyConnection, trade_date: str, gate: dict[str, object], checksum: str) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    securities = duck.execute("SELECT ts_code,symbol,name,market,coalesce(industry,'其他') FROM legacy.security_master ORDER BY ts_code").fetchall()
    quotes = duck.execute(
        """
        SELECT d.ts_code,s.name,d.close,d.pre_close,d.pct_chg,d.amount,
               snapshot.observed_at::VARCHAR,d.data_source
        FROM legacy.current_daily_bar d
        JOIN legacy.security_master s USING(ts_code)
        LEFT JOIN legacy.realtime_market_snapshot snapshot
          ON snapshot.instrument=d.ts_code AND snapshot.trade_date=d.trade_date
        WHERE d.trade_date=? ORDER BY d.ts_code
        """,
        [trade_date],
    ).fetchall()
    connection = sqlite3.connect(aster_db, timeout=60)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.executemany(
            """INSERT INTO securities(code,symbol,name,market,industry,updated_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(code) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,market=excluded.market,industry=excluded.industry,updated_at=excluded.updated_at""",
            [(*row, now) for row in securities],
        )
        connection.executemany(
            """INSERT INTO realtime_quotes(code,name,price,prev_close,pct_chg,amount,turnover_rate,quote_time,source,received_at)
               VALUES(?,?,?,?,?,?,NULL,?,?,?)
               ON CONFLICT(code) DO UPDATE SET name=excluded.name,price=excluded.price,prev_close=excluded.prev_close,pct_chg=excluded.pct_chg,amount=excluded.amount,turnover_rate=NULL,quote_time=excluded.quote_time,source=excluded.source,received_at=excluded.received_at""",
            [(*row, now) for row in quotes],
        )
        version_id = f"intraday-8010-snapshot-{trade_date}-{checksum[:12]}"
        connection.execute("UPDATE dataset_versions SET status='superseded' WHERE dataset_key='intraday_quotes' AND status='published'")
        connection.execute(
            """INSERT OR REPLACE INTO dataset_versions(dataset_key,version_id,trade_date,row_count,checksum,status,source,quality_score,created_at,published_at)
               VALUES('intraday_quotes',?,?,?,?, 'published','akshare_closing_snapshot:one_time_8010_migration',100,?,?)""",
            [version_id, trade_date, len(quotes), checksum, now, now],
        )
        row = connection.execute("SELECT value FROM metadata WHERE key='market_data_state'").fetchone()
        try:
            state = json.loads(row[0]) if row else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            state = {}
        state.update({
            "mode": "intraday",
            "modeLabel": "AKShare 8月21日收盘快照（一次性迁移）",
            "quoteTradeDate": trade_date,
            "quoteAsOf": gate["snapshot"]["last"],
            "updatedAt": now,
            "coverage": {"received": len(quotes), "expected": int(gate["eligible_master"]), "ratio": len(quotes) / int(gate["eligible_master"])},
            "source": "akshare_closing_snapshot:one_time_8010_migration",
            "migration": {"from": "8010 local DuckDB", "tradeDate": trade_date, "checksum": checksum, "importedAt": now, "runtimeDependency": False},
        })
        connection.execute(
            "INSERT INTO metadata(key,value,updated_at) VALUES('market_data_state',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            [json.dumps(state, ensure_ascii=False)],
        )
        connection.execute(
            "INSERT INTO metadata(key,value,updated_at) VALUES('legacy_8010_updates_disabled','true',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=CURRENT_TIMESTAMP"
        )
        connection.execute(
            """INSERT INTO sync_jobs(job_id,job_type,status,source,rows_changed,message,started_at,finished_at)
               VALUES(?, 'one_time_8010_snapshot_import','success','local_duckdb_snapshot',?, ?, ?, ?)""",
            [str(uuid.uuid4()), len(quotes), f"{trade_date} AKShare收盘快照已通过95%门禁并独立物化；不标记为正式日线", now, now],
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def run(source: Path, target: Path, aster_db: Path, trade_date: str, manifest: Path, dry_run: bool) -> dict[str, object]:
    if source.resolve() == target.resolve():
        raise ValueError("source and target databases must differ")
    connection = duckdb.connect(str(target))
    try:
        escaped_source = str(source).replace("'", "''")
        connection.execute(f"ATTACH '{escaped_source}' AS legacy (READ_ONLY)")
        for table in ["security_master", *DATE_TABLES]:
            if _columns(connection, "main", table) != _columns(connection, "legacy", table):
                raise RuntimeError(f"schema mismatch for {table}")
        gate = _validate(connection, trade_date)
        if not gate["pass"]:
            raise RuntimeError("; ".join(gate["failures"]))
        checksum_rows = connection.execute(
            "SELECT instrument,latest,cum_volume,cum_amount,observed_at FROM legacy.realtime_market_snapshot WHERE trade_date=? ORDER BY instrument",
            [trade_date],
        ).fetchall()
        checksum = _checksum(checksum_rows)
        copied: dict[str, int] = {}
        if not dry_run:
            connection.execute("BEGIN")
            try:
                connection.execute("DELETE FROM main.security_master")
                connection.execute("INSERT INTO main.security_master SELECT * FROM legacy.security_master")
                copied["security_master"] = int(connection.execute("SELECT count(*) FROM main.security_master").fetchone()[0])
                for table, condition in DATE_TABLES.items():
                    connection.execute(f"DELETE FROM main.{table} WHERE {condition}", [trade_date])
                    connection.execute(f"INSERT INTO main.{table} SELECT * FROM legacy.{table} WHERE {condition}", [trade_date])
                    copied[table] = int(connection.execute(f"SELECT count(*) FROM main.{table} WHERE {condition}", [trade_date]).fetchone()[0])
                connection.execute(
                    "CREATE OR REPLACE TABLE main.legacy_8010_observation_seed AS "
                    + OBSERVATION_SEED_SQL
                )
                copied["legacy_8010_observation_seed"] = int(
                    connection.execute("SELECT count(*) FROM main.legacy_8010_observation_seed").fetchone()[0]
                )
                if copied["legacy_8010_observation_seed"] < int(gate["minimum"]):
                    raise RuntimeError(
                        f"8010观察池种子仅{copied['legacy_8010_observation_seed']}行，低于门禁{gate['minimum']}"
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
            _register_sqlite(aster_db, connection, trade_date, gate, checksum)
        result = {
            "ok": True,
            "status": "dry_run" if dry_run else "imported",
            "trade_date": trade_date,
            "source_kind": "akshare_closing_snapshot",
            "official_daily": False,
            "runtime_dependency": False,
            "gate": gate,
            "checksum": checksum,
            "copied": copied,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        if not dry_run:
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return result
    finally:
        connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--aster-db", type=Path, required=True)
    parser.add_argument("--trade-date", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.source, args.target, args.aster_db, args.trade_date, args.manifest, args.dry_run), ensure_ascii=False))
