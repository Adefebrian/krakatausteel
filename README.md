# krakatausteel

A Bun-only monorepo: Hono API, a React SPA bundled with `Bun.build()`, and shared
UI/config packages. No Vite, no Next.js, no webpack.

## Layout

```
apps/web/     React + TypeScript SPA, built with Bun.build(), served by Hono static server.
apps/api/     Hono on Bun: Postgres + Redis + S3 clients, security middleware, gpt-4o-mini client.
packages/ui/  Shared React components: bento primitives, tokens, icon wrapper.
packages/config/ shared env schema.
migrations/   Plain SQL migrations, NNNN_name.sql, applied by tools/migrate.ts.
tools/        Repo tooling: migrate, db lifecycle, verify gate, boundary + compose checks.
infra/        Per-app Dockerfile (multi-stage, slim), prod compose stack, Caddyfile, DEPLOY.md.
docs/         DEV.md (local setup), BUILD-PLAN.md (phases and gates), adr/.
.github/workflows/ci.yml
.jal/memory/
```

## Getting started

Local dev needs Bun, native Postgres 15 and native Redis. It does not need Docker.

```bash
bun install
cp .env.example .env       # defaults are correct for a Homebrew Postgres
createdb tjsl_dev && createdb tjsl_test
bun run db:migrate         # dev DB
bun run verify             # full gate: test DB reset, build, test, boundaries, compose
bun run dev                # web :3000, api :3001
```

`docs/DEV.md` is the full version: clean clone to green suite, psql recipes,
running one package's tests, and the optional Docker path.

## Scripts

| Script | What it does |
|---|---|
| `bun run verify` | The gate. Test DB reset plus migrations, build, `bun test`, boundary check, static compose check. Named PASS/FAIL per step, exits non-zero on the first failure. |
| `bun run dev` | Watches apps/web (rebuild on save) and apps/api (restart on save) in parallel. No Vite dev server, no HMR: a full rebuild per save, by design, so dev and prod share one build path. |
| `bun run build` | `turbo run build` across all workspaces. |
| `bun test` | Whole suite from the repo root. The root `bunfig.toml` preloads `tools/test-env.ts`, which pins `DATABASE_URL` to `TEST_DATABASE_URL` so a test can never write to the dev database. |
| `bun run test:fresh` | `db:reset` then `bun test`. |
| `bun run typecheck` / `bun run lint` | Per workspace, via turbo. |
| `bun run db:status` | Print the resolved dev and test database URLs, passwords redacted. No writes. |
| `bun run db:migrate` / `db:migrate:test` | Migrations up on the dev / test database. |
| `bun run db:reset` | Drop and recreate the test schema, then replay every migration. Refuses any database not named `*_test`. |
| `bun run db:seed` | Seed entry point, placeholder until the phases that need it. |
| `bun run check:boundaries` | No cross-module deep imports, infra always behind a port. |
| `bun run check:compose` | Static validation of `infra/docker-compose.prod.yml` with no Docker daemon. |

## Stack

Bun runtime and package manager, Hono for HTTP, React for the SPA, TypeScript
everywhere, Postgres for data (native locally, containerised on the server),
Redis for rate limiting and caching, Turborepo for task orchestration. Vite, Next.js, webpack, and Create React App
are not used anywhere in this repository.

## Deploy

Build the images in `infra/Dockerfile.api` and `infra/Dockerfile.web`, then deploy
on your own server with Docker Compose. See `infra/DEPLOY.md` for the exact steps.
Deploy is manual from the server; CI runs on a GitHub-hosted runner and never
holds a credential that can reach it.
