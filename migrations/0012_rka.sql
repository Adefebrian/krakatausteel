-- 0012_rka.sql  (spec 4.8, spec 9.3, report 24)
--
-- Annual budget. A DISETUJUI rka is the baseline that Laporan RKA versus
-- Realisasi compares against; a revision is a NEW versi, never an edit, so a
-- report printed last month can still be reproduced (invariant 14).
--
-- rka_detail is deliberately sparse: akun_id for RKA Keuangan, sektor_id for
-- RKA PUMK, bidang_id for RKA Non PUMK. A CHECK forces exactly the dimension
-- that the rka.jenis calls for, so a PUMK budget line cannot be filed against
-- an expense account by accident and then vanish from both reports.

-- up

CREATE TABLE rka (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  -- NULL = a consolidated (entity-wide) budget rather than a branch budget.
  cabang_id UUID REFERENCES cabang(id),
  tahun SMALLINT NOT NULL CHECK (tahun BETWEEN 1900 AND 2200),
  jenis TEXT NOT NULL CHECK (jenis IN ('PUMK', 'NON_PUMK', 'KEUANGAN')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DISETUJUI', 'REVISI')),
  versi SMALLINT NOT NULL DEFAULT 1 CHECK (versi >= 1),
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT rka_disetujui_ck CHECK (
    status <> 'DISETUJUI' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX rka_versi_uq
  ON rka (bumn_id, cabang_id, tahun, jenis, versi) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
-- Only one approved baseline per scope per year; revisions must move the old
-- one to REVISI first.
CREATE UNIQUE INDEX rka_baseline_uq
  ON rka (bumn_id, cabang_id, tahun, jenis) NULLS NOT DISTINCT
  WHERE status = 'DISETUJUI' AND deleted_at IS NULL;
CREATE INDEX rka_tahun_idx ON rka (bumn_id, tahun, jenis) WHERE deleted_at IS NULL;

CREATE TABLE rka_detail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rka_id UUID NOT NULL REFERENCES rka(id),
  akun_id UUID REFERENCES akun(id),
  sektor_id UUID REFERENCES sektor_pumk(id),
  bidang_id UUID REFERENCES bidang_non_pumk(id),
  uraian TEXT NOT NULL,
  -- NULL = an annual figure with no monthly breakdown.
  bulan SMALLINT CHECK (bulan IS NULL OR bulan BETWEEN 1 AND 12),
  jumlah_anggaran NUMERIC(20,2) NOT NULL DEFAULT 0,
  -- Non-money target, e.g. number of mitra to be funded.
  jumlah_unit INTEGER CHECK (jumlah_unit IS NULL OR jumlah_unit >= 0),
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX rka_detail_rka_idx ON rka_detail (rka_id) WHERE deleted_at IS NULL;
CREATE INDEX rka_detail_akun_idx ON rka_detail (akun_id) WHERE akun_id IS NOT NULL;
CREATE INDEX rka_detail_sektor_idx ON rka_detail (sektor_id) WHERE sektor_id IS NOT NULL;
CREATE INDEX rka_detail_bidang_idx ON rka_detail (bidang_id) WHERE bidang_id IS NOT NULL;

-- The budget dimension must match the budget type, otherwise a line is
-- invisible to the report that should show it.
CREATE OR REPLACE FUNCTION tjsl_rka_detail_validasi_dimensi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_jenis TEXT;
BEGIN
  SELECT jenis INTO v_jenis FROM rka WHERE id = NEW.rka_id;

  IF v_jenis = 'PUMK' AND NEW.sektor_id IS NULL THEN
    RAISE EXCEPTION 'TJSL-RKA-001: baris RKA PUMK wajib punya sektor_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_jenis = 'NON_PUMK' AND NEW.bidang_id IS NULL THEN
    RAISE EXCEPTION 'TJSL-RKA-002: baris RKA Non PUMK wajib punya bidang_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_jenis = 'KEUANGAN' AND NEW.akun_id IS NULL THEN
    RAISE EXCEPTION 'TJSL-RKA-003: baris RKA Keuangan wajib punya akun_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_rka_detail_10_dimensi
  BEFORE INSERT OR UPDATE ON rka_detail
  FOR EACH ROW EXECUTE FUNCTION tjsl_rka_detail_validasi_dimensi();

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES ('rka'), ('rka_detail')) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES ('rka'), ('rka_detail')) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES ('rka'), ('rka_detail')) AS x(t);

-- down
DROP TABLE IF EXISTS rka_detail;
DROP FUNCTION IF EXISTS tjsl_rka_detail_validasi_dimensi() CASCADE;
DROP TABLE IF EXISTS rka;
