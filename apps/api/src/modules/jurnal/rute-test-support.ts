// Fixture for the JOURNAL ROUTE tests. NOT a *.test.ts file, so `bun test`
// never runs it on its own.
//
// WHY IT IS NOT ./test-support.ts
// That file builds a world for the ENGINE: it drives the engine directly with a
// hand-built `JurnalContext` on a `bun:sql` port, and its users cannot log in.
// A route test must not do either. Spec 2 rule 4 is "call the endpoint directly
// with the wrong role and make sure it is refused", which is only true if the
// role arrives the way it arrives in production: a real login, a real session
// cookie, a real principal resolved from Redis and Postgres, through the real
// guard chain. So this file composes:
//
//   ../../testing/harness   -- the REAL app from core/app.ts's `createApp`,
//                              real users for all six roles plus a second
//                              branch, and a `login()` that returns a cookie;
//   ../../seed/event-jurnal -- the SHIPPED chart of accounts, by the same code
//                              path `bun run db:seed` uses.
//
// Nothing here asserts a business rule and nothing here stands in for a
// collaborator: the journal engine behind these routes is the one `createApp`
// wired, which is also the one every business module posts through.
//
// EVERY FIXTURE IS UNIQUE, for the reason the harness gives: test files share
// one Postgres and another agent may reset it mid-run. Each world gets its own
// bumn (from the harness), its own branch codes, its own periods and its own
// chart of accounts. Nothing is cleaned up and nothing depends on rows another
// file left behind.
import { createFixture, tutupSemuaFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";

export type { Fixture };
export { tutupSemuaFixture };

/** Whole rupiah -> the `Uang` shape the API takes. `rp(1_250_000)` = "1250000.00". */
export function rp(rupiahBulat: number): string {
  if (!Number.isInteger(rupiahBulat)) {
    throw new Error(`rp() hanya menerima rupiah bulat, dapat ${rupiahBulat}`);
  }
  return `${rupiahBulat}.00`;
}

/** The financial year every journal in these tests is dated in. */
export const TAHUN_JURNAL = 2026;

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

export interface DuniaRuteJurnal {
  f: Fixture;
  sesi: Map<string, string>;
  /** Twelve OPEN months of `TAHUN_JURNAL`, keyed by month number. */
  periode: Map<number, PeriodeUji>;
  akunBebanId: string;
  akunKasId: string;
  akunKode: Map<string, string>;
  /** `GET`/`POST` as a role, returning the raw Response. */
  panggil(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<Response>;
  /** Same, but asserts a 2xx and returns the parsed body. */
  ok<T>(role: string, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
  /** Asserts a 4xx and returns the status plus the body's `kodeDomain`. */
  tolak(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<{ status: number; kodeDomain: string; error: string; detail?: unknown }>;
  /** A valid two-line UMUM body: debit an expense, credit cash. */
  bodyUmum(tanggal: string, nilai: string, keterangan?: string): Record<string, unknown>;
  /** Closes a period straight in the table, past every engine. */
  tutupPeriodeLangsung(periodeId: string): Promise<void>;
  /** Reads a journal's status straight from the table, past every engine. */
  statusJurnal(id: string): Promise<string | null>;
  /** Counts the LIVE lines of a journal, straight from the table. */
  jumlahBaris(id: string): Promise<number>;
}

/** The shape every write route answers with, as far as these tests read it. */
export interface JurnalHttp {
  id: string;
  noJurnal: string;
  jenis: string;
  status: string;
  tanggalTransaksi: string;
  periodeId: string;
  cabangId: string;
  keterangan: string | null;
  totalDebit: string;
  totalKredit: string;
  version: number;
  reversalOfJurnalId: string | null;
  reversedByJurnalId: string | null;
  baris: Array<{ akunId: string; debit: string; kredit: string; urutan: number }>;
}

export async function buatDuniaRuteJurnal(): Promise<DuniaRuteJurnal> {
  const f = await createFixture();
  const db = f.db;

  // UNIQUE BRANCH CODES, for the reason modules/closing's route fixture gives:
  // this world shares a database with every other, and a code collision
  // produces a failure that has nothing to do with what is being tested.
  // Rewritten BEFORE any login, so the principal each session resolves carries
  // the real code.
  for (const cabang of [f.pusat, f.cabangA, f.cabangB]) {
    const kodeBaru = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.query(`UPDATE cabang SET kode = $2 WHERE id = $1`, [cabang.id, kodeBaru]);
    cabang.kode = kodeBaru;
  }

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
    [f.bumnId, TAHUN_JURNAL],
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
  const akunBebanId = akun.get(KODE_BEBAN_OPERASIONAL);
  const akunKasId = akun.get(KODE_KAS);
  if (!akunBebanId || !akunKasId) {
    throw new Error("fixture rute jurnal: chart of accounts inti tidak lengkap");
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

  async function tolak(
    role: string,
    path: string,
    opsi: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; kodeDomain: string; error: string; detail?: unknown }> {
    const res = await panggil(role, path, opsi);
    if (res.status < 400 || res.status >= 500) {
      throw new Error(
        `${path} sebagai ${role} seharusnya ditolak 4xx, tapi menjawab ${res.status}: ` +
          `${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      kodeDomain?: string;
      code?: string;
      error?: string;
      detail?: unknown;
    };
    return {
      status: res.status,
      kodeDomain: body.kodeDomain ?? body.code ?? "",
      error: body.error ?? "",
      detail: body.detail,
    };
  }

  return {
    f,
    sesi,
    periode,
    akunBebanId,
    akunKasId,
    akunKode: akun,
    panggil,
    ok,
    tolak,

    bodyUmum(tanggal, nilai, keterangan = "Jurnal umum uji rute") {
      return {
        cabangId: f.cabangA.id,
        jenis: "UMUM",
        tanggalTransaksi: tanggal,
        keterangan,
        baris: [
          { akunId: akunBebanId, debit: nilai, keterangan: "Beban operasional" },
          { akunId: akunKasId, kredit: nilai, keterangan: "Kas keluar" },
        ],
      };
    },

    async tutupPeriodeLangsung(periodeId) {
      // Straight UPDATE rather than the closing engine: what these tests need
      // is a CLOSED period, and dragging spec 8's whole checklist in would make
      // a journal-route test fail for a closing reason.
      await db.query(
        `UPDATE periode SET status = 'CLOSED', closed_at = now(), closed_by = $2 WHERE id = $1`,
        [periodeId, f.users.ADMIN_PUSAT.id],
      );
    },

    async statusJurnal(id) {
      const rows = await db.query<{ status: string; deleted: boolean }>(
        `SELECT status, (deleted_at IS NOT NULL) AS deleted FROM jurnal WHERE id = $1::uuid`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return row.deleted ? `${row.status}+DELETED` : row.status;
    },

    async jumlahBaris(id) {
      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jurnal_baris
          WHERE jurnal_id = $1::uuid AND deleted_at IS NULL`,
        [id],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}
