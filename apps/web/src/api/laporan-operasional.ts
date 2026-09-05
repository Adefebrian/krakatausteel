// Typed client for the twenty three OPERATIONAL reports of spec 10: the eleven
// PUMK reports of 10.1, the four Non PUMK reports of 10.2, Rekap Jurnal, and
// the seven of 10.4.
//
// It is a sibling of ./laporan.ts and not an extension of it, for the same
// reason the API keeps `contract.ts` and `kontrak-operasional.ts` apart: the
// seven accounting statements are computed by one engine and these by another,
// and one file that mixed them would let a change to a statement's shape look
// like a change to an operational report's.
//
// TYPES COME FROM THE CONTRACT, never restated here. `import type` is erased by
// Bun's transpiler so no server code reaches the bundle, and a drift in the
// contract becomes a type error in this file rather than a wrong number on a
// page somebody signs.
//
// EVERY FUNCTION IS A GET. There is no write path on `/laporan` at all (see
// apps/api/src/modules/laporan/routes.ts), and this file has no non GET
// function so that stays visible from the client side too.
//
// `mode` IS SENT ONLY WHEN THE SCREEN OFFERS IT. Absent means BULANAN, decided
// by the engine, so a screen that does not carry the control cannot accidentally
// pin the window to the wrong one.
import type {
  // Re-exported from ./kontrak-operasional, which re-exports it from
  // ./contract, so a screen needs ONE import for a report and the money on it.
  // The seven accounting statements reach the same type through ./laporan.ts;
  // it is one declaration either way, so the two clients cannot disagree about
  // what a figure is.
  Angka,
  BarisAging,
  BarisAkrualJasa,
  BarisAuditTrail,
  BarisBebanPenyisihan,
  BarisBidang,
  BarisJadwalKartu,
  BarisJatuhTempo,
  BarisKolektibilitas,
  BarisKolektibilitasSektor,
  BarisMatriks,
  BarisMonitoringLpj,
  BarisPenerimaanAngsuran,
  BarisPenyaluranNonPumk,
  BarisPerhitunganPenyisihan,
  BarisPortal,
  BarisRekapJurnal,
  BarisRekapPermohonan,
  BarisRekapRealisasi,
  BarisSdg,
  BarisSektor,
  BarisSetoranKartu,
  BarisWilayah,
  DistribusiDemografi,
  EmberDemografi,
  FilterAuditTrail,
  FilterJatuhTempo,
  FilterKartuPiutang,
  FilterPeriodeLaporan,
  HasilAudit,
  KartuAkad,
  KodeBucketAging,
  KolomMatriks,
  LaporanAgingPiutang,
  LaporanAkrualJasa,
  LaporanAuditTrail,
  LaporanBebanPenyisihan,
  LaporanDemografiMitra,
  LaporanJatuhTempo,
  LaporanKartuPiutang,
  LaporanKolektibilitas,
  LaporanMonitoringLpj,
  LaporanPemetaanSdg,
  LaporanPenerimaanAngsuran,
  LaporanPenyaluranNasional,
  LaporanPenyaluranNonPumk,
  LaporanPerhitunganPenyisihan,
  LaporanPerpindahanKolektibilitas,
  LaporanPortal,
  LaporanRealisasiSektor,
  LaporanRealisasiWilayah,
  LaporanRekapBidang,
  LaporanRekapJurnal,
  LaporanRekapPermohonan,
  LaporanRekapRealisasi,
  ModeLaporan,
  Persen,
  RingkasanBucket,
  SelMatriks,
  SelPerpindahan,
  StatusLpj,
  StatusPortal,
} from "@krakatausteel/api/src/modules/laporan/kontrak-operasional";
import { apiGet, buildQuery } from "./http";

export type {
  Angka,
  BarisAging,
  BarisAkrualJasa,
  BarisAuditTrail,
  BarisBebanPenyisihan,
  BarisBidang,
  BarisJadwalKartu,
  BarisJatuhTempo,
  BarisKolektibilitas,
  BarisKolektibilitasSektor,
  BarisMatriks,
  BarisMonitoringLpj,
  BarisPenerimaanAngsuran,
  BarisPenyaluranNonPumk,
  BarisPerhitunganPenyisihan,
  BarisPortal,
  BarisRekapJurnal,
  BarisRekapPermohonan,
  BarisRekapRealisasi,
  BarisSdg,
  BarisSektor,
  BarisSetoranKartu,
  BarisWilayah,
  DistribusiDemografi,
  EmberDemografi,
  FilterAuditTrail,
  FilterJatuhTempo,
  FilterKartuPiutang,
  FilterPeriodeLaporan,
  HasilAudit,
  KartuAkad,
  KodeBucketAging,
  KolomMatriks,
  LaporanAgingPiutang,
  LaporanAkrualJasa,
  LaporanAuditTrail,
  LaporanBebanPenyisihan,
  LaporanDemografiMitra,
  LaporanJatuhTempo,
  LaporanKartuPiutang,
  LaporanKolektibilitas,
  LaporanMonitoringLpj,
  LaporanPemetaanSdg,
  LaporanPenerimaanAngsuran,
  LaporanPenyaluranNasional,
  LaporanPenyaluranNonPumk,
  LaporanPerhitunganPenyisihan,
  LaporanPerpindahanKolektibilitas,
  LaporanPortal,
  LaporanRealisasiSektor,
  LaporanRealisasiWilayah,
  LaporanRekapBidang,
  LaporanRekapJurnal,
  LaporanRekapPermohonan,
  LaporanRekapRealisasi,
  ModeLaporan,
  Persen,
  RingkasanBucket,
  SelMatriks,
  SelPerpindahan,
  StatusLpj,
  StatusPortal,
};

/**
 * The two filters spec 10's preamble puts above every report, plus the window
 * mode. An ABSENT `cabangId` is Semua Cabang and is sent as an absent
 * parameter, never defaulted to the caller's own branch: a page headed "Semua
 * Cabang" that in fact showed one branch would say nothing about it on paper.
 */
function q(filter: FilterPeriodeLaporan): string {
  return buildQuery({
    periodeId: filter.periodeId,
    cabangId: filter.cabangId ?? null,
    mode: filter.mode ?? null,
  });
}

// --------------------------------------------------------------- 10.1, PUMK

/** 1. Realisasi penyaluran per provinsi dan kota. */
export function realisasiWilayah(f: FilterPeriodeLaporan): Promise<LaporanRealisasiWilayah> {
  return apiGet<LaporanRealisasiWilayah>(`/laporan/realisasi-wilayah${q(f)}`);
}

/** 2. Realisasi penyaluran per sektor, dibandingkan RKA bila ada. */
export function realisasiSektor(f: FilterPeriodeLaporan): Promise<LaporanRealisasiSektor> {
  return apiGet<LaporanRealisasiSektor>(`/laporan/realisasi-sektor${q(f)}`);
}

/** 3. Matriks provinsi kali sektor. */
export function penyaluranNasional(f: FilterPeriodeLaporan): Promise<LaporanPenyaluranNasional> {
  return apiGet<LaporanPenyaluranNasional>(`/laporan/penyaluran-nasional${q(f)}`);
}

/** 4. Setoran angsuran yang diterima pada periode. */
export function penerimaanAngsuran(f: FilterPeriodeLaporan): Promise<LaporanPenerimaanAngsuran> {
  return apiGet<LaporanPenerimaanAngsuran>(`/laporan/penerimaan-angsuran${q(f)}`);
}

/** 5. THE ONLY REPORT WHOSE WINDOW IS NOT A PERIODE: a forward date range. */
export function jatuhTempo(f: FilterJatuhTempo): Promise<LaporanJatuhTempo> {
  return apiGet<LaporanJatuhTempo>(
    `/laporan/jatuh-tempo${buildQuery({
      dariTanggal: f.dariTanggal,
      sampaiTanggal: f.sampaiTanggal,
      cabangId: f.cabangId ?? null,
    })}`,
  );
}

/** 6. Rekap permohonan PUMK per status dan per sektor. */
export function rekapPermohonan(f: FilterPeriodeLaporan): Promise<LaporanRekapPermohonan> {
  return apiGet<LaporanRekapPermohonan>(`/laporan/rekap-permohonan${q(f)}`);
}

/** 7. Tabel bulan sepanjang tahun buku. The engine forces the window, so no
 *  `mode` is sent: a caller cannot narrow this one to a single month. */
export function rekapRealisasi(f: FilterPeriodeLaporan): Promise<LaporanRekapRealisasi> {
  return apiGet<LaporanRekapRealisasi>(
    `/laporan/rekap-realisasi${buildQuery({ periodeId: f.periodeId, cabangId: f.cabangId ?? null })}`,
  );
}

/** 8. Aging piutang per mitra, dalam lima bucket. */
export function agingPiutang(f: FilterPeriodeLaporan): Promise<LaporanAgingPiutang> {
  return apiGet<LaporanAgingPiutang>(
    `/laporan/aging-piutang${buildQuery({ periodeId: f.periodeId, cabangId: f.cabangId ?? null })}`,
  );
}

/** 9. Kartu piutang satu mitra: jadwal, setoran, saldo berjalan. */
export function kartuPiutangLaporan(f: FilterKartuPiutang): Promise<LaporanKartuPiutang> {
  return apiGet<LaporanKartuPiutang>(
    `/laporan/kartu-piutang${buildQuery({
      periodeId: f.periodeId,
      cabangId: f.cabangId ?? null,
      mitraId: f.mitraId,
    })}`,
  );
}

/** 10. Kolektibilitas per klasifikasi dan per sektor. */
export function kolektibilitas(f: FilterPeriodeLaporan): Promise<LaporanKolektibilitas> {
  return apiGet<LaporanKolektibilitas>(
    `/laporan/kolektibilitas${buildQuery({ periodeId: f.periodeId, cabangId: f.cabangId ?? null })}`,
  );
}

/** 11. Matriks klasifikasi periode lalu kali periode ini. */
export function perpindahanKolektibilitas(
  f: FilterPeriodeLaporan,
): Promise<LaporanPerpindahanKolektibilitas> {
  return apiGet<LaporanPerpindahanKolektibilitas>(
    `/laporan/perpindahan-kolektibilitas${buildQuery({
      periodeId: f.periodeId,
      cabangId: f.cabangId ?? null,
    })}`,
  );
}

// ----------------------------------------------------------- 10.2, Non PUMK

/** 12. Penyaluran hibah per termin. */
export function penyaluranNonPumk(f: FilterPeriodeLaporan): Promise<LaporanPenyaluranNonPumk> {
  return apiGet<LaporanPenyaluranNonPumk>(`/laporan/penyaluran-non-pumk${q(f)}`);
}

/** 13. Rekap penyaluran Non PUMK per bidang, dibandingkan RKA bila ada. */
export function rekapBidang(f: FilterPeriodeLaporan): Promise<LaporanRekapBidang> {
  return apiGet<LaporanRekapBidang>(`/laporan/rekap-bidang${q(f)}`);
}

/** 14. Pemetaan program ke SDGs. */
export function pemetaanSdg(f: FilterPeriodeLaporan): Promise<LaporanPemetaanSdg> {
  return apiGet<LaporanPemetaanSdg>(`/laporan/pemetaan-sdg${q(f)}`);
}

/** 15. Monitoring LPJ, dengan umur dokumen dan selisih realisasi. */
export function monitoringLpjLaporan(f: FilterPeriodeLaporan): Promise<LaporanMonitoringLpj> {
  return apiGet<LaporanMonitoringLpj>(`/laporan/monitoring-lpj${q(f)}`);
}

// ------------------------------------------------------------- 21 dan 10.4

/** 21. Rekap jurnal per jenis dan status. */
export function rekapJurnal(f: FilterPeriodeLaporan): Promise<LaporanRekapJurnal> {
  return apiGet<LaporanRekapJurnal>(`/laporan/rekap-jurnal${q(f)}`);
}

/** 25 and 26. TWO PATHS, ONE SHAPE. The specification numbers them separately,
 *  so they are two functions and two screens, not one with a parameter. */
export function portalPumk(f: FilterPeriodeLaporan): Promise<LaporanPortal> {
  return apiGet<LaporanPortal>(`/laporan/portal-pumk${q(f)}`);
}

export function portalNonPumk(f: FilterPeriodeLaporan): Promise<LaporanPortal> {
  return apiGet<LaporanPortal>(`/laporan/portal-non-pumk${q(f)}`);
}

/** 27. Demografi mitra binaan, tujuh distribusi. */
export function demografiMitra(f: FilterPeriodeLaporan): Promise<LaporanDemografiMitra> {
  return apiGet<LaporanDemografiMitra>(
    `/laporan/demografi-mitra${buildQuery({ periodeId: f.periodeId, cabangId: f.cabangId ?? null })}`,
  );
}

/** 28. Perhitungan penyisihan per akad, dengan rate yang benar benar dipakai. */
export function perhitunganPenyisihan(
  f: FilterPeriodeLaporan,
): Promise<LaporanPerhitunganPenyisihan> {
  return apiGet<LaporanPerhitunganPenyisihan>(
    `/laporan/perhitungan-penyisihan${buildQuery({
      periodeId: f.periodeId,
      cabangId: f.cabangId ?? null,
    })}`,
  );
}

/** 29. Beban penyisihan per periode, dengan tautan ke jurnalnya. */
export function bebanPenyisihan(f: FilterPeriodeLaporan): Promise<LaporanBebanPenyisihan> {
  return apiGet<LaporanBebanPenyisihan>(`/laporan/beban-penyisihan${q(f)}`);
}

/** 30. Akrual piutang jasa administrasi per akad. */
export function akrualJasa(f: FilterPeriodeLaporan): Promise<LaporanAkrualJasa> {
  return apiGet<LaporanAkrualJasa>(
    `/laporan/akrual-jasa${buildQuery({ periodeId: f.periodeId, cabangId: f.cabangId ?? null })}`,
  );
}

/** 31. Audit trail. PAGED, because an audit log is unbounded by construction. */
export function auditTrail(f: FilterAuditTrail): Promise<LaporanAuditTrail> {
  return apiGet<LaporanAuditTrail>(
    `/laporan/audit-trail${buildQuery({
      dariTanggal: f.dariTanggal,
      sampaiTanggal: f.sampaiTanggal,
      userId: f.userId ?? null,
      entitas: f.entitas ?? null,
      aksi: f.aksi ?? null,
      hasil: f.hasil ?? null,
      batas: f.batas ?? null,
      offset: f.offset ?? null,
    })}`,
  );
}
