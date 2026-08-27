"""JSON command entry point for standalone AIA jobs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from aia_engine.assets import validate_assets
from aia_engine.m30 import evaluate_m30, load_template_profile
from aia_engine.ranking import rank_top10
from aia_engine.sources import normalize_heat_payloads, source_plan
from aia_engine.tasks import run_smoke


def _read_json(path: str) -> Any:
    if path == "-":
        return json.load(sys.stdin)
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write(payload: Any) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Independent AIA algorithm task runner")
    subparsers = parser.add_subparsers(dest="task", required=True)
    subparsers.add_parser("smoke", help="validate imports, assets, M30 and Top10")
    subparsers.add_parser("validate-assets", help="validate copied model/config checksums")
    m30 = subparsers.add_parser("m30", help="score one JSON M30 bar payload")
    m30.add_argument("--input", required=True, help="JSON file path or - for stdin")
    m30.add_argument("--profile", help="optional local template profile JSON")
    top10 = subparsers.add_parser("top10", help="rank candidates and enforce exactly-ten gate")
    top10.add_argument("--input", required=True, help="JSON file path or - for stdin")
    plan = subparsers.add_parser("source-plan", help="print the allowed provider plan")
    plan.add_argument("--session", required=True, choices=["intraday", "night"])
    heat = subparsers.add_parser("normalize-heat", help="normalize fetched provider payloads")
    heat.add_argument("--input", required=True, help="provider payload map JSON file or -")
    heat.add_argument("--session", required=True, choices=["intraday", "night"])
    heat.add_argument("--kind", required=True, choices=["sector_heat", "stock_popularity"])
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.task == "smoke":
        result = run_smoke()
    elif args.task == "validate-assets":
        result = validate_assets()
    elif args.task == "m30":
        payload = _read_json(args.input)
        bars = payload.get("bars", []) if isinstance(payload, dict) else payload
        result = evaluate_m30(bars, template_profile=load_template_profile(args.profile))
    elif args.task == "top10":
        payload = _read_json(args.input)
        candidates = payload.get("candidates", []) if isinstance(payload, dict) else payload
        result = rank_top10(candidates)
    elif args.task == "source-plan":
        result = source_plan(args.session)
    else:
        result = normalize_heat_payloads(_read_json(args.input), session=args.session, kind=args.kind)
    _write(result)
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
