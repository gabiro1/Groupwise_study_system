import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStudent, requireAuth } from "../middleware/auth.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import env from "../config/env.js";
import { queryRows, queryOne } from "../config/db.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { assertWorkspaceAccess } from "../services/workspace.service.js";
import { aiStatus, parseNaturalLanguage } from "../services/ai.service.js";
import { aiChatSchema, aiIntentSchema, z } from "../lib/schemas.js";

const router = Router();

/**
 * AI routes.
 *
 * Two features, both optional:
 *
 *   1. Intent parsing — a sentence becomes structured search filters.
 *   2. Grounded answers — a question is answered from the group's own resources,
 *      with the sources attached.
 *
 * The design rule that matters: **the model never decides anything.** It never
 * picks a match, never ranks, never invents a citation. Anything it produces is
 * either a filter the student can edit, or text labelled with its sources. Both
 * features return a clear `available: false` when no provider is configured, so
 * the UI can hide them rather than showing a failure.
 */

// The role guard below depends on `req.user`, so `requireAuth` must run first.
router.use(requireAuth);
router.use(requireStudent);

/** GET /api/ai/status — drives whether the UI shows AI affordances at all. */
router.get(
  "/status",
  asyncHandler(async (_req, res) => {
    return ok(res, {
      ai: aiStatus(),
      // Plain-language capability list. The frontend uses the keys, the user never
      // sees this object.
      capabilities: {
        intentParsing: env.aiEnabled,
        groundedAnswers: env.aiEnabled,
        embeddings: env.aiEnabled,
      },
    });
  }),
);

/**
 * POST /api/ai/parse-intent
 *
 * Returns a structured, *editable* filter object. Nothing is ranked here: the
 * student reviews the parse, corrects it, and then searches. Returning a parse
 * the student cannot see would hide the system's assumptions behind a result.
 */
router.post(
  "/parse-intent",
  aiLimiter,
  validate({ body: aiIntentSchema }),
  asyncHandler(async (req, res) => {
    if (!env.aiEnabled) {
      return ok(res, {
        available: false,
        reason: "AI_DISABLED",
        message: "Natural-language search is off in this environment. Use the filters instead.",
        intent: null,
      });
    }

    const eligible = await loadEligible(req.user.id, req.body);
    const intent = await parseNaturalLanguage(req.body.text, eligible, req.user.id);

    return ok(res, { available: true, intent });
  }),
);

/**
 * POST /api/ai/chat
 *
 * Answers from the group's uploaded material and recent discussion.
 *
 * Sources are mandatory: the query runs only against resources the student is
 * already entitled to see (their groups, and their courses), and the response
 * carries the ids it actually used. A model that produced no retrievable
 * evidence returns "I could not find that in your material" rather than a
 * plausible-sounding guess.
 */
router.post(
  "/chat",
  aiLimiter,
  validate({ body: aiChatSchema }),
  asyncHandler(async (req, res) => {
    const { workspaceId, message, resourceIds, useGroupContext } = req.body;

    if (!env.aiEnabled) {
      return ok(res, {
        available: false,
        reason: "AI_DISABLED",
        message: "Ask is unavailable in this environment.",
        answer: null,
        sources: [],
      });
    }

    // Authorisation happens before retrieval, never after: the prompt is only
    // built from context this student may already read.
    let workspace = null;
    if (workspaceId) {
      workspace = await assertWorkspaceAccess(workspaceId, req.user.id).then(
        (access) => access.workspace,
      );
    }

    const context = await gatherContext({
      userId: req.user.id,
      workspaceId: useGroupContext ? workspaceId : null,
      resourceIds,
      message,
    });

    // No evidence means no answer. Inventing one would be the single worst
    // failure mode for an academic tool.
    if (context.chunks.length === 0 && context.recentMessages.length === 0) {
      return ok(res, {
        available: true,
        answer: null,
        reason: "NO_CONTEXT",
        message: workspaceId
          ? "Your group has no material I can read yet. Share a resource or a file first."
          : "No material is available to answer from yet.",
        sources: [],
      });
    }

    const answer = await answerFromContext(message, context);
    return ok(res, answer);
  }),
);

/**
 * POST /api/ai/resources/:resourceId/summarise
 *
 * Summary of a single resource the student can already open. Cheaper and more
 * predictable than retrieval, and the resource id is checked for access first.
 */
router.post(
  "/resources/:resourceId/summarise",
  aiLimiter,
  validate({ params: z.object({ resourceId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    if (!env.aiEnabled) {
      return ok(res, { available: false, reason: "AI_DISABLED", summary: null });
    }

    const resource = await loadAccessibleResource(req.user.id, req.params.resourceId);
    if (!resource) throw new NotFoundError("That resource");

    const summary = await summariseResource(resource);
    return created(res, { available: true, ...summary });
  }),
);

// ---------------------------------------------------------------------------
// Retrieval and generation
// ---------------------------------------------------------------------------

/**
 * Gather the text this student is allowed to use as context.
 *
 * Access control is expressed in SQL: workspace resources are limited to
 * workspaces the student belongs to, and course resources to courses they are
 * enrolled in or teach. There is no code path that fetches a resource first and
 * checks permission afterwards.
 */
async function gatherContext({ userId, workspaceId, resourceIds, message }) {
  const params = [userId];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const resourceClauses = [
    `r.is_deleted = FALSE`,
    `r.extraction_status IN ('COMPLETE', 'SKIPPED')`,
    `(r.visibility <> 'PRIVATE' OR r.uploaded_by = $1)`,
    // Student-authored scope: a group the student is an active member of, or a
    // course they are enrolled in.
    `(
      (r.workspace_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM workspaces w
           JOIN study_group_members m ON m.group_id = w.group_id
          WHERE w.id = r.workspace_id AND m.student_id = ${bind(userId)}
            AND m.left_at IS NULL AND m.status = 'ACTIVE'))
      OR
      (r.course_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM student_courses sc
          WHERE sc.course_id = r.course_id AND sc.student_id = ${bind(userId)}))
    )`,
  ];

  if (workspaceId) {
    resourceClauses.push(`r.workspace_id = ${bind(workspaceId)}`);
  }
  if (resourceIds.length) {
    resourceClauses.push(`r.id = ANY(${bind(resourceIds)}::uuid[])`);
  }

  const resources = await queryRows(
    `SELECT r.id, r.title, r.description, r.kind, r.topic_id, r.workspace_id, r.course_id,
            left(coalesce(r.extracted_text, r.description), 2000) AS text
       FROM resources r
      WHERE ${resourceClauses.join(" AND ")}
      ORDER BY r.updated_at DESC
      LIMIT 12`,
    params,
    "ai:resources",
  );

  const recentMessages = workspaceId
    ? await queryRows(
        `SELECT m.id, m.body, m.kind, m.created_at, u.first_name
           FROM messages m LEFT JOIN users u ON u.id = m.author_id
          WHERE m.workspace_id = $1 AND m.deleted_at IS NULL AND m.kind <> 'AI'
          ORDER BY m.created_at DESC LIMIT 15`,
        [workspaceId],
        "ai:groupMessages",
      )
    : [];

  // Relevance is a simple keyword overlap, not a vector search: with a handful of
  // resources per group, an embedding round-trip would cost latency and money
  // without changing the answer. Chunking exists so a long document is not
  // truncated away.
  const keywords = tokenise(message ?? "");
  const chunks = resources
    .flatMap((resource) => splitIntoChunks(resource.text).map((chunk) => ({ resource, chunk })))
    .map((entry) => ({ ...entry, score: overlapScore(keywords, entry.chunk) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  return { resources, chunks, recentMessages: recentMessages.reverse() };
}

const tokenise = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );

function splitIntoChunks(text, size = 1200) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function overlapScore(keywords, chunk) {
  if (keywords.size === 0) return 0;
  const tokens = tokenise(chunk);
  let hits = 0;
  for (const keyword of keywords) {
    if (tokens.has(keyword)) hits += 1;
  }
  return hits / keywords.size;
}

/**
 * Ask the model, constrained to the retrieved text, and demand citations.
 *
 * The instruction to refuse rather than guess is part of the prompt, not a hope.
 * Sources are then filtered to those the response actually quotes, so the UI
 * shows no citation the answer did not use.
 */
async function answerFromContext(message, context) {
  const contextBlocks = context.chunks.length
    ? context.chunks.map((entry, index) => `[${index + 1}] (resource: ${entry.resource.title})\n${entry.chunk}`)
    : [];

  if (context.recentMessages.length) {
    contextBlocks.push(
      `Recent group discussion:\n${context.recentMessages.map((m) => `${m.first_name ?? "Someone"}: ${m.body}`).join("\n")}`,
    );
  }

  const system = [
    "You answer questions about a study group's own material.",
    "",
    "Rules you must follow:",
    "- Use ONLY the numbered context below. If it does not contain the answer, say so plainly.",
    "- Never use general knowledge to fill a gap. Guessing is worse than admitting ignorance here.",
    "- Cite the numbers you used, like [1], inline.",
    "- Be concise and practical. A student is usually preparing for an exam.",
    "- If the context is off-topic, say the material does not cover it.",
    "",
    "CONTEXT:",
    ...contextBlocks,
  ].join("\n");

  const response = await callModel([
    { role: "system", content: system },
    { role: "user", content: message },
  ]);

  const cited = new Set();
  for (const match of response.matchAll(/\[(\d+)\]/g)) {
    const index = Number.parseInt(match[1], 10) - 1;
    if (index >= 0 && index < context.chunks.length) cited.add(index);
  }

  const sources = [...cited]
    .sort((a, b) => a - b)
    .map((index) => {
      const entry = context.chunks[index];
      return {
        resourceId: entry.resource.id,
        title: entry.resource.title,
        kind: entry.resource.kind,
        relevance: Number(entry.score.toFixed(2)),
        excerpt: entry.chunk.slice(0, 240),
      };
    });

  // Nothing cited and no discussion context means the model ignored its
  // instructions. Better to return nothing than to present an unsourced answer as
  // if it came from the group's material.
  const hasDiscussion = context.recentMessages.length > 0;
  if (sources.length === 0 && !hasDiscussion) {
    return {
      available: true,
      answer: null,
      reason: "NO_GROUNDING",
      message: "I could not find anything in your material that answers that.",
      sources: [],
    };
  }

  return {
    available: true,
    answer: response,
    sources,
    model: env.AI_CHAT_MODEL,
    // Explicit honesty about grounding: with no citations the text is discussion
    // synthesis, not something the group wrote down.
    grounded: sources.length > 0,
  };
}

async function summariseResource(resource) {
  const text = [resource.title, resource.description, resource.extracted_text]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);

  if (!text.trim()) {
    return { summary: null, reason: "NOTHING_TO_SUMMARISE" };
  }

  const summary = await callModel([
    {
      role: "system",
      content:
        "Summarise this study material in at most 5 bullet points, then one line naming the single most likely exam topic. Plain text only.",
    },
    { role: "user", content: text },
  ]);

  return {
    summary,
    resource: { id: resource.id, title: resource.title, kind: resource.kind },
    model: env.AI_CHAT_MODEL,
  };
}

/** Load one resource the student may read, or null. */
async function loadAccessibleResource(userId, resourceId) {
  return queryOne(
    `SELECT r.* FROM resources r
      WHERE r.id = $1 AND r.is_deleted = FALSE AND (
        (r.workspace_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM workspaces w JOIN study_group_members m ON m.group_id = w.group_id
            WHERE w.id = r.workspace_id AND m.student_id = $2 AND m.left_at IS NULL AND m.status = 'ACTIVE'))
        OR
        (r.course_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM student_courses sc WHERE sc.course_id = r.course_id AND sc.student_id = $2))
        OR
        (r.course_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM lecturer_courses lc WHERE lc.course_id = r.course_id AND lc.lecturer_id = $2))
      )`,
    [resourceId, userId],
    "ai:loadResource",
  );
}

async function callModel(messages) {
  const baseUrl = (env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model: env.AI_CHAT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: env.AI_MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError("The assistant is unavailable right now.", {
      status: 502,
      code: "AI_PROVIDER_ERROR",
      details: body.slice(0, 200),
    });
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AppError("The assistant returned an unusable response.", {
      status: 502,
      code: "AI_BAD_RESPONSE",
    });
  }

  return content;
}

export default router;