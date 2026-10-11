"use client";

import Link from "next/link";
import { labelFor } from "./adminApi";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

export default function TopStudyGroupsTable({ groups, loading, error, onRetry }) {
  return (
    <section className="admin-card" aria-labelledby="top-groups-heading">
      <header className="admin-card-head">
        <div>
          <h2 id="top-groups-heading">Top study groups</h2>
          <p>Most populated active groups.</p>
        </div>
        <Link className="admin-btn admin-btn-ghost" href="/admin/groups">
          View all
        </Link>
      </header>

      <div className="admin-card-body admin-card-body-flush">
        {loading ? (
          <div className="admin-card-pad"><Skeleton rows={5} /></div>
        ) : error ? (
          <div className="admin-card-pad"><ErrorState message={error} onRetry={onRetry} /></div>
        ) : groups.length === 0 ? (
          <div className="admin-card-pad">
            <EmptyState title="No study groups yet" message="Groups will appear here once students create them." />
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Course</th>
                  <th>Members</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const percent = group.max_size ? Math.min(100, Math.round((group.member_count / group.max_size) * 100)) : 0;
                  return (
                    <tr key={group.id}>
                      <td>
                        <Link className="admin-table-link" href={`/admin/groups?q=${encodeURIComponent(group.name)}`}>
                          {group.name}
                        </Link>
                      </td>
                      <td>
                        <code className="admin-code">{group.course_code}</code>
                      </td>
                      <td>
                        <div className="admin-capacity">
                          <span>
                            {group.member_count}
                            <small>/{group.max_size}</small>
                          </span>
                          <span className="admin-capacity-bar" aria-hidden="true">
                            <span style={{ width: `${percent}%` }} />
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`admin-badge admin-badge-${group.status.toLowerCase()}`}>
                          {labelFor("groupStatus", group.status)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
