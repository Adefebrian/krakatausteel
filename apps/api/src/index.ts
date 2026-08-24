import { loadEnv } from "@krakatausteel/config";
import { app } from "./core/app";
import { MAX_BODY_BYTES } from "./core/hardening";

export { app };
export type { AppType } from "./core/app";

// NO DEFAULT EXPORT, DELIBERATELY. `export default app` used to be here and it
// made this file unable to boot: Bun treats a default-exported object with a
// `fetch` method as a server definition and serves it itself, IN ADDITION to
// the explicit `Bun.serve` below. Both then bind the same port and the process
// dies with EADDRINUSE at bun:main, which under `restart: unless-stopped` is a
// crash loop rather than a visible failure. Nothing imported it. If a future
// entrypoint wants Bun's shim, it must own the port instead of calling
// Bun.serve, not do both.
//
// Fail-fast env validation and the actual listen call only happen when this
// file is executed directly (the real runtime entrypoint), never when it is
// imported (e.g. by index.test.ts via `app.request(...)`). This keeps
// `bun test` fully independent of live Postgres/Redis/S3/OpenAI.
if (import.meta.main) {
  const env = loadEnv();
  Bun.serve({
    fetch: app.fetch,
    port: env.PORT,
    // THE body-size cap, enforced by the runtime before any application code
    // runs, for a declared length AND for a chunked body with no length at
    // all. `bodySizeGuard` in core/hardening.ts only mirrors the declared case
    // so the client gets this API's JSON error shape instead of a bare 413.
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  // eslint-disable-next-line no-console
  console.log(`api listening on :${env.PORT}`);
}
