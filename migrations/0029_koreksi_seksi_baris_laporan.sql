-- 0029_koreksi_seksi_baris_laporan.sql
--
-- Corrects `baris_laporan.seksi` ON DATABASES THAT ALREADY RAN THE SEED. The
-- catalogue in apps/api/src/seed/coa-inti.ts is fixed too (commit dfcd477), but
-- that only helps a database seeded from now on: `seedCoaInti` inserts its
-- report lines `ON CONFLICT ... DO NOTHING` by design, for the same reason the
-- event mapping does (ADR 0004: a layout an accountant has adjusted must
-- survive every future `db:seed`). So the wrong rows would have survived on
-- dev, on staging and on the client's install, and this is the second time
-- this project has paid for that: migrations/0023 exists because a catalogue
-- fix could not reach an already seeded database either.
--
-- ---------------------------------------------------------------------------
-- THE BUG
-- ---------------------------------------------------------------------------
-- The seed before dfcd477 wrote its report lines with the statement's own name
-- in the section column:
--
--   INSERT INTO baris_laporan (..., laporan, ..., seksi, ...)
--   VALUES ($1, $2, ..., $2, ...)          -- $2 is `laporan`, used twice
--
-- so every line landed with `seksi = laporan`, which names no section of
-- anything. `baris_laporan.seksi` is structure, not wording (migrations/0005,
-- and modules/laporan's "Section keys. NOT captions."):
--
--   POSISI_KEUANGAN     ASET / LIABILITAS / ASET_NETO
--   ARUS_KAS            OPERASI / INVESTASI / PENDANAAN
--   AKTIVITAS           the `kode` of the POSISI_KEUANGAN line whose section is
--                       ASET_NETO, i.e. the net-asset CATEGORY this movement
--                       belongs to
--   PERUBAHAN_ASET_NETO the same category, as its own line
--
-- The consequence is not cosmetic and it is not silent. Reports 17, 19 and 20
-- attribute the surplus to a net-asset category through that column, and an
-- AKTIVITAS line whose section names no category is a REFUSAL, never a silent
-- drop (a dropped movement would make `saldoAkhir != saldoAwal + perubahan`
-- with nothing on the page to show it). So on every database seeded before the
-- fix, Laporan Posisi Keuangan answers
--
--   SEKSI_ASET_NETO_TIDAK_DIKENAL: "Seksi AKTIVITAS pada baris Laporan
--   Aktivitas tidak cocok dengan satu pun kategori aset neto."
--
-- and reports 17 and 20 refuse with it. The flagship statement of the system
-- cannot be printed at all.
--
-- ---------------------------------------------------------------------------
-- NARROW ON PURPOSE, AND IT REFUSES TO GUESS. THREE DIFFERENT ANSWERS.
-- ---------------------------------------------------------------------------
-- Only rows that still carry the shipped default are considered at all: `seksi`
-- equal to the row's own `laporan`, AND one of the six (laporan, kode) pairs the
-- broken seed actually shipped. Those six are the whole of BARIS_LAPORAN_INTI as
-- it stood at b35ef62 (the ARUS_KAS and PERUBAHAN_ASET_NETO lines did not exist
-- yet, so no database can carry a broken one). A row an accountant has already
-- repointed does not match and is left exactly as they left it, which is the
-- rule the seed follows and the rule 0023 was written to. Beyond that:
--
-- 1. A POSISI_KEUANGAN ROW IS CORRECTED OUTRIGHT. ASET, PENYISIHAN_KONTRA,
--    LIABILITAS and ASET_NETO map to ASET, ASET, LIABILITAS and ASET_NETO, and
--    that vocabulary is fixed (modules/laporan's three section keys, which
--    mirror the CHECK on `akun.tipe`). No template can make it something else.
--
-- 2. AN AKTIVITAS ROW IS CORRECTED ONLY WHEN ITS TEMPLATE LEAVES EXACTLY ONE
--    POSSIBLE ANSWER, and it is corrected to THAT line's `kode`, not to the
--    literal 'ASET_NETO'. An AKTIVITAS section must name a net-asset CATEGORY
--    of its own template: a live, active POSISI_KEUANGAN DETAIL line whose own
--    section is ASET_NETO. When the template has exactly one such line, the
--    movement belongs to it, necessarily, and writing its code is not a guess:
--    it is the only value that can be right. That covers the shipped template
--    (one undivided category, coded ASET_NETO) AND a client template that
--    renamed it, e.g. ISAK 335's single "tanpa pembatasan" category.
--
-- 3. WHEN THE TEMPLATE HAS NO CATEGORY, OR MORE THAN ONE, THE ROW IS LEFT
--    ALONE AND RECORDED. A PSAK 45 template splits net assets into "tidak
--    terikat" and "terikat temporer" (migrations/0028 exists precisely so that
--    template can exist), and WHICH half a revenue line belongs to is an
--    accounting fact about that line that no migration can read off the schema.
--    Guessing would silently file restricted income as unrestricted, which
--    balances, prints, and is wrong. The rows are therefore left untouched and
--    listed in the receipt table with `keputusan = 'DILEWATI'` and a reason, so
--    the person who built that template can see exactly which lines still need
--    a decision:
--
--      SELECT * FROM _migrasi_0029_seksi_baris_laporan WHERE keputusan = 'DILEWATI';
--
--    Not a hard stop, deliberately. A template with two categories is a
--    SUPPORTED configuration, not a corruption, and refusing to migrate at all
--    would block every later migration on a database whose only fault is that
--    somebody customised a layout the seed shipped wrong.
--
-- 4. A ROW CARRYING THE STATEMENT NAME THAT IS NOT ONE OF THE SIX DOES STOP THE
--    MIGRATION. `seksi = laporan` is unambiguously wrong under every template
--    and every standard, but on a line this seed never shipped it means someone
--    hand-built a line and left the column as the statement's name. There is no
--    shipped default to reason from, so the migration names the rows and hands
--    the decision back. Same fail-closed handover as 0024, 0025, 0026 and 0028.
--
-- SOFT-DELETED AND INACTIVE LINES ARE CORRECTED TOO, unlike 0023's mapping
-- rows. 0005 keeps a deleted line's code reserved precisely so an old period
-- can still be reprinted through it, so a broken row left behind here is a
-- defect waiting to come back the day somebody reactivates the line. The
-- CATEGORY a row is corrected to must still be live and active, because a
-- section pointing at a deactivated line is exactly what the report refuses on.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT TOUCH: STAMPED TEMPLATES AND CLOSED PERIODS
-- ---------------------------------------------------------------------------
-- Checked, not assumed:
--
--   - `periode.template_laporan_id` (the stamp migration 0028 section 7 added
--     so a closed period reprints under the layout it was closed with) is not
--     read and not written here. Neither is any other `periode` column.
--   - No `template_laporan` row is created, retired or re-dated, so which
--     template is in force for any date is unchanged and the non-overlap
--     trigger `tjsl_template_laporan_tak_bertindih` is never provoked.
--   - `baris_laporan.template_id` is not written, so no line moves between
--     templates and no statement can end up mixing two. Every lookup this
--     migration makes is scoped to the row's OWN (bumn_id, template_id), so a
--     line of one template can never be corrected against another's categories.
--   - No account moves classification: `akun`, `klasifikasi_akun` and
--     `pemetaan_baris_laporan` are untouched, so every account resolves to the
--     same printed line as before.
--   - The FIGURES are per account in `saldo_akun_periode` and are template
--     independent (ADR 0017), and nothing here writes them. Neraca Lajur, the
--     per-account reconstruction of a closed period, is bit-identical before
--     and after.
--
-- What DOES change for a closed period is the GROUPING of the lines it prints:
-- the Aktivitas movements are now attributed to a net-asset category instead
-- of to a section called "AKTIVITAS". That is deliberate and it is not the
-- silent restatement 0028 exists to prevent, because there is nothing to
-- restate: a closed period on one of these databases cannot print Posisi
-- Keuangan, Aktivitas or Perubahan Aset Neto AT ALL today, so no issued
-- statement is being changed under anyone. ADR 0017 already records that
-- editing a template in place reshapes a closed period's presentation and that
-- the mitigation is evidence rather than prevention; the evidence here is the
-- receipt table, which names every row this migration changed, what it changed
-- it from, and every row it deliberately did not touch.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS A RECEIPT TABLE
-- ---------------------------------------------------------------------------
-- `_migrasi_0029_seksi_baris_laporan` records (row, old value, new value,
-- decision) for every row this migration considered, and the down restores from
-- it and drops it.
--
-- 0023's down could be a mirror-image narrow UPDATE because its "after" state
-- was unreachable by any other means. This one's is not: a database seeded from
-- the CURRENT code already has ASET, ASET_NETO and the rest in those exact rows,
-- and the up is a no-op there. A mirror-image down would therefore take a
-- database that never had the defect and INTRODUCE it, which is precisely the
-- rollback nobody expects and the one a developer meets first (migrations run
-- before the seed, so on a fresh database `baris_laporan` is empty at 0029 and
-- every correct row in it was written afterwards by `db:seed`).
--
-- The receipt makes the down exact instead of inferential: it restores the rows
-- this migration changed, to the values they had, and touches nothing else. The
-- table is left behind by the up on purpose, as the record of what a migration
-- silently rewrote in a table that carries no audit_log trail (`baris_laporan`
-- has only the touch trigger, which stamps updated_at and version and stores no
-- old value), and as the worklist of the rows it refused to decide.
--
-- ONE RESIDUAL DIFFERENCE, STATED RATHER THAN GLOSSED, and it is the same class
-- 0026 and 0028 recorded: `baris_laporan` carries `trg_baris_laporan_00_audit`,
-- so every UPDATE bumps `version` and `updated_at`. A down/up cycle restores
-- every VALUE exactly and leaves `version` two higher than it started.
-- Invariant 12 makes `version` monotonic on purpose; a migration that reset it
-- would be forging the row's history to make a diff look tidy.

-- up

-- ---------------------------------------------------------------------------
-- 1. Refuse to guess on a line this seed never shipped
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  nakal text;
BEGIN
  SELECT string_agg(format('%s/%s', bl.laporan, bl.kode), ', ' ORDER BY bl.laporan, bl.kode)
    INTO nakal
    FROM baris_laporan bl
   WHERE bl.seksi = bl.laporan
     AND (bl.laporan, bl.kode) NOT IN (
       VALUES ('POSISI_KEUANGAN', 'ASET'),
              ('POSISI_KEUANGAN', 'PENYISIHAN_KONTRA'),
              ('POSISI_KEUANGAN', 'LIABILITAS'),
              ('POSISI_KEUANGAN', 'ASET_NETO'),
              ('AKTIVITAS', 'PENDAPATAN'),
              ('AKTIVITAS', 'BEBAN')
     );

  IF nakal IS NOT NULL THEN
    RAISE EXCEPTION
      'TJSL-MIG-0029: baris laporan % memakai nama laporan sebagai seksi, tetapi bukan baris bawaan yang diseed sistem, jadi migrasi ini tidak tahu seksi yang benar dan tidak akan menebak.',
      nakal
      USING ERRCODE = 'restrict_violation',
            HINT = 'Perbaiki seksi baris tersebut lebih dulu (POSISI_KEUANGAN: ASET/LIABILITAS/ASET_NETO; ARUS_KAS: OPERASI/INVESTASI/PENDANAAN; AKTIVITAS dan PERUBAHAN_ASET_NETO: kode baris kategori aset neto), lalu jalankan migrasi ini lagi.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The receipt: what was decided, row by row
-- ---------------------------------------------------------------------------
CREATE TABLE _migrasi_0029_seksi_baris_laporan (
  baris_laporan_id UUID PRIMARY KEY REFERENCES baris_laporan(id),
  laporan TEXT NOT NULL,
  kode TEXT NOT NULL,
  seksi_lama TEXT,
  -- NULL exactly when the migration refused to decide.
  seksi_baru TEXT,
  keputusan TEXT NOT NULL CHECK (keputusan IN ('DIKOREKSI', 'DILEWATI')),
  alasan TEXT,
  dicatat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migrasi_0029_keputusan_ck CHECK (
    (keputusan = 'DIKOREKSI' AND seksi_baru IS NOT NULL) OR
    (keputusan = 'DILEWATI' AND seksi_baru IS NULL AND alasan IS NOT NULL)
  )
);

COMMENT ON TABLE _migrasi_0029_seksi_baris_laporan IS
  'Catatan baris_laporan yang seksinya dipertimbangkan migrasi 0029: yang dikoreksi beserta nilai lamanya, dan yang sengaja dilewati karena templatenya punya lebih dari satu (atau tidak punya) kategori aset neto sehingga jawabannya bukan urusan migrasi. Dipakai oleh rollback 0029 supaya pemulihannya persis, dan dibiarkan ada sesudahnya sebagai bukti perubahan (baris_laporan tidak punya jejak audit_log) sekaligus daftar kerja yang masih perlu diputuskan akuntan.';

-- ---------------------------------------------------------------------------
-- 3. Pass one: the statement of financial position
-- ---------------------------------------------------------------------------
--
-- FIRST, AND THE ORDER IS LOAD BEARING. An AKTIVITAS row is corrected by
-- looking for the net-asset CATEGORY of its template, which is a
-- POSISI_KEUANGAN line whose own `seksi` is ASET_NETO. On exactly the databases
-- this migration is for, that category line is itself still carrying
-- 'POSISI_KEUANGAN' in the column being looked at. Doing both passes in one
-- statement therefore finds no category anywhere and skips every AKTIVITAS row
-- as undecidable, which is a wrong answer that LOOKS like caution. (Found by
-- running it, not by reading it: the first draft did exactly that.)

INSERT INTO _migrasi_0029_seksi_baris_laporan
  (baris_laporan_id, laporan, kode, seksi_lama, seksi_baru, keputusan, alasan)
SELECT bl.id, bl.laporan, bl.kode, bl.seksi, p.seksi_benar, 'DIKOREKSI', NULL
  FROM baris_laporan bl
  JOIN (
    VALUES ('ASET',              'ASET'),
           ('PENYISIHAN_KONTRA', 'ASET'),
           ('LIABILITAS',        'LIABILITAS'),
           ('ASET_NETO',         'ASET_NETO')
  ) AS p(kode, seksi_benar) ON p.kode = bl.kode
 WHERE bl.laporan = 'POSISI_KEUANGAN'
   AND bl.seksi = bl.laporan;

UPDATE baris_laporan bl
   SET seksi = r.seksi_baru
  FROM _migrasi_0029_seksi_baris_laporan r
 WHERE r.baris_laporan_id = bl.id
   AND r.keputusan = 'DIKOREKSI'
   AND bl.seksi IS DISTINCT FROM r.seksi_baru;

-- ---------------------------------------------------------------------------
-- 3b. Pass two: the statement of activities, decided by its own template
-- ---------------------------------------------------------------------------
INSERT INTO _migrasi_0029_seksi_baris_laporan
  (baris_laporan_id, laporan, kode, seksi_lama, seksi_baru, keputusan, alasan)
SELECT bl.id, bl.laporan, bl.kode, bl.seksi, kat.kode,
       CASE WHEN kat.kode IS NULL THEN 'DILEWATI' ELSE 'DIKOREKSI' END,
       CASE WHEN kat.kode IS NULL THEN
         'Template ini tidak punya tepat satu baris POSISI_KEUANGAN bertipe DETAIL dengan seksi ASET_NETO, '
         'jadi kategori aset neto mana yang dimaksud baris ini adalah keputusan akuntan, bukan tebakan migrasi.'
       END
  FROM baris_laporan bl
  -- The template's net-asset category, and ONLY when there is exactly one:
  -- `HAVING count(*) = 1` returns no row otherwise, so the LEFT JOIN yields
  -- NULL and the row is recorded as DILEWATI rather than guessed at.
  LEFT JOIN LATERAL (
    SELECT max(kat.kode) AS kode
      FROM baris_laporan kat
     WHERE kat.bumn_id = bl.bumn_id
       AND kat.template_id = bl.template_id
       AND kat.laporan = 'POSISI_KEUANGAN'
       AND kat.tipe_baris = 'DETAIL'
       AND kat.seksi = 'ASET_NETO'
       AND kat.deleted_at IS NULL
       AND kat.aktif
    HAVING count(*) = 1
  ) kat ON true
 WHERE bl.laporan = 'AKTIVITAS'
   AND bl.kode IN ('PENDAPATAN', 'BEBAN')
   AND bl.seksi = bl.laporan;

UPDATE baris_laporan bl
   SET seksi = r.seksi_baru
  FROM _migrasi_0029_seksi_baris_laporan r
 WHERE r.baris_laporan_id = bl.id
   AND r.keputusan = 'DIKOREKSI'
   AND bl.seksi IS DISTINCT FROM r.seksi_baru;

-- ---------------------------------------------------------------------------
-- 4. Prove the correction actually resolves, do not merely assert it
-- ---------------------------------------------------------------------------
--
-- Every AKTIVITAS row this migration CHANGED must now name a live, active
-- net-asset category of its own template, because that is the whole claim the
-- migration makes. It holds by construction (section 3b read the category off
-- the template it belongs to), and it is checked anyway: an earlier draft
-- wrote the literal 'ASET_NETO' everywhere and this check is what caught it,
-- on a database whose template splits net assets in two. Better to stop inside
-- the transaction than to report success and leave the flagship report broken.
DO $$
DECLARE
  yatim text;
BEGIN
  SELECT string_agg(format('%s/%s -> %s', bl.laporan, bl.kode, bl.seksi), ', '
                    ORDER BY bl.laporan, bl.kode)
    INTO yatim
    FROM baris_laporan bl
    JOIN _migrasi_0029_seksi_baris_laporan r ON r.baris_laporan_id = bl.id
   WHERE r.keputusan = 'DIKOREKSI'
     AND bl.laporan = 'AKTIVITAS'
     AND bl.deleted_at IS NULL
     AND bl.aktif
     AND NOT EXISTS (
       SELECT 1 FROM baris_laporan kat
        WHERE kat.bumn_id = bl.bumn_id
          AND kat.template_id = bl.template_id
          AND kat.laporan = 'POSISI_KEUANGAN'
          AND kat.tipe_baris = 'DETAIL'
          AND kat.seksi = 'ASET_NETO'
          AND kat.deleted_at IS NULL
          AND kat.aktif
          AND kat.kode = bl.seksi
     );

  IF yatim IS NOT NULL THEN
    RAISE EXCEPTION
      'TJSL-MIG-0029: sesudah koreksi, baris % masih menunjuk seksi yang bukan kategori aset neto mana pun di template-nya, jadi Laporan Posisi Keuangan tetap akan menolak.',
      yatim
      USING ERRCODE = 'restrict_violation',
            HINT = 'Pastikan template itu punya baris POSISI_KEUANGAN bertipe DETAIL dengan seksi ASET_NETO, lalu jalankan migrasi ini lagi.';
  END IF;
END
$$;

-- down
-- Exact, not inferential: only the rows the up actually changed go back, and
-- only to the value the up read off them. A row it declined to decide was never
-- touched and is not touched now either. A database that never had the defect
-- has an empty receipt and is left untouched, which is the whole reason the
-- receipt exists (see the header). `version` and `updated_at` move forward, as
-- they do for every UPDATE in this schema.
UPDATE baris_laporan bl
   SET seksi = r.seksi_lama
  FROM _migrasi_0029_seksi_baris_laporan r
 WHERE r.baris_laporan_id = bl.id
   AND r.keputusan = 'DIKOREKSI'
   AND bl.seksi IS DISTINCT FROM r.seksi_lama;

DROP TABLE _migrasi_0029_seksi_baris_laporan;
