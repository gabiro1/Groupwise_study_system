const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function metadataOf(notification) {
  if (notification?.metadata && typeof notification.metadata === "object") return notification.metadata;
  if (typeof notification?.metadata === "string") {
    try { return JSON.parse(notification.metadata); } catch { return {}; }
  }
  return {};
}

/**
 * Convert only known group-shaped notification links. Old workspace links are
 * left as compatibility links when no canonical group id was persisted; they
 * are resolved by the narrow compatibility route rather than rendered as a
 * separate dashboard.
 */
export function normalizeNotificationLink(notification) {
  const raw = typeof notification?.link === "string" ? notification.link : "";
  if (!raw.startsWith("/")) return "";
  const metadata = metadataOf(notification);
  const groupId = metadata.groupId || notification.groupId;
  const [path, suffix = ""] = raw.split(/(?=[?#])/);

  if (path.startsWith("/dashboard/groups/") && UUID.test(path.split("/")[3] || "")) return raw;
  if ((path.startsWith("/groups/") || path.startsWith("/dashboard/workspaces/") || path.startsWith("/dashboard/leader")) && UUID.test(groupId || "")) {
    return `/dashboard/groups/${groupId}${suffix}`;
  }
  if (path.startsWith("/dashboard/workspaces/") && UUID.test(path.split("/")[3] || "")) return raw;
  return raw.startsWith("/dashboard/") ? raw : "";
}
