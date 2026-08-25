-- 0027_saldo_beku_per_dimensi.sql
--
-- A CLOSED period gets a frozen figure per sektor and per bidang, so spec 10's
-- rule ("periode CLOSED dibaca dari snapshot, bukan dihitung ulang") can
-- actually be satisfied for RKA PUMK and RKA Non PUMK.
--
-- THE GAP, AS THE RKA SUITE PINNED IT. `saldo_akun_periode` is keyed
-- (periode, cabang, akun) and carries no analytic dimension, so a closed month
-- has NO frozen number per sektor (RKA PUMK targets per sektor, spec 9.3) and
-- none per bidang (RKA Non PUMK budgets per bidang). RKA Keuangan is per akun
-- and survives; the other two have nowhere frozen to read from at all, and
-- modules/rka refuses with SKEMA_BELUM_LENGKAP rather than recompute from live
-- master data. This migration is the schema half of removing that refusal.
--
-- WHY NOT COLUMNS ON `saldo_akun_periode`. It is the tempting shape and it is
-- the dangerous one, for three separate reasons:
--
--   1. EVERY EXISTING READER WOULD SILENTLY DOUBLE COUNT. Neraca Lajur, the
--      trial balance, reports 28 to 30 and `v_saldo_periode_terakhir`
--      (migrations/0017) all read `SELECT ... FROM saldo_akun_periode WHERE
--      periode_id = $1` and sum. Adding dimensioned rows to that table makes
--      every one of those queries wrong the day the first dimensioned row is
--      written, and wrong in the worst way: the trial balance stops summing to
--      zero, or worse, still sums to zero because both sides inflated. Fixing
--      it means retrofitting `AND sektor_id IS NULL AND bidang_id IS NULL`
--      onto every reader that exists today and every one written later, and
--      forgetting one is undetectable. That is precisely the shape the brief
--      named: a total that inflates while every row looks right.
--   2. THE IDENTITY WOULD HAVE TO BE FAKED. `saldo_akun_periode_identitas_ck`
--      ties saldo_awal + mutasi_debit - mutasi_kredit = saldo_akhir. A
--      per-sektor row has no defensible saldo_awal: for the first period after
--      this migration there IS no prior per-sektor balance to carry forward,
--      because nothing was ever frozen per sektor. Every such row would have
--      to state a zero opening balance to satisfy a CHECK, and a stated zero
--      is a claim, not a blank.
--   3. A BALANCE PER DIMENSION IS NOT WHAT IS MISSING. Report 24 measures
--      REALISATION, which is a period movement. Outstanding piutang per sektor
--      is already frozen per akad, with `sektor_id` on the row, in
--      `kolektibilitas_snapshot` (migrations/0011). Adding a second frozen
--      per-sektor balance would create two frozen answers to one question.
--
-- SO: A CHILD OF THE FROZEN ROW, CARRYING FLOW ONLY.
-- `saldo_akun_dimensi_periode` decomposes ONE frozen account row's two
-- movement columns and nothing else. It has no saldo_awal, no saldo_akhir and
-- no identity CHECK, because it makes no claim about a balance. The parent row
-- remains the sole authority for balances; the child rows only say how the
-- parent's movement was distributed.
--
-- THE PROPERTY THAT MAKES A DIMENSIONED ROW AND AN UNDIMENSIONED ROW UNABLE TO
-- DISAGREE. The decomposition is TOTAL, per axis: for a given frozen account
-- row and a given `sumbu`, the children's `mutasi_debit` sums to the parent's
-- `mutasi_debit` and their `mutasi_kredit` to the parent's, exactly, or the
-- transaction does not commit. Movement that carries no dimension is not
-- omitted, it is a RESIDUAL ROW (both id columns NULL), which is why the sum
-- can be exact instead of "less than or equal". A partial decomposition, the
-- state in which per-sektor figures quietly add up to less than the account,
-- is unrepresentable.
--
-- WHY AN AXIS COLUMN RATHER THAN ONE DIMENSION PER ROW. Sektor and bidang are
-- two INDEPENDENT partitions of the same movement. Without `sumbu`, an account
-- decomposed both ways would have its children summed across both partitions
-- and would double the account's movement while every individual row remained
-- correct. With `sumbu`, each partition reconciles to the parent on its own and
-- a second axis can never inflate the first. No account in the shipped chart is
-- decomposed both ways today; the column exists so that the day one is, the
-- arithmetic still cannot break.
--
-- REOPEN, WHICH IS WHY THE PARENT IS THE FOREIGN KEY AND NOT (periode, cabang,
-- akun). `bukaKembaliPeriode` executes `DELETE FROM saldo_akun_periode WHERE
-- periode_id = $1` and nothing else (modules/closing/repo.ts). Hanging the
-- children off `saldo_akun_periode(id) ON DELETE CASCADE` means a reopen sweeps
-- the dimensioned figures with the balances, in the same statement, with no
-- change to the closing engine and no possibility of a stale per-sektor figure
-- surviving into a re-close and reconciling against a NEW parent row. It also
-- makes "a dimensioned figure for an account that was never frozen"
-- structurally impossible rather than merely unlikely.
--
-- CASCADE HERE, RESTRICT IN 0026, AND THE DIFFERENCE IS NOT TASTE.
-- `penyisihan_periode_jurnal` links to journals of a closed period: nothing
-- deletes those, and a deletion that orphaned them should fail loudly. These
-- rows are derived, regenerable from the ledger, and deleting them on reopen is
-- the DEFINED behaviour of spec 8.4. The same reasoning that leaves
-- `saldo_akun_periode` without a delete guard (migrations/0011) and without a
-- TRUNCATE guard (migrations/0021, "what cannot be reconstructed is what cannot
-- be removed") applies unchanged to its children.
--
-- WHAT THIS MIGRATION DOES NOT DO, STATED SO NOBODY READS IT AS DONE.
-- Nothing writes these rows yet. `tutupPeriode` freezes `saldo_akun_periode`
-- from `v_ledger_baris` and must be extended to freeze the decomposition from
-- `jurnal_baris.dimensi_json` with the same ADR 0010 predicate; until it is,
-- a closed period has no dimensioned rows and modules/rka must keep refusing
-- rather than fall back to the live ledger. That is the same fail-closed
-- handover as 0024 and 0025. And for PUMK the freeze is only as good as its
-- input: `PENCAIRAN_PUMK` puts no `sektorId` in `dimensi_json`, so until
-- modules/pumk adds it (ADR 0016) a per-sektor freeze can only be derived from
-- `pumk_proposal.sektor_id`, which is editable. Freezing it at least stops the
-- figure moving AFTER the close; it does not stop it moving before.

-- up

CREATE TABLE saldo_akun_dimensi_periode (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The frozen account row this decomposes. CASCADE: see the file header.
  saldo_akun_periode_id UUID NOT NULL
    REFERENCES saldo_akun_periode(id) ON DELETE CASCADE,
  -- WHICH PARTITION this row belongs to. Children are reconciled to the parent
  -- per axis, so two axes over one account cannot inflate each other.
  sumbu TEXT NOT NULL CHECK (sumbu IN ('SEKTOR', 'BIDANG')),
  -- The bucket. Exactly one of these may be non-null and it must match `sumbu`;
  -- BOTH null is the RESIDUAL bucket, "movement on this account that carried no
  -- value on this axis", which is a real and reportable quantity rather than a
  -- rounding gap.
  sektor_id UUID REFERENCES sektor_pumk(id),
  bidang_id UUID REFERENCES bidang_non_pumk(id),
  -- DEBIT POSITIVE, gross, exactly like the parent's two movement columns. Both
  -- sides are frozen rather than a single net figure: a report that wants the
  -- account's normal direction computes debit - kredit and flips on
  -- akun.saldo_normal, which is what the parent already forces it to do, and a
  -- netted column would make a month with 5.000.000 disbursed and 5.000.000
  -- reversed indistinguishable from a month with no activity.
  mutasi_debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (mutasi_debit >= 0),
  mutasi_kredit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (mutasi_kredit >= 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT saldo_akun_dimensi_periode_sumbu_ck CHECK (
    (sumbu = 'SEKTOR' AND bidang_id IS NULL)
    OR (sumbu = 'BIDANG' AND sektor_id IS NULL)
  )
);

-- One row per bucket per axis, including exactly one residual per axis.
-- NULLS NOT DISTINCT is what makes the residual unique instead of unlimited:
-- without it, "movement with no sektor" could be written twice and the total
-- check would still pass on the sum while the report showed the residual twice.
CREATE UNIQUE INDEX saldo_akun_dimensi_periode_uq
  ON saldo_akun_dimensi_periode (saldo_akun_periode_id, sumbu, sektor_id, bidang_id)
  NULLS NOT DISTINCT;
CREATE INDEX saldo_akun_dimensi_periode_induk_idx
  ON saldo_akun_dimensi_periode (saldo_akun_periode_id, sumbu);
CREATE INDEX saldo_akun_dimensi_periode_sektor_idx
  ON saldo_akun_dimensi_periode (sektor_id) WHERE sektor_id IS NOT NULL;
CREATE INDEX saldo_akun_dimensi_periode_bidang_idx
  ON saldo_akun_dimensi_periode (bidang_id) WHERE bidang_id IS NOT NULL;

SELECT tjsl_attach_audit_trigger('saldo_akun_dimensi_periode');
SELECT tjsl_attach_audit_fk('saldo_akun_dimensi_periode');
SELECT tjsl_attach_soft_delete_check('saldo_akun_dimensi_periode');

-- Row level: the bucket must belong to the same BUMN as the period it is
-- filed under. Immediate, because every fact it reads is known at INSERT.
--
-- This is not hypothetical tidiness. `sektor_pumk` and `bidang_non_pumk` are
-- per-BUMN master tables and the only thing tying a bucket to a period today
-- would be the closing engine's own query. A cross-entity row would attribute
-- one BUMN's disbursement to another BUMN's sector, the two would still sum to
-- their own parents, and no total anywhere would move.
CREATE OR REPLACE FUNCTION tjsl_saldo_dimensi_baris() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  bumn_periode UUID;
  bumn_dimensi UUID;
BEGIN
  SELECT p.bumn_id INTO bumn_periode
    FROM saldo_akun_periode s
    JOIN periode p ON p.id = s.periode_id
   WHERE s.id = NEW.saldo_akun_periode_id;
  -- Existence is the foreign key's job; the firing order of an internal RI
  -- trigger relative to this one is not something to bet a guard on.
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF NEW.sektor_id IS NOT NULL THEN
    SELECT bumn_id INTO bumn_dimensi FROM sektor_pumk WHERE id = NEW.sektor_id;
  ELSIF NEW.bidang_id IS NOT NULL THEN
    SELECT bumn_id INTO bumn_dimensi FROM bidang_non_pumk WHERE id = NEW.bidang_id;
  ELSE
    -- The residual bucket names no master row and has nothing to check.
    RETURN NULL;
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF bumn_dimensi <> bumn_periode THEN
    RAISE EXCEPTION
      'TJSL-SDP-001: dimensi milik BUMN % dipakai pada saldo beku periode milik BUMN %',
      bumn_dimensi, bumn_periode
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER trg_saldo_akun_dimensi_periode_20_baris
  AFTER INSERT OR UPDATE ON saldo_akun_dimensi_periode
  FOR EACH ROW EXECUTE FUNCTION tjsl_saldo_dimensi_baris();

-- Aggregate: a decomposition is TOTAL or it does not exist.
--
-- Deferred, because the parent and its children are written in either order
-- inside one closing transaction, and installed on BOTH tables, because
-- otherwise a frozen movement could be restated without touching the
-- decomposition and the two would drift apart silently. Same construction as
-- migrations/0026, and the same reason.
--
-- An account with NO children on an axis is not in breach: most accounts are
-- never decomposed, and requiring a residual row for every account in the trial
-- balance would multiply the frozen table by the number of axes for no reader.
-- The rule is conditional on the CLAIM: once a single row on an axis exists,
-- that axis must account for the whole movement.
CREATE OR REPLACE FUNCTION tjsl_saldo_dimensi_total() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  induk UUID;
  saring TEXT;
  ax TEXT;
  d_induk NUMERIC(20,2);
  k_induk NUMERIC(20,2);
  d_anak NUMERIC(20,2);
  k_anak NUMERIC(20,2);
BEGIN
  -- Branching statements, NOT a CASE expression over NEW: one function serves
  -- two tables and plpgsql resolves every field reference in an expression it
  -- evaluates, so a CASE arm that never runs still fails with "record new has
  -- no field" on the other table. Recorded in ADR 0015; it cost an hour once.
  IF TG_TABLE_NAME = 'saldo_akun_periode' THEN
    -- A restated frozen movement has to be re checked against EVERY axis that
    -- claims to decompose it, so this side passes no filter.
    induk := NEW.id;
    saring := NULL;
  ELSIF TG_OP = 'DELETE' THEN
    induk := OLD.saldo_akun_periode_id;
    saring := OLD.sumbu;
  ELSE
    induk := NEW.saldo_akun_periode_id;
    saring := NEW.sumbu;
  END IF;

  SELECT mutasi_debit, mutasi_kredit INTO d_induk, k_induk
    FROM saldo_akun_periode WHERE id = induk AND deleted_at IS NULL;
  -- Parent gone inside this transaction (a reopen, or a soft delete). Its
  -- foreign key has the final word on whether that was allowed, and there is
  -- nothing left to reconcile against.
  IF NOT FOUND THEN RETURN NULL; END IF;

  FOR ax IN
    SELECT DISTINCT sumbu FROM saldo_akun_dimensi_periode
     WHERE saldo_akun_periode_id = induk
       AND deleted_at IS NULL
       AND (saring IS NULL OR sumbu = saring)
  LOOP
    SELECT COALESCE(sum(mutasi_debit), 0)::numeric(20,2),
           COALESCE(sum(mutasi_kredit), 0)::numeric(20,2)
      INTO d_anak, k_anak
      FROM saldo_akun_dimensi_periode
     WHERE saldo_akun_periode_id = induk AND sumbu = ax AND deleted_at IS NULL;

    IF d_anak <> d_induk OR k_anak <> k_induk THEN
      RAISE EXCEPTION
        'TJSL-SDP-002: rincian per % pada saldo beku % berjumlah (D %, K %) sedangkan saldo akunnya (D %, K %)',
        ax, induk, d_anak, k_anak, d_induk, k_induk
        USING ERRCODE = 'restrict_violation',
              HINT = 'Rincian dimensi harus MENGURAI seluruh mutasi akun periode itu. Mutasi yang tidak membawa dimensi ditulis sebagai satu baris sisa (sektor_id dan bidang_id NULL), bukan dihilangkan.';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_saldo_akun_dimensi_periode_30_total
  AFTER INSERT OR UPDATE OR DELETE ON saldo_akun_dimensi_periode
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tjsl_saldo_dimensi_total();

CREATE CONSTRAINT TRIGGER trg_saldo_akun_periode_30_total_dimensi
  AFTER INSERT OR UPDATE ON saldo_akun_periode
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tjsl_saldo_dimensi_total();

COMMENT ON TABLE saldo_akun_dimensi_periode IS
  'Rincian mutasi satu baris saldo_akun_periode menurut satu sumbu dimensi (sektor atau bidang), dibekukan saat periode ditutup. Hanya arus (mutasi), tidak pernah saldo: induknya tetap satu satunya sumber saldo. Penguraian wajib TOTAL per sumbu, dijaga constraint trigger deferred, dan mutasi tanpa dimensi ditulis sebagai baris sisa.';
COMMENT ON COLUMN saldo_akun_dimensi_periode.sumbu IS
  'Partisi mana yang diuraikan baris ini. Setiap sumbu direkonsiliasi sendiri sendiri terhadap induknya, sehingga dua sumbu atas satu akun tidak bisa saling menggandakan.';
COMMENT ON COLUMN saldo_akun_dimensi_periode.sektor_id IS
  'Sektor PUMK bucket ini. NULL pada sumbu SEKTOR berarti baris SISA: mutasi akun ini yang tidak membawa sektor apa pun.';
COMMENT ON COLUMN saldo_akun_dimensi_periode.bidang_id IS
  'Bidang Non PUMK bucket ini. NULL pada sumbu BIDANG berarti baris SISA.';

-- down
-- Nothing outside this migration references the table, so the rollback is the
-- exact inverse: the constraint trigger installed ON `saldo_akun_periode` goes
-- first (it is the only object this migration attached to a pre-existing
-- table), then the table itself with its own triggers and indexes, then the two
-- functions. `saldo_akun_periode` is left byte-identical to its pre-0027 shape:
-- no column was added to it and no constraint of its own was touched.
DROP TRIGGER IF EXISTS trg_saldo_akun_periode_30_total_dimensi ON saldo_akun_periode;
DROP TABLE IF EXISTS saldo_akun_dimensi_periode;
DROP FUNCTION IF EXISTS tjsl_saldo_dimensi_total();
DROP FUNCTION IF EXISTS tjsl_saldo_dimensi_baris();
