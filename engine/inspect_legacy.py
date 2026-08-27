from __future__ import annotations

from pathlib import Path

import duckdb


DB_PATH = Path(r"D:\quant_website_data\quant.duckdb")


def main() -> None:
    connection = duckdb.connect(str(DB_PATH), read_only=True)
    tables = connection.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name"
    ).fetchall()
    for (table_name,) in tables:
        if any(token in table_name.lower() for token in ("factor", "chip", "stock", "daily", "minute")):
            try:
                count = connection.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
            except Exception as error:
                count = f"unavailable:{type(error).__name__}"
            columns = connection.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='main' AND table_name=? ORDER BY ordinal_position",
                [table_name],
            ).fetchall()
            print(f"{table_name}\t{count}\t{','.join(column[0] for column in columns)}")
    connection.close()


if __name__ == "__main__":
    main()
