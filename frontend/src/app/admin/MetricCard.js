"use client";

import Link from "next/link";
import { TrendDownIcon, TrendUpIcon } from "./AdminIcons";

/**
 * A single summary metric.
 *
 * The value is rendered exactly as supplied. When a metric is missing the card
 * shows an em dash rather than a zero, because "we have no data" and "the count
 * is zero" are different statements.
 */
export default function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "violet",
  href,
  loading = false,
  trend,
}) {
  const content = (
    <>
      <span className={`admin-metric-icon admin-tone-${tone}`} aria-hidden="true">
        {Icon && <Icon size={18} />}
      </span>
      <div className="admin-metric-body">
        <span className="admin-metric-label">{label}</span>
        {loading ? (
          <span className="admin-metric-value admin-metric-skeleton" aria-hidden="true" />
        ) : (
          <span className="admin-metric-value">{value ?? "—"}</span>
        )}
        <span className="admin-metric-foot">
          {trend && (
            <span className={`admin-trend admin-trend-${trend.direction}`}>
              {trend.direction === "up" ? <TrendUpIcon size={13} /> : <TrendDownIcon size={13} />}
              {trend.value}
            </span>
          )}
          {hint && <span className="admin-metric-hint">{hint}</span>}
        </span>
      </div>
    </>
  );

  if (href) {
    return (
      <Link className="admin-metric admin-metric-link" href={href}>
        {content}
      </Link>
    );
  }

  return <div className="admin-metric">{content}</div>;
}
