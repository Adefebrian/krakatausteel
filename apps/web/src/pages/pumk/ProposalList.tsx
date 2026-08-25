// Daftar Proposal Pendanaan UMK, spec 9.1.
//
// The two tabs the spec names are a SPLIT OF ONE ANSWER, not two requests:
// the list is read once and partitioned on `sumberPengajuan`, so the count on
// each tab is a real count of the same filtered set and switching tabs never
// shows a number that was measured under different filters.
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
  formatCount,
  formatMoney,
  formatTotal,
  STATUS_PROPOSAL_PUMK,
  TextInput,
} from "@krakatausteel/ui";
import { daftarProposal, daftarSektor, type BarisProposal } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  type ColumnSpec,
  DaftarDokumen,
  HalamanModul,
  Muat,
  Penyaring,
} from "../shared/parts";

const STATUS_OPTIONS = [
  { value: "", label: "Semua status" },
  ...Object.entries(STATUS_PROPOSAL_PUMK).map(([value, meta]) => ({ value, label: meta.label })),
];

const COLUMNS: readonly ColumnSpec<BarisProposal>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "170px" },
  { key: "tanggalProposal", header: "Tanggal", type: "date", sortable: true, width: "130px" },
  {
    key: "mitraNama",
    header: "Mitra Binaan",
    sortable: true,
    render: (row) => (
      <span className="sel-utama">
        <span className="sel-utama-judul">{row.mitraNama}</span>
        <span className="sel-utama-sub">
          {row.mitraKode}
          {row.mitraNik ? ` . NIK ${row.mitraNik}` : ""}
        </span>
      </span>
    ),
  },
  {
    key: "sektorNama",
    header: "Sektor",
    sortable: true,
    width: "150px",
    render: (row) => row.sektorNama ?? "Belum diisi",
  },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  { key: "tenorDiajukan", header: "Tenor", type: "count", sortable: true, width: "90px" },
  {
    key: "status",
    header: "Status",
    sortable: true,
    width: "180px",
    render: (row) => <StatusBadge status={row.status} />,
  },
  { key: "umurHari", header: "Umur (hari)", type: "count", sortable: true, width: "120px" },
];

export function ProposalList({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();

  const [cabangId, setCabangId] = useState(session.cabang.id);
  const [sektorId, setSektorId] = useState("");
  const [status, setStatus] = useState("");
  const [dariTanggal, setDariTanggal] = useState("");
  const [sampaiTanggal, setSampaiTanggal] = useState("");
  const [cari, setCari] = useState("");
  const [tab, setTab] = useState("INTERNAL");

  const filter = useMemo(
    () => ({
      cabangId: cabangId === "SEMUA" ? null : cabangId,
      sektorId: sektorId || null,
      status: status ? (status as BarisProposal["status"]) : null,
      dariTanggal: dariTanggal || null,
      sampaiTanggal: sampaiTanggal || null,
      cari: cari.trim() || null,
    }),
    [cabangId, sektorId, status, dariTanggal, sampaiTanggal, cari],
  );

  const daftar = useApi(() => daftarProposal(filter), [JSON.stringify(filter)]);
  const sektor = useApi(() => daftarSektor(), []);

  const cabangOptions = [
    ...(session.lintasCabang ? [{ value: "SEMUA", label: "Semua cabang" }] : []),
    ...session.cabangTersedia.map((cabang) => ({
      value: cabang.id,
      label: `${cabang.kode} ${cabang.nama}`,
    })),
  ];

  const sektorOptions = [
    { value: "", label: "Semua sektor" },
    ...(sektor.data?.data ?? []).map((item) => ({ value: item.id, label: item.nama })),
  ];

  const rows = daftar.data?.data ?? [];
  const internal = rows.filter((row) => row.sumberPengajuan === "INTERNAL");
  const portal = rows.filter((row) => row.sumberPengajuan === "PORTAL_ONLINE");
  const terpilih = tab === "INTERNAL" ? internal : portal;

  function reset() {
    setCabangId(session.cabang.id);
    setSektorId("");
    setStatus("");
    setDariTanggal("");
    setSampaiTanggal("");
    setCari("");
  }

  return (
    <HalamanModul
      route={route}
      actions={
        hasPermission(session.permissions, "pumk.create") ? (
          <Button
            variant="primary"
            leading={<Icon name="plus" size={16} />}
            onClick={() => navigate("/pumk/proposal/baru")}
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
          status ? (STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status) : "Semua status",
          sektorId ? (sektorOptions.find((item) => item.value === sektorId)?.label ?? "Sektor") : "Semua sektor",
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
        searchLabel="Cari nama atau NIK"
        searchPlaceholder="Nama Mitra Binaan atau NIK"
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
          <span className="filterbar-label">Sektor</span>
          <Select
            aria-label="Sektor"
            value={sektorId}
            disabled={sektor.status === "gagal"}
            onChange={(event) => setSektorId(event.currentTarget.value)}
            options={sektorOptions}
          />
          {sektor.status === "gagal" ? (
            <span className="filterbar-gagal">Daftar sektor tidak dapat dimuat dari server.</span>
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

      <Muat hasil={daftar} judul="daftar proposal" sumber="GET /api/pumk/proposal">
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
                onPilih={(row) => navigate(`/pumk/proposal/${row.id}`)}
                caption={
                  tab === "INTERNAL"
                    ? "Proposal yang diinput petugas cabang"
                    : "Proposal yang masuk melalui Portal Online dan sudah dikonversi"
                }
                emptyTitle={
                  tab === "INTERNAL"
                    ? "Belum ada proposal internal pada filter ini"
                    : "Belum ada proposal dari Portal Online pada filter ini"
                }
                emptyDescription="Ubah filter tanggal, cabang, sektor, atau status untuk melihat proposal lain."
                kartu={(row) => ({
                  judul: row.mitraNama,
                  sub: `${row.noProposal} . ${row.sektorNama ?? "Sektor belum diisi"}`,
                  nilai: formatMoney(row.jumlahDiajukan),
                  nilaiLabel: "Diajukan",
                  meta: `${row.tenorDiajukan} bulan . umur ${row.umurHari} hari`,
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
        description="Tab memisahkan asal pengajuan, bukan statusnya. Proposal Portal Online yang sudah dikonversi tetap tampil di tab Daftar Pemohon Online beserta nomor proposal internalnya."
        footer={
          <span>Klik satu baris untuk membuka detail proposal beserta timeline persetujuannya.</span>
        }
      >
        <p className="penjelasan">
          Kolom umur dihitung dari tanggal proposal sampai hari ini, dipakai untuk memantau dokumen
          yang tertahan di satu tahap terlalu lama. Total nilai diajukan pada baris tab dihitung
          dari seluruh proposal yang lolos filter, bukan hanya tab yang sedang terbuka.
        </p>
      </Panel>

      <CatatanOtorisasi tambahan="Daftar ini hanya memuat cabang yang boleh Anda lihat." />
    </HalamanModul>
  );
}
