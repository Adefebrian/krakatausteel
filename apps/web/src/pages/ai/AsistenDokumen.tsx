// Asisten Pembacaan Dokumen, spec 12 priority 1.
//
// WHAT THIS PAGE IS. A Maker pastes the text of a document, the assistant
// proposes a set of fields, and the Maker reads the evidence, edits what is
// wrong, ticks what they will actually use, and then goes and fills in the
// ordinary form in the ordinary module. That last clause is the whole design:
// NOTHING IS EVER SAVED FROM THE EXTRACTION ALONE, and there is no control on
// this page that creates a proposal, a mitra, an attachment or a journal,
// because the engine behind it holds no port that could.
//
// FOUR THINGS THIS SCREEN HAS TO KEEP TRUE, all of them properties the server
// already holds rather than opinions of this file:
//
//   THE ASSISTANT PROPOSES, A PERSON DECIDES. `perluKonfirmasi` is a
//   server-set constant on the envelope and it is read, not assumed. Every
//   proposed value lands in an input the reader can overwrite, every "Pakai
//   nilai ini" tick starts UNTICKED, and the button that records a decision
//   says in its own label exactly what will be recorded. There is no timer, no
//   auto-accept, no accept-on-mount and no default selection anywhere below.
//
//   THE EVIDENCE IS SHOWN, NOT JUST THE ANSWER. Each field carries the span
//   the model claims it read from, and whether the SERVER found that span in
//   the text that was submitted. A field whose citation did not verify is
//   marked in its head row, before its value is read, and the engine's own
//   sentence about it is printed underneath. A hallucinated value arrives here
//   visibly unsupported instead of arriving as a confident suggestion.
//
//   OFF IS NOT BROKEN. `GET /ai/status` is the one endpoint that is not behind
//   the flag, exactly so a screen can find out there is no button to draw.
//   With the layer off this page renders a sentence saying so and nothing
//   else: no error panel, no spinner, no form that would post into a feature
//   that is switched off.
//
//   THE DOCUMENT TEXT IS UNTRUSTED, AND SO IS EVERY ANSWER ABOUT IT. Values,
//   quotes and notes are rendered as React text nodes and as input values,
//   never as markup, and nothing on this page branches on anything a model
//   returned. The upload control does not upload: the file is read in the
//   browser and its text is put in the box the reader can see, so what is sent
//   is what they are looking at.
import { useEffect, useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  Field,
  FilePicker,
  Icon,
  MoneyInput,
  Panel,
  Select,
  Textarea,
  TextInput,
  formatCount,
  formatDate,
} from "@krakatausteel/ui";
import {
  ekstrakDokumen,
  konfirmasiSaran,
  statusAi,
  type FieldEkstraksi,
  type HasilEkstraksi,
  type HasilKonfirmasi,
  type JenisDokumen,
  type KeputusanSaran,
} from "../../api/ai";
import { useAction, useApi, type HasilAksi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { CatatanOtorisasi, HalamanModul, Muat } from "../shared/parts";
import {
  AsistenMati,
  CatatanAsisten,
  DaftarFakta,
  KartuRingkas,
  LencanaBelumTersimpan,
  LencanaKutipan,
  NAMA_JENIS_DOKUMEN,
  NAMA_TIPE_FIELD,
  persenKeyakinan,
  teksUang,
} from "./parts";

/** The redaction classes the server counts, in words. */
const NAMA_REDAKSI: Record<string, string> = {
  EMAIL: "Alamat email",
  NPWP: "NPWP",
  NIK: "NIK",
  TELP: "Nomor telepon",
  NOMOR: "Deret angka panjang",
};

/** What `MoneyInput` can read back. Anything else stays in the plain box. */
const POLA_UANG_TAMPIL = /^\d{1,15}(\.\d{1,2})?$/;

const KATA_KEPUTUSAN: Record<KeputusanSaran, string> = {
  DITERIMA: "Seluruh usulan saya pakai",
  SEBAGIAN: "Sebagian usulan saya pakai",
  DITOLAK: "Tidak ada usulan yang saya pakai",
};

/**
 * Copy to clipboard, with the copied state falling back after a moment.
 *
 * ITS OWN COPY RATHER THAN AN IMPORT FROM ../../portal. That module is the
 * PUBLIC surface, deliberately isolated from the staff app (App.tsx decides
 * which of the three surfaces is mounted before anything else), and reaching
 * into it from a staff page would quietly reunify two things ADR 0019 keeps
 * apart at every other level.
 */
function useSalin(): [boolean, (teks: string) => void] {
  const [tersalin, setTersalin] = useState(false);
  useEffect(() => {
    if (!tersalin) return;
    const timer = setTimeout(() => setTersalin(false), 2500);
    return () => clearTimeout(timer);
  }, [tersalin]);
  return [
    tersalin,
    (teks: string) => {
      // Optional chaining, not a try/catch: clipboard access is absent in a
      // test document and refused in an insecure context, and neither is an
      // error worth showing over a convenience button.
      void navigator.clipboard?.writeText?.(teks).then(
        () => setTersalin(true),
        () => setTersalin(false),
      );
    },
  ];
}

export function AsistenDokumen({ route }: { route: PageRoute }) {
  const status = useApi(() => statusAi(), []);

  return (
    <HalamanModul route={route}>
      <Muat hasil={status} judul="status asisten" sumber="GET /api/ai/status">
        {(data) =>
          data.aktif && data.kemampuan.ekstraksiDokumen ? (
            <Kerja
              jenisDokumen={data.jenisDokumen}
              maksKarakter={data.batas.maksKarakterDokumen}
              perUser={data.batas.ekstraksiPerUser}
              jendelaDetik={data.batas.jendelaDetik}
              model={data.model}
            />
          ) : (
            <AsistenMati
              judul="Asisten dokumen sedang dimatikan"
              kalimat="Lapisan asisten tidak diaktifkan pada server ini, jadi tidak ada usulan yang bisa diminta dari halaman ini."
              sebagaiGantinya="Isi formulir proposal, invoice, atau LPJ seperti biasa di modulnya masing masing. Tidak ada langkah yang hilang: asisten hanya mempercepat pengetikan, tidak pernah menjadi syarat sebuah dokumen bisa dibuat."
            />
          )
        }
      </Muat>

      <CatatanAsisten tambahan="Dokumen dibuat dengan mengisi formulir di modulnya sendiri, bukan dari halaman ini." />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan ai.ekstraksi." />
    </HalamanModul>
  );
}

function Kerja({
  jenisDokumen,
  maksKarakter,
  perUser,
  jendelaDetik,
  model,
}: {
  jenisDokumen: readonly JenisDokumen[];
  maksKarakter: number;
  perUser: number;
  jendelaDetik: number;
  model: string | null;
}) {
  const [jenis, setJenis] = useState<JenisDokumen>(jenisDokumen[0] ?? "PROPOSAL");
  const [teks, setTeks] = useState("");
  const [berkas, setBerkas] = useState<File[]>([]);
  const [bacaGagal, setBacaGagal] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [pakai, setPakai] = useState<Record<string, boolean>>({});

  const ekstraksi = useAction(ekstrakDokumen);
  const konfirmasi = useAction((keputusan: KeputusanSaran) =>
    konfirmasiSaran(ekstraksi.hasil?.saranId ?? "", keputusan),
  );

  const bersih = teks.trim();
  const terlaluPanjang = teks.length > maksKarakter;
  const bisaMinta = bersih !== "" && !terlaluPanjang && ekstraksi.status !== "mengirim";

  /**
   * Reads a picked file INTO THE BOX, and never past it. The bytes are not
   * uploaded and no endpoint here takes a file: the text lands in the textarea
   * above, so the reader sees exactly the characters that will be sent.
   */
  async function bacaBerkas(dipilih: File[]) {
    setBerkas(dipilih);
    setBacaGagal(null);
    const satu = dipilih[0];
    if (!satu) return;
    try {
      const isi = await satu.text();
      setTeks(isi.slice(0, maksKarakter));
      if (isi.length > maksKarakter) {
        setBacaGagal(
          `Berkas lebih panjang dari batas ${formatCount(maksKarakter)} karakter, jadi hanya bagian awalnya yang dimuat. Periksa kotak teks di atas sebelum meminta usulan.`,
        );
      }
    } catch {
      setBacaGagal(
        "Isi berkas tidak bisa dibaca sebagai teks. Salin dan tempel sendiri isinya ke kotak di atas.",
      );
    }
  }

  async function minta() {
    // Every trace of the previous answer goes before the new call, so a stale
    // tick can never survive into a new set of suggestions.
    setEdit({});
    setPakai({});
    konfirmasi.reset();
    await ekstraksi.jalankan({ jenis, teks, konteksTipe: null, konteksId: null });
  }

  const hasil = ekstraksi.hasil;

  return (
    <>
      <Panel
        as="h2"
        title="Teks dokumen"
        description="Tempel isi dokumen di sini, atau muat dari berkas teks. Berkasnya tidak diunggah: isinya dibaca di peramban lalu ditaruh di kotak ini, jadi yang dikirim persis yang Anda lihat."
        footer={
          <span className="panel-foot-note">
            Model: {model ?? "tidak disebutkan"}. Batas {formatCount(perUser)} permintaan per{" "}
            {formatCount(Math.round(jendelaDetik / 60))} menit per pengguna, maksimal{" "}
            {formatCount(maksKarakter)} karakter per dokumen.
          </span>
        }
      >
        <div className="asisten-form">
          <Field
            label="Jenis dokumen"
            required
            hint="Menentukan daftar isian yang boleh diusulkan. Isian di luar daftar itu dibuang server, bukan ditampilkan."
          >
            <Select
              aria-label="Jenis dokumen"
              value={jenis}
              onChange={(event) => setJenis(event.currentTarget.value as JenisDokumen)}
              options={jenisDokumen.map((nilai) => ({
                value: nilai,
                label: NAMA_JENIS_DOKUMEN[nilai] ?? nilai,
              }))}
            />
          </Field>

          <Field
            label="Isi dokumen"
            required
            hint={`Terisi ${formatCount(teks.length)} dari ${formatCount(maksKarakter)} karakter.`}
            {...(terlaluPanjang
              ? {
                  error: `Teks melebihi batas ${formatCount(maksKarakter)} karakter. Potong dulu bagian yang tidak diperlukan.`,
                }
              : {})}
          >
            <Textarea
              aria-label="Isi dokumen"
              rows={10}
              value={teks}
              invalid={terlaluPanjang}
              onChange={(event) => setTeks(event.currentTarget.value)}
            />
          </Field>

          <FilePicker
            label="Muat dari berkas teks"
            files={berkas}
            multiple={false}
            accept=".txt,.md,.csv,text/plain"
            hint="Hanya berkas teks. PDF dan gambar tidak dibaca di sini, salin isinya sendiri."
            onChange={(dipilih) => void bacaBerkas(dipilih)}
          />
          {bacaGagal ? (
            <p className="asisten-peringatan" role="status">
              <Icon name="alert" size={16} />
              <span>{bacaGagal}</span>
            </p>
          ) : null}

          <div className="form-actions-row">
            <Button
              variant="secondary"
              disabled={teks === "" && berkas.length === 0}
              onClick={() => {
                setTeks("");
                setBerkas([]);
                setBacaGagal(null);
              }}
            >
              Kosongkan
            </Button>
            <Button
              variant="primary"
              disabled={!bisaMinta}
              loading={ekstraksi.status === "mengirim"}
              loadingLabel="Meminta usulan"
              onClick={() => void minta()}
              leading={<Icon name="search" size={16} />}
            >
              Minta usulan
            </Button>
          </div>

          {ekstraksi.status === "gagal" ? (
            <p className="asisten-peringatan" role="alert">
              <Icon name="alert" size={16} />
              <span>
                Permintaan ke POST /api/ai/ekstraksi ditolak server: {ekstraksi.error}. Tidak ada
                yang tersimpan, dan formulir di modul terkait tetap bisa diisi seperti biasa.
              </span>
            </p>
          ) : null}
        </div>
      </Panel>

      {hasil === null ? null : hasil.status === "NONAKTIF" ? (
        <AsistenMati
          judul="Asisten dimatikan saat permintaan ini dikirim"
          kalimat={hasil.alasan ?? "Asisten dokumen sedang dimatikan."}
          sebagaiGantinya="Isi formulirnya seperti biasa. Tidak ada usulan yang dibuat dan tidak ada catatan yang disimpan untuk permintaan ini."
        />
      ) : hasil.status === "GAGAL" ? (
        <Panel
          as="h2"
          title="Asisten tidak bisa menjawab"
          description="Permintaan sampai ke server dan dijawab, tetapi tidak ada usulan yang bisa dipakai."
          aside={<LencanaBelumTersimpan perlu={hasil.perluKonfirmasi} />}
        >
          <p className="asisten-mati-kalimat">
            {hasil.alasan ?? "Asisten gagal menjawab permintaan ini."}
          </p>
          <p className="asisten-mati-lanjut">
            Isi formulirnya sendiri seperti biasa. Kegagalan asisten tidak menahan apa pun: tidak
            ada dokumen yang tertunda karena ini.
          </p>
        </Panel>
      ) : (
        <Usulan
          hasil={hasil}
          edit={edit}
          setEdit={setEdit}
          pakai={pakai}
          setPakai={setPakai}
          konfirmasi={konfirmasi}
        />
      )}
    </>
  );
}

function Usulan({
  hasil,
  edit,
  setEdit,
  pakai,
  setPakai,
  konfirmasi,
}: {
  hasil: HasilEkstraksi;
  edit: Record<string, string>;
  setEdit: (nilai: Record<string, string>) => void;
  pakai: Record<string, boolean>;
  setPakai: (nilai: Record<string, boolean>) => void;
  konfirmasi: HasilAksi<KeputusanSaran, HasilKonfirmasi>;
}) {
  const [tersalin, salin] = useSalin();

  const bernilai = hasil.field.filter((field) => field.nilai !== null);
  const tanpaKutipan = hasil.field.filter(
    (field) => field.nilai !== null && !field.kutipanTerverifikasi,
  );
  const dipilih = hasil.field.filter((field) => pakai[field.kunci] === true);

  // THE DECISION IS DERIVED FROM WHAT THE PERSON TICKED, and nothing else.
  // With no tick it is a refusal, which is the correct record of "I looked and
  // used none of it" rather than an absence of a record.
  const keputusan: KeputusanSaran =
    dipilih.length === 0
      ? "DITOLAK"
      : dipilih.length === bernilai.length
        ? "DITERIMA"
        : "SEBAGIAN";

  function nilaiSekarang(field: FieldEkstraksi): string {
    return edit[field.kunci] ?? field.nilai ?? "";
  }

  // WHAT IS COPIED IS WHAT A PERSON WILL PASTE INTO A MONEY FIELD, so an
  // amount is copied in the product's own notation rather than as the engine's
  // decimal string. "18500000.00" pasted into a rupiah input reads its dot as a
  // thousands separator; "18.500.000,00" does not.
  const teksSalin = dipilih
    .map((field) => {
      const isi = nilaiSekarang(field);
      const tampil =
        field.tipe === "UANG" && POLA_UANG_TAMPIL.test(isi) ? teksUang(isi) : isi;
      return `${field.label}: ${tampil}`;
    })
    .join("\n");

  const redaksi = Object.entries(hasil.ringkasanMasukan.redaksi);

  return (
    <>
      <Bento columns={4}>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Status usulan"
            nilai={hasil.perluKonfirmasi ? "Belum tersimpan" : "Tanpa konfirmasi"}
            catatan="Tidak ada isi di bawah ini yang sudah masuk ke dokumen mana pun. Dokumen dibuat saat Anda mengisi dan menyimpan formulirnya sendiri."
          />
        </BentoItem>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Isian diusulkan"
            nilai={`${formatCount(bernilai.length)} dari ${formatCount(hasil.field.length)}`}
            catatan="Isian yang tidak diusulkan dibiarkan kosong oleh asisten, bukan ditebak."
          />
        </BentoItem>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Kutipan tidak ditemukan"
            nilai={formatCount(tanpaKutipan.length)}
            catatan="Potongan teks yang disebut model tidak ada di dokumen yang dikirim. Keyakinannya dibatasi server dan nilainya wajib dicek sendiri."
          />
        </BentoItem>
        <BentoItem span="sm">
          <KartuRingkas
            judul="Waktu usulan"
            nilai={formatDate(hasil.dibuatPada)}
            catatan={`Jenis dokumen ${NAMA_JENIS_DOKUMEN[hasil.jenis] ?? hasil.jenis}, sumber ${hasil.sumber}, model ${hasil.model ?? "tidak disebutkan"}.`}
          />
        </BentoItem>
      </Bento>

      <Panel
        as="h2"
        title="Usulan isian"
        description="Setiap baris adalah usulan, bukan nilai tersimpan. Ubah yang salah, lalu centang hanya yang benar benar Anda pakai."
        aside={<LencanaBelumTersimpan perlu={hasil.perluKonfirmasi} />}
        footer={
          <span className="panel-foot-note">
            Sumber: POST /api/ai/ekstraksi. Kewenangan ai.ekstraksi. Tidak ada endpoint di halaman
            ini yang menulis proposal, mitra, atau jurnal.
          </span>
        }
      >
        {hasil.field.length === 0 ? (
          <p className="asisten-mati-kalimat">
            Asisten tidak mengusulkan satu isian pun untuk dokumen ini. Isi formulirnya seperti
            biasa.
          </p>
        ) : (
          <ul className="usulan-grid">
            {hasil.field.map((field) => (
              <BarisUsulan
                key={field.kunci}
                field={field}
                nilai={nilaiSekarang(field)}
                dipakai={pakai[field.kunci] === true}
                onNilai={(nilai) => setEdit({ ...edit, [field.kunci]: nilai })}
                onPakai={(nilai) => setPakai({ ...pakai, [field.kunci]: nilai })}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        as="h2"
        title="Keputusan Anda"
        description="Mencatat bahwa seseorang sudah melihat usulan ini dan apa keputusannya. Pencatatan ini tidak membuat dokumen apa pun."
        footer={
          <span className="panel-foot-note">
            Sumber: POST /api/ai/saran/:id/konfirmasi. Yang ditulis hanya baris log saran.
          </span>
        }
      >
        <p className="asisten-keputusan-ringkas">
          {formatCount(dipilih.length)} dari {formatCount(bernilai.length)} usulan bernilai Anda
          centang. Yang akan dicatat: {KATA_KEPUTUSAN[keputusan]}.
        </p>

        {hasil.saranId === null ? (
          <p className="asisten-mati-teknis">
            Tidak ada baris saran yang tersimpan untuk permintaan ini, jadi tidak ada yang bisa
            dikonfirmasi. Itu memang perilaku yang benar: mencatat konfirmasi atas saran yang tidak
            pernah dibuat akan menjadi catatan atas peristiwa yang tidak terjadi.
          </p>
        ) : (
          <div className="form-actions-row">
            <Button
              variant="secondary"
              disabled={dipilih.length === 0}
              onClick={() => salin(teksSalin)}
              leading={<Icon name="file" size={16} />}
            >
              {tersalin ? "Nilai tercentang tersalin" : "Salin nilai tercentang"}
            </Button>
            <Button
              variant="primary"
              loading={konfirmasi.status === "mengirim"}
              loadingLabel="Mencatat"
              disabled={konfirmasi.status === "selesai"}
              onClick={() => void konfirmasi.jalankan(keputusan)}
              leading={<Icon name="check" size={16} />}
            >
              Catat keputusan: {KATA_KEPUTUSAN[keputusan]}
            </Button>
          </div>
        )}

        {konfirmasi.status === "selesai" && konfirmasi.hasil ? (
          <p className="asisten-peringatan is-selesai" role="status">
            <Icon name="checkCircle" size={16} />
            <span>
              Keputusan tercatat pada {formatDate(konfirmasi.hasil.dikonfirmasiPada)}. Tidak ada
              dokumen yang dibuat oleh pencatatan ini. Lanjutkan dengan mengisi formulir di
              modulnya.
            </span>
          </p>
        ) : null}

        {konfirmasi.status === "gagal" ? (
          <p className="asisten-peringatan" role="alert">
            <Icon name="alert" size={16} />
            <span>
              Keputusan gagal dicatat: {konfirmasi.error}. Usulan di atas tidak berubah, dan tidak
              ada dokumen yang terpengaruh.
            </span>
          </p>
        ) : null}
      </Panel>

      <Panel
        as="h2"
        title="Yang dikirim ke model"
        description="Identitas disamarkan sebelum permintaan dikirim, lalu dikembalikan ke nilai aslinya setelah jawaban diterima, jadi isian di atas tetap berisi nilai sebenarnya."
        footer={
          <span className="panel-foot-note">
            Data buku besar dan data mitra tidak pernah ikut: jalur ekstraksi hanya membaca teks
            dari permintaan ini.
          </span>
        }
      >
        <DaftarFakta
          items={[
            {
              kunci: "Karakter dokumen",
              nilai: formatCount(hasil.ringkasanMasukan.karakterDokumen),
            },
            {
              kunci: "Karakter yang dikirim",
              nilai: formatCount(hasil.ringkasanMasukan.karakterDikirim),
            },
            ...redaksi.map(([kelas, jumlah]) => ({
              kunci: `Disamarkan: ${NAMA_REDAKSI[kelas] ?? kelas}`,
              nilai: formatCount(jumlah),
            })),
            {
              kunci: "Sidik jari permintaan",
              nilai: hasil.ringkasanMasukan.hashPrompt ?? "tidak ada",
            },
          ]}
        />
        {redaksi.length === 0 ? (
          <p className="asisten-mati-teknis">
            Tidak ada identitas berpola yang ditemukan untuk disamarkan pada teks ini. Nama,
            alamat, dan uraian bebas memang dikirim apa adanya, karena itulah yang harus dibaca.
          </p>
        ) : null}
      </Panel>
    </>
  );
}

/**
 * ONE SHAPE FOR EVERY PROPOSED FIELD, whatever it carries.
 *
 * Head row with the label, the type and the citation verdict; the editable
 * value; the confidence; the quoted span, clamped to two lines so a long quote
 * and a short one produce the same card; the engine's notes; and the tick,
 * pinned to the bottom of the card so the whole grid's ticks rest on one
 * baseline. Nothing a model returns can change the shape of this card, which is
 * what keeps eleven suggestions reading as one list.
 */
function BarisUsulan({
  field,
  nilai,
  dipakai,
  onNilai,
  onPakai,
}: {
  field: FieldEkstraksi;
  nilai: string;
  dipakai: boolean;
  onNilai: (nilai: string) => void;
  onPakai: (nilai: boolean) => void;
}) {
  const kosong = field.nilai === null;
  return (
    <li className={dipakai ? "usulan-item is-dipakai" : "usulan-item"}>
      <div className="usulan-head">
        <span className="usulan-label">{field.label}</span>
        {kosong ? null : <LencanaKutipan terverifikasi={field.kutipanTerverifikasi} />}
      </div>

      <Field label={`Nilai usulan untuk ${field.label}`} hint={NAMA_TIPE_FIELD[field.tipe]}>
        {/*
          A PROPOSED AMOUNT IS TYPED IN THE SAME CONTROL EVERY OTHER AMOUNT IN
          THE PRODUCT IS TYPED IN, and that is not tidiness. The engine keeps an
          extracted amount as a decimal STRING until a human confirms it
          (invariant 7), so the raw value here is "18500000.00"; showing that on
          an Indonesian screen invites a Maker to copy it into a money field
          where a dot is a THOUSANDS separator, and 18,5 million becomes 1,85
          billion. Caught by screenshot at 1440. `MoneyInput` renders it as
          "18.500.000,00" and hands back the same `Uang` string, so what is read
          and what is carried are both right.

          A value that is not a readable amount falls back to the plain box, so
          it is still shown verbatim rather than silently blanked by a control
          that could not parse it.
        */}
        {field.tipe === "UANG" && (nilai === "" || POLA_UANG_TAMPIL.test(nilai)) ? (
          <MoneyInput
            aria-label={`Nilai usulan untuk ${field.label}`}
            value={nilai}
            onValueChange={(baru) => onNilai(baru ?? "")}
          />
        ) : (
          <TextInput
            aria-label={`Nilai usulan untuk ${field.label}`}
            value={nilai}
            maxLength={300}
            autoComplete="off"
            placeholder={kosong ? "Tidak diusulkan, isi sendiri" : undefined}
            onChange={(event) => onNilai(event.currentTarget.value)}
          />
        )}
      </Field>

      <p className="usulan-keyakinan">
        Keyakinan {persenKeyakinan(field.keyakinan)}
        {kosong ? ", karena asisten tidak mengusulkan nilai untuk isian ini" : ""}
      </p>

      {/*
        AN ISIAN WITH NO PROPOSAL HAS NO EVIDENCE TO SHOW, AND SAYING "the quote
        was not found" ABOUT IT WOULD BE A FABRICATED COMPLAINT. There is
        nothing to find because nothing was claimed, so the card says exactly
        that and drops the citation lines rather than printing a citation state
        for a value that does not exist.
      */}
      {kosong ? (
        <p className="usulan-posisi">
          Asisten tidak mengusulkan nilai untuk isian ini, jadi tidak ada potongan teks yang perlu
          dicocokkan. Isi sendiri seperti biasa.
        </p>
      ) : (
        <>
          <p className="usulan-kutipan">
            {field.kutipan === null
              ? "Asisten tidak menyebut potongan teks sumbernya."
              : `Dibaca dari: ${field.kutipan}`}
          </p>
          <p className="usulan-posisi">
            {field.kutipanTerverifikasi
              ? `Ditemukan pada karakter ke ${formatCount(field.mulai)} sampai ${formatCount(field.akhir)} di teks yang Anda kirim.`
              : "Potongan itu tidak ditemukan di teks yang Anda kirim."}
          </p>
        </>
      )}

      {field.catatan.length === 0 ? null : (
        <ul className="usulan-catatan">
          {field.catatan.map((catatan) => (
            <li key={catatan}>{catatan}</li>
          ))}
        </ul>
      )}

      <label className="usulan-pakai">
        <input
          type="checkbox"
          checked={dipakai}
          disabled={kosong && nilai.trim() === ""}
          onChange={(event) => onPakai(event.currentTarget.checked)}
        />
        <span>Pakai nilai ini</span>
      </label>
    </li>
  );
}
