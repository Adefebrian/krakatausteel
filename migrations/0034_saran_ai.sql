-- 0034_saran_ai.sql  (spec 12, Fase 8)
--
-- ONE TABLE, AND IT IS A LOG, NOT BUSINESS STATE.
--
-- Spec 12 states the rule this whole phase is built around: "AI tidak pernah
-- menyetujui, menolak, memposting jurnal, atau melakukan closing. AI hanya
-- menghasilkan saran ... yang wajib dikonfirmasi manusia." The repo owner
-- restated it more narrowly still: the assistant proposes, a person decides,
-- and nothing an assistant produced may change state without a human act in
-- between.
--
-- That rule needs a place to keep the proposal, because the same section also
-- requires the trail: "Setiap output AI disimpan dengan penanda sumber = AI,
-- model yang dipakai, timestamp, dan siapa yang mengonfirmasi." This table is
-- that place and nothing else. It holds:
--
--   * what the assistant proposed, verbatim, as JSONB DATA;
--   * which model produced it, or NULL when no model was involved at all
--     (the anomaly half of modules/ai makes no LLM call: it is arithmetic
--     over the ledger, and recording a model name for it would be a lie);
--   * what was SENT to the provider, as COUNTS AND A HASH, never as text;
--   * who confirmed it, when, and what they decided.
--
-- WHY THERE IS NO FOREIGN KEY TO A PROPOSAL, A MITRA OR A JOURNAL.
-- A suggestion is made BEFORE the thing it might become exists: a Maker
-- extracts an applicant's proposal document while there is no `mitra` row and
-- no `pumk_proposal` row to point at. `konteks_tipe`/`konteks_id` are
-- provenance, written by the caller, and deliberately not a join key. The
-- consequence -- an orphaned suggestion -- cannot corrupt a number, which is
-- the same trade-off `lampiran` (0014) makes and for the same reason.
--
-- WHY `sumber` IS A COLUMN WITH ONE ALLOWED VALUE.
-- Spec 12 says every AI output carries `sumber = AI`. A CHECK pinning it to
-- 'AI' means a future writer cannot quietly file human-entered data in this
-- table and have it read back as machine-proposed, or the reverse. The column
-- is the marker the spec asks for, and the constraint is what makes it mean
-- something.
--
-- WHAT THIS TABLE MAY NEVER GROW.
-- A column that another module reads to decide anything. The moment a
-- proposal's approval, a journal's posting or a period's close consults a row
-- here, the assistant has write authority by the back door. Everything here is
-- evidence for a person reading a screen.

-- up

CREATE TABLE ai_saran (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bumn_id UUID NOT NULL REFERENCES bumn(id),
  -- The branch of the person who asked. Every read of this table is scoped by
  -- it, the same way every other read in this system is (spec 2 rule 3).
  cabang_id UUID NOT NULL REFERENCES cabang(id),
  jenis TEXT NOT NULL CHECK (jenis IN ('EKSTRAKSI_DOKUMEN', 'ANOMALI_JURNAL')),
  -- Spec 12's marker. One allowed value on purpose; see the header.
  sumber TEXT NOT NULL DEFAULT 'AI' CHECK (sumber = 'AI'),
  -- The model that produced `hasil_json`, or NULL when no model was called.
  -- NULL is not "unknown": it is the honest record for the anomaly half, which
  -- is deterministic arithmetic over v_ledger_baris and reaches no provider.
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('BERHASIL', 'GAGAL', 'NONAKTIF')),
  -- UNTRUSTED. This is a model's output over a document an applicant supplied,
  -- so it is stored as data and rendered as data, never interpreted. Nothing
  -- in this system branches on its contents.
  hasil_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What left the building, described rather than reproduced: character counts,
  -- the number of identifiers redacted by class, and a SHA-256 of the exact
  -- prompt text that was sent. The document text itself is NOT stored here --
  -- it belongs to whatever attachment row the Maker uploaded, and duplicating
  -- it into an AI log would put a second copy of an applicant's papers in a
  -- table nobody expects to find them in.
  masukan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Provenance only. See the header: not a foreign key, by design.
  konteks_tipe TEXT,
  konteks_id UUID,
  -- Spec 12: "siapa yang mengonfirmasi". Both stay NULL until a person acts,
  -- and a suggestion nobody confirmed is exactly what that looks like.
  keputusan TEXT CHECK (keputusan IN ('DITERIMA', 'DITOLAK', 'SEBAGIAN')),
  dikonfirmasi_oleh UUID REFERENCES app_user(id),
  dikonfirmasi_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by UUID,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- A decision and its author move together, or the trail says nothing.
  CONSTRAINT ai_saran_konfirmasi_ck CHECK (
    (keputusan IS NULL AND dikonfirmasi_oleh IS NULL AND dikonfirmasi_at IS NULL)
    OR (keputusan IS NOT NULL AND dikonfirmasi_oleh IS NOT NULL AND dikonfirmasi_at IS NOT NULL)
  )
);

CREATE INDEX ai_saran_bumn_idx ON ai_saran (bumn_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ai_saran_konteks_idx ON ai_saran (konteks_tipe, konteks_id) WHERE konteks_id IS NOT NULL;
CREATE INDEX ai_saran_belum_dikonfirmasi_idx ON ai_saran (bumn_id, created_at DESC)
  WHERE keputusan IS NULL AND deleted_at IS NULL;

COMMENT ON TABLE ai_saran IS
  'Append-only log of AI assistant output (spec 12). Evidence for a human reader, never an input to any decision: no module reads this table to decide anything, and nothing here reaches the ledger.';
COMMENT ON COLUMN ai_saran.hasil_json IS
  'UNTRUSTED model output over applicant-supplied documents. Stored and rendered as data; never interpreted, never branched on.';
COMMENT ON COLUMN ai_saran.masukan_json IS
  'What was sent to the provider, described: character counts, redaction counts per class, and a SHA-256 of the prompt. Never the document text itself.';
COMMENT ON COLUMN ai_saran.model IS
  'Model that produced hasil_json, or NULL when no model was called at all (the anomaly detector is deterministic arithmetic over the ledger).';

SELECT tjsl_attach_audit_trigger('ai_saran');
SELECT tjsl_attach_audit_fk('ai_saran');
SELECT tjsl_attach_soft_delete_check('ai_saran');

-- down
DROP TABLE IF EXISTS ai_saran;
