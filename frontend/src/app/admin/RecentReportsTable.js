"use client";

import Link from "next/link";
import { labelFor, relativeTime } from "./adminApi";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

export default function RecentReportsTable({ reports, loading, error, onRetry }) {
  return (
    <section className="admin-card" aria-labelledby="recent-reports-heading">
      <header className="admin-card-head">
        <div>
          <h2 id="recent-reports-heading">Recent reports</h2>
          <p>Latest submissions to the moderation queue.</p>
        </div>
        <Link className="admin-btn admin-btn-ghost" href="/admin/reports">
          Review
        </Link>
      </header>

      <div className="admin-card-body admin-card-body-flush">
        {loading ? (
          <div className="admin-card-pad"><Skeleton rows={4} /></div>
        ) : error ? (
          <div className="admin-card-pad"><ErrorState message={error} onRetry={onRetry} /></div>
        ) : reports.length === 0 ? (
          <div className="admin-card-pad">
            <EmptyState title="The queue is clear" message="No reports have been submitted." />
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td>
                      <span className="admin-badge admin-badge-muted">{labelFor("targetType", report.target_type)}</span>
                    </td>
                    <td>{labelFor("category", report.category)}</td>
                    <td>
                      <span className={`admin-badge admin-badge-${report.status.toLowerCase()}`}>
                        {labelFor("reportStatus", report.status)}
                      </span>
                    </td>
                    <td className="admin-muted">{relativeTime(report.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
