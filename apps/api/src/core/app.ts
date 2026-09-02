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
import { createClosingHttpModule } from "../modules/closing";
import { createJurnalModule } from "../modules/jurnal";
import { createKonfigurasiModule } from "../modules/konfigurasi";
import { createNomorService } from "../modules/nomor";
import { createNonPumkHttpModule } from "../modules/nonpumk";
import { createPumkHttpModule } from "../modules/pumk";
import { createRkaHttpModule } from "../modules/rka";
import { createLaporanHttpModule } from "../modules/laporan";
import { createToolsHttpModule } from "../modules/tools";
import { createDashboardHttpModule } from "../modules/dashboard";
import { createPortalHttpModule } from "../modules/portal";
import { createMitraHttpModule } from "../modules/mitra";
import { createImporHttpModule } from "../modules/impor";
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
  /**
   * Anti-spam ceilings for the PUBLIC portal. A cost knob for the harness in
   * the same family as `loginLimits`: production never sets it, so
   * modules/portal's own constants apply, and those constants are proved
   * against a fixture that does not raise them
   * (modules/portal/portal-batas.test.ts).
   */
  portalLimits?: {
    pengajuanPerIp?: number;
    pengajuanPerIpHarian?: number;
    jendelaPengajuanDetik?: number;
    cekPerIp?: number;
    cekPerTiket?: number;
    jendelaCekDetik?: number;
    rutePengajuan?: number;
    ruteCek?: number;
  };
  /** Namespace for Redis keys, so a test run cannot collide with another. */
  keyPrefix?: string;
}

export function createApp(overrides: AppOverrides = {}) {
  const db = overrides.db ?? createDbAdapter();
  const kv = overrides.kv ?? createKeyValueAdapter();
  const keyPrefix = overrides.keyPrefix ?? "tjsl";
  const audit = overrides.audit ?? createAuditService({ db });

  const base = new Hono();
  // The prefix reaches the GLOBAL limiter too, not just the auth and config
  // ones. Without it every app built in one process shares a bucket per route
  // per IP; see ApplyHardeningOptions in ./hardening.ts.
  applyHardening(base, { keyPrefix });

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

  // Fase 5 (spec 8), the closing engine, ENGINE AND ROUTES. Spec 9.3's two
  // closing screens are mounted at /closing below.
  //
  // Wired here for the same reason the ledger engine is, and it matters more
  // here than anywhere: `jurnal.engine` satisfies `PorterJurnalClosing`
  // structurally, so there is no path from closing to a `jurnal` row that does
  // not go through `postingEvent`, and invariant 11 holds by construction
  // rather than by convention. MOUNTING THE ROUTES DOES NOT WIDEN THAT: every
  // write route below reaches the ledger through this same engine and this same
  // port, and no route hands the module a second way in. `audit` is the same
  // instance every other module uses, so a close, a reopen and the login that
  // led to either land in one audit_log stream.
  const closing = createClosingHttpModule({
    db,
    jurnal: jurnal.engine,
    audit,
    guards: auth.guards,
  });

  // Fase 6 (spec 9.3 and spec 10.3 report 24), the RKA module, ENGINE AND
  // ROUTES.
  //
  // NO JOURNAL PORT, and that is the point rather than an omission: an RKA is a
  // target, not a transaction, so this is the one business engine in the
  // composition that cannot reach the ledger at all. It only READS, through the
  // two shipped artefacts (`v_ledger_baris` for an open period,
  // `saldo_akun_periode` for a closed one). `audit` is the same instance every
  // other module uses, so a refused budget approval and the login that led to
  // it land in one audit_log stream.
  const rka = createRkaHttpModule({ db, audit, guards: auth.guards });

  // Fase 6 (spec 10.3 reports 16 to 20, 22 and 23), the core accounting
  // reports, ENGINE AND ROUTES.
  //
  // STILL NO JOURNAL PORT AND NO AUDIT PORT, and both are the point rather than
  // an omission. Spec 16 scenario 23 requires an Auditor to open every report
  // and change nothing, so this engine issues SELECTs and nothing else:
  // invariant 11 is not merely respected here, it is unreachable, and mounting
  // the routes does not change that because every one of them is a GET. It
  // reads the two shipped artefacts spec 10 names, `v_ledger_baris` for an OPEN
  // period (ADR 0010) and `saldo_akun_periode` for a CLOSED one, and says in
  // every report header which of the two produced the figures. Nothing in the
  // request can override that choice.
  const laporan = createLaporanHttpModule({ db, guards: auth.guards });

  // Fase 7 (spec 9.6), the diagnostic tools: the integrity health check and the
  // receivable reconciliation.
  //
  // NO JOURNAL PORT AND NO AUDIT PORT, and every route is a GET. This engine
  // issues SELECTs and nothing else, so invariant 11 is unreachable from it
  // rather than merely respected: a repair path here would be a second way into
  // the ledger, around `postingEvent`. The checks it exposes are the same SQL
  // apps/api/src/seed/demo-dunia/periksa.ts runs, so the health check page and
  // the seed's acceptance rule cannot disagree about whether the books are
  // intact.
  const tools = createToolsHttpModule({ db, guards: auth.guards });

  // Fase 7 (spec 11), the landing screen.
  //
  // NO JOURNAL PORT AND NO AUDIT PORT, and every route is a GET, for the same
  // reason modules/laporan and modules/tools have none: this engine issues
  // SELECTs and nothing else. It reads the two shipped artefacts spec 10 names,
  // `v_ledger_baris` for an OPEN period (ADR 0010) and `saldo_akun_periode` for
  // a CLOSED one, and says in the payload which of the two produced the
  // figures; nothing in the request can override that choice.
  //
  // THE THREE ENGINE PORTS ARE THE POINT OF THE WIRING. Three figures on this
  // page belong to somebody else, and each is obtained through a port the
  // owning engine satisfies STRUCTURALLY, so there is no adapter in between and
  // no second definition anywhere: `rka.engine` resolves WHICH budget version
  // is the baseline (spec 9.3), `nonpumk.engine` decides which LPJ is late
  // against the configured threshold (spec 9.2), and `closing.engine` owns spec
  // 8.4's ten checks. A dashboard that re-derived any of the three would be a
  // second opinion about the budget, the deadline, or whether a month may be
  // closed.
  const dashboard = createDashboardHttpModule({
    db,
    rka: rka.engine,
    nonpumk: nonpumk.engine,
    closing: closing.engine,
    guards: auth.guards,
  });

  // Fase 7 (spec 9.5), THE PUBLIC PORTAL: the first unauthenticated surface in
  // this application.
  //
  // TWO THINGS ABOUT THIS WIRING ARE SECURITY DECISIONS, not defaults.
  //
  // NO JOURNAL PORT AND NO ANGSURAN PORT. This engine writes exactly one
  // table, `portal_submission`, so there is no path from a public form to a
  // `jurnal`, a `mitra`, a proposal or an akad at all: invariant 11 is
  // unreachable from here rather than merely respected. Turning a submission
  // into a proposal is `POST /pumk/portal/konversi` under `portal.konversi`, a
  // staff act, and it stays one.
  //
  // A FAIL-CLOSED LIMITER, the same policy modules/auth's login uses and the
  // opposite of the global one. The global limiter fails OPEN because Redis
  // being down must not take the API down; for a public WRITE and for a
  // credential check that stance is wrong, because it hands an attacker an
  // unmetered window in exchange for knocking the cache over first.
  const pembatasKetat = overrides.loginLimiter ?? createRateLimiterAdapter({ failOpen: false });
  const portal = createPortalHttpModule({
    db,
    audit,
    pembatas: pembatasKetat,
    pembatasRute: pembatasKetat,
    keyPrefix,
    ...(overrides.passwordOptions ? { passwordOptions: overrides.passwordOptions } : {}),
    ...(overrides.portalLimits ? { batas: overrides.portalLimits } : {}),
    guards: auth.guards,
  });

  // Fase 7 (spec 4.9), THE SECOND KIND OF PRINCIPAL.
  //
  // Wired next to auth but sharing NOTHING with it: its own cookie name, its
  // own Redis session namespace, its own guard, its own shorter lifetimes.
  // modules/mitra/contract.ts's header is the argument for why a mitra is not
  // an `app_user` with an empty role; the short version is that reusing
  // `Principal` would mean filling every authorisation field on it with a lie,
  // and `audit_log.user_id` is a foreign key to `app_user`.
  //
  // It gets the staff `guards` too, and only for the two provisioning routes
  // (`POST /mitra/akun*`, `konfigurasi.user`): issuing a borrower's credential
  // is an officer's act, and there is no self-registration.
  //
  // NO JOURNAL PORT, NO ANGSURAN PORT, NO PUMK PORT. Every mitra-facing route
  // is a SELECT filtered by the session's own `mitra_id`.
  const mitra = createMitraHttpModule({
    db,
    kv,
    audit,
    pembatas: pembatasKetat,
    pembatasRute: pembatasKetat,
    guards: auth.guards,
    keyPrefix,
    ...(overrides.passwordOptions ? { passwordOptions: overrides.passwordOptions } : {}),
    ...(overrides.sessionOptions?.now ? { jam: overrides.sessionOptions.now } : {}),
    // The harness's ONE cost knob for authentication ceilings, applied to both
    // login surfaces. Production never sets it, so both keep their own
    // constants; a test file that makes hundreds of login calls from one
    // (absent) client address would otherwise be testing the rate limiter.
    ...(overrides.loginLimits
      ? {
          batasMasuk: {
            ...(overrides.loginLimits.perIp !== undefined ? { perIp: overrides.loginLimits.perIp } : {}),
            ...(overrides.loginLimits.perUsername !== undefined
              ? { perEmail: overrides.loginLimits.perUsername }
              : {}),
            ...(overrides.loginLimits.windowSeconds !== undefined
              ? { windowSeconds: overrides.loginLimits.windowSeconds }
              : {}),
          },
        }
      : {}),
  });

  // Fase 7 (spec 9.6), THE BULK IMPORT: the writing half of the tools.
  //
  // STILL NO JOURNAL PORT, and that is the point of the `angsuran` factory
  // instead. Spec 9.6 requires an import to be all-or-nothing per FILE, but
  // `angsuran.alokasikanSetoran` opens its own transaction per receipt, which
  // would make a 200-row file 200 independent commits. Rather than change that
  // engine's boundary (correct for its own callers), the import builds a
  // SECOND instalment engine over a db port bound to the import's ALREADY OPEN
  // transaction, so the whole file becomes one commit and one rollback.
  //
  // The engine is unmodified and the ledger path is unchanged: that second
  // instance still reaches `jurnal` only through `jurnal.engine`, i.e. through
  // `postingEvent`, which is what invariant 11 rests on. This factory is
  // exactly the kind of thing only the composition root may write, because it
  // is the one place allowed to know two modules at once.
  const impor = createImporHttpModule({
    db,
    audit,
    angsuran: (terikat) =>
      createAngsuranModule({ db: terikat, jurnal: jurnal.engine }).engine,
    guards: auth.guards,
  });

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
    .route("/rka", rka.routes)
    .route("/closing", closing.routes)
    .route("/laporan", laporan.routes)
    .route("/tools", tools.routes)
    .route("/dashboard", dashboard.routes)
    .route("/portal", portal.routes)
    .route("/mitra", mitra.routes)
    .route("/impor", impor.routes)
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
    closingBaca: closing.baca,
    rka: rka.engine,
    rkaBaca: rka.baca,
    laporan: laporan.engine,
    laporanBaca: laporan.baca,
    tools: tools.engine,
    dashboard: dashboard.engine,
    portal: portal.engine,
    mitra: mitra.engine,
    impor: impor.engine,
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
export const rka = instance.rka;
export const laporan = instance.laporan;
export const tools = instance.tools;
export const dashboard = instance.dashboard;
export const portal = instance.portal;
export const mitra = instance.mitra;
export const impor = instance.impor;
export type AppType = typeof app;
