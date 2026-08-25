// Realisasi Akad, spec 9.1.
//
// The akad does NOT re-ask for the principal, the tenor or the rate. Those
// come from the approval row, so an akad can never disagree with what was
// approved (spec 9.1, scenario 3), and the panel on the right shows the
// approved figures precisely so the operator can see that they are not
// editable here and why.
//
// What this step really adds is the contract date, the schedule shape and the
// document.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  FilePicker,
  Panel,
  Select,
  StatusBadge,
  TextInput,
  formatCount,
  formatDate,
  formatMoney,
  formatRate,
} from "@krakatausteel/ui";
import {
  batasanPumk,
  buatAkad,
  daftarProposal,
  detailProposal,
  generateJadwal,
  unggahLampiran,
  type BarisProposal,
  type MetodePerhitungan,
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
  CatatanPencatatan,
  DaftarDokumen,
  FieldGrid,
  FormLayout,
  hariIni,
  KembaliKeAntrean,
  Muat,
  PumkPage,
  usePilihan,
  type ColumnSpec,
} from "./parts";

const METODE: Array<{ value: MetodePerhitungan; label: string }> = [
  { value: "FLAT", label: "Flat" },
  { value: "EFEKTIF", label: "Efektif" },
  { value: "ANUITAS", label: "Anuitas" },
];

const ANTREAN_COLUMNS: readonly ColumnSpec<BarisProposal>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "150px" },
  { key: "mitraNama", header: "Mitra Binaan", sortable: true },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  { key: "umurHari", header: "Umur (hari)", type: "count", sortable: true, width: "120px" },
];

export function AkadForm({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const antrean = useApi(
    () => daftarProposal({ cabangId: session.cabang.id, status: "DISETUJUI" }),
    [session.cabang.id],
    { enabled: proposalId === null },
  );
  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const batas = useApi(() => batasanPumk(), []);

  const [tanggalAkad, setTanggalAkad] = useState(hariIni());
  const [tanggalMulai, setTanggalMulai] = useState("");
  const [grace, setGrace] = useState("0");
  const [metode, setMetode] = useState<MetodePerhitungan>("FLAT");
  const [dokumen, setDokumen] = useState<File[]>([]);
  const [gagalUnggah, setGagalUnggah] = useState<string | null>(null);
  const [konfirmasi, setKonfirmasi] = useState(false);

  const simpan = useAction(buatAkad);
  const jadwal = useAction(generateJadwal);

  const graceAngka = Number(grace || "0");
  const graceMaks = batas.data?.gracePeriodMax ?? null;
  const graceLewat = graceMaks !== null && graceAngka > graceMaks;
  const lengkap = tanggalAkad !== "" && tanggalMulai !== "" && !graceLewat;

  async function buat() {
    if (!proposalId || !lengkap) return;
    setGagalUnggah(null);
    let path: string | null = null;
    if (dokumen[0]) {
      try {
        path = (await unggahLampiran(dokumen[0], `akad:${proposalId}`)).path;
      } catch (cause) {
        setGagalUnggah(
          cause instanceof Error
            ? `Dokumen akad gagal diunggah, akad tidak dibuat. ${cause.message}`
            : "Dokumen akad gagal diunggah, akad tidak dibuat.",
        );
        return;
      }
    }
    const akad = await simpan.jalankan({
      proposalId,
      tanggalAkad,
      tanggalMulaiAngsuran: tanggalMulai,
      gracePeriodBulan: graceAngka,
      metodePerhitungan: metode,
      pathDokumenAkad: path,
    });
    if (akad) {
      setKonfirmasi(false);
      // Generating the schedule is the next transition, and it is the engine's
      // arithmetic, not this page's: if it fails the akad still exists and the
      // operator is told, rather than being shown a schedule that was never
      // written.
      const hasil = await jadwal.jalankan(akad.id);
      navigate(hasil ? `/pumk/jadwal?akad=${akad.id}` : `/pumk/proposal/${proposalId}`);
    }
  }

  if (proposalId === null) {
    return (
      <PumkPage route={route}>
        <Muat
          hasil={antrean}
          judul="antrean akad"
          sumber="GET /api/pumk/proposal?status=DISETUJUI"
        >
          {(data) =>
            data.data.length === 0 ? (
              <AntreanKosong
                icon="file"
                title="Tidak ada proposal yang siap diakadkan"
                description="Proposal masuk ke antrean ini setelah Approver menyetujuinya."
              />
            ) : (
              <Panel
                as="h2"
                title="Siap diakadkan"
                description="Pilih satu proposal yang sudah disetujui untuk dibuatkan akad."
                footer={<span>{formatCount(data.data.length)} proposal menunggu akad.</span>}
              >
                <DaftarDokumen
                  columns={ANTREAN_COLUMNS}
                  rows={data.data}
                  rowKey={(row) => row.id}
                  onPilih={(row) => setProposalId(row.id)}
                  emptyTitle="Tidak ada proposal yang siap diakadkan"
                  emptyDescription="Antrean terisi setelah Approver menyetujui sebuah proposal."
                  kartu={(row) => ({
                    judul: row.mitraNama,
                    sub: row.noProposal,
                    nilai: formatMoney(row.jumlahDiajukan),
                    nilaiLabel: "Diajukan",
                    meta: `umur ${row.umurHari} hari`,
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
      back={{ to: "/pumk/akad", label: "Antrean akad" }}
    >
      <Muat hasil={detail} judul="data akad" sumber={`GET /api/pumk/proposal/${proposalId}`}>
        {(data) => (
          <>
            <FormLayout
              form={
                <div className="form-main">
                  <Bagian
                    title="Data akad"
                    description="Pokok, tenor, dan rate tidak diisi di sini. Ketiganya dibaca dari keputusan Approver agar akad tidak pernah berbeda dari yang disetujui."
                  >
                    <FieldGrid>
                      <Field label="Tanggal akad" htmlFor="tanggal-akad" required>
                        <TextInput
                          id="tanggal-akad"
                          type="date"
                          value={tanggalAkad}
                          onChange={(event) => setTanggalAkad(event.currentTarget.value)}
                        />
                      </Field>
                      <Field
                        label="Tanggal mulai angsuran"
                        htmlFor="tanggal-mulai"
                        required
                        hint="Jatuh tempo angsuran berikutnya mengikuti tanggal ini."
                      >
                        <TextInput
                          id="tanggal-mulai"
                          type="date"
                          value={tanggalMulai}
                          onChange={(event) => setTanggalMulai(event.currentTarget.value)}
                        />
                      </Field>
                      <Field
                        label="Grace period (bulan)"
                        htmlFor="grace"
                        hint={
                          graceMaks === null
                            ? "Batas grace period belum terbaca dari server."
                            : `Maksimal ${formatCount(graceMaks)} bulan.`
                        }
                        error={graceLewat ? "Grace period melewati batas Parameter Sistem." : undefined}
                      >
                        <TextInput
                          id="grace"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={grace}
                          invalid={graceLewat}
                          onChange={(event) => setGrace(event.currentTarget.value)}
                        />
                      </Field>
                      <Field
                        label="Metode perhitungan"
                        htmlFor="metode"
                        hint={
                          batas.data
                            ? `Default Parameter Sistem: ${batas.data.jasaAdmMetodeDefault}.`
                            : "Default belum terbaca dari server."
                        }
                      >
                        <Select
                          id="metode"
                          value={metode}
                          onChange={(event) =>
                            setMetode(event.currentTarget.value as MetodePerhitungan)
                          }
                          options={METODE}
                        />
                      </Field>
                    </FieldGrid>
                  </Bagian>

                  <Bagian
                    title="Dokumen akad"
                    description="Berkas diunggah saat Anda menyimpan. Akad hanya dibuat bila berkas berhasil tersimpan."
                  >
                    <FilePicker
                      label="Pilih dokumen akad"
                      accept="application/pdf,image/*"
                      multiple={false}
                      files={dokumen}
                      onChange={setDokumen}
                      hint="Satu berkas, format PDF atau gambar hasil pindai."
                    />
                  </Bagian>

                  <BarisAksi
                    error={gagalUnggah ?? simpan.error ?? jadwal.error}
                    secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                    primary={
                      <Button
                        variant="primary"
                        disabled={!lengkap}
                        loading={simpan.status === "mengirim" || jadwal.status === "mengirim"}
                        loadingLabel="Membuat akad"
                        onClick={() => setKonfirmasi(true)}
                      >
                        Buat akad dan jadwal
                      </Button>
                    }
                  />
                </div>
              }
              aside={
                <aside className="form-aside">
                  <Panel
                    as="h2"
                    title="Nilai hasil persetujuan"
                    aside={<StatusBadge status={data.proposal.status} />}
                    footer={
                      <span>
                        Nilai ini dibaca dari pumk_approval dan dipakai apa adanya oleh akad.
                      </span>
                    }
                  >
                    <DataList
                      items={[
                        {
                          label: "Plafon disetujui",
                          value: data.approval?.plafonDisetujui
                            ? formatMoney(data.approval.plafonDisetujui)
                            : "Belum ada",
                          numeric: true,
                        },
                        {
                          label: "Tenor disetujui",
                          value: data.approval?.tenorDisetujui
                            ? `${formatCount(data.approval.tenorDisetujui)} bulan`
                            : "Belum ada",
                          numeric: true,
                        },
                        {
                          label: "Rate Jasa Administrasi",
                          value: data.approval?.jasaAdmRate
                            ? `${formatRate(data.approval.jasaAdmRate)} persen`
                            : "Memakai default Parameter Sistem",
                          numeric: true,
                        },
                        {
                          label: "Nilai diajukan semula",
                          value: formatMoney(data.proposal.jumlahDiajukan),
                          numeric: true,
                        },
                      ]}
                    />
                  </Panel>

                  <Panel
                    as="h2"
                    title="Mitra Binaan"
                    footer={
                      <span>
                        Satu mitra hanya boleh memiliki satu akad aktif sesuai Parameter Sistem.
                      </span>
                    }
                  >
                    <DataList
                      items={[
                        { label: "Nama", value: data.proposal.mitraNama },
                        { label: "Kode mitra", value: data.proposal.mitraKode },
                        { label: "No proposal", value: data.proposal.noProposal },
                        { label: "Tanggal proposal", value: formatDate(data.proposal.tanggalProposal) },
                      ]}
                    />
                  </Panel>
                </aside>
              }
            />

            <ConfirmDialog
              open={konfirmasi}
              title="Konfirmasi pembuatan akad"
              description="Akad dibuat dari nilai hasil persetujuan, lalu jadwal angsuran dibentuk oleh engine angsuran."
              confirmLabel="Buat akad"
              loading={simpan.status === "mengirim" || jadwal.status === "mengirim"}
              error={simpan.error ?? jadwal.error}
              onCancel={() => setKonfirmasi(false)}
              onConfirm={buat}
            >
              <DataList
                items={[
                  { label: "Proposal", value: data.proposal.noProposal },
                  { label: "Mitra Binaan", value: data.proposal.mitraNama },
                  {
                    label: "Pokok pinjaman",
                    value: data.approval?.plafonDisetujui
                      ? formatMoney(data.approval.plafonDisetujui)
                      : "Dibaca dari persetujuan",
                    numeric: true,
                  },
                  { label: "Tanggal akad", value: formatDate(tanggalAkad) },
                  { label: "Mulai angsuran", value: formatDate(tanggalMulai) },
                  { label: "Grace period", value: `${formatCount(graceAngka)} bulan`, numeric: true },
                  { label: "Metode", value: metode },
                ]}
              />
            </ConfirmDialog>
          </>
        )}
      </Muat>
      <CatatanPencatatan />
      <CatatanOtorisasi />
    </PumkPage>
  );
}
