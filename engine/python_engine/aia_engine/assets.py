"""Resolve and validate copied AIA assets without consulting the old site."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
ENGINE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST_PATH = PACKAGE_ROOT / "assets.manifest.json"


def load_asset_manifest(path: str | Path | None = None) -> dict[str, Any]:
    manifest_path = Path(path).resolve() if path else DEFAULT_MANIFEST_PATH
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["_manifest_path"] = str(manifest_path)
    return data


def resolve_asset_path(relative_path: str, manifest_path: str | Path | None = None) -> Path:
    base = Path(manifest_path).resolve().parent if manifest_path else PACKAGE_ROOT
    candidate = (base / relative_path).resolve()
    # Asset references may only reach files inside the new site's engine tree.
    if candidate != ENGINE_ROOT and ENGINE_ROOT not in candidate.parents:
        raise ValueError(f"asset escapes independent engine root: {relative_path}")
    return candidate


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_assets(path: str | Path | None = None) -> dict[str, Any]:
    manifest = load_asset_manifest(path)
    manifest_path = Path(manifest["_manifest_path"])
    results: list[dict[str, Any]] = []
    ok = True
    for item in manifest.get("assets", []):
        asset_path = resolve_asset_path(str(item["path"]), manifest_path)
        exists = asset_path.is_file()
        checksum = _sha256(asset_path) if exists else None
        checksum_ok = not item.get("sha256") or checksum == item["sha256"]
        item_ok = exists and checksum_ok
        if item.get("required", True) and not item_ok:
            ok = False
        results.append(
            {
                "id": item["id"],
                "path": str(asset_path),
                "exists": exists,
                "sha256": checksum,
                "checksum_ok": checksum_ok,
                "required": bool(item.get("required", True)),
            }
        )
    return {
        "ok": ok,
        "manifest_version": manifest.get("manifest_version"),
        "runtime_secrets_copied": False,
        "assets": results,
    }
