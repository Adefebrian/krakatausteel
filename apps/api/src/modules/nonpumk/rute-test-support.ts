// Fixture for the Non PUMK ROUTE tests. NOT a *.test.ts file, so `bun test`
// never runs it on its own.
//
// WHY IT IS NOT ./test-support.ts
// That file builds a world for the ENGINE: its users carry a fake password
// hash, so none of them can log in, and it drives the engine directly with a
// hand-built `NonPumkContext`. A route test must not do either. Spec 2 rule 4
// is "call the endpoint directly with the wrong role", which is only true if
// the role arrives the way it arrives in production: a real login, a real
// session cookie, a real principal resolved from Redis and Postgres, through
// the real guard chain. So this file composes:
//
//   ../../testing/harness   the REAL app from core/app.ts's `createApp`, real
//                           users for all six roles plus a second branch, and
//                           a `login()` that returns a cookie;
//   ../../seed/event-jurnal the SHIPPED chart of accounts and the SHIPPED event
//                           mappings, by the same code path `bun run db:seed`
//                           uses, so PENYALURAN_NON_PUMK really does take its
//                           debit from the payload and PENGEMBALIAN_SISA takes
//                           its credit the same way;
//   ../../seed/master-program the SHIPPED seven bidang and seventeen SDG, which
//                           spec 9.2 makes MANDATORY on a proposal.
//
// Nothing here asserts a business rule and nothing here stands in for a
// collaborator: the journal engine and the Non PUMK engine are the ones
// `createApp` wired, so a route test exercises the same graph the server runs.
// A double may stand in for a FAILURE, never for a VALIDATION.
//
// EVERY FIXTURE IS UNIQUE, for the reason the harness gives: `bun run db:reset`
// is run by other agents mid-suite and test files share one Postgres. Each
// world gets its own bumn (from the harness), its own periods and its own
// chart of accounts. Nothing is cleaned up afterwards, and nothing depends on
// rows another file left behind.
//
// THE CONFIGURATION IS THE SHIPPED ONE, deliberately. migrations/0022 ships the
// four Non PUMK parameters globally, and this fixture READS them rather than
// writing an override: the amounts these tests use have to be inside the range
// an operator would really face, and a fixture that widened the range first
// would hide a shipped bound that is too narrow to use.
import { createFixture, type Fixture, type TestCabang } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { seedMasterProgram } from "../../seed/master-program";

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

export interface DuniaRuteNonPumk {
  f: Fixture;
  /** Session cookies, keyed the way the tests read: `as("MAKER")`. */
  sesi: Map<string, string>;
  /** Two bidang from the SHIPPED seven, so a bidang filter has something to exclude. */
  bidangA: string;
  bidangB: string;
  /** Two SDG from the SHIPPED seventeen. */
  sdg1: string;
  sdg2: string;
  /** Postable cash account of this world's chart of accounts (1.1.01). */
  akunKasId: string;
  /** Postable BEBAN account, "Beban Penyaluran Non PUMK" (5.1.03). */
  akunBebanId: string;
  akunKode: Map<string, string>;
  /** `GET`/`POST` as a role, returning the raw Response. */
  panggil(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<Response>;
  /** Same, but asserts a 2xx and returns the parsed body. */
  ok<T>(role: string, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
  /** A proposal in the given branch, carried to the given status by real HTTP calls. */
  buatProposal(opsi?: {
    cabang?: TestCabang;
    peran?: string;
    jumlah?: string;
    bidangId?: string;
    sdgId?: string;
    tanggal?: string;
    nama?: string;
    judul?: string;
  }): Promise<{ id: string; noProposal: string }>;
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
const KODE_BEBAN = "5.1.03";

export async function buatDuniaRuteNonPumk(): Promise<DuniaRuteNonPumk> {
  const f = await createFixture();
  const db = f.db;

  // UNIQUE BRANCH CODES, and this is not cosmetic.
  //
  // The harness gives every fixture the same branch codes ("00", "01", "02"),
  // which is harmless for its own tests. It is not harmless here: `no_proposal`
  // is built by modules/nomor as
  // `{urutan}/{jenis}/{kode_cabang}/{bulan_romawi}/{tahun}` and
  // `nonpumk_proposal_no_uq` is unique over the WHOLE table, with no bumn
  // column in it. Two worlds in one database would both allocate
  // `0001/PROPOSAL_NON_PUMK/01/I/2026` and the second would fail on a duplicate
  // key that has nothing to do with what it was testing.
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
  const akunBebanId = akun.get(KODE_BEBAN);
  if (!akunKasId) throw new Error(`fixture: akun ${KODE_KAS} tidak ada setelah seedCoaInti`);
  if (!akunBebanId) throw new Error(`fixture: akun ${KODE_BEBAN} tidak ada setelah seedCoaInti`);

  // The SHIPPED master data, by the same function `bun run db:seed` calls. The
  // seventeen SDG are global and idempotent, so a second world adds none.
  await seedMasterProgram(db, f.bumnId, f.users.ADMIN_PUSAT.id);

  const bidang = await db.query<{ id: string; kode: string }>(
    `SELECT id::text AS id, kode FROM bidang_non_pumk
      WHERE bumn_id = $1 AND deleted_at IS NULL ORDER BY urutan LIMIT 2`,
    [f.bumnId],
  );
  if (bidang.length < 2) throw new Error("fixture: butuh minimal dua bidang Non PUMK");

  const sdg = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM sdg WHERE deleted_at IS NULL ORDER BY nomor LIMIT 2`,
  );
  if (sdg.length < 2) throw new Error("fixture: butuh minimal dua SDG");

  const sesi = new Map<string, string>();
  for (const role of ROLE_UNTUK_SESI) {
    const user = role === "MAKER_B" ? f.users.MAKER_B : f.users[role];
    sesi.set(role, await f.login(user.username));
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

  async function buatProposal(
    opsi: {
      cabang?: TestCabang;
      peran?: string;
      jumlah?: string;
      bidangId?: string;
      sdgId?: string;
      tanggal?: string;
      nama?: string;
      judul?: string;
    } = {},
  ): Promise<{ id: string; noProposal: string }> {
    const cabang = opsi.cabang ?? f.cabangA;
    const peran = opsi.peran ?? (cabang.id === f.cabangB.id ? "MAKER_B" : "MAKER");
    return ok<{ id: string; noProposal: string }>(peran, "/nonpumk/proposal", {
      body: {
        cabangId: cabang.id,
        tanggalProposal: opsi.tanggal ?? "2026-01-05",
        namaPemohon: opsi.nama ?? `Yayasan ${kunci("YYS")}`,
        bidangId: opsi.bidangId ?? bidang[0]!.id,
        sdg: [{ sdgId: opsi.sdgId ?? sdg[0]!.id, bobot: "1.000000" }],
        judulProgram: opsi.judul ?? "Program bantuan sarana",
        jumlahDiajukan: opsi.jumlah ?? rp(50_000_000),
        penerimaManfaatEstimasi: 120,
      },
    });
  }

  return {
    f,
    sesi,
    bidangA: bidang[0]!.id,
    bidangB: bidang[1]!.id,
    sdg1: sdg[0]!.id,
    sdg2: sdg[1]!.id,
    akunKasId,
    akunBebanId,
    akunKode: akun,
    panggil,
    ok,
    buatProposal,
  };
}
