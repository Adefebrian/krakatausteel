// Typed client for the RKA module, spec 9.3, and for report 24 which lives
// under the same prefix.
//
// TYPES COME FROM THE CONTRACT, NOT FROM THIS FILE. Every shape below is
// imported, type only, from apps/api/src/modules/rka/contract.ts and from that
// module's own ./baca.ts, the way ./pumk.ts and ./nonpumk.ts already do.
// `import type` is erased by Bun's transpiler, so no server code, no pg and no
// Redis client reaches the bundle, and a drift on either side becomes a type
// error here instead of a wrong screen. Nothing is redeclared.
//
// THE PATHS ARE READ OFF apps/api/src/modules/rka/routes.ts, which core/app.ts
// mounts at `/rka`. Two of them are ordered ahead of `/:id` on the server, and
// the shapes below mirror that: `/rka/laporan/realisasi` and `/rka/baseline`
// are their own functions rather than an id that happens to spell a word.
//
// TWO ABSENCES THAT ARE NOT THE SAME REQUEST. On `GET /rka`, an absent
// `cabangId` means "no branch filter" and `konsolidasi=true` means "entity
// wide budgets only" (`cabang_id IS NULL`). A query string cannot carry that
// difference on its own, so the server made the consolidated case its own
// boolean; `daftarRka` below keeps the two apart for the same reason, and
// sends neither key when the screen has no branch filter at all.
import type {
  BarisRka,
  BarisRkaInput,
  BarisRkaVsRealisasi,
  BuatRevisiInput,
  BuatRkaInput,
  DimensiRka,
  FilterLaporanRka,
  JenisRka,
  LaporanRkaVsRealisasi,
  MetodeRealisasi,
  ModeLaporanRka,
  Persen,
  Rka,
  RkaLengkap,
  SetujuiRkaInput,
  StatusRka,
  SumberPeriode,
  SumberRealisasi,
  TotalRkaVsRealisasi,
  Uang,
} from "@krakatausteel/api/src/modules/rka/contract";
import type {
  OpsiCabangRka,
  OpsiDimensiRka,
  OpsiPeriodeRka,
  ReferensiRka,
} from "@krakatausteel/api/src/modules/rka/baca";
import { apiGet, apiPost, buildQuery } from "./http";

export type {
  BarisRka,
  BarisRkaInput,
  BarisRkaVsRealisasi,
  BuatRevisiInput,
  BuatRkaInput,
  DimensiRka,
  FilterLaporanRka,
  JenisRka,
  LaporanRkaVsRealisasi,
  MetodeRealisasi,
  ModeLaporanRka,
  OpsiCabangRka,
  OpsiDimensiRka,
  OpsiPeriodeRka,
  Persen,
  ReferensiRka,
  Rka,
  RkaLengkap,
  SetujuiRkaInput,
  StatusRka,
  SumberPeriode,
  SumberRealisasi,
  TotalRkaVsRealisasi,
  Uang,
};

/** The list envelope every collection endpoint in this API answers with. */
interface Daftar<T> {
  data: T[];
}

/**
 * What an entry screen loads before an operator can type a number: the
 * dimension this budget type is filed against, its rows, the branches this
 * caller may budget for, and the month the financial year starts in.
 */
export function referensiRka(jenis: JenisRka): Promise<ReferensiRka> {
  return apiGet<ReferensiRka>(`/rka/referensi${buildQuery({ jenis })}`);
}

/** Accounting periods, newest first, each with the status that decides whether
 *  report 24 will read a live figure or a frozen one. */
export function periodeRka(tahun?: number | null): Promise<Daftar<OpsiPeriodeRka>> {
  return apiGet<Daftar<OpsiPeriodeRka>>(`/rka/periode${buildQuery({ tahun })}`);
}

export interface FilterDaftarRka {
  tahun?: number | null;
  jenis?: JenisRka | null;
  status?: StatusRka | null;
  /** A branch id narrows the list. It never widens it: the engine intersects
   *  it with the branches the session resolved. */
  cabangId?: string | null;
  /** Entity wide budgets only (`cabang_id IS NULL`). Mutually exclusive with
   *  `cabangId`, exactly as the route reads it. */
  konsolidasi?: boolean;
}

export function daftarRka(filter: FilterDaftarRka = {}): Promise<Daftar<Rka>> {
  const query = filter.konsolidasi
    ? { tahun: filter.tahun, jenis: filter.jenis, status: filter.status, konsolidasi: true }
    : {
        tahun: filter.tahun,
        jenis: filter.jenis,
        status: filter.status,
        cabangId: filter.cabangId,
      };
  return apiGet<Daftar<Rka>>(`/rka${buildQuery(query)}`);
}

/**
 * The approved version in force for a scope, or null. Spec 9.3's "baseline
 * pembanding": the document every variance in the system is measured against.
 */
export function baselineRka(input: {
  tahun: number;
  jenis: JenisRka;
  cabangId?: string | null;
}): Promise<{ data: Rka | null }> {
  return apiGet<{ data: Rka | null }>(
    `/rka/baseline${buildQuery({
      tahun: input.tahun,
      jenis: input.jenis,
      cabangId: input.cabangId ?? null,
    })}`,
  );
}

export function bacaRka(rkaId: string): Promise<RkaLengkap> {
  return apiGet<RkaLengkap>(`/rka/${rkaId}`);
}

/** Creates version 1 for (cabang, tahun, jenis) as a DRAFT. `cabangId: null`
 *  is a consolidated, entity wide budget, not a missing field. */
export function buatRka(input: BuatRkaInput): Promise<RkaLengkap> {
  return apiPost<RkaLengkap>("/rka", input);
}

/**
 * REPLACES the grid of a DRAFT version, whole. Not a per row patch: the server
 * refuses a partial update for the reason it refuses editing an approved
 * version, and a row that survives a revision nobody meant to keep is how a
 * budget quietly stops matching what was signed.
 */
export function simpanBarisRka(
  rkaId: string,
  baris: readonly BarisRkaInput[],
): Promise<RkaLengkap> {
  return apiPost<RkaLengkap>(`/rka/${rkaId}/baris`, { baris });
}

/** DRAFT to DISETUJUI, and the outgoing baseline to REVISI, in one
 *  transaction. Needs `admin.rka.approve`, which is not `admin.rka`. */
export function setujuiRka(input: SetujuiRkaInput): Promise<Rka> {
  return apiPost<Rka>(`/rka/${input.rkaId}/setujui`, {
    tanggal: input.tanggal ?? null,
    catatan: input.catatan ?? null,
  });
}

/**
 * Opens the NEXT version as a DRAFT from an approved one. The source version
 * is left exactly as it is, still approved and still the baseline, until the
 * new one is approved in its turn.
 */
export function buatRevisiRka(input: BuatRevisiInput): Promise<RkaLengkap> {
  return apiPost<RkaLengkap>(`/rka/${input.rkaId}/revisi`, {
    keterangan: input.keterangan ?? null,
    salinBaris: input.salinBaris ?? true,
  });
}

/**
 * Report 24. There is deliberately no parameter for WHERE the realisation is
 * read from: an open month is read live from the ledger view and a closed one
 * from the frozen trial balance, the server decides that per month, and the
 * answer carries `sumberPerPeriode` so the page can say which source answered.
 */
export function laporanRkaVsRealisasi(
  filter: FilterLaporanRka,
): Promise<LaporanRkaVsRealisasi> {
  return apiGet<LaporanRkaVsRealisasi>(
    `/rka/laporan/realisasi${buildQuery({
      tahun: filter.tahun,
      jenis: filter.jenis,
      cabangId: filter.cabangId ?? null,
      versi: filter.versi ?? null,
      rkaId: filter.rkaId ?? null,
      mode: filter.mode,
      bulan: filter.bulan,
    })}`,
  );
}

/** Which source report 24 WOULD use for one period, without running it. */
export function metodeRealisasi(input: {
  periodeId: string;
  jenis: JenisRka;
}): Promise<{ metode: MetodeRealisasi }> {
  return apiGet<{ metode: MetodeRealisasi }>(
    `/rka/laporan/metode-realisasi${buildQuery(input)}`,
  );
}
