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
// 2. NO JOURNAL IS WRITTEN BY ANY PATH OTHER THAN THE JOURNAL ENGINE.
//    ./repo.ts contains no statement that touches `jurnal` or `jurnal_baris`,
//    which is checked statically (`bun run check:boundaries`) and at runtime
//    (migration 0020's posting-path trigger). The receipt import moves money
//    through the instalment engine, which reaches the ledger through the
//    journal engine; the opening-balance import names the journal engine
//    itself, through `PorterJurnalSaldoAwal` below, because there is no
//    business engine behind an opening balance to route it through and
//    inventing one would be worse. `event_jurnal_mapping` still decides the
//    accounts and the document type in both cases, which is what invariant 11
//    actually rests on.
//
//    THE TABLES THIS MODULE WRITES ITSELF, in full, so a reader never has to
//    infer the list: `impor_berkas`, `impor_baris`, `mitra` (MITRA), and for
//    SALDO_AWAL `akun`, `saldo_awal_batch`, `akun_saldo_awal`,
//    `akad_saldo_awal`, plus the opening outstanding on `pumk_akad`. The last
//    one is the only write into another module's table that is not a create,
//    and ./saldo-awal.ts argues it where it happens.
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
  /**
   * RULE 3, APPLIED TO THE ONE IMPORT THAT OPENS THE BOOKS.
   *
   * An opening-balance file does two things an operator could otherwise only
   * do one at a time, and the engine demands the ordinary right for BOTH:
   *
   *   `konfigurasi.coa`  it may CREATE ACCOUNTS. Editing the chart of accounts
   *                      by hand needs this code, so doing it from a
   *                      spreadsheet needs it too.
   *   `jurnal.post`      it lands a POSTED journal. `postingEventGabungan`
   *                      deliberately does not demand this (see its note in
   *                      modules/jurnal/contract.ts: an automatic journal is
   *                      the consequence of a business act already
   *                      authorised), but here there IS no prior business act
   *                      -- the file itself is the act -- so the right that
   *                      normally guards putting an entry in the ledger is
   *                      the right that guards this.
   *
   * The consequence is intended and worth stating: in the shipped RBAC the
   * Maker holds `tools.import` and neither of these, so the Maker can import
   * mitra and receipts and CANNOT open the books. Only Admin Pusat can, which
   * is the correct blast radius for a one-shot go-live migration.
   */
  SALDO_AWAL_COA: "konfigurasi.coa",
  SALDO_AWAL_POSTING: "jurnal.post",
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const KODE_IMPOR = {
  JENIS_TIDAK_DIKENAL: "JENIS_TIDAK_DIKENAL",
  BERKAS_KOSONG: "BERKAS_KOSONG",
  BERKAS_TERLALU_BESAR: "BERKAS_TERLALU_BESAR",
  /**
   * An .xlsx this system refuses to parse: not a ZIP, too many entries, a
   * decompression bomb, a DTD or entity declaration, an unsafe entry name,
   * password protection, ZIP64, an unsupported compression method, or a sheet
   * past one of the row/column/cell caps.
   *
   * ONE CODE FOR ALL OF THEM AT THE HTTP BOUNDARY, and the specific reason in
   * the MESSAGE, which core/xlsx writes in Indonesian for an operator. The
   * distinction that matters to a caller is "your file was refused whole and
   * nothing was written"; the distinction between a bomb and a 3 MB sheet
   * matters to whoever reads the log, and `KesalahanXlsx.kode` carries it
   * there. Splitting it into fourteen HTTP codes would also tell an attacker
   * precisely which cap they hit.
   */
  BERKAS_XLSX_DITOLAK: "BERKAS_XLSX_DITOLAK",
  FORMAT_TIDAK_DIKENAL: "FORMAT_TIDAK_DIKENAL",
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

  // --- SALDO_AWAL, the go-live migration (spec 9.6, ADR 0006) -------------
  //
  // FIVE REFUSALS, AND NOT ONE OF THEM IS A WARNING. An opening balance set
  // that does not reconcile is not an import that needs a note attached; it
  // is an import that must not exist, because the ledger it would land can
  // never close its first month (spec 8.4 check 10 is prerequisite 10 of the
  // close) and the person who finds out is the accountant, weeks later.

  /** Total debit <> total credit across the file's account rows. */
  SALDO_AWAL_TIDAK_BALANCE: "SALDO_AWAL_TIDAK_BALANCE",
  /**
   * The akad sub-ledger does not add up to the receivable control account.
   * Both halves come from the SAME file, so this is checked before a row is
   * written rather than discovered by the close.
   */
  SUBLEDGER_PIUTANG_TIDAK_COCOK: "SUBLEDGER_PIUTANG_TIDAK_COCOK",
  /**
   * `v_rekonsiliasi_piutang` still reports a difference AFTER everything has
   * been written, read inside the import's own transaction. The shipped
   * predicate, not a restatement of it; if it disagrees with the two checks
   * above, the shipped predicate wins and the whole file rolls back.
   */
  REKONSILIASI_PIUTANG_GAGAL: "REKONSILIASI_PIUTANG_GAGAL",
  /**
   * There is no OPEN period to date the opening journal into, or the file's
   * stated cut-off is not the day before that period begins. See
   * `TANGGAL_EFEKTIF` in ./saldo-awal.ts for why those are one refusal.
   */
  PERIODE_SALDO_AWAL_TIDAK_SIAP: "PERIODE_SALDO_AWAL_TIDAK_SIAP",
  /**
   * This scope already has a posted opening balance. The FILE-level checksum
   * refusal cannot catch a re-saved .xlsx or a reordered CSV; this can, and
   * `saldo_awal_batch_diposting_uq` (migration 0033) makes it true under a
   * race as well as under a retry.
   */
  SALDO_AWAL_SUDAH_DIPOSTING: "SALDO_AWAL_SUDAH_DIPOSTING",
  /**
   * `event_jurnal_mapping` names no receivable account, so the control-account
   * check has nothing to compare against. Answering "no difference" would be
   * the one wrong answer an operator would act on, so the import refuses.
   * Same code, same reason, as modules/tools uses for the same fact.
   */
  MAPPING_PIUTANG_TIDAK_ADA: "MAPPING_PIUTANG_TIDAK_ADA",
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

export const JENIS_IMPOR = ["MITRA", "ANGSURAN", "SALDO_AWAL"] as const;
export type JenisImpor = (typeof JENIS_IMPOR)[number];

/**
 * CSV AND XLSX, and the gap this comment used to report is closed.
 *
 * It used to say: "CSV, NOT XLSX, AND THAT IS A REPORTED GAP RATHER THAN A
 * DESIGN CHOICE. Spec 9.6 says 'dari Excel'. Parsing a real .xlsx needs a
 * third-party dependency ... an xlsx front end is a parser swapped in front of
 * `parseCsv` and nothing else." That is exactly what ./xlsx.ts is, and it
 * needed no third-party dependency after all: core/xlsx reads the container
 * itself, because the one thing an .xlsx reader MUST have here -- a hard cap
 * on the number of bytes decompression is allowed to produce -- is not
 * exposed by any of the libraries.
 *
 * `MAKS_ISI_BYTE` IS THE SAME NUMBER FOR BOTH and is measured on the DECODED
 * bytes, not on the base64 the .xlsx arrives as. The rest of the .xlsx caps
 * (entry count, decompressed total, rows, columns, cell length, string table)
 * are in ./xlsx.ts and core/xlsx/batas.ts, each with the reason for its value.
 */
export const MAKS_ISI_BYTE = 512 * 1024;
export const MAKS_BARIS = 2000;

/**
 * How `BerkasImpor.isi` is encoded.
 *
 * CSV  -> `isi` is the file's TEXT, exactly as uploaded.
 * XLSX -> `isi` is the file's BYTES, base64. It cannot be text: an .xlsx is a
 *         ZIP, and putting arbitrary bytes through a JSON string would corrupt
 *         them at the first invalid UTF-8 sequence.
 *
 * The checksum is taken over `isi` either way, so it is still a hash of the
 * exact bytes uploaded and `impor_berkas_checksum_uq` still refuses the same
 * file twice.
 */
export const FORMAT_IMPOR = ["CSV", "XLSX"] as const;
export type FormatImpor = (typeof FORMAT_IMPOR)[number];

export interface BerkasImpor {
  namaFile: string;
  /** CSV text, or base64 of an .xlsx. See `FORMAT_IMPOR`. */
  isi: string;
  /** Absent means CSV, so every existing caller is unchanged. */
  format?: FormatImpor;
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
  /** SALDO_AWAL only: the batch, the journal and the numbers that were checked. */
  saldoAwal?: RingkasanSaldoAwal;
}

/**
 * What an opening-balance import produced, and the arithmetic it was allowed
 * to commit on. Every figure here is a decimal STRING because every one of
 * them is money.
 */
export interface RingkasanSaldoAwal {
  batchId: string;
  jurnalId: string;
  noJurnal: string;
  /** The legacy cut-off, as stated by the operator. */
  tanggalEfektif: string;
  /** The date the journal actually carries. See `PermintaanSaldoAwal`. */
  tanggalJurnal: string;
  periodeId: string;
  /**
   * THE TRIAL BALANCE's own totals, which is the number an accountant checks
   * against the old system's report. Deliberately NOT the journal's gross:
   * every imported balance is recorded once on its own account and once on the
   * clearing account (see the SALDO_AWAL rows in seed/event-jurnal.ts), so the
   * journal's gross is twice this and would be the wrong figure to reconcile
   * against anything outside this system.
   */
  totalDebit: Uang;
  totalKredit: Uang;
  /** The journal's own gross totals. Always exactly twice the two above. */
  brutoJurnalDebit: Uang;
  brutoJurnalKredit: Uang;
  /** `akun_saldo_awal` rows written. */
  jumlahAkun: number;
  /** `akad_saldo_awal` rows written. */
  jumlahAkad: number;
  /** Accounts this file had to create because no such code existed. */
  akunDibuat: string[];
  /** The receivable control account the sub-ledger was checked against. */
  kodeAkunPiutang: string;
  saldoKontrolPiutang: Uang;
  totalSubLedgerPiutang: Uang;
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

/**
 * ONE FILE, TWO SECTIONS, AND THAT IS FORCED BY THE FIRST RECONCILIATION RULE.
 *
 * Spec 9.6's opening balance is two lists: the chart of accounts with its
 * balances, and the outstanding per akad. They could be two uploads. They must
 * not be, because the check that decides whether either may be committed --
 * "the akad sub-ledger total equals the receivable control account" -- spans
 * BOTH. Two files means one of them commits first, and the moment the account
 * half is in the ledger without its sub-ledger half, spec 8.4 check 10 fails
 * and the entity cannot close its first month. So the two halves arrive in one
 * file, are validated together, and commit together or not at all.
 *
 * `bagian` is the discriminator: `AKUN` or `AKAD`. It is the only mandatory
 * column, because every other column is required by exactly one of the two
 * sections and a row is validated against its own section's rules. The
 * operator's template carries every column; a missing one is still refused by
 * `HEADER_TIDAK_LENGKAP` if it was named, and an unknown one is refused too,
 * for the reason KOLOM_MITRA already gives.
 *
 * THE ACCOUNT-DEFINITION COLUMNS MAY ALL BE BLANK, and blank is a statement,
 * not an omission: it means "this code already exists, take its definition
 * from the database and import only the balance". Filling them in for an
 * account that already exists is how an operator states what they believe the
 * account IS, and the import compares that belief field by field. See
 * `AKUN_BENTROK` in ./saldo-awal.ts.
 */
export const KOLOM_SALDO_AWAL = {
  wajib: ["bagian"],
  opsional: [
    // bagian = AKUN
    "kode_akun",
    "nama_akun",
    "tipe",
    "saldo_normal",
    "level",
    "parent_kode",
    "klasifikasi",
    "is_postable",
    "is_kas",
    "is_kontra",
    "klasifikasi_arus_kas",
    "debit",
    "kredit",
    // bagian = AKAD
    "no_akad",
    "outstanding_pokok",
    "outstanding_jasa",
    "tunggakan_pokok",
    "tunggakan_jasa",
    "angsuran_ke_terakhir",
    "hari_tunggakan",
    "kolektibilitas",
    // both
    "keterangan",
  ],
} as const;

export function kolomUntuk(jenis: JenisImpor): {
  wajib: readonly string[];
  opsional: readonly string[];
} {
  if (jenis === "MITRA") return KOLOM_MITRA;
  if (jenis === "ANGSURAN") return KOLOM_ANGSURAN;
  return KOLOM_SALDO_AWAL;
}

/** The two halves of an opening balance file. */
export const BAGIAN_SALDO_AWAL = ["AKUN", "AKAD"] as const;
export type BagianSaldoAwal = (typeof BAGIAN_SALDO_AWAL)[number];

/**
 * What the request says about the batch, beyond the file's own rows.
 *
 * `tanggalEfektif` is the LEGACY CUT-OFF: the date the old system's balances
 * are stated as of. It is NOT the journal's date and the two are deliberately
 * different values; ./saldo-awal.ts's `TANGGAL_EFEKTIF` note states why, and
 * the import refuses a cut-off that does not sit immediately before the first
 * period this system keeps books for.
 */
export interface PermintaanSaldoAwal {
  tanggalEfektif: string;
  keterangan?: string | null;
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

/**
 * ONE COMPONENT OF THE OPENING JOURNAL. Deliberately the shape
 * `modules/jurnal` already publishes, narrowed to what this module supplies.
 */
export interface KomponenSaldoAwal {
  eventCode: string;
  nilai: Uang;
  /** Both legs come from here: `SALDO_AWAL` maps neither. See the seed. */
  akunDebitId?: string;
  akunKreditId?: string;
  /** Written to the piutang sub-ledger columns on the receivable leg only. */
  mitraId?: string | null;
  akadId?: string | null;
  keterangan?: string | null;
}

/**
 * WHAT THE OPENING BALANCE NEEDS OF THE JOURNAL ENGINE, AND WHY THIS PORT
 * EXISTS AT ALL WHEN RULE 2 SAYS THIS MODULE HAS NO JOURNAL PORT.
 *
 * Rule 2's real content is "no journal is written by any path other than the
 * journal engine", and it was expressed as "no journal port" because the two
 * imports that shipped first move money through the instalment engine, which
 * already owns that call. An opening balance has no business engine behind it:
 * it is not a disbursement, not a receipt, not an allowance. There is nothing
 * to route it through, so routing it through something would mean inventing a
 * fake business event, and the honest alternative is to name the ledger engine
 * directly.
 *
 * WHAT THAT DOES NOT MEAN. It is not a second way into the ledger:
 *   - the only method is `postingEventGabungan`, the engine's own combined
 *     posting, so `event_jurnal_mapping` still decides the accounts, the
 *     document type and whether the event exists at all (ADR 0004);
 *   - `modules/impor/repo.ts` still contains no statement touching `jurnal` or
 *     `jurnal_baris`, which `bun run check:boundaries` verifies statically and
 *     migration 0020's trigger verifies at runtime;
 *   - the journal is stamped `jalur_posting = 'ENGINE'`, not
 *     `IMPORT_SALDO_AWAL`, because it genuinely came through the engine.
 *     0020 sanctions that second value for a hand-written path; this import
 *     does not need it and therefore does not use it, and
 *     `v_jurnal_jalur_bukan_engine` stays empty after go-live.
 *
 * It takes the CALLER'S transaction, which is the whole reason the combined
 * posting exists in that shape: the batch rows, the akad outstanding and the
 * journal must commit together or the sub-ledger and the ledger disagree by
 * exactly the amount that was imported.
 */
export interface PorterJurnalSaldoAwal {
  postingEventGabungan(
    input: {
      cabangId: string;
      tanggalTransaksi: string;
      komponen: KomponenSaldoAwal[];
      keterangan?: string | null;
      referensiTipe?: string | null;
      referensiId?: string | null;
      kunciIdempotensi?: string | null;
    },
    tx: QueryRunner,
    ctx: {
      userId: string;
      cabangId: string;
      bumnId: string;
      permissions: readonly string[];
      cabangDalamScope?: readonly string[];
    },
  ): Promise<{
    id: string;
    noJurnal: string;
    periodeId: string;
    totalDebit: Uang;
    totalKredit: Uang;
    jumlahBaris: number;
  }>;
}

export interface ImporEngineDeps {
  db: ImporDbPort;
  audit: PorterAuditImpor;
  angsuran: PabrikAngsuran;
  /**
   * Absent means the SALDO_AWAL import is not wired, and it refuses rather
   * than half-working: an opening balance that wrote its batch rows and no
   * journal is exactly the half-applied state rule 1 exists to prevent.
   */
  jurnal?: PorterJurnalSaldoAwal;
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
  /** Required for, and only read by, `jenis = "SALDO_AWAL"`. */
  saldoAwal?: PermintaanSaldoAwal | null;
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
