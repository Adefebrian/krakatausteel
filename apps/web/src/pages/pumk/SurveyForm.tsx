// Input Hasil Survey, spec 9.1 and spec 4.4's `pumk_survey`.
//
// The five aspects are the five spec 4.4 names, each scored on the same scale,
// and the total is the SUM OF WHAT WAS SCORED, computed on screen while the
// surveyor types. Nothing here invents a weighting: a weighted model that the
// client has not agreed to would be an accounting rule smuggled in as a form.
//
// The pass mark is `skor_survey_minimum_lolos` from Parameter Sistem, read
// from the server. A score below it is shown as a warning on the form, not as
// a block: the checker's recommendation is the decision point, and the engine
// refuses the recommendation itself when the score is short.
//
// PHOTOS ARE UPLOADED ON SUBMIT, and the survey is only recorded if they land.
// A record must not carry a filename for a file that was never stored.
import { useState } from "react";
import {
  Button,
  DataList,
  Field,
  FilePicker,
  Panel,
  StatusBadge,
  Textarea,
  TextInput,
  MoneyInput,
  formatCount,
  formatDate,
  formatMoney,
} from "@krakatausteel/ui";
import {
  batasanPumk,
  daftarProposal,
  detailProposal,
  inputSurvey,
  unggahLampiran,
  type BarisProposal,
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

/** Spec 4.4 `hasil_json`: the five aspects, verbatim. */
const ASPEK = [
  { id: "karakter", label: "Karakter pemohon" },
  { id: "kapasitas_usaha", label: "Kapasitas usaha" },
  { id: "kondisi_tempat_usaha", label: "Kondisi tempat usaha" },
  { id: "agunan", label: "Agunan" },
  { id: "riwayat_pinjaman", label: "Riwayat pinjaman" },
] as const;

const SKOR_MAKS_PER_ASPEK = 20;

const ANTREAN_COLUMNS: readonly ColumnSpec<BarisProposal>[] = [
  { key: "noProposal", header: "No Proposal", sortable: true, width: "150px" },
  { key: "tanggalProposal", header: "Tanggal", type: "date", sortable: true, width: "110px" },
  { key: "mitraNama", header: "Mitra Binaan", sortable: true },
  { key: "jumlahDiajukan", header: "Nilai Diajukan", type: "money", sortable: true, width: "150px" },
  { key: "umurHari", header: "Umur (hari)", type: "count", sortable: true, width: "120px" },
];

export function SurveyForm({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");

  const antrean = useApi(
    () => daftarProposal({ cabangId: session.cabang.id, status: "SURVEY_PENDING" }),
    [session.cabang.id],
    { enabled: proposalId === null },
  );
  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const batas = useApi(() => batasanPumk(), []);

  const [tanggalSurvey, setTanggalSurvey] = useState(hariIni());
  const [skor, setSkor] = useState<Record<string, string>>({});
  const [catatanAspek, setCatatanAspek] = useState<Record<string, string>>({});
  const [plafon, setPlafon] = useState("");
  const [plafonTerbaca, setPlafonTerbaca] = useState(true);
  const [tenor, setTenor] = useState("");
  const [catatan, setCatatan] = useState("");
  const [foto, setFoto] = useState<File[]>([]);
  const [gagalUnggah, setGagalUnggah] = useState<string | null>(null);

  const simpan = useAction(inputSurvey);

  const total = ASPEK.reduce((sum, aspek) => sum + (Number(skor[aspek.id] ?? "") || 0), 0);
  const totalMaks = ASPEK.length * SKOR_MAKS_PER_ASPEK;
  const minimum = batas.data ? Number(batas.data.skorSurveyMinimumLolos) : null;
  const semuaTerisi = ASPEK.every((aspek) => (skor[aspek.id] ?? "") !== "");
  const lengkap = semuaTerisi && plafon !== "" && plafonTerbaca && tenor !== "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!lengkap || !proposalId) return;
    setGagalUnggah(null);

    let lampiran: string[] = [];
    if (foto.length > 0) {
      try {
        const stored = await Promise.all(
          foto.map((file) => unggahLampiran(file, `survey:${proposalId}`)),
        );
        lampiran = stored.map((item) => item.path);
      } catch (cause) {
        // The survey is NOT saved when a photo failed to store. Saving it
        // anyway would record a survey whose evidence does not exist.
        setGagalUnggah(
          cause instanceof Error
            ? `Foto gagal diunggah, hasil survey tidak disimpan. ${cause.message}`
            : "Foto gagal diunggah, hasil survey tidak disimpan.",
        );
        return;
      }
    }

    const hasil = await simpan.jalankan({
      proposalId,
      tanggalSurvey,
      hasil: Object.fromEntries(
        ASPEK.map((aspek) => [
          aspek.id,
          { skor: Number(skor[aspek.id] ?? "0"), catatan: catatanAspek[aspek.id] ?? "" },
        ]),
      ),
      skorTotal: total.toFixed(2),
      plafonRekomendasi: plafon,
      tenorRekomendasi: Number(tenor),
      catatan: catatan.trim() || null,
      lampiranFoto: lampiran,
    });
    if (hasil) navigate(`/pumk/proposal/${proposalId}`);
  }

  if (proposalId === null) {
    return (
      <PumkPage route={route}>
        <Muat
          hasil={antrean}
          judul="antrean survey"
          sumber="GET /api/pumk/proposal?status=SURVEY_PENDING"
        >
          {(data) =>
            data.data.length === 0 ? (
              <AntreanKosong
                icon="camera"
                title="Tidak ada proposal yang menunggu survey"
                description="Proposal masuk ke antrean ini setelah Maker mengajukannya untuk survey."
              />
            ) : (
              <Panel
                as="h2"
                title="Menunggu survey"
                description="Pilih satu proposal untuk mengisi hasil kunjungan lapangan."
                footer={<span>{formatCount(data.data.length)} proposal menunggu kunjungan.</span>}
              >
                <DaftarDokumen
                  columns={ANTREAN_COLUMNS}
                  rows={data.data}
                  rowKey={(row) => row.id}
                  onPilih={(row) => setProposalId(row.id)}
                  emptyTitle="Tidak ada proposal yang menunggu survey"
                  emptyDescription="Antrean terisi setelah Maker mengajukan proposal untuk survey."
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
      title="Input Hasil Survey"
      back={{ to: "/pumk/survey", label: "Antrean survey" }}
    >
      <Muat hasil={detail} judul="data proposal" sumber={`GET /api/pumk/proposal/${proposalId}`}>
        {(data) => (
          <FormLayout
            form={
              <form className="form-main" onSubmit={submit}>
                <Bagian
                  title="Skoring survey"
                  description={`Lima aspek sesuai spesifikasi data survey. Setiap aspek bernilai 0 sampai ${SKOR_MAKS_PER_ASPEK}, total maksimal ${totalMaks}.`}
                  aside={
                    <span className="skor-total">
                      <span className="skor-total-label">Total</span>
                      <span className="skor-total-val">{formatCount(total)}</span>
                    </span>
                  }
                >
                  <div className="aspek-list">
                    {ASPEK.map((aspek) => (
                      <div className="aspek-row" key={aspek.id}>
                        <Field label={aspek.label} htmlFor={`skor-${aspek.id}`} required>
                          <TextInput
                            id={`skor-${aspek.id}`}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={SKOR_MAKS_PER_ASPEK}
                            value={skor[aspek.id] ?? ""}
                            onChange={(event) =>
                              setSkor((current) => ({
                                ...current,
                                [aspek.id]: event.currentTarget.value,
                              }))
                            }
                          />
                        </Field>
                        <Field label={`Catatan ${aspek.label.toLowerCase()}`} htmlFor={`catatan-${aspek.id}`}>
                          <TextInput
                            id={`catatan-${aspek.id}`}
                            value={catatanAspek[aspek.id] ?? ""}
                            onChange={(event) =>
                              setCatatanAspek((current) => ({
                                ...current,
                                [aspek.id]: event.currentTarget.value,
                              }))
                            }
                          />
                        </Field>
                      </div>
                    ))}
                  </div>
                </Bagian>

                <Bagian
                  title="Rekomendasi surveyor"
                  description="Plafon dan tenor yang menurut hasil kunjungan sanggup dipenuhi Mitra Binaan. Approver tetap dapat mengubahnya."
                >
                  <FieldGrid>
                    <Field label="Tanggal survey" htmlFor="tanggal-survey" required>
                      <TextInput
                        id="tanggal-survey"
                        type="date"
                        value={tanggalSurvey}
                        onChange={(event) => setTanggalSurvey(event.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Petugas survey" htmlFor="petugas">
                      <TextInput id="petugas" value={session.user.nama} readOnly />
                    </Field>
                    <Field
                      label="Plafon rekomendasi"
                      htmlFor="plafon-rekomendasi"
                      required
                      error={plafonTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                    >
                      <MoneyInput
                        id="plafon-rekomendasi"
                        value={plafon}
                        invalid={!plafonTerbaca}
                        onValueChange={(value, raw) => {
                          setPlafon(value ?? "");
                          setPlafonTerbaca(raw.trim() === "" || value !== null);
                        }}
                      />
                    </Field>
                    <Field label="Tenor rekomendasi (bulan)" htmlFor="tenor-rekomendasi" required>
                      <TextInput
                        id="tenor-rekomendasi"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={tenor}
                        onChange={(event) => setTenor(event.currentTarget.value)}
                      />
                    </Field>
                  </FieldGrid>
                  <Field label="Catatan surveyor" htmlFor="catatan-survey">
                    <Textarea
                      id="catatan-survey"
                      rows={3}
                      value={catatan}
                      onChange={(event) => setCatatan(event.currentTarget.value)}
                    />
                  </Field>
                </Bagian>

                <Bagian
                  title="Foto dan dokumen pendukung"
                  description="Foto lokasi usaha dan dokumen pendukung. Berkas diunggah saat Anda menyimpan, dan hasil survey hanya tersimpan bila seluruh berkas berhasil diunggah."
                >
                  <FilePicker
                    label="Pilih foto"
                    accept="image/*,application/pdf"
                    files={foto}
                    onChange={setFoto}
                    hint="Format gambar atau PDF. Bisa memilih lebih dari satu berkas."
                  />
                </Bagian>

                <BarisAksi
                  error={gagalUnggah ?? simpan.error}
                  secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                  primary={
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!lengkap}
                      loading={simpan.status === "mengirim"}
                      loadingLabel="Menyimpan"
                    >
                      Simpan hasil survey
                    </Button>
                  }
                />
              </form>
            }
            aside={
              <aside className="form-aside">
                <Panel
                  as="h2"
                  title="Proposal yang disurvey"
                  aside={<StatusBadge status={data.proposal.status} />}
                  footer={<span>Sumber: pumk_proposal dan master mitra.</span>}
                >
                  <DataList
                    items={[
                      { label: "No proposal", value: data.proposal.noProposal },
                      { label: "Mitra Binaan", value: data.proposal.mitraNama },
                      { label: "NIK", value: data.proposal.mitraNik ?? "Belum diisi" },
                      { label: "Sektor", value: data.proposal.sektorNama ?? "Belum diisi" },
                      {
                        label: "Nilai diajukan",
                        value: formatMoney(data.proposal.jumlahDiajukan),
                        numeric: true,
                      },
                      {
                        label: "Tenor diajukan",
                        value: `${formatCount(data.proposal.tenorDiajukan)} bulan`,
                        numeric: true,
                      },
                      { label: "Tanggal proposal", value: formatDate(data.proposal.tanggalProposal) },
                    ]}
                  />
                </Panel>

                <Panel
                  as="h2"
                  title="Skor dan batas kelulusan"
                  footer={
                    <span>
                      {minimum === null
                        ? "Skor minimum belum terbaca dari Parameter Sistem."
                        : total >= minimum
                          ? "Skor memenuhi batas minimum untuk direkomendasikan."
                          : "Skor di bawah batas minimum. Checker tidak dapat merekomendasikan proposal ini."}
                    </span>
                  }
                >
                  <DataList
                    items={[
                      { label: "Total skor", value: formatCount(total), numeric: true },
                      { label: "Skor maksimal", value: formatCount(totalMaks), numeric: true },
                      {
                        label: "Skor minimum lolos",
                        value:
                          batas.status === "gagal"
                            ? "Tidak terbaca"
                            : minimum === null
                              ? "Memuat"
                              : formatCount(minimum),
                        numeric: true,
                      },
                      {
                        label: "Aspek terisi",
                        value: `${formatCount(ASPEK.filter((a) => (skor[a.id] ?? "") !== "").length)} dari ${formatCount(ASPEK.length)}`,
                        numeric: true,
                      },
                    ]}
                  />
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
