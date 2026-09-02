// apps/api/src/modules/laporan/tanggal.ts
//
// EVERY DATE CALCULATION THIS MODULE MAKES, IN ONE PLACE AND IN UTC.
//
// Split out of ./service.ts when the operational reports (spec 10.1, 10.2 and
// 10.4) arrived, because they need exactly the same four things the accounting
// statements need -- the first day of a financial year, one year earlier, a
// day offset, a printed label -- and a second copy of `awalTahunBuku` is a
// second answer to "where does the financial year start", which is the one
// question spec 5.6 exists to make configurable.
//
// UTC THROUGHOUT, DELIBERATELY. `new Date("2026-03-01")` is midnight UTC and
// `d.getDate()` is local; on any machine west of Greenwich that pair silently
// moves a period boundary by one day, which moves a figure between two months
// and balances perfectly in both.

export interface BagianTanggal {
  tahun: number;
  bulan: number;
  hari: number;
}

/** `YYYY-MM-DD`. */
export type TanggalIso = string;

export const NAMA_BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
] as const;

export function pecahTanggal(iso: string): BagianTanggal {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  return { tahun: t, bulan: b, hari: h };
}

export function rakitTanggal(tahun: number, bulan: number, hari: number): TanggalIso {
  return `${String(tahun).padStart(4, "0")}-${String(bulan).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;
}

export function tambahHari(iso: string, hari: number): TanggalIso {
  const { tahun, bulan, hari: h } = pecahTanggal(iso);
  const d = new Date(Date.UTC(tahun, bulan - 1, h));
  d.setUTCDate(d.getUTCDate() + hari);
  return d.toISOString().slice(0, 10);
}

export function hariDalamBulan(tahun: number, bulan: number): number {
  return new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
}

/**
 * Whole days from `dari` to `sampai`, signed. Positive means `sampai` is
 * later. Used by report 5's "hari sampai jatuh tempo" and report 15's "umur",
 * both of which are read by a human as a count of days and neither of which
 * may drift with a timezone.
 */
export function selisihHari(dari: string, sampai: string): number {
  const a = pecahTanggal(dari);
  const b = pecahTanggal(sampai);
  const ms =
    Date.UTC(b.tahun, b.bulan - 1, b.hari) - Date.UTC(a.tahun, a.bulan - 1, a.hari);
  return Math.round(ms / 86_400_000);
}

/** One year earlier, clamped (29 February becomes 28 February). */
export function mundurSetahun(iso: string): TanggalIso {
  const { tahun, bulan, hari } = pecahTanggal(iso);
  return rakitTanggal(tahun - 1, bulan, Math.min(hari, hariDalamBulan(tahun - 1, bulan)));
}

/**
 * First day of the financial year containing `sampai`, given the month the
 * financial year starts in. NEVER assumes January: a hardcoded month 1 prints
 * the wrong comparative for any client on a non-calendar year and nothing
 * downstream detects it (spec 5.6, `akuntansi.tahun_buku_mulai_bulan`).
 */
export function awalTahunBuku(sampai: string, bulanMulai: number): TanggalIso {
  const { tahun, bulan } = pecahTanggal(sampai);
  return rakitTanggal(bulan >= bulanMulai ? tahun : tahun - 1, bulanMulai, 1);
}

export function labelTanggal(iso: string): string {
  const { tahun, bulan, hari } = pecahTanggal(iso);
  return `${hari} ${NAMA_BULAN[bulan - 1]} ${tahun}`;
}

export function labelRentang(dari: string, sampai: string): string {
  const a = pecahTanggal(dari);
  const b = pecahTanggal(sampai);
  if (a.tahun === b.tahun) {
    return a.bulan === b.bulan
      ? `${NAMA_BULAN[a.bulan - 1]} ${a.tahun}`
      : `${NAMA_BULAN[a.bulan - 1]} - ${NAMA_BULAN[b.bulan - 1]} ${b.tahun}`;
  }
  return `${NAMA_BULAN[a.bulan - 1]} ${a.tahun} - ${NAMA_BULAN[b.bulan - 1]} ${b.tahun}`;
}
