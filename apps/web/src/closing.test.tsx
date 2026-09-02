// The monthly close (spec 8, spec 9.3), tested through the real App. The
// router, the session bootstrap, the permission gate and the pages all take
// part, and the only thing replaced is the transport.
//
// THE THEME OF THIS FILE IS THAT THE EVIDENCE AND THE ACT ARE TWO DIFFERENT
// THINGS. A closing screen is read by somebody deciding whether to close, and
// by somebody checking, months later, how a month WAS closed. Those readers
// must see the same figures, and exactly one of them may press a button. So
// every assertion below is one of four kinds:
//
//   the evidence is reachable with `admin.closing.view` alone, which is the
//   Auditor's read only code and the whole reason it exists;
//   a write control is ABSENT for a viewer, and its absence is a convenience
//   the server enforces again rather than the control itself;
//   a failed prerequisite arrives as a SENTENCE and the rows behind it, never
//   as a colour, because a blocked close with nowhere to look is the failure
//   spec 16 scenario 12 names;
//   the two dangerous acts, the close and the reopen, cannot happen without a
//   deliberate confirmation, and the negative cash warning is a SECOND,
//   separate acknowledgement rather than the same one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "./App";

/** The banned long dash, built from its code point so this file stays clean. */
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

function tombol(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

function cariTombol(container: HTMLElement, teks: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(teks));
}

function cariAksiModal(container: HTMLElement, teks: string): HTMLButtonElement {
  return [...container.querySelectorAll(".modal-foot button")].find((b) =>
    b.textContent?.includes(teks),
  ) as HTMLButtonElement;
}

// ---------------------------------------------------------------------------
// Sessions. Three readers, three authorities.
// ---------------------------------------------------------------------------

const CABANG = { id: "c1", kode: "01", nama: "Cabang Cilegon" };

const DASAR = {
  user: { id: "u1", username: "adminpusat", nama: "Sri Handayani", role: "ADMIN_PUSAT" },
  cabang: CABANG,
  cabangTersedia: [CABANG],
  periode: { tahun: 2026, bulan: 3, status: "OPEN" },
  roles: ["ADMIN_PUSAT"],
  readOnly: false,
  lintasCabang: true,
};

/** Admin Pusat: every closing code, including the reopen nobody else holds. */
const SESSION_PUSAT = {
  ...DASAR,
  permissions: [
    "dashboard.view",
    "jurnal.view",
    "laporan.view",
    "admin.closing.view",
    "admin.closing.kolektibilitas",
    "admin.closing.periode",
    "admin.periode.reopen",
  ],
};

/** Approver: closes a month, and may NOT reopen one. Spec 2's asymmetry. */
const SESSION_APPROVER = {
  ...DASAR,
  user: { id: "u2", username: "approver", nama: "Rina Wulandari", role: "APPROVER" },
  roles: ["APPROVER"],
  permissions: [
    "dashboard.view",
    "jurnal.view",
    "laporan.view",
    "admin.closing.view",
    "admin.closing.kolektibilitas",
    "admin.closing.periode",
  ],
};

/** Auditor: `admin.closing.view` and not one code that can run anything. */
const SESSION_AUDITOR = {
  ...DASAR,
  user: { id: "u3", username: "auditor", nama: "Bagus Prasetya", role: "AUDITOR" },
  roles: ["AUDITOR"],
  readOnly: true,
  permissions: ["dashboard.view", "jurnal.view", "laporan.view", "admin.closing.view"],
};

// ---------------------------------------------------------------------------
// Fixtures. Every shape is one the closing contract already names.
// ---------------------------------------------------------------------------

const REFERENSI = {
  cabang: [CABANG],
  bolehSemuaCabang: true,
  kapabilitas: {
    izinkanReopen: true,
    metodePengakuanJasa: "ACCRUAL",
    kelasDiakrual: ["LANCAR", "KURANG_LANCAR"],
    modePenyisihan: "RATE_TABLE",
    dasarPerhitunganPenyisihan: "OUTSTANDING_POKOK",
    izinkanSaldoKasNegatif: false,
  },
};

const PERIODE_OPEN = {
  id: "p-open",
  tahun: 2026,
  bulan: 3,
  tanggalMulai: "2026-03-01",
  tanggalAkhir: "2026-03-31",
  status: "OPEN",
  closedBy: null,
  closedOleh: null,
  closedAt: null,
  reopenedBy: null,
  dibukaKembaliOleh: null,
  reopenedAt: null,
  alasanReopen: null,
  templateLaporanId: null,
  jumlahSaldoBeku: 0,
};

const PERIODE_CLOSED = {
  id: "p-closed",
  tahun: 2026,
  bulan: 2,
  tanggalMulai: "2026-02-01",
  tanggalAkhir: "2026-02-28",
  status: "CLOSED",
  closedBy: "u9",
  closedOleh: "Sri Handayani",
  closedAt: "2026-03-05",
  reopenedBy: null,
  dibukaKembaliOleh: null,
  reopenedAt: null,
  alasanReopen: null,
  templateLaporanId: "t1",
  jumlahSaldoBeku: 42,
};

const DAFTAR_PERIODE = { data: [PERIODE_OPEN, PERIODE_CLOSED] };

/** The ten checks, in spec order, all passing unless a test replaces one. */
const KODE_PRASYARAT = [
  "PERIODE_SEBELUMNYA_BELUM_CLOSED",
  "ADA_JURNAL_DRAFT",
  "JURNAL_TIDAK_BALANCE",
  "KOLEKTIBILITAS_BELUM_DIJALANKAN",
  "PENYISIHAN_BELUM_POSTED",
  "AKRUAL_BELUM_POSTED",
  "NERACA_LAJUR_TIDAK_BALANCE",
  "SALDO_KAS_NEGATIF",
  "OUTSTANDING_POKOK_NEGATIF",
  "SUB_LEDGER_TIDAK_COCOK",
] as const;

interface HasilPrasyaratUji {
  nomor: number;
  kode: string;
  status: string;
  alasan: string;
  detail: Record<string, unknown>;
}

function prasyarat(
  ganti: Record<string, { status: string; alasan: string; detail: Record<string, unknown> }> = {},
) {
  const hasil: HasilPrasyaratUji[] = KODE_PRASYARAT.map((kode, index) => {
    const timpa = ganti[kode];
    return {
      nomor: index + 1,
      kode,
      status: timpa?.status ?? "PASS",
      alasan: timpa?.alasan ?? `Pemeriksaan ${kode} lolos untuk periode Maret 2026.`,
      detail: timpa?.detail ?? {},
    };
  });
  return {
    periodeId: "p-open",
    tahun: 2026,
    bulan: 3,
    boleh: hasil.every((h) => h.status !== "GAGAL"),
    perluKonfirmasi: hasil.some((h) => h.status === "PERINGATAN"),
    hasil,
  };
}

const PRASYARAT_SIAP = prasyarat();

const PRASYARAT_GAGAL = prasyarat({
  ADA_JURNAL_DRAFT: {
    status: "GAGAL",
    alasan:
      "Masih ada 2 jurnal berstatus draft bertanggal di periode Maret 2026: JU-2026-03-0007, JU-2026-03-0011. Posting atau batalkan dulu jurnal itu.",
    detail: {
      jurnal: [
        { id: "j1", noJurnal: "JU-2026-03-0007", tanggal: "2026-03-14" },
        { id: "j2", noJurnal: "JU-2026-03-0011", tanggal: "2026-03-22" },
      ],
    },
  },
});

const PRASYARAT_PERINGATAN = prasyarat({
  SALDO_KAS_NEGATIF: {
    status: "PERINGATAN",
    alasan:
      "Saldo kas dan setara kas di akhir periode Maret 2026 negatif pada 1 akun (Kas Kecil Cabang Cilegon -1.250.000,00). Closing tetap bisa dilanjutkan, tetapi kondisi ini wajib dikonfirmasi lebih dulu.",
    detail: {
      izinkanKasNegatif: false,
      akun: [{ kode: "1101", nama: "Kas Kecil Cabang Cilegon", saldo: "-1250000.00" }],
    },
  },
});

const SNAPSHOT = {
  data: [
    {
      akadId: "a1",
      noAkad: "AK-2026-0001",
      mitraId: "m1",
      cabangId: "c1",
      sektorId: "s1",
      tanggalJatuhTempoTertunggakTertua: null,
      hariTunggakan: 0,
      kolektibilitas: "LANCAR",
      kolektibilitasPeriodeLalu: "LANCAR",
      outstandingPokok: "12000000.00",
      outstandingJasa: "360000.00",
      tunggakanPokok: "0.00",
      tunggakanJasa: "0.00",
      ratePenyisihan: "1.000000",
      dasarPerhitungan: "OUTSTANDING_POKOK",
      sumberRate: "TABEL_KONFIGURASI",
      nilaiPenyisihan: "120000.00",
    },
    {
      akadId: "a2",
      noAkad: "AK-2026-0002",
      mitraId: "m2",
      cabangId: "c1",
      sektorId: "s2",
      tanggalJatuhTempoTertunggakTertua: "2025-11-10",
      hariTunggakan: 265,
      kolektibilitas: "MACET",
      kolektibilitasPeriodeLalu: "DIRAGUKAN",
      outstandingPokok: "8000000.00",
      outstandingJasa: "240000.00",
      tunggakanPokok: "8000000.00",
      tunggakanJasa: "240000.00",
      ratePenyisihan: "100.000000",
      dasarPerhitungan: "OUTSTANDING_POKOK",
      sumberRate: "TABEL_KONFIGURASI",
      nilaiPenyisihan: "8000000.00",
    },
  ],
};

const RIWAYAT = {
  data: [
    {
      id: "run1",
      periodeId: "p-open",
      cabangId: null,
      tanggalJalan: "2026-04-02",
      status: "SELESAI",
      dijalankanOleh: "Rina Wulandari",
      totalAkadDiproses: 2,
    },
  ],
};

const PRATINJAU = {
  tersimpan: false,
  periodeId: "p-open",
  cabangId: null,
  tanggalAkhirPeriode: "2026-03-31",
  modePenyisihan: "RATE_TABLE",
  dasarPerhitungan: "OUTSTANDING_POKOK",
  totalAkadDiproses: 2,
  baris: SNAPSHOT.data,
  matriks: [
    { dari: "LANCAR", ke: "LANCAR", jumlahAkad: 1, outstandingPokok: "12000000.00" },
    { dari: "DIRAGUKAN", ke: "MACET", jumlahAkad: 1, outstandingPokok: "8000000.00" },
  ],
  ringkasanPerKelas: [
    {
      kelas: "LANCAR",
      jumlahAkad: 1,
      outstandingPokok: "12000000.00",
      nilaiPenyisihan: "120000.00",
    },
    { kelas: "MACET", jumlahAkad: 1, outstandingPokok: "8000000.00", nilaiPenyisihan: "8000000.00" },
  ],
  totalPenyisihanDibutuhkan: "8120000.00",
};

const HASIL_RUN = {
  ...PRATINJAU,
  tersimpan: true,
  closingId: "run2",
  mitraDitandaiBermasalah: ["m2"],
  menggantikanRunSebelumnya: true,
};

const SALDO = {
  data: [
    {
      periodeId: "p-closed",
      cabangId: "c1",
      akunId: "ak1",
      akunKode: "1101",
      saldoAwal: "5000000.00",
      mutasiDebit: "2000000.00",
      mutasiKredit: "1000000.00",
      saldoAkhir: "6000000.00",
    },
    {
      periodeId: "p-closed",
      cabangId: "c1",
      akunId: "ak2",
      akunKode: "3101",
      saldoAwal: "-5000000.00",
      mutasiDebit: "1000000.00",
      mutasiKredit: "2000000.00",
      saldoAkhir: "-6000000.00",
    },
  ],
};

const PENYISIHAN = {
  data: [
    {
      id: null,
      periodeId: "p-open",
      cabangId: "c1",
      saldoPenyisihanAwal: "6920000.00",
      penyisihanDibutuhkan: "8120000.00",
      bebanPenyisihanPeriode: "1200000.00",
      eventCode: "BEBAN_PENYISIHAN",
      jurnal: [],
      jurnalId: null,
      tanggal: "2026-03-31",
    },
  ],
};

const PENYISIHAN_POSTED = {
  data: [
    {
      ...PENYISIHAN.data[0],
      id: "pp1",
      jurnal: [{ jurnalId: "j-900", nilai: "1200000.00" }],
      jurnalId: "j-900",
    },
  ],
};

const AKRUAL = {
  periodeId: "p-open",
  metode: "ACCRUAL",
  kelasDiakrual: ["LANCAR", "KURANG_LANCAR"],
  dilewati: false,
  baris: [
    {
      akadId: "a1",
      noAkad: "AK-2026-0001",
      cabangId: "c1",
      kolektibilitas: "LANCAR",
      jasaJatuhTempoPeriode: "360000.00",
      jasaDiterimaPeriode: "120000.00",
      jasaDiakrual: "240000.00",
    },
  ],
  totalPerCabang: [{ cabangId: "c1", total: "240000.00", jurnalId: "j-901" }],
};

const AKRUAL_DILEWATI = {
  ...AKRUAL,
  metode: "CASH_BASIS",
  dilewati: true,
  baris: [],
  totalPerCabang: [],
};

const HASIL_TUTUP = {
  periode: { ...PERIODE_OPEN, status: "CLOSED", closedBy: "u1", closedAt: "2026-04-02" },
  prasyarat: PRASYARAT_SIAP,
  saldo: SALDO.data,
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface Pilihan {
  session?: unknown;
  prasyarat?: unknown;
  penyisihan?: unknown;
  akrual?: unknown;
  saldo?: unknown;
  snapshot?: unknown;
}

function handler(pilihan: Pilihan = {}) {
  return (call: Call): Response => {
    const { url, method } = call;
    if (url.includes("/auth/session")) return json(200, pilihan.session ?? SESSION_PUSAT);
    if (url.includes("/closing/referensi")) return json(200, REFERENSI);

    if (url.includes("/kolektibilitas/pratinjau")) return json(200, PRATINJAU);
    if (url.includes("/kolektibilitas/riwayat")) return json(200, RIWAYAT);
    if (url.includes("/kolektibilitas/snapshot")) return json(200, pilihan.snapshot ?? SNAPSHOT);
    if (url.includes("/kolektibilitas") && method === "POST") return json(201, HASIL_RUN);

    if (url.includes("/penyisihan/pratinjau")) return json(200, pilihan.penyisihan ?? PENYISIHAN);
    if (url.includes("/penyisihan")) return json(201, PENYISIHAN_POSTED);
    if (url.includes("/akrual")) return json(201, pilihan.akrual ?? AKRUAL);
    if (url.includes("/tutup")) return json(200, HASIL_TUTUP);
    if (url.includes("/buka")) return json(200, { ...PERIODE_CLOSED, status: "OPEN" });

    if (url.includes("/prasyarat")) return json(200, pilihan.prasyarat ?? PRASYARAT_SIAP);
    if (url.includes("/saldo")) return json(200, pilihan.saldo ?? SALDO);
    if (url.includes("/closing/periode")) return json(200, DAFTAR_PERIODE);
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
// The period register
// ---------------------------------------------------------------------------

describe("Periode Akuntansi: the register, and what a closed month leaves behind", () => {
  test("every period is listed with its status and who closed it", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Maret 2026");
    expect(teks).toContain("Februari 2026");
    expect(teks).toContain("Sri Handayani");
    expect(teks).toContain("05-03-2026");
    view.unmount();
  });

  test("the branch scope and the accounting policies come from the server, not from the page", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("01 Cabang Cilegon");
    expect(teks).toContain("Tabel rate per kolektibilitas");
    expect(teks).toContain("Outstanding pokok");
    view.unmount();
  });

  test("the frozen balances of a closed period are readable, and an open one says why it has none", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch(handler());
    const tutup = await mount(<App />);
    expect(textOf(tutup.container)).toContain("Saldo akun beku periode Februari 2026");
    // The server's own figures, formatted by packages/ui, negatives in
    // accounting parentheses.
    expect(textOf(tutup.container)).toContain("6.000.000,00");
    expect(textOf(tutup.container)).toContain("(6.000.000,00)");
    tutup.unmount();

    at("/admin/periode?periode=p-open");
    stubFetch(handler());
    const buka = await mount(<App />);
    expect(textOf(buka.container)).toContain("Periode ini belum ditutup");
    expect(calls.some((call) => call.url.includes("/closing/periode/p-open/saldo"))).toBe(false);
    buka.unmount();
  });

  test("a closed period holding no frozen balance is named as the problem it is", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch(handler({ saldo: { data: [] } }));
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Periode tertutup tanpa satu baris saldo beku");
    view.unmount();
  });

  test("an Auditor reads the whole register and is offered no control that writes", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch(handler({ session: SESSION_AUDITOR }));
    const view = await mount(<App />);

    // The evidence is all there.
    expect(textOf(view.container)).toContain("Saldo akun beku periode Februari 2026");
    expect(textOf(view.container)).toContain("Sri Handayani");
    // And the reopen is named as somebody else's authority, not hidden.
    expect(textOf(view.container)).toContain("Reopen adalah tindakan Admin Pusat");
    expect(view.container.querySelector("#reopen-alasan")).toBeNull();
    expect(tombol(view.container).some((t) => t.includes("Buka kembali periode"))).toBe(false);
    view.unmount();
  });

  test("an Approver may close a month and still may not reopen one", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch(handler({ session: SESSION_APPROVER }));
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Reopen adalah tindakan Admin Pusat");
    expect(tombol(view.container).some((t) => t.includes("Buka kembali periode"))).toBe(false);
    view.unmount();
  });
});

describe("Periode Akuntansi: reopen cannot happen by reflex", () => {
  test("the button stays shut until a real reason is written", async () => {
    const { mount, typeIntoTextarea } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch(handler());
    const view = await mount(<App />);

    const buka = cariTombol(view.container, "Buka kembali periode");
    expect(buka).toBeTruthy();
    expect(buka?.disabled).toBe(true);

    const alasan = view.container.querySelector("#reopen-alasan") as HTMLTextAreaElement;
    await typeIntoTextarea(alasan, "salah");
    await view.flush();
    expect(cariTombol(view.container, "Buka kembali periode")?.disabled).toBe(true);

    await typeIntoTextarea(alasan, "Koreksi jurnal penyaluran yang tertinggal");
    await view.flush();
    expect(cariTombol(view.container, "Buka kembali periode")?.disabled).toBe(false);
    view.unmount();
  });

  test("the confirmation states what will happen, and nothing is sent until the phrase is typed", async () => {
    const { mount, clickOn, typeInto, typeIntoTextarea, textOf } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch(handler());
    const view = await mount(<App />);

    const alasan = view.container.querySelector("#reopen-alasan") as HTMLTextAreaElement;
    await typeIntoTextarea(alasan, "Koreksi jurnal penyaluran yang tertinggal");
    await view.flush();
    await clickOn(cariTombol(view.container, "Buka kembali periode") as Element);

    const dialog = textOf(view.container.querySelector(".modal-panel"));
    expect(dialog).toContain("Status setelah tindakan");
    expect(dialog).toContain("42 baris");
    expect(dialog).toContain("Koreksi jurnal penyaluran yang tertinggal");

    const konfirmasi = cariAksiModal(view.container, "Ya, buka kembali periode");
    expect(konfirmasi.disabled).toBe(true);
    await clickOn(konfirmasi);
    expect(calls.some((call) => call.url.includes("/buka"))).toBe(false);

    await typeInto(
      view.container.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "BUKA KEMBALI",
    );
    await view.flush();
    await clickOn(cariAksiModal(view.container, "Ya, buka kembali periode"));

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/buka"));
    expect(kirim).toBeTruthy();
    expect(kirim?.url).toContain("/closing/periode/p-closed/buka");
    expect(JSON.parse(kirim?.body ?? "{}")).toEqual({
      alasan: "Koreksi jurnal penyaluran yang tertinggal",
    });
    view.unmount();
  });

  test("a configuration that forbids reopen is stated, and the form is not offered", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/periode?periode=p-closed");
    stubFetch((call) =>
      call.url.includes("/closing/referensi")
        ? json(200, {
            ...REFERENSI,
            kapabilitas: { ...REFERENSI.kapabilitas, izinkanReopen: false },
          })
        : handler()(call),
    );
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Reopen dimatikan pada konfigurasi");
    expect(view.container.querySelector("#reopen-alasan")).toBeNull();
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// The checklist and the close
// ---------------------------------------------------------------------------

describe("Closing Periode: the checklist is the screen", () => {
  test("all ten checks render, whatever their state, in spec order", async () => {
    const { mount } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler({ prasyarat: PRASYARAT_GAGAL }));
    const view = await mount(<App />);

    expect(view.container.querySelectorAll(".prasyarat-item").length).toBe(10);
    const nomor = [...view.container.querySelectorAll(".prasyarat-nomor")].map(
      (n) => n.textContent,
    );
    expect(nomor).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    view.unmount();
  });

  test("a failed check explains itself in Indonesian and names the rows that caused it", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler({ prasyarat: PRASYARAT_GAGAL }));
    const view = await mount(<App />);

    const gagal = view.container.querySelector(".prasyarat-item.is-gagal");
    expect(gagal).toBeTruthy();
    const teks = textOf(gagal);
    // The sentence, not a colour.
    expect(teks).toContain("Masih ada 2 jurnal berstatus draft");
    expect(teks).toContain("Posting atau batalkan dulu jurnal itu");
    // The figure behind it, named.
    expect(teks).toContain("Jurnal berstatus draft");
    // And the offending journals, so the close is not blocked with nowhere to look.
    expect(teks).toContain("JU-2026-03-0007");
    expect(teks).toContain("JU-2026-03-0011");
    view.unmount();
  });

  test("the close button is shut while a check fails, and the page says the server checks again", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler({ prasyarat: PRASYARAT_GAGAL }));
    const view = await mount(<App />);

    expect(cariTombol(view.container, "Tutup periode")?.disabled).toBe(true);
    expect(textOf(view.container)).toContain("Masih ada pemeriksaan yang gagal");
    view.unmount();
  });

  test("nothing is sent to the close endpoint until the phrase is typed", async () => {
    const { mount, clickOn, typeInto, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler());
    const view = await mount(<App />);

    const buka = cariTombol(view.container, "Tutup periode");
    expect(buka?.disabled).toBe(false);
    await clickOn(buka as Element);

    const dialog = textOf(view.container.querySelector(".modal-panel"));
    expect(dialog).toContain("Yang dibekukan");
    expect(dialog).toContain("Status setelah tindakan");
    expect(dialog).toContain("server memeriksa ulang seluruh checklist");

    const konfirmasi = cariAksiModal(view.container, "Ya, tutup periode");
    expect(konfirmasi.disabled).toBe(true);
    await clickOn(konfirmasi);
    expect(calls.some((call) => call.url.includes("/tutup"))).toBe(false);

    await typeInto(
      view.container.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "TUTUP PERIODE",
    );
    await view.flush();
    await clickOn(cariAksiModal(view.container, "Ya, tutup periode"));

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/tutup"));
    expect(kirim?.url).toContain("/closing/periode/p-open/tutup");
    expect(JSON.parse(kirim?.body ?? "{}")).toEqual({ konfirmasiKasNegatif: false });
    view.unmount();
  });

  test("a negative cash warning is a second acknowledgement, and it is what reaches the server", async () => {
    const { mount, clickOn, typeInto, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler({ prasyarat: PRASYARAT_PERINGATAN }));
    const view = await mount(<App />);

    // The warning does not block the close, it blocks it UNTIL it is confirmed.
    expect(textOf(view.container)).toContain("Kondisi yang wajib Anda konfirmasi");
    expect(textOf(view.container)).toContain("Kas Kecil Cabang Cilegon");
    expect(cariTombol(view.container, "Tutup periode")?.disabled).toBe(true);

    const centang = view.container.querySelector(
      ".konfirmasi-kas input[type=checkbox]",
    ) as HTMLInputElement;
    await clickOn(centang);
    expect(cariTombol(view.container, "Tutup periode")?.disabled).toBe(false);

    await clickOn(cariTombol(view.container, "Tutup periode") as Element);
    await typeInto(
      view.container.querySelector("#confirm-phrase-input") as HTMLInputElement,
      "TUTUP PERIODE",
    );
    await view.flush();
    await clickOn(cariAksiModal(view.container, "Ya, tutup periode"));

    const kirim = calls.find((call) => call.method === "POST" && call.url.includes("/tutup"));
    expect(JSON.parse(kirim?.body ?? "{}")).toEqual({ konfirmasiKasNegatif: true });
    view.unmount();
  });

  test("a viewer holding only admin.closing.view reads the checklist and gets no write control", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler({ session: SESSION_AUDITOR, prasyarat: PRASYARAT_GAGAL }));
    const view = await mount(<App />);

    // Every one of the ten is there, with its reason.
    expect(view.container.querySelectorAll(".prasyarat-item").length).toBe(10);
    expect(textOf(view.container)).toContain("Masih ada 2 jurnal berstatus draft");

    const labels = tombol(view.container);
    expect(labels.some((t) => t.includes("Tutup periode"))).toBe(false);
    expect(labels.some((t) => t.includes("Jalankan dan posting"))).toBe(false);
    expect(labels.some((t) => t.includes("Hitung tanpa memposting"))).toBe(false);
    expect(labels.some((t) => t.includes("Jalankan akrual"))).toBe(false);
    expect(textOf(view.container)).toContain("Eksekusi closing bukan kewenangan Anda");
    view.unmount();
  });
});

describe("Closing Periode: penyisihan and akrual", () => {
  test("the allowance is computed on demand, and a computation posts nothing", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler());
    const view = await mount(<App />);

    // Nothing is run just because the page opened: running posts a journal.
    expect(calls.some((call) => call.url.includes("/penyisihan"))).toBe(false);
    expect(textOf(view.container)).toContain("Belum dihitung pada layar ini");

    await clickOn(cariTombol(view.container, "Hitung tanpa memposting") as Element);
    expect(
      calls.some((call) => call.method === "POST" && call.url.includes("/penyisihan/pratinjau")),
    ).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/penyisihan"))).toBe(
      false,
    );
    expect(textOf(view.container)).toContain("belum ada jurnal yang terbentuk");
    expect(textOf(view.container)).toContain("1.200.000,00");
    view.unmount();
  });

  test("posting the allowance links every journal that carried the movement", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler());
    const view = await mount(<App />);

    await clickOn(cariTombol(view.container, "Jalankan dan posting") as Element);
    await clickOn(cariAksiModal(view.container, "Jalankan dan posting"));

    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/penyisihan"))).toBe(
      true,
    );
    const tautan = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(tautan).toContain("/jurnal?jurnal=j-900");
    view.unmount();
  });

  test("an accrual under cash basis is drawn as a policy outcome, not as a failure", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler({ akrual: AKRUAL_DILEWATI }));
    const view = await mount(<App />);

    await clickOn(cariTombol(view.container, "Jalankan akrual") as Element);
    await clickOn(cariAksiModal(view.container, "Jalankan akrual"));

    const teks = textOf(view.container);
    expect(teks).toContain("Langkah akrual dilewati sesuai kebijakan");
    expect(teks).toContain("Cash basis");
    expect(teks).toContain("prasyarat closing nomor 6 tetap lolos");
    view.unmount();
  });

  test("an accrual that ran links its journal per branch", async () => {
    const { mount, clickOn } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch(handler());
    const view = await mount(<App />);

    await clickOn(cariTombol(view.container, "Jalankan akrual") as Element);
    await clickOn(cariAksiModal(view.container, "Jalankan akrual"));

    const tautan = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(tautan).toContain("/jurnal?jurnal=j-901");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Kolektibilitas
// ---------------------------------------------------------------------------

describe("Closing Kolektibilitas: the distribution, and where its rate came from", () => {
  test("the stored snapshot produces a distribution and names the policy row behind each class", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Distribusi kolektibilitas");
    expect(teks).toContain("Lancar");
    expect(teks).toContain("Macet");
    // Outstanding and allowance, summed exactly by packages/ui.
    expect(teks).toContain("12.000.000,00");
    expect(teks).toContain("8.000.000,00");
    // The provenance migrations 0024 and 0025 made explicit.
    expect(teks).toContain("Dasar perhitungan penyisihan");
    expect(teks).toContain("1,00%");
    expect(teks).toContain("100,00%");
    expect(teks).toContain("Tabel konfigurasi penyisihan");
    view.unmount();
  });

  test("the migration matrix reads from the previous class to this one", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    stubFetch(handler());
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Perpindahan kolektibilitas");
    expect(textOf(view.container)).toContain("Diragukan");
    view.unmount();
  });

  test("the run history is readable, with who ran it and over how many akad", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    stubFetch(handler());
    const view = await mount(<App />);

    const teks = textOf(view.container);
    expect(teks).toContain("Riwayat run");
    expect(teks).toContain("Rina Wulandari");
    expect(teks).toContain("2 akad diproses");
    view.unmount();
  });

  test("a preview writes nothing and says so, and it never touches the commit path", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    stubFetch(handler());
    const view = await mount(<App />);

    await clickOn(cariTombol(view.container, "Pratinjau tanpa menyimpan") as Element);

    expect(
      calls.some(
        (call) => call.method === "POST" && call.url.includes("/kolektibilitas/pratinjau"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.method === "POST" && call.url.endsWith("/kolektibilitas")),
    ).toBe(false);
    expect(textOf(view.container)).toContain("Ini pratinjau, belum tersimpan");
    expect(textOf(view.container)).toContain("tidak ada snapshot");
    view.unmount();
  });

  test("running it needs a confirmation that says the previous run is rewritten", async () => {
    const { mount, clickOn, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    stubFetch(handler());
    const view = await mount(<App />);

    await clickOn(cariTombol(view.container, "Jalankan dan simpan") as Element);
    const dialog = textOf(view.container.querySelector(".modal-panel"));
    expect(dialog).toContain("ditulis ulang dalam satu transaksi");
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    await clickOn(cariAksiModal(view.container, "Jalankan dan simpan"));
    expect(
      calls.some((call) => call.method === "POST" && call.url.endsWith("/kolektibilitas")),
    ).toBe(true);
    expect(textOf(view.container)).toContain("1 mitra ditandai bermasalah");
    view.unmount();
  });

  test("a viewer holding only admin.closing.view sees the evidence and no run control", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    stubFetch(handler({ session: SESSION_AUDITOR }));
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Distribusi kolektibilitas");
    expect(textOf(view.container)).toContain("Riwayat run");
    const labels = tombol(view.container);
    expect(labels.some((t) => t.includes("Pratinjau tanpa menyimpan"))).toBe(false);
    expect(labels.some((t) => t.includes("Jalankan dan simpan"))).toBe(false);
    expect(textOf(view.container)).toContain("tanpa menjalankannya");
    view.unmount();
  });

  test("a figure that cannot be read renders the marker, never a zero", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-kolektibilitas");
    const rusak = {
      data: [{ ...SNAPSHOT.data[0], outstandingPokok: "dua belas juta", nilaiPenyisihan: "n/a" }],
    };
    stubFetch(handler({ snapshot: rusak }));
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("tidak sah");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// Failures and copy hygiene
// ---------------------------------------------------------------------------

describe("closing screens fail honestly", () => {
  test("an endpoint that does not answer renders the failure panel naming it, not an empty page", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch((call) =>
      call.url.includes("/auth/session") ? json(200, SESSION_PUSAT) : notFound(),
    );
    const view = await mount(<App />);

    const gagal = view.container.querySelector(".errorstate");
    expect(gagal).toBeTruthy();
    expect(textOf(gagal)).toContain("Gagal memuat referensi closing");
    expect(textOf(gagal)).toContain("GET /api/closing/referensi");
    view.unmount();
  });

  test("a refused prerequisite read is a named failure, not a silently empty checklist", async () => {
    const { mount, textOf } = await import("./testing");
    at("/admin/closing-periode");
    stubFetch((call) =>
      call.url.includes("/prasyarat")
        ? json(403, { error: "Pengguna ini tidak punya wewenang.", kode: "TIDAK_BERWENANG" })
        : handler()(call),
    );
    const view = await mount(<App />);

    expect(textOf(view.container)).toContain("Gagal memuat prasyarat closing");
    expect(view.container.querySelectorAll(".prasyarat-item").length).toBe(0);
    view.unmount();
  });

  test("no long dash anywhere on the three closing screens", async () => {
    const { mount, textOf } = await import("./testing");
    for (const path of [
      "/admin/periode?periode=p-closed",
      "/admin/closing-periode",
      "/admin/closing-kolektibilitas",
    ]) {
      at(path);
      stubFetch(handler({ prasyarat: PRASYARAT_PERINGATAN }));
      const view = await mount(<App />);
      expect(textOf(view.container)).not.toContain(LONG_DASH);
      view.unmount();
    }
  });
});
