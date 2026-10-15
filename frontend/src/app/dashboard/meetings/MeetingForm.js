"use client";

import { useState } from "react";

/**
 * Accessible schedule / edit form for video meetings.
 * Leaders only (the page hides it otherwise; the API enforces it).
 * Times are entered in the user's local zone and sent as ISO-with-offset so
 * the backend stores TIMESTAMPTZ without silently reinterpreting UTC.
 *
 * Two providers: JITSI (embedded, server-generated room) and GOOGLE_MEET
 * (leader pastes their own Meet link; members open it in a new tab).
 */

// Mirrors the backend's normalizeGoogleMeetUrl() acceptance rule.
const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i;

function toLocalInput(iso) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export default function MeetingForm({ groups, initial, busy, error, onSubmit, onCancel }) {
  const seeded = toLocalInput(initial?.scheduled_start);
  const [groupId, setGroupId] = useState(initial?.group_id || groups[0]?.id || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [date, setDate] = useState(seeded.date);
  const [time, setTime] = useState(seeded.time);
  const [duration, setDuration] = useState(String(initial?.expected_duration_minutes || 60));
  const [provider, setProvider] = useState(initial?.provider || "JITSI");
  const [joinUrl, setJoinUrl] = useState(initial?.join_url || "");
  const [fieldErrors, setFieldErrors] = useState({});

  function validate() {
    const errs = {};
    if (title.trim().length < 2) errs.title = "Give the meeting a title (2+ characters).";
    if (title.trim().length > 160) errs.title = "Keep the title under 160 characters.";
    if (description.trim().length > 2000) errs.description = "Keep the description under 2000 characters.";
    if (!groupId) errs.groupId = "Choose a study group.";
    if (!date) errs.date = "Choose a meeting date.";
    if (!time) errs.time = "Choose a start time.";
    const dur = Number(duration);
    if (!Number.isInteger(dur) || dur < 5 || dur > 480) errs.duration = "Duration must be 5–480 minutes.";
    if (provider === "GOOGLE_MEET" && !MEET_URL_RE.test(joinUrl.trim())) {
      errs.joinUrl = "Paste a Google Meet link like https://meet.google.com/abc-defg-hij.";
    }
    const when = date && time ? new Date(`${date}T${time}`) : null;
    if (when && Number.isNaN(when.getTime())) errs.date = "That date and time are not valid.";
    else if (when && !initial && when.getTime() < Date.now() - 60 * 1000) {
      errs.date = "The meeting must start in the future.";
    }
    setFieldErrors(errs);
    return { errs, when };
  }

  function submit(event) {
    event.preventDefault();
    const { errs, when } = validate();
    if (Object.keys(errs).length) return;
    onSubmit({
      groupId,
      title: title.trim(),
      description: description.trim(),
      scheduledStart: when.toISOString(),
      expectedDurationMinutes: Number(duration),
      // Provider is fixed at creation; edits may only refresh the Meet link.
      ...(initial ? {} : { provider }),
      ...(provider === "GOOGLE_MEET" ? { joinUrl: joinUrl.trim() } : {}),
    });
  }

  return (
    <form className="meeting-form" onSubmit={submit} noValidate>
      <div className="form-field">
        <label htmlFor="meeting-group">Study group</label>
        <select id="meeting-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={Boolean(initial)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        {fieldErrors.groupId && <p className="field-error" role="alert">{fieldErrors.groupId}</p>}
      </div>
      <div className="form-field">
        <label htmlFor="meeting-title">Meeting title</label>
        <input
          id="meeting-title" type="text" required minLength={2} maxLength={160}
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Calculus chapter 4 review" aria-invalid={Boolean(fieldErrors.title)}
          aria-describedby={fieldErrors.title ? "meeting-title-error" : undefined}
        />
        {fieldErrors.title && <p className="field-error" id="meeting-title-error" role="alert">{fieldErrors.title}</p>}
      </div>
      <div className="form-field">
        <label htmlFor="meeting-desc">Description <span className="optional">(optional)</span></label>
        <textarea
          id="meeting-desc" rows={3} maxLength={2000}
          value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="What will you cover?"
        />
        {fieldErrors.description && <p className="field-error" role="alert">{fieldErrors.description}</p>}
      </div>
      <div className="form-row">
        <div className="form-field">
          <label htmlFor="meeting-date">Meeting date</label>
          <input id="meeting-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          {fieldErrors.date && <p className="field-error" role="alert">{fieldErrors.date}</p>}
        </div>
        <div className="form-field">
          <label htmlFor="meeting-time">Start time</label>
          <input id="meeting-time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
          {fieldErrors.time && <p className="field-error" role="alert">{fieldErrors.time}</p>}
        </div>
        <div className="form-field">
          <label htmlFor="meeting-duration">Duration (minutes)</label>
          <input
            id="meeting-duration" type="number" required min={5} max={480} step={5}
            value={duration} onChange={(e) => setDuration(e.target.value)}
          />
          {fieldErrors.duration && <p className="field-error" role="alert">{fieldErrors.duration}</p>}
        </div>
      </div>
      <div className="form-field">
        <label htmlFor="meeting-provider">Video provider</label>
        <select
          id="meeting-provider" value={provider}
          onChange={(e) => setProvider(e.target.value)} disabled={Boolean(initial)}
          aria-describedby="meeting-provider-hint"
        >
          <option value="JITSI">Jitsi (built-in room)</option>
          <option value="GOOGLE_MEET">Google Meet (my link)</option>
        </select>
        <p className="meeting-hint" id="meeting-provider-hint">
          {provider === "GOOGLE_MEET"
            ? "Members open your link in a new tab — Google handles sign-in and devices."
            : "A private room is created automatically inside TWIGANE."}
        </p>
      </div>
      {provider === "GOOGLE_MEET" && (
        <div className="form-field">
          <label htmlFor="meeting-join-url">Google Meet link</label>
          <input
            id="meeting-join-url" type="url" required maxLength={300}
            value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)}
            placeholder="https://meet.google.com/abc-defg-hij"
            aria-invalid={Boolean(fieldErrors.joinUrl)}
            aria-describedby={fieldErrors.joinUrl ? "meeting-join-url-error" : "meeting-join-url-hint"}
          />
          {fieldErrors.joinUrl
            ? <p className="field-error" id="meeting-join-url-error" role="alert">{fieldErrors.joinUrl}</p>
            : <p className="meeting-hint" id="meeting-join-url-hint">Create one at meet.google.com or in Google Calendar, then paste it here.</p>}
        </div>
      )}
      <p className="meeting-hint">Times use your device time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
      {error && <p className="workspace-create-error" role="alert">{error}</p>}
      <div className="workspace-create-actions">
        {onCancel && <button className="button button-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="button button-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Schedule meeting"}
        </button>
      </div>
    </form>
  );
}
