// 24. Laporan RKA versus Realisasi, spec 10.3. Uraian, Anggaran, Realisasi,
// Selisih, persen Capaian, per akun, sektor or bidang according to the budget
// type, monthly or cumulative year to date.
//
// THIS IS THE REPORT THAT TIES THE TWO HALVES OF THE BUDGET LINE TOGETHER, so
// it is the one place the version model has to be visible rather than implied.
// A variance is meaningless without the document it was measured against, so
// the header names the version, its status and the year, and a reader holding
// `admin.rka.view` gets a link straight to that version's own page.
//
// THE REALISATION SOURCE IS NOT A CHOICE, AND THE SCREEN SAYS WHICH ONE
// ANSWERED. An OPEN month is read live from the ledger view and a CLOSED one
// from the trial balance the closing engine froze; the server decides that per
// month from the period's own status and takes no parameter for it, because
// a caller who could override it could publish a live figure for a closed
// month as the budget outturn. The answer carries `sumberPerPeriode`, and the
// panel at the foot of this page prints it month by month.
//
// THE HEADER IS ASSEMBLED HERE, AND ONE FIELD IS BORROWED. Reports 16 to 23
// come back with the API's own `HeaderLaporan`; this one is served by the RKA
// module, which returns no header at all. Five of the six fields spec 10 asks
// for are available without inventing anything (the report's own year and
// months, the branch the filter chose, today's date, the signed in user). The
// sixth, the BUMN name, is not, so it is READ FROM THE SERVER through report
// 16's header rather than composed in the browser, and when that read fails
// the field says so instead of showing a name nobody checked. Worth filing
// against the API: report 24 should return its own `HeaderLaporan` like every
// other report in the catalogue.
import { useMemo } from "react";
import {
  DataTable,
  Icon,
  Panel,
  Select,
  StatusBadge,
  formatCount,
  formatDate,
  type Column,
} from "@krakatausteel/ui";
import { baganAkun, cabangLaporan, periodeLaporan } from "../../api/laporan";
import {
  laporanRkaVsRealisasi,
  type BarisRkaVsRealisasi,
  type JenisRka,
  type LaporanRkaVsRealisasi,
  type ModeLaporanRka,
} from "../../api/rka";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import { AntreanKosong, Muat, Penyaring, TautanDokumen, useLayarKecil } from "../shared/parts";
import { Fakta, NilaiPersen, NilaiUang } from "./parts";

const NAMA_BULAN = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

const JENIS: readonly { value: JenisRka; label: string; dimensi: string }[] = [
  { value: "PUMK", label: "RKA Pendanaan UMK", dimensi: "Sektor" },
  { value: "NON_PUMK", label: "RKA Non PUMK", dimensi: "Bidang" },
  { value: "KEUANGAN", label: "RKA Keuangan", dimensi: "Akun" },
];

const MODE: readonly { value: ModeLaporanRka; label: string }[] = [
  { value: "BULANAN", label: "Bulanan" },
  { value: "KUMULATIF_YTD", label: "Kumulatif year to date" },
];

const LABEL_SUMBER: Record<string, string> = {
  SALDO_AKUN_PERIODE: "Saldo beku periode tertutup",
  V_LEDGER_BARIS: "Dihitung langsung dari ledger",
};

const SEMUA_CABANG = "SEMUA";

export function RkaVsRealisasiPage({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { query, setQuery } = useRouter();
  const kecil = useLayarKecil();

  const periode = useApi(() => periodeLaporan(), []);
  const cabang = useApi(() => cabangLaporan(), []);
  // Borrowed for the BUMN name alone. See this file's header.
  const chart = useApi(() => baganAkun(true), []);

  const tahunTersedia = useMemo(() => {
    const tahun = new Set<number>((periode.data?.data ?? []).map((p) => p.tahun));
    if (tahun.size === 0) tahun.add(session.periode.tahun);
    return [...tahun].sort((a, b) => b - a);
  }, [periode.data, session.periode.tahun]);

  const tahunUrl = Number(query.get("tahun"));
  const tahun = tahunTersedia.includes(tahunUrl) ? tahunUrl : (tahunTersedia[0] ?? session.periode.tahun);

  const bulanUrl = Number(query.get("bulan"));
  const bulan = Number.isInteger(bulanUrl) && bulanUrl >= 1 && bulanUrl <= 12 ? bulanUrl : session.periode.bulan;

  const jenisUrl = query.get("jenis");
  const jenis: JenisRka = JENIS.some((item) => item.value === jenisUrl)
    ? (jenisUrl as JenisRka)
    : "PUMK";

  const modeUrl = query.get("mode");
  const mode: ModeLaporanRka = MODE.some((item) => item.value === modeUrl)
    ? (modeUrl as ModeLaporanRka)
    : "BULANAN";

  const opsiCabang = cabang.data?.cabang ?? [];
  const bolehSemua = cabang.data?.bolehSemuaCabang ?? false;
  const cabangUrl = query.get("cabang");
  const cabangPilihan =
    cabangUrl === SEMUA_CABANG && bolehSemua
      ? SEMUA_CABANG
      : cabangUrl && opsiCabang.some((c) => c.id === cabangUrl)
        ? cabangUrl
        : bolehSemua
          ? SEMUA_CABANG
          : (cabang.data?.cabangSendiriId ?? null);
  const cabangId = cabangPilihan === SEMUA_CABANG ? null : cabangPilihan;

  const hasil = useApi(
    () => laporanRkaVsRealisasi({ tahun, jenis, cabangId, mode, bulan }),
    [tahun, jenis, cabangId, mode, bulan],
    { enabled: cabang.status === "siap" },
  );

  const namaCabang =
    cabangPilihan === SEMUA_CABANG
      ? "Semua Cabang"
      : (opsiCabang.find((c) => c.id === cabangPilihan)?.nama ?? "Cabang belum dipilih");

  const kontrol = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Jenis RKA</span>
        <Select
          aria-label="Jenis RKA"
          value={jenis}
          onChange={(event) => setQuery("jenis", event.currentTarget.value)}
          options={JENIS.map((item) => ({ value: item.value, label: item.label }))}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Tahun</span>
        <Select
          aria-label="Tahun anggaran"
          value={String(tahun)}
          onChange={(event) => setQuery("tahun", event.currentTarget.value)}
          options={tahunTersedia.map((item) => ({ value: String(item), label: String(item) }))}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Bulan</span>
        <Select
          aria-label="Bulan laporan"
          value={String(bulan)}
          onChange={(event) => setQuery("bulan", event.currentTarget.value)}
          options={NAMA_BULAN.map((nama, index) => ({ value: String(index + 1), label: nama }))}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Mode</span>
        <Select
          aria-label="Mode laporan"
          value={mode}
          onChange={(event) => setQuery("mode", event.currentTarget.value)}
          options={MODE.map((item) => ({ value: item.value, label: item.label }))}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Cabang</span>
        <Select
          aria-label="Cabang laporan"
          value={cabangPilihan ?? ""}
          disabled={opsiCabang.length === 0 && !bolehSemua}
          onChange={(event) => setQuery("cabang", event.currentTarget.value)}
          options={[
            ...(bolehSemua ? [{ value: SEMUA_CABANG, label: "Semua Cabang" }] : []),
            ...opsiCabang.map((c) => ({ value: c.id, label: `${c.kode} ${c.nama}` })),
            ...(opsiCabang.length === 0 && !bolehSemua
              ? [{ value: "", label: cabang.status === "memuat" ? "Memuat cabang" : "Tidak ada cabang" }]
              : []),
          ]}
        />
      </label>
    </div>
  );

  const ringkas = `${JENIS.find((item) => item.value === jenis)?.label ?? jenis}, ${NAMA_BULAN[bulan - 1]} ${tahun}, ${namaCabang}`;

  return (
    <div className="page laporan-page">
      <header className="page-head">
        <p className="page-crumb">Laporan Akuntansi</p>
        <div className="page-head-row">
          <div className="page-head-text">
            <h1 className="page-title">{route.title}</h1>
            <p className="page-sub">{route.summary}</p>
          </div>
        </div>
      </header>

      {kecil ? <Penyaring ringkas={ringkas}>{kontrol}</Penyaring> : kontrol}

      <Muat
        hasil={hasil}
        judul="Laporan RKA versus Realisasi"
        sumber="GET /api/rka/laporan/realisasi"
        diamLabel="Menunggu daftar cabang sebelum laporan bisa diminta."
      >
        {(data: LaporanRkaVsRealisasi) => (
          <>
            <KopRka
              data={data}
              namaBumn={chart.data?.header.namaBumn ?? null}
              bumnGagal={chart.status === "gagal"}
              namaCabang={namaCabang}
              dicetakOleh={session.user.nama}
              bolehLihatRka={session.permissions.includes("admin.rka.view")}
            />

            <Panel
              as="h2"
              title="Anggaran versus realisasi"
              description={`Dimensi ${JENIS.find((item) => item.value === data.jenis)?.dimensi ?? data.dimensi}. ${
                data.mode === "KUMULATIF_YTD"
                  ? `Kumulatif bulan ${NAMA_BULAN[data.dariBulan - 1]} sampai ${NAMA_BULAN[data.sampaiBulan - 1]}.`
                  : `Bulan ${NAMA_BULAN[data.sampaiBulan - 1]} saja.`
              }`}
            >
              <TabelRka data={data} />
            </Panel>

            <Panel
              as="h2"
              title="Sumber angka realisasi per bulan"
              description="Bulan yang sudah ditutup dibaca dari saldo yang dibekukan saat closing, bulan yang masih terbuka dihitung langsung dari ledger. Server yang menentukan, bukan pilihan di halaman ini."
            >
              {data.sumberPerPeriode.length === 0 ? (
                <p className="muat-diam">
                  Server tidak mengembalikan satu periode pun untuk rentang ini, jadi tidak ada
                  sumber yang bisa disebutkan.
                </p>
              ) : (
                <ul className="rincian-list">
                  {data.sumberPerPeriode.map((sumber) => (
                    <li className="rincian-item" key={sumber.periodeId}>
                      <span className="rincian-utama">
                        <span className="rincian-kode">
                          {NAMA_BULAN[sumber.bulan - 1]} {sumber.tahun}
                        </span>
                        <span className="rincian-nama">
                          {LABEL_SUMBER[sumber.sumber] ?? sumber.sumber}
                        </span>
                      </span>
                      <span className="rincian-nilai">
                        <StatusBadge status={sumber.statusPeriode} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
      </Muat>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Laporan ini hanya membaca. Export Excel dan export PDF belum tersedia dan belum punya
          kewenangan sendiri, jadi tidak ada tombolnya di halaman ini.
        </span>
      </p>
    </div>
  );
}

function KopRka({
  data,
  namaBumn,
  bumnGagal,
  namaCabang,
  dicetakOleh,
  bolehLihatRka,
}: {
  data: LaporanRkaVsRealisasi;
  namaBumn: string | null;
  bumnGagal: boolean;
  namaCabang: string;
  dicetakOleh: string;
  bolehLihatRka: boolean;
}) {
  const periodeLabel =
    data.mode === "KUMULATIF_YTD"
      ? `${NAMA_BULAN[data.dariBulan - 1]} sampai ${NAMA_BULAN[data.sampaiBulan - 1]} ${data.tahun}`
      : `${NAMA_BULAN[data.sampaiBulan - 1]} ${data.tahun}`;

  const sumberSet = new Set(data.sumberPerPeriode.map((s) => s.sumber));
  const sumberLabel =
    sumberSet.size === 0
      ? "Tidak ada periode pada rentang ini"
      : sumberSet.size === 1
        ? (LABEL_SUMBER[[...sumberSet][0] ?? ""] ?? [...sumberSet][0] ?? "")
        : "Campuran, dirinci per bulan di bawah";

  const tautanVersi = `/admin/rka-${data.jenis === "PUMK" ? "pumk" : data.jenis === "NON_PUMK" ? "nonpumk" : "keuangan"}?tahun=${data.tahun}&rka=${encodeURIComponent(data.rkaId)}`;

  return (
    <Panel
      as="h2"
      title="Laporan RKA versus Realisasi"
      description={
        bumnGagal
          ? "Nama BUMN tidak dapat dibaca dari server, jadi tidak diisi di sini."
          : (namaBumn ?? "Memuat nama BUMN")
      }
      className="kop-laporan"
    >
      <dl className="kop-grid">
        <Fakta label="Periode" value={periodeLabel} />
        <Fakta label="Cabang" value={namaCabang} />
        <Fakta label="Tanggal cetak" value={formatDate(new Date())} />
        <Fakta label="Dicetak oleh" value={dicetakOleh} />
        <Fakta
          label="Baseline pembanding"
          value={
            <>
              <span className="kop-klaim">
                Versi {formatCount(data.versi)} <StatusBadge status={data.statusRka} />
              </span>
              <span className="kop-jelas">
                Seluruh kolom Anggaran di bawah diukur terhadap versi ini. Versi lain dari tahun
                yang sama menghasilkan selisih yang berbeda.
              </span>
              {bolehLihatRka ? (
                <TautanDokumen to={tautanVersi}>Buka versi RKA ini</TautanDokumen>
              ) : null}
            </>
          }
        />
        <Fakta
          label="Sumber angka realisasi"
          value={
            <>
              <span className="kop-klaim">{sumberLabel}</span>
              <span className="kop-jelas">
                Angka bulan yang masih terbuka bisa berubah selama masih ada jurnal yang masuk.
                Angka bulan yang sudah ditutup tidak berubah lagi.
              </span>
            </>
          }
        />
      </dl>
    </Panel>
  );
}

function TabelRka({ data }: { data: LaporanRkaVsRealisasi }) {
  const pakaiUnit = data.jenis === "PUMK";

  const columns: readonly Column<BarisRkaVsRealisasi>[] = [
    {
      key: "uraian",
      header: "Uraian",
      render: (row) => (
        <span className="sel-utama">
          <span className="sel-utama-judul">
            {row.dimensiKode} {row.dimensiNama}
          </span>
          <span className="sel-utama-sub">{row.uraian}</span>
        </span>
      ),
      footer: <span className="sel-utama-judul">Total</span>,
    },
    {
      key: "anggaran",
      header: "Anggaran",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.anggaran} />,
      footer: <NilaiUang nilai={data.total.anggaran} />,
    },
    {
      key: "realisasi",
      header: "Realisasi",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.realisasi} />,
      footer: <NilaiUang nilai={data.total.realisasi} />,
    },
    {
      key: "selisih",
      header: "Selisih",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.selisih} />,
      footer: <NilaiUang nilai={data.total.selisih} />,
    },
    {
      key: "persenCapaian",
      header: "Capaian",
      type: "percent",
      width: "140px",
      render: (row) => <NilaiPersen nilai={row.persenCapaian} />,
      footer: <NilaiPersen nilai={data.total.persenCapaian} />,
    },
    ...(pakaiUnit
      ? [
          {
            key: "unitAnggaran",
            header: "Target mitra",
            type: "count" as const,
            width: "130px",
            render: (row: BarisRkaVsRealisasi) =>
              row.unitAnggaran === null ? (
                <span className="angka-kosong">Tidak ditargetkan</span>
              ) : (
                <span className="angka">{formatCount(row.unitAnggaran)}</span>
              ),
            footer:
              data.total.unitAnggaran === null ? (
                <span className="angka-kosong">Tidak ditargetkan</span>
              ) : (
                <span className="angka">{formatCount(data.total.unitAnggaran)}</span>
              ),
          },
          {
            key: "unitRealisasi",
            header: "Mitra terealisasi",
            type: "count" as const,
            width: "150px",
            render: (row: BarisRkaVsRealisasi) =>
              row.unitRealisasi === null ? (
                <span className="angka-kosong">Tidak tersedia</span>
              ) : (
                <span className="angka">{formatCount(row.unitRealisasi)}</span>
              ),
            footer:
              data.total.unitRealisasi === null ? (
                <span className="angka-kosong">Tidak tersedia</span>
              ) : (
                <span className="angka">{formatCount(data.total.unitRealisasi)}</span>
              ),
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="daftar-tabel">
        <DataTable
          columns={columns}
          rows={data.baris}
          rowKey={(row) => `${row.dimensiId}`}
          emptyTitle="Tidak ada baris anggaran pada rentang ini"
          emptyDescription="Versi RKA yang menjadi baseline tidak punya baris pada bulan yang dipilih, jadi tidak ada yang bisa dibandingkan."
        />
      </div>
      <div className="daftar-kartu">
        {data.baris.length === 0 ? (
          <AntreanKosong
            icon="list"
            title="Tidak ada baris anggaran pada rentang ini"
            description="Versi RKA yang menjadi baseline tidak punya baris pada bulan yang dipilih, jadi tidak ada yang bisa dibandingkan."
          />
        ) : (
          <ul className="kartu-list">
            {data.baris.map((row) => (
              <li className="kartu-item is-statis" key={row.dimensiId}>
                <div className="varian-kartu">
                  <p className="kartu-judul">
                    {row.dimensiKode} {row.dimensiNama}
                  </p>
                  <p className="kartu-sub">{row.uraian}</p>
                  <dl className="varian-grid">
                    <div className="varian-sel">
                      <dt>Anggaran</dt>
                      <dd>
                        <NilaiUang nilai={row.anggaran} />
                      </dd>
                    </div>
                    <div className="varian-sel">
                      <dt>Realisasi</dt>
                      <dd>
                        <NilaiUang nilai={row.realisasi} />
                      </dd>
                    </div>
                    <div className="varian-sel">
                      <dt>Selisih</dt>
                      <dd>
                        <NilaiUang nilai={row.selisih} />
                      </dd>
                    </div>
                    <div className="varian-sel">
                      <dt>Capaian</dt>
                      <dd>
                        <NilaiPersen nilai={row.persenCapaian} />
                      </dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
            <li className="kartu-item is-statis is-total" key="total">
              <div className="varian-kartu">
                <p className="kartu-judul">Total</p>
                <p className="kartu-sub">Seluruh dimensi pada rentang ini</p>
                <dl className="varian-grid">
                  <div className="varian-sel">
                    <dt>Anggaran</dt>
                    <dd>
                      <NilaiUang nilai={data.total.anggaran} />
                    </dd>
                  </div>
                  <div className="varian-sel">
                    <dt>Realisasi</dt>
                    <dd>
                      <NilaiUang nilai={data.total.realisasi} />
                    </dd>
                  </div>
                  <div className="varian-sel">
                    <dt>Selisih</dt>
                    <dd>
                      <NilaiUang nilai={data.total.selisih} />
                    </dd>
                  </div>
                  <div className="varian-sel">
                    <dt>Capaian</dt>
                    <dd>
                      <NilaiPersen nilai={data.total.persenCapaian} />
                    </dd>
                  </div>
                </dl>
              </div>
            </li>
          </ul>
        )}
      </div>
    </>
  );
}
