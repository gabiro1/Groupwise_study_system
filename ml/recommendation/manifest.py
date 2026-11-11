"""Model manifest and checksum helpers."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from .feature_schema import FEATURE_NAMES, FEATURE_SCHEMA_VERSION


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def feature_schema_hash() -> str:
    payload = json.dumps(
        {"version": FEATURE_SCHEMA_VERSION, "features": FEATURE_NAMES},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def write_manifest(path: str | Path, manifest: dict) -> None:
    Path(path).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_manifest(
    *,
    model_version: str,
    model_path: str | Path,
    dataset_kind: str,
    rows: list[dict],
    metrics: dict,
    git_commit: str | None,
    application_version: str | None,
    fairness_checks: dict,
) -> dict:
    timestamps = [row["timestamp"] for row in rows]
    return {
        "model_version": model_version,
        "algorithm": "LIGHTGBM_LAMBDAMART",
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "feature_schema_hash": feature_schema_hash(),
        "feature_names": list(FEATURE_NAMES),
        "training_data_kind": dataset_kind,
        "training_data_date_range": {
            "start": min(timestamps) if timestamps else None,
            "end": max(timestamps) if timestamps else None,
        },
        "anonymized_row_count": len(rows),
        "unique_student_count": len({row["student_id_hash"] for row in rows}),
        "unique_request_count": len({row["query_id"] for row in rows}),
        "positive_label_count": sum(1 for row in rows if int(row["label"]) >= 3),
        "negative_label_count": sum(1 for row in rows if int(row["label"]) == 0),
        "training_metrics": metrics.get("training", {}),
        "validation_metrics": metrics.get("validation", {}),
        "test_metrics": metrics.get("test", {}),
        "baseline_metrics": metrics.get("baseline", {}),
        "fairness_checks": fairness_checks,
        "created_timestamp": datetime.now(timezone.utc).isoformat(),
        "git_commit": git_commit,
        "application_version": application_version,
        "artifact_checksum": sha256_file(model_path),
    }
