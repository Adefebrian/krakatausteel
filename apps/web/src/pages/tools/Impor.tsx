// The three bulk import screens of spec 9.6: Mitra Binaan, Angsuran, and the
// go-live Saldo Awal. One implementation, three configurations, because they
// are one workflow and drawing it three times is how three screens end up
// disagreeing about what "commit" means.
//
// PREVIEW FIRST, AND THE COMMIT IS CLOSED UNTIL THE PREVIEW HAS BEEN READ.
// Spec 9.6: "preview hasil parsing, validasi per baris, tampilkan baris yang
// error dengan alasan, baru commit yang valid ... Jangan pernah commit sebagian
// tanpa laporan eksplisit ke user." So on this page:
//
//   the commit control does not exist until a preview has come back;
//   the preview is INVALIDATED the moment the file or any option changes, so a
//   commit can never ride on a report about a different file;
//   with even one rejected row, the commit stays closed and says why, because
//   the server would refuse the whole file anyway and an operator deserves to
//   know that before spending the round trip;
//   and a confirmation asks the operator to state, in a typed phrase, that they
//   have read the report.
//
// THE LINE NUMBERS ARE THE SPREADSHEET'S OWN, HEADER INCLUDED. `nomorBaris`
// counts the header row, so row 2 in this report is row 2 in Excel. Nothing
// here renumbers them: an operator fixing a file scrolls to the number they see.
//
// A REFUSED COMMIT WROTE NOTHING, AND THAT SENTENCE IS ON THE SCREEN. The API
// answers a 400 whose body carries the whole rejection report, and ./api/impor
// hands it back as data rather than as a thrown message. Without that, "ada
// baris yang ditolak" would arrive with no line numbers, which is the one thing
// the operator came for.
//
// THE OPENING BALANCE IMPORT REFUSES TO RUN TWICE, AND THE PAGE SAYS WHAT THAT
// MEANS. `SALDO_AWAL_SUDAH_DIPOSTING` is not a generic failure: it means this
// scope already has its opening balances, which is a normal and correct state
// on any entity that has gone live. Shown as a plain statement, not as a red
// error, because it is the answer to "has this already been done" rather than a
// fault to chase.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
  Field,
  FilePicker,
  Icon,
  Panel,
  Textarea,
  TextInput,
  formatCount,
  formatDate,
  formatMoney,
  type Column,
} from "@krakatausteel/ui";
import {
  bacaBerkas,
  komitImpor,
  KODE_SALDO_AWAL_SUDAH_DIPOSTING,
  MAKS_BARIS_IMPOR,
  MAKS_ISI_BYTE,
  pratinjauImpor,
  type BarisDitolak,
  type HasilKomit,
  type HasilPratinjau,
  type JenisImpor,
  type PermintaanImporWeb,
} from "../../api/impor";
import { kodeDomain, pesanKesalahan } from "../../api/http";
import type { PageRoute } from "../../nav";
import {
  CatatanOtorisasi,
  CatatanPencatatan,
  FieldGrid,
  HalamanModul,
  hariIni,
  useLingkupCabang,
} from "../shared/parts";
import { KartuRingkas } from "./parts";

// ---------------------------------------------------------------------------
// The three configurations
// ---------------------------------------------------------------------------

interface Konfigurasi {
  jenis: JenisImpor;
  /** Column headers the file must carry, as the server names them. */
  wajib: readonly string[];
  opsional: readonly string[];
  /** What one row of this file IS, in the operator's words. */
  satuan: string;
  /** What committing this file does to the ledger. */
  akibat: string;
  /** Extra sentences this kind, and only this kind, has to carry. */
  catatan: readonly string[];
}

const KONFIGURASI: Record<JenisImpor, Konfigurasi> = {
  MITRA: {
    jenis: "MITRA",
    wajib: ["kode_mitra", "nama_lengkap"],
    opsional: [
      "nik",
      "jenis_kelamin",
      "tanggal_lahir",
      "alamat",
      "telepon",
      "email",
      "nama_usaha",
      "bidang_usaha",
      "kode_mitra_lama",
    ],
    satuan: "satu Mitra Binaan",
    akibat:
      "Setiap baris yang lolos menjadi satu Mitra Binaan pada cabang yang dipilih. Impor ini tidak membentuk jurnal apa pun.",
    catatan: [
      "Kode mitra harus unik pada entitas Anda. Baris dengan kode yang sudah dipakai ditolak beserta nomor barisnya, dan berkasnya tidak jadi disimpan.",
    ],
  },
  ANGSURAN: {
    jenis: "ANGSURAN",
    wajib: ["no_akad", "tanggal", "jumlah", "kode_akun_kas"],
    opsional: ["no_bukti", "tanggal_valuta", "keterangan"],
    satuan: "satu setoran angsuran",
    akibat:
      "Setiap baris yang lolos dicatat sebagai penerimaan angsuran pada akadnya, dan membentuk jurnal penerimaan lewat jalur pencatatan yang sama dengan input satuan.",
    catatan: [
      "Alokasi setoran ke tunggakan, pokok, dan Jasa Administrasi dihitung engine sesuai urutan pada Parameter Sistem, bukan oleh berkas yang diunggah.",
      "Kolom jumlah ditulis sebagai angka desimal dengan titik sebagai pemisah desimal, misalnya 1500000.00, bukan sebagai teks berformat rupiah.",
    ],
  },
  SALDO_AWAL: {
    jenis: "SALDO_AWAL",
    wajib: ["bagian"],
    opsional: [
      "kode_akun",
      "nama_akun",
      "tipe",
      "saldo_normal",
      "level",
      "parent_kode",
      "klasifikasi",
      "is_postable",
      "is_kas",
      "is_kontra",
      "klasifikasi_arus_kas",
      "debit",
      "kredit",
      "no_akad",
      "outstanding_pokok",
      "outstanding_jasa",
      "tunggakan_pokok",
      "tunggakan_jasa",
      "angsuran_ke_terakhir",
      "hari_tunggakan",
      "kolektibilitas",
      "keterangan",
    ],
    satuan: "satu akun atau satu akad",
    akibat:
      "Seluruh berkas dicatat sebagai satu jurnal saldo awal dan satu batch sub ledger piutang, dalam satu transaksi. Ini adalah migrasi dari sistem lama dan dijalankan sekali saja per lingkup.",
    catatan: [
      "Satu berkas berisi dua bagian sekaligus, dibedakan kolom bagian: AKUN untuk saldo per akun, dan AKAD untuk outstanding per akad. Keduanya wajib ada di berkas yang sama karena pemeriksaan sub ledger piutang membandingkan keduanya sebelum satu baris pun ditulis.",
      "Berkas ditolak seluruhnya bila total debit tidak sama dengan total kredit, atau bila total outstanding akad tidak sama dengan saldo akun piutang pengendalinya.",
      "Tanggal efektif adalah tanggal cut off dari sistem lama, yaitu sehari sebelum periode terbuka pertama dimulai. Server menolak tanggal yang bukan itu.",
    ],
  },
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function Impor({ route, jenis }: { route: PageRoute; jenis: JenisImpor }) {
  const konfigurasi = KONFIGURASI[jenis];
  const lingkup = useLingkupCabang("Cabang tujuan impor");

  const [berkas, setBerkas] = useState<File[]>([]);
  const [tanggalEfektif, setTanggalEfektif] = useState(hariIni());
  const [keterangan, setKeterangan] = useState("");

  const [pratinjau, setPratinjau] = useState<HasilPratinjau | null>(null);
  /** The exact request the current preview describes. See the header. */
  const [sidikPratinjau, setSidikPratinjau] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState<"diam" | "pratinjau" | "komit">("diam");
  const [galat, setGalat] = useState<string | null>(null);
  const [kodeGalat, setKodeGalat] = useState<string | null>(null);
  const [hasilKomit, setHasilKomit] = useState<HasilKomit | null>(null);
  const [konfirmasi, setKonfirmasi] = useState(false);

  const file = berkas[0] ?? null;
  const sidikSekarang = file
    ? [
        jenis,
        file.name,
        String(file.size),
        String(file.lastModified),
        lingkup.cabangId ?? "scope",
        jenis === "SALDO_AWAL" ? `${tanggalEfektif}|${keterangan.trim()}` : "",
      ].join("::")
    : null;

  const pratinjauSegar = pratinjau !== null && sidikPratinjau === sidikSekarang;
  const adaDitolak = pratinjau !== null && pratinjau.ditolak.length > 0;
  const bolehKomit = pratinjauSegar && !adaDitolak && pratinjau.siapKomit;

  async function permintaan(): Promise<PermintaanImporWeb | null> {
    if (!file) return null;
    const isi = await bacaBerkas(file);
    return {
      jenis,
      namaFile: file.name,
      isi: isi.isi,
      format: isi.format,
      cabangId: lingkup.cabangId,
      saldoAwal:
        jenis === "SALDO_AWAL"
          ? { tanggalEfektif, keterangan: keterangan.trim() === "" ? null : keterangan.trim() }
          : null,
    };
  }

  async function jalankanPratinjau() {
    setSibuk("pratinjau");
    setGalat(null);
    setKodeGalat(null);
    setHasilKomit(null);
    try {
      const isi = await permintaan();
      if (!isi) return;
      const hasil = await pratinjauImpor(isi);
      setPratinjau(hasil);
      setSidikPratinjau(sidikSekarang);
    } catch (cause: unknown) {
      setPratinjau(null);
      setSidikPratinjau(null);
      setGalat(pesanKesalahan(cause));
      setKodeGalat(kodeDomain(cause));
    } finally {
      setSibuk("diam");
    }
  }

  async function jalankanKomit() {
    setSibuk("komit");
    setGalat(null);
    setKodeGalat(null);
    try {
      const isi = await permintaan();
      if (!isi) return;
      const hasil = await komitImpor(isi);
      if (hasil.ok) {
        setHasilKomit(hasil.hasil);
        setKonfirmasi(false);
      } else {
        // Nothing was written. The report replaces the preview, because it is a
        // report about the same file and it is the newer truth about it.
        setPratinjau(hasil.laporan);
        setSidikPratinjau(sidikSekarang);
        setKonfirmasi(false);
        setGalat(
          "Ada baris yang ditolak, jadi tidak ada satu baris pun yang disimpan. Perbaiki berkasnya lalu unggah ulang.",
        );
      }
    } catch (cause: unknown) {
      setGalat(pesanKesalahan(cause));
      setKodeGalat(kodeDomain(cause));
      setKonfirmasi(false);
    } finally {
      setSibuk("diam");
    }
  }

  function gantiBerkas(files: File[]) {
    setBerkas(files);
    // A preview describes ONE file. A new file makes the old report a
    // statement about something that is no longer on screen.
    setPratinjau(null);
    setSidikPratinjau(null);
    setHasilKomit(null);
    setGalat(null);
    setKodeGalat(null);
  }

  if (hasilKomit) {
    return (
      <HalamanModul route={route}>
        <HasilImpor hasil={hasilKomit} konfigurasi={konfigurasi} onLagi={() => gantiBerkas([])} />
        <CatatanPencatatan />
        <CatatanOtorisasi tambahan="Impor massal memerlukan kewenangan tools.import." />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route}>
      <PenjelasanImpor konfigurasi={konfigurasi} />

      <Panel
        as="h2"
        title="Berkas yang akan diimpor"
        description="Satu berkas per unggahan, format CSV atau XLSX. Berkas dibaca di peramban lalu dikirim sebagai isi permintaan, tidak disimpan di penyimpanan objek."
        footer={
          <span className="panel-foot-note">
            Batas server: maksimal {formatCount(Math.floor(MAKS_ISI_BYTE / 1024))} KB per berkas dan{" "}
            {formatCount(MAKS_BARIS_IMPOR)} baris data per berkas.
          </span>
        }
      >
        <div className="filter-laporan">{lingkup.kontrol}</div>
        <FilePicker
          label="Pilih berkas CSV atau XLSX"
          files={berkas}
          multiple={false}
          accept=".csv,.xlsx,text/csv"
          hint="Berkas lama otomatis diganti bila Anda memilih berkas baru, dan pratinjau sebelumnya ikut dibatalkan."
          onChange={gantiBerkas}
        />

        {jenis === "SALDO_AWAL" ? (
          <FieldGrid>
            <Field
              label="Tanggal efektif saldo awal"
              htmlFor="saldo-tanggal"
              required
              hint="Tanggal cut off dari sistem lama, yaitu sehari sebelum periode terbuka pertama dimulai. Server menolak tanggal lain."
            >
              <TextInput
                id="saldo-tanggal"
                type="date"
                value={tanggalEfektif}
                onChange={(event) => {
                  setTanggalEfektif(event.currentTarget.value);
                  setPratinjau(null);
                  setSidikPratinjau(null);
                }}
              />
            </Field>
            <Field label="Keterangan jurnal saldo awal" htmlFor="saldo-keterangan">
              <Textarea
                id="saldo-keterangan"
                rows={2}
                maxLength={240}
                value={keterangan}
                onChange={(event) => {
                  setKeterangan(event.currentTarget.value);
                  setPratinjau(null);
                  setSidikPratinjau(null);
                }}
              />
            </Field>
          </FieldGrid>
        ) : null}

        <div className="form-actions-row">
          <Button
            variant="primary"
            disabled={file === null}
            loading={sibuk === "pratinjau"}
            leading={<Icon name="eye" size={16} />}
            onClick={() => void jalankanPratinjau()}
          >
            Pratinjau berkas
          </Button>
        </div>

        {galat ? (
          kodeGalat === KODE_SALDO_AWAL_SUDAH_DIPOSTING ? (
            <SudahAdaSaldoAwal pesan={galat} />
          ) : (
            <p className="form-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{galat}</span>
            </p>
          )
        ) : null}
      </Panel>

      {pratinjau === null ? (
        <Panel as="h2" title="Belum ada pratinjau">
          <div className="antrean-kosong">
            <span className="antrean-kosong-icon" aria-hidden="true">
              <Icon name="upload" size={20} />
            </span>
            <p className="antrean-kosong-title">Pratinjau dulu, baru bisa dicommit</p>
            <p className="antrean-kosong-desc">
              Pratinjau membaca dan memvalidasi berkas tanpa menulis apa pun. Tombol commit baru
              muncul setelah laporan pratinjau ada di layar ini.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          <BandPratinjau pratinjau={pratinjau} segar={pratinjauSegar} />

          {pratinjauSegar ? null : (
            <p className="periksa-item">
              <Icon name="alert" size={16} />
              <span>
                Berkas atau pilihannya berubah setelah pratinjau ini dibuat, jadi laporan di bawah
                menggambarkan berkas yang lain. Jalankan pratinjau lagi sebelum commit.
              </span>
            </p>
          )}

          <TabelDitolak ditolak={pratinjau.ditolak} />

          <Panel
            as="h2"
            title="Commit berkas"
            description="Commit bersifat semua atau tidak sama sekali. Bila satu baris ditolak, tidak ada satu baris pun yang disimpan."
          >
            {adaDitolak ? (
              <p className="periksa-item">
                <Icon name="alert" size={16} />
                <span>
                  Masih ada {formatCount(pratinjau.ditolak.length)} baris ditolak, jadi commit
                  ditutup. Perbaiki berkasnya pada nomor baris di atas, lalu unggah dan pratinjau
                  ulang.
                </span>
              </p>
            ) : (
              <p className="periksa-ok">
                <Icon name="check" size={16} />
                <span>
                  Seluruh {formatCount(pratinjau.diterima.length)} baris lolos validasi.{" "}
                  {konfigurasi.akibat}
                </span>
              </p>
            )}
            <div className="form-actions-row">
              <Button
                variant="primary"
                disabled={!bolehKomit}
                loading={sibuk === "komit"}
                leading={<Icon name="upload" size={16} />}
                onClick={() => setKonfirmasi(true)}
              >
                Commit {formatCount(pratinjau.diterima.length)} baris
              </Button>
            </div>
          </Panel>

          <ConfirmDialog
            open={konfirmasi}
            title={`Commit ${pratinjau.namaFile}`}
            description="Seluruh berkas disimpan dalam satu transaksi, atau tidak ada satu baris pun yang disimpan."
            confirmLabel="Commit berkas"
            tone="danger"
            confirmPhrase="SAYA SUDAH BACA PRATINJAU"
            confirmPhraseLabel="Ketik untuk menyatakan pratinjau di atas sudah dibaca"
            loading={sibuk === "komit"}
            error={galat}
            onCancel={() => setKonfirmasi(false)}
            onConfirm={() => void jalankanKomit()}
          >
            <DataList
              items={[
                { label: "Nama berkas", value: pratinjau.namaFile },
                { label: "Baris data", value: formatCount(pratinjau.jumlahBaris), numeric: true },
                { label: "Baris diterima", value: formatCount(pratinjau.diterima.length), numeric: true },
                { label: "Baris ditolak", value: formatCount(pratinjau.ditolak.length), numeric: true },
                { label: "Yang terjadi setelah commit", value: konfigurasi.akibat, wide: true },
              ]}
            />
          </ConfirmDialog>
        </>
      )}

      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Impor massal memerlukan kewenangan tools.import." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// Explanation, before a file is even chosen
// ---------------------------------------------------------------------------

function PenjelasanImpor({ konfigurasi }: { konfigurasi: Konfigurasi }) {
  return (
    <Panel
      as="h2"
      title="Cara kerja impor ini"
      description={`Satu baris berkas adalah ${konfigurasi.satuan}. Baca bagian ini sebelum mengunggah, karena commit tidak bisa dibatalkan dari halaman ini.`}
      className="panel-panduan"
    >
      <ol className="langkah-list">
        <li>
          <strong>Pratinjau tidak menulis apa pun.</strong> Berkas dibaca dan divalidasi baris demi
          baris, lalu hasilnya ditampilkan lengkap dengan nomor baris berkas untuk setiap penolakan.
        </li>
        <li>
          <strong>Commit bersifat semua atau tidak sama sekali.</strong> Bila satu baris saja
          ditolak, tidak ada satu baris pun yang disimpan, dan laporan penolakannya tetap
          ditampilkan.
        </li>
        <li>
          <strong>Nomor baris mengikuti nomor baris di berkas Anda, termasuk baris judul kolom.</strong>{" "}
          Baris nomor 2 pada laporan adalah baris nomor 2 pada spreadsheet Anda.
        </li>
      </ol>
      {konfigurasi.catatan.map((teks) => (
        <p className="peringatan-teks" key={teks}>
          {teks}
        </p>
      ))}
      <h3 className="sub-judul">Kolom berkas</h3>
      <DataList
        items={[
          { label: "Kolom wajib", value: konfigurasi.wajib.join(", "), wide: true },
          { label: "Kolom opsional", value: konfigurasi.opsional.join(", "), wide: true },
          {
            label: "Kolom tidak dikenal",
            value:
              "Ditolak, bukan diabaikan. Kolom yang salah eja dan diam diam dilewati adalah cara impor kehilangan satu field tanpa ada yang tahu.",
            wide: true,
          },
        ]}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function BandPratinjau({
  pratinjau,
  segar,
}: {
  pratinjau: HasilPratinjau;
  segar: boolean;
}) {
  return (
    <Bento columns={4}>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Baris data"
          nilai={formatCount(pratinjau.jumlahBaris)}
          catatan={`Berkas ${pratinjau.namaFile}, ${formatCount(Math.round(pratinjau.ukuranBytes / 1024))} KB.`}
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Baris diterima"
          nilai={formatCount(pratinjau.diterima.length)}
          catatan="Lolos seluruh validasi per baris. Belum tersimpan: pratinjau tidak menulis apa pun."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Baris ditolak"
          nilai={formatCount(pratinjau.ditolak.length)}
          catatan="Selama masih ada penolakan, seluruh berkas tidak bisa dicommit, bukan hanya baris yang ditolak."
        />
      </BentoItem>
      <BentoItem span="sm">
        <KartuRingkas
          judul="Status pratinjau"
          nilai={segar ? "Sesuai berkas" : "Kedaluwarsa"}
          catatan={
            segar
              ? "Laporan ini menggambarkan berkas dan pilihan yang sedang aktif di halaman ini."
              : "Berkas atau pilihannya berubah setelah laporan ini dibuat. Jalankan pratinjau ulang."
          }
        />
      </BentoItem>
    </Bento>
  );
}

interface BarisTolak {
  id: string;
  nomorBaris: number;
  kolom: string;
  alasan: string;
}

const KOLOM_TOLAK: readonly Column<BarisTolak>[] = [
  { key: "nomorBaris", header: "Baris berkas", type: "count", sortable: true, width: "140px" },
  { key: "kolom", header: "Kolom", width: "220px" },
  { key: "alasan", header: "Alasan penolakan" },
];

function TabelDitolak({ ditolak }: { ditolak: readonly BarisDitolak[] }) {
  if (ditolak.length === 0) {
    return (
      <Panel as="h2" title="Tidak ada baris yang ditolak">
        <p className="periksa-ok">
          <Icon name="check" size={16} />
          <span>Seluruh baris berkas lolos validasi per baris pada pratinjau ini.</span>
        </p>
      </Panel>
    );
  }

  const rows: BarisTolak[] = [];
  for (const baris of ditolak) {
    for (const [kolom, pesan] of Object.entries(baris.alasan)) {
      rows.push({
        id: `${baris.nomorBaris}-${kolom}`,
        nomorBaris: baris.nomorBaris,
        kolom,
        alasan: pesan.join(". "),
      });
    }
  }

  return (
    <Panel
      as="h2"
      title={`Baris yang ditolak, ${formatCount(ditolak.length)} baris`}
      description="Nomor baris di kolom pertama adalah nomor baris pada berkas Anda, termasuk baris judul kolom."
      footer={
        <span className="panel-foot-note">
          Selama daftar ini tidak kosong, seluruh berkas ditolak dan tidak ada satu baris pun yang
          tersimpan.
        </span>
      }
    >
      <div className="daftar-tabel">
        <DataTable
          columns={KOLOM_TOLAK}
          rows={rows}
          rowKey={(row) => row.id}
          caption="Penolakan per baris dan per kolom"
          emptyTitle="Tidak ada penolakan"
        />
      </div>
      <div className="daftar-kartu">
        <ul className="baris-kartu-list">
          {rows.map((row) => (
            <li className="baris-kartu" key={row.id}>
              <span className="baris-kartu-head">
                <span className="baris-kartu-kode">Baris {formatCount(row.nomorBaris)}</span>
                <span className="baris-kartu-sisi">{row.kolom}</span>
              </span>
              <span className="baris-kartu-nama">{row.alasan}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// After the commit, and the one refusal that is not a fault
// ---------------------------------------------------------------------------

function HasilImpor({
  hasil,
  konfigurasi,
  onLagi,
}: {
  hasil: HasilKomit;
  konfigurasi: Konfigurasi;
  onLagi: () => void;
}) {
  const saldo = hasil.saldoAwal;
  return (
    <>
      <Panel
        as="h2"
        title={`Berkas ${hasil.namaFile} tersimpan`}
        description={konfigurasi.akibat}
        footer={
          <span className="panel-foot-note">
            Checksum berkas: {hasil.checksum}. Berkas dengan isi yang persis sama ditolak bila
            diunggah lagi.
          </span>
        }
      >
        <DataList
          items={[
            { label: "Baris pada berkas", value: formatCount(hasil.jumlahBaris), numeric: true },
            { label: "Baris tersimpan", value: formatCount(hasil.jumlahDitulis), numeric: true },
            {
              label: "Jurnal terbentuk",
              value:
                hasil.jurnalIds.length === 0
                  ? "tidak ada, impor ini tidak membentuk jurnal"
                  : formatCount(hasil.jurnalIds.length),
              wide: true,
            },
          ]}
        />
        <div className="form-actions-row">
          <Button variant="primary" onClick={onLagi}>
            Impor berkas lain
          </Button>
        </div>
      </Panel>

      {saldo ? (
        <Panel
          as="h2"
          title="Ringkasan saldo awal yang tercatat"
          description="Angka angka ini dibaca dari jurnal saldo awal yang baru terbentuk, bukan dihitung ulang di halaman ini."
        >
          <DataList
            columns={2}
            items={[
              { label: "Nomor jurnal saldo awal", value: saldo.noJurnal },
              { label: "Tanggal efektif", value: formatDate(saldo.tanggalEfektif) },
              { label: "Tanggal jurnal", value: formatDate(saldo.tanggalJurnal) },
              { label: "Jumlah akun", value: formatCount(saldo.jumlahAkun), numeric: true },
              { label: "Jumlah akad", value: formatCount(saldo.jumlahAkad), numeric: true },
              { label: "Total debit", value: formatMoney(saldo.totalDebit), numeric: true },
              { label: "Total kredit", value: formatMoney(saldo.totalKredit), numeric: true },
              {
                label: "Akun piutang pengendali",
                value: saldo.kodeAkunPiutang,
              },
              {
                label: "Saldo akun piutang",
                value: formatMoney(saldo.saldoKontrolPiutang),
                numeric: true,
              },
              {
                label: "Total sub ledger piutang",
                value: formatMoney(saldo.totalSubLedgerPiutang),
                numeric: true,
              },
              {
                label: "Akun yang dibuat dari berkas",
                value:
                  saldo.akunDibuat.length === 0
                    ? "tidak ada, seluruh akun sudah terdaftar"
                    : saldo.akunDibuat.join(", "),
                wide: true,
              },
            ]}
          />
          <p className="periksa-ok">
            <Icon name="check" size={16} />
            <span>
              Saldo akun piutang dan total sub ledger piutang sudah cocok, diperiksa server di dalam
              transaksi impor ini. Tanpa kecocokan itu, berkas akan ditolak seluruhnya.
            </span>
          </p>
        </Panel>
      ) : null}
    </>
  );
}

/**
 * The opening balance import refusing to run twice.
 *
 * IT IS NOT A RED ERROR, because it is not a fault: on any entity that has gone
 * live, this is the correct and expected answer. An operator who reads "gagal"
 * here goes looking for a broken file that is fine.
 */
function SudahAdaSaldoAwal({ pesan }: { pesan: string }) {
  return (
    <div className="peringatan">
      <Icon name="info" size={20} />
      <div>
        <p className="peringatan-judul">Lingkup ini sudah punya saldo awal</p>
        <p className="peringatan-teks">
          Saldo awal adalah migrasi sekali jalan, dan cabang ini sudah pernah menjalankannya, jadi
          server menolak yang kedua. Ini bukan berkas yang rusak dan bukan kegagalan sistem:
          menjalankannya dua kali akan menggandakan seluruh saldo pembukaan. Bila saldo awal yang
          sudah tercatat memang salah, koreksinya adalah jurnal pembalik atas jurnal saldo awalnya,
          bukan impor ulang.
        </p>
        <p className="peringatan-teks">Jawaban server: {pesan}</p>
      </div>
    </div>
  );
}
