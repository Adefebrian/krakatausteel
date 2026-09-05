// apps/api/src/modules/laporan/dasar.ts
//
// THE FIVE DECISIONS EVERY REPORT IN THIS MODULE MAKES BEFORE IT READS A
// SINGLE FIGURE, made once.
//
// Extracted verbatim from ./service.ts when the operational reports of spec
// 10.1, 10.2 and 10.4 arrived. Not a tidy-up: each of these is a place where a
// SECOND implementation would be a second answer to a question the system is
// only allowed one answer to.
//
//   1. IS THIS CALLER ALLOWED TO OPEN A REPORT AT ALL. `laporan.view`, checked
//      against the SHIPPED catalogue, failing CLOSED on a code the catalogue
//      does not carry.
//   2. WHICH BRANCHES. A branch outside the session's scope is a REFUSAL, not
//      a narrowed WHERE clause (spec 16 scenario 24). An empty report reads as
//      "that branch did nothing", which is a wrong answer presented as a right
//      one, and no total in this module can detect it.
//   3. WHICH PERIOD, and it must belong to the caller's entity.
//   4. WHERE THE FINANCIAL YEAR STARTS. spec 5.6, read from `konfigurasi`,
//      never a hardcoded January.
//   5. WHICH OF SPEC 10'S TWO PATHS. CLOSED reads the period's frozen rows,
//      OPEN computes live, and a CLOSED period with no frozen rows over a
//      non-empty ledger REFUSES rather than recomputing history.
//
// AND IT BUILDS THE HEADER spec 10's preamble puts on all 31 reports. One
// header builder means the disbursement reports and the balance sheet cannot
// disagree about the entity's name, about who printed a page, or about what
// "Semua Cabang" is called.
//
// NOTHING HERE WRITES. Every call below reaches ./repo.ts, which is SELECTs
// only; spec 16 scenario 23 is a standing constraint on this module and it is
// structural here rather than disciplined.
import { PERMISSIONS } from "../auth";
import { tanggalLokal } from "../../core/waktu";
import {
  KODE_LAPORAN,
  KUNCI_KONFIGURASI_LAPORAN,
  LaporanError,
  PERMISSION_LAPORAN,
  type HeaderLaporan,
  type KodeLaporan,
  type LaporanContext,
  type LaporanDbPort,
  type LaporanTx,
  type StatusPeriode,
  type SumberData,
  type SumberTemplate,
  type TanggalIso,
} from "./contract";
import { buatRepoLaporan, type LaporanRepo, type PeriodeRow } from "./repo";
import { NAMA_BULAN } from "./tanggal";

export function gagal(kode: KodeLaporan, pesan: string, detail?: unknown): never {
  throw new LaporanError(kode, pesan, detail === undefined ? undefined : { detail });
}

/** What the header builder needs to know about the layout template, if any. */
export interface TemplatDicetak {
  templateId: string;
  sumberTemplate: SumberTemplate;
}

export interface OpsiHeader {
  namaLaporan: string;
  periode: PeriodeRow | null;
  periodeLabel: string;
  dariTanggal: TanggalIso | null;
  sampaiTanggal: TanggalIso | null;
  cabangId: string | null;
  namaCabang: string;
  sumberData: SumberData;
  templat: TemplatDicetak | null;
}

export interface CabangDipilih {
  cabangId: string | null;
  namaCabang: string;
}

export interface DasarLaporan {
  repo: LaporanRepo;
  tx(): LaporanTx;
  jam(): Date;
  /** `YYYY-MM-DD` of the injected clock, which is what a header is stamped with. */
  hariIni(): TanggalIso;
  pastikanIzin(ctx: LaporanContext): void;
  pastikanCabang(
    ctx: LaporanContext,
    diminta: string | null | undefined,
  ): Promise<CabangDipilih>;
  /**
   * The branches a query must actually be restricted to. `null` from
   * `pastikanCabang` means Semua Cabang and is expressed as the caller's whole
   * scope rather than as "no filter", so a report can never read past the
   * entity even if a branch row appeared from elsewhere.
   */
  cabangUntukQuery(ctx: LaporanContext, dipilih: CabangDipilih): Promise<string[]>;
  ambilPeriode(ctx: LaporanContext, periodeId: string): Promise<PeriodeRow>;
  bulanAwalTahunBuku(ctx: LaporanContext): Promise<number>;
  sumberUntuk(p: PeriodeRow): Promise<SumberData>;
  buatHeader(ctx: LaporanContext, opsi: OpsiHeader): Promise<HeaderLaporan>;
}

export interface DasarDeps {
  db: LaporanDbPort;
  jam?: () => Date;
}

export function buatDasarLaporan(deps: DasarDeps): DasarLaporan {
  const repo = buatRepoLaporan();
  const db = deps.db;
  const jam = deps.jam ?? (() => new Date());
  const tx = (): LaporanTx => db;

  /**
   * FAIL CLOSED ON AN UNREGISTERED CODE. A permission this module names that
   * is absent from the shipped catalogue is a FINDING, never something
   * silently treated as granted; that mechanism has already caught three real
   * gaps in this repo.
   */
  function pastikanIzin(ctx: LaporanContext): void {
    const kode: string = PERMISSION_LAPORAN.LIHAT;
    if (!(PERMISSIONS as readonly string[]).includes(kode)) {
      gagal(
        KODE_LAPORAN.IZIN_BELUM_TERDAFTAR,
        `Izin ${kode} belum terdaftar di katalog izin sistem, sehingga laporan tidak bisa dibuka.`,
        { izin: kode },
      );
    }
    if (!ctx.permissions.includes(kode)) {
      gagal(KODE_LAPORAN.TIDAK_BERWENANG, "Anda tidak berwenang membuka laporan ini.");
    }
  }

  /**
   * Branch scope, spec 16 scenario 24. `null` is spec 10's Semua Cabang and is
   * allowed ONLY to a user whose scope already covers every branch of the
   * entity; for a branch user it is the same request as asking for every other
   * branch at once, and it is refused rather than quietly narrowed.
   */
  async function pastikanCabang(
    ctx: LaporanContext,
    diminta: string | null | undefined,
  ): Promise<CabangDipilih> {
    const scope = new Set<string>(ctx.cabangDalamScope ?? [ctx.cabangId]);
    const semua = await repo.cabangBumn(tx(), ctx.bumnId);
    if (diminta === null || diminta === undefined) {
      if (semua.length === 0 || !semua.every((c) => scope.has(c.id))) {
        gagal(
          KODE_LAPORAN.CABANG_DILUAR_SCOPE,
          "Anda tidak berwenang membuka laporan untuk semua cabang.",
        );
      }
      return { cabangId: null, namaCabang: "Semua Cabang" };
    }
    const cabang = semua.find((c) => c.id === diminta);
    if (!cabang || !scope.has(diminta)) {
      gagal(
        KODE_LAPORAN.CABANG_DILUAR_SCOPE,
        "Anda tidak berwenang membuka laporan untuk cabang tersebut.",
      );
    }
    return { cabangId: cabang.id, namaCabang: cabang.nama };
  }

  /**
   * THE OPERATIONAL REPORTS FILTER ON A LIST OF BRANCH IDS, NOT ON A NULLABLE
   * ONE, and that is not a style difference.
   *
   * The accounting statements read `v_ledger_baris`, which carries `bumn_id`,
   * so "Semua Cabang" can safely be "no branch predicate at all". The
   * operational reports read `pumk_akad`, `mitra`, `nonpumk_proposal` and
   * friends, none of which carries `bumn_id`: their only tie to the entity is
   * `cabang_id`. Expressing Semua Cabang as the caller's explicit branch list
   * is therefore what keeps one entity's disbursement report out of another's,
   * and it is the same list `pastikanCabang` just authorised.
   */
  async function cabangUntukQuery(
    ctx: LaporanContext,
    dipilih: CabangDipilih,
  ): Promise<string[]> {
    if (dipilih.cabangId !== null) return [dipilih.cabangId];
    const semua = await repo.cabangBumn(tx(), ctx.bumnId);
    return semua.map((c) => c.id);
  }

  async function ambilPeriode(ctx: LaporanContext, periodeId: string): Promise<PeriodeRow> {
    const p = periodeId ? await repo.periode(tx(), periodeId) : null;
    if (!p || p.bumn_id !== ctx.bumnId) {
      gagal(KODE_LAPORAN.PERIODE_TIDAK_DITEMUKAN, "Periode laporan tidak ditemukan.");
    }
    return p;
  }

  /** spec 5.6. A missing row is a refusal, never a guessed January. */
  async function bulanAwalTahunBuku(ctx: LaporanContext): Promise<number> {
    const { grup, kunci } = KUNCI_KONFIGURASI_LAPORAN.TAHUN_BUKU_MULAI_BULAN;
    const nilai = await repo.konfigurasi(tx(), ctx.bumnId, grup, kunci);
    if (nilai === null) {
      gagal(
        KODE_LAPORAN.KONFIGURASI_TIDAK_ADA,
        `Parameter ${grup}.${kunci} belum diatur, sehingga awal tahun buku tidak bisa ditentukan.`,
        { grup, kunci },
      );
    }
    const bulan = Number.parseInt(nilai, 10);
    if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12) {
      gagal(
        KODE_LAPORAN.KONFIGURASI_TIDAK_VALID,
        `Parameter ${grup}.${kunci} bukan bulan yang sah.`,
        { grup, kunci, nilai },
      );
    }
    return bulan;
  }

  /**
   * Which path this period is read through, and the one refusal spec 10 has no
   * other answer for.
   *
   * A CLOSED period with no frozen rows AND a ledger that carries lines up to
   * its end is a REFUSAL: recomputing would produce a plausible page that
   * violates invariant 14 and that nothing downstream could detect. A period
   * that closed with an empty ledger legitimately freezes nothing, and
   * refusing on that would make the first months of any go-live unreportable.
   */
  async function sumberUntuk(p: PeriodeRow): Promise<SumberData> {
    if (p.status !== "CLOSED") return "LEDGER_LIVE";
    if ((await repo.jumlahSaldoBeku(tx(), p.id)) > 0) return "SNAPSHOT_PERIODE";
    if (await repo.adaLedgerSampai(tx(), p.bumn_id, p.tanggal_akhir)) {
      gagal(
        KODE_LAPORAN.SALDO_PERIODE_BELUM_DIBEKUKAN,
        `Periode ${NAMA_BULAN[p.bulan - 1]} ${p.tahun} sudah ditutup tetapi saldo periodenya belum dibekukan, ` +
          "sehingga laporan tidak bisa dicetak tanpa menghitung ulang riwayat.",
        { periodeId: p.id, tahun: p.tahun, bulan: p.bulan },
      );
    }
    return "SNAPSHOT_PERIODE";
  }

  async function buatHeader(ctx: LaporanContext, opsi: OpsiHeader): Promise<HeaderLaporan> {
    const bumn = await repo.bumn(tx(), ctx.bumnId);
    const pengguna = await repo.pengguna(tx(), ctx.userId);
    return {
      namaBumn: bumn?.nama ?? "",
      namaLaporan: opsi.namaLaporan,
      periodeLabel: opsi.periodeLabel,
      periodeId: opsi.periode?.id ?? null,
      statusPeriode: (opsi.periode?.status ?? null) as StatusPeriode | null,
      dariTanggal: opsi.dariTanggal,
      sampaiTanggal: opsi.sampaiTanggal,
      cabangId: opsi.cabangId,
      namaCabang: opsi.namaCabang,
      tanggalCetak: tanggalLokal(jam()),
      dicetakOleh: pengguna?.nama ?? "",
      sumberData: opsi.sumberData,
      // A report with no layout template says so rather than naming one it did
      // not print from: Buku Besar and Neraca Lajur are per ACCOUNT, and the
      // operational reports of spec 10.1, 10.2 and 10.4 have no
      // `baris_laporan` row at all, so there is nothing to be reproducible
      // about and naming a template would be a claim the page cannot support.
      templateLaporanId: opsi.templat?.templateId ?? null,
      sumberTemplate: opsi.templat?.sumberTemplate ?? "TANPA_TEMPLATE",
    };
  }

  return {
    repo,
    tx,
    jam,
    hariIni: () => tanggalLokal(jam()),
    pastikanIzin,
    pastikanCabang,
    cabangUntukQuery,
    ambilPeriode,
    bulanAwalTahunBuku,
    sumberUntuk,
    buatHeader,
  };
}
