"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const SECTION_TABS = {
  members: "Members",
  sessions: "Study Sessions",
  resources: "Resources",
};

async function loadLeaderGroups() {
  const response = await fetch("/api/study-groups/leader/overview", { cache: "no-store" });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error?.message || "We could not open your group controls.");
  return result.data?.groups || [];
}

export default function LeaderCompatibility({ section = "overview", requestedGroupId = "" }) {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadLeaderGroups()
      .then((groups) => {
        if (!active) return;
        if (!groups.length) {
          router.replace("/dashboard/groups");
          return;
        }
        const selected = groups.find((group) => group.id === requestedGroupId) || groups[0];
        const tab = SECTION_TABS[section] || "Settings";
        router.replace(`/dashboard/groups/${selected.id}?tab=${encodeURIComponent(tab)}`);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => { active = false; };
  }, [requestedGroupId, router, section]);

  return (
    <main className="section-page compatibility-page">
      {!error ? <p role="status">Opening your group controls...</p> : <>
        <h1>Group controls unavailable</h1>
        <p role="alert">{error}</p>
        <Link className="button button-primary" href="/dashboard/groups">Open My Groups</Link>
      </>}
    </main>
  );
}
