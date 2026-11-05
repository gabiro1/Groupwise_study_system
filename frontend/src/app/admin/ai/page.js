"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../adminApi";
import PageHeading from "../PageHeading";
import { EmptyState, ErrorState, Skeleton } from "../DataState";

const DEFAULT_RUNTIME = {
  assistantEnabled: true,
  matchingEnabled: true,
  maxRequestsPerHour: 60,
  timeoutMs: 25_000,
};

export default function AIConfigView() {
  const [config, setConfig] = useState(null);
  const [usage, setUsage] = useState(null);
  const [chain, setChain] = useState(null);
  const [runtimeDraft, setRuntimeDraft] = useState(DEFAULT_RUNTIME);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [range, setRange] = useState(30);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, usageResult, chainResult] = await Promise.all([
        apiRequest("admin/ai/config"),
        apiRequest(`admin/ai/usage?range=${range}`),
        apiRequest("admin/ai/chain"),
      ]);
      const nextConfig = cfg?.config ?? cfg ?? {};
      const nextChain = Array.isArray(chainResult)
        ? chainResult
        : chainResult?.chain ?? nextConfig.chain ?? [];
      const nextRuntime = nextConfig.runtime ?? usageResult?.configuration?.runtime ?? {};
      setConfig({ ...nextConfig, runtime: nextRuntime });
      setRuntimeDraft({ ...DEFAULT_RUNTIME, ...nextRuntime });
      setUsage(usageResult?.report ?? usageResult ?? null);
      setChain(nextChain);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function reload() {
    void load();
  }

  async function saveRuntime() {
    const maxRequestsPerHour = Number(runtimeDraft.maxRequestsPerHour);
    const timeoutMs = Number(runtimeDraft.timeoutMs);
    if (!Number.isInteger(maxRequestsPerHour) || maxRequestsPerHour < 1 || maxRequestsPerHour > 1000) {
      setError("Requests per hour must be a whole number from 1 to 1,000.");
      return;
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
      setError("Timeout must be a whole number from 1,000 to 120,000 milliseconds.");
      return;
    }

    setRuntimeBusy(true);
    setError("");
    try {
      const result = await apiRequest("admin/ai/config", {
        method: "PATCH",
        body: JSON.stringify({
          assistantEnabled: Boolean(runtimeDraft.assistantEnabled),
          matchingEnabled: Boolean(runtimeDraft.matchingEnabled),
          maxRequestsPerHour,
          timeoutMs,
        }),
      });
      const nextConfig = result?.config ?? result ?? {};
      const nextRuntime = nextConfig.runtime ?? {
        assistantEnabled: Boolean(runtimeDraft.assistantEnabled),
        matchingEnabled: Boolean(runtimeDraft.matchingEnabled),
        maxRequestsPerHour,
        timeoutMs,
      };
      setConfig({ ...nextConfig, runtime: nextRuntime });
      setRuntimeDraft({ ...DEFAULT_RUNTIME, ...nextRuntime });
      setMessage("AI runtime controls saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function testProvider() {
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await apiRequest("admin/ai/test", { method: "POST", body: "{}" });
      const probe = result?.result ?? result ?? { ok: false, message: "The provider returned no test result." };
      setTestResult(probe);
      setMessage(probe.ok ? "Provider responded successfully." : "Provider test failed.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setTestBusy(false);
    }
  }

  const data = config;
  const usageData = usage;
  const chainData = Array.isArray(chain) ? chain : [];

  if (!data && error) {
    return (
      <>
        <PageHeading title="AI Configuration" subtitle="Manage AI providers and usage." />
        <ErrorState message={error} onRetry={reload} />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="AI Configuration"
        subtitle="Configure AI providers, monitor usage, and test connectivity."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      {loading && <div className="admin-card-pad"><Skeleton rows={6} /></div>}

      {!loading && (
        <>
          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>Provider status</h2>
                <p>AI provider readiness and feature toggles.</p>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              <div className="admin-status-grid">
                <div className="admin-status-item">
                  <strong>Configured</strong>
                  <span className={`admin-badge ${data?.configured ? "admin-badge-active" : "admin-badge-muted"}`}>
                    {data?.configured ? "Yes" : "No"}
                  </span>
                </div>
                <div className="admin-status-item">
                  <strong>Primary provider</strong>
                  <span>{data?.primary?.provider || "None"}</span>
                </div>
                <div className="admin-status-item">
                  <strong>Primary model</strong>
                  <span>{data?.primary?.model || "—"}</span>
                </div>
                <div className="admin-status-item">
                  <strong>Embedding model</strong>
                  <span>{data?.embeddingModel || "—"}</span>
                </div>
                <div className="admin-status-item">
                  <strong>Fallbacks</strong>
                  <span>{data?.fallbacks ?? 0}</span>
                </div>
                <div className="admin-status-item">
                  <strong>Secrets exposed</strong>
                  <span className={`admin-badge ${data?.secretsExposed ? "admin-badge-danger" : "admin-badge-active"}`}>
                    {data?.secretsExposed ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>Runtime controls</h2>
                <p>Turn AI features off or adjust their request budget without changing provider credentials.</p>
              </div>
            </header>
            <div className="admin-card-body">
              <div className="admin-field-grid">
                <label className="admin-field">
                  <span>Assistant</span>
                  <select
                    value={runtimeDraft.assistantEnabled ? "true" : "false"}
                    onChange={(event) => setRuntimeDraft((current) => ({ ...current, assistantEnabled: event.target.value === "true" }))}
                    disabled={runtimeBusy}
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
                <label className="admin-field">
                  <span>Matching</span>
                  <select
                    value={runtimeDraft.matchingEnabled ? "true" : "false"}
                    onChange={(event) => setRuntimeDraft((current) => ({ ...current, matchingEnabled: event.target.value === "true" }))}
                    disabled={runtimeBusy}
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
                <label className="admin-field">
                  <span>Requests per hour</span>
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={runtimeDraft.maxRequestsPerHour}
                    onChange={(event) => setRuntimeDraft((current) => ({ ...current, maxRequestsPerHour: event.target.value }))}
                    disabled={runtimeBusy}
                  />
                </label>
                <label className="admin-field">
                  <span>Provider timeout (ms)</span>
                  <input
                    type="number"
                    min="1000"
                    max="120000"
                    step="1000"
                    value={runtimeDraft.timeoutMs}
                    onChange={(event) => setRuntimeDraft((current) => ({ ...current, timeoutMs: event.target.value }))}
                    disabled={runtimeBusy}
                  />
                </label>
              </div>
              <button className="admin-btn admin-btn-primary" type="button" disabled={runtimeBusy} onClick={saveRuntime}>
                {runtimeBusy ? "Saving…" : "Save runtime controls"}
              </button>
            </div>
          </section>

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>Provider chain</h2>
                <p>Failover targets and circuit breaker state.</p>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              {loading && <div className="admin-card-pad"><Skeleton rows={4} /></div>}
              {!loading && chainData && chainData.length === 0 && (
                <div className="admin-card-pad">
                  <EmptyState title="No AI provider targets" message="No provider targets are configured." />
                </div>
              )}
              {!loading && chainData && chainData.length > 0 && (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Target</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Circuit</th>
                        <th>Failures</th>
                        <th className="admin-col-actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chainData.map((target) => (
                        <tr key={target.id}>
                          <td><strong>{target.label || target.id}</strong></td>
                          <td className="admin-muted">{target.provider}</td>
                          <td className="admin-muted admin-code">{target.model}</td>
                          <td>
                            <span className={`admin-badge ${target.circuit === "CLOSED" ? "admin-badge-active" : "admin-badge-danger"}`}>
                              {target.circuit}
                            </span>
                          </td>
                          <td>{target.failures ?? 0}</td>
                          <td className="admin-col-actions">
                            {target.circuit !== "CLOSED" && (
                              <button
                                className="admin-btn admin-btn-ghost admin-btn-sm"
                                type="button"
                                onClick={() => {
                                  apiRequest(`admin/ai/providers/${encodeURIComponent(target.id)}/reset`, { method: "POST", body: "{}" })
                                    .then(() => {
                                      setMessage(`Circuit breaker for ${target.label} reset.`);
                                      reload();
                                    })
                                    .catch((e) => setError(e.message));
                                }}
                              >
                                Reset
                              </button>
                            )}
                            {target.circuit === "CLOSED" && (
                              <span className="admin-muted admin-badge-small">Healthy</span>
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

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>AI usage (last {range} days)</h2>
                <p>Real telemetry from ai_usage_events.</p>
              </div>
              <div className="admin-toolbar-right">
                <button
                  className="admin-btn admin-btn-ghost"
                  type="button"
                  onClick={() => setRange(range === 30 ? 7 : 30)}
                >
                  Show {range === 30 ? "7" : "30"} days
                </button>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              {loading && <div className="admin-card-pad"><Skeleton rows={4} /></div>}
              {!loading && usageData && (
                <div className="admin-metric-grid">
                  <div className="admin-metric">
                    <div className="admin-metric-body">
                      <span className="admin-metric-label">Total requests</span>
                      <span className="admin-metric-value">{usageData?.totals?.requests ?? "—"}</span>
                    </div>
                  </div>
                  <div className="admin-metric">
                    <div className="admin-metric-body">
                      <span className="admin-metric-label">Successful</span>
                      <span className="admin-metric-value">{usageData?.totals?.successful ?? "—"}</span>
                    </div>
                  </div>
                  <div className="admin-metric">
                    <div className="admin-metric-body">
                      <span className="admin-metric-label">Failed</span>
                      <span className="admin-metric-value">{usageData?.totals?.failed ?? "—"}</span>
                    </div>
                  </div>
                  <div className="admin-metric">
                    <div className="admin-metric-body">
                      <span className="admin-metric-label">Success rate</span>
                      <span className="admin-metric-value">{usageData?.totals?.successRate ?? "—"}%</span>
                    </div>
                  </div>
                  <div className="admin-metric">
                    <div className="admin-metric-body">
                      <span className="admin-metric-label">Avg latency</span>
                      <span className="admin-metric-value">{usageData?.totals?.avgLatencyMs ?? "—"}ms</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="admin-card">
            <header className="admin-card-head">
              <div>
                <h2>Test provider</h2>
                <p>Make a live health-check request through the configured failover chain.</p>
              </div>
            </header>
            <div className="admin-card-body admin-card-body-flush">
              <button
                className="admin-btn admin-btn-primary"
                type="button"
                disabled={testBusy}
                onClick={testProvider}
              >
                {testBusy ? "Testing…" : "Test provider"}
              </button>
              {testResult && (
                <div className="admin-card-pad admin-mt">
                  <div className={`admin-banner ${testResult.ok ? "admin-banner-success" : "admin-banner-error"}`} role="status">
                    <strong>Provider:</strong> {testResult.provider}&nbsp;
                    <strong>Model:</strong> {testResult.model}&nbsp;
                    <strong>Latency:</strong> {testResult.latencyMs}ms&nbsp;
                    <strong>Status:</strong> {testResult.ok ? "OK" : testResult.code}
                    {testResult.sample && (<><br /><small>{testResult.sample}</small></>)}
                    {testResult.message && (<><br /><small>{testResult.message}</small></>)}
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
