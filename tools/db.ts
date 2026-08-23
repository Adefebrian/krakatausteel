#!/usr/bin/env bun
// tools/db.ts - database lifecycle helper for local dev and CI.
//
// Why this exists on top of tools/migrate.ts: migrate.ts only ever reads
// DATABASE_URL, by design (it is the dumb, boring migration runner). But this
// is an accounting system whose invariants live in Postgres triggers and check
// constraints, so tests need a REAL database, and that database must be a
// different one from the dev database, must never be the dev database by
// accident, and must be reproducible from zero. This file owns that policy:
//
//   bun tools/db.ts migrate        migrations up on DATABASE_URL      (dev)
//   bun tools/db.ts migrate:test   migrations up on TEST_DATABASE_URL (test)
//   bun tools/db.ts reset          wipe + re-migrate TEST_DATABASE_URL
//   bun tools/db.ts seed           seed data (placeholder, filled per phase)
//   bun tools/db.ts status         which URLs resolve to what, no writes
//
// `reset` drops and recreates the `public` schema rather than dropping the
// database, deliberately:
//   - it needs no CREATEDB privilege, so the same command works against a
//     local Homebrew Postgres and against a CI service container;
//   - it cannot fail with "database is being accessed by other users";
//   - it is a single transaction, so a half-wiped test DB is not a state you
//     can end up in.
//
// Safety rail: any destructive command refuses to run unless the target
// database name ends in `_test`. Wiping tjsl_dev because TEST_DATABASE_URL was
// unset is not an acceptable failure mode, so an unset TEST_DATABASE_URL is a
// hard error, never a silent fallback to DATABASE_URL.
import { Client } from "pg";

const ROOT = new URL("..", import.meta.url).pathname;

export function databaseNameOf(connectionString: string): string {
  // Not using `new URL(...).pathname` alone: a socket-style or password-with-
  // slash URL can make that surprising. Take the last path segment, strip any
  // query string, and refuse anything that does not look like a db name.
  const withoutQuery = connectionString.split("?")[0] ?? "";
  const name = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  if (!name || name.includes(":") || name.includes("@")) {
    throw new Error(`Cannot read a database name out of connection string: ${redact(connectionString)}`);
  }
  return name;
}

export function redact(connectionString: string): string {
  return connectionString.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

/** A URL is safe to wipe only if its database name ends in `_test`. */
export function isTestDatabase(connectionString: string): boolean {
  return databaseNameOf(connectionString).endsWith("_test");
}

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set.\n" +
        "  Local: copy .env.example to .env (it ships the right value), or export it.\n" +
        "  CI:    set it in the workflow env block.\n" +
        "  It must point at a database whose name ends in _test.",
    );
  }
  if (!isTestDatabase(url)) {
    throw new Error(
      `Refusing to use TEST_DATABASE_URL=${redact(url)}: database name ` +
        `"${databaseNameOf(url)}" does not end in _test. This guard exists so a ` +
        "misconfigured env can never wipe the dev database.",
    );
  }
  return url;
}

function requireDevUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  return url;
}

/** Run tools/migrate.ts as a child process with DATABASE_URL pointed at `url`. */
async function runMigrations(url: string, label: string): Promise<void> {
  console.log(`migrations up on ${label} (${redact(url)})`);
  const proc = Bun.spawn(["bun", `${ROOT}tools/migrate.ts`, "up"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`migrations failed on ${label} (exit ${code})`);
}

async function wipeTestSchema(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // DROP SCHEMA public CASCADE takes every table, view, sequence, type,
    // function and trigger in it, including the _migrations bookkeeping table,
    // so the following migrate run replays the whole history from 0001.
    await client.query("BEGIN");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  console.log(`wiped schema public on ${databaseNameOf(url)}`);
}

async function reset(): Promise<void> {
  const url = requireTestUrl();
  await wipeTestSchema(url);
  await runMigrations(url, "test DB");
  console.log("test database reset: schema dropped, all migrations replayed.");
}

async function seed(): Promise<void> {
  const url = requireTestUrl();
  // Placeholder on purpose. Seeds are phase-scoped (Fase 0 master data, Fase 9
  // 24 months of transactions per docs/BUILD-PLAN.md) and belong in
  // tools/seed/*.ts as they are written. This command is the stable entry
  // point those phases hook into, so nothing downstream has to change later.
  console.log(`seed: nothing to seed yet (target ${redact(url)}).`);
  console.log("      Phase seeds land in tools/seed/ and get wired in here.");
}

function status(): void {
  const dev = process.env.DATABASE_URL;
  const test = process.env.TEST_DATABASE_URL;
  console.log(`DATABASE_URL      ${dev ? redact(dev) : "(unset)"}`);
  console.log(`TEST_DATABASE_URL ${test ? redact(test) : "(unset)"}`);
  if (test) {
    console.log(`test db name      ${databaseNameOf(test)} (wipe allowed: ${isTestDatabase(test)})`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "migrate":
      await runMigrations(requireDevUrl(), "dev DB");
      break;
    case "migrate:test":
      await runMigrations(requireTestUrl(), "test DB");
      break;
    case "reset":
      await reset();
      break;
    case "seed":
      await seed();
      break;
    case "status":
      status();
      break;
    default:
      console.error("Usage: bun tools/db.ts <migrate|migrate:test|reset|seed|status>");
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
