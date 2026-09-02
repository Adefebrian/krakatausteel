-- 0031_portal_impor.sql  (spec 9.5, spec 9.6)
--
-- Three small, independent changes that Fase 7 needs and that nothing before
-- it could have needed:
--
-- 1. `portal_akun_mitra.harus_ganti_sandi`. A mitra portal account is
--    PROVISIONED BY AN OFFICER, so its first password is a secret two people
--    know. The flag is what makes that first password useless for anything
--    except changing itself: while it is true, the mitra session may reach
--    `/mitra/ganti-sandi` and `/mitra/logout` and nothing else. Without the
--    column the only alternatives are letting the officer's password stay
--    valid forever, or having the officer type the mitra's password, and both
--    are worse.
--
-- 2. `portal_submission.pemeriksa_percobaan`. The status check of spec 9.5 is
--    ticket + NIK or date of birth, i.e. a credential check on a public
--    endpoint. The per-ticket failure budget lives in Redis (it has to: it is
--    a rate limit), but a durable counter of failed attempts per ticket is
--    evidence, not throttling, and Redis is not where evidence goes.
--
-- 3. `impor_berkas` / `impor_baris`. Spec 9.6's imports are all-or-nothing per
--    FILE, which means the file itself has to be a row: an import that posted
--    500 journals is only auditable if every one of those journals can be
--    traced back to a named file and the person who uploaded it. The checksum
--    is UNIQUE per entity and kind, so the same file cannot be committed twice
--    by a double click or a retried request.

-- up

ALTER TABLE portal_akun_mitra
  ADD COLUMN harus_ganti_sandi BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN portal_akun_mitra.harus_ganti_sandi IS
  'true while the account still carries the password an officer handed over. A mitra session on such an account may only change the password or log out.';

ALTER TABLE portal_submission
  ADD COLUMN pemeriksa_percobaan INTEGER NOT NULL DEFAULT 0
    CHECK (pemeriksa_percobaan >= 0);
COMMENT ON COLUMN portal_submission.pemeriksa_percobaan IS
  'Durable count of FAILED status-check attempts against this ticket. Evidence, not throttling; the rate limit itself is in Redis.';

-- ---------------------------------------------------------------------------
-- Bulk import provenance (spec 9.6)
-- ---------------------------------------------------------------------------

CREATE TABLE impor_berkas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  -- The branch every row of the file is imported INTO. One file, one branch:
  -- a file that could name a branch per row would be a way to write into a
  -- branch the uploader may not touch.
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  jenis TEXT NOT NULL CHECK (jenis IN ('MITRA', 'ANGSURAN')),
  nama_file TEXT NOT NULL,
  ukuran_bytes BIGINT NOT NULL CHECK (ukuran_bytes >= 0),
  -- SHA-256 of the exact bytes uploaded. Two purposes: the same file cannot be
  -- committed twice (the unique index below), and a committed import can be
  -- proved to have come from the file somebody still has on disk.
  checksum TEXT NOT NULL,
  jumlah_baris INTEGER NOT NULL CHECK (jumlah_baris >= 0),
  diunggah_oleh UUID NOT NULL REFERENCES app_user(id),
  diunggah_pada TIMESTAMPTZ NOT NULL DEFAULT now(),
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
-- Only COMMITTED files land here (a preview writes nothing at all), so this
-- index is the idempotency guarantee for the whole feature.
CREATE UNIQUE INDEX impor_berkas_checksum_uq
  ON impor_berkas (bumn_id, jenis, checksum) WHERE deleted_at IS NULL;
CREATE INDEX impor_berkas_cabang_idx ON impor_berkas (cabang_id, diunggah_pada DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX impor_berkas_pengunggah_idx ON impor_berkas (diunggah_oleh, diunggah_pada DESC);

CREATE TABLE impor_baris (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  berkas_id UUID NOT NULL REFERENCES impor_berkas(id),
  -- The line number IN THE UPLOADED FILE, 1-based and counting the header, so
  -- a rejection report and an accepted row name the same line the operator
  -- sees in their spreadsheet.
  nomor_baris INTEGER NOT NULL CHECK (nomor_baris >= 1),
  entitas TEXT NOT NULL,
  entitas_id UUID NOT NULL,
  -- Set when the row produced a journal. NOT a foreign key on purpose: the
  -- ledger tables refuse a physical delete and this table does not need to
  -- widen their dependency graph; the id is provenance, not a join key.
  jurnal_id UUID,
  nilai_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX impor_baris_urutan_uq ON impor_baris (berkas_id, nomor_baris);
CREATE INDEX impor_baris_entitas_idx ON impor_baris (entitas, entitas_id);

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES ('impor_berkas'), ('impor_baris')) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES ('impor_berkas'), ('impor_baris')) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES ('impor_berkas'), ('impor_baris')) AS x(t);

-- down
DROP TABLE IF EXISTS impor_baris;
DROP TABLE IF EXISTS impor_berkas;
ALTER TABLE portal_submission DROP COLUMN IF EXISTS pemeriksa_percobaan;
ALTER TABLE portal_akun_mitra DROP COLUMN IF EXISTS harus_ganti_sandi;
