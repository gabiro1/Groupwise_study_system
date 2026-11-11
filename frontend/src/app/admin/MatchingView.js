"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, relativeTime } from "./adminApi";
import PageHeading from "./PageHeading";
import { CHART_COLORS, LineChart } from "./Charts";
import { ErrorState, Skeleton } from "./DataState";

const RANGES = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

function Stat({ label, value, hint }) {
  return (
    <div className="admin-count-card">
      <span className="admin-count-label">{label}</span>
      <strong className="admin-count-value">{value ?? "—"}</strong>
      {hint && <small className="admin-muted">{hint}</small>}
    </div>
  );
}

export default function MatchingView() {
  const [range, setRange] = useState(30);
  const [data, setData] = useState(null);
  const [modelStatus, setModelStatus] = useState(null);
  const [trainingRuns, setTrainingRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [modelVersion, setModelVersion] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async (nextRange) => {
    try {
      const [overview, status, history] = await Promise.all([
        apiRequest(`admin/overview?range=${nextRange}`),
        apiRequest("admin/recommendations/status"),
        apiRequest("admin/recommendations/training-runs?limit=10"),
      ]);
      setData(overview);
      setModelStatus(status);
      setTrainingRuns(history.runs || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [result, status, history] = await Promise.all([
          apiRequest(`admin/overview?range=${range}`),
          apiRequest("admin/recommendations/status"),
          apiRequest("admin/recommendations/training-runs?limit=10"),
        ]);
        if (active) {
          setData(result);
          setModelStatus(status);
          setTrainingRuns(history.runs || []);
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
  }, [range]);

  function changeRange(nextRange) {
    setLoading(true);
    setRange(nextRange);
  }

  async function runModelAction(action, body = {}) {
    setActionBusy(true);
    setActionError("");
    setActionMessage("");
    try {
      await apiRequest(action, { method: "POST", body: JSON.stringify(body) });
      setActionMessage("Recommendation model settings updated.");
      await load(range);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function togglePersonalization(event) {
    setActionBusy(true);
    setActionError("");
    setActionMessage("");
    try {
      await apiRequest("admin/recommendations/settings", {
        method: "PATCH",
        body: JSON.stringify({ personalizationEnabled: event.target.checked }),
      });
      setActionMessage("Personalization setting updated.");
      await load(range);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setActionBusy(false);
    }
  }

  const matching = data?.matching;
  const trend = matching?.acceptanceTrend;
  const readiness = modelStatus?.readiness;
  const activeVersion = modelStatus?.activeModelVersion || "weighted-v1.0.0";

  return (
    <>
      <PageHeading
        title="Matching analytics"
        subtitle="Recommendation volume, acceptance, and generation latency."
        updatedAt={data ? relativeTime(data.generatedAt) : null}
        onRefresh={() => load(range)}
        refreshing={loading}
        actions={
          <label className="admin-range">
            <span className="admin-sr-only">Select date range</span>
            <select value={range} onChange={(event) => changeRange(Number(event.target.value))}>
              {RANGES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        }
      />

      {error && !data ? (
        <ErrorState message={error} onRetry={() => load(range)} />
      ) : (
        <>
          <div className="admin-count-grid">
            <Stat label="Requests" value={matching?.requests} hint="recommendation requests in range" />
            <Stat label="Generated" value={matching?.generated} hint="recommendations produced" />
            <Stat label="Shown" value={matching?.shown} hint="recommendations displayed" />
            <Stat label="Accepted" value={matching?.accepted} hint="recommendations accepted" />
            <Stat
              label="Acceptance rate"
              value={matching?.acceptanceRate == null ? "—" : `${matching.acceptanceRate}%`}
              hint="accepted ÷ shown"
            />
            <Stat
              label="Average latency"
              value={matching?.avgLatencyMs == null ? "—" : `${matching.avgLatencyMs} ms`}
              hint="request to generation"
            />
          </div>

          <div className="admin-grid admin-grid-two">
            <section className="admin-card">
              <header className="admin-card-head">
                <div>
                  <h2>Acceptance rate</h2>
                  <p>Percentage of shown recommendations accepted each day.</p>
                </div>
              </header>
              <div className="admin-card-body">
                {loading && !data ? (
                  <Skeleton rows={4} />
                ) : trend?.labels?.length ? (
                  <LineChart
                    labels={trend.labels}
                    ariaLabel="Daily acceptance rate"
                    series={[{ label: "Acceptance rate (%)", color: CHART_COLORS.teal, values: trend.rate }]}
                  />
                ) : (
                  <p className="admin-chart-empty">No acceptance data in this period yet.</p>
                )}
              </div>
            </section>

            <section className="admin-card">
              <header className="admin-card-head">
                <div>
                  <h2>Shown vs accepted</h2>
                  <p>Daily recommendation volume and how many were accepted.</p>
                </div>
              </header>
              <div className="admin-card-body">
                {loading && !data ? (
                  <Skeleton rows={4} />
                ) : trend?.labels?.length ? (
                  <LineChart
                    labels={trend.labels}
                    ariaLabel="Recommendations shown and accepted"
                    series={[
                      { label: "Shown", color: CHART_COLORS.blue, values: trend.shown },
                      { label: "Accepted", color: CHART_COLORS.green, values: trend.accepted },
                    ]}
                  />
                ) : (
                  <p className="admin-chart-empty">No recommendations in this period yet.</p>
                )}
              </div>
            </section>
          </div>

          <section className="admin-card" aria-labelledby="model-status-heading">
            <header className="admin-card-head">
              <div>
                <h2 id="model-status-heading">Recommendation model operations</h2>
                <p>Training is separate from activation. Weighted scoring remains the safe fallback.</p>
              </div>
            </header>
            <div className="admin-card-body">
              <div className="admin-count-grid">
                <Stat label="Active algorithm" value={modelStatus?.algorithm} />
                <Stat label="Active version" value={activeVersion} />
                <Stat label="Training readiness" value={readiness?.ready ? "Ready" : "Not enough real data"} hint={readiness?.counts ? `${readiness.counts.labelledRows || 0} labelled rows` : undefined} />
                <Stat label="Model service" value={modelStatus?.modelService?.status || "—"} hint={`${modelStatus?.fallbackCount30d || 0} fallbacks in 30 days`} />
              </div>
              {readiness?.reason && <p className="admin-muted">{readiness.reason}</p>}
              {actionError && <p className="feature-error" role="alert">{actionError}</p>}
              {actionMessage && <p className="feature-success" role="status">{actionMessage}</p>}
              <div className="admin-form-row" style={{ alignItems: "end", flexWrap: "wrap", gap: "0.75rem" }}>
                <label>
                  <span className="admin-count-label">Model version</span>
                  <input value={modelVersion} onChange={(event) => setModelVersion(event.target.value)} placeholder="ltr-v1.0.0" />
                </label>
                <button className="admin-btn admin-btn-secondary" type="button" disabled={actionBusy || !modelVersion} onClick={() => runModelAction("admin/recommendations/training-runs", { modelVersion, datasetKind: "REAL" })}>Request export</button>
                <button className="admin-btn admin-btn-primary" type="button" disabled={actionBusy || !modelVersion} onClick={() => runModelAction(`admin/recommendations/models/${encodeURIComponent(modelVersion)}/activate`)}>Activate validated model</button>
                <button className="admin-btn admin-btn-ghost" type="button" disabled={actionBusy || !modelVersion} onClick={() => runModelAction(`admin/recommendations/models/${encodeURIComponent(modelVersion)}/deactivate`)}>Restore weighted baseline</button>
                <button className="admin-btn admin-btn-ghost" type="button" disabled={actionBusy} onClick={() => runModelAction("admin/recommendations/model-service/reset")}>Reset service circuit</button>
                <label className="admin-toggle">
                  <input type="checkbox" checked={Boolean(modelStatus?.runtime?.personalizationEnabled)} onChange={togglePersonalization} disabled={actionBusy} />
                  <span>Enable bounded personalization</span>
                </label>
              </div>
              <h3>Training history</h3>
              {trainingRuns.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead><tr><th>Version</th><th>Status</th><th>Rows</th><th>Positive</th><th>Negative</th><th>Created</th></tr></thead>
                    <tbody>{trainingRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{run.version}</td>
                        <td>{run.status}</td>
                        <td>{run.row_count ?? 0}</td>
                        <td>{run.positive_label_count ?? 0}</td>
                        <td>{run.negative_label_count ?? 0}</td>
                        <td>{run.created_at ? new Date(run.created_at).toLocaleString() : "—"}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : <p className="admin-chart-empty">No training runs yet.</p>}
            </div>
          </section>
        </>
      )}
    </>
  );
}
