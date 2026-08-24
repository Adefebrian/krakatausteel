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
//   - `akun.klasifikasi_laporan` is a real composite FK into
//     `baris_laporan(bumn_id, kode)` (migrations/0005), so report lines must
//     exist first;
//   - `akun` has a hierarchy trigger: a child must name a parent exactly one
//     level up, of the same tipe, and a parent may not be postable. Hence the
//     four level-1 headers below;
//   - the contra asset (Penyisihan) is an ASSET account with a CREDIT normal
//     balance presented as a deduction, which is spec 6.4's closing note and
//     the reason `baris_laporan.tanda = -1` exists.
//
// NOT the full client COA, and not the full report layout: the real Laporan
// Posisi Keuangan / Aktivitas layout is Fase 6 work and BUILD-PLAN requires
// two live templates (PSAK 45 and ISAK 335) to coexist. Everything here is
// additive and idempotent, so that seed extends this rather than replacing it.
//
// ASSUMPTION: these account codes are a placeholder numbering awaiting the
// client's real COA (ASSUMPTIONS.md, spec 18 question 2). They are stable
// enough to key the event mapping off, and `bun run db:seed` re-resolves by
// code, so replacing them later is a data migration, not a code change.
import type { QueryRunner } from "../core/ports/db";

export type TipeAkun = "ASET" | "LIABILITAS" | "ASET_NETO" | "PENDAPATAN" | "BEBAN";

export interface BarisLaporanDef {
  kode: string;
  nama: string;
  laporan: "POSISI_KEUANGAN" | "AKTIVITAS" | "ARUS_KAS" | "PERUBAHAN_ASET_NETO";
  urutan: number;
  /** -1 = presented as a deduction (the contra asset). */
  tanda: 1 | -1;
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
  /** FK into baris_laporan.kode. */
  klasifikasi: string;
  klasifikasiArusKas?: "OPERASI" | "INVESTASI" | "PENDANAAN";
}

/** Report lines the accounts below map onto. Minimum, see the file header. */
export const BARIS_LAPORAN_INTI: readonly BarisLaporanDef[] = [
  { kode: "ASET", nama: "Aset", laporan: "POSISI_KEUANGAN", urutan: 10, tanda: 1 },
  {
    kode: "PENYISIHAN_KONTRA",
    nama: "Penyisihan Penurunan Nilai Piutang",
    laporan: "POSISI_KEUANGAN",
    urutan: 20,
    tanda: -1,
  },
  { kode: "LIABILITAS", nama: "Liabilitas", laporan: "POSISI_KEUANGAN", urutan: 30, tanda: 1 },
  { kode: "ASET_NETO", nama: "Aset Neto", laporan: "POSISI_KEUANGAN", urutan: 40, tanda: 1 },
  { kode: "PENDAPATAN", nama: "Pendapatan", laporan: "AKTIVITAS", urutan: 10, tanda: 1 },
  { kode: "BEBAN", nama: "Beban", laporan: "AKTIVITAS", urutan: 20, tanda: 1 },
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
    klasifikasi: "LIABILITAS",
  },
  {
    kode: "2.1.02",
    nama: "Angsuran Belum Teridentifikasi",
    tipe: "LIABILITAS",
    saldoNormal: "K",
    level: 2,
    parentKode: "2",
    klasifikasi: "LIABILITAS",
  },
  {
    kode: "4.1.01",
    nama: "Pendapatan Alokasi Dana BUMN Pembina",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasi: "PENDAPATAN",
  },
  {
    kode: "4.1.02",
    nama: "Pendapatan Jasa Administrasi Pinjaman",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasi: "PENDAPATAN",
  },
  {
    kode: "4.1.03",
    nama: "Pendapatan Bunga Jasa Giro",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasi: "PENDAPATAN",
  },
  {
    kode: "4.1.04",
    nama: "Pendapatan Lain lain",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    level: 2,
    parentKode: "4",
    klasifikasi: "PENDAPATAN",
  },
  {
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
    klasifikasi: "BEBAN",
  },
  {
    kode: "5.1.03",
    nama: "Beban Penyaluran Non PUMK",
    tipe: "BEBAN",
    saldoNormal: "D",
    level: 2,
    parentKode: "5",
    klasifikasi: "BEBAN",
  },
  {
    kode: "5.1.04",
    nama: "Beban Operasional",
    tipe: "BEBAN",
    saldoNormal: "D",
    level: 2,
    parentKode: "5",
    klasifikasi: "BEBAN",
  },
];

/** Account code -> id, for the caller that has to wire mappings by code. */
export type AkunIdByKode = Map<string, string>;

/**
 * Seeds the report lines and the core accounts for one bumn, idempotently.
 * Returns every account id keyed by code, headers included.
 *
 * Takes a `QueryRunner` rather than the whole port so it composes: pass a
 * transaction to have it commit with the rest of a seed, or pass the pool.
 */
export async function seedCoaInti(
  runner: QueryRunner,
  bumnId: string,
  userId: string | null = null,
): Promise<AkunIdByKode> {
  for (const baris of BARIS_LAPORAN_INTI) {
    await runner.query(
      `INSERT INTO baris_laporan
         (bumn_id, laporan, kode, nama, urutan, level, tipe_baris, tanda, seksi, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 1, 'DETAIL', $6, $2, $7, $7)
       ON CONFLICT (bumn_id, kode) DO NOTHING`,
      [bumnId, baris.laporan, baris.kode, baris.nama, baris.urutan, baris.tanda, userId],
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
          is_kontra, klasifikasi_arus_kas, klasifikasi_laporan, aktif, created_by, updated_by)
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
    }
    if (!id) throw new Error(`seedCoaInti: akun ${def.kode} gagal dibuat`);
    byKode.set(def.kode, id);
  }
  return byKode;
}
