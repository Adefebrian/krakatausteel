-- 0020_jalur_posting_dan_idempotensi.sql
--
-- Two items from the review gate.
--
-- ===========================================================================
-- CRIT-2. Invariant 11 ("every financial event may only create a journal
-- through one central path") had no enforcement of any kind. The boundary
-- checker reads import specifiers, so it cannot see a hand-rolled
-- `insert into jurnal_baris`; the single engine instance in core/app.ts is a
-- convention; and the journal module's own concurrency test inserts rows by
-- hand, which is the nearest example a later agent copies.
--
-- WHAT THIS TRIGGER IS, STATED PLAINLY, BECAUSE A GUARD THAT OVERSELLS ITSELF
-- IS WORSE THAN NONE:
--
--   It is a TRIPWIRE AGAINST ACCIDENT, not a security boundary.
--
--   A business module CAN defeat it. Any code that can execute SQL can execute
--   `set_config('tjsl.jalur_posting', 'engine', true)` and then insert freely;
--   the database cannot tell which TypeScript module called it. So this does
--   not stop a determined or careless author who reads this file. What it does
--   stop, loudly and immediately, is the realistic failure: someone writes a
--   direct INSERT because it was convenient, runs it, and gets an error naming
--   the rule instead of a silently mis-posted ledger. It also covers paths the
--   static checker cannot see at all: psql sessions, ad hoc scripts, tools/,
--   core/, and anything outside apps/api/src/modules/**.
--
--   The pair matters more than either half: the static check in
--   tools/check-boundaries.ts catches the source text at CI time, this catches
--   execution at runtime. Neither alone is sufficient.
--
--   THE REAL BOUNDARY, if one is wanted later, is role separation: REVOKE
--   INSERT/UPDATE/DELETE on jurnal and jurnal_baris from the application role
--   and expose one SECURITY DEFINER function owned by a privileged role. Then
--   the app literally cannot write a journal line, spoofing is impossible, and
--   the guard stops depending on good faith. That needs a second database role
--   (the deployment currently connects as the table owner, and an owner keeps
--   its privileges through any REVOKE), so it is a devops change, not a
--   migration. Recorded in OPEN-QUESTIONS.md item 22.
--
-- GUC SEMANTICS, VERIFIED EMPIRICALLY RATHER THAN ASSUMED (psql probe output
-- pasted in the handover):
--   * current_setting('tjsl.jalur_posting', true) returns NULL when unset, so
--     the trigger can test it without an exception.
--   * SET LOCAL inside a transaction is visible in that transaction and is
--     GONE after both COMMIT and ROLLBACK on the same connection. So a pooled
--     connection cannot carry the blessing into the next checkout.
--   * In autocommit there is no surrounding transaction: Postgres emits
--     "WARNING: SET LOCAL can only be used in transaction blocks" and the value
--     is not visible to the next statement, so the INSERT is REFUSED. The
--     failure direction is refusal, never silent allow.
--   * set_config(key, value, is_local => true) behaves identically to SET LOCAL.
--   * PLAIN `SET` (no LOCAL) IS SESSION SCOPED AND DOES SURVIVE COMMIT. That is
--     the one way this guard turns itself off quietly: a one-word slip in the
--     engine's insert path would bless a pooled connection until it is reset.
--     Postgres offers no way to tell a SET LOCAL value from a SET value inside
--     the transaction (pg_settings.source is 'session' for both), so the
--     trigger cannot detect that slip directly.
--   * The fix costs the caller nothing: if the value carries the current
--     transaction id, a leaked or hand-copied value stops matching in any other
--     transaction. Verified empirically. THE NONCE IS THEREFORE MANDATORY here;
--     the bare form 'engine' is refused, because accepting it would leave the
--     leak open and make this guard something we only pretend is tight.
--
--   THE CONTRACT THE ENGINE MUST USE, exactly:
--
--       SELECT set_config('tjsl.jalur_posting', 'engine:' || txid_current(), true);
--
--     once per transaction, before the first journal write. `true` is is_local,
--     which is what makes it die with the transaction. A bare
--     `SET LOCAL tjsl.jalur_posting = 'engine'` is REFUSED by design.
--
-- SANCTIONED NON-ENGINE PATHS, WITHOUT A SECOND BLESSED VALUE SPREADING BY
-- COPY-PASTE: the allowed set is closed and, more importantly, the value is
-- STAMPED ONTO THE ROW (jurnal.jalur_posting). A seed or an opening-balance
-- import is therefore not an invisible convention in code, it is a column in
-- production data: `SELECT * FROM v_jurnal_jalur_bukan_engine` lists every
-- journal that entered outside the engine, for every period, forever. If
-- 'seed' ever starts spreading, it spreads somewhere visible.
--
-- ===========================================================================
-- IMP-2. jurnal_idempotensi_uq was UNIQUE (kunci_idempotensi) with no tenant
-- scope, so two BUMN using the natural key shape (CLOSING/2026-01/PENYISIHAN)
-- collide and the second tenant's closing fails for no visible reason.
-- Recreated as (bumn_id, kunci_idempotensi), deliberately keeping the SAME
-- INDEX NAME so the engine's error map, which keys on the constraint name,
-- keeps matching without a coordinated change.

-- up

-- ---------------------------------------------------------------------------
-- CRIT-2
-- ---------------------------------------------------------------------------

ALTER TABLE jurnal
  ADD COLUMN jalur_posting TEXT NOT NULL DEFAULT 'LEGACY'
    CHECK (jalur_posting IN ('ENGINE', 'SEED', 'IMPORT_SALDO_AWAL', 'LEGACY'));
-- Rows that predate this migration are honestly labelled LEGACY rather than
-- retroactively claimed to have come from the engine. The trigger never
-- produces LEGACY, and the default is dropped so a future insert cannot
-- inherit it: with no default and NOT NULL, disabling the trigger makes the
-- insert fail instead of quietly recording an unknown provenance.
ALTER TABLE jurnal ALTER COLUMN jalur_posting DROP DEFAULT;

COMMENT ON COLUMN jurnal.jalur_posting IS
  'Which sanctioned path wrote this journal, stamped by trigger from tjsl.jalur_posting. ENGINE is the only ordinary value; SEED and IMPORT_SALDO_AWAL are visible in the data precisely so they cannot become an invisible habit. LEGACY = written before 0020 existed.';

CREATE OR REPLACE FUNCTION tjsl_cek_jalur_posting() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_raw TEXT;
  v_jalur TEXT;
  v_nonce TEXT;
  v_txid TEXT := txid_current()::text;
BEGIN
  v_raw := current_setting('tjsl.jalur_posting', true);

  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RAISE EXCEPTION
      'TJSL-JRN-015: penulisan langsung ke % ditolak; semua jurnal wajib lewat engine jurnal (invarian 11). Jalur sah menyetel penanda per transaksi: SELECT set_config(''tjsl.jalur_posting'', ''engine:'' || txid_current(), true)',
      TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_jalur := upper(split_part(v_raw, ':', 1));
  v_nonce := nullif(split_part(v_raw, ':', 2), '');

  IF v_jalur NOT IN ('ENGINE', 'SEED', 'IMPORT_SALDO_AWAL') THEN
    RAISE EXCEPTION
      'TJSL-JRN-016: nilai tjsl.jalur_posting (%) tidak dikenal; yang sah hanya engine, seed, import_saldo_awal', v_raw
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The nonce is mandatory. Without it the value is session-scoped-shaped: a
  -- plain SET (the one-word slip) would bless a pooled connection until reset,
  -- and a copied line would keep working in transactions it was never meant
  -- for. With it, a blessing is worth exactly one transaction.
  IF v_nonce IS NULL THEN
    RAISE EXCEPTION
      'TJSL-JRN-017: tjsl.jalur_posting (%) tidak membawa nonce transaksi; wajib berbentuk ''<jalur>:'' || txid_current() dan disetel lokal: SELECT set_config(''tjsl.jalur_posting'', ''engine:'' || txid_current(), true)',
      v_raw
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_nonce <> v_txid THEN
    RAISE EXCEPTION
      'TJSL-JRN-018: tjsl.jalur_posting membawa nonce transaksi lain (% bukan %); nilai ini bocor atau disalin dari transaksi lain, setel ulang di dalam transaksi ini dengan set_config(..., true)',
      v_nonce, v_txid
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'jurnal' THEN
    NEW.jalur_posting := v_jalur;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION tjsl_cek_jalur_posting() IS
  'BEFORE INSERT guard for invariant 11. Requires tjsl.jalur_posting = <jalur>:<txid_current()>, set locally, so a blessing is worth one transaction only. A TRIPWIRE AGAINST MISTAKES, NOT A BOUNDARY AGAINST INTENT: a caller that can run SQL can set the flag in its own transaction and walk through. The real boundary is role separation, see ADR 0012 and OPEN-QUESTIONS item 22.';

-- Sorted first (_05_) so provenance is settled before any domain guard runs.
CREATE TRIGGER trg_jurnal_05_jalur_posting
  BEFORE INSERT ON jurnal
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_jalur_posting();

CREATE TRIGGER trg_jurnal_baris_05_jalur_posting
  BEFORE INSERT ON jurnal_baris
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_jalur_posting();

-- Every journal that entered outside the engine, for the health-check page and
-- for an auditor asking "what got in here another way".
CREATE VIEW v_jurnal_jalur_bukan_engine AS
SELECT
  j.jalur_posting,
  j.bumn_id,
  j.cabang_id,
  j.periode_id,
  j.id AS jurnal_id,
  j.no_jurnal,
  j.jenis,
  j.tanggal_transaksi,
  j.status,
  j.total_debit,
  j.total_kredit,
  j.created_by,
  j.created_at
FROM jurnal j
WHERE j.jalur_posting <> 'ENGINE'
  AND j.deleted_at IS NULL;

COMMENT ON VIEW v_jurnal_jalur_bukan_engine IS
  'Journals not written by the engine (SEED, IMPORT_SALDO_AWAL, or LEGACY from before migration 0020). Expected to be empty in production once the opening-balance import has run.';

CREATE INDEX jurnal_jalur_posting_idx ON jurnal (jalur_posting)
  WHERE jalur_posting <> 'ENGINE' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- IMP-2
-- ---------------------------------------------------------------------------
-- Same index NAME on purpose (the engine maps errors by constraint name),
-- different columns.
DROP INDEX jurnal_idempotensi_uq;
CREATE UNIQUE INDEX jurnal_idempotensi_uq ON jurnal (bumn_id, kunci_idempotensi)
  WHERE kunci_idempotensi IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX jurnal_idempotensi_uq IS
  'Closing idempotency key, scoped per BUMN (invariant 13). Unscoped before 0020, which made a natural key like CLOSING/2026-01/PENYISIHAN collide across tenants.';

-- down
DROP INDEX IF EXISTS jurnal_idempotensi_uq;
CREATE UNIQUE INDEX jurnal_idempotensi_uq ON jurnal (kunci_idempotensi)
  WHERE kunci_idempotensi IS NOT NULL AND deleted_at IS NULL;
DROP INDEX IF EXISTS jurnal_jalur_posting_idx;
DROP VIEW IF EXISTS v_jurnal_jalur_bukan_engine;
DROP TRIGGER IF EXISTS trg_jurnal_baris_05_jalur_posting ON jurnal_baris;
DROP TRIGGER IF EXISTS trg_jurnal_05_jalur_posting ON jurnal;
DROP FUNCTION IF EXISTS tjsl_cek_jalur_posting();
ALTER TABLE jurnal DROP COLUMN IF EXISTS jalur_posting;
