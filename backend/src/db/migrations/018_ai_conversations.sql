-- =============================================================================
-- Lien — 018_ai_conversations.sql
-- AI assistant conversation history
--
-- The assistant never decides anything, but the exchanges it has with a student
-- are still worth keeping: a student can scroll back through a thread, and an
-- admin can audit exactly what the assistant answered and from which sources.
-- Storage is therefore scoped like everything else — a conversation belongs to
-- one student and, optionally, one study group — and every read path re-derives
-- visibility from that ownership (plus group membership) rather than from a
-- column the caller could forge.
--
-- Conventions follow the existing schema:
--   * UUIDv7 ids via gen_uuid(), timestamptz everywhere.
--   * Native enums so invalid states are unrepresentable; transitions
--     (ACTIVE -> ARCHIVED -> DELETED) are enforced in the service layer.
--   * touch_updated_at() keeps updated_at honest so "recent threads" ordering
--     does not drift from the last message.
-- =============================================================================

-- A conversation's purpose. STUDY is a general revision thread; GROUP is shared
-- with a study group's material; SINGLE is a one-off private question; QUIZ is
-- a drill/practice exchange.
CREATE TYPE ai_conversation_kind AS ENUM ('STUDY', 'GROUP', 'SINGLE', 'QUIZ');

-- Lifecycle. DELETED is a soft delete: the row survives for audit but every read
-- path filters it out, so a deleted thread is indistinguishable from one that
-- never existed.
CREATE TYPE ai_conversation_status AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- Who wrote a message. SYSTEM is deliberately absent: system prompts are built
-- per request and never persisted, so history holds only real turns.
CREATE TYPE ai_message_role AS ENUM ('USER', 'ASSISTANT');

-- A participant's standing in a conversation.
CREATE TYPE ai_participant_role AS ENUM ('OWNER', 'MEMBER');

CREATE TABLE ai_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id   uuid REFERENCES study_groups(id) ON DELETE CASCADE,
  title      TEXT CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 160),
  kind       ai_conversation_kind NOT NULL DEFAULT 'STUDY',
  status     ai_conversation_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER ai_conversations_touch BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX ai_conversations_student_idx ON ai_conversations (student_id, updated_at DESC) WHERE status <> 'DELETED';
CREATE INDEX ai_conversations_group_idx   ON ai_conversations (group_id, updated_at DESC) WHERE status <> 'DELETED';

-- Who can see a conversation. A row per participant mirrors the direct-message
-- membership model; the creator is inserted as OWNER by the service in the same
-- transaction as the conversation itself, so a thread is never participant-less.
CREATE TABLE ai_conversation_participants (
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            ai_participant_role NOT NULL DEFAULT 'OWNER',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, student_id)
);

CREATE INDEX ai_conversation_participants_student_idx
  ON ai_conversation_participants (student_id);

CREATE TABLE ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            ai_message_role NOT NULL,
  content         TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- Cursor pagination on (created_at, id), matching the workspace and direct
-- message tables, so deep history stays cheap.
CREATE INDEX ai_messages_conversation_cursor_idx
  ON ai_messages (conversation_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
