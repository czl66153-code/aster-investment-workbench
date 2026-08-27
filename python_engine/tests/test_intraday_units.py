from __future__ import annotations

from pathlib import Path
import sys
import unittest


VENDOR_ROOT = Path(__file__).resolve().parents[1] / "vendor_exact"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from quant_mvp.intraday_units import (  # noqa: E402
    IntradayUnitError,
    canonical_turnover_from_float_share,
    normalize_quote_units,
)


class IntradayUnitContractTests(unittest.TestCase):
    def test_eastmoney_hands_become_shares(self) -> None:
        quote = normalize_quote_units(
            "akshare_eastmoney_spot",
            price=10,
            volume=1_234,
            amount=1_234_000,
            pct_chg="2.5%",
            turnover_rate="1.25%",
        )
        self.assertEqual(quote["volume"], 123_400)
        self.assertEqual(quote["amount"], 1_234_000)
        self.assertEqual(quote["pct_chg"], 2.5)
        self.assertEqual(quote["turnover_rate"], 1.25)

    def test_sina_shares_remain_shares(self) -> None:
        quote = normalize_quote_units(
            "akshare_sina_spot",
            price=9.21,
            volume=67_129_345,
            amount=614_350_378,
        )
        self.assertEqual(quote["volume"], 67_129_345)

    def test_tencent_field_6_is_hands(self) -> None:
        quote = normalize_quote_units(
            "tencent_fallback",
            price=9.21,
            volume=669_280,
            amount=612_496_437,
            turnover_rate=0.20,
        )
        self.assertEqual(quote["volume"], 66_928_000)
        self.assertAlmostEqual(quote["amount"] / quote["volume"], 9.151568, places=5)
        self.assertEqual(quote["turnover_rate"], 0.20)

    def test_tonghuashun_text_units_are_canonicalized(self) -> None:
        quote = normalize_quote_units(
            "akshare_tonghuashun_spot",
            price="10.00",
            volume="1.2万",
            amount="1200万元",
            pct_chg="2.50%",
            turnover_rate="3.10%",
        )
        self.assertEqual(quote["volume"], 1_200_000)
        self.assertEqual(quote["amount"], 12_000_000)
        self.assertEqual(quote["pct_chg"], 2.5)
        self.assertEqual(quote["turnover_rate"], 3.1)

    def test_amount_volume_mismatch_is_rejected(self) -> None:
        with self.assertRaises(IntradayUnitError):
            normalize_quote_units(
                "akshare_sina_spot",
                price=10,
                volume=10_000,
                amount=10_000_000,
            )

    def test_unknown_source_is_rejected(self) -> None:
        with self.assertRaises(IntradayUnitError):
            normalize_quote_units("mystery_vendor", price=10, volume=100, amount=1_000)

    def test_turnover_uses_tushare_float_share_10k_unit(self) -> None:
        turnover = canonical_turnover_from_float_share(20_642_251, 4_496.8188)
        self.assertAlmostEqual(turnover or 0, 45.90412, places=4)


if __name__ == "__main__":
    unittest.main()
