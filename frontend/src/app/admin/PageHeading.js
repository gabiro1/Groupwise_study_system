"use client";

import { RefreshIcon } from "./AdminIcons";

/**
 * Shared page header for every admin section.
 *
 * Keeping the “last updated” line driven by a real timestamp (passed in from the
 * fetch result) rather than a static string means it can never quietly claim the
 * data is fresher than it is.
 */
export default function PageHeading({ title, subtitle, updatedAt, onRefresh, refreshing, actions }) {
  return (
    <header className="admin-page-heading">
      <div className="admin-page-heading-text">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {updatedAt && (
          <span className="admin-page-heading-meta">
            Last updated {updatedAt}
          </span>
        )}
      </div>
      <div className="admin-page-heading-actions">
        {actions}
        {onRefresh && (
          <button
            type="button"
            className="admin-btn admin-btn-ghost"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh dashboard data"
          >
            <RefreshIcon size={15} className={refreshing ? "admin-spin" : undefined} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>
    </header>
  );
}
