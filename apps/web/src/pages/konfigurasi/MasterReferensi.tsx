// The five master reference tables of spec 9.4: sektor, bidang, provinsi, kota
// and SDG. ONE screen, four nav entries, because the server is one endpoint.
//
// WHY ONE IMPLEMENTATION AND NOT FIVE. `/konfigurasi/master/:jenis` is a
// table-driven surface on the API for a stated reason: the five tables differ
// only in their columns, and the RULES are identical and are the hard part
// (pinned to the caller's entity where the table has one, deactivate never
// delete, key uniqueness inside its scope, an audit row carrying before and
// after). Five near-identical screens is five chances for one of them to drift
// into offering a delete or letting a key be edited.
//
// THE KEY COLUMN IS IMMUTABLE AND THE SERVER SAYS SO PER FIELD. `kode`,
// `kodeBps` and `nomor` are refused on a PATCH with "tidak dapat diubah setelah
// dibuat", because they are what a posted proposal, a grant and a journal refer
// the row back by. This screen renders them as fixed facts once the row exists,
// and as an ordinary required input only while the row is being created.
//
// THE ONE PLACE THE WIRE IS ASYMMETRIC, and it is handled in exactly one
// function. A GET answers rows keyed by COLUMN (`kode_bps`, `provinsi_id`); a
// POST and a PATCH take FIELD names (`kodeBps`, `provinsiId`). `FIELD_MASTER`
// in ../../api/konfigurasi.ts holds both names for every field and a test pins
// it against the server's own registry, so neither half is guessed at here.
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  Icon,
  Panel,
  SearchInput,
  Select,
  StatusBadge,
  TabPanel,
  Tabs,
  TextInput,
  formatCount,
} from "@krakatausteel/ui";
import {
  FIELD_MASTER,
  buatMaster,
  daftarJenisMaster,
  daftarMaster,
  setAktifMaster,
  ubahMaster,
  type BarisMaster,
  type FieldMasterUi,
} from "../../api/konfigurasi";
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

/** Everything a jenis needs beyond its fields, all of it presentation. */
interface ProfilMaster {
  jenis: string;
  judul: string;
  /** What already refers to a row of this table, in words. */
  dipakai: string;
  /** What deactivation removes the row from. */
  akibat: readonly string[];
}

const PROFIL: Record<string, ProfilMaster> = {
  sektor: {
    jenis: "sektor",
    judul: "Sektor Usaha PUMK",
    dipakai: "Proposal Pendanaan UMK, RKA PUMK, dan laporan penyaluran per sektor",
    akibat: ["Sektor ini hilang dari pilihan sektor pada proposal PUMK baru."],
  },
  bidang: {
    jenis: "bidang",
    judul: "Bidang Program Non PUMK",
    dipakai: "Proposal Non PUMK, RKA Non PUMK, dan rekap penyaluran per bidang",
    akibat: ["Bidang ini hilang dari pilihan bidang pada proposal Non PUMK baru."],
  },
  provinsi: {
    jenis: "provinsi",
    judul: "Provinsi",
    dipakai: "Alamat Mitra Binaan, kota di bawahnya, dan laporan penyaluran per wilayah",
    akibat: [
      "Provinsi ini hilang dari pilihan wilayah pada data Mitra Binaan baru.",
      "Kota di bawahnya tidak ikut nonaktif, dan dinonaktifkan satu per satu bila memang perlu.",
    ],
  },
  kota: {
    jenis: "kota",
    judul: "Kota dan Kabupaten",
    dipakai: "Alamat Mitra Binaan, alamat cabang, dan laporan penyaluran per wilayah",
    akibat: ["Kota ini hilang dari pilihan wilayah pada data Mitra Binaan baru."],
  },
  sdg: {
    jenis: "sdg",
    judul: "Tujuan Pembangunan Berkelanjutan",
    dipakai: "Pemetaan SDG pada program Non PUMK dan Laporan Pemetaan SDGs",
    akibat: ["Tujuan ini hilang dari pilihan SDG pada program Non PUMK baru."],
  },
};

const OPSI_STATUS = [
  { value: "", label: "Aktif dan nonaktif" },
  { value: "AKTIF", label: "Aktif saja" },
  { value: "NONAKTIF", label: "Nonaktif saja" },
];

export function MasterReferensi({
  route,
  jenis,
}: {
  route: PageRoute;
  /** One or more reference tables, shown as tabs when there is more than one. */
  jenis: readonly string[];
}) {
  const [aktif, setAktif] = useState(jenis[0] ?? "sektor");
  const pilihan = jenis.includes(aktif) ? aktif : (jenis[0] ?? "sektor");

  return (
    <HalamanModul route={route}>
      {jenis.length > 1 ? (
        <Tabs
          label="Tabel referensi"
          items={jenis.map((item) => ({ id: item, label: PROFIL[item]?.judul ?? item }))}
          active={pilihan}
          onChange={setAktif}
        />
      ) : null}
      {jenis.length > 1 ? (
        <TabPanel id={pilihan}>
          <SatuTabel key={pilihan} jenis={pilihan} />
        </TabPanel>
      ) : (
        <SatuTabel key={pilihan} jenis={pilihan} />
      )}
      <CatatanOtorisasi tambahan="Menambah dan mengubah data referensi memerlukan kewenangan konfigurasi.master, dan setiap perubahan tercatat pada audit trail beserta nilai lama dan nilai barunya." />
    </HalamanModul>
  );
}

function SatuTabel({ jenis }: { jenis: string }) {
  const session = useActiveSession();
  const bolehTulis = hasPermission(session.permissions, "konfigurasi.master") && !session.readOnly;

  const profil = PROFIL[jenis];
  const fields = FIELD_MASTER[jenis] ?? [];
  const daftar = useApi(() => daftarMaster(jenis), [jenis]);
  // THE REGISTRY ENDPOINT, READ FOR THE ONE THING IT ANSWERS THAT THE ROWS DO
  // NOT: `scopeBumn`. Sektor and bidang belong to this reporting entity; the
  // BPS province list and the seventeen UN goals are platform reference data
  // with no owner, which is why an edit there is not "our sector list". A
  // reader cannot derive that from any row, so the screen states it.
  const registri = useApi(() => daftarJenisMaster(), []);
  // A kota row points at a provinsi, and a UUID is not a wilayah anybody
  // recognises. The referenced list is read alongside so the picker and the
  // table can print the name; when the read fails the raw id is shown rather
  // than a blank, because a blank would look like "no province".
  const perluProvinsi = fields.some((field) => field.refTabel === "provinsi");
  const provinsi = useApi(() => daftarMaster("provinsi"), [], { enabled: perluProvinsi });

  const [cari, setCari] = useState("");
  const [status, setStatus] = useState("");
  const [dipilihId, setDipilihId] = useState<string | null>(null);
  const [formBaru, setFormBaru] = useState(false);

  const rows = daftar.data?.data ?? [];
  const dipilih = rows.find((row) => row.id === dipilihId) ?? null;

  const namaProvinsi = useMemo(() => {
    const peta = new Map<string, string>();
    for (const row of provinsi.data?.data ?? []) peta.set(row.id, String(row.nama ?? row.id));
    return peta;
  }, [provinsi.data]);

  function tampilNilai(row: BarisMaster, field: FieldMasterUi): string {
    const nilai = row[field.kolom];
    if (nilai === null || nilai === undefined || nilai === "") return "tidak diisi";
    if (field.bentuk === "REF") {
      return namaProvinsi.get(String(nilai)) ?? String(nilai);
    }
    return String(nilai);
  }

  const terpilih = useMemo(() => {
    const teks = cari.trim().toLowerCase();
    return rows.filter((row) => {
      if (status === "AKTIF" && !row.aktif) return false;
      if (status === "NONAKTIF" && row.aktif) return false;
      if (teks === "") return true;
      return fields.some((field) => tampilNilai(row, field).toLowerCase().includes(teks));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cari, status, fields, namaProvinsi]);

  const kolom: readonly ColumnSpec<BarisMaster>[] = useMemo(
    () => [
      ...fields.map((field) => ({
        key: field.kolom,
        header: field.label,
        sortable: true,
        render: (row: BarisMaster) => tampilNilai(row, field),
      })),
      {
        key: "aktif",
        header: "Status",
        width: "120px",
        render: (row: BarisMaster) => (
          <StatusBadge
            status={row.aktif ? "AKTIF" : "NONAKTIF"}
            tone={row.aktif ? "success" : "neutral"}
            label={row.aktif ? "Aktif" : "Nonaktif"}
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, namaProvinsi],
  );

  const kunci = fields.filter((field) => field.kunci);
  const lingkup = registri.data?.data.find((item) => item.jenis === jenis);

  return (
    <>
      <Muat
        hasil={daftar}
        judul={`daftar ${profil?.judul ?? jenis}`}
        sumber={`GET /api/konfigurasi/master/${jenis}`}
      >
        {(data) => (
          <>
            <PapanAngka
              items={[
                {
                  label: "Seluruh baris",
                  nilai: formatCount(data.data.length),
                  catatan: "Termasuk baris yang sudah dinonaktifkan.",
                },
                {
                  label: "Aktif",
                  nilai: formatCount(data.data.filter((row) => row.aktif).length),
                  catatan: "Muncul pada pilihan di formulir baru.",
                },
                {
                  label: "Nonaktif",
                  nilai: formatCount(data.data.filter((row) => !row.aktif).length),
                  catatan: "Hilang dari pilihan, riwayatnya tetap terbaca.",
                },
                lingkup === undefined
                  ? {
                      label: "Lingkup data",
                      nilai: "Belum terbaca",
                      satuan: "Referensi",
                      catatan: "Registri jenis master belum terjawab server.",
                    }
                  : lingkup.scopeBumn
                    ? {
                        label: "Lingkup data",
                        nilai: "Entitas ini",
                        satuan: "Referensi",
                        catatan: "Daftar ini milik entitas pelapor ini sendiri.",
                      }
                    : {
                        label: "Lingkup data",
                        nilai: "Lintas entitas",
                        satuan: "Referensi",
                        catatan: "Referensi bersama, bukan pendapat satu entitas.",
                      },
              ]}
            />

            {bolehTulis ? null : (
              <Panel as="h2" title="Halaman ini terbuka untuk dibaca">
                <TanpaWewenang
                  izin="konfigurasi.master"
                  tindakan={`menambah, mengubah, atau menonaktifkan ${profil?.judul ?? jenis}`}
                />
              </Panel>
            )}

            {formBaru && bolehTulis ? (
              <FormBarisBaru
                jenis={jenis}
                judul={profil?.judul ?? jenis}
                fields={fields}
                provinsi={provinsi.data?.data ?? []}
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
              title={profil?.judul ?? jenis}
              description="Pilih satu baris untuk mengubah namanya atau menonaktifkannya."
              aside={
                bolehTulis ? (
                  <Button
                    variant="primary"
                    size="sm"
                    leading={<Icon name="plus" size={16} />}
                    onClick={() => {
                      setFormBaru((buka) => !buka);
                      setDipilihId(null);
                    }}
                  >
                    {formBaru ? "Tutup formulir" : "Baris baru"}
                  </Button>
                ) : undefined
              }
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/konfigurasi/master/{jenis}. {formatCount(terpilih.length)} dari{" "}
                  {formatCount(data.data.length)} baris ditampilkan.
                </span>
              }
            >
              <div className="filterbar" role="search">
                <div className="filterbar-group is-grow">
                  <span className="filterbar-label">Cari baris</span>
                  <SearchInput
                    label={`Cari ${profil?.judul ?? jenis}`}
                    placeholder="Kode atau nama"
                    value={cari}
                    onChange={(event) => setCari(event.currentTarget.value)}
                  />
                </div>
                <div className="filterbar-group">
                  <span className="filterbar-label">Status</span>
                  <Select
                    aria-label="Status baris"
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
                  judul: tampilNilai(row, fields[0] ?? { kolom: "id", label: "", nama: "", bentuk: "TEKS", wajib: false }),
                  sub: fields
                    .slice(1)
                    .map((field) => tampilNilai(row, field))
                    .join(" . "),
                  status: (
                    <StatusBadge
                      status={row.aktif ? "AKTIF" : "NONAKTIF"}
                      tone={row.aktif ? "success" : "neutral"}
                      label={row.aktif ? "Aktif" : "Nonaktif"}
                    />
                  ),
                  meta: `Versi ${formatCount(row.version)}`,
                })}
                onPilih={(row) => {
                  setFormBaru(false);
                  setDipilihId((sebelum) => (sebelum === row.id ? null : row.id));
                }}
                emptyTitle="Tidak ada baris yang cocok"
                emptyDescription="Ubah kata kunci pencarian atau status yang ditampilkan."
                caption={profil?.judul ?? jenis}
              />
            </Panel>

            {dipilih ? (
              <DetailBaris
                key={dipilih.id}
                jenis={jenis}
                judul={profil?.judul ?? jenis}
                fields={fields}
                baris={dipilih}
                provinsi={provinsi.data?.data ?? []}
                bolehTulis={bolehTulis}
                akibat={profil?.akibat ?? []}
                onBerubah={() => daftar.reload()}
                onTutup={() => setDipilihId(null)}
              />
            ) : null}

            <PenjelasanTanpaHapus
              subjek={profil?.judul ?? jenis}
              dipakai={profil?.dipakai ?? "Dokumen yang sudah terbit"}
              tambahan={
                kunci.length > 0
                  ? `${kunci.map((field) => field.label).join(" dan ")} tidak dapat diubah setelah baris dibuat, karena itulah yang dipakai dokumen lama untuk menunjuk baris ini. Kalau salah, buat baris baru lalu nonaktifkan yang lama.`
                  : undefined
              }
            />
          </>
        )}
      </Muat>
    </>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

function DetailBaris({
  jenis,
  judul,
  fields,
  baris,
  provinsi,
  bolehTulis,
  akibat,
  onBerubah,
  onTutup,
}: {
  jenis: string;
  judul: string;
  fields: readonly FieldMasterUi[];
  baris: BarisMaster;
  provinsi: readonly BarisMaster[];
  bolehTulis: boolean;
  akibat: readonly string[];
  onBerubah: () => void;
  onTutup: () => void;
}) {
  const bisaDiubah = fields.filter((field) => !field.kunci);
  const [isi, setIsi] = useState<Record<string, string>>(() => {
    const awal: Record<string, string> = {};
    for (const field of bisaDiubah) {
      const nilai = baris[field.kolom];
      awal[field.nama] = nilai === null || nilai === undefined ? "" : String(nilai);
    }
    return awal;
  });

  const simpan = useAction((body: Record<string, unknown>) => ubahMaster(jenis, baris.id, body));
  const status = useAction((aktif: boolean) => setAktifMaster(jenis, baris.id, aktif));

  const awal = useMemo(() => {
    const peta: Record<string, string> = {};
    for (const field of bisaDiubah) {
      const nilai = baris[field.kolom];
      peta[field.nama] = nilai === null || nilai === undefined ? "" : String(nilai);
    }
    return peta;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baris]);

  const berubah = bisaDiubah.some((field) => (isi[field.nama] ?? "") !== (awal[field.nama] ?? ""));

  const label = fields
    .filter((field) => field.kunci)
    .map((field) => String(baris[field.kolom] ?? ""))
    .join(" ");

  async function kirim() {
    const body: Record<string, unknown> = {};
    for (const field of bisaDiubah) {
      const teks = (isi[field.nama] ?? "").trim();
      if (teks === (awal[field.nama] ?? "").trim()) continue;
      body[field.nama] = bentukNilai(field, teks);
    }
    const hasil = await simpan.jalankan(body);
    if (hasil) onBerubah();
  }

  return (
    <Panel
      as="h2"
      title={`${judul}: ${label || baris.id.slice(0, 8)}`}
      description="Yang di atas tidak dapat diubah, yang di bawah dapat."
      aside={
        <Button variant="ghost" size="sm" onClick={onTutup}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: PATCH /api/konfigurasi/master/{jenis}/{baris.id.slice(0, 8)}. Versi baris{" "}
          {formatCount(baris.version)}.
        </span>
      }
    >
      <FaktaTetap
        items={fields
          .filter((field) => field.kunci)
          .map((field) => ({
            label: field.label,
            value: String(baris[field.kolom] ?? "tidak diisi"),
            alasan:
              "Inilah yang dipakai proposal, penyaluran, dan jurnal yang sudah terbit untuk menunjuk baris ini. Server menolak perubahannya. Kalau salah, buat baris baru lalu nonaktifkan yang lama.",
          }))}
      />

      {bolehTulis ? (
        <>
          <FieldGrid>
            {bisaDiubah.map((field) => (
              <KendaliField
                key={field.nama}
                id={`ubah-${jenis}-${field.nama}`}
                field={field}
                provinsi={provinsi}
                value={isi[field.nama] ?? ""}
                onChange={(nilai) => setIsi((sebelum) => ({ ...sebelum, [field.nama]: nilai }))}
              />
            ))}
          </FieldGrid>

          <Penolakan pesan={simpan.error} />
          <Berhasil pesan={simpan.hasil ? "Perubahan tersimpan dan tercatat pada audit trail." : null} />

          <div className="form-actions-row">
            <Button
              variant="primary"
              disabled={!berubah}
              loading={simpan.status === "mengirim"}
              onClick={() => void kirim()}
            >
              Simpan perubahan
            </Button>
          </div>

          <KendaliStatus
            aktif={baris.aktif}
            subjek={`${judul.toLowerCase()} ${label}`}
            akibat={[...akibat, "Baris ini tidak lagi bisa dipilih di formulir mana pun."]}
            bukanAkibat={[
              "Dokumen yang sudah menunjuk baris ini tetap terbaca apa adanya.",
              "Laporan periode yang sudah terbit menghasilkan angka yang sama.",
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
        <TanpaWewenang izin="konfigurasi.master" tindakan="mengubah atau menonaktifkan baris ini" />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// A new row
// ---------------------------------------------------------------------------

function FormBarisBaru({
  jenis,
  judul,
  fields,
  provinsi,
  onSelesai,
  onBatal,
}: {
  jenis: string;
  judul: string;
  fields: readonly FieldMasterUi[];
  provinsi: readonly BarisMaster[];
  onSelesai: (baru: BarisMaster) => void;
  onBatal: () => void;
}) {
  const [isi, setIsi] = useState<Record<string, string>>({});
  const kirim = useAction((body: Record<string, unknown>) => buatMaster(jenis, body));

  const siap = fields.every((field) => !field.wajib || (isi[field.nama] ?? "").trim() !== "");

  async function simpan() {
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      const teks = (isi[field.nama] ?? "").trim();
      if (teks === "" && !field.wajib) continue;
      body[field.nama] = bentukNilai(field, teks);
    }
    const hasil = await kirim.jalankan(body);
    if (hasil) onSelesai(hasil);
  }

  const kunci = fields.filter((field) => field.kunci);

  return (
    <Panel
      as="h2"
      title={`${judul} baru`}
      description={
        kunci.length > 0
          ? `${kunci.map((field) => field.label).join(" dan ")} hanya bisa ditetapkan sekarang, dan tidak dapat diubah setelah baris tersimpan.`
          : "Baris baru pada tabel referensi ini."
      }
      aside={
        <Button variant="ghost" size="sm" onClick={onBatal}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/konfigurasi/master/{jenis}. Keunikan kunci dan bentuk setiap nilai
          divalidasi ulang di server.
        </span>
      }
    >
      <FieldGrid>
        {fields.map((field) => (
          <KendaliField
            key={field.nama}
            id={`baru-${jenis}-${field.nama}`}
            field={field}
            provinsi={provinsi}
            value={isi[field.nama] ?? ""}
            onChange={(nilai) => setIsi((sebelum) => ({ ...sebelum, [field.nama]: nilai }))}
          />
        ))}
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
          onClick={() => void simpan()}
        >
          Simpan baris baru
        </Button>
      </div>
    </Panel>
  );
}

/** One input, chosen by the field's declared shape. Four shapes, no fifth. */
function KendaliField({
  id,
  field,
  provinsi,
  value,
  onChange,
}: {
  id: string;
  field: FieldMasterUi;
  provinsi: readonly BarisMaster[];
  value: string;
  onChange: (value: string) => void;
}) {
  const hint =
    field.bentuk === "ANGKA"
      ? `Bilangan bulat antara ${field.min ?? 0} dan ${field.maks ?? 32767}.`
      : field.kunci
        ? "Hanya bisa ditetapkan sekali. Setelah tersimpan, nilainya tetap."
        : undefined;

  if (field.bentuk === "ENUM") {
    return (
      <Field label={field.label} htmlFor={id} required={field.wajib}>
        <Select
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          options={[
            { value: "", label: "Belum dipilih" },
            ...(field.pilihan ?? []).map((item) => ({ value: item, label: item })),
          ]}
        />
      </Field>
    );
  }

  if (field.bentuk === "REF") {
    return (
      <Field
        label={field.label}
        htmlFor={id}
        required={field.wajib}
        hint="Hanya provinsi yang sudah ada di tabel referensi provinsi."
      >
        <Select
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          options={[
            { value: "", label: "Belum dipilih" },
            ...provinsi.map((row) => ({ value: row.id, label: String(row.nama ?? row.id) })),
          ]}
        />
      </Field>
    );
  }

  return (
    <Field label={field.label} htmlFor={id} required={field.wajib} hint={hint}>
      <TextInput
        id={id}
        type={field.bentuk === "ANGKA" ? "number" : "text"}
        inputMode={field.bentuk === "ANGKA" ? "numeric" : undefined}
        min={field.bentuk === "ANGKA" ? field.min : undefined}
        max={field.bentuk === "ANGKA" ? field.maks : undefined}
        maxLength={field.bentuk === "TEKS" ? field.maks : undefined}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

/**
 * The typed value the API expects for one field.
 *
 * A number goes out as a number, because the server checks `typeof mentah ===
 * "number"` and answers "wajib bilangan bulat" for the string "17". An empty
 * optional text goes out as null, which is how the server clears a column.
 */
function bentukNilai(field: FieldMasterUi, teks: string): unknown {
  if (field.bentuk === "ANGKA") {
    const angka = Number.parseInt(teks, 10);
    return Number.isNaN(angka) ? teks : angka;
  }
  if (teks === "") return null;
  return teks;
}
