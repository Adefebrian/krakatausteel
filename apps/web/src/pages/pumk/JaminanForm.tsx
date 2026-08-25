// Profil Jaminan, spec 9.1 and spec 4.4's `pumk_jaminan`.
//
// One proposal, many jaminan. The form adds ONE at a time and the table above
// it is the record as the server holds it, re-read after every save, so the
// page never shows a jaminan that the server did not confirm.
import { useState } from "react";
import {
  Button,
  DataList,
  DataTable,
  Field,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
  formatCount,
  formatMoney,
  formatRupiah,
  formatTotal,
  type Column,
} from "@krakatausteel/ui";
import {
  batasanPumk,
  daftarJaminan,
  daftarProposal,
  detailProposal,
  tambahJaminan,
  type BarisJaminan,
  type BarisProposal,
} from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  DaftarDokumen,
  FieldGrid,
  FormLayout,
  hariIni,
  Muat,
  PumkPage,
  usePilihan,
  type ColumnSpec,
} from "./parts";

const JENIS = [
  { value: "BPKB", label: "BPKB kendaraan" },
  { value: "SHM", label: "SHM tanah" },
  { value: "SHGB", label: "SHGB" },
  { value: "AJB", label: "AJB" },
  { value: "DEPOSITO", label: "Deposito" },
  { value: "TANPA_JAMINAN", label: "Tanpa jaminan" },
  { value: "LAINNYA", label: "Lainnya" },
] as const;

const JAMINAN_COLUMNS: readonly Column<BarisJaminan>[] = [
  { key: "jenis", header: "Jenis", width: "140px" },
  { key: "deskripsi", header: "Deskripsi", render: (row) => row.deskripsi ?? "Belum diisi" },
  { key: "atasNama", header: "Atas nama", render: (row) => row.atasNama ?? "Belum diisi" },
  { key: "nomorDokumen", header: "No dokumen", render: (row) => row.nomorDokumen ?? "Belum diisi" },
  { key: "nilaiTaksasi", header: "Nilai taksasi", type: "money", width: "150px" },
  { key: "tanggalTerima", header: "Diterima", type: "date", width: "120px" },
];

const ANTREAN_COLUMNS: readonly ColumnSpec<BarisProposal>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "150px" },
  { key: "mitraNama", header: "Mitra Binaan", sortable: true },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  {
    key: "status",
    header: "Status",
    sortable: true,
    width: "180px",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

export function JaminanForm({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const antrean = useApi(() => daftarProposal({ cabangId: session.cabang.id }), [session.cabang.id], {
    enabled: proposalId === null,
  });
  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const jaminan = useApi(() => daftarJaminan(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const batas = useApi(() => batasanPumk(), []);

  const [jenis, setJenis] = useState<(typeof JENIS)[number]["value"]>("BPKB");
  const [deskripsi, setDeskripsi] = useState("");
  const [nilai, setNilai] = useState("");
  const [nilaiTerbaca, setNilaiTerbaca] = useState(true);
  const [nomorDokumen, setNomorDokumen] = useState("");
  const [atasNama, setAtasNama] = useState("");
  const [lokasi, setLokasi] = useState("");
  const [tanggalTerima, setTanggalTerima] = useState(hariIni());

  const tambah = useAction((input: Parameters<typeof tambahJaminan>[1]) =>
    tambahJaminan(proposalId ?? "", input),
  );

  const tanpaJaminan = jenis === "TANPA_JAMINAN";
  const lengkap = nilaiTerbaca && (tanpaJaminan || (deskripsi.trim() !== "" && nilai !== ""));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!lengkap || !proposalId) return;
    const hasil = await tambah.jalankan({
      jenis,
      deskripsi: deskripsi.trim() || null,
      nilaiTaksasi: tanpaJaminan ? null : nilai || null,
      nomorDokumen: nomorDokumen.trim() || null,
      atasNama: atasNama.trim() || null,
      lokasi: lokasi.trim() || null,
      tanggalTerima: tanpaJaminan ? null : tanggalTerima,
    });
    if (hasil) {
      setDeskripsi("");
      setNilai("");
      setNomorDokumen("");
      setAtasNama("");
      setLokasi("");
      jaminan.reload();
    }
  }

  if (proposalId === null) {
    return (
      <PumkPage route={route}>
        <Muat hasil={antrean} judul="daftar proposal" sumber="GET /api/pumk/proposal">
          {(data) =>
            data.data.length === 0 ? (
              <AntreanKosong
                icon="lock"
                title="Belum ada proposal pada cabang ini"
                description="Buat proposal terlebih dahulu, jaminan dicatat pada proposal yang sudah tersimpan."
              />
            ) : (
              <Panel
                as="h2"
                title="Pilih proposal"
                description="Jaminan selalu melekat pada satu proposal."
                footer={<span>{formatCount(data.data.length)} proposal pada cabang Anda.</span>}
              >
                <DaftarDokumen
                  columns={ANTREAN_COLUMNS}
                  rows={data.data}
                  rowKey={(row) => row.id}
                  onPilih={(row) => setProposalId(row.id)}
                  emptyTitle="Belum ada proposal"
                  emptyDescription="Jaminan dicatat setelah proposal tersimpan."
                  kartu={(row) => ({
                    judul: row.mitraNama,
                    sub: row.noProposal,
                    nilai: formatMoney(row.jumlahDiajukan),
                    nilaiLabel: "Diajukan",
                    meta: row.sektorNama ?? "Sektor belum diisi",
                    status: <StatusBadge status={row.status} />,
                  })}
                />
              </Panel>
            )
          }
        </Muat>
        <CatatanOtorisasi />
      </PumkPage>
    );
  }

  return (
    <PumkPage
      route={route}
      back={{ to: "/pumk/jaminan", label: "Pilih proposal lain" }}
    >
      <Muat hasil={detail} judul="data proposal" sumber={`GET /api/pumk/proposal/${proposalId}`}>
        {(data) => (
          <FormLayout
            form={
              <div className="form-main">
                <Panel
                  as="h2"
                  title="Jaminan tercatat"
                  description="Daftar ini dibaca ulang dari server setiap kali satu jaminan tersimpan."
                  footer={
                    <span>
                      Total nilai taksasi{" "}
                      {formatTotal((jaminan.data?.data ?? []).map((row) => row.nilaiTaksasi))}
                    </span>
                  }
                >
                  <Muat
                    hasil={jaminan}
                    judul="daftar jaminan"
                    sumber={`GET /api/pumk/proposal/${proposalId}/jaminan`}
                  >
                    {(isi) => (
                      <DataTable
                        columns={JAMINAN_COLUMNS}
                        rows={isi.data}
                        rowKey={(row) => row.id}
                        emptyTitle="Belum ada jaminan pada proposal ini"
                        emptyDescription="Tambahkan jaminan pada form di bawah."
                      />
                    )}
                  </Muat>
                </Panel>

                <form onSubmit={submit}>
                  <Bagian
                    title="Tambah jaminan"
                    description="Satu proposal dapat memiliki lebih dari satu jaminan. Isi form ini sekali untuk setiap jaminan."
                  >
                    <FieldGrid>
                      <Field label="Jenis jaminan" htmlFor="jenis-jaminan" required>
                        <Select
                          id="jenis-jaminan"
                          value={jenis}
                          onChange={(event) =>
                            setJenis(event.currentTarget.value as (typeof JENIS)[number]["value"])
                          }
                          options={JENIS.map((item) => ({ value: item.value, label: item.label }))}
                        />
                      </Field>
                      <Field
                        label="Nilai taksasi"
                        htmlFor="nilai-taksasi"
                        required={!tanpaJaminan}
                        hint={tanpaJaminan ? "Tidak diisi untuk jaminan jenis Tanpa Jaminan." : undefined}
                        error={nilaiTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                      >
                        <MoneyInput
                          id="nilai-taksasi"
                          value={nilai}
                          disabled={tanpaJaminan}
                          invalid={!nilaiTerbaca}
                          onValueChange={(value, raw) => {
                            setNilai(value ?? "");
                            setNilaiTerbaca(raw.trim() === "" || value !== null);
                          }}
                        />
                      </Field>
                      <Field label="Nomor dokumen" htmlFor="nomor-dokumen">
                        <TextInput
                          id="nomor-dokumen"
                          value={nomorDokumen}
                          onChange={(event) => setNomorDokumen(event.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Atas nama" htmlFor="atas-nama">
                        <TextInput
                          id="atas-nama"
                          value={atasNama}
                          onChange={(event) => setAtasNama(event.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Lokasi jaminan" htmlFor="lokasi-jaminan">
                        <TextInput
                          id="lokasi-jaminan"
                          value={lokasi}
                          onChange={(event) => setLokasi(event.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Tanggal terima" htmlFor="tanggal-terima">
                        <TextInput
                          id="tanggal-terima"
                          type="date"
                          value={tanggalTerima}
                          disabled={tanpaJaminan}
                          onChange={(event) => setTanggalTerima(event.currentTarget.value)}
                        />
                      </Field>
                    </FieldGrid>
                    <Field label="Deskripsi" htmlFor="deskripsi-jaminan" required={!tanpaJaminan}>
                      <Textarea
                        id="deskripsi-jaminan"
                        rows={2}
                        value={deskripsi}
                        placeholder="Contoh: sepeda motor Honda Vario 2019, warna hitam"
                        onChange={(event) => setDeskripsi(event.currentTarget.value)}
                      />
                    </Field>
                  </Bagian>

                  <BarisAksi
                    error={tambah.error}
                    primary={
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={!lengkap}
                        loading={tambah.status === "mengirim"}
                        loadingLabel="Menyimpan"
                      >
                        Tambahkan jaminan
                      </Button>
                    }
                  />
                </form>
              </div>
            }
            aside={
              <aside className="form-aside">
                <Panel
                  as="h2"
                  title="Proposal"
                  aside={<StatusBadge status={data.proposal.status} />}
                  footer={<span>Jaminan melekat pada proposal, bukan pada Mitra Binaan.</span>}
                >
                  <DataList
                    items={[
                      { label: "No proposal", value: data.proposal.noProposal },
                      { label: "Mitra Binaan", value: data.proposal.mitraNama },
                      {
                        label: "Nilai diajukan",
                        value: formatMoney(data.proposal.jumlahDiajukan),
                        numeric: true,
                      },
                      { label: "Sektor", value: data.proposal.sektorNama ?? "Belum diisi" },
                    ]}
                  />
                </Panel>
                <Panel
                  as="h2"
                  title="Ambang wajib jaminan"
                  footer={
                    <span>
                      Nilai ambang dibaca dari Parameter Sistem dan ditegakkan ulang oleh engine.
                    </span>
                  }
                >
                  {batas.status === "gagal" ? (
                    <p className="penjelasan">
                      Ambang wajib jaminan tidak dapat dibaca dari server, jadi halaman ini tidak
                      menampilkan angkanya.
                    </p>
                  ) : batas.data ? (
                    <DataList
                      items={[
                        {
                          label: "Wajib jaminan di atas",
                          value: formatMoney(batas.data.wajibJaminanDiAtasPlafon),
                          numeric: true,
                        },
                        {
                          label: "Nilai proposal ini",
                          value: formatMoney(data.proposal.jumlahDiajukan),
                          numeric: true,
                        },
                      ]}
                    />
                  ) : (
                    <p className="muat-memuat" role="status">
                      Memuat ambang wajib jaminan.
                    </p>
                  )}
                  <p className="penjelasan">
                    Proposal dengan nilai di atas {batas.data ? formatRupiah(batas.data.wajibJaminanDiAtasPlafon) : "ambang tersebut"}{" "}
                    wajib memiliki minimal satu jaminan selain Tanpa Jaminan.
                  </p>
                </Panel>
              </aside>
            }
          />
        )}
      </Muat>
      <CatatanOtorisasi />
    </PumkPage>
  );
}
