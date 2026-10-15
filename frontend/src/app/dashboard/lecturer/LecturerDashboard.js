"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BrandLogo from "../../BrandLogo";
import ThemeToggle from "../../ThemeToggle";

/**
 * Lecturer landing page.
 *
 * Scoped entirely to the signed-in lecturer's own assigned courses. The API
 * (`GET /api/lecturer/overview`) derives everything from `lecturer_courses`, so
 * this page can never surface another lecturer's data or unrelated groups, and
 * it never receives private group chat or individual student records.
 */

async function apiRequest(path, options, retryUnauthorized = true) {
  let response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  // A 401 can simply mean the short-lived access cookie expired. The BFF
  // refreshes on `auth/me`; retry once before treating it as signed out.
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
    const error = new Error(result.error?.message || "We could not complete that request.");
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return result.data;
}

function displayNameOf(user) {
  return (
    [user?.firstName || user?.first_name, user?.lastName || user?.last_name].filter(Boolean).join(" ") ||
    user?.email ||
    "Lecturer"
  );
}

const PRIVACY_LABELS = {
  PUBLIC: "Public",
  REQUEST_REQUIRED: "Request to join",
  INVITE_ONLY: "Invite only",
};

export default function LecturerDashboard() {
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiRequest("lecturer/overview");
      setData(result);
    } catch (requestError) {
      if (requestError.status === 401) {
        window.location.replace("/login?next=/dashboard/lecturer");
        return;
      }
      if (requestError.status === 403) {
        setError("Your account does not have lecturer access to this dashboard.");
      } else {
        setError(requestError.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      let auth;
      try {
        auth = await apiRequest("auth/me");
      } catch (authError) {
        if (!active) return;
        if (authError.status === 401) {
          window.location.replace("/login?next=/dashboard/lecturer");
          return;
        }
        setError(authError.message);
        setLoading(false);
        return;
      }

      if (!active) return;

      // Route each role to its own home rather than showing an access error.
      if (auth.user?.role === "ADMIN") {
        window.location.replace("/admin");
        return;
      }
      if (auth.user?.role === "STUDENT") {
        window.location.replace("/dashboard");
        return;
      }
      if (auth.user?.role !== "LECTURER") {
        setError("Your account does not have lecturer access to this dashboard.");
        setLoading(false);
        return;
      }

      setIdentity(auth.user);
      await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  const courses = data?.courses || [];
  const groups = data?.groups || [];
  const participation = data?.participation || {};
  const metricNotes = data?.metricNotes || {};
  const isEmpty = !loading && !error && courses.length === 0;

  return (
    <main className="landing-page lecturer-page">
      <header className="landing-header lecturer-topbar">
        <Link className="landing-brand" href="/" aria-label="Lien home">
          <BrandLogo className="lien-logo" />
        </Link>
        <div className="lecturer-topbar-actions">
          <ThemeToggle />
          <Link className="button button-secondary" href="/">
            Back to site
          </Link>
        </div>
      </header>

      <section className="lecturer-hero">
        <span className="landing-pill">
          <span /> Lecturer workspace
        </span>
        <h1>Welcome back{identity ? `, ${displayNameOf(identity).split(" ")[0]}` : ""}.</h1>
        <p>
          An overview of the courses you teach, the study groups forming around them, and how
          students are taking part — all scoped to your own assignments.
        </p>
      </section>

      {loading && (
        <section className="admin-card lecturer-card" aria-busy="true">
          <div className="admin-card-pad">
            <div className="admin-skeleton">
              {Array.from({ length: 5 }).map((_, index) => (
                <span key={index} className="admin-skeleton-line" style={{ width: `${100 - index * 10}%` }} />
              ))}
            </div>
          </div>
        </section>
      )}

      {!loading && error && (
        <section className="admin-card lecturer-card">
          <div className="admin-card-pad">
            <div className="admin-error" role="alert">
              <p>{error}</p>
              <button type="button" className="admin-btn admin-btn-ghost" onClick={load}>
                Try again
              </button>
            </div>
          </div>
        </section>
      )}

      {!loading && !error && (
        <>
          {/* D. Participation overview */}
          <section className="lecturer-section" aria-label="Participation overview">
            <div className="admin-count-grid">
              <div className="admin-count-card">
                <span className="admin-count-label">Assigned courses</span>
                <strong className="admin-count-value">{participation.assignedCourses ?? 0}</strong>
              </div>
              <div className="admin-count-card">
                <span className="admin-count-label">Active study groups</span>
                <strong className="admin-count-value">{participation.activeGroups ?? 0}</strong>
              </div>
              <div className="admin-count-card">
                <span className="admin-count-label">Enrolled students</span>
                <strong className="admin-count-value">{participation.enrolledStudents ?? 0}</strong>
              </div>
              <div className="admin-count-card">
                <span className="admin-count-label">Group memberships</span>
                <strong className="admin-count-value">{participation.groupMembers ?? 0}</strong>
              </div>
            </div>
            <p className="lecturer-metric-note">
              {metricNotes.enrolledStudents ||
                "Enrolled students counts each student once across your courses."}{" "}
              {metricNotes.groupMembers || "Group memberships totals members across active groups."}
            </p>
          </section>

          {isEmpty && (
            <section className="admin-card lecturer-card">
              <div className="admin-card-pad">
                <div className="admin-empty">
                  <strong>No courses assigned yet</strong>
                  <p>
                    Once an administrator assigns you to a course, it and any study groups forming
                    around it will appear here.
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* B. Assigned courses */}
          {courses.length > 0 && (
            <section className="admin-card lecturer-card" aria-label="Assigned courses">
              <header className="admin-card-head">
                <div>
                  <h2>Assigned courses</h2>
                  <p>The courses you are teaching this term.</p>
                </div>
              </header>
              <div className="admin-card-body admin-card-body-flush">
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Course</th>
                        <th>Department</th>
                        <th>Credit hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {courses.map((course) => (
                        <tr key={course.id}>
                          <td>
                            <code className="admin-code">{course.course_code}</code>
                          </td>
                          <td>
                            <strong>{course.name}</strong>
                            {course.university_name && (
                              <small className="admin-muted">{course.university_name}</small>
                            )}
                          </td>
                          <td className="admin-muted">{course.department_name || "—"}</td>
                          <td className="admin-muted">{course.credit_hours ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {/* C. Study groups */}
          {groups.length > 0 && (
            <section className="admin-card lecturer-card" aria-label="Study groups">
              <header className="admin-card-head">
                <div>
                  <h2>Study groups</h2>
                  <p>Active groups forming around your courses.</p>
                </div>
              </header>
              <div className="admin-card-body admin-card-body-flush">
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th>Course</th>
                        <th>Privacy</th>
                        <th>Members</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((group) => (
                        <tr key={group.id}>
                          <td>
                            <strong>{group.name}</strong>
                          </td>
                          <td>
                            <code className="admin-code">{group.course_code}</code>
                          </td>
                          <td className="admin-muted">{PRIVACY_LABELS[group.privacy] || group.privacy}</td>
                          <td className="admin-muted">
                            {group.member_count}
                            {group.max_size ? `/${group.max_size}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
