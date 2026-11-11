"""Offline ranking and operational metrics."""

import math
from collections import defaultdict


def _ordered(rows, scores):
    return sorted(range(len(rows)), key=lambda index: (-float(scores[index]), index))


def _queries(rows):
    result = defaultdict(list)
    for index, row in enumerate(rows):
        result[str(row["query_id"])].append(index)
    return list(result.values())


def _dcg(labels, k):
    total = 0.0
    for position, label in enumerate(labels[:k], 1):
        total += (2 ** int(label) - 1) / math.log2(position + 1)
    return total


def ranking_metrics(rows: list[dict], scores: list[float], positive_label: int = 3) -> dict:
    if len(rows) != len(scores):
        raise ValueError("rows and scores must have equal length")
    precision = {k: [] for k in (1, 3, 5)}
    recalls = []
    ndcgs = []
    reciprocal_ranks = []
    for indices in _queries(rows):
        ranking = sorted(indices, key=lambda index: (-float(scores[index]), index))
        labels = [int(rows[index]["label"]) for index in indices]
        ideal = sorted(labels, reverse=True)
        ndcgs.append(_dcg([int(rows[index]["label"]) for index in ranking], 5) / _dcg(ideal, 5) if _dcg(ideal, 5) else 0.0)
        relevant = sum(1 for label in labels if label >= positive_label)
        for k in precision:
            precision[k].append(sum(int(rows[index]["label"]) >= positive_label for index in ranking[:k]) / min(k, len(ranking)))
        if relevant:
            recalls.append(sum(int(rows[index]["label"]) >= positive_label for index in ranking[:5]) / relevant)
            first = next((position for position, index in enumerate(ranking, 1) if int(rows[index]["label"]) >= positive_label), None)
            reciprocal_ranks.append(1 / first if first else 0.0)

    accepted = [bool(row.get("accepted")) for row in rows]
    clicked = [bool(row.get("clicked")) for row in rows]
    helpful = [row.get("helpful") for row in rows if row.get("helpful") is not None]
    joined = [bool(row.get("joined")) for row in rows]
    retained = [bool(row.get("retained")) for row in rows if row.get("joined")]
    return {
        "precision_at_1": sum(precision[1]) / len(precision[1]) if precision[1] else 0.0,
        "precision_at_3": sum(precision[3]) / len(precision[3]) if precision[3] else 0.0,
        "precision_at_5": sum(precision[5]) / len(precision[5]) if precision[5] else 0.0,
        "recall_at_5": sum(recalls) / len(recalls) if recalls else None,
        "ndcg_at_5": sum(ndcgs) / len(ndcgs) if ndcgs else 0.0,
        "mrr": sum(reciprocal_ranks) / len(reciprocal_ranks) if reciprocal_ranks else None,
        "acceptance_rate": sum(accepted) / len(accepted) if accepted else 0.0,
        "click_through_rate": sum(clicked) / len(clicked) if clicked else 0.0,
        "helpful_feedback_rate": sum(helpful) / len(helpful) if helpful else None,
        "group_join_rate": sum(joined) / len(joined) if joined else 0.0,
        "group_retention_rate": sum(retained) / len(retained) if retained else None,
        "query_count": len(_queries(rows)),
        "row_count": len(rows),
    }


def calibration_metrics(rows: list[dict], scores: list[float], positive_label: int = 3) -> dict:
    """Reliability of a bounded rank score, reported as descriptive ECE only."""
    if not rows:
        return {"ece": None, "bins": []}
    buckets = [[] for _ in range(10)]
    for row, score in zip(rows, scores):
        normalized = max(0.0, min(1.0, float(score) / 100.0))
        buckets[min(9, int(normalized * 10))].append((normalized, int(row["label"]) >= positive_label))
    bins = []
    total_error = 0.0
    for bucket in buckets:
        if not bucket:
            continue
        predicted = sum(item[0] for item in bucket) / len(bucket)
        observed = sum(item[1] for item in bucket) / len(bucket)
        total_error += abs(predicted - observed) * len(bucket) / len(rows)
        bins.append({"count": len(bucket), "predicted": predicted, "observed": observed})
    return {"ece": total_error, "bins": bins}


def evaluate(rows: list[dict], scores: list[float], positive_label: int = 3) -> dict:
    result = ranking_metrics(rows, scores, positive_label)
    result["calibration"] = calibration_metrics(rows, scores, positive_label)
    return result


def evaluate_against_baseline(rows: list[dict], model_scores: list[float], positive_label: int = 3) -> dict:
    baseline_scores = [float(row.get("baseline_score", 0.0)) for row in rows]
    return {
        "model": evaluate(rows, model_scores, positive_label),
        "baseline": evaluate(rows, baseline_scores, positive_label),
        "primary_metric": "ndcg_at_5",
    }


def segmented_metrics(rows: list[dict], scores: list[float], *, minimum_rows: int = 25) -> dict:
    segments = {
        "candidate_type": lambda row: row.get("candidate_type"),
        "profile_completeness": lambda row: row.get("profile_completeness", "unknown"),
        "course": lambda row: row.get("course_group"),
        "academic_level": lambda row: row.get("academic_level_group"),
    }
    output = {}
    for name, selector in segments.items():
        groups = defaultdict(list)
        for index, row in enumerate(rows):
            key = selector(row)
            if key:
                groups[str(key)].append(index)
        output[name] = {}
        for key, indices in groups.items():
            if len(indices) < minimum_rows:
                continue
            subset_rows = [rows[index] for index in indices]
            subset_scores = [scores[index] for index in indices]
            output[name][key] = evaluate(subset_rows, subset_scores)
    return output
