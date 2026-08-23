-- 0013_portal.sql  (spec 4.9, spec 9.5)
--
-- Public intake. portal_submission is untrusted input: it stays as submitted
-- JSON until an officer converts it into an internal proposal, and conversion
-- is recorded on both sides (converted_proposal_id here,
-- {pumk,nonpumk}_proposal.portal_submission_id there, FK added below).
--
-- portal_akun_mitra already exists (0006) next to mitra, because it is a
-- credential for an existing borrower rather than part of intake.

-- up

CREATE TABLE portal_submission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  jenis TEXT NOT NULL CHECK (jenis IN ('PUMK', 'NON_PUMK')),
  no_tiket TEXT NOT NULL,
  tanggal_submit TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The form exactly as submitted. Never trusted, never used directly by the
  -- ledger; the officer retypes/validates it into a proposal.
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  dokumen_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_kontak TEXT,
  telepon_kontak TEXT,
  -- Status-check credential (spec 9.5: ticket + NIK or date of birth). Stored
  -- as a hash: it is an authentication secret, not reference data.
  pemeriksa_hash TEXT,
  status TEXT NOT NULL DEFAULT 'BARU'
    CHECK (status IN ('BARU', 'DIPROSES', 'DIKONVERSI', 'DITOLAK')),
  converted_proposal_id UUID,
  ip_submitter INET,
  user_agent TEXT,
  catatan_petugas TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT portal_submission_konversi_ck CHECK (
    status <> 'DIKONVERSI' OR converted_proposal_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX portal_submission_tiket_uq ON portal_submission (no_tiket);
CREATE INDEX portal_submission_status_idx ON portal_submission (jenis, status);
CREATE INDEX portal_submission_tanggal_idx ON portal_submission (tanggal_submit);
-- Rate limiting / anti-spam (spec 9.5) inspects recent submissions per source.
CREATE INDEX portal_submission_ip_idx ON portal_submission (ip_submitter, tanggal_submit);

ALTER TABLE pumk_proposal
  ADD CONSTRAINT pumk_proposal_portal_fk FOREIGN KEY (portal_submission_id) REFERENCES portal_submission(id);
ALTER TABLE nonpumk_proposal
  ADD CONSTRAINT nonpumk_proposal_portal_fk FOREIGN KEY (portal_submission_id) REFERENCES portal_submission(id);
-- One submission converts into at most one proposal.
CREATE UNIQUE INDEX pumk_proposal_portal_uq ON pumk_proposal (portal_submission_id)
  WHERE portal_submission_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX nonpumk_proposal_portal_uq ON nonpumk_proposal (portal_submission_id)
  WHERE portal_submission_id IS NOT NULL AND deleted_at IS NULL;
-- PORTAL_ONLINE proposals must name their submission, and internal ones must
-- not: this is what keeps Laporan Portal (spec 10.4 #25-26) honest.
ALTER TABLE pumk_proposal ADD CONSTRAINT pumk_proposal_sumber_ck CHECK (
  (sumber_pengajuan = 'PORTAL_ONLINE') = (portal_submission_id IS NOT NULL)
);
ALTER TABLE nonpumk_proposal ADD CONSTRAINT nonpumk_proposal_sumber_ck CHECK (
  (sumber_pengajuan = 'PORTAL_ONLINE') = (portal_submission_id IS NOT NULL)
);

SELECT tjsl_attach_audit_trigger('portal_submission');
SELECT tjsl_attach_audit_fk('portal_submission');
SELECT tjsl_attach_soft_delete_check('portal_submission');

-- down
ALTER TABLE nonpumk_proposal DROP CONSTRAINT IF EXISTS nonpumk_proposal_sumber_ck;
ALTER TABLE pumk_proposal DROP CONSTRAINT IF EXISTS pumk_proposal_sumber_ck;
DROP INDEX IF EXISTS nonpumk_proposal_portal_uq;
DROP INDEX IF EXISTS pumk_proposal_portal_uq;
ALTER TABLE nonpumk_proposal DROP CONSTRAINT IF EXISTS nonpumk_proposal_portal_fk;
ALTER TABLE pumk_proposal DROP CONSTRAINT IF EXISTS pumk_proposal_portal_fk;
DROP TABLE IF EXISTS portal_submission;
