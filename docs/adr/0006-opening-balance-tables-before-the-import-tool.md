# 6. Opening balance tables before the import tool

Date: 2026-08-23

## Status

Accepted

## Context

Spec 9.6 requires an "Import Saldo Awal" for go-live: the chart of accounts with opening
balances, and the list of akad with opening outstanding, validated so that the total is balanced
and the receivable sub-ledger matches the receivable account. The import tool itself is a later
phase, and dummy legacy data will be generated later.

The temptation is to defer the tables with the tool. That is how migration becomes a
last-minute crisis: legacy data has a different shape from live data (an akad joins mid-life,
with instalments already paid and arrears already accrued), and discovering that after the
schema is full of production data means an emergency migration.

## Decision

The tables ship now, in the migration where their domain lives.

- `saldo_awal_batch` (0005): one row per go-live import, per branch or consolidated, carrying
  the effective cut-off date, the source, a status (DRAFT, DIVALIDASI, DIPOSTING, DIBATALKAN),
  the batch totals, the validation result as JSON, and a link to the opening journal once it is
  posted.
- `akun_saldo_awal` (0005): the chart-of-accounts half. One row per (batch, cabang, akun), with
  the same one-side-only CHECK as `jurnal_baris`, so an opening trial balance is structurally a
  journal and can be posted as one.
- `akad_saldo_awal` (0008): the receivable half. Opening outstanding principal and service fee,
  opening arrears, the last instalment actually paid, opening arrears days and opening
  collectibility class (FK to `kolektibilitas_kelas`).

Both halves hang off the same batch, so the go-live check "sub-ledger equals the Piutang
account balance" is one query over one batch id, before anything is posted.

The opening journal is a normal `jurnal` with `jenis = 'SALDO_AWAL'`, so it passes the same
balance, period and immutability guards as everything else. No special path into the ledger.

## Consequences

- The import tool, when it lands, writes rows and posts one journal. It does not need a schema
  change, and it cannot invent a private way into the ledger.
- Legacy akad can be represented honestly: partially paid, in arrears, already classified,
  without back-dating journals into periods that will never exist in this system.
- Cost: three tables carrying no rows until go-live. Acceptable.
- Open point for the client: whether opening balances are loaded per branch or consolidated,
  and whether the legacy arrears history needs to be reconstructed as schedule rows or only as
  aggregate opening arrears. Recorded in OPEN-QUESTIONS.md.
