-- =============================================================================
-- 020_admin_enums.sql
-- New enum values for administrative group suspension and abuse reporting.
--
-- Isolated in its own migration because PostgreSQL does not allow a value added
-- with ALTER TYPE ... ADD VALUE to be used in the same transaction. The
-- administrative console migration (021) references both values.
-- =============================================================================

-- A suspended group is distinct from an archived one: suspension is an
-- administrative hold that can be lifted (restore), while archiving is the
-- owner's decision that a group has finished.
ALTER TYPE group_status ADD VALUE IF NOT EXISTS 'SUSPENDED';

-- The catch-all abuse category the specification calls for, alongside the
-- existing harassment / spam / impersonation categories. Added rather than
-- replacing anything, so historical reports stay valid.
ALTER TYPE report_category ADD VALUE IF NOT EXISTS 'ABUSE';
