"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

async function apiRequest(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t update notifications.");
  return result.data;
}

export default function NotificationsInbox({ onUnreadChange }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
        apiRequest("notifications?limit=30"),
        apiRequest("notifications/unread-count"),
      ])
      .then(([list, unread]) => {
        if (!active) return;
        setNotifications(list.notifications || []);
        onUnreadChange?.(unread.unreadCount || 0);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [onUnreadChange]);

  async function markRead(id) {
    setError("");
    try {
      await apiRequest(`notifications/${id}/read`, { method: "POST", body: "{}" });
      setNotifications((current) => current.map((item) => item.id === id ? { ...item, read_at: new Date().toISOString() } : item));
      onUnreadChange?.((count) => Math.max(0, count - 1));
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function markAllRead() {
    setBusy(true);
    setError("");
    try {
      await apiRequest("notifications/read-all", { method: "POST", body: "{}" });
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at || readAt })));
      onUnreadChange?.(0);
      setMessage("All notifications marked as read.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section-page">
      <div className="section-page-heading">
        <span className="section-overline">STAY IN THE LOOP</span>
        <h1>Notifications</h1>
        <p>Group updates, invitations, and reminders from your study community.</p>
      </div>
      {error && <div className="feature-error" role="alert">{error}</div>}
      {message && <div className="feature-success" role="status">{message}</div>}
      <section className="panel section-panel">
        <div className="section-heading">
          <div><span className="section-overline">YOUR ACTIVITY</span><h2>Recent notifications</h2></div>
          <button className="text-link-button" type="button" onClick={markAllRead} disabled={busy || notifications.every((item) => item.read_at)}>Mark all read</button>
        </div>
        {loading && <p className="empty-state" role="status">Loading notifications…</p>}
        {!loading && notifications.length === 0 && <p className="empty-state">You’re all caught up. New group activity will appear here.</p>}
        <div className="notification-list">
          {notifications.map((item) => {
            const content = <div className="notification-details"><strong>{item.title}</strong>{item.body && <span>{item.body}</span>}<small>{new Date(item.created_at).toLocaleString()}</small></div>;
            const safeLink = typeof item.link === "string" && item.link.startsWith("/dashboard/") ? item.link : "";
            return (
              <article className={`notification-item ${item.read_at ? "" : "unread"}`} key={item.id}>
                <span className="notification-indicator" aria-hidden="true" />
                <div className="notification-copy">
                  {safeLink ? <Link href={safeLink}>{content}</Link> : content}
                  {!item.read_at && <button type="button" onClick={() => markRead(item.id)}>Mark read</button>}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}
