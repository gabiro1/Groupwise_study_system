import { z } from "zod";
import {
  ROLES,
  USER_STATUS,
  LEARNING_GOAL_LABELS,
  GROUP_SIZE,
} from "../config/constants.js";

// Re-exported so route modules can build one-off schemas (param refinements,
// `.partial()` derivations) without importing Zod directly. Every validation
// primitive in this project should live here, not be re-declared per route.
export { z };

/**
 * Request validation schemas.
 *
 * Every schema declares bounds derived from the database constraints, so a value
 * that would fail at the storage layer is rejected at the edge with a message a
 * form can display. Kept beside the routes it serves rather than in one global
 * file so schemas stay discoverable.
 */

/** Emails are stored case-insensitively (citext) but validated strictly. */
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, "Enter your email address.")
  .max(254, "That email address is too long.")
  .email("Enter a valid email address.");

/**
 * Password policy: length-first, because long passphrases are what actually
 * resists guessing, plus a character-class requirement kept modest so the policy
 * is explainable in one sentence on the sign-up form.
 */
export const password = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(200, "Passwords must be under 200 characters.")
  .refine((value) => /[a-z]/.test(value), "Include at least one lowercase letter.")
  .refine((value) => /[A-Z]/.test(value), "Include at least one uppercase letter.")
  .refine((value) => /\d/.test(value), "Include at least one number.");

export const uuid = z.string().uuid("That identifier is not valid.");

export const nameField = z
  .string()
  .trim()
  .min(1, "This field is required.")
  .max(60, "Keep this under 60 characters.");

export const cuid = z.string().trim().min(1).max(80);

export const shortText = z.string().trim().max(500);

export const dayOfWeek = z.coerce.number().int().min(0).max(6);
export const minuteOfDay = z.coerce.number().int().min(0).max(1440);

/**
 * A query-string boolean.
 *
 * `z.coerce.boolean()` cannot be used here. It applies JavaScript truthiness to
 * whatever arrives, so the string `"false"` becomes `true` and a client asking for
 * `?overdue=false` silently gets the overdue-only list. Query parameters arrive as
 * strings, so the spellings a browser or fetch call actually sends are parsed here,
 * and anything else is a validation error instead of a silent inversion.
 */
export const booleanFromQuery = z.union([
  z.boolean(),
  z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1"),
]);

export const optionalBooleanFromQuery = booleanFromQuery.optional();

// =============================================================================
// Auth
// =============================================================================

/**
 * Who may self-register.
 *
 * Only STUDENT is open. Creating a LECTURER or ADMIN account through the public
 * signup form would be a privilege-escalation hole, so elevated roles are
 * granted exclusively by an existing admin (see the admin module).
 */
export const publicRole = z.enum([ROLES.STUDENT]);

export const registerSchema = z.object({
  email,
  password,
  firstName: nameField,
  lastName: nameField,
  universityId: uuid.optional().nullable(),
  programId: uuid.optional().nullable(),
  yearOfStudy: z.coerce.number().int().min(1).max(12).default(1),
  acceptTerms: z.literal(true, { message: "You must accept the terms to continue." }),
}).refine((data) => !data.programId || data.universityId, {
  path: ["universityId"],
  message: "Select a university when providing a programme.",
});

export const loginSchema = z.object({
  email,
  // Deliberately lenient: strength is enforced at registration, not sign-in.
  // Rejecting a weak password here would leak policy and lock out legacy users.
  password: z.string().min(1, "Enter your password.").max(200),
  rememberDevice: z.boolean().optional().default(true),
});

export const forgotPasswordSchema = z.object({ email });
export const resendVerificationSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(10, "That reset link is not valid."),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: password,
  logoutOtherSessions: z.boolean().optional().default(true),
});

export const verifyEmailSchema = z.object({ token: z.string().min(10) });

export const contactMessageSchema = z.object({
  name: nameField,
  email,
  subject: z.string().trim().min(1, "Enter a subject.").max(120, "Keep the subject under 120 characters."),
  message: z.string().trim().min(10, "Please include at least 10 characters.").max(5000, "Keep the message under 5,000 characters."),
});

export const listSessionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export const revokeSessionSchema = z.object({
  sessionId: uuid.optional(),
  all: z.boolean().optional().default(false),
});

// =============================================================================
// Student profile / onboarding
// =============================================================================

export const onboardingStepSchema = z.object({
  step: z.coerce.number().int().min(0).max(7),
  completed: z.boolean().default(false),
});

export const studentCoursesSchema = z.object({
  courseIds: z.array(uuid).min(1, "Select at least one course.").max(12),
});

export const studentSkillsSchema = z.object({
  skills: z
    .array(
      z.object({
        skillId: uuid,
        courseId: uuid.optional().nullable(),
        proficiency: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"]),
        confidence: z.coerce.number().int().min(1).max(5).optional(),
        isLearning: z.boolean().optional().default(false),
      }),
    )
    .max(40),
});

export const studentTopicsSchema = z.object({
  topics: z
    .array(
      z.object({
        topicId: uuid,
        status: z.enum(["NEEDS_HELP", "LEARNING", "COMFORTABLE", "STRONG"]),
        note: shortText.max(300).optional().nullable(),
      }),
    )
    .max(60),
});

export const learningGoalsSchema = z.object({
  goals: z
    .array(z.object({ goalId: uuid, priority: z.coerce.number().int().min(1).max(5).optional() }))
    .min(1, "Choose at least one learning goal.")
    .max(5),
});

export const availabilitySchema = z.object({
  slots: z
    .array(
      z.object({
        dayOfWeek: dayOfWeek,
        startMinute: minuteOfDay,
        endMinute: minuteOfDay,
        isPreferred: z.boolean().optional().default(true),
      }),
    )
    .max(40),
});

export const studyPreferencesSchema = z.object({
  preferredMode: z.enum(["ONLINE", "PHYSICAL", "EITHER"]),
  preferredStyle: z.enum(["DISCUSS", "PROBLEM_SOLVING", "TEACH_BACK", "QUIET_FOCUS", "MIXED"]),
  minGroupSize: z.coerce.number().int().min(GROUP_SIZE.MIN).max(GROUP_SIZE.MAX),
  maxGroupSize: z.coerce.number().int().min(GROUP_SIZE.MIN).max(GROUP_SIZE.MAX),
  sessionMinutes: z.coerce.number().int().min(30).max(480),
  weeklyGoalHours: z.coerce.number().int().min(0).max(60).optional(),
});

export const privacySettingsSchema = z
  .object({
    profileVisibility: z.enum(["STUDENTS", "COURSES_ONLY", "PRIVATE"]),
    discoverable: z.boolean(),
    allowInvitesFrom: z.enum(["ANY", "SHARED_GROUPS", "NOBODY"]),
    allowMessagesFrom: z.enum(["ANY", "SHARED_GROUPS", "MEMBERS", "NOBODY"]),
    showAvailability: z.boolean(),
    showSkills: z.boolean(),
    showFullSchedule: z.boolean(),
    shareProgress: z.boolean(),
    aiPersonalised: z.boolean(),
  })
  .partial();

export const notificationPreferencesSchema = z
  .object({
    inAppEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    quietHoursStart: minuteOfDay.nullable(),
    quietHoursEnd: minuteOfDay.nullable(),
    overrides: z.record(z.string(), z.object({ inApp: z.boolean().optional(), email: z.boolean().optional() })),
  })
  .partial();

export const profileUpdateSchema = z.object({
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  bio: shortText.max(600).optional().nullable(),
  avatarUrl: z.union([
    z.string().url().max(500),
    z.string()
      .max(80_000)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, "Upload a valid JPEG profile picture."),
  ]).optional().nullable(),
  universityId: uuid.optional(),
  programId: uuid.optional().nullable(),
  yearOfStudy: z.coerce.number().int().min(1).max(12).optional(),
  timezone: z.string().max(60).optional(),
});

// =============================================================================
// Discovery / search
// =============================================================================

/** Shared pagination. Cursors are opaque and opaque by design. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const studentSearchSchema = paginationSchema.extend({
  q: shortText.max(120).optional(),
  courseId: uuid.optional(),
  skillId: uuid.optional(),
  universityId: uuid.optional(),
  programId: uuid.optional(),
  yearOfStudy: z.coerce.number().int().min(1).max(12).optional(),
  mode: z.enum(["ONLINE", "PHYSICAL", "EITHER"]).optional(),
  availableDay: dayOfWeek.optional(),
  availableFrom: minuteOfDay.optional(),
  availableTo: minuteOfDay.optional(),
  goalId: uuid.optional(),
  excludeGroupId: uuid.optional(),
});

export const groupSearchSchema = paginationSchema.extend({
  q: shortText.max(120).optional(),
  courseId: uuid.optional(),
  topicId: uuid.optional(),
  goalId: uuid.optional(),
  universityId: uuid.optional(),
  programId: uuid.optional(),
  mode: z.enum(["ONLINE", "PHYSICAL", "EITHER"]).optional(),
  privacy: z.enum(["PUBLIC", "REQUEST_REQUIRED"]).optional(),
  minSize: z.coerce.number().int().min(1).max(20).optional(),
  maxSize: z.coerce.number().int().min(1).max(20).optional(),
  hasSpace: optionalBooleanFromQuery,
  availableDay: dayOfWeek.optional(),
  availableFrom: minuteOfDay.optional(),
  availableTo: minuteOfDay.optional(),
  sort: z.enum(["relevance", "newest", "activity", "size"]).default("relevance"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});

export const groupIdParamSchema = z.object({ groupId: uuid });
export const workspaceIdParamSchema = z.object({ workspaceId: uuid });
export const idParamSchema = z.object({ id: uuid });

// =============================================================================
// Study groups
// =============================================================================

/**
 * Group create/update.
 *
 * The field set is defined once and reused, because Zod cannot call `.partial()`
 * on a schema that already carries a `.refine()`. Deriving the update schema from
 * the raw object shape is the only way to keep both refinements intact.
 */
const groupFields = {
  name: z.string().trim().min(3, "Give your study group a name.").max(80),
  courseId: uuid,
  goalId: uuid.optional().nullable(),
  description: shortText.max(1500).optional().default(""),
  mode: z.enum(["ONLINE", "PHYSICAL", "EITHER"]).default("EITHER"),
  privacy: z.enum(["PUBLIC", "REQUEST_REQUIRED", "INVITE_ONLY"]).default("REQUEST_REQUIRED"),
  requireApproval: z.boolean().default(true),
  minSize: z.coerce.number().int().min(GROUP_SIZE.MIN).max(GROUP_SIZE.MAX).default(3),
  maxSize: z.coerce.number().int().min(GROUP_SIZE.MIN).max(20).default(6),
  topicIds: z.array(uuid).max(12).default([]),
  schedule: availabilitySchema.shape.slots.default([]),
  locationHint: shortText.max(200).optional().nullable(),
};

export const createGroupSchema = z.object(groupFields).refine((data) => data.maxSize >= data.minSize, {
  message: "Maximum group size must be at least the minimum.",
  path: ["maxSize"],
});

export const updateGroupSchema = z
  .object(groupFields)
  .partial()
  .extend({ status: z.enum(["ACTIVE", "ARCHIVED"]).optional() })
  .refine((data) => data.maxSize === undefined || data.minSize === undefined || data.maxSize >= data.minSize, {
    message: "Maximum group size must be at least the minimum.",
    path: ["maxSize"],
  });

export const inviteMemberSchema = z.object({
  inviteeId: uuid,
  message: shortText.max(500).optional().nullable(),
  /** Send even when the compatibility score is low — human choice outranks the model. */
  ignoreCompatibility: z.boolean().optional().default(false),
});

export const respondInvitationSchema = z.object({
  invitationId: uuid,
  response: z.enum(["ACCEPT", "DECLINE"]),
});

export const joinRequestSchema = z.object({
  groupId: uuid,
  message: shortText.max(500).optional().nullable(),
});

export const decideJoinRequestSchema = z.object({
  requestId: uuid,
  decision: z.enum(["APPROVE", "REJECT"]),
  note: shortText.max(500).optional().nullable(),
});

export const manageMemberSchema = z.object({
  studentId: uuid,
  action: z.enum(["PROMOTE", "DEMOTE", "REMOVE"]),
});

export const leaveGroupSchema = z.object({
  groupId: uuid,
  reason: shortText.max(300).optional().nullable(),
});

// =============================================================================
// Group leader tools
// =============================================================================

export const leaderGroupFilterSchema = z.object({
  groupId: uuid.optional(),
});

export const leaderSessionQuerySchema = leaderGroupFilterSchema.extend({
  scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const cancelInvitationParamSchema = z.object({
  groupId: uuid,
  invitationId: uuid,
});

export const announcementSchema = z.object({
  title: z.string().trim().min(2, "Give the announcement a title.").max(140),
  body: z.string().trim().min(1, "Write the announcement.").max(2000),
});

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const recommendMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  q: shortText.max(120).optional(),
});

// =============================================================================
// Workspace
// =============================================================================

export const createWorkspaceSchema = z.object({
  groupId: uuid,
  name: z.string().trim().min(3, "Give your workspace a name.").max(100),
  description: shortText.max(500).optional().default(""),
});

export const createPlanSchema = z.object({
  title: z.string().trim().min(3).max(120),
  goalId: uuid.optional().nullable(),
  description: shortText.max(2000).optional().default(""),
  deadline: z.string().date().optional().nullable(),
  topics: z
    .array(z.object({ topicId: uuid, targetProficiency: z.coerce.number().int().min(1).max(4).optional() }))
    .max(20)
    .default([]),
});

export const updatePlanSchema = createPlanSchema.partial().extend({
  status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "ABANDONED"]).optional(),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(2, "Give the task a title.").max(160),
  description: shortText.max(4000).optional().default(""),
  planId: uuid.optional().nullable(),
  topicId: uuid.optional().nullable(),
  assigneeId: uuid.optional().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  status: z.enum(["TODO", "IN_PROGRESS", "COMPLETED"]).default("TODO"),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  estimateMinutes: z.coerce.number().int().min(5).max(600).optional().nullable(),
});

export const updateTaskSchema = createTaskSchema.partial();

export const taskQuerySchema = z.object({
  status: z.enum(["TODO", "IN_PROGRESS", "COMPLETED"]).optional(),
  assigneeId: uuid.optional(),
  mine: optionalBooleanFromQuery,
  planId: uuid.optional(),
  topicId: uuid.optional(),
  overdue: optionalBooleanFromQuery,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const taskCommentSchema = z.object({
  body: z.string().trim().min(1, "Write something first.").max(2000),
});

/**
 * Session create/update.
 *
 * Both are declared from the same field map: `.partial()` is illegal on a schema
 * that already carries `.refine()`, so the shared shape has to stay a raw object.
 */
const sessionFields = {
  title: z.string().trim().min(2).max(140),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  mode: z.enum(["ONLINE", "PHYSICAL"]).default("PHYSICAL"),
  location: shortText.max(200).optional().nullable(),
  meetingUrl: z.string().url().max(500).optional().nullable(),
  agenda: shortText.max(2000).optional().default(""),
  planId: uuid.optional().nullable(),
  topicId: uuid.optional().nullable(),
  attendanceTracked: z.boolean().default(true),
};

export const createSessionSchema = z
  .object(sessionFields)
  .refine((data) => new Date(data.endsAt) > new Date(data.startsAt), {
    message: "The end time must be after the start time.",
    path: ["endsAt"],
  })
  .refine(
    (data) => new Date(data.endsAt).getTime() - new Date(data.startsAt).getTime() <= 12 * 60 * 60 * 1000,
    { message: "A study session cannot be longer than 12 hours.", path: ["endsAt"] },
  );

/**
 * Every field optional *and* defaulted away.
 *
 * `sessionFields` carries `.default()` values for creation. `.partial()` on its own
 * is not enough: Zod still applies a default to an absent key, so a PATCH that only
 * renames a session would silently reset an online session to `PHYSICAL`, blank the
 * agenda and turn attendance tracking back on. Defaults are therefore rebuilt
 * without `.default()` here.
 */
const optionalSessionFields = Object.fromEntries(
  Object.entries(sessionFields).map(([key, schema]) => [
    key,
    schema._def.innerType ? schema._def.innerType.optional() : schema.optional(),
  ]),
);

export const updateSessionSchema = z
  .object(optionalSessionFields)
  .extend({ status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]).optional() })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Send at least one field to change.",
    path: ["title"],
  })
  .refine(
    (data) =>
      !data.startsAt || !data.endsAt || new Date(data.endsAt).getTime() > new Date(data.startsAt).getTime(),
    { message: "The end time must be after the start time.", path: ["endsAt"] },
  )
  .refine(
    (data) =>
      !data.startsAt ||
      !data.endsAt ||
      new Date(data.endsAt).getTime() - new Date(data.startsAt).getTime() <= 12 * 60 * 60 * 1000,
    { message: "A study session cannot be longer than 12 hours.", path: ["endsAt"] },
  );

export const rsvpSchema = z.object({
  sessionId: uuid,
  rsvp: z.enum(["GOING", "MAYBE", "NOT_GOING"]),
  attended: z.boolean().optional(),
  attendanceMinutes: z.coerce.number().int().min(0).max(720).optional(),
});

export const sessionQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const createResourceSchema = z.object({
  title: z.string().trim().min(1, "Give the resource a title.").max(160),
  description: shortText.max(1000).optional().default(""),
  kind: z.enum(["FILE", "LINK", "NOTE"]),
  visibility: z.enum(["GROUP", "COURSE", "PRIVATE"]).default("GROUP"),
  externalUrl: z.string().url().max(1000).optional().nullable(),
  content: shortText.max(50_000).optional().nullable(),
  topicId: uuid.optional().nullable(),
  planId: uuid.optional().nullable(),
});

export const resourceQuerySchema = z.object({
  kind: z.enum(["FILE", "LINK", "NOTE"]).optional(),
  topicId: uuid.optional(),
  planId: uuid.optional(),
  searchable: optionalBooleanFromQuery,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const sendMessageSchema = z.object({
  body: z.string().trim().max(4000).optional().default(""),
  parentId: uuid.optional().nullable(),
  kind: z.enum(["TEXT", "RESOURCE"]).default("TEXT"),
  resourceId: uuid.optional().nullable(),
  /** Client-generated id, so an optimistic bubble can be reconciled. */
  clientId: z.string().max(64).optional(),
}).refine((data) => data.body.length > 0 || data.resourceId, {
  message: "Write a message or attach a resource.",
  path: ["body"],
});

export const messageQuerySchema = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

// ---------------------------------------------------------------------------
// Study partners and direct messaging
// ---------------------------------------------------------------------------

export const partnerInviteSchema = z.object({
  recipientId: uuid,
  /** An optional note accompanying the request. */
  message: z.string().trim().min(1).max(500).optional(),
});

export const partnerRespondSchema = z.object({
  response: z.enum(["ACCEPT", "DECLINE"]),
});

export const partnerRevokeParamSchema = z.object({
  invitationId: uuid,
});

export const partnerRespondParamSchema = z.object({
  invitationId: uuid,
});

export const partnerConversationParamSchema = z.object({
  conversationId: uuid,
});

export const partnerMessageSchema = z
  .object({
    body: z.string().trim().max(4000),
    /** Client-generated id, so an optimistic bubble can be reconciled. */
    clientId: z.string().max(64).optional(),
  })
  .refine((data) => data.body.length > 0, {
    message: "Write a message first.",
    path: ["body"],
  });

export const partnerMessageQuerySchema = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const topicStatusSchema = z.object({
  topicId: uuid,
  status: z.enum(["NEEDS_HELP", "LEARNING", "COMFORTABLE", "STRONG"]),
  confidence: z.coerce.number().min(0).max(1).optional(),
});

export const groupFeedbackSchema = z.object({
  goalsCompatible: z.coerce.number().int().min(1).max(5),
  skillsComplementary: z.coerce.number().int().min(1).max(5),
  scheduleWorked: z.coerce.number().int().min(1).max(5),
  productive: z.coerce.number().int().min(1).max(5),
  wouldRepeat: z.boolean().optional(),
  overallRating: z.coerce.number().int().min(1).max(5),
  comment: shortText.max(1500).optional().nullable(),
});

export const quizAttemptSchema = z.object({
  title: z.string().trim().min(2).max(140),
  score: z.coerce.number().min(0),
  maxScore: z.coerce.number().positive(),
  topicId: uuid.optional().nullable(),
  questions: z.coerce.number().int().positive().optional(),
  attemptedAt: z.string().datetime({ offset: true }).optional(),
}).refine((data) => data.score <= data.maxScore, {
  message: "Your score cannot exceed the maximum score.",
  path: ["score"],
});

// =============================================================================
// Recommendations & AI
// =============================================================================

export const recommendationRequestSchema = z.object({
  kind: z.enum(["GROUP", "STUDENT"]).default("GROUP"),
  courseId: uuid.optional().nullable(),
  topicIds: z.array(uuid).max(12).default([]),
  goalId: uuid.optional().nullable(),
  availability: availabilitySchema.shape.slots.default([]),
  preferredMode: z.enum(["ONLINE", "PHYSICAL", "EITHER"]).optional(),
  minGroupSize: z.coerce.number().int().min(GROUP_SIZE.MIN).max(GROUP_SIZE.MAX).optional(),
  maxGroupSize: z.coerce.number().int().min(GROUP_SIZE.MIN).max(GROUP_SIZE.MAX).optional(),
  naturalLanguage: z.string().trim().max(1000).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Persist the request for research analytics. Off for speculative previews. */
  track: z.boolean().default(true),
  source: z.enum(["FORM", "NATURAL_LANGUAGE", "DASHBOARD", "GROUP_PAGE", "PROFILE_GAP"]).default("FORM"),
});

export const recommendationFeedbackSchema = z.object({
  recommendationId: uuid,
  helpful: z.boolean().optional().nullable(),
  reason: z
    .enum(["NOT_RELEVANT_COURSE", "SCHEDULE_MISMATCH", "GROUP_FULL", "GOAL_MISMATCH", "ALREADY_IN_GROUP", "NOT_INTERESTED", "OTHER"])
    .optional()
    .nullable(),
  comment: shortText.max(600).optional().nullable(),
});

export const aiChatSchema = z.object({
  workspaceId: uuid.optional().nullable(),
  message: z.string().trim().min(1, "Ask a question.").max(2000),
  /** Restrict answers to these resources when the user wants a grounded answer. */
  resourceIds: z.array(uuid).max(10).default([]),
  useGroupContext: z.boolean().default(true),
});

export const aiIntentSchema = z.object({
  text: z.string().trim().min(3, "Describe what you need in a little more detail.").max(1000),
  /** Course ids the student is enrolled in — constrains LLM output to real ids. */
  eligibleCourseIds: z.array(uuid).max(20).default([]),
  eligibleTopicIds: z.array(uuid).max(60).default([]),
  goalIds: z.array(uuid).max(10).default([]),
});

// =============================================================================
// Academic administration
// =============================================================================

export const universitySchema = z.object({
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers and hyphens only."),
  country: z.string().trim().max(80).default("Malaysia"),
  domain: z.string().trim().max(160).optional().nullable(),
  logoUrl: z.string().url().max(500).optional().nullable(),
  isActive: z.boolean().default(true),
});

export const facultySchema = z.object({
  universityId: uuid,
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(1).max(20),
});

export const departmentSchema = z.object({
  facultyId: uuid,
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(1).max(20),
});

export const programSchema = z.object({
  departmentId: uuid,
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(1).max(20),
  degreeLevel: z.enum(["FOUNDATION", "DIPLOMA", "UNDERGRADUATE", "POSTGRADUATE"]).default("UNDERGRADUATE"),
  durationYears: z.coerce.number().int().min(1).max(10).optional().nullable(),
});

export const courseSchema = z.object({
  departmentId: uuid.optional().nullable(),
  courseCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,4}\s?\d{3,4}[A-Za-z]?$/, "Use a code like CS2309 or CS 2309."),
  name: z.string().trim().min(2).max(160),
  description: shortText.max(2000).optional().default(""),
  creditHours: z.coerce.number().int().min(1).max(12).optional().nullable(),
  level: z.coerce.number().int().min(100).max(900).optional().nullable(),
  isActive: z.boolean().default(true),
});

export const topicSchema = z.object({
  courseId: uuid,
  name: z.string().trim().min(2).max(120),
  description: shortText.max(1000).optional().default(""),
  position: z.coerce.number().int().min(0).max(999).default(0),
  estimatedMinutes: z.coerce.number().int().min(1).max(600).optional().nullable(),
});

export const skillSchema = z.object({
  name: z.string().trim().min(2).max(80),
  category: z.string().trim().max(60).default("GENERAL"),
  courseIds: z.array(uuid).max(30).default([]),
});

export const assignLecturerSchema = z.object({
  lecturerId: uuid,
  courseIds: z.array(uuid).min(1, "Select at least one course.").max(12),
  academicYear: z.string().trim().max(20).default("default"),
  isPrimary: z.boolean().default(false),
});

export const academicActivitySchema = z.object({
  courseId: uuid,
  title: z.string().trim().min(3).max(120),
  topicIds: z.array(uuid).max(10).default([]),
  goalId: uuid.optional().nullable(),
  description: shortText.max(2000).optional().default(""),
  groupSize: z.coerce.number().int().min(2).max(12).default(4),
  mode: z.enum(["ONLINE", "PHYSICAL", "EITHER"]).default("EITHER"),
  deadline: z.string().datetime({ offset: true }).optional().nullable(),
  /** Let the recommendation engine suggest students for this activity. */
  recommendStudents: z.boolean().default(true),
});

// =============================================================================
// Admin
// =============================================================================

export const adminUserQuerySchema = z.object({
  role: z.enum(["STUDENT", "LECTURER", "ADMIN"]).optional(),
  status: z.enum(["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
  q: shortText.max(120).optional(),
  universityId: uuid.optional(),
  courseId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const changeRoleSchema = z.object({
  userId: uuid,
  role: z.enum(["STUDENT", "LECTURER", "ADMIN"]),
  reason: shortText.max(300).optional().nullable(),
});

export const suspendUserSchema = z.object({
  userId: uuid,
  reason: z.string().trim().min(5, "Give a reason for the audit trail.").max(500),
  suspendSessions: z.boolean().default(true),
});

export const restoreUserSchema = z.object({ userId: uuid, reason: shortText.max(300).optional() });

export const reportQuerySchema = z.object({
  status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"]).optional(),
  targetType: z.enum(["STUDENT", "GROUP", "MESSAGE", "RESOURCE"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const resolveReportSchema = z.object({
  reportId: uuid,
  status: z.enum(["IN_REVIEW", "RESOLVED", "DISMISSED"]),
  resolution: shortText.max(1000).optional().nullable(),
  action: z.enum(["NONE", "WARN_USER", "SUSPEND_USER", "REMOVE_CONTENT", "REMOVE_GROUP"]),
});

export const createReportSchema = z.object({
  targetType: z.enum(["STUDENT", "GROUP", "MESSAGE", "RESOURCE"]),
  targetId: uuid,
  category: z.enum(["HARASSMENT", "INAPPROPRIATE_CONTENT", "SPAM", "ACADEMIC_DISHONESTY", "IMPERSONATION", "OTHER"]),
  details: z.string().trim().min(10, "Tell us a little more.").max(2000),
});

export const weightsSchema = z.object({
  course: z.coerce.number().min(0).max(1),
  skills: z.coerce.number().min(0).max(1),
  goals: z.coerce.number().min(0).max(1),
  availability: z.coerce.number().min(0).max(1),
  preferences: z.coerce.number().min(0).max(1),
  topics: z.coerce.number().min(0).max(1),
});

export const researchQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  courseId: uuid.optional(),
  modelVersionId: z.string().max(60).optional(),
  granularity: z.enum(["day", "week", "month"]).default("week"),
});

export const settingsSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.unknown(),
  description: z.string().trim().max(300).optional(),
});

// =============================================================================
// Labels, used by the frontend to render human-readable values
// =============================================================================

export const ENUM_LABELS = Object.freeze({
  userStatus: USER_STATUS,
  learningGoal: LEARNING_GOAL_LABELS,
});

export default {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  changePasswordSchema,
  verifyEmailSchema,
};