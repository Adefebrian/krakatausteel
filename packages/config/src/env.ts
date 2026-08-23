// Typed env schema shared by every app in the monorepo.
//
// Validation is fail-fast, but deliberately NOT run at module import time:
// importing this file must never throw, so that test files (which import
// apps' route modules, which in turn may import this file) can run with
// zero environment configured and no live Postgres, Redis, or S3 endpoint.
//
// Call `loadEnv()` explicitly at the one place that actually needs a fully
// validated environment: the real server entrypoint's `if (import.meta.main)`
// block, never from a route handler or from the top of a module.
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().default("postgres://user:password@localhost:5432/app"),
  // Tests need a real Postgres, not a fake: the accounting invariants of this
  // system (Bagian 3 of the spec) are enforced by triggers and check
  // constraints inside the database, so a stubbed repository proves nothing.
  // TEST_DATABASE_URL is that database, always a separate one whose name ends
  // in _test, wiped and re-migrated by `bun run db:reset`. It is optional here
  // because the server never reads it; tools/db.ts and tools/test-env.ts are
  // the consumers, and both fail loudly when it is missing or misnamed.
  TEST_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1).default("app"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  // How many reverse proxies sit in front of this process, counted from the
  // socket inwards. Only the hops OUR proxies appended to X-Forwarded-For may
  // be believed; see apps/api/src/core/client-ip.ts for the whole argument.
  // Default 0 = ignore X-Forwarded-For entirely and use the socket address,
  // which is the only safe default for an unknown topology. The production
  // stack sets 1, matching its single Caddy.
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(16).default(0),
  // Optional alternative to the count: CIDR blocks that are our own
  // infrastructure, for a topology where the proxy depth varies.
  TRUSTED_PROXY_CIDRS: z.string().default(""),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parse and validate `process.env` against the shared schema. Throws a
 * readable error on the first call if something required is malformed.
 * Safe to call more than once, the result is cached after the first parse.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = result.data;
  return cached;
}

/** Split a comma-separated CORS_ORIGINS value into a clean allowlist. */
export function parseCorsOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
