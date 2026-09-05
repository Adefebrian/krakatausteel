// WHEN ONE MODULE'S ENGINE REFUSES, HOW MUCH OF THAT REACHES THE PERSON WHO
// ASKED.
//
// THE DEFECT THIS FILE CLOSES, stated as it was found. A receipt back-dated
// into a CLOSED period is refused by `POST /pumk/angsuran`, correctly, and
// nothing is written. What the clerk is TOLD is `SETORAN_GAGAL`, "Penerimaan
// angsuran ini gagal diproses, jadi tidak ada yang tersimpan." The real reason
// exists and is one layer in: the ledger engine raised `PERIODE_TIDAK_OPEN`,
// whose own message is "Tanggal transaksi tidak berada di periode yang masih
// terbuka. Koreksi periode lampau dibuat sebagai jurnal pembalik di periode
// terbuka." Two `catch (err) { throw tolak("...", detail, penyebab(err)) }`
// blocks -- one in modules/angsuran, one in modules/pumk -- flattened it, and
// `penyebabDb` is server-log only, so the ONE fact that tells the clerk to ask
// head office to reopen January rather than retype the receipt and fail again
// never left the building.
//
// This is the same class of defect as the unregistered error classes recorded
// in core/http.ts, one layer in: there the CLASS was missing from the registry
// and every refusal became an anonymous 500; here the class is registered and
// the CODE is flattened, so every refusal becomes the same anonymous 409.
//
// WHAT WAS NOT THE FIX. Not "stop wrapping": the wrapping exists because a
// collaborator's refusal may be about the collaborator's own document, in the
// collaborator's own vocabulary, and because a raw driver or trigger string
// must never reach a caller. And not "copy the code into the outer module's
// enum": that would mean four modules re-declaring another module's ledger
// vocabulary and drifting from it.
//
// THE FIX. A refusal from a collaborating engine is RE-RAISED UNCHANGED when it
// is safe to do so, and flattened otherwise. Re-raising is safe because the
// thing being re-raised is already a registered coded domain error whose
// `message` is, by every module's own contract, user-facing Indonesian prose
// free of driver internals, and whose `penyebabDb` core/http.ts prints to the
// log and never to a body. The whole question is therefore WHICH codes, and
// that is answered by three rules below rather than by taste.
//
// The composition is the point: with both layers fixed, the ledger's
// `PERIODE_TIDAK_OPEN` passes through modules/angsuran and then through
// modules/pumk and arrives at the clerk with its own code, its own 409 and its
// own sentence, without either module knowing the other exists.
import { NAMA_ERROR_BERKODE, httpUntukKodeDomain } from "./http";

/** The shape every module's error class guarantees. Same contract core/http.ts uses. */
export interface SebabBerkode extends Error {
  kode: string;
  detail?: Record<string, unknown>;
  penyebabDb?: string;
}

/**
 * RULE 1, STRUCTURAL. A collaborator code whose HTTP meaning is an IDENTITY
 * ANSWER never travels.
 *
 * `CABANG_DILUAR_SCOPE` is why this rule is first and why it is a rule rather
 * than a list. `assertCabangAllowed` and every engine's `wajibScope` refuse
 * without naming the row's branch precisely so that a 403 does not become an
 * oracle for enumerating another branch's data (core/principal.ts says so at
 * the function). Letting that refusal out through an OUTER module would rebuild
 * the oracle one level up: the caller asked about a receipt and would learn,
 * from the status code alone, that the akad it names is real and belongs to
 * somebody else. The same holds for `TIDAK_DITEMUKAN` on a row the caller never
 * named, and for a `SEGREGASI_TUGAS` refusal about the collaborator's document
 * rather than about the act the caller performed.
 *
 * Derived from `KODE_KE_HTTP` rather than enumerated, so a code added to that
 * table is classified by the line that already decides its status. A second
 * list here is a second thing to forget.
 */
const ARTI_HTTP_TERTAHAN = new Set(["TIDAK_BERWENANG", "SEGREGASI_TUGAS", "TIDAK_DITEMUKAN", "TIDAK_TERAUTENTIKASI"]);

/**
 * RULE 2. A code that describes the INTERNAL CONSTRUCTION of a document the
 * caller never wrote never travels.
 *
 * These are spec 6.2's shape validations. They are correct, specific and
 * perfectly useful to whoever CALLED the ledger with a malformed journal -- and
 * that caller is a business module, not a person. A clerk who typed a receipt
 * and is told "jumlah debit dan jumlah kredit harus sama persis" is being
 * blamed for arithmetic they did not do and cannot reach, and the 400 those
 * codes carry says "fix the form" about a form that was fine. When one of these
 * appears, the module that built the journal has a bug; the operator's correct
 * answer is "this failed, nothing was saved, call support", which is exactly
 * what the flattened code says, with the real cause in `penyebabDb` where the
 * person who can fix it will read it.
 *
 * NOT the same as `PERIODE_TIDAK_OPEN`, which is also a spec 6.2 validation:
 * that one is about the WORLD (a month is closed) rather than about the shape
 * of a document, and the operator has a real next action for it.
 */
const KODE_BENTUK_INTERNAL: ReadonlySet<string> = new Set([
  "MINIMAL_DUA_BARIS",
  "SATU_SISI_PER_BARIS",
  "NILAI_NEGATIF",
  "TIDAK_BALANCE",
  "NILAI_BUKAN_DESIMAL",
  "DIMENSI_PIUTANG_SALAH_AKUN",
  "NOMOR_JURNAL_DUPLIKAT",
  "EVENT_PAYLOAD_TIDAK_LENGKAP",
  "KAS_BANK_TANPA_AKUN_KAS",
  "PINBUK_AKUN_SALAH",
  "PINBUK_TANPA_TAUTAN",
  "PINBUK_KATEGORI_TIDAK_VALID",
  "BATCH_GAGAL",
  // The reversal path's own internals. A business module that reverses through
  // the ledger and is told the reversal has no registered business reverser is
  // being told about a registry the operator cannot see.
  "PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR",
  // THE SAME FAMILY ONE ENGINE OVER: modules/angsuran's SCHEDULE-shape codes.
  // A PUMK operator names an akad, a date and an amount; the pokok, the method,
  // the rounding step and the per-row totals are derived by the instalment
  // engine from the akad and from `konfigurasi`. Told "pokok pinjaman harus
  // lebih besar dari nol" after asking to restructure a loan, an operator looks
  // for a principal field that is not on their form. `TOTAL_POKOK_TIDAK_COCOK`
  // is documented in that module as an internal assert ahead of TJSL-JDW-001,
  // which says it plainly.
  //
  // DELIBERATELY NOT HERE: `TENOR_DILUAR_BATAS`, `GRACE_DILUAR_BATAS` and
  // `POKOK_DILUAR_PLAFON`. Those look similar and are the opposite: they are
  // about a CONFIGURED policy limit and a field the operator did type, and the
  // next action is to change the number or to change the parameter. Those
  // travel.
  "POKOK_TIDAK_VALID",
  "TENOR_TIDAK_VALID",
  "RATE_TIDAK_VALID",
  "METODE_TIDAK_DIKENAL",
  "PEMBULATAN_TIDAK_VALID",
  "TOTAL_POKOK_TIDAK_COCOK",
  "PRESET_ALOKASI_TIDAK_LENGKAP",
]);

/**
 * RULE 3. The FLATTENING codes themselves never travel, or a two-layer chain
 * would surface an intermediate "something failed" as though it were a cause.
 *
 * modules/angsuran wraps the ledger as `JURNAL_GAGAL` and modules/pumk wraps
 * modules/angsuran as `SETORAN_GAGAL`. Letting the inner wrapper out would
 * replace one anonymous 409 with a different anonymous 409, which is motion
 * rather than progress. What travels is the ORIGINAL refusal, because both
 * layers now re-raise instead of wrapping when the rules here allow it.
 */
const KODE_PEMBUNGKUS: ReadonlySet<string> = new Set([
  "JURNAL_GAGAL",
  "SETORAN_GAGAL",
  "JADWAL_GAGAL",
]);

/**
 * The refusal a module may re-raise as-is, or null when it must be flattened
 * into the module's own code with the cause parked in `penyebabDb`.
 *
 * Anything that is not a REGISTERED coded domain error returns null. That is
 * the same allowlist core/http.ts matches on, and it is what keeps an unrelated
 * library error that happens to carry a `kode` field from being re-raised as a
 * business refusal.
 */
export function sebabYangBolehLolos(err: unknown): SebabBerkode | null {
  if (!(err instanceof Error) || !NAMA_ERROR_BERKODE.has(err.name)) return null;
  const kode = (err as { kode?: unknown }).kode;
  if (typeof kode !== "string" || kode === "") return null;
  if (KODE_PEMBUNGKUS.has(kode)) return null;
  if (KODE_BENTUK_INTERNAL.has(kode)) return null;
  if (ARTI_HTTP_TERTAHAN.has(httpUntukKodeDomain(kode))) return null;
  return err as SebabBerkode;
}

/** The raw text a flattened refusal parks in `penyebabDb`, for the server log only. */
export function penyebabTeks(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
