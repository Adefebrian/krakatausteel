// 17. Laporan Aktivitas, spec 10.3. The nonprofit entity's income statement:
// pendapatan then beban, grouped by aset neto class, with the comparative
// column beside it.
//
// THE COMPARATIVE IS A SPAN. This statement is cumulative from the first day
// of the financial year to the period end, and the column next to it covers
// THE SAME MONTHS one year earlier. That is deliberately not the same kind of
// comparison as the balance sheet's, which is a single date, and `Pembanding`
// prints which one is on screen so the two never quietly read alike.
//
// THE ROW NAMES ARE NOT THIS FILE'S. Every line, its order, its indentation
// and whether it prints bold comes from `baris_laporan`, the template the
// period resolved. The header says which template answered.
import {
  laporanAktivitas,
  type BarisStatement,
  type LaporanAktivitas,
} from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { Panel } from "@krakatausteel/ui";
import {
  HalamanLaporan,
  KopLaporan,
  Pembanding,
  RingkasAngka,
  TabelStatement,
  useFilterLaporan,
  type BarisStatementTampil,
} from "./parts";

/** One template row as the shared statement table renders it. */
export function barisTampil(row: BarisStatement): BarisStatementTampil {
  return {
    key: row.barisLaporanId,
    label: row.nama,
    level: row.level,
    tebal: row.cetakTebal || row.tipeBaris === "TOTAL" || row.tipeBaris === "SUBTOTAL",
    garisAtas: row.tipeBaris === "TOTAL" || row.tipeBaris === "SUBTOTAL",
    tahunIni: row.nilaiTahunIni,
    tahunLalu: row.nilaiTahunLalu,
    akunKode: row.akunKode,
  };
}

export function AktivitasPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();
  const hasil = useApi(
    () => laporanAktivitas({ periodeId: filter.periodeId ?? "", cabangId: filter.cabangId }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="Laporan Aktivitas"
      sumber="GET /api/laporan/aktivitas"
    >
      {(data: LaporanAktivitas) => (
        <>
          <KopLaporan header={data.header} />
          <Pembanding kolom={data.kolom} jenis="RENTANG" />

          {/* A template that groups nothing still has rows, and they are shown
              flat rather than swallowed: an empty page under a filled header
              reads as "this entity had no activity", which is a different
              claim entirely. */}
          {data.seksi.length === 0 ? (
            <Panel
              as="h2"
              title="Baris laporan"
              description="Template laporan tidak membentuk kelompok aset neto, jadi barisnya ditampilkan berurutan."
            >
              <TabelStatement
                baris={data.baris.map(barisTampil)}
                labelTahunIni={data.kolom.labelTahunIni}
                labelTahunLalu={data.kolom.labelTahunLalu}
                kosongJudul="Tidak ada baris laporan"
                kosongPesan="Server menjawab tanpa satu baris pun. Template laporan aktivitas belum memetakan akun apa pun."
              />
            </Panel>
          ) : null}

          {data.seksi.map((seksi) => (
            <Panel
              key={seksi.kode}
              as="h2"
              title={seksi.nama}
              description="Pendapatan dan beban kelompok aset neto ini, menurut template laporan yang berlaku."
            >
              <TabelStatement
                baris={seksi.baris.map(barisTampil)}
                labelTahunIni={data.kolom.labelTahunIni}
                labelTahunLalu={data.kolom.labelTahunLalu}
                kosongJudul="Tidak ada baris pada kelompok ini"
                kosongPesan="Template laporan tidak memetakan satu akun pun ke kelompok aset neto ini."
              />
              <RingkasAngka
                items={[
                  {
                    label: "Total pendapatan",
                    tahunIni: seksi.totalPendapatanTahunIni,
                    tahunLalu: seksi.totalPendapatanTahunLalu,
                  },
                  {
                    label: "Total beban",
                    tahunIni: seksi.totalBebanTahunIni,
                    tahunLalu: seksi.totalBebanTahunLalu,
                  },
                  {
                    label: "Kenaikan aset neto",
                    tahunIni: seksi.kenaikanAsetNetoTahunIni,
                    tahunLalu: seksi.kenaikanAsetNetoTahunLalu,
                  },
                ]}
              />
            </Panel>
          ))}

          <Panel
            as="h2"
            title="Kenaikan aset neto seluruh kelompok"
            description="Angka ini adalah baris bawah Laporan Aktivitas dan harus sama dengan total perubahan pada Laporan Perubahan Aset Neto untuk periode dan cabang yang sama."
          >
            <RingkasAngka
              items={[
                {
                  label: "Kenaikan aset neto",
                  tahunIni: data.kenaikanAsetNetoTahunIni,
                  tahunLalu: data.kenaikanAsetNetoTahunLalu,
                },
              ]}
            />
          </Panel>
        </>
      )}
    </HalamanLaporan>
  );
}
