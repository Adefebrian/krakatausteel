// 18. Laporan Arus Kas, spec 10.3. Direct method: Operasi, Investasi,
// Pendanaan, then Kenaikan Kas, Kas Awal and Kas Akhir.
//
// THE COMPARATIVE IS A SPAN, and that is the same kind of comparative report
// 17 carries and NOT the kind report 19 carries. A flow is measured over
// months, so its comparison is the same months a year earlier; a position is
// measured on a date, so its comparison is a date. The two are deliberately
// different and `Pembanding` prints which one is on screen.
//
// KAS AKHIR TIES TO REPORT 19. Spec 10.3 report 18 says in as many words that
// Kas Akhir here equals the balance of the kas flagged accounts in Laporan
// Posisi Keuangan for the same period and the same branch filter. The engine
// asserts that identity; this page names it, and lists the kas accounts it was
// built from, so a reader who finds the two disagreeing knows which accounts
// to open rather than which developer to ask.
import { Panel } from "@krakatausteel/ui";
import { laporanArusKas, type LaporanArusKas } from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import {
  HalamanLaporan,
  KopLaporan,
  Nilai,
  Pembanding,
  RingkasAngka,
  TabelStatement,
  useFilterLaporan,
} from "./parts";

const NAMA_SEKSI: Record<string, string> = {
  OPERASI: "Arus kas dari aktivitas operasi",
  INVESTASI: "Arus kas dari aktivitas investasi",
  PENDANAAN: "Arus kas dari aktivitas pendanaan",
};

export function ArusKasPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();
  const hasil = useApi(
    () => laporanArusKas({ periodeId: filter.periodeId ?? "", cabangId: filter.cabangId }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="Laporan Arus Kas"
      sumber="GET /api/laporan/arus-kas"
    >
      {(data: LaporanArusKas) => (
        <>
          <KopLaporan header={data.header} />
          <Pembanding kolom={data.kolom} jenis="RENTANG" />

          {data.seksi.map((seksi) => (
            <Panel
              key={seksi.klasifikasi}
              as="h2"
              title={seksi.nama || (NAMA_SEKSI[seksi.klasifikasi] ?? seksi.klasifikasi)}
              description="Metode langsung: setiap baris adalah pergerakan kas pada akun yang bersangkutan, bukan hasil rekonsiliasi laba."
            >
              <TabelStatement
                baris={seksi.baris.map((row) => ({
                  key: `${seksi.klasifikasi}-${row.akunId}`,
                  label: `${row.akunKode} ${row.uraian}`,
                  level: 1,
                  tahunIni: row.nilaiTahunIni,
                  tahunLalu: row.nilaiTahunLalu,
                }))}
                labelTahunIni={data.kolom.labelTahunIni}
                labelTahunLalu={data.kolom.labelTahunLalu}
                kosongJudul="Tidak ada arus kas pada klasifikasi ini"
                kosongPesan="Tidak ada satu pun akun berklasifikasi ini yang bergerak pada periode tersebut."
              />
              <RingkasAngka
                items={[
                  {
                    label: `Total ${seksi.nama || (NAMA_SEKSI[seksi.klasifikasi] ?? seksi.klasifikasi)}`,
                    tahunIni: seksi.totalTahunIni,
                    tahunLalu: seksi.totalTahunLalu,
                  },
                ]}
              />
            </Panel>
          ))}

          <Panel
            as="h2"
            title="Kenaikan kas, kas awal dan kas akhir"
            description="Kas Akhir wajib sama dengan Kas dan Setara Kas pada Laporan Posisi Keuangan untuk periode dan cabang yang sama."
          >
            <RingkasAngka
              items={[
                {
                  label: "Kenaikan kas",
                  tahunIni: data.kenaikanKasTahunIni,
                  tahunLalu: data.kenaikanKasTahunLalu,
                },
                {
                  label: "Kas awal",
                  tahunIni: data.kasAwalTahunIni,
                  tahunLalu: data.kasAwalTahunLalu,
                },
                {
                  label: "Kas akhir",
                  tahunIni: data.kasAkhirTahunIni,
                  tahunLalu: data.kasAkhirTahunLalu,
                },
              ]}
            />
          </Panel>

          <Panel
            as="h2"
            title="Akun kas dan setara kas"
            description="Akun berflag kas yang membentuk Kas Akhir, beserta saldonya pada akhir periode."
          >
            {data.akunKas.length === 0 ? (
              <p className="muat-diam">
                Tidak ada akun berflag kas pada bagan akun entitas ini, jadi Kas Akhir tidak punya
                akun pembentuk yang bisa ditelusuri.
              </p>
            ) : (
              <ul className="rincian-list">
                {data.akunKas.map((akun) => (
                  <li className="rincian-item" key={akun.akunId}>
                    <span className="rincian-utama">
                      <span className="rincian-kode">{akun.kode}</span>
                      <span className="rincian-nama">{akun.nama}</span>
                    </span>
                    <span className="rincian-nilai">
                      <span className="rincian-nilai-label">Saldo akhir</span>
                      <Nilai angka={akun.saldo} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </HalamanLaporan>
  );
}
