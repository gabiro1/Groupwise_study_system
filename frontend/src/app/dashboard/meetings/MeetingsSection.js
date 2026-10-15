"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import MeetingForm from "./MeetingForm";

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || "Could not load meetings.");
    err.status = res.status;
    throw err;
  }
  return data.data;
}

export function formatMeetingTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function StatusChip({ status }) {
  const label = { SCHEDULED: "Scheduled", LIVE: "Live now", COMPLETED: "Completed", CANCELLED: "Cancelled" }[status] || status;
  return <span className={`status-chip ${String(status).toLowerCase()}`}>{label}</span>;
}

function MeetingCard({ meeting }) {
  return (
    <article className="meeting-card">
      <div className="meeting-card-top">
        <StatusChip status={meeting.status} />
        <span className="meeting-time">{formatMeetingTime(meeting.scheduled_start)}</span>
      </div>
      <h3><Link href={`/dashboard/meetings/${meeting.id}`}>{meeting.title}</Link></h3>
      <p className="meeting-group">
        {meeting.group_name} · {meeting.expected_duration_minutes} min
        {meeting.provider === "GOOGLE_MEET" && " · Google Meet"}
      </p>
      <Link className="button button-secondary" href={`/dashboard/meetings/${meeting.id}`}>View details</Link>
    </article>
  );
}
export default function MeetingsSection({ leadGroups }) {
  const [meetings, setMeetings] = useState([]);
  const [groups, setGroups] = useState([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [meetingData, groupData] = await Promise.all([
        api(`meetings?scope=${filter}&limit=100`),
        api("study-groups/mine").catch(() => ({ groups: [] })),
      ]);
      setMeetings(meetingData.meetings || []);
      setGroups(groupData.groups || groupData || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [filter]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount/filter change
  useEffect(() => { refresh(); }, [refresh]);

  const canSchedule = (leadGroups?.length || 0) > 0
    || groups.some((g) => ["OWNER", "MODERATOR"].includes(g.myRole || g.my_role));
  const scheduleGroups = useMemo(() => {
    const led = new Set((leadGroups || []).map((g) => g.id));
    return groups.filter((g) => led.has(g.id) || ["OWNER", "MODERATOR"].includes(g.myRole || g.my_role));
  }, [groups, leadGroups]);

  async function create(payload) {
    setFormBusy(true);
    setFormError("");
    try {
      await api("meetings", { method: "POST", body: JSON.stringify(payload) });
      setFormOpen(false);
      await refresh();
    } catch (e) { setFormError(e.message); }
    finally { setFormBusy(false); }
  }

  const live = meetings.filter((m) => m.status === "LIVE");
  const upcoming = meetings.filter((m) => m.status === "SCHEDULED");
  const past = meetings.filter((m) => m.status === "COMPLETED");
  const list = filter === "past" ? past : filter === "cancelled"
    ? meetings.filter((m) => m.status === "CANCELLED")
    : filter === "all" ? [...live, ...upcoming] : meetings;

  const filters = [["all", "All"], ["live", "Live"], ["upcoming", "Upcoming"], ["past", "Past"], ["cancelled", "Cancelled"]];

  return (
    <section className="section-page" aria-labelledby="meetings-heading">
      <div className="section-page-heading">
        <span className="section-overline">MEET FACE TO FACE</span>
        <h1 id="meetings-heading">Video meetings</h1>
        <p>Schedule Jitsi video calls for your study groups, then join from here.</p>
      </div>
      <div className="meetings-toolbar">
        <div className="meetings-filters" role="group" aria-label="Filter meetings">
          {filters.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={filter === v}
              className={`button ${filter === v ? "button-primary" : "button-secondary"}`}
              onClick={() => setFilter(v)}>{label}</button>
          ))}
        </div>
        {canSchedule && (
          <button className="button button-primary" type="button"
            aria-expanded={formOpen}
            onClick={() => { setFormError(""); setFormOpen((o) => !o); }}>
            {formOpen ? "Close" : "Schedule meeting"}
          </button>
        )}
      </div>
      {formOpen && (
        <section className="panel section-panel" aria-label="Schedule a meeting">
          <div className="section-heading"><div><span className="section-overline">NEW MEETING</span><h2>Schedule a meeting</h2></div></div>
          {(scheduleGroups.length || groups.length) ? (
            <MeetingForm groups={scheduleGroups.length ? scheduleGroups : groups} busy={formBusy} error={formError} onSubmit={create} onCancel={() => setFormOpen(false)} />
          ) : (
            <p className="empty-state">You lead no groups yet. Join or create a study group first.</p>
          )}
        </section>
      )}
      {loading && (
        <div className="meeting-skeleton" aria-label="Loading meetings">
          <div className="skeleton-tile" /><div className="skeleton-tile" /><div className="skeleton-tile" />
        </div>
      )}
      {error && <p className="workspace-create-error" role="alert">{error} <button className="text-link" type="button" onClick={refresh}>Retry</button></p>}
      {!loading && !error && meetings.length === 0 && (
        <section className="panel section-panel"><p className="empty-state">No video meetings here yet. {canSchedule ? "Schedule the first one above." : "Your group leader can schedule one."}</p></section>
      )}
      {!loading && !error && meetings.length > 0 && (
        <section className="panel section-panel" aria-label="Meetings">
          <div className="meeting-grid">{list.map((m) => <MeetingCard key={m.id} meeting={m} />)}</div>
          {filter === "all" && past.length > 0 && (
            <>
              <div className="section-heading"><div><span className="section-overline">HISTORY</span><h2>Recently completed</h2></div></div>
              <div className="meeting-grid">{past.slice(0, 6).map((m) => <MeetingCard key={m.id} meeting={m} />)}</div>
            </>
          )}
        </section>
      )}
    </section>
  );
}
