-- 0025_provenance_akrual_dan_status_periode.sql
--
-- Two records that were not saying what they appear to say. Both are the same
-- question 0024 answered for the provision rate: what does a row actually let
-- a reader reconstruct, years later, after the configuration has moved on.
--
-- ---------------------------------------------------------------------------
-- 1. akrual_jasa_snapshot: the method and the eligible classes
-- ---------------------------------------------------------------------------
--
-- THE GAP. `akrual_jasa_snapshot` records the fee due, the fee received and the
-- fee accrued per akad, and nothing about the POLICY that produced those rows.
-- Two policy inputs decide them: `akuntansi.metode_pengakuan_jasa_adm`, which
-- decides whether spec 8.3 runs at all, and
-- `akuntansi.akrual_hanya_untuk_kolektibilitas`, which decides WHICH akads it
-- runs over. `HasilAkrual` computes both at run time and then discards them.
-- Both live in `konfigurasi`, a table mutated in place. So an edit to either
-- one makes a closed period's Laporan Akrual Piutang Jasa Administrasi
-- (spec 10.4 report 30) unable to say why the akads in it are the akads in it.
-- Same invariant 14, same shape, different table (ADR 0014, OPEN-QUESTIONS 23).
--
-- WHY A PER-ROW COLUMN IS NOW THE RIGHT SHAPE, WHEN IT WAS NOT IN 0024's
-- REVIEW. At the time, the fact was per RUN and the accrual had no run header
-- to hang it on, so this was left open rather than guessed at. The engine has
-- since settled it: `jalankanAkrualJasaAdm` writes one row per akad in the
-- configured classes INCLUDING akads with zero fee due, because without a run
-- header a period where the step ran and produced nothing was indistinguishable
-- from a period where it never ran. There is therefore now a per-akad row to
-- carry the fact, and repeating a per-run value on every row of the run is
-- exactly what `kolektibilitas_snapshot` already does with `rate_penyisihan`
-- and `dasar_perhitungan`. No new table, no header to invent.
--
-- WHAT THIS RECOVERS, AND WHAT IT DOES NOT. It recovers the class list from any
-- period where AT LEAST ONE akad was in it, and that list then explains every
-- exclusion in that period: an akad with no row was not in `kelas_diakrual`.
-- It recovers NOTHING for a period whose list excluded the whole portfolio,
-- because there is no row to carry it. That residual hole is stated in full,
-- with the judgement on whether it warrants a run-header table after all, in
-- ADR 0015. It is not closed here and is not pretended to be.
--
-- NO DEFAULTS, SAME REASON AS 0024. A default lets an engine that never
-- considered provenance stamp a plausible value over a real one, silently, in a
-- period an auditor will later ask about. The schema refuses the row instead.
--
-- NO CHECK TYING `kolektibilitas` TO `kelas_diakrual`, DELIBERATELY. Today
-- every row's class is in the list, so `CHECK (kelas_diakrual ? kolektibilitas)`
-- would pass. It is still wrong to add: the obvious way to close the residual
-- hole above is to write a row for EVERY akad and let `kelas_diakrual ?
-- kolektibilitas` distinguish accrued from excluded, and that CHECK would
-- forbid precisely that improvement. Eligibility stays a READ-time predicate,
-- correct under both population rules.

-- up

ALTER TABLE akrual_jasa_snapshot
  -- Domain is `MetodePengakuanJasa` in modules/closing/contract.ts. Only one of
  -- its two members can ever produce a row here: under CASH_BASIS spec 8.3
  -- writes nothing at all. The CHECK says so, so that the PRESENCE of a row
  -- means "the accrual ran, under ACCRUAL" rather than "some row exists". A
  -- third recognition method arriving is a policy change, and a policy change
  -- earning a migration is correct.
  ADD COLUMN metode TEXT,
  -- The eligible-class list in force for the run that wrote this row, copied
  -- verbatim from `akuntansi.akrual_hanya_untuk_kolektibilitas`. JSONB rather
  -- than TEXT[] because that is the shape the config row itself carries and the
  -- shape `closing_kolektibilitas.ringkasan_json` already established.
  ADD COLUMN kelas_diakrual JSONB;

-- No row may exist without a provenance, and this migration refuses to invent
-- one. Which method and which class list produced an existing row is a data
-- question for the accounting owner, answered in a backfill migration of its
-- own, not guessed at here.
--
-- UNLIKE 0024, THIS ONE REALLY DOES FIRE. The accrual engine now exists, so any
-- database a test suite or a demo has run against carries rows. That is the
-- whole point on a production database, where those rows are accounting
-- history; on a development or CI database they are disposable residue, and the
-- sanctioned way to clear them is `bun run db:reset`, which rebuilds the schema
-- from zero. The message says so, because the person who hits this is far more
-- often a developer than an accountant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM akrual_jasa_snapshot) THEN
    RAISE EXCEPTION
      'TJSL-MIG-0025: akrual_jasa_snapshot sudah berisi baris tanpa metode/kelas_diakrual. '
      'Migrasi ini menolak menebak kebijakan yang menghasilkan baris lama. '
      'Database produksi: tentukan metode pengakuan dan daftar kelas yang berlaku per periode '
      'bersama pemilik akuntansi, isi lewat migrasi backfill tersendiri, lalu jalankan ulang. '
      'Database pengembangan atau CI: isinya residu test, jalankan `bun run db:reset`.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$$;

ALTER TABLE akrual_jasa_snapshot
  ALTER COLUMN metode SET NOT NULL,
  ALTER COLUMN kelas_diakrual SET NOT NULL,
  ADD CONSTRAINT akrual_jasa_snapshot_metode_ck CHECK (metode = 'ACCRUAL'),
  -- A non-empty JSON array drawn from the four codes in `kolektibilitas_kelas`.
  -- `<@` is jsonb containment, so every element is checked without a subquery,
  -- which a CHECK may not contain.
  ADD CONSTRAINT akrual_jasa_snapshot_kelas_ck CHECK (
    jsonb_typeof(kelas_diakrual) = 'array'
    AND jsonb_array_length(kelas_diakrual) > 0
    AND kelas_diakrual <@ '["LANCAR","KURANG_LANCAR","DIRAGUKAN","MACET"]'::jsonb
  );

COMMENT ON COLUMN akrual_jasa_snapshot.metode IS
  'Metode pengakuan jasa administrasi yang berlaku saat run ini berjalan. Selalu ACCRUAL: di bawah CASH_BASIS spec 8.3 tidak menulis baris sama sekali, jadi adanya baris di sini adalah buktinya. Wajib, tanpa default: lihat migrations/0025.';
COMMENT ON COLUMN akrual_jasa_snapshot.kelas_diakrual IS
  'Daftar kelas kolektibilitas yang berhak diakrual saat run ini berjalan, disalin dari akuntansi.akrual_hanya_untuk_kolektibilitas. Menjelaskan populasi laporan 30: akad tanpa baris di periode ini berarti kelasnya tidak ada di daftar ini.';

-- ---------------------------------------------------------------------------
-- 2. periode.status: CLOSING_IN_PROGRESS is kept, and stops being ambiguous
-- ---------------------------------------------------------------------------
--
-- The value is named by the specification (Bagian 4.7 periode) and allowed by
-- 0007's CHECK, and nothing writes it. Kept, not dropped, and the reasoning is
-- ADR 0015. In short: it is not dead weight, because the ledger's period guard
-- already refuses any journal in a period that is not OPEN, so the value has a
-- live and correct meaning the day anyone writes it ("books frozen, month end
-- in progress"). What it is NOT is a crash-recovery marker: `tutupPeriode` runs
-- in ONE transaction, so a crash rolls the whole close back and leaves nothing
-- half finished to find, and no other session can observe an uncommitted status
-- anyway.
--
-- A COMMENT rather than a code change, because the question this closes is
-- "may a reader assume this value is reachable", and that question is answered
-- where the reader is: on the column.

COMMENT ON COLUMN periode.status IS
  'OPEN, CLOSING_IN_PROGRESS, CLOSED (spec Bagian 4.7). CLOSING_IN_PROGRESS SENGAJA BELUM PERNAH DITULIS: closing berjalan dalam satu transaksi, jadi status antara itu tidak punya pengamat dan bukan penanda crash recovery. Nilainya dipertahankan karena guard periode di jurnal sudah menolak posting untuk periode yang bukan OPEN, sehingga ia langsung bermakna "buku dibekukan selama rangkaian tutup buku" begitu ada yang menulisnya. Kapan (dan apakah) buku dibekukan di antara langkah 8.1 sampai 8.4 adalah pertanyaan kebijakan klien: OPEN-QUESTIONS butir 24. Lihat ADR 0015.';

-- down
-- Restores the pre-0025 shape exactly. The two columns and their constraints go
-- together; dropping the columns drops the CHECKs and the COMMENTs with them,
-- and the constraints are named here as well so a rollback reads without
-- knowing that rule. `periode.status` goes back to having no comment, which is
-- what 0007 left it with.
ALTER TABLE akrual_jasa_snapshot
  DROP CONSTRAINT IF EXISTS akrual_jasa_snapshot_kelas_ck,
  DROP CONSTRAINT IF EXISTS akrual_jasa_snapshot_metode_ck;
ALTER TABLE akrual_jasa_snapshot
  DROP COLUMN IF EXISTS kelas_diakrual,
  DROP COLUMN IF EXISTS metode;
COMMENT ON COLUMN periode.status IS NULL;
