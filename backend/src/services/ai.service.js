import env from "../config/env.js";
import { AiUnavailableError } from "../lib/errors.js";
import logger from "../config/logger.js";

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
    "Return ONLY a JSON object with these keys, omitting any you cannot determine from the text:",
    '  "courseIds": array of course ids the student explicitly asked for',
    '  "topicIds": array of topic ids the student explicitly asked for',
    '  "goalId": id of the single best-matching learning goal, or null',
    '  "availability": array of { "dayOfWeek": 0-6, "startMinute": 0-1440, "endMinute": 0-1440 }',
    '  "preferredMode": "ONLINE" | "PHYSICAL" | "EITHER"',
    '  "minGroupSize": integer 2-12, "maxGroupSize": integer 2-12',
    "",
    "Rules:",
    "- Use ONLY the ids listed below. Never invent an id. An id you are unsure about is worse than an omission.",
    "- Do not guess a course from a topic name if no course was given.",
    "- Times are minutes since midnight, local to the student. \"Tuesday evening\" is dayOfWeek 2, 18:00-21:00.",
    "- dayOfWeek: 0=Sunday, 1=Monday, 6=Saturday.",
    "- If the request names no constraint at all, return {}.",
    "- Do not include commentary, prose or explanations. JSON only.",
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
  let raw;
  try {
    raw = await callProvider([{ role: "system", content: systemPrompt }, { role: "user", content: text }]);
  } catch (error) {
    // A provider outage degrades the feature; it must not surface as a 500.
    logger.warn("AI intent parse failed", {
      studentId,
      provider: env.AI_PROVIDER,
      message: error.message,
    });
    throw new AiUnavailableError();
  }

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
    parserModel: env.AI_CHAT_MODEL,
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
  const courseIds = new Set((eligible.courses ?? []).map((course) => course.id));
  const topicIds = new Set((eligible.topics ?? []).map((topic) => topic.id));
  const goalIds = new Set((eligible.goals ?? []).map((goal) => goal.id));

  const keepKnown = (list, allowed, limit) =>
    (Array.isArray(list) ? list : []).filter((id) => allowed.has(id)).slice(0, limit);

  const availability = (Array.isArray(parsed.availability) ? parsed.availability : [])
    .map((slot) => ({
      dayOfWeek: clampInt(slot?.dayOfWeek, 0, 6),
      startMinute: clampInt(slot?.startMinute, 0, 1439),
      endMinute: clampInt(slot?.endMinute, 1, 1440),
      isPreferred: true,
    }))
    // An inverted or zero-length interval is a parse error, not a user intent.
    .filter((slot) => slot.startMinute !== null && slot.endMinute !== null && slot.endMinute > slot.startMinute)
    .slice(0, 14);

  const intent = {
    courseIds: keepKnown(parsed.courseIds, courseIds, 12),
    topicIds: keepKnown(parsed.topicIds, topicIds, 12),
    goalId: goalIds.has(parsed.goalId) ? parsed.goalId : null,
    availability,
    preferredMode: ["ONLINE", "PHYSICAL", "EITHER"].includes(parsed.preferredMode) ? parsed.preferredMode : null,
    minGroupSize: clampInt(parsed.minGroupSize, 2, 12),
    maxGroupSize: clampInt(parsed.maxGroupSize, 2, 12),
  };

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

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Call the configured provider.
 *
 * Provider-specific transports live behind this single function so that adding a
 * provider does not mean touching any of the parsing logic above.
 */
async function callProvider(messages) {
  if (env.AI_PROVIDER === "openai") {
    return callOpenAiCompatible(messages);
  }
  throw new AiUnavailableError(`Unsupported AI provider: ${env.AI_PROVIDER}`);
}

/** OpenAI-compatible chat completions. Most self-hosted and vendor APIs match. */
async function callOpenAiCompatible(messages) {
  // Defaults to the OpenAI endpoint, which every OpenAI-compatible provider
  // exposes. Overridable for self-hosted gateways.
  const baseUrl = (env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_CHAT_MODEL,
      messages,
      temperature: 0,
      max_tokens: env.AI_MAX_OUTPUT_TOKENS,
      // Ask for JSON directly so the response needs no fence stripping in the
      // common case. `parseJson` still copes if the provider ignores it.
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AI provider returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("AI provider returned no message content");

  return content;
}

/** Whether AI features are usable right now. Surfaced on the health endpoint. */
export function aiStatus() {
  return {
    configured: Boolean(env.AI_PROVIDER),
    provider: env.AI_PROVIDER ?? null,
    model: env.AI_CHAT_MODEL ?? null,
    // Honest about the degradation contract: everything except natural-language
    // search and RAG answers works without this.
    required: false,
  };
}

export const intentContract = { ALLOWED_INTENT_KEYS };

export default { parseNaturalLanguage, aiStatus };