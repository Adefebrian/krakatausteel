// Daftar Proposal Non PUMK, spec 9.2.
//
// Four filters the spec names by name: bidang, SDG, status and a date range.
// All four go to the SERVER as query parameters rather than narrowing an array
// in the browser, so the count on screen is a count of what the server
// actually holds under that filter and not of the page that happened to load.
//
// The two tabs are a SPLIT OF ONE ANSWER, not two requests: the list is read
// once and partitioned on `sumberPengajuan`, so both counts are measured under
// the same filter and switching tabs can never show a number that was measured
// under a different one.
import { useMemo, useState } from "react";
import {
  Button,
  FilterBar,
  Icon,
  Panel,
  Select,
  StatusBadge,
  Tabs,
  TabPanel,
  TextInput,
  formatCount,
  formatMoney,
  formatTotal,
  STATUS_PROPOSAL_NON_PUMK,
} from "@krakatausteel/ui";
import {
  daftarBidang,
  daftarProposal,
  daftarSdg,
  type BarisProposalNonPumk,
  type StatusProposalNonPumk,
} from "../../api/nonpumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
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
import { ringkasSdg, teksUmurDokumen } from "./parts";

const STATUS_OPTIONS = [
  { value: "", label: "Semua status" },
  ...Object.entries(STATUS_PROPOSAL_NON_PUMK).map(([value, meta]) => ({
    value,
    label: meta.label,
  })),
];

// SEVEN COLUMNS, WHICH IS WHAT FITS AT 1280 AND WHAT WAS PROMISED: nomor
// proposal, pemohon, bidang, nilai diajukan, nilai disetujui, status, status
// LPJ. Measured, not guessed: nine columns wanted 1213px in a 966px shell, so
// the last two sat off the right edge behind a sideways scroll nobody uses.
//
// Tanggal and SDG are FILTERS on this page rather than columns. Both are on
// the detail page, the date is on the phone card, and the SDG mapping is on
// every work queue, where there are fewer columns and room for it.
const COLUMNS: readonly ColumnSpec<BarisProposalNonPumk>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "140px" },
  {
    key: "namaPemohon",
    header: "Pemohon",
    sortable: true,
    width: "200px",
    render: (row) => (
      <span className="sel-utama">
        <span className="sel-utama-judul">{row.namaPemohon}</span>
        <span className="sel-utama-sub">{row.judulProgram}</span>
      </span>
    ),
  },
  { key: "bidangNama", header: "Bidang", sortable: true, width: "110px" },
  { key: "jumlahDiajukan", header: "Diajukan", type: "money", sortable: true, width: "130px" },
  {
    key: "jumlahDisetujui",
    header: "Disetujui",
    type: "money",
    sortable: true,
    width: "130px",
    // Null is not zero: a proposal nobody has approved yet has no approved
    // amount, and printing 0,00 there would read as an approval at nil.
    render: (row) =>
      row.jumlahDisetujui === null ? (
        <span className="sel-kosong">Belum disetujui</span>
      ) : (
        <span className="sel-angka">{formatMoney(row.jumlahDisetujui)}</span>
      ),
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    width: "160px",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "statusLpj",
    header: "LPJ",
    sortable: true,
    width: "110px",
    render: (row) =>
      row.statusLpj === null ? (
        <span className="sel-kosong">Belum ada</span>
      ) : (
        <StatusBadge status={`LPJ_${row.statusLpj}`} label={LABEL_LPJ[row.statusLpj]} />
      ),
  },
];

const LABEL_LPJ: Record<string, string> = {
  BELUM: "Belum masuk",
  DIAJUKAN: "Diajukan",
  DIVERIFIKASI: "Diverifikasi",
  DITOLAK: "Ditolak",
};

export function ProposalList({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();

  const [cabangId, setCabangId] = useState(session.cabang.id);
  const [bidangId, setBidangId] = useState("");
  const [sdgId, setSdgId] = useState("");
  const [status, setStatus] = useState("");
  const [dariTanggal, setDariTanggal] = useState("");
  const [sampaiTanggal, setSampaiTanggal] = useState("");
  const [cari, setCari] = useState("");
  const [tab, setTab] = useState("INTERNAL");

  const filter = useMemo(
    () => ({
      cabangId: cabangId === "SEMUA" ? null : cabangId,
      bidangId: bidangId || null,
      sdgId: sdgId || null,
      status: status ? (status as StatusProposalNonPumk) : null,
      dariTanggal: dariTanggal || null,
      sampaiTanggal: sampaiTanggal || null,
      cari: cari.trim() || null,
    }),
    [cabangId, bidangId, sdgId, status, dariTanggal, sampaiTanggal, cari],
  );

  const daftar = useApi(() => daftarProposal(filter), [JSON.stringify(filter)]);
  const bidang = useApi(() => daftarBidang(), []);
  const sdg = useApi(() => daftarSdg(), []);

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

  const sdgOptions = [
    { value: "", label: "Semua SDG" },
    ...(sdg.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `SDG ${item.nomor} ${item.nama}`,
    })),
  ];

  const rows = daftar.data?.data ?? [];
  const internal = rows.filter((row) => row.sumberPengajuan === "INTERNAL");
  const portal = rows.filter((row) => row.sumberPengajuan === "PORTAL_ONLINE");
  const terpilih = tab === "INTERNAL" ? internal : portal;

  function reset() {
    setCabangId(session.cabang.id);
    setBidangId("");
    setSdgId("");
    setStatus("");
    setDariTanggal("");
    setSampaiTanggal("");
    setCari("");
  }

  return (
    <HalamanModul
      route={route}
      actions={
        hasPermission(session.permissions, "nonpumk.create") ? (
          <Button
            variant="primary"
            leading={<Icon name="plus" size={16} />}
            onClick={() => navigate("/nonpumk/proposal/baru")}
          >
            Input proposal
          </Button>
        ) : null
      }
    >
      <Penyaring
        ringkas={[
          cabangId === "SEMUA"
            ? "Semua cabang"
            : (session.cabangTersedia.find((item) => item.id === cabangId)?.nama ?? "Cabang aktif"),
          bidangId
            ? (bidangOptions.find((item) => item.value === bidangId)?.label ?? "Bidang")
            : "Semua bidang",
          sdgId ? (sdgOptions.find((item) => item.value === sdgId)?.label ?? "SDG") : "Semua SDG",
          status
            ? (STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status)
            : "Semua status",
          cari.trim() ? `Cari "${cari.trim()}"` : null,
        ]
          .filter(Boolean)
          .join(" . ")}
      >
        <FilterBar
          cabang={cabangId}
          onCabangChange={setCabangId}
          cabangOptions={cabangOptions}
          search={cari}
          onSearchChange={setCari}
          searchLabel="Cari pemohon atau judul program"
          searchPlaceholder="Nama pemohon atau judul program"
          onReset={reset}
        >
          <div className="filterbar-group">
            <span className="filterbar-label">Tanggal proposal</span>
            <div className="filterbar-pair">
              <TextInput
                type="date"
                aria-label="Tanggal proposal dari"
                value={dariTanggal}
                onChange={(event) => setDariTanggal(event.currentTarget.value)}
              />
              <TextInput
                type="date"
                aria-label="Tanggal proposal sampai"
                value={sampaiTanggal}
                onChange={(event) => setSampaiTanggal(event.currentTarget.value)}
              />
            </div>
          </div>
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
            <span className="filterbar-label">SDG</span>
            <Select
              aria-label="SDG"
              value={sdgId}
              disabled={sdg.status !== "siap"}
              onChange={(event) => setSdgId(event.currentTarget.value)}
              options={sdgOptions}
            />
            {sdg.status === "gagal" ? (
              <span className="filterbar-gagal">Daftar SDG tidak dapat dimuat dari server.</span>
            ) : null}
          </div>
          <div className="filterbar-group">
            <span className="filterbar-label">Status</span>
            <Select
              aria-label="Status proposal"
              value={status}
              onChange={(event) => setStatus(event.currentTarget.value)}
              options={STATUS_OPTIONS}
            />
          </div>
        </FilterBar>
      </Penyaring>

      <Muat hasil={daftar} judul="daftar proposal Non PUMK" sumber="GET /api/nonpumk/proposal">
        {() => (
          <>
            <Tabs
              label="Sumber pengajuan"
              active={tab}
              onChange={setTab}
              items={[
                { id: "INTERNAL", label: "Daftar Pemohon", count: internal.length },
                { id: "PORTAL_ONLINE", label: "Daftar Pemohon Online", count: portal.length },
              ]}
              aside={
                <span className="tabs-note">
                  {formatCount(rows.length)} proposal sesuai filter, total nilai diajukan{" "}
                  {formatTotal(rows.map((row) => row.jumlahDiajukan))}
                </span>
              }
            />
            <TabPanel id={tab}>
              <DaftarDokumen
                columns={COLUMNS}
                rows={terpilih}
                rowKey={(row) => row.id}
                onPilih={(row) => navigate(`/nonpumk/proposal/${row.id}`)}
                caption={
                  tab === "INTERNAL"
                    ? "Proposal bantuan yang diinput petugas cabang"
                    : "Proposal bantuan yang masuk melalui Portal Online dan sudah dikonversi"
                }
                emptyTitle={
                  tab === "INTERNAL"
                    ? "Belum ada proposal internal pada filter ini"
                    : "Belum ada proposal dari Portal Online pada filter ini"
                }
                emptyDescription="Ubah filter tanggal, cabang, bidang, SDG, atau status untuk melihat proposal lain."
                kartu={(row) => ({
                  judul: row.namaPemohon,
                  sub: `${row.noProposal} . ${row.bidangNama}`,
                  nilai: formatMoney(row.jumlahDiajukan),
                  nilaiLabel: "Diajukan",
                  meta: `${ringkasSdg(row.sdg)} . ${teksUmurDokumen(row.umurHari)}`,
                  status: <StatusBadge status={row.status} />,
                })}
              />
            </TabPanel>
          </>
        )}
      </Muat>

      <Panel
        as="h2"
        title="Cara membaca daftar ini"
        description="Tab memisahkan asal pengajuan, bukan statusnya. Kolom Disetujui kosong selama Approver belum memutuskan, dan tidak pernah diisi nol."
        footer={
          <span>Klik satu baris untuk membuka detail program beserta timeline persetujuannya.</span>
        }
      >
        <p className="penjelasan">
          Kolom LPJ menampilkan status Laporan Pertanggungjawaban program, terpisah dari status
          proposal: sebuah program bisa berstatus Menunggu LPJ sementara LPJ nya sendiri belum ada.
          Tanggal proposal dan pemetaan SDG dipakai sebagai penyaring pada daftar ini dan
          ditampilkan lengkap pada halaman detail program. Total nilai diajukan pada baris tab
          dihitung dari seluruh proposal yang lolos filter, bukan hanya tab yang sedang terbuka,
          dan dijumlahkan dalam satuan sen tanpa melewati bilangan pecahan.
        </p>
      </Panel>

      <CatatanOtorisasi tambahan="Daftar ini hanya memuat cabang yang boleh Anda lihat." />
    </HalamanModul>
  );
}
