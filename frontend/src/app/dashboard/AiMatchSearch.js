"use client";

import { useState } from "react";
import {
  parseStudyIntent,
  fetchRecommendations,
  recordRecommendationOutcome,
  sendPartnerRequest,
} from "./aiClient";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function reasonText(reason) {
  return reason?.detail || reason?.description || reason?.type?.replaceAll("_", " ").toLowerCase() || "";
}

function formatSlot(slot) {
  const day = DAYS[slot.dayOfWeek] ?? "";
  const start = new Date(2000, 0, 1, 0, slot.startMinute);
  const end = new Date(2000, 0, 1, 0, slot.endMinute);
  const time = (date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${time(start)}–${time(end)}`;
}

function fullName(item) {
  return [item.firstName, item.lastName].filter(Boolean).join(" ") || "A study partner";
}

/**
 * Natural-language search for a "perfect" group or partner.
 *
 * The model only parses the sentence into filters. Ranking stays deterministic:
 * the parsed filters are shown to the student as removable chips, then handed to
 * the existing recommendation engine. When no provider is configured the panel
 * stays visible but explains that AI search is off, rather than failing.
 */
export default function AiMatchSearch({ kind = "GROUP", onJoin, onNotice, heading, blurb }) {
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState(null);
  const [eligible, setEligible] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState("");
  const [requestedIds, setRequestedIds] = useState([]);

  const isStudent = kind === "STUDENT";
  const title = heading || (isStudent ? "Find your ideal study partner" : "Find your ideal study group");
  const copy = blurb || (isStudent
    ? "Describe who you want to study with — courses, topics, times — and we’ll rank the best matches."
    : "Describe what you want to study and when, and we’ll rank the best-fitting groups.");

  const courseLabels = new Map((eligible?.courses || []).map((c) => [c.id, `${c.courseCode} · ${c.name}`]));
  const topicLabels = new Map((eligible?.topics || []).map((t) => [t.id, `${t.courseCode} · ${t.name}`]));
  const goalLabels = new Map((eligible?.goals || []).map((g) => [g.id, g.label]));

  function notify(message) {
    if (onNotice) onNotice(message);
    else {
      setNote(message);
      window.setTimeout(() => setNote(""), 3500);
    }
  }

  function buildPayload(intent, overrides = {}) {
    const merged = { ...intent, ...overrides };
    return {
      kind,
      courseId: merged.courseIds?.[0] ?? null,
      topicIds: merged.topicIds ?? [],
      goalId: merged.goalId ?? null,
      availability: merged.availability ?? [],
      preferredMode: merged.preferredMode || undefined,
      minGroupSize: merged.minGroupSize || undefined,
      maxGroupSize: merged.maxGroupSize || undefined,
      naturalLanguage: text || null,
      limit: 20,
      track: true,
      source: "NATURAL_LANGUAGE",
    };
  }

  async function runSearch(payload) {
    setLoading(true);
    setError("");
    try {
      const data = await fetchRecommendations(payload);
      setResults(data.results || []);
      setSearched(true);
    } catch (requestError) {
      setError(requestError.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function submitSearch(event) {
    event.preventDefault();
    const query = text.trim();
    if (query.length < 3) {
      setError("Describe what you’re looking for in a little more detail.");
      return;
    }
    setParsing(true);
    setError("");
    setResults([]);
    setSearched(false);
    try {
      const parsed = await parseStudyIntent(query);
      if (parsed.available === false) {
        setFilters(null);
        setEligible(parsed.eligible || null);
        setConfidence(null);
        setError(parsed.message || "AI search is off. Enable a provider to turn it on, or use the filters below.");
        return;
      }
      setFilters(parsed.intent);
      setEligible(parsed.eligible || null);
      setConfidence(parsed.intent?.confidence ?? null);
      await runSearch(buildPayload(parsed.intent));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setParsing(false);
    }
  }

  function removeFilter(key, value) {
    setFilters((current) => {
      if (!current) return current;
      if (key === "goalId") return { ...current, goalId: null };
      return { ...current, [key]: (current[key] || []).filter((id) => id !== value) };
    });
  }

  function refine() {
    if (!filters) return;
    runSearch(buildPayload(filters));
  }

  async function joinGroup(recommendation) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await recordRecommendationOutcome(recommendation.recommendationId, "ACCEPTED");
      const result = await onJoin({
        id: recommendation.groupId,
        name: recommendation.name,
        workspaceId: recommendation.workspaceId,
      });
      if (result?.status === "JOINED" || result?.status === "REQUESTED") {
        setResults((current) => current.filter((item) => item.recommendationId !== recommendation.recommendationId));
        notify(result.status === "JOINED" ? "You’ve joined the study group." : "Your request to join was sent.");
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function requestPartner(recommendation) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await recordRecommendationOutcome(recommendation.recommendationId, "CLICKED");
      await sendPartnerRequest(recommendation.studentId);
      setRequestedIds((current) => [...current, recommendation.studentId]);
      notify("Partner request sent. They can accept it on their Study partners page.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function dismiss(recommendation) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await recordRecommendationOutcome(recommendation.recommendationId, "REJECTED", "NOT_INTERESTED");
      setResults((current) => current.filter((item) => item.recommendationId !== recommendation.recommendationId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  const busy = parsing || loading;

  return (
    <section className="panel ai-match" aria-label={title}>
      <div className="ai-match-heading">
        <span className="section-overline">AI MATCH</span>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>

      <form className="ai-match-form" onSubmit={submitSearch}>
        <label className="sr-only" htmlFor={`ai-match-${kind}`}>Describe your ideal {isStudent ? "partner" : "group"}</label>
        <textarea
          id={`ai-match-${kind}`}
          rows={2}
          maxLength={1000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={isStudent
            ? "e.g. Someone strong in linear algebra who’s free Tuesday evenings and prefers online"
            : "e.g. A small calculus group that meets Wednesday afternoons on campus"}
        />
        <button className="button button-primary" type="submit" disabled={busy || text.trim().length < 3}>
          {parsing ? "Understanding…" : loading ? "Finding matches…" : isStudent ? "Find partners" : "Find groups"}
        </button>
      </form>

      {filters && (
        <div className="ai-match-parse">
          <div className="ai-match-parse-top">
            <span>
              <strong>What I understood</strong>
              {confidence != null && <small> · {Math.round(confidence * 100)}% confidence</small>}
            </span>
            <button type="button" className="ai-match-refine" onClick={refine} disabled={busy}>
              Search again
            </button>
          </div>
          <div className="ai-match-chips">
            {(filters.courseIds || []).map((id) => (
              <span className="ai-match-chip" key={`course-${id}`}>
                {courseLabels.get(id) || "Course"}
                <button type="button" aria-label="Remove course filter" onClick={() => removeFilter("courseIds", id)}>×</button>
              </span>
            ))}
            {(filters.topicIds || []).map((id) => (
              <span className="ai-match-chip" key={`topic-${id}`}>
                {topicLabels.get(id) || "Topic"}
                <button type="button" aria-label="Remove topic filter" onClick={() => removeFilter("topicIds", id)}>×</button>
              </span>
            ))}
            {filters.goalId && (
              <span className="ai-match-chip" key="goal">
                {goalLabels.get(filters.goalId) || "Goal"}
                <button type="button" aria-label="Remove goal filter" onClick={() => removeFilter("goalId")}>×</button>
              </span>
            )}
            {filters.preferredMode && <span className="ai-match-chip static">{filters.preferredMode.toLowerCase()} mode</span>}
            {(filters.minGroupSize || filters.maxGroupSize) && (
              <span className="ai-match-chip static">
                group size {filters.minGroupSize || "?"}–{filters.maxGroupSize || "?"}
              </span>
            )}
            {(filters.availability || []).map((slot, index) => (
              <span className="ai-match-chip static" key={`slot-${index}`}>{formatSlot(slot)}</span>
            ))}
            {!(filters.courseIds || []).length
              && !(filters.topicIds || []).length
              && !filters.goalId
              && !filters.preferredMode
              && !(filters.availability || []).length
              && <span className="ai-match-chip static">No specific filters — using your profile</span>}
          </div>
          <p className="ai-match-hint">Remove any filter to refine, then search again.</p>
        </div>
      )}

      {error && <div className="feature-error" role="alert">{error}</div>}
      {note && <div className="feature-success" role="status">{note}</div>}

      {loading && <p className="empty-state" role="status">{isStudent ? "Ranking students who complement your learning…" : "Ranking groups that fit your request…"}</p>}

      {!loading && searched && results.length === 0 && !error && (
        <p className="empty-state">
          No strong matches yet. Try naming a different course or topic, or broaden your availability.
        </p>
      )}

      <div className="ai-match-results">
        {results.map((item) => {
          const itemBusy = busyId === item.recommendationId;
          if (isStudent) {
            const requested = requestedIds.includes(item.studentId);
            return (
              <article className="panel recommendation-card" key={item.recommendationId || item.studentId}>
                <div className="recommendation-card-top">
                  <div>
                    <span className="section-overline">
                      {item.yearOfStudy ? `${item.yearOfStudy}${["st", "nd", "rd", "th"][Math.min(item.yearOfStudy - 1, 3)]} year · ` : ""}
                      {item.sharedCourses} shared {item.sharedCourses === 1 ? "course" : "courses"}
                    </span>
                    <h2>{fullName(item)}</h2>
                  </div>
                  <span className="match-score" aria-label={`${Math.round(item.score)} percent match`}>
                    <strong>{Math.round(item.score)}%</strong><small>{item.label}</small>
                  </span>
                </div>
                <div className="recommendation-reasons">
                  <strong>Why this partner?</strong>
                  {item.reasons?.length
                    ? <ul>{item.reasons.slice(0, 3).map((reason, index) => <li key={`${reason.type}-${index}`}>{reasonText(reason)}</li>)}</ul>
                    : <p>{item.confidenceNote || "This student matches your learning profile."}</p>}
                </div>
                {item.warnings?.length > 0 && (
                  <p className="recommendation-caveat">{item.warnings.map(reasonText).filter(Boolean).join(" ")}</p>
                )}
                <div className="recommendation-actions">
                  <button className="button button-primary" type="button" disabled={itemBusy || requested} onClick={() => requestPartner(item)}>
                    {itemBusy ? "Sending…" : requested ? "Request sent" : "Send partner request"}
                  </button>
                  <button className="recommendation-dismiss" type="button" disabled={itemBusy || requested} onClick={() => dismiss(item)}>Not for me</button>
                </div>
                {requested && <p className="recommendation-thanks" role="status">Request sent. They can accept it on their Study partners page.</p>}
              </article>
            );
          }
          return (
            <article className="panel recommendation-card" key={item.recommendationId || item.groupId}>
              <div className="recommendation-card-top">
                <div>
                  <span className="section-overline">{item.courseCode ? `${item.courseCode} · ` : ""}{item.courseName || "STUDY GROUP"}</span>
                  <h2>{item.name}</h2>
                </div>
                <span className="match-score" aria-label={`${Math.round(item.score)} percent match`}>
                  <strong>{Math.round(item.score)}%</strong><small>{item.label}</small>
                </span>
              </div>
              {item.description && <p className="recommendation-description">{item.description}</p>}
              <p className="recommendation-meta">{item.memberCount} {item.memberCount === 1 ? "member" : "members"} · {item.mode?.toLowerCase() || "study mode not specified"}</p>
              <div className="recommendation-reasons">
                <strong>Why this group?</strong>
                {item.reasons?.length
                  ? <ul>{item.reasons.slice(0, 3).map((reason, index) => <li key={`${reason.type}-${index}`}>{reasonText(reason)}</li>)}</ul>
                  : <p>{item.confidenceNote || "This group matches your learning profile."}</p>}
              </div>
              {item.warnings?.length > 0 && (
                <p className="recommendation-caveat">{item.warnings.map(reasonText).filter(Boolean).join(" ")}</p>
              )}
              <div className="recommendation-actions">
                <button className="button button-primary" type="button" disabled={itemBusy} onClick={() => joinGroup(item)}>
                  {itemBusy ? "Sending…" : "Join group"}
                </button>
                <button className="recommendation-dismiss" type="button" disabled={itemBusy} onClick={() => dismiss(item)}>Not for me</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
