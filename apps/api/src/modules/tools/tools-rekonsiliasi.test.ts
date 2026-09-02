// Spec 9.6 "Tools rekonsiliasi" and spec 8.4 check 10, at the ENGINE surface.
//
// THIS IS THE ONE THAT MATTERS OPERATIONALLY, and the reason it has its own
// file: a total is not an answer. Two akad with offsetting errors net to zero,
// and the only output somebody can act on is WHICH akad is wrong and BY HOW
// MUCH. So every assertion below is per akad first and per branch second, with
// the totals checked last as a consequence rather than as the product.
//
// The drift is manufactured the way a real defect produces it: the sub ledger
// (`pumk_akad.outstanding_pokok`) moves and no journal is posted. The ledger
// side is real -- every disbursement below is a PENCAIRAN_PUMK posted by the
// real journal engine -- so the difference the page reports is the difference
// between two things the system genuinely wrote.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolsError } from "./contract";
import { buatDuniaTools, rp, type AkadFixture, type DuniaTools } from "./test-support";

const POKOK_A1 = rp(12_000_000);
const POKOK_A2 = rp(7_500_000);
const POKOK_B1 = rp(9_000_000);
const POKOK_B2 = rp(3_400_000);

const DRIFT_A2 = rp(-1_250_000);
const DRIFT_B1 = rp(-400_000);

const TOTAL_LEDGER_A = rp(19_500_000); // 12.000.000 + 7.500.000
const TOTAL_LEDGER_B = rp(12_400_000); // 9.000.000 + 3.400.000
const TOTAL_SUB_A = rp(18_250_000); // A2 turun 1.250.000
const TOTAL_SUB_B = rp(12_000_000); // B1 turun 400.000
const TOTAL_SELISIH = rp(-1_650_000);

describe("tools: rekonsiliasi piutang per akad", () => {
  let d: DuniaTools;
  let a1: AkadFixture;
  let a2: AkadFixture;
  let b1: AkadFixture;
  let b2: AkadFixture;

  beforeAll(async () => {
    d = await buatDuniaTools();
    a1 = await d.buatAkad({ cabangId: d.cabangA.id, pokok: POKOK_A1 });
    await d.cairkan(a1);
    a2 = await d.buatAkad({ cabangId: d.cabangA.id, pokok: POKOK_A2 });
    await d.cairkan(a2);
    b1 = await d.buatAkad({ cabangId: d.cabangB.id, pokok: POKOK_B1 });
    await d.cairkan(b1);
    b2 = await d.buatAkad({ cabangId: d.cabangB.id, pokok: POKOK_B2 });
    await d.cairkan(b2);

    await d.rusakkanRekonsiliasi(a2, DRIFT_A2);
    await d.rusakkanRekonsiliasi(b1, DRIFT_B1);
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("melaporkan selisih PER AKAD, bukan hanya totalnya", async () => {
    const laporan = await d.engine.rekonsiliasiPiutang({}, d.ctx.adminPusat);
    expect(laporan.cocok).toBe(false);
    expect(laporan.jumlahAkadDiperiksa).toBe(4);
    expect(laporan.jumlahAkadSelisih).toBe(2);

    const perAkad = new Map(laporan.baris.map((b) => [b.akadId, b]));
    expect(perAkad.size).toBe(2);

    const barisA2 = perAkad.get(a2.akadId);
    expect(barisA2?.noAkad).toBe(a2.noAkad);
    expect(barisA2?.cabangId).toBe(d.cabangA.id);
    expect(barisA2?.saldoSubLedger).toBe(rp(6_250_000));
    expect(barisA2?.saldoBukuBesar).toBe(POKOK_A2);
    expect(barisA2?.selisih).toBe(DRIFT_A2);

    const barisB1 = perAkad.get(b1.akadId);
    expect(barisB1?.noAkad).toBe(b1.noAkad);
    expect(barisB1?.cabangId).toBe(d.cabangB.id);
    expect(barisB1?.saldoSubLedger).toBe(rp(8_600_000));
    expect(barisB1?.saldoBukuBesar).toBe(POKOK_B1);
    expect(barisB1?.selisih).toBe(DRIFT_B1);

    // The largest difference first: the page is a work list.
    expect(laporan.baris[0]?.akadId).toBe(a2.akadId);
  });

  test("ringkasan per cabang menjumlahkan akad yang cocok maupun yang tidak", async () => {
    const laporan = await d.engine.rekonsiliasiPiutang({}, d.ctx.adminPusat);
    const perCabang = new Map(laporan.perCabang.map((c) => [c.cabangId, c]));
    expect(perCabang.size).toBe(2);

    const a = perCabang.get(d.cabangA.id);
    expect(a?.kodeCabang).toBe(d.cabangA.kode);
    expect(a?.jumlahAkad).toBe(2);
    expect(a?.jumlahAkadSelisih).toBe(1);
    expect(a?.totalSubLedger).toBe(TOTAL_SUB_A);
    expect(a?.totalBukuBesar).toBe(TOTAL_LEDGER_A);
    expect(a?.totalSelisih).toBe(DRIFT_A2);

    const b = perCabang.get(d.cabangB.id);
    expect(b?.jumlahAkad).toBe(2);
    expect(b?.jumlahAkadSelisih).toBe(1);
    expect(b?.totalSubLedger).toBe(TOTAL_SUB_B);
    expect(b?.totalBukuBesar).toBe(TOTAL_LEDGER_B);
    expect(b?.totalSelisih).toBe(DRIFT_B1);

    expect(laporan.totalSubLedger).toBe(rp(30_250_000));
    expect(laporan.totalBukuBesar).toBe(rp(31_900_000));
    expect(laporan.totalSelisih).toBe(TOTAL_SELISIH);
  });

  test("akun piutang dibaca dari event_jurnal_mapping, bukan dari literal", async () => {
    const laporan = await d.engine.rekonsiliasiPiutang({}, d.ctx.adminPusat);
    expect(laporan.akunPiutangId).toBe(d.akunPiutangId);
    expect(laporan.akunPiutangKode).toBe("1.1.03");
  });

  test("hanyaSelisih=false mengembalikan seluruh akad, termasuk yang cocok", async () => {
    const laporan = await d.engine.rekonsiliasiPiutang(
      { hanyaSelisih: false },
      d.ctx.adminPusat,
    );
    expect(laporan.baris).toHaveLength(4);
    const cocok = laporan.baris.filter((b) => b.selisih === "0.00").map((b) => b.akadId);
    expect(cocok.sort()).toEqual([a1.akadId, b2.akadId].sort());
  });

  // --- branch scope (spec 2 rule 3, spec 16 scenario 24) ---------------------

  test("peran terikat cabang hanya melihat akad cabangnya sendiri", async () => {
    const laporan = await d.engine.rekonsiliasiPiutang({}, d.ctx.adminCabangA);
    expect(laporan.jumlahAkadDiperiksa).toBe(2);
    expect(laporan.jumlahAkadSelisih).toBe(1);
    expect(laporan.baris.map((b) => b.akadId)).toEqual([a2.akadId]);
    expect(laporan.perCabang.map((c) => c.cabangId)).toEqual([d.cabangA.id]);
    expect(laporan.totalSelisih).toBe(DRIFT_A2);

    const lain = await d.engine.rekonsiliasiPiutang({}, d.ctx.adminCabangB);
    expect(lain.baris.map((b) => b.akadId)).toEqual([b1.akadId]);
    expect(lain.totalSelisih).toBe(DRIFT_B1);
  });

  test("CHECKER memegang tools.rekonsiliasi dan tetap terikat cabangnya", async () => {
    expect(d.ctx.checker.permissions).toContain("tools.rekonsiliasi");
    const laporan = await d.engine.rekonsiliasiPiutang({}, d.ctx.checker);
    expect(laporan.baris.map((b) => b.akadId)).toEqual([a2.akadId]);
  });

  test("cabang lain di URL DITOLAK, bukan dijawab dengan laporan kosong", async () => {
    const gagal = await d.engine
      .rekonsiliasiPiutang({ cabangId: d.cabangB.id }, d.ctx.adminCabangA)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(gagal).toBeInstanceOf(ToolsError);
    expect((gagal as ToolsError).kode).toBe("CABANG_DILUAR_SCOPE");
  });

  test("peran tanpa tools.rekonsiliasi ditolak", async () => {
    expect(d.ctx.maker.permissions).not.toContain("tools.rekonsiliasi");
    const gagal = await d.engine
      .rekonsiliasiPiutang({}, d.ctx.maker)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(gagal).toBeInstanceOf(ToolsError);
    expect((gagal as ToolsError).kode).toBe("TIDAK_BERWENANG");
  });

  test("tools.integritas TIDAK memberi akses ke rekonsiliasi, dan sebaliknya", async () => {
    // ADMIN_CABANG holds both, so the separation is asserted on the two roles
    // that hold exactly one each: CHECKER (rekonsiliasi) and MAKER (neither).
    expect(d.ctx.checker.permissions).not.toContain("tools.integritas");
    const gagal = await d.engine
      .jalankanIntegritas({}, d.ctx.checker)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(gagal).toBeInstanceOf(ToolsError);
    expect((gagal as ToolsError).kode).toBe("TIDAK_BERWENANG");
  });

  test("tanpa event_jurnal_mapping PENCAIRAN_PUMK, rekonsiliasi MENOLAK", async () => {
    // Refused rather than answered with zeroes: "no difference" because the
    // account could not be found is the worst possible answer, and the one an
    // operator would act on. The row is this world's own, so no other fixture
    // can see the change.
    await d.db.query(
      `update event_jurnal_mapping set aktif = false
        where bumn_id = $1 and event_code = 'PENCAIRAN_PUMK'`,
      [d.bumnId],
    );
    try {
      const gagal = await d.engine
        .rekonsiliasiPiutang({}, d.ctx.adminPusat)
        .then(() => null)
        .catch((err: unknown) => err);
      expect(gagal).toBeInstanceOf(ToolsError);
      expect((gagal as ToolsError).kode).toBe("MAPPING_PIUTANG_TIDAK_ADA");
    } finally {
      await d.db.query(
        `update event_jurnal_mapping set aktif = true
          where bumn_id = $1 and event_code = 'PENCAIRAN_PUMK'`,
        [d.bumnId],
      );
    }
  });
});
