// The landing screen (spec 11), tested through the real App. The router, the
// session bootstrap, the permission gate and the page all take part, and the
// only thing replaced is the transport.
//
// THE THEME OF THIS FILE IS THAT A NUMBER ON A DASHBOARD IS A CLAIM, AND EVERY
// CLAIM HAS TO CARRY ITS EVIDENCE. So every assertion below is one of five
// kinds:
//
//   the page is ONE request, because eleven independent reads can straddle a
//   close and put a frozen figure next to a live one on the same screen;
//   every figure says WHICH artefact answered it, and the one figure that has
//   no frozen artefact says so even in a closed month rather than sitting
//   silently among the frozen ones;
//   an ABSENT figure renders its reason, never a zero, and never the money
//   formatter's "tidak sah" marker, which means something else entirely;
//   every figure can be followed to the rows behind it, and those rows carry
//   their ids;
//   a figure the caller may not see is absent WITH A REASON, not blank and not
//   zero.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";

/** The banned long dash, built from its code point so this file stays clean. */
const LONG_DASH = String.fromCharCode(0x2014);

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET" };
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

/** The card for one metric, addressed by the metric's own name. */
function kartu(container: HTMLElement, nama: string): HTMLElement {
  const hit = [...container.querySelectorAll(".metrik-kartu")].find((node) =>
    node.textContent?.includes(nama),
  );
  if (!hit) throw new Error(`kartu metrik "${nama}" tidak ditemukan`);
  return hit as HTMLElement;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const CABANG_A = { id: "c1", kode: "01", nama: "Cabang Cilegon" };
const CABANG_B = { id: "c2", kode: "02", nama: "Cabang Serang" };

const DASAR = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: CABANG_A,
  cabangTersedia: [CABANG_A, CABANG_B],
  periode: { tahun: 2026, bulan: 3, status: "OPEN" },
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

const SESSION_PUSAT = {
  ...DASAR,
  permissions: [
    "dashboard.view",
    "nonpumk.view",
    "laporan.view",
    "admin.rka.view",
    "admin.closing.view",
  ],
};

/** A Maker: holds the page, holds neither evidence code behind two figures. */
const SESSION_MAKER = {
  ...DASAR,
  user: { id: "u2", username: "maker", nama: "Dedi Kurnia", role: "MAKER" },
  roles: ["MAKER"],
  permissions: ["dashboard.view", "nonpumk.view", "pumk.survey"],
};

// ---------------------------------------------------------------------------
// Fixtures. Every shape is one the dashboard contract already names.
// ---------------------------------------------------------------------------

const PERIODE = {
  data: [
    {
      id: "p-open",
      tahun: 2026,
      bulan: 3,
      status: "OPEN",
      tanggalMulai: "2026-03-01",
      tanggalAkhir: "2026-03-31",
    },
    {
      id: "p-closed",
      tahun: 2026,
      bulan: 2,
      status: "CLOSED",
      tanggalMulai: "2026-02-01",
      tanggalAkhir: "2026-02-28",
    },
  ],
};

function metrik(
  kunci: string,
  nama: string,
  jenis: "UANG" | "CACAH" | "PERSEN",
  nilai: string | null,
  sumber: string | null,
  alasanKosong: string | null = null,
) {
  return {
    kunci,
    nama,
    jenis,
    nilai,
    sumber,
    alasanKosong,
    rincian: nilai === null ? null : `metrik:${kunci}`,
  };
}

const ANTRIAN = [
  {
    tahap: "PUMK_SURVEY",
    nama: "PUMK menunggu survey",
    izin: "pumk.survey",
    jumlah: 3,
    milikSaya: true,
    rincian: "antrian:PUMK_SURVEY",
  },
  {
    tahap: "NONPUMK_PENILAIAN",
    nama: "Non PUMK menunggu penilaian",
    izin: "nonpumk.penilaian",
    jumlah: 1,
    milikSaya: false,
    rincian: "antrian:NONPUMK_PENILAIAN",
  },
];

const KOLEKTIBILITAS = [
  {
    kelas: "LANCAR",
    namaKelas: "Lancar",
    bermasalah: false,
    jumlahAkad: 12,
    outstandingPokok: "120000000.00",
    persen: "93.75",
    rincian: "kolektibilitas:LANCAR",
  },
  {
    kelas: "MACET",
    namaKelas: "Macet",
    bermasalah: true,
    jumlahAkad: 1,
    outstandingPokok: "8000000.00",
    persen: "6.25",
    rincian: "kolektibilitas:MACET",
  },
];

const PRASYARAT = {
  boleh: false,
  perluKonfirmasi: false,
  hasil: [
    { nomor: 1, kode: "PERIODE_SEBELUMNYA_BELUM_CLOSED", status: "PASS", alasan: "Periode sebelumnya sudah ditutup." },
    {
      nomor: 2,
      kode: "ADA_JURNAL_DRAFT",
      status: "GAGAL",
      alasan: "Masih ada 2 jurnal berstatus draft bertanggal di periode Maret 2026.",
    },
  ],
};

/** An OPEN month: money read live, no snapshot, so no classification yet. */
const RINGKASAN_OPEN = {
  dibuatPada: "2026-03-20T04:00:00.000Z",
  periode: PERIODE.data[0],
  sumberPeriode: "V_LEDGER_BARIS",
  cabangId: null,
  cabangDilaporkan: [CABANG_A, CABANG_B],
  metrik: [
    metrik("OUTSTANDING_PUMK", "Outstanding Piutang PUMK", "UANG", "128000000.00", "SUB_LEDGER"),
    metrik("PENYALURAN_PUMK", "Realisasi Penyaluran PUMK", "UANG", "25000000.00", "V_LEDGER_BARIS"),
    metrik(
      "REALISASI_NON_PUMK",
      "Realisasi Penyaluran Non PUMK",
      "UANG",
      "3500000.00",
      "V_LEDGER_BARIS",
    ),
    metrik("DANA_TERSALUR", "Dana Tersalur Periode Ini", "UANG", "28500000.00", "V_LEDGER_BARIS"),
    metrik("MITRA_AKTIF", "Jumlah Mitra Binaan Aktif", "CACAH", "13", "SUB_LEDGER"),
    metrik(
      "RASIO_KOLEKTIBILITAS_LANCAR",
      "Rasio Kolektibilitas Lancar",
      "PERSEN",
      null,
      null,
      "KOLEKTIBILITAS_BELUM_DIJALANKAN",
    ),
    metrik("TINGKAT_PENGEMBALIAN", "Tingkat Pengembalian", "PERSEN", "88.20", "SUB_LEDGER"),
    metrik("DANA_TERSEDIA", "Saldo Kas dan Setara Kas", "UANG", "80000000.00", "V_LEDGER_BARIS"),
    metrik("ANGGARAN_NON_PUMK", "Anggaran Non PUMK Bulan Ini", "UANG", "10000000.00", "RKA"),
    metrik("EFEKTIVITAS_NON_PUMK", "Efektivitas Penyaluran Non PUMK", "PERSEN", "35.00", "RKA"),
    metrik("LPJ_TERLAMBAT", "LPJ Non PUMK Terlambat", "CACAH", "2", "PROSES"),
  ],
  kolektibilitas: [],
  alasanKolektibilitasKosong: "KOLEKTIBILITAS_BELUM_DIJALANKAN",
  antrian: ANTRIAN,
  closing: {
    periodeId: "p-open",
    status: "OPEN",
    closedAt: null,
    prasyarat: PRASYARAT,
    alasanKosong: null,
  },
};

/**
 * A CLOSED month: money read frozen, portfolio read from the snapshot, and the
 * collection ratio STILL read from the sub ledger, because no frozen artefact
 * exists for a schedule row. That last row is the one this screen must not
 * smooth over.
 */
const RINGKASAN_CLOSED = {
  ...RINGKASAN_OPEN,
  periode: PERIODE.data[1],
  sumberPeriode: "SALDO_AKUN_PERIODE",
  metrik: [
    metrik(
      "OUTSTANDING_PUMK",
      "Outstanding Piutang PUMK",
      "UANG",
      "128000000.00",
      "KOLEKTIBILITAS_SNAPSHOT",
    ),
    metrik(
      "PENYALURAN_PUMK",
      "Realisasi Penyaluran PUMK",
      "UANG",
      "25000000.00",
      "SALDO_AKUN_PERIODE",
    ),
    metrik(
      "REALISASI_NON_PUMK",
      "Realisasi Penyaluran Non PUMK",
      "UANG",
      null,
      null,
      "SALDO_PERIODE_BELUM_DIBEKUKAN",
    ),
    metrik("DANA_TERSALUR", "Dana Tersalur Periode Ini", "UANG", null, null, "SALDO_PERIODE_BELUM_DIBEKUKAN"),
    metrik("MITRA_AKTIF", "Jumlah Mitra Binaan Aktif", "CACAH", "13", "KOLEKTIBILITAS_SNAPSHOT"),
    metrik(
      "RASIO_KOLEKTIBILITAS_LANCAR",
      "Rasio Kolektibilitas Lancar",
      "PERSEN",
      "93.75",
      "KOLEKTIBILITAS_SNAPSHOT",
    ),
    metrik("TINGKAT_PENGEMBALIAN", "Tingkat Pengembalian", "PERSEN", "88.20", "SUB_LEDGER"),
    metrik("DANA_TERSEDIA", "Saldo Kas dan Setara Kas", "UANG", "80000000.00", "SALDO_AKUN_PERIODE"),
    metrik("ANGGARAN_NON_PUMK", "Anggaran Non PUMK Bulan Ini", "UANG", "10000000.00", "RKA"),
    metrik("EFEKTIVITAS_NON_PUMK", "Efektivitas Penyaluran Non PUMK", "PERSEN", "35.00", "RKA"),
    metrik("LPJ_TERLAMBAT", "LPJ Non PUMK Terlambat", "CACAH", "2", "PROSES"),
  ],
  kolektibilitas: KOLEKTIBILITAS,
  alasanKolektibilitasKosong: null,
  closing: {
    periodeId: "p-closed",
    status: "CLOSED",
    closedAt: "2026-03-05T02:00:00.000Z",
    prasyarat: PRASYARAT,
    alasanKosong: null,
  },
};

/** What a Maker gets: the two budget figures and the checklist blanked. */
const RINGKASAN_MAKER = {
  ...RINGKASAN_OPEN,
  metrik: RINGKASAN_OPEN.metrik.map((m) =>
    m.kunci === "ANGGARAN_NON_PUMK" || m.kunci === "EFEKTIVITAS_NON_PUMK"
      ? { ...m, nilai: null, sumber: null, alasanKosong: "IZIN_TIDAK_DIMILIKI", rincian: null }
      : m,
  ),
  closing: {
    periodeId: "p-open",
    status: "OPEN",
    closedAt: null,
    prasyarat: null,
    alasanKosong: "IZIN_TIDAK_DIMILIKI",
  },
};

const RINCIAN_OUTSTANDING = {
  kunci: "metrik:OUTSTANDING_PUMK",
  nama: "Outstanding Piutang PUMK",
  sumber: "SUB_LEDGER",
  jumlah: 2,
  total: "128000000.00",
  baris: [
    {
      id: "akad-1",
      entitas: "pumk_akad",
      label: "AK-2026-0001 Warung Bu Sri",
      cabangId: "c1",
      tanggal: "2026-01-12",
      nilai: "120000000.00",
      fakta: { mitraId: "m1", statusAkad: "AKTIF", outstandingJasa: "3600000.00" },
    },
    {
      id: "akad-2",
      entitas: "pumk_akad",
      label: "AK-2026-0002 Bengkel Jaya",
      cabangId: "c2",
      tanggal: "2026-02-03",
      nilai: "8000000.00",
      fakta: { mitraId: "m2", statusAkad: "AKTIF", outstandingJasa: "240000.00" },
    },
  ],
  terpotong: false,
};

/** A queue drill down: documents, so every row is deliberately money-less. */
const RINCIAN_ANTRIAN = {
  kunci: "antrian:PUMK_SURVEY",
  nama: "PUMK menunggu survey",
  sumber: "PROSES",
  jumlah: 1,
  total: null,
  baris: [
    {
      id: "prop-9",
      entitas: "pumk_proposal",
      label: "PR-2026-0009 Toko Melati",
      cabangId: "c1",
      tanggal: "2026-03-10",
      nilai: null,
      fakta: { status: "SURVEY_PENDING", nilai: "5000000.00", izin: "pumk.survey" },
    },
  ],
  terpotong: false,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface Pilihan {
  session?: unknown;
  ringkasan?: unknown;
  rincian?: unknown;
}

function handler(pilihan: Pilihan = {}) {
  return (call: Call): Response => {
    const { url } = call;
    if (url.includes("/auth/session")) return json(200, pilihan.session ?? SESSION_PUSAT);
    if (url.includes("/dashboard/periode")) return json(200, PERIODE);
    if (url.includes("/dashboard/rincian")) {
      return json(
        200,
        pilihan.rincian ??
          (url.includes("antrian") ? RINCIAN_ANTRIAN : RINCIAN_OUTSTANDING),
      );
    }
    if (url.includes("/dashboard")) {
      if (url.includes("p-closed")) return json(200, RINGKASAN_CLOSED);
      return json(200, pilihan.ringkasan ?? RINGKASAN_OPEN);
    }
    return notFound();
  };
}

function panggilanRingkasan(): Call[] {
  return calls.filter(
    (call) =>
      call.url.includes("/api/dashboard") &&
      !call.url.includes("/dashboard/periode") &&
      !call.url.includes("/dashboard/rincian"),
  );
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

describe("Dashboard: the whole page is one read", () => {
  test("every figure, both panels and the closing checklist arrive in one call", async () => {
    const { mount } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(panggilanRingkasan().length).toBe(1);
    // And the month picker is its own cheap route, not eleven metrics.
    expect(calls.filter((c) => c.url.includes("/dashboard/periode")).length).toBe(1);
    view.unmount();
  });

  test("the summary waits for the month list, so the page never asks twice", async () => {
    const { mount } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const url = panggilanRingkasan()[0]?.url ?? "";
    expect(url).toContain("periodeId=p-open");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("Dashboard: every figure names the artefact that answered it", () => {
  test("an open month says its money is live, and says so once above the cards", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Ledger berjalan periode terbuka");
    expect(teks).toContain("masih bisa berubah");
    view.unmount();
  });

  test("a closed month says its money is frozen", async () => {
    const { mount, textOf } = await import("./testing");
    at("/?periode=p-closed");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Saldo beku periode tertutup");
    expect(textOf(kartu(view.container, "Saldo Kas dan Setara Kas"))).toContain(
      "Saldo beku periode tertutup",
    );
    view.unmount();
  });

  test("the collection ratio still says sub ledger in a closed month, and says why", async () => {
    const { mount, textOf } = await import("./testing");
    at("/?periode=p-closed");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(kartu(view.container, "Tingkat Pengembalian"));
    expect(teks).toContain("Sub ledger PUMK berjalan");
    expect(teks).toContain("Tidak ada artefak beku");
    // The frozen figure next to it is NOT relabelled: the two claims differ.
    expect(textOf(kartu(view.container, "Outstanding Piutang PUMK"))).toContain(
      "Snapshot kolektibilitas periode tertutup",
    );
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Absent is not zero
// ---------------------------------------------------------------------------

describe("Dashboard: an absent figure is a reason, never a zero", () => {
  test("a metric with no snapshot prints the reason and no figure at all", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(kartu(view.container, "Rasio Kolektibilitas Lancar"));
    expect(teks).toContain("Kolektibilitas belum dijalankan");
    expect(teks).not.toContain("0,00");
    expect(teks).not.toContain("tidak sah");
    view.unmount();
  });

  test("an absent figure offers no drill down, because there are no rows behind it", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const kosong = kartu(view.container, "Rasio Kolektibilitas Lancar");
    expect(kosong.querySelector(".metrik-drill")).toBeNull();
    expect(textOf(kosong)).toContain("Tidak ada baris yang bisa ditelusuri");
    // A card that DOES have a figure keeps its control, so the row still reads
    // as one shape.
    expect(kartu(view.container, "Outstanding Piutang PUMK").querySelector(".metrik-drill")).not
      .toBeNull();
    view.unmount();
  });

  test("a figure the caller may not see is absent with a reason, not blank and not zero", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler({ session: SESSION_MAKER, ringkasan: RINGKASAN_MAKER }));
    const view = await mount(<App />);

    const anggaran = textOf(kartu(view.container, "Anggaran Non PUMK Bulan Ini"));
    expect(anggaran).toContain("Tidak ditampilkan");
    expect(anggaran).toContain("kewenangan yang belum Anda miliki");
    expect(anggaran).not.toContain("0,00");

    const teks = textOf(view.container);
    expect(teks).toContain("Checklist prasyarat tidak ditampilkan");
    expect(teks).toContain("admin.closing.view");
    view.unmount();
  });

  test("a portfolio with no snapshot says so instead of drawing an empty distribution", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Belum ada klasifikasi untuk periode ini");
    expect(teks).toContain("bukan nol, melainkan belum ada");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Drill down
// ---------------------------------------------------------------------------

describe("Dashboard: every number can be followed to the rows behind it", () => {
  test("clicking a KPI asks for its own key and shows the rows with their ids", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const tombol = kartu(view.container, "Outstanding Piutang PUMK").querySelector(
      ".metrik-drill",
    ) as HTMLButtonElement;
    await clickOn(tombol);

    const diminta = calls.find((c) => c.url.includes("/dashboard/rincian"));
    expect(diminta?.url).toContain(`kunci=${encodeURIComponent("metrik:OUTSTANDING_PUMK")}`);

    const dialog = view.container.querySelector(".modal-panel") as HTMLElement;
    const teks = textOf(dialog);
    expect(teks).toContain("AK-2026-0001 Warung Bu Sri");
    expect(teks).toContain("akad-1");
    expect(teks).toContain("120.000.000,00");
    expect(teks).toContain("Sub ledger PUMK berjalan");
    view.unmount();
  });

  test("a kolektibilitas class and a queue stage are drillable on the same terms", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/?periode=p-closed");
    stubFetch(handler());
    const view = await mount(<App />);

    const baris = [...view.container.querySelectorAll(".daftar-tabel tbody tr")].find((tr) =>
      tr.textContent?.includes("Macet"),
    );
    await clickOn(baris as Element);
    expect(
      calls.some((c) => c.url.includes(encodeURIComponent("kolektibilitas:MACET"))),
    ).toBe(true);
    view.unmount();
  });

  test("a drill down row with no money value says so, and never prints the money marker", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    stubFetch(handler({ rincian: RINCIAN_ANTRIAN }));
    const view = await mount(<App />);

    const baris = [...view.container.querySelectorAll(".daftar-tabel tbody tr")].find((tr) =>
      tr.textContent?.includes("PUMK menunggu survey"),
    );
    await clickOn(baris as Element);

    const dialog = view.container.querySelector(".modal-panel") as HTMLElement;
    const teks = textOf(dialog);
    expect(teks).toContain("Tanpa nilai uang");
    expect(teks).toContain("Angka ini berupa cacah, tidak ada total uang");
    expect(teks).not.toContain("tidak sah");
    expect(teks).toContain("prop-9");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The queue, and the page's own copy
// ---------------------------------------------------------------------------

describe("Dashboard: the work queue and the page copy", () => {
  test("the whole queue is shown, with the stage the caller acts on marked", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("PUMK menunggu survey");
    expect(teks).toContain("Non PUMK menunggu penilaian");
    expect(teks).toContain("Tugas Anda");
    expect(teks).toContain("pumk.survey");
    view.unmount();
  });

  test("nothing on this page writes, and the page says so", async () => {
    const { mount, textOf } = await import("./testing");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(textOf(view.container)).toContain("Halaman ini hanya membaca");
    view.unmount();
  });

  test("the copy carries no long dash", async () => {
    const { mount, textOf } = await import("./testing");
    at("/?periode=p-closed");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(textOf(view.container)).not.toContain(LONG_DASH);
    view.unmount();
  });
});
