"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AiMatchSearch from "./AiMatchSearch";

async function apiRequest(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t load recommendations.");
  return result.data;
}

function recommendationReason(item) {
  return item.detail || item.description || item.type?.replaceAll("_", " ").toLowerCase();
}

const KINDS = [
  { value: "GROUP", label: "Study groups" },
  { value: "STUDENT", label: "Study partners" },
];

export default function StudentRecommendations({ onJoin, compact = false }) {
  const [kind, setKind] = useState("GROUP");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [requestedIds, setRequestedIds] = useState([]);
  const visibleResults = compact ? results.slice(0, 3) : results;

  useEffect(() => {
    let active = true;
    apiRequest("recommendations", {
        method: "POST",
        body: JSON.stringify({
          kind,
          topicIds: [],
          availability: [],
          limit: 20,
          track: true,
          source: "DASHBOARD",
        }),
      })
      .then((data) => {
        if (!active) return;
        setResults(data.results || []);
        setError("");
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [kind]);

  function loadRecommendations() {
    setLoading(true);
    setError("");
    apiRequest("recommendations", {
      method: "POST",
      body: JSON.stringify({
        kind,
        topicIds: [],
        availability: [],
        limit: 20,
        track: true,
        source: "DASHBOARD",
      }),
    })
      .then((data) => setResults(data.results || []))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }

  async function recordOutcome(recommendation, action, reason) {
    if (!recommendation.recommendationId) {
      throw new Error("This recommendation can’t be updated yet. Refresh and try again.");
    }
    await apiRequest(`recommendations/${recommendation.recommendationId}/outcome`, {
      method: "PATCH",
      body: JSON.stringify({ action, reason }),
    });
  }

  async function joinRecommendation(recommendation) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await recordOutcome(recommendation, "ACCEPTED");
      const result = await onJoin({
        id: recommendation.groupId,
        name: recommendation.name,
        workspaceId: recommendation.workspaceId,
      });
      if (result?.status === "JOINED" || result?.status === "REQUESTED") {
        setResults((current) => current.filter((item) => item.recommendationId !== recommendation.recommendationId));
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function sendPartnerRequest(recommendation) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await recordOutcome(recommendation, "CLICKED");
      await apiRequest("partners/invitations", {
        method: "POST",
        body: JSON.stringify({ recipientId: recommendation.studentId }),
      });
      setRequestedIds((current) => [...current, recommendation.studentId]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function dismissRecommendation(recommendation) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await recordOutcome(recommendation, "REJECTED", "NOT_INTERESTED");
      setResults((current) => current.filter((item) => item.recommendationId !== recommendation.recommendationId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function sendFeedback(recommendation, helpful) {
    setBusyId(recommendation.recommendationId);
    setError("");
    try {
      await apiRequest("recommendations/feedback", {
        method: "POST",
        body: JSON.stringify({ recommendationId: recommendation.recommendationId, helpful }),
      });
      setResults((current) => current.map((item) => item.recommendationId === recommendation.recommendationId
        ? { ...item, feedbackSent: true }
        : item));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  const switchKind = useCallback((next) => {
    if (next === kind) return;
    setKind(next);
    setResults([]);
    setError("");
  }, [kind]);

  return (
    <section className={compact ? "dashboard-recommendations" : "section-page"}>
      <div className={`section-page-heading recommendation-heading${compact ? " dashboard-recommendations-heading" : ""}`}>
        <span className="section-overline">MATCHES FOR YOUR LEARNING GOALS</span>
        {compact ? <h2>Recommended study groups for you</h2> : <h1>Recommended for you</h1>}
        <p>Suggestions use the courses, topics, study preferences, and availability in your profile.</p>
      </div>
      {!compact && <AiMatchSearch key={kind} kind={kind} onJoin={onJoin} />}
      {!compact && (
        <div className="recommendation-tabs" role="tablist" aria-label="Recommendation type">
          {KINDS.map((entry) => (
            <button
              type="button"
              role="tab"
              aria-selected={kind === entry.value}
              className={kind === entry.value ? "active" : ""}
              key={entry.value}
              onClick={() => switchKind(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      <div className={`recommendation-toolbar${compact ? " dashboard-recommendation-toolbar" : ""}`}>
        <p>{results.length ? `${results.length} suggestions based on your profile` : "Your profile helps us find a better fit."}</p>
        <button className="button button-secondary" type="button" onClick={loadRecommendations} disabled={loading}>
          {loading ? "Updating…" : "Refresh matches"}
        </button>
      </div>
      {error && <div className="feature-error" role="alert">{error}</div>}
      {error && <p className="recommendation-profile-cta"><Link href="/dashboard/profile">Update your study profile</Link> to help us find relevant matches.</p>}
      {loading && <p className="empty-state" role="status">{kind === "GROUP" ? "Finding groups that fit your learning goals…" : "Finding students who complement your learning…"}</p>}
      {!loading && !error && results.length === 0 && (
        <div className="panel recommendation-empty">
          <h2>No {kind === "GROUP" ? "recommendations" : "partner matches"} yet</h2>
          <p>Add courses, learning goals, or topic ratings to your profile. If your profile is already up to date, check back as students join Lien.</p>
          <Link className="button button-primary" href="/dashboard/profile">Improve my profile</Link>
        </div>
      )}
      <div className={`recommendation-list${compact ? " dashboard-recommendation-list" : ""}`}>
        {visibleResults.map((item) => {
          const busy = busyId === item.recommendationId;
          if (kind === "STUDENT") {
            const requested = requestedIds.includes(item.studentId);
            return (
              <article className={`panel recommendation-card${compact ? " dashboard-recommendation-card" : ""}`} key={item.recommendationId || item.studentId}>
                <div className="recommendation-card-top">
                  <div>
                    <span className="section-overline">{item.yearOfStudy ? `${item.yearOfStudy}${["st", "nd", "rd", "th"][Math.min(item.yearOfStudy - 1, 3)]} year · ` : ""}{item.sharedCourses} shared {item.sharedCourses === 1 ? "course" : "courses"}</span>
                    <h2>{[item.firstName, item.lastName].filter(Boolean).join(" ") || "A study partner"}</h2>
                  </div>
                  <span className="match-score" aria-label={`${Math.round(item.score)} percent match`}>
                    <strong>{Math.round(item.score)}%</strong><small>{item.label}</small>
                  </span>
                </div>
                <div className="recommendation-reasons">
                  <strong>Why this partner?</strong>
                  {item.reasons?.length
                    ? <ul>{item.reasons.slice(0, 3).map((reason, index) => <li key={`${reason.type}-${index}`}>{recommendationReason(reason)}</li>)}</ul>
                    : <p>{item.confidenceNote || "This student matches your learning profile."}</p>}
                </div>
                {item.warnings?.length > 0 && (
                  <p className="recommendation-caveat">{item.warnings.map(recommendationReason).filter(Boolean).join(" ")}</p>
                )}
                <div className="recommendation-actions">
                  <button className="button button-primary" type="button" disabled={busy || requested} onClick={() => sendPartnerRequest(item)}>
                    {busy ? "Sending…" : requested ? "Request sent" : "Send partner request"}
                  </button>
                  <button className="recommendation-dismiss" type="button" disabled={busy || requested} onClick={() => dismissRecommendation(item)}>Not for me</button>
                </div>
                {requested && <p className="recommendation-thanks" role="status">Request sent. They can accept it on their Study partners page.</p>}
              </article>
            );
          }
          return (
            <article className={`panel recommendation-card${compact ? " dashboard-recommendation-card" : ""}`} key={item.recommendationId || item.groupId}>
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
                  ? <ul>{item.reasons.slice(0, 3).map((reason, index) => <li key={`${reason.type}-${index}`}>{recommendationReason(reason)}</li>)}</ul>
                  : <p>{item.confidenceNote || "This group matches your learning profile."}</p>}
              </div>
              {item.warnings?.length > 0 && (
                <p className="recommendation-caveat">{item.warnings.map(recommendationReason).filter(Boolean).join(" ")}</p>
              )}
              <div className="recommendation-actions">
                <button className="button button-primary" type="button" disabled={busy} onClick={() => joinRecommendation(item)}>
                  {busy ? "Sending…" : "Join group"}
                </button>
                <button className="recommendation-dismiss" type="button" disabled={busy} onClick={() => dismissRecommendation(item)}>Not for me</button>
              </div>
              {!compact && !item.feedbackSent && (
                <div className="recommendation-feedback">
                  <span>Is this suggestion useful?</span>
                  <button type="button" disabled={busy} onClick={() => sendFeedback(item, true)}>Yes</button>
                  <button type="button" disabled={busy} onClick={() => sendFeedback(item, false)}>Not really</button>
                </div>
              )}
              {!compact && item.feedbackSent && <p className="recommendation-thanks" role="status">Thanks — your feedback helps improve future matches.</p>}
            </article>
          );
        })}
      </div>
      {compact && results.length > visibleResults.length && (
        <Link className="all-recommendations" href="/dashboard/recommendations">See all recommendations <span aria-hidden="true">↗</span></Link>
      )}
    </section>
  );
}