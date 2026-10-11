"use client";

import { RefreshIcon } from "./AdminIcons";

/** Loading placeholder shaped like a block of content. */
export function Skeleton({ rows = 3, className = "" }) {
  return (
    <div className={`admin-skeleton ${className}`.trim()} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <span key={index} className="admin-skeleton-line" style={{ width: `${100 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title = "Nothing here yet", message, icon: Icon }) {
  return (
    <div className="admin-empty">
      {Icon && (
        <span className="admin-empty-icon" aria-hidden="true">
          <Icon size={22} />
        </span>
      )}
      <strong>{title}</strong>
      {message && <p>{message}</p>}
    </div>
  );
}

export function ErrorState({ message = "Something went wrong loading this section.", onRetry }) {
  return (
    <div className="admin-error" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="admin-btn admin-btn-ghost" onClick={onRetry}>
          <RefreshIcon size={15} /> Try again
        </button>
      )}
    </div>
  );
}
