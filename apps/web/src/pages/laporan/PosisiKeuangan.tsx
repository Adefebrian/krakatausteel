// 19. Laporan Posisi Keuangan, spec 10.3. Aset, Liabilitas, Aset Neto, at the
// period end.
//
// THE COMPARATIVE IS A POINT, NOT A SPAN. Reports 17 and 18 compare the same
// MONTHS one year earlier because a flow is measured over time. This one
// compares the balance at the END OF THE PRECEDING FINANCIAL YEAR, because a
// position is measured on a date. They are deliberately unlike and this page
// prints which kind it is rather than dressing the two to match.
//
// THE STATEMENT BALANCES OR IT IS NOT PRINTED. The engine refuses a position
// that does not satisfy Total Aset = Total Liabilitas + Aset Neto
// (`LAPORAN_TIDAK_BALANCE`), so a page that renders at all is one that ties.
// This screen shows the identity as three figures rather than asserting it in
// prose, so a reader can check the arithmetic on the paper in front of them.
import { Panel } from "@krakatausteel/ui";
import { laporanPosisiKeuangan, type LaporanPosisiKeuangan } from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { barisTampil } from "./Aktivitas";
import {
  HalamanLaporan,
  KopLaporan,
  Pembanding,
  RingkasAngka,
  TabelStatement,
  useFilterLaporan,
} from "./parts";

export function PosisiKeuanganPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();
  const hasil = useApi(
    () =>
      laporanPosisiKeuangan({ periodeId: filter.periodeId ?? "", cabangId: filter.cabangId }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="Laporan Posisi Keuangan"
      sumber="GET /api/laporan/posisi-keuangan"
    >
      {(data: LaporanPosisiKeuangan) => (
        <>
          <KopLaporan header={data.header} />
          <Pembanding kolom={data.kolom} jenis="TITIK" />

          <Panel
            as="h2"
            title="Aset"
            description="Nama dan urutan baris berasal dari template laporan yang berlaku, bukan dari halaman ini."
          >
            <TabelStatement
              baris={data.barisAset.map(barisTampil)}
              labelTahunIni={data.kolom.labelTahunIni}
              labelTahunLalu={data.kolom.labelTahunLalu}
              kosongJudul="Tidak ada baris aset"
              kosongPesan="Template laporan tidak memetakan satu akun aset pun ke laporan posisi keuangan."
            />
            <RingkasAngka
              items={[
                {
                  label: "Total aset",
                  tahunIni: data.totalAsetTahunIni,
                  tahunLalu: data.totalAsetTahunLalu,
                },
                {
                  label: "Kas dan setara kas",
                  tahunIni: data.kasDanSetaraKasTahunIni,
                  tahunLalu: data.kasDanSetaraKasTahunLalu,
                },
              ]}
            />
          </Panel>

          <Panel as="h2" title="Liabilitas">
            <TabelStatement
              baris={data.barisLiabilitas.map(barisTampil)}
              labelTahunIni={data.kolom.labelTahunIni}
              labelTahunLalu={data.kolom.labelTahunLalu}
              kosongJudul="Tidak ada baris liabilitas"
              kosongPesan="Template laporan tidak memetakan satu akun liabilitas pun ke laporan posisi keuangan."
            />
            <RingkasAngka
              items={[
                {
                  label: "Total liabilitas",
                  tahunIni: data.totalLiabilitasTahunIni,
                  tahunLalu: data.totalLiabilitasTahunLalu,
                },
              ]}
            />
          </Panel>

          <Panel
            as="h2"
            title="Aset neto"
            description="Termasuk kenaikan aset neto periode berjalan, yang adalah baris bawah Laporan Aktivitas untuk periode yang sama."
          >
            <TabelStatement
              baris={data.barisAsetNeto.map(barisTampil)}
              labelTahunIni={data.kolom.labelTahunIni}
              labelTahunLalu={data.kolom.labelTahunLalu}
              kosongJudul="Tidak ada baris aset neto"
              kosongPesan="Template laporan tidak memetakan satu kategori aset neto pun ke laporan posisi keuangan."
            />
            <RingkasAngka
              items={[
                {
                  label: "Kenaikan aset neto periode berjalan",
                  tahunIni: data.kenaikanAsetNetoPeriodeBerjalanTahunIni,
                  tahunLalu: data.kenaikanAsetNetoPeriodeBerjalanTahunLalu,
                },
                {
                  label: "Total aset neto",
                  tahunIni: data.totalAsetNetoTahunIni,
                  tahunLalu: data.totalAsetNetoTahunLalu,
                },
              ]}
            />
          </Panel>

          <Panel
            as="h2"
            title="Keseimbangan laporan"
            description="Total Aset wajib sama dengan Total Liabilitas ditambah Total Aset Neto. Server menolak mencetak laporan yang tidak seimbang."
          >
            <RingkasAngka
              items={[
                {
                  label: "Total aset",
                  tahunIni: data.totalAsetTahunIni,
                  tahunLalu: data.totalAsetTahunLalu,
                },
                {
                  label: "Total liabilitas dan aset neto",
                  tahunIni: data.totalLiabilitasDanAsetNetoTahunIni,
                  tahunLalu: data.totalLiabilitasDanAsetNetoTahunLalu,
                },
              ]}
            />
          </Panel>
        </>
      )}
    </HalamanLaporan>
  );
}
