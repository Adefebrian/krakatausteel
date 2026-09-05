// Spec 9.5, the public status check. A ticket plus ONE verifier.
//
// THE ONE RULE THIS SCREEN EXISTS TO NOT BREAK.
//
// The server answers IDENTICALLY for "no such ticket" and "wrong verifier", on
// purpose, so the endpoint cannot be used to discover who applied. That
// property lives in the server, and a screen can undo it without touching a
// line of server code: by putting the refusal under the ticket field, by
// saying "ticket not found", by checking the ticket first and the verifier
// second, or by taking a different amount of time over the two.
//
// So: ONE message, at the top of the form, never attached to a field, and it
// is the server's own sentence. The only checks done here are SHAPE checks the
// server does not need to be asked about at all (an empty box, a NIK that is
// not sixteen digits), and they run BEFORE anything is sent, so they can never
// be mistaken for an answer about a real ticket.
//
// THE RESULT IS A STATUS AND A SENTENCE, AND NOTHING ELSE. The engine returns
// no submission id, no officer notes, no branch, no contact details and no
// timestamp finer than a date. There is nothing here that would print them if
// it did.
import { useState } from "react";
import { Button, Field, Icon, StatusBadge, TextInput, formatDate } from "@krakatausteel/ui";
import {
  cekStatus,
  PortalGagal,
  PortalTidakTerhubung,
  type StatusPengajuan,
  type StatusSubmission,
} from "../api/portal-publik";
import { GagalPublik, HalamanPublik, KartuPublik } from "./PortalPublik";
import { POLA_NIK_PUBLIK, POLA_TIKET_PUBLIK } from "./formulir";

type Pemeriksa = "NIK" | "TANGGAL_LAHIR";

const NADA: Record<StatusSubmission, "info" | "neutral" | "success" | "danger"> = {
  BARU: "info",
  DIPROSES: "info",
  DIKONVERSI: "success",
  DITOLAK: "danger",
};

const LABEL_STATUS: Record<StatusSubmission, string> = {
  BARU: "Diterima",
  DIPROSES: "Sedang diverifikasi",
  DIKONVERSI: "Sudah diproses lanjut",
  DITOLAK: "Belum dapat dilanjutkan",
};

export function CekStatus() {
  const [noTiket, setNoTiket] = useState("");
  const [pemeriksa, setPemeriksa] = useState<Pemeriksa>("NIK");
  const [nik, setNik] = useState("");
  const [tanggalLahir, setTanggalLahir] = useState("");
  const [sentuh, setSentuh] = useState(false);
  const [memuat, setMemuat] = useState(false);
  const [gagal, setGagal] = useState<string | null>(null);
  const [hasil, setHasil] = useState<StatusPengajuan | null>(null);

  // SHAPE ONLY. Nothing here can distinguish a real ticket from an invented
  // one, which is exactly the point: these run before the request and say
  // nothing about what exists.
  const galat: Record<string, string> = {};
  const tiket = noTiket.trim().toUpperCase();
  if (tiket === "") galat.noTiket = "Wajib diisi.";
  else if (!POLA_TIKET_PUBLIK.test(tiket)) {
    galat.noTiket = "Format nomor tiket belum benar. Contoh: TKT-202609-A1B2C3D4E5.";
  }
  if (pemeriksa === "NIK") {
    if (nik.trim() === "") galat.nik = "Wajib diisi.";
    else if (!POLA_NIK_PUBLIK.test(nik.trim())) galat.nik = "NIK terdiri dari 16 angka.";
  } else if (tanggalLahir.trim() === "") {
    galat.tanggalLahir = "Wajib diisi.";
  }
  const siap = Object.keys(galat).length === 0;

  async function periksa() {
    setSentuh(true);
    if (!siap || memuat) return;
    setMemuat(true);
    setGagal(null);
    setHasil(null);
    try {
      const jawaban = await cekStatus({
        noTiket: tiket,
        nik: pemeriksa === "NIK" ? nik.trim() : null,
        tanggalLahir: pemeriksa === "TANGGAL_LAHIR" ? tanggalLahir.trim() : null,
      });
      setHasil(jawaban);
    } catch (penyebab) {
      // ONE message, and it is the server's. See the file header.
      if (penyebab instanceof PortalGagal || penyebab instanceof PortalTidakTerhubung) {
        setGagal(penyebab.message);
      } else {
        setGagal("Status pengajuan tidak dapat dibuka saat ini. Coba lagi beberapa saat lagi.");
      }
    } finally {
      setMemuat(false);
    }
  }

  return (
    <HalamanPublik
      judul="Cek Status Pengajuan"
      ringkas="Masukkan nomor tiket yang Anda terima saat mengajukan, beserta data pemeriksa yang Anda isi waktu itu."
    >
      <KartuPublik
        judul="Buka status"
        ringkas="Nomor tiket dan satu data pemeriksa. Keduanya harus cocok."
        footer={
          <div className="publik-aksi">
            <Button variant="primary" onClick={periksa} loading={memuat}>
              Lihat status
            </Button>
          </div>
        }
      >
        <div className="publik-form">
          {/* The refusal sits ABOVE the form, not under a field, so it cannot
              be read as an answer about the ticket rather than about the pair. */}
          {gagal ? <GagalPublik pesan={gagal} /> : null}

          <Field
            label="Nomor tiket"
            required
            hint="Contoh: TKT-202609-A1B2C3D4E5."
            {...(sentuh && galat.noTiket ? { error: galat.noTiket } : {})}
          >
            <TextInput
              value={noTiket}
              maxLength={40}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              invalid={sentuh && galat.noTiket !== undefined}
              onChange={(event) => setNoTiket(event.currentTarget.value)}
            />
          </Field>

          <fieldset className="publik-pilihan">
            <legend className="field-label">Data pemeriksa yang Anda isi saat mengajukan</legend>
            <label className={pemeriksa === "NIK" ? "publik-opsi is-active" : "publik-opsi"}>
              <input
                type="radio"
                name="pemeriksa"
                value="NIK"
                checked={pemeriksa === "NIK"}
                onChange={() => setPemeriksa("NIK")}
              />
              <span className="publik-opsi-teks">
                <span className="publik-opsi-judul">NIK</span>
                <span className="publik-opsi-jelas">16 angka pada KTP.</span>
              </span>
            </label>
            <label
              className={pemeriksa === "TANGGAL_LAHIR" ? "publik-opsi is-active" : "publik-opsi"}
            >
              <input
                type="radio"
                name="pemeriksa"
                value="TANGGAL_LAHIR"
                checked={pemeriksa === "TANGGAL_LAHIR"}
                onChange={() => setPemeriksa("TANGGAL_LAHIR")}
              />
              <span className="publik-opsi-teks">
                <span className="publik-opsi-judul">Tanggal lahir</span>
                <span className="publik-opsi-jelas">Tanggal lahir pemohon.</span>
              </span>
            </label>
          </fieldset>

          {pemeriksa === "NIK" ? (
            <Field label="NIK" required {...(sentuh && galat.nik ? { error: galat.nik } : {})}>
              <TextInput
                value={nik}
                inputMode="numeric"
                maxLength={16}
                autoComplete="off"
                invalid={sentuh && galat.nik !== undefined}
                onChange={(event) => setNik(event.currentTarget.value.replace(/\D/g, ""))}
              />
            </Field>
          ) : (
            <Field
              label="Tanggal lahir"
              required
              {...(sentuh && galat.tanggalLahir ? { error: galat.tanggalLahir } : {})}
            >
              <input
                type="date"
                className={
                  sentuh && galat.tanggalLahir !== undefined ? "control is-invalid" : "control"
                }
                aria-label="Tanggal lahir"
                value={tanggalLahir}
                onChange={(event) => setTanggalLahir(event.currentTarget.value)}
              />
            </Field>
          )}
        </div>
      </KartuPublik>

      {hasil === null ? null : (
        <KartuPublik judul="Status pengajuan" ringkas={`Nomor tiket ${hasil.noTiket}.`}>
          <div className="publik-status">
            <StatusBadge status={LABEL_STATUS[hasil.status]} tone={NADA[hasil.status]} />
            <p className="publik-status-pesan">{hasil.pesan}</p>
          </div>
          <dl className="publik-fakta">
            <div className="publik-fakta-item">
              <dt>Jenis pengajuan</dt>
              <dd>
                {hasil.jenis === "PUMK"
                  ? "Pendanaan Usaha Mikro dan Kecil"
                  : "Program Bantuan Non PUMK"}
              </dd>
            </div>
            <div className="publik-fakta-item">
              <dt>Tanggal pengajuan</dt>
              <dd>{formatDate(hasil.tanggalSubmit)}</dd>
            </div>
          </dl>
          <div className="publik-catatan">
            <Icon name="info" size={16} />
            <span>
              Halaman ini hanya menampilkan status. Rincian penilaian dan catatan petugas tidak
              dibuka di portal publik. Untuk pertanyaan lebih lanjut, hubungi kantor cabang tempat
              Anda mengajukan.
            </span>
          </div>
        </KartuPublik>
      )}
    </HalamanPublik>
  );
}
