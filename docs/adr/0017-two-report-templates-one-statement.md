# 17. Two report templates, one statement

Date: 2026-08-25

## Status

Accepted

## Context

`docs/REGULASI.md` finding 1 established that the specification's net-asset terminology is PSAK 45's,
that PSAK 45 was withdrawn, that ISAK 35 (renumbered ISAK 335 from 1 January 2024) uses "tanpa
pembatasan" and "dengan pembatasan" instead, that audited BUMN practice is split, and that an
amendment effective 1 January 2027 changes the format again. The choice belongs to the client's
accounting team with their KAP. `docs/BUILD-PLAN.md` therefore recorded a plan that two templates
must be able to live at once, and the frontend already ships a template switcher on the affected
reports on that assumption.

The schema did not support the plan. `baris_laporan_kode_uq` is `UNIQUE (bumn_id, kode)` and
`akun.klasifikasi_laporan` is a single composite foreign key into it, so a line code exists once per
BUMN and an account belongs to the PSAK 45 line or to the ISAK 335 line, never to both.

A second finding arrived with the report suite: `akun.klasifikasi_laporan` being single-valued means
at most two of the four statements can be account-driven. Arus Kas got a parallel column
(`klasifikasi_arus_kas`); Perubahan Aset Neto got nothing and has to be inferred from
`baris_laporan.seksi`, which is a section label rather than a mapping.

## Decision

### The diagnosis: one column was doing two jobs

`baris_laporan.kode` was simultaneously the identity of a printed LINE of one statement and the
vocabulary an account is CLASSIFIED with. Those change on different schedules. What an account IS
("a restricted net asset") is an accounting fact that does not change because a standard was
renumbered; where it PRINTS, under what caption, in what order, in which section, with which sign,
changes every time the format does. Both findings are that conflation seen from two ends, and both
are fixed by splitting it. `migrations/0028`:

```
klasifikasi_akun          the vocabulary. `akun.klasifikasi_akun` points here, still NOT NULL,
                          still a real composite FK.
template_laporan          a named, effective dated presentation.
baris_laporan             a printed line OF ONE TEMPLATE. Gains template_id; kode is now unique
                          per (bumn, template).
pemetaan_baris_laporan    (template, klasifikasi, laporan) -> line.
```

### Why the mapping is per classification and not per account

The obvious alternative, a link table from `akun` to `baris_laporan` with one row per account per
template, was rejected on three grounds:

1. **Cost and drift.** Adding a template would mean re-mapping the whole chart, and every account
   added afterwards would have to be mapped into every template or it would silently vanish from one
   statement and not another. That failure is invisible: the statement still balances, because the
   account is simply absent. Under the classification model a new template is roughly twenty mapping
   rows and a new account inherits every template automatically.
2. **Totality survives.** `akun.klasifikasi_akun` stays `NOT NULL` with a real foreign key, so an
   unclassified account remains impossible. A per-account-per-template link table can only ever
   guarantee coverage for one template with `NOT NULL`.
3. **Many to one is what a standards change actually is.** PSAK 45's "terikat temporer" and "terikat
   permanen" both become ISAK 335's "dengan pembatasan". Two classifications pointing at one line
   expresses that; a shared code vocabulary across templates cannot.

And it fixes the second finding for free: the mapping is keyed by `laporan`, so one classification
reaches a line in Posisi Keuangan and a line in Perubahan Aset Neto and a line in Arus Kas. All four
statements become account-driven, and Perubahan Aset Neto stops being inferred from `seksi`.

`akun.klasifikasi_arus_kas` is deliberately left alone. It answers a different question ("when this
account is the counterpart of a cash movement, which section is that flow in") and is per account
rather than per classification. Expressing it through the mapping later, at line level instead of
section level, would be an improvement; doing it in the same migration that moves every report's
join would be two changes wearing one coat.

### A statement cannot mix two templates, structurally

A mapping row carries `template_id` and `laporan` and reaches its line through a four-column foreign
key `(baris_laporan_id, bumn_id, template_id, laporan)` into a matching unique on `baris_laporan`. A
row that names a line of template A while claiming template B is refused by the foreign key, not by
a trigger and not by a code review. A renderer selects `WHERE template_id = $1` and everything it
can reach belongs to that template. The same key makes a cross-BUMN mapping impossible, so the
migration adds no referential trigger at all. `pemetaan_baris_laporan_uq` adds the other half: a
classification lands on at most one line of a given statement in a given template, because two would
count the same accounts twice and the statement would still balance, both copies being on the same
side.

### The dual-template plan is right in substance and the report-time switcher is wrong

Asked whether a single template with a migration between them would be better, the answer is no, and
not on a keep-options-open argument. A single template makes an in-place UPDATE the only way to
adopt a new standard, and an in-place UPDATE is a silent reshaping of every prior period's
statements. Coexistence is not a hedge about which standard the client will pick; it is what "the
2026 statements were prepared under the format then in force" requires of the database, whichever
standard that turns out to be.

But coexistence does not mean a dropdown. A template chosen at print time means two people printing
"Posisi Keuangan Januari 2026" get differently shaped statements, both plausible, both balancing,
with nothing in the archive saying which one was the statement. So:

- Templates are **effective dated over the period being reported**, and a BUMN's effective ranges may
  not overlap (TJSL-TPL-001). "Which template was in force" therefore always has exactly one answer,
  and that answer is data.
- A closed period **records the template it was closed under**, in `periode.template_laporan_id`, and
  a reprint resolves its template from that column. Adopting ISAK 335 in 2027 cannot silently restate
  every 2026 statement, which is the failure that would otherwise happen by accident.
- Choosing a template explicitly stays possible, for a restatement or a preview, and the report must
  SAY which template it rendered under, the way report 24 says which realisation source answered.

### What is NOT prevented, said plainly

Editing a template in place still changes how a closed period prints: moving an account to another
classification, flipping `tanda`, deactivating a line. That is deliberate, and it is not migration
0024's defect:

- The FIGURES are frozen per account in `saldo_akun_periode` and are template-independent. Neraca
  Lajur reconstructs a closed period exactly whatever the layout does. Invariant 14 speaks of "angka
  yang sama"; the account balances do not move.
- Restating comparatives is REQUIRED when a standard changes. A system that froze the shape of a
  closed period could not produce the restated prior-year column the standard demands.
- Preventing it properly means versioning both the template and the account-to-classification link
  over time, i.e. temporal master data, which this system has adopted nowhere (mitra, sektor, bidang
  and akun are all mutable). Adding it for one table would be the expensive half of a mechanism
  nothing else uses.

The mitigation is evidence rather than prevention: all three new tables carry the audit trigger, so
who reshaped a printed statement and when is answerable from `audit_log`. Recorded as
OPEN-QUESTIONS item 27 rather than presented as solved.

## Consequences

- **This is a breaking change and it fails loudly, on purpose.** `akun.klasifikasi_laporan` is
  RENAMED to `akun.klasifikasi_akun`, values and nullability unchanged, foreign key retargeted. Every
  query joining an account to a report line by code alone now fails with `column
  "klasifikasi_laporan" does not exist` instead of quietly returning one row per template the day a
  second template exists. `modules/laporan`, `apps/api/src/seed/coa-inti.ts` and the report suite's
  `petakanAkun` helper all have to move. Same handover as 0024, 0025 and 0026.
- The backfill is exact rather than a guess: one `BAWAAN` template per BUMN, one classification per
  existing line code, one identity mapping per existing line. Every account keeps the same
  classification string and resolves to the same line. The default template is not named after a
  standard, because naming it would be the migration asserting which standard the client reports
  under.
- `modules/closing` must set `periode.template_laporan_id` at close. Periods closed before this
  migration have none, and a reprint of one has to fall back to the effective-dated lookup and say
  so.
- `modules/laporan`'s report contract gains the template it rendered under. The frontend switcher in
  `apps/web/src/regulasi.ts` stops being hardcoded wording and becomes a real selection, with the
  period's own template as the default rather than `TEMPLATE_DEFAULT = "PSAK_45"`.
- The tests in `laporan-struktur-data.test.ts` remain the right tests: they assert the re-templating
  mechanic and no terminology, which is exactly what survives this change.
