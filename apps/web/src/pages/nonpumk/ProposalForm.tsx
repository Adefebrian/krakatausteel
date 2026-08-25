// Input Proposal Non PUMK, spec 9.2.
//
// TWO MAPPINGS THE SPEC CALLS MANDATORY, AND THEY ARE MANDATORY HERE TOO: one
// bidang, and AT LEAST ONE SDG with a weight. They are not "recommended
// fields" with a server side surprise at the end; the submit button stays shut
// until both are present, and the engine refuses BIDANG_TIDAK_DITEMUKAN and
// SDG_WAJIB after that.
//
// THE FORM FAILS CLOSED WHEN IT CANNOT READ ITS OWN LIMITS. `GET
// /api/nonpumk/batasan` answers nilai_min and nilai_max out of `konfigurasi`.
// Migration 0022 ships all four Non PUMK rows, so on a migrated database this
// call succeeds; it can still fail on an un-migrated one, on a row an operator
// deleted, or because the request itself did not get through, and the button
// stays shut for any of those.
//
// The copy on screen says only "tidak dapat dibaca" and names the endpoint. It
// does NOT claim the rows are missing, because this page cannot see whether
// they are: a 503 from a database that is down and a 404 from a row nobody
// created look the same from here, and guessing between them would put a
// statement about the system's configuration in front of someone with no way
// to check it.
//
// Sending a grant proposal whose amount was never compared against a limit is
// worse than making someone retry: the value would travel all the way to an
// approver carrying an implied "this was checked" that never happened.
import { useMemo, useState } from "react";
import {
  Button,
  DataList,
  ErrorState,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
  bandingUang,
  formatCount,
  formatMoney,
  formatRupiah,
  parseRate,
} from "@krakatausteel/ui";
import {
  batasanNonPumk,
  buatProposal,
  daftarBidang,
  daftarSdg,
  type SdgInput,
} from "../../api/nonpumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  FieldGrid,
  FormLayout,
  HalamanModul,
  hariIni,
} from "../shared/parts";

interface BarisSdg {
  sdgId: string;
  nomor: number;
  nama: string;
  /** What the operator typed. Parsed to the API's shape only on submit. */
  bobot: string;
}

const BOBOT_DEFAULT = "1";

/** A weight the engine accepts: a decimal above 0 and at most 1. */
function bacaBobot(teks: string): string | null {
  const parsed = parseRate(teks);
  if (parsed === null) return null;
  const angka = Number(parsed);
  if (!Number.isFinite(angka) || angka <= 0 || angka > 1) return null;
  return parsed;
}

export function ProposalForm({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();

  const [tanggalProposal, setTanggalProposal] = useState(hariIni());
  const [namaPemohon, setNamaPemohon] = useState("");
  const [atasNama, setAtasNama] = useState("");
  const [alamat, setAlamat] = useState("");
  const [telepon, setTelepon] = useState("");
  const [bidangId, setBidangId] = useState("");
  const [judulProgram, setJudulProgram] = useState("");
  const [deskripsiProgram, setDeskripsiProgram] = useState("");
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [penerima, setPenerima] = useState("");
  const [sdgTerpilih, setSdgTerpilih] = useState<BarisSdg[]>([]);
  const [sdgTambah, setSdgTambah] = useState("");

  const batas = useApi(() => batasanNonPumk(), []);
  const bidang = useApi(() => daftarBidang(), []);
  const sdg = useApi(() => daftarSdg(), []);
  const simpan = useAction(buatProposal);

  const batasan = batas.data;
  const penerimaAngka = Number(penerima);

  const bidangOptions = [
    { value: "", label: "Pilih bidang Non PUMK" },
    ...(bidang.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `${item.kode} ${item.nama}`,
    })),
  ];

  const sdgTersisa = (sdg.data?.data ?? []).filter(
    (item) => !sdgTerpilih.some((baris) => baris.sdgId === item.id),
  );

  const masalah = useMemo(() => {
    const daftar: string[] = [];
    if (batasan) {
      const dibawah = jumlah ? bandingUang(jumlah, batasan.nilaiMin) : 0;
      const diatas = jumlah ? bandingUang(jumlah, batasan.nilaiMax) : 0;
      if (dibawah === null || diatas === null) {
        daftar.push(
          "Batas nilai bantuan tidak terbaca sebagai angka rupiah, jadi nilai yang diajukan tidak dapat diperiksa terhadap batas program.",
        );
      } else {
        if (dibawah < 0) {
          daftar.push(
            `Nilai yang diajukan di bawah batas minimum ${formatRupiah(batasan.nilaiMin)}.`,
          );
        }
        if (diatas > 0) {
          daftar.push(
            `Nilai yang diajukan melewati batas maksimum ${formatRupiah(batasan.nilaiMax)}.`,
          );
        }
      }
    }
    if (bidangId === "") daftar.push("Bidang Non PUMK wajib dipilih, satu bidang per program.");
    if (sdgTerpilih.length === 0) {
      daftar.push("Program wajib dipetakan ke minimal satu SDG beserta bobotnya.");
    }
    const bobotSalah = sdgTerpilih.filter((baris) => bacaBobot(baris.bobot) === null);
    if (bobotSalah.length > 0) {
      daftar.push(
        `Bobot SDG ${bobotSalah
          .map((baris) => baris.nomor)
          .join(", ")} harus berupa angka di atas 0 dan paling besar 1.`,
      );
    }
    if (penerima !== "" && (!Number.isInteger(penerimaAngka) || penerimaAngka < 0)) {
      daftar.push("Estimasi penerima manfaat harus berupa bilangan bulat.");
    }
    return daftar;
  }, [batasan, jumlah, bidangId, sdgTerpilih, penerima, penerimaAngka]);

  const lengkap =
    namaPemohon.trim() !== "" &&
    judulProgram.trim() !== "" &&
    jumlah !== "" &&
    jumlahTerbaca &&
    penerima !== "" &&
    tanggalProposal !== "";

  // Fails closed on THREE separate readings, not one: the limits, the bidang
  // list and the SDG list. A form that could not offer a bidang cannot produce
  // the mandatory mapping either, so it must not be submittable.
  const referensiSiap = batas.status === "siap" && bidang.status === "siap" && sdg.status === "siap";
  const bolehSimpan = lengkap && referensiSiap && batasan !== null && masalah.length === 0;

  function tambahSdg(id: string) {
    const item = (sdg.data?.data ?? []).find((baris) => baris.id === id);
    if (!item) return;
    setSdgTerpilih((current) => [
      ...current,
      { sdgId: item.id, nomor: item.nomor, nama: item.nama, bobot: BOBOT_DEFAULT },
    ]);
    setSdgTambah("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!bolehSimpan) return;
    const sdgPayload: SdgInput[] = sdgTerpilih.map((baris) => ({
      sdgId: baris.sdgId,
      bobot: bacaBobot(baris.bobot),
    }));
    const hasil = await simpan.jalankan({
      cabangId: session.cabang.id,
      tanggalProposal,
      namaPemohon: namaPemohon.trim(),
      atasNama: atasNama.trim() || null,
      alamat: alamat.trim() || null,
      telepon: telepon.trim() || null,
      bidangId,
      sdg: sdgPayload,
      judulProgram: judulProgram.trim(),
      deskripsiProgram: deskripsiProgram.trim() || null,
      jumlahDiajukan: jumlah,
      penerimaManfaatEstimasi: penerimaAngka,
    });
    if (hasil) navigate(`/nonpumk/proposal/${hasil.id}`);
  }

  return (
    <HalamanModul route={route} back={{ to: "/nonpumk/proposal", label: "Daftar proposal" }}>
      <FormLayout
        form={
          <form className="form-main" onSubmit={submit}>
            <Bagian
              title="Pemohon"
              description="Non PUMK tidak memiliki master peminjam. Pemohon dapat berupa lembaga, yayasan, atau perorangan, dan diketik pada proposal ini."
            >
              <FieldGrid>
                <Field label="Nama pemohon" htmlFor="np-pemohon" required>
                  <TextInput
                    id="np-pemohon"
                    value={namaPemohon}
                    onChange={(event) => setNamaPemohon(event.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="Atas nama"
                  htmlFor="np-atas-nama"
                  hint="Diisi bila penerima bantuan berbeda dari pemohon."
                >
                  <TextInput
                    id="np-atas-nama"
                    value={atasNama}
                    onChange={(event) => setAtasNama(event.currentTarget.value)}
                  />
                </Field>
                <Field label="Telepon" htmlFor="np-telepon">
                  <TextInput
                    id="np-telepon"
                    inputMode="tel"
                    value={telepon}
                    onChange={(event) => setTelepon(event.currentTarget.value)}
                  />
                </Field>
                <Field label="Tanggal proposal" htmlFor="np-tanggal" required>
                  <TextInput
                    id="np-tanggal"
                    type="date"
                    value={tanggalProposal}
                    onChange={(event) => setTanggalProposal(event.currentTarget.value)}
                  />
                </Field>
              </FieldGrid>
              <Field label="Alamat" htmlFor="np-alamat">
                <Textarea
                  id="np-alamat"
                  rows={2}
                  value={alamat}
                  onChange={(event) => setAlamat(event.currentTarget.value)}
                />
              </Field>
            </Bagian>

            <Bagian
              title="Program"
              description="Satu program dipetakan ke tepat satu bidang Non PUMK. Bidang ini juga menjadi dimensi RKA dan dimensi akun beban pada jurnal penyalurannya."
            >
              <FieldGrid>
                <Field
                  label="Bidang Non PUMK"
                  htmlFor="np-bidang"
                  required
                  hint={
                    bidang.status === "gagal"
                      ? "Daftar bidang tidak dapat dibaca dari server, jadi proposal tidak bisa disimpan."
                      : "Wajib, satu bidang per program."
                  }
                >
                  <Select
                    id="np-bidang"
                    value={bidangId}
                    disabled={bidang.status !== "siap"}
                    invalid={bidangId === "" && bidang.status === "siap"}
                    onChange={(event) => setBidangId(event.currentTarget.value)}
                    options={bidangOptions}
                  />
                </Field>
                <Field
                  label="Estimasi penerima manfaat"
                  htmlFor="np-penerima"
                  required
                  hint="Perkiraan pada tahap proposal. Angka aktualnya diisi pada LPJ."
                >
                  <TextInput
                    id="np-penerima"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={penerima}
                    onChange={(event) => setPenerima(event.currentTarget.value)}
                  />
                </Field>
              </FieldGrid>
              <Field label="Judul program" htmlFor="np-judul" required>
                <TextInput
                  id="np-judul"
                  value={judulProgram}
                  onChange={(event) => setJudulProgram(event.currentTarget.value)}
                />
              </Field>
              <Field label="Deskripsi program" htmlFor="np-deskripsi">
                <Textarea
                  id="np-deskripsi"
                  rows={3}
                  value={deskripsiProgram}
                  onChange={(event) => setDeskripsiProgram(event.currentTarget.value)}
                />
              </Field>
              <Field
                label="Nilai diajukan"
                htmlFor="np-jumlah"
                required
                error={jumlahTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
                hint={
                  batasan
                    ? `Batas program ${formatRupiah(batasan.nilaiMin)} sampai ${formatRupiah(batasan.nilaiMax)}.`
                    : "Batas program dibaca dari Parameter Sistem."
                }
              >
                <MoneyInput
                  id="np-jumlah"
                  value={jumlah}
                  invalid={!jumlahTerbaca}
                  onValueChange={(value, raw) => {
                    setJumlah(value ?? "");
                    setJumlahTerbaca(raw.trim() === "" || value !== null);
                  }}
                />
              </Field>
            </Bagian>

            <Bagian
              title="Pemetaan SDG"
              description="Wajib minimal satu SDG. Bobot bernilai di atas 0 sampai 1 dan tidak harus berjumlah 1, karena satu program dapat menyumbang penuh pada beberapa tujuan."
              aside={
                <span className="tabs-note">
                  {formatCount(sdgTerpilih.length)} SDG dipetakan
                </span>
              }
              footer={
                <span>
                  Pemetaan ini dipakai laporan Rekap Program per SDG dan tidak dapat dikosongkan.
                </span>
              }
            >
              <Field
                label="Tambah SDG"
                htmlFor="np-sdg-tambah"
                hint={
                  sdg.status === "gagal"
                    ? "Daftar SDG tidak dapat dibaca dari server, jadi proposal tidak bisa disimpan."
                    : "Pilih satu tujuan untuk menambahkannya ke daftar di bawah."
                }
              >
                <Select
                  id="np-sdg-tambah"
                  value={sdgTambah}
                  disabled={sdg.status !== "siap" || sdgTersisa.length === 0}
                  onChange={(event) => tambahSdg(event.currentTarget.value)}
                  options={[
                    { value: "", label: "Pilih SDG" },
                    ...sdgTersisa.map((item) => ({
                      value: item.id,
                      label: `SDG ${item.nomor} ${item.nama}`,
                    })),
                  ]}
                />
              </Field>

              {sdgTerpilih.length === 0 ? (
                <p className="penjelasan">
                  Belum ada SDG yang dipetakan. Proposal tidak dapat disimpan sebelum minimal satu
                  tujuan dipilih.
                </p>
              ) : (
                <ul className="sdg-edit">
                  {sdgTerpilih.map((baris) => {
                    const bobotSah = bacaBobot(baris.bobot) !== null;
                    return (
                      <li className="sdg-edit-item" key={baris.sdgId}>
                        <span className="sdg-edit-teks">
                          <span className="sdg-nomor">SDG {formatCount(baris.nomor)}</span>
                          <span className="sdg-nama">{baris.nama}</span>
                        </span>
                        <span className="sdg-edit-bobot">
                          <label className="sdg-edit-label" htmlFor={`np-bobot-${baris.sdgId}`}>
                            Bobot
                          </label>
                          <TextInput
                            id={`np-bobot-${baris.sdgId}`}
                            inputMode="decimal"
                            value={baris.bobot}
                            invalid={!bobotSah}
                            onChange={(event) => {
                              const nilai = event.currentTarget.value;
                              setSdgTerpilih((current) =>
                                current.map((item) =>
                                  item.sdgId === baris.sdgId ? { ...item, bobot: nilai } : item,
                                ),
                              );
                            }}
                          />
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          leading={<Icon name="trash" size={16} />}
                          onClick={() =>
                            setSdgTerpilih((current) =>
                              current.filter((item) => item.sdgId !== baris.sdgId),
                            )
                          }
                        >
                          Hapus
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Bagian>

            <BarisAksi
              error={simpan.error}
              secondary={
                <Button variant="ghost" onClick={() => navigate("/nonpumk/proposal")}>
                  Batal
                </Button>
              }
              primary={
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!bolehSimpan}
                  loading={simpan.status === "mengirim"}
                  loadingLabel="Menyimpan"
                >
                  Simpan sebagai draft
                </Button>
              }
            />
          </form>
        }
        aside={
          <aside className="form-aside">
            <Panel
              as="h2"
              title="Pemeriksaan sebelum kirim"
              description="Batas nilai dibaca dari Parameter Sistem, bukan ditulis di aplikasi."
              footer={
                <span>
                  {bolehSimpan
                    ? "Semua syarat terpenuhi. Proposal akan tersimpan berstatus Draft."
                    : "Tombol simpan terbuka setelah seluruh syarat di atas terpenuhi."}
                </span>
              }
            >
              {batas.status === "gagal" ? (
                <ErrorState
                  title="Batas program tidak dapat dibaca"
                  description="Tanpa Parameter Sistem, aplikasi tidak bisa memeriksa nilai minimum dan maksimum bantuan. Penyimpanan sengaja ditutup daripada mengirim pengajuan yang belum diperiksa."
                  detail={batas.error}
                  sumber="GET /api/nonpumk/batasan"
                  onRetry={batas.reload}
                />
              ) : batas.status === "memuat" ? (
                <p className="muat-memuat" role="status">
                  Memuat batas program.
                </p>
              ) : batasan ? (
                <>
                  <DataList
                    items={[
                      { label: "Nilai minimum", value: formatMoney(batasan.nilaiMin), numeric: true },
                      { label: "Nilai maksimum", value: formatMoney(batasan.nilaiMax), numeric: true },
                      {
                        label: "Skor penilaian minimum",
                        value: formatMoney(batasan.skorPenilaianMinimumLolos),
                        numeric: true,
                      },
                      {
                        label: "Batas hari LPJ",
                        value: `${formatCount(batasan.batasHariLpj)} hari`,
                        numeric: true,
                      },
                    ]}
                  />
                  {masalah.length > 0 ? (
                    <ul className="periksa-list">
                      {masalah.map((pesan) => (
                        <li className="periksa-item" key={pesan}>
                          <Icon name="alert" size={16} />
                          <span>{pesan}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="periksa-ok">
                      <Icon name="checkCircle" size={16} />
                      <span>
                        {lengkap
                          ? "Nilai, bidang, dan pemetaan SDG memenuhi syarat program."
                          : "Belum ada pelanggaran batas. Lengkapi pemohon, program, nilai, dan penerima manfaat."}
                      </span>
                    </p>
                  )}
                </>
              ) : null}
            </Panel>

            <Panel
              as="h2"
              title="Ringkasan pengajuan"
              aside={<StatusBadge status="DRAFT" />}
              footer={
                <span>
                  Proposal tersimpan sebagai Draft dan baru masuk antrean setelah diajukan ke
                  Penilaian.
                </span>
              }
            >
              <DataList
                items={[
                  { label: "Pemohon", value: namaPemohon.trim() || "Belum diisi" },
                  { label: "Program", value: judulProgram.trim() || "Belum diisi" },
                  {
                    label: "Bidang",
                    value:
                      bidangOptions.find((item) => item.value === bidangId && item.value !== "")
                        ?.label ?? "Belum dipilih",
                  },
                  {
                    label: "SDG dipetakan",
                    value:
                      sdgTerpilih.length === 0
                        ? "Belum dipetakan"
                        : sdgTerpilih.map((baris) => `SDG ${baris.nomor}`).join(", "),
                    wide: true,
                  },
                  {
                    label: "Nilai diajukan",
                    value: jumlah === "" ? "Belum diisi" : formatMoney(jumlah),
                    numeric: true,
                  },
                  {
                    label: "Estimasi penerima manfaat",
                    value: penerima === "" ? "Belum diisi" : formatCount(penerimaAngka),
                    numeric: true,
                  },
                  { label: "Cabang", value: session.cabang.nama },
                ]}
              />
            </Panel>
          </aside>
        }
      />
      <CatatanOtorisasi tambahan="Proposal tersimpan atas nama Anda sebagai Maker, dan Anda tidak dapat menjadi Checker dokumen yang sama." />
    </HalamanModul>
  );
}
