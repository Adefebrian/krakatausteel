// THE MITRA AREA (spec 4.9, ADR 0019), tested through the real App.
//
// The theme of this file is the split the server paid for and the frontend can
// give away for free: two principals with nothing in common. So the tests here
// are mostly about what is ABSENT, which is the only way to test a separation.
// No staff session request, no staff shell, no staff navigation, no mitra id in
// any URL, and no way past the forced password change.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIN_PANJANG_SANDI } from "@krakatausteel/api/src/modules/mitra/contract";
import { App } from "./App";

/** The banned long dash, written as an escape so this file stays clean itself. */
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

function kosong(status: number): Response {
  return new Response(null, { status });
}

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

const PROFIL = {
  kodeMitra: "MB-0001",
  namaLengkap: "Budi Santoso",
  namaUsaha: "Warung Budi",
  email: "budi@contoh.id",
  cabang: { kode: "01", nama: "Cabang Cilegon" },
  status: "AKTIF",
  harusGantiSandi: false,
};

const AKAD = {
  id: "a1",
  noAkad: "AK-2026-0001",
  tanggalAkad: "2026-02-01",
  pokokPinjaman: "10000000.00",
  tenorBulan: 24,
  metodePerhitungan: "FLAT",
  tanggalMulaiAngsuran: "2026-03-01",
  tanggalJatuhTempoAkhir: "2028-02-01",
  status: "AKTIF",
  outstandingPokok: "7500000.00",
  outstandingJasa: "150000.00",
  tanggalLunas: null,
};

const AKAD_LUNAS = {
  ...AKAD,
  id: "a2",
  noAkad: "AK-2025-0044",
  tanggalAkad: "2025-01-10",
  status: "LUNAS",
  outstandingPokok: "0.00",
  outstandingJasa: "0.00",
  tanggalLunas: "2026-01-10",
};

const JADWAL = {
  akadId: "a1",
  noAkad: "AK-2026-0001",
  versi: 1,
  outstandingPokok: "7500000.00",
  outstandingJasa: "150000.00",
  baris: [
    {
      angsuranKe: 1,
      tanggalJatuhTempo: "2026-03-01",
      pokok: "416666.00",
      jasaAdm: "25000.00",
      total: "441666.00",
      pokokTerbayar: "416666.00",
      jasaTerbayar: "25000.00",
      status: "LUNAS",
      tanggalLunas: "2026-03-01",
    },
    {
      angsuranKe: 2,
      tanggalJatuhTempo: "2026-04-01",
      pokok: "416666.00",
      jasaAdm: "25000.00",
      total: "441666.00",
      pokokTerbayar: "0.00",
      jasaTerbayar: "0.00",
      status: "BELUM_JATUH_TEMPO",
      tanggalLunas: null,
    },
  ],
};

/** A receipt with NO evidence number. An absent field is not an unreadable one. */
const PEMBAYARAN = [
  {
    tanggalTerima: "2026-03-01",
    jumlahDiterima: "441666.00",
    alokasiPokok: "416666.00",
    alokasiJasa: "25000.00",
    alokasiKelebihan: "0.00",
    noBukti: null,
  },
];

function handlerMitra(call: Call): Response {
  if (call.url.includes("/mitra/saya")) return json(200, PROFIL);
  if (call.url.includes("/mitra/akad/a1/jadwal")) return json(200, JADWAL);
  if (call.url.includes("/mitra/akad/a1/pembayaran")) return json(200, { data: PEMBAYARAN });
  if (call.url.endsWith("/mitra/akad")) return json(200, { data: [AKAD, AKAD_LUNAS] });
  return json(404, { error: "tidak ada", code: "TIDAK_DITEMUKAN" });
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// The separation
// ---------------------------------------------------------------------------

describe("the mitra area is a second principal, not a staff page", () => {
  test("no staff session request is ever made on this surface", async () => {
    const { mount } = await import("./testing");
    at("/mitra");
    stubFetch(handlerMitra);
    const view = await mount(<App />);

    expect(calls.some((call) => call.url.includes("/auth/session"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/mitra/saya"))).toBe(true);
    view.unmount();
  });

  test("no staff shell, no staff navigation, and no link into the staff app", async () => {
    const { mount } = await import("./testing");
    at("/mitra");
    stubFetch(handlerMitra);
    const view = await mount(<App />);

    expect(view.container.querySelector(".shell")).toBeNull();
    expect(view.container.querySelector(".sidenav")).toBeNull();
    const tautan = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(tautan.some((href) => href?.startsWith("/pumk") || href?.startsWith("/admin"))).toBe(
      false,
    );
    view.unmount();
  });

  test("a 401 renders the MITRA sign in form, never the staff one", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra");
    stubFetch(() =>
      json(401, {
        error: "Anda belum masuk.",
        code: "TIDAK_TERAUTENTIKASI",
        kodeDomain: "SESI_MITRA_TIDAK_VALID",
      }),
    );
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Portal Mitra Binaan");
    // The staff form's own words, which must not appear here.
    expect(teks).not.toContain("Nama pengguna");
    expect(view.container.querySelector(".mitra-masuk-kotak")).toBeTruthy();
    view.unmount();
  });

  test("a signed out mitra is shown the form with no error banner on it", async () => {
    const { mount } = await import("./testing");
    at("/mitra");
    stubFetch(() =>
      json(401, {
        error: "Anda belum masuk.",
        code: "TIDAK_TERAUTENTIKASI",
        kodeDomain: "SESI_MITRA_TIDAK_VALID",
      }),
    );
    const view = await mount(<App />);

    // Not signed in is the ordinary case, not a failure to report.
    expect(view.container.querySelector(".mitra-gagal")).toBeNull();
    view.unmount();
  });

  test("an unreachable server is told apart from a rejected session", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra");
    globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as FetchFn;
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Server tidak dapat dihubungi");
    // And it is NOT the sign in form: telling a borrower their password failed
    // when the server is down sends them to a branch office over nothing.
    expect(view.container.querySelector(".mitra-masuk-kotak")).toBeNull();
    view.unmount();
  });

  test("no request this surface makes carries a mitra id, a NIK or an akad number", async () => {
    const { mount } = await import("./testing");
    at("/mitra/akad/a1");
    stubFetch(handlerMitra);
    const view = await mount(<App />);

    for (const call of calls) {
      expect(call.url).not.toContain("mitraId");
      expect(call.url).not.toContain("nik");
      expect(call.url).not.toContain("AK-2026");
    }
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The forced password change
// ---------------------------------------------------------------------------

describe("the first password may only replace itself", () => {
  test("an account that must change its password sees nothing else at all", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra/akad");
    stubFetch((call) =>
      call.url.includes("/mitra/saya")
        ? json(200, { ...PROFIL, harusGantiSandi: true })
        : json(200, { data: [AKAD] }),
    );
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Ganti Kata Sandi Dulu");
    // No tabs, no akad, no way round it.
    expect(view.container.querySelector(".mitra-tabbar")).toBeNull();
    expect(teks).not.toContain("AK-2026-0001");
    // And the akad list was never even asked for.
    expect(calls.some((call) => call.url.endsWith("/mitra/akad"))).toBe(false);
    view.unmount();
  });

  test("the minimum length on screen is the server's own constant", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra");
    stubFetch((call) =>
      call.url.includes("/mitra/saya")
        ? json(200, { ...PROFIL, harusGantiSandi: true })
        : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain(`Minimal ${MIN_PANJANG_SANDI} karakter`);
    view.unmount();
  });

  test("signing out is reachable from the gate, so nobody is trapped on it", async () => {
    const { mount } = await import("./testing");
    at("/mitra");
    stubFetch((call) =>
      call.url.includes("/mitra/saya")
        ? json(200, { ...PROFIL, harusGantiSandi: true })
        : kosong(204),
    );
    const view = await mount(<App />);

    const keluar = [...view.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Keluar"),
    );
    expect(keluar).toBeTruthy();
    view.unmount();
  });

  test("a too short password is refused before any request is sent", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/mitra");
    stubFetch((call) =>
      call.url.includes("/mitra/saya")
        ? json(200, { ...PROFIL, harusGantiSandi: true })
        : kosong(204),
    );
    const view = await mount(<App />);

    const kotak = view.container.querySelectorAll("input");
    await typeInto(kotak[0] as HTMLInputElement, "sandi-lama-yang-panjang");
    await typeInto(kotak[1] as HTMLInputElement, "pendek");
    await typeInto(kotak[2] as HTMLInputElement, "pendek");
    await clickOn(
      [...view.container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Simpan kata sandi baru"),
      ) as Element,
    );

    expect(calls.some((call) => call.url.includes("/mitra/ganti-sandi"))).toBe(false);
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// What a mitra sees
// ---------------------------------------------------------------------------

describe("a mitra sees its own akad and nothing else", () => {
  test("the landing screen totals the akad it was given, in integer cents", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra");
    stubFetch(handlerMitra);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Budi Santoso");
    expect(teks).toContain("MB-0001");
    // 7.500.000,00 + 0,00, summed as strings and printed by packages/ui.
    expect(teks).toContain("Rp 7.500.000,00");
    expect(teks).toContain("Rp 150.000,00");
    view.unmount();
  });

  test("the akad list carries every akad in one shape, with its status in words", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra/akad");
    stubFetch(handlerMitra);
    const view = await mount(<App />);

    const kartu = view.container.querySelectorAll(".mitra-akad-kartu");
    expect(kartu.length).toBe(2);
    const teks = textOf(view.container);
    expect(teks).toContain("Berjalan");
    expect(teks).toContain("Lunas");
    // Every card has the same parts, so no card is a different shape.
    for (const satu of kartu) {
      expect(satu.querySelector(".mitra-akad-sisa")).toBeTruthy();
      expect(satu.querySelector(".mitra-akad-buka")).toBeTruthy();
    }
    view.unmount();
  });

  test("the schedule and the receipts are two reads, and one can fail without the other", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra/akad/a1");
    stubFetch((call) =>
      call.url.includes("/pembayaran")
        ? json(500, { error: "Gagal membaca setoran", code: "KESALAHAN_SERVER" })
        : handlerMitra(call),
    );
    const view = await mount(<App />);

    const teks = textOf(view.container);
    // The half that arrived is still shown.
    expect(teks).toContain("AK-2026-0001");
    expect(teks).toContain("Angsuran ke 1");
    // And the half that did not says so, by name.
    expect(teks).toContain("Gagal memuat daftar setoran");
    view.unmount();
  });

  test("an absent receipt number is printed as words, never as the money marker", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra/akad/a1");
    stubFetch(handlerMitra);
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Tanpa nomor bukti");
    // "tidak sah" is what an UNREADABLE figure prints. A receipt with no
    // evidence number is not unreadable, and a marker there would send a
    // borrower chasing a fault that is not there.
    expect(teks).not.toContain("tidak sah");
    view.unmount();
  });

  test("an akad that is not this mitra's reads exactly like one that does not exist", async () => {
    const { mount, textOf } = await import("./testing");
    at("/mitra/akad/a9");
    stubFetch((call) =>
      call.url.includes("/mitra/saya")
        ? json(200, PROFIL)
        : json(404, {
            error: "Akad tidak ditemukan.",
            code: "TIDAK_DITEMUKAN",
            kodeDomain: "AKAD_TIDAK_DITEMUKAN",
          }),
    );
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Akad tidak ditemukan");
    // Nothing on screen may hint that the id names a real contract owned by
    // somebody else, which is the whole question an enumerating caller has.
    expect(teks).not.toContain("mitra lain");
    expect(teks).not.toContain("bukan milik");
    view.unmount();
  });

  test("no long dash anywhere on the mitra screens", async () => {
    const { mount, textOf } = await import("./testing");
    for (const path of ["/mitra", "/mitra/akad", "/mitra/akad/a1", "/mitra/akun"]) {
      at(path);
      stubFetch(handlerMitra);
      const view = await mount(<App />);
      expect(textOf(view.container)).not.toContain(LONG_DASH);
      view.unmount();
    }
  });
});
