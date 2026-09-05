// The shaper, the HTML, and the PDF adapter's refusals.
//
// The route-level proof (branch scope, closed periods, the permission) lives in
// modules/laporan/laporan-ekspor.test.ts, which drives the real app. This file
// pins the RULES the shaper follows, because those are what decide whether a
// figure survives the trip out of the system intact.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dokumenDariLaporan, judulDariKunci, lembarDariDokumen } from "./dokumen";
import { formatDesimal, htmlDariDokumen, loloskanHtml } from "./html";
import { createPdfChromiumAdapter, cariChromium } from "../adapters/pdf-chromium";
import { KesalahanPdf } from "../ports/pdf";
import { bacaTabelXlsx } from "../xlsx/baca";
import { tulisXlsx } from "../xlsx/tulis";

const HEADER = {
  namaBumn: "PT Contoh (Persero)",
  namaLaporan: "Aging Piutang Mitra Binaan",
  periodeLabel: "Maret 2026",
  periodeId: "p1",
  statusPeriode: "CLOSED",
  dariTanggal: "2026-03-01",
  sampaiTanggal: "2026-03-31",
  cabangId: null,
  namaCabang: "Semua Cabang",
  tanggalCetak: "2026-04-02",
  dicetakOleh: "Sri Rahayu",
  sumberData: "SNAPSHOT_PERIODE",
};

const uang = (n: string): { nilai: string; tampil: string } => ({ nilai: n, tampil: n });

const HASIL = {
  header: HEADER,
  mode: "BULANAN",
  baris: [
    {
      mitraId: "11111111-1111-4111-8111-111111111111",
      kodeMitra: "M-001",
      namaMitra: "PT Maju Jaya",
      jumlahHari: 45,
      outstanding: uang("1500000.00"),
      persenDariTotal: "33.33",
      jatuhTempo: "2026-02-14",
      bucket: { LANCAR: uang("1000000.00"), MACET: uang("500000.00") },
    },
    {
      mitraId: "22222222-2222-4222-8222-222222222222",
      kodeMitra: "M-002",
      namaMitra: "=cmd|' /c calc'!A1",
      jumlahHari: 0,
      outstanding: uang("0.00"),
      persenDariTotal: null,
      jatuhTempo: null,
      bucket: { LANCAR: uang("0.00"), MACET: uang("0.00") },
    },
  ],
  total: { jumlahMitra: 2, outstanding: uang("1500000.00") },
};

describe("aturan pembentukan dokumen", () => {
  const dok = dokumenDariLaporan(HASIL, "Aging Piutang");

  test("header laporan jadi header dokumen, bukan tabel", () => {
    expect(dok.header.namaLaporan).toBe("Aging Piutang Mitra Binaan");
    expect(dok.header.sumberData).toBe("SNAPSHOT_PERIODE");
    expect(dok.header.statusPeriode).toBe("CLOSED");
    // A top-level scalar is a fact about how the figures were produced, so it
    // belongs with the header rather than in a one-cell table.
    expect(dok.header.tambahan).toContainEqual({ label: "Mode", nilai: "BULANAN" });
  });

  test("array jadi lembar, objek jadi Ringkasan", () => {
    expect(dok.tabel.map((t) => t.judul)).toEqual(["Aging Piutang", "Ringkasan"]);
    expect(dok.tabel[1]!.baris.map((b) => b[0]?.teks)).toEqual([
      "Total Jumlah Mitra",
      "Total Outstanding",
    ]);
  });

  test("kolom id dipindah ke ujung kanan, tidak dibuang", () => {
    // Traceability survives (spec 11), without an accountant reading past 36
    // hex characters to reach the name.
    const kolom = dok.tabel[0]!.kolom;
    expect(kolom[0]).toBe("Kode Mitra");
    expect(kolom[kolom.length - 1]).toBe("Mitra Id");
  });

  test("Record<string, Angka> jadi kolom sendiri, satu per kunci", () => {
    expect(dok.tabel[0]!.kolom).toContain("Bucket LANCAR");
    expect(dok.tabel[0]!.kolom).toContain("Bucket MACET");
  });

  test("Angka jadi sel ANGKA yang membawa `nilai`, bukan `tampil`", () => {
    const i = dok.tabel[0]!.kolom.indexOf("Outstanding");
    const sel = dok.tabel[0]!.baris[0]![i]!;
    expect(sel.jenis).toBe("uang");
    // The exact decimal string. `tampil` is a formatted display value and a
    // column of it is a column nobody can sum.
    expect(sel.desimal).toBe("1500000.00");
    expect(sel.teks).toBeUndefined();
  });

  test("persen, tanggal, cacah dan null masing-masing jadi jenis selnya sendiri", () => {
    const k = dok.tabel[0]!.kolom;
    const b0 = dok.tabel[0]!.baris[0]!;
    const b1 = dok.tabel[0]!.baris[1]!;
    expect(b0[k.indexOf("Persen Dari Total")]!.jenis).toBe("persen");
    expect(b0[k.indexOf("Jatuh Tempo")]!.jenis).toBe("tanggal");
    expect(b0[k.indexOf("Jumlah Hari")]!.jenis).toBe("angka");
    // Null is EMPTY, not zero: "33.33% of nothing" and "no answer" are
    // different facts and a spreadsheet that showed 0 would average them in.
    expect(b1[k.indexOf("Persen Dari Total")]!.jenis).toBe("kosong");
    expect(b1[k.indexOf("Jatuh Tempo")]!.jenis).toBe("kosong");
  });

  test("judulDariKunci membaca camelCase dan titik", () => {
    expect(judulDariKunci("jumlahPenyaluran")).toBe("Jumlah Penyaluran");
    expect(judulDariKunci("bucket.DPK")).toBe("Bucket DPK");
    expect(judulDariKunci("total.outstandingJasa")).toBe("Total Outstanding Jasa");
  });
});

// ---------------------------------------------------------------------------
// Rules 5 to 7: what a statement handed to management may and may not carry
// ---------------------------------------------------------------------------

/**
 * A statement shaped exactly as `modules/laporan` returns one: template
 * machinery on every line, the two comparative figures, and three per-section
 * subsets built by FILTERING the same array, which is what makes them the same
 * objects.
 */
const BARIS_STATEMENT = [
  {
    barisLaporanId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kode: "ASET",
    nama: "ASET",
    parentKode: null,
    urutan: 1,
    level: 1,
    tipeBaris: "HEADER",
    seksi: "ASET",
    tanda: 1,
    cetakTebal: true,
    akunKode: [] as string[],
    nilaiTahunIni: uang("0.00"),
    nilaiTahunLalu: uang("0.00"),
  },
  {
    barisLaporanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kode: "KAS",
    nama: "Kas dan Setara Kas",
    parentKode: "ASET",
    urutan: 2,
    level: 2,
    tipeBaris: "DETAIL",
    seksi: "ASET",
    tanda: 1,
    cetakTebal: false,
    akunKode: ["1.1.01", "1.1.02"],
    nilaiTahunIni: uang("1500000.00"),
    nilaiTahunLalu: uang("1200000.00"),
  },
  {
    barisLaporanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    kode: "TOTAL_ASET",
    nama: "Total Aset",
    parentKode: null,
    urutan: 3,
    level: 1,
    tipeBaris: "TOTAL",
    seksi: "ASET",
    tanda: 1,
    cetakTebal: true,
    akunKode: [] as string[],
    nilaiTahunIni: uang("1500000.00"),
    nilaiTahunLalu: uang("1200000.00"),
  },
];

const POSISI = {
  header: { ...HEADER, namaLaporan: "Laporan Posisi Keuangan" },
  kolom: { labelTahunIni: "2026", labelTahunLalu: "2025" },
  baris: BARIS_STATEMENT,
  barisAset: BARIS_STATEMENT.filter((b) => b.seksi === "ASET"),
  barisLiabilitas: BARIS_STATEMENT.filter((b) => b.seksi === "LIABILITAS"),
  totalAsetTahunIni: uang("1500000.00"),
};

describe("laporan keuangan yang diserahkan ke manajemen (spec 16 skenario 20)", () => {
  const dok = dokumenDariLaporan(POSISI, "Posisi Keuangan");
  const utama = dok.tabel[0]!;

  test("aturan 5: kolom mesin template tidak ikut tercetak", () => {
    // Nine columns before the first figure, every one of them a column of
    // `baris_laporan` rather than a fact about the entity.
    for (const kolom of [
      "Baris Laporan Id",
      "Parent Kode",
      "Urutan",
      "Level",
      "Tipe Baris",
      "Seksi",
      "Tanda",
      "Cetak Tebal",
    ]) {
      expect([kolom, utama.kolom.includes(kolom)]).toEqual([kolom, false]);
    }
  });

  test("yang tinggal adalah laporannya: kode baris, uraian, akun sumbernya, dan dua kolom banding", () => {
    expect(utama.judul).toBe("Posisi Keuangan");
    expect(utama.kolom).toEqual(["Kode", "Nama", "Akun Kode", "Nilai Tahun Ini", "Nilai Tahun Lalu"]);
    // `akunKode` USED TO VANISH ENTIRELY: an array of scalars went to the child
    // table builder, which filters for objects, finds none and emits nothing.
    // It is the drill-down, so it is now one comma-joined cell on its own line.
    expect(utama.baris[1]![2]).toEqual({ jenis: "teks", teks: "1.1.01, 1.1.02", tebal: false });
    // An empty list is empty, not the string "[]".
    expect(utama.baris[0]![2]!.jenis).toBe("kosong");
  });

  test("aturan 6: level jadi indentasi dan cetakTebal jadi tebal, bukan kolom", () => {
    const nama = utama.baris.map((r) => r[1]!.teks);
    // Relative to the table's own shallowest row, so a template whose levels
    // start at 1 does not put a margin on everything.
    expect(nama[0]).toBe("ASET");
    expect(nama[2]).toBe("Total Aset");
    // Non-breaking spaces: an ordinary leading space collapses in HTML, which
    // is the copy that gets printed and handed over.
    expect(nama[1]).toBe("\u00a0\u00a0\u00a0Kas dan Setara Kas");
    // Bold is a property of the whole ROW, which is what a total line is.
    expect(utama.baris.map((r) => r.every((c) => c.tebal === true))).toEqual([true, false, true]);
  });

  test("aturan 7: himpunan bagian yang hanya mengulang laporan yang sama tidak dicetak lagi", () => {
    // `barisAset` is `baris.filter(...)`, so its rows ARE `baris`'s rows: the
    // same objects, printed a second time under a second heading. Identity is
    // the test, so nothing that merely looks similar is ever suppressed.
    expect(dok.tabel.map((t) => t.judul)).not.toContain("Baris Aset");
    // An EMPTY subset still gets its "(kosong)" table: "this section has no
    // lines" is an answer, and there are no rows to recognise as repeats.
    expect(dok.tabel.map((t) => t.judul)).toContain("Baris Liabilitas");
  });

  test("indentasi dan penebalan tidak merusak netralisasi formula maupun pelolosan HTML", () => {
    const html = htmlDariDokumen(dok);
    expect(html).toContain("<td>\u00a0\u00a0\u00a0Kas dan Setara Kas</td>");
    expect(html).toContain('<td class="b">Total Aset</td>');
    // U+00A0 is not one of the five characters escaped and not one of the six
    // a spreadsheet evaluates, so an indented caption is neither mangled nor
    // prefixed with an apostrophe.
    expect(html).not.toContain("&#39;\u00a0");
  });
});

describe("workbook yang dihasilkan", () => {
  const berkas = tulisXlsx(lembarDariDokumen(dokumenDariLaporan(HASIL, "Aging Piutang")));

  test("lembar pertama adalah Header, supaya menyortir kolom tidak rusak", () => {
    const tabel = bacaTabelXlsx(berkas);
    expect(tabel.namaLembar).toBe("Header");
    const baris = tabel.baris;
    expect(baris[0]![0]).toBe("PT Contoh (Persero)");
    expect(baris.find((r) => r[0] === "Sumber data")?.[1]).toBe("SNAPSHOT_PERIODE");
    expect(baris.find((r) => r[0] === "Dicetak oleh")?.[1]).toBe("Sri Rahayu");
    expect(baris.find((r) => r[0] === "Tanggal cetak")?.[1]).toBe("2026-04-02");
  });
});

describe("HTML", () => {
  const html = htmlDariDokumen(dokumenDariLaporan(HASIL, "Aging Piutang"));

  test("mandiri sepenuhnya: tidak ada script, gambar, link, atau URL apa pun", () => {
    for (const dilarang of ["<script", "<img", "<link", "<iframe", "http://", "https://", "url("]) {
      expect(`${dilarang}: ${html.includes(dilarang)}`).toBe(`${dilarang}: false`);
    }
  });

  test("payload formula dinetralkan di HTML juga, karena tabel HTML disalin ke Excel", () => {
    expect(html).toContain("&#39;=cmd|&#39; /c calc&#39;!A1");
  });

  test("lima karakter dilepas, termasuk apostrof", () => {
    expect(loloskanHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("pemisah ribuan dihitung dari STRING desimal, bukan lewat Number", () => {
    expect(formatDesimal("1500000.00")).toBe("1.500.000,00");
    expect(formatDesimal("-250000.50")).toBe("-250.000,50");
    expect(formatDesimal("0.30")).toBe("0,30");
    // The value a JS float destroys. It survives here because no float is
    // constructed: 999999999999999.99 is not representable as a double.
    expect(formatDesimal("999999999999999.99")).toBe("999.999.999.999.999,99");
  });

  test("angka tampil rata kanan, teks tidak", () => {
    expect(html).toContain('<td class="n">1.500.000,00</td>');
  });
});

describe("adapter PDF: apa yang terjadi kalau tidak ada browser", () => {
  test("tanpa CHROMIUM_PATH, tersedia() false dan permintaan ditolak dengan sebab TIDAK_TERSEDIA", async () => {
    const pdf = createPdfChromiumAdapter({ executablePath: null });
    expect(pdf.tersedia()).toBe(false);
    let sebab = "";
    try {
      await pdf.dariHtml("<html></html>");
    } catch (err) {
      sebab = err instanceof KesalahanPdf ? err.sebab : "bukan KesalahanPdf";
    }
    expect(sebab).toBe("TIDAK_TERSEDIA");
  });

  test("cariChromium hanya membaca CHROMIUM_PATH, tidak menebak", () => {
    expect(cariChromium({} as NodeJS.ProcessEnv)).toBeNull();
    expect(cariChromium({ CHROMIUM_PATH: "/tidak/ada/chrome" } as NodeJS.ProcessEnv)).toBeNull();
  });
});

// The real renderer, only where a browser has been named. CI has none, and
// that is the point of `skipIf`: a suite that silently rendered PDFs on a
// laptop and skipped them on the server would prove nothing about either.
const CHROME = cariChromium();

describe.skipIf(!CHROME || !existsSync(CHROME))("adapter PDF dengan Chromium sungguhan", () => {
  test("HTML laporan jadi PDF yang sah, dan halamannya tidak boleh ke jaringan", async () => {
    const pdf = createPdfChromiumAdapter({ executablePath: CHROME });
    try {
      const html = htmlDariDokumen(dokumenDariLaporan(HASIL, "Aging Piutang"));
      const keluar = await pdf.dariHtml(html);
      // `%PDF-`, the magic every reader checks.
      expect(new TextDecoder().decode(keluar.subarray(0, 5))).toBe("%PDF-");
      expect(keluar.length).toBeGreaterThan(1000);

      // A document that TRIES to fetch still renders, because the request is
      // aborted rather than waited on. Without the interception this would
      // hang until the timeout.
      const jahat =
        '<html><body><img src="http://169.254.169.254/latest/meta-data/">' +
        '<script>document.title="x"</script>halo</body></html>';
      const kedua = await pdf.dariHtml(jahat, { batasWaktuMs: 10_000 });
      expect(new TextDecoder().decode(kedua.subarray(0, 5))).toBe("%PDF-");
    } finally {
      await pdf.tutup();
    }
  }, 60_000);
});
