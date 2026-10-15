"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AiMatchSearch from "./AiMatchSearch";

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
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t update your study partners.");
  return result.data;
}

function fullName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(" ") || "Study partner";
}

export default function StudyPartners() {
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      apiRequest("partners/invitations"),
      apiRequest("partners/conversations"),
    ])
      .then(([invitations, threads]) => {
        if (!active) return;
        setIncoming(invitations.incoming || []);
        setOutgoing(invitations.outgoing || []);
        setConversations(threads.conversations || []);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function respond(invitation, response) {
    setBusyId(invitation.id);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest(`partners/invitations/${invitation.id}/respond`, {
        method: "POST",
        body: JSON.stringify({ response }),
      });
      setIncoming((current) => current.filter((item) => item.id !== invitation.id));
      if (response === "ACCEPT" && result.conversationId) {
        const threads = await apiRequest("partners/conversations");
        setConversations(threads.conversations || []);
        setMessage("You are now connected. Say hello in your new conversation.");
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  async function revoke(invitation) {
    setBusyId(invitation.id);
    setError("");
    setMessage("");
    try {
      await apiRequest(`partners/invitations/${invitation.id}/revoke`, {
        method: "POST",
        body: "{}",
      });
      setOutgoing((current) => current.filter((item) => item.id !== invitation.id));
      setMessage("Request withdrawn.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="section-page">
      <div className="section-page-heading">
        <span className="section-overline">STUDY TOGETHER, ONE TO ONE</span>
        <h1>Study partners</h1>
        <p>Pair up with a student who complements your learning. Accepting a request opens a private conversation.</p>
      </div>
      {error && <div className="feature-error" role="alert">{error}</div>}
      {message && <div className="feature-success" role="status">{message}</div>}

      <AiMatchSearch kind="STUDENT" onNotice={setMessage} />

      {loading && <p className="empty-state" role="status">Loading your partner requests…</p>}

      {!loading && (
        <>
          <section className="panel section-panel">
            <div className="section-heading">
              <div><span className="section-overline">ACTIONS NEEDED</span><h2>Incoming requests <span className="heading-count">{incoming.length}</span></h2></div>
            </div>
            {incoming.length === 0 ? (
              <p className="empty-state">No partner requests yet. Recommended students appear on the For you tab.</p>
            ) : (
              <div className="group-list">
                {incoming.map((invitation) => (
                  <article className="group-card" key={invitation.id}>
                    <span className="group-invite-avatar">
                      {[invitation.requesterFirstName?.[0], invitation.requesterLastName?.[0]].filter(Boolean).join("").toUpperCase() || "?"}
                    </span>
                    <div className="group-info">
                      <h3>{fullName(invitation.requesterFirstName, invitation.requesterLastName)}</h3>
                      {invitation.message && <p className="partner-invite-note">“{invitation.message}”</p>}
                      <div className="group-members"><span>Requested {new Date(invitation.requestedAt || invitation.requested_at).toLocaleDateString()}</span></div>
                    </div>
                    <div className="partner-actions">
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={busyId === invitation.id}
                        onClick={() => respond(invitation, "ACCEPT")}
                      >
                        {busyId === invitation.id ? "Accepting…" : "Accept"}
                      </button>
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busyId === invitation.id}
                        onClick={() => respond(invitation, "DECLINE")}
                      >
                        Decline
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel section-panel">
            <div className="section-heading">
              <div><span className="section-overline">YOUR PEOPLE</span><h2>Connected partners <span className="heading-count">{conversations.length}</span></h2></div>
            </div>
            {conversations.length === 0 ? (
              <p className="empty-state">Once a request is accepted you can message each other here.</p>
            ) : (
              <div className="workspace-hub-grid">
                {conversations.map((thread) => (
                  <article className="workspace-hub-card" key={thread.conversationId}>
                    <Link className="workspace-hub-link" href={`/dashboard/messages?with=${thread.conversationId}`}>
                      <div className="workspace-hub-heading">
                        <span className="workspace-hub-icon">💬</span>
                        <span className="workspace-hub-title">
                          <strong>{fullName(thread.peer.firstName, thread.peer.lastName)}</strong>
                          <small>{thread.lastMessage ? (thread.lastMessage.senderId === thread.peer.id ? "partner" : "you") : "Connected partner"}</small>
                        </span>
                        {thread.unreadCount > 0 && <span className="notification-badge">{thread.unreadCount}</span>}
                        <IconArrow />
                      </div>
                      <div className="workspace-latest-message">
                        <strong>{thread.lastMessage ? "Last message" : "Say hello"}</strong>
                        <p>{thread.lastMessage?.body || `You and ${thread.peer.firstName || "your partner"} can now message each other privately.`}</p>
                        <small>{thread.lastMessage ? formatConversationDate(thread.lastMessage.createdAt) : "Open chat"}</small>
                      </div>
                    </Link>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel section-panel">
            <div className="section-heading">
              <div><span className="section-overline">SENT BY YOU</span><h2>Outgoing requests <span className="heading-count">{outgoing.length}</span></h2></div>
            </div>
            {outgoing.length === 0 ? (
              <p className="empty-state">Find a study partner on the For you tab of your dashboard.</p>
            ) : (
              <div className="group-list">
                {outgoing.map((invitation) => (
                  <article className="group-card" key={invitation.id}>
                    <span className="group-invite-avatar">
                      {[invitation.recipientFirstName?.[0], invitation.recipientLastName?.[0]].filter(Boolean).join("").toUpperCase() || "?"}
                    </span>
                    <div className="group-info">
                      <h3>{fullName(invitation.recipientFirstName, invitation.recipientLastName)}</h3>
                      <div className="group-members">
                        <span>{invitation.status === "PENDING" ? "Awaiting a reply" : "Answered"}</span>
                      </div>
                    </div>
                    {invitation.status === "PENDING" && (
                      <button className="button button-secondary" type="button" disabled={busyId === invitation.id} onClick={() => revoke(invitation)}>
                        {busyId === invitation.id ? "Withdrawing…" : "Withdraw"}
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function IconArrow() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function formatConversationDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}