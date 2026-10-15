import env from "../config/env.js";

/**
 * Modular video-provider integration.
 *
 * Jitsi Meet is the initial provider, embedded via the official IFrame API
 * (`https://<domain>/external_api.js`, `new JitsiMeetExternalAPI(domain, ...)`).
 * The frontend loads that script lazily (only on the live-meeting page) and the
 * backend never hands secrets to the browser: the room name is authorised by
 * group membership on every join request, and the IFrame config only carries
 * non-secret display values (room name, display name, domain).
 *
 * Swapping providers (managed JaaS, self-hosted Jitsi, LiveKit) only requires a
 * new `buildJoinConfig` branch here plus matching frontend loader — the meeting
 * records, auth checks and attendance ledger stay untouched.
 *
 * Public-service caveat: meet.jit.si welcomes integration *testing* but is not
 * meant for production apps (see https://jitsi.org/api/). Production should set
 * JITSI_DOMAIN to a JaaS tenant or a self-hosted deployment.
 */

export const PROVIDERS = Object.freeze(["JITSI", "LIVEKIT", "GOOGLE_MEET", "NONE"]);

/**
 * Google Meet links are user-supplied (TWIGANE cannot create them without a
 * Google Workspace integration), so they are validated strictly before being
 * stored or handed to members: https only, meet.google.com host only, and a
 * room-code path only (`abc-defg-hij`). Anything else is rejected rather than
 * passed through, so a meeting can never link members to an arbitrary site.
 */
const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i;

export function normalizeGoogleMeetUrl(raw) {
  const value = String(raw || "").trim();
  if (!MEET_URL_RE.test(value)) return null;
  return value.replace(/\/$/, "");
}

/** Build a deterministic, URL-safe, unpredictable-enough room identifier. */
export function buildRoomIdentifier(prefix, meetingId) {
  const clean = String(prefix || "twigane")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "twigane";
  return `${clean}-${String(meetingId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36)}`;
}

export function jitsiDomain() {
  return env.jitsiDomain || "meet.jit.si";
}

export function isPublicJitsi() {
  return jitsiDomain() === "meet.jit.si";
}

/**
 * Build the non-secret join configuration returned to an authorised member.
 * Never includes signing keys or API secrets — those stay server-side.
 */
export function buildJoinConfig({ meeting, user, role = "MEMBER" }) {
  const provider = meeting.provider || env.videoProviderDefault || "JITSI";

  if (provider === "JITSI") {
    return {
      provider: "JITSI",
      domain: jitsiDomain(),
      roomName: meeting.provider_room_identifier,
      displayName: `${user.first_name} ${user.last_name}`.trim() || user.email,
      isModerator: role === "OWNER" || role === "MODERATOR",
      // Flags the public-service limitation so the UI can show the notice.
      publicServiceWarning: isPublicJitsi(),
    };
  }

  if (provider === "GOOGLE_MEET") {
    // Hosted entirely by Google: TWIGANE only stores and re-serves the link.
    // The frontend opens it in a new tab — no iframe, no permission prompts
    // from this app — so the join payload carries no embed configuration.
    return {
      provider: "GOOGLE_MEET",
      joinUrl: meeting.join_url,
      isModerator: role === "OWNER" || role === "MODERATOR",
      delegated: true,
    };
  }

  if (provider === "LIVEKIT") {
    // LiveKit tokens are minted by livekit.service.js; the meeting service
    // delegates there. This branch documents the seam for a future switch.
    return { provider: "LIVEKIT", delegated: true };
  }

  return { provider: "NONE", delegated: false };
}

export default { buildRoomIdentifier, buildJoinConfig, jitsiDomain, isPublicJitsi, PROVIDERS };
