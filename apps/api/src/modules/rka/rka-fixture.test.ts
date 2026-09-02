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
// FINDING 1 and 2: the permission catalogue. BOTH CLOSED, re-pinned positive.
// ---------------------------------------------------------------------------

describe("katalog izin: kode yang spec 9.3 butuhkan, dan penjaga untuk yang belum ada", () => {
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

  test("admin.rka.approve ADA, jadi persetujuan RKA punya kode sendiri", () => {
    // RE-PINNED. This test used to assert
    //   canonicalPermission(PERMISSION_RKA.SETUJUI) === null
    //   PERMISSIONS does not contain "admin.rka.approve"
    //   PERMISSIONS.filter(includes "rka") === ["admin.rka"]
    // as a finding: with ONE code covering input and approval, the record
    // contained no second party for the document the whole system measures
    // itself against (report 24 here, "versus RKA" in reports 2 and 13, and
    // the dashboard on top of both). The catalogue now carries the code, so
    // the finding is discharged and this asserts the positive instead.
    expect(canonicalPermission(PERMISSION_RKA.SETUJUI)).toBe(PERMISSION_RKA.SETUJUI);
    expect(PERMISSIONS as readonly string[]).toContain(PERMISSION_RKA.SETUJUI);
    expect(PERMISSIONS.filter((p) => p.includes("rka")).sort()).toEqual([
      "admin.rka",
      "admin.rka.approve",
      "admin.rka.view",
    ]);

    // WHAT THE CODE DOES NOT BY ITSELF SETTLE, and the reason FINDING 3 below
    // still matters: ADMIN_PUSAT holds BOTH `admin.rka` and
    // `admin.rka.approve`, so on the shipped matrix one person can still draft
    // and approve the same budget. Separating those two acts is now a
    // CONFIGURATION question (`rka.pemisahan_tugas_persetujuan`) rather than a
    // missing code, which is what makes it the client's decision to make.
    const pemegangSetujui = (
      Object.keys(PERMISSIONS_BY_ROLE) as Array<keyof typeof PERMISSIONS_BY_ROLE>
    )
      .filter((r) => PERMISSIONS_BY_ROLE[r].includes(PERMISSION_RKA.SETUJUI))
      .sort();
    expect(pemegangSetujui).toEqual(["ADMIN_PUSAT"]);
  });

  test("admin.rka.view ADA dan Auditor memegangnya, tanpa memegang kode tulis", () => {
    // RE-PINNED. This test used to assert
    //   canonicalPermission(PERMISSION_RKA.LIHAT) === null
    // as a finding: spec 2 gives the Auditor "read only penuh termasuk semua
    // laporan dan audit trail", and without a read code for the budgets it
    // could open report 24 but not see which version the report was measured
    // against. The catalogue now carries the code, along exactly the precedent
    // the old test named (`admin.closing.view`), so this asserts the positive.
    expect(canonicalPermission(PERMISSION_RKA.LIHAT)).toBe(PERMISSION_RKA.LIHAT);

    // The shape of the CLOSE, stated as data rather than as prose: the Auditor
    // now reaches the budget versions report 24 compares against, and still
    // holds no code that writes one.
    const auditor = PERMISSIONS_BY_ROLE.AUDITOR as readonly string[];
    expect(auditor).toContain(PERMISSION_RKA.LAPORAN);
    expect(auditor).toContain(PERMISSION_RKA.LIHAT);
    expect(auditor).not.toContain(PERMISSION_RKA.KELOLA);
    expect(auditor).not.toContain(PERMISSION_RKA.SETUJUI);

    // The precedent it followed, kept because it is what made the case: the
    // closing module hit exactly this and the catalogue carries a read-only
    // evidence code for it.
    expect(auditor).toContain("admin.closing.view");
  });

  test("penjaga IZIN_BELUM_TERDAFTAR masih hidup, karena kode yang tidak dikirim masih ada", () => {
    // THE GUARD THE TWO DISCHARGES ABOVE COULD HAVE KILLED. The engine fails
    // closed on a permission the catalogue does not carry
    // (`IZIN_BELUM_TERDAFTAR`) rather than treating it as granted. Now that
    // both RKA codes ship, nothing in this folder would notice if
    // `canonicalPermission` started answering for anything at all, and the
    // fail-closed path would become dead code that still looks alive.
    //
    // So this pins the MECHANISM on strings the catalogue genuinely lacks,
    // rather than on the two it gained. It must keep passing after every
    // future code is added.
    for (const belumAda of ["admin.rka.delete", "admin.rka.export", "rka.approve"]) {
      expect(canonicalPermission(belumAda)).toBeNull();
      expect(PERMISSIONS as readonly string[]).not.toContain(belumAda);
    }
    // And a code that DOES ship still resolves, so the check above is about
    // the catalogue and not about `canonicalPermission` being broken.
    expect(canonicalPermission(PERMISSION_RKA.KELOLA)).toBe(PERMISSION_RKA.KELOLA);
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
// FINDING 3: the parameter catalogue. CLOSED, re-pinned positive.
// ---------------------------------------------------------------------------

describe("katalog parameter: kunci kebijakan pemisahan tugas RKA, dan penjaganya", () => {
  test("akuntansi.tahun_buku_mulai_bulan ADA, jadi jendela kumulatif punya sumber yang sah", async () => {
    const { grup, kunci } = KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN;
    const entri = KATALOG[`${grup}.${kunci}`];
    expect(entri).toBeDefined();
    expect(entri?.bentuk).toBe("INTEGER");
    // And this world carries its own bumn-scoped row, so a test can move it
    // without touching anybody else's global default.
    expect(await d.bacaKonfigurasi("akuntansi", "tahun_buku_mulai_bulan")).toBe("1");
  });

  test("rka.pemisahan_tugas_persetujuan ADA di katalog, sebagai ASUMSI yang dinyatakan", () => {
    // RE-PINNED. This test used to assert
    //   KATALOG["rka.pemisahan_tugas_persetujuan"] === undefined
    //   Object.keys(KATALOG).filter(startsWith "rka.") === []
    // as a finding: whether one Admin Pusat may draft AND approve the annual
    // budget alone is a control decision belonging to the client, spec 2
    // scopes its two segregation rules to "dua modul (PUMK dan Non PUMK)", and
    // a default invented in a fixture would have shipped as policy.
    //
    // THE FINDING WAS DISCHARGED THE RIGHT WAY ROUND, which is why this test
    // asserts the PROVENANCE and not just the presence: the key exists, its
    // default is labelled `asalNilaiDefault: "ASUMSI"`, and its description
    // says in as many words that it is waiting on the client. A key that
    // shipped as `KEBIJAKAN` or `SPEC` would be the system asserting a control
    // the client never chose, and would be a worse state than the gap was.
    const { grup, kunci } = KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN;
    const entri = KATALOG[`${grup}.${kunci}`];
    expect(entri).toBeDefined();
    expect(entri?.bentuk).toBe("BOOLEAN");
    expect(entri?.asalNilaiDefault).toBe("ASUMSI");
    expect(entri?.deskripsi).toContain("menunggu keputusan klien");
    // And it is the only `rka.` key, so nothing else arrived unannounced.
    expect(Object.keys(KATALOG).filter((k) => k.startsWith("rka."))).toEqual([
      "rka.pemisahan_tugas_persetujuan",
    ]);
  });

  test("penjaga fixture masih hidup: kunci yang benar benar tidak terkatalog tetap ditolak", async () => {
    // THE GUARD THE DISCHARGE ABOVE COULD HAVE KILLED, and the reason it was
    // written: without it, the first person to make ./rka-otorisasi.test.ts
    // green would have added the row to KONFIGURASI_AWAL and the gap would
    // have vanished from the record instead of being closed on purpose.
    //
    // It is now pinned on a key the catalogue GENUINELY lacks, so the refusal
    // stays exercised after the one it used to name started shipping. A
    // fixture that will write any key at all is a fixture that can invent a
    // parameter, and an invented parameter is policy nobody decided.
    await expect(
      d.setelKonfigurasi("rka", "batas_revisi_per_tahun", "3"),
    ).rejects.toThrow(/tidak ada di katalog konfigurasi terkirim/);

    // And the catalogued key IS writable, so the refusal above is about the
    // catalogue rather than about `setelKonfigurasi` refusing everything.
    await d.setelKonfigurasi("rka", "pemisahan_tugas_persetujuan", "false");
    expect(await d.bacaKonfigurasi("rka", "pemisahan_tugas_persetujuan")).toBe("false");
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

  // -------------------------------------------------------------------------
  // THE TWO TESTS BELOW ARE PINS ON AN OPEN GAP, AND GOING RED IS THE GOAL.
  //
  // They assert that `PENCAIRAN_PUMK` writes NO `sektorId` into
  // `jurnal_baris.dimensi_json`, and they demonstrate the consequence: a
  // per-sector figure derived from `pumk_akad -> pumk_proposal.sektor_id`
  // moves when somebody reclassifies a proposal, for a month that has already
  // been reported.
  //
  // ADR 0016 section 2 hands the fix to modules/pumk: pass
  // `dimensi: { sektorId }` on the receivable leg, the way
  // `PENYALURAN_NON_PUMK` already passes `bidangId`. THE DAY THAT LANDS, BOTH
  // TESTS GO RED. That is the signal that the gap is closed, not a regression
  // to debug and not a reason to revert the PUMK change: delete both tests and
  // replace them with the positive assertion that the disbursement carries its
  // sector, next to the Non PUMK one it is contrasted with here.
  //
  // What the fix cannot reach, so nobody looks for it: `jurnal_baris` is
  // immutable (ADR 0005), so already-posted disbursements never gain the
  // dimension, and periods closed before it lands can only be derived from the
  // mutable join.
  // -------------------------------------------------------------------------

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
