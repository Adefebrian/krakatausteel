-- 0032_beku_dimensi_ditulis.sql
--
-- The write side of migrations/0027. That migration created
-- `saldo_akun_dimensi_periode`, said in its own header that "nothing writes
-- these rows yet", and handed the job to the closing engine. This migration
-- adds the two things the engine needs that 0027 could not supply, and nothing
-- else:
--
--   1. `periode.dimensi_dibekukan_at`, the STAMP that says the close ran the
--      decomposition at all.
--   2. `saldo_dimensi_mitra_periode`, the frozen PARTNER SET behind a per
--      sektor bucket, because report 24's "jumlah mitra" is a DISTINCT COUNT
--      and a distinct count cannot be frozen as a number.
--
-- ---------------------------------------------------------------------------
-- 1. WHY A STAMP AND NOT "ARE THERE ROWS"
-- ---------------------------------------------------------------------------
-- ADR 0016 wrote the handover as "the refusal narrows to: when this period's
-- freeze produced no decomposition on the axis this budget type needs". Asking
-- the DATA is right for a schema gap and WRONG once the gap is closed, because
-- the two states it has to tell apart are not distinguishable by row count:
--
--   A. a period closed before this migration, which HAD disbursements and has
--      no frozen decomposition of them. Reading it as zero realisation would
--      report a month of real lending as a month of none.
--   B. a period closed by the engine that writes them, in a month where
--      nothing carried a sektor or a bidang. Zero rows is the CORRECT and
--      complete answer, and refusing it would refuse a quiet January forever.
--
-- Both are "no rows on this axis". `dimensi_dibekukan_at` separates them: NULL
-- means nobody decomposed this period, a timestamp means the decomposition ran
-- and is complete, including when it produced nothing. It is the same shape as
-- `template_laporan_id` (migrations/0028): a fact ABOUT the close, stamped by
-- the close, cleared by a reopen, so an OPEN period never carries a claim about
-- a close that has been undone.
--
-- NULLABLE, and no backfill. Every period closed before today genuinely has no
-- frozen decomposition, and inventing one now from the live ledger would be
-- exactly the recomputation from editable master data that ADR 0016 exists to
-- prevent. Those periods keep refusing, which is the fail-closed handover 0024,
-- 0025 and 0027 all use. A reopen and re-close is the supported way to give a
-- historical period its decomposition, and that is an accountant's decision,
-- not a migration's.
--
-- ---------------------------------------------------------------------------
-- 2. WHY THE PARTNER SET IS ROWS AND NOT A COUNT COLUMN
-- ---------------------------------------------------------------------------
-- Spec 9.3 budgets PUMK per sektor in TWO units: rupiah and "jumlah mitra".
-- The rupiah leg decomposes additively, which is why 0027's two movement
-- columns can carry it. The partner leg does not:
--
--   A mitra funded in January and again in March is ONE partner over the year
--   and two over the two months. A frozen `jumlah_mitra` per period summed
--   across a year-to-date window counts that partner twice, in a column that
--   looks right, next to a rupiah figure that is right. modules/rka reads the
--   whole window in ONE query today precisely so its `count(distinct mitra_id)`
--   stays honest; a per-period frozen count would take that away and give
--   nothing back.
--
-- So the frozen artefact is the SET, one row per (bucket, mitra), and the count
-- is taken at read time over whatever window is asked for. `count(distinct)`
-- over a union of frozen sets equals `count(distinct)` over the live ledger for
-- the same window, for every window, which is the property the report needs and
-- the only one a number could not have given.
--
-- HUNG OFF THE BUCKET ROW, NOT OFF THE PERIOD, for 0027's own reason: the
-- reopen path is `DELETE FROM saldo_akun_periode WHERE periode_id = $1`, which
-- already cascades to `saldo_akun_dimensi_periode`. A second CASCADE from there
-- means a reopen sweeps the partner sets too, in the same statement, with no
-- change to the reopen code and no way for a stale partner to survive into a
-- re-close and be counted against a NEW bucket row. It also makes "a partner
-- frozen against a bucket that does not exist" structurally impossible.
--
-- NO TOTALITY RULE HERE, deliberately, and the asymmetry with 0027 is the
-- point. The money rows must sum to their parent because they DECOMPOSE a
-- quantity the parent already states. The partner set decomposes nothing: the
-- trial balance has no partner count for it to reconcile against, and a
-- residual "partners with no sektor" row would be a bucket nothing reads. What
-- guards it instead is the unique index, which is what stops one partner being
-- counted twice inside one bucket.
--
-- SEKTOR ONLY, enforced rather than assumed. "Jumlah mitra" is a PUMK budget
-- unit; RKA Non PUMK budgets rupiah per bidang and has no unit column at all
-- (modules/rka `BarisRkaVsRealisasi.unitRealisasi` is null for NON_PUMK). A
-- partner attached to a BIDANG bucket would be a set nothing counts, and the
-- day something did count it, it would be counting partners of a Non PUMK grant
-- as if they were PUMK borrowers.

-- up

-- --- 1. the stamp ----------------------------------------------------------

ALTER TABLE periode ADD COLUMN dimensi_dibekukan_at TIMESTAMPTZ;

COMMENT ON COLUMN periode.dimensi_dibekukan_at IS
  'Kapan closing membekukan rincian per dimensi (saldo_akun_dimensi_periode) untuk periode ini. NULL berarti penguraian TIDAK PERNAH dijalankan, sehingga laporan per sektor atau per bidang atas periode ini harus MENOLAK, bukan membaca nol. Terisi berarti penguraian selesai, termasuk ketika hasilnya memang nol baris. Dikosongkan saat periode dibuka kembali, sama seperti template_laporan_id.';

-- --- 2. the frozen partner set ---------------------------------------------

CREATE TABLE saldo_dimensi_mitra_periode (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The bucket these partners were funded into. CASCADE: see the file header.
  saldo_akun_dimensi_periode_id UUID NOT NULL
    REFERENCES saldo_akun_dimensi_periode(id) ON DELETE CASCADE,
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

-- ONE row per partner per bucket. This is the whole guard on the figure: the
-- count is `count(DISTINCT mitra_id)` at read time, so a duplicated row would
-- not inflate it, but a duplicate is still a claim that the same partner was
-- funded twice into one bucket in one month, which the freeze never means.
CREATE UNIQUE INDEX saldo_dimensi_mitra_periode_uq
  ON saldo_dimensi_mitra_periode (saldo_akun_dimensi_periode_id, mitra_id);
CREATE INDEX saldo_dimensi_mitra_periode_mitra_idx
  ON saldo_dimensi_mitra_periode (mitra_id);

SELECT tjsl_attach_audit_trigger('saldo_dimensi_mitra_periode');
SELECT tjsl_attach_audit_fk('saldo_dimensi_mitra_periode');
SELECT tjsl_attach_soft_delete_check('saldo_dimensi_mitra_periode');

-- Row level, immediate, every fact known at INSERT. Three separate claims, and
-- none of them is tidiness:
--
--   1. THE BUCKET IS A SEKTOR BUCKET AND NAMES A SEKTOR. See the header: a
--      partner under a BIDANG bucket, or under the residual, is a set no report
--      counts, and the first report that counted one would be counting the
--      wrong population.
--   2. THE PARTNER BELONGS TO THE SAME BUMN AS THE PERIOD. Identical reasoning
--      to TJSL-SDP-001: `mitra` is per cabang and therefore per BUMN, nothing
--      but the closing engine's own query ties one to a period, and a cross
--      entity row would raise another BUMN's partner count without moving any
--      total anywhere.
--   3. THE PARTNER BELONGS TO THE SAME CABANG AS THE FROZEN ROW. The parent is
--      keyed per cabang and a branch scoped report filters on it, so a partner
--      filed under another branch's frozen row would appear in that branch's
--      count and vanish from its own.
CREATE OR REPLACE FUNCTION tjsl_saldo_dimensi_mitra_baris() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  ax TEXT;
  sektor UUID;
  cabang_beku UUID;
  bumn_periode UUID;
  cabang_mitra UUID;
  bumn_mitra UUID;
BEGIN
  SELECT sd.sumbu, sd.sektor_id, s.cabang_id, p.bumn_id
    INTO ax, sektor, cabang_beku, bumn_periode
    FROM saldo_akun_dimensi_periode sd
    JOIN saldo_akun_periode s ON s.id = sd.saldo_akun_periode_id
    JOIN periode p ON p.id = s.periode_id
   WHERE sd.id = NEW.saldo_akun_dimensi_periode_id;
  -- Existence is the foreign key's job; the firing order of an internal RI
  -- trigger relative to this one is not something to bet a guard on.
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF ax <> 'SEKTOR' OR sektor IS NULL THEN
    RAISE EXCEPTION
      'TJSL-SDM-001: mitra beku hanya boleh menempel pada bucket sumbu SEKTOR yang menyebut sektor, bukan pada sumbu % (sektor %)',
      ax, sektor
      USING ERRCODE = 'restrict_violation',
            HINT = 'Jumlah mitra adalah satuan anggaran RKA PUMK per sektor. Baris sisa dan sumbu BIDANG tidak punya pembaca untuk himpunan mitra.';
  END IF;

  SELECT m.cabang_id, c.bumn_id INTO cabang_mitra, bumn_mitra
    FROM mitra m JOIN cabang c ON c.id = m.cabang_id
   WHERE m.id = NEW.mitra_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF bumn_mitra <> bumn_periode THEN
    RAISE EXCEPTION
      'TJSL-SDM-002: mitra milik BUMN % dipakai pada saldo beku periode milik BUMN %',
      bumn_mitra, bumn_periode
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF cabang_mitra <> cabang_beku THEN
    RAISE EXCEPTION
      'TJSL-SDM-003: mitra cabang % dipakai pada baris saldo beku cabang %',
      cabang_mitra, cabang_beku
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER trg_saldo_dimensi_mitra_periode_20_baris
  AFTER INSERT OR UPDATE ON saldo_dimensi_mitra_periode
  FOR EACH ROW EXECUTE FUNCTION tjsl_saldo_dimensi_mitra_baris();

COMMENT ON TABLE saldo_dimensi_mitra_periode IS
  'Himpunan mitra di balik satu bucket sektor pada saldo_akun_dimensi_periode, dibekukan saat periode ditutup. Bukan angka: "jumlah mitra" pada RKA PUMK adalah COUNT DISTINCT, dan satu mitra yang dicairkan dua bulan berbeda adalah satu mitra dalam setahun. Menyimpan himpunannya membuat hitungan atas jendela mana pun (bulanan maupun kumulatif) sama dengan hitungan atas ledger hidup untuk jendela yang sama.';
COMMENT ON COLUMN saldo_dimensi_mitra_periode.mitra_id IS
  'Mitra yang menerima pencairan pada bucket sektor ini di periode ini. Satu baris per mitra per bucket.';

-- down
-- The exact inverse. The table goes first (it is the only thing referencing the
-- new trigger function), then the function, then the column added to the
-- pre-existing `periode`. `periode` is left byte-identical to its pre-0032
-- shape: no constraint of its own was touched.
DROP TABLE IF EXISTS saldo_dimensi_mitra_periode;
DROP FUNCTION IF EXISTS tjsl_saldo_dimensi_mitra_baris();
ALTER TABLE periode DROP COLUMN IF EXISTS dimensi_dibekukan_at;
