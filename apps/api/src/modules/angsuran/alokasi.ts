// The allocation waterfall (spec 7.2 steps 1 to 5). PURE: BigInt sen in,
// BigInt sen out, no database and no ordering knowledge of its own.
//
// THE ORDER IS DATA, NOT CODE. `urutan` is the `komponen` column of
// `alokasi_setoran_preset` in its `urutan`, read by the caller from the preset
// named by `angsuran.urutan_alokasi_setoran_preset` (spec 5.4). This function
// walks whatever list it is handed and has no built-in fallback: if the
// waterfall were hardcoded here, the DEFAULT and POKOK_DULU tests could not
// both pass, which is exactly the property that proves the order is
// configuration.
//
// A COMPONENT IS EXHAUSTED ACROSS EVERY ROW BEFORE THE NEXT ONE STARTS.
// TUNGGAKAN_JASA means "the jasa of every arrears row", not "the jasa of the
// oldest arrears row": spec 7.2 step 2 splits the rows into arrears and
// not-yet-due first, and step 3 then allocates by component. A 60.000 deposit
// against two arrears rows of 30.000 jasa each therefore clears both rows'
// jasa and touches neither row's pokok.
import type { KomponenAlokasi, StatusBarisJadwal } from "./contract";

/** One unpaid schedule row of the active version, in sen. */
export interface BarisTerbuka {
  jadwalId: string;
  angsuranKe: number;
  /** ISO date, compared against the deposit date to find the arrears. */
  tanggalJatuhTempo: string;
  status: StatusBarisJadwal;
  pokokSen: bigint;
  jasaSen: bigint;
  pokokTerbayarSen: bigint;
  jasaTerbayarSen: bigint;
}

export interface AlokasiBaris {
  jadwalId: string;
  angsuranKe: number;
  /** What this deposit added, which is what the receipt's rincian reports. */
  tambahPokokSen: bigint;
  tambahJasaSen: bigint;
  /** Cumulative totals after this deposit, which is what the row stores. */
  pokokTerbayarSen: bigint;
  jasaTerbayarSen: bigint;
  statusSetelah: StatusBarisJadwal;
  lunas: boolean;
}

export interface HasilKernelAlokasi {
  pokokSen: bigint;
  jasaSen: bigint;
  kelebihanSen: bigint;
  /** Only the rows this deposit actually moved, in schedule order. */
  baris: AlokasiBaris[];
}

/**
 * Walks the waterfall. `jumlahSen` must be positive and the rows must already
 * be sorted by due date then instalment number; both are the caller's job.
 */
export function alokasikan(
  baris: readonly BarisTerbuka[],
  urutan: readonly KomponenAlokasi[],
  jumlahSen: bigint,
  tanggal: string,
): HasilKernelAlokasi {
  const kerja = baris.map((b) => ({
    sumber: b,
    pokok: b.pokokTerbayarSen,
    jasa: b.jasaTerbayarSen,
    tambahPokok: 0n,
    tambahJasa: 0n,
  }));

  let sisa = jumlahSen;
  let totalPokok = 0n;
  let totalJasa = 0n;

  const tunggakan = (b: BarisTerbuka): boolean => b.tanggalJatuhTempo <= tanggal;

  for (const komponen of urutan) {
    if (komponen === "KELEBIHAN" || sisa <= 0n) continue;
    for (const k of kerja) {
      if (sisa <= 0n) break;
      const arrear = tunggakan(k.sumber);
      const cocok =
        (komponen === "TUNGGAKAN_JASA" && arrear) ||
        (komponen === "TUNGGAKAN_POKOK" && arrear) ||
        (komponen === "JASA_BERJALAN" && !arrear) ||
        (komponen === "POKOK_BERJALAN" && !arrear);
      if (!cocok) continue;

      const kePokok = komponen === "TUNGGAKAN_POKOK" || komponen === "POKOK_BERJALAN";
      const sisaKewajiban = kePokok
        ? k.sumber.pokokSen - k.pokok
        : k.sumber.jasaSen - k.jasa;
      if (sisaKewajiban <= 0n) continue;

      const bagian = sisa < sisaKewajiban ? sisa : sisaKewajiban;
      if (kePokok) {
        k.pokok += bagian;
        k.tambahPokok += bagian;
        totalPokok += bagian;
      } else {
        k.jasa += bagian;
        k.tambahJasa += bagian;
        totalJasa += bagian;
      }
      sisa -= bagian;
    }
  }

  // Step 5: whatever is left after every obligation of the active version has
  // been met. Invariant 10: it becomes a Kelebihan Pembayaran, never a
  // negative receivable.
  const kelebihan = sisa;

  const hasilBaris: AlokasiBaris[] = [];
  for (const k of kerja) {
    if (k.tambahPokok === 0n && k.tambahJasa === 0n) continue;
    const lunas = k.pokok >= k.sumber.pokokSen && k.jasa >= k.sumber.jasaSen;
    hasilBaris.push({
      jadwalId: k.sumber.jadwalId,
      angsuranKe: k.sumber.angsuranKe,
      tambahPokokSen: k.tambahPokok,
      tambahJasaSen: k.tambahJasa,
      pokokTerbayarSen: k.pokok,
      jasaTerbayarSen: k.jasa,
      statusSetelah: lunas ? "LUNAS" : "SEBAGIAN",
      lunas,
    });
  }

  return { pokokSen: totalPokok, jasaSen: totalJasa, kelebihanSen: kelebihan, baris: hasilBaris };
}
