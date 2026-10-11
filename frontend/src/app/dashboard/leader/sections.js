export const SECTIONS = [
  { key: "overview", label: "Overview", icon: "home" },
  { key: "requests", label: "Requests", icon: "inbox", badge: "pendingRequests" },
  { key: "invitations", label: "Invitations", icon: "mail", badge: "pendingInvitations" },
  { key: "members", label: "Members", icon: "users" },
  { key: "sessions", label: "Sessions", icon: "calendar", badge: "upcomingSessions" },
  { key: "matching", label: "Matching", icon: "spark" },
  { key: "analytics", label: "Analytics", icon: "chart" },
  { key: "settings", label: "Settings", icon: "settings" },
];

export const SECTION_KEYS = SECTIONS.map((item) => item.key);
