# 12. The posting-path guard is a tripwire, not a boundary

Date: 2026-08-23

## Status

Accepted

## Context

Invariant 11 says every financially significant event may create a journal only through one
central path. Until now nothing enforced it:

- `tools/check-boundaries.ts` reads import specifiers, so it cannot see a hand-rolled
  `insert into jurnal_baris`;
- one engine instance in `core/app.ts` is a convention, not a constraint;
- and the journal module's own concurrency test inserts rows directly, which is the nearest
  example a later agent copies.

The review asked for a database-side guard. The obvious mechanism is a transaction-scoped
session variable that the engine sets and a trigger checks. That mechanism has an obvious
objection, which the coordinator raised before I built it: **if a module can set the flag, the
guard proves nothing.**

## Decision

Build it, with the flag scoped to a single transaction by a nonce, and be explicit in the code
and here about what it does and does not stop.

**Mechanism.** `BEFORE INSERT` triggers on `jurnal` and `jurnal_baris` require
`current_setting('tjsl.jalur_posting', true)` to be `<path>:<txid_current()>`, where `<path>` is
one of `engine`, `seed`, `import_saldo_awal`. The engine's contract is one statement per
transaction:

```sql
select set_config('tjsl.jalur_posting', 'engine:' || txid_current(), true)
```

Semantics verified empirically rather than assumed (psql probe, output in the handover):

| Case | Behaviour | Consequence |
|---|---|---|
| `SET LOCAL` inside a transaction | visible in it, gone after both COMMIT and ROLLBACK | a pooled connection cannot carry a blessing into the next checkout |
| autocommit, no surrounding transaction | Postgres warns, value not visible to the next statement | the insert is REFUSED; failure direction is refusal, never silent allow |
| `set_config(k, v, is_local => true)` | identical to `SET LOCAL` | the form the engine uses |
| plain `SET` (no `LOCAL`) | **survives COMMIT on that connection** | a one-word slip would bless a pooled connection until reset |
| nonce from an earlier transaction | no longer equals `txid_current()` | that slip, and any copied line, is refused (`TJSL-JRN-018`) |

The nonce is therefore **mandatory**: the bare value `engine` is refused (`TJSL-JRN-017`).
Accepting it would have left the leak open, and Postgres offers no way to tell a `SET LOCAL`
value from a `SET` value inside the transaction (`pg_settings.source` is `session` for both), so
the trigger cannot detect the slip any other way.

**The honest answer to the question that matters.** Can a business module issue the same
`set_config` itself and walk straight through? **Yes.** Any code that can execute SQL can bless
its own transaction; the database cannot tell which TypeScript module called it. This is
demonstrated deliberately in the proof output rather than glossed over. So:

- this guard **stops mistakes**: a direct insert written because it was convenient fails loudly,
  at the moment it runs, with an error naming the rule;
- it **covers ground the static check cannot reach at all**: psql sessions, ad hoc scripts,
  `tools/`, `core/`, seeds, and any file outside `apps/api/src/modules/**`;
- it **does not stop intent**. Treat `tools/check-boundaries.ts` as the primary enforcement for
  code under review, and this as the runtime net.

Neither half is sufficient alone, which is the actual argument for having both.

**The real boundary, when it is wanted.** Role separation: `REVOKE INSERT, UPDATE, DELETE` on
`jurnal` and `jurnal_baris` from the application role, and expose one `SECURITY DEFINER`
function owned by a privileged role. Then the app role literally cannot write a journal line and
spoofing is impossible. This is not a migration: the deployment currently connects as the table
owner, and an owner keeps its privileges through any `REVOKE`, so it needs a second database role
created by devops. Recorded in OPEN-QUESTIONS.md item 22.

**Sanctioned non-engine paths, without a second blessed value spreading by copy-paste.** The
allowed set is closed, and more importantly the path is **stamped onto the row**:
`jurnal.jalur_posting` is set by the trigger, and `v_jurnal_jalur_bukan_engine` lists every
journal that entered any other way, for every period, forever. A seed or an opening-balance
import is therefore not an invisible convention in code but a column in production data. If
`seed` ever starts spreading, it spreads somewhere an auditor can see. Rows written before this
migration are labelled `LEGACY` rather than retroactively claimed as engine output, and the
column's default is dropped after backfill so a future insert with the trigger disabled fails on
`NOT NULL` instead of inheriting a plausible-looking provenance.

Also in the same migration, unrelated to the guard: `jurnal_idempotensi_uq` was `UNIQUE
(kunci_idempotensi)` with no tenant scope, so two BUMN using a natural key like
`CLOSING/2026-01/PENYUSUTAN` collided and the second tenant's closing failed for no visible
reason. It is now `(bumn_id, kunci_idempotensi)`, deliberately keeping the same index name so
the engine's error map, which keys on the constraint name, keeps matching.

## Consequences

- The journal engine must set the flag once per transaction before its first write. It already
  does, in `repo.ts`, with the nonce form; its suite went from 94 to 112 passing with 0 failures
  after this migration, so the contract landed without breakage.
- Any future writer of journals, sanctioned or not, must either use the engine or declare itself.
  The opening-balance import will use `import_saldo_awal:<txid>` and will be visible in
  `v_jurnal_jalur_bukan_engine` while it runs.
- A test or script that inserts journals directly now needs the flag. That is the intended
  friction: it makes the author decide, in writing, that they are bypassing the engine.
- This ADR should be superseded, not amended, if role separation is adopted: at that point the
  trigger becomes redundant belt-and-braces rather than the control, and saying so plainly will
  matter more than keeping the text tidy.
