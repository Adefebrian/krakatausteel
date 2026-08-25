// Penilaian Proposal Non PUMK, spec 9.2 and spec 4.5.
//
// THE SCORE IS ONE NUMBER, DERIVED, NOT TWO NUMBERS THAT CAN DISAGREE. The
// five aspects of spec 4.5 are recorded as they are assessed and the total is
// their average, computed here and shown read only. An earlier sketch let the
// assessor type both the aspects and the total; that is a form that can
// contradict itself, and the contradiction only shows up months later when
// somebody asks why a 72 was recorded against five scores averaging 61.
//
// THE WEIGHTING IS OURS, AND THE PAGE SAYS SO IN TERMS THE READER CAN CHECK.
// The engine stores `hasil` as free-form jsonb and does not weight the aspects,
// so equal weighting is this page's choice. It is stated as "rata rata
// sederhana, bukan rata rata tertimbang", which the reader can verify against
// the five numbers on screen, rather than as a claim about what the client has
// or has not decided, which this page has no way to see.
//
// The pass mark is READ from Parameter Sistem and never written here. It does
// not block this screen: the engine refuses a REKOMENDASI below it at the
// CHECKER's step, which is the step the rule belongs to, so this page reports
// the comparison instead of pretending to enforce it.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  ErrorState,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Stat,
  StatusBadge,
  Textarea,
  TextInput,
  bandingUang,
  formatCount,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import {
  batasanNonPumk,
  detailProposal,
  inputPenilaian,
  type DetailProposalNonPumk,
} from "../../api/nonpumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  FieldGrid,
  HalamanModul,
  hariIni,
  KembaliKeAntrean,
  Muat,
  usePilihan,
} from "../shared/parts";
import { Antrean, RingkasProgram, SdgDaftar } from "./parts";

/** Spec 4.5's five aspects. Scored 0 to 100 each. */
const ASPEK = [
  { id: "kelayakan", label: "Kelayakan program", hint: "Rencana kegiatan, anggaran, dan pelaksana." },
  { id: "urgensi", label: "Urgensi", hint: "Seberapa mendesak kebutuhan penerima manfaat." },
  { id: "dampak", label: "Dampak", hint: "Manfaat yang diperkirakan dan jangkauannya." },
  { id: "kesesuaianBidang", label: "Kesesuaian bidang", hint: "Kecocokan dengan bidang Non PUMK yang dipilih." },
  { id: "kesesuaianSdg", label: "Kesesuaian SDG", hint: "Kecocokan dengan SDG yang dipetakan." },
] as const;

type Skor = Record<string, string>;

const SKOR_AWAL: Skor = Object.fromEntries(ASPEK.map((item) => [item.id, ""]));

/** Every aspect read as a whole number in 0 to 100, or null when one is not. */
function bacaAspek(skor: Skor): number[] | null {
  const nilai: number[] = [];
  for (const item of ASPEK) {
    const teks = (skor[item.id] ?? "").trim();
    if (teks === "") return null;
    const angka = Number(teks);
    if (!Number.isInteger(angka) || angka < 0 || angka > 100) return null;
    nilai.push(angka);
  }
  return nilai;
}

/**
 * The average of the five aspects, as the plain decimal text the endpoint
 * accepts (NUMERIC(9,6)). Computed in integer arithmetic and then rendered to
 * six places, so a total of 61,666667 is exactly what is stored and exactly
 * what is shown.
 */
function skorTotal(nilai: readonly number[]): string {
  const jumlah = nilai.reduce((total, angka) => total + angka, 0);
  const mikro = Math.round((jumlah * 1_000_000) / nilai.length);
  return `${Math.floor(mikro / 1_000_000)}.${String(mikro % 1_000_000).padStart(6, "0")}`;
}

export function Penilaian({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const batas = useApi(() => batasanNonPumk(), []);

  const [tanggal, setTanggal] = useState(hariIni());
  const [skor, setSkor] = useState<Skor>(SKOR_AWAL);
  const [rekomendasi, setRekomendasi] = useState("");
  const [rekomendasiTerbaca, setRekomendasiTerbaca] = useState(true);
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(inputPenilaian);

  const aspek = bacaAspek(skor);
  const total = aspek === null ? null : skorTotal(aspek);
  const batasan = batas.data;

  if (proposalId === null) {
    return (
      <HalamanModul route={route}>
        <Antrean
          status="PENILAIAN"
          title="Menunggu penilaian"
          description="Pilih satu program untuk dinilai kelayakannya sebelum masuk review Checker."
          emptyTitle="Tidak ada program yang menunggu penilaian"
          emptyDescription="Program masuk ke antrean ini setelah Maker mengajukannya dari status Draft."
          onPilih={(row) => setProposalId(row.id)}
        />
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route} back={{ to: "/nonpumk/penilaian", label: "Antrean penilaian" }}>
      <Muat
        hasil={detail}
        judul="data program"
        sumber={`GET /api/nonpumk/proposal/${proposalId}`}
      >
        {(data: DetailProposalNonPumk) => {
          const { proposal } = data;
          // Below the pass mark the checker cannot recommend. Stated, not
          // enforced here: this screen records an assessment, and refusing to
          // record a low one would simply make low assessments disappear.
          const lolos =
            total !== null && batasan
              ? bandingUang(total, batasan.skorPenilaianMinimumLolos)
              : null;

          const lengkap =
            aspek !== null &&
            total !== null &&
            rekomendasi !== "" &&
            rekomendasiTerbaca &&
            tanggal !== "";

          async function simpan() {
            if (!proposalId || !lengkap || total === null || aspek === null) return;
            const hasil = await kirim.jalankan({
              proposalId,
              tanggal,
              hasil: Object.fromEntries(ASPEK.map((item, i) => [item.id, aspek[i]])),
              skorTotal: total,
              nilaiRekomendasi: rekomendasi,
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

              <div className="banding">
                <Panel
                  as="h2"
                  title="Data program"
                  aside={<StatusBadge status={proposal.status} />}
                  footer={<span>Diinput oleh Maker cabang {data.cabangNama}.</span>}
                >
                  <DataList
                    items={[
                      { label: "Pemohon", value: proposal.namaPemohon },
                      { label: "Atas nama", value: proposal.atasNama ?? "Sama dengan pemohon" },
                      { label: "Judul program", value: proposal.judulProgram, wide: true },
                      {
                        label: "Nilai diajukan",
                        value: formatMoney(proposal.jumlahDiajukan),
                        numeric: true,
                      },
                      {
                        label: "Estimasi penerima manfaat",
                        value:
                          proposal.penerimaManfaatEstimasi === null
                            ? "Belum diisi"
                            : formatCount(proposal.penerimaManfaatEstimasi),
                        numeric: true,
                      },
                      {
                        label: "Deskripsi",
                        value: proposal.deskripsiProgram ?? "Tidak ada deskripsi",
                        wide: true,
                      },
                    ]}
                  />
                </Panel>

                <Panel
                  as="h2"
                  title="Pemetaan SDG"
                  description="Bobot menunjukkan seberapa besar program ini menyumbang pada tiap tujuan."
                  footer={<span>Bidang program: {data.bidangNama}.</span>}
                >
                  <SdgDaftar sdg={data.sdg} />
                </Panel>
              </div>

              <Bagian
                title="Penilaian kelayakan"
                description="Lima aspek spesifikasi 4.5, masing masing 0 sampai 100. Skor total adalah rata rata kelimanya."
                aside={
                  <span className="tabs-note">
                    {total === null ? "Skor belum lengkap" : `Skor total ${formatMoney(total)}`}
                  </span>
                }
                footer={
                  <span>
                    Kelima aspek berbobot sama rata: skor total adalah rata rata sederhana, bukan
                    rata rata tertimbang. Nilai tiap aspek tetap tersimpan utuh pada penilaian ini,
                    sehingga pembobotan lain dapat dihitung ulang dari data yang sama.
                  </span>
                }
              >
                <FieldGrid>
                  {ASPEK.map((item) => {
                    const teks = (skor[item.id] ?? "").trim();
                    const angka = Number(teks);
                    const salah =
                      teks !== "" && (!Number.isInteger(angka) || angka < 0 || angka > 100);
                    return (
                      <Field
                        key={item.id}
                        label={item.label}
                        htmlFor={`np-skor-${item.id}`}
                        required
                        hint={item.hint}
                        error={salah ? "Isi bilangan bulat 0 sampai 100." : undefined}
                      >
                        <TextInput
                          id={`np-skor-${item.id}`}
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          inputMode="numeric"
                          invalid={salah}
                          value={skor[item.id] ?? ""}
                          onChange={(event) => {
                            const nilai = event.currentTarget.value;
                            setSkor((current) => ({ ...current, [item.id]: nilai }));
                          }}
                        />
                      </Field>
                    );
                  })}
                  <Field label="Tanggal penilaian" htmlFor="np-tanggal-nilai" required>
                    <TextInput
                      id="np-tanggal-nilai"
                      type="date"
                      value={tanggal}
                      onChange={(event) => setTanggal(event.currentTarget.value)}
                    />
                  </Field>
                </FieldGrid>

                <FieldGrid>
                  <Field
                    label="Nilai rekomendasi"
                    htmlFor="np-nilai-rekomendasi"
                    required
                    error={
                      rekomendasiTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."
                    }
                    hint="Nilai bantuan yang disarankan penilai. Approver tetap dapat memotongnya."
                  >
                    <MoneyInput
                      id="np-nilai-rekomendasi"
                      value={rekomendasi}
                      invalid={!rekomendasiTerbaca}
                      onValueChange={(value, raw) => {
                        setRekomendasi(value ?? "");
                        setRekomendasiTerbaca(raw.trim() === "" || value !== null);
                      }}
                    />
                  </Field>
                </FieldGrid>

                <Field label="Catatan penilai" htmlFor="np-catatan-nilai">
                  <Textarea
                    id="np-catatan-nilai"
                    rows={3}
                    value={catatan}
                    onChange={(event) => setCatatan(event.currentTarget.value)}
                  />
                </Field>

                <div className="skor-ringkas">
                  <Stat
                    label="Skor total"
                    value={total === null ? "Belum lengkap" : formatMoney(total)}
                    hint="Rata rata lima aspek, enam angka desimal, sama persis dengan yang disimpan."
                    aside={
                      lolos === null ? undefined : (
                        <StatusBadge
                          status={lolos < 0 ? "DI_BAWAH_AMBANG" : "MEMENUHI_AMBANG"}
                          tone={lolos < 0 ? "warning" : "success"}
                          label={lolos < 0 ? "Di bawah ambang" : "Memenuhi ambang"}
                        />
                      )
                    }
                  />
                  {batas.status === "gagal" ? (
                    <ErrorState
                      title="Ambang skor tidak dapat dibaca"
                      description="Penilaian tetap dapat disimpan. Yang tidak dapat ditampilkan adalah perbandingan terhadap ambang lolos, dan Checker akan tetap ditolak engine bila skornya kurang."
                      detail={batas.error}
                      sumber="GET /api/nonpumk/batasan"
                      onRetry={batas.reload}
                    />
                  ) : batasan ? (
                    <p className="penjelasan">
                      Ambang lolos saat ini {formatMoney(batasan.skorPenilaianMinimumLolos)}, dibaca
                      dari Parameter Sistem. Di bawah ambang, Checker tidak dapat memberi
                      rekomendasi dan engine menolak permintaannya.
                    </p>
                  ) : null}
                </div>

                <BarisAksi
                  error={kirim.error}
                  secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                  primary={
                    <Button
                      variant="primary"
                      disabled={!lengkap}
                      loading={kirim.status === "mengirim"}
                      loadingLabel="Menyimpan"
                      onClick={() => setKonfirmasi(true)}
                    >
                      Simpan penilaian
                    </Button>
                  }
                />
              </Bagian>

              <ConfirmDialog
                open={konfirmasi}
                title="Konfirmasi penilaian program"
                description="Penilaian tersimpan atas nama Anda dan memindahkan program ke Review Checker. Satu program hanya memiliki satu baris penilaian, jadi penilaian ulang memperbarui baris yang sama."
                confirmLabel="Simpan penilaian"
                loading={kirim.status === "mengirim"}
                error={kirim.error}
                onCancel={() => setKonfirmasi(false)}
                onConfirm={simpan}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Pemohon", value: proposal.namaPemohon },
                    { label: "Tanggal penilaian", value: formatDate(tanggal) },
                    {
                      label: "Skor total",
                      value: total === null ? "Belum lengkap" : formatMoney(total),
                      numeric: true,
                    },
                    {
                      label: "Nilai rekomendasi",
                      value: rekomendasi === "" ? "Belum diisi" : formatMoney(rekomendasi),
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
      <CatatanOtorisasi tambahan="Penilaian memindahkan status program, dan setiap transisi tercatat pada timeline beserta nama dan waktunya." />
    </HalamanModul>
  );
}
