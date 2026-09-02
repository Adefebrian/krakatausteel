# 19. A mitra is a second principal, not a role on `app_user`

Date: 2026-09-02

## Status

Accepted

## Context

Fase 7 adds two things to an application where, until now, **every** route required a staff
session and **every** read was branch-scoped:

- an unauthenticated public surface (`/portal/pengajuan`, `/portal/status`, spec 9.5), and
- a login for a Mitra Binaan, who must see its own akad, its own schedule, its own receipts,
  and nothing else in the system, ever (spec 4.9).

The second one is the architectural decision. There was an obvious cheap answer: `Principal`,
`Guards`, `requireSession` and `requirePermission` already exist and already work, so give a
mitra an `app_user` row with a role that holds no permissions, and reuse the lot. That answer
was rejected.

## Decision

A mitra is its own principal type, in its own module (`apps/api/src/modules/mitra`), sharing
**nothing** with staff authentication:

| | staff | mitra |
|---|---|---|
| cookie name | `tjsl_sid` | `tjsl_mitra` |
| cookie path | `/` | `/mitra` |
| Redis session prefix | `tjsl:sess:` | `tjsl:msess:` |
| Hono context key | `principal` | `mitraPrincipal` |
| idle / absolute TTL | 8h / 24h | 30m / 8h |
| guard | `modules/auth/guards.ts` | `modules/mitra/guards.ts` |
| principal shape | roles, permissions, branch scope | account id, mitra id, branch id |

`MitraPrincipal` carries no `permissions`, no `roles`, no `lintasCabang`, no `cabangTersedia`
and no `userId`, so there is no field on it that any staff guard reads. Nothing in
`modules/mitra` calls `setPrincipal`, so `getPrincipal(c)` stays null on a mitra request and
every staff route in the application refuses one.

## Consequences

### Why not one mechanism

1. **Reuse would have weakened staff authentication to fit.** `core/principal.ts` states that
   every field on a `Principal` is an authorisation fact re-read from Postgres per request: a
   home branch, a role list, a permission list, a cross-branch flag. A mitra has none of them,
   so every one would have to be filled with a lie, including a `cabang` the mitra must NOT be
   able to read. `assertCabangAllowed` would then be deciding a borrower's access with a rule
   written for employees, and every future `requirePermission` call would be one catalogue
   mistake away from granting a borrower something.

2. **One mechanism means one bug turns one principal into the other.** With separate cookie
   names, separate Redis namespaces and separate context keys, a mitra session id presented as
   a staff cookie is a MISS rather than a mis-typed hit: it was never written where the staff
   store looks. That is a property of the data layout, not of somebody remembering to write an
   `if`.

3. **`audit_log.user_id` is a foreign key to `app_user`** (migrations/0014). Making a mitra an
   `app_user` to satisfy that FK would put a borrower in the very table `konfigurasi.user`
   administers and `user_role` grants from. Instead a mitra's actions audit with
   `user_id = NULL` and the account named in `entitas` / `entitas_id`, and the FK stays a
   guarantee that a `user_id` in the audit trail is an employee.

### Isolation is by query, not by check

Branch scope is the STAFF rule and is deliberately not the mitra rule. Every mitra-facing
statement in `modules/mitra/repo.ts` carries `mitra_id = $n::uuid`, bound from the session, IN
THE WHERE CLAUSE. There is no "read this akad, then check ownership": the ownership IS the
query, so two mitra of the same branch are as isolated from each other as two of different
branches, and "not found" and "not yours" are literally the same code path and cannot drift
apart. No route on that surface accepts a mitra id, an akad number or a NIK in any position.

### The one thing a mitra may write

Its own password. There is no self-registration: an officer issues the account under
`konfigurasi.user` and the server generates a one-time password shown exactly once (never
stored in cleartext, never written to `audit_log`). `portal_akun_mitra.harus_ganti_sandi`
(migrations/0031) holds the session to `/mitra/ganti-sandi` and `/mitra/logout` until that
password has been replaced, because until then it is a secret two people know.

### The public portal is a third thing again, and owns no authorisation at all

`modules/portal` writes exactly one table, `portal_submission`. It takes no journal port, no
angsuran port and no pumk port, so a public form cannot create a mitra, a proposal, an akad or
a journal; invariant 11 is unreachable from it rather than merely respected. Turning a
submission into a proposal stays `pumk.konversiSubmissionPortal` under `portal.konversi`, a
staff act, and the engine cannot reach the `DIKONVERSI` status that would claim such a proposal
exists.

The status check (ticket plus NIK or date of birth) is a credential check and is treated as
one: a single indistinguishable refusal for every failure mode, constant work on the
unknown-ticket path, and a per-ticket failure budget consumed only AFTER a wrong answer and
reset by a right one, so it can never be used to lock an applicant out of their own ticket.
That last point is the shape `core/hardening.ts` records the staff login limiter once having
had, and it is not reintroduced anywhere in Fase 7.

### What this costs

Two session stores, two guard chains and two cookie policies to maintain, and roughly ninety
lines of deliberate duplication between `modules/auth/session.ts` and `modules/mitra/sesi.ts`.
That duplication is the security property, not an oversight: a change to one lifetime, one
namespace or one guard cannot silently move the other.
