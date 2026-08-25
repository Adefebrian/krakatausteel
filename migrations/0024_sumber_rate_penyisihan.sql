-- 0024_sumber_rate_penyisihan.sql
--
-- Where a snapshot's provision rate came from, recorded on the snapshot.
--
-- THE GAP. docs/REGULASI.md item 2 asks for the column by name ("Tambahkan
-- kolom `sumber_rate`"). migrations/0011 shipped `rate_penyisihan` and
-- `dasar_perhitungan` and stopped there, which was enough while there was one
-- way to obtain a rate. There are now two, chosen by `akuntansi.mode_penyisihan`
-- (RATE_TABLE, the specification's fixed table in Bagian 5.2; and
-- KOLEKTIF_HISTORIS, the collective-impairment basis the regulation review
-- found to be the one actually in force). With both live, 0.400000 in
-- `rate_penyisihan` is silent about whether an operator typed it into
-- `penyisihan_rate` or an engine derived it from collection history.
--
-- The day the mode is switched, every period closed under the old one loses
-- its explanation: Laporan Perhitungan Penyisihan (Bagian 10.4 laporan 28),
-- whose entire job is to reconstruct the provision journal, would print a rate
-- it can no longer attribute. That is invariant 14 broken for the one report
-- that exists to satisfy it.
--
-- WHAT IS RECORDED, AND WHY THAT AND NOT SOMETHING ELSE. Three options were on
-- the table; this migration takes the second.
--
--   (a) The mode alone. Enough for RATE_TABLE, because the rate it names is
--       already copied onto the row and the row already carries the class and
--       the arrears days that selected it. NOT enough for KOLEKTIF_HISTORIS:
--       "computed from history" without saying WHICH history is not an
--       attribution, it is a label. A reader in three years would be told the
--       number was derived and given nothing to derive it from.
--
--   (b) The mode plus the inputs that are otherwise irrecoverable. Taken.
--       Under KOLEKTIF_HISTORIS the rate is a function of a window of
--       collection history, and that history lives in the ledger and in the
--       instalment tables, which are append-only. So the window is the whole
--       of what is missing: with `rate_histori_dari` and `rate_histori_sampai`
--       a reader recomputes the rate from immutable data and compares it to
--       the `rate_penyisihan` this row froze. Without them the window is
--       unrecoverable, because `akuntansi.penyisihan_min_bulan_histori` is a
--       config row that will have changed by then.
--
--   (c) A pointer to the config row version in force. REJECTED, and it is the
--       tempting option, so the reason matters. `konfigurasi`, `penyisihan_rate`
--       and `kolektibilitas_range` are all mutated IN PLACE: `version` is an
--       optimistic-lock counter that increments on update, not a history key,
--       and there is no config history table to point at. The pointer would
--       therefore resolve to today's value while claiming to be the one used,
--       which is worse than storing nothing: it reads like provenance and is
--       not. Only `audit_log` holds the old value, and audit_log is evidence
--       of a change, not a source of record for a financial report.
--
-- WHAT IS DELIBERATELY NOT ADDED. No columns for the arrears band
-- (`kolektibilitas_range.hari_min` / `hari_max`) that mapped this row's
-- `hari_tunggakan` onto its `kolektibilitas`. The row already stores BOTH ends
-- of that mapping, per akad: 45 days and KURANG_LANCAR. Band columns would
-- restate a fact already recorded rather than add a missing one, and 0011's
-- rule is that a snapshot carries the inputs it USED, not a copy of every
-- table it read.
--
-- NOT NULL, AND NO DEFAULT. A default would let an engine that never thought
-- about provenance write TABEL_KONFIGURASI over a historically-derived rate,
-- silently, into a period an auditor will later ask about. That is the exact
-- failure this column exists to prevent, so the schema refuses the row instead:
-- an engine that cannot say where its rate came from may not write a snapshot
-- at all. `apps/api/src/modules/closing/contract.ts` already declares
-- `sumberRate` as a required field of `BarisKolektibilitas`, so the value is
-- in hand at insert time.
--
-- THE WINDOW COLUMNS ARE NULLABLE, AND THE MODE DECIDES. Nullable at the
-- column level, mandatory at the row level through
-- `kolektibilitas_snapshot_sumber_rate_ck`: NULL for TABEL_KONFIGURASI (there
-- is no window; inventing one would be a lie), NOT NULL and ordered for
-- KOLEKTIF_HISTORIS. So the historical mode cannot record a rate it cannot
-- explain, and the rate-table mode cannot pretend it consulted history.

-- up

ALTER TABLE kolektibilitas_snapshot
  -- Mirrors `SumberRate` in modules/closing/contract.ts. Note the values are
  -- NOT the same strings as `akuntansi.mode_penyisihan` (RATE_TABLE /
  -- KOLEKTIF_HISTORIS): the mode is a setting, this is a provenance, and one
  -- day a third mode may still resolve its rate from the config table.
  ADD COLUMN sumber_rate TEXT
    CHECK (sumber_rate IN ('TABEL_KONFIGURASI', 'KOLEKTIF_HISTORIS')),
  -- Inclusive bounds of the collection history the rate was derived from.
  ADD COLUMN rate_histori_dari DATE,
  ADD COLUMN rate_histori_sampai DATE;

-- No row may exist without a provenance, and this migration refuses to invent
-- one. On every database migrated so far the table is empty (the closing
-- engine that writes it is unimplemented), so this raises nowhere; if it ever
-- does raise, the answer is a data decision by the accounting owner, not a
-- backfill guessed here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM kolektibilitas_snapshot) THEN
    RAISE EXCEPTION
      'TJSL-MIG-0024: kolektibilitas_snapshot sudah berisi baris tanpa sumber_rate. '
      'Migrasi ini menolak menebak asal rate baris lama: tentukan nilainya '
      '(TABEL_KONFIGURASI atau KOLEKTIF_HISTORIS) per periode bersama pemilik akuntansi, '
      'isi lewat migrasi backfill tersendiri, lalu jalankan ulang.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$$;

ALTER TABLE kolektibilitas_snapshot
  ALTER COLUMN sumber_rate SET NOT NULL,
  -- The window exists if and only if the rate was derived from one.
  ADD CONSTRAINT kolektibilitas_snapshot_sumber_rate_ck CHECK (
    (sumber_rate = 'TABEL_KONFIGURASI'
      AND rate_histori_dari IS NULL
      AND rate_histori_sampai IS NULL)
    OR
    (sumber_rate = 'KOLEKTIF_HISTORIS'
      AND rate_histori_dari IS NOT NULL
      AND rate_histori_sampai IS NOT NULL
      AND rate_histori_dari <= rate_histori_sampai)
  );

COMMENT ON COLUMN kolektibilitas_snapshot.sumber_rate IS
  'Asal rate_penyisihan baris ini: TABEL_KONFIGURASI (penyisihan_rate) atau KOLEKTIF_HISTORIS (dihitung dari histori penagihan). Wajib, tanpa default: lihat migrations/0024.';
COMMENT ON COLUMN kolektibilitas_snapshot.rate_histori_dari IS
  'Awal jendela histori penagihan yang dipakai menghitung rate. NULL kalau sumber_rate = TABEL_KONFIGURASI.';
COMMENT ON COLUMN kolektibilitas_snapshot.rate_histori_sampai IS
  'Akhir jendela histori penagihan yang dipakai menghitung rate. NULL kalau sumber_rate = TABEL_KONFIGURASI.';

-- down
-- Restores the pre-0024 shape exactly: the three columns and the constraint
-- that binds them go together, and nothing else in 0011 was touched, so there
-- is nothing else to put back. Dropping the columns drops their CHECKs and
-- their COMMENTs with them; the constraint is named here as well so a rollback
-- is readable without knowing that rule.
ALTER TABLE kolektibilitas_snapshot
  DROP CONSTRAINT IF EXISTS kolektibilitas_snapshot_sumber_rate_ck;
ALTER TABLE kolektibilitas_snapshot
  DROP COLUMN IF EXISTS rate_histori_sampai,
  DROP COLUMN IF EXISTS rate_histori_dari,
  DROP COLUMN IF EXISTS sumber_rate;
