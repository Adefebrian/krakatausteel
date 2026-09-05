// Typed client for the event to journal mapping, ADR 0004 and migration 0036.
// The routes are on /jurnal/mapping, because the table belongs to the journal
// engine: an unknown event code is a bug in that engine, not a configuration
// choice, and only the account it points at is configurable.
//
// ITS OWN FILE, AND NOT PART OF ./jurnal.ts, for the same reason it has its own
// permission on the server. Everything in ./jurnal.ts is a document a Maker
// files and an Approver posts. This is a change to WHAT EVERY FUTURE DOCUMENT
// OF AN EVENT WILL DEBIT AND CREDIT, decided by two people, and it should not
// sit in the same module as "create a cash receipt".
//
// THE SHAPE IS A MAKER-CHECKER AND THE FUNCTIONS SAY SO. There is no
// `ubahMapping`. A change is `ajukan` (file a proposal), then `setujui` or
// `tolak` BY A DIFFERENT PERSON, or `batal` by the author. The server refuses
// a self approval with a segregation of duties refusal and the database
// refuses it again in `trg_ejm_usulan_10_sod`.
import type {
  AjukanMappingBody,
  MappingTampil,
  UsulanTampil,
} from "@krakatausteel/api/src/modules/jurnal/mapping";
import { apiGet, apiPost, buildQuery } from "./http";

export type { AjukanMappingBody, MappingTampil, UsulanTampil };

/** The one permission this whole surface is behind. Mirrors the server. */
export const IZIN_MAPPING = "konfigurasi.mapping";

/** Proposal states, in the order a proposal moves through them. */
export const STATUS_USULAN = ["DIAJUKAN", "DISETUJUI", "DITOLAK", "DIBATALKAN"] as const;
export type StatusUsulan = (typeof STATUS_USULAN)[number];

export interface DaftarMapping {
  data: MappingTampil[];
  /**
   * Events this entity KNOWS but has no mapping in force for. A non empty list
   * means those events can no longer post at all, which is why it is answered
   * next to the mappings rather than left to be noticed.
   */
  tanpaPemetaan: string[];
}

/** The mappings in force. One active row per event, by a partial unique index. */
export function daftarMapping(): Promise<DaftarMapping> {
  return apiGet("/jurnal/mapping");
}

export function daftarUsulanMapping(status?: string | null): Promise<{ data: UsulanTampil[] }> {
  return apiGet(`/jurnal/mapping/usulan${buildQuery({ status })}`);
}

/**
 * Files a proposal. It changes NOTHING: the posting path reads only the active
 * row in `event_jurnal_mapping`, and a pending proposal lives in its own table
 * that the engine cannot see.
 *
 * `alasan` is mandatory and at least ten characters, because the mapping row
 * does not store its own reason and the approver is being asked to agree with
 * one.
 */
export function ajukanMapping(body: AjukanMappingBody): Promise<UsulanTampil> {
  return apiPost("/jurnal/mapping/usulan", body);
}

/** A DIFFERENT person's act. Refused for the proposer, by service and trigger. */
export function setujuiUsulan(id: string, catatan: string | null): Promise<UsulanTampil> {
  return apiPost(`/jurnal/mapping/usulan/${encodeURIComponent(id)}/setujui`, { catatan });
}

/** Also a different person's act. The proposer withdraws instead, with `batal`. */
export function tolakUsulan(id: string, catatan: string | null): Promise<UsulanTampil> {
  return apiPost(`/jurnal/mapping/usulan/${encodeURIComponent(id)}/tolak`, { catatan });
}

/** Withdrawal, and it belongs to the author alone. Anyone else rejects it. */
export function batalUsulan(id: string): Promise<UsulanTampil> {
  return apiPost(`/jurnal/mapping/usulan/${encodeURIComponent(id)}/batal`);
}

/**
 * The frozen "before", stored on the proposal at the moment it was filed.
 *
 * It is typed `unknown` on the wire because the column is jsonb, and it is
 * narrowed HERE rather than cast at each call site. Null means the event had
 * no mapping in force when the proposal was filed, which is a real and
 * different case from "we could not read it".
 */
export function mappingSebelum(usulan: UsulanTampil): MappingTampil | null {
  const nilai = usulan.mappingSebelum;
  if (typeof nilai !== "object" || nilai === null) return null;
  const row = nilai as Partial<MappingTampil>;
  if (typeof row.eventCode !== "string") return null;
  return row as MappingTampil;
}
