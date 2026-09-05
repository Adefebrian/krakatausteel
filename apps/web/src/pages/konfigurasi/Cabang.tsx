// Master Cabang, spec 9.4. The unit that bounds every user's data scope.
//
// A BRANCH CODE IS NEVER RENUMBERED, and this screen never draws it as an
// input. `cabang.kode` is printed inside every document number the branch has
// ever issued (`nomor_urut.format_template`), so changing it silently re-parents
// a decade of paper. The router refuses it with exactly that reason; the screen
// says it before anyone types.
//
// HEAD OFFICE STATUS IS ALSO FIXED. One entity has exactly one kantor pusat, and
// the flag is not moved by editing a branch: the head office carries the top
// level numbering series and the heading of every report. The router refuses
// `isPusat` on a PATCH, and refuses deactivating the head office at all.
//
// DEACTIVATION IS REFUSED WHILE THE BRANCH STILL HAS ACTIVE USERS, with a count
// in the sentence. That refusal is NOT precomputed here, deliberately: this
// screen has no endpoint that counts a branch's users (GET /organisasi/pengguna
// is behind `konfigurasi.user`, which the head office master editor does not
// necessarily hold), so guessing would be worse than asking. The control is
// offered, the server answers with the count, and the answer is rendered where
// the click happened.
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
  Textarea,
  formatCount,
} from "@krakatausteel/ui";
import {
  buatCabang,
  daftarCabang,
  setAktifCabang,
  ubahCabang,
  type CabangRow,
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

export function Cabang({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const bolehTulis = hasPermission(session.permissions, "konfigurasi.master") && !session.readOnly;

  const daftar = useApi(() => daftarCabang(), []);
  const [cari, setCari] = useState("");
  const [status, setStatus] = useState("");
  const [dipilihId, setDipilihId] = useState<string | null>(null);
  const [formBaru, setFormBaru] = useState(false);

  const rows = daftar.data?.data ?? [];
  const dipilih = rows.find((row) => row.id === dipilihId) ?? null;
  const adaPusat = rows.some((row) => row.is_pusat);

  const terpilih = useMemo(() => {
    const teks = cari.trim().toLowerCase();
    return rows.filter((row) => {
      if (status === "AKTIF" && !row.aktif) return false;
      if (status === "NONAKTIF" && row.aktif) return false;
      if (teks === "") return true;
      return `${row.kode} ${row.nama} ${row.alamat ?? ""}`.toLowerCase().includes(teks);
    });
  }, [rows, cari, status]);

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
            {formBaru ? "Tutup formulir cabang baru" : "Cabang baru"}
          </Button>
        ) : undefined
      }
    >
      <Muat hasil={daftar} judul="daftar cabang" sumber="GET /api/organisasi/cabang">
        {(data) => (
          <>
            <PapanAngka
              items={[
                {
                  label: "Seluruh cabang",
                  nilai: formatCount(data.data.length),
                  satuan: "Cabang",
                  catatan: "Yang terbaca dalam wewenang Anda.",
                },
                {
                  label: "Aktif",
                  nilai: formatCount(data.data.filter((row) => row.aktif).length),
                  satuan: "Cabang",
                  catatan: "Bisa menerima pengguna dan dokumen baru.",
                },
                {
                  label: "Nonaktif",
                  nilai: formatCount(data.data.filter((row) => !row.aktif).length),
                  satuan: "Cabang",
                  catatan: "Riwayat dan laporannya tetap terbaca.",
                },
                {
                  label: "Kantor pusat",
                  nilai: formatCount(data.data.filter((row) => row.is_pusat).length),
                  satuan: "Cabang",
                  catatan: "Satu entitas hanya boleh punya satu.",
                },
              ]}
            />

            {bolehTulis ? null : (
              <Panel as="h2" title="Halaman ini terbuka untuk dibaca">
                <TanpaWewenang
                  izin="konfigurasi.master"
                  tindakan="menambah cabang, mengubah datanya, atau menonaktifkannya"
                />
              </Panel>
            )}

            {formBaru && bolehTulis ? (
              <FormCabangBaru
                adaPusat={adaPusat}
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
              title="Cabang"
              description="Pilih satu cabang untuk mengubah nama dan alamatnya, atau menonaktifkannya."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/organisasi/cabang. {formatCount(terpilih.length)} dari{" "}
                  {formatCount(data.data.length)} cabang ditampilkan.
                </span>
              }
            >
              <div className="filterbar" role="search">
                <div className="filterbar-group is-grow">
                  <span className="filterbar-label">Cari cabang</span>
                  <SearchInput
                    label="Cari cabang berdasarkan kode, nama, atau alamat"
                    placeholder="Kode, nama, atau alamat"
                    value={cari}
                    onChange={(event) => setCari(event.currentTarget.value)}
                  />
                </div>
                <div className="filterbar-group">
                  <span className="filterbar-label">Status</span>
                  <Select
                    aria-label="Status cabang"
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
                  judul: `${row.kode} ${row.nama}`,
                  sub: row.alamat ?? "alamat belum diisi",
                  status: (
                    <StatusBadge
                      status={row.aktif ? "AKTIF" : "NONAKTIF"}
                      tone={row.aktif ? "success" : "neutral"}
                      label={row.aktif ? "Aktif" : "Nonaktif"}
                    />
                  ),
                  meta: row.is_pusat ? "Kantor pusat" : "Cabang",
                })}
                onPilih={(row) => {
                  setFormBaru(false);
                  setDipilihId((sebelum) => (sebelum === row.id ? null : row.id));
                }}
                emptyTitle="Tidak ada cabang yang cocok"
                emptyDescription="Ubah kata kunci pencarian atau status yang ditampilkan."
                caption="Cabang dalam wewenang Anda"
              />
            </Panel>

            {dipilih ? (
              <DetailCabang
                key={dipilih.id}
                cabang={dipilih}
                bolehTulis={bolehTulis}
                onBerubah={() => daftar.reload()}
                onTutup={() => setDipilihId(null)}
              />
            ) : null}

            <PenjelasanTanpaHapus
              subjek="Cabang"
              dipakai="Setiap nomor dokumen yang pernah terbit, setiap pengguna, dan setiap jurnal"
              tambahan="Kode cabang dan status kantor pusat tidak pernah bisa diubah. Server juga menolak menonaktifkan kantor pusat, dan menolak menonaktifkan cabang yang masih punya pengguna aktif."
            />
          </>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Menambah dan mengubah cabang memerlukan kewenangan konfigurasi.master, yang dipegang Admin Pusat." />
    </HalamanModul>
  );
}

const KOLOM: readonly ColumnSpec<CabangRow>[] = [
  { key: "kode", header: "Kode", sortable: true, width: "120px" },
  { key: "nama", header: "Nama cabang", sortable: true },
  { key: "alamat", header: "Alamat", render: (row) => row.alamat ?? "belum diisi" },
  {
    key: "is_pusat",
    header: "Peran",
    width: "140px",
    render: (row) => (row.is_pusat ? "Kantor pusat" : "Cabang"),
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

function DetailCabang({
  cabang,
  bolehTulis,
  onBerubah,
  onTutup,
}: {
  cabang: CabangRow;
  bolehTulis: boolean;
  onBerubah: () => void;
  onTutup: () => void;
}) {
  const [nama, setNama] = useState(cabang.nama);
  const [alamat, setAlamat] = useState(cabang.alamat ?? "");

  const simpan = useAction((body: { nama: string; alamat: string | null }) =>
    ubahCabang(cabang.id, body),
  );
  const status = useAction((aktif: boolean) => setAktifCabang(cabang.id, aktif));

  const berubah = nama.trim() !== cabang.nama || alamat.trim() !== (cabang.alamat ?? "");

  return (
    <Panel
      as="h2"
      title={`${cabang.kode} ${cabang.nama}`}
      description="Yang di atas tidak dapat diubah, yang di bawah dapat."
      aside={
        <Button variant="ghost" size="sm" onClick={onTutup}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: PATCH /api/organisasi/cabang/{cabang.id.slice(0, 8)} dan POST
          /api/organisasi/cabang/{cabang.id.slice(0, 8)}/status.
        </span>
      }
    >
      <FaktaTetap
        items={[
          {
            label: "Kode cabang",
            value: cabang.kode,
            alasan:
              "Kode ini sudah tercetak di setiap nomor dokumen yang pernah diterbitkan cabang ini. Menggantinya membuat dokumen lama menunjuk cabang yang berbeda.",
          },
          {
            label: "Peran cabang",
            value: cabang.is_pusat ? "Kantor pusat" : "Cabang",
            alasan:
              "Status kantor pusat tidak dapat dipindahkan lewat perubahan data cabang: seri penomoran tingkat pusat dan kepala setiap laporan menggantung padanya.",
          },
        ]}
      />

      {bolehTulis ? (
        <>
          <FieldGrid>
            <Field label="Nama cabang" htmlFor={`cabang-nama-${cabang.id}`} required>
              <TextInput
                id={`cabang-nama-${cabang.id}`}
                maxLength={200}
                value={nama}
                onChange={(event) => setNama(event.currentTarget.value)}
              />
            </Field>
            <Field label="Alamat" htmlFor={`cabang-alamat-${cabang.id}`}>
              <Textarea
                id={`cabang-alamat-${cabang.id}`}
                rows={3}
                maxLength={500}
                value={alamat}
                onChange={(event) => setAlamat(event.currentTarget.value)}
              />
            </Field>
          </FieldGrid>

          <Penolakan pesan={simpan.error} />
          <Berhasil pesan={simpan.hasil ? "Perubahan cabang tersimpan dan tercatat pada audit trail." : null} />

          <div className="form-actions-row">
            <Button
              variant="primary"
              disabled={!berubah || nama.trim() === ""}
              loading={simpan.status === "mengirim"}
              onClick={() => {
                void simpan
                  .jalankan({ nama: nama.trim(), alamat: alamat.trim() === "" ? null : alamat.trim() })
                  .then((hasil) => {
                    if (hasil) onBerubah();
                  });
              }}
            >
              Simpan perubahan
            </Button>
          </div>

          <KendaliStatus
            aktif={cabang.aktif}
            subjek={`cabang ${cabang.kode} ${cabang.nama}`}
            akibat={[
              "Cabang ini tidak bisa lagi menerima pengguna baru.",
              "Cabang ini hilang dari pilihan cabang pada formulir baru.",
            ]}
            bukanAkibat={[
              "Dokumen, jurnal, dan laporan cabang ini tetap terbaca apa adanya.",
              "Nomor dokumen yang sudah terbit tetap sah dan tidak dipakai ulang.",
              "Pengguna yang masih aktif di cabang ini tidak ikut dinonaktifkan, dan justru menahan penonaktifan sampai ditangani lebih dulu.",
            ]}
            tertahan={
              cabang.is_pusat
                ? "Kantor pusat tidak dapat dinonaktifkan: seri penomoran tingkat pusat dan kepala setiap laporan menggantung padanya."
                : null
            }
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
        <TanpaWewenang izin="konfigurasi.master" tindakan="mengubah atau menonaktifkan cabang ini" />
      )}
    </Panel>
  );
}

function FormCabangBaru({
  adaPusat,
  onSelesai,
  onBatal,
}: {
  adaPusat: boolean;
  onSelesai: (baru: CabangRow) => void;
  onBatal: () => void;
}) {
  const [kode, setKode] = useState("");
  const [nama, setNama] = useState("");
  const [alamat, setAlamat] = useState("");
  const [isPusat, setIsPusat] = useState(false);
  const kirim = useAction(buatCabang);

  const siap = kode.trim() !== "" && nama.trim() !== "";

  return (
    <Panel
      as="h2"
      title="Cabang baru"
      description="Kode cabang hanya bisa ditetapkan sekarang. Setelah tersimpan, kode itu masuk ke setiap nomor dokumen cabang ini dan tidak dapat diubah lagi."
      aside={
        <Button variant="ghost" size="sm" onClick={onBatal}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/organisasi/cabang. Keunikan kode dan aturan satu kantor pusat per
          entitas divalidasi ulang di server.
        </span>
      }
    >
      <FieldGrid>
        <Field
          label="Kode cabang"
          htmlFor="cabang-baru-kode"
          required
          hint="1 sampai 10 karakter huruf besar atau angka. Kode ini akan tercetak pada setiap nomor dokumen cabang."
        >
          <TextInput
            id="cabang-baru-kode"
            maxLength={10}
            value={kode}
            onChange={(event) => setKode(event.currentTarget.value.toUpperCase())}
          />
        </Field>
        <Field label="Nama cabang" htmlFor="cabang-baru-nama" required>
          <TextInput
            id="cabang-baru-nama"
            maxLength={200}
            value={nama}
            onChange={(event) => setNama(event.currentTarget.value)}
          />
        </Field>
        <Field label="Alamat" htmlFor="cabang-baru-alamat">
          <Textarea
            id="cabang-baru-alamat"
            rows={3}
            maxLength={500}
            value={alamat}
            onChange={(event) => setAlamat(event.currentTarget.value)}
          />
        </Field>
      </FieldGrid>

      <div className="sifat-list">
        <div className={adaPusat ? "sifat-item is-tertahan" : "sifat-item"}>
          <label className="sifat-kotak" htmlFor="cabang-baru-pusat">
            <input
              id="cabang-baru-pusat"
              type="checkbox"
              checked={isPusat}
              disabled={adaPusat}
              onChange={(event) => setIsPusat(event.currentTarget.checked)}
            />
            <span className="sifat-teks">
              <span className="sifat-label">Jadikan kantor pusat</span>
              <span className="sifat-arti">
                Kantor pusat memegang seri penomoran tingkat pusat dan menjadi kepala setiap
                laporan.
              </span>
            </span>
          </label>
          {adaPusat ? (
            <p className="sifat-alasan">
              Entitas ini sudah punya kantor pusat, dan satu entitas hanya boleh punya satu. Status
              itu tidak dapat dipindahkan lewat halaman ini.
            </p>
          ) : null}
        </div>
      </div>

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
                kode: kode.trim(),
                nama: nama.trim(),
                alamat: alamat.trim() === "" ? null : alamat.trim(),
                isPusat: isPusat && !adaPusat,
              })
              .then((hasil) => {
                if (hasil) onSelesai(hasil);
              });
          }}
        >
          Simpan cabang baru
        </Button>
      </div>
    </Panel>
  );
}
