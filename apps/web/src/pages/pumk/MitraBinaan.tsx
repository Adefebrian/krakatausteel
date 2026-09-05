// Mitra Binaan, spec 9.1. The roster of UMK borrowers, with their business
// profile and their standing.
//
// IT READS AND IT DOES NOT WRITE, AND THAT IS THE API's SHAPE RATHER THAN A
// CHOICE MADE HERE. `modules/pumk` exposes `GET /pumk/mitra` and
// `GET /pumk/mitra/:id` and no create, update or delete route: a mitra is
// created by the proposal flow and by the bulk import, both of which have their
// own screens and their own audit trail. So this page carries no "tambah mitra"
// button, and says where a mitra actually comes from instead of offering a
// control the server would refuse.
//
// THE LIST IS CAPPED AT FIFTY ROWS BY THE SERVER, and the page says so. A
// roster page that silently showed the first fifty of nine hundred mitra would
// have an operator concluding a mitra is not registered when they simply are
// not in the first fifty by name.
//
// MONEY AND COUNTS ARE NOT INTERCHANGEABLE HERE. `jumlahPinjamanAktif` is a
// COUNT of loans and prints through the count formatter;
// `outstandingPokok` is money and prints through the money formatter, and when
// it is null it prints words rather than the "tidak sah" marker, because a
// mitra with no loan legitimately has no outstanding.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  Icon,
  Panel,
  SearchInput,
  formatCount,
  formatMoney,
  formatTotal,
} from "@krakatausteel/ui";
import { cariMitra, detailMitra, type RingkasanMitra } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { Link } from "../../router";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  DaftarDokumen,
  HalamanModul,
  Kolektibilitas,
  Muat,
  Penyaring,
  useLayarKecil,
  useLingkupCabang,
  usePilihan,
  type ColumnSpec,
} from "../shared/parts";
import { KartuRingkas } from "../tools/parts";

/** The server's own ceiling on `GET /pumk/mitra`. */
const BATAS_DAFTAR_MITRA = 50;

const KOLOM: readonly ColumnSpec<RingkasanMitra>[] = [
  { key: "kodeMitra", header: "Kode mitra", sortable: true, width: "150px" },
  { key: "namaLengkap", header: "Nama lengkap", sortable: true },
  {
    key: "namaUsaha",
    header: "Nama usaha",
    render: (row) => row.namaUsaha ?? "tidak diisi",
  },
  {
    key: "sektorNama",
    header: "Sektor",
    width: "170px",
    render: (row) => row.sektorNama ?? "belum ditentukan",
  },
  {
    key: "kotaNama",
    header: "Kota",
    width: "160px",
    render: (row) => row.kotaNama ?? "tidak diisi",
  },
  { key: "jumlahPinjamanAktif", header: "Pinjaman aktif", type: "count", width: "140px" },
  {
    key: "outstandingPokok",
    header: "Outstanding pokok",
    type: "money",
    width: "180px",
    // ABSENT IS WORDS. A mitra with no active loan has no outstanding, and
    // sending that null through the money formatter would print "tidak sah" on
    // a perfectly ordinary row.
    render: (row) =>
      row.outstandingPokok === null ? "tidak ada pinjaman" : formatMoney(row.outstandingPokok),
  },
  {
    key: "kolektibilitasTerakhir",
    header: "Kolektibilitas",
    width: "160px",
    render: (row) => <Kolektibilitas kelas={row.kolektibilitasTerakhir} />,
  },
];

export function MitraBinaan({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const kecil = useLayarKecil();
  const lingkup = useLingkupCabang("Cabang");
  const [mitraId, setMitraId] = usePilihan("mitra");
  const [cari, setCari] = useState("");

  const daftar = useApi(
    () => cariMitra(cari.trim(), lingkup.cabangId ?? session.cabang.id),
    [cari, lingkup.cabangId],
  );
  const detail = useApi(() => detailMitra(mitraId ?? ""), [mitraId], {
    enabled: mitraId !== null,
  });

  const isiFilter = (
    <div className="filter-laporan">
      {lingkup.kontrol}
      <label className="filter-laporan-group is-lebar">
        <span className="filter-laporan-label">Cari nama, NIK, atau kode mitra</span>
        <SearchInput
          label="Cari Mitra Binaan berdasarkan nama, NIK, atau kode"
          value={cari}
          onChange={(event) => setCari(event.currentTarget.value)}
        />
      </label>
      <p className="filter-laporan-catatan">
        Server memotong daftar ini pada {formatCount(BATAS_DAFTAR_MITRA)} baris, urut nama. Gunakan
        pencarian bila mitra yang dicari belum terlihat, karena daftar yang terlihat bukan seluruh
        mitra pada cabang ini.
      </p>
    </div>
  );

  return (
    <HalamanModul route={route}>
      {kecil ? <Penyaring ringkas={lingkup.ringkas}>{isiFilter}</Penyaring> : isiFilter}

      <Muat hasil={daftar} judul="daftar Mitra Binaan" sumber="GET /api/pumk/mitra">
        {(data) => (
          <>
            <BandMitra rows={data.data} />
            <Panel
              as="h2"
              title="Mitra Binaan"
              description="Pilih satu baris untuk membuka profil mitra beserta riwayat pinjamannya."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/pumk/mitra. Kewenangan pumk.view, yang tidak memberi hak mengubah
                  data mitra.
                </span>
              }
            >
              <DaftarDokumen
                columns={KOLOM}
                rows={data.data}
                rowKey={(row) => row.id}
                kartu={(row) => ({
                  judul: row.namaLengkap,
                  sub: `${row.kodeMitra} . ${row.namaUsaha ?? "tanpa nama usaha"}`,
                  meta: row.kotaNama ?? "kota tidak diisi",
                  nilai:
                    row.outstandingPokok === null
                      ? undefined
                      : formatMoney(row.outstandingPokok),
                  nilaiLabel: "Outstanding pokok",
                  status: <Kolektibilitas kelas={row.kolektibilitasTerakhir} />,
                })}
                onPilih={(row) => setMitraId(row.id)}
                emptyTitle="Tidak ada Mitra Binaan yang cocok"
                emptyDescription="Ganti kata kunci pencarian, atau pilih cabang lain dalam wewenang Anda."
                caption="Daftar Mitra Binaan"
              />
            </Panel>
            {data.data.length >= BATAS_DAFTAR_MITRA ? (
              <p className="page-note">
                <Icon name="info" size={16} />
                <span>
                  Daftar dipotong server pada {formatCount(BATAS_DAFTAR_MITRA)} baris, jadi mitra
                  yang Anda cari bisa saja ada tetapi tidak tampil. Persempit dengan pencarian nama,
                  NIK, atau kode mitra.
                </span>
              </p>
            ) : null}
          </>
        )}
      </Muat>

      {mitraId === null ? null : (
        <Muat hasil={detail} judul="profil mitra" sumber={`GET /api/pumk/mitra/${mitraId}`}>
          {(data) => <ProfilMitra mitra={data} onTutup={() => setMitraId(null)} />}
        </Muat>
      )}

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Mitra Binaan tidak dibuat maupun diubah dari halaman ini, dan server memang tidak
          menyediakan jalurnya. Mitra baru masuk lewat alur proposal PUMK atau lewat Import Mitra
          Binaan, sehingga setiap penambahan punya jejak audit yang jelas.
        </span>
      </p>
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan pumk.view." />
    </HalamanModul>
  );
}

function BandMitra({ rows }: { rows: readonly RingkasanMitra[] }) {
  const berpinjaman = rows.filter((row) => row.jumlahPinjamanAktif > 0);
  const dalamCluster = rows.filter((row) => row.clusterId !== null);
  return (
    <Bento columns={4}>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Mitra tampil"
          nilai={formatCount(rows.length)}
          catatan="Jumlah mitra pada filter yang sedang aktif, bukan jumlah seluruh mitra pada entitas."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Punya pinjaman aktif"
          nilai={formatCount(berpinjaman.length)}
          catatan="Mitra dengan setidaknya satu akad yang masih berjalan pada daftar yang tampil."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Outstanding pokok tampil"
          nilai={formatTotal(
            rows.map((row) => row.outstandingPokok).filter((nilai) => nilai !== null),
          )}
          catatan="Penjumlahan outstanding pokok mitra yang tampil. Mitra tanpa pinjaman tidak menambah."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Tergabung cluster"
          nilai={formatCount(dalamCluster.length)}
          catatan="Mitra yang tercatat sebagai anggota satu cluster pada daftar yang tampil."
        />
      </BentoItem>
    </Bento>
  );
}

function ProfilMitra({ mitra, onTutup }: { mitra: RingkasanMitra; onTutup: () => void }) {
  const fakta: readonly { label: string; nilai: string }[] = [
    { label: "Kode mitra", nilai: mitra.kodeMitra },
    { label: "Nama lengkap", nilai: mitra.namaLengkap },
    { label: "NIK", nilai: mitra.nik ?? "tidak diisi" },
    { label: "Telepon", nilai: mitra.telepon ?? "tidak diisi" },
    { label: "Alamat", nilai: mitra.alamat ?? "tidak diisi" },
    { label: "Kota", nilai: mitra.kotaNama ?? "tidak diisi" },
    { label: "Nama usaha", nilai: mitra.namaUsaha ?? "tidak diisi" },
    { label: "Bidang usaha", nilai: mitra.bidangUsaha ?? "tidak diisi" },
    { label: "Sektor", nilai: mitra.sektorNama ?? "belum ditentukan" },
    { label: "Cluster", nilai: mitra.clusterNama ?? "tidak tergabung cluster" },
    { label: "Status mitra", nilai: mitra.status },
    { label: "Mitra lama", nilai: mitra.isMitraLama ? "ya, hasil migrasi" : "tidak" },
    { label: "Pinjaman aktif", nilai: formatCount(mitra.jumlahPinjamanAktif) },
    { label: "Pinjaman selesai", nilai: formatCount(mitra.jumlahPinjamanSelesai) },
    {
      label: "Outstanding pokok",
      nilai:
        mitra.outstandingPokok === null
          ? "tidak ada pinjaman berjalan"
          : formatMoney(mitra.outstandingPokok),
    },
  ];
  return (
    <Panel
      as="h2"
      title={`Profil ${mitra.namaLengkap}`}
      description="Data mitra apa adanya dari server, tanpa penyesuaian di halaman ini."
      aside={<Kolektibilitas kelas={mitra.kolektibilitasTerakhir} />}
      footer={
        <span className="panel-foot-note">
          Sumber: GET /api/pumk/mitra/{mitra.id}. Kewenangan pumk.view.
        </span>
      }
    >
      <dl className="fakta-grid">
        {fakta.map((item) => (
          <div className="fakta-item" key={item.label}>
            <dt className="fakta-key">{item.label}</dt>
            <dd className="fakta-val">{item.nilai}</dd>
          </div>
        ))}
      </dl>
      <div className="form-actions-row">
        <Link
          className="tautan-dokumen"
          to={`/pumk/kartu-piutang?mitra=${encodeURIComponent(mitra.id)}`}
        >
          Buka kartu piutang mitra ini
        </Link>
        <Button variant="ghost" onClick={onTutup}>
          Tutup profil
        </Button>
      </div>
    </Panel>
  );
}
