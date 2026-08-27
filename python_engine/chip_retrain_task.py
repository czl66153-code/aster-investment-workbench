"""Synchronize reviewed positives and run the governed 24-feature retrainer."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "python_engine" / "vendor_exact"
DATA = ROOT / "data"
VALIDATION_SCRIPT = VENDOR / "scripts" / "write_chip_shape_deployment_validation.py"


def _model_paths(scope: str) -> tuple[Path, Path]:
    source = ROOT / "engine" / "models" / ("chip_formal" if scope == "formal" else "chip_candidate")
    target = DATA / ("chip_shape_model_current" if scope == "formal" else "chip_shape_model_candidate_current")
    return source, target


def _prepare_models() -> None:
    for scope in ("formal", "candidate"):
        source, target = _model_paths(scope)
        target.mkdir(parents=True, exist_ok=True)
        for name in ("model.joblib", "model.json"):
            if not (target / name).exists():
                shutil.copy2(source / name, target / name)


def _synchronize_runtime_models() -> list[str]:
    synchronized: list[str] = []
    for scope in ("formal", "candidate"):
        source, target = _model_paths(scope)
        source.mkdir(parents=True, exist_ok=True)
        for name in ("model.joblib", "model.json", "validation.json"):
            deployed = target / name
            runtime = source / name
            if not deployed.exists():
                continue
            if not runtime.exists() or runtime.read_bytes() != deployed.read_bytes():
                shutil.copy2(deployed, runtime)
                synchronized.append(f"{scope}/{name}")
    return synchronized


def _refresh_deployment_validation() -> list[str]:
    refreshed: list[str] = []
    for scope in ("formal", "candidate"):
        source, target = _model_paths(scope)
        model_metadata = json.loads((target / "model.json").read_text(encoding="utf-8"))
        validation_path = target / "validation.json"
        try:
            validation = json.loads(validation_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            validation = {}
        if (
            validation.get("model_version") != model_metadata.get("model_version")
            or int(validation.get("feature_count") or 0) != 24
        ):
            completed = subprocess.run(
                [
                    sys.executable,
                    str(VALIDATION_SCRIPT),
                    "--model-root",
                    str(target),
                    "--archive-root",
                    str(ROOT / "backups" / "chip_validation_archive" / scope),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
            if completed.returncode != 0:
                raise RuntimeError(f"{scope} validation refresh failed: {(completed.stderr or completed.stdout)[-2000:]}")
            refreshed.append(scope)
        source.mkdir(parents=True, exist_ok=True)
        shutil.copy2(validation_path, source / "validation.json")
    return refreshed


def _sync_registry(database: Path) -> dict[str, Any]:
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        models = {row["scope"]: dict(row) for row in connection.execute("SELECT * FROM model_registry")}
        samples = [dict(row) for row in connection.execute("SELECT * FROM chip_samples ORDER BY scope,trade_date,code")]
    finally:
        connection.close()
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    scopes: dict[str, Any] = {}
    for scope in ("formal", "candidate"):
        registry = models.get(scope, {})
        scoped = []
        for row in samples:
            if row.get("scope") != scope:
                continue
            scoped.append({
                "label": int(row.get("sample_label", 1)),
                "sample_id": row["sample_id"], "scope": scope, "ts_code": row["code"],
                "trade_date": row["trade_date"], "factor_time": "", "name": row.get("name") or row["code"],
                "reason": row.get("reason") or ("人工确认正样本" if int(row.get("sample_label", 1)) == 1 else "人工确认负样本"),
                "source": "aster_reviewed_positive" if int(row.get("sample_label", 1)) == 1 else "aster_reviewed_negative",
                "created_at": row.get("created_at") or now, "updated_at": row.get("updated_at") or now,
            })
        scopes[scope] = {
            "revision": int(registry.get("revision") or 1),
            "applied_revision": int(registry.get("applied_revision") or 0),
            "pending_retrain": bool(registry.get("pending_retrain")),
            "samples": scoped,
        }
    payload = {"version": 1, "created_at": now, "updated_at": now, "scopes": scopes, "events": []}
    path = DATA / "chip_shape_model_positive_samples.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return {
        scope: {
            "revision": value["revision"],
            "applied_revision": value["applied_revision"],
            "pending_retrain": value["pending_retrain"],
            "samples": len(value["samples"]),
        }
        for scope, value in scopes.items()
    }


def run(database: Path, dry_run: bool = False) -> dict[str, Any]:
    _prepare_models()
    registry = _sync_registry(database)
    up_to_date = all(
        not state["pending_retrain"] and state["revision"] <= state["applied_revision"]
        for state in registry.values()
    )
    if up_to_date and not dry_run:
        refreshed_validation = _refresh_deployment_validation()
        synchronized = _synchronize_runtime_models()
        connection = sqlite3.connect(database)
        try:
            connection.execute(
                "UPDATE model_registry SET status='active',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE pending_retrain=0 AND revision<=applied_revision"
            )
            connection.commit()
        finally:
            connection.close()
        return {
            "ok": True,
            "status": "up_to_date",
            "task": "aster_24d_managed_chip_retrain",
            "registry": registry,
            "summary": {"pending": [], "deployed": False, "reason": "all revisions already applied", "validation_refreshed": refreshed_validation, "runtime_models_synchronized": synchronized},
            "message": "正样本修订均已应用，现有24维双筹码模型无需重复重训",
        }
    environment = {**os.environ, "QUANT_DATA_ROOT": str(DATA), "QUANT_DB_PATH": os.environ.get("ASTER_MARKET_DB", str(DATA / "market.duckdb")), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    script = VENDOR / "scripts" / "retrain_managed_chip_shape_models.py"
    command = [sys.executable, str(script), "--scope", "all"]
    if dry_run:
        command.append("--dry-run")
    completed = subprocess.run(command, cwd=VENDOR, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3 * 60 * 60, check=False)
    try:
        summary = json.loads(completed.stdout[completed.stdout.find("{"):])
    except Exception:
        summary = {"status": "failed_kept_previous", "error": (completed.stderr or completed.stdout)[-3000:]}
    deployed = str(summary.get("status")) == "deployed"
    if deployed:
        for scope in ("formal", "candidate"):
            source, target = _model_paths(scope)
            for name in ("model.joblib", "model.json"):
                shutil.copy2(target / name, source / name)
        _refresh_deployment_validation()
    if not dry_run:
        connection = sqlite3.connect(database)
        try:
            for scope in ("formal", "candidate"):
                state = (summary.get("scopes") or {}).get(scope) or {}
                status = state.get("status") or summary.get("status") or "failed_kept_previous"
                connection.execute(
                    "UPDATE model_registry SET status=?,ready_count=?,applied_revision=CASE WHEN ?='deployed' THEN revision ELSE applied_revision END,pending_retrain=CASE WHEN ?='deployed' THEN 0 ELSE pending_retrain END,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE scope=?",
                    (status, registry[scope]["samples"], status, status, state.get("error"), scope),
                )
            connection.commit()
        finally:
            connection.close()
    message = "24维托管重训预检完成" if dry_run else "24维托管重训已部署" if deployed else "24维托管重训未通过，已安全保留上一模型"
    return {"ok": True, "status": "dry_run" if dry_run else summary.get("status") or "failed_kept_previous", "task": "aster_24d_managed_chip_retrain", "registry": registry, "summary": summary, "message": message}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.getenv("ASTER_DB_PATH", str(DATA / "aster.db")))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(Path(args.db), args.dry_run), ensure_ascii=False, default=str))
