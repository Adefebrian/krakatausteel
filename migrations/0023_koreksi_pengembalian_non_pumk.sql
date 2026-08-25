-- 0023_koreksi_pengembalian_non_pumk.sql
--
-- Corrects the PENGEMBALIAN_SISA_NON_PUMK mapping ON DATABASES THAT ALREADY
-- RAN THE SEED. The catalogue in apps/api/src/seed/event-jurnal.ts is fixed
-- too, but that only helps a database seeded from now on: `seedEventJurnalMapping`
-- is ON CONFLICT DO NOTHING by design (ADR 0004: an accountant may repoint a
-- mapping, and a re-seed must never undo their correction), so the wrong row
-- would have survived every future `db:seed` on dev, on staging, and on the
-- client's install. "The fix is data, not a deploy" is only true if the data
-- actually reaches the databases that have it wrong.
--
-- THE BUG. Spec 6.4 makes the DEBIT of PENYALURAN_NON_PUMK an expense account
-- "per bidang", chosen on the form, and the shipped row does that
-- (debit_dari_payload = true). The refund row bound its CREDIT to the single
-- pooled 5.1.03. So for any bidang carrying its own expense account, the money
-- went OUT of that account and came BACK into the pooled one: the bidang's
-- expense stayed overstated by exactly the refund, and the pooled account
-- drifted negative by exactly the same amount. Both journals balance to the
-- sen, so the ledger invariants, the trial balance and every closing check
-- pass; the only place it shows is Laporan Rekap Penyaluran Non PUMK per
-- Bidang (spec 10 report 13), months later. Recorded as ASSUMPTIONS.md A-45.
--
-- NARROW ON PURPOSE. The UPDATE touches only rows that still carry the shipped
-- default (kredit_dari_payload = false AND akun_kredit_id = that entity's own
-- 5.1.03). A row an accountant has already repointed somewhere else does not
-- match and is left exactly as they left it, which is the same rule the seed
-- follows.
--
-- THE ACCOUNT COLUMN IS EMPTIED, NOT LEFT AT 5.1.03, and that was argued.
-- The proposal was to keep 5.1.03 on the row as a "default" beside the raised
-- flag, so the mapping still documents where a refund lands when the caller
-- supplies nothing. It is refused, because modules/jurnal resolves a leg as
-- `dari_payload ? payload.akun : row.akun` with NO fallback: when the flag is
-- up, that column is read by NOTHING. Leaving the pooled account there would
-- park an unread value in the exact column where the wrong answer used to live,
-- for the next person who greps "which account does a refund credit" to find
-- and believe. Either the row decides the account or the caller does, and here
-- the caller must, because only the caller knows which termin is being
-- refunded. A test that needs "the account this refund should credit" reads the
-- disbursement's `akun_beban_id`, which is the invariant that actually matters
-- (a refund credits back what its disbursement debited); reading it from the
-- mapping would only ever re-assert the pooled default this migration removes.
-- Making the engine fall back to the row instead is possible but is a change in
-- modules/jurnal with a real cost: a caller that forgets the account would post
-- to the pooled account silently instead of being refused, which is exactly the
-- failure this migration exists to end. The flag itself is now stated
-- independently of the account in apps/api/src/seed/event-jurnal.ts, so the two
-- can be separated the day that engine change is actually wanted.
--
-- POSTED JOURNALS ARE NOT TOUCHED, AND MUST NOT BE. `jurnal_baris` stores the
-- resolved `akun_id`, not the mapping, so entries already in the ledger keep
-- the account they were posted to. Correcting a posted entry is a REVERSAL
-- (spec 6.3, invariant 4), never an UPDATE of the books, and at the time of
-- writing no PENGEMBALIAN_SISA_NON_PUMK journal exists anywhere: the Non PUMK
-- engine is unbuilt. If one is ever found on an older database, it is a
-- reversal plus a re-post, done by an accountant, not by a migration.

-- up

UPDATE event_jurnal_mapping m
   SET kredit_dari_payload = true,
       akun_kredit_id = NULL,
       deskripsi = 'Sisa dana Non PUMK dikembalikan setelah LPJ, akun beban per bidang dari form'
 WHERE m.event_code = 'PENGEMBALIAN_SISA_NON_PUMK'
   AND m.deleted_at IS NULL
   AND m.kredit_dari_payload = false
   AND m.akun_kredit_id IS NOT DISTINCT FROM (
         SELECT a.postable_id FROM akun a
          WHERE a.bumn_id = m.bumn_id AND a.kode = '5.1.03' AND a.deleted_at IS NULL
       );

-- down
-- The exact inverse, and just as narrow: only rows that look like what the up
-- produced (credit from payload, no account) go back to the pooled 5.1.03.
-- A row someone has changed since does not match and is left alone, so a
-- rollback restores the pre-0023 state without overwriting anything that was
-- not this migration's doing.
UPDATE event_jurnal_mapping m
   SET kredit_dari_payload = false,
       akun_kredit_id = (
         SELECT a.postable_id FROM akun a
          WHERE a.bumn_id = m.bumn_id AND a.kode = '5.1.03' AND a.deleted_at IS NULL
       ),
       deskripsi = 'Sisa dana Non PUMK dikembalikan setelah LPJ'
 WHERE m.event_code = 'PENGEMBALIAN_SISA_NON_PUMK'
   AND m.deleted_at IS NULL
   AND m.kredit_dari_payload = true
   AND m.akun_kredit_id IS NULL
   AND EXISTS (
         SELECT 1 FROM akun a
          WHERE a.bumn_id = m.bumn_id AND a.kode = '5.1.03' AND a.deleted_at IS NULL
       );
