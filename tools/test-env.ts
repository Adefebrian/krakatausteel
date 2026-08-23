// tools/test-env.ts - preloaded by `bun test` (see [test].preload in the root
// bunfig.toml). It runs before any test file or module under test is imported.
//
// One job: make it impossible for a test to talk to the dev database.
//
// The API's db adapter reads DATABASE_URL. Tests import the app, the app builds
// its pool from DATABASE_URL, and .env sets DATABASE_URL to tjsl_dev. So
// without this file, the first test that writes a journal entry writes it into
// the development ledger. This rewrites DATABASE_URL to TEST_DATABASE_URL for
// the test process only, and refuses to let the run continue if that would
// leave tests pointed at a non-test database.
//
// Note on scope: this applies to `bun test` invoked from the repo root, which
// is the canonical way to run the suite here (`bun run test` and
// `bun run verify` both do exactly that). Bun reads only the nearest
// bunfig.toml, so a `cd apps/api && bun test` bypasses this file; run tests
// from the root, or filter by path (`bun test apps/api/src`), and the guard
// stays on. That is also why the root `test` script is plain `bun test` rather
// than `turbo run test`: turbo would run each workspace's own `bun test` with
// the cwd inside that workspace, where this preload does not apply.

function databaseName(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  return withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
}

process.env.NODE_ENV ??= "test";

const testUrl = process.env.TEST_DATABASE_URL;

if (testUrl) {
  if (!databaseName(testUrl).endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL points at database "${databaseName(testUrl)}", which does not ` +
        "end in _test. Refusing to run the suite against it.",
    );
  }
  process.env.DATABASE_URL = testUrl;
} else if (process.env.DATABASE_URL && !databaseName(process.env.DATABASE_URL).endsWith("_test")) {
  // No test URL configured and DATABASE_URL is a real (dev) database: unset it
  // rather than let a suite silently write there. A test that genuinely needs
  // Postgres will then fail loudly with "DATABASE_URL is not set", which is the
  // correct outcome, and the fix is one line in .env.
  console.warn(
    "[test-env] TEST_DATABASE_URL is unset and DATABASE_URL is not a _test database; " +
      "unsetting DATABASE_URL for this run. Set TEST_DATABASE_URL (see .env.example).",
  );
  delete process.env.DATABASE_URL;
}

// ---------------------------------------------------------------------------
// Native fetch-API constructors, captured before happy-dom replaces them.
//
// Preload order in bunfig.toml is ["./tools/test-env.ts",
// "./apps/web/src/happydom.ts"], so THIS FILE runs while `Request`,
// `Response` and `Headers` are still Bun's own. That order is what makes the
// capture below possible, and it is why this block lives here rather than in a
// helper under apps/api.
//
// Why it is needed: happy-dom implements the browser fetch spec, including the
// forbidden-header list. Its `Request` silently drops `Cookie`, and its
// `Response` constructor silently drops `Set-Cookie` from a headers init. Both
// are correct for a page script and fatal for an API test: a session cookie
// could neither be sent nor observed, so authentication and authorisation
// would be untestable exactly where they matter (spec section 2 rule 4 demands
// calling endpoints directly with the wrong role).
//
// apps/api's test harness reads these to build real requests. Nothing in
// production ever touches them; the property is only defined under `bun test`.
Object.defineProperty(globalThis, "__BUN_NATIVE_FETCH__", {
  value: Object.freeze({ Request, Response, Headers, fetch }),
  writable: false,
  enumerable: false,
  configurable: false,
});
