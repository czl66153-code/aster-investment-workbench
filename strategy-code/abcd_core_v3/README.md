# ABCD Core V3 — synthetic scoring example

This runnable example demonstrates the candidate scoring and diversification stage of `abcd_core_v3_validated_20260815`. It contains deterministic synthetic inputs and a standalone scoring module.

## Run

```sh
python -m pip install -r requirements.txt
python demo.py
```

The demo prints five synthetic candidates. It performs local calculations without network requests or output files.

## Rule

The 09:35 snapshot uses completed five-minute observations. Candidate admission starts with chip-shape rank 1–15. Within that pool, `D = 100 × (15 − rank) / 14`.

`Core = 10% × A + 10% × B_core + 10% × C + 70% × D`

- **A — sector strength.** Snapshot sector return 30%, breadth 20%, five-minute acceleration 15%, amount acceleration 15%, previous four-day return 20%.
- **B_core — reproducible attention.** Previous-day heat 55%, as-of snapshot heat 30%, heat acceleration 15%.
- **C — leadership and event logic.** Industry-relative return rank 30%, amount rank 20%, return lead 20%, market-event score 10%, previous-day disclosed event score 20%.
- **D — chip shape.** A supplied chip-shape rank is normalized inside the candidate pool.

Select at most five candidates, with at most two per industry, excluding flagged ST, suspended, and locked-limit-up symbols. The public function names, default weights, percentile handling, optional neutral scores and ranking logic are retained from the scoring implementation. The optional live-attention score is calculated separately and does not determine core selection.

## Verification scope

`demo.py` checks formula agreement, rank admission, exclusion flags, industry limits, unchanged selections after adding future-outcome labels, and rejection of a post-signal input. The caller validates source times before scoring. The scoring function itself expects an already prepared as-of panel.

All symbols, sectors, dates and values in the demo are synthetic. The package provides the scoring stage. Chip-shape modeling, source ingestion, portfolio cash and settlement accounting, historical result reproduction and execution simulation require separate implementations and inputs. The synthetic checks establish the stated calculation behavior, with predictive performance outside their scope.
