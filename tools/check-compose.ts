#!/usr/bin/env bun
// tools/check-compose.ts - static validation of infra/docker-compose.prod.yml.
//
// `docker compose config` is the real validator, but it needs a running Docker
// daemon, and the dev machine for this project has none (see infra/DEPLOY.md:
// local dev uses native Postgres and Redis, not containers). Rather than skip
// validation until deploy day, this checks statically the things that actually
// break deploys, with no daemon:
//
//   1. the compose file is valid YAML and has a services map;
//   2. every ${VAR} the compose file interpolates is documented in
//      infra/DEPLOY.md AND present as a key in .env.example, so a fresh clone
//      cannot be missing a variable that only shows up as an empty string
//      inside a container at 2am;
//   3. no stateful service (Postgres, Redis, MinIO) publishes a host port;
//   4. every service declares a healthcheck, so `depends_on: condition:
//      service_healthy` has something to wait on;
//   5. no secret is hardcoded: anything named *PASSWORD/*SECRET/*KEY/*TOKEN
//      must come from an interpolated variable, never a literal;
//   6. .env.example covers every key packages/config's env schema parses, and
//      carries no real secret values.
//
// This is not a substitute for `docker compose config`; it is what can be
// verified honestly today. Run the real thing before the first deploy.
const ROOT = new URL("..", import.meta.url).pathname;
const COMPOSE = `${ROOT}infra/docker-compose.prod.yml`;
const DEPLOY_DOC = `${ROOT}infra/DEPLOY.md`;
const ENV_EXAMPLE = `${ROOT}.env.example`;
const ENV_SCHEMA = `${ROOT}packages/config/src/env.ts`;

const STATEFUL_IMAGE = /postgres|redis|minio|mysql|mariadb|mongo|clickhouse|elasticsearch|rabbitmq/i;
const SECRETISH = /(PASSWORD|SECRET|_KEY|TOKEN|CREDENTIAL)/i;
// Values that are allowed to sit in .env.example for a secret-ish key: empty,
// or an explicit placeholder that cannot be mistaken for a working credential.
const SAFE_PLACEHOLDER = /^$|^(change-?me|changeme|replace-?me|dev-only[\w-]*|placeholder|<[^>]+>)$/i;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

function envExampleKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

function envExampleEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (m) entries.set(m[1]!, (m[2] ?? "").trim());
  }
  return entries;
}

/** Every ${VAR} / ${VAR:-default} / ${VAR:?err} referenced in the raw file. */
function interpolatedVars(raw: string): string[] {
  const found = new Set<string>();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?][^}]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) found.add(m[1]!);
  return [...found].sort();
}

function walkStrings(node: unknown, path: string, visit: (path: string, value: string) => void): void {
  if (typeof node === "string") return visit(path, node);
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkStrings(item, `${path}[${i}]`, visit));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walkStrings(value, path ? `${path}.${key}` : key, visit);
    }
  }
}

const raw = await Bun.file(COMPOSE).text();
const deployDoc = await Bun.file(DEPLOY_DOC).text();
const envExampleText = await Bun.file(ENV_EXAMPLE).text();

// --- 1. YAML parses -------------------------------------------------------
let doc: any;
try {
  doc = Bun.YAML.parse(raw);
  record("compose YAML parses", true, `${raw.split("\n").length} lines`);
} catch (err) {
  record("compose YAML parses", false, err instanceof Error ? err.message : String(err));
  report();
}

const services: Record<string, any> = doc?.services ?? {};
const serviceNames = Object.keys(services);
record("services map present", serviceNames.length > 0, serviceNames.join(", "));

// --- 2. interpolated vars documented + in .env.example --------------------
const vars = interpolatedVars(raw);
const exampleKeys = envExampleKeys(envExampleText);
const undocumented = vars.filter((v) => !new RegExp(`\\b${v}\\b`).test(deployDoc));
const missingFromExample = vars.filter((v) => !exampleKeys.has(v));
record(
  `every \${VAR} documented in infra/DEPLOY.md (${vars.length} vars)`,
  undocumented.length === 0,
  undocumented.length ? `missing: ${undocumented.join(", ")}` : vars.join(", "),
);
record(
  `every \${VAR} present in .env.example (${vars.length} vars)`,
  missingFromExample.length === 0,
  missingFromExample.length ? `missing: ${missingFromExample.join(", ")}` : "all present",
);

// --- 3. no stateful service publishes host ports --------------------------
const publishing: string[] = [];
const statefulNames: string[] = [];
for (const [name, svc] of Object.entries(services)) {
  const image = typeof svc?.image === "string" ? svc.image : "";
  if (!STATEFUL_IMAGE.test(image)) continue;
  statefulNames.push(name);
  if (svc?.ports) publishing.push(`${name} -> ${JSON.stringify(svc.ports)}`);
}
record(
  `stateful services publish no host ports (${statefulNames.join(", ")})`,
  publishing.length === 0,
  publishing.length ? publishing.join("; ") : "none publish",
);

// --- 4. healthchecks present ---------------------------------------------
const noHealthcheck = serviceNames.filter((name) => !services[name]?.healthcheck?.test);
record(
  `every service declares a healthcheck (${serviceNames.length} services)`,
  noHealthcheck.length === 0,
  noHealthcheck.length ? `missing: ${noHealthcheck.join(", ")}` : "all present",
);

// depends_on: service_healthy is only meaningful if the target has one.
const badDeps: string[] = [];
for (const [name, svc] of Object.entries(services)) {
  const deps = svc?.depends_on;
  if (!deps || Array.isArray(deps)) continue;
  for (const [dep, cond] of Object.entries(deps as Record<string, any>)) {
    if (cond?.condition === "service_healthy" && !services[dep]?.healthcheck?.test) {
      badDeps.push(`${name} waits on ${dep} health, but ${dep} has no healthcheck`);
    }
  }
}
record("service_healthy dependencies target a service with a healthcheck", badDeps.length === 0, badDeps.join("; "));

// --- 5. no hardcoded secrets in compose ----------------------------------
const hardcoded: string[] = [];
walkStrings(doc, "", (path, value) => {
  const leaf = path.split(".").pop() ?? "";
  if (!SECRETISH.test(leaf)) return;
  if (value.includes("${")) return;
  if (value === "" || value === "false" || value === "true") return;
  hardcoded.push(`${path}=${value}`);
});
record("no hardcoded secret values in compose", hardcoded.length === 0, hardcoded.join("; "));

// --- 6. .env.example covers the app env schema, holds no real secrets -----
const schemaText = await Bun.file(ENV_SCHEMA).text();
const schemaBody = schemaText.slice(schemaText.indexOf("z.object("));
const schemaKeys = [...schemaBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]!);
const schemaMissing = schemaKeys.filter((k) => !exampleKeys.has(k));
record(
  `.env.example covers packages/config env schema (${schemaKeys.length} keys)`,
  schemaMissing.length === 0,
  schemaMissing.length ? `missing: ${schemaMissing.join(", ")}` : schemaKeys.join(", "),
);

const entries = envExampleEntries(envExampleText);
const suspicious = [...entries]
  .filter(([key, value]) => SECRETISH.test(key) && !SAFE_PLACEHOLDER.test(value))
  .map(([key]) => key);
record(
  ".env.example carries no real secret values",
  suspicious.length === 0,
  suspicious.length ? `non-placeholder values: ${suspicious.join(", ")}` : "all secret-ish keys empty or placeholder",
);

report();

function report(): never {
  const failed = checks.filter((c) => !c.ok);
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("static validation of infra/docker-compose.prod.yml (no Docker daemon used)");
  console.log("-".repeat(width + 12));
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}${c.detail ? `  ${c.detail}` : ""}`);
  }
  console.log("-".repeat(width + 12));
  if (failed.length) {
    console.error(`${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`${checks.length} checks passed. Run \`docker compose -f infra/docker-compose.prod.yml config\` on the server before the first deploy.`);
  process.exit(0);
}
