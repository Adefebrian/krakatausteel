// apps/api/src/modules/dashboard/test-support.ts
//
// Fixture builder for the dashboard engine tests (spec 11). NOT a *.test.ts
// file, so `bun test` never executes it on its own.
//
// WHY THESE TESTS HIT REAL POSTGRES
// Almost everything this module claims is a claim about what two SHIPPED
// ARTEFACTS return and about the relationship between them: `v_ledger_baris`
// (migrations/0018, whose predicate IS ADR 0010) and `saldo_akun_periode`
// (migrations/0011, written by the closing engine). A fake repository would
// prove that this module agrees with itself and nothing about whether a closed
// month reads the same as the open month it used to be.
//
// WHY THE LEDGER IS WRITTEN BY THE REAL ENGINE, AND THE FREEZE BY THE REAL CLOSE
// modules/angsuran/test-support.ts records what the alternative cost: a pure
// double for the journal port hid two production-breaking defects behind
// sixteen green tests. Every journal below is posted by the REAL journal engine
// through `postingEvent`, and `tutup(bulan)` runs the REAL closing engine end
// to end -- kolektibilitas, penyisihan, akrual, then `tutupPeriode` -- so the
// frozen rows the dashboard reads are the rows a production close writes, with
// the arithmetic modules/closing decided and not an approximation of it written
// here. It is also not optional: `bun run check:boundaries` and migration
// 0020's posting-path trigger both refuse a raw ledger INSERT from this file.
//
// THE ENGINE UNDER TEST IS BUILT WITH THE REAL PORTS TOO, for the same reason.
// `PorterRkaDashboard`, `PorterNonPumkDashboard` and `PorterClosingDashboard`
// are satisfied STRUCTURALLY by the shipped engines, and wiring the real ones
// here is what makes "this module invents no definition another module owns" a
// tested property rather than a comment. `duniaTanpaPort()` builds the same
// world with the ports omitted, so the `SUMBER_TIDAK_TERPASANG` branch is
// exercised too.
//
// NOTHING GLOBAL IS EVER TOUCHED. Every world gets its own bumn, branches,
// chart of accounts, periods, sector, bidang and users under a random suffix,
// and `tutup()` soft-deletes the entity afterwards. A closing test once blanked
// a global `konfigurasi` row to reach a guard and poisoned every world that ran
// afterwards, in every file, for the rest of the run.
import { createDbAdapter } from "../../core/adapters/db";
import { createClosingModule, type ClosingEngine } from "../closing/index";
import { createJurnalModule, type JurnalEngine } from "../jurnal/index";
import { createNonPumkModule, type NonPumkEngine } from "../nonpumk/index";
import { createRkaModule, type RkaEngine } from "../rka/index";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { permissionsForRole, seedRbac } from "../../seed/rbac";
import {
  createDashboardEngine,
  type DashboardContext,
  type DashboardEngine,
  type Uang,
} from "./contract";
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
  /** The single instalment's due date, so a test can aim a payment at it. */
  jatuhTempo: string;
}

export interface ProposalNonPumkFixture {
  proposalId: string;
  noProposal: string;
  cabangId: string;
}

export type PeranUji =
  | "adminPusat"
  | "adminCabangA"
  | "adminCabangB"
  | "checker"
  | "maker"
  | "approver";

export interface DuniaDashboard {
  db: DbPort;
  bumnId: string;
  cabangA: CabangFixture;
  cabangB: CabangFixture;
  userId: Record<PeranUji, string>;
  roleUntuk: Record<PeranUji, string>;
  ctx: Record<PeranUji, DashboardContext>;
  engine: DashboardEngine;
  jurnal: JurnalEngine;
  closing: ClosingEngine;
  rka: RkaEngine;
  nonpumk: NonPumkEngine;
  akunKasId: string;
  akunPiutangId: string;
  akunBebanNonPumkId: string;
  sektorId: string;
  bidangId: string;
  tahun: number;
  periode(bulan: number): PeriodeFixture;

  /** Cash in, so a branch has something to disburse from. */
  alokasiKas(opsi: { cabangId: string; nilai: Uang; bulan: number }): Promise<string>;
  /** A signed loan with a valid version-1 schedule. Not yet disbursed. */
  buatAkad(opsi: {
    cabangId: string;
    pokok: Uang;
    jasa?: Uang;
    bulan: number;
  }): Promise<AkadFixture>;
  /** PENCAIRAN_PUMK through the REAL engine, so the receivable leg is real. */
  cairkan(akad: AkadFixture, opsi?: { nilai?: Uang; bulan?: number }): Promise<string>;
  /** Marks the akad's single instalment paid, WITHOUT touching the ledger. */
  bayarJadwal(akad: AkadFixture, opsi: { pokok: Uang; jasa?: Uang }): Promise<void>;
  /** A Non PUMK grant: proposal, termin row, and PENYALURAN_NON_PUMK posted. */
  salurkanNonPumk(opsi: {
    cabangId: string;
    nilai: Uang;
    bulan: number;
  }): Promise<ProposalNonPumkFixture>;
  /** PENGEMBALIAN_SISA_NON_PUMK: the post-LPJ refund the net figure must net. */
  kembalikanNonPumk(
    proposal: ProposalNonPumkFixture,
    opsi: { nilai: Uang; bulan: number },
  ): Promise<string>;
  /** A proposal parked at one workflow state, for the queue panel. */
  proposalPumkDi(opsi: { cabangId: string; status: string }): Promise<string>;
  proposalNonPumkDi(opsi: { cabangId: string; status: string }): Promise<string>;
  /** An approved RKA Non PUMK baseline with one monthly line. */
  buatBaselineNonPumk(opsi: {
    cabangId: string | null;
    bulan: number;
    jumlah: Uang;
  }): Promise<string>;
  /**
   * The FULL close of one month through the real engine: kolektibilitas,
   * penyisihan, akrual, then `tutupPeriode`. Throws with the failing checklist
   * attached rather than leaving a half-closed month behind.
   */
  tutupPeriode(bulan: number): Promise<void>;

  tutup(): Promise<void>;
}

async function satu<T>(db: DbPort, sql: string, params: unknown[] = []): Promise<T> {
  const baris = await db.query<T>(sql, params);
  if (baris.length === 0) {
    throw new Error(`fixture dashboard: query tidak mengembalikan baris: ${sql}`);
  }
  return baris[0] as T;
}

function urlDbAman(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL tidak ada. Test dashboard butuh Postgres nyata (tjsl_test). " +
        "Jalankan `bun test` dari root repo (lihat docs/DEV.md).",
    );
  }
  if (!(url.split("?")[0] ?? "").endsWith("_test")) {
    throw new Error(`Menolak menjalankan fixture dashboard di database non-test: ${url}`);
  }
}

export const TAHUN_UJI = 2027;

export interface OpsiDunia {
  /** Omit the three engine ports, to exercise `SUMBER_TIDAK_TERPASANG`. */
  tanpaPort?: boolean;
}

export async function buatDuniaDashboard(
  opsi: OpsiDunia = {},
): Promise<DuniaDashboard> {
  urlDbAman();
  const db = createDbAdapter();
  const jam = () => new Date(`${TAHUN_UJI}-06-15T04:00:00.000Z`);

  const bumn = await satu<{ id: string }>(
    db,
    `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1)
     returning id::text as id`,
    [kunci("BUMN"), "PT Krakatau Steel (fixture dashboard)"],
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

  const cabangA = await buatCabang("Kantor Pusat (fixture dashboard)", true);
  const cabangB = await buatCabang("Cabang B (fixture dashboard)", false);

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
    adminPusat: await buatUser("Admin Pusat (fixture dashboard)", cabangA.id),
    adminCabangA: await buatUser("Admin Cabang A (fixture dashboard)", cabangA.id),
    adminCabangB: await buatUser("Admin Cabang B (fixture dashboard)", cabangB.id),
    checker: await buatUser("Checker (fixture dashboard)", cabangA.id),
    maker: await buatUser("Maker (fixture dashboard)", cabangA.id),
    approver: await buatUser("Approver (fixture dashboard)", cabangA.id),
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
    approver: "APPROVER",
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
    if (!p) throw new Error(`fixture dashboard: periode ${TAHUN_UJI}-${bulan} tidak ada`);
    return p;
  }

  const { akun: akunIdByKode } = await seedCoaDanEventMapping(db, bumn.id, userId.adminPusat);
  const akunKasId = akunIdByKode.get("1.1.01");
  const akunPiutangId = akunIdByKode.get("1.1.03");
  const akunBebanNonPumkId = akunIdByKode.get("5.1.03");
  if (!akunKasId || !akunPiutangId || !akunBebanNonPumkId) {
    throw new Error("fixture dashboard: COA inti tidak lengkap setelah seedCoaDanEventMapping");
  }

  const sektor = await satu<{ id: string }>(
    db,
    `insert into sektor_pumk (bumn_id, kode, nama) values ($1, $2, $3)
     returning id::text as id`,
    [bumn.id, kunci("SEK"), "Perdagangan (fixture dashboard)"],
  );
  const bidang = await satu<{ id: string }>(
    db,
    `insert into bidang_non_pumk (bumn_id, kode, nama) values ($1, $2, $3)
     returning id::text as id`,
    [bumn.id, kunci("BID"), "Pendidikan (fixture dashboard)"],
  );

  const { engine: jurnal } = createJurnalModule({ db, jam });
  const { engine: closing } = createClosingModule({ db, jurnal, jam });
  const { engine: rka } = createRkaModule({ db, jam });
  const { engine: nonpumk } = createNonPumkModule({ db, jurnal, jam });

  const engine = createDashboardEngine(
    opsi.tanpaPort
      ? { db, jam }
      : { db, jam, rka, nonpumk, closing },
  );

  function ctxUntuk(nama: PeranUji): DashboardContext {
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

  const ctx: Record<PeranUji, DashboardContext> = {
    adminPusat: ctxUntuk("adminPusat"),
    adminCabangA: ctxUntuk("adminCabangA"),
    adminCabangB: ctxUntuk("adminCabangB"),
    checker: ctxUntuk("checker"),
    maker: ctxUntuk("maker"),
    approver: ctxUntuk("approver"),
  };

  function ctxPusat(cabangId: string) {
    return {
      userId: userId.adminPusat,
      cabangId,
      bumnId: bumn.id,
      permissions: izinRole.get("ADMIN_PUSAT") ?? [],
      cabangDalamScope: [cabangA.id, cabangB.id],
    };
  }

  const tanggalDi = (bulan: number, hari = 10): string =>
    `${TAHUN_UJI}-${String(bulan).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;

  async function buatAkad(o: {
    cabangId: string;
    pokok: Uang;
    jasa?: Uang;
    bulan: number;
  }): Promise<AkadFixture> {
    const tanggalAkad = tanggalDi(o.bulan);
    const jasa = o.jasa ?? "0.00";
    const mitra = await satu<{ id: string }>(
      db,
      `insert into mitra (cabang_id, kode_mitra, nama_lengkap, sektor_id, status)
       values ($1, $2, $3, $4, 'AKTIF') returning id::text as id`,
      [o.cabangId, kunci("MTR"), `Mitra ${kunci("nm")}`, sektor.id],
    );
    const proposal = await satu<{ id: string }>(
      db,
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, mitra_id, sektor_id,
          jumlah_diajukan, tenor_diajukan, status, created_by, updated_by)
       values ($1, $2, $3::date, $4, $5, $6, 12, 'DICAIRKAN', $7, $7)
       returning id::text as id`,
      [o.cabangId, kunci("PRP"), tanggalAkad, mitra.id, sektor.id, o.pokok, userId.adminPusat],
    );
    const noAkad = kunci("AKD");
    const akad = await satu<{ id: string; jatuh_tempo: string }>(
      db,
      `insert into pumk_akad
         (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
          jasa_adm_rate, metode_perhitungan, tenor_bulan, tanggal_mulai_angsuran,
          tanggal_jatuh_tempo_akhir, status, outstanding_pokok, created_by, updated_by)
       values ($1, $2, $3, $4, $5::date, $6, 0.030000, 'FLAT', 1,
               ($5::date + interval '1 month')::date,
               ($5::date + interval '1 month')::date,
               'AKTIF', $6, $7, $7)
       returning id::text as id,
                 ($5::date + interval '1 month')::date::text as jatuh_tempo`,
      [proposal.id, mitra.id, o.cabangId, noAkad, tanggalAkad, o.pokok, userId.adminPusat],
    );
    // One instalment carrying the whole principal, so
    // `trg_pumk_jadwal_50_total_pokok` (deferred, version 1) is satisfied by
    // construction. The schedule SHAPE is modules/angsuran's specification, not
    // this module's; what matters here is that the collection ratio has exactly
    // one row with a known due amount to divide by.
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
       values ($1, 1, 1, ($2::date + interval '1 month')::date, $3, $4,
               ($3::numeric(20,2) + $4::numeric(20,2)), 0.00, true, $5, $5)`,
      [akad.id, tanggalAkad, o.pokok, jasa, userId.adminPusat],
    );
    return {
      akadId: akad.id,
      noAkad,
      mitraId: mitra.id,
      proposalId: proposal.id,
      cabangId: o.cabangId,
      pokok: o.pokok,
      tanggalAkad,
      jatuhTempo: akad.jatuh_tempo,
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
    closing,
    rka,
    nonpumk,
    akunKasId,
    akunPiutangId,
    akunBebanNonPumkId,
    sektorId: sektor.id,
    bidangId: bidang.id,
    tahun: TAHUN_UJI,
    periode,
    buatAkad,

    async alokasiKas(o) {
      const j = await jurnal.postingEvent(
        "ALOKASI_DANA_BUMN_PEMBINA",
        {
          cabangId: o.cabangId,
          tanggalTransaksi: tanggalDi(o.bulan, 2),
          nilai: o.nilai,
          keterangan: "Alokasi dana BUMN Pembina (fixture dashboard)",
        },
        ctxPusat(o.cabangId),
      );
      return j.id;
    },

    async cairkan(akad, o = {}) {
      const j = await jurnal.postingEvent(
        "PENCAIRAN_PUMK",
        {
          cabangId: akad.cabangId,
          tanggalTransaksi: tanggalDi(o.bulan ?? Number(akad.tanggalAkad.slice(5, 7))),
          nilai: o.nilai ?? akad.pokok,
          keterangan: `Pencairan ${akad.noAkad} (fixture dashboard)`,
          mitraId: akad.mitraId,
          akadId: akad.akadId,
          referensiTipe: "pumk_pencairan",
        },
        ctxPusat(akad.cabangId),
      );
      return j.id;
    },

    async bayarJadwal(akad, o) {
      // The SUB LEDGER only, deliberately. `pumk_jadwal_angsuran` is not a
      // ledger table, and the collection ratio is defined on it (see
      // ./repo.ts `pengembalian`), so a test of that ratio must be able to set
      // the collected column without also asserting how modules/angsuran
      // allocates a deposit -- which is that module's specification, tested
      // there, and would make this fixture a second copy of it.
      await db.query(
        `update pumk_jadwal_angsuran
            set pokok_terbayar = $2::numeric(20,2),
                jasa_terbayar = $3::numeric(20,2),
                status = case when $2::numeric(20,2) >= pokok
                                and $3::numeric(20,2) >= jasa_adm
                              then 'LUNAS' else 'SEBAGIAN' end,
                updated_at = now()
          where akad_id = $1 and is_active_version and angsuran_ke = 1`,
        [akad.akadId, o.pokok, o.jasa ?? "0.00"],
      );
    },

    async salurkanNonPumk(o) {
      const noProposal = kunci("NPK");
      const proposal = await satu<{ id: string }>(
        db,
        `insert into nonpumk_proposal
           (cabang_id, no_proposal, tanggal_proposal, nama_pemohon, bidang_id,
            judul_program, jumlah_diajukan, jumlah_disetujui, status,
            created_by, updated_by)
         values ($1, $2, $3::date, $4, $5, $6, $7, $7, 'DISALURKAN', $8, $8)
         returning id::text as id`,
        [
          o.cabangId,
          noProposal,
          tanggalDi(o.bulan, 3),
          `Yayasan ${kunci("ys")}`,
          bidang.id,
          "Program bantuan pendidikan (fixture dashboard)",
          o.nilai,
          userId.adminPusat,
        ],
      );
      const penyaluran = await satu<{ id: string }>(
        db,
        `insert into nonpumk_penyaluran
           (proposal_id, termin, tanggal_penyaluran, jumlah, akun_kas_id,
            akun_beban_id, created_by, updated_by)
         values ($1, 1, $2::date, $3, $4, $5, $6, $6)
         returning id::text as id`,
        [
          proposal.id,
          tanggalDi(o.bulan, 12),
          o.nilai,
          akunKasId,
          akunBebanNonPumkId,
          userId.adminPusat,
        ],
      );
      await jurnal.postingEvent(
        "PENYALURAN_NON_PUMK",
        {
          cabangId: o.cabangId,
          tanggalTransaksi: tanggalDi(o.bulan, 12),
          nilai: o.nilai,
          keterangan: `Penyaluran Non PUMK ${noProposal} (fixture dashboard)`,
          // The per-bidang expense leg, which the mapping marks
          // `debit_dari_payload` because spec 6.4 puts it on the form.
          akunDebitId: akunBebanNonPumkId,
          akunKasId,
          referensiTipe: "nonpumk_penyaluran",
          referensiId: penyaluran.id,
          dimensi: { bidangId: bidang.id },
        },
        ctxPusat(o.cabangId),
      );
      return { proposalId: proposal.id, noProposal, cabangId: o.cabangId };
    },

    async kembalikanNonPumk(proposal, o) {
      const j = await jurnal.postingEvent(
        "PENGEMBALIAN_SISA_NON_PUMK",
        {
          cabangId: proposal.cabangId,
          tanggalTransaksi: tanggalDi(o.bulan, 20),
          nilai: o.nilai,
          keterangan: `Pengembalian sisa ${proposal.noProposal} (fixture dashboard)`,
          // The SAME account the disbursement debited (migrations/0023): a
          // refund credited elsewhere would leave the bidang overstated.
          akunKreditId: akunBebanNonPumkId,
          akunKasId,
          dimensi: { bidangId: bidang.id },
        },
        ctxPusat(proposal.cabangId),
      );
      return j.id;
    },

    async proposalPumkDi(o) {
      const mitra = await satu<{ id: string }>(
        db,
        `insert into mitra (cabang_id, kode_mitra, nama_lengkap, sektor_id, status)
         values ($1, $2, $3, $4, 'AKTIF') returning id::text as id`,
        [o.cabangId, kunci("MTR"), `Mitra ${kunci("nm")}`, sektor.id],
      );
      const row = await satu<{ id: string }>(
        db,
        `insert into pumk_proposal
           (cabang_id, no_proposal, tanggal_proposal, mitra_id, sektor_id,
            jumlah_diajukan, tenor_diajukan, status, created_by, updated_by)
         values ($1, $2, $3::date, $4, $5, 5000000.00, 12, $6, $7, $7)
         returning id::text as id`,
        [
          o.cabangId,
          kunci("PRP"),
          tanggalDi(3, 5),
          mitra.id,
          sektor.id,
          o.status,
          userId.adminPusat,
        ],
      );
      return row.id;
    },

    async proposalNonPumkDi(o) {
      const row = await satu<{ id: string }>(
        db,
        `insert into nonpumk_proposal
           (cabang_id, no_proposal, tanggal_proposal, nama_pemohon, bidang_id,
            judul_program, jumlah_diajukan, status, created_by, updated_by)
         values ($1, $2, $3::date, $4, $5, $6, 7000000.00, $7, $8, $8)
         returning id::text as id`,
        [
          o.cabangId,
          kunci("NPK"),
          tanggalDi(3, 6),
          `Yayasan ${kunci("ys")}`,
          bidang.id,
          "Program antrian (fixture dashboard)",
          o.status,
          userId.adminPusat,
        ],
      );
      return row.id;
    },

    async buatBaselineNonPumk(o) {
      const row = await satu<{ id: string }>(
        db,
        `insert into rka (bumn_id, cabang_id, tahun, jenis, status, versi,
                          approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, 'NON_PUMK', 'DISETUJUI', 1, $4, now(), $4, $4)
         returning id::text as id`,
        [bumn.id, o.cabangId, TAHUN_UJI, userId.adminPusat],
      );
      await db.query(
        `insert into rka_detail (rka_id, bidang_id, uraian, bulan, jumlah_anggaran,
                                 created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $6)`,
        [
          row.id,
          bidang.id,
          "Anggaran bantuan pendidikan (fixture dashboard)",
          o.bulan,
          o.jumlah,
          userId.adminPusat,
        ],
      );
      return row.id;
    },

    async tutupPeriode(bulan) {
      const p = periode(bulan);
      const c = ctxPusat(cabangA.id);
      // Spec 8 in order, through the REAL engine. Doing it any other way would
      // make the frozen figures this module reads an invention of the fixture.
      await closing.jalankanKolektibilitas({ periodeId: p.id }, c);
      await closing.jalankanPenyisihan({ periodeId: p.id }, c);
      await closing.jalankanAkrualJasaAdm({ periodeId: p.id }, c);
      const prasyarat = await closing.periksaPrasyarat(p.id, c);
      if (!prasyarat.boleh) {
        throw new Error(
          `fixture dashboard: periode ${TAHUN_UJI}-${bulan} tidak lolos prasyarat: ` +
            prasyarat.hasil
              .filter((h) => h.status === "GAGAL")
              .map((h) => `${h.nomor} ${h.kode}: ${h.alasan}`)
              .join("; "),
        );
      }
      await closing.tutupPeriode(
        { periodeId: p.id, konfirmasiKasNegatif: prasyarat.perluKonfirmasi },
        c,
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
