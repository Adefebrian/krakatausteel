# 4. Event to journal mapping as data, not code

Date: 2026-08-23

## Status

Accepted

## Context

Spec 6.4 defines 20 business events, each with a debit and a credit account, and requires every
automatic journal to be created by one function reading that mapping (invariant 11). The
tempting implementation is a TypeScript constant: type-safe, testable, no migration needed.

Three things make that wrong here. First, the chart of accounts belongs to the client's
accounting team, and they will renumber and re-map accounts without wanting a deploy. Second,
during an audit the question is "which account did PENCAIRAN_PUMK credit in July 2026", and a
table answers that with a row plus its audit columns, while a constant answers it with a git
blame. Third, some legs are not knowable at design time: PENYALURAN_NON_PUMK debits a
per-bidang expense account and every cash leg uses the account chosen on the form.

## Decision

`event_jurnal_mapping` is a table (0010), one row per (bumn, event_code), with:

- `akun_debit_id` / `akun_kredit_id` as foreign keys to `akun(postable_id)`, so a mapping can
  never point at a header account;
- `debit_dari_payload` / `kredit_dari_payload` booleans marking a leg the posting engine must
  supply at runtime, with CHECK constraints requiring an account whenever the flag is false;
- `jenis_jurnal`, so the resulting journal is typed by configuration too;
- a partial unique index on (bumn_id, event_code) WHERE aktif, so exactly one mapping is in
  force at a time while superseded rows stay for history;
- the standard audit block, so a re-mapping records who changed it and when.

The reconciliation view `v_rekonsiliasi_piutang` (0015) also reads this table to learn which
account is Piutang Pinjaman Mitra Binaan, rather than hardcoding a code like '1201'.

## Consequences

- Account re-mapping is a config change with an audit trail, not a release.
- `event_code` is still a closed set in code (the engine has a handler per event); only the
  accounts are data. That split is deliberate: an unknown event code is a bug, an unknown
  account is a configuration choice.
- Seeding is now load-bearing: an event with no active mapping cannot post. The seed and a
  startup health check must both assert that all 20 events in spec 6.4 have an active mapping.
- The mapping table cannot express a journal with more than two legs. Multi-leg automatic
  journals (an instalment allocating principal, service fee and overpayment at once) are
  composed by the engine from several events, which is also how spec 5.4's allocation waterfall
  is described.
