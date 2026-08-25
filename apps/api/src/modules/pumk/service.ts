// The PUMK business layer (spec 9.1). The single implementation site behind
// `createPumkEngine` in ./contract.ts.
//
// WHAT THIS FILE OWNS
//   - the proposal state machine of spec 9.1, as a walk over TRANSISI_SAH,
//     with the timeline row ("siapa, kapan, catatan apa") written on EVERY
//     transition and on no refusal;
//   - the authorisation rules of spec 2: the permission, the BRANCH THE ROW
//     REPORTS (never one supplied by the request), and the two segregation
//     rules produced as clean domain errors AHEAD of TJSL-SOD-001/002;
//   - the akad, built from the APPROVAL row so an approver's change of plafon
//     or tenor flows through instead of being recorded and ignored;
//   - the disbursement, whose sub-ledger and ledger effects commit together;
//   - the read models (timeline, kartu piutang, cluster roster) and the portal
//     conversion.
//
// WHAT THIS FILE DELIBERATELY DOES NOT OWN
//   - NO SCHEDULE ARITHMETIC. Every schedule, allocation and reschedule goes
//     through `deps.angsuran` (invariants 8, 9, 10). There is no other route
//     to a `pumk_jadwal_angsuran` row from here.
//   - NO LEDGER SQL AND NO ACCOUNT PAIR. Every journal goes through
//     `deps.jurnal.postingEvent` with an EVENT CODE; the accounts come from
//     `event_jurnal_mapping` (invariant 11, ADR 0004). migrations/0020's
//     posting-path tripwire and tools/check-boundaries.ts both refuse any
//     other route.
//   - NO POLICY NUMBER. Every plafon, tenor, grace, jaminan threshold, score
//     minimum, active-loan limit, default rate and default method is read from
//     `konfigurasi` on the call that needs it. docs/REGULASI.md finding 3 puts
//     those values with the client's accounting team, so a literal here would
//     be this repo deciding them.
//
// TRANSACTION DISCIPLINE
// Every state-machine step runs inside exactly one `db.transaction`, because a
// status change without its timeline row is an audit trail with a hole in it,
// and a disbursement that wrote the akad but not the journal is precisely the
// drift `v_rekonsiliasi_piutang` exists to detect. The collaborating engines
// own their own transactions (they are reached as ports, not as SQL), so the
// order inside `catatPencairan` and `catatPengakhiran` is: post the ledger
// effect FIRST, then move this module's rows. A collaborator that refuses
// therefore takes the whole step down with it, and this module never holds a
// row lock across a call into another engine's transaction.
import {
  STATUS_TERMINAL,
  transisiUntuk,
  type AksiProposal,
  type Akad,
  type AnggotaCluster,
  type BuatAkadInput,
  type BuatProposalInput,
  type DefinisiTransisi,
  type FilterProposal,
  type HasilPencairan,
  type InputSurveyInput,
  type JaminanInput,
  type KartuPiutang,
  type KeputusanApprovalInput,
  type KonversiPortalInput,
  type MetodePerhitungan,
  type PencairanInput,
  type Pengakhiran,
  type PengakhiranInput,
  type Proposal,
  type PumkContext,
  type PumkEngine,
  type PumkEngineDeps,
  type PumkTx,
  type RateTahunan,
  type ReviewInput,
  type StatusAkad,
  type StatusProposal,
  type TerimaAngsuranInput,
  type TindakLanjut,
  type TindakLanjutInput,
  type TransisiProposal,
  type Uang,
} from "./contract";
import { bersihkanKesalahan, penyebab, tolak } from "./kesalahan";
import { createPumkRepo, type AkadBaris, type ProposalBaris } from "./repo";
import { bacaRate, bacaUang, dariSen, tambahBulan, tanggalValid } from "./uang";
import { canonicalPermission } from "../auth/index";
import { createNomorService } from "../nomor/index";
import type { HasilAlokasi, HasilReschedule, JenisReschedule, Reschedule } from "../angsuran/index";

/**
 * The permission codes this module checks, mirroring `PERMISSION_PUMK` in
 * ./contract.ts.
 *
 * WRITTEN AS STRING LITERALS ON PURPOSE, not spread from that constant:
 * ./contract.ts imports this file, so reading one of its runtime bindings at
 * module-evaluation time here throws "Cannot access before initialization".
 * ./kesalahan.ts's message catalogue is written with literal keys for exactly
 * the same reason. The two lists must not drift; ./pumk-otorisasi.test.ts
 * asserts that every one of them (bar the documented `pumk.cluster` case) is a
 * code some role in the shipped grant matrix actually holds.
 */
const PERMISSION = {
  LIHAT: "pumk.view",
  BUAT: "pumk.create",
  SURVEY: "pumk.survey",
  REVIEW: "pumk.review",
  SETUJUI: "pumk.approve",
  AKAD: "pumk.akad",
  PENCAIRAN: "pumk.pencairan",
  ANGSURAN: "pumk.angsuran",
  RESCHEDULE: "pumk.reschedule",
  HAPUSBUKU: "pumk.hapusbuku",
  PENAGIHAN: "pumk.penagihan",
  CLUSTER: "pumk.cluster",
  KONVERSI_PORTAL: "portal.konversi",
} as const;

/** Spec 6.4's write-off pair. Event CODES, never accounts (invariant 11). */
const EVENT_HAPUS_BUKU = "HAPUS_BUKU_PIUTANG";
const EVENT_HAPUS_BUKU_KEKURANGAN = "HAPUS_BUKU_KEKURANGAN_PENYISIHAN";
const EVENT_PENCAIRAN = "PENCAIRAN_PUMK";

/** Statuses that still count as a live receivable (pumk_akad_outstanding_idx). */
const STATUS_PIUTANG_AKTIF = new Set<string>(["AKTIF", "RESCHEDULED", "MACET"]);

const METODE_DIKENAL = new Set<string>(["FLAT", "EFEKTIF", "ANUITAS"]);

/**
 * `current_step` per status, so the wizard's progress bar is a fact about the
 * row rather than a number the UI guesses. TIDAK_DIREKOMENDASIKAN and DITOLAK
 * keep the step they died at.
 */
const LANGKAH: Record<StatusProposal, number> = {
  DRAFT: 1,
  SURVEY_PENDING: 2,
  SURVEY_SELESAI: 3,
  REVIEW_CHECKER: 4,
  MENUNGGU_PERSETUJUAN: 5,
  DISETUJUI: 6,
  AKAD_DIBUAT: 7,
  JADWAL_SIAP: 8,
  DICAIRKAN: 9,
  TIDAK_DIREKOMENDASIKAN: 4,
  DITOLAK: 5,
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

function proposalDari(b: ProposalBaris): Proposal {
  return {
    id: b.id,
    cabangId: b.cabang_id,
    noProposal: b.no_proposal,
    tanggalProposal: b.tanggal_proposal,
    mitraId: b.mitra_id,
    sektorId: b.sektor_id,
    jumlahDiajukan: b.jumlah_diajukan as Uang,
    tenorDiajukan: b.tenor_diajukan,
    tujuanPenggunaan: b.tujuan_penggunaan,
    sumberPengajuan: b.sumber_pengajuan === "PORTAL_ONLINE" ? "PORTAL_ONLINE" : "INTERNAL",
    portalSubmissionId: b.portal_submission_id,
    status: b.status as StatusProposal,
    currentStep: b.current_step,
    createdBy: b.created_by,
  };
}

function akadDari(b: AkadBaris): Akad {
  return {
    id: b.id,
    proposalId: b.proposal_id,
    mitraId: b.mitra_id,
    cabangId: b.cabang_id,
    noAkad: b.no_akad,
    tanggalAkad: b.tanggal_akad,
    pokokPinjaman: b.pokok_pinjaman as Uang,
    jasaAdmRate: b.jasa_adm_rate as RateTahunan,
    metodePerhitungan: b.metode_perhitungan as MetodePerhitungan,
    tenorBulan: b.tenor_bulan,
    gracePeriodBulan: b.grace_period_bulan,
    tanggalMulaiAngsuran: b.tanggal_mulai_angsuran,
    tanggalJatuhTempoAkhir: b.tanggal_jatuh_tempo_akhir,
    status: b.status as StatusAkad,
    outstandingPokok: b.outstanding_pokok as Uang,
    outstandingJasa: b.outstanding_jasa as Uang,
  };
}

// ---------------------------------------------------------------------------
// Authorisation (spec 2, scenario 24)
// ---------------------------------------------------------------------------

/**
 * Spec 2: "Sistem harus menolak, bukan hanya menyembunyikan tombol."
 *
 * A code the auth catalogue does not know FAILS CLOSED with its own error
 * rather than falling through to a permission check nobody can satisfy: an
 * unresolvable code is a configuration fault, and reporting it as
 * TIDAK_BERWENANG would make it look like a policy decision and hide it
 * forever. See PERMISSION_PUMK's note in ./contract.ts.
 */
function wajibIzin(ctx: PumkContext, kode: string): void {
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
function wajibScope(ctx: PumkContext, cabangId: string): void {
  if (cabangId === ctx.cabangId) return;
  if (ctx.cabangDalamScope?.includes(cabangId)) return;
  throw tolak("CABANG_DILUAR_SCOPE", { cabangId });
}

function cabangTerlihat(ctx: PumkContext): string[] {
  return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEnginePumk(deps: PumkEngineDeps): PumkEngine {
  const repo = createPumkRepo();
  const nomor = createNomorService({ db: deps.db });
  const sekarang = () => deps.jam?.() ?? new Date();

  // ------------------------------------------------------------------ config

  async function konfig(tx: PumkTx, bumnId: string, grup: string, kunci: string): Promise<string> {
    const nilai = await repo.konfigurasi(tx, bumnId, grup, kunci);
    if (nilai === null || nilai.trim() === "") {
      throw tolak("KONFIGURASI_TIDAK_ADA", { kunci: `${grup}.${kunci}` });
    }
    return nilai.trim();
  }

  /** An integer parameter. A cell that parses to NaN must STOP the operation. */
  async function konfigBulat(
    tx: PumkTx,
    bumnId: string,
    grup: string,
    kunci: string,
  ): Promise<number> {
    const mentah = await konfig(tx, bumnId, grup, kunci);
    if (!/^\d+$/.test(mentah)) {
      throw tolak("KONFIGURASI_TIDAK_VALID", { kunci: `${grup}.${kunci}`, nilai: mentah });
    }
    return Number(mentah);
  }

  /** A money parameter, in sen. */
  async function konfigUang(
    tx: PumkTx,
    bumnId: string,
    grup: string,
    kunci: string,
  ): Promise<bigint> {
    const mentah = await konfig(tx, bumnId, grup, kunci);
    const u = bacaUang(mentah);
    if (u.bentuk === "rusak") {
      throw tolak("KONFIGURASI_TIDAK_VALID", { kunci: `${grup}.${kunci}`, nilai: mentah });
    }
    return u.sen;
  }

  /**
   * A plain decimal parameter, scaled to micro units so a threshold written
   * "70" and a score stored "70.000000" compare exactly. Never `Number()`: a
   * ceiling that silently became NaN disables the comparison rather than
   * failing it, which is worse than an outage.
   */
  async function konfigDesimal(
    tx: PumkTx,
    bumnId: string,
    grup: string,
    kunci: string,
  ): Promise<bigint> {
    const mentah = await konfig(tx, bumnId, grup, kunci);
    const mikro = keMikro(mentah);
    if (mikro === null) {
      throw tolak("KONFIGURASI_TIDAK_VALID", { kunci: `${grup}.${kunci}`, nilai: mentah });
    }
    return mikro;
  }

  function keMikro(nilai: string): bigint | null {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(nilai.trim());
    if (!m) return null;
    return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  }

  // ------------------------------------------------------- shared validation

  /** Invariant 7 at the door: a positive two-decimal string, or nothing. */
  function wajibUangPositif(nilai: unknown, medan: string): bigint {
    const u = bacaUang(nilai);
    if (u.bentuk === "rusak" || u.sen <= 0n) throw tolak("NILAI_BUKAN_DESIMAL", { [medan]: nilai });
    return u.sen;
  }

  function wajibTanggal(nilai: unknown, medan: string): string {
    if (!tanggalValid(nilai)) throw tolak("TANGGAL_TIDAK_VALID", { [medan]: nilai });
    return nilai;
  }

  async function wajibPlafonDalamBatas(tx: PumkTx, bumnId: string, sen: bigint): Promise<void> {
    const min = await konfigUang(tx, bumnId, "batasan", "plafon_min_pumk");
    const max = await konfigUang(tx, bumnId, "batasan", "plafon_max_pumk");
    // Both boundaries INCLUSIVE: an off-by-one here rejects an application for
    // exactly the ceiling amount, which is the most common application.
    if (sen < min || sen > max) {
      throw tolak("PLAFON_DILUAR_BATAS", {
        jumlah: dariSen(sen),
        min: dariSen(min),
        max: dariSen(max),
      });
    }
  }

  async function wajibTenorDalamBatas(tx: PumkTx, bumnId: string, tenor: number): Promise<void> {
    if (!Number.isInteger(tenor) || tenor <= 0) throw tolak("TENOR_DILUAR_BATAS", { tenor });
    const min = await konfigBulat(tx, bumnId, "batasan", "tenor_min_bulan");
    const max = await konfigBulat(tx, bumnId, "batasan", "tenor_max_bulan");
    if (tenor < min || tenor > max) throw tolak("TENOR_DILUAR_BATAS", { tenor, min, max });
  }

  /**
   * Spec 5.5, enforced AHEAD of pumk_akad_satu_aktif_per_mitra_uq. The index is
   * the real guarantee but it only fires at the akad INSERT, four screens and
   * one approval later, and its message is a raw constraint name. The LIMIT is
   * a programme parameter, so it is read, never assumed to be 1.
   */
  async function wajibBelumPunyaPinjamanAktif(
    tx: PumkTx,
    bumnId: string,
    mitraId: string,
  ): Promise<void> {
    const maks = await konfigBulat(tx, bumnId, "batasan", "maks_pinjaman_aktif_per_mitra");
    const aktif = await repo.jumlahPinjamanAktif(tx, mitraId);
    if (aktif >= maks) {
      throw tolak("MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF", { mitraId, aktif, maks });
    }
  }

  /** The cash leg an operator picked on the form, validated before any posting. */
  async function wajibAkunKas(tx: PumkTx, bumnId: string, akunKasId: string): Promise<void> {
    const akun = await repo.akun(tx, akunKasId);
    if (!akun || !akun.aktif || !akun.is_kas || !akun.is_postable || akun.bumn_id !== bumnId) {
      throw tolak("AKUN_KAS_TIDAK_VALID", { akunKasId });
    }
  }

  // --------------------------------------------------------- state machine

  function periksaTransisi(
    p: ProposalBaris,
    aksi: AksiProposal,
    catatan: string | null,
  ): DefinisiTransisi {
    const status = p.status as StatusProposal;
    if (STATUS_TERMINAL.includes(status)) {
      throw tolak("STATUS_TERMINAL", { proposalId: p.id, status });
    }
    const t = transisiUntuk(status, aksi);
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
   * is ALSO the timeline's ordering: `pumk_proposal_transisi` has no sequence,
   * so two transitions sharing an instant are unorderable and the chain the
   * detail page renders stops being a chain. Under an injected (frozen) clock
   * that is every transition of a proposal.
   *
   * So a transition that would land at or before its predecessor is nudged
   * PAST it. The first transition of a proposal is exactly `jam()`.
   *
   * THE NUDGE IS A WHOLE SECOND, NOT A MILLISECOND, and that is not cosmetic.
   * A reader that renders `waktu::text` and sorts on the rendered string (the
   * obvious report query, and what this folder's fixture does) compares
   * '...11:00:00+07' against '...11:00:00.001+07' under the database's
   * collation, which does not order punctuation the way ASCII would: the
   * fractional value sorts FIRST. Keeping every nudged instant free of a
   * fractional part means the text and the timestamp orderings agree, so a
   * timeline cannot read backwards in one place and forwards in another.
   */
  async function waktuTransisi(tx: PumkTx, proposalId: string): Promise<string> {
    const terakhir = await repo.transisiTerakhir(tx, proposalId);
    let ms = sekarang().getTime();
    if (terakhir) {
      const sebelumnya = Date.parse(terakhir);
      if (!Number.isNaN(sebelumnya) && ms <= sebelumnya) ms = sebelumnya + 1_000;
    }
    return new Date(ms).toISOString();
  }

  async function terapkanTransisi(
    tx: PumkTx,
    p: ProposalBaris,
    t: DefinisiTransisi,
    ctx: PumkContext,
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

  /** Loads the proposal for a write, with the branch check the row decides. */
  async function proposalUntukTransisi(
    tx: PumkTx,
    id: string,
    ctx: PumkContext,
  ): Promise<ProposalBaris> {
    const p = await repo.proposalUntukDiubah(tx, id);
    if (!p) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId: id });
    wajibScope(ctx, p.cabang_id);
    return p;
  }

  // ------------------------------------------------- collaborator failures

  /**
   * A collaborating engine's refusal becomes THIS module's code, with the raw
   * cause confined to `penyebabDb`. The engines raise their own domain errors
   * (AngsuranError, JurnalError) whose messages may quote a trigger string;
   * those are not this module's vocabulary and must not reach its caller.
   */
  async function lewatAngsuran<T>(jalankan: () => Promise<T>, detail: Record<string, unknown>): Promise<T> {
    try {
      return await jalankan();
    } catch (err) {
      throw tolak("JADWAL_GAGAL", detail, penyebab(err));
    }
  }

  async function lewatSetoran<T>(jalankan: () => Promise<T>, detail: Record<string, unknown>): Promise<T> {
    try {
      return await jalankan();
    } catch (err) {
      throw tolak("SETORAN_GAGAL", detail, penyebab(err));
    }
  }

  async function lewatJurnal<T>(jalankan: () => Promise<T>, detail: Record<string, unknown>): Promise<T> {
    try {
      return await jalankan();
    } catch (err) {
      throw tolak("JURNAL_GAGAL", detail, penyebab(err));
    }
  }

  // ---------------------------------------------------------------- engine

  return {
    async buatProposal(input: BuatProposalInput, ctx: PumkContext): Promise<Proposal> {
      wajibIzin(ctx, PERMISSION.BUAT);
      wajibScope(ctx, input.cabangId);
      const tanggal = wajibTanggal(input.tanggalProposal, "tanggalProposal");
      const tanggalDaftar = input.tanggalDaftar
        ? wajibTanggal(input.tanggalDaftar, "tanggalDaftar")
        : tanggal;
      const jumlahSen = wajibUangPositif(input.jumlahDiajukan, "jumlahDiajukan");

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const mitra = await repo.mitra(tx, input.mitraId);
          if (!mitra) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId: input.mitraId });
          // The branch of the proposal and the branch of the mitra have to
          // agree, or a branch can book another branch's mitra onto its book.
          if (mitra.cabang_id !== input.cabangId) {
            throw tolak("CABANG_DILUAR_SCOPE", { cabangId: mitra.cabang_id });
          }
          if (input.sektorId && !(await repo.sektorAda(tx, ctx.bumnId, input.sektorId))) {
            throw tolak("SEKTOR_TIDAK_DITEMUKAN", { sektorId: input.sektorId });
          }

          await wajibPlafonDalamBatas(tx, ctx.bumnId, jumlahSen);
          await wajibTenorDalamBatas(tx, ctx.bumnId, input.tenorDiajukan);
          await wajibBelumPunyaPinjamanAktif(tx, ctx.bumnId, input.mitraId);

          const noProposal = await nomorDokumen(tx, {
            cabangId: input.cabangId,
            jenisDokumen: "PROPOSAL_PUMK",
            tanggal,
            userId: ctx.userId,
            bumnId: ctx.bumnId,
          });

          const id = await repo.buatProposal(tx, {
            cabangId: input.cabangId,
            noProposal,
            tanggalProposal: tanggal,
            tanggalDaftar,
            mitraId: input.mitraId,
            sektorId: input.sektorId ?? null,
            jumlahDiajukan: dariSen(jumlahSen),
            tenorDiajukan: input.tenorDiajukan,
            tujuanPenggunaan: input.tujuanPenggunaan ?? null,
            sumberPengajuan: "INTERNAL",
            portalSubmissionId: null,
            userId: ctx.userId,
          });

          const baris = await repo.proposal(tx, id);
          if (!baris) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId: id });
          return proposalDari(baris);
        }),
      );
    },

    async tambahJaminan(proposalId, input: JaminanInput, ctx) {
      wajibIzin(ctx, PERMISSION.BUAT);
      const taksasi =
        input.nilaiTaksasi === null || input.nilaiTaksasi === undefined
          ? null
          : dariSen(wajibUangPositif(input.nilaiTaksasi, "nilaiTaksasi"));
      const tanggalTerima = input.tanggalTerima
        ? wajibTanggal(input.tanggalTerima, "tanggalTerima")
        : null;

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await repo.proposal(tx, proposalId);
          if (!p) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId });
          wajibScope(ctx, p.cabang_id);
          const id = await repo.buatJaminan(tx, {
            proposalId,
            jenis: input.jenis,
            deskripsi: input.deskripsi ?? null,
            nilaiTaksasi: taksasi,
            nomorDokumen: input.nomorDokumen ?? null,
            atasNama: input.atasNama ?? null,
            lokasi: input.lokasi ?? null,
            tanggalTerima,
            userId: ctx.userId,
          });
          return { id };
        }),
      );
    },

    async submitUntukSurvey(proposalId, catatan, ctx) {
      wajibIzin(ctx, PERMISSION.BUAT);
      const nota = catatanBersih(catatan);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, proposalId, ctx);
          const t = periksaTransisi(p, "SUBMIT_SURVEY", nota);
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async inputSurvey(input: InputSurveyInput, ctx) {
      wajibIzin(ctx, PERMISSION.SURVEY);
      const tanggalSurvey = wajibTanggal(input.tanggalSurvey, "tanggalSurvey");
      const skor = keMikro(input.skorTotal ?? "");
      if (skor === null) throw tolak("NILAI_BUKAN_DESIMAL", { skorTotal: input.skorTotal });
      const plafonSen = wajibUangPositif(input.plafonRekomendasi, "plafonRekomendasi");
      if (!Number.isInteger(input.tenorRekomendasi) || input.tenorRekomendasi <= 0) {
        throw tolak("TENOR_DILUAR_BATAS", { tenorRekomendasi: input.tenorRekomendasi });
      }
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, "INPUT_SURVEY", nota);
          // Inner guard: the sanctioned path cannot reach SURVEY_PENDING with a
          // survey row already attached, but a repaired import or a retried
          // request can, and overwriting the basis of a credit decision is not
          // something to do quietly.
          if (await repo.surveyAda(tx, p.id)) {
            throw tolak("SURVEY_SUDAH_ADA", { proposalId: p.id });
          }
          await repo.buatSurvey(tx, {
            proposalId: p.id,
            tanggalSurvey,
            petugasKaryawanId: input.petugasKaryawanId ?? null,
            hasilJson: JSON.stringify(input.hasil ?? {}),
            skorTotal: input.skorTotal,
            plafonRekomendasi: dariSen(plafonSen),
            tenorRekomendasi: input.tenorRekomendasi,
            catatan: nota,
            lampiranJson: JSON.stringify(input.lampiranFoto ?? []),
            userId: ctx.userId,
          });
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async ajukanKeChecker(proposalId, catatan, ctx) {
      wajibIzin(ctx, PERMISSION.BUAT);
      const nota = catatanBersih(catatan);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, proposalId, ctx);
          const t = periksaTransisi(p, "AJUKAN_CHECKER", nota);

          // Spec 5.5's collateral threshold, checked HERE rather than at
          // creation: jaminan are attached after the proposal exists, so at
          // creation there are none yet and refusing there makes the form
          // unusable. The threshold is a programme parameter, so it is read.
          const ambang = await konfigUang(
            tx,
            ctx.bumnId,
            "batasan",
            "wajib_jaminan_di_atas_plafon",
          );
          const jumlah = bacaUang(p.jumlah_diajukan);
          const diajukan = jumlah.bentuk === "ok" ? jumlah.sen : 0n;
          if (diajukan > ambang && !(await repo.adaJaminanRiil(tx, p.id))) {
            throw tolak("JAMINAN_WAJIB", {
              proposalId: p.id,
              jumlahDiajukan: p.jumlah_diajukan,
              ambang: dariSen(ambang),
            });
          }

          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async review(input: ReviewInput, ctx) {
      wajibIzin(ctx, PERMISSION.REVIEW);
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, input.keputusan as AksiProposal, nota);

          // Spec 2 rule 1, AHEAD of trg_pumk_review_10_sod: the trigger's
          // TJSL-SOD-001 names a user id and a plpgsql function, which is not
          // something a branch officer should ever be shown.
          if (p.created_by && p.created_by === ctx.userId) {
            throw tolak("KONFLIK_MAKER_CHECKER", { proposalId: p.id });
          }

          if (input.keputusan === "REKOMENDASI") {
            const skorMentah = await repo.skorSurvey(tx, p.id);
            if (skorMentah === null) throw tolak("SURVEY_BELUM_ADA", { proposalId: p.id });
            const skor = keMikro(skorMentah);
            if (skor === null) {
              throw tolak("KONFIGURASI_TIDAK_VALID", { skorTotal: skorMentah });
            }
            const minimum = await konfigDesimal(
              tx,
              ctx.bumnId,
              "batasan",
              "skor_survey_minimum_lolos",
            );
            if (skor < minimum) {
              throw tolak("SKOR_DIBAWAH_MINIMUM", { proposalId: p.id, skor: skorMentah });
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

    async putuskanPersetujuan(input: KeputusanApprovalInput, ctx) {
      wajibIzin(ctx, PERMISSION.SETUJUI);
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      const nota = catatanBersih(input.catatan);

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, input.keputusan as AksiProposal, nota);

          let plafon: string | null = null;
          let tenor: number | null = null;
          let rate: string | null = null;
          if (input.keputusan === "SETUJU") {
            // pumk_approval_setuju_ck would catch this, with a raw Postgres
            // string. An approval screen submitting an empty amount is an
            // ordinary mistake and deserves an ordinary message.
            if (
              input.plafonDisetujui === null ||
              input.plafonDisetujui === undefined ||
              input.tenorDisetujui === null ||
              input.tenorDisetujui === undefined
            ) {
              throw tolak("KEPUTUSAN_TIDAK_VALID", { proposalId: p.id });
            }
            const sen = wajibUangPositif(input.plafonDisetujui, "plafonDisetujui");
            await wajibPlafonDalamBatas(tx, ctx.bumnId, sen);
            await wajibTenorDalamBatas(tx, ctx.bumnId, input.tenorDisetujui);
            plafon = dariSen(sen);
            tenor = input.tenorDisetujui;
            if (input.jasaAdmRate !== null && input.jasaAdmRate !== undefined) {
              if (bacaRate(input.jasaAdmRate).bentuk === "rusak") {
                throw tolak("NILAI_BUKAN_DESIMAL", { jasaAdmRate: input.jasaAdmRate });
              }
              rate = input.jasaAdmRate;
            }
          }

          // Spec 2 rule 2, AHEAD of trg_pumk_approval_10_sod. Per DOCUMENT, not
          // per role: ADMIN_CABANG legitimately holds review AND approve, and
          // the conflict only exists on a file this user already reviewed.
          if (await repo.sudahMereview(tx, p.id, ctx.userId)) {
            throw tolak("KONFLIK_CHECKER_APPROVER", { proposalId: p.id });
          }

          await repo.buatApproval(tx, {
            proposalId: p.id,
            approverUserId: ctx.userId,
            tanggal,
            keputusan: input.keputusan,
            plafonDisetujui: plafon,
            tenorDisetujui: tenor,
            jasaAdmRate: rate,
            catatan: nota,
          });
          return proposalDari(await terapkanTransisi(tx, p, t, ctx, nota));
        }),
      );
    },

    async timeline(proposalId, ctx): Promise<TransisiProposal[]> {
      wajibIzin(ctx, PERMISSION.LIHAT);
      return bersihkanKesalahan(async () => {
        const p = await repo.proposal(deps.db, proposalId);
        if (!p) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId });
        wajibScope(ctx, p.cabang_id);
        const baris = await repo.timeline(deps.db, proposalId);
        return baris.map((b) => ({
          statusDari: b.status_dari as StatusProposal | null,
          statusKe: b.status_ke as StatusProposal,
          aksi: b.aksi as AksiProposal,
          olehUserId: b.oleh_user_id,
          waktu: b.waktu,
          catatan: b.catatan,
        }));
      });
    },

    async daftarProposal(filter: FilterProposal, ctx): Promise<Proposal[]> {
      wajibIzin(ctx, PERMISSION.LIHAT);
      return bersihkanKesalahan(async () => {
        // The branch filter NARROWS and never widens: passing another branch's
        // id must not become a back door around the scope check (scenario 24).
        const terlihat = cabangTerlihat(ctx);
        const cabangIds =
          filter.cabangId && terlihat.includes(filter.cabangId) ? [filter.cabangId] : terlihat;
        const baris = await repo.daftarProposal(deps.db, {
          cabangIds,
          sektorId: filter.sektorId ?? null,
          status: filter.status ?? null,
          sumberPengajuan: filter.sumberPengajuan ?? null,
          dariTanggal: filter.dariTanggal ?? null,
          sampaiTanggal: filter.sampaiTanggal ?? null,
          cari: filter.cari ?? null,
        });
        return baris.map(proposalDari);
      });
    },

    async buatAkad(input: BuatAkadInput, ctx): Promise<Akad> {
      wajibIzin(ctx, PERMISSION.AKAD);
      const tanggalAkad = wajibTanggal(input.tanggalAkad, "tanggalAkad");
      const tanggalMulai = wajibTanggal(input.tanggalMulaiAngsuran, "tanggalMulaiAngsuran");
      // Instalments that begin before the contract is signed produce a schedule
      // whose first rows are already overdue on day one, which then drives
      // kolektibilitas and penyisihan off a fiction.
      if (tanggalMulai < tanggalAkad) {
        throw tolak("TANGGAL_TIDAK_VALID", { tanggalAkad, tanggalMulaiAngsuran: tanggalMulai });
      }
      const grace = input.gracePeriodBulan ?? 0;
      if (!Number.isInteger(grace) || grace < 0) throw tolak("GRACE_DILUAR_BATAS", { grace });

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const p = await proposalUntukTransisi(tx, input.proposalId, ctx);
          const t = periksaTransisi(p, "BUAT_AKAD", null);
          if (await repo.akadDariProposal(tx, p.id)) {
            throw tolak("AKAD_SUDAH_ADA", { proposalId: p.id });
          }

          // THE POINT OF THIS STEP (spec 9.1, scenario 3): pokok, tenor and
          // rate come from the APPROVAL row. Taking them from the proposal is
          // the defect that has the mitra sign an akad for an amount nobody
          // approved, and nothing in the schema can catch it.
          const approval = await repo.approvalDisetujui(tx, p.id);
          if (!approval || approval.plafon_disetujui === null || approval.tenor_disetujui === null) {
            throw tolak("KEPUTUSAN_TIDAK_VALID", { proposalId: p.id });
          }
          const pokokSen = wajibUangPositif(approval.plafon_disetujui, "plafonDisetujui");
          const tenor = approval.tenor_disetujui;

          const graceMax = await konfigBulat(tx, ctx.bumnId, "batasan", "grace_period_max_bulan");
          if (grace > graceMax) throw tolak("GRACE_DILUAR_BATAS", { grace, batas: graceMax });

          const rate = approval.jasa_adm_rate
            ?? (await konfig(tx, ctx.bumnId, "jasa_adm", "jasa_adm_rate_default"));
          if (bacaRate(rate).bentuk === "rusak") {
            throw tolak("KONFIGURASI_TIDAK_VALID", { kunci: "jasa_adm.jasa_adm_rate_default", nilai: rate });
          }
          const metode =
            input.metodePerhitungan
            ?? (await konfig(tx, ctx.bumnId, "jasa_adm", "jasa_adm_metode_default"));
          if (!METODE_DIKENAL.has(metode)) {
            throw tolak("KONFIGURASI_TIDAK_VALID", {
              kunci: "jasa_adm.jasa_adm_metode_default",
              nilai: metode,
            });
          }

          await wajibBelumPunyaPinjamanAktif(tx, ctx.bumnId, p.mitra_id);

          const noAkad = await nomorDokumen(tx, {
            cabangId: p.cabang_id,
            jenisDokumen: "AKAD_PUMK",
            tanggal: tanggalAkad,
            userId: ctx.userId,
            bumnId: ctx.bumnId,
          });

          // The last due date follows the APPROVED tenor, by the same
          // month-clamping rule the schedule kernel uses, so the akad header
          // and the schedule's last row cannot disagree.
          const jatuhTempoAkhir = tambahBulan(tanggalMulai, grace + tenor - 1);

          const akadId = await repo.buatAkad(tx, {
            proposalId: p.id,
            mitraId: p.mitra_id,
            cabangId: p.cabang_id,
            noAkad,
            tanggalAkad,
            pokokPinjaman: dariSen(pokokSen),
            jasaAdmRate: rate,
            metodePerhitungan: metode,
            tenorBulan: tenor,
            gracePeriodBulan: grace,
            tanggalMulaiAngsuran: tanggalMulai,
            tanggalJatuhTempoAkhir: jatuhTempoAkhir,
            pathDokumenAkad: input.pathDokumenAkad ?? null,
            userId: ctx.userId,
          });

          await terapkanTransisi(tx, p, t, ctx, null);

          const baris = await repo.akad(tx, akadId);
          if (!baris) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
          return akadDari(baris);
        }),
      );
    },

    async generateJadwal(akadId, ctx) {
      wajibIzin(ctx, PERMISSION.AKAD);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akad(tx, akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
          wajibScope(ctx, akad.cabang_id);
          const p = await proposalUntukTransisi(tx, akad.proposal_id, ctx);
          const t = periksaTransisi(p, "GENERATE_JADWAL", null);
          await terapkanTransisi(tx, p, t, ctx, null);
          // Invariant 8: no `pumk_jadwal_angsuran` row is written here, ever.
          // The instalment engine owns the arithmetic AND the storage, so what
          // crosses this port is an akad id and nothing else.
          return lewatAngsuran(
            () => deps.angsuran.generateJadwal({ akadId }, ctx),
            { akadId },
          );
        }),
      );
    },

    async catatPencairan(input: PencairanInput, ctx): Promise<HasilPencairan> {
      wajibIzin(ctx, PERMISSION.PENCAIRAN);
      const tanggal = wajibTanggal(input.tanggalPencairan, "tanggalPencairan");
      const jumlahSen = wajibUangPositif(input.jumlah, "jumlah");

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akad(tx, input.akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
          wajibScope(ctx, akad.cabang_id);
          const p = await proposalUntukTransisi(tx, akad.proposal_id, ctx);
          if (STATUS_TERMINAL.includes(p.status as StatusProposal)) {
            throw tolak("STATUS_TERMINAL", { proposalId: p.id, status: p.status });
          }
          if (await repo.pencairanAda(tx, akad.id)) {
            throw tolak("PENCAIRAN_SUDAH_ADA", { akadId: akad.id });
          }
          // Spec 9.1 orders the steps: generate the schedule, THEN disburse.
          // Money out with no schedule leaves a receivable nobody can bill and
          // no due date for kolektibilitas to measure against. Checked before
          // the transition lookup so the caller is told WHY, not just "no".
          if (!(await repo.adaVersiJadwal(tx, akad.id))) {
            throw tolak("JADWAL_BELUM_SIAP", { akadId: akad.id });
          }
          const t = periksaTransisi(p, "PENCAIRAN", null);

          // The akad, the schedule and the journal all describe one principal.
          // There is no partial-disbursement concept in spec 9.1, so a
          // different amount desynchronises all three at once.
          const pokok = bacaUang(akad.pokok_pinjaman);
          if (pokok.bentuk !== "ok" || pokok.sen !== jumlahSen) {
            throw tolak("NILAI_PENCAIRAN_TIDAK_COCOK", {
              jumlah: input.jumlah,
              pokokPinjaman: akad.pokok_pinjaman,
            });
          }
          await wajibAkunKas(tx, ctx.bumnId, input.akunKasId);

          const pencairanId = await repo.buatPencairan(tx, {
            akadId: akad.id,
            tanggalPencairan: tanggal,
            jumlah: dariSen(jumlahSen),
            akunKasId: input.akunKasId,
            noBukti: input.noBukti ?? null,
            keterangan: input.keterangan ?? null,
            userId: ctx.userId,
          });

          // THE LEDGER FIRST. `postingEvent` owns its own transaction, so
          // posting before this module touches `pumk_akad` means no row lock is
          // ever held across another engine's transaction. A refusal here
          // aborts everything above with it, which is the whole reason
          // `PumkDbPort.transaction` is not optional.
          const jurnal = await lewatJurnal(
            () =>
              deps.jurnal.postingEvent(
                EVENT_PENCAIRAN,
                {
                  cabangId: akad.cabang_id,
                  tanggalTransaksi: tanggal,
                  nilai: dariSen(jumlahSen),
                  keterangan: input.keterangan ?? `Pencairan PUMK akad ${akad.no_akad}`,
                  akunKasId: input.akunKasId,
                  // The sub-ledger dimensions `v_rekonsiliasi_piutang` joins
                  // on. Without `akadId` the balance cannot be attributed to an
                  // akad at all and every akad reads as a difference.
                  mitraId: akad.mitra_id,
                  akadId: akad.id,
                  referensiTipe: "pumk_pencairan",
                  referensiId: pencairanId,
                  kunciIdempotensi: `pumk_pencairan:${pencairanId}`,
                },
                ctx,
              ),
            { pencairanId },
          );

          await repo.setJurnalPencairan(tx, pencairanId, jurnal.id);
          await repo.setAkadCair(tx, {
            akadId: akad.id,
            outstandingPokok: dariSen(jumlahSen),
            // The jasa side is the schedule's own total, so the two outstanding
            // columns describe the same schedule.
            outstandingJasa: await repo.totalJasaAktif(tx, akad.id),
            userId: ctx.userId,
          });
          // Spec 4.3: the mitra stops being a CALON at disbursement.
          await repo.setStatusMitra(tx, akad.mitra_id, "AKTIF", ctx.userId);
          const proposalSetelah = await terapkanTransisi(tx, p, t, ctx, null);

          const akadSetelah = await repo.akad(tx, akad.id);
          if (!akadSetelah) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: akad.id });
          return {
            pencairanId,
            akadId: akad.id,
            tanggalPencairan: tanggal,
            jumlah: dariSen(jumlahSen),
            jurnalId: jurnal.id,
            akad: akadDari(akadSetelah),
            proposal: proposalDari(proposalSetelah),
          };
        }),
      );
    },

    async terimaAngsuran(input: TerimaAngsuranInput, ctx): Promise<HasilAlokasi> {
      wajibIzin(ctx, PERMISSION.ANGSURAN);
      const tanggal = wajibTanggal(input.tanggalTerima, "tanggalTerima");
      wajibUangPositif(input.jumlah, "jumlah");
      const valuta = input.tanggalValuta ? wajibTanggal(input.tanggalValuta, "tanggalValuta") : null;

      return bersihkanKesalahan(async () => {
        const akad = await repo.akad(deps.db, input.akadId);
        if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
        wajibScope(ctx, akad.cabang_id);
        await wajibAkunKas(deps.db, ctx.bumnId, input.akunKasId);

        // Invariants 9 and 10 live in modules/angsuran. A second allocation
        // implementation here would be a second source of truth for how a
        // rupiah is split, and the two would diverge on the first rounding
        // change. So the input is passed through unchanged and the whole
        // waterfall, the surplus routing and the combined journal of spec 7.2
        // step 8 belong to that engine.
        return lewatSetoran(
          () =>
            deps.angsuran.alokasikanSetoran(
              {
                akadId: input.akadId,
                tanggal,
                jumlah: input.jumlah,
                akunKasId: input.akunKasId,
                noBukti: input.noBukti ?? null,
                tanggalValuta: valuta,
                keterangan: input.keterangan ?? null,
              },
              ctx,
            ),
          { akadId: input.akadId },
        );
      });
    },

    async ajukanReschedule(input, ctx): Promise<Reschedule> {
      wajibIzin(ctx, PERMISSION.RESCHEDULE);
      return bersihkanKesalahan(async () => {
        const akad = await repo.akad(deps.db, input.akadId);
        if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
        wajibScope(ctx, akad.cabang_id);
        return lewatAngsuran(
          () =>
            deps.angsuran.ajukanReschedule(
              {
                akadId: input.akadId,
                tanggalPengajuan: input.tanggalPengajuan,
                alasan: input.alasan,
                jenis: input.jenis as JenisReschedule,
                tenorBaru: input.tenorBaru ?? null,
                graceBaru: input.graceBaru ?? null,
                jasaRateBaru: input.jasaRateBaru ?? null,
                catatan: input.catatan ?? null,
              },
              ctx,
            ),
          { akadId: input.akadId },
        );
      });
    },

    async setujuiReschedule(rescheduleId, ctx): Promise<HasilReschedule> {
      wajibIzin(ctx, PERMISSION.SETUJUI);
      return bersihkanKesalahan(async () => {
        const akad = await repo.akadDariReschedule(deps.db, rescheduleId);
        if (akad) wajibScope(ctx, akad.cabang_id);

        const hasil = await lewatAngsuran(
          () => deps.angsuran.setujuiReschedule(rescheduleId, ctx),
          { rescheduleId },
        );

        // The instalment engine owns the schedule and the outstanding; the
        // akad's own CONTRACTUAL SHAPE (its tenor, its grace and its final due
        // date) is this module's row and would otherwise still describe the
        // superseded version. A kartu piutang showing a 12-month akad against
        // an 18-row active schedule is a support call, not a rounding issue.
        const baris = hasil.jadwalBaru.baris;
        const terakhir = baris[baris.length - 1];
        if (terakhir) {
          await repo.setTenorAkad(deps.db, {
            akadId: hasil.jadwalBaru.akadId,
            tenorBulan: hasil.jadwalBaru.parameterTerpakai.tenorBulan,
            gracePeriodBulan: hasil.jadwalBaru.parameterTerpakai.gracePeriodBulan,
            tanggalJatuhTempoAkhir: terakhir.tanggalJatuhTempo,
            userId: ctx.userId,
          });
        }
        return hasil;
      });
    },

    async catatPengakhiran(input: PengakhiranInput, ctx): Promise<Pengakhiran> {
      wajibIzin(
        ctx,
        input.jenis === "LUNAS_DIPERCEPAT" ? PERMISSION.SETUJUI : PERMISSION.HAPUSBUKU,
      );
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      if (kosong(input.dasarKeputusan)) {
        throw tolak("CATATAN_WAJIB", { akadId: input.akadId });
      }

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akad(tx, input.akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
          wajibScope(ctx, akad.cabang_id);

          // docs/REGULASI.md finding 5 and docs/BUILD-PLAN.md: penghapustagihan
          // is a legally distinct act from penghapusbukuan, it moves no balance
          // once the receivable is already off the books, and spec 6.4 gives it
          // NO event code. Borrowing HAPUS_BUKU_PIUTANG "because it is close
          // enough" would merge two events that differ in whether the debt
          // still exists, and no reconciliation could separate them afterwards.
          if (input.jenis === "PENGHAPUSAN_BERSYARAT") {
            throw tolak("EVENT_MAPPING_BELUM_ADA", { jenis: input.jenis });
          }

          // Checked BEFORE the status eligibility, because after a write-off
          // the akad is HAPUS_BUKU and "not eligible" would be the wrong answer
          // to "you already did this".
          if (await repo.pengakhiranAda(tx, akad.id)) {
            throw tolak("PENGAKHIRAN_SUDAH_ADA", { akadId: akad.id });
          }

          const outstandingPokok = bacaUang(akad.outstanding_pokok);
          const outstandingJasa = bacaUang(akad.outstanding_jasa);
          const pokokSen = outstandingPokok.bentuk === "ok" ? outstandingPokok.sen : 0n;
          const jasaSen = outstandingJasa.bentuk === "ok" ? outstandingJasa.sen : 0n;

          if (input.jenis === "LUNAS_DIPERCEPAT") {
            // "Lunas" is a fact about the balance, not a button. Recording it
            // while money is still owed takes a live receivable off the ageing.
            if (akad.status !== "LUNAS" || pokokSen !== 0n || jasaSen !== 0n) {
              throw tolak("AKAD_TIDAK_BISA_DIAKHIRI", { status: akad.status });
            }
          } else if (!STATUS_PIUTANG_AKTIF.has(akad.status)) {
            throw tolak("AKAD_TIDAK_BISA_DIAKHIRI", { status: akad.status });
          }

          const pengakhiranId = await repo.buatPengakhiran(tx, {
            akadId: akad.id,
            jenis: input.jenis,
            tanggal,
            outstandingPokok: dariSen(pokokSen),
            outstandingJasa: dariSen(jasaSen),
            dasarKeputusan: input.dasarKeputusan,
            noSk: input.noSk ?? null,
            userId: ctx.userId,
            waktu: sekarang().toISOString(),
          });

          let jurnalId: string | null = null;
          if (input.jenis === "HAPUS_BUKU") {
            jurnalId = await postingHapusBuku(tx, {
              akad,
              tanggal,
              outstandingSen: pokokSen,
              pengakhiranId,
              noSk: input.noSk ?? null,
              ctx,
            });
            if (jurnalId) await repo.setJurnalPengakhiran(tx, pengakhiranId, jurnalId);
            await repo.setAkadHapusBuku(tx, akad.id, ctx.userId);
          }
          // LUNAS_DIPERCEPAT posts NOTHING: the money already moved through the
          // allocation, and a journal here would credit the receivable a second
          // time and drive the ledger below the sub-ledger.

          const akadSetelah = await repo.akad(tx, akad.id);
          if (!akadSetelah) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: akad.id });
          return {
            id: pengakhiranId,
            akadId: akad.id,
            jenis: input.jenis,
            tanggal,
            outstandingPokokSaatItu: dariSen(pokokSen),
            outstandingJasaSaatItu: dariSen(jasaSen),
            noSk: input.noSk ?? null,
            jurnalId,
            akadSetelah: akadDari(akadSetelah),
          };
        }),
      );
    },

    async catatTindakLanjut(input: TindakLanjutInput, ctx): Promise<TindakLanjut> {
      wajibIzin(ctx, PERMISSION.PENAGIHAN);
      const tanggal = wajibTanggal(input.tanggal, "tanggal");
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akad(tx, input.akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
          wajibScope(ctx, akad.cabang_id);
          // DELIBERATELY NO STATUS GATE. SK-277/MBU/10/2023: penghapusbukuan
          // takes the receivable off the balance sheet, but the RIGHT TO COLLECT
          // survives on the extracomptable register. A trail that closed at
          // write-off would assert the claim was extinguished, and any later
          // recovery would have no supporting record.
          const id = await repo.buatTindakLanjut(tx, {
            akadId: akad.id,
            tanggal,
            jenis: input.jenis,
            hasil: input.hasil ?? null,
            petugasKaryawanId: input.petugasKaryawanId ?? null,
            catatan: input.catatan ?? null,
            lampiranJson: JSON.stringify(input.lampiran ?? []),
            userId: ctx.userId,
          });
          return {
            id,
            akadId: akad.id,
            tanggal,
            jenis: input.jenis,
            hasil: input.hasil ?? null,
            petugasKaryawanId: input.petugasKaryawanId ?? null,
            catatan: input.catatan ?? null,
          };
        }),
      );
    },

    async daftarTindakLanjut(akadId, ctx): Promise<TindakLanjut[]> {
      wajibIzin(ctx, PERMISSION.LIHAT);
      return bersihkanKesalahan(async () => {
        const akad = await repo.akad(deps.db, akadId);
        if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
        wajibScope(ctx, akad.cabang_id);
        const baris = await repo.daftarTindakLanjut(deps.db, akadId);
        return baris.map((b) => ({
          id: b.id,
          akadId: b.akad_id,
          tanggal: b.tanggal,
          jenis: b.jenis as TindakLanjut["jenis"],
          hasil: b.hasil,
          petugasKaryawanId: b.petugas_karyawan_id,
          catatan: b.catatan,
        }));
      });
    },

    async tambahAnggotaCluster(input, ctx): Promise<AnggotaCluster> {
      wajibIzin(ctx, PERMISSION.CLUSTER);
      const tanggalMasuk = wajibTanggal(input.tanggalMasuk, "tanggalMasuk");
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const cabangCluster = await repo.clusterCabang(tx, input.clusterId);
          if (!cabangCluster) throw tolak("CLUSTER_TIDAK_DITEMUKAN", { clusterId: input.clusterId });
          wajibScope(ctx, cabangCluster);
          const mitra = await repo.mitra(tx, input.mitraId);
          if (!mitra) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId: input.mitraId });

          // AHEAD of cluster_anggota_aktif_uq, whose refusal is a raw
          // constraint name. A mitra belongs to at most one cluster at a time.
          const aktif = await repo.keanggotaanAktif(tx, input.mitraId);
          if (aktif) {
            throw tolak("MITRA_SUDAH_DI_CLUSTER", {
              mitraId: input.mitraId,
              clusterId: aktif.cluster_id,
            });
          }

          const baris = await repo.buatAnggotaCluster(tx, {
            clusterId: input.clusterId,
            mitraId: input.mitraId,
            tanggalMasuk,
            userId: ctx.userId,
          });
          // `cluster_anggota` is the HISTORY and `mitra.cluster_id` the
          // denormalised current pointer. Both move, or the two disagree about
          // who is in the group today.
          await repo.setClusterMitra(tx, input.mitraId, input.clusterId, ctx.userId);
          return anggotaDari(baris);
        }),
      );
    },

    async keluarkanAnggotaCluster(input, ctx): Promise<AnggotaCluster> {
      wajibIzin(ctx, PERMISSION.CLUSTER);
      const tanggalKeluar = wajibTanggal(input.tanggalKeluar, "tanggalKeluar");
      if (kosong(input.alasan)) throw tolak("CATATAN_WAJIB", { clusterId: input.clusterId });

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const cabangCluster = await repo.clusterCabang(tx, input.clusterId);
          if (!cabangCluster) throw tolak("CLUSTER_TIDAK_DITEMUKAN", { clusterId: input.clusterId });
          wajibScope(ctx, cabangCluster);

          // Leaving is a DATED FACT, not a deletion: a cluster's past
          // performance has to stay attributable to the members it had.
          const baris = await repo.tutupAnggotaCluster(tx, {
            clusterId: input.clusterId,
            mitraId: input.mitraId,
            tanggalKeluar,
            alasan: input.alasan,
            userId: ctx.userId,
          });
          if (!baris) {
            throw tolak("MITRA_BUKAN_ANGGOTA_CLUSTER", {
              clusterId: input.clusterId,
              mitraId: input.mitraId,
            });
          }
          await repo.setClusterMitra(tx, input.mitraId, null, ctx.userId);
          return anggotaDari(baris);
        }),
      );
    },

    async daftarAnggotaCluster(clusterId, ctx, opsi): Promise<AnggotaCluster[]> {
      wajibIzin(ctx, PERMISSION.LIHAT);
      const pada = opsi?.padaTanggal ? wajibTanggal(opsi.padaTanggal, "padaTanggal") : null;
      return bersihkanKesalahan(async () => {
        const cabangCluster = await repo.clusterCabang(deps.db, clusterId);
        if (!cabangCluster) throw tolak("CLUSTER_TIDAK_DITEMUKAN", { clusterId });
        wajibScope(ctx, cabangCluster);
        const baris = await repo.daftarAnggotaCluster(deps.db, clusterId, pada);
        return baris.map(anggotaDari);
      });
    },

    async kartuPiutang(akadId, ctx): Promise<KartuPiutang> {
      wajibIzin(ctx, PERMISSION.LIHAT);
      return bersihkanKesalahan(async () => {
        const akad = await repo.akad(deps.db, akadId);
        if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
        wajibScope(ctx, akad.cabang_id);
        const mitra = await repo.mitra(deps.db, akad.mitra_id);
        if (!mitra) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId: akad.mitra_id });

        // Every version, newest first, from the engine that owns them. Nothing
        // here recomputes a schedule: a read model that derives its own numbers
        // is a second, quietly diverging source of truth on the screen officers
        // open most often.
        const jadwal = await lewatAngsuran(
          () => deps.angsuran.riwayatJadwal(akadId, ctx),
          { akadId },
        );
        const setoran = await repo.setoran(deps.db, akadId);
        const kelebihan = await repo.kelebihan(deps.db, akadId);
        const kolek = await repo.riwayatKolektibilitas(deps.db, akadId);
        // Spec 8.4 check 10 ON THE PAGE ITSELF, read from the SHIPPED view so
        // the kartu cannot agree with a wrong query it wrote for itself.
        const rekon = await repo.rekonsiliasi(deps.db, akadId);

        return {
          mitra: {
            id: mitra.id,
            kodeMitra: mitra.kode_mitra,
            namaLengkap: mitra.nama_lengkap,
            status: mitra.status,
            clusterId: mitra.cluster_id,
          },
          akad: akadDari(akad),
          jadwal,
          setoran: setoran.map((s) => ({
            id: s.id,
            tanggalTerima: s.tanggal_terima,
            jumlahDiterima: s.jumlah_diterima as Uang,
            alokasiPokok: s.alokasi_pokok as Uang,
            alokasiJasa: s.alokasi_jasa as Uang,
            alokasiKelebihan: s.alokasi_kelebihan as Uang,
            jurnalId: s.jurnal_id,
          })),
          kelebihan: kelebihan.map((k) => ({
            id: k.id,
            tanggal: k.tanggal,
            jumlah: k.jumlah as Uang,
            status: k.status,
          })),
          riwayatKolektibilitas: kolek.map((k) => ({
            periodeId: k.periode_id,
            kelas: k.kelas,
            hariTunggakan: k.hari_tunggakan,
          })),
          outstanding: {
            pokok: akad.outstanding_pokok as Uang,
            jasa: akad.outstanding_jasa as Uang,
          },
          saldoBukuBesar: (rekon?.buku_besar ?? "0.00") as Uang,
          selisihRekonsiliasi: (rekon?.selisih ?? "0.00") as Uang,
        };
      });
    },

    async konversiSubmissionPortal(input: KonversiPortalInput, ctx): Promise<Proposal> {
      wajibIzin(ctx, PERMISSION.KONVERSI_PORTAL);
      wajibScope(ctx, input.cabangId);
      const tanggal = wajibTanggal(input.tanggalProposal, "tanggalProposal");

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const s = await repo.submission(tx, input.submissionId);
          if (!s) throw tolak("SUBMISSION_TIDAK_DITEMUKAN", { submissionId: input.submissionId });
          if (s.jenis !== "PUMK") {
            throw tolak("SUBMISSION_BUKAN_PUMK", { submissionId: s.id, jenis: s.jenis });
          }
          if (s.status === "DIKONVERSI" || s.converted_proposal_id !== null) {
            throw tolak("SUBMISSION_SUDAH_DIKONVERSI", { submissionId: s.id });
          }

          // `data_json` is whatever a member of the public typed
          // (migrations/0013: "never trusted"). It is validated by exactly the
          // same rules as the internal form; an engine that copied the numbers
          // straight in would have moved the validation boundary outside the
          // building.
          const data = bacaDataSubmission(s.data_json);
          const jumlahMentah = data.jumlah_diajukan;
          const tenorMentah = data.tenor_diajukan;
          if (
            jumlahMentah === undefined ||
            jumlahMentah === null ||
            tenorMentah === undefined ||
            tenorMentah === null
          ) {
            throw tolak("SUBMISSION_DATA_TIDAK_LENGKAP", { submissionId: s.id });
          }
          const jumlahSen = wajibUangPositif(jumlahMentah, "jumlah_diajukan");
          const tenor = bacaTenor(tenorMentah);
          if (tenor === null) throw tolak("NILAI_BUKAN_DESIMAL", { tenor_diajukan: tenorMentah });

          const mitra = await repo.mitra(tx, input.mitraId);
          if (!mitra) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId: input.mitraId });
          if (mitra.cabang_id !== input.cabangId) {
            throw tolak("CABANG_DILUAR_SCOPE", { cabangId: mitra.cabang_id });
          }
          if (input.sektorId && !(await repo.sektorAda(tx, ctx.bumnId, input.sektorId))) {
            throw tolak("SEKTOR_TIDAK_DITEMUKAN", { sektorId: input.sektorId });
          }

          await wajibPlafonDalamBatas(tx, ctx.bumnId, jumlahSen);
          await wajibTenorDalamBatas(tx, ctx.bumnId, tenor);
          await wajibBelumPunyaPinjamanAktif(tx, ctx.bumnId, input.mitraId);

          const noProposal = await nomorDokumen(tx, {
            cabangId: input.cabangId,
            jenisDokumen: "PROPOSAL_PUMK",
            tanggal,
            userId: ctx.userId,
            bumnId: ctx.bumnId,
          });

          const id = await repo.buatProposal(tx, {
            cabangId: input.cabangId,
            noProposal,
            tanggalProposal: tanggal,
            tanggalDaftar: tanggal,
            mitraId: input.mitraId,
            sektorId: input.sektorId ?? null,
            jumlahDiajukan: dariSen(jumlahSen),
            tenorDiajukan: tenor,
            tujuanPenggunaan:
              typeof data.tujuan_penggunaan === "string" ? data.tujuan_penggunaan : null,
            sumberPengajuan: "PORTAL_ONLINE",
            portalSubmissionId: s.id,
            userId: ctx.userId,
          });

          const ditandai = await repo.tandaiSubmissionDikonversi(tx, {
            id: s.id,
            proposalId: id,
            catatan: input.catatanPetugas ?? null,
            userId: ctx.userId,
          });
          if (ditandai === 0) throw tolak("SUBMISSION_SUDAH_DIKONVERSI", { submissionId: s.id });

          const baris = await repo.proposal(tx, id);
          if (!baris) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId: id });
          return proposalDari(baris);
        }),
      );
    },
  };

  // ------------------------------------------------------------- internals

  function anggotaDari(b: {
    cluster_id: string;
    mitra_id: string;
    tanggal_masuk: string;
    tanggal_keluar: string | null;
    alasan_keluar: string | null;
  }): AnggotaCluster {
    return {
      clusterId: b.cluster_id,
      mitraId: b.mitra_id,
      tanggalMasuk: b.tanggal_masuk,
      tanggalKeluar: b.tanggal_keluar,
      alasanKeluar: b.alasan_keluar,
    };
  }

  /**
   * Allocates a document number inside the CALLER's transaction, so a rolled
   * back proposal does not burn a number and leave a gap an auditor will ask
   * about (spec 4.10). The branch code goes into the template, which is what
   * keeps two branches' series apart in one global uniqueness index.
   */
  async function nomorDokumen(
    tx: PumkTx,
    input: {
      bumnId: string;
      cabangId: string;
      jenisDokumen: string;
      tanggal: string;
      userId: string;
    },
  ): Promise<string> {
    const cabang = await repo.cabang(tx, input.cabangId);
    const [tahun, bulan] = input.tanggal.split("-").map((x) => Number.parseInt(x, 10));
    const hasil = await nomor.generate(
      {
        bumnId: input.bumnId,
        cabangId: input.cabangId,
        jenisDokumen: input.jenisDokumen,
        tahun,
        bulan,
        kodeCabang: cabang?.kode ?? "",
        userId: input.userId,
      },
      { tx },
    );
    return hasil.nomor;
  }

  /**
   * The submission payload, from `data_json::text`.
   *
   * TOLERANT OF A DOUBLE-ENCODED PAYLOAD ON PURPOSE. Driver fact 3 (see
   * ./repo.ts): a `jsonb` parameter bound from a JS string through `$n::jsonb`
   * is stored as a JSON STRING SCALAR rather than as an object, and this
   * column is written by the PUBLIC intake path, which this module does not
   * own and cannot audit. Refusing such a row would mean an officer cannot
   * convert a ticket a member of the public really did submit, because of a
   * bind in another module. Unwrapping one layer of encoding costs nothing and
   * every value is validated afterwards regardless of how it arrived.
   */
  function bacaDataSubmission(mentah: string): Record<string, unknown> {
    let nilai: unknown;
    try {
      nilai = JSON.parse(mentah);
    } catch {
      return {};
    }
    if (typeof nilai === "string") {
      try {
        nilai = JSON.parse(nilai);
      } catch {
        return {};
      }
    }
    return nilai !== null && typeof nilai === "object" ? (nilai as Record<string, unknown>) : {};
  }

  function bacaTenor(nilai: unknown): number | null {
    if (typeof nilai === "number") return Number.isInteger(nilai) && nilai > 0 ? nilai : null;
    if (typeof nilai === "string" && /^\d+$/.test(nilai.trim())) {
      const n = Number(nilai.trim());
      return n > 0 ? n : null;
    }
    return null;
  }

  /**
   * Penghapusbukuan, with THE ALLOWANCE CONSUMED FIRST and only the remainder
   * charged to the period.
   *
   * WHY THE SPEC'S OWN JOURNAL IS NOT ENOUGH. Spec 6.4's HAPUS_BUKU_PIUTANG
   * debits Penyisihan Penurunan Nilai Piutang for the FULL outstanding, which
   * is only correct when the allowance covers it (a 100 percent Macet rate).
   * Under the collective-impairment basis docs/REGULASI.md found to be in
   * force, the allowance is usually smaller, and the naive journal drives a
   * CONTRA-ASSET into a debit balance: receivables presented as overstated by
   * exactly the amount that was supposed to leave the balance sheet. It
   * balances, and it is wrong. docs/BUILD-PLAN.md "Keputusan sementara" decided
   * the split, and HAPUS_BUKU_KEKURANGAN_PENYISIHAN is the seeded event for the
   * remainder.
   *
   * NO ACCOUNT CODE APPEARS HERE. The allowance account is whatever the
   * HAPUS_BUKU_PIUTANG mapping row DEBITS, so repointing that row moves the
   * balance measured with it (invariant 11, ADR 0004). The allowance is a
   * PORTFOLIO balance, not a per-akad one, because BEBAN_PENYISIHAN touches
   * neither the receivable account nor a sub-ledger dimension the engine would
   * accept (spec 6.2.8) - which is the collective basis the regulation review
   * described.
   *
   * Returns the journal recorded on `pumk_pengakhiran`; when the split produces
   * two journals that is the allowance one, which is the leg an auditor traces
   * from the write-off decision.
   */
  async function postingHapusBuku(
    tx: PumkTx,
    input: {
      akad: AkadBaris;
      tanggal: string;
      outstandingSen: bigint;
      pengakhiranId: string;
      noSk: string | null;
      ctx: PumkContext;
    },
  ): Promise<string | null> {
    const { akad, ctx } = input;
    const akunPenyisihan = await repo.akunPenyisihan(tx, ctx.bumnId, EVENT_HAPUS_BUKU);
    if (!akunPenyisihan) throw tolak("EVENT_MAPPING_BELUM_ADA", { eventCode: EVENT_HAPUS_BUKU });

    const saldo = bacaUang(
      await repo.saldoNormalAkun(tx, ctx.bumnId, akunPenyisihan, input.tanggal),
    );
    // A contra-asset already in a debit balance (someone posted the naive
    // journal before this path existed) has NOTHING left to consume; treating
    // its negative balance as capacity would deepen the very hole this split
    // exists to prevent.
    const saldoSen = saldo.bentuk === "ok" ? saldo.sen : 0n;
    const tersedia = saldoSen > 0n ? saldoSen : 0n;
    const dariPenyisihan =
      tersedia < input.outstandingSen ? tersedia : input.outstandingSen;
    const kekurangan = input.outstandingSen - dariPenyisihan;

    const dasar = {
      cabangId: akad.cabang_id,
      tanggalTransaksi: input.tanggal,
      // Both legs carry the akad, so both reduce the SAME sub-ledger balance
      // and `v_rekonsiliasi_piutang` sees the receivable fully relieved.
      mitraId: akad.mitra_id,
      akadId: akad.id,
      referensiTipe: "pumk_pengakhiran",
      referensiId: input.pengakhiranId,
    };
    const catatan = input.noSk
      ? `Hapus buku akad ${akad.no_akad} (${input.noSk})`
      : `Hapus buku akad ${akad.no_akad}`;

    let jurnalUtama: string | null = null;
    // A "0.00" component would be refused as a line with neither side filled
    // (spec 6.2.3), so "consume the allowance first" means "consume what there
    // is": with no allowance at all there is only the shortfall journal.
    if (dariPenyisihan > 0n) {
      const j = await lewatJurnal(
        () =>
          deps.jurnal.postingEvent(
            EVENT_HAPUS_BUKU,
            {
              ...dasar,
              nilai: dariSen(dariPenyisihan),
              keterangan: catatan,
              kunciIdempotensi: `pumk_pengakhiran:${input.pengakhiranId}:penyisihan`,
            },
            ctx,
          ),
        { pengakhiranId: input.pengakhiranId },
      );
      jurnalUtama = j.id;
    }
    if (kekurangan > 0n) {
      const j = await lewatJurnal(
        () =>
          deps.jurnal.postingEvent(
            EVENT_HAPUS_BUKU_KEKURANGAN,
            {
              ...dasar,
              nilai: dariSen(kekurangan),
              keterangan: `${catatan}: kekurangan penyisihan`,
              kunciIdempotensi: `pumk_pengakhiran:${input.pengakhiranId}:kekurangan`,
            },
            ctx,
          ),
        { pengakhiranId: input.pengakhiranId },
      );
      jurnalUtama = jurnalUtama ?? j.id;
    }
    return jurnalUtama;
  }
}
