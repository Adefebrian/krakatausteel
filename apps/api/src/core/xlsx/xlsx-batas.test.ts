// EVERY CAP, FIRED BY A CRAFTED ARCHIVE.
//
// A limit nobody has watched refuse something is a comment. So each test below
// BUILDS the archive that breaks one cap -- by hand, byte by byte, because
// none of these files can be produced by Excel and therefore none of them can
// be a fixture checked in from a real spreadsheet -- and asserts on the CODE
// of the refusal, not merely that something threw. The distinction matters:
// a zip bomb refused as "corrupt archive" would mean the bomb detection is
// not the thing that fired.
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { KODE_XLSX, KesalahanXlsx } from "./batas";
import { BATAS_BACA_BAWAAN, bacaTabelXlsx, tanggalDariSerial, type BatasBaca } from "./baca";
import { bacaDirektoriZip } from "./zip";
import { tulisXlsx, teks as selTeks, uang, hariDariTanggal } from "./tulis";

// ---------------------------------------------------------------------------
// A ZIP writer that can produce archives a correct one never would
// ---------------------------------------------------------------------------

interface EntriBuatan {
  nama: string;
  /** Bytes as they sit in the archive. Already deflated when `metode` is 8. */
  isi: Uint8Array;
  metode: number;
  /** What the CENTRAL DIRECTORY will CLAIM. A bomb lies here. */
  uncompressedDiklaim: number;
  bendera?: number;
  crc?: number;
}

function buatZip(entri: readonly EntriBuatan[], opsi: { zip64?: boolean } = {}): Uint8Array {
  const potong: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const e of entri) {
    const nama = enc.encode(e.nama);
    const lokal = new Uint8Array(30 + nama.length);
    const dvl = new DataView(lokal.buffer);
    dvl.setUint32(0, 0x04034b50, true);
    dvl.setUint16(4, 20, true);
    dvl.setUint16(6, e.bendera ?? 0x0800, true);
    dvl.setUint16(8, e.metode, true);
    dvl.setUint32(14, e.crc ?? 0, true);
    dvl.setUint32(18, e.isi.length, true);
    dvl.setUint32(22, e.uncompressedDiklaim, true);
    dvl.setUint16(26, nama.length, true);
    lokal.set(nama, 30);

    const pusat = new Uint8Array(46 + nama.length);
    const dvc = new DataView(pusat.buffer);
    dvc.setUint32(0, 0x02014b50, true);
    dvc.setUint16(4, 20, true);
    dvc.setUint16(6, 20, true);
    dvc.setUint16(8, e.bendera ?? 0x0800, true);
    dvc.setUint16(10, e.metode, true);
    dvc.setUint32(16, e.crc ?? 0, true);
    dvc.setUint32(20, e.isi.length, true);
    dvc.setUint32(24, e.uncompressedDiklaim, true);
    dvc.setUint16(28, nama.length, true);
    dvc.setUint32(42, offset, true);
    pusat.set(nama, 46);

    potong.push(lokal, e.isi);
    dir.push(pusat);
    offset += lokal.length + e.isi.length;
  }

  const ukuranDir = dir.reduce((t, d) => t + d.length, 0);
  const eocd = new Uint8Array(22);
  const dve = new DataView(eocd.buffer);
  dve.setUint32(0, 0x06054b50, true);
  dve.setUint16(8, opsi.zip64 ? 0xffff : entri.length, true);
  dve.setUint16(10, opsi.zip64 ? 0xffff : entri.length, true);
  dve.setUint32(12, ukuranDir, true);
  dve.setUint32(16, offset, true);

  const semua = [...potong, ...dir, eocd];
  const keluar = new Uint8Array(semua.reduce((t, s) => t + s.length, 0));
  let p = 0;
  for (const s of semua) {
    keluar.set(s, p);
    p += s.length;
  }
  return keluar;
}

const enc = new TextEncoder();

function padat(teks: string): Uint8Array {
  return new Uint8Array(deflateRawSync(enc.encode(teks), { level: 9 }));
}

function tersimpan(teks: string): EntriBuatan {
  const isi = enc.encode(teks);
  return { nama: "", isi, metode: 0, uncompressedDiklaim: isi.length };
}

/** The four parts a minimal readable workbook needs, plus one sheet body. */
function workbookBuatan(sheetXml: string, tambahan: Partial<Record<string, string>> = {}) {
  const bagian: Record<string, string> = {
    "xl/workbook.xml":
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheetXml,
    ...tambahan,
  };
  return Object.entries(bagian).map(([nama, isi]) => ({ ...tersimpan(isi), nama }));
}

function selInline(ref: string, isi: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${isi}</t></is></c>`;
}

function lembarSederhana(baris: string[][]): string {
  const xml = baris
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r
          .map((v, j) => selInline(`${String.fromCharCode(65 + j)}${i + 1}`, v))
          .join("")}</row>`,
    )
    .join("");
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`;
}

function kode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof KesalahanXlsx) return err.kode;
    return `BUKAN_KesalahanXlsx: ${(err as Error).name}: ${(err as Error).message}`;
  }
  return "TIDAK_MENOLAK";
}

// ---------------------------------------------------------------------------

describe("cap 1: ukuran berkas mentah", () => {
  test("berkas di atas MAKS_BERKAS_BYTE ditolak sebelum apa pun dibuka", () => {
    const batas: BatasBaca = { ...BATAS_BACA_BAWAAN, maksBerkasByte: 1024 };
    // Deliberately a VALID zip. The refusal must come from the size, not from
    // the archive being unreadable.
    const zip = buatZip(workbookBuatan(lembarSederhana([["a".repeat(4000)]])));
    expect(zip.length).toBeGreaterThan(1024);
    expect(kode(() => bacaTabelXlsx(zip, batas))).toBe(KODE_XLSX.BERKAS_TERLALU_BESAR);
  });

  test("berkas kosong dan berkas bukan-zip ditolak dengan kalimatnya sendiri", () => {
    expect(kode(() => bacaTabelXlsx(new Uint8Array(0)))).toBe(KODE_XLSX.BUKAN_ZIP);
    expect(kode(() => bacaTabelXlsx(enc.encode("kode_mitra,nama\nA,B\n")))).toBe(
      KODE_XLSX.BUKAN_ZIP,
    );
  });
});

describe("cap 2: jumlah entri", () => {
  test("arsip dengan lebih dari MAKS_ENTRI bagian ditolak di direktori, tanpa dekompresi", () => {
    const banyak = Array.from({ length: 9 }, (_, i) => ({ ...tersimpan("x"), nama: `p${i}.xml` }));
    const zip = buatZip(banyak);
    expect(
      kode(() =>
        bacaDirektoriZip(zip, {
          maksEntri: 8,
          maksEntriDekompresiByte: 1 << 20,
          maksTotalDekompresiByte: 1 << 20,
        }),
      ),
    ).toBe(KODE_XLSX.TERLALU_BANYAK_ENTRI);
  });
});

describe("cap 3: ukuran TERDEKOMPRESI, yang tidak ada di header mana pun", () => {
  test("zip bomb: 1 KB terkompresi yang mengembang jadi 8 MB, dan direktorinya berbohong", () => {
    // 8 MiB of one repeated byte deflates to about 8 KB. The central directory
    // is told the entry is 10 bytes long, which is the field a reader that
    // trusts headers would have checked.
    const mentah = new Uint8Array(8 * 1024 * 1024);
    const bom = new Uint8Array(deflateRawSync(mentah, { level: 9 }));
    expect(bom.length).toBeLessThan(16 * 1024);

    const zip = buatZip([
      ...workbookBuatan(lembarSederhana([["a"]])),
      { nama: "xl/sharedStrings.xml", isi: bom, metode: 8, uncompressedDiklaim: 10 },
    ]);
    // The whole upload is small enough to pass every byte-size check there is.
    expect(zip.length).toBeLessThan(64 * 1024);

    const batas: BatasBaca = {
      ...BATAS_BACA_BAWAAN,
      maksEntriDekompresiByte: 64 * 1024,
      maksTotalDekompresiByte: 1024 * 1024,
    };
    expect(kode(() => bacaTabelXlsx(zip, batas))).toBe(KODE_XLSX.ENTRI_TERLALU_BESAR);
  });

  test("beberapa entri yang masing-masing lolos batas per-entri tetap kena batas TOTAL", () => {
    const satu = new Uint8Array(200 * 1024);
    const bom = new Uint8Array(deflateRawSync(satu, { level: 9 }));
    const zip = buatZip([
      ...workbookBuatan(lembarSederhana([["a"]])),
      { nama: "xl/sharedStrings.xml", isi: bom, metode: 8, uncompressedDiklaim: satu.length },
      { nama: "xl/styles.xml", isi: bom, metode: 8, uncompressedDiklaim: satu.length },
    ]);
    const batas: BatasBaca = {
      ...BATAS_BACA_BAWAAN,
      maksEntriDekompresiByte: 256 * 1024,
      maksTotalDekompresiByte: 260 * 1024,
    };
    expect(kode(() => bacaTabelXlsx(zip, batas))).toBe(
      KODE_XLSX.TOTAL_DEKOMPRESI_TERLALU_BESAR,
    );
  });

  test("entri STORED yang besar dibatasi juga, bukan hanya yang di-deflate", () => {
    const zip = buatZip([
      ...workbookBuatan(lembarSederhana([["a"]])),
      { ...tersimpan("z".repeat(100 * 1024)), nama: "xl/sharedStrings.xml" },
    ]);
    const batas: BatasBaca = { ...BATAS_BACA_BAWAAN, maksEntriDekompresiByte: 8 * 1024 };
    expect(kode(() => bacaTabelXlsx(zip, batas))).toBe(KODE_XLSX.ENTRI_TERLALU_BESAR);
  });
});

describe("cap 4: bentuk arsip yang ditolak dan tidak ditebak", () => {
  test("nama entri dengan path traversal menolak SELURUH arsip", () => {
    const zip = buatZip([
      ...workbookBuatan(lembarSederhana([["a"]])),
      { ...tersimpan("x"), nama: "../../../etc/passwd" },
    ]);
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.NAMA_ENTRI_TIDAK_AMAN);
  });

  test("entri terenkripsi ditolak, tidak dilewati diam-diam", () => {
    const zip = buatZip([
      ...workbookBuatan(lembarSederhana([["a"]])).map((e) => ({ ...e, bendera: 0x0801 })),
    ]);
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.ZIP_TERENKRIPSI);
  });

  test("metode kompresi di luar STORED/DEFLATE ditolak", () => {
    const zip = buatZip([
      ...workbookBuatan(lembarSederhana([["a"]])),
      { ...tersimpan("x"), nama: "xl/x.bin", metode: 12 },
    ]);
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.KOMPRESI_TIDAK_DIDUKUNG);
  });

  test("ZIP64 ditolak, bukan dibaca separuh", () => {
    const zip = buatZip(workbookBuatan(lembarSederhana([["a"]])), { zip64: true });
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.ZIP64_TIDAK_DIDUKUNG);
  });

  test("arsip tanpa xl/workbook.xml bukan .xlsx", () => {
    const zip = buatZip([{ ...tersimpan("halo"), nama: "catatan.txt" }]);
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.BUKAN_XLSX);
  });
});

describe("cap 5: XML, di mana XXE dan billion laughs mati", () => {
  const XXE =
    '<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<sheetData><row r=\"1\">" +
    selInline("A1", "&xxe;") +
    "</row></sheetData></worksheet>";

  test("DOCTYPE dengan entitas SYSTEM di sheet ditolak sebelum dipindai", () => {
    const zip = buatZip(workbookBuatan(XXE));
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.XML_DEKLARASI_DILARANG);
  });

  test("DOCTYPE di sharedStrings.xml, bagian yang orang lupa periksa, ditolak juga", () => {
    const jahat =
      '<!DOCTYPE si [<!ENTITY a "x">]><sst><si><t>&a;</t></si></sst>';
    const zip = buatZip(
      workbookBuatan(lembarSederhana([["a"]]), { "xl/sharedStrings.xml": jahat }),
    );
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.XML_DEKLARASI_DILARANG);
  });

  test("billion laughs, yang tidak butuh entitas eksternal sama sekali, ditolak", () => {
    const lol =
      "<!DOCTYPE lolz [<!ENTITY lol 'lol'>" +
      Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} '&lol${i};&lol${i};&lol${i};'>`)
        .join("")
        .replace("&lol0;&lol0;&lol0;", "&lol;&lol;&lol;") +
      "]><worksheet><sheetData><row r=\"1\">" +
      selInline("A1", "&lol9;") +
      "</row></sheetData></worksheet>";
    const zip = buatZip(workbookBuatan(lol));
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.XML_DEKLARASI_DILARANG);
  });

  test("entitas tak dikenal TANPA DOCTYPE ditolak, tidak diteruskan mentah", () => {
    const sheet =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      "<sheetData><row r=\"1\">" +
      selInline("A1", "&xxe;") +
      "</row></sheetData></worksheet>";
    const zip = buatZip(workbookBuatan(sheet));
    expect(kode(() => bacaTabelXlsx(zip))).toBe(KODE_XLSX.XML_ENTITAS_TIDAK_DIKENAL);
  });

  test("lima entitas standar dan referensi numerik tetap dibaca", () => {
    const sheet = lembarSederhana([["&amp;&lt;&gt;&quot;&apos;&#65;&#x42;"]]);
    const zip = buatZip(workbookBuatan(sheet));
    expect(bacaTabelXlsx(zip).baris[0]![0]).toBe("&<>\"'AB");
  });
});

describe("cap 6: batas lembar", () => {
  test("baris melebihi batas ditolak", () => {
    const baris = Array.from({ length: 40 }, (_, i) => [`b${i}`]);
    const zip = buatZip(workbookBuatan(lembarSederhana(baris)));
    expect(kode(() => bacaTabelXlsx(zip, { ...BATAS_BACA_BAWAAN, maksBaris: 20 }))).toBe(
      KODE_XLSX.TERLALU_BANYAK_BARIS,
    );
  });

  test("kolom melebihi batas ditolak, dibaca dari referensi sel", () => {
    const sheet =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1">' +
      selInline("A1", "a") +
      selInline("ZZ1", "jauh") +
      "</row></sheetData></worksheet>";
    const zip = buatZip(workbookBuatan(sheet));
    expect(kode(() => bacaTabelXlsx(zip, { ...BATAS_BACA_BAWAAN, maksKolom: 10 }))).toBe(
      KODE_XLSX.TERLALU_BANYAK_KOLOM,
    );
  });

  test("sel melebihi batas karakter ditolak", () => {
    const zip = buatZip(workbookBuatan(lembarSederhana([["x".repeat(500)]])));
    expect(kode(() => bacaTabelXlsx(zip, { ...BATAS_BACA_BAWAAN, maksKarakterSel: 100 }))).toBe(
      KODE_XLSX.SEL_TERLALU_PANJANG,
    );
  });

  test("tabel shared string melebihi batas ditolak", () => {
    const sst = `<sst>${Array.from({ length: 30 }, (_, i) => `<si><t>s${i}</t></si>`).join("")}</sst>`;
    const zip = buatZip(workbookBuatan(lembarSederhana([["a"]]), { "xl/sharedStrings.xml": sst }));
    expect(kode(() => bacaTabelXlsx(zip, { ...BATAS_BACA_BAWAAN, maksSharedString: 10 }))).toBe(
      KODE_XLSX.TERLALU_BANYAK_SHARED_STRING,
    );
  });
});

describe("apa yang DIBACA dari sebuah berkas yang sah", () => {
  test("shared string, angka sebagai teks desimal, dan formula yang tidak dievaluasi", () => {
    const sst = "<sst><si><t>Nama Mitra</t></si><si><t>PT Maju</t></si></sst>";
    const sheet =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>jumlah</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1500000.00</v></c></row>' +
      // A formula cell. `<f>` must be ignored and the cached `<v>` used.
      '<row r="3"><c r="A3" t="inlineStr"><is><t>hasil</t></is></c>' +
      '<c r="B3"><f>SUM(B2:B2)</f><v>1500000.00</v></c></row>' +
      "</sheetData></worksheet>";
    const zip = buatZip(workbookBuatan(sheet, { "xl/sharedStrings.xml": sst }));
    const tabel = bacaTabelXlsx(zip);
    expect(tabel.namaLembar).toBe("Data");
    expect(tabel.baris).toEqual([
      ["Nama Mitra", "jumlah"],
      ["PT Maju", "1500000.00"],
      ["hasil", "1500000.00"],
    ]);
  });

  test("rupiah keluar sebagai STRING desimal persis, tidak lewat float", () => {
    const sheet =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1"><v>0.30000000000000004</v></c><c r="B1"><v>12345678901234.56</v></c></row>' +
      "</sheetData></worksheet>";
    const zip = buatZip(workbookBuatan(sheet));
    const baris = bacaTabelXlsx(zip).baris[0]!;
    expect(baris[0]).toBe("0.30000000000000004");
    // The value a JS float would have destroyed: 12345678901234.56 is not
    // representable, and `String(Number(...))` gives 12345678901234.56 back but
    // 12345678901234.567 would not survive. The point is that neither is
    // constructed here at all.
    expect(baris[1]).toBe("12345678901234.56");
  });

  test("sel bertanggal jadi ISO, dari serial dan format bawaan Excel", () => {
    const styles =
      '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const sheet =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1" s="0"><v>45292</v></c></row>' +
      "</sheetData></worksheet>";
    const zip = buatZip(workbookBuatan(sheet, { "xl/styles.xml": styles }));
    const baris = bacaTabelXlsx(zip).baris[0]!;
    expect(baris[0]).toBe("2024-01-01");
    // Same number, no date format: still a number. The format is the only
    // thing that makes a serial a date, and guessing would turn a rupiah
    // amount of 45292 into a date.
    expect(baris[1]).toBe("45292");
  });

  test("lembar pertama diambil dari relasi, bukan dari nama berkas sheet1.xml", () => {
    const bagian = [
      {
        ...tersimpan(
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<sheets><sheet name="Kedua" sheetId="2" r:id="rId7"/></sheets></workbook>',
        ),
        nama: "xl/workbook.xml",
      },
      {
        ...tersimpan(
          '<Relationships><Relationship Id="rId7" Target="worksheets/sheet3.xml"/></Relationships>',
        ),
        nama: "xl/_rels/workbook.xml.rels",
      },
      { ...tersimpan(lembarSederhana([["salah"]])), nama: "xl/worksheets/sheet1.xml" },
      { ...tersimpan(lembarSederhana([["benar"]])), nama: "xl/worksheets/sheet3.xml" },
    ];
    const tabel = bacaTabelXlsx(buatZip(bagian));
    expect(tabel.namaLembar).toBe("Kedua");
    expect(tabel.baris[0]![0]).toBe("benar");
  });

  test("baris pendek dipadatkan sampai lebar terlebar, jadi kolomnya sejajar", () => {
    const sheet =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1">' + selInline("A1", "a") + selInline("B1", "b") + selInline("C1", "c") + "</row>" +
      '<row r="2">' + selInline("A2", "x") + selInline("C2", "z") + "</row>" +
      "</sheetData></worksheet>";
    const tabel = bacaTabelXlsx(buatZip(workbookBuatan(sheet)));
    expect(tabel.baris).toEqual([
      ["a", "b", "c"],
      ["x", "", "z"],
    ]);
  });
});

describe("bolak-balik: apa yang ditulis modul ini bisa dibaca modul ini", () => {
  test("workbook yang ditulis sendiri dibaca kembali dengan nilai yang sama", () => {
    const berkas = tulisXlsx([
      {
        nama: "Ringkasan",
        bekukanBaris: 1,
        baris: [
          [selTeks("Kode", true), selTeks("Nama", true), selTeks("Jumlah", true)],
          [selTeks("M-001"), selTeks("PT Maju Jaya"), uang("1500000.00")],
          [selTeks("M-002"), selTeks("CV Sejahtera"), uang("-250000.50")],
        ],
      },
    ]);
    const tabel = bacaTabelXlsx(berkas);
    expect(tabel.namaLembar).toBe("Ringkasan");
    expect(tabel.baris).toEqual([
      ["Kode", "Nama", "Jumlah"],
      ["M-001", "PT Maju Jaya", "1500000.00"],
      ["M-002", "CV Sejahtera", "-250000.50"],
    ]);
  });
});

describe("aritmetika tanggal, bilangan bulat sepenuhnya", () => {
  test("serial Excel bolak-balik untuk tanggal batas", () => {
    const kasus: Array<[string, number]> = [
      ["1900-03-01", 61],
      ["1970-01-01", 25569],
      ["2000-02-29", 36585],
      ["2024-01-01", 45292],
      ["2026-12-31", 46387],
    ];
    for (const [iso, serial] of kasus) {
      const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
      expect(hariDariTanggal(y, m, d) - hariDariTanggal(1899, 12, 30)).toBe(serial);
      expect(tanggalDariSerial(serial)).toBe(iso);
    }
  });
});
