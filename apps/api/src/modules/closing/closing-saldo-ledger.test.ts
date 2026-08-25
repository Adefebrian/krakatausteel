// THE FROZEN TRIAL BALANCE (spec 8.4) AND THE ONE DEFECT THAT CANNOT BE
// CORRECTED LATER.
//
// ADR 0010, and migrations/0018 names this module explicitly:
//
//   "the closing engine that WRITES saldo_akun_periode must use the same rule;
//    if it filters POSTED alone, every closed period's trial balance carries
//    this bug. Flagged to the closing-engine owner; not fixable in the schema."
//
// THE MECHANISM. Correction is by reversing entry (invariant 4): the original
// is marked REVERSED and a second journal with the sides swapped is POSTED.
// Both sets of lines stay in the ledger and cancel. A sum filtered on
// `status = 'POSTED'` drops the original's lines while keeping the reversal's,
// so it subtracts a correction it never added. `v_ledger_baris` exists to state
// the right predicate once (`status IN ('POSTED','REVERSED')`), and every
// ledger aggregate is required to read it.
//
// WHY IT IS WORSE HERE THAN ANYWHERE ELSE. Every other consumer of that
// predicate recomputes, so fixing the query fixes history. Closing FREEZES the
// number into `saldo_akun_periode`, and spec 8.4's whole purpose for that table
// is that past-period reports read it instead of recomputing (invariant 14). A
// wrong figure is therefore permanent: it survives the fix, it is reported
// faithfully forever, and nothing detects it, because the erroneous trial
// balance still satisfies `saldo_akhir = saldo_awal + mutasi_debit -
// mutasi_kredit`, still sums to zero across all accounts, and still passes
// every one of the ten prerequisite checks.
//
// So the first test below constructs the exact case: post, reverse, close, and
// assert the frozen figure equals the LEDGER reading and DIFFERS from the naive
// one. The `differs` half is not decoration; without it the assertion would
// pass vacuously on any data where the two readings agree, which is most data.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buatDunia,
  jumlahUang,
  keSen,
  kurangUang,
  rp,
  tambahHari,
  type DuniaClosing,
  type PeriodeFixture,
} from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/** Debit-positive movement inside a period, from `v_ledger_baris`. */
async function mutasiLedger(akunId: string, p: PeriodeFixture): Promise<string> {
  const akhir = await d.saldoLedger(akunId, p.tanggalAkhir);
  const awal = await d.saldoLedger(akunId, tambahHari(p.tanggalMulai, -1));
  return kurangUang(akhir, awal);
}

describe("ADR 0010: saldo_akun_periode dihitung dari v_ledger_baris, bukan status POSTED saja", () => {
  test("jurnal yang dibalik di dalam periode: saldo beku cocok dengan predikat ledger, BUKAN dengan predikat naif", async () => {
    const p = d.periode(2026, 1);
    d.setelJam("2026-01-15");
    await d.postingAlokasiDana("2026-01-02", rp(100_000_000));

    const asli = await d.postingBebanOperasional("2026-01-10", rp(5_000_000));
    await d.reversalJurnal(asli.id, "Salah akun beban, dikoreksi dengan pembalik (fixture)");

    // The two readings, taken before anything is closed. THE FIXTURE PROVES
    // THEY DIVERGE, so the assertions below cannot be satisfied by accident.
    const benar = await d.saldoLedger(d.akun.bebanOperasional.id, p.tanggalAkhir);
    const naif = await d.saldoLedgerNaifPostedSaja(d.akun.bebanOperasional.id, p.tanggalAkhir);
    expect(benar).toBe("0.00");
    expect(naif).toBe("-5000000.00");
    expect(benar).not.toBe(naif);

    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    const saldo = await d.bacaSaldoAkunPeriode(p.id);
    const beban = saldo.find((s) => s.akun_kode === d.akun.bebanOperasional.kode);
    expect(beban).toBeDefined();

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(beban?.saldo_akhir).toBe(benar);
    expect(beban?.saldo_akhir).not.toBe(naif);

    // And the movement columns, which is where a POSTED-only implementation
    // shows most clearly: it would report 0.00 debited and 5.000.000 credited
    // for an expense account, i.e. a NEGATIVE expense that nobody incurred.
    expect(beban?.mutasi_debit).toBe(rp(5_000_000));
    expect(beban?.mutasi_kredit).toBe(rp(5_000_000));

    // The cash account too: the disbursement and its reversal both touched it.
    const kas = saldo.find((s) => s.akun_kode === d.akun.kas.kode);
    expect(kas?.saldo_akhir).toBe(await d.saldoLedger(d.akun.kas.id, p.tanggalAkhir));
  });

  test("SETIAP akun yang dibekukan cocok dengan v_ledger_baris, dan minimal satu berbeda dari predikat naif", async () => {
    const p = d.periode(2026, 1);
    d.setelJam("2026-01-15");
    await d.postingAlokasiDana("2026-01-02", rp(100_000_000));
    await d.buatAkad({
      hariTunggakan: 10,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    const salah = await d.postingBebanOperasional("2026-01-12", rp(2_750_000));
    await d.reversalJurnal(salah.id, "Dibatalkan, kegiatan tidak jadi (fixture)");

    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    const saldo = await d.bacaSaldoAkunPeriode(p.id);
    expect(saldo.length).toBeGreaterThan(2);

    let adaYangBerbeda = false;
    for (const baris of saldo) {
      const benar = await d.saldoLedger(baris.akun_id, p.tanggalAkhir);
      const naif = await d.saldoLedgerNaifPostedSaja(baris.akun_id, p.tanggalAkhir);
      expect(`${baris.akun_kode}=${baris.saldo_akhir}`).toBe(`${baris.akun_kode}=${benar}`);
      if (benar !== naif) adaYangBerbeda = true;
    }
    // Guards the guard: if the reversal ever stopped producing a divergence,
    // the loop above would be comparing two identical numbers and proving
    // nothing about which predicate was used.
    expect(adaYangBerbeda).toBe(true);
  });

  test("neraca lajur beku menjumlah nol, DAN itu tetap benar di implementasi yang salah, jadi bukan tes yang cukup", async () => {
    const p = d.periode(2026, 1);
    d.setelJam("2026-01-15");
    await d.postingAlokasiDana("2026-01-02", rp(50_000_000));
    const asli = await d.postingBebanOperasional("2026-01-10", rp(5_000_000));
    await d.reversalJurnal(asli.id, "Koreksi (fixture)");

    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    const saldo = await d.bacaSaldoAkunPeriode(p.id);
    // Debit-positive for every account type, so a trial balance is a SUM that
    // must be zero rather than two totals to compare.
    expect(jumlahUang(...saldo.map((s) => s.saldo_akhir))).toBe("0.00");
    expect(jumlahUang(...saldo.map((s) => s.mutasi_debit))).toBe(
      jumlahUang(...saldo.map((s) => s.mutasi_kredit)),
    );

    // ...and the identity holds row by row, which the schema also checks.
    for (const s of saldo) {
      expect(s.saldo_akhir).toBe(
        kurangUang(jumlahUang(s.saldo_awal, s.mutasi_debit), s.mutasi_kredit),
      );
    }
    // THE POINT OF THIS TEST'S NAME: a POSTED-only implementation satisfies
    // every assertion above, because it drops BOTH sides of the original
    // journal and the remaining reversal balances on its own. Balance checks
    // cannot detect this defect. Only the comparison in the first test can.
  });
});

describe("spec 8.4: saldo awal menyambung ke saldo akhir periode sebelumnya", () => {
  test("periode pertama mulai dari nol, dan mutasinya adalah seluruh aktivitasnya", async () => {
    const p = d.periode(2026, 1);
    d.setelJam("2026-01-15");
    await d.postingAlokasiDana("2026-01-02", rp(80_000_000));
    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    for (const s of await d.bacaSaldoAkunPeriode(p.id)) {
      // Nothing precedes the earliest period of a bumn, so every opening
      // balance is zero and every closing balance is the period's own movement.
      expect(`${s.akun_kode}:${s.saldo_awal}`).toBe(`${s.akun_kode}:0.00`);
      expect(s.saldo_akhir).toBe(await mutasiLedger(s.akun_id, p));
    }
  });
});

describe("BUILD-PLAN Fase 5 exit criterion: tiga periode berurutan dengan angka konsisten", () => {
  test("Januari, Februari dan Maret ditutup berurutan dan angkanya bersambung", async () => {
    // The phase's own exit criterion, stated as one experiment. Real activity
    // in each month, closed in order through the engine, and then three
    // properties that must hold across the sequence:
    //   1. every period's opening balance is the previous period's closing one;
    //   2. every period's movement is what the ledger says happened in it;
    //   3. every period's frozen trial balance sums to zero.
    const bulanan: PeriodeFixture[] = [1, 2, 3].map((b) => d.periode(2026, b));

    // January: funding and a disbursement.
    d.setelJam("2026-01-15");
    await d.postingAlokasiDana("2026-01-02", rp(150_000_000));
    const akad = await d.buatAkad({
      hariTunggakan: 10,
      padaTanggal: bulanan[0].tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    for (const [indeks, p] of bulanan.entries()) {
      d.setelJam(`${p.tanggalMulai.slice(0, 8)}15`);
      if (indeks === 1) {
        // February: an instalment, allocated by the REAL instalment engine, and
        // an expense that is posted and then reversed IN THE SAME MONTH. The
        // reversal is here on purpose: the ADR 0010 defect has to be visible
        // across a MULTI-PERIOD sequence, not only in an isolated month.
        const tanggalBayar = `${p.tanggalMulai.slice(0, 8)}12`;
        d.setelJam(tanggalBayar);
        await d.bayarSetoran(
          akad.akadId,
          tanggalBayar,
          await d.totalTertunggak(akad.akadId, tanggalBayar),
        );
        const salah = await d.postingBebanOperasional(tanggalBayar, rp(3_300_000));
        await d.reversalJurnal(salah.id, "Kegiatan dibatalkan (fixture)");
      }
      if (indeks === 2) {
        // March: an ordinary expense, no correction.
        await d.postingBebanOperasional(`${p.tanggalMulai.slice(0, 8)}09`, rp(1_100_000));
      }

      d.setelJam(p.tanggalAkhir);
      await d.siapkanTutup(p);
      const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
      expect(hasil.periode.status).toBe("CLOSED");
    }

    const saldoPer = await Promise.all(bulanan.map((p) => d.bacaSaldoAkunPeriode(p.id)));

    for (const [indeks, p] of bulanan.entries()) {
      const saldo = saldoPer[indeks];
      expect(saldo.length).toBeGreaterThan(0);

      // 3. Trial balance closes.
      expect(`${p.bulan}:${jumlahUang(...saldo.map((s) => s.saldo_akhir))}`).toBe(
        `${p.bulan}:0.00`,
      );

      for (const s of saldo) {
        // 2. The movement is the ledger's, read with the right predicate.
        expect(`${p.bulan}/${s.akun_kode}=${kurangUang(s.mutasi_debit, s.mutasi_kredit)}`).toBe(
          `${p.bulan}/${s.akun_kode}=${await mutasiLedger(s.akun_id, p)}`,
        );

        // 1. Continuity. A period whose opening balance is recomputed from
        // scratch rather than continuing the previous one will pass this only
        // if BOTH computations use the same predicate, which is the property
        // under test.
        if (indeks > 0) {
          const sebelumnya = saldoPer[indeks - 1].find(
            (x) => x.akun_id === s.akun_id && x.cabang_id === s.cabang_id,
          );
          expect(`${p.bulan}/${s.akun_kode}/awal=${s.saldo_awal}`).toBe(
            `${p.bulan}/${s.akun_kode}/awal=${sebelumnya?.saldo_akhir ?? "0.00"}`,
          );
        } else {
          expect(s.saldo_awal).toBe("0.00");
        }
      }
    }

    // The reconciliation spec 8.4 calls the most important in the system is
    // still exactly zero after three closings.
    expect(await d.akadTidakRekonsiliasi()).toHaveLength(0);
    expect(await d.selisihLedger()).toBe("0.00");

    // And the receivable in the frozen March balance is the sub-ledger's own
    // figure, which is what makes a past-period Laporan Posisi Keuangan agree
    // with a past-period Kartu Piutang.
    const maret = saldoPer[2].find((s) => s.akun_kode === d.akun.piutangPokok.kode);
    expect(maret?.saldo_akhir).toBe((await d.bacaAkad(akad.akadId)).outstanding_pokok);
    expect(keSen(maret?.saldo_akhir ?? "0.00")).toBeGreaterThan(0n);
  });

  test("menutup tiga periode tidak pernah menghasilkan snapshot ganda untuk satu akun", async () => {
    const bulanan = [1, 2, 3].map((b) => d.periode(2026, b));
    d.setelJam("2026-01-15");
    await d.postingAlokasiDana("2026-01-02", rp(60_000_000));

    for (const p of bulanan) {
      d.setelJam(p.tanggalAkhir);
      await d.siapkanTutup(p);
      await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    }

    for (const p of bulanan) {
      const saldo = await d.bacaSaldoAkunPeriode(p.id);
      const kunci = saldo.map((s) => `${s.cabang_id}/${s.akun_id}`);
      // `saldo_akun_periode_uq` says the same thing, and this says it about the
      // engine rather than about the schema.
      expect(new Set(kunci).size).toBe(kunci.length);
    }
  });
});
