// Assembles the Hono app: hardening middleware, health check, and every
// domain module, each wired with the core port adapters it needs. This is
// the one place in the codebase that is allowed to know both "modules" and
// "adapters" at once; a module itself never reaches for an adapter or a raw
// infra client directly (see ../modules/example and tools/check-boundaries.ts).
//
// The route registrations below are chained (`.get(...).route(...)`) rather
// than called as separate statements. Hono's RPC typing (`hc<AppType>`, see
// apps/web/src/client.ts) only accumulates a route's schema into the type of
// the variable that the call is assigned to; a bare `app.get(...)` statement
// whose return value is discarded still registers the route at runtime but
// leaves the compile-time type of `app` unchanged. Chaining is required for
// AppType to actually describe the routes.
//
// WHY A FACTORY AND A SINGLETON
// `createApp(overrides)` builds the whole graph; `app` is the one instance the
// server and the RPC type use. The authorisation tests build their own
// instance through the SAME factory, overriding only cost knobs (argon2
// parameters, session TTL, rate-limit ceilings) and never the wiring. Spec 2
// rule 4 requires calling endpoints with the wrong role and getting refused;
// that proves nothing if the app under test is assembled differently from the
// app that ships.
//
// WIRING ORDER, and why it is not arbitrary:
//   1. hardening (headers, CORS, origin, body size, client IP, rate limit)
//   2. the error handler, so a module's thrown AppError becomes a clean
//      response and a database guard never escapes as a 500
//   3. auth, because it produces the `guards` every other module's routes are
//      registered with. Nothing else can be wired before it exists.
//   4. everything else, each handed those guards.
import { Hono } from "hono";
import { createDbAdapter } from "./adapters/db";
import { createKeyValueAdapter } from "./adapters/keyvalue";
import { createRateLimiterAdapter } from "./adapters/ratelimit";
import { createS3ObjectStoreAdapter } from "./adapters/s3";
import { applyHardening } from "./hardening";
import { createErrorHandler } from "./http";
import type { DbPort } from "./ports/db";
import type { KeyValueStorePort } from "./ports/keyvalue";
import type { RateLimiterPort } from "./ports/ratelimit";
import type { CachePort } from "./ports/redis";
import type { ObjectStorePort } from "./ports/s3";
import { createAuditModule, createAuditService, type AuditService } from "../modules/audit";
import { auditActor, createAuthModule } from "../modules/auth";
import { createAngsuranModule } from "../modules/angsuran";
import { createClosingModule } from "../modules/closing";
import { createJurnalModule } from "../modules/jurnal";
import { createKonfigurasiModule } from "../modules/konfigurasi";
import { createNomorService } from "../modules/nomor";
import { createNonPumkHttpModule } from "../modules/nonpumk";
import { createPumkHttpModule } from "../modules/pumk";
import { createOrganisasiModule } from "../modules/organisasi";
// modules/example is deliberately NOT imported: see the note above the route
// table below.

export interface AppOverrides {
  db?: DbPort;
  kv?: KeyValueStorePort;
  /**
   * Fail-open cache port. No module wired here needs one yet (konfigurasi uses
   * the strict KeyValueStorePort on purpose), so this is accepted and passed
   * through for the first module that does.
   */
  cache?: CachePort;
  /**
   * Object storage for PUMK attachments. Overridable so a test can exercise
   * `POST /pumk/lampiran` without an S3 endpoint; the adapter opens no socket
   * on construction, so the default is safe under `bun test` too.
   */
  objectStore?: ObjectStorePort;
  loginLimiter?: RateLimiterPort;
  audit?: AuditService;
  /** Session lifetimes and clock. Tests shorten these to observe expiry. */
  sessionOptions?: {
    idleTtlSeconds?: number;
    absoluteTtlSeconds?: number;
    now?: () => Date;
  };
  /** argon2id cost. Tests lower it; production never sets it. */
  passwordOptions?: { memoryCost?: number; timeCost?: number };
  loginLimits?: { perIp?: number; perUsername?: number; windowSeconds?: number };
  /** Namespace for Redis keys, so a test run cannot collide with another. */
  keyPrefix?: string;
}

export function createApp(overrides: AppOverrides = {}) {
  const db = overrides.db ?? createDbAdapter();
  const kv = overrides.kv ?? createKeyValueAdapter();
  const keyPrefix = overrides.keyPrefix ?? "tjsl";
  const audit = overrides.audit ?? createAuditService({ db });

  const base = new Hono();
  applyHardening(base);

  const auth = createAuthModule({
    db,
    audit,
    // Fail CLOSED for login: sessions live in Redis, so if Redis is down no
    // login could succeed anyway, and refusing beats letting a password spray
    // run unmetered after knocking the cache over.
    loginLimiter: overrides.loginLimiter ?? createRateLimiterAdapter({ failOpen: false }),
    sessionOptions: { kv, ...overrides.sessionOptions },
    ...(overrides.passwordOptions ? { passwordOptions: overrides.passwordOptions } : {}),
    ...(overrides.loginLimits ? { loginLimits: overrides.loginLimits } : {}),
    keyPrefix,
  });

  // Registered before any route, so it applies to routes written later too.
  base.use("*", auth.guards.enforceReadOnlyRoles);

  // AFTER auth exists, because the handler audits authorisation refusals and
  // needs both the audit service and the acting principal to do it. Every 403
  // thrown from a service (branch scope) or from the Origin guard lands here,
  // not just the ones the guard chain makes itself.
  base.onError(createErrorHandler({ audit, actor: auditActor }));

  const konfigurasi = createKonfigurasiModule({
    db,
    kv,
    audit,
    guards: auth.guards,
    keyPrefix: `${keyPrefix}:cfg:`,
  });
  const auditModule = createAuditModule({ db, guards: auth.guards });
  const organisasi = createOrganisasiModule({ db, guards: auth.guards });
  // No HTTP surface by design (see modules/nomor/index.ts); exposed here so
  // later phases and the tests get the same instance.
  const nomor = createNomorService({ db });
  // Also no HTTP surface yet: Fase 1 is the engine, the journal screens of
  // spec 9 add routes later. Wired here so the business modules of Fase 3
  // onward reach the ledger through this one engine instance, which is what
  // invariant 11 (a single posting path) actually rests on.
  // `audit` is the same instance auth and konfigurasi use, so a posting and the
  // login that led to it land in one audit_log stream. The engine writes its
  // rows on the transaction that changed the ledger, so a rolled back posting
  // leaves no row claiming it happened.
  const jurnal = createJurnalModule({ db, audit });
  // The installment engine reaches the ledger ONLY through the journal engine
  // instance above, never by writing jurnal rows itself. That is invariant 11,
  // and migration 0020's posting-path trigger refuses any other route.
  const angsuran = createAngsuranModule({ db, jurnal: jurnal.engine });
  // Fase 3 (spec 9.1), engine AND routes. Wired here so the business layer
  // reaches the ledger ONLY through the one journal engine above and the
  // schedule ONLY through the one instalment engine, which is what invariants 8
  // and 11 actually rest on. Both engines satisfy this module's ports
  // structurally, so there is no adapter in between and no second route to a
  // journal or a schedule row. `konfigurasi.service` satisfies the module's
  // configuration port the same way, so `GET /pumk/batasan` answers from the
  // parameter rows an accountant edits rather than from a literal.
  const pumk = createPumkHttpModule({
    db,
    angsuran: angsuran.engine,
    jurnal: jurnal.engine,
    konfigurasi: konfigurasi.service,
    penyimpanan: overrides.objectStore ?? createS3ObjectStoreAdapter(),
    guards: auth.guards,
  });

  // Fase 4 (spec 9.2), the grant line, ENGINE AND ROUTES. Wired here so the
  // module reaches the ledger ONLY through the one journal engine above, which
  // is what invariant 11 actually rests on; `jurnal.engine` satisfies
  // `PorterJurnalNonPumk` structurally, so there is no adapter in between and
  // no second route to a journal row. The read side of the module is handed
  // that same engine instance, so no screen can show a row the engine would
  // have refused on branch scope.
  const nonpumk = createNonPumkHttpModule({ db, jurnal: jurnal.engine, guards: auth.guards });

  // Fase 5 (spec 8), the closing engine. NO HTTP SURFACE YET, deliberately:
  // spec 9.3's two closing screens arrive with their own routes. Wired here for
  // the same reason the ledger engine is, and it matters more here than
  // anywhere: `jurnal.engine` satisfies `PorterJurnalClosing` structurally, so
  // there is no path from closing to a `jurnal` row that does not go through
  // `postingEvent`, and invariant 11 holds by construction rather than by
  // convention. `audit` is the same instance every other module uses, so a
  // closing and the login that led to it land in one audit_log stream.
  const closing = createClosingModule({ db, jurnal: jurnal.engine, audit });

  // modules/example IS NOT MOUNTED, and must not be.
  //
  // It is the repo template's reference module and it is unauthenticated by
  // design, which is fine as a pattern and dangerous as a live route. Mounted,
  // it gave an anonymous caller two primitives against the real stack:
  //   - POST /example appended to an unbounded in-process array (memory growth
  //     with no ceiling and no auth);
  //   - GET /example/:id/views ran INCR on a caller-chosen Redis key with NO
  //     expiry, in the same Redis that holds `tjsl:sess:*`. Enough of those and
  //     Redis is full, `sessions.create` starts throwing, and because the auth
  //     limiter is fail-closed nobody can log in at all. An unauthenticated
  //     total auth outage.
  // The folder stays in the tree as the module-anatomy example that
  // tools/check-boundaries.ts and its own test exercise. Wiring it into the
  // shipped app is what was wrong.
  const app = base
    .get("/health", (c) => c.json({ ok: true }))
    .route("/auth", auth.routes)
    .route("/organisasi", organisasi.routes)
    .route("/konfigurasi", konfigurasi.routes)
    .route("/pumk", pumk.routes)
    .route("/nonpumk", nonpumk.routes)
    .route("/audit", auditModule.routes);

  return {
    app,
    db,
    kv,
    cache: overrides.cache,
    audit,
    auth,
    konfigurasi: konfigurasi.service,
    organisasi: organisasi.service,
    nomor,
    jurnal: jurnal.engine,
    angsuran: angsuran.engine,
    pumk: pumk.engine,
    pumkBaca: pumk.baca,
    nonpumk: nonpumk.engine,
    nonpumkBaca: nonpumk.baca,
    closing: closing.engine,
  };
}

const instance = createApp();

export const app = instance.app;
export const auth = instance.auth;
export const konfigurasi = instance.konfigurasi;
export const audit = instance.audit;
export const nomor = instance.nomor;
export const jurnal = instance.jurnal;
export const angsuran = instance.angsuran;
export const pumk = instance.pumk;
export const nonpumk = instance.nonpumk;
export const closing = instance.closing;
export type AppType = typeof app;
