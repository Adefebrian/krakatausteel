// The account tab: what the account is, how to change its password, and how to
// leave.
//
// SIGNING OUT IS A SERVER SIDE ACT and a failure is reported. If the request
// never lands, the session in Redis is still live, so clearing the screen and
// showing the login form would be telling a person their session is closed when
// it is not. The staff shell already learned this; the same rule applies here
// because it is the same lie either way.
//
// THE PASSWORD FORM IS THE SAME COMPONENT AS THE FORCED ONE, on purpose. There
// is one set of password rules and one place they are stated, so a voluntary
// change and a forced one cannot end up with two different minimum lengths.
import { useState } from "react";
import { Button, Icon } from "@krakatausteel/ui";
import { gantiSandi as gantiSandiRequest, MitraTidakTerhubung } from "../api/mitra";
import { Field, PasswordInput } from "@krakatausteel/ui";
import { GagalMitra, HalamanMitra, KartuMitra } from "./MitraApp";
import { useSesiMitra } from "./sesi";

const MIN_PANJANG = 12;

export function AkunMitra() {
  const { profil, keluar } = useSesiMitra();
  const [keluarGagal, setKeluarGagal] = useState<string | null>(null);
  const [sedangKeluar, setSedangKeluar] = useState(false);

  async function akhiri() {
    setSedangKeluar(true);
    setKeluarGagal(null);
    try {
      await keluar();
    } catch (penyebab) {
      setKeluarGagal(
        penyebab instanceof MitraTidakTerhubung
          ? "Server tidak dapat dihubungi, jadi sesi Anda belum ditutup. Coba lagi."
          : penyebab instanceof Error
            ? penyebab.message
            : "Sesi Anda belum ditutup. Coba lagi.",
      );
      setSedangKeluar(false);
    }
  }

  return (
    <HalamanMitra
      judul="Akun Saya"
      ringkas="Akun portal ini hanya membuka data Anda sendiri, dan tidak bisa mengubah data akad."
    >
      <KartuMitra judul="Data akun">
        <dl className="mitra-ringkas">
          <div className="mitra-ringkas-item">
            <dt>Nama</dt>
            <dd>{profil?.namaLengkap ?? ""}</dd>
          </div>
          <div className="mitra-ringkas-item">
            <dt>Kode mitra</dt>
            <dd>{profil?.kodeMitra ?? ""}</dd>
          </div>
          <div className="mitra-ringkas-item">
            <dt>Email masuk</dt>
            <dd>{profil?.email ?? ""}</dd>
          </div>
          <div className="mitra-ringkas-item">
            <dt>Cabang pembina</dt>
            <dd>{profil ? `${profil.cabang.kode} ${profil.cabang.nama}` : ""}</dd>
          </div>
        </dl>
        <p className="mitra-catatan">
          <Icon name="info" size={16} />
          <span>
            Perubahan data diri, alamat, atau data usaha dilakukan oleh petugas cabang, bukan dari
            portal ini. Hubungi kantor cabang bila ada yang perlu diperbaiki.
          </span>
        </p>
      </KartuMitra>

      <FormSandi email={profil?.email ?? ""} />

      <KartuMitra
        judul="Keluar"
        ringkas="Menutup sesi Anda di server, bukan hanya di peramban ini."
        footer={
          <Button variant="secondary" loading={sedangKeluar} onClick={() => void akhiri()}>
            Keluar dari portal
          </Button>
        }
      >
        {keluarGagal ? <GagalMitra pesan={keluarGagal} /> : null}
        <p className="mitra-catatan">
          <Icon name="lock" size={16} />
          <span>
            Selalu keluar bila Anda memakai perangkat bersama. Sesi berakhir sendiri setelah 30
            menit tanpa aktivitas, dan paling lama 8 jam sejak Anda masuk.
          </span>
        </p>
      </KartuMitra>
    </HalamanMitra>
  );
}

function FormSandi({ email }: { email: string }) {
  const [sandiLama, setSandiLama] = useState("");
  const [sandiBaru, setSandiBaru] = useState("");
  const [ulangi, setUlangi] = useState("");
  const [sentuh, setSentuh] = useState(false);
  const [mengirim, setMengirim] = useState(false);
  const [gagal, setGagal] = useState<string | null>(null);
  const [berhasil, setBerhasil] = useState(false);

  const galat: Record<string, string> = {};
  if (sandiLama === "") galat.sandiLama = "Wajib diisi.";
  if (sandiBaru.length < MIN_PANJANG) galat.sandiBaru = `Minimal ${MIN_PANJANG} karakter.`;
  else if (email !== "" && sandiBaru.toLowerCase() === email.toLowerCase()) {
    galat.sandiBaru = "Kata sandi tidak boleh sama dengan email Anda.";
  } else if (sandiBaru === sandiLama) {
    galat.sandiBaru = "Kata sandi baru harus berbeda dari yang sekarang.";
  }
  if (ulangi !== sandiBaru) galat.ulangi = "Pengulangan belum sama dengan kata sandi baru.";
  const siap = Object.keys(galat).length === 0;

  async function kirim(event: { preventDefault: () => void }) {
    event.preventDefault();
    setSentuh(true);
    if (!siap || mengirim) return;
    setMengirim(true);
    setGagal(null);
    setBerhasil(false);
    try {
      await gantiSandiRequest(sandiLama, sandiBaru);
      setBerhasil(true);
      setSandiLama("");
      setSandiBaru("");
      setUlangi("");
      setSentuh(false);
    } catch (penyebab) {
      setGagal(
        penyebab instanceof Error ? penyebab.message : "Kata sandi belum berhasil diganti.",
      );
    } finally {
      setMengirim(false);
    }
  }

  return (
    <KartuMitra
      judul="Ganti kata sandi"
      ringkas={`Minimal ${MIN_PANJANG} karakter, dan tidak boleh sama dengan email Anda.`}
    >
      <form className="mitra-form" onSubmit={kirim}>
        {gagal ? <GagalMitra pesan={gagal} /> : null}
        {berhasil ? (
          <p className="mitra-berhasil" role="status">
            <Icon name="checkCircle" size={16} />
            <span>Kata sandi Anda sudah diganti.</span>
          </p>
        ) : null}

        <Field
          label="Kata sandi sekarang"
          required
          {...(sentuh && galat.sandiLama ? { error: galat.sandiLama } : {})}
        >
          <PasswordInput
            value={sandiLama}
            autoComplete="current-password"
            maxLength={200}
            invalid={sentuh && galat.sandiLama !== undefined}
            onChange={(event) => setSandiLama(event.currentTarget.value)}
          />
        </Field>

        <Field
          label="Kata sandi baru"
          required
          {...(sentuh && galat.sandiBaru ? { error: galat.sandiBaru } : {})}
        >
          <PasswordInput
            value={sandiBaru}
            autoComplete="new-password"
            maxLength={200}
            invalid={sentuh && galat.sandiBaru !== undefined}
            onChange={(event) => setSandiBaru(event.currentTarget.value)}
          />
        </Field>

        <Field
          label="Ulangi kata sandi baru"
          required
          {...(sentuh && galat.ulangi ? { error: galat.ulangi } : {})}
        >
          <PasswordInput
            value={ulangi}
            autoComplete="new-password"
            maxLength={200}
            invalid={sentuh && galat.ulangi !== undefined}
            onChange={(event) => setUlangi(event.currentTarget.value)}
          />
        </Field>

        <Button type="submit" variant="primary" loading={mengirim}>
          Simpan kata sandi baru
        </Button>
      </form>
    </KartuMitra>
  );
}
