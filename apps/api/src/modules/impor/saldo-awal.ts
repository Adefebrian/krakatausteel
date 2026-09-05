// The GO-LIVE MIGRATION: spec 9.6 "Import Saldo Awal", ADR 0006.
//
// Read ./contract.ts's four rules first. This file adds the three decisions
// that make THIS import different from the two that shipped before it, and it
// makes them here rather than in ./service.ts so the reasoning sits next to the
// arithmetic it governs.
//
// ===========================================================================
// 1. IT RECONCILES BEFORE IT COMMITS, AND EVERY FAILURE IS A REFUSAL
// ===========================================================================
//
// An opening balance set that does not reconcile is not an import that needs a
// warning attached. It is an import that must not exist. The reason is not
// tidiness: spec 8.4 check 10 (`v_rekonsiliasi_piutang`) is prerequisite 10 of
// the monthly close, so a book opened out of balance CANNOT CLOSE ITS FIRST
// MONTH, and nobody discovers that on import day. The accountant discovers it
// four weeks later, holding a difference with no transaction behind it.
//
// So there are three gates, in this order, and each of them refuses:
//
//   R1  TOTAL DEBIT = TOTAL CREDIT over the file's account rows.
//       `SALDO_AWAL_TIDAK_BALANCE`. A trial balance that does not balance is
//       not a trial balance. Checked on BigInt minor units, never on floats,
//       and with no tolerance of any kind (invariant 1: "persis, tanpa
//       toleransi").
//
//   R2  THE AKAD SUB-LEDGER TOTAL = THE RECEIVABLE CONTROL ACCOUNT.
//       `SUBLEDGER_PIUTANG_TIDAK_COCOK`. The control account is not named in
//       code: it is read from `event_jurnal_mapping` as the debit leg of
//       `PENCAIRAN_PUMK`, WHICH IS EXACTLY WHAT `v_rekonsiliasi_piutang`
//       ITSELF DOES. An accountant who repoints that mapping row repoints
//       this check with it, and the two can never disagree about which
//       account "Piutang" means. If the mapping names nothing, the import
//       refuses (`MAPPING_PIUTANG_TIDAK_ADA`) rather than comparing against
//       zero and reporting "no difference", which is the one wrong answer an
//       operator would act on.
//
//   R3  `v_rekonsiliasi_piutang` ITSELF, RE-READ AFTER EVERYTHING IS WRITTEN,
//       INSIDE THE SAME TRANSACTION, before it commits.
//       `REKONSILIASI_PIUTANG_GAGAL`. R1 and R2 are arithmetic on the file;
//       R3 is the shipped predicate on the actual rows. It is not redundant,
//       it is the only one of the three that can catch a mistake in this
//       file's own understanding of the ledger: a sub-ledger dimension that
//       did not land on the receivable leg, a merge that collapsed two akad
//       into one line, an akad that already carried a balance. If R3
//       disagrees with R1 and R2, the shipped predicate wins and the whole
//       file rolls back. The close's own check is therefore satisfied before
//       the import is allowed to become real, rather than being restated here
//       in a form that could drift from it.
//
// ===========================================================================
// 2. THE DATE. TWO DATES, AND THEY ARE NOT THE SAME DATE
// ===========================================================================
//
// `TANGGAL_EFEKTIF` is the LEGACY CUT-OFF: the moment the old system's
// balances are stated as of. It is what the operator knows, it is what the old
// system's trial balance is headed with, and it is stored on
// `saldo_awal_batch.tanggal_efektif`.
//
// It is NOT the journal's date, and it cannot be. Invariant 5 says a journal
// may only be dated into an OPEN period, and the period containing the legacy
// cut-off is by definition the period BEFORE the first one this system keeps
// books for: either it does not exist as a `periode` row at all, or it exists
// and is CLOSED. Both refuse at `trg_jurnal_10_periode`. Dating the opening
// journal at the cut-off is therefore not a preference this code could take;
// it is a journal Postgres will not accept.
//
// So the journal is dated at `tanggal_mulai` OF THE EARLIEST OPEN PERIOD, and
// that is the accounting-correct date rather than a workaround:
//
//   - an opening balance IS the state at the start of the first period this
//     system owns. "Closing balance of 31 December" and "opening balance of 1
//     January" are the same figure stated from either side of a boundary;
//   - dating it on day one means the first period's OPENING trial balance
//     equals the imported balances exactly, so every movement inside that
//     period is a movement this system made and can explain;
//   - dating it anywhere later would put legacy balances INSIDE a period whose
//     activity report then mixes migration with operations, and the first
//     month's Laporan Aktivitas would carry the whole legacy balance sheet as
//     if it were this month's movement.
//
// AND THE TWO DATES ARE CHECKED AGAINST EACH OTHER. `tanggal_efektif` must be
// exactly the day before that period begins. That single comparison is what
// catches the real go-live accident: December's balances uploaded into a book
// that starts in March, which balances perfectly, posts perfectly, and is
// three months of activity wrong. There is no "close enough" branch, because
// the operator can always fix the date and re-upload, and nobody can fix a
// posted opening balance dated into the wrong quarter.
//
// ===========================================================================
// 3. AN IMPORTED ACCOUNT MUST NOT SILENTLY COLLIDE WITH A SEEDED ONE
// ===========================================================================
//
// Three rules were available: SKIP the colliding row, UPDATE the account from
// the file, or REFUSE. The shipped rule is REFUSE, with one narrow, explicit
// exception that makes the normal case work.
//
//   SKIP is unsafe because it is silent about the half it kept. The balance on
//   that row is still posted; only the operator's statement of what the
//   account IS is discarded. The books then hold a figure on an account whose
//   type, normal balance or classification differs from the sheet the figure
//   came from, and nothing anywhere says so.
//
//   UPDATE is worse. `event_jurnal_mapping` points at seeded accounts by id,
//   and `akun.klasifikasi_akun` decides which line of which statement an
//   account prints on. Letting an uploaded file rewrite `tipe`,
//   `saldo_normal` or `klasifikasi` on an account that already carries posted
//   journal lines re-points the meaning of every one of those lines, retro-
//   actively, from a spreadsheet, with no maker-checker step. `is_postable`
//   is worse still: the schema uses it as a generated FK target (ADR 0003), so
//   flipping it off is refused by the database in the middle of an import.
//
//   REFUSE names the account code and the fields that differ, on the operator's
//   own line number, and the operator either corrects the sheet or an
//   accountant edits the account deliberately through the COA screen, which is
//   where a change of that weight belongs.
//
// THE EXCEPTION, WITHOUT WHICH THE RULE WOULD BE USELESS. Almost every opening
// balance lands on an account that already exists: Kas, Piutang, Aset Neto are
// all seeded. So a row whose definition columns are ALL BLANK is a BALANCE-ONLY
// row: it names an existing code, imports its balance, and creates and modifies
// nothing. Blank is a statement ("take the definition from the database"), not
// an omission, and a blank definition for a code that does NOT exist is refused
// too, because then there is nothing to take it from.
//
// A row that fills the definition columns in for a code that already exists is
// stating a belief about that account, and the import compares it field by
// field. Agreement is accepted (nothing is written). Disagreement is
// `AKUN_BENTROK`. That is the whole rule.
import type { QueryRunner } from "../../core/ports/db";
import {
  BAGIAN_SALDO_AWAL,
  ImporError,
  KODE_IMPOR,
  POLA_TANGGAL,
  type BagianSaldoAwal,
  type Uang,
} from "./contract";
import type { AkunAdaBaris, ImporRepo } from "./repo";

/**
 * The two event codes the opening journal posts under, seeded in
 * seed/event-jurnal.ts, one per SIDE of the legacy trial balance.
 *
 * TWO, AND NOT ONE WITH BOTH LEGS FROM THE FILE, because a mapping row that
 * fixes neither leg decides nothing about accounts and ADR 0004 stops meaning
 * anything for that event; `seed/event-jurnal.test.ts` enforces it. Each row
 * fixes its clearing leg (`3.1.02 Pos Transisi Saldo Awal`) and takes the real
 * account from the file. See the rows themselves for why pairing the file's
 * debits off against its own credits was rejected: it balances and it invents
 * economic relationships that do not exist.
 */
export const EVENT_SALDO_AWAL_DEBIT = "SALDO_AWAL_DEBIT";
export const EVENT_SALDO_AWAL_KREDIT = "SALDO_AWAL_KREDIT";

/**
 * Money, as BigInt minor units. Nothing in this file ever sees a float, and
 * `Number()` is never applied to an amount: NUMERIC(20,2) reaches 10^18 sen
 * and Number.MAX_SAFE_INTEGER is ~9x10^15.
 */
const POLA_UANG_IMPOR = /^\d{1,15}\.\d{2}$/;

export function keSen(nilai: string): bigint | null {
  const v = nilai.trim();
  if (!POLA_UANG_IMPOR.test(v)) return null;
  return BigInt(v.replace(".", ""));
}

export function dariSen(sen: bigint): Uang {
  const negatif = sen < 0n;
  const abs = negatif ? -sen : sen;
  const s = abs.toString().padStart(3, "0");
  return `${negatif ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface DefinisiAkunBaru {
  kode: string;
  nama: string;
  tipe: string;
  saldoNormal: "D" | "K";
  level: number;
  parentKode: string | null;
  klasifikasi: string;
  isPostable: boolean;
  isKas: boolean;
  isKontra: boolean;
  klasifikasiArusKas: string | null;
}

export interface BarisAkunSaldoAwal {
  nomorBaris: number;
  kodeAkun: string;
  /** Set when the account already exists. */
  akunId: string | null;
  /** Set when this row has to create the account. Exactly one of the two. */
  buat: DefinisiAkunBaru | null;
  debitSen: bigint;
  kreditSen: bigint;
  keterangan: string | null;
}

export interface BarisAkadSaldoAwal {
  nomorBaris: number;
  noAkad: string;
  akadId: string;
  mitraId: string;
  outstandingPokokSen: bigint;
  outstandingJasaSen: bigint;
  tunggakanPokokSen: bigint;
  tunggakanJasaSen: bigint;
  angsuranKeTerakhir: number | null;
  hariTunggakan: number | null;
  kolektibilitas: string | null;
  keterangan: string | null;
}

/** The period the opening journal will be dated into, plus the cut-off it implies. */
export interface JendelaSaldoAwal {
  periodeId: string;
  /** `periode.tanggal_mulai` of the earliest OPEN period. The journal's date. */
  tanggalJurnal: string;
  /** The day before it. The only cut-off this import accepts. */
  tanggalEfektifWajib: string;
}

// ---------------------------------------------------------------------------
// The date
// ---------------------------------------------------------------------------

export function tanggalValid(nilai: string): boolean {
  if (!POLA_TANGGAL.test(nilai)) return false;
  const t = new Date(`${nilai}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === nilai;
}

/** One day earlier, in UTC, so no local timezone can move a boundary date. */
export function hariSebelum(iso: string): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Resolves the window, and refuses when the file's cut-off does not sit
 * immediately before it. See decision 2 in this file's header for why these
 * two failures share one code: from the operator's side they are one question,
 * "which boundary are these balances for", and the message answers it with the
 * date the system expects.
 */
export async function jendelaSaldoAwal(
  tx: QueryRunner,
  repo: ImporRepo,
  bumnId: string,
  tanggalEfektif: string,
): Promise<JendelaSaldoAwal> {
  const periode = await repo.periodeOpenPertama(tx, bumnId);
  if (!periode) {
    throw new ImporError(
      KODE_IMPOR.PERIODE_SALDO_AWAL_TIDAK_SIAP,
      "Belum ada periode berstatus OPEN, jadi jurnal saldo awal tidak punya tempat mendarat. " +
        "Buat periode akuntansi pertama lebih dulu, lalu unggah ulang berkasnya.",
    );
  }
  const wajib = hariSebelum(periode.tanggal_mulai);
  if (tanggalEfektif !== wajib) {
    throw new ImporError(
      KODE_IMPOR.PERIODE_SALDO_AWAL_TIDAK_SIAP,
      `Tanggal efektif saldo awal harus ${wajib}, yaitu satu hari sebelum periode OPEN pertama ` +
        `(${periode.tahun}-${String(periode.bulan).padStart(2, "0")}, mulai ${periode.tanggal_mulai}). ` +
        `Yang dikirim ${tanggalEfektif}. Saldo awal adalah keadaan pada saat pembukuan sistem ini ` +
        "dimulai; kalau tanggalnya beda, yang diimpor adalah saldo periode lain.",
      { tanggalEfektif, tanggalEfektifWajib: wajib, tanggalMulaiPeriode: periode.tanggal_mulai },
    );
  }
  return {
    periodeId: periode.id,
    tanggalJurnal: periode.tanggal_mulai,
    tanggalEfektifWajib: wajib,
  };
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

const TIPE_AKUN = ["ASET", "LIABILITAS", "ASET_NETO", "PENDAPATAN", "BEBAN"] as const;
const ARUS_KAS = ["OPERASI", "INVESTASI", "PENDANAAN"] as const;

/** Every column that DEFINES an account, as opposed to stating its balance. */
export const KOLOM_DEFINISI_AKUN = [
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
] as const;

/** Collects per-field reasons for one row, exactly as ./service.ts's does. */
export interface PengumpulAlasan {
  tolak(field: string, pesan: string): void;
  readonly gagal: boolean;
  readonly galat: Record<string, string[]>;
}

function ya(nilai: string | undefined): boolean | null {
  const v = (nilai ?? "").trim().toUpperCase();
  if (v.length === 0) return null;
  if (["Y", "YA", "TRUE", "1"].includes(v)) return true;
  if (["N", "T", "TIDAK", "FALSE", "0"].includes(v)) return false;
  return null;
}

function bacaBagian(nilai: string | undefined): BagianSaldoAwal | null {
  const v = (nilai ?? "").trim().toUpperCase();
  return (BAGIAN_SALDO_AWAL as readonly string[]).includes(v) ? (v as BagianSaldoAwal) : null;
}

export { bacaBagian };

/**
 * Compares an operator's stated account definition against the account that
 * already exists, field by field, and returns the fields that DISAGREE.
 *
 * Only fields the operator actually filled in are compared. A blank cell is
 * "take it from the database" (decision 3), not "set it to empty", so it can
 * never be a difference.
 */
export function bedaDefinisiAkun(
  ada: AkunAdaBaris,
  v: Record<string, string>,
): Array<{ kolom: string; diminta: string; tersimpan: string }> {
  const beda: Array<{ kolom: string; diminta: string; tersimpan: string }> = [];
  const bandingkan = (kolom: string, diminta: string | null, tersimpan: string): void => {
    if (diminta === null) return;
    if (diminta !== tersimpan) beda.push({ kolom, diminta, tersimpan });
  };
  const teks = (k: string): string | null => {
    const x = (v[k] ?? "").trim();
    return x.length === 0 ? null : x;
  };
  const bool = (k: string): string | null => {
    const b = ya(v[k]);
    return b === null ? null : b ? "Y" : "N";
  };

  bandingkan("nama_akun", teks("nama_akun"), ada.nama);
  bandingkan("tipe", teks("tipe")?.toUpperCase() ?? null, ada.tipe);
  bandingkan("saldo_normal", teks("saldo_normal")?.toUpperCase() ?? null, ada.saldo_normal);
  bandingkan("level", teks("level"), String(ada.level));
  bandingkan("parent_kode", teks("parent_kode"), ada.parent_kode ?? "");
  bandingkan("klasifikasi", teks("klasifikasi"), ada.klasifikasi_akun);
  bandingkan("is_postable", bool("is_postable"), ada.is_postable ? "Y" : "N");
  bandingkan("is_kas", bool("is_kas"), ada.is_kas ? "Y" : "N");
  bandingkan("is_kontra", bool("is_kontra"), ada.is_kontra ? "Y" : "N");
  bandingkan(
    "klasifikasi_arus_kas",
    teks("klasifikasi_arus_kas")?.toUpperCase() ?? null,
    ada.klasifikasi_arus_kas ?? "",
  );
  return beda;
}

/** True when the operator left every definition column blank. */
export function definisiKosong(v: Record<string, string>): boolean {
  return KOLOM_DEFINISI_AKUN.every((k) => (v[k] ?? "").trim().length === 0);
}

/**
 * Validates the definition columns of a row that has to CREATE an account.
 * `kodeDalamBerkas` carries the accounts created by earlier lines of the same
 * file, so a parent may be defined one line above its child, which is how a
 * legacy chart of accounts actually arrives.
 */
export function bacaDefinisiAkunBaru(
  a: PengumpulAlasan,
  kode: string,
  v: Record<string, string>,
  punyaSaldo: boolean,
  kodeDalamBerkas: Map<string, { level: number; tipe: string; isPostable: boolean }>,
  parentDiDb: AkunAdaBaris | null,
  klasifikasiAda: boolean,
): DefinisiAkunBaru | null {
  const nama = (v.nama_akun ?? "").trim();
  if (nama.length === 0) a.tolak("nama_akun", "wajib diisi untuk akun yang belum ada");
  else if (nama.length > 160) a.tolak("nama_akun", "maksimal 160 karakter");

  const tipe = (v.tipe ?? "").trim().toUpperCase();
  if (!(TIPE_AKUN as readonly string[]).includes(tipe)) {
    a.tolak("tipe", `wajib salah satu dari: ${TIPE_AKUN.join(", ")}`);
  }

  const saldoNormal = (v.saldo_normal ?? "").trim().toUpperCase();
  if (saldoNormal !== "D" && saldoNormal !== "K") a.tolak("saldo_normal", "wajib D atau K");

  const levelMentah = (v.level ?? "").trim();
  const level = /^[1-6]$/.test(levelMentah) ? Number(levelMentah) : 0;
  if (level === 0) a.tolak("level", "wajib bilangan bulat 1 sampai 6");

  const parentKode = (v.parent_kode ?? "").trim();
  if (level === 1 && parentKode.length > 0) {
    a.tolak("parent_kode", "akun level 1 tidak boleh punya parent");
  }
  if (level > 1 && parentKode.length === 0) {
    a.tolak("parent_kode", "wajib diisi untuk akun level 2 ke atas");
  }
  if (level > 1 && parentKode.length > 0) {
    // The same three facts `trg_akun_10_hierarki` checks, checked here so the
    // operator gets a line number instead of a trigger string from the middle
    // of a commit that then rolls the whole file back.
    const dariBerkas = kodeDalamBerkas.get(parentKode);
    const indukLevel = dariBerkas?.level ?? parentDiDb?.level ?? null;
    const indukTipe = dariBerkas?.tipe ?? parentDiDb?.tipe ?? null;
    const indukPostable = dariBerkas?.isPostable ?? parentDiDb?.is_postable ?? null;
    if (indukLevel === null) {
      a.tolak("parent_kode", "akun induk tidak ditemukan, dan tidak dibuat di baris sebelumnya");
    } else {
      if (indukLevel !== level - 1) {
        a.tolak("parent_kode", `level akun induk (${indukLevel}) harus tepat satu di atas ${level}`);
      }
      if (indukTipe !== tipe) {
        a.tolak("parent_kode", `tipe akun induk (${indukTipe}) harus sama dengan tipe akun ini`);
      }
      if (indukPostable === true) {
        a.tolak("parent_kode", "akun induk adalah akun postable dan tidak boleh punya anak");
      }
    }
  }

  const klasifikasi = (v.klasifikasi ?? "").trim();
  if (klasifikasi.length === 0) a.tolak("klasifikasi", "wajib diisi untuk akun yang belum ada");
  else if (!klasifikasiAda) {
    a.tolak("klasifikasi", "klasifikasi akun ini belum terdaftar di entitas ini");
  }

  // Postable follows the balance unless the operator says otherwise: a row
  // that carries a figure MUST be postable (a journal line may only name a
  // postable account, ADR 0003), and a row that carries none is a header.
  const postableDiminta = ya(v.is_postable);
  const isPostable = postableDiminta ?? punyaSaldo;
  if (punyaSaldo && postableDiminta === false) {
    a.tolak("is_postable", "akun yang membawa saldo awal wajib postable");
  }
  if ((v.is_postable ?? "").trim().length > 0 && postableDiminta === null) {
    a.tolak("is_postable", "wajib Y atau N");
  }

  const isKas = ya(v.is_kas) ?? false;
  if ((v.is_kas ?? "").trim().length > 0 && ya(v.is_kas) === null) {
    a.tolak("is_kas", "wajib Y atau N");
  }
  if (isKas && tipe !== "ASET") a.tolak("is_kas", "hanya akun bertipe ASET yang boleh akun kas");

  const isKontra = ya(v.is_kontra) ?? false;
  if ((v.is_kontra ?? "").trim().length > 0 && ya(v.is_kontra) === null) {
    a.tolak("is_kontra", "wajib Y atau N");
  }

  const arus = (v.klasifikasi_arus_kas ?? "").trim().toUpperCase();
  if (arus.length > 0 && !(ARUS_KAS as readonly string[]).includes(arus)) {
    a.tolak("klasifikasi_arus_kas", `wajib salah satu dari: ${ARUS_KAS.join(", ")}`);
  }

  if (a.gagal) return null;
  return {
    kode,
    nama,
    tipe,
    saldoNormal: saldoNormal as "D" | "K",
    level,
    parentKode: level === 1 ? null : parentKode,
    klasifikasi,
    isPostable,
    isKas,
    isKontra,
    klasifikasiArusKas: arus.length === 0 ? null : arus,
  };
}

// ---------------------------------------------------------------------------
// The reconciliation, R1 and R2
// ---------------------------------------------------------------------------

export interface HasilRekonsiliasi {
  totalDebitSen: bigint;
  totalKreditSen: bigint;
  saldoKontrolPiutangSen: bigint;
  totalSubLedgerPiutangSen: bigint;
}

/**
 * R1 and R2 from this file's header. THROWS; there is no "warn" branch and
 * there is no tolerance, because both would be a lie about what the ledger
 * will accept a month later.
 */
export function rekonsiliasiBerkas(input: {
  akun: readonly BarisAkunSaldoAwal[];
  akad: readonly BarisAkadSaldoAwal[];
  akunPiutangId: string;
  kodeAkunPiutang: string;
}): HasilRekonsiliasi {
  let totalDebitSen = 0n;
  let totalKreditSen = 0n;
  let saldoKontrolPiutangSen = 0n;
  for (const r of input.akun) {
    totalDebitSen += r.debitSen;
    totalKreditSen += r.kreditSen;
    if (r.akunId === input.akunPiutangId) {
      saldoKontrolPiutangSen += r.debitSen - r.kreditSen;
    }
  }
  let totalSubLedgerPiutangSen = 0n;
  for (const r of input.akad) totalSubLedgerPiutangSen += r.outstandingPokokSen;

  if (totalDebitSen !== totalKreditSen) {
    throw new ImporError(
      KODE_IMPOR.SALDO_AWAL_TIDAK_BALANCE,
      `Neraca saldo awal tidak balance: total debit ${dariSen(totalDebitSen)} tidak sama dengan ` +
        `total kredit ${dariSen(totalKreditSen)} (selisih ${dariSen(totalDebitSen - totalKreditSen)}). ` +
        "Tidak ada satu baris pun yang disimpan. Perbaiki berkasnya lalu unggah ulang.",
      {
        totalDebit: dariSen(totalDebitSen),
        totalKredit: dariSen(totalKreditSen),
        selisih: dariSen(totalDebitSen - totalKreditSen),
      },
    );
  }

  if (saldoKontrolPiutangSen !== totalSubLedgerPiutangSen) {
    throw new ImporError(
      KODE_IMPOR.SUBLEDGER_PIUTANG_TIDAK_COCOK,
      `Sub ledger piutang tidak cocok dengan akun kontrolnya: baris akad berjumlah ` +
        `${dariSen(totalSubLedgerPiutangSen)}, sedangkan akun ${input.kodeAkunPiutang} pada berkas ini ` +
        `bersaldo ${dariSen(saldoKontrolPiutangSen)} (selisih ` +
        `${dariSen(saldoKontrolPiutangSen - totalSubLedgerPiutangSen)}). ` +
        "Pemeriksaan tutup buku butir 10 memakai perbandingan yang sama, jadi impor ini ditolak " +
        "sekarang alih alih menghalangi tutup buku bulan pertama.",
      {
        kodeAkunPiutang: input.kodeAkunPiutang,
        saldoKontrol: dariSen(saldoKontrolPiutangSen),
        totalSubLedger: dariSen(totalSubLedgerPiutangSen),
        selisih: dariSen(saldoKontrolPiutangSen - totalSubLedgerPiutangSen),
      },
    );
  }

  return {
    totalDebitSen,
    totalKreditSen,
    saldoKontrolPiutangSen,
    totalSubLedgerPiutangSen,
  };
}

// ---------------------------------------------------------------------------
// From a trial balance to journal components
// ---------------------------------------------------------------------------

/**
 * One imported balance, on the side it arrived on. The receivable's entries
 * additionally carry their akad, which is the dimension
 * `v_rekonsiliasi_piutang` joins on and the reason the control account's
 * balance is expanded into one entry per akad before it reaches the journal.
 */
export interface SisiSaldoAwal {
  akunId: string;
  sen: bigint;
  mitraId: string | null;
  akadId: string | null;
  keterangan: string | null;
}
