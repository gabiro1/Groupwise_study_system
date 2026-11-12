"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { normalizeNotificationLink } from "./notificationLinks";

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
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t load your notifications.");
  return result.data;
}

function formatNotificationDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function NotificationDropdown({ open, sessionId, onUnreadChange }) {
  const [notifications, setNotifications] = useState([]);
  const [loadedSession, setLoadedSession] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorState, setErrorState] = useState({ sessionId: 0, message: "" });
  const loading = open && loadedSession !== sessionId;
  const error = errorState.sessionId === sessionId ? errorState.message : "";

  useEffect(() => {
    if (!open) return undefined;

    let active = true;

    Promise.all([
      apiRequest("notifications?limit=50"),
      apiRequest("notifications/unread-count"),
    ])
      .then(([list, unread]) => {
        if (!active) return;
        setNotifications(list.notifications || []);
        onUnreadChange?.(unread.unreadCount || 0);
        setLoadedSession(sessionId);
      })
      .catch((requestError) => {
        if (!active) return;
        setErrorState({ sessionId, message: requestError.message });
        setLoadedSession(sessionId);
      });

    return () => { active = false; };
  }, [open, sessionId, onUnreadChange]);

  async function markRead(id) {
    setErrorState({ sessionId, message: "" });
    try {
      await apiRequest(`notifications/${id}/read`, { method: "POST", body: "{}" });
      setNotifications((current) => current.map((item) => (
        item.id === id ? { ...item, read_at: new Date().toISOString() } : item
      )));
      onUnreadChange?.((count) => Math.max(0, count - 1));
    } catch (requestError) {
      setErrorState({ sessionId, message: requestError.message });
    }
  }

  async function markAllRead() {
    if (notifications.every((item) => item.read_at)) return;
    setBusy(true);
    setErrorState({ sessionId, message: "" });
    try {
      await apiRequest("notifications/read-all", { method: "POST", body: "{}" });
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at || readAt })));
      onUnreadChange?.(0);
    } catch (requestError) {
      setErrorState({ sessionId, message: requestError.message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="notification-dropdown" role="dialog" aria-label="Notifications">
      <div className="notification-dropdown-header">
        <div>
          <span className="section-overline">YOUR ACTIVITY</span>
          <h2>Notifications</h2>
        </div>
        <button
          className="text-link-button"
          type="button"
          onClick={markAllRead}
          disabled={busy || loading || notifications.length === 0 || notifications.every((item) => item.read_at)}
        >
          Mark all read
        </button>
      </div>

      {error && <p className="notification-dropdown-error" role="alert">{error}</p>}
      {loading && <p className="notification-dropdown-status" role="status">Loading notifications…</p>}
      {!loading && !error && notifications.length === 0 && (
        <p className="notification-dropdown-status">You’re all caught up.</p>
      )}
      {!loading && notifications.length > 0 && (
        <div className="notification-dropdown-list">
          {notifications.map((item) => {
            const safeLink = normalizeNotificationLink(item);
            const content = (
              <>
                <strong>{item.title}</strong>
                {item.body && <span>{item.body}</span>}
                <small>{formatNotificationDate(item.created_at)}</small>
              </>
            );

            return (
              <article className={`notification-dropdown-item ${item.read_at ? "" : "unread"}`} key={item.id}>
                <span className="notification-indicator" aria-hidden="true" />
                <div className="notification-dropdown-copy">
                  {safeLink ? <Link href={safeLink}>{content}</Link> : <div className="notification-details">{content}</div>}
                  {!item.read_at && (
                    <button type="button" onClick={() => markRead(item.id)}>Mark read</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

    </div>
  );
}
