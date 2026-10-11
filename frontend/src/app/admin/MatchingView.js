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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (nextRange) => {
    try {
      const result = await apiRequest(`admin/overview?range=${nextRange}`);
      setData(result);
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
        const result = await apiRequest(`admin/overview?range=${range}`);
        if (active) {
          setData(result);
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

  const matching = data?.matching;
  const trend = matching?.acceptanceTrend;

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
        </>
      )}
    </>
  );
}
