-- 0002_konvensi_bersama.sql
--
-- Shared conventions for every TJSL entity that follows.
--
-- WHY THIS FILE EXISTS
-- Spec invariant 12 requires audit columns + soft delete on every financial
-- entity, and invariant 7 requires fixed-precision money. Rather than repeat
-- (and eventually diverge on) that boilerplate in 12 more migrations, the
-- shared trigger functions live here once and are attached per table with
-- SELECT tjsl_attach_audit_trigger('<table>').
--
-- MONEY: every money column in this schema is NUMERIC(20,2), written out
-- literally (not hidden behind a DOMAIN) so that
--   \d <table>  and  grep -n 'double\|real\|float' migrations/
-- are both trustworthy audits. Rates/percentages are NUMERIC(9,6)
-- (e.g. 0.030000 = 3 percent). No float, double or real anywhere, ever.
--
-- IDs: UUID + gen_random_uuid() (pgcrypto, already installed).
-- ENUM-LIKE COLUMNS: TEXT + CHECK, not native enum types, because Postgres
-- enums cannot have values removed and reordering requires a rewrite; the
-- value sets here (proposal status, jurnal jenis, ...) come from a client
-- spec that is still under confirmation.

-- up

-- Bumps updated_at and version on every UPDATE. Attached to every entity
-- carrying the audit block. Deliberately does NOT set updated_by: that is
-- the application's job (the DB does not know the acting user), and a
-- trigger silently blanking it would destroy the audit trail.
CREATE OR REPLACE FUNCTION tjsl_audit_touch() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  -- version is monotonic: never let a client write it backwards or freeze it.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION tjsl_audit_touch() IS
  'BEFORE UPDATE trigger: sets updated_at = now() and version = OLD.version + 1 (spec invariant 12).';

-- Attaches tjsl_audit_touch() to a table. Kept as a function so each domain
-- migration reads as a list of tables rather than a wall of CREATE TRIGGER.
CREATE OR REPLACE FUNCTION tjsl_attach_audit_trigger(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_%1$s_00_audit BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION tjsl_audit_touch()',
    p_table
  );
END;
$fn$;

COMMENT ON FUNCTION tjsl_attach_audit_trigger(text) IS
  'Attaches the shared audit-touch BEFORE UPDATE trigger to a table. Trigger name is sorted first (_00_) so audit columns are stamped before any domain guard trigger inspects the row.';

-- Blocks physical DELETE outright. Spec invariant 12: soft delete only.
-- Attached to the tables where a physical delete is never acceptable even in
-- DRAFT state (audit_log, saldo snapshots, posted-ledger tables).
CREATE OR REPLACE FUNCTION tjsl_block_delete() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'TJSL-DEL-001: physical delete is not allowed on %; use soft delete (deleted_at/deleted_by)',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

COMMENT ON FUNCTION tjsl_block_delete() IS
  'BEFORE DELETE trigger: unconditionally raises. Used on append-only tables (audit_log, saldo_akun_periode, ...).';

CREATE OR REPLACE FUNCTION tjsl_attach_block_delete(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_%1$s_90_no_delete BEFORE DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION tjsl_block_delete()',
    p_table
  );
END;
$fn$;

-- Adds the three audit-actor foreign keys (created_by / updated_by / deleted_by
-- -> app_user) to a table. Split out from CREATE TABLE because app_user itself
-- carries the audit block, and app_user references cabang which references
-- bumn: the FK cycle is only resolvable after all three tables exist.
CREATE OR REPLACE FUNCTION tjsl_attach_audit_fk(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'ALTER TABLE %1$I
       ADD CONSTRAINT %1$s_created_by_fk FOREIGN KEY (created_by) REFERENCES app_user(id),
       ADD CONSTRAINT %1$s_updated_by_fk FOREIGN KEY (updated_by) REFERENCES app_user(id),
       ADD CONSTRAINT %1$s_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES app_user(id)',
    p_table
  );
END;
$fn$;

-- Soft-delete consistency: deleted_at and deleted_by are set together or not
-- at all. Applied as a table CHECK via this helper to keep the DDL short.
CREATE OR REPLACE FUNCTION tjsl_attach_soft_delete_check(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'ALTER TABLE %1$I ADD CONSTRAINT %1$s_soft_delete_ck
       CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))',
    p_table
  );
END;
$fn$;


-- down
DROP FUNCTION IF EXISTS tjsl_attach_soft_delete_check(text);
DROP FUNCTION IF EXISTS tjsl_attach_audit_fk(text);
DROP FUNCTION IF EXISTS tjsl_attach_block_delete(text);
DROP FUNCTION IF EXISTS tjsl_block_delete();
DROP FUNCTION IF EXISTS tjsl_attach_audit_trigger(text);
DROP FUNCTION IF EXISTS tjsl_audit_touch();
