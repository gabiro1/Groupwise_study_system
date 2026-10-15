import { AccessToken } from "livekit-server-sdk";
import env from "../config/env.js";
import { AppError, ForbiddenError } from "../lib/errors.js";
import { queryOne } from "../config/db.js";
import { assertMember } from "./group.service.js";
import { STUDY_ROLE } from "../config/constants.js";

/**
 * LiveKit meeting provisioning.
 *
 * Tokens are signed server-side only. The browser never sees the API secret and
 * never supplies identity: the authenticated `userId` becomes the LiveKit
 * identity and the room name is derived from the session id, so a participant
 * cannot hop into an unrelated meeting just by guessing a room name — the token
 * only grants access to `session-<sessionId>`.
 *
 * When LiveKit is not configured, the endpoint fails with a clear
 * MEETING_NOT_CONFIGURED error instead of pretending a meeting exists. The
 * study session itself stays fully usable for text collaboration.
 */

export const meetingRoom = (sessionId) => `session-${sessionId}`;

export function isLiveKitConfigured() {
  return env.livekitConfigured;
}

/**
 * Issue a short-lived token for the given session room.
 *
 * `metadata` carries the display role (STUDENT/GROUP_LEADER) so the meeting UI
 * can show who may present; the LiveKit ACL keeps participants subscriber-level
 * by default.
 */
export async function meetingTokenFor(user, sessionId, grants = {}) {
  if (!env.livekitConfigured) {
    throw new AppError(
      "Meetings are not configured yet. Text-based collaboration keeps working.",
      { status: 503, code: "MEETING_NOT_CONFIGURED", expected: true },
    );
  }

  const identity = user.id;
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    ttl: env.LIVEKIT_TOKEN_TTL_SECONDS,
    name: `${user.first_name} ${user.last_name}`.trim(),
  });

  token.addGrant({
    room: meetingRoom(sessionId),
    roomJoin: true,
    canPublish: grants.canPublish ?? true,
    canSubscribe: true,
    canPublishData: grants.canPublishData ?? true,
  });

  return {
    url: env.LIVEKIT_URL,
    token: token.toJwt(),
    room: meetingRoom(sessionId),
  };
}

/**
 * Verify the caller may join a session meeting and return the grants.
 *
 * Anyone who is an active participant of the session — or an active group member
 * who has RSVP'd — may join. Group moderators/owners may publish (share screen,
 * present); ordinary participants can publish audio/video but are marked
 * subscriber-level for data.
 */
export async function authorizationForMeeting(sessionId, userId) {
  const session = await queryOne(
    `SELECT s.id, s.workspace_id, s.meeting_room, s.status, s.participants_closed,
            w.group_id, w.is_archived,
            (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id AND p.student_id = $2) AS is_invited
       FROM study_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1`,
    [sessionId, userId],
    "sessions:meetingAuth",
  );

  if (!session || session.is_archived) throw new ForbiddenError("That session does not exist.");
  if (session.status === "CANCELLED" || session.status === "COMPLETED") {
    throw new ForbiddenError("That session is not running.");
  }

  // Membership check — group member (active) required as the base tier.
  const { membership } = await assertMember(session.group_id, userId);
  const canModerate = ["OWNER", "MODERATOR"].includes(membership.role);

  // Second tier: open sessions admit every active member; closed sessions only
  // admit invited participants (moderators may still join to moderate).
  if (session.participants_closed && !session.is_invited && !canModerate) {
    throw new ForbiddenError("You are not a participant of this session.");
  }

  return {
    userId,
    sessionId,
    membershipRole: membership.role,
    grants: {
      canPublish: true,
      canPublishData: canModerate,
    },
    displayRole: canModerate ? STUDY_ROLE.TEACHER : undefined,
  };
}