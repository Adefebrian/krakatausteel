-- 0004_konfigurasi_parameter.sql  (spec 4.10 konfigurasi/nomor_urut, spec 5 in full)
--
-- Every business parameter in spec 5 lives here as a ROW, never as a literal
-- in TypeScript (spec rule 3). Three tables instead of one because two of the
-- parameter groups are not scalars:
--
--   konfigurasi              scalar key/value (rate, flag, threshold)
--   kolektibilitas_range     spec 5.1, an ordered set of day ranges
--   penyisihan_rate          spec 5.2, one rate per classification
--   alokasi_setoran_preset   spec 5.4, an ordered list of components
--
-- SCOPE RESOLUTION: bumn_id NULL = platform default (shipped by this
-- migration), bumn_id set = that entity's override. Lookup is
-- "row for this bumn, else the NULL row" -- so a fresh install already has
-- the spec defaults without a seed step, and the config UI writes overrides
-- instead of mutating shipped rows. UNIQUE ... NULLS NOT DISTINCT (Postgres
-- 15+) is what makes "only one global default per key" enforceable.
--
-- EFFECTIVE DATING: kolektibilitas_range and penyisihan_rate carry
-- berlaku_dari because changing a rate must not retroactively change a closed
-- period's penyisihan (spec invariant 14, reproducible reports). The closing
-- engine picks the row with the greatest berlaku_dari <= tanggal_akhir_periode.

-- up

CREATE TABLE kolektibilitas_kelas (
  kode TEXT PRIMARY KEY CHECK (kode IN ('LANCAR', 'KURANG_LANCAR', 'DIRAGUKAN', 'MACET')),
  nama TEXT NOT NULL,
  urutan SMALLINT NOT NULL,
  -- true = counts as a problem loan (drives mitra status BERMASALAH, spec 8.1 step 7)
  is_bermasalah BOOLEAN NOT NULL DEFAULT false,
  aktif BOOLEAN NOT NULL DEFAULT true
);
COMMENT ON TABLE kolektibilitas_kelas IS
  'Fixed reference set of receivable-quality classes. Referenced by kolektibilitas_range, penyisihan_rate and kolektibilitas_snapshot so a typo cannot reach the ledger.';

INSERT INTO kolektibilitas_kelas (kode, nama, urutan, is_bermasalah) VALUES
  ('LANCAR', 'Lancar', 1, false),
  ('KURANG_LANCAR', 'Kurang Lancar', 2, false),
  ('DIRAGUKAN', 'Diragukan', 3, true),
  ('MACET', 'Macet', 4, true);

CREATE TABLE konfigurasi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID REFERENCES bumn(id),
  grup TEXT NOT NULL,
  kunci TEXT NOT NULL,
  nilai TEXT,
  tipe_data TEXT NOT NULL CHECK (tipe_data IN ('STRING', 'NUMBER', 'BOOLEAN', 'JSON', 'DATE', 'ENUM')),
  -- Allowed values when tipe_data = 'ENUM', so the config UI can render a
  -- select instead of a free-text box that can break the engine.
  pilihan_json JSONB,
  deskripsi TEXT,
  -- true = value came from the spec and is still awaiting client accounting
  -- team confirmation (spec 5 preamble + ASSUMPTIONS.md).
  perlu_konfirmasi BOOLEAN NOT NULL DEFAULT true,
  diubah_oleh UUID REFERENCES app_user(id),
  diubah_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX konfigurasi_kunci_uq
  ON konfigurasi (bumn_id, grup, kunci) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
CREATE INDEX konfigurasi_grup_idx ON konfigurasi (grup) WHERE deleted_at IS NULL;

CREATE TABLE kolektibilitas_range (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID REFERENCES bumn(id),
  kelas_kode TEXT NOT NULL REFERENCES kolektibilitas_kelas(kode),
  hari_min INTEGER NOT NULL CHECK (hari_min >= 0),
  -- NULL = unbounded (the MACET tail).
  hari_max INTEGER CHECK (hari_max IS NULL OR hari_max >= hari_min),
  berlaku_dari DATE NOT NULL DEFAULT DATE '1900-01-01',
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX kolektibilitas_range_uq
  ON kolektibilitas_range (bumn_id, kelas_kode, berlaku_dari) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
-- Overlapping day ranges would make classification ambiguous. One
-- unbounded-tail row per (bumn, effective date) keeps the ladder well formed;
-- full non-overlap is checked by the integrity-check tool (spec 9.6) because
-- an exclusion constraint here would block legitimate mid-edit states in the
-- config UI.
CREATE UNIQUE INDEX kolektibilitas_range_tail_uq
  ON kolektibilitas_range (bumn_id, berlaku_dari) NULLS NOT DISTINCT
  WHERE hari_max IS NULL AND deleted_at IS NULL;

INSERT INTO kolektibilitas_range (bumn_id, kelas_kode, hari_min, hari_max) VALUES
  (NULL, 'LANCAR', 0, 30),
  (NULL, 'KURANG_LANCAR', 31, 180),
  (NULL, 'DIRAGUKAN', 181, 270),
  (NULL, 'MACET', 271, NULL);

CREATE TABLE penyisihan_rate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID REFERENCES bumn(id),
  kelas_kode TEXT NOT NULL REFERENCES kolektibilitas_kelas(kode),
  -- 0.250000 = 25 percent. NUMERIC(9,6), never float (spec invariant 7).
  rate NUMERIC(9,6) NOT NULL CHECK (rate >= 0 AND rate <= 1),
  dasar_perhitungan TEXT NOT NULL DEFAULT 'OUTSTANDING_POKOK'
    CHECK (dasar_perhitungan IN ('OUTSTANDING_POKOK', 'OUTSTANDING_POKOK_PLUS_JASA')),
  berlaku_dari DATE NOT NULL DEFAULT DATE '1900-01-01',
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX penyisihan_rate_uq
  ON penyisihan_rate (bumn_id, kelas_kode, berlaku_dari) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;

INSERT INTO penyisihan_rate (bumn_id, kelas_kode, rate) VALUES
  (NULL, 'LANCAR', 0.000000),
  (NULL, 'KURANG_LANCAR', 0.250000),
  (NULL, 'DIRAGUKAN', 0.750000),
  (NULL, 'MACET', 1.000000);

CREATE TABLE alokasi_setoran_preset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kode TEXT NOT NULL,
  komponen TEXT NOT NULL CHECK (komponen IN
    ('TUNGGAKAN_JASA', 'TUNGGAKAN_POKOK', 'JASA_BERJALAN', 'POKOK_BERJALAN', 'KELEBIHAN')),
  urutan SMALLINT NOT NULL CHECK (urutan > 0),
  aktif BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX alokasi_setoran_preset_komponen_uq ON alokasi_setoran_preset (kode, komponen);
CREATE UNIQUE INDEX alokasi_setoran_preset_urutan_uq ON alokasi_setoran_preset (kode, urutan);
COMMENT ON TABLE alokasi_setoran_preset IS
  'Spec 5.4 payment-allocation waterfall as ordered rows. konfigurasi key angsuran.urutan_alokasi_setoran_preset selects which preset the allocation engine walks.';

INSERT INTO alokasi_setoran_preset (kode, komponen, urutan) VALUES
  ('DEFAULT', 'TUNGGAKAN_JASA', 1),
  ('DEFAULT', 'TUNGGAKAN_POKOK', 2),
  ('DEFAULT', 'JASA_BERJALAN', 3),
  ('DEFAULT', 'POKOK_BERJALAN', 4),
  ('DEFAULT', 'KELEBIHAN', 5),
  ('POKOK_DULU', 'TUNGGAKAN_POKOK', 1),
  ('POKOK_DULU', 'TUNGGAKAN_JASA', 2),
  ('POKOK_DULU', 'POKOK_BERJALAN', 3),
  ('POKOK_DULU', 'JASA_BERJALAN', 4),
  ('POKOK_DULU', 'KELEBIHAN', 5);

-- Spec 5 defaults, shipped as global rows (bumn_id NULL).
INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi) VALUES
  (NULL, 'jasa_adm', 'jasa_adm_rate_default', '0.030000', 'NUMBER', NULL, 'Rate jasa administrasi default per tahun (3 persen)'),
  (NULL, 'jasa_adm', 'jasa_adm_metode_default', 'FLAT', 'ENUM', '["FLAT","EFEKTIF","ANUITAS"]', 'Metode perhitungan jasa administrasi default'),
  (NULL, 'jasa_adm', 'jasa_adm_basis_hari', '360', 'ENUM', '["360","365"]', 'Basis hari setahun untuk perhitungan jasa administrasi'),
  (NULL, 'angsuran', 'pembulatan_angsuran', '0', 'ENUM', '["0","100","1000"]', 'Pembulatan angsuran dalam rupiah; selisih dibebankan ke angsuran terakhir'),
  (NULL, 'angsuran', 'urutan_alokasi_setoran_preset', 'DEFAULT', 'STRING', NULL, 'Kode preset di alokasi_setoran_preset yang dipakai engine alokasi setoran'),
  (NULL, 'batasan', 'plafon_min_pumk', '5000000.00', 'NUMBER', NULL, 'Plafon minimum pinjaman PUMK'),
  (NULL, 'batasan', 'plafon_max_pumk', '250000000.00', 'NUMBER', NULL, 'Plafon maksimum pinjaman PUMK'),
  (NULL, 'batasan', 'tenor_min_bulan', '6', 'NUMBER', NULL, 'Tenor minimum dalam bulan'),
  (NULL, 'batasan', 'tenor_max_bulan', '36', 'NUMBER', NULL, 'Tenor maksimum dalam bulan'),
  (NULL, 'batasan', 'grace_period_max_bulan', '6', 'NUMBER', NULL, 'Grace period maksimum dalam bulan'),
  (NULL, 'batasan', 'wajib_jaminan_di_atas_plafon', '50000000.00', 'NUMBER', NULL, 'Ambang plafon yang mewajibkan jaminan'),
  (NULL, 'batasan', 'maks_pinjaman_aktif_per_mitra', '1', 'NUMBER', NULL, 'Jumlah maksimum akad aktif per mitra binaan'),
  (NULL, 'batasan', 'skor_survey_minimum_lolos', '70', 'NUMBER', NULL, 'Skor survey minimum agar proposal bisa direkomendasikan'),
  (NULL, 'akuntansi', 'metode_pengakuan_jasa_adm', 'ACCRUAL', 'ENUM', '["CASH_BASIS","ACCRUAL"]', 'Metode pengakuan pendapatan jasa administrasi'),
  (NULL, 'akuntansi', 'akrual_hanya_untuk_kolektibilitas', '["LANCAR"]', 'JSON', NULL, 'Kelas kolektibilitas yang jasa administrasinya diakrual'),
  (NULL, 'akuntansi', 'jasa_grace_period', 'TIDAK_DIHITUNG', 'ENUM', '["TIDAK_DIHITUNG","DIHITUNG_DITANGGUHKAN","DIHITUNG_DIBAYAR"]', 'Perlakuan jasa administrasi selama grace period; lihat ASSUMPTIONS.md A-05'),
  (NULL, 'akuntansi', 'tahun_buku_mulai_bulan', '1', 'NUMBER', NULL, 'Bulan awal tahun buku'),
  (NULL, 'akuntansi', 'izinkan_reopen_periode', 'true', 'BOOLEAN', NULL, 'Boleh reopen periode CLOSED; wajib role Admin Pusat + alasan tertulis'),
  (NULL, 'akuntansi', 'dasar_perhitungan_penyisihan', 'OUTSTANDING_POKOK', 'ENUM', '["OUTSTANDING_POKOK","OUTSTANDING_POKOK_PLUS_JASA"]', 'Dasar perhitungan nilai penyisihan'),
  (NULL, 'kolektibilitas', 'tandai_mitra_bermasalah_saat_macet', 'true', 'BOOLEAN', NULL, 'Set status mitra BERMASALAH saat kolektibilitas masuk kelas bermasalah'),
  (NULL, 'kas', 'izinkan_saldo_kas_negatif', 'false', 'BOOLEAN', NULL, 'Saldo kas negatif hanya warning saat closing (spec 8.4 butir 8), bukan blocker');

CREATE TABLE nomor_urut (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  -- NULL = a pusat-level (entity-wide) series rather than a per-branch one.
  cabang_id UUID REFERENCES cabang(id),
  jenis_dokumen TEXT NOT NULL,
  tahun SMALLINT NOT NULL,
  -- NULL = yearly series (no monthly reset).
  bulan SMALLINT CHECK (bulan IS NULL OR bulan BETWEEN 1 AND 12),
  urutan_terakhir INTEGER NOT NULL DEFAULT 0 CHECK (urutan_terakhir >= 0),
  format_template TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
-- The counter row IS the lock: the generator does
--   INSERT ... ON CONFLICT (this index) DO UPDATE SET urutan_terakhir = urutan_terakhir + 1 RETURNING urutan_terakhir
-- which is atomic and race-free. NULLS NOT DISTINCT is required, otherwise
-- two rows with cabang_id NULL (pusat series) would both be "unique".
CREATE UNIQUE INDEX nomor_urut_seri_uq
  ON nomor_urut (bumn_id, cabang_id, jenis_dokumen, tahun, bulan) NULLS NOT DISTINCT;

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('konfigurasi'), ('kolektibilitas_range'), ('penyisihan_rate'), ('nomor_urut')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('konfigurasi'), ('kolektibilitas_range'), ('penyisihan_rate'), ('nomor_urut')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('konfigurasi'), ('kolektibilitas_range'), ('penyisihan_rate'), ('nomor_urut')
) AS x(t);

-- down
DROP TABLE IF EXISTS nomor_urut;
DROP TABLE IF EXISTS alokasi_setoran_preset;
DROP TABLE IF EXISTS penyisihan_rate;
DROP TABLE IF EXISTS kolektibilitas_range;
DROP TABLE IF EXISTS konfigurasi;
DROP TABLE IF EXISTS kolektibilitas_kelas;
