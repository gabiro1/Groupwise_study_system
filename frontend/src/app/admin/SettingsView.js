"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest, formatDateTime } from "./adminApi";
import BrandLogo from "../BrandLogo";
import {
  AlertTriangleIcon,
  BellIcon,
  ChartIcon,
  CheckIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  UserCheckIcon,
} from "./AdminIcons";
import { ErrorState, Skeleton } from "./DataState";

const SETTING_TABS = [
  {
    key: "registration.settings",
    label: "Registration",
    description: "Control who can create a student account.",
    navDescription: "Sign-up access",
    icon: UserCheckIcon,
  },
  {
    key: "maintenance.settings",
    label: "Maintenance",
    description: "Pause student access and show a clear status message.",
    navDescription: "Availability mode",
    icon: AlertTriangleIcon,
  },
  {
    key: "ai.runtime",
    label: "AI features",
    description: "Turn student-facing AI capabilities on or off safely.",
    navDescription: "Assistant and matching",
    icon: SparklesIcon,
  },
  {
    key: "notifications.settings",
    label: "Notifications",
    description: "Control platform-wide in-app notification delivery.",
    navDescription: "Platform alerts",
    icon: BellIcon,
  },
];

function cloneSettings(value) {
  return Object.fromEntries(
    Object.entries(value || {}).map(([key, entry]) => [
      key,
      entry && typeof entry === "object" ? JSON.parse(JSON.stringify(entry)) : entry,
    ]),
  );
}

function SettingToggle({ checked, onChange, label, description, disabled = false }) {
  return (
    <label className="admin-settings-toggle">
      <input type="checkbox" checked={Boolean(checked)} onChange={onChange} disabled={disabled} />
      <span className="admin-settings-toggle-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="admin-settings-switch" aria-hidden="true"><span /></span>
    </label>
  );
}

function SaveFooter({ saving, dirty, onSave, note = "Changes are applied immediately and recorded in the audit log." }) {
  return (
    <div className="admin-settings-form-foot">
      <span>{note}</span>
      <button className="admin-btn admin-btn-primary" type="submit" disabled={saving || !dirty} onClick={onSave}>
        <CheckIcon size={15} />
        {saving ? "Saving..." : dirty ? "Save changes" : "Saved"}
      </button>
    </div>
  );
}

function SectionCard({ title, description, badge, children }) {
  return (
    <section className="panel feature-form admin-settings-card">
      <header className="admin-settings-card-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {badge && <span className={`admin-badge ${badge.className || "admin-badge-muted"}`}>{badge.label}</span>}
      </header>
      {children}
    </section>
  );
}

function FormField({ label, hint, children, wide = false }) {
  return (
    <label className={`admin-settings-field${wide ? " admin-settings-field-wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function SettingsView() {
  const [sections, setSections] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [metadata, setMetadata] = useState([]);
  const [activeKey, setActiveKey] = useState(SETTING_TABS[0].key);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [domainInput, setDomainInput] = useState("");
  const [domainError, setDomainError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest("admin/settings/sections");
      const nextSections = result?.sections || {};
      setSections(nextSections);
      setDrafts(cloneSettings(nextSections));
      setMetadata(result?.metadata || []);
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

  const activeTab = SETTING_TABS.find((tab) => tab.key === activeKey) || SETTING_TABS[0];
  const activeDraft = drafts[activeKey] || {};
  const activeSaved = sections?.[activeKey] || {};
  const activeMeta = metadata.find((entry) => entry.key === activeKey);
  const dirty = JSON.stringify(activeDraft) !== JSON.stringify(activeSaved);
  const ActiveIcon = activeTab.icon;

  function updateDraft(key, patch) {
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] || {}), ...patch },
    }));
    setMessage("");
  }

  async function saveSection(key) {
    setSavingKey(key);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest(`admin/settings/sections/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify({ value: drafts[key] }),
      });
      const savedValue = result?.section?.value || drafts[key];
      setSections((current) => ({ ...current, [key]: savedValue }));
      setDrafts((current) => ({ ...current, [key]: JSON.parse(JSON.stringify(savedValue)) }));
      setMetadata((current) => {
        const existing = current.find((entry) => entry.key === key);
        const next = {
          ...(existing || {}),
          key,
          updatedAt: result?.section?.updated_at || new Date().toISOString(),
        };
        return [...current.filter((entry) => entry.key !== key), next];
      });
      const label = SETTING_TABS.find((tab) => tab.key === key)?.label || "Settings";
      setMessage(`${label} settings saved.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingKey("");
    }
  }

  function addDomain() {
    const domain = domainInput.trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      setDomainError("Use a domain such as student.university.edu.");
      return;
    }
    if ((activeDraft.allowedDomains || []).includes(domain)) {
      setDomainError("That domain is already on the list.");
      return;
    }
    if ((activeDraft.allowedDomains || []).length >= 20) {
      setDomainError("You can add up to 20 domains.");
      return;
    }
    updateDraft(activeKey, { allowedDomains: [...(activeDraft.allowedDomains || []), domain] });
    setDomainInput("");
    setDomainError("");
  }

  function removeDomain(domain) {
    updateDraft(activeKey, {
      allowedDomains: (activeDraft.allowedDomains || []).filter((entry) => entry !== domain),
    });
  }

  function renderRegistration() {
    return (
      <SectionCard
        title="Who can sign up"
        description="These controls affect the next registration attempt. Existing accounts are not changed."
        badge={{
          label: activeDraft.enabled === false ? "Closed" : "Open",
          className: activeDraft.enabled === false ? "admin-badge-suspended" : "admin-badge-active",
        }}
      >
        <div className="admin-settings-stack">
          <SettingToggle
            checked={activeDraft.enabled !== false}
            onChange={(event) => updateDraft(activeKey, { enabled: event.target.checked })}
            label="Allow new student accounts"
            description="Turn this off when registration should be invitation-only or temporarily paused."
          />
          <SettingToggle
            checked={Boolean(activeDraft.requireEmailVerification)}
            onChange={(event) => updateDraft(activeKey, { requireEmailVerification: event.target.checked })}
            label="Require email verification"
            description="New accounts stay pending until the student confirms their email address."
          />
        </div>

        <div className="admin-settings-field admin-settings-domain-field">
          <span>Approved university email domains</span>
          <small>Leave this empty to allow any email address. When populated, only these domains can register.</small>
          <div className="admin-settings-chip-list">
            {(activeDraft.allowedDomains || []).map((domain) => (
              <span className="admin-settings-chip" key={domain}>
                {domain}
                <button type="button" aria-label={`Remove ${domain}`} onClick={() => removeDomain(domain)}>x</button>
              </span>
            ))}
            {!activeDraft.allowedDomains?.length && <span className="admin-settings-empty-chip">Any email domain</span>}
          </div>
          <div className="admin-settings-domain-input">
            <input
              value={domainInput}
              maxLength={120}
              placeholder="student.university.edu"
              aria-label="University email domain"
              onChange={(event) => {
                setDomainInput(event.target.value);
                setDomainError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addDomain();
                }
              }}
            />
            <button className="admin-btn admin-btn-ghost" type="button" onClick={addDomain}>Add domain</button>
          </div>
          {domainError && <small className="admin-settings-inline-error" role="alert">{domainError}</small>}
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void saveSection(activeKey); }}>
          <SaveFooter saving={savingKey === activeKey} dirty={dirty} onSave={() => {}} />
        </form>
      </SectionCard>
    );
  }

  function renderMaintenance() {
    const enabled = Boolean(activeDraft.enabled);
    return (
      <SectionCard
        title="Maintenance mode"
        description="Keep the admin console available while the student-facing API shows a planned downtime message."
        badge={{
          label: enabled ? "Students paused" : "Available",
          className: enabled ? "admin-badge-pending" : "admin-badge-active",
        }}
      >
        <div className="admin-settings-stack">
          <SettingToggle
            checked={enabled}
            onChange={(event) => updateDraft(activeKey, { enabled: event.target.checked })}
            label="Enable maintenance mode"
            description="Student routes return a maintenance response; sign-in and this admin console remain reachable."
          />
          <FormField label="Message shown to students" hint="Keep it short and tell students when to try again.">
            <textarea
              rows={4}
              maxLength={500}
              value={activeDraft.message || ""}
              onChange={(event) => updateDraft(activeKey, { message: event.target.value })}
            />
          </FormField>
        </div>

        <div className={`admin-settings-preview${enabled ? " is-active" : ""}`}>
          <span className="admin-settings-preview-dot" aria-hidden="true" />
          <div>
            <strong>{enabled ? "Students will see this message" : "Maintenance mode is off"}</strong>
            <p>{activeDraft.message || "No maintenance message has been written yet."}</p>
          </div>
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void saveSection(activeKey); }}>
          <SaveFooter saving={savingKey === activeKey} dirty={dirty} onSave={() => {}} />
        </form>
      </SectionCard>
    );
  }

  function renderAiRuntime() {
    return (
      <>
        <SectionCard
          title="Student-facing AI"
          description="These switches take effect on the next AI request. Provider credentials stay encrypted and managed separately."
          badge={{ label: "Live controls", className: "admin-badge-admin" }}
        >
          <div className="admin-settings-stack">
            <SettingToggle
              checked={activeDraft.assistantEnabled !== false}
              onChange={(event) => updateDraft(activeKey, { assistantEnabled: event.target.checked })}
              label="Study assistant"
              description="Allow students to ask questions about their authorised study material."
            />
            <SettingToggle
              checked={activeDraft.matchingEnabled !== false}
              onChange={(event) => updateDraft(activeKey, { matchingEnabled: event.target.checked })}
              label="AI-assisted matching search"
              description="Allow natural-language matching requests. Deterministic scoring still decides compatibility."
            />
            <div className="admin-settings-grid">
              <FormField label="Provider timeout" hint="Milliseconds before an AI request is treated as failed.">
                <input
                  type="number"
                  min="1000"
                  max="120000"
                  step="1000"
                  value={activeDraft.timeoutMs ?? 25000}
                  onChange={(event) => updateDraft(activeKey, { timeoutMs: event.target.value })}
                />
              </FormField>
              <FormField label="Maximum provider attempts" hint="How many configured providers may be tried for one request.">
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={activeDraft.maxFailoverAttempts ?? 3}
                  onChange={(event) => updateDraft(activeKey, { maxFailoverAttempts: event.target.value })}
                />
              </FormField>
              <FormField label="Failure threshold" hint="Failures before a provider circuit temporarily opens.">
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={activeDraft.failureThreshold ?? 3}
                  onChange={(event) => updateDraft(activeKey, { failureThreshold: event.target.value })}
                />
              </FormField>
              <FormField label="Recovery cooldown" hint="Milliseconds before an opened provider is tried again.">
                <input
                  type="number"
                  min="1000"
                  max="3600000"
                  step="1000"
                  value={activeDraft.recoveryCooldownMs ?? 30000}
                  onChange={(event) => updateDraft(activeKey, { recoveryCooldownMs: event.target.value })}
                />
              </FormField>
            </div>
            <SettingToggle
              checked={activeDraft.fallbackEnabled !== false}
              onChange={(event) => updateDraft(activeKey, { fallbackEnabled: event.target.checked })}
              label="Allow provider failover"
              description="Move to the next eligible provider after a timeout or temporary upstream failure."
            />
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void saveSection(activeKey); }}>
            <SaveFooter saving={savingKey === activeKey} dirty={dirty} onSave={() => {}} />
          </form>
        </SectionCard>
        <div className="admin-settings-links" aria-label="Advanced AI settings">
          <Link href="/admin/ai" className="admin-settings-link-card">
            <span className="admin-settings-link-icon"><SparklesIcon size={17} /></span>
            <span><strong>Open AI management</strong><small>Manage providers, credentials, failover health, web research, and usage.</small></span>
            <ShieldIcon size={16} />
          </Link>
        </div>
      </>
    );
  }

  function renderNotifications() {
    const enabled = activeDraft.platformNotificationsEnabled !== false;
    return (
      <SectionCard
        title="Platform notifications"
        description="Choose whether TWIGANE creates in-app alerts for group, session, and moderation events."
        badge={{
          label: enabled ? "Delivering" : "Paused",
          className: enabled ? "admin-badge-active" : "admin-badge-suspended",
        }}
      >
        <div className="admin-settings-stack">
          <SettingToggle
            checked={enabled}
            onChange={(event) => updateDraft(activeKey, { platformNotificationsEnabled: event.target.checked })}
            label="Deliver in-app notifications"
            description="Student notification preferences still apply; this is the platform-wide safety switch."
          />
        </div>
        <div className="admin-settings-info">
          <BellIcon size={17} />
          <p>Email delivery is configured by the server environment. This page controls the notification records students see inside TWIGANE.</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void saveSection(activeKey); }}>
          <SaveFooter saving={savingKey === activeKey} dirty={dirty} onSave={() => {}} />
        </form>
      </SectionCard>
    );
  }

  function renderActiveSection() {
    if (!sections) return null;
    if (activeKey === "registration.settings") return renderRegistration();
    if (activeKey === "maintenance.settings") return renderMaintenance();
    if (activeKey === "ai.runtime") return renderAiRuntime();
    if (activeKey === "notifications.settings") return renderNotifications();
    return null;
  }

  return (
    <section className="section-page admin-settings-page">
      <header className="section-page-heading admin-settings-page-heading">
        <div>
          <span className="admin-profile-overline">PLATFORM SETTINGS</span>
          <h1>Settings</h1>
          <p>Manage the controls that shape the student experience.</p>
        </div>
        <div className="admin-settings-heading-actions">
          <div className="admin-settings-brand" aria-label="Mount Kigali University">
            <BrandLogo className="admin-settings-logo" title="Mount Kigali University" />
          </div>
          <button className="admin-btn admin-btn-ghost" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshIcon size={15} className={loading ? "admin-spin" : undefined} />
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      {loading && !sections ? (
        <div className="admin-settings-loading panel" aria-busy="true">
          <Skeleton rows={7} />
        </div>
      ) : !sections ? (
        <div className="admin-card admin-card-pad"><ErrorState message={error || "Settings could not be loaded."} onRetry={() => void load()} /></div>
      ) : (
        <div className="settings-layout admin-settings-layout">
          <nav className="settings-nav admin-settings-nav" aria-label="Platform settings sections">
            {SETTING_TABS.map((tab) => {
              const Icon = tab.icon;
              const selected = activeKey === tab.key;
              const value = drafts[tab.key] || {};
              const status = tab.key === "registration.settings"
                ? value.enabled === false ? "Closed" : "Open"
                : tab.key === "maintenance.settings"
                  ? value.enabled ? "Active" : "Off"
                  : tab.key === "notifications.settings"
                    ? value.platformNotificationsEnabled === false ? "Paused" : "On"
                    : "Available";
              return (
                <button
                  className={`settings-nav-item admin-settings-nav-item${selected ? " active" : ""}`}
                  type="button"
                  key={tab.key}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => {
                    setActiveKey(tab.key);
                    setDomainInput("");
                    setDomainError("");
                    setError("");
                    setMessage("");
                  }}
                >
                  <span className="admin-settings-nav-icon"><Icon size={17} /></span>
                  <span className="admin-settings-nav-copy">
                    <strong>{tab.label}</strong>
                    <small>{tab.navDescription}</small>
                  </span>
                  <span className="admin-settings-nav-status">{status}</span>
                </button>
              );
            })}
            <div className="admin-settings-nav-note">
              <SettingsIcon size={16} />
              <span>Every change is validated and audited before it is applied.</span>
            </div>
          </nav>

          <div className="settings-content admin-settings-content">
            <header className="settings-content-heading admin-settings-content-heading">
              <div className="admin-settings-content-title">
                <span className="admin-settings-content-icon"><ActiveIcon size={18} /></span>
                <div>
                  <h2>{activeTab.label}</h2>
                  <p>{activeTab.description}</p>
                  <small>
                    {activeMeta?.updatedAt
                      ? `Last changed ${formatDateTime(activeMeta.updatedAt)}`
                      : "Using the platform default until you save a change."}
                  </small>
                </div>
              </div>
            </header>
            {renderActiveSection()}
            <section className="admin-settings-advanced">
              <div>
                <span className="admin-profile-overline">ADVANCED OPERATIONS</span>
                <h3>Need deeper controls?</h3>
                <p>Provider credentials, recommendation analytics, and model operations live on dedicated pages so they stay understandable.</p>
              </div>
              <div className="admin-settings-advanced-links">
                <Link href="/admin/ai"><SparklesIcon size={15} /> AI management</Link>
                <Link href="/admin/matching"><ChartIcon size={15} /> Matching analytics</Link>
                <Link href="/admin/audit"><ShieldIcon size={15} /> Audit log</Link>
              </div>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
