# Independent AIA Python engine

This directory is the standalone adaptation boundary for the AIA logic formerly
served on port 8000. It reads copied assets from this repository and never calls
or imports the legacy process.

## Included logic

- M30 early-breakout gates, anti-chase checks and 64-point template calibration.
- Top10 evidence coverage, original factor weights, pattern bonuses, risk gates,
  and the exactly-ten publication rule.
- Original catalyst keywords, Kaipanla/Eastmoney/Tonghuashun leadership fusion,
  sector heat and stock-popularity formulas.
- Intraday AkShare and nightly BigQuant/Tushare source contracts. Network fetches
  are deliberately outside this package; jobs pass fetched JSON with source,
  `trade_date`, and `as_of` fields.

Intraday bars are AkShare-only. Eastmoney, Tonghuashun and Sina may appear only
as AkShare provider subsources. Tencent fallback is forbidden; if AkShare fails,
the publication layer keeps the last published version and marks it stale.

## Task entry points

From the project root:

```text
npm run verify:aia-python
aster-top10 --db D:\\UnifiedResearchWorkbench\\data\\aster.db
py -3 engine/python_engine/run.py source-plan --session intraday
py -3 engine/python_engine/run.py m30 --input examples/m30-bars.json
py -3 engine/python_engine/run.py top10 --input examples/aia-candidates.json
```

Use `ASTER_PYTHON` when Python is installed at a nonstandard path. The runtime
does not store secrets. BigQuant/Tushare credentials must remain deployment
environment variables; AkShare requires no copied key.

`aster-top10` opens SQLite in read-only/query-only mode by default. It requires
at least 400 candidates, a matching published factor snapshot, sufficient AIA
and dual-chip score coverage, compliant formal source dates, ten candidates
above the score gate, and an exact ten-item result. `--staging` writes a separate
`aia_aster` staging batch and never updates or supersedes published versions.
Install the local command without downloading runtime dependencies with
`python -m pip install -e engine/python_engine`.

## Migration and safety notes

- The source legacy repository declares no remote or license. The manifest marks
  this provenance explicitly; do not redistribute outside the local owner's
  migration without a license review.
- The copied M30 JSON contains an old `image_path` for audit provenance. The
  loader discards that value and resolves the independent local asset instead.
- Raw provider payloads are retained in normalized evidence. UI/API layers should
  redact provider errors and credentials before exposing audit responses.

## Source lineage

- `backend/signal_desk/aia/patterns/m30_early_breakout.py` -> `aia_engine/m30.py`
- `backend/signal_desk/aia/ranking/weight_config.py` and `top10.py` -> `aia_engine/ranking.py`
- `backend/signal_desk/aia/ranking/catalyst.py`, `leadership.py`, and `aia/heat.py` -> `aia_engine/evidence.py`
- Provider scheduling and freshness constraints -> `aia_engine/sources.py`

The paths on the left are provenance only. No code in this package imports them.
