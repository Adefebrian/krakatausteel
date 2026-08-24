// apps/web/server.ts - serves the SPA built by build.ts. Plain Hono +
// hono/bun static serving, no Vite dev server, no Next.js.
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();

// hono/bun's serveStatic resolves `root`/`path` relative to process.cwd(),
// not relative to this file. Use an absolute path (import.meta.dir) so the
// server behaves the same whether it is started from apps/web, from the
// repo root (a `bun test` run that imports this module), or from a Docker
// image's WORKDIR.
const distDir = `${import.meta.dir}/dist`;

// ---------------------------------------------------------------------------
// /api/* -> the Hono API, prefix stripped.
//
// This mirrors infra/Caddyfile exactly ("handle /api/*: uri strip_prefix /api,
// reverse_proxy api:3001"), so development and production have the SAME single
// origin. That matters for auth, not for convenience: the session cookie is
// HttpOnly SameSite=Lax, and SameSite=Lax means a cookie set by the API on one
// origin is simply not sent to a different one. Two ports in dev and one
// origin in prod would mean testing a login flow that does not exist in
// production.
//
// In production Caddy answers /api/* before this server ever sees it, so this
// handler is the dev path. API_ORIGIN overrides the target; the default is
// derived from PORT, the same variable the API itself reads, so there is no new
// configuration key to keep in sync.
// ---------------------------------------------------------------------------
// Resolved per request, not once at import: `bun --watch` picks up an env
// change without a restart, and the test suite can point two servers at two
// different upstreams in one process.
function apiOrigin(): string {
  return process.env.API_ORIGIN ?? `http://127.0.0.1:${Number(process.env.PORT ?? 3001)}`;
}

// Header allowlist. `x-forwarded-for` and `forwarded` are deliberately NOT
// forwarded: the API resolves the client IP from the trusted proxy hop, and
// passing a client-supplied value straight through would let a caller dictate
// the IP written into the audit log and counted by the login rate limiter.
const FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "cookie",
  "origin",
  "referer",
  "user-agent",
];

app.all("/api/*", async (c) => {
  const url = new URL(c.req.url);
  const target = `${apiOrigin()}${url.pathname.slice("/api".length) || "/"}${url.search}`;

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await c.req.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch {
    // The API is not up. Answer with the API's own JSON error envelope shape
    // (core/http.ts's AppErrorBody) and NEVER fall through to the SPA
    // index.html: a client that asked for JSON and got HTML cannot tell "you
    // are not signed in" from "the server is down".
    return c.json(
      { error: "Server tidak dapat dihubungi", code: "KESALAHAN_SERVER" },
      502,
    );
  }

  // Pass the upstream response through, headers included, so Set-Cookie (the
  // session cookie) reaches the browser unmodified. The hop-by-hop headers go:
  // fetch has already decoded the body, so re-advertising content-encoding or
  // the original content-length would make the browser decode a second time
  // and fail on a truncated frame.
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  outHeaders.delete("transfer-encoding");
  outHeaders.delete("connection");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
});

app.use("/*", serveStatic({ root: distDir }));
// SPA fallback: any route not matched by a static file (client-side routes)
// resolves to index.html instead of a 404.
//
// `path` must be a filename relative to `root`, not `distDir`'s own
// absolute path. hono's serve-static join() strips the leading slash off
// an absolute `path` when `root` defaults to "./" (verified against
// hono@4.13.3's src/middleware/serve-static/path.js), which quietly turns
// this into a request for a relative path that never exists and this
// fallback into a silent 404 instead of index.html. Passing the same
// absolute `root` here sidesteps that join() edge case entirely.
app.get("*", serveStatic({ root: distDir, path: "index.html" }));

// NAMED EXPORT ONLY, NO DEFAULT EXPORT, DELIBERATELY. Bun's entry shim treats a
// default-exported object with a `fetch` method as a server definition and
// serves it ITSELF, on `PORT`, in addition to the explicit Bun.serve below.
// With `export default app` here, `WEB_PORT=3000 bun apps/web/server.ts` bound
// 3000 as intended AND 3001 from PORT in .env, which is the API's port: the SPA
// server silently squatted the API's socket, so the API could not start and
// every /api/* request in development was answered by the SPA's own index.html
// fallback with a 200. Observed on this machine, not theoretical. Same trap
// apps/api/src/index.ts documents. A future entrypoint that wants the shim must
// own the port instead of calling Bun.serve, not do both.
export { app };

const port = Number(process.env.WEB_PORT ?? 3000);

if (import.meta.main) {
  Bun.serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log(`web listening on :${port}, /api proxies to ${apiOrigin()}`);
}
