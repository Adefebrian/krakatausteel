// Typed client for the STAFF half of the portal, spec 9.5.
//
// IT IS NOT ./portal-publik.ts AND THE TWO MUST NEVER MERGE. ADR 0019 keeps
// three principals apart at every level the server has: an anonymous caller
// with no session, a mitra with its own cookie and its own store, and a staff
// session. `./portal-publik.ts` is the anonymous surface, mounted under
// ../portal/, and it never sends a staff cookie. Everything below runs on the
// staff session and is gated by `portal.view` or `portal.konversi`. Sharing one
// client between them would attach a staff cookie to a public form, which is
// the reunification the split exists to prevent.
//
// FOUR ENDPOINTS, THREE MODULES, and that is not an accident of layout:
//
//   GET  /portal/submission        the intake queue        portal.view
//   GET  /portal/submission/:id    one submission          portal.view
//   POST /portal/submission/:id/tindak   verify or refuse  portal.konversi
//   POST /pumk/portal/konversi     BECOME A PROPOSAL       portal.konversi
//
// The last one lives on modules/pumk, not on modules/portal, and the portal
// router refuses `DIKONVERSI` as a `tindakan` on purpose: converting is the
// only act that can create the proposal that status claims exists, so it is
// performed by the module that owns proposals. `konversiSubmissionPortal` is
// re-exported from ./pumk.ts here rather than re-declared, so the conversion
// screen imports one module and there is still exactly one definition of it.
import type {
  DetailSubmission,
  JenisPengajuan,
  RingkasanSubmission,
  StatusSubmission,
  TindakanPetugas,
} from "@krakatausteel/api/src/modules/portal/contract";
import type { HasilBuatAkun } from "@krakatausteel/api/src/modules/mitra/contract";
import { apiGet, apiPost, buildQuery } from "./http";

export type {
  DetailSubmission,
  HasilBuatAkun,
  JenisPengajuan,
  RingkasanSubmission,
  StatusSubmission,
  TindakanPetugas,
};

export { konversiSubmissionPortal } from "./pumk";

interface Daftar<T> {
  data: T[];
}

export const STATUS_SUBMISSION = ["BARU", "DIPROSES", "DIKONVERSI", "DITOLAK"] as const;

export const LABEL_STATUS_SUBMISSION: Record<string, string> = {
  BARU: "Baru masuk",
  DIPROSES: "Sedang diproses",
  DIKONVERSI: "Sudah dikonversi",
  DITOLAK: "Ditolak",
};

/** The server's own ceiling, restated so a page can say the list is capped. */
export const BATAS_BARIS_SUBMISSION = 500;

export interface FilterSubmissionWeb {
  jenis?: JenisPengajuan | null;
  status?: StatusSubmission | null;
  noTiket?: string | null;
  batasBaris?: number | null;
}

/** The officer's intake queue. Scoped to the session's entity by the engine. */
export function daftarSubmission(
  filter: FilterSubmissionWeb = {},
): Promise<Daftar<RingkasanSubmission>> {
  return apiGet(
    `/portal/submission${buildQuery({
      jenis: filter.jenis ?? null,
      status: filter.status ?? null,
      noTiket: filter.noTiket ?? null,
      batasBaris: filter.batasBaris ?? null,
    })}`,
  );
}

/** One submission with the applicant's own form and the documents they named. */
export function detailSubmission(id: string): Promise<DetailSubmission> {
  return apiGet(`/portal/submission/${encodeURIComponent(id)}`);
}

/**
 * Verify or refuse. `DIKONVERSI` is not reachable here and the engine refuses
 * it: see this file's header.
 */
export function tindakSubmission(
  id: string,
  input: { tindakan: TindakanPetugas; catatan: string | null },
): Promise<DetailSubmission> {
  return apiPost(`/portal/submission/${encodeURIComponent(id)}/tindak`, input);
}

// ---------------------------------------------------------------------------
// Mitra portal accounts (spec 4.9), the staff side of modules/mitra
// ---------------------------------------------------------------------------

/**
 * Issues a portal account for a mitra, and answers a ONE TIME PASSWORD.
 *
 * IT IS NOT STORED IN CLEARTEXT ANYWHERE, not in the database, not in
 * `audit_log`, and there is no endpoint that reads it back. The account is
 * created with `harus_ganti_sandi` set, so the value can only ever be used to
 * replace itself. The screen that calls this has to treat the answer as the
 * only copy that will ever exist, and say so before the officer navigates away.
 *
 * `konfigurasi.user` AND NOT `portal.view`. The two provisioning routes on
 * modules/mitra sit on the staff guard chain with `konfigurasi.user`, which the
 * Akun Mitra page's own permission (`portal.view`) does not imply. The page
 * therefore opens for everyone who may READ the roster and offers the issuing
 * control only to a holder of `konfigurasi.user`, which is what the server
 * checks again.
 */
export function buatAkunMitra(input: { mitraId: string; email: string }): Promise<HasilBuatAkun> {
  return apiPost("/mitra/akun", input);
}

/** Enables or disables a mitra's portal account. Takes effect at once. */
export function setAktifAkunMitra(
  mitraId: string,
  aktif: boolean,
): Promise<{ mitraId: string; aktif: boolean }> {
  return apiPost(`/mitra/akun/${encodeURIComponent(mitraId)}/status`, { aktif });
}
