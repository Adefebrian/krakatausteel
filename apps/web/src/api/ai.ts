// Typed client for the assistant module, spec 12 Fase 8: document extraction
// and journal anomaly detection.
//
// TYPES ONLY FROM THE CONTRACT, AND THAT IS LOAD BEARING HERE MORE THAN
// ANYWHERE ELSE IN THIS FOLDER. `apps/api/src/modules/ai/contract.ts` imports
// `./service`, so a VALUE import from it would pull the whole engine, the
// provider adapter and the redaction table into the browser bundle. `import
// type` is erased by Bun's transpiler, so nothing below reaches the bundle.
// Anything from that file this app needs as a value is mirrored in
// ../pages/ai/parts.tsx and pinned by ../ai.test.tsx, the same way
// ../portal/formulir.ts mirrors the portal allowlist.
//
// WHAT THIS CLIENT CANNOT DO IS THE POINT. There is no function here that
// saves an extracted field to a proposal, a mitra or a journal, because there
// is no endpoint that does: the engine holds no journal port, no PUMK port and
// no mitra port (contract.ts rule 1). `konfirmasiSaran` records that a person
// decided, on `ai_saran` and nowhere else; the business record is created by
// the Maker submitting the ordinary form in the ordinary module.
//
// THE FLAG-OFF ANSWER IS A 200, NOT AN ERROR. With `AI_ENABLED` unset the
// status endpoint answers `aktif: false`, an extraction answers `status:
// "NONAKTIF"` with an empty field list, and a scan answers `aktif: false` with
// an empty queue. None of those is a failure, so none of them may render as
// one: see ../pages/ai/parts.tsx `AsistenMati`.
import type {
  FieldEkstraksi,
  HasilEkstraksi,
  HasilKonfirmasi,
  JenisDokumen,
  JurnalDitandai,
  KatalogAnomali,
  KeputusanSaran,
  KodeAnomali,
  LaporanAnomali,
  PermintaanEkstraksi,
  StatusAi,
  StatusEkstraksi,
  TemuanAnomali,
  TipeField,
  Uang,
} from "@krakatausteel/api/src/modules/ai/contract";
import { apiGet, apiPost, buildQuery } from "./http";

export type {
  FieldEkstraksi,
  HasilEkstraksi,
  HasilKonfirmasi,
  JenisDokumen,
  JurnalDitandai,
  KatalogAnomali,
  KeputusanSaran,
  KodeAnomali,
  LaporanAnomali,
  PermintaanEkstraksi,
  StatusAi,
  StatusEkstraksi,
  TemuanAnomali,
  TipeField,
  Uang,
};

interface Daftar<T> {
  data: T[];
}

/**
 * Whether the assistant is on, which model answers, and what the ceilings are.
 *
 * SESSION ONLY, NO PERMISSION, and the route says why: a screen has to be able
 * to find out that there is no button to draw, and knowing the layer is off is
 * not a privilege. It is also the one endpoint that is NOT behind the flag,
 * which is what lets the screens say "the assistant is off" rather than
 * spinning or showing an error panel.
 */
export function statusAi(): Promise<StatusAi> {
  return apiGet<StatusAi>("/ai/status");
}

/**
 * Spec 12 priority 1. Hands the assistant a document's TEXT and gets back
 * PROPOSED fields, each with a confidence and the span it was read from.
 *
 * NOTHING IS SAVED BY CALLING THIS beyond one `ai_saran` log row, and with the
 * flag off not even that. The envelope carries `perluKonfirmasi: true` as a
 * server-set constant; the screen honours it rather than deciding for itself.
 */
export function ekstrakDokumen(input: PermintaanEkstraksi): Promise<HasilEkstraksi> {
  return apiPost<HasilEkstraksi>("/ai/ekstraksi", {
    jenis: input.jenis,
    teks: input.teks,
    konteksTipe: input.konteksTipe ?? null,
    konteksId: input.konteksId ?? null,
  });
}

/**
 * Records that a person looked at a suggestion and what they decided (spec 12:
 * "siapa yang mengonfirmasi").
 *
 * IT CREATES NOTHING. Confirming does not create a proposal, a mitra or a
 * journal; it writes the decision onto the suggestion row so the log says who
 * looked. The screen calls it only from a click, never on mount, never on a
 * timer, and never as a side effect of rendering a result.
 */
export function konfirmasiSaran(
  saranId: string,
  keputusan: KeputusanSaran,
): Promise<HasilKonfirmasi> {
  return apiPost<HasilKonfirmasi>(
    `/ai/saran/${encodeURIComponent(saranId)}/konfirmasi`,
    { keputusan },
  );
}

/**
 * The eight rules and their weights, without running a scan. Lets the queue
 * page explain its own ordering before there is anything in it, which is what
 * keeps a score from reading as a verdict handed down by a model.
 */
export function katalogAnomali(): Promise<Daftar<KatalogAnomali>> {
  return apiGet<Daftar<KatalogAnomali>>("/ai/anomali/katalog");
}

export interface FilterAnomaliWeb {
  periodeId: string;
  /** A FILTER, never authority. The engine refuses a branch outside the
   *  session's scope rather than answering with an empty queue. */
  cabangId?: string | null;
  batas?: number | null;
}

/**
 * Spec 12 priority 2. One period's posted journals, ordered by how much each
 * deserves a second look.
 *
 * A GET AND AN ORDERING AID. `hanyaSaran` is `true` on every answer: nothing
 * here refuses a posting, a close or an approval, and a flagged journal is a
 * valid journal. The screen prints that rather than assuming the reader knows.
 */
export function deteksiAnomali(filter: FilterAnomaliWeb): Promise<LaporanAnomali> {
  return apiGet<LaporanAnomali>(
    `/ai/anomali${buildQuery({
      periodeId: filter.periodeId,
      cabangId: filter.cabangId ?? null,
      batas: filter.batas ?? null,
    })}`,
  );
}
