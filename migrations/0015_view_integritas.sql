-- 0015_view_integritas.sql  (spec 8.4 checks, spec 9.6 tools)
--
-- The reconciliation and integrity checks the closing checklist and the health
-- check page both need, defined once as views so the service layer, the seed
-- validator and a DBA looking at production all read the same SQL. No table
-- is created here; a view cannot drift from the ledger.
--
-- Which account is "Piutang Pinjaman Mitra Binaan" is NOT hardcoded: it is
-- read from event_jurnal_mapping (the debit leg of PENCAIRAN_PUMK), so the
-- reconciliation follows the configured chart of accounts (invariant 11).

-- up

-- spec 8.4 check 10, the most important reconciliation in the system:
-- akad-by-akad, sub-ledger outstanding versus the general ledger.
CREATE VIEW v_rekonsiliasi_piutang AS
WITH akun_piutang AS (
  SELECT bumn_id, akun_debit_id AS akun_id
  FROM event_jurnal_mapping
  WHERE event_code = 'PENCAIRAN_PUMK' AND aktif AND deleted_at IS NULL
), buku_besar AS (
  -- Cast back to NUMERIC(20,2): sum() widens to unconstrained numeric, and
  -- every money value in this schema is NUMERIC(20,2), views included.
  SELECT b.akad_id, sum(b.debit - b.kredit)::numeric(20,2) AS saldo_buku_besar
  FROM jurnal_baris b
  JOIN jurnal j ON j.id = b.jurnal_id
  JOIN akun_piutang ap ON ap.akun_id = b.akun_id AND ap.bumn_id = j.bumn_id
  WHERE j.status = 'POSTED'
    AND j.deleted_at IS NULL
    AND b.deleted_at IS NULL
    AND b.akad_id IS NOT NULL
  GROUP BY b.akad_id
)
SELECT
  a.id AS akad_id,
  a.no_akad,
  a.cabang_id,
  a.mitra_id,
  a.status,
  a.outstanding_pokok AS saldo_sub_ledger,
  coalesce(bb.saldo_buku_besar, 0)::numeric(20,2) AS saldo_buku_besar,
  (a.outstanding_pokok - coalesce(bb.saldo_buku_besar, 0))::numeric(20,2) AS selisih
FROM pumk_akad a
LEFT JOIN buku_besar bb ON bb.akad_id = a.id
WHERE a.deleted_at IS NULL;

COMMENT ON VIEW v_rekonsiliasi_piutang IS
  'Spec 8.4 check 10. Rows with selisih <> 0 must block period closing and are the drill-down list the UI shows.';

-- spec 8.4 check 3 and spec 9.6 integrity check: a POSTED jurnal whose lines
-- do not balance, computed from the lines and never from the total columns.
CREATE VIEW v_integritas_jurnal AS
SELECT
  j.id AS jurnal_id,
  j.no_jurnal,
  j.cabang_id,
  j.periode_id,
  j.tanggal_transaksi,
  j.status,
  count(b.id) AS jumlah_baris,
  coalesce(sum(b.debit), 0)::numeric(20,2) AS total_debit_baris,
  coalesce(sum(b.kredit), 0)::numeric(20,2) AS total_kredit_baris,
  (coalesce(sum(b.debit), 0) - coalesce(sum(b.kredit), 0))::numeric(20,2) AS selisih,
  j.total_debit AS total_debit_header,
  j.total_kredit AS total_kredit_header
FROM jurnal j
LEFT JOIN jurnal_baris b ON b.jurnal_id = j.id AND b.deleted_at IS NULL
WHERE j.deleted_at IS NULL
GROUP BY j.id
HAVING coalesce(sum(b.debit), 0) <> coalesce(sum(b.kredit), 0)
    OR count(b.id) < 2
    OR j.total_debit <> coalesce(sum(b.debit), 0)
    OR j.total_kredit <> coalesce(sum(b.kredit), 0);

COMMENT ON VIEW v_integritas_jurnal IS
  'Any row here is a bug: the triggers in 0010 make this impossible for POSTED journals. Expected to contain only in-progress DRAFT journals.';

-- spec 9.6 integrity check: an active schedule whose principal does not add up
-- to the loan it belongs to (invariant 9, for versions the deferred trigger
-- cannot cover, i.e. after a reschedule).
CREATE VIEW v_integritas_jadwal AS
SELECT
  a.id AS akad_id,
  a.no_akad,
  a.cabang_id,
  v.versi,
  a.pokok_pinjaman,
  coalesce(sum(s.pokok), 0)::numeric(20,2) AS total_pokok_jadwal,
  (a.pokok_pinjaman - coalesce(sum(s.pokok), 0))::numeric(20,2) AS selisih
FROM pumk_akad a
JOIN pumk_jadwal_versi v ON v.akad_id = a.id AND v.is_active_version
LEFT JOIN pumk_jadwal_angsuran s
       ON s.akad_id = v.akad_id AND s.versi = v.versi AND s.deleted_at IS NULL
WHERE a.deleted_at IS NULL AND v.versi = 1
GROUP BY a.id, v.versi
HAVING a.pokok_pinjaman <> coalesce(sum(s.pokok), 0);

-- spec 9.6 integrity check: duplicate collectibility snapshots. Should be
-- impossible (unique index), kept so the health-check page reports on it
-- rather than assuming.
CREATE VIEW v_integritas_snapshot AS
SELECT periode_id, akad_id, count(*) AS jumlah
FROM kolektibilitas_snapshot
GROUP BY periode_id, akad_id
HAVING count(*) > 1;

-- down
DROP VIEW IF EXISTS v_integritas_snapshot;
DROP VIEW IF EXISTS v_integritas_jadwal;
DROP VIEW IF EXISTS v_integritas_jurnal;
DROP VIEW IF EXISTS v_rekonsiliasi_piutang;
