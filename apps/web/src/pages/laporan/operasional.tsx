// EIGHTEEN OF SPEC 10'S TWENTY THREE OPERATIONAL REPORTS, DECLARED.
//
// Every page in this file is the same page: parameters, one table with a
// footing, a set of totals, and where the report carries one, a second table
// beside the first. What differs between them is the endpoint, the columns and
// the words, and that is exactly what a declaration holds. The frame is
// ./generik.tsx and nothing here re-implements any part of it.
//
// The five that are NOT here have their own screens, because they are not this
// shape: the two matrices (./Matriks.tsx, reports 3 and 11), the ageing grid
// (./AgingPiutang.tsx, report 8), the receivable card (./KartuPiutangLaporan.tsx,
// report 9) and the demographic distributions (./DemografiMitra.tsx, report 27).
//
// TWO THINGS TO READ CAREFULLY WHEN ADDING TO THIS FILE.
//
//   A NULLABLE FIGURE GOES THROUGH `NilaiAtau`, NEVER `Nilai`. `anggaran`,
//   `selisih` and `penyisihanDibutuhkanRun` are legitimately absent when there
//   is no approved budget and no closing run, and `Nilai` would print the
//   "tidak sah" marker on those rows. The marker means "this number could not
//   be read"; using it for "there is no number" destroys it everywhere.
//
//   A NULLABLE COUNT DOES NOT GO THROUGH `type: "count"` EITHER. `formatCount`
//   renders null as "0", which on `penerimaManfaat` would report zero
//   beneficiaries for a programme that simply has not stated them yet. Those
//   columns render through `Cacah` below.
import type { ReactNode } from "react";
import { formatCount, formatDate, Panel, StatusBadge, type Column } from "@krakatausteel/ui";
import {
  akrualJasa,
  bebanPenyisihan,
  kolektibilitas,
  monitoringLpjLaporan,
  pemetaanSdg,
  penerimaanAngsuran,
  penyaluranNonPumk,
  perhitunganPenyisihan,
  portalNonPumk,
  portalPumk,
  realisasiSektor,
  realisasiWilayah,
  rekapBidang,
  rekapJurnal,
  rekapPermohonan,
  rekapRealisasi,
  type BarisAkrualJasa,
  type BarisBebanPenyisihan,
  type BarisBidang,
  type BarisKolektibilitas,
  type BarisMonitoringLpj,
  type BarisPenerimaanAngsuran,
  type BarisPenyaluranNonPumk,
  type BarisPerhitunganPenyisihan,
  type BarisPortal,
  type BarisRekapJurnal,
  type BarisRekapPermohonan,
  type BarisRekapRealisasi,
  type BarisSdg,
  type BarisSektor,
  type BarisWilayah,
  type LaporanAkrualJasa,
  type LaporanBebanPenyisihan,
  type LaporanKolektibilitas,
  type LaporanMonitoringLpj,
  type LaporanPemetaanSdg,
  type LaporanPenerimaanAngsuran,
  type LaporanPenyaluranNonPumk,
  type LaporanPerhitunganPenyisihan,
  type LaporanPortal,
  type LaporanRealisasiSektor,
  type LaporanRealisasiWilayah,
  type LaporanRekapBidang,
  type LaporanRekapJurnal,
  type LaporanRekapPermohonan,
  type LaporanRekapRealisasi,
} from "../../api/laporan-operasional";
import type { PageRoute } from "../../nav";
import { TabelLaporan, LaporanTabel, type DeklarasiLaporan } from "./generik";
import { Nilai, NilaiAtau, NilaiPersen, teksNilai } from "./parts";

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

const KELOMPOK_PUMK = "Laporan Pendanaan UMK";
const KELOMPOK_NON_PUMK = "Laporan Non PUMK";
const KELOMPOK_AKUNTANSI = "Laporan Akuntansi";
const KELOMPOK_LAINNYA = "Laporan Lainnya";

/** A count that is allowed to be absent. `formatCount(null)` is "0", which on
 *  a beneficiary column would report a number nobody stated. */
function Cacah({ nilai, kosong }: { nilai: number | null | undefined; kosong: string }) {
  if (nilai === null || nilai === undefined) {
    return <span className="angka-kosong">{kosong}</span>;
  }
  return <span className="angka">{formatCount(nilai)}</span>;
}

/** A text cell that is clamped to one line, so no row can reshape a table. */
/**
 * A PARTNER IN ONE COLUMN INSTEAD OF TWO.
 *
 * `kode_mitra` and `nama_mitra` are one identity, and giving each a column of
 * its own cost about a hundred and twenty pixels on three reports that did not
 * have them: report 28's nine columns came to 1341px inside a 1092px box, and
 * "Nilai penyisihan", the figure the whole report exists for, was off the right
 * edge at 1440, 1280 and 1024. The code rides under the name, where a reader
 * looking for either still finds it.
 */
function SelMitra({ kode, nama }: { kode: string; nama: string }) {
  return (
    <span className="sel-nama">
      <span className="sel-nama-judul" title={nama}>
        {nama}
      </span>
      {/* `title` because the sub line is clamped to one: a list of SDG or a
          long branch name is shortened to keep the row one shape, and a value
          that is shortened must still be reachable. */}
      <span className="sel-nama-sub" title={kode}>
        {kode}
      </span>
    </span>
  );
}

function Ringkas({ teks }: { teks: string }) {
  return <span className="sel-ringkas">{teks}</span>;
}

function tanggalAtau(nilai: string | null, kosong: string): string {
  return nilai === null ? kosong : formatDate(nilai);
}

/** A secondary table under a report's main one, in the same chrome as the
 *  main one so the page reads as one system rather than two. */
function BagianTabel<Row>({
  judul,
  deskripsi,
  columns,
  rows,
  rowKey,
  kartu,
  kosongJudul,
  kosongPesan,
}: {
  judul: string;
  deskripsi: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  kartu: (row: Row) => { judul: string; sub: string; meta?: string; nilai?: string; nilaiLabel?: string; status?: ReactNode };
  kosongJudul: string;
  kosongPesan: string;
}) {
  return (
    <Panel as="h2" title={judul} description={deskripsi}>
      <TabelLaporan
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        kartu={kartu}
        kosongJudul={kosongJudul}
        kosongPesan={kosongPesan}
      />
    </Panel>
  );
}

// ===========================================================================
// 1. Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten
// ===========================================================================

const WILAYAH: DeklarasiLaporan<LaporanRealisasiWilayah, BarisWilayah> = {
  kelompok: KELOMPOK_PUMK,
  judul: "laporan realisasi penyaluran per wilayah",
  sumber: "GET /api/laporan/realisasi-wilayah",
  pakaiMode: true,
  ambil: (p) => realisasiWilayah(p),
  baris: (d) => d.baris,
  rowKey: (r) =>
    `${r.tipeBaris}:${r.provinsiId ?? r.provinsiNama}:${r.kotaId ?? r.kotaNama ?? ""}`,
  kolom: (d) => [
    {
      key: "wilayah",
      header: "Wilayah",
      render: (r) => (
        <span className={r.tipeBaris === "KOTA" ? "sel-anak" : "sel-utama-judul"}>
          {r.tipeBaris === "PROVINSI" ? r.provinsiNama : (r.kotaNama ?? r.provinsiNama)}
        </span>
      ),
      footer: "Total",
    },
    { key: "tipeBaris", header: "Tingkat", width: "110px" },
    {
      key: "jumlahMitra",
      header: "Jumlah mitra",
      type: "count",
      width: "130px",
      footer: formatCount(d.total.jumlahMitra),
    },
    {
      key: "jumlahPenyaluran",
      header: "Jumlah penyaluran",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.jumlahPenyaluran} />,
      footer: <Nilai angka={d.total.jumlahPenyaluran} />,
    },
    {
      key: "persenDariTotal",
      header: "Persen dari total",
      type: "percent",
      width: "150px",
      render: (r) => <NilaiPersen nilai={r.persenDariTotal} />,
    },
  ],
  kartu: (r) => ({
    judul: r.tipeBaris === "PROVINSI" ? r.provinsiNama : (r.kotaNama ?? r.provinsiNama),
    sub: r.tipeBaris === "PROVINSI" ? "Provinsi" : `Kota atau kabupaten di ${r.provinsiNama}`,
    meta: `${formatCount(r.jumlahMitra)} mitra`,
    nilai: teksNilai(r.jumlahPenyaluran),
    nilaiLabel: "Penyaluran",
  }),
  tabel: { judul: "Penyaluran per wilayah" },
  kosong: {
    judul: "Tidak ada penyaluran pada jendela ini",
    pesan: "Tidak ada pencairan PUMK yang jatuh pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah mitra", kunci: "Mitra", nilai: formatCount(d.total.jumlahMitra) },
    {
      label: "Jumlah penyaluran",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.jumlahPenyaluran} />,
    },
  ],
  catatan: () =>
    "Wilayah dihitung dari alamat Mitra Binaan yang tercatat saat ini, bukan alamat pada saat akad ditandatangani, jadi mitra yang pindah ikut pindah barisnya.",
};

export function RealisasiWilayahPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={WILAYAH} />;
}

// ===========================================================================
// 2. Laporan Realisasi Penyaluran berdasarkan Sektor
// ===========================================================================

const SEKTOR: DeklarasiLaporan<LaporanRealisasiSektor, BarisSektor> = {
  kelompok: KELOMPOK_PUMK,
  judul: "laporan realisasi penyaluran per sektor",
  sumber: "GET /api/laporan/realisasi-sektor",
  pakaiMode: true,
  ambil: (p) => realisasiSektor(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.sektorId ?? r.kode,
  kolom: (d) => [
    { key: "kode", header: "Kode", width: "90px", footer: "Total" },
    { key: "nama", header: "Sektor", render: (r) => <Ringkas teks={r.nama} /> },
    {
      key: "jumlahMitra",
      header: "Jumlah mitra",
      type: "count",
      width: "120px",
      footer: formatCount(d.total.jumlahMitra),
    },
    {
      key: "jumlahPenyaluran",
      header: "Penyaluran",
      type: "money",
      width: "160px",
      render: (r) => <Nilai angka={r.jumlahPenyaluran} />,
      footer: <Nilai angka={d.total.jumlahPenyaluran} />,
    },
    {
      key: "persenDariTotal",
      header: "Persen dari total",
      type: "percent",
      width: "140px",
      render: (r) => <NilaiPersen nilai={r.persenDariTotal} />,
    },
    {
      key: "anggaran",
      header: "Anggaran",
      type: "money",
      width: "160px",
      render: (r) => <NilaiAtau angka={r.anggaran} kosong="Tidak dianggarkan" />,
      footer: <NilaiAtau angka={d.total.anggaran} kosong="Tidak dianggarkan" />,
    },
    {
      key: "selisih",
      header: "Selisih",
      type: "money",
      width: "160px",
      render: (r) => <NilaiAtau angka={r.selisih} kosong="Tidak dianggarkan" />,
      footer: <NilaiAtau angka={d.total.selisih} kosong="Tidak dianggarkan" />,
    },
    {
      key: "persenCapaian",
      header: "Persen capaian",
      type: "percent",
      width: "140px",
      render: (r) => <NilaiPersen nilai={r.persenCapaian} />,
    },
  ],
  kartu: (r) => ({
    judul: `${r.kode} ${r.nama}`,
    sub: `${formatCount(r.jumlahMitra)} mitra binaan`,
    meta:
      r.anggaran === null
        ? "Tidak dianggarkan"
        : `Anggaran ${teksNilai(r.anggaran)}`,
    nilai: teksNilai(r.jumlahPenyaluran),
    nilaiLabel: "Penyaluran",
  }),
  tabel: { judul: "Penyaluran per sektor" },
  kosong: {
    judul: "Tidak ada penyaluran pada jendela ini",
    pesan: "Tidak ada pencairan PUMK yang jatuh pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah mitra", kunci: "Mitra", nilai: formatCount(d.total.jumlahMitra) },
    { label: "Penyaluran", kunci: "Nilai", nilai: <Nilai angka={d.total.jumlahPenyaluran} /> },
    {
      label: "Anggaran",
      kunci: "Nilai",
      nilai: <NilaiAtau angka={d.total.anggaran} kosong="Tidak dianggarkan" />,
      kedua: {
        kunci: "Selisih",
        nilai: <NilaiAtau angka={d.total.selisih} kosong="Tidak dianggarkan" />,
      },
    },
    {
      label: "Capaian terhadap anggaran",
      kunci: "Persen",
      nilai: <NilaiPersen nilai={d.total.persenCapaian} />,
    },
  ],
  catatan: (d) =>
    d.rkaId === null
      ? "Tidak ada RKA PUMK yang disetujui untuk periode ini, jadi kolom Anggaran, Selisih dan Persen capaian tidak diisi. Kosong di sini berarti tidak ada target, bukan target nol."
      : `Kolom Anggaran dibandingkan terhadap RKA PUMK versi ${d.rkaVersi ?? "tidak dinyatakan"} yang berstatus disetujui.`,
};

export function RealisasiSektorPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={SEKTOR} />;
}

// ===========================================================================
// 4. Laporan Penerimaan Angsuran
// ===========================================================================

const PENERIMAAN: DeklarasiLaporan<LaporanPenerimaanAngsuran, BarisPenerimaanAngsuran> = {
  kelompok: KELOMPOK_PUMK,
  judul: "laporan penerimaan angsuran",
  sumber: "GET /api/laporan/penerimaan-angsuran",
  pakaiMode: true,
  ambil: (p) => penerimaanAngsuran(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.angsuranId,
  kolom: (d) => [
    {
      key: "tanggalTerima",
      header: "Tanggal terima",
      type: "date",
      width: "130px",
      sortable: true,
      footer: "Total",
    },
    {
      key: "namaMitra",
      header: "Mitra Binaan",
      width: "220px",
      render: (r) => <SelMitra kode={r.kodeMitra} nama={r.namaMitra} />,
    },
    { key: "noAkad", header: "No akad", width: "150px" },
    {
      key: "pokok",
      header: "Pokok",
      type: "money",
      width: "150px",
      render: (r) => <Nilai angka={r.pokok} />,
      footer: <Nilai angka={d.total.pokok} />,
    },
    {
      key: "jasaAdm",
      header: "Jasa administrasi",
      type: "money",
      width: "160px",
      render: (r) => <Nilai angka={r.jasaAdm} />,
      footer: <Nilai angka={d.total.jasaAdm} />,
    },
    {
      key: "kelebihan",
      header: "Kelebihan",
      type: "money",
      width: "140px",
      render: (r) => <Nilai angka={r.kelebihan} />,
      footer: <Nilai angka={d.total.kelebihan} />,
    },
    {
      key: "total",
      header: "Total setoran",
      type: "money",
      width: "160px",
      render: (r) => <Nilai angka={r.total} />,
      footer: <Nilai angka={d.total.total} />,
    },
    {
      key: "noBukti",
      header: "No bukti",
      width: "150px",
      render: (r) => r.noBukti ?? <span className="sel-kosong">Tidak ada</span>,
    },
  ],
  kartu: (r) => ({
    judul: `${r.kodeMitra} ${r.namaMitra}`,
    sub: `${r.noAkad}, diterima ${formatDate(r.tanggalTerima)}`,
    meta: r.noBukti ? `Bukti ${r.noBukti}` : "Tanpa nomor bukti",
    nilai: teksNilai(r.total),
    nilaiLabel: "Total setoran",
  }),
  tabel: { judul: "Setoran yang diterima" },
  kosong: {
    judul: "Tidak ada setoran pada jendela ini",
    pesan: "Tidak ada angsuran yang diterima pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    {
      label: "Jumlah setoran",
      kunci: "Dokumen",
      nilai: formatCount(d.total.jumlahSetoran),
    },
    { label: "Pokok", kunci: "Nilai", nilai: <Nilai angka={d.total.pokok} /> },
    { label: "Jasa administrasi", kunci: "Nilai", nilai: <Nilai angka={d.total.jasaAdm} /> },
    {
      label: "Kelebihan bayar",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.kelebihan} />,
      kedua: { kunci: "Total setoran", nilai: <Nilai angka={d.total.total} /> },
    },
  ],
};

export function PenerimaanAngsuranPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={PENERIMAAN} />;
}

// ===========================================================================
// 6. Rekap Permohonan PUMK
// ===========================================================================

function kolomRekapPermohonan(
  total: LaporanRekapPermohonan["total"] | null,
  labelKunci: string,
): readonly Column<BarisRekapPermohonan>[] {
  return [
    { key: "nama", header: labelKunci, render: (r) => <Ringkas teks={r.nama} />, footer: total ? "Total" : undefined },
    {
      key: "jumlahProposal",
      header: "Jumlah proposal",
      type: "count",
      width: "140px",
      footer: total ? formatCount(total.jumlahProposal) : undefined,
    },
    {
      key: "jumlahDisetujui",
      header: "Disetujui",
      type: "count",
      width: "120px",
      footer: total ? formatCount(total.jumlahDisetujui) : undefined,
    },
    {
      key: "nilaiDiajukan",
      header: "Nilai diajukan",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiDiajukan} />,
      footer: total ? <Nilai angka={total.nilaiDiajukan} /> : undefined,
    },
    {
      key: "nilaiDisetujui",
      header: "Nilai disetujui",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiDisetujui} />,
      footer: total ? <Nilai angka={total.nilaiDisetujui} /> : undefined,
    },
    {
      key: "rasioPersetujuan",
      header: "Rasio persetujuan",
      type: "percent",
      width: "160px",
      render: (r) => <NilaiPersen nilai={r.rasioPersetujuan} />,
    },
  ];
}

function kartuRekapPermohonan(r: BarisRekapPermohonan) {
  return {
    judul: r.nama,
    sub: `${formatCount(r.jumlahProposal)} proposal, ${formatCount(r.jumlahDisetujui)} disetujui`,
    meta: "Nilai diajukan " + teksNilai(r.nilaiDiajukan),
    nilai: teksNilai(r.nilaiDisetujui),
    nilaiLabel: "Nilai disetujui",
  };
}

const REKAP_PERMOHONAN: DeklarasiLaporan<LaporanRekapPermohonan, BarisRekapPermohonan> = {
  kelompok: KELOMPOK_PUMK,
  judul: "rekap permohonan PUMK",
  sumber: "GET /api/laporan/rekap-permohonan",
  pakaiMode: true,
  ambil: (p) => rekapPermohonan(p),
  baris: (d) => d.perStatus,
  rowKey: (r) => r.kunci,
  kolom: (d) => kolomRekapPermohonan(d.total, "Status proposal"),
  kartu: kartuRekapPermohonan,
  tabel: { judul: "Permohonan per status" },
  kosong: {
    judul: "Tidak ada permohonan pada jendela ini",
    pesan: "Tidak ada proposal PUMK yang diajukan pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah proposal", kunci: "Dokumen", nilai: formatCount(d.total.jumlahProposal) },
    { label: "Disetujui", kunci: "Dokumen", nilai: formatCount(d.total.jumlahDisetujui) },
    {
      label: "Nilai diajukan",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.nilaiDiajukan} />,
      kedua: { kunci: "Nilai disetujui", nilai: <Nilai angka={d.total.nilaiDisetujui} /> },
    },
    {
      label: "Rasio persetujuan",
      kunci: "Persen",
      nilai: <NilaiPersen nilai={d.total.rasioPersetujuan} />,
    },
  ],
  bagian: (d) => (
    <BagianTabel
      judul="Permohonan per sektor"
      deskripsi="Permohonan yang sama, dikelompokkan menurut sektor usaha pemohonnya."
      columns={kolomRekapPermohonan(null, "Sektor")}
      rows={d.perSektor}
      rowKey={(r) => r.kunci}
      kartu={kartuRekapPermohonan}
      kosongJudul="Tidak ada permohonan per sektor"
      kosongPesan="Tidak ada proposal PUMK yang bisa dikelompokkan menurut sektor pada jendela ini."
    />
  ),
};

export function RekapPermohonanPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={REKAP_PERMOHONAN} />;
}

// ===========================================================================
// 7. Rekap Realisasi PUMK
// ===========================================================================

const REKAP_REALISASI: DeklarasiLaporan<LaporanRekapRealisasi, BarisRekapRealisasi> = {
  kelompok: KELOMPOK_PUMK,
  judul: "rekap realisasi PUMK",
  sumber: "GET /api/laporan/rekap-realisasi",
  ambil: (p) => rekapRealisasi(p),
  baris: (d) => d.baris,
  rowKey: (r) => `${r.tahun}-${r.bulan}`,
  kolom: (d) => [
    { key: "label", header: "Bulan", width: "160px", footer: "Total tahun buku" },
    {
      key: "jumlahAkad",
      header: "Jumlah akad",
      type: "count",
      width: "130px",
      footer: formatCount(d.total.jumlahAkad),
    },
    {
      key: "nilaiAkad",
      header: "Nilai akad",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiAkad} />,
      footer: <Nilai angka={d.total.nilaiAkad} />,
    },
    {
      key: "nilaiDicairkan",
      header: "Nilai dicairkan",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiDicairkan} />,
      footer: <Nilai angka={d.total.nilaiDicairkan} />,
    },
    {
      key: "mitraBaru",
      header: "Mitra baru",
      type: "count",
      width: "120px",
      footer: formatCount(d.total.mitraBaru),
    },
    {
      key: "mitraLama",
      header: "Mitra lama",
      type: "count",
      width: "120px",
      footer: formatCount(d.total.mitraLama),
    },
  ],
  kartu: (r) => ({
    judul: r.label,
    sub: `${formatCount(r.jumlahAkad)} akad, ${formatCount(r.mitraBaru)} mitra baru dan ${formatCount(r.mitraLama)} mitra lama`,
    meta: `Nilai akad ${teksNilai(r.nilaiAkad)}`,
    nilai: teksNilai(r.nilaiDicairkan),
    nilaiLabel: "Dicairkan",
  }),
  tabel: { judul: "Realisasi per bulan" },
  kosong: {
    judul: "Belum ada realisasi pada tahun buku ini",
    pesan: "Tidak ada akad PUMK yang tercatat pada tahun buku sampai periode yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah akad", kunci: "Dokumen", nilai: formatCount(d.total.jumlahAkad) },
    {
      label: "Nilai akad",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.nilaiAkad} />,
      kedua: { kunci: "Dicairkan", nilai: <Nilai angka={d.total.nilaiDicairkan} /> },
    },
    {
      label: "Mitra baru",
      kunci: "Mitra",
      nilai: formatCount(d.total.mitraBaru),
      kedua: { kunci: "Mitra lama", nilai: formatCount(d.total.mitraLama) },
    },
  ],
  catatan: () =>
    "Laporan ini selalu mencakup tahun buku berjalan sampai periode yang dipilih, jadi pilihan jendela bulanan atau kumulatif tidak berlaku di sini.",
};

export function RekapRealisasiPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={REKAP_REALISASI} />;
}

// ===========================================================================
// 10. Laporan Kolektibilitas
// ===========================================================================

const KOLEKTIBILITAS_LAPORAN: DeklarasiLaporan<LaporanKolektibilitas, BarisKolektibilitas> = {
  kelompok: KELOMPOK_PUMK,
  judul: "laporan kolektibilitas",
  sumber: "GET /api/laporan/kolektibilitas",
  ambil: (p) => kolektibilitas(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.klasifikasi,
  kolom: (d) => [
    {
      key: "klasifikasi",
      header: "Klasifikasi",
      width: "180px",
      render: (r) => <StatusBadge status={r.klasifikasi} label={r.nama} />,
      footer: "Total",
    },
    {
      key: "jumlahMitra",
      header: "Jumlah mitra",
      type: "count",
      width: "130px",
      footer: formatCount(d.total.jumlahMitra),
    },
    {
      key: "jumlahAkad",
      header: "Jumlah akad",
      type: "count",
      width: "130px",
      footer: formatCount(d.total.jumlahAkad),
    },
    {
      key: "outstandingPokok",
      header: "Outstanding pokok",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.outstandingPokok} />,
      footer: <Nilai angka={d.total.outstandingPokok} />,
    },
    {
      key: "outstandingJasa",
      header: "Outstanding jasa",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.outstandingJasa} />,
      footer: <Nilai angka={d.total.outstandingJasa} />,
    },
    {
      key: "nilaiPenyisihan",
      header: "Nilai penyisihan",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.nilaiPenyisihan} />,
      footer: <Nilai angka={d.total.nilaiPenyisihan} />,
    },
    {
      key: "persenDariTotal",
      header: "Persen dari total",
      type: "percent",
      width: "150px",
      render: (r) => <NilaiPersen nilai={r.persenDariTotal} />,
    },
  ],
  kartu: (r) => ({
    judul: r.nama,
    sub: `${formatCount(r.jumlahMitra)} mitra, ${formatCount(r.jumlahAkad)} akad`,
    meta: `Penyisihan ${teksNilai(r.nilaiPenyisihan)}`,
    nilai: teksNilai(r.outstandingPokok),
    nilaiLabel: "Outstanding pokok",
    status: <StatusBadge status={r.klasifikasi} label={r.nama} />,
  }),
  tabel: { judul: "Kolektibilitas per klasifikasi" },
  kosong: {
    judul: "Belum ada snapshot kolektibilitas",
    pesan:
      "Periode dan cabang yang dipilih belum punya hasil closing kolektibilitas, jadi tidak ada klasifikasi yang bisa dilaporkan.",
  },
  total: (d) => [
    { label: "Jumlah mitra", kunci: "Mitra", nilai: formatCount(d.total.jumlahMitra) },
    { label: "Jumlah akad", kunci: "Akad", nilai: formatCount(d.total.jumlahAkad) },
    {
      label: "Outstanding",
      kunci: "Pokok",
      nilai: <Nilai angka={d.total.outstandingPokok} />,
      kedua: { kunci: "Jasa", nilai: <Nilai angka={d.total.outstandingJasa} /> },
    },
    {
      label: "Nilai penyisihan",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.nilaiPenyisihan} />,
    },
  ],
  bagian: (d) => (
    <BagianTabel
      judul="Kolektibilitas per sektor"
      deskripsi="Outstanding pokok yang sama, dipecah menurut sektor usaha, dengan satu kolom per klasifikasi."
      columns={[
        { key: "kode", header: "Kode", width: "90px" },
        { key: "nama", header: "Sektor", render: (r) => <Ringkas teks={r.nama} /> },
        { key: "jumlahMitra", header: "Jumlah mitra", type: "count", width: "130px" },
        {
          key: "outstandingPokok",
          header: "Outstanding pokok",
          type: "money",
          width: "180px",
          render: (r) => <Nilai angka={r.outstandingPokok} />,
        },
        {
          key: "nilaiPenyisihan",
          header: "Nilai penyisihan",
          type: "money",
          width: "170px",
          render: (r) => <Nilai angka={r.nilaiPenyisihan} />,
        },
        ...d.baris.map((klas, index) => ({
          key: `kelas-${klas.klasifikasi}`,
          header: klas.nama,
          type: "money" as const,
          width: "160px",
          render: (r: (typeof d.perSektor)[number]) => (
            <NilaiAtau angka={r.perKlasifikasi[index]} kosong="Tidak ada" />
          ),
        })),
      ]}
      rows={d.perSektor}
      rowKey={(r) => r.sektorId ?? r.kode}
      kartu={(r) => ({
        judul: `${r.kode} ${r.nama}`,
        sub: `${formatCount(r.jumlahMitra)} mitra binaan`,
        meta: `Penyisihan ${teksNilai(r.nilaiPenyisihan)}`,
        nilai: teksNilai(r.outstandingPokok),
        nilaiLabel: "Outstanding pokok",
      })}
      kosongJudul="Tidak ada rincian per sektor"
      kosongPesan="Snapshot kolektibilitas periode ini tidak memuat akad yang bisa dikelompokkan menurut sektor."
    />
  ),
};

export function KolektibilitasPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={KOLEKTIBILITAS_LAPORAN} />;
}

// ===========================================================================
// 12. Laporan Penyaluran Non PUMK
// ===========================================================================

const PENYALURAN_NON_PUMK: DeklarasiLaporan<LaporanPenyaluranNonPumk, BarisPenyaluranNonPumk> = {
  kelompok: KELOMPOK_NON_PUMK,
  judul: "laporan penyaluran Non PUMK",
  sumber: "GET /api/laporan/penyaluran-non-pumk",
  pakaiMode: true,
  ambil: (p) => penyaluranNonPumk(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.penyaluranId,
  kolom: (d) => [
    {
      key: "tanggalPenyaluran",
      header: "Tanggal salur",
      type: "date",
      width: "130px",
      sortable: true,
      footer: "Total",
    },
    // TEN COLUMNS BECAME EIGHT, and the two that went were pairs that name one
    // thing between them. Measured: ten came to 1397px inside a 1092px box, so
    // "Penerima manfaat" was off the right edge at 1440, 1280 and 1024 alike.
    {
      key: "namaPemohon",
      header: "Pemohon",
      width: "200px",
      render: (r) => <SelMitra kode={r.noProposal} nama={r.namaPemohon} />,
    },
    {
      key: "bidangNama",
      header: "Bidang dan SDG",
      width: "200px",
      render: (r) => (
        <SelMitra
          nama={r.bidangNama}
          kode={
            r.sdg.length === 0
              ? "Belum dipetakan ke SDG"
              : r.sdg.map((s) => `${s.nomor}. ${s.nama}`).join(", ")
          }
        />
      ),
    },
    { key: "termin", header: "Termin", type: "count", width: "90px" },
    {
      key: "nilaiDisetujui",
      header: "Nilai disetujui",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiDisetujui} />,
    },
    {
      key: "nilaiDisalurkan",
      header: "Nilai disalurkan",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiDisalurkan} />,
      footer: <Nilai angka={d.total.nilaiDisalurkan} />,
    },
    {
      key: "statusLpj",
      header: "Status LPJ",
      width: "150px",
      render: (r) => <StatusBadge status={r.statusLpj} />,
    },
    {
      key: "penerimaManfaat",
      header: "Penerima manfaat",
      type: "count",
      width: "160px",
      render: (r) => <Cacah nilai={r.penerimaManfaat} kosong="Belum dinyatakan" />,
      footer: formatCount(d.total.penerimaManfaat),
    },
  ],
  kartu: (r) => ({
    judul: r.judulProgram,
    sub: `${r.noProposal}, ${r.namaPemohon}`,
    meta: `${r.bidangNama}, termin ${formatCount(r.termin)}, ${formatDate(r.tanggalPenyaluran)}`,
    nilai: teksNilai(r.nilaiDisalurkan),
    nilaiLabel: "Disalurkan",
    status: <StatusBadge status={r.statusLpj} />,
  }),
  tabel: { judul: "Penyaluran hibah" },
  kosong: {
    judul: "Tidak ada penyaluran pada jendela ini",
    pesan: "Tidak ada termin hibah yang disalurkan pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    {
      label: "Jumlah penyaluran",
      kunci: "Termin",
      nilai: formatCount(d.total.jumlahPenyaluran),
      kedua: { kunci: "Proposal", nilai: formatCount(d.total.jumlahProposal) },
    },
    { label: "Nilai disalurkan", kunci: "Nilai", nilai: <Nilai angka={d.total.nilaiDisalurkan} /> },
    {
      label: "Penerima manfaat",
      kunci: "Orang",
      nilai: formatCount(d.total.penerimaManfaat),
    },
  ],
  catatan: () =>
    "Total penerima manfaat hanya menjumlahkan termin yang sudah menyatakan angkanya. Termin yang belum menyatakan ditulis Belum dinyatakan dan tidak dihitung sebagai nol.",
};

export function PenyaluranNonPumkPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={PENYALURAN_NON_PUMK} />;
}

// ===========================================================================
// 13. Rekap Penyaluran Non PUMK per Bidang
// ===========================================================================

const REKAP_BIDANG: DeklarasiLaporan<LaporanRekapBidang, BarisBidang> = {
  kelompok: KELOMPOK_NON_PUMK,
  judul: "rekap penyaluran Non PUMK per bidang",
  sumber: "GET /api/laporan/rekap-bidang",
  pakaiMode: true,
  ambil: (p) => rekapBidang(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.bidangId ?? r.kode,
  kolom: (d) => [
    { key: "kode", header: "Kode", width: "90px", footer: "Total" },
    { key: "nama", header: "Bidang", render: (r) => <Ringkas teks={r.nama} /> },
    {
      key: "jumlahProgram",
      header: "Jumlah program",
      type: "count",
      width: "140px",
      footer: formatCount(d.total.jumlahProgram),
    },
    {
      key: "nilai",
      header: "Nilai disalurkan",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilai} />,
      footer: <Nilai angka={d.total.nilai} />,
    },
    {
      key: "persenDariTotal",
      header: "Persen dari total",
      type: "percent",
      width: "150px",
      render: (r) => <NilaiPersen nilai={r.persenDariTotal} />,
    },
    {
      key: "anggaran",
      header: "Anggaran",
      type: "money",
      width: "160px",
      render: (r) => <NilaiAtau angka={r.anggaran} kosong="Tidak dianggarkan" />,
      footer: <NilaiAtau angka={d.total.anggaran} kosong="Tidak dianggarkan" />,
    },
    {
      key: "selisih",
      header: "Selisih",
      type: "money",
      width: "160px",
      render: (r) => <NilaiAtau angka={r.selisih} kosong="Tidak dianggarkan" />,
      footer: <NilaiAtau angka={d.total.selisih} kosong="Tidak dianggarkan" />,
    },
    {
      key: "persenCapaian",
      header: "Persen capaian",
      type: "percent",
      width: "140px",
      render: (r) => <NilaiPersen nilai={r.persenCapaian} />,
    },
  ],
  kartu: (r) => ({
    judul: `${r.kode} ${r.nama}`,
    sub: `${formatCount(r.jumlahProgram)} program`,
    meta: r.anggaran === null ? "Tidak dianggarkan" : `Anggaran ${teksNilai(r.anggaran)}`,
    nilai: teksNilai(r.nilai),
    nilaiLabel: "Disalurkan",
  }),
  tabel: { judul: "Penyaluran per bidang" },
  kosong: {
    judul: "Tidak ada penyaluran pada jendela ini",
    pesan: "Tidak ada program Non PUMK yang disalurkan pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah program", kunci: "Program", nilai: formatCount(d.total.jumlahProgram) },
    { label: "Nilai disalurkan", kunci: "Nilai", nilai: <Nilai angka={d.total.nilai} /> },
    {
      label: "Anggaran",
      kunci: "Nilai",
      nilai: <NilaiAtau angka={d.total.anggaran} kosong="Tidak dianggarkan" />,
      kedua: {
        kunci: "Selisih",
        nilai: <NilaiAtau angka={d.total.selisih} kosong="Tidak dianggarkan" />,
      },
    },
    {
      label: "Capaian terhadap anggaran",
      kunci: "Persen",
      nilai: <NilaiPersen nilai={d.total.persenCapaian} />,
    },
  ],
  catatan: (d) =>
    d.rkaId === null
      ? "Tidak ada RKA Non PUMK yang disetujui untuk periode ini, jadi kolom Anggaran, Selisih dan Persen capaian tidak diisi. Kosong berarti tidak ada target, bukan target nol."
      : `Kolom Anggaran dibandingkan terhadap RKA Non PUMK versi ${d.rkaVersi ?? "tidak dinyatakan"} yang berstatus disetujui.`,
};

export function RekapBidangPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={REKAP_BIDANG} />;
}

// ===========================================================================
// 14. Laporan Pemetaan SDGs
// ===========================================================================

const PEMETAAN_SDG: DeklarasiLaporan<LaporanPemetaanSdg, BarisSdg> = {
  kelompok: KELOMPOK_NON_PUMK,
  judul: "laporan pemetaan SDGs",
  sumber: "GET /api/laporan/pemetaan-sdg",
  pakaiMode: true,
  ambil: (p) => pemetaanSdg(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.sdgId ?? `tanpa-${r.nama}`,
  kolom: () => [
    {
      key: "nomor",
      header: "Nomor",
      width: "100px",
      render: (r) => (r.nomor === null ? <span className="sel-kosong">Tidak ada</span> : String(r.nomor)),
    },
    { key: "nama", header: "Tujuan pembangunan berkelanjutan", render: (r) => <Ringkas teks={r.nama} /> },
    { key: "jumlahProgram", header: "Jumlah program", type: "count", width: "150px" },
    { key: "penerimaManfaat", header: "Penerima manfaat", type: "count", width: "170px" },
  ],
  kartu: (r) => ({
    judul: r.nomor === null ? r.nama : `${r.nomor}. ${r.nama}`,
    sub: `${formatCount(r.jumlahProgram)} program`,
    meta: "Penerima manfaat menurut pemetaan program",
    nilai: formatCount(r.penerimaManfaat),
    nilaiLabel: "Penerima manfaat",
  }),
  tabel: { judul: "Program per tujuan SDG" },
  kosong: {
    judul: "Tidak ada program pada jendela ini",
    pesan: "Tidak ada program Non PUMK yang disalurkan pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    {
      label: "Program unik",
      kunci: "Program",
      nilai: formatCount(d.totalProgramUnik),
    },
    {
      label: "Penerima manfaat unik",
      kunci: "Orang",
      nilai: formatCount(d.totalPenerimaManfaatUnik),
    },
  ],
  catatan: () =>
    "Satu program bisa dipetakan ke lebih dari satu tujuan, jadi kolom di tabel di atas sengaja tidak dijumlahkan. Angka unik di bawah tabel menghitung setiap program dan setiap penerima manfaat satu kali saja.",
};

export function PemetaanSdgPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={PEMETAAN_SDG} />;
}

// ===========================================================================
// 15. Laporan Monitoring LPJ
// ===========================================================================

const MONITORING_LPJ: DeklarasiLaporan<LaporanMonitoringLpj, BarisMonitoringLpj> = {
  kelompok: KELOMPOK_NON_PUMK,
  judul: "laporan monitoring LPJ",
  sumber: "GET /api/laporan/monitoring-lpj",
  pakaiMode: true,
  ambil: (p) => monitoringLpjLaporan(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.proposalId,
  kolom: (d) => [
    // Same merge as report 12, and for the same measured reason: nine columns
    // came to 1128px inside a 1092px box, so "Selisih realisasi" was clipped.
    {
      key: "namaPemohon",
      header: "Pemohon",
      width: "200px",
      footer: "Total",
      render: (r) => <SelMitra kode={r.noProposal} nama={r.namaPemohon} />,
    },
    { key: "bidangNama", header: "Bidang", width: "150px", render: (r) => <Ringkas teks={r.bidangNama} /> },
    {
      key: "tanggalSalurTerakhir",
      header: "Salur terakhir",
      width: "140px",
      render: (r) => tanggalAtau(r.tanggalSalurTerakhir, "Belum disalurkan"),
    },
    {
      key: "nilaiDisalurkan",
      header: "Nilai disalurkan",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.nilaiDisalurkan} />,
      footer: <Nilai angka={d.total.nilaiDisalurkan} />,
    },
    {
      key: "statusLpj",
      header: "Status LPJ",
      width: "150px",
      render: (r) => <StatusBadge status={r.statusLpj} />,
    },
    {
      key: "umurHari",
      header: "Umur hari",
      type: "count",
      width: "120px",
      render: (r) => <Cacah nilai={r.umurHari} kosong="Belum berjalan" />,
    },
    {
      key: "jumlahRealisasi",
      header: "Realisasi",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.jumlahRealisasi} />,
      footer: <Nilai angka={d.total.jumlahRealisasi} />,
    },
    {
      key: "selisihRealisasi",
      header: "Selisih realisasi",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.selisihRealisasi} />,
      footer: <Nilai angka={d.total.selisihRealisasi} />,
    },
  ],
  kartu: (r) => ({
    judul: r.judulProgram,
    sub: `${r.noProposal}, ${r.namaPemohon}`,
    meta:
      r.umurHari === null
        ? `${r.bidangNama}, umur belum berjalan`
        : `${r.bidangNama}, umur ${formatCount(r.umurHari)} hari`,
    nilai: teksNilai(r.nilaiDisalurkan),
    nilaiLabel: "Disalurkan",
    status: <StatusBadge status={r.statusLpj} />,
  }),
  tabel: { judul: "Monitoring pertanggungjawaban" },
  kosong: {
    judul: "Tidak ada LPJ yang dipantau pada jendela ini",
    pesan: "Tidak ada proposal Non PUMK yang sudah disalurkan pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah proposal", kunci: "Dokumen", nilai: formatCount(d.total.jumlahProposal) },
    { label: "Nilai disalurkan", kunci: "Nilai", nilai: <Nilai angka={d.total.nilaiDisalurkan} /> },
    {
      label: "Realisasi dilaporkan",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.jumlahRealisasi} />,
      kedua: { kunci: "Selisih", nilai: <Nilai angka={d.total.selisihRealisasi} /> },
    },
  ],
  bagian: (d) => (
    <BagianTabel
      judul="Rekap per status LPJ"
      deskripsi="Proposal yang sama, dihitung menurut status pertanggungjawabannya."
      columns={[
        {
          key: "status",
          header: "Status LPJ",
          width: "200px",
          render: (r) => <StatusBadge status={r.status} />,
        },
        { key: "jumlah", header: "Jumlah proposal", type: "count", width: "160px" },
        {
          key: "nilaiDisalurkan",
          header: "Nilai disalurkan",
          type: "money",
          width: "180px",
          render: (r) => <Nilai angka={r.nilaiDisalurkan} />,
        },
      ]}
      rows={d.perStatus}
      rowKey={(r) => r.status}
      kartu={(r) => ({
        judul: r.status,
        sub: `${formatCount(r.jumlah)} proposal`,
        meta: "Dihitung dari baris di tabel utama",
        nilai: teksNilai(r.nilaiDisalurkan),
        nilaiLabel: "Disalurkan",
        status: <StatusBadge status={r.status} />,
      })}
      kosongJudul="Tidak ada rekap status"
      kosongPesan="Tidak ada proposal yang sudah disalurkan pada jendela ini, jadi tidak ada status yang bisa direkap."
    />
  ),
};

export function MonitoringLpjLaporanPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={MONITORING_LPJ} />;
}

// ===========================================================================
// 21. Rekap Jurnal
// ===========================================================================

const REKAP_JURNAL: DeklarasiLaporan<LaporanRekapJurnal, BarisRekapJurnal> = {
  kelompok: KELOMPOK_AKUNTANSI,
  judul: "rekap jurnal",
  sumber: "GET /api/laporan/rekap-jurnal",
  pakaiMode: true,
  ambil: (p) => rekapJurnal(p),
  baris: (d) => d.baris,
  rowKey: (r) => `${r.jenis}:${r.status}`,
  kolom: (d) => [
    { key: "jenis", header: "Jenis jurnal", width: "200px", footer: "Total semua status" },
    {
      key: "status",
      header: "Status",
      width: "160px",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "jumlahDokumen",
      header: "Jumlah dokumen",
      type: "count",
      width: "160px",
      footer: formatCount(d.total.jumlahDokumen),
    },
    {
      key: "totalDebit",
      header: "Total debit",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.totalDebit} />,
      footer: <Nilai angka={d.total.totalDebit} />,
    },
    {
      key: "totalKredit",
      header: "Total kredit",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.totalKredit} />,
      footer: <Nilai angka={d.total.totalKredit} />,
    },
  ],
  kartu: (r) => ({
    judul: r.jenis,
    sub: `${formatCount(r.jumlahDokumen)} dokumen`,
    meta: `Kredit ${teksNilai(r.totalKredit)}`,
    nilai: teksNilai(r.totalDebit),
    nilaiLabel: "Debit",
    status: <StatusBadge status={r.status} />,
  }),
  tabel: { judul: "Jurnal per jenis dan status" },
  kosong: {
    judul: "Tidak ada jurnal pada jendela ini",
    pesan: "Tidak ada dokumen jurnal yang tercatat pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    {
      label: "Seluruh dokumen",
      kunci: "Dokumen",
      nilai: formatCount(d.total.jumlahDokumen),
    },
    {
      label: "Seluruh nilai",
      kunci: "Debit",
      nilai: <Nilai angka={d.total.totalDebit} />,
      kedua: { kunci: "Kredit", nilai: <Nilai angka={d.total.totalKredit} /> },
    },
    {
      label: "Sudah terbukukan",
      kunci: "Dokumen",
      nilai: formatCount(d.totalTerbukukan.jumlahDokumen),
    },
    {
      label: "Nilai terbukukan",
      kunci: "Debit",
      nilai: <Nilai angka={d.totalTerbukukan.totalDebit} />,
      kedua: { kunci: "Kredit", nilai: <Nilai angka={d.totalTerbukukan.totalKredit} /> },
    },
  ],
  bagian: (d) => (
    <BagianTabel
      judul="Rekap per jenis jurnal"
      deskripsi="Dokumen yang sama, digabung lintas status, sehingga satu jenis jurnal muncul satu kali."
      columns={[
        { key: "jenis", header: "Jenis jurnal", width: "220px" },
        { key: "jumlahDokumen", header: "Jumlah dokumen", type: "count", width: "160px" },
        {
          key: "totalDebit",
          header: "Total debit",
          type: "money",
          width: "180px",
          render: (r) => <Nilai angka={r.totalDebit} />,
        },
        {
          key: "totalKredit",
          header: "Total kredit",
          type: "money",
          width: "180px",
          render: (r) => <Nilai angka={r.totalKredit} />,
        },
      ]}
      rows={d.perJenis}
      rowKey={(r) => r.jenis}
      kartu={(r) => ({
        judul: r.jenis,
        sub: `${formatCount(r.jumlahDokumen)} dokumen`,
        meta: `Kredit ${teksNilai(r.totalKredit)}`,
        nilai: teksNilai(r.totalDebit),
        nilaiLabel: "Debit",
      })}
      kosongJudul="Tidak ada jenis jurnal"
      kosongPesan="Tidak ada dokumen jurnal pada periode dan cabang yang dipilih."
    />
  ),
  catatan: () =>
    "Total debit dan total kredit yang sudah terbukukan wajib sama. Baris berstatus draft dan terverifikasi ikut ditampilkan supaya dokumen yang belum diposting tetap terlihat, dan angkanya tidak masuk ke total terbukukan.",
};

export function RekapJurnalPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={REKAP_JURNAL} />;
}

// ===========================================================================
// 25 and 26. Laporan Portal PUMK dan Portal Non PUMK
//
// TWO SCREENS, ONE DECLARATION BUILDER. The specification numbers them
// separately and they answer two different endpoints, so they are two menu
// entries and two pages; the shape they share is a function, not a query
// parameter on one page.
// ===========================================================================

const SUMBER_NILAI: Record<string, string> = {
  PROPOSAL: "Nilai dari proposal hasil konversi",
  DATA_JSON: "Nilai dari formulir pengajuan",
  TIDAK_ADA: "Pengajuan tidak menyebutkan nilai",
};

function portalDeklarasi(
  jenis: "PUMK" | "NON_PUMK",
  ambil: (p: { periodeId: string; cabangId: string | null; mode: "BULANAN" | "KUMULATIF_YTD" }) => Promise<LaporanPortal>,
  sumber: string,
): DeklarasiLaporan<LaporanPortal, BarisPortal> {
  const label = jenis === "PUMK" ? "PUMK" : "Non PUMK";
  return {
    kelompok: KELOMPOK_LAINNYA,
    judul: `laporan portal ${label}`,
    sumber,
    pakaiMode: true,
    ambil,
    baris: (d) => d.baris,
    rowKey: (r) => r.submissionId,
    kolom: (d) => [
      { key: "noTiket", header: "Nomor tiket", width: "180px", footer: "Total" },
      {
        key: "tanggalSubmit",
        header: "Tanggal masuk",
        type: "date",
        width: "140px",
        sortable: true,
      },
      { key: "pemohon", header: "Pemohon", render: (r) => <Ringkas teks={r.pemohon} /> },
      {
        key: "nilaiDiajukan",
        header: "Nilai diajukan",
        type: "money",
        width: "180px",
        render: (r) => <NilaiAtau angka={r.nilaiDiajukan} kosong="Tidak dinyatakan" />,
        footer: <Nilai angka={d.total.nilaiDiajukan} />,
      },
      {
        key: "sumberNilai",
        header: "Sumber nilai",
        width: "200px",
        render: (r) => <Ringkas teks={SUMBER_NILAI[r.sumberNilai] ?? r.sumberNilai} />,
      },
      {
        key: "status",
        header: "Status",
        width: "150px",
        render: (r) => <StatusBadge status={r.status} />,
      },
      {
        key: "sudahDikonversi",
        header: "Konversi",
        width: "180px",
        render: (r) =>
          r.sudahDikonversi ? (
            <span>{r.noProposal ?? "Sudah dikonversi"}</span>
          ) : (
            <span className="sel-kosong">Belum dikonversi</span>
          ),
      },
    ],
    kartu: (r) => ({
      judul: r.noTiket,
      sub: r.pemohon,
      meta: `${formatDate(r.tanggalSubmit)}, ${r.sudahDikonversi ? (r.noProposal ?? "sudah dikonversi") : "belum dikonversi"}`,
      nilai: r.nilaiDiajukan === null ? "Tidak dinyatakan" : teksNilai(r.nilaiDiajukan),
      nilaiLabel: "Diajukan",
      status: <StatusBadge status={r.status} />,
    }),
    tabel: { judul: `Pengajuan portal ${label}` },
    kosong: {
      judul: "Tidak ada pengajuan pada jendela ini",
      pesan: `Tidak ada pengajuan ${label} yang masuk lewat portal publik pada periode yang dipilih.`,
    },
    total: (d) => [
      {
        label: "Jumlah pengajuan",
        kunci: "Tiket",
        nilai: formatCount(d.total.jumlahSubmission),
        kedua: { kunci: "Dikonversi", nilai: formatCount(d.total.jumlahDikonversi) },
      },
      { label: "Nilai diajukan", kunci: "Nilai", nilai: <Nilai angka={d.total.nilaiDiajukan} /> },
    ],
    bagian: (d) => (
      <BagianTabel
        judul="Rekap per status"
        deskripsi="Pengajuan yang sama, dihitung menurut status penanganannya."
        columns={[
          {
            key: "status",
            header: "Status",
            width: "220px",
            render: (r) => <StatusBadge status={r.status} />,
          },
          { key: "jumlah", header: "Jumlah pengajuan", type: "count", width: "180px" },
        ]}
        rows={d.perStatus}
        rowKey={(r) => r.status}
        kartu={(r) => ({
          judul: r.status,
          sub: `${formatCount(r.jumlah)} pengajuan`,
          meta: "Dihitung dari baris di tabel utama",
          status: <StatusBadge status={r.status} />,
        })}
        kosongJudul="Tidak ada rekap status"
        kosongPesan="Tidak ada pengajuan pada jendela ini, jadi tidak ada status yang bisa direkap."
      />
    ),
    catatan: () =>
      "Total nilai diajukan hanya menjumlahkan pengajuan yang benar benar menyebutkan nilainya. Pengajuan yang tidak menyebutkan ditulis Tidak dinyatakan dan tidak dihitung sebagai nol.",
  };
}

const PORTAL_PUMK = portalDeklarasi("PUMK", portalPumk, "GET /api/laporan/portal-pumk");
const PORTAL_NON_PUMK = portalDeklarasi(
  "NON_PUMK",
  portalNonPumk,
  "GET /api/laporan/portal-non-pumk",
);

export function PortalPumkPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={PORTAL_PUMK} />;
}

export function PortalNonPumkPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={PORTAL_NON_PUMK} />;
}

// ===========================================================================
// 28. Laporan Perhitungan Penyisihan
// ===========================================================================

const PERHITUNGAN_PENYISIHAN: DeklarasiLaporan<
  LaporanPerhitunganPenyisihan,
  BarisPerhitunganPenyisihan
> = {
  kelompok: KELOMPOK_LAINNYA,
  judul: "laporan perhitungan penyisihan",
  sumber: "GET /api/laporan/perhitungan-penyisihan",
  ambil: (p) => perhitunganPenyisihan(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.akadId,
  kolom: (d) => [
    { key: "noAkad", header: "No akad", width: "170px", footer: "Total" },
    {
      key: "namaMitra",
      header: "Mitra Binaan",
      width: "200px",
      render: (r) => <SelMitra kode={r.kodeMitra} nama={r.namaMitra} />,
    },
    {
      key: "outstandingPokok",
      header: "Outstanding pokok",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.outstandingPokok} />,
      footer: <Nilai angka={d.total.outstandingPokok} />,
    },
    {
      key: "tunggakanPokok",
      header: "Tunggakan pokok",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.tunggakanPokok} />,
    },
    { key: "hariTunggakan", header: "Hari tunggakan", type: "count", width: "150px" },
    {
      key: "klasifikasi",
      header: "Klasifikasi",
      width: "160px",
      render: (r) => <StatusBadge status={r.klasifikasi} />,
    },
    {
      key: "ratePenyisihan",
      header: "Rate penyisihan",
      type: "percent",
      width: "150px",
      render: (r) => <NilaiPersen nilai={r.ratePenyisihan} />,
    },
    {
      key: "dasarPerhitungan",
      header: "Dasar perhitungan",
      width: "180px",
      render: (r) => <Ringkas teks={r.dasarPerhitungan} />,
    },
    {
      key: "nilaiPenyisihan",
      header: "Nilai penyisihan",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.nilaiPenyisihan} />,
      footer: <Nilai angka={d.total.nilaiPenyisihan} />,
    },
  ],
  kartu: (r) => ({
    judul: `${r.kodeMitra} ${r.namaMitra}`,
    sub: `${r.noAkad}, tunggakan ${formatCount(r.hariTunggakan)} hari`,
    meta: `Rate ${r.ratePenyisihan}%, dasar ${r.dasarPerhitungan}`,
    nilai: teksNilai(r.nilaiPenyisihan),
    nilaiLabel: "Penyisihan",
    status: <StatusBadge status={r.klasifikasi} />,
  }),
  tabel: { judul: "Perhitungan penyisihan per akad" },
  kosong: {
    judul: "Belum ada snapshot kolektibilitas",
    pesan:
      "Periode dan cabang yang dipilih belum punya hasil closing kolektibilitas, jadi tidak ada akad yang bisa dihitung penyisihannya.",
  },
  total: (d) => [
    { label: "Jumlah akad", kunci: "Akad", nilai: formatCount(d.total.jumlahAkad) },
    {
      label: "Outstanding pokok",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.outstandingPokok} />,
    },
    {
      label: "Nilai penyisihan",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.nilaiPenyisihan} />,
    },
    {
      label: "Dibandingkan hasil closing",
      kunci: "Dibutuhkan",
      nilai: (
        <NilaiAtau angka={d.penyisihanDibutuhkanRun} kosong="Closing belum dijalankan" />
      ),
      kedua: {
        kunci: "Selisih",
        nilai: <NilaiAtau angka={d.selisihTerhadapRun} kosong="Closing belum dijalankan" />,
      },
    },
  ],
  bagian: (d) => (
    <BagianTabel
      judul="Rekap per klasifikasi"
      deskripsi="Akad yang sama, dijumlahkan menurut kelas kualitas piutangnya."
      columns={[
        {
          key: "klasifikasi",
          header: "Klasifikasi",
          width: "200px",
          render: (r) => <StatusBadge status={r.klasifikasi} label={r.nama} />,
        },
        { key: "jumlahAkad", header: "Jumlah akad", type: "count", width: "140px" },
        {
          key: "outstandingPokok",
          header: "Outstanding pokok",
          type: "money",
          width: "190px",
          render: (r) => <Nilai angka={r.outstandingPokok} />,
        },
        {
          key: "nilaiPenyisihan",
          header: "Nilai penyisihan",
          type: "money",
          width: "180px",
          render: (r) => <Nilai angka={r.nilaiPenyisihan} />,
        },
      ]}
      rows={d.perKlasifikasi}
      rowKey={(r) => r.klasifikasi}
      kartu={(r) => ({
        judul: r.nama,
        sub: `${formatCount(r.jumlahAkad)} akad`,
        meta: `Outstanding ${teksNilai(r.outstandingPokok)}`,
        nilai: teksNilai(r.nilaiPenyisihan),
        nilaiLabel: "Penyisihan",
        status: <StatusBadge status={r.klasifikasi} label={r.nama} />,
      })}
      kosongJudul="Tidak ada rekap klasifikasi"
      kosongPesan="Tidak ada akad pada snapshot periode ini, jadi tidak ada klasifikasi yang bisa direkap."
    />
  ),
  catatan: () =>
    "Rate dan dasar perhitungan pada setiap baris adalah nilai yang benar benar dipakai saat closing kolektibilitas, dibaca dari barisnya sendiri, bukan parameter yang berlaku hari ini.",
};

export function PerhitunganPenyisihanPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={PERHITUNGAN_PENYISIHAN} />;
}

// ===========================================================================
// 29. Laporan Beban Penyisihan
// ===========================================================================

const BEBAN_PENYISIHAN: DeklarasiLaporan<LaporanBebanPenyisihan, BarisBebanPenyisihan> = {
  kelompok: KELOMPOK_LAINNYA,
  judul: "laporan beban penyisihan",
  sumber: "GET /api/laporan/beban-penyisihan",
  pakaiMode: true,
  ambil: (p) => bebanPenyisihan(p),
  baris: (d) => d.baris,
  rowKey: (r) => `${r.periodeId}:${r.cabangId}`,
  kolom: (d) => [
    // The period and the branch are one row identity, in one column, for the
    // reason `SelMitra` exists: nine columns did not fit, and "Selisih terhadap
    // jurnal" was the one falling off the edge.
    {
      key: "label",
      header: "Periode dan cabang",
      width: "220px",
      footer: "Total",
      render: (r) => <SelMitra kode={r.namaCabang} nama={r.label} />,
    },
    {
      key: "statusPeriode",
      header: "Status periode",
      width: "150px",
      render: (r) => <StatusBadge status={r.statusPeriode} />,
    },
    {
      key: "saldoAwal",
      header: "Saldo awal",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.saldoAwal} />,
      footer: <Nilai angka={d.total.saldoAwal} />,
    },
    {
      key: "penyisihanDibutuhkan",
      header: "Penyisihan dibutuhkan",
      type: "money",
      width: "190px",
      render: (r) => <Nilai angka={r.penyisihanDibutuhkan} />,
    },
    {
      key: "bebanPeriode",
      header: "Beban periode",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.bebanPeriode} />,
      footer: <Nilai angka={d.total.bebanPeriode} />,
    },
    {
      key: "saldoAkhir",
      header: "Saldo akhir",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.saldoAkhir} />,
      footer: <Nilai angka={d.total.saldoAkhir} />,
    },
    {
      key: "jurnal",
      header: "Jurnal terkait",
      width: "200px",
      render: (r) => (
        <Ringkas
          teks={
            r.jurnal.length === 0
              ? "Belum ada jurnal"
              : r.jurnal.map((j) => j.noJurnal).join(", ")
          }
        />
      ),
    },
    {
      key: "selisihTautanJurnal",
      header: "Selisih terhadap jurnal",
      type: "money",
      width: "190px",
      render: (r) => <Nilai angka={r.selisihTautanJurnal} />,
    },
  ],
  kartu: (r) => ({
    judul: `${r.label}, ${r.namaCabang}`,
    sub: `Saldo awal ${teksNilai(r.saldoAwal)}, saldo akhir ${teksNilai(r.saldoAkhir)}`,
    meta:
      r.jurnal.length === 0
        ? "Belum ada jurnal penyisihan"
        : `Jurnal ${r.jurnal.map((j) => j.noJurnal).join(", ")}`,
    nilai: teksNilai(r.bebanPeriode),
    nilaiLabel: "Beban periode",
    status: <StatusBadge status={r.statusPeriode} />,
  }),
  tabel: { judul: "Beban penyisihan per periode" },
  kosong: {
    judul: "Belum ada beban penyisihan",
    pesan:
      "Belum ada closing kolektibilitas yang membentuk beban penyisihan pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Saldo awal", kunci: "Nilai", nilai: <Nilai angka={d.total.saldoAwal} /> },
    { label: "Beban periode", kunci: "Nilai", nilai: <Nilai angka={d.total.bebanPeriode} /> },
    { label: "Saldo akhir", kunci: "Nilai", nilai: <Nilai angka={d.total.saldoAkhir} /> },
  ],
  catatan: () =>
    "Kolom Selisih terhadap jurnal membandingkan beban periode dengan nilai jurnal penyisihan yang benar benar terbukukan. Selisih selain nol berarti ada beban yang belum berjurnal, dan itu perlu ditelusuri sebelum periode ditutup.",
};

export function BebanPenyisihanPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={BEBAN_PENYISIHAN} />;
}

// ===========================================================================
// 30. Laporan Akrual Piutang Jasa Administrasi
// ===========================================================================

const AKRUAL_JASA: DeklarasiLaporan<LaporanAkrualJasa, BarisAkrualJasa> = {
  kelompok: KELOMPOK_LAINNYA,
  judul: "laporan akrual piutang jasa administrasi",
  sumber: "GET /api/laporan/akrual-jasa",
  ambil: (p) => akrualJasa(p),
  baris: (d) => d.baris,
  rowKey: (r) => r.akadId,
  kolom: (d) => [
    { key: "noAkad", header: "No akad", width: "170px", footer: "Total" },
    {
      key: "namaMitra",
      header: "Mitra Binaan",
      width: "200px",
      render: (r) => <SelMitra kode={r.kodeMitra} nama={r.namaMitra} />,
    },
    {
      key: "kolektibilitas",
      header: "Kolektibilitas",
      width: "160px",
      render: (r) => <StatusBadge status={r.kolektibilitas} />,
    },
    {
      key: "jasaJatuhTempoPeriode",
      header: "Jasa jatuh tempo",
      type: "money",
      width: "180px",
      render: (r) => <Nilai angka={r.jasaJatuhTempoPeriode} />,
      footer: <Nilai angka={d.total.jatuhTempo} />,
    },
    {
      key: "jasaDiterimaPeriode",
      header: "Jasa diterima",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.jasaDiterimaPeriode} />,
      footer: <Nilai angka={d.total.diterima} />,
    },
    {
      key: "jasaDiakrual",
      header: "Jasa diakrual",
      type: "money",
      width: "170px",
      render: (r) => <Nilai angka={r.jasaDiakrual} />,
      footer: <Nilai angka={d.total.diakrual} />,
    },
    { key: "metode", header: "Metode akrual", width: "170px", render: (r) => <Ringkas teks={r.metode} /> },
  ],
  kartu: (r) => ({
    judul: `${r.kodeMitra} ${r.namaMitra}`,
    sub: `${r.noAkad}, metode ${r.metode}`,
    meta: `Jatuh tempo ${teksNilai(r.jasaJatuhTempoPeriode)}, diterima ${teksNilai(r.jasaDiterimaPeriode)}`,
    nilai: teksNilai(r.jasaDiakrual),
    nilaiLabel: "Diakrual",
    status: <StatusBadge status={r.kolektibilitas} />,
  }),
  tabel: { judul: "Akrual jasa administrasi per akad" },
  kosong: {
    judul: "Tidak ada akrual pada periode ini",
    pesan: "Tidak ada akad dengan jasa administrasi jatuh tempo pada periode dan cabang yang dipilih.",
  },
  total: (d) => [
    { label: "Jumlah akad", kunci: "Akad", nilai: formatCount(d.total.jumlahAkad) },
    {
      label: "Jasa jatuh tempo",
      kunci: "Nilai",
      nilai: <Nilai angka={d.total.jatuhTempo} />,
      kedua: { kunci: "Diterima", nilai: <Nilai angka={d.total.diterima} /> },
    },
    { label: "Jasa diakrual", kunci: "Nilai", nilai: <Nilai angka={d.total.diakrual} /> },
  ],
  catatan: (d) =>
    `Metode akrual yang dipakai pada periode ini: ${d.metode.length === 0 ? "tidak ada" : d.metode.join(", ")}. Metode dicatat pada barisnya sendiri, jadi laporan lama tetap membaca metode yang berlaku saat itu.`,
};

export function AkrualJasaPage({ route }: { route: PageRoute }) {
  return <LaporanTabel route={route} deklarasi={AKRUAL_JASA} />;
}
