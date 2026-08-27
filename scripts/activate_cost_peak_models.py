"""Atomically activate the reviewed 24-feature chip models.

The script always preserves a complete rollback bundle, merges the experiment
metadata into the existing production metadata, updates both runtime mirrors,
and switches the SQLite registry only after every file has been verified.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
from typing import Any

import joblib


ROOT = Path(__file__).resolve().parents[1]
EXPERIMENT = ROOT / "outputs" / "chip_cost_peak_distance_experiment" / "20260824_review"
DATA = ROOT / "data"
FEATURE = "cost_line_main_peak_abs_distance_rank_pct"

SCOPES = {
    "formal": {
        "experiment": EXPERIMENT / "formal",
        "targets": [DATA / "chip_shape_model_current", ROOT / "engine" / "models" / "chip_formal"],
    },
    "candidate": {
        "experiment": EXPERIMENT / "candidate",
        "targets": [DATA / "chip_shape_model_candidate_current", ROOT / "engine" / "models" / "chip_candidate"],
    },
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    temporary.replace(path)


def atomic_joblib(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    joblib.dump(payload, temporary)
    temporary.replace(path)


def production_version(scope: str, experiment_version: str) -> str:
    marker = f"__exp_cost_peak_distance_{scope}_"
    if marker not in experiment_version:
        raise RuntimeError(f"unexpected experiment version: {experiment_version}")
    return experiment_version.replace(marker, "__cost_peak_distance_v1_")


def prepare_scope(scope: str) -> tuple[dict[str, Any], dict[str, Any], str]:
    config = SCOPES[scope]
    experiment_artifact = joblib.load(config["experiment"] / "model.joblib")
    experiment_meta = json.loads((config["experiment"] / "model.json").read_text(encoding="utf-8"))
    old_meta = json.loads((config["targets"][0] / "model.json").read_text(encoding="utf-8"))
    columns = list(experiment_artifact.get("feature_columns") or [])
    if len(columns) != 24 or FEATURE not in columns:
        raise RuntimeError(f"{scope} experiment is not the reviewed 24-feature model")
    version = production_version(scope, str(experiment_artifact["model_version"]))

    artifact = copy.deepcopy(experiment_artifact)
    template = copy.deepcopy(artifact["template_model"])
    supervised = copy.deepcopy(template.get("supervised_model") or {})
    supervised.update(
        {
            "feature_columns": columns,
            "positive_reference_vectors": copy.deepcopy(artifact["positive_reference_vectors"]),
            "negative_reference_vectors": copy.deepcopy(artifact["negative_reference_vectors"]),
            "feature_importance": copy.deepcopy(experiment_meta.get("feature_importance") or []),
        }
    )
    template.update(
        {
            "model_version": version,
            "supervised_model": supervised,
            "cost_peak_distance_factor": copy.deepcopy(experiment_meta["factor_definition"]),
        }
    )
    artifact.update(
        {
            "model_version": version,
            "status": "active",
            "feature_columns": columns,
            "template_model": template,
            "activated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
    )

    metadata = copy.deepcopy(old_meta)
    metadata.update(
        {
            "model_version": version,
            "source_online_model_version": experiment_meta.get("source_online_model_version"),
            "status": "active",
            "trained_at": experiment_meta.get("trained_at"),
            "activated_at": artifact["activated_at"],
            "feature_columns": columns,
            "supervised_model": supervised,
            "cost_peak_distance_factor": copy.deepcopy(experiment_meta["factor_definition"]),
            "cost_peak_distance_validation": copy.deepcopy(experiment_meta.get("validation") or {}),
            "activation_note": "用户于2026-08-25明确批准上线；两套模型分别使用既有正式/候选正样本影子重训，第三模型未训练",
        }
    )
    return artifact, metadata, version


def activate(dry_run: bool = False) -> dict[str, Any]:
    already_active = True
    active_versions: dict[str, str] = {}
    for scope, config in SCOPES.items():
        try:
            current = json.loads((config["targets"][0] / "model.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            already_active = False
            continue
        columns = list(current.get("feature_columns") or [])
        version = str(current.get("model_version") or "")
        active_versions[scope] = version
        already_active = already_active and FEATURE in columns and len(columns) == 24 and "__cost_peak_distance_v1_" in version
    if already_active and not dry_run:
        return {
            "status": "already_active_no_change",
            "feature": FEATURE,
            "versions": active_versions,
            "message": "24维成本峰距模型已经上线；拒绝重复执行一次性激活脚本",
        }
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_root = ROOT / "backups" / f"chip_cost_peak_activation_{timestamp}"
    prepared = {scope: prepare_scope(scope) for scope in SCOPES}
    manifest: dict[str, Any] = {
        "status": "dry_run" if dry_run else "activating",
        "activated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "feature": FEATURE,
        "backup_root": str(backup_root),
        "scopes": {},
    }
    for scope, config in SCOPES.items():
        artifact, metadata, version = prepared[scope]
        before = {}
        for target in config["targets"]:
            for filename in ("model.joblib", "model.json"):
                path = target / filename
                if not path.exists():
                    raise FileNotFoundError(path)
                before[str(path)] = sha256(path)
        manifest["scopes"][scope] = {
            "version": version,
            "feature_columns": list(artifact["feature_columns"]),
            "positive_references": len(artifact["positive_reference_vectors"]),
            "negative_references": len(artifact["negative_reference_vectors"]),
            "before_sha256": before,
        }
        if dry_run:
            continue
        for target in config["targets"]:
            relative = target.relative_to(ROOT)
            destination = backup_root / relative
            destination.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target / "model.joblib", destination / "model.joblib")
            shutil.copy2(target / "model.json", destination / "model.json")
        for target in config["targets"]:
            atomic_joblib(target / "model.joblib", artifact)
            atomic_json(target / "model.json", metadata)
        job_hashes = {sha256(target / "model.joblib") for target in config["targets"]}
        json_hashes = {sha256(target / "model.json") for target in config["targets"]}
        if len(job_hashes) != 1 or len(json_hashes) != 1:
            raise RuntimeError(f"{scope} runtime mirrors failed hash verification")
        manifest["scopes"][scope]["after_sha256"] = {
            "model.joblib": next(iter(job_hashes)),
            "model.json": next(iter(json_hashes)),
        }

    if dry_run:
        return manifest

    database = DATA / "aster.db"
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        manifest["model_registry_before"] = [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM model_registry WHERE scope IN ('formal','candidate') ORDER BY scope"
            )
        ]
        connection.execute("BEGIN IMMEDIATE")
        for scope, (_, _, version) in prepared.items():
            changed = connection.execute(
                """UPDATE model_registry SET model_version=?,status='active',pending_retrain=0,
                   last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE scope=?""",
                (version, scope),
            ).rowcount
            if changed != 1:
                raise RuntimeError(f"missing model_registry row for {scope}")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    status_path = DATA / "chip_shape_model_retrain_status.json"
    if status_path.exists():
        shutil.copy2(status_path, backup_root / status_path.name)
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {"scopes": {}}
    status.setdefault("scopes", {})
    for scope, (_, metadata, version) in prepared.items():
        status["scopes"].setdefault(scope, {})
        status["scopes"][scope].update(
            {
                "status": "deployed",
                "model_version": version,
                "activated_at": metadata["activated_at"],
                "feature_columns": metadata["feature_columns"],
                "backup": str(backup_root),
                "error": None,
            }
        )
    status["updated_at"] = manifest["activated_at"]
    status["last_run_status"] = "deployed"
    atomic_json(status_path, status)
    manifest["status"] = "active"
    atomic_json(backup_root / "activation_manifest.json", manifest)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    arguments = parser.parse_args()
    print(json.dumps(activate(arguments.dry_run), ensure_ascii=False, indent=2))
