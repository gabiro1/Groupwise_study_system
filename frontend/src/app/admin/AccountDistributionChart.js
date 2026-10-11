"use client";

import { labelFor } from "./adminApi";
import { DonutChart } from "./Charts";
import { ErrorState, Skeleton } from "./DataState";

const STATUS_COLORS = {
  ACTIVE: "#10B981",
  SUSPENDED: "#F43F5E",
  PENDING_VERIFICATION: "#F59E0B",
  DEACTIVATED: "#94A3B8",
};

export default function AccountDistributionChart({ distribution, loading, error, onRetry }) {
  const total = distribution?.total || 0;

  const slices = (distribution?.statuses || []).map((status) => ({
    key: status.key,
    label: labelFor("status", status.key),
    value: status.count,
    color: STATUS_COLORS[status.key] || "#94A3B8",
  }));

  return (
    <section className="admin-card" aria-labelledby="distribution-heading">
      <header className="admin-card-head">
        <div>
          <h2 id="distribution-heading">Account distribution</h2>
          <p>Registered accounts by status.</p>
        </div>
      </header>

      <div className="admin-card-body">
        {loading ? (
          <Skeleton rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : total === 0 ? (
          <p className="admin-chart-empty">No accounts to display yet.</p>
        ) : (
          <>
            <DonutChart
              data={slices}
              centerValue={total}
              centerLabel="accounts"
              ariaLabel="Registered accounts by status"
            />
            <ul className="admin-legend">
              {slices.map((slice) => (
                <li key={slice.key}>
                  <span className="admin-chart-swatch" style={{ background: slice.color }} aria-hidden="true" />
                  <span className="admin-legend-label">{slice.label}</span>
                  <span className="admin-legend-value">
                    {slice.value}
                    <small>{total > 0 ? `${Math.round((slice.value / total) * 100)}%` : "0%"}</small>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
