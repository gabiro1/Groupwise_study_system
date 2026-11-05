"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, formatDateTime, labelFor } from "../adminApi";
import PageHeading from "../PageHeading";
import AdminModal from "../AdminModal";
import { EmptyState, Skeleton } from "../DataState";

const PAGE_SIZE = 25;

const CATEGORIES = [
  { key: "GENERAL", label: "General" },
  { key: "ACADEMIC", label: "Academic" },
  { key: "MAINTENANCE", label: "Maintenance" },
  { key: "SECURITY", label: "Security" },
  { key: "PLATFORM_UPDATE", label: "Platform Update" },
];

const AUDIENCES = [
  { key: "ALL", label: "All users" },
  { key: "STUDENTS", label: "Students" },
  { key: "GROUP_LEADERS", label: "Group Leaders" },
  { key: "ADMINS", label: "Administrators" },
];

const STATUSES = [
  { key: "DRAFT", label: "Draft" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "PUBLISHED", label: "Published" },
  { key: "ARCHIVED", label: "Archived" },
];

const EDITABLE_STATUSES = STATUSES.filter((item) => ["DRAFT", "SCHEDULED"].includes(item.key));

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildAnnouncementPayload(values) {
  if (!EDITABLE_STATUSES.some((item) => item.key === values.status)) {
    throw new Error("Announcements can only be created or updated as drafts or scheduled items.");
  }

  if (values.status !== "SCHEDULED") return { ...values, scheduledFor: null };

  const scheduledFor = new Date(values.scheduledFor);
  if (!values.scheduledFor || Number.isNaN(scheduledFor.getTime())) {
    throw new Error("Choose a valid publication time for scheduled announcements.");
  }
  if (scheduledFor.getTime() <= Date.now()) {
    throw new Error("Pick a publication time in the future.");
  }

  return { ...values, scheduledFor: scheduledFor.toISOString() };
}

function canPublishAnnouncement(announcement) {
  if (announcement?.status === "DRAFT") return true;
  if (announcement?.status !== "SCHEDULED") return false;
  const scheduledFor = announcement.scheduled_for ?? announcement.scheduledFor;
  return Boolean(scheduledFor) && !Number.isNaN(new Date(scheduledFor).getTime());
}

export default function AnnouncementsView() {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");

  const [busyId, setBusyId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [editOpen, setEditOpen] = useState(false);

  const [form, setForm] = useState({
    title: "",
    body: "",
    category: "GENERAL",
    audience: "ALL",
    status: "DRAFT",
    scheduledFor: "",
  });

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      if (category) params.set("category", category);
      const result = await apiRequest(`admin/announcements?${params.toString()}`);
      setAnnouncements(result.announcements || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [status, category]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function reload() {
    setLoading(true);
    load();
  }

  function applyFilters(event) {
    event.preventDefault();
    reload();
  }

  function resetFilters() {
    setStatus("");
    setCategory("");
    setTimeout(reload, 0);
  }

  function openCreate() {
    setForm({ title: "", body: "", category: "GENERAL", audience: "ALL", status: "DRAFT", scheduledFor: "" });
    setCreateOpen(true);
  }

  async function createAnnouncement() {
    setBusyId("create");
    setError("");
    try {
      const payload = buildAnnouncementPayload(form);
      await apiRequest("admin/announcements", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setMessage("Announcement created.");
      setCreateOpen(false);
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  function openEdit(announcement) {
    if (!EDITABLE_STATUSES.some((item) => item.key === announcement.status)) {
      setError("Published or archived announcements cannot be edited.");
      return;
    }
    setEditTarget(announcement);
    setForm({
      title: announcement.title,
      body: announcement.body,
      category: announcement.category,
      audience: announcement.audience,
      status: announcement.status,
       scheduledFor: toDateTimeLocal(announcement.scheduled_for ?? announcement.scheduledFor),
    });
    setEditOpen(true);
  }

  async function saveAnnouncement() {
    if (!editTarget) return;
    setBusyId(`edit:${editTarget.id}`);
    setError("");
    try {
      if (!EDITABLE_STATUSES.some((item) => item.key === editTarget.status)) {
        throw new Error("Published or archived announcements cannot be edited.");
      }
      const payload = buildAnnouncementPayload(form);
      await apiRequest(`admin/announcements/${editTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setMessage("Announcement updated.");
      setEditOpen(false);
      setEditTarget(null);
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function publishAnnouncement(announcement) {
    if (!canPublishAnnouncement(announcement)) {
      setError("Only valid draft or scheduled announcements can be published.");
      return;
    }
    const { id } = announcement;
    setBusyId(`publish:${id}`);
    setError("");
    try {
      await apiRequest(`admin/announcements/${id}/publish`, { method: "POST", body: "{}" });
      setMessage("Announcement published.");
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function archiveAnnouncement(id) {
    setBusyId(`archive:${id}`);
    setError("");
    try {
      await apiRequest(`admin/announcements/${id}/archive`, { method: "POST", body: "{}" });
      setMessage("Announcement archived.");
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function deleteAnnouncement(id) {
    if (!window.confirm("Delete this announcement? Drafts and archived announcements can be deleted; published ones must be archived first.")) return;
    setBusyId(`delete:${id}`);
    setError("");
    try {
      await apiRequest(`admin/announcements/${id}`, { method: "DELETE" });
      setMessage("Announcement deleted.");
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <>
      <PageHeading
        title="Announcements"
        subtitle="Create, publish, and archive platform-wide announcements."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <div className="admin-toolbar">
          <form className="admin-filter-form" onSubmit={applyFilters}>
            <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <button className="admin-btn admin-btn-primary" type="submit">Apply filters</button>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={resetFilters}>Reset</button>
          </form>
          <button className="admin-btn admin-btn-primary" type="button" onClick={openCreate}>
            + Create announcement
          </button>
        </div>

        {loading ? (
          <div className="admin-card-pad"><Skeleton rows={6} /></div>
        ) : announcements.length === 0 ? (
          <div className="admin-card-pad">
            <EmptyState title="No announcements" message="Create your first announcement above." />
          </div>
        ) : (
          <div className="admin-card-body admin-card-body-flush">
            {announcements.map((announcement) => (
              <article key={announcement.id} className="admin-announcement-card">
                <div className="admin-announcement-head">
                  <div>
                    <strong>{announcement.title}</strong>
                    <div className="admin-announcement-meta">
                      <span className={`admin-badge admin-badge-${announcement.status.toLowerCase()}`}>
                        {labelFor("groupStatus", announcement.status) || announcement.status}
                      </span>
                      <span className="admin-badge admin-badge-muted">{announcement.category}</span>
                      <span className="admin-badge admin-badge-muted">{announcement.audience}</span>
                    </div>
                  </div>
                  <div className="admin-announcement-actions">
                    {canPublishAnnouncement(announcement) && (
                      <button className="admin-btn admin-btn-ghost admin-btn-sm" type="button" onClick={() => publishAnnouncement(announcement)} disabled={busyId === `publish:${announcement.id}`}>
                        Publish
                      </button>
                    )}
                    {announcement.status === "PUBLISHED" && (
                      <button className="admin-btn admin-btn-ghost admin-btn-sm" type="button" onClick={() => archiveAnnouncement(announcement.id)} disabled={busyId === `archive:${announcement.id}`}>
                        Archive
                      </button>
                    )}
                    {(announcement.status === "DRAFT" || announcement.status === "ARCHIVED") && (
                      <button className="admin-btn admin-btn-danger admin-btn-sm" type="button" onClick={() => deleteAnnouncement(announcement.id)} disabled={busyId === `delete:${announcement.id}`}>
                        Delete
                      </button>
                    )}
                    {EDITABLE_STATUSES.some((item) => item.key === announcement.status) && (
                      <button className="admin-btn admin-btn-ghost admin-btn-sm" type="button" onClick={() => openEdit(announcement)}>
                        Edit
                      </button>
                    )}
                  </div>
                </div>
                <p className="admin-announcement-body">{announcement.body}</p>
                <div className="admin-announcement-foot">
                  <span className="admin-muted">
                    {announcement.created_by_first_name || announcement.created_by_last_name
                      ? `By {[announcement.created_by_first_name, announcement.created_by_last_name].filter(Boolean).join(" ")}`
                      : "By system"}
                    {announcement.scheduled_for && ` · Scheduled ${formatDateTime(announcement.scheduled_for)}`}
                    {announcement.published_at && ` · Published ${formatDateTime(announcement.published_at)}`}
                    {announcement.delivered_count != null && ` · ${announcement.delivered_count} delivered`}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <AdminModal
        open={createOpen}
        title="Create announcement"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button className="admin-btn admin-btn-primary" type="button" disabled={busyId === "create" || !form.title.trim() || !form.body.trim()} onClick={createAnnouncement}>
              {busyId === "create" ? "Creating…" : "Create announcement"}
            </button>
          </>
        }
      >
        <label className="admin-field">
          <span>Title</span>
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={160} />
        </label>
        <label className="admin-field">
          <span>Message</span>
          <textarea rows={4} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} maxLength={4000} />
        </label>
        <label className="admin-field">
          <span>Category</span>
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="admin-field">
          <span>Audience</span>
          <select value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })}>
            {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
        <label className="admin-field">
          <span>Status</span>
          <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
            {EDITABLE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        {form.status === "SCHEDULED" && (
          <label className="admin-field">
            <span>Publish at</span>
            <input type="datetime-local" value={form.scheduledFor} onChange={(event) => setForm({ ...form, scheduledFor: event.target.value })} />
          </label>
        )}
      </AdminModal>

      <AdminModal
        open={editOpen && Boolean(editTarget)}
        title="Edit announcement"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button className="admin-btn admin-btn-primary" type="button" disabled={busyId.startsWith("edit:") || !form.title.trim() || !form.body.trim()} onClick={saveAnnouncement}>
              {busyId.startsWith("edit:") ? "Saving…" : "Save changes"}
            </button>
          </>
        }
      >
        {editTarget && (
          <>
            <label className="admin-field">
              <span>Title</span>
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={160} />
            </label>
            <label className="admin-field">
              <span>Message</span>
              <textarea rows={4} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} maxLength={4000} />
            </label>
            <label className="admin-field">
              <span>Category</span>
              <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <label className="admin-field">
              <span>Audience</span>
              <select value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })}>
                {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </label>
            <label className="admin-field">
              <span>Status</span>
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
                {EDITABLE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            {form.status === "SCHEDULED" && (
              <label className="admin-field">
                <span>Publish at</span>
                <input type="datetime-local" value={form.scheduledFor} onChange={(event) => setForm({ ...form, scheduledFor: event.target.value })} />
              </label>
            )}
          </>
        )}
      </AdminModal>
    </>
  );
}
