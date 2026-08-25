// Review Checker Non PUMK, spec 9.2.
//
// Proposal data and assessment result SIDE BY SIDE, one row per fact, so the
// checker reads "diajukan 50.000.000,00" against "rekomendasi penilaian
// 35.000.000,00" on one line instead of holding one figure in their head while
// scrolling to the other.
//
// TWO THINGS FAIL CLOSED HERE, both for the same reason: a recommendation is
// the document's ticket to an approver, and a recommendation that was never
// checked against the rule it is subject to is worse than a retry.
//
//   1. Spec 2 rule 1 refuses a checker who is the proposal's own maker. The
//      page says so before the click; the engine and the database trigger
//      refuse it after.
//   2. The engine refuses a REKOMENDASI below the configured pass mark. If the
//      pass mark cannot be READ, the page does not guess: Rekomendasikan stays
//      shut and says why. Tidak rekomendasi and Minta perbaikan stay open,
//      because neither of them is subject to the pass mark.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  ErrorState,
  Panel,
  StatusBadge,
  Textarea,
  bandingUang,
  formatCount,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import {
  batasanNonPumk,
  detailProposal,
  review,
  type DetailProposalNonPumk,
  type KeputusanCheckerNonPumk,
} from "../../api/nonpumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  BarisAksi,
  CatatanOtorisasi,
  HalamanModul,
  hariIni,
  KembaliKeAntrean,
  Muat,
  usePilihan,
} from "../shared/parts";
import { Antrean, Peringatan, RingkasProgram, SdgDaftar } from "./parts";

const KEPUTUSAN: Array<{
  id: KeputusanCheckerNonPumk;
  label: string;
  catatanWajib: boolean;
  tone: "primary" | "danger" | "secondary";
}> = [
  { id: "REKOMENDASI", label: "Rekomendasikan", catatanWajib: false, tone: "primary" },
  { id: "MINTA_PERBAIKAN", label: "Minta perbaikan", catatanWajib: true, tone: "secondary" },
  { id: "TIDAK_REKOMENDASI", label: "Tidak rekomendasi", catatanWajib: true, tone: "danger" },
];

export function ReviewChecker({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const batas = useApi(() => batasanNonPumk(), []);

  const [keputusan, setKeputusan] = useState<KeputusanCheckerNonPumk>("REKOMENDASI");
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(review);

  const pilihan = KEPUTUSAN.find((item) => item.id === keputusan) ?? KEPUTUSAN[0]!;
  const catatanKurang = pilihan.catatanWajib && catatan.trim() === "";

  if (proposalId === null) {
    return (
      <HalamanModul route={route}>
        <Antrean
          status="REVIEW_CHECKER"
          title="Menunggu review Checker"
          description="Pilih satu program untuk membandingkan data pengajuan dengan hasil penilaian."
          emptyTitle="Tidak ada program yang menunggu review"
          emptyDescription="Program masuk ke antrean ini setelah penilaian kelayakannya disimpan."
          onPilih={(row) => setProposalId(row.id)}
        />
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route} back={{ to: "/nonpumk/review", label: "Antrean review" }}>
      <Muat hasil={detail} judul="data review" sumber={`GET /api/nonpumk/proposal/${proposalId}`}>
        {(data: DetailProposalNonPumk) => {
          const { proposal, penilaian } = data;
          const makerSendiri =
            proposal.createdBy !== null && proposal.createdBy === session.user.id;
          const batasan = batas.data;

          // null means "not comparable", which is NOT the same as "passes".
          const bandingSkor =
            penilaian?.skorTotal && batasan
              ? bandingUang(penilaian.skorTotal, batasan.skorPenilaianMinimumLolos)
              : null;
          const dibawahAmbang = bandingSkor !== null && bandingSkor < 0;
          const ambangTidakTerbaca = batas.status !== "siap" || bandingSkor === null;

          const rekomendasiTertutup =
            keputusan === "REKOMENDASI" && (dibawahAmbang || ambangTidakTerbaca);

          const banding = [
            {
              label: "Nilai",
              diajukan: formatMoney(proposal.jumlahDiajukan),
              penilaian: penilaian
                ? formatMoney(penilaian.nilaiRekomendasi ?? "0.00")
                : "Belum dinilai",
            },
            {
              label: "Penerima manfaat",
              diajukan:
                proposal.penerimaManfaatEstimasi === null
                  ? "Belum diisi"
                  : `${formatCount(proposal.penerimaManfaatEstimasi)} orang (estimasi)`,
              penilaian: penilaian ? "Diverifikasi penilai" : "Belum dinilai",
            },
            {
              label: "Tanggal",
              diajukan: formatDate(proposal.tanggalProposal),
              penilaian: penilaian ? formatDate(penilaian.tanggal) : "Belum dinilai",
            },
          ];

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
              navigate(`/nonpumk/proposal/${proposalId}`);
            }
          }

          return (
            <>
              <RingkasProgram
                proposal={proposal}
                bidangNama={data.bidangNama}
                cabangNama={data.cabangNama}
                sdg={data.sdg}
              />

              {makerSendiri ? (
                <Peringatan judul="Anda adalah Maker program ini">
                  Satu orang tidak boleh menjadi Maker sekaligus Checker pada dokumen yang sama.
                  Permintaan review dari akun ini akan ditolak server, dan penolakannya tercatat
                  pada audit log.
                </Peringatan>
              ) : null}

              {dibawahAmbang && batasan ? (
                <Peringatan judul="Skor penilaian di bawah ambang lolos">
                  Skor {formatMoney(penilaian?.skorTotal ?? "0.00")} berada di bawah ambang{" "}
                  {formatMoney(batasan.skorPenilaianMinimumLolos)} yang dibaca dari Parameter
                  Sistem, sehingga rekomendasi akan ditolak engine. Minta perbaikan atau tidak
                  rekomendasi tetap dapat dipilih.
                </Peringatan>
              ) : null}

              <div className="banding">
                <Panel
                  as="h2"
                  title="Data program"
                  aside={<StatusBadge status={proposal.status} />}
                  footer={<span>Diinput oleh Maker cabang {data.cabangNama}.</span>}
                >
                  <DataList
                    items={[
                      { label: "No proposal", value: proposal.noProposal },
                      { label: "Pemohon", value: proposal.namaPemohon },
                      { label: "Atas nama", value: proposal.atasNama ?? "Sama dengan pemohon" },
                      { label: "Bidang", value: data.bidangNama },
                      {
                        label: "Nilai diajukan",
                        value: formatMoney(proposal.jumlahDiajukan),
                        numeric: true,
                      },
                      { label: "Judul program", value: proposal.judulProgram, wide: true },
                    ]}
                  />
                </Panel>

                <Panel
                  as="h2"
                  title="Hasil penilaian"
                  aside={
                    penilaian ? (
                      <StatusBadge status="REVIEW_CHECKER" label="Sudah dinilai" tone="info" />
                    ) : (
                      <StatusBadge status="PENILAIAN" label="Belum dinilai" tone="warning" />
                    )
                  }
                  footer={
                    <span>
                      {penilaian
                        ? "Skor dan nilai rekomendasi berasal dari penilaian kelayakan."
                        : "Belum ada penilaian untuk program ini."}
                    </span>
                  }
                >
                  {penilaian ? (
                    <DataList
                      items={[
                        { label: "Tanggal penilaian", value: formatDate(penilaian.tanggal) },
                        {
                          label: "Skor total",
                          value: formatMoney(penilaian.skorTotal ?? "0.00"),
                          numeric: true,
                        },
                        {
                          label: "Ambang lolos",
                          value: batasan
                            ? formatMoney(batasan.skorPenilaianMinimumLolos)
                            : "Tidak terbaca",
                          numeric: true,
                        },
                        {
                          label: "Nilai rekomendasi",
                          value: formatMoney(penilaian.nilaiRekomendasi ?? "0.00"),
                          numeric: true,
                        },
                        {
                          label: "Catatan penilai",
                          value: penilaian.catatan ?? "Tidak ada catatan",
                          wide: true,
                        },
                      ]}
                    />
                  ) : (
                    <p className="penjelasan">
                      Hasil penilaian belum tersimpan, jadi tidak ada pembanding untuk data
                      pengajuan.
                    </p>
                  )}
                </Panel>
              </div>

              <Panel
                as="h2"
                title="Perbandingan langsung"
                description="Nilai yang diajukan pemohon berdampingan dengan hasil penilaian kelayakan."
                footer={<span>Selisih di antara keduanya adalah bahan pertimbangan Approver.</span>}
              >
                <div className="banding-tabel">
                  <div className="banding-baris banding-kepala">
                    <span>Aspek</span>
                    <span>Diajukan</span>
                    <span>Hasil penilaian</span>
                  </div>
                  {banding.map((baris) => (
                    <div className="banding-baris" key={baris.label}>
                      <span className="banding-label">{baris.label}</span>
                      <span className="banding-nilai">{baris.diajukan}</span>
                      <span className="banding-nilai">{baris.penilaian}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel
                as="h2"
                title="Pemetaan SDG"
                description="Kesesuaian program dengan tujuan yang dipetakan adalah salah satu aspek penilaian."
                footer={<span>Bidang program: {data.bidangNama}.</span>}
              >
                <SdgDaftar sdg={data.sdg} />
              </Panel>

              <Panel
                as="h2"
                title="Keputusan Checker"
                description="Tidak rekomendasi dan minta perbaikan wajib disertai catatan. Catatan tersimpan pada timeline program."
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

                {ambangTidakTerbaca && keputusan === "REKOMENDASI" ? (
                  <ErrorState
                    title="Ambang skor lolos tidak dapat dibaca"
                    description="Rekomendasi sengaja ditutup: tanpa ambang dari Parameter Sistem, halaman ini tidak dapat memastikan skor penilaian memenuhi syarat, dan engine akan menolaknya. Tidak rekomendasi dan minta perbaikan tetap terbuka."
                    detail={batas.error ?? "Penilaian program ini belum memiliki skor."}
                    sumber="GET /api/nonpumk/batasan"
                    onRetry={batas.reload}
                  />
                ) : null}

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
                      disabled={catatanKurang || makerSendiri || rekomendasiTertutup}
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
                description="Keputusan ini dicatat pada timeline program beserta nama Anda dan waktunya."
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
                    { label: "Pemohon", value: proposal.namaPemohon },
                    {
                      label: "Nilai diajukan",
                      value: formatMoney(proposal.jumlahDiajukan),
                      numeric: true,
                    },
                    {
                      label: "Skor penilaian",
                      value: penilaian ? formatMoney(penilaian.skorTotal ?? "0.00") : "Belum dinilai",
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
