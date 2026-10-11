-- =============================================================================
-- Study partners and direct messaging
--
-- Direct messaging is deliberately restricted to *accepted* study partners. A
-- student who has not accepted a connection cannot be messaged, which makes the
-- inbox count a meaningful signal ("people I chose to study with") rather than a
-- spam surface. The accept step is the authorization: when a connection becomes
-- ACCEPTED the pair is added to a two-member direct conversation, and every
-- message route re-derives participation from that membership table — never from
-- the request body.
--
-- Connections accumulate history (declined or revoked offers survive as rows) so
-- the UI and future moderation tooling can see what happened, while the partial
-- unique index keeps at most one open offer per ordered pair.
-- =============================================================================

-- New notification vocabulary. Postgres 12+ allows ADD VALUE inside the
-- migration's single transaction as long as the new values are not referenced
-- in the same transaction, which this file never does.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'PARTNER_INVITATION';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'PARTNER_ACCEPTED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'DIRECT_MESSAGE';

CREATE TYPE partner_connection_status AS ENUM (
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'REVOKED'
);

CREATE TABLE partner_connections (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       partner_connection_status NOT NULL DEFAULT 'PENDING',
  message      TEXT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_connections_not_self CHECK (requester_id <> recipient_id),
  CONSTRAINT partner_connections_message_length CHECK (
    message IS NULL OR length(btrim(message)) BETWEEN 1 AND 500
  )
);

-- One open offer per ordered pair. Declined or revoked offers are separate rows,
-- so a fresh offer is a new row, not a resurrection of a stale one.
CREATE UNIQUE INDEX partner_connections_pending_pair_idx
  ON partner_connections (requester_id, recipient_id)
  WHERE status = 'PENDING';

CREATE INDEX partner_connections_recipient_idx
  ON partner_connections (recipient_id, status, requested_at DESC);
CREATE INDEX partner_connections_requester_idx
  ON partner_connections (requester_id, status, requested_at DESC);

CREATE TABLE direct_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_uuid(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly two rows per conversation, enforced by the service layer: there is no
-- API to add or remove members, so the table can never drift into a group chat.
CREATE TABLE direct_conversation_members (
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX direct_conversation_members_user_idx
  ON direct_conversation_members (user_id, created_at DESC);

CREATE TABLE direct_messages (
  id              uuid PRIMARY KEY DEFAULT gen_uuid(),
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  client_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT direct_messages_body CHECK (length(btrim(body)) > 0)
);

-- Cursor pagination on (created_at, id), matching the workspace messages table.
CREATE INDEX direct_messages_conversation_cursor_idx
  ON direct_messages (conversation_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- A client-generated id makes a retried send idempotent: the same client_id
-- never inserts a second copy of the same message.
CREATE UNIQUE INDEX direct_messages_client_idempotency_idx
  ON direct_messages (sender_id, client_id)
  WHERE client_id IS NOT NULL AND sender_id IS NOT NULL;