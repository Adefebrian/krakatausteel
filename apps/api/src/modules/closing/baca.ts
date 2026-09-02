// Read models for the closing HTTP surface (spec 9.3's two Admin screens), and
// nothing else.
//
// WHY THIS FILE EXISTS SEPARATELY FROM ./service.ts
// `ClosingEngine` answers with what a closing step PRODUCED: the checklist, the
// migration matrix, the allowance movement, the frozen trial balance. The two
// screens of spec 9.3 need something the engine has no business carrying --
// what the operator picks BEFORE any of that runs. Which months exist and what
// state each is in; which branches this caller may classify or close for; and
// which of spec 5.6's accounting policies are in force, because they decide
// whether the accrual step will do anything at all and whether the reopen
// button may be offered. Those are projections, not behaviour, so they live
// here rather than widening an engine whose tests pin its current shape.
//
// IT FOLLOWS modules/rka/baca.ts AND modules/pumk/baca.ts, and obeys the same
// three rules:
//
// 1. BRANCH SCOPE COMES FROM THE SESSION, NEVER FROM THE REQUEST. The one
//    branch-shaped list here (`cabang`) is built from the branches the SESSION
//    resolved, and there is no by-id read in this file, so there is no id to
//    manipulate. The by-id reads that matter (a period, its frozen balances)
//    stay on the engine, which compares against the branch the ROW reports.
//
// 2. NO SECOND OPINION ABOUT POLICY. `kapabilitas` resolves the SAME
//    configuration keys through the SAME repo the engine reads
//    (`KUNCI_KONFIGURASI_CLOSING`), so the screen greys the reopen button
//    exactly when `bukaKembaliPeriode` would refuse, and shows "akrual
//    dilewati" exactly when spec 8.3 would skip. A missing or malformed key is
//    a REFUSAL here too, not a guessed default: a screen that quietly assumed
//    `izinkan_reopen_periode = true` would offer a control the engine refuses,
//    and one that assumed `false` would hide a control an operator is entitled
//    to.
//
// 3. IT WRITES NOTHING. Every function here is a SELECT. That is the whole
//    reason `admin.closing.view` exists as a code separate from
//    `admin.closing.periode` (spec 16 scenario 23): an Auditor reads the
//    evidence with no code that can run anything.
import { canonicalPermission } from "../auth/index";
import type { QueryRunner } from "../../core/ports/db";
import { buatRepoClosing } from "./repo";
import {
  ClosingError,
  KUNCI_KONFIGURASI_CLOSING,
  PERMISSION_CLOSING,
  type ClosingContext,
  type ClosingDbPort,
  type DasarPerhitunganPenyisihan,
  type KelasKolektibilitas,
  type MetodePengakuanJasa,
  type ModePenyisihan,
  type StatusPeriode,
} from "./contract";

export interface ClosingBacaDeps {
  db: ClosingDbPort;
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

/**
 * One row of the period picker both closing screens open on.
 *
 * `closedOleh` and `dibukaKembaliOleh` are NAMES, resolved by join, because the
 * audit question an accountant asks about a closed month is "who closed it",
 * and a uuid answers that only for somebody with database access.
 *
 * `jumlahSaldoBeku` is the evidence counter: a CLOSED period with zero frozen
 * rows is the state spec 10's reports refuse to print from
 * (`SALDO_PERIODE_BELUM_DIBEKUKAN`), and a screen that cannot see it sends the
 * operator to a report to discover it.
 */
export interface OpsiPeriodeClosing {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: StatusPeriode;
  closedBy: string | null;
  closedOleh: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  dibukaKembaliOleh: string | null;
  reopenedAt: string | null;
  alasanReopen: string | null;
  /** migrations/0028. NULL means "no stamp"; see `PeriodeClosing` in ./contract.ts. */
  templateLaporanId: string | null;
  jumlahSaldoBeku: number;
}

export interface OpsiCabangClosing {
  id: string;
  kode: string;
  nama: string;
}

/**
 * The accounting policies of spec 5.6 that decide what the two screens may
 * OFFER. Every field is READ from `konfigurasi`; not one is a literal in this
 * repo.
 */
export interface KapabilitasClosing {
  /** `akuntansi.izinkan_reopen_periode`. false makes the reopen route refuse. */
  izinkanReopen: boolean;
  /** `akuntansi.metode_pengakuan_jasa_adm`. CASH_BASIS means 8.3 does nothing. */
  metodePengakuanJasa: MetodePengakuanJasa;
  /** The classes 8.3 restricts itself to, when it runs at all. */
  kelasDiakrual: readonly KelasKolektibilitas[];
  modePenyisihan: ModePenyisihan;
  dasarPerhitunganPenyisihan: DasarPerhitunganPenyisihan;
  /** `kas.izinkan_saldo_kas_negatif`. Decides whether check 8 can be a PERINGATAN. */
  izinkanSaldoKasNegatif: boolean;
}

/**
 * Everything the Closing Kolektibilitas and Closing Periode screens need before
 * an operator picks anything.
 */
export interface ReferensiClosing {
  cabang: OpsiCabangClosing[];
  /**
   * True only for a caller whose scope covers every branch of the entity. Spec
   * 8.1 runs across every branch at once when no branch is named, and offering
   * that to a branch user would offer a run the engine refuses.
   */
  bolehSemuaCabang: boolean;
  kapabilitas: KapabilitasClosing;
}

export interface FilterPeriodeClosing {
  tahun?: number | null;
  status?: StatusPeriode | null;
}

export interface ClosingBaca {
  referensi(ctx: ClosingContext): Promise<ReferensiClosing>;
  /** The entity's accounting periods, newest first. Both screens' month picker. */
  daftarPeriode(
    filter: FilterPeriodeClosing,
    ctx: ClosingContext,
  ): Promise<OpsiPeriodeClosing[]>;
  /** One period, or a `PERIODE_TIDAK_DITEMUKAN` refusal. */
  periode(periodeId: string, ctx: ClosingContext): Promise<OpsiPeriodeClosing>;
}

// ---------------------------------------------------------------------------
// Guards, mirrored from the engine
// ---------------------------------------------------------------------------

/**
 * Fails closed on an unregistered code, exactly as ./service.ts's `wajibIzin`
 * does and for the same reason: a code the shipped catalogue does not know is a
 * configuration fault, and reporting it as TIDAK_BERWENANG would dress it up as
 * a policy decision and hide it forever.
 *
 * The router already ran `requirePermission`, so this is the second line. It
 * stays because a read model reachable from a later batch job or a seed must
 * refuse on its own evidence rather than on its caller's good manners.
 */
function wajibIzin(ctx: ClosingContext, kode: string): void {
  const kanonik = canonicalPermission(kode);
  if (!kanonik) {
    throw new ClosingError(
      "IZIN_BELUM_TERDAFTAR",
      `Kewenangan "${kode}" belum terdaftar di katalog izin, jadi tindakan ini ditolak sampai kewenangannya ditambahkan.`,
      { permission: kode },
    );
  }
  if (!ctx.permissions.includes(kanonik)) {
    throw new ClosingError(
      "TIDAK_BERWENANG",
      "Pengguna ini tidak punya wewenang untuk melihat data closing tersebut.",
      { permission: kanonik },
    );
  }
}

function cabangTerlihat(ctx: ClosingContext): string[] {
  return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface BarisPeriode {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: StatusPeriode;
  closedBy: string | null;
  closedOleh: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  dibukaKembaliOleh: string | null;
  reopenedAt: string | null;
  alasanReopen: string | null;
  templateLaporanId: string | null;
  jumlahSaldoBeku: string;
}

/**
 * `jumlah_saldo_beku` as a correlated subquery rather than a join with GROUP
 * BY: `saldo_akun_periode` carries one row per (periode, cabang, akun) and a
 * join would multiply the period row before it was counted.
 */
const KOLOM_PERIODE = `
  p.id::text as id, p.tahun::int as tahun, p.bulan::int as bulan,
  p.tanggal_mulai::text as "tanggalMulai", p.tanggal_akhir::text as "tanggalAkhir",
  p.status,
  p.closed_by::text as "closedBy", uc.nama as "closedOleh",
  p.closed_at::text as "closedAt",
  p.reopened_by::text as "reopenedBy", ur.nama as "dibukaKembaliOleh",
  p.reopened_at::text as "reopenedAt",
  p.alasan_reopen as "alasanReopen",
  p.template_laporan_id::text as "templateLaporanId",
  (select count(*) from saldo_akun_periode s where s.periode_id = p.id)::text as "jumlahSaldoBeku"`;

const SUMBER_PERIODE = `
  from periode p
  left join app_user uc on uc.id = p.closed_by
  left join app_user ur on ur.id = p.reopened_by`;

function keOpsi(row: BarisPeriode): OpsiPeriodeClosing {
  const { jumlahSaldoBeku, ...sisa } = row;
  return { ...sisa, jumlahSaldoBeku: Number(jumlahSaldoBeku) };
}

export function buatClosingBaca({ db }: ClosingBacaDeps): ClosingBaca {
  const repo = buatRepoClosing();
  const tx = (): QueryRunner => db;

  /**
   * One configuration key, through the module's OWN repo, so the value the
   * screen shows and the value the engine acts on cannot disagree. Absent is a
   * refusal, never a default: see rule 2 in this file's header.
   */
  async function konfig(
    ctx: ClosingContext,
    { grup, kunci }: { grup: string; kunci: string },
  ): Promise<string> {
    const mentah = await repo.konfigurasi(tx(), ctx.bumnId, grup, kunci);
    if (mentah === null) {
      throw new ClosingError(
        "KONFIGURASI_TIDAK_ADA",
        `Parameter konfigurasi ${grup}.${kunci} belum ada. Lengkapi dulu konfigurasinya sebelum membuka layar closing.`,
        { grup, kunci },
      );
    }
    return mentah;
  }

  async function konfigBoolean(
    ctx: ClosingContext,
    kunci: { grup: string; kunci: string },
  ): Promise<boolean> {
    const nilai = (await konfig(ctx, kunci)).trim().toLowerCase();
    if (nilai === "true") return true;
    if (nilai === "false") return false;
    throw new ClosingError(
      "KONFIGURASI_TIDAK_VALID",
      `Nilai parameter konfigurasi ${kunci.grup}.${kunci.kunci} tidak valid: wajib true atau false. Proses dihentikan alih alih memakai nilai tebakan.`,
      { ...kunci, nilai },
    );
  }

  async function konfigPilihan<T extends string>(
    ctx: ClosingContext,
    kunci: { grup: string; kunci: string },
    pilihan: readonly T[],
  ): Promise<T> {
    const nilai = (await konfig(ctx, kunci)).trim();
    if ((pilihan as readonly string[]).includes(nilai)) return nilai as T;
    throw new ClosingError(
      "KONFIGURASI_TIDAK_VALID",
      `Nilai parameter konfigurasi ${kunci.grup}.${kunci.kunci} tidak valid: wajib salah satu dari ${pilihan.join(", ")}. Proses dihentikan alih alih memakai nilai tebakan.`,
      { ...kunci, nilai },
    );
  }

  /**
   * `akuntansi.akrual_hanya_untuk_kolektibilitas` is a JSON array of class
   * codes. An empty array is legitimate (accrue nothing); anything that is not
   * an array of known classes is a refusal, because guessing here would make
   * the screen promise an accrual the engine will not perform.
   */
  async function kelasAkrual(ctx: ClosingContext): Promise<KelasKolektibilitas[]> {
    const kunci = KUNCI_KONFIGURASI_CLOSING.AKRUAL_HANYA_UNTUK;
    const mentah = await konfig(ctx, kunci);
    const dikenal: readonly KelasKolektibilitas[] = [
      "LANCAR",
      "KURANG_LANCAR",
      "DIRAGUKAN",
      "MACET",
    ];
    let parsed: unknown;
    try {
      parsed = JSON.parse(mentah);
    } catch {
      parsed = null;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((k) => typeof k !== "string" || !dikenal.includes(k as KelasKolektibilitas))
    ) {
      throw new ClosingError(
        "KONFIGURASI_TIDAK_VALID",
        `Nilai parameter konfigurasi ${kunci.grup}.${kunci.kunci} tidak valid: wajib daftar kelas kolektibilitas. Proses dihentikan alih alih memakai nilai tebakan.`,
        { ...kunci, nilai: mentah },
      );
    }
    return parsed as KelasKolektibilitas[];
  }

  return {
    async referensi(ctx) {
      wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);

      // Every branch of the entity, then narrowed to what the SESSION allows.
      // Narrowed here rather than filtered in SQL by an id from the request:
      // the request never names a branch on this route, and the comparison that
      // decides the answer is against the session, not against a payload.
      const semua = await tx().query<OpsiCabangClosing>(
        `select id::text as id, kode, nama
           from cabang
          where bumn_id = $1::uuid and deleted_at is null and aktif = true
          order by kode`,
        [ctx.bumnId],
      );
      const terlihat = new Set(cabangTerlihat(ctx));

      return {
        cabang: semua.filter((c) => terlihat.has(c.id)),
        bolehSemuaCabang: semua.length > 0 && semua.every((c) => terlihat.has(c.id)),
        kapabilitas: {
          izinkanReopen: await konfigBoolean(ctx, KUNCI_KONFIGURASI_CLOSING.IZINKAN_REOPEN),
          metodePengakuanJasa: await konfigPilihan<MetodePengakuanJasa>(
            ctx,
            KUNCI_KONFIGURASI_CLOSING.METODE_PENGAKUAN_JASA,
            ["CASH_BASIS", "ACCRUAL"],
          ),
          kelasDiakrual: await kelasAkrual(ctx),
          modePenyisihan: await konfigPilihan<ModePenyisihan>(
            ctx,
            KUNCI_KONFIGURASI_CLOSING.MODE_PENYISIHAN,
            ["RATE_TABLE", "KOLEKTIF_HISTORIS"],
          ),
          dasarPerhitunganPenyisihan: await konfigPilihan<DasarPerhitunganPenyisihan>(
            ctx,
            KUNCI_KONFIGURASI_CLOSING.DASAR_PENYISIHAN,
            ["OUTSTANDING_POKOK", "OUTSTANDING_POKOK_PLUS_JASA"],
          ),
          izinkanSaldoKasNegatif: await konfigBoolean(
            ctx,
            KUNCI_KONFIGURASI_CLOSING.IZINKAN_KAS_NEGATIF,
          ),
        },
      };
    },

    async daftarPeriode(filter, ctx) {
      wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);
      const params: unknown[] = [ctx.bumnId];
      let where = "";
      if (filter.tahun !== undefined && filter.tahun !== null) {
        params.push(filter.tahun);
        where += ` and p.tahun = $${params.length}`;
      }
      if (filter.status !== undefined && filter.status !== null) {
        params.push(filter.status);
        where += ` and p.status = $${params.length}`;
      }
      const rows = await tx().query<BarisPeriode>(
        `select ${KOLOM_PERIODE} ${SUMBER_PERIODE}
          where p.bumn_id = $1::uuid and p.deleted_at is null${where}
          order by p.tahun desc, p.bulan desc`,
        params,
      );
      return rows.map(keOpsi);
    },

    async periode(periodeId, ctx) {
      wajibIzin(ctx, PERMISSION_CLOSING.LIHAT);
      // Scoped to the caller's OWN entity in the WHERE clause, so an id from
      // another bumn reads as "not found" rather than as somebody else's month.
      const rows = await tx().query<BarisPeriode>(
        `select ${KOLOM_PERIODE} ${SUMBER_PERIODE}
          where p.id = $1::uuid and p.bumn_id = $2::uuid and p.deleted_at is null`,
        [periodeId, ctx.bumnId],
      );
      const row = rows[0];
      if (!row) {
        throw new ClosingError("PERIODE_TIDAK_DITEMUKAN", "Periode akuntansi tidak ditemukan.", {
          periodeId,
        });
      }
      return keOpsi(row);
    },
  };
}
