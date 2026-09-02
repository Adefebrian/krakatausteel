// Which rupiah of a receipt's jasa leg CLEARS Piutang Jasa Administrasi and
// which rupiah RECOGNISES income. PURE: BigInt sen in, BigInt sen out, no
// database, no configuration, no event codes.
//
// THE RULE, ONE SENTENCE. A rupiah of jasa clears the receivable exactly when
// that rupiah was already accrued into the receivable, and the schedule row it
// was allocated to is the only place that knows (migrations/0030, column
// `pumk_jadwal_angsuran.jasa_akrual_belum_tertagih`).
//
// WHY THIS IS PER ROW AND NOT PER RECEIPT. A single receipt can legitimately
// need both legs: 300.000 landing on a row carrying 120.000 of accrued jasa
// clears 120.000 of the receivable and recognises 180.000 of income. Deciding
// once for the whole receipt would be right only when the two happen to
// coincide, which is the mistake the old configuration-only rule made.
//
// WHY THE PLACEMENT HELPER LIVES HERE TOO. A reschedule retires a schedule
// version, and a reversal gives an accrual back to a row that may since have
// been retired. Both then have to put an amount of ALREADY-LEDGERED receivable
// somewhere on the active version, oldest row first, bounded by what each row
// still owes. Same arithmetic, same invariant, so one implementation.

/** One schedule row a receipt allocated jasa to, with what it had accrued. */
export interface BarisJasaSetoran {
  jadwalId: string;
  /** Jasa this receipt added to the row. May be zero (a pokok-only row). */
  tambahJasaSen: bigint;
  /** `jasa_akrual_belum_tertagih` as the row stood before this receipt. */
  akrualTersediaSen: bigint;
}

export interface BagianBarisJasa {
  jadwalId: string;
  /** Consumed from the row's accrued balance. Goes to ANGSURAN_JASA_ADM_AKRUAL. */
  pakaiAkrualSen: bigint;
  /** Never accrued, so it is income now. Goes to ANGSURAN_JASA_ADM. */
  langsungSen: bigint;
  /** What the row's accrued balance must be set to after this receipt. */
  sisaAkrualSen: bigint;
}

export interface PembagianJasa {
  /** Total for the ANGSURAN_JASA_ADM_AKRUAL leg. */
  akrualSen: bigint;
  /** Total for the ANGSURAN_JASA_ADM leg. */
  langsungSen: bigint;
  /** One entry per input row, in input order. */
  baris: BagianBarisJasa[];
}

/**
 * Splits a receipt's jasa allocation into the accrued half and the direct
 * half.
 *
 * The per-row consumption is `min(tambahJasa, akrualTersedia)` and nothing
 * cleverer, and that is what keeps the ledger bounded: the receipt can only
 * credit 1.1.04 for jasa the row says is there, and `pumk_jadwal_akrual_ck`
 * refuses a row that claims more accrued than it still owes. A negative
 * Piutang Jasa Administrasi is therefore unreachable rather than merely
 * unlikely.
 */
export function bagiJasaSetoran(baris: readonly BarisJasaSetoran[]): PembagianJasa {
  let akrualSen = 0n;
  let langsungSen = 0n;
  const hasil: BagianBarisJasa[] = [];

  for (const b of baris) {
    const tambah = b.tambahJasaSen > 0n ? b.tambahJasaSen : 0n;
    const tersedia = b.akrualTersediaSen > 0n ? b.akrualTersediaSen : 0n;
    const pakai = tambah < tersedia ? tambah : tersedia;
    const langsung = tambah - pakai;
    akrualSen += pakai;
    langsungSen += langsung;
    hasil.push({
      jadwalId: b.jadwalId,
      pakaiAkrualSen: pakai,
      langsungSen: langsung,
      sisaAkrualSen: tersedia - pakai,
    });
  }

  return { akrualSen, langsungSen, baris: hasil };
}

/** A row that can still hold accrued jasa, and how much of it. */
export interface KapasitasAkrual {
  jadwalId: string;
  /** `jasa_adm - jasa_terbayar - jasa_akrual_belum_tertagih`, never negative. */
  kapasitasSen: bigint;
}

export interface PenempatanAkrual {
  penempatan: Array<{ jadwalId: string; tambahSen: bigint }>;
  /** What did not fit. A caller must REFUSE rather than drop this. */
  sisaSen: bigint;
}

/**
 * Places `jumlahSen` of already-ledgered accrued jasa onto rows, in the order
 * given, filling each up to its capacity.
 *
 * `sisaSen > 0` means the rows cannot hold what the ledger already says is a
 * receivable. That is not a rounding remainder to absorb: it means the
 * operation would recognise less jasa than has already been booked as income,
 * which is a waiver, and spec 6.4 has no event for one. The caller refuses.
 */
export function tempatkanAkrual(
  kapasitas: readonly KapasitasAkrual[],
  jumlahSen: bigint,
): PenempatanAkrual {
  const penempatan: Array<{ jadwalId: string; tambahSen: bigint }> = [];
  let sisa = jumlahSen > 0n ? jumlahSen : 0n;

  for (const k of kapasitas) {
    if (sisa <= 0n) break;
    const muat = k.kapasitasSen > 0n ? k.kapasitasSen : 0n;
    if (muat === 0n) continue;
    const bagian = sisa < muat ? sisa : muat;
    penempatan.push({ jadwalId: k.jadwalId, tambahSen: bagian });
    sisa -= bagian;
  }

  return { penempatan, sisaSen: sisa };
}
