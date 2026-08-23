-- 0005_coa.sql  (spec 4.2, spec 10.3 report layout, spec 9.6 opening balances)
--
-- Chart of accounts + the report-layout reference table + the opening-balance
-- (go-live migration) tables.
--
-- REPORT LAYOUT IS DATA, NOT CODE. baris_laporan holds one row per printed
-- line of Laporan Posisi Keuangan / Aktivitas / Arus Kas / Perubahan Aset
-- Neto, and akun.klasifikasi_laporan is a real composite FK into it. So a
-- report renderer walks rows; changing the statement layout is a config edit,
-- not a deploy (spec 4.2 explicitly asks for this).
--
-- WHY akun.postable_id EXISTS. Spec invariant: a jurnal line may only point
-- at an account with is_postable = true. Postgres cannot put a foreign key on
-- a filtered view or a partial unique index, so the usual answer is a trigger.
-- Instead, postable_id is a STORED generated column that equals id when
-- is_postable and NULL otherwise, with a plain UNIQUE on it; jurnal_baris then
-- carries a genuine declarative FK to akun(postable_id). Consequences, both
-- wanted: an INSERT naming a header account fails with a plain FK violation
-- (no trigger to bypass, works under any transaction isolation), and flipping
-- is_postable to false on an account that already has journal lines fails too,
-- because the generated key those lines reference would disappear. See
-- docs/adr/0003.

-- up

CREATE TABLE baris_laporan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  laporan TEXT NOT NULL CHECK (laporan IN
    ('POSISI_KEUANGAN', 'AKTIVITAS', 'ARUS_KAS', 'PERUBAHAN_ASET_NETO')),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  parent_id UUID REFERENCES baris_laporan(id),
  urutan INTEGER NOT NULL,
  level SMALLINT NOT NULL DEFAULT 1 CHECK (level >= 1),
  -- HEADER prints a caption, DETAIL sums the accounts mapped to it,
  -- SUBTOTAL/TOTAL sum their descendant lines, FORMULA evaluates formula_json
  -- (used for lines like "Piutang Pinjaman Mitra Binaan - Bersih" and for
  -- Kenaikan/Penurunan Aset Neto).
  tipe_baris TEXT NOT NULL CHECK (tipe_baris IN ('HEADER', 'DETAIL', 'SUBTOTAL', 'TOTAL', 'FORMULA')),
  formula_json JSONB,
  -- -1 for contra presentation (Penyisihan Penurunan Nilai Piutang shown as a
  -- deduction from gross receivables, spec 6.4 note).
  tanda SMALLINT NOT NULL DEFAULT 1 CHECK (tanda IN (-1, 1)),
  -- Which side/section of the statement, e.g. ASET / LIABILITAS / ASET_NETO
  -- for Posisi Keuangan, OPERASI / INVESTASI / PENDANAAN for Arus Kas.
  seksi TEXT,
  cetak_tebal BOOLEAN NOT NULL DEFAULT false,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- A plain (not partial) UNIQUE, because akun.klasifikasi_laporan needs a
  -- composite FK target. A soft-deleted line therefore keeps its code
  -- reserved; that is correct for a layout table (reprinting an old period
  -- must still resolve the code it was printed with).
  CONSTRAINT baris_laporan_kode_uq UNIQUE (bumn_id, kode)
);
CREATE INDEX baris_laporan_urut_idx ON baris_laporan (bumn_id, laporan, urutan);

CREATE TABLE akun (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  parent_id UUID REFERENCES akun(id),
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 6),
  tipe TEXT NOT NULL CHECK (tipe IN ('ASET', 'LIABILITAS', 'ASET_NETO', 'PENDAPATAN', 'BEBAN')),
  saldo_normal TEXT NOT NULL CHECK (saldo_normal IN ('D', 'K')),
  is_postable BOOLEAN NOT NULL DEFAULT false,
  is_kas BOOLEAN NOT NULL DEFAULT false,
  -- Contra account (normal balance opposite to its type), e.g. Penyisihan
  -- Penurunan Nilai Piutang: tipe ASET, saldo_normal K.
  is_kontra BOOLEAN NOT NULL DEFAULT false,
  klasifikasi_arus_kas TEXT CHECK (klasifikasi_arus_kas IN ('OPERASI', 'INVESTASI', 'PENDANAAN')),
  klasifikasi_laporan TEXT NOT NULL,
  aktif BOOLEAN NOT NULL DEFAULT true,
  -- See file header: the declarative half of the is_postable invariant.
  postable_id UUID GENERATED ALWAYS AS (CASE WHEN is_postable THEN id END) STORED,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT akun_postable_id_uq UNIQUE (postable_id),
  CONSTRAINT akun_klasifikasi_laporan_fk
    FOREIGN KEY (bumn_id, klasifikasi_laporan) REFERENCES baris_laporan (bumn_id, kode),
  -- Only balance-sheet asset accounts can be cash (Laporan Arus Kas closing
  -- balance is defined as the sum of is_kas accounts, spec 10.3 #18).
  CONSTRAINT akun_is_kas_hanya_aset_ck CHECK (NOT is_kas OR tipe = 'ASET'),
  -- Level 1 accounts are roots; anything deeper must name a parent.
  CONSTRAINT akun_parent_level_ck CHECK ((level = 1 AND parent_id IS NULL) OR (level > 1 AND parent_id IS NOT NULL))
);
CREATE UNIQUE INDEX akun_kode_uq ON akun (bumn_id, kode) WHERE deleted_at IS NULL;
CREATE INDEX akun_parent_idx ON akun (parent_id);
CREATE INDEX akun_postable_idx ON akun (bumn_id, kode) WHERE is_postable AND aktif AND deleted_at IS NULL;
CREATE INDEX akun_klasifikasi_idx ON akun (bumn_id, klasifikasi_laporan);
CREATE INDEX akun_kas_idx ON akun (bumn_id) WHERE is_kas AND deleted_at IS NULL;

-- Hierarchy rules that a CHECK cannot express because they read the parent row
-- (spec 9.4: "COA dengan tampilan tree dan validasi hierarki"):
--   1. parent.level must be exactly this level - 1
--   2. a parent must not be postable (only leaves are postable)
--   3. parent must belong to the same bumn
--   4. child tipe must match parent tipe (no Beban hanging under Aset)
CREATE OR REPLACE FUNCTION tjsl_akun_validasi_hierarki() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p RECORD;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT level, is_postable, bumn_id, tipe INTO p FROM akun WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TJSL-COA-001: parent akun % tidak ditemukan', NEW.parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p.bumn_id <> NEW.bumn_id THEN
    RAISE EXCEPTION 'TJSL-COA-002: parent akun berada di bumn lain'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p.level <> NEW.level - 1 THEN
    RAISE EXCEPTION 'TJSL-COA-003: level akun % harus tepat satu di bawah parent (parent level %)', NEW.level, p.level
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p.is_postable THEN
    RAISE EXCEPTION 'TJSL-COA-004: akun % adalah akun postable dan tidak boleh punya anak', NEW.parent_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p.tipe <> NEW.tipe THEN
    RAISE EXCEPTION 'TJSL-COA-005: tipe akun (%) harus sama dengan tipe parent (%)', NEW.tipe, p.tipe
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_akun_10_hierarki
  BEFORE INSERT OR UPDATE OF parent_id, level, tipe, bumn_id ON akun
  FOR EACH ROW EXECUTE FUNCTION tjsl_akun_validasi_hierarki();

-- ---------------------------------------------------------------------------
-- Opening balances (go-live migration from the legacy system, spec 9.6).
-- The import tool is a later phase; the tables exist now so the schema does
-- not have to move when it lands.
-- ---------------------------------------------------------------------------

CREATE TABLE saldo_awal_batch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  -- NULL = one batch covering all branches.
  cabang_id UUID REFERENCES cabang(id),
  -- Cut-off date the legacy balances are stated as of. The generated opening
  -- journal is dated here, so this date must fall in an OPEN periode.
  tanggal_efektif DATE NOT NULL,
  keterangan TEXT,
  sumber TEXT NOT NULL DEFAULT 'IMPORT_EXCEL'
    CHECK (sumber IN ('IMPORT_EXCEL', 'INPUT_MANUAL', 'MIGRASI_SISTEM_LAMA')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'DIVALIDASI', 'DIPOSTING', 'DIBATALKAN')),
  total_debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
  total_kredit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_kredit >= 0),
  -- Set once the opening journal is posted; FK added in 0010 (jurnal).
  jurnal_id UUID,
  divalidasi_by UUID REFERENCES app_user(id),
  divalidasi_at TIMESTAMPTZ,
  catatan_validasi_json JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX saldo_awal_batch_bumn_idx ON saldo_awal_batch (bumn_id, tanggal_efektif);

CREATE TABLE akun_saldo_awal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES saldo_awal_batch(id),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  akun_id UUID NOT NULL REFERENCES akun(id),
  -- One side only, same rule as jurnal_baris: an opening balance is a debit or
  -- a credit, never both, never neither.
  saldo_debit NUMERIC(20,2) NOT NULL DEFAULT 0,
  saldo_kredit NUMERIC(20,2) NOT NULL DEFAULT 0,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT akun_saldo_awal_satu_sisi_ck CHECK (
    saldo_debit >= 0 AND saldo_kredit >= 0
    AND ((saldo_debit > 0 AND saldo_kredit = 0) OR (saldo_kredit > 0 AND saldo_debit = 0))
  )
);
CREATE UNIQUE INDEX akun_saldo_awal_uq ON akun_saldo_awal (batch_id, cabang_id, akun_id) WHERE deleted_at IS NULL;
CREATE INDEX akun_saldo_awal_akun_idx ON akun_saldo_awal (akun_id);

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('baris_laporan'), ('akun'), ('saldo_awal_batch'), ('akun_saldo_awal')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('baris_laporan'), ('akun'), ('saldo_awal_batch'), ('akun_saldo_awal')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('baris_laporan'), ('akun'), ('saldo_awal_batch'), ('akun_saldo_awal')
) AS x(t);

-- down
DROP TABLE IF EXISTS akun_saldo_awal;
DROP TABLE IF EXISTS saldo_awal_batch;
DROP TRIGGER IF EXISTS trg_akun_10_hierarki ON akun;
DROP FUNCTION IF EXISTS tjsl_akun_validasi_hierarki();
DROP TABLE IF EXISTS akun;
DROP TABLE IF EXISTS baris_laporan;
