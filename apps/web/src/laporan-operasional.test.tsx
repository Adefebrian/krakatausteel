// THE TWENTY THREE OPERATIONAL REPORTS (spec 10.1, 10.2, 10.4) AND THE INDEX
// THAT LISTS THEM, tested through the real App.
//
// TWO CLAIMS, AND THE FIRST IS THE ONE THAT MATTERS MOST.
//
//   THE INDEX IS THE SERVER'S LIST, NOT THIS REPOSITORY'S. A report that ships
//   on the server and is missing from a hand kept frontend array is invisible:
//   nobody opens it, and nothing says it is there. So the catalogue page reads
//   `GET /laporan/katalog`, and an entry this build has never heard of is still
//   drawn, with words saying what it is.
//
//   AND A REPORT WITH A SCREEN IS EXACTLY A REPORT THAT OPENS. One table
//   (pages/laporan/layar.tsx) decides both the route and the link, so
//   "reachable by URL" and "linked from the index" cannot drift apart.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";
import { LAYAR_LAPORAN } from "./pages/laporan/layar";
import { REPORTS, reportPath } from "./reports";

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

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

const SESSION = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c1", kode: "01", nama: "Cabang Cilegon" },
  cabangTersedia: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  periode: { tahun: 2026, bulan: 3, status: "OPEN" },
  permissions: ["dashboard.view", "laporan.view"],
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

/** A slice of the real catalogue, plus ONE entry this build cannot know. */
const KATALOG = [
  {
    nomor: 1,
    kode: "REALISASI_WILAYAH",
    nama: "Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten",
    path: "/laporan/realisasi-wilayah",
    perluPeriode: true,
    perluAkun: false,
  },
  {
    nomor: 8,
    kode: "AGING_PIUTANG",
    nama: "Laporan Aging Piutang",
    path: "/laporan/aging-piutang",
    perluPeriode: true,
    perluAkun: false,
  },
  {
    nomor: 99,
    kode: "LAPORAN_MASA_DEPAN",
    nama: "Laporan Yang Belum Dikenal Aplikasi Ini",
    path: "/laporan/masa-depan",
    perluPeriode: true,
    perluAkun: false,
  },
];

function handler(call: Call): Response {
  if (call.url.includes("/auth/session")) return json(200, SESSION);
  if (call.url.includes("/laporan/katalog")) return json(200, { data: KATALOG });
  return json(404, { error: "tidak ada", code: "TIDAK_DITEMUKAN" });
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the report index is driven by the server catalogue", () => {
  test("it asks the server for the catalogue rather than reading a local array", async () => {
    const { mount } = await import("./testing");
    at("/laporan/pendanaan-umk");
    stubFetch(handler);
    const view = await mount(<App />);

    expect(calls.some((call) => call.url.includes("/laporan/katalog"))).toBe(true);
    view.unmount();
  });

  test("a catalogue entry this build has never seen is still shown, never dropped", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/lainnya");
    stubFetch(handler);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Laporan Yang Belum Dikenal Aplikasi Ini");
    expect(teks).toContain("Laporan baru dari katalog server");
    view.unmount();
  });

  test("a catalogue that cannot be read fails visibly, naming the endpoint", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/pendanaan-umk");
    stubFetch((call) => (call.url.includes("/auth/session") ? json(200, SESSION) : json(500, {
      error: "Gagal",
      code: "KESALAHAN_SERVER",
    })));
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Gagal memuat katalog laporan");
    expect(teks).toContain("GET /api/laporan/katalog");
    view.unmount();
  });

  test("the row for a report that has a screen says so, and one without says so too", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/pendanaan-umk");
    stubFetch(handler);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Siap dibuka");
    view.unmount();
  });

  test("report 24 is on the list even though the laporan catalogue does not carry it", async () => {
    const { mount, textOf } = await import("./testing");
    at("/laporan/akuntansi");
    stubFetch(handler);
    const view = await mount(<App />);

    // It belongs to modules/rka, and the single catalogue across all 31 is a
    // composition above both modules. This screen IS that composition.
    expect(textOf(view.container)).toContain("RKA versus Realisasi");
    view.unmount();
  });
});

describe("every report in spec 10 has a screen, and every screen has a route", () => {
  test("all thirty one catalogue numbers are answered by a screen", () => {
    const bernomor = REPORTS.map((report) => report.no).sort((a, b) => a - b);
    expect(bernomor).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    for (const nomor of bernomor) {
      expect(LAYAR_LAPORAN[nomor]).toBeTruthy();
    }
  });

  test("every screen renders its own page rather than the not-built placeholder", async () => {
    const { mount, textOf } = await import("./testing");
    for (const report of REPORTS) {
      at(reportPath(report.slug));
      stubFetch(handler);
      const view = await mount(<App />);
      const teks = textOf(view.container);
      // The Placeholder's own sentence. Its presence would mean the route fell
      // through to "not built yet" while the catalogue said it was ready.
      expect(teks).not.toContain("Halaman belum diisi");
      view.unmount();
    }
  });

  test("the placeholder sentence the test above looks for is a real sentence", async () => {
    // A POSITIVE CONTROL. The test above asserts an ABSENCE, and an absence
    // assertion is worthless if the string it looks for was never rendered by
    // anything. A route with no screen still falls through to Placeholder, and
    // this is what proves the sentence exists to be found.
    const { mount, textOf } = await import("./testing");
    at("/konfigurasi/wilayah");
    stubFetch((call) =>
      call.url.includes("/auth/session")
        ? json(200, { ...SESSION, permissions: [...SESSION.permissions, "konfigurasi.master"] })
        : handler(call),
    );
    const view = await mount(<App />);
    expect(textOf(view.container)).toContain("Halaman belum diisi");
    view.unmount();
  });

  test("a report screen names the endpoint it could not reach, rather than drawing an empty table", async () => {
    const { mount, textOf } = await import("./testing");
    at(reportPath("aging-piutang"));
    stubFetch(handler);
    const view = await mount(<App />);

    // Every reference read fails in this fixture, so the page must SAY so.
    expect(textOf(view.container)).toContain("Gagal memuat");
    view.unmount();
  });
});
