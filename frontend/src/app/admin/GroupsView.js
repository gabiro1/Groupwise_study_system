"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest, formatDate, formatDateTime, labelFor } from "./adminApi";
import PageHeading from "./PageHeading";
import AdminModal from "./AdminModal";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const PAGE_SIZE = 30;

export default function GroupsView() {
  const searchParams = useSearchParams();
  const [groups, setGroups] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [detailTarget, setDetailTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [busyRequest, setBusyRequest] = useState("");

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

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
        const result = await apiRequest(`admin/groups?${buildQuery(nextCursor)}`);
        setGroups((current) => (nextCursor == null ? result.groups || [] : [...current, ...(result.groups || [])]));
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
        const result = await apiRequest(`admin/groups?${buildQuery(null)}`);
        if (active) {
          setGroups(result.groups || []);
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

  async function openGroupDetail(group, { clearMessage = true } = {}) {
    setDetailTarget(group);
    setDetail(null);
    setDetailError("");
    if (clearMessage) setMessage("");
    setDetailLoading(true);
    try {
      const result = await apiRequest(`admin/groups/${group.id}`);
      setDetail(result);
    } catch (requestError) {
      setDetailError(requestError.message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function decideJoinRequest(request, decision) {
    if (!detailTarget) return;
    const actionKey = `${decision}:${request.id}`;
    setBusyRequest(actionKey);
    setDetailError("");
    setMessage("");
    try {
      await apiRequest(`admin/groups/${detailTarget.id}/requests/${request.id}/decide`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          note: decision === "APPROVE"
            ? "Admitted by an administrator from the admin console."
            : "Declined by an administrator from the admin console.",
        }),
      });
      await Promise.all([openGroupDetail(detailTarget, { clearMessage: false }), reload()]);
      setMessage(decision === "APPROVE" ? "Student admitted to the group." : "Join request declined.");
    } catch (requestError) {
      setDetailError(requestError.message);
    } finally {
      setBusyRequest("");
    }
  }

  const pendingRequests = detail?.joinRequests || [];
  const groupIsActive = detail?.group?.status === "ACTIVE";

  return (
    <>
      <PageHeading
        title="Study groups"
        subtitle="Monitor every group, its size, owner, and status."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <form className="admin-toolbar" onSubmit={applyFilters}>
          <input
            aria-label="Search groups"
            placeholder="Search by group name or course code"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="ARCHIVED">Archived</option>
            <option value="DISBANDED">Disbanded</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
          <button className="admin-btn admin-btn-primary" type="submit">Search</button>
          <button className="admin-btn admin-btn-ghost" type="button" onClick={resetFilters}>Reset</button>
        </form>

        {loading ? (
          <div className="admin-card-pad"><Skeleton rows={6} /></div>
        ) : groups.length === 0 ? (
          <div className="admin-card-pad">
            <EmptyState title="No study groups found" message="No groups match that filter." />
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Course</th>
                  <th>Owner</th>
                  <th>Members</th>
                  <th>Pending requests</th>
                  <th>Privacy</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th className="admin-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td><strong>{group.name}</strong></td>
                    <td>
                      <code className="admin-code">{group.course_code}</code>
                      <small className="admin-muted">{group.course_name}</small>
                    </td>
                    <td className="admin-muted">
                      {[group.owner_first_name, group.owner_last_name].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td>
                      {group.member_count}
                      <small className="admin-muted">/{group.max_size}</small>
                    </td>
                    <td>{group.pending_requests ?? 0}</td>
                    <td className="admin-muted">{group.privacy === "PRIVATE" ? "Private" : "Public"}</td>
                    <td>
                      <span className={`admin-badge admin-badge-${group.status.toLowerCase()}`}>
                        {labelFor("groupStatus", group.status)}
                      </span>
                    </td>
                    <td className="admin-muted">{formatDate(group.created_at)}</td>
                    <td className="admin-col-actions">
                      <button className="admin-btn admin-btn-ghost" type="button" onClick={() => openGroupDetail(group)}>
                        Review
                      </button>
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
        open={Boolean(detailTarget)}
        title={detail?.group?.name || detailTarget?.name || "Study group"}
        onClose={() => {
          setDetailTarget(null);
          setDetail(null);
          setDetailError("");
        }}
        footer={
          <button
            className="admin-btn admin-btn-ghost"
            type="button"
            onClick={() => {
              setDetailTarget(null);
              setDetail(null);
            }}
          >
            Close
          </button>
        }
      >
        {detailLoading ? (
          <Skeleton rows={5} />
        ) : detailError ? (
          <div className="admin-banner admin-banner-error" role="alert">{detailError}</div>
        ) : detail ? (
          <>
            <p>
              {detail.group.course_code} · {detail.group.member_count}/{detail.group.max_size} members · {labelFor("groupStatus", detail.group.status)}
            </p>
            <p className="admin-muted">
              Owner: {[detail.group.owner_first_name, detail.group.owner_last_name].filter(Boolean).join(" ") || detail.group.owner_email}
            </p>
            {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

            <div>
              <h3 className="admin-request-title">Pending admission requests ({pendingRequests.length})</h3>
              {pendingRequests.length === 0 ? (
                <p className="admin-muted">There are no pending requests for this group.</p>
              ) : (
                <div className="admin-admission-list">
                  {pendingRequests.map((request) => {
                    const name = [request.first_name, request.last_name].filter(Boolean).join(" ") || request.email;
                    const approving = busyRequest === `APPROVE:${request.id}`;
                    const declining = busyRequest === `REJECT:${request.id}`;
                    return (
                      <article className="admin-admission-item" key={request.id}>
                        <div className="admin-admission-copy">
                          <strong>{name}</strong>
                          <small>{request.email} · Requested {formatDateTime(request.created_at)}</small>
                          {request.message && <p>{request.message}</p>}
                        </div>
                        <div className="admin-admission-actions">
                          <button
                            className="admin-btn admin-btn-primary"
                            type="button"
                            disabled={!groupIsActive || Boolean(busyRequest)}
                            onClick={() => decideJoinRequest(request, "APPROVE")}
                            title={!groupIsActive ? "Only active groups can admit members." : undefined}
                          >
                            {approving ? "Admitting…" : "Admit"}
                          </button>
                          <button
                            className="admin-btn admin-btn-danger"
                            type="button"
                            disabled={!groupIsActive || Boolean(busyRequest)}
                            onClick={() => decideJoinRequest(request, "REJECT")}
                            title={!groupIsActive ? "Only active groups can decide requests." : undefined}
                          >
                            {declining ? "Declining…" : "Decline"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}
      </AdminModal>
    </>
  );
}
