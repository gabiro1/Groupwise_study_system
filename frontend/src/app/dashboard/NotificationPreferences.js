"use client";

import { useEffect, useState } from "react";

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
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t save your notification preferences.");
  return result.data;
}

export default function NotificationPreferences({ onNotice }) {
  const [preferences, setPreferences] = useState({ in_app_enabled: true, email_enabled: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest("notifications/preferences")
      .then((result) => {
        if (active) setPreferences(result.preferences || { in_app_enabled: true, email_enabled: true });
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => { active = false; };
  }, []);

  async function savePreferences(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await apiRequest("notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({
          inAppEnabled: Boolean(preferences.in_app_enabled),
          emailEnabled: Boolean(preferences.email_enabled),
        }),
      });
      setPreferences(saved.preferences);
      onNotice?.("Notification preferences saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel feature-form" onSubmit={savePreferences}>
      <h2>Delivery preferences</h2>
      <p className="feature-muted">Choose whether Lien keeps you posted in the app and by email.</p>
      {error && <div className="feature-error" role="alert">{error}</div>}
      <div className="feature-check-list">
        <label><input type="checkbox" checked={Boolean(preferences.in_app_enabled)} onChange={(event) => setPreferences({ ...preferences, in_app_enabled: event.target.checked })} />In-app notifications</label>
        <label><input type="checkbox" checked={Boolean(preferences.email_enabled)} onChange={(event) => setPreferences({ ...preferences, email_enabled: event.target.checked })} />Email notifications</label>
      </div>
      <button className="button button-primary" type="submit" disabled={busy}>Save delivery preferences</button>
    </form>
  );
}