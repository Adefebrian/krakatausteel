// 8. Laporan Aging Piutang, spec 10.1.
//
// A GRID, NOT A LIST, which is why it does not come through ./generik.tsx: one
// mitra is one row and every bucket is a column, so the table is as wide as the
// bucket definition and the reader's question is "which column is this money
// in" rather than "what is on this row".
//
// THE BUCKETS COME FROM THE RESPONSE, NOT FROM A COPY OF THE DEFINITION HERE.
// `perBucket` carries each bucket's code and its Indonesian name in order, and
// the per mitra rows are keyed by the same codes. Restating the five bucket
// boundaries in this file would have been a second definition of the ageing
// policy, and the day the client changes "di atas 270 hari" the screen would
// have kept drawing the old columns over new figures.
//
// ON A PHONE the bucket a mitra's money sits in is what matters, so each card
// carries the outstanding and the bucket detail opens in a sheet. The card is a
// fixed shape either way.
import { useState } from "react";
import { Button, Icon, Modal, Panel, formatCount } from "@krakatausteel/ui";
import {
  agingPiutang,
  type BarisAging,
  type LaporanAgingPiutang,
  type RingkasanBucket,
} from "../../api/laporan-operasional";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { HalamanLaporan, KopLaporan, Nilai, NilaiPersen, teksNilai, useFilterLaporan } from "./parts";

export function AgingPiutangPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();

  const hasil = useApi(
    () => agingPiutang({ periodeId: filter.periodeId ?? "", cabangId: filter.cabangId }),
    [filter.periodeId, filter.cabangId],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="laporan aging piutang"
      sumber="GET /api/laporan/aging-piutang"
      crumb="Laporan Pendanaan UMK"
    >
      {(data: LaporanAgingPiutang) => <BadanAging data={data} />}
    </HalamanLaporan>
  );
}

function BadanAging({ data }: { data: LaporanAgingPiutang }) {
  const [terbuka, setTerbuka] = useState<BarisAging | null>(null);
  const bucket = data.perBucket;

  return (
    <>
      <KopLaporan header={data.header} />

      <Panel
        as="h2"
        title="Outstanding per mitra dan umur tunggakan"
        description={`${data.baris.length} mitra dengan piutang berjalan, dibagi ke ${bucket.length} kelompok umur.`}
      >
        {data.baris.length === 0 ? (
          <Kosong />
        ) : (
          <>
            <div className="daftar-tabel">
              <div className="table-wrap has-sticky-header">
                <table className="table matriks-tabel">
                  <thead>
                    <tr>
                      {/* THE BRANCH RIDES WITH THE PARTNER RATHER THAN
                          TAKING A COLUMN. Nine columns did not fit 1440: the
                          last bucket, "Di atas 270 hari", the one an operator
                          opens this report FOR, was clipped off the right edge
                          at every desktop width. Losing a column that repeats
                          one short word per row is the cheapest hundred and
                          fifty pixels on the page. */}
                      <th scope="col" className="matriks-kepala">
                        Mitra Binaan
                      </th>
                      <th scope="col" className="is-numeric">
                        Outstanding pokok
                      </th>
                      <th scope="col" className="is-numeric">
                        Outstanding jasa
                      </th>
                      {bucket.map((b) => (
                        <th key={b.kode} scope="col" className="is-numeric">
                          {b.nama}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.baris.map((row) => (
                      <tr key={row.mitraId}>
                        <th scope="row" className="matriks-kepala">
                          <span className="sel-nama">
                            <span className="sel-nama-judul">
                              {row.kodeMitra} {row.namaMitra}
                            </span>
                            <span className="sel-nama-sub">{row.namaCabang}</span>
                          </span>
                        </th>
                        <td className="is-numeric">
                          <Nilai angka={row.outstanding} />
                        </td>
                        <td className="is-numeric">
                          <Nilai angka={row.outstandingJasa} />
                        </td>
                        {bucket.map((b) => (
                          <td key={b.kode} className="is-numeric">
                            <Nilai angka={row.bucket[b.kode]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" className="matriks-kepala">
                        Total {formatCount(data.total.jumlahMitra)} mitra
                      </th>
                      <td className="is-numeric">
                        <Nilai angka={data.total.outstanding} />
                      </td>
                      <td className="is-numeric">
                        <Nilai angka={data.total.outstandingJasa} />
                      </td>
                      {bucket.map((b) => (
                        <td key={b.kode} className="is-numeric">
                          <Nilai angka={b.outstanding} />
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="daftar-kartu">
              <ul className="kartu-list">
                {data.baris.map((row) => (
                  <li className="kartu-item" key={row.mitraId}>
                    <div className="kartu-btn is-statis">
                      <span className="kartu-head">
                        <span className="kartu-judul">
                          {row.kodeMitra} {row.namaMitra}
                        </span>
                      </span>
                      <span className="kartu-sub">{row.namaCabang}</span>
                      <span className="kartu-foot">
                        <span className="kartu-meta">
                          <button
                            type="button"
                            className="matriks-buka"
                            onClick={() => setTerbuka(row)}
                          >
                            <span>Lihat kelompok umur</span>
                            <Icon name="chevronRight" size={16} />
                          </button>
                        </span>
                        <span className="kartu-nilai">
                          <span className="kartu-nilai-label">Outstanding pokok</span>
                          <span className="kartu-nilai-val">{teksNilai(row.outstanding)}</span>
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Panel>

      <Panel as="h2" title="Total laporan">
        <ul className="ringkas-angka">
          <li className="ringkas-angka-item">
            <span className="ringkas-angka-label">Mitra dengan piutang</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Mitra</span>
              <span className="angka">{formatCount(data.total.jumlahMitra)}</span>
            </span>
          </li>
          <li className="ringkas-angka-item">
            <span className="ringkas-angka-label">Outstanding</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Pokok</span>
              <Nilai angka={data.total.outstanding} />
            </span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Jasa administrasi</span>
              <Nilai angka={data.total.outstandingJasa} />
            </span>
          </li>
        </ul>
      </Panel>

      <Panel
        as="h2"
        title="Rekap per kelompok umur"
        description="Piutang yang sama, dijumlahkan menurut umur tunggakannya."
      >
        <RekapBucket baris={bucket} />
      </Panel>

      <Panel
        as="h2"
        title="Rekap per cabang"
        description="Piutang yang sama, dijumlahkan menurut cabang yang membina mitranya."
      >
        {data.perCabang.length === 0 ? (
          <Kosong />
        ) : (
          <div className="daftar-tabel">
            <div className="table-wrap has-sticky-header">
              <table className="table matriks-tabel">
                <thead>
                  <tr>
                    <th scope="col" className="matriks-kepala">
                      Cabang
                    </th>
                    <th scope="col" className="is-numeric">
                      Jumlah mitra
                    </th>
                    <th scope="col" className="is-numeric">
                      Outstanding
                    </th>
                    {bucket.map((b) => (
                      <th key={b.kode} scope="col" className="is-numeric">
                        {b.nama}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.perCabang.map((row) => (
                    <tr key={row.cabangId}>
                      <th scope="row" className="matriks-kepala">
                        {row.namaCabang}
                      </th>
                      <td className="is-numeric">
                        <span className="angka">{formatCount(row.jumlahMitra)}</span>
                      </td>
                      <td className="is-numeric">
                        <Nilai angka={row.outstanding} />
                      </td>
                      {bucket.map((b) => (
                        <td key={b.kode} className="is-numeric">
                          <Nilai angka={row.bucket[b.kode]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="daftar-kartu">
          <ul className="kartu-list">
            {data.perCabang.map((row) => (
              <li className="kartu-item" key={row.cabangId}>
                <div className="kartu-btn is-statis">
                  <span className="kartu-head">
                    <span className="kartu-judul">{row.namaCabang}</span>
                  </span>
                  <span className="kartu-sub">{formatCount(row.jumlahMitra)} mitra binaan</span>
                  <span className="kartu-foot">
                    <span className="kartu-meta">Seluruh kelompok umur digabung</span>
                    <span className="kartu-nilai">
                      <span className="kartu-nilai-label">Outstanding</span>
                      <span className="kartu-nilai-val">{teksNilai(row.outstanding)}</span>
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Batas setiap kelompok umur dibaca dari jawaban server, bukan dari salinan aturan di
          halaman ini, jadi perubahan kebijakan aging langsung terlihat pada kolomnya.
        </span>
      </p>

      <Modal
        open={terbuka !== null}
        title={terbuka ? `${terbuka.kodeMitra} ${terbuka.namaMitra}` : ""}
        description="Outstanding mitra ini, dipecah menurut umur tunggakannya."
        onClose={() => setTerbuka(null)}
        size="md"
        actions={
          <Button variant="primary" onClick={() => setTerbuka(null)}>
            Tutup
          </Button>
        }
      >
        <ul className="matriks-rincian">
          {bucket.map((b) => (
            <li className="matriks-rincian-item" key={b.kode}>
              <span className="matriks-rincian-nama">{b.nama}</span>
              <span className="matriks-rincian-nilai">
                <Nilai angka={terbuka ? terbuka.bucket[b.kode] : undefined} />
              </span>
            </li>
          ))}
          <li className="matriks-rincian-item is-total">
            <span className="matriks-rincian-nama">Outstanding pokok</span>
            <span className="matriks-rincian-nilai">
              <Nilai angka={terbuka?.outstanding} />
            </span>
          </li>
          <li className="matriks-rincian-item is-total">
            <span className="matriks-rincian-nama">Outstanding jasa administrasi</span>
            <span className="matriks-rincian-nilai">
              <Nilai angka={terbuka?.outstandingJasa} />
            </span>
          </li>
        </ul>
      </Modal>
    </>
  );
}

function RekapBucket({ baris }: { baris: readonly RingkasanBucket[] }) {
  if (baris.length === 0) return <Kosong />;
  return (
    <>
      <div className="daftar-tabel">
        <div className="table-wrap has-sticky-header">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Kelompok umur</th>
                <th scope="col" className="is-numeric" style={{ width: "150px" }}>
                  Jumlah mitra
                </th>
                <th scope="col" className="is-numeric" style={{ width: "190px" }}>
                  Outstanding
                </th>
                <th scope="col" className="is-numeric" style={{ width: "170px" }}>
                  Persen dari total
                </th>
              </tr>
            </thead>
            <tbody>
              {baris.map((row) => (
                <tr key={row.kode}>
                  <td>{row.nama}</td>
                  <td className="is-numeric">
                    <span className="angka">{formatCount(row.jumlahMitra)}</span>
                  </td>
                  <td className="is-numeric">
                    <Nilai angka={row.outstanding} />
                  </td>
                  <td className="is-numeric">
                    <NilaiPersen nilai={row.persenDariTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="daftar-kartu">
        <ul className="kartu-list">
          {baris.map((row) => (
            <li className="kartu-item" key={row.kode}>
              <div className="kartu-btn is-statis">
                <span className="kartu-head">
                  <span className="kartu-judul">{row.nama}</span>
                </span>
                <span className="kartu-sub">{formatCount(row.jumlahMitra)} mitra binaan</span>
                <span className="kartu-foot">
                  <span className="kartu-meta">Bagian dari total piutang</span>
                  <span className="kartu-nilai">
                    <span className="kartu-nilai-label">Outstanding</span>
                    <span className="kartu-nilai-val">{teksNilai(row.outstanding)}</span>
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Kosong() {
  return (
    <div className="antrean-kosong">
      <span className="antrean-kosong-icon" aria-hidden="true">
        <Icon name="list" size={20} />
      </span>
      <p className="antrean-kosong-title">Tidak ada piutang berjalan</p>
      <p className="antrean-kosong-desc">
        Tidak ada Mitra Binaan dengan outstanding pada periode dan cabang yang dipilih.
      </p>
    </div>
  );
}
