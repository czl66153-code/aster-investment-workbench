from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[1]


def result(source: str, started: float, **payload: object) -> dict[str, object]:
    return {"source": source, "latency_ms": round((time.monotonic() - started) * 1000), **payload}


def configure() -> None:
    # Probing reuses the already-authorized credentials without ever printing them.
    candidates = [
        ROOT / ".env",
        Path(r"D:\quant_website\.env"),
        Path(
            r"C:\Users\ROG\Documents\Codex\2026-08-18\xu\work\site_deploy"
            r"\网站便携包_20260818\ai_agent\PythonProject\.env"
        ),
    ]
    merged: dict[str, str] = {}
    for path in candidates:
        if not path.exists():
            continue
        for key, value in dotenv_values(path).items():
            if value and key not in merged:
                merged[key] = value
    for key in ("TUSHARE_TOKEN", "BIGQUANT_TOKEN"):
        if key in merged and not os.getenv(key):
            os.environ[key] = merged[key]


def probe_tushare() -> dict[str, object]:
    started = time.monotonic()
    try:
        import tushare as ts

        token = os.getenv("TUSHARE_TOKEN", "")
        pro = ts.pro_api(token) if token else ts.pro_api()
        frame = pro.daily(trade_date="20260819", fields="ts_code,trade_date,open,high,low,close,vol,amount")
        return result("tushare", started, ok=not frame.empty, rows=len(frame), columns=list(frame.columns))
    except Exception as exc:  # pragma: no cover - diagnostic path
        return result("tushare", started, ok=False, error=f"{type(exc).__name__}: {exc}")


def probe_bigquant() -> dict[str, object]:
    started = time.monotonic()
    try:
        from bigquant import dai

        sql = """
        SELECT date, instrument, open, high, low, close, volume, amount
        FROM cn_stock_bar1d
        WHERE date >= '2026-08-19' AND date <= '2026-08-19'
          AND instrument = '600519.SH'
        ORDER BY instrument
        """
        frame = dai.query(sql, filters={"date": ["2026-08-19", "2026-08-19"]}).df()
        return result("bigquant", started, ok=not frame.empty, rows=len(frame), columns=list(frame.columns))
    except Exception as exc:  # pragma: no cover - diagnostic path
        return result("bigquant", started, ok=False, error=f"{type(exc).__name__}: {exc}")


def probe_akshare() -> dict[str, object]:
    started = time.monotonic()
    try:
        import akshare as ak

        frame = ak.stock_zh_a_spot_em()
        required = {"代码", "名称", "最新价", "成交额"}
        return result(
            "akshare",
            started,
            ok=not frame.empty and required.issubset(frame.columns),
            rows=len(frame),
            columns=[column for column in ("代码", "名称", "最新价", "涨跌幅", "成交量", "成交额", "换手率") if column in frame.columns],
        )
    except Exception as exc:  # pragma: no cover - diagnostic path
        return result("akshare", started, ok=False, error=f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    configure()
    probes = {"tushare": probe_tushare, "bigquant": probe_bigquant, "akshare": probe_akshare}
    selected = sys.argv[1:] or list(probes)
    print(json.dumps([probes[name]() for name in selected], ensure_ascii=False))
