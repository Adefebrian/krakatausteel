-- 0006_mitra.sql  (spec 4.3, plus cluster membership history)
--
-- Mitra Binaan (the UMK borrower) and its documents. Also closes the
-- cluster <-> mitra circular reference left open in 0003, and adds
-- cluster_anggota: cluster membership is dated history, not a single column,
-- because "performa kolektibilitas per cluster" (spec 9.1) for a past period
-- must use the members the cluster had in that period.

-- up

CREATE TABLE mitra (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  kode_mitra TEXT NOT NULL,
  nama_lengkap TEXT NOT NULL,
  nik TEXT,
  npwp TEXT,
  jenis_kelamin TEXT CHECK (jenis_kelamin IN ('L', 'P')),
  tanggal_lahir DATE,
  alamat TEXT,
  kelurahan TEXT,
  kecamatan TEXT,
  kota_id UUID REFERENCES kota(id),
  telepon TEXT,
  email TEXT,
  nama_usaha TEXT,
  sektor_id UUID REFERENCES sektor_pumk(id),
  bidang_usaha TEXT,
  tahun_mulai_usaha SMALLINT CHECK (tahun_mulai_usaha IS NULL OR tahun_mulai_usaha BETWEEN 1900 AND 2200),
  jumlah_tenaga_kerja INTEGER CHECK (jumlah_tenaga_kerja IS NULL OR jumlah_tenaga_kerja >= 0),
  omzet_bulanan NUMERIC(20,2) CHECK (omzet_bulanan IS NULL OR omzet_bulanan >= 0),
  aset_usaha NUMERIC(20,2) CHECK (aset_usaha IS NULL OR aset_usaha >= 0),
  -- Repeat borrower carried over from the legacy system; kode_mitra_lama is
  -- the legacy identifier kept for reconciliation against old reports.
  is_mitra_lama BOOLEAN NOT NULL DEFAULT false,
  kode_mitra_lama TEXT,
  cluster_id UUID REFERENCES cluster(id),
  status TEXT NOT NULL DEFAULT 'CALON'
    CHECK (status IN ('CALON', 'AKTIF', 'LUNAS', 'BERMASALAH', 'BLACKLIST')),
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX mitra_kode_uq ON mitra (kode_mitra) WHERE deleted_at IS NULL;
-- NIK is the national identity number: unique per person where present. This
-- is also what enforces "maks_pinjaman_aktif_per_mitra" being meaningful --
-- one person cannot become two mitra rows to get two loans.
CREATE UNIQUE INDEX mitra_nik_uq ON mitra (nik) WHERE nik IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX mitra_cabang_idx ON mitra (cabang_id) WHERE deleted_at IS NULL;
CREATE INDEX mitra_sektor_idx ON mitra (sektor_id) WHERE deleted_at IS NULL;
CREATE INDEX mitra_kota_idx ON mitra (kota_id) WHERE deleted_at IS NULL;
CREATE INDEX mitra_cluster_idx ON mitra (cluster_id) WHERE cluster_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX mitra_status_idx ON mitra (cabang_id, status) WHERE deleted_at IS NULL;
-- Laporan Demografi Mitra Binaan (spec 10.4 #27) searches by name; trigram
-- would need pg_trgm, so a plain lower(nama) index covers prefix search only.
CREATE INDEX mitra_nama_idx ON mitra (lower(nama_lengkap));

ALTER TABLE cluster
  ADD CONSTRAINT cluster_ketua_mitra_fk FOREIGN KEY (ketua_mitra_id) REFERENCES mitra(id);

CREATE TABLE cluster_anggota (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id UUID NOT NULL REFERENCES cluster(id),
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  tanggal_masuk DATE NOT NULL,
  tanggal_keluar DATE,
  alasan_keluar TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT cluster_anggota_tanggal_ck CHECK (tanggal_keluar IS NULL OR tanggal_keluar >= tanggal_masuk)
);
-- A mitra belongs to at most one cluster at a time (mitra.cluster_id is the
-- denormalised "current" pointer; this table is the history).
CREATE UNIQUE INDEX cluster_anggota_aktif_uq
  ON cluster_anggota (mitra_id) WHERE tanggal_keluar IS NULL AND deleted_at IS NULL;
CREATE INDEX cluster_anggota_cluster_idx ON cluster_anggota (cluster_id) WHERE deleted_at IS NULL;

CREATE TABLE mitra_dokumen (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  jenis TEXT NOT NULL CHECK (jenis IN
    ('KTP', 'KK', 'NPWP', 'SIUP', 'NIB', 'FOTO_USAHA', 'SURAT_KETERANGAN_USAHA', 'LAINNYA')),
  nama_file TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  ukuran BIGINT CHECK (ukuran IS NULL OR ukuran >= 0),
  checksum TEXT,
  -- Output of the AI document-extraction feature (spec 12); kept as the raw
  -- provider response so a re-run can be compared against the old one.
  hasil_ekstraksi_json JSONB,
  -- Spec names uploaded_by/uploaded_at; those are exactly created_by/created_at
  -- from the shared audit block, so they are not duplicated here.
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX mitra_dokumen_mitra_idx ON mitra_dokumen (mitra_id) WHERE deleted_at IS NULL;

CREATE TABLE portal_akun_mitra (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX portal_akun_mitra_email_uq ON portal_akun_mitra (lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX portal_akun_mitra_mitra_uq ON portal_akun_mitra (mitra_id) WHERE deleted_at IS NULL;

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('mitra'), ('cluster_anggota'), ('mitra_dokumen'), ('portal_akun_mitra')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('mitra'), ('cluster_anggota'), ('mitra_dokumen'), ('portal_akun_mitra')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('mitra'), ('cluster_anggota'), ('mitra_dokumen'), ('portal_akun_mitra')
) AS x(t);

-- down
DROP TABLE IF EXISTS portal_akun_mitra;
DROP TABLE IF EXISTS mitra_dokumen;
DROP TABLE IF EXISTS cluster_anggota;
ALTER TABLE cluster DROP CONSTRAINT IF EXISTS cluster_ketua_mitra_fk;
DROP TABLE IF EXISTS mitra;
