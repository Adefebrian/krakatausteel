// Money for the RKA engine. BigInt minor units (sen) internally, a decimal
// string with exactly two fractional digits at every boundary, never a JS
// float (spec invariant 7).
//
// RE-DECLARED RATHER THAN IMPORTED, for the reason the sibling copies in
// modules/closing, modules/angsuran and modules/nonpumk record:
// `bun tools/check-boundaries.ts` forbids reaching past a sibling module's
// index and these helpers are internal to each. The semantics must not drift;
// when a shared money package appears, all of them collapse into it.
//
// SIGNED THROUGHOUT. `selisih` is `anggaran - realisasi` and a budget overrun
// is a real, common, negative number; `saldo_akun_periode` is debit-positive,
// so a credit-balance account carries a negative figure there. A helper that
// refused a minus sign would push the engine into carrying signs beside its
// amounts, which is how a sign gets lost.
import { POLA_UANG, type Persen, type Uang } from "./contract";

const POLA_SEN = /^(-?)(\d+)\.(\d{2})$/;

/** Minor units -> `Uang`. `sen(-150n)` === "-1.50". */
export function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** `Uang` -> minor units. Throws on anything that is not exactly two decimals. */
export function keSen(nilai: string): bigint {
  const m = POLA_SEN.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2]) * 100n + BigInt(m[3]);
  return m[1] === "-" ? -besar : besar;
}

/** True when the string is a well-formed two-decimal money value. */
export function bentukUangValid(nilai: unknown): nilai is Uang {
  return typeof nilai === "string" && POLA_UANG.test(nilai);
}

/**
 * Normalises what Postgres handed back.
 *
 * `coalesce(sum(x), 0)` comes back as '0', not '0.00', and report 24 is mostly
 * zeroes: a budget line with no realisation yet is the normal case, so the
 * un-cast path is hit on the very first run. Catching it HERE, at the boundary,
 * beats failing an equality assertion three layers away with no clue where the
 * bare '0' came from. Every query in ./repo.ts casts `::numeric(20,2)` BEFORE
 * `::text`; this is the second line of defence.
 */
export function uangDariDb(nilai: string | null | undefined): Uang {
  if (nilai === null || nilai === undefined) return "0.00";
  if (!POLA_UANG.test(nilai)) {
    throw new Error(
      `modules/rka: nilai uang dari database bukan numeric(20,2)::text: ${JSON.stringify(nilai)}. ` +
        "Cast ke ::numeric(20,2) SEBELUM ::text (lihat catatan driver di modules/jurnal/repo.ts).",
    );
  }
  return nilai;
}

export function tambah(...nilai: string[]): Uang {
  return sen(nilai.reduce((acc, n) => acc + keSen(n), 0n));
}

export function kurang(a: string, b: string): Uang {
  return sen(keSen(a) - keSen(b));
}

export function negasi(a: string): Uang {
  return sen(-keSen(a));
}

/**
 * `realisasi / anggaran * 100`, two decimals, rounded HALF UP away from zero.
 *
 * NULL when `anggaran` is zero, deliberately. Realisation against a zero budget
 * is not "0 percent" and it is not infinity; it is money spent without being
 * budgeted, and the report says so by leaving the column empty rather than
 * printing a number that reads as compliance.
 *
 * Done entirely in BigInt: a float here would turn a percentage a manager acts
 * on into a value that differs in the last decimal between two runs.
 */
export function persenCapaian(realisasi: string, anggaran: string): Persen | null {
  const bawah = keSen(anggaran);
  if (bawah === 0n) return null;
  // Scale by 10_000 = 100 (percent) * 100 (two decimals), then round half up.
  const atas = keSen(realisasi) * 10_000n;
  const negatif = atas < 0n !== bawah < 0n;
  const absAtas = atas < 0n ? -atas : atas;
  const absBawah = bawah < 0n ? -bawah : bawah;
  const dibulatkan = (absAtas + absBawah / 2n) / absBawah;
  const bertanda = negatif ? -dibulatkan : dibulatkan;
  const abs = bertanda < 0n ? -bertanda : bertanda;
  return `${bertanda < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}
