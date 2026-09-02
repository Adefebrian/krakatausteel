// Typed client for the closing module, spec 8 and spec 9.3's two Admin
// screens, plus the period list the reopen is performed from.
//
// TYPES COME FROM THE CONTRACT, NOT FROM THIS FILE. Every shape below is
// imported, type only, from apps/api/src/modules/closing/contract.ts and from
// that module's own ./baca.ts, exactly as ./rka.ts, ./pumk.ts and ./nonpumk.ts
// already do. `import type` is erased by Bun's transpiler, so no server code,
// no pg and no Redis client reaches the bundle, and a drift on either side
// becomes a type error here instead of a wrong screen. Nothing is redeclared.
//
// THE PATHS ARE READ OFF apps/api/src/modules/closing/routes.ts, which
// core/app.ts mounts at `/closing`. Fourteen endpoints, and four things about
// them that this file keeps visible rather than smoothing away:
//
//   THE PREVIEW AND THE COMMIT ARE TWO FUNCTIONS, NEVER ONE WITH A FLAG. The
//   server separated them by path, by status code and by a literal type
//   (`tersimpan: false` against `tersimpan: true`) precisely so the two cannot
//   be confused, and a `{ commit?: boolean }` parameter here would hand that
//   back: one typo would write a month. `pratinjauKolektibilitas` writes
//   nothing; `jalankanKolektibilitas` writes the snapshots.
//
//   `cabangId` IS A NARROWING FILTER AND NEVER AUTHORITY. The engine intersects
//   it with the branches the session resolved and REFUSES one outside that
//   scope rather than quietly answering with less. An absent `cabangId` means
//   every branch in scope, which is spec 8.1's opening line, so the key is
//   OMITTED rather than sent as null when the screen has no branch filter:
//   `JalankanKolektibilitasInput` reads `cabangId: null` as an explicit choice.
//
//   `konfirmasiKasNegatif` IS SENT ONLY WHEN THE OPERATOR CONFIRMED IT. It is
//   spec 8.4 check 8's "wajib dikonfirmasi user" and it lands in the audit log,
//   so it is a parameter of `tutupPeriode` and never a default this file
//   supplies. It is NOT an override of a failed check, and there is no
//   parameter here that is.
//
//   NOTHING RETRIES. `tutupPeriode` holds a row lock on the period to COMMIT so
//   two concurrent closes produce exactly one success; a retry here would hand
//   the loser of that race a second attempt against a period the winner already
//   closed. `../api/http.ts` does not retry, and nothing below adds one.
import type {
  BarisAkrual,
  BarisKolektibilitas,
  DasarPerhitunganPenyisihan,
  DaftarPrasyarat,
  HasilAkrual,
  HasilKolektibilitas,
  HasilPrasyarat,
  HasilTutupPeriode,
  KelasKolektibilitas,
  KodePrasyarat,
  KontribusiJurnalPenyisihan,
  MetodePengakuanJasa,
  ModePenyisihan,
  PenyisihanPeriode,
  PeriodeClosing,
  PreviewKolektibilitas,
  Rate,
  RingkasanKelas,
  RiwayatRunKolektibilitas,
  SaldoAkunPeriode,
  SelKematriks,
  StatusPeriode,
  StatusPrasyarat,
  StatusRunKolektibilitas,
  SumberRate,
  Uang,
} from "@krakatausteel/api/src/modules/closing/contract";
import type {
  KapabilitasClosing,
  OpsiCabangClosing,
  OpsiPeriodeClosing,
  ReferensiClosing,
} from "@krakatausteel/api/src/modules/closing/baca";
import { apiGet, apiPost, buildQuery } from "./http";

export type {
  BarisAkrual,
  BarisKolektibilitas,
  DasarPerhitunganPenyisihan,
  DaftarPrasyarat,
  HasilAkrual,
  HasilKolektibilitas,
  HasilPrasyarat,
  HasilTutupPeriode,
  KapabilitasClosing,
  KelasKolektibilitas,
  KodePrasyarat,
  KontribusiJurnalPenyisihan,
  MetodePengakuanJasa,
  ModePenyisihan,
  OpsiCabangClosing,
  OpsiPeriodeClosing,
  PenyisihanPeriode,
  PeriodeClosing,
  PreviewKolektibilitas,
  Rate,
  ReferensiClosing,
  RingkasanKelas,
  RiwayatRunKolektibilitas,
  SaldoAkunPeriode,
  SelKematriks,
  StatusPeriode,
  StatusPrasyarat,
  StatusRunKolektibilitas,
  SumberRate,
  Uang,
};

/** The list envelope the collection endpoints in this module answer with. */
interface Daftar<T> {
  data: T[];
}

/** A run scope: absent means every branch the session resolved. */
export interface LingkupRun {
  cabangId?: string | null;
}

/**
 * The narrowing filter as a body. Built here once so no screen sends
 * `cabangId: null` by accident: absent and null are two different requests.
 */
function badan({ cabangId }: LingkupRun): Record<string, unknown> {
  return cabangId === undefined || cabangId === null ? {} : { cabangId };
}

// ---------------------------------------------------------------------------
// Reads. Every one of these is gated by `admin.closing.view` on the server,
// which is the code an Auditor holds and which can run nothing at all.
// ---------------------------------------------------------------------------

/**
 * What both closing screens load before an operator picks anything: the
 * branches this caller may close for, whether Semua Cabang is among them, and
 * the spec 5.6 accounting policies in force. The policies are READ from
 * `konfigurasi`, so a screen greys the reopen control exactly when the engine
 * would refuse it and describes the accrual as skipped exactly when spec 8.3
 * would skip it.
 */
export function referensiClosing(): Promise<ReferensiClosing> {
  return apiGet<ReferensiClosing>("/closing/referensi");
}

export interface FilterPeriode {
  tahun?: number | null;
  status?: StatusPeriode | null;
}

/** The month picker, newest first, each row carrying who closed it and when. */
export function daftarPeriodeClosing(filter: FilterPeriode = {}): Promise<Daftar<OpsiPeriodeClosing>> {
  return apiGet<Daftar<OpsiPeriodeClosing>>(
    `/closing/periode${buildQuery({ tahun: filter.tahun ?? null, status: filter.status ?? null })}`,
  );
}

export function bacaPeriodeClosing(periodeId: string): Promise<OpsiPeriodeClosing> {
  return apiGet<OpsiPeriodeClosing>(`/closing/periode/${periodeId}`);
}

/**
 * Spec 8.4's ten prerequisites, all ten, every time, in spec order. A GET and a
 * pure one: the engine writes nothing, not even a CLOSING_IN_PROGRESS marker,
 * so a screen may load this on every render without turning a refresh into a
 * transaction.
 */
export function prasyaratClosing(periodeId: string): Promise<DaftarPrasyarat> {
  return apiGet<DaftarPrasyarat>(`/closing/periode/${periodeId}/prasyarat`);
}

/**
 * The frozen trial balance of a closed period, invariant 14's evidence. Read
 * rather than recomputed, which is why a reprint of a past month reproduces it
 * exactly.
 */
export function saldoPeriodeClosing(
  periodeId: string,
  filter: { cabangId?: string | null; akunId?: string | null } = {},
): Promise<Daftar<SaldoAkunPeriode>> {
  return apiGet<Daftar<SaldoAkunPeriode>>(
    `/closing/periode/${periodeId}/saldo${buildQuery({
      cabangId: filter.cabangId ?? null,
      akunId: filter.akunId ?? null,
    })}`,
  );
}

/** Which classification runs happened for this month, when, by whom, over how
 *  many akad. Read only, so an Auditor sees that it ran without running it. */
export function riwayatKolektibilitas(
  periodeId: string,
): Promise<Daftar<RiwayatRunKolektibilitas>> {
  return apiGet<Daftar<RiwayatRunKolektibilitas>>(
    `/closing/periode/${periodeId}/kolektibilitas/riwayat`,
  );
}

/**
 * The STORED snapshot, which is what the reports read, and which carries the
 * rate and the dasar perhitungan ACTUALLY USED per akad (migrations 0024 and
 * 0025). That provenance is on the row so a later configuration change cannot
 * alter a closed period's figures, and so a screen can say which policy row
 * produced a classification.
 */
export function snapshotKolektibilitas(
  periodeId: string,
  filter: { cabangId?: string | null } = {},
): Promise<Daftar<BarisKolektibilitas>> {
  return apiGet<Daftar<BarisKolektibilitas>>(
    `/closing/periode/${periodeId}/kolektibilitas/snapshot${buildQuery({
      cabangId: filter.cabangId ?? null,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Spec 8.1's mandatory preview. Runs the whole calculation, returns the
 * migration matrix, and WRITES NOTHING: no snapshot, no run row, no mitra
 * flipped to BERMASALAH. Answers `tersimpan: false`, a literal type, so its
 * result can never be assigned where a committed one is expected.
 */
export function pratinjauKolektibilitas(
  periodeId: string,
  lingkup: LingkupRun = {},
): Promise<PreviewKolektibilitas> {
  return apiPost<PreviewKolektibilitas>(
    `/closing/periode/${periodeId}/kolektibilitas/pratinjau`,
    badan(lingkup),
  );
}

/**
 * Spec 8.1 steps 1 to 7, committed. Idempotent by design (invariant 13): a
 * re-run for the same scope deletes that period's snapshots and writes them
 * again inside one transaction, so a second run changes neither the snapshot
 * count nor the journal count.
 */
export function jalankanKolektibilitas(
  periodeId: string,
  lingkup: LingkupRun = {},
): Promise<HasilKolektibilitas> {
  return apiPost<HasilKolektibilitas>(
    `/closing/periode/${periodeId}/kolektibilitas`,
    badan(lingkup),
  );
}

/** Spec 8.2 steps 1 to 3 without posting: the movement before it becomes a
 *  journal. `id` and `jurnalId` come back null, which is the shape saying no
 *  row was written. */
export function pratinjauPenyisihan(
  periodeId: string,
  lingkup: LingkupRun = {},
): Promise<Daftar<PenyisihanPeriode>> {
  return apiPost<Daftar<PenyisihanPeriode>>(
    `/closing/periode/${periodeId}/penyisihan/pratinjau`,
    badan(lingkup),
  );
}

/** Spec 8.2 steps 4 and 5. One journal per branch, keyed for idempotency, and
 *  a zero movement posts nothing and is not an error. */
export function jalankanPenyisihan(
  periodeId: string,
  lingkup: LingkupRun = {},
): Promise<Daftar<PenyisihanPeriode>> {
  return apiPost<Daftar<PenyisihanPeriode>>(
    `/closing/periode/${periodeId}/penyisihan`,
    badan(lingkup),
  );
}

/**
 * Spec 8.3. The method is READ from `akuntansi.metode_pengakuan_jasa_adm` and
 * there is deliberately no parameter for it: under CASH_BASIS the run writes
 * nothing, posts nothing and answers `dilewati: true` with the method that
 * produced that outcome, so "policy says do nothing" can never be read as
 * "something went wrong and produced nothing".
 */
export function jalankanAkrual(
  periodeId: string,
  lingkup: LingkupRun = {},
): Promise<HasilAkrual> {
  return apiPost<HasilAkrual>(`/closing/periode/${periodeId}/akrual`, badan(lingkup));
}

/**
 * THE CLOSE. Re-runs the whole checklist inside the transaction, flips the
 * period to CLOSED with `closed_by` and `closed_at`, stamps the report template
 * it was closed under, and freezes `saldo_akun_periode`.
 *
 * `konfirmasiKasNegatif` is the only field the route accepts. It confirms check
 * 8's PERINGATAN and nothing else: it does not override a GAGAL check, and
 * there is no parameter that does.
 */
export function tutupPeriode(
  periodeId: string,
  input: { konfirmasiKasNegatif?: boolean } = {},
): Promise<HasilTutupPeriode> {
  return apiPost<HasilTutupPeriode>(`/closing/periode/${periodeId}/tutup`, {
    konfirmasiKasNegatif: input.konfirmasiKasNegatif ?? false,
  });
}

/**
 * THE REOPEN, the heaviest privilege in the system. Needs
 * `admin.periode.reopen` (Admin Pusat and nobody else, not even the Approver
 * who may close), a written reason of at least ten characters, the
 * `akuntansi.izinkan_reopen_periode` policy, and the target being the LATEST
 * closed period. It DELETES that period's frozen balances, which is safe only
 * because they are derived data regenerable from the ledger.
 */
export function bukaKembaliPeriode(
  periodeId: string,
  input: { alasan: string },
): Promise<PeriodeClosing> {
  return apiPost<PeriodeClosing>(`/closing/periode/${periodeId}/buka`, {
    alasan: input.alasan,
  });
}

/** The floor the route imposes on a reopen reason, mirrored so the form can
 *  say so before the request rather than after the 400. */
export const MIN_ALASAN_REOPEN = 10;
export const MAX_ALASAN_REOPEN = 2000;
