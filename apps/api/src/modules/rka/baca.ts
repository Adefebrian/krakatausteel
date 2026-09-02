// Read models for the RKA HTTP surface (spec 9.3), and nothing else.
//
// WHY THIS FILE EXISTS SEPARATELY FROM ./service.ts
// `RkaEngine` answers with what is STORED: a version, its lines, the baseline,
// report 24. Spec 9.3's three entry screens need something the engine has no
// business carrying -- the OPTIONS a budget line may be entered against. RKA
// PUMK is per sektor, RKA Non PUMK is per bidang and RKA Keuangan is per
// budgetable account, so a grid cannot be rendered at all without the list for
// the type being entered. Those joins are a projection, not behaviour, so they
// live here rather than widening an engine whose tests pin its current shape.
//
// THE THREE RULES THIS FILE OBEYS, the same three modules/pumk/baca.ts states:
//
// 1. BRANCH SCOPE IS ENFORCED AGAINST THE BRANCH THE ROW REPORTS, and the one
//    list here that is branch-shaped (`cabangDapatDianggarkan`) is built from
//    the SESSION's visible set, never from anything in the request. There is
//    no by-id read in this file, so there is no id to manipulate.
//
// 2. NO ARITHMETIC OF ITS OWN, and in particular NO SECOND OPINION ABOUT WHAT
//    MAY BE BUDGETED. `akunDapatDianggarkan` reproduces the engine's rule
//    (postable, and BEBAN or PENDAPATAN) as a QUERY so the form offers exactly
//    what `simpanBaris` would accept. If the two ever disagree the form is the
//    one that is wrong, and ./rka-rute-otorisasi.test.ts posts a line built
//    from this list through the real endpoint so a drift fails a test rather
//    than an operator's afternoon.
//
// 3. IT WRITES NOTHING. Every function here is a SELECT. This module has no
//    journal port at all (see ./contract.ts), so nothing in it can reach the
//    ledger even by accident.
import { canonicalPermission } from "../auth/index";
import type { QueryRunner } from "../../core/ports/db";
import { buatRepoRka } from "./repo";
import {
  DIMENSI_UNTUK_JENIS,
  KUNCI_KONFIGURASI_RKA,
  PERMISSION_RKA,
  RkaError,
  type DimensiRka,
  type JenisRka,
  type RkaContext,
  type RkaDbPort,
  type StatusPeriode,
} from "./contract";

export interface RkaBacaDeps {
  db: RkaDbPort;
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

export interface OpsiDimensiRka {
  id: string;
  kode: string;
  nama: string;
}

export interface OpsiCabangRka {
  id: string;
  kode: string;
  nama: string;
}

export interface OpsiPeriodeRka {
  id: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: StatusPeriode;
}

/**
 * Everything the three entry screens of spec 9.3 need before an operator can
 * type a number: which dimension this budget type is entered against, the rows
 * of that dimension, the branches this caller may budget for, and the month
 * the financial year starts in (spec 5.6), which is what makes report 24's
 * year-to-date column mean anything.
 */
export interface ReferensiRka {
  jenis: JenisRka;
  dimensi: DimensiRka;
  opsi: OpsiDimensiRka[];
  cabang: OpsiCabangRka[];
  /**
   * True only for a caller whose scope covers every branch of the entity. A
   * consolidated budget (`cabang_id IS NULL`) belongs to the entity, so
   * offering it to a branch user would offer a document their own engine would
   * refuse to let them approve.
   */
  bolehKonsolidasi: boolean;
  /** spec 5.6. READ, never assumed to be January. */
  tahunBukuMulaiBulan: number;
}

export interface RkaBaca {
  referensi(jenis: JenisRka, ctx: RkaContext): Promise<ReferensiRka>;
  /** Accounting periods of the entity, newest first. The report's month picker. */
  daftarPeriode(
    filter: { tahun?: number | null },
    ctx: RkaContext,
  ): Promise<OpsiPeriodeRka[]>;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The three dimension lists, each keyed by the budget type it belongs to.
 *
 * `akun` mirrors the engine's `AKUN_TIDAK_DAPAT_DIANGGARKAN` rule exactly:
 * report 24 compares a budget against a PERIOD MOVEMENT, and a balance-sheet
 * account's movement is not an achievement against a target, so only postable
 * BEBAN and PENDAPATAN accounts may carry a budget line.
 */
const SQL_OPSI: Readonly<Record<DimensiRka, string>> = {
  AKUN: `select id::text as id, kode, nama
           from akun
          where bumn_id = $1::uuid and deleted_at is null and aktif = true
            and is_postable = true and tipe in ('BEBAN', 'PENDAPATAN')
          order by kode`,
  SEKTOR: `select id::text as id, kode, nama
             from sektor_pumk
            where bumn_id = $1::uuid and deleted_at is null
            order by kode`,
  BIDANG: `select id::text as id, kode, nama
             from bidang_non_pumk
            where bumn_id = $1::uuid and deleted_at is null
            order by kode`,
};

interface CabangRow {
  id: string;
  kode: string;
  nama: string;
}

/**
 * Fails closed on an unregistered code, exactly as the engine's `wajibIzin`
 * does and for the same reason: a code the shipped catalogue does not know is
 * a configuration fault, and reporting it as TIDAK_BERWENANG would dress it up
 * as a policy decision and hide it forever.
 *
 * The router already ran `requirePermission`, so this is the second line. It
 * stays because a read model reachable from a later batch job or a seed must
 * refuse on its own evidence rather than on its caller's good manners.
 */
function wajibIzin(ctx: RkaContext, kode: string): void {
  const kanonik = canonicalPermission(kode);
  if (!kanonik) {
    throw new RkaError(
      "IZIN_BELUM_TERDAFTAR",
      `Kewenangan "${kode}" belum terdaftar di katalog izin, jadi tindakan ini ditolak sampai kewenangannya ditambahkan.`,
      { permission: kode },
    );
  }
  if (!ctx.permissions.includes(kanonik)) {
    throw new RkaError(
      "TIDAK_BERWENANG",
      "Pengguna ini tidak punya wewenang untuk tindakan RKA tersebut.",
      { permission: kanonik },
    );
  }
}

function cabangTerlihat(ctx: RkaContext): string[] {
  return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
}

export function buatRkaBaca({ db }: RkaBacaDeps): RkaBaca {
  const repo = buatRepoRka();
  const tx = (): QueryRunner => db;

  /**
   * spec 5.6, through the module's OWN repo rather than a second copy of the
   * resolution order. The engine reads the same key through the same query, so
   * the month the form shows and the month report 24 cumulates from cannot
   * disagree.
   */
  async function tahunBukuMulaiBulan(ctx: RkaContext): Promise<number> {
    const { grup, kunci } = KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN;
    const mentah = await repo.konfigurasi(tx(), ctx.bumnId, grup, kunci);
    if (mentah === null) {
      throw new RkaError(
        "KONFIGURASI_TIDAK_ADA",
        `Parameter konfigurasi ${grup}.${kunci} belum ada. Lengkapi dulu konfigurasinya sebelum menjalankan tindakan ini.`,
        { grup, kunci },
      );
    }
    const bulan = Number.parseInt(mentah, 10);
    if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12) {
      throw new RkaError(
        "KONFIGURASI_TIDAK_VALID",
        `Nilai parameter konfigurasi ${grup}.${kunci} tidak valid. Proses dihentikan alih alih memakai nilai tebakan.`,
        { grup, kunci, nilai: mentah },
      );
    }
    return bulan;
  }

  return {
    async referensi(jenis, ctx) {
      wajibIzin(ctx, PERMISSION_RKA.LIHAT);
      const dimensi = DIMENSI_UNTUK_JENIS[jenis];
      const opsi = await tx().query<OpsiDimensiRka>(SQL_OPSI[dimensi], [ctx.bumnId]);

      // Every branch of the entity, then narrowed to what the SESSION allows.
      // Narrowed here rather than filtered in SQL by an id from the request:
      // the request never names a branch on this route, and the comparison
      // that decides the answer is against the session, not against a payload.
      const semua = await tx().query<CabangRow>(
        `select id::text as id, kode, nama
           from cabang
          where bumn_id = $1::uuid and deleted_at is null and aktif = true
          order by kode`,
        [ctx.bumnId],
      );
      const terlihat = new Set(cabangTerlihat(ctx));
      const cabang = semua.filter((c) => terlihat.has(c.id));

      return {
        jenis,
        dimensi,
        opsi,
        cabang,
        bolehKonsolidasi: semua.length > 0 && semua.every((c) => terlihat.has(c.id)),
        tahunBukuMulaiBulan: await tahunBukuMulaiBulan(ctx),
      };
    },

    async daftarPeriode(filter, ctx) {
      wajibIzin(ctx, PERMISSION_RKA.LIHAT);
      const params: unknown[] = [ctx.bumnId];
      let where = "";
      if (filter.tahun !== undefined && filter.tahun !== null) {
        params.push(filter.tahun);
        where = ` and tahun = $${params.length}`;
      }
      return tx().query<OpsiPeriodeRka>(
        `select id::text as id, tahun::int as tahun, bulan::int as bulan,
                tanggal_mulai::text as "tanggalMulai", tanggal_akhir::text as "tanggalAkhir",
                status
           from periode
          where bumn_id = $1::uuid and deleted_at is null${where}
          order by tahun desc, bulan desc`,
        params,
      );
    },
  };
}
