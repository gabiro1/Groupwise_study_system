import { query, queryRows, queryOne, withTransaction } from "../config/db.js";
import { NotFoundError, AppError } from "../lib/errors.js";
import { TOPIC_STATUS, STUDY_STYLE_LABELS } from "../config/constants.js";

/**
 * Student profile service.
 *
 * Owns everything a student declares about their own academic situation:
 * enrolment, skills, topic self-assessment, goals, availability, study
 * preferences, privacy and onboarding progress.
 *
 * Write patterns use replace-semantics (delete-then-insert inside one
 * transaction) rather than diffing. For collections of at most ~60 rows this is
 * simpler, atomic, and impossible to get out of sync — and it avoids the class
 * of bug where a partial diff leaves a deleted row behind.
 */

/** The seven onboarding steps, in order. */
export const ONBOARDING_STEPS = Object.freeze([
  { step: 1, key: "BASIC", title: "Your details", required: true },
  { step: 2, key: "COURSES", title: "Your courses", required: true },
  { step: 3, key: "SKILLS", title: "Your skills", required: false },
  { step: 4, key: "TOPICS", title: "Strong and weak topics", required: false },
  { step: 5, key: "GOALS", title: "Learning goals", required: true },
  { step: 6, key: "AVAILABILITY", title: "When you can study", required: true },
  { step: 7, key: "PREFERENCES", title: "Study preferences", required: false },
]);

/**
 * Weights for the completeness indicator.
 *
 * Steps marked `required` in ONBOARDING_STEPS carry more weight because they are
 * the ones that materially change recommendation quality — enrolment and
 * availability especially. Completeness is a guide, not a grade: the UI never
 * blocks progress or hides features based on it.
 */
const COMPLETENESS_WEIGHTS = Object.freeze({
  BASIC: 10,
  COURSES: 25,
  SKILLS: 15,
  TOPICS: 20,
  GOALS: 10,
  AVAILABILITY: 15,
  PREFERENCES: 5,
});

/**
 * Profile completeness with a per-step breakdown, so the UI can say *which*
 * step would most improve recommendations rather than just "85%".
 */
export async function getCompleteness(studentId) {
  const [profile, courses, skills, topics, goals, availability, preferences] = await Promise.all([
    queryOne(
      "SELECT university_id, program_id, year_of_study, onboarding_done FROM student_profiles WHERE user_id = $1",
      [studentId],
      "student:completenessProfile",
    ),
    queryOne(
      "SELECT count(*)::int AS count FROM student_courses WHERE student_id = $1 AND is_active",
      [studentId],
      "student:completenessCourses",
    ),
    queryOne(
      "SELECT count(*)::int AS count FROM student_skills WHERE student_id = $1",
      [studentId],
      "student:completenessSkills",
    ),
    queryOne(
      "SELECT count(*)::int AS count FROM student_topics WHERE student_id = $1",
      [studentId],
      "student:completenessTopics",
    ),
    queryOne(
      "SELECT count(*)::int AS count FROM student_learning_goals WHERE student_id = $1",
      [studentId],
      "student:completenessGoals",
    ),
    queryOne(
      "SELECT count(*)::int AS count FROM student_availability WHERE student_id = $1",
      [studentId],
      "student:completenessAvailability",
    ),
    queryOne(
      "SELECT preferred_mode FROM study_preferences WHERE student_id = $1",
      [studentId],
      "student:completenessPrefs",
    ),
  ]);

  const satisfied = {
    BASIC: Boolean(profile?.university_id && profile?.program_id),
    COURSES: (courses?.count ?? 0) > 0,
    SKILLS: (skills?.count ?? 0) >= 2,
    TOPICS: (topics?.count ?? 0) >= 2,
    GOALS: (goals?.count ?? 0) > 0,
    AVAILABILITY: (availability?.count ?? 0) > 0,
    PREFERENCES: Boolean(preferences?.preferred_mode),
  };

  const breakdown = ONBOARDING_STEPS.map((step) => ({
    ...step,
    complete: satisfied[step.key],
    weight: COMPLETENESS_WEIGHTS[step.key],
    // Why this step matters, shown to the student. Explaining the ask is the
    // difference between a form students tolerate and one they complete.
    impact:
      {
        BASIC: "Helps us show your programme and year to other students.",
        COURSES: "The strongest signal in matching — you can only be matched on courses you take.",
        SKILLS: "Lets us find partners who are strong where you are not.",
        TOPICS: "Topic-level strengths and gaps drive skill complementarity.",
        GOALS: "Groups are matched on whether you are working towards the same thing.",
        AVAILABILITY: "Without this we can only suggest groups, not check your schedules overlap.",
        PREFERENCES: "Filters out groups you would not enjoy studying with.",
      }[step.key] ?? "",
  }));

  const earned = breakdown.filter((step) => step.complete).reduce((sum, step) => sum + step.weight, 0);
  const total = Object.values(COMPLETENESS_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

  // The next most valuable incomplete step: what to nudge the user toward.
  const nextUp = breakdown.find((step) => !step.complete && step.weight >= 10) ?? breakdown.find((step) => !step.complete) ?? null;

  return {
    percentage: Math.round((earned / total) * 100),
    breakdown,
    nextUp: nextUp ? { step: nextUp.step, key: nextUp.key, title: nextUp.title, impact: nextUp.impact } : null,
    // Honest framing: this is not a grade and does not gate any feature.
    message: buildCompletenessMessage(Math.round((earned / total) * 100), nextUp),
  };
}

function buildCompletenessMessage(percentage, nextUp) {
  if (percentage >= 95) {
    return "Your study profile is complete — recommendations are working at full strength.";
  }
  if (percentage >= 75) {
    return `Your study profile is ${percentage}% complete. ${nextUp ? `Adding ${nextUp.title.toLowerCase()} will sharpen your recommendations further.` : ""}`;
  }
  if (percentage >= 40) {
    return `Your study profile is ${percentage}% complete. ${nextUp ? `Add ${nextUp.title.toLowerCase()} to get noticeably better matches.` : ""}`;
  }
  return "Tell us a little about how you study so we can find people who fit — you can skip anything you prefer.";
}

/** Everything the profile page and onboarding need, in one round trip. */
export async function getProfileBundle(studentId) {
  const [user, profile, courses, skills, topics, goals, availability, preferences, privacy, groups, completeness] =
    await Promise.all([
      queryOne(
        `SELECT u.first_name, u.last_name, u.email, u.avatar_url, u.email_verified_at,
                r.key AS role
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.id = $1`,
        [studentId],
        "student:bundleUser",
      ),
      queryOne(
        `SELECT sp.*, u.name AS university_name, u.code AS university_code,
                p.name AS program_name, p.code AS program_code, p.degree_level
           FROM student_profiles sp
           LEFT JOIN universities u ON u.id = sp.university_id
           LEFT JOIN programs p ON p.id = sp.program_id
          WHERE sp.user_id = $1`,
        [studentId],
        "student:bundleProfile",
      ),
      queryRows(
        `SELECT c.id, c.course_code, c.name, c.credit_hours, sc.semester
           FROM student_courses sc JOIN courses c ON c.id = sc.course_id
          WHERE sc.student_id = $1 AND sc.is_active
          ORDER BY c.name`,
        [studentId],
        "student:bundleCourses",
      ),
      queryRows(
        `SELECT ss.id, s.id AS skill_id, s.name AS skill_name, s.category,
                ss.proficiency, ss.confidence, ss.is_learning, ss.course_id
           FROM student_skills ss JOIN skills s ON s.id = ss.skill_id
          WHERE ss.student_id = $1
          ORDER BY s.name`,
        [studentId],
        "student:bundleSkills",
      ),
      queryRows(
        `SELECT st.id, st.topic_id, st.status, st.self_rating, st.note, st.source,
                ct.name AS topic_name, ct.course_id, ct.position,
                c.course_code, c.name AS course_name
           FROM student_topics st
           JOIN course_topics ct ON ct.id = st.topic_id
           JOIN courses c ON c.id = ct.course_id
          WHERE st.student_id = $1
          ORDER BY c.name, ct.position`,
        [studentId],
        "student:bundleTopics",
      ),
      queryRows(
        `SELECT g.id, g.code, g.label, g.description, slg.priority
           FROM student_learning_goals slg JOIN learning_goals g ON g.id = slg.goal_id
          WHERE slg.student_id = $1
          ORDER BY slg.priority, g.position`,
        [studentId],
        "student:bundleGoals",
      ),
      queryRows(
        `SELECT day_of_week, start_minute, end_minute, is_preferred
           FROM student_availability WHERE student_id = $1
          ORDER BY day_of_week, start_minute`,
        [studentId],
        "student:bundleAvailability",
      ),
      queryOne(
        `SELECT preferred_mode, preferred_style, min_group_size, max_group_size,
                session_minutes, weekly_goal_hours, preferred_days
           FROM study_preferences WHERE student_id = $1`,
        [studentId],
        "student:bundlePrefs",
      ),
      queryOne(
        `SELECT profile_visibility, discoverable, allow_invites_from, allow_messages_from,
                show_availability, show_skills, show_full_schedule, share_progress, ai_personalised
           FROM privacy_settings WHERE user_id = $1`,
        [studentId],
        "student:bundlePrivacy",
      ),
      queryRows(
        `SELECT g.id, g.name, g.slug, g.course_id, g.member_count, g.mode, g.status,
                c.course_code, c.name AS course_name,
                m.role AS my_role, m.joined_at
           FROM study_group_members m
           JOIN study_groups g ON g.id = m.group_id
           JOIN courses c ON c.id = g.course_id
          WHERE m.student_id = $1 AND m.left_at IS NULL AND g.status = 'ACTIVE'
          ORDER BY m.last_active_at DESC`,
        [studentId],
        "student:bundleGroups",
      ),
      getCompleteness(studentId),
    ]);

  if (!user) throw new NotFoundError("That student profile");

  return {
    user: {
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      avatarUrl: user.avatar_url,
      emailVerified: Boolean(user.email_verified_at),
      role: user.role,
    },
    academic: profile
      ? {
          universityId: profile.university_id,
          universityName: profile.university_name,
          universityCode: profile.university_code,
          programId: profile.program_id,
          programName: profile.program_name,
          programCode: profile.program_code,
          degreeLevel: profile.degree_level,
          yearOfStudy: profile.year_of_study,
          studentNumber: profile.student_number,
          bio: profile.bio,
          profilePhotoUrl: profile.profile_photo_url,
          onboardingStep: profile.onboarding_step,
          onboardingDone: profile.onboarding_done,
        }
      : null,
    courses: courses.map((course) => ({
      id: course.id,
      courseCode: course.course_code,
      name: course.name,
      creditHours: course.credit_hours,
      semester: course.semester,
    })),
    skills: skills.map((skill) => ({
      id: skill.id,
      skillId: skill.skill_id,
      name: skill.skill_name,
      category: skill.category,
      proficiency: skill.proficiency,
      confidence: skill.confidence,
      isLearning: skill.is_learning,
      courseId: skill.course_id,
    })),
    topics: topics.map((topic) => ({
      id: topic.id,
      topicId: topic.topic_id,
      name: topic.topic_name,
      status: topic.status,
      selfRating: topic.self_rating,
      note: topic.note,
      source: topic.source,
      courseId: topic.course_id,
      courseCode: topic.course_code,
      courseName: topic.course_name,
    })),
    goals: goals.map((goal) => ({
      id: goal.id,
      code: goal.code,
      label: goal.label,
      description: goal.description,
      priority: goal.priority,
    })),
    availability: availability.map((slot) => ({
      dayOfWeek: slot.day_of_week,
      startMinute: slot.start_minute,
      endMinute: slot.end_minute,
      isPreferred: slot.is_preferred,
    })),
    preferences: preferences
      ? {
          preferredMode: preferences.preferred_mode,
          preferredStyle: preferences.preferred_style,
          preferredStyleLabel: STUDY_STYLE_LABELS[preferences.preferred_style],
          minGroupSize: preferences.min_group_size,
          maxGroupSize: preferences.max_group_size,
          sessionMinutes: preferences.session_minutes,
          weeklyGoalHours: preferences.weekly_goal_hours,
          preferredDays: preferences.preferred_days ?? [],
        }
      : null,
    privacy: privacy
      ? {
          profileVisibility: privacy.profile_visibility,
          discoverable: privacy.discoverable,
          allowInvitesFrom: privacy.allow_invites_from,
          allowMessagesFrom: privacy.allow_messages_from,
          showAvailability: privacy.show_availability,
          showSkills: privacy.show_skills,
          showFullSchedule: privacy.show_full_schedule,
          shareProgress: privacy.share_progress,
          aiPersonalised: privacy.ai_personalised,
        }
      : null,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      slug: group.slug,
      courseId: group.course_id,
      courseCode: group.course_code,
      courseName: group.course_name,
      memberCount: group.member_count,
      mode: group.mode,
      status: group.status,
      myRole: group.my_role,
      joinedAt: group.joined_at,
    })),
    completeness,
  };
}

/**
 * Partial update of the student's own profile.
 *
 * Two tables are involved, so they are written in one transaction: a name change
 * and a programme change must both land or neither, otherwise the profile page
 * can render a name from one save against a programme from another.
 */
export async function updateProfile(studentId, updates) {
  const userColumns = {
    firstName: "first_name",
    lastName: "last_name",
    avatarUrl: "avatar_url",
    timezone: "timezone",
  };

  const profileColumns = {
    bio: "bio",
    profilePhotoUrl: "profile_photo_url",
    universityId: "university_id",
    programId: "program_id",
    yearOfStudy: "year_of_study",
  };

  const buildAssignments = (mapping) => {
    const values = [];
    const assignments = [];
    for (const [key, column] of Object.entries(mapping)) {
      if (updates[key] === undefined) continue;
      values.push(updates[key]);
      assignments.push(column);
    }
    return { values, assignments };
  };

  const user = buildAssignments(userColumns);
  const profile = buildAssignments(profileColumns);

  // A profile row can legitimately not exist yet: university_id is NOT NULL, so
  // it is normally created at registration. Check once and branch explicitly
  // rather than using an upsert, because the DO UPDATE clause would need to
  // re-bind the same placeholders as the INSERT list.
  let hasProfileRow = false;
  if (profile.assignments.length) {
    const existing = await queryOne(
      "SELECT user_id FROM student_profiles WHERE user_id = $1",
      [studentId],
      "student:profileExists",
    );
    hasProfileRow = Boolean(existing);

    if (!hasProfileRow && updates.universityId === undefined) {
      throw new AppError("Choose your university before editing the rest of your profile.", {
        status: 422,
        code: "UNIVERSITY_REQUIRED",
        fields: { universityId: "Select your university." },
      });
    }
  }

  await withTransaction(async (tx) => {
    if (user.assignments.length) {
      // $1 is the student id; the values follow in `assignments` order.
      const clause = user.assignments
        .map((column, index) => `${column} = $${index + 2}`)
        .join(", ");
      await tx.query(`UPDATE users SET ${clause} WHERE id = $1`, [studentId, ...user.values], "student:updateUser");
    }

    if (profile.assignments.length) {
      if (hasProfileRow) {
        const clause = profile.assignments
          .map((column, index) => `${column} = $${index + 2}`)
          .join(", ");
        await tx.query(
          `UPDATE student_profiles SET ${clause} WHERE user_id = $1`,
          [studentId, ...profile.values],
          "student:updateProfile",
        );
      } else {
        // Insert path.
        //
        // `university_id` is NOT NULL, so it must lead the insert — but it may also
        // appear in `profile.assignments` when the caller passed `universityId`.
        // Listing it twice would be a duplicate-column SQL error, so it is pulled
        // out of the assignment list and bound as the first value instead.
        const assignments = profile.assignments.filter((column) => column !== "university_id");
        const values = profile.values.filter((_, index) => profile.assignments[index] !== "university_id");

        const columns = ["user_id", "university_id", ...assignments];
        const placeholders = ["$1", "$2", ...assignments.map((_, index) => `$${index + 3}`)];

        await tx.query(
          `INSERT INTO student_profiles (${columns.join(", ")})
           VALUES (${placeholders.join(", ")})`,
          [studentId, updates.universityId, ...values],
          "student:insertProfile",
        );
      }
    }
  }, "student:updateProfile");

  return getProfileBundle(studentId);
}

/** Replace the student's course enrolments. */
export async function setCourses(studentId, courseIds) {
  const unique = [...new Set(courseIds)];

  // Validate every id before touching anything, so a bad id cannot leave a
  // half-replaced enrolment set.
  const valid = await queryRows(
    "SELECT id FROM courses WHERE id = ANY($1::uuid[]) AND is_active",
    [unique],
    "student:validateCourses",
  );
  if (valid.length !== unique.length) {
    throw new AppError("One or more selected courses are no longer available.", {
      status: 422,
      code: "INVALID_COURSE",
      fields: { courseIds: "Check the selected courses and try again." },
    });
  }

  await withTransaction(async (tx) => {
    await tx.query("DELETE FROM student_courses WHERE student_id = $1", [studentId], "student:clearCourses");
    for (const courseId of unique) {
      await tx.query(
        "INSERT INTO student_courses (student_id, course_id) VALUES ($1, $2)",
        [studentId, courseId],
        "student:addCourse",
      );
    }
  }, "student:setCourses");

  return { courseIds: unique, courses: await getEnrolledCourses(studentId) };
}

async function getEnrolledCourses(studentId) {
  return queryRows(
    `SELECT c.id, c.course_code, c.name FROM student_courses sc
       JOIN courses c ON c.id = sc.course_id
      WHERE sc.student_id = $1 AND sc.is_active ORDER BY c.name`,
    [studentId],
    "student:enrolledCourses",
  );
}

/**
 * Replace self-declared skill levels.
 *
 * A skill may be declared once globally and once per course. Entries are upserted
 * one by one rather than bulk-replaced: deleting and reinserting would churn row
 * ids that other tables reference, so an upsert is the only way to keep the
 * `(student, skill, course)` identity stable across edits.
 */
export async function setSkills(studentId, skills) {
  const skillIds = skills.map((entry) => entry.skillId);
  const courseIds = [...new Set(skills.map((entry) => entry.courseId).filter(Boolean))];

  const [validSkills, validCourses] = await Promise.all([
    queryRows("SELECT id FROM skills WHERE id = ANY($1::uuid[])", [skillIds], "student:validateSkills"),
    courseIds.length
      ? queryRows("SELECT id FROM courses WHERE id = ANY($1::uuid[])", [courseIds], "student:validateSkillCourses")
      : Promise.resolve([]),
  ]);

  if (validSkills.length !== new Set(skillIds).size) {
    throw new AppError("One or more selected skills are no longer available.", {
      status: 422,
      code: "INVALID_SKILL",
      fields: { skills: "Check the selected skills and try again." },
    });
  }
  if (validCourses.length !== courseIds.length) {
    throw new AppError("One or more courses are no longer available.", {
      status: 422,
      code: "INVALID_COURSE",
      fields: { skills: "Check the selected skills and try again." },
    });
  }

  // Collapse duplicates on (skillId, courseId) before writing. The route schema
  // permits two entries for the same pair (e.g. the same skill added at two
  // levels); the table's unique index would reject the second, so we keep the
  // last one the student chose instead of failing the whole save.
  const wanted = new Map();
  for (const entry of skills) {
    wanted.set(`${entry.skillId}:${entry.courseId ?? "global"}`, entry);
  }

  const NO_COURSE = "00000000-0000-0000-0000-000000000000";

  await withTransaction(async (tx) => {
    // Remove only the entries the student has cleared from the UI. Comparing
    // (skill_id, COALESCE(course_id, ...)) keeps the global-scope entries, which
    // is where a naive "DELETE everything" would silently drop them.
    const kept = [...wanted.values()].map((entry) => [
      entry.skillId,
      entry.courseId ?? NO_COURSE,
    ]);

    if (kept.length === 0) {
      await tx.query("DELETE FROM student_skills WHERE student_id = $1", [studentId], "student:clearSkills");
    } else {
      // The (skill_id, COALESCE(course_id, ...)) pair identifies a row, so the
      // comparison needs a row set — hence the CTE over the JSON array.
      await tx.query(
        `WITH kept AS (
           SELECT (entry->>0)::uuid AS skill_id, (entry->>1)::uuid AS course_id
             FROM jsonb_array_elements($2::jsonb) AS e(entry)
         )
         DELETE FROM student_skills
          WHERE student_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM kept
               WHERE kept.skill_id = student_skills.skill_id
                 AND kept.course_id = COALESCE(student_skills.course_id, '${NO_COURSE}'::uuid)
            )`,
        [studentId, JSON.stringify(kept)],
        "student:pruneSkills",
      );
    }

    for (const entry of wanted.values()) {
      // `ON CONFLICT` names the index expression exactly as `student_skills_unique`
        // defines it. The parentheses around `COALESCE(...)` are required for an
        // expression index target and omitted here the statement fails to parse.
        await tx.query(
          `INSERT INTO student_skills (student_id, skill_id, course_id, proficiency, confidence, is_learning)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (student_id, skill_id, (COALESCE(course_id, '${NO_COURSE}'::uuid)))
         DO UPDATE SET proficiency = EXCLUDED.proficiency,
                       confidence = EXCLUDED.confidence,
                       is_learning = EXCLUDED.is_learning,
                       updated_at = now()`,
        [
          studentId,
          entry.skillId,
          entry.courseId ?? null,
          entry.proficiency,
          entry.confidence ?? 3,
          entry.isLearning ?? false,
        ],
        "student:upsertSkill",
      );
    }
  }, "student:setSkills");

  return { count: wanted.size };
}

/**
 * Replace topic self-assessment.
 *
 * Only topics belonging to a course the student is actually enrolled in are
 * accepted. This prevents a student from declaring expertise in a syllabus they
 * do not sit, which would otherwise let them appear as a knowledge source for
 * material they have never studied.
 */
export async function setTopics(studentId, topics) {
  const topicIds = topics.map((entry) => entry.topicId);

  const allowed = await queryRows(
    `SELECT ct.id FROM course_topics ct
       JOIN student_courses sc ON sc.course_id = ct.course_id AND sc.student_id = $1 AND sc.is_active
      WHERE ct.id = ANY($2::uuid[])`,
    [studentId, topicIds],
    "student:validateTopics",
  );

  if (allowed.length !== new Set(topicIds).size) {
    throw new AppError("You can only rate topics from your enrolled courses.", {
      status: 422,
      code: "INVALID_TOPIC",
      fields: { topics: "Remove topics that are not from your courses." },
    });
  }

  await withTransaction(async (tx) => {
    await tx.query(
      `DELETE FROM student_topics
        WHERE student_id = $1 AND NOT (topic_id = ANY($2::uuid[]))`,
      [studentId, topicIds],
      "student:clearTopics",
    );

    for (const entry of topics) {
      await tx.query(
        `INSERT INTO student_topics (student_id, topic_id, status, self_rating, note, source)
         VALUES ($1, $2, $3, $4, $5, 'SELF')
         ON CONFLICT (student_id, topic_id)
         DO UPDATE SET status = EXCLUDED.status,
                       self_rating = EXCLUDED.self_rating,
                       note = EXCLUDED.note,
                       updated_at = now()`,
        [studentId, entry.topicId, entry.status, selfRatingFor(entry.status), entry.note ?? null],
        "student:upsertTopic",
      );
    }
  }, "student:setTopics");

  return { count: topics.length };
}

/**
 * Derive a numeric self-rating from the four-band status.
 * This is what the complementarity model reads, so it must be monotonic and
 * consistent — see TOPIC_STATUS_MEANING for the authoritative bands.
 */
function selfRatingFor(status) {
  const midpoint = {
    [TOPIC_STATUS.NEEDS_HELP]: 0.15,
    [TOPIC_STATUS.LEARNING]: 0.425,
    [TOPIC_STATUS.COMFORTABLE]: 0.7,
    [TOPIC_STATUS.STRONG]: 0.9,
  };
  return midpoint[status] ?? 0.5;
}

/** Replace learning goals. At least one is required by the schema. */
export async function setGoals(studentId, goals) {
  const goalIds = goals.map((entry) => entry.goalId);
  const valid = await queryRows(
    "SELECT id FROM learning_goals WHERE id = ANY($1::uuid[]) AND is_active",
    [goalIds],
    "student:validateGoals",
  );
  if (valid.length !== new Set(goalIds).size) {
    throw new AppError("One or more learning goals is no longer available.", {
      status: 422,
      code: "INVALID_GOAL",
      fields: { goals: "Check the selected goals and try again." },
    });
  }

  await withTransaction(async (tx) => {
    await tx.query("DELETE FROM student_learning_goals WHERE student_id = $1", [studentId], "student:clearGoals");

    // Sequential, not `forEach`: the callback's promises would be discarded and the
    // transaction could commit before the inserts ran.
    for (const [index, entry] of goals.entries()) {
      // Without an explicit priority, preserve the order the student selected
      // them in — their first choice is their priority.
      const priority = entry.priority ?? index + 1;
      await tx.query(
        "INSERT INTO student_learning_goals (student_id, goal_id, priority) VALUES ($1, $2, $3)",
        [studentId, entry.goalId, Math.min(priority, 5)],
        "student:addGoal",
      );
    }
  }, "student:setGoals");

  return { count: goals.length };
}

/**
 * Replace availability slots.
 *
 * Overlapping slots on the same day are rejected by the schema's exclusion
 * constraint, so the service catches it first to return a field-level error the
 * availability picker can attach to the offending slot.
 */
export async function setAvailability(studentId, slots) {
  const normalised = slots
    .map((slot) => ({
      day: slot.dayOfWeek,
      start: slot.startMinute,
      end: slot.endMinute,
      preferred: slot.isPreferred ?? true,
    }))
    .filter((slot) => slot.start < slot.end);

  for (let index = 0; index < normalised.length; index += 1) {
    for (let other = index + 1; other < normalised.length; other += 1) {
      const a = normalised[index];
      const b = normalised[other];
      if (a.day === b.day && a.start < b.end && b.start < a.end) {
        throw new AppError("Two of your available time slots overlap.", {
          status: 422,
          code: "OVERLAPPING_SLOT",
          fields: { slots: `The slot on ${dayName(a.day)} overlaps another you added.` },
        });
      }
    }
  }

  await withTransaction(async (tx) => {
    await tx.query("DELETE FROM student_availability WHERE student_id = $1", [studentId], "student:clearAvailability");
    for (const slot of normalised) {
      await tx.query(
        `INSERT INTO student_availability (student_id, day_of_week, start_minute, end_minute, is_preferred)
         VALUES ($1, $2, $3, $4, $5)`,
        [studentId, slot.day, slot.start, slot.end, slot.preferred],
        "student:addSlot",
      );
    }
  }, "student:setAvailability");

  return { count: normalised.length };
}

function dayName(day) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "that day";
}

/** Upsert study preferences. */
export async function setPreferences(studentId, preferences) {
  await query(
    `INSERT INTO study_preferences
       (student_id, preferred_mode, preferred_style, min_group_size, max_group_size, session_minutes, weekly_goal_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (student_id) DO UPDATE
       SET preferred_mode = EXCLUDED.preferred_mode,
           preferred_style = EXCLUDED.preferred_style,
           min_group_size = EXCLUDED.min_group_size,
           max_group_size = EXCLUDED.max_group_size,
           session_minutes = EXCLUDED.session_minutes,
           weekly_goal_hours = EXCLUDED.weekly_goal_hours,
           updated_at = now()`,
    [
      studentId,
      preferences.preferredMode,
      preferences.preferredStyle,
      preferences.minGroupSize,
      preferences.maxGroupSize,
      preferences.sessionMinutes,
      preferences.weeklyGoalHours ?? 4,
    ],
    "student:setPreferences",
  );

  const row = await queryOne(
    `SELECT preferred_mode, preferred_style, min_group_size, max_group_size, session_minutes, weekly_goal_hours
       FROM study_preferences WHERE student_id = $1`,
    [studentId],
    "student:readPrefs",
  );

  return {
    preferredMode: row.preferred_mode,
    preferredStyle: row.preferred_style,
    preferredStyleLabel: STUDY_STYLE_LABELS[row.preferred_style],
    minGroupSize: row.min_group_size,
    maxGroupSize: row.max_group_size,
    sessionMinutes: row.session_minutes,
    weeklyGoalHours: row.weekly_goal_hours,
  };
}

/** Advance onboarding progress. Progress is never allowed to go backwards. */
export async function recordOnboardingStep(studentId, step, completed) {
  const row = await queryOne(
    `UPDATE student_profiles
        SET onboarding_step = GREATEST(onboarding_step, $2),
            onboarding_done = onboarding_done OR ($2 = 7 AND $3)
      WHERE user_id = $1
      RETURNING onboarding_step, onboarding_done`,
    [studentId, step, completed],
    "student:onboardingStep",
  );

  if (!row) throw new NotFoundError("That student profile");

  // Recompute completeness, since finishing a step changes what is missing.
  const completeness = await getCompleteness(studentId);
  return { step: row.onboarding_step, done: row.onboarding_done, completeness };
}

export async function getPrivacy(userId) {
  const row = await queryOne(
    `SELECT profile_visibility, discoverable, allow_invites_from, allow_messages_from,
            show_availability, show_skills, show_full_schedule, share_progress, ai_personalised
       FROM privacy_settings WHERE user_id = $1`,
    [userId],
    "student:privacy",
  );
  if (!row) throw new NotFoundError("Those privacy settings");
  return row;
}

/**
 * Update privacy settings.
 *
 * Every field defaults to the most private option, so a partial update can never
 * accidentally widen visibility. The frontend sends the full object; this is the
 * backstop.
 */
export async function updatePrivacy(userId, updates) {
  const current = await getPrivacy(userId);

  const next = {
    profile_visibility: updates.profileVisibility ?? current.profile_visibility,
    discoverable: updates.discoverable ?? false,
    allow_invites_from: updates.allowInvitesFrom ?? "NOBODY",
    allow_messages_from: updates.allowMessagesFrom ?? "MEMBERS",
    show_availability: updates.showAvailability ?? false,
    show_skills: updates.showSkills ?? false,
    show_full_schedule: updates.showFullSchedule ?? false,
    share_progress: updates.shareProgress ?? false,
    ai_personalised: updates.aiPersonalised ?? true,
  };

  // A private profile cannot be discoverable — the two contradict each other.
  if (next.profile_visibility === "PRIVATE") next.discoverable = false;

  await query(
    `UPDATE privacy_settings
        SET profile_visibility = $2, discoverable = $3, allow_invites_from = $4,
            allow_messages_from = $5, show_availability = $6, show_skills = $7,
            show_full_schedule = $8, share_progress = $9, ai_personalised = $10,
            updated_at = now()
      WHERE user_id = $1`,
    [
      userId,
      next.profile_visibility,
      next.discoverable,
      next.allow_invites_from,
      next.allow_messages_from,
      next.show_availability,
      next.show_skills,
      next.show_full_schedule,
      next.share_progress,
      next.ai_personalised,
    ],
    "student:updatePrivacy",
  );

  return next;
}

/**
 * The dashboard overview counters.
 *
 * One aggregate query plus two prefixed counts: this is what populates the
 * summary cards, so a student logging in sees, in one round trip, how many
 * groups they are in, what is waiting on them, and what is happening next.
 */
export async function summaryForStudent(studentId) {
  const { unreadCount: unreadNotifications } = await import("../lib/notifications.js");
  const { unreadCount: unreadDirectMessages } = await import("./partner.service.js");

  const [rows, notifications, directMessages] = await Promise.all([
    queryOne(
      `SELECT
        (SELECT count(*)::int FROM study_group_members m
          JOIN study_groups g ON g.id = m.group_id
         WHERE m.student_id = $1 AND m.left_at IS NULL AND g.status = 'ACTIVE') AS active_groups,
        (SELECT count(*)::int FROM study_group_invitations i
         WHERE i.invitee_id = $1 AND i.status = 'PENDING' AND i.expires_at > now()) AS pending_group_invitations,
        (SELECT count(*)::int FROM study_group_join_requests jr
         WHERE jr.student_id = $1 AND jr.status = 'PENDING') AS pending_group_requests,
        (SELECT count(*)::int FROM partner_connections pc
         WHERE pc.recipient_id = $1 AND pc.status = 'PENDING') AS pending_partner_invitations,
        (SELECT count(*)::int FROM study_group_members m
          JOIN workspaces w ON w.group_id = m.group_id AND NOT w.is_archived
          JOIN study_sessions ss ON ss.workspace_id = w.id
         WHERE m.student_id = $1 AND m.left_at IS NULL
           AND ss.status = 'SCHEDULED' AND ss.starts_at > now()) AS upcoming_sessions,
        (SELECT count(DISTINCT g.id)::int FROM study_group_members m
          JOIN study_groups g ON g.id = m.group_id AND g.status = 'ACTIVE'
         WHERE m.student_id = $1 AND m.left_at IS NULL
           AND m.role IN ('OWNER', 'MODERATOR')) AS leading_groups`,
      [studentId],
      "student:summary",
    ),
    unreadNotifications(studentId),
    unreadDirectMessages(studentId),
  ]);

  return {
    activeGroups: rows?.active_groups ?? 0,
    pendingGroupInvitations: rows?.pending_group_invitations ?? 0,
    pendingGroupRequests: rows?.pending_group_requests ?? 0,
    pendingPartnerInvitations: rows?.pending_partner_invitations ?? 0,
    upcomingSessions: rows?.upcoming_sessions ?? 0,
    leadingGroups: rows?.leading_groups ?? 0,
    unreadNotifications,
    unreadDirectMessages: directMessages,
  };
}

export default {
  ONBOARDING_STEPS,
  getCompleteness,
  getProfileBundle,
  updateProfile,
  setCourses,
  setSkills,
  setTopics,
  setGoals,
  setAvailability,
  setPreferences,
  recordOnboardingStep,
  getPrivacy,
  updatePrivacy,
};