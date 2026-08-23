# 7. Single level branch hierarchy

Date: 2026-08-23

## Status

Accepted

## Context

Spec 4.1 defines `cabang` with an `is_pusat` flag and no parent. Spec 13 asks the seed for
1 pusat plus 3 branches. Spec 2 expresses every authorisation rule as "scope cabang", with
Admin Pusat and Auditor seeing everything. Nothing in the spec describes a regional layer
between pusat and cabang, but real BUMN structures often have one (pusat, wilayah, cabang), and
adding a level after reports exist is expensive because every branch-scoped aggregate has to
become a recursive query.

## Decision

Single level: `cabang` has no `parent_id`, and branch scoping is a direct equality check on
`cabang_id`. `is_pusat` is constrained to exactly one row per bumn by a partial unique index.
`cabang_id` is denormalised onto `pumk_akad` (kept in step with its proposal by trigger) and
onto the closing snapshots, because every report filters by branch and a two-hop join for the
most common filter in the system is not worth the purity.

This is recorded as assumption A-01 in ASSUMPTIONS.md, to be confirmed with the client.

## Consequences

- Reports and permissions stay simple: `WHERE cabang_id = $1` or `WHERE cabang_id = ANY($1)`.
- If a regional level is confirmed later, the migration is additive: add `cabang.parent_id`,
  add a recursive CTE (or a materialised closure table) behind a single scope-resolution
  function, and change the permission check to use it. The denormalised `cabang_id` columns
  stay correct, because they name a leaf branch either way.
- What would be painful is the reverse: if the client's branches are already a tree today, then
  every "Semua Cabang" aggregate written between now and that discovery is wrong for the
  intermediate level. That is why this is written down as an assumption to confirm rather than
  left implicit.
