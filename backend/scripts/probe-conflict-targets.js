// One-off probe: list every UNIQUE index on the tables the seed upserts into, so an
// `ON CONFLICT (cols)` target that does not match a real arbiter index can be found
// before the seed runs. Run with: node scripts/probe-conflict-targets.js
import { pool, queryRows } from "../src/config/db.js";

const TABLES = [
  "roles", "universities", "faculties", "departments", "programs", "courses",
  "course_topics", "skills", "learning_goals", "system_settings",
  "student_profiles", "privacy_settings", "student_skills", "student_topics",
  "student_learning_goals", "student_courses", "lecturer_courses",
  "study_groups", "study_group_members", "workspaces", "group_membership_outcomes",
  "recommendation_model_versions",
];

for (const table of TABLES) {
  const rows = await queryRows("SELECT indexdef FROM pg_indexes WHERE tablename = $1", [table], "probe:indexes");
  const unique = rows.map((row) => row.indexdef).filter((def) => def.includes("UNIQUE"));

  console.log(`\n== ${table}`);
  if (unique.length === 0) console.log("   (no unique index - ON CONFLICT would fail)");
  for (const def of unique) {
    console.log(`   ${def.replace(/^CREATE UNIQUE INDEX \S+ ON public\.\S+ USING btree /, "")}`);
  }
}

await pool.end();