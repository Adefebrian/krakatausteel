// Read models for the report HTTP surface (spec 10), and nothing else.
//
// WHY THIS FILE EXISTS SEPARATELY FROM ./service.ts
// `LaporanEngine` produces the seven statements of spec 10.3. Spec 10's
// preamble puts two FILTERS above every one of them -- "Filter periode (bulan,
// triwulan, tahun)" and "Filter cabang (untuk Admin Pusat: semua cabang)" --
// and a screen cannot render either filter without the OPTIONS in it. Those
// lists are a projection, not behaviour, so they live here rather than widening
// an engine whose tests pin its current shape.
//
// THE THREE RULES THIS FILE OBEYS:
//
// 1. THE BRANCH LIST IS BUILT FROM THE SESSION, never from the request. It
//    returns exactly the branches this caller may report on, plus one flag
//    saying whether Semua Cabang is open to them, which is true only for a
//    scope covering every branch of the entity. A branch user therefore SEES
//    that the option does not exist rather than discovering it as a 403 after
//    pressing print, and the engine still refuses the request on its own
//    evidence if one is sent anyway (spec 16 scenario 24).
//
// 2. IT PRODUCES NO FIGURES. Not one number in this file comes from the
//    ledger. `daftarPeriode` returns periods and their STATUS, which is what
//    tells a reader whether a month will be read live or from frozen balances;
//    it does not tell them what the balances are. Every figure in this module
//    comes from ./service.ts, through spec 10's two paths, or it does not
//    exist.
//
// 3. IT WRITES NOTHING, which in this module is structural rather than
//    disciplined: the engine takes no journal port and no audit port at all
//    (see ./contract.ts and ./index.ts), so there is nothing here to write
//    with. Spec 16 scenario 23 requires an Auditor to open every report and
//    change nothing; every function below is a SELECT and every route that
//    calls one is a GET.
import { canonicalPermission } from "../auth/index";
import type { QueryRunner } from "../../core/ports/db";
import {
  KODE_LAPORAN,
  LaporanError,
  NAMA_LAPORAN,
  PERMISSION_LAPORAN,
  type LaporanContext,
  type LaporanDbPort,
  type StatusPeriode,
} from "./contract";
import { NAMA_LAPORAN_OPERASIONAL } from "./kontrak-operasional";

export interface LaporanBacaDeps {
  db: LaporanDbPort;
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

export interface OpsiPeriode {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: StatusPeriode;
  /**
   * Which of spec 10's two paths this period will be read through. CLOSED
   * means the frozen `saldo_akun_periode`, anything else means the live
   * ledger. Carried so a page can LABEL the choice; there is deliberately no
   * way to CHANGE it (see ./routes.ts).
   */
  sumberData: "LEDGER_LIVE" | "SNAPSHOT_PERIODE";
}

export interface OpsiCabangLaporan {
  id: string;
  kode: string;
  nama: string;
}

export interface FilterCabangLaporan {
  cabang: OpsiCabangLaporan[];
  /**
   * Spec 10: "Filter cabang (untuk Admin Pusat: semua cabang)". True only when
   * the session's scope covers EVERY branch of the entity, which is the same
   * condition the engine enforces, stated once here so the screen and the
   * engine cannot offer and refuse the same option.
   */
  bolehSemuaCabang: boolean;
  /** The caller's own branch, which is the sensible default selection. */
  cabangSendiriId: string;
}

export interface EntriKatalogLaporan {
  /** spec 10.3's own numbering. */
  nomor: number;
  kode: string;
  /** Verbatim from `NAMA_LAPORAN`, so the screen, the header and a later
   *  export cannot drift apart. */
  nama: string;
  /** Path under `/laporan`, so a catalogue page needs no second vocabulary. */
  path: string;
  /** Whether this report takes a period. Report 16 is a chart, not a period. */
  perluPeriode: boolean;
  /** Whether it takes a single account. Only report 22 does. */
  perluAkun: boolean;
}

export interface LaporanBaca {
  daftarPeriode(filter: { tahun?: number | null }, ctx: LaporanContext): Promise<OpsiPeriode[]>;
  filterCabang(ctx: LaporanContext): Promise<FilterCabangLaporan>;
  katalog(ctx: LaporanContext): Promise<EntriKatalogLaporan[]>;
}

/**
 * THE THIRTY REPORTS THIS MODULE ANSWERS, with the path each is reached at, in
 * the specification's own numbering.
 *
 * SPEC 10 LISTS 31 AND EXACTLY ONE IS ABSENT: report 24, RKA versus Realisasi,
 * which lives in modules/rka because it is the budget module's own comparison
 * and reaches `rka_detail` through that module's repository. Listing it here
 * would put this module in charge of a path it does not own; a single
 * catalogue across all 31 is a composition above both, and it is one entry.
 *
 * `perluPeriode` FALSE MEANS THE ROUTE TAKES NO `periodeId` AT ALL, which is
 * true of three reports and for three different reasons: report 16 is a
 * structure rather than a balance, report 5 asks about the FUTURE and takes a
 * forward due-date window, and report 31 is an audit log over an arbitrary
 * date range. A screen that offered a period picker on any of them would be
 * offering a control the API refuses.
 */
export const KATALOG_LAPORAN: readonly EntriKatalogLaporan[] = [
  // --- 10.1 Laporan Pendanaan UMK -----------------------------------------
  { nomor: 1, kode: "REALISASI_WILAYAH", nama: NAMA_LAPORAN_OPERASIONAL.REALISASI_WILAYAH, path: "/laporan/realisasi-wilayah", perluPeriode: true, perluAkun: false },
  { nomor: 2, kode: "REALISASI_SEKTOR", nama: NAMA_LAPORAN_OPERASIONAL.REALISASI_SEKTOR, path: "/laporan/realisasi-sektor", perluPeriode: true, perluAkun: false },
  { nomor: 3, kode: "PENYALURAN_NASIONAL", nama: NAMA_LAPORAN_OPERASIONAL.PENYALURAN_NASIONAL, path: "/laporan/penyaluran-nasional", perluPeriode: true, perluAkun: false },
  { nomor: 4, kode: "PENERIMAAN_ANGSURAN", nama: NAMA_LAPORAN_OPERASIONAL.PENERIMAAN_ANGSURAN, path: "/laporan/penerimaan-angsuran", perluPeriode: true, perluAkun: false },
  { nomor: 5, kode: "JATUH_TEMPO", nama: NAMA_LAPORAN_OPERASIONAL.JATUH_TEMPO, path: "/laporan/jatuh-tempo", perluPeriode: false, perluAkun: false },
  { nomor: 6, kode: "REKAP_PERMOHONAN_PUMK", nama: NAMA_LAPORAN_OPERASIONAL.REKAP_PERMOHONAN_PUMK, path: "/laporan/rekap-permohonan", perluPeriode: true, perluAkun: false },
  { nomor: 7, kode: "REKAP_REALISASI_PUMK", nama: NAMA_LAPORAN_OPERASIONAL.REKAP_REALISASI_PUMK, path: "/laporan/rekap-realisasi", perluPeriode: true, perluAkun: false },
  { nomor: 8, kode: "AGING_PIUTANG", nama: NAMA_LAPORAN_OPERASIONAL.AGING_PIUTANG, path: "/laporan/aging-piutang", perluPeriode: true, perluAkun: false },
  { nomor: 9, kode: "KARTU_PIUTANG", nama: NAMA_LAPORAN_OPERASIONAL.KARTU_PIUTANG, path: "/laporan/kartu-piutang", perluPeriode: true, perluAkun: false },
  { nomor: 10, kode: "KOLEKTIBILITAS", nama: NAMA_LAPORAN_OPERASIONAL.KOLEKTIBILITAS, path: "/laporan/kolektibilitas", perluPeriode: true, perluAkun: false },
  { nomor: 11, kode: "PERPINDAHAN_KOLEKTIBILITAS", nama: NAMA_LAPORAN_OPERASIONAL.PERPINDAHAN_KOLEKTIBILITAS, path: "/laporan/perpindahan-kolektibilitas", perluPeriode: true, perluAkun: false },

  // --- 10.2 Laporan Non PUMK ----------------------------------------------
  { nomor: 12, kode: "PENYALURAN_NON_PUMK", nama: NAMA_LAPORAN_OPERASIONAL.PENYALURAN_NON_PUMK, path: "/laporan/penyaluran-non-pumk", perluPeriode: true, perluAkun: false },
  { nomor: 13, kode: "REKAP_BIDANG", nama: NAMA_LAPORAN_OPERASIONAL.REKAP_BIDANG, path: "/laporan/rekap-bidang", perluPeriode: true, perluAkun: false },
  { nomor: 14, kode: "PEMETAAN_SDG", nama: NAMA_LAPORAN_OPERASIONAL.PEMETAAN_SDG, path: "/laporan/pemetaan-sdg", perluPeriode: true, perluAkun: false },
  { nomor: 15, kode: "MONITORING_LPJ", nama: NAMA_LAPORAN_OPERASIONAL.MONITORING_LPJ, path: "/laporan/monitoring-lpj", perluPeriode: true, perluAkun: false },

  // --- 10.3 Laporan Akuntansi ---------------------------------------------
  { nomor: 16, kode: "BAGAN_AKUN", nama: NAMA_LAPORAN.BAGAN_AKUN, path: "/laporan/bagan-akun", perluPeriode: false, perluAkun: false },
  { nomor: 17, kode: "AKTIVITAS", nama: NAMA_LAPORAN.AKTIVITAS, path: "/laporan/aktivitas", perluPeriode: true, perluAkun: false },
  { nomor: 18, kode: "ARUS_KAS", nama: NAMA_LAPORAN.ARUS_KAS, path: "/laporan/arus-kas", perluPeriode: true, perluAkun: false },
  { nomor: 19, kode: "POSISI_KEUANGAN", nama: NAMA_LAPORAN.POSISI_KEUANGAN, path: "/laporan/posisi-keuangan", perluPeriode: true, perluAkun: false },
  { nomor: 20, kode: "PERUBAHAN_ASET_NETO", nama: NAMA_LAPORAN.PERUBAHAN_ASET_NETO, path: "/laporan/perubahan-aset-neto", perluPeriode: true, perluAkun: false },
  { nomor: 21, kode: "REKAP_JURNAL", nama: NAMA_LAPORAN_OPERASIONAL.REKAP_JURNAL, path: "/laporan/rekap-jurnal", perluPeriode: true, perluAkun: false },
  { nomor: 22, kode: "BUKU_BESAR", nama: NAMA_LAPORAN.BUKU_BESAR, path: "/laporan/buku-besar", perluPeriode: true, perluAkun: true },
  { nomor: 23, kode: "NERACA_LAJUR", nama: NAMA_LAPORAN.NERACA_LAJUR, path: "/laporan/neraca-lajur", perluPeriode: true, perluAkun: false },

  // --- 10.4 Laporan Lainnya -----------------------------------------------
  { nomor: 25, kode: "PORTAL_PUMK", nama: NAMA_LAPORAN_OPERASIONAL.PORTAL_PUMK, path: "/laporan/portal-pumk", perluPeriode: true, perluAkun: false },
  { nomor: 26, kode: "PORTAL_NON_PUMK", nama: NAMA_LAPORAN_OPERASIONAL.PORTAL_NON_PUMK, path: "/laporan/portal-non-pumk", perluPeriode: true, perluAkun: false },
  { nomor: 27, kode: "DEMOGRAFI_MITRA", nama: NAMA_LAPORAN_OPERASIONAL.DEMOGRAFI_MITRA, path: "/laporan/demografi-mitra", perluPeriode: true, perluAkun: false },
  { nomor: 28, kode: "PERHITUNGAN_PENYISIHAN", nama: NAMA_LAPORAN_OPERASIONAL.PERHITUNGAN_PENYISIHAN, path: "/laporan/perhitungan-penyisihan", perluPeriode: true, perluAkun: false },
  { nomor: 29, kode: "BEBAN_PENYISIHAN", nama: NAMA_LAPORAN_OPERASIONAL.BEBAN_PENYISIHAN, path: "/laporan/beban-penyisihan", perluPeriode: true, perluAkun: false },
  { nomor: 30, kode: "AKRUAL_JASA", nama: NAMA_LAPORAN_OPERASIONAL.AKRUAL_JASA, path: "/laporan/akrual-jasa", perluPeriode: true, perluAkun: false },
  { nomor: 31, kode: "AUDIT_TRAIL", nama: NAMA_LAPORAN_OPERASIONAL.AUDIT_TRAIL, path: "/laporan/audit-trail", perluPeriode: false, perluAkun: false },
];

/**
 * Fails closed on an unregistered code, exactly as the engine's `pastikanIzin`
 * does and for the same reason: a code the shipped catalogue does not know is a
 * configuration fault, and reporting it as TIDAK_BERWENANG would dress it up as
 * a policy decision and hide it forever.
 *
 * The router already ran `requirePermission`, so this is the second line, and
 * it stays for the reason every other module's does: a read model reachable
 * from anywhere else must refuse on its own evidence.
 */
function pastikanIzin(ctx: LaporanContext): void {
  const kode: string = PERMISSION_LAPORAN.LIHAT;
  if (!canonicalPermission(kode)) {
    throw new LaporanError(
      KODE_LAPORAN.IZIN_BELUM_TERDAFTAR,
      `Izin ${kode} belum terdaftar di katalog izin sistem, sehingga laporan tidak bisa dibuka.`,
      { detail: { izin: kode } },
    );
  }
  if (!ctx.permissions.includes(kode)) {
    throw new LaporanError(
      KODE_LAPORAN.TIDAK_BERWENANG,
      "Anda tidak berwenang membuka laporan ini.",
    );
  }
}

interface PeriodeRow {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: StatusPeriode;
}

export function buatLaporanBaca({ db }: LaporanBacaDeps): LaporanBaca {
  const tx = (): QueryRunner => db;

  return {
    async daftarPeriode(filter, ctx) {
      pastikanIzin(ctx);
      const params: unknown[] = [ctx.bumnId];
      let where = "";
      if (filter.tahun !== undefined && filter.tahun !== null) {
        params.push(filter.tahun);
        where = ` and tahun = $${params.length}`;
      }
      const rows = await tx().query<PeriodeRow>(
        `select id::text as id, tahun::int as tahun, bulan::int as bulan,
                tanggal_mulai::text as "tanggalMulai", tanggal_akhir::text as "tanggalAkhir",
                status
           from periode
          where bumn_id = $1::uuid and deleted_at is null${where}
          order by tahun desc, bulan desc`,
        params,
      );
      // The label only. Whether a CLOSED period actually HAS frozen rows is a
      // question the engine answers when it prints, and it REFUSES rather than
      // recomputing; saying so here would mean querying `saldo_akun_periode`
      // per period to build a picker, which is a report's worth of work to
      // draw a dropdown.
      return rows.map((p) => ({
        ...p,
        sumberData: p.status === "CLOSED" ? ("SNAPSHOT_PERIODE" as const) : ("LEDGER_LIVE" as const),
      }));
    },

    async filterCabang(ctx) {
      pastikanIzin(ctx);
      const semua = await tx().query<OpsiCabangLaporan>(
        `select id::text as id, kode, nama
           from cabang
          where bumn_id = $1::uuid and deleted_at is null and aktif = true
          order by kode`,
        [ctx.bumnId],
      );
      // The SESSION's scope, never a branch from the request. Same set the
      // engine compares against, so the option list and the refusal agree.
      const scope = new Set<string>(ctx.cabangDalamScope ?? [ctx.cabangId]);
      return {
        cabang: semua.filter((c) => scope.has(c.id)),
        bolehSemuaCabang: semua.length > 0 && semua.every((c) => scope.has(c.id)),
        cabangSendiriId: ctx.cabangId,
      };
    },

    async katalog(ctx) {
      pastikanIzin(ctx);
      return [...KATALOG_LAPORAN];
    },
  };
}
