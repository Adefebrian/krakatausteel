#!/usr/bin/env bun
// tools/verify.ts - the single local gate. `bun run verify`.
//
// docs/BUILD-PLAN.md says no phase is done until build, test and the boundary
// check are all green. This runs exactly that, in a fixed order, with the test
// database rebuilt from migrations first so the suite starts from a known
// schema instead of whatever the last run left behind.
//
// Contract:
//   - steps run in order, output streams straight through (no buffering, so a
//     hanging step is visible while it hangs);
//   - the first failing step stops the run and the process exits non-zero;
//   - the last line is a summary table of every step and its pass/fail state,
//     so a failed gate is readable without scrolling back through build noise.
//
// Optional steps declare a `skipIf`: on a machine with no Postgres reachable
// the DB steps are reported as SKIP rather than failing the whole gate, and the
// summary says so out loud. Nothing else is skippable.
import { Client } from "pg";

const ROOT = new URL("..", import.meta.url).pathname;

interface Step {
  name: string;
  cmd: string[];
  /** Return a reason string to skip, or null to run. */
  skipIf?: () => Promise<string | null>;
}

type State = "pass" | "fail" | "skip";

interface Result {
  name: string;
  state: State;
  ms: number;
  detail?: string;
}

async function postgresReachable(): Promise<string | null> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return "TEST_DATABASE_URL not set";
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return null;
  } catch (err) {
    await client.end().catch(() => {});
    return `cannot connect to test database (${err instanceof Error ? err.message : String(err)})`;
  }
}

const steps: Step[] = [
  {
    name: "db:reset (test schema + migrations)",
    cmd: ["bun", "tools/db.ts", "reset"],
    skipIf: postgresReachable,
  },
  // Typecheck is its own step, and it runs before build and test on purpose.
  // apps/api defines `build` as `echo ... && exit 0` (the API ships as
  // TypeScript source for the Bun runtime), so without this step the largest
  // package in the repo got zero type checking in the one command everyone
  // treats as the gate: a type error surfaced later as a confusing test
  // failure, or not at all. Fastest signal first, before build and test spend
  // time on code that does not typecheck.
  { name: "typecheck", cmd: ["bun", "run", "typecheck"] },
  { name: "build", cmd: ["bun", "run", "build"] },
  { name: "test", cmd: ["bun", "test"] },
  { name: "check:boundaries", cmd: ["bun", "run", "check:boundaries"] },
  { name: "check:compose (static, no Docker)", cmd: ["bun", "tools/check-compose.ts"] },
];

const HR = "-".repeat(64);

async function run(): Promise<number> {
  const results: Result[] = [];
  const startedAll = Date.now();

  for (const [index, step] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${step.name}`;
    const skipReason = step.skipIf ? await step.skipIf() : null;
    if (skipReason) {
      console.log(`\n${HR}\n${label}  SKIP: ${skipReason}\n${HR}`);
      results.push({ name: step.name, state: "skip", ms: 0, detail: skipReason });
      continue;
    }

    console.log(`\n${HR}\n${label}  $ ${step.cmd.join(" ")}\n${HR}`);
    const started = Date.now();
    const proc = Bun.spawn(step.cmd, {
      cwd: ROOT,
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    const ms = Date.now() - started;

    if (code !== 0) {
      results.push({ name: step.name, state: "fail", ms, detail: `exit ${code}` });
      summary(results, Date.now() - startedAll);
      console.error(`\nverify FAILED at step ${index + 1}: ${step.name}`);
      return 1;
    }
    results.push({ name: step.name, state: "pass", ms });
  }

  summary(results, Date.now() - startedAll);
  const skipped = results.filter((r) => r.state === "skip");
  console.log(
    skipped.length === 0
      ? "\nverify PASSED"
      : `\nverify PASSED with ${skipped.length} skipped step(s), see above`,
  );
  return 0;
}

function summary(results: Result[], totalMs: number): void {
  const width = Math.max(...results.map((r) => r.name.length), 20);
  console.log(`\n${HR}\nverify summary\n${HR}`);
  for (const r of results) {
    const state = r.state.toUpperCase().padEnd(4);
    const time = r.state === "skip" ? "" : `${(r.ms / 1000).toFixed(2)}s`;
    const detail = r.detail && r.state !== "fail" ? `  (${r.detail})` : r.detail ? `  ${r.detail}` : "";
    console.log(`${state}  ${r.name.padEnd(width)}  ${time.padStart(7)}${detail}`);
  }
  console.log(`${HR}\ntotal ${(totalMs / 1000).toFixed(2)}s`);
}

run().then((code) => process.exit(code));
