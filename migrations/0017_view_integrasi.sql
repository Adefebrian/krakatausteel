-- 0017_view_integrasi.sql
--
-- Read-only support for the optional integration layer in 0016. Views, not
-- tables, for the same reason as 0015: they cannot drift from the ledger, and
-- the service layer, a health-check page and a DBA all read the same SQL.
--
-- All of them are naturally inert: with no target registered and no export
-- rows they return zero rows, and none is referenced by any trigger or
-- constraint. Nothing here decides who holds the books (ADR 0008).
--
-- Three of these views exist specifically because of what the API research
-- found (docs/INTEGRASI-ACCURATE.md):
--   v_baris_jurnal_pihak_bermasalah   party/account mismatch fails SILENTLY
--                                     over there, so we must catch it here
--   v_ekspor_perlu_keputusan          no idempotency over there, so an
--                                     ambiguous send needs a human, not a retry
--   v_drift_saldo_eksternal           their journals are mutable, so a closed
--                                     period's reported balance can change

-- up

-- An account already in use with no counterpart in a registered target is a
-- CONFIGURATION error, and it must be findable before a push starts rather
-- than halfway through one. "In use" is two things on purpose: it has POSTED
-- or REVERSED journal lines, or an active event_jurnal_mapping points at it,
-- which catches an account the first automatic journal will hit even though it
-- has no history yet. Registered-but-inactive targets are included, because
-- validating the mapping is a pre-activation step.
CREATE VIEW v_akun_belum_dipetakan AS
WITH sistem AS (
  SELECT kode, aktif FROM sistem_eksternal WHERE deleted_at IS NULL
), terpakai AS (
  SELECT b.akun_id, count(*) AS jumlah_baris_posted, 0 AS dipakai_event
  FROM jurnal_baris b
  JOIN jurnal j ON j.id = b.jurnal_id
  WHERE j.status IN ('POSTED', 'REVERSED')
    AND j.deleted_at IS NULL
    AND b.deleted_at IS NULL
  GROUP BY b.akun_id
  UNION ALL
  SELECT m.akun_debit_id, 0, 1 FROM event_jurnal_mapping m
  WHERE m.aktif AND m.deleted_at IS NULL AND m.akun_debit_id IS NOT NULL
  UNION ALL
  SELECT m.akun_kredit_id, 0, 1 FROM event_jurnal_mapping m
  WHERE m.aktif AND m.deleted_at IS NULL AND m.akun_kredit_id IS NOT NULL
), terpakai_agg AS (
  SELECT akun_id,
         sum(jumlah_baris_posted) AS jumlah_baris_posted,
         max(dipakai_event) = 1 AS dipakai_event_mapping
  FROM terpakai
  GROUP BY akun_id
)
SELECT
  s.kode AS sistem_kode,
  s.aktif AS sistem_aktif,
  a.id AS akun_id,
  a.kode AS akun_kode,
  a.nama AS akun_nama,
  a.tipe,
  a.aktif AS akun_aktif,
  t.jumlah_baris_posted,
  t.dipakai_event_mapping
FROM terpakai_agg t
JOIN akun a ON a.id = t.akun_id AND a.deleted_at IS NULL
CROSS JOIN sistem s
WHERE NOT EXISTS (
  SELECT 1 FROM pemetaan_akun_eksternal p
  WHERE p.akun_id = a.id AND p.sistem_kode = s.kode AND p.aktif AND p.deleted_at IS NULL
);

COMMENT ON VIEW v_akun_belum_dipetakan IS
  'Accounts already in use with no active counterpart in a registered target. Must be empty before an export run starts (konfigurasi wajib_pemetaan_lengkap_sebelum_push).';

-- FINDING 3, the expensive one. A journal line whose sub-ledger party does not
-- match what the mapped account expects SAVES WITHOUT ERROR on the target and
-- then silently never appears in the subsidiary ledger, which is the worst bug
-- class for an accounting system: the balance sheet and the sub-ledger
-- disagree and nothing complains. Since the per-Mitra receivable sub-ledger is
-- the heart of this system, the check is ours and it runs BEFORE the push.
--
-- Four distinct problems, named so the fix is obvious:
--   PIHAK_HILANG          account expects a party, line has no mitra
--   PIHAK_TIDAK_DIPETAKAN line has a mitra with no active party mapping
--   PIHAK_TIDAK_DIHARAPKAN account expects none, line carries one
--   JENIS_PIHAK_TIDAK_COCOK account expects one kind, the mitra is mapped as another
CREATE VIEW v_baris_jurnal_pihak_bermasalah AS
SELECT
  p.sistem_kode,
  j.periode_id,
  j.cabang_id,
  j.id AS jurnal_id,
  j.no_jurnal,
  j.tanggal_transaksi,
  b.id AS jurnal_baris_id,
  b.urutan,
  a.kode AS akun_kode,
  a.nama AS akun_nama,
  p.akun_eksternal_no,
  p.jenis_pihak_diharapkan,
  p.pihak_wajib,
  b.mitra_id,
  pm.jenis_pihak AS jenis_pihak_terpetakan,
  pm.pihak_eksternal_no,
  CASE
    WHEN p.pihak_wajib AND b.mitra_id IS NULL THEN 'PIHAK_HILANG'
    WHEN p.pihak_wajib AND pm.id IS NULL THEN 'PIHAK_TIDAK_DIPETAKAN'
    WHEN p.jenis_pihak_diharapkan = 'TIDAK_ADA' AND b.mitra_id IS NOT NULL THEN 'PIHAK_TIDAK_DIHARAPKAN'
    ELSE 'JENIS_PIHAK_TIDAK_COCOK'
  END AS masalah
FROM jurnal_baris b
JOIN jurnal j ON j.id = b.jurnal_id
JOIN akun a ON a.id = b.akun_id
JOIN pemetaan_akun_eksternal p
     ON p.akun_id = b.akun_id AND p.aktif AND p.deleted_at IS NULL
LEFT JOIN pemetaan_mitra_eksternal pm
     ON pm.mitra_id = b.mitra_id AND pm.sistem_kode = p.sistem_kode
    AND pm.aktif AND pm.deleted_at IS NULL
WHERE j.status IN ('POSTED', 'REVERSED')
  AND j.deleted_at IS NULL
  AND b.deleted_at IS NULL
  AND (
       (p.pihak_wajib AND b.mitra_id IS NULL)
    OR (p.pihak_wajib AND b.mitra_id IS NOT NULL AND pm.id IS NULL)
    OR (p.jenis_pihak_diharapkan = 'TIDAK_ADA' AND b.mitra_id IS NOT NULL)
    OR (pm.id IS NOT NULL AND pm.jenis_pihak <> p.jenis_pihak_diharapkan)
  );

COMMENT ON VIEW v_baris_jurnal_pihak_bermasalah IS
  'Posted journal lines whose sub-ledger party does not match the mapped accounts expectation. The target accepts these silently and drops them from its subsidiary ledger, so this must be empty before a push (konfigurasi wajib_pihak_valid_sebelum_push).';

-- The export worklist: everything not yet successfully sent, per target. A
-- journal with no export row shows as BELUM_ADA_JEJAK, which is different from
-- BELUM_KIRIM: the first means the export layer has never seen it, the second
-- means it is queued.
CREATE VIEW v_jurnal_belum_terkirim AS
SELECT
  s.kode AS sistem_kode,
  s.aktif AS sistem_aktif,
  j.periode_id,
  p.tahun,
  p.bulan,
  j.cabang_id,
  j.id AS jurnal_id,
  j.no_jurnal,
  j.jenis,
  j.tanggal_transaksi,
  j.total_debit,
  j.total_kredit,
  coalesce(e.status, 'BELUM_ADA_JEJAK') AS status_ekspor,
  coalesce(e.jumlah_percobaan, 0) AS jumlah_percobaan,
  e.percobaan_dimulai_at,
  e.percobaan_terakhir_at,
  e.kesalahan_terakhir_kode,
  e.kesalahan_terakhir
FROM jurnal j
JOIN periode p ON p.id = j.periode_id
CROSS JOIN (SELECT kode, aktif FROM sistem_eksternal WHERE deleted_at IS NULL) s
LEFT JOIN jurnal_ekspor e
       ON e.jurnal_id = j.id AND e.sistem_kode = s.kode AND e.deleted_at IS NULL
WHERE j.status IN ('POSTED', 'REVERSED')
  AND j.deleted_at IS NULL
  AND (e.id IS NULL OR e.status IN ('BELUM_KIRIM', 'SEDANG_DIKIRIM', 'GAGAL', 'AMBIGU'));

COMMENT ON VIEW v_jurnal_belum_terkirim IS
  'Posted journals not yet successfully exported, per target. This is the data a closing prerequisite would read if and when export state is coupled to closing (deliberately not coupled yet, see 0016).';

-- FINDING 1. Rows that CANNOT be resolved by machinery, only by a decision.
-- With no idempotency on the target, a retry after an ambiguous send can
-- duplicate a real journal, so these are queued for a human or for a
-- reconciliation pass. In-flight rows are included with their start time so a
-- sweeper can age them into AMBIGU using konfigurasi batas_menit_anggap_ambigu
-- rather than a threshold baked into a view.
CREATE VIEW v_ekspor_perlu_keputusan AS
SELECT
  e.sistem_kode,
  j.periode_id,
  j.cabang_id,
  e.jurnal_id,
  j.no_jurnal,
  j.tanggal_transaksi,
  e.status,
  e.status_remote,
  e.jumlah_percobaan,
  e.percobaan_dimulai_at,
  e.percobaan_terakhir_at,
  e.terkirim_at,
  e.diverifikasi_at,
  e.id_eksternal,
  e.kesalahan_terakhir_kode,
  e.kesalahan_terakhir,
  CASE
    WHEN e.status = 'AMBIGU' THEN 'AMBIGU_PERLU_KONFIRMASI'
    WHEN e.status = 'SEDANG_DIKIRIM' THEN 'MASIH_IN_FLIGHT'
    WHEN e.status_remote = 'HILANG' THEN 'HILANG_DI_SISI_TUJUAN'
    ELSE 'BERUBAH_DI_SISI_TUJUAN'
  END AS alasan
FROM jurnal_ekspor e
JOIN jurnal j ON j.id = e.jurnal_id
WHERE e.deleted_at IS NULL
  AND (e.status IN ('AMBIGU', 'SEDANG_DIKIRIM') OR e.status_remote IN ('BERUBAH', 'HILANG'));

COMMENT ON VIEW v_ekspor_perlu_keputusan IS
  'Export trails needing a human decision: ambiguous sends (retry is forbidden, the target has no idempotency), sends still in flight, and journals that changed or vanished on the targets side. Never resolve any of these by sending again.';

-- Our own payload changing after a send. The ledger triggers in 0010 make this
-- nearly impossible for the journal itself (POSTED is immutable), so a row
-- here means the payload BUILDER changed, or a mapping change altered what the
-- target would now receive. Either way the two systems no longer agree about
-- what was sent.
CREATE VIEW v_ekspor_payload_berubah AS
SELECT
  e.sistem_kode,
  e.jurnal_id,
  j.no_jurnal,
  j.periode_id,
  j.cabang_id,
  e.terkirim_at,
  e.sidik_payload_terkirim,
  e.sidik_payload AS sidik_payload_sekarang
FROM jurnal_ekspor e
JOIN jurnal j ON j.id = e.jurnal_id
WHERE e.status = 'TERKIRIM'
  AND e.deleted_at IS NULL
  AND e.sidik_payload_terkirim IS DISTINCT FROM e.sidik_payload;

COMMENT ON VIEW v_ekspor_payload_berubah IS
  'Journals marked TERKIRIM whose current export payload no longer hashes to what was sent. Any row is a discrepancy to investigate, never to silently re-send.';

-- Per period per account: our balance versus theirs. Both sides read from
-- frozen snapshots (saldo_akun_periode, and the CURRENT fetch run in
-- saldo_akun_eksternal), never from a live API, so a past period's
-- reconciliation reproduces exactly (invariant 14). Our side is per branch,
-- theirs is expected consolidated, so both are aggregated to (periode, akun)
-- before comparison. Symmetric by design: the same query whichever side turns
-- out to be authoritative, only the meaning of a difference changes.
CREATE VIEW v_rekonsiliasi_eksternal AS
WITH sistem AS (
  SELECT kode FROM sistem_eksternal WHERE deleted_at IS NULL
), internal AS (
  SELECT periode_id, akun_id, sum(saldo_akhir)::numeric(20,2) AS saldo_akhir
  FROM saldo_akun_periode
  WHERE deleted_at IS NULL
  GROUP BY periode_id, akun_id
), eksternal AS (
  SELECT e.periode_id, e.sistem_kode, e.akun_id,
         min(e.akun_eksternal_no) AS akun_eksternal_no,
         sum(e.saldo_akhir)::numeric(20,2) AS saldo_akhir,
         max(r.diambil_at) AS diambil_at
  FROM saldo_akun_eksternal e
  JOIN pengambilan_saldo_eksternal r ON r.id = e.pengambilan_id
  WHERE e.deleted_at IS NULL AND r.deleted_at IS NULL AND r.is_terkini
  GROUP BY e.periode_id, e.sistem_kode, e.akun_id
), kunci AS (
  SELECT s.kode AS sistem_kode, i.periode_id, i.akun_id FROM internal i CROSS JOIN sistem s
  UNION
  SELECT e.sistem_kode, e.periode_id, e.akun_id FROM eksternal e
)
SELECT
  k.sistem_kode,
  k.periode_id,
  p.tahun,
  p.bulan,
  p.status AS status_periode,
  k.akun_id,
  a.kode AS akun_kode,
  a.nama AS akun_nama,
  coalesce(e.akun_eksternal_no, m.akun_eksternal_no) AS akun_eksternal_no,
  e.diambil_at AS saldo_eksternal_diambil_at,
  coalesce(i.saldo_akhir, 0)::numeric(20,2) AS saldo_akhir_internal,
  coalesce(e.saldo_akhir, 0)::numeric(20,2) AS saldo_akhir_eksternal,
  (coalesce(i.saldo_akhir, 0) - coalesce(e.saldo_akhir, 0))::numeric(20,2) AS selisih,
  -- Why a difference may be legitimate rather than an error.
  (SELECT count(*) FROM v_jurnal_belum_terkirim u
    WHERE u.sistem_kode = k.sistem_kode AND u.periode_id = k.periode_id) AS jurnal_belum_terkirim,
  (SELECT count(*) FROM v_jurnal_belum_terkirim u
    WHERE u.sistem_kode = k.sistem_kode AND u.periode_id = k.periode_id
      AND u.status_ekspor IN ('GAGAL', 'AMBIGU')) AS jurnal_gagal_atau_ambigu
FROM kunci k
JOIN periode p ON p.id = k.periode_id
JOIN akun a ON a.id = k.akun_id
LEFT JOIN internal i ON i.periode_id = k.periode_id AND i.akun_id = k.akun_id
LEFT JOIN eksternal e ON e.periode_id = k.periode_id AND e.sistem_kode = k.sistem_kode AND e.akun_id = k.akun_id
LEFT JOIN pemetaan_akun_eksternal m
       ON m.akun_id = k.akun_id AND m.sistem_kode = k.sistem_kode AND m.aktif AND m.deleted_at IS NULL;

COMMENT ON VIEW v_rekonsiliasi_eksternal IS
  'Per period per account: our snapshot balance versus the targets reported balance from the current fetch, with the count of journals not yet exported. Does not presume which side is authoritative.';

-- FINDING 2. Their journal vouchers are mutable, including a documented bulk
-- delete, so a CLOSED period's reported balance can legitimately change
-- between two fetches, and that change is the signal we need. This is the
-- current fetch against the previous one: any row means something moved on
-- their side after we had already reconciled.
CREATE VIEW v_drift_saldo_eksternal AS
WITH terkini AS (
  SELECT r.id AS pengambilan_id, r.sistem_kode, r.periode_id, r.diambil_at
  FROM pengambilan_saldo_eksternal r
  WHERE r.is_terkini AND r.deleted_at IS NULL
), sebelumnya AS (
  SELECT DISTINCT ON (r.sistem_kode, r.periode_id)
         r.id AS pengambilan_id, r.sistem_kode, r.periode_id, r.diambil_at
  FROM pengambilan_saldo_eksternal r
  WHERE NOT r.is_terkini AND r.deleted_at IS NULL
  ORDER BY r.sistem_kode, r.periode_id, r.diambil_at DESC
)
SELECT
  t.sistem_kode,
  t.periode_id,
  p.tahun,
  p.bulan,
  p.status AS status_periode,
  coalesce(st.akun_id, ss.akun_id) AS akun_id,
  a.kode AS akun_kode,
  a.nama AS akun_nama,
  s.diambil_at AS diambil_sebelumnya_at,
  t.diambil_at AS diambil_terkini_at,
  coalesce(ss.saldo_akhir, 0)::numeric(20,2) AS saldo_sebelumnya,
  coalesce(st.saldo_akhir, 0)::numeric(20,2) AS saldo_terkini,
  (coalesce(st.saldo_akhir, 0) - coalesce(ss.saldo_akhir, 0))::numeric(20,2) AS drift
FROM terkini t
JOIN sebelumnya s ON s.sistem_kode = t.sistem_kode AND s.periode_id = t.periode_id
JOIN periode p ON p.id = t.periode_id
LEFT JOIN (
  SELECT pengambilan_id, akun_id, sum(saldo_akhir)::numeric(20,2) AS saldo_akhir
  FROM saldo_akun_eksternal WHERE deleted_at IS NULL GROUP BY pengambilan_id, akun_id
) st ON st.pengambilan_id = t.pengambilan_id
FULL JOIN (
  SELECT pengambilan_id, akun_id, sum(saldo_akhir)::numeric(20,2) AS saldo_akhir
  FROM saldo_akun_eksternal WHERE deleted_at IS NULL GROUP BY pengambilan_id, akun_id
) ss ON ss.pengambilan_id = s.pengambilan_id AND ss.akun_id = st.akun_id
JOIN akun a ON a.id = coalesce(st.akun_id, ss.akun_id)
WHERE coalesce(st.saldo_akhir, 0) <> coalesce(ss.saldo_akhir, 0);

COMMENT ON VIEW v_drift_saldo_eksternal IS
  'Balance movement on the targets side between the previous fetch and the current one, per period per account. Non-empty for a CLOSED period means someone edited or deleted a pushed journal over there.';

-- down
DROP VIEW IF EXISTS v_drift_saldo_eksternal;
DROP VIEW IF EXISTS v_rekonsiliasi_eksternal;
DROP VIEW IF EXISTS v_ekspor_payload_berubah;
DROP VIEW IF EXISTS v_ekspor_perlu_keputusan;
DROP VIEW IF EXISTS v_jurnal_belum_terkirim;
DROP VIEW IF EXISTS v_baris_jurnal_pihak_bermasalah;
DROP VIEW IF EXISTS v_akun_belum_dipetakan;
