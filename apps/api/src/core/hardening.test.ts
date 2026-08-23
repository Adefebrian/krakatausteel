// Tests for the global hardening stack, focused on the two things a forged
// X-Forwarded-For header used to be able to do: rotate its way out of the rate
// limiter, and write someone else's address into audit_log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createMemoryRateLimiter } from "./adapters/ratelimit";
import {
  applyHardening,
  bodySizeGuard,
  clientIp,
  clientIpMiddleware,
  corsAllowlist,
  originGuard,
  rateLimit,
  resetTrustedProxyConfig,
} from "./hardening";
import { nativeFetchApi } from "../testing/native-fetch";

const REAL = "203.0.113.7";
const FORGED = "1.2.3.4";

/** Sends a request through `app` with the runtime's own Request (see native-fetch.ts). */
async function send(
  app: Hono,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const { Request: NativeRequest } = nativeFetchApi();
  return app.fetch(new NativeRequest(`http://localhost${path}`, init));
}

function appWithLimiter(options: { limit: number; trustedProxies: string | undefined }): Hono {
  if (options.trustedProxies === undefined) delete process.env.TRUSTED_PROXY_COUNT;
  else process.env.TRUSTED_PROXY_COUNT = options.trustedProxies;
  resetTrustedProxyConfig();

  const base = new Hono();
  base.use("*", clientIpMiddleware);
  base.use(
    "*",
    rateLimit({
      limit: options.limit,
      windowSeconds: 60,
      keyPrefix: `t${crypto.randomUUID().slice(0, 8)}`,
      limiter: createMemoryRateLimiter(),
    }),
  );
  return base.get("/probe", (c) => c.json({ ip: clientIp(c) })) as unknown as Hono;
}

const savedProxyCount = process.env.TRUSTED_PROXY_COUNT;

beforeEach(() => {
  resetTrustedProxyConfig();
});

afterEach(() => {
  if (savedProxyCount === undefined) delete process.env.TRUSTED_PROXY_COUNT;
  else process.env.TRUSTED_PROXY_COUNT = savedProxyCount;
  resetTrustedProxyConfig();
});

describe("rate limiter keying with no trusted proxy configured", () => {
  test("a rotating forged X-Forwarded-For does NOT get a fresh bucket", () => {
    // This is the whole point. With no proxy configured, XFF is ignored, so
    // every one of these requests shares the same (socket-less) bucket and the
    // limit still bites. The old leftmost-hop code gave each forged value its
    // own bucket, i.e. an unlimited request budget for one line of curl.
    const app = appWithLimiter({ limit: 3, trustedProxies: undefined });
    return (async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await send(app, "/probe", { headers: { "x-forwarded-for": `9.9.9.${i}` } });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    })();
  });

  test("the 429 carries Retry-After, per jal-security-hardening", async () => {
    const app = appWithLimiter({ limit: 1, trustedProxies: undefined });
    await send(app, "/probe");
    const res = await send(app, "/probe");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Terlalu banyak permintaan" });
  });

  test("X-RateLimit-Remaining counts down", async () => {
    const app = appWithLimiter({ limit: 5, trustedProxies: undefined });
    const first = await send(app, "/probe");
    const second = await send(app, "/probe");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(second.headers.get("x-ratelimit-remaining")).toBe("3");
  });
});

describe("rate limiter keying with one trusted proxy", () => {
  test("distinct real clients behind the proxy get distinct buckets", async () => {
    const app = appWithLimiter({ limit: 2, trustedProxies: "1" });
    // Two different real clients, each with the same forged prefix.
    const a = async () => send(app, "/probe", { headers: { "x-forwarded-for": `${FORGED}, ${REAL}` } });
    const b = async () => send(app, "/probe", { headers: { "x-forwarded-for": `${FORGED}, 198.51.100.9` } });
    expect((await a()).status).toBe(200);
    expect((await a()).status).toBe(200);
    expect((await a()).status).toBe(429); // client A is out of budget
    expect((await b()).status).toBe(200); // client B is unaffected
  });

  test("one real client cannot escape its bucket by changing the forged prefix", async () => {
    const app = appWithLimiter({ limit: 2, trustedProxies: "1" });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await send(app, "/probe", {
        headers: { "x-forwarded-for": `${i}.${i}.${i}.${i}, ${REAL}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  test("the resolved IP handed to handlers is the real client, not the forged hop", async () => {
    // Same value the audit log records, so this is also the "forged XFF cannot
    // poison audit_log.ip" property at the middleware level.
    const app = appWithLimiter({ limit: 50, trustedProxies: "1" });
    const res = await send(app, "/probe", { headers: { "x-forwarded-for": `${FORGED}, ${REAL}` } });
    expect(await res.json()).toEqual({ ip: REAL });
  });

  test("a request with no XFF at all resolves to null, not to a made-up string", async () => {
    const app = appWithLimiter({ limit: 50, trustedProxies: "1" });
    const res = await send(app, "/probe");
    expect(await res.json()).toEqual({ ip: null });
  });
});

describe("origin guard", () => {
  const app = (() => {
    const base = new Hono();
    base.use("*", originGuard);
    return base.post("/x", (c) => c.json({ ok: true })).get("/x", (c) => c.json({ ok: true }));
  })();

  test("rejects a mutating request from an origin outside the allowlist", async () => {
    const res = await send(app as unknown as Hono, "/x", {
      method: "POST",
      headers: { origin: "https://jahat.example" },
    });
    expect(res.status).toBe(403);
  });

  test("allows a mutating request from an allowlisted origin", async () => {
    const res = await send(app as unknown as Hono, "/x", {
      method: "POST",
      headers: { origin: corsAllowlist()[0]! },
    });
    expect(res.status).toBe(200);
  });

  test("never blocks a safe method, whatever the origin says", async () => {
    const res = await send(app as unknown as Hono, "/x", { headers: { origin: "https://jahat.example" } });
    expect(res.status).toBe(200);
  });

  test("allows a request with no Origin header (server to server, curl)", async () => {
    // Not a hole: those requests still need a valid session cookie, and the
    // cookie is SameSite=Lax so a browser will not attach it cross-site.
    const res = await send(app as unknown as Hono, "/x", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("body size guard", () => {
  test("rejects an oversized declared Content-Length with 413", async () => {
    const base = new Hono();
    base.use("*", bodySizeGuard);
    const app = base.post("/x", (c) => c.json({ ok: true }));
    const res = await send(app as unknown as Hono, "/x", {
      method: "POST",
      headers: { "content-length": "99999999" },
      body: "{}",
    });
    expect(res.status).toBe(413);
  });
});

describe("applyHardening", () => {
  test("registers the whole stack and still serves a route", async () => {
    const base = new Hono();
    applyHardening(base);
    const app = base.get("/x", (c) => c.json({ ok: true }));
    const res = await send(app as unknown as Hono, "/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
