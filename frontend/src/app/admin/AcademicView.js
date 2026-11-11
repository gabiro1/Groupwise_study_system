"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, useDebouncedValue } from "./adminApi";
import PageHeading from "./PageHeading";
import AdminModal from "./AdminModal";
import { PlusIcon } from "./AdminIcons";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const COUNT_CARDS = [
  { key: "universities", label: "Universities" },
  { key: "faculties", label: "Faculties" },
  { key: "programs", label: "Programs" },
  { key: "courses", label: "Courses" },
];

const EMPTY_COURSE = {
  courseCode: "",
  name: "",
  departmentId: "",
  description: "",
  creditHours: "",
  level: "",
};

function flattenDepartments(tree) {
  return (tree?.universities || []).flatMap((university) => (
    (university.faculties || []).flatMap((faculty) => (
      (faculty.departments || []).map((department) => ({
        id: department.id,
        label: `${university.name} / ${faculty.name} / ${department.name}`,
      }))
    ))
  ));
}

export default function AcademicView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [createCourseOpen, setCreateCourseOpen] = useState(false);
  const [courseForm, setCourseForm] = useState(EMPTY_COURSE);
  const [courseSaving, setCourseSaving] = useState(false);
  const [courseError, setCourseError] = useState("");
  const [departmentOptions, setDepartmentOptions] = useState([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [departmentsLoaded, setDepartmentsLoaded] = useState(false);

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

  async function reload() {
    setLoading(true);
    await load(debouncedQuery);
  }

  async function openCreateCourse() {
    setCreateCourseOpen(true);
    setCourseError("");
    if (departmentsLoaded || departmentsLoading) return;

    setDepartmentsLoading(true);
    try {
      const result = await apiRequest("academic/tree");
      setDepartmentOptions(flattenDepartments(result));
      setDepartmentsLoaded(true);
    } catch (requestError) {
      setCourseError(requestError.message);
    } finally {
      setDepartmentsLoading(false);
    }
  }

  async function createCourse(event) {
    event.preventDefault();
    setCourseSaving(true);
    setCourseError("");
    setError("");
    try {
      const result = await apiRequest("admin/academic/courses", {
        method: "POST",
        body: JSON.stringify({
          courseCode: courseForm.courseCode.trim(),
          name: courseForm.name.trim(),
          departmentId: courseForm.departmentId || null,
          description: courseForm.description.trim(),
          creditHours: courseForm.creditHours === "" ? null : Number(courseForm.creditHours),
          level: courseForm.level === "" ? null : Number(courseForm.level),
        }),
      });
      setMessage(`${result.course.course_code} was added to the course catalogue.`);
      setCourseForm(EMPTY_COURSE);
      setCreateCourseOpen(false);
      await reload();
    } catch (requestError) {
      setCourseError(requestError.message);
    } finally {
      setCourseSaving(false);
    }
  }

  const counts = data?.counts;

  return (
    <>
      <PageHeading
        title="Academic data"
        subtitle="Universities, faculties, programs, and the course catalogue."
        onRefresh={reload}
        refreshing={loading}
        actions={(
          <button className="admin-btn admin-btn-primary" type="button" onClick={openCreateCourse}>
            <PlusIcon size={15} />
            New course
          </button>
        )}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

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

      <AdminModal
        open={createCourseOpen}
        title="Add new course"
        onClose={() => {
          if (!courseSaving) setCreateCourseOpen(false);
        }}
        footer={(
          <>
            <button className="admin-btn admin-btn-ghost" type="button" onClick={() => setCreateCourseOpen(false)} disabled={courseSaving}>
              Cancel
            </button>
            <button className="admin-btn admin-btn-primary" type="submit" form="admin-create-course-form" disabled={courseSaving || departmentsLoading}>
              {courseSaving ? "Adding…" : "Add course"}
            </button>
          </>
        )}
      >
        {courseError && <div className="admin-banner admin-banner-error" role="alert">{courseError}</div>}
        {departmentsLoading ? (
          <Skeleton rows={4} />
        ) : (
          <form id="admin-create-course-form" className="admin-field-grid" onSubmit={createCourse}>
            <label className="admin-field">
              <span>Course code</span>
              <input required maxLength={20} value={courseForm.courseCode} onChange={(event) => setCourseForm((current) => ({ ...current, courseCode: event.target.value }))} placeholder="e.g. SCS2103" />
            </label>
            <label className="admin-field">
              <span>Course name</span>
              <input required maxLength={160} value={courseForm.name} onChange={(event) => setCourseForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Database Systems" />
            </label>
            <label className="admin-field admin-field-wide">
              <span>Department</span>
              <select value={courseForm.departmentId} onChange={(event) => setCourseForm((current) => ({ ...current, departmentId: event.target.value }))}>
                <option value="">No department</option>
                {departmentOptions.map((department) => <option key={department.id} value={department.id}>{department.label}</option>)}
              </select>
            </label>
            <label className="admin-field">
              <span>Credit hours</span>
              <input type="number" min="1" max="12" value={courseForm.creditHours} onChange={(event) => setCourseForm((current) => ({ ...current, creditHours: event.target.value }))} placeholder="e.g. 3" />
            </label>
            <label className="admin-field">
              <span>Level</span>
              <input type="number" min="100" max="900" value={courseForm.level} onChange={(event) => setCourseForm((current) => ({ ...current, level: event.target.value }))} placeholder="e.g. 200" />
            </label>
            <label className="admin-field admin-field-wide">
              <span>Description</span>
              <textarea rows={3} maxLength={2000} value={courseForm.description} onChange={(event) => setCourseForm((current) => ({ ...current, description: event.target.value }))} placeholder="Briefly describe what this course covers." />
            </label>
          </form>
        )}
      </AdminModal>
    </>
  );
}
