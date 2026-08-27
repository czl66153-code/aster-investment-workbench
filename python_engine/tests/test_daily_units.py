from __future__ import annotations

from pathlib import Path
import sys
import unittest


VENDOR_ROOT = Path(__file__).resolve().parents[1] / "vendor_exact"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from quant_mvp.daily_units import (  # noqa: E402
    DailyUnitError,
    canonical_daily_vwap,
    canonical_to_legacy_daily_units,
    legacy_daily_vwap,
    validate_daily_vwap,
)
from quant_mvp.independent_chip import infer_daily_average_price  # noqa: E402


class DailyUnitContractTests(unittest.TestCase):
    def test_canonical_and_legacy_contracts_produce_same_vwap(self) -> None:
        volume_shares = 12_345_600
        amount_cny = 123_949_320
        volume_lots, amount_thousand = canonical_to_legacy_daily_units(
            volume_shares, amount_cny
        )
        self.assertAlmostEqual(
            canonical_daily_vwap(amount_cny, volume_shares),
            legacy_daily_vwap(amount_thousand, volume_lots),
            places=10,
        )

    def test_legacy_chip_formula_accepts_valid_daily_units(self) -> None:
        self.assertAlmostEqual(
            infer_daily_average_price(123_949.32, 123_456, low=9.8, high=10.3),
            10.03996,
            places=4,
        )

    def test_canonical_values_are_rejected_by_legacy_chip_formula(self) -> None:
        with self.assertRaises(DailyUnitError):
            infer_daily_average_price(
                123_949_320,
                12_345_600,
                low=9.8,
                high=10.3,
            )

    def test_vwap_outside_ohlc_is_rejected(self) -> None:
        with self.assertRaises(DailyUnitError):
            validate_daily_vwap(100, 9.8, 10.3)


if __name__ == "__main__":
    unittest.main()
