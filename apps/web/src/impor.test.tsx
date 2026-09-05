// The three bulk import screens of spec 9.6, tested through the real App.
//
// FIVE THINGS THIS FILE EXISTS TO HOLD, and every one of them is a rule spec
// 9.6 states in words:
//
//   a commit cannot happen without a preview. The control does not exist before
//   one, and it is closed again the moment the file changes;
//   a rejection is shown WITH ITS LINE NUMBER, and the number is the
//   spreadsheet's own, header row included, never renumbered;
//   one rejected row closes the whole commit, because the server refuses the
//   whole file and an operator should not spend a round trip to learn that;
//   a refused commit wrote NOTHING, and the report that comes back with the 400
//   is rendered as the report rather than flattened into a sentence;
//   the opening balance import refusing to run twice is a STATEMENT, not a
//   fault: it means this scope already has its opening balances.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";

const LONG_DASH = String.fromCharCode(0x2014);

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

function teks(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function semuaTombol(container: HTMLElement): string {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .join(" | ")
    .toLowerCase();
}

function tombol(container: HTMLElement, label: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").toLowerCase().includes(label.toLowerCase()),
  );
  if (!hit) throw new Error(`tombol "${label}" tidak ditemukan`);
  return hit as HTMLButtonElement;
}

/**
 * Picks a file the way the operator does, through the real input, so the page's
 * own `onChange` runs and the preview invalidation with it.
 *
 * happy-dom's file input does not accept an assignment to `files`, so the list
 * is defined on the element and the change event fired by hand. Everything
 * after that is the component's own code path.
 */
async function pilihBerkas(container: HTMLElement, nama: string, isi: string) {
  const { act } = await import("react");
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([isi], nama, { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const CABANG_A = { id: "c1", kode: "01", nama: "Cabang Cilegon" };

const SESSION = {
  user: { id: "u1", username: "maker", nama: "Budi Santoso", role: "MAKER" },
  cabang: CABANG_A,
  cabangTersedia: [CABANG_A],
  periode: { tahun: 2026, bulan: 3, status: "OPEN" },
  roles: ["MAKER"],
  readOnly: false,
  lintasCabang: false,
  permissions: ["dashboard.view", "tools.import", "pumk.view", "pumk.create"],
};

// ---------------------------------------------------------------------------
// Fixtures, in the shapes modules/impor already names
// ---------------------------------------------------------------------------

const PRATINJAU_BERSIH = {
  jenis: "MITRA",
  namaFile: "mitra.csv",
  checksum: "abc123",
  ukuranBytes: 2048,
  jumlahBaris: 2,
  diterima: [
    { nomorBaris: 2, ringkasan: { kode_mitra: "MB-0001", nama_lengkap: "Sri Rahayu" } },
    { nomorBaris: 3, ringkasan: { kode_mitra: "MB-0002", nama_lengkap: "Andi Pratama" } },
  ],
  ditolak: [],
  siapKomit: true,
};

const PRATINJAU_DITOLAK = {
  ...PRATINJAU_BERSIH,
  diterima: [PRATINJAU_BERSIH.diterima[0]],
  ditolak: [
    { nomorBaris: 3, alasan: { kode_mitra: ["sudah dipakai mitra lain"] } },
    { nomorBaris: 7, alasan: { nik: ["wajib 16 digit angka"], telepon: ["maksimal 20 karakter"] } },
  ],
  siapKomit: false,
};

const HASIL_KOMIT = {
  berkasId: "berkas-1",
  jenis: "MITRA",
  namaFile: "mitra.csv",
  checksum: "abc123",
  jumlahBaris: 2,
  jumlahDitulis: 2,
  jurnalIds: [],
};

interface Pilihan {
  session?: unknown;
  pratinjau?: Response;
  komit?: Response;
}

function handler(pilihan: Pilihan = {}) {
  return (call: Call): Response => {
    const { url, method } = call;
    if (url.includes("/auth/session")) return json(200, pilihan.session ?? SESSION);
    if (method === "POST" && url.includes("/pratinjau")) {
      return pilihan.pratinjau ?? json(200, PRATINJAU_BERSIH);
    }
    if (method === "POST" && url.includes("/komit")) {
      return pilihan.komit ?? json(201, HASIL_KOMIT);
    }
    return notFound();
  };
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Preview before commit
// ---------------------------------------------------------------------------

describe("Impor: preview first, and the commit is closed until one is read", () => {
  test("there is no commit control before a preview exists", async () => {
    const { mount } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(semuaTombol(view.container)).not.toContain("commit");
    expect(teks(view.container)).toContain("Pratinjau dulu, baru bisa dicommit");
    view.unmount();
  });

  test("a preview writes nothing and the page says so", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "kode_mitra,nama_lengkap\nMB-0001,Sri\n");
    await clickOn(tombol(view.container, "Pratinjau berkas"));

    expect(calls.some((c) => c.url.includes("/impor/MITRA/pratinjau"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/komit"))).toBe(false);
    expect(teks(view.container)).toContain("Pratinjau tidak menulis apa pun");
    view.unmount();
  });

  test("rejections carry the spreadsheet's own line numbers, header row included", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler({ pratinjau: json(200, PRATINJAU_DITOLAK) }));
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "kode_mitra,nama_lengkap\nMB-0001,Sri\n");
    await clickOn(tombol(view.container, "Pratinjau berkas"));

    const isi = teks(view.container);
    expect(isi).toContain("termasuk baris judul kolom");
    expect(isi).toContain("sudah dipakai mitra lain");
    expect(isi).toContain("wajib 16 digit angka");
    // Both numbers as the server sent them, not renumbered from one.
    const nomor = [...view.container.querySelectorAll("tbody td.is-numeric")].map(
      (td) => td.textContent ?? "",
    );
    expect(nomor).toContain("3");
    expect(nomor).toContain("7");
    view.unmount();
  });

  test("one rejected row closes the whole commit, and says why", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler({ pratinjau: json(200, PRATINJAU_DITOLAK) }));
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "isi");
    await clickOn(tombol(view.container, "Pratinjau berkas"));

    expect(tombol(view.container, "Commit").disabled).toBe(true);
    expect(teks(view.container)).toContain("commit ditutup");
    view.unmount();
  });

  test("changing the file invalidates the preview and closes the commit again", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "isi");
    await clickOn(tombol(view.container, "Pratinjau berkas"));
    expect(tombol(view.container, "Commit").disabled).toBe(false);

    await pilihBerkas(view.container, "mitra-baru.csv", "isi lain");
    expect(semuaTombol(view.container)).not.toContain("commit");
    expect(teks(view.container)).toContain("Pratinjau dulu, baru bisa dicommit");
    view.unmount();
  });

  test("the confirmation asks the operator to state the report was read", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "isi");
    await clickOn(tombol(view.container, "Pratinjau berkas"));
    await clickOn(tombol(view.container, "Commit"));

    const dialog = teks(document.body as unknown as HTMLElement);
    expect(dialog).toContain("SAYA SUDAH BACA PRATINJAU");
    expect(dialog).toContain("tidak ada satu baris pun yang disimpan");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The refusal whose body is the report
// ---------------------------------------------------------------------------

describe("Impor: a refused commit wrote nothing, and the report says which rows", () => {
  test("the 400 report is rendered as the report, not flattened into a sentence", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(
      handler({
        komit: json(400, {
          error: "Ada baris yang ditolak",
          code: "VALIDASI",
          kodeDomain: "ADA_BARIS_DITOLAK",
          laporan: PRATINJAU_DITOLAK,
        }),
      }),
    );
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "isi");
    await clickOn(tombol(view.container, "Pratinjau berkas"));
    await clickOn(tombol(view.container, "Commit"));
    await typeInto(
      document.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "SAYA SUDAH BACA PRATINJAU",
    );
    const konfirm = [...document.querySelectorAll(".modal-foot button")].find((b) =>
      (b.textContent ?? "").includes("Commit berkas"),
    );
    await clickOn(konfirm!);

    const isi = teks(view.container);
    expect(isi).toContain("tidak ada satu baris pun yang disimpan");
    expect(isi).toContain("sudah dipakai mitra lain");
    expect(isi).toContain("wajib 16 digit angka");
    view.unmount();
  });

  test("a clean commit reports what was written, and what it did to the ledger", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/tools/import-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    await pilihBerkas(view.container, "mitra.csv", "isi");
    await clickOn(tombol(view.container, "Pratinjau berkas"));
    await clickOn(tombol(view.container, "Commit"));
    await typeInto(
      document.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "SAYA SUDAH BACA PRATINJAU",
    );
    const konfirm = [...document.querySelectorAll(".modal-foot button")].find((b) =>
      (b.textContent ?? "").includes("Commit berkas"),
    );
    await clickOn(konfirm!);

    const isi = teks(view.container);
    expect(isi).toContain("Berkas mitra.csv tersimpan");
    expect(isi).toContain("tidak membentuk jurnal");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The opening balance import
// ---------------------------------------------------------------------------

describe("Import Saldo Awal: run once, and say so plainly when it has been", () => {
  test("it asks for the cut off date, because that is a statement about the file", async () => {
    const { mount } = await import("./testing");
    at("/tools/import-saldo-awal");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(view.container.querySelector("#saldo-tanggal")).toBeTruthy();
    expect(teks(view.container)).toContain("sehari sebelum periode terbuka pertama dimulai");
    view.unmount();
  });

  test("a second run says this branch already has its opening balances, not a generic error", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/tools/import-saldo-awal");
    stubFetch(
      handler({
        pratinjau: json(409, {
          error: "Lingkup ini sudah punya saldo awal yang diposting",
          code: "KONFLIK",
          kodeDomain: "SALDO_AWAL_SUDAH_DIPOSTING",
        }),
      }),
    );
    const view = await mount(<App />);

    await pilihBerkas(view.container, "saldo.csv", "bagian\nAKUN\n");
    await clickOn(tombol(view.container, "Pratinjau berkas"));

    const isi = teks(view.container);
    expect(isi).toContain("Lingkup ini sudah punya saldo awal");
    expect(isi).toContain("Ini bukan berkas yang rusak dan bukan kegagalan sistem");
    expect(isi).toContain("koreksinya adalah jurnal pembalik");
    // Rendered as a statement, not as the red error row.
    expect(view.container.querySelectorAll(".peringatan").length).toBeGreaterThan(0);
    view.unmount();
  });

  test("the two sections of the file are explained before an upload", async () => {
    const { mount } = await import("./testing");
    at("/tools/import-saldo-awal");
    stubFetch(handler());
    const view = await mount(<App />);

    const isi = teks(view.container);
    expect(isi).toContain("AKUN untuk saldo per akun, dan AKAD untuk outstanding per akad");
    expect(isi).toContain("sub ledger piutang");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// House style
// ---------------------------------------------------------------------------

describe("House style holds on all three import screens", () => {
  for (const path of ["/tools/import-mitra", "/tools/import-angsuran", "/tools/import-saldo-awal"]) {
    test(`${path} carries no long dash and no unreadable figure`, async () => {
      const { mount } = await import("./testing");
      at(path);
      stubFetch(handler());
      const view = await mount(<App />);

      const isi = teks(view.container);
      expect(isi).not.toContain(LONG_DASH);
      expect(isi).not.toContain("tidak sah");
      expect(isi).toContain("Kolom wajib");
      view.unmount();
    });
  }
});
