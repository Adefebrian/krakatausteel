# TJSL Online data model

75 tables and 13 views, created by `migrations/0002` through `migrations/0026`. This document is
the map; the migrations are the source of truth and every non-obvious column is commented there.

Sections 1 to 13 are the core system, which works standalone and holds the books.
Section 14 is an **optional** outbound integration layer that is inert until a target is
configured: who holds the authoritative TJSL books is still undecided (ADR 0008), and nothing in
section 14 changes an account, a report or a closing rule.

Read this first:

- **Money is always `NUMERIC(20,2)`. Rates are always `NUMERIC(9,6)`** (0.030000 = 3 percent).
  There is no float, double or real column anywhere, and there never will be (spec invariant 7).
- **Every financial entity carries the same audit block**: `created_by, created_at, updated_by,
  updated_at, deleted_by, deleted_at, version`. `updated_at` and `version` are maintained by the
  shared trigger `tjsl_audit_touch`. Soft delete only. Read paths must filter
  `deleted_at IS NULL`; the views in `0015_view_integritas.sql` show the pattern.
- **Two spec table names are renamed** because they are Postgres reserved words: spec `user` is
  `app_user`, spec `role` is `app_role`.
- **Spec's `uploaded_by` / `uploaded_at`** (on `mitra_dokumen` and `lampiran`) are the audit
  block's `created_by` / `created_at`, not extra columns.
- **A `REVERSED` journal is still in the ledger.** Correction is by reversing entry, which adds
  two rows and removes none, so a ledger sum counts a journal when its status is `POSTED` **or**
  `REVERSED`. Filtering `POSTED` alone counts one half of a correction pair and doubles its
  effect. Read `v_ledger_baris` (0018) instead of re-deriving that filter; see ADR 0010.
- **Journals may only be written through the engine.** `jurnal` and `jurnal_baris` reject any
  INSERT unless the transaction declares its path:
  `select set_config('tjsl.jalur_posting', 'engine:' || txid_current(), true)`. The nonce makes a
  blessing worth exactly one transaction. This is a tripwire against mistakes, not a boundary
  against intent (a caller can bless its own transaction), so the static check in
  `tools/check-boundaries.ts` remains the primary enforcement; see ADR 0012. The path is stamped
  onto `jurnal.jalur_posting`, and `v_jurnal_jalur_bukan_engine` lists everything that entered
  another way.
- **What cannot be reconstructed cannot be removed.** Ledger and audit tables carry both a
  row-level DELETE guard and a statement-level TRUNCATE guard (ADR 0013); derived snapshots carry
  neither, because reopening a period is defined as dropping them.
- **The database enforces the accounting invariants**, not just the service layer. See
  `docs/adr/0002`. Guard errors carry stable codes (`TJSL-JRN-031`, `TJSL-PER-001`, ...).

## 1. Organisation and master data (0003)

| Table | Purpose |
|---|---|
| `bumn` | The reporting entity. Everything is scoped under one of these; fiscal year start lives here. |
| `cabang` | Branch. The unit every authorisation rule and every report filter is expressed in. Exactly one `is_pusat` per bumn, single level (ADR 0007). |
| `app_user` | Login identity, belongs to one cabang. |
| `app_role`, `permission`, `role_permission`, `user_role` | RBAC. Permissions are granular per action (`jurnal.post`, `periode.close`). `user_role.scope_cabang_id` grants a role in another branch without widening the user's home scope. |
| `karyawan` | Staff member, used as survey officer and programme owner. Not a login. |
| `provinsi`, `kota` | Wilayah reference with BPS codes, required because national disbursement reports group by province. |
| `sektor_pumk` | PUMK business sector (Industri, Perdagangan, ...). |
| `bidang_non_pumk` | Non PUMK field (Pendidikan, Kesehatan, ...). |
| `sdg` | The 17 SDGs, with targets as JSON. |
| `cluster` | A group of mitra binaan developed together; chaired by one of its members. |

## 2. Configuration as data (0004)

Nothing in spec section 5 is hardcoded. Scope resolution is "row for this bumn, else the global
row with `bumn_id IS NULL`", which is why the unique indexes use `NULLS NOT DISTINCT`.

| Table | Purpose |
|---|---|
| `konfigurasi` | Scalar parameters (rates, thresholds, flags) with a declared data type, allowed values for enums, and a `perlu_konfirmasi` flag marking values still awaiting client confirmation. |
| `kolektibilitas_kelas` | The fixed set of receivable-quality classes (LANCAR, KURANG_LANCAR, DIRAGUKAN, MACET). Referenced by every table that stores a class, so a typo cannot reach the ledger. |
| `kolektibilitas_range` | Spec 5.1 day ranges as editable rows, effective-dated. |
| `penyisihan_rate` | Spec 5.2 provision rates as editable rows, effective-dated, each with its calculation basis. |
| `alokasi_setoran_preset` | Spec 5.4 payment-allocation waterfall as ordered rows. Ships with DEFAULT and POKOK_DULU. |
| `nomor_urut` | Document-number counters. The row is the lock: the generator does `INSERT ... ON CONFLICT DO UPDATE SET urutan_terakhir = urutan_terakhir + 1 RETURNING`, which is atomic. |

## 3. Chart of accounts and report layout (0005)

| Table | Purpose |
|---|---|
| `baris_laporan` | One row per printed line of Posisi Keuangan / Aktivitas / Arus Kas / Perubahan Aset Neto. Report layout is data: changing a statement is a config edit, not a deploy. |
| `akun` | The chart of accounts. Tree via `parent_id` with hierarchy validated by trigger (child level, matching type, parent not postable). `klasifikasi_laporan` is a real composite FK into `baris_laporan`. `postable_id` is the generated column that makes "only leaves can be posted to" a foreign key (ADR 0003). |
| `saldo_awal_batch` | One go-live opening-balance import (ADR 0006). |
| `akun_saldo_awal` | The chart-of-accounts half of an opening balance, one side only per row. |

## 4. Mitra binaan (0006)

| Table | Purpose |
|---|---|
| `mitra` | The UMK borrower: identity, business profile, demographics for report 27, legacy code for repeat borrowers. NIK is unique where present. |
| `cluster_anggota` | Dated cluster membership history, so "collectibility per cluster" for a past period uses that period's members. At most one open membership per mitra. |
| `mitra_dokumen` | Uploaded identity and business documents, with the AI extraction result kept as raw JSON. |
| `portal_akun_mitra` | Public-portal credential for a borrower who already has an akad. |

## 5. Accounting calendar (0007)

| Table | Purpose |
|---|---|
| `periode` | One calendar month per row, unique per (bumn, tahun, bulan). Closing order and reopen rules are enforced by trigger. Physical delete blocked. |

`tjsl_periode_untuk_tanggal(bumn_id, date)` is the single definition of "which period does this
transaction date fall in", shared by the journal guard and the closing engine.

## 6. Pendanaan UMK (0008)

| Table | Purpose |
|---|---|
| `pumk_proposal` | Loan application. Status walks the spec 9.1 state machine. |
| `pumk_proposal_transisi` | Append-only transition log, the timeline shown on the detail page. |
| `pumk_survey` | Field survey with per-aspect scoring as JSON plus the derived total the flow gates on. |
| `pumk_jaminan` | Collateral, multiple per proposal, with physical custody status. |
| `pumk_review` | Checker decision. Trigger refuses a reviewer who is the proposal's maker. |
| `pumk_approval` | Approver decision, including a cut plafon or tenor. Trigger refuses an approver who already reviewed. |
| `pumk_akad` | The signed loan: principal, rate, method, tenor, grace, outstanding principal and service fee. `outstanding_pokok` is CHECKed between 0 and the principal. A partial unique index enforces one live loan per mitra. |
| `pumk_jadwal_versi` | One row per generated schedule version; this is where "exactly one active version per akad" is a partial unique index. |
| `pumk_jadwal_angsuran` | The instalment rows. Priced columns are immutable, physical delete blocked, version 1 principal must equal the loan (deferred trigger). |
| `pumk_pencairan` | Disbursement event, links to the journal that recorded it. |
| `pumk_angsuran` | Instalment received, with its allocation to principal, service fee and overpayment. CHECK: the three add up to the amount received. |
| `pumk_reschedule` | Restructuring request and its outcome, naming the old and new schedule versions. |
| `pumk_pengakhiran` | Early settlement or write-off, freezing the outstanding at decision time. |
| `pumk_kelebihan` | Overpayment held as a liability, and its return. |
| `tindak_lanjut_penagihan` | Collection follow-up log (visit, call, warning letter, somasi). |
| `akad_saldo_awal` | The receivable half of a go-live opening balance. |

## 7. Non PUMK (0009)

| Table | Purpose |
|---|---|
| `nonpumk_proposal` | Grant application. Applicant identity lives here (no borrower master). `jumlah_disetujui` is the disbursement ceiling. |
| `nonpumk_proposal_sdg` | Weighted many-to-many to SDGs. |
| `nonpumk_proposal_transisi` | Append-only transition log. |
| `nonpumk_penilaian` | Assessment with scoring as JSON. |
| `nonpumk_review`, `nonpumk_approval` | Same maker/checker/approver trail as PUMK, same segregation-of-duties triggers. |
| `nonpumk_penyaluran` | Disbursement, possibly in several termin. Deferred trigger: the total never exceeds the approved amount. |
| `nonpumk_lpj` | Accountability report. Deferred trigger: realisation plus returned remainder equals what was actually disbursed. |

## 8. Closing (0011)

| Table | Purpose |
|---|---|
| `closing_kolektibilitas` | One collectibility run: preview or committed, with the migration matrix as JSON. At most one committed run per (periode, cabang). |
| `kolektibilitas_snapshot` | Per akad per period: arrears days, class, outstanding, arrears, the rate and basis used, and the resulting provision. A CHECK re-derives the provision from the stored inputs, which is what makes report 28 reproducible. Since 0024 the row also states WHERE the rate came from (`sumber_rate`, plus `rate_histori_dari` / `rate_histori_sampai` for a collectively derived one), so report 28 survives a change of `akuntansi.mode_penyisihan`; provenance is copied, never pointed at a config row that is mutated in place (ADR 0014). Unique per (periode, akad). |
| `penyisihan_periode` | Per branch per period: opening provision balance, required provision, and the expense or recovery, with a CHECK that the third equals the second minus the first. It has NO `jurnal_id`: a correction is posted as a delta, so the movement is carried by a set of journals (0026, ADR 0015). |
| `penyisihan_periode_jurnal` | The journals making up one period-branch provision movement, each with its SIGNED contribution. A deferred constraint trigger on both tables makes `SUM(nilai)` disagreeing with `beban_penyisihan_periode` impossible to commit, which is what spec 16 scenario 17 rests on. Unique on `jurnal_id` alone: a journal belongs to exactly one provision. |
| `akrual_jasa_snapshot` | Per akad per period service-fee accrual, so spec 8.3 is idempotent and report 30 is reproducible. Since 0025 it also records the policy that produced it: `metode` (always ACCRUAL, because CASH_BASIS writes nothing) and `kelas_diakrual`, the eligible-class list in force, so eligibility per row is `kelas_diakrual ? kolektibilitas` and report 30 states its own population. A period whose class list excluded the whole portfolio still has no rows and so no record that the step ran: OPEN-QUESTIONS item 23. |
| `saldo_akun_periode` | Frozen trial balance per (periode, cabang, akun). All four amount columns are debit-positive, and a CHECK enforces closing = opening + debit - credit. Deleted when a period is reopened, by design. |

## 9. Ledger (0010)

| Table | Purpose |
|---|---|
| `jurnal` | Journal header. `jalur_posting` records which sanctioned path wrote it (ENGINE, SEED, IMPORT_SALDO_AWAL, or LEGACY for rows predating 0020), stamped by trigger. `total_debit` / `total_kredit` are maintained by trigger from the lines, never trusted from a caller. `kunci_idempotensi` makes closing re-runs safe. Guards: period resolution, closed-period block, POSTED immutability, delete block. |
| `jurnal_baris` | Journal line. One side only (CHECK), account must be postable (FK to the generated column), optional mitra and akad for the receivable sub-ledger, analytic dimensions as JSON. |
| `event_jurnal_mapping` | The spec 6.4 event-to-account mapping, as configuration (ADR 0004). |

## 10. Budget (0012)

| Table | Purpose |
|---|---|
| `rka` | Annual budget per (bumn, cabang, tahun, jenis, versi). One approved baseline per scope; a revision is a new version. |
| `rka_detail` | Budget lines. A trigger forces the dimension the budget type requires: sektor for PUMK, bidang for Non PUMK, akun for Keuangan. |

## 11. Public portal (0013)

| Table | Purpose |
|---|---|
| `portal_submission` | Untrusted public intake, kept as submitted JSON until an officer converts it. Ticket is unique; the status-check secret is stored hashed; IP and timestamp are indexed for rate limiting. Conversion is recorded on both sides, and a CHECK ties `sumber_pengajuan = PORTAL_ONLINE` to the presence of a submission link. |

## 12. Cross-cutting (0014, plus konfigurasi/nomor_urut in 0004)

| Table | Purpose |
|---|---|
| `audit_log` | Append-only. UPDATE and DELETE raise, for everyone. Holds rejected authorisation attempts too (spec 2 rule 5). |
| `lampiran` | Polymorphic attachments (`entitas` + `entitas_id`), with checksum. |
| `notifikasi` | In-app notifications per user. |

## 13. Views (0015)

| View | Purpose |
|---|---|
| `v_jurnal_jalur_bukan_engine` | Journals that did not come from the engine. Expected empty in production once the opening-balance import has run. Added in 0020. |
| `v_ledger_baris` | The canonical set of ledger lines (journal `POSTED` or `REVERSED`, nothing soft-deleted), with `debit - kredit` precomputed. Every ledger aggregate must read this rather than re-deriving the status filter (ADR 0010). Added in 0018. |
| `v_rekonsiliasi_piutang` | Spec 8.4 check 10, the most important reconciliation in the system: per akad, sub-ledger outstanding versus general ledger. Any non-zero `selisih` blocks period closing. The receivable account is read from `event_jurnal_mapping`, not hardcoded. Rebuilt on `v_ledger_baris` in 0018, which fixed a double-count of every reversal. |
| `v_integritas_jurnal` | Journals whose lines do not balance, or have fewer than 2 lines, or disagree with the header totals. Computed from the lines. Should only ever contain in-progress DRAFT journals. |
| `v_integritas_jadwal` | Active version 1 schedules whose principal does not add up to the loan. |
| `v_integritas_snapshot` | Duplicate collectibility snapshots. Should always be empty. |


## 14. Optional outbound integration layer (0016, 0017)

Inert until a target is registered and activated. Adds no column to `jurnal`, modifies no trigger
in 0007 or 0010, demotes no report, and does not gate period closing. Decisions: ADR 0008
(ownership open, mapping as a table, why export state lives outside `jurnal`, two-way sync
rejected) and ADR 0009 (state machine for a target with no idempotency, mutable remote records,
silent party mismatch).

| Table | Purpose |
|---|---|
| `sistem_eksternal` | One row per export target. `arah` is CHECKed to `KELUAR`, so an inbound configuration cannot be represented. Capability flags (`dukung_referensi_eksternal`, `dukung_baca_by_referensi`, `dukung_idempotensi`, the three dimension flags, `maks_baris_per_dokumen`) all default to the pessimistic answer the API research supports, so the exporter degrades instead of assuming. |
| `pemetaan_akun_eksternal` | Our account to their account, one-to-one in both directions while active. References `akun(postable_id)`, so only accounts that can appear in a journal line can be mapped. Also declares what sub-ledger party the account expects (`jenis_pihak_diharapkan`, `pihak_wajib`), because a party of the wrong kind is accepted silently on their side. |
| `pemetaan_mitra_eksternal` | Our Mitra to their party record (customer by default), one-to-one both ways: two Mitra sharing one customer record would merge two people's receivables in their sub-ledger. |
| `jurnal_ekspor` | Export state per journal per target: the six-state machine (`BELUM_KIRIM`, `SEDANG_DIKIRIM`, `TERKIRIM`, `GAGAL`, `AMBIGU`, `DIKECUALIKAN`), attempt bookkeeping, their id, the adapter used, the payload fingerprint pair, and the remote-verification triple. `UNIQUE (jurnal_id, sistem_kode)` is the actual double-post protection, because the target has none. Physical delete blocked. |
| `berkas_ekspor` | A file-adapter push: one file covering many journals, with a CHECK that its totals balance. |
| `pengambilan_saldo_eksternal` | One row per fetch of external balances for a period. Exactly one run is current per (target, period); older runs stay, which is what makes remote drift detectable. |
| `saldo_akun_eksternal` | What the target reported, per run per account. Same debit-positive convention and same self-checking identity as `saldo_akun_periode`. Never overwritten in place. |

| View | Purpose |
|---|---|
| `v_akun_belum_dipetakan` | Accounts already in use (posted lines, or an active event mapping) with no active counterpart. Must be empty before a push starts. |
| `v_baris_jurnal_pihak_bermasalah` | Posted lines whose sub-ledger party does not match the mapped account's expectation, classified as `PIHAK_HILANG`, `PIHAK_TIDAK_DIPETAKAN`, `PIHAK_TIDAK_DIHARAPKAN` or `JENIS_PIHAK_TIDAK_COCOK`. The check the target does not perform. |
| `v_jurnal_belum_terkirim` | Posted journals not yet successfully exported, per target, per period. `BELUM_ADA_JEJAK` means the export layer has never seen the journal. |
| `v_ekspor_perlu_keputusan` | Rows a machine must not resolve: ambiguous sends, sends still in flight, and journals that changed or vanished on their side. |
| `v_ekspor_payload_berubah` | Journals marked sent whose current payload no longer hashes to what was sent. |
| `v_rekonsiliasi_eksternal` | Per period per account: our snapshot versus their current fetch, with the count of journals not yet exported. Symmetric; does not presume which side is authoritative. |
| `v_drift_saldo_eksternal` | Their balance movement between the previous fetch and the current one. Non-empty for a CLOSED period means a pushed journal was edited or deleted over there. |

Integration parameters live in `konfigurasi` under group `integrasi` (master switch off, target,
`pemegang_buku_resmi` defaulting to `SISTEM_INI`, adapter, push granularity, line limit unknown,
retry budget, in-flight timeout, the two pre-push gates, remote re-verification interval,
dimension switch). All flagged `perlu_konfirmasi`.

## Relationship map

```
bumn
 ├─ cabang ── app_user ── user_role ── app_role ── role_permission ── permission
 │    ├─ karyawan
 │    ├─ cluster ── cluster_anggota ──┐
 │    └─ mitra ───────────────────────┘
 │        ├─ mitra_dokumen
 │        └─ portal_akun_mitra
 ├─ provinsi ── kota ── (cabang.kota_id, mitra.kota_id, nonpumk_proposal.kota_id)
 ├─ sektor_pumk, bidang_non_pumk, sdg
 ├─ konfigurasi, kolektibilitas_range, penyisihan_rate  (bumn_id NULL = global default)
 ├─ nomor_urut
 ├─ baris_laporan ── akun (klasifikasi_laporan)
 │                    └─ akun.postable_id ◄── jurnal_baris.akun_id
 │                                        ◄── event_jurnal_mapping
 ├─ periode ──┬── jurnal
 │            ├── closing_kolektibilitas ── kolektibilitas_snapshot
 │            ├── penyisihan_periode ── penyisihan_periode_jurnal ──► jurnal
 │            ├── akrual_jasa_snapshot
 │            └── saldo_akun_periode
 ├─ jurnal ── jurnal_baris ──► akun, mitra, pumk_akad
 │      ▲  reversal_of_jurnal_id / reversed_by_jurnal_id (self, 1:1)
 │      └── referenced by pumk_pencairan, pumk_angsuran, pumk_pengakhiran,
 │          pumk_kelebihan, nonpumk_penyaluran, nonpumk_lpj,
 │          penyisihan_periode_jurnal, akrual_jasa_snapshot, saldo_awal_batch
 ├─ rka ── rka_detail ──► akun / sektor_pumk / bidang_non_pumk
 └─ portal_submission ──► pumk_proposal / nonpumk_proposal (converted)

pumk_proposal ── pumk_survey, pumk_jaminan, pumk_review, pumk_approval,
                 pumk_proposal_transisi
      └─ pumk_akad
           ├─ pumk_jadwal_versi ── pumk_jadwal_angsuran
           ├─ pumk_pencairan, pumk_angsuran ── pumk_kelebihan
           ├─ pumk_reschedule ──► pumk_jadwal_versi
           ├─ pumk_pengakhiran
           ├─ tindak_lanjut_penagihan
           ├─ akad_saldo_awal ──► saldo_awal_batch ── akun_saldo_awal
           └─ kolektibilitas_snapshot, akrual_jasa_snapshot

nonpumk_proposal ── nonpumk_penilaian, nonpumk_review, nonpumk_approval,
                    nonpumk_proposal_sdg, nonpumk_proposal_transisi,
                    nonpumk_penyaluran, nonpumk_lpj

optional integration layer (inert until a target is active)
sistem_eksternal ──┬── pemetaan_akun_eksternal ──► akun(postable_id)
                   ├── pemetaan_mitra_eksternal ──► mitra
                   ├── jurnal_ekspor ──► jurnal, berkas_ekspor
                   └── pengambilan_saldo_eksternal ── saldo_akun_eksternal ──► akun, periode
```

## Query shapes the indexes are built for

| Report or check | Index |
|---|---|
| Any report header (branch + date range) | `jurnal_ledger_cabang_tanggal_idx` (partial on POSTED or REVERSED, added 0018); `jurnal_cabang_tanggal_idx` remains for POSTED-only queries |
| Rekap Jurnal, Neraca Lajur, closing prerequisites | `jurnal_periode_status_idx`, `jurnal_periode_jenis_idx` |
| "Are there DRAFT journals in this period" (spec 8.4 check 2) | `jurnal_draft_idx` |
| Buku Besar per account | `jurnal_baris_akun_jurnal_idx` |
| Piutang sub-ledger reconciliation (spec 8.4 check 10) | `jurnal_baris_rekonsiliasi_idx` (covering, includes the amounts) |
| Kartu Piutang per mitra | `jurnal_baris_mitra_idx`, `pumk_angsuran_akad_idx`, `pumk_jadwal_akad_idx` |
| Collectibility run (active loans with a balance) | `pumk_akad_outstanding_idx` |
| Laporan Jatuh Tempo | `pumk_jadwal_jatuh_tempo_idx` (partial on unpaid, active version) |
| Penyaluran by province / sector / bidang | `mitra_kota_idx`, `mitra_sektor_idx`, `pumk_proposal_sektor_idx`, `nonpumk_proposal_bidang_idx` |
| Provision reports per class | `kolektibilitas_snapshot_kelas_idx`, `kolektibilitas_snapshot_sektor_idx` |
| Audit trail by user / entity / rejection | `audit_log_user_idx`, `audit_log_entitas_idx`, `audit_log_ditolak_idx` |
| Journals that entered outside the engine | `jurnal_jalur_posting_idx` (partial, added 0020) |
| Closing idempotency, per tenant | `jurnal_idempotensi_uq` on `(bumn_id, kunci_idempotensi)` (rescoped in 0020) |
| Export worklist, retries, stuck sends | `jurnal_ekspor_status_idx`, `jurnal_ekspor_gagal_idx`, `jurnal_ekspor_inflight_idx` |
| Sent journals due for re-verification against a mutable remote | `jurnal_ekspor_verifikasi_idx` |
| External balance reconciliation and drift | `saldo_akun_eksternal_periode_idx`, `pengambilan_saldo_eksternal_periode_idx` |
