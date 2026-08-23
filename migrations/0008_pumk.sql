-- 0008_pumk.sql  (spec 4.4, spec 9.1)
--
-- Pendanaan UMK: proposal -> survey -> review -> approval -> akad -> jadwal
-- angsuran -> pencairan -> angsuran, plus reschedule, pengakhiran/hapus buku,
-- kelebihan pembayaran, collection follow-up and the legacy opening
-- outstanding table.
--
-- INVARIANTS ENFORCED HERE (spec 3 and spec 2):
--   #8  a generated schedule is immutable: physical DELETE is blocked, and an
--       UPDATE of any priced column (pokok, jasa_adm, total, due date,
--       angsuran_ke, versi) is rejected. Changes go through a new versi via
--       pumk_reschedule; exactly one versi per akad may be is_active_version
--       (partial unique index).
--   #9  SUM(pokok) of version 1 equals akad.pokok_pinjaman, as a DEFERRED
--       constraint trigger so a schedule can be inserted row by row inside one
--       transaction and is only checked at COMMIT.
--   #10 akad.outstanding_pokok / outstanding_jasa CHECK >= 0. Overpayment goes
--       to pumk_kelebihan, never to a negative receivable.
--   spec 2.1 maker <> checker and 2.2 checker <> approver, as triggers, so the
--       rule holds for any caller including SQL scripts and the seeder.
--
-- Money columns are NUMERIC(20,2); rates NUMERIC(9,6) (0.030000 = 3 percent).

-- up

CREATE TABLE pumk_proposal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  no_proposal TEXT NOT NULL,
  tanggal_proposal DATE NOT NULL,
  tanggal_daftar DATE,
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  sektor_id UUID REFERENCES sektor_pumk(id),
  jumlah_diajukan NUMERIC(20,2) NOT NULL CHECK (jumlah_diajukan > 0),
  tenor_diajukan SMALLINT NOT NULL CHECK (tenor_diajukan > 0),
  tujuan_penggunaan TEXT,
  sumber_pengajuan TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (sumber_pengajuan IN ('INTERNAL', 'PORTAL_ONLINE')),
  -- FK added in 0011 (portal_submission is defined there).
  portal_submission_id UUID,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'SURVEY_PENDING', 'SURVEY_SELESAI', 'REVIEW_CHECKER',
    'MENUNGGU_PERSETUJUAN', 'DISETUJUI', 'AKAD_DIBUAT', 'JADWAL_SIAP',
    'DICAIRKAN', 'TIDAK_DIREKOMENDASIKAN', 'DITOLAK')),
  current_step SMALLINT NOT NULL DEFAULT 1 CHECK (current_step >= 1),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX pumk_proposal_no_uq ON pumk_proposal (no_proposal) WHERE deleted_at IS NULL;
CREATE INDEX pumk_proposal_cabang_status_idx ON pumk_proposal (cabang_id, status) WHERE deleted_at IS NULL;
CREATE INDEX pumk_proposal_tanggal_idx ON pumk_proposal (tanggal_proposal);
CREATE INDEX pumk_proposal_mitra_idx ON pumk_proposal (mitra_id) WHERE deleted_at IS NULL;
CREATE INDEX pumk_proposal_sektor_idx ON pumk_proposal (sektor_id) WHERE deleted_at IS NULL;
CREATE INDEX pumk_proposal_sumber_idx ON pumk_proposal (cabang_id, sumber_pengajuan) WHERE deleted_at IS NULL;

-- Not in spec 4.4 by name, but spec 9.1 requires a per-transition timeline
-- ("catat siapa, kapan, catatan apa"). Append-only.
CREATE TABLE pumk_proposal_transisi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES pumk_proposal(id),
  status_dari TEXT,
  status_ke TEXT NOT NULL,
  aksi TEXT NOT NULL,
  oleh_user_id UUID REFERENCES app_user(id),
  waktu TIMESTAMPTZ NOT NULL DEFAULT now(),
  catatan TEXT
);
CREATE INDEX pumk_proposal_transisi_idx ON pumk_proposal_transisi (proposal_id, waktu);

CREATE TABLE pumk_survey (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES pumk_proposal(id),
  tanggal_survey DATE NOT NULL,
  petugas_karyawan_id UUID REFERENCES karyawan(id),
  -- Per-aspect scoring (karakter, kapasitas usaha, kondisi tempat usaha,
  -- agunan, riwayat pinjaman). JSONB because the scoring sheet is expected to
  -- change per client without a migration; skor_total is the derived number
  -- the approval flow gates on.
  hasil_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  skor_total NUMERIC(9,6) CHECK (skor_total IS NULL OR skor_total >= 0),
  plafon_rekomendasi NUMERIC(20,2) CHECK (plafon_rekomendasi IS NULL OR plafon_rekomendasi >= 0),
  tenor_rekomendasi SMALLINT CHECK (tenor_rekomendasi IS NULL OR tenor_rekomendasi > 0),
  catatan TEXT,
  lampiran_foto_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX pumk_survey_proposal_uq ON pumk_survey (proposal_id) WHERE deleted_at IS NULL;

CREATE TABLE pumk_jaminan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES pumk_proposal(id),
  jenis TEXT NOT NULL CHECK (jenis IN
    ('BPKB', 'SHM', 'SHGB', 'AJB', 'DEPOSITO', 'TANPA_JAMINAN', 'LAINNYA')),
  deskripsi TEXT,
  nilai_taksasi NUMERIC(20,2) CHECK (nilai_taksasi IS NULL OR nilai_taksasi >= 0),
  nomor_dokumen TEXT,
  atas_nama TEXT,
  lokasi TEXT,
  status_fisik TEXT NOT NULL DEFAULT 'DITERIMA'
    CHECK (status_fisik IN ('DITERIMA', 'DIKEMBALIKAN')),
  tanggal_terima DATE,
  tanggal_kembali DATE,
  path_dokumen TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pumk_jaminan_kembali_ck CHECK (
    status_fisik <> 'DIKEMBALIKAN' OR tanggal_kembali IS NOT NULL
  )
);
CREATE INDEX pumk_jaminan_proposal_idx ON pumk_jaminan (proposal_id) WHERE deleted_at IS NULL;

CREATE TABLE pumk_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES pumk_proposal(id),
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
CREATE INDEX pumk_review_proposal_idx ON pumk_review (proposal_id);

CREATE TABLE pumk_approval (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES pumk_proposal(id),
  approver_user_id UUID NOT NULL REFERENCES app_user(id),
  tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
  keputusan TEXT NOT NULL CHECK (keputusan IN ('SETUJU', 'TOLAK', 'KEMBALIKAN')),
  -- The approver may cut the amount or the tenor (spec 9.1); these are what
  -- the akad must be built from, not the proposed figures.
  plafon_disetujui NUMERIC(20,2) CHECK (plafon_disetujui IS NULL OR plafon_disetujui > 0),
  tenor_disetujui SMALLINT CHECK (tenor_disetujui IS NULL OR tenor_disetujui > 0),
  jasa_adm_rate NUMERIC(9,6) CHECK (jasa_adm_rate IS NULL OR jasa_adm_rate >= 0),
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pumk_approval_setuju_ck CHECK (
    keputusan <> 'SETUJU' OR (plafon_disetujui IS NOT NULL AND tenor_disetujui IS NOT NULL)
  )
);
CREATE INDEX pumk_approval_proposal_idx ON pumk_approval (proposal_id);

-- Segregation of duties, spec 2 rules 1 and 2. Generic over the proposal /
-- review table names so 0009 reuses them for Non PUMK.
CREATE OR REPLACE FUNCTION tjsl_cek_reviewer_bukan_maker() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_maker UUID;
BEGIN
  EXECUTE format('SELECT created_by FROM %I WHERE id = $1', TG_ARGV[0])
    INTO v_maker USING NEW.proposal_id;
  IF v_maker IS NOT NULL AND v_maker = NEW.reviewer_user_id THEN
    RAISE EXCEPTION
      'TJSL-SOD-001: user % adalah maker proposal ini dan tidak boleh menjadi checker', NEW.reviewer_user_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION tjsl_cek_approver_bukan_checker() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_ada INTEGER;
BEGIN
  EXECUTE format(
    'SELECT count(*) FROM %I WHERE proposal_id = $1 AND reviewer_user_id = $2 AND deleted_at IS NULL',
    TG_ARGV[0])
    INTO v_ada USING NEW.proposal_id, NEW.approver_user_id;
  IF v_ada > 0 THEN
    RAISE EXCEPTION
      'TJSL-SOD-002: user % sudah menjadi checker proposal ini dan tidak boleh menjadi approver', NEW.approver_user_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_pumk_review_10_sod
  BEFORE INSERT OR UPDATE ON pumk_review
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_reviewer_bukan_maker('pumk_proposal');

CREATE TRIGGER trg_pumk_approval_10_sod
  BEFORE INSERT OR UPDATE ON pumk_approval
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_approver_bukan_checker('pumk_review');

CREATE TABLE pumk_akad (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES pumk_proposal(id),
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  -- Denormalised from proposal for branch-scoped reporting (every PUMK report
  -- filters by cabang); kept in step by trg_pumk_akad_10_cabang below.
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  no_akad TEXT NOT NULL,
  tanggal_akad DATE NOT NULL,
  pokok_pinjaman NUMERIC(20,2) NOT NULL CHECK (pokok_pinjaman > 0),
  jasa_adm_rate NUMERIC(9,6) NOT NULL CHECK (jasa_adm_rate >= 0),
  metode_perhitungan TEXT NOT NULL DEFAULT 'FLAT'
    CHECK (metode_perhitungan IN ('FLAT', 'EFEKTIF', 'ANUITAS')),
  tenor_bulan SMALLINT NOT NULL CHECK (tenor_bulan > 0),
  grace_period_bulan SMALLINT NOT NULL DEFAULT 0 CHECK (grace_period_bulan >= 0),
  tanggal_mulai_angsuran DATE NOT NULL,
  tanggal_jatuh_tempo_akhir DATE NOT NULL,
  -- BELUM_CAIR is not in spec 4.4's list; it is the state between "akad
  -- signed" and "pencairan posted", where outstanding is still zero. Without
  -- it, an unfunded akad would have to sit in AKTIF and pollute the
  -- sub-ledger reconciliation in spec 8.4 #10. See ASSUMPTIONS.md A-08.
  status TEXT NOT NULL DEFAULT 'BELUM_CAIR' CHECK (status IN
    ('BELUM_CAIR', 'AKTIF', 'LUNAS', 'RESCHEDULED', 'MACET', 'HAPUS_BUKU')),
  outstanding_pokok NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (outstanding_pokok >= 0),
  outstanding_jasa NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (outstanding_jasa >= 0),
  tanggal_lunas DATE,
  path_dokumen_akad TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pumk_akad_tanggal_ck CHECK (tanggal_jatuh_tempo_akhir >= tanggal_mulai_angsuran),
  CONSTRAINT pumk_akad_outstanding_pokok_max_ck CHECK (outstanding_pokok <= pokok_pinjaman),
  CONSTRAINT pumk_akad_lunas_ck CHECK (status <> 'LUNAS' OR tanggal_lunas IS NOT NULL)
);
CREATE UNIQUE INDEX pumk_akad_no_uq ON pumk_akad (no_akad) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX pumk_akad_proposal_uq ON pumk_akad (proposal_id) WHERE deleted_at IS NULL;
CREATE INDEX pumk_akad_mitra_idx ON pumk_akad (mitra_id) WHERE deleted_at IS NULL;
CREATE INDEX pumk_akad_cabang_status_idx ON pumk_akad (cabang_id, status) WHERE deleted_at IS NULL;
CREATE INDEX pumk_akad_tanggal_idx ON pumk_akad (tanggal_akad);
-- Spec 8.4 #10 reconciliation and spec 8.1 step 1 both scan "akad with an
-- outstanding balance"; this is the driving index for both.
CREATE INDEX pumk_akad_outstanding_idx ON pumk_akad (cabang_id, status, outstanding_pokok)
  WHERE deleted_at IS NULL AND status IN ('AKTIF', 'RESCHEDULED', 'MACET');
-- Enforces konfigurasi maks_pinjaman_aktif_per_mitra = 1 (spec 5.5 default).
-- Deliberately a UNIQUE INDEX, not a trigger: if the client raises the limit
-- above 1, dropping this index is the migration, and until then the database
-- itself cannot hold a second live loan for one mitra.
CREATE UNIQUE INDEX pumk_akad_satu_aktif_per_mitra_uq ON pumk_akad (mitra_id)
  WHERE deleted_at IS NULL AND status IN ('BELUM_CAIR', 'AKTIF', 'RESCHEDULED', 'MACET');

CREATE OR REPLACE FUNCTION tjsl_akad_sinkron_cabang() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_cabang UUID;
BEGIN
  SELECT cabang_id INTO v_cabang FROM pumk_proposal WHERE id = NEW.proposal_id;
  IF v_cabang IS DISTINCT FROM NEW.cabang_id THEN
    RAISE EXCEPTION 'TJSL-AKD-001: cabang_id akad (%) harus sama dengan cabang proposal (%)',
      NEW.cabang_id, v_cabang
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_pumk_akad_10_cabang
  BEFORE INSERT OR UPDATE OF cabang_id, proposal_id ON pumk_akad
  FOR EACH ROW EXECUTE FUNCTION tjsl_akad_sinkron_cabang();

-- One row per generated schedule version. This table, not the row-level
-- flag, is where "exactly one active version per akad" is enforceable as a
-- partial unique index: pumk_jadwal_angsuran holds N rows per version, so a
-- partial unique index over its own (akad_id, versi) could never express
-- "one active version" without also forbidding the 2nd instalment.
-- pumk_jadwal_angsuran.is_active_version (the column spec 4.4 names) is kept,
-- but it is mirrored from here by trigger and cannot be set independently.
CREATE TABLE pumk_jadwal_versi (
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  versi SMALLINT NOT NULL CHECK (versi >= 1),
  is_active_version BOOLEAN NOT NULL DEFAULT true,
  -- Invariant 8 names the retired state SUPERSEDED.
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  tanggal_berlaku DATE,
  -- Set for versi > 1; FK added after pumk_reschedule exists (below).
  reschedule_id UUID,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (akad_id, versi),
  CONSTRAINT pumk_jadwal_versi_status_ck CHECK (
    (is_active_version AND status = 'ACTIVE') OR (NOT is_active_version AND status = 'SUPERSEDED')
  )
);
CREATE UNIQUE INDEX pumk_jadwal_versi_aktif_uq ON pumk_jadwal_versi (akad_id) WHERE is_active_version;

CREATE TABLE pumk_jadwal_angsuran (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  versi SMALLINT NOT NULL DEFAULT 1 CHECK (versi >= 1),
  angsuran_ke SMALLINT NOT NULL CHECK (angsuran_ke >= 1),
  tanggal_jatuh_tempo DATE NOT NULL,
  pokok NUMERIC(20,2) NOT NULL CHECK (pokok >= 0),
  jasa_adm NUMERIC(20,2) NOT NULL CHECK (jasa_adm >= 0),
  total NUMERIC(20,2) NOT NULL,
  saldo_pokok_setelah NUMERIC(20,2) NOT NULL CHECK (saldo_pokok_setelah >= 0),
  status TEXT NOT NULL DEFAULT 'BELUM_JATUH_TEMPO' CHECK (status IN
    ('BELUM_JATUH_TEMPO', 'JATUH_TEMPO', 'LUNAS', 'SEBAGIAN', 'DIRESCHEDULE')),
  pokok_terbayar NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (pokok_terbayar >= 0),
  jasa_terbayar NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (jasa_terbayar >= 0),
  tanggal_lunas DATE,
  is_active_version BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pumk_jadwal_total_ck CHECK (total = pokok + jasa_adm),
  -- A row can never be overpaid; excess goes to pumk_kelebihan (invariant 10).
  CONSTRAINT pumk_jadwal_terbayar_ck CHECK (pokok_terbayar <= pokok AND jasa_terbayar <= jasa_adm),
  CONSTRAINT pumk_jadwal_lunas_ck CHECK (
    status <> 'LUNAS' OR (pokok_terbayar = pokok AND jasa_terbayar = jasa_adm)
  ),
  CONSTRAINT pumk_jadwal_versi_uq UNIQUE (akad_id, versi, angsuran_ke),
  CONSTRAINT pumk_jadwal_versi_fk FOREIGN KEY (akad_id, versi)
    REFERENCES pumk_jadwal_versi (akad_id, versi)
);
-- is_active_version on a schedule row is a mirror of its version header, so
-- the "one active version per akad" guarantee cannot be defeated by writing
-- the row column directly.
CREATE OR REPLACE FUNCTION tjsl_jadwal_sinkron_versi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_aktif BOOLEAN;
BEGIN
  SELECT is_active_version INTO v_aktif
  FROM pumk_jadwal_versi WHERE akad_id = NEW.akad_id AND versi = NEW.versi;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TJSL-JDW-003: versi jadwal % untuk akad % belum terdaftar di pumk_jadwal_versi',
      NEW.versi, NEW.akad_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.is_active_version := v_aktif;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_pumk_jadwal_05_sinkron_versi
  BEFORE INSERT OR UPDATE ON pumk_jadwal_angsuran
  FOR EACH ROW EXECUTE FUNCTION tjsl_jadwal_sinkron_versi();

CREATE OR REPLACE FUNCTION tjsl_jadwal_versi_propagasi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE pumk_jadwal_angsuran
     SET is_active_version = NEW.is_active_version,
         status = CASE WHEN NOT NEW.is_active_version AND status <> 'LUNAS' THEN 'DIRESCHEDULE' ELSE status END,
         updated_by = NEW.updated_by
   WHERE akad_id = NEW.akad_id AND versi = NEW.versi
     AND is_active_version <> NEW.is_active_version;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER trg_pumk_jadwal_versi_50_propagasi
  AFTER UPDATE OF is_active_version ON pumk_jadwal_versi
  FOR EACH ROW EXECUTE FUNCTION tjsl_jadwal_versi_propagasi();
CREATE INDEX pumk_jadwal_akad_idx ON pumk_jadwal_angsuran (akad_id, versi, angsuran_ke);
-- Laporan Jatuh Tempo (spec 10.1 #5) and the arrears scan in spec 8.1 step 2.
CREATE INDEX pumk_jadwal_jatuh_tempo_idx ON pumk_jadwal_angsuran (tanggal_jatuh_tempo)
  WHERE is_active_version AND status <> 'LUNAS' AND deleted_at IS NULL;

-- Invariant 9, deferred so a whole schedule can be inserted row by row and is
-- validated once at COMMIT. Only version 1 is checked: a reschedule
-- (versi > 1) restructures the remaining balance, so its total pokok is the
-- outstanding at reschedule time, not the original principal.
CREATE OR REPLACE FUNCTION tjsl_jadwal_cek_total_pokok() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_total NUMERIC(20,2);
  v_pokok NUMERIC(20,2);
BEGIN
  SELECT coalesce(sum(pokok), 0) INTO v_total
  FROM pumk_jadwal_angsuran
  WHERE akad_id = NEW.akad_id AND versi = 1 AND deleted_at IS NULL;

  SELECT pokok_pinjaman INTO v_pokok FROM pumk_akad WHERE id = NEW.akad_id;

  IF v_total <> v_pokok THEN
    RAISE EXCEPTION
      'TJSL-JDW-001: total pokok jadwal versi 1 (%) harus sama persis dengan pokok pinjaman akad (%)',
      v_total, v_pokok
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_pumk_jadwal_50_total_pokok
  AFTER INSERT OR UPDATE ON pumk_jadwal_angsuran
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.versi = 1 AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION tjsl_jadwal_cek_total_pokok();

-- Invariant 8: the priced shape of a schedule row never changes. Payment
-- progress columns (pokok_terbayar, jasa_terbayar, status, tanggal_lunas,
-- is_active_version) stay mutable, because that is how allocation and
-- reschedule record their effect.
CREATE OR REPLACE FUNCTION tjsl_jadwal_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.akad_id <> OLD.akad_id
     OR NEW.versi <> OLD.versi
     OR NEW.angsuran_ke <> OLD.angsuran_ke
     OR NEW.tanggal_jatuh_tempo <> OLD.tanggal_jatuh_tempo
     OR NEW.pokok <> OLD.pokok
     OR NEW.jasa_adm <> OLD.jasa_adm
     OR NEW.total <> OLD.total
     OR NEW.saldo_pokok_setelah <> OLD.saldo_pokok_setelah THEN
    RAISE EXCEPTION
      'TJSL-JDW-002: jadwal angsuran bersifat immutable; ubah lewat reschedule (versi baru), bukan UPDATE'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_pumk_jadwal_10_immutable
  BEFORE UPDATE ON pumk_jadwal_angsuran
  FOR EACH ROW EXECUTE FUNCTION tjsl_jadwal_immutable();

SELECT tjsl_attach_block_delete('pumk_jadwal_angsuran');

CREATE TABLE pumk_pencairan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  tanggal_pencairan DATE NOT NULL,
  jumlah NUMERIC(20,2) NOT NULL CHECK (jumlah > 0),
  akun_kas_id UUID NOT NULL REFERENCES akun(id),
  no_bukti TEXT,
  keterangan TEXT,
  -- FK added in 0010; every money event points at the jurnal that recorded it.
  jurnal_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX pumk_pencairan_akad_idx ON pumk_pencairan (akad_id) WHERE deleted_at IS NULL;
CREATE INDEX pumk_pencairan_tanggal_idx ON pumk_pencairan (tanggal_pencairan);

CREATE TABLE pumk_angsuran (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  tanggal_terima DATE NOT NULL,
  -- Value date: when the money actually landed, which is what the journal is
  -- dated on when it differs from data-entry date.
  tanggal_valuta DATE,
  jumlah_diterima NUMERIC(20,2) NOT NULL CHECK (jumlah_diterima > 0),
  alokasi_pokok NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (alokasi_pokok >= 0),
  alokasi_jasa NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (alokasi_jasa >= 0),
  alokasi_kelebihan NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (alokasi_kelebihan >= 0),
  akun_kas_id UUID NOT NULL REFERENCES akun(id),
  no_bukti TEXT,
  metode_alokasi TEXT NOT NULL DEFAULT 'DEFAULT',
  keterangan TEXT,
  jurnal_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- The allocation must account for every rupiah received, exactly.
  CONSTRAINT pumk_angsuran_alokasi_ck CHECK (
    jumlah_diterima = alokasi_pokok + alokasi_jasa + alokasi_kelebihan
  )
);
CREATE INDEX pumk_angsuran_akad_idx ON pumk_angsuran (akad_id, tanggal_terima) WHERE deleted_at IS NULL;
CREATE INDEX pumk_angsuran_tanggal_idx ON pumk_angsuran (tanggal_terima);

CREATE TABLE pumk_reschedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  tanggal_pengajuan DATE NOT NULL,
  alasan TEXT NOT NULL,
  jenis TEXT NOT NULL CHECK (jenis IN
    ('PERPANJANG_TENOR', 'TURUNKAN_ANGSURAN', 'GRACE_PERIOD', 'RESTRUKTUR_POKOK')),
  tenor_baru SMALLINT CHECK (tenor_baru IS NULL OR tenor_baru > 0),
  grace_baru SMALLINT CHECK (grace_baru IS NULL OR grace_baru >= 0),
  jasa_rate_baru NUMERIC(9,6) CHECK (jasa_rate_baru IS NULL OR jasa_rate_baru >= 0),
  jadwal_versi_lama SMALLINT NOT NULL CHECK (jadwal_versi_lama >= 1),
  jadwal_versi_baru SMALLINT CHECK (jadwal_versi_baru IS NULL OR jadwal_versi_baru > jadwal_versi_lama),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DISETUJUI', 'DITOLAK')),
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pumk_reschedule_disetujui_ck CHECK (
    status <> 'DISETUJUI' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND jadwal_versi_baru IS NOT NULL)
  )
);
CREATE INDEX pumk_reschedule_akad_idx ON pumk_reschedule (akad_id) WHERE deleted_at IS NULL;

ALTER TABLE pumk_jadwal_versi
  ADD CONSTRAINT pumk_jadwal_versi_reschedule_fk
  FOREIGN KEY (reschedule_id) REFERENCES pumk_reschedule(id);

CREATE TABLE pumk_pengakhiran (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  jenis TEXT NOT NULL CHECK (jenis IN
    ('LUNAS_DIPERCEPAT', 'HAPUS_BUKU', 'PENGHAPUSAN_BERSYARAT')),
  tanggal DATE NOT NULL,
  -- Frozen at decision time: the write-off journal must be reconstructable
  -- from this row even after the akad's outstanding columns move to zero.
  outstanding_pokok_saat_itu NUMERIC(20,2) NOT NULL CHECK (outstanding_pokok_saat_itu >= 0),
  outstanding_jasa_saat_itu NUMERIC(20,2) NOT NULL CHECK (outstanding_jasa_saat_itu >= 0),
  dasar_keputusan TEXT,
  no_sk TEXT,
  jurnal_id UUID,
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX pumk_pengakhiran_akad_idx ON pumk_pengakhiran (akad_id) WHERE deleted_at IS NULL;

CREATE TABLE pumk_kelebihan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  -- The angsuran row that produced the overpayment, when it came from one.
  angsuran_id UUID REFERENCES pumk_angsuran(id),
  tanggal DATE NOT NULL,
  jumlah NUMERIC(20,2) NOT NULL CHECK (jumlah > 0),
  status TEXT NOT NULL DEFAULT 'TERTAHAN'
    CHECK (status IN ('TERTAHAN', 'DIKEMBALIKAN', 'DIALOKASIKAN')),
  jurnal_id_terima UUID,
  jurnal_id_kembali UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX pumk_kelebihan_akad_idx ON pumk_kelebihan (akad_id) WHERE deleted_at IS NULL;

CREATE TABLE tindak_lanjut_penagihan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  tanggal DATE NOT NULL,
  jenis TEXT NOT NULL CHECK (jenis IN
    ('KUNJUNGAN', 'TELEPON', 'SURAT_PERINGATAN', 'SOMASI')),
  hasil TEXT,
  petugas_karyawan_id UUID REFERENCES karyawan(id),
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
CREATE INDEX tindak_lanjut_penagihan_akad_idx ON tindak_lanjut_penagihan (akad_id, tanggal) WHERE deleted_at IS NULL;

-- Legacy opening outstanding, the akad half of spec 9.6 "Import Saldo Awal".
-- Paired with akun_saldo_awal (0005) through the same batch, so the go-live
-- validation "sub-ledger equals the Piutang account balance" is one query.
CREATE TABLE akad_saldo_awal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES saldo_awal_batch(id),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  outstanding_pokok_awal NUMERIC(20,2) NOT NULL CHECK (outstanding_pokok_awal >= 0),
  outstanding_jasa_awal NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (outstanding_jasa_awal >= 0),
  tunggakan_pokok_awal NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (tunggakan_pokok_awal >= 0),
  tunggakan_jasa_awal NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (tunggakan_jasa_awal >= 0),
  angsuran_ke_terakhir_dibayar SMALLINT CHECK (angsuran_ke_terakhir_dibayar IS NULL OR angsuran_ke_terakhir_dibayar >= 0),
  hari_tunggakan_awal INTEGER CHECK (hari_tunggakan_awal IS NULL OR hari_tunggakan_awal >= 0),
  kolektibilitas_awal TEXT REFERENCES kolektibilitas_kelas(kode),
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT akad_saldo_awal_tunggakan_ck CHECK (
    tunggakan_pokok_awal <= outstanding_pokok_awal
  )
);
CREATE UNIQUE INDEX akad_saldo_awal_uq ON akad_saldo_awal (batch_id, akad_id) WHERE deleted_at IS NULL;

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('pumk_proposal'), ('pumk_survey'), ('pumk_jaminan'), ('pumk_review'),
  ('pumk_approval'), ('pumk_akad'), ('pumk_jadwal_versi'), ('pumk_jadwal_angsuran'), ('pumk_pencairan'),
  ('pumk_angsuran'), ('pumk_reschedule'), ('pumk_pengakhiran'), ('pumk_kelebihan'),
  ('tindak_lanjut_penagihan'), ('akad_saldo_awal')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('pumk_proposal'), ('pumk_survey'), ('pumk_jaminan'), ('pumk_review'),
  ('pumk_approval'), ('pumk_akad'), ('pumk_jadwal_versi'), ('pumk_jadwal_angsuran'), ('pumk_pencairan'),
  ('pumk_angsuran'), ('pumk_reschedule'), ('pumk_pengakhiran'), ('pumk_kelebihan'),
  ('tindak_lanjut_penagihan'), ('akad_saldo_awal')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('pumk_proposal'), ('pumk_survey'), ('pumk_jaminan'), ('pumk_review'),
  ('pumk_approval'), ('pumk_akad'), ('pumk_jadwal_versi'), ('pumk_jadwal_angsuran'), ('pumk_pencairan'),
  ('pumk_angsuran'), ('pumk_reschedule'), ('pumk_pengakhiran'), ('pumk_kelebihan'),
  ('tindak_lanjut_penagihan'), ('akad_saldo_awal')
) AS x(t);

-- down
DROP TABLE IF EXISTS akad_saldo_awal;
DROP TABLE IF EXISTS tindak_lanjut_penagihan;
DROP TABLE IF EXISTS pumk_kelebihan;
DROP TABLE IF EXISTS pumk_pengakhiran;
DROP TABLE IF EXISTS pumk_angsuran;
DROP TABLE IF EXISTS pumk_pencairan;
DROP TABLE IF EXISTS pumk_jadwal_angsuran;
-- pumk_jadwal_versi references pumk_reschedule, so the version header goes first.
DROP TABLE IF EXISTS pumk_jadwal_versi;
DROP TABLE IF EXISTS pumk_reschedule;
DROP FUNCTION IF EXISTS tjsl_jadwal_versi_propagasi() CASCADE;
DROP FUNCTION IF EXISTS tjsl_jadwal_sinkron_versi() CASCADE;
DROP FUNCTION IF EXISTS tjsl_jadwal_immutable() CASCADE;
DROP FUNCTION IF EXISTS tjsl_jadwal_cek_total_pokok() CASCADE;
DROP TABLE IF EXISTS pumk_akad;
DROP FUNCTION IF EXISTS tjsl_akad_sinkron_cabang() CASCADE;
DROP TABLE IF EXISTS pumk_approval;
DROP TABLE IF EXISTS pumk_review;
DROP FUNCTION IF EXISTS tjsl_cek_approver_bukan_checker() CASCADE;
DROP FUNCTION IF EXISTS tjsl_cek_reviewer_bukan_maker() CASCADE;
DROP TABLE IF EXISTS pumk_jaminan;
DROP TABLE IF EXISTS pumk_survey;
DROP TABLE IF EXISTS pumk_proposal_transisi;
DROP TABLE IF EXISTS pumk_proposal;
