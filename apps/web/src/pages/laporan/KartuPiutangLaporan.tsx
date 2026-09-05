// 9. Kartu Piutang Mitra Binaan, spec 10.1.
//
// PER DOCUMENT, NOT PER PERIOD, which is why it has its own screen. Every other
// report answers "what happened in this month"; this one answers "what has this
// one mitra owed and paid, from the first akad to now", and the answer is a set
// of akad each carrying its own schedule and its own receipts. There is no
// column list that could have declared that through ./generik.tsx.
//
// IT TAKES A MITRA, SO IT ASKS FOR ONE FIRST. The report is not requested at
// all until a mitra is chosen, and the chosen mitra lives in the query string
// so a card a colleague is asked to check opens on the same mitra when the link
// is pasted.
//
// AND IT SHOWS ITS OWN RECONCILIATION. The API returns TWO outstanding figures
// per akad -- the one the akad record carries and the one the card's own rows
// add up to -- plus their difference. Both are printed. A card that showed only
// one of them would look right in exactly the case where the ledger and the
// schedule have drifted apart, which is the case the report exists to catch.
import { useState } from "react";
import {
  Button,
  DataList,
  DataTable,
  Icon,
  Panel,
  SearchInput,
  StatusBadge,
  formatCount,
  formatDate,
  type Column,
} from "@krakatausteel/ui";
import { cariMitra, type RingkasanMitra } from "../../api/pumk";
import {
  kartuPiutangLaporan,
  type BarisJadwalKartu,
  type BarisSetoranKartu,
  type KartuAkad,
  type LaporanKartuPiutang,
} from "../../api/laporan-operasional";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { AntreanKosong, DaftarDokumen } from "../shared/parts";
import { HalamanLaporan, KopLaporan, Nilai, teksNilai, useFilterLaporan } from "./parts";

export function KartuPiutangLaporanPage({ route }: { route: PageRoute }) {
  const { query, setQuery } = useRouter();
  const mitraId = query.get("mitra");
  const filter = useFilterLaporan();

  const hasil = useApi(
    () =>
      kartuPiutangLaporan({
        periodeId: filter.periodeId ?? "",
        cabangId: filter.cabangId,
        mitraId: mitraId ?? "",
      }),
    [filter.periodeId, filter.cabangId, mitraId],
    { enabled: filter.siap && filter.periodeId !== null && mitraId !== null },
  );

  return (
    <HalamanLaporan
      route={route}
      filter={filter}
      hasil={hasil}
      judul="kartu piutang mitra binaan"
      sumber="GET /api/laporan/kartu-piutang"
      crumb="Laporan Pendanaan UMK"
      diamLabel="Pilih Mitra Binaan terlebih dahulu untuk membuka kartu piutangnya."
      aksi={
        mitraId ? (
          <Button variant="secondary" onClick={() => setQuery("mitra", null)}>
            Ganti Mitra Binaan
          </Button>
        ) : undefined
      }
      sebelum={
        mitraId ? null : <PemilihMitra onPilih={(mitra) => setQuery("mitra", mitra.id)} />
      }
    >
      {(data: LaporanKartuPiutang) => <BadanKartu data={data} />}
    </HalamanLaporan>
  );
}

// ---------------------------------------------------------------------------
// Choosing the mitra
// ---------------------------------------------------------------------------

const KOLOM_MITRA: readonly Column<RingkasanMitra>[] = [
  { key: "kodeMitra", header: "Kode mitra", width: "140px" },
  { key: "namaLengkap", header: "Nama Mitra Binaan" },
  {
    key: "namaUsaha",
    header: "Nama usaha",
    render: (row) => <span className="sel-ringkas">{row.namaUsaha ?? "Tidak diisi"}</span>,
  },
  {
    key: "kotaNama",
    header: "Kota",
    width: "180px",
    render: (row) => row.kotaNama ?? "Tidak diisi",
  },
  {
    key: "jumlahPinjamanAktif",
    header: "Pinjaman aktif",
    type: "count",
    width: "150px",
  },
];

function PemilihMitra({ onPilih }: { onPilih: (mitra: RingkasanMitra) => void }) {
  const [cari, setCari] = useState("");
  const cariAktif = cari.trim();

  // Two characters is the floor the other mitra searches in this product use.
  // Below it the list is the whole book of mitra and answers nothing.
  const hasil = useApi(() => cariMitra(cariAktif), [cariAktif], {
    enabled: cariAktif.length >= 2,
  });

  const baris = hasil.data?.data ?? [];

  return (
    <Panel
      as="h2"
      title="Pilih Mitra Binaan"
      description="Kartu piutang selalu untuk satu mitra, jadi laporan belum diminta ke server sebelum mitranya dipilih."
    >
      <div className="cari-mitra">
        <SearchInput
          label="Cari Mitra Binaan"
          placeholder="Ketik kode mitra, nama, atau NIK"
          value={cari}
          onChange={(event) => setCari(event.currentTarget.value)}
        />
      </div>

      {cariAktif.length < 2 ? (
        <AntreanKosong
          icon="search"
          title="Ketik minimal dua huruf"
          description="Pencarian dimulai setelah dua huruf, supaya hasilnya benar benar menyempit dan bukan seluruh daftar mitra."
        />
      ) : hasil.status === "memuat" ? (
        <p className="muat-memuat" role="status">
          Mencari Mitra Binaan.
        </p>
      ) : hasil.status === "gagal" ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{hasil.error}</span>
        </p>
      ) : (
        <DaftarDokumen
          columns={KOLOM_MITRA}
          rows={baris}
          rowKey={(row) => row.id}
          onPilih={onPilih}
          kartu={(row) => ({
            judul: `${row.kodeMitra} ${row.namaLengkap}`,
            sub: row.namaUsaha ?? "Nama usaha belum diisi",
            meta: row.kotaNama ?? "Kota belum diisi",
            nilai: `${formatCount(row.jumlahPinjamanAktif)}`,
            nilaiLabel: "Pinjaman aktif",
          })}
          emptyTitle="Tidak ada mitra yang cocok"
          emptyDescription="Ubah kata pencarian, atau periksa kembali kode mitra yang dicari."
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The card itself
// ---------------------------------------------------------------------------

function BadanKartu({ data }: { data: LaporanKartuPiutang }) {
  return (
    <>
      <KopLaporan header={data.header} />

      <Panel
        as="h2"
        title={`${data.kodeMitra} ${data.namaMitra}`}
        description={`${data.akad.length} akad tercatat untuk mitra ini sampai akhir periode yang dipilih.`}
      >
        <ul className="ringkas-angka">
          <li className="ringkas-angka-item">
            <span className="ringkas-angka-label">Pokok dicairkan</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Nilai</span>
              <Nilai angka={data.total.pokokDicairkan} />
            </span>
          </li>
          <li className="ringkas-angka-item">
            <span className="ringkas-angka-label">Pokok sudah dibayar</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Nilai</span>
              <Nilai angka={data.total.totalPokokDibayar} />
            </span>
          </li>
          <li className="ringkas-angka-item">
            <span className="ringkas-angka-label">Outstanding pokok</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Menurut akad</span>
              <Nilai angka={data.total.outstandingPokokAkad} />
            </span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Menurut kartu</span>
              <Nilai angka={data.total.outstandingPokokKartu} />
            </span>
          </li>
          <li className="ringkas-angka-item">
            <span className="ringkas-angka-label">Selisih kedua angka</span>
            <span className="ringkas-angka-baris">
              <span className="ringkas-angka-key">Nilai</span>
              <Nilai angka={data.total.selisihOutstandingPokok} />
            </span>
          </li>
        </ul>
      </Panel>

      {data.akad.length === 0 ? (
        <Panel as="h2" title="Akad">
          <AntreanKosong
            title="Mitra ini belum punya akad"
            description="Tidak ada akad PUMK atas nama mitra ini sampai akhir periode yang dipilih, jadi tidak ada jadwal maupun setoran yang bisa ditampilkan."
          />
        </Panel>
      ) : (
        data.akad.map((akad) => <KartuSatuAkad key={akad.akadId} akad={akad} />)
      )}

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Outstanding menurut akad dibaca dari catatan akad itu sendiri, sedangkan outstanding
          menurut kartu dihitung ulang dari jadwal dan setoran di bawahnya. Selisih selain nol
          berarti kedua catatan itu berbeda dan perlu ditelusuri, bukan dipilih salah satunya.
        </span>
      </p>
    </>
  );
}

const KOLOM_JADWAL: readonly Column<BarisJadwalKartu>[] = [
  { key: "angsuranKe", header: "Angsuran ke", type: "count", width: "130px" },
  { key: "tanggalJatuhTempo", header: "Jatuh tempo", type: "date", width: "140px" },
  {
    key: "pokok",
    header: "Pokok",
    type: "money",
    width: "150px",
    render: (row) => <Nilai angka={row.pokok} />,
  },
  {
    key: "jasaAdm",
    header: "Jasa administrasi",
    type: "money",
    width: "160px",
    render: (row) => <Nilai angka={row.jasaAdm} />,
  },
  {
    key: "total",
    header: "Total",
    type: "money",
    width: "150px",
    render: (row) => <Nilai angka={row.total} />,
  },
  {
    key: "pokokTerbayar",
    header: "Pokok terbayar",
    type: "money",
    width: "160px",
    render: (row) => <Nilai angka={row.pokokTerbayar} />,
  },
  {
    key: "jasaTerbayar",
    header: "Jasa terbayar",
    type: "money",
    width: "160px",
    render: (row) => <Nilai angka={row.jasaTerbayar} />,
  },
  {
    key: "status",
    header: "Status",
    width: "150px",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "tanggalLunas",
    header: "Tanggal lunas",
    width: "150px",
    render: (row) =>
      row.tanggalLunas === null ? (
        <span className="sel-kosong">Belum lunas</span>
      ) : (
        formatDate(row.tanggalLunas)
      ),
  },
];

const KOLOM_SETORAN: readonly Column<BarisSetoranKartu>[] = [
  { key: "tanggalTerima", header: "Tanggal terima", type: "date", width: "150px" },
  {
    key: "jumlahDiterima",
    header: "Jumlah diterima",
    type: "money",
    width: "170px",
    render: (row) => <Nilai angka={row.jumlahDiterima} />,
  },
  {
    key: "pokok",
    header: "Alokasi pokok",
    type: "money",
    width: "160px",
    render: (row) => <Nilai angka={row.pokok} />,
  },
  {
    key: "jasaAdm",
    header: "Alokasi jasa",
    type: "money",
    width: "150px",
    render: (row) => <Nilai angka={row.jasaAdm} />,
  },
  {
    key: "kelebihan",
    header: "Kelebihan",
    type: "money",
    width: "150px",
    render: (row) => <Nilai angka={row.kelebihan} />,
  },
  {
    key: "saldoPokokBerjalan",
    header: "Saldo pokok berjalan",
    type: "money",
    width: "190px",
    render: (row) => <Nilai angka={row.saldoPokokBerjalan} />,
  },
  {
    key: "noBukti",
    header: "No bukti",
    width: "150px",
    render: (row) => row.noBukti ?? <span className="sel-kosong">Tidak ada</span>,
  },
];

function KartuSatuAkad({ akad }: { akad: KartuAkad }) {
  return (
    <Panel
      as="h2"
      title={akad.noAkad}
      description={`Akad tanggal ${formatDate(akad.tanggalAkad)}, ${akad.jadwal.length} baris jadwal dan ${akad.setoran.length} setoran.`}
      aside={<StatusBadge status={akad.status} />}
    >
      <DataList
        columns={2}
        items={[
          { label: "Pokok pinjaman", value: <Nilai angka={akad.pokokPinjaman} />, numeric: true },
          { label: "Pokok dicairkan", value: <Nilai angka={akad.pokokDicairkan} />, numeric: true },
          {
            label: "Pokok sudah dibayar",
            value: <Nilai angka={akad.totalPokokDibayar} />,
            numeric: true,
          },
          {
            label: "Jasa sudah dibayar",
            value: <Nilai angka={akad.totalJasaDibayar} />,
            numeric: true,
          },
          { label: "Kelebihan bayar", value: <Nilai angka={akad.totalKelebihan} />, numeric: true },
          {
            label: "Outstanding jasa menurut akad",
            value: <Nilai angka={akad.outstandingJasaAkad} />,
            numeric: true,
          },
          {
            label: "Outstanding pokok menurut akad",
            value: <Nilai angka={akad.outstandingPokokAkad} />,
            numeric: true,
          },
          {
            label: "Outstanding pokok menurut kartu",
            value: <Nilai angka={akad.outstandingPokokKartu} />,
            numeric: true,
          },
          {
            label: "Selisih kedua angka",
            value: <Nilai angka={akad.selisihOutstandingPokok} />,
            numeric: true,
            wide: true,
          },
        ]}
      />

      <h3 className="kartu-bagian-judul">Jadwal angsuran</h3>
      <div className="daftar-tabel">
        <DataTable
          columns={KOLOM_JADWAL}
          rows={akad.jadwal}
          rowKey={(row) => row.jadwalId}
          emptyTitle="Belum ada jadwal"
          emptyDescription="Akad ini belum punya jadwal angsuran yang dibentuk."
        />
      </div>
      <div className="daftar-kartu">
        {akad.jadwal.length === 0 ? (
          <AntreanKosong
            title="Belum ada jadwal"
            description="Akad ini belum punya jadwal angsuran yang dibentuk."
          />
        ) : (
          <ul className="kartu-list">
            {akad.jadwal.map((row) => (
              <li className="kartu-item" key={row.jadwalId}>
                <div className="kartu-btn is-statis">
                  <span className="kartu-head">
                    <span className="kartu-judul">Angsuran ke {formatCount(row.angsuranKe)}</span>
                    <StatusBadge status={row.status} />
                  </span>
                  <span className="kartu-sub">
                    Jatuh tempo {formatDate(row.tanggalJatuhTempo)}, terbayar{" "}
                    {teksNilai(row.pokokTerbayar)}
                  </span>
                  <span className="kartu-foot">
                    <span className="kartu-meta">
                      {row.tanggalLunas === null
                        ? "Belum lunas"
                        : `Lunas ${formatDate(row.tanggalLunas)}`}
                    </span>
                    <span className="kartu-nilai">
                      <span className="kartu-nilai-label">Total angsuran</span>
                      <span className="kartu-nilai-val">{teksNilai(row.total)}</span>
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h3 className="kartu-bagian-judul">Setoran yang diterima</h3>
      <div className="daftar-tabel">
        <DataTable
          columns={KOLOM_SETORAN}
          rows={akad.setoran}
          rowKey={(row) => row.angsuranId}
          emptyTitle="Belum ada setoran"
          emptyDescription="Belum ada angsuran yang diterima atas akad ini sampai akhir periode yang dipilih."
        />
      </div>
      <div className="daftar-kartu">
        {akad.setoran.length === 0 ? (
          <AntreanKosong
            title="Belum ada setoran"
            description="Belum ada angsuran yang diterima atas akad ini sampai akhir periode yang dipilih."
          />
        ) : (
          <ul className="kartu-list">
            {akad.setoran.map((row) => (
              <li className="kartu-item" key={row.angsuranId}>
                <div className="kartu-btn is-statis">
                  <span className="kartu-head">
                    <span className="kartu-judul">{formatDate(row.tanggalTerima)}</span>
                  </span>
                  <span className="kartu-sub">
                    Pokok {teksNilai(row.pokok)}, jasa {teksNilai(row.jasaAdm)}
                  </span>
                  <span className="kartu-foot">
                    <span className="kartu-meta">
                      {row.noBukti ? `Bukti ${row.noBukti}` : "Tanpa nomor bukti"}
                    </span>
                    <span className="kartu-nilai">
                      <span className="kartu-nilai-label">Diterima</span>
                      <span className="kartu-nilai-val">{teksNilai(row.jumlahDiterima)}</span>
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
