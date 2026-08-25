-- 0022_parameter_non_pumk.sql
--
-- The four Non PUMK parameters that spec 5.5 never named.
--
-- THE GAP. Spec 5.5 "Batasan Program" lists PUMK limits only (plafon, tenor,
-- grace period, jaminan, akad aktif, skor survey). Spec 9.2 nevertheless makes
-- the Non PUMK engine enforce an amount range on the proposal, a pass mark on
-- the penilaian, and an LPJ deadline that drives the "terlambat" monitoring.
-- Those are policy numbers, and spec rule 3 forbids a policy number living in
-- TypeScript, so the engine reads `konfigurasi` and fails closed with
-- KONFIGURASI_TIDAK_ADA when the row is absent. On every database migrated so
-- far the row IS absent: migrations/0004 ships 21 global rows and not one of
-- them is Non PUMK. So the whole Non PUMK path was unreachable on a fresh
-- install, by construction.
--
-- A NEW MIGRATION, NOT AN EDIT TO 0004. 0004 has been applied everywhere;
-- appending to its INSERT would be a no-op on every existing database and
-- would silently make a fresh install differ from a migrated one. A config row
-- is DATA, and new data needs a new migration. Same ruling, same wording, as
-- migrations/0019 when it added angsuran.hari_jatuh_tempo_tetap.
--
-- EVERY VALUE HERE IS INVENTED, AND IS LABELLED AS SUCH. The spec gives no Non
-- PUMK limit of any kind, so these are not "the spec's defaults awaiting
-- confirmation" the way 0004's rows are; they are our proposal, recorded in
-- ASSUMPTIONS.md A-41 to A-44 as assumptions requiring the client's written
-- confirmation. They ship with perlu_konfirmasi = true (the column's default)
-- so the Konfigurasi screen shows them as unconfirmed, and they are global
-- rows (bumn_id NULL), so an entity that decides differently writes an
-- override instead of anyone editing a shipped row.
--
-- The reasoning, in one line each, because a number with no reason is a number
-- nobody dares to change:
--
--   nilai_min_non_pumk  Rp 1.000.000. A bantuan smaller than this costs more
--                       in proposal, penilaian, review, approval, penyaluran
--                       and LPJ than it hands over.
--   nilai_max_non_pumk  Rp 500.000.000. Two times the PUMK ceiling of
--                       Rp 250.000.000 that spec 5.5 DOES give: Non PUMK is a
--                       grant to an institution for a programme, not a loan to
--                       one micro business, so the same ceiling would be too
--                       low, while an unbounded one means no ceiling at all.
--   skor_penilaian_minimum_lolos_non_pumk  70, the same pass mark spec 5.5
--                       sets for the PUMK survey (skor_survey_minimum_lolos).
--                       One programme's assessment scale should not be
--                       stricter than the other's by accident; if the client
--                       wants them to differ, that is now a row to change.
--   batas_hari_lpj_non_pumk  60 days after the last penyaluran. Spec 9.2's own
--                       ageing buckets are 30/60/90, so the deadline should be
--                       one of them: at 30 a programme running over a quarter
--                       is late before it has finished, and at 90 the first
--                       two buckets can never hold a late LPJ, which makes the
--                       monitoring dashboard the spec asks for light up only
--                       at the very last bucket.
--
-- NO NEW SCHEMA AND NO NEW CONSTRAINT. This migration inserts four rows into a
-- table 0004 already created, and they are already governed by
-- konfigurasi_kunci_uq (one global row per grup+kunci, NULLS NOT DISTINCT) and
-- by the tipe_data CHECK. The handover pastes psql output for both refusing
-- bad data on exactly these rows.

-- up

INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi) VALUES
  (NULL, 'batasan', 'nilai_min_non_pumk', '1000000.00', 'NUMBER', NULL,
   'Nilai bantuan Non PUMK minimum yang boleh diajukan. TIDAK ADA di spesifikasi Bagian 5.5; lihat ASSUMPTIONS.md A-41'),
  (NULL, 'batasan', 'nilai_max_non_pumk', '500000000.00', 'NUMBER', NULL,
   'Nilai bantuan Non PUMK maksimum yang boleh diajukan. TIDAK ADA di spesifikasi Bagian 5.5; lihat ASSUMPTIONS.md A-42'),
  (NULL, 'batasan', 'skor_penilaian_minimum_lolos_non_pumk', '70', 'NUMBER', NULL,
   'Skor penilaian minimum agar proposal Non PUMK bisa direkomendasikan. TIDAK ADA di spesifikasi Bagian 5.5; lihat ASSUMPTIONS.md A-43'),
  (NULL, 'batasan', 'batas_hari_lpj_non_pumk', '60', 'NUMBER', NULL,
   'Batas hari penyampaian LPJ dihitung dari penyaluran terakhir; menentukan flag terlambat di monitoring Bagian 9.2. TIDAK ADA di spesifikasi Bagian 5.5; lihat ASSUMPTIONS.md A-44');

-- down
-- Removes exactly the four rows this migration shipped, and only the GLOBAL
-- ones: an entity's override (bumn_id NOT NULL) was written by an operator
-- through the Konfigurasi screen and is not this migration's to delete. Rolling
-- back therefore restores the pre-0022 state exactly: no global Non PUMK
-- parameter, and the engine fails closed again with KONFIGURASI_TIDAK_ADA.
DELETE FROM konfigurasi
 WHERE bumn_id IS NULL
   AND grup = 'batasan'
   AND kunci IN ('nilai_min_non_pumk', 'nilai_max_non_pumk',
                 'skor_penilaian_minimum_lolos_non_pumk', 'batas_hari_lpj_non_pumk');
