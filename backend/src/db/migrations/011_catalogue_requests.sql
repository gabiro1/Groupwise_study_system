-- =============================================================================
-- Catalogue requests
--
-- Students can ask for a course, skill, or topic that the academic catalogue
-- does not yet contain. The catalogue itself stays admin-owned: approvals are
-- the only path that writes to `courses`, `skills`, or `course_topics`.
--
-- A request records *what* was asked ("Linear Algebra II") and the admin can
-- complete the structured fields a create needs (course code, department, …)
-- at approval time, so the student never has to know them.
-- =============================================================================

CREATE TYPE catalogue_request_kind AS ENUM ('COURSE', 'SKILL', 'TOPIC');

CREATE TYPE catalogue_request_status AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

CREATE TABLE catalogue_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES users(id),
  kind         catalogue_request_kind NOT NULL,
  title        TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  note         TEXT CHECK (note IS NULL OR char_length(note) <= 600),
  -- Required for TOPIC requests so the admin knows which syllabus to extend.
  course_id    uuid REFERENCES courses(id),
  status       catalogue_request_status NOT NULL DEFAULT 'PENDING',
  admin_note   TEXT CHECK (admin_note IS NULL OR char_length(admin_note) <= 600),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT catalogue_requests_topic_course CHECK (
    kind <> 'TOPIC' OR course_id IS NOT NULL
  )
);

CREATE INDEX catalogue_requests_status_idx   ON catalogue_requests (status, created_at DESC);
CREATE INDEX catalogue_requests_requester_idx ON catalogue_requests (requested_by, created_at DESC);