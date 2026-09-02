// Fase 6: the RKA screens (spec 9.3) and the accounting statements
// (spec 10.3), tested through the real App. The router, the session
// bootstrap, the permission gate and the page all take part, and the only
// thing replaced is the transport.
//
// The theme of this file is that a number on one of these screens is either
// the server's own or is visibly absent, and that a budget figure is always
// attached to the VERSION it belongs to. Those are the two ways an accounting
// screen lies: by printing a figure nobody can source, and by printing a
// variance without saying what it was measured against.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";

// The banned long dash, written as an escape so this file stays clean itself.
const LONG_DASH = "—";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body: string | null;
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  }) as FetchFn;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } });
}

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

// ---------------------------------------------------------------------------
// Fixtures. Every one of them is a SHAPE the API contract already names; none
// of them stands in for a validation, only for a transport.
// ---------------------------------------------------------------------------

const SESSION = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c1", kode: "01", nama: "Cabang Cilegon" },
  cabangTersedia: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  periode: { tahun: 2026, bulan: 3, status: "OPEN" },
  permissions: [
    "dashboard.view",
    "laporan.view",
    "admin.rka",
    "admin.rka.approve",
    "admin.rka.view",
  ],
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

/** Holds the input code but not the approval code. Spec 2's separation. */
const SESSION_TANPA_APPROVE = {
  ...SESSION,
  permissions: ["dashboard.view", "laporan.view", "admin.rka", "admin.rka.view"],
};

const REFERENSI = {
  jenis: "PUMK",
  dimensi: "SEKTOR",
  opsi: [
    { id: "s1", kode: "01", nama: "Perdagangan" },
    { id: "s2", kode: "02", nama: "Industri" },
  ],
  cabang: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  bolehKonsolidasi: true,
  tahunBukuMulaiBulan: 1,
};

const RKA_V1 = {
  id: "r1",
  bumnId: "b1",
  cabangId: null,
  tahun: 2026,
  jenis: "PUMK",
  status: "DISETUJUI",
  versi: 1,
  approvedBy: "u9",
  approvedAt: "2026-01-15",
  keterangan: "Anggaran awal 2026",
  createdBy: "u1",
  versiSebelumnya: null,
};

const RKA_V2 = {
  ...RKA_V1,
  id: "r2",
  status: "DRAFT",
  versi: 2,
  approvedBy: null,
  approvedAt: null,
  keterangan: "Revisi pertama",
  versiSebelumnya: 1,
};

const DETAIL_V1 = {
  ...RKA_V1,
  totalAnggaran: "1500000000.00",
  baris: [
    {
      id: "b1",
      rkaId: "r1",
      akunId: null,
      sektorId: "s1",
      bidangId: null,
      uraian: "Target penyaluran sektor perdagangan",
      bulan: 1,
      jumlahAnggaran: "1500000000.00",
      jumlahUnit: 40,
      keterangan: null,
    },
  ],
};

const DETAIL_V2 = {
  ...RKA_V2,
  totalAnggaran: "500000000.00",
  baris: [
    {
      id: "b2",
      rkaId: "r2",
      akunId: null,
      sektorId: "s1",
      bidangId: null,
      uraian: "Target sektor perdagangan",
      bulan: 1,
      jumlahAnggaran: "500000000.00",
      jumlahUnit: 12,
      keterangan: null,
    },
    {
      id: "b3",
      rkaId: "r2",
      akunId: null,
      sektorId: "s2",
      bidangId: null,
      uraian: "Target sektor industri",
      bulan: 6,
      jumlahAnggaran: "250000000.00",
      jumlahUnit: 5,
      keterangan: null,
    },
  ],
};

function rkaHandler(call: Call): Response {
  const { url } = call;
  if (url.includes("/auth/session")) return json(200, SESSION);
  if (url.includes("/rka/referensi")) return json(200, REFERENSI);
  if (url.includes("/rka/baseline")) return json(200, { data: RKA_V1 });
  if (url.includes("/rka/r1/revisi")) return json(201, { ...DETAIL_V2, id: "r3", versi: 3 });
  if (url.includes("/rka/r2/setujui")) return json(200, { ...RKA_V2, status: "DISETUJUI" });
  if (url.includes("/rka/r2/baris")) return json(200, DETAIL_V2);
  if (url.includes("/rka/r1")) return json(200, DETAIL_V1);
  if (url.includes("/rka/r2")) return json(200, DETAIL_V2);
  if (url.includes("/rka?") || url.endsWith("/rka")) return json(200, { data: [RKA_V2, RKA_V1] });
  return notFound();
}

const nol = (nilai = "0.00") => ({ nilai, tampil: "0,00" });
const angka = (nilai: string, tampil: string) => ({ nilai, tampil });

const HEADER = {
  namaBumn: "PT Krakatau Steel (Persero) Tbk",
  namaLaporan: "Laporan Posisi Keuangan",
  periodeLabel: "Maret 2026",
  periodeId: "p1",
  statusPeriode: "CLOSED",
  dariTanggal: "2026-03-01",
  sampaiTanggal: "2026-03-31",
  cabangId: null,
  namaCabang: "Semua Cabang",
  tanggalCetak: "2026-09-02",
  dicetakOleh: "Sri Handayani",
  sumberData: "SNAPSHOT_PERIODE",
  templateLaporanId: "t1",
  sumberTemplate: "TEMPLATE_PERIODE",
};

const PERIODE = {
  data: [
    {
      id: "p1",
      tahun: 2026,
      bulan: 3,
      tanggalMulai: "2026-03-01",
      tanggalAkhir: "2026-03-31",
      status: "CLOSED",
      sumberData: "SNAPSHOT_PERIODE",
    },
  ],
};

const CABANG_FILTER = {
  cabang: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  bolehSemuaCabang: true,
  cabangSendiriId: "c1",
};

const KOLOM_TITIK = {
  labelTahunIni: "31 Maret 2026",
  dariTahunIni: "2026-01-01",
  sampaiTahunIni: "2026-03-31",
  labelTahunLalu: "31 Desember 2025",
  dariTahunLalu: "2025-01-01",
  sampaiTahunLalu: "2025-12-31",
};

const KOLOM_RENTANG = {
  labelTahunIni: "Januari sampai Maret 2026",
  dariTahunIni: "2026-01-01",
  sampaiTahunIni: "2026-03-31",
  labelTahunLalu: "Januari sampai Maret 2025",
  dariTahunLalu: "2025-01-01",
  sampaiTahunLalu: "2025-03-31",
};

function baris(id: string, nama: string, ini: string, lalu: string, tampilIni: string) {
  return {
    barisLaporanId: id,
    kode: id,
    nama,
    parentKode: null,
    urutan: 1,
    level: 1,
    tipeBaris: "DETAIL" as const,
    seksi: null,
    tanda: 1 as const,
    cetakTebal: false,
    akunKode: ["1101"],
    nilaiTahunIni: angka(ini, tampilIni),
    nilaiTahunLalu: angka(lalu, "0,00"),
  };
}

const POSISI = {
  header: HEADER,
  kolom: KOLOM_TITIK,
  baris: [],
  barisAset: [
    baris("a1", "Kas dan setara kas", "12500000.00", "0.00", "12.500.000,00"),
    // A figure that did not arrive. It must NOT render as a zero.
    {
      ...baris("a2", "Piutang mitra binaan", "0.00", "0.00", "0,00"),
      nilaiTahunIni: { nilai: "bukan-angka", tampil: "" },
    },
  ],
  barisLiabilitas: [baris("l1", "Utang jangka pendek", "0.00", "0.00", "0,00")],
  barisAsetNeto: [baris("n1", "Aset neto tanpa pembatasan", "12500000.00", "0.00", "12.500.000,00")],
  totalAsetTahunIni: angka("12500000.00", "12.500.000,00"),
  totalAsetTahunLalu: nol(),
  totalLiabilitasTahunIni: nol(),
  totalLiabilitasTahunLalu: nol(),
  totalAsetNetoTahunIni: angka("12500000.00", "12.500.000,00"),
  totalAsetNetoTahunLalu: nol(),
  kenaikanAsetNetoPeriodeBerjalanTahunIni: angka("12500000.00", "12.500.000,00"),
  kenaikanAsetNetoPeriodeBerjalanTahunLalu: nol(),
  totalLiabilitasDanAsetNetoTahunIni: angka("12500000.00", "12.500.000,00"),
  totalLiabilitasDanAsetNetoTahunLalu: nol(),
  kasDanSetaraKasTahunIni: angka("12500000.00", "12.500.000,00"),
  kasDanSetaraKasTahunLalu: nol(),
};

const ARUS_KAS = {
  header: { ...HEADER, namaLaporan: "Laporan Arus Kas" },
  kolom: KOLOM_RENTANG,
  seksi: [
    {
      klasifikasi: "OPERASI",
      nama: "Arus kas dari aktivitas operasi",
      baris: [
        {
          akunId: "k1",
          akunKode: "1101",
          uraian: "Penerimaan angsuran mitra binaan",
          nilaiTahunIni: angka("12500000.00", "12.500.000,00"),
          nilaiTahunLalu: nol(),
        },
      ],
      totalTahunIni: angka("12500000.00", "12.500.000,00"),
      totalTahunLalu: nol(),
    },
  ],
  kenaikanKasTahunIni: angka("12500000.00", "12.500.000,00"),
  kenaikanKasTahunLalu: nol(),
  kasAwalTahunIni: nol(),
  kasAwalTahunLalu: nol(),
  kasAkhirTahunIni: angka("12500000.00", "12.500.000,00"),
  kasAkhirTahunLalu: nol(),
  akunKas: [
    { akunId: "k1", kode: "1101", nama: "Kas Bank Mandiri", saldo: angka("12500000.00", "12.500.000,00") },
  ],
};

const BAGAN = {
  header: { ...HEADER, namaLaporan: "Bagan Akun" },
  baris: [
    {
      akunId: "k1",
      kode: "1101",
      nama: "Kas Bank Mandiri",
      parentId: null,
      level: 0,
      tipe: "ASET",
      saldoNormal: "D",
      isPostable: true,
      isKas: true,
      isKontra: false,
      klasifikasiArusKas: "OPERASI",
      klasifikasiLaporan: "ASET_LANCAR",
      aktif: true,
      status: "AKTIF",
    },
  ],
};

const BUKU_BESAR = {
  header: { ...HEADER, namaLaporan: "Buku Besar" },
  akunId: "k1",
  akunKode: "1101",
  akunNama: "Kas Bank Mandiri",
  tipe: "ASET",
  saldoNormal: "D",
  saldoAwal: nol(),
  mutasi: [
    {
      jurnalId: "j-777",
      jurnalBarisId: "jb-888",
      noJurnal: "JU-2026-03-0001",
      tanggal: "2026-03-04",
      jenisJurnal: "PENERIMAAN_ANGSURAN",
      keterangan: "Angsuran ke 3 mitra MB-0001",
      debit: angka("12500000.00", "12.500.000,00"),
      kredit: nol(),
      saldoBerjalan: angka("12500000.00", "12.500.000,00"),
      mitraId: "m1",
      akadId: "a1",
      cabangId: "c1",
    },
  ],
  totalDebit: angka("12500000.00", "12.500.000,00"),
  totalKredit: nol(),
  saldoAkhir: angka("12500000.00", "12.500.000,00"),
};

function laporanHandler(call: Call): Response {
  const { url } = call;
  if (url.includes("/auth/session")) return json(200, SESSION);
  if (url.includes("/laporan/periode")) return json(200, PERIODE);
  if (url.includes("/laporan/cabang")) return json(200, CABANG_FILTER);
  if (url.includes("/laporan/bagan-akun")) return json(200, BAGAN);
  if (url.includes("/laporan/posisi-keuangan")) return json(200, POSISI);
  if (url.includes("/laporan/arus-kas")) return json(200, ARUS_KAS);
  if (url.includes("/laporan/buku-besar")) return json(200, BUKU_BESAR);
  return notFound();
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// RKA
// ---------------------------------------------------------------------------

describe("RKA: the version model is on the screen, not implied", () => {
  test("an endpoint that does not answer renders the failure panel naming it, not an empty grid", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/rka-pumk");
    stubFetch((call) => (call.url.includes("/auth/session") ? json(200, SESSION) : notFound()));
    const view = await mount(<App />);

    const gagal = view.container.querySelector(".errorstate");
    expect(gagal).toBeTruthy();
    expect(textOf(gagal)).toContain("Gagal memuat referensi RKA");
    expect(textOf(gagal)).toContain("GET /api/rka/referensi");
    view.unmount();
  });

  test("the approved version is marked as the baseline and named in its own panel", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/rka-pumk");
    stubFetch(rkaHandler);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Baseline pembanding");
    // The baseline panel names the version in force and the date it was approved.
    expect(teks).toContain("15-01-2026");
    // And the list marks exactly one row as the baseline.
    const tanda = view.container.querySelectorAll(".daftar-tabel .tanda-baseline");
    expect(tanda.length).toBe(1);
    view.unmount();
  });

  test("a version list with no approved member says the comparison has no baseline", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/rka-pumk");
    stubFetch((call) =>
      call.url.includes("/rka/baseline") ? json(200, { data: null }) : rkaHandler(call),
    );
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Belum ada baseline");
    expect(textOf(view.container)).toContain("belum punya pembanding");
    view.unmount();
  });

  test("a DRAFT is editable and the grid submits every month it holds, not just the one on screen", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/admin/rka-pumk?rka=r2");
    stubFetch(rkaHandler);
    const view = await mount(<App />);

    const simpan = [...view.container.querySelectorAll("button")].find(
      (btn) => btn.textContent?.includes("Simpan seluruh baris"),
    );
    expect(simpan).toBeTruthy();
    await clickOn(simpan as Element);

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/rka/r2/baris"));
    expect(kirim).toBeTruthy();
    const body = JSON.parse(kirim?.body ?? "{}") as { baris: { bulan: number | null }[] };
    // January is on screen, June is not, and both are sent: the server REPLACES
    // the grid, so a partial save silently deletes the month nobody opened.
    expect(body.baris.map((row) => row.bulan).sort()).toEqual([1, 6]);
    view.unmount();
  });

  test("an approved version offers a revision and no editable figure at all", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/rka-pumk?rka=r1");
    stubFetch(rkaHandler);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("tidak bisa diubah lagi");
    const tombol = [...view.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(tombol.some((label) => label.includes("Buat revisi"))).toBe(true);
    expect(tombol.some((label) => label.includes("Simpan seluruh baris"))).toBe(false);
    // Not one money input on an approved version.
    expect(view.container.querySelectorAll(".control.is-numeric").length).toBe(0);
    view.unmount();
  });

  test("a revision posts to the revision endpoint, and never edits the approved version in place", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/admin/rka-pumk?rka=r1");
    stubFetch(rkaHandler);
    const view = await mount(<App />);

    const buka = [...view.container.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Buat revisi"),
    );
    await clickOn(buka as Element);
    const konfirmasi = [...view.container.querySelectorAll(".modal-foot button")].find((btn) =>
      btn.textContent?.includes("Buat revisi"),
    );
    expect(konfirmasi).toBeTruthy();
    await clickOn(konfirmasi as Element);

    expect(calls.some((call) => call.method === "POST" && call.url.includes("/rka/r1/revisi"))).toBe(
      true,
    );
    // Nothing was written to the approved version's own lines.
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/rka/r1/baris"))).toBe(
      false,
    );
    view.unmount();
  });

  test("a note typed into the revision dialog keeps every character it was given", async () => {
    const { mount, clickOn, typeIntoTextarea } = await import("./testing");
    at("/admin/rka-pumk?rka=r1");
    stubFetch(rkaHandler);
    const view = await mount(<App />);

    await clickOn(
      [...view.container.querySelectorAll("button")].find((btn) =>
        btn.textContent?.includes("Buat revisi"),
      ) as Element,
    );
    const catatan = view.container.querySelector(
      "#rka-keterangan-revisi",
    ) as HTMLTextAreaElement;
    expect(catatan).toBeTruthy();
    // Two writes in a row. The dialog used to move focus back to its own panel
    // on every parent render, so the second one landed nowhere and a note
    // ended up one character long.
    catatan.focus();
    await typeIntoTextarea(catatan, "Revisi anggaran");
    // The parent has now re-rendered. Focus must still be in the field the
    // operator was typing into, not back on the dialog panel.
    expect(document.activeElement).toBe(catatan);
    await typeIntoTextarea(catatan, "Revisi anggaran triwulan dua");
    expect(catatan.value).toBe("Revisi anggaran triwulan dua");
    expect(document.activeElement).toBe(catatan);
    view.unmount();
  });

  test("entering a budget and approving one are two authorities, and holding the first does not light up the second", async () => {
    const { mount } = await import("./testing");
    at("/admin/rka-pumk?rka=r2");
    stubFetch((call) =>
      call.url.includes("/auth/session") ? json(200, SESSION_TANPA_APPROVE) : rkaHandler(call),
    );
    const view = await mount(<App />);

    const tombol = [...view.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(tombol.some((label) => label.includes("Simpan seluruh baris"))).toBe(true);
    expect(tombol.some((label) => label.includes("Setujui versi ini"))).toBe(false);
    view.unmount();
  });

  test("a budget figure the field cannot read closes the save button instead of sending zero", async () => {
    const { mount, typeInto, textOf } = await import("./testing");
    at("/admin/rka-pumk?rka=r2");
    stubFetch(rkaHandler);
    const view = await mount(<App />);

    const uang = view.container.querySelector(".control.is-numeric") as HTMLInputElement | null;
    expect(uang).toBeTruthy();
    await typeInto(uang as HTMLInputElement, "seratus juta");

    const simpan = [...view.container.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Simpan seluruh baris"),
    ) as HTMLButtonElement;
    expect(simpan.disabled).toBe(true);
    expect(textOf(view.container)).toContain("tidak terbaca sebagai angka");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe("laporan: the header, the zero, and the two kinds of comparative", () => {
  test("the header carries every field spec 10 asks for, plus which source and which template answered", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/laporan-posisi-keuangan");
    stubFetch(laporanHandler);
    const view = await mount(<App />);

    const kop = textOf(view.container.querySelector(".kop-laporan"));
    expect(kop).toContain("PT Krakatau Steel (Persero) Tbk");
    expect(kop).toContain("Laporan Posisi Keuangan");
    expect(kop).toContain("Maret 2026");
    expect(kop).toContain("Semua Cabang");
    expect(kop).toContain("02-09-2026");
    expect(kop).toContain("Sri Handayani");
    // The two claims a printed page would otherwise lose.
    expect(kop).toContain("Saldo beku periode tertutup");
    expect(kop).toContain("Template yang dicap pada periode");
    view.unmount();
  });

  test("a live period and a stamped template read as different claims from a frozen one", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/laporan-posisi-keuangan");
    stubFetch((call) =>
      call.url.includes("/laporan/posisi-keuangan")
        ? json(200, {
            ...POSISI,
            header: { ...HEADER, sumberData: "LEDGER_LIVE", sumberTemplate: "TEMPLATE_BERLAKU" },
          })
        : laporanHandler(call),
    );
    const view = await mount(<App />);

    const kop = textOf(view.container.querySelector(".kop-laporan"));
    expect(kop).toContain("Dihitung langsung dari ledger");
    expect(kop).toContain("bisa berubah");
    expect(kop).toContain("Template berlaku menurut tanggal");
    view.unmount();
  });

  test("zero renders as 0,00 and a figure that did not arrive renders as a marker, never as a zero", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/laporan-posisi-keuangan");
    stubFetch(laporanHandler);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("0,00");
    // The unreadable cell is a visible marker with the raw value in its title.
    const rusak = view.container.querySelector(".cell-invalid");
    expect(rusak).toBeTruthy();
    expect(rusak?.getAttribute("title")).toContain("bukan-angka");
    view.unmount();
  });

  test("the balance sheet says its comparative is a date and the cash flow says its is a span", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/laporan-posisi-keuangan");
    stubFetch(laporanHandler);
    const posisi = await mount(<App />);
    const teksPosisi = textOf(posisi.container);
    expect(teksPosisi).toContain("posisi pada satu tanggal");
    expect(teksPosisi).not.toContain("rentang periode");
    posisi.unmount();

    at("/laporan/laporan-arus-kas");
    stubFetch(laporanHandler);
    const arus = await mount(<App />);
    const teksArus = textOf(arus.container);
    expect(teksArus).toContain("rentang periode");
    expect(teksArus).not.toContain("posisi pada satu tanggal");
    arus.unmount();
  });

  test("the general ledger drills to the journal with the exact entry and line", async () => {
    const { mount } = await import("./testing");
    at("/laporan/buku-besar");
    stubFetch(laporanHandler);
    const view = await mount(<App />);

    const tautan = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(tautan).toContain("/jurnal?jurnal=j-777&baris=jb-888");
    view.unmount();
  });

  test("the period and branch filters reach the API on every statement", async () => {
    const { mount } = await import("./testing");
    at("/laporan/laporan-posisi-keuangan?periode=p1&cabang=c1");
    stubFetch(laporanHandler);
    const view = await mount(<App />);

    const panggil = calls.find((call) => call.url.includes("/laporan/posisi-keuangan"));
    expect(panggil?.url).toContain("periodeId=p1");
    expect(panggil?.url).toContain("cabangId=c1");
    view.unmount();
  });

  test("Semua Cabang sends no branch at all rather than quietly defaulting to one", async () => {
    const { mount } = await import("./testing");
    at("/laporan/laporan-posisi-keuangan");
    stubFetch(laporanHandler);
    const view = await mount(<App />);

    const panggil = calls.find((call) => call.url.includes("/laporan/posisi-keuangan"));
    expect(panggil?.url).toContain("periodeId=p1");
    expect(panggil?.url).not.toContain("cabangId=");
    view.unmount();
  });

  test("no report offers an Excel or PDF export, and none pretends one is coming with a dead button", async () => {
    const { mount, textOf } = await import("./testing");
    for (const path of ["/laporan/laporan-posisi-keuangan", "/laporan/buku-besar", "/laporan/laporan-arus-kas"]) {
      at(path);
      stubFetch(laporanHandler);
      const view = await mount(<App />);
      const tombol = [...view.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
      expect(tombol.some((label) => /excel|pdf|export/i.test(label))).toBe(false);
      expect(textOf(view.container)).toContain("belum tersedia");
      view.unmount();
    }
  });
});

describe("copy hygiene on the built Fase 6 pages", () => {
  test("no long dash and no emoji anywhere on a rendered RKA or report page", async () => {
    const { mount, textOf } = await import("./testing");
    const halaman: [string, (call: Call) => Response][] = [
      ["/admin/rka-pumk", rkaHandler],
      ["/laporan/laporan-posisi-keuangan", laporanHandler],
      ["/laporan/laporan-arus-kas", laporanHandler],
      ["/laporan/buku-besar", laporanHandler],
      ["/laporan/bagan-akun", laporanHandler],
    ];
    for (const [path, handler] of halaman) {
      at(path);
      stubFetch(handler);
      const view = await mount(<App />);
      const teks = textOf(view.container);
      expect(teks).not.toContain(LONG_DASH);
      expect(/\p{Extended_Pictographic}/u.test(teks)).toBe(false);
      view.unmount();
    }
  });
});
