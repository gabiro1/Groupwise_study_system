"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { askAssistant, getAiStatus } from "./aiClient";
import GroupLeaderTools from "./GroupLeaderTools";
import MeetingsLazy from "./meetings/MeetingsLazy";
import {
  AnswerSources,
  FeedbackButtons,
  SourceModeNotice,
  SourceModeSelector,
} from "./AiAnswerSources";

const TABS = [
  "Overview",
  "Members",
  "Messages",
  "Study Sessions",
  "Meetings",
  "Topics",
  "Tasks",
  "Resources",
  "Shared Notes",
  "Progress",
  "AI Assistant",
  "Settings",
];

const TAB_ALIASES = {
  overview: "Overview",
  members: "Members",
  messages: "Messages",
  discussions: "Messages",
  sessions: "Study Sessions",
  "study-sessions": "Study Sessions",
  plans: "Tasks",
  tasks: "Tasks",
  resources: "Resources",
  notes: "Shared Notes",
  "shared-notes": "Shared Notes",
  progress: "Progress",
  ai: "AI Assistant",
  "ai-assistant": "AI Assistant",
  settings: "Settings",
};

function tabName(value) {
  if (!value) return "Overview";
  const decoded = String(value).replaceAll("+", " ");
  return TABS.includes(decoded) ? decoded : TAB_ALIASES[decoded.toLowerCase()] || "Overview";
}

async function apiRequest(path, options = {}) {
  const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body && !isMultipart ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || "We could not load this study group.");
    error.status = response.status;
    throw error;
  }
  return result.data;
}

function valueOf(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

function readableStatus(value) {
  return String(value || "").replaceAll("_", " ").toLowerCase();
}

function formatDate(value, options = { dateStyle: "medium" }) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString(undefined, options);
}

function memberName(member) {
  return [member.firstName || member.first_name, member.lastName || member.last_name]
    .filter(Boolean)
    .join(" ") || "Group member";
}

function initials(member) {
  return memberName(member)
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function GroupSkeleton() {
  return (
    <div className="workspace-skeleton" role="status" aria-label="Loading study group">
      <span className="sr-only">Loading study group...</span>
      <div className="workspace-skeleton-heading"><span /><span /><span /></div>
      <div className="workspace-skeleton-tabs"><span /><span /><span /><span /><span /></div>
      <div className="workspace-skeleton-grid"><span /><span /><span /></div>
      <div className="workspace-skeleton-list"><span /><span /><span /><span /></div>
    </div>
  );
}

function EmptyState({ children }) {
  return <p className="empty-state">{children}</p>;
}

function MemberList({ members, currentUserId }) {
  if (!members?.length) return <EmptyState>No active members are listed yet.</EmptyState>;
  return (
    <div className="workspace-data-list">
      {members.map((member) => (
        <article className="workspace-list-item group-member-list-item" key={member.id}>
          <span className="group-invite-avatar" aria-hidden="true">{initials(member)}</span>
          <div>
            <strong>{memberName(member)}{member.id === currentUserId ? " (you)" : ""}</strong>
            <span>{String(member.role || "MEMBER").toLowerCase()} {member.joined_at || member.joinedAt ? `· joined ${formatDate(member.joined_at || member.joinedAt)}` : ""}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function GroupSettings({ group, onSaved }) {
  const isOwner = group.viewer?.role === "OWNER";
  const [form, setForm] = useState(() => ({
    name: group.name || "",
    description: group.description || "",
    mode: group.mode || "EITHER",
    privacy: group.privacy || "REQUEST_REQUIRED",
    requireApproval: group.requireApproval !== false,
    minSize: group.minSize ?? 3,
    maxSize: group.maxSize ?? 6,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
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
      setNotice("Group settings saved.");
      onSaved?.();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel feature-form" aria-label="Group settings">
      <div className="section-heading">
        <div><span className="section-overline">GROUP PROFILE</span><h2>Settings</h2></div>
        <span className="leader-chip">{String(group.viewer?.role || "LEADER").toLowerCase()}</span>
      </div>
      {error && <p className="feature-error" role="alert">{error}</p>}
      {notice && <p className="feature-success" role="status">{notice}</p>}
      <form className="feature-form-grid" onSubmit={save}>
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
            <option value="PUBLIC">Public</option>
            <option value="REQUEST_REQUIRED">Request to join</option>
            <option value="INVITE_ONLY">Invite only</option>
          </select>
        </label>
        <label className="workspace-repeat"><input type="checkbox" checked={form.requireApproval} disabled={!isOwner} onChange={(event) => setForm({ ...form, requireApproval: event.target.checked })} />Require approval to join</label>
        <label className="form-span">Description<textarea rows={3} maxLength={1500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button>
      </form>
      {!isOwner && <p className="feature-muted">Only the owner can change privacy, approval, and size limits.</p>}
    </section>
  );
}

function GroupSharePanel({ groupId, group }) {
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [invitedIds, setInvitedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const shareLink = typeof window === "undefined"
    ? `/dashboard/groups/${groupId}`
    : `${window.location.origin}/dashboard/groups/${groupId}`;

  async function searchStudents(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams({
        courseId: group.courseId,
        excludeGroupId: groupId,
        limit: "20",
      });
      if (search.trim()) params.set("q", search.trim());
      const result = await apiRequest(`students/search?${params.toString()}`);
      setCandidates(result.students || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function invite(student) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(`study-groups/${groupId}/invite`, {
        method: "POST",
        body: JSON.stringify({ inviteeId: student.id }),
      });
      setInvitedIds((current) => [...current, student.id]);
      setNotice(`Invitation sent to ${memberName(student)}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    setError("");
    try {
      await navigator.clipboard.writeText(shareLink);
      setNotice("Group link copied. Send it to a classmate.");
    } catch {
      setNotice("Copy the group link from the field below and send it to a classmate.");
    }
  }

  return (
    <section className="panel feature-form group-share-panel" aria-label="Share study group">
      <div className="section-heading">
        <div>
          <span className="section-overline">GROW THE GROUP</span>
          <h2>Share {group.name}</h2>
        </div>
      </div>
      <p className="feature-muted">Invite classmates directly or share this link so they can view the group and request to join.</p>
      <div className="group-share-link-row">
        <input aria-label="Study group link" value={shareLink} readOnly />
        <button className="button button-secondary" type="button" onClick={copyLink}>Copy link</button>
      </div>
      <form className="group-invite-search" onSubmit={searchStudents}>
        <input aria-label="Search students to invite" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search classmates by name" />
        <button className="button button-secondary" type="submit" disabled={busy}>{busy ? "Searching..." : "Find classmates"}</button>
      </form>
      {error && <p className="feature-error" role="alert">{error}</p>}
      {notice && <p className="feature-success" role="status">{notice}</p>}
      {candidates.length > 0 && (
        <div className="group-invite-results">
          {candidates.map((student) => (
            <article className="group-invite-candidate" key={student.id}>
              <span className="group-invite-avatar">{initials(student)}</span>
              <span className="group-invite-person"><strong>{memberName(student)}</strong><small>{student.programName || `${student.sharedCourses || 0} shared courses`}</small></span>
              <button className="button button-secondary group-invite-button" type="button" disabled={busy || invitedIds.includes(student.id) || student.canInvite === false} onClick={() => invite(student)}>
                {invitedIds.includes(student.id) ? "Invited" : student.canInvite === false ? "Unavailable" : "Invite"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default function StudyWorkspace({ groupId, initialTab = "Overview", initialResourceKind, meetingId = null }) {
  const [activeTab, setActiveTab] = useState(tabName(initialTab));
  const [group, setGroup] = useState(null);
  const [overview, setOverview] = useState(null);
  const [plans, setPlans] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [resources, setResources] = useState([]);
  const [progress, setProgress] = useState([]);
  const [feedbackSummary, setFeedbackSummary] = useState(null);
  const [currentUserId, setCurrentUserId] = useState("");
  const [resourceKindFilter, setResourceKindFilter] = useState(initialResourceKind || "ALL");
  const [aiMessages, setAiMessages] = useState([]);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiAvailable, setAiAvailable] = useState(null);
  const [aiSourceMode, setAiSourceMode] = useState("LOCAL");
  const [aiQuestion, setAiQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [planForm, setPlanForm] = useState({ title: "", description: "", deadline: "" });
  const [taskForm, setTaskForm] = useState({ title: "", description: "", priority: "MEDIUM" });
  const [sessionForm, setSessionForm] = useState({ title: "", startsAt: "", endsAt: "", mode: "PHYSICAL", location: "", meetingUrl: "" });
  const [messageText, setMessageText] = useState("");
  const [resourceForm, setResourceForm] = useState({ title: "", description: "", kind: "LINK", externalUrl: "", content: "", visibility: "GROUP", file: null });
  const [progressForm, setProgressForm] = useState({ topicId: "", status: "LEARNING", confidence: "0.5" });
  const [feedbackForm, setFeedbackForm] = useState({
    goalsCompatible: 3,
    skillsComplementary: 3,
    scheduleWorked: 3,
    productive: 3,
    overallRating: 3,
    wouldRepeat: true,
    comment: "",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [authData, groupData] = await Promise.all([
        apiRequest("auth/me"),
        apiRequest(`study-groups/${groupId}`),
      ]);
      const nextGroup = groupData.group;
      setCurrentUserId(authData.user?.id || "");
      setGroup(nextGroup);
      setMembers(nextGroup?.members || []);

      if (!nextGroup?.viewer?.isMember) {
        throw new Error("You need to be a member of this study group to open its shared tools.");
      }

      const [collaboration, planData, taskData, sessionData, messageData, resourceData, progressData, feedbackData] = await Promise.all([
        apiRequest(`study-groups/${groupId}/overview`),
        apiRequest(`study-groups/${groupId}/plans`),
        apiRequest(`study-groups/${groupId}/tasks?limit=100`),
        apiRequest(`study-groups/${groupId}/sessions?scope=all&limit=50`),
        apiRequest(`study-groups/${groupId}/messages?limit=50`),
        apiRequest(`study-groups/${groupId}/resources?limit=50`),
        apiRequest(`study-groups/${groupId}/progress`),
        apiRequest(`study-groups/${groupId}/feedback`),
      ]);
      setOverview(collaboration);
      setPlans(planData.plans || []);
      setTasks(taskData.tasks || []);
      setSessions(sessionData.sessions || []);
      setMessages(messageData.messages || []);
      setResources(resourceData.resources || []);
      setProgress(progressData.progress || collaboration.progress || []);
      setFeedbackSummary(feedbackData);
      setProgressForm((current) => current.topicId
        ? current
        : { ...current, topicId: nextGroup.topics?.[0]?.id || "" });
      if (feedbackData.ownFeedback) {
        const own = feedbackData.ownFeedback;
        setFeedbackForm((current) => ({
          ...current,
          goalsCompatible: own.goals_compatible ?? own.goalsCompatible ?? current.goalsCompatible,
          skillsComplementary: own.skills_complementary ?? own.skillsComplementary ?? current.skillsComplementary,
          scheduleWorked: own.schedule_worked ?? own.scheduleWorked ?? current.scheduleWorked,
          productive: own.productive ?? current.productive,
          overallRating: own.overall_rating ?? own.overallRating ?? current.overallRating,
          wouldRepeat: own.would_repeat ?? own.wouldRepeat ?? current.wouldRepeat,
          comment: own.comment || "",
        }));
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load the selected group when its route changes
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (activeTab !== "AI Assistant") return undefined;
    let active = true;
    getAiStatus()
      .then((data) => { if (active) setAiStatus(data); })
      .catch(() => { if (active) setAiStatus(null); });
    return () => { active = false; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "Messages") return undefined;
    let active = true;
    const interval = window.setInterval(() => {
      apiRequest(`study-groups/${groupId}/messages?limit=50`)
        .then((data) => { if (active) setMessages(data.messages || []); })
        .catch((requestError) => { if (active) setError(requestError.message); });
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeTab, groupId]);

  function selectTab(tab) {
    setActiveTab(tab);
    setResourceKindFilter(tab === "Shared Notes" ? "NOTE" : "ALL");
  }

  async function submit(path, body, successMessage) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body) });
      setNotice(successMessage);
      await refresh();
      return true;
    } catch (requestError) {
      setError(requestError.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createPlan(event) {
    event.preventDefault();
    const saved = await submit(`study-groups/${groupId}/plans`, {
      ...planForm,
      deadline: planForm.deadline || null,
      topics: [],
    }, "Study plan created.");
    if (saved) setPlanForm({ title: "", description: "", deadline: "" });
  }

  async function createTask(event) {
    event.preventDefault();
    const saved = await submit(`study-groups/${groupId}/tasks`, taskForm, "Task added to the group board.");
    if (saved) setTaskForm({ title: "", description: "", priority: "MEDIUM" });
  }

  async function changeTaskStatus(task) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`study-groups/${groupId}/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: task.status === "COMPLETED" ? "TODO" : "COMPLETED" }),
      });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function changePlanStatus(plan, status) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`study-groups/${groupId}/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createSession(event) {
    event.preventDefault();
    const saved = await submit(`study-groups/${groupId}/sessions`, {
      ...sessionForm,
      startsAt: new Date(sessionForm.startsAt).toISOString(),
      endsAt: new Date(sessionForm.endsAt).toISOString(),
      location: sessionForm.location || null,
      meetingUrl: sessionForm.meetingUrl || null,
      agenda: "",
      attendanceTracked: true,
    }, "Study session scheduled.");
    if (saved) setSessionForm({ title: "", startsAt: "", endsAt: "", mode: "PHYSICAL", location: "", meetingUrl: "" });
  }

  async function rsvp(session, rsvpValue) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`study-groups/${groupId}/sessions/rsvp`, {
        method: "POST",
        body: JSON.stringify({ sessionId: session.id, rsvp: rsvpValue }),
      });
      await refresh();
      setNotice("Your response has been saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelSession(session) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`study-groups/${groupId}/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ status: "CANCELLED" }) });
      await refresh();
      setNotice("Study session cancelled.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const content = messageText.trim();
    if (!content) return;
    const saved = await submit(`study-groups/${groupId}/messages`, { body: content, kind: "TEXT" }, "Message sent.");
    if (saved) setMessageText("");
  }

  async function createResource(event) {
    event.preventDefault();
    const body = new FormData();
    body.append("title", resourceForm.title);
    body.append("description", resourceForm.description);
    body.append("kind", resourceForm.kind);
    body.append("visibility", resourceForm.visibility);
    if (resourceForm.kind === "LINK") body.append("externalUrl", resourceForm.externalUrl);
    if (resourceForm.kind === "NOTE") body.append("content", resourceForm.content);
    if (resourceForm.kind === "FILE" && resourceForm.file) body.append("file", resourceForm.file);
    const saved = await submit(`study-groups/${groupId}/resources`, body, "Resource shared with your group.");
    if (saved) setResourceForm({ title: "", description: "", kind: "LINK", externalUrl: "", content: "", visibility: "GROUP", file: null });
  }

  async function askAi(event) {
    event.preventDefault();
    const question = aiQuestion.trim();
    if (!question) return;
    setBusy(true);
    setError("");
    try {
      const response = await askAssistant({ groupId, message: question, resourceIds: [], useGroupContext: true, sourceMode: aiSourceMode });
      setAiAvailable(response.available);
      setAiMessages((current) => [
        ...current,
        { role: "user", content: question },
        {
          role: "assistant",
          content: response.answer || response.message || "I could not find an answer in your group's shared study material.",
          sources: response.sources || [],
          searches: response.searches || [],
          limitations: response.limitations || [],
          sourcesDisagree: response.sourcesDisagree,
          sourceMode: response.sourceMode || aiSourceMode,
          feedback: null,
          showEvidence: true,
        },
      ]);
      setAiQuestion("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateProgress(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest(`study-groups/${groupId}/progress`, {
        method: "PUT",
        body: JSON.stringify({
          topicId: progressForm.topicId,
          status: progressForm.status,
          confidence: Number(progressForm.confidence),
        }),
      });
      setNotice("Group progress updated.");
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitFeedback(event) {
    event.preventDefault();
    const saved = await submit(`study-groups/${groupId}/feedback`, {
      ...feedbackForm,
      goalsCompatible: Number(feedbackForm.goalsCompatible),
      skillsComplementary: Number(feedbackForm.skillsComplementary),
      scheduleWorked: Number(feedbackForm.scheduleWorked),
      productive: Number(feedbackForm.productive),
      overallRating: Number(feedbackForm.overallRating),
      comment: feedbackForm.comment || null,
    }, "Thanks for sharing feedback about your group.");
    if (saved) setFeedbackForm((current) => ({ ...current, comment: "" }));
  }

  if (loading && !group) return <section className="section-page workspace-page"><GroupSkeleton /></section>;

  const manager = Boolean(group?.viewer?.canModerate);
  const topics = group?.topics || [];
  const visibleResources = resourceKindFilter === "ALL" ? resources : resources.filter((resource) => resource.kind === resourceKindFilter);
  const upcomingSessions = sessions.filter((session) => valueOf(session, "status", "status") === "SCHEDULED");
  const openTasks = tasks.filter((task) => valueOf(task, "status", "status") !== "COMPLETED");
  const collaboration = overview || {};

  return (
    <section className="section-page workspace-page" aria-labelledby="group-heading">
      <Link className="back-link" href="/dashboard/groups">Back to my study groups</Link>
      {error && <div className="feature-error" role="alert">{error}<button type="button" onClick={refresh}>Try again</button></div>}
      {notice && <div className="feature-success" role="status">{notice}</div>}
      {group && (
        <>
          <div className="section-page-heading">
            <span className="section-overline">STUDY GROUP · {group.courseCode || group.courseName || "LEARNING TOGETHER"}</span>
            <h1 id="group-heading">{group.name}</h1>
            <p>{group.description || "Plan your learning together, coordinate study time, and keep progress visible."}</p>
            <div className="group-header-meta">
              <span>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</span>
              {group.viewer?.role && <span>{String(group.viewer.role).toLowerCase()}</span>}
              {group.goalLabel && <span>{group.goalLabel}</span>}
            </div>
          </div>

          {group.viewer?.isMember && (
            <div className="workspace-tabs group-tab-strip" role="tablist" aria-label="Study group navigation">
              {TABS.map((tab) => (
                <button type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "selected" : ""} key={tab} onClick={() => selectTab(tab)}>{tab}</button>
              ))}
            </div>
          )}

          {group.viewer?.isMember && activeTab === "Overview" && (
            <div className="workspace-overview-grid">
              <section className="panel workspace-summary">
                <span className="section-overline">GROUP AT A GLANCE</span>
                <h2>Keep learning moving</h2>
                <p>{plans.filter((plan) => valueOf(plan, "status", "status") !== "COMPLETED").length} active plans · {openTasks.length} open tasks · {upcomingSessions.length} scheduled sessions</p>
                <div className="workspace-shortcuts">
                  {["Members", "Discussions", "Study Sessions", "Tasks", "Resources", "Shared Notes", "Progress", "AI Assistant"].map((tab) => <button type="button" key={tab} onClick={() => selectTab(tab)}>{tab} -&gt;</button>)}
                </div>
              </section>
              <section className="panel workspace-overview-list">
                <div className="section-heading"><div><span className="section-overline">UP NEXT</span><h2>Upcoming sessions</h2></div></div>
                {(collaboration.upcomingSessions || upcomingSessions).length === 0 && <EmptyState>No sessions scheduled yet.</EmptyState>}
                {(collaboration.upcomingSessions || upcomingSessions).slice(0, 4).map((session) => <article className="workspace-list-item" key={session.id}><strong>{session.title}</strong><span>{formatDate(valueOf(session, "startsAt", "starts_at"), { dateStyle: "medium", timeStyle: "short" })} · {valueOf(session, "goingCount", "going_count") || 0} going</span></article>)}
              </section>
              <section className="panel workspace-overview-list">
                <div className="section-heading"><div><span className="section-overline">GROUP FOCUS</span><h2>Learning progress</h2></div></div>
                {progress.length === 0 && <EmptyState>Update progress to make it easier to decide what to study next.</EmptyState>}
                {progress.slice(0, 5).map((item) => <article className="workspace-list-item" key={item.topicId || item.topic_id}><strong>{item.topicName || item.topic_name}</strong><span>{readableStatus(item.status)}{item.confidence !== null && item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}</span></article>)}
              </section>
            </div>
          )}
          {group.viewer?.isMember && manager && activeTab === "Overview" && (
            <GroupSharePanel groupId={groupId} group={group} />
          )}

          {group.viewer?.isMember && activeTab === "Members" && (
            <section className="panel feature-form">
              <div className="section-heading"><div><span className="section-overline">GROUP ROSTER</span><h2>Members <span className="heading-count">{members.length}</span></h2></div></div>
              <MemberList members={members} currentUserId={currentUserId} />
            </section>
          )}

          {group.viewer?.isMember && activeTab === "Messages" && (
            <section className="panel workspace-chat">
              <div className="section-heading"><div><span className="section-overline">GROUP MESSAGES</span><h2>{group.name}</h2></div></div>
              <div className="workspace-bubble-list" aria-live="polite">
                {messages.length === 0 && <EmptyState>Start the conversation by sharing a question or what you plan to study next.</EmptyState>}
                {messages.map((message) => {
                  const senderName = memberName({ first_name: message.first_name, last_name: message.last_name });
                  const mine = Boolean(currentUserId) && message.author_id === currentUserId;
                  return (
                    <div className={`chat-bubble-row${mine ? " is-mine" : ""}`} key={message.id}>
                      <span className="chat-avatar" aria-hidden="true">{initials({ first_name: message.first_name, last_name: message.last_name })}</span>
                      <div className="chat-bubble">
                        <div className="chat-bubble-meta"><strong>{mine ? "You" : senderName}</strong><time>{formatDate(message.created_at, { dateStyle: "short", timeStyle: "short" })}</time></div>
                        <p>{message.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <form className="workspace-message-form" onSubmit={sendMessage}>
                <label className="sr-only" htmlFor="group-message">Write a group message</label>
                <textarea id="group-message" rows={2} maxLength={4000} value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Write a message to your group..." onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} />
                <button className="button button-primary" disabled={busy || !messageText.trim()}>Send</button>
              </form>
            </section>
          )}

          {group.viewer?.isMember && activeTab === "Study Sessions" && (
            <div className="workspace-columns">
              {manager && <section className="panel feature-form">
                <h2>Schedule a study session</h2>
                <form className="feature-form-grid" onSubmit={createSession}>
                  <label className="form-span">Session title<input required value={sessionForm.title} onChange={(event) => setSessionForm({ ...sessionForm, title: event.target.value })} /></label>
                  <label>Starts<input required type="datetime-local" value={sessionForm.startsAt} onChange={(event) => setSessionForm({ ...sessionForm, startsAt: event.target.value })} /></label>
                  <label>Ends<input required type="datetime-local" value={sessionForm.endsAt} onChange={(event) => setSessionForm({ ...sessionForm, endsAt: event.target.value })} /></label>
                  <label>Format<select value={sessionForm.mode} onChange={(event) => setSessionForm({ ...sessionForm, mode: event.target.value })}><option value="ONLINE">Online</option><option value="PHYSICAL">In person</option></select></label>
                  <label>Location<input value={sessionForm.location} onChange={(event) => setSessionForm({ ...sessionForm, location: event.target.value })} /></label>
                  {sessionForm.mode === "ONLINE" && <label>Meeting link<input required type="url" value={sessionForm.meetingUrl} onChange={(event) => setSessionForm({ ...sessionForm, meetingUrl: event.target.value })} placeholder="https://" /></label>}
                  <button className="button button-primary" disabled={busy}>Schedule session</button>
                </form>
              </section>}
              <section className="panel feature-form">
                <h2>Study sessions</h2>
                {sessions.length === 0 && <EmptyState>No sessions yet. {manager ? "Schedule the first one for your group." : "Your group leader has not scheduled one yet."}</EmptyState>}
                <div className="workspace-data-list">
                  {sessions.map((session) => {
                    const status = valueOf(session, "status", "status");
                     return <article className="workspace-list-item" key={session.id}><strong>{session.title}</strong><span>{formatDate(valueOf(session, "startsAt", "starts_at"), { dateStyle: "medium", timeStyle: "short" })} · {readableStatus(session.mode)} · {readableStatus(status)}</span>{session.location && <span>{session.location}</span>}{status === "SCHEDULED" && <div className="session-rsvp-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => rsvp(session, "GOING")}>I&apos;m going</button><button type="button" className="text-link-button" disabled={busy} onClick={() => rsvp(session, "MAYBE")}>Maybe</button>{manager && <button type="button" className="text-link-button" disabled={busy} onClick={() => cancelSession(session)}>Cancel session</button>}</div>}</article>;
                  })}
                </div>
              </section>
            </div>
          )}

          {group.viewer?.isMember && activeTab === "Meetings" && (
            <MeetingsLazy groupId={groupId} group={group} meetingId={meetingId} />
          )}

          {group.viewer?.isMember && activeTab === "Topics" && (
            <section className="panel feature-form">
              <div className="section-heading"><div><span className="section-overline">GROUP CURRICULUM</span><h2>Topics <span className="heading-count">{topics.length}</span></h2></div></div>
              {topics.length === 0 ? <EmptyState>No topics have been added to this group yet.</EmptyState> : <div className="workspace-data-list">{topics.map((topic) => <article className="workspace-list-item" key={topic.id}><strong>{topic.name}</strong><span>{topic.focus_weight || topic.focusWeight ? `Focus ${topic.focus_weight || topic.focusWeight}/5` : "Group topic"}</span></article>)}</div>}
            </section>
          )}

          {group.viewer?.isMember && activeTab === "Tasks" && (
            <div className="workspace-columns">
              {manager && <section className="panel feature-form">
                <h2>Create a study plan</h2>
                <form className="feature-form-grid" onSubmit={createPlan}>
                  <label className="form-span">Plan title<input required minLength={3} maxLength={120} value={planForm.title} onChange={(event) => setPlanForm({ ...planForm, title: event.target.value })} /></label>
                  <label className="form-span">What will the group focus on?<textarea rows={3} maxLength={500} value={planForm.description} onChange={(event) => setPlanForm({ ...planForm, description: event.target.value })} /></label>
                  <label>Target date<input type="date" value={planForm.deadline} onChange={(event) => setPlanForm({ ...planForm, deadline: event.target.value })} /></label>
                  <button className="button button-primary" disabled={busy}>Create plan</button>
                </form>
              </section>}
              <section className="panel feature-form">
                <h2>Plans and tasks</h2>
                <div className="workspace-data-list">
                  {plans.length === 0 && <EmptyState>No study plans yet.</EmptyState>}
                  {plans.map((plan) => <article className="workspace-list-item" key={plan.id}><strong>{plan.title}</strong><span>{readableStatus(plan.status)}{plan.deadline ? ` · due ${formatDate(plan.deadline)}` : ""}</span>{plan.description && <p>{plan.description}</p>}{manager && plan.status !== "COMPLETED" && <button className="text-link-button" type="button" disabled={busy} onClick={() => changePlanStatus(plan, "COMPLETED")}>Mark plan complete</button>}</article>)}
                </div>
              </section>
              {manager && <section className="panel feature-form">
                <h2>Add a task</h2>
                <form className="feature-form-grid" onSubmit={createTask}>
                  <label className="form-span">Task title<input required minLength={2} maxLength={160} value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} /></label>
                  <label className="form-span">Details<textarea rows={2} maxLength={500} value={taskForm.description} onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })} /></label>
                  <label>Priority<select value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: event.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
                  <button className="button button-primary" disabled={busy}>Add task</button>
                </form>
              </section>}
              <section className="panel feature-form">
                <h2>Task board</h2>
                {tasks.length === 0 && <EmptyState>Your group has no tasks yet.</EmptyState>}
                <div className="workspace-data-list">{tasks.map((task) => <article className="workspace-list-item task-row" key={task.id}><div><strong>{task.title}</strong><span>{readableStatus(task.status)} · {readableStatus(task.priority)}{task.due_at ? ` · due ${formatDate(task.due_at)}` : ""}</span></div><button type="button" className="button button-secondary" disabled={busy} onClick={() => changeTaskStatus(task)}>{task.status === "COMPLETED" ? "Reopen" : "Complete"}</button></article>)}</div>
              </section>
            </div>
          )}

          {group.viewer?.isMember && ["Resources", "Shared Notes"].includes(activeTab) && (
            <div className="workspace-columns">
              {manager && <section className="panel feature-form">
                <h2>Share a study resource</h2>
                <p className="feature-muted">Share a useful link, note, or file with your group.</p>
                <form className="feature-form-grid" onSubmit={createResource}>
                  <label className="form-span">Title<input required maxLength={160} value={resourceForm.title} onChange={(event) => setResourceForm({ ...resourceForm, title: event.target.value })} /></label>
                  <label>Resource type<select value={resourceForm.kind} onChange={(event) => setResourceForm({ ...resourceForm, kind: event.target.value, file: null })}><option value="LINK">Web link</option><option value="NOTE">Text note</option><option value="FILE">Upload file</option></select></label>
                  <label>Visibility<select value={resourceForm.visibility} onChange={(event) => setResourceForm({ ...resourceForm, visibility: event.target.value })}><option value="GROUP">Group</option><option value="PRIVATE">Only me</option></select></label>
                  <label className="form-span">Description<textarea rows={2} maxLength={500} value={resourceForm.description} onChange={(event) => setResourceForm({ ...resourceForm, description: event.target.value })} /></label>
                  {resourceForm.kind === "LINK" ? <label className="form-span">URL<input required type="url" maxLength={1000} value={resourceForm.externalUrl} onChange={(event) => setResourceForm({ ...resourceForm, externalUrl: event.target.value })} placeholder="https://" /></label> : resourceForm.kind === "NOTE" ? <label className="form-span">Note content<textarea required rows={5} maxLength={50000} value={resourceForm.content} onChange={(event) => setResourceForm({ ...resourceForm, content: event.target.value })} /></label> : <label className="form-span">File<input required type="file" onChange={(event) => setResourceForm({ ...resourceForm, file: event.target.files?.[0] || null })} /><small className="feature-muted">PDF, documents, spreadsheets, images, TXT, or CSV up to 10 MB</small></label>}
                  <button className="button button-primary" disabled={busy}>Share resource</button>
                </form>
              </section>}
              <section className="panel feature-form">
                <h2>{activeTab === "Shared Notes" ? "Shared study notes" : "Shared resources"}</h2>
                {visibleResources.length === 0 && <EmptyState>{activeTab === "Shared Notes" ? "Your group has not shared any study notes yet." : "Your group has not shared any study resources yet."}</EmptyState>}
                <div className="workspace-data-list">{visibleResources.map((resource) => <article className="workspace-list-item" key={resource.id}><strong>{resource.title}</strong><span>{readableStatus(resource.kind)} · {readableStatus(resource.visibility)}{resource.uploader_first_name ? ` · shared by ${resource.uploader_first_name}` : ""}</span>{resource.description && <p>{resource.description}</p>}{resource.kind === "LINK" && resource.external_url && <a className="resource-link" href={resource.external_url} target="_blank" rel="noopener noreferrer">{resource.external_url}</a>}{resource.kind === "NOTE" && resource.content && <p className="resource-note">{resource.content}</p>}{resource.kind === "FILE" && <a className="resource-link" href={`/api/study-groups/${groupId}/resources/${resource.id}/download`}>Download {resource.original_filename || "file"}</a>}</article>)}</div>
              </section>
            </div>
          )}

          {group.viewer?.isMember && activeTab === "Progress" && (
            <div className="workspace-columns">
              <section className="panel feature-form">
                <h2>Group progress</h2>
                {manager ? (topics.length === 0 ? <EmptyState>There are no topics configured for this group yet.</EmptyState> : <form className="feature-form-grid" onSubmit={updateProgress}><label className="form-span">Topic<select required value={progressForm.topicId} onChange={(event) => setProgressForm({ ...progressForm, topicId: event.target.value })}>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label><label>Progress<select value={progressForm.status} onChange={(event) => setProgressForm({ ...progressForm, status: event.target.value })}><option value="NEEDS_HELP">Need help</option><option value="LEARNING">Learning</option><option value="COMFORTABLE">Comfortable</option><option value="STRONG">Strong</option></select></label><label>Confidence<input type="number" min="0" max="1" step="0.1" value={progressForm.confidence} onChange={(event) => setProgressForm({ ...progressForm, confidence: event.target.value })} /></label><button className="button button-primary" disabled={busy}>Save progress</button></form>) : <p className="feature-muted">Progress updates are managed by group leaders.</p>}
                <div className="workspace-data-list">{progress.map((item) => <article className="workspace-list-item" key={item.topicId || item.topic_id}><strong>{item.topicName || item.topic_name}</strong><span>{readableStatus(item.status)}{item.confidence !== null && item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}</span></article>)}</div>
              </section>
              <section className="panel feature-form">
                <h2>Group feedback</h2>
                <p className="feature-muted">Your feedback helps the group reflect on how well its study approach is working.</p>
                {feedbackSummary?.summary && <p className="feature-muted">{feedbackSummary.summary.responses || 0} feedback response(s) so far.</p>}
                <form className="feature-form-grid" onSubmit={submitFeedback}>{[["goalsCompatible", "Our learning goals fit"], ["skillsComplementary", "We helped each other learn"], ["scheduleWorked", "The schedule worked"], ["productive", "Sessions felt productive"], ["overallRating", "Overall group experience"]].map(([key, label]) => <label key={key}>{label}<select value={feedbackForm[key]} onChange={(event) => setFeedbackForm({ ...feedbackForm, [key]: event.target.value })}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value} / 5</option>)}</select></label>)}<label className="form-span">Comment<textarea rows={3} maxLength={1500} value={feedbackForm.comment} onChange={(event) => setFeedbackForm({ ...feedbackForm, comment: event.target.value })} /></label><label className="workspace-repeat"><input type="checkbox" checked={feedbackForm.wouldRepeat} onChange={(event) => setFeedbackForm({ ...feedbackForm, wouldRepeat: event.target.checked })} />I would study with this group again</label><button className="button button-primary" disabled={busy}>Submit feedback</button></form>
              </section>
            </div>
          )}

          {group.viewer?.isMember && activeTab === "AI Assistant" && (
            <section className="panel workspace-chat">
               <div className="section-heading"><div><span className="section-overline">STUDY ASSISTANT</span><h2>Ask about your group&apos;s material</h2></div></div>
              <p className="feature-muted">Answers use material and discussion that you are authorized to access.</p>
              <div className="workspace-ai-controls"><SourceModeSelector id="group-ai-source-mode" value={aiSourceMode} onChange={setAiSourceMode} disabled={busy} webEnabled={Boolean(aiStatus?.capabilities?.webResearch)} /><SourceModeNotice sourceMode={aiSourceMode} /></div>
               {aiAvailable === false && <div className="feature-error" role="status">The AI assistant is currently unavailable. Your group&apos;s shared tools still work.</div>}
              <div className="workspace-message-list" aria-live="polite">{aiMessages.length === 0 && <EmptyState>Try asking about a shared note or a topic your group is studying.</EmptyState>}{aiMessages.map((message, index) => <article className={`workspace-message ${message.role}`} key={`${message.role}-${index}`}><strong>{message.role === "user" ? "You" : "Lien study assistant"}</strong><p>{message.content}</p>{message.showEvidence && <AnswerSources sources={message.sources} searches={message.searches} sourcesDisagree={message.sourcesDisagree} limitations={message.limitations} />}{message.showEvidence && message.role === "assistant" && <FeedbackButtons value={message.feedback} onChange={(value) => setAiMessages((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, feedback: value } : entry))} />}</article>)}</div>
              <form className="workspace-message-form" onSubmit={askAi}><label className="sr-only" htmlFor="group-ai-question">Ask a study question</label><textarea id="group-ai-question" rows={2} maxLength={2000} value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} placeholder="Ask about your group's shared material..." /><button className="button button-primary" disabled={busy || !aiQuestion.trim()}>Ask</button></form>
            </section>
          )}

          {group.viewer?.isMember && activeTab === "Settings" && (
            <div className="workspace-columns">
              {manager ? <>
                <GroupSettings group={group} onSaved={refresh} />
                <GroupLeaderTools groupId={groupId} group={group} currentUserId={currentUserId} onUpdated={refresh} />
              </> : <section className="panel feature-form"><span className="section-overline">GROUP SETTINGS</span><h2>About this group</h2><p>{group.description || "This group has not added a description yet."}</p><dl className="meeting-facts"><div><dt>Format</dt><dd>{readableStatus(group.mode)}</dd></div><div><dt>Privacy</dt><dd>{readableStatus(group.privacy)}</dd></div><div><dt>Membership</dt><dd>{String(group.viewer?.role || "member").toLowerCase()}</dd></div></dl><p className="feature-muted">Only group leaders can change group settings or manage membership.</p></section>}
            </div>
          )}

          {!group.viewer?.isMember && <section className="panel feature-form"><h2>Group membership required</h2><p>You can view this group&apos;s public details, but shared discussions, members, sessions, and study tools are available to active members.</p><Link className="button button-primary" href="/dashboard/groups">Back to my groups</Link></section>}
        </>
      )}
    </section>
  );
}
