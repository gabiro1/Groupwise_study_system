"use client";

import { useEffect, useState } from "react";
import { apiRequest, formatDateTime } from "./adminApi";
import PageHeading from "./PageHeading";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const ENTITY_TYPES = [
  { value: "", label: "All entities" },
  { value: "user", label: "User" },
  { value: "report", label: "Report" },
  { value: "system_setting", label: "System setting" },
];

export default function AuditView() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");

  async function load() {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (action.trim()) params.set("action", action.trim());
      if (entityType) params.set("entityType", entityType);
      const result = await apiRequest(`admin/audit?${params.toString()}`);
      setEntries(result.entries || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function reload() {
    setLoading(true);
    return load();
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await apiRequest("admin/audit?limit=100");
        if (active) {
          setEntries(result.entries || []);
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
  }, []);

  function applyFilters(event) {
    event.preventDefault();
    reload();
  }

  return (
    <>
      <PageHeading
        title="Audit log"
        subtitle="Every administrative action, newest first."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}

      <section className="admin-card">
        <form className="admin-toolbar" onSubmit={applyFilters}>
          <input
            aria-label="Filter by action"
            placeholder="Filter by action (e.g. user.suspended)"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
          <select aria-label="Filter by entity type" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
            {ENTITY_TYPES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button className="admin-btn admin-btn-primary" type="submit">Apply filters</button>
          <button
            className="admin-btn admin-btn-ghost"
            type="button"
            onClick={() => {
              setAction("");
              setEntityType("");
              setTimeout(reload, 0);
            }}
          >
            Reset
          </button>
        </form>

        <div className="admin-card-body admin-card-body-flush">
          {loading ? (
            <div className="admin-card-pad"><Skeleton rows={6} /></div>
          ) : error ? (
            <div className="admin-card-pad"><ErrorState message={error} onRetry={reload} /></div>
          ) : entries.length === 0 ? (
            <div className="admin-card-pad">
              <EmptyState title="No audit entries" message="Administrative actions will be recorded here." />
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Actor</th>
                    <th>IP</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="admin-muted">{formatDateTime(entry.created_at)}</td>
                      <td><code className="admin-code">{entry.action}</code></td>
                      <td className="admin-muted">
                        {entry.entity_type}
                        {entry.entity_id ? ` · ${entry.entity_id.slice(0, 8)}…` : ""}
                      </td>
                      <td className="admin-muted">
                        {entry.actor_email || "System"}
                        {entry.actor_role ? <small className="admin-muted"> · {entry.actor_role}</small> : null}
                      </td>
                      <td className="admin-muted">{entry.ip_address || "—"}</td>
                      <td>
                        {entry.metadata ? (
                          <code className="admin-code admin-code-block" title={JSON.stringify(entry.metadata)}>
                            {JSON.stringify(entry.metadata)}
                          </code>
                        ) : (
                          <span className="admin-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
