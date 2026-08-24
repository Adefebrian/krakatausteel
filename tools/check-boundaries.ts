// Enforces the module boundaries described in skills/jal-architecture:
//   - a module may only reach a sibling module through that sibling's
//     index.ts (never a deep import into its internals)
//   - a module may never import a raw infra client (pg/ioredis/etc); infra
//     always sits behind a port in src/core/
//   - no code outside modules/jurnal/** writes to the ledger tables in raw
//     SQL (spec Bagian 3 invariant 11: every financially consequential event
//     posts through postingEvent, one central path, or the ledger cannot be
//     reconciled and the subledger silently drifts from the buku besar)
//
// For the import rules, core/** is deliberately NOT scanned: core is where
// adapters are allowed to touch raw infra clients directly, per the
// ports-and-adapters pattern. The ledger-write rule scans wider, see
// LEDGER_SCAN below.
import { Glob } from "bun";

const root = new URL("../apps/api/src/", import.meta.url).pathname;
const repoRoot = new URL("..", import.meta.url).pathname;
const files = [...new Glob("modules/**/*.ts").scanSync(root)];

const RAW_INFRA = ["pg", "postgres", "ioredis", "redis", "@aws-sdk/client-s3"];

// The shared lib/* wrappers (apps/api/src/lib/{db,redis,s3,ai}.ts) hold the
// actual raw infra client construction (`new Pool(...)`, `new Redis(...)`,
// etc). core/adapters/*.ts is the one place allowed to import them, wrapping
// each one behind a core/ports/*.ts port. A module that imports lib/* directly
// skips that port entirely, so it is a boundary violation just like importing
// the raw infra package itself (see RAW_INFRA above).
const LIB_WRAPPER_RE = /(?:^|\/)lib\/(db|redis|s3|ai)(?:\.ts)?$/;

const violations: string[] = [];

for (const rel of files) {
  const self = rel.split("/")[1];
  const src = await Bun.file(root + rel).text();
  const importRe = /import[^"']*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src))) {
    const spec = m[1];

    // A one-level-up relative import ("../<name>/...") reaches into a
    // sibling folder under modules/. A two-or-more-level-up import
    // ("../../core/...", "../../lib/...") escapes modules/ entirely and is
    // not a sibling-module reference, so it is deliberately excluded here
    // via the negative lookahead.
    const sib = spec.match(/^\.\.\/(?!\.\.\/)([^/]+)(\/.*)?$/);
    if (sib && sib[1] !== self && sib[2] && !/^\/index(\.ts)?$/.test(sib[2])) {
      violations.push(`${rel}: deep import into sibling module "${sib[1]}" (${spec})`);
    }

    // Catches any import spec that names another module's internals by
    // path, however it got there (alias, absolute, workspace-relative).
    const deep = spec.match(/modules\/([^/]+)\/(.+)$/);
    if (deep && deep[1] !== self && !/^index(\.ts)?$/.test(deep[2])) {
      violations.push(`${rel}: deep import into module "${deep[1]}" (${spec})`);
    }

    if (RAW_INFRA.includes(spec)) {
      violations.push(`${rel}: raw infra import "${spec}"; use a core port instead`);
    }

    if (LIB_WRAPPER_RE.test(spec)) {
      violations.push(`${rel}: direct import of shared lib wrapper "${spec}"; use a core port instead`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ledger-write rule (invariant 11, static second line of defence)
// ---------------------------------------------------------------------------
//
// The primary guard is a database trigger gated on a transaction-scoped
// `SET LOCAL tjsl.jalur_posting`, so Postgres itself refuses a journal row
// that did not come through the engine. This check exists because the trigger
// only fires at runtime, inside a transaction, in a test that happens to be
// written. A copy-pasted `insert into jurnal_baris` in a new module should be
// caught in the gate, before it ever reaches Postgres, with a message that
// says what to use instead.
//
// Scope decisions, made deliberately and worth arguing with if you disagree:
//
//   - Guarded tables are `jurnal` and `jurnal_baris` only. `jurnal_ekspor` is
//     an export audit log, not a ledger table: writing it does not move money
//     and does not affect balance, so guarding it would be noise.
//   - Scanned: modules/** (the rule as specified), core/** (a "helper" in core
//     that posts journals would defeat the rule just as thoroughly, and core
//     contains no business-table SQL today, so this costs nothing), and any
//     seed directory. Seeds are in scope on purpose: spec Bagian 13 requires
//     seed data to be created through the engine, and a seed that raw-inserts
//     journal rows produces exactly the unbalanced demo ledger the invariant
//     exists to prevent. The seed directories do not exist yet; they are
//     listed now so the rule is already in force on the day they appear.
//   - Exempt: modules/jurnal/** in full, including its own test-support.ts and
//     tests. That module IS the central path; its repo is the one place raw
//     ledger SQL belongs, and its concurrency test has to be able to construct
//     rows behind the engine's back to prove the trigger holds.
//   - NOT exempt: `*.test.ts` and `test-support.ts` outside modules/jurnal/**.
//     A blanket test exemption would remove the rule from precisely the files
//     most likely to be copy-pasted into production code. A fixture in, say,
//     modules/angsuran that genuinely needs ledger state should either call
//     the engine (which is what production does, so the fixture then proves
//     more) or carry an explicit one-line exemption, below.
//
// Escape hatch, narrow and visible on purpose: put
//
//   // boundary-allow: ledger-write <reason, at least 10 characters>
//
// on the line directly above the statement (that exact line, not a window:
// one pragma exempts one statement and nothing else). Every active exemption
// is printed by this checker on every run, so exemptions cannot accumulate
// unnoticed; a diff that adds one is a diff a reviewer can see.
const LEDGER_SCAN: Array<{ base: string; glob: string }> = [
  { base: root, glob: "modules/**/*.ts" },
  { base: root, glob: "core/**/*.ts" },
  { base: root, glob: "seed/**/*.ts" },
  { base: repoRoot, glob: "tools/seed/**/*.ts" },
];

const LEDGER_EXEMPT_DIR = /(?:^|\/)modules\/jurnal\//;

// `insert into jurnal`, `update jurnal set`, `delete from jurnal_baris where`,
// with optional `only`, `public.` and double quotes. jurnal_baris is listed
// first so the alternation cannot match the `jurnal` prefix of it and then
// fail the trailing lookahead. The trailing lookahead requires the next token
// to be the start of a real statement body, which keeps prose like "the jurnal
// update was rejected" from matching.
const LEDGER_WRITE_RE =
  /\b(insert\s+into|update|delete\s+from)\s+(?:only\s+)?(?:public\.)?"?(jurnal_baris|jurnal)"?(?![\w$])\s*(?=\(|set\b|where\b|values\b|select\b|as\b|;|$)/gim;

const LEDGER_ALLOW_RE = /boundary-allow:\s*ledger-write\s+(\S.{9,})/i;

/**
 * Blank out // and /* *\/ comments, preserving every byte position and line
 * break so reported line numbers stay accurate.
 *
 * Why strip comments at all: a regex over raw source matches the word inside
 * a comment, and a comment saying "never insert into jurnal here" is exactly
 * the comment a careful author writes. Stripping removes that whole class of
 * false positive. The cost is that a commented-out raw insert is not flagged,
 * which is fine: dead code moves no money, and it becomes live (and flagged)
 * the moment someone uncomments it.
 *
 * String literals are deliberately NOT stripped: raw SQL lives in template
 * literals, so stripping them would delete the only thing this rule looks at.
 * The residual false positive is a human-facing message that spells out a full
 * SQL statement shape, e.g. throw new Error("jangan insert into jurnal (...)").
 * Reword it or add an exemption; the rule stays narrow either way.
 */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const ledgerExemptions: string[] = [];

for (const { base, glob } of LEDGER_SCAN) {
  for (const rel of new Glob(glob).scanSync(base)) {
    const shown = base === repoRoot ? rel : `apps/api/src/${rel}`;
    if (LEDGER_EXEMPT_DIR.test(`/${rel}`)) continue;

    const raw = await Bun.file(base + rel).text();
    const src = blankComments(raw);
    const lines = raw.split("\n");

    let m: RegExpExecArray | null;
    LEDGER_WRITE_RE.lastIndex = 0;
    while ((m = LEDGER_WRITE_RE.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length;
      const statement = m[0].replace(/\s+/g, " ").trim();

      // Exactly the one line directly above the statement, not a window.
      // A three-line window let a single pragma silently bless three
      // consecutive statements, which is how a narrow exemption turns into a
      // blanket one. One pragma, one statement, and the reviewer can count
      // them in the diff.
      const above = lines[line - 2] ?? "";
      const allow = LEDGER_ALLOW_RE.exec(above);
      if (allow) {
        ledgerExemptions.push(`${shown}:${line}: "${statement}" allowed: ${allow[1].trim()}`);
        continue;
      }

      violations.push(
        `${shown}:${line}: raw ledger write "${statement}"; only modules/jurnal/** may write ` +
          "jurnal or jurnal_baris. Post through postingEvent from modules/jurnal (invariant 11).",
      );
    }
  }
}

if (ledgerExemptions.length > 0) {
  console.log(`LEDGER-WRITE EXEMPTIONS (${ledgerExemptions.length}), review every one:`);
  for (const line of ledgerExemptions) console.log(`  ${line}`);
}

if (violations.length > 0) {
  console.error("BOUNDARY CHECK FAIL:\n" + violations.join("\n"));
  process.exit(1);
}

console.log("BOUNDARY CHECK PASS");
