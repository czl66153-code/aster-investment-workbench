"""Offline chip-model experiment for the cost-line/main-peak distance factor.

This module is deliberately isolated from the production model registry and
rank tables.  It re-fits two shadow ExtraTrees classifiers from the currently
reviewed formal/candidate positive samples, scores one complete daily cross
section, and writes only to an explicitly supplied output directory.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import sys
from typing import Any, Iterable

import duckdb
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.metrics import balanced_accuracy_score, brier_score_loss, roc_auc_score


ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "python_engine" / "vendor_exact"
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

from quant_mvp.chip_shape_score import _score_shape_panel_with_model  # noqa: E402
from quant_mvp.chip_shape_template import (  # noqa: E402
    ML_FEATURE_COLUMNS,
    blend_shape_scores,
    build_shape_rank_features,
    score_shape_template_model,
)


RANDOM_STATE = 20260727
NEW_FEATURE = "cost_line_main_peak_abs_distance_rank_pct"
FACTOR_DEFINITION = {
    "display_name": "成本均线与主峰距离",
    "cost_line_price": (
        "当日完整筹码分布的加权平均成本 Σ(price_i × chips_ratio_i) / Σ(chips_ratio_i)，"
        "落库字段优先使用 chip_avg_price；仅在该字段缺失时回退同截面 avg_cost"
    ),
    "main_peak_price": (
        "同一日筹码分布经既有8010主峰识别算法得到的 raw_main_peak_price；"
        "历史训练截面使用同口径 chip_main_peak_price"
    ),
    "signed_ratio": "(main_peak_price - cost_line_price) / cost_line_price",
    "absolute_ratio": "abs(signed_ratio)",
    "model_input": (
        "absolute_ratio 在同一交易日完整股票横截面内的百分位排名，范围[0,1]；"
        "0表示主峰最贴近成本线，1表示距离最远"
    ),
    "unit": "原始输出为百分比；模型输入为无量纲百分位",
    "point_in_time": (
        "只使用该交易日已完成的筹码分布与当日主峰，不读取未来价格、未来收益或未来标签"
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run isolated cost/main-peak chip experiment")
    parser.add_argument("--trade-date", default="2026-08-24")
    parser.add_argument("--database", type=Path, default=ROOT / "data" / "market.duckdb")
    parser.add_argument(
        "--registry",
        type=Path,
        default=ROOT / "data" / "chip_shape_model_positive_samples.json",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def _json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _make_model() -> ExtraTreesClassifier:
    return ExtraTreesClassifier(
        n_estimators=400,
        max_depth=4,
        min_samples_leaf=6,
        class_weight="balanced",
        max_features=0.8,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )


def _normalized_dates(frame: pd.DataFrame) -> pd.Series:
    return pd.to_datetime(frame["trade_date"], errors="coerce").dt.date


def _attach_distance_factor(frame: pd.DataFrame) -> pd.DataFrame:
    """Attach raw and same-date ranked versions without mutating the input."""
    result = frame.copy()
    def numeric_column(name: str) -> pd.Series:
        if name not in result:
            return pd.Series(np.nan, index=result.index, dtype="float64")
        return pd.to_numeric(result[name], errors="coerce")

    cost = numeric_column("chip_avg_price")
    if "avg_cost" in result:
        fallback_cost = numeric_column("avg_cost")
        cost = cost.where(cost > 0, fallback_cost)
    peak = numeric_column("raw_main_peak_price")
    if "chip_main_peak_price" in result:
        fallback_peak = numeric_column("chip_main_peak_price")
        peak = peak.where(peak > 0, fallback_peak)
    valid = (cost > 0) & (peak > 0)
    signed = pd.Series(np.nan, index=result.index, dtype="float64")
    signed.loc[valid] = (peak.loc[valid] - cost.loc[valid]) / cost.loc[valid]
    absolute = signed.abs()
    dates = _normalized_dates(result)
    ranked = absolute.groupby(dates).rank(pct=True, method="average")
    result["cost_line_price"] = cost
    result["main_peak_price_for_distance"] = peak
    result["cost_line_main_peak_signed_distance_ratio"] = signed
    result["cost_line_main_peak_abs_distance_ratio"] = absolute
    result[NEW_FEATURE] = ranked.fillna(0.5).clip(0.0, 1.0)
    return result


def _load_historical_distance_panel(
    connection: duckdb.DuckDBPyConnection,
    dates: Iterable[str],
) -> pd.DataFrame:
    ordered = sorted({str(value)[:10] for value in dates})
    placeholders = ", ".join("?" for _ in ordered)
    primary = connection.execute(
        f"""
        SELECT
            ts_code,
            trade_date,
            avg_cost,
            chip_avg_price,
            chip_main_peak_price,
            'market.duckdb/chip_factor_daily' AS factor_source
        FROM chip_factor_daily
        WHERE trade_date IN ({placeholders})
        ORDER BY trade_date, ts_code
        """,
        ordered,
    ).fetchdf()
    panels = [primary]
    project_snapshot = (
        ROOT
        / "data"
        / "warehouse_external"
        / "factor_cache"
        / "pool500_realtime_chip"
        / "_computed"
        / "pool500_factor_panel.parquet"
    )
    if project_snapshot.exists():
        snapshot = connection.execute(
            f"""
            SELECT
                ts_code,
                trade_date,
                avg_cost,
                chip_avg_price,
                chip_main_peak_price,
                'warehouse_external/pool500_factor_panel.parquet' AS factor_source
            FROM read_parquet(?)
            WHERE trade_date IN ({placeholders})
            ORDER BY trade_date, ts_code
            """,
            [str(project_snapshot), *ordered],
        ).fetchdf()
        panels.append(snapshot)
    panel = pd.concat(panels, ignore_index=True, copy=False)
    # The local DuckDB is the first choice.  The project-owned materialized
    # pool fills historical reviewed stocks that are absent from the compact
    # table without consulting a running legacy website.
    panel = panel.drop_duplicates(["ts_code", "trade_date"], keep="first")
    if panel.empty:
        raise RuntimeError("historical chip factor panel is empty for reviewed sample dates")
    return _attach_distance_factor(panel)


def _load_target_panel(
    connection: duckdb.DuckDBPyConnection,
    target_date: str,
) -> pd.DataFrame:
    panel = connection.execute(
        """
        SELECT *
        FROM current_chip_factor_daily
        WHERE trade_date = ?
        ORDER BY ts_code
        """,
        [target_date],
    ).fetchdf()
    if panel.empty:
        raise RuntimeError(f"current_chip_factor_daily has no rows for {target_date}")
    return _attach_distance_factor(panel)


def _reference_lookup(rows: Iterable[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (str(row.get("ts_code")), str(row.get("trade_date"))[:10]): dict(row)
        for row in rows
    }


def _training_rows(
    *,
    positive_samples: list[dict[str, Any]],
    template_model: dict[str, Any],
    distance_panel: pd.DataFrame,
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray, dict[str, Any]]:
    supervised = dict(template_model.get("supervised_model") or {})
    positive_vectors = _reference_lookup(supervised.get("positive_reference_vectors") or [])
    negative_vectors = _reference_lookup(supervised.get("negative_reference_vectors") or [])
    positive_keys = [
        (str(row["ts_code"]), str(row["trade_date"])[:10])
        for row in positive_samples
    ]
    # Managed training lets a reviewed positive override any older negative.
    positive_key_set = set(positive_keys)
    negative_keys = [key for key in negative_vectors if key not in positive_key_set]
    distance_lookup = {
        (str(row.ts_code), pd.Timestamp(row.trade_date).date().isoformat()): row
        for row in distance_panel.itertuples(index=False)
    }
    records: list[dict[str, Any]] = []
    labels: list[int] = []
    weights: list[float] = []
    missing: list[tuple[str, str, str]] = []
    neutral_imputations: list[dict[str, str]] = []
    for label, keys, lookup in (
        (1, positive_keys, positive_vectors),
        (0, negative_keys, negative_vectors),
    ):
        for key in keys:
            vector = lookup.get(key)
            distance = distance_lookup.get(key)
            if vector is None:
                missing.append((*key, "deployed_reference_vector"))
                continue
            record = {column: float(vector[column]) for column in ML_FEATURE_COLUMNS}
            if distance is None or not math.isfinite(float(getattr(distance, NEW_FEATURE))):
                # The existing rank builders use 0.5 for an unavailable raw
                # feature.  Keep the reviewed sample with the same explicit
                # neutral convention and disclose it instead of inventing a
                # historical distribution or silently dropping the sample.
                record[NEW_FEATURE] = 0.5
                neutral_imputations.append(
                    {"ts_code": key[0], "trade_date": key[1], "reason": "historical distribution unavailable"}
                )
            else:
                record[NEW_FEATURE] = float(getattr(distance, NEW_FEATURE))
            record.update({"ts_code": key[0], "trade_date": key[1]})
            records.append(record)
            labels.append(label)
            weights.append(
                1.0
                if label == 1
                else 1.0
                + float(np.clip(vector.get("reference_weight", 1.0), 0.0, 1.0))
            )
    if missing:
        raise RuntimeError(f"training lineage is incomplete: {missing[:10]}")
    rows = pd.DataFrame(records)
    feature_columns = [*ML_FEATURE_COLUMNS, NEW_FEATURE]
    features = rows.loc[:, feature_columns].astype("float64")
    y = np.asarray(labels, dtype="int8")
    sample_weight = np.asarray(weights, dtype="float64")
    if len(np.unique(y)) != 2:
        raise RuntimeError("experiment needs both reviewed positives and explicit negatives")
    summary = {
        "positive_rows": int(y.sum()),
        "negative_rows": int((y == 0).sum()),
        "training_rows": int(len(y)),
        "training_dates": int(rows["trade_date"].nunique()),
        "missing_rows": [],
        "neutral_missing_factor_rows": neutral_imputations,
        "neutral_missing_factor_count": len(neutral_imputations),
        "source_factor_coverage": float(
            (len(features) - len(neutral_imputations)) / len(features)
        ),
        "modeled_factor_coverage_after_neutral_policy": float(
            features[NEW_FEATURE].notna().mean()
        ),
    }
    return rows, y, sample_weight, summary


def _nearest_similarity(
    features: pd.DataFrame,
    reference_vectors: list[dict[str, Any]],
    feature_columns: list[str],
    bandwidth: float,
) -> np.ndarray:
    if not reference_vectors:
        return np.zeros(len(features), dtype="float64")
    values = features.loc[:, feature_columns].to_numpy(dtype="float64")
    references = np.asarray(
        [[float(row[column]) for column in feature_columns] for row in reference_vectors],
        dtype="float64",
    )
    reference_weights = np.asarray(
        [float(np.clip(row.get("reference_weight", 1.0), 0.0, 1.0)) for row in reference_vectors],
        dtype="float64",
    )
    squared = (
        np.sum(values * values, axis=1)[:, None]
        + np.sum(references * references, axis=1)[None, :]
        - 2.0 * values @ references.T
    )
    np.maximum(squared, 0.0, out=squared)
    distances = np.sqrt(squared / len(feature_columns))
    similarity = np.exp(-0.5 * (distances / max(float(bandwidth), 1e-9)) ** 2)
    similarity *= reference_weights[None, :]
    return similarity.max(axis=1)


def _extended_reference_vectors(
    rows: pd.DataFrame,
    labels: np.ndarray,
    sample_weight: np.ndarray,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    feature_columns = [*ML_FEATURE_COLUMNS, NEW_FEATURE]
    positives: list[dict[str, Any]] = []
    negatives: list[dict[str, Any]] = []
    for index, row in rows.iterrows():
        vector = {column: float(row[column]) for column in feature_columns}
        vector.update({"ts_code": str(row["ts_code"]), "trade_date": str(row["trade_date"])})
        if int(labels[index]) == 1:
            positives.append(vector)
        else:
            # Original negative weight is (sample_weight - 1) in [0, 1].
            vector["reference_weight"] = float(np.clip(sample_weight[index] - 1.0, 0.0, 1.0))
            negatives.append(vector)
    return positives, negatives


def _cross_validation(
    rows: pd.DataFrame,
    labels: np.ndarray,
    weights: np.ndarray,
) -> dict[str, Any]:
    base_columns = list(ML_FEATURE_COLUMNS)
    experiment_columns = [*base_columns, NEW_FEATURE]
    dates = rows["trade_date"].astype(str).to_numpy()
    predictions = {"without_new_factor": np.full(len(rows), np.nan), "with_new_factor": np.full(len(rows), np.nan)}
    folds = 0
    for held_out in sorted(set(dates)):
        train = dates != held_out
        test = ~train
        if len(np.unique(labels[train])) != 2:
            continue
        folds += 1
        for key, columns in (
            ("without_new_factor", base_columns),
            ("with_new_factor", experiment_columns),
        ):
            model = _make_model()
            model.fit(rows.loc[train, columns], labels[train], sample_weight=weights[train])
            predictions[key][test] = model.predict_proba(rows.loc[test, columns])[:, 1]
    report: dict[str, Any] = {"method": "leave-one-trade-date-out", "folds": folds}
    for key, predicted in predictions.items():
        valid = np.isfinite(predicted)
        y = labels[valid]
        probability = predicted[valid]
        metrics: dict[str, Any] = {
            "evaluated_rows": int(valid.sum()),
            "brier": float(brier_score_loss(y, probability)) if valid.any() else None,
            "balanced_accuracy_at_0_5": (
                float(balanced_accuracy_score(y, probability >= 0.5)) if valid.any() else None
            ),
            "roc_auc": (
                float(roc_auc_score(y, probability)) if len(np.unique(y)) == 2 else None
            ),
        }
        report[key] = metrics
    before = report["without_new_factor"].get("roc_auc")
    after = report["with_new_factor"].get("roc_auc")
    report["roc_auc_delta"] = None if before is None or after is None else float(after - before)
    report["warning"] = "样本量较小，交叉验证仅作试验筛查，不能替代滚动样本外验证"
    return report


def _experimental_score(
    panel: pd.DataFrame,
    model: ExtraTreesClassifier,
    template_model: dict[str, Any],
    positive_vectors: list[dict[str, Any]],
    negative_vectors: list[dict[str, Any]],
) -> pd.DataFrame:
    feature_columns = [*ML_FEATURE_COLUMNS, NEW_FEATURE]
    features = build_shape_rank_features(panel)
    features[NEW_FEATURE] = panel[NEW_FEATURE].to_numpy(dtype="float64")
    template_scored = score_shape_template_model(panel, template_model)
    lookup = features.copy()
    lookup["ts_code"] = panel["ts_code"].astype(str).to_numpy()
    lookup["trade_date"] = _normalized_dates(panel)
    lookup = lookup.set_index(["trade_date", "ts_code"])
    keys = pd.MultiIndex.from_arrays(
        [_normalized_dates(template_scored), template_scored["ts_code"].astype(str)],
        names=["trade_date", "ts_code"],
    )
    ordered = lookup.loc[keys, feature_columns]
    supervised = dict(template_model.get("supervised_model") or {})
    positive_similarity = _nearest_similarity(
        ordered,
        positive_vectors,
        feature_columns,
        float(supervised.get("positive_reference_bandwidth", 0.04)),
    )
    negative_bandwidth = float(supervised.get("negative_reference_bandwidth", 0.04))
    negative_similarity = _nearest_similarity(
        ordered,
        negative_vectors,
        feature_columns,
        negative_bandwidth,
    )
    ml_scores = model.predict_proba(ordered)[:, 1]
    ml_scores *= 1.0 - float(supervised.get("negative_reference_strength", 0.95)) * negative_similarity
    scored = blend_shape_scores(
        template_scored,
        ml_scores,
        template_rank_weight=float(supervised.get("template_rank_weight", 0.997)),
        profit_rank_weight=float(supervised.get("profit_rank_weight", 0.0)),
        positive_similarity=positive_similarity,
        positive_score_bonus=float(supervised.get("positive_score_bonus", 0.03)),
        negative_similarity=negative_similarity,
        negative_score_penalty=float(supervised.get("negative_final_score_penalty", 0.02)),
        low_profit_threshold=float(supervised.get("low_profit_threshold", 0.50)),
        low_profit_score_penalty=float(supervised.get("low_profit_score_penalty", 0.10)),
        peak2_ratio_penalty_threshold=float(supervised.get("peak2_ratio_penalty_threshold", 0.40)),
        peak2_ratio_penalty_strength=float(supervised.get("peak2_ratio_penalty_strength", 0.18)),
        peak2_ratio_penalty_power=float(supervised.get("peak2_ratio_penalty_power", 1.4)),
        peak_count_penalty_threshold=float(supervised.get("peak_count_penalty_threshold", 3.0)),
        peak_count_penalty_strength=float(supervised.get("peak_count_penalty_strength", 0.08)),
        peak_count_penalty_power=float(supervised.get("peak_count_penalty_power", 1.2)),
        peak_width_penalty_threshold=float(supervised.get("peak_width_penalty_threshold", 0.12)),
        peak_width_penalty_strength=float(supervised.get("peak_width_penalty_strength", 0.08)),
        peak_width_penalty_power=float(supervised.get("peak_width_penalty_power", 1.2)),
        unprofitable_main_peak_penalty=float(supervised.get("unprofitable_main_peak_penalty", 0.0)),
        selection_size=int(template_model.get("selection_size", 6)),
    )
    return scored


def _top_rows(scored: pd.DataFrame, panel: pd.DataFrame, limit: int = 8) -> list[dict[str, Any]]:
    factor = panel.loc[
        :,
        [
            "ts_code",
            "cost_line_price",
            "main_peak_price_for_distance",
            "cost_line_main_peak_signed_distance_ratio",
            "cost_line_main_peak_abs_distance_ratio",
            NEW_FEATURE,
        ],
    ]
    merged = scored.merge(factor, on="ts_code", how="left")
    merged = merged.sort_values(["shape_rank", "ts_code"]).head(limit)
    rows: list[dict[str, Any]] = []
    for row in merged.to_dict("records"):
        rows.append(
            {
                "rank": int(row["shape_rank"]),
                "code": str(row["ts_code"]),
                "name": str(row.get("name") or row["ts_code"]),
                "industry": str(row.get("industry") or ""),
                "score": round(float(row["shape_score"]) * 100.0, 6),
                "cost_line_price": round(float(row["cost_line_price"]), 6),
                "main_peak_price": round(float(row["main_peak_price_for_distance"]), 6),
                "signed_distance_pct": round(
                    float(row["cost_line_main_peak_signed_distance_ratio"]) * 100.0, 6
                ),
                "absolute_distance_pct": round(
                    float(row["cost_line_main_peak_abs_distance_ratio"]) * 100.0, 6
                ),
                "distance_rank_pct": round(float(row[NEW_FEATURE]) * 100.0, 6),
            }
        )
    return rows


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    temporary.replace(path)


def _write_scope_artifact(
    *,
    destination: Path,
    version: str,
    source_version: str,
    model: ExtraTreesClassifier,
    template_model: dict[str, Any],
    training: dict[str, Any],
    validation: dict[str, Any],
    positive_vectors: list[dict[str, Any]],
    negative_vectors: list[dict[str, Any]],
) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    feature_columns = [*ML_FEATURE_COLUMNS, NEW_FEATURE]
    metadata = {
        "model_version": version,
        "source_online_model_version": source_version,
        "status": "offline_experiment_not_deployed",
        "trained_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "feature_columns": feature_columns,
        "factor_definition": FACTOR_DEFINITION,
        "training": training,
        "validation": validation,
        "feature_importance": [
            {"feature": str(feature), "importance": float(importance)}
            for feature, importance in sorted(
                zip(feature_columns, model.feature_importances_),
                key=lambda item: float(item[1]),
                reverse=True,
            )
        ],
    }
    joblib.dump(
        {
            "model_version": version,
            "source_online_model_version": source_version,
            "status": "offline_experiment_not_deployed",
            "model": model,
            "feature_columns": feature_columns,
            "template_model": template_model,
            "positive_reference_vectors": positive_vectors,
            "negative_reference_vectors": negative_vectors,
            "factor_definition": FACTOR_DEFINITION,
        },
        destination / "model.joblib",
    )
    _atomic_json(destination / "model.json", metadata)


def run(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.resolve()
    # Refuse known production roots even if a caller passes one accidentally.
    forbidden = {
        (ROOT / "data" / "chip_shape_model_current").resolve(),
        (ROOT / "data" / "chip_shape_model_candidate_current").resolve(),
        (ROOT / "engine" / "models" / "chip_formal").resolve(),
        (ROOT / "engine" / "models" / "chip_candidate").resolve(),
    }
    if output in forbidden or any(parent in forbidden for parent in output.parents):
        raise ValueError("experiment output may not be inside a production model directory")
    output.mkdir(parents=True, exist_ok=True)
    registry = _json(args.registry)
    model_paths = {
        "formal": ROOT / "data" / "chip_shape_model_current" / "model.joblib",
        "candidate": ROOT / "data" / "chip_shape_model_candidate_current" / "model.joblib",
    }
    positive_dates = {
        str(row["trade_date"])[:10]
        for scope in ("formal", "candidate")
        for row in registry["scopes"][scope]["samples"]
    }
    # Negative dates are read from deployed vectors, which are the exact
    # negative examples used by the currently deployed model revision.
    loaded = {scope: joblib.load(path) for scope, path in model_paths.items()}
    negative_dates = {
        str(row["trade_date"])[:10]
        for artifact in loaded.values()
        for row in artifact["template_model"].get("supervised_model", {}).get(
            "negative_reference_vectors", []
        )
    }
    with duckdb.connect(str(args.database), read_only=True) as connection:
        distance_panel = _load_historical_distance_panel(
            connection,
            positive_dates | negative_dates,
        )
        target_panel = _load_target_panel(connection, args.trade_date)

    scope_results: dict[str, Any] = {}
    for scope in ("formal", "candidate"):
        artifact = loaded[scope]
        template_model = dict(artifact["template_model"])
        samples = list(registry["scopes"][scope]["samples"])
        training_rows, labels, weights, training_summary = _training_rows(
            positive_samples=samples,
            template_model=template_model,
            distance_panel=distance_panel,
        )
        feature_columns = [*ML_FEATURE_COLUMNS, NEW_FEATURE]
        model = _make_model()
        model.fit(training_rows.loc[:, feature_columns], labels, sample_weight=weights)
        positives, negatives = _extended_reference_vectors(training_rows, labels, weights)
        validation = _cross_validation(training_rows, labels, weights)
        online = _score_shape_panel_with_model(target_panel, model_paths[scope])
        experimental = _experimental_score(
            target_panel,
            model,
            template_model,
            positives,
            negatives,
        )
        online_top = _top_rows(online, target_panel)
        experiment_top = _top_rows(experimental, target_panel)
        online_codes = [row["code"] for row in online_top]
        experiment_codes = [row["code"] for row in experiment_top]
        source_version = str(artifact.get("model_version") or template_model.get("model_version"))
        version = (
            f"{source_version}__exp_cost_peak_distance_"
            f"{scope}_r{registry['scopes'][scope].get('revision', 0)}_{args.trade_date.replace('-', '')}"
        )
        training_summary.update(
            {
                "registry_revision": int(registry["scopes"][scope].get("revision") or 0),
                "reviewed_positive_count": len(samples),
                "negative_source": "deployed model explicit negative reference vectors",
                "label_policy": "reviewed positives + currently deployed explicit negatives only",
                "future_columns_used": [],
            }
        )
        _write_scope_artifact(
            destination=output / scope,
            version=version,
            source_version=source_version,
            model=model,
            template_model=template_model,
            training=training_summary,
            validation=validation,
            positive_vectors=positives,
            negative_vectors=negatives,
        )
        scope_results[scope] = {
            "status": "offline_experiment_not_deployed",
            "version": version,
            "source_online_version": source_version,
            "training": training_summary,
            "validation": validation,
            "new_factor_importance": float(
                model.feature_importances_[feature_columns.index(NEW_FEATURE)]
            ),
            "top8_overlap_count": len(set(online_codes) & set(experiment_codes)),
            "top8_added": [code for code in experiment_codes if code not in online_codes],
            "top8_removed": [code for code in online_codes if code not in experiment_codes],
            "online_top8": online_top,
            "experimental_top8": experiment_top,
            "artifact_path": str(output / scope),
        }

    result = {
        "status": "completed_offline_not_deployed",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "target_trade_date": args.trade_date,
        "target_rows": int(len(target_panel)),
        "factor_definition": FACTOR_DEFINITION,
        "lineage": {
            "database": str(args.database.resolve()),
            "database_size": args.database.stat().st_size,
            "database_mtime": datetime.fromtimestamp(args.database.stat().st_mtime).astimezone().isoformat(),
            "registry": str(args.registry.resolve()),
            "registry_sha256": _sha256(args.registry),
            "formal_online_artifact": str(model_paths["formal"].resolve()),
            "formal_online_artifact_sha256": _sha256(model_paths["formal"]),
            "candidate_online_artifact": str(model_paths["candidate"].resolve()),
            "candidate_online_artifact_sha256": _sha256(model_paths["candidate"]),
            "historical_factor_table": "chip_factor_daily",
            "target_factor_table": "current_chip_factor_daily",
        },
        "safety": {
            "production_registry_modified": False,
            "production_models_modified": False,
            "production_rank_table_modified": False,
            "third_model_trained": False,
            "note": "第三模型没有独立正样本，本实验不训练第三模型",
        },
        "scopes": scope_results,
    }
    _atomic_json(output / "comparison.json", result)
    return result


def main() -> int:
    result = run(parse_args())
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
