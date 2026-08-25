// SPEC 9.2's LATE-LPJ MONITORING, WITH AGEING AT 30, 60 AND 90 DAYS.
//
//   "Dashboard monitoring LPJ yang TERLAMBAT, dengan AGING (30, 60, 90 hari
//    SEJAK PENYALURAN)."
//
// WHY EVERY BUCKET IS ASSERTED AT ITS BOUNDARY.
// An off-by-one in an ageing bucket is invisible in every screenshot and wrong
// in every management report: a grant that is exactly 30 days old sits in the
// "under 30" column, the "30 to 59" column looks one row light, and nobody can
// tell by looking. So each threshold is tested with the two days that straddle
// it (29/30, 59/60, 89/90), never with a day in the middle of a bucket.
// The contract states the rule the tests encode: the boundaries are HALF-OPEN
// ON THE LEFT, so exactly 30 days old is UMUR_30_59.
//
// WHY THE CLOCK IS INJECTED.
// `NonPumkEngineDeps.jam` is the only thing that makes any of this
// deterministic. A module that called `new Date()` would produce a suite whose
// buckets change at midnight and whose failures cannot be reproduced, which is
// the exact class of flake this repo's fixtures exist to prevent.
//
// WHY THE DEADLINE IS READ AND THE BUCKETS ARE NOT.
// The three thresholds are the SPEC's, so they are a constant
// (`AMBANG_UMUR_LPJ`). The number of days after which an LPJ is LATE is a
// policy nobody has decided (TEMUAN 3: migrations/0004 ships no Non PUMK
// parameter at all), so it is read from `konfigurasi` and the tests assert the
// MECHANIC: change the row, the late set changes. No test here claims 60 days
// is the right answer.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createNonPumkEngine,
  KODE_NONPUMK,
  KUNCI_KONFIGURASI_NONPUMK,
  type EmberUmurLpj,
  type NonPumkEngine,
} from "./contract";
import {
  buatDunia,
  porterJurnalUji,
  rp,
  selisihHari,
  tambahHari,
  tolakDengan,
  HARI_INI_BAKU,
  type DuniaNonPumk,
  type PorterJurnalUji,
  type ProposalFixture,
} from "./test-support";

let d: DuniaNonPumk;
let engine: NonPumkEngine;
let jurnal: PorterJurnalUji;

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  engine = createNonPumkEngine({ db: d.db, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** A grant whose LAST disbursement was exactly `umur` days before the clock. */
function berumur(
  umur: number,
  opsi: Parameters<DuniaNonPumk["siapkanProposal"]>[1] = {},
): Promise<ProposalFixture> {
  return d.siapkanProposal("MENUNGGU_LPJ", {
    ...opsi,
    tanggalPenyaluran: tambahHari(HARI_INI_BAKU, -umur),
  });
}

/** The monitoring row for one proposal, or undefined when it is not listed. */
async function baris(proposalId: string, ctx = d.ctx.maker) {
  const semua = await engine.monitoringLpj({}, ctx);
  return semua.find((m) => m.proposalId === proposalId);
}

// ---------------------------------------------------------------------------
// The three thresholds, at their boundaries
// ---------------------------------------------------------------------------

describe("aging 30, 60, 90 hari sejak penyaluran (spec 9.2)", () => {
  test("setiap ambang diuji dengan dua hari yang mengapitnya", async () => {
    // 0..29, 30..59, 60..89, 90+. Six proposals, three boundaries, and the pair
    // straddling each one, so a `>` written as `>=` (or the reverse) fails here
    // and nowhere else.
    const kasus: Array<[number, EmberUmurLpj]> = [
      [29, "UMUR_0_29"],
      [30, "UMUR_30_59"],
      [59, "UMUR_30_59"],
      [60, "UMUR_60_89"],
      [89, "UMUR_60_89"],
      [90, "UMUR_90_PLUS"],
    ];
    for (const [umur, ember] of kasus) {
      const f = await berumur(umur);
      const m = await baris(f.proposalId);
      expect(`${umur}:${m?.ember}`).toBe(`${umur}:${ember}`);
      // The age itself, so a correct bucket computed from a wrong number of days
      // still fails.
      expect(`${umur}:${m?.umurHari}`).toBe(`${umur}:${umur}`);
    }
  }, 120_000);

  test("umur dihitung dari penyaluran TERAKHIR, bukan dari yang pertama", async () => {
    // With staged disbursement there are several dates to choose from, and the
    // choice is not cosmetic: measuring from the first termin would make a grant
    // whose final instalment left yesterday look ninety days overdue.
    const f = await d.siapkanProposal("MENUNGGU_LPJ", {
      tanggalPenyaluran: tambahHari(HARI_INI_BAKU, -100),
      // The fixture spaces later termin one day apart, so the last one is at
      // -98 days.
      terminPenyaluran: [rp(10_000_000), rp(10_000_000), rp(10_000_000)],
    });
    const m = await baris(f.proposalId);
    expect(m?.tanggalPenyaluranTerakhir).toBe(tambahHari(HARI_INI_BAKU, -98));
    expect(m?.umurHari).toBe(98);
    expect(m?.ember).toBe("UMUR_90_PLUS");
  }, 30_000);

  test("umur dihitung terhadap jam yang disuntikkan, bukan jam dinding", async () => {
    // Without this, the whole file is a suite that changes answer at midnight.
    const f = await berumur(45);
    const m = await baris(f.proposalId);
    expect(m?.umurHari).toBe(selisihHari(m?.tanggalPenyaluranTerakhir as string, HARI_INI_BAKU));
    expect(d.jam().toISOString().slice(0, 10)).toBe(HARI_INI_BAKU);
  }, 30_000);

  test("hibah yang baru disalurkan hari ini berumur nol, bukan hilang dari daftar", async () => {
    // The permissive edge of the first bucket. A monitoring page that only lists
    // overdue grants cannot be used to see whether anything is APPROACHING its
    // deadline, which is the only moment intervention is still cheap.
    const f = await berumur(0);
    const m = await baris(f.proposalId);
    expect(m?.umurHari).toBe(0);
    expect(m?.ember).toBe("UMUR_0_29");
    expect(m?.terlambat).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Who is on the list
// ---------------------------------------------------------------------------

describe("populasi monitoring", () => {
  test("mencakup DISALURKAN, MENUNGGU_LPJ dan LPJ_DITOLAK", async () => {
    // Money is out and no accepted LPJ exists. LPJ_DITOLAK belongs here
    // precisely because a rejected report is not a report: the clock never
    // stopped, and dropping it off the list is how a rejected LPJ is quietly
    // forgotten.
    const salur = await d.siapkanProposal("DISALURKAN", {
      tanggalPenyaluran: tambahHari(HARI_INI_BAKU, -70),
      terminPenyaluran: [rp(10_000_000)],
    });
    const menunggu = await berumur(70);
    const ditolak = await d.siapkanProposal("LPJ_DITOLAK", {
      tanggalPenyaluran: tambahHari(HARI_INI_BAKU, -70),
      jumlahRealisasi: rp(20_000_000),
    });

    const ids = (await engine.monitoringLpj({}, d.ctx.maker)).map((m) => m.proposalId);
    expect(ids).toContain(salur.proposalId);
    expect(ids).toContain(menunggu.proposalId);
    expect(ids).toContain(ditolak.proposalId);
  }, 60_000);

  test("tidak mencakup LPJ_DIAJUKAN dan SELESAI", async () => {
    // At LPJ_DIAJUKAN the recipient has done their part and the ball is with the
    // verifier, so listing it as a late RECIPIENT is a false accusation. SELESAI
    // is finished.
    const diajukan = await d.siapkanProposal("LPJ_DIAJUKAN", {
      tanggalPenyaluran: tambahHari(HARI_INI_BAKU, -120),
    });
    const selesai = await d.siapkanProposal("SELESAI", {
      tanggalPenyaluran: tambahHari(HARI_INI_BAKU, -120),
    });
    const ids = (await engine.monitoringLpj({}, d.ctx.maker)).map((m) => m.proposalId);
    expect(ids).not.toContain(diajukan.proposalId);
    expect(ids).not.toContain(selesai.proposalId);
  }, 60_000);

  test("tidak mencakup proposal yang belum menyalurkan apa apa", async () => {
    // Nothing has left the account, so there is nothing to account for and no
    // date to count from. Including it would put a row on the page with a null
    // age, which is how a monitoring list stops being trusted.
    const setuju = await d.siapkanProposal("DISETUJUI");
    const draft = await d.siapkanProposal("DRAFT");
    const ids = (await engine.monitoringLpj({}, d.ctx.maker)).map((m) => m.proposalId);
    expect(ids).not.toContain(setuju.proposalId);
    expect(ids).not.toContain(draft.proposalId);
  }, 30_000);

  test("baris membawa apa yang dibutuhkan halaman untuk ditindaklanjuti", async () => {
    // A monitoring row whose only content is an id forces the page into N+1
    // lookups, and a page that is expensive to open is a page nobody opens.
    const f = await berumur(65, { bidang: d.bidangLain, terminPenyaluran: [rp(12_000_000)] });
    const m = await baris(f.proposalId);
    expect(m?.noProposal).toBe(f.noProposal);
    expect(m?.cabangId).toBe(d.cabangId);
    expect(m?.bidangId).toBe(d.bidangLain.id);
    expect(m?.namaPemohon.length).toBeGreaterThan(0);
    expect(m?.judulProgram.length).toBeGreaterThan(0);
    expect(m?.status).toBe("MENUNGGU_LPJ");
    expect(m?.totalDisalurkan).toBe(rp(12_000_000));
  }, 30_000);

  test("urut dari yang paling tua, karena itulah yang harus ditangani dulu", async () => {
    const muda = await berumur(31);
    const tua = await berumur(120);
    const sedang = await berumur(75);

    const semua = await engine.monitoringLpj({}, d.ctx.maker);
    const posisi = (id: string) => semua.findIndex((m) => m.proposalId === id);
    expect(posisi(tua.proposalId)).toBeLessThan(posisi(sedang.proposalId));
    expect(posisi(sedang.proposalId)).toBeLessThan(posisi(muda.proposalId));
    // And the ordering really is by age, not by insertion.
    for (let i = 1; i < semua.length; i += 1) {
      expect(semua[i - 1].umurHari).toBeGreaterThanOrEqual(semua[i].umurHari);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// "Terlambat", which is policy and therefore configuration
// ---------------------------------------------------------------------------

describe("batas keterlambatan dibaca dari konfigurasi (TEMUAN 3)", () => {
  test("terlambat mengikuti baris konfigurasi, dan ambang aging tidak ikut berubah", async () => {
    // The mechanic, asserted twice over on the SAME proposal: nothing about the
    // grant changed, only the policy row, and the answer changed with it. And
    // the 30/60/90 buckets did NOT move, because those are the spec's and not
    // the client's.
    const f = await berumur(65);
    const ketat = await d.denganKonfigurasi("batasan", "batas_hari_lpj_non_pumk", "60", () =>
      baris(f.proposalId),
    );
    expect(ketat?.terlambat).toBe(true);
    expect(ketat?.ember).toBe("UMUR_60_89");

    const longgar = await d.denganKonfigurasi("batasan", "batas_hari_lpj_non_pumk", "90", () =>
      baris(f.proposalId),
    );
    expect(longgar?.terlambat).toBe(false);
    // Same bucket, different verdict. That is the whole distinction.
    expect(longgar?.ember).toBe("UMUR_60_89");
    expect(longgar?.umurHari).toBe(65);
  }, 60_000);

  test("terlambat diuji PERSIS di batasnya: hari ke-60 belum terlambat, hari ke-61 sudah", async () => {
    // "Due within 60 days" means day 60 is still inside the deadline. Off by
    // one here turns every on-time grant on its last day into a breach in the
    // report that goes to management.
    const tepat = await berumur(60);
    const lewat = await berumur(61);
    await d.denganKonfigurasi("batasan", "batas_hari_lpj_non_pumk", "60", async () => {
      expect((await baris(tepat.proposalId))?.terlambat).toBe(false);
      expect((await baris(lewat.proposalId))?.terlambat).toBe(true);
    });
  }, 60_000);

  test("konfigurasi batas yang hilang ditolak dengan KONFIGURASI_TIDAK_ADA", async () => {
    // TEMUAN 3 again, and this is the state a fresh installation is in. A
    // monitoring page that silently defaulted to some number would report every
    // grant as on time, or every grant as late, and either way would look like
    // a working page.
    const err = await d.tanpaKonfigurasi(
      KUNCI_KONFIGURASI_NONPUMK.BATAS_HARI_LPJ.grup,
      KUNCI_KONFIGURASI_NONPUMK.BATAS_HARI_LPJ.kunci,
      () => tolakDengan(() => engine.monitoringLpj({}, d.ctx.maker), KODE_NONPUMK.KONFIGURASI_TIDAK_ADA),
    );
    expect(err.message).toContain(KUNCI_KONFIGURASI_NONPUMK.BATAS_HARI_LPJ.kunci);
  }, 30_000);

  test("konfigurasi batas yang tidak bisa diurai ditolak, bukan jadi NaN", async () => {
    // A deadline that parses to NaN makes every comparison false, so nothing is
    // ever late and the page looks perfect. Fail closed.
    await d.denganKonfigurasi("batasan", "batas_hari_lpj_non_pumk", "dua bulan", () =>
      tolakDengan(() => engine.monitoringLpj({}, d.ctx.maker), KODE_NONPUMK.KONFIGURASI_TIDAK_VALID),
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("filter monitoring", () => {
  test("hanyaTerlambat menyaring, dan tetap menghormati batas dari konfigurasi", async () => {
    const aman = await berumur(20);
    const telat = await berumur(95);

    const hasil = await d.denganKonfigurasi("batasan", "batas_hari_lpj_non_pumk", "60", () =>
      engine.monitoringLpj({ hanyaTerlambat: true }, d.ctx.maker),
    );
    const ids = hasil.map((m) => m.proposalId);
    expect(ids).toContain(telat.proposalId);
    expect(ids).not.toContain(aman.proposalId);
    for (const m of hasil) expect(m.terlambat).toBe(true);
  }, 60_000);

  test("emberMinimal menyaring dari sebuah ambang ke atas, inklusif", async () => {
    // "Show me everything 60 days and older" is the question the page is opened
    // with, and it has to include the 60-to-89 bucket itself, not just the one
    // beyond it.
    const muda = await berumur(35);
    const enam = await berumur(65);
    const sembilan = await berumur(95);

    const hasil = await engine.monitoringLpj({ emberMinimal: "UMUR_60_89" }, d.ctx.maker);
    const ids = hasil.map((m) => m.proposalId);
    expect(ids).toContain(enam.proposalId);
    expect(ids).toContain(sembilan.proposalId);
    expect(ids).not.toContain(muda.proposalId);
  }, 60_000);

  test("filter bidang menyaring, karena tiap bidang punya pengelola sendiri", async () => {
    const a = await berumur(70, { bidang: d.bidang });
    const b = await berumur(70, { bidang: d.bidangLain });
    const hasil = await engine.monitoringLpj({ bidangId: d.bidangLain.id }, d.ctx.maker);
    const ids = hasil.map((m) => m.proposalId);
    expect(ids).toContain(b.proposalId);
    expect(ids).not.toContain(a.proposalId);
    for (const m of hasil) expect(m.bidangId).toBe(d.bidangLain.id);
  }, 60_000);

  test("membaca monitoring butuh nonpumk.view dan tidak mengubah apa pun", async () => {
    // The page is a read, and the Auditor must be able to open it (scenario 23's
    // positive half). It also posts nothing: a monitoring query that touched the
    // ledger would be a monitoring query that changes what it measures.
    const f = await berumur(70);
    const hasil = await engine.monitoringLpj({}, d.ctx.auditor);
    expect(hasil.map((m) => m.proposalId)).toContain(f.proposalId);
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
  }, 30_000);
});
