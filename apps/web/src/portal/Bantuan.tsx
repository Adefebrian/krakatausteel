// The third public destination: what to do when the form and the status check
// do not answer the question.
//
// IT LINKS NOWHERE INTO THE STAFF APPLICATION. Not a login link, not an admin
// address, not a "for officers" note. A member of the public has no account
// here and no reason to be told the staff surface exists; an officer types the
// address they were given.
//
// AND IT PROMISES NOTHING THE SERVER CANNOT DO. There is no "resend my ticket
// number", because there is no endpoint that could: the verifier is stored as
// a hash and the ticket cannot be looked up by name, which is the whole reason
// the status check is safe. Saying so here is more useful than a support form
// that would have to answer "we cannot".
import { Icon } from "@krakatausteel/ui";
import { HalamanPublik, KartuPublik } from "./PortalPublik";

interface Tanya {
  tanya: string;
  jawab: string;
}

const PERTANYAAN: readonly Tanya[] = [
  {
    tanya: "Saya kehilangan nomor tiket. Bisakah dicarikan?",
    jawab:
      "Tidak bisa dicari dari halaman ini. Nomor tiket tidak tersimpan dengan nama Anda dan data pemeriksa disimpan dalam bentuk teracak, justru supaya pengajuan orang lain tidak bisa dibuka oleh siapa pun yang menebak nama. Hubungi kantor cabang tempat Anda mengajukan dengan membawa identitas asli.",
  },
  {
    tanya: "Status masih Diterima setelah beberapa hari. Apa artinya?",
    jawab:
      "Pengajuan Anda sudah masuk antrean verifikasi dan belum mulai diperiksa. Antrean diproses petugas cabang secara berurutan, jadi ini keadaan normal, bukan tanda ada yang salah.",
  },
  {
    tanya: "Apakah saya perlu membuat akun?",
    jawab:
      "Tidak. Pengajuan lewat portal ini tidak memerlukan akun. Akun portal hanya diberikan kepada Mitra Binaan yang sudah punya akad, dan diterbitkan oleh petugas, bukan lewat pendaftaran sendiri.",
  },
  {
    tanya: "Apakah pengajuan saya pasti disetujui?",
    jawab:
      "Tidak. Pengajuan lewat portal adalah permohonan awal. Petugas akan melakukan verifikasi dan survei, dan jumlah akhir ditentukan pada tahap itu, bukan oleh angka yang Anda isi di formulir.",
  },
  {
    tanya: "Apakah dokumen saya sudah terunggah?",
    jawab:
      "Belum. Pada formulir ini Anda hanya menyebutkan dokumen yang sudah disiapkan. Berkas aslinya diminta petugas saat verifikasi, supaya identitas diperiksa langsung oleh orang yang berwenang.",
  },
  {
    tanya: "Saya salah mengisi data. Bisakah diubah?",
    jawab:
      "Pengajuan yang sudah terkirim tidak bisa diubah dari halaman ini. Sampaikan koreksinya kepada petugas saat dihubungi, atau hubungi kantor cabang dengan menyebutkan nomor tiket Anda.",
  },
];

export function Bantuan() {
  return (
    <HalamanPublik
      judul="Bantuan"
      ringkas="Jawaban atas pertanyaan yang paling sering muncul tentang pengajuan lewat portal ini."
    >
      <KartuPublik
        judul="Pertanyaan yang sering diajukan"
        ringkas="Bila jawabannya tidak ada di sini, hubungi kantor cabang tempat Anda mengajukan."
      >
        <dl className="publik-tanya">
          {PERTANYAAN.map((entri) => (
            <div className="publik-tanya-item" key={entri.tanya}>
              <dt className="publik-tanya-judul">{entri.tanya}</dt>
              <dd className="publik-tanya-jawab">{entri.jawab}</dd>
            </div>
          ))}
        </dl>
      </KartuPublik>

      <KartuPublik
        judul="Menjaga pengajuan Anda"
        ringkas="Tiga hal yang membuat pengajuan Anda tidak bisa dibuka orang lain."
      >
        <ul className="publik-daftar">
          <li className="publik-daftar-item">
            <Icon name="lock" size={16} />
            <span>
              Simpan nomor tiket dan data pemeriksa Anda sendiri. Petugas tidak akan pernah
              menanyakan keduanya lewat telepon atau pesan singkat.
            </span>
          </li>
          <li className="publik-daftar-item">
            <Icon name="lock" size={16} />
            <span>
              Portal ini tidak pernah meminta kata sandi, PIN, kode OTP, atau nomor rekening
              melalui formulir pengajuan.
            </span>
          </li>
          <li className="publik-daftar-item">
            <Icon name="lock" size={16} />
            <span>
              Tidak ada biaya apa pun untuk mengajukan lewat portal ini. Bila ada yang meminta
              biaya atas nama program ini, laporkan ke kantor cabang.
            </span>
          </li>
        </ul>
      </KartuPublik>
    </HalamanPublik>
  );
}
