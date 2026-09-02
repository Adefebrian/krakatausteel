-- 0030_akrual_jasa_per_baris_jadwal.sql
--
-- THE DEFECT THIS CLOSES. Piutang Jasa Administrasi (1.1.04) went NEGATIVE and
-- Pendapatan Jasa Administrasi was understated by the same amount, on a demo
-- world whose balance sheet still balanced (the income was missing too, so no
-- integrity view could see it). The arithmetic was never wrong; the
-- CLASSIFICATION was.
--
--   * `modules/angsuran` chose the jasa event for a receipt from ONE config
--     cell, `akuntansi.metode_pengakuan_jasa_adm`. That cell is ACCRUAL, so
--     EVERY receipt posted `ANGSURAN_JASA_ADM_AKRUAL`, which CREDITS 1.1.04 on
--     the assumption the receivable already exists.
--   * `modules/closing` accrues `jasa_jatuh_tempo_periode -
--     jasa_diterima_periode`. An instalment PAID IN THE MONTH IT FALLS DUE
--     nets to zero, so it is never accrued and nothing ever DEBITS 1.1.04.
--
-- The credit happened, the matching debit never did. The netting in the close
-- is correct on its own terms (a receipt that recognises income directly must
-- not be accrued a second time); the wrong half is the receipt, which must
-- follow whether THAT jasa was actually accrued rather than what a global
-- config cell says. OPEN-QUESTIONS item 3 already framed the target rule in as
-- many words: "engine bisa memutuskan per rupiah: sebesar yang pernah diakrual
-- pakai event akrual, sisanya pakai event non akrual". This migration supplies
-- the fact that makes that decidable.
--
-- WHY NOT `akrual_jasa_snapshot`. It is per akad per PERIOD and carries one
-- total. A receipt arriving in M+2 against instalments due in M and M+1 cannot
-- ask it "how much of THIS line's jasa is already sitting in 1.1.04" without
-- re-deriving the answer from the whole history of every period, and a
-- re-derivation that disagrees with the ledger is exactly the failure mode
-- that produced the defect. The fact belongs on the row it is a fact about.
--
-- WHY A REMAINING BALANCE AND NOT AN ACCRUED-EVER TOTAL. The question the
-- receipt asks is "how much is STILL in 1.1.04 for this line", so the column
-- is a live balance: the close sets it, a receipt consumes it, a reversal puts
-- it back. An accrued-ever total would force every reader to subtract a
-- collection history it does not have.
--
-- THE CHECK IS THE REAL CONTROL. `jasa_akrual_belum_tertagih` may never exceed
-- the line's UNPAID jasa. That single constraint is what makes the negative
-- balance structurally unreachable: a receipt can only credit 1.1.04 for jasa
-- this column says is there, the column can never claim more than the line
-- still owes, and `pumk_jadwal_terbayar_ck` already forbids overpaying a line.
-- Together they bound total credits to 1.1.04 by total debits to it.
--
-- THE VERSIONED SCHEDULE. A reschedule retires a version and writes a new one.
-- Accrued jasa on a retired row is money ALREADY IN THE LEDGER, so dropping it
-- with the version would strand a receivable no receipt can ever clear.
-- `modules/angsuran` carries the balance forward onto the new version's rows
-- (earliest first) inside the same transaction, and refuses the reschedule
-- when the new version has no room for it, because a restructure that shrinks
-- jasa below what has already been recognised as income is a WAIVER and spec
-- 6.4 has no event for one. The schema's part of that contract is only the
-- CHECK above: it makes an over-placement fail rather than silently exceed.

-- up

ALTER TABLE pumk_jadwal_angsuran
  ADD COLUMN jasa_akrual_belum_tertagih NUMERIC(20,2) NOT NULL DEFAULT 0;

ALTER TABLE pumk_jadwal_angsuran
  ADD CONSTRAINT pumk_jadwal_akrual_ck CHECK (
    jasa_akrual_belum_tertagih >= 0
    AND jasa_akrual_belum_tertagih <= jasa_adm - jasa_terbayar
  );

COMMENT ON COLUMN pumk_jadwal_angsuran.jasa_akrual_belum_tertagih IS
  'Jasa administrasi baris ini yang SUDAH diakrual (Dr 1.1.04 Piutang Jasa Administrasi, Cr pendapatan) oleh closing spec 8.3 dan BELUM ditagih kasnya. Ditulis ulang setiap run akrual untuk baris yang jatuh tempo di periode itu, dikurangi saat setoran mengalokasikan jasa ke baris ini (yang lalu memakai ANGSURAN_JASA_ADM_AKRUAL sebesar bagian ini dan ANGSURAN_JASA_ADM untuk sisanya), dan dikembalikan saat setoran itu dibalik. Nol berarti jasa baris ini belum pernah jadi piutang, jadi setorannya adalah pendapatan langsung: itulah kasus akad di luar akrual_hanya_untuk_kolektibilitas, dan kasus angsuran yang dibayar di bulan jatuh temponya sebelum closing. Lihat migrations/0030.';

-- The provenance of every consumption, so a reversal can put back EXACTLY what
-- a receipt took and not a recomputed approximation. Without this, reversing a
-- receipt would have to guess which lines it cleared, and a guess that lands on
-- the wrong line leaves 1.1.04 right in total and wrong per akad, which is
-- precisely the class of error spec 8.4 check 10 exists to catch.
CREATE TABLE pumk_angsuran_akrual (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  angsuran_id UUID NOT NULL REFERENCES pumk_angsuran(id),
  jadwal_id UUID NOT NULL REFERENCES pumk_jadwal_angsuran(id),
  nilai NUMERIC(20,2) NOT NULL CHECK (nilai > 0),
  -- Set when the consumption has been given back. Kept rather than deleted:
  -- the row is the evidence that a receipt once cleared this much of 1.1.04,
  -- and evidence of a corrected entry is not removed (invariant 4, ADR 0005).
  dipulihkan_at TIMESTAMPTZ,
  dipulihkan_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pumk_angsuran_akrual_uq UNIQUE (angsuran_id, jadwal_id),
  CONSTRAINT pumk_angsuran_akrual_pulih_ck CHECK (
    (dipulihkan_at IS NULL AND dipulihkan_by IS NULL)
    OR (dipulihkan_at IS NOT NULL AND dipulihkan_by IS NOT NULL)
  )
);

CREATE INDEX pumk_angsuran_akrual_angsuran_idx ON pumk_angsuran_akrual (angsuran_id);
CREATE INDEX pumk_angsuran_akrual_jadwal_idx ON pumk_angsuran_akrual (jadwal_id);

SELECT tjsl_attach_block_delete('pumk_angsuran_akrual');

COMMENT ON TABLE pumk_angsuran_akrual IS
  'Berapa piutang jasa administrasi yang sudah diakrual dikonsumsi oleh satu setoran, per baris jadwal. Dipakai pembalikan setoran untuk mengembalikan pumk_jadwal_angsuran.jasa_akrual_belum_tertagih persis sebesar yang diambil. Lihat migrations/0030.';

-- BACKFILL, and what it can and cannot know.
--
-- A world seeded before this migration carries the defect in its ledger: every
-- receipt credited 1.1.04 whether or not the jasa was accrued. This migration
-- does NOT rewrite those journals; ledger history is not editable (invariant 4)
-- and a reversal of twenty four months of receipts is an accounting decision,
-- not a schema change. What it CAN do is stop the defect from continuing:
-- restore, on every line still owing jasa, the accrued balance the accrual
-- engine would have recorded for it.
--
-- The rule: a line is accrued-and-uncollected exactly when it is on the ACTIVE
-- version, still owes jasa, and fell due inside a period whose accrual run
-- produced a non-zero accrual FOR ITS OWN AKAD. That is the same predicate the
-- engine now writes, evaluated against the snapshots that already exist. It is
-- never an over-claim: the snapshot's `jasa_diakrual` for that akad and period
-- was `SUM(jasa_adm) - SUM(jasa_terbayar)` across that period's lines at close
-- time, and payments only ever reduce what is still owed, so the per-line
-- unpaid jasa today is bounded by it.
--
-- Lines whose akad never had a non-zero accrual (kolektibilitas outside
-- `akrual_hanya_untuk_kolektibilitas`, or paid before the close) stay at zero,
-- which is exactly right: their jasa was never a receivable.
UPDATE pumk_jadwal_angsuran r
   SET jasa_akrual_belum_tertagih = r.jasa_adm - r.jasa_terbayar
 WHERE r.is_active_version
   AND r.deleted_at IS NULL
   AND r.jasa_adm > r.jasa_terbayar
   AND EXISTS (
     SELECT 1
       FROM akrual_jasa_snapshot s
       JOIN periode p ON p.id = s.periode_id
      WHERE s.akad_id = r.akad_id
        AND s.deleted_at IS NULL
        AND s.jasa_diakrual > 0
        AND r.tanggal_jatuh_tempo BETWEEN p.tanggal_mulai AND p.tanggal_akhir
   );

-- down
-- Removes the column, its CHECK and the provenance table. The backfill needs no
-- inverse: the column it wrote is the thing being dropped.
DROP TABLE IF EXISTS pumk_angsuran_akrual;
ALTER TABLE pumk_jadwal_angsuran
  DROP CONSTRAINT IF EXISTS pumk_jadwal_akrual_ck;
ALTER TABLE pumk_jadwal_angsuran
  DROP COLUMN IF EXISTS jasa_akrual_belum_tertagih;
