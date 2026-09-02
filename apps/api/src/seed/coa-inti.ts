// The MINIMUM chart of accounts, and the report lines it hangs off.
//
// WHY THIS EXISTS HERE AND WHY IT IS "INTI" (core) RATHER THAN "THE COA"
// The 19 event mappings of spec 6.4 are rows in `event_jurnal_mapping`, and
// every one of them points at an `akun` (ADR 0004: the mapping is data so an
// accountant can correct an account without a deploy). Data has to be seeded,
// and a mapping row cannot be seeded before the account it names exists. So
// the accounts spec 6.4 actually names live here, next to the mapping seed.
//
// Three chained facts make this the smallest possible set, not a design choice:
//   - `akun.klasifikasi_akun` is a real composite FK into
//     `klasifikasi_akun(bumn_id, kode)` (migrations/0028, which renamed the
//     column from `klasifikasi_laporan` and repointed it off the printed
//     line), so the classification vocabulary must exist first, and the
//     printed lines it maps onto must belong to a `template_laporan`;
//   - `akun` has a hierarchy trigger: a child must name a parent exactly one
//     level up, of the same tipe, and a parent may not be postable. Hence the
//     four level-1 headers below;
//   - the contra asset (Penyisihan) is an ASSET account with a CREDIT normal
//     balance presented as a deduction, which is spec 6.4's closing note and
//     the reason `baris_laporan.tanda = -1` exists.
//
// NOT the full client COA, and not the full report layout: the real Laporan
// Posisi Keuangan / Aktivitas layout is Fase 6 work. Everything here is
// additive and idempotent, so that seed extends this rather than replacing it.
//
// ONE TEMPLATE, NAMED AFTER NO STANDARD. migrations/0028 lets two templates
// coexist (PSAK 45 wording and ISAK 335 wording, docs/REGULASI.md finding 1),
// and this seed ships exactly ONE, `BAWAAN`, effective from 1900-01-01, with
// the same code, name and reason the migration's own backfill uses. A database
// that reached 0028 by migrating and a database seeded from zero therefore
// describe the same template. Naming it after a standard, or shipping a second
// one, would be this file deciding which standard the client reports under,
// which is the open question the template mechanism exists to keep open.
//
// THE CAPTIONS HERE ASSERT NO STANDARD EITHER. `ASET NETO` is the section and
// the single net-asset category; the split into "Tidak Terikat / Terikat
// Temporer" (PSAK 45) or "tanpa pembatasan / dengan pembatasan" (ISAK 335) is
// the client's, and is added as rows, not as a release.
//
// ASSUMPTION: these account codes are a placeholder numbering awaiting the
// client's real COA (ASSUMPTIONS.md, spec 18 question 2). They are stable
// enough to key the event mapping off, and `bun run db:seed` re-resolves by
// code, so replacing them later is a data migration, not a code change.
import type { QueryRunner } from "../core/ports/db";

export type TipeAkun = "ASET" | "LIABILITAS" | "ASET_NETO" | "PENDAPATAN" | "BEBAN";

export type KodeLaporanSeed =
  | "POSISI_KEUANGAN"
  | "AKTIVITAS"
  | "ARUS_KAS"
  | "PERUBAHAN_ASET_NETO";

export interface BarisLaporanDef {
  kode: string;
  nama: string;
  laporan: KodeLaporanSeed;
  urutan: number;
  /** -1 = presented as a deduction (the contra asset). */
  tanda: 1 | -1;
  /**
   * Which SECTION of the statement the line sits in. Never the statement's own
   * name: this seed used to write `seksi = laporan`, which named no section of
   * anything, so report 19 could not group its three sides and report 20 could
   * not attribute a movement to a net-asset category at all.
   *
   * POSISI_KEUANGAN: ASET / LIABILITAS / ASET_NETO.
   * ARUS_KAS: OPERASI / INVESTASI / PENDANAAN (`akun.klasifikasi_arus_kas`).
   * AKTIVITAS: the `kode` of the POSISI_KEUANGAN line whose section is
   *   ASET_NETO that this movement belongs to, i.e. the net-asset CATEGORY.
   * PERUBAHAN_ASET_NETO: the same category, as its own line.
   */
  seksi: string;
}

export interface KlasifikasiAkunDef {
  kode: string;
  nama: string;
  urutan: number;
  keterangan?: string;
}

/** (klasifikasi, laporan) -> the line that classification prints on. */
export interface PemetaanBarisDef {
  klasifikasi: string;
  laporan: KodeLaporanSeed;
  baris: string;
}

export interface AkunDef {
  kode: string;
  nama: string;
  tipe: TipeAkun;
  saldoNormal: "D" | "K";
  /** Level-1 header accounts are non-postable; leaves are postable. */
  level: 1 | 2;
  parentKode?: string;
  isKas?: boolean;
  isKontra?: boolean;
  /** FK into klasifikasi_akun.kode (migrations/0028). */
  klasifikasi: string;
  klasifikasiArusKas?: "OPERASI" | "INVESTASI" | "PENDANAAN";
}

/**
 * The one template this seed ships. Identical in code, name, reason and
 * effective date to migration 0028's own backfill, so a database that reached
 * 0028 by migrating and a database seeded from zero are the same database.
 */
export const TEMPLATE_INTI = {
  kode: "BAWAAN",
  nama: "Template bawaan",
  dasar:
    "Format yang sudah terpasang sebelum migrasi 0028. Standarnya belum ditetapkan klien.",
  berlakuDari: "1900-01-01",
} as const;

/**
 * The classification vocabulary. WHAT an account is, independent of the
 * presentation in force (migrations/0028, ADR 0017).
 *
 * The codes are identical to the line codes below, which is not laziness: it
 * is exactly the identity 0028's backfill writes for an existing installation,
 * and keeping the two in step is what lets a migrated database and a seeded
 * one resolve every account to the same printed line.
 */
export const KLASIFIKASI_AKUN_INTI: readonly KlasifikasiAkunDef[] = [
  { kode: "ASET", nama: "Aset", urutan: 10 },
  {
    kode: "PENYISIHAN_KONTRA",
    nama: "Penyisihan Penurunan Nilai Piutang",
    urutan: 20,
    keterangan: "Akun kontra aset: saldo normal kredit, disajikan sebagai pengurang piutang.",
  },
  { kode: "LIABILITAS", nama: "Liabilitas", urutan: 30 },
  { kode: "ASET_NETO", nama: "Aset Neto", urutan: 40 },
  { kode: "PENDAPATAN", nama: "Pendapatan", urutan: 50 },
  { kode: "BEBAN", nama: "Beban", urutan: 60 },
];

/**
 * Report lines the classifications above map onto, for all FOUR statements.
 *
 * ARUS_KAS and PERUBAHAN_ASET_NETO used to have no rows at all, so two of the
 * four statements had no template to print from and refused out of the box.
 */
export const BARIS_LAPORAN_INTI: readonly BarisLaporanDef[] = [
  {
    kode: "ASET",
    nama: "Aset",
    laporan: "POSISI_KEUANGAN",
    urutan: 10,
    tanda: 1,
    seksi: "ASET",
  },
  {
    kode: "PENYISIHAN_KONTRA",
    nama: "Penyisihan Penurunan Nilai Piutang",
    laporan: "POSISI_KEUANGAN",
    urutan: 20,
    tanda: -1,
    seksi: "ASET",
  },
  {
    kode: "LIABILITAS",
    nama: "Liabilitas",
    laporan: "POSISI_KEUANGAN",
    urutan: 30,
    tanda: 1,
    seksi: "LIABILITAS",
  },
  {
    // The single net-asset CATEGORY, and the section it sits in, deliberately
    // one row: splitting it is the client's decision (see the file header).
    kode: "ASET_NETO",
    nama: "Aset Neto",
    laporan: "POSISI_KEUANGAN",
    urutan: 40,
    tanda: 1,
    seksi: "ASET_NETO",
  },
  {
    kode: "PENDAPATAN",
    nama: "Pendapatan",
    laporan: "AKTIVITAS",
    urutan: 10,
    tanda: 1,
    seksi: "ASET_NETO",
  },
  {
    kode: "BEBAN",
    nama: "Beban",
    laporan: "AKTIVITAS",
    urutan: 20,
    tanda: 1,
    seksi: "ASET_NETO",
  },
  // Arus Kas: the three sections spec 10.3 report 18 always prints, even when
  // empty. They are lines rather than captions compiled into the report for
  // the same reason every other line is (spec 4.2, "tanpa deploy").
  {
    kode: "ARUS_OPERASI",
    nama: "Arus Kas dari Aktivitas Operasi",
    laporan: "ARUS_KAS",
    urutan: 10,
    tanda: 1,
    seksi: "OPERASI",
  },
  {
    kode: "ARUS_INVESTASI",
    nama: "Arus Kas dari Aktivitas Investasi",
    laporan: "ARUS_KAS",
    urutan: 20,
    tanda: 1,
    seksi: "INVESTASI",
  },
  {
    kode: "ARUS_PENDANAAN",
    nama: "Arus Kas dari Aktivitas Pendanaan",
    laporan: "ARUS_KAS",
    urutan: 30,
    tanda: 1,
    seksi: "PENDANAAN",
  },
  // Perubahan Aset Neto: one line per net-asset category, which is one line
  // until the client splits the category.
  {
    kode: "PAN_ASET_NETO",
    nama: "Aset Neto",
    laporan: "PERUBAHAN_ASET_NETO",
    urutan: 10,
    tanda: 1,
    seksi: "ASET_NETO",
  },
];

/**
 * (template, klasifikasi, laporan) -> printed line. This is what makes a
 * statement ACCOUNT DRIVEN: report 20 no longer has to be inferred from
 * `baris_laporan.seksi`, because a classification reaches a line of its own in
 * every statement that prints it.
 *
 * ARUS_KAS IS DELIBERATELY UNMAPPED, and that is not an omission. ADR 0017:
 * "when this account is the counterpart of a cash movement, which section is
 * that flow in" is answered per ACCOUNT by `akun.klasifikasi_arus_kas`, not per
 * classification, and moving it into this table is a separate change with its
 * own reasoning. The three ARUS_KAS lines above exist so the statement has a
 * template to print; what lands on them still comes from the account column.
 */
export const PEMETAAN_BARIS_INTI: readonly PemetaanBarisDef[] = [
  { klasifikasi: "ASET", laporan: "POSISI_KEUANGAN", baris: "ASET" },
  { klasifikasi: "PENYISIHAN_KONTRA", laporan: "POSISI_KEUANGAN", baris: "PENYISIHAN_KONTRA" },
  { klasifikasi: "LIABILITAS", laporan: "POSISI_KEUANGAN", baris: "LIABILITAS" },
  { klasifikasi: "ASET_NETO", laporan: "POSISI_KEUANGAN", baris: "ASET_NETO" },
  { klasifikasi: "PENDAPATAN", laporan: "AKTIVITAS", baris: "PENDAPATAN" },
  { klasifikasi: "BEBAN", laporan: "AKTIVITAS", baris: "BEBAN" },
  { klasifikasi: "ASET_NETO", laporan: "PERUBAHAN_ASET_NETO", baris: "PAN_ASET_NETO" },
];

/** Level-1 headers. Non-postable by construction (only leaves may be posted to). */
export const HEADER_AKUN_INTI: readonly AkunDef[] = [
  { kode: "1", nama: "ASET", tipe: "ASET", saldoNormal: "D", level: 1, klasifikasi: "ASET" },
  { kode: "2", nama: "LIABILITAS", tipe: "LIABILITAS", saldoNormal: "K", level: 1, klasifikasi: "LIABILITAS" },
  { kode: "3", nama: "ASET NETO", tipe: "ASET_NETO", saldoNormal: "K", level: 1, klasifikasi: "ASET_NETO" },
  { kode: "4", nama: "PENDAPATAN", tipe: "PENDAPATAN", saldoNormal: "K", level: 1, klasifikasi: "PENDAPATAN" },
  { kode: "5", nama: "BEBAN", tipe: "BEBAN", saldoNormal: "D", level: 1, klasifikasi: "BEBAN" },
];

/**
 * Postable accounts named by spec 6.4. Codes match the journal engine's test
 * fixture on purpose, so a fixture built from this module and a production
 * database seeded from it describe the same world.
 */
export const AKUN_INTI: readonly AkunDef[] = [
  {
    kode: "1.1.01",
    nama: "Kas dan Setara Kas",
    tipe: "ASET",
    saldoNormal: "D",
    level: 2,
    parentKode: "1",
    isKas: true,
    klasifikasi: "ASET",
    klasifikasiArusKas: "OPERASI",
  },
  {
    kode: "1.1.02",
    nama: "Bank Operasional TJSL",
    tipe: "ASET",
    saldoNormal: "D",
    level: 2,
    parentKode: "1",
    isKas: true,
    klasifikasi: "ASET",
    klasifikasiArusKas: "OPERASI",
  },
  {
    kode: "1.1.03",
    nama: "Piutang Pinjaman Mitra Binaan",
    tipe: "ASET",
    saldoNormal: "D",
    level: 2,
    parentKode: "1",
    klasifikasi: "ASET",
    klasifikasiArusKas: "OPERASI",
  },
  {
    kode: "1.1.04",
    nama: "Piutang Jasa Administrasi",
    tipe: "ASET",
    saldoNormal: "D",
    level: 2,
    parentKode: "1",
    klasifikasi: "ASET",
    klasifikasiArusKas: "OPERASI",
  },
  {
    // Contra asset: ASSET tipe, CREDIT normal balance, presented as a
    // deduction from gross receivables (spec 6.4 closing note).
    kode: "1.1.05",
    nama: "Penyisihan Penurunan Nilai Piutang",
    tipe: "ASET",
    saldoNormal: "K",
    level: 2,
    parentKode: "1",
    isKontra: true,
    klasifikasi: "PENYISIHAN_KONTRA",
  },
  {
    kode: "2.1.01",
    nama: "Kelebihan Pembayaran Angsuran",
    tipe: "LIABILITAS",
    saldoNormal: "K",
    level: 2,
    parentKode: "2",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "LIABILITAS",
  },
  {
    kode: "2.1.02",
    nama: "Angsuran Belum Teridentifikasi",
    tipe: "LIABILITAS",
    saldoNormal: "K",
    level: 2,
    parentKode: "2",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "LIABILITAS",
  },
  {
    // THE ONLY POSTABLE NET-ASSET ACCOUNT, and the reason it exists: without a
    // leaf under root 3 no journal line could ever name a net-asset account,
    // so the section of Laporan Posisi Keuangan that must balance the other
    // two had no way to carry a figure at all. Deliberately ONE undivided
    // category, named after no standard (see the file header).
    //
    // No `klasifikasiArusKas`: a movement in net assets here is a
    // reclassification, not a cash movement, so claiming a section for it
    // would put money in Arus Kas that never touched cash.
    kode: "3.1.01",
    nama: "Aset Neto",
    tipe: "ASET_NETO",
    saldoNormal: "K",
    level: 2,
    parentKode: "3",
    klasifikasi: "ASET_NETO",
  },
  {
    kode: "4.1.01",
    nama: "Pendapatan Alokasi Dana BUMN Pembina",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "PENDAPATAN",
  },
  {
    kode: "4.1.02",
    nama: "Pendapatan Jasa Administrasi Pinjaman",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "PENDAPATAN",
  },
  {
    kode: "4.1.03",
    nama: "Pendapatan Bunga Jasa Giro",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "PENDAPATAN",
  },
  {
    kode: "4.1.04",
    nama: "Pendapatan Lain lain",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "PENDAPATAN",
  },
  {
    // No `klasifikasiArusKas`, deliberately, and the same for 1.1.05: the
    // allowance journal never touches cash, so either account turning up
    // opposite a cash movement is a mistake report 18 should refuse on rather
    // than bucket.
    kode: "5.1.01",
    nama: "Beban Penyisihan Penurunan Nilai Piutang",
    tipe: "BEBAN",
    saldoNormal: "D",
    level: 2,
    parentKode: "5",
    klasifikasi: "BEBAN",
  },
  {
    kode: "5.1.02",
    nama: "Beban Pembinaan Kemitraan",
    tipe: "BEBAN",
    saldoNormal: "D",
    level: 2,
    parentKode: "5",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "BEBAN",
  },
  {
    kode: "5.1.03",
    nama: "Beban Penyaluran Non PUMK",
    tipe: "BEBAN",
    saldoNormal: "D",
    level: 2,
    parentKode: "5",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "BEBAN",
  },
  {
    kode: "5.1.04",
    nama: "Beban Operasional",
    tipe: "BEBAN",
    saldoNormal: "D",
    level: 2,
    parentKode: "5",
    klasifikasiArusKas: "OPERASI",
    klasifikasi: "BEBAN",
  },
];

/** Account code -> id, for the caller that has to wire mappings by code. */
export type AkunIdByKode = Map<string, string>;

/**
 * Ensures the default report template exists for one bumn and returns its id.
 * Exported because a fixture that adds a line of its own needs the same
 * template the seed put every other line in; a second template would be a
 * different statement, not an extra line on this one (migrations/0028).
 */
export async function seedTemplateLaporan(
  runner: QueryRunner,
  bumnId: string,
  userId: string | null = null,
): Promise<string> {
  const dibuat = await runner.query<{ id: string }>(
    `INSERT INTO template_laporan
       (bumn_id, kode, nama, dasar, berlaku_dari, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::date, $6, $6)
     ON CONFLICT (bumn_id, kode) DO NOTHING
     RETURNING id::text AS id`,
    [
      bumnId,
      TEMPLATE_INTI.kode,
      TEMPLATE_INTI.nama,
      TEMPLATE_INTI.dasar,
      TEMPLATE_INTI.berlakuDari,
      userId,
    ],
  );
  if (dibuat[0]?.id) return dibuat[0].id;
  const ada = await runner.query<{ id: string }>(
    `SELECT id::text AS id FROM template_laporan
      WHERE bumn_id = $1 AND kode = $2 AND deleted_at IS NULL`,
    [bumnId, TEMPLATE_INTI.kode],
  );
  const id = ada[0]?.id;
  if (!id) throw new Error(`seedCoaInti: template ${TEMPLATE_INTI.kode} gagal dibuat`);
  return id;
}

/**
 * Seeds the template, the classification vocabulary, the report lines, the
 * classification-to-line mapping and the core accounts for one bumn,
 * idempotently. Returns every account id keyed by code, headers included.
 *
 * ORDER IS FORCED BY THE FOREIGN KEYS, not by taste: a line needs its
 * template, `pemetaan_baris_laporan` needs both the line and the
 * classification, and `akun.klasifikasi_akun` needs the classification.
 *
 * Takes a `QueryRunner` rather than the whole port so it composes: pass a
 * transaction to have it commit with the rest of a seed, or pass the pool.
 */
export async function seedCoaInti(
  runner: QueryRunner,
  bumnId: string,
  userId: string | null = null,
): Promise<AkunIdByKode> {
  const templateId = await seedTemplateLaporan(runner, bumnId, userId);

  for (const k of KLASIFIKASI_AKUN_INTI) {
    await runner.query(
      `INSERT INTO klasifikasi_akun
         (bumn_id, kode, nama, keterangan, urutan, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (bumn_id, kode) DO NOTHING`,
      [bumnId, k.kode, k.nama, k.keterangan ?? null, k.urutan, userId],
    );
  }

  for (const baris of BARIS_LAPORAN_INTI) {
    await runner.query(
      `INSERT INTO baris_laporan
         (bumn_id, template_id, laporan, kode, nama, urutan, level, tipe_baris, tanda, seksi,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'DETAIL', $7, $8, $9, $9)
       ON CONFLICT (bumn_id, template_id, kode) DO NOTHING`,
      [
        bumnId,
        templateId,
        baris.laporan,
        baris.kode,
        baris.nama,
        baris.urutan,
        baris.tanda,
        baris.seksi,
        userId,
      ],
    );
  }

  for (const p of PEMETAAN_BARIS_INTI) {
    await runner.query(
      `INSERT INTO pemetaan_baris_laporan
         (bumn_id, template_id, klasifikasi_id, baris_laporan_id, laporan, created_by, updated_by)
       SELECT $1, $2, k.id, b.id, $3, $6, $6
         FROM klasifikasi_akun k, baris_laporan b
        WHERE k.bumn_id = $1 AND k.kode = $4
          AND b.bumn_id = $1 AND b.template_id = $2 AND b.kode = $5
       ON CONFLICT (template_id, klasifikasi_id, laporan) WHERE deleted_at IS NULL DO NOTHING`,
      [bumnId, templateId, p.laporan, p.klasifikasi, p.baris, userId],
    );
  }

  const byKode: AkunIdByKode = new Map();
  // Headers first: the hierarchy trigger reads the parent row.
  for (const def of [...HEADER_AKUN_INTI, ...AKUN_INTI]) {
    const parentId = def.parentKode ? byKode.get(def.parentKode) : null;
    if (def.parentKode && !parentId) {
      throw new Error(`seedCoaInti: parent ${def.parentKode} untuk akun ${def.kode} belum ada`);
    }
    const rows = await runner.query<{ id: string }>(
      `INSERT INTO akun
         (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal, is_postable, is_kas,
          is_kontra, klasifikasi_arus_kas, klasifikasi_akun, aktif, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $13)
       ON CONFLICT (bumn_id, kode) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id::text AS id`,
      [
        bumnId,
        def.kode,
        def.nama,
        parentId ?? null,
        def.level,
        def.tipe,
        def.saldoNormal,
        def.level > 1,
        def.isKas ?? false,
        def.isKontra ?? false,
        def.klasifikasiArusKas ?? null,
        def.klasifikasi,
        userId,
      ],
    );
    let id = rows[0]?.id;
    if (!id) {
      // Already present from an earlier run: read it back so the returned map
      // is complete either way.
      const existing = await runner.query<{ id: string }>(
        `SELECT id::text AS id FROM akun WHERE bumn_id = $1 AND kode = $2 AND deleted_at IS NULL`,
        [bumnId, def.kode],
      );
      id = existing[0]?.id;

      // BACKFILL A MISSING CASH FLOW CLASSIFICATION, and nothing else.
      //
      // The insert above is DO NOTHING, deliberately: an account an accountant
      // has edited must never be reset by a seed. But `klasifikasi_arus_kas`
      // arrived after the first databases were seeded, so those rows still
      // carry NULL, and report 18 refuses OUTRIGHT with
      // KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP as soon as such an account becomes
      // the counterpart of a cash movement. The whole statement of cash flows
      // is unavailable until somebody notices.
      //
      // A NULL is an ABSENCE, not a decision, so filling one is a repair rather
      // than an overwrite: the predicate below only touches rows where the
      // column is still NULL and where this seed's own definition has a value.
      // The two accounts whose definition deliberately has none (the allowance
      // and Aset Neto, see their notes above) are excluded by `$3 IS NOT NULL`
      // and stay NULL.
      if (id && def.klasifikasiArusKas) {
        await runner.query(
          `UPDATE akun SET klasifikasi_arus_kas = $3, updated_by = $4
            WHERE id = $1::uuid AND deleted_at IS NULL
              AND klasifikasi_arus_kas IS NULL AND $3::text IS NOT NULL
              AND kode = $2`,
          [id, def.kode, def.klasifikasiArusKas, userId],
        );
      }
    }
    if (!id) throw new Error(`seedCoaInti: akun ${def.kode} gagal dibuat`);
    byKode.set(def.kode, id);
  }
  return byKode;
}
