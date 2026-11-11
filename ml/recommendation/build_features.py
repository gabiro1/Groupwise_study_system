"""Load and validate anonymized grouped ranking rows."""

import json
from pathlib import Path
from typing import Iterable

from .feature_schema import EXCLUDED_FIELDS, FEATURE_NAMES, FEATURE_SCHEMA_VERSION, validate_features


REQUIRED_ROW_FIELDS = {
    "query_id",
    "student_id_hash",
    "candidate_id_hash",
    "candidate_type",
    "label",
    "timestamp",
    "source_model_version",
    "feature_schema_version",
    "features",
}

ALLOWED_ROW_FIELDS = REQUIRED_ROW_FIELDS | {
    "dataset_kind",
    "baseline_score",
    "confidence",
    "accepted",
    "clicked",
    "helpful",
    "joined",
    "retained",
    "course_group",
    "course_groups",
    "academic_level_group",
    "profile_completeness",
    "label_stage",
}


def load_jsonl(path: str | Path) -> list[dict]:
    rows: list[dict] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON at line {line_number}: {error}") from error
    return rows


def validate_rows(rows: Iterable[dict], *, allow_synthetic: bool = False) -> list[dict]:
    rows = list(rows)
    errors: list[str] = []
    query_seen: set[str] = set()
    for index, row in enumerate(rows):
        unknown_fields = set(row) - ALLOWED_ROW_FIELDS
        if unknown_fields:
            errors.append(f"row {index}: unknown fields {sorted(unknown_fields)}")
        missing = REQUIRED_ROW_FIELDS - set(row)
        if missing:
            errors.append(f"row {index}: missing {sorted(missing)}")
        if row.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
            errors.append(f"row {index}: unsupported feature schema")
        if row.get("candidate_type") not in {"STUDENT", "GROUP"}:
            errors.append(f"row {index}: candidate_type must be STUDENT or GROUP")
        if not isinstance(row.get("label"), int) or not 0 <= row["label"] <= 6:
            errors.append(f"row {index}: label must be an integer from 0 to 6")
        feature_errors = validate_features(row.get("features"))
        errors.extend(f"row {index}: {error}" for error in feature_errors)
        if not allow_synthetic and row.get("dataset_kind") == "SYNTHETIC":
            errors.append(f"row {index}: synthetic data is not allowed for a real training run")
        for excluded in EXCLUDED_FIELDS:
            if excluded in row or excluded in row.get("features", {}):
                errors.append(f"row {index}: excluded field {excluded} present")
        query_seen.add(str(row.get("query_id")))

    if errors:
        raise ValueError("feature validation failed: " + "; ".join(errors[:20]))
    if not rows:
        raise ValueError("dataset is empty")
    return rows


def query_groups(rows: list[dict]) -> tuple[list[list[dict]], list[int]]:
    grouped: dict[str, list[dict]] = {}
    order: list[str] = []
    for row in rows:
        query_id = str(row["query_id"])
        if query_id not in grouped:
            grouped[query_id] = []
            order.append(query_id)
        grouped[query_id].append(row)
    groups = [grouped[query_id] for query_id in order]
    return groups, [len(group) for group in groups]


def matrix(rows: list[dict]):
    """Return X, y, query sizes, preserving query contiguity."""
    groups, sizes = query_groups(rows)
    ordered = [row for group in groups for row in group]
    x = [[float(row["features"][name]) for name in FEATURE_NAMES] for row in ordered]
    y = [int(row["label"]) for row in ordered]
    return x, y, sizes, ordered


def time_split(rows: list[dict], train_ratio: float = 0.70, validation_ratio: float = 0.15):
    """Split by request time while keeping all candidates from a query together."""
    groups, _ = query_groups(sorted(rows, key=lambda row: (row["timestamp"], row["query_id"])))
    if len(groups) < 3:
        raise ValueError("at least three time-ordered recommendation requests are required")
    train_end = min(len(groups) - 2, max(1, int(len(groups) * train_ratio)))
    validation_end = min(len(groups) - 1, max(train_end + 1, int(len(groups) * (train_ratio + validation_ratio))))
    return (
        [row for group in groups[:train_end] for row in group],
        [row for group in groups[train_end:validation_end] for row in group],
        [row for group in groups[validation_end:] for row in group],
    )
