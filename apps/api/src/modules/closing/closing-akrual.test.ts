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
import { buatDunia, jumlahUang, tolakDengan, type DuniaClosing } from "./test-support";

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

  test("konfigurasi metode yang hilang di dua level ditolak, bukan diasumsikan ACCRUAL", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await akadJatuhTempoDiPeriode(d, p.tanggalAkhir, 10);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    await d.hapusKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm");
    await d.db.query(
      `update konfigurasi set deleted_at = now()
        where bumn_id is null and grup = 'akuntansi' and kunci = 'metode_pengakuan_jasa_adm'
          and deleted_at is null`,
    );

    // Defaulting in code to the spec's ACCRUAL would post real journals under a
    // policy nobody selected, in a client's audited accounts, and nothing in
    // the ledger would record that the choice was made by a fallback.
    await tolakDengan(
      () => d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.KONFIGURASI_TIDAK_ADA,
    );
    expect(await d.bacaAkrual(p.id)).toHaveLength(0);
  });
});

describe("spec 8.3: populasi mengikuti akrual_hanya_untuk_kolektibilitas", () => {
  test("kelas di luar daftar tidak diakru; menambahkannya ke daftar membuatnya ikut", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const lancar = await akadJatuhTempoDiPeriode(d, p1.tanggalAkhir, 10);
    const macet = await akadJatuhTempoDiPeriode(d, p1.tanggalAkhir, 300);

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const sempit = await d.engine.jalankanAkrualJasaAdm({ periodeId: p1.id }, d.ctx.approver);

    expect(sempit.kelasDiakrual).toEqual(["LANCAR"]);
    expect(sempit.baris.map((b) => b.akadId)).toEqual([lancar.akadId]);

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
      [lancar.akadId, macet.akadId].sort(),
    );
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
