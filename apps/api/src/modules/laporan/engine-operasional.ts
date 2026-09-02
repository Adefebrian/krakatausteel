// apps/api/src/modules/laporan/engine-operasional.ts
//
// ONE ENGINE FOR THE TWENTY-THREE OPERATIONAL REPORTS, assembled from the
// three service files that implement them.
//
// THE SPLIT IS FOR READERS OF THE CODE AND STOPS HERE. ./kontrak-operasional.ts
// says why: a split at the BOUNDARY would make the composition root wire three
// things and would let three copies of the permission check, the branch check
// and the period lookup drift apart. There is exactly one `buatDasarLaporan`
// below and every report reaches it.
//
// IT TAKES A DATABASE AND A CLOCK AND NOTHING ELSE, like `LaporanEngine`. No
// journal port, no audit port, no storage port. Spec 16 scenario 23 ("an
// Auditor opens every report and finds no control that changes data") is
// therefore a property of the module rather than a promise about the screens:
// there is nothing reachable from here to write with.
import type { LaporanEngineDeps } from "./contract";
import { buatDasarLaporan } from "./dasar";
import type { LaporanOperasionalEngine } from "./kontrak-operasional";
import { buatLayananLainnya } from "./service-lainnya";
import { buatLayananNonPumk } from "./service-nonpumk";
import { buatLayananPumk } from "./service-pumk";

export function buatEngineOperasional(deps: LaporanEngineDeps): LaporanOperasionalEngine {
  const dasar = buatDasarLaporan(deps);
  const pumk = buatLayananPumk({ dasar });
  const nonpumk = buatLayananNonPumk({ dasar, anggaranUntuk: pumk.anggaranUntuk });
  const lainnya = buatLayananLainnya({ dasar });

  return {
    realisasiWilayah: pumk.realisasiWilayah,
    realisasiSektor: pumk.realisasiSektor,
    penyaluranNasional: pumk.penyaluranNasional,
    penerimaanAngsuran: pumk.penerimaanAngsuran,
    jatuhTempo: pumk.jatuhTempo,
    rekapPermohonanPumk: pumk.rekapPermohonanPumk,
    rekapRealisasiPumk: pumk.rekapRealisasiPumk,
    agingPiutang: pumk.agingPiutang,
    kartuPiutang: pumk.kartuPiutang,
    kolektibilitas: pumk.kolektibilitas,
    perpindahanKolektibilitas: pumk.perpindahanKolektibilitas,

    penyaluranNonPumk: nonpumk.penyaluranNonPumk,
    rekapBidang: nonpumk.rekapBidang,
    pemetaanSdg: nonpumk.pemetaanSdg,
    monitoringLpj: nonpumk.monitoringLpj,

    rekapJurnal: lainnya.rekapJurnal,
    portal: lainnya.portal,
    demografiMitra: lainnya.demografiMitra,
    // REPORT 28 SPANS TWO FILES AND IS JOINED HERE, not by one of them
    // importing the other. The per-akad rows come from the collectibility
    // snapshot reader in ./service-pumk.ts, the figure they are checked
    // against comes from the single `penyisihan_periode` reader in
    // ./service-lainnya.ts, and the resolver form means both are answered
    // inside ONE authorisation and ONE period lookup.
    perhitunganPenyisihan: (filter, ctx) =>
      pumk.perhitunganPenyisihan(filter, ctx, lainnya.penyisihanDibutuhkanRun),
    bebanPenyisihan: lainnya.bebanPenyisihan,
    akrualJasa: lainnya.akrualJasa,
    auditTrail: lainnya.auditTrail,
  };
}
