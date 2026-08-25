// Typed client for the Non PUMK module, spec 9.2: the grant and social aid
// line. Hibah and bantuan sosial or lingkungan, no repayment, but a mandatory
// LPJ.
//
// TYPES COME FROM THE CONTRACT AND FROM THE READ MODEL, NOT FROM THIS FILE.
// The stored shapes are imported, type only, from
// apps/api/src/modules/nonpumk/contract.ts and the list and detail shapes from
// that module's own ./baca.ts, exactly the way ./pumk.ts imports the PUMK
// contract: `import type` is erased by Bun's transpiler, so no server code, no
// pg and no Redis client reaches the bundle, and a drift on either side
// becomes a type error here instead of a wrong screen.
//
// NOT ONE SHAPE IS REDECLARED HERE. An earlier draft of this file wrote its
// own `BarisProposalNonPumk` because the module had no routes yet, and that is
// precisely how a screen ends up rendering a field the server never sends. The
// paths and the payload names below are read off
// apps/api/src/modules/nonpumk/routes.ts, which is mounted at `/nonpumk` in
// apps/api/src/core/app.ts.
//
// WHEN A CALL FAILS, THE PAGE SAYS SO. There is no stub, no sample row and no
// offline mode anywhere behind these functions: a fixture may stand in for a
// FAILURE, never for a VALIDATION.
import type {
  BarisMonitoringLpjBerlabel,
  BatasanNonPumk,
  BarisProposalNonPumk,
  DetailProposalNonPumk,
  OpsiReferensi,
  OpsiSdg,
} from "@krakatausteel/api/src/modules/nonpumk/baca";
import type {
  AjukanLpjInput,
  AksiNonPumk,
  BuatProposalNonPumkInput,
  EmberUmurLpj,
  FilterMonitoringLpj,
  FilterProposalNonPumk,
  InputPenilaianInput,
  KeputusanApprovalNonPumkInput,
  KeputusanApproverNonPumk,
  KeputusanCheckerNonPumk,
  Lpj,
  Penilaian,
  Penyaluran,
  PenyaluranInput,
  ProposalNonPumk,
  ReviewNonPumkInput,
  RingkasanProposal,
  SdgInput,
  SdgProposal,
  StatusLpj,
  StatusProposalNonPumk,
  SumberPengajuanNonPumk,
  TolakLpjInput,
  TransisiProposalNonPumk,
  Uang,
  VerifikasiLpjInput,
} from "@krakatausteel/api/src/modules/nonpumk/contract";
import { apiGet, apiPost, buildQuery } from "./http";

export type {
  AjukanLpjInput,
  AksiNonPumk,
  BarisMonitoringLpjBerlabel,
  BarisProposalNonPumk,
  BatasanNonPumk,
  BuatProposalNonPumkInput,
  DetailProposalNonPumk,
  EmberUmurLpj,
  FilterMonitoringLpj,
  FilterProposalNonPumk,
  InputPenilaianInput,
  KeputusanApprovalNonPumkInput,
  KeputusanApproverNonPumk,
  KeputusanCheckerNonPumk,
  Lpj,
  OpsiReferensi,
  OpsiSdg,
  Penilaian,
  Penyaluran,
  PenyaluranInput,
  ProposalNonPumk,
  ReviewNonPumkInput,
  RingkasanProposal,
  SdgInput,
  SdgProposal,
  StatusLpj,
  StatusProposalNonPumk,
  SumberPengajuanNonPumk,
  TolakLpjInput,
  TransisiProposalNonPumk,
  Uang,
  VerifikasiLpjInput,
};

interface Daftar<T> {
  data: T[];
}

const proposal = (id: string) => `/nonpumk/proposal/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// Referensi: what a form has to load before it can be filled in
// ---------------------------------------------------------------------------

/**
 * Spec 5's bounds for Non PUMK. Every figure is a `konfigurasi` row, never a
 * literal, which is also why this call can legitimately fail with a readable
 * reason when a row is missing. The proposal form stays CLOSED when it does:
 * rejecting a value after a whole form has been typed is bad, accepting one
 * that was never checked against a limit is worse.
 */
export function batasanNonPumk(): Promise<BatasanNonPumk> {
  return apiGet("/nonpumk/batasan");
}

export function daftarBidang(): Promise<Daftar<OpsiReferensi>> {
  return apiGet("/nonpumk/bidang");
}

export function daftarSdg(): Promise<Daftar<OpsiSdg>> {
  return apiGet("/nonpumk/sdg");
}

/**
 * The expense accounts a penyaluran may name.
 *
 * Spec 6.4's PENYALURAN_NON_PUMK mapping row carries `debit_dari_payload =
 * true` because the debit is "Beban Penyaluran Non PUMK (PER BIDANG)". The
 * account therefore arrives on the form and is handed to the ledger engine;
 * the module never names an account pair of its own (invariant 11).
 */
export function daftarAkunBeban(): Promise<Daftar<OpsiReferensi>> {
  return apiGet("/nonpumk/akun-beban");
}

// ---------------------------------------------------------------------------
// Proposal and state machine
// ---------------------------------------------------------------------------

export function daftarProposal(
  filter: FilterProposalNonPumk,
): Promise<Daftar<BarisProposalNonPumk>> {
  return apiGet(
    `/nonpumk/proposal${buildQuery({
      cabangId: filter.cabangId,
      bidangId: filter.bidangId,
      sdgId: filter.sdgId,
      status: filter.status,
      sumberPengajuan: filter.sumberPengajuan,
      dariTanggal: filter.dariTanggal,
      sampaiTanggal: filter.sampaiTanggal,
      cari: filter.cari,
    })}`,
  );
}

export function detailProposal(proposalId: string): Promise<DetailProposalNonPumk> {
  return apiGet(proposal(proposalId));
}

export function timelineProposal(proposalId: string): Promise<Daftar<TransisiProposalNonPumk>> {
  return apiGet(`${proposal(proposalId)}/timeline`);
}

export function buatProposal(input: BuatProposalNonPumkInput): Promise<ProposalNonPumk> {
  return apiPost("/nonpumk/proposal", input);
}

export function ajukanPenilaian(
  proposalId: string,
  catatan: string | null,
): Promise<ProposalNonPumk> {
  return apiPost(`${proposal(proposalId)}/ajukan-penilaian`, { catatan });
}

export function inputPenilaian(input: InputPenilaianInput): Promise<ProposalNonPumk> {
  return apiPost(`${proposal(input.proposalId)}/penilaian`, input);
}

export function review(input: ReviewNonPumkInput): Promise<ProposalNonPumk> {
  return apiPost(`${proposal(input.proposalId)}/review`, input);
}

/**
 * The approval. `jumlahDisetujui` may be LOWER than what was asked for and
 * never higher: the cut is spec 9.2's own ("ini sering terjadi di praktik")
 * and a raise is refused by the engine with NILAI_DISETUJUI_MELEBIHI_PENGAJUAN.
 * The screen compares the two before the click; the engine is the control.
 */
export function putuskanPersetujuan(
  input: KeputusanApprovalNonPumkInput,
): Promise<ProposalNonPumk> {
  return apiPost(`${proposal(input.proposalId)}/persetujuan`, input);
}

// ---------------------------------------------------------------------------
// Penyaluran bertahap (spec 9.2)
// ---------------------------------------------------------------------------

/**
 * Records ONE termin of a staged disbursement that already happened at a
 * counter or through a bank, and posts the PENYALURAN_NON_PUMK journal that
 * recognises it. It instructs no payment.
 *
 * The termin that would take the running total past `jumlahDisetujui` is
 * refused with PLAFON_PENYALURAN_TERLAMPAUI, ahead of the deferred
 * TJSL-NPK-002 trigger. A termin landing EXACTLY on the ceiling is allowed and
 * one sen over it is not, which is why the screen compares in integer sen and
 * never on a rounded figure.
 */
export function catatPenyaluran(input: PenyaluranInput): Promise<Penyaluran> {
  return apiPost(`${proposal(input.proposalId)}/penyaluran`, input);
}

/** DISALURKAN to MENUNGGU_LPJ. Closes the staging and starts the LPJ clock. */
export function tutupPenyaluran(
  proposalId: string,
  catatan: string | null,
): Promise<ProposalNonPumk> {
  return apiPost(`${proposal(proposalId)}/tutup-penyaluran`, { catatan });
}

// ---------------------------------------------------------------------------
// LPJ (spec 9.2)
// ---------------------------------------------------------------------------

/**
 * Files the LPJ. POSTS NO JOURNAL: the money comes back when the LPJ is
 * ACCEPTED, not when it is filed, so an LPJ that can still be rejected has not
 * moved the ledger.
 *
 * `jumlahSisaDikembalikan` is deliberately NOT a field here. The engine
 * computes it as disbursed minus realised, so the two figures cannot disagree.
 * The form shows the remainder it expects, in sen, and the engine's answer is
 * the one that is stored.
 */
export function ajukanLpj(input: AjukanLpjInput): Promise<Lpj> {
  return apiPost(`${proposal(input.proposalId)}/lpj`, input);
}

/**
 * Accepts the LPJ, and WHEN AND ONLY WHEN there is a remainder posts
 * PENGEMBALIAN_SISA_NON_PUMK for it. `akunKasId` says where the returned money
 * landed and is required by the engine exactly when there is something to
 * return.
 *
 * Requires `nonpumk.lpj.verifikasi`, held by the CHECKER and inherited by
 * Admin Cabang and Admin Pusat. It is deliberately not `nonpumk.lpj`, which is
 * the Maker's filing code: the author of a report must not be the person who
 * signs it off.
 */
export function verifikasiLpj(input: VerifikasiLpjInput): Promise<Lpj> {
  return apiPost(`${proposal(input.proposalId)}/lpj/verifikasi`, input);
}

export function tolakLpj(input: TolakLpjInput): Promise<ProposalNonPumk> {
  return apiPost(`${proposal(input.proposalId)}/lpj/tolak`, input);
}

// ---------------------------------------------------------------------------
// Monitoring LPJ terlambat (spec 9.2)
// ---------------------------------------------------------------------------

/**
 * Spec 9.2: "Dashboard monitoring LPJ yang terlambat, dengan aging (30, 60, 90
 * hari sejak penyaluran)". The buckets are the spec's and are half open on the
 * left, so a grant disbursed exactly 30 days ago is in the 30 to 59 bucket.
 * `terlambat` is a CONFIGURED deadline the engine reads, which is a different
 * question from which bucket a row falls in.
 */
export function monitoringLpj(
  filter: FilterMonitoringLpj,
): Promise<Daftar<BarisMonitoringLpjBerlabel>> {
  return apiGet(
    `/nonpumk/monitoring-lpj${buildQuery({
      cabangId: filter.cabangId,
      bidangId: filter.bidangId,
      emberMinimal: filter.emberMinimal,
      hanyaTerlambat: filter.hanyaTerlambat,
    })}`,
  );
}
