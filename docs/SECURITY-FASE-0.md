# Security review, Fase 0

Scope: `b8983ff` (auth, RBAC, branch scoping, audit log, konfigurasi, nomor,
organisasi, hardening) plus the working tree. Target: `apps/api`, `apps/web`,
`infra/`, `packages/config`, `tools/`.

Method: read the code adversarially, then prove or disprove each hypothesis with
a live probe against the real app factory (`createApp`) and, where the socket
matters, against a real `Bun.serve`. Probes were run from a scratch directory and
are not committed; every command needed to reproduce is inline below.

Line numbers are as of the working tree at review time.

---

## Verdict on the headline question

**No cross-branch data path was found.** Every probe against the branch scope was
refused. What is broken in this area is not the *check*, it is the *evidence*:
a cross-branch attempt is refused silently, with no audit row (F-1). For a system
whose numbers get audited, "we refused it and cannot prove it happened" is the
finding that matters most here.

Details of what was tried and held are in "Categories with nothing to report".

---

## Findings, ranked by real exploitability

| # | Severity | Title |
|---|---|---|
| F-1 | High | Cross-branch denials are not written to `audit_log` (spec 2 rule 5 gap) |
| F-2 | High | Login rate limiter is a remote account-lockout weapon |
| F-3 | High | `/example` is mounted in the shipped app: anonymous write + unbounded permanent keys in the session Redis |
| F-4 | Medium | `X-Forwarded-For` is believed without proving the request came through a trusted proxy |
| F-5 | Medium | `audit_log` "append only" does not cover `TRUNCATE` |
| F-6 | Medium | `/audit` has no branch scope at all; it is safe only by RBAC accident |
| F-7 | High (availability) | The API process cannot boot in the shipped configuration |
| F-8 | Low | Body-size guard is `Content-Length`-only; a chunked body walks past it |
| F-9 | Low | The SPA still ships the demo login stub that mints a fake Admin Pusat session |
| F-10 | Low | `db:seed:dev` will plant the public demo credentials on any database, and will overwrite a colliding real account's password |
| F-11 | Low | `SESSION_SECRET` is a phantom secret in the deploy contract |
| F-12 | Low | `DATABASE_URL` has a working default |

Dependency vulnerabilities: **fixed** (see "Dependencies", 4 findings -> 0).

---

### F-1 (High) Cross-branch denials are not audited

**Where** `apps/api/src/core/principal.ts:81-92` (`assertCabangAllowed`), and
every caller: `apps/api/src/modules/organisasi/service.ts:56`, `:66`, `:78`.

**What** `assertCabangAllowed` throws `forbidden(...)` directly. The guard layer
(`modules/auth/guards.ts:42-56`, `denied()`) is the only place that writes a
`DITOLAK` row, and the branch check does not go through it. So a
permission-level denial is recorded and a *branch*-level denial is not, even
though the branch denial is the one spec 16 scenario 24 exists for and the one
that means "someone is probing another branch's money".

**Attack** Authenticate as a branch-bound role and walk another branch's ids.
Every attempt is refused, and the trail is empty afterwards. There is nothing to
alert on and nothing to show an auditor.

**Proof** For each request, `audit_log` was counted before and after:

```
cross-branch karyawan/:idB      status=403 rows+0
cross-branch ?cabangId=B        status=403 rows+0
cross-branch cabang/:idB        status=403 rows+0
missing permission (/konfigurasi) status=403 rows+2   <- login + denial, correct
no session                      status=401 rows+1     <- correct
bad Origin on a mutation        status=403 rows+0
oversize declared body          status=413 rows+0
```

**Minimal fix** Route the branch check through the same audit path as the
permission check. Two options, both small:

1. Add an optional recorder to the scope check and pass it from the route layer:
   `assertCabangAllowed(principal, row.cabang_id, { audit, actor, entitas, entitasId })`.
2. Cheaper and it covers every future phase for free: in `core/http.ts`'s
   `errorHandler`, when `err instanceof AppError && err.code === "TIDAK_BERWENANG"`
   and no `DITOLAK` row has been written for this request, write one. Mark the
   request in the context when `denied()` already wrote one, so it is not
   double-logged. This also closes the same gap for the `Origin` rejection.

Option 2 is the recommendation: it makes "every denial is logged" a property of
the error handler rather than a thing each author must remember.

---

### F-2 (High) The login limiter is a remote account-lockout weapon

**Where** `apps/api/src/modules/auth/service.ts:274-295`, with
`LOGIN_LIMIT_PER_USERNAME = 5` / `LOGIN_WINDOW_SECONDS = 300` at `:38-39`, and
the key at `:174-175`.

**What** The per-username counter is consumed *before* the password is verified,
and the limiter is fail-closed. Five wrong-password attempts against a username
therefore lock the real owner of that account out for five minutes. The
successful-login reset at `:330` never runs, because the legitimate login is
refused at the limiter before it gets to `Bun.password.verify`.

**Attack** Two requests per minute against a known username is a permanent
lockout. Usernames are guessable by construction (`adminpusat`, `auditor`,
`approver`, and the seeded set in `SEED.md`). Cost to the attacker: nothing.
Effect: the only account that can post a journal, close a period or read the
audit trail is unavailable. The per-IP ceiling (10/300s) does not help, since
5 attempts is under it and one IP can lock two accounts per window.

The key is `username.toLowerCase()`, so case does not evade the lockout either
(spraying `MAKER.X` locks `maker.x`).

**Proof**

```
attacker, 6 wrong passwords on the victim's username: [401,401,401,401,401,429]
victim, CORRECT password, different source address:   429
  {"error":"Terlalu banyak upaya masuk. Coba lagi dalam 300 detik.", ...}

uppercase spray locks the lowercase victim:           429
```

**Minimal fix** Keep the fail-closed policy and the per-IP counter as they are.
Change the per-username counter from *consume-then-verify* to
*verify-then-consume-on-failure*:

- check only the per-IP counter before doing work (that is the CPU-spend
  defence);
- verify the credential;
- on failure, `consume(usernameKey(...))` and, if that consume reports the
  username over its ceiling, return the 429 instead of the 401;
- on success, return the session (and keep the existing `reset`).

A correct password then always succeeds, so an attacker can no longer deny
service to a third party, while a spray against one account still hits the wall
after 5 wrong guesses.

---

### F-3 (High) `/example` is mounted in the shipped app

**Where** `apps/api/src/core/app.ts:119` (`.route("/example", createExampleModule(...))`),
routes at `apps/api/src/modules/example/routes.ts:16-29`, cache adapter at
`apps/api/src/core/adapters/redis.ts:11-17`.

**What** The scaffolding template module is wired into the production app with
no `requireSession` and no permission. It exposes:

- `POST /example` - anonymous write into an unbounded in-process array
  (`modules/example/repo.ts:24-32`), `name` length unbounded up to the body
  limit;
- `GET /example/:id/views` - anonymous `INCR example:views:<id>` where `<id>` is
  an arbitrary path segment, **with no expiry set**.

The Redis that backs `example:views:*` is the same Redis that holds the session
store (`tjsl:sess:*`, `modules/auth/session.ts:22`), and the `KeyValueStorePort`
used for sessions throws on failure by design. So filling Redis is not a
degraded-cache event, it is an authentication outage: `sessions.create` throws
(login fails, `service.ts:86-89`) and the fail-closed login limiter then refuses
everything. `infra/docker-compose.prod.yml:118-121` runs Redis with
`--appendonly yes` and no `maxmemory`, so the AOF grows on disk too.

**Attack** Unauthenticated, no session, no rate-limit ceiling worth mentioning
(the global limiter is 120/min/IP and **fails open**, `core/ports/ratelimit.ts:8-10`):

```
GET /api/example/<uuid>/views   x N distinct uuids
```

**Proof**

```
anonymous POST /example                     201
anonymous GET  /example items               1
redis keys created by 25 anonymous GETs     25
ttl of those keys (-1 = never expires)      [-1, -1, -1]
```

Confirmed on the real server too: `anon POST /example` -> 201,
`anon GET /example/<uuid>/views` -> 200.

**Minimal fix** Delete the `.route("/example", ...)` line from `core/app.ts`.
The module is a template for the boundary checker, not a feature; nothing in
`apps/web` calls it. If it must stay reachable, put `guards.requireSession` and
`guards.requirePermission("dashboard.view")` in front of all three routes and
have `recordView` call `cache.expire(key, 3600)` after the `incr`.

---

### F-4 (Medium) `X-Forwarded-For` is trusted without proving the peer

**Where** `apps/api/src/core/client-ip.ts:214-253` (`resolveClientIp`).

**What** The function takes the socket address as an input but only ever uses it
as a *fallback*. It never checks that the request actually arrived from one of
our proxies before consuming XFF hops. Two configurations are forgeable:

- `TRUSTED_PROXY_CIDRS` set with `TRUSTED_PROXY_COUNT` unset (the documented
  "proxy depth varies" mode). `count === 0` and `cidrs.length > 0`, so the
  early return at `:217` does not fire. If no hop matches a trusted CIDR, the
  walk consumes nothing, `remaining = max(0, 0 - 0 - 1) = 0`, and `index` is
  still the rightmost hop, which is returned. That hop is pure client input.
- `TRUSTED_PROXY_COUNT=1` (the production value,
  `infra/docker-compose.prod.yml:84`) on a request that did not pass through
  Caddy: a single forged hop is returned as the client.

**Attack** Rotate the rate-limit bucket at will (`core/hardening.ts:179` keys on
the resolved IP), pin a victim's address into someone else's bucket, and write
attacker-chosen values into `audit_log.ip` - which is the column that exists to
make abuse attributable. The file header of `client-ip.ts:6-14` states exactly
this threat; the check is one step short of preventing it.

**Proof** Against a real `Bun.serve` (so `socketAddress()` is a genuine peer):

```
config                     no XFF        XFF: 9.9.9.9    XFF: 9.9.9.9, 127.0.0.1
count=0 (default)          ::1           ::1             ::1                <- correct
count=1 (production)       ::1           9.9.9.9         127.0.0.1          <- forged
cidrs=127.0.0.0/8          ::1           9.9.9.9         9.9.9.9            <- forged
```

The third row is the sharpest: the socket peer was `::1`, which is *not* in
`127.0.0.0/8`, yet a client-supplied `127.0.0.1` hop was accepted as "one of our
proxies" and the hop to its left was returned as the client.

Note `socketAddress()` does work correctly under `Bun.serve` (column 1), so the
default `count=0` posture is genuinely safe. This is only about the two
configured modes.

**Minimal fix** In `resolveClientIp`, require the peer itself to be trusted
before consuming any hop:

```ts
// after computing `socket`, before the hop walk
if (config.cidrs.length > 0) {
  if (!socket || !config.cidrs.some((cidr) => ipInCidr(socket, cidr))) return socket;
}
```

That closes the CIDR mode completely. `count`-only mode cannot be verified from
the header alone, so pair it with the CIDR check in production: add
`TRUSTED_PROXY_CIDRS` for the Caddy container's network to
`infra/docker-compose.prod.yml` next to `TRUSTED_PROXY_COUNT`, and state in
`core/client-ip.ts` that count-only mode assumes the API port is unreachable
except through the proxy.

---

### F-5 (Medium) `audit_log` append-only does not cover `TRUNCATE`

**Where** `migrations/0014_lintas_sistem.sql:44-46`:

```sql
CREATE TRIGGER trg_audit_log_90_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION tjsl_audit_log_append_only();
```

**What** `UPDATE` and `DELETE` are refused, `TRUNCATE` is not. Row-level
triggers cannot fire on `TRUNCATE` at all; it needs a statement-level
`BEFORE TRUNCATE` trigger.

**Proof** Same connection the application uses:

```
UPDATE   refused: TJSL-AUD-001: audit_log bersifat append only; UPDATE tidak diizinkan
DELETE   refused: TJSL-AUD-001: audit_log bersifat append only; DELETE tidak diizinkan
TRUNCATE ALLOWED
```

**Exploitability** There is no `TRUNCATE` anywhere in the app layer and no
injection path was found (see "nothing to report"), so this is not remotely
reachable today. It matters because it is exactly the gap the stated guarantee
claims to have closed: the whole trail can be erased in one statement by anything
holding the app's own database credentials.

**Minimal fix** (owner: whoever holds `migrations/**` - not touched here)

```sql
CREATE TRIGGER trg_audit_log_91_no_truncate
  BEFORE TRUNCATE ON audit_log
  EXECUTE FUNCTION tjsl_audit_log_append_only();
```

The existing function already reports `TG_OP`, so the message comes out right
with no change to it. Worth applying to the other append-only tables named in
`migrations/0002_konvensi_bersama.sql:72` at the same time.

---

### F-6 (Medium) `/audit` has no branch scope

**Where** `apps/api/src/modules/audit/routes.ts:32-48` and
`apps/api/src/modules/audit/repo.ts:98-124`.

**What** The list query filters on `userId`, `entitas`, `entitasId`, `aksi`,
`hasil` and `limit`, and on nothing else. There is no branch predicate, and
`audit_log` has no `cabang_id` column (`migrations/0014_lintas_sistem.sql:15`).
The endpoint is safe today only because `audit.view` happens to be granted to
`AUDITOR` and `ADMIN_PUSAT` (`modules/auth/permissions.ts:181-189`, `:245`),
both of which are `lintasCabang`. Spec 4.1 makes RBAC *data* ("an operator can
add a role", and `modules/auth/service.ts:220-222` reads the grant table rather
than a constant), so that alignment is a convention, not a control.

**Proof**

```
MAKER 403   CHECKER 403   APPROVER 403   ADMIN_CABANG 403
ADMIN_PUSAT 200   AUDITOR 200
```

then, granting `audit.view` to `MAKER` in `role_permission` (one INSERT, exactly
what a Fase 8 user-admin screen will do):

```
MAKER after grant: 200 rows=50   (rows from every branch, unfiltered)
```

**Exploitability** Not reachable through the API today: Fase 0 ships no
role/permission write endpoint. It becomes reachable the moment the
`konfigurasi.user` screens land.

**Minimal fix** One line in the route, until the trail carries a branch:

```ts
.get("/", guards.requireSession, guards.requirePermission("audit.view"), async (c) => {
  const principal = requirePrincipal(c);
  if (!principal.lintasCabang) throw forbidden("Jejak audit hanya untuk peran lintas cabang");
  ...
```

Longer term, denormalise `cabang_id` onto `audit_log` and scope with the existing
`cabangScopeFilter` (`core/principal.ts:106-114`), which is what makes a branch
admin able to see their own branch's trail without seeing everyone's.

---

### F-7 (High, availability) The API cannot boot in the shipped configuration

**Where** `apps/api/src/index.ts:6` (`export default app`) together with `:14`
(`Bun.serve({ fetch: app.fetch, port: env.PORT })`), and
`infra/docker-compose.prod.yml:69` (`PORT: 3001`).

**What** A default export carrying a `fetch` is a Bun server config. Bun's entry
shim serves it *in addition to* the explicit `Bun.serve` in the same file. With
`PORT` set, both target the same port, the second bind fails, and the process
exits.

**Proof**

```
$ PORT=3099 bun apps/api/src/index.ts
api listening on :3099
...
error: Failed to start server. Is port 3099 in use?
 syscall: "listen", code: "EADDRINUSE"
      at bun:main:15:28

alive? no
listening on 3099? nothing
```

`infra/Dockerfile.api:25` runs exactly this command and
`docker-compose.prod.yml:67` sets `restart: unless-stopped`, so the container
crash-loops and the healthcheck never passes. `apps/api/package.json`'s `dev`
and `start` scripts fail the same way with the repo `.env` (`PORT=3001`).

**Why it is in a security report** None of the hardening in this review has ever
executed on the real runtime path, only under `app.fetch` in tests. It also means
the first person to deploy will be debugging a crash loop, which is when
`TRUSTED_PROXY_COUNT` and `CORS_ORIGINS` get "temporarily" loosened.

**Minimal fix** Delete `export default app` from `apps/api/src/index.ts:6`.
Nothing imports it (`apps/web/src/client.ts:11` imports the `AppType` from
`core/app`; `index.test.ts` imports the named `app`).

---

### F-8 (Low) The body-size guard is `Content-Length`-only

**Where** `apps/api/src/core/hardening.ts:92-98`.

**What** The guard reads the declared `Content-Length` and nothing else. A
request with `Transfer-Encoding: chunked` has no `Content-Length`, so the check
is skipped and the handler receives the whole body.

**Proof** Live, against the real server, with `MAX_BODY_BYTES = 1_000_000`:

```
3MB chunked POST /example   201
```

**Exploitability** Bounded in production by Caddy's `request_body max_size 20MB`
(`infra/Caddyfile:13-15`), so the real in-app ceiling is 20MB rather than the
1MB the code advertises. It compounds F-3 (anonymous retained allocations).

**Minimal fix** Either cap on read - measure the body the handler actually
consumes and reject over the limit - or drop the pretence and document that the
edge owns the body limit. If Fase 3 adds file uploads through Hono rather than
straight to S3, the read-side cap becomes mandatory.

---

### F-9 (Low) The SPA still ships the demo login stub

**Where** `apps/web/src/api/auth.ts:146-247`. Its own banner reads
`DEMO STUB, DELETE THIS BLOCK WHEN apps/api SHIPS /auth/*` - `/auth/*` shipped in
this very commit.

**What** When `/auth/login` is unreachable or answers with a non-JSON
content-type, `stubLogin` mints a client-side session with
`PERMISSIONS_BY_ROLE[role]`, including `ADMIN_PUSAT`, for any username in
`STUB_USERS` with any non-empty password.

**Exploitability** Low. It is fenced to `localhost`/`127.0.0.1`/`[::1]`/`""`
hostnames (`:191-194`) and every session it mints carries `demo: true`. The API
now exists, so on a real host the fence holds and a 502 surfaces as
`ApiUnreachableError`. What it still does is turn "the API is down" into a
fake logged-in Admin Pusat UI for anyone reaching the SPA over a tunnel or a
loopback proxy on the server.

**Minimal fix** Delete the fenced block and the three call sites that reach for
it (`:100`, `:110`, `:128`, `:132`, `:138`). The comment says the module becomes
a plain fetch client with no fallback, which is now the correct behaviour.

---

### F-10 (Low) `db:seed:dev` will plant demo credentials on any database

**Where** `apps/api/src/seed/index.ts:44-49`, `apps/api/src/seed/demo.ts:167-180`,
`tools/db.ts:134-141` and `:169-171`.

**What** Two problems in one command.

1. No environment guard. `seedFase0` seeds demo unless `includeDemo === false`,
   and `bun run db:seed:dev` runs it against whatever `DATABASE_URL` points at.
   `tools/db.ts` guards *wipes* with the `_test` name check
   (`tools/db.ts:50-53`) but applies no equivalent guard to seeding. Running it
   on the server plants `adminpusat` / `auditor` / `maker` with the password
   published in `SEED.md`.
2. It is destructive to real accounts. `seed/demo.ts:168-177` upserts
   `ON CONFLICT (lower(username)) ... DO UPDATE SET password_hash = EXCLUDED.password_hash,
   cabang_id = EXCLUDED.cabang_id, aktif = true`, then `:186-192` deletes every
   other role the user held. A production account that happens to be named
   `maker` or `auditor` gets its password reset to the public demo value,
   reactivated if it was deactivated, moved to another branch, and stripped of
   its roles.

**Exploitability** Requires shell access and an explicit command, so this is a
foot-gun rather than a vulnerability - but the review question was whether the
demo credentials can reach production without an explicit act, and the answer is
that one mistyped script name is the whole distance.

**Minimal fix** Fail closed at the top of `seedDemo`:

```ts
if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "1") {
  throw new Error("seedDemo: menolak berjalan dengan NODE_ENV=production");
}
```

and change the upsert to `ON CONFLICT ... DO NOTHING` for the password and role
columns so an existing account is never rewritten. Optionally have `tools/db.ts`
require the target database name to end in `_test` or `_dev` before seeding demo.

---

### F-11 (Low) `SESSION_SECRET` is a phantom secret

**Where** `.env:12`, `.env.example:57`, `infra/docker-compose.prod.yml:79`,
`infra/DEPLOY.md:66` and `:121`, `docs/DEV.md:161`,
`.github/workflows/ci.yml:63`. Read by nothing:
`apps/api/src/modules/auth/session.ts:9` explains, correctly, that opaque
server-side sessions have nothing to sign, and it is absent from the schema in
`packages/config/src/env.ts` (confirmed by `tools/check-compose.ts`, which lists
13 schema keys and does not include it).

**What** The deploy checklist instructs the operator to generate 32 random bytes
and to keep it different between environments, for a value that has no effect.
A secret that does nothing teaches an operator that the checklist is decorative,
and the day someone adds signing they will assume it was already rotated.

**Minimal fix** Remove it from `.env.example`, `docker-compose.prod.yml`,
`DEPLOY.md`, `DEV.md` and the CI env. If it is being reserved for the Fase 7
mitra portal, add it to the `packages/config` schema now with no default so it
is validated the day it starts mattering.

---

### F-12 (Low) `DATABASE_URL` has a working default

**Where** `packages/config/src/env.ts:15`:
`.default("postgres://user:password@localhost:5432/app")`.

**What** A missing `DATABASE_URL` passes validation and the process boots
pointing at a plausible local database instead of refusing. `loadEnv()` is the
fail-fast gate; a default defeats it for the one variable where a wrong value is
least recoverable.

**Minimal fix** Drop the default (`z.string().url()`); the prod compose always
sets it (`docker-compose.prod.yml:70`) and `.env.example` documents it. Same
argument, lower stakes, for `REDIS_URL` and `S3_ENDPOINT`.

---

## Dependencies (fixed)

Before:

```
happy-dom <20.0.0   (workspace:@krakatausteel/web > @happy-dom/global-registrator)
  critical  VM Context Escape -> RCE                       GHSA-37j7-fg3j-429f
  high      fetch credentials use page-origin cookies      GHSA-w4gp-fjgq-3q4g
  high      unsanitized export names executed              GHSA-6q6h-j7hj-3r64
extract-zip <=2.0.1 (workspace:@krakatausteel/web > puppeteer-core)
  high      unvalidated symlink path traversal             GHSA-jmr9-qjv8-65gv
4 vulnerabilities (1 critical, 3 high)
```

**Real exposure: low.** Both are `devDependencies` of `apps/web` and neither is
in any runtime path. `infra/Dockerfile.web:1-27` and `Dockerfile.api` install the
workspace and run `bun run build` / `bun apps/api/src/index.ts`; no production
code imports happy-dom or puppeteer-core. The happy-dom RCE needs attacker
controlled HTML/JS evaluated inside the registered DOM, which in this repo means
a test fixture. The `extract-zip` traversal needs a malicious browser archive,
which only `@puppeteer/browsers` download would fetch, and this repo uses
`puppeteer-core` (no bundled download). So this was a supply-chain-hygiene item,
not a live hole - but both were a clean upgrade, so they are fixed rather than
accepted.

**Change made** `apps/web/package.json`:

- `@happy-dom/global-registrator` `^15.11.0` -> `^20.11.6`
- `puppeteer-core` `^23.10.0` -> `^25.8.0`

After: `bun audit` -> **No vulnerabilities found.**

**Nothing broke.** happy-dom 20 was the risk, because the root `bunfig.toml`
preload order (`tools/test-env.ts` then `apps/web/src/happydom.ts`) and the
native-fetch capture in `tools/test-env.ts:70-75` depend on it, and
`apps/api/src/testing/native-fetch.ts` exists because happy-dom's `Request`
drops `Cookie`. Verified rather than assumed:

| step | before | after |
|---|---|---|
| `bun test` | 404 pass / 89 fail | 404 pass / 89 fail |
| `bun run build` | pass | pass |
| `bun run typecheck` | pass | pass |
| `bun run check:boundaries` | pass | pass |
| `bun tools/check-compose.ts` | 10 checks pass | 10 checks pass |

All 89 failures are pre-existing and confined to
`apps/api/src/modules/angsuran/**` (another agent's in-progress TDD against
`contract.ts` stubs that throw `not implemented`). Zero failures outside that
directory, before or after. The `apps/web` component tests that actually use
happy-dom pass on 20, including the routing tests that depend on
`GlobalRegistrator.register({ url })`.

The `db:reset` step of `bun run verify` was **deliberately skipped**: it does
`DROP SCHEMA public CASCADE` on `tjsl_test`, and another agent is editing
`migrations/**` right now, so replaying a half-written migration set would break
the shared test database for everyone. The other four verify steps were run
individually and are in the table above. Re-run the full `bun run verify` once
`migrations/**` is quiet.

---

## Categories with nothing to report

Stated plainly, because a clean result is information.

**Injection.** No SQL injection was found. Every statement in every `repo.ts`
binds parameters; there is no interpolation of a request-derived value into SQL
anywhere. Specifically checked:

- `apps/api/src/modules/jurnal/repo.ts:140-141`, the dynamic
  `IN ($2::uuid, $3::uuid, ...)` list. It is built from
  `Array.from({ length: jumlah })` where `jumlah` is `ids.length`
  (`:230-240`); only placeholder *text* is generated and the ids go through
  the parameter array. Not injectable.
- The `$n::text::jsonb` pattern (`jurnal/repo.ts:354`, and `$n::jsonb` in
  `audit/repo.ts:74` and `konfigurasi/repo.ts:132`). The value is a bound
  parameter, so quoting is the driver's job and no payload escapes the string.
  Type confusion is the reverse: the double cast exists to *avoid* silently
  storing an object as a JSON string scalar. `JSON.stringify` of a plain object
  cannot produce invalid JSON, so the cast cannot be made to fail into
  something else.
- `apps/api/src/modules/audit/repo.ts:98-124`, the dynamically assembled
  `WHERE`. Only fixed fragments (`"user_id = $?"`) are pushed and `$?` is
  replaced with a positional index; no filter value touches the SQL text.
- `apps/api/src/modules/auth/segregation.ts:93` and `:104`, the only
  interpolated *identifiers*. Both are validated against
  `/^[a-z_][a-z0-9_]*$/` at construction time (`:70-77`) and come from the
  module wiring, never from a request.
- `apps/api/src/modules/konfigurasi/repo.ts` and `modules/nomor/repo.ts`
  interpolate only module-level column-list and `WHERE` constants.

Also checked and clean: `host(ip)` rather than `ip::text` in the audit read
(`audit/repo.ts:115`), the `limit` parser (`audit/routes.ts:15-22`, integer
1..200), and the `hasil` enum parser (`:24-30`).

**The read-only guard.** It could not be defeated. `core/app.ts:93` registers
`enforceReadOnlyRoles` globally before any route, and it keys on the HTTP method
(`modules/auth/guards.ts:114-132`). Tried as `AUDITOR` against
`PUT /konfigurasi/:grup/:kunci`:

```
PUT plain                        403
POST + X-HTTP-Method-Override    403      POST + X-Method-Override   403
POST + X-HTTP-Method             403      POST _method in body       403
GET ?_method=PUT                 404      (no GET route; nothing mutates on GET)
PATCH                            403      DELETE                     403
HEAD                             404      (Hono does not route HEAD to a GET handler)
OPTIONS                          204      (CORS preflight, no handler runs)
POST /auth/LOGIN                 403      POST /auth/login/          403
POST //auth/login                403      POST /auth/%6cogin         401 (decoded consistently)
```

Hono honours no method-override header, and the exempt set
(`guards.ts:112`, `/auth/login` and `/auth/logout`) is matched against the same
normalised `c.req.path` the router dispatches on, so no mutating route can be
reached while the guard thinks it is looking at the login path. There are no
WebSocket or streaming routes, no `app.all`, no `app.on`, and no route registered
before the guard. Every GET handler in Fase 0 is a pure read.

**Branch scoping.** No bypass found. The claim in
`modules/organisasi/repo.ts:4-11` holds: `findKaryawanById` and `findCabangById`
take only the id and the service checks the branch the row itself reports
(`service.ts:51-58`, `:72-80`). The `?cabangId=` path does not trust its input -
it validates it against `cabangTersedia` first (`service.ts:60-70`) and answers
403 rather than an empty list. As `MAKER` in branch A against branch B:

```
GET /organisasi/karyawan/:idB      403      GET /organisasi/cabang/:idB   403
GET /organisasi/karyawan?cabangId=B 403
GET /organisasi/karyawan            1 row, branch A only, no B leakage
cabangId as B uppercase / {braced} / dash-stripped / empty     403 (all)
cabangId as A uppercase / {braced} / dash-stripped             403 (fails closed)
?cabangId=A&cabangId=B  -> branch A only    ?cabangId=B&cabangId=A -> 403
```

Both by-id reads also pin the row to `principal.bumnId` before the branch check,
so a valid id from another reporting entity 404s instead of resolving. The
journal engine, which has no HTTP surface yet, uses an explicit allowlist for
the one case where there is no existing row to read a branch from
(`modules/jurnal/service.ts:118-121`, `:292-298`) and re-reads the branch to
confirm its `bumn_id`; there is no `lintasCabang` bypass in that check, which is
the right default for Fase 3.

**Session handling.** Everything claimed is true.

```
login mints a new id (does not adopt a pre-set cookie value)   true
an attacker-chosen cookie value resolves to                    401
after POST /auth/logout, the same cookie                       200 -> 401 (server side)
idle expiry (idle=100s, +101s)                                 401
absolute expiry while polling every 50s (absolute=300s)        200 x5 then 401 at t+300s
role revoked mid-session, next request                         200 -> 403
user deactivated mid-session, next request                     401
cookie (dev)   HttpOnly, SameSite=Lax, Path=/, Max-Age=idleTtl
cookie (NODE_ENV=production)  ... plus Secure
```

`NODE_ENV=production` is set in `infra/Dockerfile.api:17`, so the `Secure` flag
is on in the real image. Authorisation facts are re-read from Postgres on every
request (`modules/auth/service.ts:178-227`), which is what makes revocation and
deactivation immediate.

On `core/cookies.ts` specifically: the queue is per-request state
(`c.set`/`c.get`, `cookies.ts:26-35`), so it cannot leak a cookie into another
request; and `setCookieFlush` appends to `c.res.headers` after `await next()`
(`:42-48`), so a header set by a later middleware cannot drop it. The one
asymmetry is that a handler which queues a cookie and *then* throws loses the
cookie, because the flush is not in a `finally` and Hono's error path unwinds
through it. That direction is fail-safe (no cookie rather than a wrong one) and
no current handler queues before it can throw, so it is a note, not a finding.

**Audit write reliability.** A failed audit write cannot be swallowed. Every
`recordFor` on a denial path is awaited and not caught (`guards.ts:47-55`,
`service.ts:263-271`), the repo throws if `RETURNING` yields no id
(`audit/repo.ts:90-94`), and an audit failure therefore surfaces as a 500 rather
than an unrecorded denial. Login denials, the login 429 and anonymous access
denials all write a row (verified: 8 bad logins for an unknown username produced
8 rows, the last 3 being the rate-limit refusals). The uncovered denials are the
branch check (F-1), the `Origin` rejection, the body-size 413 and the global
rate-limit 429; the first is a real gap, the last three are pre-authentication
transport refusals and the F-1 fix in `errorHandler` covers the `Origin` one for
free.

**CSRF.** Covered twice over: `SameSite=Lax` means no cookie on a cross-site
mutation, and `originGuard` (`hardening.ts:82-89`) rejects a mutating request
whose `Origin` is outside the allowlist. The guard permits a request with no
`Origin` header at all, which is correct - browsers always send it on non-GET,
and a headless client still needs a valid session cookie. No state-changing GET
exists, so the `Lax` top-level-navigation carve-out is not reachable.

**Secrets and logging.** No secret is logged. `tools/db.ts:46-48` redacts the
password from connection strings before printing; `core/http.ts:130-147` logs a
method, a path and an error object but never a request body or a cookie;
`errorHandler` returns a code and an Indonesian sentence with no stack trace.
`.env.example` carries no real values (`tools/check-compose.ts` asserts this) and
`infra/docker-compose.prod.yml` has no hardcoded secret. The demo password is
public *on purpose* and is documented as such (`seed/demo.ts:1-8`, `SEED.md:26`);
the problem with it is the missing guard (F-10), not the disclosure.

**Rate limiting.** Redis-backed, keyed on route plus the resolved client IP, with
the fail-open/fail-closed split chosen where the limiter is constructed
(`core/app.ts:85`, `core/ports/ratelimit.ts:8-13`) rather than buried. That
split is the right way round. The two problems with it are the forgeable key
input (F-4) and the per-username policy (F-2), both above.

---

## Recommended order of work

1. F-7 - nothing else is real until the process boots.
2. F-3 - delete one line, removes an unauthenticated write and an
   unauthenticated path into the session store.
3. F-2 - a two-request account lockout on `adminpusat` is the cheapest attack in
   this report.
4. F-1 - the evidence gap; do it in `errorHandler` so every later phase inherits
   it.
5. F-4, F-6 - both a few lines, both close a class rather than an instance.
6. F-5 - hand to the `migrations/**` owner.
7. F-8 through F-12 - hygiene, but F-10 before anyone touches the server.
