// apps/api/src/modules/pumk/test-support.ts
//
// Reusable fixture builder for the PUMK module tests (spec 9.1). NOT a
// *.test.ts file, so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// Almost everything spec 9.1 has to respect is enforced inside the database,
// and this module's job is to produce a CLEAN DOMAIN ERROR ahead of each of
// them:
//   - segregation of duties as triggers on pumk_review / pumk_approval
//     (TJSL-SOD-001 / TJSL-SOD-002, migrations/0008);
//   - one live loan per mitra as pumk_akad_satu_aktif_per_mitra_uq, which
//     covers BELUM_CAIR too;
//   - an akad's cabang must equal its proposal's (TJSL-AKD-001);
//   - schedule immutability and the DEFERRED version-1 total (TJSL-JDW-002 /
//     TJSL-JDW-001);
//   - the posting-path tripwire (TJSL-JRN-015, migrations/0020), which means no
//     fixture here can hand-write a journal row even if it wanted to;
//   - v_rekonsiliasi_piutang, which is a VIEW over the posted ledger, so the
//     reconciliation assertion of spec 8.4 check 10 is only meaningful against
//     real journal rows written by the real engine.
// A fake or in-memory repository proves nothing about any of that. So every
// fixture below writes to `tjsl_test`, which tools/test-env.ts guarantees is
// where DATABASE_URL points during `bun test`.
//
// WHY THE COLLABORATING ENGINES ARE REAL, WRAPPED, NEVER REPLACED
// modules/angsuran/test-support.ts records what the alternative cost: a pure
// double for the journal port hid two production-breaking defects (a real
// non-deferrable FK, and a sub-ledger dimension the real engine rejects)
// behind sixteen green tests. THE RULE THAT CAME OUT OF IT, and that this file
// follows: a double may stand in for a collaborator's FAILURE, never for its
// VALIDATION. So `porterJurnalUji` and `porterAngsuranUji` below are RECORDING
// WRAPPERS around the engines reached through their own index.ts (the import
// the boundary checker allows and the wiring the composition root uses). They
// record calls and can be armed to fail; they never answer in the real
// engine's place.
//
// WHY SO MUCH OF THIS RESEMBLES modules/angsuran/test-support.ts
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling
// module's internals, and that file is internal to modules/angsuran. The money
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
// database. A fixture that hardcodes `permissions: ["pumk.approve"]` asserts
// against its own opinion; that is how `jurnal.update` / `jurnal.delete` being
// grantable to nobody stayed invisible. Two-level-up imports escape modules/
// and are explicitly allowed by the boundary checker.
//
// NO TEST MAY DEPEND ON ANOTHER TEST'S DATA. `bun run db:reset` and
// `bun run db:seed` are run periodically by other agents, and nothing here is
// cleaned up afterwards (physical DELETE is blocked on several of these tables
// by design), so every fixture key is uniquified per call via `kunci()`. Each
// world is self-contained: its own bumn, its own branches, its own chart of
// accounts, its own periods, its own configuration rows. Each proposal gets
// its OWN mitra, because pumk_akad_satu_aktif_per_mitra_uq allows exactly one
// live loan per mitra and a shared mitra would make the second akad of a file
// unbuildable.
import { SQL } from "bun";
import { expect } from "bun:test";
import { createAngsuranModule, type AngsuranContext, type Jadwal } from "../angsuran/index";
import { createJurnalModule, type Jurnal, type JurnalContext } from "../jurnal/index";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { permissionsForRole, seedRbac } from "../../seed/rbac";
import {
  PumkError,
  KODE_PUMK,
  type KodePumk,
  type PorterAngsuranPumk,
  type PorterJurnalPumk,
  type PumkContext,
  type PumkDbPort,
  type PumkTx,
  type StatusProposal,
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

/**
 * Adds whole months to an ISO date, clamping to the end of the target month
 * (31 Jan + 1 month = 28/29 Feb). Same rule as the schedule engine's, so a
 * fixture's expected due dates cannot disagree with the engine's for an
 * incidental reason.
 */
export function tambahBulan(iso: string, bulan: number): string {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  const totalBulan = b - 1 + bulan;
  const tahunBaru = t + Math.floor(totalBulan / 12);
  const bulanBaru = ((totalBulan % 12) + 12) % 12;
  const hariTerakhir = new Date(Date.UTC(tahunBaru, bulanBaru + 1, 0)).getUTCDate();
  const hariBaru = Math.min(h, hariTerakhir);
  return `${tahunBaru}-${String(bulanBaru + 1).padStart(2, "0")}-${String(hariBaru).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The DB port
// ---------------------------------------------------------------------------

function urlDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test PUMK butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun run db:reset` dan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!url.split("?")[0].endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture PUMK di database non-test: ${url}`);
  }
  return url;
}

interface PortUji extends PumkDbPort {
  tutup(): Promise<void>;
}

function buatPortDb(): PortUji {
  const sql = new SQL({ url: urlDb(), max: 6 });
  const bungkus = (jalankan: (t: string, p: unknown[]) => Promise<unknown>): PumkTx => ({
    async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
      const hasil = await jalankan(text, params);
      return hasil as unknown as T[];
    },
  });
  return {
    query: bungkus((t, p) => sql.unsafe(t, p as never[])).query,
    async transaction<T>(jalankan: (tx: PumkTx) => Promise<T>): Promise<T> {
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
  piutangPokok: "1.1.03",
  piutangJasa: "1.1.04",
  penyisihan: "1.1.05",
  kelebihanAngsuran: "2.1.01",
  pendapatanJasaAdm: "4.1.02",
  bebanPenyisihan: "5.1.01",
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
 * rows shipped by migrations/0004. The engine resolves bumn-scoped over global
 * (modules/angsuran/repo.ts `konfigurasi`), which is what makes this work.
 *
 * EVERY VALUE HERE IS A FIXTURE VALUE, NOT A POLICY CLAIM. docs/REGULASI.md
 * finding 3 and docs/BUILD-PLAN.md "Dampak temuan regulasi" record that the
 * spec's 3 percent FLAT contradicts PER-1/MBU/03/2023, and that the decision
 * belongs to the client's accounting team. No test in this folder asserts that
 * any of these numbers is correct; they assert that changing the row changes
 * the behaviour.
 */
const KONFIGURASI_AWAL: ReadonlyArray<[string, string, string, string]> = [
  ["angsuran", "pembulatan_angsuran", "0", "ENUM"],
  ["angsuran", "urutan_alokasi_setoran_preset", "DEFAULT", "STRING"],
  ["angsuran", "hari_jatuh_tempo_tetap", "0", "NUMBER"],
  ["akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG", "ENUM"],
  ["jasa_adm", "jasa_adm_rate_default", "0.030000", "NUMBER"],
  ["jasa_adm", "jasa_adm_metode_default", "FLAT", "ENUM"],
  ["jasa_adm", "jasa_adm_basis_hari", "360", "ENUM"],
  ["jasa_adm", "turunkan_flat_dari_efektif", "false", "BOOLEAN"],
  ["jasa_adm", "rate_efektif_acuan", "0.030000", "NUMBER"],
  ["batasan", "plafon_min_pumk", "1000000.00", "NUMBER"],
  ["batasan", "plafon_max_pumk", "250000000.00", "NUMBER"],
  ["batasan", "tenor_min_bulan", "6", "NUMBER"],
  ["batasan", "tenor_max_bulan", "36", "NUMBER"],
  ["batasan", "grace_period_max_bulan", "6", "NUMBER"],
  ["batasan", "wajib_jaminan_di_atas_plafon", "50000000.00", "NUMBER"],
  ["batasan", "maks_pinjaman_aktif_per_mitra", "1", "NUMBER"],
  ["batasan", "skor_survey_minimum_lolos", "70", "NUMBER"],
];

// ---------------------------------------------------------------------------
// The default akad shape used by every file, chosen so no assertion needs a
// calculator: 12.000.000 over 12 months, FLAT 3 percent per year, rounding 0.
// Pokok 1.000.000,00 and jasa 30.000,00 per row; total jasa 360.000,00.
// ---------------------------------------------------------------------------

export const POKOK_BAKU: Uang = rp(12_000_000);
export const JASA_BAKU: Uang = rp(360_000);
export const TENOR_BAKU = 12;
export const RATE_BAKU = "0.030000";
export const TANGGAL_PROPOSAL_BAKU = "2026-01-05";
export const TANGGAL_AKAD_BAKU = "2026-02-05";
export const MULAI_ANGSURAN_BAKU = "2026-03-10";
/** `jam()` for every world: inside an OPEN period, after the first due date. */
export const SEKARANG_BAKU = new Date("2026-06-15T04:00:00.000Z");

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

export interface MitraFixture {
  id: string;
  kodeMitra: string;
  nama: string;
  nik: string;
}

export interface OpsiSiapkan {
  /** Defaults to a fresh mitra of the world's main branch. */
  mitra?: MitraFixture;
  cabangId?: string;
  /** Who created the proposal. Defaults to the maker. Drives segregation. */
  makerUserId?: string;
  /** Who reviewed it, when the target status implies a review. */
  checkerUserId?: string;
  jumlahDiajukan?: Uang;
  tenorDiajukan?: number;
  /** Written to pumk_approval; defaults to the requested amount and tenor. */
  plafonDisetujui?: Uang;
  tenorDisetujui?: number;
  rate?: string;
  skorTotal?: string;
  sumberPengajuan?: "INTERNAL" | "PORTAL_ONLINE";
  portalSubmissionId?: string;
  tanggalProposal?: string;
  tanggalAkad?: string;
  tanggalMulaiAngsuran?: string;
  /** Adds one jaminan row of this jenis. */
  jaminan?: "BPKB" | "SHM" | "TANPA_JAMINAN";
}

export interface ProposalFixture {
  proposalId: string;
  noProposal: string;
  mitraId: string;
  cabangId: string;
  status: StatusProposal;
  jumlahDiajukan: Uang;
  tenorDiajukan: number;
  plafonDisetujui: Uang;
  tenorDisetujui: number;
  /** Present from AKAD_DIBUAT onwards. */
  akadId: string | null;
  noAkad: string | null;
}

export interface ProposalDb {
  id: string;
  cabang_id: string;
  no_proposal: string;
  tanggal_proposal: string;
  mitra_id: string;
  sektor_id: string | null;
  jumlah_diajukan: string;
  tenor_diajukan: number;
  tujuan_penggunaan: string | null;
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

export interface AkadDb {
  id: string;
  proposal_id: string;
  mitra_id: string;
  cabang_id: string;
  no_akad: string;
  tanggal_akad: string;
  pokok_pinjaman: string;
  jasa_adm_rate: string;
  metode_perhitungan: string;
  tenor_bulan: number;
  grace_period_bulan: number;
  tanggal_mulai_angsuran: string;
  tanggal_jatuh_tempo_akhir: string;
  status: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
  tanggal_lunas: string | null;
}

export interface BarisJadwalDb {
  id: string;
  versi: number;
  angsuran_ke: number;
  tanggal_jatuh_tempo: string;
  pokok: string;
  jasa_adm: string;
  total: string;
  saldo_pokok_setelah: string;
  status: string;
  pokok_terbayar: string;
  jasa_terbayar: string;
  tanggal_lunas: string | null;
  is_active_version: boolean;
}

export interface Rekonsiliasi {
  saldoSubLedger: Uang;
  saldoBukuBesar: Uang;
  selisih: Uang;
}

export interface DuniaPumk {
  db: PortUji;
  bumnId: string;
  cabangId: string;
  cabangLainId: string;
  sektorId: string;
  karyawanId: string;
  clusterId: string;
  clusterLainId: string;
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
  ctx: Record<keyof DuniaPumk["userId"], PumkContext>;

  buatMitra(opsi?: { cabangId?: string; nama?: string; nik?: string }): Promise<MitraFixture>;

  /**
   * Builds a proposal (and whatever supporting rows the target status implies)
   * DIRECTLY IN SQL. These are PRECONDITIONS, not behaviour under test: the
   * module is unimplemented, so routing "a proposal already at
   * MENUNGGU_PERSETUJUAN" through it would turn one failure into a cascade and
   * hide which transition actually broke. The transitions themselves are
   * exercised by calling the engine from that precondition, and the
   * `pumk_proposal_transisi` timeline is deliberately left EMPTY here so a
   * timeline assertion can only pass if the engine wrote the row.
   *
   * From JADWAL_SIAP the schedule is generated by the REAL instalment engine,
   * and at DICAIRKAN the PENCAIRAN_PUMK journal is posted by the REAL ledger
   * engine (see `cairkanLewatEngine`), so the sub-ledger and the general ledger
   * agree and `rekonsiliasi()` starts at zero.
   */
  siapkanProposal(status: StatusProposal, opsi?: OpsiSiapkan): Promise<ProposalFixture>;

  /**
   * Stand-in for the unimplemented disbursement step, using the REAL ledger
   * path: flips the akad AKTIF with the outstanding a disbursement leaves, and
   * posts PENCAIRAN_PUMK through modules/jurnal. Nothing here hand-writes a
   * journal row; migrations/0020 would refuse it anyway (TJSL-JRN-015).
   */
  cairkanLewatEngine(akadId: string, pokok: Uang, jasa: Uang): Promise<string>;

  /** Generates version 1 through the REAL instalment engine. */
  generateJadwalLewatEngine(akadId: string): Promise<Jadwal>;

  buatSubmissionPortal(opsi?: {
    jenis?: "PUMK" | "NON_PUMK";
    data?: Record<string, unknown>;
    status?: "BARU" | "DIPROSES" | "DIKONVERSI" | "DITOLAK";
    convertedProposalId?: string | null;
  }): Promise<{ id: string; noTiket: string; data: Record<string, unknown> }>;

  setelKonfigurasi(grup: string, kunciKonfig: string, nilai: string): Promise<void>;

  bacaProposal(id: string): Promise<ProposalDb>;
  bacaTransisi(proposalId: string): Promise<TransisiDb[]>;
  bacaSurvey(proposalId: string): Promise<
    Array<{ id: string; tanggal_survey: string; skor_total: string | null; plafon_rekomendasi: string | null; tenor_rekomendasi: number | null; created_by: string | null }>
  >;
  bacaReview(proposalId: string): Promise<
    Array<{ id: string; reviewer_user_id: string; keputusan: string; catatan: string | null }>
  >;
  bacaApproval(proposalId: string): Promise<
    Array<{ id: string; approver_user_id: string; keputusan: string; plafon_disetujui: string | null; tenor_disetujui: number | null; jasa_adm_rate: string | null; catatan: string | null }>
  >;
  bacaJaminan(proposalId: string): Promise<Array<{ id: string; jenis: string; nilai_taksasi: string | null }>>;
  bacaAkad(akadId: string): Promise<AkadDb>;
  bacaAkadByProposal(proposalId: string): Promise<AkadDb | null>;
  bacaJadwal(akadId: string, versi?: number): Promise<BarisJadwalDb[]>;
  bacaVersi(akadId: string): Promise<Array<{ versi: number; is_active_version: boolean; status: string; reschedule_id: string | null }>>;
  bacaPencairan(akadId: string): Promise<Array<{ id: string; tanggal_pencairan: string; jumlah: string; akun_kas_id: string; no_bukti: string | null; jurnal_id: string | null; created_by: string | null }>>;
  bacaAngsuran(akadId: string): Promise<Array<{ id: string; tanggal_terima: string; jumlah_diterima: string; alokasi_pokok: string; alokasi_jasa: string; alokasi_kelebihan: string; jurnal_id: string | null }>>;
  bacaKelebihan(akadId: string): Promise<Array<{ id: string; tanggal: string; jumlah: string; status: string; jurnal_id_terima: string | null }>>;
  bacaReschedule(akadId: string): Promise<Array<{ id: string; status: string; jadwal_versi_lama: number; jadwal_versi_baru: number | null; approved_by: string | null }>>;
  bacaPengakhiran(akadId: string): Promise<Array<{ id: string; jenis: string; tanggal: string; outstanding_pokok_saat_itu: string; outstanding_jasa_saat_itu: string; no_sk: string | null; jurnal_id: string | null; approved_by: string | null }>>;
  bacaTindakLanjut(akadId: string): Promise<Array<{ id: string; tanggal: string; jenis: string; hasil: string | null; petugas_karyawan_id: string | null; catatan: string | null }>>;
  bacaAnggotaCluster(clusterId: string): Promise<Array<{ mitra_id: string; tanggal_masuk: string; tanggal_keluar: string | null; alasan_keluar: string | null }>>;
  bacaMitra(mitraId: string): Promise<{ id: string; status: string; cluster_id: string | null }>;
  bacaSubmission(id: string): Promise<{ id: string; status: string; converted_proposal_id: string | null; data_json: Record<string, unknown> }>;
  bacaBarisJurnal(jurnalId: string): Promise<Array<{ urutan: number; akun_id: string; akun_kode: string; debit: string; kredit: string; mitra_id: string | null; akad_id: string | null }>>;
  bacaJurnal(jurnalId: string): Promise<{ id: string; no_jurnal: string; jenis: string; status: string; tanggal_transaksi: string; total_debit: string; total_kredit: string; referensi_tipe: string | null; referensi_id: string | null; jalur_posting: string }>;

  /**
   * Spec 8.4 check 10, read from the SHIPPED view `v_rekonsiliasi_piutang`
   * rather than recomputed here, so a test cannot agree with a wrong query it
   * wrote itself.
   */
  rekonsiliasi(akadId: string): Promise<Rekonsiliasi>;
  /** Every akad of this world with a non-zero reconciliation difference. */
  akadTidakRekonsiliasi(): Promise<Array<{ akad_id: string; selisih: string }>>;
  /** Mirrors the active-receivable predicate of pumk_akad_outstanding_idx. */
  dihitungSebagaiPiutangAktif(akadId: string): Promise<boolean>;

  tutup(): Promise<void>;
}

async function satu<T>(db: PumkTx, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) throw new Error(`fixture: query tidak mengembalikan baris: ${sql}`);
  return baris[0];
}

/** Which supporting rows a target status implies. Read as a table, on purpose. */
const PERLU_SURVEY: readonly StatusProposal[] = [
  "SURVEY_SELESAI",
  "REVIEW_CHECKER",
  "MENUNGGU_PERSETUJUAN",
  "DISETUJUI",
  "AKAD_DIBUAT",
  "JADWAL_SIAP",
  "DICAIRKAN",
  "TIDAK_DIREKOMENDASIKAN",
  "DITOLAK",
];
const PERLU_REVIEW: readonly StatusProposal[] = [
  "MENUNGGU_PERSETUJUAN",
  "DISETUJUI",
  "AKAD_DIBUAT",
  "JADWAL_SIAP",
  "DICAIRKAN",
];
const PERLU_APPROVAL: readonly StatusProposal[] = [
  "DISETUJUI",
  "AKAD_DIBUAT",
  "JADWAL_SIAP",
  "DICAIRKAN",
];
const PERLU_AKAD: readonly StatusProposal[] = ["AKAD_DIBUAT", "JADWAL_SIAP", "DICAIRKAN"];
const PERLU_JADWAL: readonly StatusProposal[] = ["JADWAL_SIAP", "DICAIRKAN"];

/**
 * Builds a minimal but complete world: one bumn, two branches, monthly OPEN
 * periods for 2026-01 .. 2028-12, the SHIPPED chart of accounts and all 19
 * SHIPPED event mappings, the SHIPPED RBAC matrix with one user per role, this
 * module's configuration rows scoped to the world's bumn, one sektor, one
 * karyawan and two clusters.
 */
export async function buatDunia(): Promise<DuniaPumk> {
  const db = buatPortDb();
  const jam = () => SEKARANG_BAKU;

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1) returning id::text as id`,
    [kunci("BUMN"), "PT Krakatau Steel (fixture pumk)"],
  );
  const cabang = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama, is_pusat) values ($1, $2, $3, true) returning id::text as id`,
    [bumn.id, kunci("CBG"), "Kantor Pusat (fixture pumk)"],
  );
  const cabangLain = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama) values ($1, $2, $3) returning id::text as id`,
    [bumn.id, kunci("CBG"), "Cabang B (fixture pumk)"],
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
  await seedRbac(db);

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
    izinRole.set(kodeRole, await permissionsForRole(db, kodeRole));
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

  // The SHIPPED COA and the SHIPPED 19 event mappings, by the same code path
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

  for (const [grup, kunciKonfig, nilai, tipe] of KONFIGURASI_AWAL) {
    await db.query(
      `insert into konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, deskripsi, perlu_konfirmasi)
       values ($1, $2, $3, $4, $5, 'fixture pumk (spec 5)', true)`,
      [bumn.id, grup, kunciKonfig, nilai, tipe],
    );
  }

  const sektor = await satu<{ id: string }>(
    db,
    `insert into sektor_pumk (bumn_id, kode, nama) values ($1, $2, 'Perdagangan (fixture)') returning id::text as id`,
    [bumn.id, kunci("SEK")],
  );
  const karyawan = await satu<{ id: string }>(
    db,
    `insert into karyawan (cabang_id, nip, nama, jabatan) values ($1, $2, 'Petugas Survey (fixture)', 'Staf')
     returning id::text as id`,
    [cabang.id, kunci("NIP")],
  );
  const cluster = await satu<{ id: string }>(
    db,
    `insert into cluster (cabang_id, kode, nama, sektor_id) values ($1, $2, 'Cluster Alpha (fixture)', $3)
     returning id::text as id`,
    [cabang.id, kunci("CLS"), sektor.id],
  );
  const clusterLain = await satu<{ id: string }>(
    db,
    `insert into cluster (cabang_id, kode, nama, sektor_id) values ($1, $2, 'Cluster Beta (fixture)', $3)
     returning id::text as id`,
    [cabang.id, kunci("CLS"), sektor.id],
  );

  // The two engines this module drives, wired the way the composition root
  // wires them, and used by the fixture itself for the preconditions that must
  // be REAL (a generated schedule, a posted disbursement journal).
  const { engine: jurnalEngine } = createJurnalModule({ db, jam });
  const { engine: angsuranEngine } = createAngsuranModule({ db, jurnal: jurnalEngine, jam });

  function ctxUntuk(nama: keyof typeof userId): PumkContext {
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
  } satisfies Record<keyof typeof userId, PumkContext>;

  function ctxAngsuran(c: PumkContext): AngsuranContext {
    return c;
  }
  function ctxJurnal(c: PumkContext): JurnalContext {
    return c;
  }

  async function buatMitra(
    opsi: { cabangId?: string; nama?: string; nik?: string } = {},
  ): Promise<MitraFixture> {
    const kode = kunci("MTR");
    const nik = opsi.nik ?? kunci("NIK").replace(/\D/g, "").padEnd(16, "0").slice(0, 16);
    const nama = opsi.nama ?? `Mitra ${kode}`;
    const m = await satu<{ id: string }>(
      db,
      `insert into mitra (cabang_id, kode_mitra, nama_lengkap, nik, sektor_id, status, nama_usaha)
       values ($1, $2, $3, $4, $5, 'CALON', $6) returning id::text as id`,
      [opsi.cabangId ?? cabang.id, kode, nama, nik, sektor.id, `Usaha ${kode}`],
    );
    return { id: m.id, kodeMitra: kode, nama, nik };
  }

  async function generateJadwalLewatEngine(akadId: string): Promise<Jadwal> {
    return angsuranEngine.generateJadwal({ akadId }, ctxAngsuran(ctx.maker));
  }

  async function cairkanLewatEngine(akadId: string, pokok: Uang, jasa: Uang): Promise<string> {
    const a = await satu<{ mitra_id: string; cabang_id: string; tanggal_akad: string; no_akad: string }>(
      db,
      `select mitra_id::text as mitra_id, cabang_id::text as cabang_id,
              tanggal_akad::text as tanggal_akad, no_akad
         from pumk_akad where id = $1`,
      [akadId],
    );
    const jurnal = await jurnalEngine.postingEvent(
      "PENCAIRAN_PUMK",
      {
        cabangId: a.cabang_id,
        tanggalTransaksi: a.tanggal_akad,
        nilai: pokok,
        keterangan: `Pencairan (fixture) akad ${a.no_akad}`,
        akunKasId: akun.kas.id,
        mitraId: a.mitra_id,
        akadId,
        referensiTipe: "pumk_pencairan",
        referensiId: akadId,
      },
      ctxJurnal(ctx.maker),
    );
    await db.query(
      `update pumk_akad
          set status = 'AKTIF', outstanding_pokok = $2, outstanding_jasa = $3, updated_by = $4
        where id = $1`,
      [akadId, pokok, jasa, userId.maker],
    );
    await db.query(`update mitra set status = 'AKTIF', updated_by = $2 where id = $1`, [
      a.mitra_id,
      userId.maker,
    ]);
    return jurnal.id;
  }

  async function siapkanProposal(
    status: StatusProposal,
    opsi: OpsiSiapkan = {},
  ): Promise<ProposalFixture> {
    const cabangId = opsi.cabangId ?? cabang.id;
    const mitra = opsi.mitra ?? (await buatMitra({ cabangId }));
    const maker = opsi.makerUserId ?? userId.maker;
    const checker = opsi.checkerUserId ?? userId.checker;
    const jumlah = opsi.jumlahDiajukan ?? POKOK_BAKU;
    const tenor = opsi.tenorDiajukan ?? TENOR_BAKU;
    const plafon = opsi.plafonDisetujui ?? jumlah;
    const tenorSetuju = opsi.tenorDisetujui ?? tenor;
    const rate = opsi.rate ?? RATE_BAKU;
    const tanggalProposal = opsi.tanggalProposal ?? TANGGAL_PROPOSAL_BAKU;
    const tanggalAkad = opsi.tanggalAkad ?? TANGGAL_AKAD_BAKU;
    const mulaiAngsuran = opsi.tanggalMulaiAngsuran ?? MULAI_ANGSURAN_BAKU;
    const noProposal = kunci("PRP");

    const proposal = await satu<{ id: string }>(
      db,
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, mitra_id, sektor_id,
          jumlah_diajukan, tenor_diajukan, tujuan_penggunaan, sumber_pengajuan,
          portal_submission_id, status, created_by, updated_by)
       values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       returning id::text as id`,
      [
        cabangId,
        noProposal,
        tanggalProposal,
        mitra.id,
        sektor.id,
        jumlah,
        tenor,
        "Tambahan modal kerja (fixture)",
        opsi.sumberPengajuan ?? "INTERNAL",
        opsi.portalSubmissionId ?? null,
        status,
        maker,
      ],
    );

    if (opsi.jaminan) {
      await db.query(
        `insert into pumk_jaminan (proposal_id, jenis, deskripsi, nilai_taksasi, status_fisik, tanggal_terima, created_by, updated_by)
         values ($1, $2, $3, $4, 'DITERIMA', $5, $6, $6)`,
        [
          proposal.id,
          opsi.jaminan,
          `Jaminan fixture ${opsi.jaminan}`,
          opsi.jaminan === "TANPA_JAMINAN" ? null : rp(50_000_000),
          tanggalProposal,
          maker,
        ],
      );
    }

    if (PERLU_SURVEY.includes(status)) {
      await db.query(
        `insert into pumk_survey
           (proposal_id, tanggal_survey, petugas_karyawan_id, hasil_json, skor_total,
            plafon_rekomendasi, tenor_rekomendasi, catatan, created_by, updated_by)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $9)`,
        [
          proposal.id,
          tanggalProposal,
          karyawan.id,
          JSON.stringify({ karakter: 80, kapasitas_usaha: 75, tempat_usaha: 80, agunan: 70, riwayat: 90 }),
          opsi.skorTotal ?? "80.000000",
          jumlah,
          tenor,
          "Survey fixture",
          maker,
        ],
      );
    }
    if (PERLU_REVIEW.includes(status)) {
      await db.query(
        `insert into pumk_review (proposal_id, reviewer_user_id, tanggal, keputusan, catatan, created_by, updated_by)
         values ($1, $2, $3, 'REKOMENDASI', 'Direkomendasikan (fixture)', $2, $2)`,
        [proposal.id, checker, tanggalProposal],
      );
    }
    if (PERLU_APPROVAL.includes(status)) {
      await db.query(
        `insert into pumk_approval
           (proposal_id, approver_user_id, tanggal, keputusan, plafon_disetujui, tenor_disetujui,
            jasa_adm_rate, catatan, created_by, updated_by)
         values ($1, $2, $3, 'SETUJU', $4, $5, $6, 'Disetujui (fixture)', $2, $2)`,
        [proposal.id, userId.approver, tanggalAkad, plafon, tenorSetuju, rate],
      );
    }

    let akadId: string | null = null;
    let noAkad: string | null = null;
    if (PERLU_AKAD.includes(status)) {
      noAkad = kunci("AKD");
      const jatuhTempoAkhir = tambahBulan(mulaiAngsuran, tenorSetuju - 1);
      const akad = await satu<{ id: string }>(
        db,
        `insert into pumk_akad
           (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
            jasa_adm_rate, metode_perhitungan, tenor_bulan, grace_period_bulan,
            tanggal_mulai_angsuran, tanggal_jatuh_tempo_akhir, status, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'FLAT', $8, 0, $9, $10, 'BELUM_CAIR', $11, $11)
         returning id::text as id`,
        [
          proposal.id,
          mitra.id,
          cabangId,
          noAkad,
          tanggalAkad,
          plafon,
          rate,
          tenorSetuju,
          mulaiAngsuran,
          jatuhTempoAkhir,
          userId.maker,
        ],
      );
      akadId = akad.id;
    }
    if (akadId && PERLU_JADWAL.includes(status)) {
      await generateJadwalLewatEngine(akadId);
    }
    if (akadId && status === "DICAIRKAN") {
      const jadwal = await db.query<{ jasa: string }>(
        `select coalesce(sum(jasa_adm), 0)::text as jasa
           from pumk_jadwal_angsuran
          where akad_id = $1 and is_active_version and deleted_at is null`,
        [akadId],
      );
      await cairkanLewatEngine(akadId, plafon, jadwal[0]?.jasa ?? "0.00");
    }

    return {
      proposalId: proposal.id,
      noProposal,
      mitraId: mitra.id,
      cabangId,
      status,
      jumlahDiajukan: jumlah,
      tenorDiajukan: tenor,
      plafonDisetujui: plafon,
      tenorDisetujui: tenorSetuju,
      akadId,
      noAkad,
    };
  }

  return {
    db,
    bumnId: bumn.id,
    cabangId: cabang.id,
    cabangLainId: cabangLain.id,
    sektorId: sektor.id,
    karyawanId: karyawan.id,
    clusterId: cluster.id,
    clusterLainId: clusterLain.id,
    akun,
    jam,
    userId,
    ctx,
    buatMitra,
    siapkanProposal,
    cairkanLewatEngine,
    generateJadwalLewatEngine,

    async buatSubmissionPortal(opsi = {}) {
      const noTiket = kunci("TKT");
      const data = opsi.data ?? {
        nama_lengkap: "Siti Aminah (portal fixture)",
        nik: "1871010101010001",
        telepon: "081200000001",
        email: "siti@example.test",
        nama_usaha: "Warung Siti",
        jumlah_diajukan: POKOK_BAKU,
        tenor_diajukan: TENOR_BAKU,
        tujuan_penggunaan: "Tambah stok dagangan",
      };
      const s = await satu<{ id: string }>(
        db,
        `insert into portal_submission
           (bumn_id, jenis, no_tiket, data_json, dokumen_json, email_kontak, telepon_kontak,
            status, converted_proposal_id)
         values ($1, $2, $3, $4::jsonb, '[]'::jsonb, $5, $6, $7, $8)
         returning id::text as id`,
        [
          bumn.id,
          opsi.jenis ?? "PUMK",
          noTiket,
          JSON.stringify(data),
          String(data.email ?? "portal@example.test"),
          String(data.telepon ?? "0812"),
          opsi.status ?? "BARU",
          opsi.convertedProposalId ?? null,
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

    bacaProposal(id) {
      return satu<ProposalDb>(
        db,
        `select id::text as id, cabang_id::text as cabang_id, no_proposal,
                tanggal_proposal::text as tanggal_proposal, mitra_id::text as mitra_id,
                sektor_id::text as sektor_id, jumlah_diajukan::text as jumlah_diajukan,
                tenor_diajukan, tujuan_penggunaan, sumber_pengajuan,
                portal_submission_id::text as portal_submission_id, status, current_step,
                created_by::text as created_by, version
           from pumk_proposal where id = $1 and deleted_at is null`,
        [id],
      );
    },

    bacaTransisi(proposalId) {
      return db.query<TransisiDb>(
        `select status_dari, status_ke, aksi, oleh_user_id::text as oleh_user_id,
                waktu::text as waktu, catatan
           from pumk_proposal_transisi where proposal_id = $1 order by waktu, aksi`,
        [proposalId],
      );
    },

    bacaSurvey(proposalId) {
      return db.query(
        `select id::text as id, tanggal_survey::text as tanggal_survey,
                skor_total::text as skor_total, plafon_rekomendasi::text as plafon_rekomendasi,
                tenor_rekomendasi, created_by::text as created_by
           from pumk_survey where proposal_id = $1 and deleted_at is null`,
        [proposalId],
      );
    },

    bacaReview(proposalId) {
      return db.query(
        `select id::text as id, reviewer_user_id::text as reviewer_user_id, keputusan, catatan
           from pumk_review where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaApproval(proposalId) {
      return db.query(
        `select id::text as id, approver_user_id::text as approver_user_id, keputusan,
                plafon_disetujui::text as plafon_disetujui, tenor_disetujui,
                jasa_adm_rate::text as jasa_adm_rate, catatan
           from pumk_approval where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaJaminan(proposalId) {
      return db.query(
        `select id::text as id, jenis, nilai_taksasi::text as nilai_taksasi
           from pumk_jaminan where proposal_id = $1 and deleted_at is null order by created_at`,
        [proposalId],
      );
    },

    bacaAkad(akadId) {
      return satu<AkadDb>(db, AKAD_SQL + ` where id = $1 and deleted_at is null`, [akadId]);
    },

    async bacaAkadByProposal(proposalId) {
      const baris = await db.query<AkadDb>(
        AKAD_SQL + ` where proposal_id = $1 and deleted_at is null`,
        [proposalId],
      );
      return baris[0] ?? null;
    },

    bacaJadwal(akadId, versi) {
      return db.query<BarisJadwalDb>(
        `select id::text as id, versi, angsuran_ke, tanggal_jatuh_tempo::text as tanggal_jatuh_tempo,
                pokok::text as pokok, jasa_adm::text as jasa_adm, total::text as total,
                saldo_pokok_setelah::text as saldo_pokok_setelah, status,
                pokok_terbayar::text as pokok_terbayar, jasa_terbayar::text as jasa_terbayar,
                tanggal_lunas::text as tanggal_lunas, is_active_version
           from pumk_jadwal_angsuran
          where akad_id = $1 and ($2::int is null or versi = $2) and deleted_at is null
          order by versi, angsuran_ke`,
        [akadId, versi ?? null],
      );
    },

    bacaVersi(akadId) {
      return db.query(
        `select versi, is_active_version, status, reschedule_id::text as reschedule_id
           from pumk_jadwal_versi where akad_id = $1 order by versi`,
        [akadId],
      );
    },

    bacaPencairan(akadId) {
      return db.query(
        `select id::text as id, tanggal_pencairan::text as tanggal_pencairan,
                jumlah::text as jumlah, akun_kas_id::text as akun_kas_id, no_bukti,
                jurnal_id::text as jurnal_id, created_by::text as created_by
           from pumk_pencairan where akad_id = $1 and deleted_at is null order by created_at`,
        [akadId],
      );
    },

    bacaAngsuran(akadId) {
      return db.query(
        `select id::text as id, tanggal_terima::text as tanggal_terima,
                jumlah_diterima::text as jumlah_diterima, alokasi_pokok::text as alokasi_pokok,
                alokasi_jasa::text as alokasi_jasa, alokasi_kelebihan::text as alokasi_kelebihan,
                jurnal_id::text as jurnal_id
           from pumk_angsuran where akad_id = $1 and deleted_at is null
          order by tanggal_terima, created_at`,
        [akadId],
      );
    },

    bacaKelebihan(akadId) {
      return db.query(
        `select id::text as id, tanggal::text as tanggal, jumlah::text as jumlah, status,
                jurnal_id_terima::text as jurnal_id_terima
           from pumk_kelebihan where akad_id = $1 and deleted_at is null order by tanggal, created_at`,
        [akadId],
      );
    },

    bacaReschedule(akadId) {
      return db.query(
        `select id::text as id, status, jadwal_versi_lama, jadwal_versi_baru,
                approved_by::text as approved_by
           from pumk_reschedule where akad_id = $1 and deleted_at is null order by created_at`,
        [akadId],
      );
    },

    bacaPengakhiran(akadId) {
      return db.query(
        `select id::text as id, jenis, tanggal::text as tanggal,
                outstanding_pokok_saat_itu::text as outstanding_pokok_saat_itu,
                outstanding_jasa_saat_itu::text as outstanding_jasa_saat_itu, no_sk,
                jurnal_id::text as jurnal_id, approved_by::text as approved_by
           from pumk_pengakhiran where akad_id = $1 and deleted_at is null order by created_at`,
        [akadId],
      );
    },

    bacaTindakLanjut(akadId) {
      return db.query(
        `select id::text as id, tanggal::text as tanggal, jenis, hasil,
                petugas_karyawan_id::text as petugas_karyawan_id, catatan
           from tindak_lanjut_penagihan where akad_id = $1 and deleted_at is null
          order by tanggal, created_at`,
        [akadId],
      );
    },

    bacaAnggotaCluster(clusterId) {
      return db.query(
        `select mitra_id::text as mitra_id, tanggal_masuk::text as tanggal_masuk,
                tanggal_keluar::text as tanggal_keluar, alasan_keluar
           from cluster_anggota where cluster_id = $1 and deleted_at is null
          order by tanggal_masuk, created_at`,
        [clusterId],
      );
    },

    bacaMitra(mitraId) {
      return satu(
        db,
        `select id::text as id, status, cluster_id::text as cluster_id from mitra where id = $1`,
        [mitraId],
      );
    },

    bacaSubmission(id) {
      return satu(
        db,
        `select id::text as id, status, converted_proposal_id::text as converted_proposal_id, data_json
           from portal_submission where id = $1 and deleted_at is null`,
        [id],
      );
    },

    bacaBarisJurnal(jurnalId) {
      return db.query(
        `select b.urutan, b.akun_id::text as akun_id, a.kode as akun_kode,
                b.debit::text as debit, b.kredit::text as kredit,
                b.mitra_id::text as mitra_id, b.akad_id::text as akad_id
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

    async rekonsiliasi(akadId) {
      const r = await satu<{ sub: string; bb: string; selisih: string }>(
        db,
        `select saldo_sub_ledger::text as sub, saldo_buku_besar::text as bb, selisih::text as selisih
           from v_rekonsiliasi_piutang where akad_id = $1`,
        [akadId],
      );
      return { saldoSubLedger: r.sub, saldoBukuBesar: r.bb, selisih: r.selisih };
    },

    akadTidakRekonsiliasi() {
      return db.query(
        `select v.akad_id::text as akad_id, v.selisih::text as selisih
           from v_rekonsiliasi_piutang v
           join cabang c on c.id = v.cabang_id
          where c.bumn_id = $1 and v.selisih <> 0`,
        [bumn.id],
      );
    },

    async dihitungSebagaiPiutangAktif(akadId) {
      const baris = await db.query<{ ada: boolean }>(
        `select true as ada from pumk_akad
          where id = $1 and deleted_at is null and status in ('AKTIF', 'RESCHEDULED', 'MACET')`,
        [akadId],
      );
      return baris.length === 1;
    },

    tutup: () => db.tutup(),
  };
}

const AKAD_SQL = `select id::text as id, proposal_id::text as proposal_id, mitra_id::text as mitra_id,
       cabang_id::text as cabang_id, no_akad, tanggal_akad::text as tanggal_akad,
       pokok_pinjaman::text as pokok_pinjaman, jasa_adm_rate::text as jasa_adm_rate,
       metode_perhitungan, tenor_bulan, grace_period_bulan,
       tanggal_mulai_angsuran::text as tanggal_mulai_angsuran,
       tanggal_jatuh_tempo_akhir::text as tanggal_jatuh_tempo_akhir, status,
       outstanding_pokok::text as outstanding_pokok, outstanding_jasa::text as outstanding_jasa,
       tanggal_lunas::text as tanggal_lunas
  from pumk_akad`;

// ---------------------------------------------------------------------------
// Recording wrappers around the REAL engines
// ---------------------------------------------------------------------------

export interface PanggilanJurnal {
  eventCode: string;
  cabangId: string;
  tanggalTransaksi: string;
  nilai: Uang;
  akunKasId?: string;
  mitraId?: string | null;
  akadId?: string | null;
  referensiTipe?: string | null;
  referensiId?: string | null;
}

export interface PorterJurnalUji extends PorterJurnalPumk {
  /** Every call, in order. The length is the "ONE journal, not three" assertion. */
  panggilan: PanggilanJurnal[];
  /**
   * Arms the next call to fail. The message deliberately looks like a raw
   * Postgres trigger string, so a rollback test can assert BOTH that the
   * operation rolled back AND that the raw text did not leak into the
   * `PumkError` the caller sees.
   */
  gagalkan(pesan?: string): void;
  reset(): void;
}

export const PESAN_JURNAL_GAGAL =
  "TJSL-JRN-031: jurnal OTOMATIS/202602/00001 tidak balance: total debit 12000000.00 total kredit 11000000.00";

/**
 * A RECORDING WRAPPER around the real ledger engine, reached through
 * modules/jurnal's index.ts. NOT a replacement for it.
 *
 * What the wrapper buys that a double cannot: the journal is really written,
 * by the code that writes it in production, against the SHIPPED
 * `event_jurnal_mapping` rows of this world, subject to every spec 6.2
 * validation, the deferred balance trigger, the sub-ledger dimension rule and
 * the posting-path tripwire of migrations/0020. A double that returned
 * `crypto.randomUUID()` as a journal id is what once hid a non-deferrable FK
 * from `pumk_pencairan.jurnal_id` and a rejected sub-ledger dimension behind a
 * green suite; `pumk_pencairan.jurnal_id` has exactly such an FK, so a fake id
 * here would raise 23503 and roll back the whole disbursement in production.
 *
 * `gagalkan()` throws BEFORE delegating, so an armed call writes no journal.
 * That is the one thing a double is legitimately for: a collaborator's
 * FAILURE, never its VALIDATION.
 */
export function porterJurnalUji(db: PumkDbPort, jam?: () => Date): PorterJurnalUji {
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
        akunKasId: payload.akunKasId,
        mitraId: payload.mitraId ?? null,
        akadId: payload.akadId ?? null,
        referensiTipe: payload.referensiTipe ?? null,
        referensiId: payload.referensiId ?? null,
      });
      if (pesanGagal) throw new Error(pesanGagal);
      return engine.postingEvent(eventCode, payload, ctx);
    },
  };
}

export interface PanggilanAngsuran {
  metode: "generateJadwal" | "alokasikanSetoran" | "ajukanReschedule" | "setujuiReschedule" | "riwayatJadwal";
  argumen: unknown;
}

export interface PorterAngsuranUji extends PorterAngsuranPumk {
  panggilan: PanggilanAngsuran[];
  /** Arms the NEXT call to the named method to fail. */
  gagalkan(metode: PanggilanAngsuran["metode"], pesan?: string): void;
  reset(): void;
}

export const PESAN_JADWAL_GAGAL =
  "TJSL-JDW-001: total pokok jadwal versi 1 (11999999.00) harus sama persis dengan pokok pinjaman akad (12000000.00)";

/**
 * The same treatment for the instalment engine: a recording wrapper around the
 * REAL engine from modules/angsuran's index.ts.
 *
 * This is the wrapper that makes the integration assertions of spec 9.1 mean
 * something. A double could return a plausible-looking schedule; only the real
 * engine writes rows that satisfy the DEFERRED version-1 total trigger, the
 * one-active-version index and the immutability trigger, and only the real
 * allocation engine routes a surplus into `pumk_kelebihan` instead of driving
 * the receivable negative. Those are precisely the behaviours spec 9.1 depends
 * on and must not be re-asserted against a fixture's opinion.
 */
export function porterAngsuranUji(
  db: PumkDbPort,
  jurnal: PorterJurnalPumk & { postingEventGabungan?: unknown },
  jam?: () => Date,
): PorterAngsuranUji {
  // The instalment engine needs the COMBINED posting capability (spec 7.2 step
  // 8), which is wider than this module's journal port, so it is given the real
  // ledger engine directly rather than the wrapper above. Deliberate: an
  // allocation's journal is the instalment engine's business, and its own test
  // file already pins it.
  void jurnal;
  const { engine: ledger } = createJurnalModule({ db, jam });
  const { engine } = createAngsuranModule({ db, jurnal: ledger, jam });
  const panggilan: PanggilanAngsuran[] = [];
  const armed = new Map<PanggilanAngsuran["metode"], string>();

  function periksa(metode: PanggilanAngsuran["metode"], argumen: unknown): void {
    panggilan.push({ metode, argumen });
    const pesan = armed.get(metode);
    if (pesan) {
      armed.delete(metode);
      throw new Error(pesan);
    }
  }

  return {
    panggilan,
    gagalkan(metode, pesan = PESAN_JADWAL_GAGAL) {
      armed.set(metode, pesan);
    },
    reset() {
      panggilan.length = 0;
      armed.clear();
    },
    async generateJadwal(input, ctx) {
      periksa("generateJadwal", input);
      return engine.generateJadwal(input, ctx);
    },
    async alokasikanSetoran(input, ctx) {
      periksa("alokasikanSetoran", input);
      return engine.alokasikanSetoran(input, ctx);
    },
    async ajukanReschedule(input, ctx) {
      periksa("ajukanReschedule", input);
      return engine.ajukanReschedule(input, ctx);
    },
    async setujuiReschedule(rescheduleId, ctx) {
      periksa("setujuiReschedule", rescheduleId);
      return engine.setujuiReschedule(rescheduleId, ctx);
    },
    async riwayatJadwal(akadId, ctx) {
      periksa("riwayatJadwal", akadId);
      return engine.riwayatJadwal(akadId, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions shared by the test files
// ---------------------------------------------------------------------------

/**
 * Fragments that mean a raw driver or trigger string has leaked into a
 * user-facing message. The module must wrap DB failures in `PumkError` with a
 * clean Indonesian message and keep the raw text in `penyebabDb`.
 */
const POLA_KEBOCORAN_DB =
  /TJSL-[A-Z]{3}-\d{3}|PL\/pgSQL|plpgsql|SQLSTATE|violates|duplicate key|null value in column|relation "|_ck\b|_uq\b|ERROR:|syntax error at/i;

/**
 * Asserts a rejection is the expected DOMAIN error, and that its message is
 * free of DB internals. DELIBERATELY STRICT ABOUT THE TYPE AND THE CODE: a
 * bare `Error("not implemented")` must NOT satisfy this, otherwise every
 * rejection test in this folder would go green against an unimplemented
 * module, which is the one failure mode a tests-first suite exists to prevent.
 */
export async function tolakDengan(janji: Promise<unknown>, kode: KodePumk): Promise<PumkError> {
  let ditangkap: unknown;
  try {
    await janji;
  } catch (e) {
    ditangkap = e;
  }
  if (ditangkap === undefined) {
    throw new Error(`diharapkan ditolak dengan ${kode}, tapi operasi berhasil`);
  }
  expect(ditangkap).toBeInstanceOf(PumkError);
  const err = ditangkap as PumkError;
  expect(err.kode).toBe(kode);
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.message).not.toMatch(POLA_KEBOCORAN_DB);
  return err;
}

/** Sanity: every code a test names exists in the contract's catalogue. */
export function kodeAda(kode: KodePumk): KodePumk {
  expect(Object.values(KODE_PUMK)).toContain(kode);
  return kode;
}

/** Spec 8.4 check 10: the sub-ledger and the general ledger agree exactly. */
export function periksaRekonsiliasiNol(r: Rekonsiliasi, saldoDiharapkan: Uang): void {
  expect(r.saldoSubLedger).toBe(saldoDiharapkan);
  expect(r.saldoBukuBesar).toBe(saldoDiharapkan);
  expect(r.selisih).toBe("0.00");
}
