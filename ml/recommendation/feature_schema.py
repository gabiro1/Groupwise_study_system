"""The versioned feature contract used by training and inference."""

import math

FEATURE_SCHEMA_VERSION = "recommendation-features-v1"
FEATURE_NAMES = (
    "shared_course_count",
    "same_programme",
    "course_compatibility",
    "skill_complementarity",
    "topic_similarity",
    "goal_compatibility",
    "availability_overlap",
    "mode_compatibility",
    "style_compatibility",
    "session_length_compatibility",
    "preference_compatibility",
    "group_size_compatibility",
    "activity_compatibility",
    "candidate_activity_score",
    "group_dormancy",
    "capacity_available_ratio",
    "group_age_days",
    "profile_confidence",
    "profile_fields_completed",
    "candidate_type_group",
    "requester_prior_accepted_count",
    "requester_helpful_feedback_rate",
    "requester_group_retention_rate",
)

EXCLUDED_FIELDS = frozenset(
    {
        "gender",
        "religion",
        "race",
        "ethnicity",
        "disability",
        "password",
        "token",
        "private_message",
        "raw_name",
        "raw_email",
    }
)


def validate_features(features: dict) -> list[str]:
    errors: list[str] = []
    if not isinstance(features, dict):
        return ["features must be an object"]

    for name in FEATURE_NAMES:
        if name not in features:
            errors.append(f"missing feature: {name}")
            continue
        value = features[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(f"feature {name} must be numeric")
            continue
        if not math.isfinite(value):
            errors.append(f"feature {name} must be finite")
            continue
        maximum = 4 if name == "shared_course_count" else 1
        if not 0 <= value <= maximum:
            errors.append(f"feature {name} must be between 0 and {maximum}")

    for name in features:
        if name not in FEATURE_NAMES:
            errors.append(f"unknown feature: {name}")

    return errors
