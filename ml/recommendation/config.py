"""Configuration for offline training and readiness checks."""

from dataclasses import dataclass
import os


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


@dataclass(frozen=True)
class TrainingConfig:
    min_students: int = _int("RECOMMENDATION_MIN_TRAINING_STUDENTS", 100)
    min_requests: int = _int("RECOMMENDATION_MIN_TRAINING_REQUESTS", 500)
    min_rows: int = _int("RECOMMENDATION_MIN_LABELLED_ROWS", 10_000)
    min_positive: int = _int("RECOMMENDATION_MIN_POSITIVE_OUTCOMES", 100)
    min_negative: int = _int("RECOMMENDATION_MIN_NEGATIVE_OUTCOMES", 100)
    min_interactions: int = _int("RECOMMENDATION_MIN_INTERACTIONS", 20)
    min_courses: int = _int("RECOMMENDATION_MIN_COURSES", 5)
    min_labels: int = _int("RECOMMENDATION_MIN_LABEL_DIVERSITY", 3)
    test_positive_label: int = 3
    random_seed: int = _int("RECOMMENDATION_TRAINING_SEED", 2024)
    max_estimators: int = _int("RECOMMENDATION_MAX_ESTIMATORS", 300)


def readiness(rows: list[dict], config: TrainingConfig | None = None) -> dict:
    config = config or TrainingConfig()
    request_ids = {row["query_id"] for row in rows}
    students = {row["student_id_hash"] for row in rows}
    courses = set()
    for row in rows:
        courses.update(row.get("course_groups") or [])
        if row.get("course_group"):
            courses.add(row["course_group"])
    interactions = {
        row.get("candidate_id_hash")
        for row in rows
        if row.get("candidate_id_hash")
    }
    positives = sum(1 for row in rows if int(row["label"]) >= config.test_positive_label)
    negatives = sum(1 for row in rows if int(row["label"]) == 0)
    labels = {int(row["label"]) for row in rows}
    checks = {
        "unique_students": (len(students), config.min_students),
        "recommendation_requests": (len(request_ids), config.min_requests),
        "labelled_candidate_rows": (len(rows), config.min_rows),
        "positive_outcomes": (positives, config.min_positive),
        "negative_outcomes": (negatives, config.min_negative),
        "groups_or_partner_interactions": (len(interactions), config.min_interactions),
        "courses_represented": (len(courses), config.min_courses),
        "label_diversity": (len(labels), config.min_labels),
    }
    failed = [f"{name} {observed}/{required}" for name, (observed, required) in checks.items() if observed < required]
    return {
        "ready": not failed,
        "reason": None if not failed else "Not enough real data for training: " + ", ".join(failed),
        "checks": {
            name: {"observed": observed, "required": required, "ready": observed >= required}
            for name, (observed, required) in checks.items()
        },
        "rows": len(rows),
        "students": len(students),
        "requests": len(request_ids),
        "positive": positives,
        "negative": negatives,
        "label_diversity": len(labels),
    }
