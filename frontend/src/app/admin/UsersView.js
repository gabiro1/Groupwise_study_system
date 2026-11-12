"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest, displayName, formatDateTime, labelFor } from "./adminApi";
import PageHeading from "./PageHeading";
import AdminModal from "./AdminModal";
import { EditIcon, RefreshIcon, TrashIcon, UserMinusIcon } from "./AdminIcons";
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
  const [registrationNumberStatus, setRegistrationNumberStatus] = useState(searchParams.get("registrationNumberStatus") || "");

  const [busyUser, setBusyUser] = useState("");
  const [suspendTarget, setSuspendTarget] = useState(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ firstName: "", lastName: "", email: "", yearOfStudy: "", admissionYear: "", currentSemester: "", registrationNumber: "", registrationNumberVerified: false, staffIdentifier: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteReason, setDeleteReason] = useState("");

  const buildQuery = useCallback(
    (nextCursor) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (q.trim()) params.set("q", q.trim());
      if (role) params.set("role", role);
      if (status) params.set("status", status);
      if (registrationNumberStatus) params.set("registrationNumberStatus", registrationNumberStatus);
      if (nextCursor != null) params.set("cursor", String(nextCursor));
      return params.toString();
    },
    [q, role, status, registrationNumberStatus],
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
    setRegistrationNumberStatus("");
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

  async function openEdit(user) {
    setEditTarget(user);
    setEditLoading(true);
    setEditError("");
    try {
      const result = await apiRequest(`admin/users/${user.id}`);
      const detail = result.user;
      setEditForm({
        firstName: detail.first_name || "",
        lastName: detail.last_name || "",
        email: detail.email || "",
        yearOfStudy: detail.year_of_study ?? "",
        admissionYear: detail.admission_year ?? "",
        currentSemester: detail.current_semester || "",
        registrationNumber: detail.student_number || "",
        registrationNumberVerified: Boolean(detail.registration_number_verified_at),
        staffIdentifier: detail.staff_identifier || "",
      });
    } catch (requestError) {
      setEditError(requestError.message);
    } finally {
      setEditLoading(false);
    }
  }

  async function saveEdit() {
    if (!editTarget) return;
    setBusyUser(`edit:${editTarget.id}`);
    setEditError("");
    try {
      const body = {
        firstName: editForm.firstName.trim(),
        lastName: editForm.lastName.trim(),
        email: editForm.email.trim(),
        yearOfStudy: editForm.yearOfStudy === "" ? null : Number(editForm.yearOfStudy),
        admissionYear: editForm.admissionYear === "" ? null : Number(editForm.admissionYear),
      };
      if (editTarget.role === "STUDENT") {
        body.registrationNumber = editForm.registrationNumber.trim() || null;
        body.registrationNumberVerified = Boolean(editForm.registrationNumberVerified);
        body.currentSemester = editForm.currentSemester.trim() || null;
      }
      if (editTarget.role === "ADMIN") body.staffIdentifier = editForm.staffIdentifier.trim() || null;

      const result = await apiRequest(`admin/users/${editTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setMessage(result.emailChanged ? "User details updated. The new email requires verification." : "User details updated.");
      setEditTarget(null);
      await reload();
    } catch (requestError) {
      setEditError(requestError.message);
    } finally {
      setBusyUser("");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteReason.trim().length < 5) {
      setError("Give a reason (at least 5 characters) for the audit trail before deleting.");
      return;
    }
    setBusyUser(`delete:${deleteTarget.id}`);
    setError("");
    try {
      const result = await apiRequest(`admin/users/${deleteTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: deleteReason.trim() }),
      });
      const groupMessage = result.groupsArchived
        ? ` ${result.groupsArchived} owned group${result.groupsArchived === 1 ? " was" : "s were"} archived.`
        : "";
      setMessage(`${displayName(deleteTarget)} was removed from the system and all active sessions were revoked.${groupMessage}`);
      setDeleteTarget(null);
      setDeleteReason("");
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
              placeholder="Search by name, email, or identifier"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
            <select aria-label="Filter by role" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">All roles</option>
              <option value="STUDENT">Student</option>
              <option value="ADMIN">Admin</option>
            </select>
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="PENDING_VERIFICATION">Pending verification</option>
            <option value="DEACTIVATED">Deactivated</option>
          </select>
          <select aria-label="Filter by registration number" value={registrationNumberStatus} onChange={(event) => setRegistrationNumberStatus(event.target.value)}>
            <option value="">All registration numbers</option>
            <option value="ASSIGNED">Assigned</option>
            <option value="PENDING">Pending assignment</option>
            <option value="UNVERIFIED">Pending verification</option>
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
                  <th>University identifier</th>
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
                      <span>{user.role === "STUDENT" ? (user.student_number || "Pending assignment") : (user.staff_identifier || "—")}</span>
                      {user.role === "STUDENT" && user.student_number && <small className="admin-muted">{user.registration_number_verified_at ? "Verified" : "Pending verification"}</small>}
                    </td>
                    <td>
                      <span className={`admin-badge admin-badge-${user.role.toLowerCase()}`}>
                        {labelFor("role", user.role)}
                      </span>
                    </td>
                    <td>
                      <span className={`admin-badge admin-badge-${user.status.toLowerCase()}`}>
                        {labelFor("status", user.status)}
                      </span>
                    </td>
                    <td>{user.group_count ?? 0}</td>
                    <td className="admin-muted">{user.last_login_at ? formatDateTime(user.last_login_at) : "Never"}</td>
                    <td className="admin-col-actions">
                      <button
                        className="admin-icon-action"
                        type="button"
                        aria-label={`Edit ${displayName(user)}`}
                        title="Edit user"
                        disabled={busyUser === `edit:${user.id}`}
                        onClick={() => openEdit(user)}
                      >
                        <EditIcon size={16} />
                      </button>
                      {user.role !== "ADMIN" && user.status === "ACTIVE" && (
                        <button
                          className="admin-icon-action admin-icon-action-danger"
                          type="button"
                          aria-label={`Suspend ${displayName(user)}`}
                          title="Suspend user"
                          onClick={() => {
                            setSuspendTarget(user);
                            setSuspendReason("");
                          }}
                        >
                          <UserMinusIcon size={16} />
                        </button>
                      )}
                      {user.role !== "ADMIN" && user.status === "SUSPENDED" && (
                        <button
                          className="admin-icon-action"
                          type="button"
                          aria-label={`Restore ${displayName(user)}`}
                          title="Restore user"
                          disabled={busyUser === `restore:${user.id}`}
                          onClick={() => restore(user)}
                        >
                          <RefreshIcon size={16} />
                        </button>
                      )}
                      {user.role !== "ADMIN" && user.status !== "DEACTIVATED" && (
                        <button
                          className="admin-icon-action admin-icon-action-danger"
                          type="button"
                          aria-label={`Delete ${displayName(user)}`}
                          title="Delete user"
                          onClick={() => {
                            setDeleteTarget(user);
                            setDeleteReason("");
                            setError("");
                          }}
                        >
                          <TrashIcon size={16} />
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

      <AdminModal
        open={Boolean(editTarget)}
        title={editTarget ? `Edit ${displayName(editTarget)}` : "Edit user"}
        onClose={() => setEditTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setEditTarget(null)}>
              Cancel
            </button>
            <button
              className="admin-btn admin-btn-primary"
              type="button"
              disabled={editLoading || busyUser.startsWith("edit:")}
              onClick={saveEdit}
            >
              {busyUser.startsWith("edit:") ? "Saving…" : "Save changes"}
            </button>
          </>
        }
      >
        {editLoading ? (
          <Skeleton rows={4} />
        ) : editError ? (
          <div className="admin-banner admin-banner-error" role="alert">{editError}</div>
        ) : (
          <div className="admin-field-grid">
            <label className="admin-field">
              <span>First name</span>
              <input value={editForm.firstName} onChange={(event) => setEditForm((current) => ({ ...current, firstName: event.target.value }))} />
            </label>
            <label className="admin-field">
              <span>Last name</span>
              <input value={editForm.lastName} onChange={(event) => setEditForm((current) => ({ ...current, lastName: event.target.value }))} />
            </label>
            <label className="admin-field" style={{ gridColumn: "1 / -1" }}>
              <span>Email address</span>
              <input type="email" value={editForm.email} onChange={(event) => setEditForm((current) => ({ ...current, email: event.target.value }))} />
            </label>
            <label className="admin-field">
              <span>Year of study</span>
              <input type="number" min="1" max="10" value={editForm.yearOfStudy} onChange={(event) => setEditForm((current) => ({ ...current, yearOfStudy: event.target.value }))} />
            </label>
            {editTarget?.role === "STUDENT" && (
              <>
                <label className="admin-field">
                  <span>Registration number</span>
                  <input value={editForm.registrationNumber} onChange={(event) => setEditForm((current) => ({ ...current, registrationNumber: event.target.value }))} placeholder="e.g. BBICTR/2024/44711" />
                </label>
                <label className="admin-field">
                  <span>Admission year</span>
                  <input type="number" min="1900" max={new Date().getFullYear() + 1} value={editForm.admissionYear} onChange={(event) => setEditForm((current) => ({ ...current, admissionYear: event.target.value }))} />
                </label>
                <label className="admin-field">
                  <span>Current semester</span>
                  <input maxLength={40} value={editForm.currentSemester} onChange={(event) => setEditForm((current) => ({ ...current, currentSemester: event.target.value }))} placeholder="e.g. Semester 1" />
                </label>
                <label className="admin-field admin-checkbox-field">
                  <span>Verification</span>
                  <span><input type="checkbox" checked={editForm.registrationNumberVerified} onChange={(event) => setEditForm((current) => ({ ...current, registrationNumberVerified: event.target.checked }))} /> Mark registration number as verified</span>
                </label>
              </>
            )}
            {editTarget?.role === "ADMIN" && (
              <label className="admin-field">
                <span>Staff identifier</span>
                <input value={editForm.staffIdentifier} onChange={(event) => setEditForm((current) => ({ ...current, staffIdentifier: event.target.value }))} placeholder="Optional institutional staff ID" />
              </label>
            )}
            <p className="admin-muted" style={{ gridColumn: "1 / -1" }}>
              Changing an email address resets verification and revokes the user&apos;s active sessions. Registration-number changes are recorded in the audit log.
            </p>
          </div>
        )}
      </AdminModal>

      <AdminModal
        open={Boolean(deleteTarget)}
        title="Delete user account"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button
              className="admin-btn admin-btn-danger"
              type="button"
              disabled={busyUser.startsWith("delete:")}
              onClick={confirmDelete}
            >
              {busyUser.startsWith("delete:") ? "Deleting…" : "Delete account"}
            </button>
          </>
        }
      >
        {deleteTarget && (
          <>
            <p>
              This will deactivate <strong>{displayName(deleteTarget)}</strong> ({deleteTarget.email}), revoke active sessions,
              archive any active groups they own, remove active group memberships, and cancel pending invitations and join
              requests. The account is soft-deleted so academic history remains intact.
            </p>
            <label className="admin-field">
              <span>Reason (recorded in the audit log)</span>
              <textarea
                required
                minLength={5}
                rows={3}
                maxLength={500}
                value={deleteReason}
                onChange={(event) => setDeleteReason(event.target.value)}
                placeholder="Explain why this account is being removed."
              />
            </label>
          </>
        )}
      </AdminModal>
    </>
  );
}
