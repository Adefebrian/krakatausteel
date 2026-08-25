// Money for the closing engine. BigInt minor units (sen) internally, a decimal
// string with exactly two fractional digits at every boundary, never a JS
// float (spec invariant 7).
//
// RE-DECLARED RATHER THAN IMPORTED, for the reason the sibling copies in
// modules/angsuran and modules/nonpumk record: `bun tools/check-boundaries.ts`
// forbids reaching past a sibling module's index, and the same helpers are
// internal to the ledger module. The semantics must not drift: a sen-level
// difference between two of these copies would be a real difference in a real
// ledger. When a shared money package appears, all four collapse into it.
//
// SIGNED THROUGHOUT, unlike the sibling copies. Spec 8.2's
// `beban_penyisihan_periode` is negative for a recovery and
// `saldo_akun_periode` is debit-positive, so a credit-balance account carries a
// negative figure. A helper that refused a minus sign would push the engine
// into carrying signs beside its amounts, which is how a sign gets lost.
import { POLA_UANG, type Rate, type Uang } from "./contract";

const POLA_SEN = /^(-?)(\d+)\.(\d{2})$/;
const POLA_RATE_KETAT = /^(\d{1,3})\.(\d{1,6})$/;

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

/**
 * Normalises what Postgres handed back. `numeric(20,2)::text` is already the
 * right shape; this exists so a `coalesce(sum(...), 0)` that slipped through as
 * '0' is caught HERE, at the boundary, instead of failing an equality
 * assertion three layers away with no clue where it came from.
 */
export function uangDariDb(nilai: string | null | undefined): Uang {
  if (nilai === null || nilai === undefined) return "0.00";
  if (!POLA_UANG.test(nilai)) {
    throw new Error(
      `modules/closing: nilai uang dari database bukan numeric(20,2)::text: ${JSON.stringify(nilai)}. ` +
        "Cast ke ::numeric(20,2) SEBELUM ::text (lihat catatan driver di repo ledger).",
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

export function nol(a: string): boolean {
  return keSen(a) === 0n;
}

/**
 * `nilai * rate`, rounded HALF UP away from zero to the sen.
 *
 * The rounding rule is not a preference: `kolektibilitas_snapshot_nilai_ck`
 * re-derives the stored allowance with Postgres `round(x * rate, 2)`, so an
 * engine that rounded any other way would have its own INSERT refused by the
 * database. Done in BigInt so the two cannot disagree because of a float.
 */
export function kaliRate(nilai: string, rate: Rate): Uang {
  const m = POLA_RATE_KETAT.exec(rate);
  if (!m) throw new Error(`bukan Rate yang valid: ${JSON.stringify(rate)}`);
  const rateMikro = BigInt(m[1]) * 1_000_000n + BigInt(m[2].padEnd(6, "0"));
  const produk = keSen(nilai) * rateMikro; // scaled by 1e6
  const negatif = produk < 0n;
  const abs = negatif ? -produk : produk;
  const dibulatkan = (abs + 500_000n) / 1_000_000n;
  return sen(negatif ? -dibulatkan : dibulatkan);
}

/** NUMERIC(9,6) as the six-decimal string the contract's `POLA_RATE` demands. */
export function rateDariDb(nilai: string): Rate {
  const m = POLA_RATE_KETAT.exec(nilai);
  if (!m) throw new Error(`bukan Rate yang valid dari database: ${JSON.stringify(nilai)}`);
  return `${m[1]}.${m[2].padEnd(6, "0")}`;
}

/** Builds a `Rate` from a ratio expressed in millionths, clamped to [0, 1]. */
export function rateDariMikro(mikro: bigint): Rate {
  const dijepit = mikro < 0n ? 0n : mikro > 1_000_000n ? 1_000_000n : mikro;
  return `${dijepit / 1_000_000n}.${String(dijepit % 1_000_000n).padStart(6, "0")}`;
}
