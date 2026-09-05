// The eight configuration screens of spec 9.4, and the invariants that make
// them different from CRUD.
//
// What is asserted here is not "the list renders". It is the four properties
// the API's shape forces on the UI, each of which is easy to lose in a later
// refactor and expensive to lose in production:
//
//   1. THERE IS NO DELETE ANYWHERE ON THIS SURFACE. Every row is referenced by
//      posted history, and the only removal is a deactivation that says what it
//      does and does not do.
//   2. AN IMMUTABLE FIELD IS DRAWN AS A FIXED FACT WITH ITS REASON, never as an
//      input the server will refuse.
//   3. A REFUSAL IS THE SERVER'S OWN SENTENCE, ON THE CONTROL THAT CAUSED IT,
//      and a refusal the screen can already predict disables the control with
//      that reason instead of offering a certain 409.
//   4. THE ONE TIME PASSWORD IS SHOWN ONCE, and while it is on screen nothing
//      that could destroy or replace it is reachable.
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { MASTER } from "@krakatausteel/api/src/modules/konfigurasi/master";
import { App } from "./App";
import { FIELD_MASTER } from "./api/konfigurasi";
import { PERMISSIONS, PERMISSIONS_BY_ROLE } from "./permissions";
import { findRoute } from "./nav";
import { clickOn, mount, textOf, typeInto } from "./testing";

// The banned long dash, written as an escape so this file itself stays clean.
const LONG_DASH = "\u2014";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

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
  user: { id: "u-admin", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: { id: "c0", kode: "00", nama: "Kantor Pusat" },
  cabangTersedia: [{ id: "c0", kode: "00", nama: "Kantor Pusat" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: [
    "dashboard.view",
    "konfigurasi.coa",
    "konfigurasi.master",
    "konfigurasi.user",
    "konfigurasi.parameter",
    "konfigurasi.mapping",
  ],
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

// ---------------------------------------------------------------- fixtures

function akun(over: Record<string, unknown> = {}) {
  return {
    id: "a-kas",
    kode: "1.1.01",
    nama: "Kas di Bank",
    parentId: null,
    parentKode: null,
    level: 1,
    tipe: "ASET",
    saldoNormal: "D",
    isPostable: true,
    isKas: true,
    isKontra: false,
    klasifikasiArusKas: "OPERASI",
    klasifikasiAkun: "KAS",
    aktif: true,
    version: 2,
    punyaAnak: false,
    dipakaiMapping: false,
    dipakaiJurnal: false,
    ...over,
  };
}

const COA = {
  data: [
    akun(),
    akun({
      id: "a-piutang",
      kode: "1.2.01",
      nama: "Piutang Pinjaman PUMK",
      klasifikasiAkun: "PIUTANG",
      isKas: false,
      dipakaiMapping: true,
      dipakaiJurnal: true,
    }),
    akun({
      id: "a-header",
      kode: "1",
      nama: "Aset",
      isPostable: false,
      isKas: false,
      punyaAnak: true,
      klasifikasiAkun: "ASET",
    }),
  ],
};

const KLASIFIKASI = {
  data: [
    { id: "k1", kode: "KAS", nama: "Kas dan Setara Kas", keterangan: null },
    { id: "k2", kode: "PIUTANG", nama: "Piutang Pinjaman", keterangan: null },
    { id: "k3", kode: "ASET", nama: "Aset", keterangan: null },
  ],
};

const CABANG = {
  data: [
    {
      id: "c0",
      bumn_id: "b1",
      kode: "00",
      nama: "Kantor Pusat",
      alamat: "Cilegon",
      is_pusat: true,
      aktif: true,
    },
    {
      id: "c1",
      bumn_id: "b1",
      kode: "01",
      nama: "Cabang Serang",
      alamat: null,
      is_pusat: false,
      aktif: true,
    },
  ],
};

const KARYAWAN = {
  data: [
    {
      id: "k-1",
      cabang_id: "c0",
      bumn_id: "b1",
      nip: "1990001",
      nama: "Bagus Prakoso",
      jabatan: "Surveyor",
      unit: "TJSL",
      aktif: true,
    },
  ],
};

const PERAN = {
  data: [
    {
      kode: "MAKER",
      nama: "Maker",
      lintasCabang: false,
      readOnly: false,
      dapatDiberikan: true,
      alasan: null,
    },
    {
      kode: "CHECKER",
      nama: "Checker",
      lintasCabang: false,
      readOnly: false,
      dapatDiberikan: true,
      alasan: null,
    },
    {
      kode: "AUDITOR",
      nama: "Auditor",
      lintasCabang: true,
      readOnly: true,
      dapatDiberikan: false,
      alasan:
        "Peran Auditor berlaku lintas cabang, dan hanya pengguna yang sendirinya lintas cabang boleh memberikannya",
    },
  ],
};

function pengguna(over: Record<string, unknown> = {}) {
  return {
    id: "u-maker",
    cabangId: "c1",
    cabangKode: "01",
    cabangNama: "Cabang Serang",
    nip: "1990002",
    nama: "Rina Sulastri",
    email: "rina@contoh.id",
    username: "rina",
    aktif: true,
    harusGantiSandi: false,
    lastLoginAt: "2026-08-20T02:00:00.000Z",
    sandiDiubahAt: "2026-08-01T02:00:00.000Z",
    version: 3,
    peran: [{ kode: "MAKER", scopeCabangId: null }],
    ...over,
  };
}

const PENGGUNA = {
  data: [
    pengguna(),
    pengguna({
      id: "u-admin",
      cabangId: "c0",
      cabangKode: "00",
      cabangNama: "Kantor Pusat",
      nama: "Sri Handayani",
      username: "adminpusat",
      email: "sri@contoh.id",
      peran: [{ kode: "CHECKER", scopeCabangId: null }],
    }),
  ],
};

const MAPPING_BERLAKU = {
  id: "m-1",
  eventCode: "PENCAIRAN_PUMK",
  akunDebitId: "a-piutang",
  akunDebitKode: "1.2.01",
  akunDebitNama: "Piutang Pinjaman PUMK",
  akunKreditId: "a-kas",
  akunKreditKode: "1.1.01",
  akunKreditNama: "Kas di Bank",
  debitDariPayload: false,
  kreditDariPayload: false,
  jenisJurnal: "OTOMATIS",
  keterangan: "Pencairan pinjaman ke mitra",
  aktif: true,
};

const MAPPING = { data: [MAPPING_BERLAKU], tanpaPemetaan: ["PELUNASAN_PUMK"] };

function usulan(over: Record<string, unknown> = {}) {
  return {
    id: "us-1",
    eventCode: "PENCAIRAN_PUMK",
    akunDebitId: "a-kas",
    akunDebitKode: "1.1.01",
    akunKreditId: "a-kas",
    akunKreditKode: "1.1.01",
    debitDariPayload: false,
    kreditDariPayload: false,
    jenisJurnal: "OTOMATIS",
    alasan: "Kaki debit salah sejak seed, seharusnya piutang bukan kas.",
    status: "DIAJUKAN",
    mappingSebelum: MAPPING_BERLAKU,
    diajukanBy: "u-maker",
    diajukanOleh: "Rina Sulastri",
    diajukanAt: "2026-09-01T02:00:00.000Z",
    diputusBy: null,
    diputusOleh: null,
    diputusAt: null,
    catatanKeputusan: null,
    ...over,
  };
}

// --------------------------------------------------------------- the stub

interface Tolakan {
  /** Substring of the URL, matched on a non GET request. */
  cocok: string;
  status: number;
  pesan: string;
}

let tolakan: Tolakan | null = null;
let usulanRows: unknown[] = [usulan()];

function stub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method !== "GET" && tolakan && url.includes(tolakan.cocok)) {
      return json(tolakan.status, { error: tolakan.pesan });
    }

    if (url.includes("/auth/session")) return json(200, SESSION);

    // Order matters: the longer literal path goes first, exactly as it does on
    // the server's own router.
    if (url.includes("/konfigurasi/klasifikasi-akun")) return json(200, KLASIFIKASI);
    if (url.includes("/konfigurasi/coa")) {
      return method === "GET" ? json(200, COA) : json(200, akun());
    }
    if (url.endsWith("/konfigurasi/master")) {
      return json(200, { data: [
        { jenis: "sektor", label: "Sektor Usaha PUMK", scopeBumn: true },
        { jenis: "bidang", label: "Bidang Program Non PUMK", scopeBumn: true },
        { jenis: "provinsi", label: "Provinsi", scopeBumn: false },
        { jenis: "kota", label: "Kota / Kabupaten", scopeBumn: false },
        { jenis: "sdg", label: "Tujuan Pembangunan Berkelanjutan", scopeBumn: false },
      ] });
    }
    if (url.includes("/konfigurasi/master/")) {
      const jenis = url.split("/konfigurasi/master/")[1]!.split(/[/?]/)[0]!;
      const rows =
        jenis === "provinsi"
          ? [{ id: "p-1", kode_bps: "36", nama: "Banten", aktif: true, version: 1 }]
          : jenis === "kota"
            ? [
                {
                  id: "kt-1",
                  kode_bps: "3672",
                  nama: "Cilegon",
                  provinsi_id: "p-1",
                  tipe: "KOTA",
                  aktif: true,
                  version: 1,
                },
              ]
            : [
                {
                  id: "s-1",
                  kode: "PERDAGANGAN",
                  nama: "Perdagangan",
                  keterangan: null,
                  urutan: 1,
                  aktif: true,
                  version: 1,
                },
              ];
      return json(200, { jenis, data: rows });
    }

    if (url.includes("/organisasi/cabang")) return json(200, CABANG);
    if (url.includes("/organisasi/karyawan")) return json(200, KARYAWAN);
    if (url.includes("/organisasi/peran")) return json(200, PERAN);
    if (url.includes("/organisasi/pengguna")) {
      if (url.includes("sandi-sementara")) {
        return json(200, { id: "u-maker", username: "rina", sandiSementara: "Kd7-Rp2-Qz9" });
      }
      if (method === "POST") {
        return json(201, {
          ...pengguna({ id: "u-baru", username: "budi", nama: "Budi Santoso" }),
          sandiSementara: "Xy4-Mn8-Tp1",
        });
      }
      return json(200, PENGGUNA);
    }

    if (url.includes("/jurnal/mapping/usulan")) return json(200, { data: usulanRows });
    if (url.includes("/jurnal/mapping")) return json(200, MAPPING);

    return notFound();
  }) as FetchFn;
}

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

beforeEach(() => {
  at("/");
  tolakan = null;
  usulanRows = [usulan()];
  stub();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every configuration route the nav lists, all of which now have a screen. */
const LAYAR = [
  "/konfigurasi/coa",
  "/konfigurasi/wilayah",
  "/konfigurasi/sektor",
  "/konfigurasi/bidang",
  "/konfigurasi/sdg",
  "/konfigurasi/cabang",
  "/konfigurasi/karyawan",
  "/konfigurasi/pengguna",
  "/konfigurasi/event-jurnal",
  "/konfigurasi/template-laporan",
  "/konfigurasi/nomor-dokumen",
];

function tombol(container: Element, teks: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((node) =>
    textOf(node).toLowerCase().includes(teks.toLowerCase()),
  ) as HTMLButtonElement | undefined;
}

function barisPertama(container: Element): Element {
  return container.querySelector(".kartu-btn, tbody tr") as Element;
}

function konfirmasiDialog(container: Element, teks: string): Element {
  return [...container.querySelectorAll(".modal-foot button")].find((node) =>
    textOf(node).includes(teks),
  )!;
}

// ---------------------------------------------------------------------------

describe("every configuration nav entry now opens a real screen", () => {
  test("none of the eleven falls through to the generic placeholder", async () => {
    for (const path of LAYAR) {
      at(path);
      const view = await mount(<App />);
      const teks = textOf(view.container);
      // The Placeholder's own heading. Its presence would mean the route table
      // has no entry for this path.
      expect(teks).not.toContain("Yang akan tersedia di halaman ini");
      expect(view.container.querySelector(".page-title")).toBeTruthy();
      view.unmount();
    }
  });

  test("no screen in the group offers a delete, on any control", async () => {
    // THE INVARIANT WITH TEETH. There is no DELETE anywhere on this API surface
    // and there must never be one on the screens: every row here is referenced
    // by posted history, so removal would change what an old document meant.
    for (const path of LAYAR) {
      at(path);
      const view = await mount(<App />);
      for (const node of view.container.querySelectorAll("button")) {
        expect(textOf(node).toLowerCase()).not.toContain("hapus");
      }
      view.unmount();
    }
  });

  test("no long dash and no emoji on any of them", async () => {
    for (const path of LAYAR) {
      at(path);
      const view = await mount(<App />);
      const teks = textOf(view.container);
      expect(teks).not.toContain(LONG_DASH);
      expect(/\p{Extended_Pictographic}/u.test(teks)).toBe(false);
      view.unmount();
    }
  });
});

describe("bagan akun", () => {
  test("the five immutable fields are facts with reasons, never inputs", async () => {
    at("/konfigurasi/coa");
    const view = await mount(<App />);
    await clickOn(view.container.querySelectorAll(".coa-buka")[0]!);

    const tetap = textOf(view.container.querySelector(".tetap-list"));
    for (const label of ["Kode akun", "Akun induk", "Level", "Tipe akun", "Saldo normal"]) {
      expect(tetap).toContain(label);
    }
    expect(tetap).toContain("Mengganti kode berarti mengubah arti jurnal yang sudah diposting");

    // None of the five is an editable control anywhere on the page.
    const idKontrol = [...view.container.querySelectorAll("input, select")].map((node) => node.id);
    expect(idKontrol.some((id) => id.startsWith("akun-kode"))).toBe(false);
    expect(idKontrol.some((id) => id.startsWith("akun-tipe"))).toBe(false);
    view.unmount();
  });

  test("a deactivation the API is certain to refuse is disabled, with the reason", async () => {
    at("/konfigurasi/coa");
    const view = await mount(<App />);
    // 1.2.01 is the leg of an active event mapping (`dipakaiMapping`).
    const baris = [...view.container.querySelectorAll(".coa-buka")].find((node) =>
      textOf(node).includes("1.2.01"),
    );
    await clickOn(baris!);

    const kendali = view.container.querySelector(".status-kendali") as HTMLElement;
    const nonaktif = kendali.querySelector("button") as HTMLButtonElement;
    expect(textOf(nonaktif)).toContain("Nonaktifkan");
    expect(nonaktif.disabled).toBe(true);
    expect(textOf(view.container)).toContain(
      "masih menjadi kaki dari pemetaan event jurnal yang aktif",
    );
    view.unmount();
  });

  test("an account carrying journal lines cannot have postable cleared, and says why", async () => {
    at("/konfigurasi/coa");
    const view = await mount(<App />);
    const baris = [...view.container.querySelectorAll(".coa-buka")].find((node) =>
      textOf(node).includes("1.2.01"),
    );
    await clickOn(baris!);

    const kotak = view.container.querySelector("#akun-postable-a-piutang") as HTMLInputElement;
    expect(kotak.disabled).toBe(true);
    expect(textOf(view.container)).toContain("kaki pemetaan event jurnal yang aktif");
    view.unmount();
  });

  test("the deactivation says what it does AND what it does not do", async () => {
    at("/konfigurasi/coa");
    const view = await mount(<App />);
    await clickOn(view.container.querySelectorAll(".coa-buka")[0]!);
    await clickOn(tombol(view.container.querySelector(".status-kendali")!, "Nonaktifkan")!);

    const dialog = textOf(view.container.querySelector(".modal"));
    expect(dialog).toContain("Yang berubah");
    expect(dialog).toContain("Yang tidak berubah");
    expect(dialog).toContain("Baris jurnal yang sudah menunjuk akun ini tidak berubah");
    view.unmount();
  });

  test("the server's own refusal sentence lands on the control that caused it", async () => {
    tolakan = {
      cocok: "/konfigurasi/coa/a-kas/status",
      status: 409,
      pesan:
        "Akun 1.1.01 adalah kaki dari pemetaan event PENERIMAAN_ANGSURAN, yang menentukan jurnal setiap transaksi event itu.",
    };
    at("/konfigurasi/coa");
    const view = await mount(<App />);
    await clickOn(view.container.querySelectorAll(".coa-buka")[0]!);
    await clickOn(tombol(view.container.querySelector(".status-kendali")!, "Nonaktifkan")!);
    await clickOn(konfirmasiDialog(view.container, "Nonaktifkan"));

    const galat = [...view.container.querySelectorAll('[role="alert"]')]
      .map((node) => textOf(node))
      .join(" ");
    expect(galat).toContain("PENERIMAAN_ANGSURAN");
    view.unmount();
  });
});

describe("master referensi", () => {
  test("the field registry the forms are generated from matches the server's own", () => {
    // The registry endpoint answers only { jenis, label, scopeBumn }, so the
    // columns had to be mirrored in the SPA. This is the pin: a field added,
    // renamed or re-shaped on the server fails HERE rather than in a form that
    // posts a name the server has never heard of.
    expect(Object.keys(FIELD_MASTER).sort()).toEqual(MASTER.map((d) => d.jenis).sort());
    for (const def of MASTER) {
      const ui = FIELD_MASTER[def.jenis]!;
      expect(ui.map((f) => f.nama)).toEqual(def.fields.map((f) => f.nama));
      expect(ui.map((f) => f.kolom)).toEqual(def.fields.map((f) => f.kolom));
      expect(ui.map((f) => f.bentuk)).toEqual(def.fields.map((f) => f.bentuk));
      expect(ui.map((f) => f.wajib)).toEqual(def.fields.map((f) => f.wajib));
      expect(ui.map((f) => f.kunci === true)).toEqual(def.fields.map((f) => f.kunci === true));
      expect(ui.map((f) => f.maks)).toEqual(def.fields.map((f) => f.maks));
      expect(ui.map((f) => f.min)).toEqual(def.fields.map((f) => f.min));
      expect(ui.map((f) => f.pilihan)).toEqual(def.fields.map((f) => f.pilihan));
    }
  });

  test("the key column is an input while creating and a fixed fact afterwards", async () => {
    at("/konfigurasi/sektor");
    const view = await mount(<App />);

    // Creating: the key is an ordinary required field.
    await clickOn(tombol(view.container, "Baris baru")!);
    expect(view.container.querySelector("#baru-sektor-kode")).toBeTruthy();
    await clickOn(tombol(view.container, "Tutup formulir")!);

    // Existing: the key is a fact with the reason, and there is no input for it.
    await clickOn(barisPertama(view.container));
    const tetap = textOf(view.container.querySelector(".tetap-list"));
    expect(tetap).toContain("Kode sektor");
    expect(tetap).toContain("Server menolak perubahannya");
    expect(view.container.querySelector("#ubah-sektor-kode")).toBeNull();
    // The name IS editable, because a name is presentation and not identity.
    expect(view.container.querySelector("#ubah-sektor-nama")).toBeTruthy();
    view.unmount();
  });

  test("the screen states whose reference list this is, from the registry endpoint", async () => {
    // `scopeBumn` is the one thing the registry answers that no row does, and it
    // is a real distinction: a sector list belongs to this reporting entity,
    // while the BPS province list and the seventeen UN goals do not.
    at("/konfigurasi/sektor");
    const sektor = await mount(<App />);
    expect(textOf(sektor.container)).toContain("Entitas ini");
    sektor.unmount();

    at("/konfigurasi/sdg");
    const sdg = await mount(<App />);
    expect(textOf(sdg.container)).toContain("Lintas entitas");
    sdg.unmount();
  });

  test("wilayah shows both reference tables, and a kota row names its province", async () => {
    at("/konfigurasi/wilayah");
    const view = await mount(<App />);
    const tab = [...view.container.querySelectorAll('[role="tab"]')].map((node) => textOf(node));
    expect(tab).toEqual(["Provinsi", "Kota dan Kabupaten"]);

    await clickOn([...view.container.querySelectorAll('[role="tab"]')][1]!);
    // The province is printed by name, never as a bare id.
    expect(textOf(view.container)).toContain("Banten");
    expect(textOf(view.container)).not.toContain("p-1");
    view.unmount();
  });
});

describe("cabang", () => {
  test("the branch code is fixed, with the document numbering reason", async () => {
    at("/konfigurasi/cabang");
    const view = await mount(<App />);
    await clickOn(barisPertama(view.container));

    const tetap = textOf(view.container.querySelector(".tetap-list"));
    expect(tetap).toContain("Kode cabang");
    expect(tetap).toContain("tercetak di setiap nomor dokumen");
    view.unmount();
  });

  test("the head office cannot be deactivated, and the reason is on the control", async () => {
    at("/konfigurasi/cabang");
    const view = await mount(<App />);
    // The first row is the kantor pusat: the server sorts is_pusat first.
    await clickOn(barisPertama(view.container));

    const kendali = view.container.querySelector(".status-kendali") as HTMLElement;
    const nonaktif = kendali.querySelector("button") as HTMLButtonElement;
    expect(nonaktif.disabled).toBe(true);
    expect(textOf(view.container)).toContain("Kantor pusat tidak dapat dinonaktifkan");
    view.unmount();
  });
});

describe("pengguna dan role", () => {
  test("a role this caller may not grant is visibly unavailable WITH the server's reason", async () => {
    at("/konfigurasi/pengguna");
    const view = await mount(<App />);
    await clickOn(barisPertama(view.container));

    const auditor = view.container.querySelector("#peran-u-maker-AUDITOR") as HTMLInputElement;
    // Not hidden. Present, disabled, and carrying the sentence the server sent.
    expect(auditor).toBeTruthy();
    expect(auditor.disabled).toBe(true);
    expect(textOf(view.container)).toContain(
      "hanya pengguna yang sendirinya lintas cabang boleh memberikannya",
    );
    const checker = view.container.querySelector("#peran-u-maker-CHECKER") as HTMLInputElement;
    expect(checker.disabled).toBe(false);
    view.unmount();
  });

  test("nobody edits their own authority, and the page says which rule that is", async () => {
    at("/konfigurasi/pengguna");
    const view = await mount(<App />);
    const baris = [...view.container.querySelectorAll(".kartu-btn, tbody tr")].find((node) =>
      textOf(node).includes("adminpusat"),
    );
    await clickOn(baris!);

    const teks = textOf(view.container);
    expect(teks).toContain("Ini akun Anda sendiri");
    expect(teks).toContain("Anda tidak dapat menonaktifkan akun Anda sendiri");
    // No role checkbox and no deactivate control on one's own account.
    expect(view.container.querySelector("#peran-u-admin-MAKER")).toBeNull();
    expect(view.container.querySelector(".status-kendali")).toBeNull();
    view.unmount();
  });

  test("the username is a fixed fact with the audit trail reason", async () => {
    at("/konfigurasi/pengguna");
    const view = await mount(<App />);
    await clickOn(barisPertama(view.container));

    expect(textOf(view.container.querySelector(".tetap-list"))).toContain("Nama pengguna");
    expect(textOf(view.container)).toContain("Audit trail dan setiap jejak pembuat dokumen");
    view.unmount();
  });

  test("while the one time password is on screen, nothing that could destroy it is reachable", async () => {
    // THE DEFECT THIS PREVENTS. The cheapest way to lose the only copy of a
    // handover password is not a stray click on "reset": it is a stray click on
    // ANOTHER ROW, which unmounts the panel holding it. So the whole list goes
    // away while the value is shown.
    at("/konfigurasi/pengguna");
    const view = await mount(<App />);
    await clickOn(barisPertama(view.container));
    await clickOn(tombol(view.container, "Terbitkan sandi sementara")!);
    await clickOn(konfirmasiDialog(view.container, "Terbitkan"));

    expect(textOf(view.container)).toContain("Kd7-Rp2-Qz9");
    // No list, no second issue control, and no other row to click.
    expect(view.container.querySelector("table")).toBeNull();
    expect(view.container.querySelector(".kartu-btn")).toBeNull();
    expect(tombol(view.container, "Terbitkan sandi sementara")).toBeUndefined();
    expect(tombol(view.container, "Akun baru")).toBeUndefined();
    expect(textOf(view.container)).toContain("tidak ada cara apa pun untuk menampilkannya kembali");
    view.unmount();
  });

  test("dismissing the password says it is gone, and never re-renders the value", async () => {
    at("/konfigurasi/pengguna");
    const view = await mount(<App />);
    await clickOn(barisPertama(view.container));
    await clickOn(tombol(view.container, "Terbitkan sandi sementara")!);
    await clickOn(konfirmasiDialog(view.container, "Terbitkan"));
    await clickOn(tombol(view.container, "Tutup, sandi sudah diserahkan")!);

    expect(textOf(view.container)).not.toContain("Kd7-Rp2-Qz9");
    expect(textOf(view.container)).toContain("tidak bisa dibaca kembali dari mana pun");
    view.unmount();
  });
});

describe("event journal mapping is a maker checker, not a form", () => {
  test("a proposal is drawn as a diff against the mapping frozen when it was filed", async () => {
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);

    const kartu = view.container.querySelector(".usul-kartu") as HTMLElement;
    expect(kartu).toBeTruthy();
    const kepala = textOf(kartu.querySelector(".usul-banding-kepala"));
    expect(kepala).toContain("Berlaku saat usulan diajukan");
    expect(kepala).toContain("Diusulkan");

    const barisDebit = [...kartu.querySelectorAll(".usul-banding-baris")].find((node) =>
      textOf(node).includes("Kaki debit"),
    );
    // The frozen before, and the proposed after, side by side on one row.
    expect(textOf(barisDebit)).toContain("1.2.01 Piutang Pinjaman PUMK");
    expect(textOf(barisDebit)).toContain("1.1.01");
    // A changed row is marked by a word, not by colour alone.
    expect(textOf(barisDebit)).toContain("berubah");
    view.unmount();
  });

  test("an unchanged row is not marked as changed", async () => {
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);
    const jenis = [...view.container.querySelectorAll(".usul-banding-baris")].find((node) =>
      textOf(node).includes("Jenis jurnal"),
    );
    expect(jenis?.className).not.toContain("is-beda");
    view.unmount();
  });

  test("approving your own proposal is not offered, withdrawing it is", async () => {
    usulanRows = [usulan({ diajukanBy: "u-admin", diajukanOleh: "Sri Handayani" })];
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);

    expect(tombol(view.container, "Setujui dan berlakukan")).toBeUndefined();
    expect(tombol(view.container, "Tolak usulan")).toBeUndefined();
    expect(tombol(view.container, "Tarik usulan ini")).toBeTruthy();
    expect(textOf(view.container)).toContain("Anda tidak boleh memutuskannya sendiri");
    view.unmount();
  });

  test("somebody else's proposal offers both decisions, and approval needs the event typed", async () => {
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);

    await clickOn(tombol(view.container, "Setujui dan berlakukan")!);
    expect((konfirmasiDialog(view.container, "Setujui") as HTMLButtonElement).disabled).toBe(true);

    await typeInto(
      view.container.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "PENCAIRAN_PUMK",
    );
    expect((konfirmasiDialog(view.container, "Setujui") as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  test("the page states that a proposal changes nothing until it is approved", async () => {
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);
    const teks = textOf(view.container);
    expect(teks).toContain("tidak mengubah apa pun");
    expect(teks).toContain("usulan disimpan di tabel terpisah yang tidak dilihat mesin jurnal");
    view.unmount();
  });

  test("an event with no mapping in force is reported, because it cannot post at all", async () => {
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);
    expect(textOf(view.container)).toContain("PELUNASAN_PUMK");
    expect(textOf(view.container)).toContain("Event yang tidak punya pemetaan berlaku");
    view.unmount();
  });

  test("the server's segregation refusal is rendered on the proposal it refused", async () => {
    tolakan = {
      cocok: "/jurnal/mapping/usulan/us-1/setujui",
      status: 409,
      pesan:
        "Anda yang mengajukan perubahan pemetaan ini, jadi Anda tidak boleh menyetujuinya sendiri.",
    };
    at("/konfigurasi/event-jurnal");
    const view = await mount(<App />);
    await clickOn(tombol(view.container, "Setujui dan berlakukan")!);
    await typeInto(
      view.container.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "PENCAIRAN_PUMK",
    );
    await clickOn(konfirmasiDialog(view.container, "Setujui"));

    expect(textOf(view.container.querySelector(".usul-kartu"))).toContain(
      "tidak boleh menyetujuinya sendiri",
    );
    view.unmount();
  });
});

describe("the two entries with no API say why, and offer no control", () => {
  for (const path of ["/konfigurasi/template-laporan", "/konfigurasi/nomor-dokumen"]) {
    test(`${path} names the undecided question instead of promising a form`, async () => {
      at(path);
      const view = await mount(<App />);
      const teks = textOf(view.container);
      expect(teks).toContain("belum tersedia, dan alasannya bukan jadwal");
      expect(teks).toContain("Cara mengubahnya hari ini");
      // No form, no button that would imply the answer is known.
      expect(view.container.querySelector("input, select, textarea")).toBeNull();
      view.unmount();
    });
  }
});

describe("the permission mirror follows the server", () => {
  test("konfigurasi.mapping is in the SPA vocabulary and held only by Admin Pusat", () => {
    expect(PERMISSIONS).toContain("konfigurasi.mapping");
    expect(PERMISSIONS_BY_ROLE.ADMIN_PUSAT).toContain("konfigurasi.mapping");
    // An Admin Cabang holds `konfigurasi.user` and must NOT inherit the right
    // to re-point the ledger through it.
    expect(PERMISSIONS_BY_ROLE.ADMIN_CABANG).not.toContain("konfigurasi.mapping");
    expect(PERMISSIONS_BY_ROLE.APPROVER).not.toContain("konfigurasi.mapping");
    expect(PERMISSIONS_BY_ROLE.AUDITOR).not.toContain("konfigurasi.mapping");
  });

  test("the mapping screen is gated on its own code, not on konfigurasi.parameter", () => {
    // Sharing `konfigurasi.parameter` would have meant that the right to read
    // and change a rate also carried the right to decide what every future
    // PENCAIRAN_PUMK debits.
    expect(findRoute("/konfigurasi/event-jurnal")?.permission).toBe("konfigurasi.mapping");
    expect(findRoute("/konfigurasi/coa")?.permission).toBe("konfigurasi.coa");
    expect(findRoute("/konfigurasi/pengguna")?.permission).toBe("konfigurasi.user");
  });
});
