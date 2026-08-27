from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_ROOT = Path(r"D:\UnifiedResearchWorkbench")
SOURCE_ENVS = (
    Path(r"D:\quant_website\.env"),
    Path(
        r"C:\Users\ROG\Documents\Codex\2026-08-18\xu\work\site_deploy"
        r"\网站便携包_20260818\ai_agent\PythonProject\.env"
    ),
)
SECRET_KEYS = (
    "TUSHARE_TOKEN",
    "BIGQUANT_TOKEN",
    "BIGQUANT_API_KEY",
    "MINISHARE_TOKEN",
    "MINISHARE_RESEARCH_TOKEN",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_TIMEOUT",
    "XUEQIU_COOKIE",
    "TAOGUBA_COOKIE",
    "TAVILY_API_KEY",
    "TAVILY_API_KEYS",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "MODEL_PROVIDER",
)


def read_values() -> dict[str, str]:
    values: dict[str, str] = {}
    for path in SOURCE_ENVS:
        if not path.exists():
            continue
        for key, value in dotenv_values(path).items():
            if key in SECRET_KEYS and value and key not in values:
                values[key] = str(value)
    return values


def render(values: dict[str, str], root: Path) -> str:
    fixed = {
        "ASTER_PYTHON": r"D:\quant_runtime\bigquant_py311\python.exe",
        "ASTER_ENGINE_HOST": "127.0.0.1",
        "ASTER_ENGINE_PORT": "8035",
        "ASTER_ALGORITHM_MODE": "legacy_compatible",
        "ASTER_INTRADAY_PROVIDER": "akshare_sina",
        "ASTER_ALLOW_TENCENT_FALLBACK": "0",
        "ASTER_DATA_ROOT": str(root / "data"),
        "ASTER_8002_DATA_ROOT": str(root / "data" / "source8002_data"),
        "ASTER_MARKET_DB": str(root / "data" / "market.duckdb"),
        "QUANT_DB_PATH": str(root / "data" / "market.duckdb"),
        "QUANT_DATA_ROOT": str(root / "data"),
        "AIA_DATA_ROOT": str(root / "data" / "aia"),
    }
    merged = {**values, **fixed}
    lines = [
        "# Generated locally from the previously authorized source configuration.",
        "# Values are never printed by this migration utility.",
    ]
    lines.extend(f"{key}={value}" for key, value in merged.items())
    return "\n".join(lines) + "\n"


def write_private_env(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


if __name__ == "__main__":
    values = read_values()
    write_private_env(PROJECT_ROOT / ".env", render(values, PROJECT_ROOT))
    if DEPLOY_ROOT.exists():
        write_private_env(DEPLOY_ROOT / ".env", render(values, DEPLOY_ROOT))
    print(f"configured={len(values)} targets=2")
