-- 0011_closing.sql  (spec 4.7 closing tables, spec 8, spec 10.4 #28-30)
--
-- Everything the closing engine writes. Three ideas drive the shapes here:
--
-- IDEMPOTENCY (invariant 13). Re-running a step for the same period must not
-- double anything, so every output row is keyed by its scope:
--   kolektibilitas_snapshot  UNIQUE (periode_id, akad_id)
--   penyisihan_periode       UNIQUE (periode_id, cabang_id)
--   akrual_jasa_snapshot     UNIQUE (periode_id, akad_id)
--   saldo_akun_periode       UNIQUE (periode_id, cabang_id, akun_id)
-- The journals those steps post are additionally keyed by
-- jurnal.kunci_idempotensi (0010).
--
-- REPRODUCIBILITY (invariant 14). A snapshot row carries the inputs it used,
-- not just the result: rate_penyisihan and dasar_perhitungan are stored per
-- row, and a CHECK re-derives nilai_penyisihan from them. So Laporan
-- Perhitungan Penyisihan (spec 10.4 #28) can reconstruct that period's
-- penyisihan journal exactly, years later, even after the config changes.
--
-- REOPEN. saldo_akun_periode is deliberately NOT delete-protected: spec 8.4
-- says reopening a period deletes its balance snapshot. It is derived data and
-- fully regenerable from the ledger, which is why deleting it is safe while
-- deleting a jurnal never is.

-- up

CREATE TABLE closing_kolektibilitas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id UUID NOT NULL REFERENCES periode(id),
  -- NULL = the run covered all branches at once (spec 8.1).
  cabang_id UUID REFERENCES cabang(id),
  tanggal_jalan TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- PREVIEW is the uncommitted calculation spec 8.1 requires before commit.
  status TEXT NOT NULL DEFAULT 'PREVIEW'
    CHECK (status IN ('PREVIEW', 'SELESAI', 'GAGAL', 'DIBATALKAN')),
  dijalankan_oleh UUID REFERENCES app_user(id),
  total_akad_diproses INTEGER NOT NULL DEFAULT 0 CHECK (total_akad_diproses >= 0),
  -- Migration matrix (from-class -> to-class counts) and totals per class, so
  -- the run summary screen does not have to re-aggregate the snapshots.
  ringkasan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
-- At most one committed run per scope; PREVIEW runs are unrestricted.
CREATE UNIQUE INDEX closing_kolektibilitas_selesai_uq
  ON closing_kolektibilitas (periode_id, cabang_id) NULLS NOT DISTINCT
  WHERE status = 'SELESAI' AND deleted_at IS NULL;
CREATE INDEX closing_kolektibilitas_periode_idx ON closing_kolektibilitas (periode_id);

CREATE TABLE kolektibilitas_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id UUID NOT NULL REFERENCES periode(id),
  closing_id UUID REFERENCES closing_kolektibilitas(id),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  sektor_id UUID REFERENCES sektor_pumk(id),
  -- Due date of the oldest unpaid instalment at period end; NULL = no arrears.
  tanggal_jatuh_tempo_tertunggak_tertua DATE,
  hari_tunggakan INTEGER NOT NULL DEFAULT 0 CHECK (hari_tunggakan >= 0),
  kolektibilitas TEXT NOT NULL REFERENCES kolektibilitas_kelas(kode),
  outstanding_pokok NUMERIC(20,2) NOT NULL CHECK (outstanding_pokok >= 0),
  outstanding_jasa NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (outstanding_jasa >= 0),
  tunggakan_pokok NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (tunggakan_pokok >= 0),
  tunggakan_jasa NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (tunggakan_jasa >= 0),
  rate_penyisihan NUMERIC(9,6) NOT NULL CHECK (rate_penyisihan >= 0 AND rate_penyisihan <= 1),
  -- The basis actually used, copied from config at run time so a later config
  -- change cannot alter a closed period's numbers.
  dasar_perhitungan TEXT NOT NULL DEFAULT 'OUTSTANDING_POKOK'
    CHECK (dasar_perhitungan IN ('OUTSTANDING_POKOK', 'OUTSTANDING_POKOK_PLUS_JASA')),
  nilai_penyisihan NUMERIC(20,2) NOT NULL CHECK (nilai_penyisihan >= 0),
  -- Feeds the quality-migration report (spec 8.1 step 6).
  kolektibilitas_periode_lalu TEXT REFERENCES kolektibilitas_kelas(kode),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Arrears days and an arrears due date agree with each other.
  CONSTRAINT kolektibilitas_snapshot_tunggakan_ck CHECK (
    (tanggal_jatuh_tempo_tertunggak_tertua IS NULL AND hari_tunggakan = 0)
    OR (tanggal_jatuh_tempo_tertunggak_tertua IS NOT NULL)
  ),
  -- The result is re-derivable from the stored inputs, to the cent.
  CONSTRAINT kolektibilitas_snapshot_nilai_ck CHECK (
    nilai_penyisihan = round(
      CASE dasar_perhitungan
        WHEN 'OUTSTANDING_POKOK' THEN outstanding_pokok
        ELSE outstanding_pokok + outstanding_jasa
      END * rate_penyisihan, 2)
  )
);
-- Invariant 13: one snapshot per akad per period, ever.
CREATE UNIQUE INDEX kolektibilitas_snapshot_uq ON kolektibilitas_snapshot (periode_id, akad_id);
CREATE INDEX kolektibilitas_snapshot_periode_cabang_idx ON kolektibilitas_snapshot (periode_id, cabang_id);
CREATE INDEX kolektibilitas_snapshot_kelas_idx ON kolektibilitas_snapshot (periode_id, kolektibilitas);
CREATE INDEX kolektibilitas_snapshot_akad_idx ON kolektibilitas_snapshot (akad_id);
CREATE INDEX kolektibilitas_snapshot_mitra_idx ON kolektibilitas_snapshot (mitra_id);
CREATE INDEX kolektibilitas_snapshot_sektor_idx ON kolektibilitas_snapshot (periode_id, sektor_id);

CREATE TABLE penyisihan_periode (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id UUID NOT NULL REFERENCES periode(id),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  saldo_penyisihan_awal NUMERIC(20,2) NOT NULL DEFAULT 0,
  penyisihan_dibutuhkan NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (penyisihan_dibutuhkan >= 0),
  -- Negative = pemulihan (recovery), spec 8.2 step 4. Signed on purpose.
  beban_penyisihan_periode NUMERIC(20,2) NOT NULL DEFAULT 0,
  jurnal_id UUID REFERENCES jurnal(id),
  dijalankan_oleh UUID REFERENCES app_user(id),
  tanggal DATE NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- spec 8.2 step 3, as arithmetic the database checks.
  CONSTRAINT penyisihan_periode_beban_ck CHECK (
    beban_penyisihan_periode = penyisihan_dibutuhkan - saldo_penyisihan_awal
  )
);
CREATE UNIQUE INDEX penyisihan_periode_uq ON penyisihan_periode (periode_id, cabang_id) WHERE deleted_at IS NULL;

-- Not named in spec 4, but Laporan Akrual Piutang Jasa Administrasi
-- (spec 10.4 #30) has to be reproducible for closed periods and spec 8.3 has
-- to be idempotent; both require the per-akad accrual to be stored, not
-- recomputed. See ASSUMPTIONS.md A-10.
CREATE TABLE akrual_jasa_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id UUID NOT NULL REFERENCES periode(id),
  akad_id UUID NOT NULL REFERENCES pumk_akad(id),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  -- Class at the time of the run; accrual only applies to the classes listed
  -- in konfigurasi akrual_hanya_untuk_kolektibilitas.
  kolektibilitas TEXT NOT NULL REFERENCES kolektibilitas_kelas(kode),
  jasa_jatuh_tempo_periode NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (jasa_jatuh_tempo_periode >= 0),
  jasa_diterima_periode NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (jasa_diterima_periode >= 0),
  jasa_diakrual NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (jasa_diakrual >= 0),
  jurnal_id UUID REFERENCES jurnal(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX akrual_jasa_snapshot_uq ON akrual_jasa_snapshot (periode_id, akad_id);
CREATE INDEX akrual_jasa_snapshot_cabang_idx ON akrual_jasa_snapshot (periode_id, cabang_id);

-- spec 8.4: written when a period closes, so a past period's reports are read
-- from a frozen snapshot instead of being recomputed (invariant 14).
CREATE TABLE saldo_akun_periode (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id UUID NOT NULL REFERENCES periode(id),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  akun_id UUID NOT NULL REFERENCES akun(id),
  -- SIGN CONVENTION: all four columns are debit-positive. A credit-balance
  -- account (liabilitas, aset neto, pendapatan) therefore carries a negative
  -- saldo_awal/saldo_akhir. One convention for every account type is what
  -- makes the identity below checkable, and what makes Neraca Lajur totals
  -- sum to zero rather than to two numbers that have to be compared.
  -- Presentation flips the sign using akun.saldo_normal.
  saldo_awal NUMERIC(20,2) NOT NULL DEFAULT 0,
  mutasi_debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (mutasi_debit >= 0),
  mutasi_kredit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (mutasi_kredit >= 0),
  saldo_akhir NUMERIC(20,2) NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT saldo_akun_periode_identitas_ck CHECK (
    saldo_akhir = saldo_awal + mutasi_debit - mutasi_kredit
  )
);
CREATE UNIQUE INDEX saldo_akun_periode_uq ON saldo_akun_periode (periode_id, cabang_id, akun_id);
CREATE INDEX saldo_akun_periode_akun_idx ON saldo_akun_periode (akun_id, periode_id);
CREATE INDEX saldo_akun_periode_periode_idx ON saldo_akun_periode (periode_id, cabang_id);

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('closing_kolektibilitas'), ('kolektibilitas_snapshot'), ('penyisihan_periode'),
  ('akrual_jasa_snapshot'), ('saldo_akun_periode')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('closing_kolektibilitas'), ('kolektibilitas_snapshot'), ('penyisihan_periode'),
  ('akrual_jasa_snapshot'), ('saldo_akun_periode')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('closing_kolektibilitas'), ('kolektibilitas_snapshot'), ('penyisihan_periode'),
  ('akrual_jasa_snapshot'), ('saldo_akun_periode')
) AS x(t);

-- down
DROP TABLE IF EXISTS saldo_akun_periode;
DROP TABLE IF EXISTS akrual_jasa_snapshot;
DROP TABLE IF EXISTS penyisihan_periode;
DROP TABLE IF EXISTS kolektibilitas_snapshot;
DROP TABLE IF EXISTS closing_kolektibilitas;
