// Input Jurnal Pinbuk, spec 9.4 and spec 6.5. Coaching and development expense:
// training, an exhibition, a certification, mentoring, equipment support.
//
// THE ENGINE RUNS THREE EXTRA CHECKS ON THIS TYPE, and each one lands on a
// different control here, because a refusal at the top of the page is a
// refusal an operator cannot act on:
//
//   PINBUK_AKUN_SALAH             one line must hit the account the entity's
//                                 `event_jurnal_mapping` names as the debit leg
//                                 of PENYALURAN_PINBUK. On the expense picker.
//   PINBUK_TANPA_TAUTAN           some line must carry `dimensi.mitraId` or
//                                 `dimensi.clusterId`. On the link control.
//   PINBUK_KATEGORI_TIDAK_VALID   some line must carry a `dimensi.kategoriKegiatan`
//                                 the entity has configured. On the category
//                                 control.
//
// THE LINK LIVES IN `dimensi`, NOT IN `mitraId` ON THE LINE, and that is the
// engine's own note: `jurnal_baris.mitra_id` is the receivable sub-ledger
// dimension and validation 6.2.8 demands a receivable account for it, which a
// coaching expense is not. Sending the mitra there would make a perfectly good
// Pinbuk entry refuse for the wrong reason.
//
// THE CATEGORY LIST IS CONFIGURATION THIS ROLE MAY NOT BE ABLE TO READ, and the
// form says so rather than pretending. `JURNAL.kategori_kegiatan_pinbuk` sits
// behind `konfigurasi.parameter` or `audit.view`; a Maker holds neither. So the
// form asks for the list, offers a picker when it arrives, and falls back to a
// free text field with the honest sentence that the server holds the
// authoritative list and will refuse an unknown value. It never invents a list
// of its own: a hardcoded set of five categories here would be a second
// configuration nobody maintains.
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  Icon,
  MoneyInput,
  Panel,
  SearchInput,
  Select,
  TextInput,
} from "@krakatausteel/ui";
import { satuKonfigurasi } from "../../api/konfigurasi";
import { cariMitra, daftarCluster } from "../../api/pumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  BarisAksi,
  Bagian,
  CatatanOtorisasi,
  CatatanPencatatan,
  FieldGrid,
  HalamanModul,
  hariIni,
  Muat,
} from "../shared/parts";
import {
  BagianDokumen,
  barisKosong,
  CatatanAlurJurnal,
  EditorBaris,
  HasilDraft,
  hitungTotal,
  keInputBaris,
  keluhanForm,
  KeluhanForm,
  pesanUntukKontrol,
  TotalBerjalan,
  useAkun,
  useKirimJurnal,
  type BarisForm,
} from "./parts";

type JenisTautan = "MITRA" | "CLUSTER";

const OPSI_TAUTAN = [
  { value: "MITRA", label: "Mitra Binaan" },
  { value: "CLUSTER", label: "Cluster Mitra" },
];

export function JurnalPinbuk({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const akun = useAkun();
  const kirim = useKirimJurnal();

  const [cabangId, setCabangId] = useState(session.cabang.id);
  const [tanggal, setTanggal] = useState(hariIni());
  const [keterangan, setKeterangan] = useState("");

  const [akunBeban, setAkunBeban] = useState("");
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [kategori, setKategori] = useState("");
  const [jenisTautan, setJenisTautan] = useState<JenisTautan>("MITRA");
  const [tautanId, setTautanId] = useState("");
  const [cari, setCari] = useState("");
  const [lawan, setLawan] = useState<BarisForm[]>(() => [barisKosong("KREDIT")]);

  // The configured category list. A 403 here is expected for a Maker and is not
  // an error on the page: see this file's header.
  const daftarKategori = useApi(
    () => satuKonfigurasi("JURNAL", "kategori_kegiatan_pinbuk"),
    [],
  );
  const opsiKategori = useMemo(() => bacaKategori(daftarKategori.data?.nilai ?? null), [
    daftarKategori.data,
  ]);

  const mitra = useApi(() => cariMitra(cari.trim(), cabangId), [cari, cabangId], {
    enabled: jenisTautan === "MITRA",
  });
  const cluster = useApi(() => daftarCluster({ cabangId, cari: cari.trim() || null }), [
    cari,
    cabangId,
  ], { enabled: jenisTautan === "CLUSTER" });

  const daftarAkun = akun.data?.baris ?? [];
  const opsiBeban = useMemo(
    () =>
      daftarAkun
        .filter((a) => a.isPostable && a.aktif && a.tipe === "BEBAN")
        .map((a) => ({ value: a.akunId, label: `${a.kode} ${a.nama}` })),
    [daftarAkun],
  );

  /**
   * The expense leg. Its `dimensi` is what the engine's three Pinbuk checks
   * read, so it is built here in one place rather than typed into the free
   * editor, where a missing key would look like a valid line.
   */
  const barisBeban: BarisForm = {
    kunci: "beban",
    akunId: akunBeban,
    sisi: "DEBIT",
    jumlah,
    terbaca: jumlahTerbaca,
    keterangan: keterangan.trim(),
    mitraId: null,
    akadId: null,
    dimensi: {
      ...(jenisTautan === "MITRA" && tautanId ? { mitraId: tautanId } : {}),
      ...(jenisTautan === "CLUSTER" && tautanId ? { clusterId: tautanId } : {}),
      ...(kategori.trim() === "" ? {} : { kategoriKegiatan: kategori.trim() }),
    },
  };

  const semua = [barisBeban, ...lawan];
  const total = hitungTotal(semua);
  const keluhan = [
    ...keluhanForm(semua, total),
    ...(tautanId === "" ? ["Tautan ke Mitra Binaan atau cluster belum dipilih."] : []),
    ...(kategori.trim() === "" ? ["Kategori kegiatan belum diisi."] : []),
  ];
  const siap = keluhan.length === 0 && tanggal !== "" && cabangId !== "";

  function ulangi() {
    kirim.reset();
    setAkunBeban("");
    setJumlah("");
    setJumlahTerbaca(true);
    setKategori("");
    setTautanId("");
    setKeterangan("");
    setLawan([barisKosong("KREDIT")]);
  }

  if (kirim.hasil) {
    return (
      <HalamanModul route={route}>
        <HasilDraft jurnal={kirim.hasil} onLagi={ulangi} />
        <CatatanPencatatan />
        <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.create." />
      </HalamanModul>
    );
  }

  const pilihan =
    jenisTautan === "MITRA"
      ? (mitra.data?.data ?? []).map((m) => ({ id: m.id, judul: m.namaLengkap, sub: m.kodeMitra }))
      : (cluster.data?.data ?? []).map((c) => ({ id: c.id, judul: c.nama, sub: c.kode }));
  const statusPilihan = jenisTautan === "MITRA" ? mitra.status : cluster.status;

  return (
    <HalamanModul route={route}>
      <CatatanAlurJurnal />

      <BagianDokumen
        cabangId={cabangId}
        setCabangId={setCabangId}
        tanggal={tanggal}
        setTanggal={setTanggal}
        keterangan={keterangan}
        setKeterangan={setKeterangan}
        galat={kirim.galat}
      />

      <Bagian
        title="Beban pembinaan"
        description="Sisi beban dokumen ini wajib memakai akun beban pembinaan kemitraan sesuai pemetaan event PENYALURAN_PINBUK milik entitas Anda."
      >
        <Muat hasil={akun} judul="bagan akun" sumber="GET /api/laporan/bagan-akun">
          {() => (
            <FieldGrid>
              <Field
                label="Akun beban pembinaan"
                htmlFor="pinbuk-akun"
                required
                error={pesanUntukKontrol(kirim.kode, kirim.error, "akunBeban")}
                hint="Akun yang benar ditentukan pemetaan event di server, bukan oleh nama akun di daftar ini."
              >
                <Select
                  id="pinbuk-akun"
                  value={akunBeban}
                  onChange={(event) => setAkunBeban(event.currentTarget.value)}
                  options={[{ value: "", label: "Pilih akun beban" }, ...opsiBeban]}
                />
              </Field>
              <Field
                label="Jumlah beban"
                htmlFor="pinbuk-jumlah"
                required
                error={jumlahTerbaca ? undefined : "Nilai tidak terbaca sebagai angka rupiah."}
              >
                <MoneyInput
                  id="pinbuk-jumlah"
                  value={jumlah}
                  invalid={!jumlahTerbaca}
                  onValueChange={(nilai, mentah) => {
                    setJumlah(nilai ?? "");
                    setJumlahTerbaca(mentah.trim() === "" || nilai !== null);
                  }}
                />
              </Field>
              <Field
                label="Kategori kegiatan"
                htmlFor="pinbuk-kategori"
                required
                error={pesanUntukKontrol(kirim.kode, kirim.error, "kategori")}
                hint={
                  opsiKategori === null
                    ? "Daftar kategori adalah parameter sistem yang tidak terbaca oleh peran Anda. Ketik kategorinya; server menolak nilai yang tidak dikonfigurasi."
                    : "Daftar ini berasal dari parameter JURNAL.kategori_kegiatan_pinbuk milik entitas Anda."
                }
              >
                {opsiKategori === null ? (
                  <TextInput
                    id="pinbuk-kategori"
                    value={kategori}
                    maxLength={200}
                    onChange={(event) => setKategori(event.currentTarget.value)}
                  />
                ) : (
                  <Select
                    id="pinbuk-kategori"
                    value={kategori}
                    onChange={(event) => setKategori(event.currentTarget.value)}
                    options={[
                      { value: "", label: "Pilih kategori kegiatan" },
                      ...opsiKategori.map((nilai) => ({ value: nilai, label: nilai })),
                    ]}
                  />
                )}
              </Field>
            </FieldGrid>
          )}
        </Muat>
      </Bagian>

      <Bagian
        title="Tautan penerima pembinaan"
        description="Jurnal Pinbuk wajib bertaut ke satu Mitra Binaan atau ke satu cluster. Tautan disimpan sebagai dimensi baris, bukan sebagai sub ledger piutang."
      >
        <FieldGrid>
          <Field label="Jenis tautan" htmlFor="pinbuk-jenis-tautan" required>
            <Select
              id="pinbuk-jenis-tautan"
              value={jenisTautan}
              onChange={(event) => {
                setJenisTautan(event.currentTarget.value as JenisTautan);
                setTautanId("");
              }}
              options={OPSI_TAUTAN}
            />
          </Field>
          <Field
            label={jenisTautan === "MITRA" ? "Cari Mitra Binaan" : "Cari cluster"}
            htmlFor="pinbuk-cari"
            error={pesanUntukKontrol(kirim.kode, kirim.error, "tautan")}
          >
            <SearchInput
              id="pinbuk-cari"
              label={jenisTautan === "MITRA" ? "Cari Mitra Binaan" : "Cari cluster"}
              value={cari}
              onChange={(event) => setCari(event.currentTarget.value)}
            />
          </Field>
        </FieldGrid>
        {statusPilihan === "gagal" ? (
          <p className="periksa-item">
            <Icon name="alert" size={16} />
            <span>
              Daftar {jenisTautan === "MITRA" ? "Mitra Binaan" : "cluster"} tidak dapat dibaca dari
              server, jadi tautan belum bisa dipilih.
            </span>
          </p>
        ) : (
          <ul className="pilihan-list">
            {pilihan.length === 0 ? (
              <li className="pilihan-btn is-statis">
                <span className="pilihan-judul">Tidak ada hasil</span>
                <span className="pilihan-sub">
                  Persempit atau ganti kata kunci pencarian di atas.
                </span>
              </li>
            ) : (
              pilihan.slice(0, 12).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={tautanId === item.id ? "pilihan-btn is-active" : "pilihan-btn"}
                    onClick={() => setTautanId(item.id)}
                  >
                    <span className="pilihan-judul">{item.judul}</span>
                    <span className="pilihan-sub">{item.sub}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </Bagian>

      <Bagian
        title="Baris lawan"
        description="Sisi lawan bebas, biasanya kas atau bank. Totalnya harus sama dengan sisi beban."
      >
        <Muat hasil={akun} judul="bagan akun" sumber="GET /api/laporan/bagan-akun">
          {(data) => (
            <>
              <EditorBaris baris={lawan} onChange={setLawan} akun={data.baris} galat={null} />
              <TotalBerjalan total={total} />
            </>
          )}
        </Muat>
      </Bagian>

      <Panel
        as="h2"
        title="Simpan sebagai draft"
        description="Yang tersimpan adalah dokumen DRAFT. Menyimpan di sini membentuk jurnal, bukan memindahkan dana."
      >
        <KeluhanForm keluhan={keluhan} />
        <BarisAksi
          error={kirim.kode !== null && kirim.kode.startsWith("PINBUK_") ? null : kirim.error}
          primary={
            <Button
              variant="primary"
              disabled={!siap || akun.status !== "siap"}
              loading={kirim.status === "mengirim"}
              leading={<Icon name="check" size={16} />}
              onClick={() =>
                void kirim.kirim({
                  cabangId,
                  jenis: "PINBUK",
                  tanggalTransaksi: tanggal,
                  keterangan: keterangan.trim() === "" ? null : keterangan.trim(),
                  baris: keInputBaris(semua),
                })
              }
            >
              Simpan draft jurnal pinbuk
            </Button>
          }
          secondary={
            <Button variant="ghost" onClick={() => setLawan([barisKosong("KREDIT")])}>
              Kosongkan baris lawan
            </Button>
          }
        />
      </Panel>

      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.create." />
    </HalamanModul>
  );
}

/**
 * The configured category list, or null when it could not be read.
 *
 * NULL IS "I DO NOT KNOW", NOT "THERE ARE NONE". An empty picker would tell an
 * operator no category exists, which is a statement about the entity's
 * configuration this page has no basis for; null falls back to a free field and
 * says why.
 */
function bacaKategori(nilai: string | null): string[] | null {
  if (nilai === null) return null;
  try {
    const terbaca: unknown = JSON.parse(nilai);
    if (!Array.isArray(terbaca)) return null;
    const daftar = terbaca.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return daftar.length === 0 ? null : daftar;
  } catch {
    return null;
  }
}
