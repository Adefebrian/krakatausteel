// The four STAFF portal screens of spec 9.5, tested through the real App.
//
// FOUR THINGS THIS FILE EXISTS TO HOLD:
//
//   the staff surface never becomes the public one. These screens read
//   `/api/portal/submission`, which is session bound, and they never touch the
//   two unauthenticated routes the public form uses;
//   a one time password is treated as one: shown once, copyable, explicitly
//   unrecoverable, and gone the moment the officer says it was handed over;
//   an activation state nobody can read is not invented. No endpoint answers
//   whether a mitra's portal account is enabled, so the page says so instead of
//   printing a chip derived from nothing;
//   the applicant's own form is rendered through the SERVER's field rules, so a
//   tenor of 24 months never prints as a rupiah figure and a field the
//   applicant left blank never prints the "tidak sah" marker.
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

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const CABANG_A = { id: "c1", kode: "01", nama: "Cabang Cilegon" };

const DASAR = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: CABANG_A,
  cabangTersedia: [CABANG_A],
  periode: { tahun: 2026, bulan: 3, status: "OPEN" },
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

const SESSION_ADMIN = {
  ...DASAR,
  permissions: [
    "dashboard.view",
    "portal.view",
    "portal.konversi",
    "konfigurasi.user",
    "pumk.view",
    "pumk.create",
  ],
};

/** An intake officer who may read the roster and may not provision accounts. */
const SESSION_PETUGAS = {
  ...DASAR,
  user: { id: "u2", username: "maker", nama: "Budi Santoso", role: "MAKER" },
  roles: ["MAKER"],
  permissions: ["dashboard.view", "portal.view", "portal.konversi", "pumk.view", "pumk.create"],
};

// ---------------------------------------------------------------------------
// Fixtures, in the shapes modules/portal already names
// ---------------------------------------------------------------------------

function ringkasan(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    noTiket: "TKT-260311-ABCDEFGHJK",
    jenis: "PUMK",
    tanggalSubmit: "2026-03-11",
    status: "BARU",
    namaPemohon: "Warung Bu Sri",
    jumlahDiajukan: "15000000.00",
    emailKontak: "busri@contoh.id",
    teleponKontak: null,
    sudahDikonversi: false,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  return {
    ...ringkasan(),
    formulir: {
      nama_lengkap: "Sri Rahayu",
      nama_usaha: "Warung Bu Sri",
      sektor: "Perdagangan",
      alamat: "Jalan Merdeka 12",
      jumlah_diajukan: "15000000.00",
      tenor_diajukan: 24,
      tujuan_penggunaan: "Tambahan modal barang dagangan",
    },
    dokumen: [{ jenis: "KTP", namaFile: "ktp-sri.jpg" }],
    catatanPetugas: null,
    convertedProposalId: null,
    ...over,
  };
}

const MITRA = {
  data: [
    {
      id: "m1",
      kodeMitra: "MB-0001",
      namaLengkap: "Sri Rahayu",
      nik: "3671010101800001",
      telepon: "0811000111",
      alamat: "Jalan Merdeka 12",
      namaUsaha: "Warung Bu Sri",
      sektorId: "sek-1",
      sektorNama: "Perdagangan",
      bidangUsaha: "Warung kelontong",
      kotaNama: "Cilegon",
      status: "AKTIF",
      isMitraLama: false,
      clusterId: null,
      clusterNama: null,
      jumlahPinjamanAktif: 1,
      jumlahPinjamanSelesai: 2,
      outstandingPokok: "8000000.00",
      kolektibilitasTerakhir: "LANCAR",
    },
    {
      id: "m2",
      kodeMitra: "MB-0002",
      namaLengkap: "Andi Pratama",
      nik: null,
      telepon: null,
      alamat: null,
      namaUsaha: null,
      sektorId: null,
      sektorNama: null,
      bidangUsaha: null,
      kotaNama: null,
      status: "AKTIF",
      isMitraLama: false,
      clusterId: null,
      clusterNama: null,
      jumlahPinjamanAktif: 0,
      jumlahPinjamanSelesai: 0,
      // No loan at all, so there is no outstanding. It must NOT print the
      // unreadable marker.
      outstandingPokok: null,
      kolektibilitasTerakhir: null,
    },
  ],
};

interface Pilihan {
  session?: unknown;
  daftar?: unknown[];
  detail?: unknown;
  akun?: Response;
}

function handler(pilihan: Pilihan = {}) {
  return (call: Call): Response => {
    const { url, method } = call;
    if (url.includes("/auth/session")) return json(200, pilihan.session ?? SESSION_ADMIN);
    if (method === "POST" && url.includes("/mitra/akun")) {
      return (
        pilihan.akun ??
        json(201, {
          akunId: "ak-1",
          mitraId: "m1",
          email: "busri@contoh.id",
          sandiSementara: "Kx7-Pq2m-Vb9t",
        })
      );
    }
    if (url.includes("/pumk/mitra")) return json(200, pilihan.daftar ? { data: [] } : MITRA);
    if (url.includes("/konfigurasi/sektor")) return json(200, { data: [] });
    if (method === "POST" && url.includes("/pumk/portal/konversi")) {
      return json(201, { id: "prop-1" });
    }
    if (method === "POST" && url.includes("/tindak")) {
      return json(200, pilihan.detail ?? detail({ status: "DIPROSES" }));
    }
    if (/\/portal\/submission\/[^/?]+$/.test(url)) {
      return json(200, pilihan.detail ?? detail());
    }
    if (url.includes("/portal/submission")) {
      return json(200, { data: pilihan.daftar ?? [ringkasan()] });
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
// The two intake queues
// ---------------------------------------------------------------------------

describe("Pengajuan portal: the staff side of the public form", () => {
  test("the PUMK queue narrows the SAME endpoint by jenis, and never calls a public route", async () => {
    const { mount } = await import("./testing");
    at("/portal/pengajuan-pumk");
    stubFetch(handler());
    const view = await mount(<App />);

    const daftar = calls.find((c) => c.url.includes("/portal/submission"));
    expect(daftar?.url).toContain("jenis=PUMK");
    expect(calls.some((c) => c.url.includes("/portal/pengajuan"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/portal/status"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/portal/entitas"))).toBe(false);
    view.unmount();
  });

  test("the Non PUMK queue is the same screen on the other jenis", async () => {
    const { mount } = await import("./testing");
    at("/portal/pengajuan-non-pumk");
    stubFetch(handler({ daftar: [ringkasan({ jenis: "NON_PUMK" })] }));
    const view = await mount(<App />);

    expect(calls.find((c) => c.url.includes("/portal/submission"))?.url).toContain(
      "jenis=NON_PUMK",
    );
    view.unmount();
  });

  test("the read only queue offers no decision control", async () => {
    const { mount } = await import("./testing");
    at("/portal/pengajuan-pumk?submission=s1");
    stubFetch(handler());
    const view = await mount(<App />);

    const tombolTeks = semuaTombol(view.container);
    expect(tombolTeks).not.toContain("tolak");
    expect(tombolTeks).not.toContain("konversi");
    expect(teks(view.container)).toContain("Buka di Verifikasi dan Konversi");
    view.unmount();
  });

  test("the applicant's tenor prints as a count and the amount as money", async () => {
    const { mount } = await import("./testing");
    at("/portal/pengajuan-pumk?submission=s1");
    stubFetch(handler());
    const view = await mount(<App />);

    const isi = teks(view.container);
    // The label and the value, and the value is a COUNT: a tenor rendered as
    // money would read "24,00" and a Maker copying it would file two years as
    // twenty four rupiah.
    expect(isi).toContain("Tenor diajukan, bulan");
    expect(isi).toContain("bulan24");
    expect(isi).not.toContain("bulan24,00");
    expect(isi).toContain("15.000.000,00");
    expect(isi).not.toContain("tidak sah");
    view.unmount();
  });

  test("a field the applicant left blank says so, never the unreadable marker", async () => {
    const { mount } = await import("./testing");
    at("/portal/pengajuan-pumk?submission=s1");
    stubFetch(
      handler({
        detail: detail({
          jumlahDiajukan: null,
          formulir: { nama_lengkap: "Sri Rahayu", tenor_diajukan: 24 },
        }),
      }),
    );
    const view = await mount(<App />);

    const isi = teks(view.container);
    expect(isi).toContain("tidak diisi pemohon");
    expect(isi).not.toContain("tidak sah");
    view.unmount();
  });

  test("declared documents say there is nothing to download, because nothing was uploaded", async () => {
    const { mount } = await import("./testing");
    at("/portal/pengajuan-pumk?submission=s1");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(teks(view.container)).toContain("tidak menerima unggahan berkasnya");
    expect(view.container.querySelectorAll('a[download]').length).toBe(0);
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Verify and convert
// ---------------------------------------------------------------------------

describe("Verifikasi dan Konversi: two acts, kept apart", () => {
  test("refusing requires a reason, and the reason is described as visible to the applicant", async () => {
    const { mount, selectOption } = await import("./testing");
    at("/portal/verifikasi?submission=s1");
    stubFetch(handler());
    const view = await mount(<App />);

    await selectOption(
      view.container.querySelector("#portal-tindakan") as HTMLSelectElement,
      "DITOLAK",
    );
    expect(tombol(view.container, "Tolak submission").disabled).toBe(true);
    expect(teks(view.container)).toContain("dibaca pemohon di portal publik");
    view.unmount();
  });

  test("conversion refuses to invent a mitra, and says where one comes from", async () => {
    const { mount } = await import("./testing");
    at("/portal/verifikasi?submission=s1");
    stubFetch(handler());
    const view = await mount(<App />);

    const isi = teks(view.container);
    expect(isi).toContain("Bila pemohon belum terdaftar, daftarkan dulu sebagai Mitra Binaan");
    expect(tombol(view.container, "Konversi menjadi proposal").disabled).toBe(true);
    view.unmount();
  });

  test("converting posts to the pumk module, not to the portal module", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/portal/verifikasi?submission=s1");
    stubFetch(handler());
    const view = await mount(<App />);

    // `button.pilihan-btn` and not `.pilihan-btn`: the declared documents above
    // use the same card shape as a STATIC list item, and clicking one of those
    // selects no mitra at all.
    await clickOn(view.container.querySelectorAll("button.pilihan-btn")[0] as HTMLElement);
    await clickOn(tombol(view.container, "Konversi menjadi proposal"));
    const konfirm = [...document.querySelectorAll(".modal-foot button")].find((b) =>
      (b.textContent ?? "").includes("Konversi"),
    );
    await clickOn(konfirm!);
    void typeInto;

    const kirim = calls.find((c) => c.method === "POST" && c.url.includes("/pumk/portal/konversi"));
    expect(kirim).toBeDefined();
    const badan = JSON.parse(kirim?.body ?? "{}");
    expect(badan.submissionId).toBe("s1");
    expect(badan.mitraId).toBe("m1");
    // DIKONVERSI is never sent as a `tindakan`: the portal engine refuses it.
    const tindak = calls.filter((c) => c.url.includes("/tindak"));
    for (const call of tindak) {
      expect(JSON.parse(call.body ?? "{}").tindakan).not.toBe("DIKONVERSI");
    }
    view.unmount();
  });

  test("an already converted submission shows its proposal instead of the form", async () => {
    const { mount } = await import("./testing");
    at("/portal/verifikasi?submission=s1");
    stubFetch(
      handler({ detail: detail({ status: "DIKONVERSI", convertedProposalId: "prop-1" }) }),
    );
    const view = await mount(<App />);

    const isi = teks(view.container);
    expect(isi).toContain("sudah menjadi proposal internal");
    expect(isi).toContain("PORTAL_ONLINE");
    expect(semuaTombol(view.container)).not.toContain("konversi menjadi proposal");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The one time password
// ---------------------------------------------------------------------------

describe("Akun Mitra: a password shown once is treated as shown once", () => {
  test("the page states the three rules before any account is issued", async () => {
    const { mount } = await import("./testing");
    at("/portal/akun-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    const isi = teks(view.container);
    expect(isi).toContain("hanya ditampilkan satu kali");
    expect(isi).toContain("tidak ada endpoint yang bisa menampilkannya lagi");
    expect(isi).toContain("wajib mengganti sandinya sendiri");
    view.unmount();
  });

  test("a role without konfigurasi.user reads the roster and gets no issuing control", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/portal/akun-mitra");
    stubFetch(handler({ session: SESSION_PETUGAS }));
    const view = await mount(<App />);

    expect(teks(view.container)).toContain("tidak memegang kewenangan konfigurasi.user");
    await clickOn(view.container.querySelectorAll(".kartu-btn, tbody tr")[0] as HTMLElement);
    expect(semuaTombol(view.container)).not.toContain("terbitkan akun portal");
    view.unmount();
  });

  test("the password is shown once, said to be unrecoverable, and cannot be brought back", async () => {
    const { mount, clickOn, typeInto } = await import("./testing");
    at("/portal/akun-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    await clickOn(view.container.querySelectorAll("tbody tr")[0] as HTMLElement);
    await typeInto(
      view.container.querySelector("#akun-email") as HTMLInputElement,
      "busri@contoh.id",
    );
    await clickOn(tombol(view.container, "Terbitkan akun portal"));
    const konfirm = [...document.querySelectorAll(".modal-foot button")].find((b) =>
      (b.textContent ?? "").includes("Terbitkan akun"),
    );
    await clickOn(konfirm!);

    expect(teks(view.container)).toContain("Kx7-Pq2m-Vb9t");
    expect(teks(view.container)).toContain("ditampilkan satu kali");
    // ISSUING AGAIN IS CLOSED WHILE THE VALUE IS ON SCREEN. A second issue
    // produces a NEW password and invalidates the one the officer is holding.
    expect(tombol(view.container, "Terbitkan akun portal").disabled).toBe(true);
    expect(teks(view.container)).toContain("Kontrol akun dikunci selama sandi sementara masih tampil");

    // Handed over. The value must be gone, and must not come back.
    await clickOn(tombol(view.container, "Tutup, sandi sudah diserahkan"));
    expect(teks(view.container)).not.toContain("Kx7-Pq2m-Vb9t");
    expect(teks(view.container)).toContain("tidak bisa dibaca kembali");

    // And nothing re-fetches it: there is no GET that could.
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("/mitra/akun")).length).toBe(0);
    view.unmount();
  });

  test("no activation status is invented, and the page says why", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/portal/akun-mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    await clickOn(view.container.querySelectorAll("tbody tr")[0] as HTMLElement);
    const isi = teks(view.container);
    expect(isi).toContain("tidak dapat dibaca dari server");
    expect(isi).toContain("Belum ada endpoint yang membaca status akun portal");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Mitra Binaan
// ---------------------------------------------------------------------------

describe("Mitra Binaan", () => {
  test("a mitra with no loan prints words, never the money marker", async () => {
    const { mount } = await import("./testing");
    at("/pumk/mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    const isi = teks(view.container);
    expect(isi).toContain("tidak ada pinjaman");
    expect(isi).not.toContain("tidak sah");
    // The count column is a count, not money.
    expect(isi).toContain("Pinjaman aktif");
    view.unmount();
  });

  test("there is no create or delete control, and the page says where a mitra comes from", async () => {
    const { mount } = await import("./testing");
    at("/pumk/mitra");
    stubFetch(handler());
    const view = await mount(<App />);

    const tombolTeks = semuaTombol(view.container);
    expect(tombolTeks).not.toContain("tambah mitra");
    expect(tombolTeks).not.toContain("hapus");
    expect(teks(view.container)).toContain("lewat alur proposal PUMK atau lewat Import Mitra");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// House style
// ---------------------------------------------------------------------------

describe("House style holds on every staff portal screen", () => {
  for (const path of [
    "/portal/pengajuan-pumk",
    "/portal/pengajuan-non-pumk",
    "/portal/verifikasi",
    "/portal/akun-mitra",
    "/pumk/mitra",
  ]) {
    test(`${path} carries no long dash and no unreadable figure`, async () => {
      const { mount } = await import("./testing");
      at(path);
      stubFetch(handler());
      const view = await mount(<App />);

      const isi = teks(view.container);
      expect(isi).not.toContain(LONG_DASH);
      expect(isi).not.toContain("tidak sah");
      expect(isi.length).toBeGreaterThan(200);
      view.unmount();
    });
  }
});
