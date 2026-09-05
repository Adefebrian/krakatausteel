-- 0033_impor_saldo_awal.sql  (spec 9.6 "Import Saldo Awal", ADR 0006)
--
-- The GO-LIVE MIGRATION TOOL's two schema needs, and nothing else. ADR 0006
-- already shipped `saldo_awal_batch` (0005), `akun_saldo_awal` (0005) and
-- `akad_saldo_awal` (0008) precisely so the tool would need no schema change
-- when it landed. Two things it could not have foreseen:
--
-- 1. `impor_berkas.jenis` was written CHECK (jenis IN ('MITRA','ANGSURAN'))
--    in 0031, so the third import kind cannot be recorded at all. The file
--    row is what makes every imported line attributable (rule 4 of
--    modules/impor/contract.ts), so widening this check is not cosmetic: an
--    opening-balance import that could not write `impor_berkas` would be an
--    import with no provenance and no `impor_berkas_checksum_uq` protection.
--
-- 2. AN OPENING BALANCE MAY BE POSTED EXACTLY ONCE PER SCOPE, EVER, AND THAT
--    HAS TO BE A DATABASE FACT.
--
--    The checksum index refuses the same BYTES twice. It does not refuse the
--    same BALANCES re-uploaded from a re-saved .xlsx (a zip carries
--    timestamps, so the bytes differ), from a CSV with the rows in a
--    different order, or under a different filename with one cell reformatted.
--    A nervous operator who re-runs the migration "just to be sure" would then
--    double every opening balance, and the person who finds out is the
--    accountant, weeks later, with a trial balance that is exactly twice what
--    it should be on every line.
--
--    So the refusal is stated where it cannot be raced or rephrased: ONE
--    DIPOSTING batch per (bumn, cabang). The engine reads it first and answers
--    with a readable refusal naming the earlier batch; this index is what
--    makes the answer true even when two requests arrive at once.
--
--    `coalesce(cabang_id, ...)` because 0005 makes `cabang_id` nullable to
--    mean "one batch covering all branches" (ADR 0006's open point). NULL is
--    not distinct-from-NULL in a unique index, so without the coalesce two
--    consolidated batches would collide by accident rather than by rule; with
--    it, "consolidated" is one more scope value and the rule is the same rule.
--    The nil UUID is used as that sentinel and is never a real `cabang.id`
--    (gen_random_uuid() cannot produce it: it sets the version and variant
--    bits).
--
-- WHAT IS DELIBERATELY NOT HERE: no new column recording "this batch came
-- from that file". The link already exists and is the same one every other
-- import uses -- `impor_baris (berkas_id, nomor_baris, entitas, entitas_id)`
-- with `entitas = 'saldo_awal_batch'` -- and inventing a second, private link
-- for one import kind is how two provenance stories start disagreeing.

-- up

ALTER TABLE impor_berkas DROP CONSTRAINT impor_berkas_jenis_check;
ALTER TABLE impor_berkas
  ADD CONSTRAINT impor_berkas_jenis_check
  CHECK (jenis IN ('MITRA', 'ANGSURAN', 'SALDO_AWAL'));

CREATE UNIQUE INDEX saldo_awal_batch_diposting_uq
  ON saldo_awal_batch (
    bumn_id,
    coalesce(cabang_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'DIPOSTING' AND deleted_at IS NULL;

COMMENT ON INDEX saldo_awal_batch_diposting_uq IS
  'Opening balances are posted exactly once per (bumn, cabang), ever. The checksum index on impor_berkas refuses the same BYTES twice; this refuses the same BALANCES arriving as different bytes (re-saved .xlsx, reordered rows, renamed file), which is the shape a nervous operator actually produces. A consolidated batch (cabang_id NULL) is one more scope value, hence the coalesce onto the nil UUID.';

-- down
DROP INDEX IF EXISTS saldo_awal_batch_diposting_uq;
ALTER TABLE impor_berkas DROP CONSTRAINT impor_berkas_jenis_check;
ALTER TABLE impor_berkas
  ADD CONSTRAINT impor_berkas_jenis_check
  CHECK (jenis IN ('MITRA', 'ANGSURAN'));
