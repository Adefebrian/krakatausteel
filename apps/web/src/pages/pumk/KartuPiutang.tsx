// Kartu Piutang Mitra Binaan, spec 9.1: "halaman yang paling sering dibuka
// petugas, buat sebaik mungkin".
//
// Everything about one receivable on one page, in the order a person actually
// asks for it: how much is still owed, whether the sub ledger agrees with the
// general ledger, what the schedule says, what has been paid, how the quality
// of the debt has moved, and what is being done about it.
//
// The reconciliation figure is on the FIRST screen, not buried: spec 8.4 check
// 10 requires `outstanding.pokok - saldoBukuBesar` to be exactly zero, so the
// page prints it and says out loud when it is not. A kartu piutang that hides
// a broken reconciliation is worse than no kartu piutang.
import {
  Bento,
  BentoItem,
  Button,
  DataList,
  DataTable,
  Icon,
  Panel,
  Stat,
  StatusBadge,
  formatCount,
  formatDate,
  formatMoney,
  formatRate,
  formatTotal,
  type Column,
} from "@krakatausteel/ui";
import { kartuPiutang, type BarisAkad, type KartuPiutang as KartuPiutangData } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { Link, useRouter } from "../../router";
import { useActiveSession } from "../../session";
import { AkadPicker } from "./AkadPicker";
import { JadwalTabel } from "./JadwalTabel";
import { CatatanOtorisasi, Kolektibilitas, Muat, PumkPage, RingkasDokumen } from "./parts";

type Setoran = KartuPiutangData["setoran"][number];
type Kelebihan = KartuPiutangData["kelebihan"][number];
type RiwayatKol = KartuPiutangData["riwayatKolektibilitas"][number];

const SETORAN_COLUMNS: readonly Column<Setoran>[] = [
  { key: "tanggalTerima", header: "Tanggal", type: "date", sortable: true, width: "120px" },
  { key: "jumlahDiterima", header: "Diterima", type: "money", sortable: true },
  { key: "alokasiPokok", header: "Ke pokok", type: "money", sortable: true },
  { key: "alokasiJasa", header: "Ke Jasa Administrasi", type: "money", sortable: true },
  { key: "alokasiKelebihan", header: "Ke kelebihan", type: "money", sortable: true },
  {
    key: "jurnalId",
    header: "Jurnal",
    width: "130px",
    render: (row) =>
      row.jurnalId ? (
        <Link className="tautan-dokumen" to={`/jurnal?dokumen=${row.jurnalId}`}>
          Lihat jurnal
        </Link>
      ) : (
        "Belum berjurnal"
      ),
  },
];

const KELEBIHAN_COLUMNS: readonly Column<Kelebihan>[] = [
  { key: "tanggal", header: "Tanggal", type: "date", width: "120px" },
  { key: "jumlah", header: "Jumlah", type: "money" },
  {
    key: "status",
    header: "Status",
    width: "180px",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

const KOLEKTIBILITAS_COLUMNS: readonly Column<RiwayatKol>[] = [
  { key: "periodeId", header: "Periode", width: "160px" },
  {
    key: "kelas",
    header: "Klasifikasi",
    width: "180px",
    render: (row) => <Kolektibilitas kelas={row.kelas} />,
  },
  { key: "hariTunggakan", header: "Hari tunggakan", type: "count", width: "160px" },
];

export function KartuPiutangPicker({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  return (
    <PumkPage
      route={route}
      title="Kartu Piutang Mitra Binaan"
      sub="Cari akad untuk membuka kartu piutangnya: data mitra, jadwal, seluruh setoran, riwayat kolektibilitas, dan outstanding terkini pada satu halaman."
    >
      <AkadPicker
        title="Cari akad"
        description="Satu kartu piutang menampilkan satu akad. Mitra dengan lebih dari satu akad memiliki satu kartu untuk setiap akadnya."
        emptyTitle="Belum ada akad pada cabang ini"
        emptyDescription="Akad terbentuk setelah proposal disetujui dan realisasi akad dicatat."
        onPilih={(baris: BarisAkad) => navigate(`/pumk/kartu-piutang/${baris.id}`)}
      />
      <CatatanOtorisasi />
    </PumkPage>
  );
}

export function KartuPiutangPage({ route, akadId }: { route: PageRoute; akadId: string }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const kartu = useApi(() => kartuPiutang(akadId), [akadId]);

  return (
    <PumkPage
      route={route}
      title={
        kartu.data ? `Kartu Piutang ${kartu.data.mitra.namaLengkap}` : "Kartu Piutang Mitra Binaan"
      }
      sub={
        kartu.data
          ? `Akad ${kartu.data.akad.noAkad} . ${kartu.data.mitra.kodeMitra}`
          : route.summary
      }
      back={{ to: "/pumk/kartu-piutang", label: "Cari akad lain" }}
      actions={kartu.data ? <StatusBadge status={kartu.data.akad.status} /> : null}
    >
      <Muat hasil={kartu} judul="kartu piutang" sumber={`GET /api/pumk/kartu-piutang/${akadId}`}>
        {(data) => {
          const aktif = data.jadwal.find((item) => item.isActiveVersion) ?? data.jadwal[0] ?? null;
          const versiLain = data.jadwal.filter((item) => !item.isActiveVersion);
          const rekonsiliasiCocok = data.selisihRekonsiliasi === "0.00";
          const kolTerakhir = data.riwayatKolektibilitas.at(-1) ?? null;

          return (
            <>
              <RingkasDokumen
                items={[
                  { label: "Kode mitra", value: data.mitra.kodeMitra },
                  { label: "No akad", value: data.akad.noAkad },
                  { label: "Tanggal akad", value: formatDate(data.akad.tanggalAkad) },
                  {
                    label: "Kolektibilitas",
                    value: <Kolektibilitas kelas={kolTerakhir?.kelas ?? null} />,
                  },
                  { label: "Status mitra", value: <StatusBadge status={data.mitra.status} /> },
                ]}
              />

              <Bento columns={4}>
                <BentoItem span="sm">
                  <Panel as="h2" title="Outstanding pokok" className="panel-kpi">
                    <Stat
                      label="Sisa pokok pinjaman"
                      value={formatMoney(data.outstanding.pokok)}
                      hint={`Dari pokok ${formatMoney(data.akad.pokokPinjaman)}`}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Outstanding Jasa Administrasi" className="panel-kpi">
                    <Stat
                      label="Jasa yang belum diterima"
                      value={formatMoney(data.outstanding.jasa)}
                      hint={`Rate ${formatRate(data.akad.jasaAdmRate)} persen, ${data.akad.metodePerhitungan}`}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Saldo Buku Besar" className="panel-kpi">
                    <Stat
                      label="Akun piutang, jurnal POSTED"
                      value={formatMoney(data.saldoBukuBesar)}
                      hint="Dihitung dari ledger, bukan dari sub ledger."
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Selisih rekonsiliasi" className="panel-kpi">
                    <Stat
                      label="Sub ledger dikurangi Buku Besar"
                      value={formatMoney(data.selisihRekonsiliasi)}
                      hint={
                        rekonsiliasiCocok
                          ? "Nol. Sub ledger cocok dengan Buku Besar."
                          : "Tidak nol. Wajib ditelusuri sebelum closing periode."
                      }
                      aside={
                        <StatusBadge
                          status={rekonsiliasiCocok ? "COCOK" : "SELISIH"}
                          tone={rekonsiliasiCocok ? "success" : "danger"}
                          label={rekonsiliasiCocok ? "Cocok" : "Ada selisih"}
                        />
                      }
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              {rekonsiliasiCocok ? null : (
                <div className="peringatan" role="alert">
                  <Icon name="alert" size={18} />
                  <div>
                    <p className="peringatan-judul">Sub ledger tidak cocok dengan Buku Besar</p>
                    <p className="peringatan-teks">
                      Outstanding pokok pada akad berbeda {formatMoney(data.selisihRekonsiliasi)} dari
                      saldo akun piutang di Buku Besar. Telusuri melalui Tools Rekonsiliasi sebelum
                      periode ditutup. Angka pada halaman ini tetap ditampilkan apa adanya.
                    </p>
                  </div>
                </div>
              )}

              <Bento columns={2}>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Mitra Binaan"
                    footer={
                      <span>
                        {data.mitra.clusterId
                          ? "Mitra ini tergabung dalam sebuah cluster."
                          : "Mitra ini tidak tergabung dalam cluster."}
                      </span>
                    }
                  >
                    <DataList
                      items={[
                        { label: "Nama lengkap", value: data.mitra.namaLengkap },
                        { label: "Kode mitra", value: data.mitra.kodeMitra },
                        { label: "Status mitra", value: data.mitra.status },
                        {
                          label: "Kolektibilitas terakhir",
                          value: <Kolektibilitas kelas={kolTerakhir?.kelas ?? null} />,
                        },
                        {
                          label: "Hari tunggakan terakhir",
                          value: formatCount(kolTerakhir?.hariTunggakan ?? 0),
                          numeric: true,
                        },
                        {
                          label: "Jumlah setoran tercatat",
                          value: formatCount(data.setoran.length),
                          numeric: true,
                        },
                        {
                          label: "Total setoran diterima",
                          value: formatTotal(data.setoran.map((row) => row.jumlahDiterima)),
                          numeric: true,
                        },
                        {
                          label: "Kelebihan tertahan",
                          value: formatTotal(
                            data.kelebihan
                              .filter((row) => row.status === "TERTAHAN")
                              .map((row) => row.jumlah),
                          ),
                          numeric: true,
                        },
                        {
                          label: "Cluster",
                          value: data.mitra.clusterId ? (
                            <Link className="tautan-dokumen" to={`/pumk/cluster/${data.mitra.clusterId}`}>
                              Buka cluster
                            </Link>
                          ) : (
                            "Tidak ada"
                          ),
                        },
                      ]}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Syarat akad"
                    footer={<span>Perubahan syarat hanya melalui reschedule yang disetujui.</span>}
                  >
                    <DataList
                      items={[
                        { label: "No akad", value: data.akad.noAkad },
                        { label: "Pokok pinjaman", value: formatMoney(data.akad.pokokPinjaman), numeric: true },
                        {
                          label: "Rate Jasa Administrasi",
                          value: `${formatRate(data.akad.jasaAdmRate)} persen per tahun`,
                          numeric: true,
                        },
                        { label: "Metode", value: data.akad.metodePerhitungan },
                        { label: "Tenor", value: `${formatCount(data.akad.tenorBulan)} bulan`, numeric: true },
                        {
                          label: "Grace period",
                          value: `${formatCount(data.akad.gracePeriodBulan)} bulan`,
                          numeric: true,
                        },
                        { label: "Mulai angsuran", value: formatDate(data.akad.tanggalMulaiAngsuran) },
                        { label: "Jatuh tempo akhir", value: formatDate(data.akad.tanggalJatuhTempoAkhir) },
                      ]}
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Panel
                as="h2"
                title={aktif ? `Jadwal angsuran versi ${aktif.versi}` : "Jadwal angsuran"}
                description={
                  versiLain.length === 0
                    ? "Versi aktif. Belum pernah dilakukan reschedule pada akad ini."
                    : `Versi aktif. Terdapat ${versiLain.length} versi lama yang tetap tersimpan utuh.`
                }
                aside={
                  <Button variant="secondary" size="sm" onClick={() => navigate(`/pumk/jadwal?akad=${akadId}`)}>
                    Lihat semua versi
                  </Button>
                }
                footer={
                  <span>
                    Total pokok jadwal wajib sama dengan pokok pinjaman akad, yaitu{" "}
                    {formatMoney(data.akad.pokokPinjaman)}.
                  </span>
                }
              >
                {aktif ? (
                  <JadwalTabel baris={aktif.baris} caption="Jadwal angsuran versi aktif" />
                ) : (
                  <p className="penjelasan">
                    Akad ini belum memiliki jadwal angsuran. Jadwal dibentuk pada langkah generate
                    jadwal setelah akad dibuat.
                  </p>
                )}
              </Panel>

              <Panel
                as="h2"
                title="Seluruh setoran"
                description="Setiap penerimaan angsuran beserta alokasinya ke pokok, Jasa Administrasi, dan kelebihan pembayaran."
                footer={
                  <span>
                    Total diterima {formatTotal(data.setoran.map((row) => row.jumlahDiterima))}, ke
                    pokok {formatTotal(data.setoran.map((row) => row.alokasiPokok))}, ke Jasa
                    Administrasi {formatTotal(data.setoran.map((row) => row.alokasiJasa))}.
                  </span>
                }
              >
                <DataTable
                  columns={SETORAN_COLUMNS}
                  rows={data.setoran}
                  rowKey={(row) => row.id}
                  caption="Riwayat setoran akad ini"
                  emptyTitle="Belum ada setoran pada akad ini"
                  emptyDescription="Setoran tercatat melalui halaman Penerimaan Angsuran."
                />
              </Panel>

              <Bento columns={2}>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Kelebihan pembayaran"
                    footer={
                      <span>
                        Kelebihan ditahan sebagai kewajiban, tidak mengurangi piutang menjadi
                        negatif.
                      </span>
                    }
                  >
                    <DataTable
                      columns={KELEBIHAN_COLUMNS}
                      rows={data.kelebihan}
                      rowKey={(row) => row.id}
                      emptyTitle="Tidak ada kelebihan pembayaran"
                      emptyDescription="Seluruh setoran terserap ke kewajiban yang jatuh tempo."
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel
                    as="h2"
                    title="Riwayat kolektibilitas"
                    footer={
                      <span>
                        Klasifikasi ditetapkan pada closing kolektibilitas setiap periode, bukan
                        dihitung ulang di halaman ini.
                      </span>
                    }
                  >
                    <DataTable
                      columns={KOLEKTIBILITAS_COLUMNS}
                      rows={data.riwayatKolektibilitas}
                      rowKey={(row) => row.periodeId}
                      emptyTitle="Belum ada riwayat kolektibilitas"
                      emptyDescription="Riwayat terisi setelah closing kolektibilitas dijalankan."
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Panel
                as="h2"
                title="Tindakan atas akad ini"
                description="Hanya tindakan yang sesuai hak akses Anda yang dapat dibuka."
                footer={
                  <span>
                    Setiap tindakan tercatat pada audit trail beserta nama pelaku dan waktunya.
                  </span>
                }
              >
                <div className="aksi-list">
                  <Button
                    variant="secondary"
                    disabled={!hasPermission(session.permissions, "pumk.angsuran")}
                    onClick={() => navigate(`/pumk/angsuran?akad=${akadId}`)}
                  >
                    Catat penerimaan angsuran
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!hasPermission(session.permissions, "pumk.reschedule")}
                    onClick={() => navigate(`/pumk/reschedule?akad=${akadId}`)}
                  >
                    Ajukan reschedule
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!hasPermission(session.permissions, "pumk.penagihan")}
                    onClick={() => navigate(`/pumk/mitra-bermasalah?akad=${akadId}`)}
                  >
                    Catat tindak lanjut penagihan
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!hasPermission(session.permissions, "pumk.hapusbuku")}
                    onClick={() => navigate(`/pumk/pengakhiran?akad=${akadId}`)}
                  >
                    Pengakhiran atau hapus buku
                  </Button>
                  <Button variant="secondary" onClick={() => navigate(`/pumk/jadwal?akad=${akadId}`)}>
                    Jadwal seluruh versi
                  </Button>
                </div>
              </Panel>
            </>
          );
        }}
      </Muat>
      <CatatanOtorisasi tambahan="Kartu piutang cabang lain tidak dapat dibuka meskipun alamatnya diketik langsung." />
    </PumkPage>
  );
}
