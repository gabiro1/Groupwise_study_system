"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest, displayName, formatDateTime, labelFor } from "../adminApi";
import PageHeading from "../PageHeading";
import AdminModal from "../AdminModal";
import { EmptyState, Skeleton } from "../DataState";

const PAGE_SIZE = 25;

const ROLES = [
  { key: "STUDENT", label: "Student" },
  { key: "ADMIN", label: "Administrator" },
];

const ROLE_ACTIONS = {
  STUDENT: [],
  ADMIN: [],
};

function RolesContent() {
  const searchParams = useSearchParams();
  const [users, setUsers] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [role, setRole] = useState(searchParams.get("role") || "");

  const [busyUser, setBusyUser] = useState("");
  const [changeTarget, setChangeTarget] = useState(null);
  const [changeTargetNewRole, setChangeTargetNewRole] = useState("");
  const [changeReason, setChangeReason] = useState("");

  const buildQuery = useCallback(
    (nextCursor) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (q.trim()) params.set("q", q.trim());
      if (role) params.set("role", role);
      if (nextCursor != null) params.set("cursor", String(nextCursor));
      return params.toString();
    },
    [q, role],
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
    // Load the URL filters once; subsequent searches are explicit form actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(event) {
    event.preventDefault();
    reload();
  }

  function resetFilters() {
    setQ("");
    setRole("");
    setTimeout(() => reload(), 0);
  }

  function availableActions(userRole) {
    return ROLE_ACTIONS[userRole] || [];
  }

  async function changeRole(user, nextRole) {
    const reason = changeReason.trim();
    if (!nextRole) {
      setError("Choose the new role.");
      return;
    }
    if (reason.length < 5) {
      setError("Give a reason of at least 5 characters for the audit trail.");
      return;
    }
    setBusyUser(`role:${user.id}`);
    setError("");
    try {
      await apiRequest(`admin/users/${user.id}/role`, {
        method: "POST",
        body: JSON.stringify({ role: nextRole, reason }),
      });
      setMessage(`${displayName(user)} is now a ${nextRole.toLowerCase().replaceAll("_", " ")}.`);
      setChangeTarget(null);
      setChangeReason("");
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
        title="Roles & Permissions"
        subtitle="Global roles are Student and Administrator; group leadership is membership-scoped."
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
            {ROLES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
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
                  <th>Groups led</th>
                  <th>Last login</th>
                  <th className="admin-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const actions = availableActions(user.role);
                  return (
                    <tr key={user.id}>
                      <td>
                        <strong>{displayName(user)}</strong>
                        <small className="admin-muted">{user.email}</small>
                      </td>
                      <td>
                        <span className={`admin-badge admin-badge-role-${user.role.toLowerCase().replace("_", "-")}`}>
                          {labelFor("role", user.role)}
                        </span>
                      </td>
                      <td>
                        <span className={`admin-badge admin-badge-${user.status.toLowerCase()}`}>
                          {labelFor("status", user.status)}
                        </span>
                      </td>
                      <td className="admin-muted">{user.group_count ?? 0}</td>
                      <td className="admin-muted">{user.last_login_at ? formatDateTime(user.last_login_at) : "Never"}</td>
                      <td className="admin-col-actions">
                        {actions.length > 0 && user.role !== "ADMIN" && (
                          <button
                            className="admin-btn admin-btn-ghost admin-btn-sm"
                            type="button"
                            disabled={busyUser === `role:${user.id}`}
                            onClick={() => {
                              setChangeTarget(user);
                              setChangeTargetNewRole(availableActions(user.role)[0]?.value || "");
                              setChangeReason("");
                            }}
                          >
                            {busyUser === `role:${user.id}` ? "…" : "Change role"}
                          </button>
                        )}
                        {user.role === "ADMIN" && (
                          <span className="admin-muted admin-badge-small">Protected</span>
                        )}
                        {actions.length === 0 && user.role !== "ADMIN" && (
                          <span className="admin-muted admin-badge-small">No change</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
        open={Boolean(changeTarget)}
        title="Change role"
        onClose={() => setChangeTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setChangeTarget(null)}>
              Cancel
            </button>
            <button
              className="admin-btn admin-btn-danger"
              type="button"
              disabled={busyUser.startsWith("role:") || !changeTargetNewRole || changeReason.trim().length < 5}
              onClick={() => changeRole(changeTarget, changeTargetNewRole)}
            >
              {busyUser.startsWith("role:") ? "Changing…" : "Change role"}
            </button>
          </>
        }
      >
        {changeTarget && (
          <>
            <p>
              Change <strong>{displayName(changeTarget)}</strong> from {labelFor("role", changeTarget.role)} to:
            </p>
            <label className="admin-field">
              <span>New role</span>
              <select
                value={changeTargetNewRole}
                onChange={(event) => setChangeTargetNewRole(event.target.value)}
                disabled={busyUser.startsWith("role:")}
              >
                {availableActions(changeTarget.role).map((action) => (
                  <option key={action.value} value={action.value}>{action.label}</option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Reason (recorded in the audit log)</span>
              <textarea
                rows={3}
                maxLength={500}
                value={changeReason}
                onChange={(event) => setChangeReason(event.target.value)}
                placeholder="Explain why this role is changing."
              />
            </label>
          </>
        )}
      </AdminModal>
    </>
  );
}

export default function RolesView() {
  return (
    <Suspense fallback={<Skeleton rows={6} />}>
      <RolesContent />
    </Suspense>
  );
}
