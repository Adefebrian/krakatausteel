// UPLOADING AN .xlsx, over HTTP, AND EVERY CAP THAT BOUNDS IT.
//
// Spec 9.6 says "dari Excel", and this is the route that finally accepts one.
// The happy path is one test here; the other fourteen are the reason the
// feature is a security change rather than a convenience:
//
//   a decompression bomb whose central directory LIES about the size;
//   entry-count and total-decompressed caps;
//   `<!DOCTYPE ... <!ENTITY xxe SYSTEM "file:///etc/passwd">` in a cell;
//   billion laughs, which needs no network at all;
//   a password-protected workbook, which must NOT import as empty;
//   an entry named `../../etc/passwd`;
//   ZIP64 and an unsupported compression method;
//   row, column and cell-length caps;
//   a base64 body larger than the file cap, refused before any decode.
//
// EVERY ONE OF THEM IS A CRAFTED ARCHIVE BUILT IN THIS FILE, because no
// spreadsheet program produces any of them and therefore none of them could be
// a checked-in fixture. The unit-level versions live in
// core/xlsx/xlsx-batas.test.ts; these prove the caps are actually WIRED at the
// module's own numbers and that a refusal arrives as a 400 in the API's own
// envelope with nothing written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { createFixture, type Fixture } from "../../testing/harness";
import { buatPeriodeOpen } from "./test-support";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { tulisXlsx, teks, type Sel } from "../../core/xlsx/tulis";
import { MAKS_ISI_BYTE } from "./contract";

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// A ZIP writer that can produce what a correct one never would
// ---------------------------------------------------------------------------

interface EntriBuatan {
  nama: string;
  isi: Uint8Array;
  metode: number;
  uncompressedDiklaim: number;
  bendera?: number;
}

function buatZip(entri: readonly EntriBuatan[], opsi: { zip64?: boolean } = {}): Uint8Array {
  const potong: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let offset = 0;
  for (const e of entri) {
    const nama = enc.encode(e.nama);
    const lokal = new Uint8Array(30 + nama.length);
    const dvl = new DataView(lokal.buffer);
    dvl.setUint32(0, 0x04034b50, true);
    dvl.setUint16(4, 20, true);
    dvl.setUint16(6, e.bendera ?? 0x0800, true);
    dvl.setUint16(8, e.metode, true);
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
    dvc.setUint32(20, e.isi.length, true);
    dvc.setUint32(24, e.uncompressedDiklaim, true);
    dvc.setUint16(28, nama.length, true);
    dvc.setUint32(42, offset, true);
    pusat.set(nama, 46);

    potong.push(lokal, e.isi);
    dir.push(pusat);
    offset += lokal.length + e.isi.length;
  }
  const ukuranDir = dir.reduce((t, x) => t + x.length, 0);
  const eocd = new Uint8Array(22);
  const dve = new DataView(eocd.buffer);
  dve.setUint32(0, 0x06054b50, true);
  dve.setUint16(8, opsi.zip64 ? 0xffff : entri.length, true);
  dve.setUint16(10, opsi.zip64 ? 0xffff : entri.length, true);
  dve.setUint32(12, ukuranDir, true);
  dve.setUint32(16, offset, true);
  const semua = [...potong, ...dir, eocd];
  const keluar = new Uint8Array(semua.reduce((t, x) => t + x.length, 0));
  let p = 0;
  for (const x of semua) {
    keluar.set(x, p);
    p += x.length;
  }
  return keluar;
}

function simpan(nama: string, isi: string): EntriBuatan {
  const b = enc.encode(isi);
  return { nama, isi: b, metode: 0, uncompressedDiklaim: b.length };
}

function bagianWorkbook(sheetXml: string, tambahan: Record<string, string> = {}): EntriBuatan[] {
  const semua: Record<string, string> = {
    "xl/workbook.xml":
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheetXml,
    ...tambahan,
  };
  return Object.entries(semua).map(([n, v]) => simpan(n, v));
}

function lembarDari(baris: readonly (readonly string[])[]): string {
  const xml = baris
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r
          .map(
            (v, j) =>
              `<c r="${kolomHuruf(j + 1)}${i + 1}" t="inlineStr"><is><t>${v
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`;
}

function kolomHuruf(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function ke64(data: Uint8Array): string {
  let biner = "";
  for (const b of data) biner += String.fromCharCode(b);
  return btoa(biner);
}

const HEADER_MITRA = ["kode_mitra", "nama_lengkap", "nik", "alamat"] as const;

// ---------------------------------------------------------------------------

describe("impor .xlsx", () => {
  let f: Fixture;
  let cookie = "";
  let seq = 0;

  function barisMitra(n: number): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      out.push([
        `KX-${f.suffix}-${seq}`,
        `Mitra Xlsx ${seq}`,
        `32${String(Date.now() % 100000000).padStart(8, "0")}${String(seq).padStart(6, "0")}`.slice(0, 16),
        "Jl. Excel No. 1",
      ]);
    }
    return out;
  }

  async function kirim(
    jalur: "pratinjau" | "komit",
    data: Uint8Array | string,
    opsi: { namaFile?: string; format?: string } = {},
  ): Promise<Response> {
    return f.request(`/impor/MITRA/${jalur}`, {
      cookie,
      method: "POST",
      body: {
        namaFile: opsi.namaFile ?? "mitra.xlsx",
        format: opsi.format ?? "XLSX",
        isi: typeof data === "string" ? data : ke64(data),
      },
    });
  }

  /** The refusal code, or the status when the body is not a domain refusal. */
  async function tolakan(res: Response): Promise<string> {
    const body = (await res.json()) as { kodeDomain?: string; code?: string };
    return `${res.status} ${body.kodeDomain ?? body.code ?? "?"}`;
  }

  async function cacahMitra(): Promise<number> {
    const r = await f.db.query<{ n: string }>(
      `select count(*)::text as n from mitra m join cabang c on c.id = m.cabang_id
        where c.bumn_id = $1::uuid`,
      [f.bumnId],
    );
    return Number(r[0]?.n ?? "0");
  }

  beforeAll(async () => {
    f = await createFixture();
    await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
    await buatPeriodeOpen(f.db, f.bumnId, 2026, 3);
    cookie = await f.login(f.users.MAKER.username);
  });

  afterAll(async () => {
    await f.tutup();
  });

  // -------------------------------------------------------------------------

  describe("jalan bahagia: berkas Excel sungguhan", () => {
    test("workbook yang ditulis core/xlsx diunggah, dipratinjau, lalu dikomit", async () => {
      const data = barisMitra(3);
      const lembar: Sel[][] = [
        [...HEADER_MITRA].map((h) => teks(h, true)),
        ...data.map((r) => r.map((v) => teks(v))),
      ];
      const berkas = tulisXlsx([{ nama: "Mitra", baris: lembar }]);

      const pratinjau = await kirim("pratinjau", berkas);
      expect(await tolakan(pratinjau.clone())).toBe("200 ?");
      const laporan = (await pratinjau.json()) as {
        jumlahBaris: number;
        diterima: { nomorBaris: number }[];
        ditolak: unknown[];
        siapKomit: boolean;
      };
      expect(laporan.jumlahBaris).toBe(3);
      expect(laporan.ditolak).toEqual([]);
      expect(laporan.siapKomit).toBe(true);
      // LINE NUMBERS ARE THE SPREADSHEET'S: row 1 is the header, so the first
      // data row is 2, exactly as the CSV path reports it.
      expect(laporan.diterima.map((d) => d.nomorBaris)).toEqual([2, 3, 4]);

      const sebelum = await cacahMitra();
      const komit = await kirim("komit", berkas);
      expect(komit.status).toBe(201);
      expect(await cacahMitra()).toBe(sebelum + 3);
    });

    test("angka dan tanggal yang diketik di Excel sampai sebagai teks yang benar", async () => {
      // A `tanggal_lahir` typed into Excel is stored as a SERIAL NUMBER with a
      // date format, not as text. Without the styles.xml pass it would arrive
      // as "45292" and the row would be refused with a message about the date
      // pattern, which is correct and useless.
      const styles =
        '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
      const sheet =
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>kode_mitra</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t>nama_lengkap</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>tanggal_lahir</t></is></c></row>' +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>KX-${f.suffix}-D1</t></is></c>` +
        '<c r="B2" t="inlineStr"><is><t>Mitra Tanggal</t></is></c>' +
        '<c r="C2" s="1"><v>29343</v></c></row>' +
        "</sheetData></worksheet>";
      const zip = buatZip(bagianWorkbook(sheet, { "xl/styles.xml": styles }));
      const res = await kirim("pratinjau", zip);
      expect(res.status).toBe(200);
      const laporan = (await res.json()) as { ditolak: unknown[]; siapKomit: boolean };
      expect(laporan.ditolak).toEqual([]);
      expect(laporan.siapKomit).toBe(true);
    });

    test("baris dengan kolom opsional kosong diterima, bukan dianggap cacat", async () => {
      // A spreadsheet row does not have "too few cells"; it has empty ones.
      const sheet = lembarDari([
        [...HEADER_MITRA],
        [`KX-${f.suffix}-S1`, "Mitra Pendek", "", ""],
      ]);
      const res = await kirim("pratinjau", buatZip(bagianWorkbook(sheet)));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ditolak: unknown[] }).ditolak).toEqual([]);
    });

    test("format CSV masih jalan tanpa menyebut format sama sekali", async () => {
      const csv = `kode_mitra,nama_lengkap\nKX-${f.suffix}-C1,Mitra CSV\n`;
      const res = await f.request("/impor/MITRA/pratinjau", {
        cookie,
        method: "POST",
        body: { namaFile: "mitra.csv", isi: csv },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { jumlahBaris: number }).jumlahBaris).toBe(1);
    });
  });

  // -------------------------------------------------------------------------

  describe("batas ukuran berkas", () => {
    test("berkas di atas 512 KB ditolak oleh cap ukuran, dihitung dari byte TERDEKODE", async () => {
      // A VALID workbook, deliberately over the cap, so the refusal is about
      // SIZE and not about the archive being unreadable. Stored uncompressed
      // so the archive really is bigger than the cap rather than deflating
      // back under it.
      const besar = "x".repeat(600 * 1024);
      const bagian = bagianWorkbook(lembarDari([[...HEADER_MITRA]]));
      const zip = buatZip([...bagian, simpan("xl/sharedStrings.xml", besar)]);
      expect(zip.length).toBeGreaterThan(MAKS_ISI_BYTE);
      // The base64 of it is still well inside the route's coarse bound, so the
      // refusal comes from the ENGINE's exact check on the decoded bytes.
      expect(ke64(zip).length).toBeLessThan(MAKS_ISI_BYTE * 2);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_TERLALU_BESAR");
    });

    test("base64 yang terlalu panjang ditolak di batas, sebelum satu byte pun didekode", async () => {
      const b64 = "A".repeat(MAKS_ISI_BYTE * 2 + 8);
      const res = await kirim("pratinjau", b64);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail?: Record<string, string[]> };
      expect(body.code).toBe("VALIDASI");
      expect(Object.keys(body.detail ?? {})).toContain("isi");
    });

    test("isi yang bukan base64 ditolak sebagai validasi, bukan sebagai crash", async () => {
      expect((await kirim("pratinjau", "ini bukan base64!!")).status).toBe(400);
    });

    test("format yang tidak dikenal ditolak di batas", async () => {
      const res = await kirim("pratinjau", "QUJD", { format: "PDF" });
      const body = (await res.json()) as { detail?: Record<string, string[]> };
      expect(res.status).toBe(400);
      expect(Object.keys(body.detail ?? {})).toContain("format");
    });
  });

  describe("zip bomb: yang tidak kelihatan dari ukuran unggahan", () => {
    test("1 MB unggahan yang mengembang jadi 64 MB ditolak, dan direktorinya berbohong", async () => {
      // 64 MiB of a single repeated byte deflates to about 64 KB. The central
      // directory is told the entry is 10 bytes: that is the field a reader
      // which trusted headers would have believed.
      const mentah = new Uint8Array(64 * 1024 * 1024);
      const bom = new Uint8Array(deflateRawSync(mentah, { level: 9 }));
      const zip = buatZip([
        ...bagianWorkbook(lembarDari([[...HEADER_MITRA]])),
        { nama: "xl/sharedStrings.xml", isi: bom, metode: 8, uncompressedDiklaim: 10 },
      ]);
      // Small enough to pass every byte-size check in the request path.
      expect(zip.length).toBeLessThan(MAKS_ISI_BYTE);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("tiga bagian yang masing-masing LOLOS batas per-entri tetap kena batas TOTAL", async () => {
      // 9 MB each: under the 12 MB per-entry cap, over the 24 MB total. This is
      // the case a per-entry check alone would wave through, and it is why the
      // budget is shared across the whole read rather than per call.
      const satu = new Uint8Array(9 * 1024 * 1024);
      const bom = new Uint8Array(deflateRawSync(satu, { level: 9 }));
      const bagian = bagianWorkbook(lembarDari([[...HEADER_MITRA]]));
      const zip = buatZip([
        ...bagian.filter((e) => e.nama !== "xl/worksheets/sheet1.xml"),
        { nama: "xl/sharedStrings.xml", isi: bom, metode: 8, uncompressedDiklaim: satu.length },
        { nama: "xl/styles.xml", isi: bom, metode: 8, uncompressedDiklaim: satu.length },
        {
          nama: "xl/worksheets/sheet1.xml",
          isi: bom,
          metode: 8,
          uncompressedDiklaim: satu.length,
        },
      ]);
      expect(zip.length).toBeLessThan(MAKS_ISI_BYTE);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("arsip dengan entri melebihi batas jumlah ditolak sebelum dekompresi", async () => {
      const banyak = Array.from({ length: 80 }, (_, i) => simpan(`xl/p${i}.xml`, "x"));
      const zip = buatZip([...bagianWorkbook(lembarDari([[...HEADER_MITRA]])), ...banyak]);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });
  });

  describe("XML: XXE dan billion laughs", () => {
    test("DOCTYPE dengan entitas SYSTEM di lembar ditolak", async () => {
      const jahat =
        '<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>kode_mitra</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>&xxe;</t></is></c></row>' +
        "</sheetData></worksheet>";
      expect(await tolakan(await kirim("pratinjau", buatZip(bagianWorkbook(jahat))))).toBe(
        "400 BERKAS_XLSX_DITOLAK",
      );
    });

    test("DOCTYPE di sharedStrings.xml ditolak juga, bukan cuma di lembar", async () => {
      const zip = buatZip(
        bagianWorkbook(lembarDari([[...HEADER_MITRA]]), {
          "xl/sharedStrings.xml":
            '<!DOCTYPE sst [<!ENTITY xxe SYSTEM "file:///etc/hosts">]><sst><si><t>&xxe;</t></si></sst>',
        }),
      );
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("billion laughs, yang tidak menyentuh jaringan sama sekali, ditolak", async () => {
      const lol =
        "<!DOCTYPE lolz [<!ENTITY lol 'lol'>" +
        Array.from(
          { length: 9 },
          (_, i) => `<!ENTITY lol${i + 1} '&lol${i === 0 ? "" : i};&lol${i === 0 ? "" : i};'>`,
        ).join("") +
        ']><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol9;</t></is></c></row>' +
        "</sheetData></worksheet>";
      expect(await tolakan(await kirim("pratinjau", buatZip(bagianWorkbook(lol))))).toBe(
        "400 BERKAS_XLSX_DITOLAK",
      );
    });

    test("entitas tak dikenal TANPA DOCTYPE ditolak, tidak diteruskan mentah ke database", async () => {
      const sheet =
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>&sesuatu;</t></is></c></row>' +
        "</sheetData></worksheet>";
      expect(await tolakan(await kirim("pratinjau", buatZip(bagianWorkbook(sheet))))).toBe(
        "400 BERKAS_XLSX_DITOLAK",
      );
    });
  });

  describe("bentuk arsip yang ditolak dan tidak ditebak", () => {
    test("nama entri dengan path traversal menolak SELURUH arsip", async () => {
      const zip = buatZip([
        ...bagianWorkbook(lembarDari([[...HEADER_MITRA]])),
        simpan("../../../etc/passwd", "x"),
      ]);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("workbook berkata sandi ditolak, TIDAK diimpor sebagai berkas kosong", async () => {
      const zip = buatZip(
        bagianWorkbook(lembarDari([[...HEADER_MITRA]])).map((e) => ({ ...e, bendera: 0x0801 })),
      );
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("ZIP64 dan metode kompresi asing ditolak, bukan dibaca separuh", async () => {
      const z64 = buatZip(bagianWorkbook(lembarDari([[...HEADER_MITRA]])), { zip64: true });
      expect(await tolakan(await kirim("pratinjau", z64))).toBe("400 BERKAS_XLSX_DITOLAK");

      const aneh = buatZip([
        ...bagianWorkbook(lembarDari([[...HEADER_MITRA]])),
        { ...simpan("xl/x.bin", "x"), metode: 12 },
      ]);
      expect(await tolakan(await kirim("pratinjau", aneh))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("berkas .csv yang diberi nama .xlsx ditolak dengan kalimat yang bisa ditindaklanjuti", async () => {
      const res = await kirim("pratinjau", enc.encode("kode_mitra,nama_lengkap\nA,B\n"));
      expect(await tolakan(res.clone())).toBe("400 BERKAS_XLSX_DITOLAK");
      expect(((await res.json()) as { error: string }).error).toContain(".xlsx");
    });

    test("arsip tanpa xl/workbook.xml ditolak", async () => {
      const zip = buatZip([simpan("catatan.txt", "halo")]);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });
  });

  describe("batas lembar", () => {
    test("lebih dari 2000 baris data ditolak", async () => {
      const baris = [[...HEADER_MITRA] as string[]];
      for (let i = 0; i < 2100; i += 1) baris.push([`K${i}`, `N${i}`, "", ""]);
      const zip = buatZip(bagianWorkbook(lembarDari(baris)));
      expect(zip.length).toBeLessThan(MAKS_ISI_BYTE);
      expect(await tolakan(await kirim("pratinjau", zip))).toBe("400 BERKAS_XLSX_DITOLAK");
    });

    test("kolom jauh di kanan ditolak, dibaca dari referensi sel", async () => {
      const sheet =
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>kode_mitra</t></is></c>' +
        '<c r="CZ1" t="inlineStr"><is><t>jauh</t></is></c></row>' +
        "</sheetData></worksheet>";
      expect(await tolakan(await kirim("pratinjau", buatZip(bagianWorkbook(sheet))))).toBe(
        "400 BERKAS_XLSX_DITOLAK",
      );
    });

    test("sel yang sangat panjang ditolak", async () => {
      const sheet = lembarDari([
        [...HEADER_MITRA],
        [`KX-${f.suffix}-L1`, "x".repeat(5000), "", ""],
      ]);
      expect(await tolakan(await kirim("pratinjau", buatZip(bagianWorkbook(sheet))))).toBe(
        "400 BERKAS_XLSX_DITOLAK",
      );
    });
  });

  describe("kontrak kolom sama persis dengan jalur CSV", () => {
    test("kolom wajib yang hilang dan kolom asing ditolak dengan kode yang sama", async () => {
      const kurang = buatZip(bagianWorkbook(lembarDari([["kode_mitra"], ["KM-1"]])));
      expect(await tolakan(await kirim("pratinjau", kurang))).toBe("400 HEADER_TIDAK_LENGKAP");

      const asing = buatZip(
        bagianWorkbook(lembarDari([["kode_mitra", "nama_lengkap", "kolom_ngawur"], ["A", "B", "C"]])),
      );
      expect(await tolakan(await kirim("pratinjau", asing))).toBe("400 HEADER_TIDAK_LENGKAP");
    });

    test("baris dengan isi DI LUAR lebar header dilaporkan cacat dengan nomor barisnya", async () => {
      const sheet =
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>kode_mitra</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t>nama_lengkap</t></is></c></row>' +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>KX-${f.suffix}-R1</t></is></c>` +
        '<c r="B2" t="inlineStr"><is><t>Mitra Lebar</t></is></c>' +
        '<c r="C2" t="inlineStr"><is><t>nyasar</t></is></c></row>' +
        "</sheetData></worksheet>";
      const res = await kirim("pratinjau", buatZip(bagianWorkbook(sheet)));
      expect(res.status).toBe(200);
      const laporan = (await res.json()) as { ditolak: { nomorBaris: number }[]; siapKomit: boolean };
      expect(laporan.ditolak.map((r) => r.nomorBaris)).toEqual([2]);
      expect(laporan.siapKomit).toBe(false);
    });
  });

  describe("tidak ada satu baris pun ditulis oleh berkas yang ditolak", () => {
    test("setelah semua arsip jahat di atas, tidak ada berkas impor yang tercatat", async () => {
      const r = await f.db.query<{ n: string }>(
        `select count(*)::text as n from impor_berkas where bumn_id = $1::uuid and nama_file like '%.xlsx'`,
        [f.bumnId],
      );
      // Exactly ONE: the single successful commit in the happy-path test.
      expect(Number(r[0]?.n ?? "0")).toBe(1);
    });
  });
});
