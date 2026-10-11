"use client";

import { CHART_COLORS, LineChart } from "./Charts";
import { ErrorState, Skeleton } from "./DataState";

const RANGES = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

export default function ActivityOverviewChart({ series, range, onRangeChange, loading, error, onRetry }) {
  return (
    <section className="admin-card" aria-labelledby="activity-heading">
      <header className="admin-card-head">
        <div>
          <h2 id="activity-heading">Platform activity overview</h2>
          <p>Student registrations, group creations, and scheduled sessions over time.</p>
        </div>
        <label className="admin-range">
          <span className="admin-sr-only">Select date range</span>
          <select value={range} onChange={(event) => onRangeChange(Number(event.target.value))}>
            {RANGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="admin-card-body">
        {loading ? (
          <Skeleton rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : (
          <LineChart
            labels={series.labels}
            ariaLabel={`Platform activity over the last ${range} days`}
            series={[
              { label: "Student registrations", color: CHART_COLORS.blue, values: series.registrations },
              { label: "Group creations", color: CHART_COLORS.green, values: series.groups },
              { label: "Study sessions", color: CHART_COLORS.orange, values: series.sessions },
            ]}
          />
        )}
      </div>
    </section>
  );
}
