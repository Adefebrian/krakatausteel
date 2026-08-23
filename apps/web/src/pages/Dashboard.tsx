// Dashboard, spec section 11. Fase 0 builds the layout and the drill down
// wiring; the figures arrive with the engines that produce them.
//
// No placeholder numbers are printed anywhere on this page on purpose. A KPI
// card shows what the figure means and which report it drills into, because an
// invented number on an accounting dashboard is worse than an absent one.
import { Bento, BentoItem, DataTable, Panel, type Column } from "@krakatausteel/ui";
import { Link } from "../router";
import { reportPath } from "../reports";
import { useActiveSession } from "../session";

interface Kpi {
  label: string;
  definisi: string;
  drillLabel: string;
  drillPath: string;
}

const KPI: readonly Kpi[] = [
  {
    label: "Outstanding Piutang PUMK",
    definisi: "Saldo pokok berjalan seluruh akad aktif, bersih setelah penyisihan.",
    drillLabel: "Laporan Aging Piutang",
    drillPath: reportPath("aging-piutang"),
  },
  {
    label: "Realisasi Penyaluran PUMK",
    definisi: "Nilai pencairan kumulatif tahun berjalan terhadap target RKA PUMK.",
    drillLabel: "Rekap Realisasi PUMK",
    drillPath: reportPath("rekap-realisasi-pumk"),
  },
  {
    label: "Realisasi Penyaluran Non PUMK",
    definisi: "Nilai penyaluran hibah kumulatif tahun berjalan terhadap target RKA Non PUMK.",
    drillLabel: "Penyaluran Non PUMK",
    drillPath: reportPath("penyaluran-non-pumk"),
  },
  {
    label: "Mitra Binaan Aktif",
    definisi: "Jumlah Mitra Binaan dengan akad berstatus aktif pada akhir periode.",
    drillLabel: "Demografi Mitra Binaan",
    drillPath: reportPath("demografi-mitra"),
  },
  {
    label: "Rasio Kolektibilitas Lancar",
    definisi: "Outstanding berklasifikasi Lancar dibagi total outstanding piutang.",
    drillLabel: "Laporan Kolektibilitas",
    drillPath: reportPath("kolektibilitas"),
  },
  {
    label: "Efektivitas Penyaluran",
    definisi: "Realisasi penyaluran dibagi anggaran RKA yang disetujui.",
    drillLabel: "RKA versus Realisasi",
    drillPath: reportPath("rka-vs-realisasi"),
  },
  {
    label: "Tingkat Pengembalian",
    definisi: "Kumulatif angsuran diterima dibagi kumulatif angsuran jatuh tempo.",
    drillLabel: "Penerimaan Angsuran",
    drillPath: reportPath("penerimaan-angsuran"),
  },
  {
    label: "Saldo Kas dan Setara Kas",
    definisi: "Saldo akun berflag kas pada Laporan Posisi Keuangan periode berjalan.",
    drillLabel: "Laporan Posisi Keuangan",
    drillPath: reportPath("laporan-posisi-keuangan"),
  },
];

interface PanelSpec {
  title: string;
  description: string;
  span: "sm" | "wide";
  drillLabel: string;
  drillPath: string;
}

const PANELS: readonly PanelSpec[] = [
  {
    title: "Realisasi versus RKA per bulan",
    description:
      "Batang realisasi penyaluran per bulan dengan garis anggaran RKA sebagai pembanding.",
    span: "wide",
    drillLabel: "RKA versus Realisasi",
    drillPath: reportPath("rka-vs-realisasi"),
  },
  {
    title: "Komposisi penyaluran per sektor",
    description: "Porsi nilai penyaluran PUMK per sektor usaha pada periode berjalan.",
    span: "sm",
    drillLabel: "Penyaluran per Sektor",
    drillPath: reportPath("realisasi-penyaluran-sektor"),
  },
  {
    title: "Komposisi kolektibilitas",
    description: "Proporsi Lancar, Kurang Lancar, Diragukan, dan Macet atas outstanding piutang.",
    span: "sm",
    drillLabel: "Laporan Kolektibilitas",
    drillPath: reportPath("kolektibilitas"),
  },
  {
    title: "Tren outstanding dan kolektibilitas 12 bulan",
    description: "Pergerakan outstanding piutang dan kualitasnya sepanjang dua belas periode.",
    span: "wide",
    drillLabel: "Perpindahan Kolektibilitas",
    drillPath: reportPath("perpindahan-kolektibilitas"),
  },
  {
    title: "Distribusi Non PUMK per bidang dan SDG",
    description: "Sebaran program hibah menurut bidang Non PUMK dan tujuan SDG yang dipetakan.",
    span: "sm",
    drillLabel: "Pemetaan SDGs",
    drillPath: reportPath("pemetaan-sdgs"),
  },
  {
    title: "Jatuh tempo 30 hari ke depan",
    description: "Angsuran yang akan jatuh tempo dalam tiga puluh hari, per Mitra Binaan.",
    span: "sm",
    drillLabel: "Laporan Jatuh Tempo",
    drillPath: reportPath("jatuh-tempo"),
  },
  {
    title: "Penyaluran per provinsi",
    description:
      "Tabel penyaluran per provinsi beserta jumlah mitra, sebagai dasar pemetaan wilayah.",
    span: "wide",
    drillLabel: "Penyaluran Nasional",
    drillPath: reportPath("penyaluran-nasional"),
  },
  {
    title: "Mitra bermasalah",
    description: "Akad Diragukan dan Macet yang menunggu tindak lanjut penagihan.",
    span: "sm",
    drillLabel: "Mitra Bermasalah",
    drillPath: "/pumk/mitra-bermasalah",
  },
  {
    title: "Status closing periode berjalan",
    description: "Checklist prasyarat closing beserta kondisi yang belum terpenuhi.",
    span: "sm",
    drillLabel: "Closing Periode",
    drillPath: "/admin/closing-periode",
  },
];

interface AntrianRow {
  jenis: string;
  dokumen: string;
  jumlah: number;
  umurHari: number;
}

const ANTRIAN_COLUMNS: readonly Column<AntrianRow>[] = [
  { key: "jenis", header: "Jenis antrean", sortable: true },
  { key: "dokumen", header: "Dokumen", sortable: true },
  { key: "jumlah", header: "Jumlah", type: "count", sortable: true, width: "120px" },
  { key: "umurHari", header: "Umur tertua (hari)", type: "count", sortable: true, width: "160px" },
];

export function Dashboard() {
  const session = useActiveSession();

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">
          Ringkasan program untuk {session.cabang.nama}. Setiap angka pada halaman ini bisa diklik
          untuk menelusuri sampai data sumbernya.
        </p>
      </header>

      <section className="band" aria-labelledby="band-kpi">
        <div className="band-head">
          <h2 className="band-title" id="band-kpi">
            Indikator utama
          </h2>
          <p className="band-note">
            Angka terisi setelah engine jurnal dan engine angsuran aktif. Sampai saat itu setiap
            kartu menerangkan definisi dan tujuan penelusurannya.
          </p>
        </div>
        <Bento columns={4}>
          {KPI.map((kpi) => (
            <BentoItem span="sm" key={kpi.label}>
              <Panel
                title={kpi.label}
                description={kpi.definisi}
                footer={
                  <Link className="panel-link" to={kpi.drillPath}>
                    {kpi.drillLabel}
                  </Link>
                }
              />
            </BentoItem>
          ))}
        </Bento>
      </section>

      <section className="band" aria-labelledby="band-antrian">
        <div className="band-head">
          <h2 className="band-title" id="band-antrian">
            Antrean Kerja Saya
          </h2>
          <p className="band-note">
            Dokumen yang menunggu aksi {session.user.nama}, dipisah per jenis antrean.
          </p>
        </div>
        <DataTable
          columns={ANTRIAN_COLUMNS}
          rows={[] as AntrianRow[]}
          emptyTitle="Belum ada dokumen yang menunggu aksi Anda"
          emptyDescription="Antrean terisi begitu modul PUMK dan Non PUMK mulai memproses dokumen."
        />
      </section>

      <section className="band" aria-labelledby="band-panel">
        <div className="band-head">
          <h2 className="band-title" id="band-panel">
            Panel monitoring
          </h2>
          <p className="band-note">
            Sembilan panel sesuai spesifikasi dashboard, masing masing menelusuri ke laporan atau
            daftar data sumbernya.
          </p>
        </div>
        <Bento columns={4}>
          {PANELS.map((panel) => (
            <BentoItem span={panel.span} key={panel.title}>
              <Panel
                title={panel.title}
                description={panel.description}
                footer={
                  <Link className="panel-link" to={panel.drillPath}>
                    {panel.drillLabel}
                  </Link>
                }
              />
            </BentoItem>
          ))}
        </Bento>
      </section>
    </div>
  );
}
