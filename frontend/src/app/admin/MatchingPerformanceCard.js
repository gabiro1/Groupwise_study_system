"use client";

import Link from "next/link";
import { CHART_COLORS, LineChart } from "./Charts";
import { ErrorState, Skeleton } from "./DataState";

function Stat({ label, value, hint }) {
  return (
    <div className="admin-mini-stat">
      <span className="admin-mini-stat-label">{label}</span>
      <strong className="admin-mini-stat-value">{value ?? "—"}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function MatchingPerformanceCard({ matching, loading, error, onRetry }) {
  const trend = matching?.acceptanceTrend;
  const hasTrend = trend && trend.labels?.length > 0;

  return (
    <section className="admin-card" aria-labelledby="matching-heading">
      <header className="admin-card-head">
        <div>
          <h2 id="matching-heading">Matching engine performance</h2>
          <p>How recommendations are generated and accepted.</p>
        </div>
        <Link className="admin-btn admin-btn-ghost" href="/admin/matching">
          View details
        </Link>
      </header>

      <div className="admin-card-body">
        {loading ? (
          <Skeleton rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : (
          <>
            <div className="admin-mini-stats">
              <Stat label="Requests" value={matching.requests} />
              <Stat label="Generated" value={matching.generated} />
              <Stat label="Shown" value={matching.shown} />
              <Stat label="Accepted" value={matching.accepted} />
              <Stat
                label="Acceptance"
                value={matching.acceptanceRate == null ? "—" : `${matching.acceptanceRate}%`}
                hint={matching.acceptanceRate == null ? "no recommendations shown" : undefined}
              />
              <Stat
                label="Avg latency"
                value={matching.avgLatencyMs == null ? "—" : `${matching.avgLatencyMs} ms`}
                hint={matching.avgLatencyMs == null ? "not recorded" : undefined}
              />
            </div>

            {hasTrend ? (
              <LineChart
                height={200}
                labels={trend.labels}
                ariaLabel="Daily recommendation acceptance rate"
                series={[{ label: "Acceptance rate (%)", color: CHART_COLORS.teal, values: trend.rate }]}
              />
            ) : (
              <p className="admin-chart-empty">No acceptance data in this period yet.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
