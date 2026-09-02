// Fixture for the CLOSING ROUTE tests. NOT a *.test.ts file, so `bun test`
// never runs it on its own.
//
// WHY IT IS NOT ./test-support.ts
// That file builds a world for the ENGINE: it drives the engine directly with a
// hand-built `ClosingContext` and its users cannot log in. A route test must
// not do either. Spec 2 rule 4 is "call the endpoint directly with the wrong
// role and make sure it is refused", which is only true if the role arrives the
// way it arrives in production: a real login, a real session cookie, a real
// principal resolved from Redis and Postgres, through the real guard chain. So
// this file composes:
//
//   ../../testing/harness   -- the REAL app from core/app.ts's `createApp`,
//                              real users for all six roles plus a second
//                              branch, and a `login()` that returns a cookie;
//   ../../seed/event-jurnal -- the SHIPPED chart of accounts and the SHIPPED
//                              event mappings, by the same code path
//                              `bun run db:seed` uses.
//
// Nothing here asserts a business rule and nothing here stands in for a
// collaborator: the closing engine is the one `createApp` wired, reaching the
// ledger through the one journal engine, so a route test exercises the same
// graph the server runs.
//
// THE CONFIGURATION IS THE SHIPPED CONFIGURATION, NOT A FIXTURE OPINION.
// Unlike ./test-support.ts, this world seeds NO bumn-scoped `konfigurasi` rows,
// no `kolektibilitas_range` and no `penyisihan_rate`. It does not need to:
// migrations/0004 ships the global (bumn_id NULL) rows for every key spec 8
// reads, plus the day bands and the allowance rates, and `ensureRbac` in the
// harness seeds the capability keys added after the spec
// (`akuntansi.mode_penyisihan`, `akuntansi.penyisihan_min_bulan_histori`).
// A route test that seeded its own parameters would be asserting against its
// own opinion of what ships; this one fails if the shipped defaults ever stop
// being enough to close a month, which is worth knowing.
//
// WHY THERE IS NO AKAD IN THIS WORLD
// The arithmetic of spec 8.1, 8.2 and 8.3 over a real portfolio is pinned by
// nine engine test files in this folder, each with a real akad, a real schedule
// from the real instalment engine and real arrears. Rebuilding that through
// HTTP would duplicate it and would test the PUMK routes rather than these. A
// month with no akad still exercises every route here end to end, and the
// checklist still passes legitimately: check 4 reads the run header, check 5
// reads the per-branch `penyisihan_periode` row that spec 8.2 writes even for a
// nil movement, and check 6 passes on "kolektibilitas ran and there is no
// candidate" rather than on a short circuit. What this world DOES carry is a
// real POSTED journal, so the frozen trial balance spec 16 scenario 12 checks
// is not empty.
//
// EVERY FIXTURE IS UNIQUE, for the reason the harness gives: test files share
// one Postgres and another agent may reset it mid-run. Each world gets its own
// bumn (from the harness), its own branch codes, its own periods and its own
// chart of accounts. Nothing is cleaned up and nothing depends on rows another
// file left behind.
import {
  createFixture,
  tutupSemuaFixture,
  type Fixture,
} from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import type { JurnalContext } from "../jurnal/index";

export type { Fixture };
// Re-exported so a test file that uses this world can close it with one
// `afterAll(tutupSemuaFixture)` and one import. See the FIXTURE LEAK note in
// ../../testing/harness.ts.
export { tutupSemuaFixture };

/** Whole rupiah -> the `Uang` shape the API takes. `rp(1_250_000)` = "1250000.00". */
export function rp(rupiahBulat: number): string {
  if (!Number.isInteger(rupiahBulat)) {
    throw new Error(`rp() hanya menerima rupiah bulat, dapat ${rupiahBulat}`);
  }
  return `${rupiahBulat}.00`;
}

/** The financial year every case in these tests closes inside. */
export const TAHUN_CLOSING = 2026;

const ROLE_UNTUK_SESI = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
  "MAKER_B",
] as const;

/** Accounts from the SHIPPED core COA that the journals below need. */
const KODE_BEBAN_OPERASIONAL = "5.1.04";
const KODE_KAS = "1.1.01";

export interface PeriodeUji {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
}

export interface DuniaRuteClosing {
  f: Fixture;
  sesi: Map<string, string>;
  /** Twelve OPEN months of `TAHUN_CLOSING`, keyed by month number. */
  periode: Map<number, PeriodeUji>;
  akunBebanOperasionalId: string;
  akunKasId: string;
  /** Every account id of this world's chart, keyed by code. */
  akunKode: Map<string, string>;
  /** `GET`/`POST` as a role, returning the raw Response. */
  panggil(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<Response>;
  /** Same, but asserts a 2xx and returns the parsed body. */
  ok<T>(role: string, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
  /**
   * The three preparatory steps of spec 8, DRIVEN THROUGH HTTP as the role that
   * holds each code. Leaves the period ready to close.
   */
  siapkanTutup(periodeId: string): Promise<void>;
  /**
   * A DRAFT journal dated inside a period, through the REAL ledger engine the
   * app wired. modules/jurnal has no HTTP surface yet (see core/app.ts), so
   * this is the engine call the future journal screen will make.
   */
  buatJurnalDraft(tanggal: string, nilai: string): Promise<{ id: string; noJurnal: string }>;
  postingJurnalDraft(jurnalId: string): Promise<{ id: string; status: string }>;
  /** Posts BEBAN_OPERASIONAL: debit an expense, credit cash. Drives cash DOWN. */
  postingBebanOperasional(tanggal: string, nilai: string): Promise<{ id: string }>;
  /** Posts ALOKASI_DANA_BUMN_PEMBINA: debit cash, credit income. Funds the entity. */
  postingAlokasiDana(tanggal: string, nilai: string): Promise<{ id: string }>;
  /** Reads the period's status straight from the table, past every engine. */
  statusPeriode(periodeId: string): Promise<string>;
  /** Row count of the frozen trial balance, straight from the table. */
  jumlahSaldoBeku(periodeId: string): Promise<number>;
}

export async function buatDuniaRuteClosing(): Promise<DuniaRuteClosing> {
  const f = await createFixture();
  const db = f.db;

  // UNIQUE BRANCH CODES. The harness gives every fixture "00", "01", "02",
  // which is harmless for its own tests and not harmless here: this world
  // shares a database with every other, and a code collision produces a failure
  // that has nothing to do with what is being tested. Rewritten BEFORE any
  // login, so the principal each session resolves carries the real code.
  for (const cabang of [f.pusat, f.cabangA, f.cabangB]) {
    const kodeBaru = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.query(`UPDATE cabang SET kode = $2 WHERE id = $1`, [cabang.id, kodeBaru]);
    cabang.kode = kodeBaru;
  }

  // Twelve monthly OPEN periods. January of `TAHUN_CLOSING` is the EARLIEST
  // period of this bumn, which is what makes closing it legal at all: invariant
  // 6 (sequential close) has nothing earlier to complain about.
  //
  // ONE statement, not twelve round trips. `generate_series` builds the month
  // windows in Postgres, which is also the only place that agrees with
  // `periode_window_ck` about the last day of a month without a second
  // implementation of the calendar in TypeScript.
  const barisPeriode = await db.query<{
    id: string;
    tahun: number;
    bulan: number;
    mulai: string;
    akhir: string;
  }>(
    `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
     SELECT $1,
            extract(year from m)::smallint,
            extract(month from m)::smallint,
            m::date,
            (m + interval '1 month' - interval '1 day')::date,
            'OPEN'
       FROM generate_series(
              make_date($2::int, 1, 1),
              make_date($2::int, 12, 1),
              interval '1 month') AS m
     RETURNING id::text AS id, tahun, bulan,
               tanggal_mulai::text AS mulai, tanggal_akhir::text AS akhir`,
    [f.bumnId, TAHUN_CLOSING],
  );
  const periode = new Map<number, PeriodeUji>();
  for (const row of barisPeriode) {
    periode.set(row.bulan, {
      id: row.id,
      tahun: row.tahun,
      bulan: row.bulan,
      tanggalMulai: row.mulai,
      tanggalAkhir: row.akhir,
    });
  }

  const { akun } = await seedCoaDanEventMapping(db, f.bumnId, f.users.ADMIN_PUSAT.id);
  const akunBebanOperasionalId = akun.get(KODE_BEBAN_OPERASIONAL);
  const akunKasId = akun.get(KODE_KAS);
  if (!akunBebanOperasionalId || !akunKasId) {
    throw new Error("fixture rute closing: chart of accounts inti tidak lengkap");
  }

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

  // The ledger context for the two journal helpers. ADMIN_PUSAT, because the
  // journal engine checks its own permissions and this is a fixture arranging
  // the world rather than the thing under test.
  const ctxJurnal: JurnalContext = {
    userId: f.users.ADMIN_PUSAT.id,
    cabangId: f.pusat.id,
    bumnId: f.bumnId,
    permissions: ["jurnal.create", "jurnal.post", "jurnal.view"],
    cabangDalamScope: [f.pusat.id, f.cabangA.id, f.cabangB.id],
  };

  return {
    f,
    sesi,
    periode,
    akunBebanOperasionalId,
    akunKasId,
    akunKode: akun,
    panggil,
    ok,

    async siapkanTutup(periodeId) {
      // Each step as a role that holds the code for it, so the sequence itself
      // is evidence that the permission split works end to end.
      await ok("APPROVER", `/closing/periode/${periodeId}/kolektibilitas`, { body: {} });
      await ok("APPROVER", `/closing/periode/${periodeId}/penyisihan`, { body: {} });
      await ok("APPROVER", `/closing/periode/${periodeId}/akrual`, { body: {} });
    },

    async buatJurnalDraft(tanggal, nilai) {
      const j = await f.ctx.jurnal.buatJurnal(
        {
          cabangId: f.pusat.id,
          jenis: "UMUM",
          tanggalTransaksi: tanggal,
          keterangan: "Jurnal umum DRAFT (fixture rute closing, spec 8.4 butir 2)",
          baris: [
            { akunId: akunBebanOperasionalId, debit: nilai },
            { akunId: akunKasId, kredit: nilai },
          ],
        },
        ctxJurnal,
      );
      return { id: j.id, noJurnal: j.noJurnal };
    },

    async postingJurnalDraft(jurnalId) {
      const j = await f.ctx.jurnal.postingJurnal(jurnalId, ctxJurnal);
      return { id: j.id, status: j.status };
    },

    async postingBebanOperasional(tanggal, nilai) {
      const j = await f.ctx.jurnal.postingEvent(
        "BEBAN_OPERASIONAL",
        {
          cabangId: f.pusat.id,
          tanggalTransaksi: tanggal,
          nilai,
          keterangan: "Beban operasional (fixture rute closing)",
          akunDebitId: akunBebanOperasionalId,
          akunKasId,
        },
        ctxJurnal,
      );
      return { id: j.id };
    },

    async postingAlokasiDana(tanggal, nilai) {
      const j = await f.ctx.jurnal.postingEvent(
        "ALOKASI_DANA_BUMN_PEMBINA",
        {
          cabangId: f.pusat.id,
          tanggalTransaksi: tanggal,
          nilai,
          keterangan: "Alokasi dana BUMN Pembina (fixture rute closing)",
          akunKasId,
        },
        ctxJurnal,
      );
      return { id: j.id };
    },

    async statusPeriode(periodeId) {
      const rows = await db.query<{ status: string }>(
        `SELECT status FROM periode WHERE id = $1::uuid`,
        [periodeId],
      );
      const row = rows[0];
      if (!row) throw new Error(`periode ${periodeId} tidak ada`);
      return row.status;
    },

    async jumlahSaldoBeku(periodeId) {
      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM saldo_akun_periode WHERE periode_id = $1::uuid`,
        [periodeId],
      );
      return Number(rows[0]?.n ?? "0");
    },
  };
}
