// SPEC 8.5, THE TWELVE MANDATORY TESTS FOR THE CLOSING ENGINE.
//
// One test per item, numbered and named so a failure names the spec item it
// belongs to and nothing else. The deeper behaviour of each area lives in the
// sibling files (./closing-kolektibilitas.test.ts, ./closing-penyisihan.test.ts,
// ./closing-akrual.test.ts, ./closing-periode.test.ts,
// ./closing-saldo-ledger.test.ts); this file is the checklist the specification
// itself hands over, kept legible.
//
// WHAT THESE TESTS ASSERT AND WHAT THEY REFUSE TO ASSERT
// Items 2 and 4 are written in the spec as "penyisihan 25 persen" and
// "penyisihan 100 persen". docs/REGULASI.md finding 3 established that those
// numbers are in no regulation currently in force and contradict the collective
// impairment basis audited PUMK statements use, and spec 5's own preamble makes
// every number in section 5.2 a default awaiting the client accounting team's
// confirmation. So the tests below assert the MECHANIC: the allowance equals
// the outstanding times WHATEVER RATE `penyisihan_rate` carries for that class,
// read back out of the table at assertion time. The fixture deliberately seeds
// rates that are NOT the spec's (test-support.ts `RATE_AWAL`), so an
// implementation with 0.25 and 1.00 hardcoded fails here rather than passing.
//
// The CLASSIFICATIONS in items 1 to 4 are asserted directly, because they are
// structural: the fixture's day bands are known, and the claim being tested is
// that the engine reads them from `kolektibilitas_range` and lands 45 days in
// the second band rather than in an `if` somewhere.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JurnalError } from "../jurnal/index";
import { KODE_CLOSING, PRASYARAT_CLOSING } from "./contract";
import {
  alasanTerbaca,
  buatDunia,
  jumlahUang,
  kaliRate,
  negasiUang,
  rp,
  tolakDengan,
  type DuniaClosing,
} from "./test-support";

// ---------------------------------------------------------------------------
// Items 1..5 share one world: they are pure classification and idempotency,
// they close nothing, and each one asserts only on the akad it created.
// ---------------------------------------------------------------------------

describe("spec 8.5 butir 1-5: klasifikasi dan idempotensi", () => {
  let d: DuniaClosing;
  let periodeAkhir: string;
  let periodeId: string;

  beforeAll(async () => {
    d = await buatDunia();
    const p = d.periode(2027, 6);
    periodeAkhir = p.tanggalAkhir;
    periodeId = p.id;
    d.setelJam(p.tanggalAkhir);
  });
  afterAll(async () => {
    await d?.tutup();
  });

  async function jalankanDanAmbil(akadId: string) {
    await d.engine.jalankanKolektibilitas({ periodeId }, d.ctx.approver);
    const snapshot = await d.bacaSnapshot(periodeId);
    const baris = snapshot.find((s) => s.akad_id === akadId);
    if (!baris) {
      throw new Error(
        `spec 8.1 langkah 6: tidak ada baris kolektibilitas_snapshot untuk akad ${akadId}`,
      );
    }
    return baris;
  }

  test("8.5.1 akad tanpa tunggakan berklasifikasi LANCAR dengan penyisihan 0", async () => {
    const akad = await d.buatAkad({ hariTunggakan: null, padaTanggal: periodeAkhir });
    const baris = await jalankanDanAmbil(akad.akadId);

    expect(baris.hari_tunggakan).toBe(0);
    expect(baris.tanggal_jatuh_tempo_tertunggak_tertua).toBeNull();
    expect(baris.kolektibilitas).toBe("LANCAR");
    expect(baris.outstanding_pokok).toBe(akad.pokok);
    // Zero regardless of the rate, because the rate for this class is zero and
    // anything times zero is zero. Asserted as an amount, not as "the rate is
    // 0 percent": the claim is about the allowance, not about the policy.
    expect(baris.nilai_penyisihan).toBe("0.00");
  });

  test("8.5.2 akad tunggakan 45 hari berklasifikasi KURANG_LANCAR dengan penyisihan sesuai rate terkonfigurasi", async () => {
    const akad = await d.buatAkad({ hariTunggakan: 45, padaTanggal: periodeAkhir });
    const baris = await jalankanDanAmbil(akad.akadId);

    expect(baris.hari_tunggakan).toBe(45);
    expect(baris.kolektibilitas).toBe("KURANG_LANCAR");

    // THE SPEC SAYS 25 PERCENT. This asserts the mechanic instead: the value
    // the engine used is the value in the table, and the allowance is derived
    // from it. See the file header for why.
    const rate = await d.bacaRate("KURANG_LANCAR");
    expect(baris.rate_penyisihan).toBe(rate);
    expect(baris.nilai_penyisihan).toBe(kaliRate(akad.pokok, rate));
    expect(baris.dasar_perhitungan).toBe("OUTSTANDING_POKOK");
  });

  test("8.5.3 akad tunggakan 200 hari berklasifikasi DIRAGUKAN", async () => {
    const akad = await d.buatAkad({ hariTunggakan: 200, padaTanggal: periodeAkhir });
    const baris = await jalankanDanAmbil(akad.akadId);

    expect(baris.hari_tunggakan).toBe(200);
    expect(baris.kolektibilitas).toBe("DIRAGUKAN");
    expect(baris.nilai_penyisihan).toBe(
      kaliRate(akad.pokok, await d.bacaRate("DIRAGUKAN")),
    );
  });

  test("8.5.4 akad tunggakan 300 hari berklasifikasi MACET dengan penyisihan sesuai rate terkonfigurasi", async () => {
    const akad = await d.buatAkad({ hariTunggakan: 300, padaTanggal: periodeAkhir });
    const baris = await jalankanDanAmbil(akad.akadId);

    expect(baris.hari_tunggakan).toBe(300);
    expect(baris.kolektibilitas).toBe("MACET");

    // THE SPEC SAYS 100 PERCENT, i.e. that the allowance always covers the
    // whole outstanding. The fixture's MACET rate is below 1, which is exactly
    // the situation docs/REGULASI.md finding 4 says the spec never contemplates
    // and which ./closing-penyisihan.test.ts follows through to the write-off.
    const rate = await d.bacaRate("MACET");
    expect(baris.rate_penyisihan).toBe(rate);
    expect(baris.nilai_penyisihan).toBe(kaliRate(akad.pokok, rate));
  });

  test("8.5.5 menjalankan closing kolektibilitas dua kali: jumlah snapshot dan jumlah jurnal tetap sama", async () => {
    // Invariant 13. Counted around the second run rather than from zero,
    // because the four akads above are already in this period and the claim is
    // about the DELTA a re-run produces, which must be nothing.
    await d.engine.jalankanKolektibilitas({ periodeId }, d.ctx.approver);
    const snapshotSebelum = await d.jumlahSnapshot(periodeId);
    const jurnalSebelum = await d.jumlahJurnalPeriode(periodeId);
    expect(snapshotSebelum).toBeGreaterThan(0);

    await d.engine.jalankanKolektibilitas({ periodeId }, d.ctx.approver);

    expect(await d.jumlahSnapshot(periodeId)).toBe(snapshotSebelum);
    expect(await d.jumlahJurnalPeriode(periodeId)).toBe(jurnalSebelum);

    // And exactly one COMMITTED run row for the scope, which is what
    // `closing_kolektibilitas_selesai_uq` also insists on.
    const run = await d.bacaRunKolektibilitas(periodeId);
    expect(run.filter((r) => r.status === "SELESAI")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Items 6 and 7 need two consecutive periods and a portfolio nobody else is
// adding to, so each gets its own world.
// ---------------------------------------------------------------------------

describe("spec 8.5 butir 6-7: beban penyisihan bergerak, bukan penuh", () => {
  let d: DuniaClosing;

  beforeEach(async () => {
    d = await buatDunia();
  });
  afterEach(async () => {
    await d?.tutup();
  });

  test("8.5.6 beban penyisihan periode kedua = kebutuhan baru dikurangi saldo periode pertama, bukan nilai penuh", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const rateMacet = await d.bacaRate("MACET");

    // Period 1: one MACET akad.
    const akadSatu = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    // A second akad that is NOT yet disbursed, so spec 8.1 step 1's population
    // (AKTIF / RESCHEDULED / MACET) excludes it from period 1 entirely.
    const akadDua = await d.buatAkad({
      hariTunggakan: 331,
      padaTanggal: p2.tanggalAkhir,
      janganCairkan: true,
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const [pen1] = await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);

    const kebutuhan1 = kaliRate(akadSatu.pokok, rateMacet);
    expect(pen1.saldoPenyisihanAwal).toBe("0.00");
    expect(pen1.penyisihanDibutuhkan).toBe(kebutuhan1);
    expect(pen1.bebanPenyisihanPeriode).toBe(kebutuhan1);
    expect(pen1.eventCode).toBe("BEBAN_PENYISIHAN");

    // Period 2: the second akad goes live, so the requirement doubles.
    d.setelJam(p2.tanggalMulai);
    await d.cairkan(akadDua.akadId, p2.tanggalMulai);
    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const [pen2] = await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);

    const kebutuhan2 = kaliRate(jumlahUang(akadSatu.pokok, akadDua.pokok), rateMacet);
    expect(pen2.penyisihanDibutuhkan).toBe(kebutuhan2);
    // THE WHOLE POINT: the second period's expense is the MOVEMENT, not the
    // requirement. An implementation that posted `penyisihanDibutuhkan` would
    // double the allowance and overstate the expense by the first period's
    // amount, and both journals would still balance.
    expect(pen2.saldoPenyisihanAwal).toBe(kebutuhan1);
    expect(pen2.bebanPenyisihanPeriode).toBe(kebutuhan1);
    expect(pen2.bebanPenyisihanPeriode).not.toBe(pen2.penyisihanDibutuhkan);

    // And the ledger agrees with the arithmetic, read through v_ledger_baris.
    expect(await d.saldoLedger(d.akun.penyisihan.id, p2.tanggalAkhir)).toBe(
      negasiUang(kebutuhan2),
    );
  });

  test("8.5.7 kolektibilitas membaik dari MACET ke LANCAR menghasilkan jurnal pemulihan bernilai negatif dengan benar", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const rateMacet = await d.bacaRate("MACET");

    const akad = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const [pen1] = await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);
    const kebutuhan1 = kaliRate(akad.pokok, rateMacet);
    expect(pen1.bebanPenyisihanPeriode).toBe(kebutuhan1);

    // The mitra clears every overdue instalment inside period 2, through the
    // REAL instalment engine, so the improvement is one the rest of the system
    // agrees happened rather than one this test asserted into existence.
    const tanggalBayar = `${p2.tahun}-${String(p2.bulan).padStart(2, "0")}-10`;
    d.setelJam(tanggalBayar);
    const tertunggak = await d.totalTertunggak(akad.akadId, p2.tanggalAkhir);
    await d.bayarSetoran(akad.akadId, tanggalBayar, tertunggak);

    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const snapshot2 = await d.bacaSnapshot(p2.id);
    expect(snapshot2).toHaveLength(1);
    expect(snapshot2[0].kolektibilitas).toBe("LANCAR");
    // spec 8.1 step 6: the previous class travels with the row, which is what
    // makes the quality-migration report possible at all.
    expect(snapshot2[0].kolektibilitas_periode_lalu).toBe("MACET");

    const [pen2] = await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);
    expect(pen2.penyisihanDibutuhkan).toBe("0.00");
    expect(pen2.saldoPenyisihanAwal).toBe(kebutuhan1);
    // NEGATIVE, and stored negative. spec 8.2 step 4 posts the ABSOLUTE value
    // through PEMULIHAN_PENYISIHAN, which debits the contra-asset and credits
    // the expense; a naive implementation that posted BEBAN_PENYISIHAN with a
    // negative amount would be rejected by the ledger's own value guard.
    expect(pen2.bebanPenyisihanPeriode).toBe(negasiUang(kebutuhan1));
    expect(pen2.eventCode).toBe("PEMULIHAN_PENYISIHAN");
    expect(pen2.jurnalId).not.toBeNull();

    const posting = d.jurnal.panggilan.filter(
      (c) => c.eventCode === "PEMULIHAN_PENYISIHAN",
    );
    expect(posting).toHaveLength(1);
    expect((posting[0].argumen as { nilai: string }).nilai).toBe(kebutuhan1);

    // The allowance is back to nothing, and it got there by two journals that
    // both exist, not by one being edited.
    expect(await d.saldoLedger(d.akun.penyisihan.id, p2.tanggalAkhir)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// Items 8..12 close real periods, so each gets its own world.
// ---------------------------------------------------------------------------

describe("spec 8.5 butir 8-12: closing periode", () => {
  let d: DuniaClosing;

  beforeEach(async () => {
    d = await buatDunia();
  });
  afterEach(async () => {
    await d?.tutup();
  });

  /** Everything a period needs to be closeable, minus whatever the test breaks. */
  async function siapkan(tahun: number, bulan: number) {
    const p = d.periode(tahun, bulan);
    await d.tutupPeriodeSampai(p);
    d.setelJam(p.tanggalMulai);
    // Fund the branch so spec 8.4 check 8 (negative cash) is not a warning
    // every one of these tests would then have to confirm around.
    await d.postingAlokasiDana(p.tanggalMulai, rp(100_000_000));
    await d.buatAkad({
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: p.tanggalMulai,
    });
    d.setelJam(p.tanggalAkhir);
    return p;
  }

  test("8.5.8 closing periode ditolak kalau masih ada jurnal DRAFT", async () => {
    const p = await siapkan(2026, 1);
    await d.siapkanTutup(p);
    const draft = await d.buatJurnalDraft(p.tanggalAkhir, rp(250_000));
    expect(draft.status).toBe("DRAFT");

    const err = await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.PRASYARAT_GAGAL,
    );

    const gagal = err.detail.gagal as Array<{ kode: string; nomor: number; alasan: string }>;
    const cek = gagal.find((g) => g.kode === "ADA_JURNAL_DRAFT");
    expect(cek).toBeDefined();
    expect(cek?.nomor).toBe(PRASYARAT_CLOSING.ADA_JURNAL_DRAFT);
    alasanTerbaca(cek?.alasan ?? "");
    // Spec 16 scenario 12 asks for a reason clear enough to act on, so the
    // offending document has to be named.
    expect(JSON.stringify(err.detail)).toContain(draft.noJurnal);

    // Nothing moved.
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    expect(await d.bacaSaldoAkunPeriode(p.id)).toHaveLength(0);
  });

  test("8.5.9 closing periode ditolak kalau sub ledger piutang tidak cocok dengan buku besar", async () => {
    const p = await siapkan(2026, 1);
    const akad = await d.buatAkad({
      hariTunggakan: 20,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: p.tanggalMulai,
    });
    await d.siapkanTutup(p);

    // The divergence, manufactured the only way it can happen: the sub-ledger
    // moves without a journal. `pumk_akad` is not a ledger table, so this does
    // not defeat invariant 11.
    await d.rusakSubLedger(akad.akadId, rp(7_500_000));
    expect((await d.rekonsiliasi(akad.akadId)).selisih).not.toBe("0.00");

    const err = await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.PRASYARAT_GAGAL,
    );
    const gagal = err.detail.gagal as Array<{ kode: string; nomor: number; alasan: string; detail: Record<string, unknown> }>;
    const cek = gagal.find((g) => g.kode === "SUB_LEDGER_TIDAK_COCOK");
    expect(cek).toBeDefined();
    expect(cek?.nomor).toBe(PRASYARAT_CLOSING.SUB_LEDGER_TIDAK_COCOK);
    alasanTerbaca(cek?.alasan ?? "");
    // spec 8.4 check 10: "tampilkan daftar akad yang menyebabkan selisih". The
    // list is the whole value of this check; a bare "tidak cocok" leaves an
    // accountant with a blocked close and nowhere to look.
    expect(JSON.stringify(cek?.detail ?? {})).toContain(akad.akadId);
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
  });

  test("8.5.10 closing Maret ditolak kalau Februari masih OPEN", async () => {
    const jan = d.periode(2026, 1);
    const feb = d.periode(2026, 2);
    const mar = d.periode(2026, 3);
    await d.tutupPeriodeLangsung(jan);
    expect((await d.bacaPeriode(feb.id)).status).toBe("OPEN");

    d.setelJam(mar.tanggalAkhir);
    await d.siapkanTutup(mar);

    const err = await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: mar.id }, d.ctx.approver),
      KODE_CLOSING.PRASYARAT_GAGAL,
    );
    const gagal = err.detail.gagal as Array<{ kode: string; nomor: number; alasan: string }>;
    const cek = gagal.find((g) => g.kode === "PERIODE_SEBELUMNYA_BELUM_CLOSED");
    expect(cek).toBeDefined();
    expect(cek?.nomor).toBe(PRASYARAT_CLOSING.PERIODE_SEBELUMNYA_BELUM_CLOSED);
    alasanTerbaca(cek?.alasan ?? "");

    // Invariant 6 is also a database trigger (TJSL-PER-001). The engine must
    // refuse FIRST, with a domain error, so the trigger stays a backstop and
    // its text never reaches a user. `tolakDengan` already asserted the message
    // carries no trigger code; this asserts nothing was written either.
    expect((await d.bacaPeriode(mar.id)).status).toBe("OPEN");
    expect((await d.bacaPeriode(feb.id)).status).toBe("OPEN");
  });

  test("8.5.11 setelah periode CLOSED, mencoba posting jurnal bertanggal di periode itu ditolak", async () => {
    const p = await siapkan(2026, 1);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    expect((await d.bacaPeriode(p.id)).status).toBe("CLOSED");

    // Invariant 5, and spec 16 scenario 13. Asserted against the REAL ledger
    // engine rather than against a fixture opinion: the closing engine's job
    // was to put the period in the state that makes this refusal happen.
    let ditangkap: unknown;
    try {
      await d.postingBebanOperasional(p.tanggalAkhir, rp(1_000_000));
    } catch (e) {
      ditangkap = e;
    }
    expect(ditangkap).toBeInstanceOf(JurnalError);
    expect((ditangkap as JurnalError).kode).toBe("PERIODE_TIDAK_OPEN");

    // A DRAFT dated in the closed period is refused too: invariant 5 is about
    // the transaction date, not about the posting step.
    let ditangkapDraft: unknown;
    try {
      await d.buatJurnalDraft(p.tanggalMulai, rp(1_000));
    } catch (e) {
      ditangkapDraft = e;
    }
    expect(ditangkapDraft).toBeInstanceOf(JurnalError);
  });

  test("8.5.12 reopen lalu close ulang menghasilkan snapshot saldo yang identik kalau tidak ada perubahan data", async () => {
    const p = await siapkan(2026, 1);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    const sebelum = await d.bacaSaldoAkunPeriode(p.id);
    expect(sebelum.length).toBeGreaterThan(0);

    await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Koreksi klasifikasi beban, permintaan KAP (fixture)" },
      d.ctx.adminPusat,
    );
    // spec 8.4: reopening DELETES the frozen balances. Safe precisely because
    // they are derived data, fully regenerable from the ledger.
    expect(await d.bacaSaldoAkunPeriode(p.id)).toHaveLength(0);
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");

    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    const sesudah = await d.bacaSaldoAkunPeriode(p.id);

    // IDENTICAL, to the sen, row for row. This is invariant 14 stated as an
    // experiment: a report of a past period must produce the same numbers
    // whenever it is run, so re-deriving the frozen balances from unchanged
    // data must be a no-op.
    expect(sesudah).toEqual(sebelum);
  });
});
