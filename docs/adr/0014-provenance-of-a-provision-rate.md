# 14. The provenance of a provision rate is copied onto the snapshot, never pointed at

Date: 2026-08-25

## Status

Accepted

## Context

`kolektibilitas_snapshot` (migrations/0011) stores, per akad per period, the arrears days, the
class, the outstanding, the rate used, the basis used, and the resulting provision, with a CHECK
that re-derives the provision from the stored inputs. That was enough while there was exactly one
way to obtain a rate: look it up in `penyisihan_rate` by class.

There are now two. `akuntansi.mode_penyisihan` selects between `RATE_TABLE`, the fixed table in
spec 5.2, and `KOLEKTIF_HISTORIS`, the collective-impairment basis docs/REGULASI.md item 2 found
to be the one actually in force in audited PUMK statements (SE-02/MBU/Wk/2012). Both are
capabilities the closing engine must carry, chosen by a config row and not by a deploy.

With both live, `rate_penyisihan = 0.400000` is silent about where that number came from. The day
an entity switches mode, every period closed under the old one loses its explanation: Laporan
Perhitungan Penyisihan (spec 10.4 report 28), whose entire job is to reconstruct the provision
journal, prints a rate it can no longer attribute. That is invariant 14 broken for the one report
that exists to satisfy it. docs/REGULASI.md asks for the column by name; the closing suite pinned
its absence as a fail-closed finding rather than inventing it in a fixture.

## Decision

### 1. Record the mode, plus the inputs that are otherwise irrecoverable. Not the mode alone.

`kolektibilitas_snapshot.sumber_rate` is `TABEL_KONFIGURASI` or `KOLEKTIF_HISTORIS`, mirroring
`SumberRate` in `modules/closing/contract.ts`, `NOT NULL`, no default.

For `TABEL_KONFIGURASI` the mode alone is sufficient: it names a lookup whose result is already
copied onto the row, next to the class and the arrears days that selected it.

For `KOLEKTIF_HISTORIS` it is not. "Derived from collection history" without saying *which*
history is a label, not an attribution: a reader is told the number was computed and given nothing
to compute it from. So the row also carries `rate_histori_dari` and `rate_histori_sampai`, the
inclusive bounds of the window used. The collection history itself lives in the ledger and the
instalment tables, which are append-only, so the window is the whole of what would otherwise be
lost: `akuntansi.penyisihan_min_bulan_histori` is a config row and will have changed by the time
anyone asks.

### 2. Copy values. Never point at a config row version.

The tempting third option was a reference to the config row in force at run time, which would
cover both modes at once and every future mode for free. It is unsound here, and the reason
generalises: `konfigurasi`, `penyisihan_rate` and `kolektibilitas_range` are all mutated **in
place**. Their `version` column is an optimistic-lock counter that increments on update, not a
history key, and there is no config history table for a pointer to resolve against. The reference
would therefore resolve to *today's* value while claiming to be the one used. That is worse than
storing nothing: it reads like provenance and is not. `audit_log` holds the old value, but an
audit trail is evidence that a change happened, not a source of record for a financial report.

A snapshot copies what it used. That is already 0011's rule for `rate_penyisihan` and
`dasar_perhitungan`; this extends it rather than introducing it.

### 3. No columns for the arrears band.

The obvious fourth column set was the `kolektibilitas_range` band (`hari_min`, `hari_max`) that
mapped this row's arrears days onto its class. Rejected: the row already stores **both ends of
that mapping**, per akad, 45 days and `KURANG_LANCAR`. Band columns would restate a fact already
recorded instead of adding a missing one. The rule is that a snapshot carries the inputs it used,
not a copy of every table it read.

### 4. NOT NULL, no default, and the window is mandatory by mode.

A default would let an engine that never considered provenance write `TABEL_KONFIGURASI` over a
historically derived rate, silently, into a period an auditor will later ask about. That is
precisely the failure the column exists to prevent, so the schema refuses the row instead: an
engine that cannot say where its rate came from may not write a snapshot at all. `contract.ts`
already declares `sumberRate` a required field of `BarisKolektibilitas`, so the value is in hand
at insert time.

The two window columns are nullable at column level and mandatory at row level, through
`kolektibilitas_snapshot_sumber_rate_ck`: `NULL` for `TABEL_KONFIGURASI` (there is no window, and
inventing one would be a lie), `NOT NULL` and correctly ordered for `KOLEKTIF_HISTORIS`. So the
historical mode cannot record a rate it cannot explain, and the rate-table mode cannot pretend it
consulted history.

### 5. The migration refuses to backfill.

If `kolektibilitas_snapshot` already holds rows, migrations/0024 raises `TJSL-MIG-0024` and rolls
back rather than defaulting them to `TABEL_KONFIGURASI`. The provenance of an existing closed
period is a data question for the accounting owner, not something a migration may guess. On every
database migrated so far the table is empty, because the engine that writes it is unimplemented.

## Consequences

- Report 28 stays reconstructible across a mode switch, which is the whole point.
- The closing engine must supply `sumber_rate` on every snapshot insert, and the history window
  whenever it runs `KOLEKTIF_HISTORIS`. An insert that omits either fails loudly at write time
  rather than producing an unexplainable row.
- `penyisihan_periode` needs no provenance column of its own: it aggregates a period's snapshots,
  and the mode is recoverable by joining to them. Adding one there would create a second place for
  the same fact to be wrong.
- `saldo_akun_periode` has no comparable gap. Its four columns are debit-positive amounts derived
  from the ledger, which is append-only, and a CHECK ties them to each other. It reads no policy
  parameter, so there is no mutable input to record. The one live risk there is which journal
  statuses the engine counts, which is ADR 0010 and OPEN-QUESTIONS item 20, not a missing column.
- `akrual_jasa_snapshot` **does** have the same shape of gap and is deliberately not fixed here.
  It records the accrued fee per akad but not `akuntansi.akrual_hanya_untuk_kolektibilitas`, the
  eligible-class list in force, so a later edit to that list makes "why was this akad not accrued
  in that period" unanswerable from the snapshot. `HasilAkrual` computes the list at run time and
  then discards it. The fix is not obviously a column: the fact is per run, and unlike
  kolektibilitas there is no `closing_akrual` header row to hang it on. Recorded as
  OPEN-QUESTIONS item 23, to be settled with the accrual engine's design and before the first
  production period closes, not guessed at while that engine is being written.
