-- 0021_blokir_truncate.sql
--
-- Security finding F-5, and the class behind it.
--
-- THE HOLE. Every guard this schema has against physical deletion of financial
-- or audit data is FOR EACH ROW: tjsl_block_delete (0002),
-- tjsl_audit_log_append_only (0014), tjsl_jurnal_block_delete and
-- tjsl_jurnal_baris_immutable (0010). A row-level trigger never fires for
-- TRUNCATE, because TRUNCATE does not touch rows; it swaps the relation's
-- storage. So `TRUNCATE audit_log` succeeded, and it was not the only one:
--
--     audit_log             append-only          FOR EACH ROW  -> TRUNCATE walked through
--     jurnal                delete blocked       FOR EACH ROW  -> same
--     jurnal_baris          update/delete frozen FOR EACH ROW  -> same
--     periode               delete blocked       FOR EACH ROW  -> same
--     akun                  delete blocked       FOR EACH ROW  -> same
--     pumk_jadwal_angsuran  delete blocked       FOR EACH ROW  -> same
--     jurnal_ekspor         delete blocked       FOR EACH ROW  -> same
--
-- One reported instance, seven actual instances. That is what "check whether it
-- is a pattern" is for.
--
-- THE FIX, and why it reaches further than the seven tables. A BEFORE TRUNCATE
-- trigger is statement-level, and it also fires when the table is reached by
-- TRUNCATE ... CASCADE from somewhere else. So guarding the ledger tables does
-- not only refuse `TRUNCATE jurnal`; it refuses any cascade that would arrive
-- there, including `TRUNCATE bumn CASCADE`, which would otherwise take the
-- whole entity's books with it. Proven in the handover output.
--
-- WHO CAN DO THIS AT ALL. TRUNCATE requires TRUNCATE privilege, which in
-- practice means the table owner. This deployment connects as the owner, so the
-- application role can issue it today, which is exactly why the guard belongs
-- in the database rather than in a policy document. The same role separation
-- that would turn the posting-path tripwire into a real boundary (ADR 0012,
-- OPEN-QUESTIONS item 22) would also remove TRUNCATE from the app role. Until
-- then, this trigger is the control.
--
-- WHAT IS DELIBERATELY NOT GUARDED. Derived, regenerable snapshots
-- (saldo_akun_periode, kolektibilitas_snapshot, saldo_akun_eksternal, and the
-- rest) keep no TRUNCATE guard, for the same reason they keep no DELETE guard:
-- reopening a period is defined as dropping its snapshot (spec 8.4), and a
-- figure that can be recomputed from the ledger is not evidence. The rule this
-- migration encodes is narrow and deliberate: what cannot be reconstructed is
-- what cannot be removed.

-- up

CREATE OR REPLACE FUNCTION tjsl_block_truncate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'TJSL-DEL-002: TRUNCATE tidak diizinkan pada %; tabel ini adalah bukti (buku besar atau jejak audit) dan tidak bisa dihapus fisik, termasuk lewat TRUNCATE ... CASCADE dari tabel lain',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

COMMENT ON FUNCTION tjsl_block_truncate() IS
  'BEFORE TRUNCATE statement-level trigger: unconditionally raises. Row-level guards never see TRUNCATE, which is how finding F-5 happened.';

CREATE OR REPLACE FUNCTION tjsl_attach_block_truncate(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_%1$s_95_no_truncate BEFORE TRUNCATE ON %1$I FOR EACH STATEMENT EXECUTE FUNCTION tjsl_block_truncate()',
    p_table
  );
END;
$fn$;

-- Every table whose row-level guard had this blind spot.
SELECT tjsl_attach_block_truncate(t) FROM (VALUES
  ('audit_log'),
  ('jurnal'),
  ('jurnal_baris'),
  ('periode'),
  ('akun'),
  ('pumk_jadwal_angsuran'),
  ('jurnal_ekspor')
) AS x(t);

-- Fix the pattern at its source, not just its instances: the shared helper from
-- 0002 now attaches BOTH guards, so a table added in a later migration cannot
-- inherit the hole by using the convention correctly. Redefined rather than
-- edited in place because 0002 is pushed.
CREATE OR REPLACE FUNCTION tjsl_attach_block_delete(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_%1$s_90_no_delete BEFORE DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION tjsl_block_delete()',
    p_table
  );
  -- A row-level DELETE guard without its statement-level TRUNCATE twin is a
  -- guard with a documented bypass. Attach both, always (finding F-5).
  EXECUTE format(
    'CREATE TRIGGER trg_%1$s_95_no_truncate BEFORE TRUNCATE ON %1$I FOR EACH STATEMENT EXECUTE FUNCTION tjsl_block_truncate()',
    p_table
  );
END;
$fn$;

COMMENT ON FUNCTION tjsl_attach_block_delete(text) IS
  'Attaches both physical-deletion guards to a table: BEFORE DELETE FOR EACH ROW and BEFORE TRUNCATE FOR EACH STATEMENT. Since 0021 (finding F-5) the second one is not optional.';

-- down
DROP TRIGGER IF EXISTS trg_jurnal_ekspor_95_no_truncate ON jurnal_ekspor;
DROP TRIGGER IF EXISTS trg_pumk_jadwal_angsuran_95_no_truncate ON pumk_jadwal_angsuran;
DROP TRIGGER IF EXISTS trg_akun_95_no_truncate ON akun;
DROP TRIGGER IF EXISTS trg_periode_95_no_truncate ON periode;
DROP TRIGGER IF EXISTS trg_jurnal_baris_95_no_truncate ON jurnal_baris;
DROP TRIGGER IF EXISTS trg_jurnal_95_no_truncate ON jurnal;
DROP TRIGGER IF EXISTS trg_audit_log_95_no_truncate ON audit_log;
-- Restores the 0002 body verbatim: a rollback undoes the change, it does not
-- keep half of it.
CREATE OR REPLACE FUNCTION tjsl_attach_block_delete(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_%1$s_90_no_delete BEFORE DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION tjsl_block_delete()',
    p_table
  );
END;
$fn$;
DROP FUNCTION IF EXISTS tjsl_attach_block_truncate(text);
DROP FUNCTION IF EXISTS tjsl_block_truncate();
