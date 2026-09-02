// BRANCH SCOPE (spec 2 rule 3, spec 16 scenario 24).
//
// `cabangId` on the filter is a FILTER, never authority. It can only narrow,
// and a branch outside the session's set is REFUSED rather than answered with
// an empty page: an empty dashboard reads as "that branch did nothing", which
// is a wrong answer presented as a right one and exactly the answer somebody
// would act on.
//
// The two branches carry DIFFERENT, non-round amounts on purpose. With equal
// figures an implementation that ignored the scope entirely (or applied it to
// the wrong side of a join) would still produce a plausible number; here every
// wrong scoping produces a number that is in none of the tables.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaDashboard, rp, type DuniaDashboard } from "./test-support";
import { DashboardError } from "./contract";
import type { Metrik, RingkasanDashboard } from "./contract";

const PUMK_A = rp(11_000_000);
const PUMK_B = rp(4_000_000);
const PUMK_TOTAL = rp(15_000_000);
const NON_PUMK_B = rp(3_000_000);

function metrik(r: RingkasanDashboard, kunci: string): Metrik {
  const m = r.metrik.find((x) => x.kunci === kunci);
  if (!m) throw new Error(`metrik ${kunci} tidak ada di ringkasan`);
  return m;
}

describe("dashboard: cakupan cabang", () => {
  let d: DuniaDashboard;

  beforeAll(async () => {
    d = await buatDuniaDashboard();
    await d.alokasiKas({ cabangId: d.cabangA.id, nilai: rp(50_000_000), bulan: 2 });
    await d.alokasiKas({ cabangId: d.cabangB.id, nilai: rp(20_000_000), bulan: 2 });

    const a = await d.buatAkad({ cabangId: d.cabangA.id, pokok: PUMK_A, bulan: 2 });
    await d.cairkan(a, { bulan: 2 });
    const b = await d.buatAkad({ cabangId: d.cabangB.id, pokok: PUMK_B, bulan: 2 });
    await d.cairkan(b, { bulan: 2 });
    await d.salurkanNonPumk({ cabangId: d.cabangB.id, nilai: NON_PUMK_B, bulan: 2 });
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("ADMIN_PUSAT tanpa filter: kedua cabang, totalnya gabungan", async () => {
    const r = await d.engine.ringkasan(
      { periodeId: d.periode(2).id },
      d.ctx.adminPusat,
    );
    expect(r.cabangId).toBeNull();
    expect(r.cabangDilaporkan.map((c) => c.id).sort()).toEqual(
      [d.cabangA.id, d.cabangB.id].sort(),
    );
    expect(metrik(r, "PENYALURAN_PUMK").nilai).toBe(PUMK_TOTAL);
    expect(metrik(r, "REALISASI_NON_PUMK").nilai).toBe(NON_PUMK_B);
    expect(metrik(r, "OUTSTANDING_PUMK").nilai).toBe(PUMK_TOTAL);
    expect(metrik(r, "MITRA_AKTIF").nilai).toBe("2");
  });

  test("ADMIN_PUSAT dengan filter cabang B: hanya cabang B", async () => {
    const r = await d.engine.ringkasan(
      { periodeId: d.periode(2).id, cabangId: d.cabangB.id },
      d.ctx.adminPusat,
    );
    expect(r.cabangId).toBe(d.cabangB.id);
    expect(r.cabangDilaporkan.map((c) => c.id)).toEqual([d.cabangB.id]);
    expect(metrik(r, "PENYALURAN_PUMK").nilai).toBe(PUMK_B);
    expect(metrik(r, "REALISASI_NON_PUMK").nilai).toBe(NON_PUMK_B);
    expect(metrik(r, "MITRA_AKTIF").nilai).toBe("1");
  });

  test("ADMIN_CABANG A tanpa filter: cabangnya sendiri saja", async () => {
    const r = await d.engine.ringkasan(
      { periodeId: d.periode(2).id },
      d.ctx.adminCabangA,
    );
    // No filter was sent, and the answer is STILL one branch: the scope came
    // from the session, which is the whole point.
    expect(r.cabangId).toBeNull();
    expect(r.cabangDilaporkan.map((c) => c.id)).toEqual([d.cabangA.id]);
    expect(metrik(r, "PENYALURAN_PUMK").nilai).toBe(PUMK_A);
    // Branch B's Non PUMK grant is not branch A's realisation.
    expect(metrik(r, "REALISASI_NON_PUMK").nilai).toBe("0.00");
    expect(metrik(r, "OUTSTANDING_PUMK").nilai).toBe(PUMK_A);
  });

  test("ADMIN_CABANG B meminta cabang A: DITOLAK, bukan halaman kosong", async () => {
    const janji = d.engine.ringkasan(
      { periodeId: d.periode(2).id, cabangId: d.cabangA.id },
      d.ctx.adminCabangB,
    );
    await expect(janji).rejects.toBeInstanceOf(DashboardError);
    await janji.catch((err: unknown) => {
      expect((err as DashboardError).kode).toBe("CABANG_DILUAR_SCOPE");
    });
  });

  test("rincian mewarisi cakupan yang sama, bukan cakupan sendiri", async () => {
    const r = await d.engine.rincian(
      "metrik:PENYALURAN_PUMK",
      { periodeId: d.periode(2).id },
      d.ctx.adminCabangA,
    );
    expect(r.total).toBe(PUMK_A);
    expect(r.baris.length).toBeGreaterThan(0);
    // Every underlying row is branch A's. A drill-down that widened the scope
    // would be a scope bypass with a table attached.
    for (const baris of r.baris) {
      expect(baris.cabangId).toBe(d.cabangA.id);
    }
    const jumlahBaris = r.baris.reduce(
      (akumulasi, b) => akumulasi + BigInt((b.nilai ?? "0.00").replace(".", "")),
      0n,
    );
    expect(jumlahBaris).toBe(BigInt(PUMK_A.replace(".", "")));
  });

  test("rincian juga menolak cabang di luar scope", async () => {
    const janji = d.engine.rincian(
      "metrik:PENYALURAN_PUMK",
      { periodeId: d.periode(2).id, cabangId: d.cabangA.id },
      d.ctx.adminCabangB,
    );
    await expect(janji).rejects.toBeInstanceOf(DashboardError);
  });

  test("cabang yang bukan milik entitas ini: CABANG_TIDAK_DITEMUKAN", async () => {
    // In scope as far as the SESSION is concerned (it is spliced into
    // `cabangDalamScope`), but not a row of this bumn. The engine checks both,
    // because a session is not a proof that the branch exists here.
    const asing = crypto.randomUUID();
    const janji = d.engine.ringkasan(
      { periodeId: d.periode(2).id, cabangId: asing },
      {
        ...d.ctx.adminPusat,
        cabangDalamScope: [d.cabangA.id, d.cabangB.id, asing],
      },
    );
    await janji.catch((err: unknown) => {
      expect((err as DashboardError).kode).toBe("CABANG_TIDAK_DITEMUKAN");
    });
    await expect(janji).rejects.toBeInstanceOf(DashboardError);
  });
});
