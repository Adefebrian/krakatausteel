-- 0016_integrasi_eksternal.sql
--
-- Optional outbound accounting-integration layer (target: Accurate Online).
--
-- WHO HOLDS THE AUTHORITATIVE TJSL BOOKS IS NOT DECIDED (ADR 0008). Until it
-- is, the default from spec section 1 stands: the TJSL unit is a separate
-- reporting entity, THIS system holds the books and produces the section 10.3
-- statements in full. This migration adds no column to jurnal, modifies no
-- trigger in 0007 or 0010, demotes no report, and touches no account. Roll it
-- back and the system behaves exactly as it did at 0015.
--
-- THE LAYER IS INERT UNTIL CONFIGURED. One pre-registered target row with
-- aktif = false, every other table empty, konfigurasi.integrasi_akuntansi_aktif
-- false, and no constraint anywhere else depends on any of it. Export state
-- deliberately does NOT gate period closing yet (see section 3 below).
--
-- WHAT THE API RESEARCH CHANGED (docs/INTEGRASI-ACCURATE.md, and note its
-- section 0 confidence caveat: search extraction, primary sources unopened).
-- Three findings are load-bearing for this schema, and each one is answered
-- structurally rather than in a comment:
--
--   1. Accurate Online appears to have NO idempotency mechanism, journal
--      numbers are manually settable and uniqueness looks unenforced, and
--      lookup-by-our-number is unconfirmed. So jurnal_ekspor is not a
--      convenience table, it is the ONLY thing between a network timeout and a
--      duplicated journal in the other system. Hence the state machine below:
--      an attempt is recorded as SEDANG_DIKIRIM and COMMITTED BEFORE the call
--      goes out, so a crash mid-call leaves a visible in-flight row; that row
--      can only move to AMBIGU, and AMBIGU can NEVER go back to SEDANG_DIKIRIM.
--      A blind retry is not a discouraged practice here, it is unrepresentable.
--
--   2. Journal vouchers in Accurate are mutable, including a documented bulk
--      delete, so "sent" is not a state we can trust forever. jurnal_ekspor
--      therefore carries a remote-verification triple (status_remote,
--      sidik_remote, diverifikasi_at) paired with their id, and external
--      balances are fetched per RUN (pengambilan_saldo_eksternal) instead of
--      being overwritten in place, so drift on their side is detectable per
--      period rather than assumed absent.
--
--   3. Sub-ledger party selection on a journal line fails SILENTLY when the
--      party type does not match the account type (a receivable line with a
--      vendor selected saves, then never appears in the AR sub-ledger). Since
--      the per-Mitra receivable sub-ledger is the heart of this system,
--      validation is ours and must happen before the push. So the account
--      mapping declares what kind of party an account expects, mitra get their
--      own party mapping, and 0017 turns both into a pre-push query.
--
-- Dimensions (department, project, branch) are edition-dependent in Accurate,
-- so they are capability FLAGS on the target, never requirements: an export
-- with no dimension support is still valid.
--
-- STILL ENDPOINT-AGNOSTIC. No URL, endpoint, field name or auth scheme appears
-- here; the researcher deliberately refused to guess those and the unblocker
-- is pulling the API descriptor with a developer account. Everything the
-- research can still change is data (capability flags, konfigurasi), not DDL.
-- Assumptions: ASSUMPTIONS.md A-21..A-32. Questions: OPEN-QUESTIONS.md 11..19.

-- up

CREATE TABLE sistem_eksternal (
  kode TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  jenis TEXT NOT NULL DEFAULT 'AKUNTANSI' CHECK (jenis IN ('AKUNTANSI', 'LAINNYA')),
  -- Which adapter behind the single export port is in force. Data, not code,
  -- so falling back from API to FILE is a config change.
  adapter_aktif TEXT NOT NULL DEFAULT 'FILE' CHECK (adapter_aktif IN ('API', 'FILE')),
  -- One way, outbound, always, in either outcome of the ownership question.
  -- The CHECK is the point: an inbound configuration cannot be represented
  -- without an explicit, reviewable schema change. See ADR 0008.
  arah TEXT NOT NULL DEFAULT 'KELUAR' CHECK (arah = 'KELUAR'),
  -- CAPABILITY FLAGS. All default to the pessimistic answer, which is what the
  -- research actually supports. They exist so the exporter degrades instead of
  -- assuming: an unsupported dimension is omitted, an unsupported external
  -- reference means idempotency is entirely ours, and no lookup-by-reference
  -- means ambiguous sends need a human instead of an automated reconciliation.
  dukung_referensi_eksternal BOOLEAN NOT NULL DEFAULT false,
  dukung_baca_by_referensi BOOLEAN NOT NULL DEFAULT false,
  dukung_idempotensi BOOLEAN NOT NULL DEFAULT false,
  dukung_dimensi_departemen BOOLEAN NOT NULL DEFAULT false,
  dukung_dimensi_proyek BOOLEAN NOT NULL DEFAULT false,
  dukung_dimensi_cabang BOOLEAN NOT NULL DEFAULT false,
  dukung_pihak_sub_ledger BOOLEAN NOT NULL DEFAULT false,
  -- 0 = unknown, so the exporter must stay conservative and split (the research
  -- found no documented hard limit, only advice to split large imports).
  maks_baris_per_dokumen INTEGER NOT NULL DEFAULT 0 CHECK (maks_baris_per_dokumen >= 0),
  aktif BOOLEAN NOT NULL DEFAULT false,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- A target that cannot be read back by our reference cannot have its
  -- ambiguous sends resolved automatically; that is a fact worth keeping
  -- consistent rather than a combination worth allowing by accident.
  CONSTRAINT sistem_eksternal_baca_ck CHECK (
    NOT dukung_baca_by_referensi OR dukung_referensi_eksternal
  )
);
COMMENT ON TABLE sistem_eksternal IS
  'Optional outbound export targets. Zero active rows means the whole integration layer is inert. Capability flags default to the pessimistic answer supported by docs/INTEGRASI-ACCURATE.md and are corrected once the API descriptor is pulled.';

INSERT INTO sistem_eksternal (kode, nama, jenis, adapter_aktif, aktif, keterangan) VALUES
  ('ACCURATE_ONLINE', 'Accurate Online', 'AKUNTANSI', 'FILE', false,
   'Target ekspor jurnal. Semua flag kemampuan masih false sesuai temuan riset (tidak ditemukan mekanisme idempotensi, referensi eksternal belum terkonfirmasi). Aktifkan setelah deskriptor API ditarik, pemetaan akun dan pihak lengkap, dan pemilik memutuskan siapa pemegang buku resmi.');

-- ---------------------------------------------------------------------------
-- 1. Account mapping, with the party expectation that finding 3 requires
-- ---------------------------------------------------------------------------

CREATE TABLE pemetaan_akun_eksternal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sistem_kode TEXT NOT NULL REFERENCES sistem_eksternal(kode),
  -- FK to akun(postable_id), not akun(id): only postable accounts can appear
  -- in a jurnal_baris, so only they can need a counterpart. Same generated
  -- column as ADR 0003, and it inherits the same bonus: a mapped account
  -- cannot be flipped to non-postable.
  akun_id UUID NOT NULL REFERENCES akun(postable_id),
  -- Their identifiers, two of them on purpose: the NUMBER is what a human
  -- reconciles against a printed report, the ID is the surrogate key an API
  -- expects back. Which one their API requires is unverified (A-22).
  akun_eksternal_no TEXT NOT NULL,
  akun_eksternal_id TEXT,
  akun_eksternal_nama TEXT,
  -- Their account TYPE as read from the target (for example a receivable
  -- type). Kept because the party rule below is a consequence of the account
  -- type on their side, and a human needs to see why the rule applies.
  tipe_akun_eksternal TEXT,
  -- FINDING 3. A journal line to a receivable/payable account carries a
  -- sub-ledger party, and a party of the wrong KIND saves without error and
  -- then never appears in the subsidiary ledger. So the expectation is
  -- declared here per account, and 0017 checks every posted line against it
  -- before a push. TIDAK_ADA means the target expects no party at all, and a
  -- line carrying one is just as wrong as a missing one.
  jenis_pihak_diharapkan TEXT NOT NULL DEFAULT 'TIDAK_ADA'
    CHECK (jenis_pihak_diharapkan IN ('TIDAK_ADA', 'PELANGGAN', 'PEMASOK', 'KARYAWAN', 'LAINNYA')),
  -- true = a line to this account without a party is a configuration error,
  -- not merely unusual. This is what makes the per-Mitra receivable push
  -- verifiable instead of hopeful.
  pihak_wajib BOOLEAN NOT NULL DEFAULT false,
  disinkron_at TIMESTAMPTZ,
  aktif BOOLEAN NOT NULL DEFAULT true,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pemetaan_akun_eksternal_no_ck CHECK (btrim(akun_eksternal_no) <> ''),
  -- "party required" without saying which kind is meaningless.
  CONSTRAINT pemetaan_akun_eksternal_pihak_ck CHECK (
    NOT pihak_wajib OR jenis_pihak_diharapkan <> 'TIDAK_ADA'
  )
);
-- One active mapping per account per target: one of our accounts maps to one
-- of theirs.
CREATE UNIQUE INDEX pemetaan_akun_eksternal_akun_uq
  ON pemetaan_akun_eksternal (sistem_kode, akun_id)
  WHERE aktif AND deleted_at IS NULL;
-- And the reverse, so the mapping is a bijection while active. Without this,
-- two of our accounts could point at one of theirs and per-account
-- reconciliation would have no well-defined answer. Dropping this index is a
-- deliberate migration (A-23), not a side effect of a config edit.
CREATE UNIQUE INDEX pemetaan_akun_eksternal_eksternal_uq
  ON pemetaan_akun_eksternal (sistem_kode, akun_eksternal_no)
  WHERE aktif AND deleted_at IS NULL;
CREATE INDEX pemetaan_akun_eksternal_akun_idx ON pemetaan_akun_eksternal (akun_id);
CREATE INDEX pemetaan_akun_eksternal_pihak_idx ON pemetaan_akun_eksternal (sistem_kode)
  WHERE pihak_wajib AND aktif AND deleted_at IS NULL;

-- The other half of finding 3: knowing that a line NEEDS a customer is
-- useless without knowing WHICH customer record on their side a Mitra is. One
-- row per mitra per target. Deliberately a real FK to mitra rather than a
-- polymorphic entitas/entitas_id pair: the only sub-ledger party this system
-- pushes is a Mitra Binaan, and inventing a generic shape here would trade a
-- foreign key for nothing (A-29).
CREATE TABLE pemetaan_mitra_eksternal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sistem_kode TEXT NOT NULL REFERENCES sistem_eksternal(kode),
  mitra_id UUID NOT NULL REFERENCES mitra(id),
  -- Which kind of party record the Mitra is over there. Defaults to PELANGGAN
  -- because a receivable sub-ledger party is a customer, but it is explicit so
  -- the pre-push check compares kind to kind rather than assuming.
  jenis_pihak TEXT NOT NULL DEFAULT 'PELANGGAN'
    CHECK (jenis_pihak IN ('PELANGGAN', 'PEMASOK', 'KARYAWAN', 'LAINNYA')),
  pihak_eksternal_no TEXT NOT NULL,
  pihak_eksternal_id TEXT,
  pihak_eksternal_nama TEXT,
  disinkron_at TIMESTAMPTZ,
  aktif BOOLEAN NOT NULL DEFAULT true,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT pemetaan_mitra_eksternal_no_ck CHECK (btrim(pihak_eksternal_no) <> '')
);
CREATE UNIQUE INDEX pemetaan_mitra_eksternal_mitra_uq
  ON pemetaan_mitra_eksternal (sistem_kode, mitra_id)
  WHERE aktif AND deleted_at IS NULL;
-- One external party record belongs to one Mitra: two Mitra sharing a customer
-- record would merge two people's receivables in their sub-ledger.
CREATE UNIQUE INDEX pemetaan_mitra_eksternal_pihak_uq
  ON pemetaan_mitra_eksternal (sistem_kode, jenis_pihak, pihak_eksternal_no)
  WHERE aktif AND deleted_at IS NULL;
CREATE INDEX pemetaan_mitra_eksternal_mitra_idx ON pemetaan_mitra_eksternal (mitra_id);

-- ---------------------------------------------------------------------------
-- 2. Export state per journal
-- ---------------------------------------------------------------------------

-- A FILE-adapter push produces one file covering many journals. Modelled so a
-- file send is as auditable as an API one, and because the file path has to
-- survive if the API disappoints.
CREATE TABLE berkas_ekspor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sistem_kode TEXT NOT NULL REFERENCES sistem_eksternal(kode),
  adapter TEXT NOT NULL CHECK (adapter IN ('API', 'FILE')),
  cabang_id UUID REFERENCES cabang(id),
  periode_id UUID REFERENCES periode(id),
  nama_file TEXT NOT NULL,
  path TEXT,
  checksum TEXT,
  jumlah_jurnal INTEGER NOT NULL DEFAULT 0 CHECK (jumlah_jurnal >= 0),
  total_debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
  total_kredit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_kredit >= 0),
  status TEXT NOT NULL DEFAULT 'DIBUAT'
    CHECK (status IN ('DIBUAT', 'DIKIRIM', 'DIKONFIRMASI', 'GAGAL', 'DIBATALKAN')),
  dikirim_at TIMESTAMPTZ,
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- A file carrying journals must balance in total. A one-sided export file is
  -- a bug, not an edge case, and the research notes their import requires
  -- balance anyway.
  CONSTRAINT berkas_ekspor_balance_ck CHECK (total_debit = total_kredit)
);
CREATE INDEX berkas_ekspor_sistem_idx ON berkas_ekspor (sistem_kode, created_at DESC);
CREATE INDEX berkas_ekspor_periode_idx ON berkas_ekspor (periode_id) WHERE periode_id IS NOT NULL;

CREATE TABLE jurnal_ekspor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurnal_id UUID NOT NULL REFERENCES jurnal(id),
  sistem_kode TEXT NOT NULL REFERENCES sistem_eksternal(kode),
  -- THE STATE MACHINE (finding 1). Transitions are enforced by trigger below.
  --   BELUM_KIRIM     queued, nothing has been attempted
  --   SEDANG_DIKIRIM  an attempt is in flight. Written and COMMITTED BEFORE
  --                   the call leaves. A row stuck here means the process died
  --                   mid-call, which is information, not a gap.
  --   TERKIRIM        the target confirmed it. Not trusted forever: see the
  --                   remote-verification columns (finding 2).
  --   GAGAL           confirmed NOT booked on their side. Safe to retry.
  --   AMBIGU          unknown whether they booked it (timeout, crash, unparseable
  --                   response). Retry is FORBIDDEN: without idempotency on
  --                   their side a retry can duplicate a real journal. Only an
  --                   explicit human confirmation or a reconciliation pass can
  --                   move it, and only to TERKIRIM or GAGAL.
  --   DIKECUALIKAN    deliberately never sent, with a stated reason.
  status TEXT NOT NULL DEFAULT 'BELUM_KIRIM' CHECK (status IN
    ('BELUM_KIRIM', 'SEDANG_DIKIRIM', 'TERKIRIM', 'GAGAL', 'AMBIGU', 'DIKECUALIKAN')),
  -- Our no_jurnal, kept identical to the journal by trigger and unique per
  -- target. With no idempotency mechanism on their side (finding 1), this is
  -- not their dedup key, it is OUR identification handle: the string a human
  -- searches for in Accurate to answer "did this one land twice".
  referensi_eksternal TEXT NOT NULL,
  -- Whatever id they hand back. Nullable: it is unverified that their API
  -- returns one (A-24).
  id_eksternal TEXT,
  adapter_dipakai TEXT CHECK (adapter_dipakai IN ('API', 'FILE')),
  berkas_ekspor_id UUID REFERENCES berkas_ekspor(id),
  jumlah_percobaan INTEGER NOT NULL DEFAULT 0 CHECK (jumlah_percobaan >= 0),
  -- Set when an attempt STARTS (entering SEDANG_DIKIRIM), before the call.
  percobaan_dimulai_at TIMESTAMPTZ,
  -- Set when an attempt ENDS, whatever the outcome.
  percobaan_terakhir_at TIMESTAMPTZ,
  terkirim_at TIMESTAMPTZ,
  kesalahan_terakhir TEXT,
  kesalahan_terakhir_kode TEXT,
  -- SHA-256 (hex) of the canonical export payload. sidik_payload is what it
  -- hashes to NOW, sidik_payload_terkirim is what was hashed at the moment of
  -- the send. A difference means the payload changed after the send, which
  -- 0017 reports; a changed payload can therefore not masquerade as the same
  -- send.
  sidik_payload TEXT NOT NULL,
  sidik_payload_terkirim TEXT,
  -- FINDING 2: their journal vouchers are mutable, including bulk delete, so
  -- TERKIRIM is a claim with an expiry date. This triple is how we re-check it:
  --   status_remote  what the last verification found on their side
  --   sidik_remote   hash of their record as read back, so an edit is detectable
  --                  and not merely suspected
  --   diverifikasi_* when, and by whom or by which process
  status_remote TEXT NOT NULL DEFAULT 'BELUM_DIPERIKSA'
    CHECK (status_remote IN ('BELUM_DIPERIKSA', 'ADA', 'BERUBAH', 'HILANG')),
  sidik_remote TEXT,
  diverifikasi_at TIMESTAMPTZ,
  diverifikasi_oleh UUID REFERENCES app_user(id),
  catatan_remote TEXT,
  -- How an AMBIGU row was resolved. Required to leave AMBIGU, so the resolution
  -- of a possible double post is always attributable to a person or to a named
  -- reconciliation pass.
  resolusi_metode TEXT CHECK (resolusi_metode IN ('KONFIRMASI_MANUAL', 'REKONSILIASI')),
  resolusi_oleh UUID REFERENCES app_user(id),
  resolusi_at TIMESTAMPTZ,
  resolusi_catatan TEXT,
  alasan_dikecualikan TEXT,
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT jurnal_ekspor_sidik_ck CHECK (sidik_payload ~ '^[0-9a-f]{64}$'),
  CONSTRAINT jurnal_ekspor_sidik_terkirim_ck CHECK (
    sidik_payload_terkirim IS NULL OR sidik_payload_terkirim ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT jurnal_ekspor_sidik_remote_ck CHECK (
    sidik_remote IS NULL OR sidik_remote ~ '^[0-9a-f]{64}$'
  ),
  -- An in-flight row must say when the attempt started; that timestamp is what
  -- a sweeper uses to find a send that died mid-call.
  CONSTRAINT jurnal_ekspor_inflight_ck CHECK (
    status <> 'SEDANG_DIKIRIM' OR (percobaan_dimulai_at IS NOT NULL AND jumlah_percobaan > 0)
  ),
  -- A send that succeeded must say when, with what adapter, and over which
  -- exact payload. Without all three, TERKIRIM is an unverifiable claim.
  CONSTRAINT jurnal_ekspor_terkirim_ck CHECK (
    status <> 'TERKIRIM'
    OR (terkirim_at IS NOT NULL AND adapter_dipakai IS NOT NULL AND sidik_payload_terkirim IS NOT NULL)
  ),
  CONSTRAINT jurnal_ekspor_belum_terkirim_ck CHECK (status = 'TERKIRIM' OR terkirim_at IS NULL),
  CONSTRAINT jurnal_ekspor_gagal_ck CHECK (
    status <> 'GAGAL' OR (kesalahan_terakhir IS NOT NULL AND percobaan_terakhir_at IS NOT NULL)
  ),
  -- An ambiguous row must record what made it ambiguous, otherwise nobody can
  -- resolve it later.
  CONSTRAINT jurnal_ekspor_ambigu_ck CHECK (
    status <> 'AMBIGU' OR (percobaan_dimulai_at IS NOT NULL AND kesalahan_terakhir IS NOT NULL)
  ),
  CONSTRAINT jurnal_ekspor_dikecualikan_ck CHECK (
    status <> 'DIKECUALIKAN' OR btrim(coalesce(alasan_dikecualikan, '')) <> ''
  ),
  CONSTRAINT jurnal_ekspor_percobaan_ck CHECK (
    jumlah_percobaan = 0 OR percobaan_dimulai_at IS NOT NULL
  ),
  -- A resolution is recorded whole or not at all.
  CONSTRAINT jurnal_ekspor_resolusi_ck CHECK (
    (resolusi_metode IS NULL AND resolusi_oleh IS NULL AND resolusi_at IS NULL)
    OR (resolusi_metode IS NOT NULL AND resolusi_oleh IS NOT NULL AND resolusi_at IS NOT NULL)
  ),
  -- Only a row that was actually sent can have been verified over there.
  CONSTRAINT jurnal_ekspor_verifikasi_ck CHECK (
    status_remote = 'BELUM_DIPERIKSA' OR (diverifikasi_at IS NOT NULL AND terkirim_at IS NOT NULL)
  )
);
-- One export record per journal per target. This is what makes "successfully
-- sent twice to the same target" unrepresentable: there is no second row to
-- hold a second success. With no idempotency on their side, this index is the
-- system's actual double-post protection.
CREATE UNIQUE INDEX jurnal_ekspor_jurnal_sistem_uq ON jurnal_ekspor (jurnal_id, sistem_kode);
CREATE UNIQUE INDEX jurnal_ekspor_referensi_uq ON jurnal_ekspor (sistem_kode, referensi_eksternal);
CREATE UNIQUE INDEX jurnal_ekspor_id_eksternal_uq ON jurnal_ekspor (sistem_kode, id_eksternal)
  WHERE id_eksternal IS NOT NULL;
CREATE INDEX jurnal_ekspor_status_idx ON jurnal_ekspor (sistem_kode, status);
CREATE INDEX jurnal_ekspor_gagal_idx ON jurnal_ekspor (sistem_kode, percobaan_terakhir_at)
  WHERE status IN ('GAGAL', 'AMBIGU');
-- Finding a send that died mid-call, and finding sent journals due for
-- re-verification against a mutable remote.
CREATE INDEX jurnal_ekspor_inflight_idx ON jurnal_ekspor (sistem_kode, percobaan_dimulai_at)
  WHERE status = 'SEDANG_DIKIRIM';
CREATE INDEX jurnal_ekspor_verifikasi_idx ON jurnal_ekspor (sistem_kode, diverifikasi_at)
  WHERE status = 'TERKIRIM';
CREATE INDEX jurnal_ekspor_berkas_idx ON jurnal_ekspor (berkas_ekspor_id) WHERE berkas_ekspor_id IS NOT NULL;

-- The state machine, plus the rules a CHECK cannot see.
CREATE OR REPLACE FUNCTION tjsl_jurnal_ekspor_validasi() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  j RECORD;
BEGIN
  SELECT status, no_jurnal INTO j FROM jurnal WHERE id = NEW.jurnal_id;

  -- Only a posted (or reversed, which was posted) journal is an accounting
  -- fact. A DRAFT is still being typed and has nothing to export.
  IF j.status = 'DRAFT' THEN
    RAISE EXCEPTION
      'TJSL-EXP-001: jurnal % masih DRAFT; hanya jurnal POSTED/REVERSED yang punya jejak ekspor', j.no_jurnal
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Our journal number IS the external reference, not a copy that can drift.
  IF NEW.referensi_eksternal <> j.no_jurnal THEN
    RAISE EXCEPTION
      'TJSL-EXP-002: referensi_eksternal (%) wajib sama dengan no_jurnal (%); nomor jurnal kita adalah satu satunya pegangan identifikasi di sistem tujuan',
      NEW.referensi_eksternal, j.no_jurnal
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A trail starts queued or explicitly excluded. It never starts as sent:
    -- a send has to pass through SEDANG_DIKIRIM so that the in-flight moment
    -- is recorded before the call, which is the whole defence against a
    -- duplicate under a timeout.
    IF NEW.status NOT IN ('BELUM_KIRIM', 'DIKECUALIKAN') THEN
      RAISE EXCEPTION
        'TJSL-EXP-010: jejak ekspor baru hanya boleh berstatus BELUM_KIRIM atau DIKECUALIKAN (diminta: %); pengiriman wajib melewati SEDANG_DIKIRIM yang tercatat sebelum panggilan keluar',
        NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- ---- UPDATE path ----
  IF NEW.jurnal_id <> OLD.jurnal_id OR NEW.sistem_kode <> OLD.sistem_kode THEN
    RAISE EXCEPTION 'TJSL-EXP-011: jejak ekspor tidak boleh dipindahkan ke jurnal atau sistem lain'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.jumlah_percobaan < OLD.jumlah_percobaan THEN
    RAISE EXCEPTION 'TJSL-EXP-004: jumlah_percobaan tidak boleh turun (% -> %)',
      OLD.jumlah_percobaan, NEW.jumlah_percobaan
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    -- Allowed transitions, exhaustively.
    IF NOT (
         (OLD.status = 'BELUM_KIRIM'    AND NEW.status IN ('SEDANG_DIKIRIM', 'DIKECUALIKAN'))
      OR (OLD.status = 'SEDANG_DIKIRIM' AND NEW.status IN ('TERKIRIM', 'GAGAL', 'AMBIGU'))
      OR (OLD.status = 'GAGAL'          AND NEW.status IN ('SEDANG_DIKIRIM', 'DIKECUALIKAN'))
      OR (OLD.status = 'AMBIGU'         AND NEW.status IN ('TERKIRIM', 'GAGAL'))
      OR (OLD.status = 'DIKECUALIKAN'   AND NEW.status = 'BELUM_KIRIM')
    ) THEN
      RAISE EXCEPTION
        'TJSL-EXP-012: transisi status ekspor % -> % tidak diizinkan untuk jurnal %',
        OLD.status, NEW.status, j.no_jurnal
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- The rule finding 1 exists for: an ambiguous send can NEVER be retried.
    -- It is resolved by looking, not by sending again. The transition table
    -- above already omits AMBIGU -> SEDANG_DIKIRIM; this raise names the
    -- reason so the error is self-explanatory in a log.
    IF OLD.status = 'AMBIGU' AND NEW.status = 'SEDANG_DIKIRIM' THEN
      RAISE EXCEPTION
        'TJSL-EXP-013: jurnal % berstatus AMBIGU; kirim ulang dilarang karena sistem tujuan tidak punya mekanisme idempotensi. Selesaikan lewat konfirmasi manual atau rekonsiliasi (TERKIRIM/GAGAL) lebih dulu',
        j.no_jurnal
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Starting an attempt must count it, before the call goes out.
    IF NEW.status = 'SEDANG_DIKIRIM' AND (
         NEW.jumlah_percobaan <= OLD.jumlah_percobaan
      OR NEW.percobaan_dimulai_at IS NULL
      OR NEW.percobaan_dimulai_at = OLD.percobaan_dimulai_at
    ) THEN
      RAISE EXCEPTION
        'TJSL-EXP-014: masuk SEDANG_DIKIRIM wajib menaikkan jumlah_percobaan dan menyetel percobaan_dimulai_at baru; percobaan dicatat sebelum panggilan keluar, bukan sesudah'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Leaving AMBIGU is a decision, and a decision has an owner.
    IF OLD.status = 'AMBIGU' AND (
         NEW.resolusi_metode IS NULL
      OR NEW.resolusi_oleh IS NULL
      OR NEW.resolusi_at IS NULL
      OR btrim(coalesce(NEW.resolusi_catatan, '')) = ''
    ) THEN
      RAISE EXCEPTION
        'TJSL-EXP-015: keluar dari status AMBIGU wajib mencatat resolusi_metode, resolusi_oleh, resolusi_at, dan resolusi_catatan'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- TERKIRIM is terminal for the SEND. What may still change afterwards is the
  -- record of what the remote looks like now (finding 2: their vouchers are
  -- mutable), plus our recomputed payload fingerprint. The evidence of the send
  -- itself is frozen. A correction is a reversing journal here, which becomes
  -- its own export row.
  IF OLD.status = 'TERKIRIM' AND (
       NEW.status <> OLD.status
    OR NEW.referensi_eksternal <> OLD.referensi_eksternal
    OR NEW.sidik_payload_terkirim IS DISTINCT FROM OLD.sidik_payload_terkirim
    OR NEW.terkirim_at IS DISTINCT FROM OLD.terkirim_at
    OR NEW.adapter_dipakai IS DISTINCT FROM OLD.adapter_dipakai
    OR NEW.jumlah_percobaan <> OLD.jumlah_percobaan
    OR (OLD.id_eksternal IS NOT NULL AND NEW.id_eksternal IS DISTINCT FROM OLD.id_eksternal)
  ) THEN
    RAISE EXCEPTION
      'TJSL-EXP-003: jurnal % sudah TERKIRIM ke %; bukti pengiriman tidak bisa diubah atau dikirim ulang (koreksi lewat jurnal pembalik; perubahan di sisi tujuan dicatat lewat status_remote)',
      j.no_jurnal, OLD.sistem_kode
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_jurnal_ekspor_10_validasi
  BEFORE INSERT OR UPDATE ON jurnal_ekspor
  FOR EACH ROW EXECUTE FUNCTION tjsl_jurnal_ekspor_validasi();

-- The export trail is the evidence that a journal was, or was not, handed to
-- another set of books. It is never physically removed.
SELECT tjsl_attach_block_delete('jurnal_ekspor');

-- ---------------------------------------------------------------------------
-- 3. Closing and export state: deliberately NOT coupled yet
-- ---------------------------------------------------------------------------
-- BUILD-PLAN item 5 (no journal of this period may still be failing to send)
-- is the right rule once pushes are really in use, and it is not built here on
-- purpose: an undecided, inactive integration must not be able to block the
-- accounting cutoff. The data is already there (v_jurnal_belum_terkirim in
-- 0017 reports unsent, failed, in-flight and ambiguous per period), so wiring
-- it in later is one BEFORE UPDATE trigger on periode next to
-- trg_periode_10_transisi.

-- ---------------------------------------------------------------------------
-- 4. Reconciliation landing tables
-- ---------------------------------------------------------------------------
-- External balances have to land somewhere: reconciling a closed period
-- against a live API call would break invariant 14, because re-running last
-- quarter's reconciliation would compare our frozen snapshot against whatever
-- the other system says today, and the report would change under the auditor.
--
-- Finding 2 adds a second requirement: their journals are mutable, so the
-- answer they give for a closed period can legitimately CHANGE between two
-- fetches, and that change is exactly what we need to see. So a fetch is a
-- first-class row (one RUN per fetch) and balances are never overwritten in
-- place. Drift per period is then the difference between the latest run and the
-- previous one, which 0017 exposes as a view.
CREATE TABLE pengambilan_saldo_eksternal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sistem_kode TEXT NOT NULL REFERENCES sistem_eksternal(kode),
  periode_id UUID NOT NULL REFERENCES periode(id),
  diambil_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sumber TEXT NOT NULL DEFAULT 'API' CHECK (sumber IN ('API', 'IMPORT_FILE', 'INPUT_MANUAL')),
  diambil_oleh UUID REFERENCES app_user(id),
  -- Exactly one run per (target, period) is the current one; older runs stay as
  -- the baseline that makes drift detectable.
  is_terkini BOOLEAN NOT NULL DEFAULT true,
  jumlah_akun INTEGER NOT NULL DEFAULT 0 CHECK (jumlah_akun >= 0),
  ringkasan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  catatan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX pengambilan_saldo_eksternal_terkini_uq
  ON pengambilan_saldo_eksternal (sistem_kode, periode_id)
  WHERE is_terkini AND deleted_at IS NULL;
CREATE INDEX pengambilan_saldo_eksternal_periode_idx
  ON pengambilan_saldo_eksternal (periode_id, sistem_kode, diambil_at DESC);

CREATE TABLE saldo_akun_eksternal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pengambilan_id UUID NOT NULL REFERENCES pengambilan_saldo_eksternal(id),
  -- Denormalised from the run so every reconciliation query is one join
  -- shorter and can be indexed directly; kept in step by trigger.
  periode_id UUID NOT NULL REFERENCES periode(id),
  sistem_kode TEXT NOT NULL REFERENCES sistem_eksternal(kode),
  akun_id UUID NOT NULL REFERENCES akun(id),
  -- Their account number as reported, verbatim, so a later mapping change
  -- cannot rewrite history.
  akun_eksternal_no TEXT NOT NULL,
  -- NULL = a consolidated figure with no branch dimension, which is what the
  -- target is expected to return (A-26, and their branch dimension is
  -- edition-dependent anyway).
  cabang_id UUID REFERENCES cabang(id),
  -- Same convention as saldo_akun_periode: debit positive, so a credit-balance
  -- account is negative and the identity below is checkable.
  saldo_awal NUMERIC(20,2) NOT NULL DEFAULT 0,
  mutasi_debit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (mutasi_debit >= 0),
  mutasi_kredit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (mutasi_kredit >= 0),
  saldo_akhir NUMERIC(20,2) NOT NULL DEFAULT 0,
  keterangan TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT saldo_akun_eksternal_identitas_ck CHECK (
    saldo_akhir = saldo_awal + mutasi_debit - mutasi_kredit
  )
);
CREATE UNIQUE INDEX saldo_akun_eksternal_uq
  ON saldo_akun_eksternal (pengambilan_id, akun_id, cabang_id) NULLS NOT DISTINCT;
CREATE INDEX saldo_akun_eksternal_periode_idx ON saldo_akun_eksternal (periode_id, sistem_kode);
CREATE INDEX saldo_akun_eksternal_akun_idx ON saldo_akun_eksternal (akun_id, periode_id);

CREATE OR REPLACE FUNCTION tjsl_saldo_eksternal_sinkron_run() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  r RECORD;
BEGIN
  SELECT sistem_kode, periode_id INTO r
  FROM pengambilan_saldo_eksternal WHERE id = NEW.pengambilan_id;

  IF r.sistem_kode IS DISTINCT FROM NEW.sistem_kode OR r.periode_id IS DISTINCT FROM NEW.periode_id THEN
    RAISE EXCEPTION
      'TJSL-EXT-001: sistem_kode/periode_id baris saldo (% / %) harus sama dengan pengambilannya (% / %)',
      NEW.sistem_kode, NEW.periode_id, r.sistem_kode, r.periode_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_saldo_akun_eksternal_10_run
  BEFORE INSERT OR UPDATE OF pengambilan_id, periode_id, sistem_kode ON saldo_akun_eksternal
  FOR EACH ROW EXECUTE FUNCTION tjsl_saldo_eksternal_sinkron_run();

-- Integration parameters, as data like everything in spec 5. Global defaults
-- (bumn_id NULL), every one of them flagged perlu_konfirmasi, and every one of
-- them set to the pessimistic value the research supports.
INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi) VALUES
  (NULL, 'integrasi', 'integrasi_akuntansi_aktif', 'false', 'BOOLEAN', NULL,
   'Master switch push jurnal ke sistem akuntansi eksternal. false = seluruh lapisan integrasi inert'),
  (NULL, 'integrasi', 'sistem_akuntansi_target', 'ACCURATE_ONLINE', 'STRING', NULL,
   'Kode sistem_eksternal tujuan push jurnal'),
  (NULL, 'integrasi', 'pemegang_buku_resmi', 'SISTEM_INI', 'ENUM', '["SISTEM_INI","EKSTERNAL"]',
   'BELUM DIPUTUSKAN. Default SISTEM_INI sesuai spesifikasi Bagian 1 (unit TJSL adalah entitas pelaporan tersendiri). Mengubah ke EKSTERNAL adalah keputusan pemilik, bukan setelan teknis; lihat ADR 0008 dan OPEN-QUESTIONS butir 11'),
  (NULL, 'integrasi', 'adapter_ekspor', 'FILE', 'ENUM', '["API","FILE"]',
   'Adapter di belakang port ekspor; jalur FILE tetap tersedia kalau API membatasi'),
  (NULL, 'integrasi', 'granularitas_push', 'REKAP_PERIODE', 'ENUM', '["PER_JURNAL","REKAP_PERIODE"]',
   'Default REKAP_PERIODE: batas baris per voucher di sistem tujuan belum terukur, dan sistem ini masih pemegang buku sehingga jurnal ringkas cukup untuk konsolidasi induk. PER_JURNAL hanya kalau Accurate jadi pemegang buku dan batas baris sudah diukur'),
  (NULL, 'integrasi', 'maks_baris_per_dokumen', '0', 'NUMBER', NULL,
   'Batas baris per dokumen di sistem tujuan. 0 = belum diketahui; riset tidak menemukan angka resmi, hanya saran memecah impor besar. Ukur empiris di database uji sebelum push otomatis'),
  (NULL, 'integrasi', 'maks_percobaan_kirim', '5', 'NUMBER', NULL,
   'Batas percobaan kirim otomatis untuk kegagalan yang PASTI (GAGAL). Status AMBIGU tidak pernah dicoba ulang otomatis'),
  (NULL, 'integrasi', 'batas_menit_anggap_ambigu', '5', 'NUMBER', NULL,
   'Umur maksimum baris SEDANG_DIKIRIM sebelum sweeper menandainya AMBIGU (proses mati di tengah panggilan)'),
  (NULL, 'integrasi', 'wajib_pemetaan_lengkap_sebelum_push', 'true', 'BOOLEAN', NULL,
   'Tolak mulai push kalau masih ada akun terpakai yang belum dipetakan (v_akun_belum_dipetakan tidak kosong)'),
  (NULL, 'integrasi', 'wajib_pihak_valid_sebelum_push', 'true', 'BOOLEAN', NULL,
   'Tolak mulai push kalau masih ada baris jurnal yang pihak sub-ledgernya tidak cocok dengan akunnya (v_baris_jurnal_pihak_bermasalah tidak kosong). Mismatch di sisi tujuan gagal SENYAP, jadi validasi wajib di sisi kita'),
  (NULL, 'integrasi', 'verifikasi_remote_setiap_hari', '7', 'NUMBER', NULL,
   'Interval hari untuk memeriksa ulang jurnal TERKIRIM terhadap sistem tujuan. Jurnal di sana bisa diedit atau dihapus tanpa memberi tahu kita'),
  (NULL, 'integrasi', 'kirim_dimensi_program', 'false', 'BOOLEAN', NULL,
   'Ikutkan dimensi program/sektor pada payload ekspor. Default mati: dimensi departemen/proyek di sistem tujuan tergantung edisi, jadi ekspor wajib tetap valid tanpanya');

SELECT tjsl_attach_audit_trigger(t) FROM (VALUES
  ('sistem_eksternal'), ('pemetaan_akun_eksternal'), ('pemetaan_mitra_eksternal'),
  ('berkas_ekspor'), ('jurnal_ekspor'),
  ('pengambilan_saldo_eksternal'), ('saldo_akun_eksternal')
) AS x(t);
SELECT tjsl_attach_audit_fk(t) FROM (VALUES
  ('pemetaan_akun_eksternal'), ('pemetaan_mitra_eksternal'), ('berkas_ekspor'),
  ('jurnal_ekspor'), ('pengambilan_saldo_eksternal'), ('saldo_akun_eksternal')
) AS x(t);
SELECT tjsl_attach_soft_delete_check(t) FROM (VALUES
  ('sistem_eksternal'), ('pemetaan_akun_eksternal'), ('pemetaan_mitra_eksternal'),
  ('berkas_ekspor'), ('jurnal_ekspor'),
  ('pengambilan_saldo_eksternal'), ('saldo_akun_eksternal')
) AS x(t);

-- sistem_eksternal has no audit-actor FKs: it is seeded by this migration
-- before any app_user exists, so created_by would be NULL regardless.

-- down
DELETE FROM konfigurasi WHERE bumn_id IS NULL AND grup = 'integrasi';
DROP TABLE IF EXISTS saldo_akun_eksternal;
DROP FUNCTION IF EXISTS tjsl_saldo_eksternal_sinkron_run() CASCADE;
DROP TABLE IF EXISTS pengambilan_saldo_eksternal;
DROP TABLE IF EXISTS jurnal_ekspor;
DROP FUNCTION IF EXISTS tjsl_jurnal_ekspor_validasi() CASCADE;
DROP TABLE IF EXISTS berkas_ekspor;
DROP TABLE IF EXISTS pemetaan_mitra_eksternal;
DROP TABLE IF EXISTS pemetaan_akun_eksternal;
DROP TABLE IF EXISTS sistem_eksternal;
