// apps/api/src/modules/laporan/dasar-operasional.ts
//
// WHAT ALL TWENTY-THREE OPERATIONAL REPORTS DO BEFORE THEY READ A ROW, done
// once. ./dasar.ts holds what ALL THIRTY-ONE do (permission, branch scope,
// period lookup, financial-year start, the printed header); this file holds
// the three things that are specific to the reports of spec 10.1, 10.2, 10.4
// and 21:
//
//   1. THE WINDOW. BULANAN is the reported month; KUMULATIF_YTD is the first
//      day of the financial year to the reported month's end. One
//      implementation, so a page that says "kumulatif" in its header cannot be
//      cutting a different span from the page next to it.
//
//   2. THE BRANCH LIST. `pastikanCabang` answers "which branch", and these
//      reports need "which branch IDS", because their tables carry no
//      `bumn_id` and the list is therefore the entity filter too (see
//      ./repo-operasional.ts note 4).
//
//   3. THE HEADER, with the window's own label and with `sumberData` stated by
//      the CALLER rather than derived. That last part is deliberate and it is
//      the one judgement in this file:
//
//      `sumberUntuk` in ./dasar.ts refuses a CLOSED period whose
//      `saldo_akun_periode` was never written, which is exactly right for a
//      report whose figures COME from `saldo_akun_periode` and exactly wrong
//      for one that never touches it. Laporan Penerimaan Angsuran reads
//      `pumk_angsuran`; refusing it because a trial balance was not frozen
//      would be a refusal about a table the report does not open. So each
//      report DECLARES which artefact it reads and the header says so:
//      LEDGER_LIVE for the ledger and the operational tables, SNAPSHOT_PERIODE
//      for the four frozen per-period artefacts (`kolektibilitas_snapshot`,
//      `penyisihan_periode`, `akrual_jasa_snapshot`, `saldo_akun_periode`).
//      The reports that read a frozen artefact enforce its presence with their
//      own refusal, which names the run that has not happened.
import type { DasarLaporan } from "./dasar";
import type {
  Angka,
  HeaderLaporan,
  LaporanContext,
  SumberData,
  TanggalIso,
} from "./contract";
import type { ModeLaporan, Persen } from "./kontrak-operasional";
import type { PeriodeRow } from "./repo";
import { NAMA_BULAN, awalTahunBuku, labelRentang } from "./tanggal";
import { angka, keSen, persen, uangDariDb } from "./uang";

/** Money out of Postgres, straight into a printable cell. */
export function angkaDb(nilai: string | null | undefined): Angka {
  return angka(uangDariDb(nilai));
}

export function nol(): Angka {
  return angka(0n);
}

export function jumlahAngka(...nilai: Angka[]): Angka {
  return angka(nilai.reduce((t, n) => t + keSen(n.nilai), 0n));
}

export function bagi(atas: Angka, bawah: Angka): Persen | null {
  return persen(keSen(atas.nilai), keSen(bawah.nilai));
}

export function bagiCacah(atas: number, bawah: number): Persen | null {
  return persen(BigInt(atas) * 100n, BigInt(bawah) * 100n);
}

/** `a - b`, as a cell. */
export function kurangAngka(a: Angka, b: Angka): Angka {
  return angka(keSen(a.nilai) - keSen(b.nilai));
}

/**
 * Accumulates a `Map<kunci, bigint>` without the `?? 0n` dance at every call
 * site, which is where a forgotten default turns into a silently dropped row.
 */
export function tambahKe(peta: Map<string, bigint>, kunci: string, nilai: bigint): void {
  peta.set(kunci, (peta.get(kunci) ?? 0n) + nilai);
}

export function tambahKeSet(peta: Map<string, Set<string>>, kunci: string, nilai: string): void {
  let s = peta.get(kunci);
  if (!s) {
    s = new Set<string>();
    peta.set(kunci, s);
  }
  s.add(nilai);
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

export interface Rentang {
  mode: ModeLaporan;
  dari: TanggalIso;
  sampai: TanggalIso;
  label: string;
}

export function rentangUntuk(
  mode: ModeLaporan,
  p: PeriodeRow,
  bulanMulaiTahunBuku: number,
): Rentang {
  if (mode === "KUMULATIF_YTD") {
    const dari = awalTahunBuku(p.tanggal_akhir, bulanMulaiTahunBuku);
    return { mode, dari, sampai: p.tanggal_akhir, label: labelRentang(dari, p.tanggal_akhir) };
  }
  return {
    mode,
    dari: p.tanggal_mulai,
    sampai: p.tanggal_akhir,
    label: `${NAMA_BULAN[p.bulan - 1]} ${p.tahun}`,
  };
}

// ---------------------------------------------------------------------------
// Everything a report has decided before its first SELECT
// ---------------------------------------------------------------------------

export interface SiapLaporan extends Rentang {
  periode: PeriodeRow;
  cabangId: string | null;
  namaCabang: string;
  /** The branch ids to filter on. Never empty for an authorised caller. */
  cabangIds: string[];
  header(namaLaporan: string): Promise<HeaderLaporan>;
}

export interface OpsiSiap {
  /** Which artefact this report reads. See this file's header. */
  sumberData: SumberData;
  /** Reports 7 and 27 are inherently year-to-date and take no `mode`. */
  paksaMode?: ModeLaporan;
}

export async function siapkan(
  dasar: DasarLaporan,
  filter: { periodeId: string; cabangId?: string | null; mode?: ModeLaporan },
  ctx: LaporanContext,
  opsi: OpsiSiap,
): Promise<SiapLaporan> {
  dasar.pastikanIzin(ctx);
  const dipilih = await dasar.pastikanCabang(ctx, filter.cabangId);
  const cabangIds = await dasar.cabangUntukQuery(ctx, dipilih);
  const periode = await dasar.ambilPeriode(ctx, filter.periodeId);
  const bulanMulai = await dasar.bulanAwalTahunBuku(ctx);
  const mode = opsi.paksaMode ?? filter.mode ?? "BULANAN";
  const rentang = rentangUntuk(mode, periode, bulanMulai);
  return {
    ...rentang,
    periode,
    cabangId: dipilih.cabangId,
    namaCabang: dipilih.namaCabang,
    cabangIds,
    header: (namaLaporan: string) =>
      dasar.buatHeader(ctx, {
        namaLaporan,
        periode,
        periodeLabel: rentang.label,
        dariTanggal: rentang.dari,
        sampaiTanggal: rentang.sampai,
        cabangId: dipilih.cabangId,
        namaCabang: dipilih.namaCabang,
        sumberData: opsi.sumberData,
        templat: null,
      }),
  };
}
