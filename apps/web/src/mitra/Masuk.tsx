// The mitra login. A SECOND login screen, and it is not the staff one wearing
// different words.
//
// ONE REFUSAL FOR EVERY FAILURE MODE, because that is what the server sends.
// An unknown email, a wrong password, a deactivated account and an account
// whose mitra was removed all answer `KREDENSIAL_MITRA_SALAH` with one
// sentence; the distinction goes to `audit_log` where an officer can see it.
// This screen prints that sentence and adds nothing to it, so it cannot become
// the account-existence oracle the server declined to be.
//
// THERE IS NO REGISTRATION LINK AND NO PASSWORD RESET LINK, because neither
// endpoint exists and neither should. A form that created a login by naming a
// mitra would be an account takeover primitive for anyone who knows a
// borrower's email address (ADR 0019). The way back in is the branch office,
// and the screen says so instead of offering a button that would 404.
import { useState } from "react";
import { Button, Field, Icon, PasswordInput, TextInput } from "@krakatausteel/ui";
import { MitraTidakTerhubung } from "../api/mitra";
import { GagalMitra } from "./MitraApp";
import { useSesiMitra } from "./sesi";

export function MasukMitra() {
  const { masuk } = useSesiMitra();
  const [email, setEmail] = useState("");
  const [sandi, setSandi] = useState("");
  const [sentuh, setSentuh] = useState(false);
  const [mengirim, setMengirim] = useState(false);
  const [gagal, setGagal] = useState<string | null>(null);

  const galat: Record<string, string> = {};
  if (email.trim() === "") galat.email = "Wajib diisi.";
  if (sandi === "") galat.sandi = "Wajib diisi.";
  const siap = Object.keys(galat).length === 0;

  async function kirim(event: { preventDefault: () => void }) {
    event.preventDefault();
    setSentuh(true);
    if (!siap || mengirim) return;
    setMengirim(true);
    setGagal(null);
    try {
      await masuk(email.trim(), sandi);
    } catch (penyebab) {
      setGagal(
        penyebab instanceof MitraTidakTerhubung
          ? penyebab.message
          : penyebab instanceof Error
            ? penyebab.message
            : "Tidak dapat masuk. Coba lagi beberapa saat lagi.",
      );
      // The password box is cleared on a failure and the email is kept: the
      // email is almost never the thing that was wrong, and retyping it is how
      // a person on a phone gives up.
      setSandi("");
      setMengirim(false);
    }
  }

  return (
    <div className="mitra-masuk">
      <form className="mitra-masuk-kotak" onSubmit={kirim}>
        <div className="mitra-masuk-head">
          <span className="mitra-mark" aria-hidden="true">
            <Icon name="handshake" size={20} />
          </span>
          <h1 className="mitra-masuk-judul">Portal Mitra Binaan</h1>
          <p className="mitra-masuk-sub">
            Masuk untuk melihat akad, jadwal angsuran, dan setoran Anda.
          </p>
        </div>

        {gagal ? <GagalMitra pesan={gagal} /> : null}

        <Field label="Email" required {...(sentuh && galat.email ? { error: galat.email } : {})}>
          <TextInput
            type="email"
            value={email}
            autoComplete="username"
            maxLength={200}
            invalid={sentuh && galat.email !== undefined}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>

        <Field
          label="Kata sandi"
          required
          {...(sentuh && galat.sandi ? { error: galat.sandi } : {})}
        >
          <PasswordInput
            value={sandi}
            autoComplete="current-password"
            maxLength={200}
            invalid={sentuh && galat.sandi !== undefined}
            onChange={(event) => setSandi(event.currentTarget.value)}
          />
        </Field>

        <Button type="submit" variant="primary" loading={mengirim} block>
          Masuk
        </Button>

        <p className="mitra-masuk-catatan">
          Akun portal diterbitkan oleh petugas untuk Mitra Binaan yang sudah punya akad. Bila Anda
          belum punya akun, atau lupa kata sandi, hubungi kantor cabang tempat akad Anda dibuat.
          Kata sandi tidak dapat dikirim ulang lewat halaman ini.
        </p>
      </form>
    </div>
  );
}
