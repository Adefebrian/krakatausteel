// The two diagnostic screens of spec 9.6, tested through the real App.
//
// THE THEME OF THIS FILE IS THAT A DIAGNOSTIC PAGE HAS TO BE ACTIONABLE AND
// HAS TO STAY HARMLESS. So every assertion below is one of five kinds:
//
//   nine checks, all nine, every time, each with its verdict and its count;
//   a failure names the ROWS behind it, with their ids, because "3 failures"
//   with nowhere to look is a page nobody can act on;
//   a check that a database constraint already guards is EXPLAINED, so a
//   permanently green row does not read as a check that never runs;
//   a check whose rows carry no branch says why a branch filter did not narrow
//   it, so a working filter is not mistaken for a broken one;
//   nothing here writes: every call is a GET and there is no control that
//   looks like it repairs something.
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

/** One check row, addressed by the invariant the page names it with. */
function baris(container: HTMLElement, judul: string): HTMLElement {
  const hit = [...container.querySelectorAll(".prasyarat-item")].find((node) =>
    node.textContent?.includes(judul),
  );
  if (!hit) throw new Error(`baris pemeriksaan "${judul}" tidak ditemukan`);
  return hit as HTMLElement;
}

function semuaTombol(container: HTMLElement): string {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .join(" | ")
    .toLowerCase();
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

const SESSION_ADMIN = {
  ...DASAR,
  permissions: ["dashboard.view", "tools.integritas", "tools.rekonsiliasi"],
};

/** A Checker: reconciles, and does not hold the health check code. */
const SESSION_CHECKER = {
  ...DASAR,
  user: { id: "u2", username: "checker", nama: "Rina Wulandari", role: "CHECKER" },
  roles: ["CHECKER"],
  permissions: ["dashboard.view", "tools.rekonsiliasi"],
};

// ---------------------------------------------------------------------------
// Fixtures. Every shape is one the tools contract already names.
// ---------------------------------------------------------------------------

function cek(
  kode: string,
  nama: string,
  sumber: string,
  entitas: string,
  extra: Partial<{
    dijagaDatabase: boolean;
    terikatCabang: boolean;
    lulus: boolean;
    jumlah: number;
    detail: string;
    baris: unknown[];
    terpotong: boolean;
  }> = {},
) {
  return {
    kode,
    nama,
    sumber,
    entitas,
    dijagaDatabase: extra.dijagaDatabase ?? false,
    terikatCabang: extra.terikatCabang ?? true,
    lulus: extra.lulus ?? true,
    jumlah: extra.jumlah ?? 0,
    detail: extra.detail ?? "0 baris",
    baris: extra.baris ?? [],
    terpotong: extra.terpotong ?? false,
  };
}

const LAPORAN_INTEGRITAS = {
  dijalankanPada: "2026-03-20T04:00:00.000Z",
  cabangDiperiksa: ["c1", "c2"],
  sehat: false,
  hasil: [
    cek("JURNAL_TIDAK_BALANCE", "v_integritas_jurnal", "v_integritas_jurnal", "jurnal", {
      lulus: false,
      jumlah: 2,
      detail: "2 baris",
      baris: [
        {
          id: "jurnal-1",
          entitas: "jurnal",
          label: "JU-2026-03-0007",
          cabangId: "c1",
          fakta: {
            status: "POSTED",
            totalDebitBaris: "1500000.00",
            totalKreditBaris: "1400000.00",
            selisih: "100000.00",
          },
        },
        {
          id: "jurnal-2",
          entitas: "jurnal",
          label: "JU-2026-03-0011",
          cabangId: "c1",
          fakta: { status: "POSTED", selisih: "-50000.00", tanggalTransaksi: null },
        },
      ],
    }),
    cek("JADWAL_POKOK_TIDAK_COCOK", "v_integritas_jadwal", "v_integritas_jadwal", "pumk_akad"),
    cek(
      "SNAPSHOT_KOLEKTIBILITAS_GANDA",
      "v_integritas_snapshot",
      "v_integritas_snapshot",
      "kolektibilitas_snapshot",
      { dijagaDatabase: true },
    ),
    cek(
      "SUB_LEDGER_PIUTANG_TIDAK_COCOK",
      "v_rekonsiliasi_piutang",
      "v_rekonsiliasi_piutang",
      "pumk_akad",
    ),
    cek("TANGGA_KOLEKTIBILITAS", "tangga kolektibilitas", "kolektibilitas_range", "kolektibilitas_range", {
      terikatCabang: false,
    }),
    cek("JURNAL_DRAFT_DI_PERIODE_CLOSED", "jurnal draft", "jurnal", "jurnal"),
    cek("OUTSTANDING_POKOK_NEGATIF", "outstanding negatif", "pumk_akad", "pumk_akad", {
      dijagaDatabase: true,
    }),
    cek("PIUTANG_JASA_BERSALDO_KREDIT", "piutang jasa", "v_ledger_baris", "periode"),
    cek("NERACA_SALDO_TIDAK_SEIMBANG", "buku besar", "v_ledger_baris", "buku_besar", {
      detail: "debit Rp 10.000.000,00, kredit Rp 10.000.000,00, selisih Rp 0,00",
    }),
  ],
};

const LAPORAN_SEHAT = {
  ...LAPORAN_INTEGRITAS,
  sehat: true,
  hasil: LAPORAN_INTEGRITAS.hasil.map((h) =>
    h.kode === "JURNAL_TIDAK_BALANCE"
      ? { ...h, lulus: true, jumlah: 0, detail: "0 baris", baris: [] }
      : h,
  ),
};

const REKONSILIASI = {
  dijalankanPada: "2026-03-20T04:00:00.000Z",
  akunPiutangId: "akun-1",
  akunPiutangKode: "1.1.03",
  cocok: false,
  jumlahAkadDiperiksa: 14,
  jumlahAkadSelisih: 2,
  totalSubLedger: "128000000.00",
  totalBukuBesar: "127500000.00",
  totalSelisih: "500000.00",
  perCabang: [
    {
      cabangId: "c1",
      kodeCabang: "01",
      namaCabang: "Cabang Cilegon",
      jumlahAkad: 9,
      jumlahAkadSelisih: 1,
      totalSubLedger: "90000000.00",
      totalBukuBesar: "89400000.00",
      totalSelisih: "600000.00",
    },
    {
      cabangId: "c2",
      kodeCabang: "02",
      namaCabang: "Cabang Serang",
      jumlahAkad: 5,
      jumlahAkadSelisih: 1,
      totalSubLedger: "38000000.00",
      totalBukuBesar: "38100000.00",
      totalSelisih: "-100000.00",
    },
  ],
  baris: [
    {
      akadId: "akad-1",
      noAkad: "AK-2026-0001",
      cabangId: "c1",
      mitraId: "m1",
      namaMitra: "Warung Bu Sri",
      statusAkad: "AKTIF",
      saldoSubLedger: "12000000.00",
      saldoBukuBesar: "11400000.00",
      selisih: "600000.00",
    },
    {
      akadId: "akad-2",
      noAkad: "AK-2026-0002",
      cabangId: "c2",
      mitraId: "m2",
      namaMitra: "Bengkel Jaya",
      statusAkad: "AKTIF",
      saldoSubLedger: "8000000.00",
      saldoBukuBesar: "8100000.00",
      selisih: "-100000.00",
    },
  ],
  terpotong: false,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface Pilihan {
  session?: unknown;
  integritas?: unknown;
  rekonsiliasi?: unknown;
  gagalRekonsiliasi?: boolean;
}

function handler(pilihan: Pilihan = {}) {
  return (call: Call): Response => {
    const { url } = call;
    if (url.includes("/auth/session")) return json(200, pilihan.session ?? SESSION_ADMIN);
    if (url.includes("/tools/integritas")) {
      return json(200, pilihan.integritas ?? LAPORAN_INTEGRITAS);
    }
    if (url.includes("/tools/rekonsiliasi/piutang")) {
      if (pilihan.gagalRekonsiliasi) {
        return json(409, {
          error: "Pemetaan akun piutang PUMK belum diatur",
          kode: "MAPPING_PIUTANG_TIDAK_ADA",
        });
      }
      return json(200, pilihan.rekonsiliasi ?? REKONSILIASI);
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
// Cek Integritas
// ---------------------------------------------------------------------------

describe("Cek Integritas: nine checks, and a finding you can chase", () => {
  test("all nine checks are listed, the passing ones included", async () => {
    const { mount } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(view.container.querySelectorAll(".prasyarat-item").length).toBe(9);
    view.unmount();
  });

  test("a failure names its rows, with their ids and their figures", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(baris(view.container, "Setiap jurnal seimbang debit dan kredit"));
    expect(teks).toContain("Ada temuan");
    expect(teks).toContain("JU-2026-03-0007");
    expect(teks).toContain("jurnal-1");
    expect(teks).toContain("100.000,00");
    expect(teks).toContain("jurnal bermasalah");
    view.unmount();
  });

  test("an absent fact prints as absent, never as the money marker", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(baris(view.container, "Setiap jurnal seimbang debit dan kredit"));
    // The second row carries `tanggalTransaksi: null`.
    expect(teks).toContain("tanggalTransaksi tidak ada");
    expect(teks).not.toContain("tidak sah");
    view.unmount();
  });

  test("a check a database constraint already guards explains its permanent green", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler());
    const view = await mount(<App />);

    const dijaga = textOf(baris(view.container, "Tidak ada snapshot kolektibilitas ganda"));
    expect(dijaga).toContain("dijaga constraint database");
    expect(dijaga).toContain("Lolos");

    const negatif = textOf(baris(view.container, "Tidak ada akad dengan outstanding pokok negatif"));
    expect(negatif).toContain("dijaga constraint database");

    // And a check that is NOT guarded says nothing of the kind.
    expect(textOf(baris(view.container, "Total pokok jadwal sama dengan pokok akad"))).not.toContain(
      "dijaga constraint database",
    );
    view.unmount();
  });

  test("the check with no branch on its rows says why a branch filter did not narrow it", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas?cabang=c1");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(baris(view.container, "Tangga hari kolektibilitas"));
    expect(teks).toContain("tidak memiliki cabang");
    expect(teks).toContain("Filter cabang di atas tidak mempersempit");
    view.unmount();
  });

  test("the branch filter narrows the request and is never the authority", async () => {
    const { mount } = await import("./testing");
    at("/tools/integritas?cabang=c2");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(calls.some((c) => c.url.includes("/tools/integritas?cabangId=c2"))).toBe(true);
    view.unmount();
  });

  test("the page diagnoses and offers nothing that repairs", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const tombol = semuaTombol(view.container);
    expect(tombol).not.toContain("perbaiki");
    expect(tombol).not.toContain("hapus");
    expect(tombol).not.toContain("jalankan");
    expect(textOf(view.container)).toContain("Tidak ada tombol perbaikan di sini");
    view.unmount();
  });

  test("a clean run says so without hiding the checks that ran", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler({ integritas: LAPORAN_SEHAT }));
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Sehat");
    expect(view.container.querySelectorAll(".prasyarat-item").length).toBe(9);
    view.unmount();
  });

  test("a Checker without tools.integritas is refused the page, not shown an empty one", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/integritas");
    stubFetch(handler({ session: SESSION_CHECKER }));
    const view = await mount(<App />);

    expect(calls.some((c) => c.url.includes("/tools/integritas"))).toBe(false);
    expect(textOf(view.container)).toContain("tidak memiliki hak akses");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Rekonsiliasi
// ---------------------------------------------------------------------------

describe("Rekonsiliasi piutang: the per akad difference is the product", () => {
  test("every akad with a difference is listed with both balances and the signed gap", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/rekonsiliasi");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("AK-2026-0001");
    expect(teks).toContain("Warung Bu Sri");
    expect(teks).toContain("12.000.000,00");
    expect(teks).toContain("11.400.000,00");
    expect(teks).toContain("600.000,00");
    // A difference the other way is shown as such, in accounting parentheses.
    expect(teks).toContain("(100.000,00)");
    view.unmount();
  });

  test("the per cabang summary is context under the akad list, not a substitute for it", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/rekonsiliasi");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Akad penyebab selisih");
    expect(teks).toContain("Ringkasan per cabang");
    expect(teks.indexOf("Akad penyebab selisih")).toBeLessThan(teks.indexOf("Ringkasan per cabang"));
    expect(teks).toContain("1 dari 9");
    view.unmount();
  });

  test("the account it reconciled against is named, read from the event mapping", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/rekonsiliasi");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("1.1.03");
    expect(teks).toContain("pemetaan event pencairan PUMK");
    view.unmount();
  });

  test("the default asks for differences only, and the toggle asks for everything", async () => {
    const { mount } = await import("./testing");
    at("/tools/rekonsiliasi");
    stubFetch(handler());
    const bawaan = await mount(<App />);
    expect(calls.some((c) => c.url.includes("hanyaSelisih"))).toBe(false);
    bawaan.unmount();

    at("/tools/rekonsiliasi?akad=semua");
    stubFetch(handler());
    const semua = await mount(<App />);
    expect(calls.some((c) => c.url.includes("hanyaSelisih=false"))).toBe(true);
    semua.unmount();
  });

  test("a refusal from the server is shown as the server's own sentence, not as zero difference", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/rekonsiliasi");
    stubFetch(handler({ gagalRekonsiliasi: true }));
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Gagal memuat hasil rekonsiliasi piutang");
    expect(teks).toContain("Pemetaan akun piutang PUMK belum diatur");
    expect(teks).not.toContain("Cocok");
    view.unmount();
  });

  test("nothing here writes, and the copy carries no long dash", async () => {
    const { mount, textOf } = await import("./testing");
    at("/tools/rekonsiliasi");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(semuaTombol(view.container)).not.toContain("perbaiki");
    expect(textOf(view.container)).not.toContain(LONG_DASH);
    view.unmount();
  });
});
