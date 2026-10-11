"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t load your study space.");
  return result.data;
}

const summaryCards = [
  { key: "activeGroups", label: "Active groups", href: "/dashboard/groups", hint: "learning together" },
  { key: "pendingGroupInvitations", label: "Group invitations", href: "/dashboard/groups", hint: "waiting on you" },
  { key: "pendingGroupRequests", label: "Join requests", href: "/dashboard/groups", hint: "sent, awaiting approval" },
  { key: "pendingPartnerInvitations", label: "Partner requests", href: "/dashboard/partners", hint: "waiting on you" },
  { key: "upcomingSessions", label: "Upcoming sessions", href: "/dashboard/sessions", hint: "on your calendar" },
  { key: "unreadDirectMessages", label: "Unread messages", href: "/dashboard/messages", hint: "from study partners" },
];

export default function StudentSummary() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    apiRequest("students/me/summary")
      .then((data) => {
        if (active) {
          setSummary(data.summary || {});
          setError("");
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <section className="summary-strip" aria-label="Your study overview at a glance">
      {summaryCards.map((card) => {
        const value = summary ? Number(summary[card.key] ?? 0) : 0;
        const hasCount = value > 0;
        return (
          <Link className={`summary-card${hasCount ? " has-count" : ""}`} href={card.href} key={card.key}>
            <span className="summary-value">{loading ? "…" : value}</span>
            <span className="summary-label">{card.label}</span>
            <span className="summary-hint">{card.hint}</span>
          </Link>
        );
      })}
      {error && <p className="empty-state summary-error" role="alert">{error}</p>}
    </section>
  );
}