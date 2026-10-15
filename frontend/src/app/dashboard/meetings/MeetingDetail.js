"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MeetingForm from "./MeetingForm";
import { formatMeetingTime, StatusChip } from "./MeetingsSection";
import JitsiRoom from "./JitsiRoom";
import GoogleMeetRoom from "./GoogleMeetRoom";

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || "Could not load this meeting.");
    err.status = res.status;
    throw err;
  }
  return data.data;
}

export default function MeetingDetail({ meetingId }) {
  const [detail, setDetail] = useState(null);
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [joinConfig, setJoinConfig] = useState(null);
  const [joined, setJoined] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api(`meetings/${meetingId}`);
      setDetail(data);
      if (data.isModerator) {
        try {
          const att = await api(`meetings/${meetingId}/attendance`);
          setAttendance(att.attendance || []);
        } catch { setAttendance([]); }
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [meetingId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount/filter change
  useEffect(() => { refresh(); }, [refresh]);

  async function run(label, fn) {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      setNotice(label);
    } catch (e) { setActionError(e.message); }
    finally { setBusy(false); }
  }

  async function saveEdit(payload) {
    setBusy(true);
    setActionError("");
    try {
      const data = await api(`meetings/${meetingId}`, { method: "PATCH", body: JSON.stringify(payload) });
      setDetail(data);
      setEditing(false);
      setNotice("Meeting updated.");
    } catch (e) { setActionError(e.message); }
    finally { setBusy(false); }
  }

  async function join() {
    setBusy(true);
    setActionError("");
    try {
      const data = await api(`meetings/${meetingId}/join`, { method: "POST", body: "{}" });
      setDetail((d) => ({ ...d, meeting: data.meeting, joinable: true }));
      setJoinConfig(data.joinConfig);
    } catch (e) { setActionError(e.message); }
    finally { setBusy(false); }
  }
  // Only show the full-page skeleton on the very first load. Once we have data,
  // refreshes (e.g. the one fired when a call connects) update in place so the
  // live video room is never unmounted and disposed mid-call.
  if (loading && !detail) {
    return (
      <section className="section-page" aria-label="Loading meeting">
        <div className="meeting-skeleton"><div className="skeleton-tile" /><div className="skeleton-tile" /></div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="section-page">
        <div className="section-page-heading">
          <span className="section-overline">VIDEO MEETING</span>
          <h1>Meeting unavailable</h1>
          <p role="alert">{error}</p>
        </div>
        <div className="workspace-create-actions">
          <button className="button button-secondary" type="button" onClick={refresh}>Retry</button>
          <Link className="button button-primary" href="/dashboard/meetings">Back to meetings</Link>
        </div>
      </section>
    );
  }
  const { meeting, isModerator, joinable } = detail;
  const organizer = [meeting.organizer_first_name, meeting.organizer_last_name].filter(Boolean).join(" ") || "Group leader";
  const showJoin = joinable && meeting.status !== "CANCELLED" && meeting.status !== "COMPLETED" && !joinConfig;
  return (
    <section className="section-page" aria-labelledby="meeting-title">
      <p><Link className="text-link" href="/dashboard/meetings">Back to meetings</Link></p>
      <div className="section-page-heading">
        <span className="section-overline">VIDEO MEETING · {meeting.group_name}</span>
        <h1 id="meeting-title">{meeting.title}</h1>
        <p>{meeting.description || "No description yet."}</p>
      </div>
      <section className="panel section-panel" aria-label="Meeting details">
        <div className="meeting-meta">
          <StatusChip status={meeting.status} />
          <span>{formatMeetingTime(meeting.scheduled_start)} · {meeting.expected_duration_minutes} min</span>
        </div>
        <dl className="meeting-facts">
          <div><dt>Group</dt><dd>{meeting.group_name}</dd></div>
          <div><dt>Organizer</dt><dd>{organizer}</dd></div>
          <div><dt>Your role</dt><dd>{detail.myRole?.toLowerCase()}</dd></div>
        </dl>
        {notice && <p className="feature-success" role="status">{notice}</p>}
        {actionError && <p className="workspace-create-error" role="alert">{actionError}</p>}
        <div className="workspace-create-actions">
          {showJoin && (
            <button className="button button-primary" type="button" disabled={busy} onClick={join}>
              {busy ? "Joining…" : meeting.status === "LIVE" ? "Join live meeting" : "Join meeting"}
            </button>
          )}
          {!joinable && meeting.status === "SCHEDULED" && (
            <p className="meeting-hint">Joining opens 15 minutes before the start time.</p>
          )}
          {isModerator && meeting.status === "SCHEDULED" && (
            <button className="button button-secondary" type="button" disabled={busy}
              onClick={() => run("Meeting is live.", () => api(`meetings/${meetingId}/start`, { method: "POST", body: "{}" }))}>
              Start now
            </button>
          )}
          {isModerator && meeting.status === "LIVE" && (
            <button className="button button-secondary" type="button" disabled={busy}
              onClick={() => run("Meeting completed.", () => api(`meetings/${meetingId}/complete`, { method: "POST", body: "{}" }))}>
              End meeting
            </button>
          )}
          {isModerator && (meeting.status === "SCHEDULED" || meeting.status === "LIVE") && (
            <>
              <button className="button button-secondary" type="button" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                {editing ? "Close editor" : "Edit"}
              </button>
              <button className="button button-secondary" type="button" disabled={busy}
                onClick={() => { if (window.confirm("Cancel this meeting? Members will be notified.")) run("Meeting cancelled.", () => api(`meetings/${meetingId}/cancel`, { method: "POST", body: "{}" })); }}>
                Cancel meeting
              </button>
            </>
          )}
        </div>
        {editing && isModerator && (
          <MeetingForm initial={meeting} groups={[{ id: meeting.group_id, name: meeting.group_name }]} busy={busy} error={actionError} onSubmit={saveEdit} onCancel={() => setEditing(false)} />
        )}
      </section>
      {joinConfig && (
        <section className="panel section-panel" aria-label="Live video room">
          <div className="section-heading">
            <div>
              <span className="section-overline">{joinConfig.provider === "GOOGLE_MEET" ? "GOOGLE MEET" : "LIVE ROOM"}</span>
              <h2>{meeting.title}</h2>
            </div>
          </div>
          {joinConfig.provider === "GOOGLE_MEET" ? (
            <GoogleMeetRoom joinConfig={joinConfig} meeting={meeting}
              onJoined={() => { setJoined(true); refresh(); }}
              onLeft={() => { setJoined(false); setJoinConfig(null); refresh(); }} />
          ) : (
            <>
              {joinConfig.publicServiceWarning && (
                <p className="meeting-hint" role="note">Using the public Jitsi test service — fine for trying out, not for production.</p>
              )}
              <JitsiRoom joinConfig={joinConfig} meeting={meeting}
                onJoined={() => { setJoined(true); refresh(); }}
                onLeft={() => { setJoined(false); setJoinConfig(null); refresh(); }} />
            </>
          )}
          {joined && <p className="feature-success" role="status">You are in the call. Your attendance is being recorded.</p>}
        </section>
      )}
      {isModerator && (
        <section className="panel section-panel" aria-label="Attendance">
          <div className="section-heading"><div><span className="section-overline">ATTENDANCE</span><h2>Who joined</h2></div></div>
          {attendance.length === 0 ? (
            <p className="empty-state">No verified joins yet. Only confirmed meeting events are recorded.</p>
          ) : (
            <ul className="attendance-list">
              {attendance.map((a) => (
                <li key={a.id}>
                  <strong>{[a.first_name, a.last_name].filter(Boolean).join(" ") || a.email}</strong>
                  <span> joined {formatMeetingTime(a.joined_at)}</span>
                  {a.left_at && <span> · left {formatMeetingTime(a.left_at)}</span>}
                  {a.duration_seconds != null && <span> · {Math.round(a.duration_seconds / 60)} min</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
