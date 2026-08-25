// WHERE REALISATION COMES FROM. The file this module exists to get right.
//
// Spec 10's rule, and invariant 14 behind it: "Semua laporan harus
// reproducible. Laporan periode lampau yang dibuka hari ini harus menghasilkan
// angka yang sama dengan saat periode itu ditutup. Artinya laporan dibaca dari
// snapshot/ledger, bukan dari kalkulasi ulang atas data master yang bisa
// berubah."
//
// Applied here, that is two sources and one forbidden predicate:
//
//   OPEN period    -> `v_ledger_baris`
//   CLOSED period  -> `saldo_akun_periode`, frozen by the closing engine
//   never          -> `status = 'POSTED'` alone
//
// WHY THE LAST ONE IS NOT PEDANTRY (ADR 0010, migrations/0018). Correction is
// by reversing entry: the original is marked REVERSED and a second journal with
// the sides swapped is POSTED. Both sets of lines stay in the ledger and
// cancel. A sum filtered on POSTED alone drops the original's lines while
// keeping the reversal's, so it SUBTRACTS a correction it never added. In the
// trial balance that defect at least preserves the row identity and the
// zero-sum, which is why it hid; in a budget report there is no identity and no
// zero-sum, so nothing whatsoever detects it. The figure is simply wrong, it is
// plausible, and it is reported faithfully forever.
//
// EVERY TEST BELOW PROVES THE TWO CANDIDATE READINGS DIVERGE BEFORE ASSERTING
// WHICH ONE WAS USED. Without that, an assertion that the figure is correct
// passes identically on an implementation that read the wrong source, because
// on well-behaved data the two agree. That is the same trap
// modules/closing/closing-saldo-ledger.test.ts documents, and the reason
// `d.geserSaldoBeku` and `d.mutasiLedgerNaifPostedSaja` exist at all.
//
// AND ONE THING THIS MODULE REFUSES TO DO. `saldo_akun_periode` is keyed
// (periode, cabang, akun) and carries no sektor and no bidang, so a CLOSED
// period has NO frozen figure for RKA PUMK or RKA Non PUMK. The only way to
// produce one is to re-derive it from the live ledger and, for PUMK, to join
// out to `pumk_proposal.sektor_id`, which is editable master data
// (./rka-fixture.test.ts proves a reclassification moves a historical figure).
// That is invariant 14 broken for the very report spec 16 scenario 18 exists to
// check, so the report REFUSES with SKEMA_BELUM_LENGKAP rather than answering.
// Filed as a fail-closed test, not worked around.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_RKA } from "./contract";
import {
  BEBAN_OPERASIONAL_FEB,
  PENDAPATAN_GIRO_FEB,
  TAHUN_RKA,
  buatDunia,
  jumlahUang,
  kodeAda,
  kurangUang,
  negasiUang,
  rp,
  tolakDengan,
  type DuniaRka,
} from "./test-support";

let d: DuniaRka;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

async function baselineKeuangan(baris: Array<Record<string, unknown>>) {
  const rka = await d.engine.buatRka(
    { cabangId: d.cabangId, tahun: TAHUN_RKA, jenis: "KEUANGAN", baris: baris as never },
    d.ctx.adminPusat,
  );
  await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);
  return rka;
}

// ---------------------------------------------------------------------------
// ADR 0010: the forbidden predicate
// ---------------------------------------------------------------------------

describe("ADR 0010: realisasi dibaca dengan predikat v_ledger_baris, bukan status POSTED saja", () => {
  test("beban yang diposting lalu dibalik di bulan yang sama: realisasi nol, bukan minus", async () => {
    d.setelJam("2026-02-20");
    await d.postingAlokasiDana("2026-02-02", rp(50_000_000));
    const salah = await d.postingBebanOperasional("2026-02-10", BEBAN_OPERASIONAL_FEB);
    await d.reversalJurnal(salah.id, "Salah akun beban, dikoreksi dengan pembalik (fixture rka)");

    // THE DIVERGENCE, PROVED FIRST. Without these three lines the assertion
    // below could be satisfied by either predicate.
    const benar = await d.mutasiNormal(
      d.akun.bebanOperasional.id,
      "2026-02-01",
      "2026-02-28",
      d.cabangId,
    );
    const naif = await d.mutasiLedgerNaifPostedSaja(
      d.akun.bebanOperasional.id,
      "2026-02-01",
      "2026-02-28",
      d.cabangId,
    );
    expect(benar).toBe("0.00");
    expect(naif).toBe(negasiUang(BEBAN_OPERASIONAL_FEB));
    expect(benar).not.toBe(naif);

    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban operasional Februari",
        bulan: 2,
        jumlahAnggaran: rp(4_000_000),
      },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    const baris = l.baris.find((b) => b.dimensiId === d.akun.bebanOperasional.id)!;

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(baris.realisasi).toBe(benar);
    expect(baris.realisasi).not.toBe(naif);
    expect(baris.sumberRealisasi).toBe("V_LEDGER_BARIS");
    // And the consequence in the column a manager reads: a POSTED-only report
    // would say this budget was 84 percent UNDER-spent by having spent minus
    // 3.370.000, which nobody would question because it looks like thrift.
    expect(baris.selisih).toBe(rp(4_000_000));
    expect(baris.persenCapaian).toBe("0.00");
  });

  test("pembalikan di bulan berikutnya mengurangi bulan itu, bukan bulan aslinya", async () => {
    // The other reversal shape, and the one that decides whether a monthly
    // report is stable. A correction dated in March must not silently rewrite
    // February, because February may already have been reported.
    d.setelJam("2026-03-20");
    await d.postingAlokasiDana("2026-02-02", rp(50_000_000));
    const asli = await d.postingBebanOperasional("2026-02-10", BEBAN_OPERASIONAL_FEB);
    d.setelJam("2026-03-10");
    await d.reversalJurnal(asli.id, "Kegiatan dibatalkan, dikoreksi Maret (fixture rka)");

    await baselineKeuangan([
      { akunId: d.akun.bebanOperasional.id, uraian: "Beban Februari", bulan: 2, jumlahAnggaran: rp(4_000_000) },
      { akunId: d.akun.bebanOperasional.id, uraian: "Beban Maret", bulan: 3, jumlahAnggaran: rp(4_000_000) },
    ]);
    const dasar = { tahun: TAHUN_RKA, jenis: "KEUANGAN" as const, cabangId: d.cabangId };

    const feb = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(feb.baris[0].realisasi).toBe(
      await d.mutasiNormal(d.akun.bebanOperasional.id, "2026-02-01", "2026-02-28", d.cabangId),
    );
    expect(feb.baris[0].realisasi).toBe(BEBAN_OPERASIONAL_FEB);

    const mar = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "BULANAN", bulan: 3 },
      d.ctx.adminPusat,
    );
    expect(mar.baris[0].realisasi).toBe(negasiUang(BEBAN_OPERASIONAL_FEB));

    // Year to date is back to nothing, which is the truth.
    const ytd = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "KUMULATIF_YTD", bulan: 3 },
      d.ctx.adminPusat,
    );
    expect(ytd.baris[0].realisasi).toBe("0.00");
  });

  test("jurnal DRAFT tidak dihitung sebagai realisasi", async () => {
    // `v_ledger_baris` excludes DRAFT deliberately: a draft is not an
    // accounting fact yet, and invariant 1 is not even enforced on it until it
    // is posted. A budget report that counted drafts would let anyone move the
    // achievement figure without an approval.
    d.setelJam("2026-02-20");
    await d.postingAlokasiDana("2026-02-02", rp(50_000_000));
    // Through the REAL ledger engine, not raw SQL: only modules/jurnal may
    // write `jurnal` (invariant 11, and `bun tools/check-boundaries.ts`
    // enforces it). It is also the stronger fixture, because what must be
    // excluded is whatever the ENGINE calls a draft.
    const draft = await d.buatJurnalDraft("2026-02-15", rp(2_800_000));
    expect(draft.status).toBe("DRAFT");

    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Februari",
        bulan: 2,
        jumlahAnggaran: rp(4_000_000),
      },
    ]);
    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(l.baris[0].realisasi).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// OPEN vs CLOSED
// ---------------------------------------------------------------------------

describe("spec 10: periode OPEN dibaca dari ledger hidup", () => {
  test("realisasi bulan berjalan cocok dengan v_ledger_baris dan sumbernya dinyatakan", async () => {
    d.setelJam("2026-02-20");
    await d.postingAlokasiDana("2026-02-02", rp(50_000_000));
    await d.postingBebanOperasional("2026-02-10", BEBAN_OPERASIONAL_FEB);
    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Februari",
        bulan: 2,
        jumlahAnggaran: rp(4_000_000),
      },
    ]);

    expect((await d.bacaPeriode(d.periode(2026, 2).id)).status).toBe("OPEN");
    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(l.baris[0].sumberRealisasi).toBe("V_LEDGER_BARIS");
    expect(l.baris[0].realisasi).toBe(
      await d.mutasiNormal(d.akun.bebanOperasional.id, "2026-02-01", "2026-02-28", d.cabangId),
    );

    expect(l.sumberPerPeriode).toHaveLength(1);
    expect(l.sumberPerPeriode[0].bulan).toBe(2);
    expect(l.sumberPerPeriode[0].statusPeriode).toBe("OPEN");
    expect(l.sumberPerPeriode[0].sumber).toBe("V_LEDGER_BARIS");
  });

  test("laporan bulan berjalan berubah ketika jurnal baru diposting, karena memang belum beku", async () => {
    // The property that distinguishes a live reading from a frozen one, made
    // explicit so the frozen half below is not merely "the same number twice".
    d.setelJam("2026-02-20");
    await d.postingAlokasiDana("2026-02-02", rp(50_000_000));
    await d.postingBebanOperasional("2026-02-10", rp(1_000_000));
    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Februari",
        bulan: 2,
        jumlahAnggaran: rp(4_000_000),
      },
    ]);
    const filter = {
      tahun: TAHUN_RKA,
      jenis: "KEUANGAN" as const,
      cabangId: d.cabangId,
      mode: "BULANAN" as const,
      bulan: 2,
    };
    const sebelum = await d.engine.laporanRkaVsRealisasi(filter, d.ctx.adminPusat);
    await d.postingBebanOperasional("2026-02-18", rp(1_500_000));
    const sesudah = await d.engine.laporanRkaVsRealisasi(filter, d.ctx.adminPusat);
    expect(sesudah.baris[0].realisasi).toBe(
      jumlahUang(sebelum.baris[0].realisasi, rp(1_500_000)),
    );
  });
});

describe("spec 10 dan invarian 14: periode CLOSED dibaca dari saldo_akun_periode yang beku", () => {
  test("laporan mengikuti angka BEKU, bukan ledger hidup, dibuktikan dengan membuat keduanya berbeda", async () => {
    // THE DECISIVE TEST OF THIS FILE.
    //
    // Both readings agree on ordinary data, so an equality assertion alone
    // cannot tell which one answered. `geserSaldoBeku` moves the frozen row
    // WITHOUT touching the ledger and WITHOUT breaking
    // `saldo_akun_periode_identitas_ck`, so the row stays one the closing
    // engine could legitimately have written. Then the report has to pick a
    // side, and the side it picks is the whole requirement.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", BEBAN_OPERASIONAL_FEB);
    await d.tutupDanBekukan(jan);

    const geser = rp(250_000);
    await d.geserSaldoBeku(jan.id, d.akun.bebanOperasional.id, geser);

    const beku = (await d.bacaSaldoAkunPeriode(jan.id)).find(
      (s) => s.akun_kode === d.akun.bebanOperasional.kode,
    )!;
    const bekuNormal = kurangUang(beku.mutasi_debit, beku.mutasi_kredit);
    const hidupNormal = await d.mutasiNormal(
      d.akun.bebanOperasional.id,
      jan.tanggalMulai,
      jan.tanggalAkhir,
      d.cabangId,
    );
    expect(bekuNormal).not.toBe(hidupNormal);

    d.setelJam("2026-03-15");
    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
      },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
      d.ctx.adminPusat,
    );
    const baris = l.baris.find((b) => b.dimensiId === d.akun.bebanOperasional.id)!;
    expect(baris.realisasi).toBe(bekuNormal);
    expect(baris.realisasi).not.toBe(hidupNormal);
    expect(baris.sumberRealisasi).toBe("SALDO_AKUN_PERIODE");
    expect(l.sumberPerPeriode[0].statusPeriode).toBe("CLOSED");
    expect(l.sumberPerPeriode[0].sumber).toBe("SALDO_AKUN_PERIODE");
  });

  test("akun pendapatan yang beku tetap positif terhadap targetnya", async () => {
    // `saldo_akun_periode` is DEBIT-POSITIVE for every account type, so a
    // revenue account carries a NEGATIVE figure there. Reading it straight
    // through would make every revenue target look like a total miss. The
    // report shows the account's normal direction, from either source, and the
    // two sources must agree about that.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingPendapatanGiro("2026-01-09", PENDAPATAN_GIRO_FEB);
    const saldo = await d.tutupDanBekukan(jan);

    const bekuGiro = saldo.find((s) => s.akun_kode === d.akun.pendapatanJasaGiro.kode)!;
    // The frozen row IS negative, debit-positive. Asserted so the test below
    // cannot pass by the sign never having been a problem.
    expect(kurangUang(bekuGiro.mutasi_debit, bekuGiro.mutasi_kredit)).toBe(
      negasiUang(PENDAPATAN_GIRO_FEB),
    );

    d.setelJam("2026-03-15");
    await baselineKeuangan([
      {
        akunId: d.akun.pendapatanJasaGiro.id,
        uraian: "Target jasa giro Januari",
        bulan: 1,
        jumlahAnggaran: rp(1_500_000),
      },
    ]);
    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
      d.ctx.adminPusat,
    );
    expect(l.baris[0].realisasi).toBe(PENDAPATAN_GIRO_FEB);
    expect(l.baris[0].sumberRealisasi).toBe("SALDO_AKUN_PERIODE");
  });

  test("periode CLOSED tanpa baris saldo ditolak, bukan diam diam dihitung ulang dari ledger", async () => {
    kodeAda(KODE_RKA.SALDO_PERIODE_TIDAK_ADA);
    // A closed period whose freeze did not happen is a broken close, not a
    // licence to recompute. Recomputing would produce a plausible figure and
    // hide the fact that the period's trial balance is missing, which is a far
    // bigger problem than this report.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", BEBAN_OPERASIONAL_FEB);
    await d.tutupTanpaBekukan(jan);

    d.setelJam("2026-03-15");
    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
      },
    ]);
    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
          d.ctx.adminPusat,
        ),
      KODE_RKA.SALDO_PERIODE_TIDAK_ADA,
    );
  });
});

describe("kumulatif yang melintasi periode CLOSED dan periode OPEN memakai KEDUA sumber", () => {
  test("Januari beku, Februari hidup, dan laporan menyebut sumber per periode", async () => {
    // The case a single figure cannot reveal. A year-to-date column spanning a
    // closed month and an open one must read each from its own source; an
    // implementation that picked one source for the whole window produces the
    // same total on clean data and diverges silently the first time a frozen
    // figure and a live one disagree.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", rp(2_000_000));
    await d.tutupDanBekukan(jan);

    const geser = rp(300_000);
    await d.geserSaldoBeku(jan.id, d.akun.bebanOperasional.id, geser);

    d.setelJam("2026-02-20");
    await d.postingBebanOperasional("2026-02-14", rp(1_500_000));

    d.setelJam("2026-03-15");
    await baselineKeuangan([
      { akunId: d.akun.bebanOperasional.id, uraian: "Beban Januari", bulan: 1, jumlahAnggaran: rp(3_000_000) },
      { akunId: d.akun.bebanOperasional.id, uraian: "Beban Februari", bulan: 2, jumlahAnggaran: rp(3_000_000) },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      {
        tahun: TAHUN_RKA,
        jenis: "KEUANGAN",
        cabangId: d.cabangId,
        mode: "KUMULATIF_YTD",
        bulan: 2,
      },
      d.ctx.adminPusat,
    );

    // January from the frozen table (so the 300.000 shift is included),
    // February from the live ledger.
    const bekuJan = (await d.bacaSaldoAkunPeriode(jan.id)).find(
      (s) => s.akun_kode === d.akun.bebanOperasional.kode,
    )!;
    const januariBeku = kurangUang(bekuJan.mutasi_debit, bekuJan.mutasi_kredit);
    const februariHidup = await d.mutasiNormal(
      d.akun.bebanOperasional.id,
      "2026-02-01",
      "2026-02-28",
      d.cabangId,
    );
    expect(l.baris[0].realisasi).toBe(jumlahUang(januariBeku, februariHidup));

    // A whole-window live reading would have produced a DIFFERENT number, which
    // is what makes the assertion above meaningful.
    const seluruhnyaHidup = await d.mutasiNormal(
      d.akun.bebanOperasional.id,
      "2026-01-01",
      "2026-02-28",
      d.cabangId,
    );
    expect(l.baris[0].realisasi).not.toBe(seluruhnyaHidup);

    // And the report SAYS which source answered for which month, per period.
    expect(l.sumberPerPeriode).toHaveLength(2);
    const perBulan = Object.fromEntries(l.sumberPerPeriode.map((s) => [s.bulan, s.sumber]));
    expect(perBulan[1]).toBe("SALDO_AKUN_PERIODE");
    expect(perBulan[2]).toBe("V_LEDGER_BARIS");
    // A mixed window cannot claim a single source on its rows, so the row's
    // own `sumberRealisasi` must not silently pick one. It reports the frozen
    // source only when EVERY month in the window was frozen.
    expect(l.baris[0].sumberRealisasi).toBe("V_LEDGER_BARIS");
  });
});

// ---------------------------------------------------------------------------
// The schema gap, filed as a refusal
// ---------------------------------------------------------------------------

describe("TEMUAN: periode CLOSED tidak punya angka beku per sektor atau per bidang", () => {
  test("metodeRealisasi menjawab TIDAK_TERSEDIA untuk PUMK dan NON_PUMK di periode CLOSED", async () => {
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.tutupDanBekukan(jan);
    const feb = d.periode(2026, 2);

    // The gap is about the CLOSED case only: an open period reads the ledger,
    // where Non PUMK carries `bidangId` on the line and PUMK is joinable.
    expect(await d.engine.metodeRealisasi({ periodeId: feb.id, jenis: "PUMK" }, d.ctx.adminPusat))
      .toBe("V_LEDGER_BARIS");
    expect(
      await d.engine.metodeRealisasi({ periodeId: jan.id, jenis: "KEUANGAN" }, d.ctx.adminPusat),
    ).toBe("SALDO_AKUN_PERIODE");

    // THE GAP.
    for (const jenis of ["PUMK", "NON_PUMK"] as const) {
      expect(
        `${jenis}=${await d.engine.metodeRealisasi({ periodeId: jan.id, jenis }, d.ctx.adminPusat)}`,
      ).toBe(`${jenis}=TIDAK_TERSEDIA`);
    }
    // The column list that causes it, restated as the thing to change.
    expect(await d.kolomAda("saldo_akun_periode", "sektor_id")).toBe(false);
    expect(await d.kolomAda("saldo_akun_periode", "bidang_id")).toBe(false);
  });

  test("laporan 24 PUMK atas periode CLOSED menolak dengan SKEMA_BELUM_LENGKAP", async () => {
    kodeAda(KODE_RKA.SKEMA_BELUM_LENGKAP);
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.buatPencairanPumk({
      tanggal: "2026-01-12",
      sektorId: d.sektor.a.id,
      jumlah: rp(5_000_000),
    });
    await d.tutupDanBekukan(jan);

    d.setelJam("2026-03-15");
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Target Perdagangan Januari",
            bulan: 1,
            jumlahAnggaran: rp(6_000_000),
            jumlahUnit: 2,
          },
        ],
      },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);

    const err = await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          { tahun: TAHUN_RKA, jenis: "PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
          d.ctx.adminPusat,
        ),
      KODE_RKA.SKEMA_BELUM_LENGKAP,
    );
    // Readable by an accountant, and it says WHY the report stopped rather
    // than naming a table.
    expect(err.message.length).toBeGreaterThan(30);
    expect(err.message).not.toMatch(/saldo_akun_periode|sektor_id/);
  });

  test("laporan 24 Non PUMK atas periode CLOSED menolak juga, meski dimensinya ada di ledger", async () => {
    // Non PUMK is a NEAR MISS rather than a second instance of the same
    // defect: `PENYALURAN_NON_PUMK` does carry `bidangId` on the line, so its
    // attribution is immutable ledger data and would survive a
    // recomputation. It still has nowhere FROZEN to read from, so spec 10's
    // rule cannot be satisfied and the refusal is the same. Worth a separate
    // test because the two are fixed by different changes: PUMK needs the
    // dimension on the journal line as well as the frozen column, Non PUMK
    // needs only the frozen column.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    const salur = await d.buatPenyaluranNonPumk({
      tanggal: "2026-01-12",
      bidangId: d.bidang.a.id,
      jumlah: rp(4_000_000),
    });
    // The evidence for "near miss": the dimension IS on the ledger line.
    expect(
      await d.mutasiLedgerDimensi(
        salur.akunBebanId,
        "bidangId",
        d.bidang.a.id,
        "2026-01-01",
        "2026-01-31",
      ),
    ).toBe(rp(4_000_000));

    await d.tutupDanBekukan(jan);
    d.setelJam("2026-03-15");
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Anggaran Pendidikan Januari",
            bulan: 1,
            jumlahAnggaran: rp(5_000_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);

    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
          d.ctx.adminPusat,
        ),
      KODE_RKA.SKEMA_BELUM_LENGKAP,
    );
  });

  test("kumulatif yang MENYENTUH satu periode CLOSED juga menolak untuk PUMK", async () => {
    // The window matters, not just the reported month: a year-to-date column
    // through February over a closed January is exactly as unreproducible as
    // the January column on its own, and a report that answered it would be
    // the first place the refusal leaks.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.buatPencairanPumk({
      tanggal: "2026-01-12",
      sektorId: d.sektor.a.id,
      jumlah: rp(5_000_000),
    });
    await d.tutupDanBekukan(jan);

    d.setelJam("2026-02-20");
    await d.buatPencairanPumk({
      tanggal: "2026-02-10",
      sektorId: d.sektor.a.id,
      jumlah: rp(3_000_000),
    });
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Target Perdagangan",
            bulan: 2,
            jumlahAnggaran: rp(6_000_000),
            jumlahUnit: 2,
          },
        ],
      },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);

    // February alone is fine: its period is OPEN.
    const feb = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(feb.baris[0].sumberRealisasi).toBe("V_LEDGER_BARIS");

    // Year to date reaches back into January, which is closed.
    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          {
            tahun: TAHUN_RKA,
            jenis: "PUMK",
            cabangId: d.cabangId,
            mode: "KUMULATIF_YTD",
            bulan: 2,
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.SKEMA_BELUM_LENGKAP,
    );
  });

  test("RKA Keuangan atas periode CLOSED TIDAK menolak, jadi penolakan di atas adalah tentang dimensi", async () => {
    // The control. Without it, an engine that refused every closed period
    // would pass all three tests above while breaking the one budget type that
    // spec 10's rule can actually be satisfied for.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", BEBAN_OPERASIONAL_FEB);
    await d.tutupDanBekukan(jan);

    d.setelJam("2026-03-15");
    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
      },
    ]);
    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
      d.ctx.adminPusat,
    );
    expect(l.baris[0].realisasi).toBe(BEBAN_OPERASIONAL_FEB);
    expect(l.baris[0].sumberRealisasi).toBe("SALDO_AKUN_PERIODE");
  });
});

describe("invarian 14 dinyatakan langsung: laporan periode lampau menghasilkan angka yang sama", () => {
  test("laporan Januari yang dicetak hari ini sama dengan yang dicetak saat Januari ditutup", async () => {
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", BEBAN_OPERASIONAL_FEB);
    await baselineKeuangan([
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
      },
    ]);

    const filter = {
      tahun: TAHUN_RKA,
      jenis: "KEUANGAN" as const,
      cabangId: d.cabangId,
      mode: "BULANAN" as const,
      bulan: 1,
    };
    const saatItu = await d.engine.laporanRkaVsRealisasi(filter, d.ctx.adminPusat);
    await d.tutupDanBekukan(jan);

    // Months of subsequent activity, in later periods.
    d.setelJam("2026-05-20");
    await d.postingBebanOperasional("2026-04-08", rp(6_600_000));
    await d.postingBebanOperasional("2026-05-11", rp(2_200_000));

    const hariIni = await d.engine.laporanRkaVsRealisasi(filter, d.ctx.adminPusat);
    expect(hariIni.baris.map((b) => `${b.dimensiKode}:${b.realisasi}:${b.selisih}`)).toEqual(
      saatItu.baris.map((b) => `${b.dimensiKode}:${b.realisasi}:${b.selisih}`),
    );
    expect(hariIni.total.realisasi).toBe(saatItu.total.realisasi);
    // The source changed, which is the point: the number survived BECAUSE it
    // moved to the frozen table, not because nothing happened.
    expect(saatItu.baris[0].sumberRealisasi).toBe("V_LEDGER_BARIS");
    expect(hariIni.baris[0].sumberRealisasi).toBe("SALDO_AKUN_PERIODE");
  });
});
