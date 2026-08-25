-- 0028_template_laporan.sql
--
-- Two report templates can live at once, one account can appear in both, and a
-- statement can never mix lines from two of them.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- `baris_laporan_kode_uq` is UNIQUE (bumn_id, kode) and `akun.klasifikasi_
-- laporan` is a single composite foreign key into it. So a code exists once per
-- BUMN and an account points at exactly one line, which means:
--
--   - two coexisting templates cannot both own a line called ASET_NETO_TERIKAT,
--     and
--   - an account belongs to the PSAK 45 line or to the ISAK 335 line, never to
--     both.
--
-- docs/BUILD-PLAN.md records the plan that the specification's PSAK 45 net
-- asset wording and the ISAK 335 wording actually in force must both be able to
-- live at once, because docs/REGULASI.md finding 1 established that the
-- specification cites a withdrawn standard, that audited BUMN practice is
-- split, and that the choice belongs to the client's accounting team with their
-- KAP. As the schema stood, that plan did not work.
--
-- The related complaint, that `akun.klasifikasi_laporan` is single valued so at
-- most two of the four statements can be account driven (Arus Kas got its own
-- parallel column, Perubahan Aset Neto got nothing and has to be derived from
-- `baris_laporan.seksi`), turns out to be the SAME defect seen from the other
-- end, and it is fixed by the same change. See "one column doing two jobs".
--
-- ---------------------------------------------------------------------------
-- THE DIAGNOSIS: ONE COLUMN DOING TWO JOBS
-- ---------------------------------------------------------------------------
-- `baris_laporan.kode` is simultaneously
--
--   (a) the identity of a PRINTED LINE of one statement, and
--   (b) the vocabulary an account is CLASSIFIED with.
--
-- Those are different things and they change on different schedules. What an
-- account IS ("a restricted net asset", "a receivable from partners") is an
-- accounting fact about the account that does not change because a standard was
-- renumbered. Where it PRINTS, under what caption, in what order, in which
-- section, with which sign, is a presentation decision that changes every time
-- the standard or the client's format changes. Conflating them is exactly why
-- one account cannot be in two templates, and why only one statement per
-- classification column can be account driven.
--
-- So this migration splits them:
--
--   klasifikasi_akun          the vocabulary. What an account is. Per BUMN,
--                             standard agnostic, and `akun` points here.
--   template_laporan          a named, effective dated presentation.
--   baris_laporan             a printed line OF ONE TEMPLATE. Gains template_id.
--   pemetaan_baris_laporan    (template, klasifikasi, statement) -> line.
--
-- WHAT THE INDIRECTION BUYS, CONCRETELY:
--
--   1. Adding a second template is ~20 mapping rows, not one row per account.
--      A per account per template link table (the other candidate, and the one
--      the brief named first) would mean re mapping the entire chart for every
--      template, and every account added afterwards would have to be mapped
--      into every template or it would silently vanish from one statement and
--      not another. That failure is invisible: the statement still balances,
--      because the account simply is not there.
--   2. A standards change is usually MANY TO ONE. PSAK 45 has three net asset
--      categories, ISAK 335 has two: "terikat temporer" and "terikat permanen"
--      both become "dengan pembatasan". A shared code vocabulary across
--      templates cannot express that; a mapping table can, because two
--      classifications may point at one line.
--   3. Totality survives. `akun.klasifikasi_akun` stays NOT NULL with a real
--      composite foreign key, so an account without a classification remains
--      impossible, exactly as before. Under a per account per template link
--      table, NOT NULL can only ever guarantee coverage for one template.
--   4. All four statements become account driven. One classification maps to a
--      line in POSISI_KEUANGAN and a line in ARUS_KAS and a line in
--      PERUBAHAN_ASET_NETO, one per statement per template, because the mapping
--      is keyed by statement. Perubahan Aset Neto stops being inferred from
--      `baris_laporan.seksi`, which is a section label, not a mapping.
--
-- `akun.klasifikasi_arus_kas` is deliberately LEFT ALONE. It answers a
-- different question ("when this account is the counterpart of a cash movement,
-- which section is that flow in") and it is per account rather than per
-- classification. It could be expressed through the mapping table later, at
-- line level rather than section level, which would be an improvement; doing it
-- in the same migration that moves every report's join would be two changes
-- wearing one coat.
--
-- ---------------------------------------------------------------------------
-- A STATEMENT CANNOT MIX TWO TEMPLATES. STRUCTURALLY, NOT BY CONVENTION.
-- ---------------------------------------------------------------------------
-- A mapping row carries `template_id` and `laporan` and points at its line
-- through a FOUR column foreign key (baris_laporan_id, bumn_id, template_id,
-- laporan). A row that names a line of template A while claiming template B is
-- rejected by the foreign key, not by a trigger and not by a code review. A
-- renderer therefore selects `WHERE template_id = $1` and everything it can
-- reach, lines and mappings alike, belongs to that template.
--
-- The same four column key is why a cross BUMN mapping is impossible, so this
-- migration adds no referential trigger at all.
--
-- ---------------------------------------------------------------------------
-- WHAT STOPS A CLOSED PERIOD'S STATEMENT FROM SILENTLY CHANGING SHAPE
-- ---------------------------------------------------------------------------
-- Answered in three parts, because a single answer would be a half truth.
--
-- 1. SWITCHING TEMPLATES CANNOT RESHAPE A CLOSED PERIOD, because the period
--    records the template it was closed under. `periode.template_laporan_id` is
--    written at close, and a reprint of a closed period resolves ITS template
--    from that column rather than from whatever is in force today. Adopting
--    ISAK 335 in 2027 therefore cannot silently restate every 2026 statement,
--    which is the failure mode with the widest blast radius and the only one
--    that would happen by accident.
--
-- 2. EDITING A TEMPLATE IN PLACE STILL CAN, AND IS NOT FORBIDDEN HERE. Moving
--    an account to another classification, flipping `tanda`, or deactivating a
--    line changes how a closed period prints. That is deliberate, and it is not
--    the same defect as migration 0024's:
--
--      - The FIGURES are frozen per account in `saldo_akun_periode` and are
--        template independent. Neraca Lajur, which is per account, reconstructs
--        a closed period exactly, whatever the layout does. Invariant 14 speaks
--        about "angka yang sama"; the account balances do not move.
--      - Restating comparatives is REQUIRED when a standard changes, not
--        forbidden. A system that froze the shape of a closed period could not
--        produce the restated prior year column the standard demands.
--      - Making the shape immutable properly means versioning both the template
--        AND the account to classification link over time, i.e. temporal master
--        data, which this system has deliberately not adopted anywhere (mitra,
--        sektor, bidang and akun are all mutable). Adding it for one table only
--        would be the expensive half of a mechanism nothing else uses.
--
--    So the mitigation is evidence rather than prevention: every one of those
--    tables carries the audit trigger, so who reshaped a printed statement, and
--    when, is answerable from `audit_log`. Recorded in ADR 0017 and as an open
--    question rather than presented as solved.
--
-- 3. "WHICH TEMPLATE WAS IN FORCE" ALWAYS HAS EXACTLY ONE ANSWER, because the
--    effective ranges of a BUMN's templates may not overlap. Enforced, below.
--    A template is not a dropdown on a report screen: picking one at print time
--    is allowed for a restatement or a preview, but the DEFAULT for a period is
--    data, and two people printing the same month get the same statement.
--
-- ---------------------------------------------------------------------------
-- ON THE ALTERNATIVE THE BRIEF OFFERED: ONE TEMPLATE, MIGRATE BETWEEN THEM
-- ---------------------------------------------------------------------------
-- Rejected, and not on the "keep options open" argument, which is usually a
-- reason to build the wrong thing. It is rejected because a single template
-- makes an in place UPDATE the only way to adopt a new standard, and an in
-- place UPDATE is precisely the silent reshaping of every prior period that
-- point 1 above exists to prevent. Coexistence is not a hedge about which
-- standard the client will pick; it is what "the 2026 statements were prepared
-- under the format then in force" requires of the database, whichever standard
-- that turns out to be. The client still chooses ONE template per period. They
-- do not choose one template for all time.
--
-- ---------------------------------------------------------------------------
-- THIS IS A BREAKING CHANGE, ON PURPOSE, AND IT FAILS LOUDLY
-- ---------------------------------------------------------------------------
-- `akun.klasifikasi_laporan` is RENAMED to `akun.klasifikasi_akun`. Its values
-- are unchanged, its NOT NULL is unchanged, and its foreign key is unchanged in
-- shape, only retargeted at the new vocabulary table. The rename is the point:
-- every query that joins an account to a report line by code alone must change,
-- and after this migration each one fails immediately with `column
-- "klasifikasi_laporan" does not exist` instead of quietly returning one row
-- per template the day a second template is created. Same fail closed handover
-- as 0024, 0025 and 0026. The alternative, leaving the name, would have been a
-- report that doubles every line and still balances.
--
-- THE BACKFILL IS EXACT, NOT A GUESS. Today's schema means precisely "one
-- template, and the classification vocabulary IS the set of line codes", so the
-- migration writes one template per BUMN, one classification per existing line
-- code, and one identity mapping per existing line. Nothing is invented and
-- nothing is dropped: every account keeps the same classification string and
-- resolves to the same line it resolved to before. The default template is
-- named BAWAAN and not PSAK_45, because naming it after a standard would be
-- this migration asserting which standard the client reports under, which is
-- the open question it exists to keep open.

-- up

-- ---------------------------------------------------------------------------
-- 1. The templates
-- ---------------------------------------------------------------------------

CREATE TABLE template_laporan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  -- Free text on purpose: "ISAK 335", "PSAK 45 / Pedoman Akuntansi PKBL",
  -- "Amendemen ISAK 335 (PSAK 118)". A CHECK listing today's standards would
  -- need a migration every time DSAK IAI renumbers one, which docs/REGULASI.md
  -- shows happening twice in six years.
  dasar TEXT,
  -- EFFECTIVE DATING, over the period being REPORTED, not over wall clock time.
  -- A template adopted for financial years from 2027 has berlaku_dari
  -- 2027-01-01 even if it is entered in 2026. berlaku_sampai is INCLUSIVE;
  -- NULL means open ended.
  berlaku_dari DATE NOT NULL,
  berlaku_sampai DATE,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT template_laporan_rentang_ck CHECK (
    berlaku_sampai IS NULL OR berlaku_sampai >= berlaku_dari
  ),
  -- Composite targets, so every child link below can be a declarative foreign
  -- key that carries bumn_id and cannot cross entities.
  CONSTRAINT template_laporan_bumn_uq UNIQUE (id, bumn_id)
);
CREATE UNIQUE INDEX template_laporan_kode_uq ON template_laporan (bumn_id, kode);
CREATE INDEX template_laporan_berlaku_idx ON template_laporan (bumn_id, berlaku_dari);

-- ---------------------------------------------------------------------------
-- 2. The classification vocabulary
-- ---------------------------------------------------------------------------

CREATE TABLE klasifikasi_akun (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  keterangan TEXT,
  urutan INTEGER NOT NULL DEFAULT 0,
  aktif BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT klasifikasi_akun_bumn_uq UNIQUE (id, bumn_id),
  -- A plain (not partial) UNIQUE, for the same reason 0005 gave it to
  -- `baris_laporan`: `akun.klasifikasi_akun` needs a composite foreign key
  -- target, and a soft deleted classification must keep its code reserved so
  -- that reprinting an old period still resolves the code it was printed with.
  CONSTRAINT klasifikasi_akun_kode_uq UNIQUE (bumn_id, kode)
);

-- ---------------------------------------------------------------------------
-- 3. baris_laporan belongs to a template
-- ---------------------------------------------------------------------------

ALTER TABLE baris_laporan ADD COLUMN template_id UUID REFERENCES template_laporan(id);

-- One default template per BUMN that already has a layout. `1900-01-01` rather
-- than the BUMN's first period: this template describes every statement ever
-- printed by this installation, and an open lower bound is the truthful claim.
INSERT INTO template_laporan (bumn_id, kode, nama, dasar, berlaku_dari)
SELECT DISTINCT bl.bumn_id, 'BAWAAN', 'Template bawaan',
       'Format yang sudah terpasang sebelum migrasi 0028. Standarnya belum ditetapkan klien.',
       DATE '1900-01-01'
  FROM baris_laporan bl;

UPDATE baris_laporan bl
   SET template_id = t.id
  FROM template_laporan t
 WHERE t.bumn_id = bl.bumn_id AND t.kode = 'BAWAAN';

ALTER TABLE baris_laporan ALTER COLUMN template_id SET NOT NULL;

-- The code is unique WITHIN a template now, so ASET_NETO_TERIKAT can exist once
-- in each of two coexisting templates. `akun`'s foreign key depends on the old
-- unique and has to let go of it first; it is re pointed at the vocabulary
-- table in section 4, and between these two statements no account is
-- referentially anchored to anything. That window is inside one transaction
-- (tools/migrate.ts runs each file in one), so it is not observable.
ALTER TABLE akun DROP CONSTRAINT akun_klasifikasi_laporan_fk;
ALTER TABLE baris_laporan DROP CONSTRAINT baris_laporan_kode_uq;
ALTER TABLE baris_laporan
  ADD CONSTRAINT baris_laporan_kode_uq UNIQUE (bumn_id, template_id, kode);
-- The composite target that makes a mapping row unable to name a line from
-- another template, another statement or another entity.
ALTER TABLE baris_laporan
  ADD CONSTRAINT baris_laporan_ruang_uq UNIQUE (id, bumn_id, template_id, laporan);
DROP INDEX baris_laporan_urut_idx;
CREATE INDEX baris_laporan_urut_idx
  ON baris_laporan (bumn_id, template_id, laporan, urutan);

-- ---------------------------------------------------------------------------
-- 4. akun points at the vocabulary, not at a printed line
-- ---------------------------------------------------------------------------

INSERT INTO klasifikasi_akun (bumn_id, kode, nama, keterangan)
SELECT bl.bumn_id, bl.kode, bl.nama,
       'Dibuat oleh migrasi 0028 dari baris laporan yang sudah ada; nilainya identik dengan klasifikasi_laporan sebelumnya.'
  FROM baris_laporan bl;

DROP INDEX akun_klasifikasi_idx;
ALTER TABLE akun RENAME COLUMN klasifikasi_laporan TO klasifikasi_akun;
ALTER TABLE akun
  ADD CONSTRAINT akun_klasifikasi_akun_fk
  FOREIGN KEY (bumn_id, klasifikasi_akun) REFERENCES klasifikasi_akun (bumn_id, kode);
CREATE INDEX akun_klasifikasi_idx ON akun (bumn_id, klasifikasi_akun);

-- ---------------------------------------------------------------------------
-- 5. The mapping
-- ---------------------------------------------------------------------------

CREATE TABLE pemetaan_baris_laporan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  template_id UUID NOT NULL,
  klasifikasi_id UUID NOT NULL,
  baris_laporan_id UUID NOT NULL,
  -- Denormalised from the line, so that "one line per statement per
  -- classification" is a plain UNIQUE rather than a trigger. Kept honest by the
  -- four column foreign key below, which refuses a row whose `laporan` does not
  -- match the line it names.
  laporan TEXT NOT NULL CHECK (laporan IN
    ('POSISI_KEUANGAN', 'AKTIVITAS', 'ARUS_KAS', 'PERUBAHAN_ASET_NETO')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pemetaan_template_fk
    FOREIGN KEY (template_id, bumn_id) REFERENCES template_laporan (id, bumn_id),
  CONSTRAINT pemetaan_klasifikasi_fk
    FOREIGN KEY (klasifikasi_id, bumn_id) REFERENCES klasifikasi_akun (id, bumn_id),
  CONSTRAINT pemetaan_baris_fk
    FOREIGN KEY (baris_laporan_id, bumn_id, template_id, laporan)
    REFERENCES baris_laporan (id, bumn_id, template_id, laporan)
);

-- THE RULE THAT KEEPS A STATEMENT ADDING UP: a classification lands on AT MOST
-- ONE line of a given statement in a given template. Two lines would count the
-- same accounts twice, and the statement would still balance, because both
-- copies sit on the same side.
CREATE UNIQUE INDEX pemetaan_baris_laporan_uq
  ON pemetaan_baris_laporan (template_id, klasifikasi_id, laporan)
  WHERE deleted_at IS NULL;
CREATE INDEX pemetaan_baris_laporan_baris_idx ON pemetaan_baris_laporan (baris_laporan_id);
CREATE INDEX pemetaan_baris_laporan_template_idx
  ON pemetaan_baris_laporan (template_id, laporan);

-- The identity backfill: every existing line becomes the mapping of the
-- classification with the same code, in the default template, for that line's
-- own statement. This is what the pre-0028 schema meant, written out.
INSERT INTO pemetaan_baris_laporan (bumn_id, template_id, klasifikasi_id, baris_laporan_id, laporan)
SELECT bl.bumn_id, bl.template_id, k.id, bl.id, bl.laporan
  FROM baris_laporan bl
  JOIN klasifikasi_akun k ON k.bumn_id = bl.bumn_id AND k.kode = bl.kode;

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('template_laporan'), ('klasifikasi_akun'), ('pemetaan_baris_laporan')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('template_laporan'), ('klasifikasi_akun'), ('pemetaan_baris_laporan')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('template_laporan'), ('klasifikasi_akun'), ('pemetaan_baris_laporan')
) AS x(t);

-- ---------------------------------------------------------------------------
-- 6. Exactly one template in force for any reported date
-- ---------------------------------------------------------------------------
--
-- A trigger rather than an EXCLUDE constraint, deliberately: EXCLUDE over a
-- daterange needs the btree_gist extension, this repository installs no
-- extensions at all, and adding a deployment time dependency on a contrib
-- module to express three lines of plpgsql is a poor trade. If extensions ever
-- become part of the base image for another reason, this is the first thing to
-- replace with `EXCLUDE USING gist (bumn_id WITH =, daterange(...) WITH &&)`.
--
-- Soft deleted and inactive templates are excluded from the check: a template
-- that is not in use does not compete for a date range, and a client that
-- retires a template and re issues it over the same years is doing something
-- legitimate.
CREATE OR REPLACE FUNCTION tjsl_template_laporan_tak_bertindih() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  bentrok RECORD;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NOT NEW.aktif THEN RETURN NULL; END IF;

  SELECT kode, berlaku_dari, berlaku_sampai INTO bentrok
    FROM template_laporan
   WHERE bumn_id = NEW.bumn_id
     AND id <> NEW.id
     AND deleted_at IS NULL
     AND aktif
     AND daterange(berlaku_dari, berlaku_sampai, '[]')
         && daterange(NEW.berlaku_dari, NEW.berlaku_sampai, '[]')
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'TJSL-TPL-001: rentang berlaku template % bertindih dengan template % (% sampai %)',
      NEW.kode, bentrok.kode, bentrok.berlaku_dari, COALESCE(bentrok.berlaku_sampai::text, 'seterusnya')
      USING ERRCODE = 'restrict_violation',
            HINT = 'Satu tanggal pelaporan harus jatuh pada tepat satu template. Tutup rentang template lama (berlaku_sampai) sebelum memberlakukan yang baru.';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_template_laporan_20_tak_bertindih
  AFTER INSERT OR UPDATE ON template_laporan
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tjsl_template_laporan_tak_bertindih();

-- ---------------------------------------------------------------------------
-- 7. A closed period remembers the template it was closed under
-- ---------------------------------------------------------------------------
--
-- Nullable, and nothing writes it yet: `tutupPeriode` must set it, and periods
-- closed before this migration have none. A reprint of such a period has to
-- fall back to the effective dated lookup and SAY that it did, which is
-- modules/laporan's decision to implement, not a default this migration can
-- invent. Same fail closed handover as the rest of this pass.
ALTER TABLE periode ADD COLUMN template_laporan_id UUID REFERENCES template_laporan(id);
CREATE INDEX periode_template_idx ON periode (template_laporan_id)
  WHERE template_laporan_id IS NOT NULL;

COMMENT ON TABLE template_laporan IS
  'Satu format penyajian laporan keuangan, berlaku untuk rentang tanggal pelaporan tertentu. Dua template boleh hidup bersamaan (mis. istilah PSAK 45 dan istilah ISAK 335), tetapi rentang berlakunya tidak boleh bertindih, sehingga satu periode selalu punya tepat satu template bawaan.';
COMMENT ON TABLE klasifikasi_akun IS
  'Kosakata klasifikasi akun: APA sebuah akun itu, terlepas dari standar penyajian yang sedang berlaku. Dipisahkan dari baris_laporan oleh migrasi 0028 karena satu kolom sebelumnya merangkap identitas baris cetak dan kosakata klasifikasi.';
COMMENT ON TABLE pemetaan_baris_laporan IS
  'Pemetaan (template, klasifikasi, laporan) -> baris cetak. Satu klasifikasi jatuh pada paling banyak satu baris per laporan per template, dan foreign key empat kolomnya membuat baris dari template lain tidak bisa tercampur ke dalam satu laporan.';
COMMENT ON COLUMN akun.klasifikasi_akun IS
  'Klasifikasi akun (FK ke klasifikasi_akun.kode). Sebelum migrasi 0028 kolom ini bernama klasifikasi_laporan dan menunjuk langsung ke satu baris cetak; namanya diganti supaya setiap query lama gagal keras, bukan mengembalikan satu baris per template.';
COMMENT ON COLUMN periode.template_laporan_id IS
  'Template yang berlaku saat periode ini ditutup, ditulis oleh mesin closing. Cetak ulang periode CLOSED memakai kolom ini, sehingga pemberlakuan template baru tidak bisa mengubah bentuk laporan periode yang sudah dilaporkan.';

-- down
-- Restores the pre-0028 shape exactly: `akun.klasifikasi_laporan` back under its
-- old name with its old foreign key into `baris_laporan (bumn_id, kode)`, the
-- old unique and index on `baris_laporan`, and every object this migration
-- created removed. The VALUES survive the round trip untouched, because the
-- rename preserved them and the vocabulary codes are identical to the line
-- codes it was built from.
--
-- ONE RESIDUAL DIFFERENCE, STATED RATHER THAN GLOSSED, and it is the same one
-- 0026 recorded: a column cannot be reinserted at an ordinal position, so after
-- a down/up cycle `akun.klasifikasi_laporan` sits where the rename left it
-- rather than at its original ordinal. Type, nullability, foreign key and every
-- other object are identical. (A rename does not move a column, so a plain
-- down/up of THIS migration is ordinal identical; the note applies to
-- `baris_laporan.template_id`, which is dropped and would come back last.)
DROP TRIGGER IF EXISTS trg_template_laporan_20_tak_bertindih ON template_laporan;
DROP FUNCTION IF EXISTS tjsl_template_laporan_tak_bertindih();

DROP INDEX IF EXISTS periode_template_idx;
ALTER TABLE periode DROP COLUMN IF EXISTS template_laporan_id;

DROP TABLE IF EXISTS pemetaan_baris_laporan;

ALTER TABLE akun DROP CONSTRAINT akun_klasifikasi_akun_fk;
DROP INDEX akun_klasifikasi_idx;
ALTER TABLE akun RENAME COLUMN klasifikasi_akun TO klasifikasi_laporan;
-- A RENAME carries the column COMMENT with it, so without this the rolled back
-- schema would still describe the column in terms of a table that no longer
-- exists. Found by diffing the dumps, not by reading.
COMMENT ON COLUMN akun.klasifikasi_laporan IS NULL;

ALTER TABLE baris_laporan DROP CONSTRAINT baris_laporan_ruang_uq;
ALTER TABLE baris_laporan DROP CONSTRAINT baris_laporan_kode_uq;
-- Rolling back is only meaningful if the pre-0028 uniqueness still holds, i.e.
-- if nobody created a second template. Refusing here is better than a bare
-- unique violation with no explanation of what the operator has to decide.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM baris_laporan GROUP BY bumn_id, kode HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'TJSL-MIG-0028-DOWN: ada kode baris laporan yang dipakai lebih dari satu template, '
      'sehingga UNIQUE (bumn_id, kode) sebelum 0028 tidak bisa dipulihkan. '
      'Nonaktifkan atau hapus template tambahan lebih dulu, lalu jalankan rollback ini kembali.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$$;
ALTER TABLE baris_laporan
  ADD CONSTRAINT baris_laporan_kode_uq UNIQUE (bumn_id, kode);
ALTER TABLE akun
  ADD CONSTRAINT akun_klasifikasi_laporan_fk
  FOREIGN KEY (bumn_id, klasifikasi_laporan) REFERENCES baris_laporan (bumn_id, kode);
CREATE INDEX akun_klasifikasi_idx ON akun (bumn_id, klasifikasi_laporan);
DROP INDEX baris_laporan_urut_idx;
CREATE INDEX baris_laporan_urut_idx ON baris_laporan (bumn_id, laporan, urutan);
ALTER TABLE baris_laporan DROP COLUMN template_id;

DROP TABLE IF EXISTS klasifikasi_akun;
DROP TABLE IF EXISTS template_laporan;
