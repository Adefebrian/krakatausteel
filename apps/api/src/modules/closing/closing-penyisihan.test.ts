// SPEC 8.2, PERHITUNGAN DAN JURNAL PENYISIHAN.
//
// The arithmetic is four lines long and the specification states it plainly.
// What this file is really about is the two places the specification's own
// wording will lead an implementation astray.
//
// FIRST: `saldo_penyisihan_awal` is "saldo akun Penyisihan Penurunan Nilai
// Piutang di akhir periode sebelumnya". That is a LEDGER BALANCE. It is
// tempting, and much easier, to compute it as the SUM of the previous period's
// `nilai_penyisihan`, because in a quiet month the two agree exactly. They stop
// agreeing the moment anything other than closing touches the allowance, and
// the thing that touches it is a WRITE-OFF. After a write-off the snapshot sum
// still says the allowance is intact while the ledger says it was spent, so the
// next period's expense comes out understated by exactly the amount written
// off, the allowance rebuilds itself out of nothing, and every journal balances
// throughout. `./closing-penyisihan.test.ts` writes an akad off between two
// periods and asserts the difference.
//
// SECOND: spec 6.4 gives `HAPUS_BUKU_PIUTANG` a 100 percent debit to the
// allowance, which is only right when the allowance covers the outstanding.
// docs/REGULASI.md finding 4 says it usually does not, and modules/jurnal
// already solved it: `postingHapusBukuPiutang` consumes what exists and routes
// the remainder to `HAPUS_BUKU_KEKURANGAN_PENYISIHAN`. The closing engine must
// not reintroduce the naive path, and the tests below assert it never posts
// that event at all.
//
// The RATES are config data throughout. The fixture seeds rates that are not
// the spec's (see `RATE_AWAL`), and every expectation reads the rate back out
// of `penyisihan_rate` rather than restating a number.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_CLOSING } from "./contract";
import {
  buatDunia,
  jumlahUang,
  kaliRate,
  keSen,
  kurangUang,
  negasiUang,
  rp,
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

describe("spec 8.2: rate adalah data, bukan kode", () => {
  test("mengubah baris penyisihan_rate mengubah kebutuhan penyisihan periode itu", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });

    await d.setelRate("MACET", "0.400000");
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const [rendah] = await d.engine.hitungPenyisihan({ periodeId: p.id }, d.ctx.approver);
    expect(rendah.penyisihanDibutuhkan).toBe(kaliRate(akad.pokok, "0.400000"));

    await d.setelRate("MACET", "0.900000");
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const [tinggi] = await d.engine.hitungPenyisihan({ periodeId: p.id }, d.ctx.approver);
    expect(tinggi.penyisihanDibutuhkan).toBe(kaliRate(akad.pokok, "0.900000"));

    // No test in this folder claims either number is the right policy. What is
    // asserted is that the number in the table is the number that was used.
    expect(rendah.penyisihanDibutuhkan).not.toBe(tinggi.penyisihanDibutuhkan);
  });

  test("hitungPenyisihan adalah pratinjau: tidak menulis baris dan tidak memposting jurnal", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const jurnalSebelum = await d.jumlahJurnalPeriode(p.id);
    d.jurnal.reset();

    const [pratinjau] = await d.engine.hitungPenyisihan({ periodeId: p.id }, d.ctx.approver);

    expect(pratinjau.id).toBeNull();
    expect(pratinjau.jurnalId).toBeNull();
    expect(await d.bacaPenyisihan(p.id)).toHaveLength(0);
    expect(await d.jumlahJurnalPeriode(p.id)).toBe(jurnalSebelum);
    expect(d.jurnal.panggilan).toHaveLength(0);
  });

  test("snapshot menyimpan rate yang dipakai, sehingga periode lampau tetap bisa direkonstruksi", async () => {
    // Invariant 14, and the reason `kolektibilitas_snapshot` carries
    // `rate_penyisihan` at all. Changing the table afterwards must not move a
    // closed period's numbers.
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });

    await d.setelRate("MACET", "0.400000");
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);

    await d.setelRate("MACET", "0.950000");

    const baris = (await d.bacaSnapshot(p.id))[0];
    expect(baris.rate_penyisihan).toBe("0.400000");
    expect(baris.nilai_penyisihan).toBe(kaliRate(akad.pokok, "0.400000"));
    // The Laporan Perhitungan Penyisihan (spec 10.4 #28, spec 16 scenario 17)
    // reconstructs the journal from these rows, so the two must still agree.
    const [tersimpan] = await d.bacaPenyisihan(p.id);
    expect(tersimpan.penyisihan_dibutuhkan).toBe(baris.nilai_penyisihan);
  });
});

describe("spec 8.2: satu jurnal per cabang, lewat postingEvent", () => {
  test("satu jurnal per cabang, dengan kunci idempotensi, tidak satu jurnal per akad", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const a = await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    const b = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    d.jurnal.reset();

    const hasil = await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);

    expect(hasil).toHaveLength(1);
    expect(hasil[0].cabangId).toBe(d.cabangId);
    const rate = await d.bacaRate("MACET");
    expect(hasil[0].penyisihanDibutuhkan).toBe(
      jumlahUang(kaliRate(a.pokok, rate), kaliRate(b.pokok, rate)),
    );

    // ONE call, ONE journal, for two akads. Invariant 11 (every automatic
    // journal through the central path) plus invariant 13 (an idempotency key
    // so a re-run cannot double it).
    const posting = d.jurnal.panggilan.filter((c) => c.eventCode === "BEBAN_PENYISIHAN");
    expect(posting).toHaveLength(1);
    const payload = posting[0].argumen as { kunciIdempotensi?: string | null; cabangId: string };
    expect(payload.cabangId).toBe(d.cabangId);
    expect(payload.kunciIdempotensi ?? "").not.toBe("");

    const jurnal = await d.db.query<{ jenis: string; kunci_idempotensi: string | null }>(
      `select jenis, kunci_idempotensi from jurnal where id = $1`,
      [hasil[0].jurnalId],
    );
    expect(jurnal[0].jenis).toBe("PENYISIHAN");
    expect(jurnal[0].kunci_idempotensi).not.toBeNull();
  });

  test("dua cabang menghasilkan dua baris penyisihan_periode dan dua jurnal", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      cabangId: d.cabangLainId,
      tanggalPencairan: "2026-01-05",
    });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.adminPusat);
    d.jurnal.reset();

    const hasil = await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.adminPusat);

    // spec 8.2 step 5 keys `penyisihan_periode` on (periode, cabang), and the
    // branch-level reports depend on the split being real rather than an
    // allocation done afterwards.
    expect(hasil).toHaveLength(2);
    expect(hasil.map((h) => h.cabangId).sort()).toEqual([d.cabangId, d.cabangLainId].sort());
    expect(new Set(hasil.map((h) => h.jurnalId)).size).toBe(2);
    expect(d.jurnal.panggilan.filter((c) => c.eventCode === "BEBAN_PENYISIHAN")).toHaveLength(2);
    expect(await d.bacaPenyisihan(p.id)).toHaveLength(2);
  });

  test("pergerakan nol tidak memposting jurnal apa pun, dan itu bukan kegagalan", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    d.setelJam(p1.tanggalAkhir);
    await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);

    // A month later, nothing paid and nothing new: the arrears grew but the
    // class and the outstanding did not, so the requirement is unchanged.
    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    d.jurnal.reset();
    const [pen2] = await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);

    expect(pen2.bebanPenyisihanPeriode).toBe("0.00");
    expect(pen2.eventCode).toBeNull();
    expect(pen2.jurnalId).toBeNull();
    // spec 8.2 step 4: "Kalau nol: tidak ada jurnal." A zero-value journal
    // would be rejected by the ledger's own one-side-per-line guard anyway, so
    // the alternative is not a harmless empty entry, it is a failed closing.
    expect(d.jurnal.panggilan).toHaveLength(0);
    // The row itself is still written, because check 5 asks whether the step
    // ran, and "ran and produced nothing" is a different state from "not run".
    expect(await d.bacaPenyisihan(p2.id)).toHaveLength(1);
  });

  test("jurnal gagal membatalkan seluruh langkah, tidak menyisakan baris penyisihan_periode", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    // The ONE thing a double is allowed to do: arm the collaborator's failure.
    // It still never answers in the real engine's place.
    d.jurnal.gagalkan("BEBAN_PENYISIHAN");

    await tolakDengan(
      () => d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.JURNAL_GAGAL,
    );
    // A `penyisihan_periode` row pointing at no journal would tell check 5 the
    // allowance was posted when it was not, and the period would close on it.
    expect(await d.bacaPenyisihan(p.id)).toHaveLength(0);
  });

  test("penyisihan ditolak kalau closing kolektibilitas belum dijalankan", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });

    // Without the snapshot, `penyisihan_dibutuhkan` would be SUM over nothing,
    // i.e. zero, and a portfolio full of MACET akads would post a RECOVERY of
    // the entire existing allowance. Silence is the dangerous answer here.
    await tolakDengan(
      () => d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.KOLEKTIBILITAS_BELUM_DIJALANKAN,
    );
    expect(await d.bacaPenyisihan(p.id)).toHaveLength(0);
  });

  test("menjalankan penyisihan dua kali tidak menggandakan jurnal maupun baris", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    const [pertama] = await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);
    const jurnalSetelahSatu = await d.jumlahJurnalPeriode(p.id);

    const [kedua] = await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);

    expect(kedua.jurnalId).toBe(pertama.jurnalId);
    expect(kedua.bebanPenyisihanPeriode).toBe(pertama.bebanPenyisihanPeriode);
    expect(await d.jumlahJurnalPeriode(p.id)).toBe(jurnalSetelahSatu);
    expect(await d.bacaPenyisihan(p.id)).toHaveLength(1);
  });
});

describe("spec 8.2: saldo awal dibaca dari ledger, bukan dari snapshot periode lalu", () => {
  test("hapus buku yang memakai penyisihan terlihat di kebutuhan periode berikutnya", async () => {
    // THE TEST THIS FILE EXISTS FOR.
    //
    // Period 1: one MACET akad, allowance formed at the configured rate, which
    // is BELOW 100 percent. Between the periods the akad is written off through
    // the real ledger path, which consumes the whole allowance and charges the
    // shortfall. Period 2 must therefore start from an allowance of ZERO.
    //
    // An implementation that computed `saldo_penyisihan_awal` as the SUM of
    // period 1's `nilai_penyisihan` would start period 2 from the pre-write-off
    // figure, and would post a RECOVERY of an allowance that no longer exists.
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const rateMacet = await d.bacaRate("MACET");
    expect(rateMacet).not.toBe("1.000000");

    const macet = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    const lancar = await d.buatAkad({
      hariTunggakan: null,
      padaTanggal: p2.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const [pen1] = await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);
    const dibentuk = kaliRate(macet.pokok, rateMacet);
    expect(pen1.penyisihanDibutuhkan).toBe(dibentuk);
    expect(await d.saldoLedger(d.akun.penyisihan.id, p1.tanggalAkhir)).toBe(negasiUang(dibentuk));

    // The write-off, through modules/jurnal's own method. It consumes
    // min(allowance, outstanding) and routes the rest to
    // HAPUS_BUKU_KEKURANGAN_PENYISIHAN, which is precisely the path the spec's
    // single event does not have.
    const tanggalHapus = `${p2.tahun}-${String(p2.bulan).padStart(2, "0")}-05`;
    d.setelJam(tanggalHapus);
    const hapus = await d.hapusBukuLewatEngine(macet.akadId, tanggalHapus);
    expect(hapus.dariPenyisihan).toBe(dibentuk);
    expect(hapus.kekurangan).toBe(kurangUang(macet.pokok, dibentuk));
    expect(keSen(hapus.kekurangan)).toBeGreaterThan(0n);
    // The contra-asset reached zero and never crossed it.
    expect(await d.saldoLedger(d.akun.penyisihan.id, tanggalHapus)).toBe("0.00");

    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const [pen2] = await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);

    // The only akad left is LANCAR, so nothing is required. THE ASSERTION THAT
    // MATTERS is the opening balance: read from the ledger it is 0.00, and the
    // period's movement is therefore nothing. Read from period 1's snapshots it
    // would be `dibentuk`, and the engine would post a recovery of an allowance
    // the write-off already spent, crediting expense out of thin air.
    expect((await d.bacaSnapshot(p2.id)).map((s) => s.akad_id)).toEqual([lancar.akadId]);
    expect(pen2.penyisihanDibutuhkan).toBe("0.00");
    expect(pen2.saldoPenyisihanAwal).toBe("0.00");
    expect(pen2.saldoPenyisihanAwal).not.toBe(dibentuk);
    expect(pen2.bebanPenyisihanPeriode).toBe("0.00");
    expect(pen2.eventCode).toBeNull();
    expect(await d.saldoLedger(d.akun.penyisihan.id, p2.tanggalAkhir)).toBe("0.00");
  });

  test("closing tidak pernah memposting HAPUS_BUKU_PIUTANG sendiri", async () => {
    // The naive path, stated as a prohibition. Writing an akad off is
    // modules/pumk's decision and modules/jurnal's arithmetic; closing measures
    // the allowance, it does not spend it. If closing ever posted this event it
    // would debit the contra-asset for a full outstanding it never checked, and
    // a contra-ASSET in a debit balance presents as receivables overstated by
    // exactly the amount that was supposed to leave the balance sheet.
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    d.jurnal.reset();

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);
    await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.approver);

    const dipakai = new Set(d.jurnal.panggilan.map((c) => c.eventCode));
    expect(dipakai.has("HAPUS_BUKU_PIUTANG")).toBe(false);
    expect(dipakai.has("HAPUS_BUKU_KEKURANGAN_PENYISIHAN")).toBe(false);
    // Only the three events spec 8 gives this engine.
    for (const kode of dipakai) {
      expect([
        "BEBAN_PENYISIHAN",
        "PEMULIHAN_PENYISIHAN",
        "AKRUAL_JASA_ADM",
      ]).toContain(kode);
    }
  });

  test("saldo awal membaca jurnal REVERSED juga, sehingga pembentukan yang dibalik tidak dihitung dua kali", async () => {
    // ADR 0010, applied to the allowance account. A reversed formation's lines
    // are still in the ledger and are offset by the reversing journal; a
    // POSTED-only read would subtract the reversal without adding the original
    // and report an allowance that never existed, in the negative.
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const akad = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    const [pen1] = await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);

    // The allowance journal is reversed inside period 1, so at the period end
    // the allowance is genuinely zero.
    d.setelJam(p1.tanggalAkhir);
    await d.reversalJurnal(pen1.jurnalId ?? "", "Salah periode, dibalik (fixture)");
    expect(await d.saldoLedger(d.akun.penyisihan.id, p1.tanggalAkhir)).toBe("0.00");
    expect(
      await d.saldoLedgerNaifPostedSaja(d.akun.penyisihan.id, p1.tanggalAkhir),
    ).toBe(kaliRate(akad.pokok, await d.bacaRate("MACET")));

    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const [pen2] = await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);

    // Opening balance zero, so period 2 forms the whole requirement afresh.
    expect(pen2.saldoPenyisihanAwal).toBe("0.00");
    expect(pen2.bebanPenyisihanPeriode).toBe(pen2.penyisihanDibutuhkan);
    expect(pen2.eventCode).toBe("BEBAN_PENYISIHAN");
  });

  test("penyisihan tidak pernah membuat akun kontra bersaldo debit", async () => {
    // The invariant behind both defects above, stated once. Penyisihan
    // Penurunan Nilai Piutang is a contra-ASSET with a normal CREDIT balance;
    // a debit balance on it is a balance sheet that overstates receivables, and
    // it balances perfectly while doing so.
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const akad = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);

    const tanggalBayar = `${p2.tahun}-${String(p2.bulan).padStart(2, "0")}-10`;
    d.setelJam(tanggalBayar);
    await d.bayarSetoran(
      akad.akadId,
      tanggalBayar,
      await d.totalTertunggak(akad.akadId, p2.tanggalAkhir),
    );

    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);

    for (const tanggal of [p1.tanggalAkhir, p2.tanggalAkhir]) {
      const saldo = await d.saldoLedger(d.akun.penyisihan.id, tanggal);
      // Debit-positive convention: a credit-balance account must be <= 0.
      expect(keSen(saldo)).toBeLessThanOrEqual(0n);
    }
    expect(await d.saldoLedger(d.akun.penyisihan.id, p2.tanggalAkhir)).toBe("0.00");
    expect(await d.selisihLedger()).toBe("0.00");
  });

  test("pemulihan tidak boleh melebihi saldo penyisihan yang benar benar ada", async () => {
    // A recovery larger than the balance is the same defect as a write-off
    // larger than the balance, arriving from the other direction: it drives the
    // contra-asset debit. Constructed by forming an allowance, spending most of
    // it on a write-off, and then letting the remaining portfolio improve.
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const macet = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p1.id }, d.ctx.approver);

    const tanggalHapus = `${p2.tahun}-${String(p2.bulan).padStart(2, "0")}-05`;
    d.setelJam(tanggalHapus);
    await d.hapusBukuLewatEngine(macet.akadId, tanggalHapus);

    d.setelJam(p2.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    const [pen2] = await d.engine.jalankanPenyisihan({ periodeId: p2.id }, d.ctx.approver);

    if (pen2.eventCode === "PEMULIHAN_PENYISIHAN") {
      expect(keSen(negasiUang(pen2.bebanPenyisihanPeriode))).toBeLessThanOrEqual(
        keSen(pen2.saldoPenyisihanAwal),
      );
    }
    expect(keSen(await d.saldoLedger(d.akun.penyisihan.id, p2.tanggalAkhir))).toBeLessThanOrEqual(
      0n,
    );
  });
});

describe("spec 8.2: rekonstruksi laporan (spec 16 skenario 17)", () => {
  test("total baris snapshot merekonstruksi nilai jurnal penyisihan periode itu", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.buatAkad({
      hariTunggakan: 200,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const [pen] = await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);

    const dariSnapshot = jumlahUang(
      ...(await d.bacaSnapshot(p.id)).map((s) => s.nilai_penyisihan),
    );
    expect(pen.penyisihanDibutuhkan).toBe(dariSnapshot);

    // First period, so opening balance zero and the journal IS the requirement.
    // That is exactly what spec 16 scenario 17 asks an operator to confirm.
    const baris = await d.db.query<{ debit: string; kredit: string; akun_id: string }>(
      `select debit::text as debit, kredit::text as kredit, akun_id::text as akun_id
         from jurnal_baris where jurnal_id = $1 and deleted_at is null order by urutan`,
      [pen.jurnalId],
    );
    expect(baris).toHaveLength(2);
    const kredit = baris.find((b) => b.akun_id === d.akun.penyisihan.id);
    const debit = baris.find((b) => b.akun_id === d.akun.bebanPenyisihan.id);
    expect(kredit?.kredit).toBe(dariSnapshot);
    expect(debit?.debit).toBe(dariSnapshot);
    expect(jumlahUang(rp(0), dariSnapshot)).not.toBe("0.00");
  });
});
