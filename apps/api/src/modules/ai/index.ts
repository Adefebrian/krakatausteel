// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./ekstraksi.ts, ./anomali.ts, ./redaksi.ts
// and this folder's ./test-support.ts stay private.
//
// SPEC 12, FASE 8: THE ASSISTANT. Two features, in the owner's order --
// document extraction for the Maker, and an anomaly-ordered review queue for
// the Checker and Approver.
//
// THE RULE THIS MODULE IS SHAPED AROUND, and which nothing in it may override:
// the assistant never approves, never posts, never closes, and never writes to
// the ledger. It proposes; a person decides.
//
// That is not a convention here, it is the dependency graph. This module takes
// a `DbPort`, a `RateLimiterPort`, and OPTIONALLY an `AiPort`. It takes no
// journal port, no pumk port, no mitra port and no angsuran port, so there is
// no path from an AI answer to a `jurnal` row, a proposal, an approval or a
// closed period at all: invariant 11 is unreachable from here rather than
// merely respected. The one table it writes is `ai_saran` (migration 0034), a
// log that no other module reads.
//
// NOTHING ELSE CONSUMES IT EITHER, and that is the other half of the same
// property. `createAiHttpModule` is wired in the composition root and its
// engine is handed to nobody: modules/closing does not consult it, the checklist
// of spec 8.4 does not know it exists, and no approval path reads `ai_saran`. A
// flagged journal is a valid journal.
//
// OFF BY DEFAULT. `AI_ENABLED` is read once in core/app.ts; with it unset or
// false no `AiPort` is constructed, so a deployment of this system contains no
// provider client and needs no API key. Every endpoint still answers, with a
// well-formed empty result, so a screen is told the assistant is off rather
// than shown an error. `./ai-nonaktif.test.ts` proves it.
import { createAiEngine, type AiEngine, type AiEngineDeps } from "./contract";
import { createAiRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createAiEngine,
  AiError,
  ATURAN_ANOMALI,
  BATAS_ANOMALI_PER_USER,
  BATAS_EKSTRAKSI_PER_USER,
  BATAS_TEMUAN_BAWAAN,
  BATAS_TEMUAN_MAKS,
  BATAS_WAKTU_MS,
  BULAN_RIWAYAT_ANOMALI,
  JENDELA_EKSTRAKSI_DETIK,
  JENIS_DOKUMEN,
  KATALOG_ANOMALI,
  KODE_AI,
  MAKS_KARAKTER_DOKUMEN,
  PERMISSION_AI,
  SKEMA_DOKUMEN,
} from "./contract";
export type {
  AiContext,
  AiDbPort,
  AiEngine,
  AiEngineDeps,
  FieldEkstraksi,
  FilterAnomali,
  HasilEkstraksi,
  HasilKonfirmasi,
  JenisDokumen,
  JurnalDitandai,
  KatalogAnomali,
  KeputusanSaran,
  KodeAi,
  KodeAnomali,
  LaporanAnomali,
  PermintaanEkstraksi,
  PermissionAi,
  StatusAi,
  StatusEkstraksi,
  TemuanAnomali,
  TipeField,
  Uang,
} from "./contract";

/**
 * Builds the AI engine. Called from the composition root
 * (apps/api/src/core/app.ts). THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for
 * the reason modules/jurnal records: a module-global instance gets re-pointed
 * by whichever `createApp` ran last, so with a per-fixture app a call can land
 * on another fixture's pool.
 */
export function createAiModule(deps: AiEngineDeps): { engine: AiEngine } {
  return { engine: createAiEngine(deps) };
}

export interface AiModuleDeps extends AiEngineDeps {
  guards: Guards;
  /** Cost knob for the harness only. Production never sets it. */
  batasRute?: { ekstraksi?: number; anomali?: number };
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createAiModule` so a caller that only needs the engine (this folder's
 * own fixtures, a later batch job) does not have to invent a guard set to get
 * one.
 */
export function createAiHttpModule(deps: AiModuleDeps): {
  engine: AiEngine;
  routes: ReturnType<typeof createAiRoutes>;
} {
  const engine = createAiEngine(deps);
  return {
    engine,
    routes: createAiRoutes({
      engine,
      guards: deps.guards,
      // The engine's own limiter instance is reused for the route ceiling, so
      // both halves of the budget live in one Redis namespace and one policy
      // (fail closed) rather than two that could drift apart.
      pembatas: deps.pembatas,
      ...(deps.keyPrefix ? { keyPrefix: deps.keyPrefix } : {}),
      ...(deps.batasRute ? { batasRute: deps.batasRute } : {}),
    }),
  };
}
