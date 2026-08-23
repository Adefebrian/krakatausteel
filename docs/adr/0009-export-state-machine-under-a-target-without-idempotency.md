# 9. Export state machine for a target with no idempotency, mutable vouchers, and silent party mismatch

Date: 2026-08-23

## Status

Accepted

## Context

ADR 0008 built the export layer while the ownership question stayed open. The API research
(`docs/INTEGRASI-ACCURATE.md`) then landed and changed three things about what that layer has to
survive. Read that document's section 0 first: it could not open primary sources, so its findings
are search extraction labelled official versus secondary, and the strongest of the three is
partly an argument from absence.

1. **No idempotency mechanism was found.** No idempotency key, no dedup header, no documented
   "send twice, stored once". Journal numbers can be set manually and uniqueness looks
   unenforced. Whether their voucher can carry our number as a source reference, and whether
   there is any lookup-by-number, is unconfirmed.
2. **Their journal vouchers are mutable**, including a documented bulk delete. A voucher we
   pushed can be edited or deleted on their side without telling us.
3. **Sub-ledger party selection on a journal line fails silently when mismatched.** A partner
   writeup documents a general journal line to a receivable account with a *vendor* selected: it
   saves without error, and the amount then never appears in the AR subsidiary ledger. The
   balance sheet and the sub-ledger disagree and nothing complains.

Each has a sharp consequence for a system whose whole point is a per-Mitra receivable
sub-ledger.

Finding 1 means the classic pattern (send, then record what happened) is unsafe. If the process
records the attempt only after the call returns, then a timeout, a crash, or an unparseable
response leaves nothing on disk, the next run sees an unsent journal, retries, and the target
happily books it twice. There is nothing on their side to stop it.

Finding 2 means "sent" cannot be treated as a fact with an unlimited shelf life, and that a
closed period's reported balance can legitimately differ between two fetches. If external
balances are overwritten in place, that difference is invisible: the drift silently becomes the
new baseline.

Finding 3 means the correctness of the sub-ledger cannot be delegated to the target at all. A
mismatch there is not an error to handle, it is data loss with no signal.

## Decision

### The send is recorded before the call, and an ambiguous send is never retried

`jurnal_ekspor.status` is a six-state machine with transitions enforced by trigger:

```
BELUM_KIRIM ──> SEDANG_DIKIRIM ──> TERKIRIM
     │                │        ├──> GAGAL ──> SEDANG_DIKIRIM   (retry allowed)
     │                │        └──> AMBIGU ─> TERKIRIM | GAGAL (decision only)
     └──> DIKECUALIKAN ──> BELUM_KIRIM
```

- A trail cannot be **created** as `TERKIRIM`. Every send passes through `SEDANG_DIKIRIM`
  (`TJSL-EXP-010`), and entering that state must increment `jumlah_percobaan` and set a fresh
  `percobaan_dimulai_at` (`TJSL-EXP-014`). The application commits that row **before** the call
  goes out. A process that dies mid-call therefore leaves a visible in-flight row, which is
  information; the alternative leaves nothing, which is an invitation to double-post.
- A send whose outcome is unknown becomes `AMBIGU`, and `AMBIGU -> SEDANG_DIKIRIM` **does not
  exist** in the transition table (`TJSL-EXP-012`, with `TJSL-EXP-013` spelling out the reason).
  A blind retry is not discouraged by convention, it is unrepresentable. Resolution requires
  `resolusi_metode` (`KONFIRMASI_MANUAL` or `REKONSILIASI`), `resolusi_oleh`, `resolusi_at` and a
  note (`TJSL-EXP-015`), so the resolution of a possible double post is always attributable.
- `GAGAL` means *confirmed not booked*, and only that state may be retried. Distinguishing "we
  know it failed" from "we do not know" is the entire point of having both.
- The uniqueness of `(jurnal_id, sistem_kode)` remains the hard floor: there is no second row to
  hold a second success.

The consequence to accept openly: because their read-by-reference is unconfirmed, resolving an
`AMBIGU` row may be a human opening Accurate and searching for our journal number. That is why
`referensi_eksternal` is forced equal to `no_jurnal` (`TJSL-EXP-002`) even though their side may
not treat it as a key: it is the string a human searches for. `sistem_eksternal.dukung_baca_by_referensi`
exists so that automated resolution can be switched on the day the capability is verified,
without a migration.

### "Sent" is a claim with an expiry date

`jurnal_ekspor` carries a remote-verification triple next to their id: `status_remote`
(`BELUM_DIPERIKSA` / `ADA` / `BERUBAH` / `HILANG`), `sidik_remote` (hash of their record as read
back) and `diverifikasi_at` / `diverifikasi_oleh`. Verification can only be claimed for a row
that was actually sent (`jurnal_ekspor_verifikasi_ck`), and re-verification updates that triple
while the send evidence stays frozen (`TJSL-EXP-003`). A remote edit or deletion is therefore
recorded as a finding, not applied as a correction, and it surfaces in
`v_ekspor_perlu_keputusan`.

External balances are fetched **per run**: `pengambilan_saldo_eksternal` is one row per fetch,
with a partial unique index making exactly one run current per (target, period), and
`saldo_akun_eksternal` rows hang off a run instead of being overwritten. So the drift between
the previous fetch and the current one is a query (`v_drift_saldo_eksternal`), and a non-empty
result for a CLOSED period means someone changed a pushed journal over there. Overwriting in
place would have made that undetectable, which is the one thing finding 2 makes unacceptable.

### The sub-ledger party is validated here, before the push

`pemetaan_akun_eksternal` declares what a mapped account expects: `jenis_pihak_diharapkan`
(`TIDAK_ADA` / `PELANGGAN` / `PEMASOK` / `KARYAWAN` / `LAINNYA`) and `pihak_wajib`, with a CHECK
that "party required" cannot be stated without saying which kind. `pemetaan_mitra_eksternal`
maps each Mitra to its party record on their side, one-to-one in both directions, because two
Mitra sharing one customer record would merge two people's receivables in their sub-ledger.

`v_baris_jurnal_pihak_bermasalah` then names the four ways a posted line can be wrong:
`PIHAK_HILANG`, `PIHAK_TIDAK_DIPETAKAN`, `PIHAK_TIDAK_DIHARAPKAN`, `JENIS_PIHAK_TIDAK_COCOK`.
`konfigurasi.wajib_pihak_valid_sebelum_push` makes an empty result a precondition of a push.
This is the check the target does not perform, expressed as a query rather than as trust.

### Dimensions degrade, they are never required

Department, project and branch dimensions are edition-dependent over there, so they are
capability flags on `sistem_eksternal` (all defaulting to false) and `konfigurasi.kirim_dimensi_program`
defaults off. An export with no dimension support is a valid export. `jurnal_baris.dimensi_json`
stays what it always was: our analytic dimension, not a push requirement.

### Line limits and granularity stay conservative

No hard line limit was found, only advice to split large imports, so
`sistem_eksternal.maks_baris_per_dokumen` defaults to 0 meaning unknown, and
`konfigurasi.granularitas_push` defaults to `REKAP_PERIODE`. Sending one giant voucher on the
strength of an unmeasured limit is the kind of optimism that produces a half-posted period.

## Consequences

- Double posting now requires defeating a unique index, a transition table and a mandatory
  attributable resolution. The realistic remaining failure is a human resolving an `AMBIGU` row
  wrongly, which is exactly where a human belongs, and it leaves a named record of who decided.
- Every push needs at least two transactions per journal (mark in-flight, then record the
  outcome) and cannot be done inside the journal-creation transaction. That is the correct shape
  anyway: the ledger must not depend on a third party being reachable.
- A row can legitimately sit in `SEDANG_DIKIRIM` after a crash. A sweeper ages it into `AMBIGU`
  using `konfigurasi.batas_menit_anggap_ambigu`; the threshold is config, not a magic number in a
  view.
- Reconciliation costs storage: every fetch of every period is kept. That is deliberate, and it
  is the price of being able to prove that a number changed on the other side.
- The party mapping introduces master-data governance the client must own: each Mitra becomes a
  customer record over there, and someone has to be responsible for creating and deactivating
  those. Recorded in OPEN-QUESTIONS.md item 15.
- If the API descriptor later shows that idempotency, external references or read-by-reference do
  exist, nothing here has to be torn out: the capability flags flip, `AMBIGU` becomes rare and
  auto-resolvable, and the state machine stays correct but less exercised. The design is
  pessimistic on purpose, and being wrong in that direction is cheap.
