// THE TEST THIS MODULE EXISTS FOR (contract rule 2).
//
// A CLOSED period must be read from `saldo_akun_periode`, an OPEN one from
// `v_ledger_baris`, and the two must produce THE SAME NUMBER for the same
// month. Both halves matter and neither is enough alone:
//
//   - if the values differed, the dashboard would disagree with the statements
//     for a closed month, which is the single most common way this class of
//     system loses the accounting team;
//   - if only the values were asserted, an implementation that read the live
//     ledger for a closed month would PASS, because the two sources agree on
//     well-behaved data. So every assertion below also pins `sumber`, and the
//     "before" figures are captured while the month is genuinely OPEN.
//
// Every figure is an explicit rupiah amount chosen so the arithmetic is
// checkable by hand, and the month is closed by the REAL closing engine, so the
// frozen rows are the rows a production close writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaDashboard,
  rp,
  type DuniaDashboard,
} from "./test-support";
import type { Metrik, RingkasanDashboard } from "./contract";

const KAS_AWAL = rp(100_000_000);
const POKOK_PUMK = rp(30_000_000);
const JASA_PUMK = rp(900_000);
const SALUR_NON_PUMK = rp(7_000_000);
const KEMBALI_NON_PUMK = rp(2_000_000);

// 100.000.000 - 30.000.000 (pencairan) - 7.000.000 (penyaluran) + 2.000.000
const KAS_AKHIR = rp(65_000_000);
// 7.000.000 disalurkan, 2.000.000 dikembalikan setelah LPJ
const NON_PUMK_NETO = rp(5_000_000);
const TERSALUR = rp(35_000_000);

function metrik(r: RingkasanDashboard, kunci: string): Metrik {
  const m = r.metrik.find((x) => x.kunci === kunci);
  if (!m) throw new Error(`metrik ${kunci} tidak ada di ringkasan`);
  return m;
}

describe("dashboard: periode CLOSED dibaca beku, periode OPEN dibaca hidup", () => {
  let d: DuniaDashboard;
  let sebelum: RingkasanDashboard;
  let sesudah: RingkasanDashboard;

  beforeAll(async () => {
    d = await buatDuniaDashboard();
    const p1 = d.periode(1);

    await d.alokasiKas({ cabangId: d.cabangA.id, nilai: KAS_AWAL, bulan: 1 });
    const akad = await d.buatAkad({
      cabangId: d.cabangA.id,
      pokok: POKOK_PUMK,
      jasa: JASA_PUMK,
      bulan: 1,
    });
    await d.cairkan(akad, { bulan: 1 });
    const hibah = await d.salurkanNonPumk({
      cabangId: d.cabangA.id,
      nilai: SALUR_NON_PUMK,
      bulan: 1,
    });
    await d.kembalikanNonPumk(hibah, { nilai: KEMBALI_NON_PUMK, bulan: 1 });

    sebelum = await d.engine.ringkasan({ periodeId: p1.id }, d.ctx.adminPusat);
    await d.tutupPeriode(1);
    sesudah = await d.engine.ringkasan({ periodeId: p1.id }, d.ctx.adminPusat);
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("periode OPEN: setiap angka uang berasal dari v_ledger_baris", () => {
    expect(sebelum.periode.status).toBe("OPEN");
    expect(sebelum.sumberPeriode).toBe("V_LEDGER_BARIS");
    for (const kunci of [
      "DANA_TERSEDIA",
      "PENYALURAN_PUMK",
      "REALISASI_NON_PUMK",
      "DANA_TERSALUR",
    ]) {
      expect(metrik(sebelum, kunci).sumber).toBe("V_LEDGER_BARIS");
    }
  });

  test("periode OPEN: angkanya persis aritmetika fixture", () => {
    expect(metrik(sebelum, "DANA_TERSEDIA").nilai).toBe(KAS_AKHIR);
    expect(metrik(sebelum, "PENYALURAN_PUMK").nilai).toBe(POKOK_PUMK);
    expect(metrik(sebelum, "REALISASI_NON_PUMK").nilai).toBe(NON_PUMK_NETO);
    expect(metrik(sebelum, "DANA_TERSALUR").nilai).toBe(TERSALUR);
  });

  test("periode OPEN tanpa snapshot: outstanding dari SUB_LEDGER, kelas belum ada", () => {
    const outstanding = metrik(sebelum, "OUTSTANDING_PUMK");
    expect(outstanding.nilai).toBe(POKOK_PUMK);
    expect(outstanding.sumber).toBe("SUB_LEDGER");
    expect(metrik(sebelum, "MITRA_AKTIF").nilai).toBe("1");
    // Kolektibilitas is a CLOSING step (spec 8.1). Computing a class here would
    // be this module inventing a definition modules/closing owns, so it is
    // absent WITH A REASON rather than guessed.
    expect(sebelum.alasanKolektibilitasKosong).toBe("KOLEKTIBILITAS_BELUM_DIJALANKAN");
    expect(sebelum.kolektibilitas).toEqual([]);
    expect(metrik(sebelum, "RASIO_KOLEKTIBILITAS_LANCAR").nilai).toBeNull();
    expect(metrik(sebelum, "RASIO_KOLEKTIBILITAS_LANCAR").alasanKosong).toBe(
      "KOLEKTIBILITAS_BELUM_DIJALANKAN",
    );
  });

  test("setelah closing: sumber pindah ke saldo_akun_periode", () => {
    expect(sesudah.periode.status).toBe("CLOSED");
    expect(sesudah.sumberPeriode).toBe("SALDO_AKUN_PERIODE");
    for (const kunci of [
      "DANA_TERSEDIA",
      "PENYALURAN_PUMK",
      "REALISASI_NON_PUMK",
      "DANA_TERSALUR",
    ]) {
      expect(metrik(sesudah, kunci).sumber).toBe("SALDO_AKUN_PERIODE");
    }
  });

  test("setelah closing: angkanya IDENTIK dengan bacaan hidup sebelum closing", () => {
    expect(metrik(sesudah, "DANA_TERSEDIA").nilai).toBe(KAS_AKHIR);
    expect(metrik(sesudah, "PENYALURAN_PUMK").nilai).toBe(POKOK_PUMK);
    expect(metrik(sesudah, "REALISASI_NON_PUMK").nilai).toBe(NON_PUMK_NETO);
    expect(metrik(sesudah, "DANA_TERSALUR").nilai).toBe(TERSALUR);
  });

  test("setelah closing: portofolio dibaca dari kolektibilitas_snapshot", () => {
    const outstanding = metrik(sesudah, "OUTSTANDING_PUMK");
    expect(outstanding.sumber).toBe("KOLEKTIBILITAS_SNAPSHOT");
    expect(outstanding.nilai).toBe(POKOK_PUMK);
    expect(metrik(sesudah, "MITRA_AKTIF").sumber).toBe("KOLEKTIBILITAS_SNAPSHOT");
    expect(metrik(sesudah, "MITRA_AKTIF").nilai).toBe("1");

    // The instalment falls due a month AFTER the akad, so at the end of month 1
    // there are no arrears at all and the whole portfolio is LANCAR.
    const rasio = metrik(sesudah, "RASIO_KOLEKTIBILITAS_LANCAR");
    expect(rasio.sumber).toBe("KOLEKTIBILITAS_SNAPSHOT");
    expect(rasio.nilai).toBe("100.00");

    expect(sesudah.alasanKolektibilitasKosong).toBeNull();
    // EVERY class, including the empty ones: a composition panel that hid them
    // would change shape between months.
    expect(sesudah.kolektibilitas.map((k) => k.kelas)).toEqual([
      "LANCAR",
      "KURANG_LANCAR",
      "DIRAGUKAN",
      "MACET",
    ]);
    const lancar = sesudah.kolektibilitas[0]!;
    expect(lancar.outstandingPokok).toBe(POKOK_PUMK);
    expect(lancar.persen).toBe("100.00");
    expect(lancar.jumlahAkad).toBe(1);
    // `is_bermasalah` is READ from kolektibilitas_kelas (migrations/0004), where
    // KURANG_LANCAR is FALSE. The contract's comment used to claim otherwise.
    expect(sesudah.kolektibilitas.map((k) => k.bermasalah)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test("periode CLOSED tanpa saldo beku: null dengan alasan, BUKAN hitung ulang", async () => {
    const p1 = d.periode(1);
    // `saldo_akun_periode` is derived and fully regenerable, which is why
    // spec 8.4's reopen deletes it outright (modules/closing/repo.ts
    // `hapusSaldoAkunPeriode`). Deleting it here WITHOUT reopening leaves
    // exactly the state this branch exists for: a CLOSED period whose freeze
    // did not happen. No ledger table is touched.
    await d.db.query(`delete from saldo_akun_periode where periode_id = $1`, [p1.id]);
    const r = await d.engine.ringkasan({ periodeId: p1.id }, d.ctx.adminPusat);

    expect(r.sumberPeriode).toBe("SALDO_AKUN_PERIODE");
    for (const kunci of [
      "DANA_TERSEDIA",
      "PENYALURAN_PUMK",
      "REALISASI_NON_PUMK",
      "DANA_TERSALUR",
    ]) {
      const m = metrik(r, kunci);
      // A live recomputation here would look identical today and different
      // after a reopen, so it is refused rather than fallen back to.
      expect(m.nilai).toBeNull();
      expect(m.sumber).toBeNull();
      expect(m.alasanKosong).toBe("SALDO_PERIODE_BELUM_DIBEKUKAN");
      expect(m.rincian).toBeNull();
    }
    // The portfolio has its own frozen artefact and is unaffected: the
    // snapshot is still there, so the figure it answers is still frozen.
    expect(metrik(r, "OUTSTANDING_PUMK").sumber).toBe("KOLEKTIBILITAS_SNAPSHOT");
  });
});
