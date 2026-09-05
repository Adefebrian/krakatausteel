// The monthly close, DRIVEN THROUGH HTTP end to end.
//
// ../pumk/pumk-rute-otorisasi.test.ts and ./closing-rute-otorisasi.test.ts
// answer "who may call what". This file answers the other half, the one spec 16
// actually describes: does the SEQUENCE an accountant performs work over the
// real endpoints, and does it refuse where it must.
//
// It follows ../nonpumk/nonpumk-rute-alur.test.ts. Everything goes through the
// REAL app -- real logins, real cookies, the real guard chain, the real error
// handler, the real engine reaching the real ledger -- and every assertion is
// made on the HTTP response or on the DATABASE, never on an engine return
// value. The engine's own behaviour is pinned by the nine engine files in this
// folder; what is pinned HERE is that the transport neither adds nor loses
// anything on the way through, which is where the last three modules' routers
// each went wrong in a different way.
//
// THE SCENARIOS OF SPEC 16 THIS FILE OWNS OVER HTTP:
//
//   11  the kolektibilitas run: preview first, then commit, with the migration
//       matrix, the run history, and a re-run that replaces rather than
//       duplicates;
//   12  THE ACCEPTANCE TEST. A journal left in DRAFT REFUSES the close with a
//       reason naming the document; the journal is posted; the close then
//       succeeds and the posted figure is inside the frozen balances;
//   13  once a period is CLOSED nothing may be posted into it and no closing
//       step may be re-run against it;
//   17  the allowance movement is reconstructible from the journals recorded
//       against it, over the wire and not only in the engine.
//
// AND THE TWO PROPERTIES THAT ARE NOT SCENARIOS BUT WOULD BE WORSE TO LOSE:
// the checklist is ALWAYS all ten items, never short-circuited at the first
// failure; and two concurrent closes produce EXACTLY ONE success, which the
// engine's row lock guarantees and which a retry in the router would destroy.
//
// TEST ORDER IS PART OF THE FIXTURE. `bun test` runs a file's tests in source
// order in one process, and this file deliberately uses that: January is closed
// by the scenario 12 block and is still closed when the scenario 13 block runs.
// Every block says which month it works on and what state it leaves behind, so
// the sequence reads as the operator's year rather than as hidden coupling.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaRuteClosing,
  rp,
  tutupSemuaFixture,
  type DuniaRuteClosing,
} from "./rute-test-support";

// Fixture teardown, one call for the whole file. See the FIXTURE LEAK note in
// apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

let d: DuniaRuteClosing;

/**
 * spec 8.4's ten checks, in the spec's own order. Written out rather than read
 * from `PRASYARAT_CLOSING` so that a reordering of the engine's enum shows up
 * here as a failure instead of being mirrored silently: the ORDER is what the
 * screen renders and what an accountant works down.
 */
const URUTAN_PRASYARAT = [
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

interface Prasyarat {
  nomor: number;
  kode: string;
  status: "PASS" | "GAGAL" | "PERINGATAN";
  alasan: string;
  detail: Record<string, unknown>;
}

interface DaftarPrasyarat {
  periodeId: string;
  tahun: number;
  bulan: number;
  boleh: boolean;
  perluKonfirmasi: boolean;
  hasil: Prasyarat[];
}

/**
 * A reason an accountant can act on, which spec 16 scenario 12 requires in so
 * many words ("dengan alasan yang jelas"). The same shape ./test-support.ts
 * uses for the engine: long enough to be a sentence, and free of every driver
 * and trigger internal.
 */
function alasanTerbaca(alasan: string): void {
  expect(alasan.length).toBeGreaterThan(25);
  expect(alasan).not.toMatch(/TJSL-[A-Z]{3}-\d{3}/);
  expect(alasan).not.toMatch(/constraint|violates|SQLSTATE|duplicate key|_uq\b|_ck\b/i);
}

const prasyarat = (periodeId: string, role = "APPROVER"): Promise<DaftarPrasyarat> =>
  d.ok<DaftarPrasyarat>(role, `/closing/periode/${periodeId}/prasyarat`);

const cek = (daftar: DaftarPrasyarat, kode: string): Prasyarat => {
  const hasil = daftar.hasil.find((h) => h.kode === kode);
  if (!hasil) throw new Error(`prasyarat ${kode} tidak ada di daftar`);
  return hasil;
};

beforeAll(async () => {
  d = await buatDuniaRuteClosing();
});

// ---------------------------------------------------------------------------
// The checklist. Month 5, which nothing else in this file touches.
// ---------------------------------------------------------------------------

describe("spec 8.4: daftar prasyarat selalu sepuluh butir, tidak pernah berhenti di kegagalan pertama", () => {
  test("sepuluh butir, urutan spesifikasi, masing masing dengan status dan alasan sendiri", async () => {
    const daftar = await prasyarat(d.periode.get(5)!.id);

    expect(daftar.hasil).toHaveLength(10);
    expect(daftar.hasil.map((h) => h.kode)).toEqual([...URUTAN_PRASYARAT]);
    expect(daftar.hasil.map((h) => h.nomor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const h of daftar.hasil) {
      expect(["PASS", "GAGAL", "PERINGATAN"]).toContain(h.status);
      alasanTerbaca(h.alasan);
    }
  });

  test("BEBERAPA butir gagal sekaligus: operator tahu sisa pekerjaannya, bukan hanya yang pertama", async () => {
    // The property that makes the list worth returning at all. Nothing has been
    // prepared for this month, so checks 4, 5 and 6 all fail; a short-circuit
    // would report one of them and send the operator round the loop three times
    // to discover the others. Check 1 fails too, since earlier months are open.
    const daftar = await prasyarat(d.periode.get(5)!.id);
    const gagal = daftar.hasil.filter((h) => h.status === "GAGAL").map((h) => h.kode);

    expect(gagal).toContain("KOLEKTIBILITAS_BELUM_DIJALANKAN");
    expect(gagal).toContain("PENYISIHAN_BELUM_POSTED");
    expect(gagal).toContain("AKRUAL_BELUM_POSTED");
    expect(gagal.length).toBeGreaterThanOrEqual(3);
    expect(daftar.boleh).toBe(false);
  });

  test("membaca checklist tidak menulis apa pun, termasuk penanda CLOSING_IN_PROGRESS", async () => {
    // The screen polls this on every page load, so a read with consequences
    // would make refreshing a page a transaction.
    const p = d.periode.get(5)!;
    await prasyarat(p.id);
    await prasyarat(p.id);
    expect(await d.statusPeriode(p.id)).toBe("OPEN");
    expect(await d.jumlahSaldoBeku(p.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// spec 16 scenario 11 / spec 8.1. Month 6, which nothing else touches.
// ---------------------------------------------------------------------------

describe("spec 16 skenario 11 (spec 8.1): pratinjau kolektibilitas tidak menulis, commit menulis", () => {
  const bulan = 6;

  test("pratinjau menjawab 200 dengan tersimpan:false dan matriks perpindahan", async () => {
    const p = d.periode.get(bulan)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${p.id}/kolektibilitas/pratinjau`, {
      body: {},
    });
    // 200, not 201: nothing was created. That is one of the four ways the
    // preview and the commit are kept apart; see routes.ts's header.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tersimpan: boolean;
      matriks: unknown[];
      ringkasanPerKelas: unknown[];
      tanggalAkhirPeriode: string;
    };
    expect(body.tersimpan).toBe(false);
    expect(Array.isArray(body.matriks)).toBe(true);
    expect(Array.isArray(body.ringkasanPerKelas)).toBe(true);
    // Arrears are measured at the period's own end date, which the answer
    // states rather than leaving the reader to assume.
    expect(body.tanggalAkhirPeriode).toBe(p.tanggalAkhir);
  });

  test("setelah pratinjau, riwayat dan snapshot masih kosong", async () => {
    const p = d.periode.get(bulan)!;
    const riwayat = await d.ok<{ data: unknown[] }>(
      "AUDITOR",
      `/closing/periode/${p.id}/kolektibilitas/riwayat`,
    );
    expect(riwayat.data).toEqual([]);
    const snapshot = await d.ok<{ data: unknown[] }>(
      "AUDITOR",
      `/closing/periode/${p.id}/kolektibilitas/snapshot`,
    );
    expect(snapshot.data).toEqual([]);
    // And check 4 still says the step has not run: the preview did not fake it.
    expect(cek(await prasyarat(p.id), "KOLEKTIBILITAS_BELUM_DIJALANKAN").status).toBe("GAGAL");
  });

  test("commit menjawab 201 dengan tersimpan:true dan meninggalkan satu baris riwayat", async () => {
    const p = d.periode.get(bulan)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${p.id}/kolektibilitas`, {
      body: {},
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tersimpan: boolean; closingId: string };
    expect(body.tersimpan).toBe(true);
    expect(body.closingId).toBeTruthy();

    const riwayat = await d.ok<{
      data: Array<{ id: string; status: string; dijalankanOleh: string | null }>;
    }>("AUDITOR", `/closing/periode/${p.id}/kolektibilitas/riwayat`);
    expect(riwayat.data).toHaveLength(1);
    expect(riwayat.data[0]!.status).toBe("SELESAI");
    // Who ran it is part of the evidence, and it is the SESSION's user, never
    // anything the request could name.
    expect(riwayat.data[0]!.dijalankanOleh).toBe(d.f.users.APPROVER.id);

    expect(cek(await prasyarat(p.id), "KOLEKTIBILITAS_BELUM_DIJALANKAN").status).toBe("PASS");
  });

  test("menjalankan ulang MENGGANTIKAN, tidak menggandakan (invariant 13)", async () => {
    const p = d.periode.get(bulan)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${p.id}/kolektibilitas`, {
      body: {},
    });
    expect(res.status).toBe(201);
    const riwayat = await d.ok<{ data: unknown[] }>(
      "AUDITOR",
      `/closing/periode/${p.id}/kolektibilitas/riwayat`,
    );
    expect(riwayat.data).toHaveLength(1);
  });

  test("pratinjau SESUDAH commit tetap tidak menulis", async () => {
    // The dangerous direction: an operator re-checks their work after running
    // the step. If the preview wrote, that click would silently replace a
    // committed run.
    const p = d.periode.get(bulan)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${p.id}/kolektibilitas/pratinjau`, {
      body: {},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tersimpan: boolean }).tersimpan).toBe(false);
    const riwayat = await d.ok<{ data: unknown[] }>(
      "AUDITOR",
      `/closing/periode/${p.id}/kolektibilitas/riwayat`,
    );
    expect(riwayat.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// spec 8.4 check 8. January, before it is closed further down.
// ---------------------------------------------------------------------------

describe("spec 8.4 butir 8: kas negatif adalah PERINGATAN yang wajib dikonfirmasi", () => {
  test("kas negatif menahan closing sampai dikonfirmasi, dan penolakannya bukan PRASYARAT_GAGAL", async () => {
    const jan = d.periode.get(1)!;
    // Spend before there is anything to spend: cash goes negative at the period
    // end, which is exactly the condition check 8 describes.
    await d.postingBebanOperasional(jan.tanggalMulai, rp(1_000_000));
    await d.siapkanTutup(jan.id);

    const daftar = await prasyarat(jan.id);
    const kas = cek(daftar, "SALDO_KAS_NEGATIF");
    expect(kas.status).toBe("PERINGATAN");
    alasanTerbaca(kas.alasan);
    // A warning is not a blocker: the list still says the close is permitted,
    // and separately that it needs a confirmation. Collapsing the two into one
    // boolean is how "wajib dikonfirmasi user" turns into a silent override.
    expect(daftar.boleh).toBe(true);
    expect(daftar.perluKonfirmasi).toBe(true);

    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${jan.id}/tutup`, { body: {} });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { kodeDomain: string; error: string };
    expect(body.kodeDomain).toBe("KONFIRMASI_KAS_NEGATIF_WAJIB");
    alasanTerbaca(body.error);
    expect(await d.statusPeriode(jan.id)).toBe("OPEN");
  });

  test("mendanai entitas membuat butir 8 PASS lagi: checklist membaca keadaan, bukan sejarah", async () => {
    const jan = d.periode.get(1)!;
    await d.postingAlokasiDana(jan.tanggalMulai, rp(50_000_000));
    const daftar = await prasyarat(jan.id);
    expect(cek(daftar, "SALDO_KAS_NEGATIF").status).toBe("PASS");
    expect(daftar.perluKonfirmasi).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spec 16 scenario 12. January. LEAVES JANUARY CLOSED.
// ---------------------------------------------------------------------------

describe("spec 16 skenario 12: jurnal DRAFT memblokir closing, diposting, lalu closing berhasil", () => {
  let noJurnalDraft = "";
  let idJurnalDraft = "";

  test("1. closing DITOLAK, dengan alasan yang menyebut dokumennya", async () => {
    const jan = d.periode.get(1)!;
    const draft = await d.buatJurnalDraft(jan.tanggalAkhir, rp(1_250_000));
    noJurnalDraft = draft.noJurnal;
    idJurnalDraft = draft.id;

    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${jan.id}/tutup`, { body: {} });
    // 409, not 400: the request was well formed and the BOOKS refuse it. An
    // identical retry would refuse identically, which is what the status says.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      kodeDomain: string;
      error: string;
    };
    expect(body.code).toBe("KONFLIK");
    expect(body.kodeDomain).toBe("PRASYARAT_GAGAL");
    alasanTerbaca(body.error);

    // The reason has to be actionable, so the offending document is named. The
    // checklist carries it, and the checklist is what the screen renders.
    const daftar = await prasyarat(jan.id);
    const butir = cek(daftar, "ADA_JURNAL_DRAFT");
    expect(butir.status).toBe("GAGAL");
    expect(butir.nomor).toBe(2);
    alasanTerbaca(butir.alasan);
    expect(JSON.stringify(butir.detail)).toContain(noJurnalDraft);
    expect(daftar.boleh).toBe(false);

    // NOTHING MOVED. A refused close that half-froze a trial balance would be
    // far worse than one that failed loudly.
    expect(await d.statusPeriode(jan.id)).toBe("OPEN");
    expect(await d.jumlahSaldoBeku(jan.id)).toBe(0);
  });

  test("2. jurnal diposting lewat ledger yang sama", async () => {
    const posted = await d.postingJurnalDraft(idJurnalDraft);
    expect(posted.status).toBe("POSTED");
    expect(cek(await prasyarat(d.periode.get(1)!.id), "ADA_JURNAL_DRAFT").status).toBe("PASS");
  });

  test("3. closing BERHASIL, membekukan saldo, dan mencatat siapa yang menutup", async () => {
    const jan = d.periode.get(1)!;
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${jan.id}/tutup`, { body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      periode: { status: string; closedBy: string | null; closedAt: string | null };
      prasyarat: DaftarPrasyarat;
      saldo: Array<{ akunId: string; akunKode: string; mutasiDebit: string }>;
    };

    expect(body.periode.status).toBe("CLOSED");
    // `closed_by` is the SESSION's user, and since OPEN-QUESTIONS 29 that user
    // is an Admin Pusat: the branch prepares the month, head office declares it
    // finished. Nothing in the request could name it either way.
    expect(body.periode.closedBy).toBe(d.f.users.ADMIN_PUSAT.id);
    expect(body.periode.closedAt).not.toBeNull();

    // The checklist AS IT STOOD travels with the answer, so the record says what
    // was true when the decision was made rather than what is true whenever
    // somebody next looks.
    expect(body.prasyarat.hasil).toHaveLength(10);
    expect(body.prasyarat.hasil.filter((h) => h.status === "GAGAL")).toEqual([]);

    // The journal that blocked a moment ago is INSIDE the frozen figures, which
    // is the whole point of having refused.
    expect(body.saldo.length).toBeGreaterThan(0);
    const beban = body.saldo.find((s) => s.akunId === d.akunBebanOperasionalId);
    expect(beban).toBeDefined();
    expect(Number(beban!.mutasiDebit)).toBeGreaterThanOrEqual(1_250_000);

    expect(await d.statusPeriode(jan.id)).toBe("CLOSED");
    expect(await d.jumlahSaldoBeku(jan.id)).toBe(body.saldo.length);
  });

  test("4. saldo beku dapat dibaca kembali lewat HTTP, oleh Auditor, tanpa hak menjalankan apa pun", async () => {
    const jan = d.periode.get(1)!;
    const dibaca = await d.ok<{ data: Array<{ akunKode: string; saldoAkhir: string }> }>(
      "AUDITOR",
      `/closing/periode/${jan.id}/saldo`,
    );
    expect(dibaca.data.length).toBe(await d.jumlahSaldoBeku(jan.id));

    // The period row now reports the close on the picker screen too, with the
    // NAME of who did it: a uuid answers "who closed January" only for somebody
    // with database access.
    const periode = await d.ok<{
      status: string;
      closedOleh: string | null;
      jumlahSaldoBeku: number;
    }>("AUDITOR", `/closing/periode/${jan.id}`);
    expect(periode.status).toBe("CLOSED");
    expect(periode.closedOleh).toBe(`Uji ADMIN_PUSAT ${d.f.suffix}`);
    expect(periode.jumlahSaldoBeku).toBe(dibaca.data.length);
  });
});

// ---------------------------------------------------------------------------
// spec 16 scenario 13. January stays CLOSED.
// ---------------------------------------------------------------------------

describe("spec 16 skenario 13: periode CLOSED menolak posting baru dan menolak diulang", () => {
  test("ledger menolak jurnal bertanggal di periode yang sudah ditutup (invariant 5)", async () => {
    const jan = d.periode.get(1)!;
    let ditangkap: unknown;
    try {
      await d.postingBebanOperasional(jan.tanggalAkhir, rp(100_000));
    } catch (e) {
      ditangkap = e;
    }
    expect((ditangkap as { kode?: string } | undefined)?.kode).toBe("PERIODE_TIDAK_OPEN");
  });

  test("langkah closing tidak bisa diulang di periode CLOSED, lewat HTTP", async () => {
    const jan = d.periode.get(1)!;
    for (const path of ["kolektibilitas", "penyisihan", "akrual"]) {
      const res = await d.panggil("APPROVER", `/closing/periode/${jan.id}/${path}`, { body: {} });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe("PERIODE_TIDAK_OPEN");
    }
  });

  test("closing kedua atas periode yang sama ditolak, dan saldo beku tidak ditulis ulang", async () => {
    const jan = d.periode.get(1)!;
    const sebelum = await d.jumlahSaldoBeku(jan.id);
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${jan.id}/tutup`, { body: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe("PERIODE_SUDAH_CLOSED");
    expect(await d.jumlahSaldoBeku(jan.id)).toBe(sebelum);
  });

  test("pratinjau TETAP boleh di periode CLOSED, dan tetap tidak menyentuh snapshot", async () => {
    // DELIBERATE, AND WORTH STATING PLAINLY. The COMMIT is gated on OPEN
    // (service.ts, `jalankanKolektibilitas`); the PREVIEW is not
    // (`hitungKolektibilitas` reads the period without a status gate). The
    // asymmetry is the right one: a preview is the question "what would this
    // month look like if it were recomputed today", which is exactly what an
    // accountant asks BEFORE deciding whether a reopen is worth it, and
    // answering it writes nothing.
    //
    // What must stay true is that the answer can never be mistaken for the
    // closed month's figures, and that is asserted here rather than assumed:
    // the response says `tersimpan: false`, and the STORED snapshot -- the one
    // every report reads, and the one invariant 14 protects -- is untouched by
    // the call.
    const jan = d.periode.get(1)!;
    const sebelum = await d.ok<{ data: unknown[] }>(
      "AUDITOR",
      `/closing/periode/${jan.id}/kolektibilitas/snapshot`,
    );

    const res = await d.panggil("APPROVER", `/closing/periode/${jan.id}/kolektibilitas/pratinjau`, {
      body: {},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tersimpan: boolean }).tersimpan).toBe(false);

    const sesudah = await d.ok<{ data: unknown[] }>(
      "AUDITOR",
      `/closing/periode/${jan.id}/kolektibilitas/snapshot`,
    );
    expect(sesudah).toEqual(sebelum);
    expect(await d.statusPeriode(jan.id)).toBe("CLOSED");
    expect(await d.jumlahSaldoBeku(jan.id)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// spec 8.4 reopen. Closes February, then reopens it. LEAVES FEBRUARY OPEN.
// ---------------------------------------------------------------------------

describe("spec 8.4: reopen adalah hak paling berat di sistem ini", () => {
  test("Februari ditutup, sehingga ada periode CLOSED yang lebih baru dari Januari", async () => {
    const feb = d.periode.get(2)!;
    await d.siapkanTutup(feb.id);
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${feb.id}/tutup`, { body: {} });
    expect(res.status).toBe(200);
    expect(await d.statusPeriode(feb.id)).toBe("CLOSED");
  });

  test("hanya periode CLOSED TERAKHIR yang boleh dibuka kembali", async () => {
    // Reopening an older month would leave a closed month sitting on top of an
    // open one, and every statement since then would be unreproducible.
    const jan = d.periode.get(1)!;
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${jan.id}/buka`, {
      body: { alasan: "Koreksi klasifikasi beban atas permintaan KAP (uji rute)" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { kodeDomain: string; error: string };
    expect(body.kodeDomain).toBe("REOPEN_BUKAN_PERIODE_TERAKHIR");
    alasanTerbaca(body.error);
    expect(await d.statusPeriode(jan.id)).toBe("CLOSED");
  });

  test("Approver boleh menutup tapi TIDAK boleh membuka kembali", async () => {
    // The asymmetry IS the control, and it is asserted here as well as in the
    // permission matrix because this is the sequence in which it matters: the
    // same person who legitimately closed February a moment ago cannot undo it.
    const feb = d.periode.get(2)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${feb.id}/buka`, {
      body: { alasan: "Ingin mengulang closing Februari (uji rute)" },
    });
    expect(res.status).toBe(403);
    expect(await d.statusPeriode(feb.id)).toBe("CLOSED");
  });

  test("Admin Pusat membuka kembali Februari: status OPEN, saldo beku dihapus, alasan tercatat", async () => {
    const feb = d.periode.get(2)!;
    expect(await d.jumlahSaldoBeku(feb.id)).toBeGreaterThan(0);
    const alasan = "Koreksi klasifikasi beban atas permintaan KAP, memo 12/2026 (uji rute)";

    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${feb.id}/buka`, {
      body: { alasan },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      reopenedBy: string | null;
      alasanReopen: string | null;
      templateLaporanId: string | null;
    };
    expect(body.status).toBe("OPEN");
    expect(body.reopenedBy).toBe(d.f.users.ADMIN_PUSAT.id);
    expect(body.alasanReopen).toBe(alasan);
    // The template stamp is CLEARED, the same way the balances are: a reopened
    // period was not reported under anything (migrations/0028, ADR 0017).
    expect(body.templateLaporanId).toBeNull();

    // spec 8.4: reopening DELETES the frozen balances. Safe precisely because
    // they are derived data, fully regenerable from the ledger.
    expect(await d.statusPeriode(feb.id)).toBe("OPEN");
    expect(await d.jumlahSaldoBeku(feb.id)).toBe(0);
    const saldo = await d.ok<{ data: unknown[] }>("AUDITOR", `/closing/periode/${feb.id}/saldo`);
    expect(saldo.data).toEqual([]);

    // And the reason is on the picker screen, where an auditor will look for it.
    const periode = await d.ok<{ alasanReopen: string | null; dibukaKembaliOleh: string | null }>(
      "AUDITOR",
      `/closing/periode/${feb.id}`,
    );
    expect(periode.alasanReopen).toBe(alasan);
    expect(periode.dibukaKembaliOleh).toBe(`Uji ADMIN_PUSAT ${d.f.suffix}`);
  });

  test("membuka periode yang tidak pernah ditutup ditolak", async () => {
    const mei = d.periode.get(5)!;
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${mei.id}/buka`, {
      body: { alasan: "Mencoba membuka periode yang masih OPEN (uji rute)" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe("PERIODE_BELUM_CLOSED");
  });

  test("spec 2 rule 5: reopen yang ditolak meninggalkan jejak DITOLAK di audit_log", async () => {
    const feb = d.periode.get(2)!;
    await d.panggil("APPROVER", `/closing/periode/${feb.id}/buka`, {
      body: { alasan: "Percobaan kedua tanpa wewenang reopen (uji rute)" },
    });
    const baris = await d.f.auditRows({ hasil: "DITOLAK", userId: d.f.users.APPROVER.id });
    const jalur = baris.map((b) => (b.nilai_baru_json as { path?: string } | null)?.path);
    expect(jalur).toContain(`/closing/periode/${feb.id}/buka`);
  });
});

// ---------------------------------------------------------------------------
// Concurrency. February, reopened above and still prepared. LEAVES IT CLOSED.
// ---------------------------------------------------------------------------

describe("dua closing bersamaan menghasilkan TEPAT SATU keberhasilan", () => {
  test("rute tidak mengulang, dan kunci baris di engine yang memutuskan", async () => {
    // THE ONE FAILURE MODE THAT IS BOTH UNLIKELY AND CATASTROPHIC: a
    // double-clicked close, two transactions both reading OPEN, both evaluating
    // the same checklist, both passing, and one month frozen twice with two
    // SUKSES audit records. The engine holds a FOR UPDATE lock on the period
    // row from before the checklist to COMMIT; this asserts the ROUTER does not
    // undo that by retrying the loser.
    const feb = d.periode.get(2)!;
    expect(await d.statusPeriode(feb.id)).toBe("OPEN");

    const [a, b] = await Promise.all([
      d.panggil("ADMIN_PUSAT", `/closing/periode/${feb.id}/tutup`, { body: {} }),
      d.panggil("ADMIN_PUSAT", `/closing/periode/${feb.id}/tutup`, { body: {} }),
    ]);

    const status = [a.status, b.status].sort();
    const berhasil = [a, b].filter((r) => r.status >= 200 && r.status < 300);
    expect(berhasil).toHaveLength(1);

    // The loser is refused in the module's own vocabulary. Raw driver text
    // naming `saldo_akun_periode_uq` is what this is here to prevent.
    const kalah = [a, b].find((r) => r.status >= 400)!;
    const body = (await kalah.json()) as { error: string; code: string; kodeDomain?: string };
    expect(body.code).not.toBe("KESALAHAN_SERVER");
    alasanTerbaca(body.error);
    expect(status[0]).toBeGreaterThanOrEqual(200);

    expect(await d.statusPeriode(feb.id)).toBe("CLOSED");
    // Frozen exactly once. The row count is the evidence: a second freeze would
    // either duplicate the rows or fail on a constraint the caller must never
    // see.
    const saldo = await d.ok<{ data: unknown[] }>(
      "ADMIN_PUSAT",
      `/closing/periode/${feb.id}/saldo`,
    );
    expect(await d.jumlahSaldoBeku(feb.id)).toBe(saldo.data.length);
  });
});

// ---------------------------------------------------------------------------
// spec 16 scenario 17. Month 7, untouched by everything above.
// ---------------------------------------------------------------------------

describe("spec 16 skenario 17 (spec 8.2): pergerakan penyisihan dapat direkonstruksi dari jurnalnya", () => {
  const bulan = 7;

  test("pratinjau penyisihan tidak menulis: id dan jurnalId keduanya null", async () => {
    const p = d.periode.get(bulan)!;
    await d.ok("APPROVER", `/closing/periode/${p.id}/kolektibilitas`, { body: {} });

    const pratinjau = await d.ok<{
      data: Array<{ id: string | null; jurnalId: string | null; cabangId: string }>;
    }>("APPROVER", `/closing/periode/${p.id}/penyisihan/pratinjau`, { body: {} });

    expect(pratinjau.data.length).toBeGreaterThan(0);
    for (const baris of pratinjau.data) {
      expect(baris.id).toBeNull();
      expect(baris.jurnalId).toBeNull();
    }
    // And check 5 still says the step has not run.
    expect(cek(await prasyarat(p.id), "PENYISIHAN_BELUM_POSTED").status).toBe("GAGAL");
  });

  test("commit menulis satu baris per cabang, termasuk cabang yang pergerakannya nol", async () => {
    const p = d.periode.get(bulan)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${p.id}/penyisihan`, { body: {} });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: Array<{
        id: string | null;
        cabangId: string;
        bebanPenyisihanPeriode: string;
        eventCode: string | null;
        jurnal: Array<{ jurnalId: string; nilai: string }>;
      }>;
    };

    expect(body.data.length).toBeGreaterThan(0);
    for (const baris of body.data) {
      // The row IS the statement that the movement was nil, which is what
      // prerequisite check 5 reads. Spec 8.2 writes it either way.
      expect(baris.id).not.toBeNull();

      // SCENARIO 17'S PROPERTY, over the wire: the period's provision is the
      // SUM of the entries recorded against it, not a single `jurnalId`. After
      // a delta correction the movement lives in several journals
      // (migrations/0026), and following one link would not reconcile.
      const dariJurnal = baris.jurnal.reduce((n, j) => n + Number(j.nilai), 0);
      expect(dariJurnal).toBeCloseTo(Number(baris.bebanPenyisihanPeriode), 2);

      // Zero movement posts NO journal, and that is not an error: an entry that
      // moved nothing is not part of the movement.
      if (Number(baris.bebanPenyisihanPeriode) === 0) {
        expect(baris.jurnal).toEqual([]);
        expect(baris.eventCode).toBeNull();
      }
    }
    expect(cek(await prasyarat(p.id), "PENYISIHAN_BELUM_POSTED").status).toBe("PASS");
  });

  test("akrual melaporkan metode yang berlaku, bukan diam diam melewatinya", async () => {
    const p = d.periode.get(bulan)!;
    const res = await d.panggil("APPROVER", `/closing/periode/${p.id}/akrual`, { body: {} });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      metode: string;
      dilewati: boolean;
      kelasDiakrual: string[];
    };
    // A skipped step is a legitimate outcome, NOT a silent skip: `metode` says
    // which policy produced it, so "policy says do nothing" can never be
    // confused with "something went wrong and produced nothing".
    expect(["CASH_BASIS", "ACCRUAL"]).toContain(body.metode);
    expect(body.dilewati).toBe(body.metode === "CASH_BASIS");

    // And the reference screen reports the SAME policy, read from the same
    // configuration, so the button's label and the engine's behaviour cannot
    // disagree.
    const referensi = await d.ok<{
      kapabilitas: { metodePengakuanJasa: string; kelasDiakrual: string[]; izinkanReopen: boolean };
      bolehSemuaCabang: boolean;
      cabang: Array<{ id: string }>;
    }>("AUDITOR", "/closing/referensi");
    expect(referensi.kapabilitas.metodePengakuanJasa).toBe(body.metode);
    expect(referensi.kapabilitas.izinkanReopen).toBe(true);
    // The Auditor is exempt from branch scoping (spec 2 rule 3), so it sees
    // every branch and may pick Semua Cabang.
    expect(referensi.bolehSemuaCabang).toBe(true);
    expect(referensi.cabang).toHaveLength(3);
  });

  test("Admin Cabang hanya ditawari cabangnya sendiri", async () => {
    // The other side of the same read: the option list is built from what the
    // SESSION resolved, never from anything in the request, so the screen
    // offers exactly what the engine would accept.
    const referensi = await d.ok<{
      bolehSemuaCabang: boolean;
      cabang: Array<{ id: string }>;
    }>("ADMIN_CABANG", "/closing/referensi");
    expect(referensi.cabang.map((c) => c.id)).toEqual([d.f.cabangA.id]);
    expect(referensi.bolehSemuaCabang).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The period picker, read after everything above has happened to it.
// ---------------------------------------------------------------------------

describe("layar pemilih periode melaporkan keadaan sebenarnya", () => {
  test("daftar periode terbaru dulu, dengan status, penutup dan jumlah saldo beku", async () => {
    const daftar = await d.ok<{
      data: Array<{ bulan: number; status: string; jumlahSaldoBeku: number }>;
    }>("AUDITOR", `/closing/periode?tahun=2026`);
    expect(daftar.data).toHaveLength(12);
    expect(daftar.data.map((p) => p.bulan)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

    const jan = daftar.data.find((p) => p.bulan === 1)!;
    expect(jan.status).toBe("CLOSED");
    expect(jan.jumlahSaldoBeku).toBeGreaterThan(0);
    const mei = daftar.data.find((p) => p.bulan === 5)!;
    expect(mei.status).toBe("OPEN");
    expect(mei.jumlahSaldoBeku).toBe(0);
  });

  test("filter status menyaring, dan tahun lain kosong", async () => {
    const ditutup = await d.ok<{ data: Array<{ bulan: number }> }>(
      "AUDITOR",
      "/closing/periode?status=CLOSED",
    );
    expect(ditutup.data.map((p) => p.bulan).sort((a, b) => a - b)).toEqual([1, 2]);

    const lain = await d.ok<{ data: unknown[] }>("AUDITOR", "/closing/periode?tahun=2027");
    expect(lain.data).toEqual([]);
  });

  test("periode milik BUMN lain tidak terbaca sebagai periode sendiri", async () => {
    // Scoped in the WHERE clause to the caller's own entity, so an id from
    // another bumn reads as "not found" rather than as somebody else's month.
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/closing/periode/00000000-0000-4000-8000-000000000000`,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "PERIODE_TIDAK_DITEMUKAN",
    );
  });
});
