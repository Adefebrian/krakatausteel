-- 0026_penyisihan_jurnal_satu_ke_banyak.sql
--
-- The period's provision is carried by a SET of journals. The schema now says
-- so, and checks it.
--
-- THE DEFECT, AS PROBED RATHER THAN REASONED ABOUT. The closing engine corrects
-- a provision by posting the DELTA, not by reversing and re-posting: a
-- requirement of 10.200.000 posts one journal for 10.200.000, and a corrected
-- rate then posts a second for 1.200.000. The ledger ends at 11.400.000, which
-- is right. `penyisihan_periode` then states
-- `beban_penyisihan_periode = 11.400.000` next to a `jurnal_id` naming an entry
-- worth 1.200.000, because each run repoints the column at whatever it just
-- posted.
--
-- That is not a cosmetic mismatch. Spec 16 scenario 17 has an operator
-- reconcile Laporan Perhitungan Penyisihan against the provision journal. A
-- report that follows `jurnal_id` reconstructs 1.200.000 against a stated
-- 11.400.000 and fails the check the specification asks for; a report that sums
-- every provision journal in the period reconciles. Both readings are
-- defensible from migrations/0011, and THAT is the actual defect: the schema
-- does not say which is correct.
--
-- DELTA POSTING IS KEPT. Reversing a correct entry in order to re-post a larger
-- one puts churn in the ledger for what is a refinement rather than a mistake,
-- and in this system a reversal MEANS a mistake was made (ADR 0010, spec 6.3).
-- The ambiguity is a modelling defect, so it is fixed in the model rather than
-- papered over by constraining the engine to produce exactly one journal
-- forever.
--
-- A JOIN TABLE, NOT A DERIVED SET. The cheap option was to drop the singular
-- column and let a report re-derive the set as "every journal in this period
-- with this jenis". Rejected on two grounds. It is a heuristic, not a record: a
-- manual journal may legitimately carry `jenis = 'PENYISIHAN'` for the same
-- period and branch, and it would be counted into the automated movement with
-- nothing to distinguish it. And it is unenforceable: a derived set cannot be
-- checked against `beban_penyisihan_periode`, so the one property spec 16
-- scenario 17 depends on would rest on a convention. An implicit link that
-- nothing verifies is the same class of thing as a stored default nothing
-- reads.
--
-- (`jurnal.referensi_tipe` / `referensi_id`, the polymorphic back-reference the
-- ledger already ships, was the third candidate and is the near-miss. Right
-- multiplicity, right direction, no new table. It carries no signed
-- contribution, so a recovery and a formation cannot be told apart without
-- inspecting the lines; `referensi_id` is deliberately NOT a foreign key
-- because it spans a dozen tables; and enforcing the total would mean a
-- closing-specific aggregate trigger on `jurnal` itself, which puts one
-- module's arithmetic inside the shared ledger table. The engine should still
-- set it, for the audit trail and the reversal registry, but it is not the
-- record of the provision.)
--
-- THE PROPERTY THIS BUYS. `SUM(nilai)` over a row's links equals its
-- `beban_penyisihan_periode`, or the transaction fails at COMMIT. Deferred,
-- because the row and its links are written in either order inside one
-- transaction, and enforced from BOTH sides, because otherwise the movement
-- could be restated without touching the links. It holds exactly under the
-- engine's own delta arithmetic, including recoveries: 10.200.000 then
-- +1.200.000 then -2.400.000 sums to the 9.000.000 the row would then state.
-- Precedent for a deferred cross-row invariant is 0008's
-- `SUM(pokok) = akad.pokok_pinjaman`, extended by 0019.
--
-- REVERSAL DOES NOT BREAK IT, ON PURPOSE. Reversing a provision journal is a
-- supported correction (closing-penyisihan.test.ts does it, "salah periode"),
-- and the system reads the consequence from the LEDGER: the next period's
-- opening allowance comes from `v_ledger_baris`, never from these rows. So a
-- link records which entry carried a decision at the time it was made, and a
-- later reversal does not retroactively unmake that fact. No trigger on
-- `jurnal` fires here, and that workflow keeps working unchanged.
--
-- REOPEN. `bukaKembaliPeriode` deletes `saldo_akun_periode` and nothing else,
-- so a reopened period keeps its `penyisihan_periode` row, its journals and its
-- links. Re-running after a re-open posts one more delta and appends one more
-- link, and the total invariant holds across the re-close by construction. The
-- foreign key to `penyisihan_periode` is deliberately restrictive rather than
-- ON DELETE CASCADE: nothing deletes that row today, and a future deletion that
-- would orphan the journals of a closed period should fail loudly.

-- up

CREATE TABLE penyisihan_periode_jurnal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  penyisihan_periode_id UUID NOT NULL REFERENCES penyisihan_periode(id),
  jurnal_id UUID NOT NULL REFERENCES jurnal(id),
  -- SIGNED contribution of this entry to the period's movement: positive is a
  -- formation (BEBAN_PENYISIHAN), negative a recovery (PEMULIHAN_PENYISIHAN),
  -- matching the sign convention of `beban_penyisihan_periode` itself. The
  -- direction cannot be read off the journal, because both events post under
  -- `jenis = 'PENYISIHAN'` and only the accounts differ, so it is recorded
  -- rather than inferred. Never zero: a journal that moved nothing is not part
  -- of the movement, and spec 8.2 step 4 posts none.
  nilai NUMERIC(20,2) NOT NULL CHECK (nilai <> 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

-- A journal belongs to exactly ONE period-branch provision. Stronger than
-- uniqueness within a parent: it makes double attribution impossible ACROSS
-- rows, which is the way a total gets inflated without any single row looking
-- wrong.
CREATE UNIQUE INDEX penyisihan_periode_jurnal_jurnal_uq
  ON penyisihan_periode_jurnal (jurnal_id) WHERE deleted_at IS NULL;
CREATE INDEX penyisihan_periode_jurnal_induk_idx
  ON penyisihan_periode_jurnal (penyisihan_periode_id);

SELECT tjsl_attach_audit_trigger('penyisihan_periode_jurnal');
SELECT tjsl_attach_audit_fk('penyisihan_periode_jurnal');
SELECT tjsl_attach_soft_delete_check('penyisihan_periode_jurnal');

-- Row-level: a link must actually describe the journal it names. Immediate, not
-- deferred, because every fact it checks is known the moment the row is
-- written, and a wrong link should be refused at its own INSERT rather than at
-- a COMMIT far away from the code that caused it.
CREATE OR REPLACE FUNCTION tjsl_penyisihan_jurnal_baris() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  j RECORD;
  p RECORD;
BEGIN
  SELECT periode_id, cabang_id, status, total_debit INTO j
    FROM jurnal WHERE id = NEW.jurnal_id;
  -- Existence is the foreign key's job, and the firing order of an internal RI
  -- trigger relative to this one is not something to bet a guard on. If the row
  -- is not there yet, say nothing and let the FK be the one to refuse.
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT periode_id, cabang_id INTO p
    FROM penyisihan_periode WHERE id = NEW.penyisihan_periode_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF j.periode_id <> p.periode_id OR j.cabang_id <> p.cabang_id THEN
    RAISE EXCEPTION
      'TJSL-PEN-001: jurnal % bukan milik periode/cabang baris penyisihan %',
      NEW.jurnal_id, NEW.penyisihan_periode_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF j.status = 'DRAFT' THEN
    RAISE EXCEPTION
      'TJSL-PEN-002: jurnal % masih DRAFT dan tidak boleh dihitung sebagai penyisihan yang sudah terposting',
      NEW.jurnal_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF abs(NEW.nilai) <> j.total_debit THEN
    RAISE EXCEPTION
      'TJSL-PEN-003: nilai kontribusi % tidak sama dengan nilai jurnal % (%)',
      NEW.nilai, NEW.jurnal_id, j.total_debit
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER trg_penyisihan_periode_jurnal_20_baris
  AFTER INSERT OR UPDATE ON penyisihan_periode_jurnal
  FOR EACH ROW EXECUTE FUNCTION tjsl_penyisihan_jurnal_baris();

-- Aggregate: the links and the stated movement agree, or the transaction does
-- not commit. This is the property spec 16 scenario 17 rests on, moved out of
-- the report's assumptions and into the database.
CREATE OR REPLACE FUNCTION tjsl_penyisihan_jurnal_total() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  target UUID;
  dinyatakan NUMERIC(20,2);
  terhubung NUMERIC(20,2);
BEGIN
  -- Branching statements, NOT a CASE expression. One function serves two
  -- tables, and plpgsql resolves every field reference in an expression it
  -- evaluates, so a `CASE ... ELSE NEW.penyisihan_periode_id END` fails with
  -- "record new has no field" on the `penyisihan_periode` side even when the
  -- matching arm never needed it. Found by probing, not by reading.
  IF TG_TABLE_NAME = 'penyisihan_periode' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.penyisihan_periode_id;
  ELSE
    target := NEW.penyisihan_periode_id;
  END IF;

  SELECT beban_penyisihan_periode INTO dinyatakan
    FROM penyisihan_periode WHERE id = target AND deleted_at IS NULL;
  -- The parent went away inside this transaction; its foreign key has the
  -- final word on whether that was allowed, and there is nothing to compare.
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(nilai), 0)::numeric(20,2) INTO terhubung
    FROM penyisihan_periode_jurnal
   WHERE penyisihan_periode_id = target AND deleted_at IS NULL;

  IF terhubung <> dinyatakan THEN
    RAISE EXCEPTION
      'TJSL-PEN-004: total jurnal penyisihan yang tertaut (%) tidak sama dengan beban_penyisihan_periode (%) pada baris %',
      terhubung, dinyatakan, target
      USING ERRCODE = 'restrict_violation',
            HINT = 'Setiap jurnal delta yang diposting untuk periode/cabang ini harus punya baris di penyisihan_periode_jurnal, dan jumlah bertandanya harus sama dengan pergerakan yang dinyatakan.';
  END IF;
  RETURN NULL;
END;
$fn$;

-- Deferred, because a row and its links are written in either order within one
-- transaction, and enforced from BOTH sides, because a movement restated
-- without touching the links is exactly the drift this exists to catch.
CREATE CONSTRAINT TRIGGER trg_penyisihan_periode_jurnal_30_total
  AFTER INSERT OR UPDATE OR DELETE ON penyisihan_periode_jurnal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tjsl_penyisihan_jurnal_total();

CREATE CONSTRAINT TRIGGER trg_penyisihan_periode_30_total_jurnal
  AFTER INSERT OR UPDATE ON penyisihan_periode
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tjsl_penyisihan_jurnal_total();

-- The singular column goes. Leaving it beside the join table would preserve the
-- exact ambiguity this migration exists to remove: a report author follows the
-- column because it is there, and gets the last delta.
--
-- This migration refuses to run against existing rows rather than backfilling
-- one link per surviving `jurnal_id`. That backfill would be a guess in the one
-- case that matters: a row whose movement was carried by several journals has
-- kept only the last, so the invented link would state a total the new
-- constraint immediately, and correctly, rejects. Which entries carried a
-- closed period's provision is a data question for the accounting owner,
-- answered by reading the ledger, not by a migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM penyisihan_periode) THEN
    RAISE EXCEPTION
      'TJSL-MIG-0026: penyisihan_periode sudah berisi baris dengan jurnal_id tunggal. '
      'Migrasi ini menolak menebak jurnal mana saja yang membentuk pergerakan periode itu: '
      'baris yang pergerakannya dibawa lebih dari satu jurnal hanya menyimpan yang terakhir. '
      'Database produksi: rekonstruksi tautannya dari buku besar bersama pemilik akuntansi lewat '
      'migrasi backfill tersendiri, lalu jalankan ulang. '
      'Database pengembangan atau CI: isinya residu test, jalankan `bun run db:reset`.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$$;

ALTER TABLE penyisihan_periode DROP COLUMN jurnal_id;

COMMENT ON TABLE penyisihan_periode_jurnal IS
  'Jurnal jurnal yang membentuk pergerakan penyisihan satu periode dan cabang. Satu ke banyak, karena koreksi diposting sebagai delta dan bukan sebagai pembalikan (ADR 0015). Jumlah bertanda kolom nilai WAJIB sama dengan penyisihan_periode.beban_penyisihan_periode, dijaga constraint trigger deferred.';
COMMENT ON COLUMN penyisihan_periode_jurnal.nilai IS
  'Kontribusi bertanda jurnal ini terhadap pergerakan periode: positif pembentukan, negatif pemulihan. Besarannya wajib sama dengan jurnal.total_debit.';

-- down
-- Restores the pre-0026 shape: the singular column comes back nullable with its
-- foreign key, as 0011 declared it, and the join table, its two functions and
-- its three triggers all go. Restoring the column's VALUES is not a question,
-- because the up section refuses to run unless `penyisihan_periode` is empty,
-- so there were none to lose.
--
-- ONE RESIDUAL DIFFERENCE, STATED RATHER THAN GLOSSED: `jurnal_id` comes back
-- as the LAST column of the table instead of the seventh. Postgres cannot
-- reinsert a column at an ordinal position, so no rollback of a DROP COLUMN can
-- restore that, and the alternative (rebuilding the table inside a rollback) is
-- worse than the difference. Type, nullability, foreign key, and every other
-- object in the table are byte-identical to the pre-0026 dump; the diff below
-- the migration shows exactly that one line moving.
DROP TRIGGER IF EXISTS trg_penyisihan_periode_30_total_jurnal ON penyisihan_periode;
DROP TABLE IF EXISTS penyisihan_periode_jurnal;
DROP FUNCTION IF EXISTS tjsl_penyisihan_jurnal_total();
DROP FUNCTION IF EXISTS tjsl_penyisihan_jurnal_baris();
ALTER TABLE penyisihan_periode ADD COLUMN jurnal_id UUID REFERENCES jurnal(id);
