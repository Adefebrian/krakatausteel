-- 0009_nonpumk.sql  (spec 4.5, spec 9.2)
--
-- Non PUMK: grants. No receivable, no schedule; the accountability trail is
-- the LPJ instead. Reuses the segregation-of-duties trigger functions defined
-- in 0008 (tjsl_cek_reviewer_bukan_maker / tjsl_cek_approver_bukan_checker),
-- parameterised with this module's table names.
--
-- Two money rules from spec 9.2 are enforced here as deferred constraint
-- triggers rather than left to the service layer, because both are the kind of
-- arithmetic that a partial UI flow silently breaks:
--   SUM(nonpumk_penyaluran.jumlah) <= proposal.jumlah_disetujui
--   LPJ realisasi + sisa dikembalikan = total actually disbursed

-- up

CREATE TABLE nonpumk_proposal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  no_proposal TEXT NOT NULL,
  tanggal_proposal DATE NOT NULL,
  tanggal_daftar DATE,
  -- The applicant is an institution or a person, not a mitra binaan: Non PUMK
  -- has no borrower master, so identity lives on the proposal itself.
  nama_pemohon TEXT NOT NULL,
  atas_nama TEXT,
  alamat TEXT,
  kelurahan TEXT,
  kecamatan TEXT,
  kota_id UUID REFERENCES kota(id),
  telepon TEXT,
  email TEXT,
  bidang_id UUID NOT NULL REFERENCES bidang_non_pumk(id),
  judul_program TEXT NOT NULL,
  deskripsi_program TEXT,
  jumlah_diajukan NUMERIC(20,2) NOT NULL CHECK (jumlah_diajukan > 0),
  -- Set from the approval decision; the disbursement ceiling. Denormalised on
  -- purpose so the "total penyaluran <= approved" trigger is a single lookup.
  jumlah_disetujui NUMERIC(20,2) CHECK (jumlah_disetujui IS NULL OR jumlah_disetujui > 0),
  penerima_manfaat_estimasi INTEGER CHECK (penerima_manfaat_estimasi IS NULL OR penerima_manfaat_estimasi >= 0),
  sumber_pengajuan TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (sumber_pengajuan IN ('INTERNAL', 'PORTAL_ONLINE')),
  portal_submission_id UUID,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PENILAIAN', 'REVIEW_CHECKER', 'MENUNGGU_PERSETUJUAN', 'DISETUJUI',
    'DISALURKAN', 'MENUNGGU_LPJ', 'LPJ_DIAJUKAN', 'SELESAI',
    'TIDAK_DIREKOMENDASIKAN', 'DITOLAK', 'LPJ_DITOLAK')),
  current_step SMALLINT NOT NULL DEFAULT 1 CHECK (current_step >= 1),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX nonpumk_proposal_no_uq ON nonpumk_proposal (no_proposal) WHERE deleted_at IS NULL;
CREATE INDEX nonpumk_proposal_cabang_status_idx ON nonpumk_proposal (cabang_id, status) WHERE deleted_at IS NULL;
CREATE INDEX nonpumk_proposal_bidang_idx ON nonpumk_proposal (bidang_id) WHERE deleted_at IS NULL;
CREATE INDEX nonpumk_proposal_tanggal_idx ON nonpumk_proposal (tanggal_proposal);
CREATE INDEX nonpumk_proposal_kota_idx ON nonpumk_proposal (kota_id) WHERE deleted_at IS NULL;

-- spec 4.5 lists sdg_ids on the proposal; a real join table instead, because
-- spec 4.1 asks for weighted many-to-many and an array cannot carry a weight
-- or be joined for the SDG report.
CREATE TABLE nonpumk_proposal_sdg (
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  sdg_id UUID NOT NULL REFERENCES sdg(id),
  -- Contribution weight, 0..1. Not forced to sum to 1: a programme can be
  -- partially attributable, and forcing normalisation would be an invented
  -- rule (see ASSUMPTIONS.md A-09).
  bobot NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (bobot > 0 AND bobot <= 1),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, sdg_id)
);
CREATE INDEX nonpumk_proposal_sdg_sdg_idx ON nonpumk_proposal_sdg (sdg_id);

CREATE TABLE nonpumk_proposal_transisi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  status_dari TEXT,
  status_ke TEXT NOT NULL,
  aksi TEXT NOT NULL,
  oleh_user_id UUID REFERENCES app_user(id),
  waktu TIMESTAMPTZ NOT NULL DEFAULT now(),
  catatan TEXT
);
CREATE INDEX nonpumk_proposal_transisi_idx ON nonpumk_proposal_transisi (proposal_id, waktu);

CREATE TABLE nonpumk_penilaian (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  tanggal DATE NOT NULL,
  petugas_karyawan_id UUID REFERENCES karyawan(id),
  -- kelayakan, urgensi, dampak, kesesuaian bidang, kesesuaian SDG
  hasil_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  skor_total NUMERIC(9,6) CHECK (skor_total IS NULL OR skor_total >= 0),
  nilai_rekomendasi NUMERIC(20,2) CHECK (nilai_rekomendasi IS NULL OR nilai_rekomendasi >= 0),
  catatan TEXT,
  lampiran_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX nonpumk_penilaian_proposal_uq ON nonpumk_penilaian (proposal_id) WHERE deleted_at IS NULL;

CREATE TABLE nonpumk_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  reviewer_user_id UUID NOT NULL REFERENCES app_user(id),
  tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
  keputusan TEXT NOT NULL CHECK (keputusan IN ('REKOMENDASI', 'TIDAK_REKOMENDASI', 'MINTA_PERBAIKAN')),
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX nonpumk_review_proposal_idx ON nonpumk_review (proposal_id);

CREATE TABLE nonpumk_approval (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  approver_user_id UUID NOT NULL REFERENCES app_user(id),
  tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
  keputusan TEXT NOT NULL CHECK (keputusan IN ('SETUJU', 'TOLAK', 'KEMBALIKAN')),
  jumlah_disetujui NUMERIC(20,2) CHECK (jumlah_disetujui IS NULL OR jumlah_disetujui > 0),
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT nonpumk_approval_setuju_ck CHECK (keputusan <> 'SETUJU' OR jumlah_disetujui IS NOT NULL)
);
CREATE INDEX nonpumk_approval_proposal_idx ON nonpumk_approval (proposal_id);

CREATE TRIGGER trg_nonpumk_review_10_sod
  BEFORE INSERT OR UPDATE ON nonpumk_review
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_reviewer_bukan_maker('nonpumk_proposal');

CREATE TRIGGER trg_nonpumk_approval_10_sod
  BEFORE INSERT OR UPDATE ON nonpumk_approval
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_approver_bukan_checker('nonpumk_review');

CREATE TABLE nonpumk_penyaluran (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  -- Multi-termin disbursement (spec 9.2): termin 1..n per proposal.
  termin SMALLINT NOT NULL DEFAULT 1 CHECK (termin >= 1),
  tanggal_penyaluran DATE NOT NULL,
  jumlah NUMERIC(20,2) NOT NULL CHECK (jumlah > 0),
  akun_kas_id UUID NOT NULL REFERENCES akun(id),
  akun_beban_id UUID NOT NULL REFERENCES akun(id),
  no_bukti TEXT,
  keterangan TEXT,
  jurnal_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX nonpumk_penyaluran_termin_uq ON nonpumk_penyaluran (proposal_id, termin) WHERE deleted_at IS NULL;
CREATE INDEX nonpumk_penyaluran_tanggal_idx ON nonpumk_penyaluran (tanggal_penyaluran);

CREATE OR REPLACE FUNCTION tjsl_nonpumk_cek_plafon_penyaluran() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_total NUMERIC(20,2);
  v_disetujui NUMERIC(20,2);
BEGIN
  SELECT coalesce(sum(jumlah), 0) INTO v_total
  FROM nonpumk_penyaluran WHERE proposal_id = NEW.proposal_id AND deleted_at IS NULL;

  SELECT jumlah_disetujui INTO v_disetujui FROM nonpumk_proposal WHERE id = NEW.proposal_id;

  IF v_disetujui IS NULL THEN
    RAISE EXCEPTION 'TJSL-NPK-001: proposal % belum punya jumlah_disetujui; penyaluran tidak boleh dicatat', NEW.proposal_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_total > v_disetujui THEN
    RAISE EXCEPTION 'TJSL-NPK-002: total penyaluran (%) melebihi nilai disetujui (%)', v_total, v_disetujui
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_nonpumk_penyaluran_50_plafon
  AFTER INSERT OR UPDATE ON nonpumk_penyaluran
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL)
  EXECUTE FUNCTION tjsl_nonpumk_cek_plafon_penyaluran();

CREATE TABLE nonpumk_lpj (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES nonpumk_proposal(id),
  tanggal_lpj DATE NOT NULL,
  jumlah_realisasi NUMERIC(20,2) NOT NULL CHECK (jumlah_realisasi >= 0),
  jumlah_sisa_dikembalikan NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (jumlah_sisa_dikembalikan >= 0),
  penerima_manfaat_aktual INTEGER CHECK (penerima_manfaat_aktual IS NULL OR penerima_manfaat_aktual >= 0),
  uraian_realisasi TEXT,
  status TEXT NOT NULL DEFAULT 'BELUM'
    CHECK (status IN ('BELUM', 'DIAJUKAN', 'DIVERIFIKASI', 'DITOLAK')),
  verified_by UUID REFERENCES app_user(id),
  verified_at TIMESTAMPTZ,
  lampiran_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  jurnal_id_pengembalian UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT nonpumk_lpj_verifikasi_ck CHECK (
    status <> 'DIVERIFIKASI' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX nonpumk_lpj_proposal_uq ON nonpumk_lpj (proposal_id) WHERE deleted_at IS NULL;
CREATE INDEX nonpumk_lpj_status_idx ON nonpumk_lpj (status) WHERE deleted_at IS NULL;

-- realisasi + sisa dikembalikan must reconcile to what was actually paid out,
-- otherwise the PENGEMBALIAN_SISA_NON_PUMK journal is wrong by construction.
CREATE OR REPLACE FUNCTION tjsl_nonpumk_cek_lpj() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_disalurkan NUMERIC(20,2);
BEGIN
  SELECT coalesce(sum(jumlah), 0) INTO v_disalurkan
  FROM nonpumk_penyaluran WHERE proposal_id = NEW.proposal_id AND deleted_at IS NULL;

  IF NEW.jumlah_realisasi + NEW.jumlah_sisa_dikembalikan <> v_disalurkan THEN
    RAISE EXCEPTION
      'TJSL-NPK-003: realisasi (%) + sisa dikembalikan (%) harus sama dengan total disalurkan (%)',
      NEW.jumlah_realisasi, NEW.jumlah_sisa_dikembalikan, v_disalurkan
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

-- Only checked once the LPJ is actually submitted: a row still in BELUM is a
-- placeholder created at disbursement time and has no numbers yet.
CREATE CONSTRAINT TRIGGER trg_nonpumk_lpj_50_rekonsiliasi
  AFTER INSERT OR UPDATE ON nonpumk_lpj
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status IN ('DIAJUKAN', 'DIVERIFIKASI') AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION tjsl_nonpumk_cek_lpj();

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('nonpumk_proposal'), ('nonpumk_penilaian'), ('nonpumk_review'),
  ('nonpumk_approval'), ('nonpumk_penyaluran'), ('nonpumk_lpj')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('nonpumk_proposal'), ('nonpumk_penilaian'), ('nonpumk_review'),
  ('nonpumk_approval'), ('nonpumk_penyaluran'), ('nonpumk_lpj')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('nonpumk_proposal'), ('nonpumk_penilaian'), ('nonpumk_review'),
  ('nonpumk_approval'), ('nonpumk_penyaluran'), ('nonpumk_lpj')
) AS x(t);

-- down
DROP TABLE IF EXISTS nonpumk_lpj;
DROP FUNCTION IF EXISTS tjsl_nonpumk_cek_lpj() CASCADE;
DROP TABLE IF EXISTS nonpumk_penyaluran;
DROP FUNCTION IF EXISTS tjsl_nonpumk_cek_plafon_penyaluran() CASCADE;
DROP TABLE IF EXISTS nonpumk_approval;
DROP TABLE IF EXISTS nonpumk_review;
DROP TABLE IF EXISTS nonpumk_penilaian;
DROP TABLE IF EXISTS nonpumk_proposal_transisi;
DROP TABLE IF EXISTS nonpumk_proposal_sdg;
DROP TABLE IF EXISTS nonpumk_proposal;
