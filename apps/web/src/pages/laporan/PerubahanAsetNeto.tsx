// 20. Laporan Perubahan Aset Neto, spec 10.3. Saldo awal, kenaikan atau
// penurunan, saldo akhir, per kategori aset neto.
//
// SIX FIGURES PER ROW, NOT TWO, so this one does not use the shared two column
// statement table: each category carries a full triple for this year and the
// same triple for last year. The layout keeps the two triples as two labelled
// groups rather than as six anonymous columns, because "saldo akhir tahun
// lalu" and "saldo awal tahun ini" are different numbers that look identical
// when the column headers scroll off a phone.
//
// THE CATEGORY NAMES ARE THE TEMPLATE'S. Spec 10.3 report 20 says so, and the
// report header says which template answered.
import { Panel } from "@krakatausteel/ui";
import {
  laporanPerubahanAsetNeto,
  type BarisPerubahanAsetNeto,
  type LaporanPerubahanAsetNeto,
} from "../../api/laporan";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { HalamanLaporan, KopLaporan, Nilai, Pembanding, useFilterLaporan } from "./parts";
import { Icon } from "@krakatausteel/ui";

export function PerubahanAsetNetoPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();
  const hasil = useApi(
    () =>
      laporanPerubahanAsetNeto({
        periodeId: filter.periodeId ?? "",
        cabangId: filter.cabangId,
      }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="Laporan Perubahan Aset Neto"
      sumber="GET /api/laporan/perubahan-aset-neto"
    >
      {(data: LaporanPerubahanAsetNeto) => (
        <>
          <KopLaporan header={data.header} />
          <Pembanding kolom={data.kolom} jenis="RENTANG" />

          <Panel
            as="h2"
            title="Perubahan per kategori aset neto"
            description="Total perubahan di bawah wajib sama dengan kenaikan aset neto pada Laporan Aktivitas untuk periode dan cabang yang sama."
          >
            {data.baris.length === 0 ? (
              <div className="antrean-kosong">
                <span className="antrean-kosong-icon" aria-hidden="true">
                  <Icon name="list" size={20} />
                </span>
                <p className="antrean-kosong-title">Tidak ada kategori aset neto</p>
                <p className="antrean-kosong-desc">
                  Template laporan belum mendefinisikan satu kategori aset neto pun untuk entitas
                  ini.
                </p>
              </div>
            ) : (
              <ul className="trio-list">
                {data.baris.map((row) => (
                  <BarisTrio
                    key={row.kategoriKode}
                    row={row}
                    labelTahunIni={data.kolom.labelTahunIni}
                    labelTahunLalu={data.kolom.labelTahunLalu}
                  />
                ))}
                <BarisTrio
                  total
                  row={{
                    kategoriKode: "TOTAL",
                    nama: "Total seluruh kategori",
                    urutan: 9999,
                    saldoAwalTahunIni: data.totalSaldoAwalTahunIni,
                    perubahanTahunIni: data.totalPerubahanTahunIni,
                    saldoAkhirTahunIni: data.totalSaldoAkhirTahunIni,
                    saldoAwalTahunLalu: data.totalSaldoAwalTahunLalu,
                    perubahanTahunLalu: data.totalPerubahanTahunLalu,
                    saldoAkhirTahunLalu: data.totalSaldoAkhirTahunLalu,
                  }}
                  labelTahunIni={data.kolom.labelTahunIni}
                  labelTahunLalu={data.kolom.labelTahunLalu}
                />
              </ul>
            )}
          </Panel>
        </>
      )}
    </HalamanLaporan>
  );
}

function BarisTrio({
  row,
  labelTahunIni,
  labelTahunLalu,
  total = false,
}: {
  row: BarisPerubahanAsetNeto;
  labelTahunIni: string;
  labelTahunLalu: string;
  total?: boolean;
}) {
  return (
    <li className={total ? "trio-item is-total" : "trio-item"}>
      <p className="trio-nama">{row.nama}</p>
      <div className="trio-grid">
        <div className="trio-kolom">
          <p className="trio-kolom-judul">{labelTahunIni}</p>
          <dl className="trio-angka">
            <div className="trio-baris">
              <dt>Saldo awal</dt>
              <dd>
                <Nilai angka={row.saldoAwalTahunIni} />
              </dd>
            </div>
            <div className="trio-baris">
              <dt>Kenaikan atau penurunan</dt>
              <dd>
                <Nilai angka={row.perubahanTahunIni} />
              </dd>
            </div>
            <div className="trio-baris is-akhir">
              <dt>Saldo akhir</dt>
              <dd>
                <Nilai angka={row.saldoAkhirTahunIni} />
              </dd>
            </div>
          </dl>
        </div>
        <div className="trio-kolom">
          <p className="trio-kolom-judul">{labelTahunLalu}</p>
          <dl className="trio-angka">
            <div className="trio-baris">
              <dt>Saldo awal</dt>
              <dd>
                <Nilai angka={row.saldoAwalTahunLalu} />
              </dd>
            </div>
            <div className="trio-baris">
              <dt>Kenaikan atau penurunan</dt>
              <dd>
                <Nilai angka={row.perubahanTahunLalu} />
              </dd>
            </div>
            <div className="trio-baris is-akhir">
              <dt>Saldo akhir</dt>
              <dd>
                <Nilai angka={row.saldoAkhirTahunLalu} />
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </li>
  );
}
