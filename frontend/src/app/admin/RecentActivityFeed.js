"use client";

import Link from "next/link";
import { relativeTime } from "./adminApi";
import { EmptyState, ErrorState, Skeleton } from "./DataState";
import {
  AlertTriangleIcon,
  CalendarIcon,
  InboxIcon,
  NetworkIcon,
  UsersIcon,
} from "./AdminIcons";

const TYPES = {
  registration: { icon: UsersIcon, tone: "blue" },
  group: { icon: NetworkIcon, tone: "green" },
  session: { icon: CalendarIcon, tone: "orange" },
  report: { icon: AlertTriangleIcon, tone: "red" },
  join_request: { icon: InboxIcon, tone: "violet" },
};

export default function RecentActivityFeed({ items, loading, error, onRetry }) {
  return (
    <section className="admin-card" aria-labelledby="activity-feed-heading">
      <header className="admin-card-head">
        <div>
          <h2 id="activity-feed-heading">Recent activity</h2>
          <p>Latest events across the platform.</p>
        </div>
      </header>

      <div className="admin-card-body">
        {loading ? (
          <Skeleton rows={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : items.length === 0 ? (
          <EmptyState title="No recent activity" message="Events will appear here as students use Lien." />
        ) : (
          <ul className="admin-feed">
            {items.map((item, index) => {
              const meta = TYPES[item.type] || { icon: NetworkIcon, tone: "slate" };
              const Icon = meta.icon;
              const body = (
                <>
                  <span className={`admin-feed-icon admin-tone-${meta.tone}`} aria-hidden="true">
                    <Icon size={15} />
                  </span>
                  <span className="admin-feed-copy">
                    <strong>{item.title}</strong>
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                  <time className="admin-feed-time" dateTime={item.at || undefined}>
                    {relativeTime(item.at)}
                  </time>
                </>
              );
              return (
                <li key={`${item.type}-${item.at}-${index}`}>
                  {item.link ? (
                    <Link className="admin-feed-item" href={item.link}>
                      {body}
                    </Link>
                  ) : (
                    <div className="admin-feed-item">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
