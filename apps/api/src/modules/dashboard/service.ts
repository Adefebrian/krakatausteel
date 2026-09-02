// The dashboard engine (spec 11). Authorises, scopes, CHOOSES THE SOURCE, and
// shapes what ./repo.ts reads. It invents no definition another module owns and
// it writes nothing: there is no journal port, no audit port and no transaction
// in this file, so invariant 11 is unreachable from here rather than merely
// respected.
//
// THE FOUR RULES THIS FILE EXISTS TO ENFORCE are stated in full at the top of
// ./contract.ts. In code they land as:
//
//   1. EVERY NUMBER IS DRILLABLE. `KATALOG_RINCIAN` below is the single index
//      from a drill-down key to the query that answers it, and every `Metrik`,
//      `BarisKolektibilitas` and `BarisAntrian` this file emits carries a key
//      that is IN that index. `./dashboard-drilldown.test.ts` sweeps the whole
//      summary and calls `rincian` on every key it finds, so a metric cannot be
//      added without its drill-down.
//
//   2. A CLOSED PERIOD IS READ FROZEN. `sumberBeku` is computed ONCE, from the
//      period's own `status`, and no filter can override it. Every money figure
//      then branches on that one boolean, and each `Metrik` reports WHICH
//      artefact answered so a test can assert the source rather than only the
//      value: two sources agree on well-behaved data, so an equality assertion
//      alone passes on an implementation that got the rule backwards.
//
//   3. NO DEFINITION ANOTHER MODULE OWNS. The RKA baseline, the LPJ lateness
//      threshold and the spec 8.4 checklist arrive through the three optional
//      ports and are never re-derived. An absent port produces
//      `SUMBER_TIDAK_TERPASANG`, not a zero that reads as "nothing to do".
//
//   4. A NUMBER THE CALLER MAY NOT SEE IS ABSENT, NOT ZERO. The three gated
//      figures resolve to `nilai: null` with `IZIN_TIDAK_DIMILIKI`.
//
// PERMISSIONS GO THROUGH `canonicalPermission`, so a code the shipped catalogue
// does not carry FAILS CLOSED with `IZIN_BELUM_TERDAFTAR` instead of being
// treated as granted.
//
// BRANCH SCOPE IS THE SESSION'S, NEVER THE REQUEST'S (spec 2 rule 3, spec 16
// scenario 24). `cabangId` on a filter NARROWS the answer, and a branch outside
// the session's set is REFUSED with `CABANG_DILUAR_SCOPE` rather than answered
// with an empty page: an empty dashboard reads as "that branch did nothing",
// which is a wrong answer presented as a right one.
import { canonicalPermission } from "../auth/index";
import {
  BATAS_RINCIAN_BAWAAN,
  BATAS_RINCIAN_MAKS,
  KODE_DASHBOARD,
  METRIK_DASHBOARD,
  PERMISSION_DASHBOARD,
  POLA_PERSEN,
  POLA_UANG,
  TAHAP_ANTRIAN,
  DashboardError,
  type AlasanKosong,
  type BarisAntrian,
  type BarisKolektibilitas,
  type BarisRincian,
  type CabangDashboard,
  type DashboardContext,
  type DashboardEngine,
  type DashboardEngineDeps,
  type FilterDashboard,
  type FilterRincian,
  type JenisAngka,
  type KodeDashboard,
  type KunciMetrik,
  type Metrik,
  type Persen,
  type PeriodeDashboard,
  type RincianDashboard,
  type RingkasanDashboard,
  type StatusClosingDashboard,
  type StatusPeriode,
  type SumberAngka,
  type TahapAntrian,
  type Uang,
} from "./contract";
import * as repo from "./repo";
import type { Lingkup, PeriodeRow } from "./repo";

// ---------------------------------------------------------------------------
// Money and percentages, at the boundary
// ---------------------------------------------------------------------------

/**
 * Normalises what Postgres handed back. Every query in ./repo.ts casts
 * `::numeric(20,2)` BEFORE `::text`; this is the second line of defence, and it
 * fails LOUDLY rather than letting a bare '0' reach a page as if it were money.
 */
function uang(nilai: string | null | undefined): Uang {
  if (nilai === null || nilai === undefined) return "0.00";
  if (!POLA_UANG.test(nilai)) {
    throw new Error(
      `modules/dashboard: nilai uang dari database bukan numeric(20,2)::text: ${JSON.stringify(nilai)}. ` +
        "Cast ke ::numeric(20,2) SEBELUM ::text (lihat catatan driver di modules/jurnal/repo.ts).",
    );
  }
  return nilai;
}

const POLA_SEN = /^(-?)(\d+)\.(\d{2})$/;

function keSen(nilai: string): bigint {
  const m = POLA_SEN.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2] as string) * 100n + BigInt(m[3] as string);
  return m[1] === "-" ? -besar : besar;
}

function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/**
 * `pembilang / penyebut * 100`, two decimals, as a STRING, in integer
 * arithmetic from end to end.
 *
 * Null when the denominator is zero. NOT "0.00" and not Infinity: a ratio with
 * nothing underneath it is a question this system cannot answer, and the
 * caller turns that null into `PEMBAGI_NOL`.
 *
 * Rounds half away from zero, done on integers, because a percentage that
 * reached a page through a float would be the one number on the screen with a
 * different rounding rule from every other.
 */
function persen(pembilang: bigint, penyebut: bigint): Persen | null {
  if (penyebut === 0n) return null;
  const negatif = pembilang < 0n !== penyebut < 0n;
  const a = pembilang < 0n ? -pembilang : pembilang;
  const b = penyebut < 0n ? -penyebut : penyebut;
  const ratusan = (a * 10000n * 2n + b) / (b * 2n);
  const nilai = `${ratusan / 100n}.${String(ratusan % 100n).padStart(2, "0")}`;
  const hasil = negatif && ratusan !== 0n ? `-${nilai}` : nilai;
  if (!POLA_PERSEN.test(hasil)) {
    throw new Error(`modules/dashboard: persen di luar pola: ${JSON.stringify(hasil)}`);
  }
  return hasil;
}

// ---------------------------------------------------------------------------
// The metric catalogue
// ---------------------------------------------------------------------------
//
// `kunci` is written as a STRING LITERAL rather than as `METRIK_DASHBOARD.X`.
// ./contract.ts imports this file (the factory lives there), so the cycle
// contract -> service -> contract is closed at module-evaluation time, and
// reading a runtime binding of ./contract.ts HERE, at module scope, throws
// "Cannot access before initialization". modules/tools/service.ts and
// modules/rka/kesalahan.ts do the same for the same reason. The literals are
// still type checked: the record is annotated with `KunciMetrik` keys.

interface EntriMetrik {
  nama: string;
  jenis: JenisAngka;
}

const KATALOG_METRIK: Readonly<Record<KunciMetrik, EntriMetrik>> = Object.freeze({
  DANA_TERSEDIA: { nama: "Saldo Kas dan Setara Kas", jenis: "UANG" },
  DANA_TERSALUR: { nama: "Dana Tersalur Periode Ini", jenis: "UANG" },
  PENYALURAN_PUMK: { nama: "Realisasi Penyaluran PUMK", jenis: "UANG" },
  REALISASI_NON_PUMK: { nama: "Realisasi Penyaluran Non PUMK", jenis: "UANG" },
  OUTSTANDING_PUMK: { nama: "Outstanding Piutang PUMK", jenis: "UANG" },
  MITRA_AKTIF: { nama: "Jumlah Mitra Binaan Aktif", jenis: "CACAH" },
  RASIO_KOLEKTIBILITAS_LANCAR: { nama: "Rasio Kolektibilitas Lancar", jenis: "PERSEN" },
  TINGKAT_PENGEMBALIAN: { nama: "Tingkat Pengembalian", jenis: "PERSEN" },
  ANGGARAN_NON_PUMK: { nama: "Anggaran Non PUMK Bulan Ini", jenis: "UANG" },
  EFEKTIVITAS_NON_PUMK: { nama: "Efektivitas Penyaluran Non PUMK", jenis: "PERSEN" },
  LPJ_TERLAMBAT: { nama: "LPJ Non PUMK Terlambat", jenis: "CACAH" },
});

/** Summary order: the KPI row of spec 11 first, then the two budget figures. */
const URUTAN_METRIK: readonly KunciMetrik[] = Object.freeze([
  "OUTSTANDING_PUMK",
  "PENYALURAN_PUMK",
  "REALISASI_NON_PUMK",
  "DANA_TERSALUR",
  "MITRA_AKTIF",
  "RASIO_KOLEKTIBILITAS_LANCAR",
  "TINGKAT_PENGEMBALIAN",
  "DANA_TERSEDIA",
  "ANGGARAN_NON_PUMK",
  "EFEKTIVITAS_NON_PUMK",
  "LPJ_TERLAMBAT",
]);

// ---------------------------------------------------------------------------
// The work queue catalogue (spec 11 panel 7)
// ---------------------------------------------------------------------------
//
// One row per stage a document can be PARKED at, with the CANONICAL permission
// whose holder acts on it. Both columns are copied from the owning module's
// `TRANSISI_SAH` table: for each stage, `status` is the `dari` of the edges
// leaving it and `izin` is those edges' `izin`. Restated here rather than
// imported because `bun tools/check-boundaries.ts` forbids reaching into a
// sibling module's internals, and ./dashboard-antrian.test.ts pins each pairing
// against the shipped state machine's own behaviour.

interface EntriTahap {
  nama: string;
  izin: string;
  jenis: "PUMK" | "NONPUMK";
  status: readonly string[];
}

const KATALOG_TAHAP: Readonly<Record<TahapAntrian, EntriTahap>> = Object.freeze({
  PUMK_SURVEY: {
    nama: "PUMK menunggu survey",
    izin: "pumk.survey",
    jenis: "PUMK",
    status: ["SURVEY_PENDING"],
  },
  PUMK_REVIEW: {
    nama: "PUMK menunggu review Checker",
    izin: "pumk.review",
    jenis: "PUMK",
    status: ["REVIEW_CHECKER"],
  },
  PUMK_PERSETUJUAN: {
    nama: "PUMK menunggu persetujuan",
    izin: "pumk.approve",
    jenis: "PUMK",
    status: ["MENUNGGU_PERSETUJUAN"],
  },
  PUMK_AKAD: {
    // Two statuses, one actor: `pumk.akad` carries both BUAT_AKAD (DISETUJUI ->
    // AKAD_DIBUAT) and GENERATE_JADWAL (AKAD_DIBUAT -> JADWAL_SIAP), so a
    // proposal sitting at either is waiting on the same person's queue.
    nama: "PUMK menunggu akad dan jadwal",
    izin: "pumk.akad",
    jenis: "PUMK",
    status: ["DISETUJUI", "AKAD_DIBUAT"],
  },
  PUMK_PENCAIRAN: {
    nama: "PUMK menunggu pencairan",
    izin: "pumk.pencairan",
    jenis: "PUMK",
    status: ["JADWAL_SIAP"],
  },
  NONPUMK_PENILAIAN: {
    nama: "Non PUMK menunggu penilaian",
    izin: "nonpumk.penilaian",
    jenis: "NONPUMK",
    status: ["PENILAIAN"],
  },
  NONPUMK_REVIEW: {
    nama: "Non PUMK menunggu review Checker",
    izin: "nonpumk.review",
    jenis: "NONPUMK",
    status: ["REVIEW_CHECKER"],
  },
  NONPUMK_PERSETUJUAN: {
    nama: "Non PUMK menunggu persetujuan",
    izin: "nonpumk.approve",
    jenis: "NONPUMK",
    status: ["MENUNGGU_PERSETUJUAN"],
  },
  NONPUMK_PENYALURAN: {
    // DISALURKAN is deliberately NOT here. Staging is still open at that state,
    // but the document is not WAITING on the disburser: it is waiting on the
    // recipient's LPJ once staging closes, and counting it as a pending
    // disbursement would put every finished grant back in somebody's queue.
    nama: "Non PUMK menunggu penyaluran",
    izin: "nonpumk.penyaluran",
    jenis: "NONPUMK",
    status: ["DISETUJUI"],
  },
  NONPUMK_LPJ_VERIFIKASI: {
    nama: "LPJ Non PUMK menunggu verifikasi",
    izin: "nonpumk.lpj.verifikasi",
    jenis: "NONPUMK",
    status: ["LPJ_DIAJUKAN"],
  },
});

const URUTAN_TAHAP: readonly TahapAntrian[] = Object.freeze([
  "PUMK_SURVEY",
  "PUMK_REVIEW",
  "PUMK_PERSETUJUAN",
  "PUMK_AKAD",
  "PUMK_PENCAIRAN",
  "NONPUMK_PENILAIAN",
  "NONPUMK_REVIEW",
  "NONPUMK_PERSETUJUAN",
  "NONPUMK_PENYALURAN",
  "NONPUMK_LPJ_VERIFIKASI",
]);

// ---------------------------------------------------------------------------
// Drill-down keys
// ---------------------------------------------------------------------------
//
// STRUCTURED, and parsed rather than looked up in a second table. A key names
// the FAMILY and the member: `metrik:OUTSTANDING_PUMK`,
// `kolektibilitas:MACET`, `antrian:PUMK_SURVEY`. The summary emits them and a
// client never constructs one, so the parse is a validation of something the
// server itself wrote a moment ago; an unrecognised key is REFUSED with
// `RINCIAN_TIDAK_DIKENAL` rather than answered with an empty list, because an
// empty list reads as "there is nothing there".

const KUNCI_METRIK = (kunci: KunciMetrik): string => `metrik:${kunci}`;
const KUNCI_KOLEKTIBILITAS = (kelas: string): string => `kolektibilitas:${kelas}`;
const KUNCI_ANTRIAN = (tahap: TahapAntrian): string => `antrian:${tahap}`;

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/**
 * A metric's answer BEFORE it is dressed as a `Metrik`: the figure, which
 * artefact produced it, and (when it is absent) why.
 *
 * `nilai` and `sumber` are null together, always. `bentuk` keeps that
 * invariant in one place instead of eleven.
 */
interface Angka {
  nilai: string | null;
  sumber: SumberAngka | null;
  alasan: AlasanKosong | null;
}

const kosong = (alasan: AlasanKosong): Angka => ({
  nilai: null,
  sumber: null,
  alasan,
});

const ada = (nilai: string, sumber: SumberAngka): Angka => ({
  nilai,
  sumber,
  alasan: null,
});

/**
 * Everything the whole page is computed FROM, resolved once per request.
 *
 * The point of gathering it is that `sumberBeku` is decided HERE, from the
 * period's status, and then read by every figure. A metric cannot reach for the
 * request to decide how to read a closed month, because the request is not in
 * scope by the time the figures are computed.
 */
interface Basis {
  periode: PeriodeRow;
  lingkup: Lingkup;
  /** The period is CLOSED, so money is read frozen. Decided once, never asked. */
  sumberBeku: boolean;
  /** A CLOSED period whose `saldo_akun_periode` rows are missing. */
  bekuHilang: boolean;
  adaSnapshot: boolean;
  akunPiutangId: string | null;
  akunNonPumkIds: readonly string[];
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEngineDashboard(deps: DashboardEngineDeps): DashboardEngine {
  const db = deps.db;
  const jam = deps.jam ?? (() => new Date());

  function tolak(
    kode: KodeDashboard,
    pesan: string,
    detail: Record<string, unknown> = {},
  ): DashboardError {
    return new DashboardError(kode, pesan, detail);
  }

  /** Canonical form, or a fail-closed refusal. Never "treat unknown as held". */
  function kanonik(kode: string): string {
    const hasil = canonicalPermission(kode);
    if (!hasil) {
      throw tolak(
        KODE_DASHBOARD.IZIN_BELUM_TERDAFTAR,
        `Permission "${kode}" belum terdaftar di katalog; operasi ditolak (fail closed)`,
        { permission: kode },
      );
    }
    return hasil;
  }

  function punyaIzin(ctx: DashboardContext, kode: string): boolean {
    return ctx.permissions.includes(kanonik(kode));
  }

  function wajibIzin(ctx: DashboardContext, kode: string): void {
    const k = kanonik(kode);
    if (!ctx.permissions.includes(k)) {
      throw tolak(KODE_DASHBOARD.TIDAK_BERWENANG, "Akses ditolak", { permission: k });
    }
  }

  /** Every branch the SESSION resolved. Never empty. */
  function cabangTerlihat(ctx: DashboardContext): string[] {
    return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
  }

  async function lingkup(
    ctx: DashboardContext,
    cabangId: string | null | undefined,
  ): Promise<Lingkup> {
    const terlihat = cabangTerlihat(ctx);
    if (cabangId === null || cabangId === undefined) {
      return { bumnId: ctx.bumnId, cabangIds: terlihat };
    }
    if (!terlihat.includes(cabangId)) {
      throw tolak(KODE_DASHBOARD.CABANG_DILUAR_SCOPE, "Cabang ini berada di luar scope Anda", {
        cabangId,
      });
    }
    const baris = await repo.cabang(db, ctx.bumnId, cabangId);
    if (!baris) {
      throw tolak(KODE_DASHBOARD.CABANG_TIDAK_DITEMUKAN, "Cabang tidak ditemukan", {
        cabangId,
      });
    }
    return { bumnId: ctx.bumnId, cabangIds: [cabangId] };
  }

  function batasBaris(nilai: number | null | undefined): number {
    if (nilai === null || nilai === undefined) return BATAS_RINCIAN_BAWAAN;
    if (!Number.isInteger(nilai) || nilai < 1) return BATAS_RINCIAN_BAWAAN;
    return Math.min(nilai, BATAS_RINCIAN_MAKS);
  }

  // --- period resolution ---------------------------------------------------

  async function periodeUntuk(
    filter: FilterDashboard,
    ctx: DashboardContext,
  ): Promise<PeriodeRow> {
    if (filter.periodeId) {
      const p = await repo.periodeById(db, ctx.bumnId, filter.periodeId);
      if (!p) {
        throw tolak(KODE_DASHBOARD.PERIODE_TIDAK_ADA, "Periode tidak ditemukan", {
          periodeId: filter.periodeId,
        });
      }
      return p;
    }
    if (filter.tahun && filter.bulan) {
      const p = await repo.periodeByBulan(db, ctx.bumnId, filter.tahun, filter.bulan);
      if (!p) {
        throw tolak(
          KODE_DASHBOARD.PERIODE_TIDAK_ADA,
          `Periode ${filter.tahun}-${String(filter.bulan).padStart(2, "0")} belum dibuat`,
          { tahun: filter.tahun, bulan: filter.bulan },
        );
      }
      return p;
    }
    const p = await repo.periodeBawaan(db, ctx.bumnId, filter.tahun ?? null);
    if (!p) {
      // NOT invented. A dashboard that manufactured a month would be the only
      // place in the system where a reporting period exists without a row.
      throw tolak(
        KODE_DASHBOARD.PERIODE_TIDAK_ADA,
        "Belum ada periode akuntansi untuk entitas ini",
        { tahun: filter.tahun ?? null },
      );
    }
    return p;
  }

  async function basisUntuk(
    filter: FilterDashboard,
    ctx: DashboardContext,
  ): Promise<Basis> {
    const periode = await periodeUntuk(filter, ctx);
    const l = await lingkup(ctx, filter.cabangId);
    const sumberBeku = periode.status === "CLOSED";
    const [bekuAda, snapshotAda, akunPiutang, akunNonPumk] = await Promise.all([
      sumberBeku ? repo.adaSaldoBeku(db, periode.id) : Promise.resolve(true),
      repo.adaSnapshotKolektibilitas(db, periode.id),
      repo.akunPiutangPumk(db, ctx.bumnId),
      repo.akunBebanNonPumk(db, ctx.bumnId),
    ]);
    return {
      periode,
      lingkup: l,
      sumberBeku,
      bekuHilang: sumberBeku && !bekuAda,
      adaSnapshot: snapshotAda,
      akunPiutangId: akunPiutang?.id ?? null,
      akunNonPumkIds: akunNonPumk.map((a) => a.id),
    };
  }

  // --- the money figures ---------------------------------------------------

  async function danaTersedia(b: Basis): Promise<Angka> {
    if (b.bekuHilang) return kosong("SALDO_PERIODE_BELUM_DIBEKUKAN");
    if (b.sumberBeku) {
      const g = await repo.saldoKasBeku(db, b.lingkup, b.periode.id);
      return ada(uang(g.neto), "SALDO_AKUN_PERIODE");
    }
    const g = await repo.saldoKasLedger(db, b.lingkup, b.periode.tanggal_akhir);
    return ada(uang(g.neto), "V_LEDGER_BARIS");
  }

  async function penyaluranPumk(b: Basis): Promise<Angka> {
    if (b.akunPiutangId === null) return kosong("PEMETAAN_AKUN_BELUM_ADA");
    if (b.bekuHilang) return kosong("SALDO_PERIODE_BELUM_DIBEKUKAN");
    if (b.sumberBeku) {
      const g = await repo.gerakAkunBeku(db, b.lingkup, b.periode.id, [b.akunPiutangId]);
      return ada(uang(g.debit), "SALDO_AKUN_PERIODE");
    }
    const g = await repo.gerakAkunLedger(
      db,
      b.lingkup,
      [b.akunPiutangId],
      b.periode.tanggal_mulai,
      b.periode.tanggal_akhir,
    );
    return ada(uang(g.debit), "V_LEDGER_BARIS");
  }

  async function realisasiNonPumk(b: Basis): Promise<Angka> {
    if (b.bekuHilang) return kosong("SALDO_PERIODE_BELUM_DIBEKUKAN");
    if (b.sumberBeku) {
      const g = await repo.gerakAkunBeku(db, b.lingkup, b.periode.id, b.akunNonPumkIds);
      return ada(uang(g.neto), "SALDO_AKUN_PERIODE");
    }
    const g = await repo.gerakAkunLedger(
      db,
      b.lingkup,
      b.akunNonPumkIds,
      b.periode.tanggal_mulai,
      b.periode.tanggal_akhir,
    );
    return ada(uang(g.neto), "V_LEDGER_BARIS");
  }

  /**
   * PUMK plus Non PUMK for the month. Null when EITHER half is null, and it
   * inherits that half's reason: a total that silently dropped one of its two
   * components would be smaller than the truth and would look like a fact.
   */
  function danaTersalur(pumk: Angka, nonpumk: Angka): Angka {
    if (pumk.nilai === null) return kosong(pumk.alasan ?? "SUMBER_TIDAK_TERPASANG");
    if (nonpumk.nilai === null) return kosong(nonpumk.alasan ?? "SUMBER_TIDAK_TERPASANG");
    return ada(
      sen(keSen(pumk.nilai) + keSen(nonpumk.nilai)),
      pumk.sumber ?? "V_LEDGER_BARIS",
    );
  }

  // --- the portfolio figures -----------------------------------------------

  async function portofolio(b: Basis): Promise<{
    outstanding: Angka;
    mitra: Angka;
    lancar: Angka;
  }> {
    if (b.sumberBeku || b.adaSnapshot) {
      if (!b.adaSnapshot) {
        const a = kosong("KOLEKTIBILITAS_BELUM_DIJALANKAN");
        return { outstanding: a, mitra: a, lancar: a };
      }
      const [p, kelas] = await Promise.all([
        repo.portofolioSnapshot(db, b.lingkup, b.periode.id),
        repo.ringkasKolektibilitas(db, b.lingkup, b.periode.id),
      ]);
      const total = keSen(uang(p.outstanding_pokok));
      const baris = kelas.find((k) => k.kolektibilitas === "LANCAR");
      const lancarSen = baris ? keSen(uang(baris.outstanding_pokok)) : 0n;
      const rasio = persen(lancarSen, total);
      return {
        outstanding: ada(uang(p.outstanding_pokok), "KOLEKTIBILITAS_SNAPSHOT"),
        mitra: ada(p.jumlah_mitra, "KOLEKTIBILITAS_SNAPSHOT"),
        lancar:
          rasio === null
            ? kosong("PEMBAGI_NOL")
            : ada(rasio, "KOLEKTIBILITAS_SNAPSHOT"),
      };
    }
    // An OPEN period with no snapshot: outstanding is the LIVE sub ledger, and
    // the CLASSIFICATION genuinely does not exist yet. Kolektibilitas is a
    // closing step (spec 8.1), so computing a class here would be this module
    // inventing a definition modules/closing owns.
    const p = await repo.portofolioSubLedger(db, b.lingkup);
    return {
      outstanding: ada(uang(p.outstanding_pokok), "SUB_LEDGER"),
      mitra: ada(p.jumlah_mitra, "SUB_LEDGER"),
      lancar: kosong("KOLEKTIBILITAS_BELUM_DIJALANKAN"),
    };
  }

  async function tingkatPengembalian(b: Basis): Promise<Angka> {
    const r = await repo.pengembalian(
      db,
      b.lingkup,
      b.periode.tanggal_mulai,
      b.periode.tanggal_akhir,
    );
    const rasio = persen(keSen(uang(r.terbayar)), keSen(uang(r.jatuh_tempo)));
    // SUB_LEDGER in both directions, and stated as such: there is no frozen
    // artefact for a schedule row (see ./repo.ts `pengembalian`).
    return rasio === null ? kosong("PEMBAGI_NOL") : ada(rasio, "SUB_LEDGER");
  }

  // --- the budget figures --------------------------------------------------

  /** The baseline modules/rka resolved, or the reason there is no figure. */
  async function baselineNonPumk(
    b: Basis,
    ctx: DashboardContext,
    cabangFilter: string | null,
  ): Promise<{ rkaId: string; versi: number } | AlasanKosong> {
    if (!punyaIzin(ctx, PERMISSION_DASHBOARD.RKA)) return "IZIN_TIDAK_DIMILIKI";
    if (!deps.rka) return "SUMBER_TIDAK_TERPASANG";
    const rka = await deps.rka.baseline(
      { tahun: b.periode.tahun, jenis: "NON_PUMK", cabangId: cabangFilter },
      ctx,
    );
    if (!rka) return "BASELINE_RKA_TIDAK_ADA";
    return { rkaId: rka.id, versi: rka.versi };
  }

  async function anggaranNonPumk(
    b: Basis,
    baseline: { rkaId: string; versi: number } | AlasanKosong,
  ): Promise<Angka> {
    if (typeof baseline === "string") return kosong(baseline);
    const hasil = await repo.anggaranBulan(db, baseline.rkaId, b.periode.bulan);
    if (Number(hasil.jumlah_baris) === 0) {
      const adaBaris = await repo.adaBarisAnggaran(db, baseline.rkaId);
      // A baseline with lines but none for this month is budgeted ANNUALLY
      // (`rka_detail.bulan` is nullable by design). 0.00 there would report a
      // data-entry convention as a management fact.
      return kosong(adaBaris ? "ANGGARAN_TIDAK_PER_BULAN" : "BASELINE_RKA_TIDAK_ADA");
    }
    return ada(uang(hasil.total), "RKA");
  }

  function efektivitasNonPumk(realisasi: Angka, anggaran: Angka): Angka {
    if (anggaran.nilai === null) return kosong(anggaran.alasan ?? "SUMBER_TIDAK_TERPASANG");
    if (realisasi.nilai === null) return kosong(realisasi.alasan ?? "SUMBER_TIDAK_TERPASANG");
    const rasio = persen(keSen(realisasi.nilai), keSen(anggaran.nilai));
    return rasio === null ? kosong("PEMBAGI_NOL") : ada(rasio, "RKA");
  }

  // --- the LPJ figure ------------------------------------------------------

  async function lpjTerlambat(
    ctx: DashboardContext,
    cabangFilter: string | null,
  ): Promise<Angka> {
    if (!punyaIzin(ctx, PERMISSION_DASHBOARD.NONPUMK)) return kosong("IZIN_TIDAK_DIMILIKI");
    if (!deps.nonpumk) return kosong("SUMBER_TIDAK_TERPASANG");
    // `terlambat` is THEIRS: it compares the age of the last disbursement
    // against `batasan.batas_hari_lpj_non_pumk`, which is CONFIGURATION. A
    // second copy of that comparison here would drift the day somebody changes
    // the parameter.
    const baris = await deps.nonpumk.monitoringLpj(
      { cabangId: cabangFilter, hanyaTerlambat: true },
      ctx,
    );
    return ada(String(baris.length), "PROSES");
  }

  // --- assembling a Metrik -------------------------------------------------

  function bentuk(kunci: KunciMetrik, a: Angka): Metrik {
    const entri = KATALOG_METRIK[kunci];
    return {
      kunci,
      nama: entri.nama,
      jenis: entri.jenis,
      nilai: a.nilai,
      sumber: a.nilai === null ? null : a.sumber,
      alasanKosong: a.nilai === null ? a.alasan : null,
      // An absent number has no rows behind it, and offering a link that
      // answers with nothing is worse than offering none.
      rincian: a.nilai === null ? null : KUNCI_METRIK(kunci),
    };
  }

  // --- the whole summary ---------------------------------------------------

  async function hitungSemua(
    b: Basis,
    filter: FilterDashboard,
    ctx: DashboardContext,
  ): Promise<Record<KunciMetrik, Angka>> {
    const cabangFilter = filter.cabangId ?? null;
    const [tersedia, pumk, nonpumk, folio, pengembalian, lpj, baseline] = await Promise.all([
      danaTersedia(b),
      penyaluranPumk(b),
      realisasiNonPumk(b),
      portofolio(b),
      tingkatPengembalian(b),
      lpjTerlambat(ctx, cabangFilter),
      baselineNonPumk(b, ctx, cabangFilter),
    ]);
    const anggaran = await anggaranNonPumk(b, baseline);
    return {
      DANA_TERSEDIA: tersedia,
      DANA_TERSALUR: danaTersalur(pumk, nonpumk),
      PENYALURAN_PUMK: pumk,
      REALISASI_NON_PUMK: nonpumk,
      OUTSTANDING_PUMK: folio.outstanding,
      MITRA_AKTIF: folio.mitra,
      RASIO_KOLEKTIBILITAS_LANCAR: folio.lancar,
      TINGKAT_PENGEMBALIAN: pengembalian,
      ANGGARAN_NON_PUMK: anggaran,
      EFEKTIVITAS_NON_PUMK: efektivitasNonPumk(nonpumk, anggaran),
      LPJ_TERLAMBAT: lpj,
    };
  }

  async function panelKolektibilitas(
    b: Basis,
  ): Promise<{ baris: BarisKolektibilitas[]; alasan: AlasanKosong | null }> {
    if (!b.adaSnapshot) {
      return { baris: [], alasan: "KOLEKTIBILITAS_BELUM_DIJALANKAN" };
    }
    const [kelas, ringkas] = await Promise.all([
      repo.kelasKolektibilitas(db),
      repo.ringkasKolektibilitas(db, b.lingkup, b.periode.id),
    ]);
    const indeks = new Map(ringkas.map((r) => [r.kolektibilitas, r]));
    const total = ringkas.reduce(
      (akumulasi, r) => akumulasi + keSen(uang(r.outstanding_pokok)),
      0n,
    );
    // EVERY class, in `urutan`, including the ones with nothing in them. A
    // composition panel that hid the empty classes would change shape between
    // months and could not be read as a distribution.
    return {
      baris: kelas.map((k) => {
        const r = indeks.get(k.kode);
        const nilai = r ? uang(r.outstanding_pokok) : "0.00";
        return {
          kelas: k.kode,
          namaKelas: k.nama,
          bermasalah: k.is_bermasalah,
          jumlahAkad: r ? Number(r.jumlah_akad) : 0,
          outstandingPokok: nilai,
          persen: persen(keSen(nilai), total),
          rincian: KUNCI_KOLEKTIBILITAS(k.kode),
        };
      }),
      alasan: null,
    };
  }

  async function panelAntrian(
    b: Basis,
    filter: FilterDashboard,
    ctx: DashboardContext,
  ): Promise<BarisAntrian[]> {
    const [pumk, nonpumk] = await Promise.all([
      repo.antrianPumk(db, b.lingkup),
      repo.antrianNonPumk(db, b.lingkup),
    ]);
    const hitung = (jenis: "PUMK" | "NONPUMK", status: readonly string[]): number => {
      const sumber = jenis === "PUMK" ? pumk : nonpumk;
      return sumber
        .filter((r) => status.includes(r.status))
        .reduce((akumulasi, r) => akumulasi + Number(r.n), 0);
    };
    const hanyaMilikSaya = filter.hanyaMilikSaya === true;
    const baris = URUTAN_TAHAP.map((tahap) => {
      const entri = KATALOG_TAHAP[tahap];
      return {
        tahap,
        nama: entri.nama,
        izin: kanonik(entri.izin),
        jumlah: hitung(entri.jenis, entri.status),
        milikSaya: punyaIzin(ctx, entri.izin),
        rincian: KUNCI_ANTRIAN(tahap),
      };
    });
    // The WHOLE queue by default: a branch manager needs to see what their
    // branch is waiting on even where they are not the actor. `hanyaMilikSaya`
    // narrows it (spec 11: "dokumen yang menunggu aksi user yang login").
    return hanyaMilikSaya ? baris.filter((r) => r.milikSaya) : baris;
  }

  async function panelClosing(
    b: Basis,
    ctx: DashboardContext,
  ): Promise<StatusClosingDashboard> {
    const dasar = {
      periodeId: b.periode.id,
      status: b.periode.status as StatusPeriode,
      closedAt: b.periode.closed_at,
    };
    if (!punyaIzin(ctx, PERMISSION_DASHBOARD.CLOSING)) {
      // Returning zero checks would both leak nothing and lie; returning the
      // list would leak the closing evidence to a role the catalogue keeps it
      // from (contract rule 4).
      return { ...dasar, prasyarat: null, alasanKosong: "IZIN_TIDAK_DIMILIKI" };
    }
    if (!deps.closing) {
      return { ...dasar, prasyarat: null, alasanKosong: "SUMBER_TIDAK_TERPASANG" };
    }
    // Spec 8.4's ten checks are modules/closing's. A dashboard that re-listed
    // them would be a second opinion about whether a month may be closed.
    const hasil = await deps.closing.periksaPrasyarat(b.periode.id, ctx);
    return {
      ...dasar,
      prasyarat: {
        boleh: hasil.boleh,
        perluKonfirmasi: hasil.perluKonfirmasi,
        hasil: hasil.hasil.map((h) => ({
          nomor: h.nomor,
          kode: h.kode,
          status: h.status,
          alasan: h.alasan,
        })),
      },
      alasanKosong: null,
    };
  }

  function keperiode(p: PeriodeRow): PeriodeDashboard {
    return {
      id: p.id,
      tahun: p.tahun,
      bulan: p.bulan,
      status: p.status as StatusPeriode,
      tanggalMulai: p.tanggal_mulai,
      tanggalAkhir: p.tanggal_akhir,
    };
  }

  // --- drill-down ----------------------------------------------------------

  /**
   * `batas + 1` rows are fetched and the extra one is DROPPED, so `terpotong`
   * is a fact about the data rather than a guess from `length === batas`. A
   * drill-down whose last page silently looked truncated would send somebody
   * looking for rows that are not there.
   */
  function potong<T>(baris: T[], batas: number): { baris: T[]; terpotong: boolean } {
    return baris.length > batas
      ? { baris: baris.slice(0, batas), terpotong: true }
      : { baris, terpotong: false };
  }

  function bungkus(
    kunci: string,
    nama: string,
    sumber: SumberAngka,
    total: Uang | null,
    hasil: { baris: BarisRincian[]; terpotong: boolean },
  ): RincianDashboard {
    return {
      kunci,
      nama,
      sumber,
      jumlah: hasil.baris.length,
      total,
      baris: hasil.baris,
      terpotong: hasil.terpotong,
    };
  }

  async function rincianMetrik(
    kunci: KunciMetrik,
    b: Basis,
    filter: FilterRincian,
    ctx: DashboardContext,
    batas: number,
  ): Promise<RincianDashboard> {
    const nama = KATALOG_METRIK[kunci].nama;
    const kunciPenuh = KUNCI_METRIK(kunci);
    const cabangFilter = filter.cabangId ?? null;
    const dari = b.periode.tanggal_mulai;
    const sampai = b.periode.tanggal_akhir;

    /** Frozen or live rows for a movement over a set of accounts. */
    const gerak = async (
      akunIds: readonly string[],
      sisi: "DEBIT" | "NETO",
      total: Uang | null,
    ): Promise<RincianDashboard> => {
      if (b.sumberBeku) {
        const baris = await repo.barisGerakBeku(
          db,
          b.lingkup,
          b.periode.id,
          akunIds,
          sisi,
          batas + 1,
        );
        return bungkus(
          kunciPenuh,
          nama,
          "SALDO_AKUN_PERIODE",
          total,
          potong(
            baris.map((r) => ({
              id: r.id,
              entitas: "saldo_akun_periode",
              label: `${r.kode} ${r.nama}`,
              cabangId: r.cabang_id,
              tanggal: sampai,
              nilai: uang(r.nilai),
              fakta: { akunId: r.akun_id, akunKode: r.kode, periodeId: b.periode.id },
            })),
            batas,
          ),
        );
      }
      const baris = await repo.barisGerakLedger(
        db,
        b.lingkup,
        akunIds,
        dari,
        sampai,
        sisi,
        batas + 1,
      );
      return bungkus(
        kunciPenuh,
        nama,
        "V_LEDGER_BARIS",
        total,
        potong(
          baris.map((r) => ({
            id: r.jurnal_id,
            entitas: "jurnal",
            label: r.no_jurnal,
            cabangId: r.cabang_id,
            tanggal: r.tanggal_transaksi,
            nilai: uang(r.nilai),
            fakta: {
              jurnalBarisId: r.id,
              akunKode: r.akun_kode,
              keterangan: r.keterangan,
            },
          })),
          batas,
        ),
      );
    };

    switch (kunci) {
      case METRIK_DASHBOARD.DANA_TERSEDIA: {
        const angka = await danaTersedia(b);
        if (b.sumberBeku) {
          const baris = await repo.barisSaldoKasBeku(db, b.lingkup, b.periode.id, batas + 1);
          return bungkus(
            kunciPenuh,
            nama,
            "SALDO_AKUN_PERIODE",
            angka.nilai,
            potong(
              baris.map((r) => ({
                id: r.id,
                entitas: "saldo_akun_periode",
                label: `${r.kode} ${r.nama}`,
                cabangId: r.cabang_id,
                tanggal: sampai,
                nilai: uang(r.nilai),
                fakta: { akunId: r.akun_id, akunKode: r.kode },
              })),
              batas,
            ),
          );
        }
        const baris = await repo.barisSaldoKasLedger(db, b.lingkup, sampai, batas + 1);
        return bungkus(
          kunciPenuh,
          nama,
          "V_LEDGER_BARIS",
          angka.nilai,
          potong(
            baris.map((r) => ({
              id: r.akun_id,
              entitas: "akun",
              label: `${r.kode} ${r.nama}`,
              cabangId: r.cabang_id,
              tanggal: sampai,
              nilai: uang(r.nilai),
              fakta: { akunKode: r.kode, sampai },
            })),
            batas,
          ),
        );
      }

      case METRIK_DASHBOARD.PENYALURAN_PUMK: {
        if (b.akunPiutangId === null) {
          throw tolak(
            KODE_DASHBOARD.RINCIAN_TIDAK_DIKENAL,
            "Akun piutang PUMK belum dipetakan, sehingga tidak ada baris yang bisa ditelusuri",
            { kunci: kunciPenuh, eventCode: "PENCAIRAN_PUMK" },
          );
        }
        const angka = await penyaluranPumk(b);
        return gerak([b.akunPiutangId], "DEBIT", angka.nilai);
      }

      case METRIK_DASHBOARD.REALISASI_NON_PUMK:
      case METRIK_DASHBOARD.EFEKTIVITAS_NON_PUMK: {
        // EFEKTIVITAS drills to its NUMERATOR. The denominator has its own
        // metric (`ANGGARAN_NON_PUMK`) with its own key, so pointing this one
        // at the budget lines would leave the realisation untraceable while
        // duplicating the budget's drill-down.
        const angka = await realisasiNonPumk(b);
        return gerak(b.akunNonPumkIds, "NETO", angka.nilai);
      }

      case METRIK_DASHBOARD.DANA_TERSALUR: {
        // BOTH halves, in one list, because that is what was clicked. The
        // account sets are disjoint (a receivable and an expense), so a line
        // cannot appear twice.
        const ids =
          b.akunPiutangId === null
            ? b.akunNonPumkIds
            : [b.akunPiutangId, ...b.akunNonPumkIds];
        const [pumk, nonpumk] = await Promise.all([penyaluranPumk(b), realisasiNonPumk(b)]);
        const total = danaTersalur(pumk, nonpumk).nilai;
        // NETO for the pooled list: the PUMK half has no credits inside the
        // month it was disbursed in unless it was reversed, and a reversed
        // disbursement should not be in the total either.
        return gerak(ids, "NETO", total);
      }

      case METRIK_DASHBOARD.OUTSTANDING_PUMK:
      case METRIK_DASHBOARD.MITRA_AKTIF: {
        const cacah = kunci === METRIK_DASHBOARD.MITRA_AKTIF;
        if (b.sumberBeku || b.adaSnapshot) {
          const [p, baris] = await Promise.all([
            repo.portofolioSnapshot(db, b.lingkup, b.periode.id),
            repo.barisSnapshot(db, b.lingkup, b.periode.id, null, batas + 1),
          ]);
          return bungkus(
            kunciPenuh,
            nama,
            "KOLEKTIBILITAS_SNAPSHOT",
            cacah ? null : uang(p.outstanding_pokok),
            potong(barisSnapshotKe(baris, cacah), batas),
          );
        }
        const [p, baris] = await Promise.all([
          repo.portofolioSubLedger(db, b.lingkup),
          repo.barisAkadHidup(db, b.lingkup, batas + 1),
        ]);
        return bungkus(
          kunciPenuh,
          nama,
          "SUB_LEDGER",
          cacah ? null : uang(p.outstanding_pokok),
          potong(barisAkadKe(baris, cacah), batas),
        );
      }

      case METRIK_DASHBOARD.RASIO_KOLEKTIBILITAS_LANCAR: {
        const baris = await repo.barisSnapshot(
          db,
          b.lingkup,
          b.periode.id,
          "LANCAR",
          batas + 1,
        );
        const ringkas = await repo.ringkasKolektibilitas(db, b.lingkup, b.periode.id);
        const lancar = ringkas.find((r) => r.kolektibilitas === "LANCAR");
        return bungkus(
          kunciPenuh,
          nama,
          "KOLEKTIBILITAS_SNAPSHOT",
          uang(lancar?.outstanding_pokok ?? "0.00"),
          potong(barisSnapshotKe(baris, false), batas),
        );
      }

      case METRIK_DASHBOARD.TINGKAT_PENGEMBALIAN: {
        const [r, baris] = await Promise.all([
          repo.pengembalian(db, b.lingkup, dari, sampai),
          repo.barisPengembalian(db, b.lingkup, dari, sampai, batas + 1),
        ]);
        return bungkus(
          kunciPenuh,
          nama,
          "SUB_LEDGER",
          uang(r.jatuh_tempo),
          potong(
            baris.map((j) => ({
              id: j.id,
              entitas: "pumk_jadwal_angsuran",
              label: `${j.no_akad} angsuran ${j.angsuran_ke}`,
              cabangId: j.cabang_id,
              tanggal: j.tanggal_jatuh_tempo,
              // The DENOMINATOR's contribution: `total` is what fell due, and
              // `terbayar` beside it is what came in. `total` is the value in
              // `nilai` because that is the figure the rows have to add up to.
              nilai: uang(j.total),
              fakta: {
                akadId: j.akad_id,
                terbayar: uang(j.terbayar),
                statusJadwal: j.status,
              },
            })),
            batas,
          ),
        );
      }

      case METRIK_DASHBOARD.ANGGARAN_NON_PUMK: {
        const baseline = await baselineNonPumk(b, ctx, cabangFilter);
        if (typeof baseline === "string") {
          throw tolak(
            KODE_DASHBOARD.RINCIAN_TIDAK_DIKENAL,
            "Tidak ada baseline RKA Non PUMK yang bisa ditelusuri untuk periode ini",
            { kunci: kunciPenuh, alasan: baseline },
          );
        }
        const [hasil, baris] = await Promise.all([
          repo.anggaranBulan(db, baseline.rkaId, b.periode.bulan),
          repo.barisAnggaran(db, baseline.rkaId, b.periode.bulan, batas + 1),
        ]);
        return bungkus(
          kunciPenuh,
          nama,
          "RKA",
          uang(hasil.total),
          potong(
            baris.map((r) => ({
              id: r.id,
              entitas: "rka_detail",
              label: r.bidang ? `${r.bidang}: ${r.uraian}` : r.uraian,
              // A budget line belongs to the RKA document, whose own scope may
              // be the whole entity (`rka.cabang_id` is nullable). null rather
              // than a guessed branch.
              cabangId: null,
              tanggal: null,
              nilai: uang(r.jumlah_anggaran),
              fakta: {
                rkaId: baseline.rkaId,
                versi: String(baseline.versi),
                bulan: r.bulan,
                bidang: r.bidang,
              },
            })),
            batas,
          ),
        );
      }

      case METRIK_DASHBOARD.LPJ_TERLAMBAT: {
        if (!punyaIzin(ctx, PERMISSION_DASHBOARD.NONPUMK) || !deps.nonpumk) {
          throw tolak(
            KODE_DASHBOARD.RINCIAN_TIDAK_DIKENAL,
            "Monitoring LPJ Non PUMK tidak tersedia untuk pemanggil ini",
            { kunci: kunciPenuh },
          );
        }
        const baris = await deps.nonpumk.monitoringLpj(
          { cabangId: cabangFilter, hanyaTerlambat: true },
          ctx,
        );
        return bungkus(
          kunciPenuh,
          nama,
          "PROSES",
          null,
          potong(
            baris.slice(0, batas + 1).map((r) => ({
              id: r.proposalId,
              entitas: "nonpumk_proposal",
              label: `${r.noProposal} ${r.judulProgram}`,
              cabangId: r.cabangId,
              tanggal: r.tanggalPenyaluranTerakhir,
              nilai: null,
              fakta: {
                namaPemohon: r.namaPemohon,
                totalDisalurkan: r.totalDisalurkan,
                umurHari: String(r.umurHari),
              },
            })),
            batas,
          ),
        );
      }

      default: {
        // Unreachable while `KunciMetrik` and this switch agree; kept so adding
        // a metric without its drill-down is a COMPILE error rather than a
        // 400 nobody discovers until the page is open.
        const tidakTerjangkau: never = kunci;
        throw tolak(
          KODE_DASHBOARD.RINCIAN_TIDAK_DIKENAL,
          `Rincian "${String(tidakTerjangkau)}" tidak dikenal`,
        );
      }
    }
  }

  function barisSnapshotKe(
    baris: readonly repo.BarisSnapshotRow[],
    cacah: boolean,
  ): BarisRincian[] {
    return baris.map((r) => ({
      id: r.akad_id,
      entitas: "pumk_akad",
      label: `${r.no_akad} ${r.nama_mitra}`,
      cabangId: r.cabang_id,
      tanggal: null,
      nilai: cacah ? null : uang(r.outstanding_pokok),
      fakta: {
        snapshotId: r.id,
        mitraId: r.mitra_id,
        kolektibilitas: r.kolektibilitas,
        hariTunggakan: r.hari_tunggakan,
        outstandingPokok: uang(r.outstanding_pokok),
      },
    }));
  }

  function barisAkadKe(
    baris: readonly repo.BarisAkadRow[],
    cacah: boolean,
  ): BarisRincian[] {
    return baris.map((r) => ({
      id: r.id,
      entitas: "pumk_akad",
      label: `${r.no_akad} ${r.nama_mitra}`,
      cabangId: r.cabang_id,
      tanggal: r.tanggal_akad,
      nilai: cacah ? null : uang(r.outstanding_pokok),
      fakta: {
        mitraId: r.mitra_id,
        statusAkad: r.status,
        outstandingPokok: uang(r.outstanding_pokok),
        outstandingJasa: uang(r.outstanding_jasa),
      },
    }));
  }

  async function rincianKolektibilitas(
    kelas: string,
    b: Basis,
    batas: number,
  ): Promise<RincianDashboard> {
    const daftarKelas = await repo.kelasKolektibilitas(db);
    const entri = daftarKelas.find((k) => k.kode === kelas);
    if (!entri) {
      throw tolak(
        KODE_DASHBOARD.RINCIAN_TIDAK_DIKENAL,
        `Kelas kolektibilitas "${kelas}" tidak dikenal`,
        { kelas },
      );
    }
    const [ringkas, baris] = await Promise.all([
      repo.ringkasKolektibilitas(db, b.lingkup, b.periode.id),
      repo.barisSnapshot(db, b.lingkup, b.periode.id, kelas, batas + 1),
    ]);
    const total = ringkas.find((r) => r.kolektibilitas === kelas);
    return bungkus(
      KUNCI_KOLEKTIBILITAS(kelas),
      `Kolektibilitas ${entri.nama}`,
      "KOLEKTIBILITAS_SNAPSHOT",
      uang(total?.outstanding_pokok ?? "0.00"),
      potong(barisSnapshotKe(baris, false), batas),
    );
  }

  async function rincianAntrian(
    tahap: TahapAntrian,
    b: Basis,
    batas: number,
  ): Promise<RincianDashboard> {
    const entri = KATALOG_TAHAP[tahap];
    const baris =
      entri.jenis === "PUMK"
        ? await repo.barisAntrianPumk(db, b.lingkup, entri.status, batas + 1)
        : await repo.barisAntrianNonPumk(db, b.lingkup, entri.status, batas + 1);
    return bungkus(
      KUNCI_ANTRIAN(tahap),
      entri.nama,
      "PROSES",
      // A count, so there is no money total to state. The amount each proposal
      // carries is in `fakta`, where it cannot be mistaken for a sum the rows
      // add up to.
      null,
      potong(
        baris.map((r) => ({
          id: r.id,
          entitas: entri.jenis === "PUMK" ? "pumk_proposal" : "nonpumk_proposal",
          label: `${r.no_proposal} ${r.label}`,
          cabangId: r.cabang_id,
          tanggal: r.tanggal_proposal,
          nilai: null,
          fakta: { status: r.status, nilai: uang(r.nilai), izin: kanonik(entri.izin) },
        })),
        batas,
      ),
    );
  }

  // --- the interface -------------------------------------------------------

  return {
    async daftarPeriode(filter, ctx): Promise<PeriodeDashboard[]> {
      wajibIzin(ctx, PERMISSION_DASHBOARD.LIHAT);
      const baris = await repo.daftarPeriode(db, ctx.bumnId, filter.tahun ?? null);
      return baris.map(keperiode);
    },

    async ringkasan(filter, ctx): Promise<RingkasanDashboard> {
      wajibIzin(ctx, PERMISSION_DASHBOARD.LIHAT);
      const b = await basisUntuk(filter, ctx);
      const [angka, kolektibilitas, antrian, closing, cabangBaris] = await Promise.all([
        hitungSemua(b, filter, ctx),
        panelKolektibilitas(b),
        panelAntrian(b, filter, ctx),
        panelClosing(b, ctx),
        repo.cabangDalam(db, b.lingkup),
      ]);
      const cabangDilaporkan: CabangDashboard[] = cabangBaris.map((c) => ({
        id: c.id,
        kode: c.kode,
        nama: c.nama,
      }));
      return {
        dibuatPada: jam().toISOString(),
        periode: keperiode(b.periode),
        // Decided from the PERIOD, never from the request. A caller cannot ask
        // for a live reading of a closed month.
        sumberPeriode: b.sumberBeku ? "SALDO_AKUN_PERIODE" : "V_LEDGER_BARIS",
        cabangId: filter.cabangId ?? null,
        cabangDilaporkan,
        metrik: URUTAN_METRIK.map((kunci) => bentuk(kunci, angka[kunci])),
        kolektibilitas: kolektibilitas.baris,
        alasanKolektibilitasKosong: kolektibilitas.alasan,
        antrian,
        closing,
      };
    },

    async rincian(kunci, filter, ctx): Promise<RincianDashboard> {
      wajibIzin(ctx, PERMISSION_DASHBOARD.LIHAT);
      const b = await basisUntuk(filter, ctx);
      const batas = batasBaris(filter.batasBaris);
      const pisah = kunci.indexOf(":");
      const keluarga = pisah === -1 ? "" : kunci.slice(0, pisah);
      const anggota = pisah === -1 ? "" : kunci.slice(pisah + 1);

      if (keluarga === "metrik" && anggota in KATALOG_METRIK) {
        return rincianMetrik(anggota as KunciMetrik, b, filter, ctx, batas);
      }
      if (keluarga === "kolektibilitas") {
        return rincianKolektibilitas(anggota, b, batas);
      }
      if (keluarga === "antrian" && anggota in KATALOG_TAHAP) {
        return rincianAntrian(anggota as TahapAntrian, b, batas);
      }
      throw tolak(
        KODE_DASHBOARD.RINCIAN_TIDAK_DIKENAL,
        `Kunci rincian "${kunci}" tidak dikenal`,
        {
          kunci,
          contoh: [
            KUNCI_METRIK(METRIK_DASHBOARD.OUTSTANDING_PUMK),
            KUNCI_KOLEKTIBILITAS("MACET"),
            KUNCI_ANTRIAN(TAHAP_ANTRIAN.PUMK_SURVEY),
          ],
        },
      );
    },
  };
}
