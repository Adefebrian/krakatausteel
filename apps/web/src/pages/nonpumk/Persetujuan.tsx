// Persetujuan Proposal Non PUMK, spec 9.2.
//
// THE APPROVER MAY CUT THE AMOUNT AND MAY NOT RAISE IT. Spec 9.2 says the cut
// happens often in practice, so the approved figure is an editable field here
// rather than a fixed echo of the request, and the difference against what was
// asked for is shown while it is typed. A raise is refused by the engine with
// NILAI_DISETUJUI_MELEBIHI_PENGAJUAN; this page closes the button first, so
// nobody types a larger figure, confirms it, and only then learns it was never
// possible.
//
// The comparison is done in integer sen through `bandingUang`, and a value it
// cannot read answers null, which closes the button too. "I could not compare
// these two numbers" must never be treated as "they are fine": that is how an
// unchecked ceiling reaches the disbursement screen, where it becomes the only
// limit standing between a termin and the ledger.
//
// Spec 2 rule 2 refuses an approver who reviewed the same document. The
// reviewer is not on the detail read, so it is taken from the RECORDED
// timeline, which is where the review transition actually lives. The engine
// and the database trigger refuse the click regardless.
import { useEffect, useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  MoneyInput,
  Panel,
  Stat,
  StatusBadge,
  Textarea,
  bandingUang,
  formatCount,
  formatDate,
  formatMoney,
  kurangkanUang,
} from "@krakatausteel/ui";
import {
  detailProposal,
  putuskanPersetujuan,
  timelineProposal,
  type DetailProposalNonPumk,
  type KeputusanApproverNonPumk,
} from "../../api/nonpumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  BarisAksi,
  CatatanOtorisasi,
  FieldGrid,
  HalamanModul,
  hariIni,
  KembaliKeAntrean,
  Muat,
  usePilihan,
} from "../shared/parts";
import { Antrean, Peringatan, RingkasProgram } from "./parts";

const KEPUTUSAN: Array<{
  id: KeputusanApproverNonPumk;
  label: string;
  catatanWajib: boolean;
  tone: "primary" | "danger" | "secondary";
}> = [
  { id: "SETUJU", label: "Setujui", catatanWajib: false, tone: "primary" },
  { id: "KEMBALIKAN", label: "Kembalikan ke Checker", catatanWajib: true, tone: "secondary" },
  { id: "TOLAK", label: "Tolak", catatanWajib: true, tone: "danger" },
];

const AKSI_CHECKER = new Set(["REKOMENDASI", "TIDAK_REKOMENDASI", "MINTA_PERBAIKAN"]);

export function Persetujuan({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const timeline = useApi(() => timelineProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });

  const [keputusan, setKeputusan] = useState<KeputusanApproverNonPumk>("SETUJU");
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(putuskanPersetujuan);

  // Prefilled from the ASSESSOR's recommendation when there is one, and from
  // the request only when there is not. Prefilling from the request would nudge
  // an approver towards granting the full amount by default.
  const prefill = detail.data?.penilaian?.nilaiRekomendasi ?? detail.data?.proposal.jumlahDiajukan;
  useEffect(() => {
    if (prefill) setJumlah(prefill);
  }, [prefill]);

  const pilihan = KEPUTUSAN.find((item) => item.id === keputusan) ?? KEPUTUSAN[0]!;
  const catatanKurang = pilihan.catatanWajib && catatan.trim() === "";

  if (proposalId === null) {
    return (
      <HalamanModul route={route}>
        <Antrean
          status="MENUNGGU_PERSETUJUAN"
          title="Menunggu persetujuan"
          description="Pilih satu program yang sudah direkomendasikan Checker untuk diputuskan."
          emptyTitle="Tidak ada program yang menunggu persetujuan"
          emptyDescription="Program masuk ke antrean ini setelah Checker memberi rekomendasi."
          onPilih={(row) => setProposalId(row.id)}
        />
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route} back={{ to: "/nonpumk/persetujuan", label: "Antrean persetujuan" }}>
      <Muat
        hasil={detail}
        judul="data persetujuan"
        sumber={`GET /api/nonpumk/proposal/${proposalId}`}
      >
        {(data: DetailProposalNonPumk) => {
          const { proposal, penilaian } = data;

          const reviewer =
            (timeline.data?.data ?? []).filter((baris) => AKSI_CHECKER.has(baris.aksi)).at(-1) ??
            null;
          const checkerSendiri =
            reviewer?.olehUserId !== null &&
            reviewer?.olehUserId !== undefined &&
            reviewer.olehUserId === session.user.id;

          // null is "not comparable", and not comparable closes the button.
          const banding = jumlah === "" ? null : bandingUang(jumlah, proposal.jumlahDiajukan);
          const melebihiPengajuan = banding === null ? null : banding > 0;
          const selisih = jumlah === "" ? null : kurangkanUang(jumlah, proposal.jumlahDiajukan);

          const nilaiSah =
            keputusan !== "SETUJU" ||
            (jumlah !== "" && jumlahTerbaca && melebihiPengajuan === false);

          const bolehKirim = !catatanKurang && !checkerSendiri && nilaiSah;

          async function putuskan() {
            if (!proposalId || !bolehKirim) return;
            const hasil = await kirim.jalankan({
              proposalId,
              tanggal: hariIni(),
              keputusan,
              jumlahDisetujui: keputusan === "SETUJU" ? jumlah : null,
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

              {checkerSendiri ? (
                <Peringatan judul="Anda adalah Checker program ini">
                  Satu orang tidak boleh menjadi Checker sekaligus Approver pada dokumen yang sama.
                  Keputusan dari akun ini akan ditolak server, dan penolakannya tercatat pada audit
                  log.
                </Peringatan>
              ) : null}

              {melebihiPengajuan === true ? (
                <Peringatan judul="Nilai disetujui melebihi nilai yang diajukan">
                  Approver dapat memotong nilai bantuan dan tidak dapat menaikkannya. Turunkan nilai
                  disetujui menjadi paling banyak {formatMoney(proposal.jumlahDiajukan)}.
                </Peringatan>
              ) : null}

              {melebihiPengajuan === null && keputusan === "SETUJU" && jumlah !== "" ? (
                <Peringatan judul="Nilai tidak dapat dibandingkan">
                  Salah satu dari nilai disetujui dan nilai diajukan tidak terbaca sebagai angka
                  rupiah, jadi halaman ini tidak dapat memastikan nilai disetujui tidak melebihi
                  pengajuan. Persetujuan sengaja ditutup sampai keduanya terbaca.
                </Peringatan>
              ) : null}

              <div className="form-layout has-aside">
                <div className="form-main">
                  <Panel
                    as="h2"
                    title="Keputusan Approver"
                    description="Nilai disetujui boleh lebih kecil dari nilai yang diajukan dan tidak boleh lebih besar. Nilai inilah yang menjadi pagu penyaluran bertahap."
                    footer={
                      <span>
                        Setelah disetujui, nilai ini tidak dapat dinaikkan lagi dari halaman mana
                        pun.
                      </span>
                    }
                  >
                    <div
                      className="keputusan-pilihan"
                      role="radiogroup"
                      aria-label="Keputusan Approver"
                    >
                      {KEPUTUSAN.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="radio"
                          aria-checked={keputusan === item.id}
                          className={
                            keputusan === item.id ? "keputusan-btn is-active" : "keputusan-btn"
                          }
                          onClick={() => setKeputusan(item.id)}
                        >
                          <span className="keputusan-label">{item.label}</span>
                          <span className="keputusan-note">
                            {item.catatanWajib ? "Catatan wajib" : "Catatan opsional"}
                          </span>
                        </button>
                      ))}
                    </div>

                    {keputusan === "SETUJU" ? (
                      <FieldGrid>
                        <div className="field">
                          <label className="field-label" htmlFor="np-jumlah-disetujui">
                            Nilai disetujui
                            <span className="field-required" aria-hidden="true">
                              wajib
                            </span>
                          </label>
                          <MoneyInput
                            id="np-jumlah-disetujui"
                            value={jumlah}
                            invalid={!jumlahTerbaca || melebihiPengajuan !== false}
                            onValueChange={(value, raw) => {
                              setJumlah(value ?? "");
                              setJumlahTerbaca(raw.trim() === "" || value !== null);
                            }}
                          />
                          <p className="field-hint" id="np-jumlah-disetujui-hint">
                            Diisi awal dari nilai rekomendasi penilaian, bukan dari nilai yang
                            diajukan.
                          </p>
                        </div>
                      </FieldGrid>
                    ) : null}

                    <Textarea
                      rows={3}
                      aria-label="Catatan Approver"
                      placeholder={
                        pilihan.catatanWajib
                          ? "Wajib: jelaskan alasan keputusan ini"
                          : "Opsional: catatan untuk pelaksana penyaluran"
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
                          disabled={!bolehKirim}
                          onClick={() => setKonfirmasi(true)}
                        >
                          {pilihan.label}
                        </Button>
                      }
                    />
                  </Panel>
                </div>

                <aside className="form-aside">
                  <Panel
                    as="h2"
                    title="Nilai disetujui terhadap pengajuan"
                    aside={<StatusBadge status={proposal.status} />}
                    footer={
                      <span>
                        {melebihiPengajuan === false && selisih !== null
                          ? bandingUang(selisih, "0.00") === 0
                            ? "Disetujui penuh sesuai pengajuan."
                            : "Nilai disetujui lebih kecil dari yang diajukan."
                          : "Persetujuan tertutup sampai nilai memenuhi syarat."}
                      </span>
                    }
                  >
                    <Stat
                      label="Selisih terhadap pengajuan"
                      value={selisih === null ? "Belum dapat dihitung" : formatMoney(selisih)}
                      hint="Nilai disetujui dikurangi nilai diajukan, dihitung dalam satuan sen."
                    />
                    <DataList
                      items={[
                        {
                          label: "Nilai diajukan",
                          value: formatMoney(proposal.jumlahDiajukan),
                          numeric: true,
                        },
                        {
                          label: "Rekomendasi penilaian",
                          value: penilaian
                            ? formatMoney(penilaian.nilaiRekomendasi ?? "0.00")
                            : "Belum dinilai",
                          numeric: true,
                        },
                        {
                          label: "Skor penilaian",
                          value: penilaian
                            ? formatMoney(penilaian.skorTotal ?? "0.00")
                            : "Belum dinilai",
                          numeric: true,
                        },
                        {
                          label: "Nilai disetujui",
                          value: jumlah === "" ? "Belum diisi" : formatMoney(jumlah),
                          numeric: true,
                        },
                      ]}
                    />
                  </Panel>

                  <Panel
                    as="h2"
                    title="Program"
                    footer={<span>Bidang {data.bidangNama}, cabang {data.cabangNama}.</span>}
                  >
                    <DataList
                      items={[
                        { label: "No proposal", value: proposal.noProposal },
                        { label: "Pemohon", value: proposal.namaPemohon },
                        { label: "Judul program", value: proposal.judulProgram, wide: true },
                        { label: "Tanggal proposal", value: formatDate(proposal.tanggalProposal) },
                        {
                          label: "Estimasi penerima manfaat",
                          value:
                            proposal.penerimaManfaatEstimasi === null
                              ? "Belum diisi"
                              : formatCount(proposal.penerimaManfaatEstimasi),
                          numeric: true,
                        },
                      ]}
                    />
                  </Panel>
                </aside>
              </div>

              <ConfirmDialog
                open={konfirmasi}
                title={`Konfirmasi: ${pilihan.label}`}
                description="Keputusan ini dicatat pada timeline program beserta nama Anda dan waktunya. Nilai disetujui menjadi pagu penyaluran dan tidak dapat dinaikkan setelah ini."
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
                      label: "Nilai disetujui",
                      value:
                        keputusan === "SETUJU"
                          ? jumlah === ""
                            ? "Belum diisi"
                            : formatMoney(jumlah)
                          : "Tidak ada nilai disetujui",
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
      <CatatanOtorisasi tambahan="Pemisahan Checker dan Approver ditegakkan oleh engine dan oleh trigger basis data." />
    </HalamanModul>
  );
}
