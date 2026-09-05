// THE TWO MATRIX REPORTS: 3. Laporan Penyaluran Nasional (provinsi kali
// sektor) and 11. Laporan Perpindahan Kolektibilitas (kelas periode lalu kali
// kelas periode ini).
//
// THEY DO NOT GO THROUGH ./generik.tsx, AND THAT IS THE POINT. A matrix has no
// fixed column list: its columns come from the DATA, one per sector or one per
// collectibility class, so a driver built around a declared `Column[]` would
// have had to grow a second mode that took its columns from the response. Two
// modes in one driver is how a shared frame stops being shared. One small
// component that only draws matrices is the smaller thing.
//
// EVERY CELL CARRIES TWO FIGURES, a count and a value, and both are always
// shown. A matrix that showed only the value would answer "how much" and hide
// "how many", and the two together are the whole reason the specification asks
// for a cross tabulation rather than two lists.
//
// ON A PHONE A MATRIX IS NOT A TABLE. Twenty columns become a sideways scroll
// nobody reads, so each ROW becomes one fixed shape card carrying its own
// total, and the cells behind it open in a sheet. The card cannot change height
// with the data, so the list still reads as one system, and no figure is lost.
import { useState, type ReactNode } from "react";
import { Button, Icon, Modal, Panel, formatCount } from "@krakatausteel/ui";
import {
  penyaluranNasional,
  perpindahanKolektibilitas,
  type Angka,
  type LaporanPenyaluranNasional,
  type LaporanPerpindahanKolektibilitas,
} from "../../api/laporan-operasional";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useModeLaporan } from "./generik";
import { HalamanLaporan, KopLaporan, Nilai, teksNilai, useFilterLaporan } from "./parts";

// ---------------------------------------------------------------------------
// The matrix itself
// ---------------------------------------------------------------------------

interface SelTampil {
  /** The value, rendered through `Nilai`. */
  nilai: Angka;
  /** The count that goes with it, already a plain number. */
  cacah: number;
}

interface BarisTampil {
  key: string;
  label: string;
  sel: readonly SelTampil[];
  total: SelTampil;
}

function Sel({ sel, labelCacah }: { sel: SelTampil; labelCacah: string }) {
  return (
    <span className="matriks-sel">
      <Nilai angka={sel.nilai} />
      <span className="matriks-cacah">
        {formatCount(sel.cacah)} {labelCacah}
      </span>
    </span>
  );
}

function MatriksLaporan({
  judulBaris,
  labelCacah,
  kolom,
  baris,
  totalKolom,
  totalKeseluruhan,
}: {
  /** What the first column names, e.g. "Provinsi". */
  judulBaris: string;
  /** What the count in every cell counts, e.g. "mitra" or "akad". */
  labelCacah: string;
  kolom: readonly { key: string; label: string }[];
  baris: readonly BarisTampil[];
  totalKolom: readonly SelTampil[];
  totalKeseluruhan: SelTampil;
}) {
  const [terbuka, setTerbuka] = useState<BarisTampil | null>(null);

  if (baris.length === 0 || kolom.length === 0) {
    return (
      <div className="antrean-kosong">
        <span className="antrean-kosong-icon" aria-hidden="true">
          <Icon name="list" size={20} />
        </span>
        <p className="antrean-kosong-title">Tidak ada baris pada jendela ini</p>
        <p className="antrean-kosong-desc">
          Tidak ada data yang bisa disilangkan pada periode dan cabang yang dipilih, jadi
          matriksnya kosong.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="daftar-tabel">
        <div className="table-wrap has-sticky-header">
          <table className="table matriks-tabel">
            <thead>
              <tr>
                <th scope="col" className="matriks-kepala">
                  {judulBaris}
                </th>
                {kolom.map((k) => (
                  <th key={k.key} scope="col" className="is-numeric">
                    {k.label}
                  </th>
                ))}
                <th scope="col" className="is-numeric">
                  Total baris
                </th>
              </tr>
            </thead>
            <tbody>
              {baris.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="matriks-kepala">
                    {row.label}
                  </th>
                  {row.sel.map((sel, index) => (
                    <td key={kolom[index]?.key ?? index} className="is-numeric">
                      <Sel sel={sel} labelCacah={labelCacah} />
                    </td>
                  ))}
                  <td className="is-numeric">
                    <Sel sel={row.total} labelCacah={labelCacah} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="matriks-kepala">
                  Total kolom
                </th>
                {totalKolom.map((sel, index) => (
                  <td key={kolom[index]?.key ?? index} className="is-numeric">
                    <Sel sel={sel} labelCacah={labelCacah} />
                  </td>
                ))}
                <td className="is-numeric">
                  <Sel sel={totalKeseluruhan} labelCacah={labelCacah} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="daftar-kartu">
        <ul className="kartu-list">
          {baris.map((row) => (
            <li className="kartu-item" key={row.key}>
              <div className="kartu-btn is-statis">
                <span className="kartu-head">
                  <span className="kartu-judul">{row.label}</span>
                </span>
                <span className="kartu-sub">
                  {formatCount(row.total.cacah)} {labelCacah} pada {formatCount(kolom.length)} kolom
                </span>
                <span className="kartu-foot">
                  <span className="kartu-meta">
                    <button
                      type="button"
                      className="matriks-buka"
                      onClick={() => setTerbuka(row)}
                    >
                      <span>Lihat rincian kolom</span>
                      <Icon name="chevronRight" size={16} />
                    </button>
                  </span>
                  <span className="kartu-nilai">
                    <span className="kartu-nilai-label">Total baris</span>
                    <span className="kartu-nilai-val">{teksNilai(row.total.nilai)}</span>
                  </span>
                </span>
              </div>
            </li>
          ))}
          <li className="kartu-item" key="__total">
            <div className="kartu-btn is-statis">
              <span className="kartu-head">
                <span className="kartu-judul">Total seluruh matriks</span>
              </span>
              <span className="kartu-sub">
                {formatCount(totalKeseluruhan.cacah)} {labelCacah} pada seluruh baris dan kolom
              </span>
              <span className="kartu-foot">
                <span className="kartu-meta">Baris terakhir tabel</span>
                <span className="kartu-nilai">
                  <span className="kartu-nilai-label">Total</span>
                  <span className="kartu-nilai-val">{teksNilai(totalKeseluruhan.nilai)}</span>
                </span>
              </span>
            </div>
          </li>
        </ul>
      </div>

      <Modal
        open={terbuka !== null}
        title={terbuka?.label ?? ""}
        description={`Rincian setiap kolom untuk baris ini, beserta jumlah ${labelCacah}.`}
        onClose={() => setTerbuka(null)}
        size="md"
        actions={
          <Button variant="primary" onClick={() => setTerbuka(null)}>
            Tutup
          </Button>
        }
      >
        <ul className="matriks-rincian">
          {(terbuka?.sel ?? []).map((sel, index) => (
            <li className="matriks-rincian-item" key={kolom[index]?.key ?? index}>
              <span className="matriks-rincian-nama">{kolom[index]?.label ?? "Kolom"}</span>
              <span className="matriks-rincian-nilai">
                <Nilai angka={sel.nilai} />
                <span className="matriks-cacah">
                  {formatCount(sel.cacah)} {labelCacah}
                </span>
              </span>
            </li>
          ))}
          <li className="matriks-rincian-item is-total">
            <span className="matriks-rincian-nama">Total baris</span>
            <span className="matriks-rincian-nilai">
              <Nilai angka={terbuka?.total.nilai ?? { nilai: "0.00", tampil: "0,00" }} />
              <span className="matriks-cacah">
                {formatCount(terbuka?.total.cacah ?? 0)} {labelCacah}
              </span>
            </span>
          </li>
        </ul>
      </Modal>
    </>
  );
}

/** The totals panel both matrices carry, in the same shape every other report
 *  in spec 10 uses for its footing. */
function TotalMatriks({
  cacah,
  nilai,
  labelCacah,
  jumlahBaris,
  jumlahKolom,
  judulBaris,
  judulKolom,
}: {
  cacah: number;
  nilai: Angka;
  labelCacah: string;
  jumlahBaris: number;
  jumlahKolom: number;
  judulBaris: string;
  judulKolom: string;
}) {
  return (
    <Panel as="h2" title="Total laporan">
      <ul className="ringkas-angka">
        <li className="ringkas-angka-item">
          <span className="ringkas-angka-label">Total seluruh matriks</span>
          <span className="ringkas-angka-baris">
            <span className="ringkas-angka-key">Nilai</span>
            <Nilai angka={nilai} />
          </span>
          <span className="ringkas-angka-baris">
            <span className="ringkas-angka-key">
              {labelCacah.charAt(0).toUpperCase() + labelCacah.slice(1)}
            </span>
            <span className="angka">{formatCount(cacah)}</span>
          </span>
        </li>
        <li className="ringkas-angka-item">
          <span className="ringkas-angka-label">Ukuran matriks</span>
          <span className="ringkas-angka-baris">
            <span className="ringkas-angka-key">{judulBaris}</span>
            <span className="angka">{formatCount(jumlahBaris)}</span>
          </span>
          <span className="ringkas-angka-baris">
            <span className="ringkas-angka-key">{judulKolom}</span>
            <span className="angka">{formatCount(jumlahKolom)}</span>
          </span>
        </li>
      </ul>
    </Panel>
  );
}

function Catatan({ children }: { children: ReactNode }) {
  return (
    <p className="page-note">
      <Icon name="info" size={16} />
      <span>{children}</span>
    </p>
  );
}

// ===========================================================================
// 3. Laporan Penyaluran Nasional
// ===========================================================================

export function PenyaluranNasionalPage({ route }: { route: PageRoute }) {
  const mode = useModeLaporan();
  const filter = useFilterLaporan({ tambahan: mode.kontrol, ringkasTambahan: mode.ringkas });

  const hasil = useApi(
    () =>
      penyaluranNasional({
        periodeId: filter.periodeId ?? "",
        cabangId: filter.cabangId,
        mode: mode.mode,
      }),
    [filter.periodeId, filter.cabangId, mode.mode],
    { enabled: filter.siap && filter.periodeId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="laporan penyaluran nasional"
      sumber="GET /api/laporan/penyaluran-nasional"
      crumb="Laporan Pendanaan UMK"
    >
      {(data: LaporanPenyaluranNasional) => (
        <>
          <KopLaporan header={data.header} />
          <Panel
            as="h2"
            title="Provinsi kali sektor"
            description={`${data.baris.length} provinsi dan ${data.kolom.length} sektor. Setiap sel memuat nilai penyaluran dan jumlah mitra.`}
          >
            <MatriksLaporan
              judulBaris="Provinsi"
              labelCacah="mitra"
              kolom={data.kolom.map((k) => ({
                key: k.sektorId ?? k.kode,
                label: `${k.kode} ${k.nama}`,
              }))}
              baris={data.baris.map((b) => ({
                key: b.provinsiId ?? b.provinsiNama,
                label: b.provinsiNama,
                sel: b.sel.map((s) => ({ nilai: s.nilai, cacah: s.jumlahMitra })),
                total: { nilai: b.total.nilai, cacah: b.total.jumlahMitra },
              }))}
              totalKolom={data.totalKolom.map((s) => ({ nilai: s.nilai, cacah: s.jumlahMitra }))}
              totalKeseluruhan={{
                nilai: data.totalKeseluruhan.nilai,
                cacah: data.totalKeseluruhan.jumlahMitra,
              }}
            />
          </Panel>
          <TotalMatriks
            cacah={data.totalKeseluruhan.jumlahMitra}
            nilai={data.totalKeseluruhan.nilai}
            labelCacah="mitra"
            jumlahBaris={data.baris.length}
            jumlahKolom={data.kolom.length}
            judulBaris="Provinsi"
            judulKolom="Sektor"
          />
          <Catatan>
            Provinsi dihitung dari alamat Mitra Binaan yang tercatat saat ini, bukan alamat pada
            saat akad ditandatangani. Jumlah mitra pada baris total tidak selalu sama dengan
            penjumlahan sel, karena satu mitra bisa punya akad di lebih dari satu sektor.
          </Catatan>
        </>
      )}
    </HalamanLaporan>
  );
}

// ===========================================================================
// 11. Laporan Perpindahan Kolektibilitas
// ===========================================================================

export function PerpindahanKolektibilitasPage({ route }: { route: PageRoute }) {
  const filter = useFilterLaporan();

  const hasil = useApi(
    () =>
      perpindahanKolektibilitas({
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
      judul="laporan perpindahan kolektibilitas"
      sumber="GET /api/laporan/perpindahan-kolektibilitas"
      crumb="Laporan Pendanaan UMK"
    >
      {(data: LaporanPerpindahanKolektibilitas) => (
        <>
          <KopLaporan header={data.header} />
          <Panel
            as="h2"
            title="Kelas periode lalu kali kelas periode ini"
            description="Baris adalah klasifikasi pada periode sebelumnya, kolom adalah klasifikasi pada periode yang dipilih. Setiap sel memuat outstanding pokok dan jumlah akad."
          >
            <MatriksLaporan
              judulBaris="Kelas periode lalu"
              labelCacah="akad"
              kolom={data.kolom.map((k) => ({ key: k.kode, label: k.nama }))}
              baris={data.baris.map((b) => ({
                key: b.kode,
                label: b.nama,
                sel: b.sel.map((s) => ({ nilai: s.outstandingPokok, cacah: s.jumlahAkad })),
                total: { nilai: b.total.outstandingPokok, cacah: b.total.jumlahAkad },
              }))}
              totalKolom={data.totalKolom.map((s) => ({
                nilai: s.outstandingPokok,
                cacah: s.jumlahAkad,
              }))}
              totalKeseluruhan={{
                nilai: data.totalKeseluruhan.outstandingPokok,
                cacah: data.totalKeseluruhan.jumlahAkad,
              }}
            />
          </Panel>
          <TotalMatriks
            cacah={data.totalKeseluruhan.jumlahAkad}
            nilai={data.totalKeseluruhan.outstandingPokok}
            labelCacah="akad"
            jumlahBaris={data.baris.length}
            jumlahKolom={data.kolom.length}
            judulBaris="Kelas asal"
            judulKolom="Kelas tujuan"
          />
          <Catatan>
            Baris paling atas adalah akad yang baru muncul pada periode ini dan belum punya
            klasifikasi periode sebelumnya, jadi barisnya bukan perpindahan melainkan penambahan.
            Sel di diagonal adalah akad yang kelasnya tidak berubah.
          </Catatan>
        </>
      )}
    </HalamanLaporan>
  );
}
