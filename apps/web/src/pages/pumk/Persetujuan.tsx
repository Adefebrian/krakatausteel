// Persetujuan Proposal Pendanaan UMK, spec 9.1.
//
// THE PLAFON AND THE TENOR ARE EDITABLE HERE. The spec is explicit that an
// approver changing them "sering terjadi di praktik", so this page treats a
// change as normal work rather than as an exception: the requested figure, the
// surveyor's recommendation and the approved figure sit in one row, the
// difference is shown as it is typed, and the akad that follows is built from
// what was APPROVED, never from what was asked for.
//
// Spec 2 rule 2 refuses an approver who reviewed the same document. The page
// says so before the click; the engine and the trigger refuse it after.
import { useEffect, useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Stat,
  StatusBadge,
  Textarea,
  TextInput,
  formatCount,
  formatDate,
  formatMoney,
  formatRate,
  jumlahkanUang,
  parseRate,
  UNPARSEABLE,
} from "@krakatausteel/ui";
import {
  batasanPumk,
  daftarProposal,
  detailProposal,
  putuskanPersetujuan,
  type BarisProposal,
} from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  BarisAksi,
  CatatanOtorisasi,
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

type Keputusan = "SETUJU" | "TOLAK" | "KEMBALIKAN";

const KEPUTUSAN: Array<{ id: Keputusan; label: string; catatanWajib: boolean; tone: "primary" | "danger" | "secondary" }> = [
  { id: "SETUJU", label: "Setujui", catatanWajib: false, tone: "primary" },
  { id: "KEMBALIKAN", label: "Kembalikan ke Checker", catatanWajib: true, tone: "secondary" },
  { id: "TOLAK", label: "Tolak", catatanWajib: true, tone: "danger" },
];

const ANTREAN_COLUMNS: readonly ColumnSpec<BarisProposal>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "150px" },
  { key: "mitraNama", header: "Mitra Binaan", sortable: true },
  { key: "sektorNama", header: "Sektor", sortable: true, width: "150px", render: (row) => row.sektorNama ?? "Belum diisi" },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  { key: "umurHari", header: "Umur (hari)", type: "count", sortable: true, width: "120px" },
];

/**
 * The signed difference between two `Uang` strings, in exact cents. Written as
 * an addition of a negated value so it goes through the one adder in
 * packages/ui and never through a float.
 */
function selisihUang(baru: string, lama: string): string | null {
  const negasi = lama.startsWith("-") ? lama.slice(1) : `-${lama}`;
  return jumlahkanUang([baru, negasi]);
}

export function Persetujuan({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const antrean = useApi(
    () => daftarProposal({ cabangId: session.cabang.id, status: "MENUNGGU_PERSETUJUAN" }),
    [session.cabang.id],
    { enabled: proposalId === null },
  );
  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const batas = useApi(() => batasanPumk(), []);

  const [keputusan, setKeputusan] = useState<Keputusan>("SETUJU");
  const [plafon, setPlafon] = useState("");
  const [plafonTerbaca, setPlafonTerbaca] = useState(true);
  const [tenor, setTenor] = useState("");
  const [rate, setRate] = useState("");
  const [catatan, setCatatan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const kirim = useAction(putuskanPersetujuan);

  // Prefill from the surveyor's recommendation, falling back to what the mitra
  // asked for. Prefilling is a starting point, never a decision: the approver
  // owns these three fields and the akad is built from them.
  const proposal = detail.data?.proposal;
  const survey = detail.data?.survey;
  useEffect(() => {
    if (!proposal) return;
    setPlafon(survey?.plafonRekomendasi ?? proposal.jumlahDiajukan);
    setTenor(String(survey?.tenorRekomendasi ?? proposal.tenorDiajukan));
  }, [proposal?.id, survey?.id]);

  useEffect(() => {
    if (rate === "" && batas.data) setRate(formatRate(batas.data.jasaAdmRateDefault));
  }, [batas.data]);

  const pilihan = KEPUTUSAN.find((item) => item.id === keputusan) ?? KEPUTUSAN[0]!;
  const catatanKurang = pilihan.catatanWajib && catatan.trim() === "";
  const rateTerbaca = rate.trim() === "" || parseRate(rate) !== null;
  const setuju = keputusan === "SETUJU";
  const bolehKirim =
    !catatanKurang && (!setuju || (plafon !== "" && plafonTerbaca && tenor !== "" && rateTerbaca));

  async function putuskan() {
    if (!proposalId) return;
    const hasil = await kirim.jalankan({
      proposalId,
      tanggal: hariIni(),
      keputusan,
      plafonDisetujui: setuju ? plafon : null,
      tenorDisetujui: setuju ? Number(tenor) : null,
      jasaAdmRate: setuju ? parseRate(rate) : null,
      catatan: catatan.trim() || null,
    });
    if (hasil) {
      setKonfirmasi(false);
      navigate(`/pumk/proposal/${proposalId}`);
    }
  }

  if (proposalId === null) {
    return (
      <PumkPage route={route}>
        <Muat
          hasil={antrean}
          judul="antrean persetujuan"
          sumber="GET /api/pumk/proposal?status=MENUNGGU_PERSETUJUAN"
        >
          {(data) =>
            data.data.length === 0 ? (
              <AntreanKosong
                icon="handshake"
                title="Tidak ada proposal yang menunggu persetujuan"
                description="Proposal masuk ke antrean ini setelah Checker memberi rekomendasi."
              />
            ) : (
              <Panel
                as="h2"
                title="Menunggu persetujuan"
                description="Pilih satu proposal untuk memutuskan, termasuk mengubah plafon dan tenornya."
                footer={<span>{formatCount(data.data.length)} proposal menunggu keputusan.</span>}
              >
                <DaftarDokumen
                  columns={ANTREAN_COLUMNS}
                  rows={data.data}
                  rowKey={(row) => row.id}
                  onPilih={(row) => setProposalId(row.id)}
                  emptyTitle="Tidak ada proposal yang menunggu persetujuan"
                  emptyDescription="Antrean terisi setelah Checker merekomendasikan sebuah proposal."
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
      </PumkPage>
    );
  }

  return (
    <PumkPage
      route={route}
      back={{ to: "/pumk/persetujuan", label: "Antrean persetujuan" }}
    >
      <Muat hasil={detail} judul="data persetujuan" sumber={`GET /api/pumk/proposal/${proposalId}`}>
        {(data) => {
          const selisih = plafon && plafonTerbaca ? selisihUang(plafon, data.proposal.jumlahDiajukan) : null;
          const tenorSelisih = tenor === "" ? null : Number(tenor) - data.proposal.tenorDiajukan;
          const checkerSendiri =
            data.review?.reviewerUserId !== null &&
            data.review?.reviewerUserId === session.user.id;

          return (
            <>
              {checkerSendiri ? (
                <div className="peringatan" role="alert">
                  <Icon name="lock" size={18} />
                  <div>
                    <p className="peringatan-judul">Anda adalah Checker proposal ini</p>
                    <p className="peringatan-teks">
                      Satu orang tidak boleh menjadi Checker sekaligus Approver pada dokumen yang
                      sama. Keputusan dari akun ini akan ditolak server dan penolakannya tercatat
                      pada audit log.
                    </p>
                  </div>
                </div>
              ) : null}

              <FormLayout
                form={
                  <div className="form-main">
                    <Panel
                      as="h2"
                      title="Nilai yang diputuskan"
                      description="Plafon dan tenor boleh berbeda dari yang diajukan. Akad dibentuk dari nilai pada bagian ini, bukan dari nilai pengajuan."
                      aside={<StatusBadge status={data.proposal.status} />}
                      footer={
                        <span>
                          Nilai asal tetap tersimpan pada proposal, sehingga perubahan bisa
                          ditelusuri di kemudian hari.
                        </span>
                      }
                    >
                      <div className="banding-tabel">
                        <div className="banding-baris banding-kepala">
                          <span>Aspek</span>
                          <span>Diajukan</span>
                          <span>Rekomendasi survey</span>
                          <span>Disetujui</span>
                        </div>
                        <div className="banding-baris">
                          <span className="banding-label">Plafon</span>
                          <span className="banding-nilai">{formatMoney(data.proposal.jumlahDiajukan)}</span>
                          <span className="banding-nilai">
                            {data.survey?.plafonRekomendasi
                              ? formatMoney(data.survey.plafonRekomendasi)
                              : "Belum ada"}
                          </span>
                          <span className="banding-nilai is-final">
                            {plafon && plafonTerbaca ? formatMoney(plafon) : "Belum diisi"}
                          </span>
                        </div>
                        <div className="banding-baris">
                          <span className="banding-label">Tenor</span>
                          <span className="banding-nilai">
                            {formatCount(data.proposal.tenorDiajukan)} bulan
                          </span>
                          <span className="banding-nilai">
                            {data.survey?.tenorRekomendasi
                              ? `${formatCount(data.survey.tenorRekomendasi)} bulan`
                              : "Belum ada"}
                          </span>
                          <span className="banding-nilai is-final">
                            {tenor === "" ? "Belum diisi" : `${formatCount(Number(tenor))} bulan`}
                          </span>
                        </div>
                      </div>

                      <FieldGrid>
                        <Field
                          label="Plafon disetujui"
                          htmlFor="plafon-disetujui"
                          required={setuju}
                          hint={
                            batas.data
                              ? `Batas program ${formatMoney(batas.data.plafonMin)} sampai ${formatMoney(batas.data.plafonMax)}.`
                              : "Batas plafon belum terbaca dari server."
                          }
                          error={plafonTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                        >
                          <MoneyInput
                            id="plafon-disetujui"
                            value={plafon}
                            disabled={!setuju}
                            invalid={!plafonTerbaca}
                            onValueChange={(value, raw) => {
                              setPlafon(value ?? "");
                              setPlafonTerbaca(raw.trim() === "" || value !== null);
                            }}
                          />
                        </Field>
                        <Field
                          label="Tenor disetujui (bulan)"
                          htmlFor="tenor-disetujui"
                          required={setuju}
                          hint={
                            batas.data
                              ? `${formatCount(batas.data.tenorMin)} sampai ${formatCount(batas.data.tenorMax)} bulan.`
                              : "Batas tenor belum terbaca dari server."
                          }
                        >
                          <TextInput
                            id="tenor-disetujui"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={tenor}
                            disabled={!setuju}
                            onChange={(event) => setTenor(event.currentTarget.value)}
                          />
                        </Field>
                        <Field
                          label="Rate Jasa Administrasi (persen per tahun)"
                          htmlFor="rate"
                          hint="Kosongkan untuk memakai rate default dari Parameter Sistem."
                          error={rateTerbaca ? undefined : "Rate tidak terbaca. Contoh penulisan: 3 atau 3,5."}
                        >
                          <TextInput
                            id="rate"
                            inputMode="decimal"
                            value={rate}
                            disabled={!setuju}
                            invalid={!rateTerbaca}
                            onChange={(event) => setRate(event.currentTarget.value)}
                          />
                        </Field>
                        <Field
                          label="Tanggal keputusan"
                          htmlFor="tanggal-keputusan"
                          hint="Tanggal hari ini, ikut tercatat pada timeline proposal."
                        >
                          <TextInput id="tanggal-keputusan" type="date" value={hariIni()} readOnly />
                        </Field>
                      </FieldGrid>
                    </Panel>

                    <Panel
                      as="h2"
                      title="Keputusan"
                      description="Tolak dan kembalikan ke Checker wajib disertai catatan. Catatan tersimpan pada timeline proposal."
                      footer={
                        <span>
                          Keputusan memindahkan status dokumen dan tidak dapat dibatalkan dari
                          halaman ini.
                        </span>
                      }
                    >
                      <div className="keputusan-pilihan" role="radiogroup" aria-label="Keputusan Approver">
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
                        aria-label="Catatan Approver"
                        placeholder={
                          pilihan.catatanWajib
                            ? "Wajib: jelaskan alasan keputusan ini"
                            : "Opsional: alasan perubahan plafon atau tenor"
                        }
                        value={catatan}
                        onChange={(event) => setCatatan(event.currentTarget.value)}
                      />
                      <BarisAksi
                        error={kirim.error}
                        secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                        primary={
                          <Button
                            variant={pilihan.tone === "danger" ? "danger" : "primary"}
                            disabled={!bolehKirim || checkerSendiri}
                            onClick={() => setKonfirmasi(true)}
                          >
                            {pilihan.label}
                          </Button>
                        }
                      />
                    </Panel>
                  </div>
                }
                aside={
                  <aside className="form-aside">
                    <Panel
                      as="h2"
                      title="Perubahan terhadap pengajuan"
                      footer={
                        <span>
                          Selisih dihitung dari nilai yang diajukan Mitra Binaan, bukan dari
                          rekomendasi survey.
                        </span>
                      }
                    >
                      <Stat
                        label="Selisih plafon"
                        value={
                          selisih === null
                            ? plafon === ""
                              ? "Belum diisi"
                              : UNPARSEABLE
                            : formatMoney(selisih)
                        }
                        hint={
                          selisih === null
                            ? "Isi plafon disetujui untuk melihat selisihnya."
                            : selisih.startsWith("-")
                              ? "Plafon disetujui lebih kecil dari yang diajukan."
                              : selisih === "0.00"
                                ? "Plafon disetujui sama dengan yang diajukan."
                                : "Plafon disetujui lebih besar dari yang diajukan."
                        }
                      />
                      <Stat
                        label="Selisih tenor"
                        value={
                          tenorSelisih === null
                            ? "Belum diisi"
                            : `${tenorSelisih > 0 ? "+" : ""}${formatCount(tenorSelisih)} bulan`
                        }
                        hint={`Tenor diajukan ${formatCount(data.proposal.tenorDiajukan)} bulan.`}
                      />
                    </Panel>

                    <Panel
                      as="h2"
                      title="Proposal"
                      footer={<span>Jaminan tercatat: {formatCount(data.jaminan.length)}.</span>}
                    >
                      <DataList
                        items={[
                          { label: "No proposal", value: data.proposal.noProposal },
                          { label: "Mitra Binaan", value: data.proposal.mitraNama },
                          { label: "Sektor", value: data.proposal.sektorNama ?? "Belum diisi" },
                          { label: "Tanggal proposal", value: formatDate(data.proposal.tanggalProposal) },
                          {
                            label: "Skor survey",
                            value: data.survey?.skorTotal
                              ? formatMoney(data.survey.skorTotal)
                              : "Belum disurvey",
                            numeric: true,
                          },
                        ]}
                      />
                    </Panel>

                    <Panel
                      as="h2"
                      title="Rekomendasi Checker"
                      footer={
                        <span>
                          {data.review?.reviewerNama
                            ? `Direview oleh ${data.review.reviewerNama}.`
                            : "Belum ada jejak review pada proposal ini."}
                        </span>
                      }
                    >
                      <DataList
                        items={[
                          { label: "Keputusan", value: data.review?.keputusan ?? "Belum ada" },
                          {
                            label: "Tanggal review",
                            value: data.review?.tanggal ? formatDate(data.review.tanggal) : "Belum ada",
                          },
                          {
                            label: "Catatan Checker",
                            value: data.review?.catatan ?? "Tidak ada catatan",
                            wide: true,
                          },
                        ]}
                      />
                    </Panel>
                  </aside>
                }
              />

              <ConfirmDialog
                open={konfirmasi}
                title={`Konfirmasi: ${pilihan.label}`}
                description="Keputusan dicatat pada timeline proposal beserta nama Anda, waktunya, dan nilai final yang Anda tetapkan."
                confirmLabel={pilihan.label}
                tone={pilihan.tone === "danger" ? "danger" : "primary"}
                loading={kirim.status === "mengirim"}
                error={kirim.error}
                onCancel={() => setKonfirmasi(false)}
                onConfirm={putuskan}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: data.proposal.noProposal },
                    { label: "Mitra Binaan", value: data.proposal.mitraNama },
                    {
                      label: "Plafon diajukan",
                      value: formatMoney(data.proposal.jumlahDiajukan),
                      numeric: true,
                    },
                    {
                      label: "Plafon disetujui",
                      value: setuju ? formatMoney(plafon) : "Tidak berlaku",
                      numeric: true,
                    },
                    {
                      label: "Tenor disetujui",
                      value: setuju ? `${formatCount(Number(tenor))} bulan` : "Tidak berlaku",
                      numeric: true,
                    },
                    {
                      label: "Rate Jasa Administrasi",
                      value: setuju
                        ? rate.trim() === ""
                          ? "Memakai default Parameter Sistem"
                          : `${rate} persen per tahun`
                        : "Tidak berlaku",
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
    </PumkPage>
  );
}
