"""Regression tests use only generated, synthetic marks."""

import unittest

import pandas as pd

from szj_overlay import first_exit_signal


class ExitSignalTests(unittest.TestCase):
    def frame(self, values):
        dates = pd.bdate_range("2000-01-03", periods=len(values))
        return pd.DataFrame({"mark": values, "valid": True}, index=dates)

    def test_loss_at_inclusive_twenty_percent_boundary(self):
        frame = self.frame([100.0, 90.0, 80.0, 85.0])
        self.assertEqual(first_exit_signal(frame, frame.index[0]), frame.index[2])

    def test_trail_activates_at_inclusive_forty_percent_boundary(self):
        frame = self.frame([100.0, 140.0, 105.0, 110.0])
        self.assertEqual(first_exit_signal(frame, frame.index[0]), frame.index[2])

    def test_trail_is_inactive_before_activation(self):
        frame = self.frame([100.0, 130.0, 90.0, 95.0])
        self.assertTrue(pd.isna(first_exit_signal(frame, frame.index[0])))

    def test_stale_price_does_not_trigger_exit(self):
        frame = self.frame([100.0, 150.0, 110.0, 110.0, 110.0])
        frame.loc[frame.index[2:4], "valid"] = False
        self.assertEqual(first_exit_signal(frame, frame.index[0]), frame.index[4])

    def test_original_exit_wins_on_same_day(self):
        frame = self.frame([100.0, 150.0, 110.0, 120.0])
        result = first_exit_signal(frame, frame.index[0], frame.index[2])
        self.assertTrue(pd.isna(result))

    def test_overlay_cannot_replace_earlier_original_exit(self):
        frame = self.frame([100.0, 150.0, 110.0, 120.0])
        result = first_exit_signal(frame, frame.index[0], frame.index[1])
        self.assertTrue(pd.isna(result))

    def test_future_append_preserves_every_published_prefix(self):
        frame = self.frame([100.0, 110.0, 141.0, 150.0, 118.0, 110.0, 200.0, 70.0])
        full = first_exit_signal(frame, frame.index[0])
        for length in range(1, len(frame) + 1):
            prefix = frame.iloc[:length]
            actual = first_exit_signal(prefix, frame.index[0])
            if pd.notna(full) and full <= prefix.index[-1]:
                self.assertEqual(actual, full)
            else:
                self.assertTrue(pd.isna(actual))

    def test_missing_confirmation_date_returns_no_signal(self):
        frame = self.frame([100.0, 80.0, 90.0])
        self.assertTrue(pd.isna(first_exit_signal(frame, pd.Timestamp("1999-01-01"))))

    def test_zero_or_missing_reference_returns_no_signal(self):
        for reference in (0.0, float("nan")):
            frame = self.frame([reference, 80.0, 90.0])
            self.assertTrue(pd.isna(first_exit_signal(frame, frame.index[0])))

    def test_duplicate_or_unsorted_dates_are_rejected(self):
        frame = self.frame([100.0, 80.0, 90.0])
        with self.assertRaises(ValueError):
            first_exit_signal(frame.iloc[::-1], frame.index[0])
        duplicate = pd.concat([frame, frame.iloc[[-1]]])
        with self.assertRaises(ValueError):
            first_exit_signal(duplicate, frame.index[0])

    def test_invalid_thresholds_are_rejected(self):
        frame = self.frame([100.0, 80.0])
        for kwargs in (
            {"loss_limit": 0.0},
            {"loss_limit": 1.0},
            {"trail_distance": float("nan")},
            {"trail_activation": float("inf")},
        ):
            with self.assertRaises(ValueError):
                first_exit_signal(frame, frame.index[0], **kwargs)


if __name__ == "__main__":
    unittest.main()
