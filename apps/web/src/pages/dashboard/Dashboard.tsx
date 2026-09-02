// The landing screen, spec 11, driven by modules/dashboard.
//
// FIVE THINGS ABOUT THIS PAGE ARE STRUCTURAL, NOT COSMETIC.
//
//   IT IS ONE REQUEST. `GET /api/dashboard` answers every figure, both panels
//   and the closing checklist together, and this file makes exactly one such
//   call per period and branch scope. Eleven separate reads could straddle a
//   close and put a frozen KPI next to a live one on the same screen, which is
//   the single most common way a dashboard stops agreeing with the statements.
//   The only other read is the month picker, which is its own cheap route
//   precisely so a dropdown does not compute eleven metrics to fill itself.
//
//   EVERY FIGURE IS DRILLABLE. Spec 11: "Angka yang tidak bisa ditelusuri
//   asalnya tidak dipercaya user". Every card, every kolektibilitas row and
//   every queue row opens the records behind it, with their ids.
//
//   EVERY FIGURE NAMES ITS ARTEFACT. `sumberPeriode` says whether this month's
//   money was read frozen or live, once, above the cards; each card repeats the
//   artefact that answered IT, because they are not all the same. The
//   collection ratio in particular has no frozen artefact at all and says so
//   even for a closed month, rather than being quietly presented as if it had
//   been frozen with the rest.
//
//   AN ABSENT FIGURE IS A SENTENCE, NEVER A ZERO, and never the money
//   formatter's "tidak sah" marker either. See ./parts.tsx.
//
//   NOTHING ON THIS PAGE WRITES. The engine behind it takes no journal port and
//   no audit port, so there is no control here that could change a record.
import {
  Button,
  ErrorState,
  Icon,
  Panel,
  Select,
  StatusBadge,
  formatCount,
  formatDate,
  formatPeriode,
} from "@krakatausteel/ui";
import {
  daftarPeriodeDashboard,
  ringkasanDashboard,
  type BarisAntrian,
  type BarisKolektibilitas,
  type BarisPrasyaratDashboard,
  type Metrik,
  type PeriodeDashboard,
  type RingkasanDashboard,
} from "../../api/dashboard";
import { useApi } from "../../api/useApi";
import { Link, useRouter } from "../../router";
import { JUDUL_PRASYARAT } from "../closing/parts";
import { useActiveSession } from "../../session";
import {
  DaftarDokumen,
  Muat,
  Penyaring,
  useLayarKecil,
  useLingkupCabang,
  type ColumnSpec,
} from "../shared/parts";
import {
  Band,
  DialogRincian,
  JELAS_SUMBER,
  KartuMetrik,
  LABEL_SUMBER,
  teksPersen,
  teksUang,
  useRincian,
} from "./parts";

const LABEL_STATUS_PERIODE: Record<string, string> = {
  OPEN: "Periode terbuka",
  CLOSING_IN_PROGRESS: "Periode sedang ditutup",
  CLOSED: "Periode tertutup",
};

/**
 * The three metrics that are not part of spec 11's KPI row: the Non PUMK
 * budget, the effectiveness measured against it, and the overdue LPJ count.
 * They are their own band because two of them sit behind `admin.rka.view` and
 * are absent for most roles, and a band of three keeps the KPI band at exactly
 * two full rows of four rather than leaving a hole in the middle of it.
 */
const KUNCI_LANJUTAN: readonly string[] = [
  "ANGGARAN_NON_PUMK",
  "EFEKTIVITAS_NON_PUMK",
  "LPJ_TERLAMBAT",
];

function labelPeriode(periode: PeriodeDashboard | null): string {
  return periode ? formatPeriode(periode.tahun, periode.bulan) : "Periode belum dipilih";
}

export function Dashboard() {
  const session = useActiveSession();
  const { query, setQuery } = useRouter();
  const kecil = useLayarKecil();
  const lingkup = useLingkupCabang("Cabang");
  const rincian = useRincian();

  const periode = useApi(() => daftarPeriodeDashboard(), []);
  const daftarPeriode = periode.data?.data ?? [];
  const periodeUrl = query.get("periode");
  const periodeId =
    periodeUrl && daftarPeriode.some((p) => p.id === periodeUrl)
      ? periodeUrl
      : (daftarPeriode[0]?.id ?? null);
  const periodeTerpilih = daftarPeriode.find((p) => p.id === periodeId) ?? null;
  const milikSaya = query.get("antrean") === "saya";

  // ONE call, and it waits for the month list so the page cannot ask twice: a
  // first request with no period, then a second with the one the list resolved.
  const ringkasan = useApi(
    () =>
      ringkasanDashboard({
        periodeId,
        cabangId: lingkup.cabangId,
        hanyaMilikSaya: milikSaya,
      }),
    [periodeId, lingkup.cabangId, milikSaya],
    { enabled: periode.status === "siap" },
  );

  const isiFilter = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Periode</span>
        <Select
          aria-label="Periode dashboard"
          value={periodeId ?? ""}
          disabled={daftarPeriode.length === 0}
          onChange={(event) => setQuery("periode", event.currentTarget.value)}
          options={
            daftarPeriode.length === 0
              ? [
                  {
                    value: "",
                    label: periode.status === "memuat" ? "Memuat periode" : "Tidak ada periode",
                  },
                ]
              : daftarPeriode.map((p) => ({
                  value: p.id,
                  label: `${formatPeriode(p.tahun, p.bulan)}, ${LABEL_STATUS_PERIODE[p.status] ?? p.status}`,
                }))
          }
        />
      </label>
      {lingkup.kontrol}
      <label className="filter-laporan-check">
        <input
          type="checkbox"
          checked={milikSaya}
          onChange={(event) => setQuery("antrean", event.currentTarget.checked ? "saya" : null)}
        />
        <span>Antrean hanya tahap yang saya kerjakan</span>
      </label>
      <div className="filter-laporan-aksi">
        <Button variant="secondary" onClick={() => ringkasan.reload()}>
          Muat ulang
        </Button>
      </div>
      {periodeTerpilih ? (
        <p className="filter-laporan-catatan">
          {LABEL_STATUS_PERIODE[periodeTerpilih.status] ?? periodeTerpilih.status}.{" "}
          {periodeTerpilih.status === "CLOSED"
            ? "Angka uang dibaca dari saldo yang dibekukan saat closing, jadi halaman ini sama dengan laporan periode tersebut."
            : "Angka uang dihitung langsung dari ledger dan masih bisa berubah selama masih ada jurnal yang masuk."}
        </p>
      ) : null}
    </div>
  );

  const ringkasFilter = [
    labelPeriode(periodeTerpilih),
    lingkup.ringkas,
    milikSaya ? "Antrean saya saja" : "Seluruh antrean",
  ].join(", ");

  return (
    <div className="page dashboard-page">
      <header className="page-head">
        <div className="page-head-row">
          <div className="page-head-text">
            <h1 className="page-title">Dashboard</h1>
            <p className="page-sub">
              Ringkasan program untuk {session.cabang.nama}. Setiap angka menyebut sumber datanya
              dan bisa ditelusuri sampai baris asalnya.
            </p>
          </div>
        </div>
      </header>

      {kecil ? <Penyaring ringkas={ringkasFilter}>{isiFilter}</Penyaring> : isiFilter}

      {/*
        A FAILED MONTH LIST IS A FAILURE, NOT A PAUSE. The summary is gated on
        the picker so the page cannot ask twice, which means a dead picker would
        otherwise leave the body parked on "menyiapkan daftar periode" forever
        and read as a slow load rather than as a broken read.
      */}
      {periode.status === "gagal" ? (
        <ErrorState
          title="Gagal memuat daftar periode dashboard"
          detail={periode.error}
          sumber="GET /api/dashboard/periode"
          onRetry={periode.reload}
        />
      ) : null}

      <Muat
        hasil={periode.status === "gagal" ? { ...ringkasan, status: "diam" } : ringkasan}
        judul="ringkasan dashboard"
        sumber="GET /api/dashboard"
        diamLabel={
          periode.status === "gagal"
            ? "Ringkasan tidak diminta karena daftar periode gagal dimuat."
            : "Menyiapkan daftar periode."
        }
      >
        {(data) => (
          <IsiDashboard
            data={data}
            periodeId={periodeId}
            cabangId={lingkup.cabangId}
            onRincian={rincian.buka}
          />
        )}
      </Muat>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Halaman ini hanya membaca. Tidak ada tombol yang mengubah data di sini, dan setiap angka
          dihitung ulang di server sesuai kewenangan sesi Anda.
        </span>
      </p>

      <DialogRincian
        permintaan={rincian.permintaan}
        periodeId={periodeId}
        cabangId={lingkup.cabangId}
        onClose={rincian.tutup}
      />
    </div>
  );
}

function IsiDashboard({
  data,
  periodeId,
  cabangId,
  onRincian,
}: {
  data: RingkasanDashboard;
  periodeId: string | null;
  cabangId: string | null;
  onRincian: (kunci: string, nama: string) => void;
}) {
  const utama = data.metrik.filter((m) => !KUNCI_LANJUTAN.includes(m.kunci));
  const lanjutan = data.metrik.filter((m) => KUNCI_LANJUTAN.includes(m.kunci));

  /**
   * The note that goes under a figure whose artefact is NOT the one the period
   * itself was read from.
   *
   * On a closed month every money figure comes from the frozen balances, with
   * one exception the engine states outright: the collection ratio is computed
   * from schedule rows, for which no frozen artefact exists. Saying so on the
   * card is the whole point of `Metrik.sumber`; letting it sit silently among
   * the frozen figures would present a live number as a final one.
   */
  function catatanSumber(metrik: Metrik): string | undefined {
    if (metrik.nilai === null || metrik.sumber === null) return undefined;
    if (data.sumberPeriode !== "SALDO_AKUN_PERIODE") return undefined;
    if (metrik.sumber === "SALDO_AKUN_PERIODE" || metrik.sumber === "KOLEKTIBILITAS_SNAPSHOT") {
      return undefined;
    }
    if (metrik.sumber === "SUB_LEDGER") {
      return "Sub ledger PUMK berjalan. Tidak ada artefak beku untuk angka ini, jadi periode tertutup pun dibaca langsung.";
    }
    return `${LABEL_SUMBER[metrik.sumber]}. Bukan saldo beku periode ini.`;
  }

  return (
    <>
      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Sumber angka uang periode ini: {LABEL_SUMBER[data.sumberPeriode]}.{" "}
          {JELAS_SUMBER[data.sumberPeriode]} Cabang yang tercakup:{" "}
          {data.cabangDilaporkan.length === 0
            ? "tidak ada"
            : data.cabangDilaporkan.map((c) => `${c.kode} ${c.nama}`).join(", ")}
          . Disusun {formatDate(data.dibuatPada)}.
        </span>
      </p>

      <Band
        id="band-kpi"
        judul="Indikator utama"
        catatan="Angka pokok spesifikasi 11. Setiap kartu menyebut artefak yang menjawabnya, dan angka yang tidak dapat dijawab menampilkan alasannya, bukan nol."
      >
        <div className="bento bento-cols-4">
          {utama.map((metrik) => (
            <div className="bento-item bento-sm" key={metrik.kunci}>
              <KartuMetrik
                metrik={metrik}
                catatanSumber={catatanSumber(metrik)}
                onRincian={onRincian}
              />
            </div>
          ))}
        </div>
      </Band>

      <Band
        id="band-anggaran"
        judul="Anggaran dan kepatuhan Non PUMK"
        catatan="Dua angka pertama dibaca dari baseline RKA dan hanya tampil untuk pemegang kewenangan admin.rka.view. Angka yang tidak boleh Anda lihat ditandai sebagai tidak ditampilkan, bukan nol."
      >
        {/* FOUR COLUMNS HERE TOO, WITH A SHORT LAST ROW, rather than three wider
            cards: a card that changes width between two bands on one page reads
            as a second design, and card width is the thing a reader uses to
            tell one system from two. */}
        <div className="bento bento-cols-4">
          {lanjutan.map((metrik) => (
            <div className="bento-item bento-sm" key={metrik.kunci}>
              <KartuMetrik
                metrik={metrik}
                catatanSumber={catatanSumber(metrik)}
                onRincian={onRincian}
              />
            </div>
          ))}
        </div>
      </Band>

      <Band
        id="band-kolektibilitas"
        judul="Komposisi kolektibilitas"
        catatan="Sebaran outstanding pokok per kelas kolektibilitas. Kelas kosong tetap ditampilkan supaya bentuk sebaran tidak berubah antar bulan."
      >
        <Panel
          as="h3"
          title="Portofolio per kelas"
          description="Klik satu baris untuk membuka akad yang menyusun kelas tersebut."
          footer={<span className="panel-foot-note">Sumber: GET /api/dashboard</span>}
        >
          {data.alasanKolektibilitasKosong !== null ? (
            <PanelKosong
              judul="Belum ada klasifikasi untuk periode ini"
              teks={
                data.alasanKolektibilitasKosong === "KOLEKTIBILITAS_BELUM_DIJALANKAN"
                  ? "Closing kolektibilitas belum dijalankan untuk periode ini, jadi belum ada snapshot yang bisa dibaca. Sebaran ini bukan nol, melainkan belum ada."
                  : "Sebaran kolektibilitas tidak dapat dijawab untuk periode dan lingkup ini."
              }
            />
          ) : (
            <TabelKolektibilitas baris={data.kolektibilitas} onRincian={onRincian} />
          )}
        </Panel>
      </Band>

      <Band
        id="band-antrean"
        judul="Antrean kerja"
        catatan="Dokumen yang tertahan di setiap tahap, beserta kewenangan yang menanganinya. Tahap yang Anda kerjakan ditandai, tahap lain tetap ditampilkan supaya kondisi cabang terbaca utuh."
      >
        <Panel
          as="h3"
          title="Dokumen menunggu tindakan"
          description="Klik satu baris untuk membuka dokumen yang tertahan di tahap tersebut."
          footer={<span className="panel-foot-note">Sumber: GET /api/dashboard</span>}
        >
          <TabelAntrian baris={data.antrian} onRincian={onRincian} />
        </Panel>
      </Band>

      <Band
        id="band-closing"
        judul="Status closing periode"
        catatan="Checklist prasyarat closing dimiliki modul closing, dan dibaca apa adanya di sini supaya halaman ini tidak menjadi pendapat kedua tentang boleh atau tidaknya sebuah bulan ditutup."
      >
        <PanelClosing data={data} />
      </Band>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Periode: {formatPeriode(data.periode.tahun, data.periode.bulan)},{" "}
          {LABEL_STATUS_PERIODE[data.periode.status] ?? data.periode.status}, berlaku{" "}
          {formatDate(data.periode.tanggalMulai)} sampai {formatDate(data.periode.tanggalAkhir)}.
          Lingkup cabang: {cabangId === null ? "seluruh cabang dalam wewenang" : "satu cabang"}.
          {periodeId === null ? " Periode dipilih otomatis oleh server." : ""}
        </span>
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function PanelKosong({ judul, teks }: { judul: string; teks: string }) {
  return (
    <div className="antrean-kosong">
      <span className="antrean-kosong-icon" aria-hidden="true">
        <Icon name="info" size={20} />
      </span>
      <p className="antrean-kosong-title">{judul}</p>
      <p className="antrean-kosong-desc">{teks}</p>
    </div>
  );
}

function TabelKolektibilitas({
  baris,
  onRincian,
}: {
  baris: readonly BarisKolektibilitas[];
  onRincian: (kunci: string, nama: string) => void;
}) {
  const kolom: readonly ColumnSpec<BarisKolektibilitas>[] = [
    {
      key: "namaKelas",
      header: "Kelas",
      sortable: true,
      render: (row) => <StatusBadge status={row.kelas} label={row.namaKelas} />,
    },
    {
      key: "bermasalah",
      header: "Kategori",
      sortable: true,
      width: "160px",
      render: (row) => (row.bermasalah ? "Bermasalah" : "Tidak bermasalah"),
    },
    { key: "jumlahAkad", header: "Jumlah akad", type: "count", sortable: true, width: "140px" },
    {
      key: "outstandingPokok",
      header: "Outstanding pokok",
      type: "money",
      sortable: true,
      width: "200px",
      render: (row) => <span className="angka">{teksUang(row.outstandingPokok)}</span>,
    },
    {
      key: "persen",
      header: "Porsi",
      type: "percent",
      sortable: true,
      width: "150px",
      sortValue: (row) => (row.persen === null ? "" : Number(row.persen)),
      render: (row) =>
        row.persen === null ? (
          <span className="angka-kosong">Tidak dapat dihitung</span>
        ) : (
          <span className="angka">{teksPersen(row.persen)}</span>
        ),
    },
  ];

  return (
    <DaftarDokumen
      columns={kolom}
      rows={baris}
      rowKey={(row) => row.kelas}
      onPilih={(row) => onRincian(row.rincian, `Kolektibilitas ${row.namaKelas}`)}
      kartu={(row) => ({
        judul: row.namaKelas,
        sub: `${formatCount(row.jumlahAkad)} akad, ${row.bermasalah ? "kategori bermasalah" : "tidak bermasalah"}`,
        meta: `Porsi ${teksPersen(row.persen)}`,
        nilai: teksUang(row.outstandingPokok),
        nilaiLabel: "Outstanding pokok",
        status: <StatusBadge status={row.kelas} label={row.namaKelas} />,
      })}
      emptyTitle="Belum ada kelas kolektibilitas"
      emptyDescription="Tabel referensi kelas kolektibilitas belum terisi untuk entitas ini."
    />
  );
}

function TabelAntrian({
  baris,
  onRincian,
}: {
  baris: readonly BarisAntrian[];
  onRincian: (kunci: string, nama: string) => void;
}) {
  const kolom: readonly ColumnSpec<BarisAntrian>[] = [
    { key: "nama", header: "Tahap", sortable: true },
    { key: "izin", header: "Kewenangan", sortable: true, width: "220px" },
    {
      key: "milikSaya",
      header: "Penanganan",
      sortable: true,
      width: "180px",
      render: (row) =>
        row.milikSaya ? (
          <StatusBadge status="MILIK_SAYA" label="Tugas Anda" tone="info" />
        ) : (
          <span className="angka-kosong">Peran lain</span>
        ),
    },
    { key: "jumlah", header: "Dokumen", type: "count", sortable: true, width: "140px" },
  ];

  return (
    <DaftarDokumen
      columns={kolom}
      rows={baris}
      rowKey={(row) => row.tahap}
      onPilih={(row) => onRincian(row.rincian, row.nama)}
      kartu={(row) => ({
        judul: row.nama,
        sub: `Kewenangan ${row.izin}`,
        meta: row.milikSaya ? "Menunggu tindakan Anda" : "Ditangani peran lain",
        nilai: formatCount(row.jumlah),
        nilaiLabel: "Dokumen",
        status: row.milikSaya ? (
          <StatusBadge status="MILIK_SAYA" label="Tugas Anda" tone="info" />
        ) : undefined,
      })}
      emptyTitle="Tidak ada dokumen yang tertahan"
      emptyDescription="Tidak ada dokumen yang menunggu tindakan pada lingkup cabang dan periode yang dipilih."
    />
  );
}

function PanelClosing({ data }: { data: RingkasanDashboard }) {
  const closing = data.closing;
  return (
    <Panel
      as="h3"
      title={`Closing ${formatPeriode(data.periode.tahun, data.periode.bulan)}`}
      description="Kondisi periode berjalan dan sepuluh prasyarat closing menurut modul closing."
      aside={<StatusBadge status={closing.status} />}
      footer={
        <span className="panel-foot-note">
          Sumber: GET /api/dashboard.{" "}
          <Link className="panel-link" to="/admin/closing-periode">
            Buka halaman Closing Periode
          </Link>
        </span>
      }
    >
      <dl className="kop-grid">
        <div className="kop-fakta">
          <dt className="kop-label">Status periode</dt>
          <dd className="kop-nilai">
            {LABEL_STATUS_PERIODE[closing.status] ?? closing.status}
          </dd>
        </div>
        <div className="kop-fakta">
          <dt className="kop-label">Waktu penutupan</dt>
          <dd className="kop-nilai">
            {closing.closedAt ? formatDate(closing.closedAt) : "Belum ditutup"}
          </dd>
        </div>
        <div className="kop-fakta">
          <dt className="kop-label">Prasyarat terpenuhi</dt>
          <dd className="kop-nilai">
            {closing.prasyarat === null
              ? "Tidak ditampilkan"
              : closing.prasyarat.boleh
                ? "Ya, periode boleh ditutup"
                : "Belum, masih ada prasyarat gagal"}
          </dd>
        </div>
      </dl>

      {closing.prasyarat === null ? (
        <PanelKosong
          judul="Checklist prasyarat tidak ditampilkan"
          teks={
            closing.alasanKosong === "IZIN_TIDAK_DIMILIKI"
              ? "Checklist closing berada di balik kewenangan admin.closing.view yang belum Anda miliki. Ini bukan berarti seluruh prasyarat sudah lolos."
              : "Modul closing tidak terpasang pada server ini, jadi checklist prasyarat tidak dapat diminta."
          }
        />
      ) : (
        <>
          {closing.prasyarat.perluKonfirmasi ? (
            <p className="page-note">
              <Icon name="alert" size={16} />
              <span>
                Ada prasyarat berstatus peringatan yang wajib dikonfirmasi orang yang menutup
                periode. Konfirmasi itu dilakukan di halaman Closing Periode, bukan di sini.
              </span>
            </p>
          ) : null}
          <ol className="prasyarat-list">
            {closing.prasyarat.hasil.map((item) => (
              <ItemPrasyaratRingkas key={item.kode} item={item} />
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}

const NADA_PRASYARAT: Record<string, "success" | "danger" | "caution"> = {
  PASS: "success",
  GAGAL: "danger",
  PERINGATAN: "caution",
};

const LABEL_PRASYARAT: Record<string, string> = {
  PASS: "Lolos",
  GAGAL: "Gagal",
  PERINGATAN: "Perlu konfirmasi",
};

/**
 * One prerequisite as this page shows it: number, title, verdict, sentence.
 *
 * The same internal shape whatever the verdict, so ten of them read as one
 * list. The rows behind a failure live on the Closing Periode screen, which
 * owns them; repeating them here would be a second opinion about the same
 * check.
 */
function ItemPrasyaratRingkas({ item }: { item: BarisPrasyaratDashboard }) {
  return (
    <li className={`prasyarat-item is-${item.status.toLowerCase()}`}>
      <div className="prasyarat-head">
        <span className="prasyarat-nomor" aria-hidden="true">
          {item.nomor}
        </span>
        <span className="prasyarat-judul">
          {(JUDUL_PRASYARAT as Record<string, string | undefined>)[item.kode] ?? item.kode}
        </span>
        <StatusBadge
          status={item.status}
          tone={NADA_PRASYARAT[item.status] ?? "neutral"}
          label={LABEL_PRASYARAT[item.status] ?? item.status}
        />
      </div>
      <p className="prasyarat-alasan">{item.alasan}</p>
    </li>
  );
}
