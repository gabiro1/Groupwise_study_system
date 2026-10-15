import env from "../config/env.js";
import { AiUnavailableError } from "../lib/errors.js";
import logger from "../config/logger.js";
import { callProvider as invokeProvider } from "../modules/ai/orchestration.js";
import { getTargets } from "../modules/ai/registry.js";

/**
 * Natural-language intent extraction.
 *
 * The narrow, carefully bounded role the LLM plays in Lien:
 *
 *   **in**  — a sentence like "I need someone strong in calculus who is free
 *             Tuesday evenings" becomes structured requirements.
 *   **out** — a set of ids the student is actually enrolled in, and a confidence.
 *
 * Everything downstream of this file is deterministic. The model never sees a
 * score, never ranks anything, and never chooses a person. If it invents a course
 * id that is not in the eligible list, the id is dropped rather than trusted.
 *
 * When no provider is configured, `parseNaturalLanguage` throws
 * `AiUnavailableError` and the caller degrades to structured input. The product
 * works without it; that is a requirement, not a fallback.
 */

/** Only these keys may leave the parser. Anything else is discarded. */
const ALLOWED_INTENT_KEYS = Object.freeze([
  "courseIds",
  "topicIds",
  "goalId",
  "availability",
  "preferredMode",
  "minGroupSize",
  "maxGroupSize",
]);

/**
 * The system prompt.
 *
 * Its job is to constrain, not to reason. Every candidate id is supplied inline so
 * the model is choosing from a fixed list rather than recalling from memory —
 * which is what makes hallucinated ids detectable and discardable.
 */
function buildSystemPrompt({ courses, topics, goals }) {
  return [
    "You convert a student's study request into a structured search filter for a study-group matching engine.",
    "",
    "You are NOT matching students and you are NOT scoring compatibility. You only extract stated requirements.",
    "",
    "Return ONLY a JSON object with these keys (omit any you cannot determine):",
    '  "courseIds": array of course ids the student explicitly asked for',
    '  "topicIds": array of topic ids',
    '  "goalId": id of the single best-matching learning goal, or null',
    '  "availability": array of { "dayOfWeek": 0-6, "startMinute": 0-1440, "endMinute": 0-1440 }',
    '  "preferredMode": "ONLINE" | "PHYSICAL" | "EITHER"',
    '  "minGroupSize": integer 2-12',
    '  "maxGroupSize": integer 2-12',
    "",
    "Rules:",
    "- Prefer the ids listed below, copied EXACTLY. If the student names a course by its code or name, return that course's id.",
    "- preferredMode MUST be one of the three uppercase values. Use EITHER when unspecified.",
    "- availability MUST be structured numbers, never a phrase. dayOfWeek is 0=Sunday .. 6=Saturday.",
    "  Convert time words: morning=540-720, afternoon=720-1020, evening=1020-1260, night=1200-1380.",
    "- Convert group-size words: small=2-4, medium=3-6, large=6-12.",
    '- Example: "small calculus group Wednesday afternoon online" ->',
    '  {"courseIds":["<calculus id>"],"availability":[{"dayOfWeek":3,"startMinute":720,"endMinute":1020}],"preferredMode":"ONLINE","minGroupSize":2,"maxGroupSize":4}',
    "- If the request names no constraint at all, return {}.",
    "- JSON only: no prose, no markdown fences, no commentary.",
    "",
    "AVAILABLE COURSES (id | code | name):",
    ...courses.map((course) => `  ${course.id} | ${course.course_code} | ${course.name}`),
    "",
    "AVAILABLE TOPICS (id | course code | topic):",
    ...topics.map((topic) => `  ${topic.id} | ${topic.courseCode} | ${topic.name}`),
    "",
    "AVAILABLE GOALS (id | label):",
    ...goals.map((goal) => `  ${goal.id} | ${goal.label}`),
  ].join("\n");
}

/**
 * Parse a natural-language request.
 *
 * @param {string} text
 * @param {{courses:Array, topics:Array, goals:Array}} eligible Ids the student may use.
 * @param {string} studentId For audit logging.
 */
export async function parseNaturalLanguage(text, eligible, studentId) {
// `aiEnabled` requires both a provider and an API key, so a half-configured
  // deployment degrades rather than sending unauthenticated requests.
  if (!env.aiEnabled) {
    throw new AiUnavailableError();
  }

  const systemPrompt = buildSystemPrompt(eligible);

  const startedAt = process.hrtime.bigint();
  let result;
  try {
    result = await callProvider([{ role: "system", content: systemPrompt }, { role: "user", content: text }]);
  } catch (error) {
    // A provider outage degrades the feature; it must not surface as a 500.
    logger.warn("AI intent parse failed", {
      studentId,
      provider: env.AI_PROVIDER,
      message: error.message,
    });
    throw new AiUnavailableError();
  }

  const raw = result.text;

  const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
  const intent = sanitise(parseJson(raw), eligible);

  logger.info("AI intent parsed", {
    studentId,
    latencyMs,
    confidence: intent.confidence,
    courseCount: intent.courseIds.length,
    topicCount: intent.topicIds.length,
  });

  return {
    ...intent,
    naturalLanguage: text,
    parserModel: result.model,
    latencyMs,
  };
}

/**
 * Extract JSON from a model response.
 *
 * Wrapped in an object first because models routinely wrap JSON in a ```json
 * fence or add a sentence of preamble; both are recoverable, whereas malformed
 * JSON without them is not.
 */
function parseJson(raw) {
  const text = String(raw ?? "").trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return {};

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return {};
  }
}

/**
 * Whitelist the model's output against the eligible id sets.
 *
 * This is the important function in the file. The model is treated as untrusted:
 * an id that was not offered is discarded, a time slot that is not a real interval
 * is discarded, and nothing is passed through that the database would later have
 * to reject. A parser that returns an empty intent is safe; a parser that returns
 * an invented course id is not.
 */
function sanitise(parsed, eligible) {
  const courseResolver = buildResolver(eligible.courses, ["id", "courseCode", "name"]);
  const topicResolver = buildResolver(eligible.topics, ["id", "name"]);
  const goalResolver = buildResolver(eligible.goals, ["id", "code", "label"]);

  const intent = {
    courseIds: resolveIdList(parsed.courseIds, courseResolver, 12),
    topicIds: resolveIdList(parsed.topicIds, topicResolver, 12),
    goalId: goalResolver(parsed.goalId),
    availability: normaliseAvailability(parsed.availability),
    preferredMode: normaliseMode(parsed.preferredMode),
    minGroupSize: clampInt(parsed.minGroupSize, 2, 12),
    maxGroupSize: clampInt(parsed.maxGroupSize, 2, 12),
  };

  // A max below the min is a parse error; widen it rather than return a filter
  // the ranking engine would treat as impossible.
  if (intent.minGroupSize && intent.maxGroupSize && intent.maxGroupSize < intent.minGroupSize) {
    intent.maxGroupSize = intent.minGroupSize;
  }

  // Confidence reflects how much the parser actually extracted. A request that
  // yielded nothing usable is explicitly low confidence, so the UI can fall back
  // to the structured form rather than showing "no matches" from a bad parse.
  const signals = [
    intent.courseIds.length > 0,
    intent.topicIds.length > 0,
    intent.goalId !== null,
    intent.availability.length > 0,
    intent.preferredMode !== null,
  ];
  const filled = signals.filter(Boolean).length;

  intent.confidence = Math.round((filled / signals.length) * 100) / 100;
  intent.extractedSignals = filled;

  return intent;
}

/** Loose key: lowercased, punctuation/space stripped so "MATH 101" === "math101". */
function normaliseKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Build a `value -> id` resolver from eligible rows, matching on any of the given
 * keys (id, code, or name). Models frequently echo a course code or a name
 * instead of the uuid; this recovers those without trusting anything outside the
 * eligible set.
 */
function buildResolver(items, keys) {
  const map = new Map();
  for (const item of items ?? []) {
    for (const key of keys) {
      const normalised = normaliseKey(item?.[key]);
      if (normalised && !map.has(normalised)) map.set(normalised, item.id);
    }
  }
  return (value) => map.get(normaliseKey(value)) ?? null;
}

function resolveIdList(list, resolver, limit) {
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const id = resolver(value);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

const MODE_SYNONYMS = {
  ONLINE: "ONLINE",
  REMOTE: "ONLINE",
  VIRTUAL: "ONLINE",
  PHYSICAL: "PHYSICAL",
  INPERSON: "PHYSICAL",
  ONSITE: "PHYSICAL",
  CAMPUS: "PHYSICAL",
  EITHER: "EITHER",
  BOTH: "EITHER",
  ANY: "EITHER",
  HYBRID: "EITHER",
};

function normaliseMode(value) {
  if (typeof value !== "string") return null;
  return MODE_SYNONYMS[value.toUpperCase().replace(/[^A-Z]/g, "")] ?? null;
}

const DAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function normaliseAvailability(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((slot) => ({
        dayOfWeek: clampInt(slot?.dayOfWeek, 0, 6),
        startMinute: coerceMinute(slot?.startMinute, 0, 1439),
        endMinute: coerceMinute(slot?.endMinute, 1, 1440),
        isPreferred: true,
      }))
      // An inverted or zero-length interval is a parse error, not a user intent.
      .filter((slot) => slot.dayOfWeek !== null && slot.startMinute !== null && slot.endMinute !== null && slot.endMinute > slot.startMinute)
      .slice(0, 14);
  }
  // Some models answer with a phrase ("Wednesday afternoons") instead of the
  // structured array the prompt asks for. Recover it rather than drop it.
  if (typeof raw === "string") return parseAvailabilityText(raw);
  return [];
}

function coerceMinute(value, min, max) {
  if (typeof value === "string" && value.includes(":")) {
    const [hours, minutes] = value.split(":");
    const h = Number.parseInt(hours, 10);
    const m = Number.parseInt(minutes, 10);
    if (Number.isFinite(h) && Number.isFinite(m)) return Math.min(max, Math.max(min, h * 60 + m));
  }
  return clampInt(value, min, max);
}

/** Recover structured slots from a free-text availability phrase. */
function parseAvailabilityText(text) {
  const lower = String(text).toLowerCase();

  const days = [];
  for (const [name, index] of Object.entries(DAY_INDEX)) {
    if (lower.includes(name)) days.push(index);
  }
  if (lower.includes("weekday")) for (const day of [1, 2, 3, 4, 5]) if (!days.includes(day)) days.push(day);
  if (!days.length) return [];

  let start = null;
  let end = null;

  const explicit = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|till|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(lower);
  if (explicit) {
    start = toMinutes(explicit[1], explicit[2], explicit[3]);
    end = toMinutes(explicit[4], explicit[5], explicit[6]);
  } else if (lower.includes("morning")) {
    start = 540;
    end = 720;
  } else if (lower.includes("afternoon")) {
    start = 720;
    end = 1020;
  } else if (lower.includes("evening")) {
    start = 1020;
    end = 1260;
  } else if (lower.includes("night")) {
    start = 1200;
    end = 1380;
  }

  if (start === null || end === null || end <= start) return [];

  return days.map((dayOfWeek) => ({ dayOfWeek, startMinute: start, endMinute: end, isPreferred: true }));
}

function toMinutes(hours, minutes, meridiem) {
  let h = Number.parseInt(hours, 10);
  const m = minutes ? Number.parseInt(minutes, 10) : 0;
  if (!Number.isFinite(h)) return null;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  // No meridiem and a small hour is almost always afternoon/evening in this context.
  if (!meridiem && h < 8) h += 12;
  return Math.min(1440, Math.max(0, h * 60 + m));
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Call the configured provider chain.
 *
 * Transport selection, failover across the configured target list, and the
 * per-target circuit breaker all live behind the orchestration module, so this
 * file only decides the JSON mode.
 */
async function callProvider(messages) {
  // Intent parsing always wants a JSON object back.
  return invokeProvider(messages, { jsonMode: true });
}

/** Whether AI features are usable right now. Surfaced on the health endpoint. */
export function aiStatus() {
  const targets = getTargets();
  return {
    configured: targets.length > 0,
    provider: targets[0]?.provider ?? null,
    model: targets[0]?.chatModel ?? null,
    // Ordered failover chain (primary first). The UI only needs `configured`.
    chain: targets.map((target) => ({
      provider: target.provider,
      model: target.chatModel,
      label: target.label,
    })),
    fallbacks: Math.max(0, targets.length - 1),
    // Honest about the degradation contract: everything except natural-language
    // search and RAG answers works without this.
    required: false,
  };
}

export const intentContract = { ALLOWED_INTENT_KEYS };

export default { parseNaturalLanguage, aiStatus };