// apps/api/src/modules/rka/service.ts
//
// The RKA engine (spec 4.8, spec 9.3, spec 10.3 report 24, spec 16 scenario
// 18). Private to the module; ./index.ts is the only door in and ./contract.ts
// is the shape the six *.test.ts files in this folder were written against
// before a line of this file existed.
//
// ---------------------------------------------------------------------------
// THE ONE THING THIS FILE MUST NOT GET WRONG
// ---------------------------------------------------------------------------
// REALISATION IS READ, NEVER RECOMPUTED.
//
//   OPEN period    -> `v_ledger_baris`, the shipped view whose predicate is
//                     `status IN ('POSTED','REVERSED')`.
//   CLOSED period  -> `saldo_akun_periode`, the trial balance the close FROZE.
//   never          -> `status = 'POSTED'` alone (ADR 0010, migrations/0018): a
//                     correction is a reversing entry, both sets of lines stay
//                     in the ledger and cancel, so a POSTED-only sum subtracts
//                     a correction it never added. In a budget report that
//                     defect is invisible, because report 24 has no balance to
//                     check and nothing to reconcile against.
//
// Every row and every period says WHICH source answered (`sumberRealisasi`,
// `sumberPerPeriode`), because the two agree on well-behaved data and an
// equality assertion alone cannot tell them apart. A period read live when it
// should have been read frozen gives the same figure today and a different one
// after a reopen or a reclassification, which is precisely the failure
// invariant 14 forbids.
//
// ---------------------------------------------------------------------------
// AND THE REFUSAL THIS FILE IMPLEMENTS RATHER THAN WORKS AROUND
// ---------------------------------------------------------------------------
// `saldo_akun_periode` is keyed (periode, cabang, akun) and carries no sektor
// and no bidang. migrations/0027 (ADR 0016) added the child table
// `saldo_akun_dimensi_periode` to hold the decomposition, but the closing
// engine does not yet WRITE it, so a CLOSED period still has NO frozen figure
// per sector or per bidang. The only remaining way to produce one is to
// re-derive it from the live ledger, and for PUMK to join out to
// `pumk_proposal.sektor_id`, which is editable master data: a reclassification
// months later would move a historical month's figure. That is invariant 14
// broken for the very report spec 16 scenario 18 exists to check, so report 24
// for RKA PUMK and RKA Non PUMK over a closed period REFUSES with
// `SKEMA_BELUM_LENGKAP`. `metodeRealisasi` asks the DATA rather than the
// schema, so the refusal lifts by itself the day the close starts writing the
// child table.
//
// ---------------------------------------------------------------------------
// NO LEDGER PORT, DELIBERATELY
// ---------------------------------------------------------------------------
// This module writes nothing to the ledger: an RKA is a target, not a
// transaction. A journal port here would be an invitation to hand the engine a
// double that answers for the ledger, which is the one thing
// modules/angsuran's test-support records as having cost this project two
// production defects.
import { canonicalPermission } from "../auth/index";
import {
  DIMENSI_UNTUK_JENIS,
  KUNCI_KONFIGURASI_RKA,
  PERMISSION_RKA,
  POLA_UANG,
  RkaError,
  type BarisRka,
  type BarisRkaInput,
  type BarisRkaVsRealisasi,
  type BuatRevisiInput,
  type BuatRkaInput,
  type DimensiRka,
  type FilterLaporanRka,
  type FilterRka,
  type JenisRka,
  type LaporanRkaVsRealisasi,
  type MetodeRealisasi,
  type Rka,
  type RkaContext,
  type RkaEngine,
  type RkaEngineDeps,
  type RkaLengkap,
  type RkaTx,
  type SetujuiRkaInput,
  type SimpanBarisRkaInput,
  type SumberPeriode,
  type SumberRealisasi,
  type Uang,
} from "./contract";
import {
  petakanKesalahanDb,
  tolak,
  tolakIzinBelumTerdaftar,
  tolakKonfigurasi,
} from "./kesalahan";
import {
  buatRepoRka,
  type BarisRkaRow,
  type DimensiRow,
  type PeriodeRow,
  type RkaRow,
  type RepoRka,
} from "./repo";
import { keSen, persenCapaian, sen, tambah, uangDariDb } from "./uang";

/** Accounts a budget line may name. Spec 9.3: expense budgets and revenue targets. */
const TIPE_AKUN_DAPAT_DIANGGARKAN = new Set(["BEBAN", "PENDAPATAN"]);

interface BarisSiap {
  akunId: string | null;
  sektorId: string | null;
  bidangId: string | null;
  uraian: string;
  bulan: number | null;
  jumlahAnggaran: Uang;
  jumlahUnit: number | null;
  keterangan: string | null;
}

interface BulanJendela {
  tahun: number;
  bulan: number;
}

export function buatEngineRka(deps: RkaEngineDeps): RkaEngine {
  const { db } = deps;
  const audit = deps.audit;
  const jam = deps.jam ?? (() => new Date());
  const repo: RepoRka = buatRepoRka();

  // --- authorisation -------------------------------------------------------

  /**
   * Spec 2: "Sistem harus menolak, bukan hanya menyembunyikan tombol."
   *
   * A code the shipped catalogue does not know FAILS CLOSED with its own error
   * rather than falling through to a check nobody can satisfy: an unresolvable
   * code is a configuration fault, and reporting it as TIDAK_BERWENANG would
   * make it look like a policy decision and hide it forever. That mechanism has
   * found five real gaps in this repository, two of them this module's own.
   */
  function wajibIzin(ctx: RkaContext, kode: string): void {
    const kanonik = canonicalPermission(kode);
    if (!kanonik) throw tolakIzinBelumTerdaftar(kode);
    if (!ctx.permissions.includes(kanonik)) throw tolak("TIDAK_BERWENANG", { permission: kanonik });
  }

  /**
   * Spec 2 rule 3, and spec 16 scenario 24: the branch checked is the one the
   * ROW reports, never one taken from the request, so holding a valid id for
   * another branch's budget is not a way in.
   *
   * A consolidated budget (`cabang_id IS NULL`) belongs to the entity rather
   * than to a branch and is therefore not branch-scoped.
   */
  function wajibScope(ctx: RkaContext, cabangId: string | null): void {
    if (cabangId === null) return;
    if (cabangId === ctx.cabangId) return;
    if (ctx.cabangDalamScope?.includes(cabangId)) return;
    throw tolak("CABANG_DILUAR_SCOPE", { cabangId });
  }

  function cabangTerlihat(ctx: RkaContext): string[] {
    return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
  }

  // --- audit ---------------------------------------------------------------

  /**
   * Spec 2 rule 5: every authorisation refusal reaches the log. On the POOL,
   * not on a transaction: the refusal aborts whatever it was guarding, and a
   * row written inside the doomed transaction would roll back with it, leaving
   * no record that the attempt happened.
   *
   * The sink is optional (the engine must be constructible with a database and
   * nothing else) and a refusal never depends on one being wired, so a failure
   * to log must not turn a rejection into something else.
   */
  async function catatTolakan(
    ctx: RkaContext,
    aksi: string,
    err: RkaError,
    entitasId: string | null,
  ): Promise<void> {
    if (!audit) return;
    try {
      await audit.record({
        userId: ctx.userId,
        aksi,
        entitas: "rka",
        entitasId,
        hasil: "DITOLAK",
        keterangan: `${err.kode}: ${err.message}`,
      });
    } catch {
      // A broken audit sink must not convert a refusal into a success or into
      // a different error. The refusal itself is re-thrown by the caller.
    }
  }

  async function catatSukses(
    tx: RkaTx,
    ctx: RkaContext,
    aksi: string,
    entitasId: string,
    keterangan: string,
    nilaiBaru?: unknown,
  ): Promise<void> {
    if (!audit) return;
    await audit.record(
      {
        userId: ctx.userId,
        aksi,
        entitas: "rka",
        entitasId,
        hasil: "SUKSES",
        keterangan,
        nilaiBaru,
      },
      tx,
    );
  }

  /**
   * Runs `fn`, logging any `RkaError` it raises as a refusal.
   *
   * Wrapping the WHOLE operation rather than only the permission check is
   * deliberate: a scope refusal and a state refusal are both things somebody
   * reconstructing an attempt needs to see, and spec 2 rule 1's "the system
   * must refuse, not merely hide the button" is about the record as much as
   * about the outcome.
   */
  async function jalankan<T>(
    ctx: RkaContext,
    aksi: string,
    entitasId: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof RkaError ? e : petakanKesalahanDb(e);
      if (err) {
        await catatTolakan(ctx, aksi, err, entitasId);
        throw err;
      }
      throw e;
    }
  }

  // --- configuration -------------------------------------------------------

  async function konfigurasiWajib(
    tx: RkaTx,
    ctx: RkaContext,
    kunci: { grup: string; kunci: string },
  ): Promise<string> {
    const nilai = await repo.konfigurasi(tx, ctx.bumnId, kunci.grup, kunci.kunci);
    if (nilai === null || nilai.trim() === "") {
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_ADA", kunci.grup, kunci.kunci);
    }
    return nilai.trim();
  }

  async function bulanMulaiTahunBuku(tx: RkaTx, ctx: RkaContext): Promise<number> {
    const mentah = await konfigurasiWajib(tx, ctx, KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN);
    const nilai = Number.parseInt(mentah, 10);
    if (!Number.isInteger(nilai) || nilai < 1 || nilai > 12) {
      throw tolakKonfigurasi(
        "KONFIGURASI_TIDAK_VALID",
        KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN.grup,
        KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN.kunci,
        "harus bilangan bulat 1 sampai 12",
      );
    }
    return nilai;
  }

  async function pemisahanTugasAktif(tx: RkaTx, ctx: RkaContext): Promise<boolean> {
    const mentah = (
      await konfigurasiWajib(tx, ctx, KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN)
    ).toLowerCase();
    if (mentah === "true") return true;
    if (mentah === "false") return false;
    throw tolakKonfigurasi(
      "KONFIGURASI_TIDAK_VALID",
      KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN.grup,
      KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN.kunci,
      "harus true atau false",
    );
  }

  // --- shapes --------------------------------------------------------------

  function keRka(row: RkaRow): Rka {
    return {
      id: row.id,
      bumnId: row.bumn_id,
      cabangId: row.cabang_id,
      tahun: row.tahun,
      jenis: row.jenis,
      status: row.status,
      versi: row.versi,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      keterangan: row.keterangan,
      createdBy: row.created_by,
      // DERIVED, not stored: migrations/0012 has no `versi_sebelumnya` column,
      // and it does not need one. `REVISI_MASIH_TERBUKA` forbids a second open
      // draft for a scope, so versions are strictly sequential and version n
      // was revised from version n-1. Storing it would be a second source of
      // truth for a fact the version number already carries.
      versiSebelumnya: row.versi > 1 ? row.versi - 1 : null,
    };
  }

  function keBaris(row: BarisRkaRow): BarisRka {
    return {
      id: row.id,
      rkaId: row.rka_id,
      akunId: row.akun_id,
      sektorId: row.sektor_id,
      bidangId: row.bidang_id,
      uraian: row.uraian,
      bulan: row.bulan,
      jumlahAnggaran: uangDariDb(row.jumlah_anggaran),
      jumlahUnit: row.jumlah_unit,
      keterangan: row.keterangan,
    };
  }

  async function bacaLengkap(tx: RkaTx, row: RkaRow): Promise<RkaLengkap> {
    const baris = (await repo.barisRka(tx, row.id)).map(keBaris);
    return {
      ...keRka(row),
      baris,
      totalAnggaran: baris.length === 0 ? "0.00" : tambah(...baris.map((b) => b.jumlahAnggaran)),
    };
  }

  // --- line validation -----------------------------------------------------

  function dimensiDariBaris(b: BarisRkaInput): { akun: boolean; sektor: boolean; bidang: boolean } {
    return {
      akun: typeof b.akunId === "string" && b.akunId.length > 0,
      sektor: typeof b.sektorId === "string" && b.sektorId.length > 0,
      bidang: typeof b.bidangId === "string" && b.bidangId.length > 0,
    };
  }

  /**
   * Validates the WHOLE grid before a single row is written.
   *
   * A budget line filed against the wrong dimension is invisible to the report
   * that should show it and absent from every other one: the money is
   * budgeted, the entry screen's total is right, and nothing anywhere
   * reconciles it. So the engine refuses FIRST and
   * `trg_rka_detail_10_dimensi` stays as the last line of defence, never as
   * the thing an operator hears from.
   */
  async function siapkanBaris(
    tx: RkaTx,
    ctx: RkaContext,
    jenis: JenisRka,
    baris: readonly BarisRkaInput[],
  ): Promise<BarisSiap[]> {
    const dimensi = DIMENSI_UNTUK_JENIS[jenis];
    const siap: BarisSiap[] = [];
    const terpakai = new Set<string>();

    for (const b of baris) {
      const ada = dimensiDariBaris(b);
      const benar = dimensi === "AKUN" ? ada.akun : dimensi === "SEKTOR" ? ada.sektor : ada.bidang;
      // Exactly one dimension, and it must be the one the budget type calls
      // for. A row carrying two would be counted by two different reports.
      const jumlahDimensi = Number(ada.akun) + Number(ada.sektor) + Number(ada.bidang);
      if (!benar || jumlahDimensi !== 1) {
        throw tolak("DIMENSI_TIDAK_SESUAI_JENIS", { jenis, dimensi, uraian: b.uraian });
      }

      if (b.bulan !== null && b.bulan !== undefined) {
        if (!Number.isInteger(b.bulan) || b.bulan < 1 || b.bulan > 12) {
          throw tolak("BULAN_TIDAK_VALID", { bulan: b.bulan });
        }
      }

      if (typeof b.jumlahAnggaran !== "string" || !POLA_UANG.test(b.jumlahAnggaran)) {
        throw tolak("NILAI_BUKAN_DESIMAL", { jumlahAnggaran: b.jumlahAnggaran });
      }
      if (keSen(b.jumlahAnggaran) < 0n) {
        throw tolak("NILAI_NEGATIF", { jumlahAnggaran: b.jumlahAnggaran });
      }

      const unit = b.jumlahUnit ?? null;
      if (unit !== null && (!Number.isInteger(unit) || unit < 0)) {
        throw tolak("UNIT_TIDAK_VALID", { jumlahUnit: unit });
      }

      const dimensiId = (dimensi === "AKUN" ? b.akunId : dimensi === "SEKTOR" ? b.sektorId : b.bidangId) as string;
      // Two lines for the same dimension and the same month would be summed
      // silently by the report, so the grid says which one it meant.
      const kunciBaris = `${dimensiId}|${b.bulan ?? "null"}`;
      if (terpakai.has(kunciBaris)) {
        throw tolak("BARIS_DUPLIKAT", { dimensiId, bulan: b.bulan ?? null });
      }
      terpakai.add(kunciBaris);

      siap.push({
        akunId: dimensi === "AKUN" ? dimensiId : null,
        sektorId: dimensi === "SEKTOR" ? dimensiId : null,
        bidangId: dimensi === "BIDANG" ? dimensiId : null,
        uraian: b.uraian,
        bulan: b.bulan ?? null,
        jumlahAnggaran: b.jumlahAnggaran,
        jumlahUnit: unit,
        keterangan: b.keterangan ?? null,
      });
    }

    await wajibDimensiAda(tx, ctx, dimensi, siap);
    return siap;
  }

  /**
   * The dimension must exist AND belong to this bumn.
   *
   * A foreign key alone would accept another tenant's sector: the row would be
   * stored, the entry screen would show it, and it would never appear in a
   * report, because every report filters by bumn.
   */
  async function wajibDimensiAda(
    tx: RkaTx,
    ctx: RkaContext,
    dimensi: DimensiRka,
    baris: readonly BarisSiap[],
  ): Promise<void> {
    if (dimensi === "AKUN") {
      const ids = [...new Set(baris.map((b) => b.akunId as string))];
      const akun = await repo.akun(tx, ctx.bumnId, ids);
      const peta = new Map(akun.map((a) => [a.id, a]));
      for (const id of ids) {
        const a = peta.get(id);
        if (!a) throw tolak("AKUN_TIDAK_DITEMUKAN", { akunId: id });
        // Spec 9.3: "anggaran per akun beban dan target pendapatan". Report 24
        // compares a budget against a PERIOD MOVEMENT, and a balance-sheet
        // account's movement is not an achievement against a target, so
        // budgeting cash produces a percentage that reads as performance and
        // means nothing.
        if (!TIPE_AKUN_DAPAT_DIANGGARKAN.has(a.tipe) || !a.is_postable) {
          throw tolak("AKUN_TIDAK_DAPAT_DIANGGARKAN", { akunId: id, tipe: a.tipe });
        }
      }
      return;
    }

    if (dimensi === "SEKTOR") {
      const ids = [...new Set(baris.map((b) => b.sektorId as string))];
      const ada = new Set((await repo.sektor(tx, ctx.bumnId, ids)).map((s) => s.id));
      for (const id of ids) {
        if (!ada.has(id)) throw tolak("SEKTOR_TIDAK_DITEMUKAN", { sektorId: id });
      }
      return;
    }

    const ids = [...new Set(baris.map((b) => b.bidangId as string))];
    const ada = new Set((await repo.bidang(tx, ctx.bumnId, ids)).map((b) => b.id));
    for (const id of ids) {
      if (!ada.has(id)) throw tolak("BIDANG_TIDAK_DITEMUKAN", { bidangId: id });
    }
  }

  async function tulisBaris(
    tx: RkaTx,
    ctx: RkaContext,
    rkaId: string,
    baris: readonly BarisSiap[],
  ): Promise<void> {
    for (const b of baris) await repo.sisipkanBaris(tx, rkaId, b, ctx.userId);
  }

  // --- loading -------------------------------------------------------------

  /**
   * A row from ANOTHER tenant is NOT FOUND, never "out of scope": a different
   * bumn is not "a branch you may not see", and acknowledging that the id
   * exists turns the id itself into a probe.
   */
  async function rkaWajib(tx: RkaTx, rkaId: string, ctx: RkaContext, kunci = false): Promise<RkaRow> {
    const row = kunci
      ? await repo.rkaByIdTerkunci(tx, rkaId)
      : await repo.rkaById(tx, rkaId);
    if (!row || row.bumn_id !== ctx.bumnId) throw tolak("RKA_TIDAK_DITEMUKAN", { rkaId });
    return row;
  }

  // --- report window -------------------------------------------------------

  /**
   * The months report 24 covers, in calendar terms.
   *
   * BULANAN is the single month. KUMULATIF_YTD counts from the first month of
   * the FINANCIAL year, which is configuration and not January: a year that
   * starts in April makes month 4 the first of the cumulation, and a hardcoded
   * January would produce a report that is right for most clients and quietly
   * wrong for the ones who asked for this column. When the reported month falls
   * before the start month, the financial year began in the previous calendar
   * year and the window spans both.
   */
  function jendelaBulan(mode: "BULANAN" | "KUMULATIF_YTD", tahun: number, bulan: number, mulai: number): BulanJendela[] {
    if (mode === "BULANAN") return [{ tahun, bulan }];
    if (bulan >= mulai) {
      const out: BulanJendela[] = [];
      for (let b = mulai; b <= bulan; b += 1) out.push({ tahun, bulan: b });
      return out;
    }
    const out: BulanJendela[] = [];
    for (let b = mulai; b <= 12; b += 1) out.push({ tahun, bulan: b });
    for (let b = 1; b <= bulan; b += 1) out.push({ tahun: tahun + 1, bulan: b });
    return out;
  }

  // --- realisation ---------------------------------------------------------

  interface Agregat {
    nilai: Map<string, bigint>;
    unit: Map<string, number>;
  }

  function kosong(): Agregat {
    return { nilai: new Map(), unit: new Map() };
  }

  function tambahkan(ke: Agregat, dimensiId: string, nilai: bigint, unit: number): void {
    ke.nilai.set(dimensiId, (ke.nilai.get(dimensiId) ?? 0n) + nilai);
    ke.unit.set(dimensiId, (ke.unit.get(dimensiId) ?? 0) + unit);
  }

  /**
   * RKA Keuangan, month by month, each month from the source ITS OWN period
   * status dictates. A cumulative window spanning a closed January and an open
   * February reads January frozen and February live; picking one source for the
   * whole window gives the same total on clean data and diverges silently the
   * first time a frozen figure and a live one disagree.
   *
   * The figure arrives DEBIT-POSITIVE from both sources and is flipped into the
   * account's normal direction here, once: `saldo_akun_periode` is
   * debit-positive for every account type, so reading it straight through would
   * report every revenue target as minus its achievement.
   */
  async function realisasiKeuangan(
    tx: RkaTx,
    ctx: RkaContext,
    cabangIds: readonly string[],
    periode: ReadonlyArray<PeriodeRow>,
  ): Promise<Agregat> {
    const debitPositif = new Map<string, bigint>();
    for (const p of periode) {
      const rows =
        p.status === "CLOSED"
          ? await repo.realisasiAkunBeku(tx, { periodeId: p.id, cabangIds })
          : await repo.realisasiAkunLedger(tx, {
              bumnId: ctx.bumnId,
              cabangIds,
              dari: p.tanggal_mulai,
              sampai: p.tanggal_akhir,
            });
      for (const r of rows) {
        if (!r.dimensi_id) continue;
        debitPositif.set(
          r.dimensi_id,
          (debitPositif.get(r.dimensi_id) ?? 0n) + keSen(uangDariDb(r.nilai)),
        );
      }
    }

    const hasil = kosong();
    if (debitPositif.size === 0) return hasil;
    const akun = await repo.akun(tx, ctx.bumnId, [...debitPositif.keys()]);
    const arah = new Map(akun.map((a) => [a.id, a.saldo_normal]));
    for (const [id, nilai] of debitPositif) {
      hasil.nilai.set(id, arah.get(id) === "K" ? -nilai : nilai);
    }
    return hasil;
  }

  /**
   * RKA PUMK and RKA Non PUMK, over the WHOLE window in one read.
   *
   * Safe to do in one query rather than month by month precisely because a
   * closed period inside the window has already been refused with
   * `SKEMA_BELUM_LENGKAP`: every month here is live, so there is no source to
   * switch between. It also keeps the DISTINCT mitra count honest, which a
   * per-month sum could not be (a partner funded in January and again in
   * February is one partner, not two).
   */
  async function realisasiDimensi(
    tx: RkaTx,
    ctx: RkaContext,
    jenis: JenisRka,
    cabangIds: readonly string[],
    dari: string,
    sampai: string,
  ): Promise<Agregat> {
    const rows =
      jenis === "PUMK"
        ? await repo.realisasiSektorLedger(tx, { bumnId: ctx.bumnId, cabangIds, dari, sampai })
        : await repo.realisasiBidangLedger(tx, { bumnId: ctx.bumnId, cabangIds, dari, sampai });
    const hasil = kosong();
    for (const r of rows) {
      if (!r.dimensi_id) continue;
      tambahkan(
        hasil,
        r.dimensi_id,
        keSen(uangDariDb(r.nilai)),
        r.unit ? Number.parseInt(r.unit, 10) : 0,
      );
    }
    return hasil;
  }

  async function namaDimensi(
    tx: RkaTx,
    ctx: RkaContext,
    dimensi: DimensiRka,
    ids: readonly string[],
  ): Promise<Map<string, DimensiRow>> {
    const rows =
      dimensi === "AKUN"
        ? await repo.akunUntukLaporan(tx, ctx.bumnId, ids)
        : dimensi === "SEKTOR"
          ? await repo.sektor(tx, ctx.bumnId, ids)
          : await repo.bidang(tx, ctx.bumnId, ids);
    return new Map(rows.map((r) => [r.id, r]));
  }

  // -------------------------------------------------------------------------
  // The engine
  // -------------------------------------------------------------------------

  return {
    async buatRka(input: BuatRkaInput, ctx: RkaContext): Promise<RkaLengkap> {
      return jalankan(ctx, "rka.buat", null, () =>
        db.transaction(async (tx) => {
          wajibIzin(ctx, PERMISSION_RKA.KELOLA);
          wajibScope(ctx, input.cabangId);
          if (!Number.isInteger(input.tahun) || input.tahun < 1900 || input.tahun > 2200) {
            throw tolak("TAHUN_TIDAK_VALID", { tahun: input.tahun });
          }

          // The WHOLE grid is validated before a single row is written, so a
          // rejected budget leaves no header behind: a guard that raises after
          // writing is indistinguishable from no guard once the transaction
          // commits, and half a budget is worse than none.
          const baris = await siapkanBaris(tx, ctx, input.jenis, input.baris ?? []);

          const rkaId = await repo.sisipkanRka(tx, {
            bumnId: ctx.bumnId,
            cabangId: input.cabangId,
            tahun: input.tahun,
            jenis: input.jenis,
            versi: 1,
            keterangan: input.keterangan ?? null,
            userId: ctx.userId,
          });
          await tulisBaris(tx, ctx, rkaId, baris);

          const row = await rkaWajib(tx, rkaId, ctx);
          const hasil = await bacaLengkap(tx, row);
          await catatSukses(tx, ctx, "rka.buat", rkaId, `RKA ${input.jenis} ${input.tahun} versi 1`, {
            jenis: input.jenis,
            tahun: input.tahun,
            totalAnggaran: hasil.totalAnggaran,
          });
          return hasil;
        }),
      );
    },

    async simpanBaris(input: SimpanBarisRkaInput, ctx: RkaContext): Promise<RkaLengkap> {
      return jalankan(ctx, "rka.simpan_baris", input.rkaId, () =>
        db.transaction(async (tx) => {
          wajibIzin(ctx, PERMISSION_RKA.KELOLA);
          const row = await rkaWajib(tx, input.rkaId, ctx, true);
          wajibScope(ctx, row.cabang_id);
          // Spec 9.3: a change makes a NEW version. An approved baseline is
          // immutable and a superseded one is history, and editable history is
          // worse than no history: it is the evidence for every report printed
          // while it was in force.
          if (row.status !== "DRAFT") {
            throw tolak("RKA_SUDAH_DISETUJUI", { rkaId: row.id, status: row.status });
          }

          const baris = await siapkanBaris(tx, ctx, row.jenis, input.baris);
          await repo.hapusBaris(tx, row.id, ctx.userId);
          await tulisBaris(tx, ctx, row.id, baris);
          // The segregation control asks who touched the grid LAST, so the
          // editor is recorded even when the creator is somebody else.
          await repo.tandaiDiedit(tx, row.id, ctx.userId);

          const sesudah = await rkaWajib(tx, row.id, ctx);
          const hasil = await bacaLengkap(tx, sesudah);
          await catatSukses(
            tx,
            ctx,
            "rka.simpan_baris",
            row.id,
            `Baris RKA diganti, ${baris.length} baris`,
            { totalAnggaran: hasil.totalAnggaran },
          );
          return hasil;
        }),
      );
    },

    async setujuiRka(input: SetujuiRkaInput, ctx: RkaContext): Promise<Rka> {
      return jalankan(ctx, "rka.setujui", input.rkaId, () =>
        db.transaction(async (tx) => {
          wajibIzin(ctx, PERMISSION_RKA.SETUJUI);
          const row = await rkaWajib(tx, input.rkaId, ctx, true);
          wajibScope(ctx, row.cabang_id);
          if (row.status !== "DRAFT") {
            throw tolak("RKA_BUKAN_DRAFT", { rkaId: row.id, status: row.status });
          }

          // POLICY IS DATA. Whether one person may draft and approve the annual
          // budget is the client's decision, read from configuration, never a
          // literal here. Both directions are real behaviour.
          if (await pemisahanTugasAktif(tx, ctx)) {
            if (row.created_by === ctx.userId || row.updated_by === ctx.userId) {
              throw tolak("KONFLIK_MAKER_APPROVER", {
                rkaId: row.id,
                createdBy: row.created_by,
                updatedBy: row.updated_by,
              });
            }
          }

          // DEMOTE FIRST, PROMOTE SECOND, in ONE transaction. `rka_baseline_uq`
          // is a partial unique index over `status = 'DISETUJUI'`, so the two
          // cannot both be approved even for an instant; this ordering is not a
          // preference and the reverse would raise BASELINE_GANDA.
          const baselineLama = await repo.rkaByStatus(
            tx,
            {
              bumnId: row.bumn_id,
              cabangId: row.cabang_id,
              tahun: row.tahun,
              jenis: row.jenis,
            },
            "DISETUJUI",
          );
          if (baselineLama && baselineLama.id !== row.id) {
            await repo.turunkanKeRevisi(tx, baselineLama.id);
          }

          const saatIni = (input.tanggal ? new Date(input.tanggal) : jam()).toISOString();
          const berhasil = await repo.tandaiDisetujui(tx, row.id, ctx.userId, saatIni);
          if (!berhasil) throw tolak("RKA_BUKAN_DRAFT", { rkaId: row.id });

          const sesudah = await rkaWajib(tx, row.id, ctx);
          await catatSukses(
            tx,
            ctx,
            "rka.setujui",
            row.id,
            input.catatan ?? `RKA ${row.jenis} ${row.tahun} versi ${row.versi} disetujui`,
            { versi: row.versi, baselineLama: baselineLama?.id ?? null },
          );
          return keRka(sesudah);
        }),
      );
    },

    async buatRevisi(input: BuatRevisiInput, ctx: RkaContext): Promise<RkaLengkap> {
      return jalankan(ctx, "rka.revisi", input.rkaId, () =>
        db.transaction(async (tx) => {
          wajibIzin(ctx, PERMISSION_RKA.KELOLA);
          const sumber = await rkaWajib(tx, input.rkaId, ctx, true);
          wajibScope(ctx, sumber.cabang_id);
          // A DRAFT is simply edited. Allowing a revision of one would produce
          // a second unapproved version for the same scope, and then two
          // candidates where spec 9.3 expects one baseline and one open
          // revision.
          if (sumber.status !== "DISETUJUI") {
            throw tolak("REVISI_HARUS_DARI_DISETUJUI", { rkaId: sumber.id, status: sumber.status });
          }

          const kunciScope = {
            bumnId: sumber.bumn_id,
            cabangId: sumber.cabang_id,
            tahun: sumber.tahun,
            jenis: sumber.jenis,
          };
          const draftTerbuka = await repo.rkaByStatus(tx, kunciScope, "DRAFT");
          if (draftTerbuka) {
            throw tolak("REVISI_MASIH_TERBUKA", { rkaId: draftTerbuka.id, versi: draftTerbuka.versi });
          }

          const versi = (await repo.versiTertinggi(tx, kunciScope)) + 1;
          const rkaId = await repo.sisipkanRka(tx, {
            ...kunciScope,
            versi,
            keterangan: input.keterangan ?? null,
            userId: ctx.userId,
          });

          // THE SOURCE VERSION IS NOT TOUCHED: still DISETUJUI, still the
          // baseline, still carrying its own rows with their own ids, until the
          // new version is approved. The copies are NEW rows, so a later edit
          // of the revision cannot reach back into what was in force.
          if (input.salinBaris !== false) {
            const asal = await repo.barisRka(tx, sumber.id);
            for (const b of asal) {
              await repo.sisipkanBaris(
                tx,
                rkaId,
                {
                  akunId: b.akun_id,
                  sektorId: b.sektor_id,
                  bidangId: b.bidang_id,
                  uraian: b.uraian,
                  bulan: b.bulan,
                  jumlahAnggaran: uangDariDb(b.jumlah_anggaran),
                  jumlahUnit: b.jumlah_unit,
                  keterangan: b.keterangan,
                },
                ctx.userId,
              );
            }
          }

          const row = await rkaWajib(tx, rkaId, ctx);
          const hasil = await bacaLengkap(tx, row);
          await catatSukses(
            tx,
            ctx,
            "rka.revisi",
            rkaId,
            `Revisi RKA ${sumber.jenis} ${sumber.tahun}: versi ${sumber.versi} -> ${versi}`,
            { dariVersi: sumber.versi, keVersi: versi },
          );
          return hasil;
        }),
      );
    },

    async daftarRka(filter: FilterRka, ctx: RkaContext): Promise<Rka[]> {
      return jalankan(ctx, "rka.daftar", null, async () => {
        wajibIzin(ctx, PERMISSION_RKA.LIHAT);
        const rows = await repo.daftarRka(db, ctx.bumnId, cabangTerlihat(ctx), {
          tahun: filter.tahun ?? null,
          jenis: filter.jenis ?? null,
          status: filter.status ?? null,
          ...(filter.cabangId !== undefined ? { cabangId: filter.cabangId } : {}),
        });
        return rows.map(keRka);
      });
    },

    async bacaRka(rkaId: string, ctx: RkaContext): Promise<RkaLengkap> {
      return jalankan(ctx, "rka.baca", rkaId, async () => {
        wajibIzin(ctx, PERMISSION_RKA.LIHAT);
        const row = await rkaWajib(db, rkaId, ctx);
        // Spec 16 scenario 24: the branch checked is the one the ROW reports.
        wajibScope(ctx, row.cabang_id);
        return bacaLengkap(db, row);
      });
    },

    async baseline(
      input: { tahun: number; jenis: JenisRka; cabangId: string | null },
      ctx: RkaContext,
    ): Promise<Rka | null> {
      return jalankan(ctx, "rka.baseline", null, async () => {
        wajibIzin(ctx, PERMISSION_RKA.LIHAT);
        wajibScope(ctx, input.cabangId);
        const row = await repo.rkaByStatus(
          db,
          { bumnId: ctx.bumnId, cabangId: input.cabangId, tahun: input.tahun, jenis: input.jenis },
          "DISETUJUI",
        );
        // NULL, never the newest draft. A draft is somebody's proposal, and
        // reporting against it presents an unapproved target as performance.
        return row ? keRka(row) : null;
      });
    },

    async laporanRkaVsRealisasi(
      filter: FilterLaporanRka,
      ctx: RkaContext,
    ): Promise<LaporanRkaVsRealisasi> {
      return jalankan(ctx, "rka.laporan_24", filter.rkaId ?? null, async () => {
        wajibIzin(ctx, PERMISSION_RKA.LAPORAN);
        if (!Number.isInteger(filter.bulan) || filter.bulan < 1 || filter.bulan > 12) {
          throw tolak("BULAN_TIDAK_VALID", { bulan: filter.bulan });
        }
        const cabangFilter = filter.cabangId ?? null;
        // Refused, not emptied. An empty report would look like "that branch
        // spent nothing", which is a wrong answer presented as a right one.
        if (cabangFilter !== null) wajibScope(ctx, cabangFilter);
        const cabangIds = cabangFilter !== null ? [cabangFilter] : cabangTerlihat(ctx);

        const dimensi = DIMENSI_UNTUK_JENIS[filter.jenis];
        const mulaiTahunBuku =
          filter.mode === "KUMULATIF_YTD" ? await bulanMulaiTahunBuku(db, ctx) : filter.bulan;
        const bulanJendela = jendelaBulan(
          filter.mode,
          filter.tahun,
          filter.bulan,
          mulaiTahunBuku,
        );

        // --- which version is being compared against ---------------------
        const kunciScope = {
          bumnId: ctx.bumnId,
          cabangId: cabangFilter,
          tahun: filter.tahun,
          jenis: filter.jenis,
        };
        let rka: RkaRow | null;
        if (filter.rkaId) {
          rka = await rkaWajib(db, filter.rkaId, ctx);
          wajibScope(ctx, rka.cabang_id);
        } else if (filter.versi !== undefined && filter.versi !== null) {
          rka = await repo.rkaByVersi(db, kunciScope, filter.versi);
          // Named and absent is a refusal, never a silent fall back to the
          // baseline: a report headed "versi 7" that compared against versi 2
          // is a wrong answer nobody can see.
          if (!rka) throw tolak("VERSI_TIDAK_DITEMUKAN", { versi: filter.versi });
        } else {
          rka = await repo.rkaByStatus(db, kunciScope, "DISETUJUI");
          if (!rka) throw tolak("BASELINE_TIDAK_ADA", { ...kunciScope, bumnId: undefined });
        }

        // --- which source answers for each month --------------------------
        const periodeRows = await repo.periodeBulan(db, ctx.bumnId, bulanJendela);
        const periodePeta = new Map(periodeRows.map((p) => [`${p.tahun}-${p.bulan}`, p]));
        const periode: PeriodeRow[] = [];
        for (const b of bulanJendela) {
          const p = periodePeta.get(`${b.tahun}-${b.bulan}`);
          if (!p) throw tolak("PERIODE_TIDAK_DITEMUKAN", { tahun: b.tahun, bulan: b.bulan });
          periode.push(p);
        }

        const sumberPerPeriode: SumberPeriode[] = periode.map((p) => ({
          periodeId: p.id,
          tahun: p.tahun,
          bulan: p.bulan,
          statusPeriode: p.status,
          sumber: p.status === "CLOSED" ? "SALDO_AKUN_PERIODE" : "V_LEDGER_BARIS",
        }));

        const adaTertutup = periode.some((p) => p.status === "CLOSED");
        if (adaTertutup && filter.jenis !== "KEUANGAN") {
          // THE REFUSAL, NOT A WORKAROUND. See this file's header: there is no
          // frozen per-sektor or per-bidang figure to read, and re-deriving one
          // from live master data would make a closed month's report change
          // when somebody reclassifies a partner.
          throw tolak("SKEMA_BELUM_LENGKAP", {
            jenis: filter.jenis,
            dimensi,
            periode: periode.filter((p) => p.status === "CLOSED").map((p) => p.id),
          });
        }
        for (const p of periode) {
          if (p.status !== "CLOSED") continue;
          // A closed period whose freeze did not happen is a broken close, not
          // a licence to recompute: recomputing would produce a plausible
          // figure and hide the fact that the trial balance is missing.
          if (!(await repo.adaSaldoBeku(db, p.id))) {
            throw tolak("SALDO_PERIODE_TIDAK_ADA", { periodeId: p.id, tahun: p.tahun, bulan: p.bulan });
          }
        }

        // A row may claim the frozen source only when EVERY month in its window
        // was frozen. A mixed window read half live cannot call itself
        // reproducible.
        const sumberBaris: SumberRealisasi = periode.every((p) => p.status === "CLOSED")
          ? "SALDO_AKUN_PERIODE"
          : "V_LEDGER_BARIS";

        // --- realisation, READ ---------------------------------------------
        const realisasi =
          filter.jenis === "KEUANGAN"
            ? await realisasiKeuangan(db, ctx, cabangIds, periode)
            : await realisasiDimensi(
                db,
                ctx,
                filter.jenis,
                cabangIds,
                periode[0].tanggal_mulai,
                periode[periode.length - 1].tanggal_akhir,
              );

        // --- budget --------------------------------------------------------
        const bulanDalamJendela = new Set(bulanJendela.map((b) => b.bulan));
        const semuaBaris = await repo.barisRka(db, rka.id);
        const idDari = (b: BarisRkaRow): string =>
          (dimensi === "AKUN" ? b.akun_id : dimensi === "SEKTOR" ? b.sektor_id : b.bidang_id) ?? "";
        const dalamJendela = (b: BarisRkaRow): boolean =>
          b.bulan === null
            ? // An annual figure has no month, so it belongs to the year and
              // not to any single one of its months. A monthly report that
              // included it whole would show a twelvefold overrun every month.
              filter.mode === "KUMULATIF_YTD"
            : bulanDalamJendela.has(b.bulan);

        const anggaran = new Map<string, bigint>();
        const unitAnggaran = new Map<string, number>();
        const uraianPer = new Map<string, string[]>();
        // Every dimension the version budgets ANYWHERE appears, even in a month
        // it has no target for: a budget line that vanishes from the report in
        // the months it is not scheduled is a line nobody can find.
        for (const b of semuaBaris) {
          const id = idDari(b);
          if (id === "") continue;
          if (!anggaran.has(id)) anggaran.set(id, 0n);
          if (!dalamJendela(b)) continue;
          anggaran.set(id, (anggaran.get(id) ?? 0n) + keSen(uangDariDb(b.jumlah_anggaran)));
          unitAnggaran.set(id, (unitAnggaran.get(id) ?? 0) + (b.jumlah_unit ?? 0));
          uraianPer.set(id, [...(uraianPer.get(id) ?? []), b.uraian]);
        }

        // --- rows ----------------------------------------------------------
        // Budgeted dimensions UNION dimensions that moved. An inner join onto
        // the budget drops money spent on something nobody budgeted, the totals
        // then understate spending, and the omission is invisible because the
        // report has no independent total to disagree with.
        const semuaId = [...new Set([...anggaran.keys(), ...realisasi.nilai.keys()])];
        const meta = await namaDimensi(db, ctx, dimensi, semuaId);

        const baris: BarisRkaVsRealisasi[] = semuaId
          .map((id) => {
            const info = meta.get(id);
            const nilaiAnggaran = sen(anggaran.get(id) ?? 0n);
            const nilaiRealisasi = sen(realisasi.nilai.get(id) ?? 0n);
            const uraianList = uraianPer.get(id) ?? [];
            return {
              dimensi,
              dimensiId: id,
              dimensiKode: info?.kode ?? "",
              dimensiNama: info?.nama ?? "",
              // One budget line in the window names itself; several rolled into
              // one row are named by the dimension they roll up to.
              uraian: uraianList.length === 1 ? uraianList[0] : (info?.nama ?? ""),
              anggaran: nilaiAnggaran,
              realisasi: nilaiRealisasi,
              selisih: sen(keSen(nilaiAnggaran) - keSen(nilaiRealisasi)),
              persenCapaian: persenCapaian(nilaiRealisasi, nilaiAnggaran),
              unitAnggaran: filter.jenis === "PUMK" ? (unitAnggaran.get(id) ?? 0) : null,
              unitRealisasi: filter.jenis === "PUMK" ? (realisasi.unit.get(id) ?? 0) : null,
              sumberRealisasi: sumberBaris,
              dianggarkan: anggaran.has(id),
            };
          })
          // Budgeted lines first, then spending nobody budgeted, each by code.
          // A budget report is read down its own budget; the unbudgeted tail is
          // an exception list and belongs under it rather than interleaved.
          .sort((a, b) => {
            if (a.dianggarkan !== b.dianggarkan) return a.dianggarkan ? -1 : 1;
            return a.dimensiKode.localeCompare(b.dimensiKode);
          })
          .map(({ dianggarkan: _dianggarkan, ...sisa }) => sisa);

        const totalAnggaran =
          baris.length === 0 ? "0.00" : tambah(...baris.map((b) => b.anggaran));
        const totalRealisasi =
          baris.length === 0 ? "0.00" : tambah(...baris.map((b) => b.realisasi));

        return {
          rkaId: rka.id,
          jenis: rka.jenis,
          dimensi,
          tahun: rka.tahun,
          versi: rka.versi,
          statusRka: rka.status,
          cabangId: cabangFilter,
          mode: filter.mode,
          dariBulan: filter.mode === "BULANAN" ? filter.bulan : mulaiTahunBuku,
          sampaiBulan: filter.bulan,
          baris,
          total: {
            anggaran: totalAnggaran,
            realisasi: totalRealisasi,
            selisih: sen(keSen(totalAnggaran) - keSen(totalRealisasi)),
            // Computed from the TOTALS, not averaged over the rows: the average
            // of the rows' percentages is a different and wrong number whenever
            // the budgets differ in size.
            persenCapaian: persenCapaian(totalRealisasi, totalAnggaran),
            unitAnggaran:
              filter.jenis === "PUMK"
                ? baris.reduce((n, b) => n + (b.unitAnggaran ?? 0), 0)
                : null,
            unitRealisasi:
              filter.jenis === "PUMK"
                ? baris.reduce((n, b) => n + (b.unitRealisasi ?? 0), 0)
                : null,
          },
          sumberPerPeriode,
        };
      });
    },

    async metodeRealisasi(
      input: { periodeId: string; jenis: JenisRka },
      ctx: RkaContext,
    ): Promise<MetodeRealisasi> {
      return jalankan(ctx, "rka.metode_realisasi", input.periodeId, async () => {
        wajibIzin(ctx, PERMISSION_RKA.LAPORAN);
        const p = await repo.periodeById(db, input.periodeId, ctx.bumnId);
        if (!p) throw tolak("PERIODE_TIDAK_DITEMUKAN", { periodeId: input.periodeId });
        if (p.status !== "CLOSED") return "V_LEDGER_BARIS";
        if (input.jenis === "KEUANGAN") return "SALDO_AKUN_PERIODE";
        // The gap, made inspectable rather than only observable as an
        // exception, so a screen can grey the button instead of showing an
        // error after the click. Asked of the DATA: the day modules/closing
        // starts writing `saldo_akun_dimensi_periode`, this answers
        // SALDO_AKUN_PERIODE without a second change here.
        const sumbu = input.jenis === "PUMK" ? "SEKTOR" : "BIDANG";
        return (await repo.adaSaldoBekuDimensi(db, p.id, sumbu))
          ? "SALDO_AKUN_PERIODE"
          : "TIDAK_TERSEDIA";
      });
    },
  };
}
