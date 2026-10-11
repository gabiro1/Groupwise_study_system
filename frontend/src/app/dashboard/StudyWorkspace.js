"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

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
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t update this study workspace.");
  return result.data;
}

const tabs = ["Overview", "Plans & tasks", "Sessions", "Group chat", "Resources", "Ask AI", "Progress & feedback"];

function readableStatus(value) {
  return value?.replaceAll("_", " ").toLowerCase() || "";
}

function safeResourceUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export default function StudyWorkspace({ workspaceId, initialTab = "Overview", initialResourceKind }) {
  const [activeTab, setActiveTab] = useState(tabs.includes(initialTab) ? initialTab : "Overview");
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [resources, setResources] = useState([]);
  const [resourceKindFilter, setResourceKindFilter] = useState(initialResourceKind || "ALL");
  const [groupTopics, setGroupTopics] = useState([]);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiAvailable, setAiAvailable] = useState(null);
  const [aiQuestion, setAiQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [planForm, setPlanForm] = useState({ title: "", description: "", deadline: "" });
  const [taskForm, setTaskForm] = useState({ title: "", description: "", priority: "MEDIUM" });
  const [sessionForm, setSessionForm] = useState({ title: "", startsAt: "", endsAt: "", mode: "PHYSICAL", location: "", meetingUrl: "" });
  const [messageText, setMessageText] = useState("");
  const [resourceForm, setResourceForm] = useState({ title: "", description: "", kind: "LINK", externalUrl: "", content: "", visibility: "GROUP" });
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
      const workspaceData = await apiRequest(`workspaces/${workspaceId}`);
      const [taskData, sessionData, messageData, resourceData, groupData, meData] = await Promise.all([
        apiRequest(`workspaces/${workspaceId}/tasks?limit=100`),
        apiRequest(`workspaces/${workspaceId}/sessions?scope=all&limit=50`),
        apiRequest(`workspaces/${workspaceId}/messages?limit=50`),
        apiRequest(`workspaces/${workspaceId}/resources?limit=50`),
        apiRequest(`study-groups/${workspaceData.group.id}`),
        apiRequest("auth/me"),
      ]);
      setOverview(workspaceData);
      setTasks(taskData.tasks || []);
      setSessions(sessionData.sessions || []);
      setMessages(messageData.messages || []);
      setResources(resourceData.resources || []);
      setCurrentUserId(meData.user?.id || "");
      setGroupTopics(groupData.group?.topics || []);
      setProgressForm((current) => current.topicId
        ? current
        : { ...current, topicId: groupData.group?.topics?.[0]?.id || "" });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    setActiveTab(tabs.includes(initialTab) ? initialTab : "Overview");
  }, [initialTab]);

  useEffect(() => {
    setResourceKindFilter(initialResourceKind || "ALL");
    if (initialResourceKind === "NOTE") {
      setResourceForm((current) => ({ ...current, kind: "NOTE" }));
    }
  }, [initialResourceKind]);

  useEffect(() => {
    if (activeTab !== "Group chat") return undefined;
    let active = true;
    const interval = window.setInterval(() => {
      apiRequest(`workspaces/${workspaceId}/messages?limit=50`)
        .then((result) => {
          if (active) setMessages(result.messages || []);
        })
        .catch((requestError) => {
          if (active) setError(requestError.message);
        });
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeTab, workspaceId]);

  async function submit(path, body, successMessage) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(path, { method: "POST", body: JSON.stringify(body) });
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
    const saved = await submit(`workspaces/${workspaceId}/plans`, {
      ...planForm,
      deadline: planForm.deadline || null,
      topics: [],
    }, "Your study plan has been created.");
    if (saved) setPlanForm({ title: "", description: "", deadline: "" });
  }

  async function createTask(event) {
    event.preventDefault();
    const saved = await submit(`workspaces/${workspaceId}/tasks`, taskForm, "Task added to the group board.");
    if (saved) setTaskForm({ title: "", description: "", priority: "MEDIUM" });
  }

  async function changeTaskStatus(task) {
    const nextStatus = task.status === "COMPLETED" ? "TODO" : "COMPLETED";
    setBusy(true);
    setError("");
    try {
      await apiRequest(`workspaces/${workspaceId}/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
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
      await apiRequest(`workspaces/${workspaceId}/plans/${plan.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createSession(event) {
    event.preventDefault();
    const saved = await submit(`workspaces/${workspaceId}/sessions`, {
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

  async function rsvp(session, rsvp) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`workspaces/${workspaceId}/sessions/rsvp`, {
        method: "POST",
        body: JSON.stringify({ sessionId: session.id, rsvp }),
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
      await apiRequest(`workspaces/${workspaceId}/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "CANCELLED" }),
      });
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
    const saved = await submit(`workspaces/${workspaceId}/messages`, { body: content, kind: "TEXT" }, "Message sent.");
    if (saved) setMessageText("");
  }

  async function createResource(event) {
    event.preventDefault();
    const saved = await submit(`workspaces/${workspaceId}/resources`, {
      title: resourceForm.title,
      description: resourceForm.description,
      kind: resourceForm.kind,
      visibility: resourceForm.visibility,
      ...(resourceForm.kind === "LINK" ? { externalUrl: resourceForm.externalUrl } : { content: resourceForm.content }),
    }, "Resource shared with your group.");
    if (saved) setResourceForm({ title: "", description: "", kind: "LINK", externalUrl: "", content: "", visibility: "GROUP" });
  }

  async function askAi(event) {
    event.preventDefault();
    const question = aiQuestion.trim();
    if (!question) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiRequest("ai/chat", {
        method: "POST",
        body: JSON.stringify({ workspaceId, message: question, resourceIds: [], useGroupContext: true }),
      });
      setAiAvailable(response.available);
      setAiMessages((current) => [
        ...current,
        { role: "user", content: question },
        {
          role: "assistant",
          content: response.answer || response.message || "I couldn’t find an answer in your group’s shared study material.",
          sources: response.sources || [],
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
    const saved = await apiRequest(`workspaces/${workspaceId}/progress`, {
      method: "PUT",
      body: JSON.stringify({
        topicId: progressForm.topicId,
        status: progressForm.status,
        confidence: Number(progressForm.confidence),
      }),
    }).then(() => true).catch((requestError) => {
      setError(requestError.message);
      return false;
    });
    if (saved) {
      setNotice("Group progress updated.");
      await refresh();
    }
  }

  async function submitFeedback(event) {
    event.preventDefault();
    const saved = await submit(`workspaces/${workspaceId}/feedback`, {
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

  const plans = overview?.plans || [];
  const progress = overview?.progress || [];
  const visibleResources = resourceKindFilter === "ALL"
    ? resources
    : resources.filter((resource) => resource.kind === resourceKindFilter);

  return (
    <section className="section-page workspace-page">
      <Link className="back-link" href="/dashboard/groups">← My study groups</Link>
      {loading && !overview ? <p className="empty-state" role="status">Loading your group workspace…</p> : null}
      {error && <div className="feature-error" role="alert">{error}<button type="button" onClick={refresh}>Try again</button></div>}
      {notice && <div className="feature-success" role="status">{notice}</div>}
      {overview && (
        <>
          <div className="section-page-heading">
            <span className="section-overline">STUDY WORKSPACE · {overview.group?.name}</span>
            <h1>{overview.workspace?.name || overview.group?.name}</h1>
            <p>Plan your learning together, coordinate study time, and keep your group’s progress visible.</p>
          </div>
          <div className="workspace-tabs" role="tablist" aria-label="Study workspace">
            {tabs.map((tab) => (
              <button type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "selected" : ""} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>
            ))}
          </div>
          {activeTab === "Overview" && (
            <div className="workspace-overview-grid">
              <section className="panel workspace-summary">
                <span className="section-overline">YOUR GROUP AT A GLANCE</span>
                <h2>Keep learning moving</h2>
                <p>{plans.length} active plans · {tasks.filter((task) => task.status !== "COMPLETED").length} open tasks · {sessions.filter((session) => session.status === "SCHEDULED").length} scheduled sessions</p>
                <div className="workspace-shortcuts">
                  {["Plans & tasks", "Sessions", "Group chat", "Resources", "Ask AI", "Progress & feedback"].map((tab) => <button type="button" key={tab} onClick={() => setActiveTab(tab)}>{tab} →</button>)}
                </div>
              </section>
              <section className="panel workspace-overview-list">
                <div className="section-heading"><div><span className="section-overline">UP NEXT</span><h2>Upcoming sessions</h2></div></div>
                {(overview.upcomingSessions || []).length === 0 && <p className="empty-state">No sessions scheduled yet.</p>}
                {(overview.upcomingSessions || []).slice(0, 4).map((session) => <article className="workspace-list-item" key={session.id}><strong>{session.title}</strong><span>{new Date(session.starts_at).toLocaleString()} · {session.going_count || 0} going</span></article>)}
              </section>
              <section className="panel workspace-overview-list">
                <div className="section-heading"><div><span className="section-overline">GROUP FOCUS</span><h2>Learning progress</h2></div></div>
                {progress.length === 0 && <p className="empty-state">Update progress to make it easier to decide what to study next.</p>}
                {progress.slice(0, 5).map((item) => <article className="workspace-list-item" key={item.topic_id}><strong>{item.topic_name}</strong><span>{readableStatus(item.status)}{item.confidence !== null ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}</span></article>)}
              </section>
            </div>
          )}
          {activeTab === "Plans & tasks" && (
            <div className="workspace-columns">
              <section className="panel feature-form">
                <h2>Create a study plan</h2>
                <form className="feature-form-grid" onSubmit={createPlan}>
                  <label className="form-span">Plan title<input required minLength={3} maxLength={120} value={planForm.title} onChange={(event) => setPlanForm({ ...planForm, title: event.target.value })} /></label>
                  <label className="form-span">What will your group focus on?<textarea rows={3} maxLength={500} value={planForm.description} onChange={(event) => setPlanForm({ ...planForm, description: event.target.value })} /></label>
                  <label>Target date<input type="date" value={planForm.deadline} onChange={(event) => setPlanForm({ ...planForm, deadline: event.target.value })} /></label>
                  <button className="button button-primary" disabled={busy}>Create plan</button>
                </form>
                <div className="workspace-data-list">
                  <h3>Group plans</h3>
                  {plans.length === 0 && <p className="empty-state">No plans yet. Start with a shared learning goal.</p>}
                  {plans.map((plan) => <article className="workspace-list-item" key={plan.id}><strong>{plan.title}</strong><span>{readableStatus(plan.status)}{plan.deadline ? ` · due ${new Date(plan.deadline).toLocaleDateString()}` : ""}</span>{plan.description && <p>{plan.description}</p>}{plan.status !== "COMPLETED" && <button className="text-link-button" type="button" disabled={busy} onClick={() => changePlanStatus(plan, "COMPLETED")}>Mark plan complete</button>}</article>)}
                </div>
              </section>
              <section className="panel feature-form">
                <h2>Add a task</h2>
                <form className="feature-form-grid" onSubmit={createTask}>
                  <label className="form-span">Task title<input required minLength={2} maxLength={160} value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} /></label>
                  <label className="form-span">Details<textarea rows={2} maxLength={500} value={taskForm.description} onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })} /></label>
                  <label>Priority<select value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: event.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
                  <button className="button button-primary" disabled={busy}>Add task</button>
                </form>
                <div className="workspace-data-list">
                  <h3>Task board</h3>
                  {tasks.length === 0 && <p className="empty-state">Your group has no tasks yet.</p>}
                  {tasks.map((task) => <article className="workspace-list-item task-row" key={task.id}><div><strong>{task.title}</strong><span>{readableStatus(task.status)} · {readableStatus(task.priority)}{task.due_at ? ` · due ${new Date(task.due_at).toLocaleDateString()}` : ""}</span></div><button type="button" className="button button-secondary" disabled={busy} onClick={() => changeTaskStatus(task)}>{task.status === "COMPLETED" ? "Reopen" : "Complete"}</button></article>)}
                </div>
              </section>
            </div>
          )}
          {activeTab === "Sessions" && (
            <div className="workspace-columns">
              <section className="panel feature-form">
                <h2>Schedule a study session</h2>
                <form className="feature-form-grid" onSubmit={createSession}>
                  <label className="form-span">Session title<input required value={sessionForm.title} onChange={(event) => setSessionForm({ ...sessionForm, title: event.target.value })} /></label>
                  <label>Starts<input required type="datetime-local" value={sessionForm.startsAt} onChange={(event) => setSessionForm({ ...sessionForm, startsAt: event.target.value })} /></label>
                  <label>Ends<input required type="datetime-local" value={sessionForm.endsAt} onChange={(event) => setSessionForm({ ...sessionForm, endsAt: event.target.value })} /></label>
                  <label>Format<select value={sessionForm.mode} onChange={(event) => setSessionForm({ ...sessionForm, mode: event.target.value })}><option value="ONLINE">Online</option><option value="PHYSICAL">In person</option></select></label>
                  <label>Location<input value={sessionForm.location} onChange={(event) => setSessionForm({ ...sessionForm, location: event.target.value })} placeholder="Room, building, address…" /></label>
                  {sessionForm.mode === "ONLINE" && <label>Meeting link<input type="url" value={sessionForm.meetingUrl} onChange={(event) => setSessionForm({ ...sessionForm, meetingUrl: event.target.value })} placeholder="https://meet.google.com/…" /></label>}
                  <button className="button button-primary" disabled={busy}>Schedule session</button>
                </form>
              </section>
              <section className="panel feature-form">
                <h2>Group sessions</h2>
                {sessions.length === 0 && <p className="empty-state">No sessions yet. Schedule the first one for your group.</p>}
                <div className="workspace-data-list">
                  {sessions.map((session) => <article className="workspace-list-item" key={session.id}><strong>{session.title}</strong><span>{new Date(session.starts_at).toLocaleString()} · {readableStatus(session.mode)} · {readableStatus(session.status)}</span>{session.location && <span>{session.location}</span>}{session.status === "SCHEDULED" && <div className="session-rsvp-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => rsvp(session, "GOING")}>I’m going</button><button type="button" className="text-link-button" disabled={busy} onClick={() => rsvp(session, "MAYBE")}>Maybe</button><button type="button" className="text-link-button" disabled={busy} onClick={() => cancelSession(session)}>Cancel session</button></div>}</article>)}
                </div>
              </section>
            </div>
          )}
          {activeTab === "Group chat" && (
            <section className="panel workspace-chat">
              <div className="section-heading"><div><span className="section-overline">GROUP CONVERSATION</span><h2>{overview.group?.name}</h2></div></div>
              <div className="workspace-bubble-list" aria-live="polite">
                {messages.length === 0 && <p className="empty-state">Start the conversation. Share a question or what you plan to study next.</p>}
                {messages.map((message) => {
                  const senderName = [message.first_name, message.last_name].filter(Boolean).join(" ") || "Group member";
                  const initials = senderName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
                  const mine = Boolean(currentUserId) && message.author_id === currentUserId;
                  return (
                    <div className={`chat-bubble-row${mine ? " is-mine" : ""}`} key={message.id}>
                      <span className="chat-avatar" aria-hidden="true">{initials}</span>
                      <div className="chat-bubble">
                        <div className="chat-bubble-meta">
                          <strong>{mine ? "You" : senderName}</strong>
                          <time>{new Date(message.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</time>
                        </div>
                        <p>{message.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <form className="workspace-message-form" onSubmit={sendMessage}>
                <label className="sr-only" htmlFor="workspace-message">Write a message</label>
                <textarea id="workspace-message" rows={2} maxLength={4000} value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Write a message to your group…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} />
                <button className="button button-primary" disabled={busy || !messageText.trim()}>Send</button>
              </form>
            </section>
          )}
          {activeTab === "Resources" && (
            <div className="workspace-columns">
              <section className="panel feature-form">
                <h2>Share a study resource</h2>
                <p className="feature-muted">Add a useful link or a text note for your group. File uploads are not available yet.</p>
                <form className="feature-form-grid" onSubmit={createResource}>
                  <label className="form-span">Title<input required maxLength={160} value={resourceForm.title} onChange={(event) => setResourceForm({ ...resourceForm, title: event.target.value })} /></label>
                  <label>Resource type<select value={resourceForm.kind} onChange={(event) => setResourceForm({ ...resourceForm, kind: event.target.value })}><option value="LINK">Web link</option><option value="NOTE">Text note</option></select></label>
                  <label>Visibility<select value={resourceForm.visibility} onChange={(event) => setResourceForm({ ...resourceForm, visibility: event.target.value })}><option value="GROUP">Group</option><option value="PRIVATE">Only me</option></select></label>
                  <label className="form-span">Description<textarea rows={2} maxLength={500} value={resourceForm.description} onChange={(event) => setResourceForm({ ...resourceForm, description: event.target.value })} /></label>
                  {resourceForm.kind === "LINK"
                    ? <label className="form-span">URL<input required type="url" maxLength={1000} value={resourceForm.externalUrl} onChange={(event) => setResourceForm({ ...resourceForm, externalUrl: event.target.value })} placeholder="https://" /></label>
                    : <label className="form-span">Note content<textarea required rows={5} maxLength={500} value={resourceForm.content} onChange={(event) => setResourceForm({ ...resourceForm, content: event.target.value })} /></label>}
                  <button className="button button-primary" disabled={busy}>Share resource</button>
                </form>
              </section>
              <section className="panel feature-form">
                <h2>{resourceKindFilter === "NOTE" ? "Shared study notes" : "Shared resources"}</h2>
                {visibleResources.length === 0 && <p className="empty-state">{resourceKindFilter === "NOTE"
                  ? "Your group hasn’t shared any study notes yet."
                  : "Your group hasn’t shared study resources yet."}</p>}
                <div className="workspace-data-list">
                  {visibleResources.map((resource) => {
                    const url = resource.kind === "LINK" ? safeResourceUrl(resource.external_url) : null;
                    return <article className="workspace-list-item" key={resource.id}>
                    <strong>{resource.title}</strong>
                    <span>{readableStatus(resource.kind)} · {readableStatus(resource.visibility)}{resource.uploader_first_name ? ` · shared by ${resource.uploader_first_name}` : ""}</span>
                    {resource.description && <p>{resource.description}</p>}
                    {url && <a className="resource-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>}
                    {resource.kind === "NOTE" && resource.content && <p className="resource-note">{resource.content}</p>}
                  </article>;
                  })}
                </div>
              </section>
            </div>
          )}
          {activeTab === "Ask AI" && (
            <section className="panel workspace-chat">
              <div className="section-heading"><div><span className="section-overline">STUDY ASSISTANT</span><h2>Ask about your group’s material</h2></div></div>
              <p className="feature-muted">Answers are grounded in accessible group resources and recent discussion. If there’s no supporting material, Lien will say so.</p>
              {aiAvailable === false && <div className="feature-error" role="status">The AI assistant is currently unavailable. You can still use your group’s shared resources and chat.</div>}
              <div className="workspace-message-list" aria-live="polite">
                {aiMessages.length === 0 && <p className="empty-state">Try asking about a shared note or how to approach a topic your group is studying.</p>}
                {aiMessages.map((message, index) => <article className={`workspace-message ${message.role}`} key={`${message.role}-${index}`}><strong>{message.role === "user" ? "You" : "Lien study assistant"}</strong><p>{message.content}</p>{message.sources?.map((source) => <small className="ai-source" key={source.resourceId}>Source: {source.title}{source.excerpt ? ` — “${source.excerpt}”` : ""}</small>)}</article>)}
              </div>
              <form className="workspace-message-form" onSubmit={askAi}><label className="sr-only" htmlFor="workspace-ai-question">Ask a study question</label><textarea id="workspace-ai-question" rows={2} maxLength={2000} value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} placeholder="Ask about your group’s shared material…" /><button className="button button-primary" disabled={busy || !aiQuestion.trim()}>Ask</button></form>
            </section>
          )}
          {activeTab === "Progress & feedback" && (
            <div className="workspace-columns">
              <section className="panel feature-form">
                <h2>Update group progress</h2>
                {groupTopics.length === 0 ? <p className="empty-state">There are no topics configured for this group yet.</p> : (
                  <form className="feature-form-grid" onSubmit={updateProgress}>
                    <label className="form-span">Topic<select required value={progressForm.topicId} onChange={(event) => setProgressForm({ ...progressForm, topicId: event.target.value })}>{groupTopics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    <label>Progress<select value={progressForm.status} onChange={(event) => setProgressForm({ ...progressForm, status: event.target.value })}><option value="NEEDS_HELP">Need help</option><option value="LEARNING">Learning</option><option value="COMFORTABLE">Comfortable</option><option value="STRONG">Strong</option></select></label>
                    <label>Confidence<input type="number" min="0" max="1" step="0.1" value={progressForm.confidence} onChange={(event) => setProgressForm({ ...progressForm, confidence: event.target.value })} /></label>
                    <button className="button button-primary" disabled={busy}>Save progress</button>
                  </form>
                )}
                <div className="workspace-data-list">{progress.map((item) => <article className="workspace-list-item" key={item.topic_id}><strong>{item.topic_name}</strong><span>{readableStatus(item.status)}{item.confidence !== null ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}</span></article>)}</div>
              </section>
              <section className="panel feature-form">
                <h2>Share group feedback</h2>
                <p className="feature-muted">Your feedback helps the group reflect on how well its study approach is working.</p>
                <form className="feature-form-grid" onSubmit={submitFeedback}>
                  {[
                    ["goalsCompatible", "Our learning goals fit"],
                    ["skillsComplementary", "We helped each other learn"],
                    ["scheduleWorked", "The schedule worked"],
                    ["productive", "Sessions felt productive"],
                    ["overallRating", "Overall group experience"],
                  ].map(([key, label]) => <label key={key}>{label}<select value={feedbackForm[key]} onChange={(event) => setFeedbackForm({ ...feedbackForm, [key]: event.target.value })}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value} / 5</option>)}</select></label>)}
                  <label className="form-span">Comment<textarea rows={3} maxLength={1500} value={feedbackForm.comment} onChange={(event) => setFeedbackForm({ ...feedbackForm, comment: event.target.value })} /></label>
                  <label className="workspace-repeat"><input type="checkbox" checked={feedbackForm.wouldRepeat} onChange={(event) => setFeedbackForm({ ...feedbackForm, wouldRepeat: event.target.checked })} />I’d study with this group again</label>
                  <button className="button button-primary" disabled={busy}>Submit feedback</button>
                </form>
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}
