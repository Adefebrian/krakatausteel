-- 0007_periode.sql  (spec 4.7 periode, invariants 5 and 6)
--
-- The accounting calendar. Created before jurnal because every jurnal names a
-- periode, and because two invariants are enforced here rather than in the
-- application:
--
--   invariant 6, periods close in order: a BEFORE UPDATE trigger refuses to
--   set CLOSED while any earlier period of the same bumn is not CLOSED, and
--   refuses to reopen anything but the most recently closed period.
--
--   invariant 5, no posting into a CLOSED period: enforced in 0010 on jurnal,
--   using tjsl_periode_untuk_tanggal() defined here so both migrations share
--   one definition of "which period does this transaction date fall in".
--
-- A periode is a calendar month. A fiscal year starting in a month other than
-- January (bumn.tahun_buku_mulai_bulan) is a reporting-time grouping over
-- these monthly rows, not a different period shape. See ASSUMPTIONS.md A-07.

-- up

CREATE TABLE periode (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  tahun SMALLINT NOT NULL CHECK (tahun BETWEEN 1900 AND 2200),
  bulan SMALLINT NOT NULL CHECK (bulan BETWEEN 1 AND 12),
  tanggal_mulai DATE NOT NULL,
  tanggal_akhir DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLOSING_IN_PROGRESS', 'CLOSED')),
  closed_by UUID REFERENCES app_user(id),
  closed_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES app_user(id),
  reopened_at TIMESTAMPTZ,
  alasan_reopen TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Spec deliverable: uniqueness per (bumn_id, tahun, bulan). Not a partial
  -- index: a period is never soft-deleted, so the constraint is unconditional
  -- and can therefore be a real UNIQUE constraint (FK-referenceable).
  CONSTRAINT periode_bumn_tahun_bulan_uq UNIQUE (bumn_id, tahun, bulan),
  -- The date window must agree with tahun/bulan, otherwise
  -- tjsl_periode_untuk_tanggal() and "periode_id" could disagree about which
  -- month a jurnal belongs to.
  CONSTRAINT periode_window_ck CHECK (
    tanggal_mulai = make_date(tahun, bulan, 1)
    AND tanggal_akhir = (make_date(tahun, bulan, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date
  ),
  CONSTRAINT periode_closed_jejak_ck CHECK (
    (status <> 'CLOSED') OR (closed_by IS NOT NULL AND closed_at IS NOT NULL)
  )
);
CREATE INDEX periode_tanggal_idx ON periode (bumn_id, tanggal_mulai, tanggal_akhir);
CREATE INDEX periode_status_idx ON periode (bumn_id, status);

-- Resolves a transaction date to its period. STABLE, not IMMUTABLE: it reads
-- a table. Used by the jurnal guards in 0010 and by the closing engine.
CREATE OR REPLACE FUNCTION tjsl_periode_untuk_tanggal(p_bumn_id UUID, p_tanggal DATE)
RETURNS periode
LANGUAGE sql STABLE AS $fn$
  SELECT p.* FROM periode p
  WHERE p.bumn_id = p_bumn_id
    AND p_tanggal BETWEEN p.tanggal_mulai AND p.tanggal_akhir
  LIMIT 1;
$fn$;

-- Invariant 6 + the reopen rules from spec 8.4.
CREATE OR REPLACE FUNCTION tjsl_periode_validasi_transisi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_belum_tutup INTEGER;
  v_lebih_baru INTEGER;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Closing: every earlier period must already be CLOSED.
  IF NEW.status = 'CLOSED' THEN
    SELECT count(*) INTO v_belum_tutup
    FROM periode p
    WHERE p.bumn_id = NEW.bumn_id
      AND p.status <> 'CLOSED'
      AND (p.tahun, p.bulan) < (NEW.tahun, NEW.bulan)
      AND p.id <> NEW.id;
    IF v_belum_tutup > 0 THEN
      RAISE EXCEPTION
        'TJSL-PER-001: tidak bisa closing %-%: masih ada % periode sebelumnya yang belum CLOSED',
        NEW.tahun, NEW.bulan, v_belum_tutup
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- Reopen: only the most recently closed period, and only with a reason.
  IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
    SELECT count(*) INTO v_lebih_baru
    FROM periode p
    WHERE p.bumn_id = NEW.bumn_id
      AND p.status = 'CLOSED'
      AND (p.tahun, p.bulan) > (NEW.tahun, NEW.bulan);
    IF v_lebih_baru > 0 THEN
      RAISE EXCEPTION
        'TJSL-PER-002: tidak bisa reopen %-%: ada % periode CLOSED yang lebih baru; reopen harus berurutan dari yang terakhir',
        NEW.tahun, NEW.bulan, v_lebih_baru
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.alasan_reopen IS NULL OR btrim(NEW.alasan_reopen) = '' THEN
      RAISE EXCEPTION 'TJSL-PER-003: reopen periode wajib menyertakan alasan_reopen'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.reopened_by IS NULL THEN
      RAISE EXCEPTION 'TJSL-PER-004: reopen periode wajib mencatat reopened_by'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_periode_10_transisi
  BEFORE UPDATE OF status ON periode
  FOR EACH ROW EXECUTE FUNCTION tjsl_periode_validasi_transisi();

-- A period row is part of the audit chain; it is never physically removed.
SELECT tjsl_attach_block_delete('periode');
SELECT tjsl_attach_audit_trigger('periode');
SELECT tjsl_attach_audit_fk('periode');
SELECT tjsl_attach_soft_delete_check('periode');

-- down
DROP FUNCTION IF EXISTS tjsl_periode_validasi_transisi() CASCADE;
DROP FUNCTION IF EXISTS tjsl_periode_untuk_tanggal(UUID, DATE);
DROP TABLE IF EXISTS periode;
