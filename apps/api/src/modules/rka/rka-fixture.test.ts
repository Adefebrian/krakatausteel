// THE FIXTURE'S OWN TEST, AND THE FINDINGS THIS MODULE REFUSES TO WORK AROUND.
//
// Everything here must be GREEN today, with the engine unimplemented. Nothing
// in this file calls `d.engine`. Two reasons:
//
//   1. A red suite is only evidence if the arrangement is trustworthy. When
//      ./rka-laporan-24.test.ts fails, the reader has to be able to tell "the
//      report method does not exist" from "the disbursement the report was
//      supposed to read was never created". This file makes the second half
//      of that a settled question.
//   2. The findings below are claims about the SHIPPED catalogues and the
//      SHIPPED schema, not about this module. They are true whether or not the
//      engine is written, and each one is a test that goes RED the day the gap
//      is closed, which is how it gets noticed and removed.
//
// REPEATABILITY IS PART OF THE FIXTURE'S CONTRACT. `bun run db:reset` is not
// run between files (and other agents share `tjsl_test`, where a reset would
// drop the schema underneath them), so a fixture that reused a business key
// would pass on a fresh database and fail on the second run. Every key goes
// through `kunci()`, and the last describe block builds two worlds in one
// process and proves they do not collide.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS, PERMISSIONS_BY_ROLE, canonicalPermission } from "../auth";
import { KATALOG } from "../konfigurasi/index";
import { KUNCI_KONFIGURASI_RKA, PERMISSION_RKA } from "./contract";
import {
  BEBAN_OPERASIONAL_FEB,
  PENCAIRAN_SEKTOR_A,
  PENCAIRAN_SEKTOR_B,
  PENDAPATAN_GIRO_FEB,
  PENYALURAN_BIDANG_A,
  REALISASI_BIDANG_A,
  buatDunia,
  jumlahUang,
  keSen,
  kurangUang,
  negasiUang,
  persenCapaian,
  rp,
  type DuniaRka,
} from "./test-support";

let d: DuniaRka;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

// ---------------------------------------------------------------------------
// FINDING 1 and 2: the permission catalogue
// ---------------------------------------------------------------------------

describe("TEMUAN: katalog izin tidak punya kode yang spec 9.3 butuhkan", () => {
  test("admin.rka ADA dan hanya dipegang Admin Pusat, jadi input RKA memang terkatalog", async () => {
    // The positive half, first, so the two findings below cannot be read as
    // "RKA has no permissions at all". The input side is covered.
    expect(canonicalPermission(PERMISSION_RKA.KELOLA)).toBe(PERMISSION_RKA.KELOLA);
    expect(d.ctx.adminPusat.permissions).toContain(PERMISSION_RKA.KELOLA);

    // And who does NOT hold it, read from the SHIPPED matrix rather than
    // asserted as policy. This is an observation for the report, not a claim
    // that Admin Cabang ought to be excluded: a branch-scoped RKA
    // (`rka.cabang_id` is nullable precisely so a branch can have one) with no
    // branch-level holder of `admin.rka` means every branch budget has to be
    // typed by head office. That is a question for the client, filed rather
    // than decided here.
    const pemegang = (Object.keys(PERMISSIONS_BY_ROLE) as Array<keyof typeof PERMISSIONS_BY_ROLE>)
      .filter((r) => PERMISSIONS_BY_ROLE[r].includes(PERMISSION_RKA.KELOLA))
      .sort();
    expect(pemegang).toEqual(["ADMIN_PUSAT"]);
  });

  test("TEMUAN: admin.rka.approve tidak ada, jadi penyusun RKA juga yang menyetujuinya", () => {
    // The whole system measures itself against the DISETUJUI baseline: report
    // 24 here, "versus RKA" in reports 2 and 13, and the dashboard on top of
    // both. With one code covering input and approval, the record contains no
    // second party for that document, ever.
    //
    // This test goes RED the day the code is added, which is the signal to
    // delete it and turn ./rka-otorisasi.test.ts's fail-closed pin into a
    // positive assertion.
    expect(canonicalPermission(PERMISSION_RKA.SETUJUI)).toBeNull();
    expect(PERMISSIONS as readonly string[]).not.toContain(PERMISSION_RKA.SETUJUI);

    // And it is not reachable under another spelling: no shipped code contains
    // both "rka" and an approval verb.
    const mirip = PERMISSIONS.filter((p) => p.includes("rka"));
    expect(mirip).toEqual(["admin.rka"]);
  });

  test("TEMUAN: admin.rka.view tidak ada, jadi Auditor tidak bisa melihat versi mana yang jadi baseline", () => {
    expect(canonicalPermission(PERMISSION_RKA.LIHAT)).toBeNull();

    // The shape of the gap, stated as data rather than as prose: the Auditor
    // holds the report code, so report 24 opens for it, but holds nothing that
    // reaches the budget versions the report compares against.
    const auditor = PERMISSIONS_BY_ROLE.AUDITOR as readonly string[];
    expect(auditor).toContain(PERMISSION_RKA.LAPORAN);
    expect(auditor).not.toContain(PERMISSION_RKA.KELOLA);

    // The precedent this follows, and the proof it is a precedent and not an
    // analogy: the closing module hit exactly this and the catalogue now
    // carries a read-only evidence code for it.
    expect(auditor).toContain("admin.closing.view");
  });

  test("laporan.view memang cukup untuk laporan 24, jadi hanya SATU kode baca yang kurang", () => {
    // Report 24 IS one of the 31 reports of spec 10, so gating it on
    // `laporan.view` is not a compromise: every role that may read reports
    // already holds it, including the Auditor and every operational role.
    expect(canonicalPermission(PERMISSION_RKA.LAPORAN)).toBe(PERMISSION_RKA.LAPORAN);
    for (const nama of ["maker", "checker", "approver", "auditor", "adminPusat"] as const) {
      expect(`${nama}:${d.ctx[nama].permissions.includes(PERMISSION_RKA.LAPORAN)}`).toBe(
        `${nama}:true`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// FINDING 3: the parameter catalogue
// ---------------------------------------------------------------------------

describe("TEMUAN: katalog parameter tidak punya kunci kebijakan pemisahan tugas RKA", () => {
  test("akuntansi.tahun_buku_mulai_bulan ADA, jadi jendela kumulatif punya sumber yang sah", async () => {
    const { grup, kunci } = KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN;
    const entri = KATALOG[`${grup}.${kunci}`];
    expect(entri).toBeDefined();
    expect(entri?.bentuk).toBe("INTEGER");
    // And this world carries its own bumn-scoped row, so a test can move it
    // without touching anybody else's global default.
    expect(await d.bacaKonfigurasi("akuntansi", "tahun_buku_mulai_bulan")).toBe("1");
  });

  test("TEMUAN: rka.pemisahan_tugas_persetujuan tidak ada di katalog", () => {
    const { grup, kunci } = KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN;
    expect(KATALOG[`${grup}.${kunci}`]).toBeUndefined();
    expect(Object.keys(KATALOG).filter((k) => k.startsWith("rka."))).toEqual([]);

    // WHY IT IS A FINDING RATHER THAN A KEY WE ADD IN A FIXTURE.
    // Spec 2 scopes its two segregation rules to "dua modul (PUMK dan Non
    // PUMK)". The RKA has an approval and no Checker stage, so neither rule
    // reaches it verbatim, and whether one Admin Pusat may draft AND approve
    // the annual budget alone is a control decision belonging to the client.
    // A default invented here would ship as policy.
  });

  test("fixture menolak menulis kunci yang tidak terkatalog, jadi temuan di atas tidak bisa ditutup diam diam", async () => {
    // The guard that makes the previous test durable. Without it, the first
    // person to make ./rka-otorisasi.test.ts green would add the row to
    // KONFIGURASI_AWAL and the gap would vanish from the record.
    await expect(
      d.setelKonfigurasi("rka", "pemisahan_tugas_persetujuan", "true"),
    ).rejects.toThrow(/tidak ada di katalog konfigurasi terkirim/);
  });
});

// ---------------------------------------------------------------------------
// FINDING 4: where a frozen figure per sector or per bidang lives.
// THE SCHEMA HALF IS CLOSED (migrations/0027, ADR 0016); the WRITE is not.
// ---------------------------------------------------------------------------

describe("TEMUAN: dekomposisi beku per sektor dan per bidang", () => {
  test("dekomposisinya adalah tabel anak saldo_akun_dimensi_periode, bukan kolom di saldo_akun_periode", async () => {
    // RE-PINNED. This test used to assert
    //   kolomAda("saldo_akun_periode", "sektor_id") === false
    //   kolomAda("saldo_akun_periode", "bidang_id") === false
    // as the gap: a closed period had nowhere to hold a per-sektor or
    // per-bidang figure. The fix turned out to be table shaped, not column
    // shaped (ADR 0016: dimensioned rows in the parent table would inflate
    // every existing unfiltered reader of it), so a column-shaped pin would
    // stay green forever and record the gap as open after it was closed.
    expect(await d.kolomAda("saldo_akun_periode", "akun_id")).toBe(true);
    expect(await d.kolomAda("saldo_akun_periode", "cabang_id")).toBe(true);
    // The parent still carries NO dimension, deliberately, and that is now the
    // design rather than the gap.
    expect(await d.kolomAda("saldo_akun_periode", "sektor_id")).toBe(false);
    expect(await d.kolomAda("saldo_akun_periode", "bidang_id")).toBe(false);
    // The child that does carry it.
    expect(await d.tabelAda("saldo_akun_dimensi_periode")).toBe(true);
    expect(await d.kolomAda("saldo_akun_dimensi_periode", "saldo_akun_periode_id")).toBe(true);
    expect(await d.kolomAda("saldo_akun_dimensi_periode", "sumbu")).toBe(true);
    expect(await d.kolomAda("saldo_akun_dimensi_periode", "sektor_id")).toBe(true);
    expect(await d.kolomAda("saldo_akun_dimensi_periode", "bidang_id")).toBe(true);

    // WHAT IS STILL OPEN, and it is the reason ./rka-realisasi-sumber.test.ts
    // keeps pinning the refusal: spec 10 requires a closed period's figures to
    // come from the frozen snapshot (invariant 14), and modules/closing does
    // not yet WRITE this table. RKA Keuangan is per akun and survives. RKA
    // PUMK (per sektor) and RKA Non PUMK (per bidang) still have nothing
    // frozen to read, so the report must refuse rather than recompute.
  });

  test("jurnal PENCAIRAN_PUMK tidak membawa sektorId, jadi sektor hanya bisa dijoin dari master yang bisa berubah", async () => {
    d.setelJam("2026-02-15");
    const cair = await d.buatPencairanPumk({ tanggal: "2026-02-10", sektorId: d.sektor.a.id });

    const dimensi = await d.dimensiBarisJurnal(cair.jurnalId);
    expect(dimensi.length).toBe(2);
    for (const dim of dimensi) {
      expect(Object.keys(dim)).not.toContain("sektorId");
    }

    // The contrast that makes it a defect rather than a style choice: the Non
    // PUMK disbursement DOES carry its dimension, so its attribution is
    // immutable ledger data and PUMK's is not.
    const salur = await d.buatPenyaluranNonPumk({ tanggal: "2026-02-20" });
    const dimensiNonPumk = await d.dimensiBarisJurnal(salur.jurnalId);
    expect(dimensiNonPumk.some((x) => x.bidangId === d.bidang.a.id)).toBe(true);
  });

  test("mengubah sektor di proposal MENGUBAH atribusi realisasi PUMK, yang melanggar invarian 14", async () => {
    // The proof that the missing dimension has teeth. Nothing here is about
    // the RKA engine: it is about what the ONLY available source of a
    // per-sector figure does when master data moves.
    d.setelJam("2026-02-15");
    const cair = await d.buatPencairanPumk({ tanggal: "2026-02-10", sektorId: d.sektor.a.id });

    const sebelumA = await d.totalPencairanPumk({
      sektorId: d.sektor.a.id,
      dari: "2026-02-01",
      sampai: "2026-02-28",
    });
    expect(sebelumA).toBe(cair.jumlah);

    // A reclassification: the sort of correction a Maker makes months later.
    await d.db.query(`update pumk_proposal set sektor_id = $2 where id = $1`, [
      cair.proposalId,
      d.sektor.b.id,
    ]);

    const sesudahA = await d.totalPencairanPumk({
      sektorId: d.sektor.a.id,
      dari: "2026-02-01",
      sampai: "2026-02-28",
    });
    const sesudahB = await d.totalPencairanPumk({
      sektorId: d.sektor.b.id,
      dari: "2026-02-01",
      sampai: "2026-02-28",
    });
    // The same historical month now reports differently. The LEDGER did not
    // move: only the master row did.
    expect(sesudahA).toBe("0.00");
    expect(sesudahB).toBe(cair.jumlah);
    expect(sesudahA).not.toBe(sebelumA);
  });
});

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

describe("fixture: realisasi dibuat oleh mesin yang sebenarnya", () => {
  test("pencairan PUMK memakai mesin angsuran dan mesin jurnal nyata, dan tercatat di kedua tempat", async () => {
    d.setelJam("2026-02-15");
    const cair = await d.buatPencairanPumk({
      tanggal: "2026-02-10",
      sektorId: d.sektor.a.id,
      jumlah: PENCAIRAN_SEKTOR_A,
    });

    // The disbursement report's source.
    expect(
      await d.totalPencairanPumk({
        sektorId: d.sektor.a.id,
        dari: "2026-02-01",
        sampai: "2026-02-28",
      }),
    ).toBe(PENCAIRAN_SEKTOR_A);
    expect(
      await d.jumlahMitraDicairkan({
        sektorId: d.sektor.a.id,
        dari: "2026-02-01",
        sampai: "2026-02-28",
      }),
    ).toBe(1);

    // The ledger's. Receivable is debit-normal, so the movement is positive.
    expect(
      await d.mutasiNormal(d.akun.piutangPokok.id, "2026-02-01", "2026-02-28"),
    ).toBe(PENCAIRAN_SEKTOR_A);

    // A real schedule exists, from the real instalment engine.
    const jadwal = await d.db.query<{ n: string }>(
      `select count(*)::text as n from pumk_jadwal_angsuran where akad_id = $1 and is_active_version`,
      [cair.akadId],
    );
    expect(Number.parseInt(jadwal[0].n, 10)).toBe(12);
  });

  test("penyaluran Non PUMK menjalankan seluruh state machine nyata, dan LPJ memposting pengembalian", async () => {
    d.setelJam("2026-04-15");
    const salur = await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.a.id,
      jumlah: PENYALURAN_BIDANG_A,
      realisasiLpj: REALISASI_BIDANG_A,
      tanggalLpj: "2026-03-05",
    });

    expect(salur.pengembalian).toBe(kurangUang(PENYALURAN_BIDANG_A, REALISASI_BIDANG_A));
    expect(salur.jurnalPengembalianId).not.toBeNull();

    // Report 13's source is GROSS.
    expect(
      await d.totalPenyaluranNonPumk({
        bidangId: d.bidang.a.id,
        dari: "2026-01-01",
        sampai: "2026-12-31",
      }),
    ).toBe(PENYALURAN_BIDANG_A);
    // The refund is a separate movement, in the ledger, in a later month.
    expect(
      await d.totalPengembalianNonPumk({
        bidangId: d.bidang.a.id,
        dari: "2026-01-01",
        sampai: "2026-12-31",
      }),
    ).toBe(salur.pengembalian);

    // And the expense account nets out to what was actually spent, which is
    // the number a budget is measured against.
    expect(
      await d.mutasiNormal(d.akun.bebanNonPumk.id, "2026-01-01", "2026-12-31"),
    ).toBe(REALISASI_BIDANG_A);
  });

  test("beban dan pendapatan bergerak di arah saldo normal masing masing", async () => {
    d.setelJam("2026-02-15");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-02-05", BEBAN_OPERASIONAL_FEB);
    await d.postingPendapatanGiro("2026-02-07", PENDAPATAN_GIRO_FEB);

    // An expense account is debit-normal: spending is positive.
    expect(await d.mutasiNormal(d.akun.bebanOperasional.id, "2026-02-01", "2026-02-28")).toBe(
      BEBAN_OPERASIONAL_FEB,
    );
    // A revenue account is credit-normal: earning is positive in normal sign
    // and NEGATIVE debit-positive. Report 24 must show the first, or a revenue
    // target of 1.140.000 would read as minus 1.140.000 achieved.
    expect(await d.mutasiNormal(d.akun.pendapatanJasaGiro.id, "2026-02-01", "2026-02-28")).toBe(
      PENDAPATAN_GIRO_FEB,
    );
    expect(await d.mutasiLedger(d.akun.pendapatanJasaGiro.id, "2026-02-01", "2026-02-28")).toBe(
      negasiUang(PENDAPATAN_GIRO_FEB),
    );
  });
});

describe("fixture: pembekuan saldo periode", () => {
  test("saldo beku cocok dengan v_ledger_baris dan memenuhi identitas neraca lajur", async () => {
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", BEBAN_OPERASIONAL_FEB);

    const saldo = await d.tutupDanBekukan(jan);
    expect(saldo.length).toBeGreaterThan(1);
    expect((await d.bacaPeriode(jan.id)).status).toBe("CLOSED");

    for (const s of saldo) {
      // The identity the schema also checks, asserted here so a broken freeze
      // fails in this file rather than weakening a report assertion elsewhere.
      expect(`${s.akun_kode}:${s.saldo_akhir}`).toBe(
        `${s.akun_kode}:${kurangUang(jumlahUang(s.saldo_awal, s.mutasi_debit), s.mutasi_kredit)}`,
      );
      // And the ledger predicate: this is the ADR 0010 reading, which is what
      // modules/closing is required to freeze too.
      expect(`${s.akun_kode}:${kurangUang(s.mutasi_debit, s.mutasi_kredit)}`).toBe(
        `${s.akun_kode}:${await d.mutasiLedger(s.akun_id, jan.tanggalMulai, jan.tanggalAkhir, s.cabang_id)}`,
      );
    }
    // A frozen trial balance sums to zero across every account, debit-positive.
    expect(jumlahUang(...saldo.map((s) => s.saldo_akhir))).toBe("0.00");
  });

  test("geserSaldoBeku membuat data beku dan ledger hidup berbeda, tanpa melanggar CHECK", async () => {
    // This helper exists so a report test can prove WHICH source was read.
    // If it did not actually produce a divergence, every such test would pass
    // vacuously, so the divergence itself is asserted here.
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-01-12", BEBAN_OPERASIONAL_FEB);
    await d.tutupDanBekukan(jan);

    const geser = rp(999_000);
    await d.geserSaldoBeku(jan.id, d.akun.bebanOperasional.id, geser);

    const beku = (await d.bacaSaldoAkunPeriode(jan.id)).find(
      (s) => s.akun_kode === d.akun.bebanOperasional.kode,
    );
    const hidup = await d.mutasiLedger(
      d.akun.bebanOperasional.id,
      jan.tanggalMulai,
      jan.tanggalAkhir,
    );
    expect(kurangUang(beku!.mutasi_debit, beku!.mutasi_kredit)).toBe(jumlahUang(hidup, geser));
    expect(kurangUang(beku!.mutasi_debit, beku!.mutasi_kredit)).not.toBe(hidup);
    // Identity still holds, so the row is one the engine could legitimately
    // have written and the divergence is not detectable as corruption.
    expect(beku!.saldo_akhir).toBe(
      kurangUang(jumlahUang(beku!.saldo_awal, beku!.mutasi_debit), beku!.mutasi_kredit),
    );
  });

  test("tutupTanpaBekukan meninggalkan periode CLOSED tanpa satu pun baris saldo", async () => {
    const jan = d.periode(2026, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.tutupTanpaBekukan(jan);

    expect((await d.bacaPeriode(jan.id)).status).toBe("CLOSED");
    expect(await d.bacaSaldoAkunPeriode(jan.id)).toHaveLength(0);
  });
});

describe("ADR 0010: predikat naif dan predikat ledger memang berbeda di dunia ini", () => {
  test("beban yang dibalik: v_ledger_baris nol, filter POSTED saja minus", async () => {
    // The divergence report 24 must not reproduce. Asserted in the fixture
    // file so that when ./rka-realisasi-sumber.test.ts says "the report used
    // the wrong predicate", the reader already knows the two predicates
    // disagree on this data.
    d.setelJam("2026-02-15");
    await d.postingAlokasiDana("2026-02-02", rp(50_000_000));
    const salah = await d.postingBebanOperasional("2026-02-10", BEBAN_OPERASIONAL_FEB);
    await d.reversalJurnal(salah.id, "Salah akun beban, dikoreksi dengan pembalik (fixture rka)");

    const benar = await d.mutasiLedger(d.akun.bebanOperasional.id, "2026-02-01", "2026-02-28");
    const naif = await d.mutasiLedgerNaifPostedSaja(
      d.akun.bebanOperasional.id,
      "2026-02-01",
      "2026-02-28",
    );
    expect(benar).toBe("0.00");
    expect(naif).toBe(negasiUang(BEBAN_OPERASIONAL_FEB));
    expect(benar).not.toBe(naif);
  });
});

describe("aritmetika laporan 24, dinyatakan sekali", () => {
  test("persenCapaian membulatkan HALF UP ke dua desimal dan menolak anggaran nol", () => {
    // The rule the report is compared against. Stated here so no test file
    // writes a rounded literal it worked out in its head.
    expect(persenCapaian(rp(5_000_000), rp(6_000_000))).toBe("83.33");
    expect(persenCapaian(rp(1), rp(3))).toBe("33.33");
    expect(persenCapaian(rp(2), rp(3))).toBe("66.67");
    expect(persenCapaian(rp(6_000_000), rp(6_000_000))).toBe("100.00");
    // Spending against a budget of zero is not zero percent and not infinity.
    expect(persenCapaian(rp(1_000_000), "0.00")).toBeNull();
    expect(persenCapaian("0.00", "0.00")).toBeNull();
  });

  test("selisih adalah anggaran dikurangi realisasi, dan boleh negatif", () => {
    expect(kurangUang(rp(6_000_000), rp(5_000_000))).toBe(rp(1_000_000));
    expect(keSen(kurangUang(rp(5_000_000), rp(6_000_000)))).toBeLessThan(0n);
  });
});

// ---------------------------------------------------------------------------
// Repeatability
// ---------------------------------------------------------------------------

describe("dua dunia berturut turut tanpa db:reset tidak bertabrakan", () => {
  test("dua dunia di satu proses punya bumn, cabang, sektor, bidang dan periode sendiri sendiri", async () => {
    const lain = await buatDunia();
    try {
      expect(lain.bumnId).not.toBe(d.bumnId);
      expect(lain.cabangId).not.toBe(d.cabangId);
      expect(lain.sektor.a.id).not.toBe(d.sektor.a.id);
      expect(lain.sektor.a.kode).not.toBe(d.sektor.a.kode);
      expect(lain.bidang.a.id).not.toBe(d.bidang.a.id);
      expect(lain.periode(2026, 1).id).not.toBe(d.periode(2026, 1).id);
      // The one deliberately SHARED row: `sdg` is global, insert-only, never
      // updated or deleted here.
      expect(lain.sdg.id).toBe(d.sdg.id);

      // Realisation in one world is invisible to the other, which is what makes
      // a report assertion in a parallel file safe.
      d.setelJam("2026-02-15");
      await d.buatPencairanPumk({ tanggal: "2026-02-10", jumlah: PENCAIRAN_SEKTOR_A });
      expect(
        await lain.totalPencairanPumk({ dari: "2026-01-01", sampai: "2026-12-31" }),
      ).toBe("0.00");
      expect(await d.totalPencairanPumk({ dari: "2026-01-01", sampai: "2026-12-31" })).toBe(
        PENCAIRAN_SEKTOR_A,
      );
    } finally {
      await lain.tutup();
    }
  });

  test("dua pencairan berturut turut di sektor berbeda dijumlahkan terpisah", async () => {
    d.setelJam("2026-03-20");
    await d.buatPencairanPumk({
      tanggal: "2026-02-10",
      sektorId: d.sektor.a.id,
      jumlah: PENCAIRAN_SEKTOR_A,
    });
    await d.buatPencairanPumk({
      tanggal: "2026-03-12",
      sektorId: d.sektor.b.id,
      jumlah: PENCAIRAN_SEKTOR_B,
    });

    const jendela = { dari: "2026-01-01", sampai: "2026-12-31" };
    expect(await d.totalPencairanPumk({ ...jendela, sektorId: d.sektor.a.id })).toBe(
      PENCAIRAN_SEKTOR_A,
    );
    expect(await d.totalPencairanPumk({ ...jendela, sektorId: d.sektor.b.id })).toBe(
      PENCAIRAN_SEKTOR_B,
    );
    expect(await d.totalPencairanPumk(jendela)).toBe(
      jumlahUang(PENCAIRAN_SEKTOR_A, PENCAIRAN_SEKTOR_B),
    );
  });
});
