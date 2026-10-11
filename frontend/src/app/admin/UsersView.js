"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest, displayName, formatDateTime, labelFor } from "./adminApi";
import PageHeading from "./PageHeading";
import AdminModal from "./AdminModal";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const PAGE_SIZE = 25;

export default function UsersView() {
  const searchParams = useSearchParams();
  const [users, setUsers] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [role, setRole] = useState(searchParams.get("role") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

  const [busyUser, setBusyUser] = useState("");
  const [suspendTarget, setSuspendTarget] = useState(null);
  const [suspendReason, setSuspendReason] = useState("");

  const buildQuery = useCallback(
    (nextCursor) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (q.trim()) params.set("q", q.trim());
      if (role) params.set("role", role);
      if (status) params.set("status", status);
      if (nextCursor != null) params.set("cursor", String(nextCursor));
      return params.toString();
    },
    [q, role, status],
  );

  const load = useCallback(
    async (nextCursor = null) => {
      if (nextCursor != null) setLoadingMore(true);
      try {
        const result = await apiRequest(`admin/users?${buildQuery(nextCursor)}`);
        setUsers((current) => (nextCursor == null ? result.users || [] : [...current, ...(result.users || [])]));
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
        const result = await apiRequest(`admin/users?${buildQuery(null)}`);
        if (active) {
          setUsers(result.users || []);
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
    setRole("");
    setStatus("");
    setTimeout(() => reload(), 0);
  }

  async function confirmSuspend() {
    if (suspendReason.trim().length < 5) {
      setError("Give a reason (at least 5 characters) for the audit trail before suspending.");
      return;
    }
    const userId = suspendTarget.id;
    setBusyUser(`suspend:${userId}`);
    setError("");
    try {
      await apiRequest("admin/users/suspend", {
        method: "POST",
        body: JSON.stringify({ userId, reason: suspendReason.trim(), suspendSessions: true }),
      });
      setMessage(`${displayName(suspendTarget)} was suspended and their sessions were revoked.`);
      setSuspendTarget(null);
      setSuspendReason("");
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyUser("");
    }
  }

  async function restore(user) {
    setBusyUser(`restore:${user.id}`);
    setError("");
    try {
      await apiRequest("admin/users/restore", {
        method: "POST",
        body: JSON.stringify({ userId: user.id, reason: "Restored from the admin console." }),
      });
      setMessage(`${displayName(user)} was restored.`);
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyUser("");
    }
  }

  async function changeRole(user, nextRole) {
    setBusyUser(`role:${user.id}`);
    setError("");
    try {
      await apiRequest("admin/users/role", {
        method: "POST",
        body: JSON.stringify({ userId: user.id, role: nextRole, reason: "Changed from the admin console." }),
      });
      setMessage(`${displayName(user)} is now a ${nextRole.toLowerCase()}. Their sessions were revoked.`);
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyUser("");
    }
  }

  return (
    <>
      <PageHeading
        title="Users"
        subtitle="Search accounts, review status, and manage roles."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <form className="admin-toolbar" onSubmit={applyFilters}>
          <input
            aria-label="Search users"
            placeholder="Search by name or email"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <select aria-label="Filter by role" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">All roles</option>
            <option value="STUDENT">Student</option>
            <option value="LECTURER">Lecturer</option>
            <option value="ADMIN">Admin</option>
          </select>
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="PENDING_VERIFICATION">Pending verification</option>
            <option value="DEACTIVATED">Deactivated</option>
          </select>
          <button className="admin-btn admin-btn-primary" type="submit">Search</button>
          <button className="admin-btn admin-btn-ghost" type="button" onClick={resetFilters}>Reset</button>
        </form>

        {loading ? (
          <div className="admin-card-pad"><Skeleton rows={6} /></div>
        ) : users.length === 0 ? (
          <div className="admin-card-pad">
            <EmptyState title="No users match that filter" message="Try a different search term or clear the filters." />
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Groups</th>
                  <th>Last login</th>
                  <th className="admin-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{displayName(user)}</strong>
                      <small className="admin-muted">{user.email}</small>
                    </td>
                    <td>
                      {user.role === "ADMIN" ? (
                        <span className="admin-badge admin-badge-admin">{labelFor("role", user.role)}</span>
                      ) : (
                        <select
                          className="admin-select-inline"
                          aria-label={`Change role for ${user.email}`}
                          value={user.role}
                          disabled={busyUser === `role:${user.id}`}
                          onChange={(event) => changeRole(user, event.target.value)}
                        >
                          <option value="STUDENT">Student</option>
                          <option value="LECTURER">Lecturer</option>
                        </select>
                      )}
                    </td>
                    <td>
                      <span className={`admin-badge admin-badge-${user.status.toLowerCase()}`}>
                        {labelFor("status", user.status)}
                      </span>
                    </td>
                    <td>{user.group_count ?? 0}</td>
                    <td className="admin-muted">{user.last_login_at ? formatDateTime(user.last_login_at) : "Never"}</td>
                    <td className="admin-col-actions">
                      {user.role !== "ADMIN" && user.status === "ACTIVE" && (
                        <button
                          className="admin-btn admin-btn-danger"
                          type="button"
                          onClick={() => {
                            setSuspendTarget(user);
                            setSuspendReason("");
                          }}
                        >
                          Suspend
                        </button>
                      )}
                      {user.role !== "ADMIN" && user.status === "SUSPENDED" && (
                        <button
                          className="admin-btn admin-btn-ghost"
                          type="button"
                          disabled={busyUser === `restore:${user.id}`}
                          onClick={() => restore(user)}
                        >
                          {busyUser === `restore:${user.id}` ? "…" : "Restore"}
                        </button>
                      )}
                      {user.status === "SUSPENDED" && user.suspension_reason && (
                        <small className="admin-muted admin-suspension-reason" title={user.suspension_reason}>
                          {user.suspension_reason}
                        </small>
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
        open={Boolean(suspendTarget)}
        title="Suspend account"
        onClose={() => setSuspendTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setSuspendTarget(null)}>
              Cancel
            </button>
            <button
              className="admin-btn admin-btn-danger"
              type="button"
              disabled={busyUser.startsWith("suspend:")}
              onClick={confirmSuspend}
            >
              {busyUser.startsWith("suspend:") ? "Suspending…" : "Suspend account"}
            </button>
          </>
        }
      >
        {suspendTarget && (
          <>
            <p>
              Suspending <strong>{displayName(suspendTarget)}</strong> ({suspendTarget.email}) will revoke their active
              sessions immediately.
            </p>
            <label className="admin-field">
              <span>Reason (recorded in the audit log)</span>
              <textarea
                rows={3}
                maxLength={500}
                value={suspendReason}
                onChange={(event) => setSuspendReason(event.target.value)}
                placeholder="Explain why this account is being suspended."
              />
            </label>
          </>
        )}
      </AdminModal>
    </>
  );
}
