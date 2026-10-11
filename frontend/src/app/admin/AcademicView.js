"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, useDebouncedValue } from "./adminApi";
import PageHeading from "./PageHeading";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const COUNT_CARDS = [
  { key: "universities", label: "Universities" },
  { key: "faculties", label: "Faculties" },
  { key: "departments", label: "Departments" },
  { key: "programs", label: "Programs" },
  { key: "courses", label: "Courses" },
  { key: "active_courses", label: "Active courses" },
  { key: "skills", label: "Skills" },
  { key: "topics", label: "Course topics" },
];

export default function AcademicView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);

  const load = useCallback(async (term) => {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (term && term.trim()) params.set("q", term.trim());
      const result = await apiRequest(`admin/academic?${params.toString()}`);
      setData(result);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        const term = debouncedQuery.trim();
        if (term) params.set("q", term);
        const result = await apiRequest(`admin/academic?${params.toString()}`);
        if (active) {
          setData(result);
          setError("");
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [debouncedQuery]);

  function reload() {
    setLoading(true);
    load(debouncedQuery);
  }

  const counts = data?.counts;

  return (
    <>
      <PageHeading
        title="Academic data"
        subtitle="Universities, faculties, programs, and the course catalogue."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}

      <div className="admin-count-grid">
        {COUNT_CARDS.map((card) => (
          <div className="admin-count-card" key={card.key}>
            <span className="admin-count-label">{card.label}</span>
            {loading && !counts ? (
              <span className="admin-metric-value admin-metric-skeleton" aria-hidden="true" />
            ) : (
              <strong className="admin-count-value">{counts?.[card.key] ?? "—"}</strong>
            )}
          </div>
        ))}
      </div>

      <section className="admin-card">
        <header className="admin-card-head">
          <div>
            <h2>Course register</h2>
            <p>Every course with enrolment and group counts.</p>
          </div>
          <label className="admin-search-inline">
            <span className="admin-sr-only">Search courses</span>
            <input
              type="search"
              placeholder="Search courses…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLoading(true);
              }}
            />
          </label>
        </header>

        <div className="admin-card-body admin-card-body-flush">
          {loading && !data ? (
            <div className="admin-card-pad"><Skeleton rows={6} /></div>
          ) : error ? (
            <div className="admin-card-pad"><ErrorState message={error} onRetry={reload} /></div>
          ) : (data?.courses || []).length === 0 ? (
            <div className="admin-card-pad">
              <EmptyState title="No courses found" message="No courses match that search." />
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Course</th>
                    <th>Department</th>
                    <th>Level</th>
                    <th>Enrolled</th>
                    <th>Groups</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.courses.map((course) => (
                    <tr key={course.id}>
                      <td><code className="admin-code">{course.course_code}</code></td>
                      <td>
                        <strong>{course.name}</strong>
                        {course.university_name && <small className="admin-muted">{course.university_name}</small>}
                      </td>
                      <td className="admin-muted">{course.department_name || "—"}</td>
                      <td className="admin-muted">{course.level || "—"}</td>
                      <td>{course.enrolled_students}</td>
                      <td>{course.groups_count}</td>
                      <td>
                        <span className={`admin-badge ${course.is_active ? "admin-badge-active" : "admin-badge-muted"}`}>
                          {course.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
