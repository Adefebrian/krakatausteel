-- 0010_jurnal.sql  (spec 4.6, spec 6, invariants 1-5, 11)
--
-- The ledger. This is the one migration where the database, not the service
-- layer, is the last line of defence, because every number the auditor will
-- see is derived from these two tables.
--
-- WHAT IS ENFORCED HERE, AND HOW
--
-- inv 3, one side per line: plain CHECK on jurnal_baris. debit and kredit are
--   both >= 0 and exactly one of them is > 0. A zero-zero line is rejected
--   too, so a "placeholder" line cannot exist.
--
-- inv 1 + 2, balanced and at least 2 lines: a DEFERRED CONSTRAINT TRIGGER on
--   jurnal that fires when the row is POSTED. Deferred is deliberate: a DRAFT
--   jurnal mid-edit is allowed to be unbalanced (that is what DRAFT means, and
--   the maker types one line at a time), and even the POST itself needs to be
--   able to write the header and the lines in any order inside one
--   transaction. The check therefore runs at COMMIT of the transaction that
--   left the jurnal POSTED, which is the exact moment the invariant must hold.
--   Consequence to know: the error surfaces on COMMIT, not on the offending
--   statement, so the service layer must post inside an explicit transaction
--   and treat commit failure as a validation error.
--
-- inv 4, POSTED is immutable: three triggers. UPDATE of a POSTED jurnal is
--   allowed only for the reversal transition (status -> REVERSED plus
--   reversed_by_jurnal_id) and the audit columns; every other column change
--   raises. DELETE of a non-DRAFT jurnal raises. Any UPDATE or DELETE of a
--   line whose parent is not DRAFT raises. Note that deleted_at is NOT in the
--   allowed set: a POSTED jurnal cannot be soft-deleted either, because that
--   would silently remove it from every report. Correction is a reversal.
--
-- inv 5, no posting into a CLOSED period: trigger on jurnal, resolved from
--   tanggal_transaksi (not created_at) via tjsl_periode_untuk_tanggal, and it
--   also forces periode_id to be the period that date actually falls in, so
--   the two can never disagree.
--
-- is_postable: jurnal_baris.akun_id is a real FK to akun(postable_id), the
--   generated column from 0005. A header account has postable_id NULL and can
--   therefore never be referenced. akun.aktif is checked by trigger on INSERT
--   only, because deactivating an account must not break existing lines.
--
-- inv 11, one central path: event_jurnal_mapping is a table, not a TypeScript
--   map, so the account behind an event can be corrected by an accountant
--   without a deploy, and so the mapping in force is queryable evidence during
--   an audit. See docs/adr/0004.

-- up

CREATE TABLE jurnal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalised from cabang: needed by the period guard (periods are per
  -- bumn) and by document numbering. Kept in step by trigger.
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  no_jurnal TEXT NOT NULL,
  jenis TEXT NOT NULL CHECK (jenis IN
    ('KAS_BANK', 'UMUM', 'PINBUK', 'OTOMATIS', 'PENYISIHAN', 'AKRUAL', 'REVERSAL', 'CLOSING', 'SALDO_AWAL')),
  tanggal_transaksi DATE NOT NULL,
  periode_id UUID NOT NULL REFERENCES periode(id),
  keterangan TEXT,
  -- Polymorphic back-reference to the business event that produced this
  -- jurnal (e.g. 'pumk_pencairan' + its id). Not an FK: it spans a dozen
  -- tables. The forward direction (pumk_pencairan.jurnal_id) IS an FK.
  referensi_tipe TEXT,
  referensi_id UUID,
  -- Maintained by trigger from the lines; never trust a caller-supplied value.
  total_debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
  total_kredit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_kredit >= 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  is_auto_generated BOOLEAN NOT NULL DEFAULT false,
  -- Set on a reversing jurnal, pointing at what it reverses.
  reversal_of_jurnal_id UUID REFERENCES jurnal(id),
  -- Set on the reversed original, pointing at its reversal.
  reversed_by_jurnal_id UUID REFERENCES jurnal(id),
  -- Idempotency key for the closing engine (invariant 13): one jurnal per
  -- (event, periode, cabang) scope. NULL for manual journals.
  kunci_idempotensi TEXT,
  verified_by UUID REFERENCES app_user(id),
  verified_at TIMESTAMPTZ,
  posted_by UUID REFERENCES app_user(id),
  posted_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT jurnal_posted_jejak_ck CHECK (
    status = 'DRAFT' OR (posted_by IS NOT NULL AND posted_at IS NOT NULL)
  ),
  CONSTRAINT jurnal_reversed_jejak_ck CHECK (
    status <> 'REVERSED' OR reversed_by_jurnal_id IS NOT NULL
  ),
  -- A jurnal cannot reverse itself.
  CONSTRAINT jurnal_reversal_diri_ck CHECK (reversal_of_jurnal_id IS DISTINCT FROM id),
  CONSTRAINT jurnal_reversed_diri_ck CHECK (reversed_by_jurnal_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX jurnal_no_uq ON jurnal (bumn_id, no_jurnal) WHERE deleted_at IS NULL;
-- One reversal per original, and one original per reversal.
CREATE UNIQUE INDEX jurnal_reversal_of_uq ON jurnal (reversal_of_jurnal_id) WHERE reversal_of_jurnal_id IS NOT NULL;
CREATE UNIQUE INDEX jurnal_reversed_by_uq ON jurnal (reversed_by_jurnal_id) WHERE reversed_by_jurnal_id IS NOT NULL;
-- Closing idempotency (invariant 13): re-running a closing step cannot create
-- a second jurnal for the same scope.
CREATE UNIQUE INDEX jurnal_idempotensi_uq ON jurnal (kunci_idempotensi)
  WHERE kunci_idempotensi IS NOT NULL AND deleted_at IS NULL;

-- Report-shaped indexes (spec 10):
--   branch scope + date range, the filter every report header carries
CREATE INDEX jurnal_cabang_tanggal_idx ON jurnal (cabang_id, tanggal_transaksi)
  WHERE status = 'POSTED' AND deleted_at IS NULL;
--   period-based reads: Rekap Jurnal, Neraca Lajur, closing prerequisites
CREATE INDEX jurnal_periode_status_idx ON jurnal (periode_id, status) WHERE deleted_at IS NULL;
CREATE INDEX jurnal_periode_jenis_idx ON jurnal (periode_id, jenis) WHERE deleted_at IS NULL;
--   "are there DRAFT journals dated in this period" (spec 8.4 check 2)
CREATE INDEX jurnal_draft_idx ON jurnal (bumn_id, tanggal_transaksi) WHERE status = 'DRAFT' AND deleted_at IS NULL;
CREATE INDEX jurnal_referensi_idx ON jurnal (referensi_tipe, referensi_id) WHERE referensi_id IS NOT NULL;
CREATE INDEX jurnal_tanggal_idx ON jurnal (tanggal_transaksi);

CREATE TABLE jurnal_baris (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurnal_id UUID NOT NULL REFERENCES jurnal(id),
  urutan SMALLINT NOT NULL CHECK (urutan >= 1),
  -- FK to the generated postable_id, not to id: this is what makes "only
  -- postable accounts can be posted to" a declarative constraint.
  akun_id UUID NOT NULL REFERENCES akun(postable_id),
  debit NUMERIC(20,2) NOT NULL DEFAULT 0,
  kredit NUMERIC(20,2) NOT NULL DEFAULT 0,
  keterangan TEXT,
  -- Piutang sub-ledger dimensions (spec 4.6).
  mitra_id UUID REFERENCES mitra(id),
  akad_id UUID REFERENCES pumk_akad(id),
  -- Analytic dimensions for reporting: sektor, bidang, SDG, program, kategori
  -- pinbuk. JSONB because the set differs per journal type and none of them
  -- affect the double entry itself.
  dimensi_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Invariant 3, verbatim: never both, never neither, never negative.
  CONSTRAINT jurnal_baris_satu_sisi_ck CHECK (
    debit >= 0 AND kredit >= 0
    AND ((debit > 0 AND kredit = 0) OR (kredit > 0 AND debit = 0))
  ),
  CONSTRAINT jurnal_baris_urutan_uq UNIQUE (jurnal_id, urutan)
);
CREATE INDEX jurnal_baris_jurnal_idx ON jurnal_baris (jurnal_id, urutan);
CREATE INDEX jurnal_baris_akun_idx ON jurnal_baris (akun_id);
CREATE INDEX jurnal_baris_mitra_idx ON jurnal_baris (mitra_id) WHERE mitra_id IS NOT NULL;
CREATE INDEX jurnal_baris_akad_idx ON jurnal_baris (akad_id) WHERE akad_id IS NOT NULL;
-- The single most important query in the system (spec 8.4 check 10): the
-- piutang sub-ledger reconciliation, SUM per akad on the receivable account
-- versus SUM(akad.outstanding_pokok). Covering index so it never touches the
-- heap for the amounts.
CREATE INDEX jurnal_baris_rekonsiliasi_idx ON jurnal_baris (akun_id, akad_id)
  INCLUDE (debit, kredit) WHERE akad_id IS NOT NULL AND deleted_at IS NULL;
-- Buku Besar (spec 10.3 #22) drills per account inside a journal date range.
CREATE INDEX jurnal_baris_akun_jurnal_idx ON jurnal_baris (akun_id, jurnal_id) WHERE deleted_at IS NULL;

CREATE TABLE event_jurnal_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  event_code TEXT NOT NULL,
  deskripsi TEXT,
  akun_debit_id UUID REFERENCES akun(postable_id),
  akun_kredit_id UUID REFERENCES akun(postable_id),
  -- Some events resolve one leg at runtime instead of from this row:
  -- PENYALURAN_NON_PUMK debits a per-bidang expense account, BEBAN_OPERASIONAL
  -- debits a per-type expense account, and every cash leg uses the akun_kas_id
  -- chosen on the form. These flags tell the posting engine which leg it must
  -- supply, and let the NOT NULL rule below stay strict for everything else.
  debit_dari_payload BOOLEAN NOT NULL DEFAULT false,
  kredit_dari_payload BOOLEAN NOT NULL DEFAULT false,
  jenis_jurnal TEXT NOT NULL DEFAULT 'OTOMATIS' CHECK (jenis_jurnal IN
    ('KAS_BANK', 'UMUM', 'PINBUK', 'OTOMATIS', 'PENYISIHAN', 'AKRUAL', 'REVERSAL', 'CLOSING', 'SALDO_AWAL')),
  aktif BOOLEAN NOT NULL DEFAULT true,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT event_jurnal_mapping_debit_ck CHECK (debit_dari_payload OR akun_debit_id IS NOT NULL),
  CONSTRAINT event_jurnal_mapping_kredit_ck CHECK (kredit_dari_payload OR akun_kredit_id IS NOT NULL),
  CONSTRAINT event_jurnal_mapping_beda_akun_ck CHECK (
    akun_debit_id IS NULL OR akun_kredit_id IS NULL OR akun_debit_id <> akun_kredit_id
  )
);
CREATE UNIQUE INDEX event_jurnal_mapping_aktif_uq
  ON event_jurnal_mapping (bumn_id, event_code) WHERE aktif AND deleted_at IS NULL;
CREATE INDEX event_jurnal_mapping_code_idx ON event_jurnal_mapping (event_code);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- bumn_id must match the cabang, and periode_id must be the period that
-- tanggal_transaksi falls in, and that period must not be CLOSED (invariant 5).
CREATE OR REPLACE FUNCTION tjsl_jurnal_validasi_periode() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_bumn UUID;
  p periode;
BEGIN
  SELECT bumn_id INTO v_bumn FROM cabang WHERE id = NEW.cabang_id;
  IF v_bumn IS DISTINCT FROM NEW.bumn_id THEN
    RAISE EXCEPTION 'TJSL-JRN-001: bumn_id jurnal (%) tidak cocok dengan bumn cabang (%)', NEW.bumn_id, v_bumn
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  p := tjsl_periode_untuk_tanggal(NEW.bumn_id, NEW.tanggal_transaksi);
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'TJSL-JRN-002: tidak ada periode yang memuat tanggal transaksi %', NEW.tanggal_transaksi
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p.id <> NEW.periode_id THEN
    RAISE EXCEPTION
      'TJSL-JRN-003: periode_id tidak sesuai tanggal transaksi %; seharusnya periode %-%',
      NEW.tanggal_transaksi, p.tahun, p.bulan
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Blocks both "post into a closed period" and "create a new jurnal dated
  -- into a closed period" (a DRAFT that could never be posted is a trap, and
  -- reversals must be dated in an open period).
  IF p.status = 'CLOSED' THEN
    RAISE EXCEPTION
      'TJSL-JRN-004: periode %-% sudah CLOSED; tidak boleh ada jurnal bertanggal % (koreksi lewat jurnal pembalik di periode terbuka)',
      p.tahun, p.bulan, NEW.tanggal_transaksi
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_jurnal_10_periode
  BEFORE INSERT OR UPDATE OF tanggal_transaksi, periode_id, cabang_id, bumn_id, status ON jurnal
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_validasi_periode();

-- Invariant 4: POSTED is immutable except for the reversal transition.
CREATE OR REPLACE FUNCTION tjsl_jurnal_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  -- Allowed: POSTED -> REVERSED, and nothing else about the status.
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED') THEN
    RAISE EXCEPTION
      'TJSL-JRN-010: jurnal % berstatus %; transisi ke % tidak diizinkan (koreksi lewat jurnal pembalik)',
      OLD.no_jurnal, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.bumn_id <> OLD.bumn_id
     OR NEW.cabang_id <> OLD.cabang_id
     OR NEW.no_jurnal <> OLD.no_jurnal
     OR NEW.jenis <> OLD.jenis
     OR NEW.tanggal_transaksi <> OLD.tanggal_transaksi
     OR NEW.periode_id <> OLD.periode_id
     OR NEW.total_debit <> OLD.total_debit
     OR NEW.total_kredit <> OLD.total_kredit
     OR NEW.keterangan IS DISTINCT FROM OLD.keterangan
     OR NEW.referensi_tipe IS DISTINCT FROM OLD.referensi_tipe
     OR NEW.referensi_id IS DISTINCT FROM OLD.referensi_id
     OR NEW.reversal_of_jurnal_id IS DISTINCT FROM OLD.reversal_of_jurnal_id
     OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
     OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION
      'TJSL-JRN-011: jurnal % sudah %; kolom keuangan/identitas tidak bisa diubah dan tidak bisa di-soft-delete',
      OLD.no_jurnal, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_jurnal_20_immutable
  BEFORE UPDATE ON jurnal
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_immutable();

CREATE OR REPLACE FUNCTION tjsl_jurnal_block_delete() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'TJSL-JRN-012: jurnal % berstatus % tidak bisa dihapus secara fisik; gunakan jurnal pembalik (reversal)',
      OLD.no_jurnal, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER trg_jurnal_30_no_delete
  BEFORE DELETE ON jurnal
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_block_delete();

-- Lines of a non-DRAFT jurnal are frozen, both UPDATE and DELETE.
-- jurnal_baris.jurnal_id has no ON DELETE CASCADE precisely so that this
-- trigger always has a parent row to inspect: deleting a DRAFT jurnal means
-- deleting its lines first, explicitly.
CREATE OR REPLACE FUNCTION tjsl_jurnal_baris_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_status TEXT;
  v_no TEXT;
  r RECORD;
BEGIN
  r := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  SELECT status, no_jurnal INTO v_status, v_no FROM jurnal WHERE id = r.jurnal_id;

  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'TJSL-JRN-013: baris jurnal % (status %) tidak bisa diubah atau dihapus; gunakan jurnal pembalik',
      v_no, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.jurnal_id <> NEW.jurnal_id THEN
    RAISE EXCEPTION 'TJSL-JRN-014: baris jurnal tidak boleh dipindahkan ke jurnal lain'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN r;
END;
$fn$;

CREATE TRIGGER trg_jurnal_baris_20_immutable
  BEFORE UPDATE OR DELETE ON jurnal_baris
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_baris_immutable();

-- akun.aktif is checked on INSERT only: an account may be deactivated later
-- (spec 4.2 allows deactivate, forbids delete) without invalidating history.
CREATE OR REPLACE FUNCTION tjsl_jurnal_baris_cek_akun() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  a RECORD;
BEGIN
  SELECT kode, nama, aktif, deleted_at INTO a FROM akun WHERE id = NEW.akun_id;
  IF a.aktif IS NOT TRUE OR a.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'TJSL-JRN-020: akun % (%) tidak aktif dan tidak boleh dipakai di jurnal baru', a.kode, a.nama
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_jurnal_baris_10_akun
  BEFORE INSERT ON jurnal_baris
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_baris_cek_akun();

-- Totals are derived, never asserted: recomputed from the lines on every line
-- change, so spec 8.4 check 3 ("do not trust the total column") holds by
-- construction while the column stays available for cheap reporting.
CREATE OR REPLACE FUNCTION tjsl_jurnal_hitung_total() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_jurnal UUID;
BEGIN
  v_jurnal := CASE TG_OP WHEN 'DELETE' THEN OLD.jurnal_id ELSE NEW.jurnal_id END;

  UPDATE jurnal j
     SET total_debit = t.d, total_kredit = t.k
    FROM (
      SELECT coalesce(sum(debit), 0) AS d, coalesce(sum(kredit), 0) AS k
      FROM jurnal_baris WHERE jurnal_id = v_jurnal AND deleted_at IS NULL
    ) t
   WHERE j.id = v_jurnal
     AND (j.total_debit <> t.d OR j.total_kredit <> t.k);

  RETURN NULL;
END;
$fn$;

CREATE TRIGGER trg_jurnal_baris_50_total
  AFTER INSERT OR UPDATE OR DELETE ON jurnal_baris
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_hitung_total();

-- Invariants 1 and 2, checked at COMMIT of the transaction that leaves the
-- jurnal POSTED. See the file header for why this is deferred.
CREATE OR REPLACE FUNCTION tjsl_jurnal_cek_balance() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_status TEXT;
  v_baris INTEGER;
  v_debit NUMERIC(20,2);
  v_kredit NUMERIC(20,2);
  v_td NUMERIC(20,2);
  v_tk NUMERIC(20,2);
BEGIN
  -- Re-read: by COMMIT time the row may have been reverted to DRAFT or
  -- deleted, in which case there is nothing to check.
  SELECT status, total_debit, total_kredit INTO v_status, v_td, v_tk
  FROM jurnal WHERE id = NEW.id;
  IF NOT FOUND OR v_status = 'DRAFT' THEN
    RETURN NULL;
  END IF;

  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(kredit), 0)
    INTO v_baris, v_debit, v_kredit
  FROM jurnal_baris WHERE jurnal_id = NEW.id AND deleted_at IS NULL;

  IF v_baris < 2 THEN
    RAISE EXCEPTION
      'TJSL-JRN-030: jurnal % hanya punya % baris; minimal 2 baris (invarian 2)', NEW.no_jurnal, v_baris
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_debit <> v_kredit THEN
    RAISE EXCEPTION
      'TJSL-JRN-031: jurnal % tidak balance: total debit % vs total kredit % (selisih %)',
      NEW.no_jurnal, v_debit, v_kredit, v_debit - v_kredit
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_td <> v_debit OR v_tk <> v_kredit THEN
    RAISE EXCEPTION
      'TJSL-JRN-032: kolom total jurnal % (D % / K %) tidak cocok dengan jumlah barisnya (D % / K %)',
      NEW.no_jurnal, v_td, v_tk, v_debit, v_kredit
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_jurnal_90_balance
  AFTER INSERT OR UPDATE ON jurnal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status <> 'DRAFT')
  EXECUTE FUNCTION tjsl_jurnal_cek_balance();

-- spec 4.2: an account used by a POSTED jurnal may be deactivated, never
-- removed. is_postable is already protected by the FK to postable_id; this
-- covers the soft-delete path.
CREATE OR REPLACE FUNCTION tjsl_akun_cegah_hapus_terpakai() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_ada INTEGER;
BEGIN
  IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_ada
  FROM jurnal_baris b JOIN jurnal j ON j.id = b.jurnal_id
  WHERE b.akun_id = NEW.id AND j.status IN ('POSTED', 'REVERSED');
  IF v_ada > 0 THEN
    RAISE EXCEPTION
      'TJSL-COA-010: akun % dipakai di % baris jurnal POSTED; hanya boleh dinonaktifkan (aktif = false), tidak dihapus',
      NEW.kode, v_ada
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_akun_20_cegah_hapus
  BEFORE UPDATE OF deleted_at ON akun
  FOR EACH ROW EXECUTE FUNCTION tjsl_akun_cegah_hapus_terpakai();

SELECT tjsl_attach_block_delete('akun');

-- ---------------------------------------------------------------------------
-- Forward links from business events to the jurnal that recorded them.
-- Declared here because jurnal did not exist when those tables were created.
-- ---------------------------------------------------------------------------
ALTER TABLE saldo_awal_batch    ADD CONSTRAINT saldo_awal_batch_jurnal_fk    FOREIGN KEY (jurnal_id) REFERENCES jurnal(id);
ALTER TABLE pumk_pencairan      ADD CONSTRAINT pumk_pencairan_jurnal_fk      FOREIGN KEY (jurnal_id) REFERENCES jurnal(id);
ALTER TABLE pumk_angsuran       ADD CONSTRAINT pumk_angsuran_jurnal_fk       FOREIGN KEY (jurnal_id) REFERENCES jurnal(id);
ALTER TABLE pumk_pengakhiran    ADD CONSTRAINT pumk_pengakhiran_jurnal_fk    FOREIGN KEY (jurnal_id) REFERENCES jurnal(id);
ALTER TABLE pumk_kelebihan      ADD CONSTRAINT pumk_kelebihan_jurnal_terima_fk  FOREIGN KEY (jurnal_id_terima)  REFERENCES jurnal(id);
ALTER TABLE pumk_kelebihan      ADD CONSTRAINT pumk_kelebihan_jurnal_kembali_fk FOREIGN KEY (jurnal_id_kembali) REFERENCES jurnal(id);
ALTER TABLE nonpumk_penyaluran  ADD CONSTRAINT nonpumk_penyaluran_jurnal_fk  FOREIGN KEY (jurnal_id) REFERENCES jurnal(id);
ALTER TABLE nonpumk_lpj         ADD CONSTRAINT nonpumk_lpj_jurnal_fk         FOREIGN KEY (jurnal_id_pengembalian) REFERENCES jurnal(id);

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('jurnal'), ('jurnal_baris'), ('event_jurnal_mapping')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('jurnal'), ('jurnal_baris'), ('event_jurnal_mapping')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('jurnal'), ('jurnal_baris'), ('event_jurnal_mapping')
) AS x(t);

-- down
ALTER TABLE nonpumk_lpj         DROP CONSTRAINT IF EXISTS nonpumk_lpj_jurnal_fk;
ALTER TABLE nonpumk_penyaluran  DROP CONSTRAINT IF EXISTS nonpumk_penyaluran_jurnal_fk;
ALTER TABLE pumk_kelebihan      DROP CONSTRAINT IF EXISTS pumk_kelebihan_jurnal_kembali_fk;
ALTER TABLE pumk_kelebihan      DROP CONSTRAINT IF EXISTS pumk_kelebihan_jurnal_terima_fk;
ALTER TABLE pumk_pengakhiran    DROP CONSTRAINT IF EXISTS pumk_pengakhiran_jurnal_fk;
ALTER TABLE pumk_angsuran       DROP CONSTRAINT IF EXISTS pumk_angsuran_jurnal_fk;
ALTER TABLE pumk_pencairan      DROP CONSTRAINT IF EXISTS pumk_pencairan_jurnal_fk;
ALTER TABLE saldo_awal_batch    DROP CONSTRAINT IF EXISTS saldo_awal_batch_jurnal_fk;
DROP TRIGGER IF EXISTS trg_akun_90_no_delete ON akun;
DROP TRIGGER IF EXISTS trg_akun_20_cegah_hapus ON akun;
DROP FUNCTION IF EXISTS tjsl_akun_cegah_hapus_terpakai();
DROP TABLE IF EXISTS event_jurnal_mapping;
DROP TABLE IF EXISTS jurnal_baris;
DROP TABLE IF EXISTS jurnal;
DROP FUNCTION IF EXISTS tjsl_jurnal_cek_balance();
DROP FUNCTION IF EXISTS tjsl_jurnal_hitung_total();
DROP FUNCTION IF EXISTS tjsl_jurnal_baris_cek_akun();
DROP FUNCTION IF EXISTS tjsl_jurnal_baris_immutable();
DROP FUNCTION IF EXISTS tjsl_jurnal_block_delete();
DROP FUNCTION IF EXISTS tjsl_jurnal_immutable();
DROP FUNCTION IF EXISTS tjsl_jurnal_validasi_periode();
