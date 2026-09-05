// Spec 9.5, the public application form. Three steps, one submit, one ticket.
//
// WHY THREE STEPS AND NOT ONE LONG PAGE. Spec 9.5 asks for a multi step form,
// and the reason it is right here is that the three groups answer three
// different questions: WHERE the application goes, WHAT is being asked for,
// and HOW the applicant will be reached and will later prove the ticket is
// theirs. On a phone a fourteen field scroll with a submit button at the bottom
// is where applications are abandoned; three short screens with the position
// stated in words is not.
//
// A STEP IS NOT LEFT UNTIL IT IS VALID. The applicant is told what is wrong
// under the field it is wrong on, before the round trip, because the engine's
// refusal arrives as ONE sentence with no fields attached to it (core/http.ts
// drops a coded domain error's `detail`). See ./formulir.ts.
//
// THE VERIFIER IS EXACTLY ONE OF TWO, and the form enforces that rather than
// letting the server refuse it: the engine takes NIK or date of birth, never
// both, because two verifiers on one ticket means an attacker only ever has to
// beat the weaker one. The screen offers a choice, not two boxes.
//
// AND THE VERIFIER IS SAID OUT LOUD FOR WHAT IT IS. It is the only thing that
// will open the ticket later, it is stored as a hash and never in cleartext, so
// nobody can look it up and read it back to the applicant. The form says so
// before it is typed, not after.
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  Icon,
  MoneyInput,
  Select,
  TextInput,
  Textarea,
  formatDate,
} from "@krakatausteel/ui";
import {
  ajukan,
  PortalGagal,
  PortalTidakTerhubung,
  type DokumenPengajuan,
  type HasilPengajuan,
  type JenisDokumen,
  type JenisPengajuan,
} from "../api/portal-publik";
import { GagalPublik, HalamanPublik, KartuPublik, useSalin } from "./PortalPublik";
import {
  DOKUMEN_PILIHAN,
  MAKS_DOKUMEN_PUBLIK,
  MAKS_NAMA_FILE_PUBLIK,
  POLA_NIK_PUBLIK,
  formulirUntuk,
  nilaiTerkirim,
  periksaField,
} from "./formulir";

type Pemeriksa = "NIK" | "TANGGAL_LAHIR";

const LANGKAH = [
  { judul: "Tujuan pengajuan", ringkas: "Ke entitas mana pengajuan ini ditujukan." },
  { judul: "Data pengajuan", ringkas: "Isi yang dibutuhkan petugas untuk menilai." },
  { judul: "Kontak dan data pemeriksa", ringkas: "Cara kami menghubungi Anda." },
] as const;

const JENIS_PILIHAN: readonly { value: JenisPengajuan; label: string; jelas: string }[] = [
  {
    value: "PUMK",
    label: "Pendanaan Usaha Mikro dan Kecil",
    jelas: "Pinjaman modal usaha yang diangsur kembali, untuk usaha mikro dan kecil.",
  },
  {
    value: "NON_PUMK",
    label: "Program Bantuan Non PUMK",
    jelas: "Bantuan program sosial atau lingkungan yang tidak diangsur kembali.",
  },
];

const POLA_EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;
const POLA_TELEPON = /^[0-9+][0-9 ()-]{6,24}$/;

export function Pengajuan() {
  const [langkah, setLangkah] = useState(0);
  const [hasil, setHasil] = useState<HasilPengajuan | null>(null);

  if (hasil !== null) {
    return <Tanda hasil={hasil} ulangi={() => setHasil(null)} />;
  }

  return (
    <HalamanPublik
      judul="Ajukan Permohonan"
      ringkas="Isi formulir ini untuk mengajukan pendanaan usaha atau program bantuan. Anda tidak perlu membuat akun."
    >
      <Formulir
        langkah={langkah}
        setLangkah={setLangkah}
        selesai={(nilai) => {
          setHasil(nilai);
          globalThis.scrollTo?.({ top: 0 });
        }}
      />
    </HalamanPublik>
  );
}

function Formulir({
  langkah,
  setLangkah,
  selesai,
}: {
  langkah: number;
  setLangkah: (nilai: number) => void;
  selesai: (hasil: HasilPengajuan) => void;
}) {
  const [kodeEntitas, setKodeEntitas] = useState("");
  const [jenis, setJenis] = useState<JenisPengajuan>("PUMK");
  const [isi, setIsi] = useState<Record<string, string>>({});
  const [email, setEmail] = useState("");
  const [telepon, setTelepon] = useState("");
  const [pemeriksa, setPemeriksa] = useState<Pemeriksa>("NIK");
  const [nik, setNik] = useState("");
  const [tanggalLahir, setTanggalLahir] = useState("");
  const [dokumen, setDokumen] = useState<DokumenPengajuan[]>([]);
  const [sentuh, setSentuh] = useState(false);
  const [mengirim, setMengirim] = useState(false);
  const [gagal, setGagal] = useState<string | null>(null);

  const fields = useMemo(() => formulirUntuk(jenis), [jenis]);

  /**
   * Writes one answer.
   *
   * THE VALUE IS READ BEFORE THE UPDATER RUNS, not inside it. React nulls
   * `event.currentTarget` once the handler returns, and a functional updater
   * runs later, so reading it in there throws on the first keystroke. Caught
   * by ./portal.test.tsx typing into the second step, not by a type.
   */
  function tulis(kunci: string, nilai: string) {
    setIsi((lama) => ({ ...lama, [kunci]: nilai }));
  }

  const galatSatu: Record<string, string> = {};
  if (kodeEntitas.trim() === "") galatSatu.kodeEntitas = "Wajib diisi.";
  else if (kodeEntitas.trim().length > 32) galatSatu.kodeEntitas = "Maksimal 32 karakter.";

  const galatDua: Record<string, string> = {};
  for (const field of fields) {
    const pesan = periksaField(field, isi[field.kunci] ?? "");
    if (pesan) galatDua[field.kunci] = pesan;
  }

  const galatTiga: Record<string, string> = {};
  const emailBersih = email.trim();
  const teleponBersih = telepon.trim();
  if (emailBersih !== "" && !POLA_EMAIL.test(emailBersih)) {
    galatTiga.email = "Format email belum benar.";
  }
  if (teleponBersih !== "" && !POLA_TELEPON.test(teleponBersih)) {
    galatTiga.telepon = "Isi nomor telepon, boleh dengan kode negara.";
  }
  if (emailBersih === "" && teleponBersih === "") {
    galatTiga.email = "Isi email atau nomor telepon agar kami bisa menghubungi Anda.";
  }
  if (pemeriksa === "NIK") {
    if (nik.trim() === "") galatTiga.nik = "Wajib diisi.";
    else if (!POLA_NIK_PUBLIK.test(nik.trim())) galatTiga.nik = "NIK terdiri dari 16 angka.";
  } else {
    const lahir = tanggalLahir.trim();
    if (lahir === "") galatTiga.tanggalLahir = "Wajib diisi.";
    else if (lahir > new Date().toISOString().slice(0, 10)) {
      galatTiga.tanggalLahir = "Tanggal lahir tidak boleh di masa depan.";
    }
  }

  const galat = [galatSatu, galatDua, galatTiga][langkah] ?? {};
  const bisaLanjut = Object.keys(galat).length === 0;

  function lanjut() {
    setSentuh(true);
    if (!bisaLanjut) return;
    setSentuh(false);
    setLangkah(langkah + 1);
    globalThis.scrollTo?.({ top: 0 });
  }

  function mundur() {
    setSentuh(false);
    setGagal(null);
    setLangkah(langkah - 1);
    globalThis.scrollTo?.({ top: 0 });
  }

  async function kirim() {
    setSentuh(true);
    if (!bisaLanjut || mengirim) return;
    setMengirim(true);
    setGagal(null);
    try {
      const formulir: Record<string, unknown> = {};
      for (const field of fields) {
        const nilai = nilaiTerkirim(field, isi[field.kunci] ?? "");
        if (nilai !== undefined) formulir[field.kunci] = nilai;
      }
      const hasil = await ajukan({
        kodeEntitas: kodeEntitas.trim(),
        jenis,
        emailKontak: emailBersih === "" ? null : emailBersih,
        teleponKontak: teleponBersih === "" ? null : teleponBersih,
        // EXACTLY ONE of the two, never both. See the file header.
        nik: pemeriksa === "NIK" ? nik.trim() : null,
        tanggalLahir: pemeriksa === "TANGGAL_LAHIR" ? tanggalLahir.trim() : null,
        formulir,
        dokumen,
      });
      selesai(hasil);
    } catch (penyebab) {
      if (penyebab instanceof PortalGagal || penyebab instanceof PortalTidakTerhubung) {
        setGagal(penyebab.message);
      } else {
        setGagal("Pengajuan gagal dikirim. Coba lagi beberapa saat lagi.");
      }
      setMengirim(false);
    }
  }

  const posisi = LANGKAH[langkah] ?? LANGKAH[0];

  return (
    <>
      <p className="publik-langkah" aria-live="polite">
        Langkah {langkah + 1} dari {LANGKAH.length}
      </p>

      <KartuPublik
        judul={posisi.judul}
        ringkas={posisi.ringkas}
        footer={
          <div className="publik-aksi">
            {langkah > 0 ? (
              <Button variant="secondary" onClick={mundur} disabled={mengirim}>
                Kembali
              </Button>
            ) : null}
            {langkah < LANGKAH.length - 1 ? (
              <Button variant="primary" onClick={lanjut}>
                Lanjut
              </Button>
            ) : (
              <Button variant="primary" onClick={kirim} loading={mengirim}>
                Kirim pengajuan
              </Button>
            )}
          </div>
        }
      >
        {langkah === 0 ? (
          <div className="publik-form">
            <Field
              label="Kode entitas tujuan"
              required
              hint="Kode BUMN yang membuka program ini, tertulis pada pengumuman atau brosur yang Anda terima."
              error={sentuh ? galatSatu.kodeEntitas : undefined}
            >
              <TextInput
                value={kodeEntitas}
                maxLength={32}
                autoComplete="off"
                invalid={sentuh && galatSatu.kodeEntitas !== undefined}
                onChange={(event) => setKodeEntitas(event.currentTarget.value)}
              />
            </Field>

            <fieldset className="publik-pilihan">
              <legend className="field-label">Jenis pengajuan</legend>
              {JENIS_PILIHAN.map((pilihan) => (
                <label
                  key={pilihan.value}
                  className={jenis === pilihan.value ? "publik-opsi is-active" : "publik-opsi"}
                >
                  <input
                    type="radio"
                    name="jenis"
                    value={pilihan.value}
                    checked={jenis === pilihan.value}
                    onChange={() => {
                      setJenis(pilihan.value);
                      setIsi({});
                    }}
                  />
                  <span className="publik-opsi-teks">
                    <span className="publik-opsi-judul">{pilihan.label}</span>
                    <span className="publik-opsi-jelas">{pilihan.jelas}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        ) : null}

        {langkah === 1 ? (
          <div className="publik-form">
            {fields.map((field) => (
              <Field
                key={field.kunci}
                label={field.label}
                required={field.aturan.wajib}
                {...(field.hint ? { hint: field.hint } : {})}
                {...(sentuh && galatDua[field.kunci] ? { error: galatDua[field.kunci] } : {})}
              >
                {field.bentuk === "uang" ? (
                  <MoneyInput
                    value={isi[field.kunci] ?? ""}
                    invalid={sentuh && galatDua[field.kunci] !== undefined}
                    onValueChange={(nilai) =>
                      setIsi((lama) => ({ ...lama, [field.kunci]: nilai ?? "" }))
                    }
                  />
                ) : field.bentuk === "panjang" ? (
                  <Textarea
                    value={isi[field.kunci] ?? ""}
                    rows={4}
                    maxLength={field.aturan.jenis === "teks" ? field.aturan.maks : undefined}
                    invalid={sentuh && galatDua[field.kunci] !== undefined}
                    onChange={(event) => tulis(field.kunci, event.currentTarget.value)}
                  />
                ) : (
                  <TextInput
                    value={isi[field.kunci] ?? ""}
                    inputMode={field.bentuk === "bulat" ? "numeric" : "text"}
                    maxLength={field.aturan.jenis === "teks" ? field.aturan.maks : undefined}
                    autoComplete="off"
                    invalid={sentuh && galatDua[field.kunci] !== undefined}
                    onChange={(event) => tulis(field.kunci, event.currentTarget.value)}
                  />
                )}
              </Field>
            ))}
          </div>
        ) : null}

        {langkah === 2 ? (
          <div className="publik-form">
            <Field
              label="Email"
              hint="Isi email atau nomor telepon. Salah satu saja sudah cukup."
              {...(sentuh && galatTiga.email ? { error: galatTiga.email } : {})}
            >
              <TextInput
                type="email"
                value={email}
                maxLength={200}
                autoComplete="email"
                invalid={sentuh && galatTiga.email !== undefined}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </Field>

            <Field
              label="Nomor telepon"
              {...(sentuh && galatTiga.telepon ? { error: galatTiga.telepon } : {})}
            >
              <TextInput
                type="tel"
                value={telepon}
                maxLength={30}
                autoComplete="tel"
                invalid={sentuh && galatTiga.telepon !== undefined}
                onChange={(event) => setTelepon(event.currentTarget.value)}
              />
            </Field>

            <div className="publik-catatan">
              <Icon name="lock" size={16} />
              <span>
                Data pemeriksa di bawah ini dipakai hanya untuk membuka status pengajuan Anda
                nanti. Data itu disimpan dalam bentuk teracak, jadi tidak bisa dibaca kembali oleh
                siapa pun, termasuk petugas. Simpan jawaban Anda sendiri.
              </span>
            </div>

            <Field label="Data pemeriksa" required>
              <Select
                aria-label="Pilih data pemeriksa"
                value={pemeriksa}
                onChange={(event) => setPemeriksa(event.currentTarget.value as Pemeriksa)}
                options={[
                  { value: "NIK", label: "NIK (16 angka)" },
                  { value: "TANGGAL_LAHIR", label: "Tanggal lahir" },
                ]}
              />
            </Field>

            {pemeriksa === "NIK" ? (
              <Field
                label="NIK"
                required
                hint="16 angka pada KTP Anda."
                {...(sentuh && galatTiga.nik ? { error: galatTiga.nik } : {})}
              >
                <TextInput
                  value={nik}
                  inputMode="numeric"
                  maxLength={16}
                  autoComplete="off"
                  invalid={sentuh && galatTiga.nik !== undefined}
                  onChange={(event) => setNik(event.currentTarget.value.replace(/\D/g, ""))}
                />
              </Field>
            ) : (
              <Field
                label="Tanggal lahir"
                required
                {...(sentuh && galatTiga.tanggalLahir
                  ? { error: galatTiga.tanggalLahir }
                  : {})}
              >
                <input
                  type="date"
                  className={
                    sentuh && galatTiga.tanggalLahir !== undefined
                      ? "control is-invalid"
                      : "control"
                  }
                  aria-label="Tanggal lahir"
                  value={tanggalLahir}
                  onChange={(event) => setTanggalLahir(event.currentTarget.value)}
                />
              </Field>
            )}

            <Dokumen dokumen={dokumen} setDokumen={setDokumen} />

            {gagal ? <GagalPublik pesan={gagal} /> : null}
          </div>
        ) : null}
      </KartuPublik>
    </>
  );
}

/**
 * Declared attachments.
 *
 * THE PORTAL RECORDS THAT A DOCUMENT WAS OFFERED; IT DOES NOT TAKE BYTES.
 * `POST /portal/pengajuan` accepts a kind and a file name and no upload, and
 * the screen says so plainly rather than showing a file picker that would
 * quietly drop what a person selected. The officer collects the documents at
 * verification, which is where identity checking belongs anyway.
 */
function Dokumen({
  dokumen,
  setDokumen,
}: {
  dokumen: DokumenPengajuan[];
  setDokumen: (nilai: DokumenPengajuan[]) => void;
}) {
  const [jenis, setJenis] = useState<JenisDokumen>("KTP");
  const [nama, setNama] = useState("");
  const penuh = dokumen.length >= MAKS_DOKUMEN_PUBLIK;
  const bersih = nama.trim();
  const bisaTambah = !penuh && bersih !== "" && bersih.length <= MAKS_NAMA_FILE_PUBLIK;

  return (
    <div className="publik-dokumen">
      <p className="field-label">Dokumen yang Anda siapkan</p>
      <p className="field-hint">
        Sebutkan dokumen yang sudah Anda siapkan. Berkasnya belum diunggah di sini, petugas akan
        meminta aslinya saat verifikasi. Maksimal {MAKS_DOKUMEN_PUBLIK} dokumen.
      </p>

      {dokumen.length === 0 ? null : (
        <ul className="publik-dokumen-list">
          {dokumen.map((entri, index) => (
            <li className="publik-dokumen-item" key={`${entri.jenis}-${entri.namaFile}-${index}`}>
              <span className="publik-dokumen-jenis">
                {DOKUMEN_PILIHAN.find((p) => p.jenis === entri.jenis)?.label ?? entri.jenis}
              </span>
              <span className="publik-dokumen-nama">{entri.namaFile}</span>
              <button
                type="button"
                className="publik-dokumen-hapus"
                onClick={() => setDokumen(dokumen.filter((_, i) => i !== index))}
              >
                <Icon name="close" size={16} />
                <span>Hapus {entri.namaFile}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="publik-dokumen-tambah">
        <Select
          aria-label="Jenis dokumen"
          value={jenis}
          disabled={penuh}
          onChange={(event) => setJenis(event.currentTarget.value as JenisDokumen)}
          options={DOKUMEN_PILIHAN.map((p) => ({ value: p.jenis, label: p.label }))}
        />
        <TextInput
          aria-label="Nama berkas"
          placeholder="Nama berkas, misalnya ktp-budi.jpg"
          value={nama}
          maxLength={MAKS_NAMA_FILE_PUBLIK}
          disabled={penuh}
          onChange={(event) => setNama(event.currentTarget.value)}
        />
        <Button
          variant="secondary"
          disabled={!bisaTambah}
          onClick={() => {
            setDokumen([...dokumen, { jenis, namaFile: bersih }]);
            setNama("");
          }}
        >
          Tambah
        </Button>
      </div>
      {penuh ? (
        <p className="field-hint">
          Sudah mencapai batas {MAKS_DOKUMEN_PUBLIK} dokumen. Hapus salah satu untuk menambah yang
          lain.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The receipt. The ticket number is the ONLY thing that reopens this
 * application, so it is the largest thing on the page, it can be copied in one
 * tap, and the sentence next to it says that nobody can look it up for the
 * applicant later.
 */
function Tanda({ hasil, ulangi }: { hasil: HasilPengajuan; ulangi: () => void }) {
  const [tersalin, salin] = useSalin();
  return (
    <HalamanPublik
      judul="Pengajuan Terkirim"
      ringkas="Simpan nomor tiket di bawah ini. Nomor itu yang dipakai untuk mengecek status pengajuan Anda."
    >
      <KartuPublik
        judul="Nomor tiket Anda"
        ringkas={hasil.pesan}
        footer={
          <div className="publik-aksi">
            <Button variant="secondary" onClick={ulangi}>
              Ajukan lagi
            </Button>
          </div>
        }
      >
        <p className="publik-tiket">{hasil.noTiket}</p>
        <div className="publik-aksi">
          <Button variant="secondary" onClick={() => salin(hasil.noTiket)}>
            <Icon name="file" size={16} />
            {tersalin ? "Nomor tiket tersalin" : "Salin nomor tiket"}
          </Button>
        </div>
        <dl className="publik-fakta">
          <div className="publik-fakta-item">
            <dt>Jenis pengajuan</dt>
            <dd>{hasil.jenis === "PUMK" ? "Pendanaan Usaha Mikro dan Kecil" : "Program Bantuan Non PUMK"}</dd>
          </div>
          <div className="publik-fakta-item">
            <dt>Tanggal pengajuan</dt>
            <dd>{formatDate(hasil.tanggalSubmit)}</dd>
          </div>
        </dl>
        <div className="publik-catatan">
          <Icon name="alert" size={16} />
          <span>
            Catat nomor tiket ini sekarang. Nomor tiket tidak dikirim ulang dan tidak bisa dicari
            berdasarkan nama, jadi tanpa nomor itu status pengajuan Anda tidak bisa dibuka.
          </span>
        </div>
      </KartuPublik>
    </HalamanPublik>
  );
}
