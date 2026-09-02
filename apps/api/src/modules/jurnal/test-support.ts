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
// Chart of accounts and event catalogue: ONE SOURCE, SHARED WITH THE SEED
// ---------------------------------------------------------------------------
//
// This file used to carry its own copy of the accounts and of the 19 event
// mappings. Two copies of an event-to-account mapping do not fail as a red
// test when they drift: they fail as a journal posted to the wrong account in
// production while the fixture keeps agreeing with itself. Adding the owner's
// three new events to two catalogues would have been exactly that. So the
// world is now built by `seedCoaDanEventMapping`, the same function
// `seedFase0` runs against a real database, and the ids are read back BY CODE.
//
// What that buys, concretely: a mapping the seed gets wrong is now a failing
// journal test, and an account the seed forgets is a failing journal test.
//
// TWO ACCOUNTS ARE STILL DEFINED HERE, and deliberately are not in the seed:
// an alternative receivable and a DEACTIVATED expense account. Both exist only
// to be pointed at by a validation test (6.2.6 needs an inactive account to
// reject, 6.2.8 needs a second receivable to repoint a mapping at). Seeding a
// "Beban Program Lama (nonaktif)" into a client's chart of accounts to satisfy
// a test would be putting test scaffolding into production data.
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { KATALOG_EVENT_JURNAL } from "../../seed/event-jurnal";
// Same reasoning one level up: the capability switches that have no migration
// (among them akuntansi.kekurangan_penyisihan_hapus_buku, which decides what a
// write-off does with a shortfall) are seeded by the function `seedFase0`
// runs, not restated here. A fixture carrying its own copy of a default is a
// fixture that keeps passing after the real default changes.
import { seedKonfigurasiTambahan } from "../../seed/konfigurasi";

type TipeAkun = "ASET" | "LIABILITAS" | "ASET_NETO" | "PENDAPATAN" | "BEBAN";

/**
 * Friendly fixture name -> account CODE in the seeded chart of accounts. The
 * tests read `d.akun.piutangPokok.id`; the code is what ties that name to the
 * one definition in apps/api/src/seed/coa-inti.ts.
 */
const KODE_AKUN = {
  kas: "1.1.01",
  kasKedua: "1.1.02",
  piutangPokok: "1.1.03",
  piutangJasa: "1.1.04",
  penyisihan: "1.1.05",
  /** Fixture-only, see the file header. */
  piutangAlternatif: "1.1.06",
  kelebihanAngsuran: "2.1.01",
  angsuranBelumTeridentifikasi: "2.1.02",
  pendapatanAlokasi: "4.1.01",
  pendapatanJasaAdm: "4.1.02",
  pendapatanJasaGiro: "4.1.03",
  pendapatanLain: "4.1.04",
  bebanPenyisihan: "5.1.01",
  bebanPinbuk: "5.1.02",
  bebanNonPumk: "5.1.03",
  bebanOperasional: "5.1.04",
  /** Fixture-only and INACTIVE, so validation 6.2.6 has something to reject. */
  bebanNonAktif: "5.1.09",
} as const;

export type KunciAkun = keyof typeof KODE_AKUN;

/** The two accounts the production seed must not carry. See the file header. */
const AKUN_KHUSUS_FIXTURE: ReadonlyArray<{
  kode: string;
  nama: string;
  tipe: TipeAkun;
  saldoNormal: "D" | "K";
  parentKode: string;
  klasifikasi: string;
  aktif: boolean;
}> = [
  {
    kode: "1.1.06",
    nama: "Piutang Pinjaman Mitra Binaan (Alternatif)",
    tipe: "ASET",
    saldoNormal: "D",
    parentKode: "1",
    klasifikasi: "ASET",
    aktif: true,
  },
  {
    kode: "5.1.09",
    nama: "Beban Program Lama (nonaktif)",
    tipe: "BEBAN",
    saldoNormal: "D",
    parentKode: "5",
    klasifikasi: "BEBAN",
    aktif: false,
  },
];

/**
 * The event catalogue the world is seeded with: spec 6.4's nineteen plus the
 * three the owner ruled on (docs/BUILD-PLAN.md, "Keputusan sementara"). Named
 * without a spec section number because it is no longer only the spec's:
 * apps/api/src/seed/event-jurnal.ts keeps the two groups separable through
 * `EVENT_SPEC_6_4` and `EVENT_KEPUTUSAN_PEMILIK`.
 *
 * Re-exported rather than copied. A test that wants "every event" iterates
 * this and therefore covers a new one the day it is seeded.
 */
export const KATALOG_EVENT: ReadonlyArray<{
  code: string;
  debitKode: string | null;
  kreditKode: string | null;
  jenis: JenisJurnal;
}> = KATALOG_EVENT_JURNAL;

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
  /**
   * Overrides `akuntansi.kekurangan_penyisihan_hapus_buku` FOR THIS WORLD's
   * bumn only. The shipped default is a global row (bumn_id NULL) seeded by
   * the same function the real seed runs, so a test that flips the policy must
   * not edit that row: every other world reads it too.
   */
  setelKebijakanKekurangan(nilai: "BEBAN_PERIODE" | "TOLAK"): Promise<void>;
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

  // The chart of accounts, its report lines, and every event mapping, from the
  // SAME function that seeds a real database (see the file header). Ids come
  // back keyed by account code.
  const { akun: idPerKode } = await seedCoaDanEventMapping(db, bumn.id);

  // The two fixture-only accounts. Level 2 under a seeded header, so the
  // hierarchy trigger is satisfied the same way the seed satisfies it.
  for (const def of AKUN_KHUSUS_FIXTURE) {
    const parentId = idPerKode.get(def.parentKode);
    if (!parentId) throw new Error(`fixture: header ${def.parentKode} tidak ada di hasil seed`);
    const a = await satu<{ id: string }>(
      db,
      `insert into akun
         (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal,
          is_postable, is_kas, is_kontra, aktif, klasifikasi_akun)
       values ($1, $2, $3, $4::uuid, 2, $5, $6, true, false, false, $7, $8) returning id`,
      [bumn.id, def.kode, def.nama, parentId, def.tipe, def.saldoNormal, def.aktif, def.klasifikasi],
    );
    idPerKode.set(def.kode, a.id);
  }

  // Read every account back by code. Reading rather than trusting the seed's
  // own return value means the flags the tests depend on (is_kas, is_kontra)
  // are the ones actually stored, not the ones intended.
  const barisAkun = await db.query<{
    kode: string;
    id: string;
    nama: string;
    tipe: TipeAkun;
    saldo_normal: "D" | "K";
    is_kas: boolean;
    is_kontra: boolean;
    klasifikasi_akun: string;
  }>(
    `select kode, id, nama, tipe, saldo_normal, is_kas, is_kontra, klasifikasi_akun
       from akun where bumn_id = $1 and deleted_at is null`,
    [bumn.id],
  );
  const akunPerKode = new Map(barisAkun.map((row) => [row.kode, row]));

  const akun = {} as Record<KunciAkun, AkunFixture>;
  for (const [kunciAkun, kode] of Object.entries(KODE_AKUN) as Array<[KunciAkun, string]>) {
    const row = akunPerKode.get(kode);
    if (!row) {
      throw new Error(
        `fixture: akun ${kode} (${kunciAkun}) tidak ada setelah seed. ` +
          "Kalau kode COA di apps/api/src/seed/coa-inti.ts berubah, perbarui KODE_AKUN di sini.",
      );
    }
    akun[kunciAkun] = {
      id: row.id,
      kode: row.kode,
      nama: row.nama,
      tipe: row.tipe,
      saldoNormal: row.saldo_normal,
      isKas: row.is_kas,
      isKontra: row.is_kontra,
      klasifikasi: row.klasifikasi_akun,
    };
  }

  const akunHeaderAset = akunPerKode.get("1");
  if (!akunHeaderAset) throw new Error("fixture: akun header 1 (ASET) tidak ada setelah seed");

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

  // The global (bumn_id NULL) capability defaults, from the real seed. The
  // insert is ON CONFLICT DO NOTHING on a NULLS NOT DISTINCT unique index, so
  // repeating it once per world is idempotent and worlds cannot fight over it.
  await seedKonfigurasiTambahan(db);

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
    akunHeaderId: akunHeaderAset.id,
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
    async setelKebijakanKekurangan(nilai): Promise<void> {
      await db.query(
        `insert into konfigurasi
           (bumn_id, grup, kunci, nilai, tipe_data, deskripsi, perlu_konfirmasi)
         values ($1, 'akuntansi', 'kekurangan_penyisihan_hapus_buku', $2, 'ENUM',
                 'Override per bumn (fixture)', true)
         on conflict (bumn_id, grup, kunci) where deleted_at is null
           do update set nilai = excluded.nilai, diubah_at = now()`,
        [bumn.id, nilai],
      );
    },
    async gantiAkunMapping(eventCode, kolom, akunId): Promise<void> {
      await db.query(
        `update event_jurnal_mapping set ${kolom} = $3
         where bumn_id = $1 and event_code = $2 and aktif and deleted_at is null`,
        [bumn.id, eventCode, akunId],
      );
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
