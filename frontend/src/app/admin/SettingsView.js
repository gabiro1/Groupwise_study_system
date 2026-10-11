"use client";

import { useEffect, useState } from "react";
import { apiRequest, formatDateTime } from "./adminApi";
import PageHeading from "./PageHeading";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

export default function SettingsView() {
  const [settings, setSettings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [drafts, setDrafts] = useState({});
  const [busyKey, setBusyKey] = useState("");

  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("{}");
  const [newDescription, setNewDescription] = useState("");

  async function load() {
    try {
      const result = await apiRequest("admin/settings");
      setSettings(result.settings || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function reload() {
    setLoading(true);
    return load();
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await apiRequest("admin/settings");
        if (active) {
          setSettings(result.settings || []);
          setError("");
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function save(key, valueText, description) {
    let value;
    try {
      value = JSON.parse(valueText);
    } catch {
      setError(`“${key}” must be valid JSON.`);
      return;
    }
    setBusyKey(key);
    setError("");
    try {
      await apiRequest(`admin/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ key, value, description: description || "" }),
      });
      setMessage(`Saved “${key}”.`);
      setDrafts((current) => ({ ...current, [key]: undefined }));
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyKey("");
    }
  }

  function createSetting(event) {
    event.preventDefault();
    const key = newKey.trim();
    if (!key) {
      setError("Give the setting a key.");
      return;
    }
    save(key, newValue, newDescription.trim()).then(() => {
      setNewKey("");
      setNewValue("{}");
      setNewDescription("");
    });
  }

  const jsonFor = (setting) => JSON.stringify(setting.value ?? null, null, 2);

  return (
    <>
      <PageHeading
        title="Settings"
        subtitle="Key/value configuration stored in the database."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <header className="admin-card-head">
          <div>
            <h2>Add or update a setting</h2>
            <p>Values are stored as JSON. Existing keys are overwritten.</p>
          </div>
        </header>
        <form className="admin-card-body admin-setting-form" onSubmit={createSetting}>
          <label className="admin-field">
            <span>Key</span>
            <input value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder="feature.recommendations_enabled" maxLength={80} />
          </label>
          <label className="admin-field">
            <span>Description</span>
            <input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="What this setting controls" />
          </label>
          <label className="admin-field admin-field-wide">
            <span>Value (JSON)</span>
            <textarea rows={3} spellCheck="false" value={newValue} onChange={(event) => setNewValue(event.target.value)} />
          </label>
          <button className="admin-btn admin-btn-primary" type="submit" disabled={busyKey === newKey.trim()}>
            {busyKey === newKey.trim() ? "Saving…" : "Save setting"}
          </button>
        </form>
      </section>

      <section className="admin-card">
        <header className="admin-card-head">
          <div>
            <h2>Current settings</h2>
            <p>{settings.length} key{settings.length === 1 ? "" : "s"} defined.</p>
          </div>
        </header>
        <div className="admin-card-body">
          {loading ? (
            <Skeleton rows={4} />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : settings.length === 0 ? (
            <EmptyState title="No settings yet" message="Add a key above to create the first one." />
          ) : (
            <div className="admin-setting-list">
              {settings.map((setting) => (
                <article className="admin-setting-row" key={setting.key}>
                  <div className="admin-setting-copy">
                    <strong>{setting.key}</strong>
                    {setting.description && <small>{setting.description}</small>}
                    <small className="admin-muted">Updated {formatDateTime(setting.updated_at) || "—"}</small>
                  </div>
                  <textarea
                    aria-label={`Value for ${setting.key}`}
                    rows={3}
                    spellCheck="false"
                    value={drafts[setting.key] === undefined ? jsonFor(setting) : drafts[setting.key]}
                    onChange={(event) => setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))}
                  />
                  <button
                    className="admin-btn admin-btn-ghost"
                    type="button"
                    disabled={busyKey === setting.key || drafts[setting.key] === undefined}
                    onClick={() => save(setting.key, drafts[setting.key], setting.description)}
                  >
                    {busyKey === setting.key ? "Saving…" : "Save"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
