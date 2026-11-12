"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import BrandLogo from "../BrandLogo";
import StudentRecommendations from "./StudentRecommendations";
import StudentProfile from "./StudentProfile";
import NotificationsInbox from "./NotificationsInbox";
import NotificationDropdown from "./NotificationDropdown";
import AiMatchSearch from "./AiMatchSearch";
import FloatingAssistant from "./FloatingAssistant";
import MeetingsLazy from "./meetings/MeetingsLazy";
import ThemeToggle from "../ThemeToggle";
import GroupLeaderTools from "./GroupLeaderTools";
import StudyWorkspace from "./StudyWorkspace";

const navGroups = [
  {
    label: "YOUR SPACE",
    items: [
      { label: "Dashboard", icon: "home", href: "/dashboard" },
      { label: "Discover Groups", icon: "search", href: "/dashboard/discover" },
      { label: "My Groups", icon: "users", href: "/dashboard/groups" },
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      { label: "Profile / Settings", icon: "settings", href: "/dashboard/profile" },
    ],
  },
];

const sectionTitles = {
  overview: "Dashboard",
  discover: "Discover Groups",
  groups: "My Groups",
  group: "My Groups",
  messages: "Messages",
  meetings: "Meetings",
  meetingDetail: "Meetings",
  sessions: "Study sessions",
  courses: "My courses",
  recommendations: "For you",
  profile: "Profile / Settings",
  notifications: "Notifications",
};

function Icon({ name, size = 18, strokeWidth = 1.8 }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  const paths = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" /><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" /><path d="M8 11h8M8 14h5" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.2 2.1-2.1 2.1-2.2-1.2h-.2a7.4 7.4 0 0 1-1.7.7l-.2.1-.7 2.4h-3l-.7-2.4-.2-.1a7.4 7.4 0 0 1-1.7-.7h-.2l-2.2 1.2-2.1-2.1 1.2-2.2v-.2a7.4 7.4 0 0 1-.7-1.7l-.1-.2-2.4-.7v-3l2.4-.7.1-.2a7.4 7.4 0 0 1 .7-1.7v-.2L3.5 5.3l2.1-2.1 2.2 1.2H8a7.4 7.4 0 0 1 1.7-.7l.2-.1.7-2.4h3l.7 2.4.2.1a7.4 7.4 0 0 1 1.7.7h.2l2.2-1.2 2.1 2.1-1.2 2.2v.2a7.4 7.4 0 0 1 .7 1.7l.1.2 2.4.7v3l-2.4.7-.1.2a7.4 7.4 0 0 1-.7 1.7Z" transform="translate(-1.5 -1.5) scale(1.12)" /></>,
    video: <><rect x="2" y="6" width="13" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
  };
  return <svg {...shared}>{paths[name] || paths.home}</svg>;
}

function Avatar({ initials, className = "", src }) {
  return <span className={`avatar ${className}`} aria-label={initials}>{src ? <Image src={src} alt="" width={64} height={64} unoptimized /> : initials}</span>;
}

async function apiRequest(path, options, retryUnauthorized = true) {
  let response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  if (response.status === 401 && retryUnauthorized && path !== "auth/me") {
    await apiRequest("auth/me", undefined, false);
    response = await fetch(`/api/${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        ...(options?.body ? { "content-type": "application/json" } : {}),
        ...options?.headers,
      },
    });
  }
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || "We could not load your dashboard.");
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return result.data;
}

function normaliseGroup(group) {
  // Old migration payloads may still contain a container id. Keep it out of the
  // current group model; only compatibility routes inspect that historical field.
  const { workspaceId: _legacyContainerId, workspace_id: _legacyContainerIdSnake, ...current } = group;
  const courseCode = current.courseCode || current.course_code || "";
  const courseName = current.courseName || current.course_name || "Course not listed";
  const palette = ["mint", "lilac", "peach"];
  const colorIndex = [...(courseCode || current.id || current.name)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return {
    ...current,
    courseCode,
    courseName,
    course: `${courseCode ? `${courseCode} · ` : ""}${courseName}`,
    memberCount: current.memberCount ?? current.member_count ?? 0,
    myRole: current.myRole || current.my_role || current.viewer?.role,
    color: palette[colorIndex],
  };
}

function formatActivityDate(value) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Activity date unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function memberName(member) {
  return [member.firstName || member.first_name, member.lastName || member.last_name].filter(Boolean).join(" ") || "Group member";
}

function DashboardSkeleton() {
  return <div className="dashboard-skeleton" role="status" aria-label="Loading study dashboard"><span className="sr-only">Loading your study dashboard...</span><div className="dashboard-skeleton-hero"><span /><span /><span /></div><div className="dashboard-skeleton-cards"><span /><span /><span /></div><div className="dashboard-skeleton-content"><span /><span /></div></div>;
}

function DashboardDataSkeleton() {
  return <div className="dashboard-data-skeleton" role="status" aria-label="Loading data"><span /><span /><span /></div>;
}

function ReportGroupForm({ group, onClose }) {
  const [category, setCategory] = useState("SPAM");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest("reports", { method: "POST", body: JSON.stringify({ targetType: "GROUP", targetId: group.id, category, details: details.trim() }) });
      setSent(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <article className="group-report-panel"><p className="feature-success" role="status">Thanks - our moderation team will take a look.</p></article>;
  return (
    <article className="group-report-panel">
      <form className="group-report-form" onSubmit={submit}>
        <div className="section-heading"><div><span className="section-overline">MODERATION</span><h3>Report {group.name}</h3></div></div>
        <label>Reason<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="HARASSMENT">Harassment or bullying</option><option value="INAPPROPRIATE_CONTENT">Inappropriate content</option><option value="SPAM">Spam</option><option value="ACADEMIC_DISHONESTY">Academic dishonesty</option><option value="IMPERSONATION">Impersonation</option><option value="OTHER">Something else</option></select></label>
        <label>Details<textarea required minLength={10} maxLength={2000} rows={3} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Tell the moderation team what you saw." /></label>
        {error && <p className="group-create-error" role="alert">{error}</p>}
        <div className="workspace-create-actions"><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || details.trim().length < 10}>{busy ? "Sending..." : "Send report"}</button></div>
      </form>
    </article>
  );
}

function DashboardSection({ section, search, setSearch, searchRef, groups, courses, sessions, loading, onJoin, onCreateGroup, profile, onProfileSaved, onNotice, onUnreadChange, identity, meetingId }) {
  const [manageGroupId, setManageGroupId] = useState("");
  const [reportGroupId, setReportGroupId] = useState("");
  if (section === "group") return <StudyWorkspace key={`${groups.groupId}:${groups.groupTab}:${groups.groupMeetingId || ""}`} groupId={groups.groupId} initialTab={groups.groupTab} meetingId={groups.groupMeetingId} />;
  if (section === "recommendations") return <StudentRecommendations onJoin={onJoin} />;
  if (section === "profile") return <StudentProfile initialProfile={profile} onSaved={onProfileSaved} onNotice={onNotice} />;
  if (section === "notifications") return <NotificationsInbox onUnreadChange={onUnreadChange} />;
  if (section === "meetings" || section === "meetingDetail") return <MeetingsLazy section={section} meetingId={meetingId} groups={groups.mine} />;

  const matchingGroups = section === "discover" ? groups.discovered : groups.mine;
  const filteredGroups = matchingGroups.filter((group) => `${group.name} ${group.course}`.toLowerCase().includes(search.toLowerCase()));
  if (section === "groups" || section === "discover") {
    const isDiscover = section === "discover";
    return (
      <section className="section-page" id={isDiscover ? "discover" : "groups"}>
        <div className="section-page-heading group-page-heading"><div><span className="section-overline">{isDiscover ? "LEARN BETTER TOGETHER" : "YOUR PEOPLE"}</span><h1>{isDiscover ? "Find your study group" : "My study groups"}</h1><p>{isDiscover ? "Meet people who are learning the same things you are." : "Your study crews, all in one place."}</p></div>{!isDiscover && <button className="button button-primary" type="button" onClick={onCreateGroup}><Icon name="plus" size={16} /> Create group</button>}</div>
        {isDiscover && <label className="discover-search section-search"><Icon name="search" size={17} /><input ref={searchRef} aria-label="Search study groups" placeholder="Search by course or topic" value={search} onChange={(event) => setSearch(event.target.value)} /></label>}
        {isDiscover && <AiMatchSearch onJoin={onJoin} onNotice={onNotice} />}
        <section className="panel section-panel"><div className="section-heading"><div><span className="section-overline">{isDiscover ? "FROM YOUR STUDY COMMUNITY" : "YOUR ACTIVE GROUPS"}</span><h2>{isDiscover ? "Groups to explore" : "All groups"} <span className="heading-count">{filteredGroups.length}</span></h2></div></div><div className="group-list">{filteredGroups.map((group) => <Fragment key={group.id}><article className="group-card"><div className={`course-symbol ${group.color}`}><Icon name="book" size={19} /></div><div className="group-info"><h3>{group.name}</h3><p>{group.course}</p><div className="group-members"><span>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</span>{group.myRole && <><span className="member-divider">·</span><span>{group.myRole.toLowerCase()}</span></>}</div></div>{isDiscover && !group.isMember ? <div className="group-card-actions"><button className="button button-primary" type="button" onClick={() => onJoin(group)} disabled={!group.hasSpace}>{group.hasPendingRequest ? "Request sent" : group.hasPendingInvite ? "Invitation received" : group.hasSpace ? "Join group" : "Group full"}</button><button className="button button-secondary group-report-toggle" type="button" onClick={() => setReportGroupId((current) => current === group.id ? "" : group.id)}>{reportGroupId === group.id ? "Cancel" : "Report"}</button></div> : <div className="group-card-actions">{["OWNER", "MODERATOR"].includes(group.myRole) && <button className="button button-secondary" type="button" onClick={() => setManageGroupId((current) => current === group.id ? "" : group.id)}>{manageGroupId === group.id ? "Close" : "Manage"}</button>}<Link className="circle-arrow" href={`/dashboard/groups/${group.id}`} aria-label={`Open ${group.name}`}><Icon name="arrow" size={17} /></Link></div>}</article>{reportGroupId === group.id && <ReportGroupForm group={group} onClose={() => setReportGroupId("")} />}{manageGroupId === group.id && <GroupLeaderTools groupId={group.id} group={group} currentUserId={identity?.id} />}</Fragment>)}{!loading && filteredGroups.length === 0 && <p className="empty-state">{isDiscover ? "No study groups match this search yet." : "You have not joined a study group yet. Explore groups to find your people."}</p>}{loading && <DashboardDataSkeleton />}</div>{isDiscover && !loading && <Link className="browse-groups" href="/dashboard/courses"><Icon name="book" size={16} /> Browse your courses</Link>}</section>
      </section>
    );
  }

  if (section === "sessions") return <section className="section-page"><div className="section-page-heading"><span className="section-overline">MAKE TIME TO LEARN</span><h1>Study sessions</h1><p>See what your groups are working on next.</p></div><section className="panel section-panel"><div className="section-heading"><div><span className="section-overline">UP NEXT</span><h2>Your upcoming sessions</h2></div></div><div className="section-agenda">{sessions.map((session) => <article className="session-card" key={session.id}><span className="session-accent" /><div className="session-time"><Icon name="clock" size={14} /> {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startsAt))}</div><h3>{session.title}</h3><p><Icon name="users" size={14} /> {session.groupName}</p><div className="session-bottom"><span><Icon name="pin" size={14} /> {session.location || session.mode}</span><span>{session.goingCount} attending</span></div></article>)}{!loading && sessions.length === 0 && <p className="empty-state">There are no upcoming sessions in your study groups yet.</p>}{loading && <DashboardDataSkeleton />}</div></section></section>;

  return <section className="section-page"><div className="section-page-heading"><span className="section-overline">YOUR LEARNING PATH</span><h1>My courses</h1><p>Keep track of the classes and study groups you care about.</p></div><div className="section-course-grid">{courses.map((course) => <article className="panel section-course-card" key={course.id}><div className="course-symbol mint"><Icon name="book" size={19} /></div><span className="section-overline">CURRENT COURSE</span><h2>{course.name}</h2><p>{course.courseCode}{course.semester ? ` · ${course.semester}` : ""}</p><Link className="text-link" href="/dashboard/groups">View study groups <Icon name="arrow" size={15} /></Link></article>)}{!loading && courses.length === 0 && <p className="empty-state">No courses are linked to your profile yet.</p>}{loading && <DashboardDataSkeleton />}</div></section>;
}

export default function DashboardWorkspace({ section = "overview", meetingId, groupId = null, initialGroupTab = "Overview", groupMeetingId = null }) {
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [identity, setIdentity] = useState(null);
  const [profile, setProfile] = useState(null);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupCreateBusy, setGroupCreateBusy] = useState(false);
  const [groupCreateError, setGroupCreateError] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateCourseId, setGroupCreateCourseId] = useState("");
  const [groupCreateDescription, setGroupCreateDescription] = useState("");
  const [createdGroupForInvites, setCreatedGroupForInvites] = useState(null);
  const [inviteSearch, setInviteSearch] = useState("");
  const [inviteCandidates, setInviteCandidates] = useState([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [invitingStudentId, setInvitingStudentId] = useState("");
  const [invitedStudentIds, setInvitedStudentIds] = useState([]);
  const [myGroups, setMyGroups] = useState([]);
  const [discoveredGroups, setDiscoveredGroups] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [hasLeadership, setHasLeadership] = useState(false);
  const [notificationMenuOpen, setNotificationMenuOpen] = useState(false);
  const [notificationMenuSession, setNotificationMenuSession] = useState(0);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedDiscoverySearch, setLoadedDiscoverySearch] = useState(null);
  const [loadError, setLoadError] = useState("");
  const searchRef = useRef(null);
  const topSearchRef = useRef(null);
  const noticeTimeoutRef = useRef(null);
  const activeNav = groupId ? "My Groups" : sectionTitles[section] || "Dashboard";
  const discoverLoading = section === "discover" && loadedDiscoverySearch !== search;

  useEffect(() => {
    let active = true;
    async function loadDashboard() {
      let auth;
      try {
        auth = await apiRequest("auth/me");
      } catch (error) {
        if (!active) return;
        if (error.status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        setLoadError(error.message);
        setLoading(false);
        return;
      }
      if (!active) return;
      if (auth.user?.role !== "STUDENT") {
        if (auth.user?.role === "ADMIN") {
          window.location.replace("/admin");
          return;
        }
        setLoadError("Your account is signed in, but it does not have student access to this dashboard.");
        setLoading(false);
        return;
      }
      setIdentity(auth.user);
      try {
        const [student, groupResult, notificationResult, leaderResult, sessionResult] = await Promise.all([
          apiRequest("students/me"),
          apiRequest("study-groups/mine"),
          apiRequest("notifications/unread-count"),
          apiRequest("study-groups/leader/overview").catch(() => ({ groups: [] })),
          apiRequest("sessions?scope=upcoming"),
        ]);
        if (!active) return;
        const memberGroups = (groupResult.groups || []).map(normaliseGroup);
        setProfile(student.profile);
        setMyGroups(memberGroups);
        setUnreadNotifications(notificationResult.unreadCount || 0);
        setHasLeadership((leaderResult.groups || []).length > 0);
        setSessions((sessionResult.sessions || []).map((session) => ({
          id: session.id,
          title: session.title,
          startsAt: session.starts_at || session.startsAt,
          location: session.location,
          mode: session.mode,
          goingCount: session.going_count || session.goingCount || 0,
          groupName: session.group_name || session.groupName,
        })));
        setLoading(false);
      } catch (error) {
        if (!active) return;
        if (error.status === 401 && error.path === "auth/me") {
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        setLoadError(error.message);
        setLoading(false);
      }
    }
    loadDashboard();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (section !== "discover") return undefined;
    let active = true;
    const timeout = window.setTimeout(() => {
      const query = new URLSearchParams({ limit: "20" });
      if (search.trim()) query.set("q", search.trim());
      apiRequest(`study-groups?${query.toString()}`)
        .then((result) => {
          if (active) {
            setDiscoveredGroups((result.groups || []).map(normaliseGroup));
            setLoadedDiscoverySearch(search);
          }
        })
        .catch((error) => {
          if (active) {
            setLoadError(error.message);
            setLoadedDiscoverySearch(search);
          }
        });
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [section, search]);

  useEffect(() => {
    function handleShortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        (window.matchMedia("(max-width: 620px)").matches ? searchRef.current : topSearchRef.current)?.focus();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
      window.clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  function showNotice(message) {
    window.clearTimeout(noticeTimeoutRef.current);
    setNotice(message);
    noticeTimeoutRef.current = window.setTimeout(() => setNotice(""), 2800);
  }

  function openGroupCreate() {
    setGroupCreateCourseId(profile?.courses?.[0]?.id || "");
    setGroupCreateName("");
    setGroupCreateDescription("");
    setGroupCreateError("");
    setCreatedGroupForInvites(null);
    setInviteCandidates([]);
    setInviteSearch("");
    setInviteError("");
    setInvitedStudentIds([]);
    setGroupCreateOpen(true);
  }

  async function createStudyGroup(event) {
    event.preventDefault();
    setGroupCreateBusy(true);
    setGroupCreateError("");
    try {
      const result = await apiRequest("study-groups", { method: "POST", body: JSON.stringify({ name: groupCreateName, courseId: groupCreateCourseId, description: groupCreateDescription, privacy: "REQUEST_REQUIRED", requireApproval: true, mode: "EITHER", minSize: 3, maxSize: 6, topicIds: [], schedule: [] }) });
      const createdGroup = normaliseGroup({ ...result.group, myRole: "OWNER" });
      setMyGroups((current) => [createdGroup, ...current.filter((group) => group.id !== createdGroup.id)]);
      setCreatedGroupForInvites(createdGroup);
      showNotice("Study group created.");
    } catch (error) {
      setGroupCreateError(error.message);
    } finally {
      setGroupCreateBusy(false);
    }
  }

  async function searchInviteCandidates(event) {
    event.preventDefault();
    if (!createdGroupForInvites) return;
    setInviteLoading(true);
    setInviteError("");
    try {
      const query = new URLSearchParams({ courseId: createdGroupForInvites.courseId, excludeGroupId: createdGroupForInvites.id, limit: "20" });
      if (inviteSearch.trim()) query.set("q", inviteSearch.trim());
      const result = await apiRequest(`students/search?${query.toString()}`);
      setInviteCandidates(result.students || []);
    } catch (error) {
      setInviteError(error.message);
    } finally {
      setInviteLoading(false);
    }
  }

  async function inviteStudent(student) {
    if (!createdGroupForInvites) return;
    setInvitingStudentId(student.id);
    setInviteError("");
    try {
      await apiRequest(`study-groups/${createdGroupForInvites.id}/invite`, { method: "POST", body: JSON.stringify({ inviteeId: student.id }) });
      setInvitedStudentIds((current) => [...current, student.id]);
    } catch (error) {
      setInviteError(error.message);
    } finally {
      setInvitingStudentId("");
    }
  }

  async function joinGroup(group) {
    try {
      const result = await apiRequest(`study-groups/${group.id}/join`, { method: "POST", body: JSON.stringify({ recommendationId: group.recommendationId ?? null }) });
      const joined = result.status === "JOINED";
      showNotice(joined ? "You have joined the study group." : "Your request to join was sent.");
      setDiscoveredGroups((current) => current.map((item) => item.id === group.id ? { ...item, isMember: joined, hasPendingRequest: !joined } : item));
      if (joined) setMyGroups((current) => current.some((item) => item.id === group.id) ? current : [...current, normaliseGroup({ ...group, myRole: "MEMBER" })]);
      return result;
    } catch (error) {
      showNotice(error.message);
      throw error;
    }
  }

  const updateProfile = useCallback((nextProfile) => {
    setProfile((current) => ({ ...current, ...nextProfile }));
    if (nextProfile.user) setIdentity(nextProfile.user);
  }, []);
  const pageGroups = { mine: myGroups, discovered: discoveredGroups, groupId, groupTab: initialGroupTab, groupMeetingId };
  const courses = profile?.courses || [];
  const displayName = identity?.firstName || profile?.user?.firstName || "Student";
  const initialsText = displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  async function signOut() {
    try {
      await apiRequest("auth/logout", { method: "POST", body: "{}" });
      window.location.replace("/");
    } catch (error) {
      showNotice(error.message);
    }
  }

  return (
    <main className="app-shell" id="overview">
      <aside className="sidebar" aria-label="Main navigation">
        <Link className="brand" href="/" aria-label="Lien home"><BrandLogo className="lien-logo" /></Link>
        {navGroups.map((group) => <div className="sidebar-nav-group" key={group.label}><div className="sidebar-label">{group.label}</div><nav className="side-nav" aria-label={group.label.toLowerCase()}>{group.items.map((item) => <div className="nav-link-row" key={item.label}><Link className={`nav-link ${activeNav === item.label ? "active" : ""}`} href={item.href} aria-current={activeNav === item.label ? "page" : undefined}><Icon name={item.icon} size={18} /><span>{item.label}</span>{item.label === "My Groups" && hasLeadership && <span className="sidebar-tree-count">{myGroups.length}</span>}</Link>{item.label === "My Groups" && <button className="workspace-add-button" type="button" aria-label="Create a study group" title="Create a study group" onClick={openGroupCreate}><Icon name="plus" size={16} /></button>}</div>)}</nav></div>)}
        {identity?.role === "ADMIN" && <div className="sidebar-nav-group"><div className="sidebar-label">STAFF</div><nav className="side-nav" aria-label="Staff"><Link className="nav-link" href="/admin"><Icon name="settings" size={18} /><span>Admin console</span></Link></nav></div>}
        <div className="sidebar-spacer" />
        <div className="weekly-card"><div className="weekly-icon"><Icon name="check" size={17} /></div><p className="weekly-title">Small steps add up.</p><p className="weekly-copy">{myGroups.length ? `You are learning with ${myGroups.length} ${myGroups.length === 1 ? "study group" : "study groups"}.` : "Join a study group to start learning together."}</p></div>
        <Link className="profile-row" href="/dashboard/profile"><Avatar initials={initialsText} className="profile-avatar" src={profile?.user?.avatarUrl} /><span className="profile-copy"><strong>{displayName}</strong><small>{profile?.academic?.programName || profile?.academic?.universityName || "Student"}</small></span><Icon name="chevron" size={16} /></Link>
      </aside>

      <section className="main-panel">
        <header className="topbar"><div className="mobile-brand"><BrandLogo className="lien-logo" /></div><label className="search-box"><Icon name="search" size={18} /><input ref={topSearchRef} aria-label="Search courses and study groups" placeholder="Search courses, groups..." value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label><div className="topbar-actions"><ThemeToggle /><div className="notification-menu-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setNotificationMenuOpen(false); }}><button className="icon-button notification-button" type="button" aria-label={unreadNotifications ? `${unreadNotifications} unread notifications` : "No unread notifications"} aria-haspopup="dialog" aria-expanded={notificationMenuOpen} onClick={() => { setProfileMenuOpen(false); if (!notificationMenuOpen) setNotificationMenuSession((session) => session + 1); setNotificationMenuOpen((open) => !open); }}><Icon name="bell" size={19} />{unreadNotifications > 0 && <span className="notification-dot" />}</button><NotificationDropdown open={notificationMenuOpen} sessionId={notificationMenuSession} onUnreadChange={setUnreadNotifications} /></div><div className="profile-menu-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setProfileMenuOpen(false); }}><button className="profile-menu-trigger" type="button" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}><Avatar initials={initialsText} className="top-avatar" src={identity?.avatarUrl || profile?.user?.avatarUrl} /></button>{profileMenuOpen && <div className="profile-menu-dropdown" role="menu"><Link href="/dashboard/profile" role="menuitem" onClick={() => setProfileMenuOpen(false)}>Profile / Settings</Link><button type="button" role="menuitem" onClick={() => { setProfileMenuOpen(false); signOut(); }}>Sign out</button></div>}</div></div></header>
        <div className="content-wrap">
          {loadError && <div className="dashboard-load-error" role="alert"><strong>We could not load your study dashboard.</strong><span>{loadError}</span><button type="button" onClick={() => window.location.reload()}>Try again</button></div>}
          {identity && !identity.emailVerified && <div className="email-verification-notice" role="status">Your account is ready. You can verify your email later. <Link href={`/resend-verification?email=${encodeURIComponent(identity.email)}`}>Get a verification link</Link></div>}
          {loading ? <DashboardSkeleton /> : loadError ? null : section === "overview" ? <><section className="welcome-row"><div><div className="eyebrow"><span className="live-dot" /> YOUR STUDY SPACE</div><h1>Welcome, {displayName}</h1><p className="welcome-copy">Your groups, courses, and study sessions in one place.</p></div><Link className="button button-primary welcome-cta" href="/dashboard/discover"><Icon name="plus" size={17} /> Find a study group</Link></section><section className="hero-card" aria-label="Weekly study progress"><div className="hero-content"><div className="hero-kicker">YOUR WEEKLY MOMENTUM</div><h2>Learn a little<br />together.</h2><p>{profile?.preferences?.weeklyGoalHours ? `Your weekly study goal is ${profile.preferences.weeklyGoalHours} hours.` : "Find a group, plan time to study, and make progress with your peers."}</p><Link className="hero-link" href="/dashboard/discover">Explore study groups <Icon name="arrow" size={16} /></Link></div><div className="hero-progress"><div className="progress-ring" role="img" aria-label={`${myGroups.length} study groups`}><div className="progress-ring-inner"><strong>{myGroups.length}<span> groups</span></strong><small>together</small></div></div><span className="progress-label">YOUR STUDY GROUPS</span><span className="progress-caption">{courses.length} courses</span></div><div className="hero-decoration hero-decoration-one" /><div className="hero-decoration hero-decoration-two" /></section><section className="quick-actions" aria-label="Quick actions"><Link className="quick-action" href="/dashboard/discover"><span className="quick-icon quick-icon-green"><Icon name="users" size={19} /></span><span><strong>Find a group</strong><small>Learn together</small></span><Icon name="chevron" size={16} /></Link><Link className="quick-action" href="/dashboard/sessions"><span className="quick-icon quick-icon-yellow"><Icon name="calendar" size={19} /></span><span><strong>Plan a session</strong><small>Pick a time to meet</small></span><Icon name="chevron" size={16} /></Link><Link className="quick-action" href="/dashboard/courses"><span className="quick-icon quick-icon-blue"><Icon name="book" size={19} /></span><span><strong>My courses</strong><small>Keep goals in view</small></span><Icon name="chevron" size={16} /></Link></section><StudentRecommendations compact onJoin={joinGroup} /><div className="dashboard-grid"><section className="panel groups-panel" id="groups"><div className="section-heading"><div><span className="section-overline">YOUR PEOPLE</span><h2>My study groups <span className="heading-count">{myGroups.length}</span></h2></div><Link className="text-link" href="/dashboard/groups">See all <Icon name="arrow" size={15} /></Link></div><div className="group-list">{myGroups.slice(0, 4).map((group) => <article className="group-card" key={group.id}><div className={`course-symbol ${group.color}`}><Icon name="book" size={19} /></div><div className="group-info"><h3>{group.name}</h3><p>{group.course}</p><div className="group-members"><span>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</span></div></div><Link className="circle-arrow" href={`/dashboard/groups/${group.id}`} aria-label={`Open ${group.name}`}><Icon name="arrow" size={17} /></Link></article>)}{myGroups.length === 0 && <p className="empty-state">You have not joined a group yet. <Link href="/dashboard/discover">Explore study groups</Link>.</p>}</div><Link className="browse-groups" href="/dashboard/discover"><Icon name="plus" size={16} /> Discover more study groups</Link></section><section className="panel sessions-panel" id="sessions"><div className="section-heading"><div><span className="section-overline">MAKE TIME TO LEARN</span><h2>Sessions &amp; deadlines</h2></div><Link className="text-link" href="/dashboard/sessions">All sessions <Icon name="arrow" size={15} /></Link></div>{sessions.length ? sessions.slice(0, 3).map((session) => <article className="session-card" key={session.id}><span className="session-accent" /><div className="session-time"><Icon name="clock" size={14} /> {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startsAt))}</div><h3>{session.title}</h3><p><Icon name="users" size={14} /> {session.groupName}</p><div className="session-bottom"><span><Icon name="pin" size={14} /> {session.location || session.mode}</span><span>{session.goingCount} attending</span></div></article>) : <p className="empty-state">No upcoming study sessions. <Link href="/dashboard/sessions">View sessions</Link>.</p>}</section></div></> : <DashboardSection section={section} search={search} setSearch={setSearch} searchRef={searchRef} groups={pageGroups} courses={courses} sessions={sessions} loading={loading || discoverLoading} onJoin={joinGroup} onCreateGroup={openGroupCreate} profile={profile} onProfileSaved={updateProfile} onNotice={showNotice} onUnreadChange={setUnreadNotifications} identity={identity} initialConversationId={initialConversationId} meetingId={meetingId} />}
        </div>
      </section>

      {groupCreateOpen && <div className="workspace-modal-backdrop"><section className="panel workspace-create-modal group-create-modal" role="dialog" aria-modal="true" aria-labelledby="group-create-title"><div className="workspace-create-heading"><div><span className="section-overline">{createdGroupForInvites ? "GROW YOUR STUDY CREW" : "START A STUDY CREW"}</span><h2 id="group-create-title">{createdGroupForInvites ? "Invite classmates" : "Create a study group"}</h2></div><button className="workspace-modal-close" type="button" aria-label="Close" onClick={() => setGroupCreateOpen(false)} disabled={groupCreateBusy || Boolean(invitingStudentId)}><Icon name="close" size={17} /></button></div>{createdGroupForInvites ? <div className="group-invite-step"><p className="group-create-intro"><strong>{createdGroupForInvites.name}</strong> is ready. Invite classmates directly or close this dialog.</p><form className="group-invite-search" onSubmit={searchInviteCandidates}><input aria-label="Search classmates" maxLength={120} value={inviteSearch} onChange={(event) => setInviteSearch(event.target.value)} placeholder="Search classmates by name" /><button className="button button-secondary" type="submit" disabled={inviteLoading}>{inviteLoading ? "Searching..." : "Search"}</button></form>{inviteError && <p className="group-create-error" role="alert">{inviteError}</p>}<div className="group-invite-results">{inviteCandidates.map((student) => <article className="group-invite-candidate" key={student.id}><span className="group-invite-avatar">{[student.firstName?.[0], student.lastName?.[0]].filter(Boolean).join("").toUpperCase()}</span><span className="group-invite-person"><strong>{student.firstName} {student.lastName}</strong><small>{student.programName || `${student.sharedCourses || 0} shared courses`}</small></span><button className="button button-secondary group-invite-button" type="button" disabled={!student.canInvite || invitedStudentIds.includes(student.id) || invitingStudentId === student.id} onClick={() => inviteStudent(student)}>{invitedStudentIds.includes(student.id) ? "Invited" : invitingStudentId === student.id ? "Sending..." : student.canInvite ? "Invite" : "Unavailable"}</button></article>)}{!inviteLoading && inviteCandidates.length === 0 && <p className="empty-state">Search for classmates to invite them.</p>}</div><div className="workspace-create-actions"><button className="button button-primary" type="button" onClick={() => setGroupCreateOpen(false)}>Done</button></div></div> : profile?.courses?.length ? <form className="workspace-create-form" onSubmit={createStudyGroup}><label>Group name<input required minLength={3} maxLength={80} value={groupCreateName} onChange={(event) => setGroupCreateName(event.target.value)} placeholder="e.g. Calculus study crew" /></label><label>Course<select required value={groupCreateCourseId} onChange={(event) => setGroupCreateCourseId(event.target.value)}>{profile.courses.map((course) => <option value={course.id} key={course.id}>{course.courseCode} · {course.name}</option>)}</select></label><label>Description <span>(optional)</span><textarea maxLength={500} rows={3} value={groupCreateDescription} onChange={(event) => setGroupCreateDescription(event.target.value)} placeholder="What would you like to study together?" /></label>{groupCreateError && <p className="group-create-error" role="alert">{groupCreateError}</p>}<div className="workspace-create-actions"><button className="button button-secondary" type="button" onClick={() => setGroupCreateOpen(false)} disabled={groupCreateBusy}>Cancel</button><button className="button button-primary" type="submit" disabled={groupCreateBusy || !groupCreateCourseId}>{groupCreateBusy ? "Creating..." : "Create group"}</button></div></form> : <div className="workspace-create-empty"><p>Add a course to your profile before creating a study group.</p><Link className="button button-primary" href="/dashboard/profile" onClick={() => setGroupCreateOpen(false)}>Add courses to profile</Link></div>}</section></div>}

       <nav className="mobile-nav" aria-label="Mobile navigation">{[{ label: "Home", icon: "home", href: "/dashboard", active: "Dashboard" }, { label: "Groups", icon: "users", href: "/dashboard/groups", active: "My Groups" }, { label: "Discover", icon: "search", href: "/dashboard/discover", active: "Discover Groups" }].map((item) => <Link href={item.href} key={item.label} className={`mobile-nav-link ${activeNav === item.active ? "selected" : ""}`}><Icon name={item.icon} size={19} /><span>{item.label}</span></Link>)}</nav>
      <div className={`toast ${notice ? "visible" : ""}`} role="status" aria-live="polite">{notice}</div>
      <FloatingAssistant />
    </main>
  );
}
