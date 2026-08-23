-- 0003_organisasi_master.sql  (spec 4.1)
--
-- Organisation + reference master data. Everything else in the schema hangs
-- off bumn (the reporting entity) and cabang (the branch scope that every
-- authorisation rule in spec 2 is expressed in terms of).
--
-- NAMING: spec calls the user table `user`; that is a reserved word in
-- Postgres (SELECT user), so it is `app_user` here. Same idea for `role`
-- (reserved) -> `app_role`. Documented in docs/DATA-MODEL.md.
--
-- BRANCH HIERARCHY: single level (1 pusat + N cabang), i.e. cabang has no
-- parent_id. See ASSUMPTIONS.md A-01; adding a level later is an additive
-- migration (cabang.parent_id + a recursive CTE in reporting), not a rewrite.

-- up

CREATE TABLE bumn (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  npwp TEXT,
  alamat TEXT,
  -- First month of the fiscal year (spec 5.6 tahun_buku_mulai_bulan, default 1).
  tahun_buku_mulai_bulan SMALLINT NOT NULL DEFAULT 1 CHECK (tahun_buku_mulai_bulan BETWEEN 1 AND 12),
  tahun_buku_mulai SMALLINT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX bumn_kode_uq ON bumn (kode) WHERE deleted_at IS NULL;

CREATE TABLE provinsi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kode_bps TEXT NOT NULL,
  nama TEXT NOT NULL,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX provinsi_kode_bps_uq ON provinsi (kode_bps) WHERE deleted_at IS NULL;

CREATE TABLE kota (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provinsi_id UUID NOT NULL REFERENCES provinsi(id),
  kode_bps TEXT NOT NULL,
  nama TEXT NOT NULL,
  tipe TEXT NOT NULL CHECK (tipe IN ('KOTA', 'KABUPATEN')),
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX kota_kode_bps_uq ON kota (kode_bps) WHERE deleted_at IS NULL;
CREATE INDEX kota_provinsi_idx ON kota (provinsi_id);

CREATE TABLE cabang (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  alamat TEXT,
  kota_id UUID REFERENCES kota(id),
  is_pusat BOOLEAN NOT NULL DEFAULT false,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX cabang_kode_uq ON cabang (bumn_id, kode) WHERE deleted_at IS NULL;
-- Exactly one head office per BUMN: the report header, the pusat-level
-- numbering series and the "Semua Cabang" scope all assume a single pusat.
CREATE UNIQUE INDEX cabang_satu_pusat_uq ON cabang (bumn_id) WHERE is_pusat AND deleted_at IS NULL;

CREATE TABLE app_user (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  nip TEXT,
  nama TEXT NOT NULL,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  aktif BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX app_user_username_uq ON app_user (lower(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX app_user_cabang_idx ON app_user (cabang_id) WHERE deleted_at IS NULL;

CREATE TABLE app_role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  deskripsi TEXT,
  -- System roles (MAKER, CHECKER, APPROVER, ADMIN_CABANG, ADMIN_PUSAT,
  -- AUDITOR) cannot be deleted by the config UI; spec 2 hard-codes the
  -- segregation-of-duties rules against them.
  is_system BOOLEAN NOT NULL DEFAULT false,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX app_role_kode_uq ON app_role (kode) WHERE deleted_at IS NULL;

CREATE TABLE permission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Granular per action, e.g. 'pumk.proposal.create', 'jurnal.post',
  -- 'periode.close', 'periode.reopen' (spec 4.1).
  kode TEXT NOT NULL,
  grup TEXT NOT NULL,
  deskripsi TEXT,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX permission_kode_uq ON permission (kode);

CREATE TABLE role_permission (
  role_id UUID NOT NULL REFERENCES app_role(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role (
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES app_role(id) ON DELETE CASCADE,
  -- NULL = the role applies in the user's own cabang. A non-null value grants
  -- the role in another cabang (how a pusat reviewer covers a branch) without
  -- widening the user's home scope.
  scope_cabang_id UUID REFERENCES cabang(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_role_role_idx ON user_role (role_id);

CREATE TABLE karyawan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  nip TEXT,
  nama TEXT NOT NULL,
  jabatan TEXT,
  unit TEXT,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX karyawan_nip_uq ON karyawan (nip) WHERE nip IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX karyawan_cabang_idx ON karyawan (cabang_id) WHERE deleted_at IS NULL;

CREATE TABLE sektor_pumk (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  keterangan TEXT,
  urutan SMALLINT NOT NULL DEFAULT 0,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX sektor_pumk_kode_uq ON sektor_pumk (bumn_id, kode) WHERE deleted_at IS NULL;

CREATE TABLE bidang_non_pumk (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  urutan SMALLINT NOT NULL DEFAULT 0,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX bidang_non_pumk_kode_uq ON bidang_non_pumk (bumn_id, kode) WHERE deleted_at IS NULL;

CREATE TABLE sdg (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nomor SMALLINT NOT NULL CHECK (nomor BETWEEN 1 AND 17),
  nama TEXT NOT NULL,
  target_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX sdg_nomor_uq ON sdg (nomor) WHERE deleted_at IS NULL;

CREATE TABLE cluster (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  sektor_id UUID REFERENCES sektor_pumk(id),
  -- FK to mitra is added in 0006 (mitra is defined there; the reference is
  -- circular because a cluster's chair is one of its own members).
  ketua_mitra_id UUID,
  keterangan TEXT,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX cluster_kode_uq ON cluster (cabang_id, kode) WHERE deleted_at IS NULL;
CREATE INDEX cluster_cabang_idx ON cluster (cabang_id) WHERE deleted_at IS NULL;

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('bumn'), ('provinsi'), ('kota'), ('cabang'), ('app_user'), ('app_role'),
  ('karyawan'), ('sektor_pumk'), ('bidang_non_pumk'), ('sdg'), ('cluster')
) AS x(t);

SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('bumn'), ('provinsi'), ('kota'), ('cabang'), ('app_user'), ('app_role'),
  ('karyawan'), ('sektor_pumk'), ('bidang_non_pumk'), ('sdg'), ('cluster')
) AS x(t);

SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('bumn'), ('provinsi'), ('kota'), ('cabang'), ('app_user'), ('app_role'),
  ('karyawan'), ('sektor_pumk'), ('bidang_non_pumk'), ('sdg'), ('cluster')
) AS x(t);

-- down
-- One statement with CASCADE: bumn -> cabang -> app_user -> (audit FK back to
-- app_user on bumn/cabang/kota/provinsi) is a genuine FK cycle, so no drop
-- order exists. Safe here because `migrate down` runs in reverse order, so
-- every table from a later migration is already gone.
DROP TABLE IF EXISTS
  cluster, sdg, bidang_non_pumk, sektor_pumk, karyawan,
  user_role, role_permission, permission, app_role, app_user,
  cabang, kota, provinsi, bumn
CASCADE;
