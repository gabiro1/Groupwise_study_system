"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import BrandLogo from "../BrandLogo";
import StudentRecommendations from "./StudentRecommendations";
import StudentProfile from "./StudentProfile";
import NotificationsInbox from "./NotificationsInbox";
import StudyWorkspace from "./StudyWorkspace";
import StudyPartners from "./StudyPartners";
import AiMatchSearch from "./AiMatchSearch";
import FloatingAssistant from "./FloatingAssistant";
import MeetingsLazy from "./meetings/MeetingsLazy";
import ThemeToggle from "../ThemeToggle";

const navGroups = [
  {
    label: "YOUR SPACE",
    items: [
      { label: "Dashboard", icon: "home", href: "/dashboard" },
      { label: "Discover Groups", icon: "search", href: "/dashboard/discover" },
      { label: "My Groups", icon: "users", href: "/dashboard/groups" },
      { label: "Workspaces", icon: "workspace", href: "/dashboard/workspaces" },
    ],
  },
  {
    label: "COMMUNICATION",
    items: [
      { label: "Messages", icon: "chat", href: "/dashboard/messages" },
      { label: "Meetings", icon: "video", href: "/dashboard/meetings" },
      { label: "Partners", icon: "partner", href: "/dashboard/partners" },
      { label: "Notifications", icon: "bell", href: "/dashboard/notifications" },
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      { label: "Profile / Settings", icon: "settings", href: "/dashboard/profile" },
    ],
  },
];

const workspaceActions = [];

const workspaceTabConfig = {
  notes: { initialTab: "Resources", resourceKind: "NOTE" },
  tasks: { initialTab: "Plans & tasks" },
  resources: { initialTab: "Resources" },
  sessions: { initialTab: "Sessions" },
  discussions: { initialTab: "Group chat" },
  progress: { initialTab: "Progress & feedback" },
};

const sectionTitles = {
  overview: "Dashboard",
  discover: "Discover Groups",
  groups: "My Groups",
  workspaces: "Workspaces",
  messages: "Messages",
  meetings: "Meetings",
  meetingDetail: "Meetings",
  partners: "Study partners",
  sessions: "Study sessions",
  courses: "My courses",
  recommendations: "For you",
  profile: "Profile / Settings",
  notifications: "Notifications",
  workspace: "Workspaces",
};

function Icon({ name, size = 18, strokeWidth = 1.8 }) {
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
    partner: <><path d="M10 13a5 5 0 0 0 7.5 5.5l2.5-2.5-2.5-2.5-2.5 2.5" /><path d="M14 11a5 5 0 0 0-7.5-5.5L4 8l2.5 2.5L9 8" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" /><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    workspace: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" /><path d="M8 11h8M8 14h5" /></>,
    note: <><path d="M7 3h7l5 5v13H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" /><path d="M14 3v6h5M8 13h7M8 17h7" /></>,
    tasks: <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="m8 9 1.5 1.5L12 8M14 10h3M8 16h9" /></>,
    resource: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" /><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20M8 7h8M8 11h6" /></>,
    progress: <><path d="M4 19V5M4 19h17" /><path d="m7 15 4-4 3 2 5-6" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.2 2.1-2.1 2.1-2.2-1.2h-.2a7.4 7.4 0 0 1-1.7.7l-.2.1-.7 2.4h-3l-.7-2.4-.2-.1a7.4 7.4 0 0 1-1.7-.7h-.2l-2.2 1.2-2.1-2.1 1.2-2.2v-.2a7.4 7.4 0 0 1-.7-1.7l-.1-.2-2.4-.7v-3l2.4-.7.1-.2a7.4 7.4 0 0 1 .7-1.7v-.2L3.5 5.3l2.1-2.1 2.2 1.2H8a7.4 7.4 0 0 1 1.7-.7l.2-.1.7-2.4h3l.7 2.4.2.1a7.4 7.4 0 0 1 1.7.7h.2l2.2-1.2 2.1 2.1-1.2 2.2v.2a7.4 7.4 0 0 1 .7 1.7l.1.2 2.4.7v3l-2.4.7-.1.2a7.4 7.4 0 0 1-.7 1.7Z" transform="translate(-1.5 -1.5) scale(1.12)" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    video: <><rect x="2" y="6" width="13" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></>,
  };

  return <svg {...shared}>{paths[name] || paths.home}</svg>;
}

function Avatar({ initials, className = "", src }) {
  return (
    <span className={`avatar ${className}`} aria-label={initials}>
      {src ? <Image src={src} alt="" width={64} height={64} unoptimized /> : initials}
    </span>
  );
}

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
    const error = new Error(result.error?.message || "We couldn’t load your study space.");
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return result.data;
}

function normaliseGroup(group) {
  const courseCode = group.courseCode || group.course_code || "";
  const courseName = group.courseName || group.course_name || "Course not listed";
  const palette = ["mint", "lilac", "peach"];
  const colorIndex = [...(courseCode || group.id || group.name)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return {
    ...group,
    name: group.name,
    courseCode,
    courseName,
    course: `${courseCode ? `${courseCode} · ` : ""}${courseName}`,
    memberCount: group.memberCount ?? group.member_count ?? 0,
    myRole: group.myRole || group.my_role,
    workspaceId: group.workspaceId || group.workspace_id,
    color: palette[colorIndex],
  };
}

function normaliseWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    groupId: workspace.groupId || workspace.group_id,
    canArchive: workspace.canArchive ?? workspace.can_archive ?? false,
    groupName: workspace.groupName || workspace.group_name,
    courseCode: workspace.courseCode || workspace.course_code || "",
    courseName: workspace.courseName || workspace.course_name || "Course not listed",
    topics: workspace.topics || "",
    memberCount: Number(workspace.memberCount ?? workspace.member_count ?? 0),
    lastActivityAt: workspace.lastActivityAt || workspace.last_activity_at || null,
    lastMessageBody: workspace.lastMessageBody || workspace.last_message_body || "",
    lastMessageAt: workspace.lastMessageAt || workspace.last_message_at || null,
    lastMessageAuthor: [
      workspace.lastMessageFirstName || workspace.last_message_first_name,
      workspace.lastMessageLastName || workspace.last_message_last_name,
    ].filter(Boolean).join(" "),
    progressTopics: Number(workspace.progressTopics ?? workspace.progress_topic_count ?? 0),
    progressCompleted: Number(workspace.progressCompleted ?? workspace.progress_completed_count ?? 0),
  };
}

function formatActivityDate(value) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Activity date unavailable"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function memberName(member) {
  return [member.firstName || member.first_name, member.lastName || member.last_name].filter(Boolean).join(" ") || "Group member";
}

/**
 * Group-leader management panel.
 *
 * Leadership is a membership permission (OWNER / MODERATOR), not a role, so this
 * is only rendered for groups where the caller has one of those two roles. It
 * reads the group's pending-invitation and join-request queue plus the member
 * roster, and drives the moderator endpoints that back them.
 */
function GroupLeadershipPanel({ group, currentUserId, onClose }) {
  const [queue, setQueue] = useState({ invitations: [], requests: [] });
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refreshRoster = useCallback(async () => {
    const detail = await apiRequest(`study-groups/${group.id}`);
    setMembers(Array.isArray(detail.group?.members) ? detail.group.members : []);
  }, [group.id]);

  useEffect(() => {
    let active = true;
    async function loadQueue() {
      try {
        const moderation = await apiRequest(`study-groups/${group.id}/moderation`);
        const detail = await apiRequest(`study-groups/${group.id}`);
        if (!active) return;
        setQueue({
          invitations: moderation.invitations || [],
          requests: moderation.requests || [],
        });
        setMembers(Array.isArray(detail.group?.members) ? detail.group.members : []);
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadQueue();
    return () => { active = false; };
  }, [group.id]);

  async function decide(requestId, decision) {
    setBusyId(`request:${requestId}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`study-groups/${group.id}/requests/${requestId}/decide`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          note: decision === "REJECT" ? note.trim() || null : null,
        }),
      });
      setQueue((current) => ({
        ...current,
        requests: current.requests.filter((request) => request.id !== requestId),
      }));
      setMessage(decision === "APPROVE" ? "Request approved — they are now a member." : "Request declined.");
      setNote("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function manageMember(member, action) {
    setBusyId(`member:${member.id}:${action}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`study-groups/${group.id}/members/${member.id}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setMessage(
        action === "PROMOTE" ? "Promoted to moderator."
          : action === "DEMOTE" ? "Demoted to member."
          : "Removed from the group.",
      );
      await refreshRoster();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  const isOwner = group.myRole === "OWNER";

  return (
    <article className="group-leadership-panel" aria-live="polite">
      <div className="section-heading">
        <div>
          <span className="section-overline">LEADER TOOLS</span>
          <h3>Manage “{group.name}”</h3>
        </div>
        <button className="group-panel-close" type="button" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {error && <div className="feature-error" role="alert">{error}</div>}
      {message && <div className="feature-success" role="status">{message}</div>}
      {loading && <p className="empty-state" role="status">Loading the moderation queue…</p>}

      {!loading && (
        <>
          <div className="group-leadership-columns">
            <div className="group-leadership-col">
              <h4>Join requests <span className="heading-count">{queue.requests.length}</span></h4>
              {queue.requests.length === 0 ? (
                <p className="empty-state">No pending join requests.</p>
              ) : (
                <div className="group-leadership-queue">
                  {queue.requests.map((request) => (
                    <div className="group-leadership-row" key={request.id}>
                      <span className="group-invite-avatar">
                        {[request.firstName?.[0], request.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?"}
                      </span>
                      <div className="group-leadership-row-copy">
                        <strong>{memberName(request)}</strong>
                        {request.message && <small>“{request.message}”</small>}
                      </div>
                      <div className="partner-actions">
                        <button
                          className="button button-primary"
                          type="button"
                          disabled={busyId === `request:${request.id}`}
                          onClick={() => decide(request.id, "APPROVE")}
                        >
                          {busyId === `request:${request.id}` ? "Approving…" : "Approve"}
                        </button>
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={busyId === `request:${request.id}`}
                          onClick={() => decide(request.id, "REJECT")}
                        >
                          {busyId === `request:${request.id}` ? "Declining…" : "Decline"}
                        </button>
                      </div>
                    </div>
                  ))}
                  <label className="group-leadership-note">
                    Rejection note <span>(optional)</span>
                    <input
                      maxLength={500}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="e.g. The group is full this semester."
                    />
                  </label>
                </div>
              )}

              <h4>Pending invitations <span className="heading-count">{queue.invitations.length}</span></h4>
              {queue.invitations.length === 0 ? (
                <p className="empty-state">No invitations awaiting a reply.</p>
              ) : (
                <div className="group-leadership-queue">
                  {queue.invitations.map((invitation) => (
                    <div className="group-leadership-row" key={invitation.id}>
                      <span className="group-invite-avatar">
                        {[invitation.firstName?.[0], invitation.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?"}
                      </span>
                      <div className="group-leadership-row-copy">
                        <strong>{memberName(invitation)}</strong>
                        {invitation.message && <small>“{invitation.message}”</small>}
                        <small>Invited {new Date(invitation.createdAt || invitation.created_at).toLocaleDateString()}</small>
                      </div>
                      <span className="group-leadership-status">Awaiting reply</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="group-leadership-col">
              <h4>Members <span className="heading-count">{members.length}</span></h4>
              <div className="group-leadership-queue">
                {members.map((member) => {
                  const roleLabel = member.role?.toLowerCase() || "member";
                  const selfControl = member.id === currentUserId;
                  const isOwnerRow = member.role === "OWNER";
                  return (
                    <div className="group-leadership-row" key={member.id}>
                      <span className="group-invite-avatar">
                        {[member.first_name?.[0], member.last_name?.[0]].filter(Boolean).join("").toUpperCase() || "?"}
                      </span>
                      <div className="group-leadership-row-copy">
                        <strong>{memberName(member)}{selfControl && <span className="heading-count"> · you</span>}</strong>
                        <small className={`group-role-chip ${roleLabel}`}>{roleLabel}</small>
                      </div>
                      {!selfControl && !isOwnerRow && (
                        <div className="partner-actions">
                          {isOwner && member.role !== "MODERATOR" && (
                            <button
                              className="button button-secondary"
                              type="button"
                              disabled={busyId === `member:${member.id}:PROMOTE`}
                              onClick={() => manageMember(member, "PROMOTE")}
                            >
                              {busyId === `member:${member.id}:PROMOTE` ? "…" : "Promote"}
                            </button>
                          )}
                          {member.role === "MODERATOR" && (
                            <button
                              className="button button-secondary"
                              type="button"
                              disabled={busyId === `member:${member.id}:DEMOTE`}
                              onClick={() => manageMember(member, "DEMOTE")}
                            >
                              {busyId === `member:${member.id}:DEMOTE` ? "…" : "Demote"}
                            </button>
                          )}
                          <button
                            className="button button-secondary"
                            type="button"
                            disabled={busyId === `member:${member.id}:REMOVE`}
                            onClick={() => manageMember(member, "REMOVE")}
                          >
                            {busyId === `member:${member.id}:REMOVE` ? "…" : "Remove"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </article>
  );
}

/** Inline report form for a discover card, posting to the shared moderation queue. */
function ReportGroupForm({ group, onClose }) {
  const [category, setCategory] = useState("SPAM");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest("reports", {
        method: "POST",
        body: JSON.stringify({
          targetType: "GROUP",
          targetId: group.id,
          category,
          details: details.trim(),
        }),
      });
      setSent(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <article className="group-report-panel">
        <p className="feature-success" role="status">Thanks — our moderation team will take a look.</p>
      </article>
    );
  }

  return (
    <article className="group-report-panel">
      <form className="group-report-form" onSubmit={submit}>
        <div className="section-heading">
          <div><span className="section-overline">MODERATION</span><h3>Report “{group.name}”</h3></div>
        </div>
        <label>
          Reason
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="HARASSMENT">Harassment or bullying</option>
            <option value="INAPPROPRIATE_CONTENT">Inappropriate content</option>
            <option value="SPAM">Spam</option>
            <option value="ACADEMIC_DISHONESTY">Academic dishonesty</option>
            <option value="IMPERSONATION">Impersonation</option>
            <option value="OTHER">Something else</option>
          </select>
        </label>
        <label>
          Details
          <textarea
            required
            minLength={10}
            maxLength={2000}
            rows={3}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="Tell the moderation team what you saw."
          />
        </label>
        {error && <p className="workspace-create-error" role="alert">{error}</p>}
        <div className="workspace-create-actions">
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy || details.trim().length < 10}>
            {busy ? "Sending…" : "Send report"}
          </button>
        </div>
      </form>
    </article>
  );
}

function MessagesSection({ workspaces, loading, identity, initialConversationId }) {
  const [tab, setTab] = useState("direct");
  const [conversations, setConversations] = useState([]);
  const [convoLoading, setConvoLoading] = useState(true);
  const [activeConvo, setActiveConvo] = useState(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [messageData, setMessageData] = useState({ convoId: null, messages: [], loading: false });
  const msgListRef = useRef(null);

  useEffect(() => {
    let active = true;
    apiRequest("partners/conversations")
      .then((result) => {
        if (!active) return;
        const loaded = result.conversations || [];
        setConversations(loaded);
        if (initialConversationId) {
          const match = loaded.find((c) => c.conversationId === initialConversationId);
          if (match) setActiveConvo(match);
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setConvoLoading(false); });
    return () => { active = false; };
  }, [initialConversationId]);

useEffect(() => {
    if (!activeConvo) return undefined;
    const conversationId = activeConvo.conversationId;
    let active = true;
    apiRequest(`partners/conversations/${conversationId}/messages?limit=50`)
      .then((result) => {
        if (active) setMessageData({ convoId: conversationId, messages: result.messages || [], loading: false });
      })
      .catch(() => {});
    apiRequest(`partners/conversations/${conversationId}/read`, { method: "POST", body: "{}" }).catch(() => {});
    return () => { active = false; };
  }, [activeConvo]);

  useEffect(() => {
    if (msgListRef.current) msgListRef.current.scrollTop = msgListRef.current.scrollHeight;
  }, [messageData]);

  async function sendDm(event) {
    event.preventDefault();
    if (!draft.trim() || !activeConvo || sending) return;
    setSending(true);
    const body = draft.trim();
    setDraft("");
    try {
      const result = await apiRequest(`partners/conversations/${activeConvo.conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body, clientId: crypto.randomUUID() }),
      });
      setMessageData((prev) => prev.convoId === activeConvo.conversationId
        ? { ...prev, messages: [...prev.messages, {
          id: result.message.id,
          body: result.message.body,
          createdAt: result.message.created_at || result.message.createdAt,
          sender: { id: identity?.id, firstName: identity?.firstName, lastName: identity?.lastName },
        }] }
        : prev);
      setConversations((prev) => prev.map((c) =>
        c.conversationId === activeConvo.conversationId
          ? { ...c, lastMessage: { body, senderId: identity?.id, createdAt: new Date().toISOString() }, lastMessageAt: new Date().toISOString() }
          : c,
      ));
    } catch {}
    finally { setSending(false); }
  }

  const msgLoading = messageData.convoId !== (activeConvo ? activeConvo.conversationId : null) || messageData.loading;
  const messages = activeConvo && messageData.convoId === activeConvo.conversationId ? messageData.messages : [];

  return (
    <section className="section-page">
      <div className="section-page-heading">
        <span className="section-overline">COMMUNICATION</span>
        <h1>Messages</h1>
        <p>Chat with study partners or catch up on group conversations.</p>
      </div>
      <div className="messages-tab-bar">
        <button type="button" className={`messages-tab-btn${tab === "direct" ? " active" : ""}`} onClick={() => setTab("direct")}>
          <Icon name="chat" size={15} /> Direct messages
        </button>
        <button type="button" className={`messages-tab-btn${tab === "groups" ? " active" : ""}`} onClick={() => setTab("groups")}>
          <Icon name="users" size={15} /> Group chats
        </button>
      </div>

      {tab === "direct" && (
        <div className="dm-shell">
          <aside className="dm-sidebar">
            {convoLoading && <p className="empty-state">Loading...</p>}
            {!convoLoading && conversations.length === 0 && (
              <p className="empty-state">No direct conversations yet. Connect with a study partner to start chatting.</p>
            )}
            {conversations.map((c) => {
              const peerInitials = [c.peer?.firstName?.[0], c.peer?.lastName?.[0]].filter(Boolean).join("").toUpperCase();
              const isActive = activeConvo?.conversationId === c.conversationId;
              return (
                <button
                  key={c.conversationId}
                  type="button"
                  className={`dm-convo-row${isActive ? " active" : ""}${c.unreadCount > 0 ? " unread" : ""}`}
                  onClick={() => setActiveConvo(c)}
                >
                  <span className="dm-peer-avatar">{peerInitials}</span>
                  <span className="dm-convo-info">
                    <strong>{c.peer?.firstName} {c.peer?.lastName}</strong>
                    <span>{c.lastMessage?.body || "No messages yet"}</span>
                  </span>
                  {c.unreadCount > 0 && <span className="dm-unread-badge">{c.unreadCount}</span>}
                </button>
              );
            })}
          </aside>

          <div className="dm-chat-panel">
            {!activeConvo ? (
              <div className="dm-empty-chat">
                <Icon name="chat" size={32} />
                <p>Select a conversation to start chatting</p>
              </div>
            ) : (
              <>
                <div className="dm-chat-header">
                  <span className="dm-peer-avatar sm">
                    {[activeConvo.peer?.firstName?.[0], activeConvo.peer?.lastName?.[0]].filter(Boolean).join("").toUpperCase()}
                  </span>
                  <strong>{activeConvo.peer?.firstName} {activeConvo.peer?.lastName}</strong>
                </div>
                <div className="workspace-bubble-list" ref={msgListRef}>
                  {msgLoading && <p className="empty-state">Loading messages...</p>}
                  {!msgLoading && messages.length === 0 && <p className="empty-state">No messages yet. Say hello!</p>}
                  {messages.map((msg) => {
                    const initials = [msg.sender?.firstName?.[0], msg.sender?.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?";
                    const time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
                    return (
                      <div className="chat-bubble-row" key={msg.id}>
                        <span className="chat-avatar" aria-hidden="true">{initials}</span>
                        <div className="chat-bubble">
                          <div className="chat-bubble-meta">
                            <strong>{msg.sender?.firstName || "Unknown"}</strong>
                            <time>{time}</time>
                          </div>
                          <p>{msg.body}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <form className="workspace-message-form" onSubmit={sendDm}>
                  <textarea
                    rows={2}
                    placeholder="Write a message..."
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDm(e); } }}
                  />
                  <button className="button button-primary" type="submit" disabled={sending || !draft.trim()}>Send</button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "groups" && (
        <>
          <div className="workspace-hub-grid">
            {workspaces.map((workspace) => (
              <article className="workspace-hub-card" key={workspace.id}>
                <Link className="workspace-hub-link" href={`/dashboard/workspaces/${workspace.id}?tab=messages`}>
                  <div className="workspace-hub-heading">
                    <span className="workspace-hub-icon"><Icon name="chat" size={19} /></span>
                    <span className="workspace-hub-title">
                      <strong>{workspace.name}</strong>
                      <small>Workspace for {workspace.groupName}</small>
                    </span>
                    <Icon name="arrow" size={17} />
                  </div>
                  <div className="workspace-hub-details">
                    <span>{workspace.courseCode ? `${workspace.courseCode} · ` : ""}{workspace.courseName}</span>
                    {workspace.topics && <span>{workspace.topics}</span>}
                    <span>{workspace.memberCount} {workspace.memberCount === 1 ? "member" : "members"}</span>
                  </div>
                  <div className="workspace-latest-message">
                    <strong>{workspace.lastMessageAuthor || "Conversation"}</strong>
                    <p>{workspace.lastMessageBody || "No messages yet. Start the conversation with your group."}</p>
                    <small>{workspace.lastMessageAt ? formatActivityDate(workspace.lastMessageAt) : "Open chat"}</small>
                  </div>
                </Link>
              </article>
            ))}
          </div>
          {!loading && workspaces.length === 0 && (
            <p className="empty-state">No group workspaces yet. Join or create a study group to start a conversation.</p>
          )}
          {loading && <p className="empty-state">Loading your workspaces...</p>}
        </>
      )}
    </section>
  );
}

function DashboardSection({ section, search, setSearch, searchRef, groups, workspaces, workspaceGroupId, courses, sessions, loading, onJoin, onArchiveWorkspace, onCreateGroup, profile, onProfileSaved, onNotice, onUnreadChange, identity, initialConversationId, meetingId }) {
  const [manageGroupId, setManageGroupId] = useState("");
  const [reportGroupId, setReportGroupId] = useState("");
  if (section === "recommendations") return <StudentRecommendations onJoin={onJoin} />;
  if (section === "profile") return <StudentProfile initialProfile={profile} onSaved={onProfileSaved} onNotice={onNotice} />;
  if (section === "notifications") return <NotificationsInbox onUnreadChange={onUnreadChange} />;
  if (section === "messages") return <MessagesSection workspaces={workspaces} loading={loading} identity={identity} initialConversationId={initialConversationId} meetingId={meetingId} />;
  if (section === "meetings" || section === "meetingDetail") return <MeetingsLazy section={section} meetingId={meetingId} groups={groups.mine || []} />;
  if (section === "workspaces") {
    const filteredWorkspaces = workspaces.filter((workspace) =>
      (!workspaceGroupId || workspace.groupId === workspaceGroupId)
      && `${workspace.name} ${workspace.groupName} ${workspace.courseCode} ${workspace.courseName} ${workspace.topics}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
    return (
      <section className="section-page">
        <div className="section-page-heading">
          <span className="section-overline">YOUR SHARED STUDY SPACES</span>
          <h1>Workspaces</h1>
          <p>A dedicated place for each group to plan, discuss, and make progress together.</p>
        </div>
        <div className="workspace-hub-grid">
          {filteredWorkspaces.map((workspace) => {
            const progressPercent = workspace.progressTopics
              ? Math.round((workspace.progressCompleted / workspace.progressTopics) * 100)
              : 0;
            return (
              <article className="workspace-hub-card" key={workspace.id}>
                <Link className="workspace-hub-link" href={`/dashboard/workspaces/${workspace.id}`}>
                  <div className="workspace-hub-heading">
                    <span className="workspace-hub-icon"><Icon name="workspace" size={19} /></span>
                    <span className="workspace-hub-title">
                      <strong>{workspace.name}</strong>
                      <small>Workspace for {workspace.groupName}</small>
                    </span>
                    <Icon name="arrow" size={17} />
                  </div>
                  <div className="workspace-hub-details">
                    <span>{workspace.courseCode ? `${workspace.courseCode} · ` : ""}{workspace.courseName}</span>
                    {workspace.topics && <span>{workspace.topics}</span>}
                    <span>{workspace.memberCount} {workspace.memberCount === 1 ? "member" : "members"}</span>
                  </div>
                  <div className="workspace-progress-copy">
                    <span>Study progress</span>
                    <strong>{workspace.progressTopics
                      ? `${workspace.progressCompleted}/${workspace.progressTopics} topics · ${progressPercent}%`
                      : "Not tracked yet"}</strong>
                  </div>
                  <div
                    className="workspace-progress-track"
                    role="progressbar"
                    aria-label={`${workspace.groupName} study progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent}
                  >
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                  <small className="workspace-activity">Recent activity · {formatActivityDate(workspace.lastActivityAt)}</small>
                </Link>
                {workspace.canArchive && (
                  <button
                    className="workspace-archive-button"
                    type="button"
                    onClick={() => onArchiveWorkspace(workspace)}
                    aria-label={`Archive ${workspace.name}`}
                  >
                    Archive workspace
                  </button>
                )}
              </article>
            );
          })}
        </div>
        {!loading && filteredWorkspaces.length === 0 && (
          <p className="empty-state">You don’t have a workspace yet. Join or create a study group and its shared workspace will appear here.</p>
        )}
        {loading && <p className="empty-state">Loading your workspaces...</p>}
      </section>
    );
  }

  if (section === "partners") return <StudyPartners />;

  const matchingGroups = (section === "discover" ? groups.discovered : groups.mine);
  const filteredGroups = matchingGroups.filter((group) =>
    `${group.name} ${group.course}`.toLowerCase().includes(search.toLowerCase()),
  );

  if (section === "groups" || section === "discover") {
    const isDiscover = section === "discover";
    return (
      <section className="section-page" id={isDiscover ? "discover" : "groups"}>
        <div className="section-page-heading group-page-heading">
          <div>
            <span className="section-overline">{isDiscover ? "LEARN BETTER TOGETHER" : "YOUR PEOPLE"}</span>
            <h1>{isDiscover ? "Find your study group" : "My study groups"}</h1>
            <p>{isDiscover ? "Meet people who are learning the same things you are." : "Your study crews, all in one place."}</p>
          </div>
          {!isDiscover && (
            <button className="button button-primary" type="button" onClick={onCreateGroup}>
              <Icon name="plus" size={16} /> Create group
            </button>
          )}
        </div>
        {isDiscover && (
          <label className="discover-search section-search">
            <Icon name="search" size={17} />
            <input
              ref={searchRef}
              aria-label="Search study groups"
              placeholder="Search by course or topic"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
        {isDiscover && <AiMatchSearch kind="GROUP" onJoin={onJoin} onNotice={onNotice} />}
        <section className="panel section-panel">
          <div className="section-heading">
            <div><span className="section-overline">{isDiscover ? "FROM YOUR STUDY COMMUNITY" : "YOUR ACTIVE GROUPS"}</span><h2>{isDiscover ? "Groups to explore" : "All groups"} <span className="heading-count">{filteredGroups.length}</span></h2></div>
          </div>
          <div className="group-list">
            {filteredGroups.map((group) => (
              <Fragment key={group.id}>
                <article className="group-card">
                  <div className={`course-symbol ${group.color}`}><Icon name="book" size={19} /></div>
                  <div className="group-info">
                    <h3>{group.name}</h3>
                    <p>{group.course}</p>
                    <div className="group-members">
                      <span>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</span>
                      {group.myRole && <><span className="member-divider">·</span><span>{group.myRole.toLowerCase()}</span></>}
                    </div>
                  </div>
                  {isDiscover && !group.isMember ? (
                    <div className="group-card-actions">
                      <button className="button button-primary" type="button" onClick={() => onJoin(group)} disabled={!group.hasSpace}> {group.hasPendingRequest ? "Request sent" : group.hasPendingInvite ? "Invitation received" : group.hasSpace ? "Join group" : "Group full"} </button>
                      <button
                        className="button button-secondary group-report-toggle"
                        type="button"
                        aria-expanded={reportGroupId === group.id}
                        onClick={() => setReportGroupId((current) => (current === group.id ? "" : group.id))}
                      >
                        {reportGroupId === group.id ? "Cancel" : "Report"}
                      </button>
                    </div>
                  ) : (
                    <div className="group-card-actions">
                      {(group.myRole === "OWNER" || group.myRole === "MODERATOR") && (
                        <button
                          className="button button-secondary group-report-toggle"
                          type="button"
                          aria-expanded={manageGroupId === group.id}
                          onClick={() => setManageGroupId((current) => (current === group.id ? "" : group.id))}
                        >
                          {manageGroupId === group.id ? "Close" : "Manage"}
                        </button>
                      )}
                      <Link className="circle-arrow" href={`/dashboard/workspaces?groupId=${group.id}`} aria-label={`View workspaces for ${group.name}`}><Icon name="arrow" size={17} /></Link>
                    </div>
                  )}
                </article>
                {reportGroupId === group.id && (
                  <ReportGroupForm group={group} onClose={() => setReportGroupId("")} />
                )}
                {manageGroupId === group.id && (
                  <GroupLeadershipPanel group={group} currentUserId={identity?.id} onClose={() => setManageGroupId("")} />
                )}
              </Fragment>
            ))}
            {!loading && filteredGroups.length === 0 && <p className="empty-state">{isDiscover ? "No study groups match this search yet." : "You haven't joined a study group yet. Explore groups to find your people."}</p>}
            {loading && <p className="empty-state">Loading study groups...</p>}
          </div>
          {isDiscover && !loading && <Link className="browse-groups" href="/dashboard/courses"><Icon name="book" size={16} /> Browse your courses</Link>}
        </section>
      </section>
    );
  }

  if (section === "sessions") {
    return (
      <section className="section-page">
        <div className="section-page-heading">
          <span className="section-overline">MAKE TIME TO LEARN</span>
          <h1>Study sessions</h1>
          <p>See what your groups are working on next.</p>
        </div>
        <section className="panel section-panel">
          <div className="section-heading"><div><span className="section-overline">UP NEXT</span><h2>Your upcoming sessions</h2></div></div>
          <div className="section-agenda">
            {sessions.map((session) => (
              <article className="session-card" key={session.id}><span className="session-accent" />
                <div className="session-time"><Icon name="clock" size={14} /> {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startsAt))}</div>
                <h3>{session.title}</h3><p><Icon name="users" size={14} /> {session.groupName}</p>
                <div className="session-bottom"><span><Icon name="pin" size={14} /> {session.location || session.mode}</span><span>{session.goingCount} attending</span></div>
              </article>
            ))}
            {!loading && sessions.length === 0 && <p className="empty-state">There are no upcoming sessions in your study groups yet.</p>}
            {loading && <p className="empty-state">Loading study sessions...</p>}
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="section-page">
      <div className="section-page-heading">
        <span className="section-overline">YOUR LEARNING PATH</span>
        <h1>My courses</h1>
        <p>Keep track of the classes and study groups you care about.</p>
      </div>
      <div className="section-course-grid">
        {courses.map((course) => (
          <article className="panel section-course-card" key={course.id}>
            <div className="course-symbol mint"><Icon name="book" size={19} /></div>
            <span className="section-overline">CURRENT COURSE</span>
            <h2>{course.name}</h2><p>{course.courseCode}{course.semester ? ` · ${course.semester}` : ""}</p>
            <Link className="text-link" href="/dashboard/groups">View study group <Icon name="arrow" size={15} /></Link>
          </article>
        ))}
        {!loading && courses.length === 0 && <p className="empty-state">No courses are linked to your profile yet.</p>}
        {loading && <p className="empty-state">Loading your courses...</p>}
      </div>
    </section>
  );
}

export default function DashboardWorkspace({ section = "overview", workspaceId, workspaceTab, workspaceGroupId, initialConversationId, meetingId }) {
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [identity, setIdentity] = useState(null);
  const [profile, setProfile] = useState(null);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupCreateBusy, setGroupCreateBusy] = useState(false);
  const [groupCreateError, setGroupCreateError] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateCourseId, setGroupCreateCourseId] = useState("");
  const [groupCreateDescription, setGroupCreateDescription] = useState("");
  const [createdGroupForInvites, setCreatedGroupForInvites] = useState(null);
  const [inviteSearch, setInviteSearch] = useState("");
  const [inviteCandidates, setInviteCandidates] = useState([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [invitingStudentId, setInvitingStudentId] = useState("");
  const [invitedStudentIds, setInvitedStudentIds] = useState([]);
  const [workspaceCreateGroupId, setWorkspaceCreateGroupId] = useState("");
  const [workspaceCreateName, setWorkspaceCreateName] = useState("");
  const [workspaceCreateDescription, setWorkspaceCreateDescription] = useState("");
  const [workspaceCreateError, setWorkspaceCreateError] = useState("");
  const [workspaceCreateBusy, setWorkspaceCreateBusy] = useState(false);
  const [myGroups, setMyGroups] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [discoveredGroups, setDiscoveredGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedDiscoverySearch, setLoadedDiscoverySearch] = useState(null);
  const [loadError, setLoadError] = useState("");
  const searchRef = useRef(null);
  const topSearchRef = useRef(null);
  const noticeTimeoutRef = useRef(null);
  const visibleGroups = useMemo(
    () => myGroups.filter((group) => `${group.name} ${group.course}`.toLowerCase().includes(search.toLowerCase())),
    [myGroups, search],
  );
  const activeNav = sectionTitles[section] || "Overview";
  const discoverLoading = section === "discover" && loadedDiscoverySearch !== search;
  const workspacePageTab = workspaceTabConfig[workspaceTab];
  const sidebarWorkspace = workspaces.find((item) => item.id === workspaceId) || workspaces[0];

  useEffect(() => {
    let active = true;
    async function loadDashboard() {
      let auth;
      try {
        auth = await apiRequest("auth/me");
      } catch (error) {
        if (!active) return;
        if (error.status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        setLoadError(error.message);
        setLoading(false);
        return;
      }

      if (!active) return;
      if (auth.user?.role !== "STUDENT") {
        // Route other roles to their own home rather than showing an access
        // error they cannot act on. A lecturer belongs in /dashboard/lecturer.
        if (auth.user?.role === "ADMIN") {
          window.location.replace("/admin");
          return;
        }
        if (auth.user?.role === "LECTURER") {
          window.location.replace("/dashboard/lecturer");
          return;
        }
        setLoadError("Your account is signed in, but it does not have student access to this dashboard.");
        setLoading(false);
        return;
      }
      setIdentity(auth.user);

      try {
        const [student, groupResult, workspaceResult, notificationResult, leaderResult] = await Promise.all([
          apiRequest("students/me"),
          apiRequest("study-groups/mine"),
          apiRequest("workspaces"),
          apiRequest("notifications/unread-count"),
          apiRequest("study-groups/leader/overview").catch(() => ({ groups: [] })),
        ]);
        if (!active) return;
        // Group leaders belong in their dedicated dashboard. Only the landing
        // view redirects, so the shared student pages (Discover, Messages, …)
        // stay reachable for them.
        if (section === "overview" && (leaderResult.groups || []).length > 0) {
          window.location.replace("/dashboard/leader");
          return;
        }
        const memberGroups = (groupResult.groups || []).map(normaliseGroup);
        setProfile(student.profile);
        setMyGroups(memberGroups);
        setWorkspaces((workspaceResult.workspaces || []).map(normaliseWorkspace));
        setUnreadNotifications(notificationResult.unreadCount || 0);
        const activeWorkspaces = (workspaceResult.workspaces || []).map(normaliseWorkspace);
        const groupSessions = await Promise.all(activeWorkspaces.map(async (workspace) => {
          const result = await apiRequest(`workspaces/${workspace.id}/sessions?scope=upcoming&limit=10`);
          return (result.sessions || []).map((session) => ({
            id: session.id,
            title: session.title,
            startsAt: session.starts_at,
            location: session.location,
            mode: session.mode,
            goingCount: session.going_count || 0,
            groupName: workspace.groupName,
          }));
        }));
        if (!active) return;
        setSessions(groupSessions.flat().sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt)));
        setLoading(false);
        // Deep link from the leader dashboard: /dashboard/groups?create=1 opens
        // the create-group flow straight away.
        if (section === "groups" && new URLSearchParams(window.location.search).get("create") === "1") {
          openGroupCreate();
        }
      } catch (error) {
        if (!active) return;
        if (error.status === 401 && error.path === "auth/me") {
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        setLoadError(error.status === 401
          ? `Your sign-in is active, but the ${error.path} request was rejected. Please try again.`
          : error.message);
        setLoading(false);
      }
    }

    loadDashboard();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (section !== "discover") return undefined;
    let active = true;
    const timeout = window.setTimeout(() => {
      const query = new URLSearchParams({ limit: "20" });
      if (search.trim()) query.set("q", search.trim());
      apiRequest(`study-groups?${query.toString()}`)
        .then((result) => {
          if (active) {
            setDiscoveredGroups((result.groups || []).map(normaliseGroup));
            setLoadedDiscoverySearch(search);
          }
        })
        .catch((error) => {
          if (active) {
            setLoadError(error.message);
            setLoadedDiscoverySearch(search);
          }
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [section, search]);

  useEffect(() => {
    function handleShortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (window.matchMedia("(max-width: 620px)").matches) {
          focusSearch();
        } else {
          topSearchRef.current?.focus();
        }
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
      window.clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  function showNotice(message) {
    window.clearTimeout(noticeTimeoutRef.current);
    setNotice(message);
    noticeTimeoutRef.current = window.setTimeout(() => setNotice(""), 2800);
  }

  function openWorkspaceCreate() {
    const firstGroup = myGroups[0];
    setWorkspaceCreateGroupId(firstGroup?.id || "");
    setWorkspaceCreateName(firstGroup ? `${firstGroup.name} study space` : "");
    setWorkspaceCreateDescription("");
    setWorkspaceCreateError("");
    setWorkspaceCreateOpen(true);
  }

  function openGroupCreate() {
    setGroupCreateCourseId(profile?.courses?.[0]?.id || "");
    setGroupCreateName("");
    setGroupCreateDescription("");
    setGroupCreateError("");
    setCreatedGroupForInvites(null);
    setInviteCandidates([]);
    setInviteSearch("");
    setInviteError("");
    setInvitedStudentIds([]);
    setGroupCreateOpen(true);
  }

  async function createStudyGroup(event) {
    event.preventDefault();
    setGroupCreateBusy(true);
    setGroupCreateError("");
    try {
      const result = await apiRequest("study-groups", {
        method: "POST",
        body: JSON.stringify({
          name: groupCreateName,
          courseId: groupCreateCourseId,
          description: groupCreateDescription,
          privacy: "REQUEST_REQUIRED",
          requireApproval: true,
          mode: "EITHER",
          minSize: 3,
          maxSize: 6,
          topicIds: [],
          schedule: [],
        }),
      });
      const createdGroup = normaliseGroup({ ...result.group, myRole: "OWNER" });
      setMyGroups((current) => [createdGroup, ...current.filter((group) => group.id !== createdGroup.id)]);
      const workspaceResult = await apiRequest("workspaces");
      setWorkspaces((workspaceResult.workspaces || []).map(normaliseWorkspace));
      setCreatedGroupForInvites(createdGroup);
      showNotice("Study group created. It can now appear in group discovery and recommendations.");
    } catch (error) {
      setGroupCreateError(error.message);
    } finally {
      setGroupCreateBusy(false);
    }
  }

  async function searchInviteCandidates(event) {
    event.preventDefault();
    if (!createdGroupForInvites) return;
    setInviteLoading(true);
    setInviteError("");
    try {
      const query = new URLSearchParams({
        courseId: createdGroupForInvites.courseId,
        excludeGroupId: createdGroupForInvites.id,
        limit: "20",
      });
      if (inviteSearch.trim()) query.set("q", inviteSearch.trim());
      const result = await apiRequest(`students/search?${query.toString()}`);
      setInviteCandidates(result.students || []);
    } catch (error) {
      setInviteError(error.message);
    } finally {
      setInviteLoading(false);
    }
  }

  async function inviteStudent(student) {
    if (!createdGroupForInvites) return;
    setInvitingStudentId(student.id);
    setInviteError("");
    try {
      await apiRequest(`study-groups/${createdGroupForInvites.id}/invite`, {
        method: "POST",
        body: JSON.stringify({ inviteeId: student.id }),
      });
      setInvitedStudentIds((current) => [...current, student.id]);
    } catch (error) {
      setInviteError(error.message);
    } finally {
      setInvitingStudentId("");
    }
  }

  async function submitWorkspaceCreate(event) {
    event.preventDefault();
    setWorkspaceCreateBusy(true);
    setWorkspaceCreateError("");
    try {
      const result = await apiRequest("workspaces", {
        method: "POST",
        body: JSON.stringify({
          groupId: workspaceCreateGroupId,
          name: workspaceCreateName,
          description: workspaceCreateDescription,
        }),
      });
      const createdWorkspace = normaliseWorkspace({
        ...result.workspace,
        can_archive: true,
        group_id: result.group.id,
        group_name: result.group.name,
        course_code: result.group.courseCode,
        course_name: result.group.courseName,
        member_count: result.group.memberCount,
        last_activity_at: result.workspace.created_at,
      });
      setWorkspaces((current) => [
        createdWorkspace,
        ...current.filter((workspace) => workspace.id !== createdWorkspace.id),
      ].sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)));
      setWorkspaceCreateOpen(false);
      showNotice("Workspace created.");
    } catch (error) {
      setWorkspaceCreateError(error.message);
    } finally {
      setWorkspaceCreateBusy(false);
    }
  }

  async function archiveWorkspace(workspace) {
    const confirmed = window.confirm(
      `Archive "${workspace.name}"? Its notes, discussions, tasks, sessions, and progress will be preserved.`,
    );
    if (!confirmed) return;

    try {
      await apiRequest(`workspaces/${workspace.id}`, { method: "DELETE" });
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
      showNotice("Workspace archived. Its contents are preserved.");
    } catch (error) {
      showNotice(error.message);
    }
  }

  function focusSearch() {
    document.querySelector("#discover")?.scrollIntoView({ behavior: "smooth", block: "center" });
    (searchRef.current || topSearchRef.current)?.focus({ preventScroll: true });
  }

  async function joinGroup(group) {
    try {
      const result = await apiRequest(`study-groups/${group.id}/join`, { method: "POST", body: "{}" });
      const joined = result.status === "JOINED";
      setNotice(joined ? "You’ve joined the study group." : "Your request to join was sent.");
      setDiscoveredGroups((current) => current.map((item) => item.id === group.id
        ? { ...item, isMember: joined, hasPendingRequest: !joined }
        : item));
      if (joined) {
        const joinedGroup = normaliseGroup({ ...group, myRole: "MEMBER", workspaceId: result.workspaceId });
        setMyGroups((current) => current.some((item) => item.id === group.id)
          ? current
          : [...current, joinedGroup]);
        if (result.workspaceId) {
          setWorkspaces((current) => current.some((item) => item.id === result.workspaceId)
            ? current
            : [
              ...current,
              normaliseWorkspace({
                id: result.workspaceId,
                name: `${joinedGroup.name} — Study Workspace`,
                group_id: joinedGroup.id,
                group_name: joinedGroup.name,
                course_code: joinedGroup.courseCode,
                course_name: joinedGroup.courseName,
                member_count: joinedGroup.memberCount,
              }),
            ]);
        }
      }
      return result;
    } catch (error) {
      setNotice(error.message);
      throw error;
    }
  }

  const updateProfile = useCallback((nextProfile) => {
    setProfile((current) => ({ ...current, ...nextProfile }));
    if (nextProfile.user) setIdentity(nextProfile.user);
  }, []);

  const updateUnreadCount = useCallback((count) => {
    setUnreadNotifications(count);
  }, []);

  async function signOut() {
    try {
      await apiRequest("auth/logout", { method: "POST", body: "{}" });
      window.location.replace("/");
    } catch (error) {
      showNotice(error.message);
    }
  }

  const pageGroups = { mine: myGroups, discovered: discoveredGroups };
  const courses = profile?.courses || [];
  const displayName = identity?.firstName || profile?.user?.firstName || "Student";
  const initials = displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  return (
    <>
    <main className="app-shell" id="overview">
      <aside className="sidebar" aria-label="Main navigation">
        <Link className="brand" href="/" aria-label="Lien home">
          <BrandLogo className="lien-logo" />
        </Link>

        {navGroups.map((group) => (
          <div className="sidebar-nav-group" key={group.label}>
            <div className="sidebar-label">{group.label}</div>
            <nav className="side-nav" aria-label={group.label.toLowerCase()}>
              {group.items.map((item) => (
                <div
                  className={`nav-link-row ${item.label === "Workspaces" ? "workspace-nav-row" : ""} ${item.label === "My Groups" ? "group-nav-row" : ""}`}
                  key={item.label}
                >
                  <Link
                    className={`nav-link ${activeNav === item.label ? "active" : ""}`}
                    href={item.href}
                    aria-current={activeNav === item.label ? "page" : undefined}
                  >
                    <Icon name={item.icon} size={18} />
                    <span>{item.label}</span>
                  </Link>
                  {item.label === "My Groups" && (
                    <div
                      className="workspace-more-wrap"
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setGroupMenuOpen(false);
                      }}
                    >
                      <button
                        className="workspace-more-button"
                        type="button"
                        aria-label="More group actions"
                        aria-haspopup="menu"
                        aria-expanded={groupMenuOpen}
                        title="More group actions"
                        onClick={() => setGroupMenuOpen((open) => !open)}
                      >
                        <Icon name="more" size={17} />
                      </button>
                      {groupMenuOpen && (
                        <div className="workspace-more-menu" role="menu">
                          <Link
                            href="/dashboard/groups"
                            role="menuitem"
                            onClick={() => setGroupMenuOpen(false)}
                          >
                            View all groups
                          </Link>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setGroupMenuOpen(false);
                              openGroupCreate();
                            }}
                          >
                            Create a group
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {item.label === "My Groups" && (
                    <button
                      className="workspace-add-button"
                      type="button"
                      aria-label="Create a study group"
                      title="Create a study group"
                      onClick={openGroupCreate}
                    >
                      <Icon name="plus" size={16} />
                    </button>
                  )}
                  {item.label === "Workspaces" && (
                    <>
                      <div
                        className="workspace-more-wrap"
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget)) setWorkspaceMenuOpen(false);
                        }}
                      >
                        <button
                          className="workspace-more-button"
                          type="button"
                          aria-label="More workspace actions"
                          aria-haspopup="menu"
                          aria-expanded={workspaceMenuOpen}
                          title="More workspace actions"
                          onClick={() => setWorkspaceMenuOpen((open) => !open)}
                        >
                          <Icon name="more" size={17} />
                        </button>
                        {workspaceMenuOpen && (
                          <div className="workspace-more-menu" role="menu">
                            <Link
                              href="/dashboard/workspaces"
                              role="menuitem"
                              onClick={() => setWorkspaceMenuOpen(false)}
                            >
                              View all workspaces
                            </Link>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setWorkspaceMenuOpen(false);
                                openWorkspaceCreate();
                              }}
                            >
                              Add a workspace
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        className="workspace-add-button"
                        type="button"
                        aria-label="Add a workspace"
                        title="Add a workspace"
                        onClick={openWorkspaceCreate}
                      >
                        <Icon name="plus" size={16} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </nav>
            {group.label === "YOUR SPACE" && workspaces.length > 0 && workspaceActions.length > 0 && (
              <nav className="workspace-feature-nav" aria-label="Workspace tools">
                {workspaceActions.map((item) => {
                  const href = `/dashboard/workspaces/${sidebarWorkspace.id}?tab=${item.tab}`;
                  const selected = section === "workspace" && workspaceTab === item.tab;
                  return (
                    <Link
                      className={`workspace-feature-link ${selected ? "selected" : ""}`}
                      href={href}
                      key={item.tab}
                      aria-current={selected ? "page" : undefined}
                    >
                      <Icon name={item.icon} size={15} />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            )}
            {group.label === "YOUR SPACE" && workspaces.length > 0 && (
              <div className="recent-workspaces">
                <span className="recent-workspaces-label">RECENT WORKSPACES</span>
                {workspaces.slice(0, 3).map((workspace) => (
                  <Link
                    className="recent-workspace-link"
                    href={`/dashboard/workspaces/${workspace.id}`}
                    key={workspace.id}
                    title={`${workspace.name} · ${workspace.groupName}`}
                  >
                    <span className="recent-workspace-dot" />
                    <span>{workspace.name}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}

        {identity?.role === "ADMIN" && (
          <div className="sidebar-nav-group">
            <div className="sidebar-label">STAFF</div>
            <nav className="side-nav" aria-label="Staff">
              <Link className={`nav-link ${activeNav === "Admin console" ? "active" : ""}`} href="/admin" aria-current={activeNav === "Admin console" ? "page" : undefined}>
                <Icon name="settings" size={18} />
                <span>Admin console</span>
              </Link>
            </nav>
          </div>
        )}

        <div className="sidebar-spacer" />
        <div className="weekly-card">
          <div className="weekly-icon"><Icon name="check" size={17} /></div>
          <p className="weekly-title">Small steps add up.</p>
          <p className="weekly-copy">{myGroups.length ? `You’re learning with ${myGroups.length} ${myGroups.length === 1 ? "study group" : "study groups"}.` : "Join a study group to start learning together."}</p>
        </div>
        <Link className="profile-row" href="/dashboard/profile">
          <Avatar initials={initials} className="profile-avatar" src={profile?.user?.avatarUrl} />
          <span className="profile-copy"><strong>{displayName}</strong><small>{profile?.academic?.programName || profile?.academic?.universityName || "Student"}</small></span>
          <Icon name="chevron" size={16} />
        </Link>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandLogo className="lien-logo" />
          </div>
          <label
            className="search-box"
            onClick={(event) => {
              if (window.matchMedia("(max-width: 620px)").matches) {
                event.preventDefault();
                focusSearch();
              }
            }}
          >
            <Icon name="search" size={18} />
            <input
              ref={topSearchRef}
              aria-label="Search courses and study groups"
              placeholder="Search courses, groups..."
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="topbar-actions">
            <ThemeToggle />
            <Link
              className="icon-button notification-button"
              aria-label={unreadNotifications ? `${unreadNotifications} unread notifications` : "No unread notifications"}
              href="/dashboard/notifications"
            >
              <Icon name="bell" size={19} />{unreadNotifications > 0 && <span className="notification-dot" />}
            </Link>
            <div
              className="profile-menu-wrap"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setProfileMenuOpen(false);
              }}
            >
              <button
                className="profile-menu-trigger"
                type="button"
                aria-label="Open profile menu"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((open) => !open)}
              >
                <Avatar initials={initials} className="top-avatar" src={identity?.avatarUrl || profile?.user?.avatarUrl} />
              </button>
              {profileMenuOpen && (
                <div className="profile-menu-dropdown" role="menu">
                  <Link
                    href="/dashboard/profile"
                    role="menuitem"
                    onClick={() => setProfileMenuOpen(false)}
                  >
                    Profile / Settings
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      signOut();
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="content-wrap">
          {loadError && <div className="dashboard-load-error" role="alert"><strong>We couldn’t load your study space.</strong><span>{loadError}</span><button type="button" onClick={() => window.location.reload()}>Try again</button></div>}
          {identity && !identity.emailVerified && <div className="email-verification-notice" role="status">Your account is ready. You can verify your email later. <Link href={`/resend-verification?email=${encodeURIComponent(identity.email)}`}>Get a verification link</Link></div>}
          {loading ? <div className="dashboard-loading" role="status">Loading your study space…</div> : loadError ? null : section === "workspace" ? (
            <StudyWorkspace
              workspaceId={workspaceId}
              initialTab={workspaceTab === "messages" ? "Group chat" : workspacePageTab?.initialTab}
              initialResourceKind={workspacePageTab?.resourceKind}
            />
          ) : section === "overview" ? (
          <>
          <section className="welcome-row">
            <div>
              <div className="eyebrow"><span className="live-dot" /> YOUR STUDY SPACE</div>
              <h1>Welcome, {displayName}</h1>
              <p className="welcome-copy">Your groups, courses, and study sessions in one place.</p>
            </div>
            <Link className="button button-primary welcome-cta" href="/dashboard/discover">
              <Icon name="plus" size={17} /> Find a study group
            </Link>
          </section>

          <section className="hero-card" aria-label="Weekly study progress">
            <div className="hero-content">
              <div className="hero-kicker">YOUR WEEKLY MOMENTUM</div>
              <h2>Learn a little<br />together.</h2>
              <p>{profile?.preferences?.weeklyGoalHours ? `Your weekly study goal is ${profile.preferences.weeklyGoalHours} hours.` : "Find a group, plan time to study, and make progress with your peers."}</p>
              <Link className="hero-link" href="/dashboard/discover">Explore study groups <Icon name="arrow" size={16} /></Link>
            </div>
            <div className="hero-progress">
              <div className="progress-ring" role="img" aria-label={`${myGroups.length} study groups`}>
                <div className="progress-ring-inner">
                  <strong>{myGroups.length}<span> groups</span></strong>
                  <small>together</small>
                </div>
              </div>
              <span className="progress-label">YOUR STUDY GROUPS</span>
              <span className="progress-caption">{courses.length} courses</span>
            </div>
            <div className="hero-decoration hero-decoration-one" />
            <div className="hero-decoration hero-decoration-two" />
          </section>

          <section className="quick-actions" aria-label="Quick actions">
            <Link className="quick-action" href="/dashboard/discover">
              <span className="quick-icon quick-icon-green"><Icon name="users" size={19} /></span>
              <span><strong>Find a group</strong><small>Learn together</small></span>
              <Icon name="chevron" size={16} />
            </Link>
            <Link className="quick-action" href="/dashboard/sessions">
              <span className="quick-icon quick-icon-yellow"><Icon name="calendar" size={19} /></span>
              <span><strong>Plan a session</strong><small>Pick a time to meet</small></span>
              <Icon name="chevron" size={16} />
            </Link>
            <Link className="quick-action" href="/dashboard/courses">
              <span className="quick-icon quick-icon-blue"><Icon name="book" size={19} /></span>
              <span><strong>My courses</strong><small>Keep goals in view</small></span>
              <Icon name="chevron" size={16} />
            </Link>
          </section>

          <StudentRecommendations compact onJoin={joinGroup} />

          <div className="dashboard-grid">
            <section className="panel groups-panel" id="groups">
              <div className="section-heading">
                <div><span className="section-overline">YOUR PEOPLE</span><h2>My study groups <span className="heading-count">{myGroups.length}</span></h2></div>
                <Link className="text-link" href="/dashboard/groups">See all <Icon name="arrow" size={15} /></Link>
              </div>
              <div className="group-list">
                {visibleGroups.map((group) => (
                  <article className="group-card" key={group.id}>
                    <div className={`course-symbol ${group.color}`}><Icon name="book" size={19} /></div>
                    <div className="group-info">
                      <h3>{group.name}</h3>
                      <p>{group.course}</p>
                      <div className="group-members">
                        <div className="avatar-stack">
                          <Avatar initials={initials} className="member-avatar member-0" />
                        </div>
                        <span>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</span>
                      </div>
                    </div>
                    <Link className="circle-arrow" href={`/dashboard/workspaces?groupId=${group.id}`} aria-label={`View workspaces for ${group.name}`}><Icon name="arrow" size={17} /></Link>
                  </article>
                ))}
                {visibleGroups.length === 0 && <p className="empty-state">You haven’t joined a group yet. <Link href="/dashboard/discover">Explore study groups</Link>.</p>}
              </div>
              <Link className="browse-groups" href="/dashboard/discover"><Icon name="plus" size={16} /> Discover more study groups</Link>
            </section>

            <section className="panel sessions-panel" id="sessions">
              <div className="section-heading">
                <div><span className="section-overline">MAKE TIME TO LEARN</span><h2>Sessions &amp; deadlines</h2></div>
                <Link className="text-link" href="/dashboard/sessions">All sessions <Icon name="arrow" size={15} /></Link>
              </div>
              {sessions.length ? sessions.slice(0, 3).map((session) => (
                <article className="session-card" key={session.id}>
                  <span className="session-accent" />
                  <div className="session-time"><Icon name="clock" size={14} /> {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startsAt))}</div>
                  <h3>{session.title}</h3>
                  <p><Icon name="users" size={14} /> {session.groupName}</p>
                  <div className="session-bottom"><span><Icon name="pin" size={14} /> {session.location || session.mode}</span><span>{session.goingCount} attending</span></div>
                </article>
              )) : <p className="empty-state">No upcoming study sessions. <Link href="/dashboard/sessions">View sessions</Link>.</p>}
            </section>

          </div>

          </>
          ) : (
            <DashboardSection section={section} search={search} setSearch={setSearch} searchRef={searchRef} groups={pageGroups} workspaces={workspaces} workspaceGroupId={workspaceGroupId} courses={courses} sessions={sessions} loading={loading || discoverLoading} onJoin={joinGroup} onArchiveWorkspace={archiveWorkspace} onCreateGroup={openGroupCreate} profile={profile} onProfileSaved={updateProfile} onNotice={showNotice} onUnreadChange={updateUnreadCount} identity={identity} initialConversationId={initialConversationId} meetingId={meetingId} />
          )}
        </div>
      </section>

      {workspaceCreateOpen && (
        <div className="workspace-modal-backdrop">
          <section className="panel workspace-create-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-create-title">
            <div className="workspace-create-heading">
              <div>
                <span className="section-overline">NEW SHARED SPACE</span>
                <h2 id="workspace-create-title">Add a workspace</h2>
              </div>
              <button
                className="workspace-modal-close"
                type="button"
                aria-label="Close"
                onClick={() => setWorkspaceCreateOpen(false)}
                disabled={workspaceCreateBusy}
              >
                <Icon name="close" size={17} />
              </button>
            </div>
            {myGroups.length ? (
              <form className="workspace-create-form" onSubmit={submitWorkspaceCreate}>
                <label>
                  Study group
                  <select
                    required
                    value={workspaceCreateGroupId}
                    onChange={(event) => {
                      const group = myGroups.find((item) => item.id === event.target.value);
                      setWorkspaceCreateGroupId(event.target.value);
                      if (group) setWorkspaceCreateName(`${group.name} study space`);
                    }}
                  >
                    {myGroups.map((group) => (
                      <option value={group.id} key={group.id}>{group.name} · {group.course}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Workspace name
                  <input
                    required
                    minLength={3}
                    maxLength={100}
                    value={workspaceCreateName}
                    onChange={(event) => setWorkspaceCreateName(event.target.value)}
                  />
                </label>
                <label>
                  Description <span>(optional)</span>
                  <textarea
                    maxLength={500}
                    rows={3}
                    value={workspaceCreateDescription}
                    onChange={(event) => setWorkspaceCreateDescription(event.target.value)}
                    placeholder="What will this workspace be used for?"
                  />
                </label>
                {workspaceCreateError && <p className="workspace-create-error" role="alert">{workspaceCreateError}</p>}
                <div className="workspace-create-actions">
                  <button className="button button-secondary" type="button" onClick={() => setWorkspaceCreateOpen(false)} disabled={workspaceCreateBusy}>Cancel</button>
                  <button className="button button-primary" type="submit" disabled={workspaceCreateBusy}>
                    {workspaceCreateBusy ? "Creating…" : "Create workspace"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="workspace-create-empty">
                <p>Join or create a study group first. Each workspace is shared with members of its group.</p>
                <Link className="button button-primary" href="/dashboard/discover" onClick={() => setWorkspaceCreateOpen(false)}>Discover groups</Link>
              </div>
            )}
          </section>
        </div>
      )}

      {groupCreateOpen && (
        <div className="workspace-modal-backdrop">
          <section className="panel workspace-create-modal group-create-modal" role="dialog" aria-modal="true" aria-labelledby="group-create-title">
            <div className="workspace-create-heading">
              <div>
                <span className="section-overline">{createdGroupForInvites ? "GROW YOUR STUDY CREW" : "START A STUDY CREW"}</span>
                <h2 id="group-create-title">{createdGroupForInvites ? "Invite classmates" : "Create a study group"}</h2>
              </div>
              <button
                className="workspace-modal-close"
                type="button"
                aria-label="Close"
                onClick={() => setGroupCreateOpen(false)}
                disabled={groupCreateBusy || Boolean(invitingStudentId)}
              >
                <Icon name="close" size={17} />
              </button>
            </div>
            {createdGroupForInvites ? (
              <div className="group-invite-step">
                <p className="group-create-intro">
                  <strong>{createdGroupForInvites.name}</strong> is ready. It’s discoverable by students who share the course, and you can invite classmates directly too.
                </p>
                <form className="group-invite-search" onSubmit={searchInviteCandidates}>
                  <input
                    aria-label="Search classmates"
                    maxLength={120}
                    value={inviteSearch}
                    onChange={(event) => setInviteSearch(event.target.value)}
                    placeholder="Search classmates by name"
                  />
                  <button className="button button-secondary" type="submit" disabled={inviteLoading}>
                    {inviteLoading ? "Searching…" : "Search"}
                  </button>
                </form>
                {inviteError && <p className="workspace-create-error" role="alert">{inviteError}</p>}
                <div className="group-invite-results">
                  {inviteCandidates.map((student) => (
                    <article className="group-invite-candidate" key={student.id}>
                      <span className="group-invite-avatar">
                        {[student.firstName?.[0], student.lastName?.[0]].filter(Boolean).join("").toUpperCase()}
                      </span>
                      <span className="group-invite-person">
                        <strong>{student.firstName} {student.lastName}</strong>
                        <small>{student.programName || `${student.sharedCourses || 0} shared courses`}</small>
                      </span>
                      <button
                        className="button button-secondary group-invite-button"
                        type="button"
                        disabled={!student.canInvite || invitedStudentIds.includes(student.id) || invitingStudentId === student.id}
                        title={student.inviteBlockedReason || undefined}
                        onClick={() => inviteStudent(student)}
                      >
                        {invitedStudentIds.includes(student.id) ? "Invited" : invitingStudentId === student.id ? "Sending…" : student.canInvite ? "Invite" : "Unavailable"}
                      </button>
                    </article>
                  ))}
                  {!inviteLoading && inviteCandidates.length === 0 && (
                    <p className="empty-state">Search for classmates to invite them. Students control whether they appear in discovery and accept invitations.</p>
                  )}
                </div>
                <div className="workspace-create-actions">
                  <button className="button button-primary" type="button" onClick={() => setGroupCreateOpen(false)}>Done</button>
                </div>
              </div>
            ) : profile?.courses?.length ? (
              <form className="workspace-create-form" onSubmit={createStudyGroup}>
                <label>
                  Group name
                  <input
                    required
                    minLength={3}
                    maxLength={80}
                    value={groupCreateName}
                    onChange={(event) => setGroupCreateName(event.target.value)}
                    placeholder="e.g. Calculus study crew"
                  />
                </label>
                <label>
                  Course
                  <select required value={groupCreateCourseId} onChange={(event) => setGroupCreateCourseId(event.target.value)}>
                    {profile.courses.map((course) => (
                      <option value={course.id} key={course.id}>{course.courseCode} · {course.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Description <span>(optional)</span>
                  <textarea
                    maxLength={500}
                    rows={3}
                    value={groupCreateDescription}
                    onChange={(event) => setGroupCreateDescription(event.target.value)}
                    placeholder="What would you like to study together?"
                  />
                </label>
                <p className="group-create-hint">Your group will be open to discovery and AI recommendations for students studying this course. It will have a shared workspace automatically.</p>
                {groupCreateError && <p className="workspace-create-error" role="alert">{groupCreateError}</p>}
                <div className="workspace-create-actions">
                  <button className="button button-secondary" type="button" onClick={() => setGroupCreateOpen(false)} disabled={groupCreateBusy}>Cancel</button>
                  <button className="button button-primary" type="submit" disabled={groupCreateBusy || !groupCreateCourseId}>
                    {groupCreateBusy ? "Creating…" : "Create group"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="workspace-create-empty">
                <p>Add a course to your profile before creating a study group, so classmates can find it through discovery and recommendations.</p>
                <Link className="button button-primary" href="/dashboard/profile" onClick={() => setGroupCreateOpen(false)}>Add courses to profile</Link>
              </div>
            )}
          </section>
        </div>
      )}

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {[
          { label: "Home", icon: "home", href: "/dashboard", active: "Dashboard" },
          { label: "Groups", icon: "users", href: "/dashboard/groups", active: "My Groups" },
          { label: "Workspaces", icon: "workspace", href: "/dashboard/workspaces", active: "Workspaces" },
          { label: "Messages", icon: "chat", href: "/dashboard/messages", active: "Messages" },
          { label: "Discover", icon: "search", href: "/dashboard/discover", active: "Discover Groups" },
        ].map((item) => (
          <a
            href={item.href}
            key={item.label}
            className={`mobile-nav-link ${activeNav === item.active ? "selected" : ""}`}
          >
            <Icon name={item.icon} size={19} /><span>{item.label}</span>
          </a>
        ))}
      </nav>
      <div className={`toast ${notice ? "visible" : ""}`} role="status" aria-live="polite">{notice}</div>
      <FloatingAssistant />
    </main>
    </>
  );
}
