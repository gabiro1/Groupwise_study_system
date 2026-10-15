// Leader dashboard navigation.
//
// Items with a `key` are internal sections (rendered as buttons that switch the
// in-page view). Items with an `href` are shared student pages that stay
// reachable for a group leader — a leader is still a student, so nothing is
// taken away; the leadership tools are simply added alongside.
export const NAV_GROUPS = [
  {
    label: "YOUR SPACE",
    items: [
      { key: "overview", label: "Dashboard", icon: "home" },
      { label: "Discover Groups", icon: "search", href: "/dashboard/discover" },
      { label: "My Groups", icon: "users", href: "/dashboard/groups" },
      { label: "Workspaces", icon: "workspace", href: "/dashboard/workspaces" },
    ],
  },
  {
    label: "GROUP MANAGEMENT",
    items: [
      { key: "groups", label: "Manage Groups", icon: "layers" },
      { key: "members", label: "Members", icon: "users" },
      { key: "sessions", label: "Study Sessions", icon: "calendar", badge: "upcomingSessions" },
      { key: "resources", label: "Group Resources", icon: "folder" },
    ],
  },
  {
    label: "LEARNING & COMMUNICATION",
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

// Secondary tools that are reached from in-page actions (a group card's
// "Requests" button, the Matching tab, and so on) rather than from the sidebar.
// They still resolve to real routes so a direct link keeps working.
export const AUX_SECTIONS = [
  { key: "requests", label: "Requests", icon: "inbox", badge: "pendingRequests" },
  { key: "invitations", label: "Invitations", icon: "mail", badge: "pendingInvitations" },
  { key: "matching", label: "Matching", icon: "spark" },
  { key: "analytics", label: "Analytics", icon: "chart" },
  { key: "settings", label: "Settings", icon: "settings" },
];

// Every internal section, keyed, for title/badge lookup.
export const SECTIONS = [
  ...NAV_GROUPS.flatMap((group) => group.items.filter((item) => item.key)),
  ...AUX_SECTIONS,
];

export const SECTION_KEYS = SECTIONS.map((item) => item.key);
