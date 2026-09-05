// Master Karyawan, spec 9.4. The people named as surveyor, collection officer
// and document owner on records that are already posted.
//
// AN EMPLOYEE IS NOT A USER ACCOUNT, and this screen does not pretend otherwise.
// `karyawan` is a roster of people; `app_user` is a set of credentials. The API
// has no column linking the two and no endpoint that answers "which account
// belongs to this employee", so this page never claims one. The nav entry
// promises a link to the application account "bila ada"; there is no such field
// on the wire, and the page says so instead of showing an empty column that
// reads as "no account".
//
// NOTHING IS DELETED. An employee is the named surveyor on a survey that a
// journal was posted from, so removing the row would leave a posted document
// pointing at nobody. Deactivation takes them out of every picker and changes
// no history, which is what the panel below says in words.
//
// THE NIP IS UNIQUE AND IS EDITABLE, unlike every other identifier on this
// surface. That is the server's choice, not an oversight here: `nip` is
// nullable, is not a foreign key, and a corrected staff number is an ordinary
// correction. A collision is refused by the server with the number in the
// sentence, and that sentence is rendered on the field.
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  Icon,
  Panel,
  SearchInput,
  Select,
  StatusBadge,
  TextInput,
  formatCount,
} from "@krakatausteel/ui";
import {
  buatKaryawan,
  daftarCabang,
  daftarKaryawan,
  setAktifKaryawan,
  ubahKaryawan,
  type CabangRow,
  type KaryawanRow,
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
  useLingkupCabang,
  type ColumnSpec,
} from "../shared/parts";
import {
  Berhasil,
  KendaliStatus,
  PapanAngka,
  Penolakan,
  PenjelasanTanpaHapus,
  TanpaWewenang,
} from "./parts";

const OPSI_STATUS = [
  { value: "", label: "Aktif dan nonaktif" },
  { value: "AKTIF", label: "Aktif saja" },
  { value: "NONAKTIF", label: "Nonaktif saja" },
];

export function Karyawan({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const bolehTulis = hasPermission(session.permissions, "konfigurasi.master") && !session.readOnly;
  const lingkup = useLingkupCabang("Cabang penempatan");

  const daftar = useApi(() => daftarKaryawan(lingkup.cabangId), [lingkup.cabangId]);
  const cabang = useApi(() => daftarCabang(), []);

  const [cari, setCari] = useState("");
  const [status, setStatus] = useState("");
  const [dipilihId, setDipilihId] = useState<string | null>(null);
  const [formBaru, setFormBaru] = useState(false);

  const rows = daftar.data?.data ?? [];
  const dipilih = rows.find((row) => row.id === dipilihId) ?? null;
  const daftarCabangAktif = (cabang.data?.data ?? []).filter((row) => row.aktif);

  const namaCabang = useMemo(() => {
    const peta = new Map<string, string>();
    for (const row of cabang.data?.data ?? []) peta.set(row.id, `${row.kode} ${row.nama}`);
    return peta;
  }, [cabang.data]);

  const terpilih = useMemo(() => {
    const teks = cari.trim().toLowerCase();
    return rows.filter((row) => {
      if (status === "AKTIF" && !row.aktif) return false;
      if (status === "NONAKTIF" && row.aktif) return false;
      if (teks === "") return true;
      return `${row.nama} ${row.nip ?? ""} ${row.jabatan ?? ""} ${row.unit ?? ""}`
        .toLowerCase()
        .includes(teks);
    });
  }, [rows, cari, status]);

  const kolom: readonly ColumnSpec<KaryawanRow>[] = useMemo(
    () => [
      { key: "nip", header: "NIP", sortable: true, width: "140px", render: (row) => row.nip ?? "belum diisi" },
      { key: "nama", header: "Nama karyawan", sortable: true },
      { key: "jabatan", header: "Jabatan", render: (row) => row.jabatan ?? "belum diisi" },
      { key: "unit", header: "Unit", render: (row) => row.unit ?? "belum diisi" },
      {
        key: "cabang_id",
        header: "Cabang",
        width: "180px",
        render: (row) => namaCabang.get(row.cabang_id) ?? "di luar wewenang Anda",
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
    ],
    [namaCabang],
  );

  return (
    <HalamanModul
      route={route}
      actions={
        bolehTulis ? (
          <Button
            variant="primary"
            leading={<Icon name="plus" size={16} />}
            onClick={() => {
              setFormBaru((buka) => !buka);
              setDipilihId(null);
            }}
          >
            {formBaru ? "Tutup formulir karyawan baru" : "Karyawan baru"}
          </Button>
        ) : undefined
      }
    >
      <Muat hasil={daftar} judul="daftar karyawan" sumber="GET /api/organisasi/karyawan">
        {(data) => (
          <>
            <PapanAngka
              items={[
                {
                  label: "Seluruh karyawan",
                  nilai: formatCount(data.data.length),
                  satuan: "Orang",
                  catatan: lingkup.ringkas,
                },
                {
                  label: "Aktif",
                  nilai: formatCount(data.data.filter((row) => row.aktif).length),
                  satuan: "Orang",
                  catatan: "Bisa dipilih sebagai petugas pada dokumen baru.",
                },
                {
                  label: "Nonaktif",
                  nilai: formatCount(data.data.filter((row) => !row.aktif).length),
                  satuan: "Orang",
                  catatan: "Namanya tetap tercantum pada dokumen lama.",
                },
                {
                  label: "Tanpa NIP",
                  nilai: formatCount(data.data.filter((row) => row.nip === null).length),
                  satuan: "Orang",
                  catatan: "NIP boleh kosong, dan harus unik bila diisi.",
                },
              ]}
            />

            {bolehTulis ? null : (
              <Panel as="h2" title="Halaman ini terbuka untuk dibaca">
                <TanpaWewenang
                  izin="konfigurasi.master"
                  tindakan="menambah karyawan, mengubah datanya, atau menonaktifkannya"
                />
              </Panel>
            )}

            {formBaru && bolehTulis ? (
              <FormKaryawanBaru
                cabang={daftarCabangAktif}
                cabangAwal={lingkup.cabangId ?? session.cabang.id}
                onSelesai={(baru) => {
                  setFormBaru(false);
                  setDipilihId(baru.id);
                  daftar.reload();
                }}
                onBatal={() => setFormBaru(false)}
              />
            ) : null}

            <Panel
              as="h2"
              title="Karyawan"
              description="Pilih satu karyawan untuk mengubah datanya atau menonaktifkannya."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/organisasi/karyawan. {formatCount(terpilih.length)} dari{" "}
                  {formatCount(data.data.length)} karyawan ditampilkan.
                </span>
              }
            >
              <div className="filterbar" role="search">
                <div className="filterbar-group is-grow">
                  <span className="filterbar-label">Cari karyawan</span>
                  <SearchInput
                    label="Cari karyawan berdasarkan nama, NIP, jabatan, atau unit"
                    placeholder="Nama, NIP, jabatan, atau unit"
                    value={cari}
                    onChange={(event) => setCari(event.currentTarget.value)}
                  />
                </div>
                {lingkup.kontrol}
                <div className="filterbar-group">
                  <span className="filterbar-label">Status</span>
                  <Select
                    aria-label="Status karyawan"
                    value={status}
                    onChange={(event) => setStatus(event.currentTarget.value)}
                    options={OPSI_STATUS}
                  />
                </div>
              </div>

              <DaftarDokumen
                columns={kolom}
                rows={terpilih}
                rowKey={(row) => row.id}
                kartu={(row) => ({
                  judul: row.nama,
                  sub: `${row.nip ?? "tanpa NIP"} . ${row.jabatan ?? "tanpa jabatan"}`,
                  status: (
                    <StatusBadge
                      status={row.aktif ? "AKTIF" : "NONAKTIF"}
                      tone={row.aktif ? "success" : "neutral"}
                      label={row.aktif ? "Aktif" : "Nonaktif"}
                    />
                  ),
                  meta: namaCabang.get(row.cabang_id) ?? "cabang di luar wewenang Anda",
                })}
                onPilih={(row) => {
                  setFormBaru(false);
                  setDipilihId((sebelum) => (sebelum === row.id ? null : row.id));
                }}
                emptyTitle="Tidak ada karyawan yang cocok"
                emptyDescription="Ubah kata kunci pencarian, cabang, atau status yang ditampilkan."
                caption="Karyawan pada cabang terpilih"
              />
            </Panel>

            {dipilih ? (
              <DetailKaryawan
                key={dipilih.id}
                karyawan={dipilih}
                cabang={daftarCabangAktif}
                bolehTulis={bolehTulis}
                onBerubah={() => daftar.reload()}
                onTutup={() => setDipilihId(null)}
              />
            ) : null}

            <Panel as="h2" title="Karyawan dan akun aplikasi adalah dua daftar yang berbeda">
              <p className="penjelasan">
                Data karyawan adalah daftar orang yang namanya dicantumkan sebagai surveyor, petugas
                penagihan, dan penanggung jawab dokumen. Akun aplikasi adalah kredensial untuk masuk,
                dan dikelola di halaman Pengguna dan Role. Server tidak menyimpan tautan antara
                keduanya dan tidak punya endpoint yang bisa menjawabnya, jadi halaman ini tidak
                menampilkan kolom akun. Menampilkan tebakan di situ akan menjadi pernyataan tentang
                hak akses yang tidak diverifikasi siapa pun.
              </p>
            </Panel>

            <PenjelasanTanpaHapus
              subjek="Karyawan"
              dipakai="Hasil survey, tindak lanjut penagihan, dan dokumen yang sudah terbit"
            />
          </>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Menambah dan mengubah karyawan memerlukan kewenangan konfigurasi.master, dan scope cabang tetap diperiksa ulang di server." />
    </HalamanModul>
  );
}

function DetailKaryawan({
  karyawan,
  cabang,
  bolehTulis,
  onBerubah,
  onTutup,
}: {
  karyawan: KaryawanRow;
  cabang: readonly CabangRow[];
  bolehTulis: boolean;
  onBerubah: () => void;
  onTutup: () => void;
}) {
  const [nama, setNama] = useState(karyawan.nama);
  const [nip, setNip] = useState(karyawan.nip ?? "");
  const [jabatan, setJabatan] = useState(karyawan.jabatan ?? "");
  const [unit, setUnit] = useState(karyawan.unit ?? "");
  const [cabangId, setCabangId] = useState(karyawan.cabang_id);

  const simpan = useAction((body: Parameters<typeof ubahKaryawan>[1]) =>
    ubahKaryawan(karyawan.id, body),
  );
  const status = useAction((aktif: boolean) => setAktifKaryawan(karyawan.id, aktif));

  const berubah =
    nama.trim() !== karyawan.nama ||
    nip.trim() !== (karyawan.nip ?? "") ||
    jabatan.trim() !== (karyawan.jabatan ?? "") ||
    unit.trim() !== (karyawan.unit ?? "") ||
    cabangId !== karyawan.cabang_id;

  return (
    <Panel
      as="h2"
      title={karyawan.nama}
      description="Seluruh data karyawan dapat diperbaiki. Yang tidak bisa dilakukan adalah menghapusnya."
      aside={
        <Button variant="ghost" size="sm" onClick={onTutup}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: PATCH /api/organisasi/karyawan/{karyawan.id.slice(0, 8)} dan POST
          /api/organisasi/karyawan/{karyawan.id.slice(0, 8)}/status.
        </span>
      }
    >
      {bolehTulis ? (
        <>
          <FieldGrid>
            <Field label="Nama karyawan" htmlFor={`kar-nama-${karyawan.id}`} required>
              <TextInput
                id={`kar-nama-${karyawan.id}`}
                maxLength={200}
                value={nama}
                onChange={(event) => setNama(event.currentTarget.value)}
              />
            </Field>
            <Field
              label="NIP"
              htmlFor={`kar-nip-${karyawan.id}`}
              hint="Boleh kosong. Bila diisi, harus unik di seluruh entitas."
            >
              <TextInput
                id={`kar-nip-${karyawan.id}`}
                maxLength={50}
                value={nip}
                onChange={(event) => setNip(event.currentTarget.value)}
              />
            </Field>
            <Field label="Jabatan" htmlFor={`kar-jabatan-${karyawan.id}`}>
              <TextInput
                id={`kar-jabatan-${karyawan.id}`}
                maxLength={100}
                value={jabatan}
                onChange={(event) => setJabatan(event.currentTarget.value)}
              />
            </Field>
            <Field label="Unit" htmlFor={`kar-unit-${karyawan.id}`}>
              <TextInput
                id={`kar-unit-${karyawan.id}`}
                maxLength={100}
                value={unit}
                onChange={(event) => setUnit(event.currentTarget.value)}
              />
            </Field>
            <Field
              label="Cabang penempatan"
              htmlFor={`kar-cabang-${karyawan.id}`}
              required
              hint="Hanya cabang aktif dalam wewenang Anda. Server memeriksa scope ini lagi."
            >
              <Select
                id={`kar-cabang-${karyawan.id}`}
                value={cabangId}
                onChange={(event) => setCabangId(event.currentTarget.value)}
                options={cabang.map((row) => ({ value: row.id, label: `${row.kode} ${row.nama}` }))}
              />
            </Field>
          </FieldGrid>

          <Penolakan pesan={simpan.error} />
          <Berhasil pesan={simpan.hasil ? "Perubahan karyawan tersimpan dan tercatat pada audit trail." : null} />

          <div className="form-actions-row">
            <Button
              variant="primary"
              disabled={!berubah || nama.trim() === ""}
              loading={simpan.status === "mengirim"}
              onClick={() => {
                void simpan
                  .jalankan({
                    nama: nama.trim(),
                    nip: nip.trim() === "" ? null : nip.trim(),
                    jabatan: jabatan.trim() === "" ? null : jabatan.trim(),
                    unit: unit.trim() === "" ? null : unit.trim(),
                    cabangId,
                  })
                  .then((hasil) => {
                    if (hasil) onBerubah();
                  });
              }}
            >
              Simpan perubahan
            </Button>
          </div>

          <KendaliStatus
            aktif={karyawan.aktif}
            subjek={`karyawan ${karyawan.nama}`}
            akibat={[
              "Nama ini hilang dari pilihan petugas pada survey dan penagihan baru.",
              "Nama ini hilang dari pilihan penanggung jawab dokumen baru.",
            ]}
            bukanAkibat={[
              "Survey dan penagihan yang sudah mencantumkan namanya tetap mencantumkannya.",
              "Akun aplikasi orang ini tidak ikut dinonaktifkan: akun dikelola di halaman Pengguna dan Role.",
            ]}
            tertahan={null}
            mengirim={status.status === "mengirim"}
            error={status.error}
            onUbah={(aktif) => {
              void status.jalankan(aktif).then((hasil) => {
                if (hasil) onBerubah();
              });
            }}
          />
        </>
      ) : (
        <TanpaWewenang izin="konfigurasi.master" tindakan="mengubah atau menonaktifkan karyawan ini" />
      )}
    </Panel>
  );
}

function FormKaryawanBaru({
  cabang,
  cabangAwal,
  onSelesai,
  onBatal,
}: {
  cabang: readonly CabangRow[];
  cabangAwal: string;
  onSelesai: (baru: KaryawanRow) => void;
  onBatal: () => void;
}) {
  const [nama, setNama] = useState("");
  const [nip, setNip] = useState("");
  const [jabatan, setJabatan] = useState("");
  const [unit, setUnit] = useState("");
  const [cabangId, setCabangId] = useState(
    cabang.some((row) => row.id === cabangAwal) ? cabangAwal : (cabang[0]?.id ?? ""),
  );
  const kirim = useAction(buatKaryawan);

  const siap = nama.trim() !== "" && cabangId !== "";

  return (
    <Panel
      as="h2"
      title="Karyawan baru"
      description="Menambahkan orang ke daftar petugas. Ini bukan akun untuk masuk aplikasi."
      aside={
        <Button variant="ghost" size="sm" onClick={onBatal}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/organisasi/karyawan. Keunikan NIP dan scope cabang divalidasi ulang di
          server.
        </span>
      }
    >
      <FieldGrid>
        <Field label="Nama karyawan" htmlFor="kar-baru-nama" required>
          <TextInput
            id="kar-baru-nama"
            maxLength={200}
            value={nama}
            onChange={(event) => setNama(event.currentTarget.value)}
          />
        </Field>
        <Field label="NIP" htmlFor="kar-baru-nip" hint="Boleh kosong. Bila diisi, harus unik.">
          <TextInput
            id="kar-baru-nip"
            maxLength={50}
            value={nip}
            onChange={(event) => setNip(event.currentTarget.value)}
          />
        </Field>
        <Field label="Jabatan" htmlFor="kar-baru-jabatan">
          <TextInput
            id="kar-baru-jabatan"
            maxLength={100}
            value={jabatan}
            onChange={(event) => setJabatan(event.currentTarget.value)}
          />
        </Field>
        <Field label="Unit" htmlFor="kar-baru-unit">
          <TextInput
            id="kar-baru-unit"
            maxLength={100}
            value={unit}
            onChange={(event) => setUnit(event.currentTarget.value)}
          />
        </Field>
        <Field label="Cabang penempatan" htmlFor="kar-baru-cabang" required>
          <Select
            id="kar-baru-cabang"
            value={cabangId}
            onChange={(event) => setCabangId(event.currentTarget.value)}
            options={cabang.map((row) => ({ value: row.id, label: `${row.kode} ${row.nama}` }))}
          />
        </Field>
      </FieldGrid>

      <Penolakan pesan={kirim.error} />

      <div className="form-actions-row">
        <Button variant="ghost" onClick={onBatal}>
          Batal
        </Button>
        <Button
          variant="primary"
          disabled={!siap}
          loading={kirim.status === "mengirim"}
          onClick={() => {
            void kirim
              .jalankan({
                cabangId,
                nama: nama.trim(),
                nip: nip.trim() === "" ? null : nip.trim(),
                jabatan: jabatan.trim() === "" ? null : jabatan.trim(),
                unit: unit.trim() === "" ? null : unit.trim(),
              })
              .then((hasil) => {
                if (hasil) onSelesai(hasil);
              });
          }}
        >
          Simpan karyawan baru
        </Button>
      </div>
    </Panel>
  );
}
