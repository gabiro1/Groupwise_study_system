"use client";

import { useEffect, useState } from "react";
import { apiRequest, formatDateTime, labelFor } from "./adminApi";
import PageHeading from "./PageHeading";
import { EmptyState, ErrorState, Skeleton } from "./DataState";

const REPORT_ACTIONS = [
  { value: "NONE", label: "No action" },
  { value: "WARN_USER", label: "Warn user" },
  { value: "SUSPEND_USER", label: "Suspend user" },
  { value: "REMOVE_CONTENT", label: "Remove content" },
  { value: "REMOVE_GROUP", label: "Remove group" },
];

function defaultAction(report) {
  if (report.target_type === "STUDENT") return "WARN_USER";
  if (report.target_type === "GROUP") return "REMOVE_GROUP";
  return "REMOVE_CONTENT";
}

export default function ReportsView() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [targetType, setTargetType] = useState("");
  const [busyReport, setBusyReport] = useState("");
  const [actions, setActions] = useState({});
  const [resolutions, setResolutions] = useState({});

  async function load() {
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (status) params.set("status", status);
      if (targetType) params.set("targetType", targetType);
      const result = await apiRequest(`admin/reports?${params.toString()}`);
      setReports(result.reports || []);
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
        const result = await apiRequest("admin/reports?limit=25");
        if (active) {
          setReports(result.reports || []);
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
  }, []);

  async function resolve(report, nextStatus) {
    const action = actions[report.id] || defaultAction(report);
    setBusyReport(report.id);
    setError("");
    try {
      await apiRequest("admin/reports/resolve", {
        method: "POST",
        body: JSON.stringify({
          reportId: report.id,
          status: nextStatus,
          action,
          resolution: (resolutions[report.id] || "").trim() || null,
        }),
      });
      setMessage(`Report marked ${nextStatus.toLowerCase()}.`);
      await reload();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyReport("");
    }
  }

  return (
    <>
      <PageHeading
        title="Reports & moderation"
        subtitle="Review reports and take action on the target."
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <div className="admin-banner admin-banner-error" role="alert">{error}</div>}
      {message && <div className="admin-banner admin-banner-success" role="status">{message}</div>}

      <section className="admin-card">
        <div className="admin-toolbar">
          <select aria-label="Filter reports by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Open &amp; in review</option>
            <option value="OPEN">Open</option>
            <option value="IN_REVIEW">In review</option>
            <option value="RESOLVED">Resolved</option>
            <option value="DISMISSED">Dismissed</option>
          </select>
          <select aria-label="Filter reports by target type" value={targetType} onChange={(event) => setTargetType(event.target.value)}>
            <option value="">All targets</option>
            <option value="STUDENT">Student</option>
            <option value="GROUP">Group</option>
            <option value="MESSAGE">Message</option>
            <option value="RESOURCE">Resource</option>
          </select>
          <button className="admin-btn admin-btn-primary" type="button" onClick={reload}>Apply filters</button>
        </div>

        <div className="admin-card-body">
          {loading ? (
            <Skeleton rows={5} />
          ) : reports.length === 0 ? (
            <EmptyState
              title="The moderation queue is clear"
              message="There are no reports matching this filter."
            />
          ) : (
            <div className="admin-report-list">
              {reports.map((report) => (
                <article className="admin-report-card" key={report.id}>
                  <div className="admin-report-top">
                    <span className={`admin-badge admin-badge-${report.status.toLowerCase()}`}>
                      {labelFor("reportStatus", report.status)}
                    </span>
                    <span className="admin-badge admin-badge-muted">{labelFor("targetType", report.target_type)}</span>
                    <span className="admin-badge admin-badge-muted">{labelFor("category", report.category)}</span>
                    <span className="admin-report-meta">
                      Reported {formatDateTime(report.created_at)}
                      {(report.reporter_first_name || report.reporter_last_name) &&
                        ` · by ${[report.reporter_first_name, report.reporter_last_name].filter(Boolean).join(" ")}`}
                    </span>
                  </div>

                  <p className="admin-report-details">{report.details || "No details provided."}</p>

                  {report.status === "OPEN" || report.status === "IN_REVIEW" ? (
                    <div className="admin-report-actions">
                      <select
                        aria-label="Action for report"
                        value={actions[report.id] || defaultAction(report)}
                        onChange={(event) => setActions((current) => ({ ...current, [report.id]: event.target.value }))}
                      >
                        {REPORT_ACTIONS.map((option) => (
                          <option value={option.value} key={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <input
                        aria-label="Resolution note"
                        placeholder="Resolution note (recorded in the audit trail)"
                        maxLength={1000}
                        value={resolutions[report.id] || ""}
                        onChange={(event) => setResolutions((current) => ({ ...current, [report.id]: event.target.value }))}
                      />
                      <button
                        className="admin-btn admin-btn-primary"
                        type="button"
                        disabled={busyReport === report.id}
                        onClick={() => resolve(report, "RESOLVED")}
                      >
                        {busyReport === report.id ? "…" : "Resolve"}
                      </button>
                      <button
                        className="admin-btn admin-btn-ghost"
                        type="button"
                        disabled={busyReport === report.id}
                        onClick={() => resolve(report, "DISMISSED")}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <p className="admin-report-resolution">
                      {report.resolution ? <><strong>Resolution:</strong> {report.resolution}</> : "Closed."}
                      {report.handled_at && <span className="admin-muted"> · {formatDateTime(report.handled_at)}</span>}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
