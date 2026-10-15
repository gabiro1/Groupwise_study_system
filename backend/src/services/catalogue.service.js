import { queryOne, queryRows, withTransaction } from "../config/db.js";
import { NotFoundError, AppError, ConflictError } from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";

/**
 * Catalogue requests.
 *
 * Students may ask for a course, skill, or topic that the academic catalogue
 * does not contain. Students can only *ask* — writing to `courses`, `skills`
 * and `course_topics` happens exclusively here, in the admin approval path, so
 * the catalogue never grows from unmoderated student input.
 */

/** Cap on open requests per student, so the admin queue cannot be flooded. */
const MAX_PENDING = 10;

function mapRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    note: row.note,
    courseId: row.course_id,
    status: row.status,
    adminNote: row.admin_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function createRequest(studentId, input, { req } = {}) {
  if (input.courseId) {
    const course = await queryOne("SELECT id FROM courses WHERE id = $1", [input.courseId], "catalogue:course");
    if (!course) throw new AppError("That course no longer exists.", { status: 422, code: "INVALID_COURSE" });
  }

  const pending = await queryOne(
    "SELECT count(*)::int AS n FROM catalogue_requests WHERE requested_by = $1 AND status = 'PENDING'",
    [studentId],
    "catalogue:pendingCount",
  );
  if (pending.n >= MAX_PENDING) {
    throw new AppError("You already have several requests being reviewed — check back before adding more.", {
      status: 429,
      code: "TOO_MANY_REQUESTS",
    });
  }

  const row = await queryOne(
    `INSERT INTO catalogue_requests (requested_by, kind, title, note, course_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kind, title, note, course_id, status, admin_note, created_at`,
    [studentId, input.kind, input.title.trim(), input.note ?? null, input.courseId ?? null],
    "catalogue:create",
  );

  await recordAudit({
    actor: { id: studentId, role: "STUDENT" },
    req,
    action: AUDIT.CATALOGUE_REQUEST_CREATED,
    entityType: "CATALOGUE_REQUEST",
    entityId: row.id,
    metadata: { kind: row.kind, title: row.title },
  });

  return { request: mapRow({ ...row, resolved_at: null }) };
}

export async function listMyRequests(studentId) {
  const rows = await queryRows(
    `SELECT id, kind, title, note, course_id, status, admin_note, created_at, resolved_at
       FROM catalogue_requests
      WHERE requested_by = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [studentId],
    "catalogue:my",
  );
  return rows.map(mapRow);
}

/** Admin queue, newest first. Optionally narrowed to one status. */
export async function listAdminRequests({ status } = {}) {
  const rows = await queryRows(
    `SELECT r.id, r.kind, r.title, r.note, r.course_id, r.status, r.admin_note,
            r.created_at, r.resolved_at,
            u.first_name, u.last_name, u.email,
            c.course_code, c.name AS course_name
       FROM catalogue_requests r
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN courses c ON c.id = r.course_id
      WHERE ($1::catalogue_request_status IS NULL OR r.status = $1)
      ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC
      LIMIT 200`,
    [status ?? null],
    "catalogue:admin",
  );

  return rows.map((row) => ({
    ...mapRow(row),
    course: row.course_id ? { id: row.course_id, courseCode: row.course_code, name: row.course_name } : null,
    requestor: { firstName: row.first_name, lastName: row.last_name, email: row.email },
  }));
}

/**
 * Approve a request: create the catalogue entity, then mark the request
 * resolved. Both writes and the audit row share one transaction.
 */
export async function approveRequest(adminId, catalogueRequestId, input, { req } = {}) {
  const request = await queryOne(
    "SELECT * FROM catalogue_requests WHERE id = $1",
    [catalogueRequestId],
    "catalogue:load",
  );
  if (!request) throw new NotFoundError("That catalogue request");
  if (request.status !== "PENDING") {
    throw new AppError("That request has already been reviewed.", { status: 409, code: "ALREADY_RESOLVED" });
  }

  let entity;
  await withTransaction(async (tx) => {
    if (request.kind === "SKILL") {
      const name = (input.skill?.name ?? request.title).trim();
      try {
        entity = await tx.queryOne(
          `INSERT INTO skills (name, category) VALUES ($1, $2)
           RETURNING id, name, category`,
          [name, input.skill?.category ?? "GENERAL"],
          "catalogue:skill",
        );
      } catch (error) {
        if (error.code === "DUPLICATE") {
          throw new ConflictError("A skill with that name already exists.", { code: "DUPLICATE", fields: { name: "That skill is already in the catalogue." } });
        }
        throw error;
      }
    } else if (request.kind === "TOPIC") {
      const courseId = input.topic?.courseId ?? request.course_id;
      const name = (input.topic?.name ?? request.title).trim();
      const position = await tx.queryOne(
        "SELECT COALESCE(max(position), 0) + 1 AS next_position FROM course_topics WHERE course_id = $1",
        [courseId],
        "catalogue:nextPosition",
      );
      entity = await tx.queryOne(
        `INSERT INTO course_topics (course_id, name, description, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id, course_id, name, position`,
        [courseId, name, input.topic?.description ?? "", position.next_position],
        "catalogue:topic",
      );
    } else {
      const courseCode = (input.course?.courseCode ?? "").trim();
      const name = (input.course?.name ?? request.title).trim();
      if (!courseCode) {
        throw new AppError("A course request needs its code (e.g. SCS2103).", {
          status: 422,
          code: "COURSE_CODE_REQUIRED",
          fields: { courseCode: "Enter the course code." },
        });
      }
      try {
        entity = await tx.queryOne(
          `INSERT INTO courses (course_code, name, department_id, description, credit_hours, level)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, course_code, name, department_id, level`,
          [courseCode, name, input.course?.departmentId ?? null, input.course?.description ?? "", input.course?.creditHours ?? null, input.course?.level ?? null],
          "catalogue:course",
        );
      } catch (error) {
        if (error.code === "DUPLICATE") {
          throw new ConflictError("A course with that code already exists.", { code: "DUPLICATE", fields: { courseCode: "That course code is already in use." } });
        }
        throw error;
      }
    }

    await tx.query(
      `UPDATE catalogue_requests
          SET status = 'APPROVED', admin_note = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1`,
      [catalogueRequestId, input.adminNote ?? null, adminId],
      "catalogue:approve",
    );

    await recordAudit({
      actor: { id: adminId, role: "ADMIN" },
      req,
      tx,
      action: AUDIT.CATALOGUE_REQUEST_APPROVED,
      entityType: "CATALOGUE_REQUEST",
      entityId: catalogueRequestId,
      metadata: { kind: request.kind, title: request.title, entityId: entity.id },
    });
  }, "catalogue:approveTx");

  return { approved: true, entity };
}

export async function declineRequest(adminId, catalogueRequestId, { adminNote }, { req } = {}) {
  const request = await queryOne(
    "SELECT id, kind, title, status FROM catalogue_requests WHERE id = $1",
    [catalogueRequestId],
    "catalogue:load",
  );
  if (!request) throw new NotFoundError("That catalogue request");
  if (request.status !== "PENDING") {
    throw new AppError("That request has already been reviewed.", { status: 409, code: "ALREADY_RESOLVED" });
  }

  const row = await queryOne(
    `UPDATE catalogue_requests
        SET status = 'DECLINED', admin_note = $2, resolved_by = $3, resolved_at = now()
      WHERE id = $1
      RETURNING id, status, admin_note, resolved_at`,
    [catalogueRequestId, adminNote, adminId],
    "catalogue:decline",
  );

  await recordAudit({
    actor: { id: adminId, role: "ADMIN" },
    req,
    action: AUDIT.CATALOGUE_REQUEST_DECLINED,
    entityType: "CATALOGUE_REQUEST",
    entityId: catalogueRequestId,
    metadata: { kind: request.kind, title: request.title },
  });

  return { declined: true, request: mapRow({ ...row, kind: request.kind, title: request.title }) };
}

export default { createRequest, listMyRequests, listAdminRequests, approveRequest, declineRequest };