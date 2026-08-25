// apps/api/src/modules/closing/service.ts
//
// The closing engine (spec 8). Private to the module; ./index.ts is the only
// door in, and ./contract.ts is the shape the tests in this folder were written
// against before a line of this file existed.
//
// -------------------------------------------------------------------------
// THE ONE THING THIS FILE MUST NOT GET WRONG
// -------------------------------------------------------------------------
// `saldo_akun_periode` is FROZEN at close, and every past-period report reads
// it instead of recomputing (invariant 14). It is therefore computed from
// `v_ledger_baris` (`status IN ('POSTED','REVERSED')`) and NEVER from
// `status = 'POSTED'` alone. See ./repo.ts `saldoAkunUntukPeriode`, ADR 0010
// and migrations/0018, which names this module.
//
// -------------------------------------------------------------------------
// POLICY IS DATA
// -------------------------------------------------------------------------
// There is not one classification threshold or allowance rate in this file.
// Day bands come from `kolektibilitas_range`, rates from `penyisihan_rate` or
// from collection history, the recognition method and the accrual population
// from `konfigurasi`. A missing row is a REFUSAL, never a literal fallback: a
// defaulted rate is a wrong number in a client's audited accounts that nobody
// can trace back to a decision.
//
// -------------------------------------------------------------------------
// INVARIANT 11
// -------------------------------------------------------------------------
// Every journal here goes through `PorterJurnalClosing.postingEvent`, so the
// ACCOUNTS come from `event_jurnal_mapping` and never from this module. There
// is no write-off path, deliberately: closing MEASURES the allowance, it never
// spends it. Reading `saldoPenyisihanAwal` from the LEDGER is what keeps a
// write-off somebody else performed visible in the next period's requirement.
import {
  ClosingError,
  EVENT_CLOSING,
  KUNCI_KONFIGURASI_CLOSING,
  PERMISSION_CLOSING,
  PRASYARAT_CLOSING,
  type BarisAkrual,
  type BarisKolektibilitas,
  type ClosingContext,
  type ClosingEngine,
  type ClosingEngineDeps,
  type ClosingTx,
  type DaftarPrasyarat,
  type DasarPerhitunganPenyisihan,
  type FilterSaldoAkunPeriode,
  type HasilAkrual,
  type HasilKolektibilitas,
  type HasilPrasyarat,
  type HasilTutupPeriode,
  type JalankanAkrualInput,
  type JalankanKolektibilitasInput,
  type JalankanPenyisihanInput,
  type KelasKolektibilitas,
  type KodePrasyarat,
  type KontribusiJurnalPenyisihan,
  type MetodePengakuanJasa,
  type ModePenyisihan,
  type PenyisihanPeriode,
  type PeriodeClosing,
  type PreviewKolektibilitas,
  type Rate,
  type ReopenPeriodeInput,
  type RingkasanKelas,
  type RiwayatRunKolektibilitas,
  type SaldoAkunPeriode,
  type SelKematriks,
  type SumberRate,
  type TutupPeriodeInput,
  type Uang,
} from "./contract";
import { petakanKesalahanDb, tolak, tolakKonfigurasi } from "./kesalahan";
import {
  buatRepoClosing,
  type AkadRow,
  type PeriodeRow,
  type RepoClosing,
  type SaldoRow,
} from "./repo";
import {
  kaliRate,
  keSen,
  kurang,
  negasi,
  nol,
  rateDariDb,
  rateDariMikro,
  tambah,
  uangDariDb,
} from "./uang";
import { canonicalPermission } from "../auth/index";
import type { JurnalContext } from "../jurnal/index";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const URUTAN_KELAS: readonly KelasKolektibilitas[] = [
  "LANCAR",
  "KURANG_LANCAR",
  "DIRAGUKAN",
  "MACET",
];

const NAMA_KELAS: Record<KelasKolektibilitas, string> = {
  LANCAR: "Lancar",
  KURANG_LANCAR: "Kurang Lancar",
  DIRAGUKAN: "Diragukan",
  MACET: "Macet",
};

/** Whole days between two ISO dates, `sampai - dari`. UTC, no local drift. */
function selisihHari(dari: string, sampai: string): number {
  const a = Date.parse(`${dari}T00:00:00.000Z`);
  const b = Date.parse(`${sampai}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw tolak("TANGGAL_TIDAK_VALID", { dari, sampai });
  }
  return Math.round((b - a) / 86_400_000);
}

/** Whole months between two ISO dates, floored. */
function selisihBulan(dari: string, sampai: string): number {
  const [t1, b1, h1] = dari.split("-").map((x) => Number.parseInt(x, 10));
  const [t2, b2, h2] = sampai.split("-").map((x) => Number.parseInt(x, 10));
  let bulan = (t2 - t1) * 12 + (b2 - b1);
  if (h2 < h1) bulan -= 1;
  return bulan;
}

function tambahBulan(iso: string, bulan: number): string {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  const total = b - 1 + bulan;
  const tahunBaru = t + Math.floor(total / 12);
  const bulanBaru = ((total % 12) + 12) % 12;
  const hariTerakhir = new Date(Date.UTC(tahunBaru, bulanBaru + 1, 0)).getUTCDate();
  const hari = Math.min(h, hariTerakhir);
  return `${tahunBaru}-${String(bulanBaru + 1).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;
}

function labelPeriode(p: { tahun: number; bulan: number }): string {
  return `${String(p.bulan).padStart(2, "0")}/${p.tahun}`;
}

/** Rupiah, for a message an accountant reads. No currency maths depends on it. */
function rupiah(nilai: Uang): string {
  const negatif = nilai.startsWith("-");
  const [utuh, pecahan] = (negatif ? nilai.slice(1) : nilai).split(".");
  const dikelompokkan = utuh.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negatif ? "-" : ""}Rp ${dikelompokkan},${pecahan}`;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEngineClosing(deps: ClosingEngineDeps): ClosingEngine {
  const { db, jurnal } = deps;
  const audit = deps.audit;
  const jam = deps.jam ?? (() => new Date());
  const repo: RepoClosing = buatRepoClosing();

  // --- authorisation -------------------------------------------------------

  /**
   * Spec 2: "Sistem harus menolak, bukan hanya menyembunyikan tombol."
   *
   * A code the shipped catalogue does not know FAILS CLOSED with its own error
   * rather than falling through to a check nobody can satisfy: an unresolvable
   * code is a configuration fault, and reporting it as TIDAK_BERWENANG would
   * make it look like a policy decision and hide it forever. That mechanism has
   * already found three real gaps (`pumk.cluster`, `nonpumk.lpj.verifikasi`,
   * and `admin.closing.view` from this module).
   */
  function wajibIzin(ctx: ClosingContext, kode: string): void {
    const kanonik = canonicalPermission(kode);
    if (!kanonik) throw tolak("IZIN_BELUM_TERDAFTAR", { permission: kode });
    if (!ctx.permissions.includes(kanonik)) throw tolak("TIDAK_BERWENANG", { permission: kanonik });
  }

  /** Spec 2 rule 3: a user acts on their own branch or one explicitly in scope. */
  function wajibScope(ctx: ClosingContext, cabangId: string): void {
    if (cabangId === ctx.cabangId) return;
    if (ctx.cabangDalamScope?.includes(cabangId)) return;
    throw tolak("CABANG_DILUAR_SCOPE", { cabangId });
  }

  function cabangTerlihat(ctx: ClosingContext): string[] {
    return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
  }

  // --- error translation ---------------------------------------------------

  async function bersihkan<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ClosingError) throw e;
      const dipetakan = petakanKesalahanDb(e);
      if (dipetakan) throw dipetakan;
      throw e;
    }
  }

  /**
   * The ledger refused, so the whole step rolls back. The raw reason stays in
   * `penyebabDb` for the server log; what reaches a caller is the catalogue
   * message, free of trigger codes and constraint names.
   */
  function gagalJurnal(eventCode: string, e: unknown): ClosingError {
    const dipetakan = petakanKesalahanDb(e);
    if (dipetakan) return dipetakan;
    const mentah = e instanceof Error ? e.message : String(e);
    return tolak("JURNAL_GAGAL", { eventCode }, mentah);
  }

  // --- period lookup -------------------------------------------------------

  async function periodeWajib(
    tx: ClosingTx,
    periodeId: string,
    bumnId: string,
  ): Promise<PeriodeRow> {
    const p = await repo.periode(tx, periodeId);
    if (!p || p.bumn_id !== bumnId) throw tolak("PERIODE_TIDAK_DITEMUKAN", { periodeId });
    return p;
  }

  /** `periodeWajib`, but taking the row lock. See `repo.periodeUntukUbah`. */
  async function periodeUntukUbah(
    tx: ClosingTx,
    periodeId: string,
    bumnId: string,
  ): Promise<PeriodeRow> {
    const p = await repo.periodeUntukUbah(tx, periodeId);
    if (!p || p.bumn_id !== bumnId) throw tolak("PERIODE_TIDAK_DITEMUKAN", { periodeId });
    return p;
  }

  function keProfilPeriode(p: PeriodeRow): PeriodeClosing {
    return {
      id: p.id,
      bumnId: p.bumn_id,
      tahun: p.tahun,
      bulan: p.bulan,
      tanggalMulai: p.tanggal_mulai,
      tanggalAkhir: p.tanggal_akhir,
      status: p.status as PeriodeClosing["status"],
      closedBy: p.closed_by,
      closedAt: p.closed_at,
      reopenedBy: p.reopened_by,
      reopenedAt: p.reopened_at,
      alasanReopen: p.alasan_reopen,
    };
  }

  // --- configuration -------------------------------------------------------

  async function konfigWajib(
    tx: ClosingTx,
    bumnId: string,
    kunci: { grup: string; kunci: string },
  ): Promise<string> {
    const nilai = await repo.konfigurasi(tx, bumnId, kunci.grup, kunci.kunci);
    if (nilai === null || nilai.trim() === "") {
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_ADA", kunci.grup, kunci.kunci);
    }
    return nilai.trim();
  }

  async function konfigEnum<T extends string>(
    tx: ClosingTx,
    bumnId: string,
    kunci: { grup: string; kunci: string },
    diizinkan: readonly T[],
  ): Promise<T> {
    const nilai = await konfigWajib(tx, bumnId, kunci);
    if (!(diizinkan as readonly string[]).includes(nilai)) {
      throw tolakKonfigurasi(
        "KONFIGURASI_TIDAK_VALID",
        kunci.grup,
        kunci.kunci,
        `nilai yang dikenal hanya ${diizinkan.join(", ")}`,
      );
    }
    return nilai as T;
  }

  async function konfigBoolean(
    tx: ClosingTx,
    bumnId: string,
    kunci: { grup: string; kunci: string },
  ): Promise<boolean> {
    const nilai = (await konfigWajib(tx, bumnId, kunci)).toLowerCase();
    if (nilai === "true") return true;
    if (nilai === "false") return false;
    throw tolakKonfigurasi(
      "KONFIGURASI_TIDAK_VALID",
      kunci.grup,
      kunci.kunci,
      "nilai yang dikenal hanya true atau false",
    );
  }

  async function konfigBilangan(
    tx: ClosingTx,
    bumnId: string,
    kunci: { grup: string; kunci: string },
  ): Promise<number> {
    const nilai = await konfigWajib(tx, bumnId, kunci);
    const angka = Number.parseInt(nilai, 10);
    if (!Number.isFinite(angka) || angka < 0) {
      throw tolakKonfigurasi(
        "KONFIGURASI_TIDAK_VALID",
        kunci.grup,
        kunci.kunci,
        "nilainya harus bilangan bulat tidak negatif",
      );
    }
    return angka;
  }

  /** Spec 5.6 `akrual_hanya_untuk_kolektibilitas`, a JSON array of classes. */
  async function kelasAkrual(tx: ClosingTx, bumnId: string): Promise<KelasKolektibilitas[]> {
    const mentah = await konfigWajib(tx, bumnId, KUNCI_KONFIGURASI_CLOSING.AKRUAL_HANYA_UNTUK);
    let terurai: unknown;
    try {
      terurai = JSON.parse(mentah);
    } catch {
      throw tolakKonfigurasi(
        "KONFIGURASI_TIDAK_VALID",
        KUNCI_KONFIGURASI_CLOSING.AKRUAL_HANYA_UNTUK.grup,
        KUNCI_KONFIGURASI_CLOSING.AKRUAL_HANYA_UNTUK.kunci,
        "isinya harus daftar kelas kolektibilitas dalam bentuk JSON",
      );
    }
    if (!Array.isArray(terurai) || terurai.some((x) => !URUTAN_KELAS.includes(x as KelasKolektibilitas))) {
      throw tolakKonfigurasi(
        "KONFIGURASI_TIDAK_VALID",
        KUNCI_KONFIGURASI_CLOSING.AKRUAL_HANYA_UNTUK.grup,
        KUNCI_KONFIGURASI_CLOSING.AKRUAL_HANYA_UNTUK.kunci,
        `kelas yang dikenal hanya ${URUTAN_KELAS.join(", ")}`,
      );
    }
    return terurai as KelasKolektibilitas[];
  }

  // --- spec 5.1 / 5.2, the policy tables ----------------------------------

  interface Rentang {
    kelas: KelasKolektibilitas;
    min: number;
    max: number | null;
  }

  async function rentangEfektif(
    tx: ClosingTx,
    bumnId: string,
    padaTanggal: string,
  ): Promise<Rentang[]> {
    const rows = await repo.rangeKolektibilitas(tx, bumnId, padaTanggal);
    // Effective dating (migrations/0004): the row with the greatest
    // `berlaku_dari` on or before the period end, so changing a band today
    // cannot move a closed period's classification.
    const terpilih = new Map<KelasKolektibilitas, Rentang>();
    for (const r of rows) {
      terpilih.set(r.kelas_kode, { kelas: r.kelas_kode, min: r.hari_min, max: r.hari_max });
    }
    const daftar = [...terpilih.values()].sort((a, b) => a.min - b.min);
    if (daftar.length === 0) {
      throw tolak("RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP", { padaTanggal, jumlahRentang: 0 });
    }
    // Ambiguity is a refusal, not a race: migrations/0004 deliberately leaves
    // overlap unconstrained so the config screen can pass through a half-edited
    // state, which means the engine is the thing that has to notice.
    for (let i = 0; i < daftar.length; i += 1) {
      for (let j = i + 1; j < daftar.length; j += 1) {
        const a = daftar[i];
        const b = daftar[j];
        const aMax = a.max ?? Number.MAX_SAFE_INTEGER;
        const bMax = b.max ?? Number.MAX_SAFE_INTEGER;
        if (a.min <= bMax && b.min <= aMax) {
          throw tolak("RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH", {
            kelas: [a.kelas, b.kelas],
            rentang: [
              { kelas: a.kelas, hariMin: a.min, hariMax: a.max },
              { kelas: b.kelas, hariMin: b.min, hariMax: b.max },
            ],
          });
        }
      }
    }
    return daftar;
  }

  function klasifikasi(daftar: readonly Rentang[], hari: number): KelasKolektibilitas {
    for (const r of daftar) {
      if (hari >= r.min && (r.max === null || hari <= r.max)) return r.kelas;
    }
    // Defaulting to LANCAR here would mark a 200-day arrears as performing and
    // provision it at zero, and nothing downstream would ever disagree.
    throw tolak("RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP", {
      hariTunggakan: hari,
      rentang: daftar.map((r) => ({ kelas: r.kelas, hariMin: r.min, hariMax: r.max })),
    });
  }

  interface SumberRateHasil {
    rate: Map<KelasKolektibilitas, Rate>;
    sumber: SumberRate;
    historiDari: string | null;
    historiSampai: string | null;
  }

  async function rateEfektif(
    tx: ClosingTx,
    bumnId: string,
    padaTanggal: string,
    mode: ModePenyisihan,
  ): Promise<SumberRateHasil> {
    if (mode === "RATE_TABLE") {
      const rows = await repo.ratePenyisihan(tx, bumnId, padaTanggal);
      const rate = new Map<KelasKolektibilitas, Rate>();
      for (const r of rows) rate.set(r.kelas_kode, rateDariDb(r.rate));
      return { rate, sumber: "TABEL_KONFIGURASI", historiDari: null, historiSampai: null };
    }

    // KOLEKTIF_HISTORIS. docs/BUILD-PLAN.md requires this as a CAPABILITY, and
    // docs/REGULASI.md finding 3 is why: audited PUMK statements impair
    // collectively from collection history rather than from the spec's rate
    // table. The METHODOLOGY itself is still the client accounting team's to
    // confirm (OPEN-QUESTIONS), so what is implemented here is the plainest
    // reading of "collective impairment from collection history": of everything
    // that fell due inside the window on akads carrying a class, the share that
    // was never collected.
    const minBulan = await konfigBilangan(tx, bumnId, KUNCI_KONFIGURASI_CLOSING.MIN_BULAN_HISTORI);
    const awal = await repo.awalHistori(tx, bumnId, padaTanggal);
    const tersedia = awal === null ? 0 : selisihBulan(awal, padaTanggal);
    if (tersedia < minBulan) {
      // Quietly falling back to the rate table would report a collectively
      // impaired allowance that was in fact a rate table, in a period an
      // auditor will later ask about.
      throw tolak("HISTORI_TIDAK_CUKUP", {
        bulanTersedia: tersedia,
        bulanMinimum: minBulan,
        historiMulai: awal,
      });
    }
    const dari = tambahBulan(padaTanggal, -minBulan);
    const baris = await repo.kolektifHistoris(tx, { bumnId, dari, sampai: padaTanggal });
    const rate = new Map<KelasKolektibilitas, Rate>();
    for (const b of baris) {
      const jatuhTempo = keSen(uangDariDb(b.jatuh_tempo));
      if (jatuhTempo <= 0n) continue;
      const tertagih = keSen(uangDariDb(b.tertagih));
      const gagalMikro = ((jatuhTempo - tertagih) * 1_000_000n) / jatuhTempo;
      rate.set(b.kelas, rateDariMikro(gagalMikro));
    }
    return { rate, sumber: "KOLEKTIF_HISTORIS", historiDari: dari, historiSampai: padaTanggal };
  }

  // --- spec 8.1, the calculation ------------------------------------------

  interface CakupanCabang {
    /** null = every branch in scope at once (spec 8.1 opening line). */
    cabangId: string | null;
    daftar: string[];
  }

  async function cakupan(
    tx: ClosingTx,
    ctx: ClosingContext,
    diminta: string | null | undefined,
  ): Promise<CakupanCabang> {
    const milikBumn = new Set((await repo.cabangBumn(tx, ctx.bumnId)).map((c) => c.id));
    if (diminta) {
      wajibScope(ctx, diminta);
      if (!milikBumn.has(diminta)) throw tolak("CABANG_TIDAK_DITEMUKAN", { cabangId: diminta });
      return { cabangId: diminta, daftar: [diminta] };
    }
    // "Semua cabang sekaligus" means every branch IN SCOPE, not every branch in
    // the database: a branch Approver choosing the all-branches option must not
    // quietly become a cross-branch read (spec 2 rule 3).
    const daftar = cabangTerlihat(ctx).filter((id) => milikBumn.has(id));
    if (daftar.length === 0) throw tolak("CABANG_TIDAK_DITEMUKAN", { cabangId: ctx.cabangId });
    return { cabangId: daftar.length === 1 ? daftar[0] : null, daftar };
  }

  interface HitunganKolektibilitas {
    periode: PeriodeRow;
    cakupan: CakupanCabang;
    mode: ModePenyisihan;
    dasar: DasarPerhitunganPenyisihan;
    sumberRate: SumberRate;
    historiDari: string | null;
    historiSampai: string | null;
    baris: BarisKolektibilitas[];
    matriks: SelKematriks[];
    ringkasan: RingkasanKelas[];
    total: Uang;
    akadRow: Map<string, AkadRow>;
  }

  async function hitungKolektibilitas(
    tx: ClosingTx,
    input: JalankanKolektibilitasInput,
    ctx: ClosingContext,
  ): Promise<HitunganKolektibilitas> {
    const periode = await periodeWajib(tx, input.periodeId, ctx.bumnId);
    const lingkup = await cakupan(tx, ctx, input.cabangId);
    const akhir = periode.tanggal_akhir;

    const dasar = await konfigEnum<DasarPerhitunganPenyisihan>(
      tx,
      ctx.bumnId,
      KUNCI_KONFIGURASI_CLOSING.DASAR_PENYISIHAN,
      ["OUTSTANDING_POKOK", "OUTSTANDING_POKOK_PLUS_JASA"],
    );
    const mode = await konfigEnum<ModePenyisihan>(
      tx,
      ctx.bumnId,
      KUNCI_KONFIGURASI_CLOSING.MODE_PENYISIHAN,
      ["RATE_TABLE", "KOLEKTIF_HISTORIS"],
    );

    const rentang = await rentangEfektif(tx, ctx.bumnId, akhir);
    const rate = await rateEfektif(tx, ctx.bumnId, akhir, mode);

    const akad = await repo.akadPopulasi(tx, ctx.bumnId, lingkup.daftar, akhir);
    const lalu = new Map(
      (await repo.kelasPeriodeLalu(tx, ctx.bumnId, periode.tahun, periode.bulan)).map((r) => [
        r.akad_id,
        r.kolektibilitas,
      ]),
    );

    const baris: BarisKolektibilitas[] = [];
    const akadRow = new Map<string, AkadRow>();
    for (const a of akad) {
      akadRow.set(a.akad_id, a);
      const tanggalTertua = a.tanggal_tertua;
      const hari = tanggalTertua === null ? 0 : Math.max(0, selisihHari(tanggalTertua, akhir));
      const kelas = klasifikasi(rentang, hari);
      const nilaiRate = rate.rate.get(kelas);
      if (!nilaiRate) {
        // Treating a missing rate as zero silently reports the worst part of
        // the portfolio as fully provisioned at nothing.
        throw tolak("RATE_PENYISIHAN_TIDAK_ADA", { kelas, mode });
      }
      const outstandingPokok = uangDariDb(a.outstanding_pokok);
      const outstandingJasa = uangDariDb(a.outstanding_jasa);
      const basis =
        dasar === "OUTSTANDING_POKOK" ? outstandingPokok : tambah(outstandingPokok, outstandingJasa);
      baris.push({
        akadId: a.akad_id,
        noAkad: a.no_akad,
        mitraId: a.mitra_id,
        cabangId: a.cabang_id,
        sektorId: a.sektor_id,
        tanggalJatuhTempoTertunggakTertua: tanggalTertua,
        hariTunggakan: hari,
        kolektibilitas: kelas,
        kolektibilitasPeriodeLalu: lalu.get(a.akad_id) ?? null,
        outstandingPokok,
        outstandingJasa,
        tunggakanPokok: uangDariDb(a.tunggakan_pokok),
        tunggakanJasa: uangDariDb(a.tunggakan_jasa),
        ratePenyisihan: nilaiRate,
        dasarPerhitungan: dasar,
        sumberRate: rate.sumber,
        nilaiPenyisihan: kaliRate(basis, nilaiRate),
      });
    }

    return {
      periode,
      cakupan: lingkup,
      mode,
      dasar,
      sumberRate: rate.sumber,
      historiDari: rate.historiDari,
      historiSampai: rate.historiSampai,
      baris,
      matriks: bangunMatriks(baris),
      ringkasan: bangunRingkasan(baris),
      total: tambah("0.00", ...baris.map((b) => b.nilaiPenyisihan)),
      akadRow,
    };
  }

  /**
   * Spec 8.1's "ringkasan perpindahan kolektibilitas", the feature the spec
   * calls the one accounting users value most. One cell per (from, to) pair
   * that actually occurred; `dari` is null for an akad with no earlier snapshot.
   * Ordered deterministically so a preview and its commit are comparable
   * cell for cell.
   */
  function bangunMatriks(baris: readonly BarisKolektibilitas[]): SelKematriks[] {
    const sel = new Map<string, SelKematriks>();
    for (const b of baris) {
      const kunci = `${b.kolektibilitasPeriodeLalu ?? ""}>${b.kolektibilitas}`;
      const ada = sel.get(kunci);
      if (ada) {
        sel.set(kunci, {
          ...ada,
          jumlahAkad: ada.jumlahAkad + 1,
          outstandingPokok: tambah(ada.outstandingPokok, b.outstandingPokok),
        });
      } else {
        sel.set(kunci, {
          dari: b.kolektibilitasPeriodeLalu,
          ke: b.kolektibilitas,
          jumlahAkad: 1,
          outstandingPokok: b.outstandingPokok,
        });
      }
    }
    const urut = (k: KelasKolektibilitas | null): number =>
      k === null ? -1 : URUTAN_KELAS.indexOf(k);
    return [...sel.values()].sort((a, b) => urut(a.dari) - urut(b.dari) || urut(a.ke) - urut(b.ke));
  }

  function bangunRingkasan(baris: readonly BarisKolektibilitas[]): RingkasanKelas[] {
    const per = new Map<KelasKolektibilitas, RingkasanKelas>();
    for (const b of baris) {
      const ada = per.get(b.kolektibilitas);
      if (ada) {
        per.set(b.kolektibilitas, {
          ...ada,
          jumlahAkad: ada.jumlahAkad + 1,
          outstandingPokok: tambah(ada.outstandingPokok, b.outstandingPokok),
          nilaiPenyisihan: tambah(ada.nilaiPenyisihan, b.nilaiPenyisihan),
        });
      } else {
        per.set(b.kolektibilitas, {
          kelas: b.kolektibilitas,
          jumlahAkad: 1,
          outstandingPokok: b.outstandingPokok,
          nilaiPenyisihan: b.nilaiPenyisihan,
        });
      }
    }
    return [...per.values()].sort(
      (a, b) => URUTAN_KELAS.indexOf(a.kelas) - URUTAN_KELAS.indexOf(b.kelas),
    );
  }

  function bentukHasil(h: HitunganKolektibilitas) {
    return {
      periodeId: h.periode.id,
      cabangId: h.cakupan.cabangId,
      tanggalAkhirPeriode: h.periode.tanggal_akhir,
      modePenyisihan: h.mode,
      dasarPerhitungan: h.dasar,
      totalAkadDiproses: h.baris.length,
      baris: h.baris,
      matriks: h.matriks,
      ringkasanPerKelas: h.ringkasan,
      totalPenyisihanDibutuhkan: h.total,
    };
  }

  // --- spec 8.2 ------------------------------------------------------------

  interface BarisPenyisihanTersimpan {
    id: string;
    beban: Uang;
    /** Oldest first, so the last element is the entry the last run posted. */
    jurnal: KontribusiJurnalPenyisihan[];
  }

  interface HitunganPenyisihan {
    cabangId: string;
    saldoAwal: Uang;
    dibutuhkan: Uang;
    beban: Uang;
    barisAda: BarisPenyisihanTersimpan | null;
  }

  async function hitungPenyisihanCabang(
    tx: ClosingTx,
    ctx: ClosingContext,
    periode: PeriodeRow,
    cabangId: string,
    akunPenyisihanId: string,
    tersimpan: Map<string, BarisPenyisihanTersimpan>,
  ): Promise<HitunganPenyisihan> {
    const dibutuhkan = uangDariDb(
      await repo.totalPenyisihanDibutuhkan(tx, periode.id, cabangId),
    );
    const ada = tersimpan.get(cabangId) ?? null;
    // THE OPENING BALANCE COMES FROM THE LEDGER, and it is the position the
    // allowance account is in BEFORE this period's own allowance entry. Not the
    // SUM of the previous period's `nilai_penyisihan`: those two agree only
    // until something else touches the allowance, and the thing that touches it
    // is a WRITE-OFF. After one, a snapshot sum still says the allowance is
    // intact while the ledger says it was spent, so the next period's expense
    // comes out understated by exactly the amount written off and the allowance
    // rebuilds itself out of nothing, with every journal balancing throughout.
    const saldoDebit = await repo.saldoAkun(tx, {
      bumnId: ctx.bumnId,
      akunId: akunPenyisihanId,
      sampaiTanggal: periode.tanggal_akhir,
      cabangId,
      // EVERY entry this period's provision has already posted, not just the
      // last one. Under delta correction the movement is carried by a SET
      // (migrations/0026), so excluding one of two would leave the earlier
      // formation inside the "opening" balance and the re-run would compute a
      // delta against a figure that already contains its own first instalment.
      kecualiJurnalIds: ada?.jurnal.map((j) => j.jurnalId) ?? [],
    });
    // The contra-asset carries a normal CREDIT balance and `saldoAkun` is
    // debit-positive, so the allowance in hand is the negation.
    const saldoAwal = negasi(uangDariDb(saldoDebit));
    return {
      cabangId,
      saldoAwal,
      dibutuhkan,
      beban: kurang(dibutuhkan, saldoAwal),
      barisAda: ada,
    };
  }

  async function siapkanPenyisihan(
    tx: ClosingTx,
    input: JalankanPenyisihanInput,
    ctx: ClosingContext,
  ): Promise<{ periode: PeriodeRow; akunId: string; hitungan: HitunganPenyisihan[] }> {
    const periode = await periodeWajib(tx, input.periodeId, ctx.bumnId);
    if (periode.status !== "OPEN") throw tolak("PERIODE_TIDAK_OPEN", { periodeId: periode.id });
    if (!(await repo.adaRunSelesai(tx, periode.id))) {
      // Without the snapshot, `penyisihan_dibutuhkan` would be a SUM over
      // nothing, and a portfolio full of MACET akads would post a RECOVERY of
      // the entire existing allowance. Silence is the dangerous answer here.
      throw tolak("KOLEKTIBILITAS_BELUM_DIJALANKAN", { periodeId: periode.id });
    }
    const lingkup = await cakupan(tx, ctx, input.cabangId);
    const mapping = await repo.akunEvent(tx, ctx.bumnId, EVENT_CLOSING.BEBAN_PENYISIHAN);
    if (!mapping) {
      throw tolak("EVENT_MAPPING_BELUM_ADA", { eventCode: EVENT_CLOSING.BEBAN_PENYISIHAN });
    }
    const tautan = await repo.tautanJurnal(tx, periode.id);
    const tersimpan = new Map<string, BarisPenyisihanTersimpan>(
      (await repo.penyisihanPeriode(tx, periode.id)).map((r) => [
        r.cabang_id,
        {
          id: r.id,
          beban: uangDariDb(r.beban_penyisihan_periode),
          jurnal: tautan
            .filter((t) => t.penyisihan_periode_id === r.id)
            .map((t) => ({ jurnalId: t.jurnal_id, nilai: uangDariDb(t.nilai) })),
        },
      ]),
    );
    const hitungan: HitunganPenyisihan[] = [];
    for (const cabangId of lingkup.daftar) {
      hitungan.push(
        await hitungPenyisihanCabang(
          tx,
          ctx,
          periode,
          cabangId,
          mapping.akun_kredit_id,
          tersimpan,
        ),
      );
    }
    return { periode, akunId: mapping.akun_kredit_id, hitungan };
  }

  // --- spec 8.3 ------------------------------------------------------------

  interface HitunganAkrual {
    periode: PeriodeRow;
    metode: MetodePengakuanJasa;
    kelas: KelasKolektibilitas[];
    daftar: string[];
    baris: BarisAkrual[];
  }

  async function hitungAkrual(
    tx: ClosingTx,
    input: JalankanAkrualInput,
    ctx: ClosingContext,
  ): Promise<HitunganAkrual> {
    const periode = await periodeWajib(tx, input.periodeId, ctx.bumnId);
    if (periode.status !== "OPEN") throw tolak("PERIODE_TIDAK_OPEN", { periodeId: periode.id });
    const metode = await konfigEnum<MetodePengakuanJasa>(
      tx,
      ctx.bumnId,
      KUNCI_KONFIGURASI_CLOSING.METODE_PENGAKUAN_JASA,
      ["CASH_BASIS", "ACCRUAL"],
    );
    const lingkup = await cakupan(tx, ctx, input.cabangId);
    if (metode === "CASH_BASIS") {
      return { periode, metode, kelas: [], daftar: lingkup.daftar, baris: [] };
    }
    if (!(await repo.adaRunSelesai(tx, periode.id))) {
      // The population is defined BY CLASS, so without the snapshot there is no
      // class to filter on. Treating "no snapshot" as "no akad qualifies" would
      // skip the accrual for the whole portfolio and leave check 6 satisfied by
      // an empty run.
      throw tolak("KOLEKTIBILITAS_BELUM_DIJALANKAN", { periodeId: periode.id });
    }
    const kelas = await kelasAkrual(tx, ctx.bumnId);
    const kandidat =
      kelas.length === 0
        ? []
        : await repo.akrualKandidat(tx, {
            periodeId: periode.id,
            cabangIds: lingkup.daftar,
            kelas,
            mulai: periode.tanggal_mulai,
            akhir: periode.tanggal_akhir,
          });
    const baris: BarisAkrual[] = [];
    for (const k of kandidat) {
      // EVERY akad in the configured classes gets a row, INCLUDING one with no
      // jasa administrasi falling due this period. The row is the record that
      // the step RAN over that akad: spec 8.4 check 5 draws the same
      // distinction for the allowance ("posted or explicitly stated as zero"),
      // and check 6 has no run header to read, so without a zero row a period
      // where the accrual ran and produced nothing is indistinguishable from
      // one where it was never run at all. It is also the population spec 10.4
      // report 30 needs in order to say which akads were considered.
      const jatuhTempo = uangDariDb(k.jasa_jatuh_tempo);
      const diterima = uangDariDb(k.jasa_diterima);
      const selisih = kurang(jatuhTempo, diterima);
      // Floored at zero. An overpayment is not a negative accrual, it is a
      // `pumk_kelebihan` row (invariant 10), and letting it go negative would
      // quietly reduce another akad's accrual in the branch total.
      baris.push({
        akadId: k.akad_id,
        noAkad: k.no_akad,
        cabangId: k.cabang_id,
        kolektibilitas: k.kolektibilitas,
        jasaJatuhTempoPeriode: jatuhTempo,
        jasaDiterimaPeriode: diterima,
        jasaDiakrual: keSen(selisih) < 0n ? "0.00" : selisih,
      });
    }
    return { periode, metode, kelas, daftar: lingkup.daftar, baris };
  }

  // --- spec 8.4, the ten checks -------------------------------------------

  function hasilPrasyarat(
    kode: KodePrasyarat,
    status: HasilPrasyarat["status"],
    alasan: string,
    detail: Record<string, unknown> = {},
  ): HasilPrasyarat {
    return { nomor: PRASYARAT_CLOSING[kode], kode, status, alasan, detail: Object.freeze(detail) };
  }

  async function jalankanPrasyarat(
    tx: ClosingTx,
    periode: PeriodeRow,
    ctx: ClosingContext,
  ): Promise<DaftarPrasyarat> {
    const hasil: HasilPrasyarat[] = [];
    const label = labelPeriode(periode);

    // 1. Periods close in order (invariant 6). First on the list because it is
    //    the only failure whose fix is another closing.
    const sebelumnya = await repo.periodeSebelumnyaBelumTutup(
      tx,
      periode.bumn_id,
      periode.tahun,
      periode.bulan,
    );
    hasil.push(
      hasilPrasyarat(
        "PERIODE_SEBELUMNYA_BELUM_CLOSED",
        sebelumnya.length === 0 ? "PASS" : "GAGAL",
        sebelumnya.length === 0
          ? `Semua periode sebelum ${label} sudah ditutup, jadi periode ini boleh ditutup berurutan.`
          : `Masih ada ${sebelumnya.length} periode sebelum ${label} yang belum ditutup: ` +
            `${sebelumnya.map(labelPeriode).join(", ")}. Tutup periode itu lebih dulu, satu per satu.`,
        { periode: sebelumnya.map((p) => ({ id: p.id, tahun: p.tahun, bulan: p.bulan, status: p.status })) },
      ),
    );

    // 2. DRAFT journals dated inside this period. On the TRANSACTION date, not
    //    the input date: invariant 5 is about when the money moved.
    const draft = await repo.jurnalDraftPeriode(
      tx,
      periode.bumn_id,
      periode.tanggal_mulai,
      periode.tanggal_akhir,
    );
    hasil.push(
      hasilPrasyarat(
        "ADA_JURNAL_DRAFT",
        draft.length === 0 ? "PASS" : "GAGAL",
        draft.length === 0
          ? `Tidak ada jurnal berstatus draft yang bertanggal di periode ${label}.`
          : `Masih ada ${draft.length} jurnal berstatus draft bertanggal di periode ${label}: ` +
            `${draft.map((j) => j.no_jurnal).join(", ")}. Posting atau batalkan dulu jurnal itu.`,
        { jurnal: draft.map((j) => ({ id: j.id, noJurnal: j.no_jurnal, tanggal: j.tanggal_transaksi })) },
      ),
    );

    // 3. Every journal balances, computed from the LINES (spec 8.4: "query
    //    verifikasi, jangan percaya kolom total"). Can only PASS while the
    //    deferred balance trigger of migrations/0010 stands; it stays on the
    //    list as the operator's evidence that the guard held.
    const timpang = await repo.jurnalTidakBalance(tx, periode.id);
    hasil.push(
      hasilPrasyarat(
        "JURNAL_TIDAK_BALANCE",
        timpang.length === 0 ? "PASS" : "GAGAL",
        timpang.length === 0
          ? `Seluruh jurnal periode ${label} seimbang antara sisi debit dan sisi kredit.`
          : `Ada ${timpang.length} jurnal periode ${label} yang sisi debit dan kreditnya tidak sama: ` +
            `${timpang.map((j) => j.no_jurnal).join(", ")}.`,
        { jurnal: timpang.map((j) => ({ noJurnal: j.no_jurnal, selisih: j.selisih })) },
      ),
    );

    // 4. Kolektibilitas has been run and committed.
    const adaRun = await repo.adaRunSelesai(tx, periode.id);
    hasil.push(
      hasilPrasyarat(
        "KOLEKTIBILITAS_BELUM_DIJALANKAN",
        adaRun ? "PASS" : "GAGAL",
        adaRun
          ? `Closing kolektibilitas periode ${label} sudah dijalankan dan hasilnya tersimpan.`
          : `Closing kolektibilitas periode ${label} belum dijalankan, padahal penyisihan dan akrual ` +
            "dihitung dari hasilnya. Jalankan dulu langkah itu.",
        { adaRun },
      ),
    );

    // 5. The allowance step ran. spec 8.4: "sudah diposting ATAU eksplisit
    //    dinyatakan nol". The `penyisihan_periode` row IS that statement, which
    //    is why spec 8.2 writes it even when the movement is nothing.
    const penyisihan = await repo.penyisihanPeriode(tx, periode.id);
    const tautanPenyisihan = await repo.tautanJurnal(tx, periode.id);
    hasil.push(
      hasilPrasyarat(
        "PENYISIHAN_BELUM_POSTED",
        penyisihan.length > 0 ? "PASS" : "GAGAL",
        penyisihan.length > 0
          ? `Perhitungan penyisihan periode ${label} sudah dijalankan untuk ${penyisihan.length} cabang, ` +
            "termasuk yang pergerakannya nol."
          : `Perhitungan penyisihan periode ${label} belum dijalankan, jadi belum ada beban penyisihan ` +
            "maupun pernyataan bahwa pergerakannya nol.",
        {
          // The drill-down names EVERY entry that carried the branch's
          // movement, not one of them: after a delta correction the provision
          // lives in several journals (migrations/0026) and an operator
          // checking the checklist needs all of them.
          cabang: penyisihan.map((p) => ({
            cabangId: p.cabang_id,
            beban: uangDariDb(p.beban_penyisihan_periode),
            jurnal: tautanPenyisihan
              .filter((t) => t.penyisihan_periode_id === p.id)
              .map((t) => ({ jurnalId: t.jurnal_id, nilai: uangDariDb(t.nilai) })),
          })),
        },
      ),
    );

    // 6. The accrual step ran, and ONLY IF the configured method calls for one.
    //    This is the check reading configuration, not the engine deciding an
    //    accounting policy.
    const metode = await konfigEnum<MetodePengakuanJasa>(
      tx,
      periode.bumn_id,
      KUNCI_KONFIGURASI_CLOSING.METODE_PENGAKUAN_JASA,
      ["CASH_BASIS", "ACCRUAL"],
    );
    if (metode === "CASH_BASIS") {
      hasil.push(
        hasilPrasyarat(
          "AKRUAL_BELUM_POSTED",
          "PASS",
          "Metode pengakuan jasa administrasi yang berlaku adalah CASH_BASIS, jadi periode ini memang " +
            "tidak punya jurnal akrual untuk diposting.",
          { metode },
        ),
      );
    } else {
      const kelas = await kelasAkrual(tx, periode.bumn_id);
      const akrual = await repo.akrualSnapshot(tx, periode.id);
      // An akad can only be accrued if it is in one of the configured classes.
      // With none in the portfolio there is nothing the step could have
      // produced, so demanding a row would block every closing of a quiet month
      // forever.
      const adaKandidat = await repo.adaKandidatAkrual(tx, periode.id, kelas);
      // "The step ran" is what check 6 is about, and the accrual has no run
      // header row of its own, so the evidence is the snapshot: spec 8.3 writes
      // one row per akad in the configured classes even when the amount is
      // zero. `!adaKandidat` is the other legitimate way to pass, but ONLY once
      // kolektibilitas has run: before that there is no snapshot to read a
      // class from, so "no candidate" would mean "nothing has happened yet"
      // rather than "nothing needed to happen".
      const lolos = akrual.length > 0 || (adaRun && !adaKandidat);
      hasil.push(
        hasilPrasyarat(
          "AKRUAL_BELUM_POSTED",
          lolos ? "PASS" : "GAGAL",
          lolos
            ? akrual.length > 0
              ? `Akrual jasa administrasi periode ${label} sudah dijalankan untuk ${akrual.length} akad.`
              : `Tidak ada akad berkolektibilitas ${kelas.join(", ")} di periode ${label}, jadi memang ` +
                "tidak ada jasa administrasi yang perlu diakru."
            : adaRun
              ? `Akrual jasa administrasi periode ${label} belum dijalankan, padahal metode pengakuan ` +
                `yang berlaku adalah ${metode} dan masih ada akad yang masuk cakupannya.`
              : `Akrual jasa administrasi periode ${label} belum dijalankan, dan belum bisa dijalankan ` +
                "karena closing kolektibilitas periode ini juga belum dijalankan.",
          { metode, kelas, jumlahBaris: akrual.length },
        ),
      );
    }

    // 7. The whole ledger balances, read the correct way (ADR 0010). Follows
    //    from check 3 summed over every journal.
    const selisih = uangDariDb(
      await repo.selisihLedger(tx, periode.bumn_id, periode.tanggal_akhir),
    );
    hasil.push(
      hasilPrasyarat(
        "NERACA_LAJUR_TIDAK_BALANCE",
        nol(selisih) ? "PASS" : "GAGAL",
        nol(selisih)
          ? `Neraca lajur sampai akhir periode ${label} seimbang: total debit sama dengan total kredit.`
          : `Neraca lajur sampai akhir periode ${label} tidak seimbang, selisihnya ${rupiah(selisih)}.`,
        { selisih },
      ),
    );

    // 8. Negative cash. spec 8.4: "warning, bukan blocker, tapi wajib
    //    dikonfirmasi user", which is neither PASS nor GAGAL and needs the
    //    third state.
    const izinkanKasNegatif = await konfigBoolean(
      tx,
      periode.bumn_id,
      KUNCI_KONFIGURASI_CLOSING.IZINKAN_KAS_NEGATIF,
    );
    const kas = await repo.saldoKas(tx, periode.bumn_id, periode.tanggal_akhir);
    const kasNegatif = kas.filter((k) => keSen(uangDariDb(k.saldo)) < 0n);
    const kasBermasalah = kasNegatif.length > 0 && !izinkanKasNegatif;
    hasil.push(
      hasilPrasyarat(
        "SALDO_KAS_NEGATIF",
        kasBermasalah ? "PERINGATAN" : "PASS",
        kasBermasalah
          ? `Saldo kas dan setara kas di akhir periode ${label} negatif pada ${kasNegatif.length} akun ` +
            `(${kasNegatif.map((k) => `${k.akun_nama} ${rupiah(uangDariDb(k.saldo))}`).join("; ")}). ` +
            "Closing tetap bisa dilanjutkan, tetapi kondisi ini wajib dikonfirmasi lebih dulu."
          : kasNegatif.length === 0
            ? `Saldo kas dan setara kas di akhir periode ${label} tidak ada yang negatif.`
            : `Saldo kas negatif di akhir periode ${label} diizinkan lewat konfigurasi akuntansi, ` +
              "jadi kondisi ini tidak menahan closing.",
        {
          izinkanKasNegatif,
          akun: kasNegatif.map((k) => ({ kode: k.akun_kode, nama: k.akun_nama, saldo: uangDariDb(k.saldo) })),
        },
      ),
    );

    // 9. No negative outstanding. Can only PASS while
    //    `CHECK (outstanding_pokok >= 0)` stands; kept for the same reason as 3.
    const negatif = await repo.outstandingNegatif(tx, periode.bumn_id);
    hasil.push(
      hasilPrasyarat(
        "OUTSTANDING_POKOK_NEGATIF",
        negatif.length === 0 ? "PASS" : "GAGAL",
        negatif.length === 0
          ? "Tidak ada akad dengan sisa pokok negatif di seluruh cabang."
          : `Ada ${negatif.length} akad dengan sisa pokok negatif: ` +
            `${negatif.map((a) => a.no_akad).join(", ")}.`,
        { akad: negatif.map((a) => ({ akadId: a.akad_id, noAkad: a.no_akad, outstandingPokok: a.outstanding_pokok })) },
      ),
    );

    // 10. The reconciliation spec 8.4 calls the most important in the system.
    //     The LIST is the check: a bare "tidak cocok" leaves an accountant with
    //     a blocked close and nowhere to look.
    const tidakCocok = await repo.subLedgerTidakCocok(tx, periode.bumn_id);
    hasil.push(
      hasilPrasyarat(
        "SUB_LEDGER_TIDAK_COCOK",
        tidakCocok.length === 0 ? "PASS" : "GAGAL",
        tidakCocok.length === 0
          ? "Sisa piutang di kartu piutang sudah sama dengan saldo piutang di buku besar untuk seluruh akad."
          : `Ada ${tidakCocok.length} akad yang sisa piutangnya berbeda antara kartu piutang dan buku besar: ` +
            `${tidakCocok.map((a) => `${a.no_akad} selisih ${rupiah(uangDariDb(a.selisih))}`).join("; ")}.`,
        {
          akad: tidakCocok.map((a) => ({
            akadId: a.akad_id,
            noAkad: a.no_akad,
            saldoSubLedger: uangDariDb(a.saldo_sub_ledger),
            saldoBukuBesar: uangDariDb(a.saldo_buku_besar),
            selisih: uangDariDb(a.selisih),
          })),
        },
      ),
    );

    void ctx;
    return {
      periodeId: periode.id,
      tahun: periode.tahun,
      bulan: periode.bulan,
      boleh: hasil.every((h) => h.status !== "GAGAL"),
      perluKonfirmasi: hasil.some((h) => h.status === "PERINGATAN"),
      hasil,
    };
  }

  // --- the frozen trial balance -------------------------------------------

  function keSaldoPublik(periodeId: string, rows: readonly SaldoRow[]): SaldoAkunPeriode[] {
    return rows.map((r) => ({
      periodeId,
      cabangId: r.cabang_id,
      akunId: r.akun_id,
      akunKode: r.akun_kode,
      saldoAwal: uangDariDb(r.saldo_awal),
      mutasiDebit: uangDariDb(r.mutasi_debit),
      mutasiKredit: uangDariDb(r.mutasi_kredit),
      saldoAkhir: uangDariDb(r.saldo_akhir),
    }));
  }

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  return {
    // --- 8.1 --------------------------------------------------------------

    previewKolektibilitas(input, ctx): Promise<PreviewKolektibilitas> {
      return bersihkan(async () => {
        // A preview writes nothing, which is exactly why it is tempting to
        // leave ungated. It still returns every akad's outstanding, arrears and
        // classification for every branch in scope, which is the most sensitive
        // read in the PUMK module.
        wajibIzin(ctx, PERMISSION_CLOSING.KOLEKTIBILITAS);
        const h = await hitungKolektibilitas(db, input, ctx);
        return { ...bentukHasil(h), tersimpan: false };
      });
    },

    jalankanKolektibilitas(input, ctx): Promise<HasilKolektibilitas> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.KOLEKTIBILITAS);
        return db.transaction(async (tx) => {
          const h = await hitungKolektibilitas(tx, input, ctx);
          if (h.periode.status !== "OPEN") {
            // A closed period's snapshot is what its allowance journal and its
            // frozen trial balance were built from; rewriting it would make a
            // filed period disagree with itself.
            throw tolak("PERIODE_TIDAK_OPEN", { periodeId: h.periode.id });
          }

          const sebelumnya = await repo.runSelesai(tx, h.periode.id, h.cakupan.cabangId);
          const ringkasan = JSON.stringify({
            matriks: h.matriks,
            ringkasanPerKelas: h.ringkasan,
            totalPenyisihanDibutuhkan: h.total,
            modePenyisihan: h.mode,
            dasarPerhitungan: h.dasar,
            sumberRate: h.sumberRate,
          });
          const closingId = await repo.simpanRun(tx, {
            id: sebelumnya?.id ?? null,
            periodeId: h.periode.id,
            cabangId: h.cakupan.cabangId,
            userId: ctx.userId,
            total: h.baris.length,
            ringkasan,
          });

          // Invariant 13: the earlier snapshots are REWRITTEN, never
          // duplicated. Physical, because `kolektibilitas_snapshot_uq` has no
          // `deleted_at IS NULL` predicate.
          await repo.hapusSnapshot(tx, h.periode.id, h.cakupan.daftar);
          await repo.tulisSnapshot(
            tx,
            h.periode.id,
            closingId,
            ctx.userId,
            h.baris.map((b) => ({
              akadId: b.akadId,
              mitraId: b.mitraId,
              cabangId: b.cabangId,
              sektorId: b.sektorId,
              tanggalTertua: b.tanggalJatuhTempoTertunggakTertua,
              hariTunggakan: b.hariTunggakan,
              kolektibilitas: b.kolektibilitas,
              outstandingPokok: b.outstandingPokok,
              outstandingJasa: b.outstandingJasa,
              tunggakanPokok: b.tunggakanPokok,
              tunggakanJasa: b.tunggakanJasa,
              ratePenyisihan: b.ratePenyisihan,
              dasarPerhitungan: b.dasarPerhitungan,
              nilaiPenyisihan: b.nilaiPenyisihan,
              kolektibilitasPeriodeLalu: b.kolektibilitasPeriodeLalu,
              // migrations/0024 + ADR 0014: provenance is mandatory and has no
              // default, so a historically derived rate can never be stamped as
              // if it had been typed into `penyisihan_rate`. The window is
              // frozen with it, because only the window is unrecoverable later.
              sumberRate: b.sumberRate,
              historiDari: h.historiDari,
              historiSampai: h.historiSampai,
            })),
          );

          // Spec 8.1 step 7.
          const tandai = await konfigBoolean(
            tx,
            ctx.bumnId,
            KUNCI_KONFIGURASI_CLOSING.TANDAI_MITRA_BERMASALAH,
          );
          const mitraMacet = tandai
            ? [...new Set(h.baris.filter((b) => b.kolektibilitas === "MACET").map((b) => b.mitraId))]
            : [];
          const ditandai = await repo.tandaiMitraBermasalah(tx, mitraMacet, ctx.userId);

          await audit?.record(
            {
              userId: ctx.userId,
              aksi: "closing.kolektibilitas",
              entitas: "closing_kolektibilitas",
              entitasId: closingId,
              nilaiBaru: {
                periodeId: h.periode.id,
                cabangId: h.cakupan.cabangId,
                totalAkadDiproses: h.baris.length,
                totalPenyisihanDibutuhkan: h.total,
              },
              hasil: "SUKSES",
              keterangan: `Closing kolektibilitas ${labelPeriode(h.periode)}`,
            },
            tx,
          );

          return {
            ...bentukHasil(h),
            tersimpan: true,
            closingId,
            mitraDitandaiBermasalah: ditandai,
            menggantikanRunSebelumnya: sebelumnya !== null,
          };
        });
      });
    },

    riwayatKolektibilitas(periodeId, ctx): Promise<RiwayatRunKolektibilitas[]> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);
        await periodeWajib(db, periodeId, ctx.bumnId);
        const rows = await repo.riwayatRun(db, periodeId);
        return rows.map((r) => ({
          id: r.id,
          periodeId: r.periode_id,
          cabangId: r.cabang_id,
          tanggalJalan: r.tanggal_jalan,
          status: r.status as RiwayatRunKolektibilitas["status"],
          dijalankanOleh: r.dijalankan_oleh,
          totalAkadDiproses: r.total_akad_diproses,
        }));
      });
    },

    snapshotKolektibilitas(input, ctx): Promise<BarisKolektibilitas[]> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);
        await periodeWajib(db, input.periodeId, ctx.bumnId);
        const lingkup = await cakupan(db, ctx, input.cabangId);
        const rows = await repo.bacaSnapshot(db, input.periodeId, lingkup.daftar);
        return rows.map((r) => ({
          akadId: r.akad_id,
          noAkad: r.no_akad,
          mitraId: r.mitra_id,
          cabangId: r.cabang_id,
          sektorId: r.sektor_id,
          tanggalJatuhTempoTertunggakTertua: r.tanggal_jatuh_tempo_tertunggak_tertua,
          hariTunggakan: r.hari_tunggakan,
          kolektibilitas: r.kolektibilitas,
          kolektibilitasPeriodeLalu: r.kolektibilitas_periode_lalu,
          outstandingPokok: uangDariDb(r.outstanding_pokok),
          outstandingJasa: uangDariDb(r.outstanding_jasa),
          tunggakanPokok: uangDariDb(r.tunggakan_pokok),
          tunggakanJasa: uangDariDb(r.tunggakan_jasa),
          ratePenyisihan: rateDariDb(r.rate_penyisihan),
          dasarPerhitungan: r.dasar_perhitungan,
          sumberRate: r.sumber_rate,
          nilaiPenyisihan: uangDariDb(r.nilai_penyisihan),
        }));
      });
    },

    // --- 8.2 --------------------------------------------------------------

    hitungPenyisihan(input, ctx): Promise<PenyisihanPeriode[]> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.PERIODE);
        const { periode, hitungan } = await siapkanPenyisihan(db, input, ctx);
        return hitungan.map((h) => ({
          id: null,
          periodeId: periode.id,
          cabangId: h.cabangId,
          saldoPenyisihanAwal: h.saldoAwal,
          penyisihanDibutuhkan: h.dibutuhkan,
          bebanPenyisihanPeriode: h.beban,
          eventCode: nol(h.beban)
            ? null
            : keSen(h.beban) > 0n
              ? EVENT_CLOSING.BEBAN_PENYISIHAN
              : EVENT_CLOSING.PEMULIHAN_PENYISIHAN,
          // A preview states what WOULD be posted, not what is stored, so both
          // links are empty even when a committed run already exists.
          jurnal: [],
          jurnalId: null,
          tanggal: periode.tanggal_akhir,
        }));
      });
    },

    jalankanPenyisihan(input, ctx): Promise<PenyisihanPeriode[]> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.PERIODE);
        return db.transaction(async (tx) => {
          const { periode, hitungan } = await siapkanPenyisihan(tx, input, ctx);
          const keluaran: PenyisihanPeriode[] = [];
          for (const h of hitungan) {
            // The event REPORTED is the one the period's own movement calls
            // for. spec 8.2 step 4: zero movement means no journal at all, and
            // that is a legitimate outcome rather than a failure.
            const eventCode = nol(h.beban)
              ? null
              : keSen(h.beban) > 0n
                ? EVENT_CLOSING.BEBAN_PENYISIHAN
                : EVENT_CLOSING.PEMULIHAN_PENYISIHAN;

            // IDEMPOTENCY (invariant 13), as one rule rather than two cases:
            // what gets posted is always the DELTA between the movement already
            // journalised for this (periode, cabang) and the movement now
            // required. On a first run nothing is journalised yet, so the delta
            // IS the movement; on a re-run with unchanged inputs it is zero and
            // nothing is posted, which is what leaves the journal count alone.
            // `saldoAwal` was measured with every existing entry EXCLUDED, so
            // the arithmetic reproduces instead of compounding.
            const tautanLama = h.barisAda?.jurnal ?? [];
            const sudahDijurnal: Uang = tambah("0.00", ...tautanLama.map((t) => t.nilai));
            const delta = kurang(h.beban, sudahDijurnal);
            let jurnalBaruId: string | null = null;
            if (!nol(delta)) {
              const naikDelta = keSen(delta) > 0n;
              // spec 8.2 step 4 posts the ABSOLUTE value through the event that
              // carries the direction. A negative amount on BEBAN_PENYISIHAN
              // would be refused by the ledger's own one-side-per-line guard,
              // so a "negative expense" is not even expressible here.
              const eventDipakai = naikDelta
                ? EVENT_CLOSING.BEBAN_PENYISIHAN
                : EVENT_CLOSING.PEMULIHAN_PENYISIHAN;
              try {
                const jurnalBaru = await jurnal.postingEvent(
                  eventDipakai,
                  {
                    cabangId: h.cabangId,
                    tanggalTransaksi: periode.tanggal_akhir,
                    nilai: naikDelta ? delta : negasi(delta),
                    keterangan:
                      eventDipakai === EVENT_CLOSING.BEBAN_PENYISIHAN
                        ? `Pembentukan penyisihan penurunan nilai piutang periode ${labelPeriode(periode)}`
                        : `Pemulihan penyisihan penurunan nilai piutang periode ${labelPeriode(periode)}`,
                    // Invariant 13. A closing journal ALWAYS carries a key, and
                    // the movement is part of it, so a corrected re-run posts a
                    // second journal for the difference instead of being refused
                    // as a duplicate of the first.
                    kunciIdempotensi: `closing:penyisihan:${periode.id}:${h.cabangId}:${keSen(h.beban)}`,
                  },
                  ctx as JurnalContext,
                );
                jurnalBaruId = jurnalBaru.id;
              } catch (e) {
                // A `penyisihan_periode` row pointing at no journal would tell
                // check 5 the allowance was posted when it was not, and the
                // period would close on it. So the whole step rolls back.
                throw gagalJurnal(eventDipakai, e);
              }
            }

            const id = await repo.simpanPenyisihan(tx, {
              id: h.barisAda?.id ?? null,
              periodeId: periode.id,
              cabangId: h.cabangId,
              saldoAwal: h.saldoAwal,
              dibutuhkan: h.dibutuhkan,
              beban: h.beban,
              tanggal: periode.tanggal_akhir,
              userId: ctx.userId,
            });
            // The row first, then its link: the parent must exist for the
            // foreign key, and `trg_penyisihan_periode_jurnal_30_total` is
            // deferred, so it compares the stated movement against the sum of
            // the links once, at COMMIT, whichever order they were written in.
            if (jurnalBaruId) {
              await repo.tautkanJurnal(tx, {
                penyisihanPeriodeId: id,
                jurnalId: jurnalBaruId,
                nilai: delta,
                userId: ctx.userId,
              });
            }
            const tautan: KontribusiJurnalPenyisihan[] = jurnalBaruId
              ? [...tautanLama, { jurnalId: jurnalBaruId, nilai: delta }]
              : [...tautanLama];

            keluaran.push({
              id,
              periodeId: periode.id,
              cabangId: h.cabangId,
              saldoPenyisihanAwal: h.saldoAwal,
              penyisihanDibutuhkan: h.dibutuhkan,
              bebanPenyisihanPeriode: h.beban,
              eventCode,
              jurnal: tautan,
              // The entry the LAST movement was posted to, which after a delta
              // correction is the delta and NOT the period's provision. See the
              // field's note in ./contract.ts: reports read `jurnal`.
              jurnalId: tautan.at(-1)?.jurnalId ?? null,
              tanggal: periode.tanggal_akhir,
            });
          }
          return keluaran;
        });
      });
    },

    // --- 8.3 --------------------------------------------------------------

    jalankanAkrualJasaAdm(input, ctx): Promise<HasilAkrual> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.PERIODE);
        return db.transaction(async (tx) => {
          const h = await hitungAkrual(tx, input, ctx);
          if (h.metode === "CASH_BASIS") {
            // A skipped step, not a silent skip: `metode` says which policy
            // produced the emptiness, so "policy says do nothing" cannot be
            // confused with "something went wrong and produced nothing".
            return {
              periodeId: h.periode.id,
              metode: h.metode,
              kelasDiakrual: [],
              dilewati: true,
              baris: [],
              totalPerCabang: [],
            };
          }

          const lama = new Map(
            (await repo.akrualSnapshot(tx, h.periode.id)).map((r) => [r.akad_id, r]),
          );
          const perCabang = new Map<string, { total: Uang; jurnalId: string | null }>();
          for (const cabangId of h.daftar) perCabang.set(cabangId, { total: "0.00", jurnalId: null });
          for (const b of h.baris) {
            const ada = perCabang.get(b.cabangId) ?? { total: "0.00", jurnalId: null };
            perCabang.set(b.cabangId, { ...ada, total: tambah(ada.total, b.jasaDiakrual) });
          }

          const hasilCabang: Array<{ cabangId: string; total: Uang; jurnalId: string | null }> = [];
          for (const [cabangId, agregat] of [...perCabang.entries()].sort()) {
            const punyaBaris = h.baris.some((b) => b.cabangId === cabangId);
            if (!punyaBaris) continue;
            let jurnalId: string | null =
              [...lama.values()].find((r) => r.cabang_id === cabangId && r.jurnal_id)?.jurnal_id ??
              null;
            const totalLama = tambah(
              "0.00",
              ...[...lama.values()]
                .filter((r) => r.cabang_id === cabangId)
                .map((r) => uangDariDb(r.jasa_diakrual)),
            );
            if (!nol(agregat.total) && !(jurnalId && totalLama === agregat.total)) {
              try {
                const jurnalBaru = await jurnal.postingEvent(
                  EVENT_CLOSING.AKRUAL_JASA_ADM,
                  {
                    cabangId,
                    tanggalTransaksi: h.periode.tanggal_akhir,
                    nilai: agregat.total,
                    keterangan: `Akrual jasa administrasi periode ${labelPeriode(h.periode)}`,
                    kunciIdempotensi: `closing:akrual:${h.periode.id}:${cabangId}:${keSen(agregat.total)}`,
                  },
                  ctx as JurnalContext,
                );
                jurnalId = jurnalBaru.id;
              } catch (e) {
                // A snapshot without its journal would satisfy check 6 while the
                // ledger carried no accrual at all.
                throw gagalJurnal(EVENT_CLOSING.AKRUAL_JASA_ADM, e);
              }
            }
            hasilCabang.push({ cabangId, total: agregat.total, jurnalId });
          }

          const jurnalPerCabang = new Map(hasilCabang.map((c) => [c.cabangId, c.jurnalId]));
          await repo.hapusAkrual(tx, h.periode.id, h.daftar);
          await repo.tulisAkrual(
            tx,
            {
              periodeId: h.periode.id,
              userId: ctx.userId,
              // migrations/0025. Both are the policy that produced this run, in
              // hand already and previously discarded; `konfigurasi` is mutated
              // in place, so without them a closed period cannot say why its
              // population was its population. `metode` can only ever be
              // ACCRUAL here, because CASH_BASIS returned above without writing
              // anything, and the column's CHECK says exactly that.
              metode: h.metode,
              kelasDiakrual: JSON.stringify(h.kelas),
            },
            h.baris.map((b) => ({
              akadId: b.akadId,
              cabangId: b.cabangId,
              kolektibilitas: b.kolektibilitas,
              jatuhTempo: b.jasaJatuhTempoPeriode,
              diterima: b.jasaDiterimaPeriode,
              diakrual: b.jasaDiakrual,
              jurnalId: nol(b.jasaDiakrual) ? null : (jurnalPerCabang.get(b.cabangId) ?? null),
            })),
          );

          return {
            periodeId: h.periode.id,
            metode: h.metode,
            kelasDiakrual: h.kelas,
            dilewati: false,
            baris: h.baris,
            totalPerCabang: hasilCabang,
          };
        });
      });
    },

    // --- 8.4 --------------------------------------------------------------

    periksaPrasyarat(periodeId, ctx): Promise<DaftarPrasyarat> {
      return bersihkan(async () => {
        // Reading the checklist is a separate act from executing the close, and
        // an Approver does the first before deciding whether to do the second.
        wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);
        // Pure read: not even a CLOSING_IN_PROGRESS marker. The UI runs this on
        // every page load, so it has to be free of consequences.
        const periode = await periodeWajib(db, periodeId, ctx.bumnId);
        return jalankanPrasyarat(db, periode, ctx);
      });
    },

    tutupPeriode(input: TutupPeriodeInput, ctx): Promise<HasilTutupPeriode> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.PERIODE);
        return db.transaction(async (tx) => {
          // THE ROW LOCK, taken before the checklist and held to COMMIT.
          // Without it two concurrent closes both read OPEN, both evaluate the
          // checklist against the same committed state, both pass, and both
          // write a SUKSES audit record for a period that was closed once.
          // Monthly closing makes that unlikely and the frozen trial balance
          // makes it expensive, which is the worst combination to leave to
          // chance.
          const periode = await periodeUntukUbah(tx, input.periodeId, ctx.bumnId);
          if (periode.status === "CLOSED") {
            // A second close that silently rewrote the frozen balances would be
            // invariant 14 broken with no trace: both runs look identical in
            // the audit log.
            throw tolak("PERIODE_SUDAH_CLOSED", { periodeId: periode.id });
          }

          // Re-evaluated INSIDE the transaction. A check that passed a minute
          // ago is not evidence: a Maker saves a draft while the Approver is
          // looking at a green checklist, and that is the ordinary case in a
          // multi-user system rather than an exotic one.
          const prasyarat = await jalankanPrasyarat(tx, periode, ctx);
          const gagal = prasyarat.hasil.filter((h) => h.status === "GAGAL");
          if (gagal.length > 0) {
            await audit?.record({
              userId: ctx.userId,
              aksi: "closing.periode",
              entitas: "periode",
              entitasId: periode.id,
              nilaiBaru: { gagal: gagal.map((g) => g.kode) },
              hasil: "DITOLAK",
              keterangan: `Closing periode ${labelPeriode(periode)} ditolak: ${gagal
                .map((g) => g.kode)
                .join(", ")}`,
            });
            throw tolak("PRASYARAT_GAGAL", { periodeId: periode.id, gagal });
          }

          const peringatan = prasyarat.hasil.filter((h) => h.status === "PERINGATAN");
          if (peringatan.length > 0 && input.konfirmasiKasNegatif !== true) {
            // A confirmation that can be skipped by not passing a flag is not a
            // confirmation.
            throw tolak("KONFIRMASI_KAS_NEGATIF_WAJIB", {
              periodeId: periode.id,
              peringatan: peringatan.map((p) => p.kode),
            });
          }

          // THE FROZEN TRIAL BALANCE, from `v_ledger_baris` (ADR 0010).
          const saldo = await repo.saldoAkunUntukPeriode(
            tx,
            periode.bumn_id,
            periode.tanggal_mulai,
            periode.tanggal_akhir,
          );
          await repo.hapusSaldoAkunPeriode(tx, periode.id);
          await repo.tulisSaldoAkunPeriode(tx, periode.id, ctx.userId, saldo);

          const ditutup = await repo.tandaiClosed(
            tx,
            periode.id,
            ctx.userId,
            jam().toISOString(),
          );
          // The second half of the lock. `tandaiClosed` carries
          // `status <> 'CLOSED'`, so a close that lost a race updates nothing
          // and finds out here instead of writing a SUKSES audit row for
          // somebody else's close.
          if (!ditutup) throw tolak("PERIODE_SUDAH_CLOSED", { periodeId: periode.id });

          await audit?.record(
            {
              userId: ctx.userId,
              aksi: "closing.periode",
              entitas: "periode",
              entitasId: periode.id,
              nilaiLama: { status: periode.status },
              // The checklist as it stood travels with the record, so the log
              // says what was true when the decision was made rather than what
              // is true whenever someone next looks.
              nilaiBaru: {
                status: "CLOSED",
                prasyarat: prasyarat.hasil.map((h) => ({
                  nomor: h.nomor,
                  kode: h.kode,
                  status: h.status,
                })),
                konfirmasiKasNegatif: input.konfirmasiKasNegatif === true,
                jumlahSaldoDibekukan: saldo.length,
              },
              hasil: "SUKSES",
              keterangan:
                `Closing periode ${labelPeriode(periode)}` +
                (peringatan.length > 0
                  ? `; peringatan dikonfirmasi: ${peringatan.map((p) => p.kode).join(", ")}`
                  : ""),
            },
            tx,
          );

          return {
            periode: keProfilPeriode(ditutup),
            prasyarat,
            saldo: keSaldoPublik(periode.id, saldo),
          };
        });
      });
    },

    bukaKembaliPeriode(input: ReopenPeriodeInput, ctx): Promise<PeriodeClosing> {
      return bersihkan(async () => {
        // The asymmetry is the control: closing a period is an operational act,
        // reopening one rewrites a period that has already been reported on,
        // which is why spec 2 puts it with Admin Pusat and nowhere else.
        wajibIzin(ctx, PERMISSION_CLOSING.REOPEN);
        const alasan = (input.alasan ?? "").trim();
        if (alasan === "") throw tolak("ALASAN_WAJIB", { periodeId: input.periodeId });
        return db.transaction(async (tx) => {
          const izinkan = await konfigBoolean(
            tx,
            ctx.bumnId,
            KUNCI_KONFIGURASI_CLOSING.IZINKAN_REOPEN,
          );
          if (!izinkan) throw tolak("REOPEN_TIDAK_DIIZINKAN", { periodeId: input.periodeId });

          // Locked for the same reason `tutupPeriode` locks: a reopen decides
          // on `periodeClosedLebihBaru`, which is only evidence if no other
          // session can close a later period between the read and the write.
          const periode = await periodeUntukUbah(tx, input.periodeId, ctx.bumnId);
          if (periode.status !== "CLOSED") {
            throw tolak("PERIODE_BELUM_CLOSED", { periodeId: periode.id, status: periode.status });
          }
          const lebihBaru = await repo.periodeClosedLebihBaru(
            tx,
            periode.bumn_id,
            periode.tahun,
            periode.bulan,
          );
          if (lebihBaru.length > 0) {
            // Reopening an earlier period while a later one is closed would
            // leave closed periods whose figures were computed on top of a
            // period that is open again, i.e. invariant 6 violated from inside.
            throw tolak("REOPEN_BUKAN_PERIODE_TERAKHIR", {
              periodeId: periode.id,
              periodeLebihBaru: lebihBaru.map((p) => ({ id: p.id, tahun: p.tahun, bulan: p.bulan })),
            });
          }

          // Spec 8.4: reopening DELETES the frozen balances. Safe precisely
          // because they are derived data, fully regenerable from the ledger,
          // which is also why deleting a `jurnal` row never is.
          await repo.hapusSaldoAkunPeriode(tx, periode.id);
          const dibuka = await repo.tandaiOpenKembali(
            tx,
            periode.id,
            ctx.userId,
            alasan,
            jam().toISOString(),
          );
          if (!dibuka) throw tolak("PERIODE_BELUM_CLOSED", { periodeId: periode.id });

          await audit?.record(
            {
              userId: ctx.userId,
              aksi: "periode.reopen",
              entitas: "periode",
              entitasId: periode.id,
              nilaiLama: { status: "CLOSED" },
              nilaiBaru: { status: "OPEN", alasanReopen: alasan },
              hasil: "SUKSES",
              keterangan: `Buka kembali periode ${labelPeriode(periode)}: ${alasan}`,
            },
            tx,
          );

          return keProfilPeriode(dibuka);
        });
      });
    },

    saldoAkunPeriode(filter: FilterSaldoAkunPeriode, ctx): Promise<SaldoAkunPeriode[]> {
      return bersihkan(async () => {
        wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);
        await periodeWajib(db, filter.periodeId, ctx.bumnId);
        if (filter.cabangId) wajibScope(ctx, filter.cabangId);
        const rows = await repo.bacaSaldoAkunPeriode(db, filter);
        return keSaldoPublik(filter.periodeId, rows);
      });
    },
  };
}
