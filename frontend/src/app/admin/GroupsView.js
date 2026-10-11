"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest, formatDate, labelFor } from "./adminApi";
import PageHeading from "./PageHeading";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const PAGE_SIZE = 30;

export default function GroupsView() {
  const searchParams = useSearchParams();
  const [groups, setGroups] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

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

  return (
    <>
      <PageHeading
        title="Study groups"
        subtitle="Monitor every group, its size, owner, and status."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}

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
                  <th>Privacy</th>
                  <th>Status</th>
                  <th>Created</th>
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
                    <td className="admin-muted">{group.privacy === "PRIVATE" ? "Private" : "Public"}</td>
                    <td>
                      <span className={`admin-badge admin-badge-${group.status.toLowerCase()}`}>
                        {labelFor("groupStatus", group.status)}
                      </span>
                    </td>
                    <td className="admin-muted">{formatDate(group.created_at)}</td>
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
    </>
  );
}
