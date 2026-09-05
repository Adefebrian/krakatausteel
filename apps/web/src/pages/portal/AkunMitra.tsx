// Akun Mitra Portal, spec 9.5 and spec 4.9. Issuing and disabling the portal
// account a Mitra Binaan signs in with to read their own akad.
//
// THE PASSWORD IS SHOWN ONCE AND THE PAGE TREATS IT AS THE ONLY COPY THAT WILL
// EVER EXIST.
//
// `POST /mitra/akun` answers a server generated password. It is not stored in
// cleartext anywhere, it is not written to `audit_log`, and there is no
// endpoint that reads it back: the new account carries `harus_ganti_sandi`, so
// the value can only ever be used to replace itself. So this screen
//
//   shows it exactly once, in a panel that says in words that it cannot be
//   retrieved again and that closing the panel destroys the only copy;
//   offers a copy control, because the alternative is an officer retyping a
//   generated string and blaming the system when the mitra cannot sign in;
//   never re-renders it from a later read, because no later read has it;
//   never puts it in the URL, in a toast, or in any list.
//
// If it is lost, the account is issued again, which produces a NEW password and
// invalidates the old one. That is the recovery path, and the page says so
// rather than leaving an officer hunting for a "lihat sandi" control that
// cannot exist.
//
// THE ACTIVATION STATE IS NOT READABLE FROM ANY ENDPOINT, AND THE PAGE DOES NOT
// INVENT ONE. `GET /pumk/mitra` answers the mitra roster and says nothing about
// portal accounts; the only two account routes are both POSTs. So the roster is
// shown without an account column, the page says why, and the only status it
// ever prints is the answer to an action taken IN THIS SESSION, labelled as
// exactly that. A green "Aktif" chip derived from nothing would be a claim
// about access control that nobody checked.
//
// ISSUING NEEDS `konfigurasi.user`, WHICH THIS PAGE'S OWN PERMISSION DOES NOT
// IMPLY. The nav entry opens on `portal.view` so an intake officer can read the
// roster; the two provisioning routes sit on `konfigurasi.user`. The controls
// are therefore offered only to a holder of that code, and the server checks it
// again, which is where the actual control lives.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  Icon,
  Panel,
  SearchInput,
  TextInput,
  formatCount,
  useToast,
} from "@krakatausteel/ui";
import { buatAkunMitra, setAktifAkunMitra, type HasilBuatAkun } from "../../api/portal-staf";
import { cariMitra, type RingkasanMitra } from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  DaftarDokumen,
  FieldGrid,
  HalamanModul,
  Muat,
  useLingkupCabang,
  type ColumnSpec,
} from "../shared/parts";
import { CatatanPortal } from "./parts";

export function AkunMitra({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const lingkup = useLingkupCabang("Cabang");
  const [cari, setCari] = useState("");
  const [dipilih, setDipilih] = useState<RingkasanMitra | null>(null);

  const bolehKelola = hasPermission(session.permissions, "konfigurasi.user");
  const daftar = useApi(
    () => cariMitra(cari.trim(), lingkup.cabangId ?? session.cabang.id),
    [cari, lingkup.cabangId],
  );

  return (
    <HalamanModul route={route}>
      <PenjelasanAkun bolehKelola={bolehKelola} />

      <div className="filter-laporan">
        {lingkup.kontrol}
        <label className="filter-laporan-group is-lebar">
          <span className="filter-laporan-label">Cari Mitra Binaan</span>
          <SearchInput
            label="Cari Mitra Binaan berdasarkan nama, NIK, atau kode"
            value={cari}
            onChange={(event) => setCari(event.currentTarget.value)}
          />
        </label>
      </div>

      <Muat hasil={daftar} judul="daftar Mitra Binaan" sumber="GET /api/pumk/mitra">
        {(data) => (
          <Panel
            as="h2"
            title="Mitra Binaan"
            description="Pilih satu mitra untuk menerbitkan atau menonaktifkan akun portalnya."
            footer={
              <span className="panel-foot-note">
                Sumber: GET /api/pumk/mitra. Daftar ini dipotong server pada{" "}
                {formatCount(50)} baris, jadi persempit dengan pencarian.
              </span>
            }
          >
            <DaftarDokumen
              columns={KOLOM_MITRA}
              rows={data.data}
              rowKey={(row) => row.id}
              kartu={(row) => ({
                judul: row.namaLengkap,
                sub: `${row.kodeMitra} . ${row.namaUsaha ?? "tanpa nama usaha"}`,
                meta: row.telepon ?? "tanpa telepon",
              })}
              onPilih={(row) => setDipilih(row)}
              emptyTitle="Tidak ada Mitra Binaan yang cocok"
              emptyDescription="Ganti kata kunci pencarian, atau pilih cabang lain dalam wewenang Anda."
              caption="Mitra Binaan pada cabang terpilih"
            />
          </Panel>
        )}
      </Muat>

      {dipilih === null ? null : (
        <PengelolaanAkun
          mitra={dipilih}
          bolehKelola={bolehKelola}
          onTutup={() => setDipilih(null)}
        />
      )}

      <CatatanPortal />
      <CatatanOtorisasi tambahan="Halaman ini terbuka dengan portal.view. Menerbitkan dan menonaktifkan akun mitra memerlukan konfigurasi.user, dan server memeriksanya ulang." />
    </HalamanModul>
  );
}

const KOLOM_MITRA: readonly ColumnSpec<RingkasanMitra>[] = [
  { key: "kodeMitra", header: "Kode mitra", sortable: true, width: "160px" },
  { key: "namaLengkap", header: "Nama lengkap", sortable: true },
  {
    key: "namaUsaha",
    header: "Nama usaha",
    render: (row) => row.namaUsaha ?? "tidak diisi",
  },
  {
    key: "telepon",
    header: "Telepon",
    width: "160px",
    render: (row) => row.telepon ?? "tidak diisi",
  },
  {
    key: "jumlahPinjamanAktif",
    header: "Pinjaman aktif",
    type: "count",
    width: "140px",
  },
];

function PenjelasanAkun({ bolehKelola }: { bolehKelola: boolean }) {
  return (
    <Panel
      as="h2"
      title="Cara kerja akun mitra, sebelum satu akun diterbitkan"
      description="Tiga hal yang berlaku pada setiap akun mitra, tanpa pengecualian."
      className="panel-panduan"
    >
      <ol className="langkah-list">
        <li>
          Sandi awal dibentuk server dan <strong>hanya ditampilkan satu kali</strong>, tepat setelah
          akun dibuat. Sandi itu tidak disimpan dalam bentuk terbaca di mana pun, tidak dicatat pada
          audit log, dan tidak ada endpoint yang bisa menampilkannya lagi.
        </li>
        <li>
          Akun baru wajib mengganti sandinya sendiri pada login pertama, jadi sandi yang Anda
          serahkan hanya bisa dipakai untuk menggantikan dirinya sendiri.
        </li>
        <li>
          Mitra hanya bisa melihat akad, jadwal, dan pembayarannya sendiri. Sesi mitra memakai
          cookie dan penyimpanan sesi yang terpisah dari sesi petugas, sehingga akun mitra tidak
          pernah bisa menyentuh layar petugas.
        </li>
      </ol>
      {bolehKelola ? null : (
        <p className="periksa-item">
          <Icon name="lock" size={16} />
          <span>
            Peran Anda bisa membaca daftar mitra, tetapi tidak memegang kewenangan konfigurasi.user
            yang dibutuhkan untuk menerbitkan atau menonaktifkan akun. Kontrolnya tidak ditampilkan,
            dan server tetap menolaknya bila dipanggil langsung.
          </span>
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One mitra: issue, and enable or disable
// ---------------------------------------------------------------------------

function PengelolaanAkun({
  mitra,
  bolehKelola,
  onTutup,
}: {
  mitra: RingkasanMitra;
  bolehKelola: boolean;
  onTutup: () => void;
}) {
  const [email, setEmail] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const terbit = useAction(buatAkunMitra);
  const status = useAction((input: { mitraId: string; aktif: boolean }) =>
    setAktifAkunMitra(input.mitraId, input.aktif),
  );

  const emailBersih = email.trim();
  const siap = emailBersih.length > 0 && emailBersih.length <= 200;
  /** True from the moment a password is answered until the officer dismisses it. */
  const sedangMenampilkanSandi = terbit.hasil !== null;

  async function terbitkan() {
    const hasil = await terbit.jalankan({ mitraId: mitra.id, email: emailBersih });
    if (hasil) setKonfirmasi(false);
  }

  return (
    <>
      <Panel
        as="h2"
        title={`Akun portal untuk ${mitra.namaLengkap}`}
        description="Satu akun per Mitra Binaan. Menerbitkan ulang membentuk sandi baru dan membuat sandi lama tidak berlaku lagi."
        aside={
          <Button variant="ghost" size="sm" onClick={onTutup}>
            Tutup
          </Button>
        }
        footer={
          <span className="panel-foot-note">
            Sumber: POST /api/mitra/akun dan POST /api/mitra/akun/{mitra.id}/status. Kewenangan
            konfigurasi.user.
          </span>
        }
      >
        <DataList
          items={[
            { label: "Kode mitra", value: mitra.kodeMitra },
            { label: "Nama lengkap", value: mitra.namaLengkap },
            { label: "Nama usaha", value: mitra.namaUsaha ?? "tidak diisi" },
            { label: "Telepon", value: mitra.telepon ?? "tidak diisi" },
            {
              label: "Status akun portal",
              value: "tidak dapat dibaca dari server",
              wide: true,
            },
          ]}
        />
        <p className="page-note">
          <Icon name="info" size={16} />
          <span>
            Belum ada endpoint yang membaca status akun portal seorang mitra, jadi halaman ini tidak
            menampilkan status aktif atau nonaktif yang tersimpan. Menampilkan tebakan di sini akan
            menjadi pernyataan tentang hak akses yang tidak diverifikasi siapa pun. Yang ditampilkan
            hanyalah hasil tindakan yang Anda lakukan pada halaman ini.
          </span>
        </p>

        {bolehKelola ? (
          <>
            <FieldGrid>
              <Field
                label="Email untuk login mitra"
                htmlFor="akun-email"
                required
                hint="Email ini menjadi identitas login mitra di portal. Pastikan benar sebelum akun diterbitkan."
              >
                <TextInput
                  id="akun-email"
                  type="email"
                  autoComplete="off"
                  maxLength={200}
                  value={email}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                />
              </Field>
            </FieldGrid>
            {/*
              EVERY CONTROL IS CLOSED WHILE THE PASSWORD IS ON SCREEN.

              Issuing again produces a NEW password and invalidates the one the
              officer is holding, so leaving the button live next to a value
              that cannot be recovered is one stray click away from losing it.
              Seen at 1440 with the panel open, not caught by a test. It is
              disabled rather than hidden so the row does not jump under the
              cursor, and the reason is stated rather than left to be guessed.
            */}
            {sedangMenampilkanSandi ? (
              <p className="periksa-item">
                <Icon name="alert" size={16} />
                <span>
                  Kontrol akun dikunci selama sandi sementara masih tampil di bawah. Menerbitkan
                  ulang sekarang akan membentuk sandi baru dan membuat sandi yang sedang Anda pegang
                  tidak berlaku lagi.
                </span>
              </p>
            ) : null}
            <div className="form-actions-row">
              <Button
                variant="ghost"
                disabled={sedangMenampilkanSandi}
                leading={<Icon name="lock" size={16} />}
                loading={status.status === "mengirim"}
                onClick={() => void status.jalankan({ mitraId: mitra.id, aktif: false })}
              >
                Nonaktifkan akun
              </Button>
              <Button
                variant="ghost"
                disabled={sedangMenampilkanSandi}
                leading={<Icon name="check" size={16} />}
                loading={status.status === "mengirim"}
                onClick={() => void status.jalankan({ mitraId: mitra.id, aktif: true })}
              >
                Aktifkan kembali
              </Button>
              <Button
                variant="primary"
                disabled={!siap || sedangMenampilkanSandi}
                leading={<Icon name="user" size={16} />}
                onClick={() => setKonfirmasi(true)}
              >
                Terbitkan akun portal
              </Button>
            </div>
            {status.error ? (
              <p className="form-error" role="alert">
                <Icon name="alert" size={16} />
                <span>{status.error}</span>
              </p>
            ) : null}
            {status.hasil ? (
              <p className="periksa-ok">
                <Icon name="check" size={16} />
                <span>
                  Tindakan terakhir di halaman ini: akun mitra ini{" "}
                  {status.hasil.aktif ? "diaktifkan" : "dinonaktifkan"}, dan berlaku seketika.
                </span>
              </p>
            ) : null}
            {terbit.error ? (
              <p className="form-error" role="alert">
                <Icon name="alert" size={16} />
                <span>{terbit.error}</span>
              </p>
            ) : null}
          </>
        ) : null}
      </Panel>

      {terbit.hasil ? (
        <SandiSekali hasil={terbit.hasil} onSelesai={() => terbit.reset()} />
      ) : null}

      <ConfirmDialog
        open={konfirmasi}
        title={`Terbitkan akun portal untuk ${mitra.namaLengkap}`}
        description="Sandi awal akan ditampilkan satu kali saja, tepat setelah ini, dan tidak bisa ditampilkan lagi setelah Anda menutupnya."
        confirmLabel="Terbitkan akun"
        loading={terbit.status === "mengirim"}
        error={terbit.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={() => void terbitkan()}
      >
        <DataList
          items={[
            { label: "Mitra Binaan", value: `${mitra.kodeMitra} ${mitra.namaLengkap}` },
            { label: "Email login", value: emailBersih, wide: true },
            {
              label: "Bila mitra sudah punya akun",
              value: "sandi lama tidak berlaku lagi setelah akun diterbitkan ulang",
              wide: true,
            },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}

/**
 * The one time password, shown once.
 *
 * IT IS DISMISSED EXPLICITLY, not by navigating away by accident: the only
 * control closes it and says what closing it costs. Nothing re-renders this
 * panel from a later read, because no later read carries the value.
 */
function SandiSekali({ hasil, onSelesai }: { hasil: HasilBuatAkun; onSelesai: () => void }) {
  const toast = useToast();
  const [ditutup, setDitutup] = useState(false);

  if (ditutup) {
    return (
      <Panel as="h2" title="Sandi sementara sudah ditutup">
        <p className="peringatan-teks">
          Sandi sementara tidak ditampilkan lagi dan tidak bisa dibaca kembali dari mana pun. Bila
          sandi itu belum sempat diserahkan kepada mitra, terbitkan akunnya sekali lagi untuk
          mendapatkan sandi baru.
        </p>
        <div className="form-actions-row">
          <Button variant="primary" onClick={onSelesai}>
            Kembali ke pengelolaan akun
          </Button>
        </div>
      </Panel>
    );
  }

  async function salin() {
    try {
      await navigator.clipboard?.writeText(hasil.sandiSementara);
      toast.success("Sandi sementara disalin ke papan klip");
    } catch {
      toast.error(
        "Penyalinan otomatis ditolak peramban",
        "Salin sandinya secara manual dari kotak di atas sebelum menutup panel ini.",
      );
    }
  }

  return (
    <Panel
      as="h2"
      title="Sandi sementara, ditampilkan satu kali"
      description="Serahkan sandi ini kepada mitra sekarang juga. Setelah panel ini ditutup, tidak ada cara apa pun untuk menampilkannya kembali."
      className="panel-sandi"
    >
      <DataList
        items={[
          { label: "Email login", value: hasil.email, wide: true },
          {
            label: "Sandi sementara",
            value: <code className="sandi-nilai">{hasil.sandiSementara}</code>,
            wide: true,
          },
        ]}
      />
      <p className="peringatan-teks">
        Sandi ini tidak disimpan dalam bentuk terbaca di basis data, tidak dicatat pada audit log,
        dan tidak dikirim lewat surel oleh sistem. Akun ini wajib mengganti sandinya sendiri pada
        login pertama, sehingga sandi di atas hanya bisa dipakai untuk menggantikan dirinya sendiri.
      </p>
      <div className="form-actions-row">
        <Button variant="secondary" leading={<Icon name="file" size={16} />} onClick={() => void salin()}>
          Salin sandi sementara
        </Button>
        <Button variant="primary" onClick={() => setDitutup(true)}>
          Tutup, sandi sudah diserahkan
        </Button>
      </div>
    </Panel>
  );
}
