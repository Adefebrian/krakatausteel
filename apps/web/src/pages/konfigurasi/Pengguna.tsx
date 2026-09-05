// Pengguna dan Role, spec 9.4. Where authority is handed out.
//
// FOUR RULES OF THE API, AND EACH OF THEM IS VISIBLE ON THIS SCREEN.
//
// 1. A ONE TIME PASSWORD IS SHOWN ONCE AND THIS PAGE TREATS IT AS THE ONLY COPY
//    THAT WILL EVER EXIST. Creating an account and resetting a password both
//    answer a server generated value. It is stored only as an argon2id hash, it
//    is never written to `audit_log`, and there is no endpoint that reads it
//    back. So while it is on screen this page shows NOTHING ELSE: no user list
//    to click, no reset button, no create button. That is stricter than
//    disabling the two controls that could mint a replacement, and it is
//    deliberate, because the cheapest way to lose the value here is not a stray
//    click on "reset", it is a stray click on ANOTHER ROW, which would unmount
//    the panel holding it. The mitra account screen learnt the first half of
//    this the hard way; this screen starts from the conclusion.
//
// 2. THE ROLE CATALOGUE IS ANSWERED PER CALLER AND IS NOT RE-DERIVED HERE.
//    `GET /organisasi/peran` returns every role annotated with `dapatDiberikan`
//    and, when false, the server's own `alasan`. A role this officer may not
//    grant is rendered visibly unavailable WITH that sentence, never hidden and
//    never offered then refused. The rule itself (a grant may not widen the
//    granter's own authority; only a cross branch caller may grant a cross
//    branch role) lives on the server, in one place, and this file does not
//    hold a second opinion about it.
//
// 3. NOBODY EDITS THEIR OWN AUTHORITY. Not their roles, not their own active
//    flag. The server refuses it for every role including Admin Pusat, because
//    the control is "two people were involved" and an exception for the most
//    privileged account is an exception exactly where it matters most. This
//    page therefore does not offer either control on the signed in officer's
//    own account, and says which rule is why.
//
// 4. A USERNAME IS NEVER RENAMED, AND NOTHING IS EVER DELETED. `audit_log` and
//    every `created_by` trail are read back through the username by a human, so
//    renaming one makes old evidence point at a name nobody recognises. The
//    remedy is a deactivation plus a new account, and the page says so where an
//    edit control would otherwise be.
import { useMemo, useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  Field,
  Icon,
  Panel,
  SearchInput,
  Select,
  StatusBadge,
  TextInput,
  Textarea,
  formatCount,
  formatDate,
  useToast,
} from "@krakatausteel/ui";
import {
  buatPengguna,
  daftarCabang,
  daftarPengguna,
  daftarPeran,
  gantiPeran,
  sandiSementara,
  setAktifPengguna,
  ubahPengguna,
  type CabangRow,
  type GrantPeran,
  type HasilSandiSementara,
  type PenggunaTampil,
  type PeranTersedia,
} from "../../api/organisasi";
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
  type ColumnSpec,
} from "../shared/parts";
import {
  Berhasil,
  FaktaTetap,
  PapanAngka,
  Penolakan,
  TanpaWewenang,
} from "./parts";

const OPSI_STATUS = [
  { value: "", label: "Aktif dan nonaktif" },
  { value: "AKTIF", label: "Aktif saja" },
  { value: "NONAKTIF", label: "Nonaktif saja" },
];

/** The password currently on screen, and which act produced it. */
interface SandiTampil {
  hasil: HasilSandiSementara;
  asal: "BARU" | "RESET";
  nama: string;
}

export function Pengguna({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const bolehKelola = hasPermission(session.permissions, "konfigurasi.user") && !session.readOnly;

  const daftar = useApi(() => daftarPengguna(), []);
  const peran = useApi(() => daftarPeran(), []);
  const cabang = useApi(() => daftarCabang(), []);

  const [cari, setCari] = useState("");
  const [status, setStatus] = useState("");
  const [dipilihId, setDipilihId] = useState<string | null>(null);
  const [formBaru, setFormBaru] = useState(false);
  const [sandi, setSandi] = useState<SandiTampil | null>(null);

  const rows = daftar.data?.data ?? [];
  const dipilih = rows.find((row) => row.id === dipilihId) ?? null;
  const katalogPeran = peran.data?.data ?? [];
  const cabangAktif = (cabang.data?.data ?? []).filter((row) => row.aktif);

  const terpilih = useMemo(() => {
    const teks = cari.trim().toLowerCase();
    return rows.filter((row) => {
      if (status === "AKTIF" && !row.aktif) return false;
      if (status === "NONAKTIF" && row.aktif) return false;
      if (teks === "") return true;
      return `${row.username} ${row.nama} ${row.email} ${row.nip ?? ""} ${row.cabangKode}`
        .toLowerCase()
        .includes(teks);
    });
  }, [rows, cari, status]);

  // THE PASSWORD PANEL REPLACES THE PAGE. See rule 1 in the file header: the
  // list stays mounted nowhere, so no click anywhere can destroy the only copy
  // of the value the officer is holding.
  if (sandi) {
    return (
      <HalamanModul route={route}>
        <SandiSekali
          sandi={sandi}
          onSelesai={() => {
            setSandi(null);
            daftar.reload();
          }}
        />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul
      route={route}
      actions={
        bolehKelola ? (
          <Button
            variant="primary"
            leading={<Icon name="plus" size={16} />}
            onClick={() => {
              setFormBaru((buka) => !buka);
              setDipilihId(null);
            }}
          >
            {formBaru ? "Tutup formulir akun baru" : "Akun baru"}
          </Button>
        ) : undefined
      }
    >
      <Muat hasil={daftar} judul="daftar pengguna" sumber="GET /api/organisasi/pengguna">
        {(data) => (
          <>
            <PapanAngka
              items={[
                {
                  label: "Seluruh akun",
                  nilai: formatCount(data.data.length),
                  satuan: "Akun",
                  catatan: "Yang terbaca dalam wewenang Anda.",
                },
                {
                  label: "Aktif",
                  nilai: formatCount(data.data.filter((row) => row.aktif).length),
                  satuan: "Akun",
                  catatan: "Bisa masuk aplikasi.",
                },
                {
                  label: "Wajib ganti sandi",
                  nilai: formatCount(data.data.filter((row) => row.harusGantiSandi).length),
                  satuan: "Akun",
                  catatan: "Sandi sementara belum diganti pemiliknya.",
                },
                {
                  label: "Belum pernah masuk",
                  nilai: formatCount(data.data.filter((row) => row.lastLoginAt === null).length),
                  satuan: "Akun",
                  catatan: "Diterbitkan, tetapi belum dipakai sekali pun.",
                },
              ]}
            />

            {bolehKelola ? null : (
              <Panel as="h2" title="Halaman ini terbuka untuk dibaca">
                <TanpaWewenang
                  izin="konfigurasi.user"
                  tindakan="menerbitkan akun, mengubah peran, atau menonaktifkan akun"
                />
                <p className="penjelasan">
                  Daftar ini juga terbuka dengan kewenangan audit.view, karena audit trail menyimpan
                  pelaku sebagai id pengguna dan sebuah jejak yang pelakunya tidak bisa dikenali
                  bukan jejak yang bisa dibaca.
                </p>
              </Panel>
            )}

            {formBaru && bolehKelola ? (
              <FormPenggunaBaru
                peran={katalogPeran}
                cabang={cabangAktif}
                cabangAwal={session.cabang.id}
                onTerbit={(hasil, nama) => {
                  setFormBaru(false);
                  setSandi({ hasil, asal: "BARU", nama });
                }}
                onBatal={() => setFormBaru(false)}
              />
            ) : null}

            <Panel
              as="h2"
              title="Akun pengguna"
              description="Pilih satu akun untuk membaca datanya, mengubah perannya, atau menonaktifkannya."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/organisasi/pengguna. {formatCount(terpilih.length)} dari{" "}
                  {formatCount(data.data.length)} akun ditampilkan.
                </span>
              }
            >
              <div className="filterbar" role="search">
                <div className="filterbar-group is-grow">
                  <span className="filterbar-label">Cari akun</span>
                  <SearchInput
                    label="Cari akun berdasarkan nama pengguna, nama lengkap, surel, atau cabang"
                    placeholder="Nama pengguna, nama, surel, atau cabang"
                    value={cari}
                    onChange={(event) => setCari(event.currentTarget.value)}
                  />
                </div>
                <div className="filterbar-group">
                  <span className="filterbar-label">Status</span>
                  <Select
                    aria-label="Status akun"
                    value={status}
                    onChange={(event) => setStatus(event.currentTarget.value)}
                    options={OPSI_STATUS}
                  />
                </div>
              </div>

              <DaftarDokumen
                columns={KOLOM}
                rows={terpilih}
                rowKey={(row) => row.id}
                kartu={(row) => ({
                  judul: row.nama,
                  sub: `${row.username} . ${row.cabangKode} ${row.cabangNama}`,
                  status: (
                    <StatusBadge
                      status={row.aktif ? "AKTIF" : "NONAKTIF"}
                      tone={row.aktif ? "success" : "neutral"}
                      label={row.aktif ? "Aktif" : "Nonaktif"}
                    />
                  ),
                  meta: row.peran.map((item) => item.kode).join(", ") || "tanpa peran",
                })}
                onPilih={(row) => {
                  setFormBaru(false);
                  setDipilihId((sebelum) => (sebelum === row.id ? null : row.id));
                }}
                emptyTitle="Tidak ada akun yang cocok"
                emptyDescription="Ubah kata kunci pencarian atau status yang ditampilkan."
                caption="Akun pengguna dalam wewenang Anda"
              />
            </Panel>

            {dipilih ? (
              <DetailPengguna
                key={dipilih.id}
                pengguna={dipilih}
                peran={katalogPeran}
                cabang={cabangAktif}
                bolehKelola={bolehKelola}
                diriSendiri={dipilih.id === session.user.id}
                onBerubah={() => daftar.reload()}
                onSandi={(hasil) => setSandi({ hasil, asal: "RESET", nama: dipilih.nama })}
                onTutup={() => setDipilihId(null)}
              />
            ) : null}

            <PenjelasanAkun />
          </>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Menerbitkan akun dan mengubah peran memerlukan kewenangan konfigurasi.user, dan setiap perubahan hak akses tercatat pada audit trail." />
    </HalamanModul>
  );
}

const KOLOM: readonly ColumnSpec<PenggunaTampil>[] = [
  { key: "username", header: "Nama pengguna", sortable: true, width: "160px" },
  { key: "nama", header: "Nama lengkap", sortable: true },
  { key: "email", header: "Surel" },
  {
    key: "cabangKode",
    header: "Cabang",
    width: "180px",
    render: (row) => `${row.cabangKode} ${row.cabangNama}`,
  },
  {
    key: "peran",
    header: "Peran",
    render: (row) => row.peran.map((item) => item.kode).join(", ") || "tanpa peran",
  },
  {
    key: "aktif",
    header: "Status",
    width: "120px",
    render: (row) => (
      <StatusBadge
        status={row.aktif ? "AKTIF" : "NONAKTIF"}
        tone={row.aktif ? "success" : "neutral"}
        label={row.aktif ? "Aktif" : "Nonaktif"}
      />
    ),
  },
];

function PenjelasanAkun() {
  return (
    <Panel
      as="h2"
      title="Empat hal yang berlaku pada setiap akun, tanpa pengecualian"
      description="Aturannya ditegakkan di server, dan halaman ini hanya menampilkannya lebih awal."
      className="panel-panduan"
    >
      <ol className="langkah-list">
        <li>
          Sandi awal dibentuk server dan <strong>hanya ditampilkan satu kali</strong>. Sandi itu
          tidak disimpan dalam bentuk terbaca di mana pun, tidak dicatat pada audit log, dan tidak
          ada endpoint yang bisa menampilkannya lagi. Selama sandi tampil, halaman ini menutup
          seluruh daftar supaya tidak ada klik yang bisa menghilangkannya.
        </li>
        <li>
          Nama pengguna tidak dapat diubah. Audit trail dan setiap jejak pembuat dokumen dibaca
          manusia lewat nama itu, jadi menggantinya membuat bukti lama menunjuk nama yang tidak
          dikenali siapa pun. Kalau orangnya berganti, nonaktifkan akun ini dan terbitkan akun baru.
        </li>
        <li>
          Tidak ada akun yang dihapus. Id pengguna adalah pelaku pada setiap baris audit, jadi satu
          satunya penghentian akses adalah menonaktifkan akun.
        </li>
        <li>
          Tidak ada yang boleh mengubah wewenangnya sendiri. Peran dan status akun Anda sendiri
          hanya bisa diubah oleh pengguna lain yang berwenang, termasuk untuk Admin Pusat.
        </li>
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------

function DetailPengguna({
  pengguna,
  peran,
  cabang,
  bolehKelola,
  diriSendiri,
  onBerubah,
  onSandi,
  onTutup,
}: {
  pengguna: PenggunaTampil;
  peran: readonly PeranTersedia[];
  cabang: readonly CabangRow[];
  bolehKelola: boolean;
  diriSendiri: boolean;
  onBerubah: () => void;
  onSandi: (hasil: HasilSandiSementara) => void;
  onTutup: () => void;
}) {
  const [nama, setNama] = useState(pengguna.nama);
  const [email, setEmail] = useState(pengguna.email);
  const [nip, setNip] = useState(pengguna.nip ?? "");
  const [cabangId, setCabangId] = useState(pengguna.cabangId);
  const [alasanStatus, setAlasanStatus] = useState("");
  const [konfirmasiStatus, setKonfirmasiStatus] = useState(false);
  const [konfirmasiSandi, setKonfirmasiSandi] = useState(false);

  const [dipilihPeran, setDipilihPeran] = useState<readonly string[]>(() =>
    pengguna.peran.map((item) => item.kode),
  );

  const simpan = useAction((body: Parameters<typeof ubahPengguna>[1]) =>
    ubahPengguna(pengguna.id, body),
  );
  const peranAksi = useAction((daftar: readonly GrantPeran[]) => gantiPeran(pengguna.id, daftar));
  const statusAksi = useAction((input: { aktif: boolean; alasan: string | null }) =>
    setAktifPengguna(pengguna.id, input.aktif, input.alasan),
  );
  const resetAksi = useAction(() => sandiSementara(pengguna.id));

  const profilBerubah =
    nama.trim() !== pengguna.nama ||
    email.trim() !== pengguna.email ||
    nip.trim() !== (pengguna.nip ?? "") ||
    cabangId !== pengguna.cabangId;

  // Keyed by a plain string on purpose. `PeranTersedia.kode` is the server's
  // narrow role union, while `PenggunaTampil.peran[].kode` is a plain string,
  // because an account can hold a role the current catalogue no longer names.
  // Looking one up must therefore be possible for ANY string, and a miss is a
  // real answer: it means this caller may not grant that role.
  const katalog = useMemo(
    () => new Map<string, PeranTersedia>(peran.map((item) => [item.kode, item])),
    [peran],
  );

  // A role the account ALREADY holds that this caller may not grant. The role
  // endpoint replaces the WHOLE set, and the server authorises every member of
  // the new set, so a caller in this position cannot save any role change at
  // all. Said in words, with the server's own reason, instead of offering a
  // form whose every save is refused.
  const peranDiLuarWewenang = pengguna.peran.filter(
    (item) => katalog.get(item.kode)?.dapatDiberikan !== true,
  );

  const peranBerubah =
    dipilihPeran.length !== pengguna.peran.length ||
    dipilihPeran.some((kode) => !pengguna.peran.some((item) => item.kode === kode));

  const scopeLama = useMemo(
    () => new Map(pengguna.peran.map((item) => [item.kode, item.scopeCabangId])),
    [pengguna.peran],
  );

  function simpanPeran() {
    const daftar: GrantPeran[] = dipilihPeran.map((kode) => ({
      kode,
      // A role already granted in ANOTHER branch keeps that scope. A newly
      // ticked role is granted in the account's own branch, which is what a
      // null scope means, and the panel says so rather than inventing a
      // per-role branch picker this API has no screen precedent for.
      scopeCabangId: scopeLama.get(kode) ?? null,
    }));
    void peranAksi.jalankan(daftar).then((hasil) => {
      if (hasil) onBerubah();
    });
  }

  return (
    <Panel
      as="h2"
      title={`${pengguna.nama} (${pengguna.username})`}
      description="Identitas akun di atas tidak dapat diubah. Data diri, peran, dan status di bawahnya dapat."
      aside={
        <Button variant="ghost" size="sm" onClick={onTutup}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: PATCH /api/organisasi/pengguna/{pengguna.id.slice(0, 8)}, PUT .../peran, POST
          .../status, POST .../sandi-sementara. Versi baris {formatCount(pengguna.version)}.
        </span>
      }
    >
      <FaktaTetap
        items={[
          {
            label: "Nama pengguna",
            value: pengguna.username,
            alasan:
              "Audit trail dan setiap jejak pembuat dokumen dibaca manusia lewat nama ini. Kalau orangnya berganti, nonaktifkan akun ini lalu terbitkan akun baru.",
          },
        ]}
      />

      <DataList
        columns={2}
        items={[
          { label: "Cabang saat ini", value: `${pengguna.cabangKode} ${pengguna.cabangNama}` },
          {
            label: "Peran yang berlaku",
            value: pengguna.peran.length === 0
              ? "tanpa peran"
              : pengguna.peran
                  .map((item) => (item.scopeCabangId ? `${item.kode} (scope cabang lain)` : item.kode))
                  .join(", "),
          },
          {
            label: "Terakhir masuk",
            value: pengguna.lastLoginAt ? formatDate(pengguna.lastLoginAt) : "belum pernah masuk",
          },
          {
            label: "Sandi terakhir diganti",
            value: pengguna.sandiDiubahAt ? formatDate(pengguna.sandiDiubahAt) : "belum pernah diganti sendiri",
          },
          {
            label: "Wajib ganti sandi saat masuk",
            value: pengguna.harusGantiSandi ? "Ya, sandi sementara belum diganti" : "Tidak",
            wide: true,
          },
        ]}
      />

      {!bolehKelola ? (
        <TanpaWewenang izin="konfigurasi.user" tindakan="mengubah akun ini" />
      ) : (
        <>
          <FieldGrid>
            <Field label="Nama lengkap" htmlFor={`usr-nama-${pengguna.id}`} required>
              <TextInput
                id={`usr-nama-${pengguna.id}`}
                maxLength={200}
                value={nama}
                onChange={(event) => setNama(event.currentTarget.value)}
              />
            </Field>
            <Field label="Surel" htmlFor={`usr-email-${pengguna.id}`} required>
              <TextInput
                id={`usr-email-${pengguna.id}`}
                type="email"
                maxLength={200}
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </Field>
            <Field label="NIP" htmlFor={`usr-nip-${pengguna.id}`}>
              <TextInput
                id={`usr-nip-${pengguna.id}`}
                maxLength={50}
                value={nip}
                onChange={(event) => setNip(event.currentTarget.value)}
              />
            </Field>
            <Field
              label="Cabang"
              htmlFor={`usr-cabang-${pengguna.id}`}
              required
              hint="Cabang ini membatasi seluruh data yang bisa dibaca akun ini, kecuali perannya lintas cabang."
            >
              <Select
                id={`usr-cabang-${pengguna.id}`}
                value={cabangId}
                onChange={(event) => setCabangId(event.currentTarget.value)}
                options={cabang.map((row) => ({ value: row.id, label: `${row.kode} ${row.nama}` }))}
              />
            </Field>
          </FieldGrid>

          <Penolakan pesan={simpan.error} />
          <Berhasil pesan={simpan.hasil ? "Data akun tersimpan dan tercatat pada audit trail." : null} />

          <div className="form-actions-row">
            <Button
              variant="primary"
              disabled={!profilBerubah || nama.trim() === "" || email.trim() === ""}
              loading={simpan.status === "mengirim"}
              onClick={() => {
                void simpan
                  .jalankan({
                    nama: nama.trim(),
                    email: email.trim(),
                    nip: nip.trim() === "" ? null : nip.trim(),
                    cabangId,
                    version: pengguna.version,
                  })
                  .then((hasil) => {
                    if (hasil) onBerubah();
                  });
              }}
            >
              Simpan data akun
            </Button>
          </div>

          {/* ------------------------------------------------------- peran */}
          <div className="blok-aksi">
            <h3 className="blok-judul">Peran</h3>
            <p className="blok-sub">
              Menyimpan peran mengganti seluruh peran akun ini sekaligus, bukan menambah satu.
              Peran yang tidak dapat Anda berikan ditandai beserta alasan dari server.
            </p>

            {diriSendiri ? (
              <p className="periksa-item">
                <Icon name="lock" size={16} />
                <span>
                  Ini akun Anda sendiri. Tidak ada pengguna, termasuk Admin Pusat, yang boleh
                  mengubah perannya sendiri: kontrolnya adalah bahwa dua orang terlibat, dan
                  pengecualian untuk akun paling berwenang justru pengecualian di tempat yang paling
                  penting. Mintalah pengguna lain yang berwenang.
                </span>
              </p>
            ) : peranDiLuarWewenang.length > 0 ? (
              <p className="periksa-item">
                <Icon name="lock" size={16} />
                <span>
                  Akun ini memegang peran{" "}
                  {peranDiLuarWewenang.map((item) => item.kode).join(", ")}, dan Anda tidak dapat
                  memberikan peran itu.{" "}
                  {katalog.get(peranDiLuarWewenang[0]!.kode)?.alasan ?? ""} Karena penyimpanan peran
                  mengganti seluruh daftar sekaligus, server akan menolak perubahan apa pun dari
                  Anda pada akun ini.
                </span>
              </p>
            ) : (
              <>
                <ul className="peran-list">
                  {peran.map((item) => {
                    const dicentang = dipilihPeran.includes(item.kode);
                    const terkunci = !item.dapatDiberikan;
                    return (
                      <li
                        className={terkunci ? "peran-item is-tertahan" : "peran-item"}
                        key={item.kode}
                      >
                        <label className="peran-kotak" htmlFor={`peran-${pengguna.id}-${item.kode}`}>
                          <input
                            id={`peran-${pengguna.id}-${item.kode}`}
                            type="checkbox"
                            checked={dicentang}
                            disabled={terkunci}
                            onChange={(event) =>
                              setDipilihPeran((sebelum) =>
                                event.currentTarget.checked
                                  ? [...sebelum, item.kode]
                                  : sebelum.filter((kode) => kode !== item.kode),
                              )
                            }
                          />
                          <span className="peran-teks">
                            <span className="peran-nama">{item.nama}</span>
                            <span className="peran-sifat">
                              {item.lintasCabang ? "Lintas cabang" : "Terikat satu cabang"}
                              {item.readOnly ? ", hanya baca" : ""}
                            </span>
                          </span>
                        </label>
                        {terkunci && item.alasan ? (
                          <p className="peran-alasan">{item.alasan}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>

                <p className="penjelasan">
                  Peran baru diberikan pada cabang akun ini. Peran yang sebelumnya diberikan dengan
                  scope cabang lain mempertahankan scope itu selama tetap dicentang.
                </p>

                <Penolakan pesan={peranAksi.error} />
                <Berhasil pesan={peranAksi.hasil ? "Peran akun ini diganti dan tercatat pada audit trail." : null} />

                <div className="form-actions-row">
                  <Button
                    variant="primary"
                    disabled={!peranBerubah || dipilihPeran.length === 0}
                    loading={peranAksi.status === "mengirim"}
                    onClick={simpanPeran}
                  >
                    Simpan peran
                  </Button>
                </div>
                {dipilihPeran.length === 0 ? (
                  <p className="periksa-item">
                    <Icon name="alert" size={16} />
                    <span>
                      Sebuah akun harus punya sekurang kurangnya satu peran. Untuk menghentikan
                      akses, nonaktifkan akunnya, bukan mengosongkan perannya.
                    </span>
                  </p>
                ) : null}
              </>
            )}
          </div>

          {/* ------------------------------------------------------ status */}
          <div className="blok-aksi">
            <h3 className="blok-judul">Status akun</h3>
            <p className="blok-sub">
              Menonaktifkan akun menghentikan aksesnya seketika. Tidak ada akun yang dihapus, karena
              id pengguna adalah pelaku pada setiap baris audit.
            </p>
            {diriSendiri ? (
              <p className="periksa-item">
                <Icon name="lock" size={16} />
                <span>
                  Anda tidak dapat menonaktifkan akun Anda sendiri. Mintalah pengguna lain yang
                  berwenang.
                </span>
              </p>
            ) : (
              <>
                <div className="status-kendali">
                  <div className="status-teks">
                    <p className="status-judul">
                      Status saat ini{" "}
                      <StatusBadge
                        status={pengguna.aktif ? "AKTIF" : "NONAKTIF"}
                        tone={pengguna.aktif ? "success" : "neutral"}
                        label={pengguna.aktif ? "Aktif" : "Nonaktif"}
                      />
                    </p>
                    <p className="status-sub">
                      {pengguna.aktif
                        ? "Akun ini bisa masuk aplikasi sekarang."
                        : "Akun ini tidak bisa masuk aplikasi. Dokumen yang pernah dibuatnya tetap utuh."}
                    </p>
                  </div>
                  <Button
                    variant={pengguna.aktif ? "ghost" : "primary"}
                    leading={<Icon name={pengguna.aktif ? "lock" : "check"} size={16} />}
                    loading={statusAksi.status === "mengirim"}
                    onClick={() => setKonfirmasiStatus(true)}
                  >
                    {pengguna.aktif ? "Nonaktifkan akun" : "Aktifkan kembali"}
                  </Button>
                </div>
                <Penolakan pesan={statusAksi.error} />
                <Berhasil
                  pesan={
                    statusAksi.hasil
                      ? `Akun ini ${statusAksi.hasil.aktif ? "diaktifkan" : "dinonaktifkan"}, dan berlaku seketika.`
                      : null
                  }
                />
              </>
            )}
          </div>

          {/* ------------------------------------------------------- sandi */}
          <div className="blok-aksi">
            <h3 className="blok-judul">Sandi sementara</h3>
            <p className="blok-sub">
              Menerbitkan sandi sementara membuat sandi lama akun ini tidak berlaku lagi, dan
              memaksa pemiliknya mengganti sandi saat masuk. Sandi baru ditampilkan satu kali saja.
            </p>
            <Penolakan pesan={resetAksi.error} />
            <div className="form-actions-row">
              <Button
                variant="secondary"
                leading={<Icon name="refresh" size={16} />}
                loading={resetAksi.status === "mengirim"}
                onClick={() => setKonfirmasiSandi(true)}
              >
                Terbitkan sandi sementara
              </Button>
            </div>
          </div>

          <ConfirmDialog
            open={konfirmasiStatus}
            title={pengguna.aktif ? `Nonaktifkan akun ${pengguna.username}` : `Aktifkan kembali akun ${pengguna.username}`}
            description={
              pengguna.aktif
                ? "Akses akun ini berhenti seketika. Dokumen dan jejak audit yang sudah ada tidak tersentuh."
                : "Akun ini bisa masuk lagi setelah ini, dengan peran yang tercantum di atas."
            }
            confirmLabel={pengguna.aktif ? "Nonaktifkan akun" : "Aktifkan kembali"}
            tone={pengguna.aktif ? "danger" : "primary"}
            loading={statusAksi.status === "mengirim"}
            error={statusAksi.error}
            onCancel={() => setKonfirmasiStatus(false)}
            onConfirm={() => {
              setKonfirmasiStatus(false);
              void statusAksi
                .jalankan({
                  aktif: !pengguna.aktif,
                  alasan: alasanStatus.trim() === "" ? null : alasanStatus.trim(),
                })
                .then((hasil) => {
                  if (hasil) onBerubah();
                });
            }}
          >
            <Field
              label="Alasan"
              htmlFor={`usr-alasan-${pengguna.id}`}
              hint="Ikut tercatat pada audit trail. Boleh kosong, tetapi alasan yang tertulis membuat riwayat akses bisa dibaca setahun kemudian."
            >
              <Textarea
                id={`usr-alasan-${pengguna.id}`}
                rows={3}
                maxLength={500}
                value={alasanStatus}
                onChange={(event) => setAlasanStatus(event.currentTarget.value)}
              />
            </Field>
          </ConfirmDialog>

          <ConfirmDialog
            open={konfirmasiSandi}
            title={`Terbitkan sandi sementara untuk ${pengguna.username}`}
            description="Sandi lama akun ini langsung tidak berlaku. Sandi baru ditampilkan satu kali saja, tepat setelah ini, dan tidak bisa ditampilkan lagi setelah Anda menutupnya."
            confirmLabel="Terbitkan sandi sementara"
            tone="danger"
            loading={resetAksi.status === "mengirim"}
            error={resetAksi.error}
            onCancel={() => setKonfirmasiSandi(false)}
            onConfirm={() => {
              setKonfirmasiSandi(false);
              void resetAksi.jalankan(undefined).then((hasil) => {
                if (hasil) onSandi(hasil);
              });
            }}
          >
            <DataList
              items={[
                { label: "Akun", value: `${pengguna.username} . ${pengguna.nama}` },
                { label: "Cabang", value: `${pengguna.cabangKode} ${pengguna.cabangNama}` },
                {
                  label: "Setelah ini",
                  value:
                    "akun wajib mengganti sandinya sendiri saat masuk, sehingga sandi yang Anda serahkan hanya bisa dipakai untuk menggantikan dirinya sendiri",
                  wide: true,
                },
              ]}
            />
          </ConfirmDialog>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// A new account
// ---------------------------------------------------------------------------

function FormPenggunaBaru({
  peran,
  cabang,
  cabangAwal,
  onTerbit,
  onBatal,
}: {
  peran: readonly PeranTersedia[];
  cabang: readonly CabangRow[];
  cabangAwal: string;
  onTerbit: (hasil: HasilSandiSementara, nama: string) => void;
  onBatal: () => void;
}) {
  const [username, setUsername] = useState("");
  const [nama, setNama] = useState("");
  const [email, setEmail] = useState("");
  const [nip, setNip] = useState("");
  const [cabangId, setCabangId] = useState(
    cabang.some((row) => row.id === cabangAwal) ? cabangAwal : (cabang[0]?.id ?? ""),
  );
  const [dipilihPeran, setDipilihPeran] = useState<readonly string[]>([]);
  const [konfirmasi, setKonfirmasi] = useState(false);

  const kirim = useAction(buatPengguna);

  const siap =
    username.trim() !== "" &&
    nama.trim() !== "" &&
    email.trim() !== "" &&
    cabangId !== "" &&
    dipilihPeran.length > 0;

  const namaCabang = cabang.find((row) => row.id === cabangId);

  return (
    <Panel
      as="h2"
      title="Akun baru"
      description="Nama pengguna hanya bisa ditetapkan sekarang, dan tidak dapat diubah setelah akun tersimpan."
      aside={
        <Button variant="ghost" size="sm" onClick={onBatal}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/organisasi/pengguna. Sandi awal dibentuk server dan hanya dijawab satu
          kali; jawabannya ditandai no-store supaya tidak tersimpan di proxy atau peramban.
        </span>
      }
    >
      <FieldGrid>
        <Field
          label="Nama pengguna"
          htmlFor="usr-baru-username"
          required
          hint="3 sampai 50 karakter huruf kecil, angka, titik, garis bawah, atau strip. Tidak dapat diubah lagi."
        >
          <TextInput
            id="usr-baru-username"
            autoComplete="off"
            maxLength={50}
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value.toLowerCase())}
          />
        </Field>
        <Field label="Nama lengkap" htmlFor="usr-baru-nama" required>
          <TextInput
            id="usr-baru-nama"
            maxLength={200}
            value={nama}
            onChange={(event) => setNama(event.currentTarget.value)}
          />
        </Field>
        <Field label="Surel" htmlFor="usr-baru-email" required>
          <TextInput
            id="usr-baru-email"
            type="email"
            autoComplete="off"
            maxLength={200}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>
        <Field label="NIP" htmlFor="usr-baru-nip">
          <TextInput
            id="usr-baru-nip"
            maxLength={50}
            value={nip}
            onChange={(event) => setNip(event.currentTarget.value)}
          />
        </Field>
        <Field
          label="Cabang"
          htmlFor="usr-baru-cabang"
          required
          hint="Membatasi seluruh data yang bisa dibaca akun ini, kecuali perannya lintas cabang."
        >
          <Select
            id="usr-baru-cabang"
            value={cabangId}
            onChange={(event) => setCabangId(event.currentTarget.value)}
            options={cabang.map((row) => ({ value: row.id, label: `${row.kode} ${row.nama}` }))}
          />
        </Field>
      </FieldGrid>

      <div className="blok-aksi">
        <h3 className="blok-judul">Peran</h3>
        <p className="blok-sub">
          Sebuah akun harus punya sekurang kurangnya satu peran. Peran yang tidak dapat Anda
          berikan ditandai beserta alasan dari server.
        </p>
        <ul className="peran-list">
          {peran.map((item) => {
            const terkunci = !item.dapatDiberikan;
            return (
              <li className={terkunci ? "peran-item is-tertahan" : "peran-item"} key={item.kode}>
                <label className="peran-kotak" htmlFor={`peran-baru-${item.kode}`}>
                  <input
                    id={`peran-baru-${item.kode}`}
                    type="checkbox"
                    checked={dipilihPeran.includes(item.kode)}
                    disabled={terkunci}
                    onChange={(event) =>
                      setDipilihPeran((sebelum) =>
                        event.currentTarget.checked
                          ? [...sebelum, item.kode]
                          : sebelum.filter((kode) => kode !== item.kode),
                      )
                    }
                  />
                  <span className="peran-teks">
                    <span className="peran-nama">{item.nama}</span>
                    <span className="peran-sifat">
                      {item.lintasCabang ? "Lintas cabang" : "Terikat satu cabang"}
                      {item.readOnly ? ", hanya baca" : ""}
                    </span>
                  </span>
                </label>
                {terkunci && item.alasan ? <p className="peran-alasan">{item.alasan}</p> : null}
              </li>
            );
          })}
        </ul>
      </div>

      <Penolakan pesan={kirim.error} />

      <div className="form-actions-row">
        <Button variant="ghost" onClick={onBatal}>
          Batal
        </Button>
        <Button variant="primary" disabled={!siap} onClick={() => setKonfirmasi(true)}>
          Terbitkan akun
        </Button>
      </div>

      <ConfirmDialog
        open={konfirmasi}
        title={`Terbitkan akun ${username.trim()}`}
        description="Sandi awal akan ditampilkan satu kali saja, tepat setelah ini, dan tidak bisa ditampilkan lagi setelah Anda menutupnya."
        confirmLabel="Terbitkan akun"
        loading={kirim.status === "mengirim"}
        error={kirim.error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={() => {
          setKonfirmasi(false);
          void kirim
            .jalankan({
              username: username.trim(),
              nama: nama.trim(),
              email: email.trim(),
              nip: nip.trim() === "" ? null : nip.trim(),
              cabangId,
              peran: dipilihPeran.map((kode) => ({ kode })),
            })
            .then((hasil) => {
              if (hasil) onTerbit(hasil, hasil.nama);
            });
        }}
      >
        <DataList
          items={[
            { label: "Nama pengguna", value: username.trim() },
            { label: "Nama lengkap", value: nama.trim() },
            { label: "Surel", value: email.trim() },
            { label: "Cabang", value: namaCabang ? `${namaCabang.kode} ${namaCabang.nama}` : "belum dipilih" },
            { label: "Peran", value: dipilihPeran.join(", "), wide: true },
          ]}
        />
      </ConfirmDialog>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The one time password
// ---------------------------------------------------------------------------

/**
 * Shown once, on a page that holds nothing else.
 *
 * IT IS DISMISSED EXPLICITLY, and the only control says what dismissing costs.
 * Nothing re-renders this from a later read, because no later read carries the
 * value: the server stores an argon2id hash and nothing else, and the account
 * carries `harus_ganti_sandi` so the value can only ever be used to replace
 * itself.
 */
function SandiSekali({ sandi, onSelesai }: { sandi: SandiTampil; onSelesai: () => void }) {
  const toast = useToast();
  const [ditutup, setDitutup] = useState(false);

  if (ditutup) {
    return (
      <Panel as="h2" title="Sandi sementara sudah ditutup">
        <p className="peringatan-teks">
          Sandi sementara tidak ditampilkan lagi dan tidak bisa dibaca kembali dari mana pun. Bila
          sandi itu belum sempat diserahkan kepada pemiliknya, terbitkan sandi sementara sekali lagi
          dari halaman akun untuk mendapatkan sandi baru.
        </p>
        <div className="form-actions-row">
          <Button variant="primary" onClick={onSelesai}>
            Kembali ke daftar pengguna
          </Button>
        </div>
      </Panel>
    );
  }

  async function salin() {
    try {
      await navigator.clipboard?.writeText(sandi.hasil.sandiSementara);
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
      description="Serahkan sandi ini kepada pemiliknya sekarang juga. Setelah panel ini ditutup, tidak ada cara apa pun untuk menampilkannya kembali."
      className="panel-sandi"
      footer={
        <span className="panel-foot-note">
          Sumber:{" "}
          {sandi.asal === "BARU"
            ? "POST /api/organisasi/pengguna"
            : "POST /api/organisasi/pengguna/:id/sandi-sementara"}
          . Jawaban ditandai no-store, jadi tidak tersimpan di proxy maupun peramban.
        </span>
      }
    >
      <p className="periksa-item">
        <Icon name="alert" size={16} />
        <span>
          Seluruh daftar pengguna sengaja ditutup selama panel ini terbuka. Membuka akun lain akan
          menghilangkan satu satunya salinan sandi yang sedang Anda pegang, dan menerbitkan ulang
          akan membentuk sandi baru yang membuat sandi ini tidak berlaku lagi.
        </span>
      </p>

      <DataList
        items={[
          {
            label: sandi.asal === "BARU" ? "Akun yang baru diterbitkan" : "Akun yang sandinya diatur ulang",
            value: `${sandi.hasil.username} . ${sandi.nama}`,
            wide: true,
          },
          {
            label: "Sandi sementara",
            value: <code className="sandi-nilai">{sandi.hasil.sandiSementara}</code>,
            wide: true,
          },
        ]}
      />

      <p className="peringatan-teks">
        Sandi ini tidak disimpan dalam bentuk terbaca di basis data, tidak dicatat pada audit log,
        dan tidak dikirim lewat surel oleh sistem. Akun ini wajib mengganti sandinya sendiri saat
        masuk pertama kali, sehingga sandi di atas hanya bisa dipakai untuk menggantikan dirinya
        sendiri.
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
