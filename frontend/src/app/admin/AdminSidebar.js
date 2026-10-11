"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { apiRequest, displayName, initialsFor } from "./adminApi";
import {
  BookOpenIcon,
  CapIcon,
  ChartIcon,
  ChevronDownIcon,
  ClipboardIcon,
  DashboardIcon,
  LogoutIcon,
  NetworkIcon,
  SettingsIcon,
  ShieldIcon,
  UsersIcon,
} from "./AdminIcons";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: DashboardIcon, exact: true },
  { href: "/admin/users", label: "Users", icon: UsersIcon },
  { href: "/admin/academic", label: "Academic Data", icon: BookOpenIcon },
  { href: "/admin/groups", label: "Study Groups", icon: NetworkIcon },
  { href: "/admin/reports", label: "Reports & Moderation", icon: ShieldIcon },
  { href: "/admin/matching", label: "Matching Analytics", icon: ChartIcon },
  { href: "/admin/audit", label: "Audit Logs", icon: ClipboardIcon },
  { href: "/admin/settings", label: "Settings", icon: SettingsIcon },
];

export default function AdminSidebar({ user, system, onNavigate }) {
  const pathname = usePathname();
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const menuRef = useRef(null);

  useEffect(() => {
    function onDocumentClick(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setProfileOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setProfileOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function signOut() {
    setBusy(true);
    setSignOutError("");
    try {
      await apiRequest("auth/logout", { method: "POST", body: "{}" });
      window.location.replace("/login");
    } catch (error) {
      setSignOutError(error.message);
      setBusy(false);
    }
  }

  const isActive = (item) => (item.exact ? pathname === item.href : pathname.startsWith(item.href));

  const statusClass = system?.status === "online" ? "online" : system?.status === "degraded" ? "warn" : "unknown";
  const statusText = system
    ? system.status === "online"
      ? "System online"
      : system.status === "degraded"
        ? "Service degraded"
        : "Status unknown"
    : "Checking status…";

  return (
    <aside className="admin-sidebar" aria-label="Admin navigation">
      <Link className="admin-brand" href="/admin" onClick={onNavigate}>
        <span className="admin-brand-mark" aria-hidden="true">
          <CapIcon size={20} />
        </span>
        <span className="admin-brand-text">
          <strong>Lien</strong>
          <small>Study Together. Grow Together.</small>
        </span>
      </Link>

      <div className="admin-profile" ref={menuRef}>
        <button
          type="button"
          className="admin-profile-btn"
          aria-expanded={profileOpen}
          aria-haspopup="menu"
          onClick={() => setProfileOpen((open) => !open)}
        >
          <span className="admin-avatar" aria-hidden="true">{initialsFor(user)}</span>
          <span className="admin-profile-copy">
            <strong>{displayName(user)}</strong>
            <small>Administrator</small>
          </span>
          <ChevronDownIcon size={16} />
        </button>

        {profileOpen && (
          <div className="admin-profile-menu" role="menu">
            <Link href="/admin/settings" role="menuitem" onClick={onNavigate}>
              <SettingsIcon size={15} /> Account settings
            </Link>
            <button type="button" role="menuitem" onClick={signOut} disabled={busy}>
              <LogoutIcon size={15} /> {busy ? "Signing out…" : "Sign out"}
            </button>
            {signOutError && <p className="admin-profile-error" role="alert">{signOutError}</p>}
          </div>
        )}
      </div>

      <nav className="admin-nav" aria-label="Admin sections">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`admin-nav-link${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="admin-sidebar-foot">
        <span className={`admin-status admin-status-${statusClass}`}>
          <span className="admin-status-dot" aria-hidden="true" />
          {statusText}
        </span>
        <span className="admin-version">{system?.appName ? `${system.appName} API` : "Lien API"} · v1.0</span>
      </div>
    </aside>
  );
}
