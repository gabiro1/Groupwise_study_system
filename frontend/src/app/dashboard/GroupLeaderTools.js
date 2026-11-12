"use client";

import { useCallback, useEffect, useState } from "react";

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
  if (!response.ok) throw new Error(result.error?.message || "We could not complete that group action.");
  return result.data;
}

function memberName(member) {
  return [member.firstName || member.first_name, member.lastName || member.last_name]
    .filter(Boolean)
    .join(" ") || "Group member";
}

function initials(member) {
  return [member.firstName || member.first_name, member.lastName || member.last_name]
    .filter(Boolean)
    .map((value) => value[0])
    .join("")
    .toUpperCase() || "?";
}

export default function GroupLeaderTools({ groupId, group, currentUserId, onUpdated }) {
  const [queue, setQueue] = useState({ invitations: [], requests: [] });
  const [members, setMembers] = useState(group?.members || []);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [rejectionNote, setRejectionNote] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const [moderation, detail] = await Promise.all([
      apiRequest(`study-groups/${groupId}/moderation`),
      apiRequest(`study-groups/${groupId}`),
    ]);
    setQueue({
      invitations: moderation.invitations || [],
      requests: moderation.requests || [],
    });
    setMembers(detail.group?.members || []);
  }, [groupId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    refresh()
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refresh]);

  async function decide(requestId, decision) {
    setBusyId(`request:${requestId}`);
    setError("");
    setMessage("");
    try {
      await apiRequest(`study-groups/${groupId}/requests/${requestId}/decide`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          note: decision === "REJECT" ? rejectionNote.trim() || null : null,
        }),
      });
      setMessage(decision === "APPROVE" ? "Request approved." : "Request declined.");
      setRejectionNote("");
      await refresh();
      onUpdated?.();
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
      await apiRequest(`study-groups/${groupId}/members/${member.id}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setMessage(action === "PROMOTE" ? "Member promoted to moderator." : action === "DEMOTE" ? "Moderator demoted." : "Member removed.");
      await refresh();
      onUpdated?.();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId("");
    }
  }

  const isOwner = (group?.viewer?.role || group?.myRole) === "OWNER";

  return (
    <section className="group-leadership-panel" aria-label="Group leader tools" data-testid="group-leader-tools">
      <div className="section-heading">
        <div>
          <span className="section-overline">LEADER TOOLS</span>
          <h2>Manage {group?.name || "your group"}</h2>
        </div>
      </div>
      {error && <div className="feature-error" role="alert">{error}</div>}
      {message && <div className="feature-success" role="status">{message}</div>}
      {loading && <p className="empty-state" role="status">Loading group controls…</p>}

      {!loading && (
        <div className="group-leadership-columns">
          <div className="group-leadership-col">
            <h3>Join requests <span className="heading-count">{queue.requests.length}</span></h3>
            {queue.requests.length === 0 ? <p className="empty-state">No pending join requests.</p> : (
              <div className="group-leadership-queue">
                {queue.requests.map((request) => (
                  <div className="group-leadership-row" key={request.id}>
                    <span className="group-invite-avatar" aria-hidden="true">{initials(request)}</span>
                    <div className="group-leadership-row-copy">
                      <strong>{memberName(request)}</strong>
                      {request.message && <small>“{request.message}”</small>}
                    </div>
                    <div className="group-actions">
                      <button className="button button-primary" type="button" disabled={Boolean(busyId)} onClick={() => decide(request.id, "APPROVE")}>Approve</button>
                      <button className="button button-secondary" type="button" disabled={Boolean(busyId)} onClick={() => decide(request.id, "REJECT")}>Decline</button>
                    </div>
                  </div>
                ))}
                <label className="group-leadership-note">
                  Rejection note <span>(optional)</span>
                  <input maxLength={500} value={rejectionNote} onChange={(event) => setRejectionNote(event.target.value)} />
                </label>
              </div>
            )}

            <h3>Pending invitations <span className="heading-count">{queue.invitations.length}</span></h3>
            {queue.invitations.length === 0 ? <p className="empty-state">No invitations awaiting a reply.</p> : (
              <div className="group-leadership-queue">
                {queue.invitations.map((invitation) => (
                  <div className="group-leadership-row" key={invitation.id}>
                    <span className="group-invite-avatar" aria-hidden="true">{initials(invitation)}</span>
                    <div className="group-leadership-row-copy">
                      <strong>{memberName(invitation)}</strong>
                      <small>Awaiting reply</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="group-leadership-col">
            <h3>Members <span className="heading-count">{members.length}</span></h3>
            <div className="group-leadership-queue">
              {members.map((member) => {
                const self = member.id === currentUserId;
                const owner = member.role === "OWNER";
                return (
                  <div className="group-leadership-row" key={member.id}>
                    <span className="group-invite-avatar" aria-hidden="true">{initials(member)}</span>
                    <div className="group-leadership-row-copy">
                      <strong>{memberName(member)}{self ? " · you" : ""}</strong>
                      <small className={`group-role-chip ${(member.role || "MEMBER").toLowerCase()}`}>{(member.role || "MEMBER").toLowerCase()}</small>
                    </div>
                    {!self && !owner && (
                      <div className="group-actions">
                        {isOwner && member.role !== "MODERATOR" && <button className="button button-secondary" type="button" disabled={Boolean(busyId)} onClick={() => manageMember(member, "PROMOTE")}>Promote</button>}
                        {member.role === "MODERATOR" && <button className="button button-secondary" type="button" disabled={Boolean(busyId)} onClick={() => manageMember(member, "DEMOTE")}>Demote</button>}
                        <button className="button button-secondary" type="button" disabled={Boolean(busyId)} onClick={() => manageMember(member, "REMOVE")}>Remove</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
