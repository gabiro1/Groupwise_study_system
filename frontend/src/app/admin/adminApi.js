"use client";

import { useEffect, useState } from "react";

/**
 * Thin wrapper around the BFF proxy.
 *
 * Every admin component talks to `/api/<path>`, which the Next route handler
 * forwards to the API with the caller's cookies and CSRF token. Keeping the one
 * helper here means error handling and the response envelope are unwrapped in a
 * single place.
 */
export async function apiRequest(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(result.error?.message || "That request could not be completed.");
    error.status = response.status;
    error.code = result.error?.code;
    throw error;
  }

  return result.data;
}

/** Debounce a fast-changing value (search input) so requests stay cheap. */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { dateStyle: "medium" });
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function relativeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(value);
}

export function initialsFor(user) {
  if (!user) return "?";
  const source = [user.firstName || user.first_name, user.lastName || user.last_name]
    .filter(Boolean)
    .join(" ");
  const initials = source
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || (user.email ? user.email[0].toUpperCase() : "?");
}

export function displayName(user) {
  if (!user) return "Administrator";
  const name = [user.firstName || user.first_name, user.lastName || user.last_name]
    .filter(Boolean)
    .join(" ");
  return name || user.email || "Administrator";
}

/** Human-readable labels for the enum values the dashboard renders as badges. */
export const LABELS = {
  status: {
    ACTIVE: "Active",
    SUSPENDED: "Suspended",
    PENDING_VERIFICATION: "Pending",
    DEACTIVATED: "Deactivated",
  },
  groupStatus: {
    ACTIVE: "Active",
    ARCHIVED: "Archived",
    DISBANDED: "Disbanded",
  },
  reportStatus: {
    OPEN: "Open",
    IN_REVIEW: "In review",
    RESOLVED: "Resolved",
    DISMISSED: "Dismissed",
  },
  targetType: {
    STUDENT: "Student",
    GROUP: "Group",
    MESSAGE: "Message",
    RESOURCE: "Resource",
  },
  category: {
    HARASSMENT: "Harassment",
    INAPPROPRIATE_CONTENT: "Inappropriate content",
    SPAM: "Spam",
    ACADEMIC_DISHONESTY: "Academic dishonesty",
    IMPERSONATION: "Impersonation",
    OTHER: "Other",
  },
  role: {
    STUDENT: "Student",
    LECTURER: "Lecturer",
    ADMIN: "Administrator",
  },
};

export function labelFor(group, value) {
  if (!value) return "—";
  return LABELS[group]?.[value] || value.toLowerCase().replace(/_/g, " ");
}
