async function request(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || "The AI service could not be reached.");
    error.status = response.status;
    throw error;
  }
  return result.data;
}

/** GET /api/ai/status — whether AI features are configured at all. */
export function getAiStatus() {
  return request("ai/status");
}

/**
 * POST /api/recommendations/parse-intent
 *
 * Turns a sentence into the same structured filters the ranking engine accepts.
 * The response carries the eligible ids with labels so the UI can show the
 * student exactly what was understood and let them correct it.
 */
export function parseStudyIntent(text, { eligibleCourseIds = [], eligibleTopicIds = [], goalIds = [] } = {}) {
  return request("recommendations/parse-intent", {
    method: "POST",
    body: JSON.stringify({ text, eligibleCourseIds, eligibleTopicIds, goalIds }),
  });
}

/** POST /api/recommendations — deterministic ranking from structured filters. */
export function fetchRecommendations(payload) {
  return request("recommendations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** PATCH /api/recommendations/:id/outcome — the behavioural funnel. */
export function recordRecommendationOutcome(recommendationId, action, reason) {
  return request(`recommendations/${recommendationId}/outcome`, {
    method: "PATCH",
    body: JSON.stringify(reason ? { action, reason } : { action }),
  });
}

/** POST /api/recommendations/feedback — the qualitative opinion on a card. */
export function sendRecommendationFeedback(recommendationId, helpful) {
  return request("recommendations/feedback", {
    method: "POST",
    body: JSON.stringify({ recommendationId, helpful }),
  });
}

/**
 * POST /api/ai/chat
 *
 * Grounded answers from the student's own material. With no `groupId` the
 * backend searches every course and study group the student can access, so
 * the floating assistant can answer across their whole study space.
 */
export function askAssistant({ message, groupId = null, resourceIds = [], useGroupContext = false, sourceMode, researchOptions }) {
  return request("ai/chat", {
    method: "POST",
    body: JSON.stringify({ groupId, resourceIds, message, useGroupContext, sourceMode, researchOptions }),
  });
}
