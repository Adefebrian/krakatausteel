-- 0014_lintas_sistem.sql  (spec 4.10)
--
-- Cross-cutting tables: audit trail, attachments, notifications.
-- (konfigurasi and nomor_urut, also listed in spec 4.10, live in 0004 because
-- the whole schema below them depends on their parameters.)
--
-- audit_log is APPEND ONLY, enforced: no UPDATE, no DELETE, for anyone,
-- including a migration. Spec 10.4 #31 says the audit trail cannot be deleted
-- by anyone, and spec 2 rule 5 requires even rejected authorisation attempts
-- to land here. If the log ever needs pruning, that is a new migration that
-- drops the guard deliberately, in the open, with an ADR.

-- up

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  waktu TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES app_user(id),
  ip INET,
  user_agent TEXT,
  aksi TEXT NOT NULL,
  entitas TEXT NOT NULL,
  entitas_id TEXT,
  nilai_lama_json JSONB,
  nilai_baru_json JSONB,
  hasil TEXT NOT NULL DEFAULT 'SUKSES' CHECK (hasil IN ('SUKSES', 'DITOLAK')),
  keterangan TEXT
);
CREATE INDEX audit_log_waktu_idx ON audit_log (waktu DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, waktu DESC);
CREATE INDEX audit_log_entitas_idx ON audit_log (entitas, entitas_id, waktu DESC);
CREATE INDEX audit_log_aksi_idx ON audit_log (aksi, waktu DESC);
-- Rejected attempts are the security-relevant slice; keep them cheap to scan.
CREATE INDEX audit_log_ditolak_idx ON audit_log (waktu DESC) WHERE hasil = 'DITOLAK';

CREATE OR REPLACE FUNCTION tjsl_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'TJSL-AUD-001: audit_log bersifat append only; % tidak diizinkan', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

CREATE TRIGGER trg_audit_log_90_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION tjsl_audit_log_append_only();

CREATE TABLE lampiran (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic by design: attachments hang off a dozen entities and a FK per
  -- entity would mean a migration per new attachable thing. The trade-off
  -- (no referential integrity on entitas_id) is accepted because an orphaned
  -- attachment cannot corrupt a number.
  entitas TEXT NOT NULL,
  entitas_id UUID NOT NULL,
  jenis TEXT,
  nama_file TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  ukuran BIGINT CHECK (ukuran IS NULL OR ukuran >= 0),
  checksum TEXT,
  -- spec names uploaded_by/uploaded_at; those are created_by/created_at here.
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX lampiran_entitas_idx ON lampiran (entitas, entitas_id) WHERE deleted_at IS NULL;

CREATE TABLE notifikasi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id),
  jenis TEXT NOT NULL,
  judul TEXT NOT NULL,
  isi TEXT,
  entitas TEXT,
  entitas_id UUID,
  dibaca_at TIMESTAMPTZ,
  dibuat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifikasi_user_idx ON notifikasi (user_id, dibuat_at DESC);
CREATE INDEX notifikasi_belum_dibaca_idx ON notifikasi (user_id) WHERE dibaca_at IS NULL;

SELECT tjsl_attach_audit_trigger('lampiran');
SELECT tjsl_attach_audit_fk('lampiran');
SELECT tjsl_attach_soft_delete_check('lampiran');

-- down
DROP TABLE IF EXISTS notifikasi;
DROP TABLE IF EXISTS lampiran;
DROP TRIGGER IF EXISTS trg_audit_log_90_append_only ON audit_log;
DROP FUNCTION IF EXISTS tjsl_audit_log_append_only();
DROP TABLE IF EXISTS audit_log;
