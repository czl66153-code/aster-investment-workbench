"""Refresh only the original 8002 five-platform hot-stock dashboard."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import replace
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_project_env() -> None:
    path = ROOT / ".env"
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        cleaned = value.strip().strip("\"'")
        if key.strip() and not str(os.environ.get(key.strip(), "")).strip():
            os.environ[key.strip()] = cleaned


def run(data_root: Path) -> dict:
    from python_engine.vendor8002.collectors import MultiPlatformHotCollector
    from python_engine.vendor8002.config import Vendor8002Settings

    load_project_env()
    settings = replace(Vendor8002Settings.from_env(project_dir=ROOT), cache_dir=data_root)
    payload = MultiPlatformHotCollector(settings=settings).refresh(
        target_day=date.today(), mode="legacy", write_cache=True
    )
    return {
        "ok": int(payload.get("success_count") or 0) > 0,
        "status": "success" if int(payload.get("success_count") or 0) >= 3 else "degraded",
        "message": f"五平台完成 {int(payload.get('success_count') or 0)}/5",
        "count": sum(len(item.get("items") or []) for item in payload.get("platforms") or []),
        "payload": payload,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", default=os.getenv("ASTER_8002_DATA_ROOT", str(ROOT / "data" / "source8002_data")))
    args = parser.parse_args()
    print(json.dumps(run(Path(args.data_root)), ensure_ascii=False, default=str))
