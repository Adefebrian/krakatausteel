// WHICH REPORT SCREENS EXIST, KEYED BY SPEC 10's OWN NUMBER. One table, read
// by two callers that must never disagree:
//
//   ../../App.tsx builds a route entry from it, so a report reachable by URL is
//   exactly a report that has a screen; and
//
//   ../ReportCatalog.tsx asks it whether an entry from `GET /laporan/katalog`
//   is openable, so the index links what is built and SAYS SO about what is
//   not, instead of quietly leaving it out.
//
// THE NUMBER IS THE KEY, NOT THE PATH, because the number is the one
// identifier the server's catalogue, the specification and ../../reports.ts
// all carry. The API's own `path` on a catalogue entry is an API path
// (`/laporan/realisasi-wilayah`), the SPA's is a route path
// (`/laporan/realisasi-penyaluran-wilayah`), and they are deliberately allowed
// to differ; joining on either would have been joining on a coincidence.
//
// THERE IS NO ENTRY HERE FOR A REPORT WITHOUT A SCREEN, and that is what makes
// the catalogue page honest: absence from this table is the fact the index
// prints, not a fact it hides.
import type { PageRoute } from "../../nav";
import { AgingPiutangPage } from "./AgingPiutang";
import { AktivitasPage } from "./Aktivitas";
import { ArusKasPage } from "./ArusKas";
import { BaganAkunPage } from "./BaganAkun";
import { BukuBesarPage } from "./BukuBesar";
import { DemografiMitraPage } from "./DemografiMitra";
import { KartuPiutangLaporanPage } from "./KartuPiutangLaporan";
import { PenyaluranNasionalPage, PerpindahanKolektibilitasPage } from "./Matriks";
import { NeracaLajurPage } from "./NeracaLajur";
import { PerubahanAsetNetoPage } from "./PerubahanAsetNeto";
import { PosisiKeuanganPage } from "./PosisiKeuangan";
import { AuditTrailPage, JatuhTempoPage } from "./Rentang";
import { RkaVsRealisasiPage } from "./RkaVsRealisasi";
import {
  AkrualJasaPage,
  BebanPenyisihanPage,
  KolektibilitasPage,
  MonitoringLpjLaporanPage,
  PemetaanSdgPage,
  PenerimaanAngsuranPage,
  PenyaluranNonPumkPage,
  PerhitunganPenyisihanPage,
  PortalNonPumkPage,
  PortalPumkPage,
  RealisasiSektorPage,
  RealisasiWilayahPage,
  RekapBidangPage,
  RekapJurnalPage,
  RekapPermohonanPage,
  RekapRealisasiPage,
} from "./operasional";

export type PenggambarLaporan = (route: PageRoute) => JSX.Element;

/** Spec 10's number, to the screen that answers it. */
export const LAYAR_LAPORAN: Readonly<Record<number, PenggambarLaporan>> = {
  // 10.1 Laporan Pendanaan UMK
  1: (route) => <RealisasiWilayahPage route={route} />,
  2: (route) => <RealisasiSektorPage route={route} />,
  3: (route) => <PenyaluranNasionalPage route={route} />,
  4: (route) => <PenerimaanAngsuranPage route={route} />,
  5: (route) => <JatuhTempoPage route={route} />,
  6: (route) => <RekapPermohonanPage route={route} />,
  7: (route) => <RekapRealisasiPage route={route} />,
  8: (route) => <AgingPiutangPage route={route} />,
  9: (route) => <KartuPiutangLaporanPage route={route} />,
  10: (route) => <KolektibilitasPage route={route} />,
  11: (route) => <PerpindahanKolektibilitasPage route={route} />,

  // 10.2 Laporan Non PUMK
  12: (route) => <PenyaluranNonPumkPage route={route} />,
  13: (route) => <RekapBidangPage route={route} />,
  14: (route) => <PemetaanSdgPage route={route} />,
  15: (route) => <MonitoringLpjLaporanPage route={route} />,

  // 10.3 Laporan Akuntansi
  16: (route) => <BaganAkunPage route={route} />,
  17: (route) => <AktivitasPage route={route} />,
  18: (route) => <ArusKasPage route={route} />,
  19: (route) => <PosisiKeuanganPage route={route} />,
  20: (route) => <PerubahanAsetNetoPage route={route} />,
  21: (route) => <RekapJurnalPage route={route} />,
  22: (route) => <BukuBesarPage route={route} />,
  23: (route) => <NeracaLajurPage route={route} />,
  // 24 is modules/rka's, not modules/laporan's. See ../ReportCatalog.tsx.
  24: (route) => <RkaVsRealisasiPage route={route} />,

  // 10.4 Laporan Lainnya
  25: (route) => <PortalPumkPage route={route} />,
  26: (route) => <PortalNonPumkPage route={route} />,
  27: (route) => <DemografiMitraPage route={route} />,
  28: (route) => <PerhitunganPenyisihanPage route={route} />,
  29: (route) => <BebanPenyisihanPage route={route} />,
  30: (route) => <AkrualJasaPage route={route} />,
  31: (route) => <AuditTrailPage route={route} />,
};

export function adaLayarLaporan(nomor: number): boolean {
  return Object.hasOwn(LAYAR_LAPORAN, nomor);
}
