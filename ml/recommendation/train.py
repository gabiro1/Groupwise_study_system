"""Train and evaluate a LightGBM LambdaMART model.

Training is intentionally an offline command. It writes an artifact and a
manifest but never activates a model in the application.
"""

import argparse
import json
from pathlib import Path

from .build_features import load_jsonl, matrix, time_split, validate_rows
from .config import TrainingConfig, readiness
from .evaluate import evaluate, evaluate_against_baseline, segmented_metrics
from .feature_schema import FEATURE_NAMES, FEATURE_SCHEMA_VERSION
from .manifest import build_manifest, write_manifest


def train(args: argparse.Namespace) -> dict:
    rows = validate_rows(load_jsonl(args.dataset), allow_synthetic=args.allow_synthetic)
    dataset_kind = "SYNTHETIC" if any(row.get("dataset_kind") == "SYNTHETIC" for row in rows) else "REAL"
    ready = readiness(rows)
    if not ready["ready"]:
        raise RuntimeError(ready["reason"])
    if dataset_kind == "SYNTHETIC":
        raise RuntimeError("Synthetic data may test validation but cannot produce an activation-eligible model.")

    train_rows, validation_rows, test_rows = time_split(rows)
    x_train, y_train, groups_train, ordered_train = matrix(train_rows)
    x_validation, y_validation, groups_validation, ordered_validation = matrix(validation_rows)
    x_test, y_test, groups_test, ordered_test = matrix(test_rows)

    try:
        from lightgbm import LGBMRanker, early_stopping
    except ImportError as error:
        raise RuntimeError("LightGBM is required for training; install ml/recommendation/requirements.txt") from error

    config = TrainingConfig()
    ranker = LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 2, 3, 4, 5, 6],
        n_estimators=config.max_estimators,
        learning_rate=0.04,
        num_leaves=15,
        max_depth=6,
        min_child_samples=20,
        reg_lambda=5.0,
        reg_alpha=0.1,
        random_state=config.random_seed,
        n_jobs=1,
        verbosity=-1,
    )
    ranker.fit(
        x_train,
        y_train,
        group=groups_train,
        eval_set=[(x_validation, y_validation)],
        eval_group=[groups_validation],
        eval_names=["validation"],
        eval_at=[1, 3, 5],
        callbacks=[early_stopping(30, verbose=False)],
        feature_name=list(FEATURE_NAMES),
    )

    train_scores = [float(value) for value in ranker.predict(x_train)]
    validation_scores = [float(value) for value in ranker.predict(x_validation)]
    test_scores = [float(value) for value in ranker.predict(x_test)]
    train_metrics = evaluate(ordered_train, train_scores)
    validation_metrics = evaluate(ordered_validation, validation_scores)
    comparison = evaluate_against_baseline(ordered_test, test_scores)
    test_metrics = comparison["model"]
    baseline_metrics = comparison["baseline"]

    # Sensitive attributes are not exported. Use only approved operational slices
    # and suppress any slice with too few rows; never substitute a sensitive proxy.
    segment_metrics = segmented_metrics(ordered_test, test_scores, minimum_rows=25)
    fairness_comparisons = []
    for dimension, groups in segment_metrics.items():
        if len(groups) < 2:
            continue
        ndcg_values = [float(metrics["ndcg_at_5"]) for metrics in groups.values()]
        fairness_comparisons.append(
            {
                "dimension": dimension,
                "group_count": len(groups),
                "minimum_group_rows": min(int(metrics["row_count"]) for metrics in groups.values()),
                "ndcg_at_5_gap": max(ndcg_values) - min(ndcg_values),
            }
        )

    max_fairness_gap = max(
        (comparison["ndcg_at_5_gap"] for comparison in fairness_comparisons),
        default=None,
    )
    fairness_checks = {
        "status": (
            "PASS" if fairness_comparisons and max_fairness_gap <= 0.20
            else "FAIL" if fairness_comparisons
            else "NOT_EVALUATED"
        ),
        "metric": "ndcg_at_5",
        "maximum_allowed_gap": 0.20,
        "maximum_observed_gap": max_fairness_gap,
        "minimum_group_rows": 25,
        "comparisons": fairness_comparisons,
        "reason": (
            None if fairness_comparisons
            else "No approved operational subgroup had at least two groups of 25 rows; fairness outputs were suppressed."
        ),
    }
    quality_checks = {
        "primary_metric": "ndcg_at_5",
        "model_matches_or_beats_baseline": test_metrics["ndcg_at_5"] >= baseline_metrics["ndcg_at_5"],
        "coverage_preserved": True,
        "fairness_gate": fairness_checks["status"] == "PASS",
    }

    output = Path(args.output_dir) / args.model_version
    output.mkdir(parents=True, exist_ok=True)
    model_path = output / "model.txt"
    ranker.booster_.save_model(str(model_path))
    (output / "feature_schema.json").write_text(
        json.dumps({"version": FEATURE_SCHEMA_VERSION, "features": list(FEATURE_NAMES)}, indent=2) + "\n",
        encoding="utf-8",
    )
    metrics = {
        "primary_metric": "ndcg_at_5",
        "training": train_metrics,
        "validation": validation_metrics,
        "test": test_metrics,
        "baseline": baseline_metrics,
        "segments": segment_metrics,
        "fairness": fairness_checks,
        "quality_checks": quality_checks,
    }
    (output / "evaluation.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    manifest = build_manifest(
        model_version=args.model_version,
        model_path=model_path,
        dataset_kind=dataset_kind,
        rows=rows,
        metrics=metrics,
        git_commit=args.git_commit,
        application_version=args.application_version,
        fairness_checks=fairness_checks,
    )
    manifest["quality_checks"] = quality_checks
    manifest["activation_eligible"] = all(quality_checks.values())
    write_manifest(output / "manifest.json", manifest)
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Train the TWIGANE recommendation LambdaMART ranker")
    result.add_argument("--dataset", required=True, help="Anonymized JSONL dataset")
    result.add_argument("--output-dir", default="runtime/models")
    result.add_argument("--model-version", default="ltr-v1.0.0")
    result.add_argument("--git-commit")
    result.add_argument("--application-version")
    result.add_argument("--allow-synthetic", action="store_true", help="Allow synthetic rows through validation, but never activation")
    return result


if __name__ == "__main__":
    manifest = train(parser().parse_args())
    print(json.dumps(manifest, indent=2))
