// apps/api/src/modules/laporan/test-support.ts
//
// Fixture builder for the core accounting reports (spec 10.3 reports 16 to 20,
// 22 and 23). NOT a *.test.ts file, so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// A report is a claim about what the database already contains, and almost
// everything these reports must respect lives inside Postgres:
//   - `v_ledger_baris` (migrations/0018) IS the definition of a live figure,
//     and the whole ADR 0010 hazard is a difference between two SQL
//     predicates. A fake repository cannot have that hazard, so a suite built
//     on one cannot test for it;
//   - `saldo_akun_periode` and its `saldo_akun_periode_identitas_ck`
//     (migrations/0011) ARE the frozen figures spec 10 requires a CLOSED
//     period to be read from;
//   - `baris_laporan`, `klasifikasi_akun`, `pemetaan_baris_laporan` and the
//     composite FK `akun.klasifikasi_akun -> klasifikasi_akun(bumn_id, kode)`
//     (migrations/0005, split by 0028) ARE the report layout, and "editing a
//     row changes the report with no deploy" is only testable against the real
//     tables;
//   - `akun.is_kas`, `akun.klasifikasi_arus_kas` and the
//     `akun_is_kas_hanya_aset_ck` CHECK ARE the definition of Kas Akhir.
// So every fixture below writes to `tjsl_test`, which tools/test-env.ts
// guarantees is where DATABASE_URL points during `bun test`.
//
// WHY THE LEDGER IS THE REAL ENGINE, WRAPPED, NEVER REPLACED
// modules/angsuran/test-support.ts records what the alternative cost: a pure
// double for the journal port hid two production-breaking defects behind
// sixteen green tests. THE RULE THAT CAME OUT OF IT: a double may stand in for
// a collaborator's FAILURE, never for its VALIDATION. This fixture never
// doubles the ledger at all. Every journal in the standard book below is
// composed and posted through the engine reached via `../jurnal/index`, so the
// balances these reports read are balances the rest of the system agrees
// exist, and the reversal in `bukuBerbalik()` is a real reversal with the real
// REVERSED / POSTED status pair that ADR 0010 turns on.
//
// WHY SO MUCH OF THIS RESEMBLES modules/closing/test-support.ts
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling
// module's internals, and that file is internal to modules/closing. The money
// helpers, the unique-key helper, the DB port and the leak-detecting
// `tolakDengan` are therefore re-declared here with the SAME semantics. Two
// rules follow: the shapes must not drift (a sen-level difference between two
// modules' `keSen` would be a real bug in a real ledger), and when a shared
// test-support package appears, this file collapses into it.
//
// THE COA, THE REPORT LINES, THE PERMISSIONS AND THE PARAMETER CATALOGUE ARE
// THE SHIPPED ONES. `seedCoaDanEventMapping`, `seedKonfigurasiTambahan` and
// `seedRbac` from apps/api/src/seed are called directly rather than re-typed,
// and every context's permission list comes from `permissionsForRole`, which
// READS the grant matrix out of the database. A fixture that hardcodes
// `permissions: ["laporan.view"]` asserts against its own opinion; that is how
// `jurnal.update` / `jurnal.delete` being grantable to nobody stayed invisible.
//
// WHAT THIS FIXTURE ADDS ON TOP OF THE SEED
// The shipped seed used to be short of four things for the accounting
// statements, all of which this fixture supplied for its own bumn:
//   1. no postable ASET_NETO account existed, only the level-1 header, so no
//      journal could ever touch net assets;
//   2. no `baris_laporan` row carried a section name a statement can group by:
//      the seed set `seksi = laporan`, i.e. 'POSISI_KEUANGAN' / 'AKTIVITAS';
//   3. `klasifikasi_arus_kas` was set only on the five 1.1.x accounts, so most
//      counter-accounts of a cash movement could not be classified;
//   4. there were no ARUS_KAS or PERUBAHAN_ASET_NETO template rows at all.
// ALL FOUR ARE NOW CLOSED IN apps/api/src/seed/coa-inti.ts. What this fixture
// still adds is its own, larger, world: the PSAK 45 style SPLIT of net assets
// into two categories (the seed ships one undivided category, because dividing
// it is the client's decision), the accounts that make each report's sections
// non-empty, and an inactive account so report 16 has a status to print.
// ./laporan-struktur-data.test.ts still pins each of the four states as a
// fail-closed refusal, reached by editing the rows rather than by relying on
// the seed being short, so an implementation can never invent a default.
//
// NO TEST MAY DEPEND ON ANOTHER TEST'S DATA. `bun run db:reset` is run
// periodically by other agents and nothing here is cleaned up afterwards, so
// every fixture key is uniquified per call via `kunci()` and every world gets
// its own bumn, branches, chart of accounts, report lines, periods and
// parameter rows. NOTHING HERE EVER MUTATES A GLOBAL (bumn_id IS NULL) ROW: a
// closing test once edited a global config row and poisoned every world built
// after it. TWO CONSECUTIVE RUNS WITHOUT A RESET THEREFORE PRODUCE IDENTICAL
// RESULTS, which ./laporan-fixture.test.ts demonstrates rather than assumes.
//
// THE SHARED DATABASE MAY BE BEHIND THE TREE. Nothing here touches a table or
// column newer than migrations/0018 (`v_ledger_baris`). In particular it does
// NOT read `penyisihan_periode_jurnal` (0026) or the accrual provenance
// columns (0025), so a world builds identically at 0024 and at 0026.
import { SQL } from "bun";
import { expect } from "bun:test";
import { createJurnalModule, type Jurnal, type JurnalContext } from "../jurnal/index";
import { createDbAdapter } from "../../core/adapters/db";
import { KATALOG, tipeDataUntuk } from "../konfigurasi/index";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { seedTemplateLaporan } from "../../seed/coa-inti";
import { seedKonfigurasiTambahan } from "../../seed/konfigurasi";
import { permissionsForRole, seedRbac } from "../../seed/rbac";
import {
  LaporanError,
  KODE_LAPORAN,
  NOL_TAMPIL,
  POLA_TAMPIL,
  POLA_UANG,
  createLaporanEngine,
  type Angka,
  type KlasifikasiArusKas,
  type KodeLaporan,
  type LaporanContext,
  type LaporanDbPort,
  type LaporanEngine,
  type LaporanTx,
  type TipeBaris,
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

/** Minor units (sen) -> `Uang`. Signed. */
export function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** `Uang` -> minor units. Rejects anything that is not exactly two decimals. */
export function keSen(nilai: Uang): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2]) * 100n + BigInt(m[3]);
  return m[1] === "-" ? -besar : besar;
}

export function jumlahUang(...nilai: Uang[]): Uang {
  return sen(nilai.reduce((t, n) => t + keSen(n), 0n));
}

export function kurangUang(a: Uang, b: Uang): Uang {
  return sen(keSen(a) - keSen(b));
}

export function negasiUang(a: Uang): Uang {
  return sen(-keSen(a));
}

export function nolUang(a: Uang): boolean {
  return keSen(a) === 0n;
}

// ---------------------------------------------------------------------------
// The formatting contract of spec 10, as a reference implementation
// ---------------------------------------------------------------------------

/**
 * `Uang` -> the string a report prints. THIS IS THE TEST'S STATEMENT OF THE
 * RULE, deliberately written here rather than imported from the module, so a
 * report that renders its own way is compared against the specification and
 * not against itself.
 *
 * spec 10: "Nilai nol ditampilkan sebagai `0,00` bukan kosong". Two decimals
 * with a comma, thousands grouped with a dot, negatives in parentheses.
 */
export function formatTampil(nilai: Uang): string {
  if (!POLA_UANG.test(nilai)) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const negatif = keSen(nilai) < 0n;
  const [utuh, pecahan] = (negatif ? nilai.slice(1) : nilai).split(".");
  const dikelompokkan = utuh.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const inti = `${dikelompokkan},${pecahan}`;
  return negatif ? `(${inti})` : inti;
}

/** The inverse of `formatTampil`, so a rendered cell can be read back. */
export function bacaTampil(tampil: string): Uang {
  if (!POLA_TAMPIL.test(tampil)) throw new Error(`bukan tampilan uang: ${JSON.stringify(tampil)}`);
  const negatif = tampil.startsWith("(");
  const inti = negatif ? tampil.slice(1, -1) : tampil;
  const [utuh, pecahan] = inti.split(",");
  return `${negatif ? "-" : ""}${utuh.replace(/\./g, "")}.${pecahan}`;
}

/**
 * Every assertion that matters about one rendered cell, in one place:
 *   - `nilai` is a valid two-decimal `Uang` (invariant 7);
 *   - `tampil` is never blank and never a dash;
 *   - `tampil` is exactly what the rule produces from `nilai`;
 *   - zero renders as `0,00` (spec 10), which is the whole point of the rule.
 */
export function angkaSah(a: Angka, jalur = "angka"): void {
  expect(a, `${jalur}: cell tidak ada`).toBeDefined();
  expect(a.nilai, `${jalur}.nilai`).toMatch(POLA_UANG);
  expect(a.tampil, `${jalur}.tampil kosong`).not.toBe("");
  expect(a.tampil, `${jalur}.tampil`).toBe(formatTampil(a.nilai));
  if (keSen(a.nilai) === 0n) expect(a.tampil, `${jalur}.tampil nol`).toBe(NOL_TAMPIL);
  expect(bacaTampil(a.tampil), `${jalur} round trip`).toBe(a.nilai);
}

/**
 * Walks any report result and yields every `Angka` in it with a dotted path.
 * Used to assert the zero rule AT THE REPORT BOUNDARY rather than on the two
 * or three cells a test happens to name, which is what "assert it at the
 * report boundary" means: no cell anywhere in the payload may be blank.
 */
export function setiapAngka(nilai: unknown, jalur = "$"): Array<[string, Angka]> {
  const keluar: Array<[string, Angka]> = [];
  const kunjungi = (n: unknown, j: string): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach((x, i) => kunjungi(x, `${j}[${i}]`));
      return;
    }
    const rec = n as Record<string, unknown>;
    if (typeof rec.nilai === "string" && typeof rec.tampil === "string") {
      keluar.push([j, rec as unknown as Angka]);
      return;
    }
    for (const [k, v] of Object.entries(rec)) kunjungi(v, `${j}.${k}`);
  };
  kunjungi(nilai, jalur);
  return keluar;
}

/**
 * Asserts every rendered cell in a whole report satisfies the spec 10 rule,
 * and returns how many it checked.
 *
 * THE PER-REPORT FLOOR EXISTS BECAUSE A WALKER THAT FOUND NOTHING WOULD PASS
 * SILENTLY. But one of the seven genuinely has no money in it: spec 10.3
 * report 16 (Bagan Akun) is a chart of accounts tree of code, name, type,
 * normal balance and status, and ./contract.ts declares no monetary field on
 * it. Widening that type to satisfy this helper would be the test dictating
 * the shape of a report, which is the move the contract forbids by name.
 *
 * `tanpaUang` IS AN OPT-OUT THAT ASSERTS THE OPPOSITE RATHER THAN SKIPPING.
 * A caller declaring a report figure-free must be right: if such a report ever
 * grows an `Angka`, this fails, so the flag cannot rot into a blanket
 * exemption that hides a real walker regression. That is why it is a flag here
 * rather than a hardcoded list of "the six statements" in the caller, which
 * would silently stop covering the seventh report somebody adds later.
 *
 * Non-vacuity for the suite as a whole is carried by the caller's aggregate
 * floor over the returned counts, which this does not weaken: a figure-free
 * report contributes 0 to it, as it should.
 */
export function semuaAngkaSah(
  laporan: unknown,
  jalur = "$",
  opsi: { tanpaUang?: boolean } = {},
): number {
  const semua = setiapAngka(laporan, jalur);
  if (opsi.tanpaUang) {
    expect(
      semua.map(([j]) => j),
      `${jalur}: dinyatakan tanpa kolom uang, tapi memuat Angka`,
    ).toEqual([]);
    return 0;
  }
  expect(semua.length, `${jalur}: laporan tanpa satu pun angka`).toBeGreaterThan(0);
  for (const [j, a] of semua) angkaSah(a, j);
  return semua.length;
}

// ---------------------------------------------------------------------------
// Unique keys and dates
// ---------------------------------------------------------------------------

const JEJAK = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
let urut = 0;

/**
 * A key unique across worlds, runs and parallel files. Every business key this
 * fixture writes goes through here, because `bun run db:reset` is NOT run
 * between files and several of these tables refuse a physical DELETE. This is
 * the whole reason two consecutive `bun test` runs without a reset produce the
 * same results instead of colliding on the second.
 */
export function kunci(awalan: string): string {
  urut += 1;
  return `${awalan}-${JEJAK}-${String(urut).padStart(4, "0")}`;
}

/** Adds whole days to an ISO date. UTC throughout, no local-time drift. */
export function tambahHari(iso: string, hari: number): string {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  const d = new Date(Date.UTC(t, b - 1, h));
  d.setUTCDate(d.getUTCDate() + hari);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The DB port
// ---------------------------------------------------------------------------

function urlDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test laporan butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!url.split("?")[0].endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture laporan di database non-test: ${url}`);
  }
  return url;
}

interface PortUji extends LaporanDbPort {
  tutup(): Promise<void>;
}

function buatPortDb(): PortUji {
  const sql = new SQL({ url: urlDb(), max: 6 });
  const bungkus = (jalankan: (t: string, p: unknown[]) => Promise<unknown>): LaporanTx => ({
    async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await jalankan(text, params)) as unknown as T[];
    },
  });
  return {
    query: bungkus((t, p) => sql.unsafe(t, p as never[])).query,
    async transaction<T>(jalankan: (tx: LaporanTx) => Promise<T>): Promise<T> {
      return (await sql.begin(async (tx) =>
        jalankan(bungkus((t, p) => tx.unsafe(t, p as never[]))),
      )) as T;
    },
    async tutup(): Promise<void> {
      await sql.close();
    },
  };
}

async function satu<T>(db: LaporanTx, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) throw new Error(`fixture: query tidak mengembalikan baris: ${sql}`);
  return baris[0];
}

/**
 * Adds a printed line AND the classification that reaches it, in one call.
 *
 * WHY THE TWO ARE ONE OPERATION HERE. Before migrations/0028 a line's `kode`
 * was simultaneously the printed line and the vocabulary an account was
 * classified with, so `insert into baris_laporan` was the whole of "add a line
 * an account can point at". 0028 split them, so the same intent is now three
 * rows: the classification, the line, and the `(template, klasifikasi,
 * laporan)` mapping between them.
 *
 * The classification's code is deliberately the SAME STRING as the line's,
 * which is the identity mapping 0028's own backfill writes. It is what lets
 * `petakanAkun(akunId, "ASET_TETAP")` keep meaning "put this account on the
 * ASET_TETAP line" without every caller learning about a second vocabulary.
 */
async function tambahBarisDanKlasifikasi(
  db: LaporanTx,
  bumnId: string,
  templateId: string,
  penulis: string,
  b: {
    kode: string;
    nama: string;
    laporan: string;
    urutan: number;
    level: number;
    tipeBaris: TipeBaris;
    tanda: 1 | -1;
    seksi: string | null;
    parentId?: string | null;
  },
): Promise<string> {
  await db.query(
    `insert into klasifikasi_akun (bumn_id, kode, nama, urutan, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (bumn_id, kode) do nothing`,
    [bumnId, b.kode, b.nama, b.urutan, penulis],
  );
  const baris = await satu<{ id: string }>(
    db,
    `insert into baris_laporan
       (bumn_id, template_id, laporan, kode, nama, parent_id, urutan, level, tipe_baris, tanda,
        seksi, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     returning id::text as id`,
    [
      bumnId,
      templateId,
      b.laporan,
      b.kode,
      b.nama,
      b.parentId ?? null,
      b.urutan,
      b.level,
      b.tipeBaris,
      b.tanda,
      b.seksi,
      penulis,
    ],
  );
  await db.query(
    `insert into pemetaan_baris_laporan
       (bumn_id, template_id, klasifikasi_id, baris_laporan_id, laporan, created_by, updated_by)
     select $1, $2, k.id, $3, $4, $6, $6
       from klasifikasi_akun k
      where k.bumn_id = $1 and k.kode = $5
     on conflict (template_id, klasifikasi_id, laporan) where deleted_at is null do nothing`,
    [bumnId, templateId, baris.id, b.laporan, b.kode, penulis],
  );
  return baris.id;
}

// ---------------------------------------------------------------------------
// Accounts, by the friendly name the tests use
// ---------------------------------------------------------------------------

/**
 * Codes from apps/api/src/seed/coa-inti.ts, which is also what seeds them,
 * plus the ones this fixture adds so every section of every statement has
 * something in it. `3.1.01` is now SHIPPED by the seed as one undivided
 * net-asset category; this fixture takes it over as the "tidak terikat" half
 * of the split, and adds `3.2.01` as the other (see the file header).
 *
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
  belumTeridentifikasi: "2.1.02",
  pendapatanAlokasi: "4.1.01",
  pendapatanJasaAdm: "4.1.02",
  pendapatanBungaGiro: "4.1.03",
  pendapatanLain: "4.1.04",
  bebanPenyisihan: "5.1.01",
  bebanPembinaan: "5.1.02",
  bebanNonPumk: "5.1.03",
  bebanOperasional: "5.1.04",
  // Added by this fixture, see BARIS_TAMBAHAN / AKUN_TAMBAHAN below.
  asetTetap: "1.2.01",
  asetNetoTidakTerikat: "3.1.01",
  asetNetoTerikat: "3.2.01",
  pendapatanTerikat: "4.1.05",
  bebanNonaktif: "5.1.09",
} as const;

export type KunciAkun = keyof typeof KODE_AKUN;

export interface AkunFixture {
  id: string;
  kode: string;
  nama: string;
}

/** `baris_laporan.kode` values the fixture's world uses. */
export const KODE_BARIS = {
  aset: "ASET",
  penyisihanKontra: "PENYISIHAN_KONTRA",
  liabilitas: "LIABILITAS",
  asetNeto: "ASET_NETO",
  asetNetoTidakTerikat: "ASET_NETO_TIDAK_TERIKAT",
  asetNetoTerikat: "ASET_NETO_TERIKAT_TEMPORER",
  pendapatan: "PENDAPATAN",
  beban: "BEBAN",
  pendapatanTerikat: "PENDAPATAN_TERIKAT",
} as const;

/** The section names the statements group by. See the file header, finding 2. */
export const SEKSI = {
  aset: "ASET",
  liabilitas: "LIABILITAS",
  asetNeto: "ASET_NETO",
  tidakTerikat: KODE_BARIS.asetNetoTidakTerikat,
  terikat: KODE_BARIS.asetNetoTerikat,
} as const;

/**
 * `baris_laporan` rows this fixture adds, each with the classification that
 * reaches it. The seed ships ONE undivided net-asset category, because
 * splitting it is the client's decision; these are the two halves of the
 * PSAK 45 split the specification's own scenarios are written in.
 *
 * NOT A CLAIM THAT THESE ARE THE RIGHT CAPTIONS. docs/REGULASI.md finding 1
 * records that the specification's PSAK 45 wording ("Tidak Terikat", "Terikat
 * Temporer") was superseded by ISAK 335 ("tanpa pembatasan", "dengan
 * pembatasan") and that the choice belongs to the client's accounting team.
 * These are fixture values chosen because the specification's own scenarios
 * are written in them. No test asserts either wording is correct; every test
 * asserts that changing the row changes the report.
 */
const BARIS_TAMBAHAN: ReadonlyArray<{
  kode: string;
  nama: string;
  laporan: "POSISI_KEUANGAN" | "AKTIVITAS" | "ARUS_KAS" | "PERUBAHAN_ASET_NETO";
  urutan: number;
  tipeBaris: TipeBaris;
  tanda: 1 | -1;
  seksi: string;
  /** Nests under a line the seed already ships. */
  parentKode?: string;
  level?: number;
}> = [
  {
    kode: KODE_BARIS.asetNetoTidakTerikat,
    nama: "Aset Neto Tidak Terikat",
    laporan: "POSISI_KEUANGAN",
    urutan: 41,
    tipeBaris: "DETAIL",
    tanda: 1,
    seksi: SEKSI.asetNeto,
    parentKode: KODE_BARIS.asetNeto,
    level: 2,
  },
  {
    kode: KODE_BARIS.asetNetoTerikat,
    nama: "Aset Neto Terikat Temporer",
    laporan: "POSISI_KEUANGAN",
    urutan: 42,
    tipeBaris: "DETAIL",
    tanda: 1,
    seksi: SEKSI.asetNeto,
    parentKode: KODE_BARIS.asetNeto,
    level: 2,
  },
  {
    kode: KODE_BARIS.pendapatanTerikat,
    nama: "Penerimaan Sumbangan Terikat",
    laporan: "AKTIVITAS",
    urutan: 15,
    tipeBaris: "DETAIL",
    tanda: 1,
    seksi: SEKSI.terikat,
  },
];

/**
 * `seksi` re-pointing on the SHIPPED rows. The seed now writes real section
 * names (finding 2, closed), but it writes the ONE net-asset category it
 * ships; this world has two, so the revenue and expense lines have to name the
 * half they belong to. ./laporan-struktur-data.test.ts still pins the
 * uncorrected state as a refusal, by writing `seksi = 'AKTIVITAS'` itself, so
 * the gap cannot be forgotten.
 */
const SEKSI_BARIS_TERKIRIM: ReadonlyArray<[string, string]> = [
  [KODE_BARIS.aset, SEKSI.aset],
  [KODE_BARIS.penyisihanKontra, SEKSI.aset],
  [KODE_BARIS.liabilitas, SEKSI.liabilitas],
  [KODE_BARIS.asetNeto, SEKSI.asetNeto],
  [KODE_BARIS.pendapatan, SEKSI.tidakTerikat],
  [KODE_BARIS.beban, SEKSI.tidakTerikat],
];

/**
 * The shipped ASET_NETO line becomes the section CAPTION, with the two
 * categories nested under it.
 *
 * Not cosmetic. The seed makes it a DETAIL row and points the non-postable
 * level-1 account "3" at it, so it can never carry a balance; leaving it a
 * DETAIL row would make report 20 print a third category that is permanently
 * zero, and would hide a report that lost a real category behind one that
 * legitimately has nothing in it. HEADER is what the row actually is.
 */
const BARIS_JADI_HEADER: readonly string[] = [KODE_BARIS.asetNeto];

/** Accounts this fixture adds. See the file header, findings 1 and 4. */
const AKUN_TAMBAHAN: ReadonlyArray<{
  kode: string;
  nama: string;
  tipe: "ASET" | "LIABILITAS" | "ASET_NETO" | "PENDAPATAN" | "BEBAN";
  saldoNormal: "D" | "K";
  parentKode: string;
  klasifikasi: string;
  arusKas: KlasifikasiArusKas | null;
  aktif: boolean;
}> = [
  {
    kode: KODE_AKUN.asetTetap,
    nama: "Aset Tetap",
    tipe: "ASET",
    saldoNormal: "D",
    parentKode: "1",
    klasifikasi: KODE_BARIS.aset,
    // The only INVESTASI counter-account in the world, so report 18's
    // investing section is non-zero and cannot pass by being empty.
    arusKas: "INVESTASI",
    aktif: true,
  },
  {
    // SHIPPED BY THE SEED under this exact code, as the single undivided
    // category "Aset Neto". This world splits the category in two, so the
    // seeded row is renamed and re-classified rather than duplicated.
    //
    // PENDANAAN, AND THE SEED'S REASON FOR LEAVING IT NULL DOES NOT APPLY HERE.
    // apps/api/src/seed/coa-inti.ts says a movement in net assets is "a
    // reclassification, not a cash movement, so claiming a section would put
    // money in Arus Kas that never touched cash". That is true of a net-asset
    // TO net-asset journal, and `klasifikasi_arus_kas` is never consulted for
    // one: it is read only when this account is the COUNTER-SIDE of a movement
    // on an `is_kas` account, i.e. only when cash did move. In this world that
    // happens exactly once, the opening funding of the unit in
    // ${TAHUN_LALU}-01, and money arriving from the parent BUMN as capital is a
    // FINANCING inflow by any reading of the direct method.
    //
    // Leaving it null is what made the classification-completeness check
    // unable to run over the comparative span at all, which is how a column of
    // this statement came to omit counter-accounts silently. See
    // ./laporan-arus-kas.test.ts.
    kode: KODE_AKUN.asetNetoTidakTerikat,
    nama: "Aset Neto Tidak Terikat",
    tipe: "ASET_NETO",
    saldoNormal: "K",
    parentKode: "3",
    klasifikasi: KODE_BARIS.asetNetoTidakTerikat,
    arusKas: "PENDANAAN",
    aktif: true,
  },
  {
    // Same reasoning as its unrestricted twin above. No journal in the
    // standard book puts cash opposite this one, so it classifies nothing
    // today; it carries the section so that a world which DOES fund the
    // restricted category in cash is not a refusal waiting to happen.
    kode: KODE_AKUN.asetNetoTerikat,
    nama: "Aset Neto Terikat Temporer",
    tipe: "ASET_NETO",
    saldoNormal: "K",
    parentKode: "3",
    klasifikasi: KODE_BARIS.asetNetoTerikat,
    arusKas: "PENDANAAN",
    aktif: true,
  },
  {
    kode: KODE_AKUN.pendapatanTerikat,
    nama: "Penerimaan Sumbangan Terikat",
    tipe: "PENDAPATAN",
    saldoNormal: "K",
    parentKode: "4",
    klasifikasi: KODE_BARIS.pendapatanTerikat,
    arusKas: "PENDANAAN",
    aktif: true,
  },
  {
    // Inactive on purpose: spec 10.3 report 16 asks for a `status` column, and
    // an account that has never been inactive cannot test it.
    kode: KODE_AKUN.bebanNonaktif,
    nama: "Beban Lain lain (nonaktif)",
    tipe: "BEBAN",
    saldoNormal: "D",
    parentKode: "5",
    klasifikasi: KODE_BARIS.beban,
    arusKas: "OPERASI",
    aktif: false,
  },
];

/**
 * `klasifikasi_arus_kas` on the counter-accounts of ordinary cash movements.
 * The seed now sets these itself (finding 3, closed); this restates the same
 * values so the fixture's world is stated in one place rather than half here
 * and half in the seed, and so a seed that regressed would be caught by the
 * report rather than by nothing.
 *
 * DELIBERATELY LEFT NULL: 1.1.05 Penyisihan and 5.1.01 Beban Penyisihan. Both
 * are non-cash by construction (the allowance journal never touches cash), so
 * a classification on them would be meaningless, and leaving them null proves
 * the report only demands one where a cash movement actually needs it.
 */
const ARUS_KAS_TERKIRIM: ReadonlyArray<[string, KlasifikasiArusKas]> = [
  [KODE_AKUN.kelebihanAngsuran, "OPERASI"],
  [KODE_AKUN.belumTeridentifikasi, "OPERASI"],
  [KODE_AKUN.pendapatanAlokasi, "OPERASI"],
  [KODE_AKUN.pendapatanJasaAdm, "OPERASI"],
  [KODE_AKUN.pendapatanBungaGiro, "OPERASI"],
  [KODE_AKUN.pendapatanLain, "OPERASI"],
  [KODE_AKUN.bebanPembinaan, "OPERASI"],
  [KODE_AKUN.bebanNonPumk, "OPERASI"],
  [KODE_AKUN.bebanOperasional, "OPERASI"],
];

// ---------------------------------------------------------------------------
// Configuration, scoped to the world's bumn
// ---------------------------------------------------------------------------

/**
 * Seeded per world with `bumn_id` set, so a world's values are its own and no
 * test can be perturbed by another agent editing the global (bumn_id NULL)
 * rows migrations/0004 ships. Every engine here resolves bumn-scoped over
 * global, which is what makes this work.
 *
 * Only the keys THIS module reads. `tahun_buku_mulai_bulan` decides the span
 * of Laporan Aktivitas and the cut-off of both comparative columns; the value
 * 1 is a FIXTURE VALUE, and ./laporan-struktur-data.test.ts changes it and
 * asserts the spans move, precisely so an implementation cannot hardcode
 * January.
 */
const KONFIGURASI_AWAL: ReadonlyArray<[string, string, string]> = [
  ["akuntansi", "tahun_buku_mulai_bulan", "1"],
];

// ---------------------------------------------------------------------------
// The world's calendar
// ---------------------------------------------------------------------------

/**
 * 2025-01 .. 2026-12. TWO YEARS, because reports 17 and 19 both require a
 * comparative column ("Kolom tahun ini dan tahun lalu bersebelahan") and a
 * one-year world would let a report pass the comparative test by returning
 * zero, which is exactly the vacuous pass this suite is required to avoid.
 */
export const TAHUN_LALU = 2025;
export const TAHUN_INI = 2026;

/** The period every headline test reports on. */
export const BULAN_LAPORAN = 3;

export interface PeriodeFixture {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
}

// ---------------------------------------------------------------------------
// The standard book
// ---------------------------------------------------------------------------

export interface BarisJurnalFixture {
  akun: KunciAkun;
  debit?: Uang;
  kredit?: Uang;
}

export interface JurnalFixture {
  tanggal: string;
  jenis: "UMUM" | "KAS_BANK";
  keterangan: string;
  /** Defaults to the world's main branch. */
  diCabangLain?: boolean;
  baris: BarisJurnalFixture[];
}

/**
 * THE LEDGER EVERY REPORT TEST READS.
 *
 * Chosen so that no assertion in this folder can pass vacuously:
 *   - Total Aset, Total Liabilitas and Aset Neto are each non-zero, so
 *     scenario 14's identity is a real test rather than 0 = 0 + 0;
 *   - the OPERASI, INVESTASI and PENDANAAN sections of report 18 are each
 *     non-zero, so scenario 15 cannot be satisfied by a statement that
 *     classifies nothing;
 *   - all six Neraca Lajur totals are non-zero for the reporting month, so
 *     scenario 16's three balance checks bite;
 *   - there is activity in BOTH years and in three different months of the
 *     current one, so the comparative columns and the "saldo awal" of reports
 *     22 and 23 are all non-zero;
 *   - there is a NON-CASH journal pair (allowance) so a cash-flow statement
 *     that simply mirrored the income statement would be wrong;
 *   - there is a journal in a SECOND BRANCH, so branch filtering has something
 *     to exclude, and it is self-balancing inside that branch so the balance
 *     sheet identity holds per-branch and for Semua Cabang alike.
 *
 * Everything is posted through the REAL journal engine, in date order, while
 * every period is still OPEN (invariant 5).
 */
export const BUKU_STANDAR: readonly JurnalFixture[] = [
  // --- 2025, the comparative year -----------------------------------------
  {
    tanggal: "2025-01-05",
    jenis: "UMUM",
    keterangan: "Saldo awal aset neto tidak terikat (fixture laporan)",
    baris: [
      { akun: "kas", debit: rp(1_000_000_000) },
      { akun: "asetNetoTidakTerikat", kredit: rp(1_000_000_000) },
    ],
  },
  {
    tanggal: "2025-03-10",
    jenis: "KAS_BANK",
    keterangan: "Alokasi dana dari BUMN Pembina (fixture laporan)",
    baris: [
      { akun: "kas", debit: rp(400_000_000) },
      { akun: "pendapatanAlokasi", kredit: rp(400_000_000) },
    ],
  },
  {
    tanggal: "2025-06-20",
    jenis: "KAS_BANK",
    keterangan: "Penyaluran pinjaman PUMK (fixture laporan)",
    baris: [
      { akun: "piutangPokok", debit: rp(250_000_000) },
      { akun: "kas", kredit: rp(250_000_000) },
    ],
  },
  {
    tanggal: "2025-09-15",
    jenis: "KAS_BANK",
    keterangan: "Penerimaan angsuran pokok dan jasa administrasi (fixture laporan)",
    baris: [
      { akun: "kas", debit: rp(60_000_000) },
      { akun: "piutangPokok", kredit: rp(55_000_000) },
      { akun: "pendapatanJasaAdm", kredit: rp(5_000_000) },
    ],
  },
  {
    tanggal: "2025-11-30",
    jenis: "KAS_BANK",
    keterangan: "Pembayaran beban operasional (fixture laporan)",
    baris: [
      { akun: "bebanOperasional", debit: rp(30_000_000) },
      { akun: "kas", kredit: rp(30_000_000) },
    ],
  },
  {
    // NON-CASH on purpose: touches neither an is_kas account nor a classified
    // counter-account, so it must appear in reports 17, 19, 22 and 23 and must
    // NOT appear anywhere in report 18.
    tanggal: "2025-12-20",
    jenis: "UMUM",
    keterangan: "Pembentukan penyisihan penurunan nilai piutang (fixture laporan)",
    baris: [
      { akun: "bebanPenyisihan", debit: rp(12_000_000) },
      { akun: "penyisihan", kredit: rp(12_000_000) },
    ],
  },

  // --- 2026, the reporting year -------------------------------------------
  {
    tanggal: "2026-01-08",
    jenis: "KAS_BANK",
    keterangan: "Alokasi dana dari BUMN Pembina (fixture laporan)",
    baris: [
      { akun: "kas", debit: rp(300_000_000) },
      { akun: "pendapatanAlokasi", kredit: rp(300_000_000) },
    ],
  },
  {
    tanggal: "2026-01-20",
    jenis: "KAS_BANK",
    keterangan: "Pembelian aset tetap (fixture laporan, arus kas INVESTASI)",
    baris: [
      { akun: "asetTetap", debit: rp(75_000_000) },
      { akun: "kas", kredit: rp(75_000_000) },
    ],
  },
  {
    tanggal: "2026-02-05",
    jenis: "KAS_BANK",
    keterangan: "Penyaluran pinjaman PUMK (fixture laporan)",
    baris: [
      { akun: "piutangPokok", debit: rp(180_000_000) },
      { akun: "kas", kredit: rp(180_000_000) },
    ],
  },
  {
    tanggal: "2026-02-14",
    jenis: "KAS_BANK",
    diCabangLain: true,
    keterangan: "Alokasi dana cabang B (fixture laporan, uji filter cabang)",
    baris: [
      { akun: "kas", debit: rp(50_000_000) },
      { akun: "pendapatanAlokasi", kredit: rp(50_000_000) },
    ],
  },
  {
    tanggal: "2026-02-25",
    jenis: "KAS_BANK",
    keterangan: "Kelebihan pembayaran angsuran (fixture laporan, liabilitas)",
    baris: [
      { akun: "kas", debit: rp(9_000_000) },
      { akun: "kelebihanAngsuran", kredit: rp(9_000_000) },
    ],
  },
  {
    tanggal: "2026-03-10",
    jenis: "KAS_BANK",
    keterangan: "Penerimaan angsuran pokok dan jasa administrasi (fixture laporan)",
    baris: [
      { akun: "kas", debit: rp(44_000_000) },
      { akun: "piutangPokok", kredit: rp(40_000_000) },
      { akun: "pendapatanJasaAdm", kredit: rp(4_000_000) },
    ],
  },
  {
    tanggal: "2026-03-18",
    jenis: "KAS_BANK",
    keterangan: "Penerimaan sumbangan terikat temporer (fixture laporan, arus kas PENDANAAN)",
    baris: [
      { akun: "kas", debit: rp(25_000_000) },
      { akun: "pendapatanTerikat", kredit: rp(25_000_000) },
    ],
  },
  {
    tanggal: "2026-03-22",
    jenis: "KAS_BANK",
    keterangan: "Pembayaran beban operasional (fixture laporan)",
    baris: [
      { akun: "bebanOperasional", debit: rp(18_000_000) },
      { akun: "kas", kredit: rp(18_000_000) },
    ],
  },
  {
    tanggal: "2026-03-28",
    jenis: "UMUM",
    keterangan: "Pembentukan penyisihan penurunan nilai piutang (fixture laporan)",
    baris: [
      { akun: "bebanPenyisihan", debit: rp(6_000_000) },
      { akun: "penyisihan", kredit: rp(6_000_000) },
    ],
  },
];

/**
 * THE FIGURES THE STANDARD BOOK PRODUCES, stated once, for the MAIN BRANCH at
 * 2026-03 unless the name says otherwise.
 *
 * These are HARDCODED ON PURPOSE, and ./laporan-fixture.test.ts re-derives
 * every one of them from `v_ledger_baris` and fails if they disagree. Two
 * reasons a report test should compare against a literal rather than against
 * another query:
 *   - a test whose expectation is a second query is a test that can agree with
 *     a wrong implementation, because both can read the ledger the same wrong
 *     way (that is exactly the ADR 0010 hazard);
 *   - an implementation that silently drops one journal still satisfies every
 *     internal identity, so only an absolute figure catches it.
 */
export const HARAPAN = {
  // Posisi Keuangan at 2026-03-31, main branch.
  kasAkhir: rp(1_285_000_000),
  piutangPokok: rp(335_000_000),
  asetTetap: rp(75_000_000),
  /** Contra asset, presented as a deduction: `tanda = -1`. */
  penyisihan: rp(18_000_000),
  totalAset: rp(1_677_000_000),
  totalLiabilitas: rp(9_000_000),
  totalAsetNeto: rp(1_668_000_000),

  // Posisi Keuangan at 2025-12-31 (the comparative cut-off), main branch.
  kasAkhirTahunLalu: rp(1_180_000_000),
  totalAsetTahunLalu: rp(1_363_000_000),
  totalLiabilitasTahunLalu: rp(0),
  totalAsetNetoTahunLalu: rp(1_363_000_000),

  // Aktivitas, 2026-01-01..2026-03-31 versus 2025-01-01..2025-03-31.
  pendapatanTahunIni: rp(329_000_000),
  bebanTahunIni: rp(24_000_000),
  kenaikanAsetNetoTahunIni: rp(305_000_000),
  kenaikanAsetNetoTidakTerikatTahunIni: rp(280_000_000),
  kenaikanAsetNetoTerikatTahunIni: rp(25_000_000),
  kenaikanAsetNetoTahunLalu: rp(400_000_000),

  // Arus Kas, 2026-01-01..2026-03-31, main branch.
  arusOperasi: rp(155_000_000),
  arusInvestasi: rp(-75_000_000),
  arusPendanaan: rp(25_000_000),
  kenaikanKas: rp(105_000_000),
  kasAwal: rp(1_180_000_000),

  // Arus Kas COMPARATIVE column, 2025-01-01..2025-03-31, main branch.
  //
  // LIKE FOR LIKE, THE SAME SPAN ONE YEAR EARLIER, which is Laporan
  // Aktivitas's convention and not Laporan Posisi Keuangan's. A cash flow
  // statement is a FLOW statement, so its comparative is a period, not a
  // point. `kasAkhirQ1TahunLalu` is therefore cash at 2025-03-31 and is
  // DELIBERATELY NOT `kasAkhirTahunLalu` (cash at 2025-12-31), which is the
  // balance sheet's comparative cut-off. The two differ by the 2025 movements
  // after March, and ./laporan-arus-kas.test.ts asserts that they differ
  // rather than leaving it to be discovered.
  kasAwalTahunLalu: rp(0),
  arusOperasiTahunLalu: rp(400_000_000),
  arusInvestasiTahunLalu: rp(0),
  arusPendanaanTahunLalu: rp(1_000_000_000),
  kenaikanKasTahunLalu: rp(1_400_000_000),
  kasAkhirQ1TahunLalu: rp(1_400_000_000),

  // Perubahan Aset Neto, 2026 year to date, main branch.
  asetNetoTidakTerikatAwal: rp(1_363_000_000),
  asetNetoTidakTerikatAkhir: rp(1_643_000_000),
  asetNetoTerikatAwal: rp(0),
  asetNetoTerikatAkhir: rp(25_000_000),

  // Neraca Lajur for 2026-03 alone, main branch.
  neracaSaldoAwal: rp(1_726_000_000),
  neracaMutasi: rp(93_000_000),
  neracaSaldoAkhir: rp(1_761_000_000),

  // Buku Besar for Kas over 2026-03, main branch.
  kasSaldoAwalMaret: rp(1_234_000_000),
  kasMutasiDebitMaret: rp(69_000_000),
  kasMutasiKreditMaret: rp(18_000_000),
  kasMutasiBarisMaret: 3,
} as const;

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

export interface BarisLaporanDb {
  id: string;
  laporan: string;
  kode: string;
  nama: string;
  parent_kode: string | null;
  urutan: number;
  level: number;
  tipe_baris: string;
  tanda: number;
  seksi: string | null;
  aktif: boolean;
}

export interface SaldoAkunPeriodeDb {
  akun_id: string;
  akun_kode: string;
  cabang_id: string;
  saldo_awal: string;
  mutasi_debit: string;
  mutasi_kredit: string;
  saldo_akhir: string;
}

export interface DuniaLaporan {
  db: PortUji;
  bumnId: string;
  namaBumn: string;
  cabangId: string;
  namaCabang: string;
  cabangLainId: string;
  namaCabangLain: string;
  akun: Record<KunciAkun, AkunFixture>;

  /** The engine under test, wired the way the composition root wires it. */
  engine: LaporanEngine;
  /** Builds a SECOND engine, e.g. one on a different clock. */
  buatEngine(opsi?: { jam?: () => Date }): LaporanEngine;

  jam(): Date;
  /** Moves the injected clock. Every engine in this world reads it live. */
  setelJam(iso: string): void;

  userId: Record<
    "maker" | "checker" | "approver" | "auditor" | "adminPusat" | "adminCabang" | "makerLain",
    string
  >;
  namaUser: Record<keyof DuniaLaporan["userId"], string>;
  /** Contexts whose `permissions` came from `permissionsForRole`, never a literal. */
  ctx: Record<keyof DuniaLaporan["userId"], LaporanContext>;
  /** A context stripped of one permission, to test a refusal. */
  ctxTanpaIzin(dasar: LaporanContext, izin: string): LaporanContext;

  // --- periods -------------------------------------------------------------
  periode(tahun: number, bulan: number): PeriodeFixture;
  /** The period every headline test reports on: 2026-03. */
  periodeLaporan(): PeriodeFixture;
  bacaPeriode(periodeId: string): Promise<{ id: string; status: string }>;

  // --- journals ------------------------------------------------------------
  /** Posts the whole standard book, in date order, through the REAL engine. */
  postingBukuStandar(): Promise<Jurnal[]>;
  /** Composes and posts one journal through the REAL engine. */
  postingJurnal(j: JurnalFixture): Promise<Jurnal>;
  /** Leaves it DRAFT, so a test can prove a DRAFT never reaches a report. */
  buatJurnalDraft(j: JurnalFixture): Promise<Jurnal>;
  reversalJurnal(jurnalId: string, alasan: string): Promise<Jurnal>;

  // --- the two ledger readings that must not be confused -------------------
  /**
   * THE CORRECT ONE. Debit-positive balance of an account up to and including
   * `sampaiTanggal`, read from the SHIPPED view `v_ledger_baris`
   * (`status IN ('POSTED','REVERSED')`). ADR 0010.
   */
  saldoLedger(akunId: string, sampaiTanggal: string, cabangId?: string | null): Promise<Uang>;
  /**
   * THE WRONG ONE, on purpose. The same sum with `status = 'POSTED'` alone.
   * Exists so a test can assert the two DIFFER before asserting which one the
   * report used; without that, a test that only checked the correct value
   * could pass vacuously on data where both readings agree.
   */
  saldoLedgerNaifPostedSaja(
    akunId: string,
    sampaiTanggal: string,
    cabangId?: string | null,
  ): Promise<Uang>;
  /** Movement in a date span, debit-positive, from `v_ledger_baris`. */
  mutasiLedger(
    akunId: string,
    dari: string,
    sampai: string,
    cabangId?: string | null,
  ): Promise<{ debit: Uang; kredit: Uang }>;
  /** Whole-ledger `SUM(debit) - SUM(kredit)` for this world. */
  selisihLedger(): Promise<Uang>;
  /** The same, POSTED-only. Balances too, which is why ADR 0010 is invisible. */
  selisihLedgerNaifPostedSaja(): Promise<Uang>;

  // --- freezing and closing, as PRECONDITIONS ------------------------------
  /**
   * Freezes `saldo_akun_periode` from `v_ledger_baris` and sets the period
   * CLOSED, with raw SQL, in one transaction.
   *
   * DELIBERATELY NOT THROUGH modules/closing. This is a PRECONDITION, not the
   * behaviour under test: what these tests assert is that a CLOSED period is
   * READ from the frozen rows, and driving the ten-item checklist of spec 8.4
   * to get there would make every report test depend on an engine another
   * agent is mid-way through adapting, and would turn one report failure into
   * a cascade that hides which step actually broke. The freeze uses the SAME
   * ledger predicate the closing engine is required to use (ADR 0010), which
   * is exactly what makes the "the two paths agree" test meaningful.
   */
  bekukanDanTutup(p: PeriodeFixture): Promise<void>;
  /** Closes every period strictly before `sebelum`, in order (invariant 6). */
  bekukanDanTutupSampai(sebelum: PeriodeFixture): Promise<void>;
  /**
   * CLOSED with NO frozen balances. The state spec 10 has no answer for, and
   * the one a report must refuse on rather than quietly recompute.
   */
  tutupTanpaMembekukan(p: PeriodeFixture): Promise<void>;
  bacaSaldoBeku(periodeId: string): Promise<SaldoAkunPeriodeDb[]>;
  /**
   * Moves a frozen figure WITHOUT touching the ledger, keeping
   * `saldo_akun_periode_identitas_ck` satisfied (saldo_awal and saldo_akhir
   * move together).
   *
   * The only way to prove a report READ the snapshot instead of recomputing:
   * after this, the frozen figure and the ledger figure disagree, and there is
   * exactly one right answer for a CLOSED period. Call it twice with opposite
   * deltas on two accounts to keep the trial balance balanced; call it once to
   * manufacture the unbalanced snapshot a report must refuse on.
   */
  rusakSaldoBeku(periodeId: string, akunId: string, deltaDebitPositif: Uang): Promise<void>;

  // --- report layout, which is data ---------------------------------------
  bacaBarisLaporan(laporan?: string): Promise<BarisLaporanDb[]>;
  tambahBarisLaporan(baris: {
    kode: string;
    nama: string;
    laporan: string;
    urutan: number;
    tipeBaris?: TipeBaris;
    tanda?: 1 | -1;
    seksi?: string | null;
    level?: number;
  }): Promise<string>;
  setelBarisLaporan(
    kode: string,
    ubah: Partial<{ nama: string; urutan: number; aktif: boolean; tanda: 1 | -1; seksi: string | null }>,
  ): Promise<void>;
  /** Repoints an account at another report line. No deploy, no code change. */
  petakanAkun(akunId: string, kodeBaris: string): Promise<void>;
  setelKlasifikasiArusKas(akunId: string, nilai: KlasifikasiArusKas | null): Promise<void>;
  setelAktifAkun(akunId: string, aktif: boolean): Promise<void>;

  // --- configuration -------------------------------------------------------
  setelKonfigurasi(grup: string, kunciKonfig: string, nilai: string): Promise<void>;
  /**
   * Soft-deletes THIS WORLD'S OWN row only, so the SHIPPED GLOBAL DEFAULT
   * still answers and the call SUCCEEDS. That is what it is for: "the client
   * configured nothing, so the default applies". It is NOT a way to reach a
   * missing-configuration refusal; use `tanpaKonfigurasi`.
   */
  hapusKonfigurasi(grup: string, kunciKonfig: string): Promise<void>;
  /**
   * Runs `jalankan` with the key ABSENT AT BOTH LEVELS, this world's row and
   * the SHIPPED GLOBAL one, then puts both back WHATEVER HAPPENS.
   *
   * WHY THIS EXISTS, AND WHAT IT COST TO LEARN. `hapusKonfigurasi` removes one
   * level, and `akuntansi.tahun_buku_mulai_bulan` has a global row from
   * migrations/0004, so the refusal test built on it could not fail closed by
   * the module's own bumn-then-global resolution. Faced with that, this module
   * was implemented to resolve THIS ONE KEY branch-only, while
   * modules/closing and modules/rka resolve it branch-then-global. One key
   * with two resolution orders in one system is a trap for whoever debugs a
   * wrong fiscal year later, and it was a test defect that forced it, not a
   * design disagreement. The convention is branch-then-global everywhere; this
   * helper is what lets the test say "absent" and mean it.
   *
   * THE COST, STATED RATHER THAN HIDDEN. The global row is shared and
   * `bun test` runs files in parallel, so during `jalankan` a concurrent world
   * sees the key missing. The window is one engine call, the restore is in a
   * `finally` so a throwing assertion still restores, and rows are
   * soft-deleted and UN-deleted BY ID rather than deleted and re-inserted, so
   * the original comes back with its own id and description. Same trade
   * modules/nonpumk's `tanpaKonfigurasi` has carried since migrations/0022.
   */
  tanpaKonfigurasi<T>(grup: string, kunciKonfig: string, jalankan: () => Promise<T>): Promise<T>;

  tutup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export async function buatDunia(): Promise<DuniaLaporan> {
  const db = buatPortDb();

  // Default print date: the last day of the reporting period, so
  // `HeaderLaporan.tanggalCetak` is a stable value a test can assert instead
  // of whatever today happens to be.
  let sekarang = new Date(`${TAHUN_INI}-03-31T04:00:00.000Z`);
  const jam = () => sekarang;

  const namaBumn = "PT Krakatau Steel (fixture laporan)";
  const namaCabang = "Kantor Pusat (fixture laporan)";
  const namaCabangLain = "Cabang B (fixture laporan)";

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1) returning id::text as id`,
    [kunci("BUMN"), namaBumn],
  );
  const cabang = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama, is_pusat) values ($1, $2, $3, true) returning id::text as id`,
    [bumn.id, kunci("CBG"), namaCabang],
  );
  const cabangLain = await satu<{ id: string }>(
    db,
    `insert into cabang (bumn_id, kode, nama) values ($1, $2, $3) returning id::text as id`,
    [bumn.id, kunci("CBG"), namaCabangLain],
  );

  const namaUser = {
    maker: "Maker (fixture laporan)",
    checker: "Checker (fixture laporan)",
    approver: "Approver (fixture laporan)",
    auditor: "Auditor (fixture laporan)",
    adminPusat: "Admin Pusat (fixture laporan)",
    adminCabang: "Admin Cabang (fixture laporan)",
    makerLain: "Maker Cabang B (fixture laporan)",
  } as const;

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
    maker: await buatUser(namaUser.maker, cabang.id),
    checker: await buatUser(namaUser.checker, cabang.id),
    approver: await buatUser(namaUser.approver, cabang.id),
    auditor: await buatUser(namaUser.auditor, cabang.id),
    adminPusat: await buatUser(namaUser.adminPusat, cabang.id),
    adminCabang: await buatUser(namaUser.adminCabang, cabang.id),
    makerLain: await buatUser(namaUser.makerLain, cabangLain.id),
  };

  // The SHIPPED permission catalogue, the six SHIPPED system roles and the
  // SHIPPED grant matrix.
  //
  // THROUGH THE node-postgres ADAPTER ON PURPOSE, not through this world's
  // `bun:sql` port. `seedRbac` binds a JS ARRAY (`kode = ANY($2::text[])`) and
  // driver fact 3 in modules/jurnal/repo.ts applies: `bun:sql` serialises a JS
  // array as a bare comma-joined string, which `text[]` rejects with 22P02.
  // `createDbAdapter` opens no socket on import and shares one lazily-built
  // pool across the whole test process, so this costs no extra connection.
  const dbRbac = createDbAdapter();
  await seedRbac(dbRbac);

  const ROLE_UNTUK: Record<keyof typeof userId, string> = {
    maker: "MAKER",
    checker: "CHECKER",
    approver: "APPROVER",
    auditor: "AUDITOR",
    adminPusat: "ADMIN_PUSAT",
    adminCabang: "ADMIN_CABANG",
    makerLain: "MAKER",
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

  // Monthly OPEN periods across both years. ONE statement, not twenty-four
  // round trips: `generate_series` builds the month windows in Postgres, which
  // is also the only place that agrees with `periode_window_ck` about what the
  // last day of a month is without a second calendar in TypeScript.
  const periodeIndeks = new Map<string, PeriodeFixture>();
  const barisPeriode = await db.query<{
    id: string;
    tahun: number;
    bulan: number;
    mulai: string;
    akhir: string;
  }>(
    `insert into periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
     select $1,
            extract(year from m)::smallint,
            extract(month from m)::smallint,
            m::date,
            (m + interval '1 month' - interval '1 day')::date,
            'OPEN'
       from generate_series(
              make_date($2::int, 1, 1),
              make_date($3::int, 12, 1),
              interval '1 month') as m
     returning id::text as id, tahun, bulan,
               tanggal_mulai::text as mulai, tanggal_akhir::text as akhir`,
    [bumn.id, TAHUN_LALU, TAHUN_INI],
  );
  for (const row of barisPeriode) {
    periodeIndeks.set(`${row.tahun}-${row.bulan}`, {
      id: row.id,
      tahun: row.tahun,
      bulan: row.bulan,
      tanggalMulai: row.mulai,
      tanggalAkhir: row.akhir,
    });
  }

  // The SHIPPED COA, report lines and event mappings, by the same code path
  // `bun run db:seed` uses.
  const { akun: akunIdByKode } = await seedCoaDanEventMapping(db, bumn.id, userId.adminPusat);

  // The template every line of this world belongs to. The seed created it;
  // this resolves the same row rather than making a second one, because two
  // templates would be two statements, not one statement with extra lines
  // (migrations/0028).
  const templateId = await seedTemplateLaporan(db, bumn.id, userId.adminPusat);

  // What the seed does not ship (see the file header). Report lines first: the
  // composite FK `akun.klasifikasi_akun -> klasifikasi_akun(bumn_id, kode)`
  // means a classification has to exist before an account can point at it, and
  // `pemetaan_baris_laporan` has to exist before that classification prints.
  for (const [kode, seksi] of SEKSI_BARIS_TERKIRIM) {
    await db.query(
      `update baris_laporan set seksi = $3, updated_by = $4 where bumn_id = $1 and kode = $2`,
      [bumn.id, kode, seksi, userId.adminPusat],
    );
  }
  for (const kode of BARIS_JADI_HEADER) {
    await db.query(
      `update baris_laporan set tipe_baris = 'HEADER', updated_by = $3
        where bumn_id = $1 and kode = $2`,
      [bumn.id, kode, userId.adminPusat],
    );
  }
  for (const b of BARIS_TAMBAHAN) {
    let parentId: string | null = null;
    if (b.parentKode) {
      const induk = await satu<{ id: string }>(
        db,
        `select id::text as id from baris_laporan where bumn_id = $1 and template_id = $2 and kode = $3`,
        [bumn.id, templateId, b.parentKode],
      );
      parentId = induk.id;
    }
    await tambahBarisDanKlasifikasi(db, bumn.id, templateId, userId.adminPusat, {
      kode: b.kode,
      nama: b.nama,
      laporan: b.laporan,
      urutan: b.urutan,
      level: b.level ?? 1,
      tipeBaris: b.tipeBaris,
      tanda: b.tanda,
      seksi: b.seksi,
      parentId,
    });
  }
  for (const a of AKUN_TAMBAHAN) {
    const parentId = akunIdByKode.get(a.parentKode);
    if (!parentId) throw new Error(`fixture laporan: parent akun ${a.parentKode} tidak ada`);
    // ON CONFLICT DO UPDATE, not a plain INSERT: since the seed grew a postable
    // net-asset account of its own (finding 1, now closed), one of these codes
    // already exists. Adopting the seeded row rather than duplicating it is
    // what keeps "the chart this world reports on" a single set of accounts.
    const baru = await satu<{ id: string }>(
      db,
      `insert into akun
         (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal, is_postable, is_kas,
          is_kontra, klasifikasi_arus_kas, klasifikasi_akun, aktif, created_by, updated_by)
       values ($1, $2, $3, $4, 2, $5, $6, true, false, false, $7, $8, $9, $10, $10)
       on conflict (bumn_id, kode) where deleted_at is null do update
         set nama = excluded.nama,
             klasifikasi_arus_kas = excluded.klasifikasi_arus_kas,
             klasifikasi_akun = excluded.klasifikasi_akun,
             aktif = excluded.aktif,
             updated_by = excluded.updated_by
       returning id::text as id`,
      [
        bumn.id,
        a.kode,
        a.nama,
        parentId,
        a.tipe,
        a.saldoNormal,
        a.arusKas,
        a.klasifikasi,
        a.aktif,
        userId.adminPusat,
      ],
    );
    akunIdByKode.set(a.kode, baru.id);
  }
  for (const [kode, klas] of ARUS_KAS_TERKIRIM) {
    await db.query(
      `update akun set klasifikasi_arus_kas = $3, updated_by = $4
        where bumn_id = $1 and kode = $2 and deleted_at is null`,
      [bumn.id, kode, klas, userId.adminPusat],
    );
  }

  const akun = {} as Record<KunciAkun, AkunFixture>;
  for (const [nama, kode] of Object.entries(KODE_AKUN) as Array<[KunciAkun, string]>) {
    const id = akunIdByKode.get(kode);
    if (!id) {
      throw new Error(
        `fixture laporan: akun ${kode} tidak ada setelah seed; periksa apps/api/src/seed/coa-inti.ts`,
      );
    }
    const row = await satu<{ nama: string }>(db, `select nama from akun where id = $1`, [id]);
    akun[nama] = { id, kode, nama: row.nama };
  }

  // `tipe_data` and `pilihan_json` come from the SHIPPED catalogue, not from a
  // second table typed out here: a key absent from the catalogue is a fixture
  // inventing a parameter, so `entri` throwing is the right answer.
  //
  // `$6::text::jsonb`, NOT `$6::jsonb`: driver fact 1 in modules/jurnal/repo.ts,
  // a jsonb parameter bound from a JS string is stored as a JSON string SCALAR.
  for (const [grup, kunciKonfig, nilai] of KONFIGURASI_AWAL) {
    const entri = KATALOG[`${grup}.${kunciKonfig}`];
    if (!entri) {
      throw new Error(
        `fixture laporan: ${grup}.${kunciKonfig} tidak ada di katalog konfigurasi terkirim; ` +
          "fixture tidak boleh mengarang parameter",
      );
    }
    await db.query(
      `insert into konfigurasi
         (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi, perlu_konfirmasi)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, 'fixture laporan (spec 10)', true)`,
      [
        bumn.id,
        grup,
        kunciKonfig,
        nilai,
        tipeDataUntuk(entri.bentuk),
        entri.pilihan ? JSON.stringify(entri.pilihan) : null,
      ],
    );
  }
  // The global (bumn_id NULL) capability defaults, from the REAL seed. ON
  // CONFLICT DO NOTHING on a NULLS NOT DISTINCT index, so worlds cannot fight
  // over them, and nothing here ever UPDATEs one.
  await seedKonfigurasiTambahan(db);

  // The ledger, real, wired the way the composition root wires it.
  const { engine: jurnalEngine } = createJurnalModule({ db, jam });

  function ctxUntuk(nama: keyof typeof userId): LaporanContext {
    const kodeRole = ROLE_UNTUK[nama];
    const izin = izinRole.get(kodeRole) ?? [];
    const lintasCabang = kodeRole === "ADMIN_PUSAT" || kodeRole === "AUDITOR";
    const rumah = nama === "makerLain" ? cabangLain.id : cabang.id;
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
    checker: ctxUntuk("checker"),
    approver: ctxUntuk("approver"),
    auditor: ctxUntuk("auditor"),
    adminPusat: ctxUntuk("adminPusat"),
    adminCabang: ctxUntuk("adminCabang"),
    makerLain: ctxUntuk("makerLain"),
  } satisfies Record<keyof typeof userId, LaporanContext>;

  const engine = createLaporanEngine({ db, jam });

  // --- helpers -------------------------------------------------------------

  function periode(tahun: number, bulan: number): PeriodeFixture {
    const p = periodeIndeks.get(`${tahun}-${bulan}`);
    if (!p) {
      throw new Error(
        `fixture laporan: periode ${tahun}-${bulan} di luar rentang dunia ` +
          `(${TAHUN_LALU}-01 .. ${TAHUN_INI}-12)`,
      );
    }
    return p;
  }

  function inputJurnal(j: JurnalFixture) {
    return {
      cabangId: j.diCabangLain ? cabangLain.id : cabang.id,
      jenis: j.jenis,
      tanggalTransaksi: j.tanggal,
      keterangan: j.keterangan,
      baris: j.baris.map((b) => ({
        akunId: akun[b.akun].id,
        ...(b.debit === undefined ? {} : { debit: b.debit }),
        ...(b.kredit === undefined ? {} : { kredit: b.kredit }),
      })),
    };
  }

  async function bekukanDanTutup(p: PeriodeFixture): Promise<void> {
    await db.transaction(async (tx) => {
      // The SAME predicate and the SAME arithmetic modules/closing is
      // required to use (ADR 0010, migrations/0018), which is the whole
      // point: the frozen figure must be the ledger figure, so that
      // "OPEN and CLOSED agree at the moment of closing" is a claim about
      // the REPORT and not about this helper.
      await tx.query(
        `insert into saldo_akun_periode
           (periode_id, cabang_id, akun_id, saldo_awal, mutasi_debit, mutasi_kredit,
            saldo_akhir, created_by, updated_by)
         with gerak as (
           select l.cabang_id, l.akun_id,
                  coalesce(sum(case when l.tanggal_transaksi < $3::date
                                    then l.debit - l.kredit else 0 end), 0)::numeric(20,2) as saldo_awal,
                  coalesce(sum(case when l.tanggal_transaksi >= $3::date
                                    then l.debit else 0 end), 0)::numeric(20,2) as mutasi_debit,
                  coalesce(sum(case when l.tanggal_transaksi >= $3::date
                                    then l.kredit else 0 end), 0)::numeric(20,2) as mutasi_kredit
             from v_ledger_baris l
            where l.bumn_id = $2::uuid and l.tanggal_transaksi <= $4::date
            group by l.cabang_id, l.akun_id
         )
         select $1::uuid, g.cabang_id, g.akun_id, g.saldo_awal, g.mutasi_debit, g.mutasi_kredit,
                (g.saldo_awal + g.mutasi_debit - g.mutasi_kredit)::numeric(20,2), $5::uuid, $5::uuid
           from gerak g
          where g.saldo_awal <> 0 or g.mutasi_debit <> 0 or g.mutasi_kredit <> 0`,
        [p.id, bumn.id, p.tanggalMulai, p.tanggalAkhir, userId.approver],
      );
      await tx.query(
        `update periode set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`,
        [p.id, userId.approver],
      );
    });
  }

  async function saldoDenganPredikat(
    predikat: "LEDGER" | "POSTED_SAJA",
    akunId: string,
    sampaiTanggal: string,
    cabangId?: string | null,
  ): Promise<Uang> {
    // `coalesce(sum(...), 0)` returns '0', not '0.00'. Cast to numeric(20,2)
    // BEFORE ::text or the value fails POLA_UANG and every equality assertion.
    const sumber =
      predikat === "LEDGER"
        ? `from v_ledger_baris l where l.akun_id = $1 and l.tanggal_transaksi <= $2 and l.bumn_id = $3`
        : `from jurnal_baris b join jurnal j on j.id = b.jurnal_id
            where b.akun_id = $1 and j.tanggal_transaksi <= $2 and j.bumn_id = $3
              and j.status = 'POSTED' and j.deleted_at is null and b.deleted_at is null`;
    const kolom = predikat === "LEDGER" ? "l.debit - l.kredit" : "b.debit - b.kredit";
    const params: unknown[] = [akunId, sampaiTanggal, bumn.id];
    let filterCabang = "";
    if (cabangId) {
      params.push(cabangId);
      filterCabang = predikat === "LEDGER" ? ` and l.cabang_id = $4` : ` and j.cabang_id = $4`;
    }
    const baris = await satu<{ saldo: string }>(
      db,
      `select coalesce(sum(${kolom}), 0)::numeric(20,2)::text as saldo ${sumber}${filterCabang}`,
      params,
    );
    return baris.saldo;
  }

  return {
    db,
    bumnId: bumn.id,
    namaBumn,
    cabangId: cabang.id,
    namaCabang,
    cabangLainId: cabangLain.id,
    namaCabangLain,
    akun,
    engine,
    buatEngine: (opsi) => createLaporanEngine({ db, jam: opsi?.jam ?? jam }),
    jam,
    setelJam(iso) {
      sekarang = new Date(`${iso}T04:00:00.000Z`);
    },
    userId,
    namaUser,
    ctx,
    ctxTanpaIzin: (dasar, izin) => ({
      ...dasar,
      permissions: dasar.permissions.filter((p) => p !== izin),
    }),

    periode,
    periodeLaporan: () => periode(TAHUN_INI, BULAN_LAPORAN),
    bacaPeriode: (periodeId) =>
      satu(db, `select id::text as id, status from periode where id = $1`, [periodeId]),

    async postingBukuStandar() {
      const keluar: Jurnal[] = [];
      for (const j of BUKU_STANDAR) {
        const draft = await jurnalEngine.buatJurnal(inputJurnal(j), ctx.adminPusat as JurnalContext);
        keluar.push(await jurnalEngine.postingJurnal(draft.id, ctx.adminPusat as JurnalContext));
      }
      return keluar;
    },
    async postingJurnal(j) {
      const draft = await jurnalEngine.buatJurnal(inputJurnal(j), ctx.adminPusat as JurnalContext);
      return jurnalEngine.postingJurnal(draft.id, ctx.adminPusat as JurnalContext);
    },
    buatJurnalDraft: (j) =>
      jurnalEngine.buatJurnal(inputJurnal(j), ctx.adminPusat as JurnalContext),
    reversalJurnal: (jurnalId, alasan) =>
      jurnalEngine.reversalJurnal(jurnalId, alasan, ctx.adminPusat as JurnalContext),

    saldoLedger: (akunId, sampaiTanggal, cabangId) =>
      saldoDenganPredikat("LEDGER", akunId, sampaiTanggal, cabangId),
    saldoLedgerNaifPostedSaja: (akunId, sampaiTanggal, cabangId) =>
      saldoDenganPredikat("POSTED_SAJA", akunId, sampaiTanggal, cabangId),
    async mutasiLedger(akunId, dari, sampai, cabangId) {
      const params: unknown[] = [akunId, dari, sampai, bumn.id];
      let filter = "";
      if (cabangId) {
        params.push(cabangId);
        filter = ` and l.cabang_id = $5`;
      }
      return satu<{ debit: Uang; kredit: Uang }>(
        db,
        `select coalesce(sum(l.debit), 0)::numeric(20,2)::text as debit,
                coalesce(sum(l.kredit), 0)::numeric(20,2)::text as kredit
           from v_ledger_baris l
          where l.akun_id = $1 and l.tanggal_transaksi >= $2 and l.tanggal_transaksi <= $3
            and l.bumn_id = $4${filter}`,
        params,
      );
    },
    async selisihLedger() {
      const baris = await satu<{ selisih: string }>(
        db,
        `select coalesce(sum(l.debit) - sum(l.kredit), 0)::numeric(20,2)::text as selisih
           from v_ledger_baris l where l.bumn_id = $1`,
        [bumn.id],
      );
      return baris.selisih;
    },
    async selisihLedgerNaifPostedSaja() {
      const baris = await satu<{ selisih: string }>(
        db,
        `select coalesce(sum(b.debit) - sum(b.kredit), 0)::numeric(20,2)::text as selisih
           from jurnal_baris b join jurnal j on j.id = b.jurnal_id
          where j.bumn_id = $1 and j.status = 'POSTED'
            and j.deleted_at is null and b.deleted_at is null`,
        [bumn.id],
      );
      return baris.selisih;
    },

    bekukanDanTutup,
    async bekukanDanTutupSampai(sebelum) {
      const urutan = [...periodeIndeks.values()].sort(
        (a, b) => a.tahun * 12 + a.bulan - (b.tahun * 12 + b.bulan),
      );
      for (const p of urutan) {
        if (p.tahun * 12 + p.bulan >= sebelum.tahun * 12 + sebelum.bulan) break;
        await bekukanDanTutup(p);
      }
    },
    async tutupTanpaMembekukan(p) {
      await db.query(
        `update periode set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`,
        [p.id, userId.approver],
      );
    },
    bacaSaldoBeku(periodeId) {
      return db.query<SaldoAkunPeriodeDb>(
        `select s.akun_id::text as akun_id, a.kode as akun_kode, s.cabang_id::text as cabang_id,
                s.saldo_awal::text as saldo_awal, s.mutasi_debit::text as mutasi_debit,
                s.mutasi_kredit::text as mutasi_kredit, s.saldo_akhir::text as saldo_akhir
           from saldo_akun_periode s join akun a on a.id = s.akun_id
          where s.periode_id = $1 and s.deleted_at is null
          order by a.kode, s.cabang_id`,
        [periodeId],
      );
    },
    async rusakSaldoBeku(periodeId, akunId, deltaDebitPositif) {
      await db.query(
        `update saldo_akun_periode
            set saldo_awal = saldo_awal + $3::numeric(20,2),
                saldo_akhir = saldo_akhir + $3::numeric(20,2),
                updated_by = $4
          where periode_id = $1 and akun_id = $2`,
        [periodeId, akunId, deltaDebitPositif, userId.adminPusat],
      );
    },

    bacaBarisLaporan(laporan) {
      const params: unknown[] = [bumn.id];
      let filter = "";
      if (laporan) {
        params.push(laporan);
        filter = ` and b.laporan = $2`;
      }
      return db.query<BarisLaporanDb>(
        `select b.id::text as id, b.laporan, b.kode, b.nama, p.kode as parent_kode,
                b.urutan, b.level, b.tipe_baris, b.tanda, b.seksi, b.aktif
           from baris_laporan b
           left join baris_laporan p on p.id = b.parent_id
          where b.bumn_id = $1 and b.deleted_at is null${filter}
          order by b.laporan, b.urutan`,
        params,
      );
    },
    async tambahBarisLaporan(b) {
      return tambahBarisDanKlasifikasi(db, bumn.id, templateId, userId.adminPusat, {
        kode: b.kode,
        nama: b.nama,
        laporan: b.laporan,
        urutan: b.urutan,
        level: b.level ?? 1,
        tipeBaris: b.tipeBaris ?? "DETAIL",
        tanda: b.tanda ?? 1,
        seksi: b.seksi ?? null,
      });
    },
    async setelBarisLaporan(kode, ubah) {
      const set: string[] = [];
      const params: unknown[] = [bumn.id, kode, userId.adminPusat];
      for (const [kolom, nilai] of Object.entries(ubah)) {
        if (nilai === undefined) continue;
        params.push(nilai);
        set.push(`${kolom} = $${params.length}`);
      }
      if (set.length === 0) return;
      await db.query(
        `update baris_laporan set ${set.join(", ")}, updated_by = $3
          where bumn_id = $1 and kode = $2`,
        params,
      );
    },
    async petakanAkun(akunId, kodeBaris) {
      // The account points at a CLASSIFICATION now, not at a printed line
      // (migrations/0028). `tambahBarisDanKlasifikasi` gives every line a
      // classification with the same code, so the argument still names the
      // line the caller means.
      await db.query(`update akun set klasifikasi_akun = $2, updated_by = $3 where id = $1`, [
        akunId,
        kodeBaris,
        userId.adminPusat,
      ]);
    },
    async setelKlasifikasiArusKas(akunId, nilai) {
      await db.query(
        `update akun set klasifikasi_arus_kas = $2, updated_by = $3 where id = $1`,
        [akunId, nilai, userId.adminPusat],
      );
    },
    async setelAktifAkun(akunId, aktif) {
      await db.query(`update akun set aktif = $2, updated_by = $3 where id = $1`, [
        akunId,
        aktif,
        userId.adminPusat,
      ]);
    },

    async setelKonfigurasi(grup, kunciKonfig, nilai) {
      const entri = KATALOG[`${grup}.${kunciKonfig}`];
      if (!entri) throw new Error(`fixture laporan: ${grup}.${kunciKonfig} bukan parameter terkirim`);
      // BUMN-SCOPED ONLY. Never an UPDATE on the global row: a closing test did
      // that once and poisoned every world built after it.
      const diubah = await db.query(
        `update konfigurasi set nilai = $4, updated_by = $5
          where bumn_id = $1 and grup = $2 and kunci = $3 and deleted_at is null
          returning id`,
        [bumn.id, grup, kunciKonfig, nilai, userId.adminPusat],
      );
      if (diubah.length > 0) return;
      await db.query(
        `insert into konfigurasi
           (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi, perlu_konfirmasi,
            created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6::text::jsonb, 'fixture laporan (spec 10)', true, $7, $7)`,
        [
          bumn.id,
          grup,
          kunciKonfig,
          nilai,
          tipeDataUntuk(entri.bentuk),
          entri.pilihan ? JSON.stringify(entri.pilihan) : null,
          userId.adminPusat,
        ],
      );
    },
    async hapusKonfigurasi(grup, kunciKonfig) {
      // THIS WORLD'S ROW ONLY, so the shipped global default still answers.
      await db.query(
        `update konfigurasi set deleted_at = now(), deleted_by = $4
          where bumn_id = $1 and grup = $2 and kunci = $3`,
        [bumn.id, grup, kunciKonfig, userId.adminPusat],
      );
    },
    async tanpaKonfigurasi(grup, kunciKonfig, jalankan) {
      // BOTH ROWS. See the port's note: with bumn-then-global resolution,
      // removing one level is not removing the configuration.
      const hidup = await db.query<{ id: string; bumn_id: string | null }>(
        `select id::text as id, bumn_id::text as bumn_id from konfigurasi
          where grup = $2 and kunci = $3 and deleted_at is null
            and (bumn_id = $1 or bumn_id is null)`,
        [bumn.id, grup, kunciKonfig],
      );
      if (!hidup.some((r) => r.bumn_id === bumn.id)) {
        throw new Error(
          `fixture laporan: konfigurasi ${grup}.${kunciKonfig} tidak ada untuk bumn ini; ` +
            "tambahkan ke KONFIGURASI_AWAL di test-support.ts",
        );
      }
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

    async tutup() {
      await db.tutup();
    },
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

const POLA_KEBOCORAN_DB =
  /TJSL-[A-Z]{3}-\d{3}|PL\/pgSQL|plpgsql|SQLSTATE|violates|duplicate key|null value in column|relation "|_ck\b|_uq\b|ERROR:|syntax error at|select |from v_/i;

/**
 * Asserts a rejection is the expected DOMAIN error, and that its message is
 * free of DB internals. DELIBERATELY STRICT ABOUT THE TYPE AND THE CODE: the
 * stub in ./service.ts throws a plain `Error`, so this cannot be satisfied by
 * an unimplemented engine, which is the one failure mode a tests-first suite
 * exists to prevent.
 *
 * TAKES A PROMISE OR A THUNK. Prefer the thunk: a method that rejects from a
 * guard clause placed before its first `await`, in a function not declared
 * `async`, throws SYNCHRONOUSLY, and the argument expression would blow up at
 * the call site before this assertion ever ran.
 */
export async function tolakDengan(
  janji: Promise<unknown> | (() => Promise<unknown> | unknown),
  kode: KodeLaporan,
): Promise<LaporanError> {
  let ditangkap: unknown;
  try {
    await (typeof janji === "function" ? janji() : janji);
  } catch (e) {
    ditangkap = e;
  }
  if (ditangkap === undefined) {
    throw new Error(`diharapkan ditolak dengan ${kode}, tapi operasi berhasil`);
  }
  expect(ditangkap).toBeInstanceOf(LaporanError);
  const err = ditangkap as LaporanError;
  expect(err.kode).toBe(kode);
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.message).not.toMatch(POLA_KEBOCORAN_DB);
  return err;
}

/** Sanity: every code a test names exists in the contract's catalogue. */
export function kodeAda(kode: KodeLaporan): KodeLaporan {
  expect(Object.values(KODE_LAPORAN)).toContain(kode);
  return kode;
}

/** Spec 10's header, asserted once wherever a report is opened. */
export function headerSah(
  header: { [k: string]: unknown },
  d: DuniaLaporan,
  harap: { namaLaporan: string; cabangId: string | null; sumberData: string },
): void {
  expect(header.namaBumn).toBe(d.namaBumn);
  expect(header.namaLaporan).toBe(harap.namaLaporan);
  // A period-less report (Bagan Akun) still prints a header label; spec 10
  // makes the header a property of every report, not of periodic ones.
  expect(String(header.periodeLabel ?? "").length).toBeGreaterThan(0);
  expect(header.cabangId).toBe(harap.cabangId);
  expect(String(header.namaCabang ?? "").length).toBeGreaterThan(0);
  expect(header.tanggalCetak).toBe(d.jam().toISOString().slice(0, 10));
  expect(header.sumberData).toBe(harap.sumberData);
}
