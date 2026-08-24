// apps/api/src/modules/jurnal/test-support.ts
//
// Reusable fixture builder for the journal engine tests. NOT a *.test.ts file,
// so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// The accounting invariants of spec 3 are enforced by CHECK constraints and
// triggers inside the database (docs/adr/0002): one-side-per-line, balance and
// minimum two lines at POST, POSTED immutability including no soft delete, no
// journal dated into a CLOSED period, postable-account-only via a real FK,
// sequential period close. A fake or in-memory repository proves nothing about
// any of them. So every fixture below writes to `tjsl_test`, which
// tools/test-env.ts guarantees is where DATABASE_URL points during `bun test`.
//
// WHY THE DB HANDLE IS BUILT HERE AND NOT TAKEN FROM core/
// The engine needs a TRANSACTIONAL port (`JurnalDbPort` in ./contract.ts):
// postingBatch is all-or-nothing, reversal must revert business state in the
// same transaction, and the balance trigger is DEFERRED so it only raises at
// COMMIT. `core/ports/db.ts` is currently query-only and another agent is live
// in core/**, so this file builds the port itself from Bun's own Postgres
// client. Two consequences worth knowing:
//   - `bun tools/check-boundaries.ts` forbids modules/** from importing `pg`
//     or the lib/* wrappers; `bun:sql` is neither, so this stays inside the
//     boundary rules rather than punching through them.
//   - When core grows a real transactional adapter, the ONLY thing that should
//     change here is `buatPortDb()`. Tests and fixtures depend on the port
//     interface from ./contract.ts, never on a driver type.
//
// NO TEST MAY DEPEND ON ANOTHER TEST'S DATA. `bun run db:reset` is run
// periodically by other agents, and nothing here is cleaned up afterwards
// (physical DELETE is blocked on the ledger tables by design), so every
// fixture key is uniquified per call via `kunci()`. A world is self-contained
// down to its own `bumn`, which means its `periode`, `akun`, `baris_laporan`
// and `event_jurnal_mapping` rows can never collide with another world's.
import { SQL } from "bun";
import { expect } from "bun:test";
import {
  JurnalError,
  KODE_JURNAL,
  KUNCI_KONFIGURASI,
  type JenisJurnal,
  type JurnalContext,
  type JurnalDbPort,
  type JurnalTx,
  type KodeJurnal,
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
// The DB port
// ---------------------------------------------------------------------------

function urlDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test jurnal butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun run db:reset` dan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!url.split("?")[0].endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture jurnal di database non-test: ${url}`);
  }
  return url;
}

interface PortUji extends JurnalDbPort {
  tutup(): Promise<void>;
}

function buatPortDb(): PortUji {
  const sql = new SQL({ url: urlDb(), max: 6 });
  const bungkus = (jalankan: (t: string, p: unknown[]) => Promise<unknown>): JurnalTx => ({
    async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
      const hasil = await jalankan(text, params);
      return hasil as unknown as T[];
    },
  });
  return {
    query: bungkus((t, p) => sql.unsafe(t, p as never[])).query,
    async transaction<T>(jalankan: (tx: JurnalTx) => Promise<T>): Promise<T> {
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
// Chart of accounts for the minimal world
// ---------------------------------------------------------------------------

type TipeAkun = "ASET" | "LIABILITAS" | "ASET_NETO" | "PENDAPATAN" | "BEBAN";

interface DefAkun {
  kode: string;
  nama: string;
  tipe: TipeAkun;
  saldoNormal: "D" | "K";
  isKas?: boolean;
  isKontra?: boolean;
  aktif?: boolean;
  klasifikasi: string;
}

/**
 * Every account spec 6.4 names, plus the ones the validation tests need
 * (a second cash account, an alternative receivable account, an inactive
 * account). Header (non-postable) parents are created separately.
 */
const DEF_AKUN: Record<string, DefAkun> = {
  kas: { kode: "1.1.01", nama: "Kas dan Setara Kas", tipe: "ASET", saldoNormal: "D", isKas: true, klasifikasi: "ASET" },
  kasKedua: { kode: "1.1.02", nama: "Bank Operasional TJSL", tipe: "ASET", saldoNormal: "D", isKas: true, klasifikasi: "ASET" },
  piutangPokok: { kode: "1.1.03", nama: "Piutang Pinjaman Mitra Binaan", tipe: "ASET", saldoNormal: "D", klasifikasi: "ASET" },
  piutangJasa: { kode: "1.1.04", nama: "Piutang Jasa Administrasi", tipe: "ASET", saldoNormal: "D", klasifikasi: "ASET" },
  // Contra asset, spec 6.4 note: normal balance CREDIT on an ASSET account,
  // presented as a deduction from gross receivables (baris_laporan.tanda = -1).
  penyisihan: {
    kode: "1.1.05",
    nama: "Penyisihan Penurunan Nilai Piutang",
    tipe: "ASET",
    saldoNormal: "K",
    isKontra: true,
    klasifikasi: "PENYISIHAN_KONTRA",
  },
  piutangAlternatif: { kode: "1.1.06", nama: "Piutang Pinjaman Mitra Binaan (Alternatif)", tipe: "ASET", saldoNormal: "D", klasifikasi: "ASET" },
  kelebihanAngsuran: { kode: "2.1.01", nama: "Kelebihan Pembayaran Angsuran", tipe: "LIABILITAS", saldoNormal: "K", klasifikasi: "LIABILITAS" },
  angsuranBelumTeridentifikasi: { kode: "2.1.02", nama: "Angsuran Belum Teridentifikasi", tipe: "LIABILITAS", saldoNormal: "K", klasifikasi: "LIABILITAS" },
  pendapatanAlokasi: { kode: "4.1.01", nama: "Pendapatan Alokasi Dana BUMN Pembina", tipe: "PENDAPATAN", saldoNormal: "K", klasifikasi: "PENDAPATAN" },
  pendapatanJasaAdm: { kode: "4.1.02", nama: "Pendapatan Jasa Administrasi Pinjaman", tipe: "PENDAPATAN", saldoNormal: "K", klasifikasi: "PENDAPATAN" },
  pendapatanJasaGiro: { kode: "4.1.03", nama: "Pendapatan Bunga Jasa Giro", tipe: "PENDAPATAN", saldoNormal: "K", klasifikasi: "PENDAPATAN" },
  pendapatanLain: { kode: "4.1.04", nama: "Pendapatan Lain lain", tipe: "PENDAPATAN", saldoNormal: "K", klasifikasi: "PENDAPATAN" },
  bebanPenyisihan: { kode: "5.1.01", nama: "Beban Penyisihan Penurunan Nilai Piutang", tipe: "BEBAN", saldoNormal: "D", klasifikasi: "BEBAN" },
  bebanPinbuk: { kode: "5.1.02", nama: "Beban Pembinaan Kemitraan", tipe: "BEBAN", saldoNormal: "D", klasifikasi: "BEBAN" },
  bebanNonPumk: { kode: "5.1.03", nama: "Beban Penyaluran Non PUMK", tipe: "BEBAN", saldoNormal: "D", klasifikasi: "BEBAN" },
  bebanOperasional: { kode: "5.1.04", nama: "Beban Operasional", tipe: "BEBAN", saldoNormal: "D", klasifikasi: "BEBAN" },
  bebanNonAktif: { kode: "5.1.09", nama: "Beban Program Lama (nonaktif)", tipe: "BEBAN", saldoNormal: "D", aktif: false, klasifikasi: "BEBAN" },
};

export type KunciAkun = keyof typeof DEF_AKUN;

/**
 * Spec 6.4, transcribed. `debit`/`kredit` name a key of DEF_AKUN, or null when
 * the leg is resolved at runtime from the payload (`PENYALURAN_NON_PUMK`
 * debits a per-bidang expense account, `BEBAN_OPERASIONAL` a per-type one;
 * migrations/0010_jurnal.sql calls this out explicitly).
 *
 * The spec 6.4 table has NINETEEN rows, not twenty. Counted and listed here in
 * full so the discrepancy is visible in the fixture rather than hidden in a
 * loop bound; see the report note on `HAPUS_TAGIH_PIUTANG`, which
 * docs/BUILD-PLAN.md says is a separate event that regulation requires but the
 * spec does not name, and which is therefore NOT invented here.
 */
export const KATALOG_EVENT_6_4: ReadonlyArray<{
  code: string;
  debit: KunciAkun | null;
  kredit: KunciAkun | null;
  jenis: JenisJurnal;
}> = [
  { code: "ALOKASI_DANA_BUMN_PEMBINA", debit: "kas", kredit: "pendapatanAlokasi", jenis: "OTOMATIS" },
  { code: "PENCAIRAN_PUMK", debit: "piutangPokok", kredit: "kas", jenis: "OTOMATIS" },
  { code: "ANGSURAN_POKOK", debit: "kas", kredit: "piutangPokok", jenis: "OTOMATIS" },
  { code: "ANGSURAN_JASA_ADM", debit: "kas", kredit: "pendapatanJasaAdm", jenis: "OTOMATIS" },
  { code: "ANGSURAN_JASA_ADM_AKRUAL", debit: "kas", kredit: "piutangJasa", jenis: "OTOMATIS" },
  { code: "TERIMA_KELEBIHAN_ANGSURAN", debit: "kas", kredit: "kelebihanAngsuran", jenis: "OTOMATIS" },
  { code: "KEMBALIKAN_KELEBIHAN_ANGSURAN", debit: "kelebihanAngsuran", kredit: "kas", jenis: "OTOMATIS" },
  { code: "TERIMA_ANGSURAN_BELUM_TERIDENTIFIKASI", debit: "kas", kredit: "angsuranBelumTeridentifikasi", jenis: "OTOMATIS" },
  { code: "IDENTIFIKASI_ANGSURAN", debit: "angsuranBelumTeridentifikasi", kredit: "piutangPokok", jenis: "OTOMATIS" },
  { code: "PENYALURAN_NON_PUMK", debit: null, kredit: "kas", jenis: "OTOMATIS" },
  { code: "PENGEMBALIAN_SISA_NON_PUMK", debit: "kas", kredit: "bebanNonPumk", jenis: "OTOMATIS" },
  { code: "PENYALURAN_PINBUK", debit: "bebanPinbuk", kredit: "kas", jenis: "PINBUK" },
  { code: "AKRUAL_JASA_ADM", debit: "piutangJasa", kredit: "pendapatanJasaAdm", jenis: "AKRUAL" },
  { code: "BEBAN_PENYISIHAN", debit: "bebanPenyisihan", kredit: "penyisihan", jenis: "PENYISIHAN" },
  { code: "PEMULIHAN_PENYISIHAN", debit: "penyisihan", kredit: "bebanPenyisihan", jenis: "PENYISIHAN" },
  { code: "HAPUS_BUKU_PIUTANG", debit: "penyisihan", kredit: "piutangPokok", jenis: "OTOMATIS" },
  { code: "PENERIMAAN_HAPUS_BUKU", debit: "kas", kredit: "pendapatanLain", jenis: "OTOMATIS" },
  { code: "PENDAPATAN_JASA_GIRO", debit: "kas", kredit: "pendapatanJasaGiro", jenis: "OTOMATIS" },
  { code: "BEBAN_OPERASIONAL", debit: null, kredit: "kas", jenis: "OTOMATIS" },
];

/**
 * Pinbuk activity categories (spec 6.5). Seeded into `konfigurasi`, NOT
 * hardcoded in the engine, so the tests can prove the list is configuration by
 * editing the row. Spec 5's preamble makes every value in it a default
 * awaiting client confirmation.
 */
export const KATEGORI_PINBUK_AWAL = [
  "PELATIHAN",
  "PAMERAN",
  "SERTIFIKASI",
  "PENDAMPINGAN",
  "BANTUAN_SARANA",
];

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface Periode {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
}

export interface AkunFixture {
  id: string;
  kode: string;
  nama: string;
  tipe: TipeAkun;
  saldoNormal: "D" | "K";
  isKas: boolean;
  isKontra: boolean;
  klasifikasi: string;
}

export interface DuniaJurnal {
  db: PortUji;
  bumnId: string;
  cabangId: string;
  /** A second branch in the same bumn, for the branch-scope validation (6.2.7). */
  cabangLainId: string;
  /** Earlier OPEN period. `tutupPeriode(dunia.periodeAwal)` closes it. */
  periodeAwal: Periode;
  /** Later OPEN period; the "current open period" a reversal must land in. */
  periodeKini: Periode;
  /** A date inside `periodeKini`, and what the injected clock returns. */
  tanggalKini: string;
  /** A date inside `periodeAwal`. */
  tanggalAwal: string;
  jam: () => Date;
  akun: Record<KunciAkun, AkunFixture>;
  /** Non-postable header account, for validation 6.2.6. */
  akunHeaderId: string;
  sektorId: string;
  mitraId: string;
  clusterId: string;
  akadId: string;
  bidangNonPumkId: string;
  ctx: {
    maker: JurnalContext;
    checker: JurnalContext;
    approver: JurnalContext;
    /** Read-only: has no journal permission at all. */
    auditor: JurnalContext;
    /** Approver of another branch, for the scope validation. */
    approverCabangLain: JurnalContext;
  };
  tutupPeriode(periode: Periode): Promise<void>;
  setelKategoriPinbuk(kategori: string[]): Promise<void>;
  gantiAkunMapping(eventCode: string, kolom: "akun_debit_id" | "akun_kredit_id", akunId: string): Promise<void>;
  tutup(): Promise<void>;
}

async function satu<T>(db: JurnalTx, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) throw new Error(`fixture: query tidak mengembalikan baris: ${sql}`);
  return baris[0];
}

/**
 * Builds a minimal but complete world: one bumn, two branches, two OPEN
 * monthly periods, the full spec 6.4 chart of accounts (including a cash
 * account and the contra-asset), one mitra + cluster + akad for the piutang
 * sub-ledger, all 19 event mappings, the Pinbuk category configuration, and
 * four users with distinct permission sets.
 *
 * Composable on purpose: later phases (angsuran, closing) can call this and
 * add their own rows on top without touching this file.
 */
export async function buatDunia(): Promise<DuniaJurnal> {
  const db = buatPortDb();

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1) returning id`,
    [kunci("BUMN"), "PT Krakatau Steel (fixture)"],
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

  async function buatUser(nama: string): Promise<string> {
    const u = await satu<{ id: string }>(
      db,
      `insert into app_user (cabang_id, nama, email, username, password_hash)
       values ($1, $2, $3, $4, 'x-not-a-real-hash') returning id`,
      [cabang.id, nama, `${kunci("mail")}@example.test`, kunci("user")],
    );
    return u.id;
  }
  const maker = await buatUser("Maker (fixture)");
  const checker = await buatUser("Checker (fixture)");
  const approver = await buatUser("Approver (fixture)");
  const auditor = await buatUser("Auditor (fixture)");
  const approverLain = await satu<{ id: string }>(
    db,
    `insert into app_user (cabang_id, nama, email, username, password_hash)
     values ($1, $2, $3, $4, 'x-not-a-real-hash') returning id`,
    [cabangLain.id, "Approver Cabang Lain (fixture)", `${kunci("mail")}@example.test`, kunci("user")],
  );

  // RBAC rows, so the world matches how the app will really resolve
  // permissions later. `permission.kode` is unique GLOBALLY (not per bumn), so
  // the insert is idempotent across worlds and runs.
  const kodePermission = Object.values({
    BUAT: "jurnal.create",
    UBAH: "jurnal.update",
    VERIFIKASI: "jurnal.verify",
    POSTING: "jurnal.post",
    HAPUS: "jurnal.delete",
    // Reversal is a right of its own (see PERMISSION_JURNAL.REVERSAL), and the
    // shipped APPROVER role in modules/auth holds it alongside jurnal.post.
    // Granting it here keeps this fixture's Approver a faithful stand-in for
    // that role; the refusal cases still use Maker, who holds neither.
    REVERSAL: "jurnal.reversal",
  });
  for (const kode of kodePermission) {
    await db.query(
      `insert into permission (kode, grup, deskripsi) values ($1, 'jurnal', $1)
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
    // array as a bare comma-joined string, which `text[]` rejects, and a
    // hand-built `{a,b}` literal is a quoting bug waiting to happen.
    for (const kode of permissions) {
      await db.query(
        `insert into role_permission (role_id, permission_id)
         select $1, p.id from permission p where p.kode = $2`,
        [role.id, kode],
      );
    }
    await db.query(`insert into user_role (user_id, role_id) values ($1, $2)`, [userId, role.id]);
  }
  await buatRole("Maker", ["jurnal.create", "jurnal.update", "jurnal.delete"], maker);
  await buatRole("Checker", ["jurnal.verify"], checker);
  await buatRole(
    "Approver",
    ["jurnal.create", "jurnal.update", "jurnal.post", "jurnal.delete", "jurnal.reversal"],
    approver,
  );
  await buatRole("Auditor", [], auditor);
  await buatRole(
    "ApproverLain",
    ["jurnal.create", "jurnal.update", "jurnal.post", "jurnal.delete", "jurnal.reversal"],
    approverLain.id,
  );

  // Two consecutive OPEN months. `periodeAwal` is the earliest period of this
  // bumn, which is what makes `tutupPeriode(periodeAwal)` legal: invariant 6
  // (sequential close) has nothing earlier to complain about.
  async function buatPeriode(tahun: number, bulan: number): Promise<Periode> {
    const mulai = `${tahun}-${String(bulan).padStart(2, "0")}-01`;
    const akhirDate = new Date(Date.UTC(tahun, bulan, 0));
    const akhir = akhirDate.toISOString().slice(0, 10);
    const p = await satu<{ id: string }>(
      db,
      `insert into periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
       values ($1, $2, $3, $4, $5, 'OPEN') returning id`,
      [bumn.id, tahun, bulan, mulai, akhir],
    );
    return { id: p.id, tahun, bulan, tanggalMulai: mulai, tanggalAkhir: akhir };
  }
  const periodeAwal = await buatPeriode(2026, 1);
  const periodeKini = await buatPeriode(2026, 2);

  // Report layout rows. `akun.klasifikasi_laporan` is a real composite FK into
  // this table (migrations/0005_coa.sql), so they must exist first. `tanda`
  // -1 on PENYISIHAN_KONTRA is what makes the contra-asset present as a
  // deduction from gross receivables (spec 6.4 note).
  const barisLaporan: Array<[string, string, string, number, number]> = [
    ["ASET", "Aset", "POSISI_KEUANGAN", 10, 1],
    ["PENYISIHAN_KONTRA", "Penyisihan Penurunan Nilai Piutang", "POSISI_KEUANGAN", 20, -1],
    ["LIABILITAS", "Liabilitas", "POSISI_KEUANGAN", 30, 1],
    ["ASET_NETO", "Aset Neto", "POSISI_KEUANGAN", 40, 1],
    ["PENDAPATAN", "Pendapatan", "AKTIVITAS", 10, 1],
    ["BEBAN", "Beban", "AKTIVITAS", 20, 1],
  ];
  for (const [kode, nama, laporan, urutan, tanda] of barisLaporan) {
    await db.query(
      `insert into baris_laporan (bumn_id, laporan, kode, nama, urutan, level, tipe_baris, tanda, seksi)
       values ($1, $2, $3, $4, $5, 1, 'DETAIL', $6, $2)`,
      [bumn.id, laporan, kode, nama, urutan, tanda],
    );
  }

  // Level-1 header accounts: non-postable by construction, which is exactly
  // what validation 6.2.6 needs something to point at.
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
      `insert into akun (bumn_id, kode, nama, level, tipe, saldo_normal, is_postable, klasifikasi_laporan)
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
          is_postable, is_kas, is_kontra, aktif, klasifikasi_laporan)
       values ($1, $2, $3, $4, 2, $5, $6, true, $7, $8, $9, $10) returning id`,
      [
        bumn.id,
        def.kode,
        def.nama,
        header[def.tipe],
        def.tipe,
        def.saldoNormal,
        def.isKas ?? false,
        def.isKontra ?? false,
        def.aktif ?? true,
        def.klasifikasi,
      ],
    );
    akun[kunciAkun] = {
      id: a.id,
      kode: def.kode,
      nama: def.nama,
      tipe: def.tipe,
      saldoNormal: def.saldoNormal,
      isKas: def.isKas ?? false,
      isKontra: def.isKontra ?? false,
      klasifikasi: def.klasifikasi,
    };
  }

  const sektor = await satu<{ id: string }>(
    db,
    `insert into sektor_pumk (bumn_id, kode, nama) values ($1, $2, 'Perdagangan (fixture)') returning id`,
    [bumn.id, kunci("SEK")],
  );
  const bidang = await satu<{ id: string }>(
    db,
    `insert into bidang_non_pumk (bumn_id, kode, nama) values ($1, $2, 'Pendidikan (fixture)') returning id`,
    [bumn.id, kunci("BID")],
  );
  const cluster = await satu<{ id: string }>(
    db,
    `insert into cluster (cabang_id, kode, nama, sektor_id) values ($1, $2, 'Cluster Fixture', $3) returning id`,
    [cabang.id, kunci("CLS"), sektor.id],
  );
  const mitra = await satu<{ id: string }>(
    db,
    `insert into mitra (cabang_id, kode_mitra, nama_lengkap, sektor_id, cluster_id, status)
     values ($1, $2, 'Mitra Fixture', $3, $4, 'AKTIF') returning id`,
    [cabang.id, kunci("MTR"), sektor.id, cluster.id],
  );
  const proposal = await satu<{ id: string }>(
    db,
    `insert into pumk_proposal
       (cabang_id, no_proposal, tanggal_proposal, mitra_id, sektor_id, jumlah_diajukan, tenor_diajukan, status)
     values ($1, $2, $3, $4, $5, 50000000.00, 24, 'DICAIRKAN') returning id`,
    [cabang.id, kunci("PRP"), periodeAwal.tanggalMulai, mitra.id, sektor.id],
  );
  // jasa_adm_rate is stored, not asserted on: docs/REGULASI.md found the
  // spec's 3 percent FLAT is one reading of PER-1/MBU/03/2023, not settled
  // law, so no journal test may treat it as a fixed expectation.
  const akad = await satu<{ id: string }>(
    db,
    `insert into pumk_akad
       (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman, jasa_adm_rate,
        metode_perhitungan, tenor_bulan, tanggal_mulai_angsuran, tanggal_jatuh_tempo_akhir, status)
     values ($1, $2, $3, $4, $5, 50000000.00, 0.030000, 'FLAT', 24, $6, $7, 'BELUM_CAIR') returning id`,
    [
      proposal.id,
      mitra.id,
      cabang.id,
      kunci("AKD"),
      periodeAwal.tanggalMulai,
      periodeKini.tanggalMulai,
      "2028-02-01",
    ],
  );

  // Spec 6.4 mapping rows: the accounts behind every automatic journal live
  // HERE, as data (ADR 0004), which is what the event tests prove.
  for (const ev of KATALOG_EVENT_6_4) {
    await db.query(
      `insert into event_jurnal_mapping
         (bumn_id, event_code, deskripsi, akun_debit_id, akun_kredit_id,
          debit_dari_payload, kredit_dari_payload, jenis_jurnal, aktif)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [
        bumn.id,
        ev.code,
        `${ev.code} (fixture)`,
        ev.debit ? akun[ev.debit].id : null,
        ev.kredit ? akun[ev.kredit].id : null,
        ev.debit === null,
        ev.kredit === null,
        ev.jenis,
      ],
    );
  }

  await db.query(
    `insert into konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, deskripsi, perlu_konfirmasi)
     values ($1, $2, $3, $4, 'JSON', 'Kategori kegiatan Pinbuk (spec 6.5), default menunggu konfirmasi klien', true)`,
    [
      bumn.id,
      KUNCI_KONFIGURASI.KATEGORI_PINBUK.grup,
      KUNCI_KONFIGURASI.KATEGORI_PINBUK.kunci,
      JSON.stringify(KATEGORI_PINBUK_AWAL),
    ],
  );

  const tanggalKini = `${periodeKini.tahun}-${String(periodeKini.bulan).padStart(2, "0")}-10`;
  const tanggalAwal = `${periodeAwal.tahun}-${String(periodeAwal.bulan).padStart(2, "0")}-15`;
  const jam = () => new Date(`${tanggalKini}T04:00:00.000Z`);

  function ctxUntuk(userId: string, cabangId: string, permissions: string[]): JurnalContext {
    return { userId, cabangId, bumnId: bumn.id, permissions };
  }

  return {
    db,
    bumnId: bumn.id,
    cabangId: cabang.id,
    cabangLainId: cabangLain.id,
    periodeAwal,
    periodeKini,
    tanggalKini,
    tanggalAwal,
    jam,
    akun,
    akunHeaderId: header.ASET,
    sektorId: sektor.id,
    mitraId: mitra.id,
    clusterId: cluster.id,
    akadId: akad.id,
    bidangNonPumkId: bidang.id,
    ctx: {
      maker: ctxUntuk(maker, cabang.id, ["jurnal.create", "jurnal.update", "jurnal.delete"]),
      checker: ctxUntuk(checker, cabang.id, ["jurnal.verify"]),
      approver: ctxUntuk(approver, cabang.id, [
        "jurnal.create",
        "jurnal.update",
        "jurnal.post",
        "jurnal.delete",
        "jurnal.reversal",
      ]),
      auditor: ctxUntuk(auditor, cabang.id, []),
      approverCabangLain: ctxUntuk(approverLain.id, cabangLain.id, [
        "jurnal.create",
        "jurnal.update",
        "jurnal.post",
        "jurnal.delete",
        "jurnal.reversal",
      ]),
    },
    async tutupPeriode(periode: Periode): Promise<void> {
      // Direct SQL: the closing engine (spec 8) does not exist yet, and these
      // tests only need the CLOSED state, not the checklist that leads to it.
      await db.query(
        `update periode set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`,
        [periode.id, approver],
      );
    },
    async setelKategoriPinbuk(kategori: string[]): Promise<void> {
      await db.query(
        `update konfigurasi set nilai = $3, diubah_at = now()
         where bumn_id = $1 and grup = $2 and kunci = $4`,
        [
          bumn.id,
          KUNCI_KONFIGURASI.KATEGORI_PINBUK.grup,
          JSON.stringify(kategori),
          KUNCI_KONFIGURASI.KATEGORI_PINBUK.kunci,
        ],
      );
    },
    async gantiAkunMapping(eventCode, kolom, akunId): Promise<void> {
      await db.query(
        `update event_jurnal_mapping set ${kolom} = $3
         where bumn_id = $1 and event_code = $2 and aktif and deleted_at is null`,
        [bumn.id, eventCode, akunId],
      );
    },
    tutup: () => db.tutup(),
  };
}

// ---------------------------------------------------------------------------
// Assertions shared by the test files
// ---------------------------------------------------------------------------

/**
 * Fragments that mean a raw driver or trigger string has leaked into a
 * user-facing message. The engine wraps DB failures in `JurnalError` with a
 * clean Indonesian message and keeps the raw text in `penyebabDb`; that
 * separation is precisely what the spec 6.2 tests are checking.
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
  kode: KodeJurnal,
): Promise<JurnalError> {
  let ditangkap: unknown;
  try {
    await janji;
  } catch (e) {
    ditangkap = e;
  }
  if (ditangkap === undefined) {
    throw new Error(`diharapkan ditolak dengan ${kode}, tapi operasi berhasil`);
  }
  expect(ditangkap).toBeInstanceOf(JurnalError);
  const err = ditangkap as JurnalError;
  expect(err.kode).toBe(kode);
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.message).not.toMatch(POLA_KEBOCORAN_DB);
  return err;
}

/** Sanity: every code used by the tests exists in the contract's catalogue. */
export function kodeAda(kode: KodeJurnal): KodeJurnal {
  expect(Object.values(KODE_JURNAL)).toContain(kode);
  return kode;
}

/**
 * Spec 6.6.10 / spec 8.4 check 7: `SUM(debit) - SUM(kredit)` across the WHOLE
 * ledger, computed from the lines and never from the header total columns.
 * REVERSED journals stay in the sum: their lines are still in the ledger and
 * are offset by their reversal, which is the whole point of a reversal.
 */
export async function selisihLedger(db: JurnalTx): Promise<Uang> {
  const baris = await satu<{ selisih: string }>(
    db,
    `select coalesce(sum(b.debit) - sum(b.kredit), 0)::numeric(20,2)::text as selisih
       from jurnal_baris b
       join jurnal j on j.id = b.jurnal_id
      where j.status in ('POSTED', 'REVERSED')
        and j.deleted_at is null
        and b.deleted_at is null`,
  );
  return baris.selisih;
}

/** Reads a journal straight from the tables, bypassing the engine's own mapping. */
export async function bacaJurnalDb(
  db: JurnalTx,
  id: string,
): Promise<{
  id: string;
  no_jurnal: string;
  jenis: string;
  status: string;
  tanggal_transaksi: string;
  periode_id: string;
  keterangan: string | null;
  total_debit: string;
  total_kredit: string;
  version: number;
  deleted_at: string | null;
  posted_by: string | null;
  verified_by: string | null;
  reversal_of_jurnal_id: string | null;
  reversed_by_jurnal_id: string | null;
} | null> {
  const baris = await db.query<never>(
    `select id, no_jurnal, jenis, status, tanggal_transaksi::text as tanggal_transaksi,
            periode_id, keterangan, total_debit::text as total_debit,
            total_kredit::text as total_kredit, version, deleted_at::text as deleted_at,
            posted_by, verified_by, reversal_of_jurnal_id, reversed_by_jurnal_id
       from jurnal where id = $1`,
    [id],
  );
  return (baris[0] as never) ?? null;
}

/** Reads a journal's lines straight from the tables, ordered as stored. */
export async function bacaBarisDb(
  db: JurnalTx,
  jurnalId: string,
): Promise<
  Array<{
    urutan: number;
    akun_id: string;
    debit: string;
    kredit: string;
    mitra_id: string | null;
    akad_id: string | null;
    dimensi_json: Record<string, unknown>;
  }>
> {
  return db.query(
    `select urutan, akun_id, debit::text as debit, kredit::text as kredit,
            mitra_id, akad_id, dimensi_json
       from jurnal_baris
      where jurnal_id = $1 and deleted_at is null
      order by urutan`,
    [jurnalId],
  );
}
