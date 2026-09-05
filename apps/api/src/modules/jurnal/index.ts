// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./baca.ts, ./kesalahan.ts and ./uang.ts stay
// private.
//
// THE HTTP SURFACE IS HERE NOW (./routes.ts), wired with the guard set from
// modules/auth exactly as every other module's router is. It landed long after
// the engine, and the gap was real rather than cosmetic: spec 9.4's screens --
// including "Hapus Jurnal Transaksi", which is spec 6.3's correction by
// reversing entry and the single most important accounting control in the
// product -- had no door, so spec 16 scenario 10 could not be run and the DRAFT
// scenario 12 needs had to be made by reaching past HTTP into the engine.
// Business modules (PUMK, Non PUMK, closing) must reach the ledger through
// `postingEvent`, `postingEventGabungan` or `postingHapusBukuPiutang` on the
// engine built here, and never write jurnal rows themselves (invariant 11).
// A write-off in particular must use `postingHapusBukuPiutang` and not
// `postingEvent("HAPUS_BUKU_PIUTANG", ...)`: the latter debits the allowance
// for whatever it is handed and will drive that contra-asset negative when the
// allowance is short of the outstanding.
//
// THE ENGINE IS A DEPENDENCY, NOT A SINGLETON. There is no module-global
// instance and no free-function surface over one: an earlier version had both,
// and the global was re-pointed by whichever `createApp` ran last, so with a
// per-fixture app (testing/harness.ts) a call could land on another fixture's
// pool. `createJurnalModule` builds one engine and hands it back; the caller
// decides who gets it.
import { buatJurnalBaca, type JurnalBaca } from "./baca";
import { createJurnalEngine, type JurnalEngine, type JurnalEngineDeps } from "./contract";
import { createJurnalRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createJurnalEngine,
  JurnalError,
  KODE_JURNAL,
  KUNCI_KONFIGURASI,
  PERMISSION_JURNAL,
  POLA_NO_JURNAL,
  POLA_UANG,
} from "./contract";
export type {
  BarisJurnal,
  BarisJurnalInput,
  BuatJurnalInput,
  DimensiBaris,
  EventPayload,
  HapusBukuPiutang,
  HapusBukuPiutangInput,
  JenisJurnal,
  Jurnal,
  JurnalContext,
  JurnalDbPort,
  JurnalEngine,
  JurnalEngineDeps,
  JurnalGabungan,
  JurnalTx,
  KodeJurnal,
  KomponenEvent,
  PembalikStateBisnis,
  PencatatAudit,
  PostingGabunganInput,
  StatusJurnal,
  Uang,
} from "./contract";

/**
 * Builds the journal engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter.
 *
 * The returned engine also satisfies the journal port `modules/angsuran`
 * declares (`PorterJurnalAngsuran`), because `postingEventGabungan` returns
 * `jurnalId` and `jumlahBaris` alongside the full journal. So the wiring is
 * `createAngsuranModule({ db, jurnal: jurnal.engine })` with no adapter in
 * between, and invariant 11 holds structurally: the only way into the ledger
 * is this object.
 */
export function createJurnalModule(deps: JurnalEngineDeps): { engine: JurnalEngine } {
  return { engine: createJurnalEngine(deps) };
}

export type { JurnalBaca };
export type {
  BarisJurnalTampil,
  FilterJurnal,
  JurnalTampil,
  RingkasanJurnal,
} from "./baca";

export interface JurnalModuleDeps extends JurnalEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createJurnalModule` above so a caller that only needs the engine (a
 * seed, a batch job, the five business modules' fixtures) does not have to
 * invent a guard set to get one.
 *
 * The engine handed back here is the SAME instance the routes are built over,
 * which is what keeps invariant 11 true after the door is opened: mounting a
 * router does not add a second way into the ledger, it adds a way to reach the
 * one that was already there.
 */
export function createJurnalHttpModule(deps: JurnalModuleDeps): {
  engine: JurnalEngine;
  baca: JurnalBaca;
  routes: ReturnType<typeof createJurnalRoutes>;
} {
  const engine = createJurnalEngine(deps);
  const baca = buatJurnalBaca({ db: deps.db });
  return { engine, baca, routes: createJurnalRoutes({ engine, baca, guards: deps.guards }) };
}
