// The Non PUMK business layer (spec 9.2). The single implementation site
// behind `createNonPumkEngine` in ./contract.ts.
//
// WHAT THIS FILE OWNS
//   - the grant proposal state machine of spec 9.2, as a walk over
//     TRANSISI_SAH_NON_PUMK, with the timeline row ("siapa, kapan, catatan
//     apa") written on EVERY transition and on no refusal;
//   - the two mappings spec 9.2 calls mandatory (a bidang, and at least one
//     weighted SDG) and the beneficiary counts, estimated at proposal and
//     actual at LPJ;
//   - the authorisation rules of spec 2: the permission, the BRANCH THE ROW
//     REPORTS (never one supplied by the request), and the two segregation
//     rules produced as clean domain errors AHEAD of TJSL-SOD-001/002;
//   - the STAGED disbursement, refusing the termin that would breach the
//     approved ceiling AHEAD of the deferred TJSL-NPK-002 and BEFORE the
//     ledger is called;
//   - the LPJ, whose remainder is COMPUTED rather than taken from the caller,
//     and whose return journal is posted at VERIFICATION, not at filing;
//   - the read models (timeline, detail summary, late-LPJ ageing).
//
// WHAT THIS FILE DELIBERATELY DOES NOT OWN
//   - NO INSTALMENT ENGINE. A grant has no schedule, no receivable and no
//     kolektibilitas; that absence is why this module's port list is one entry
//     long.
//   - NO LEDGER SQL AND NO ACCOUNT PAIR. Every journal goes through
//     `deps.jurnal.postingEvent` with an EVENT CODE; the accounts come from
//     `event_jurnal_mapping` (invariant 11, ADR 0004). The one account this
//     module passes is the PER-BIDANG expense account that arrived on the form,
//     and it passes it because the mapping row asks for it, not because this
//     module decided which expense account to use. migrations/0020's
//     posting-path tripwire and tools/check-boundaries.ts both refuse any
//     other route.
//   - NO POLICY NUMBER. The amount bounds, the assessment pass mark and the
//     LPJ deadline are read from `konfigurasi` on the call that needs them.
//     spec 5's preamble makes every parameter the client's decision and
//     docs/OPEN-QUESTIONS.md records that none of the Non PUMK limits has been
//     decided, so a literal here would be this repo deciding them. A missing
//     row FAILS CLOSED and NAMES THE KEY, because an operator who cannot see
//     which parameter is missing cannot fix it.
//
// TRANSACTION DISCIPLINE
// Every state-machine step runs inside exactly one `db.transaction`, because a
// status change without its timeline row is an audit trail with a hole in it,
// and a termin on disk with no journal behind it is a grant the buku besar
// does not know about. BOTH NPK guards are DEFERRED constraint triggers that
// fire at COMMIT, so a partial write is not merely untidy: it is a refusal the
// caller cannot attribute to any one statement. The collaborating ledger
// engine owns its own transaction (it is reached as a PORT, not as SQL), so the
// order inside `catatPenyaluran` and `verifikasiLpj` is: write this module's
// row, post the ledger effect, then stamp the journal id back. A ledger
// refusal therefore takes the whole step down with it, and this module never
// holds a row lock across a call into another engine's transaction for longer
// than that one call.
import {
  STATUS_TERMINAL_NON_PUMK,
  transisiNonPumkUntuk,
  type AjukanLpjInput,
  type AksiNonPumk,
  type BarisMonitoringLpj,
  type BuatProposalNonPumkInput,
  type DefinisiTransisiNonPumk,
  type EmberUmurLpj,
  type FilterMonitoringLpj,
  type FilterProposalNonPumk,
  type InputPenilaianInput,
  type KeputusanApprovalNonPumkInput,
  type Lpj,
  type NonPumkContext,
  type NonPumkEngine,
  type NonPumkEngineDeps,
  type NonPumkTx,
  type Penilaian,
  type Penyaluran,
  type PenyaluranInput,
  type ProposalNonPumk,
  type ReviewNonPumkInput,
  type RingkasanProposal,
  type SdgInput,
  type SdgProposal,
  type StatusLpj,
  type StatusProposalNonPumk,
  type SumberPengajuanNonPumk,
  type TolakLpjInput,
  type TransisiProposalNonPumk,
  type Uang,
  type VerifikasiLpjInput,
} from "./contract";
import { bersihkanKesalahan, penyebab, tolak, tolakKonfigurasi } from "./kesalahan";
import { sebabYangBolehLolos } from "../../core/sebab-kolaborator";
import {
  createNonPumkRepo,
  type LpjBaris,
  type PenyaluranBaris,
  type ProposalBaris,
} from "./repo";
import { bacaUang, dariMikro, dariSen, keMikro, selisihHari, tanggalValid } from "./uang";
import { canonicalPermission } from "../auth/index";
import { createNomorService } from "../nomor/index";

/**
 * The permission codes this module checks, mirroring `PERMISSION_NONPUMK` in
 * ./contract.ts.
 *
 * WRITTEN AS STRING LITERALS ON PURPOSE, not spread from that constant:
 * ./contract.ts imports this file, so reading one of its runtime bindings at
 * module-evaluation time here throws "Cannot access before initialization".
 * ./kesalahan.ts's message catalogue is written with literal keys for exactly
 * the same reason. The two lists must not drift, and
 * ./nonpumk-otorisasi.test.ts asserts that every one of them is a code some
 * role in the SHIPPED grant matrix actually holds.
 */
const PERMISSION = {
  VIEW: "nonpumk.view",
  CREATE: "nonpumk.create",
  PENILAIAN: "nonpumk.penilaian",
  REVIEW: "nonpumk.review",
  APPROVE: "nonpumk.approve",
  PENYALURAN: "nonpumk.penyaluran",
  LPJ: "nonpumk.lpj",
  LPJ_VERIFIKASI: "nonpumk.lpj.verifikasi",
} as const;

/** Spec 6.4's two Non PUMK events. Event CODES, never accounts (invariant 11). */
const EVENT_PENYALURAN = "PENYALURAN_NON_PUMK";
const EVENT_PENGEMBALIAN = "PENGEMBALIAN_SISA_NON_PUMK";

/** Configuration keys. Group and key, never a value. */
const KONFIG = {
  GRUP: "batasan",
  SKOR_MINIMUM: "skor_penilaian_minimum_lolos_non_pumk",
  NILAI_MIN: "nilai_min_non_pumk",
  NILAI_MAX: "nilai_max_non_pumk",
  BATAS_HARI_LPJ: "batas_hari_lpj_non_pumk",
} as const;

/** Spec 9.2's ageing thresholds. The SPEC's, so they are not configurable. */
const AMBANG: readonly number[] = [30, 60, 90];

const URUTAN_EMBER: readonly EmberUmurLpj[] = [
  "UMUR_0_29",
  "UMUR_30_59",
  "UMUR_60_89",
  "UMUR_90_PLUS",
];

/**
 * Money is out and no accepted LPJ exists. LPJ_DIAJUKAN is absent because the
 * recipient has done their part and the ball is with the verifier; listing it
 * as a late RECIPIENT is a false accusation. SELESAI is finished.
 */
const STATUS_MONITORING: readonly StatusProposalNonPumk[] = [
  "DISALURKAN",
  "MENUNGGU_LPJ",
  "LPJ_DITOLAK",
];

/**
 * `current_step` per status, so the wizard's progress bar is a fact about the
 * row rather than a number the UI guesses. The three refusal states keep the
 * step they died at.
 */
const LANGKAH: Record<StatusProposalNonPumk, number> = {
  DRAFT: 1,
  PENILAIAN: 2,
  REVIEW_CHECKER: 3,
  MENUNGGU_PERSETUJUAN: 4,
  DISETUJUI: 5,
  DISALURKAN: 6,
  MENUNGGU_LPJ: 7,
  LPJ_DIAJUKAN: 8,
  SELESAI: 9,
  TIDAK_DIREKOMENDASIKAN: 3,
  DITOLAK: 4,
  LPJ_DITOLAK: 8,
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function kosong(nilai: string | null | undefined): boolean {
  return nilai === null || nilai === undefined || nilai.trim() === "";
}

/** Blank and whitespace-only notes are the same thing: no note. */
function catatanBersih(nilai: string | null | undefined): string | null {
  return kosong(nilai) ? null : (nilai as string);
}

function proposalDari(b: ProposalBaris): ProposalNonPumk {
  return {
    id: b.id,
    cabangId: b.cabang_id,
    noProposal: b.no_proposal,
    tanggalProposal: b.tanggal_proposal,
    namaPemohon: b.nama_pemohon,
    atasNama: b.atas_nama,
    bidangId: b.bidang_id,
    judulProgram: b.judul_program,
    deskripsiProgram: b.deskripsi_program,
    jumlahDiajukan: b.jumlah_diajukan as Uang,
    jumlahDisetujui: (b.jumlah_disetujui as Uang | null) ?? null,
    penerimaManfaatEstimasi:
      b.penerima_manfaat_estimasi === null ? null : Number(b.penerima_manfaat_estimasi),
    sumberPengajuan: (b.sumber_pengajuan === "PORTAL_ONLINE"
      ? "PORTAL_ONLINE"
      : "INTERNAL") as SumberPengajuanNonPumk,
    status: b.status as StatusProposalNonPumk,
    currentStep: b.current_step,
    createdBy: b.created_by,
  };
}

function penyaluranDari(b: PenyaluranBaris): Penyaluran {
  return {
    id: b.id,
    proposalId: b.proposal_id,
    termin: Number(b.termin),
    tanggalPenyaluran: b.tanggal_penyaluran,
    jumlah: b.jumlah as Uang,
    akunKasId: b.akun_kas_id,
    akunBebanId: b.akun_beban_id,
    noBukti: b.no_bukti,
    keterangan: b.keterangan,
    // The column is nullable only for the instant between the INSERT and the
    // ledger's answer, and both live in one transaction. A row that reached a
    // reader without one would be a disbursement with no journal behind it.
    jurnalId: b.jurnal_id ?? "",
  };
}

function lpjDari(b: LpjBaris): Lpj {
  return {
    id: b.id,
    proposalId: b.proposal_id,
    tanggalLpj: b.tanggal_lpj,
    jumlahRealisasi: b.jumlah_realisasi as Uang,
    jumlahSisaDikembalikan: b.jumlah_sisa_dikembalikan as Uang,
    penerimaManfaatAktual:
      b.penerima_manfaat_aktual === null ? null : Number(b.penerima_manfaat_aktual),
    uraianRealisasi: b.uraian_realisasi,
    status: b.status as StatusLpj,
    verifiedBy: b.verified_by,
    verifiedAt: b.verified_at,
    jurnalIdPengembalian: b.jurnal_id_pengembalian,
  };
}

/** Half-open on the left: exactly 30 days old is UMUR_30_59, not UMUR_0_29. */
function emberUntuk(umurHari: number): EmberUmurLpj {
  if (umurHari < AMBANG[0]) return "UMUR_0_29";
  if (umurHari < AMBANG[1]) return "UMUR_30_59";
  if (umurHari < AMBANG[2]) return "UMUR_60_89";
  return "UMUR_90_PLUS";
}

// ---------------------------------------------------------------------------
// Authorisation (spec 2, scenario 24)
// ---------------------------------------------------------------------------

/**
 * Spec 2: "Sistem harus menolak, bukan hanya menyembunyikan tombol."
 *
 * A code the auth catalogue does not know FAILS CLOSED with its own error
 * rather than falling through to a permission check nobody can satisfy: an
 * unresolvable code is a CONFIGURATION fault, and reporting it as
 * TIDAK_BERWENANG would make it look like a policy decision and hide it
 * forever. That is exactly the state `nonpumk.lpj.verifikasi` was in when this
 * module was written; the distinction is what made the gap visible.
 */
function wajibIzin(ctx: NonPumkContext, kode: string): void {
  const kanonik = canonicalPermission(kode);
  if (!kanonik) throw tolak("IZIN_BELUM_TERDAFTAR", { permission: kode });
  if (!ctx.permissions.includes(kanonik)) throw tolak("TIDAK_BERWENANG", { permission: kanonik });
}

/**
 * Spec 2 rule 3 and scenario 24: a user acts on their own branch or on one
 * explicitly in scope. The branch is ALWAYS the one the ROW reports, never one
 * that arrived in the request, which is what makes "manipulasi ID di URL"
 * useless: a correctly guessed id still resolves to another branch's row.
 */
function wajibScope(ctx: NonPumkContext, cabangId: string): void {
  if (cabangId === ctx.cabangId) return;
  if (ctx.cabangDalamScope?.includes(cabangId)) return;
  throw tolak("CABANG_DILUAR_SCOPE", { cabangId });
}

function cabangTerlihat(ctx: NonPumkContext): string[] {
  return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
}

/**
 * The branch set a LIST query may span.
 *
 * A `cabangId` filter is honoured only when it is already inside the caller's
 * scope; otherwise it is IGNORED and the caller's own branches answer. Not
 * "return nothing": a list that silently empties when someone edits a query
 * parameter is indistinguishable from a list that is simply empty, and a user
 * would reasonably conclude their branch has no data. Scoping is a ceiling on
 * what a filter can reach, not a trapdoor.
 */
function cabangUntukDaftar(ctx: NonPumkContext, cabangId?: string | null): string[] {
  const terlihat = cabangTerlihat(ctx);
  if (cabangId && terlihat.includes(cabangId)) return [cabangId];
  return terlihat;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEngineNonPumk(deps: NonPumkEngineDeps): NonPumkEngine {
  const repo = createNonPumkRepo();
  const nomor = createNomorService({ db: deps.db });
  const sekarang = () => deps.jam?.() ?? new Date();

  // ------------------------------------------------------------------ config

  async function konfig(tx: NonPumkTx, bumnId: string, kunci: string): Promise<string> {
    const nilai = await repo.konfigurasi(tx, bumnId, KONFIG.GRUP, kunci);
    if (nilai === null || nilai.trim() === "") {
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_ADA", KONFIG.GRUP, kunci);
    }
    return nilai.trim();
  }

  /** A money parameter, in sen. */
  async function konfigUang(tx: NonPumkTx, bumnId: string, kunci: string): Promise<bigint> {
    const mentah = await konfig(tx, bumnId, kunci);
    const u = bacaUang(mentah);
    if (u.bentuk === "rusak") {
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_VALID", KONFIG.GRUP, kunci, mentah);
    }
    return u.sen;
  }

  /** A whole-number parameter. A cell that parses to NaN must STOP the operation. */
  async function konfigBulat(tx: NonPumkTx, bumnId: string, kunci: string): Promise<number> {
    const mentah = await konfig(tx, bumnId, kunci);
    if (!/^\d+$/.test(mentah)) {
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_VALID", KONFIG.GRUP, kunci, mentah);
    }
    return Number(mentah);
  }

  /**
   * A plain decimal parameter, scaled to micro units so a threshold written
   * "70" and a score stored "70.000000" compare exactly. Never `Number()`: a
   * threshold that silently became NaN makes every comparison false and
   * quietly DISABLES the check, which is worse than an outage.
   */
  async function konfigDesimal(tx: NonPumkTx, bumnId: string, kunci: string): Promise<bigint> {
    const mentah = await konfig(tx, bumnId, kunci);
    const mikro = keMikro(mentah);
    if (mikro === null) {
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_VALID", KONFIG.GRUP, kunci, mentah);
    }
    return mikro;
  }

  // ------------------------------------------------------- shared validation

  /** Invariant 7 at the door: a two-decimal string, or nothing. */
  function wajibUang(nilai: unknown, medan: string): bigint {
    const u = bacaUang(nilai);
    if (u.bentuk === "rusak") throw tolak("NILAI_BUKAN_DESIMAL", { [medan]: nilai });
    return u.sen;
  }

  /**
   * The same, refusing zero and negatives with NILAI_DILUAR_BATAS rather than
   * NILAI_BUKAN_DESIMAL: "-1000000.00" IS a well-formed amount, it is just not
   * one this programme can grant, and the two rejections send the user to
   * different places.
   */
  function wajibUangPositif(nilai: unknown, medan: string): bigint {
    const sen = wajibUang(nilai, medan);
    if (sen <= 0n) throw tolak("NILAI_DILUAR_BATAS", { [medan]: nilai });
    return sen;
  }

  function wajibTanggal(nilai: unknown, medan: string): string {
    if (!tanggalValid(nilai)) throw tolak("TANGGAL_TIDAK_VALID", { [medan]: nilai });
    return nilai;
  }

  /** Spec 9.2's beneficiary count: mandatory, whole, and allowed to be zero. */
  function wajibPenerimaManfaat(nilai: unknown, medan: string): number {
    if (typeof nilai !== "number" || !Number.isInteger(nilai) || nilai < 0) {
      throw tolak("PENERIMA_MANFAAT_WAJIB", { [medan]: nilai });
    }
    return nilai;
  }

  async function wajibNilaiDalamBatas(
    tx: NonPumkTx,
    bumnId: string,
    sen: bigint,
  ): Promise<void> {
    const min = await konfigUang(tx, bumnId, KONFIG.NILAI_MIN);
    const max = await konfigUang(tx, bumnId, KONFIG.NILAI_MAX);
    // Both boundaries INCLUSIVE: an off-by-one here rejects an application for
    // exactly the ceiling amount, which is a common application.
    if (sen < min || sen > max) {
      throw tolak("NILAI_DILUAR_BATAS", {
        jumlah: dariSen(sen),
        min: dariSen(min),
        max: dariSen(max),
      });
    }
  }

  /**
   * The cash leg an operator picked on the form, validated BEFORE any posting.
   * The account arrives from the form, so the form can send anything.
   */
  async function wajibAkunKas(
    tx: NonPumkTx,
    bumnId: string,
    akunKasId: string | null | undefined,
  ): Promise<string> {
    if (!akunKasId) throw tolak("AKUN_KAS_TIDAK_VALID", { akunKasId: akunKasId ?? null });
    const akun = await repo.akun(tx, akunKasId);
    if (!akun || !akun.aktif || !akun.is_kas || !akun.is_postable || akun.bumn_id !== bumnId) {
      throw tolak("AKUN_KAS_TIDAK_VALID", { akunKasId });
    }
    return akunKasId;
  }

  /**
   * Spec 6.4's per-bidang expense account, likewise from the form.
   *
   * Refusing a non-BEBAN account is not pedantry: debiting a cash account here
   * would produce a perfectly BALANCED journal that moves money between two
   * cash accounts and records no expense at all, which no balance check can
   * catch and which the ledger would carry forever.
   */
  async function wajibAkunBeban(
    tx: NonPumkTx,
    bumnId: string,
    akunBebanId: string | null | undefined,
  ): Promise<string> {
    if (!akunBebanId) throw tolak("AKUN_BEBAN_TIDAK_VALID", { akunBebanId: akunBebanId ?? null });
    const akun = await repo.akun(tx, akunBebanId);
    if (
      !akun ||
      !akun.aktif ||
      !akun.is_postable ||
      akun.is_kas ||
      akun.tipe !== "BEBAN" ||
      akun.bumn_id !== bumnId
    ) {
      throw tolak("AKUN_BEBAN_TIDAK_VALID", { akunBebanId });
    }
    return akunBebanId;
  }

  /**
   * The weighted SDG mapping of spec 9.2, validated as a SET before anything
   * is written.
   *
   * Duplicates are caught here rather than at `nonpumk_proposal_sdg`'s primary
   * key, because a double-clicked chip in a form deserves an ordinary message
   * and not a constraint name; the weight range is ASSUMPTIONS.md A-09's
   * `0 < bobot <= 1`, which the CHECK also holds, and the default is 1 rather
   * than 0 because an unweighted mapping still contributes fully.
   */
  function siapkanSdg(daftar: readonly SdgInput[] | undefined): Array<{ sdgId: string; bobot: string }> {
    if (!Array.isArray(daftar) || daftar.length === 0) throw tolak("SDG_WAJIB", {});
    const terlihat = new Set<string>();
    const hasil: Array<{ sdgId: string; bobot: string }> = [];
    for (const item of daftar) {
      const sdgId = item?.sdgId;
      if (typeof sdgId !== "string" || sdgId.trim() === "") {
        throw tolak("SDG_TIDAK_DITEMUKAN", { sdgId: sdgId ?? null });
      }
      if (terlihat.has(sdgId)) throw tolak("SDG_DUPLIKAT", { sdgId });
      terlihat.add(sdgId);

      const mentah = item.bobot === null || item.bobot === undefined ? "1.000000" : item.bobot;
      const mikro = keMikro(mentah);
      if (mikro === null || mikro <= 0n || mikro > 1_000_000n) {
        throw tolak("BOBOT_SDG_TIDAK_VALID", { sdgId, bobot: mentah });
      }
      hasil.push({ sdgId, bobot: dariMikro(mikro) });
    }
    return hasil;
  }

  // --------------------------------------------------------- state machine

  function periksaTransisi(
    p: ProposalBaris,
    aksi: AksiNonPumk,
    catatan: string | null,
  ): DefinisiTransisiNonPumk {
    const status = p.status as StatusProposalNonPumk;
    if (STATUS_TERMINAL_NON_PUMK.includes(status)) {
      throw tolak("STATUS_TERMINAL", { proposalId: p.id, status });
    }
    const t = transisiNonPumkUntuk(status, aksi);
    if (!t) throw tolak("TRANSISI_TIDAK_VALID", { proposalId: p.id, status, aksi });
    if (t.catatanWajib && catatan === null) {
      throw tolak("CATATAN_WAJIB", { proposalId: p.id, aksi });
    }
    return t;
  }

  /**
   * The timeline instant.
   *
   * `jam()` is the source, because a backdated import must be recordable
   * honestly and a test must not be hostage to the wall clock. But this column
   * is ALSO the timeline's ordering: `nonpumk_proposal_transisi` has no
   * sequence, so two transitions sharing an instant are unorderable and the
   * chain the detail page renders stops being a chain. Under an injected
   * (frozen) clock that is EVERY transition of a proposal, which is precisely
   * the case scenario 9 walks end to end.
   *
   * So a transition that would land at or before its predecessor is nudged
   * PAST it. The first transition of a proposal is exactly `jam()`.
   *
   * THE NUDGE IS A WHOLE SECOND, NOT A MILLISECOND, and that is not cosmetic.
   * A reader that renders the instant as text and sorts on the rendered string
   * compares '...11:00:00+07' against '...11:00:00.001+07' under the database's
   * collation, which does not order punctuation the way ASCII would: the
   * fractional value sorts FIRST. Keeping every nudged instant free of a
   * fractional part means the text and the timestamp orderings agree, so a
   * timeline cannot read backwards in one place and forwards in another.
   */
  async function waktuTransisi(tx: NonPumkTx, proposalId: string): Promise<string> {
    const terakhir = await repo.transisiTerakhir(tx, proposalId);
    let ms = sekarang().getTime();
    if (terakhir) {
      const sebelumnya = Date.parse(terakhir);
      if (!Number.isNaN(sebelumnya) && ms <= sebelumnya) ms = sebelumnya + 1_000;
    }
    return new Date(ms).toISOString();
  }

  async function terapkanTransisi(
    tx: NonPumkTx,
    p: ProposalBaris,
    t: DefinisiTransisiNonPumk,
    ctx: NonPumkContext,
    catatan: string | null,
  ): Promise<ProposalBaris> {
    await repo.setStatusProposal(tx, {
      id: p.id,
      status: t.ke,
      currentStep: LANGKAH[t.ke],
      userId: ctx.userId,
    });
    await repo.catatTransisi(tx, {
      proposalId: p.id,
      dari: t.dari,
      ke: t.ke,
      aksi: t.aksi,
      userId: ctx.userId,
      waktu: await waktuTransisi(tx, p.id),
      catatan,
    });
    return { ...p, status: t.ke, current_step: LANGKAH[t.ke] };
  }

  /** Loads the proposal for a write, with the branch check the ROW decides. */
  async function proposalUntukTransisi(
    tx: NonPumkTx,
    id: string,
    ctx: NonPumkContext,
  ): Promise<ProposalBaris> {
    const p = await repo.proposalUntukDiubah(tx, id);
    if (!p) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId: id });
    wajibScope(ctx, p.cabang_id);
    return p;
  }

  /** The same, for a read. No lock, same scope rule. */
  async function proposalUntukBaca(
    tx: NonPumkTx,
    id: string,
    ctx: NonPumkContext,
  ): Promise<ProposalBaris> {
    const p = await repo.proposal(tx, id);
    if (!p) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId: id });
    wajibScope(ctx, p.cabang_id);
    return p;
  }

  // ------------------------------------------------- collaborator failures

  /**
   * The ledger engine's refusal, at the boundary where it becomes an answer to
   * the person who asked.
   *
   * A refusal that is SAFE to re-raise is re-raised UNCHANGED; the rest becomes
   * this module's `JURNAL_GAGAL` with the raw cause confined to `penyebabDb`.
   * core/sebab-kolaborator.ts owns which is which and states the three rules,
   * and the defect it closes was found on `POST /pumk/angsuran`: a disbursement
   * dated into a CLOSED period is refused for a reason the operator can act on
   * (`PERIODE_TIDAK_OPEN`, "ask head office to reopen the month"), and
   * flattening it left them retyping a form that will refuse identically. A
   * branch-scope refusal and a malformed-journal refusal still do not travel:
   * the first would rebuild the enumeration oracle one module up, the second
   * would blame an operator for arithmetic this module did.
   */
  async function lewatJurnal<T>(
    jalankan: () => Promise<T>,
    detail: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await jalankan();
    } catch (err) {
      const lolos = sebabYangBolehLolos(err);
      if (lolos) throw lolos;
      throw tolak("JURNAL_GAGAL", detail, penyebab(err));
    }
  }

  /**
   * Allocates a document number inside the CALLER's transaction, so a rolled
   * back proposal does not burn a number and leave a gap an auditor will ask
   * about (spec 4.10). The branch code goes into the template, which is what
   * keeps two branches' series apart in one global uniqueness index.
   */
  async function nomorProposal(
    tx: NonPumkTx,
    input: { bumnId: string; cabangId: string; tanggal: string; userId: string },
  ): Promise<string> {
    const cabang = await repo.cabang(tx, input.cabangId);
    const [tahun, bulan] = input.tanggal.split("-").map((x) => Number.parseInt(x, 10));
    const hasil = await nomor.generate(
      {
        bumnId: input.bumnId,
        cabangId: input.cabangId,
        jenisDokumen: "PROPOSAL_NON_PUMK",
        tahun,
        bulan,
        kodeCabang: cabang?.kode ?? "",
        userId: input.userId,
      },
      { tx },
    );
    return hasil.nomor;
  }

  // ---------------------------------------------------------------- engine

  return {
    async buatProposal(input: BuatProposalNonPumkInput, ctx): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.CREATE);
      // The branch arrives in the PAYLOAD here, because there is no row yet to
      // read it from. That is the one place a request may name a branch, and it
      // is checked against the caller's scope on the way in.
      wajibScope(ctx, input.cabangId);
      const tanggal = wajibTanggal(input.tanggalProposal, "tanggalProposal");
      const tanggalDaftar = input.tanggalDaftar
        ? wajibTanggal(input.tanggalDaftar, "tanggalDaftar")
        : tanggal;
      const jumlahSen = wajibUang(input.jumlahDiajukan, "jumlahDiajukan");
      const penerima = wajibPenerimaManfaat(
        input.penerimaManfaatEstimasi,
        "penerimaManfaatEstimasi",
      );
      const sdg = siapkanSdg(input.sdg);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          if (!(await repo.bidangAda(tx, ctx.bumnId, input.bidangId))) {
            throw tolak("BIDANG_TIDAK_DITEMUKAN", { bidangId: input.bidangId });
          }
          const ada = new Set(await repo.sdgYangAda(tx, sdg.map((s) => s.sdgId)));
          for (const s of sdg) {
            if (!ada.has(s.sdgId)) throw tolak("SDG_TIDAK_DITEMUKAN", { sdgId: s.sdgId });
          }
          // Zero and negative are refused by the bounds below whenever the
          // configured minimum is positive, but the explicit check keeps the
          // guarantee independent of the parameter: a minimum of zero must not
          // make a grant of nothing bookable.
          if (jumlahSen <= 0n) {
            throw tolak("NILAI_DILUAR_BATAS", { jumlahDiajukan: input.jumlahDiajukan });
          }
          await wajibNilaiDalamBatas(tx, ctx.bumnId, jumlahSen);

          const noProposal = await nomorProposal(tx, {
            bumnId: ctx.bumnId,
            cabangId: input.cabangId,
            tanggal,
            userId: ctx.userId,
          });

          const id = await repo.buatProposal(tx, {
            cabangId: input.cabangId,
            noProposal,
            tanggalProposal: tanggal,
            tanggalDaftar,
            namaPemohon: input.namaPemohon,
            atasNama: input.atasNama ?? null,
            alamat: input.alamat ?? null,
            kelurahan: input.kelurahan ?? null,
            kecamatan: input.kecamatan ?? null,
            kotaId: input.kotaId ?? null,
            telepon: input.telepon ?? null,
            email: input.email ?? null,
            bidangId: input.bidangId,
            judulProgram: input.judulProgram,
            deskripsiProgram: input.deskripsiProgram ?? null,
            jumlahDiajukan: dariSen(jumlahSen),
            penerimaManfaatEstimasi: penerima,
            sumberPengajuan: input.sumberPengajuan ?? "INTERNAL",
            portalSubmissionId: input.portalSubmissionId ?? null,
            currentStep: LANGKAH.DRAFT,
            userId: ctx.userId,
          });
          // All or nothing: the proposal and its mappings commit together, so a
          // bad SDG in position two never leaves a proposal carrying only
          // position one, and a proposal invisible to the SDG report of spec
          // 10.2 is never created at all.
          for (const s of sdg) {
            await repo.tambahSdg(tx, {
              proposalId: id,
              sdgId: s.sdgId,
              bobot: s.bobot,
              userId: ctx.userId,
            });
          }

          const baris = await repo.proposal(tx, id);
          if (!baris) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId: id });
          return proposalDari(baris);
        }),
      );
    },

    async ajukanPenilaian(proposalId, catatan, ctx): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.CREATE);
      const nota = catatanBersih(catatan);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, proposalId, ctx);
          const t = periksaTransisi(p, "AJUKAN_PENILAIAN", nota);
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async inputPenilaian(input: InputPenilaianInput, ctx): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.PENILAIAN);
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      const skor = keMikro(input.skorTotal ?? "");
      if (skor === null || skor < 0n) throw tolak("NILAI_BUKAN_DESIMAL", { skorTotal: input.skorTotal });
      const nilaiSen = wajibUang(input.nilaiRekomendasi, "nilaiRekomendasi");
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, "INPUT_PENILAIAN", nota);
          // ONE assessment row per proposal, so a proposal sent back by
          // MINTA_PERBAIKAN and reassessed UPDATES it. The history of the loop
          // lives on the timeline, which is where an auditor looks for it.
          await repo.simpanPenilaian(tx, {
            proposalId: p.id,
            tanggal,
            petugasKaryawanId: input.petugasKaryawanId ?? null,
            hasilJson: JSON.stringify(input.hasil ?? {}),
            skorTotal: dariMikro(skor),
            nilaiRekomendasi: dariSen(nilaiSen),
            catatan: nota,
            lampiranJson: JSON.stringify(input.lampiran ?? []),
            userId: ctx.userId,
          });
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async review(input: ReviewNonPumkInput, ctx): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.REVIEW);
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, input.keputusan as AksiNonPumk, nota);

          // Spec 2 rule 1, AHEAD of trg_nonpumk_review_10_sod: the trigger's
          // TJSL-SOD-001 names a user id and a plpgsql function, which is not
          // something a branch officer should ever be shown. Per DOCUMENT, not
          // per role: ADMIN_CABANG legitimately holds create AND review.
          if (p.created_by && p.created_by === ctx.userId) {
            throw tolak("KONFLIK_MAKER_CHECKER", { proposalId: p.id });
          }

          if (input.keputusan === "REKOMENDASI") {
            const penilaian = await repo.penilaian(tx, p.id);
            if (!penilaian || penilaian.skor_total === null) {
              throw tolak("PENILAIAN_BELUM_ADA", { proposalId: p.id });
            }
            const skor = keMikro(penilaian.skor_total);
            if (skor === null) {
              throw tolakKonfigurasi(
                "KONFIGURASI_TIDAK_VALID",
                KONFIG.GRUP,
                KONFIG.SKOR_MINIMUM,
                penilaian.skor_total,
              );
            }
            const minimum = await konfigDesimal(tx, ctx.bumnId, KONFIG.SKOR_MINIMUM);
            if (skor < minimum) {
              throw tolak("SKOR_DIBAWAH_MINIMUM", {
                proposalId: p.id,
                skor: penilaian.skor_total,
              });
            }
          }

          await repo.buatReview(tx, {
            proposalId: p.id,
            reviewerUserId: ctx.userId,
            tanggal,
            keputusan: input.keputusan,
            catatan: nota,
          });
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async putuskanPersetujuan(
      input: KeputusanApprovalNonPumkInput,
      ctx,
    ): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.APPROVE);
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, input.keputusan as AksiNonPumk, nota);

          let disetujui: string | null = null;
          if (input.keputusan === "SETUJU") {
            // nonpumk_approval_setuju_ck would catch an empty amount with a raw
            // Postgres string, and TJSL-NPK-001 would then refuse every later
            // termin with a message about a proposal uuid. Without the amount
            // there is no disbursement ceiling at all.
            if (input.jumlahDisetujui === null || input.jumlahDisetujui === undefined) {
              throw tolak("NILAI_DISETUJUI_WAJIB", { proposalId: p.id });
            }
            const sen = wajibUangPositif(input.jumlahDisetujui, "jumlahDisetujui");
            const diajukan = bacaUang(p.jumlah_diajukan);
            // The approver may CUT ("ini sering terjadi di praktik"), never
            // raise: granting more than was asked for is not a decision on this
            // proposal, it is a different proposal, and it would exceed what
            // the applicant documented and the checker reviewed.
            if (diajukan.bentuk === "ok" && sen > diajukan.sen) {
              throw tolak("NILAI_DISETUJUI_MELEBIHI_PENGAJUAN", {
                proposalId: p.id,
                jumlahDiajukan: p.jumlah_diajukan,
                jumlahDisetujui: dariSen(sen),
              });
            }
            disetujui = dariSen(sen);
          }

          // Spec 2 rule 2, AHEAD of trg_nonpumk_approval_10_sod. Per DOCUMENT,
          // not per role: the conflict only exists on a file this user already
          // reviewed.
          if (await repo.sudahMereview(tx, p.id, ctx.userId)) {
            throw tolak("KONFLIK_CHECKER_APPROVER", { proposalId: p.id });
          }

          await repo.buatApproval(tx, {
            proposalId: p.id,
            approverUserId: ctx.userId,
            tanggal,
            keputusan: input.keputusan,
            jumlahDisetujui: disetujui,
            catatan: nota,
          });
          if (disetujui !== null) {
            // ASSUMPTIONS.md A-15: denormalised onto the proposal, because that
            // column is the single ceiling the staged-disbursement guard and the
            // deferred TJSL-NPK-002 both read. A cut that is recorded in
            // nonpumk_approval and then ignored is worse than no cut at all.
            await repo.setJumlahDisetujui(tx, {
              id: p.id,
              jumlahDisetujui: disetujui,
              userId: ctx.userId,
            });
          }

          const sesudah = await terapkanTransisi(tx, p, t, ctx, nota);
          const baris = await repo.proposal(tx, sesudah.id);
          return proposalDari(baris ?? sesudah);
        }),
      );
    },

    async timeline(proposalId, ctx): Promise<TransisiProposalNonPumk[]> {
      wajibIzin(ctx, PERMISSION.VIEW);
      return bersihkanKesalahan(async () => {
        const p = await proposalUntukBaca(deps.db, proposalId, ctx);
        const baris = await repo.timeline(deps.db, p.id);
        return baris.map((b) => ({
          statusDari: (b.status_dari as StatusProposalNonPumk | null) ?? null,
          statusKe: b.status_ke as StatusProposalNonPumk,
          aksi: b.aksi as AksiNonPumk,
          olehUserId: b.oleh_user_id,
          waktu: b.waktu,
          catatan: b.catatan,
        }));
      });
    },

    async daftarProposal(filter: FilterProposalNonPumk, ctx): Promise<ProposalNonPumk[]> {
      wajibIzin(ctx, PERMISSION.VIEW);
      return bersihkanKesalahan(async () => {
        const baris = await repo.daftarProposal(deps.db, {
          cabangIds: cabangUntukDaftar(ctx, filter.cabangId),
          bidangId: filter.bidangId ?? null,
          sdgId: filter.sdgId ?? null,
          status: filter.status ?? null,
          sumberPengajuan: filter.sumberPengajuan ?? null,
          dariTanggal: filter.dariTanggal ?? null,
          sampaiTanggal: filter.sampaiTanggal ?? null,
          cari: filter.cari ?? null,
        });
        return baris.map(proposalDari);
      });
    },

    // --- penyaluran bertahap (spec 9.2) -------------------------------------

    async catatPenyaluran(input: PenyaluranInput, ctx): Promise<Penyaluran> {
      wajibIzin(ctx, PERMISSION.PENYALURAN);
      const tanggal = wajibTanggal(input.tanggalPenyaluran, "tanggalPenyaluran");
      const jumlahSen = wajibUangPositif(input.jumlah, "jumlah");

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          // The state machine gets there before TJSL-NPK-001, whose message
          // names a proposal uuid, and says something a human can act on.
          const t = periksaTransisi(p, "PENYALURAN", null);

          const akunBebanId = await wajibAkunBeban(tx, ctx.bumnId, input.akunBebanId);
          const akunKasId = await wajibAkunKas(tx, ctx.bumnId, input.akunKasId);

          if (p.jumlah_disetujui === null) {
            throw tolak("BELUM_DISETUJUI", { proposalId: p.id });
          }
          const pagu = bacaUang(p.jumlah_disetujui);
          if (pagu.bentuk === "rusak") {
            throw tolak("BELUM_DISETUJUI", { proposalId: p.id });
          }
          const sudah = bacaUang(await repo.totalPenyaluran(tx, p.id));
          const total = (sudah.bentuk === "ok" ? sudah.sen : 0n) + jumlahSen;
          // `>` and not `>=`: the termin that lands EXACTLY on the ceiling is
          // the final instalment of every fully disbursed grant. Refused AHEAD
          // of the DEFERRED TJSL-NPK-002 and BEFORE the ledger is called, so a
          // refusal never leaves a real posting for the rollback to undo.
          if (total > pagu.sen) {
            throw tolak("PLAFON_PENYALURAN_TERLAMPAUI", {
              proposalId: p.id,
              jumlah: dariSen(jumlahSen),
              sudahDisalurkan: dariSen(sudah.bentuk === "ok" ? sudah.sen : 0n),
              jumlahDisetujui: dariSen(pagu.sen),
            });
          }

          const termin = await repo.terminBerikutnya(tx, p.id);
          const penyaluranId = await repo.buatPenyaluran(tx, {
            proposalId: p.id,
            termin,
            tanggalPenyaluran: tanggal,
            jumlah: dariSen(jumlahSen),
            akunKasId,
            akunBebanId,
            noBukti: input.noBukti ?? null,
            keterangan: input.keterangan ?? null,
            userId: ctx.userId,
          });

          // ONE EVENT PER BUSINESS ACT. `postingEvent` owns its own
          // transaction, so posting after this module's INSERT and before its
          // status change means no row lock is held across another engine's
          // transaction for longer than the call. A refusal here aborts
          // everything above with it, which is the whole reason
          // `NonPumkDbPort.transaction` is not optional.
          const jurnal = await lewatJurnal(
            () =>
              deps.jurnal.postingEvent(
                EVENT_PENYALURAN,
                {
                  cabangId: p.cabang_id,
                  tanggalTransaksi: tanggal,
                  nilai: dariSen(jumlahSen),
                  keterangan:
                    input.keterangan ??
                    `Penyaluran Non PUMK ${p.no_proposal} termin ${termin}`,
                  // Spec 6.4's per-bidang expense account. Passed because the
                  // shipped mapping row asks for it (`debit_dari_payload`), not
                  // because this module chose an account.
                  akunDebitId: akunBebanId,
                  akunKasId,
                  referensiTipe: "nonpumk_penyaluran",
                  referensiId: penyaluranId,
                  // Spec 4.6's analytic dimension. Without it, "Laporan
                  // Penyaluran per Bidang" has to reconstruct the bidang by
                  // joining back through the business tables, which stops being
                  // possible the moment a proposal's bidang is corrected.
                  dimensi: { bidangId: p.bidang_id },
                  kunciIdempotensi: `nonpumk_penyaluran:${penyaluranId}`,
                },
                ctx,
              ),
            { proposalId: p.id, termin },
          );

          await repo.setJurnalPenyaluran(tx, penyaluranId, jurnal.id, ctx.userId);
          await terapkanTransisi(tx, p, t, ctx, null);

          const baris = await repo.penyaluran(tx, penyaluranId);
          if (!baris) throw tolak("PENYALURAN_TIDAK_DITEMUKAN", { penyaluranId });
          return penyaluranDari(baris);
        }),
      );
    },

    async tutupPenyaluran(proposalId, catatan, ctx): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.PENYALURAN);
      const nota = catatanBersih(catatan);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, proposalId, ctx);
          const t = periksaTransisi(p, "TUTUP_PENYALURAN", nota);
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    // --- LPJ (spec 9.2, spec 4.5, scenario 9) -------------------------------

    async ajukanLpj(input: AjukanLpjInput, ctx): Promise<Lpj> {
      wajibIzin(ctx, PERMISSION.LPJ);
      const tanggal = wajibTanggal(input.tanggalLpj, "tanggalLpj");
      const realisasiSen = wajibUang(input.jumlahRealisasi, "jumlahRealisasi");
      if (realisasiSen < 0n) {
        throw tolak("NILAI_DILUAR_BATAS", { jumlahRealisasi: input.jumlahRealisasi });
      }
      const penerima = wajibPenerimaManfaat(
        input.penerimaManfaatAktual,
        "penerimaManfaatAktual",
      );

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, "AJUKAN_LPJ", null);

          const disalurkan = bacaUang(await repo.totalPenyaluran(tx, p.id));
          const totalSen = disalurkan.bentuk === "ok" ? disalurkan.sen : 0n;
          // A realisation larger than what actually left the account is either a
          // typo or an attempt to account for money from somewhere else; either
          // way it would force the computed remainder negative. Refused AHEAD of
          // the DEFERRED TJSL-NPK-003.
          if (realisasiSen > totalSen) {
            throw tolak("REALISASI_MELEBIHI_PENYALURAN", {
              proposalId: p.id,
              jumlahRealisasi: dariSen(realisasiSen),
              totalDisalurkan: dariSen(totalSen),
            });
          }
          // COMPUTED, never taken from the caller: the two numbers cannot
          // disagree, so the deferred trigger has nothing left to catch. A
          // constraint that never fires is a constraint that never reaches a
          // user as a plpgsql string.
          const sisaSen = totalSen - realisasiSen;

          await repo.simpanLpj(tx, {
            proposalId: p.id,
            tanggalLpj: tanggal,
            jumlahRealisasi: dariSen(realisasiSen),
            jumlahSisaDikembalikan: dariSen(sisaSen),
            penerimaManfaatAktual: penerima,
            uraianRealisasi: input.uraianRealisasi ?? null,
            lampiranJson: JSON.stringify(input.lampiran ?? []),
            userId: ctx.userId,
          });
          // POSTS NO JOURNAL. The money comes back when the LPJ is ACCEPTED,
          // not when it is filed: an LPJ that can still be rejected must not
          // have moved the ledger, or every rejection needs a reversal and spec
          // 6.3's correction path gets exercised for a routine back-and-forth.
          await terapkanTransisi(tx, p, t, ctx, null);

          const baris = await repo.lpj(tx, p.id);
          if (!baris) throw tolak("LPJ_TIDAK_DITEMUKAN", { proposalId: p.id });
          return lpjDari(baris);
        }),
      );
    },

    async verifikasiLpj(input: VerifikasiLpjInput, ctx): Promise<Lpj> {
      wajibIzin(ctx, PERMISSION.LPJ_VERIFIKASI);
      const tanggal = wajibTanggal(input.tanggalVerifikasi, "tanggalVerifikasi");
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, "VERIFIKASI_LPJ", nota);

          const lpj = await repo.lpj(tx, p.id);
          if (!lpj) throw tolak("LPJ_TIDAK_DITEMUKAN", { proposalId: p.id });
          const sisa = bacaUang(lpj.jumlah_sisa_dikembalikan);
          const sisaSen = sisa.bentuk === "ok" ? sisa.sen : 0n;

          // The cash leg of the return is a real bank credit, and which account
          // it landed in is not something this module may guess. Validated
          // BEFORE anything is written, so a missing account leaves the LPJ
          // exactly as it was.
          const akunKasId = sisaSen > 0n ? await wajibAkunKas(tx, ctx.bumnId, input.akunKasId) : null;

          await repo.setLpjDiverifikasi(tx, {
            id: lpj.id,
            verifiedBy: ctx.userId,
            verifiedAt: sekarang().toISOString(),
          });

          if (sisaSen > 0n && akunKasId) {
            // THE CREDIT LEG IS THE ACCOUNT THE DISBURSEMENT DEBITED.
            //
            // Spec 6.4 makes the disbursement's expense account per bidang, so
            // the refund's must be too: crediting a single pooled account
            // instead would leave the bidang's expense overstated by the refund
            // and the pooled account drifting negative by the same amount,
            // while both journals balance and every balance check passes. A
            // refund is the reversal of a SPECIFIC disbursement, so it reverses
            // that disbursement's leg. Which account that is comes from the
            // termin row, never from a literal here (invariant 11): the mapping
            // decides whether this value is honoured.
            const akunBebanId = await repo.akunBebanTerakhir(tx, p.id);
            if (!akunBebanId) throw tolak("AKUN_BEBAN_TIDAK_VALID", { proposalId: p.id });

            const jurnal = await lewatJurnal(
              () =>
                deps.jurnal.postingEvent(
                  EVENT_PENGEMBALIAN,
                  {
                    cabangId: p.cabang_id,
                    tanggalTransaksi: tanggal,
                    nilai: dariSen(sisaSen),
                    keterangan: `Pengembalian sisa dana Non PUMK ${p.no_proposal}`,
                    akunKreditId: akunBebanId,
                    akunKasId,
                    referensiTipe: "nonpumk_lpj",
                    referensiId: lpj.id,
                    // The bidang travels with the return too, or the per-bidang
                    // expense report nets the disbursement against nothing.
                    dimensi: { bidangId: p.bidang_id },
                    kunciIdempotensi: `nonpumk_lpj:${lpj.id}`,
                  },
                  ctx,
                ),
              { proposalId: p.id, lpjId: lpj.id },
            );
            await repo.setJurnalPengembalian(tx, lpj.id, jurnal.id, ctx.userId);
          }
          // With sisa = 0 there is nothing to post and no journal is created: a
          // balanced pair of zero lines would be refused by validation 6.2.3
          // anyway, and an empty journal in the buku besar is noise an auditor
          // has to explain.

          await terapkanTransisi(tx, p, t, ctx, nota);

          const baris = await repo.lpj(tx, p.id);
          if (!baris) throw tolak("LPJ_TIDAK_DITEMUKAN", { proposalId: p.id });
          return lpjDari(baris);
        }),
      );
    },

    async tolakLpj(input: TolakLpjInput, ctx): Promise<ProposalNonPumk> {
      wajibIzin(ctx, PERMISSION.LPJ_VERIFIKASI);
      const nota = catatanBersih(input.catatan);
      wajibTanggal(input.tanggal, "tanggal");

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          // The note is the entire content of a rejection: without it the
          // recipient has nothing to correct.
          const t = periksaTransisi(p, "TOLAK_LPJ", nota);

          const lpj = await repo.lpj(tx, p.id);
          if (!lpj) throw tolak("LPJ_TIDAK_DITEMUKAN", { proposalId: p.id });
          await repo.setLpjDitolak(tx, { id: lpj.id, userId: ctx.userId });
          // A rejection moves no money, so the remainder stays where it is and
          // the expense stays at the full disbursement.
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    // --- read models --------------------------------------------------------

    async ringkasan(proposalId, ctx): Promise<RingkasanProposal> {
      wajibIzin(ctx, PERMISSION.VIEW);
      return bersihkanKesalahan(async () => {
        const db = deps.db;
        const p = await proposalUntukBaca(db, proposalId, ctx);

        const [sdgBaris, penilaianBaris, penyaluranBaris, lpjBaris, efek] = await Promise.all([
          repo.sdgProposal(db, p.id),
          repo.penilaian(db, p.id),
          repo.daftarPenyaluran(db, p.id),
          repo.lpj(db, p.id),
          repo.efekBukuBesar(db, p.id),
        ]);

        let totalSen = 0n;
        for (const s of penyaluranBaris) {
          const u = bacaUang(s.jumlah);
          if (u.bentuk === "ok") totalSen += u.sen;
        }
        const pagu = p.jumlah_disetujui === null ? null : bacaUang(p.jumlah_disetujui);
        const paguSen = pagu && pagu.bentuk === "ok" ? pagu.sen : 0n;
        // Never negative: the engine refuses the offending termin first, so a
        // negative headroom here would mean a write got past the guard and the
        // page should not paper over it with a minus sign.
        const sisaSen = paguSen > totalSen ? paguSen - totalSen : 0n;

        const sdg: SdgProposal[] = sdgBaris.map((s) => ({
          sdgId: s.sdg_id,
          nomor: Number(s.nomor),
          nama: s.nama,
          bobot: s.bobot,
        }));
        const penilaian: Penilaian | null = penilaianBaris
          ? {
              id: penilaianBaris.id,
              proposalId: penilaianBaris.proposal_id,
              tanggal: penilaianBaris.tanggal,
              petugasKaryawanId: penilaianBaris.petugas_karyawan_id,
              skorTotal: penilaianBaris.skor_total,
              nilaiRekomendasi: (penilaianBaris.nilai_rekomendasi as Uang | null) ?? null,
              catatan: penilaianBaris.catatan,
            }
          : null;

        return {
          proposal: proposalDari(p),
          sdg,
          penilaian,
          penyaluran: penyaluranBaris.map(penyaluranDari),
          totalDisalurkan: dariSen(totalSen),
          sisaPagu: dariSen(sisaSen),
          lpj: lpjBaris ? lpjDari(lpjBaris) : null,
          // Read from the POSTED ledger, not recomputed from the business rows,
          // so the page itself proves the two agree instead of asserting it
          // elsewhere.
          bebanBersihBukuBesar: efek.beban as Uang,
          kasBersihBukuBesar: efek.kas as Uang,
        };
      });
    },

    async monitoringLpj(filter: FilterMonitoringLpj, ctx): Promise<BarisMonitoringLpj[]> {
      wajibIzin(ctx, PERMISSION.VIEW);
      return bersihkanKesalahan(async () => {
        const db = deps.db;
        // Read FIRST, and fail closed. A page that silently defaulted to some
        // number would report every grant as on time, or every grant as late,
        // and either way would look like a working page.
        const batasHari = await konfigBulat(db, ctx.bumnId, KONFIG.BATAS_HARI_LPJ);
        const hariIni = sekarang().toISOString().slice(0, 10);

        const baris = await repo.monitoring(db, {
          cabangIds: cabangUntukDaftar(ctx, filter.cabangId),
          bidangId: filter.bidangId ?? null,
          status: STATUS_MONITORING,
        });

        const minimal = filter.emberMinimal
          ? URUTAN_EMBER.indexOf(filter.emberMinimal)
          : 0;

        const hasil: BarisMonitoringLpj[] = [];
        for (const b of baris) {
          const umurHari = selisihHari(b.tanggal_penyaluran_terakhir, hariIni);
          const ember = emberUntuk(umurHari);
          // "Due within N days" means day N is still INSIDE the deadline. Off by
          // one here turns every on-time grant on its last day into a breach in
          // the report that goes to management.
          const terlambat = umurHari > batasHari;
          if (minimal > 0 && URUTAN_EMBER.indexOf(ember) < minimal) continue;
          if (filter.hanyaTerlambat && !terlambat) continue;
          hasil.push({
            proposalId: b.proposal_id,
            noProposal: b.no_proposal,
            cabangId: b.cabang_id,
            bidangId: b.bidang_id,
            namaPemohon: b.nama_pemohon,
            judulProgram: b.judul_program,
            status: b.status as StatusProposalNonPumk,
            totalDisalurkan: b.total_disalurkan as Uang,
            tanggalPenyaluranTerakhir: b.tanggal_penyaluran_terakhir,
            umurHari,
            ember,
            terlambat,
          });
        }
        // Oldest first, because that is what has to be handled first. The repo
        // already orders by the last termin's date ascending, which is the same
        // ordering; sorting again here keeps the contract true even if the
        // query's ordering is ever relaxed.
        hasil.sort((a, b) => b.umurHari - a.umurHari);
        return hasil;
      });
    },
  };
}
