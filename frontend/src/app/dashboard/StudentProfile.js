"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import NotificationPreferences from "./NotificationPreferences";

async function apiRequest(path, options = {}, retryUnauthorized = true) {
  let response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401 && retryUnauthorized && path !== "auth/me") {
    await apiRequest("auth/me", {}, false);
    response = await fetch(`/api/${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
  }
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error?.message || "We couldn’t save your profile.");
  return result.data;
}

async function createProfilePhoto(file) {
  const acceptedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!acceptedTypes.includes(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Choose an image smaller than 8 MB.");
  }

  const image = await createImageBitmap(file);
  try {
    if (image.width > 6000 || image.height > 6000 || image.width * image.height > 20_000_000) {
      throw new Error("That image has too many pixels. Choose a smaller image.");
    }

    for (const dimension of [256, 192, 128]) {
      const scale = Math.min(1, dimension / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Your browser couldn’t prepare that image.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      for (const quality of [0.84, 0.72, 0.6, 0.48]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= 80_000) return dataUrl;
      }
    }
  } finally {
    image.close();
  }
  throw new Error("That image couldn’t be compressed enough. Choose a simpler image.");
}

function SettingsIcon({ name }) {
  const paths = {
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.4 3.1-5 7-5s6.2 1.6 7 5" /></>,
    study: <><path d="M3 9.5 12 5l9 4.5-9 4.5-9-4.5Z" /><path d="M6.5 11.5v4c3.2 2.5 7.8 2.5 11 0v-4M21 10v6" /></>,
    courses: <><path d="M5 4.5h13a1 1 0 0 1 1 1v14H6a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" /><path d="M7 8h8M7 12h8M7 16h5" /></>,
    topics: <><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="19" cy="17.5" r="2.5" /></>,
    privacy: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v2" /></>,
    notifications: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></>,
  };
  return <svg className="settings-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function StudentProfile({ initialProfile, onSaved, onNotice }) {
  const [activeSettingsTab, setActiveSettingsTab] = useState("profile");
  const [profile, setProfile] = useState(initialProfile);
  const [profilePhotoDraft, setProfilePhotoDraft] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    firstName: initialProfile?.user?.firstName || "",
    lastName: initialProfile?.user?.lastName || "",
    bio: initialProfile?.academic?.bio || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const [preferences, setPreferences] = useState(() => initialProfile?.preferences || {
    preferredMode: "EITHER",
    preferredStyle: "MIXED",
    minGroupSize: 2,
    maxGroupSize: 8,
    sessionMinutes: 60,
    weeklyGoalHours: 0,
    partnerPreferences: "",
  });
  const [privacy, setPrivacy] = useState(() => initialProfile?.privacy || {
    discoverable: true,
    showAvailability: true,
    showSkills: true,
    shareProgress: true,
    aiPersonalised: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function chooseProfilePhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError("");
    try {
      setProfilePhotoDraft(await createProfilePhoto(file));
    } catch (photoError) {
      setError(photoError.message || "We couldn’t prepare that image.");
    }
  }

  async function saveProfilePhoto() {
    if (!profilePhotoDraft) return;
    setPhotoBusy(true);
    setError("");
    try {
      const data = await apiRequest("students/me", {
        method: "PATCH",
        body: JSON.stringify({ avatarUrl: profilePhotoDraft }),
      });
      setProfile(data.profile);
      setProfilePhotoDraft("");
      onSaved?.(data.profile);
      onNotice?.("Profile picture saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await apiRequest("students/me", { method: "PATCH", body: JSON.stringify(form) });
      setProfile(data.profile);
      onSaved?.(data.profile);
      onNotice?.("Personal details saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePreferences(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest("students/me/preferences", {
        method: "PUT",
        body: JSON.stringify({
          ...preferences,
          minGroupSize: Number(preferences.minGroupSize),
          maxGroupSize: Number(preferences.maxGroupSize),
          sessionMinutes: Number(preferences.sessionMinutes),
          weeklyGoalHours: Number(preferences.weeklyGoalHours),
        }),
      });
      onNotice?.("Study preferences saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePrivacy(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest("students/me/privacy", { method: "PUT", body: JSON.stringify(privacy) });
      onNotice?.("Privacy settings saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const completeness = profile?.completeness;
  const nextUp = completeness?.nextUp;
  const settingsTabs = [
    { id: "profile", label: "Profile", icon: "profile" },
    { id: "study", label: "Study preferences", icon: "study" },
    { id: "courses", label: "Courses & goals", icon: "courses" },
    { id: "topics", label: "Topics & skills", icon: "topics" },
    { id: "privacy", label: "Privacy", icon: "privacy" },
    { id: "notifications", label: "Notifications", icon: "notifications" },
  ];
  const activeTab = settingsTabs.find((tab) => tab.id === activeSettingsTab) || settingsTabs[0];

  return (
    <section className="section-page">
      <div className="section-page-heading">
        <span className="section-overline">YOUR ACCOUNT</span>
        <h1>Settings</h1>
        <p>Manage your profile and study preferences.</p>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsTabs.map((tab) => (
            <button
              className={`settings-nav-item ${activeSettingsTab === tab.id ? "active" : ""}`}
              type="button"
              key={tab.id}
              aria-current={activeSettingsTab === tab.id ? "page" : undefined}
              onClick={() => {
                setActiveSettingsTab(tab.id);
                setError("");
              }}
            >
              <SettingsIcon name={tab.icon} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <header className="settings-content-heading">
            <h2>{activeTab.label}</h2>
            <p>{{
              profile: "Manage the personal details shown on your study profile.",
              study: "Choose how you like to study and what group fits you.",
              courses: "Manage the courses, goals, and availability used for matching.",
              topics: "Rate your topic strengths and list the skills you bring or want to build.",
              privacy: "Control what other students can see and how recommendations work.",
              notifications: "Choose how Twigane keeps you up to date.",
            }[activeSettingsTab]}</p>
          </header>
          {error && <div className="feature-error" role="alert">{error}</div>}
          {activeSettingsTab === "profile" && (
            <>
              <section className="panel profile-photo-editor" aria-labelledby="profile-photo-heading">
                <div className="profile-photo-preview">
                  {(profilePhotoDraft || profile?.user?.avatarUrl)
                    ? <Image src={profilePhotoDraft || profile.user.avatarUrl} alt="Profile picture preview" width={256} height={256} unoptimized />
                    : <span>{`${profile?.user?.firstName?.[0] || ""}${profile?.user?.lastName?.[0] || ""}`.toUpperCase() || "?"}</span>}
                </div>
                <div className="profile-photo-details">
                  <h2 id="profile-photo-heading">Profile picture</h2>
                  <p>Upload a JPG, PNG, or WebP image. It will be cropped to fit your profile circle.</p>
                  <div className="profile-photo-actions">
                    <label className="button button-secondary profile-photo-choose">
                      Choose image
                      <input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseProfilePhoto} />
                    </label>
                    <button className="button button-primary" type="button" disabled={!profilePhotoDraft || photoBusy} onClick={saveProfilePhoto}>
                      {photoBusy ? "Saving…" : "Save picture"}
                    </button>
                  </div>
                </div>
              </section>
              {completeness && (
                <div className="panel profile-completeness">
                  <div><strong>Study profile {completeness.percentage}% complete</strong><p>{completeness.message}</p></div>
                  <div className="completeness-track" role="progressbar" aria-label="Study profile completeness" aria-valuenow={completeness.percentage} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${completeness.percentage}%` }} />
                  </div>
                  {nextUp && <small>Next helpful step: {nextUp.title}</small>}
                </div>
              )}
              <form className="panel feature-form" onSubmit={saveProfile}>
                <h2>Personal details</h2>
                <div className="feature-form-grid">
                  <label>First name<input required maxLength={80} value={form.firstName || ""} onChange={(event) => setForm({ ...form, firstName: event.target.value })} /></label>
                  <label>Last name<input required maxLength={80} value={form.lastName || ""} onChange={(event) => setForm({ ...form, lastName: event.target.value })} /></label>
                  <label className="form-span">About you<textarea rows={3} maxLength={500} value={form.bio || ""} onChange={(event) => setForm({ ...form, bio: event.target.value })} placeholder="What are you learning, or what makes a good study session for you?" /></label>
                </div>
                <div className="profile-readonly"><span>Email</span><strong>{profile?.user?.email || "—"}</strong></div>
                {profile?.academic?.universityName && <div className="profile-readonly"><span>University</span><strong>{profile.academic.universityName}</strong></div>}
                <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save personal details"}</button>
              </form>
            </>
          )}
          {activeSettingsTab === "study" && preferences && (
            <form className="panel feature-form" onSubmit={savePreferences}>
              <h2>Study preferences</h2>
              <div className="feature-form-grid">
                <label>Study format<select value={preferences.preferredMode} onChange={(event) => setPreferences({ ...preferences, preferredMode: event.target.value })}><option value="EITHER">Either</option><option value="ONLINE">Online</option><option value="PHYSICAL">In person</option></select></label>
                <label>Study style<select value={preferences.preferredStyle} onChange={(event) => setPreferences({ ...preferences, preferredStyle: event.target.value })}><option value="MIXED">A mix of styles</option><option value="DISCUSS">Discussion</option><option value="PROBLEM_SOLVING">Problem solving</option><option value="TEACH_BACK">Teach-back</option><option value="QUIET_FOCUS">Quiet focus</option></select></label>
                <label>Minimum group size<input type="number" min="2" max="12" value={preferences.minGroupSize} onChange={(event) => setPreferences({ ...preferences, minGroupSize: event.target.value })} /></label>
                <label>Maximum group size<input type="number" min="2" max="12" value={preferences.maxGroupSize} onChange={(event) => setPreferences({ ...preferences, maxGroupSize: event.target.value })} /></label>
                <label>Usual session length (minutes)<input type="number" min="30" max="480" step="15" value={preferences.sessionMinutes} onChange={(event) => setPreferences({ ...preferences, sessionMinutes: event.target.value })} /></label>
                <label>Weekly study goal (hours)<input type="number" min="0" max="60" value={preferences.weeklyGoalHours} onChange={(event) => setPreferences({ ...preferences, weeklyGoalHours: event.target.value })} /></label>
                <label className="form-span">What I’m looking for in a study partner<textarea rows={3} maxLength={500} value={preferences.partnerPreferences || ""} onChange={(event) => setPreferences({ ...preferences, partnerPreferences: event.target.value })} placeholder="e.g. Someone who can explain statistics, prefers quiet morning sessions, and is focused on exam prep." /></label>
              </div>
              <button className="button button-primary" type="submit" disabled={busy}>Save study preferences</button>
            </form>
          )}
          <div hidden={activeSettingsTab !== "courses"}>
            <ProfileLearningSettings initialProfile={profile} onSaved={(next) => {
              setProfile(next);
              onSaved?.(next);
            }} onNotice={onNotice} />
          </div>
          <div hidden={activeSettingsTab !== "topics"}>
            <ProfileTopicsAndSkills initialProfile={profile} onSaved={(next) => {
              setProfile(next);
              onSaved?.(next);
            }} onNotice={onNotice} />
          </div>
          {activeSettingsTab === "privacy" && privacy && (
            <form className="panel feature-form" onSubmit={savePrivacy}>
              <h2>Privacy and discovery</h2>
              <p className="feature-muted">You control which profile details help other students find compatible study partners.</p>
              <div className="feature-check-list">
                {[
                  ["discoverable", "Let other students discover my profile"],
                  ["showAvailability", "Share my available study times"],
                  ["showSkills", "Show my skills and topic strengths"],
                  ["shareProgress", "Share my group learning progress"],
                  ["aiPersonalised", "Allow personalised recommendations"],
                ].map(([key, label]) => (
                  <label key={key}><input type="checkbox" checked={Boolean(privacy[key])} onChange={(event) => setPrivacy({ ...privacy, [key]: event.target.checked })} />{label}</label>
                ))}
              </div>
              <button className="button button-primary" type="submit" disabled={busy}>Save privacy settings</button>
            </form>
          )}
          <div hidden={activeSettingsTab !== "notifications"}>
            <NotificationPreferences onNotice={onNotice} />
          </div>
        </div>
      </div>
    </section>
  );
}

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function ProfileLearningSettings({ initialProfile, onSaved, onNotice }) {
  const [savedProfile, setSavedProfile] = useState(initialProfile);
  const [courseQuery, setCourseQuery] = useState("");
  const [catalogueCourses, setCatalogueCourses] = useState([]);
  const [catalogueGoals, setCatalogueGoals] = useState([]);
  const [courseIds, setCourseIds] = useState(() => initialProfile?.courses?.map((course) => course.id) || []);
  const [goalIds, setGoalIds] = useState(() => initialProfile?.goals?.map((goal) => goal.id) || []);
  const [availability, setAvailability] = useState(() => initialProfile?.availability || []);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [knownCourses, setKnownCourses] = useState(() => Object.fromEntries(
    (initialProfile?.courses || []).map((course) => [course.id, course]),
  ));

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ limit: "15" });
    if (courseQuery.trim()) query.set("q", courseQuery.trim());
    const timer = window.setTimeout(() => {
      apiRequest(`academic/courses?${query.toString()}`)
        .then((result) => {
          if (!active) return;
          const courses = result.courses || [];
          setCatalogueCourses(courses);
          setKnownCourses((current) => ({
            ...current,
            ...Object.fromEntries(courses.map((course) => [course.id, course])),
          }));
        })
        .catch((requestError) => {
          if (active) setError(requestError.message);
        })
        .finally(() => {
          if (active) setLoadingCourses(false);
        });
    }, courseQuery ? 220 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [courseQuery]);

  useEffect(() => {
    let active = true;
    apiRequest("academic/learning-goals")
      .then((result) => {
        if (active) setCatalogueGoals(result.goals || []);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      });
    return () => { active = false; };
  }, []);

  async function reloadProfile() {
    const result = await apiRequest("students/me");
    setSavedProfile(result.profile);
    onSaved?.(result.profile);
  }

  async function saveCourses(event) {
    event.preventDefault();
    if (courseIds.length === 0) {
      setError("Keep at least one course in your profile.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await apiRequest("students/me/courses", { method: "PUT", body: JSON.stringify({ courseIds }) });
      const nextProfile = {
        ...savedProfile,
        courses: result.courses.map((course) => ({
          id: course.id,
          courseCode: course.course_code,
          name: course.name,
        })),
      };
      setSavedProfile(nextProfile);
      onSaved?.(nextProfile);
      onNotice?.("Courses saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveGoals(event) {
    event.preventDefault();
    if (goalIds.length === 0) {
      setError("Choose at least one learning goal.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiRequest("students/me/goals", {
        method: "PUT",
        body: JSON.stringify({ goals: goalIds.map((goalId) => ({ goalId })) }),
      });
      onNotice?.("Learning goals saved.");
      await reloadProfile();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveAvailability(event) {
    event.preventDefault();
    const slots = availability.map((slot) => ({
      dayOfWeek: Number(slot.dayOfWeek),
      startMinute: Number(slot.startMinute),
      endMinute: Number(slot.endMinute),
      isPreferred: Boolean(slot.isPreferred),
    }));
    if (slots.some((slot) => slot.endMinute <= slot.startMinute)) {
      setError("Each available time must end after it starts.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiRequest("students/me/availability", { method: "PUT", body: JSON.stringify({ slots }) });
      onNotice?.("Study availability saved.");
      await reloadProfile();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  function toggleCourse(courseId) {
    setCourseIds((current) => current.includes(courseId)
      ? current.filter((id) => id !== courseId)
      : [...current, courseId]);
  }

  function toggleGoal(goalId) {
    setGoalIds((current) => current.includes(goalId)
      ? current.filter((id) => id !== goalId)
      : current.length < 5 ? [...current, goalId] : current);
  }

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return (
    <>
      {error && <div className="feature-error" role="alert">{error}</div>}
      <form className="panel feature-form" onSubmit={saveCourses}>
        <h2>Courses</h2>
        <p className="feature-muted">Choose the courses you’re taking so recommendations focus on your real study needs.</p>
        <label className="catalogue-search">Find a course<input value={courseQuery} onChange={(event) => setCourseQuery(event.target.value)} placeholder="Search by course name or code" /></label>
        <div className="selected-course-list">
          <strong>Your selected courses ({courseIds.length})</strong>
          {courseIds.map((id) => {
            const course = knownCourses[id];
            return <span className="selected-course-chip" key={id}>{course?.course_code || course?.courseCode || "Course"} · {course?.name || "Selected"}<button type="button" aria-label={`Remove ${course?.name || "course"}`} onClick={() => toggleCourse(id)}>×</button></span>;
          })}
        </div>
        {loadingCourses && <p className="empty-state">Loading course catalogue…</p>}
        <div className="course-option-list">
          {catalogueCourses.map((course) => <label key={course.id}><input type="checkbox" checked={courseIds.includes(course.id)} disabled={!courseIds.includes(course.id) && courseIds.length >= 12} onChange={() => toggleCourse(course.id)} /><span><strong>{course.course_code}</strong> {course.name}</span></label>)}
          {!loadingCourses && catalogueCourses.length === 0 && <p className="empty-state">No courses match that search.</p>}
        </div>
        <button className="button button-primary" disabled={saving}>Save courses</button>
      </form>
      <form className="panel feature-form" onSubmit={saveGoals}>
        <h2>Learning goals</h2>
        <p className="feature-muted">Choose one or more goals to help shape group matches.</p>
        <div className="course-option-list">
          {catalogueGoals.map((goal) => <label key={goal.id}><input type="checkbox" checked={goalIds.includes(goal.id)} disabled={!goalIds.includes(goal.id) && goalIds.length >= 5} onChange={() => toggleGoal(goal.id)} /><span><strong>{goal.label}</strong>{goal.description && <small>{goal.description}</small>}</span></label>)}
          {catalogueGoals.length === 0 && <p className="empty-state">Loading learning goals…</p>}
        </div>
        <button className="button button-primary" disabled={saving || catalogueGoals.length === 0}>Save learning goals</button>
      </form>
      <form className="panel feature-form" onSubmit={saveAvailability}>
        <h2>When you’re available</h2>
        <p className="feature-muted">Share typical study times to help the recommendation engine find groups with compatible schedules.</p>
        <div className="availability-list">
          {availability.map((slot, index) => <div className="availability-row" key={`${slot.dayOfWeek}-${slot.startMinute}-${index}`}>
            <label>Day<select value={slot.dayOfWeek} onChange={(event) => setAvailability((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, dayOfWeek: Number(event.target.value) } : item))}>{days.map((day, dayIndex) => <option value={dayIndex} key={day}>{day}</option>)}</select></label>
            <label>From<input type="time" value={minutesToTime(slot.startMinute)} onChange={(event) => setAvailability((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, startMinute: timeToMinutes(event.target.value) } : item))} /></label>
            <label>Until<input type="time" value={minutesToTime(slot.endMinute)} onChange={(event) => setAvailability((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, endMinute: timeToMinutes(event.target.value) } : item))} /></label>
            <button className="recommendation-dismiss" type="button" onClick={() => setAvailability((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
          </div>)}
        </div>
        <div className="availability-actions">
          <button className="button button-secondary" type="button" disabled={availability.length >= 40} onClick={() => setAvailability((current) => [...current, { dayOfWeek: 1, startMinute: 1080, endMinute: 1200, isPreferred: true }])}>Add available time</button>
          <button className="button button-primary" disabled={saving}>Save availability</button>
        </div>
      </form>
    </>
  );
}

const TOPIC_STATUS_OPTIONS = [
  ["NEEDS_HELP", "I need help"],
  ["LEARNING", "Still learning"],
  ["COMFORTABLE", "Comfortable"],
  ["STRONG", "I can teach this"],
];

const PROFICIENCY_OPTIONS = [
  ["BEGINNER", "Beginner"],
  ["INTERMEDIATE", "Intermediate"],
  ["ADVANCED", "Advanced"],
  ["EXPERT", "Expert"],
];

function ProfileTopicsAndSkills({ initialProfile, onSaved, onNotice }) {
  const [courses] = useState(() => initialProfile?.courses || []);
  const [activeCourseId, setActiveCourseId] = useState(() => initialProfile?.courses?.[0]?.id || "");
  const [courseTopics, setCourseTopics] = useState({});
  const [loadingTopics, setLoadingTopics] = useState(() => (initialProfile?.courses?.length || 0) > 0);
  const [ratings, setRatings] = useState(() => Object.fromEntries(
    (initialProfile?.topics || []).map((topic) => [topic.topicId, topic.status]),
  ));
  const [skills, setSkills] = useState(() => (initialProfile?.skills || []).map((skill) => ({
    skillId: skill.skillId,
    courseId: skill.courseId || null,
    proficiency: skill.proficiency || "INTERMEDIATE",
    isLearning: Boolean(skill.isLearning),
  })));
  const [knownSkills, setKnownSkills] = useState(() => Object.fromEntries(
    (initialProfile?.skills || []).map((skill) => [skill.skillId, { name: skill.name, category: skill.category }]),
  ));
  const [skillQuery, setSkillQuery] = useState("");
  const [skillResults, setSkillResults] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [myRequests, setMyRequests] = useState([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [requestKind, setRequestKind] = useState("TOPIC");
  const [requestTitle, setRequestTitle] = useState("");
  const [requestCourseId, setRequestCourseId] = useState(() => initialProfile?.courses?.[0]?.id || "");
  const [requestNote, setRequestNote] = useState("");
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all(courses.map((course) => apiRequest(`academic/courses/${course.id}/topics`).then((result) => [course.id, result.topics || []])))
      .then((entries) => {
        if (active) setCourseTopics(Object.fromEntries(entries));
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoadingTopics(false);
      });
    return () => { active = false; };
  }, [courses]);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ limit: "20" });
    if (skillQuery.trim()) query.set("q", skillQuery.trim());
    const timer = window.setTimeout(() => {
      setLoadingSkills(true);
      apiRequest(`academic/skills?${query.toString()}`)
        .then((result) => {
          if (!active) return;
          setSkillResults(result.skills || []);
        })
        .catch((requestError) => {
          if (active) setError(requestError.message);
        })
        .finally(() => {
          if (active) setLoadingSkills(false);
        });
    }, skillQuery ? 220 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [skillQuery]);

  async function reloadProfile() {
    const result = await apiRequest("students/me");
    onSaved?.(result.profile);
  }

  async function saveTopics(event) {
    event.preventDefault();
    const topics = Object.entries(ratings)
      .filter(([, status]) => Boolean(status))
      .map(([topicId, status]) => ({ topicId, status }));
    setSaving(true);
    setError("");
    try {
      await apiRequest("students/me/topics", { method: "PUT", body: JSON.stringify({ topics }) });
      onNotice?.("Topic strengths saved.");
      await reloadProfile();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveSkills(event) {
    event.preventDefault();
    const payload = skills.map((skill) => ({
      skillId: skill.skillId,
      courseId: skill.courseId || undefined,
      proficiency: skill.proficiency,
      isLearning: skill.isLearning,
    }));
    setSaving(true);
    setError("");
    try {
      await apiRequest("students/me/skills", { method: "PUT", body: JSON.stringify({ skills: payload }) });
      onNotice?.("Skills saved.");
      await reloadProfile();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  function addSkill(skill) {
    setKnownSkills((current) => ({ ...current, [skill.id]: { name: skill.name, category: skill.category } }));
    setSkills((current) => current.some((entry) => entry.skillId === skill.id)
      ? current
      : [...current, { skillId: skill.id, courseId: null, proficiency: "INTERMEDIATE", isLearning: false }]);
  }

  function removeSkill(skillId) {
    setSkills((current) => current.filter((entry) => entry.skillId !== skillId));
  }

  useEffect(() => {
    let active = true;
    apiRequest("students/me/catalogue-requests")
      .then((result) => {
        if (active) setMyRequests(result.requests || []);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoadingRequests(false);
      });
    return () => { active = false; };
  }, []);

  async function addCatalogueRequest(event) {
    event.preventDefault();
    const title = requestTitle.trim();
    if (!title) {
      setError("Describe what you’d like added.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = { kind: requestKind, title };
      if (requestKind === "TOPIC") body.courseId = requestCourseId || undefined;
      if (requestNote.trim()) body.note = requestNote.trim();
      const result = await apiRequest("students/me/catalogue-requests", { method: "POST", body: JSON.stringify(body) });
      setMyRequests((current) => [result.request, ...current]);
      setRequestTitle("");
      setRequestNote("");
      onNotice?.("Request submitted — an administrator will review it.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  const activeTopics = courseTopics[activeCourseId] || [];
  const ratedCount = Object.values(ratings).filter(Boolean).length;

  return (
    <>
      {error && <div className="feature-error" role="alert">{error}</div>}
      <form className="panel feature-form" onSubmit={saveTopics}>
        <h2>Topic strengths</h2>
        <p className="feature-muted">Rate the topics in your courses. Flag the ones you need help with and the ones you can teach — matching pairs complementary gaps, so both are useful.</p>
        {courses.length === 0
          ? <p className="empty-state">Add courses in “Courses &amp; goals” first to rate their topics.</p>
          : (
            <>
              <div className="topic-course-tabs" role="tablist" aria-label="Your courses">
                {courses.map((course) => (
                  <button
                    type="button"
                    key={course.id}
                    role="tab"
                    aria-selected={activeCourseId === course.id}
                    className={`topic-course-tab ${activeCourseId === course.id ? "active" : ""}`}
                    onClick={() => setActiveCourseId(course.id)}
                  >
                    {course.courseCode || course.name}
                  </button>
                ))}
              </div>
              {loadingTopics && <p className="empty-state">Loading topics…</p>}
              {!loadingTopics && (
                <div className="course-option-list">
                  {activeTopics.map((topic) => (
                    <label key={topic.id} className="topic-row">
                      <span><strong>{topic.name}</strong>{topic.description && <small>{topic.description}</small>}</span>
                      <select
                        value={ratings[topic.id] || ""}
                        onChange={(event) => setRatings((current) => ({ ...current, [topic.id]: event.target.value }))}
                      >
                        <option value="">Not rated</option>
                        {TOPIC_STATUS_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                      </select>
                    </label>
                  ))}
                  {activeTopics.length === 0 && <p className="empty-state">No topics are listed for this course yet.</p>}
                </div>
              )}
            </>
          )}
        <button className="button button-primary" disabled={saving || courses.length === 0}>Save topic strengths{ratedCount ? ` (${ratedCount})` : ""}</button>
      </form>
      <form className="panel feature-form" onSubmit={saveSkills}>
        <h2>Skills</h2>
        <p className="feature-muted">List the skills you bring and the ones you’re building. These sharpen who the matcher suggests for you.</p>
        <label className="catalogue-search">Find a skill<input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="Search skills by name" /></label>
        <div className="selected-course-list">
          <strong>Your skills ({skills.length})</strong>
          {skills.map((skill) => (
            <span className="skill-chip" key={`${skill.skillId}:${skill.courseId || "global"}`}>
              <strong>{knownSkills[skill.skillId]?.name || "Skill"}</strong>
              <select value={skill.proficiency} onChange={(event) => setSkills((current) => current.map((entry) => entry.skillId === skill.skillId ? { ...entry, proficiency: event.target.value } : entry))}>
                {PROFICIENCY_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              <label className="skill-learning"><input type="checkbox" checked={skill.isLearning} onChange={(event) => setSkills((current) => current.map((entry) => entry.skillId === skill.skillId ? { ...entry, isLearning: event.target.checked } : entry))} />Learning</label>
              <button type="button" aria-label={`Remove ${knownSkills[skill.skillId]?.name || "skill"}`} onClick={() => removeSkill(skill.skillId)}>×</button>
            </span>
          ))}
        </div>
        {loadingSkills && <p className="empty-state">Loading skill catalogue…</p>}
        <div className="course-option-list">
          {skillResults.map((skill) => (
            <label key={skill.id}>
              <input type="checkbox" checked={skills.some((entry) => entry.skillId === skill.id)} onChange={() => (skills.some((entry) => entry.skillId === skill.id) ? removeSkill(skill.id) : addSkill(skill))} />
              <span><strong>{skill.name}</strong>{skill.category && <small>{skill.category}</small>}</span>
            </label>
          ))}
          {!loadingSkills && skillResults.length === 0 && <p className="empty-state">No skills match that search.</p>}
        </div>
        <button className="button button-primary" disabled={saving}>Save skills</button>
      </form>
      <form className="panel feature-form" onSubmit={addCatalogueRequest}>
        <h2>Request a missing topic, skill, or course</h2>
        <p className="feature-muted">Something you study isn’t in the catalogue yet? Ask for it — an administrator reviews requests and adds approved items so everyone can use them.</p>
        <div className="feature-form-grid">
          <label>What’s missing?
            <select value={requestKind} onChange={(event) => setRequestKind(event.target.value)}>
              <option value="TOPIC">A topic in one of my courses</option>
              <option value="SKILL">A skill</option>
              <option value="COURSE">A course</option>
            </select>
          </label>
          <label>Name
            <input required maxLength={200} value={requestTitle} onChange={(event) => setRequestTitle(event.target.value)} placeholder={requestKind === "COURSE" ? "e.g. Machine Learning Operations" : requestKind === "SKILL" ? "e.g. Data cleaning" : "e.g. Bayesian inference"} />
          </label>
          {requestKind === "TOPIC" && (
            <label>Course it belongs to
              <select value={requestCourseId} onChange={(event) => setRequestCourseId(event.target.value)}>
                {courses.map((course) => <option value={course.id} key={course.id}>{course.courseCode || course.name}</option>)}
              </select>
            </label>
          )}
          <label className="form-span">Anything to help the reviewer?
            <textarea rows={3} maxLength={600} value={requestNote} onChange={(event) => setRequestNote(event.target.value)} placeholder="e.g. Why it matters, where it fits, references…" />
          </label>
        </div>
        <button className="button button-primary" disabled={saving}>Submit request</button>
      </form>
      <section className="panel feature-form">
        <h2>Your requests</h2>
        {loadingRequests ? (
          <p className="empty-state">Loading your requests…</p>
        ) : myRequests.length === 0 ? (
          <p className="empty-state">No requests yet. Request a missing topic, skill, or course above.</p>
        ) : (
          <div className="request-history-list">
            {myRequests.map((request) => (
              <div className="request-history-row" key={request.id}>
                <div>
                  <strong>{request.title}</strong>
                  <span className={`request-status request-status-${request.status.toLowerCase()}`}>
                    {request.status === "APPROVED" ? "Added" : request.status === "DECLINED" ? "Declined" : "In review"}
                  </span>
                </div>
                <small>
                  {request.kind === "TOPIC" ? "Topic" : request.kind === "SKILL" ? "Skill" : "Course"}
                  {request.adminNote && <span className="request-admin-note"> · {request.adminNote}</span>}
                </small>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
