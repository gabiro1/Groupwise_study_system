"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const TAB_MAP = {
  overview: "Overview",
  messages: "Discussions",
  discussions: "Discussions",
  sessions: "Study Sessions",
  tasks: "Tasks",
  plans: "Tasks",
  resources: "Resources",
  notes: "Shared Notes",
  progress: "Progress",
  ai: "AI Assistant",
  settings: "Settings",
};

function normalizeTab(value) {
  if (!value) return "Overview";
  const decoded = String(value).replaceAll("+", " ");
  return TAB_MAP[decoded.toLowerCase()] || decoded;
}

async function resolveGroup(legacyId) {
  const direct = await fetch(`/api/study-groups/${legacyId}`, { cache: "no-store" });
  if (direct.ok) {
    const result = await direct.json();
    if (result.data?.group?.id) return result.data.group.id;
  }

  // Historical dashboard payloads sometimes carried the old container id on a
  // group row. It is only read during this compatibility redirect and is never
  // passed into the current group UI.
  const mine = await fetch("/api/study-groups/mine", { cache: "no-store" });
  if (!mine.ok) return null;
  const result = await mine.json();
  const match = (result.data?.groups || []).find((group) => (
    group.id === legacyId
    || group.workspaceId === legacyId
    || group.workspace_id === legacyId
  ));
  return match?.id || null;
}

export function WorkspaceCompatibility({ legacyId, tab }) {
  const router = useRouter();
  const [state, setState] = useState({ loading: true, error: "" });

  useEffect(() => {
    let active = true;
    resolveGroup(legacyId)
      .then((groupId) => {
        if (!active) return;
        if (!groupId) {
          setState({ loading: false, error: "This old link could not be matched to a study group." });
          return;
        }
        const nextTab = normalizeTab(tab);
        router.replace(`/dashboard/groups/${groupId}?tab=${encodeURIComponent(nextTab)}`);
      })
      .catch((error) => {
        if (active) setState({ loading: false, error: error.message || "This old link could not be matched to a study group." });
      });
    return () => { active = false; };
  }, [legacyId, router, tab]);

  return (
    <main className="section-page compatibility-page">
      {state.loading ? <p role="status">Opening your study group...</p> : <>
        <h1>Study group link unavailable</h1>
        <p role="alert">{state.error}</p>
        <Link className="button button-primary" href="/dashboard/groups">Open My Groups</Link>
      </>}
    </main>
  );
}

export function GroupCompatibility({ groupId }) {
  const router = useRouter();
  const [state, setState] = useState({ loading: true, error: "" });

  useEffect(() => {
    let active = true;
    resolveGroup(groupId)
      .then((resolvedId) => {
        if (!active) return;
        if (!resolvedId) {
          setState({ loading: false, error: "That study group could not be found." });
          return;
        }
        router.replace(`/dashboard/groups/${resolvedId}`);
      })
      .catch((error) => {
        if (active) setState({ loading: false, error: error.message || "That study group could not be found." });
      });
    return () => { active = false; };
  }, [groupId, router]);

  return (
    <main className="section-page compatibility-page">
      {state.loading ? <p role="status">Opening your study group...</p> : <>
        <h1>Study group link unavailable</h1>
        <p role="alert">{state.error}</p>
        <Link className="button button-primary" href="/dashboard/groups">Open My Groups</Link>
      </>}
    </main>
  );
}
