// apps/api/src/modules/tools/test-support.ts
//
// Fixture builder for the tools engine tests (spec 9.6). NOT a *.test.ts file,
// so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// This module is almost entirely a claim about what four SHIPPED VIEWS return.
// `v_integritas_jurnal`, `v_integritas_jadwal`, `v_integritas_snapshot` and
// `v_rekonsiliasi_piutang` live in migrations/0015 and 0018; the last one is
// rebuilt on `v_ledger_baris`, whose predicate IS ADR 0010. A fake repository
// would prove nothing about any of it, and the checks would then be a second
// opinion about integrity rather than a window onto the database's own.
//
// WHY THE LEDGER IS WRITTEN BY THE REAL ENGINE
// modules/angsuran/test-support.ts records what the alternative cost: a pure
// double for the journal port hid two production-breaking defects behind
// sixteen green tests. Every journal below is posted by the REAL journal
// engine through `postingEvent`, so the receivable lines this module
// reconciles are the lines a disbursement actually produces. It is also not
// optional: `bun run check:boundaries` and migration 0020's posting-path
// trigger both refuse a raw ledger INSERT from here.
//
// THE DELIBERATE BREAKS ARE THE POINT OF THE FILE
// A check that has never been observed catching anything is a query somebody
// hopes is right. `rusakkan*` below each break exactly one invariant, by the
// smallest edit that produces it, so a failing check can be traced to the row
// the fixture broke. Two of the seven checks CANNOT be broken on the shipped
// schema (a CHECK constraint and a unique index make the bad state
// uncommittable); those have `buktikanDijagaDatabase*` helpers instead, which
// assert the database refuses, because "this check can never fire" is a claim
// that also deserves a test.
//
// WHY SO MUCH OF THIS RESEMBLES modules/rka/test-support.ts
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling
// module's internals, and that file is internal to modules/rka. The money
// helpers, the unique-key helper and the world builder are therefore
// re-declared here with the SAME semantics. When a shared test-support package
// appears, both collapse into it.
//
// NOTHING GLOBAL IS EVER TOUCHED. Every world gets its own bumn, branches,
// chart of accounts, periods, sectors and users under a random suffix, and the
// kolektibilitas ladder is broken by inserting a BUMN-SCOPED range for THIS
// world only. A closing test once blanked a global `konfigurasi` row to reach
// a guard and poisoned every world that ran afterwards, in every file, for the
// rest of the run.
import { createDbAdapter } from "../../core/adapters/db";
import { createJurnalModule, type JurnalEngine } from "../jurnal/index";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { permissionsForRole, seedRbac } from "../../seed/rbac";
import { createToolsEngine, type ToolsContext, type ToolsEngine, type Uang } from "./contract";
import type { DbPort } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Money. BigInt minor units internally, two-decimal strings at every boundary.
// ---------------------------------------------------------------------------

export function rp(rupiahBulat: number): Uang {
  if (!Number.isSafeInteger(rupiahBulat)) {
    throw new Error(`rp() hanya menerima bilangan bulat: ${rupiahBulat}`);
  }
  return sen(BigInt(rupiahBulat) * 100n);
}

export function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

const POLA_SEN = /^(-?)(\d+)\.(\d{2})$/;

export function keSen(nilai: string): bigint {
  const m = POLA_SEN.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2] as string) * 100n + BigInt(m[3] as string);
  return m[1] === "-" ? -besar : besar;
}

// ---------------------------------------------------------------------------
// Unique keys, so two runs without `db:reset` produce identical results
// ---------------------------------------------------------------------------

const JEJAK = Math.random().toString(36).slice(2, 8);
let urut = 0;

export function kunci(awalan: string): string {
  urut += 1;
  return `${awalan}-${JEJAK}-${String(urut).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CabangFixture {
  id: string;
  kode: string;
  nama: string;
}

export interface PeriodeFixture {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
}

export interface AkadFixture {
  akadId: string;
  noAkad: string;
  mitraId: string;
  proposalId: string;
  cabangId: string;
  pokok: Uang;
  tanggalAkad: string;
}

export type PeranUji =
  | "adminPusat"
  | "adminCabangA"
  | "adminCabangB"
  | "checker"
  | "maker";

export interface DuniaTools {
  db: DbPort;
  bumnId: string;
  cabangA: CabangFixture;
  cabangB: CabangFixture;
  userId: Record<PeranUji, string>;
  roleUntuk: Record<PeranUji, string>;
  ctx: Record<PeranUji, ToolsContext>;
  engine: ToolsEngine;
  jurnal: JurnalEngine;
  akunPiutangId: string;
  akunKasId: string;
  sektorId: string;
  tahun: number;
  periode(bulan: number): PeriodeFixture;

  /** A signed loan with a valid version-1 schedule. Not yet disbursed. */
  buatAkad(opsi: { cabangId: string; pokok: Uang; bulan?: number }): Promise<AkadFixture>;
  /** PENCAIRAN_PUMK through the REAL engine, so the receivable leg is real. */
  cairkan(akad: AkadFixture, opsi?: { nilai?: Uang; bulan?: number }): Promise<string>;
  /** A balanced DRAFT journal through the REAL engine. */
  buatJurnalDraft(opsi: { cabangId: string; nilai: Uang; bulan?: number }): Promise<string>;
  /** Posts, then reverses, a cash movement. Both journals stay in the ledger. */
  postingLaluReversal(opsi: { cabangId: string; nilai: Uang; bulan?: number }): Promise<{
    asli: string;
    pembalik: string;
  }>;

  // --- the deliberate breaks ------------------------------------------------
  /** Moves the sub ledger without a journal: spec 8.4 check 10 fails by `delta`. */
  rusakkanRekonsiliasi(akad: AkadFixture, delta: Uang): Promise<void>;
  /** Raises the akad principal, leaving version 1's schedule short. */
  rusakkanJadwal(akad: AkadFixture, delta: Uang): Promise<void>;
  /** Soft-deletes one line of a DRAFT journal: it now has 1 line, not 2. */
  rusakkanJurnal(jurnalId: string): Promise<void>;
  /** Closes a period that still holds a DRAFT journal. */
  tutupPeriode(bulan: number): Promise<void>;
  /** Inserts a bumn-scoped range that leaves a gap in the ladder. */
  rusakkanTanggaKolektibilitas(): Promise<string>;
  /**
   * Leaves Piutang Jasa Administrasi with a CREDIT balance, by posting the
   * credit half of the accrual cycle and never the debit. This is the shipped
   * defect reproduced through the real posting path, not a hand-written row:
   * see ADR 0018.
   */
  rusakkanPiutangJasaKredit(opsi: {
    cabangId: string;
    nilai: Uang;
    bulan?: number;
  }): Promise<string>;

  // --- the two that CANNOT be broken ---------------------------------------
  /** Asserts `pumk_akad_outstanding_pokok_check` refuses a negative balance. */
  cobaOutstandingNegatif(akad: AkadFixture): Promise<string>;
  /** Asserts `kolektibilitas_snapshot_uq` refuses a second snapshot. */
  cobaSnapshotGanda(akad: AkadFixture, bulan: number): Promise<string>;

  tutup(): Promise<void>;
}

async function satu<T>(db: DbPort, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) {
    throw new Error(`fixture tools: query tidak mengembalikan baris: ${sql}`);
  }
  return baris[0] as T;
}

function urlDbAman(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test tools butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!(url.split("?")[0] ?? "").endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture tools di database non-test: ${url}`);
  }
}

export const TAHUN_UJI = 2026;

export async function buatDuniaTools(): Promise<DuniaTools> {
  urlDbAman();
  const db = createDbAdapter();
  const jam = () => new Date(`${TAHUN_UJI}-06-15T04:00:00.000Z`);

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1)
     returning id::text as id`,
    [kunci("BUMN"), "PT Krakatau Steel (fixture tools)"],
  );

  async function buatCabang(nama: string, pusat: boolean): Promise<CabangFixture> {
    const kode = kunci("CBG");
    const row = await satu<{ id: string }>(
      db,
      `insert into cabang (bumn_id, kode, nama, is_pusat) values ($1, $2, $3, $4)
       returning id::text as id`,
      [bumn.id, kode, nama, pusat],
    );
    return { id: row.id, kode, nama };
  }

  const cabangA = await buatCabang("Kantor Pusat (fixture tools)", true);
  const cabangB = await buatCabang("Cabang B (fixture tools)", false);

  async function buatUser(nama: string, cabangId: string): Promise<string> {
    const u = await satu<{ id: string }>(
      db,
      `insert into app_user (cabang_id, nama, email, username, password_hash)
       values ($1, $2, $3, $4, 'x-not-a-real-hash') returning id::text as id`,
      [cabangId, nama, `${kunci("mail")}@example.test`, kunci("user")],
    );
    return u.id;
  }

  const userId: Record<PeranUji, string> = {
    adminPusat: await buatUser("Admin Pusat (fixture tools)", cabangA.id),
    adminCabangA: await buatUser("Admin Cabang A (fixture tools)", cabangA.id),
    adminCabangB: await buatUser("Admin Cabang B (fixture tools)", cabangB.id),
    checker: await buatUser("Checker (fixture tools)", cabangA.id),
    maker: await buatUser("Maker (fixture tools)", cabangA.id),
  };

  // The SHIPPED permission catalogue, the SHIPPED roles and the SHIPPED grant
  // matrix. Never a literal permission list: a fixture that grants itself the
  // code it wants proves only that the fixture agrees with itself.
  await seedRbac(db);
  const roleUntuk: Record<PeranUji, string> = {
    adminPusat: "ADMIN_PUSAT",
    adminCabangA: "ADMIN_CABANG",
    adminCabangB: "ADMIN_CABANG",
    checker: "CHECKER",
    maker: "MAKER",
  };
  const izinRole = new Map<string, string[]>();
  for (const kodeRole of new Set(Object.values(roleUntuk))) {
    izinRole.set(kodeRole, await permissionsForRole(db, kodeRole));
  }
  for (const [nama, kodeRole] of Object.entries(roleUntuk)) {
    await db.query(
      `insert into user_role (user_id, role_id)
       select $1, r.id from app_role r where r.kode = $2 and r.deleted_at is null
       on conflict (user_id, role_id) do nothing`,
      [userId[nama as PeranUji], kodeRole],
    );
  }

  const periodeIndeks = new Map<number, PeriodeFixture>();
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
       from generate_series(make_date($2::int, 1, 1), make_date($2::int, 12, 1),
                            interval '1 month') as m
     returning id::text as id, tahun, bulan,
               tanggal_mulai::text as mulai, tanggal_akhir::text as akhir`,
    [bumn.id, TAHUN_UJI],
  );
  for (const row of barisPeriode) {
    periodeIndeks.set(row.bulan, {
      id: row.id,
      tahun: row.tahun,
      bulan: row.bulan,
      tanggalMulai: row.mulai,
      tanggalAkhir: row.akhir,
    });
  }
  function periode(bulan: number): PeriodeFixture {
    const p = periodeIndeks.get(bulan);
    if (!p) throw new Error(`fixture tools: periode ${TAHUN_UJI}-${bulan} tidak ada`);
    return p;
  }

  const { akun: akunIdByKode } = await seedCoaDanEventMapping(db, bumn.id, userId.adminPusat);
  const akunPiutangId = akunIdByKode.get("1.1.03");
  const akunKasId = akunIdByKode.get("1.1.01");
  const akunPendapatanId = akunIdByKode.get("4.1.01");
  const akunPiutangJasaId = akunIdByKode.get("1.1.04");
  if (!akunPiutangId || !akunKasId || !akunPendapatanId || !akunPiutangJasaId) {
    throw new Error("fixture tools: COA inti tidak lengkap setelah seedCoaDanEventMapping");
  }

  const sektor = await satu<{ id: string }>(
    db,
    `insert into sektor_pumk (bumn_id, kode, nama) values ($1, $2, $3)
     returning id::text as id`,
    [bumn.id, kunci("SEK"), "Perdagangan (fixture tools)"],
  );

  const { engine: jurnal } = createJurnalModule({ db, jam });
  const engine = createToolsEngine({ db, jam });

  function ctxUntuk(nama: PeranUji): ToolsContext {
    const kodeRole = roleUntuk[nama];
    const izin = izinRole.get(kodeRole) ?? [];
    const lintas = kodeRole === "ADMIN_PUSAT" || kodeRole === "AUDITOR";
    const rumah = nama === "adminCabangB" ? cabangB.id : cabangA.id;
    return {
      userId: userId[nama],
      cabangId: rumah,
      bumnId: bumn.id,
      permissions: izin,
      cabangDalamScope: lintas ? [cabangA.id, cabangB.id] : [rumah],
    };
  }

  const ctx: Record<PeranUji, ToolsContext> = {
    adminPusat: ctxUntuk("adminPusat"),
    adminCabangA: ctxUntuk("adminCabangA"),
    adminCabangB: ctxUntuk("adminCabangB"),
    checker: ctxUntuk("checker"),
    maker: ctxUntuk("maker"),
  };

  function jurnalCtx(cabangId: string) {
    return {
      userId: userId.adminPusat,
      cabangId,
      bumnId: bumn.id,
      permissions: izinRole.get("ADMIN_PUSAT") ?? [],
      cabangDalamScope: [cabangA.id, cabangB.id],
    };
  }

  /**
   * The same context for a DIFFERENT person. Needed because the manual journal
   * path enforces segregation of duties: the maker of a journal may not verify
   * it, so a fixture that wants a posted manual journal has to be two people.
   */
  function jurnalCtxSebagai(peran: PeranUji, cabangId: string) {
    return {
      userId: userId[peran],
      cabangId,
      bumnId: bumn.id,
      permissions: izinRole.get(roleUntuk[peran]) ?? [],
      cabangDalamScope: [cabangA.id, cabangB.id],
    };
  }

  const tanggalDi = (bulan: number): string =>
    `${TAHUN_UJI}-${String(bulan).padStart(2, "0")}-10`;

  async function buatAkad(opsi: {
    cabangId: string;
    pokok: Uang;
    bulan?: number;
  }): Promise<AkadFixture> {
    const bulan = opsi.bulan ?? 2;
    const tanggalAkad = tanggalDi(bulan);
    const mitra = await satu<{ id: string }>(
      db,
      `insert into mitra (cabang_id, kode_mitra, nama_lengkap, sektor_id, status)
       values ($1, $2, $3, $4, 'AKTIF') returning id::text as id`,
      [opsi.cabangId, kunci("MTR"), `Mitra ${kunci("nm")}`, sektor.id],
    );
    const proposal = await satu<{ id: string }>(
      db,
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, mitra_id, sektor_id,
          jumlah_diajukan, tenor_diajukan, status, created_by, updated_by)
       values ($1, $2, $3::date, $4, $5, $6, 12, 'DICAIRKAN', $7, $7)
       returning id::text as id`,
      [
        opsi.cabangId,
        kunci("PRP"),
        tanggalAkad,
        mitra.id,
        sektor.id,
        opsi.pokok,
        userId.adminPusat,
      ],
    );
    const noAkad = kunci("AKD");
    const akad = await satu<{ id: string }>(
      db,
      `insert into pumk_akad
         (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
          jasa_adm_rate, metode_perhitungan, tenor_bulan, tanggal_mulai_angsuran,
          tanggal_jatuh_tempo_akhir, status, outstanding_pokok, created_by, updated_by)
       values ($1, $2, $3, $4, $5::date, $6, 0.030000, 'FLAT', 1,
               ($5::date + interval '1 month')::date,
               ($5::date + interval '1 month')::date,
               'AKTIF', $6, $7, $7)
       returning id::text as id`,
      [proposal.id, mitra.id, opsi.cabangId, noAkad, tanggalAkad, opsi.pokok, userId.adminPusat],
    );
    // One instalment carrying the whole principal, so
    // `trg_pumk_jadwal_50_total_pokok` (deferred, version 1) is satisfied by
    // construction. The schedule shape is modules/angsuran's specification, not
    // this module's; what matters here is that a VALID one exists so
    // `v_integritas_jadwal` is empty until `rusakkanJadwal` says otherwise.
    await db.query(
      `insert into pumk_jadwal_versi (akad_id, versi, is_active_version, status,
                                      tanggal_berlaku, created_by, updated_by)
       values ($1, 1, true, 'ACTIVE', $2::date, $3, $3)`,
      [akad.id, tanggalAkad, userId.adminPusat],
    );
    await db.query(
      `insert into pumk_jadwal_angsuran
         (akad_id, versi, angsuran_ke, tanggal_jatuh_tempo, pokok, jasa_adm, total,
          saldo_pokok_setelah, is_active_version, created_by, updated_by)
       values ($1, 1, 1, ($2::date + interval '1 month')::date, $3, 0.00, $3, 0.00,
               true, $4, $4)`,
      [akad.id, tanggalAkad, opsi.pokok, userId.adminPusat],
    );
    return {
      akadId: akad.id,
      noAkad,
      mitraId: mitra.id,
      proposalId: proposal.id,
      cabangId: opsi.cabangId,
      pokok: opsi.pokok,
      tanggalAkad,
    };
  }

  return {
    db,
    bumnId: bumn.id,
    cabangA,
    cabangB,
    userId,
    roleUntuk,
    ctx,
    engine,
    jurnal,
    akunPiutangId,
    akunKasId,
    sektorId: sektor.id,
    tahun: TAHUN_UJI,
    periode,
    buatAkad,

    async cairkan(akad, opsi = {}) {
      const j = await jurnal.postingEvent(
        "PENCAIRAN_PUMK",
        {
          cabangId: akad.cabangId,
          tanggalTransaksi: tanggalDi(opsi.bulan ?? 2),
          nilai: opsi.nilai ?? akad.pokok,
          keterangan: `Pencairan ${akad.noAkad} (fixture tools)`,
          mitraId: akad.mitraId,
          akadId: akad.akadId,
        },
        jurnalCtx(akad.cabangId),
      );
      return j.id;
    },

    async buatJurnalDraft(opsi) {
      const j = await jurnal.buatJurnal(
        {
          cabangId: opsi.cabangId,
          jenis: "UMUM",
          tanggalTransaksi: tanggalDi(opsi.bulan ?? 3),
          keterangan: "Jurnal umum DRAFT (fixture tools)",
          baris: [
            { akunId: akunKasId, debit: opsi.nilai },
            { akunId: akunPendapatanId, kredit: opsi.nilai },
          ],
        },
        jurnalCtx(opsi.cabangId),
      );
      return j.id;
    },

    async postingLaluReversal(opsi) {
      const asli = await jurnal.postingEvent(
        "ALOKASI_DANA_BUMN_PEMBINA",
        {
          cabangId: opsi.cabangId,
          tanggalTransaksi: tanggalDi(opsi.bulan ?? 4),
          nilai: opsi.nilai,
          keterangan: "Alokasi dana (fixture tools)",
        },
        jurnalCtx(opsi.cabangId),
      );
      const pembalik = await jurnal.reversalJurnal(
        asli.id,
        "Pembalik untuk uji predikat ADR 0010",
        jurnalCtx(opsi.cabangId),
      );
      return { asli: asli.id, pembalik: pembalik.id };
    },

    async rusakkanRekonsiliasi(akad, delta) {
      // Moves the SUB LEDGER only. `pumk_akad` is not a ledger table, so this
      // is a legitimate write; what it produces is precisely the drift spec 8.4
      // check 10 exists to find, and it is the drift a real defect produces
      // (business state updated, journal not posted).
      const baru = sen(keSen(akad.pokok) + keSen(delta));
      await db.query(
        `update pumk_akad
            set outstanding_pokok = $2::numeric(20,2),
                updated_at = now()
          where id = $1`,
        [akad.akadId, baru],
      );
    },

    async rusakkanJadwal(akad, delta) {
      // Raises the akad principal WITHOUT touching the schedule. The deferred
      // trigger fires on `pumk_jadwal_angsuran`, not on `pumk_akad`, so this is
      // committable -- which is exactly why `v_integritas_jadwal` exists.
      await db.query(
        `update pumk_akad
            set pokok_pinjaman = (pokok_pinjaman + $2::numeric(20,2))::numeric(20,2),
                updated_at = now()
          where id = $1`,
        [akad.akadId, delta],
      );
    },

    async rusakkanJurnal(jurnalId) {
      const baris = await db.query<{ id: string }>(
        `select id::text as id from jurnal_baris
          where jurnal_id = $1 and deleted_at is null order by urutan limit 1`,
        [jurnalId],
      );
      const target = baris[0]?.id;
      if (!target) throw new Error("fixture tools: jurnal tidak punya baris");
      await db.query(
        // boundary-allow: ledger-write making v_integritas_jurnal non-empty needs one line of a DRAFT journal removed; there is no engine method for that, and a health check nobody has watched catch anything is a query somebody hopes is right
        `update jurnal_baris set deleted_at = now(), deleted_by = $2 where id = $1`,
        [target, userId.adminPusat],
      );
    },

    async tutupPeriode(bulan) {
      const p = periode(bulan);
      await db.query(
        `update periode set status = 'CLOSED', closed_by = $2, closed_at = now()
          where id = $1`,
        [p.id, userId.adminPusat],
      );
    },

    async rusakkanTanggaKolektibilitas() {
      // A BUMN-SCOPED row only. The seed's predicate unions the global ladder
      // with this entity's rows, so one extra band whose `hari_min` does not
      // continue the previous band leaves a junction that is neither
      // contiguous nor overlapping-by-design.
      const row = await satu<{ id: string }>(
        db,
        `insert into kolektibilitas_range
           (bumn_id, kelas_kode, hari_min, hari_max, berlaku_dari, created_by, updated_by)
         values ($1, 'MACET', 5000, 5999, make_date($2, 1, 1), $3, $3)
         returning id::text as id`,
        [bumn.id, TAHUN_UJI, userId.adminPusat],
      );
      return row.id;
    },

    async rusakkanPiutangJasaKredit(opsi) {
      // A perfectly legal, balanced, POSTED manual journal: cash in, receivable
      // down. Nothing here bypasses anything, which is the whole point. An
      // asset account can be driven to a credit balance by ordinary journals,
      // no constraint objects, and that is why the invariant needs a check of
      // its own rather than a constraint.
      const j = await jurnal.buatJurnal(
        {
          cabangId: opsi.cabangId,
          jenis: "UMUM",
          tanggalTransaksi: tanggalDi(opsi.bulan ?? 3),
          keterangan: "Setoran jasa yang tidak pernah diakrual (fixture tools)",
          baris: [
            { akunId: akunKasId, debit: opsi.nilai },
            { akunId: akunPiutangJasaId, kredit: opsi.nilai },
          ],
        },
        jurnalCtxSebagai("maker", opsi.cabangId),
      );
      await jurnal.verifikasiJurnal(j.id, jurnalCtx(opsi.cabangId));
      await jurnal.postingJurnal(j.id, jurnalCtx(opsi.cabangId));
      return j.id;
    },

    async cobaOutstandingNegatif(akad) {
      try {
        await db.query(
          `update pumk_akad set outstanding_pokok = -1.00 where id = $1`,
          [akad.akadId],
        );
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error(
        "fixture tools: pumk_akad menerima outstanding_pokok negatif; " +
          "pumk_akad_outstanding_pokok_check hilang, dan pemeriksaan " +
          "OUTSTANDING_POKOK_NEGATIF sekarang bisa gagal sungguhan",
      );
    },

    async cobaSnapshotGanda(akad, bulan) {
      const p = periode(bulan);
      const sisip = async (): Promise<void> => {
        await db.query(
          `insert into kolektibilitas_snapshot
             (periode_id, akad_id, mitra_id, cabang_id, kolektibilitas,
              outstanding_pokok, rate_penyisihan, dasar_perhitungan,
              nilai_penyisihan, sumber_rate, created_by, updated_by)
           values ($1, $2, $3, $4, 'LANCAR', $5, 0.000000, 'OUTSTANDING_POKOK',
                   0.00, 'TABEL_KONFIGURASI', $6, $6)`,
          [p.id, akad.akadId, akad.mitraId, akad.cabangId, akad.pokok, userId.adminPusat],
        );
      };
      await sisip();
      try {
        await sisip();
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error(
        "fixture tools: kolektibilitas_snapshot menerima pasangan (periode, akad) ganda; " +
          "kolektibilitas_snapshot_uq hilang, dan pemeriksaan " +
          "SNAPSHOT_KOLEKTIBILITAS_GANDA sekarang bisa gagal sungguhan",
      );
    },

    async tutup() {
      // Soft delete, matching apps/api/src/testing/harness.ts: the fixture's
      // bumn stops counting as a live reporting entity for the sweeps that walk
      // every entity, and nothing is physically removed from tables that refuse
      // a DELETE.
      await db.query(
        `update bumn set deleted_at = now(), deleted_by = $2, aktif = false
          where id = $1 and deleted_at is null`,
        [bumn.id, userId.adminPusat],
      );
    },
  };
}
