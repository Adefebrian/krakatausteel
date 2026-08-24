-- 0018_perbaikan_reversal.sql
--
-- Two bugs found by the journal engine, both confirmed with a standalone SQL
-- probe, both in migrations that are already committed and pushed (0007, 0010,
-- 0015). Fixed forward here rather than by editing those files.
--
-- Both bugs share one root cause: the schema treated REVERSED as if it were
-- "gone" (a state to be excluded), when it is actually "still in the ledger,
-- offset by its reversal". Correction by reversing entry is spec 6.3 and
-- invariant 4; a reversal adds two rows, it never removes any.
--
-- ---------------------------------------------------------------------------
-- BUG 1: the closed-period guard blocked the reversal that spec 6.3 mandates.
-- ---------------------------------------------------------------------------
-- trg_jurnal_10_periode fires BEFORE INSERT OR UPDATE OF (..., status), so
-- marking an original POSTED -> REVERSED re-ran the closed-period validation
-- against the ORIGINAL journal's transaction date. Once that period had
-- closed, TJSL-JRN-004 fired and the whole reversal rolled back. Spec 6.3
-- requires exactly this case to work: the reversing journal is dated in the
-- current OPEN period precisely because "periode asli mungkin sudah tutup",
-- and ADR 0002 already claims the guard "allows only the reversal transition".
-- The intent was documented, the trigger did not implement it.
--
-- FIX: early-return from tjsl_jurnal_validasi_periode() for exactly the
-- reversal transition, and only when the date and the period do not move.
--
-- WHY INVARIANT 5 SURVIVES, checked case by case rather than assumed:
--   * INSERT is untouched. A new journal dated into a CLOSED period is still
--     rejected, including the reversing journal itself, which is what actually
--     keeps corrections out of closed periods.
--   * DRAFT -> POSTED is untouched, because the early return requires
--     OLD.status = 'POSTED'. This is the case that matters most: a draft
--     created while the period was open, posted after it closed, is still
--     rejected.
--   * No date can move through this path: NEW.tanggal_transaksi and
--     NEW.periode_id must both equal their OLD values, or the early return
--     does not apply and the full validation runs.
--   * The bumn/cabang consistency check (TJSL-JRN-001) is skipped on this
--     path, and that is safe rather than lucky: trg_jurnal_20_immutable is
--     also BEFORE UPDATE on jurnal, sorts after this one, has no column list
--     so it always fires, and raises TJSL-JRN-011 if bumn_id or cabang_id
--     differs on a non-DRAFT row. An UPDATE that both reverses and moves the
--     branch still aborts, one trigger later.
--   * Deliberately NOT broadened to "NEW.status = OLD.status", which looks
--     harmless and is not: a DRAFT row is returned early by
--     trg_jurnal_20_immutable, so a no-op status rewrite that also changed
--     cabang_id on a DRAFT in a closed period would then skip both guards.
--     Narrow beats tidy here.
--   * Residual, accepted: re-writing status = 'REVERSED' on a row that is
--     ALREADY REVERSED, in a closed period, still raises TJSL-JRN-004. That is
--     a no-op the application never needs, and trg_jurnal_20_immutable forbids
--     leaving REVERSED anyway.
--
-- ---------------------------------------------------------------------------
-- BUG 2: v_rekonsiliasi_piutang double-counted every reversal.
-- ---------------------------------------------------------------------------
-- Its buku_besar CTE filtered j.status = 'POSTED'. When an original is marked
-- REVERSED its lines drop out of the sum, while the reversing journal (POSTED)
-- subtracts again, so the akad's ledger balance moved by twice the reversed
-- amount. The receivable sub-ledger reconciliation is spec 8.4 check 10, the
-- single most important number in the system, so this was reporting a
-- fabricated difference on every corrected akad.
--
-- FIX, and prevention of the whole class: the correct rule ("a ledger line
-- counts when its journal is POSTED or REVERSED, and neither row is
-- soft-deleted") is now stated ONCE, in v_ledger_baris, and every ledger
-- aggregate reads that view instead of re-deriving the filter. A future query
-- that gets this wrong now has to bypass a view whose comment says why.
--
-- Audit of everything else that sums or scans journal lines:
--   0015 v_integritas_jurnal   no status filter, per-journal internal balance.
--                              A REVERSED journal still balances. Correct.
--   0015 v_integritas_jadwal / v_integritas_snapshot   no journal sums.
--   0017 v_akun_belum_dipetakan, v_baris_jurnal_pihak_bermasalah,
--        v_jurnal_belum_terkirim   already IN ('POSTED','REVERSED'). Correct.
--   0017 v_rekonsiliasi_eksternal / v_drift_saldo_eksternal   read the frozen
--        snapshots, not journal lines. Correct here, BUT the closing engine
--        that WRITES saldo_akun_periode must use the same rule; if it filters
--        POSTED alone, every closed period's trial balance carries this bug.
--        Flagged to the closing-engine owner; not fixable in the schema.
--   0010 tjsl_akun_cegah_hapus_terpakai   already IN ('POSTED','REVERSED').
--
-- ---------------------------------------------------------------------------
-- BUG 3 (found while auditing, smaller): jurnal_cabang_tanggal_idx is partial
-- ON (status = 'POSTED'), so the corrected ledger predicate cannot use it. A
-- correctness fix that silently loses its index is a performance regression
-- waiting to be blamed on the fix, so the covering partial index is added here.

-- up

CREATE OR REPLACE FUNCTION tjsl_jurnal_validasi_periode() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_bumn UUID;
  p periode;
BEGIN
  -- Spec 6.3: reversing a journal whose original period has since CLOSED must
  -- work. This transition moves no money and no date; the accounting effect of
  -- the correction lives entirely in the reversing journal, which is inserted
  -- with a current date and validated on its own INSERT. See the file header
  -- for the case-by-case argument that invariant 5 is unaffected.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'POSTED'
     AND NEW.status = 'REVERSED'
     AND NEW.tanggal_transaksi = OLD.tanggal_transaksi
     AND NEW.periode_id = OLD.periode_id THEN
    RETURN NEW;
  END IF;

  SELECT bumn_id INTO v_bumn FROM cabang WHERE id = NEW.cabang_id;
  IF v_bumn IS DISTINCT FROM NEW.bumn_id THEN
    RAISE EXCEPTION 'TJSL-JRN-001: bumn_id jurnal (%) tidak cocok dengan bumn cabang (%)', NEW.bumn_id, v_bumn
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  p := tjsl_periode_untuk_tanggal(NEW.bumn_id, NEW.tanggal_transaksi);
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'TJSL-JRN-002: tidak ada periode yang memuat tanggal transaksi %', NEW.tanggal_transaksi
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p.id <> NEW.periode_id THEN
    RAISE EXCEPTION
      'TJSL-JRN-003: periode_id tidak sesuai tanggal transaksi %; seharusnya periode %-%',
      NEW.tanggal_transaksi, p.tahun, p.bulan
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF p.status = 'CLOSED' THEN
    RAISE EXCEPTION
      'TJSL-JRN-004: periode %-% sudah CLOSED; tidak boleh ada jurnal bertanggal % (koreksi lewat jurnal pembalik di periode terbuka)',
      p.tahun, p.bulan, NEW.tanggal_transaksi
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

-- The one definition of "this line counts in the ledger". A REVERSED journal
-- stays in: its lines are still real ledger entries, and they are offset by
-- the lines of its reversal, which is a separate POSTED journal. Excluding
-- REVERSED removes one side of that pair and doubles the effect of every
-- correction.
--
-- DRAFT is excluded: a draft is not an accounting fact yet (invariant 1 is not
-- even enforced on it until it is posted).
CREATE VIEW v_ledger_baris AS
SELECT
  b.id AS jurnal_baris_id,
  b.jurnal_id,
  b.urutan,
  b.akun_id,
  b.debit,
  b.kredit,
  (b.debit - b.kredit)::numeric(20,2) AS nilai_debit_positif,
  b.mitra_id,
  b.akad_id,
  b.dimensi_json,
  j.bumn_id,
  j.cabang_id,
  j.periode_id,
  j.no_jurnal,
  j.jenis,
  j.tanggal_transaksi,
  j.status AS status_jurnal,
  j.reversal_of_jurnal_id,
  j.reversed_by_jurnal_id
FROM jurnal_baris b
JOIN jurnal j ON j.id = b.jurnal_id
WHERE j.status IN ('POSTED', 'REVERSED')
  AND j.deleted_at IS NULL
  AND b.deleted_at IS NULL;

COMMENT ON VIEW v_ledger_baris IS
  'The canonical set of ledger lines: journal POSTED or REVERSED, nothing soft-deleted. Every ledger aggregate must read this view rather than re-deriving the status filter. A REVERSED journal stays in the sum because its lines are offset by its reversals lines; filtering POSTED alone double-counts every correction (fixed in 0018).';

-- Spec 8.4 check 10, rebuilt on v_ledger_baris. Column list, order and types
-- are unchanged from 0015, so any query or report already reading this view is
-- unaffected apart from now getting the right number.
DROP VIEW IF EXISTS v_rekonsiliasi_piutang;
CREATE VIEW v_rekonsiliasi_piutang AS
WITH akun_piutang AS (
  SELECT bumn_id, akun_debit_id AS akun_id
  FROM event_jurnal_mapping
  WHERE event_code = 'PENCAIRAN_PUMK' AND aktif AND deleted_at IS NULL
), buku_besar AS (
  SELECT l.akad_id, sum(l.nilai_debit_positif)::numeric(20,2) AS saldo_buku_besar
  FROM v_ledger_baris l
  JOIN akun_piutang ap ON ap.akun_id = l.akun_id AND ap.bumn_id = l.bumn_id
  WHERE l.akad_id IS NOT NULL
  GROUP BY l.akad_id
)
SELECT
  a.id AS akad_id,
  a.no_akad,
  a.cabang_id,
  a.mitra_id,
  a.status,
  a.outstanding_pokok AS saldo_sub_ledger,
  coalesce(bb.saldo_buku_besar, 0)::numeric(20,2) AS saldo_buku_besar,
  (a.outstanding_pokok - coalesce(bb.saldo_buku_besar, 0))::numeric(20,2) AS selisih
FROM pumk_akad a
LEFT JOIN buku_besar bb ON bb.akad_id = a.id
WHERE a.deleted_at IS NULL;

COMMENT ON VIEW v_rekonsiliasi_piutang IS
  'Spec 8.4 check 10. Rows with selisih <> 0 must block period closing and are the drill-down list the UI shows. Reads v_ledger_baris, so a reversed journal is counted once, not twice.';

-- BUG 3: the ledger predicate is now (POSTED, REVERSED), which cannot use the
-- POSTED-only partial index from 0010. That index is left in place (it still
-- serves queries that genuinely want only POSTED, and dropping an index from a
-- pushed migration is a separate decision) and the covering one is added.
CREATE INDEX jurnal_ledger_cabang_tanggal_idx ON jurnal (cabang_id, tanggal_transaksi)
  WHERE status IN ('POSTED', 'REVERSED') AND deleted_at IS NULL;
CREATE INDEX jurnal_ledger_periode_idx ON jurnal (periode_id)
  WHERE status IN ('POSTED', 'REVERSED') AND deleted_at IS NULL;

-- down
-- Restores the exact pre-0018 behaviour, bugs included: a down migration undoes
-- a change, it does not half-keep it. Rolling back therefore reinstates the
-- POSTED-only reconciliation and the reversal-blocking guard.
DROP INDEX IF EXISTS jurnal_ledger_periode_idx;
DROP INDEX IF EXISTS jurnal_ledger_cabang_tanggal_idx;
DROP VIEW IF EXISTS v_rekonsiliasi_piutang;
CREATE VIEW v_rekonsiliasi_piutang AS
WITH akun_piutang AS (
  SELECT bumn_id, akun_debit_id AS akun_id
  FROM event_jurnal_mapping
  WHERE event_code = 'PENCAIRAN_PUMK' AND aktif AND deleted_at IS NULL
), buku_besar AS (
  SELECT b.akad_id, sum(b.debit - b.kredit)::numeric(20,2) AS saldo_buku_besar
  FROM jurnal_baris b
  JOIN jurnal j ON j.id = b.jurnal_id
  JOIN akun_piutang ap ON ap.akun_id = b.akun_id AND ap.bumn_id = j.bumn_id
  WHERE j.status = 'POSTED'
    AND j.deleted_at IS NULL
    AND b.deleted_at IS NULL
    AND b.akad_id IS NOT NULL
  GROUP BY b.akad_id
)
SELECT
  a.id AS akad_id,
  a.no_akad,
  a.cabang_id,
  a.mitra_id,
  a.status,
  a.outstanding_pokok AS saldo_sub_ledger,
  coalesce(bb.saldo_buku_besar, 0)::numeric(20,2) AS saldo_buku_besar,
  (a.outstanding_pokok - coalesce(bb.saldo_buku_besar, 0))::numeric(20,2) AS selisih
FROM pumk_akad a
LEFT JOIN buku_besar bb ON bb.akad_id = a.id
WHERE a.deleted_at IS NULL;
DROP VIEW IF EXISTS v_ledger_baris;
CREATE OR REPLACE FUNCTION tjsl_jurnal_validasi_periode() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_bumn UUID;
  p periode;
BEGIN
  SELECT bumn_id INTO v_bumn FROM cabang WHERE id = NEW.cabang_id;
  IF v_bumn IS DISTINCT FROM NEW.bumn_id THEN
    RAISE EXCEPTION 'TJSL-JRN-001: bumn_id jurnal (%) tidak cocok dengan bumn cabang (%)', NEW.bumn_id, v_bumn
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  p := tjsl_periode_untuk_tanggal(NEW.bumn_id, NEW.tanggal_transaksi);
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'TJSL-JRN-002: tidak ada periode yang memuat tanggal transaksi %', NEW.tanggal_transaksi
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p.id <> NEW.periode_id THEN
    RAISE EXCEPTION
      'TJSL-JRN-003: periode_id tidak sesuai tanggal transaksi %; seharusnya periode %-%',
      NEW.tanggal_transaksi, p.tahun, p.bulan
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF p.status = 'CLOSED' THEN
    RAISE EXCEPTION
      'TJSL-JRN-004: periode %-% sudah CLOSED; tidak boleh ada jurnal bertanggal % (koreksi lewat jurnal pembalik di periode terbuka)',
      p.tahun, p.bulan, NEW.tanggal_transaksi
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$fn$;
