// THE WORLD THE SPEC 16 ACCEPTANCE SUITE RUNS IN.
//
// Spec Bagian 16 lists 24 scenarios and calls them the definition of done. This
// folder runs them as PROOF rather than as a claim, and this file is the ground
// it stands on.
//
// FOUR RULES, and they are the reason this file exists instead of importing one
// of the module fixtures next door.
//
//   1. THE APP IS THE SHIPPED APP. It comes from `createApp` in core/app.ts,
//      through ../testing/harness, with only cost knobs overridden (argon2
//      parameters, portal ceilings, Redis namespace). Nothing is stubbed, no
//      route is re-registered, no guard is skipped.
//
//   2. AN OUTSIDE CHECK DOES NOT INHERIT THE FIXTURES OF THE CODE IT CHECKS.
//      modules/pumk/rute-test-support.ts and modules/nonpumk/rute-test-support.ts
//      each build most of this world already. Reusing one would make the
//      acceptance run depend on the same author's idea of a valid starting
//      state, which is exactly the confusion Bagian 16 exists to break. What IS
//      reused is the SHIPPED seed (`seedCoaDanEventMapping`,
//      `seedMasterProgram`): those are production code paths, run by
//      `bun run db:seed`, not test scaffolding.
//
//   3. ONE WORLD, ONE ENTITY, ONE CALENDAR. Every scenario below runs against
//      the same `bumn`, the same three branches and the same twelve monthly
//      periods, in scenario order, because Bagian 16's list is a narrative:
//      scenario 7 reads the card of the loan scenario 4 created, and scenario 14
//      reads the balance sheet of the month scenario 12 closed. Splitting them
//      into independent fixtures would test 24 unrelated things and prove none
//      of the sequence.
//
//   4. NO CLEANUP, AND UNIQUE KEYS EVERYWHERE. `bun run db:reset` is run by
//      other agents mid-suite and the test database is shared, so every business
//      key here carries a random suffix and nothing depends on a row another
//      file left behind. Teardown is the harness's soft delete of the `bumn`,
//      for the FIXTURE LEAK reason documented in ../testing/harness.ts.
import { createFixture, tutupSemuaFixture, type Fixture, type TestCabang } from "../testing/harness";
import { seedCoaDanEventMapping } from "../seed/event-jurnal";
import { seedMasterProgram } from "../seed/master-program";

export type { Fixture };
export { tutupSemuaFixture };

/** Whole rupiah as the decimal string every money boundary in this API takes. */
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

export type Peran =
  | "MAKER"
  | "CHECKER"
  | "APPROVER"
  | "ADMIN_CABANG"
  | "ADMIN_PUSAT"
  | "AUDITOR"
  | "MAKER_B"
  | "ADMIN_PUSAT_2";

export interface DuniaSpec16 {
  f: Fixture;
  kodeEntitas: string;
  sektorId: string;
  bidangA: string;
  bidangB: string;
  sdg1: string;
  sdg2: string;
  akunKasId: string;
  akunBebanId: string;
  akunPiutangId: string;
  akunKode: Map<string, string>;
  /** The second head-office account, the only one that may approve an RKA the first one drafted. */
  adminPusat2Id: string;
  /** Period id by `YYYY-MM`, for every month of 2026. */
  periode: Map<string, string>;
  buatMitra(opsi?: { cabang?: TestCabang; nama?: string; nik?: string }): Promise<MitraUji>;
  /** Raw `Response`, so a scenario can assert a refusal. */
  panggil(role: Peran, path: string, opsi?: { method?: string; body?: unknown }): Promise<Response>;
  /** Same call, asserting 2xx, returning the parsed body. */
  ok<T>(role: Peran, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
  /** The body of a refusal, with its status. */
  tolak(
    role: Peran,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<{ status: number; code?: string; kodeDomain?: string; error?: string }>;
}

const KODE_KAS = "1.1.01";
const KODE_PIUTANG = "1.1.03";
const KODE_BEBAN = "5.1.03";

/** Every role the harness itself creates. `ADMIN_PUSAT_2` is made below. */
const PERAN_HARNESS = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
  "MAKER_B",
] as const;

export async function buatDuniaSpec16(): Promise<DuniaSpec16> {
  const f = await createFixture({
    // Cost knob only. The public portal's own ceilings are proved by
    // modules/portal/portal-batas.test.ts against a fixture that does NOT raise
    // them; raising them here keeps scenario 21 from measuring the rate limiter.
    portalLimits: { pengajuanPerIp: 200, pengajuanPerIpHarian: 200, rutePengajuan: 200 },
  });
  const db = f.db;

  // Unique branch codes. `no_proposal` is `{urutan}/{jenis}/{kode_cabang}/...`
  // and its unique index spans the whole table with no bumn column, so two
  // worlds sharing "01" collide on a key that has nothing to do with the test.
  for (const cabang of [f.pusat, f.cabangA, f.cabangB]) {
    const kodeBaru = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.query(`UPDATE cabang SET kode = $2 WHERE id = $1`, [cabang.id, kodeBaru]);
    cabang.kode = kodeBaru;
  }

  // Monthly OPEN periods for 2026 and 2027. Deliberately starting at 2026-01
  // and no earlier: closing prerequisite 1 is "the preceding period is closed",
  // and 2026-01 is the first period this entity has, so the chain has a head.
  // 2027 exists because scenario 6's over-payment is only an over-payment once
  // every instalment of a 12-month schedule has fallen due.
  const periode = new Map<string, string>();
  for (const tahun of [2026, 2027]) {
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      const mm = String(bulan).padStart(2, "0");
      const akhir = new Date(Date.UTC(tahun, bulan, 0)).toISOString().slice(0, 10);
      const rows = await db.query<{ id: string }>(
        `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING id::text AS id`,
        [f.bumnId, tahun, bulan, `${tahun}-${mm}-01`, akhir],
      );
      periode.set(`${tahun}-${mm}`, rows[0]!.id);
    }
  }

  const { akun } = await seedCoaDanEventMapping(db, f.bumnId, f.users.ADMIN_PUSAT.id);
  const ambil = (kode: string): string => {
    const id = akun.get(kode);
    if (!id) throw new Error(`dunia spec 16: akun ${kode} tidak ada setelah seedCoaInti`);
    return id;
  };

  await seedMasterProgram(db, f.bumnId, f.users.ADMIN_PUSAT.id);

  const bidang = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM bidang_non_pumk
      WHERE bumn_id = $1 AND deleted_at IS NULL ORDER BY urutan LIMIT 2`,
    [f.bumnId],
  );
  if (bidang.length < 2) throw new Error("dunia spec 16: butuh minimal dua bidang Non PUMK");
  const sdg = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM sdg WHERE deleted_at IS NULL ORDER BY nomor LIMIT 2`,
  );
  if (sdg.length < 2) throw new Error("dunia spec 16: butuh minimal dua SDG");

  const sektorRows = await db.query<{ id: string }>(
    `INSERT INTO sektor_pumk (bumn_id, kode, nama) VALUES ($1, $2, 'Perdagangan (spec 16)')
     RETURNING id::text AS id`,
    [f.bumnId, kunci("SEK").slice(0, 20)],
  );

  const bumnRows = await db.query<{ kode: string }>(`SELECT kode FROM bumn WHERE id = $1::uuid`, [
    f.bumnId,
  ]);

  // A SECOND ADMIN PUSAT, and it is not padding.
  // `rka.pemisahan_tugas_persetujuan` is on by default, so `setujuiRka` refuses
  // the person who drafted the version (`KONFLIK_MAKER_APPROVER`), and
  // `admin.rka.approve` is held by ADMIN_PUSAT alone. With one head-office
  // account this world could never hold an approved RKA baseline, and scenario
  // 18 would be untestable for a reason that is about the cast, not the code.
  // SEED.md makes the same argument for the demo world's `adminpusat2`.
  const pusat2 = await (async () => {
    const username = `adminpusat2.${f.suffix}`;
    const hash = await f.ctx.auth.service.hashPassword("UjiCoba#12345");
    const rows = await db.query<{ id: string }>(
      `INSERT INTO app_user (cabang_id, nip, nama, email, username, password_hash, aktif)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id::text AS id`,
      [
        f.pusat.id,
        `adminpusat2-${f.suffix}`,
        `Uji ADMIN_PUSAT 2 ${f.suffix}`,
        `${username}@uji.local`,
        username,
        hash,
      ],
    );
    await db.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT $1, id FROM app_role WHERE kode = 'ADMIN_PUSAT' AND deleted_at IS NULL`,
      [rows[0]!.id],
    );
    return { id: rows[0]!.id, username };
  })();

  const sesi = new Map<Peran, string>();
  for (const role of PERAN_HARNESS) {
    const user = role === "MAKER_B" ? f.users.MAKER_B : f.users[role];
    sesi.set(role, await f.login(user.username));
  }
  sesi.set("ADMIN_PUSAT_2", await f.login(pusat2.username));

  async function buatMitra(
    opsi: { cabang?: TestCabang; nama?: string; nik?: string } = {},
  ): Promise<MitraUji> {
    const cabang = opsi.cabang ?? f.cabangA;
    const kode = kunci("MTR").slice(0, 24);
    const nik =
      opsi.nik ?? crypto.randomUUID().replace(/\D/g, "").padEnd(16, "7").slice(0, 16);
    const nama = opsi.nama ?? `Mitra ${kode}`;
    const rows = await db.query<{ id: string }>(
      `INSERT INTO mitra (cabang_id, kode_mitra, nama_lengkap, nik, sektor_id, nama_usaha, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'CALON') RETURNING id::text AS id`,
      [cabang.id, kode, nama, nik, sektorRows[0]!.id, `Usaha ${kode}`],
    );
    return { id: rows[0]!.id, kodeMitra: kode, nama, nik };
  }

  function cookie(role: Peran): string {
    const c = sesi.get(role);
    if (!c) throw new Error(`tidak ada sesi untuk ${role}`);
    return c;
  }

  async function panggil(
    role: Peran,
    path: string,
    opsi: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return f.request(path, {
      method: opsi.method ?? (opsi.body === undefined ? "GET" : "POST"),
      cookie: cookie(role),
      ...(opsi.body !== undefined ? { body: opsi.body } : {}),
    });
  }

  async function ok<T>(
    role: Peran,
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
    role: Peran,
    path: string,
    opsi: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; code?: string; kodeDomain?: string; error?: string }> {
    const res = await panggil(role, path, opsi);
    const teks = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(teks) as Record<string, unknown>;
    } catch {
      body = { error: teks };
    }
    return {
      status: res.status,
      code: body.code as string | undefined,
      kodeDomain: body.kodeDomain as string | undefined,
      error: body.error as string | undefined,
    };
  }

  return {
    f,
    kodeEntitas: bumnRows[0]!.kode,
    sektorId: sektorRows[0]!.id,
    bidangA: bidang[0]!.id,
    bidangB: bidang[1]!.id,
    sdg1: sdg[0]!.id,
    sdg2: sdg[1]!.id,
    akunKasId: ambil(KODE_KAS),
    akunBebanId: ambil(KODE_BEBAN),
    akunPiutangId: ambil(KODE_PIUTANG),
    akunKode: akun,
    adminPusat2Id: pusat2.id,
    periode,
    buatMitra,
    panggil,
    ok,
    tolak,
  };
}
