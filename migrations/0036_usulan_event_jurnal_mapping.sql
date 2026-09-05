-- 0036_usulan_event_jurnal_mapping.sql  (ADR 0004, spec 6.4, spec 2 rules 1 and 2)
--
-- WHY AN EDIT TO `event_jurnal_mapping` GETS A MAKER-CHECKER AND NOTHING ELSE
-- IN THE ADMINISTRATION API DOES.
--
-- ADR 0004 made the event-to-account mapping DATA rather than code, for three
-- good reasons: the chart of accounts belongs to the client's accountants, an
-- auditor asking "which account did PENCAIRAN_PUMK credit in July 2026" should
-- get a row rather than a git blame, and some legs are not knowable at design
-- time. Every one of those reasons is about who may change it and how the
-- change is evidenced. NONE of them is an argument that the change is small.
--
-- It is not small. One row here decides what EVERY FUTURE JOURNAL of that event
-- debits and credits. Repointing PENCAIRAN_PUMK's debit from Piutang Pinjaman
-- Mitra Binaan to, say, Beban Pembinaan does not fail: it posts, it balances,
-- every integrity check stays green, and the entity quietly stops having
-- receivables while its expenses grow. The demo world already proved this class
-- of defect is invisible to arithmetic checks (see the jasa administrasi
-- misclassification in docs/RESUME.md): what was wrong was the CLASSIFICATION,
-- not the sums, and forty-six green checks did not see it.
--
-- So the control cannot be "the numbers still add up". It has to be a second
-- person who understands accounts looking at the before and the after. That is
-- exactly the maker-checker spec 2 already applies to a proposal, applied to
-- the one configuration row that is closer to a deploy than to data entry.
--
-- WHY A SEPARATE TABLE RATHER THAN A STATUS COLUMN ON THE MAPPING.
-- `event_jurnal_mapping` has a partial unique index on (bumn_id, event_code)
-- WHERE aktif, and the posting engine reads exactly that row. A proposal is not
-- a mapping in a different state; it is a REQUEST that no engine may ever read.
-- Keeping it in its own table means there is no state of this table in which a
-- half-approved row could be picked up by `postingEvent`, and it means the
-- approval writes the mapping through the same shape the seed does.
--
-- WHY THE SEGREGATION IS ENFORCED BY A TRIGGER AND ALSO IN THE SERVICE.
-- Same split ADR 0002 and modules/auth/segregation.ts describe: the trigger is
-- the guarantee (a psql session or a bulk script must not be able to
-- self-approve), the service mirror is what turns it into a 409 with a sentence
-- and refuses BEFORE any side effect. Never remove either half.
--
-- WHY THERE IS NO SEPARATE "APPROVER" PERMISSION.
-- The role catalogue has nothing above ADMIN_PUSAT, so a second code would be
-- held by exactly the same set of people and would buy nothing. The control
-- that has teeth is the PERSON: `diputus_by <> diajukan_by`, enforced below.

-- up

CREATE TABLE event_jurnal_mapping_usulan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  event_code TEXT NOT NULL,

  -- The proposed mapping, in exactly the shape `event_jurnal_mapping` holds it,
  -- with the same constraints, so an approval is a copy and never a conversion.
  akun_debit_id UUID REFERENCES akun(postable_id),
  akun_kredit_id UUID REFERENCES akun(postable_id),
  debit_dari_payload BOOLEAN NOT NULL DEFAULT false,
  kredit_dari_payload BOOLEAN NOT NULL DEFAULT false,
  jenis_jurnal TEXT NOT NULL DEFAULT 'OTOMATIS' CHECK (jenis_jurnal IN
    ('KAS_BANK', 'UMUM', 'PINBUK', 'OTOMATIS', 'PENYISIHAN', 'AKRUAL', 'REVERSAL', 'CLOSING', 'SALDO_AWAL')),
  keterangan TEXT,

  -- WHY THE PROPOSER MUST WRITE A REASON. The row that results carries no
  -- explanation of itself; `event_jurnal_mapping.keterangan` says what the
  -- mapping IS, not why it stopped being the previous one. An auditor reading
  -- a re-mapping a year later needs the sentence, and the person who wrote it.
  alasan TEXT NOT NULL CHECK (length(btrim(alasan)) >= 10),

  -- WHAT WAS IN FORCE WHEN THIS WAS PROPOSED, frozen as JSON. The approver
  -- approves a DIFF, and a diff computed at approval time against a mapping
  -- that moved in between is a different diff from the one that was reviewed.
  mapping_sebelum_json JSONB,

  status TEXT NOT NULL DEFAULT 'DIAJUKAN'
    CHECK (status IN ('DIAJUKAN', 'DISETUJUI', 'DITOLAK', 'DIBATALKAN')),
  -- The mapping row this proposal became, set only on approval.
  diterapkan_mapping_id UUID REFERENCES event_jurnal_mapping(id),

  diajukan_by UUID NOT NULL REFERENCES app_user(id),
  diajukan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  diputus_by UUID REFERENCES app_user(id),
  diputus_at TIMESTAMPTZ,
  catatan_keputusan TEXT,
  -- WITHDRAWAL IS NOT A DECISION, and it has its own column so that stays
  -- visible. `diputus_by` names the SECOND person; a proposal the author took
  -- back never had one, and writing the author's own id there would both be a
  -- lie and be refused by the segregation trigger below.
  dibatalkan_at TIMESTAMPTZ,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),

  -- The same three shape rules `event_jurnal_mapping` carries (0010). Repeated
  -- rather than referenced because a proposal that cannot become a valid
  -- mapping should be refused when it is FILED, not when it is approved.
  CONSTRAINT ejmu_debit_ck CHECK (debit_dari_payload OR akun_debit_id IS NOT NULL),
  CONSTRAINT ejmu_kredit_ck CHECK (kredit_dari_payload OR akun_kredit_id IS NOT NULL),
  CONSTRAINT ejmu_beda_akun_ck CHECK (
    akun_debit_id IS NULL OR akun_kredit_id IS NULL OR akun_debit_id <> akun_kredit_id
  ),
  CONSTRAINT ejmu_keputusan_ck CHECK (
    status NOT IN ('DISETUJUI', 'DITOLAK') OR (diputus_by IS NOT NULL AND diputus_at IS NOT NULL)
  ),
  CONSTRAINT ejmu_batal_ck CHECK ((status = 'DIBATALKAN') = (dibatalkan_at IS NOT NULL)),
  CONSTRAINT ejmu_diterapkan_ck CHECK (
    status <> 'DISETUJUI' OR diterapkan_mapping_id IS NOT NULL
  )
);

-- ONE OPEN PROPOSAL PER EVENT. Two people proposing different accounts for the
-- same event at the same time is a race whose loser silently overwrites the
-- winner at approval time; refusing the second filing is the honest answer.
CREATE UNIQUE INDEX event_jurnal_mapping_usulan_terbuka_uq
  ON event_jurnal_mapping_usulan (bumn_id, event_code)
  WHERE status = 'DIAJUKAN' AND deleted_at IS NULL;
CREATE INDEX event_jurnal_mapping_usulan_status_idx
  ON event_jurnal_mapping_usulan (bumn_id, status, diajukan_at DESC);

-- SEGREGATION OF DUTIES, spec 2 rules 1 and 2 applied to a configuration row.
-- TJSL-SOD-003, next after 001 (checker is not the maker) and 002 (approver is
-- not the checker). core/http.ts already maps every TJSL-SOD-* to a 409 with
-- this message, so the trigger firing is never a 500.
CREATE OR REPLACE FUNCTION tjsl_cek_pemutus_bukan_pengusul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.diputus_by IS NOT NULL AND NEW.diputus_by = NEW.diajukan_by THEN
    RAISE EXCEPTION
      'TJSL-SOD-003: user % mengajukan perubahan pemetaan event ini dan tidak boleh memutuskannya sendiri',
      NEW.diputus_by
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_ejm_usulan_10_sod
  BEFORE INSERT OR UPDATE ON event_jurnal_mapping_usulan
  FOR EACH ROW EXECUTE FUNCTION tjsl_cek_pemutus_bukan_pengusul();

SELECT tjsl_attach_audit_trigger('event_jurnal_mapping_usulan');
SELECT tjsl_attach_audit_fk('event_jurnal_mapping_usulan');
SELECT tjsl_attach_soft_delete_check('event_jurnal_mapping_usulan');

COMMENT ON TABLE event_jurnal_mapping_usulan IS
  'Usulan perubahan event_jurnal_mapping. Tidak pernah dibaca mesin jurnal: hanya baris di event_jurnal_mapping yang aktif yang menentukan jurnal. Persetujuan wajib oleh orang yang berbeda (TJSL-SOD-003).';

-- down
DROP TRIGGER IF EXISTS trg_ejm_usulan_10_sod ON event_jurnal_mapping_usulan;
DROP FUNCTION IF EXISTS tjsl_cek_pemutus_bukan_pengusul();
DROP TABLE IF EXISTS event_jurnal_mapping_usulan;
