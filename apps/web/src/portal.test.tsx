// The PUBLIC PORTAL (spec 9.5), tested through the real App.
//
// The theme of this file is the property the server built and a screen can
// silently undo: that the status check answers IDENTICALLY for an unknown
// ticket and a wrong verifier, so it cannot be used to discover who applied.
// Every test below is either that property, or the second one that matters as
// much: that a member of the public on this surface never touches the staff
// session at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FIELD_NON_PUMK, FIELD_PUMK } from "@krakatausteel/api/src/modules/portal/contract";
import { App } from "./App";
import { FORM_NON_PUMK, FORM_PUMK } from "./portal/formulir";

/** The banned long dash, written as an escape so this file stays clean itself. */
const LONG_DASH = "—";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body: string | null;
  credentials: RequestCredentials | undefined;
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      credentials: init?.credentials,
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

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

const HASIL_AJUKAN = {
  noTiket: "TKT-202609-A1B2C3D4E5",
  jenis: "PUMK",
  tanggalSubmit: "2026-09-05",
  status: "BARU",
  pesan: "Pengajuan Anda sudah kami terima dan masuk antrean verifikasi.",
};

const STATUS_DIPROSES = {
  noTiket: "TKT-202609-A1B2C3D4E5",
  jenis: "PUMK",
  tanggalSubmit: "2026-09-05",
  status: "DIPROSES",
  pesan: "Pengajuan Anda sedang diverifikasi petugas.",
};

/** The one refusal the engine ever gives a failed status check. */
const REFUSAL = {
  error: "Nomor tiket atau data pemeriksa tidak cocok.",
  code: "TIDAK_TERAUTENTIKASI",
  kodeDomain: "TIKET_ATAU_PEMERIKSA_SALAH",
};

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// The surface split
// ---------------------------------------------------------------------------

describe("the public portal is not the staff app with the menu hidden", () => {
  test("no session request is made at all on a public page", async () => {
    const { mount } = await import("./testing");
    at("/pengajuan");
    stubFetch(() => json(404, { error: "tidak dipanggil", code: "TIDAK_DITEMUKAN" }));
    const view = await mount(<App />);

    // The staff bootstrap is the thing that must not run: it would 401, and a
    // member of the public would be shown a login form for a system they have
    // no account for.
    expect(calls.some((call) => call.url.includes("/auth/session"))).toBe(false);
    view.unmount();
  });

  test("no staff navigation, no staff shell, and no link into the staff app", async () => {
    const { mount, textOf } = await import("./testing");
    at("/pengajuan");
    stubFetch(() => json(404, { error: "x", code: "TIDAK_DITEMUKAN" }));
    const view = await mount(<App />);

    expect(view.container.querySelector(".shell")).toBeNull();
    expect(view.container.querySelector(".sidenav")).toBeNull();
    const tautan = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(tautan.some((href) => href?.startsWith("/pumk") || href?.startsWith("/admin"))).toBe(
      false,
    );
    expect(textOf(view.container)).not.toContain("Masuk ke aplikasi");
    view.unmount();
  });

  test("the three public destinations are reachable and each renders its own page", async () => {
    const { mount, textOf, clickOn } = await import("./testing");
    at("/cek-status");
    stubFetch(() => json(404, { error: "x", code: "TIDAK_DITEMUKAN" }));
    const view = await mount(<App />);
    expect(textOf(view.container)).toContain("Cek Status Pengajuan");

    const bantuan = [...view.container.querySelectorAll(".publik-nav-btn")].find((b) =>
      b.textContent?.includes("Bantuan"),
    );
    await clickOn(bantuan as Element);
    expect(textOf(view.container)).toContain("Pertanyaan yang sering diajukan");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The application form
// ---------------------------------------------------------------------------

describe("the application form", () => {
  test("the screen's allowlist is the server's allowlist, key for key and limit for limit", () => {
    // The engine's refusal arrives as ONE sentence with no fields on it, so
    // the screen validates locally; this is what stops the local copy drifting
    // into a form that refuses what the server would take, or vice versa.
    for (const [aturanServer, formLayar] of [
      [FIELD_PUMK, FORM_PUMK],
      [FIELD_NON_PUMK, FORM_NON_PUMK],
    ] as const) {
      expect(formLayar.map((f) => f.kunci).sort()).toEqual(Object.keys(aturanServer).sort());
      for (const field of formLayar) {
        expect(field.aturan).toEqual(aturanServer[field.kunci]!);
      }
    }
  });

  test("a submission carries no cookie, so a staff session on a shared machine cannot ride along", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/pengajuan") ? json(201, HASIL_AJUKAN) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });

    const kirim = calls.find((call) => call.url.includes("/portal/pengajuan"));
    expect(kirim).toBeTruthy();
    expect(kirim?.credentials).toBe("omit");
    view.unmount();
  });

  test("exactly one verifier is sent, never both", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/pengajuan") ? json(201, HASIL_AJUKAN) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });

    const body = JSON.parse(
      calls.find((call) => call.url.includes("/portal/pengajuan"))?.body ?? "{}",
    ) as { nik: string | null; tanggalLahir: string | null };
    expect(body.nik).toBe("3201010101010001");
    expect(body.tanggalLahir).toBeNull();
    view.unmount();
  });

  test("money leaves as a two decimal string, never as a JavaScript number", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/pengajuan") ? json(201, HASIL_AJUKAN) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });

    const body = JSON.parse(
      calls.find((call) => call.url.includes("/portal/pengajuan"))?.body ?? "{}",
    ) as { formulir: Record<string, unknown> };
    expect(body.formulir.jumlah_diajukan).toBe("5000000.00");
    // And an integer field leaves as a number, which is what the engine takes.
    expect(body.formulir.tenor_diajukan).toBe(24);
    view.unmount();
  });

  test("the ticket is shown once, in full, with a warning that it is not resent", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea, textOf } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/pengajuan") ? json(201, HASIL_AJUKAN) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });

    const tiket = view.container.querySelector(".publik-tiket");
    expect(textOf(tiket)).toBe("TKT-202609-A1B2C3D4E5");
    expect(textOf(view.container)).toContain("tidak dikirim ulang");
    view.unmount();
  });

  test("a refused submission keeps the form and shows the server's own sentence", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea, textOf } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/pengajuan")
        ? json(404, {
            error: "Entitas tujuan pengajuan tidak dikenal.",
            code: "TIDAK_DITEMUKAN",
            kodeDomain: "ENTITAS_TIDAK_DITEMUKAN",
          })
        : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });

    expect(textOf(view.container)).toContain("Entitas tujuan pengajuan tidak dikenal");
    // And the receipt is NOT shown: a refusal must never look like a success.
    expect(view.container.querySelector(".publik-tiket")).toBeNull();
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The status check. THE PROPERTY THIS FILE EXISTS FOR.
// ---------------------------------------------------------------------------

describe("the status check answers one way for every failure", () => {
  test("an unknown ticket and a wrong verifier produce the SAME words on screen", async () => {
    const { mount, clickOn, typeInto, textOf } = await import("./testing");

    async function pesanUntuk(nik: string): Promise<string> {
      at("/cek-status");
      stubFetch((call) =>
        call.url.includes("/portal/status") ? json(401, REFUSAL) : json(404, { error: "x" }),
      );
      const view = await mount(<App />);
      await isiCekStatus(view, "TKT-202609-A1B2C3D4E5", nik, { typeInto });
      await tekanLihatStatus(view, clickOn);
      const teks = textOf(view.container.querySelector(".publik-gagal"));
      view.unmount();
      return teks;
    }

    const satu = await pesanUntuk("3201010101010001");
    const dua = await pesanUntuk("9999999999999999");
    expect(satu).toBe(dua);
    expect(satu).toContain("Nomor tiket atau data pemeriksa tidak cocok");
  });

  test("the refusal never says which half was wrong and is never attached to a field", async () => {
    const { mount, clickOn, typeInto, textOf } = await import("./testing");
    at("/cek-status");
    stubFetch((call) =>
      call.url.includes("/portal/status") ? json(401, REFUSAL) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiCekStatus(view, "TKT-202609-A1B2C3D4E5", "3201010101010001", { typeInto });
    await tekanLihatStatus(view, clickOn);

    const teks = textOf(view.container);
    for (const bocor of [
      "tidak ditemukan",
      "tidak terdaftar",
      "NIK salah",
      "tanggal lahir salah",
      "belum pernah",
    ]) {
      expect(teks).not.toContain(bocor);
    }
    // The message is at the top of the form, not inside a field's error slot.
    expect(view.container.querySelector(".field-error")).toBeNull();
    expect(view.container.querySelector(".publik-gagal")).toBeTruthy();
    view.unmount();
  });

  test("the verifier is sent in the BODY, never in the query string", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/cek-status");
    stubFetch((call) =>
      call.url.includes("/portal/status") ? json(200, STATUS_DIPROSES) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiCekStatus(view, "TKT-202609-A1B2C3D4E5", "3201010101010001", { typeInto });
    await tekanLihatStatus(view, clickOn);

    const panggil = calls.find((call) => call.url.includes("/portal/status"));
    expect(panggil?.method).toBe("POST");
    // A credential in a query string lands in the access log, the history and
    // the Referer of every asset on the result page.
    expect(panggil?.url).not.toContain("3201010101010001");
    expect(panggil?.body).toContain("3201010101010001");
    view.unmount();
  });

  test("a successful check shows the status and nothing internal", async () => {
    const { mount, clickOn, typeInto, textOf } = await import("./testing");
    at("/cek-status");
    stubFetch((call) =>
      call.url.includes("/portal/status") ? json(200, STATUS_DIPROSES) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await isiCekStatus(view, "TKT-202609-A1B2C3D4E5", "3201010101010001", { typeInto });
    await tekanLihatStatus(view, clickOn);

    const teks = textOf(view.container);
    expect(teks).toContain("Sedang diverifikasi");
    expect(teks).toContain("05-09-2026");
    expect(teks).toContain("Rincian penilaian dan catatan petugas tidak dibuka");
    view.unmount();
  });

  test("a malformed ticket is refused before any request is sent", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/cek-status");
    stubFetch(() => json(200, STATUS_DIPROSES));
    const view = await mount(<App />);

    await isiCekStatus(view, "bukan-tiket", "3201010101010001", { typeInto });
    await tekanLihatStatus(view, clickOn);

    // Shape only, and it costs the server nothing: a request that could never
    // match anything is not worth a round trip or a rate limit slot.
    expect(calls.some((call) => call.url.includes("/portal/status"))).toBe(false);
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Choosing the entity, and what happens when that read fails
// ---------------------------------------------------------------------------
//
// `GET /portal/entitas` replaced a text box a member of the public had to type
// a `kodeEntitas` into off a leaflet. The property this block protects is that
// it replaced it WITHOUT making the form depend on it: a public form that
// cannot be filled in when one request fails is worse than one that asks for a
// code.

const ENTITAS = {
  data: [
    { kode: "KS", nama: "PT Krakatau Steel (Persero) Tbk" },
    { kode: "KDL", nama: "PT Krakatau Daya Listrik" },
  ],
};

function pilihanSelect(view: { container: HTMLElement }, label: string): string[] {
  const field = [...view.container.querySelectorAll(".field")].find((f) =>
    f.querySelector(".field-label")?.textContent?.startsWith(label),
  );
  const select = field?.querySelector("select");
  if (!select) throw new Error(`pilihan "${label}" tidak ada di layar`);
  return [...select.querySelectorAll("option")].map((o) => o.textContent ?? "");
}

describe("the entity is chosen from a list, and the list is not a dependency", () => {
  test("the live entities are offered by name, and no code has to be typed", async () => {
    const { mount } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/entitas") ? json(200, ENTITAS) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    expect(pilihanSelect(view, "Entitas tujuan")).toEqual([
      "Pilih entitas tujuan",
      "KS PT Krakatau Steel (Persero) Tbk",
      "KDL PT Krakatau Daya Listrik",
    ]);
    // The old text box is gone while the list is there, so there is nothing to
    // mistype.
    expect(() => isianBernama(view, "Kode entitas tujuan")).toThrow();
    view.unmount();
  });

  test("the read is anonymous by transport, like the two POSTs on this surface", async () => {
    const { mount } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/entitas") ? json(200, ENTITAS) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    const baca = calls.find((call) => call.url.includes("/portal/entitas"));
    expect(baca?.method).toBe("GET");
    expect(baca?.credentials).toBe("omit");
    view.unmount();
  });

  test("NOTHING is preselected, so an application is never quietly addressed", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) =>
      call.url.includes("/portal/entitas") ? json(200, ENTITAS) : json(404, { error: "x" }),
    );
    const view = await mount(<App />);

    await clickOn(tombolBerisi(view, "Lanjut"));
    expect(textOf(view.container)).toContain("Pilih entitas tujuan.");
    // Still on step one: the step did not advance on an unmade choice.
    expect(textOf(view.container)).toContain("Langkah 1 dari 3");
    view.unmount();
  });

  test("the chosen code is what is submitted, unchanged", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea, selectOption } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) => {
      if (call.url.includes("/portal/entitas")) return json(200, ENTITAS);
      if (call.url.includes("/portal/pengajuan")) return json(201, HASIL_AJUKAN);
      return json(404, { error: "x" });
    });
    const view = await mount(<App />);

    const select = view.container.querySelector("select") as HTMLSelectElement;
    await selectOption(select, "KDL");
    await clickOn(tombolBerisi(view, "Lanjut"));
    await isiLangkahDuaDanTiga(view, { clickOn, typeInto, typeIntoTextarea });

    const kirim = calls.find((call) => call.url.includes("/portal/pengajuan"));
    expect(JSON.parse(kirim?.body ?? "{}").kodeEntitas).toBe("KDL");
    view.unmount();
  });

  test("when the read FAILS the old text box comes back and the form still submits", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea, textOf } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) => {
      if (call.url.includes("/portal/entitas")) return json(503, { error: "sedang gangguan" });
      if (call.url.includes("/portal/pengajuan")) return json(201, HASIL_AJUKAN);
      return json(404, { error: "x" });
    });
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Formulir ini tetap bisa dikirim");
    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });

    const kirim = calls.find((call) => call.url.includes("/portal/pengajuan"));
    expect(kirim).toBeTruthy();
    expect(JSON.parse(kirim?.body ?? "{}").kodeEntitas).toBe("KS");
    view.unmount();
  });

  test("an empty list falls back the same way, rather than offering an empty picker", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea } = await import("./testing");
    at("/pengajuan");
    stubFetch((call) => {
      if (call.url.includes("/portal/entitas")) return json(200, { data: [] });
      if (call.url.includes("/portal/pengajuan")) return json(201, HASIL_AJUKAN);
      return json(404, { error: "x" });
    });
    const view = await mount(<App />);

    await isiSampaiKirim(view, { clickOn, typeInto, typeIntoTextarea });
    expect(calls.some((call) => call.url.includes("/portal/pengajuan"))).toBe(true);
    view.unmount();
  });

  test("the fallback offers a retry, and a later success turns the box into a list", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/pengajuan");
    let gagalDulu = true;
    stubFetch((call) => {
      if (call.url.includes("/portal/entitas")) {
        if (gagalDulu) {
          gagalDulu = false;
          return json(503, { error: "sedang gangguan" });
        }
        return json(200, ENTITAS);
      }
      return json(404, { error: "x" });
    });
    const view = await mount(<App />);

    expect(isianBernama(view, "Kode entitas tujuan")).toBeTruthy();
    await clickOn(tombolBerisi(view, "Coba muat daftar entitas lagi"));
    await view.flush();

    expect(pilihanSelect(view, "Entitas tujuan")).toContain("KS PT Krakatau Steel (Persero) Tbk");
    view.unmount();
  });
});

describe("the public copy obeys the house rules", () => {
  test("no long dash anywhere on the three public pages", async () => {
    const { mount, textOf } = await import("./testing");
    for (const path of ["/pengajuan", "/cek-status", "/bantuan"]) {
      at(path);
      stubFetch(() => json(404, { error: "x" }));
      const view = await mount(<App />);
      expect(textOf(view.container)).not.toContain(LONG_DASH);
      view.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Alat {
  clickOn: (el: Element) => Promise<void>;
  typeInto: (el: HTMLInputElement, value: string) => Promise<void>;
  typeIntoTextarea: (el: HTMLTextAreaElement, value: string) => Promise<void>;
}

function tombolBerisi(view: { container: HTMLElement }, teks: string): Element {
  const tombol = [...view.container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(teks),
  );
  if (!tombol) throw new Error(`tombol "${teks}" tidak ada di layar`);
  return tombol;
}

/** Finds a control by its LABEL, never by index: a reordered form would
 *  otherwise quietly turn into a test of a different field. */
function isianBernama(view: { container: HTMLElement }, label: string): HTMLInputElement {
  const input = kontrolBernama(view, label);
  if (input.tagName !== "INPUT") {
    throw new Error(`isian "${label}" adalah ${input.tagName}, pakai isiPanjang`);
  }
  return input as HTMLInputElement;
}

function kontrolBernama(view: { container: HTMLElement }, label: string): Element {
  const field = [...view.container.querySelectorAll(".field")].find((f) =>
    f.querySelector(".field-label")?.textContent?.startsWith(label),
  );
  const kontrol = field?.querySelector("input, textarea");
  if (!kontrol) throw new Error(`isian "${label}" tidak ada di layar`);
  return kontrol;
}

/** A textarea. Its own path because the native value setter lives on a
 *  different prototype, and calling the input one on a textarea throws inside
 *  happy-dom rather than failing an assertion. */
function isiPanjang(
  view: { container: HTMLElement },
  label: string,
  nilai: string,
  alat: Alat,
): Promise<void> {
  return alat.typeIntoTextarea(kontrolBernama(view, label) as HTMLTextAreaElement, nilai);
}

async function isiCekStatus(
  view: { container: HTMLElement },
  tiket: string,
  nik: string,
  alat: { typeInto: Alat["typeInto"] },
) {
  await alat.typeInto(isianBernama(view, "Nomor tiket"), tiket);
  await alat.typeInto(isianBernama(view, "NIK"), nik);
}

function tekanLihatStatus(view: { container: HTMLElement }, clickOn: Alat["clickOn"]) {
  return clickOn(tombolBerisi(view, "Lihat status"));
}

/**
 * Walks the three steps with valid answers and presses submit, driving step one
 * through the FALLBACK text box. Every caller of this helper stubs
 * `/portal/entitas` as a failure or leaves it unstubbed, which is what the
 * fallback is for; a caller that wants the picker drives step one itself and
 * calls `isiLangkahDuaDanTiga`.
 */
async function isiSampaiKirim(view: { container: HTMLElement }, alat: Alat) {
  const { clickOn, typeInto } = alat;

  // Step 1: entity and kind. PUMK is the default, so it is not touched.
  await typeInto(isianBernama(view, "Kode entitas tujuan"), "KS");
  await clickOn(tombolBerisi(view, "Lanjut"));

  await isiLangkahDuaDanTiga(view, alat);
}

/** Steps two and three, once step one has been answered somehow. */
async function isiLangkahDuaDanTiga(view: { container: HTMLElement }, alat: Alat) {
  const { clickOn, typeInto } = alat;

  // Step 2: the PUMK allowlist.
  await typeInto(isianBernama(view, "Nama lengkap"), "Budi Santoso");
  await typeInto(isianBernama(view, "Nama usaha"), "Warung Budi");
  await typeInto(isianBernama(view, "Sektor usaha"), "Perdagangan");
  await isiPanjang(view, "Alamat usaha", "Jalan Merdeka 1, Cilegon", alat);
  await typeInto(isianBernama(view, "Jumlah pendanaan"), "5000000");
  await typeInto(isianBernama(view, "Lama angsuran"), "24");
  await isiPanjang(view, "Tujuan penggunaan", "Menambah stok dagangan", alat);
  await clickOn(tombolBerisi(view, "Lanjut"));

  // Step 3: contact and verifier, then submit.
  await typeInto(isianBernama(view, "Email"), "budi@contoh.id");
  await typeInto(isianBernama(view, "NIK"), "3201010101010001");
  await clickOn(tombolBerisi(view, "Kirim pengajuan"));
}
