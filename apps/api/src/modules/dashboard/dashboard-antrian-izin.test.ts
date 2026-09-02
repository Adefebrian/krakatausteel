// PANEL 7 ("Antrian Kerja Saya") AND CONTRACT RULE 4.
//
// Spec 11 calls panel 7 the one used most, and it is the only panel whose
// content depends on WHO is looking: `milikSaya` is true exactly when the
// caller holds the permission that acts on that stage, and `hanyaMilikSaya`
// narrows the list to those. The counts themselves are the branch's, not the
// user's, because a branch manager needs to see what their branch is waiting on
// even where they are not the actor.
//
// Rule 4 is the other half of this file: a number the caller may not see is
// ABSENT, with `IZIN_TIDAK_DIMILIKI`, never a zero and never an exception. Zero
// would be a statement of fact ("the budget is nothing"); an exception would
// take the whole landing screen down over one panel. Three roles are exercised
// because they hold three DIFFERENT subsets of the two evidence codes, and a
// single role would leave the branch untested in one direction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaDashboard, rp, type DuniaDashboard } from "./test-support";
import type { BarisAntrian, Metrik, RingkasanDashboard } from "./contract";

function metrik(r: RingkasanDashboard, kunci: string): Metrik {
  const m = r.metrik.find((x) => x.kunci === kunci);
  if (!m) throw new Error(`metrik ${kunci} tidak ada di ringkasan`);
  return m;
}

function tahap(r: RingkasanDashboard, kode: string): BarisAntrian {
  const t = r.antrian.find((x) => x.tahap === kode);
  if (!t) throw new Error(`tahap ${kode} tidak ada di antrian`);
  return t;
}

describe("dashboard: antrian kerja dan izin", () => {
  let d: DuniaDashboard;

  beforeAll(async () => {
    d = await buatDuniaDashboard();
    // Explicit, DIFFERENT counts per stage, so a query that grouped on the
    // wrong column produces a number that appears nowhere.
    const rencana: Array<[string, number]> = [
      ["SURVEY_PENDING", 3],
      ["REVIEW_CHECKER", 2],
      ["MENUNGGU_PERSETUJUAN", 1],
      ["DISETUJUI", 2],
      ["AKAD_DIBUAT", 1],
      ["JADWAL_SIAP", 4],
      // Not a queue stage: a disbursed proposal is terminal for the workflow.
      ["DICAIRKAN", 5],
    ];
    for (const [status, n] of rencana) {
      for (let i = 0; i < n; i += 1) {
        await d.proposalPumkDi({ cabangId: d.cabangA.id, status });
      }
    }
    // Branch B carries its own, so a scope leak shows up as a wrong count.
    await d.proposalPumkDi({ cabangId: d.cabangB.id, status: "SURVEY_PENDING" });
    await d.proposalNonPumkDi({ cabangId: d.cabangA.id, status: "PENILAIAN" });
    await d.proposalNonPumkDi({ cabangId: d.cabangA.id, status: "LPJ_DIAJUKAN" });
    await d.proposalNonPumkDi({ cabangId: d.cabangA.id, status: "LPJ_DIAJUKAN" });

    await d.buatBaselineNonPumk({ cabangId: null, bulan: 4, jumlah: rp(8_000_000) });
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("hitungan per tahap sesuai state machine yang dikirim", async () => {
    const r = await d.engine.ringkasan(
      { periodeId: d.periode(4).id, cabangId: d.cabangA.id },
      d.ctx.adminPusat,
    );
    expect(tahap(r, "PUMK_SURVEY").jumlah).toBe(3);
    expect(tahap(r, "PUMK_REVIEW").jumlah).toBe(2);
    expect(tahap(r, "PUMK_PERSETUJUAN").jumlah).toBe(1);
    // DISETUJUI (2) and AKAD_DIBUAT (1) are ONE queue: `pumk.akad` carries both
    // BUAT_AKAD and GENERATE_JADWAL, so the same person is waited on.
    expect(tahap(r, "PUMK_AKAD").jumlah).toBe(3);
    expect(tahap(r, "PUMK_PENCAIRAN").jumlah).toBe(4);
    // DICAIRKAN is terminal and belongs in nobody's queue.
    expect(r.antrian.reduce((n, t) => n + t.jumlah, 0)).toBe(3 + 2 + 1 + 3 + 4 + 1 + 2);
    expect(tahap(r, "NONPUMK_PENILAIAN").jumlah).toBe(1);
    expect(tahap(r, "NONPUMK_LPJ_VERIFIKASI").jumlah).toBe(2);
  });

  test("cabang lain tidak masuk hitungan", async () => {
    const semua = await d.engine.ringkasan(
      { periodeId: d.periode(4).id },
      d.ctx.adminPusat,
    );
    // Branch B's single SURVEY_PENDING lifts the entity-wide count to 4.
    expect(tahap(semua, "PUMK_SURVEY").jumlah).toBe(4);
    const hanyaA = await d.engine.ringkasan(
      { periodeId: d.periode(4).id, cabangId: d.cabangA.id },
      d.ctx.adminPusat,
    );
    expect(tahap(hanyaA, "PUMK_SURVEY").jumlah).toBe(3);
  });

  test("milikSaya mengikuti izin kanonik pemanggil, bukan perannya", async () => {
    const maker = await d.engine.ringkasan({ periodeId: d.periode(4).id }, d.ctx.maker);
    // MAKER holds pumk.survey / pumk.akad / pumk.pencairan and does NOT hold
    // pumk.review or pumk.approve (modules/auth/permissions.ts).
    expect(tahap(maker, "PUMK_SURVEY").milikSaya).toBe(true);
    expect(tahap(maker, "PUMK_AKAD").milikSaya).toBe(true);
    expect(tahap(maker, "PUMK_PENCAIRAN").milikSaya).toBe(true);
    expect(tahap(maker, "PUMK_REVIEW").milikSaya).toBe(false);
    expect(tahap(maker, "PUMK_PERSETUJUAN").milikSaya).toBe(false);
    // ...and the count is still the BRANCH's, not "mine".
    expect(tahap(maker, "PUMK_REVIEW").jumlah).toBe(2);

    const checker = await d.engine.ringkasan(
      { periodeId: d.periode(4).id },
      d.ctx.checker,
    );
    expect(tahap(checker, "PUMK_REVIEW").milikSaya).toBe(true);
    expect(tahap(checker, "NONPUMK_LPJ_VERIFIKASI").milikSaya).toBe(true);
    expect(tahap(checker, "PUMK_SURVEY").milikSaya).toBe(false);

    const approver = await d.engine.ringkasan(
      { periodeId: d.periode(4).id },
      d.ctx.approver,
    );
    expect(tahap(approver, "PUMK_PERSETUJUAN").milikSaya).toBe(true);
    expect(tahap(approver, "PUMK_REVIEW").milikSaya).toBe(false);
  });

  test("hanyaMilikSaya menyaring, tanpa mengubah hitungannya", async () => {
    const r = await d.engine.ringkasan(
      { periodeId: d.periode(4).id, hanyaMilikSaya: true },
      d.ctx.checker,
    );
    expect(r.antrian.map((t): string => t.tahap).sort()).toEqual(
      ["PUMK_REVIEW", "NONPUMK_REVIEW", "NONPUMK_LPJ_VERIFIKASI"].sort(),
    );
    expect(r.antrian.every((t) => t.milikSaya)).toBe(true);
    expect(tahap(r, "PUMK_REVIEW").jumlah).toBe(2);
  });

  test("setiap tahap membawa izin KANONIK, bukan ejaan bebas", async () => {
    const r = await d.engine.ringkasan({ periodeId: d.periode(4).id }, d.ctx.adminPusat);
    expect(tahap(r, "PUMK_SURVEY").izin).toBe("pumk.survey");
    expect(tahap(r, "NONPUMK_LPJ_VERIFIKASI").izin).toBe("nonpumk.lpj.verifikasi");
    // ADMIN_PUSAT holds the whole catalogue, so every stage is its own.
    expect(r.antrian.every((t) => t.milikSaya)).toBe(true);
  });

  test("rincian antrian menyerahkan dokumen dengan id-nya", async () => {
    const r = await d.engine.rincian(
      "antrian:PUMK_PENCAIRAN",
      { periodeId: d.periode(4).id, cabangId: d.cabangA.id },
      d.ctx.adminPusat,
    );
    expect(r.jumlah).toBe(4);
    expect(r.sumber).toBe("PROSES");
    // A count metric has no money total the rows add up to; the amount each
    // proposal carries sits in `fakta`, where it cannot be mistaken for one.
    expect(r.total).toBeNull();
    for (const baris of r.baris) {
      expect(baris.entitas).toBe("pumk_proposal");
      expect(baris.fakta.status).toBe("JADWAL_SIAP");
      expect(baris.fakta.izin).toBe("pumk.pencairan");
      expect(baris.nilai).toBeNull();
      expect(baris.cabangId).toBe(d.cabangA.id);
    }
  });

  test("MAKER: anggaran dan checklist closing ABSEN dengan alasan, bukan nol", async () => {
    const r = await d.engine.ringkasan({ periodeId: d.periode(4).id }, d.ctx.maker);
    for (const kunci of ["ANGGARAN_NON_PUMK", "EFEKTIVITAS_NON_PUMK"]) {
      const m = metrik(r, kunci);
      expect(m.nilai).toBeNull();
      expect(m.alasanKosong).toBe("IZIN_TIDAK_DIMILIKI");
      expect(m.rincian).toBeNull();
    }
    expect(r.closing.prasyarat).toBeNull();
    expect(r.closing.alasanKosong).toBe("IZIN_TIDAK_DIMILIKI");
    // The rest of the page is UNAFFECTED. Hiding ten metrics to protect two
    // would be the wrong trade, and gating the route would do exactly that.
    expect(metrik(r, "DANA_TERSEDIA").nilai).not.toBeNull();
    expect(metrik(r, "OUTSTANDING_PUMK").nilai).not.toBeNull();
    expect(r.antrian.length).toBeGreaterThan(0);
  });

  test("APPROVER: checklist ADA, anggaran tetap absen", async () => {
    const r = await d.engine.ringkasan({ periodeId: d.periode(4).id }, d.ctx.approver);
    // APPROVER holds admin.closing.view and not admin.rka.view.
    expect(r.closing.prasyarat).not.toBeNull();
    expect(r.closing.prasyarat!.hasil).toHaveLength(10);
    expect(r.closing.alasanKosong).toBeNull();
    expect(metrik(r, "ANGGARAN_NON_PUMK").alasanKosong).toBe("IZIN_TIDAK_DIMILIKI");
  });

  test("ADMIN_PUSAT: keduanya ada, dan checklist datang dari modules/closing", async () => {
    const r = await d.engine.ringkasan({ periodeId: d.periode(4).id }, d.ctx.adminPusat);
    expect(metrik(r, "ANGGARAN_NON_PUMK").nilai).toBe(rp(8_000_000));
    expect(metrik(r, "ANGGARAN_NON_PUMK").sumber).toBe("RKA");
    const prasyarat = r.closing.prasyarat!;
    // Spec 8.4's ten, in the spec's own numbering. A dashboard that re-listed
    // them would be a second opinion about whether a month may be closed.
    expect(prasyarat.hasil.map((h) => h.nomor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.closing.status).toBe("OPEN");
    expect(r.closing.closedAt).toBeNull();
  });

  test("baseline tanpa baris bulan ini: ANGGARAN_TIDAK_PER_BULAN, bukan 0.00", async () => {
    // The baseline covers month 4 only; month 5 asks the same document for a
    // line it does not carry.
    const r = await d.engine.ringkasan({ periodeId: d.periode(5).id }, d.ctx.adminPusat);
    const m = metrik(r, "ANGGARAN_NON_PUMK");
    expect(m.nilai).toBeNull();
    expect(m.alasanKosong).toBe("ANGGARAN_TIDAK_PER_BULAN");
    expect(metrik(r, "EFEKTIVITAS_NON_PUMK").alasanKosong).toBe("ANGGARAN_TIDAK_PER_BULAN");
  });

  test("daftar periode: terbaru dulu, dan hanya milik entitas ini", async () => {
    const semua = await d.engine.daftarPeriode({}, d.ctx.adminPusat);
    expect(semua).toHaveLength(12);
    expect(semua[0]!.bulan).toBe(12);
    expect(semua[11]!.bulan).toBe(1);
    expect(new Set(semua.map((p) => p.tahun))).toEqual(new Set([d.tahun]));
    expect(await d.engine.daftarPeriode({ tahun: d.tahun - 1 }, d.ctx.adminPusat)).toEqual(
      [],
    );
  });
});

describe("dashboard: port yang tidak terpasang", () => {
  let d: DuniaDashboard;

  beforeAll(async () => {
    d = await buatDuniaDashboard({ tanpaPort: true });
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("tanpa port: SUMBER_TIDAK_TERPASANG, bukan nol yang terbaca 'tidak ada kerjaan'", async () => {
    const r = await d.engine.ringkasan({ periodeId: d.periode(4).id }, d.ctx.adminPusat);
    expect(metrik(r, "ANGGARAN_NON_PUMK").alasanKosong).toBe("SUMBER_TIDAK_TERPASANG");
    expect(metrik(r, "EFEKTIVITAS_NON_PUMK").alasanKosong).toBe("SUMBER_TIDAK_TERPASANG");
    expect(metrik(r, "LPJ_TERLAMBAT").nilai).toBeNull();
    expect(metrik(r, "LPJ_TERLAMBAT").alasanKosong).toBe("SUMBER_TIDAK_TERPASANG");
    expect(r.closing.prasyarat).toBeNull();
    expect(r.closing.alasanKosong).toBe("SUMBER_TIDAK_TERPASANG");
    // The engine still answers everything a database alone can answer: the
    // ports are optional precisely so the fixtures can construct it this way.
    expect(metrik(r, "DANA_TERSEDIA").nilai).not.toBeNull();
    expect(r.antrian.length).toBe(10);
  });
});
