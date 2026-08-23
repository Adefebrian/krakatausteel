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
import { createRedisCacheAdapter } from "./adapters/redis";
import { applyHardening } from "./hardening";
import { errorHandler } from "./http";
import type { DbPort } from "./ports/db";
import type { KeyValueStorePort } from "./ports/keyvalue";
import type { RateLimiterPort } from "./ports/ratelimit";
import type { CachePort } from "./ports/redis";
import { createAuditModule, createAuditService, type AuditService } from "../modules/audit";
import { createAuthModule } from "../modules/auth";
import { createExampleModule } from "../modules/example";
import { createKonfigurasiModule } from "../modules/konfigurasi";
import { createNomorService } from "../modules/nomor";
import { createOrganisasiModule } from "../modules/organisasi";

export interface AppOverrides {
  db?: DbPort;
  kv?: KeyValueStorePort;
  cache?: CachePort;
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
  base.onError(errorHandler);

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

  const app = base
    .get("/health", (c) => c.json({ ok: true }))
    .route("/auth", auth.routes)
    .route("/organisasi", organisasi.routes)
    .route("/konfigurasi", konfigurasi.routes)
    .route("/audit", auditModule.routes)
    .route("/example", createExampleModule({ cache: overrides.cache ?? createRedisCacheAdapter() }));

  return {
    app,
    db,
    kv,
    audit,
    auth,
    konfigurasi: konfigurasi.service,
    organisasi: organisasi.service,
    nomor,
  };
}

const instance = createApp();

export const app = instance.app;
export const auth = instance.auth;
export const konfigurasi = instance.konfigurasi;
export const audit = instance.audit;
export const nomor = instance.nomor;
export type AppType = typeof app;
