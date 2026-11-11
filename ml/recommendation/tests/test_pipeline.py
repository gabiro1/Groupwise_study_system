import unittest

from ml.recommendation.build_features import matrix, time_split, validate_rows
from ml.recommendation.evaluate import evaluate
from ml.recommendation.feature_schema import validate_features
from ml.recommendation.labels import LabelPolicy


FEATURES = {
    name: 0.5
    for name in (
        "shared_course_count", "same_programme", "course_compatibility",
        "skill_complementarity", "topic_similarity", "goal_compatibility",
        "availability_overlap", "mode_compatibility", "style_compatibility",
        "session_length_compatibility", "preference_compatibility",
        "group_size_compatibility", "activity_compatibility",
        "candidate_activity_score", "group_dormancy", "capacity_available_ratio",
        "group_age_days", "profile_confidence", "profile_fields_completed",
        "candidate_type_group", "requester_prior_accepted_count",
        "requester_helpful_feedback_rate", "requester_group_retention_rate",
    )
}


def row(query_id, label, index=0):
    return {
        "query_id": query_id,
        "student_id_hash": f"student-{query_id}",
        "candidate_id_hash": f"candidate-{query_id}-{index}",
        "candidate_type": "STUDENT",
        "feature_schema_version": "recommendation-features-v1",
        "source_model_version": "weighted-v1.0.0",
        "timestamp": f"2026-01-0{index + 1}T00:00:00+00:00",
        "features": FEATURES,
        "label": label,
        "baseline_score": float(label * 10),
    }


class PipelineTests(unittest.TestCase):
    def test_label_policy_keeps_shown_as_observed(self):
        self.assertEqual(LabelPolicy().label({"shown_at": "2026-01-01T00:00:00+00:00"}), 1)
        self.assertEqual(LabelPolicy().label({"shown_at": "2026-01-01T00:00:00+00:00", "rejected_at": "2026-01-02T00:00:00+00:00"}), 0)
        self.assertEqual(
            LabelPolicy().label({"joined_at": "2026-01-01T00:00:00+00:00", "retained": True}),
            5,
        )
        self.assertIsNone(LabelPolicy().label({"joined_at": "2026-01-01T00:00:00+00:00", "retained": False}))

    def test_feature_schema_rejects_non_finite_or_out_of_range_values(self):
        self.assertEqual(validate_features(FEATURES), [])
        self.assertTrue(validate_features({**FEATURES, "group_age_days": 2}))
        self.assertTrue(validate_features({**FEATURES, "group_age_days": float("nan")}))

    def test_rows_reject_private_fields(self):
        with self.assertRaises(ValueError):
            validate_rows([{**row("q1", 1), "raw_email": "student@example.test"}])

    def test_rows_are_grouped_and_split_as_queries(self):
        rows = [row("q1", 0, 0), row("q1", 3, 0), row("q2", 1, 1), row("q3", 4, 2)]
        validate_rows(rows)
        train, validation, test = time_split(rows)
        self.assertEqual({item["query_id"] for item in train} & {item["query_id"] for item in validation}, set())
        self.assertEqual({item["query_id"] for item in validation} & {item["query_id"] for item in test}, set())
        x, y, groups, ordered = matrix(rows)
        self.assertEqual(len(x), len(y))
        self.assertEqual(sum(groups), len(ordered))

    def test_evaluation_is_bounded(self):
        rows = [row("q1", 3, 0), row("q1", 0, 1)]
        result = evaluate(rows, [0.9, 0.1])
        self.assertEqual(result["precision_at_1"], 1.0)
        self.assertGreaterEqual(result["ndcg_at_5"], 0.0)
        self.assertLessEqual(result["ndcg_at_5"], 1.0)


if __name__ == "__main__":
    unittest.main()
