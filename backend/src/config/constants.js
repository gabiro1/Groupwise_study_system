/**
 * Single source of truth for every enum-like value in Lien.
 *
 * These strings are persisted in Postgres as native enum types, so they must
 * match `db/migrations/*.sql` exactly. Validation schemas import from here so a
 * value can never drift between the database, the API and the UI.
 */

export const ROLES = Object.freeze({
  STUDENT: "STUDENT",
  GROUP_LEADER: "GROUP_LEADER",
  ADMIN: "ADMIN",
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

export const USER_STATUS = Object.freeze({
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  DEACTIVATED: "DEACTIVATED",
});

/** Proficiency scale used for both skills and topic self-assessment. */
export const PROFICIENCY = Object.freeze({
  BEGINNER: "BEGINNER",
  INTERMEDIATE: "INTERMEDIATE",
  ADVANCED: "ADVANCED",
  EXPERT: "EXPERT",
});

/** Numeric companion values, used by the scoring engine. */
export const PROFICIENCY_SCORE = Object.freeze({
  BEGINNER: 0.2,
  INTERMEDIATE: 0.45,
  ADVANCED: 0.75,
  EXPERT: 0.95,
  UNKNOWN: 0.5,
});

export const TOPIC_STATUS = Object.freeze({
  NEEDS_HELP: "NEEDS_HELP",
  LEARNING: "LEARNING",
  COMFORTABLE: "COMFORTABLE",
  STRONG: "STRONG",
});

/**
 * Topic status encodes a self-assessed range. A "help" topic is a knowledge
 * gap, a "strong" topic is a knowledge asset — that asymmetry is what the
 * complementarity model exploits.
 */
export const TOPIC_STATUS_MEANING = Object.freeze({
  NEEDS_HELP: { min: 0.0, max: 0.3, label: "Needs help", polarity: "gap" },
  LEARNING: { min: 0.25, max: 0.6, label: "Learning", polarity: "gap" },
  COMFORTABLE: { min: 0.55, max: 0.85, label: "Comfortable", polarity: "neutral" },
  STRONG: { min: 0.8, max: 1.0, label: "Strong", polarity: "asset" },
});

export const LEARNING_GOALS = Object.freeze({
  EXAM_PREPARATION: "EXAM_PREPARATION",
  ASSIGNMENT: "ASSIGNMENT",
  IMPROVE_UNDERSTANDING: "IMPROVE_UNDERSTANDING",
  PRACTICE: "PRACTICE",
  PEER_TEACHING: "PEER_TEACHING",
  GENERAL_REVISION: "GENERAL_REVISION",
  RESEARCH_PROJECT: "RESEARCH_PROJECT",
});

export const LEARNING_GOAL_LABELS = Object.freeze({
  EXAM_PREPARATION: "Exam preparation",
  ASSIGNMENT: "Assignment",
  IMPROVE_UNDERSTANDING: "Improve understanding",
  PRACTICE: "Practice problems",
  PEER_TEACHING: "Peer teaching",
  GENERAL_REVISION: "General revision",
  RESEARCH_PROJECT: "Research project",
});

export const STUDY_MODES = Object.freeze({
  ONLINE: "ONLINE",
  PHYSICAL: "PHYSICAL",
  EITHER: "EITHER",
});

export const STUDY_STYLES = Object.freeze({
  DISCUSS: "DISCUSS",
  PROBLEM_SOLVING: "PROBLEM_SOLVING",
  TEACH_BACK: "TEACH_BACK",
  QUIET_FOCUS: "QUIET_FOCUS",
  MIXED: "MIXED",
});

export const STUDY_STYLE_LABELS = Object.freeze({
  DISCUSS: "Discussion-based",
  PROBLEM_SOLVING: "Problem-solving",
  TEACH_BACK: "Teach-back / peer teaching",
  QUIET_FOCUS: "Quiet focus",
  MIXED: "Mixed",
});

/**
 * Group size compatibility is a *soft* preference: both partners' preferred
 * ranges are considered so that a group of 2 people who each want 4–6 can
 * still be flagged as a mild mismatch rather than a hard exclusion.
 */
export const GROUP_SIZE = Object.freeze({ MIN: 2, MAX: 12, DEFAULT_MIN: 3, DEFAULT_MAX: 6 });

export const GROUP_PRIVACY = Object.freeze({
  PUBLIC: "PUBLIC",
  REQUEST_REQUIRED: "REQUEST_REQUIRED",
  INVITE_ONLY: "INVITE_ONLY",
});

export const GROUP_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
  DISBANDED: "DISBANDED",
});

export const GROUP_MEMBER_ROLE = Object.freeze({
  OWNER: "OWNER",
  MODERATOR: "MODERATOR",
  MEMBER: "MEMBER",
});

export const INVITATION_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
});

export const JOIN_REQUEST_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

export const TASK_STATUS = Object.freeze({
  TODO: "TODO",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
});

export const TASK_PRIORITY = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

export const SESSION_MODE = Object.freeze({ ONLINE: "ONLINE", PHYSICAL: "PHYSICAL" });
export const SESSION_STATUS = Object.freeze({
  SCHEDULED: "SCHEDULED",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});
export const SESSION_FORMAT = Object.freeze({ GUIDED: "GUIDED", FLEXIBLE: "FLEXIBLE" });
export const STUDY_ROLE = Object.freeze({ TEACHER: "TEACHER", QUESTIONER: "QUESTIONER", TIMER: "TIMER" });
export const QUESTION_STATUS = Object.freeze({
  OPEN: "OPEN",
  ANSWERED: "ANSWERED",
  NEEDS_VERIFICATION: "NEEDS_VERIFICATION",
  RESOLVED: "RESOLVED",
});
export const PREP_STATUS = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  READY: "READY",
});
export const SESSION_ACTIVITY_KIND = Object.freeze({
  INTRO: "INTRO",
  TEACH: "TEACH",
  QUESTIONS: "QUESTIONS",
  EXERCISE: "EXERCISE",
  DISCUSSION: "DISCUSSION",
  BREAK: "BREAK",
  REVIEW: "REVIEW",
  WRAP_UP: "WRAP_UP",
});
export const RSVP_STATUS = Object.freeze({ GOING: "GOING", MAYBE: "MAYBE", NOT_GOING: "NOT_GOING" });

export const MEETING_STATUS = Object.freeze({
  SCHEDULED: "SCHEDULED",
  LIVE: "LIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});

export const MEETING_PROVIDER = Object.freeze({
  JITSI: "JITSI",
  LIVEKIT: "LIVEKIT",
  GOOGLE_MEET: "GOOGLE_MEET",
  NONE: "NONE",
});

export const MEETING_ATTENDANCE_STATUS = Object.freeze({
  JOINED: "JOINED",
  LEFT: "LEFT",
  IN_CALL: "IN_CALL",
});

/** Valid video-meeting state transitions (compare-and-set in the service). */
export const MEETING_TRANSITIONS = Object.freeze({
  SCHEDULED: ["LIVE", "CANCELLED"],
  LIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
});

/** Duration bounds for scheduled video meetings (minutes). */
export const MEETING_DURATION = Object.freeze({ MIN: 5, MAX: 480 });

/** How early (minutes before scheduled_start) a member may join. */
export const MEETING_JOIN_WINDOW_MINUTES = 15;

export const RESOURCE_KIND = Object.freeze({
  FILE: "FILE",
  LINK: "LINK",
  NOTE: "NOTE",
});

export const RESOURCE_VISIBILITY = Object.freeze({
  GROUP: "GROUP",
  COURSE: "COURSE",
  PRIVATE: "PRIVATE",
});

export const MESSAGE_KIND = Object.freeze({
  TEXT: "TEXT",
  AI: "AI",
  SYSTEM: "SYSTEM",
  RESOURCE: "RESOURCE",
});

export const NOTIFICATION_TYPE = Object.freeze({
  GROUP_INVITATION: "GROUP_INVITATION",
  JOIN_REQUEST: "JOIN_REQUEST",
  INVITATION_ACCEPTED: "INVITATION_ACCEPTED",
  JOIN_REQUEST_APPROVED: "JOIN_REQUEST_APPROVED",
  SESSION_REMINDER: "SESSION_REMINDER",
  SESSION_UPDATED: "SESSION_UPDATED",
  TASK_ASSIGNED: "TASK_ASSIGNED",
  TASK_DUE: "TASK_DUE",
  GROUP_ANNOUNCEMENT: "GROUP_ANNOUNCEMENT",
  AI_RECOMMENDATION: "AI_RECOMMENDATION",
  SYSTEM: "SYSTEM",
  MODERATION: "MODERATION",
  PARTNER_INVITATION: "PARTNER_INVITATION",
  PARTNER_ACCEPTED: "PARTNER_ACCEPTED",
  DIRECT_MESSAGE: "DIRECT_MESSAGE",
  SESSION_STARTED: "SESSION_STARTED",
  ROLE_ASSIGNED: "ROLE_ASSIGNED",
  MEETING_SCHEDULED: "MEETING_SCHEDULED",
  MEETING_UPDATED: "MEETING_UPDATED",
  MEETING_CANCELLED: "MEETING_CANCELLED",
  MEETING_STARTED: "MEETING_STARTED",
});

/**
 * Study-partner connection lifecycle.
 *
 * A connection is one-directional until accepted: requester -> recipient. The
 * statuses form two timelines — the invite timeline (PENDING -> DECLINED, or ->
 * REVOKED by the requester) and the working timeline (PENDING -> ACCEPTED). A
 * closed connection can be re-offered, because each accepted pair is re-created
 * fresh rather than resurrected from a stale row.
 */
export const PARTNER_CONNECTION_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  REVOKED: "REVOKED",
});

export const RECOMMENDATION_KIND = Object.freeze({
  GROUP: "GROUP",
  STUDENT: "STUDENT",
});

export const REPORT_STATUS = Object.freeze({
  OPEN: "OPEN",
  IN_REVIEW: "IN_REVIEW",
  RESOLVED: "RESOLVED",
  DISMISSED: "DISMISSED",
});

export const REPORT_TARGET = Object.freeze({
  STUDENT: "STUDENT",
  GROUP: "GROUP",
  MESSAGE: "MESSAGE",
  RESOURCE: "RESOURCE",
});

export const REPORT_CATEGORY = Object.freeze({
  HARASSMENT: "HARASSMENT",
  INAPPROPRIATE_CONTENT: "INAPPROPRIATE_CONTENT",
  SPAM: "SPAM",
  ACADEMIC_DISHONESTY: "ACADEMIC_DISHONESTY",
  IMPERSONATION: "IMPERSONATION",
  OTHER: "OTHER",
});

/** Day-of-week convention: 0 = Sunday, matching `Date#getDay()`. */
export const DAYS_OF_WEEK = Object.freeze([
  { value: 0, short: "Sun", label: "Sunday" },
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
]);

export const TIME = Object.freeze({
  MINUTES_PER_DAY: 24 * 60,
  DAY_LABEL: "Sun",
});

/** Minutes since midnight → "10:30". */
export function minutesToTimeLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** "10:30" → 630. Returns `null` for anything unparseable. */
export function timeLabelToMinutes(label) {
  if (typeof label !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(label.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

/** Human duration from minutes, e.g. 150 → "2h 30m". */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}