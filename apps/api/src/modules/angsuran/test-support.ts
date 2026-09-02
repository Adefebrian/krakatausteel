// apps/api/src/modules/angsuran/test-support.ts
//
// Reusable fixture builder for the instalment engine tests (spec 7). NOT a
// *.test.ts file, so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// The invariants of spec 3 that this engine has to live with are enforced
// inside the database (migrations/0008_pumk.sql, docs/adr/0002): a generated
// schedule is immutable in its priced columns (trg_pumk_jadwal_10_immutable),
// exactly one version per akad may be active (pumk_jadwal_versi_aktif_uq),
// version 1's total pokok must equal the akad's principal as a DEFERRED
// constraint trigger, `0 <= outstanding_pokok <= pokok_pinjaman` are CHECKs,
// a schedule row can never be overpaid (pumk_jadwal_terbayar_ck), and a
// deposit must be fully accounted for (pumk_angsuran_alokasi_ck). A fake or
// in-memory repository proves nothing about any of them. So every fixture
// below writes to `tjsl_test`, which tools/test-env.ts guarantees is where
// DATABASE_URL points during `bun test`.
//
// WHY SO MUCH OF THIS IS COPIED FROM modules/jurnal/test-support.ts
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling module,
// and modules/jurnal/test-support.ts is internal to that module either way.
// (Its index.ts IS importable, and `porterJurnalUji` below does exactly that
// for the engine itself.) The money helpers, the
// unique-key helper, the deterministic PRNG, the DB port and the leak-detecting
// `tolakDengan` are therefore re-declared here with the SAME semantics. Two
// rules follow: the shapes must not drift (a sen-level difference between the
// two modules' `keSen` would be a real bug in a real ledger), and when a
// shared test-support package appears, this is the file that collapses into it.
//
// NO TEST MAY DEPEND ON ANOTHER TEST'S DATA. `bun run db:reset` and
// `bun run db:seed` are run periodically by other agents, and nothing here is
// cleaned up afterwards (physical DELETE is blocked on the schedule table by
// design), so every fixture key is uniquified per call via `kunci()`. Each
// world is self-contained: its own bumn, its own branches, its own chart of
// accounts, its own periods. Each akad additionally gets its OWN mitra,
// because pumk_akad_satu_aktif_per_mitra_uq allows exactly one live loan per
// mitra and a shared mitra would make the second akad of a file unbuildable.
import { SQL } from "bun";
import { expect } from "bun:test";
import { createJurnalModule } from "../jurnal/index";
import { seedTemplateLaporan } from "../../seed/coa-inti";
import {
  AngsuranError,
  KODE_ANGSURAN,
  type AngsuranContext,
  type AngsuranDbPort,
  type AngsuranTx,
  type KodeAngsuran,
  type KomponenJurnal,
  type MetodePerhitungan,
  type PorterJurnalAngsuran,
  type RateTahunan,
  type Uang,
} from "./contract";

// ---------------------------------------------------------------------------
// Money helpers. BigInt minor units internally, decimal string at the edges,
// never a float (see the money note in ./contract.ts).
// ---------------------------------------------------------------------------

/** Whole rupiah -> `Uang`. `rp(1_500_000)` === "1500000.00". */
export function rp(rupiahBulat: number): Uang {
  if (!Number.isSafeInteger(rupiahBulat) || rupiahBulat < 0) {
    throw new Error(`rp() hanya menerima rupiah bulat non-negatif, dapat: ${rupiahBulat}`);
  }
  return `${rupiahBulat}.00`;
}

/** Minor units (sen) -> `Uang`, for amounts that must not pass through a JS number. */
export function sen(minor: bigint): Uang {
  if (minor < 0n) throw new Error(`sen() hanya menerima nilai non-negatif, dapat: ${minor}`);
  const s = minor.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** `Uang` -> minor units. Exact; no parseFloat anywhere. */
export function keSen(nilai: Uang): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  return BigInt(m[1] + m[2] + m[3]);
}

export function jumlahUang(...nilai: Uang[]): Uang {
  return sen(nilai.reduce((acc, n) => acc + keSen(n), 0n));
}

export function kurangUang(a: Uang, b: Uang): Uang {
  return sen(keSen(a) - keSen(b));
}

/** `RateTahunan` -> micro units (6 dp). "0.030000" -> 30000n. */
export function keMikro(rate: RateTahunan): bigint {
  const m = /^(\d+)\.(\d{6})$/.exec(rate);
  if (!m) throw new Error(`bukan RateTahunan yang valid: ${JSON.stringify(rate)}`);
  return BigInt(m[1]) * 1_000_000n + BigInt(m[2]);
}

/** Micro units -> `RateTahunan`. */
export function keRate(mikro: bigint): RateTahunan {
  if (mikro < 0n) throw new Error(`rate tidak boleh negatif: ${mikro}`);
  const s = mikro.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * Deterministic PRNG (mulberry32) so a property-test failure reproduces
 * exactly from the seed printed in the test name.
 */
export function acak(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Unique keys
// ---------------------------------------------------------------------------

const JEJAK = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
let urut = 0;

/** Globally unique, human-readable fixture key. Never reused across runs. */
export function kunci(awalan: string): string {
  urut += 1;
  return `${awalan}-${JEJAK}-${urut.toString(36).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Adds whole months to an ISO date, clamping the day to the target month's
 * length. ONLY used to build fixture schedules from start dates whose day is
 * 1..28, so the clamp never fires here; the clamping RULE itself (spec 7.1
 * "tanggal 31 di Februari") is tested against hardcoded expected dates in
 * angsuran-jadwal.test.ts, never against this helper, because a fixture that
 * computes the expected value with the same code as the thing under test
 * proves nothing.
 */
export function tambahBulan(iso: string, bulan: number): string {
  const [y, m, d] = iso.split("-").map((x) => Number(x));
  const total = (y * 12 + (m - 1)) + bulan;
  const th = Math.floor(total / 12);
  const bl = (total % 12) + 1;
  const hariTerakhir = new Date(Date.UTC(th, bl, 0)).getUTCDate();
  const hari = Math.min(d, hariTerakhir);
  return `${th}-${String(bl).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The DB port
// ---------------------------------------------------------------------------

function urlDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test angsuran butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun run db:reset` dan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!url.split("?")[0].endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture angsuran di database non-test: ${url}`);
  }
  return url;
}

interface PortUji extends AngsuranDbPort {
  tutup(): Promise<void>;
}

function buatPortDb(): PortUji {
  const sql = new SQL({ url: urlDb(), max: 6 });
  const bungkus = (jalankan: (t: string, p: unknown[]) => Promise<unknown>): AngsuranTx => ({
    async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
      const hasil = await jalankan(text, params);
      return hasil as unknown as T[];
    },
  });
  return {
    query: bungkus((t, p) => sql.unsafe(t, p as never[])).query,
    async transaction<T>(jalankan: (tx: AngsuranTx) => Promise<T>): Promise<T> {
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
// Chart of accounts: only what the angsuran events need (spec 6.4)
// ---------------------------------------------------------------------------

type TipeAkun = "ASET" | "LIABILITAS" | "PENDAPATAN" | "BEBAN";

interface DefAkun {
  kode: string;
  nama: string;
  tipe: TipeAkun;
  saldoNormal: "D" | "K";
  isKas?: boolean;
  klasifikasi: string;
}

const DEF_AKUN: Record<string, DefAkun> = {
  kas: { kode: "1.1.01", nama: "Kas dan Setara Kas", tipe: "ASET", saldoNormal: "D", isKas: true, klasifikasi: "ASET" },
  kasKedua: { kode: "1.1.02", nama: "Bank Operasional TJSL", tipe: "ASET", saldoNormal: "D", isKas: true, klasifikasi: "ASET" },
  piutangPokok: { kode: "1.1.03", nama: "Piutang Pinjaman Mitra Binaan", tipe: "ASET", saldoNormal: "D", klasifikasi: "ASET" },
  piutangJasa: { kode: "1.1.04", nama: "Piutang Jasa Administrasi", tipe: "ASET", saldoNormal: "D", klasifikasi: "ASET" },
  kelebihanAngsuran: { kode: "2.1.01", nama: "Kelebihan Pembayaran Angsuran", tipe: "LIABILITAS", saldoNormal: "K", klasifikasi: "LIABILITAS" },
  pendapatanJasaAdm: { kode: "4.1.02", nama: "Pendapatan Jasa Administrasi Pinjaman", tipe: "PENDAPATAN", saldoNormal: "K", klasifikasi: "PENDAPATAN" },
};

export type KunciAkun = keyof typeof DEF_AKUN;

/**
 * The subset of spec 6.4 an instalment touches. Kept as data here for the same
 * reason modules/jurnal keeps the full table as data: the accounts behind an
 * automatic journal are rows (ADR 0004), and v_rekonsiliasi_piutang finds the
 * receivable account by looking up PENCAIRAN_PUMK's debit leg rather than
 * hardcoding a code, so that mapping must exist for the reconciliation view to
 * see this world at all.
 */
const KATALOG_EVENT: ReadonlyArray<{ code: string; debit: KunciAkun; kredit: KunciAkun }> = [
  { code: "PENCAIRAN_PUMK", debit: "piutangPokok", kredit: "kas" },
  { code: "ANGSURAN_POKOK", debit: "kas", kredit: "piutangPokok" },
  { code: "ANGSURAN_JASA_ADM", debit: "kas", kredit: "pendapatanJasaAdm" },
  { code: "ANGSURAN_JASA_ADM_AKRUAL", debit: "kas", kredit: "piutangJasa" },
  { code: "TERIMA_KELEBIHAN_ANGSURAN", debit: "kas", kredit: "kelebihanAngsuran" },
  { code: "KEMBALIKAN_KELEBIHAN_ANGSURAN", debit: "kelebihanAngsuran", kredit: "kas" },
];

/**
 * Configuration rows this module's engine reads. Seeded per world with
 * `bumn_id` set, so a world's values are its own and no test can be perturbed
 * by another agent editing the global (bumn_id NULL) rows shipped by
 * migrations/0004.
 *
 * NOTE on `angsuran.hari_jatuh_tempo_tetap`: spec 7.1 requires the option and
 * modules/konfigurasi/katalog.ts does not have it yet (see the note on
 * KUNCI_KONFIGURASI in ./contract.ts). It is seeded here so the tests can
 * exercise the mechanic; the catalogue entry belongs to the konfigurasi owner.
 */
const KONFIGURASI_AWAL: ReadonlyArray<[string, string, string, string]> = [
  ["angsuran", "pembulatan_angsuran", "0", "ENUM"],
  ["angsuran", "urutan_alokasi_setoran_preset", "DEFAULT", "STRING"],
  ["angsuran", "hari_jatuh_tempo_tetap", "0", "NUMBER"],
  ["akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG", "ENUM"],
  ["jasa_adm", "jasa_adm_basis_hari", "360", "ENUM"],
  ["jasa_adm", "turunkan_flat_dari_efektif", "false", "BOOLEAN"],
  ["jasa_adm", "rate_efektif_acuan", "0.030000", "NUMBER"],
  ["batasan", "tenor_max_bulan", "36", "NUMBER"],
  ["batasan", "grace_period_max_bulan", "6", "NUMBER"],
  ["batasan", "plafon_min_pumk", "1000000.00", "NUMBER"],
  ["batasan", "plafon_max_pumk", "250000000.00", "NUMBER"],
];

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface AkunFixture {
  id: string;
  kode: string;
  nama: string;
  isKas: boolean;
}

export interface OpsiAkad {
  pokok: Uang;
  rate?: RateTahunan;
  metode?: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan?: number;
  tanggalMulaiAngsuran: string;
  tanggalAkad?: string;
  status?: "BELUM_CAIR" | "AKTIF";
}

export interface AkadFixture {
  id: string;
  noAkad: string;
  mitraId: string;
  proposalId: string;
  pokok: Uang;
  rate: RateTahunan;
  metode: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan: number;
  tanggalMulaiAngsuran: string;
}

/** One fixture schedule row. `total` is derived, never passed in. */
export interface BarisJadwalUji {
  angsuranKe: number;
  tanggalJatuhTempo: string;
  pokok: Uang;
  jasaAdm: Uang;
  saldoPokokSetelah: Uang;
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

export interface AkadDb {
  id: string;
  status: string;
  pokok_pinjaman: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
  tanggal_lunas: string | null;
  tenor_bulan: number;
  grace_period_bulan: number;
  jasa_adm_rate: string;
  metode_perhitungan: string;
}

export interface DuniaAngsuran {
  db: PortUji;
  bumnId: string;
  cabangId: string;
  cabangLainId: string;
  akun: Record<KunciAkun, AkunFixture>;
  sektorId: string;
  jam: () => Date;
  ctx: {
    maker: AngsuranContext;
    checker: AngsuranContext;
    approver: AngsuranContext;
    /** Read-only: no PUMK write permission at all. */
    auditor: AngsuranContext;
    /** Maker of another branch: has the permission, lacks the scope. */
    makerCabangLain: AngsuranContext;
    /** Approver of another branch, for the scope rule on approvals. */
    approverCabangLain: AngsuranContext;
  };
  /** Creates a fresh mitra + proposal + akad. See the header on why the mitra is not shared. */
  buatAkad(opsi: OpsiAkad): Promise<AkadFixture>;
  /**
   * Stand-in for the pencairan module, which does not exist yet: sets the akad
   * AKTIF with the outstanding a disbursement would have left behind. The
   * allocation tests are about allocation, not about disbursement.
   */
  cairkan(akadId: string, outstandingPokok: Uang, outstandingJasa: Uang): Promise<void>;
  /**
   * Writes a schedule version by hand, in ONE transaction because the
   * version-1 total-pokok trigger is DEFERRED. Used by the allocation and
   * reschedule tests so that a failure there is a failure of allocation or
   * reschedule, not a knock-on from generateJadwal being unimplemented; spec
   * 7.1's own tests are what prove the engine produces these rows.
   */
  pasangJadwal(akadId: string, versi: number, baris: BarisJadwalUji[]): Promise<void>;
  /**
   * Marks a schedule row fully paid, by hand. Same reasoning as pasangJadwal:
   * the reschedule tests need "rows 1..3 already LUNAS" as a PRECONDITION, and
   * getting there through the allocation engine would couple two unimplemented
   * features into one failure.
   */
  tandaiLunas(akadId: string, versi: number, angsuranKe: number, tanggal: string): Promise<void>;
  setelKonfigurasi(grup: string, kunciKonfig: string, nilai: string): Promise<void>;
  bacaJadwal(akadId: string, versi?: number): Promise<BarisJadwalDb[]>;
  bacaAkad(akadId: string): Promise<AkadDb>;
  bacaVersi(akadId: string): Promise<Array<{ versi: number; is_active_version: boolean; status: string; reschedule_id: string | null }>>;
  bacaAngsuran(akadId: string): Promise<Array<{ id: string; tanggal_terima: string; jumlah_diterima: string; alokasi_pokok: string; alokasi_jasa: string; alokasi_kelebihan: string; jurnal_id: string | null }>>;
  bacaKelebihan(akadId: string): Promise<Array<{ id: string; tanggal: string; jumlah: string; status: string; jurnal_id_terima: string | null }>>;
  bacaReschedule(akadId: string): Promise<Array<{ id: string; status: string; jadwal_versi_lama: number; jadwal_versi_baru: number | null; approved_by: string | null }>>;
  /** Mirrors the "active receivable" predicate of pumk_akad_outstanding_idx (spec 8.4 check 10). */
  dihitungSebagaiPiutangAktif(akadId: string): Promise<boolean>;
  tutup(): Promise<void>;
}

async function satu<T>(db: AngsuranTx, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) throw new Error(`fixture: query tidak mengembalikan baris: ${sql}`);
  return baris[0];
}

/**
 * Builds a minimal but complete world: one bumn, two branches, monthly OPEN
 * periods covering 2026-01 to 2028-12 (every fixture date in this folder falls
 * inside that window), the angsuran slice of the spec 6.4 chart of accounts
 * and event mappings, this module's configuration rows scoped to the world's
 * bumn, and five users with distinct permission sets.
 */
export async function buatDunia(): Promise<DuniaAngsuran> {
  const db = buatPortDb();

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1) returning id`,
    [kunci("BUMN"), "PT Krakatau Steel (fixture angsuran)"],
  );

  const cabang = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama, is_pusat) values ($1, $2, $3, true) returning id`,
    [bumn.id, kunci("CBG"), "Kantor Pusat (fixture)"],
  );
  const cabangLain = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama) values ($1, $2, $3) returning id`,
    [bumn.id, kunci("CBG"), "Cabang Lain (fixture)"],
  );

  async function buatUser(nama: string, cabangId: string): Promise<string> {
    const u = await satu<{ id: string }>(
      db,
      `insert into app_user (cabang_id, nama, email, username, password_hash)
       values ($1, $2, $3, $4, 'x-not-a-real-hash') returning id`,
      [cabangId, nama, `${kunci("mail")}@example.test`, kunci("user")],
    );
    return u.id;
  }
  const maker = await buatUser("Maker (fixture)", cabang.id);
  const checker = await buatUser("Checker (fixture)", cabang.id);
  const approver = await buatUser("Approver (fixture)", cabang.id);
  const auditor = await buatUser("Auditor (fixture)", cabang.id);
  const makerLain = await buatUser("Maker Cabang Lain (fixture)", cabangLain.id);
  const approverLain = await buatUser("Approver Cabang Lain (fixture)", cabangLain.id);

  // RBAC rows, so the world matches how the app really resolves permissions.
  // `permission.kode` is unique GLOBALLY, so the inserts are idempotent across
  // worlds and across runs.
  const semuaPermission = ["pumk.view", "pumk.akad", "pumk.angsuran", "pumk.reschedule", "pumk.approve"];
  for (const kode of semuaPermission) {
    await db.query(
      `insert into permission (kode, grup, deskripsi) values ($1, 'pumk', $1)
       on conflict (kode) do nothing`,
      [kode],
    );
  }
  async function buatRole(nama: string, permissions: string[], userId: string): Promise<void> {
    const role = await satu<{ id: string }>(
      db,
      `insert into app_role (kode, nama) values ($1, $2) returning id`,
      [kunci(nama.toUpperCase()), `${nama} (fixture)`],
    );
    // One statement per permission: the Bun Postgres client serialises a JS
    // array as a bare comma-joined string, which `text[]` rejects.
    for (const kode of permissions) {
      await db.query(
        `insert into role_permission (role_id, permission_id)
         select $1, p.id from permission p where p.kode = $2`,
        [role.id, kode],
      );
    }
    await db.query(`insert into user_role (user_id, role_id) values ($1, $2)`, [userId, role.id]);
  }
  const IZIN_MAKER = ["pumk.view", "pumk.akad", "pumk.angsuran", "pumk.reschedule"];
  const IZIN_APPROVER = ["pumk.view", "pumk.approve"];
  await buatRole("Maker", IZIN_MAKER, maker);
  await buatRole("Checker", ["pumk.view"], checker);
  await buatRole("Approver", IZIN_APPROVER, approver);
  await buatRole("Auditor", ["pumk.view"], auditor);
  await buatRole("MakerLain", IZIN_MAKER, makerLain);
  await buatRole("ApproverLain", IZIN_APPROVER, approverLain);

  // Monthly OPEN periods for 2026-01 .. 2028-12. Every fixture date in this
  // folder (including the 2028 leap-February due dates) falls inside, so no
  // test can fail for the incidental reason that its date has no period.
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

  // akun.klasifikasi_akun is a real composite FK into klasifikasi_akun
  // (migrations/0005_coa.sql, split off the printed line by 0028), and a
  // printed line belongs to a template, so all three have to exist first. The
  // template is the seed's own `BAWAAN`, resolved rather than invented, so
  // this world and a seeded database describe the same presentation.
  const templateId = await seedTemplateLaporan(db, bumn.id);
  const barisLaporan: Array<[string, string, string, number]> = [
    ["ASET", "Aset", "POSISI_KEUANGAN", 10],
    ["LIABILITAS", "Liabilitas", "POSISI_KEUANGAN", 30],
    ["PENDAPATAN", "Pendapatan", "AKTIVITAS", 10],
    ["BEBAN", "Beban", "AKTIVITAS", 20],
  ];
  for (const [kode, nama, laporan, urutan] of barisLaporan) {
    await db.query(
      `insert into klasifikasi_akun (bumn_id, kode, nama, urutan)
       values ($1, $2, $3, $4) on conflict (bumn_id, kode) do nothing`,
      [bumn.id, kode, nama, urutan],
    );
    await db.query(
      `insert into baris_laporan
         (bumn_id, template_id, laporan, kode, nama, urutan, level, tipe_baris, tanda, seksi)
       values ($1, $2, $3, $4, $5, $6, 1, 'DETAIL', 1, $3)`,
      [bumn.id, templateId, laporan, kode, nama, urutan],
    );
    await db.query(
      `insert into pemetaan_baris_laporan
         (bumn_id, template_id, klasifikasi_id, baris_laporan_id, laporan)
       select $1, $2, k.id, b.id, $3
         from klasifikasi_akun k, baris_laporan b
        where k.bumn_id = $1 and k.kode = $4
          and b.bumn_id = $1 and b.template_id = $2 and b.kode = $4`,
      [bumn.id, templateId, laporan, kode],
    );
  }

  const header: Record<string, string> = {};
  const defHeader: Array<[string, string, TipeAkun, "D" | "K", string]> = [
    ["1", "ASET", "ASET", "D", "ASET"],
    ["2", "LIABILITAS", "LIABILITAS", "K", "LIABILITAS"],
    ["4", "PENDAPATAN", "PENDAPATAN", "K", "PENDAPATAN"],
    ["5", "BEBAN", "BEBAN", "D", "BEBAN"],
  ];
  for (const [kode, nama, tipe, saldo, klasifikasi] of defHeader) {
    const h = await satu<{ id: string }>(
      db,
      `insert into akun (bumn_id, kode, nama, level, tipe, saldo_normal, is_postable, klasifikasi_akun)
       values ($1, $2, $3, 1, $4, $5, false, $6) returning id`,
      [bumn.id, kode, nama, tipe, saldo, klasifikasi],
    );
    header[tipe] = h.id;
  }

  const akun = {} as Record<KunciAkun, AkunFixture>;
  for (const [kunciAkun, def] of Object.entries(DEF_AKUN) as Array<[KunciAkun, DefAkun]>) {
    const a = await satu<{ id: string }>(
      db,
      `insert into akun
         (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal,
          is_postable, is_kas, aktif, klasifikasi_akun)
       values ($1, $2, $3, $4, 2, $5, $6, true, $7, true, $8) returning id`,
      [bumn.id, def.kode, def.nama, header[def.tipe], def.tipe, def.saldoNormal, def.isKas ?? false, def.klasifikasi],
    );
    akun[kunciAkun] = { id: a.id, kode: def.kode, nama: def.nama, isKas: def.isKas ?? false };
  }

  for (const ev of KATALOG_EVENT) {
    await db.query(
      `insert into event_jurnal_mapping
         (bumn_id, event_code, deskripsi, akun_debit_id, akun_kredit_id,
          debit_dari_payload, kredit_dari_payload, jenis_jurnal, aktif)
       values ($1, $2, $3, $4, $5, false, false, 'OTOMATIS', true)`,
      [bumn.id, ev.code, `${ev.code} (fixture)`, akun[ev.debit].id, akun[ev.kredit].id],
    );
  }

  for (const [grup, kunciKonfig, nilai, tipe] of KONFIGURASI_AWAL) {
    await db.query(
      `insert into konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, deskripsi, perlu_konfirmasi)
       values ($1, $2, $3, $4, $5, 'fixture angsuran (spec 5)', true)`,
      [bumn.id, grup, kunciKonfig, nilai, tipe],
    );
  }

  const sektor = await satu<{ id: string }>(
    db,
    `insert into sektor_pumk (bumn_id, kode, nama) values ($1, $2, 'Perdagangan (fixture)') returning id`,
    [bumn.id, kunci("SEK")],
  );

  const jam = () => new Date("2026-06-15T04:00:00.000Z");

  function ctxUntuk(userId: string, cabangId: string, permissions: string[]): AngsuranContext {
    return { userId, cabangId, bumnId: bumn.id, permissions };
  }

  return {
    db,
    bumnId: bumn.id,
    cabangId: cabang.id,
    cabangLainId: cabangLain.id,
    akun,
    sektorId: sektor.id,
    jam,
    ctx: {
      maker: ctxUntuk(maker, cabang.id, IZIN_MAKER),
      checker: ctxUntuk(checker, cabang.id, ["pumk.view"]),
      approver: ctxUntuk(approver, cabang.id, IZIN_APPROVER),
      auditor: ctxUntuk(auditor, cabang.id, ["pumk.view"]),
      makerCabangLain: ctxUntuk(makerLain, cabangLain.id, IZIN_MAKER),
      approverCabangLain: ctxUntuk(approverLain, cabangLain.id, IZIN_APPROVER),
    },

    async buatAkad(opsi: OpsiAkad): Promise<AkadFixture> {
      const rate = opsi.rate ?? "0.030000";
      const metode = opsi.metode ?? "FLAT";
      const grace = opsi.gracePeriodBulan ?? 0;
      const tanggalAkad = opsi.tanggalAkad ?? "2026-01-05";
      const mitra = await satu<{ id: string }>(
        db,
        `insert into mitra (cabang_id, kode_mitra, nama_lengkap, sektor_id, status)
         values ($1, $2, $3, $4, 'AKTIF') returning id`,
        [cabang.id, kunci("MTR"), `Mitra ${kunci("f")}`, sektor.id],
      );
      const proposal = await satu<{ id: string }>(
        db,
        `insert into pumk_proposal
           (cabang_id, no_proposal, tanggal_proposal, mitra_id, sektor_id,
            jumlah_diajukan, tenor_diajukan, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'DICAIRKAN') returning id`,
        [cabang.id, kunci("PRP"), tanggalAkad, mitra.id, sektor.id, opsi.pokok, opsi.tenorBulan],
      );
      const jatuhTempoAkhir = tambahBulan(opsi.tanggalMulaiAngsuran, grace + opsi.tenorBulan - 1);
      const akad = await satu<{ id: string; no_akad: string }>(
        db,
        `insert into pumk_akad
           (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
            jasa_adm_rate, metode_perhitungan, tenor_bulan, grace_period_bulan,
            tanggal_mulai_angsuran, tanggal_jatuh_tempo_akhir, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning id, no_akad`,
        [
          proposal.id,
          mitra.id,
          cabang.id,
          kunci("AKD"),
          tanggalAkad,
          opsi.pokok,
          rate,
          metode,
          opsi.tenorBulan,
          grace,
          opsi.tanggalMulaiAngsuran,
          jatuhTempoAkhir,
          opsi.status ?? "BELUM_CAIR",
        ],
      );
      return {
        id: akad.id,
        noAkad: akad.no_akad,
        mitraId: mitra.id,
        proposalId: proposal.id,
        pokok: opsi.pokok,
        rate,
        metode,
        tenorBulan: opsi.tenorBulan,
        gracePeriodBulan: grace,
        tanggalMulaiAngsuran: opsi.tanggalMulaiAngsuran,
      };
    },

    async cairkan(akadId, outstandingPokok, outstandingJasa): Promise<void> {
      await db.query(
        `update pumk_akad
            set status = 'AKTIF', outstanding_pokok = $2, outstanding_jasa = $3
          where id = $1`,
        [akadId, outstandingPokok, outstandingJasa],
      );
    },

    async pasangJadwal(akadId, versi, baris): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.query(
          `insert into pumk_jadwal_versi (akad_id, versi, is_active_version, status, tanggal_berlaku)
           values ($1, $2, true, 'ACTIVE', $3)`,
          [akadId, versi, baris[0]?.tanggalJatuhTempo ?? null],
        );
        for (const b of baris) {
          await tx.query(
            `insert into pumk_jadwal_angsuran
               (akad_id, versi, angsuran_ke, tanggal_jatuh_tempo, pokok, jasa_adm, total,
                saldo_pokok_setelah, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'BELUM_JATUH_TEMPO')`,
            [
              akadId,
              versi,
              b.angsuranKe,
              b.tanggalJatuhTempo,
              b.pokok,
              b.jasaAdm,
              jumlahUang(b.pokok, b.jasaAdm),
              b.saldoPokokSetelah,
            ],
          );
        }
      });
    },

    async tandaiLunas(akadId, versi, angsuranKe, tanggal): Promise<void> {
      await db.query(
        `update pumk_jadwal_angsuran
            set pokok_terbayar = pokok, jasa_terbayar = jasa_adm,
                status = 'LUNAS', tanggal_lunas = $4
          where akad_id = $1 and versi = $2 and angsuran_ke = $3`,
        [akadId, versi, angsuranKe, tanggal],
      );
      // Keeps the akad's outstanding columns in step with the rows this helper
      // just marked paid, over the ACTIVE version only, so a reschedule test
      // starts from a self-consistent akad.
      await db.query(
        `update pumk_akad a
            set outstanding_pokok = greatest(
                  a.pokok_pinjaman - coalesce((
                    select sum(j.pokok_terbayar) from pumk_jadwal_angsuran j
                     where j.akad_id = a.id and j.is_active_version and j.deleted_at is null), 0), 0),
                outstanding_jasa = greatest(coalesce((
                    select sum(j.jasa_adm - j.jasa_terbayar) from pumk_jadwal_angsuran j
                     where j.akad_id = a.id and j.is_active_version and j.deleted_at is null), 0), 0)
          where a.id = $1`,
        [akadId],
      );
    },

    async setelKonfigurasi(grup, kunciKonfig, nilai): Promise<void> {
      const hasil = await db.query<{ id: string }>(
        `update konfigurasi set nilai = $4, diubah_at = now()
          where bumn_id = $1 and grup = $2 and kunci = $3 and deleted_at is null
          returning id`,
        [bumn.id, grup, kunciKonfig, nilai],
      );
      if (hasil.length === 0) {
        throw new Error(
          `fixture: konfigurasi ${grup}.${kunciKonfig} tidak ada untuk bumn ini; ` +
            "tambahkan ke KONFIGURASI_AWAL di test-support.ts",
        );
      }
    },

    async bacaJadwal(akadId, versi): Promise<BarisJadwalDb[]> {
      return db.query<BarisJadwalDb>(
        `select id, versi, angsuran_ke, tanggal_jatuh_tempo::text as tanggal_jatuh_tempo,
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

    async bacaAkad(akadId): Promise<AkadDb> {
      return satu<AkadDb>(
        db,
        `select id, status, pokok_pinjaman::text as pokok_pinjaman,
                outstanding_pokok::text as outstanding_pokok,
                outstanding_jasa::text as outstanding_jasa,
                tanggal_lunas::text as tanggal_lunas, tenor_bulan, grace_period_bulan,
                jasa_adm_rate::text as jasa_adm_rate, metode_perhitungan
           from pumk_akad where id = $1`,
        [akadId],
      );
    },

    async bacaVersi(akadId) {
      return db.query(
        `select versi, is_active_version, status, reschedule_id
           from pumk_jadwal_versi where akad_id = $1 order by versi`,
        [akadId],
      );
    },

    async bacaAngsuran(akadId) {
      return db.query(
        `select id, tanggal_terima::text as tanggal_terima,
                jumlah_diterima::text as jumlah_diterima, alokasi_pokok::text as alokasi_pokok,
                alokasi_jasa::text as alokasi_jasa, alokasi_kelebihan::text as alokasi_kelebihan,
                jurnal_id
           from pumk_angsuran where akad_id = $1 and deleted_at is null
          order by tanggal_terima, created_at`,
        [akadId],
      );
    },

    async bacaKelebihan(akadId) {
      return db.query(
        `select id, tanggal::text as tanggal, jumlah::text as jumlah, status, jurnal_id_terima
           from pumk_kelebihan where akad_id = $1 and deleted_at is null order by tanggal, created_at`,
        [akadId],
      );
    },

    async bacaReschedule(akadId) {
      return db.query(
        `select id, status, jadwal_versi_lama, jadwal_versi_baru, approved_by
           from pumk_reschedule where akad_id = $1 and deleted_at is null order by created_at`,
        [akadId],
      );
    },

    async dihitungSebagaiPiutangAktif(akadId): Promise<boolean> {
      const baris = await db.query<{ ada: boolean }>(
        `select true as ada from pumk_akad
          where id = $1 and deleted_at is null
            and status in ('AKTIF', 'RESCHEDULED', 'MACET')`,
        [akadId],
      );
      return baris.length === 1;
    },

    /**
     * Teardown: soft-deletes THIS WORLD'S OWN bumn, then closes the pool.
     *
     * WHY THE SOFT DELETE IS PART OF TEARDOWN. `seedFase0` sweeps every bumn
     * `WHERE deleted_at IS NULL` and re-seeds its COA, event mappings and
     * programme master, because a deploy must leave EVERY reporting entity
     * postable. That property is asserted by apps/api/src/seed/*.test.ts and is
     * not negotiable. But a fixture bumn that is never removed stays in that
     * sweep forever, so the cost of the seed grows with the number of test runs
     * ever executed against the shared `tjsl_test`, and those tests eventually
     * time out on a database nobody reset.
     *
     * Soft-deleting the world's bumn here makes the sweep track LIVE entities
     * instead of every world ever built. Nothing else changes: the rows stay
     * for post-mortem, no assertion is weakened, no production code moves, and
     * every other world is untouched because the statement is keyed by this
     * world's own id.
     *
     * `deleted_by` comes from a user of this world, because `bumn_soft_delete_ck`
     * requires deleted_at and deleted_by to move together. The FROM clause
     * makes the statement a no-op rather than a constraint violation if a world
     * ever has no user, so teardown can never fail louder than the test it
     * follows.
     */
    async tutup() {
      await db.query(
        `update bumn b
            set deleted_at = now(), deleted_by = u.id
           from (select au.id from app_user au
                   join cabang c on c.id = au.cabang_id
                  where c.bumn_id = $1) u
          where b.id = $1 and b.deleted_at is null`,
        [bumn.id],
      );
      await db.tutup();
    },
  };
}

// ---------------------------------------------------------------------------
// The journal port double
// ---------------------------------------------------------------------------

export interface PanggilanJurnal {
  cabangId: string;
  tanggalTransaksi: string;
  komponen: KomponenJurnal[];
  akunKasId?: string | null;
  referensiTipe?: string | null;
  referensiId?: string | null;
}

export interface PorterUji extends PorterJurnalAngsuran {
  /** Every call, in order. Length is the "one journal, not three" assertion. */
  panggilan: PanggilanJurnal[];
  /**
   * Arms the next call to fail. The message deliberately looks like a raw
   * Postgres trigger string, so the allocation test can assert BOTH that the
   * transaction rolled back AND that the raw text did not leak into the
   * AngsuranError a caller sees.
   */
  gagalkan(pesan?: string): void;
  reset(): void;
}

export const PESAN_JURNAL_GAGAL =
  "TJSL-JRN-031: jurnal OTOMATIS/202603/00001 tidak balance: total debit 1030000.00 total kredit 1000000.00";

/**
 * A RECORDING WRAPPER around the real journal engine, not a replacement for it.
 *
 * An earlier version of this file was a pure double that wrote no jurnal rows
 * and returned `crypto.randomUUID()` as the journal id, on the stated belief
 * that "`pumk_angsuran.jurnal_id` and `pumk_kelebihan.jurnal_id_terima` have no
 * FK to `jurnal`". That was simply false. migrations/0010_jurnal.sql declares
 * both, and neither is DEFERRABLE:
 *
 *   ALTER TABLE pumk_angsuran  ADD CONSTRAINT pumk_angsuran_jurnal_fk
 *     FOREIGN KEY (jurnal_id) REFERENCES jurnal(id);
 *   ALTER TABLE pumk_kelebihan ADD CONSTRAINT pumk_kelebihan_jurnal_terima_fk
 *     FOREIGN KEY (jurnal_id_terima) REFERENCES jurnal(id);
 *
 * So storing an id for a journal that was never written raised 23503 on the
 * spot and rolled back the whole allocation. Sixteen allocation tests failed
 * for that reason alone, and the two ways to make them pass without fixing the
 * fixture were both laundering: loosening the FK (a real invariant plus a
 * migration) or storing the id "only when the journal exists" (green tests, and
 * a silently missing receipt-to-journal audit link in production). Since
 * migration 0020 the database also refuses direct writes to `jurnal` from
 * outside the ledger engine (TJSL-JRN-015, invariant 11 in the schema), so
 * hand-writing a journal row here is not available either, and rightly so.
 *
 * The engine that gets built here is the real one, reached through
 * modules/jurnal's index.ts, which is the import the boundary checker allows
 * and the same wiring the composition root uses:
 * `createAngsuranModule({ db, jurnal: jurnal.engine })`. No adapter in between,
 * because `JurnalEngine.postingEventGabungan` already has the shape
 * `PorterJurnalAngsuran` declares.
 *
 * Everything the double existed for survives, as a thin shell around the real
 * call rather than instead of it:
 *   - `panggilan` still records every call in order, so "ONE journal, not
 *     three" (spec 7.2 step 8) is still asserted on the call count;
 *   - `gagalkan()` still injects a failure whose text deliberately looks like a
 *     raw Postgres trigger string, so the rollback tests still prove both that
 *     the allocation rolled back AND that the raw text never leaked into the
 *     `AngsuranError` a caller sees. It throws BEFORE delegating, so no journal
 *     is written on an armed call.
 *
 * What the wrapper buys that the double could not: the journal is really
 * written, by the code that will write it in production, against the real
 * `event_jurnal_mapping` rows of this world. That is what caught a sub-ledger
 * dimension being tagged onto the cash and kelebihan components as well as
 * pokok: the double ignored dimensions, so the suite stayed green while the
 * real engine rejects it with DIMENSI_PIUTANG_SALAH_AKUN (spec 6.2 validation
 * 8) and every allocation would have rolled back in production.
 */
export function porterJurnalUji(db: AngsuranDbPort, jam?: () => Date): PorterUji {
  // Structural, not coincidental: AngsuranDbPort/AngsuranTx and
  // JurnalDbPort/JurnalTx are the same shape by design (see the note on
  // AngsuranDbPort in ./contract.ts), so the world's port drives both engines
  // and both therefore share one transaction.
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
    async postingEventGabungan(input, tx, ctx) {
      panggilan.push({
        cabangId: input.cabangId,
        tanggalTransaksi: input.tanggalTransaksi,
        komponen: input.komponen,
        akunKasId: input.akunKasId ?? null,
        referensiTipe: input.referensiTipe ?? null,
        referensiId: input.referensiId ?? null,
      });
      if (pesanGagal) throw new Error(pesanGagal);
      const jurnal = await engine.postingEventGabungan(input, tx, ctx);
      return { jurnalId: jurnal.jurnalId, jumlahBaris: jurnal.jumlahBaris };
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions shared by the test files
// ---------------------------------------------------------------------------

/**
 * Fragments that mean a raw driver or trigger string has leaked into a
 * user-facing message. The engine wraps DB failures in `AngsuranError` with a
 * clean Indonesian message and keeps the raw text in `penyebabDb`.
 */
const POLA_KEBOCORAN_DB =
  /TJSL-[A-Z]{3}-\d{3}|PL\/pgSQL|plpgsql|SQLSTATE|violates|duplicate key|null value in column|relation "|_ck\b|_uq\b|ERROR:|syntax error at/i;

/**
 * Asserts a rejection is the expected DOMAIN error, and that its message is
 * free of DB internals. Deliberately strict about the code: a bare
 * `Error("not implemented")` must NOT satisfy this, otherwise these tests
 * would go green against an unimplemented engine.
 */
export async function tolakDengan(
  janji: Promise<unknown>,
  kode: KodeAngsuran,
): Promise<AngsuranError> {
  let ditangkap: unknown;
  try {
    await janji;
  } catch (e) {
    ditangkap = e;
  }
  if (ditangkap === undefined) {
    throw new Error(`diharapkan ditolak dengan ${kode}, tapi operasi berhasil`);
  }
  expect(ditangkap).toBeInstanceOf(AngsuranError);
  const err = ditangkap as AngsuranError;
  expect(err.kode).toBe(kode);
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.message).not.toMatch(POLA_KEBOCORAN_DB);
  return err;
}

/** Same, for the synchronous helper `rateFlatEkuivalen`. */
export function tolakDenganSinkron(jalankan: () => unknown, kode: KodeAngsuran): AngsuranError {
  let ditangkap: unknown;
  try {
    jalankan();
  } catch (e) {
    ditangkap = e;
  }
  if (ditangkap === undefined) {
    throw new Error(`diharapkan ditolak dengan ${kode}, tapi operasi berhasil`);
  }
  expect(ditangkap).toBeInstanceOf(AngsuranError);
  const err = ditangkap as AngsuranError;
  expect(err.kode).toBe(kode);
  expect(err.message).not.toMatch(POLA_KEBOCORAN_DB);
  return err;
}

/** Sanity: every code used by the tests exists in the contract's catalogue. */
export function kodeAda(kode: KodeAngsuran): KodeAngsuran {
  expect(Object.values(KODE_ANGSURAN)).toContain(kode);
  return kode;
}

/**
 * Spec 7.1's two non-negotiable totals, checked against whatever rows are
 * given: SUM(pokok) equals the principal EXACTLY, and the last row's
 * `saldo_pokok_setelah` is exactly zero. Shared so every schedule test asserts
 * them the same way and none can quietly forget one.
 */
export function periksaTotalPokok(
  baris: ReadonlyArray<{ pokok: Uang; saldoPokokSetelah: Uang }>,
  pokokPinjaman: Uang,
): void {
  expect(baris.length).toBeGreaterThan(0);
  const jumlah = baris.reduce((acc, b) => acc + keSen(b.pokok), 0n);
  expect(sen(jumlah)).toBe(pokokPinjaman);
  expect(baris[baris.length - 1].saldoPokokSetelah).toBe("0.00");
}

/** Every row's amount is a multiple of the rounding unit, except the last. */
export function periksaPembulatan(
  baris: ReadonlyArray<{ pokok: Uang; jasaAdm: Uang }>,
  unitSen: bigint,
): void {
  for (let i = 0; i < baris.length - 1; i += 1) {
    expect(keSen(baris[i].pokok) % unitSen).toBe(0n);
    expect(keSen(baris[i].jasaAdm) % unitSen).toBe(0n);
  }
}
