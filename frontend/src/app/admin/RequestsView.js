"use client";

import { useEffect, useState } from "react";
import { apiRequest, formatDateTime, useDebouncedValue } from "./adminApi";
import PageHeading from "./PageHeading";
import { EmptyState, ErrorState, Skeleton } from "./DataState";
import AdminModal from "./AdminModal";

const KIND_LABELS = { SKILL: "Skill", TOPIC: "Topic", COURSE: "Course" };
const STATUS_LABELS = { PENDING: "Pending", APPROVED: "Approved", DECLINED: "Declined" };

function flattenDepartments(tree) {
  const departments = [];
  for (const university of tree.universities || []) {
    for (const faculty of university.faculties || []) {
      for (const department of faculty.departments || []) {
        departments.push({ id: department.id, name: `${department.name} — ${university.code}` });
      }
    }
  }
  return departments.sort((a, b) => a.name.localeCompare(b.name));
}

export default function RequestsView() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("PENDING");
  const [busy, setBusy] = useState(false);

  const [approveTarget, setApproveTarget] = useState(null);
  const [form, setForm] = useState({});
  const [formError, setFormError] = useState("");
  const [departments, setDepartments] = useState([]);

  const [courseTerm, setCourseTerm] = useState("");
  const [courseResults, setCourseResults] = useState([]);
  const [courseSearching, setCourseSearching] = useState(false);
  const debouncedCourseTerm = useDebouncedValue(courseTerm, 300);

  const [declineTarget, setDeclineTarget] = useState(null);
  const [declineNote, setDeclineNote] = useState("");
  const [declineError, setDeclineError] = useState("");

  async function load(activeStatus = status) {
    try {
      const params = new URLSearchParams();
      if (activeStatus) params.set("status", activeStatus);
      const result = await apiRequest(`admin/catalogue-requests?${params.toString()}`);
      setRequests(result.requests || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function reload() {
    setLoading(true);
    return load();
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        const result = await apiRequest(`admin/catalogue-requests?${params.toString()}`);
        if (active) {
          setRequests(result.requests || []);
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
  }, [status]);

  useEffect(() => {
    if (approveTarget?.kind !== "TOPIC") return undefined;
    const term = debouncedCourseTerm.trim();
    if (!term) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => setCourseSearching(true))
      .then(() => apiRequest(`academic/courses?q=${encodeURIComponent(term)}&limit=8`))
      .then((result) => {
        if (active) setCourseResults(result.courses || []);
      })
      .catch(() => {
        if (active) setCourseResults([]);
      })
      .finally(() => {
        if (active) setCourseSearching(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedCourseTerm, approveTarget?.kind]);

  useEffect(() => {
    if (approveTarget?.kind !== "COURSE") return undefined;
    let active = true;
    (async () => {
      try {
        const tree = await apiRequest("academic/tree");
        if (active) setDepartments(flattenDepartments(tree));
      } catch {
        if (active) setDepartments([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [approveTarget?.kind]);

  function openApprove(request) {
    setApproveTarget(request);
    setForm({});
    setFormError("");
    setCourseTerm("");
    setCourseResults([]);
  }

  function openDecline(request) {
    setDeclineTarget(request);
    setDeclineNote("");
    setDeclineError("");
  }

  function buildApprovePayload(target, values) {
    if (target.kind === "SKILL") {
      return {
        skill: {
          name: (values.name || "").trim() || target.title,
          category: (values.category || "").trim() || "GENERAL",
        },
      };
    }
    if (target.kind === "TOPIC") {
      return {
        topic: {
          courseId: values.courseId,
          name: (values.name || "").trim() || target.title,
          description: (values.description || "").trim() || null,
        },
      };
    }
    return {
      course: {
        courseCode: (values.courseCode || "").trim(),
        name: (values.name || "").trim() || target.title,
        departmentId: values.departmentId || null,
        description: (values.description || "").trim() || null,
        creditHours: values.creditHours ? Number(values.creditHours) : null,
        level: values.level ? Number(values.level) : null,
      },
    };
  }

  async function submitApprove() {
    const values = form;
    if (approveTarget.kind === "TOPIC" && !values.courseId) {
      setFormError("Pick the course this topic belongs to.");
      return;
    }
    if (approveTarget.kind === "COURSE" && !(values.courseCode || "").trim()) {
      setFormError("Enter the course code.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const payload = buildApprovePayload(approveTarget, values);
      await apiRequest(`admin/catalogue-requests/${approveTarget.id}/approve`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const kind = KIND_LABELS[approveTarget.kind].toLowerCase();
      setMessage(`Approved — the ${kind} is now in the catalogue.`);
      setApproveTarget(null);
      setForm({});
      await load();
    } catch (requestError) {
      setFormError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDecline() {
    if (!declineNote.trim()) {
      setDeclineError("Tell the student why, so they can rephrase and resubmit.");
      return;
    }
    setBusy(true);
    setDeclineError("");
    try {
      await apiRequest(`admin/catalogue-requests/${declineTarget.id}/decline`, {
        method: "POST",
        body: JSON.stringify({ adminNote: declineNote.trim() }),
      });
      setMessage("Request declined.");
      setDeclineTarget(null);
      setDeclineNote("");
      await load();
    } catch (requestError) {
      setDeclineError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const approveModalTitle = approveTarget
    ? `Approve ${KIND_LABELS[approveTarget.kind].toLowerCase()} request`
    : "";

  return (
    <>
      <PageHeading
        title="Catalogue requests"
        subtitle="Students ask for missing courses, skills, and topics. Approving adds the entity to the catalogue."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <div className="admin-toolbar">
          <select aria-label="Filter requests by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="DECLINED">Declined</option>
          </select>
        </div>

        <div className="admin-card-body">
          {loading ? (
            <Skeleton rows={5} />
          ) : requests.length === 0 ? (
            <EmptyState
              title={status === "PENDING" ? "The queue is clear" : "Nothing here yet"}
              message={status === "PENDING" ? "New student requests will appear here." : "No requests match this filter."}
            />
          ) : (
            <div className="admin-report-list">
              {requests.map((request) => (
                <article className="admin-report-card" key={request.id}>
                  <div className="admin-report-top">
                    <span className={`admin-badge admin-badge-${request.status.toLowerCase()}`}>
                      {STATUS_LABELS[request.status]}
                    </span>
                    <span className="admin-badge admin-badge-muted">{KIND_LABELS[request.kind]}</span>
                    {request.course && (
                      <span className="admin-badge admin-badge-muted">
                        {request.course.courseCode} · {request.course.name}
                      </span>
                    )}
                    <span className="admin-report-meta">
                      Requested {formatDateTime(request.createdAt)}
                      {" · "}{[request.requestor.firstName, request.requestor.lastName].filter(Boolean).join(" ") || request.requestor.email}
                    </span>
                  </div>

                  <h3 className="admin-request-title">{request.title}</h3>
                  {request.note && <p className="admin-report-details">{request.note}</p>}

                  {request.status === "PENDING" ? (
                    <div className="admin-report-actions">
                      <button
                        className="admin-btn admin-btn-primary"
                        type="button"
                        disabled={busy}
                        onClick={() => openApprove(request)}
                      >
                        Approve
                      </button>
                      <button
                        className="admin-btn admin-btn-danger"
                        type="button"
                        disabled={busy}
                        onClick={() => openDecline(request)}
                      >
                        Decline
                      </button>
                    </div>
                  ) : (
                    <p className="admin-report-resolution">
                      {request.adminNote
                        ? <><strong>{STATUS_LABELS[request.status]}:</strong> {request.adminNote}</>
                        : `Closed as ${STATUS_LABELS[request.status].toLowerCase()}.`}
                      {request.resolvedAt && <span className="admin-muted"> · {formatDateTime(request.resolvedAt)}</span>}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <AdminModal
        open={Boolean(approveTarget)}
        title={approveModalTitle}
        onClose={() => setApproveTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" disabled={busy} onClick={() => setApproveTarget(null)}>
              Cancel
            </button>
            <button className="admin-btn admin-btn-primary" type="button" disabled={busy} onClick={submitApprove}>
              {busy ? "…" : "Approve & add to catalogue"}
            </button>
          </>
        }
      >
        {approveTarget?.kind === "SKILL" && (
          <>
            <label className="admin-field">
              <span>Skill name</span>
              <input
                value={form.name ?? approveTarget.title}
                maxLength={120}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="admin-field">
              <span>Category</span>
              <input
                value={form.category ?? ""}
                placeholder="e.g. DATA"
                maxLength={60}
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
              />
            </label>
          </>
        )}

        {approveTarget?.kind === "TOPIC" && (
          <>
            <label className="admin-field">
              <span>Course</span>
              <input
                value={courseTerm}
                placeholder="Search courses by name or code…"
                onChange={(event) => setCourseTerm(event.target.value)}
              />
              {courseSearching && <small className="admin-muted">Searching…</small>}
              {!courseSearching && courseResults.length > 0 && (
                <div className="admin-select-list">
                  {courseResults.map((course) => (
                    <button
                      type="button"
                      key={course.id}
                      className={`admin-select-option ${form.courseId === course.id ? "selected" : ""}`}
                      onClick={() => setForm((current) => ({ ...current, courseId: course.id }))}
                    >
                      <strong>{course.course_code}</strong> {course.name}
                    </button>
                  ))}
                </div>
              )}
              {form.courseId && <small className="admin-muted">Selected course locked in.</small>}
            </label>
            <label className="admin-field">
              <span>Topic name</span>
              <input
                value={form.name ?? approveTarget.title}
                maxLength={200}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="admin-field">
              <span>Description (optional)</span>
              <textarea
                value={form.description ?? ""}
                rows={3}
                maxLength={1000}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              />
            </label>
          </>
        )}

        {approveTarget?.kind === "COURSE" && (
          <>
            <label className="admin-field">
              <span>Course code</span>
              <input
                value={form.courseCode ?? ""}
                placeholder="e.g. SCS2103"
                maxLength={20}
                onChange={(event) => setForm((current) => ({ ...current, courseCode: event.target.value }))}
              />
            </label>
            <label className="admin-field">
              <span>Course name</span>
              <input
                value={form.name ?? approveTarget.title}
                maxLength={200}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="admin-field">
              <span>Department</span>
              <select
                value={form.departmentId ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, departmentId: event.target.value || null }))}
              >
                <option value="">Not assigned</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <div className="admin-field-grid">
              <label className="admin-field">
                <span>Credit hours</span>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={form.creditHours ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, creditHours: event.target.value }))}
                />
              </label>
              <label className="admin-field">
                <span>Level</span>
                <input
                  type="number"
                  min="1"
                  max="8"
                  value={form.level ?? ""}
                  onChange={(event) => setForm((current) => ({ ...current, level: event.target.value }))}
                />
              </label>
            </div>
            <label className="admin-field">
              <span>Description (optional)</span>
              <textarea
                value={form.description ?? ""}
                rows={3}
                maxLength={2000}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              />
            </label>
          </>
        )}

        {formError && <div className="admin-banner admin-banner-error" role="alert">{formError}</div>}
      </AdminModal>

      <AdminModal
        open={Boolean(declineTarget)}
        title={declineTarget ? `Decline ${KIND_LABELS[declineTarget.kind].toLowerCase()} request` : ""}
        onClose={() => setDeclineTarget(null)}
        footer={
          <>
            <button className="admin-btn admin-btn-ghost" type="button" disabled={busy} onClick={() => setDeclineTarget(null)}>
              Cancel
            </button>
            <button className="admin-btn admin-btn-danger" type="button" disabled={busy} onClick={submitDecline}>
              {busy ? "…" : "Decline request"}
            </button>
          </>
        }
      >
        <p><strong>“{declineTarget?.title}”</strong></p>
        <label className="admin-field">
          <span>Reason for the student</span>
          <textarea
            value={declineNote}
            rows={3}
            maxLength={600}
            autoFocus
            onChange={(event) => setDeclineNote(event.target.value)}
          />
        </label>
        {declineError && <div className="admin-banner admin-banner-error" role="alert">{declineError}</div>}
      </AdminModal>
    </>
  );
}