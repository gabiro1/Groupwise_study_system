"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest, formatDate, formatDateTime, labelFor } from "../adminApi";
import PageHeading from "../PageHeading";
import AdminModal from "../AdminModal";
import { EmptyState, Skeleton } from "../DataState";

const PAGE_SIZE = 30;

function SessionsContent() {
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

  const [busySession, setBusySession] = useState("");
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelReason, setCancelReason] = useState("");

  const buildQuery = useCallback(
    (nextCursor) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      if (nextCursor != null) params.set("cursor", String(nextCursor));
      return params.toString();
    },
    [q, status],
  );

  const load = useCallback(
    async (nextCursor = null) => {
      if (nextCursor != null) setLoadingMore(true);
      try {
        const result = await apiRequest(`admin/sessions?${buildQuery(nextCursor)}`);
        setSessions((current) => (nextCursor == null ? result.sessions || [] : [...current, ...(result.sessions || [])]));
        setCursor(result.cursor);
        setError("");
      } catch (requestError) {
        setError(requestError.message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [buildQuery],
  );

  const reload = useCallback(() => {
    setLoading(true);
    return load(null);
  }, [load]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await apiRequest(`admin/sessions?${buildQuery(null)}`);
        if (active) {
          setSessions(result.sessions || []);
          setCursor(result.cursor);
          setError("");
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // Load the URL filters once; subsequent searches are explicit form actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(event) {
    event.preventDefault();
    reload();
  }

  function resetFilters() {
    setQ("");
    setStatus("");
    setTimeout(() => reload(), 0);
  }

  async function cancelSession(session) {
    const reason = cancelReason.trim();
    if (reason.length < 5) {
      setError("Give a reason of at least 5 characters for the audit trail.");
      return;
    }
    setBusySession(`cancel:${session.id}`);
    setError("");
    try {
      await apiRequest(`admin/sessions/${session.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setMessage(`Session "${session.title}" was cancelled.`);
      setCancelTarget(null);
      setCancelReason("");
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusySession("");
    }
  }

  const STATUS_OPTIONS = [
    { value: "", label: "All statuses" },
    { value: "SCHEDULED", label: "Scheduled" },
    { value: "ACTIVE", label: "Active" },
    { value: "PAUSED", label: "Paused" },
    { value: "COMPLETED", label: "Completed" },
    { value: "CANCELLED", label: "Cancelled" },
  ];

  return (
    <>
      <PageHeading
        title="Study Sessions"
        subtitle="Monitor all study sessions across the platform."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <form className="admin-toolbar" onSubmit={applyFilters}>
          <input
            aria-label="Search sessions"
            placeholder="Search by session title or group name"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button className="admin-btn admin-btn-primary" type="submit">Search</button>
          <button className="admin-btn admin-btn-ghost" type="button" onClick={resetFilters}>Reset</button>
        </form>

        {loading ? (
          <div className="admin-card-pad"><Skeleton rows={6} /></div>
        ) : sessions.length === 0 ? (
          <div className="admin-card-pad">
            <EmptyState title="No study sessions found" message="No sessions match that filter." />
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Group</th>
                  <th>Course</th>
                  <th>Status</th>
                  <th>Starts</th>
                  <th>Participants</th>
                  <th className="admin-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <strong>{session.title}</strong>
                      <small className="admin-muted">{session.mode}</small>
                    </td>
                    <td className="admin-muted">{session.group_name}</td>
                    <td className="admin-muted admin-code">{session.course_code || "—"}</td>
                    <td>
                      <span className={`admin-badge admin-badge-${session.status.toLowerCase()}`}>
                        {labelFor("groupStatus", session.status) || session.status}
                      </span>
                    </td>
                    <td className="admin-muted">{formatDateTime(session.starts_at)}</td>
                    <td>
                      {session.attended ?? 0} / {session.participants ?? 0}
                    </td>
                    <td className="admin-col-actions">
                      {session.status !== "CANCELLED" && session.status !== "COMPLETED" && (
                        <button
                          className="admin-btn admin-btn-danger admin-btn-sm"
                          type="button"
                          disabled={busySession === `cancel:${session.id}`}
                          onClick={() => {
                            setCancelTarget(session);
                            setCancelReason("");
                          }}
                        >
                          {busySession === `cancel:${session.id}` ? "…" : "Cancel"}
                        </button>
                      )}
                      {session.status === "CANCELLED" && (
                        <span className="admin-muted admin-badge-small">Cancelled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cursor != null && !loading && (
          <div className="admin-card-foot">
            <button className="admin-btn admin-btn-ghost" type="button" disabled={loadingMore} onClick={() => load(cursor)}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>

      <AdminModal
        open={Boolean(cancelTarget)}
        title="Cancel session"
        onClose={() => setCancelTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setCancelTarget(null)}>
              Cancel
            </button>
            <button
              className="admin-btn admin-btn-danger"
              type="button"
              disabled={busySession.startsWith("cancel:") || cancelReason.trim().length < 5}
              onClick={() => cancelSession(cancelTarget)}
            >
              {busySession.startsWith("cancel:") ? "Cancelling…" : "Cancel session"}
            </button>
          </>
        }
      >
        {cancelTarget && (
          <>
            <p>
              Cancelling <strong>{cancelTarget.title}</strong> will notify all participants and the group owner.
            </p>
            <label className="admin-field">
              <span>Reason (recorded in the audit log)</span>
              <textarea
                rows={3}
                maxLength={500}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Explain why this session is being cancelled."
              />
            </label>
          </>
        )}
      </AdminModal>
    </>
  );
}

export default function SessionsView() {
  return (
    <Suspense fallback={<Skeleton rows={6} />}>
      <SessionsContent />
    </Suspense>
  );
}
