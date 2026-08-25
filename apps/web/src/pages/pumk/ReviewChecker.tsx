// Review Checker, spec 9.1.
//
// The layout the spec asks for is the point: proposal data and survey result
// SIDE BY SIDE, one row per fact, so a checker reads "diajukan 25.000.000,00"
// against "rekomendasi survey 20.000.000,00" on one line instead of holding
// one number in their head while scrolling to the other.
//
// Three outcomes, and two of them require a note. Spec 2 rule 1 refuses a
// checker who is the proposal's own maker; this page says so before the click
// and the engine and the database trigger refuse it after.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Icon,
  Panel,
  StatusBadge,
  Textarea,
  formatCount,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import {
  daftarProposal,
  detailProposal,
  review,
  type BarisProposal,
  type KeputusanChecker,
} from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  BarisAksi,
  CatatanOtorisasi,
  type ColumnSpec,
  DaftarDokumen,
  HalamanModul,
  hariIni,
  KembaliKeAntrean,
  Muat,
  usePilihan,
} from "../shared/parts";

const ANTREAN_COLUMNS: readonly ColumnSpec<BarisProposal>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "150px" },
  { key: "mitraNama", header: "Mitra Binaan", sortable: true },
  { key: "sektorNama", header: "Sektor", sortable: true, width: "150px", render: (row) => row.sektorNama ?? "Belum diisi" },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  { key: "umurHari", header: "Umur (hari)", type: "count", sortable: true, width: "120px" },
];

const KEPUTUSAN: Array<{ id: KeputusanChecker; label: string; catatanWajib: boolean; tone: "primary" | "danger" | "secondary" }> = [
  { id: "REKOMENDASI", label: "Rekomendasikan", catatanWajib: false, tone: "primary" },
  { id: "MINTA_PERBAIKAN", label: "Minta perbaikan", catatanWajib: true, tone: "secondary" },
  { id: "TIDAK_REKOMENDASI", label: "Tidak rekomendasi", catatanWajib: true, tone: "danger" },
];

export function ReviewChecker({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const antrean = useApi(
    () => daftarProposal({ cabangId: session.cabang.id, status: "REVIEW_CHECKER" }),
    [session.cabang.id],
    { enabled: proposalId === null },
  );
  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });

  const [keputusan, setKeputusan] = useState<KeputusanChecker>("REKOMENDASI");
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(review);

  const pilihan = KEPUTUSAN.find((item) => item.id === keputusan) ?? KEPUTUSAN[0]!;
  const catatanKurang = pilihan.catatanWajib && catatan.trim() === "";

  async function putuskan() {
    if (!proposalId) return;
    const hasil = await kirim.jalankan({
      proposalId,
      tanggal: hariIni(),
      keputusan,
      catatan: catatan.trim() || null,
    });
    if (hasil) {
      setKonfirmasi(false);
      navigate(`/pumk/proposal/${proposalId}`);
    }
  }

  if (proposalId === null) {
    return (
      <HalamanModul route={route}>
        <Muat
          hasil={antrean}
          judul="antrean review"
          sumber="GET /api/pumk/proposal?status=REVIEW_CHECKER"
        >
          {(data) =>
            data.data.length === 0 ? (
              <AntreanKosong
                icon="checkCircle"
                title="Tidak ada proposal yang menunggu review"
                description="Proposal masuk ke antrean ini setelah Maker mengajukannya ke Checker."
              />
            ) : (
              <Panel
                as="h2"
                title="Menunggu review Checker"
                description="Pilih satu proposal untuk membandingkan data pengajuan dengan hasil survey."
                footer={<span>{formatCount(data.data.length)} proposal menunggu review.</span>}
              >
                <DaftarDokumen
                  columns={ANTREAN_COLUMNS}
                  rows={data.data}
                  rowKey={(row) => row.id}
                  onPilih={(row) => setProposalId(row.id)}
                  emptyTitle="Tidak ada proposal yang menunggu review"
                  emptyDescription="Antrean terisi setelah Maker mengajukan proposal ke Checker."
                  kartu={(row) => ({
                    judul: row.mitraNama,
                    sub: `${row.noProposal} . ${row.sektorNama ?? "Sektor belum diisi"}`,
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
      </HalamanModul>
    );
  }

  return (
    <HalamanModul
      route={route}
      back={{ to: "/pumk/review", label: "Antrean review" }}
    >
      <Muat hasil={detail} judul="data review" sumber={`GET /api/pumk/proposal/${proposalId}`}>
        {(data) => {
          const { proposal, survey } = data;
          const makerSendiri = proposal.createdBy !== null && proposal.createdBy === session.user.id;
          const banding = [
            {
              label: "Nilai",
              diajukan: formatMoney(proposal.jumlahDiajukan),
              survey: survey ? formatMoney(survey.plafonRekomendasi ?? "0.00") : "Belum disurvey",
            },
            {
              label: "Tenor",
              diajukan: `${formatCount(proposal.tenorDiajukan)} bulan`,
              survey: survey ? `${formatCount(survey.tenorRekomendasi ?? 0)} bulan` : "Belum disurvey",
            },
            {
              label: "Tanggal",
              diajukan: formatDate(proposal.tanggalProposal),
              survey: survey ? formatDate(survey.tanggalSurvey) : "Belum disurvey",
            },
          ];

          return (
            <>
              {makerSendiri ? (
                <div className="peringatan" role="alert">
                  <Icon name="lock" size={18} />
                  <div>
                    <p className="peringatan-judul">Anda adalah Maker proposal ini</p>
                    <p className="peringatan-teks">
                      Satu orang tidak boleh menjadi Maker sekaligus Checker pada dokumen yang sama.
                      Permintaan review dari akun ini akan ditolak server dan penolakannya tercatat
                      pada audit log.
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="banding">
                <Panel
                  as="h2"
                  title="Data proposal"
                  aside={<StatusBadge status={proposal.status} />}
                  footer={<span>Diinput oleh Maker cabang {proposal.cabangNama}.</span>}
                >
                  <DataList
                    items={[
                      { label: "No proposal", value: proposal.noProposal },
                      { label: "Mitra Binaan", value: proposal.mitraNama },
                      { label: "NIK", value: proposal.mitraNik ?? "Belum diisi" },
                      { label: "Sektor", value: proposal.sektorNama ?? "Belum diisi" },
                      {
                        label: "Nilai diajukan",
                        value: formatMoney(proposal.jumlahDiajukan),
                        numeric: true,
                      },
                      {
                        label: "Tenor diajukan",
                        value: `${formatCount(proposal.tenorDiajukan)} bulan`,
                        numeric: true,
                      },
                      {
                        label: "Tujuan penggunaan",
                        value: proposal.tujuanPenggunaan ?? "Belum diisi",
                        wide: true,
                      },
                    ]}
                  />
                </Panel>

                <Panel
                  as="h2"
                  title="Hasil survey"
                  aside={
                    survey ? (
                      <StatusBadge status="SURVEY_SELESAI" />
                    ) : (
                      <StatusBadge status="SURVEY_PENDING" />
                    )
                  }
                  footer={
                    <span>
                      {survey
                        ? "Skor dan rekomendasi berasal dari kunjungan lapangan."
                        : "Belum ada hasil survey untuk proposal ini."}
                    </span>
                  }
                >
                  {survey ? (
                    <DataList
                      items={[
                        { label: "Tanggal survey", value: formatDate(survey.tanggalSurvey) },
                        { label: "Skor total", value: formatMoney(survey.skorTotal ?? "0.00"), numeric: true },
                        {
                          label: "Plafon rekomendasi",
                          value: formatMoney(survey.plafonRekomendasi ?? "0.00"),
                          numeric: true,
                        },
                        {
                          label: "Tenor rekomendasi",
                          value: `${formatCount(survey.tenorRekomendasi ?? 0)} bulan`,
                          numeric: true,
                        },
                        { label: "Jaminan tercatat", value: formatCount(data.jaminan.length), numeric: true },
                        { label: "Catatan surveyor", value: survey.catatan ?? "Tidak ada catatan", wide: true },
                      ]}
                    />
                  ) : (
                    <p className="penjelasan">
                      Hasil survey belum diinput, jadi tidak ada pembanding untuk data pengajuan.
                    </p>
                  )}
                </Panel>
              </div>

              <Panel
                as="h2"
                title="Perbandingan langsung"
                description="Nilai pengajuan Mitra Binaan berdampingan dengan rekomendasi hasil survey."
                footer={<span>Selisih di antara keduanya adalah bahan pertimbangan Approver.</span>}
              >
                <div className="banding-tabel">
                  <div className="banding-baris banding-kepala">
                    <span>Aspek</span>
                    <span>Diajukan</span>
                    <span>Rekomendasi survey</span>
                  </div>
                  {banding.map((baris) => (
                    <div className="banding-baris" key={baris.label}>
                      <span className="banding-label">{baris.label}</span>
                      <span className="banding-nilai">{baris.diajukan}</span>
                      <span className="banding-nilai">{baris.survey}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel
                as="h2"
                title="Keputusan Checker"
                description="Tidak rekomendasi dan minta perbaikan wajib disertai catatan. Catatan tersimpan pada timeline proposal."
                footer={
                  <span>
                    Keputusan ini memindahkan status dokumen dan tidak dapat dibatalkan dari halaman
                    ini.
                  </span>
                }
              >
                <div className="keputusan-pilihan" role="radiogroup" aria-label="Keputusan Checker">
                  {KEPUTUSAN.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={keputusan === item.id}
                      className={keputusan === item.id ? "keputusan-btn is-active" : "keputusan-btn"}
                      onClick={() => setKeputusan(item.id)}
                    >
                      <span className="keputusan-label">{item.label}</span>
                      <span className="keputusan-note">
                        {item.catatanWajib ? "Catatan wajib" : "Catatan opsional"}
                      </span>
                    </button>
                  ))}
                </div>
                <Textarea
                  rows={3}
                  aria-label="Catatan Checker"
                  placeholder={
                    pilihan.catatanWajib
                      ? "Wajib: jelaskan alasan keputusan ini"
                      : "Opsional: catatan untuk Approver"
                  }
                  value={catatan}
                  invalid={catatanKurang && catatan !== ""}
                  onChange={(event) => setCatatan(event.currentTarget.value)}
                />
                <BarisAksi
                  error={kirim.error}
                  secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                  primary={
                    <Button
                      variant={pilihan.tone === "danger" ? "danger" : "primary"}
                      disabled={catatanKurang || makerSendiri}
                      onClick={() => setKonfirmasi(true)}
                    >
                      {pilihan.label}
                    </Button>
                  }
                />
              </Panel>

              <ConfirmDialog
                open={konfirmasi}
                title={`Konfirmasi: ${pilihan.label}`}
                description="Keputusan ini dicatat pada timeline proposal beserta nama Anda dan waktunya."
                confirmLabel={pilihan.label}
                tone={pilihan.tone === "danger" ? "danger" : "primary"}
                loading={kirim.status === "mengirim"}
                error={kirim.error}
                onCancel={() => setKonfirmasi(false)}
                onConfirm={putuskan}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Mitra Binaan", value: proposal.mitraNama },
                    {
                      label: "Nilai diajukan",
                      value: formatMoney(proposal.jumlahDiajukan),
                      numeric: true,
                    },
                    { label: "Catatan", value: catatan.trim() || "Tidak ada catatan", wide: true },
                  ]}
                />
              </ConfirmDialog>
            </>
          );
        }}
      </Muat>
      <CatatanOtorisasi tambahan="Pemisahan Maker dan Checker ditegakkan oleh engine dan oleh trigger basis data." />
    </HalamanModul>
  );
}
