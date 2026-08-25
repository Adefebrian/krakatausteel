// Cluster Mitra Binaan, spec 9.1: manage the group, move members in and out,
// and read the collection quality of the group as a whole.
//
// Membership is DATED, not toggled: joining carries a date and leaving carries
// a date and a reason, so the roster can be read as it stood on any past day
// rather than only as it stands now. That is why removing a member is a
// confirmation step with a reason, and why a former member stays in the list
// with its exit date instead of disappearing.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
  Field,
  Panel,
  SearchInput,
  Stat,
  StatusBadge,
  TextInput,
  Textarea,
  formatCount,
  formatDate,
  formatMoney,
  formatTotal,
  type Column,
} from "@krakatausteel/ui";
import {
  anggotaCluster,
  cariMitra,
  daftarCluster,
  detailCluster,
  keluarkanAnggotaCluster,
  tambahAnggotaCluster,
  type BarisAnggotaCluster,
  type BarisCluster,
} from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  type ColumnSpec,
  DaftarDokumen,
  FieldGrid,
  HalamanModul,
  hariIni,
  Kolektibilitas,
  Muat,
  RingkasDokumen,
} from "../shared/parts";

const CLUSTER_COLUMNS: readonly ColumnSpec<BarisCluster>[] = [
  { key: "kode", header: "Kode", sortable: true, width: "120px" },
  { key: "nama", header: "Nama cluster", sortable: true },
  { key: "cabangNama", header: "Cabang", sortable: true, width: "170px" },
  { key: "jumlahAnggota", header: "Anggota", type: "count", sortable: true, width: "110px" },
  { key: "outstandingPokok", header: "Outstanding pokok", type: "money", sortable: true, width: "170px" },
];

const ANGGOTA_COLUMNS: readonly Column<BarisAnggotaCluster>[] = [
  { key: "mitraKode", header: "Kode mitra", width: "130px" },
  { key: "mitraNama", header: "Mitra Binaan" },
  { key: "tanggalMasuk", header: "Masuk", type: "date", width: "120px" },
  {
    key: "tanggalKeluar",
    header: "Keluar",
    width: "120px",
    render: (row) => (row.tanggalKeluar ? formatDate(row.tanggalKeluar) : "Masih anggota"),
  },
  {
    key: "kolektibilitas",
    header: "Kolektibilitas",
    width: "160px",
    render: (row) => <Kolektibilitas kelas={row.kolektibilitas} />,
  },
  { key: "outstandingPokok", header: "Outstanding", type: "money", width: "150px" },
];

export function ClusterList({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [cari, setCari] = useState("");

  const daftar = useApi(
    () => daftarCluster({ cabangId: session.cabang.id, cari: cari.trim() || null }),
    [session.cabang.id, cari],
  );

  return (
    <HalamanModul route={route}>
      <Panel
        as="h2"
        title="Daftar cluster"
        description="Cluster mengelompokkan Mitra Binaan untuk pembinaan bersama dan pemantauan kualitas piutang kelompok."
        footer={
          <span>
            {daftar.data
              ? `${formatCount(daftar.data.data.length)} cluster pada cabang Anda.`
              : "Memuat daftar cluster."}
          </span>
        }
      >
        <div className="cari-akad">
          <SearchInput
            label="Cari kode atau nama cluster"
            placeholder="Kode atau nama cluster"
            value={cari}
            onChange={(event) => setCari(event.currentTarget.value)}
          />
        </div>
        <Muat hasil={daftar} judul="daftar cluster" sumber="GET /api/pumk/cluster">
          {(data) =>
            data.data.length === 0 ? (
              <AntreanKosong
                icon="users"
                title="Belum ada cluster pada cabang ini"
                description="Cluster dibuat melalui master data cluster, lalu anggotanya dikelola di halaman ini."
              />
            ) : (
              <DaftarDokumen
                columns={CLUSTER_COLUMNS}
                rows={data.data}
                rowKey={(row) => row.id}
                onPilih={(row) => navigate(`/pumk/cluster/${row.id}`)}
                emptyTitle="Belum ada cluster"
                emptyDescription="Cluster dibuat melalui master data cluster."
                kartu={(row) => ({
                  judul: row.nama,
                  sub: `${row.kode} . ${row.cabangNama}`,
                  nilai: formatMoney(row.outstandingPokok),
                  nilaiLabel: "Outstanding",
                  meta: `${row.jumlahAnggota} anggota`,
                })}
              />
            )
          }
        </Muat>
      </Panel>
      <CatatanOtorisasi />
    </HalamanModul>
  );
}

export function ClusterDetail({ route, clusterId }: { route: PageRoute; clusterId: string }) {
  const session = useActiveSession();
  const cluster = useApi(() => detailCluster(clusterId), [clusterId]);
  const anggota = useApi(() => anggotaCluster(clusterId), [clusterId]);

  const [cari, setCari] = useState("");
  const [cariAktif, setCariAktif] = useState("");
  const [mitraId, setMitraId] = useState("");
  const [tanggalMasuk, setTanggalMasuk] = useState(hariIni());
  const [keluar, setKeluar] = useState<BarisAnggotaCluster | null>(null);
  const [tanggalKeluar, setTanggalKeluar] = useState(hariIni());
  const [alasan, setAlasan] = useState("");

  const kandidat = useApi(() => cariMitra(cariAktif, session.cabang.id), [cariAktif], {
    enabled: cariAktif.trim().length >= 3,
  });
  const tambah = useAction(tambahAnggotaCluster);
  const keluarkan = useAction(keluarkanAnggotaCluster);

  async function simpanAnggota(event: React.FormEvent) {
    event.preventDefault();
    if (mitraId === "" || tanggalMasuk === "") return;
    const hasil = await tambah.jalankan({ clusterId, mitraId, tanggalMasuk });
    if (hasil) {
      setMitraId("");
      setCariAktif("");
      setCari("");
      anggota.reload();
      cluster.reload();
    }
  }

  async function konfirmasiKeluar() {
    if (!keluar || alasan.trim() === "") return;
    const hasil = await keluarkan.jalankan({
      clusterId,
      mitraId: keluar.mitraId,
      tanggalKeluar,
      alasan: alasan.trim(),
    });
    if (hasil) {
      setKeluar(null);
      setAlasan("");
      anggota.reload();
      cluster.reload();
    }
  }

  return (
    <HalamanModul
      route={route}
      title={cluster.data ? `Cluster ${cluster.data.nama}` : route.title}
      sub={cluster.data ? `${cluster.data.kode} . ${cluster.data.cabangNama}` : route.summary}
      back={{ to: "/pumk/cluster", label: "Daftar cluster" }}
    >
      <Muat hasil={cluster} judul="data cluster" sumber={`GET /api/pumk/cluster/${clusterId}`}>
        {(data) => (
          <>
            <RingkasDokumen
              items={[
                { label: "Kode", value: data.kode },
                { label: "Cabang", value: data.cabangNama },
                { label: "Anggota aktif", value: formatCount(data.jumlahAnggota) },
                { label: "Outstanding pokok", value: formatMoney(data.outstandingPokok) },
              ]}
            />

            <Bento columns={4}>
              {data.komposisiKolektibilitas.map((baris) => (
                <BentoItem span="sm" key={baris.kelas}>
                  <Panel as="h2" title={`Kolektibilitas ${baris.kelas}`}>
                    <Stat
                      label="Outstanding pokok kelompok"
                      value={formatMoney(baris.outstandingPokok)}
                      hint={`${formatCount(baris.jumlahAkad)} akad`}
                      aside={<Kolektibilitas kelas={baris.kelas} />}
                    />
                  </Panel>
                </BentoItem>
              ))}
              {data.komposisiKolektibilitas.length === 0 ? (
                <BentoItem span="lg">
                  <Panel as="h2" title="Performa kolektibilitas">
                    <p className="penjelasan">
                      Belum ada akad aktif pada anggota cluster ini, jadi belum ada komposisi
                      kolektibilitas yang bisa ditampilkan.
                    </p>
                  </Panel>
                </BentoItem>
              ) : null}
            </Bento>
          </>
        )}
      </Muat>

      <Panel
        as="h2"
        title="Anggota cluster"
        description="Anggota yang sudah keluar tetap tampil beserta tanggal keluarnya, sehingga riwayat keanggotaan tidak hilang."
        footer={
          <span>
            Total outstanding anggota{" "}
            {formatTotal((anggota.data?.data ?? []).map((row) => row.outstandingPokok))}.
          </span>
        }
      >
        <Muat
          hasil={anggota}
          judul="daftar anggota"
          sumber={`GET /api/pumk/cluster/${clusterId}/anggota`}
        >
          {(data) => (
            <DataTable
              columns={[
                ...ANGGOTA_COLUMNS,
                {
                  key: "aksi",
                  header: "Aksi",
                  width: "150px",
                  render: (row: BarisAnggotaCluster) =>
                    row.tanggalKeluar ? (
                      "Sudah keluar"
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setKeluar(row)}>
                        Keluarkan
                      </Button>
                    ),
                },
              ]}
              rows={data.data}
              rowKey={(row) => `${row.clusterId}-${row.mitraId}-${row.tanggalMasuk}`}
              caption="Keanggotaan cluster beserta tanggal masuk dan keluar"
              emptyTitle="Belum ada anggota pada cluster ini"
              emptyDescription="Tambahkan anggota melalui form di bawah."
            />
          )}
        </Muat>
      </Panel>

      <form onSubmit={simpanAnggota}>
        <Bagian
          title="Tambah anggota"
          description="Cari Mitra Binaan pada cabang ini, lalu tetapkan tanggal masuk keanggotaannya."
        >
          <div className="cari-mitra">
            <SearchInput
              label="Cari nama atau NIK Mitra Binaan"
              placeholder="Nama lengkap atau NIK"
              value={cari}
              onChange={(event) => setCari(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setCariAktif(cari);
                }
              }}
            />
            <Button variant="secondary" onClick={() => setCariAktif(cari)}>
              Cari
            </Button>
          </div>

          {cariAktif.trim().length >= 3 ? (
            <Muat hasil={kandidat} judul="hasil pencarian mitra" sumber="GET /api/pumk/mitra">
              {(data) =>
                data.data.length === 0 ? (
                  <p className="penjelasan">Tidak ada Mitra Binaan yang cocok pada cabang ini.</p>
                ) : (
                  <ul className="pilihan-list">
                    {data.data.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={mitraId === item.id ? "pilihan-btn is-active" : "pilihan-btn"}
                          onClick={() => setMitraId(item.id)}
                        >
                          <span className="pilihan-judul">{item.namaLengkap}</span>
                          <span className="pilihan-sub">
                            {item.kodeMitra}
                            {item.nik ? ` . NIK ${item.nik}` : ""}
                          </span>
                          <span className="pilihan-meta">
                            {item.clusterNama
                              ? `Sudah tergabung di cluster ${item.clusterNama}`
                              : "Belum tergabung di cluster mana pun"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Muat>
          ) : (
            <p className="penjelasan">Ketik minimal tiga huruf, lalu tekan Cari.</p>
          )}

          <FieldGrid columns={1}>
            <Field label="Tanggal masuk" htmlFor="tanggal-masuk" required>
              <TextInput
                id="tanggal-masuk"
                type="date"
                value={tanggalMasuk}
                onChange={(event) => setTanggalMasuk(event.currentTarget.value)}
              />
            </Field>
          </FieldGrid>
        </Bagian>

        <BarisAksi
          error={tambah.error}
          primary={
            <Button
              type="submit"
              variant="primary"
              disabled={mitraId === "" || tanggalMasuk === ""}
              loading={tambah.status === "mengirim"}
              loadingLabel="Menyimpan"
            >
              Tambahkan ke cluster
            </Button>
          }
        />
      </form>

      <ConfirmDialog
        open={keluar !== null}
        title="Keluarkan anggota dari cluster"
        description="Keanggotaan ditutup dengan tanggal keluar dan alasannya. Riwayat keanggotaan tetap tersimpan dan tidak dihapus."
        confirmLabel="Keluarkan anggota"
        tone="danger"
        loading={keluarkan.status === "mengirim"}
        error={keluarkan.error}
        onCancel={() => {
          setKeluar(null);
          setAlasan("");
        }}
        onConfirm={konfirmasiKeluar}
      >
        <DataList
          items={[
            { label: "Mitra Binaan", value: keluar?.mitraNama ?? "" },
            { label: "Kode mitra", value: keluar?.mitraKode ?? "" },
            {
              label: "Tanggal masuk",
              value: keluar ? formatDate(keluar.tanggalMasuk) : "",
            },
          ]}
        />
        <div className="konfirmasi-form">
          <Field label="Tanggal keluar" htmlFor="tanggal-keluar" required>
            <TextInput
              id="tanggal-keluar"
              type="date"
              value={tanggalKeluar}
              onChange={(event) => setTanggalKeluar(event.currentTarget.value)}
            />
          </Field>
          <Field label="Alasan keluar" htmlFor="alasan-keluar" required>
            <Textarea
              id="alasan-keluar"
              rows={2}
              value={alasan}
              onChange={(event) => setAlasan(event.currentTarget.value)}
            />
          </Field>
        </div>
      </ConfirmDialog>

      <CatatanOtorisasi />
    </HalamanModul>
  );
}
