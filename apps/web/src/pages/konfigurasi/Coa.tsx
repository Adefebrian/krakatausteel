// Master Perkiraan, spec 9.4. The chart of accounts, administered.
//
// THE READ ONLY VIEW OF THIS TREE ALREADY EXISTS, at ../laporan/BaganAkun.tsx,
// and this screen deliberately reuses its markup and its CSS. Two different
// drawings of the same chart is how two screens end up disagreeing about which
// account is a header, and the operator who administers the chart is usually
// the one who just read the report.
//
// WHAT MAKES THIS HARDER THAN A CRUD FORM, in the API's own words.
//
//   FIVE FIELDS ARE REFUSED, NOT IGNORED. `kode`, `parentId`, `level`, `tipe`
//   and `saldoNormal` cannot change on an existing account: the first is what
//   `event_jurnal_mapping`, the report seed and every reconciliation view name
//   the account by, and the other four are where it sits in the statements.
//   Changing one does not correct a mistake, it silently restates what an
//   already posted journal meant. So this screen never draws them as inputs. It
//   draws them as fixed facts with the reason, and the remedy the API intends
//   (a new account plus a deactivation) is stated on the same panel.
//
//   THERE IS NO DELETE, AND THE PROTECTION ON THE DEACTIVATION IS STRICTER THAN
//   ON A SECTOR NAME. A sector that stops being offered costs a form one
//   option. An account that an ACTIVE event mapping points at stops every
//   future journal of that event from being postable at all. The list endpoint
//   answers `punyaAnak`, `dipakaiMapping` and `dipakaiJurnal` precisely so this
//   screen can disable the control and say which of the three is in the way,
//   instead of offering it and letting a 409 explain afterwards. The server
//   refuses again either way, and when it does, its sentence names the event.
//
//   THE HIERARCHY RULES ARE THE SERVER'S AND ARE NOT RE-DERIVED HERE. The form
//   derives `level` and `tipe` FROM THE CHOSEN PARENT, because those two are
//   the only values the server will accept and offering a free choice would be
//   offering a refusal. Everything else (code shape, a postable parent, an
//   inactive parent) is validated on the server, mirrored from the database
//   trigger, and rendered from its answer.
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
  buatAkun,
  daftarAkun,
  daftarKlasifikasiAkun,
  setAktifAkun,
  ubahAkun,
  type AkunTampil,
  type KlasifikasiRow,
} from "../../api/konfigurasi";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useActiveSession } from "../../session";
import {
  CatatanOtorisasi,
  FieldGrid,
  HalamanModul,
  Muat,
  Penyaring,
} from "../shared/parts";
import {
  Berhasil,
  FaktaTetap,
  KendaliStatus,
  PapanAngka,
  Penolakan,
  PenjelasanTanpaHapus,
  SaklarSifat,
  TanpaWewenang,
} from "./parts";

const LABEL_TIPE: Record<string, string> = {
  ASET: "Aset",
  LIABILITAS: "Liabilitas",
  ASET_NETO: "Aset Neto",
  PENDAPATAN: "Pendapatan",
  BEBAN: "Beban",
};

const LABEL_ARUS_KAS: Record<string, string> = {
  OPERASI: "Arus kas operasi",
  INVESTASI: "Arus kas investasi",
  PENDANAAN: "Arus kas pendanaan",
};

const OPSI_TIPE = Object.entries(LABEL_TIPE).map(([value, label]) => ({ value, label }));

const OPSI_ARUS_KAS = [
  { value: "", label: "Tidak masuk Laporan Arus Kas" },
  ...Object.entries(LABEL_ARUS_KAS).map(([value, label]) => ({ value, label })),
];

const OPSI_STATUS = [
  { value: "", label: "Aktif dan nonaktif" },
  { value: "AKTIF", label: "Aktif saja" },
  { value: "NONAKTIF", label: "Nonaktif saja" },
];

const OPSI_TIPE_FILTER = [{ value: "", label: "Semua tipe akun" }, ...OPSI_TIPE];

export function Coa({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const bolehTulis = hasPermission(session.permissions, "konfigurasi.coa") && !session.readOnly;

  const akun = useApi(() => daftarAkun(), []);
  const klasifikasi = useApi(() => daftarKlasifikasiAkun(), []);

  const [cari, setCari] = useState("");
  const [tipe, setTipe] = useState("");
  const [status, setStatus] = useState("");
  const [dipilihId, setDipilihId] = useState<string | null>(null);
  const [formBaru, setFormBaru] = useState(false);

  const rows = akun.data?.data ?? [];
  const dipilih = rows.find((row) => row.id === dipilihId) ?? null;

  const terpilih = useMemo(() => {
    const teks = cari.trim().toLowerCase();
    return rows.filter((row) => {
      if (teks !== "" && !`${row.kode} ${row.nama}`.toLowerCase().includes(teks)) return false;
      if (tipe !== "" && row.tipe !== tipe) return false;
      if (status === "AKTIF" && !row.aktif) return false;
      if (status === "NONAKTIF" && row.aktif) return false;
      return true;
    });
  }, [rows, cari, tipe, status]);

  const angka = useMemo(
    () => [
      {
        label: "Seluruh akun",
        nilai: formatCount(rows.length),
        satuan: "Akun",
        catatan: "Termasuk akun induk dan akun nonaktif.",
      },
      {
        label: "Bisa dijurnal",
        nilai: formatCount(rows.filter((row) => row.isPostable).length),
        satuan: "Akun",
        catatan: "Hanya akun daun yang menerima baris jurnal.",
      },
      {
        label: "Sudah punya jurnal",
        nilai: formatCount(rows.filter((row) => row.dipakaiJurnal).length),
        satuan: "Akun",
        catatan: "Sifat postable akun ini tidak dapat dicabut lagi.",
      },
      {
        label: "Nonaktif",
        nilai: formatCount(rows.filter((row) => !row.aktif).length),
        satuan: "Akun",
        catatan: "Hilang dari pilihan, riwayatnya tetap terbaca.",
      },
    ],
    [rows],
  );

  function segarkan() {
    akun.reload();
  }

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
            {formBaru ? "Tutup formulir akun baru" : "Akun baru"}
          </Button>
        ) : undefined
      }
    >
      <Muat hasil={akun} judul="bagan akun" sumber="GET /api/konfigurasi/coa">
        {(data) => (
          <>
            <PapanAngka items={angka} />

            {bolehTulis ? null : (
              <Panel as="h2" title="Halaman ini terbuka untuk dibaca">
                <TanpaWewenang
                  izin="konfigurasi.coa"
                  tindakan="menambah akun, mengubah namanya, atau menonaktifkannya"
                />
              </Panel>
            )}

            {formBaru && bolehTulis ? (
              <FormAkunBaru
                akun={data.data}
                klasifikasi={klasifikasi.data?.data ?? []}
                onSelesai={(baru) => {
                  setFormBaru(false);
                  setDipilihId(baru.id);
                  segarkan();
                }}
                onBatal={() => setFormBaru(false)}
              />
            ) : null}

            <Penyaring
              ringkas={[
                tipe ? (LABEL_TIPE[tipe] ?? tipe) : "Semua tipe akun",
                status === "" ? "Aktif dan nonaktif" : status === "AKTIF" ? "Aktif saja" : "Nonaktif saja",
                cari.trim() ? `Cari "${cari.trim()}"` : null,
              ]
                .filter(Boolean)
                .join(" . ")}
            >
              <div className="filterbar" role="search">
                <div className="filterbar-group is-grow">
                  <span className="filterbar-label">Cari akun</span>
                  <SearchInput
                    label="Cari akun berdasarkan kode atau nama"
                    placeholder="Kode atau nama akun"
                    value={cari}
                    onChange={(event) => setCari(event.currentTarget.value)}
                  />
                </div>
                <div className="filterbar-group">
                  <span className="filterbar-label">Tipe akun</span>
                  <Select
                    aria-label="Tipe akun"
                    value={tipe}
                    onChange={(event) => setTipe(event.currentTarget.value)}
                    options={OPSI_TIPE_FILTER}
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
            </Penyaring>

            <Panel
              as="h2"
              title="Struktur akun"
              description="Pilih satu akun untuk membaca sifatnya dan mengubah yang boleh diubah."
              footer={
                <span className="panel-foot-note">
                  Sumber: GET /api/konfigurasi/coa. {formatCount(terpilih.length)} dari{" "}
                  {formatCount(data.data.length)} akun ditampilkan.
                </span>
              }
            >
              <PohonAkun
                baris={terpilih}
                dipilihId={dipilihId}
                onPilih={(id) => {
                  setFormBaru(false);
                  setDipilihId((sebelum) => (sebelum === id ? null : id));
                }}
              />
            </Panel>

            {dipilih ? (
              <DetailAkun
                key={dipilih.id}
                akun={dipilih}
                semua={data.data}
                klasifikasi={klasifikasi.data?.data ?? []}
                bolehTulis={bolehTulis}
                onBerubah={segarkan}
                onTutup={() => setDipilihId(null)}
              />
            ) : null}

            <PenjelasanTanpaHapus
              subjek="Akun"
              dipakai="Baris jurnal yang sudah diposting, pemetaan event, dan template baris laporan"
              tambahan="Kode, induk, level, tipe, dan saldo normal akun tidak pernah bisa diubah. Kalau salah satunya salah, buat akun baru dengan nilai yang benar lalu nonaktifkan akun lama, supaya kedua pembacaan tetap terlihat oleh siapa pun yang membaca riwayat."
            />
          </>
        )}
      </Muat>

      <CatatanOtorisasi tambahan="Menambah dan mengubah akun memerlukan kewenangan konfigurasi.coa, dan setiap perubahan tercatat pada audit trail beserta nilai lama dan nilai barunya." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function PohonAkun({
  baris,
  dipilihId,
  onPilih,
}: {
  baris: readonly AkunTampil[];
  dipilihId: string | null;
  onPilih: (id: string) => void;
}) {
  const anak = useMemo(() => {
    const peta = new Map<string, AkunTampil[]>();
    for (const row of baris) {
      const kunci = row.parentId ?? "";
      const daftar = peta.get(kunci);
      if (daftar) daftar.push(row);
      else peta.set(kunci, [row]);
    }
    return peta;
  }, [baris]);

  // An account whose parent was filtered out is rendered at the root rather
  // than dropped, so a filter can never make an account disappear from its own
  // chart. Same rule as the read only report.
  const adaId = useMemo(() => new Set(baris.map((row) => row.id)), [baris]);
  const akar = useMemo(
    () => baris.filter((row) => row.parentId === null || !adaId.has(row.parentId)),
    [baris, adaId],
  );

  const [tutup, setTutup] = useState<ReadonlySet<string>>(() => new Set<string>());

  if (baris.length === 0) {
    return (
      <div className="antrean-kosong">
        <span className="antrean-kosong-icon" aria-hidden="true">
          <Icon name="list" size={20} />
        </span>
        <p className="antrean-kosong-title">Tidak ada akun yang cocok</p>
        <p className="antrean-kosong-desc">
          Ubah kata kunci pencarian, tipe akun, atau status yang ditampilkan.
        </p>
      </div>
    );
  }

  function toggle(id: string) {
    setTutup((sebelum) => {
      const next = new Set(sebelum);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function render(row: AkunTampil, kedalaman: number): JSX.Element[] {
    const anakRow = anak.get(row.id) ?? [];
    const terbuka = !tutup.has(row.id);
    const kelas = [
      "coa-row",
      `is-level-${Math.min(kedalaman, 4)}`,
      row.id === dipilihId ? "is-terpilih" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const keluar: JSX.Element[] = [
      <li key={row.id} className={kelas}>
        <span className="coa-utama">
          {anakRow.length > 0 ? (
            <button
              type="button"
              className="coa-toggle"
              aria-expanded={terbuka}
              aria-label={terbuka ? `Tutup ${row.nama}` : `Buka ${row.nama}`}
              onClick={() => toggle(row.id)}
            >
              <Icon name={terbuka ? "chevronDown" : "chevronRight"} size={16} />
            </button>
          ) : (
            <span className="coa-toggle is-kosong" aria-hidden="true" />
          )}
          <button
            type="button"
            className="coa-buka"
            aria-pressed={row.id === dipilihId}
            onClick={() => onPilih(row.id)}
          >
            <span className="coa-kode">{row.kode}</span>
            <span className="coa-nama">{row.nama}</span>
          </button>
        </span>
        <span className="coa-meta">
          <span className="coa-tipe">{LABEL_TIPE[row.tipe] ?? row.tipe}</span>
          <span className="coa-normal">
            Saldo normal {row.saldoNormal === "D" ? "Debit" : "Kredit"}
          </span>
          <span className="coa-tanda">
            {row.isPostable ? "Bisa dijurnal" : "Header"}
            {row.isKas ? ", kas" : ""}
            {row.isKontra ? ", kontra" : ""}
            {row.dipakaiMapping ? ", kaki pemetaan event" : ""}
            {row.dipakaiJurnal ? ", sudah punya jurnal" : ""}
          </span>
        </span>
        <span className="coa-status">
          <StatusBadge
            status={row.aktif ? "AKTIF" : "NONAKTIF"}
            tone={row.aktif ? "success" : "neutral"}
            label={row.aktif ? "Aktif" : "Nonaktif"}
          />
        </span>
      </li>,
    ];
    if (terbuka) {
      for (const child of anakRow) keluar.push(...render(child, kedalaman + 1));
    }
    return keluar;
  }

  return (
    <div className="coa">
      <div className="coa-head" role="presentation">
        <span className="coa-utama">Kode dan nama akun</span>
        <span className="coa-meta">Tipe, saldo normal, sifat</span>
        <span className="coa-status">Status</span>
      </div>
      <ul className="coa-list">{akar.flatMap((row) => render(row, 0))}</ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------

function DetailAkun({
  akun,
  semua,
  klasifikasi,
  bolehTulis,
  onBerubah,
  onTutup,
}: {
  akun: AkunTampil;
  semua: readonly AkunTampil[];
  klasifikasi: readonly KlasifikasiRow[];
  bolehTulis: boolean;
  onBerubah: () => void;
  onTutup: () => void;
}) {
  const [nama, setNama] = useState(akun.nama);
  const [klasifikasiAkun, setKlasifikasiAkun] = useState(akun.klasifikasiAkun);
  const [arusKas, setArusKas] = useState(akun.klasifikasiArusKas ?? "");
  const [isKas, setIsKas] = useState(akun.isKas);
  const [isKontra, setIsKontra] = useState(akun.isKontra);
  const [isPostable, setIsPostable] = useState(akun.isPostable);

  const simpan = useAction((input: { id: string; body: Parameters<typeof ubahAkun>[1] }) =>
    ubahAkun(input.id, input.body),
  );
  const status = useAction((input: { id: string; aktif: boolean }) =>
    setAktifAkun(input.id, input.aktif),
  );

  const induk = semua.find((row) => row.id === akun.parentId) ?? null;

  const berubah =
    nama.trim() !== akun.nama ||
    klasifikasiAkun !== akun.klasifikasiAkun ||
    arusKas !== (akun.klasifikasiArusKas ?? "") ||
    isKas !== akun.isKas ||
    isKontra !== akun.isKontra ||
    isPostable !== akun.isPostable;

  // The three facts the list endpoint answers so this screen never offers a
  // control the server is certain to refuse. Each one is a statement of the
  // fact, not a paraphrase of the refusal: when the server does refuse, its own
  // sentence names the event or the count and is rendered underneath.
  const tertahanNonaktif = akun.dipakaiMapping
    ? "Akun ini masih menjadi kaki dari pemetaan event jurnal yang aktif. Pemetaan itu menentukan jurnal setiap transaksi eventnya, jadi arahkan dulu pemetaannya ke akun lain, baru nonaktifkan akun ini."
    : akun.punyaAnak
      ? "Akun ini masih punya akun anak yang aktif. Nonaktifkan turunannya lebih dulu, supaya tidak ada akun aktif yang menggantung pada induk yang mati."
      : null;

  const tertahanPostable = !isPostable
    ? akun.punyaAnak
      ? "Akun ini punya akun anak, jadi tidak boleh dijadikan bisa dijurnal. Hanya akun daun yang menerima jurnal."
      : null
    : akun.dipakaiMapping
      ? "Sifat ini tidak dapat dicabut selama akun ini menjadi kaki pemetaan event jurnal yang aktif."
      : akun.dipakaiJurnal
        ? "Akun ini sudah punya baris jurnal, jadi sifat bisa dijurnal tidak dapat dicabut lagi. Nonaktifkan akunnya kalau tidak boleh dipakai lagi."
        : null;

  async function kirim() {
    const hasil = await simpan.jalankan({
      id: akun.id,
      body: {
        nama: nama.trim(),
        klasifikasiAkun,
        klasifikasiArusKas: arusKas === "" ? null : arusKas,
        isKas,
        isKontra,
        isPostable,
        version: akun.version,
      },
    });
    if (hasil) onBerubah();
  }

  return (
    <Panel
      as="h2"
      title={`${akun.kode} ${akun.nama}`}
      description="Yang di atas tidak dapat diubah, yang di bawah dapat."
      aside={
        <Button variant="ghost" size="sm" onClick={onTutup}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: PATCH /api/konfigurasi/coa/{akun.id.slice(0, 8)} dan POST
          /api/konfigurasi/coa/{akun.id.slice(0, 8)}/status. Versi baris {formatCount(akun.version)}.
        </span>
      }
    >
      <FaktaTetap
        items={[
          {
            label: "Kode akun",
            value: akun.kode,
            alasan:
              "Pemetaan event, seed baris laporan, dan setiap view rekonsiliasi menyebut akun ini dengan kodenya. Mengganti kode berarti mengubah arti jurnal yang sudah diposting.",
          },
          {
            label: "Akun induk",
            value: induk ? `${induk.kode} ${induk.nama}` : "Tidak ada, akun ini akar bagan",
            alasan:
              "Induk menentukan posisi akun di laporan. Memindahkannya menyusun ulang laporan periode yang sudah terbit.",
          },
          {
            label: "Level",
            value: formatCount(akun.level),
            alasan: "Level selalu tepat satu di bawah induknya, jadi ia mengikuti induk, bukan diisi sendiri.",
          },
          {
            label: "Tipe akun",
            value: LABEL_TIPE[akun.tipe] ?? akun.tipe,
            alasan: "Tipe menentukan akun ini masuk laporan yang mana, dan harus sama dengan tipe induknya.",
          },
          {
            label: "Saldo normal",
            value: akun.saldoNormal === "D" ? "Debit" : "Kredit",
            alasan: "Saldo normal menentukan tanda setiap saldo yang pernah dihitung dari akun ini.",
          },
        ]}
      />

      {bolehTulis ? (
        <>
          <FieldGrid>
            <Field label="Nama akun" htmlFor={`akun-nama-${akun.id}`} required>
              <TextInput
                id={`akun-nama-${akun.id}`}
                maxLength={200}
                value={nama}
                onChange={(event) => setNama(event.currentTarget.value)}
              />
            </Field>
            <Field
              label="Klasifikasi akun"
              htmlFor={`akun-klas-${akun.id}`}
              required
              hint="Menentukan pengelompokan akun ini pada laporan yang memakai klasifikasi."
            >
              <Select
                id={`akun-klas-${akun.id}`}
                value={klasifikasiAkun}
                onChange={(event) => setKlasifikasiAkun(event.currentTarget.value)}
                options={klasifikasi.map((row) => ({
                  value: row.kode,
                  label: `${row.kode} ${row.nama}`,
                }))}
              />
            </Field>
            <Field
              label="Klasifikasi arus kas"
              htmlFor={`akun-arus-${akun.id}`}
              hint="Hanya dipakai Laporan Arus Kas. Kosongkan untuk akun yang tidak masuk laporan itu."
            >
              <Select
                id={`akun-arus-${akun.id}`}
                value={arusKas}
                onChange={(event) => setArusKas(event.currentTarget.value)}
                options={OPSI_ARUS_KAS}
              />
            </Field>
          </FieldGrid>

          <div className="sifat-list">
            <SaklarSifat
              id={`akun-postable-${akun.id}`}
              label="Bisa dijurnal"
              arti="Transaksi boleh menunjuk akun ini langsung. Hanya akun daun."
              checked={isPostable}
              tertahan={tertahanPostable}
              onChange={setIsPostable}
            />
            <SaklarSifat
              id={`akun-kas-${akun.id}`}
              label="Akun kas"
              arti="Ikut menyusun saldo penutup Laporan Arus Kas. Hanya akun bertipe Aset."
              checked={isKas}
              tertahan={
                akun.tipe === "ASET"
                  ? null
                  : `Akun ini bertipe ${LABEL_TIPE[akun.tipe] ?? akun.tipe}, dan hanya akun bertipe Aset yang boleh ditandai kas.`
              }
              onChange={setIsKas}
            />
            <SaklarSifat
              id={`akun-kontra-${akun.id}`}
              label="Akun kontra"
              arti="Disajikan sebagai pengurang akun induknya, misalnya penyisihan piutang."
              checked={isKontra}
              onChange={setIsKontra}
            />
          </div>

          <Penolakan pesan={simpan.error} />
          <Berhasil pesan={simpan.hasil ? "Perubahan akun tersimpan dan tercatat pada audit trail." : null} />

          <div className="form-actions-row">
            <Button
              variant="primary"
              disabled={!berubah || nama.trim() === ""}
              loading={simpan.status === "mengirim"}
              onClick={() => void kirim()}
            >
              Simpan perubahan
            </Button>
          </div>

          <KendaliStatus
            aktif={akun.aktif}
            subjek={`akun ${akun.kode} ${akun.nama}`}
            akibat={[
              "Akun ini hilang dari setiap pilihan akun pada formulir baru.",
              "Akun ini tidak bisa lagi dijadikan kaki pemetaan event jurnal.",
            ]}
            bukanAkibat={[
              "Baris jurnal yang sudah menunjuk akun ini tidak berubah.",
              "Saldo dan laporan periode yang sudah terbit menghasilkan angka yang sama.",
              "Akun ini tetap muncul pada Bagan Akun dengan status nonaktif.",
            ]}
            tertahan={tertahanNonaktif}
            mengirim={status.status === "mengirim"}
            error={status.error}
            onUbah={(aktif) => {
              void status.jalankan({ id: akun.id, aktif }).then((hasil) => {
                if (hasil) onBerubah();
              });
            }}
          />
        </>
      ) : (
        <TanpaWewenang izin="konfigurasi.coa" tindakan="mengubah atau menonaktifkan akun ini" />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// A new account
// ---------------------------------------------------------------------------

function FormAkunBaru({
  akun,
  klasifikasi,
  onSelesai,
  onBatal,
}: {
  akun: readonly AkunTampil[];
  klasifikasi: readonly KlasifikasiRow[];
  onSelesai: (baru: AkunTampil) => void;
  onBatal: () => void;
}) {
  const [parentId, setParentId] = useState("");
  const [kode, setKode] = useState("");
  const [nama, setNama] = useState("");
  const [tipe, setTipe] = useState("ASET");
  const [saldoNormal, setSaldoNormal] = useState("D");
  const [klasifikasiAkun, setKlasifikasiAkun] = useState(klasifikasi[0]?.kode ?? "");
  const [arusKas, setArusKas] = useState("");
  const [isPostable, setIsPostable] = useState(true);
  const [isKas, setIsKas] = useState(false);
  const [isKontra, setIsKontra] = useState(false);

  const kirim = useAction(buatAkun);

  const induk = akun.find((row) => row.id === parentId) ?? null;
  // Derived, never chosen: the server accepts exactly one value for each.
  const levelEfektif = induk ? induk.level + 1 : 1;
  const tipeEfektif = induk ? induk.tipe : tipe;

  const calonInduk = akun.filter((row) => !row.isPostable && row.aktif);

  const siap =
    kode.trim() !== "" &&
    nama.trim() !== "" &&
    klasifikasiAkun !== "" &&
    (isKas ? tipeEfektif === "ASET" && isPostable : true);

  async function simpan() {
    const hasil = await kirim.jalankan({
      kode: kode.trim(),
      nama: nama.trim(),
      parentId: parentId === "" ? null : parentId,
      level: levelEfektif,
      tipe: tipeEfektif,
      saldoNormal,
      isPostable,
      isKas,
      isKontra,
      klasifikasiArusKas: arusKas === "" ? null : arusKas,
      klasifikasiAkun,
    });
    if (hasil) onSelesai(hasil);
  }

  return (
    <Panel
      as="h2"
      title="Akun baru"
      description="Kode, induk, level, tipe, dan saldo normal hanya bisa ditetapkan sekarang. Setelah tersimpan, kelimanya tidak dapat diubah lagi."
      aside={
        <Button variant="ghost" size="sm" onClick={onBatal}>
          Tutup
        </Button>
      }
      footer={
        <span className="panel-foot-note">
          Sumber: POST /api/konfigurasi/coa. Hierarki, bentuk kode, dan aturan akun kas divalidasi
          ulang di server dan di basis data.
        </span>
      }
    >
      <FieldGrid>
        <Field
          label="Akun induk"
          htmlFor="akun-baru-induk"
          hint="Hanya akun header yang aktif. Kosongkan untuk membuat akar bagan akun."
        >
          <Select
            id="akun-baru-induk"
            value={parentId}
            onChange={(event) => setParentId(event.currentTarget.value)}
            options={[
              { value: "", label: "Tidak ada, akun akar level 1" },
              ...calonInduk.map((row) => ({
                value: row.id,
                label: `${row.kode} ${row.nama} (level ${row.level})`,
              })),
            ]}
          />
        </Field>
        <Field
          label="Kode akun"
          htmlFor="akun-baru-kode"
          required
          hint="1 sampai 30 karakter: huruf, angka, titik, garis bawah, atau strip."
        >
          <TextInput
            id="akun-baru-kode"
            maxLength={30}
            value={kode}
            onChange={(event) => setKode(event.currentTarget.value)}
          />
        </Field>
        <Field label="Nama akun" htmlFor="akun-baru-nama" required>
          <TextInput
            id="akun-baru-nama"
            maxLength={200}
            value={nama}
            onChange={(event) => setNama(event.currentTarget.value)}
          />
        </Field>
        {induk ? null : (
          <Field
            label="Tipe akun"
            htmlFor="akun-baru-tipe"
            required
            hint="Hanya bisa dipilih pada akun akar. Akun di bawahnya mengikuti tipe induknya."
          >
            <Select
              id="akun-baru-tipe"
              value={tipe}
              onChange={(event) => setTipe(event.currentTarget.value)}
              options={OPSI_TIPE}
            />
          </Field>
        )}
        <Field label="Saldo normal" htmlFor="akun-baru-saldo" required>
          <Select
            id="akun-baru-saldo"
            value={saldoNormal}
            onChange={(event) => setSaldoNormal(event.currentTarget.value)}
            options={[
              { value: "D", label: "Debit" },
              { value: "K", label: "Kredit" },
            ]}
          />
        </Field>
        <Field label="Klasifikasi akun" htmlFor="akun-baru-klas" required>
          <Select
            id="akun-baru-klas"
            value={klasifikasiAkun}
            onChange={(event) => setKlasifikasiAkun(event.currentTarget.value)}
            options={klasifikasi.map((row) => ({
              value: row.kode,
              label: `${row.kode} ${row.nama}`,
            }))}
          />
        </Field>
        <Field
          label="Klasifikasi arus kas"
          htmlFor="akun-baru-arus"
          hint="Kosongkan untuk akun yang tidak masuk Laporan Arus Kas."
        >
          <Select
            id="akun-baru-arus"
            value={arusKas}
            onChange={(event) => setArusKas(event.currentTarget.value)}
            options={OPSI_ARUS_KAS}
          />
        </Field>
      </FieldGrid>

      <FaktaTetap
        items={[
          {
            label: "Level yang akan dipakai",
            value: formatCount(levelEfektif),
            alasan: induk
              ? `Mengikuti induk ${induk.kode} yang ada di level ${induk.level}. Server hanya menerima tepat satu level di bawah induknya.`
              : "Akun tanpa induk selalu level 1, dan akun level 1 tidak boleh punya induk.",
          },
          {
            label: "Tipe yang akan dipakai",
            value: LABEL_TIPE[tipeEfektif] ?? tipeEfektif,
            alasan: induk
              ? `Mengikuti induk ${induk.kode}. Tipe akun anak harus sama dengan tipe induknya.`
              : "Dipilih di atas, karena akun ini akar bagan akun.",
          },
        ]}
      />

      <div className="sifat-list">
        <SaklarSifat
          id="akun-baru-postable"
          label="Bisa dijurnal"
          arti="Transaksi boleh menunjuk akun ini langsung. Akun yang punya anak tidak boleh."
          checked={isPostable}
          onChange={setIsPostable}
        />
        <SaklarSifat
          id="akun-baru-kas"
          label="Akun kas"
          arti="Ikut menyusun saldo penutup Laporan Arus Kas."
          checked={isKas}
          tertahan={
            tipeEfektif === "ASET"
              ? isPostable
                ? null
                : "Akun kas harus bisa dijurnal: sebuah transaksi menunjuk akun kasnya langsung."
              : `Tipe yang akan dipakai adalah ${LABEL_TIPE[tipeEfektif] ?? tipeEfektif}, dan hanya akun bertipe Aset yang boleh ditandai kas.`
          }
          onChange={setIsKas}
        />
        <SaklarSifat
          id="akun-baru-kontra"
          label="Akun kontra"
          arti="Disajikan sebagai pengurang akun induknya."
          checked={isKontra}
          onChange={setIsKontra}
        />
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
          onClick={() => void simpan()}
        >
          Simpan akun baru
        </Button>
      </div>
    </Panel>
  );
}
