// Fixture for the PUMK ROUTE tests. NOT a *.test.ts file, so `bun test` never
// runs it on its own.
//
// WHY IT IS NOT ./test-support.ts
// That file builds a world for the ENGINE: its users carry a fake password
// hash, so none of them can log in, and it drives the engine directly with a
// hand-built `PumkContext`. A route test must not do either. Spec 2 rule 4 is
// "call the endpoint directly with the wrong role", which is only true if the
// role arrives the way it arrives in production: a real login, a real session
// cookie, a real principal resolved from Redis and Postgres, through the real
// guard chain. So this file composes:
//
//   ../../testing/harness  -- the REAL app from core/app.ts's `createApp`,
//                             real users for all six roles plus a second
//                             branch, and a `login()` that returns a cookie;
//   ../../seed/event-jurnal -- the SHIPPED chart of accounts and the SHIPPED
//                             event mappings, by the same code path
//                             `bun run db:seed` uses.
//
// Nothing here asserts a business rule and nothing here stands in for a
// collaborator: the journal engine, the instalment engine and the PUMK engine
// are the ones `createApp` wired, so a route test exercises the same graph the
// server runs. A double may stand in for a FAILURE, never for a VALIDATION.
//
// EVERY FIXTURE IS UNIQUE, for the reason the harness gives: `bun run db:reset`
// is run by other agents mid-suite and test files share one Postgres. Each
// world gets its own bumn (from the harness), its own periods, its own chart of
// accounts and its own mitra. Nothing is cleaned up afterwards, and nothing
// depends on rows another file left behind.
import { createFixture, tutupSemuaFixture, type Fixture, type TestCabang } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";

export type { Fixture };
// Re-exported so a test file that uses this world can close it with one
// `afterAll(tutupSemuaFixture)` and one import. See the FIXTURE LEAK note in
// ../../testing/harness.ts.
export { tutupSemuaFixture };

/** Whole rupiah -> the `Uang` shape the API takes. `rp(12_000_000)` = "12000000.00". */
export function rp(rupiahBulat: number): string {
  if (!Number.isInteger(rupiahBulat)) {
    throw new Error(`rp() hanya menerima rupiah bulat, dapat ${rupiahBulat}`);
  }
  return `${rupiahBulat}.00`;
}

/** A unique key per call, so two worlds can never collide on a unique index. */
export function kunci(awalan: string): string {
  return `${awalan}-${crypto.randomUUID().slice(0, 12)}`;
}

export interface MitraUji {
  id: string;
  kodeMitra: string;
  nama: string;
  nik: string;
}

export interface DuniaRute {
  f: Fixture;
  /** Session cookies, keyed the way the tests read: `as("MAKER")`. */
  sesi: Map<string, string>;
  sektorId: string;
  karyawanId: string;
  clusterA: string;
  clusterB: string;
  /** Postable cash account of this world's chart of accounts. */
  akunKasId: string;
  akunKode: Map<string, string>;
  buatMitra(opsi?: { cabang?: TestCabang; nama?: string }): Promise<MitraUji>;
  /** `GET`/`POST` as a role, returning the raw Response. */
  panggil(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<Response>;
  /** Same, but asserts a 2xx and returns the parsed body. */
  ok<T>(role: string, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
}

const ROLE_UNTUK_SESI = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
  "MAKER_B",
] as const;

/** The account codes this fixture needs by name, from the SHIPPED core COA. */
const KODE_KAS = "1.1.01";

export async function buatDuniaRute(): Promise<DuniaRute> {
  const f = await createFixture();
  const db = f.db;

  // UNIQUE BRANCH CODES, and this is not cosmetic.
  //
  // The harness gives every fixture the same branch codes ("00", "01", "02"),
  // which is harmless for its own tests. It is not harmless here:
  // `no_proposal` is built by modules/nomor as
  // `{urutan}/{jenis}/{kode_cabang}/{bulan_romawi}/{tahun}` and
  // `pumk_proposal_no_uq` is unique over the WHOLE table, with no bumn column
  // in it. Two worlds in one database would therefore both allocate
  // `0001/PROPOSAL_PUMK/01/I/2026` and the second one would fail on a
  // duplicate key that has nothing to do with what it was testing.
  //
  // Rewritten BEFORE any login, so the principal each session resolves already
  // carries the code its branch really has.
  for (const cabang of [f.pusat, f.cabangA, f.cabangB]) {
    const kodeBaru = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.query(`UPDATE cabang SET kode = $2 WHERE id = $1`, [cabang.id, kodeBaru]);
    cabang.kode = kodeBaru;
  }

  // Monthly OPEN periods for 2026-01 .. 2028-12. Every date these tests use
  // falls inside, so no test can fail for the incidental reason that its date
  // has no period to post into.
  for (let tahun = 2026; tahun <= 2028; tahun += 1) {
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      const mulai = `${tahun}-${String(bulan).padStart(2, "0")}-01`;
      const akhir = new Date(Date.UTC(tahun, bulan, 0)).toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
        [f.bumnId, tahun, bulan, mulai, akhir],
      );
    }
  }

  const { akun } = await seedCoaDanEventMapping(db, f.bumnId, f.users.ADMIN_PUSAT.id);
  const akunKasId = akun.get(KODE_KAS);
  if (!akunKasId) {
    throw new Error(`fixture: akun ${KODE_KAS} tidak ada setelah seedCoaInti`);
  }

  const sektorRows = await db.query<{ id: string }>(
    `INSERT INTO sektor_pumk (bumn_id, kode, nama) VALUES ($1, $2, 'Perdagangan (uji rute)')
     RETURNING id::text AS id`,
    [f.bumnId, kunci("SEK").slice(0, 20)],
  );
  const sektorId = sektorRows[0]!.id;

  const clusterRows = await db.query<{ id: string }>(
    `INSERT INTO cluster (cabang_id, kode, nama, sektor_id) VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id`,
    [f.cabangA.id, kunci("CLS").slice(0, 20), "Cluster A (uji rute)", sektorId],
  );
  const clusterBRows = await db.query<{ id: string }>(
    `INSERT INTO cluster (cabang_id, kode, nama, sektor_id) VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id`,
    [f.cabangB.id, kunci("CLS").slice(0, 20), "Cluster B (uji rute)", sektorId],
  );

  const sesi = new Map<string, string>();
  for (const role of ROLE_UNTUK_SESI) {
    const user = role === "MAKER_B" ? f.users.MAKER_B : f.users[role];
    sesi.set(role, await f.login(user.username));
  }

  async function buatMitra(
    opsi: { cabang?: TestCabang; nama?: string } = {},
  ): Promise<MitraUji> {
    const cabang = opsi.cabang ?? f.cabangA;
    const kode = kunci("MTR").slice(0, 24);
    // Digits only and unique: mitra_nik_uq is a real unique index, and a mitra
    // per proposal is required because pumk_akad_satu_aktif_per_mitra_uq allows
    // exactly one live loan each.
    const nik = crypto.randomUUID().replace(/\D/g, "").padEnd(16, "7").slice(0, 16);
    const nama = opsi.nama ?? `Mitra ${kode}`;
    const rows = await db.query<{ id: string }>(
      `INSERT INTO mitra (cabang_id, kode_mitra, nama_lengkap, nik, sektor_id, nama_usaha, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'CALON') RETURNING id::text AS id`,
      [cabang.id, kode, nama, nik, sektorId, `Usaha ${kode}`],
    );
    return { id: rows[0]!.id, kodeMitra: kode, nama, nik };
  }

  function cookieUntuk(role: string): string {
    const cookie = sesi.get(role);
    if (!cookie) throw new Error(`tidak ada sesi untuk ${role}`);
    return cookie;
  }

  async function panggil(
    role: string,
    path: string,
    opsi: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return f.request(path, {
      method: opsi.method ?? (opsi.body === undefined ? "GET" : "POST"),
      cookie: cookieUntuk(role),
      ...(opsi.body !== undefined ? { body: opsi.body } : {}),
    });
  }

  async function ok<T>(
    role: string,
    path: string,
    opsi: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await panggil(role, path, opsi);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `${opsi.method ?? (opsi.body === undefined ? "GET" : "POST")} ${path} sebagai ${role} ` +
          `menjawab ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  return {
    f,
    sesi,
    sektorId,
    karyawanId: f.karyawanA,
    clusterA: clusterRows[0]!.id,
    clusterB: clusterBRows[0]!.id,
    akunKasId,
    akunKode: akun,
    buatMitra,
    panggil,
    ok,
  };
}
