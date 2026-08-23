# 3. Postable account as a generated foreign key

Date: 2026-08-23

## Status

Accepted

## Context

Spec 4.2: "Jurnal hanya boleh menunjuk akun dengan `is_postable = true`". Only leaf accounts
are postable; header accounts exist to aggregate.

Postgres cannot put a foreign key on a filtered view, and a foreign key requires a plain
unique constraint, not a partial unique index. The obvious implementation is therefore a
trigger on `jurnal_baris` that looks up `akun.is_postable`. Triggers are bypassable in one
important way: they are per-statement logic that a future `COPY`, a bulk load with triggers
disabled, or a careless `ALTER TABLE ... DISABLE TRIGGER` silently removes.

## Decision

`akun` carries a stored generated column:

```
postable_id UUID GENERATED ALWAYS AS (CASE WHEN is_postable THEN id END) STORED
CONSTRAINT akun_postable_id_uq UNIQUE (postable_id)
```

`jurnal_baris.akun_id` references `akun(postable_id)`, and so do
`event_jurnal_mapping.akun_debit_id` and `akun_kredit_id`.

A header account has `postable_id` NULL, so it is not a valid FK target and cannot be posted
to. `akun.aktif` is checked by a separate trigger on INSERT only, because deactivating an
account must never invalidate history.

## Consequences

- The rule is declarative: it holds under any isolation level, survives disabled triggers, and
  produces a standard foreign-key violation that any client library already understands.
- Bonus, and intended: flipping `is_postable` to false on an account that already has journal
  lines fails, because the key those lines reference would disappear. That is exactly spec
  4.2's "akun yang sudah dipakai tidak boleh dihapus, hanya dinonaktifkan", enforced one level
  stronger than asked.
- Cost: one extra 16-byte column and one extra unique index on `akun` (about 100 rows), and a
  developer who has not seen the pattern needs the comment in `migrations/0005_coa.sql` to
  understand why `akun_id` does not reference `akun(id)`.
- Deactivating an account (`aktif = false`) remains possible at any time, which is the
  operation accountants actually need.
