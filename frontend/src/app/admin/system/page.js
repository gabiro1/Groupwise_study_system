"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, formatDateTime } from "../adminApi";
import PageHeading from "../PageHeading";
import { Skeleton } from "../DataState";

const SERVICE_STATUSES = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  DOWN: "down",
  UNKNOWN: "unknown",
};

function statusColor(status) {
  switch (status) {
    case SERVICE_STATUSES.HEALTHY: return "admin-badge-active";
    case SERVICE_STATUSES.DEGRADED: return "admin-badge-warn";
    case SERVICE_STATUSES.DOWN: return "admin-badge-danger";
    default: return "admin-badge-muted";
  }
}

export default function SystemMonitoringView() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiRequest("admin/system/health");
      setHealth(result?.health ?? result);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function reload() {
    setLoading(true);
    load();
  }

  return (
    <>
      <PageHeading
        title="System Monitoring"
        subtitle="Inspect backend availability, database health, AI providers, and platform services."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}

      {loading && <div className="admin-card-pad"><Skeleton rows={8} /></div>}

      {!loading ? (
        <div className="admin-content">
          <div className="admin-metric-grid">
            <div className="admin-metric">
              <div className="admin-metric-body">
                <span className="admin-metric-label">Overall status</span>
                <span className={`admin-metric-value admin-badge ${statusColor(health?.status || "unknown")}`}>
                  {(health?.status || "unknown").charAt(0).toUpperCase() + (health?.status || "unknown").slice(1)}
                </span>
              </div>
            </div>
            <div className="admin-metric">
              <div className="admin-metric-body">
                <span className="admin-metric-label">Uptime</span>
                <span className="admin-metric-value">{health?.app?.uptimeSeconds != null ? Math.floor(health.app.uptimeSeconds / 60) + " min" : "—"}</span>
              </div>
            </div>
            <div className="admin-metric">
              <div className="admin-metric-body">
                <span className="admin-metric-label">Database connections</span>
                <span className="admin-metric-value">{health?.database?.pool?.total ?? "—"}</span>
              </div>
            </div>
            <div className="admin-metric">
              <div className="admin-metric-body">
                <span className="admin-metric-label">Memory used</span>
                <span className="admin-metric-value">{health?.memory?.heapUsedMb ?? "—"} MB</span>
              </div>
            </div>
          </div>

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>Services</h2>
                <p>Real health checks performed at request time.</p>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              {loading ? (
                <div className="admin-card-pad"><Skeleton rows={4} /></div>
              ) : health?.services && (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th>Status</th>
                        <th>Detail</th>
                        <th>Latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {health.services.map((service) => (
                        <tr key={service.key}>
                          <td><strong>{service.label}</strong></td>
                          <td>
                            <span className={`admin-badge ${statusColor(service.ok ? "healthy" : "down")}`}>
                              {service.ok ? "Healthy" : "Down"}
                            </span>
                          </td>
                          <td className="admin-muted">{service.detail}</td>
                          <td className="admin-muted">{service.latencyMs != null ? service.latencyMs + " ms" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {health?.database?.details && (
            <section className="admin-card">
              <header className="admin-card-head">
                <div>
                  <h2>Database</h2>
                  <p>PostgreSQL instance details.</p>
                </div>
              </header>
              <div className="admin-card-body admin-card-body-flush">
                <div className="admin-setting-list">
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Database</strong>
                      <small>{health.database.details.database}</small>
                    </div>
                    <span className="admin-muted">{health.database.details.version}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Size</strong>
                      <small>Database size on disk.</small>
                    </div>
                    <span className="admin-muted">{health.database.details.size}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Connections</strong>
                      <small>Active connections to this database.</small>
                    </div>
                    <span className="admin-muted">{health.database.details.connections}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Slowest migration</strong>
                      <small>Milliseconds.</small>
                    </div>
                    <span className="admin-muted">{health.migrations?.slowest_ms != null ? health.migrations.slowest_ms + " ms" : "—"}</span>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>AI</h2>
                <p>AI provider configuration and circuit breaker state.</p>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              {loading ? (
                <div className="admin-card-pad"><Skeleton rows={3} /></div>
              ) : health?.ai && (
                <div className="admin-setting-list">
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Configured</strong>
                      <small>Whether any AI provider target is configured.</small>
                    </div>
                    <span className={`admin-badge ${health.ai.configured ? "admin-badge-active" : "admin-badge-muted"}`}>
                      {health.ai.configured ? "Yes" : "No"}
                    </span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Provider</strong>
                      <small>The primary AI provider.</small>
                    </div>
                    <span className="admin-muted">{health.ai.provider || "None"}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Model</strong>
                      <small>The primary chat model.</small>
                    </div>
                    <span className="admin-muted">{health.ai.model || "—"}</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          {health?.migrations && (
            <section className="admin-card">
              <header className="admin-card-head">
                <div>
                  <h2>Migrations</h2>
                  <p>Applied schema migrations.</p>
                </div>
              </header>
              <div className="admin-card-body admin-card-body-flush">
                <div className="admin-setting-list">
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Applied</strong>
                      <small>Number of migrations applied.</small>
                    </div>
                    <span className="admin-muted">{health.migrations.applied}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Last applied</strong>
                      <small>Timestamp of the most recent migration.</small>
                    </div>
                    <span className="admin-muted">{health.migrations.last_applied ? formatDateTime(health.migrations.last_applied) : "—"}</span>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>Activity (last 24 hours)</h2>
                <p>Recent platform activity counts.</p>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              {loading ? (
                <div className="admin-card-pad"><Skeleton rows={4} /></div>
              ) : health?.activity && (
                <div className="admin-setting-list">
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Active users</strong>
                      <small>Accounts with status ACTIVE.</small>
                    </div>
                    <span className="admin-muted">{health.activity.active_users}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Active groups</strong>
                      <small>Study groups with status ACTIVE.</small>
                    </div>
                    <span className="admin-muted">{health.activity.active_groups}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Live sessions</strong>
                      <small>Study sessions with status ACTIVE.</small>
                    </div>
                    <span className="admin-muted">{health.activity.live_sessions}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Open reports</strong>
                      <small>Reports with status OPEN or IN_REVIEW.</small>
                    </div>
                    <span className="admin-muted">{health.activity.open_reports}</span>
                  </div>
                  <div className="admin-setting-row">
                    <div className="admin-setting-copy">
                      <strong>Audit events (24h)</strong>
                      <small>Administrative actions in the last 24 hours.</small>
                    </div>
                    <span className="admin-muted">{health.activity.audit_events_24h}</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
