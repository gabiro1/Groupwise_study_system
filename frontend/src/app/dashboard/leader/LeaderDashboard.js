"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import BrandLogo from "../../BrandLogo";
import ThemeToggle from "../../ThemeToggle";
import { SECTIONS } from "./sections";

async function apiRequest(path, options, retryUnauthorized = true) {
  let response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  if (response.status === 401 && retryUnauthorized && path !== "auth/me") {
    await apiRequest("auth/me", undefined, false);
    response = await fetch(`/api/${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        ...(options?.body ? { "content-type": "application/json" } : {}),
        ...options?.headers,
      },
    });
  }
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || "We could not complete that request.");
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return result.data;
}

function initialsOf(user) {
  const first = user?.firstName || user?.first_name || "";
  const last = user?.lastName || user?.last_name || "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || "?";
}

function displayNameOf(user) {
  return [user?.firstName || user?.first_name, user?.lastName || user?.last_name].filter(Boolean).join(" ") || "Student";
}

function memberName(member) {
  return [member.firstName || member.first_name, member.lastName || member.last_name].filter(Boolean).join(" ") || "Group member";
}

function formatDateTime(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatDate(value) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No activity yet" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

const MODE_LABELS = { ONLINE: "Online", PHYSICAL: "In person", EITHER: "Either" };
const PRIVACY_LABELS = { PUBLIC: "Public", REQUEST_REQUIRED: "Request to join", INVITE_ONLY: "Invite only" };
const ROLE_LABELS = { OWNER: "Owner", MODERATOR: "Moderator", MEMBER: "Member" };

function LeaderIcon({ name, size = 18, strokeWidth = 1.8 }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  const paths = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></>,
    inbox: <><path d="M4 4h16v6H4z" /><path d="M4 13h5l1.5 2.5h3L15 13h5" /><path d="M4 4v13l2 3h12l2-3V4" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6.3 6.3 2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8" /></>,
    chart: <><path d="M4 19V5M4 19h17" /><path d="M8 16v-5M12 16V8M16 16v-7" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
    back: <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
  };
  return <svg {...shared}>{paths[name] || paths.home}</svg>;
}

export default function LeaderDashboard({ initialSection = "overview", initialGroupId = null }) {
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [overview, setOverview] = useState({ groups: [], totals: {} });
  const [section, setSection] = useState(initialSection);
  const [activeGroupId, setActiveGroupId] = useState(initialGroupId || "");
  const [toast, setToast] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const groups = useMemo(() => overview.groups || [], [overview]);
  const totals = overview.totals || {};
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) || groups[0] || null,
    [groups, activeGroupId],
  );

  const reloadOverview = useCallback(async () => {
    const result = await apiRequest("study-groups/leader/overview");
    setOverview(result);
    return result;
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      let auth;
      try {
        auth = await apiRequest("auth/me");
      } catch (error) {
        if (!active) return;
        if (error.status === 401) {
          window.location.replace("/login?next=/dashboard/leader");
          return;
        }
        setLoadError(error.message);
        setLoading(false);
        return;
      }

      if (!active) return;
      if (auth.user?.role !== "STUDENT") {
        if (auth.user?.role === "ADMIN") {
          window.location.replace("/admin");
          return;
        }
        setLoadError("Your account is signed in, but it does not have student access to the leader dashboard.");
        setLoading(false);
        return;
      }
      setIdentity(auth.user);

      try {
        const result = await apiRequest("study-groups/leader/overview");
        if (!active) return;
        setOverview(result);
        setActiveGroupId((current) => current || result.groups?.[0]?.id || "");
        setLoading(false);
      } catch (error) {
        if (!active) return;
        setLoadError(error.message);
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const showToast = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }, []);

  const refreshAll = useCallback(async () => {
    await reloadOverview();
    setRefreshKey((key) => key + 1);
  }, [reloadOverview]);

  const navigate = useCallback((nextSection, groupId) => {
    if (groupId) setActiveGroupId(groupId);
    setSection(nextSection);
  }, []);

  if (loading) {
    return (
      <main className="app-shell">
        <div className="content-wrap leader-center">
          <p className="feature-muted">Loading your leadership dashboard…</p>
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="app-shell">
        <div className="content-wrap leader-center">
          <div className="panel leader-empty">
            <h1>We could not open the leader dashboard</h1>
            <p className="feature-muted">{loadError}</p>
            <Link className="button button-secondary" href="/dashboard">Back to the student dashboard</Link>
          </div>
        </div>
      </main>
    );
  }

  if (groups.length === 0) {
    return (
      <main className="app-shell">
        <div className="content-wrap leader-center">
          <div className="panel leader-empty">
            <span className="section-overline">GROUP LEADERSHIP</span>
            <h1>You are not leading a group yet</h1>
            <p className="feature-muted">
              Leading is a membership permission. When you own or moderate a study group, its tools appear here.
            </p>
            <div className="leader-empty-actions">
              <Link className="button button-primary" href="/dashboard/groups">View my groups</Link>
              <Link className="button button-secondary" href="/dashboard/discover">Discover groups</Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const sectionMeta = SECTIONS.find((item) => item.key === section) || SECTIONS[0];

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Leader navigation">
        <Link className="brand" href="/" aria-label="Lien home">
          <BrandLogo className="lien-logo" />
        </Link>

        <div className="sidebar-nav-group">
          <div className="sidebar-label">LEADERSHIP</div>
          <nav className="side-nav" aria-label="Leader sections">
            {SECTIONS.map((item) => {
              const count = item.badge ? totals[item.badge] : 0;
              return (
                <div className="leader-nav-row" key={item.key}>
                  <button
                    type="button"
                    className={`nav-link leader-nav-button ${section === item.key ? "active" : ""}`}
                    aria-current={section === item.key ? "page" : undefined}
                    onClick={() => setSection(item.key)}
                  >
                    <LeaderIcon name={item.icon} size={18} />
                    <span>{item.label}</span>
                    {count > 0 && <span className="leader-nav-badge">{count}</span>}
                  </button>
                </div>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-nav-group">
          <div className="sidebar-label">YOUR GROUPS</div>
          <div className="leader-group-list">
            {groups.map((group) => (
              <button
                type="button"
                key={group.id}
                className={`leader-group-item ${activeGroup?.id === group.id ? "active" : ""}`}
                onClick={() => setActiveGroupId(group.id)}
              >
                <span className="leader-group-name">{group.name}</span>
                <span className="leader-group-meta">
                  {ROLE_LABELS[group.my_role] || "Leader"} · {group.active_members} {group.active_members === 1 ? "member" : "members"}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-spacer" />
        <div className="leader-sidebar-foot">
          <Link className="nav-link" href="/dashboard">
            <LeaderIcon name="back" size={18} />
            <span>Student dashboard</span>
          </Link>
          <ThemeToggle />
        </div>
      </aside>

      <section className="main-panel">
        <nav className="leader-mobile-nav" aria-label="Leader sections">
          {SECTIONS.map((item) => {
            const count = item.badge ? totals[item.badge] : 0;
            return (
              <button
                key={item.key}
                type="button"
                className={`leader-mobile-tab ${section === item.key ? "active" : ""}`}
                aria-current={section === item.key ? "page" : undefined}
                onClick={() => setSection(item.key)}
              >
                <LeaderIcon name={item.icon} size={16} />
                <span>{item.label}</span>
                {count > 0 && <span className="leader-nav-badge">{count}</span>}
              </button>
            );
          })}
        </nav>
        <div className="content-wrap">
          <div className="section-page-heading leader-heading">
            <span className="section-overline">GROUP LEADERSHIP</span>
            <h1>{sectionMeta.label}</h1>
            <p>
              {activeGroup ? (
                <>
                  Managing <strong>{activeGroup.name}</strong> · {activeGroup.course_code ? `${activeGroup.course_code} · ` : ""}
                  {activeGroup.course_name}. You are the {ROLE_LABELS[activeGroup.my_role] || "leader"}.
                </>
              ) : "Managing your study groups."}
            </p>
            {groups.length > 1 && (
              <label className="leader-group-select-wrap">
                <span>Group</span>
                <select value={activeGroup?.id || ""} onChange={(event) => setActiveGroupId(event.target.value)}>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {section === "overview" && (
            <OverviewSection
              groups={groups}
              totals={totals}
              activeGroup={activeGroup}
              refreshKey={refreshKey}
              navigate={navigate}
            />
          )}
          {section === "requests" && (
            <RequestsSection activeGroup={activeGroup} showToast={showToast} onRefreshOverview={reloadOverview} refreshKey={refreshKey} />
          )}
          {section === "invitations" && (
            <InvitationsSection activeGroup={activeGroup} showToast={showToast} onRefreshOverview={reloadOverview} refreshKey={refreshKey} />
          )}
          {section === "members" && (
            <MembersSection activeGroup={activeGroup} identity={identity} showToast={showToast} onRefreshOverview={reloadOverview} refreshKey={refreshKey} />
          )}
          {section === "sessions" && (
            <SessionsSection activeGroup={activeGroup} showToast={showToast} refreshKey={refreshKey} />
          )}
          {section === "matching" && (
            <MatchingSection activeGroup={activeGroup} showToast={showToast} refreshKey={refreshKey} />
          )}
          {section === "analytics" && (
            <AnalyticsSection activeGroup={activeGroup} refreshKey={refreshKey} />
          )}
          {section === "settings" && (
            <SettingsSection
              activeGroup={activeGroup}
              identity={identity}
              showToast={showToast}
              onRefreshOverview={refreshAll}
              onArchived={() => setSection("overview")}
              refreshKey={refreshKey}
            />
          )}
        </div>
      </section>

      {toast && <div className="leader-toast" role="status">{toast}</div>}
    </main>
  );
}

function StatCard({ label, value, hint }) {
  return (
    <div className="leader-stat">
      <span className="leader-stat-value">{value}</span>
      <span className="leader-stat-label">{label}</span>
      {hint && <span className="leader-stat-hint">{hint}</span>}
    </div>
  );
}

function useSectionData(path, deps, refreshKey) {
  const [state, setState] = useState({ loading: true, error: "", data: null, path: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await apiRequest(path);
        if (active) setState({ loading: false, error: "", data, path });
      } catch (error) {
        if (active) setState({ loading: false, error: error.message, data: null, path });
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshKey, nonce, path]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  // While a new path is loading, the previous path's payload is stale. Hide it so
  // the UI never shows another group's data under this group's heading.
  const stale = state.path !== path;

  return {
    loading: stale || state.loading,
    error: stale ? "" : state.error,
    data: stale ? null : state.data,
    refresh,
  };
}

function OverviewSection({ groups, totals, activeGroup, navigate, refreshKey }) {
  const { loading, error, data } = useSectionData("study-groups/leader/sessions?limit=6&scope=upcoming", [], refreshKey);
  const sessions = data?.sessions || [];

  return (
    <div className="leader-stack">
      <div className="leader-stat-grid">
        <StatCard label="Groups you lead" value={totals.groups ?? groups.length} />
        <StatCard label="Active members" value={totals.activeMembers ?? 0} />
        <StatCard label="Pending requests" value={totals.pendingRequests ?? 0} hint="Awaiting your decision" />
        <StatCard label="Outstanding invitations" value={totals.pendingInvitations ?? 0} hint="Sent, not yet answered" />
        <StatCard label="Upcoming sessions" value={totals.upcomingSessions ?? 0} />
      </div>

      <div className="leader-two-col">
        <section className="panel leader-card">
          <div className="section-heading">
            <div><span className="section-overline">YOUR GROUPS</span><h2>Where attention is needed</h2></div>
          </div>
          <div className="leader-group-cards">
            {groups.map((group) => (
              <article key={group.id} className={`leader-group-card ${activeGroup?.id === group.id ? "active" : ""}`}>
                <div className="leader-group-card-head">
                  <h3>{group.name}</h3>
                  <span className="leader-badge">{ROLE_LABELS[group.my_role] || "Leader"}</span>
                </div>
                <p className="leader-muted">
                  {group.course_code ? `${group.course_code} · ` : ""}{group.course_name}
                </p>
                <div className="leader-mini-stats">
                  <span><strong>{group.active_members}</strong>/{group.max_size} members</span>
                  <span><strong>{group.pending_requests}</strong> requests</span>
                  <span><strong>{group.pending_invitations}</strong> invites</span>
                  <span><strong>{group.upcoming_sessions}</strong> sessions</span>
                </div>
                <div className="leader-actions">
                  <button type="button" className="button button-secondary" onClick={() => navigate("members", group.id)}>Members</button>
                  <button type="button" className="button button-secondary" onClick={() => navigate("requests", group.id)}>Requests</button>
                  <button type="button" className="button button-primary" onClick={() => navigate("analytics", group.id)}>Analytics</button>
                </div>
                <p className="leader-muted leader-tiny">Last activity {formatDate(group.last_activity_at)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel leader-card">
          <div className="section-heading">
            <div><span className="section-overline">UP NEXT</span><h2>Upcoming sessions</h2></div>
          </div>
          {loading && <p className="feature-muted">Loading sessions…</p>}
          {error && <p className="feature-error">{error}</p>}
          {!loading && !error && sessions.length === 0 && <p className="feature-muted">No sessions scheduled yet.</p>}
          <ul className="leader-list">
            {sessions.map((session) => (
              <li key={session.id} className="leader-list-row">
                <div>
                  <strong>{session.title}</strong>
                  <span className="leader-muted">{session.group_name} · {formatDateTime(session.starts_at)}</span>
                </div>
                <span className="leader-chip">{session.going_count}/{session.member_count} going</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function RequestsSection({ activeGroup, showToast, onRefreshOverview, refreshKey }) {
  const [scope, setScope] = useState("group");
  const path = scope === "all" ? "study-groups/leader/requests" : `study-groups/leader/requests?groupId=${activeGroup.id}`;
  const { loading, error, data } = useSectionData(path, [scope, activeGroup?.id], refreshKey);
  const [busyId, setBusyId] = useState("");
  const [notes, setNotes] = useState({});
  const [actionError, setActionError] = useState("");
  const requests = data?.requests || [];

  async function decide(request, decision) {
    setBusyId(request.id);
    setActionError("");
    try {
      await apiRequest(`study-groups/${request.group_id}/requests/${request.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, note: notes[request.id]?.trim() || null }),
      });
      showToast(decision === "APPROVE" ? `${memberName(request)} joined the group.` : "Request declined.");
      await onRefreshOverview();
      setBusyId("");
    } catch (error) {
      setActionError(error.message);
      setBusyId("");
    }
  }

  return (
    <section className="panel leader-card">
      <div className="section-heading leader-split">
        <div><span className="section-overline">REQUESTS TO JOIN</span><h2>Approve or decline <span className="heading-count">{requests.length}</span></h2></div>
        <div className="leader-tabs">
          <button type="button" className={scope === "group" ? "active" : ""} onClick={() => setScope("group")}>This group</button>
          <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All my groups</button>
        </div>
      </div>
      {actionError && <p className="feature-error">{actionError}</p>}
      {loading && <p className="feature-muted">Loading requests…</p>}
      {error && <p className="feature-error">{error}</p>}
      {!loading && !error && requests.length === 0 && (
        <p className="feature-muted">No pending requests. New requests appear here the moment a student asks to join.</p>
      )}
      <ul className="leader-list">
        {requests.map((request) => (
          <li key={request.id} className="leader-request-row">
            <div className="leader-request-main">
              <div className="leader-request-head">
                <strong>{memberName(request)}</strong>
                {scope === "all" && <span className="leader-chip">{request.group_name}</span>}
                {request.compatibility_score != null && (
                  <span className="leader-chip">Match {Math.round(request.compatibility_score)}%</span>
                )}
              </div>
              <p className="leader-muted">
                {request.course_code ? `${request.course_code} · ` : ""}
                {request.year_of_study ? `Year ${request.year_of_study} · ` : ""}
                Requested {formatDate(request.created_at)}
              </p>
              {request.message && <p className="leader-quote">“{request.message}”</p>}
              <label className="leader-note-field">
                <span>Note (optional)</span>
                <input
                  type="text"
                  maxLength={500}
                  value={notes[request.id] || ""}
                  onChange={(event) => setNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                  placeholder="Add context for the decision"
                />
              </label>
            </div>
            <div className="leader-actions">
              <button type="button" className="button button-primary" disabled={busyId === request.id} onClick={() => decide(request, "APPROVE")}>Approve</button>
              <button type="button" className="button button-secondary" disabled={busyId === request.id} onClick={() => decide(request, "REJECT")}>Decline</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InvitationsSection({ activeGroup, showToast, onRefreshOverview, refreshKey }) {
  const [scope, setScope] = useState("group");
  const path = scope === "all" ? "study-groups/leader/invitations" : `study-groups/leader/invitations?groupId=${activeGroup.id}`;
  const { loading, error, data } = useSectionData(path, [scope, activeGroup?.id], refreshKey);
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  const invitations = data?.invitations || [];

  async function cancel(invitation) {
    setBusyId(invitation.id);
    setActionError("");
    try {
      await apiRequest(`study-groups/${invitation.group_id}/invitations/${invitation.id}/cancel`, { method: "POST" });
      showToast(`Invitation to ${memberName(invitation)} withdrawn.`);
      await onRefreshOverview();
      setBusyId("");
    } catch (error) {
      setActionError(error.message);
      setBusyId("");
    }
  }

  return (
    <section className="panel leader-card">
      <div className="section-heading leader-split">
        <div><span className="section-overline">SENT INVITATIONS</span><h2>Pending invitations <span className="heading-count">{invitations.length}</span></h2></div>
        <div className="leader-tabs">
          <button type="button" className={scope === "group" ? "active" : ""} onClick={() => setScope("group")}>This group</button>
          <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All my groups</button>
        </div>
      </div>
      {actionError && <p className="feature-error">{actionError}</p>}
      {loading && <p className="feature-muted">Loading invitations…</p>}
      {error && <p className="feature-error">{error}</p>}
      {!loading && !error && invitations.length === 0 && (
        <p className="feature-muted">No invitations are waiting on an answer. Invite students from the Members or Matching tab.</p>
      )}
      <ul className="leader-list">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="leader-list-row">
            <div>
              <strong>{memberName(invitation)}</strong>
              <span className="leader-muted">
                {scope === "all" ? `${invitation.group_name} · ` : ""}
                Expires {formatDate(invitation.expires_at)}
                {invitation.compatibility_score != null ? ` · Match ${Math.round(invitation.compatibility_score)}%` : ""}
              </span>
              {invitation.message && <span className="leader-quote">“{invitation.message}”</span>}
            </div>
            <button type="button" className="button button-secondary" disabled={busyId === invitation.id} onClick={() => cancel(invitation)}>
              Withdraw
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MembersSection({ activeGroup, identity, showToast, onRefreshOverview, refreshKey }) {
  const detail = useSectionData(activeGroup ? `study-groups/${activeGroup.id}` : "study-groups/leader/overview", [activeGroup?.id], refreshKey);
  const group = detail.data?.group || null;
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [invitedIds, setInvitedIds] = useState([]);
  const [busyId, setBusyId] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const [actionError, setActionError] = useState("");
  const [transferId, setTransferId] = useState("");

  useEffect(() => {
    if (!activeGroup) return undefined;
    let active = true;
    const timeout = window.setTimeout(() => {
      setSearching(true);
      setSearchError("");
      const params = new URLSearchParams({ limit: "20", excludeGroupId: activeGroup.id });
      if (group?.courseId) params.set("courseId", group.courseId);
      if (query.trim()) params.set("q", query.trim());
      apiRequest(`students/search?${params.toString()}`)
        .then((result) => {
          if (active) {
            setCandidates(result.students || []);
            setSearching(false);
          }
        })
        .catch((error) => {
          if (active) {
            setSearchError(error.message);
            setSearching(false);
          }
        });
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [activeGroup, group?.courseId, query]);

  async function invite(candidateId) {
    setBusyId(candidateId);
    setActionError("");
    try {
      await apiRequest(`study-groups/${activeGroup.id}/invite`, {
        method: "POST",
        body: JSON.stringify({ inviteeId: candidateId, ignoreCompatibility: true }),
      });
      setInvitedIds((current) => [...current, candidateId]);
      showToast("Invitation sent.");
      await onRefreshOverview();
      setBusyId("");
    } catch (error) {
      setActionError(error.message);
      setBusyId("");
    }
  }

  async function manage(member, action) {
    setBusyId(member.id);
    setActionError("");
    try {
      await apiRequest(`study-groups/${activeGroup.id}/members/${member.id}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      showToast(action === "REMOVE" ? `${memberName(member)} removed.` : "Member updated.");
      setPendingAction(null);
      detail.refresh?.();
      await onRefreshOverview();
      setBusyId("");
    } catch (error) {
      setActionError(error.message);
      setBusyId("");
    }
  }

  async function transferOwner() {
    if (!transferId) return;
    setBusyId(transferId);
    setActionError("");
    try {
      await apiRequest(`study-groups/${activeGroup.id}/transfer-ownership`, {
        method: "POST",
        body: JSON.stringify({ newOwnerId: transferId }),
      });
      showToast("Ownership transferred.");
      await onRefreshOverview();
      setTransferId("");
      setBusyId("");
    } catch (error) {
      setActionError(error.message);
      setBusyId("");
    }
  }

  if (detail.loading) return <p className="feature-muted">Loading members…</p>;
  if (detail.error) return <p className="feature-error">{detail.error}</p>;
  const members = group?.members || [];
  const isOwner = group?.viewer?.role === "OWNER";

  return (
    <div className="leader-stack">
      {actionError && <p className="feature-error">{actionError}</p>}
      <section className="panel leader-card">
        <div className="section-heading">
          <div>
            <span className="section-overline">ROSTER</span>
            <h2>{group?.name} members <span className="heading-count">{members.length}</span></h2>
          </div>
          <span className="leader-chip">{members.length}/{group?.maxSize} places filled</span>
        </div>
        <ul className="leader-list">
          {members.map((member) => {
            const isSelf = memberIsSelf(member, identity?.id);
            return (
              <li key={member.id} className="leader-member-row">
                <div className="leader-member-main">
                  <strong>{memberName(member)}{isSelf ? " (you)" : ""}</strong>
                  <span className="leader-muted">
                    <span className="leader-badge">{ROLE_LABELS[member.role] || member.role}</span>{" "}
                    Joined {formatDate(member.joined_at)}
                  </span>
                </div>
                {member.role !== "OWNER" && (
                  <div className="leader-actions">
                    <button type="button" className="button button-secondary" disabled={busyId === member.id} onClick={() => manage(member, member.role === "MODERATOR" ? "DEMOTE" : "PROMOTE")}>
                      {member.role === "MODERATOR" ? "Demote" : "Promote"}
                    </button>
                    {pendingAction === member.id ? (
                      <>
                        <button type="button" className="button button-primary" disabled={busyId === member.id} onClick={() => manage(member, "REMOVE")}>Confirm remove</button>
                        <button type="button" className="button button-secondary" onClick={() => setPendingAction(null)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className="button button-secondary" onClick={() => setPendingAction(member.id)}>Remove</button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner && members.length > 1 && (
        <section className="panel leader-card">
          <div className="section-heading">
            <div><span className="section-overline">OWNERSHIP</span><h3>Transfer ownership</h3></div>
          </div>
          <p className="leader-muted">Hand the group to another member. You will become a regular member.</p>
          <div className="leader-inline-form">
            <select value={transferId} onChange={(event) => setTransferId(event.target.value)}>
              <option value="">Choose a member…</option>
              {members.filter((member) => member.role !== "OWNER").map((member) => (
                <option key={member.id} value={member.id}>{memberName(member)}</option>
              ))}
            </select>
            <button type="button" className="button button-secondary" disabled={!transferId || busyId === transferId} onClick={transferOwner}>Transfer</button>
          </div>
        </section>
      )}

      <section className="panel leader-card">
        <div className="section-heading">
          <div><span className="section-overline">GROW THE GROUP</span><h2>Invite students</h2></div>
          {group?.memberCount >= group?.maxSize && <span className="leader-chip">Group is full</span>}
        </div>
        <input
          className="leader-search"
          type="search"
          value={query}
          placeholder="Search by name"
          onChange={(event) => setQuery(event.target.value)}
        />
        {searchError && <p className="feature-error">{searchError}</p>}
        {searching && <p className="feature-muted">Searching…</p>}
        {!searching && candidates.length === 0 && !searchError && <p className="feature-muted">No matching students found.</p>}
        <ul className="leader-list">
          {candidates.filter((candidate) => !candidate.alreadyInGroup).map((candidate) => (
            <li key={candidate.id} className="leader-list-row">
              <div>
                <strong>{memberName(candidate)}</strong>
                <span className="leader-muted">
                  {candidate.compatibility?.score != null ? `Match ${Math.round(candidate.compatibility.score)}% · ` : ""}
                  {candidate.sharedCourses ? `${candidate.sharedCourses} shared course(s)` : "Discovery result"}
                </span>
              </div>
              {invitedIds.includes(candidate.id) ? (
                <span className="leader-chip">Invited</span>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busyId === candidate.id || !candidate.canInvite}
                  title={candidate.inviteBlockedReason || "Send an invitation"}
                  onClick={() => invite(candidate.id)}
                >
                  Invite
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function memberIsSelf(member, viewerId) {
  return Boolean(viewerId) && member.id === viewerId;
}

function SessionsSection({ activeGroup, showToast, refreshKey }) {
  const [scope, setScope] = useState("upcoming");
  const path = activeGroup
    ? `study-groups/leader/sessions?groupId=${activeGroup.id}&scope=${scope}&limit=30`
    : "study-groups/leader/sessions?scope=upcoming&limit=30";
  const { loading, error, data } = useSectionData(path, [scope, activeGroup?.id], refreshKey);
  const sessions = data?.sessions || [];
  const [form, setForm] = useState({ title: "", startsAt: "", endsAt: "", mode: "PHYSICAL", location: "", meetingUrl: "", agenda: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [busyId, setBusyId] = useState("");
  const [localSessions, setLocalSessions] = useState(null);

  const list = localSessions || sessions;

  async function createSession(event) {
    event.preventDefault();
    if (!activeGroup?.workspace_id) {
      setFormError("This group has no active workspace yet.");
      return;
    }
    setSaving(true);
    setFormError("");
    setFormSuccess("");
    try {
      await apiRequest(`workspaces/${activeGroup.workspace_id}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
          mode: form.mode,
          location: form.location || null,
          meetingUrl: form.meetingUrl || null,
          agenda: form.agenda,
        }),
      });
      setFormSuccess("Session scheduled. Members have been notified.");
      setForm({ title: "", startsAt: "", endsAt: "", mode: "PHYSICAL", location: "", meetingUrl: "", agenda: "" });
      setLocalSessions(null);
      setScope("upcoming");
      showToast("Session scheduled.");
    } catch (error) {
      setFormError(error.message);
    }
    setSaving(false);
  }

  async function cancelSession(session) {
    setBusyId(session.id);
    try {
      await apiRequest(`workspaces/${session.workspace_id}/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "CANCELLED" }),
      });
      setLocalSessions((current) => ({
        sessions: (current?.sessions || sessions).map((item) => (item.id === session.id ? { ...item, status: "CANCELLED" } : item)),
      }));
      showToast("Session cancelled.");
    } catch (error) {
      setFormError(error.message);
    }
    setBusyId("");
  }

  return (
    <div className="leader-stack">
      <section className="panel leader-card">
        <div className="section-heading leader-split">
          <div><span className="section-overline">SCHEDULING</span><h2>Sessions <span className="heading-count">{list.length}</span></h2></div>
          <div className="leader-tabs">
            {["upcoming", "past", "all"].map((value) => (
              <button key={value} type="button" className={scope === value ? "active" : ""} onClick={() => setScope(value)}>{value}</button>
            ))}
          </div>
        </div>
        {loading && <p className="feature-muted">Loading sessions…</p>}
        {error && <p className="feature-error">{error}</p>}
        {!loading && !error && list.length === 0 && <p className="feature-muted">Nothing on the calendar for this view.</p>}
        <ul className="leader-list">
          {list.map((session) => (
            <li key={session.id} className="leader-list-row">
              <div>
                <strong>{session.title}</strong>
                <span className="leader-muted">
                  {session.group_name} · {formatDateTime(session.starts_at)} · {MODE_LABELS[session.mode] || session.mode}
                  {session.location ? ` · ${session.location}` : ""}
                </span>
                <span className="leader-muted">
                  {session.going_count}/{session.member_count} going · {session.status}
                </span>
              </div>
              {session.status === "SCHEDULED" && (
                <button type="button" className="button button-secondary" disabled={busyId === session.id} onClick={() => cancelSession(session)}>Cancel</button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel leader-card">
        <div className="section-heading">
          <div><span className="section-overline">NEW SESSION</span><h3>Schedule a study session</h3></div>
        </div>
        {formError && <p className="feature-error">{formError}</p>}
        {formSuccess && <p className="feature-success">{formSuccess}</p>}
        <form className="feature-form leader-form-grid" onSubmit={createSession}>
          <label>Title<input required minLength={2} maxLength={140} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label>Starts<input required type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /></label>
          <label>Ends<input required type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></label>
          <label>Mode
            <select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
              <option value="PHYSICAL">In person</option>
              <option value="ONLINE">Online</option>
            </select>
          </label>
          <label>Location<input maxLength={200} value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
          <label>Meeting link<input type="url" maxLength={500} value={form.meetingUrl} onChange={(event) => setForm({ ...form, meetingUrl: event.target.value })} placeholder="https://" /></label>
          <label className="leader-form-wide">Agenda<textarea rows={3} maxLength={2000} value={form.agenda} onChange={(event) => setForm({ ...form, agenda: event.target.value })} /></label>
          <div className="leader-form-wide">
            <button type="submit" className="button button-primary" disabled={saving}>{saving ? "Scheduling…" : "Schedule session"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function MatchingSection({ activeGroup, showToast, refreshKey }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [invitedIds, setInvitedIds] = useState([]);
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const params = new URLSearchParams({ limit: "12" });
  if (activeGroup?.id) params.set("limit", "12");
  if (debounced) params.set("q", debounced);
  const path = activeGroup ? `study-groups/${activeGroup.id}/recommended-members?${params.toString()}` : "study-groups/leader/overview";
  const { loading, error, data } = useSectionData(path, [activeGroup?.id, debounced], refreshKey);
  const candidates = data?.candidates || [];

  async function invite(candidateId) {
    setBusyId(candidateId);
    setActionError("");
    try {
      await apiRequest(`study-groups/${activeGroup.id}/invite`, {
        method: "POST",
        body: JSON.stringify({ inviteeId: candidateId, ignoreCompatibility: true }),
      });
      setInvitedIds((current) => [...current, candidateId]);
      showToast("Invitation sent.");
    } catch (error) {
      setActionError(error.message);
    }
    setBusyId("");
  }

  return (
    <section className="panel leader-card">
      <div className="section-heading">
        <div><span className="section-overline">AI-ASSISTED MATCHING</span><h2>Suggested members <span className="heading-count">{candidates.length}</span></h2></div>
      </div>
      <p className="leader-muted">
        Compatibility is computed from shared courses, complementary topics, goals and availability. A low score never blocks an invite.
      </p>
      <input
        className="leader-search"
        type="search"
        value={query}
        placeholder="Search candidates by name"
        onChange={(event) => setQuery(event.target.value)}
      />
      {actionError && <p className="feature-error">{actionError}</p>}
      {loading && <p className="feature-muted">Scoring candidates…</p>}
      {error && <p className="feature-error">{error}</p>}
      {!loading && !error && candidates.length === 0 && <p className="feature-muted">No candidates to suggest right now.</p>}
      <div className="leader-candidate-grid">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="leader-candidate">
            <div className="leader-candidate-head">
              <strong>{memberName(candidate)}</strong>
              {candidate.compatibility?.score != null && (
                <span className="leader-badge">{Math.round(candidate.compatibility.score)}% match</span>
              )}
            </div>
            <p className="leader-muted">
              {candidate.programName || "Student"}
              {candidate.yearOfStudy ? ` · Year ${candidate.yearOfStudy}` : ""}
              {candidate.sharedCourses ? ` · ${candidate.sharedCourses} shared course(s)` : ""}
            </p>
            {candidate.reasons?.length > 0 && (
              <ul className="leader-reasons">
                {candidate.reasons.slice(0, 3).map((reason, index) => (
                  <li key={index}>{reason.detail || reason.label || String(reason)}</li>
                ))}
              </ul>
            )}
            <div className="leader-actions">
              {invitedIds.includes(candidate.id) ? (
                <span className="leader-chip">Invited</span>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busyId === candidate.id || !candidate.canInvite}
                  title={candidate.inviteBlockedReason || "Invite to the group"}
                  onClick={() => invite(candidate.id)}
                >
                  Invite
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AnalyticsSection({ activeGroup, refreshKey }) {
  const [days, setDays] = useState(30);
  const path = activeGroup ? `study-groups/${activeGroup.id}/analytics?days=${days}` : "study-groups/leader/overview";
  const { loading, error, data } = useSectionData(path, [activeGroup?.id, days], refreshKey);

  if (loading) return <p className="feature-muted">Crunching the numbers…</p>;
  if (error) return <p className="feature-error">{error}</p>;
  if (!data?.group) return <p className="feature-muted">Select a group to see analytics.</p>;

  const membership = data.membership || {};
  const activity = data.activity || {};
  const byType = activity.byType || [];
  const maxCount = Math.max(1, ...byType.map((item) => item.count));

  return (
    <div className="leader-stack">
      <div className="leader-tabs leader-tabs-inline">
        {[7, 30, 90].map((value) => (
          <button key={value} type="button" className={days === value ? "active" : ""} onClick={() => setDays(value)}>Last {value} days</button>
        ))}
      </div>

      <div className="leader-stat-grid">
        <StatCard label="Active members" value={membership.active ?? 0} hint={`${membership.members ?? 0} members · ${membership.moderators ?? 0} moderators`} />
        <StatCard label="Joined" value={membership.joined_in_window ?? 0} hint={`in ${days} days`} />
        <StatCard label="Left" value={membership.left_in_window ?? 0} hint={`in ${days} days`} />
        <StatCard label="Group events" value={activity.in_window ?? 0} hint={`${activity.total ?? 0} all time`} />
        <StatCard label="Sessions held" value={data.sessions?.completed ?? 0} hint={`${data.sessions?.upcoming ?? 0} upcoming`} />
        <StatCard label="Going / attended" value={`${data.sessions?.going ?? 0} / ${data.sessions?.attended ?? 0}`} />
        <StatCard label="Tasks complete" value={data.tasks?.completed ?? 0} hint={`${data.tasks?.overdue ?? 0} overdue`} />
        <StatCard label="Messages" value={data.chat?.messages ?? 0} hint={`in ${days} days`} />
      </div>

      <div className="leader-two-col">
        <section className="panel leader-card">
          <div className="section-heading"><div><span className="section-overline">ACTIVITY MIX</span><h3>What the group did</h3></div></div>
          {byType.length === 0 && <p className="feature-muted">No recorded activity in this window.</p>}
          <div className="leader-bars">
            {byType.map((item) => (
              <div className="leader-bar-row" key={item.event_type}>
                <span className="leader-bar-label">{item.event_type.replaceAll("_", " ").toLowerCase()}</span>
                <div className="leader-bar-track"><div className="leader-bar-fill" style={{ width: `${Math.round((item.count / maxCount) * 100)}%` }} /></div>
                <span className="leader-bar-value">{item.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel leader-card">
          <div className="section-heading"><div><span className="section-overline">HOW MEMBERS ARRIVED</span><h3>Join sources</h3></div></div>
          <ul className="leader-list">
            {(data.joinSources || []).map((source) => (
              <li key={source.joined_via} className="leader-list-row">
                <span>{source.joined_via.replaceAll("_", " ").toLowerCase()}</span>
                <span className="leader-chip">{source.count}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function SettingsSection({ activeGroup, identity, showToast, onRefreshOverview, onArchived, refreshKey }) {
  const detail = useSectionData(activeGroup ? `study-groups/${activeGroup.id}` : "study-groups/leader/overview", [activeGroup?.id], refreshKey);
  const group = detail.data?.group || null;
  const isOwner = group?.viewer?.role === "OWNER";
  const [announcement, setAnnouncement] = useState({ title: "", body: "" });
  const [announcing, setAnnouncing] = useState(false);
  const [sectionError, setSectionError] = useState("");
  const [sectionSuccess, setSectionSuccess] = useState("");
  const [archiveStage, setArchiveStage] = useState(false);
  const [archiving, setArchiving] = useState(false);

  async function sendAnnouncement(event) {
    event.preventDefault();
    setAnnouncing(true);
    setSectionError("");
    setSectionSuccess("");
    try {
      const result = await apiRequest(`study-groups/${activeGroup.id}/announcement`, {
        method: "POST",
        body: JSON.stringify(announcement),
      });
      setSectionSuccess(`Announcement posted to ${result.notified} member(s).`);
      showToast("Announcement posted.");
      setAnnouncement({ title: "", body: "" });
    } catch (error) {
      setSectionError(error.message);
    }
    setAnnouncing(false);
  }

  async function archiveGroup() {
    setArchiving(true);
    setSectionError("");
    try {
      await apiRequest(`study-groups/${activeGroup.id}/archive`, { method: "POST" });
      showToast("Group archived.");
      await onRefreshOverview();
      onArchived();
    } catch (error) {
      setSectionError(error.message);
      setArchiving(false);
    }
  }

  if (detail.loading) return <p className="feature-muted">Loading settings…</p>;
  if (detail.error) return <p className="feature-error">{detail.error}</p>;
  if (!group) return <p className="feature-muted">Select a group to manage its settings.</p>;

  return (
    <div className="leader-stack">
      {sectionError && <p className="feature-error">{sectionError}</p>}
      {sectionSuccess && <p className="feature-success">{sectionSuccess}</p>}

      {/* Keyed by group id: switching groups remounts the form so its initial
          state always reflects the newly selected group, with no prop-sync effect. */}
      <SettingsForm key={group.id} group={group} isOwner={isOwner} showToast={showToast} onRefreshOverview={onRefreshOverview} />

      <section className="panel leader-card">
        <div className="section-heading"><div><span className="section-overline">REACH EVERYONE</span><h3>Post an announcement</h3></div></div>
        <p className="leader-muted">Announcements are delivered to every active member as a notification and posted to the group chat.</p>
        <form className="feature-form leader-form-grid" onSubmit={sendAnnouncement}>
          <label className="leader-form-wide">Title<input required minLength={2} maxLength={140} value={announcement.title} onChange={(event) => setAnnouncement({ ...announcement, title: event.target.value })} /></label>
          <label className="leader-form-wide">Message<textarea required rows={3} maxLength={2000} value={announcement.body} onChange={(event) => setAnnouncement({ ...announcement, body: event.target.value })} /></label>
          <div className="leader-form-wide">
            <button type="submit" className="button button-primary" disabled={announcing}>{announcing ? "Posting…" : "Post announcement"}</button>
          </div>
        </form>
      </section>

      {isOwner && (
        <section className="panel leader-card leader-danger">
          <div className="section-heading"><div><span className="section-overline">DANGER ZONE</span><h3>Archive this group</h3></div></div>
          <p className="leader-muted">
            Archiving keeps the history for the audit trail but closes the workspace and cancels pending requests and invitations.
          </p>
          {archiveStage ? (
            <div className="leader-actions">
              <button type="button" className="button button-primary" disabled={archiving} onClick={archiveGroup}>{archiving ? "Archiving…" : "Yes, archive"}</button>
              <button type="button" className="button button-secondary" onClick={() => setArchiveStage(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="button button-secondary" onClick={() => setArchiveStage(true)}>Archive group</button>
          )}
        </section>
      )}

      <p className="leader-muted leader-tiny">
        Signed in as {displayNameOf(identity)} · Need to leave instead? Use My Groups in the student dashboard.
      </p>
    </div>
  );
}

function SettingsForm({ group, isOwner, showToast, onRefreshOverview }) {
  const [form, setForm] = useState(() => ({
    name: group.name || "",
    description: group.description || "",
    mode: group.mode || "EITHER",
    privacy: group.privacy || "REQUEST_REQUIRED",
    requireApproval: group.requireApproval !== false,
    minSize: group.minSize ?? 3,
    maxSize: group.maxSize ?? 6,
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    setSaveSuccess("");
    const payload = {
      name: form.name,
      description: form.description,
      mode: form.mode,
      minSize: Number(form.minSize),
      maxSize: Number(form.maxSize),
    };
    if (isOwner) {
      payload.privacy = form.privacy;
      payload.requireApproval = form.requireApproval;
    }
    try {
      await apiRequest(`study-groups/${group.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      setSaveSuccess("Group settings saved.");
      showToast("Settings saved.");
      await onRefreshOverview();
    } catch (error) {
      setSaveError(error.message);
    }
    setSaving(false);
  }

  return (
    <section className="panel leader-card">
      <div className="section-heading"><div><span className="section-overline">GROUP PROFILE</span><h3>Settings</h3></div><span className="leader-chip">{ROLE_LABELS[group.viewer?.role] || "Leader"}</span></div>
      {saveError && <p className="feature-error">{saveError}</p>}
      {saveSuccess && <p className="feature-success">{saveSuccess}</p>}
      <form className="feature-form leader-form-grid" onSubmit={saveSettings}>
        <label>Name<input required minLength={3} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Mode
          <select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
            <option value="EITHER">Either</option>
            <option value="ONLINE">Online</option>
            <option value="PHYSICAL">In person</option>
          </select>
        </label>
        <label>Minimum size<input type="number" min={2} max={12} value={form.minSize} onChange={(event) => setForm({ ...form, minSize: event.target.value })} /></label>
        <label>Maximum size<input type="number" min={2} max={20} value={form.maxSize} onChange={(event) => setForm({ ...form, maxSize: event.target.value })} /></label>
        <label>Privacy
          <select value={form.privacy} disabled={!isOwner} onChange={(event) => setForm({ ...form, privacy: event.target.value })}>
            {Object.entries(PRIVACY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="leader-check">
          <input type="checkbox" checked={form.requireApproval} disabled={!isOwner} onChange={(event) => setForm({ ...form, requireApproval: event.target.checked })} />
          <span>Require approval to join</span>
        </label>
        <label className="leader-form-wide">Description<textarea rows={3} maxLength={1500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <div className="leader-form-wide">
          <button type="submit" className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
      {!isOwner && <p className="leader-muted leader-tiny">Only the owner can change privacy, approval and size limits.</p>}
    </section>
  );
}
