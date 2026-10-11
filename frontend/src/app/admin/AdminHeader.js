"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ThemeToggle from "../ThemeToggle";
import { apiRequest, useDebouncedValue, relativeTime } from "./adminApi";
import { BellIcon, MenuIcon, SearchIcon } from "./AdminIcons";

/**
 * Admin top bar: global search, notifications, live clock, theme toggle.
 *
 * Search queries the server (debounced) rather than filtering a preloaded list,
 * because the admin surface can hold accounts than a single page should fetch.
 */
export default function AdminHeader({ onOpenNav }) {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [results, setResults] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);

  const [now, setNow] = useState("");
  const [notifications, setNotifications] = useState(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const notifRef = useRef(null);

  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest("notifications/unread-count")
      .then((result) => {
        if (active) setUnread(result.unreadCount || 0);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const term = debouncedQuery.trim();
    if (term.length < 2) return undefined;
    let active = true;
    apiRequest(`admin/search?q=${encodeURIComponent(term)}`)
      .then((result) => {
        if (active) setResults(result);
      })
      .catch(() => {
        if (active) setResults({ users: [], groups: [] });
      });
    return () => {
      active = false;
    };
  }, [debouncedQuery]);

  useEffect(() => {
    function onDocumentClick(event) {
      if (searchRef.current && !searchRef.current.contains(event.target)) setSearchOpen(false);
      if (notifRef.current && !notifRef.current.contains(event.target)) setNotifOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotifOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function toggleNotifications() {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next && notifications === null && !notificationsLoading) {
      setNotificationsLoading(true);
      try {
        const page = await apiRequest("notifications?limit=6");
        setNotifications(page.notifications || []);
      } catch {
        setNotifications([]);
      } finally {
        setNotificationsLoading(false);
      }
    }
  }

  async function markAllRead() {
    try {
      await apiRequest("notifications/read-all", { method: "POST", body: "{}" });
      setUnread(0);
      setNotifications((current) => (current || []).map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() })));
    } catch {
      /* leave the badge as-is if the call fails */
    }
  }

  function submitSearch(event) {
    event.preventDefault();
    const term = query.trim();
    if (term.length >= 2) {
      setSearchOpen(false);
      router.push(`/admin/users?q=${encodeURIComponent(term)}`);
    }
  }

  const term = debouncedQuery.trim();
  const showResults = searchOpen && term.length >= 2;

  return (
    <header className="admin-header">
      <button className="admin-icon-btn admin-menu-btn" type="button" aria-label="Open navigation" onClick={onOpenNav}>
        <MenuIcon size={20} />
      </button>

      <div className="admin-search" ref={searchRef}>
        <form role="search" onSubmit={submitSearch}>
          <SearchIcon size={17} className="admin-search-icon" />
          <input
            type="search"
            value={query}
            placeholder="Search users, groups, courses…"
            aria-label="Search users and study groups"
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
          />
        </form>

        {showResults && (
          <div className="admin-search-results">
            {results && results.users.length === 0 && results.groups.length === 0 && (
              <p className="admin-search-hint">No matches for “{term}”.</p>
            )}

            {results?.users?.length > 0 && (
              <div className="admin-search-group">
                <span>Users</span>
                {results.users.map((user) => (
                  <Link
                    key={user.id}
                    href={`/admin/users?q=${encodeURIComponent(user.email)}`}
                    onClick={() => setSearchOpen(false)}
                  >
                    <strong>{[user.first_name, user.last_name].filter(Boolean).join(" ") || user.email}</strong>
                    <small>
                      {user.email} · {user.role}
                    </small>
                  </Link>
                ))}
              </div>
            )}

            {results?.groups?.length > 0 && (
              <div className="admin-search-group">
                <span>Study groups</span>
                {results.groups.map((group) => (
                  <Link
                    key={group.id}
                    href={`/admin/groups?q=${encodeURIComponent(group.name)}`}
                    onClick={() => setSearchOpen(false)}
                  >
                    <strong>{group.name}</strong>
                    <small>
                      {group.course_code} · {group.status}
                    </small>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="admin-header-actions">
        <span className="admin-clock" aria-hidden="true">{now}</span>
        <ThemeToggle className="admin-theme-toggle" />

        <div className="admin-notif" ref={notifRef}>
          <button
            className="admin-icon-btn"
            type="button"
            aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
            aria-expanded={notifOpen}
            onClick={toggleNotifications}
          >
            <BellIcon size={19} />
            {unread > 0 && <span className="admin-notif-badge">{unread > 9 ? "9+" : unread}</span>}
          </button>

          {notifOpen && (
            <div className="admin-notif-menu">
              <div className="admin-notif-head">
                <strong>Notifications</strong>
                {unread > 0 && (
                  <button type="button" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
              </div>
              {notificationsLoading && <p className="admin-search-hint">Loading…</p>}
              {!notificationsLoading && notifications && notifications.length === 0 && (
                <p className="admin-search-hint">You&rsquo;re all caught up.</p>
              )}
              {!notificationsLoading &&
                notifications?.map((item) => (
                  <div className={`admin-notif-item${item.read_at ? "" : " is-unread"}`} key={item.id}>
                    <strong>{item.title}</strong>
                    {item.body && <p>{item.body}</p>}
                    <small>{relativeTime(item.created_at)}</small>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
