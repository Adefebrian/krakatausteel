// SPEC 8.3, AKRUAL JASA ADMINISTRASI.
//
// NO TEST IN THIS FILE ASSERTS WHICH RECOGNITION METHOD IS CORRECT.
//
// That is not modesty, it is the point. Spec 5.6 ships ACCRUAL as a DEFAULT,
// spec 5's preamble makes every parameter in section 5 the client accounting
// team's decision, and OPEN-QUESTIONS.md still carries "metode pengakuan jasa
// administrasi, cash basis atau akrual?" as unanswered. A test asserting that
// a journal was accrued would be this repository deciding an accounting policy
// on the client's behalf and then defending the decision with a red build.
//
// What IS asserted, in every test below, is the MECHANIC: whichever method the
// `konfigurasi` row names is the method that runs, and switching the row
// switches the behaviour with no deploy. The same applies to
// `akrual_hanya_untuk_kolektibilitas`: the tests change the list and assert the
// population follows it, never that `["LANCAR"]` is the right list.
//
// One thing here is NOT policy and is asserted flatly: CASH_BASIS produces no
// journal and no snapshot, and that is a legitimate outcome rather than a
// silent skip. The result carries `metode`, so the reason nothing happened is
// recorded in the result rather than inferred from its emptiness. A closing
// that quietly does nothing and reports success is the failure mode this
// distinction exists to prevent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_CLOSING } from "./contract";
import {
  buatDunia,
  jumlahUang,
  selisihHari,
  tolakDengan,
  type DuniaClosing,
} from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/** An akad whose first instalment falls due INSIDE the given period, unpaid. */
async function akadJatuhTempoDiPeriode(
  dunia: DuniaClosing,
  padaTanggal: string,
  hariTunggakan: number,
) {
  return dunia.buatAkad({
    hariTunggakan,
    padaTanggal,
    tanggalPencairan: "2026-01-05",
  });
}

describe("spec 8.3: metode pengakuan dibaca dari konfigurasi", () => {
  test("ACCRUAL mengakru jasa yang jatuh tempo tapi belum diterima kas", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    const jadwal = await d.bacaJadwal(akad.akadId);
    const jatuhDiPeriode = jadwal.filter(
      (r) => r.tanggal_jatuh_tempo >= p.tanggalMulai && r.tanggal_jatuh_tempo <= p.tanggalAkhir,
    );
    expect(jatuhDiPeriode).toHaveLength(1);
    const jasaPeriode = jatuhDiPeriode[0].jasa_adm;

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    d.jurnal.reset();
    const hasil = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);

    expect(hasil.metode).toBe("ACCRUAL");
    expect(hasil.dilewati).toBe(false);
    expect(hasil.baris).toHaveLength(1);
    expect(hasil.baris[0].akadId).toBe(akad.akadId);
    expect(hasil.baris[0].kolektibilitas).toBe("LANCAR");
    expect(hasil.baris[0].jasaJatuhTempoPeriode).toBe(jasaPeriode);
    expect(hasil.baris[0].jasaDiterimaPeriode).toBe("0.00");
    expect(hasil.baris[0].jasaDiakrual).toBe(jasaPeriode);

    // spec 8.3 step 2: one AKRUAL_JASA_ADM per branch, for the total.
    const posting = d.jurnal.panggilan.filter((c) => c.eventCode === "AKRUAL_JASA_ADM");
    expect(posting).toHaveLength(1);
    expect((posting[0].argumen as { nilai: string }).nilai).toBe(jasaPeriode);
    expect(hasil.totalPerCabang).toHaveLength(1);
    expect(hasil.totalPerCabang[0].total).toBe(jasaPeriode);
    expect(hasil.totalPerCabang[0].jurnalId).not.toBeNull();

    // The receivable for the accrued fee, which is what
    // ANGSURAN_JASA_ADM_AKRUAL later credits instead of income (spec 8.3
    // step 3). Debit-positive, so an asset is positive.
    expect(await d.saldoLedger(d.akun.piutangJasa.id, p.tanggalAkhir)).toBe(jasaPeriode);
  });

  test("CASH_BASIS tidak menulis snapshot, tidak memposting jurnal, dan MENGATAKAN kenapa", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "CASH_BASIS");

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    d.jurnal.reset();
    const hasil = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);

    expect(hasil.metode).toBe("CASH_BASIS");
    // `dilewati` plus `metode` is what separates "policy says do nothing" from
    // "something went wrong and produced nothing". An empty result alone cannot
    // tell those apart, and the second one must never be reported as success.
    expect(hasil.dilewati).toBe(true);
    expect(hasil.baris).toEqual([]);
    expect(hasil.totalPerCabang).toEqual([]);
    expect(d.jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaAkrual(p.id)).toHaveLength(0);
    expect(await d.saldoLedger(d.akun.piutangJasa.id, p.tanggalAkhir)).toBe("0.00");
  });

  test("mengubah baris konfigurasi mengubah metode yang berjalan, tanpa deploy", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    await akadJatuhTempoDiPeriode(d, p1.tanggalAkhir, 10);

    d.setelJam(p1.tanggalAkhir);
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "CASH_BASIS");
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const kas = await d.engine.jalankanAkrualJasaAdm({ periodeId: p1.id }, d.ctx.approver);
    expect(kas.dilewati).toBe(true);

    d.setelJam(p2.tanggalAkhir);
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const akrual = await d.engine.jalankanAkrualJasaAdm({ periodeId: p2.id }, d.ctx.approver);

    expect(akrual.metode).toBe("ACCRUAL");
    expect(akrual.dilewati).toBe(false);
    // Whichever method the client eventually confirms, this is the assertion
    // that survives the decision.
    expect(kas.metode).not.toBe(akrual.metode);
  });

  test("metode yang tidak terselesaikan ke nilai apa pun ditolak, bukan diasumsikan ACCRUAL", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    // THE PARAMETER IS EMPTIED, NOT DELETED, AND THE GLOBAL ROW IS LEFT ALONE.
    //
    // An earlier version of this test soft-deleted the SHIPPED (bumn_id IS
    // NULL) row so the key would be absent at both levels. Two things were
    // wrong with that, and the second is much worse than the first:
    //
    //   1. it omitted `deleted_by`, so `konfigurasi_soft_delete_ck` raised
    //      23514 inside the test body before the engine was ever called;
    //   2. `tjsl_test` is shared, and EVERY world in the process resolves
    //      through that one global row. Deleting it without restoring it
    //      poisons every suite that runs afterwards, in a database several
    //      agents are using at once. That class of cross-test contamination
    //      has already cost this project several hundred phantom failures.
    //
    // A `finally` that restored the row would still leave a window in which
    // another process could observe it, so the row is not touched at all.
    // Instead the world's OWN bumn-scoped row is set to blank, which is the
    // state an operator produces by clearing the field in the Konfigurasi
    // screen. That row wins the resolution order (bumn-scoped over global), so
    // the parameter resolves to nothing for THIS bumn and for no other.
    //
    // It reaches the same guard by the same route: the engine refuses when the
    // value resolves to null OR to blank, which is the honest statement of the
    // requirement anyway. "No row anywhere" and "a row an operator emptied" are
    // the same fact to a calculation that needs a value.
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "");

    // Defaulting in code to the spec's ACCRUAL would post real journals under a
    // policy nobody selected, in a client's audited accounts, and nothing in
    // the ledger would record that the choice was made by a fallback.
    const err = await tolakDengan(
      () => d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.KONFIGURASI_TIDAK_ADA,
    );
    // The refusal names the key, because an operator who cannot see WHICH
    // parameter is missing has a fail-closed guard and no way to clear it.
    expect(err.message).toContain("akuntansi.metode_pengakuan_jasa_adm");
    expect(await d.bacaAkrual(p.id)).toHaveLength(0);

    // The shipped default is still exactly where it was, for every other world.
    const global = await d.db.query<{ nilai: string | null }>(
      `select nilai from konfigurasi
        where bumn_id is null and grup = 'akuntansi' and kunci = 'metode_pengakuan_jasa_adm'
          and deleted_at is null`,
    );
    expect(global).toHaveLength(1);
  });
});

describe("spec 8.3: populasi mengikuti akrual_hanya_untuk_kolektibilitas", () => {
  test("kelas di luar daftar tidak diakru; menambahkannya ke daftar membuatnya ikut", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const lancarP1 = await akadJatuhTempoDiPeriode(d, p1.tanggalAkhir, 10);
    const macet = await akadJatuhTempoDiPeriode(d, p1.tanggalAkhir, 300);

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const sempit = await d.engine.jalankanAkrualJasaAdm({ periodeId: p1.id }, d.ctx.approver);

    expect(sempit.kelasDiakrual).toEqual(["LANCAR"]);
    expect(sempit.baris.map((b) => b.akadId)).toEqual([lancarP1.akadId]);

    // P2 GETS A FRESH AKAD RATHER THAN REUSING `lancarP1`, and that is the
    // whole subtlety of this test.
    //
    // Nobody pays `lancarP1`, so its arrears keep growing: 10 days at p1's end
    // is 41 days at p2's end, which the fixture bands classify as
    // KURANG_LANCAR. Since the population is filtered on the CURRENT period's
    // snapshot (asserted directly in the next test), an earlier version of this
    // test that expected `lancarP1` back under a `["LANCAR","MACET"]` list was
    // asking for something no correct implementation can do. The akad that must
    // be LANCAR at p2 is therefore built to be LANCAR at p2.
    //
    // Disbursed inside p2, so spec 8.1 step 1's population (AKTIF /
    // RESCHEDULED / MACET) correctly excluded it from p1 a moment ago.
    const lancarP2 = await d.buatAkad({
      hariTunggakan: 10,
      padaTanggal: p2.tanggalAkhir,
      janganCairkan: true,
    });
    d.setelJam(p2.tanggalMulai);
    await d.cairkan(lancarP2.akadId, p2.tanggalMulai);

    // The reason the default list is narrow is stated in spec 5.6 itself
    // ("jasa administrasi tidak diakrual untuk piutang bermasalah"), but the
    // list is still a parameter, so widening it must work.
    await d.setelKonfigurasi(
      "akuntansi",
      "akrual_hanya_untuk_kolektibilitas",
      '["LANCAR","MACET"]',
    );
    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const lebar = await d.engine.jalankanAkrualJasaAdm({ periodeId: p2.id }, d.ctx.approver);

    expect(lebar.kelasDiakrual).toEqual(["LANCAR", "MACET"]);
    expect(lebar.baris.map((b) => b.akadId).sort()).toEqual(
      [lancarP2.akadId, macet.akadId].sort(),
    );
    // And `lancarP1` is absent, not because the list shrank but because the
    // AKAD moved. Left as an assertion rather than a comment: it is the only
    // thing separating "the list is honoured" from "the list is ignored and
    // everything accrues".
    expect(lebar.baris.map((b) => b.akadId)).not.toContain(lancarP1.akadId);
  });

  test("kelas yang memburuk antar periode keluar dari populasi akrual tanpa konfigurasi berubah", async () => {
    // THE DRIFT, PINNED ON ITS OWN.
    //
    // This is ordinary behaviour, not an edge case: an unpaid akad ages one
    // month per month and crosses a band without anyone touching it. Two things
    // follow, and both matter to an accountant reading the accrual report.
    //
    // First, the population is a property of THE PERIOD, not of the akad: it is
    // filtered on the current period's `kolektibilitas_snapshot`, so an akad
    // that qualified last month can drop out this month. Second, that is spec
    // 5.6 working as intended ("jasa administrasi tidak diakrual untuk piutang
    // bermasalah"): the moment a receivable stops performing, the system stops
    // recognising income it is unlikely to collect.
    //
    // No configuration changes anywhere in this test. Only time passes.
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const akad = await akadJatuhTempoDiPeriode(d, p1.tanggalAkhir, 10);

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const awal = await d.engine.jalankanAkrualJasaAdm({ periodeId: p1.id }, d.ctx.approver);
    expect((await d.bacaSnapshot(p1.id))[0].kolektibilitas).toBe("LANCAR");
    expect(awal.baris.map((b) => b.akadId)).toEqual([akad.akadId]);

    // One month later, unpaid. The first instalment was due 10 days before p1
    // ended and is now that much older; the fixture bands put anything past 30
    // days into KURANG_LANCAR.
    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const snapshot = (await d.bacaSnapshot(p2.id))[0];
    expect(snapshot.hari_tunggakan).toBe(
      selisihHari(akad.tanggalMulaiAngsuran, p2.tanggalAkhir),
    );
    expect(snapshot.kolektibilitas).toBe("KURANG_LANCAR");

    d.jurnal.reset();
    const akhir = await d.engine.jalankanAkrualJasaAdm({ periodeId: p2.id }, d.ctx.approver);

    // Same list, same akad, different answer, and the reason is in the snapshot
    // rather than in the configuration.
    expect(akhir.kelasDiakrual).toEqual(["LANCAR"]);
    expect(akhir.metode).toBe("ACCRUAL");
    expect(akhir.dilewati).toBe(false);
    expect(akhir.baris).toEqual([]);
    expect(akhir.totalPerCabang).toEqual([]);
    expect(d.jurnal.panggilan.filter((c) => c.eventCode === "AKRUAL_JASA_ADM")).toHaveLength(0);
  });

  test("akrual ditolak kalau closing kolektibilitas belum dijalankan", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);

    // The population is defined BY class, so without the snapshot there is no
    // class to filter on. Treating "no snapshot" as "no akad qualifies" would
    // silently skip the accrual for the whole portfolio and leave check 6
    // satisfied by an empty run.
    await tolakDengan(
      () => d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.KOLEKTIBILITAS_BELUM_DIJALANKAN,
    );
    expect(await d.bacaAkrual(p.id)).toHaveLength(0);
  });
});

describe("spec 8.3: jasa yang sudah diterima kas tidak diakru dua kali", () => {
  test("jasa yang dibayar di dalam periode mengurangi akrual sampai nol", async () => {
    const p = d.periode(2027, 6);
    const akad = await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    const jadwal = await d.bacaJadwal(akad.akadId);
    const barisPeriode = jadwal.find(
      (r) => r.tanggal_jatuh_tempo >= p.tanggalMulai && r.tanggal_jatuh_tempo <= p.tanggalAkhir,
    );
    expect(barisPeriode).toBeDefined();

    // The instalment is paid in full, in cash, inside the period. Accruing it
    // as well would recognise the same fee twice: once as Piutang Jasa
    // Administrasi and once as cash income, and the receivable would never
    // clear because no ANGSURAN_JASA_ADM_AKRUAL was ever posted against it.
    const tanggalBayar = barisPeriode?.tanggal_jatuh_tempo ?? p.tanggalAkhir;
    d.setelJam(tanggalBayar);
    await d.bayarSetoran(akad.akadId, tanggalBayar, barisPeriode?.total ?? "0.00");

    d.setelJam(p.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    d.jurnal.reset();
    const hasil = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);

    const baris = hasil.baris.find((b) => b.akadId === akad.akadId);
    expect(baris?.jasaJatuhTempoPeriode).toBe(barisPeriode?.jasa_adm);
    expect(baris?.jasaDiterimaPeriode).toBe(barisPeriode?.jasa_adm);
    expect(baris?.jasaDiakrual).toBe("0.00");
    // Nothing to accrue means nothing to post.
    expect(d.jurnal.panggilan.filter((c) => c.eventCode === "AKRUAL_JASA_ADM")).toHaveLength(0);
  });

  test("akrual tidak pernah negatif walaupun setoran melebihi jasa periode itu", async () => {
    // Invariant 10 in a different costume: a surplus is a `pumk_kelebihan` row,
    // not a negative receivable, so it must not become a negative accrual that
    // silently reduces someone else's.
    const p = d.periode(2027, 6);
    const akad = await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    const jadwal = await d.bacaJadwal(akad.akadId);

    const tanggalBayar = jadwal[0].tanggal_jatuh_tempo;
    d.setelJam(tanggalBayar);
    await d.bayarSetoran(
      akad.akadId,
      tanggalBayar,
      jumlahUang(jadwal[0].total, jadwal[1].total, jadwal[2].total),
    );

    d.setelJam(p.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const hasil = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);

    for (const b of hasil.baris) {
      expect(b.jasaDiakrual).toMatch(/^\d+\.\d{2}$/);
    }
  });
});

describe("spec 8.3: idempotensi dan cakupan cabang", () => {
  test("menjalankan akrual dua kali tidak menggandakan jurnal maupun snapshot", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    const pertama = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);
    const jurnalSetelahSatu = await d.jumlahJurnalPeriode(p.id);
    const snapshotSetelahSatu = await d.bacaAkrual(p.id);

    const kedua = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);

    // Invariant 13. `akrual_jasa_snapshot_uq` is (periode, akad), so a second
    // run must rewrite rather than insert, and the journal is keyed by
    // `kunci_idempotensi` so it cannot be posted twice.
    expect(kedua.totalPerCabang).toEqual(pertama.totalPerCabang);
    expect(await d.jumlahJurnalPeriode(p.id)).toBe(jurnalSetelahSatu);
    expect(await d.bacaAkrual(p.id)).toEqual(snapshotSetelahSatu);
  });

  test("akrual diposting per cabang, bukan satu jurnal gabungan", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    await d.buatAkad({
      hariTunggakan: 10,
      padaTanggal: p.tanggalAkhir,
      cabangId: d.cabangLainId,
      tanggalPencairan: "2026-01-05",
    });

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.adminPusat);
    d.jurnal.reset();
    const hasil = await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.adminPusat);

    expect(hasil.totalPerCabang).toHaveLength(2);
    expect(hasil.totalPerCabang.map((t) => t.cabangId).sort()).toEqual(
      [d.cabangId, d.cabangLainId].sort(),
    );
    expect(d.jurnal.panggilan.filter((c) => c.eventCode === "AKRUAL_JASA_ADM")).toHaveLength(2);
    // Every branch-level report in spec 10 depends on the split existing in the
    // ledger rather than being derived later.
    for (const panggilan of d.jurnal.panggilan) {
      const arg = panggilan.argumen as { cabangId: string };
      expect([d.cabangId, d.cabangLainId]).toContain(arg.cabangId);
    }
  });

  test("jurnal akrual gagal membatalkan seluruh langkah", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    d.jurnal.gagalkan("AKRUAL_JASA_ADM");

    await tolakDengan(
      () => d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.JURNAL_GAGAL,
    );
    // A snapshot without its journal would satisfy check 6 while the ledger
    // carried no accrual at all.
    expect(await d.bacaAkrual(p.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE ACCRUAL AND THE RECEIPT, END TO END (migrations/0030)
// ---------------------------------------------------------------------------
//
// The one thing spec 8.3 could not prove on its own. The close's arithmetic was
// always right, and so was the receipt's; what was wrong was that the receipt
// decided WHICH ACCOUNT to credit from a single configuration cell
// (`akuntansi.metode_pengakuan_jasa_adm`) instead of from whether that jasa had
// actually been accrued. The cell ships as ACCRUAL, so every receipt credited
// Piutang Jasa Administrasi (1.1.04); an instalment paid in the month it fell
// due was never accrued, so nothing ever debited it. Twenty four months of the
// demo world drove 1.1.04 to roughly MINUS Rp 87,5 juta with almost no jasa
// income, and every integrity check passed, because the missing income kept the
// balance sheet balanced.
//
// Only a test that runs BOTH engines can see it. Each module's own suite was
// green throughout.
//
// NOTHING HERE ASSERTS A RECOGNITION POLICY, exactly as the file header says:
// the accrual runs because the world's `konfigurasi` says ACCRUAL, and the
// third test flips `akrual_hanya_untuk_kolektibilitas` rather than claiming a
// value for it. What is asserted is that the ledger ends where the arithmetic
// says it should, whichever policy is in force.
describe("spec 8.3 + spec 7.2: piutang jasa yang diakrual harus bisa ditagih sampai nol", () => {
  // 12.000.000,00 FLAT 3 percent over 12 months: total jasa 360.000,00 across
  // twelve rows of pokok 1.000.000,00 + jasa 30.000,00 = 1.030.000,00. With
  // `hariTunggakan: 10` against 30 June 2027, row 1 falls due 20 June 2027 and
  // it is the only row inside the period.
  const JASA_BARIS = "30000.00";
  const ANGSURAN_BARIS = "1030000.00";

  test("diakrual di Juni, ditagih di Juli: 1.1.04 kembali NOL dan pendapatan diakui SEKALI", async () => {
    const juni = d.periode(2027, 6);
    const juli = d.periode(2027, 7);
    d.setelJam(juni.tanggalAkhir);
    const akad = await akadJatuhTempoDiPeriode(d, juni.tanggalAkhir, 10);

    await d.engine.jalankanKolektibilitas({ periodeId: juni.id }, d.ctx.approver);
    const akrual = await d.engine.jalankanAkrualJasaAdm({ periodeId: juni.id }, d.ctx.approver);
    expect(akrual.baris.find((b) => b.akadId === akad.akadId)?.jasaDiakrual).toBe(JASA_BARIS);

    // The receivable exists in the ledger...
    expect(await d.saldoLedger(d.akun.piutangJasa.id, juni.tanggalAkhir)).toBe(JASA_BARIS);
    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id, juni.tanggalAkhir)).toBe("-30000.00");

    // ...AND on the schedule row it belongs to, which is the fact the receipt
    // reads. Without it the receipt has to guess, and guessing is the defect.
    const jadwal = await d.bacaJadwal(akad.akadId);
    expect(jadwal[0].jasa_akrual_belum_tertagih).toBe(JASA_BARIS);

    d.setelJam("2027-07-05");
    const setoran = await d.bayarSetoran(akad.akadId, "2027-07-05", ANGSURAN_BARIS);
    expect(setoran.alokasiJasa).toBe(JASA_BARIS);
    expect(setoran.alokasiJasaAkrual).toBe(JASA_BARIS);
    expect(setoran.alokasiJasaLangsung).toBe("0.00");

    // THE ASSERTION THE WHOLE FIX EXISTS FOR.
    expect(await d.saldoLedger(d.akun.piutangJasa.id, juli.tanggalAkhir)).toBe("0.00");
    // Recognised ONCE, by the close, and not again by the receipt.
    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id, juli.tanggalAkhir)).toBe("-30000.00");
    expect((await d.bacaJadwal(akad.akadId))[0].jasa_akrual_belum_tertagih).toBe("0.00");
  });

  test("dibayar di bulan jatuh temponya sebelum closing: 1.1.04 tidak pernah bergerak", async () => {
    // The exact shape of the demo defect. The close correctly accrues nothing,
    // because the fee was collected in cash inside the period; the receipt must
    // therefore recognise the income itself. Before the fix it credited 1.1.04
    // instead, and 1.1.04 went to -30.000,00 with no income anywhere.
    const juni = d.periode(2027, 6);
    d.setelJam(juni.tanggalAkhir);
    const akad = await akadJatuhTempoDiPeriode(d, juni.tanggalAkhir, 10);
    const jatuhTempo = (await d.bacaJadwal(akad.akadId))[0].tanggal_jatuh_tempo;

    d.setelJam(jatuhTempo);
    const setoran = await d.bayarSetoran(akad.akadId, jatuhTempo, ANGSURAN_BARIS);
    expect(setoran.alokasiJasaAkrual).toBe("0.00");
    expect(setoran.alokasiJasaLangsung).toBe(JASA_BARIS);

    d.setelJam(juni.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: juni.id }, d.ctx.approver);
    const akrual = await d.engine.jalankanAkrualJasaAdm({ periodeId: juni.id }, d.ctx.approver);
    expect(akrual.baris.find((b) => b.akadId === akad.akadId)?.jasaDiakrual).toBe("0.00");

    expect(await d.saldoLedger(d.akun.piutangJasa.id, juni.tanggalAkhir)).toBe("0.00");
    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id, juni.tanggalAkhir)).toBe("-30000.00");
  });

  test("akad di luar kelas yang diakrual: setorannya pendapatan langsung, bukan pelunasan piutang", async () => {
    // The standard non-performing treatment, and it needs no branch of its own:
    // the close never touched this akad, so its rows carry no accrued balance
    // and every rupiah collected is income now.
    const juni = d.periode(2027, 6);
    const juli = d.periode(2027, 7);
    await d.setelKonfigurasi("akuntansi", "akrual_hanya_untuk_kolektibilitas", '["MACET"]');
    d.setelJam(juni.tanggalAkhir);
    const akad = await akadJatuhTempoDiPeriode(d, juni.tanggalAkhir, 10);

    await d.engine.jalankanKolektibilitas({ periodeId: juni.id }, d.ctx.approver);
    const akrual = await d.engine.jalankanAkrualJasaAdm({ periodeId: juni.id }, d.ctx.approver);
    expect(akrual.kelasDiakrual).toEqual(["MACET"]);
    expect(akrual.baris.find((b) => b.akadId === akad.akadId)).toBeUndefined();
    expect((await d.bacaJadwal(akad.akadId))[0].jasa_akrual_belum_tertagih).toBe("0.00");
    expect(await d.saldoLedger(d.akun.piutangJasa.id, juni.tanggalAkhir)).toBe("0.00");

    d.setelJam("2027-07-05");
    const setoran = await d.bayarSetoran(akad.akadId, "2027-07-05", ANGSURAN_BARIS);
    expect(setoran.alokasiJasaAkrual).toBe("0.00");
    expect(setoran.alokasiJasaLangsung).toBe(JASA_BARIS);
    expect(await d.saldoLedger(d.akun.piutangJasa.id, juli.tanggalAkhir)).toBe("0.00");
    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id, juli.tanggalAkhir)).toBe("-30000.00");
  });

  test("akrual dijalankan ulang sesudah setoran tidak menggandakan saldo baris", async () => {
    // Invariant 13 lets a period's accrual be re-run while it is still OPEN.
    // The per-row balance is SET to `jasa_adm - jasa_terbayar`, never added to,
    // so a second run after a collection lands on the smaller correct number.
    const juni = d.periode(2027, 6);
    d.setelJam(juni.tanggalAkhir);
    const akad = await akadJatuhTempoDiPeriode(d, juni.tanggalAkhir, 10);

    await d.engine.jalankanKolektibilitas({ periodeId: juni.id }, d.ctx.approver);
    await d.engine.jalankanAkrualJasaAdm({ periodeId: juni.id }, d.ctx.approver);
    expect((await d.bacaJadwal(akad.akadId))[0].jasa_akrual_belum_tertagih).toBe(JASA_BARIS);

    // Half the fee is collected before the month is closed.
    d.setelJam("2027-06-25");
    const setoran = await d.bayarSetoran(akad.akadId, "2027-06-25", "15000.00");
    expect(setoran.alokasiJasaAkrual).toBe("15000.00");
    expect((await d.bacaJadwal(akad.akadId))[0].jasa_akrual_belum_tertagih).toBe("15000.00");

    d.setelJam(juni.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: juni.id }, d.ctx.approver);
    const ulang = await d.engine.jalankanAkrualJasaAdm({ periodeId: juni.id }, d.ctx.approver);
    expect(ulang.baris.find((b) => b.akadId === akad.akadId)?.jasaDiakrual).toBe("15000.00");
    expect((await d.bacaJadwal(akad.akadId))[0].jasa_akrual_belum_tertagih).toBe("15000.00");

    // NO LEDGER ASSERTION HERE, AND THE SILENCE IS NOT APPROVAL. A second run
    // whose total changed posts a SECOND AKRUAL_JASA_ADM journal without
    // reversing the first, so 1.1.04 reads 30.000,00 while the sub-ledger
    // correctly reads 15.000,00. That is a separate, pre-existing defect in
    // `jalankanAkrualJasaAdm`'s idempotency (the key carries the total, and
    // `hapusAkrual` removes only the snapshot rows), it is measured and
    // written up in OPEN-QUESTIONS item 29, and asserting the wrong number
    // here would make it look decided.
  });
});
