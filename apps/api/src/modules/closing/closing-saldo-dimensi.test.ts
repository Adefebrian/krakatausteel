// THE FROZEN DECOMPOSITION (migrations/0027, migrations/0032, ADR 0016).
//
// WHAT WAS MISSING. 0027 created `saldo_akun_dimensi_periode`, wrote the
// totality rule into two triggers, and said in its own header: "Nothing writes
// these rows yet. `tutupPeriode` freezes `saldo_akun_periode` from
// `v_ledger_baris` and must be extended to freeze the decomposition from
// `jurnal_baris.dimensi_json` with the same ADR 0010 predicate". This file is
// that extension's specification. Until it passed, spec 10's rule ("periode
// CLOSED dibaca dari snapshot") could not be satisfied for RKA PUMK or RKA Non
// PUMK, and report 24 refused both.
//
// ---------------------------------------------------------------------------
// THE THREE PROPERTIES, AND WHY EACH ONE HAS TO BE ASSERTED SEPARATELY
// ---------------------------------------------------------------------------
//
// 1. IT IS A DECOMPOSITION, NOT A SECOND OPINION. The children of one frozen
//    account row sum, per axis, to that row's own two movement columns.
//    Movement carrying no dimension is a RESIDUAL row, not an omission, which
//    is what makes the sum exact instead of "less than or equal". A partial
//    decomposition is the failure this is guarding against and it is invisible
//    at the row level: every per-sektor figure looks right and the total is
//    quietly short.
//
// 2. IT SPLITS. Every test below uses TWO buckets per axis. With one bucket,
//    an implementation that ignored the dimension entirely and wrote the
//    account's whole movement into a single row would satisfy the totality
//    trigger and every equality assertion in this file.
//
// 3. IT READS `v_ledger_baris` (ADR 0010). A reversed disbursement leaves a
//    debit AND a credit in its sector's bucket, both frozen gross. A
//    POSTED-only read would freeze the credit without the debit, i.e. a sector
//    that lent MINUS five million in a month it lent nothing. The parent row
//    has the same defect and closing-saldo-ledger.test.ts pins it there; here
//    the stakes are higher, because the decomposition has no identity CHECK and
//    no zero-sum to violate.
//
// ---------------------------------------------------------------------------
// AND THE FOURTH, WHICH IS NOT ABOUT MONEY
// ---------------------------------------------------------------------------
// `jumlah mitra` (spec 9.3) is a DISTINCT COUNT, and a distinct count cannot be
// frozen as a number: one partner funded in January and again in March is one
// partner over the year and two over the two months, so a per-period count
// summed year-to-date double counts in a column that looks right. migrations/
// 0032 freezes the SET instead (`saldo_dimensi_mitra_periode`) and the count is
// taken at read time over whatever window is asked for.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buatDunia,
  jumlahUang,
  kurangUang,
  rp,
  type DuniaClosing,
  type PeriodeFixture,
  type SaldoDimensiDb,
} from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/** The decomposition of ONE account on ONE axis, as `bucket -> (D, K)`. */
async function rincian(
  periodeId: string,
  akunKode: string,
  sumbu: "SEKTOR" | "BIDANG",
): Promise<Record<string, string>> {
  const rows = await d.bacaDimensiBeku(periodeId);
  const keluar: Record<string, string> = {};
  for (const r of rows) {
    if (r.akun_kode !== akunKode || r.sumbu !== sumbu) continue;
    keluar[r.bucket] = `D ${r.mutasi_debit} K ${r.mutasi_kredit}`;
  }
  return keluar;
}

/** Sums the children of every frozen row and compares with the parent, per axis. */
async function totalitas(periodeId: string): Promise<string[]> {
  const induk = await d.bacaSaldoAkunPeriode(periodeId);
  const anak = await d.bacaDimensiBeku(periodeId);
  const keluar: string[] = [];
  for (const p of induk) {
    for (const sumbu of ["SEKTOR", "BIDANG"] as const) {
      const bagian = anak.filter(
        (a) => a.akun_kode === p.akun_kode && a.cabang_id === p.cabang_id && a.sumbu === sumbu,
      );
      if (bagian.length === 0) continue;
      const debit = jumlahUang(...bagian.map((b) => b.mutasi_debit));
      const kredit = jumlahUang(...bagian.map((b) => b.mutasi_kredit));
      keluar.push(
        `${p.akun_kode} ${sumbu}: anak D ${debit} K ${kredit} vs induk D ${p.mutasi_debit} K ${p.mutasi_kredit}`,
      );
    }
  }
  return keluar;
}

/** The world every test in the first two describes shares, closed and frozen. */
async function duniaTerbuka(): Promise<PeriodeFixture> {
  const p = d.periode(2026, 1);
  d.setelJam("2026-01-20");
  await d.postingAlokasiDana("2026-01-02", rp(100_000_000));
  return p;
}

async function tutup(p: PeriodeFixture): Promise<void> {
  d.setelJam(p.tanggalAkhir);
  await d.siapkanTutup(p);
  await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.adminPusat);
}

describe("sumbu SEKTOR: mutasi piutang diuraikan per sektor, sisanya jadi baris SISA", () => {
  test("dua sektor plus satu baris sisa, dan ketiganya berjumlah persis mutasi akunnya", async () => {
    const p = await duniaTerbuka();

    // Sektor A gets two disbursements, sektor B one. Distinct totals, so a
    // bucket that ended up on the wrong sector is a failing number rather than
    // a coincidence.
    const a1 = await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(12_000_000),
      hariTunggakan: 10,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(6_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-09",
    });
    await d.buatAkad({
      sektorId: d.sektorLainId,
      pokok: rp(9_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-08",
    });

    // A REPAYMENT, which moves the SAME receivable account and is not
    // realisation. Row 1 of a 12.000.000 over 12 akad is 1.000.000 pokok plus
    // 30.000 jasa, and the allocation order pays the jasa first, so exactly
    // 1.000.000,00 is credited to the receivable.
    const jadwal = await d.bacaJadwal(a1.akadId);
    expect(jadwal[0].pokok).toBe(rp(1_000_000));
    expect(jadwal[0].jasa_adm).toBe("30000.00");
    await d.bayarSetoran(a1.akadId, "2026-01-25", jumlahUang(rp(1_000_000), "30000.00"));

    await tutup(p);

    // THE DECOMPOSITION, stated in full so a missing bucket fails as an
    // inequality of objects rather than as a length that happens to match.
    const sektorA = (await d.bacaDimensiBeku(p.id)).find(
      (r) => r.sumbu === "SEKTOR" && r.bucket !== "SISA" && r.mutasi_debit === rp(18_000_000),
    );
    expect(sektorA).toBeDefined();

    const peta = await rincian(p.id, d.akun.piutangPokok.kode, "SEKTOR");
    const kodeSektorA = sektorA?.bucket as string;
    const kodeSektorB = Object.keys(peta).find((k) => k !== "SISA" && k !== kodeSektorA) as string;
    expect(peta).toEqual({
      // 12.000.000 + 6.000.000, both in sektor A.
      [kodeSektorA]: `D ${rp(18_000_000)} K 0.00`,
      [kodeSektorB]: `D ${rp(9_000_000)} K 0.00`,
      // The repayment. It carries an akad and therefore a sector in the master
      // data, and it is STILL residual: realisation is disbursement, and
      // modules/rka reads the same window through the same back-reference.
      SISA: `D 0.00 K ${rp(1_000_000)}`,
    });

    // The parent, independently, and the identity between the two.
    const induk = (await d.bacaSaldoAkunPeriode(p.id)).find(
      (s) => s.akun_kode === d.akun.piutangPokok.kode,
    );
    expect(induk?.mutasi_debit).toBe(rp(27_000_000));
    expect(induk?.mutasi_kredit).toBe(rp(1_000_000));
    expect(await totalitas(p.id)).toContain(
      `${d.akun.piutangPokok.kode} SEKTOR: anak D ${rp(27_000_000)} K ${rp(1_000_000)}` +
        ` vs induk D ${rp(27_000_000)} K ${rp(1_000_000)}`,
    );
  });

  test("akun yang tidak pernah membawa sektor TIDAK diuraikan sama sekali", async () => {
    // The rule is conditional on the CLAIM (migrations/0027): once one row on
    // an axis exists that axis must account for the whole movement, but an
    // account nobody decomposes gets no rows at all. Writing a residual row for
    // every account in the trial balance would multiply the frozen table by the
    // number of axes for no reader.
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(12_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await tutup(p);

    const rows = await d.bacaDimensiBeku(p.id);
    // Cash moved on both the allocation and the disbursement, and cash is on
    // no axis.
    expect(rows.filter((r) => r.akun_kode === d.akun.kas.kode)).toEqual([]);
    expect(rows.some((r) => r.akun_kode === d.akun.piutangPokok.kode)).toBe(true);
  });

  test("pencairan yang DIBALIK membekukan debit DAN kredit di bucket sektornya (ADR 0010)", async () => {
    const p = await duniaTerbuka();
    const salah = await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-06",
    });
    await d.buatAkad({
      sektorId: d.sektorLainId,
      pokok: rp(7_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-07",
    });
    await d.reversalJurnal(
      salah.jurnalPencairanId as string,
      "Pencairan salah akad, dikoreksi dengan pembalik (fixture)",
    );
    // The sub-ledger has to follow the ledger or check 10 blocks the close.
    await d.rusakSubLedger(salah.akadId, "0.00");

    // THE FIXTURE PROVES THE TWO READINGS DIVERGE before anything is frozen.
    const benar = await d.saldoLedger(d.akun.piutangPokok.id, p.tanggalAkhir);
    const naif = await d.saldoLedgerNaifPostedSaja(d.akun.piutangPokok.id, p.tanggalAkhir);
    expect(benar).toBe(rp(7_000_000));
    expect(naif).toBe(rp(2_000_000));

    await tutup(p);

    const peta = await rincian(p.id, d.akun.piutangPokok.kode, "SEKTOR");
    const kodeA = Object.keys(peta).find((k) => peta[k] === `D ${rp(5_000_000)} K ${rp(5_000_000)}`);
    // GROSS, both sides. A netted column would make a month with 5.000.000
    // disbursed and 5.000.000 reversed indistinguishable from a month with no
    // activity in that sector at all, and a POSTED-only read would report
    // `D 0.00 K 5.000.000`: a sector that un-lent money it never lent.
    expect(kodeA).toBeDefined();
    expect(peta[kodeA as string]).not.toBe(`D 0.00 K ${rp(5_000_000)}`);
    expect(Object.values(peta)).toContain(`D ${rp(7_000_000)} K 0.00`);
    expect(await totalitas(p.id)).toContain(
      `${d.akun.piutangPokok.kode} SEKTOR: anak D ${rp(12_000_000)} K ${rp(5_000_000)}` +
        ` vs induk D ${rp(12_000_000)} K ${rp(5_000_000)}`,
    );
  });
});

describe("sumbu BIDANG: mutasi beban diuraikan dari dimensi_json baris jurnalnya", () => {
  test("dua bidang, pengembalian sebagai KREDIT di bidang yang sama, dan sisa tanpa bidang", async () => {
    const p = await duniaTerbuka();
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await d.postingPenyaluranNonPumk("2026-01-15", rp(3_000_000), d.bidang.b.id);
    // A refund credits the account the disbursement debited, per bidang
    // (event_jurnal_mapping's own note on PENGEMBALIAN_SISA_NON_PUMK).
    await d.postingPengembalianSisaNonPumk("2026-01-20", rp(1_000_000), d.bidang.a.id);
    // Ordinary expense on the SAME account, carrying no bidang: the residual.
    await d.postingBebanOperasional("2026-01-22", rp(2_500_000));

    await tutup(p);

    expect(await rincian(p.id, d.akun.bebanOperasional.kode, "BIDANG")).toEqual({
      [d.bidang.a.kode]: `D ${rp(4_000_000)} K ${rp(1_000_000)}`,
      [d.bidang.b.kode]: `D ${rp(3_000_000)} K 0.00`,
      SISA: `D ${rp(2_500_000)} K 0.00`,
    });
    expect(await totalitas(p.id)).toContain(
      `${d.akun.bebanOperasional.kode} BIDANG: anak D ${rp(9_500_000)} K ${rp(1_000_000)}` +
        ` vs induk D ${rp(9_500_000)} K ${rp(1_000_000)}`,
    );
  });

  test("dua sumbu atas satu periode direkonsiliasi sendiri sendiri", async () => {
    // migrations/0027's reason for the `sumbu` column. Sektor and bidang are
    // independent partitions; without the axis, children summed across both
    // would double an account's movement while every row stayed correct.
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(8_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await tutup(p);

    const baris = await totalitas(p.id);
    // Every line here compares a child sum with its parent; the assertion is
    // that no line reports a mismatch, stated as the whole list so a failure
    // names the account.
    for (const l of baris) {
      const [anak, indukSisi] = l.split(" vs ");
      // `split(": anak ")`, not `split(": ")`: the left side carries the word
      // "anak" and the right side does not, so splitting on the colon alone
      // compares "anak D 1 K 0" with "D 1 K 0" and can never be equal for ANY
      // data. That is an assertion that only fails, which is worse than no
      // assertion: it cannot distinguish a broken decomposition from a sound
      // one. Repaired rather than deleted, because the property it means to
      // state is real and this is the only place the TWO AXIS case is checked.
      expect(`${l}: ${anak.split(": anak ")[1]}`).toBe(`${l}: ${indukSisi.replace("induk ", "")}`);
    }
    expect(baris.length).toBeGreaterThanOrEqual(2);
  });
});

describe("himpunan mitra beku: jumlah mitra adalah COUNT DISTINCT, bukan angka yang dijumlahkan", () => {
  test("satu baris per mitra per bucket sektor, dan mitra yang dicairkan dua kali tetap satu", async () => {
    const p = await duniaTerbuka();
    const a1 = await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(4_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(3_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-06",
    });
    await d.buatAkad({
      sektorId: d.sektorLainId,
      pokok: rp(2_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-07",
    });
    // A SECOND disbursement to a partner already funded this month. Two ledger
    // lines, one partner: spec 9.3's "jumlah mitra target" counts partners, not
    // tranches.
    await d.cairkan(a1.akadId, "2026-01-09");

    await tutup(p);

    const mitra = await d.bacaMitraDimensiBeku(p.id);
    // Three partners in total across two sectors, and the twice-funded one
    // appears ONCE.
    expect(mitra.length).toBe(3);
    expect(new Set(mitra.map((m) => m.kode_mitra)).size).toBe(3);
    const perSektor = new Map<string, number>();
    for (const m of mitra) perSektor.set(m.sektor_kode, (perSektor.get(m.sektor_kode) ?? 0) + 1);
    expect([...perSektor.values()].sort()).toEqual([1, 2]);
    // Every partner hangs off the receivable account's bucket, which is where
    // the disbursement moved.
    expect(new Set(mitra.map((m) => m.akun_kode))).toEqual(
      new Set([d.akun.piutangPokok.kode]),
    );
  });
});

describe("penguraian yang tidak menjumlah kembali ke induknya DITOLAK oleh database", () => {
  test("menghapus satu bucket membuat sisa penguraian kurang dari mutasi akunnya, dan transaksinya gagal", async () => {
    // Not a test of this engine's SQL: a test that the rule 0027 installed is
    // LIVE against the rows this engine writes. Without it, "the numbers happen
    // to add up today" and "the numbers cannot fail to add up" are the same
    // green.
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      sektorId: d.sektorLainId,
      pokok: rp(6_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-06",
    });
    await tutup(p);

    let pesan = "";
    try {
      await d.db.transaction(async (tx) => {
        await tx.query(
          `delete from saldo_dimensi_mitra_periode dm
            using saldo_akun_dimensi_periode d, saldo_akun_periode s
            where dm.saldo_akun_dimensi_periode_id = d.id
              and d.saldo_akun_periode_id = s.id and s.periode_id = $1
              and d.sektor_id = $2`,
          [p.id, d.sektorId],
        );
        await tx.query(
          `delete from saldo_akun_dimensi_periode d
            using saldo_akun_periode s
            where d.saldo_akun_periode_id = s.id and s.periode_id = $1 and d.sektor_id = $2`,
          [p.id, d.sektorId],
        );
      });
    } catch (err) {
      pesan = err instanceof Error ? err.message : String(err);
    }
    expect(pesan).toContain("TJSL-SDP-002");
    // And the rows are still all there, because the whole transaction rolled
    // back rather than half of it committing.
    expect(Object.keys(await rincian(p.id, d.akun.piutangPokok.kode, "SEKTOR")).length).toBe(2);
  });
});

describe("reproducibility: buka kembali lalu tutup lagi menghasilkan baris beku yang sama", () => {
  test("reopen menyapu penguraian bersama induknya dan mengosongkan capnya", async () => {
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await tutup(p);
    expect((await d.bacaDimensiBeku(p.id)).length).toBeGreaterThan(0);
    expect(await d.dimensiDibekukanAt(p.id)).not.toBeNull();

    await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Koreksi klasifikasi bidang (fixture)" },
      d.ctx.adminPusat,
    );

    // ON DELETE CASCADE from `saldo_akun_periode`, which the reopen already
    // deleted. No stale per-sektor figure can survive into a re-close and
    // reconcile against a NEW parent row.
    expect(await d.bacaDimensiBeku(p.id)).toEqual([]);
    expect(await d.bacaMitraDimensiBeku(p.id)).toEqual([]);
    // And the stamp goes with them: an OPEN period asserting a completed
    // decomposition is the state that would make a report read zero and call it
    // frozen.
    expect(await d.dimensiDibekukanAt(p.id)).toBeNull();
  });

  test("tutup ulang atas ledger yang sama menghasilkan baris identik, termasuk himpunan mitranya", async () => {
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      sektorId: d.sektorLainId,
      pokok: rp(6_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-06",
    });
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await d.postingPenyaluranNonPumk("2026-01-14", rp(2_000_000), d.bidang.b.id);
    await d.postingBebanOperasional("2026-01-16", rp(750_000));

    await tutup(p);
    const pertama: SaldoDimensiDb[] = await d.bacaDimensiBeku(p.id);
    const mitraPertama = await d.bacaMitraDimensiBeku(p.id);
    expect(pertama.length).toBeGreaterThan(4);

    await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Buka kembali untuk uji reproducibility (fixture)" },
      d.ctx.adminPusat,
    );
    // NOTHING about the ledger changes between the two closes. Invariant 14 is
    // exactly the claim that this is enough to reproduce the figures.
    await tutup(p);

    expect(await d.bacaDimensiBeku(p.id)).toEqual(pertama);
    expect(await d.bacaMitraDimensiBeku(p.id)).toEqual(mitraPertama);
  });
});

describe("cap dimensi_dibekukan_at membedakan 'tidak pernah diuraikan' dari 'diuraikan dan hasilnya nol'", () => {
  test("periode tanpa satu pun mutasi berdimensi tetap mendapat cap, dengan nol baris", async () => {
    // migrations/0032's whole reason. A quiet January is not a broken close,
    // and a reader that treated "no rows" as "never decomposed" would refuse
    // that month forever.
    const p = await duniaTerbuka();
    await d.postingBebanOperasional("2026-01-12", rp(1_250_000));
    await tutup(p);

    expect(await d.bacaDimensiBeku(p.id)).toEqual([]);
    expect(await d.dimensiDibekukanAt(p.id)).not.toBeNull();
  });

  test("periode yang ditutup tanpa mesin ini TIDAK punya cap", async () => {
    // The state every period closed before this feature is in. It has frozen
    // balances and no decomposition, and the difference from the test above is
    // the only thing a reader can use to tell them apart.
    const p = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-02", rp(50_000_000));
    await d.tutupPeriodeLangsung(p);
    expect(await d.dimensiDibekukanAt(p.id)).toBeNull();
  });
});

describe("hasil tutupPeriode melaporkan penguraian yang ditulisnya", () => {
  test("audit log mencatat berapa baris dimensi dan berapa mitra dibekukan", async () => {
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await tutup(p);

    const baris = await d.bacaDimensiBeku(p.id);
    const mitra = await d.bacaMitraDimensiBeku(p.id);
    const catatan = await d.db.query<{ nilai_baru_json: unknown }>(
      `select nilai_baru_json from audit_log
        where aksi = 'closing.periode' and entitas_id = $1 and hasil = 'SUKSES'`,
      [p.id],
    );
    expect(catatan.length).toBe(1);
    const nilai = catatan[0].nilai_baru_json as Record<string, unknown>;
    expect(nilai.jumlahDimensiDibekukan).toBe(baris.length);
    expect(nilai.jumlahMitraDimensiDibekukan).toBe(mitra.length);
    // The counts are only evidence if they are not zero.
    expect(baris.length).toBeGreaterThan(0);
    expect(mitra.length).toBe(1);
  });
});

describe("kontrol: penguraian tidak mengubah neraca saldo yang dibekukan", () => {
  test("saldo_akun_periode tetap berjumlah nol dan tetap sama dengan v_ledger_baris", async () => {
    // migrations/0027's first argument for a child table rather than columns:
    // "every existing reader would silently double count". This is that claim
    // asserted rather than trusted.
    const p = await duniaTerbuka();
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await tutup(p);

    const saldo = await d.bacaSaldoAkunPeriode(p.id);
    expect(jumlahUang(...saldo.map((s) => s.saldo_akhir))).toBe("0.00");
    for (const s of saldo) {
      expect(`${s.akun_kode}=${s.saldo_akhir}`).toBe(
        `${s.akun_kode}=${await d.saldoLedger(s.akun_id, p.tanggalAkhir, s.cabang_id)}`,
      );
      expect(kurangUang(s.saldo_akhir, s.saldo_awal)).toBe(
        kurangUang(s.mutasi_debit, s.mutasi_kredit),
      );
    }
  });
});
