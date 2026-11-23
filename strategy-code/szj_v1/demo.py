"""Run with python demo.py. All marks below are synthetic."""

import json

import pandas as pd

from szj_overlay import first_exit_signal


def main():
    dates = pd.bdate_range("2000-01-03", periods=8)
    features = pd.DataFrame(
        {
            "mark": [100.0, 110.0, 141.0, 150.0, 118.0, 110.0, 122.0, 120.0],
            "valid": True,
        },
        index=dates,
    )
    signal = first_exit_signal(features, dates[0])
    next_index = dates.searchsorted(signal, side="right")
    next_session = dates[next_index] if pd.notna(signal) and next_index < len(dates) else pd.NaT
    print(
        json.dumps(
            {
                "data": "synthetic",
                "confirmation_close": float(features["mark"].iloc[0]),
                "exit_signal_close": str(signal.date()) if pd.notna(signal) else None,
                "next_session_to_attempt_execution": (
                    str(next_session.date()) if pd.notna(next_session) else None
                ),
                "execution_status": "not simulated",
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
