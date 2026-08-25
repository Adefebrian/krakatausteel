// Fase 3 PUMK screens, tested through the real App: the router, the session
// bootstrap, the permission gate and the page all take part, and the only
// thing replaced is the transport.
//
// The theme of this file is that a failure is never dressed up as data. The
// PUMK endpoints do not exist yet, so the FIRST test asserts what the screens
// do about that: an honest failure panel naming the endpoint, and no table of
// nothing pretending the list is empty.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";
import { clickOn, mount, textOf, typeInto } from "./testing";

// The banned long dash, written as an escape so this file stays clean itself.
const LONG_DASH = "\u2014";

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

/** What an unbuilt route actually answers today: Hono's plain text 404. */
function notFound(): Response {
  return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } });
}

const SESSION = {
  user: { id: "u2", username: "maker", nama: "Budi Santoso", role: "MAKER" },
  cabang: { id: "c1", kode: "01", nama: "Cabang Cilegon" },
  cabangTersedia: [{ id: "c1", kode: "01", nama: "Cabang Cilegon" }],
  periode: { tahun: 2026, bulan: 8, status: "OPEN" },
  permissions: ["dashboard.view", "pumk.view", "pumk.create", "pumk.survey"],
  roles: ["MAKER"],
  readOnly: false,
  lintasCabang: false,
};

const SESSION_APPROVER = {
  ...SESSION,
  user: { id: "u4", username: "approver", nama: "Rina Wijaya", role: "APPROVER" },
  permissions: ["dashboard.view", "pumk.view", "pumk.approve"],
  roles: ["APPROVER"],
};

const PROPOSAL_INTERNAL = {
  id: "p1",
  cabangId: "c1",
  noProposal: "PRP-2026-0001",
  tanggalProposal: "2026-08-01",
  mitraId: "m1",
  sektorId: "s1",
  jumlahDiajukan: "25000000.00",
  tenorDiajukan: 24,
  tujuanPenggunaan: "Tambahan modal bahan baku",
  sumberPengajuan: "INTERNAL",
  portalSubmissionId: null,
  status: "MENUNGGU_PERSETUJUAN",
  currentStep: 4,
  createdBy: "u2",
  mitraKode: "MB-001",
  mitraNama: "Anugerah Konveksi",
  mitraNik: "3671010101800001",
  sektorNama: "Perdagangan",
  cabangNama: "Cabang Cilegon",
  umurHari: 12,
};

const PROPOSAL_PORTAL = {
  ...PROPOSAL_INTERNAL,
  id: "p2",
  noProposal: "PRP-2026-0002",
  mitraKode: "MB-002",
  mitraNama: "Baraka Tani",
  mitraNik: "3671010101800002",
  jumlahDiajukan: "10000000.00",
  sumberPengajuan: "PORTAL_ONLINE",
  portalSubmissionId: "sub-9",
  status: "REVIEW_CHECKER",
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

describe("daftar proposal", () => {
  test("an endpoint that does not exist yet renders the failure panel, not an empty table", async () => {
    // The PUMK module has no HTTP surface at the time these screens were
    // built. That must look exactly like any other server failure: no stub
    // rows, no "belum ada data", and the endpoint named so it can be chased.
    at("/pumk/proposal");
    stubFetch((call) => (call.url.includes("/auth/session") ? json(200, SESSION) : notFound()));
    const view = await mount(<App />);

    const gagal = view.container.querySelector(".errorstate");
    expect(gagal).toBeTruthy();
    expect(textOf(gagal)).toContain("Gagal memuat daftar proposal");
    expect(textOf(gagal)).toContain("GET /api/pumk/proposal");
    // No table of nothing standing in for the answer that never came.
    expect(view.container.querySelector(".table-state-title")).toBeNull();
    expect(textOf(view.container)).not.toContain("Belum ada data");
    view.unmount();
  });

  test("the failure repeats the server's own status rather than inventing a reason", async () => {
    at("/pumk/proposal");
    stubFetch((call) =>
      call.url.includes("/auth/session")
        ? json(200, SESSION)
        : json(503, { error: "Basis data sedang tidak dapat diakses", code: "DB_DOWN" }),
    );
    const view = await mount(<App />);
    const gagal = textOf(view.container.querySelector(".errorstate"));
    expect(gagal).toContain("Basis data sedang tidak dapat diakses");
    expect(gagal).toContain("DB_DOWN");
    view.unmount();
  });

  test("the two tabs split one answer, so both counts are measured under the same filter", async () => {
    at("/pumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/proposal")) {
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

    // The internal tab is open first and shows only the internal proposal.
    expect(textOf(view.container.querySelector("tbody"))).toContain("Anugerah Konveksi");
    expect(textOf(view.container.querySelector("tbody"))).not.toContain("Baraka Tani");

    await clickOn(tabs[1]!);
    expect(textOf(view.container.querySelector("tbody"))).toContain("Baraka Tani");
    expect(textOf(view.container.querySelector("tbody"))).not.toContain("Anugerah Konveksi");
    view.unmount();
  });

  test("money is Indonesian, and the total is added without a float", async () => {
    at("/pumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/proposal")) {
        return json(200, { data: [PROPOSAL_INTERNAL, PROPOSAL_PORTAL] });
      }
      return notFound();
    });
    const view = await mount(<App />);

    expect(textOf(view.container.querySelector("tbody"))).toContain("25.000.000,00");
    // 25.000.000,00 plus 10.000.000,00 across BOTH tabs, added in integer cents.
    expect(textOf(view.container.querySelector(".tabs-note"))).toContain("35.000.000,00");
    view.unmount();
  });

  test("the search filter reaches the API as a query parameter, not a client side filter", async () => {
    at("/pumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/proposal")) return json(200, { data: [] });
      return notFound();
    });
    const view = await mount(<App />);

    const search = view.container.querySelector('input[type="search"]') as HTMLInputElement;
    await typeInto(search, "Baraka");
    await view.flush();

    const terakhir = calls.filter((call) => call.url.includes("/pumk/proposal")).at(-1);
    expect(terakhir?.url).toContain("cari=Baraka");
    expect(terakhir?.url).toContain("cabangId=c1");
    view.unmount();
  });
});

describe("halaman persetujuan", () => {
  const DETAIL = {
    proposal: PROPOSAL_INTERNAL,
    survey: {
      id: "sv1",
      proposalId: "p1",
      tanggalSurvey: "2026-08-05",
      petugasKaryawanId: "k1",
      skorTotal: "78.00",
      plafonRekomendasi: "20000000.00",
      tenorRekomendasi: 18,
      catatan: "Usaha berjalan, tempat usaha milik sendiri",
    },
    jaminan: [],
    timeline: [],
    review: {
      reviewerUserId: "u3",
      reviewerNama: "Sari Lestari",
      tanggal: "2026-08-07",
      keputusan: "REKOMENDASI",
      catatan: "Layak dengan plafon sesuai rekomendasi survey",
    },
    approval: null,
    akad: null,
  };

  function stubPersetujuan(session: unknown = SESSION_APPROVER) {
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, session);
      if (call.url.includes("/pumk/proposal/p1")) return json(200, DETAIL);
      if (call.url.includes("/pumk/batasan")) {
        return json(200, {
          plafonMin: "1000000.00",
          plafonMax: "50000000.00",
          tenorMin: 6,
          tenorMax: 36,
          gracePeriodMax: 3,
          wajibJaminanDiAtasPlafon: "20000000.00",
          maksPinjamanAktifPerMitra: 1,
          skorSurveyMinimumLolos: "60",
          jasaAdmRateDefault: "3.000000",
          jasaAdmMetodeDefault: "FLAT",
        });
      }
      return notFound();
    });
  }

  test("the approver can change the plafon, and the change is shown against what was asked for", async () => {
    // Spec 9.1: changing the plafon and the tenor at approval is normal
    // practice, so it is an editable field on this page and the difference is
    // visible while it is typed.
    at("/pumk/persetujuan?proposal=p1");
    stubPersetujuan();
    const view = await mount(<App />);

    const plafon = view.container.querySelector("#plafon-disetujui") as HTMLInputElement;
    expect(plafon).toBeTruthy();
    // Prefilled from the surveyor's recommendation, not from the request.
    expect(plafon.value).toBe("20.000.000,00");

    await typeInto(plafon, "15.000.000");
    await view.flush();

    const ringkas = textOf(view.container.querySelector(".form-aside"));
    // 15.000.000,00 approved against 25.000.000,00 requested.
    expect(ringkas).toContain("-10.000.000,00");
    expect(ringkas).toContain("lebih kecil dari yang diajukan");
    view.unmount();
  });

  test("the decision is submitted with the approved figures, not the requested ones", async () => {
    at("/pumk/persetujuan?proposal=p1");
    stubPersetujuan();
    const view = await mount(<App />);

    await typeInto(view.container.querySelector("#plafon-disetujui") as HTMLInputElement, "15000000");
    await typeInto(view.container.querySelector("#tenor-disetujui") as HTMLInputElement, "12");
    await view.flush();

    const setujui = [...view.container.querySelectorAll(".form-actions-row .btn")].at(-1)!;
    await clickOn(setujui);
    const konfirmasi = [...view.container.querySelectorAll(".modal-foot .btn")].at(-1)!;
    await clickOn(konfirmasi);

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/persetujuan"));
    expect(kirim).toBeTruthy();
    const body = JSON.parse(kirim?.body ?? "{}") as Record<string, unknown>;
    expect(body.keputusan).toBe("SETUJU");
    expect(body.plafonDisetujui).toBe("15000000.00");
    expect(body.tenorDisetujui).toBe(12);
    view.unmount();
  });

  test("an approver who reviewed the same proposal is warned before the click", async () => {
    // Spec 2 rule 2. The server refuses it too; this is the courtesy layer.
    at("/pumk/persetujuan?proposal=p1");
    stubPersetujuan({
      ...SESSION_APPROVER,
      user: { id: "u3", username: "checker", nama: "Sari Lestari", role: "APPROVER" },
    });
    const view = await mount(<App />);

    const peringatan = textOf(view.container.querySelector(".peringatan"));
    expect(peringatan).toContain("Checker proposal ini");
    const setujui = [...view.container.querySelectorAll(".form-actions-row .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(setujui.disabled).toBe(true);
    view.unmount();
  });

  test("a rejection cannot be sent without the note the state machine requires", async () => {
    at("/pumk/persetujuan?proposal=p1");
    stubPersetujuan();
    const view = await mount(<App />);

    const tolak = [...view.container.querySelectorAll(".keputusan-btn")].at(-1)!;
    await clickOn(tolak);
    const tombol = [...view.container.querySelectorAll(".form-actions-row .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(textOf(tombol)).toBe("Tolak");
    expect(tombol.disabled).toBe(true);
    view.unmount();
  });
});

describe("kartu piutang", () => {
  const KARTU = {
    mitra: {
      id: "m1",
      kodeMitra: "MB-001",
      namaLengkap: "Anugerah Konveksi",
      status: "AKTIF",
      clusterId: null,
    },
    akad: {
      id: "a1",
      proposalId: "p1",
      mitraId: "m1",
      cabangId: "c1",
      noAkad: "AKD-2026-0001",
      tanggalAkad: "2026-08-10",
      pokokPinjaman: "15000000.00",
      jasaAdmRate: "3.000000",
      metodePerhitungan: "FLAT",
      tenorBulan: 12,
      gracePeriodBulan: 0,
      tanggalMulaiAngsuran: "2026-09-10",
      tanggalJatuhTempoAkhir: "2027-08-10",
      status: "AKTIF",
      outstandingPokok: "13750000.00",
      outstandingJasa: "412500.00",
    },
    jadwal: [
      {
        akadId: "a1",
        versi: 1,
        isActiveVersion: true,
        baris: [
          {
            angsuranKe: 1,
            tanggalJatuhTempo: "2026-09-10",
            pokok: "1250000.00",
            jasaAdm: "37500.00",
            total: "1287500.00",
            saldoPokokSetelah: "13750000.00",
          },
        ],
        ringkasan: {
          totalPokok: "15000000.00",
          totalJasa: "450000.00",
          totalBayar: "15450000.00",
          angsuranPerBulan: "1287500.00",
          jumlahBaris: 12,
        },
        parameterTerpakai: {
          pokok: "15000000.00",
          rate: "3.000000",
          metode: "FLAT",
          tenorBulan: 12,
          gracePeriodBulan: 0,
          pembulatan: 0,
          jasaGrace: "TIDAK_DIHITUNG",
          basisHari: 360,
          hariJatuhTempoTetap: 0,
        },
      },
    ],
    setoran: [
      {
        id: "s1",
        tanggalTerima: "2026-09-10",
        jumlahDiterima: "1287500.00",
        alokasiPokok: "1250000.00",
        alokasiJasa: "37500.00",
        alokasiKelebihan: "0.00",
        jurnalId: "j1",
      },
    ],
    kelebihan: [],
    riwayatKolektibilitas: [{ periodeId: "2026-09", kelas: "LANCAR", hariTunggakan: 0 }],
    outstanding: { pokok: "13750000.00", jasa: "412500.00" },
    saldoBukuBesar: "13750000.00",
    selisihRekonsiliasi: "0.00",
  };

  test("shows outstanding, the ledger balance and the reconciliation on the first screen", async () => {
    at("/pumk/kartu-piutang/a1");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/kartu-piutang/a1")) return json(200, KARTU);
      return notFound();
    });
    const view = await mount(<App />);

    const bento = textOf(view.container.querySelector(".bento"));
    expect(bento).toContain("13.750.000,00");
    expect(bento).toContain("Saldo Buku Besar");
    expect(bento).toContain("Selisih rekonsiliasi");
    expect(bento).toContain("Cocok");
    // A genuine zero still prints as 0,00, which is what the accounting team
    // cross checks the reconciliation on.
    expect(bento).toContain("0,00");
    view.unmount();
  });

  test("a broken reconciliation is stated, not hidden behind a matching looking card", async () => {
    at("/pumk/kartu-piutang/a1");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/kartu-piutang/a1")) {
        return json(200, {
          ...KARTU,
          saldoBukuBesar: "13000000.00",
          selisihRekonsiliasi: "750000.00",
        });
      }
      return notFound();
    });
    const view = await mount(<App />);

    const peringatan = textOf(view.container.querySelector(".peringatan"));
    expect(peringatan).toContain("tidak cocok dengan Buku Besar");
    expect(peringatan).toContain("750.000,00");
    view.unmount();
  });

  test("every setoran is listed with its allocation, and the history is on the page", async () => {
    at("/pumk/kartu-piutang/a1");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/kartu-piutang/a1")) return json(200, KARTU);
      return notFound();
    });
    const view = await mount(<App />);

    const halaman = textOf(view.container);
    expect(halaman).toContain("Seluruh setoran");
    expect(halaman).toContain("1.287.500,00");
    expect(halaman).toContain("Riwayat kolektibilitas");
    expect(halaman).toContain("Lancar");
    view.unmount();
  });

  test("a failed read shows the failure, never a card of zeroes", async () => {
    at("/pumk/kartu-piutang/a1");
    stubFetch((call) => (call.url.includes("/auth/session") ? json(200, SESSION) : notFound()));
    const view = await mount(<App />);

    expect(textOf(view.container.querySelector(".errorstate"))).toContain(
      "Gagal memuat kartu piutang",
    );
    expect(view.container.querySelector(".bento")).toBeNull();
    view.unmount();
  });
});

describe("simulasi angsuran", () => {
  test("the calculator asks the engine rather than computing a second answer", async () => {
    at("/pumk/simulasi");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/simulasi")) {
        return json(200, {
          baris: [
            {
              angsuranKe: 1,
              tanggalJatuhTempo: "2026-09-25",
              pokok: "1000000.00",
              jasaAdm: "25000.00",
              total: "1025000.00",
              saldoPokokSetelah: "11000000.00",
            },
          ],
          ringkasan: {
            totalPokok: "12000000.00",
            totalJasa: "300000.00",
            totalBayar: "12300000.00",
            angsuranPerBulan: "1025000.00",
            jumlahBaris: 12,
          },
          parameterTerpakai: {
            pokok: "12000000.00",
            rate: "3.000000",
            metode: "FLAT",
            tenorBulan: 12,
            gracePeriodBulan: 0,
            pembulatan: 0,
            jasaGrace: "TIDAK_DIHITUNG",
            basisHari: 360,
            hariJatuhTempoTetap: 0,
          },
        });
      }
      return notFound();
    });
    const view = await mount(<App />);

    await typeInto(view.container.querySelector("#sim-pokok") as HTMLInputElement, "12.000.000");
    await view.flush();
    await clickOn([...view.container.querySelectorAll(".form-actions-row .btn")].at(-1)!);

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/pumk/simulasi"));
    const body = JSON.parse(kirim?.body ?? "{}") as Record<string, unknown>;
    expect(body.pokok).toBe("12000000.00");
    expect(body.rate).toBe("3.000000");
    expect(textOf(view.container)).toContain("1.025.000,00");
    view.unmount();
  });
});

describe("copy hygiene on the built pages", () => {
  test("no long dash and no emoji anywhere on a rendered PUMK page", async () => {
    at("/pumk/proposal");
    stubFetch((call) => {
      if (call.url.includes("/auth/session")) return json(200, SESSION);
      if (call.url.includes("/pumk/proposal")) {
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
