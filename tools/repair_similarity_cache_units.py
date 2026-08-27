"""Normalize migrated K-line similarity caches to share-volume units.

Dry-run is the default. ``--apply`` creates an exact file backup before each
rewrite, atomically replaces cache/feature files, and writes a JSON manifest.
The similarity formulas are not changed; only their adapter-level OHLCV unit
contract is made consistent with Aster's governed market warehouse.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUNTIME = PROJECT_ROOT / "python_engine" / "vendor_exact" / "machine_stock_picker_similarity" / "runtime"
sys.path.insert(0, str(RUNTIME))

from signal_desk.aia.api.similarity import _normalize_volume_units  # noqa: E402
from signal_desk.aia.similarity_cache import update_feature_index  # noqa: E402


def _atomic_gzip_json(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(gzip.compress(json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")))
    temporary.replace(path)


def _row_changed(before: dict, after: dict) -> bool:
    return (
        before.get("volume") != after.get("volume")
        or before.get("volume_unit") != "shares"
        or before.get("volume_shares") != after.get("volume_shares")
        or before.get("similarity_unit_version") != "aster_similarity_shares_v1"
    )


def run(*, apply: bool, data_root: Path) -> dict:
    cache_root = data_root / "aia" / "cache"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = data_root / "repair_backups" / f"{stamp}-similarity-cache-unit-repair"
    summary = {
        "mode": "apply" if apply else "dry_run",
        "started_at": datetime.now().astimezone().isoformat(),
        "unit_version": "aster_similarity_shares_v1",
        "cache_files_seen": 0,
        "cache_files_changed": 0,
        "rows_seen": 0,
        "rows_changed": 0,
        "feature_files_rebuilt": 0,
        "malformed_files": [],
        "backup_root": str(backup_root) if apply else None,
    }
    for period in ("daily", "m30"):
        source_dir = cache_root / "similarity_kline" / period
        for path in sorted(source_dir.glob("*.json.gz")):
            summary["cache_files_seen"] += 1
            try:
                payload = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
                rows = [dict(row) for row in (payload.get("rows") or []) if isinstance(row, dict)]
            except (OSError, ValueError, TypeError, gzip.BadGzipFile) as exc:
                summary["malformed_files"].append({"path": str(path), "error": type(exc).__name__})
                continue
            normalized = _normalize_volume_units(rows)
            changed_rows = sum(1 for before, after in zip(rows, normalized) if _row_changed(before, after))
            summary["rows_seen"] += len(rows)
            summary["rows_changed"] += changed_rows
            if not changed_rows:
                continue
            summary["cache_files_changed"] += 1
            if not apply:
                continue

            relative_cache = path.relative_to(cache_root)
            cache_backup = backup_root / "original" / relative_cache
            cache_backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, cache_backup)

            feature_path = cache_root / "similarity_features" / period / path.name
            if feature_path.exists():
                feature_backup = backup_root / "original" / feature_path.relative_to(cache_root)
                feature_backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(feature_path, feature_backup)

            payload["rows"] = normalized
            payload["unit_version"] = "aster_similarity_shares_v1"
            payload["unit_repaired_at"] = datetime.now().astimezone().isoformat()
            _atomic_gzip_json(path, payload)
            update_feature_index(data_root, str(payload.get("ticker") or path.stem.replace("_", ".")), period, normalized)
            summary["feature_files_rebuilt"] += 1

    summary["finished_at"] = datetime.now().astimezone().isoformat()
    if apply:
        backup_root.mkdir(parents=True, exist_ok=True)
        (backup_root / "repair_manifest.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--data-root", type=Path, default=PROJECT_ROOT / "data")
    arguments = parser.parse_args()
    result = run(apply=arguments.apply, data_root=arguments.data_root.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["malformed_files"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
