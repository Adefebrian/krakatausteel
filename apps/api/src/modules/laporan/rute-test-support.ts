// Fixture for the REPORT ROUTE tests. NOT a *.test.ts file, so `bun test`
// never runs it on its own.
//
// WHY IT IS NOT ./test-support.ts
// That file builds a world for the ENGINE: it drives the engine directly with a
// hand-built `LaporanContext`, and its users carry a placeholder password hash
// so none of them can log in. A route test must not do either. Spec 2 rule 4 is
// "call the endpoint directly with the wrong role", which is only true if the
// role arrives the way it arrives in production: a real login, a real session
// cookie, a real principal resolved from Redis and Postgres, through the real
// guard chain. So this file composes:
//
//   ../../testing/harness   -- the REAL app from core/app.ts's `createApp`,
//                              real users for all six roles plus a second
//                              branch, and a `login()` that returns a cookie;
//   ../../seed/event-jurnal -- the SHIPPED chart of accounts, the SHIPPED
//                              report template and the SHIPPED event mappings,
//                              by the same code path `bun run db:seed` uses.
//
// THE LEDGER IS POSTED THROUGH THE REAL JOURNAL ENGINE, the one `createApp`
// wired, in date order, while every period is still OPEN (invariant 5). Nothing
// here inserts a `jurnal` or `jurnal_baris` row directly: invariant 11 says
// there is one posting path, and a fixture that went around it would be proving
// its reports against a ledger the product cannot produce.
//
// THE BOOK IS CHOSEN SO NO ASSERTION CAN PASS VACUOUSLY:
//   - Total Aset, Total Liabilitas and Total Aset Neto are each NON-ZERO, so
//     `Aset = Liabilitas + Aset Neto` is a real test rather than 0 = 0 + 0;
//   - cash moves in BOTH directions inside the reporting year, so Kas Akhir is
//     neither Kas Awal nor zero when it is compared against the balance sheet;
//   - all six Neraca Lajur totals are non-zero for the reporting month, so its
//     three balance checks bite;
//   - there is activity in the PRIOR year, so the comparative columns and the
//     "saldo awal" of reports 22 and 23 are non-zero;
//   - there is a NON-CASH pair (the allowance), so a cash-flow statement that
//     merely mirrored the income statement would be wrong;
//   - there is a journal in a SECOND BRANCH, self-balancing inside that branch,
//     so branch filtering has something to exclude and the balance sheet
//     identity holds per branch and for Semua Cabang alike.
//
// TWO ACCOUNTS ARE DELIBERATELY NEVER PUT OPPOSITE CASH. `3.1.01` (Aset Neto)
// and `1.1.05` (Penyisihan) carry no `klasifikasi_arus_kas` in the shipped
// chart, on purpose: a movement in net assets is a reclassification and an
// allowance never touches cash, so either one facing a cash line is a mistake
// report 18 REFUSES on rather than buckets. This book therefore opens net
// assets against a receivable, not against cash.
//
// EVERY FIXTURE IS UNIQUE, for the reason the harness gives: test files share
// one Postgres and another agent may reset it mid-run. Nothing is cleaned up and
// nothing depends on rows another file left behind.
import { createFixture, tutupSemuaFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import type { JurnalContext } from "../jurnal/index";

export type { Fixture };
// Re-exported so a test file that uses this world can close it with one
// `afterAll(tutupSemuaFixture)` and one import. See the FIXTURE LEAK note in
// ../../testing/harness.ts.
export { tutupSemuaFixture };

/** Whole rupiah -> the fixed two-decimal text the ledger takes. */
export function rp(rupiahBulat: number): string {
  if (!Number.isInteger(rupiahBulat)) {
    throw new Error(`rp() hanya menerima rupiah bulat, dapat ${rupiahBulat}`);
  }
  return `${rupiahBulat}.00`;
}

/** Sen, from the fixed two-decimal text, for an exact comparison. */
export function keSen(nilai: string): bigint {
  const cocok = /^(-?)(\d+)\.(\d{2})$/.exec(nilai);
  if (!cocok) throw new Error(`bukan uang dua desimal: ${nilai}`);
  const besar = BigInt(cocok[2]!) * 100n + BigInt(cocok[3]!);
  return cocok[1] === "-" ? -besar : besar;
}

export const TAHUN_LALU = 2025;
export const TAHUN_INI = 2026;
/** The month every statement in these tests is printed for. */
export const BULAN_LAPORAN = 3;

/** Account codes from the SHIPPED core COA, by the name the fixture uses. */
const KODE_AKUN = {
  kas: "1.1.01",
  bank: "1.1.02",
  piutangPokok: "1.1.03",
  penyisihan: "1.1.05",
  kelebihanAngsuran: "2.1.01",
  asetNeto: "3.1.01",
  pendapatanAlokasi: "4.1.01",
  bebanPenyisihan: "5.1.01",
  bebanPembinaan: "5.1.02",
  bebanOperasional: "5.1.04",
} as const;

export type KunciAkun = keyof typeof KODE_AKUN;

interface BarisBuku {
  akun: KunciAkun;
  debit?: string;
  kredit?: string;
}

interface EntriBuku {
  tanggal: string;
  jenis: "UMUM" | "KAS_BANK";
  keterangan: string;
  diCabangLain?: boolean;
  baris: BarisBuku[];
}

const BUKU: readonly EntriBuku[] = [
  // --- the comparative year ------------------------------------------------
  {
    tanggal: `${TAHUN_LALU}-01-05`,
    jenis: "UMUM",
    keterangan: "Saldo awal aset neto (fixture rute laporan)",
    baris: [
      { akun: "piutangPokok", debit: rp(1_000_000_000) },
      { akun: "asetNeto", kredit: rp(1_000_000_000) },
    ],
  },
  {
    tanggal: `${TAHUN_LALU}-03-10`,
    jenis: "KAS_BANK",
    keterangan: "Alokasi dana dari BUMN Pembina (fixture rute laporan)",
    baris: [
      { akun: "kas", debit: rp(400_000_000) },
      { akun: "pendapatanAlokasi", kredit: rp(400_000_000) },
    ],
  },
  {
    tanggal: `${TAHUN_LALU}-11-20`,
    jenis: "KAS_BANK",
    keterangan: "Beban operasional tahun lalu (fixture rute laporan)",
    baris: [
      { akun: "bebanOperasional", debit: rp(50_000_000) },
      { akun: "kas", kredit: rp(50_000_000) },
    ],
  },

  // --- the reporting year --------------------------------------------------
  {
    tanggal: `${TAHUN_INI}-01-15`,
    jenis: "KAS_BANK",
    keterangan: "Alokasi dana dari BUMN Pembina (fixture rute laporan)",
    baris: [
      { akun: "bank", debit: rp(300_000_000) },
      { akun: "pendapatanAlokasi", kredit: rp(300_000_000) },
    ],
  },
  {
    tanggal: `${TAHUN_INI}-02-10`,
    jenis: "KAS_BANK",
    keterangan: "Penyaluran pinjaman mitra binaan (fixture rute laporan)",
    baris: [
      { akun: "piutangPokok", debit: rp(120_000_000) },
      { akun: "bank", kredit: rp(120_000_000) },
    ],
  },
  {
    tanggal: `${TAHUN_INI}-${String(BULAN_LAPORAN).padStart(2, "0")}-05`,
    jenis: "KAS_BANK",
    keterangan: "Beban pembinaan kemitraan (fixture rute laporan)",
    baris: [
      { akun: "bebanPembinaan", debit: rp(40_000_000) },
      { akun: "kas", kredit: rp(40_000_000) },
    ],
  },
  {
    // NON-CASH on purpose: neither leg is an `is_kas` account, so report 18
    // must not show it and report 17 must.
    tanggal: `${TAHUN_INI}-${String(BULAN_LAPORAN).padStart(2, "0")}-12`,
    jenis: "UMUM",
    keterangan: "Penyisihan penurunan nilai piutang (fixture rute laporan)",
    baris: [
      { akun: "bebanPenyisihan", debit: rp(15_000_000) },
      { akun: "penyisihan", kredit: rp(15_000_000) },
    ],
  },
  {
    // The one entry that gives Total Liabilitas a non-zero figure, so the
    // balance-sheet identity is not `Aset = 0 + Aset Neto`.
    tanggal: `${TAHUN_INI}-${String(BULAN_LAPORAN).padStart(2, "0")}-18`,
    jenis: "KAS_BANK",
    keterangan: "Kelebihan pembayaran angsuran diterima (fixture rute laporan)",
    baris: [
      { akun: "kas", debit: rp(5_000_000) },
      { akun: "kelebihanAngsuran", kredit: rp(5_000_000) },
    ],
  },
  {
    // Branch B, self-balancing inside branch B, so the identity holds per
    // branch and for Semua Cabang alike and the branch filter has something
    // real to exclude.
    tanggal: `${TAHUN_INI}-${String(BULAN_LAPORAN).padStart(2, "0")}-20`,
    jenis: "KAS_BANK",
    keterangan: "Alokasi dana cabang B (fixture rute laporan)",
    diCabangLain: true,
    baris: [
      { akun: "kas", debit: rp(25_000_000) },
      { akun: "pendapatanAlokasi", kredit: rp(25_000_000) },
    ],
  },
];

const ROLE_UNTUK_SESI = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
  "MAKER_B",
] as const;

export interface PeriodeUji {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
}

export interface DuniaRuteLaporan {
  f: Fixture;
  sesi: Map<string, string>;
  /** Account ids of this world's chart, keyed by the fixture's own names. */
  akun: Record<KunciAkun, string>;
  /** The reporting period: `TAHUN_INI`-`BULAN_LAPORAN`, still OPEN. */
  periodeLaporan: PeriodeUji;
  /**
   * ONE PARTNER IN CABANG A, WITH NO AKAD AT ALL. Report 9 is the only report
   * keyed on a partner, so without one there is no way to call its route with
   * valid parameters and the "every catalogue path answers" check would have a
   * hole exactly where the catalogue's only per-entity report is. It holds no
   * contract on purpose: the FIGURES are proven in ./laporan-pumk.test.ts
   * against the operational world, and what this file proves is the WIRING.
   */
  mitraKosong: string;
  periode(tahun: number, bulan: number): PeriodeUji;
  /** Closes a period AND freezes its balances the way modules/closing does. */
  bekukanDanTutup(p: PeriodeUji): Promise<void>;
  /** Closes a period WITHOUT freezing, to reach the fail-closed refusal. */
  tutupTanpaMembekukan(p: PeriodeUji): Promise<void>;
  panggil(
    role: string,
    path: string,
    opsi?: { method?: string; body?: unknown },
  ): Promise<Response>;
  ok<T>(role: string, path: string, opsi?: { method?: string; body?: unknown }): Promise<T>;
}

export async function buatDuniaRuteLaporan(): Promise<DuniaRuteLaporan> {
  const f = await createFixture();
  const db = f.db;

  for (const cabang of [f.pusat, f.cabangA, f.cabangB]) {
    const kodeBaru = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.query(`UPDATE cabang SET kode = $2 WHERE id = $1`, [cabang.id, kodeBaru]);
    cabang.kode = kodeBaru;
  }

  // Monthly OPEN periods across both years. Everything is posted while they
  // are open (invariant 5); a test that wants the CLOSED path closes one
  // afterwards, which is the order the product enforces too.
  const periodeById = new Map<string, PeriodeUji>();
  for (const tahun of [TAHUN_LALU, TAHUN_INI]) {
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      const mulai = `${tahun}-${String(bulan).padStart(2, "0")}-01`;
      const akhir = new Date(Date.UTC(tahun, bulan, 0)).toISOString().slice(0, 10);
      const rows = await db.query<{ id: string }>(
        `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING id::text AS id`,
        [f.bumnId, tahun, bulan, mulai, akhir],
      );
      periodeById.set(`${tahun}-${bulan}`, {
        id: rows[0]!.id,
        tahun,
        bulan,
        tanggalMulai: mulai,
        tanggalAkhir: akhir,
      });
    }
  }
  const periode = (tahun: number, bulan: number): PeriodeUji => {
    const p = periodeById.get(`${tahun}-${bulan}`);
    if (!p) throw new Error(`fixture rute laporan: tidak ada periode ${tahun}-${bulan}`);
    return p;
  };

  const { akun: akunIdByKode } = await seedCoaDanEventMapping(
    db,
    f.bumnId,
    f.users.ADMIN_PUSAT.id,
  );
  const akun = {} as Record<KunciAkun, string>;
  for (const [nama, kode] of Object.entries(KODE_AKUN) as Array<[KunciAkun, string]>) {
    const id = akunIdByKode.get(kode);
    if (!id) throw new Error(`fixture rute laporan: akun ${kode} tidak ada setelah seedCoaInti`);
    akun[nama] = id;
  }

  const rowsMitra = await db.query<{ id: string }>(
    `INSERT INTO mitra (cabang_id, kode_mitra, nama_lengkap, status, created_by, updated_by)
     VALUES ($1, $2, $3, 'CALON', $4, $4) RETURNING id::text AS id`,
    [f.cabangA.id, `MTR-RUTE-${f.suffix}`, `Mitra rute laporan ${f.suffix}`, f.users.ADMIN_PUSAT.id],
  );
  const mitraKosong = rowsMitra[0]!.id;

  const sesi = new Map<string, string>();
  for (const role of ROLE_UNTUK_SESI) {
    const user = role === "MAKER_B" ? f.users.MAKER_B : f.users[role];
    sesi.set(role, await f.login(user.username));
  }

  // Posted through the engine `createApp` wired, as Admin Pusat, in date
  // order. `f.ctx.jurnal` is that instance; there is no second path.
  const ctxJurnal: JurnalContext = {
    userId: f.users.ADMIN_PUSAT.id,
    cabangId: f.pusat.id,
    bumnId: f.bumnId,
    permissions: ["jurnal.create", "jurnal.post", "jurnal.view"],
    cabangDalamScope: [f.pusat.id, f.cabangA.id, f.cabangB.id],
  };
  for (const entri of BUKU) {
    const draft = await f.ctx.jurnal.buatJurnal(
      {
        cabangId: entri.diCabangLain ? f.cabangB.id : f.cabangA.id,
        jenis: entri.jenis,
        tanggalTransaksi: entri.tanggal,
        keterangan: entri.keterangan,
        baris: entri.baris.map((b) => ({
          akunId: akun[b.akun],
          ...(b.debit === undefined ? {} : { debit: b.debit }),
          ...(b.kredit === undefined ? {} : { kredit: b.kredit }),
        })),
      },
      ctxJurnal,
    );
    await f.ctx.jurnal.postingJurnal(draft.id, ctxJurnal);
  }

  /**
   * Freezes a period's trial balance with the SAME predicate and the SAME
   * arithmetic modules/closing is required to use (ADR 0010,
   * migrations/0018), which is the whole point: the frozen figure must be the
   * ledger figure, so "the OPEN and CLOSED paths agree at the moment of
   * closing" stays a claim about the REPORT rather than about this helper.
   */
  async function bekukanDanTutup(p: PeriodeUji): Promise<void> {
    await db.transaction(async (tx) => {
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
                g.saldo_awal + g.mutasi_debit - g.mutasi_kredit, $5::uuid, $5::uuid
           from gerak g
          where g.saldo_awal <> 0 or g.mutasi_debit <> 0 or g.mutasi_kredit <> 0`,
        [p.id, f.bumnId, p.tanggalMulai, p.tanggalAkhir, f.users.ADMIN_PUSAT.id],
      );
      // `periode_closed_jejak_ck` makes `closed_by` and `closed_at` mandatory
      // on a CLOSED row: a period that closed with nobody's name on it is not
      // evidence of anything.
      await tx.query(
        `update periode set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`,
        [p.id, f.users.APPROVER.id],
      );
    });
  }

  async function tutupTanpaMembekukan(p: PeriodeUji): Promise<void> {
    await db.query(
      `update periode set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1`,
      [p.id, f.users.APPROVER.id],
    );
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
    akun,
    periodeLaporan: periode(TAHUN_INI, BULAN_LAPORAN),
    periode,
    mitraKosong,
    bekukanDanTutup,
    tutupTanpaMembekukan,
    panggil,
    ok,
  };
}
