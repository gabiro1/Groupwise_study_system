"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, displayName, formatDateTime, labelFor } from "../adminApi";
import PageHeading from "../PageHeading";
import { CheckIcon, ShieldIcon, SettingsIcon, UserCheckIcon } from "../AdminIcons";
import { EmptyState, Skeleton } from "../DataState";

const tabs = [
  {
    id: "profile",
    label: "Profile",
    description: "Personal details and identity",
    icon: UserCheckIcon,
  },
  {
    id: "security",
    label: "Account & security",
    description: "Access and verification status",
    icon: ShieldIcon,
  },
];

function initialsFor(user) {
  const initials = `${user?.firstName?.[0] || ""}${user?.lastName?.[0] || ""}`.trim();
  return initials.toUpperCase() || user?.email?.[0]?.toUpperCase() || "A";
}

export default function ProfileView() {
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "" });
  const [activeTabId, setActiveTabId] = useState("profile");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiRequest("auth/me");
      const nextUser = result?.user ?? null;
      setUser(nextUser);
      setForm({
        firstName: nextUser?.firstName || "",
        lastName: nextUser?.lastName || "",
        email: nextUser?.email || "",
      });
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function saveProfile(event) {
    event.preventDefault();
    if (!user) return;

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest(`admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
        }),
      });

      const updated = result?.user;
      setUser((current) => ({
        ...current,
        firstName: updated?.first_name ?? form.firstName.trim(),
        lastName: updated?.last_name ?? form.lastName.trim(),
        email: updated?.email ?? form.email.trim(),
        status: updated?.status ?? current.status,
        emailVerified: Boolean(updated?.email_verified_at),
      }));
      setForm((current) => ({
        ...current,
        firstName: updated?.first_name ?? current.firstName.trim(),
        lastName: updated?.last_name ?? current.lastName.trim(),
        email: updated?.email ?? current.email.trim(),
      }));
      setMessage(result?.emailChanged
        ? "Profile updated. Your new email address must be verified, and you will need to sign in again."
        : "Your profile details have been saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const ActiveIcon = activeTab.icon;

  return (
    <>
      <PageHeading
        title="Profile settings"
        subtitle="Manage the identity and access details for your administrator account."
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      {loading ? (
        <div className="admin-card admin-card-pad"><Skeleton rows={5} /></div>
      ) : !user ? (
        <div className="admin-card admin-card-pad">
          <EmptyState title="No profile available" message="Could not load your account details." />
        </div>
      ) : (
        <section className="admin-profile-settings">
          <aside className="admin-profile-nav-card">
            <div className="admin-profile-identity">
              <span className="admin-profile-avatar" aria-hidden="true">{initialsFor(user)}</span>
              <div className="admin-profile-identity-copy">
                <strong>{displayName(user)}</strong>
                <span>{user.email}</span>
                <span className="admin-badge admin-badge-admin">Administrator</span>
              </div>
            </div>

            <nav className="admin-profile-nav" aria-label="Profile settings sections">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const selected = activeTabId === tab.id;
                return (
                  <button
                    className={`admin-profile-nav-item${selected ? " active" : ""}`}
                    type="button"
                    key={tab.id}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => {
                      setActiveTabId(tab.id);
                      setError("");
                      setMessage("");
                    }}
                  >
                    <Icon size={17} />
                    <span>
                      <strong>{tab.label}</strong>
                      <small>{tab.description}</small>
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="admin-profile-nav-note">
              <SettingsIcon size={16} />
              <span>Profile changes are recorded in the administrator audit log.</span>
            </div>
          </aside>

          <div className="admin-profile-settings-content">
            <header className="admin-profile-section-heading">
              <div>
                <span className="admin-profile-overline">ACCOUNT SETTINGS</span>
                <h2>{activeTab.label}</h2>
                <p>{activeTab.description}. Keep your administrator identity current and secure.</p>
              </div>
              <ActiveIcon size={22} />
            </header>

            {activeTab.id === "profile" ? (
              <>
                <form className="admin-card admin-profile-edit-card" onSubmit={saveProfile}>
                  <div className="admin-card-head">
                    <div>
                      <h2>Personal details</h2>
                      <p>These details are used across the admin console and account emails.</p>
                    </div>
                    <span className="admin-badge admin-badge-active">Editable</span>
                  </div>
                  <div className="admin-profile-form-grid">
                    <label className="admin-field">
                      <span>First name</span>
                      <input
                        required
                        maxLength={80}
                        value={form.firstName}
                        onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))}
                      />
                    </label>
                    <label className="admin-field">
                      <span>Last name</span>
                      <input
                        required
                        maxLength={80}
                        value={form.lastName}
                        onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))}
                      />
                    </label>
                    <label className="admin-field admin-profile-field-wide">
                      <span>Sign-in email</span>
                      <input
                        required
                        type="email"
                        maxLength={254}
                        value={form.email}
                        onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="admin-profile-form-note">
                    <ShieldIcon size={16} />
                    <span>Changing your email resets verification and revokes active sessions for security.</span>
                  </div>
                  <div className="admin-profile-card-foot">
                    <span>Last updated details are reflected immediately.</span>
                    <button className="admin-btn admin-btn-primary" type="submit" disabled={saving}>
                      <CheckIcon size={15} />
                      {saving ? "Saving…" : "Save profile"}
                    </button>
                  </div>
                </form>

                <section className="admin-card admin-profile-overview-card">
                  <div className="admin-card-head">
                    <div>
                      <h2>Account overview</h2>
                      <p>Information managed by the platform.</p>
                    </div>
                  </div>
                  <div className="admin-profile-detail-grid">
                    <div className="admin-profile-detail">
                      <span>Role</span>
                      <strong>{labelFor("role", user.role)}</strong>
                      <small>Administrator permissions are controlled by the platform.</small>
                    </div>
                    <div className="admin-profile-detail">
                      <span>Status</span>
                      <strong><span className={`admin-badge admin-badge-${user.status.toLowerCase()}`}>{labelFor("status", user.status)}</span></strong>
                      <small>Current access state for this account.</small>
                    </div>
                    <div className="admin-profile-detail">
                      <span>Member since</span>
                      <strong>{user.createdAt ? formatDateTime(user.createdAt) : "—"}</strong>
                      <small>When your administrator account was created.</small>
                    </div>
                    <div className="admin-profile-detail">
                      <span>Last login</span>
                      <strong>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never"}</strong>
                      <small>Your most recent successful sign-in.</small>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <section className="admin-card admin-profile-overview-card">
                <div className="admin-card-head">
                  <div>
                    <h2>Access and verification</h2>
                    <p>Review the security state of your administrator account.</p>
                  </div>
                  <span className="admin-badge admin-badge-admin">Protected</span>
                </div>
                <div className="admin-profile-security-list">
                  <div className="admin-profile-security-row">
                    <span className="admin-profile-security-icon"><ShieldIcon size={17} /></span>
                    <div><strong>Administrator access</strong><small>Your account can manage users, groups, moderation, and platform settings.</small></div>
                    <span className="admin-badge admin-badge-admin">{labelFor("role", user.role)}</span>
                  </div>
                  <div className="admin-profile-security-row">
                    <span className="admin-profile-security-icon"><UserCheckIcon size={17} /></span>
                    <div><strong>Email verification</strong><small>Verification is required after changing your sign-in email.</small></div>
                    <span className={`admin-badge ${user.emailVerified ? "admin-badge-active" : "admin-badge-muted"}`}>
                      {user.emailVerified ? "Verified" : "Not verified"}
                    </span>
                  </div>
                  <div className="admin-profile-security-row">
                    <span className="admin-profile-security-icon"><SettingsIcon size={17} /></span>
                    <div><strong>Session protection</strong><small>Email changes, suspensions, and other sensitive actions revoke active sessions.</small></div>
                    <span className="admin-badge admin-badge-active">Enabled</span>
                  </div>
                </div>
              </section>
            )}
          </div>
        </section>
      )}
    </>
  );
}
