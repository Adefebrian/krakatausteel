// Typed Hono RPC client for apps/api, built from that app's own route types
// (see apps/api/src/core/app.ts's `AppType`), so a call like
// `api.example.$get()` is checked against the real request/response shapes
// at build time instead of being hand-typed and left to drift.
//
// The `AppType` import below is `import type` only, so Bun's transpiler
// elides it entirely from the bundle: apps/api's runtime code (Postgres,
// Redis, S3, OpenAI clients) never ships to the browser, only the type
// information tsc needs is pulled in, and only at typecheck time.
import { hc } from "hono/client";
import type { AppType } from "@krakatausteel/api/src/core/app";

// Same base as ./api/auth.ts, and for the same reason: the API lives under the
// /api prefix on the SPA's own origin, stripped by Caddy in production
// (infra/Caddyfile) and by apps/web/server.ts in development. A bare origin
// here would send every RPC call to the SPA's index.html fallback and get a
// 200 with HTML in it.
//
// `import.meta.env` is a Vite convention, not a Bun one; this repo has no
// Vite dev server (see README "Stack"), so nothing defines `env` on
// `ImportMeta` here. Read it defensively through a local cast instead of
// widening the global `ImportMeta` type just for one optional override.
const apiUrl =
  (import.meta as unknown as { env?: { API_URL?: string } }).env?.API_URL ??
  (globalThis as { __TJSL_API_BASE__?: string }).__TJSL_API_BASE__ ??
  "/api";

export const api = hc<AppType>(apiUrl, { init: { credentials: "include" } });
