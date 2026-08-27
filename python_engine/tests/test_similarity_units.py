from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "python_engine" / "vendor_exact" / "machine_stock_picker_similarity" / "runtime"
sys.path.insert(0, str(RUNTIME))

from signal_desk.aia.api.similarity import _normalize_volume_units


def test_similarity_rows_normalize_migrated_lots_and_keep_aster_shares() -> None:
    rows = _normalize_volume_units(
        [
            {"source": "tencent_qfq", "volume": 1234},
            {"source": "eastmoney_30m_qfq", "volume": 500, "volume_unit": "lots"},
            {"source": "tencent_qfq_direct", "volume": 10, "volume_unit": "lots", "volume_shares": 1000},
            {"source": "aster_bigquant_tushare_formal", "volume": 86000000},
        ]
    )
    assert [row["volume"] for row in rows] == [123400, 50000, 1000, 86000000]
    assert all(row["volume_unit"] == "shares" for row in rows)
    assert all(row["similarity_unit_version"] == "aster_similarity_shares_v1" for row in rows)


def test_similarity_unit_normalization_is_idempotent() -> None:
    once = _normalize_volume_units([{"source": "tencent_qfq", "volume": 1234}])
    twice = _normalize_volume_units(once)
    assert twice[0]["volume"] == 123400
    assert twice[0]["volume_shares"] == 123400
