// Fase 4 Non PUMK screens, tested through the real App: the router, the
// session bootstrap, the permission gate and the page all take part, and the
// only thing replaced is the transport.
//
// The theme of this file is that a number on one of these screens is either
// the server's own or is visibly absent. The disbursement ceiling and the LPJ
// remainder get the most attention, because they are the two places where a
// figure rounded for display would change what an operator believes they are
// allowed to do.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";
import { hasPermission, PERMISSIONS_BY_ROLE } from "./permissions";
import { clickOn, mount, selectOption, textOf, typeInto } from "./testing";

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

/** What an endpoint the SPA asks for but the API does not serve answers. */
function notFound(): Response {
  return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } });
}

const SESSION = {
  user: { id: "u2", username: "maker", nama: "Budi Santoso", role: "MAKER" },
  cabang: { id: "c1", kode: "01", nama: "Cabang Cilegon" },
  cabangTersedia: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: [
    "dashboard.view",
    "nonpumk.view",
    "nonpumk.create",
    "nonpumk.penilaian",
    "nonpumk.penyaluran",
    "nonpumk.lpj",
  ],
  roles: ["MAKER"],
  readOnly: false,
  lintasCabang: false,
};

/** Admin Pusat, who inherits the Checker's `nonpumk.lpj.verifikasi`. */
const SESSION_ADMIN = {
  ...SESSION,
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  permissions: [
    ...SESSION.permissions,
    "nonpumk.review",
    "nonpumk.approve",
    "nonpumk.lpj.verifikasi",
    "konfigurasi.parameter",
  ],
  roles: ["ADMIN_PUSAT"],
};

const SDG_1 = { sdgId: "sdg1", nomor: 1, nama: "Tanpa Kemiskinan", bobot: "1.000000" };
const SDG_4 = { sdgId: "sdg4", nomor: 4, nama: "Pendidikan Berkualitas", bobot: "0.500000" };

const PROPOSAL_INTERNAL = {
  id: "np1",
  cabangId: "c1",
  noProposal: "NPK-2026-0001",
  tanggalProposal: "2026-08-01",
  namaPemohon: "Yayasan Bina Bangsa",
  atasNama: null,
  bidangId: "b1",
  judulProgram: "Renovasi ruang kelas",
  deskripsiProgram: "Perbaikan tiga ruang kelas",
  jumlahDiajukan: "50000000.00",
  jumlahDisetujui: "40000000.00",
  penerimaManfaatEstimasi: 120,
  sumberPengajuan: "INTERNAL",
  status: "DISETUJUI",
  currentStep: 5,
  createdBy: "u2",
  bidangKode: "PDD",
  bidangNama: "Pendidikan",
  cabangNama: "Cabang Cilegon",
  sdg: [SDG_1, SDG_4],
  totalDisalurkan: "0.00",
  statusLpj: null,
  // Days since the PROPOSAL was raised, from the server. Not the LPJ ageing.
  umurHari: 84,
};

const PROPOSAL_PORTAL = {
  ...PROPOSAL_INTERNAL,
  id: "np2",
  noProposal: "NPK-2026-0002",
  namaPemohon: "Karang Taruna Grogol",
  judulProgram: "Bantuan bibit mangrove",
  jumlahDiajukan: "10000000.00",
  jumlahDisetujui: null,
  sumberPengajuan: "PORTAL_ONLINE",
  status: "MENUNGGU_PERSETUJUAN",
  sdg: [SDG_1],
};

const BATASAN = {
  nilaiMin: "1000000.00",
  nilaiMax: "500000000.00",
  skorPenilaianMinimumLolos: "70.000000",
  batasHariLpj: 90,
  ambangUmurLpj: [30, 60, 90],
};

const BIDANG = { data: [{ id: "b1", kode: "PDD", nama: "Pendidikan" }] };
const SDG_MASTER = {
  data: [
    { id: "sdg1", nomor: 1, nama: "Tanpa Kemiskinan" },
    { id: "sdg4", nomor: 4, nama: "Pendidikan Berkualitas" },
  ],
};
const AKUN_KAS = { data: [{ id: "k1", kode: "1101", nama: "Kas Bank Mandiri" }] };
const AKUN_BEBAN = { data: [{ id: "e1", kode: "5201", nama: "Beban Penyaluran Pendidikan" }] };

function at(path: string) {
  globalThis.history.replaceState(null, "", path);
}

beforeEach(() => {
  at("/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("daftar proposal Non PUMK", () => {
  test("an endpoint that does not answer renders the failure panel, not an empty table", async () => {
    at("/nonpumk/proposal");
    stubFetch((call) => (call.url.includes("/auth/session") ? json(200, SESSION) : notFound()));
    const view = await mount(<App />);

    const gagal = view.container.querySelector(".errorstate");
    expect(gagal).toBeTruthy();
    expect(textOf(gagal)).toContain("Gagal memuat daftar proposal Non PUMK");
    expect(textOf(gagal)).toContain("GET /api/nonpumk/proposal");
    // No table of nothing standing in for the answer that never came.
    expect(view.container.querySelector(".table-state-title")).toBeNull();
    view.unmount();
  });

  test("the failure repeats the server's own status rather than inventing a reason", async () => {
    at("/nonpumk/proposal");
    stubFetch((call) =>
      call.url.includes("/auth/session")
        ? json(200, SESSION)
        : json(503, { error: "Basis data sedang tidak dapat diakses", kode: "DB_DOWN" }),
    );
    const view = await mount(<App />);
    const gagal = textOf(view.container.querySelector(".errorstate"));
    expect(gagal).toContain("Basis data sedang tidak dapat diakses");
    expect(gagal).toContain("DB_DOWN");
    view.unmount();
  });

  test("bidang, SDG, status and the date range all reach the API as query parameters", async () => {
    // Spec 9.2 names these four filters. Narrowing an array in the browser
    // would make the count on screen a count of the page, not of the answer.
    at("/nonpumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/sdg")) return json(200, SDG_MASTER);
      if (call.url.includes("/nonpumk/proposal")) return json(200, { data: [] });
      return notFound();
    });
    const view = await mount(<App />);

    const pilih = (label: string) =>
      view.container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;

    await selectOption(pilih("Bidang Non PUMK"), "b1");
    await selectOption(pilih("SDG"), "sdg4");
    await selectOption(pilih("Status proposal"), "DISALURKAN");
    await typeInto(
      view.container.querySelector('input[aria-label="Tanggal proposal dari"]') as HTMLInputElement,
      "2026-08-01",
    );
    await view.flush();

    const terakhir = calls.filter((call) => call.url.includes("/nonpumk/proposal")).at(-1);
    expect(terakhir?.url).toContain("bidangId=b1");
    expect(terakhir?.url).toContain("sdgId=sdg4");
    expect(terakhir?.url).toContain("status=DISALURKAN");
    expect(terakhir?.url).toContain("dariTanggal=2026-08-01");
    view.unmount();
  });

  test("money is Indonesian, and a proposal nobody approved shows no approved figure", async () => {
    at("/nonpumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/sdg")) return json(200, SDG_MASTER);
      if (call.url.includes("/nonpumk/proposal")) {
        return json(200, { data: [PROPOSAL_INTERNAL, PROPOSAL_PORTAL] });
      }
      return notFound();
    });
    const view = await mount(<App />);

    const tabs = [...view.container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map((tab) => textOf(tab))).toEqual([
      "Daftar Pemohon1",
      "Daftar Pemohon Online1",
    ]);

    expect(textOf(view.container.querySelector("tbody"))).toContain("50.000.000,00");
    // 50.000.000,00 plus 10.000.000,00 across BOTH tabs, added in integer sen.
    expect(textOf(view.container.querySelector(".tabs-note"))).toContain("60.000.000,00");

    // The portal proposal has no approved amount. It must not read as 0,00.
    await clickOn(tabs[1]!);
    const baris = textOf(view.container.querySelector("tbody"));
    expect(baris).toContain("Belum disetujui");
    view.unmount();
  });
});

describe("antrean kerja Non PUMK", () => {
  test("the queue age is the server's document age, printed as such", async () => {
    // The browser computes no age of its own. `umurHari` on a proposal row is
    // days since the proposal was raised; days since the last disbursement is
    // a different field on a different screen, and the column says which.
    at("/nonpumk/penilaian");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/batasan")) return json(200, BATASAN);
      if (call.url.includes("/nonpumk/proposal")) {
        return json(200, { data: [{ ...PROPOSAL_INTERNAL, status: "PENILAIAN", umurHari: 84 }] });
      }
      return notFound();
    });
    const view = await mount(<App />);

    expect(calls.some((call) => call.url.includes("status=PENILAIAN"))).toBe(true);
    expect(textOf(view.container.querySelector("thead"))).toContain("Umur dokumen (hari)");
    expect(textOf(view.container.querySelector("tbody"))).toContain("84");
    view.unmount();
  });
});

describe("input proposal Non PUMK", () => {
  function stubForm(batasanResponse: () => Response) {
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/batasan")) return batasanResponse();
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/sdg")) return json(200, SDG_MASTER);
      return notFound();
    });
  }

  async function isiDasar(view: Awaited<ReturnType<typeof mount>>) {
    await typeInto(view.container.querySelector("#np-pemohon") as HTMLInputElement, "Yayasan Bina Bangsa");
    await typeInto(view.container.querySelector("#np-judul") as HTMLInputElement, "Renovasi ruang kelas");
    await typeInto(view.container.querySelector("#np-jumlah") as HTMLInputElement, "50.000.000");
    await typeInto(view.container.querySelector("#np-penerima") as HTMLInputElement, "120");
    await view.flush();
  }

  test("the form stays closed when its own limits cannot be read", async () => {
    // Sending a grant proposal whose amount was never compared against a limit
    // would carry an implied "this was checked" all the way to an approver.
    at("/nonpumk/proposal/baru");
    stubForm(() => json(503, { error: "Parameter batasan Non PUMK belum ada", kode: "KONFIGURASI_TIDAK_ADA" }));
    const view = await mount(<App />);
    await isiDasar(view);

    const gagal = textOf(view.container.querySelector(".form-aside .errorstate"));
    expect(gagal).toContain("Batas program tidak dapat dibaca");
    expect(gagal).toContain("GET /api/nonpumk/batasan");
    expect(gagal).toContain("KONFIGURASI_TIDAK_ADA");

    const simpan = [...view.container.querySelectorAll(".form-actions-row .btn")].at(-1) as HTMLButtonElement;
    expect(textOf(simpan)).toBe("Simpan sebagai draft");
    expect(simpan.disabled).toBe(true);
    view.unmount();
  });

  test("a bidang and at least one SDG are mandatory before the form will submit", async () => {
    at("/nonpumk/proposal/baru");
    stubForm(() => json(200, BATASAN));
    const view = await mount(<App />);
    await isiDasar(view);

    const simpan = () =>
      [...view.container.querySelectorAll(".form-actions-row .btn")].at(-1) as HTMLButtonElement;
    const periksa = () => textOf(view.container.querySelector(".periksa-list"));

    expect(periksa()).toContain("Bidang Non PUMK wajib dipilih");
    expect(periksa()).toContain("minimal satu SDG");
    expect(simpan().disabled).toBe(true);

    await selectOption(
      view.container.querySelector("#np-bidang") as HTMLSelectElement,
      "b1",
    );
    await view.flush();
    expect(simpan().disabled).toBe(true);

    await selectOption(
      view.container.querySelector("#np-sdg-tambah") as HTMLSelectElement,
      "sdg4",
    );
    await view.flush();

    expect(simpan().disabled).toBe(false);
    view.unmount();
  });

  test("an SDG weight outside 0 to 1 closes the form and says which goal", async () => {
    at("/nonpumk/proposal/baru");
    stubForm(() => json(200, BATASAN));
    const view = await mount(<App />);
    await isiDasar(view);

    await selectOption(
      view.container.querySelector("#np-bidang") as HTMLSelectElement,
      "b1",
    );
    await selectOption(
      view.container.querySelector("#np-sdg-tambah") as HTMLSelectElement,
      "sdg4",
    );
    await view.flush();

    await typeInto(view.container.querySelector("#np-bobot-sdg4") as HTMLInputElement, "1.5");
    await view.flush();

    expect(textOf(view.container.querySelector(".periksa-list"))).toContain("Bobot SDG 4");
    const simpan = [...view.container.querySelectorAll(".form-actions-row .btn")].at(-1) as HTMLButtonElement;
    expect(simpan.disabled).toBe(true);
    view.unmount();
  });

  test("a value over the configured maximum is named against that maximum", async () => {
    at("/nonpumk/proposal/baru");
    stubForm(() => json(200, { ...BATASAN, nilaiMax: "20000000.00" }));
    const view = await mount(<App />);
    await isiDasar(view);

    expect(textOf(view.container.querySelector(".periksa-list"))).toContain(
      "melewati batas maksimum Rp 20.000.000,00",
    );
    view.unmount();
  });

  test("the payload carries the bidang and every SDG with its weight", async () => {
    at("/nonpumk/proposal/baru");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/batasan")) return json(200, BATASAN);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/sdg")) return json(200, SDG_MASTER);
      if (call.method === "POST" && call.url.includes("/nonpumk/proposal")) {
        return json(201, { ...PROPOSAL_INTERNAL, status: "DRAFT" });
      }
      return notFound();
    });
    const view = await mount(<App />);
    await isiDasar(view);

    await selectOption(
      view.container.querySelector("#np-bidang") as HTMLSelectElement,
      "b1",
    );
    await selectOption(
      view.container.querySelector("#np-sdg-tambah") as HTMLSelectElement,
      "sdg1",
    );
    await view.flush();
    await typeInto(view.container.querySelector("#np-bobot-sdg1") as HTMLInputElement, "0,5");
    await view.flush();

    await clickOn([...view.container.querySelectorAll(".form-actions-row .btn")].at(-1)!);

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/nonpumk/proposal"));
    expect(kirim).toBeTruthy();
    const body = JSON.parse(kirim?.body ?? "{}") as Record<string, unknown>;
    expect(body.bidangId).toBe("b1");
    expect(body.jumlahDiajukan).toBe("50000000.00");
    expect(body.penerimaManfaatEstimasi).toBe(120);
    expect(body.sdg).toEqual([{ sdgId: "sdg1", bobot: "0.500000" }]);
    view.unmount();
  });
});

describe("penyaluran bertahap", () => {
  const DETAIL_DISALURKAN = {
    proposal: { ...PROPOSAL_INTERNAL, status: "DISALURKAN", totalDisalurkan: undefined },
    sdg: [SDG_1, SDG_4],
    penilaian: null,
    penyaluran: [
      {
        id: "t1",
        proposalId: "np1",
        termin: 1,
        tanggalPenyaluran: "2026-08-10",
        jumlah: "25000000.00",
        akunKasId: "k1",
        akunBebanId: "e1",
        noBukti: "BKK-001",
        keterangan: "Termin pertama",
        jurnalId: "j1",
      },
    ],
    totalDisalurkan: "25000000.00",
    sisaPagu: "15000000.00",
    lpj: null,
    bebanBersihBukuBesar: "25000000.00",
    kasBersihBukuBesar: "-25000000.00",
    bidangKode: "PDD",
    bidangNama: "Pendidikan",
    cabangNama: "Cabang Cilegon",
  };

  function stubPenyaluran(detail: unknown = DETAIL_DISALURKAN) {
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/konfigurasi/akun")) return json(200, AKUN_KAS);
      if (call.url.includes("/nonpumk/akun-beban")) return json(200, AKUN_BEBAN);
      if (call.url.includes("/nonpumk/proposal/np1")) return json(200, detail);
      return notFound();
    });
  }

  /** Everything the termin form needs EXCEPT the amount, so a disabled button
   *  in these tests can only be about the ceiling. */
  async function isiAkun(view: Awaited<ReturnType<typeof mount>>) {
    await selectOption(
      view.container.querySelector("#np-akun-kas") as HTMLSelectElement,
      "k1",
    );
    await selectOption(
      view.container.querySelector("#np-akun-beban") as HTMLSelectElement,
      "e1",
    );
    await view.flush();
  }

  test("approved, already disbursed and remaining are three separate exact figures", async () => {
    at("/nonpumk/penyaluran?proposal=np1");
    stubPenyaluran();
    const view = await mount(<App />);

    const bento = textOf(view.container.querySelector(".bento"));
    expect(bento).toContain("Nilai disetujui");
    expect(bento).toContain("40.000.000,00");
    expect(bento).toContain("Sudah disalurkan");
    expect(bento).toContain("25.000.000,00");
    expect(bento).toContain("Sisa pagu");
    expect(bento).toContain("15.000.000,00");
    view.unmount();
  });

  test("a termin landing exactly on the remaining pagu is allowed", async () => {
    at("/nonpumk/penyaluran?proposal=np1");
    stubPenyaluran();
    const view = await mount(<App />);
    await isiAkun(view);

    await typeInto(view.container.querySelector("#np-jumlah-salur") as HTMLInputElement, "15.000.000");
    await view.flush();

    const catat = [...view.container.querySelectorAll(".form-main .form-actions-row .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(textOf(catat)).toBe("Catat termin penyaluran");
    expect(catat.disabled).toBe(false);
    expect(textOf(view.container)).toContain("persis menghabiskan sisa pagu");
    view.unmount();
  });

  test("one sen over the remaining pagu is refused, and the refusal names the figure", async () => {
    // The whole reason the remaining figure is never rounded for display: at
    // 15.000.000,00 remaining, 15.000.000,01 is a different answer.
    at("/nonpumk/penyaluran?proposal=np1");
    stubPenyaluran();
    const view = await mount(<App />);
    await isiAkun(view);

    await typeInto(view.container.querySelector("#np-jumlah-salur") as HTMLInputElement, "15.000.000,01");
    await view.flush();

    expect(textOf(view.container.querySelector(".field.has-error"))).toContain(
      "Melebihi sisa pagu 15.000.000,00",
    );
    const catat = [...view.container.querySelectorAll(".form-main .form-actions-row .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(catat.disabled).toBe(true);
    view.unmount();
  });

  test("a remaining pagu with sen keeps its sen on screen, unrounded", async () => {
    at("/nonpumk/penyaluran?proposal=np1");
    stubPenyaluran({ ...DETAIL_DISALURKAN, sisaPagu: "14999999.99" });
    const view = await mount(<App />);

    expect(textOf(view.container.querySelector(".bento"))).toContain("14.999.999,99");
    view.unmount();
  });

  test("the ceiling is not checked at all when the read that carries it failed", async () => {
    at("/nonpumk/penyaluran?proposal=np1");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/konfigurasi/akun")) return json(200, AKUN_KAS);
      if (call.url.includes("/nonpumk/akun-beban")) return json(200, AKUN_BEBAN);
      return notFound();
    });
    const view = await mount(<App />);

    // No form at all, and no pagu cards: there is nothing to check against.
    expect(textOf(view.container.querySelector(".errorstate"))).toContain(
      "Gagal memuat pagu dan riwayat penyaluran",
    );
    expect(view.container.querySelector("#np-jumlah-salur")).toBeNull();
    expect(view.container.querySelector(".bento")).toBeNull();
    view.unmount();
  });

  test("the termin is submitted with the cash and expense accounts the form chose", async () => {
    at("/nonpumk/penyaluran?proposal=np1");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/konfigurasi/akun")) return json(200, AKUN_KAS);
      if (call.url.includes("/nonpumk/akun-beban")) return json(200, AKUN_BEBAN);
      if (call.method === "POST" && call.url.includes("/penyaluran")) {
        return json(201, DETAIL_DISALURKAN.penyaluran[0]);
      }
      if (call.url.includes("/nonpumk/proposal/np1")) return json(200, DETAIL_DISALURKAN);
      return notFound();
    });
    const view = await mount(<App />);

    await typeInto(view.container.querySelector("#np-jumlah-salur") as HTMLInputElement, "10.000.000");
    await selectOption(
      view.container.querySelector("#np-akun-kas") as HTMLSelectElement,
      "k1",
    );
    await selectOption(
      view.container.querySelector("#np-akun-beban") as HTMLSelectElement,
      "e1",
    );
    await view.flush();

    await clickOn([...view.container.querySelectorAll(".form-main .form-actions-row .btn")].at(-1)!);
    // The confirmation step is mandatory before anything is recorded.
    expect(textOf(view.container.querySelector(".modal"))).toContain(
      "membentuk jurnal, bukan memindahkan dana",
    );
    await clickOn([...view.container.querySelectorAll(".modal-foot .btn")].at(-1)!);

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/penyaluran"));
    const body = JSON.parse(kirim?.body ?? "{}") as Record<string, unknown>;
    expect(body.jumlah).toBe("10000000.00");
    expect(body.akunKasId).toBe("k1");
    expect(body.akunBebanId).toBe("e1");
    view.unmount();
  });
});

describe("LPJ", () => {
  const DETAIL_MENUNGGU_LPJ = {
    proposal: { ...PROPOSAL_INTERNAL, status: "MENUNGGU_LPJ" },
    sdg: [SDG_1],
    penilaian: null,
    penyaluran: [],
    totalDisalurkan: "40000000.00",
    sisaPagu: "0.00",
    lpj: null,
    bebanBersihBukuBesar: "40000000.00",
    kasBersihBukuBesar: "-40000000.00",
    bidangKode: "PDD",
    bidangNama: "Pendidikan",
    cabangNama: "Cabang Cilegon",
  };

  const DETAIL_LPJ_DIAJUKAN = {
    ...DETAIL_MENUNGGU_LPJ,
    proposal: { ...PROPOSAL_INTERNAL, status: "LPJ_DIAJUKAN" },
    lpj: {
      id: "l1",
      proposalId: "np1",
      tanggalLpj: "2026-11-01",
      jumlahRealisasi: "37500000.00",
      jumlahSisaDikembalikan: "2500000.00",
      penerimaManfaatAktual: 118,
      uraianRealisasi: "Tiga ruang kelas selesai",
      status: "DIAJUKAN",
      verifiedBy: null,
      verifiedAt: null,
      jurnalIdPengembalian: null,
    },
  };

  function stubLpj(detail: unknown, session: unknown = SESSION) {
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, session);
      if (call.url.includes("/konfigurasi/akun")) return json(200, AKUN_KAS);
      if (call.method === "POST" && call.url.includes("/lpj")) return json(201, {});
      // Ordered before the detail read: the timeline path CONTAINS the detail
      // path, and matching the detail first fed a proposal object to a screen
      // expecting a `{ data: [] }` envelope.
      if (call.url.includes("/timeline")) return json(200, { data: [] });
      if (call.url.includes("/nonpumk/proposal/np1")) return json(200, detail);
      return notFound();
    });
  }

  test("disbursed, realised and the returnable remainder are three separate figures", async () => {
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_MENUNGGU_LPJ);
    const view = await mount(<App />);

    await typeInto(view.container.querySelector("#np-realisasi") as HTMLInputElement, "37.500.000");
    await view.flush();

    const bento = textOf(view.container.querySelector(".bento"));
    expect(bento).toContain("Dana disalurkan");
    expect(bento).toContain("40.000.000,00");
    expect(bento).toContain("Realisasi LPJ");
    expect(bento).toContain("37.500.000,00");
    expect(bento).toContain("Sisa dikembalikan");
    expect(bento).toContain("2.500.000,00");
    view.unmount();
  });

  test("the remainder is exact to the sen while it is being typed", async () => {
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_MENUNGGU_LPJ);
    const view = await mount(<App />);

    await typeInto(view.container.querySelector("#np-realisasi") as HTMLInputElement, "39.999.999,99");
    await view.flush();

    expect(textOf(view.container.querySelector(".bento"))).toContain("0,01");
    view.unmount();
  });

  test("a realisation larger than what went out is refused before it is sent", async () => {
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_MENUNGGU_LPJ);
    const view = await mount(<App />);

    await typeInto(view.container.querySelector("#np-realisasi") as HTMLInputElement, "40.000.000,01");
    await typeInto(view.container.querySelector("#np-penerima-aktual") as HTMLInputElement, "118");
    await view.flush();

    expect(textOf(view.container.querySelector(".field.has-error"))).toContain(
      "Realisasi melebihi dana yang disalurkan 40.000.000,00",
    );
    const ajukan = [...view.container.querySelectorAll(".form-main .form-actions-row .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(ajukan.disabled).toBe(true);
    view.unmount();
  });

  test("filing says plainly that it forms no journal, and acceptance says which one it does", async () => {
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_MENUNGGU_LPJ);
    const view = await mount(<App />);
    expect(textOf(view.container)).toContain("Pengajuan LPJ belum membentuk jurnal apa pun");
    view.unmount();

    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_LPJ_DIAJUKAN, SESSION_ADMIN);
    const kedua = await mount(<App />);
    const teks = textOf(kedua.container);
    expect(teks).toContain("PENGEMBALIAN_SISA_NON_PUMK");
    expect(teks).toContain("2.500.000,00");
    kedua.unmount();
  });

  test("a session holding the verification permission can verify", async () => {
    // `nonpumk.lpj.verifikasi` IS in the server's catalogue, granted to the
    // Checker and inherited by Admin Pusat. An earlier version of this screen
    // told such a user the permission did not exist yet, which is the
    // application asserting something false about its own configuration to
    // somebody with no way to check it.
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_LPJ_DIAJUKAN, SESSION_ADMIN);
    const view = await mount(<App />);

    expect(view.container.querySelector(".peringatan")).toBeNull();
    const teks = textOf(view.container);
    expect(teks).not.toContain("belum terdaftar");
    expect(teks).not.toContain("nonpumk.lpj.verifikasi");

    const tombol = [...view.container.querySelectorAll(".form-main .form-actions-row .btn")] as HTMLButtonElement[];
    expect(tombol.map((btn) => textOf(btn))).toEqual(["Tolak LPJ", "Terima LPJ"]);
    // Accept is open, because there is a remainder AND a cash account can be
    // chosen. Reject is shut until a reason is typed, which is its own rule.
    const kas = view.container.querySelector("#np-akun-kas-lpj") as HTMLSelectElement;
    expect(kas.disabled).toBe(false);
    await selectOption(kas, "k1");
    expect(tombol[1]!.disabled).toBe(false);
    view.unmount();
  });

  test("acceptance posts the return with the cash account, and nothing else", async () => {
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_LPJ_DIAJUKAN, SESSION_ADMIN);
    const view = await mount(<App />);

    await selectOption(
      view.container.querySelector("#np-akun-kas-lpj") as HTMLSelectElement,
      "k1",
    );
    await clickOn(
      [...view.container.querySelectorAll(".form-main .form-actions-row .btn")].at(-1)!,
    );
    await clickOn([...view.container.querySelectorAll(".modal-foot .btn")].at(-1)!);

    const kirim = calls.find(
      (call) => call.method === "POST" && call.url.includes("/lpj/verifikasi"),
    );
    expect(kirim).toBeTruthy();
    const body = JSON.parse(kirim?.body ?? "{}") as Record<string, unknown>;
    expect(body.akunKasId).toBe("k1");
    // The expense account credited back is the one that termin debited, and
    // the engine reads it from the termin row. It is not a choice, so it is
    // not on the form and must not be in the payload.
    expect(body).not.toHaveProperty("akunBebanId");
    expect(body).not.toHaveProperty("jumlahSisaDikembalikan");
    view.unmount();
  });

  test("a session without it sees the controls shut, and no claim about the catalogue", async () => {
    // The Maker filed this report. The ordinary permission check closes the
    // controls; the reason given is about THIS account's authority, which the
    // page can see, not about what the system does or does not have.
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_LPJ_DIAJUKAN, SESSION);
    const view = await mount(<App />);

    const peringatan = textOf(view.container.querySelector(".peringatan"));
    expect(peringatan).toContain("wewenang Checker");
    expect(peringatan).not.toContain("belum terdaftar");
    expect(peringatan).not.toContain("katalog");

    const tombol = [...view.container.querySelectorAll(".form-main .form-actions-row .btn")] as HTMLButtonElement[];
    expect(tombol.every((btn) => btn.disabled)).toBe(true);
    view.unmount();
  });

  test("no screen in this module claims a permission or a config row is missing", async () => {
    // The class of bug this guards: copy that was true when it was written and
    // is false after the server ships the thing. Migration 0022 shipped all
    // four Non PUMK limits and the auth catalogue holds the verification code,
    // so no screen may tell a reader otherwise.
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(DETAIL_LPJ_DIAJUKAN, SESSION_ADMIN);
    const view = await mount(<App />);
    const teks = textOf(view.container);
    for (const klaim of ["belum terdaftar", "katalog hak akses", "belum dipegang", "pasti ditolak"]) {
      expect(teks).not.toContain(klaim);
    }
    view.unmount();
  });

  test("a realisation equal to the disbursement forms no journal, and says so", async () => {
    at("/nonpumk/lpj?proposal=np1");
    stubLpj(
      {
        ...DETAIL_LPJ_DIAJUKAN,
        lpj: {
          ...DETAIL_LPJ_DIAJUKAN.lpj,
          jumlahRealisasi: "40000000.00",
          jumlahSisaDikembalikan: "0.00",
        },
      },
      SESSION_ADMIN,
    );
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("tidak ada jurnal yang terbentuk");
    // A genuine zero still prints as 0,00.
    expect(textOf(view.container.querySelector(".bento"))).toContain("0,00");
    view.unmount();
  });
});

describe("monitoring LPJ terlambat", () => {
  const BARIS = {
    proposalId: "np1",
    noProposal: "NPK-2026-0001",
    cabangId: "c1",
    bidangId: "b1",
    namaPemohon: "Yayasan Bina Bangsa",
    judulProgram: "Renovasi ruang kelas",
    status: "MENUNGGU_LPJ",
    totalDisalurkan: "40000000.00",
    tanggalPenyaluranTerakhir: "2026-05-01",
    umurHari: 95,
    ember: "UMUR_90_PLUS",
    terlambat: true,
    bidangKode: "PDD",
    bidangNama: "Pendidikan",
    cabangNama: "Cabang Cilegon",
  };

  test("the four spec buckets are named with their day boundaries", async () => {
    at("/nonpumk/monitoring-lpj");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/monitoring-lpj")) {
        return json(200, { data: [BARIS, { ...BARIS, proposalId: "np3", ember: "UMUR_30_59", umurHari: 30, terlambat: false, totalDisalurkan: "5000000.00" }] });
      }
      return notFound();
    });
    const view = await mount(<App />);

    const bento = textOf(view.container.querySelector(".bento"));
    expect(bento).toContain("Kurang dari 30 hari");
    expect(bento).toContain("30 sampai 59 hari");
    expect(bento).toContain("60 sampai 89 hari");
    expect(bento).toContain("90 hari atau lebih");
    // Card totals come from the same answer the table renders.
    expect(bento).toContain("40.000.000,00");
    expect(bento).toContain("5.000.000,00");
    view.unmount();
  });

  test("the bucket and the configured deadline are kept as two different facts", async () => {
    at("/nonpumk/monitoring-lpj");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/monitoring-lpj")) {
        // 95 days since the last termin and NOT late, because the configured
        // deadline is longer than the spec's top bucket.
        return json(200, { data: [{ ...BARIS, terlambat: false }] });
      }
      return notFound();
    });
    const view = await mount(<App />);

    const tabel = textOf(view.container.querySelector("tbody"));
    expect(tabel).toContain("95");
    expect(tabel).toContain("Dalam batas");
    // The bucket is on the cards, which read from the same answer.
    expect(textOf(view.container.querySelector(".bento"))).toContain("90 hari atau lebih");
    expect(textOf(view.container)).toContain("Program berumur 90 hari belum tentu lewat batas");
    view.unmount();
  });

  test("the two ages in this module are labelled apart, never both as umur", async () => {
    // Days since the proposal was raised and days since the last disbursement
    // differ by months on a real programme. One labelled as the other on a
    // monitoring screen is an error an operator would act on.
    at("/nonpumk/monitoring-lpj");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/monitoring-lpj")) return json(200, { data: [BARIS] });
      return notFound();
    });
    const view = await mount(<App />);
    const kepala = textOf(view.container.querySelector("thead"));
    expect(kepala).toContain("Umur sejak termin (hari)");
    expect(kepala).not.toContain("Umur dokumen");
    expect(textOf(view.container)).toContain("bukan dari tanggal proposal");
    view.unmount();
  });

  test("the ageing filter reaches the API rather than trimming the array", async () => {
    at("/nonpumk/monitoring-lpj");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/monitoring-lpj")) return json(200, { data: [] });
      return notFound();
    });
    const view = await mount(<App />);

    await selectOption(
      view.container.querySelector('select[aria-label="Kelompok umur minimal"]') as HTMLSelectElement,
      "UMUR_60_89",
    );
    await selectOption(
      view.container.querySelector('select[aria-label="Batas waktu LPJ"]') as HTMLSelectElement,
      "YA",
    );
    await view.flush();

    const terakhir = calls.filter((call) => call.url.includes("/monitoring-lpj")).at(-1);
    expect(terakhir?.url).toContain("emberMinimal=UMUR_60_89");
    expect(terakhir?.url).toContain("hanyaTerlambat=true");
    view.unmount();
  });
});

describe("copy hygiene on the built Non PUMK pages", () => {
  test("no long dash and no emoji anywhere on a rendered Non PUMK page", async () => {
    at("/nonpumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/nonpumk/bidang")) return json(200, BIDANG);
      if (call.url.includes("/nonpumk/sdg")) return json(200, SDG_MASTER);
      if (call.url.includes("/nonpumk/proposal")) {
        return json(200, { data: [PROPOSAL_INTERNAL, PROPOSAL_PORTAL] });
      }
      return notFound();
    });
    const view = await mount(<App />);
    const teks = textOf(view.container);
    expect(teks).not.toContain(LONG_DASH);
    expect(/\p{Extended_Pictographic}/u.test(teks)).toBe(false);
    view.unmount();
  });
});

describe("who may verify an LPJ", () => {
  // The frontend's role table is a MIRROR of the server's, kept so the nav
  // tests can assert what a role sees without standing up the API. A mirror
  // that disagrees with the original is worse than no mirror: it is what let a
  // screen tell a Checker their own permission did not exist.
  //
  // Source of truth: apps/api/src/modules/auth/permissions.ts, where
  // `nonpumk.lpj.verifikasi` is granted to CHECKER, inherited by ADMIN_CABANG
  // through that list and by ADMIN_PUSAT through the spread of PERMISSIONS.
  const IZIN = "nonpumk.lpj.verifikasi";

  test("the Checker holds it, and the two admin roles inherit it", () => {
    expect(hasPermission(PERMISSIONS_BY_ROLE.CHECKER, IZIN)).toBe(true);
    expect(hasPermission(PERMISSIONS_BY_ROLE.ADMIN_CABANG, IZIN)).toBe(true);
    expect(hasPermission(PERMISSIONS_BY_ROLE.ADMIN_PUSAT, IZIN)).toBe(true);
  });

  test("the Maker who files the report does not, nor does the Approver", () => {
    // The control this split exists to keep: the author of a report must not
    // sign it off, and the person who released the money must not certify that
    // it was spent.
    expect(hasPermission(PERMISSIONS_BY_ROLE.MAKER, IZIN)).toBe(false);
    expect(hasPermission(PERMISSIONS_BY_ROLE.APPROVER, IZIN)).toBe(false);
    expect(hasPermission(PERMISSIONS_BY_ROLE.AUDITOR, IZIN)).toBe(false);
  });

  test("it is a different code from filing an LPJ", () => {
    expect(hasPermission(PERMISSIONS_BY_ROLE.MAKER, "nonpumk.lpj")).toBe(true);
    expect(hasPermission(PERMISSIONS_BY_ROLE.CHECKER, "nonpumk.lpj")).toBe(false);
  });
});
