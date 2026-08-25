// apps/api/src/modules/nonpumk/test-support.ts
//
// Reusable fixture builder for the Non PUMK module tests (spec 9.2). NOT a
// *.test.ts file, so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// Almost everything spec 9.2 has to respect is enforced inside the database,
// and this module's job is to produce a CLEAN DOMAIN ERROR ahead of each of
// them:
//   - segregation of duties as triggers on nonpumk_review / nonpumk_approval
//     (TJSL-SOD-001 / TJSL-SOD-002, migrations/0009, the same trigger
//     FUNCTIONS as PUMK parameterised with this module's tables);
//   - SUM(nonpumk_penyaluran.jumlah) <= nonpumk_proposal.jumlah_disetujui as a
//     DEFERRED constraint trigger (TJSL-NPK-002) that fires at COMMIT;
//   - LPJ realisasi + sisa dikembalikan = total disbursed (TJSL-NPK-003), also
//     deferred;
//   - one penilaian and one LPJ per proposal, as partial unique indexes;
//   - real NON-DEFERRABLE foreign keys from nonpumk_penyaluran.jurnal_id and
//     nonpumk_lpj.jurnal_id_pengembalian to `jurnal` (migrations/0010);
//   - the posting-path tripwire (TJSL-JRN-015, migrations/0020), which means
//     no fixture here can hand-write a journal row even if it wanted to.
// A fake or in-memory repository proves nothing about any of that. So every
// fixture below writes to `tjsl_test`, which tools/test-env.ts guarantees is
// where DATABASE_URL points during `bun test`.
//
// WHY THE LEDGER ENGINE IS REAL, WRAPPED, NEVER REPLACED
// modules/angsuran/test-support.ts records what the alternative cost: a pure
// double for the journal port hid two production-breaking defects (a real
// non-deferrable FK, and a sub-ledger dimension the real engine rejects)
// behind sixteen green tests. THE RULE THAT CAME OUT OF IT, and that this file
// follows: a double may stand in for a collaborator's FAILURE, never for its
// VALIDATION. So `porterJurnalUji` below is a RECORDING WRAPPER around the
// engine reached through modules/jurnal's index.ts (the import the boundary
// checker allows and the wiring the composition root uses). It records calls
// and can be armed to fail; it never answers in the real engine's place.
// It matters concretely here: BOTH journal columns in this module carry real
// non-deferrable FKs, so a double returning `crypto.randomUUID()` would raise
// 23503 in production while the suite stayed green.
//
// WHY SO MUCH OF THIS RESEMBLES modules/pumk/test-support.ts
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling
// module's internals, and that file is internal to modules/pumk. The money
// helpers, the unique-key helper, the DB port and the leak-detecting
// `tolakDengan` are therefore re-declared here with the SAME semantics. Two
// rules follow: the shapes must not drift (a sen-level difference between two
// modules' `keSen` would be a real bug in a real ledger), and when a shared
// test-support package appears, this file collapses into it.
//
// THE CHART OF ACCOUNTS, THE EVENT MAPPINGS AND THE PERMISSIONS ARE THE
// SHIPPED ONES. `seedCoaDanEventMapping` and `seedRbac` from apps/api/src/seed
// are called directly rather than re-typed, and every context's permission
// list comes from `permissionsForRole`, which READS the grant matrix out of the
// database. A fixture that hardcodes `permissions: ["nonpumk.approve"]` asserts
// against its own opinion; that is how `jurnal.update` / `jurnal.delete` being
// grantable to nobody stayed invisible, and how `pumk.cluster` nearly did.
//
// NO TEST MAY DEPEND ON ANOTHER TEST'S DATA. `bun run db:reset` and
// `bun run db:seed` are run periodically by other agents, and nothing here is
// cleaned up afterwards (physical DELETE is blocked on several of these tables
// by design), so every business key this fixture writes goes through `kunci()`.
// Each world is self-contained: its own bumn, its own branches, its own chart
// of accounts, its own periods, its own configuration rows, its own bidang.
// THE ONE EXCEPTION IS `sdg`, whose unique index is on `nomor` GLOBALLY and
// which therefore cannot be uniquified: it is upserted by nomor and read back,
// so a pre-seeded catalogue and an empty table both work and two consecutive
// runs give the same answer.
import { SQL } from "bun";
import { expect } from "bun:test";
import { createJurnalModule, type Jurnal, type JurnalContext } from "../jurnal/index";
import { createDbAdapter } from "../../core/adapters/db";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { permissionsForRole, seedRbac } from "../../seed/rbac";
import {
  NonPumkError,
  KODE_NONPUMK,
  type KodeNonPumk,
  type NonPumkContext,
  type NonPumkDbPort,
  type NonPumkTx,
  type PorterJurnalNonPumk,
  type StatusProposalNonPumk,
  type Uang,
} from "./contract";

// ---------------------------------------------------------------------------
// Money helpers. BigInt minor units internally, decimal string at the edges,
// never a float (spec invariant 7).
// ---------------------------------------------------------------------------

/** Whole rupiah -> `Uang`. `rp(1_500_000)` === "1500000.00". */
export function rp(rupiahBulat: number): Uang {
  if (!Number.isInteger(rupiahBulat)) {
    throw new Error(`rp() hanya menerima rupiah bulat, dapat ${rupiahBulat}`);
  }
  return `${rupiahBulat}.00`;
}

/** Minor units (sen) -> `Uang`. */
export function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  const utuh = abs / 100n;
  const pecahan = abs % 100n;
  return `${negatif ? "-" : ""}${utuh}.${String(pecahan).padStart(2, "0")}`;
}

/** `Uang` -> minor units. Rejects anything that is not exactly two decimals. */
export function keSen(nilai: Uang): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2]) * 100n + BigInt(m[3]);
  return m[1] === "-" ? -besar : besar;
}

export function jumlahUang(...nilai: Uang[]): Uang {
  return sen(nilai.reduce((acc, n) => acc + keSen(n), 0n));
}

export function kurangUang(a: Uang, b: Uang): Uang {
  return sen(keSen(a) - keSen(b));
}

// ---------------------------------------------------------------------------
// Unique keys and dates
// ---------------------------------------------------------------------------

const JEJAK = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
let urut = 0;

/**
 * A key unique across worlds, runs and parallel files. Every business key this
 * fixture writes goes through here, because `bun run db:reset` is NOT run
 * between files and several of these tables refuse a physical DELETE.
 */
export function kunci(awalan: string): string {
  urut += 1;
  return `${awalan}-${JEJAK}-${String(urut).padStart(4, "0")}`;
}

/** Adds (or subtracts) whole days to an ISO date. The ageing arithmetic of
 *  spec 9.2 is in DAYS, so the tests build their dates the same way. */
export function tambahHari(iso: string, hari: number): string {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  const d = new Date(Date.UTC(t, b - 1, h));
  d.setUTCDate(d.getUTCDate() + hari);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates, `sampai - dari`. */
export function selisihHari(dari: string, sampai: string): number {
  const ms = Date.parse(`${sampai}T00:00:00.000Z`) - Date.parse(`${dari}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// The DB port
// ---------------------------------------------------------------------------

function urlDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test Non PUMK butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun run db:reset` dan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!url.split("?")[0].endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture Non PUMK di database non-test: ${url}`);
  }
  return url;
}

interface PortUji extends NonPumkDbPort {
  tutup(): Promise<void>;
}

function buatPortDb(): PortUji {
  const sql = new SQL({ url: urlDb(), max: 6 });
  const bungkus = (jalankan: (t: string, p: unknown[]) => Promise<unknown>): NonPumkTx => ({
    async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
      const hasil = await jalankan(text, params);
      return hasil as unknown as T[];
    },
  });
  return {
    query: bungkus((t, p) => sql.unsafe(t, p as never[])).query,
    async transaction<T>(jalankan: (tx: NonPumkTx) => Promise<T>): Promise<T> {
      const hasil = await sql.begin(async (tx) =>
        jalankan(bungkus((t, p) => tx.unsafe(t, p as never[]))),
      );
      return hasil as T;
    },
    async tutup(): Promise<void> {
      await sql.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Accounts, by the friendly name the tests use
// ---------------------------------------------------------------------------

/**
 * Codes from apps/api/src/seed/coa-inti.ts, which is also what seeds them.
 * Deliberately a lookup onto the SHIPPED codes rather than a second chart of
 * accounts: a fixture COA that drifts from the seeded one is not a failing
 * test, it is a journal posting to the wrong account in production.
 */
const KODE_AKUN = {
  kas: "1.1.01",
  bank: "1.1.02",
  /** 5.1.03 Beban Penyaluran Non PUMK, the pooled account. */
  bebanNonPumk: "5.1.03",
  bebanPinbuk: "5.1.02",
} as const;

export type KunciAkun = keyof typeof KODE_AKUN;

export interface AkunFixture {
  id: string;
  kode: string;
}

// ---------------------------------------------------------------------------
// Configuration rows, scoped to the world's bumn
// ---------------------------------------------------------------------------

/**
 * Seeded per world with `bumn_id` set, so a world's values are its own and no
 * test can be perturbed by another agent editing the global (bumn_id NULL)
 * rows shipped by migrations/0004.
 *
 * ALL FOUR KEYS NOW SHIP AS GLOBAL ROWS, in migrations/0022. They did not when
 * this file was written: spec 5.5 "Batasan Program" lists only PUMK limits, so
 * migrations/0004 had no Non PUMK row at all and the whole Non PUMK path was
 * unreachable on a fresh install. That was TEMUAN 3, and it is discharged in
 * ./nonpumk-fixture.test.ts.
 *
 * THE PER-WORLD ROWS STAY, AND STILL WIN. The engine resolves bumn-scoped over
 * global, so a file that moves a threshold moves its OWN world's row and no
 * other world sees it. Without them, `denganKonfigurasi` would be editing a row
 * shared by every world in the database.
 *
 * The values are still fixture values. ASSUMPTIONS.md A-41 to A-44 record the
 * shipped defaults as INVENTED and awaiting the client's written confirmation,
 * so no test in this folder asserts that any of these numbers is correct; they
 * assert that changing the row changes the behaviour.
 *
 * EVERY VALUE HERE IS A FIXTURE VALUE, NOT A POLICY CLAIM. No test in this
 * folder asserts that any of these numbers is correct; they assert that
 * changing the row changes the behaviour.
 */
const KONFIGURASI_AWAL: ReadonlyArray<[string, string, string, string]> = [
  ["batasan", "skor_penilaian_minimum_lolos_non_pumk", "70", "NUMBER"],
  ["batasan", "nilai_min_non_pumk", "1000000.00", "NUMBER"],
  ["batasan", "nilai_max_non_pumk", "500000000.00", "NUMBER"],
  ["batasan", "batas_hari_lpj_non_pumk", "60", "NUMBER"],
];

// ---------------------------------------------------------------------------
// The default grant shape used by every file, chosen so no assertion needs a
// calculator: 50.000.000 requested, 40.000.000 approved, disbursed in full,
// realised 30.000.000 with 10.000.000 returned.
// ---------------------------------------------------------------------------

export const DIAJUKAN_BAKU: Uang = rp(50_000_000);
export const DISETUJUI_BAKU: Uang = rp(40_000_000);
export const REALISASI_BAKU: Uang = rp(30_000_000);
export const SISA_BAKU: Uang = rp(10_000_000);
export const PENERIMA_ESTIMASI_BAKU = 120;
export const PENERIMA_AKTUAL_BAKU = 105;
export const TANGGAL_PROPOSAL_BAKU = "2026-03-05";
export const TANGGAL_PENYALURAN_BAKU = "2026-04-10";
export const TANGGAL_LPJ_BAKU = "2026-06-20";
/** The date `jam()` reports, as an ISO day. Every ageing test counts back from it. */
export const HARI_INI_BAKU = "2026-09-15";
/** `jam()` for every world: inside an OPEN period, after every fixture date. */
export const SEKARANG_BAKU = new Date(`${HARI_INI_BAKU}T04:00:00.000Z`);

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

export interface BidangFixture {
  id: string;
  kode: string;
  nama: string;
  /** The per-bidang expense account the form supplies to PENYALURAN_NON_PUMK. */
  akunBeban: AkunFixture;
}

export interface SdgFixture {
  id: string;
  nomor: number;
  nama: string;
}

export interface OpsiSiapkan {
  cabangId?: string;
  bidang?: BidangFixture;
  /** Defaults to the world's two SDG. At least one, per spec 9.2. */
  sdgIds?: readonly string[];
  /** Who created the proposal. Defaults to the maker. Drives segregation. */
  makerUserId?: string;
  /** Who reviewed it, when the target status implies a review. */
  checkerUserId?: string;
  /** Who approved it, when the target status implies an approval. */
  approverUserId?: string;
  jumlahDiajukan?: Uang;
  /** Written to nonpumk_approval AND nonpumk_proposal.jumlah_disetujui. */
  jumlahDisetujui?: Uang;
  penerimaManfaatEstimasi?: number;
  penerimaManfaatAktual?: number;
  skorTotal?: string;
  tanggalProposal?: string;
  /** The FIRST termin's date. Later termin are one day apart. */
  tanggalPenyaluran?: string;
  /**
   * One entry per termin. Defaults to a single termin for the whole approved
   * amount. Amounts, not a count, so a fixture never has to divide.
   */
  terminPenyaluran?: readonly Uang[];
  /** LPJ realisation for statuses that carry an LPJ row. Defaults to the total. */
  jumlahRealisasi?: Uang;
  sumberPengajuan?: "INTERNAL" | "PORTAL_ONLINE";
  portalSubmissionId?: string;
}

export interface ProposalFixture {
  proposalId: string;
  noProposal: string;
  cabangId: string;
  bidangId: string;
  akunBebanId: string;
  sdgIds: readonly string[];
  status: StatusProposalNonPumk;
  jumlahDiajukan: Uang;
  /** Null before an approval. */
  jumlahDisetujui: Uang | null;
  totalDisalurkan: Uang;
  /** Null when nothing was disbursed. */
  tanggalPenyaluranTerakhir: string | null;
  /** Present from LPJ_DIAJUKAN, LPJ_DITOLAK and SELESAI onwards. */
  lpjId: string | null;
  jumlahRealisasi: Uang | null;
  sisaDikembalikan: Uang | null;
}

export interface ProposalDb {
  id: string;
  cabang_id: string;
  no_proposal: string;
  tanggal_proposal: string;
  nama_pemohon: string;
  atas_nama: string | null;
  bidang_id: string;
  judul_program: string;
  deskripsi_program: string | null;
  jumlah_diajukan: string;
  jumlah_disetujui: string | null;
  penerima_manfaat_estimasi: number | null;
  sumber_pengajuan: string;
  portal_submission_id: string | null;
  status: string;
  current_step: number;
  created_by: string | null;
  version: number;
}

export interface TransisiDb {
  status_dari: string | null;
  status_ke: string;
  aksi: string;
  oleh_user_id: string | null;
  waktu: string;
  catatan: string | null;
}

export interface PenyaluranDb {
  id: string;
  termin: number;
  tanggal_penyaluran: string;
  jumlah: string;
  akun_kas_id: string;
  akun_beban_id: string;
  no_bukti: string | null;
  keterangan: string | null;
  jurnal_id: string | null;
  created_by: string | null;
}

export interface LpjDb {
  id: string;
  tanggal_lpj: string;
  jumlah_realisasi: string;
  jumlah_sisa_dikembalikan: string;
  penerima_manfaat_aktual: number | null;
  uraian_realisasi: string | null;
  status: string;
  verified_by: string | null;
  verified_at: string | null;
  jurnal_id_pengembalian: string | null;
  created_by: string | null;
}

export interface DuniaNonPumk {
  db: PortUji;
  bumnId: string;
  cabangId: string;
  cabangLainId: string;
  karyawanId: string;
  kotaId: string;
  /** Uses the SHIPPED pooled 5.1.03 as its expense account, so the return
   *  journal (whose credit leg is fixed to 5.1.03 by the shipped mapping) nets
   *  against the disbursement and `bebanBersih` is meaningful. */
  bidang: BidangFixture;
  /** Its own level-2 expense account, so the per-bidang DEBIT leg is provable. */
  bidangLain: BidangFixture;
  sdg: readonly SdgFixture[];
  akun: Record<KunciAkun, AkunFixture>;
  jam: () => Date;

  /** User ids, so a test can assert `oleh_user_id` on a timeline row. */
  userId: {
    maker: string;
    makerDua: string;
    checker: string;
    checkerDua: string;
    approver: string;
    auditor: string;
    adminPusat: string;
    /** ADMIN_CABANG: really holds create + review + approve, which is what
     *  makes the segregation rules testable with the SHIPPED grant matrix. */
    adminCabang: string;
    makerLain: string;
    approverLain: string;
  };
  /** Contexts whose `permissions` came from `permissionsForRole`, never a literal. */
  ctx: Record<keyof DuniaNonPumk["userId"], NonPumkContext>;

  buatBidang(opsi?: { nama?: string; akunBebanId?: string }): Promise<BidangFixture>;

  /**
   * Builds a proposal (and whatever supporting rows the target status implies)
   * DIRECTLY IN SQL. These are PRECONDITIONS, not behaviour under test: the
   * module is unimplemented, so routing "a proposal already at
   * MENUNGGU_PERSETUJUAN" through it would turn one failure into a cascade and
   * hide which transition actually broke. The transitions themselves are
   * exercised by calling the engine from that precondition, and the
   * `nonpumk_proposal_transisi` timeline is deliberately left EMPTY here so a
   * timeline assertion can only pass if the engine wrote the row.
   *
   * From DISALURKAN onwards the PENYALURAN_NON_PUMK journals are posted by the
   * REAL ledger engine (see `salurkanLewatEngine`), and at SELESAI with a
   * remainder the PENGEMBALIAN_SISA_NON_PUMK journal is too, so the ledger
   * assertions start from a state the real path produced.
   */
  siapkanProposal(status: StatusProposalNonPumk, opsi?: OpsiSiapkan): Promise<ProposalFixture>;

  /**
   * Stand-in for the unimplemented disbursement step, using the REAL ledger
   * path. Nothing here hand-writes a journal row; migrations/0020 would refuse
   * it anyway (TJSL-JRN-015).
   */
  salurkanLewatEngine(
    proposalId: string,
    jumlah: Uang,
    opsi?: { termin?: number; tanggal?: string; akunBebanId?: string; akunKasId?: string },
  ): Promise<{ penyaluranId: string; jurnalId: string }>;

  /** The same, for the LPJ remainder. */
  kembalikanSisaLewatEngine(
    proposalId: string,
    jumlah: Uang,
    opsi?: { tanggal?: string; akunKasId?: string },
  ): Promise<string>;

  buatSubmissionPortal(opsi?: {
    jenis?: "PUMK" | "NON_PUMK";
    data?: Record<string, unknown>;
    status?: "BARU" | "DIPROSES" | "DIKONVERSI" | "DITOLAK";
  }): Promise<{ id: string; noTiket: string; data: Record<string, unknown> }>;

  setelKonfigurasi(grup: string, kunciKonfig: string, nilai: string): Promise<void>;
  /**
   * Runs `jalankan` with the configuration row SOFT-DELETED, then puts it back
   * WHATEVER HAPPENS.
   *
   * A `try`/`finally` rather than a delete followed by a re-insert, and that is
   * not a style preference. The body of one of these tests is a `tolakDengan`
   * against an unimplemented engine, so it THROWS; a re-insert written after it
   * never runs, the row stays deleted, and every later test in the file dies in
   * SETUP with "konfigurasi tidak ada". That failure looks exactly like a
   * missing-configuration defect, which is the thing under test, so it is the
   * most expensive kind of false negative available here.
   */
  tanpaKonfigurasi<T>(grup: string, kunciKonfig: string, jalankan: () => Promise<T>): Promise<T>;
  /**
   * Runs `jalankan` with the row set to `nilai`, then restores the previous
   * value WHATEVER HAPPENS. Same `try`/`finally` argument as
   * `tanpaKonfigurasi`: a restore written after an assertion never runs when
   * the assertion throws, and a leaked policy value silently changes the answer
   * of every later test in the file.
   */
  denganKonfigurasi<T>(
    grup: string,
    kunciKonfig: string,
    nilai: string,
    jalankan: () => Promise<T>,
  ): Promise<T>;

  bacaProposal(id: string): Promise<ProposalDb>;
  bacaTransisi(proposalId: string): Promise<TransisiDb[]>;
  bacaSdg(proposalId: string): Promise<Array<{ sdg_id: string; nomor: number; bobot: string }>>;
  bacaPenilaian(proposalId: string): Promise<
    Array<{ id: string; tanggal: string; skor_total: string | null; nilai_rekomendasi: string | null; catatan: string | null; created_by: string | null; version: number }>
  >;
  bacaReview(proposalId: string): Promise<
    Array<{ id: string; reviewer_user_id: string; keputusan: string; catatan: string | null }>
  >;
  bacaApproval(proposalId: string): Promise<
    Array<{ id: string; approver_user_id: string; keputusan: string; jumlah_disetujui: string | null; catatan: string | null }>
  >;
  bacaPenyaluran(proposalId: string): Promise<PenyaluranDb[]>;
  bacaLpj(proposalId: string): Promise<LpjDb[]>;
  bacaBarisJurnal(jurnalId: string): Promise<
    Array<{ urutan: number; akun_id: string; akun_kode: string; debit: string; kredit: string; dimensi_json: Record<string, unknown> }>
  >;
  bacaJurnal(jurnalId: string): Promise<{ id: string; no_jurnal: string; jenis: string; status: string; tanggal_transaksi: string; total_debit: string; total_kredit: string; referensi_tipe: string | null; referensi_id: string | null; jalur_posting: string }>;

  /**
   * The LEDGER effect of one proposal, read from POSTED journal lines rather
   * than recomputed from the business rows: SUM(debit - kredit) over BEBAN
   * accounts and over is_kas accounts, across every journal this proposal's
   * rows point at. This is the "assert the ledger effect, not just the row"
   * hook of scenario 9.
   */
  efekBukuBesar(proposalId: string): Promise<{ beban: Uang; kas: Uang }>;

  tutup(): Promise<void>;
}

async function satu<T>(db: NonPumkTx, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) throw new Error(`fixture: query tidak mengembalikan baris: ${sql}`);
  return baris[0];
}

/** Which supporting rows a target status implies. Read as a table, on purpose. */
const PERLU_PENILAIAN: readonly StatusProposalNonPumk[] = [
  "REVIEW_CHECKER",
  "MENUNGGU_PERSETUJUAN",
  "DISETUJUI",
  "DISALURKAN",
  "MENUNGGU_LPJ",
  "LPJ_DIAJUKAN",
  "SELESAI",
  "LPJ_DITOLAK",
  "TIDAK_DIREKOMENDASIKAN",
  "DITOLAK",
];
const PERLU_REVIEW: readonly StatusProposalNonPumk[] = [
  "MENUNGGU_PERSETUJUAN",
  "DISETUJUI",
  "DISALURKAN",
  "MENUNGGU_LPJ",
  "LPJ_DIAJUKAN",
  "SELESAI",
  "LPJ_DITOLAK",
  "DITOLAK",
];
/** SETUJU, so `jumlah_disetujui` is set and the disbursement ceiling exists. */
const PERLU_APPROVAL_SETUJU: readonly StatusProposalNonPumk[] = [
  "DISETUJUI",
  "DISALURKAN",
  "MENUNGGU_LPJ",
  "LPJ_DIAJUKAN",
  "SELESAI",
  "LPJ_DITOLAK",
];
const PERLU_PENYALURAN: readonly StatusProposalNonPumk[] = [
  "DISALURKAN",
  "MENUNGGU_LPJ",
  "LPJ_DIAJUKAN",
  "SELESAI",
  "LPJ_DITOLAK",
];
const PERLU_LPJ: readonly StatusProposalNonPumk[] = ["LPJ_DIAJUKAN", "SELESAI", "LPJ_DITOLAK"];

const STATUS_LPJ_UNTUK: Partial<Record<StatusProposalNonPumk, string>> = {
  LPJ_DIAJUKAN: "DIAJUKAN",
  SELESAI: "DIVERIFIKASI",
  LPJ_DITOLAK: "DITOLAK",
};

/**
 * Builds a minimal but complete world: one bumn, two branches, monthly OPEN
 * periods for 2026-01 .. 2028-12, the SHIPPED chart of accounts and every
 * SHIPPED event mapping, the SHIPPED RBAC matrix with one user per role, this
 * module's configuration rows scoped to the world's bumn, two bidang Non PUMK
 * (one on the pooled expense account, one on its own), two SDG and one
 * karyawan.
 */
export async function buatDunia(): Promise<DuniaNonPumk> {
  const db = buatPortDb();
  const jam = () => SEKARANG_BAKU;

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1) returning id::text as id`,
    [kunci("BUMN"), "PT Krakatau Steel (fixture nonpumk)"],
  );
  const cabang = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama, is_pusat) values ($1, $2, $3, true) returning id::text as id`,
    [bumn.id, kunci("CBG"), "Kantor Pusat (fixture nonpumk)"],
  );
  const cabangLain = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama) values ($1, $2, $3) returning id::text as id`,
    [bumn.id, kunci("CBG"), "Cabang B (fixture nonpumk)"],
  );

  async function buatUser(nama: string, cabangId: string): Promise<string> {
    const u = await satu<{ id: string }>(
      db,
      `insert into app_user (cabang_id, nama, email, username, password_hash)
       values ($1, $2, $3, $4, 'x-not-a-real-hash') returning id::text as id`,
      [cabangId, nama, `${kunci("mail")}@example.test`, kunci("user")],
    );
    return u.id;
  }

  const userId = {
    maker: await buatUser("Maker A (fixture)", cabang.id),
    makerDua: await buatUser("Maker A2 (fixture)", cabang.id),
    checker: await buatUser("Checker A (fixture)", cabang.id),
    checkerDua: await buatUser("Checker A2 (fixture)", cabang.id),
    approver: await buatUser("Approver A (fixture)", cabang.id),
    auditor: await buatUser("Auditor (fixture)", cabang.id),
    adminPusat: await buatUser("Admin Pusat (fixture)", cabang.id),
    adminCabang: await buatUser("Admin Cabang A (fixture)", cabang.id),
    makerLain: await buatUser("Maker B (fixture)", cabangLain.id),
    approverLain: await buatUser("Approver B (fixture)", cabangLain.id),
  };

  // The SHIPPED permission catalogue, the six SHIPPED system roles and the
  // SHIPPED grant matrix. Idempotent, so another agent's `db:reset` mid-run is
  // repaired by the next world that needs it.
  //
  // THROUGH THE node-postgres ADAPTER ON PURPOSE, not through this world's
  // `bun:sql` port. `seedRbac` reconciles each role's grants with
  // `kode = ANY($2::text[])`, i.e. it binds a JS ARRAY, and driver fact 3 in
  // modules/jurnal/repo.ts applies: `bun:sql` serialises a JS array as a bare
  // comma-joined string, which `text[]` rejects with 22P02 "malformed array
  // literal". node-postgres serialises it correctly.
  const dbRbac = createDbAdapter();
  await seedRbac(dbRbac);

  const ROLE_UNTUK: Record<keyof typeof userId, string> = {
    maker: "MAKER",
    makerDua: "MAKER",
    checker: "CHECKER",
    checkerDua: "CHECKER",
    approver: "APPROVER",
    auditor: "AUDITOR",
    adminPusat: "ADMIN_PUSAT",
    adminCabang: "ADMIN_CABANG",
    makerLain: "MAKER",
    approverLain: "APPROVER",
  };
  const izinRole = new Map<string, string[]>();
  for (const kodeRole of new Set(Object.values(ROLE_UNTUK))) {
    izinRole.set(kodeRole, await permissionsForRole(dbRbac, kodeRole));
  }
  for (const [nama, kodeRole] of Object.entries(ROLE_UNTUK)) {
    await db.query(
      `insert into user_role (user_id, role_id)
       select $1, r.id from app_role r where r.kode = $2 and r.deleted_at is null
       on conflict (user_id, role_id) do nothing`,
      [userId[nama as keyof typeof userId], kodeRole],
    );
  }

  // Monthly OPEN periods for 2026-01 .. 2028-12. Every fixture date in this
  // folder falls inside, so no test can fail for the incidental reason that
  // its date has no period.
  for (let tahun = 2026; tahun <= 2028; tahun += 1) {
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      const mulai = `${tahun}-${String(bulan).padStart(2, "0")}-01`;
      const akhir = new Date(Date.UTC(tahun, bulan, 0)).toISOString().slice(0, 10);
      await db.query(
        `insert into periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
         values ($1, $2, $3, $4, $5, 'OPEN')`,
        [bumn.id, tahun, bulan, mulai, akhir],
      );
    }
  }

  // The SHIPPED COA and every SHIPPED event mapping, by the same code path
  // `bun run db:seed` uses.
  const { akun: akunIdByKode } = await seedCoaDanEventMapping(db, bumn.id, userId.adminPusat);
  const akun = {} as Record<KunciAkun, AkunFixture>;
  for (const [nama, kode] of Object.entries(KODE_AKUN) as Array<[KunciAkun, string]>) {
    const id = akunIdByKode.get(kode);
    if (!id) {
      throw new Error(
        `fixture: akun ${kode} tidak ada setelah seedCoaInti; periksa apps/api/src/seed/coa-inti.ts`,
      );
    }
    akun[nama] = { id, kode };
  }
  const akunBebanRoot = akunIdByKode.get("5");
  if (!akunBebanRoot) throw new Error("fixture: akun induk '5' (BEBAN) tidak ada");

  for (const [grup, kunciKonfig, nilai, tipe] of KONFIGURASI_AWAL) {
    await db.query(
      `insert into konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, deskripsi, perlu_konfirmasi)
       values ($1, $2, $3, $4, $5, 'fixture nonpumk (spec 5, belum ada di migrations/0004)', true)`,
      [bumn.id, grup, kunciKonfig, nilai, tipe],
    );
  }

  const karyawan = await satu<{ id: string }>(
    db,
    `insert into karyawan (cabang_id, nip, nama, jabatan) values ($1, $2, 'Petugas Penilaian (fixture)', 'Staf')
     returning id::text as id`,
    [cabang.id, kunci("NIP")],
  );
  const provinsi = await satu<{ id: string }>(
    db,
    `insert into provinsi (kode_bps, nama) values ($1, 'Banten (fixture)') returning id::text as id`,
    [kunci("PRV").slice(0, 20)],
  );
  const kota = await satu<{ id: string }>(
    db,
    `insert into kota (provinsi_id, kode_bps, nama, tipe) values ($1, $2, 'Cilegon (fixture)', 'KOTA')
     returning id::text as id`,
    [provinsi.id, kunci("KOT").slice(0, 20)],
  );

  /**
   * A postable level-2 expense account under the shipped BEBAN root, for the
   * "per bidang" DEBIT leg of PENYALURAN_NON_PUMK (spec 6.4). NOT a child of
   * 5.1.03: migrations/0005 forbids a postable parent, so hanging children off
   * 5.1.03 would make it unpostable and break the PENGEMBALIAN_SISA_NON_PUMK
   * mapping, whose credit leg is bound to exactly that account.
   */
  async function buatAkunBeban(nama: string, kode: string): Promise<AkunFixture> {
    const a = await satu<{ id: string }>(
      db,
      `insert into akun
         (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal, is_postable,
          klasifikasi_laporan, created_by, updated_by)
       values ($1, $2, $3, $4, 2, 'BEBAN', 'D', true, 'BEBAN', $5, $5)
       returning id::text as id`,
      [bumn.id, kode, nama, akunBebanRoot, userId.adminPusat],
    );
    return { id: a.id, kode };
  }

  async function buatBidang(
    opsi: { nama?: string; akunBebanId?: string } = {},
  ): Promise<BidangFixture> {
    const kode = kunci("BDG");
    const nama = opsi.nama ?? `Bidang ${kode}`;
    const b = await satu<{ id: string }>(
      db,
      `insert into bidang_non_pumk (bumn_id, kode, nama, created_by, updated_by)
       values ($1, $2, $3, $4, $4) returning id::text as id`,
      [bumn.id, kode, nama, userId.adminPusat],
    );
    const akunBeban = opsi.akunBebanId
      ? { id: opsi.akunBebanId, kode: "" }
      : akun.bebanNonPumk;
    return { id: b.id, kode, nama, akunBeban };
  }

  // Bidang A rides the POOLED 5.1.03, so the disbursement debit and the return
  // credit (which the shipped mapping binds to 5.1.03) hit the same account and
  // the net expense of a proposal is exactly its realisation. Bidang B gets its
  // own account, which is what makes the per-bidang DEBIT leg provable.
  const bidang = await buatBidang({ nama: "Pendidikan (fixture)" });
  const akunBidangLain = await buatAkunBeban("Beban Penyaluran Non PUMK - Lingkungan (fixture)", "5.9.01");
  const bidangLain = await buatBidang({
    nama: "Lingkungan (fixture)",
    akunBebanId: akunBidangLain.id,
  });
  bidangLain.akunBeban = akunBidangLain;

  /**
   * THE ONE GLOBAL TABLE. `sdg_nomor_uq` is UNIQUE (nomor) across the whole
   * database with no bumn scoping, so this cannot be uniquified with `kunci()`
   * the way every other key here is. Upserted by nomor and read back instead,
   * which is idempotent and is what makes the two cases identical: `bun run
   * db:seed` now creates all seventeen goals (apps/api/src/seed/master-program.ts),
   * and a database that has not been seeded has none. Either way this ends with
   * the same three rows, and a second consecutive run changes nothing.
   */
  const sdg: SdgFixture[] = [];
  for (const [nomor, nama] of [
    [1, "Tanpa Kemiskinan"],
    [4, "Pendidikan Berkualitas"],
    [13, "Penanganan Perubahan Iklim"],
  ] as Array<[number, string]>) {
    await db.query(
      `insert into sdg (nomor, nama) values ($1, $2)
       on conflict (nomor) where deleted_at is null do nothing`,
      [nomor, nama],
    );
    const s = await satu<{ id: string; nama: string }>(
      db,
      `select id::text as id, nama from sdg where nomor = $1 and deleted_at is null`,
      [nomor],
    );
    sdg.push({ id: s.id, nomor, nama: s.nama });
  }

  // The ledger engine this module drives, wired the way the composition root
  // wires it, and used by the fixture itself for the preconditions that must be
  // REAL (a posted disbursement journal, a posted return journal).
  const { engine: jurnalEngine } = createJurnalModule({ db, jam });

  function ctxUntuk(nama: keyof typeof userId): NonPumkContext {
    const kodeRole = ROLE_UNTUK[nama];
    const izin = izinRole.get(kodeRole) ?? [];
    const lintasCabang = kodeRole === "ADMIN_PUSAT" || kodeRole === "AUDITOR";
    const rumah = nama === "makerLain" || nama === "approverLain" ? cabangLain.id : cabang.id;
    return {
      userId: userId[nama],
      cabangId: rumah,
      bumnId: bumn.id,
      permissions: izin,
      cabangDalamScope: lintasCabang ? [cabang.id, cabangLain.id] : [rumah],
    };
  }

  const ctx = {
    maker: ctxUntuk("maker"),
    makerDua: ctxUntuk("makerDua"),
    checker: ctxUntuk("checker"),
    checkerDua: ctxUntuk("checkerDua"),
    approver: ctxUntuk("approver"),
    auditor: ctxUntuk("auditor"),
    adminPusat: ctxUntuk("adminPusat"),
    adminCabang: ctxUntuk("adminCabang"),
    makerLain: ctxUntuk("makerLain"),
    approverLain: ctxUntuk("approverLain"),
  } satisfies Record<keyof typeof userId, NonPumkContext>;

  function ctxJurnal(c: NonPumkContext): JurnalContext {
    return c;
  }

  /**
   * THE ADMIN PUSAT CONTEXT, NOT THE MAKER'S, AND THAT IS THE WHOLE POINT.
   *
   * These helpers build PRECONDITIONS, not the behaviour under test. The
   * maker's context is scoped to cabang A (spec 2 rule 3), so a cabang B
   * fixture that posted its disbursement through the maker's context would die
   * IN SETUP with the ledger engine's own scope refusal, before the engine
   * under test was ever called. The cross-branch tests that then went red would
   * be reporting a fixture fault as if it were a scope defect, which is the
   * most expensive kind of false negative: it looks exactly like the thing it
   * is hiding. That mistake cost three tests in modules/pumk.
   *
   * Admin Pusat is the honest choice rather than a widened maker context,
   * because spec 2 rule 3 genuinely exempts it from branch scoping. Nothing is
   * weakened: every scope assertion in this folder is made against the engine
   * under test with the role that owns the operation, never against these.
   */
  async function salurkanLewatEngine(
    proposalId: string,
    jumlah: Uang,
    opsi: { termin?: number; tanggal?: string; akunBebanId?: string; akunKasId?: string } = {},
  ): Promise<{ penyaluranId: string; jurnalId: string }> {
    const p = await satu<{ cabang_id: string; bidang_id: string; no_proposal: string }>(
      db,
      `select cabang_id::text as cabang_id, bidang_id::text as bidang_id, no_proposal
         from nonpumk_proposal where id = $1`,
      [proposalId],
    );
    const berikut = await satu<{ termin: number }>(
      db,
      `select coalesce(max(termin), 0) + 1 as termin
         from nonpumk_penyaluran where proposal_id = $1 and deleted_at is null`,
      [proposalId],
    );
    const termin = opsi.termin ?? Number(berikut.termin);
    const tanggal = opsi.tanggal ?? TANGGAL_PENYALURAN_BAKU;
    const akunBebanId = opsi.akunBebanId ?? akun.bebanNonPumk.id;
    const akunKasId = opsi.akunKasId ?? akun.kas.id;

    const penyaluran = await satu<{ id: string }>(
      db,
      `insert into nonpumk_penyaluran
         (proposal_id, termin, tanggal_penyaluran, jumlah, akun_kas_id, akun_beban_id,
          no_bukti, keterangan, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       returning id::text as id`,
      [
        proposalId,
        termin,
        tanggal,
        jumlah,
        akunKasId,
        akunBebanId,
        kunci("BKK"),
        "Penyaluran (fixture)",
        userId.maker,
      ],
    );
    const jurnal = await jurnalEngine.postingEvent(
      "PENYALURAN_NON_PUMK",
      {
        cabangId: p.cabang_id,
        tanggalTransaksi: tanggal,
        nilai: jumlah,
        keterangan: `Penyaluran (fixture) ${p.no_proposal} termin ${termin}`,
        akunDebitId: akunBebanId,
        akunKasId,
        referensiTipe: "nonpumk_penyaluran",
        referensiId: penyaluran.id,
        dimensi: { bidangId: p.bidang_id },
      },
      ctxJurnal(ctx.adminPusat),
    );
    await db.query(
      `update nonpumk_penyaluran set jurnal_id = $2, updated_by = $3 where id = $1`,
      [penyaluran.id, jurnal.id, userId.maker],
    );
    return { penyaluranId: penyaluran.id, jurnalId: jurnal.id };
  }

  async function kembalikanSisaLewatEngine(
    proposalId: string,
    jumlah: Uang,
    opsi: { tanggal?: string; akunKasId?: string } = {},
  ): Promise<string> {
    const p = await satu<{ cabang_id: string; bidang_id: string; no_proposal: string }>(
      db,
      `select cabang_id::text as cabang_id, bidang_id::text as bidang_id, no_proposal
         from nonpumk_proposal where id = $1`,
      [proposalId],
    );
    const lpj = await satu<{ id: string }>(
      db,
      `select id::text as id from nonpumk_lpj where proposal_id = $1 and deleted_at is null`,
      [proposalId],
    );
    // THE CREDIT LEG IS THE ACCOUNT THE DISBURSEMENT DEBITED, read from the
    // LAST live termin rather than from a constant here.
    //
    // This used to be absent, because the shipped mapping bound the refund's
    // credit to the pooled 5.1.03 and ignored anything the payload offered.
    // That asymmetry was TEMUAN 2 in ./nonpumk-fixture.test.ts; the catalogue
    // and migrations/0023 now set `kredit_dari_payload`, so an omitted account
    // is `EVENT_PAYLOAD_TIDAK_LENGKAP { butuhKredit: true }` and the fixture
    // has to supply what production supplies. Deliberately the same lookup the
    // engine performs (`repo.akunBebanTerakhir`), so a precondition built here
    // is indistinguishable in the ledger from one the engine produced.
    const beban = await satu<{ akun_beban_id: string }>(
      db,
      `select akun_beban_id::text as akun_beban_id
         from nonpumk_penyaluran
        where proposal_id = $1 and deleted_at is null
        order by termin desc limit 1`,
      [proposalId],
    );
    const jurnal = await jurnalEngine.postingEvent(
      "PENGEMBALIAN_SISA_NON_PUMK",
      {
        cabangId: p.cabang_id,
        tanggalTransaksi: opsi.tanggal ?? TANGGAL_LPJ_BAKU,
        nilai: jumlah,
        keterangan: `Pengembalian sisa (fixture) ${p.no_proposal}`,
        akunKreditId: beban.akun_beban_id,
        akunKasId: opsi.akunKasId ?? akun.kas.id,
        referensiTipe: "nonpumk_lpj",
        referensiId: lpj.id,
        dimensi: { bidangId: p.bidang_id },
      },
      ctxJurnal(ctx.adminPusat),
    );
    await db.query(
      `update nonpumk_lpj set jurnal_id_pengembalian = $2, updated_by = $3 where id = $1`,
      [lpj.id, jurnal.id, userId.maker],
    );
    return jurnal.id;
  }

  async function siapkanProposal(
    status: StatusProposalNonPumk,
    opsi: OpsiSiapkan = {},
  ): Promise<ProposalFixture> {
    const cabangId = opsi.cabangId ?? cabang.id;
    const bid = opsi.bidang ?? bidang;
    const maker = opsi.makerUserId ?? userId.maker;
    const checker = opsi.checkerUserId ?? userId.checker;
    const approver = opsi.approverUserId ?? userId.approver;
    const diajukan = opsi.jumlahDiajukan ?? DIAJUKAN_BAKU;
    const disetujui = opsi.jumlahDisetujui ?? DISETUJUI_BAKU;
    const sdgIds = opsi.sdgIds ?? [sdg[0].id, sdg[1].id];
    const tanggalProposal = opsi.tanggalProposal ?? TANGGAL_PROPOSAL_BAKU;
    const tanggalPenyaluran = opsi.tanggalPenyaluran ?? TANGGAL_PENYALURAN_BAKU;
    const noProposal = kunci("NPK");
    const punyaApproval = PERLU_APPROVAL_SETUJU.includes(status);

    const proposal = await satu<{ id: string }>(
      db,
      `insert into nonpumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, nama_pemohon, atas_nama,
          alamat, kota_id, telepon, email, bidang_id, judul_program, deskripsi_program,
          jumlah_diajukan, jumlah_disetujui, penerima_manfaat_estimasi, sumber_pengajuan,
          portal_submission_id, status, created_by, updated_by)
       values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
       returning id::text as id`,
      [
        cabangId,
        noProposal,
        tanggalProposal,
        `Yayasan ${noProposal}`,
        "Ketua Yayasan (fixture)",
        "Jl. Fixture No. 1",
        kota.id,
        "081200000001",
        `${kunci("kontak")}@example.test`,
        bid.id,
        `Program ${noProposal}`,
        "Deskripsi program bantuan (fixture)",
        diajukan,
        punyaApproval ? disetujui : null,
        opsi.penerimaManfaatEstimasi ?? PENERIMA_ESTIMASI_BAKU,
        opsi.sumberPengajuan ?? "INTERNAL",
        opsi.portalSubmissionId ?? null,
        status,
        maker,
      ],
    );

    for (const sdgId of sdgIds) {
      await db.query(
        `insert into nonpumk_proposal_sdg (proposal_id, sdg_id, bobot, created_by)
         values ($1, $2, 1, $3)`,
        [proposal.id, sdgId, maker],
      );
    }

    if (PERLU_PENILAIAN.includes(status)) {
      await db.query(
        `insert into nonpumk_penilaian
           (proposal_id, tanggal, petugas_karyawan_id, hasil_json, skor_total,
            nilai_rekomendasi, catatan, created_by, updated_by)
         values ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8, $8)`,
        [
          proposal.id,
          tanggalProposal,
          karyawan.id,
          JSON.stringify({
            kelayakan: 80,
            urgensi: 75,
            dampak: 85,
            kesesuaian_bidang: 90,
            kesesuaian_sdg: 80,
          }),
          opsi.skorTotal ?? "82.000000",
          disetujui,
          "Penilaian fixture",
          maker,
        ],
      );
    }
    if (PERLU_REVIEW.includes(status)) {
      await db.query(
        `insert into nonpumk_review (proposal_id, reviewer_user_id, tanggal, keputusan, catatan, created_by, updated_by)
         values ($1, $2, $3, 'REKOMENDASI', 'Direkomendasikan (fixture)', $2, $2)`,
        [proposal.id, checker, tanggalProposal],
      );
    }
    if (punyaApproval) {
      await db.query(
        `insert into nonpumk_approval
           (proposal_id, approver_user_id, tanggal, keputusan, jumlah_disetujui, catatan, created_by, updated_by)
         values ($1, $2, $3, 'SETUJU', $4, 'Disetujui (fixture)', $2, $2)`,
        [proposal.id, approver, tanggalProposal, disetujui],
      );
    } else if (status === "DITOLAK") {
      await db.query(
        `insert into nonpumk_approval
           (proposal_id, approver_user_id, tanggal, keputusan, catatan, created_by, updated_by)
         values ($1, $2, $3, 'TOLAK', 'Ditolak (fixture)', $2, $2)`,
        [proposal.id, approver, tanggalProposal],
      );
    }

    let totalDisalurkan: Uang = "0.00";
    let tanggalTerakhir: string | null = null;
    if (PERLU_PENYALURAN.includes(status)) {
      const termin = opsi.terminPenyaluran ?? [disetujui];
      let ke = 0;
      for (const nilai of termin) {
        ke += 1;
        const tanggal = tambahHari(tanggalPenyaluran, ke - 1);
        await salurkanLewatEngine(proposal.id, nilai, {
          termin: ke,
          tanggal,
          akunBebanId: bid.akunBeban.id,
        });
        totalDisalurkan = jumlahUang(totalDisalurkan, nilai);
        tanggalTerakhir = tanggal;
      }
    }

    let lpjId: string | null = null;
    let realisasi: Uang | null = null;
    let sisa: Uang | null = null;
    if (PERLU_LPJ.includes(status)) {
      realisasi = opsi.jumlahRealisasi ?? totalDisalurkan;
      sisa = kurangUang(totalDisalurkan, realisasi);
      const statusLpj = STATUS_LPJ_UNTUK[status] as string;
      const terverifikasi = statusLpj === "DIVERIFIKASI";
      const l = await satu<{ id: string }>(
        db,
        `insert into nonpumk_lpj
           (proposal_id, tanggal_lpj, jumlah_realisasi, jumlah_sisa_dikembalikan,
            penerima_manfaat_aktual, uraian_realisasi, status, verified_by, verified_at,
            created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         returning id::text as id`,
        [
          proposal.id,
          TANGGAL_LPJ_BAKU,
          realisasi,
          sisa,
          opsi.penerimaManfaatAktual ?? PENERIMA_AKTUAL_BAKU,
          "Realisasi kegiatan (fixture)",
          statusLpj,
          terverifikasi ? userId.checker : null,
          terverifikasi ? SEKARANG_BAKU.toISOString() : null,
          userId.maker,
        ],
      );
      lpjId = l.id;
      if (terverifikasi && keSen(sisa) > 0n) {
        await kembalikanSisaLewatEngine(proposal.id, sisa);
      }
    }

    return {
      proposalId: proposal.id,
      noProposal,
      cabangId,
      bidangId: bid.id,
      akunBebanId: bid.akunBeban.id,
      sdgIds,
      status,
      jumlahDisetujui: punyaApproval ? disetujui : null,
      jumlahDiajukan: diajukan,
      totalDisalurkan,
      tanggalPenyaluranTerakhir: tanggalTerakhir,
      lpjId,
      jumlahRealisasi: realisasi,
      sisaDikembalikan: sisa,
    };
  }

  return {
    db,
    bumnId: bumn.id,
    cabangId: cabang.id,
    cabangLainId: cabangLain.id,
    karyawanId: karyawan.id,
    kotaId: kota.id,
    bidang,
    bidangLain,
    sdg,
    akun,
    jam,
    userId,
    ctx,
    buatBidang,
    siapkanProposal,
    salurkanLewatEngine,
    kembalikanSisaLewatEngine,

    /**
     * `$4::text::jsonb`, NOT `$4::jsonb`. Driver fact 1 in
     * modules/jurnal/repo.ts: a `jsonb` parameter bound from a JS STRING is
     * stored as a JSON string SCALAR, so `jsonb_typeof(data_json)` returns
     * 'string' and `data_json->>'judul_program'` is NULL.
     */
    async buatSubmissionPortal(opsi = {}) {
      const noTiket = kunci("TKT");
      const data = opsi.data ?? {
        nama_pemohon: "Yayasan Cahaya (portal fixture)",
        telepon: "081200000002",
        email: "yayasan@example.test",
        judul_program: "Renovasi ruang kelas",
        jumlah_diajukan: DIAJUKAN_BAKU,
        penerima_manfaat_estimasi: PENERIMA_ESTIMASI_BAKU,
      };
      const s = await satu<{ id: string }>(
        db,
        `insert into portal_submission
           (bumn_id, jenis, no_tiket, data_json, dokumen_json, email_kontak, telepon_kontak, status)
         values ($1, $2, $3, $4::text::jsonb, '[]'::jsonb, $5, $6, $7)
         returning id::text as id`,
        [
          bumn.id,
          opsi.jenis ?? "NON_PUMK",
          noTiket,
          JSON.stringify(data),
          String(data.email ?? "portal@example.test"),
          String(data.telepon ?? "0812"),
          opsi.status ?? "BARU",
        ],
      );
      return { id: s.id, noTiket, data };
    },

    async setelKonfigurasi(grup, kunciKonfig, nilai) {
      const hasil = await db.query<{ id: string }>(
        `update konfigurasi set nilai = $4, diubah_at = now()
          where bumn_id = $1 and grup = $2 and kunci = $3 and deleted_at is null
          returning id::text as id`,
        [bumn.id, grup, kunciKonfig, nilai],
      );
      if (hasil.length === 0) {
        throw new Error(
          `fixture: konfigurasi ${grup}.${kunciKonfig} tidak ada untuk bumn ini; ` +
            "tambahkan ke KONFIGURASI_AWAL di test-support.ts",
        );
      }
    },

    /**
     * Soft-deletes the row (invariant 12, never a physical delete), runs the
     * body, and restores it in a `finally`. See the note on the interface.
     */
    async denganKonfigurasi(grup, kunciKonfig, nilai, jalankan) {
      const asli = await db.query<{ nilai: string | null }>(
        `select nilai from konfigurasi
          where bumn_id = $1 and grup = $2 and kunci = $3 and deleted_at is null`,
        [bumn.id, grup, kunciKonfig],
      );
      if (asli.length === 0) {
        throw new Error(
          `fixture: konfigurasi ${grup}.${kunciKonfig} tidak ada untuk bumn ini; ` +
            "tambahkan ke KONFIGURASI_AWAL di test-support.ts",
        );
      }
      await db.query(
        `update konfigurasi set nilai = $4, diubah_at = now()
          where bumn_id = $1 and grup = $2 and kunci = $3 and deleted_at is null`,
        [bumn.id, grup, kunciKonfig, nilai],
      );
      try {
        return await jalankan();
      } finally {
        await db.query(
          `update konfigurasi set nilai = $4, diubah_at = now()
            where bumn_id = $1 and grup = $2 and kunci = $3 and deleted_at is null`,
          [bumn.id, grup, kunciKonfig, asli[0].nilai],
        );
      }
    },

    async tanpaKonfigurasi(grup, kunciKonfig, jalankan) {
      // BOTH ROWS, THE WORLD'S AND THE GLOBAL ONE. This used to delete only the
      // bumn-scoped row, which was enough while migrations/0004 shipped no Non
      // PUMK parameter at all (that was TEMUAN 3). migrations/0022 now ships
      // global defaults, and the engine resolves bumn-scoped OVER global, so
      // deleting only the world's row leaves the global default answering and
      // the operation SUCCEEDS. A "fails closed on missing configuration" test
      // that quietly stopped removing the configuration is worse than no test:
      // it reports green for the one behaviour it exists to prove.
      const hidup = await db.query<{ id: string; bumn_id: string | null }>(
        `select id::text as id, bumn_id::text as bumn_id from konfigurasi
          where grup = $2 and kunci = $3 and deleted_at is null
            and (bumn_id = $1 or bumn_id is null)`,
        [bumn.id, grup, kunciKonfig],
      );
      if (!hidup.some((r) => r.bumn_id === bumn.id)) {
        throw new Error(
          `fixture: konfigurasi ${grup}.${kunciKonfig} tidak ada untuk bumn ini; ` +
            "tambahkan ke KONFIGURASI_AWAL di test-support.ts",
        );
      }
      // Soft-deleted and later UN-deleted by id, never deleted and re-inserted.
      // The global row is shared by every world in this database, so putting
      // back a COPY of it would leave the original id dangling behind a partial
      // unique index and hand the next world a row nobody wrote. Restoring the
      // same row restores exactly what was there, including its id, its
      // deskripsi and its perlu_konfirmasi flag.
      for (const r of hidup) {
        await db.query(
          `update konfigurasi set deleted_at = now(), deleted_by = $2 where id = $1`,
          [r.id, userId.adminPusat],
        );
      }
      try {
        return await jalankan();
      } finally {
        for (const r of hidup) {
          await db.query(
            `update konfigurasi set deleted_at = null, deleted_by = null where id = $1`,
            [r.id],
          );
        }
      }
    },

    bacaProposal(id) {
      return satu<ProposalDb>(
        db,
        `select id::text as id, cabang_id::text as cabang_id, no_proposal,
                tanggal_proposal::text as tanggal_proposal, nama_pemohon, atas_nama,
                bidang_id::text as bidang_id, judul_program, deskripsi_program,
                jumlah_diajukan::text as jumlah_diajukan,
                jumlah_disetujui::text as jumlah_disetujui,
                penerima_manfaat_estimasi, sumber_pengajuan,
                portal_submission_id::text as portal_submission_id, status, current_step,
                created_by::text as created_by, version
           from nonpumk_proposal where id = $1 and deleted_at is null`,
        [id],
      );
    },

    bacaTransisi(proposalId) {
      return db.query<TransisiDb>(
        `select status_dari, status_ke, aksi, oleh_user_id::text as oleh_user_id,
                waktu::text as waktu, catatan
           from nonpumk_proposal_transisi where proposal_id = $1 order by waktu, id`,
        [proposalId],
      );
    },

    bacaSdg(proposalId) {
      return db.query(
        `select s.sdg_id::text as sdg_id, g.nomor, s.bobot::text as bobot
           from nonpumk_proposal_sdg s join sdg g on g.id = s.sdg_id
          where s.proposal_id = $1 order by g.nomor`,
        [proposalId],
      );
    },

    bacaPenilaian(proposalId) {
      return db.query(
        `select id::text as id, tanggal::text as tanggal, skor_total::text as skor_total,
                nilai_rekomendasi::text as nilai_rekomendasi, catatan,
                created_by::text as created_by, version
           from nonpumk_penilaian where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaReview(proposalId) {
      return db.query(
        `select id::text as id, reviewer_user_id::text as reviewer_user_id, keputusan, catatan
           from nonpumk_review where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaApproval(proposalId) {
      return db.query(
        `select id::text as id, approver_user_id::text as approver_user_id, keputusan,
                jumlah_disetujui::text as jumlah_disetujui, catatan
           from nonpumk_approval where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaPenyaluran(proposalId) {
      return db.query<PenyaluranDb>(
        `select id::text as id, termin, tanggal_penyaluran::text as tanggal_penyaluran,
                jumlah::text as jumlah, akun_kas_id::text as akun_kas_id,
                akun_beban_id::text as akun_beban_id, no_bukti, keterangan,
                jurnal_id::text as jurnal_id, created_by::text as created_by
           from nonpumk_penyaluran where proposal_id = $1 and deleted_at is null order by termin`,
        [proposalId],
      );
    },

    bacaLpj(proposalId) {
      return db.query<LpjDb>(
        `select id::text as id, tanggal_lpj::text as tanggal_lpj,
                jumlah_realisasi::text as jumlah_realisasi,
                jumlah_sisa_dikembalikan::text as jumlah_sisa_dikembalikan,
                penerima_manfaat_aktual, uraian_realisasi, status,
                verified_by::text as verified_by, verified_at::text as verified_at,
                jurnal_id_pengembalian::text as jurnal_id_pengembalian,
                created_by::text as created_by
           from nonpumk_lpj where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaBarisJurnal(jurnalId) {
      return db.query(
        `select b.urutan, b.akun_id::text as akun_id, a.kode as akun_kode,
                b.debit::text as debit, b.kredit::text as kredit, b.dimensi_json
           from jurnal_baris b join akun a on a.id = b.akun_id
          where b.jurnal_id = $1 and b.deleted_at is null order by b.urutan`,
        [jurnalId],
      );
    },

    bacaJurnal(jurnalId) {
      return satu(
        db,
        `select id::text as id, no_jurnal, jenis, status, tanggal_transaksi::text as tanggal_transaksi,
                total_debit::text as total_debit, total_kredit::text as total_kredit,
                referensi_tipe, referensi_id::text as referensi_id, jalur_posting
           from jurnal where id = $1 and deleted_at is null`,
        [jurnalId],
      );
    },

    /**
     * A SUBQUERY, not `= ANY($2::text[])`. Driver fact 3 in
     * modules/jurnal/repo.ts: `bun:sql` binds a JS array as a bare
     * comma-joined string, which `text[]` rejects with 22P02 "malformed array
     * literal". The journal ids therefore never leave the database.
     */
    async efekBukuBesar(proposalId) {
      const r = await satu<{ beban: string; kas: string }>(
        db,
        `with j as (
           select p.jurnal_id as id
             from nonpumk_penyaluran p
            where p.proposal_id = $1 and p.jurnal_id is not null and p.deleted_at is null
           union
           select l.jurnal_id_pengembalian as id
             from nonpumk_lpj l
            where l.proposal_id = $1 and l.jurnal_id_pengembalian is not null and l.deleted_at is null
         )
         select coalesce(sum(case when a.tipe = 'BEBAN' then b.debit - b.kredit else 0 end), 0)
                  ::numeric(20,2)::text as beban,
                coalesce(sum(case when a.is_kas then b.debit - b.kredit else 0 end), 0)
                  ::numeric(20,2)::text as kas
           from jurnal_baris b
           join jurnal jr on jr.id = b.jurnal_id
           join akun a on a.id = b.akun_id
          where b.jurnal_id in (select id from j)
            and jr.status = 'POSTED' and jr.deleted_at is null and b.deleted_at is null`,
        [proposalId],
      );
      // `::numeric(20,2)::text`, NOT a bare `::text`. With no matching journal
      // the `sum` is NULL and `coalesce` yields the INTEGER literal 0, which
      // renders as "0" and is not a `Uang`: `keSen` rejects it, `toBe("0.00")`
      // fails, and the difference only appears on the empty case, i.e. on the
      // rollback tests where the whole point is that nothing was posted. The
      // repo's convention is two decimal places at every boundary (invariant
      // 7), so the cast makes the empty answer "0.00" like every other answer.
      return { beban: r.beban as Uang, kas: r.kas as Uang };
    },

    tutup: () => db.tutup(),
  };
}

// ---------------------------------------------------------------------------
// Recording wrapper around the REAL ledger engine
// ---------------------------------------------------------------------------

export interface PanggilanJurnal {
  eventCode: string;
  cabangId: string;
  tanggalTransaksi: string;
  nilai: Uang;
  akunDebitId?: string;
  akunKreditId?: string;
  akunKasId?: string;
  referensiTipe?: string | null;
  referensiId?: string | null;
  dimensi?: Record<string, unknown>;
}

export interface PorterJurnalUji extends PorterJurnalNonPumk {
  /** Every call, in order. The length is the "ONE journal, not three" assertion. */
  panggilan: PanggilanJurnal[];
  /**
   * Arms the next call to fail. The message deliberately looks like a raw
   * Postgres trigger string, so a rollback test can assert BOTH that the
   * operation rolled back AND that the raw text did not leak into the
   * `NonPumkError` the caller sees.
   */
  gagalkan(pesan?: string): void;
  reset(): void;
}

export const PESAN_JURNAL_GAGAL =
  "TJSL-JRN-031: jurnal OTOMATIS/202604/00001 tidak balance: total debit 40000000.00 total kredit 39000000.00";

/**
 * A RECORDING WRAPPER around the real ledger engine, reached through
 * modules/jurnal's index.ts. NOT a replacement for it.
 *
 * What the wrapper buys that a double cannot: the journal is really written, by
 * the code that writes it in production, against the SHIPPED
 * `event_jurnal_mapping` rows of this world, subject to every spec 6.2
 * validation, the deferred balance trigger and the posting-path tripwire of
 * migrations/0020. Both journal columns in this module carry real
 * non-deferrable FKs, so a double returning `crypto.randomUUID()` would raise
 * 23503 and roll back the whole disbursement in production while every test
 * stayed green; modules/angsuran/test-support.ts records that exact incident.
 *
 * `gagalkan()` throws BEFORE delegating, so an armed call writes no journal.
 * That is the one thing a double is legitimately for: a collaborator's FAILURE,
 * never its VALIDATION.
 */
export function porterJurnalUji(db: NonPumkDbPort, jam?: () => Date): PorterJurnalUji {
  const { engine } = createJurnalModule({ db, jam });
  const panggilan: PanggilanJurnal[] = [];
  let pesanGagal: string | null = null;
  return {
    panggilan,
    gagalkan(pesan = PESAN_JURNAL_GAGAL) {
      pesanGagal = pesan;
    },
    reset() {
      panggilan.length = 0;
      pesanGagal = null;
    },
    async postingEvent(eventCode, payload, ctx): Promise<Jurnal> {
      panggilan.push({
        eventCode,
        cabangId: payload.cabangId,
        tanggalTransaksi: payload.tanggalTransaksi,
        nilai: payload.nilai,
        akunDebitId: payload.akunDebitId,
        akunKreditId: payload.akunKreditId,
        akunKasId: payload.akunKasId,
        referensiTipe: payload.referensiTipe ?? null,
        referensiId: payload.referensiId ?? null,
        dimensi: payload.dimensi as Record<string, unknown> | undefined,
      });
      if (pesanGagal) throw new Error(pesanGagal);
      return engine.postingEvent(eventCode, payload, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions shared by the test files
// ---------------------------------------------------------------------------

/**
 * Fragments that mean a raw driver or trigger string has leaked into a
 * user-facing message. The module must wrap DB failures in `NonPumkError` with
 * a clean Indonesian message and keep the raw text in `penyebabDb`.
 */
const POLA_KEBOCORAN_DB =
  /TJSL-[A-Z]{3}-\d{3}|PL\/pgSQL|plpgsql|SQLSTATE|violates|duplicate key|null value in column|relation "|_ck\b|_uq\b|ERROR:|syntax error at/i;

/**
 * Asserts a rejection is the expected DOMAIN error, and that its message is
 * free of DB internals. DELIBERATELY STRICT ABOUT THE TYPE AND THE CODE: a bare
 * `Error("not implemented")` must NOT satisfy this, otherwise every rejection
 * test in this folder would go green against an unimplemented module, which is
 * the one failure mode a tests-first suite exists to prevent.
 *
 * TAKES A PROMISE OR A THUNK. Prefer the thunk. A method that rejects from a
 * guard clause placed before its first `await`, in a function that is not
 * declared `async`, throws SYNCHRONOUSLY: the argument expression blows up at
 * the call site and this assertion never runs, so the test fails with a raw
 * stack instead of "expected KODE_X, got KODE_Y". That is exactly how today's
 * `belumDiimplementasikan()` stub behaves, and it is a shape a real
 * implementation can reach by accident.
 */
export async function tolakDengan(
  janji: Promise<unknown> | (() => Promise<unknown> | unknown),
  kode: KodeNonPumk,
): Promise<NonPumkError> {
  let ditangkap: unknown;
  try {
    await (typeof janji === "function" ? janji() : janji);
  } catch (e) {
    ditangkap = e;
  }
  if (ditangkap === undefined) {
    throw new Error(`diharapkan ditolak dengan ${kode}, tapi operasi berhasil`);
  }
  expect(ditangkap).toBeInstanceOf(NonPumkError);
  const err = ditangkap as NonPumkError;
  expect(err.kode).toBe(kode);
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.message).not.toMatch(POLA_KEBOCORAN_DB);
  return err;
}

/** Sanity: every code a test names exists in the contract's catalogue. */
export function kodeAda(kode: KodeNonPumk): KodeNonPumk {
  expect(Object.values(KODE_NONPUMK)).toContain(kode);
  return kode;
}
