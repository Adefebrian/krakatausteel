// Spec 9.6, the WRITING half of the tools. modules/tools reads and only reads
// (its own header says a POST there would be the moment somebody invented a
// repair path around `postingEvent`); this module writes, so it is a separate
// module with a separate threat model.
//
// ---------------------------------------------------------------------------
// FOUR RULES, AND THE FIRST ONE DECIDES THE ARCHITECTURE
// ---------------------------------------------------------------------------
//
// 1. ALL OR NOTHING PER FILE. Spec 9.6: "Jangan pernah commit sebagian tanpa
//    laporan eksplisit ke user." A half-applied import is worse than a refused
//    one, because nobody can tell from the outside which half applied. So a
//    commit runs EVERY row inside ONE `db.transaction`, and one bad row rolls
//    the whole file back.
//
//    That is the reason for `PabrikAngsuran` below. `angsuran.alokasikanSetoran`
//    opens its own `db.transaction` per receipt, which would make a 200-row
//    file 200 independent commits. Rather than change that engine (whose
//    transaction boundary is correct for its own callers), the import builds a
//    SECOND instance of it over a db port whose `transaction(fn)` runs `fn`
//    against the ALREADY OPEN outer transaction. The engine is unmodified, the
//    ledger path is unchanged, and the whole file becomes one commit.
//
// 2. NO JOURNAL IS WRITTEN BY ANY PATH OTHER THAN `postingEvent`. This module
//    has no journal port at all. The only rows it writes itself are `mitra`,
//    `impor_berkas` and `impor_baris`; every rupiah it moves moves through the
//    instalment engine, which reaches the ledger through the journal engine,
//    which is the single posting path invariant 11 rests on.
//
// 3. AN IMPORT CANNOT DO WHAT ITS OPERATOR COULD NOT DO ONE ROW AT A TIME. The
//    route requires `tools.import`; the ENGINE additionally requires the
//    ordinary operational code for the thing being created (`pumk.create` for
//    a mitra, `pumk.angsuran` for a receipt, checked by the instalment engine
//    itself from the caller's real permission list). Uploading a file is not a
//    privilege-escalation ramp.
//
// 4. EVERY IMPORTED ROW IS ATTRIBUTABLE. `impor_berkas` names the file, its
//    SHA-256, its size, the branch, and the uploader; `impor_baris` ties each
//    created entity, and the journal it produced, to a LINE NUMBER in that
//    file. "This import posted 500 journals with one click" is only acceptable
//    if all 500 can be traced back to a named file and a named person, and the
//    same file cannot be committed twice (`impor_berkas_checksum_uq`).
import type { QueryRunner } from "../../core/ports/db";

/** Decimal string, exactly two fractional digits. Never a JS number. */
export type Uang = string;

export const POLA_UANG = /^\d{1,15}\.\d{2}$/;
export const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
export const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route's gate. Both codes SHIP in modules/auth's catalogue. */
export const PERMISSION_IMPOR = {
  UNGGAH: "tools.import",
  /** Rule 3: creating a borrower record is the Maker's ordinary act. */
  MITRA: "pumk.create",
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const KODE_IMPOR = {
  JENIS_TIDAK_DIKENAL: "JENIS_TIDAK_DIKENAL",
  BERKAS_KOSONG: "BERKAS_KOSONG",
  BERKAS_TERLALU_BESAR: "BERKAS_TERLALU_BESAR",
  TERLALU_BANYAK_BARIS: "TERLALU_BANYAK_BARIS",
  HEADER_TIDAK_LENGKAP: "HEADER_TIDAK_LENGKAP",
  /**
   * At least one row was refused, so NOTHING was written.
   *
   * NOT thrown as an `ImporError`: see `HasilKomitAtauTolak` below. The
   * rejection list is the PRODUCT of this refusal and travels as data, because
   * core/http.ts deliberately does not put a domain error's `detail` in the
   * response body. The code is kept here so the route can put it in the
   * envelope as `kodeDomain`, which is what a client branches on.
   */
  ADA_BARIS_DITOLAK: "ADA_BARIS_DITOLAK",
  /** The same bytes were already committed. Answered as a conflict. */
  BERKAS_SUDAH_DIIMPOR: "BERKAS_SUDAH_DIIMPOR",
  CABANG_TIDAK_DITEMUKAN: "CABANG_TIDAK_DITEMUKAN",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
} as const;

export type KodeImpor = (typeof KODE_IMPOR)[keyof typeof KODE_IMPOR];

/**
 * Registered in `NAMA_ERROR_BERKODE` in core/http.ts WITH this file. Four
 * modules have shipped a router without that registration, each producing
 * anonymous 500s with no audit denial row.
 */
export class ImporError extends Error {
  readonly kode: KodeImpor;
  readonly detail?: Record<string, unknown> | undefined;
  readonly penyebabDb?: string | undefined;

  constructor(
    kode: KodeImpor,
    message: string,
    detail?: Record<string, unknown>,
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "ImporError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export const JENIS_IMPOR = ["MITRA", "ANGSURAN"] as const;
export type JenisImpor = (typeof JENIS_IMPOR)[number];

/**
 * CSV, NOT XLSX, AND THAT IS A REPORTED GAP RATHER THAN A DESIGN CHOICE.
 * Spec 9.6 says "dari Excel". Parsing a real .xlsx needs a third-party
 * dependency, and adding one is a decision for the repository owner, not for
 * this module. The engine below takes TEXT and the column contract is the
 * same either way, so an xlsx front end is a parser swapped in front of
 * `parseCsv` and nothing else.
 */
export const MAKS_ISI_BYTE = 512 * 1024;
export const MAKS_BARIS = 2000;

export interface BerkasImpor {
  namaFile: string;
  /** The file's text, exactly as uploaded. The checksum is taken over this. */
  isi: string;
}

/** One refused line, with the line number the operator sees in their sheet. */
export interface BarisDitolak {
  nomorBaris: number;
  alasan: Record<string, string[]>;
}

export interface BarisDiterima {
  nomorBaris: number;
  ringkasan: Record<string, string | number | null>;
}

export interface HasilPratinjau {
  jenis: JenisImpor;
  namaFile: string;
  checksum: string;
  ukuranBytes: number;
  jumlahBaris: number;
  diterima: BarisDiterima[];
  ditolak: BarisDitolak[];
  /** True only when `ditolak` is empty. A commit refuses otherwise. */
  siapKomit: boolean;
}

export interface HasilKomit {
  berkasId: string;
  jenis: JenisImpor;
  namaFile: string;
  checksum: string;
  jumlahBaris: number;
  jumlahDitulis: number;
  /** Journal ids produced, in line order. Empty for an import that posts none. */
  jurnalIds: string[];
}

// ---------------------------------------------------------------------------
// Column contracts
// ---------------------------------------------------------------------------

/**
 * Required and optional headers per kind. A file missing a required header is
 * refused whole (`HEADER_TIDAK_LENGKAP`); an unknown header is refused too,
 * because a mis-spelled column that is silently ignored is how an import
 * quietly loses a field.
 */
export const KOLOM_MITRA = {
  wajib: ["kode_mitra", "nama_lengkap"],
  opsional: [
    "nik",
    "jenis_kelamin",
    "tanggal_lahir",
    "alamat",
    "telepon",
    "email",
    "nama_usaha",
    "bidang_usaha",
    "kode_mitra_lama",
  ],
} as const;

export const KOLOM_ANGSURAN = {
  wajib: ["no_akad", "tanggal", "jumlah", "kode_akun_kas"],
  opsional: ["no_bukti", "tanggal_valuta", "keterangan"],
} as const;

export function kolomUntuk(jenis: JenisImpor): {
  wajib: readonly string[];
  opsional: readonly string[];
} {
  return jenis === "MITRA" ? KOLOM_MITRA : KOLOM_ANGSURAN;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ImporDbPort extends QueryRunner {
  transaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T>;
}

export interface PorterAuditImpor {
  record(
    entry: {
      userId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      aksi: string;
      entitas: string;
      entitasId?: string | null;
      nilaiBaru?: unknown;
      hasil: "SUKSES" | "DITOLAK";
      keterangan?: string | null;
    },
    runner?: QueryRunner,
  ): Promise<string>;
}

/** What the import needs of the instalment engine, and nothing more. */
export interface PorterAngsuranImpor {
  alokasikanSetoran(
    input: {
      akadId: string;
      tanggal: string;
      jumlah: Uang;
      akunKasId: string;
      noBukti?: string | null;
      tanggalValuta?: string | null;
      keterangan?: string | null;
    },
    ctx: {
      userId: string;
      cabangId: string;
      bumnId: string;
      permissions: readonly string[];
      cabangDalamScope?: readonly string[];
    },
  ): Promise<{ angsuranId: string; jurnalId: string; jumlahDiterima: Uang }>;
}

/**
 * Builds an instalment engine bound to an ALREADY OPEN transaction. See rule 1
 * in this file's header: this is what makes a whole file one commit without
 * modifying the instalment engine's own transaction boundary.
 *
 * Supplied by the composition root (core/app.ts), which is the only place
 * allowed to know both modules at once.
 */
export type PabrikAngsuran = (db: ImporDbPort) => PorterAngsuranImpor;

export interface ImporEngineDeps {
  db: ImporDbPort;
  audit: PorterAuditImpor;
  angsuran: PabrikAngsuran;
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// Context and engine
// ---------------------------------------------------------------------------

export interface ImporContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Empty means "no branch restriction" (Admin Pusat, Auditor). */
  cabangDalamScope?: readonly string[];
}

export interface PermintaanImpor {
  jenis: JenisImpor;
  berkas: BerkasImpor;
  /**
   * The branch every row lands in. One file, one branch: a file that named a
   * branch per row would be a way into a branch the uploader may not touch.
   * Defaults to the session's own branch and is always checked against the
   * session's scope, never trusted from the request.
   */
  cabangId?: string | null;
}

/**
 * What a commit attempt produced.
 *
 * A FILE WITH BAD ROWS IS NOT AN ERROR, IT IS AN ANSWER, and that is why this
 * is a union rather than a thrown `ImporError`. Spec 9.6 makes the rejection
 * report the PRODUCT of a refused import ("tampilkan baris yang error dengan
 * alasan"), and an error body in this codebase carries a message and a code,
 * not a structured report: core/http.ts deliberately does not put a domain
 * error's `detail` in the response, because several engines park things there
 * (a row's real `cabang_id`, for one) that a refusal must never reveal.
 *
 * So the rejection list travels as data, the route turns `ok: false` into a
 * 400 with the whole report attached, and nothing about the error taxonomy has
 * to be loosened for one module's benefit. Everything that IS an error here
 * (an unreadable header, a file already imported, a branch out of scope) still
 * throws `ImporError` and still goes through core/http.ts.
 */
export type HasilKomitAtauTolak =
  | { ok: true; hasil: HasilKomit }
  | { ok: false; laporan: HasilPratinjau };

export interface ImporEngine {
  /** Parses and validates. WRITES NOTHING, not even `impor_berkas`. */
  pratinjau(permintaan: PermintaanImpor, ctx: ImporContext): Promise<HasilPratinjau>;
  /**
   * Applies the whole file in ONE transaction, or applies none of it. Answers
   * `{ ok: false }` with the full rejection list if any row fails validation,
   * and rolls back if any row fails while being written.
   */
  komit(permintaan: PermintaanImpor, ctx: ImporContext): Promise<HasilKomitAtauTolak>;
}
