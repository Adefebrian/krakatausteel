// apps/api/src/modules/tools/contract.ts
//
// THE TOOLS MODULE'S ONLY SHAPE. Spec 9.6, the two diagnostic pages:
// "Tools rekonsiliasi" (sub ledger piutang versus buku besar, per cabang, with
// drill down to the offending akad) and "Tools cek integritas" (a health check
// page listing unbalanced journals, negative outstanding, schedules whose
// principal does not match the akad, and duplicate collectibility snapshots).
//
// ---------------------------------------------------------------------------
// RULE 1: THESE ENDPOINTS DIAGNOSE. THEY NEVER REPAIR.
// ---------------------------------------------------------------------------
// Every method here issues SELECTs and nothing else. There is no journal port,
// no transaction, and no write of any kind, which is not a convention but a
// structural fact of this file: a repair path invented on a health check page
// would be a second way into the ledger and would bypass `postingEvent`
// (invariant 11, ADR 0012). A broken row found here is fixed by the engine
// that owns it -- a reversing journal, a reschedule, a re-run of the closing
// step -- never by this module.
//
// ---------------------------------------------------------------------------
// RULE 2: THE CHECKS ARE THE SEED'S CHECKS, NOT A SECOND OPINION.
// ---------------------------------------------------------------------------
// `apps/api/src/seed/demo-dunia/periksa.ts` already implements spec 9.6's
// checks as SQL, and the demo seed FAILS when one of them returns a non-zero
// count. If this module wrote its own version of the same invariant, the
// system would carry two definitions of "the books are intact" and the day
// they disagreed neither would obviously be wrong.
//
// So every predicate below is the seed's predicate, copied, with exactly two
// deliberate differences, both stated here and both asserted in
// ./tools-integritas.test.ts:
//
//   1. SCOPE. The seed owns the whole database and counts globally. An API
//      call is made by a person who holds a role in a tenant and, for
//      ADMIN_CABANG, in ONE branch. Every check here is therefore filtered by
//      `bumn_id` and, for the checks whose rows carry one, by the branch set
//      the SESSION resolved (spec 2 rule 3). The predicate that decides
//      whether a row is BROKEN is untouched; only the population is narrowed.
//
//   2. `NERACA_SALDO_TIDAK_SEIMBANG` READS `v_ledger_baris`, WHERE THE SEED
//      READS `jurnal.status = 'POSTED'`. ADR 0010: a REVERSED journal is still
//      in the ledger and its lines are offset by its reversal's lines, so the
//      canonical line set is `status IN ('POSTED','REVERSED')` and every
//      balance read in this repository must use the shipped view rather than
//      re-derive the filter. The two agree on the SELISIH (each journal
//      balances on its own, so dropping whole journals cannot unbalance the
//      total) and disagree on the TOTALS PRINTED, because POSTED-only hides
//      every reversed pair from the operator reading the page. This module
//      shows the ledger. `./tools-integritas.test.ts` pins both predicates at
//      zero difference on a world that contains a reversal, so the divergence
//      is proven immaterial to the verdict rather than assumed.
//
// TWO OF THE SEVEN CHECKS CANNOT FAIL ON THE SHIPPED SCHEMA, and that is
// recorded rather than hidden:
//   - `OUTSTANDING_POKOK_NEGATIF` is also `pumk_akad_outstanding_pokok_check`,
//     a CHECK constraint, so a negative outstanding cannot be committed at all.
//   - `SNAPSHOT_KOLEKTIBILITAS_GANDA` is also `kolektibilitas_snapshot_uq`, a
//     total unique index on (periode_id, akad_id) with no partial predicate,
//     so a duplicate cannot be committed either.
// Both stay, for the reason the seed keeps them: they are defence in depth
// against a future migration that relaxes the constraint, and a health check
// that reports on an invariant it cannot see fail is still reporting on the
// invariant. `KatalogPemeriksaan.dijagaDatabase` says so on the page instead of
// leaving an operator to wonder why one row is always green.
import type { DbPort } from "../../core/ports/db";
import { buatEngineTools } from "./service";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Decimal string, exactly two fractional digits. Never a JS number. */
export type Uang = string;

export const POLA_UANG = /^-?\d{1,18}\.\d{2}$/;

// ---------------------------------------------------------------------------
// Permissions (spec 2, spec 9.6). Both SHIP in modules/auth's catalogue.
// ---------------------------------------------------------------------------

export const PERMISSION_TOOLS = {
  /**
   * The health check page. Granted to ADMIN_CABANG (and so to ADMIN_PUSAT),
   * which is what makes the branch-scope path on these reads reachable at all:
   * an enforcement no reachable caller can trigger is not enforcement.
   */
  INTEGRITAS: "tools.integritas",
  /**
   * The reconciliation page. Granted to CHECKER and ADMIN_CABANG (and so to
   * ADMIN_PUSAT). Both are branch-bound roles, so this surface is scoped too.
   */
  REKONSILIASI: "tools.rekonsiliasi",
} as const;

export type PermissionTools = (typeof PERMISSION_TOOLS)[keyof typeof PERMISSION_TOOLS];

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const KODE_TOOLS = {
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  CABANG_TIDAK_DITEMUKAN: "CABANG_TIDAK_DITEMUKAN",
  /** A permission this module needs is not in the shipped catalogue, so the
   *  operation fails closed instead of treating an unknown code as granted. */
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",
  /** A check code the catalogue does not carry. */
  PEMERIKSAAN_TIDAK_DIKENAL: "PEMERIKSAAN_TIDAK_DIKENAL",
  /**
   * `event_jurnal_mapping` has no active PENCAIRAN_PUMK row, so there is no
   * configured receivable account and the reconciliation has nothing to
   * reconcile AGAINST. Refused rather than answered with zeroes: a page that
   * reports "no difference" because it could not find the account is the
   * worst possible answer, and it is the one an operator would act on.
   */
  MAPPING_PIUTANG_TIDAK_ADA: "MAPPING_PIUTANG_TIDAK_ADA",
} as const;

export type KodeTools = (typeof KODE_TOOLS)[keyof typeof KODE_TOOLS];

/**
 * The one error type this module raises. `name` is "ToolsError" and it carries
 * a string `kode`, which is the shape `core/http.ts` recognises; it is LISTED
 * in `NAMA_ERROR_BERKODE` there, because four modules shipped without being
 * listed and every refusal each of them made left an anonymous 500 with no
 * DITOLAK row in `audit_log`.
 */
export class ToolsError extends Error {
  readonly kode: KodeTools;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Raw driver/trigger text, for the SERVER LOG ONLY. Never rendered. */
  readonly penyebabDb?: string;

  constructor(
    kode: KodeTools,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "ToolsError";
    this.kode = kode;
    this.detail = Object.freeze({ ...detail });
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// The integrity catalogue (spec 9.6)
// ---------------------------------------------------------------------------

/**
 * Every check, keyed by a stable code. The order is the seed's order, so the
 * page and `periksaIntegritas` read top to bottom the same way.
 */
export const PEMERIKSAAN_INTEGRITAS = {
  JURNAL_TIDAK_BALANCE: "JURNAL_TIDAK_BALANCE",
  JADWAL_POKOK_TIDAK_COCOK: "JADWAL_POKOK_TIDAK_COCOK",
  SNAPSHOT_KOLEKTIBILITAS_GANDA: "SNAPSHOT_KOLEKTIBILITAS_GANDA",
  SUB_LEDGER_PIUTANG_TIDAK_COCOK: "SUB_LEDGER_PIUTANG_TIDAK_COCOK",
  TANGGA_KOLEKTIBILITAS: "TANGGA_KOLEKTIBILITAS",
  JURNAL_DRAFT_DI_PERIODE_CLOSED: "JURNAL_DRAFT_DI_PERIODE_CLOSED",
  OUTSTANDING_POKOK_NEGATIF: "OUTSTANDING_POKOK_NEGATIF",
  PIUTANG_JASA_BERSALDO_KREDIT: "PIUTANG_JASA_BERSALDO_KREDIT",
  NERACA_SALDO_TIDAK_SEIMBANG: "NERACA_SALDO_TIDAK_SEIMBANG",
} as const;

export type KodePemeriksaan =
  (typeof PEMERIKSAAN_INTEGRITAS)[keyof typeof PEMERIKSAAN_INTEGRITAS];

/**
 * WHICH SHIPPED ARTEFACT ANSWERED. Not decoration: an operator chasing a
 * failure needs to know which view or table to open, and a test needs to be
 * able to assert that a check did not quietly grow its own query.
 */
export type SumberPemeriksaan =
  | "v_integritas_jurnal"
  | "v_integritas_jadwal"
  | "v_integritas_snapshot"
  | "v_rekonsiliasi_piutang"
  | "kolektibilitas_range"
  | "jurnal"
  | "pumk_akad"
  | "v_ledger_baris";

export interface KatalogPemeriksaan {
  kode: KodePemeriksaan;
  /** Indonesian, the wording the seed prints, so the two pages read alike. */
  nama: string;
  sumber: SumberPemeriksaan;
  /** The entity kind `BarisPemeriksaan.id` names, for the drill-down link. */
  entitas: string;
  /**
   * True when a database constraint already makes a failure impossible, so a
   * permanently green row is expected rather than suspicious. See this file's
   * header.
   */
  dijagaDatabase: boolean;
  /**
   * False when the check's rows carry no branch at all (the kolektibilitas
   * ladder is configuration for the whole entity). The page uses it to explain
   * why a branch filter did not narrow that row.
   */
  terikatCabang: boolean;
}

/**
 * One offending row, in a shape every check shares so the page renders one
 * table and a caller can always follow the id.
 *
 * `fakta` is `string | null` throughout on purpose: every money value in it is
 * a `numeric(20,2)::text` and passing it through `number` is how a rupiah
 * turns into 0.30000000000000004 on a page an accountant is using to chase a
 * difference (invariant 7).
 */
export interface BarisPemeriksaan {
  /** Primary key of the offending row. */
  id: string;
  /** What `id` names: 'jurnal', 'pumk_akad', 'periode', 'kolektibilitas_range'. */
  entitas: string;
  /** What a human recognises: no_jurnal, no_akad, a class code. */
  label: string;
  /** null when the row genuinely has no branch, never "unknown". */
  cabangId: string | null;
  fakta: Readonly<Record<string, string | null>>;
}

export interface HasilPemeriksaan extends KatalogPemeriksaan {
  lulus: boolean;
  /** Offending rows found, AFTER scoping. Not the length of `baris`. */
  jumlah: number;
  /** The seed's one-line summary, same wording. */
  detail: string;
  /** Up to `batasBaris` offending rows, ordered so the worst comes first. */
  baris: BarisPemeriksaan[];
  /** True when `jumlah > baris.length`, so a truncated list says so. */
  terpotong: boolean;
}

export interface LaporanIntegritas {
  /** ISO timestamp from the injected clock. */
  dijalankanPada: string;
  /** The branches actually covered. Empty means "every branch in the tenant". */
  cabangDiperiksa: readonly string[];
  /** True when every check passed. */
  sehat: boolean;
  hasil: HasilPemeriksaan[];
}

export interface FilterIntegritas {
  /**
   * A FILTER, never authority. The service intersects it with the branches the
   * session resolved and REFUSES a branch outside that set rather than
   * emptying the answer: an empty health check reads as "that branch is
   * clean", which is a wrong answer presented as a right one.
   */
  cabangId?: string | null;
  /** Rows per check. Defaults to `BATAS_BARIS_BAWAAN`, capped at `BATAS_BARIS_MAKS`. */
  batasBaris?: number | null;
}

/** Enough to act on, small enough that a broken database cannot serialise itself. */
export const BATAS_BARIS_BAWAAN = 50;
export const BATAS_BARIS_MAKS = 500;

// ---------------------------------------------------------------------------
// Reconciliation (spec 8.4 check 10, spec 9.6 "Tools rekonsiliasi")
// ---------------------------------------------------------------------------

/**
 * ONE AKAD'S DIFFERENCE. Spec 9.6 asks for the page "per cabang, dengan drill
 * down ke akad penyebab", and spec 8.4 check 10 is the reconciliation that
 * blocks a period close. A total alone is useless operationally: two akad with
 * offsetting errors net to zero, and the only actionable output is the akad
 * that is wrong and by how much.
 */
export interface BarisRekonsiliasiPiutang {
  akadId: string;
  noAkad: string;
  cabangId: string;
  mitraId: string;
  namaMitra: string;
  statusAkad: string;
  /** `pumk_akad.outstanding_pokok`. */
  saldoSubLedger: Uang;
  /** `v_ledger_baris` sum on the configured receivable account, for this akad. */
  saldoBukuBesar: Uang;
  /** `saldoSubLedger - saldoBukuBesar`. Signed; both directions are real. */
  selisih: Uang;
}

export interface RingkasanCabangRekonsiliasi {
  cabangId: string;
  kodeCabang: string;
  namaCabang: string;
  jumlahAkad: number;
  jumlahAkadSelisih: number;
  totalSubLedger: Uang;
  totalBukuBesar: Uang;
  totalSelisih: Uang;
}

export interface LaporanRekonsiliasiPiutang {
  dijalankanPada: string;
  /** The account the reconciliation ran against, read from `event_jurnal_mapping`. */
  akunPiutangId: string;
  akunPiutangKode: string;
  cocok: boolean;
  jumlahAkadDiperiksa: number;
  jumlahAkadSelisih: number;
  totalSubLedger: Uang;
  totalBukuBesar: Uang;
  totalSelisih: Uang;
  perCabang: RingkasanCabangRekonsiliasi[];
  /** The drill-down. Ordered by absolute difference, largest first. */
  baris: BarisRekonsiliasiPiutang[];
  terpotong: boolean;
}

export interface FilterRekonsiliasi {
  cabangId?: string | null;
  /**
   * Default TRUE: the page exists to show what is wrong, and a portfolio of
   * ten thousand correct akad is not the answer to "what do I fix". Set false
   * to export the whole reconciliation.
   */
  hanyaSelisih?: boolean | null;
  batasBaris?: number | null;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type ToolsDbPort = DbPort;

/**
 * Who is acting. Same shape as `JurnalContext`, `ClosingContext` and
 * `RkaContext` (spec 2 rule 3), so a context flows between modules unchanged
 * and the branch scope cannot be widened on the way through.
 */
export interface ToolsContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own. Admin Pusat / Auditor get every branch. */
  cabangDalamScope?: readonly string[];
}

export interface ToolsEngineDeps {
  db: ToolsDbPort;
  /** Injectable clock, so `dijalankanPada` is deterministic under test. */
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * NO JOURNAL PORT AND NO AUDIT PORT, and both are the point rather than an
 * omission. This engine cannot reach the ledger: every method is a SELECT, so
 * invariant 11 is not merely respected here, it is unreachable. Adding a
 * method that writes would require adding a port first, which is the loud
 * change this shape exists to force.
 */
export interface ToolsEngine {
  /** The catalogue, without touching the database. Needs `tools.integritas`. */
  katalogPemeriksaan(ctx: ToolsContext): Promise<KatalogPemeriksaan[]>;

  /** Every check, in catalogue order. Needs `tools.integritas`. */
  jalankanIntegritas(
    filter: FilterIntegritas,
    ctx: ToolsContext,
  ): Promise<LaporanIntegritas>;

  /**
   * ONE check, so a page can refresh a single row and a caller can raise
   * `batasBaris` for the one that is failing without pulling every other
   * check's rows too. Needs `tools.integritas`.
   */
  jalankanPemeriksaan(
    kode: KodePemeriksaan,
    filter: FilterIntegritas,
    ctx: ToolsContext,
  ): Promise<HasilPemeriksaan>;

  /**
   * Spec 8.4 check 10 as an operator's page: per cabang, per akad, with the
   * difference on each row. Needs `tools.rekonsiliasi`.
   */
  rekonsiliasiPiutang(
    filter: FilterRekonsiliasi,
    ctx: ToolsContext,
  ): Promise<LaporanRekonsiliasiPiutang>;
}

/**
 * The one implementation site. `deps` flows straight through to ./service.ts,
 * which is private to this module.
 */
export function createToolsEngine(deps: ToolsEngineDeps): ToolsEngine {
  return buatEngineTools(deps);
}
