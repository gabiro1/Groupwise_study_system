"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, displayName, formatDateTime } from "../adminApi";
import PageHeading from "../PageHeading";
import { EmptyState, Skeleton } from "../DataState";

export default function ProfileView() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiRequest("auth/me");
      setUser(result?.user ?? null);
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

  return (
    <>
      <PageHeading title="Admin Profile" subtitle="Your administrator account details." />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}

      {loading ? (
        <div className="admin-card-pad"><Skeleton rows={4} /></div>
      ) : !user ? (
        <div className="admin-card-pad">
          <EmptyState title="No profile available" message="Could not load your account details." />
        </div>
      ) : (
        <section className="admin-card">
          <div className="admin-card-body admin-card-body-flush">
            <div className="admin-profile-header">
              <span className="admin-avatar" aria-hidden="true">
                {user.firstName?.[0] ?? ""}{user.lastName?.[0] ?? ""}
              </span>
              <div>
                <strong>{displayName(user)}</strong>
                <span className="admin-badge admin-badge-admin">Administrator</span>
              </div>
            </div>
            <div className="admin-setting-list">
              <div className="admin-setting-row">
                <div className="admin-setting-copy">
                  <strong>Email</strong>
                  <small>Your sign-in email address.</small>
                </div>
                <span className="admin-muted">{user.email}</span>
              </div>
              <div className="admin-setting-row">
                <div className="admin-setting-copy">
                  <strong>Role</strong>
                  <small>Your application role.</small>
                </div>
                <span className="admin-muted">{user.role}</span>
              </div>
              <div className="admin-setting-row">
                <div className="admin-setting-copy">
                  <strong>Status</strong>
                  <small>Your account status.</small>
                </div>
                <span className={`admin-badge admin-badge-${user.status.toLowerCase()}`}>
                  {user.status}
                </span>
              </div>
              <div className="admin-setting-row">
                <div className="admin-setting-copy">
                  <strong>Member since</strong>
                  <small>When your account was created.</small>
                </div>
                <span className="admin-muted">{user.createdAt ? formatDateTime(user.createdAt) : "—"}</span>
              </div>
              <div className="admin-setting-row">
                <div className="admin-setting-copy">
                  <strong>Last login</strong>
                  <small>Your most recent sign-in.</small>
                </div>
                <span className="admin-muted">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never"}</span>
              </div>
              <div className="admin-setting-row">
                <div className="admin-setting-copy">
                  <strong>Email verified</strong>
                  <small>Whether your email address has been verified.</small>
                </div>
                <span className={`admin-badge ${user.emailVerified ? "admin-badge-active" : "admin-badge-muted"}`}>
                  {user.emailVerified ? "Yes" : "No"}
                </span>
              </div>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
