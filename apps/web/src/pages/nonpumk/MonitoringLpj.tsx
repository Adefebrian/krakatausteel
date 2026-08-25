// Monitoring LPJ Terlambat, spec 9.2: "Dashboard monitoring LPJ yang
// terlambat, dengan aging (30, 60, 90 hari sejak penyaluran)".
//
// THE BUCKETS ARE THE SPEC'S AND ARE HALF OPEN ON THE LEFT. A grant whose last
// termin was exactly 30 days ago sits in the 30 to 59 bucket, not in the one
// below it. The engine states that boundary and this page prints it on every
// card, because an off by one in an ageing bucket is invisible in a screenshot
// and wrong in every management report built on top of it.
//
// AGE AND LATENESS ARE TWO DIFFERENT QUESTIONS, and the page keeps them apart.
// The bucket is the number of days since the LAST disbursement, from the spec.
// `terlambat` is whether that has passed the CONFIGURED deadline, which the
// client can change without a deploy. A program can be ninety days old and not
// late, if the deadline is longer; the dashboard must not merge the two into
// one alarming colour.
//
// The counts and totals on the four cards are computed from the SAME answer
// the table below renders, so a card can never disagree with the rows under
// it, and the totals are added in integer sen through `formatTotal`, which
// renders the marker rather than a number when any row is unreadable.
import { useMemo, useState } from "react";
import {
  Bento,
  BentoItem,
  FilterBar,
  Panel,
  Select,
  Stat,
  StatusBadge,
  formatCount,
  formatDate,
  formatMoney,
  formatTotal,
} from "@krakatausteel/ui";
import {
  daftarBidang,
  monitoringLpj,
  type BarisMonitoringLpjBerlabel,
  type EmberUmurLpj,
} from "../../api/nonpumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  DaftarDokumen,
  HalamanModul,
  Muat,
  Penyaring,
  type ColumnSpec,
} from "../shared/parts";
import { EMBER_LPJ, URUTAN_EMBER } from "./parts";

// SEVEN COLUMNS, MEASURED AT 1280. Nine wanted 1203px in a 932px shell, which
// put the late marker, the one column this dashboard exists for, off the right
// edge behind a sideways scroll.
//
// Bidang is a FILTER here rather than a column. The per row ageing bucket is
// gone too: `umurHari` is the same fact with more precision, and the four
// cards above already state where each boundary falls. The date of the last
// termin, which the age is measured from, is on the phone card and one click
// away on the program's LPJ page.
const COLUMNS: readonly ColumnSpec<BarisMonitoringLpjBerlabel>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "150px" },
  {
    key: "namaPemohon",
    header: "Penerima",
    sortable: true,
    width: "180px",
    render: (row) => (
      <span className="sel-utama">
        <span className="sel-utama-judul">{row.namaPemohon}</span>
        <span className="sel-utama-sub">{row.judulProgram}</span>
      </span>
    ),
  },
  {
    key: "totalDisalurkan",
    header: "Nilai Disalurkan",
    type: "money",
    sortable: true,
    width: "150px",
  },
  {
    key: "umurHari",
    header: "Umur sejak termin (hari)",
    type: "count",
    sortable: true,
    width: "160px",
  },
  {
    key: "status",
    header: "Status program",
    sortable: true,
    width: "150px",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "terlambat",
    header: "Batas LPJ",
    sortable: true,
    width: "120px",
    sortValue: (row) => (row.terlambat ? 1 : 0),
    render: (row) => (
      <StatusBadge
        status={row.terlambat ? "LEWAT_BATAS" : "DALAM_BATAS"}
        tone={row.terlambat ? "warning" : "neutral"}
        label={row.terlambat ? "Lewat batas" : "Dalam batas"}
      />
    ),
  },
];

const EMBER_OPTIONS = [
  { value: "", label: "Semua kelompok umur" },
  ...URUTAN_EMBER.map((ember) => ({ value: ember, label: `${EMBER_LPJ[ember].label} ke atas` })),
];

export function MonitoringLpj({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();

  const [cabangId, setCabangId] = useState(session.cabang.id);
  const [bidangId, setBidangId] = useState("");
  const [emberMinimal, setEmberMinimal] = useState("");
  const [hanyaTerlambat, setHanyaTerlambat] = useState("");

  const filter = useMemo(
    () => ({
      cabangId: cabangId === "SEMUA" ? null : cabangId,
      bidangId: bidangId || null,
      emberMinimal: emberMinimal ? (emberMinimal as EmberUmurLpj) : null,
      hanyaTerlambat: hanyaTerlambat === "YA" ? true : undefined,
    }),
    [cabangId, bidangId, emberMinimal, hanyaTerlambat],
  );

  const daftar = useApi(() => monitoringLpj(filter), [JSON.stringify(filter)]);
  const bidang = useApi(() => daftarBidang(), []);

  const cabangOptions = [
    ...(session.lintasCabang ? [{ value: "SEMUA", label: "Semua cabang" }] : []),
    ...session.cabangTersedia.map((cabang) => ({
      value: cabang.id,
      label: `${cabang.kode} ${cabang.nama}`,
    })),
  ];
  const bidangOptions = [
    { value: "", label: "Semua bidang" },
    ...(bidang.data?.data ?? []).map((item) => ({ value: item.id, label: item.nama })),
  ];

  function reset() {
    setCabangId(session.cabang.id);
    setBidangId("");
    setEmberMinimal("");
    setHanyaTerlambat("");
  }

  return (
    <HalamanModul route={route}>
      <Penyaring
        ringkas={[
          cabangId === "SEMUA"
            ? "Semua cabang"
            : (session.cabangTersedia.find((item) => item.id === cabangId)?.nama ?? "Cabang aktif"),
          bidangId
            ? (bidangOptions.find((item) => item.value === bidangId)?.label ?? "Bidang")
            : "Semua bidang",
          emberMinimal
            ? (EMBER_OPTIONS.find((item) => item.value === emberMinimal)?.label ?? "Umur")
            : "Semua kelompok umur",
          hanyaTerlambat === "YA" ? "Hanya lewat batas" : null,
        ]
          .filter(Boolean)
          .join(" . ")}
      >
        <FilterBar
          cabang={cabangId}
          onCabangChange={setCabangId}
          cabangOptions={cabangOptions}
          onReset={reset}
        >
          <div className="filterbar-group">
            <span className="filterbar-label">Bidang Non PUMK</span>
            <Select
              aria-label="Bidang Non PUMK"
              value={bidangId}
              disabled={bidang.status !== "siap"}
              onChange={(event) => setBidangId(event.currentTarget.value)}
              options={bidangOptions}
            />
            {bidang.status === "gagal" ? (
              <span className="filterbar-gagal">Daftar bidang tidak dapat dimuat dari server.</span>
            ) : null}
          </div>
          <div className="filterbar-group">
            <span className="filterbar-label">Kelompok umur minimal</span>
            <Select
              aria-label="Kelompok umur minimal"
              value={emberMinimal}
              onChange={(event) => setEmberMinimal(event.currentTarget.value)}
              options={EMBER_OPTIONS}
            />
          </div>
          <div className="filterbar-group">
            <span className="filterbar-label">Batas waktu LPJ</span>
            <Select
              aria-label="Batas waktu LPJ"
              value={hanyaTerlambat}
              onChange={(event) => setHanyaTerlambat(event.currentTarget.value)}
              options={[
                { value: "", label: "Semua program" },
                { value: "YA", label: "Hanya yang lewat batas" },
              ]}
            />
          </div>
        </FilterBar>
      </Penyaring>

      <Muat
        hasil={daftar}
        judul="monitoring LPJ"
        sumber="GET /api/nonpumk/monitoring-lpj"
      >
        {(data) => {
          const rows = data.data;
          const perEmber = URUTAN_EMBER.map((ember) => {
            const isi = rows.filter((row) => row.ember === ember);
            return {
              ember,
              jumlah: isi.length,
              nilai: formatTotal(isi.map((row) => row.totalDisalurkan)),
              terlambat: isi.filter((row) => row.terlambat).length,
            };
          });

          return (
            <>
              <Bento columns={4}>
                {perEmber.map((kelompok) => (
                  <BentoItem span="sm" key={kelompok.ember}>
                    <Panel
                      as="h2"
                      title={EMBER_LPJ[kelompok.ember].label}
                      className="panel-kpi"
                      footer={
                        <span>
                          {formatCount(kelompok.terlambat)} dari {formatCount(kelompok.jumlah)}{" "}
                          sudah lewat batas waktu LPJ.
                        </span>
                      }
                    >
                      <Stat
                        label="Nilai disalurkan"
                        value={kelompok.nilai}
                        hint={`${formatCount(kelompok.jumlah)} program, ${EMBER_LPJ[kelompok.ember].ringkas} sejak termin terakhir.`}
                      />
                    </Panel>
                  </BentoItem>
                ))}
              </Bento>

              <Panel
                as="h2"
                title="Program yang belum menyelesaikan LPJ"
                description="Diurutkan dari yang paling lama sejak termin terakhirnya. Umur di sini dihitung dari tanggal termin penyaluran terakhir, bukan dari tanggal proposal seperti kolom umur dokumen pada Daftar Proposal."
                footer={
                  <span>
                    {formatCount(rows.length)} program, total nilai disalurkan{" "}
                    {formatTotal(rows.map((row) => row.totalDisalurkan))}.
                  </span>
                }
              >
                <DaftarDokumen
                  columns={COLUMNS}
                  rows={rows}
                  rowKey={(row) => row.proposalId}
                  onPilih={(row) => navigate(`/nonpumk/lpj?proposal=${row.proposalId}`)}
                  caption="Program dengan dana sudah disalurkan dan LPJ belum diterima"
                  emptyTitle="Tidak ada program yang menunggak LPJ"
                  emptyDescription="Setiap program yang dananya sudah disalurkan pada filter ini sudah menyelesaikan LPJ nya."
                  kartu={(row) => ({
                    judul: row.namaPemohon,
                    sub: `${row.noProposal} . ${row.bidangNama}`,
                    nilai: formatMoney(row.totalDisalurkan),
                    nilaiLabel: "Disalurkan",
                    // One line, and the day count places the row in its bucket without
                    // spending the width on repeating the bucket label.
                    meta: `${formatCount(row.umurHari)} hari sejak termin ${formatDate(row.tanggalPenyaluranTerakhir)}`,
                    status: (
                      <StatusBadge
                        status={row.terlambat ? "LEWAT_BATAS" : "DALAM_BATAS"}
                        tone={row.terlambat ? "warning" : "neutral"}
                        label={row.terlambat ? "Lewat batas" : "Dalam batas"}
                      />
                    ),
                  })}
                />
              </Panel>
            </>
          );
        }}
      </Muat>

      <Panel
        as="h2"
        title="Cara membaca dashboard ini"
        description="Kelompok umur dan status lewat batas adalah dua hal yang berbeda dan tidak digabung menjadi satu penanda."
        footer={
          <span>Klik satu baris untuk membuka halaman LPJ program yang bersangkutan.</span>
        }
      >
        <ol className="langkah-list">
          <li>
            Kelompok umur 30, 60, dan 90 hari berasal dari spesifikasi dan tidak dapat diubah dari
            Parameter Sistem. Batasnya terbuka di sebelah kiri, sehingga program berumur tepat 30
            hari masuk kelompok 30 sampai 59 hari.
          </li>
          <li>
            Umur dihitung sejak tanggal termin penyaluran terakhir, bukan sejak tanggal proposal
            atau tanggal persetujuan.
          </li>
          <li>
            Penanda Lewat batas dibaca dari batas hari LPJ pada Parameter Sistem, yang dapat diubah
            klien tanpa deploy. Program berumur 90 hari belum tentu lewat batas.
          </li>
          <li>
            Daftar ini memuat program yang dananya sudah keluar dan LPJ nya belum diterima:
            penyaluran masih berjalan, menunggu LPJ, dan LPJ ditolak. Program yang LPJ nya sedang
            menunggu verifikasi tidak masuk, karena bolanya ada di verifikator.
          </li>
        </ol>
      </Panel>

      <CatatanOtorisasi tambahan="Dashboard ini hanya memuat cabang yang boleh Anda lihat." />
    </HalamanModul>
  );
}
