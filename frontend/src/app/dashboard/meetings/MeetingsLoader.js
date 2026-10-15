"use client";

import dynamic from "next/dynamic";

const MeetingsSection = dynamic(() => import("./MeetingsSection"), {
  ssr: false,
  loading: () => (
    <section className="section-page" aria-label="Loading meetings">
      <div className="meeting-skeleton"><div className="skeleton-tile" /><div className="skeleton-tile" /><div className="skeleton-tile" /></div>
    </section>
  ),
});

const MeetingDetail = dynamic(() => import("./MeetingDetail"), {
  ssr: false,
  loading: () => (
    <section className="section-page" aria-label="Loading meeting">
      <div className="meeting-skeleton"><div className="skeleton-tile" /><div className="skeleton-tile" /></div>
    </section>
  ),
});

/**
 * Lazy entry for the meetings area. The Jitsi IFrame API script loads only
 * inside the live room (see jitsiLoader.js) — the dashboard bundle never
 * contains video SDK code, so a provider outage cannot break navigation.
 *
 * `groups` may arrive either as the caller's own groups array or as the
 * dashboard's `{ mine, discovered }` bundle; normalise before filtering so a
 * shape mismatch can never crash the section.
 */
export default function MeetingsLoader({ section, meetingId, groups }) {
  if (section === "meetingDetail" && meetingId) return <MeetingDetail meetingId={meetingId} />;
  const mine = Array.isArray(groups) ? groups : (groups?.mine ?? []);
  const leadGroups = (Array.isArray(mine) ? mine : []).filter(
    (g) => ["OWNER", "MODERATOR"].includes(g?.myRole || g?.my_role),
  );
  return <MeetingsSection leadGroups={leadGroups} />;
}
