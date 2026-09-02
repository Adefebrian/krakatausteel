// Fixture for the RKA ROUTE tests. NOT a *.test.ts file, so `bun test` never
// runs it on its own.
//
// WHY IT IS NOT ./test-support.ts
// That file builds a world for the ENGINE: it drives the engine directly with
// a hand-built `RkaContext` and its users cannot log in. A route test must not
// do either. Spec 2 rule 4 is "call the endpoint directly with the wrong role",
// which is only true if the role arrives the way it arrives in production: a
// real login, a real session cookie, a real principal resolved from Redis and
// Postgres, through the real guard chain. So this file composes:
//
//   ../../testing/harness   -- the REAL app from core/app.ts's `createApp`,
//                              real users for all six roles plus a second
//                              branch, and a `login()` that returns a cookie;
//   ../../seed/event-jurnal -- the SHIPPED chart of accounts and the SHIPPED
//                              event mappings, by the same code path
//                              `bun run db:seed` uses.
//
// Nothing here asserts a business rule and nothing here stands in for a
// collaborator: the RKA engine is the one `createApp` wired, so a route test
// exercises the same graph the server runs.
//
// EVERY FIXTURE IS UNIQUE, for the reason the harness gives: test files share
// one Postgres and another agent may reset it mid-run. Each world gets its own
// bumn (from the harness), its own periods, its own chart of accounts, its own
// sektor and its own bidang. Nothing is cleaned up and nothing depends on rows
// another file left behind.
import { createFixture, TEST_PASSWORD, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";

export type { Fixture };

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

/** The financial year every case in these tests budgets for. */
export const TAHUN_RKA = 2026;

const ROLE_UNTUK_SESI = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
  "MAKER_B",
] as const;

/**
 * A SECOND Admin Pusat, and it is not a convenience.
 *
 * `rka.pemisahan_tugas_persetujuan` ships as `true`, so the person who created
 * or last edited a version may not approve it (`KONFLIK_MAKER_APPROVER`), and
 * `admin.rka.approve` is held by ADMIN_PUSAT alone. With the harness's single
 * Admin Pusat, NO approval could ever succeed in these tests and every test
 * needing a baseline would have to switch the control off -- which would mean
 * the route tests ran against a configuration the product does not ship.
 * Creating a second Admin Pusat is what a client with this control on has to do
 * too, so the fixture reproduces the real deployment rather than working around
 * it.
 */
export const ADMIN_PUSAT_2 = "ADMIN_PUSAT_2";

/** A postable BEBAN account from the SHIPPED core COA, budgetable by the engine's rule. */
const KODE_BEBAN = "5.1.02";

export interface DuniaRuteRka {
  f: Fixture;
  sesi: Map<string, string>;
  /** Dimension rows, one of each, for the three budget types. */
  sektorId: string;
  bidangId: string;
  /** A postable BEBAN account: what RKA Keuangan may be budgeted against. */
  akunBebanId: string;
  /** A postable ASET account: what it may NOT, so the refusal is reachable. */
  akunKasId: string;
  /** Every account id of this world's chart, keyed by code. */
  akunKode: Map<string, string>;
  /** An OPEN period of `TAHUN_RKA`, for the realisation-source routes. */
  periodeOpenId: string;
  /** The second Admin Pusat's user id, so a test can name the approver. */
  adminPusat2Id: string;
  /** `GET`/`POST` as a role, returning the raw Response. */
  panggil(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<Response>;
  /** Same, but asserts a 2xx and returns the parsed body. */
  ok<T>(role: string, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
}

export async function buatDuniaRuteRka(): Promise<DuniaRuteRka> {
  const f = await createFixture();
  const db = f.db;

  // UNIQUE BRANCH CODES. The harness gives every fixture "00", "01", "02",
  // which is harmless for its own tests and not harmless here: this world
  // shares a database with every other, and a code collision produces a
  // failure that has nothing to do with what is being tested. Rewritten BEFORE
  // any login, so the principal each session resolves carries the real code.
  for (const cabang of [f.pusat, f.cabangA, f.cabangB]) {
    const kodeBaru = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.query(`UPDATE cabang SET kode = $2 WHERE id = $1`, [cabang.id, kodeBaru]);
    cabang.kode = kodeBaru;
  }

  // Monthly OPEN periods for the budget year and the one after it. Report 24
  // refuses a month with no period (`PERIODE_TIDAK_DITEMUKAN`), so this exists
  // to keep an authorisation test from failing for an accounting reason.
  for (let tahun = TAHUN_RKA; tahun <= TAHUN_RKA + 1; tahun += 1) {
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
  const periodeRows = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM periode WHERE bumn_id = $1 AND tahun = $2 AND bulan = 2`,
    [f.bumnId, TAHUN_RKA],
  );
  const periodeOpenId = periodeRows[0]!.id;

  const { akun } = await seedCoaDanEventMapping(db, f.bumnId, f.users.ADMIN_PUSAT.id);
  const akunBebanId = akun.get(KODE_BEBAN);
  const akunKasId = akun.get("1.1.01");
  if (!akunBebanId || !akunKasId) {
    throw new Error("fixture rute RKA: chart of accounts inti tidak lengkap");
  }

  const sektorRows = await db.query<{ id: string }>(
    `INSERT INTO sektor_pumk (bumn_id, kode, nama) VALUES ($1, $2, 'Perdagangan (uji rute RKA)')
     RETURNING id::text AS id`,
    [f.bumnId, kunci("SEK").slice(0, 20)],
  );
  const bidangRows = await db.query<{ id: string }>(
    `INSERT INTO bidang_non_pumk (bumn_id, kode, nama) VALUES ($1, $2, 'Pendidikan (uji rute RKA)')
     RETURNING id::text AS id`,
    [f.bumnId, kunci("BID").slice(0, 20)],
  );

  const sesi = new Map<string, string>();
  for (const role of ROLE_UNTUK_SESI) {
    const user = role === "MAKER_B" ? f.users.MAKER_B : f.users[role];
    sesi.set(role, await f.login(user.username));
  }

  // The second approver. Built the way the harness builds its own users --
  // real argon2 hash, real `user_role` grant -- so it logs in through the same
  // path and resolves the same principal.
  const passwordHash = await f.ctx.auth.service.hashPassword(TEST_PASSWORD);
  const namaPusat2 = `adminpusat2.${f.suffix}`;
  const pusat2Rows = await db.query<{ id: string }>(
    `INSERT INTO app_user (cabang_id, nip, nama, email, username, password_hash, aktif)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id::text AS id`,
    [
      f.pusat.id,
      `admin-pusat-2-${f.suffix}`,
      `Uji ADMIN_PUSAT 2 ${f.suffix}`,
      `${namaPusat2}@uji.local`,
      namaPusat2,
      passwordHash,
    ],
  );
  const adminPusat2Id = pusat2Rows[0]!.id;
  await db.query(
    `INSERT INTO user_role (user_id, role_id)
     SELECT $1, id FROM app_role WHERE kode = 'ADMIN_PUSAT' AND deleted_at IS NULL`,
    [adminPusat2Id],
  );
  sesi.set(ADMIN_PUSAT_2, await f.login(namaPusat2));

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
    sektorId: sektorRows[0]!.id,
    bidangId: bidangRows[0]!.id,
    akunBebanId,
    akunKasId,
    akunKode: akun,
    periodeOpenId,
    adminPusat2Id,
    panggil,
    ok,
  };
}
