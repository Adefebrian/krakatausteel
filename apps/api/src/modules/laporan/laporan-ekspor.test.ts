// SPEC 10's export, over HTTP, against the real app.
//
// What this file has to prove is not "a workbook came back". It is four
// things, and each one is a way an export goes wrong quietly:
//
//   1. AN EXPORT IS A SECOND PRIVILEGE. `laporan.export` is not held by Maker
//      or Checker, and a role that may READ a report must still be refused the
//      FILE. Proved by asking as every role in spec 2 and reading the grant
//      out of the shipped catalogue rather than restating it.
//
//   2. AN EXPORT OBEYS THE SAME BRANCH SCOPE. Spec 16 scenario 24 says a
//      branch user asking for another branch is REFUSED, not shown an empty
//      page, "termasuk lewat manipulasi ID di URL atau request API langsung".
//      A downloaded empty workbook reads as "that branch did nothing".
//
//   3. AN EXPORT OF A CLOSED PERIOD SHOWS THE FROZEN FIGURES. This is the one
//      that would be invisible: an export that recomputed from the live ledger
//      would produce a signed-looking document disagreeing with the statements
//      and nothing on the page would say so. The test closes a month, exports
//      it, and asserts CELL BY CELL against the JSON the screen renders.
//
//   4. A PARTNER NAMED `=cmd|' /c calc'!A1` DOES NOT EXECUTE. End to end,
//      through the route, out of the real .xlsx bytes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaRuteLaporan,
  TAHUN_LALU,
  tutupSemuaFixture,
  type DuniaRuteLaporan,
} from "./rute-test-support";
import { PERMISSIONS_BY_ROLE, type RoleCode } from "../auth";
import { KATALOG_LAPORAN, NAMA_LAPORAN_OPERASIONAL, namaBerkasEkspor } from "./index";
import { AnggaranDekompresi, bacaDirektoriZip, bacaEntriZip } from "../../core/xlsx/zip";
import { bacaTabelXlsx } from "../../core/xlsx/baca";

afterAll(tutupSemuaFixture);

let d: DuniaRuteLaporan;

const SEMUA_ROLE: readonly RoleCode[] = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
];

/** The payload, as a partner name, because that is how it would really arrive. */
const NAMA_MITRA_JAHAT = "=cmd|' /c calc'!A1";

beforeAll(async () => {
  d = await buatDuniaRuteLaporan();
  // The partner report 9 is keyed on. Renaming it here rather than in the
  // shared fixture keeps the payload inside this file's own world.
  await d.f.db.query(`UPDATE mitra SET nama_lengkap = $2 WHERE id = $1`, [
    d.mitraKosong,
    NAMA_MITRA_JAHAT,
  ]);
});

function jalur(kode: string, ekstra = ""): string {
  return `/laporan/ekspor/${kode}?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}${ekstra}`;
}

async function bytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** One sheet of a downloaded workbook, by name, as a matrix of strings. */
function lembar(berkas: Uint8Array, nama: string): string[][] {
  const entri = bacaDirektoriZip(berkas);
  const anggaran = new AnggaranDekompresi();
  const dec = new TextDecoder();
  const workbook = dec.decode(
    bacaEntriZip(berkas, entri.find((e) => e.nama === "xl/workbook.xml")!, anggaran),
  );
  const urut = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!);
  const i = urut.indexOf(nama);
  if (i < 0) throw new Error(`lembar "${nama}" tidak ada; yang ada: ${urut.join(", ")}`);
  const xml = dec.decode(
    bacaEntriZip(berkas, entri.find((e) => e.nama === `xl/worksheets/sheet${i + 1}.xml`)!, anggaran),
  );
  // Reuse the reader for the cell walk, by handing it a workbook with just
  // this sheet in it. Simpler: read the whole file and pick, which the reader
  // does not do -- so parse this one sheet's inline strings and values here.
  const baris: string[][] = [];
  for (const m of xml.matchAll(/<row r="\d+"[^>]*>([\s\S]*?)<\/row>/g)) {
    const sel: string[] = [];
    for (const c of m[1]!.matchAll(/<c [^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const isi = c[1] ?? "";
      const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(isi);
      const v = /<v>([\s\S]*?)<\/v>/.exec(isi);
      sel.push(
        t
          ? t[1]!
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&amp;/g, "&")
          : (v?.[1] ?? ""),
      );
    }
    baris.push(sel);
  }
  return baris;
}

// ---------------------------------------------------------------------------

describe("otorisasi: membaca laporan dan MENGAMBIL berkasnya adalah dua izin", () => {
  test("katalog izin: laporan.export dipegang Auditor dan Approver, bukan Maker atau Checker", () => {
    // READ OUT OF THE SHIPPED CATALOGUE, not restated. The day somebody widens
    // the grant, this says so rather than passing quietly.
    for (const role of ["AUDITOR", "APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT"] as const) {
      expect(PERMISSIONS_BY_ROLE[role] as readonly string[]).toContain("laporan.export");
    }
    for (const role of ["MAKER", "CHECKER"] as const) {
      expect(PERMISSIONS_BY_ROLE[role] as readonly string[]).toContain("laporan.view");
      expect(PERMISSIONS_BY_ROLE[role] as readonly string[]).not.toContain("laporan.export");
    }
  });

  test("setiap role: bisa membaca laporan, hanya sebagian yang bisa mengunduh", async () => {
    for (const role of SEMUA_ROLE) {
      const baca = await d.panggil(
        role,
        `/laporan/aging-piutang?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
      );
      expect(`${role} baca: ${baca.status}`).toBe(`${role} baca: 200`);

      const unduh = await d.panggil(role, jalur("AGING_PIUTANG"));
      const bolehEkspor = (PERMISSIONS_BY_ROLE[role] as readonly string[]).includes(
        "laporan.export",
      );
      expect(`${role} unduh: ${unduh.status}`).toBe(`${role} unduh: ${bolehEkspor ? 200 : 403}`);
      if (!bolehEkspor) {
        const body = (await unduh.json()) as { code: string };
        expect(body.code).toBe("TIDAK_BERWENANG");
      }
    }
  });

  test("tanpa sesi sama sekali: 401, bukan berkas", async () => {
    const res = await d.f.request(jalur("AGING_PIUTANG"));
    expect(res.status).toBe(401);
  });
});

describe("scope cabang berlaku sama untuk unduhan (skenario 24)", () => {
  test("Admin Cabang A meminta ekspor cabang B ditolak, bukan diberi berkas kosong", async () => {
    const res = await d.panggil(
      "ADMIN_CABANG",
      `/laporan/ekspor/AGING_PIUTANG?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangB.id}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kodeDomain: string };
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("Admin Cabang A meminta Semua Cabang ditolak juga", async () => {
    const res = await d.panggil(
      "ADMIN_CABANG",
      `/laporan/ekspor/AGING_PIUTANG?periodeId=${d.periodeLaporan.id}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("validasi di batas, sama persis dengan rute laporannya", () => {
  test("periodeId yang hilang ditolak 400 dengan detail per field", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/laporan/ekspor/AGING_PIUTANG");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail?: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(Object.keys(body.detail ?? {})).toContain("periodeId");
  });

  test("Buku Besar tanpa akunId ditolak: filter per laporan ikut terbawa", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/laporan/ekspor/BUKU_BESAR?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: Record<string, string[]> };
    expect(Object.keys(body.detail ?? {})).toContain("akunId");
  });

  test("format yang tidak dikenal ditolak dengan kodenya sendiri", async () => {
    const res = await d.panggil("ADMIN_PUSAT", jalur("AGING_PIUTANG", "&format=doc"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "FORMAT_EKSPOR_TIDAK_DIKENAL",
    );
  });

  test("kode laporan yang tidak ada, termasuk laporan 24 yang milik modul RKA", async () => {
    for (const kode of ["TIDAK_ADA", "RKA_VS_REALISASI"]) {
      const res = await d.panggil("ADMIN_PUSAT", jalur(kode));
      expect(`${kode}: ${res.status}`).toBe(`${kode}: 400`);
      expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe(
        "LAPORAN_TIDAK_DIKENAL",
      );
    }
  });

  // THE TWO HALVES OF THE SAME DEPLOYMENT QUESTION, and each runs on the host
  // it describes. There is no auto-discovery (see
  // core/adapters/pdf-chromium.ts), so `CHROMIUM_PATH` is exactly the switch,
  // and a suite that quietly rendered PDFs on a laptop while skipping them on
  // the server would prove nothing about either.
  test.skipIf(Boolean(process.env.CHROMIUM_PATH))(
    "PDF di host TANPA browser: 503 dengan jalan keluarnya, bukan 500",
    async () => {
      const res = await d.panggil("ADMIN_PUSAT", jalur("AGING_PIUTANG", "&format=pdf"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { kodeDomain: string; error: string };
      expect(body.kodeDomain).toBe("EKSPOR_PDF_TIDAK_TERSEDIA");
      expect(body.error).toContain("HTML");
    },
  );

  test.skipIf(!process.env.CHROMIUM_PATH)(
    "PDF di host DENGAN browser: PDF sungguhan, dari HTML yang sama",
    async () => {
      const res = await d.panggil("ADMIN_PUSAT", jalur("AGING_PIUTANG", "&format=pdf"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain(".pdf");
      const berkas = await bytes(res);
      expect(new TextDecoder().decode(berkas.subarray(0, 5))).toBe("%PDF-");
    },
    60_000,
  );
});

describe("bentuk berkas yang diunduh", () => {
  test("xlsx: tipe konten, Content-Disposition, dan nama berkas yang aman", async () => {
    const res = await d.panggil("ADMIN_PUSAT", jalur("AGING_PIUTANG"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd.startsWith("attachment; filename=")).toBe(true);
    expect(cd).toContain(".xlsx");
    // No CR, LF or quote can reach the header, whatever the branch is called.
    expect(/[\r\n]/.test(cd)).toBe(false);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const berkas = await bytes(res);
    // A real ZIP, and a real workbook: the reader in core/xlsx opens it.
    expect(berkas[0]).toBe(0x50);
    expect(berkas[1]).toBe(0x4b);
    expect(bacaTabelXlsx(berkas).baris.length).toBeGreaterThan(0);
  });

  test("nama berkas menolak karakter yang bisa memecah header", () => {
    const nama = namaBerkasEkspor(
      'Aging Piutang"\r\nSet-Cookie: x=y',
      "Maret 2026",
      "Cabang / Jakarta",
      "xlsx",
    );
    expect(nama).toBe("Aging-Piutang-Set-Cookie-x-y_Maret-2026_Cabang-Jakarta.xlsx");
    expect(/[\r\n"]/.test(nama)).toBe(false);
  });

  test("html: dokumen mandiri, tanpa script dan tanpa satu pun URL", async () => {
    const res = await d.panggil("ADMIN_PUSAT", jalur("AGING_PIUTANG", "&format=html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // Served as a DOWNLOAD, so a document built from user text never runs in
    // this API's own origin.
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  test("setiap laporan di katalog punya rute ekspor yang menjawab", async () => {
    // The catalogue is the contract the SPA renders its report list from. A
    // report with no export route is a button that 400s.
    const perluAkun = `&akunId=${d.akun.kas}`;
    const perluMitra = `&mitraId=${d.mitraKosong}`;
    const rentang = "&dariTanggal=2026-01-01&sampaiTanggal=2026-12-31";
    for (const e of KATALOG_LAPORAN) {
      const q = [
        e.perluPeriode ? `periodeId=${d.periodeLaporan.id}` : "",
        `cabangId=${d.f.cabangA.id}`,
        e.perluAkun ? perluAkun.slice(1) : "",
        e.kode === "KARTU_PIUTANG" ? perluMitra.slice(1) : "",
        e.kode === "JATUH_TEMPO" || e.kode === "AUDIT_TRAIL" ? rentang.slice(1) : "",
      ]
        .filter((s) => s.length > 0)
        .join("&");
      const res = await d.panggil("ADMIN_PUSAT", `/laporan/ekspor/${e.kode}?${q}`);
      expect(`${e.kode}: ${res.status}`).toBe(`${e.kode}: 200`);
    }
  });
});

describe("formula injection: mitra bernama =cmd|' /c calc'!A1", () => {
  test("berkas .xlsx yang diunduh memuat sel yang tidak bisa dieksekusi", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/laporan/ekspor/KARTU_PIUTANG?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}&mitraId=${d.mitraKosong}`,
    );
    expect(res.status).toBe(200);
    const berkas = await bytes(res);

    const kepala = lembar(berkas, "Header");
    const barisNama = kepala.find((r) => r[0] === "Nama Mitra");
    expect(barisNama).toBeDefined();
    // The exact cell content, as it sits in the file. The payload is intact
    // and the cell no longer begins with `=`.
    expect(barisNama![1]).toBe(`'${NAMA_MITRA_JAHAT}`);
    expect(barisNama![1]!.startsWith("=")).toBe(false);

    // And nowhere in the whole package is there a formula element at all.
    const entri = bacaDirektoriZip(berkas);
    const anggaran = new AnggaranDekompresi();
    const dec = new TextDecoder();
    for (const e of entri) {
      const isi = dec.decode(bacaEntriZip(berkas, e, anggaran));
      expect(`${e.nama} punya <f>: ${isi.includes("<f>") || isi.includes("<f ")}`).toBe(
        `${e.nama} punya <f>: false`,
      );
    }
  });

  test("ekspor HTML menetralkan nilai yang sama, karena tabel HTML disalin ke Excel", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/laporan/ekspor/KARTU_PIUTANG?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}&mitraId=${d.mitraKosong}&format=html`,
    );
    const html = await res.text();
    expect(html).toContain("&#39;=cmd|&#39; /c calc&#39;!A1");
    // The raw payload never appears unescaped and unprefixed.
    expect(html).not.toContain(">=cmd");
  });

  test("JSON di layar tetap memuat nama aslinya, apa adanya", async () => {
    // The neutralisation belongs to the EXPORT boundary. Doing it in the engine
    // would put an apostrophe on a partner's name on every screen in the
    // system, and would eventually be written back to the database.
    const hasil = await d.ok<{ namaMitra: string }>(
      "ADMIN_PUSAT",
      `/laporan/kartu-piutang?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}&mitraId=${d.mitraKosong}`,
    );
    expect(hasil.namaMitra).toBe(NAMA_MITRA_JAHAT);
  });
});

describe("periode TERTUTUP: yang diekspor adalah angka beku, sama dengan yang di layar", () => {
  test("neraca lajur bulan tertutup: setiap sel berkas sama dengan JSON layar", async () => {
    // CLOSED THE WAY THE PRODUCT DOES IT. `TJSL-PER-001` refuses to close a
    // month while an earlier one is still open, so a fixture that closed one
    // month alone would be freezing a world the closing engine cannot produce.
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      await d.bekukanDanTutup(d.periode(TAHUN_LALU, bulan));
    }
    const p = d.periode(TAHUN_LALU, 12);

    const layar = await d.ok<{
      header: { sumberData: string; statusPeriode: string };
      baris: Array<Record<string, unknown>>;
    }>("ADMIN_PUSAT", `/laporan/neraca-lajur?periodeId=${p.id}&cabangId=${d.f.cabangA.id}`);

    // The frozen path, said by the engine and printed on the page.
    expect(layar.header.statusPeriode).toBe("CLOSED");
    expect(layar.header.sumberData).toBe("SNAPSHOT_PERIODE");

    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/laporan/ekspor/NERACA_LAJUR?periodeId=${p.id}&cabangId=${d.f.cabangA.id}`,
    );
    expect(res.status).toBe(200);
    const berkas = await bytes(res);

    // The header sheet says which path produced the figures, so a printed page
    // cannot hide that it came from a closed period.
    const kepala = lembar(berkas, "Header");
    expect(kepala.find((r) => r[0] === "Sumber data")?.[1]).toBe("SNAPSHOT_PERIODE");
    expect(kepala.find((r) => r[0] === "Status periode")?.[1]).toBe("CLOSED");

    // And the figures themselves, cell by cell, against the screen's own JSON.
    const utama = lembar(berkas, NAMA_LAPORAN_OPERASIONAL.REKAP_JURNAL ? "Neraca Lajur" : "x");
    const judul = utama[0]!;
    expect(utama.length - 1).toBe(layar.baris.length);

    const kolomUang = judul
      .map((j, i) => ({ j, i }))
      .filter(({ j }) => /Debit|Kredit|Saldo/.test(j));
    expect(kolomUang.length).toBeGreaterThan(0);

    layar.baris.forEach((b, n) => {
      const selBerkas = utama[n + 1]!;
      for (const { j, i } of kolomUang) {
        // `judulDariKunci` turned `saldoDebit` into `Saldo Debit`; go back.
        const kunci = j.charAt(0).toLowerCase() + j.slice(1).replace(/ /g, "");
        const nilai = b[kunci] as { nilai: string } | undefined;
        if (!nilai || typeof nilai.nilai !== "string") continue;
        // EXACT DECIMAL STRING, not a float, and not a rounded display value.
        expect(`${n}.${kunci}=${selBerkas[i] ?? ""}`).toBe(`${n}.${kunci}=${nilai.nilai}`);
      }
    });
  });
});
