from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def main() -> None:
    database = Path(sys.argv[1])
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    for (table_name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table_name}")')]
        try:
            count = connection.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        except sqlite3.DatabaseError as error:
            count = f"unavailable:{type(error).__name__}"
        print(f"{table_name}\t{count}\t{','.join(columns)}")
    connection.close()


if __name__ == "__main__":
    main()
