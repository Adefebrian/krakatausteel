// Parameter Sistem, spec 9.4, and the one thing this screen exists to prevent:
// an invented number read as settled policy.
//
// The four Non PUMK limits were invented by us, because the contract left them
// undecided and the system could not run without a figure. An accountant
// reading "Nilai maksimum bantuan Non PUMK" has no way to tell that apart from
// a figure written in the specification, and the difference matters the moment
// somebody quotes it in a meeting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";
import { mount, selectOption, textOf } from "./testing";

const LONG_DASH = "—";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    handler(String(input))) as FetchFn;
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

const SESSION = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c0", kode: "00", nama: "Kantor Pusat" },
  cabangTersedia: [{ id: "c0", kode: "00", nama: "Kantor Pusat" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: ["dashboard.view", "konfigurasi.parameter"],
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

function baris(over: Record<string, unknown>) {
  return {
    grup: "batasan",
    kunci: "nilai_max_non_pumk",
    nilai: "500000000.00",
    override: false,
    version: 1,
    diubahAt: "2026-08-01T00:00:00.000Z",
    diubahOleh: null,
    perluKonfirmasi: true,
    asalNilaiDefault: "ASUMSI",
    diLuarKatalog: false,
    ...over,
  };
}

const ROWS = {
  data: [
    baris({}),
    baris({
      kunci: "plafon_max_pumk",
      nilai: "50000000.00",
      asalNilaiDefault: "SPEC",
      perluKonfirmasi: false,
    }),
    baris({
      grup: "jasa_adm",
      kunci: "jasa_adm_rate_default",
      nilai: "0.030000",
      asalNilaiDefault: "KEPUTUSAN",
      perluKonfirmasi: false,
      override: true,
      version: 3,
      diubahOleh: "9f8e7d6c-1111-2222-3333-444455556666",
    }),
    baris({
      grup: "integrasi",
      kunci: "kunci_lama_tanpa_katalog",
      nilai: "true",
      asalNilaiDefault: null,
      perluKonfirmasi: false,
      diLuarKatalog: true,
    }),
  ],
};

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubKonfigurasi(body: unknown = ROWS) {
  stubFetch((url) => {
    if (url.includes("/auth/session")) return json(200, SESSION);
    if (url.includes("/konfigurasi")) return json(200, body);
    return notFound();
  });
}

describe("provenance of a shipped default", () => {
  test("an invented number says so, in words, next to its value", async () => {
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);

    const items = [...view.container.querySelectorAll(".param-item")];
    const asumsi = items.find((item) => textOf(item).includes("nilai max non pumk"));
    expect(asumsi).toBeTruthy();
    expect(textOf(asumsi)).toContain("Asumsi kami");
    expect(textOf(asumsi)).toContain("500000000.00");
    expect(textOf(asumsi)).toContain("kami usulkan sendiri");
    view.unmount();
  });

  test("the three provenances are told apart, and an uncatalogued row claims nothing", async () => {
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);

    const teksOf = (kunci: string) =>
      textOf(
        [...view.container.querySelectorAll(".param-item")].find((item) =>
          textOf(item).includes(kunci),
        ),
      );

    expect(teksOf("plafon max pumk")).toContain("Dari spesifikasi");
    expect(teksOf("jasa adm rate default")).toContain("Keputusan tercatat");
    expect(teksOf("nilai max non pumk")).toContain("Asumsi kami");
    // "We do not know where this came from" is NOT "the spec says so".
    expect(teksOf("kunci lama tanpa katalog")).toContain("Asal tidak diketahui");
    view.unmount();
  });

  test("provenance and the confirmation flag are two separate facts, never merged", async () => {
    // A value can be confirmed and still have been invented by us. This row is
    // the opposite case: invented AND still awaiting confirmation, and both
    // are printed.
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);

    const asumsi = [...view.container.querySelectorAll(".param-item")].find((item) =>
      textOf(item).includes("nilai max non pumk"),
    );
    const badges = [...(asumsi?.querySelectorAll(".badge") ?? [])].map((b) => textOf(b));
    expect(badges).toContain("Asumsi kami");
    expect(badges).toContain("Perlu konfirmasi klien");

    // The spec sourced row carries neither of those, but still says where it
    // came from.
    const spec = [...view.container.querySelectorAll(".param-item")].find((item) =>
      textOf(item).includes("plafon max pumk"),
    );
    const specBadges = [...(spec?.querySelectorAll(".badge") ?? [])].map((b) => textOf(b));
    expect(specBadges).toContain("Dari spesifikasi");
    expect(specBadges).not.toContain("Perlu konfirmasi klien");
    view.unmount();
  });

  test("the summary counts each provenance from the same answer the list renders", async () => {
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);

    const bento = textOf(view.container.querySelector(".bento"));
    expect(bento).toContain("Dari spesifikasi");
    expect(bento).toContain("Keputusan tercatat");
    expect(bento).toContain("Asumsi kami");
    expect(bento).toContain("Perlu konfirmasi");
    view.unmount();
  });

  test("the list can be narrowed to just the numbers we invented", async () => {
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);

    await selectOption(
      view.container.querySelector('select[aria-label="Asal nilai default"]') as HTMLSelectElement,
      "ASUMSI",
    );

    const items = [...view.container.querySelectorAll(".param-item")];
    expect(items.length).toBe(1);
    expect(textOf(items[0])).toContain("nilai max non pumk");
    view.unmount();
  });

  test("an override is shown as an override, with its version and who changed it", async () => {
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);

    const item = [...view.container.querySelectorAll(".param-item")].find((row) =>
      textOf(row).includes("jasa adm rate default"),
    );
    expect(textOf(item)).toContain("Nilai diubah");
    expect(textOf(item)).toContain("versi 3");
    // The ordinary case says so in words rather than wearing a badge.
    const bawaan = [...view.container.querySelectorAll(".param-item")].find((row) =>
      textOf(row).includes("plafon max pumk"),
    );
    expect(textOf(bawaan)).toContain("masih nilai bawaan");
    expect(textOf(item)).toContain("ID pengguna 9f8e7d6c");
    view.unmount();
  });

  test("a failed read shows the failure, never a list of parameters with no provenance", async () => {
    at("/konfigurasi/parameter");
    stubFetch((url) => (url.includes("/auth/session") ? json(200, SESSION) : notFound()));
    const view = await mount(<App />);

    expect(textOf(view.container.querySelector(".errorstate"))).toContain(
      "Gagal memuat parameter sistem",
    );
    expect(textOf(view.container.querySelector(".errorstate"))).toContain("GET /api/konfigurasi");
    expect(view.container.querySelector(".param-item")).toBeNull();
    view.unmount();
  });

  test("no long dash and no emoji on the rendered screen", async () => {
    at("/konfigurasi/parameter");
    stubKonfigurasi();
    const view = await mount(<App />);
    const teks = textOf(view.container);
    expect(teks).not.toContain(LONG_DASH);
    expect(/\p{Extended_Pictographic}/u.test(teks)).toBe(false);
    view.unmount();
  });
});
