# TJSL Online data model

67 tables and 4 views, created by `migrations/0002` through `migrations/0015`. This document is
the map; the migrations are the source of truth and every non-obvious column is commented there.

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
| `kolektibilitas_snapshot` | Per akad per period: arrears days, class, outstanding, arrears, the rate and basis used, and the resulting provision. A CHECK re-derives the provision from the stored inputs, which is what makes report 28 reproducible. Unique per (periode, akad). |
| `penyisihan_periode` | Per branch per period: opening provision balance, required provision, and the expense or recovery, with a CHECK that the third equals the second minus the first. |
| `akrual_jasa_snapshot` | Per akad per period service-fee accrual, so spec 8.3 is idempotent and report 30 is reproducible. |
| `saldo_akun_periode` | Frozen trial balance per (periode, cabang, akun). All four amount columns are debit-positive, and a CHECK enforces closing = opening + debit - credit. Deleted when a period is reopened, by design. |

## 9. Ledger (0010)

| Table | Purpose |
|---|---|
| `jurnal` | Journal header. `total_debit` / `total_kredit` are maintained by trigger from the lines, never trusted from a caller. `kunci_idempotensi` makes closing re-runs safe. Guards: period resolution, closed-period block, POSTED immutability, delete block. |
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
| `v_rekonsiliasi_piutang` | Spec 8.4 check 10, the most important reconciliation in the system: per akad, sub-ledger outstanding versus general ledger. Any non-zero `selisih` blocks period closing. The receivable account is read from `event_jurnal_mapping`, not hardcoded. |
| `v_integritas_jurnal` | Journals whose lines do not balance, or have fewer than 2 lines, or disagree with the header totals. Computed from the lines. Should only ever contain in-progress DRAFT journals. |
| `v_integritas_jadwal` | Active version 1 schedules whose principal does not add up to the loan. |
| `v_integritas_snapshot` | Duplicate collectibility snapshots. Should always be empty. |

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
 │            ├── penyisihan_periode
 │            ├── akrual_jasa_snapshot
 │            └── saldo_akun_periode
 ├─ jurnal ── jurnal_baris ──► akun, mitra, pumk_akad
 │      ▲  reversal_of_jurnal_id / reversed_by_jurnal_id (self, 1:1)
 │      └── referenced by pumk_pencairan, pumk_angsuran, pumk_pengakhiran,
 │          pumk_kelebihan, nonpumk_penyaluran, nonpumk_lpj, penyisihan_periode,
 │          akrual_jasa_snapshot, saldo_awal_batch
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
```

## Query shapes the indexes are built for

| Report or check | Index |
|---|---|
| Any report header (branch + date range) | `jurnal_cabang_tanggal_idx` (partial on POSTED) |
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
