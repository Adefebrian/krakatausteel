-- 0019_restruktur_pokok.sql
--
-- Closes a real hole found by the angsuran engine tests: `pumk_reschedule.jenis`
-- allows 'RESTRUKTUR_POKOK', but the table had no column for a changed
-- principal, so spec 7.3 item 7's second branch ("kalau ada penambahan atau
-- pengurangan pokok, buat jurnal koreksi") was unreachable from the schema.
-- Only the "no journal when the principal is unchanged" half was testable.
--
-- FOUR DECISIONS, made deliberately (ADR 0011 has the full reasoning):
--
-- 1. ABSOLUTE, FROZEN BASIS, AND A GENERATED DELTA. Not one or the other: the
--    correction journal's amount is a difference, and a difference is only
--    unambiguous when both of its operands are recorded. So the row stores the
--    outstanding principal AT APPROVAL (outstanding_pokok_sebelum, the basis
--    spec 7.3 step 2 computes) and the new absolute principal (pokok_baru),
--    and delta_pokok is a STORED GENERATED column. The journal amount can then
--    never disagree with the two numbers it was derived from, and it stays
--    reconstructable years later even after further payments move outstanding.
--
-- 2. A CHECK, NOT A CONVENTION. pokok_baru exists if and only if
--    jenis = 'RESTRUKTUR_POKOK'. A tenor extension carrying a principal, or a
--    principal restructure without one, are both rejected by the database
--    rather than by a code comment.
--
-- 3. THE VERSION-1 INVARIANT NOW HAS ITS COMPANION. 0008 enforced
--    SUM(pokok) = akad.pokok_pinjaman for version 1 only (ASSUMPTIONS A-19),
--    because a later version restructures the remaining balance. That left
--    versions above 1 unchecked. They are checkable, via the link
--    pumk_jadwal_versi.reschedule_id that 0008 already created: the basis for
--    version v > 1 is coalesce(pokok_baru, outstanding_pokok_sebelum) of the
--    reschedule that produced it. Enforced deferred, same as version 1.
--
-- 4. akad.pokok_pinjaman STAYS IMMUTABLE. A restructure does not rewrite the
--    signed contract amount; it accumulates into pokok_restruktur_kumulatif,
--    and the current contractual principal is the generated column
--    pokok_pinjaman_efektif. Two reasons beyond bookkeeping taste: mutating
--    pokok_pinjaman would break the already-pushed version-1 invariant (the
--    original schedule's total would no longer match), and a principal
--    INCREASE would violate the old CHECK outstanding_pokok <= pokok_pinjaman.
--    That CHECK is therefore replaced here with one against the effective
--    principal. Whether the client's accountants want the contract amount
--    restated instead is a policy question, recorded in OPEN-QUESTIONS item 21;
--    the conservative option is implemented.
--
-- ALSO: konfigurasi row angsuran.hari_jatuh_tempo_tetap (spec 7.1 fixed-due-day
-- option). Deliberately added HERE and not appended to 0004's INSERT: 0004 is
-- already applied everywhere, so editing its INSERT would be a no-op on every
-- existing database and would silently make a fresh install differ from a
-- migrated one. A config row is data; new data needs a new migration.

-- up

-- ---------------------------------------------------------------------------
-- 1. The restructured principal
-- ---------------------------------------------------------------------------

ALTER TABLE pumk_reschedule
  -- Spec 7.3 step 2: the outstanding computed at approval. Frozen here so the
  -- correction journal and the new schedule are both reconstructable.
  ADD COLUMN outstanding_pokok_sebelum NUMERIC(20,2)
    CHECK (outstanding_pokok_sebelum IS NULL OR outstanding_pokok_sebelum >= 0),
  ADD COLUMN outstanding_jasa_sebelum NUMERIC(20,2)
    CHECK (outstanding_jasa_sebelum IS NULL OR outstanding_jasa_sebelum >= 0),
  -- The new absolute principal the version-2 schedule is generated from.
  -- Only meaningful for jenis = 'RESTRUKTUR_POKOK'.
  ADD COLUMN pokok_baru NUMERIC(20,2) CHECK (pokok_baru IS NULL OR pokok_baru > 0),
  -- Positive = penambahan pokok, negative = pengurangan pokok. This is the
  -- amount of the correction journal, derived rather than typed, so it cannot
  -- drift from the two figures it is the difference of.
  ADD COLUMN delta_pokok NUMERIC(20,2)
    GENERATED ALWAYS AS (pokok_baru - outstanding_pokok_sebelum) STORED,
  -- The correction journal from spec 7.3 item 7. FK to jurnal, like every other
  -- money event in this schema.
  ADD COLUMN jurnal_id_koreksi UUID REFERENCES jurnal(id);

COMMENT ON COLUMN pumk_reschedule.delta_pokok IS
  'Generated: pokok_baru - outstanding_pokok_sebelum. Positive = penambahan pokok, negative = pengurangan. NULL means no principal change, which per spec 7.3 item 7 means no correction journal.';

ALTER TABLE pumk_reschedule
  -- Decision 2: the principal column belongs to exactly one jenis.
  ADD CONSTRAINT pumk_reschedule_pokok_baru_jenis_ck CHECK (
    (jenis = 'RESTRUKTUR_POKOK') = (pokok_baru IS NOT NULL)
  ),
  -- An approved reschedule must know the balance it restructured; without it
  -- neither the new schedule nor the delta is defined.
  ADD CONSTRAINT pumk_reschedule_basis_ck CHECK (
    status <> 'DISETUJUI' OR outstanding_pokok_sebelum IS NOT NULL
  ),
  -- A principal restructure that does not change the principal is not a
  -- restructure; it is a tenor or grace change wearing the wrong jenis.
  ADD CONSTRAINT pumk_reschedule_delta_bukan_nol_ck CHECK (
    jenis <> 'RESTRUKTUR_POKOK'
    OR status <> 'DISETUJUI'
    OR (pokok_baru IS NOT NULL AND outstanding_pokok_sebelum IS NOT NULL
        AND pokok_baru <> outstanding_pokok_sebelum)
  ),
  -- Spec 7.3 item 7, first half: a reschedule with no principal change makes no
  -- journal. So a correction journal can only ever hang off a principal
  -- restructure.
  ADD CONSTRAINT pumk_reschedule_koreksi_jenis_ck CHECK (
    jurnal_id_koreksi IS NULL OR jenis = 'RESTRUKTUR_POKOK'
  );

-- Spec 7.3 item 7, second half: an approved principal restructure MUST have its
-- correction journal. Deferred, so the engine can write the reschedule row and
-- the journal in one transaction in either order.
CREATE OR REPLACE FUNCTION tjsl_reschedule_cek_koreksi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  r RECORD;
BEGIN
  SELECT jenis, status, jurnal_id_koreksi, delta_pokok, deleted_at
    INTO r FROM pumk_reschedule WHERE id = NEW.id;
  IF NOT FOUND OR r.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF r.jenis = 'RESTRUKTUR_POKOK' AND r.status = 'DISETUJUI' AND r.jurnal_id_koreksi IS NULL THEN
    RAISE EXCEPTION
      'TJSL-RSC-001: reschedule RESTRUKTUR_POKOK yang DISETUJUI wajib punya jurnal koreksi (delta pokok %); spec 7.3 butir 7',
      r.delta_pokok
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_pumk_reschedule_50_koreksi
  AFTER INSERT OR UPDATE ON pumk_reschedule
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'DISETUJUI' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION tjsl_reschedule_cek_koreksi();

-- ---------------------------------------------------------------------------
-- 2. The akad side: contract principal immutable, effective principal derived
-- ---------------------------------------------------------------------------

ALTER TABLE pumk_akad
  -- Sum of approved principal deltas. Signed: a net reduction is negative.
  ADD COLUMN pokok_restruktur_kumulatif NUMERIC(20,2) NOT NULL DEFAULT 0,
  -- The principal in force today. Generated, so it cannot be edited into
  -- disagreement with its two inputs.
  ADD COLUMN pokok_pinjaman_efektif NUMERIC(20,2)
    GENERATED ALWAYS AS (pokok_pinjaman + pokok_restruktur_kumulatif) STORED;

COMMENT ON COLUMN pumk_akad.pokok_pinjaman IS
  'The principal as contracted and signed. IMMUTABLE: a restructure never rewrites it (ADR 0011). The principal in force is pokok_pinjaman_efektif.';
COMMENT ON COLUMN pumk_akad.pokok_pinjaman_efektif IS
  'Generated: pokok_pinjaman + pokok_restruktur_kumulatif. This is the ceiling for outstanding_pokok and the figure the Kartu Piutang should show as the current principal.';

-- The old ceiling was the contract principal, which makes a penambahan pokok
-- unrepresentable. Replaced by the effective principal. Dropping and re-adding
-- a constraint from a pushed migration is deliberate and reversed in `down`.
ALTER TABLE pumk_akad DROP CONSTRAINT pumk_akad_outstanding_pokok_max_ck;
ALTER TABLE pumk_akad
  ADD CONSTRAINT pumk_akad_outstanding_pokok_max_ck CHECK (
    outstanding_pokok <= pokok_pinjaman + pokok_restruktur_kumulatif
  ),
  -- A restructure can reduce the principal, never below zero.
  ADD CONSTRAINT pumk_akad_pokok_efektif_ck CHECK (
    pokok_pinjaman + pokok_restruktur_kumulatif > 0
  );

-- pokok_restruktur_kumulatif is maintained by the engine, not by a trigger:
-- silently mutating one financial row from another is how ledgers drift. But
-- the two may never disagree, so equality with the approved reschedules is
-- enforced instead, deferred so both writes fit in one transaction.
CREATE OR REPLACE FUNCTION tjsl_akad_cek_restruktur_kumulatif() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_akad UUID;
  v_kumulatif NUMERIC(20,2);
  v_jumlah_delta NUMERIC(20,2);
  v_no TEXT;
BEGIN
  -- IF, not CASE: plpgsql resolves every field reference in a single
  -- expression, so a CASE mentioning both NEW.id and NEW.akad_id fails on
  -- whichever table lacks the other one. Two branches, one field each.
  IF TG_TABLE_NAME = 'pumk_akad' THEN
    v_akad := NEW.id;
  ELSE
    v_akad := NEW.akad_id;
  END IF;

  SELECT pokok_restruktur_kumulatif, no_akad INTO v_kumulatif, v_no
  FROM pumk_akad WHERE id = v_akad AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(delta_pokok), 0) INTO v_jumlah_delta
  FROM pumk_reschedule
  WHERE akad_id = v_akad
    AND status = 'DISETUJUI'
    AND jenis = 'RESTRUKTUR_POKOK'
    AND deleted_at IS NULL;

  IF v_kumulatif <> v_jumlah_delta THEN
    RAISE EXCEPTION
      'TJSL-RSC-002: pokok_restruktur_kumulatif akad % (%) harus sama dengan jumlah delta_pokok reschedule DISETUJUI (%)',
      v_no, v_kumulatif, v_jumlah_delta
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_pumk_akad_50_restruktur
  AFTER INSERT OR UPDATE OF pokok_restruktur_kumulatif ON pumk_akad
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tjsl_akad_cek_restruktur_kumulatif();

CREATE CONSTRAINT TRIGGER trg_pumk_reschedule_60_restruktur
  AFTER INSERT OR UPDATE ON pumk_reschedule
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.jenis = 'RESTRUKTUR_POKOK')
  EXECUTE FUNCTION tjsl_akad_cek_restruktur_kumulatif();

-- ---------------------------------------------------------------------------
-- 3. The companion to the version-1 principal invariant (closes A-19)
-- ---------------------------------------------------------------------------
-- 0008 enforces SUM(pokok) = akad.pokok_pinjaman for versi = 1. For versi > 1
-- the basis is not the contract principal but what the reschedule restructured:
-- pokok_baru for a principal restructure, otherwise the outstanding at
-- approval. Both live on the reschedule row that pumk_jadwal_versi already
-- points at.
--
-- This also makes "a version above 1 exists because of a reschedule" a rule
-- rather than an expectation: without the link there is no basis to check
-- against, so the link is required. Deferred, so the engine may insert the
-- version row before it has the reschedule id, as long as both are set by
-- COMMIT.
CREATE OR REPLACE FUNCTION tjsl_jadwal_cek_total_pokok_versi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_total NUMERIC(20,2);
  v_dasar NUMERIC(20,2);
  v_reschedule UUID;
  v_no TEXT;
BEGIN
  SELECT v.reschedule_id INTO v_reschedule
  FROM pumk_jadwal_versi v
  WHERE v.akad_id = NEW.akad_id AND v.versi = NEW.versi AND v.deleted_at IS NULL;
  IF NOT FOUND THEN
    -- The composite FK already guarantees the version header exists; a
    -- soft-deleted header is out of scope for this check.
    RETURN NULL;
  END IF;

  SELECT no_akad INTO v_no FROM pumk_akad WHERE id = NEW.akad_id;

  IF v_reschedule IS NULL THEN
    RAISE EXCEPTION
      'TJSL-JDW-004: jadwal versi % akad % tidak menunjuk baris pumk_reschedule; versi di atas 1 hanya boleh lahir dari reschedule (set pumk_jadwal_versi.reschedule_id)',
      NEW.versi, v_no
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coalesce(r.pokok_baru, r.outstanding_pokok_sebelum) INTO v_dasar
  FROM pumk_reschedule r WHERE r.id = v_reschedule;

  IF v_dasar IS NULL THEN
    RAISE EXCEPTION
      'TJSL-JDW-005: reschedule % belum punya dasar pokok (outstanding_pokok_sebelum atau pokok_baru); jadwal versi % akad % tidak bisa diverifikasi',
      v_reschedule, NEW.versi, v_no
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coalesce(sum(pokok), 0) INTO v_total
  FROM pumk_jadwal_angsuran
  WHERE akad_id = NEW.akad_id AND versi = NEW.versi AND deleted_at IS NULL;

  IF v_total <> v_dasar THEN
    RAISE EXCEPTION
      'TJSL-JDW-006: total pokok jadwal versi % akad % (%) harus sama persis dengan dasar restrukturnya (%)',
      NEW.versi, v_no, v_total, v_dasar
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_pumk_jadwal_55_total_pokok_versi
  AFTER INSERT OR UPDATE ON pumk_jadwal_angsuran
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.versi > 1 AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION tjsl_jadwal_cek_total_pokok_versi();

-- ---------------------------------------------------------------------------
-- 4. Spec 7.1 fixed-due-day option, as a config row
-- ---------------------------------------------------------------------------
-- 0 = disabled, which is the spec's default behaviour (same day of month as
-- tanggal_mulai_angsuran, falling back to the last day of a short month).
-- 1..28 pins the due day; values above 28 are refused here rather than left to
-- produce a different day in February.
INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi)
SELECT NULL, 'angsuran', 'hari_jatuh_tempo_tetap', '0', 'NUMBER', NULL,
       'Hari jatuh tempo tetap setiap bulan (spec 7.1). 0 = mengikuti tanggal mulai angsuran akad, dengan fallback ke hari terakhir bulan pendek. 1 sampai 28 = selalu tanggal itu; di atas 28 ditolak agar Februari tidak berperilaku lain'
WHERE NOT EXISTS (
  SELECT 1 FROM konfigurasi
  WHERE bumn_id IS NULL AND grup = 'angsuran' AND kunci = 'hari_jatuh_tempo_tetap'
);

-- down
DELETE FROM konfigurasi
 WHERE bumn_id IS NULL AND grup = 'angsuran' AND kunci = 'hari_jatuh_tempo_tetap';
DROP TRIGGER IF EXISTS trg_pumk_jadwal_55_total_pokok_versi ON pumk_jadwal_angsuran;
DROP FUNCTION IF EXISTS tjsl_jadwal_cek_total_pokok_versi();
DROP TRIGGER IF EXISTS trg_pumk_reschedule_60_restruktur ON pumk_reschedule;
DROP TRIGGER IF EXISTS trg_pumk_akad_50_restruktur ON pumk_akad;
DROP FUNCTION IF EXISTS tjsl_akad_cek_restruktur_kumulatif();
ALTER TABLE pumk_akad DROP CONSTRAINT IF EXISTS pumk_akad_pokok_efektif_ck;
ALTER TABLE pumk_akad DROP CONSTRAINT IF EXISTS pumk_akad_outstanding_pokok_max_ck;
-- Restores the pre-0019 ceiling. This fails if a principal increase has been
-- recorded, which is correct: rolling back the feature must not leave data the
-- old constraint calls invalid.
ALTER TABLE pumk_akad
  ADD CONSTRAINT pumk_akad_outstanding_pokok_max_ck CHECK (outstanding_pokok <= pokok_pinjaman);
ALTER TABLE pumk_akad
  DROP COLUMN IF EXISTS pokok_pinjaman_efektif,
  DROP COLUMN IF EXISTS pokok_restruktur_kumulatif;
DROP TRIGGER IF EXISTS trg_pumk_reschedule_50_koreksi ON pumk_reschedule;
DROP FUNCTION IF EXISTS tjsl_reschedule_cek_koreksi();
ALTER TABLE pumk_reschedule
  DROP CONSTRAINT IF EXISTS pumk_reschedule_koreksi_jenis_ck,
  DROP CONSTRAINT IF EXISTS pumk_reschedule_delta_bukan_nol_ck,
  DROP CONSTRAINT IF EXISTS pumk_reschedule_basis_ck,
  DROP CONSTRAINT IF EXISTS pumk_reschedule_pokok_baru_jenis_ck,
  DROP COLUMN IF EXISTS jurnal_id_koreksi,
  DROP COLUMN IF EXISTS delta_pokok,
  DROP COLUMN IF EXISTS pokok_baru,
  DROP COLUMN IF EXISTS outstanding_jasa_sebelum,
  DROP COLUMN IF EXISTS outstanding_pokok_sebelum;
