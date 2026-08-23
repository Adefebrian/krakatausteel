// Default security hardening applied to every route, per jal-security-hardening.
// Secure headers, a CORS allowlist sourced from env, an Origin check on
// mutating requests, a Redis-backed rate limiter keyed by the REAL client IP,
// and a body-size guard. None of this touches a network resource at import
// time: everything here is either pure config or lazy on first request.
import type { Context, MiddlewareHandler, Next } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { setCookieFlush } from "./cookies";
import {
  loadTrustedProxyConfig,
  normaliseIp,
  resolveClientIp,
  type TrustedProxyConfig,
} from "./client-ip";
import { createRateLimiterAdapter } from "./adapters/ratelimit";
import type { RateLimiterPort } from "./ports/ratelimit";

const DEFAULT_ORIGINS = ["http://localhost:3000"];
const MAX_BODY_BYTES = 1_000_000; // 1 MB. File uploads land in Fase 3 behind their own route.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 120;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Namespace for every rate-limit key. Under `bun test` it gets a per-process
 * random suffix, because the limiter counts in a REAL Redis with a 60 second
 * window: without this, running the suite twice inside a minute would inherit
 * the previous run's counters and fail a test for reasons that have nothing
 * to do with the code. Production uses the stable prefix.
 */
export const DEFAULT_KEY_PREFIX =
  process.env.RATE_LIMIT_KEY_PREFIX ??
  (process.env.NODE_ENV === "test" ? `rl:t:${crypto.randomUUID().slice(0, 8)}` : "rl");

/** Key under which the resolved client IP is stashed for downstream handlers. */
export const CLIENT_IP_VAR = "clientIp";

export function corsAllowlist(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : DEFAULT_ORIGINS;
}

/** hono/secure-headers, applied globally before any route is registered. */
export const secureHeadersMiddleware: MiddlewareHandler = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
  crossOriginResourcePolicy: "same-origin",
  referrerPolicy: "strict-origin-when-cross-origin",
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
});

/** Explicit origin allowlist from env, never `*`, never a reflected wildcard. */
export const corsMiddleware: MiddlewareHandler = cors({
  origin: (origin) => {
    const allowlist = corsAllowlist();
    return origin && allowlist.includes(origin) ? origin : allowlist[0];
  },
  credentials: true,
});

/**
 * Rejects a mutating request whose `Origin` is not in the allowlist.
 *
 * CORS alone does not stop this: the browser blocks the RESPONSE, but the
 * request has already reached the handler and its side effect has already
 * happened. Since the session cookie is SameSite=Lax, a cross-site POST
 * carries no cookie and would fail on authentication anyway; this is the
 * second lock, and it is what makes a same-site-but-different-subdomain
 * attacker fail too. A request with no Origin header at all (server to
 * server, curl, the test suite) is not blocked here, it is blocked by
 * needing a valid session cookie.
 */
export const originGuard: MiddlewareHandler = async (c: Context, next: Next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin && !corsAllowlist().includes(origin)) {
    return c.json({ error: "Origin tidak diizinkan" }, 403);
  }
  return next();
};

/** Rejects any request whose declared Content-Length exceeds the limit. */
export const bodySizeGuard: MiddlewareHandler = async (c: Context, next: Next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }
  return next();
};

// Loaded once per process, lazily, so an invalid value fails on the first
// request rather than at import time (which would break `bun test`).
let trustedProxies: TrustedProxyConfig | undefined;
export function trustedProxyConfig(): TrustedProxyConfig {
  if (!trustedProxies) trustedProxies = loadTrustedProxyConfig();
  return trustedProxies;
}

/** Test seam: forget the cached config so a test can change the env. */
export function resetTrustedProxyConfig(): void {
  trustedProxies = undefined;
}

/**
 * Peer address of the TCP connection, when the runtime can tell us.
 *
 * Under `Bun.serve` Hono exposes the server on the context env, and
 * `server.requestIP(req)` gives the socket peer. Under `app.request(...)`
 * (the test path) there is no socket at all and this is null, which is
 * correct: a synthetic request has no peer, so a test that wants one passes
 * a header and configures a trusted proxy.
 */
export function socketAddress(c: Context): string | null {
  const env = c.env as { requestIP?: (req: Request) => { address?: string } | null } | undefined;
  const server = (env as { server?: { requestIP?: (req: Request) => { address?: string } | null } })?.server;
  const source = typeof env?.requestIP === "function" ? env : server;
  if (!source || typeof source.requestIP !== "function") return null;
  try {
    const info = source.requestIP(c.req.raw);
    return info?.address ? normaliseIp(info.address) : null;
  } catch {
    return null;
  }
}

/**
 * The real client IP for this request, or null when it cannot be established.
 * Reads the value cached by `clientIpMiddleware` so the resolution runs once.
 */
export function clientIp(c: Context): string | null {
  const cached = c.get(CLIENT_IP_VAR as never) as string | null | undefined;
  if (cached !== undefined) return cached;
  return resolveClientIp(
    { forwardedFor: c.req.header("x-forwarded-for"), socketAddress: socketAddress(c) },
    trustedProxyConfig(),
  );
}

/** Resolves the client IP once per request and caches it on the context. */
export const clientIpMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  const ip = resolveClientIp(
    { forwardedFor: c.req.header("x-forwarded-for"), socketAddress: socketAddress(c) },
    trustedProxyConfig(),
  );
  c.set(CLIENT_IP_VAR as never, ip as never);
  return next();
};

export interface RateLimitOptions {
  limit?: number;
  windowSeconds?: number;
  keyPrefix?: string;
  limiter?: RateLimiterPort;
}

/**
 * Redis-backed rate limit, keyed by route + real client IP. Fails open (see
 * core/ports/ratelimit.ts). A request whose IP cannot be established falls
 * back to a per-route bucket rather than sharing one global "unknown" bucket
 * with every other unidentifiable request.
 */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const limit = options.limit ?? RATE_LIMIT_MAX_REQUESTS;
  const windowSeconds = options.windowSeconds ?? RATE_LIMIT_WINDOW_SECONDS;
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const limiter = options.limiter ?? createRateLimiterAdapter({ failOpen: true });

  return async (c: Context, next: Next) => {
    const ip = clientIp(c);
    const key = `${prefix}:${c.req.path}:${ip ?? "no-ip"}`;
    const result = await limiter.consume(key, limit, windowSeconds);
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      c.header("Retry-After", String(Math.max(1, result.retryAfterSeconds)));
      return c.json({ error: "Terlalu banyak permintaan" }, 429);
    }
    return next();
  };
}

/** Back-compat alias: the global limiter with default settings. */
export const rateLimitMiddleware: MiddlewareHandler = rateLimit();

/** Registers the full hardening stack, in the order it must run. */
export function applyHardening(app: {
  use: (path: string, ...handlers: MiddlewareHandler[]) => unknown;
}): void {
  // First registered = outermost = last to touch the response. Cookies are
  // written there so no middleware downstream can drop them; see ./cookies.ts.
  app.use("*", setCookieFlush);
  app.use("*", secureHeadersMiddleware);
  app.use("*", corsMiddleware);
  app.use("*", originGuard);
  app.use("*", bodySizeGuard);
  // Client IP must be resolved before the limiter keys on it.
  app.use("*", clientIpMiddleware);
  app.use("*", rateLimitMiddleware);
}
