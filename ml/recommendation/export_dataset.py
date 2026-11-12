"""Export approved recommendation outcomes as anonymized JSONL rows."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from pathlib import Path

from .config import readiness
from .labels import LabelPolicy, label_stage


SQL = """
SELECT rr.id AS request_id, rr.student_id, rr.created_at AS request_at,
       rr.serving_model_version, rr.model_version_id, rr.feature_schema_version,
       r.id AS recommendation_id, r.kind AS candidate_type,
       r.target_group_id, r.target_workspace_id, r.feature_values,
       COALESCE(r.baseline_score, r.score) AS baseline_score, r.confidence,
       r.shown_at, r.clicked_at, r.accepted_at, r.rejected_at,
       rf.helpful, rf.reason,
       mo.joined_at, mo.left_at, mo.sessions_attended,
       gf.overall_rating,
       COALESCE(group_course.id, request_course.id) AS course_id,
       COALESCE(group_course.level, request_course.level) AS course_level,
       ARRAY(
         SELECT requested_course.course_id
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(rr.requirements->'courseIds') = 'array'
                  THEN rr.requirements->'courseIds' ELSE '[]'::jsonb END
           ) AS requested_course(course_id)
       ) AS request_course_ids
  FROM recommendations r
  JOIN recommendation_requests rr ON rr.id = r.request_id
  LEFT JOIN recommendation_feedback rf ON rf.recommendation_id = r.id
  LEFT JOIN group_membership_outcomes mo ON mo.recommendation_id = r.id
  LEFT JOIN group_feedback gf ON gf.workspace_id = mo.workspace_id AND gf.student_id = r.student_id
  LEFT JOIN workspaces target_workspace ON target_workspace.id = r.target_workspace_id
   LEFT JOIN study_groups target_group ON target_group.id = COALESCE(r.target_group_id, target_workspace.group_id)
  LEFT JOIN courses group_course ON group_course.id = target_group.course_id
  LEFT JOIN courses request_course ON request_course.id = rr.course_id
  WHERE r.kind = 'GROUP' AND r.feature_values <> '{}'::jsonb
"""


def hash_id(value, salt: str) -> str:
    return hmac.new(salt.encode("utf-8"), str(value).encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def retained(row, as_of=None) -> bool:
    joined = row.get("joined_at")
    if not joined:
        return False
    as_of = as_of or datetime.now(timezone.utc)
    if joined.tzinfo is None:
        joined = joined.replace(tzinfo=timezone.utc)
    if joined + timedelta(days=30) > as_of:
        return False
    left = row.get("left_at")
    if not left:
        return True
    if left.tzinfo is None:
        left = left.replace(tzinfo=timezone.utc)
    return (left - joined).total_seconds() >= 30 * 86_400


def export(database_url: str, output: str, salt: str, *, from_date=None, to_date=None) -> dict:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise RuntimeError("psycopg is required for dataset export") from error

    params = []
    predicates = []
    if from_date:
        predicates.append("rr.created_at >= %s")
        params.append(from_date)
    if to_date:
        predicates.append("rr.created_at < %s")
        params.append(to_date)

    query = SQL
    if predicates:
        query += " AND " + " AND ".join(predicates) + "\n"
    query += " ORDER BY rr.created_at ASC, rr.id ASC, r.rank ASC"

    policy = LabelPolicy()
    exported_at = datetime.now(timezone.utc)
    rows = []
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, params)
            for record in cursor.fetchall():
                raw_features = record.get("feature_values") or {}
                if not isinstance(raw_features, dict):
                    continue
                row = {
                    "shown_at": iso(record.get("shown_at")),
                    "clicked_at": iso(record.get("clicked_at")),
                    "accepted_at": iso(record.get("accepted_at")),
                    "rejected_at": iso(record.get("rejected_at")),
                    "helpful": record.get("helpful"),
                    "joined_at": iso(record.get("joined_at")),
                    "left_at": iso(record.get("left_at")),
                    "sessions_attended": record.get("sessions_attended", 0),
                    "overall_rating": record.get("overall_rating"),
                    "retained": retained(record, exported_at),
                }
                label = policy.label(row, exported_at)
                if label is None:
                    continue
                candidate_id = record.get("target_group_id") or record.get("target_workspace_id")
                timestamp = record.get("request_at")
                course_id = record.get("course_id")
                course_level = record.get("course_level")
                course_groups = []
                for course in [course_id, *(record.get("request_course_ids") or [])]:
                    if course:
                        hashed = hash_id(course, salt)
                        if hashed not in course_groups:
                            course_groups.append(hashed)
                feature_values = {key: float(value) for key, value in raw_features.items()}
                rows.append(
                    {
                        "query_id": hash_id(record["request_id"], salt),
                        "student_id_hash": hash_id(record["student_id"], salt),
                        "candidate_id_hash": hash_id(candidate_id, salt),
                        "candidate_type": str(record["candidate_type"]),
                        "feature_schema_version": record.get("feature_schema_version") or "recommendation-features-v1",
                        "source_model_version": record.get("serving_model_version") or record.get("model_version_id"),
                        "timestamp": iso(timestamp),
                        "features": feature_values,
                        "label": label,
                        "label_stage": label_stage(label),
                        "dataset_kind": "REAL",
                        "baseline_score": float(record.get("baseline_score") or 0),
                        "confidence": float(record.get("confidence") or 0),
                        "accepted": bool(record.get("accepted_at")),
                        "clicked": bool(record.get("clicked_at")),
                        "helpful": record.get("helpful"),
                        "joined": bool(record.get("joined_at")),
                        "retained": row["retained"],
                        "course_group": course_groups[0] if course_groups else None,
                        "course_groups": course_groups,
                        "academic_level_group": str(int(course_level) // 100 * 100) if course_level else None,
                        "profile_completeness": "complete" if feature_values.get("profile_fields_completed", 0) >= 0.7 else "incomplete",
                    }
                )

    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    manifest = {
        "dataset_kind": "REAL",
        "created_at": exported_at.isoformat(),
        "output": str(destination),
        "rows": len(rows),
        "readiness": readiness(rows),
        "identifiers": "HMAC-SHA256 truncated to 128 bits; raw identifiers are not written",
    }
    destination.with_name("dataset-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def parser():
    result = argparse.ArgumentParser(description="Export anonymized TWIGANE recommendation rows")
    result.add_argument("--database-url", required=True)
    result.add_argument("--output", default="runtime/data/recommendation.jsonl")
    result.add_argument("--hash-salt", required=True)
    result.add_argument("--from-date")
    result.add_argument("--to-date")
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    print(json.dumps(export(arguments.database_url, arguments.output, arguments.hash_salt, from_date=arguments.from_date, to_date=arguments.to_date), indent=2))
