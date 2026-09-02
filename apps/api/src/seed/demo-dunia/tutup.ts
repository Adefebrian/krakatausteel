// The monthly close, run through the closing engine, month after month.
//
// SPEC 13 ASKS FOR "kolektibilitas snapshots and provision journals for EVERY
// closed period", and there is only one honest way to produce them: run the
// same four steps a Approver runs on screen, in order, and let the engine
// refuse if the month is not ready. Nothing here writes `kolektibilitas_
// snapshot`, `penyisihan_periode`, `saldo_akun_periode` or a journal row; all
// four are side effects of the engine calls below.
//
// THE CHECKLIST IS A GATE, NOT A REPORT. `periksaPrasyarat` returns ten checks
// and this refuses to close a month that fails any of them, printing the ones
// that failed. That is spec 13's own acceptance rule applied per month rather
// than only at the end, so a defect surfaces on the month that caused it
// instead of twenty months later as an unexplained imbalance.
import type { DaftarPrasyarat } from "../../modules/closing";
import type { Dunia, PeriodeDemo } from "./dunia";

export interface HasilTutup {
  periodeDitutup: number;
  akadDinilai: number;
  jurnalPenyisihan: number;
  jurnalAkrual: number;
  peringatan: string[];
}

export function hasilTutupBaru(): HasilTutup {
  return {
    periodeDitutup: 0,
    akadDinilai: 0,
    jurnalPenyisihan: 0,
    jurnalAkrual: 0,
    peringatan: [],
  };
}

/**
 * Kolektibilitas, penyisihan and akrual for one period, across every branch.
 * Run for the OPEN month too (without closing it), so the demo lands on a
 * dashboard with current collectibility rather than last month's.
 */
export async function jalankanPipelineClosing(
  dunia: Dunia,
  periode: PeriodeDemo,
  hasil: HasilTutup,
): Promise<void> {
  const ctx = dunia.ctx(dunia.adminPusat);
  dunia.jam.ke(periode.akhir);

  const kol = await dunia.closing.jalankanKolektibilitas({ periodeId: periode.id, cabangId: null }, ctx);
  hasil.akadDinilai += kol.totalAkadDiproses;

  const penyisihan = await dunia.closing.jalankanPenyisihan({ periodeId: periode.id, cabangId: null }, ctx);
  hasil.jurnalPenyisihan += penyisihan.filter((p) => p.jurnalId !== null).length;

  const akrual = await dunia.closing.jalankanAkrualJasaAdm({ periodeId: periode.id, cabangId: null }, ctx);
  hasil.jurnalAkrual += akrual.totalPerCabang.filter((c) => c.jurnalId !== null).length;
}

/** Runs the checklist and closes, or throws with the failing checks named. */
export async function tutupPeriodeDemo(
  dunia: Dunia,
  periode: PeriodeDemo,
  hasil: HasilTutup,
): Promise<DaftarPrasyarat> {
  const ctx = dunia.ctx(dunia.adminPusat);
  dunia.jam.ke(periode.akhir);

  const pra = await dunia.closing.periksaPrasyarat(periode.id, ctx);
  const gagal = pra.hasil.filter((h) => h.status === "GAGAL");
  if (gagal.length > 0) {
    throw new Error(
      `Prasyarat closing ${periode.tahun}-${String(periode.bulan).padStart(2, "0")} GAGAL:\n` +
        gagal.map((g) => `  [${g.nomor}] ${g.kode}: ${g.alasan}`).join("\n"),
    );
  }
  for (const p of pra.hasil.filter((h) => h.status === "PERINGATAN")) {
    hasil.peringatan.push(`${periode.tahun}-${String(periode.bulan).padStart(2, "0")} ${p.kode}: ${p.alasan}`);
  }

  await dunia.closing.tutupPeriode(
    { periodeId: periode.id, konfirmasiKasNegatif: pra.perluKonfirmasi },
    ctx,
  );
  periode.status = "CLOSED";
  hasil.periodeDitutup += 1;
  return pra;
}
