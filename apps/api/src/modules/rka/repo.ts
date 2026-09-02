// Data access for the RKA module. Private to the module; ./service.ts is the
// only caller and ./index.ts is the only door in.
//
// ---------------------------------------------------------------------------
// THE FOUR DRIVER FACTS THIS FILE OBEYS (modules/jurnal/repo.ts records them)
// ---------------------------------------------------------------------------
// 1. A JS ARRAY binds as a bare comma-joined string under `bun:sql`, so
//    `= ANY($n::uuid[])` fails with 22P02 "malformed array literal". Every
//    id-set predicate below is therefore an explicit `IN ($3, $4, ...)` list
//    built by `daftar()`, not an array parameter.
// 2. A jsonb parameter bound from a JS string is stored as a JSON string
//    SCALAR, so a jsonb write needs `$n::text::jsonb`. This module writes no
//    jsonb; it only READS `dimensi_json ->> 'bidangId'`, which is safe.
// 3. Dates and timestamps come back as `Date` objects, so every date column is
//    selected `::text` and stays a string all the way to the contract.
// 4. `coalesce(sum(x), 0)` yields '0', NOT '0.00', and fails `POLA_UANG`. Every
//    money projection casts `::numeric(20,2)` BEFORE `::text`. Report 24 is
//    mostly zeroes, so that path is hit on the first run rather than on some
//    unlucky edge case.
//
// ---------------------------------------------------------------------------
// WHERE REALISATION COMES FROM, RESTATED AS QUERIES
// ---------------------------------------------------------------------------
// `realisasiLedger*` read `v_ledger_baris`, the SHIPPED view whose predicate is
// `status IN ('POSTED','REVERSED')`. Never `status = 'POSTED'` alone: ADR 0010
// and migrations/0018, correction is by reversing entry and both sets of lines
// stay in the ledger and cancel, so a POSTED-only filter subtracts a correction
// it never added. In a budget report that defect is invisible, because report
// 24 has no balance to check.
//
// `realisasiBeku` reads `saldo_akun_periode`, the trial balance the closing
// engine froze. That is spec 10's own rule and invariant 14: a past period's
// report must reproduce.
//
// There is deliberately NO query here that sums `pumk_pencairan` or
// `nonpumk_penyaluran`. Those tables are what the DISBURSEMENT reports read,
// and spec 16 scenario 18 requires this report to AGREE with them rather than
// becoming a second implementation of them. The PUMK figure is the ledger's own
// disbursement lines, reached through `jurnal.referensi_tipe = 'pumk_pencairan'`
// (the back-reference the ledger stores for exactly this purpose, and which a
// reversing journal carries too, so a reversal nets out).
import type { QueryRunner } from "../../core/ports/db";
import type { DimensiRka, JenisRka, StatusPeriode, StatusRka } from "./contract";

export interface RkaRow {
  id: string;
  bumn_id: string;
  cabang_id: string | null;
  tahun: number;
  jenis: JenisRka;
  status: StatusRka;
  versi: number;
  approved_by: string | null;
  approved_at: string | null;
  keterangan: string | null;
  created_by: string | null;
  updated_by: string | null;
}

export interface BarisRkaRow {
  id: string;
  rka_id: string;
  akun_id: string | null;
  sektor_id: string | null;
  bidang_id: string | null;
  uraian: string;
  bulan: number | null;
  jumlah_anggaran: string;
  jumlah_unit: number | null;
  keterangan: string | null;
}

export interface PeriodeRow {
  id: string;
  tahun: number;
  bulan: number;
  tanggal_mulai: string;
  tanggal_akhir: string;
  status: StatusPeriode;
}

export interface AkunRow {
  id: string;
  kode: string;
  nama: string;
  tipe: string;
  saldo_normal: "D" | "K";
  is_postable: boolean;
}

export interface DimensiRow {
  id: string;
  kode: string;
  nama: string;
}

/** The three rows report 24's header is printed from (spec 10's preamble). */
export interface BumnRow {
  nama: string;
}

export interface PenggunaRow {
  nama: string;
}

export interface CabangRow {
  id: string;
  kode: string;
  nama: string;
}

/** One dimension's movement in a window, debit-positive, in `nilai`. */
export interface AgregatRow {
  dimensi_id: string | null;
  nilai: string;
  unit: string | null;
}

const KOLOM_RKA = `id::text as id, bumn_id::text as bumn_id, cabang_id::text as cabang_id,
   tahun::int as tahun, jenis, status, versi::int as versi,
   approved_by::text as approved_by, approved_at::text as approved_at,
   keterangan, created_by::text as created_by, updated_by::text as updated_by`;

const KOLOM_BARIS = `id::text as id, rka_id::text as rka_id, akun_id::text as akun_id,
   sektor_id::text as sektor_id, bidang_id::text as bidang_id, uraian, bulan::int as bulan,
   jumlah_anggaran::numeric(20,2)::text as jumlah_anggaran, jumlah_unit::int as jumlah_unit,
   keterangan`;

/**
 * Appends `nilai` to `params` and returns the placeholder list for an IN clause.
 * See driver fact 1: an array parameter is not an option here.
 */
function daftar(params: unknown[], nilai: readonly string[]): string {
  const mulai = params.length + 1;
  params.push(...nilai);
  return nilai.map((_, i) => `$${mulai + i}`).join(", ");
}

async function satu<T>(tx: QueryRunner, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await tx.query<T>(sql, params);
  return rows[0] ?? null;
}

export interface RepoRka {
  rkaById(tx: QueryRunner, id: string): Promise<RkaRow | null>;
  rkaByIdTerkunci(tx: QueryRunner, id: string): Promise<RkaRow | null>;
  rkaByVersi(
    tx: QueryRunner,
    kunci: { bumnId: string; cabangId: string | null; tahun: number; jenis: JenisRka },
    versi: number,
  ): Promise<RkaRow | null>;
  rkaByStatus(
    tx: QueryRunner,
    kunci: { bumnId: string; cabangId: string | null; tahun: number; jenis: JenisRka },
    status: StatusRka,
  ): Promise<RkaRow | null>;
  versiTertinggi(
    tx: QueryRunner,
    kunci: { bumnId: string; cabangId: string | null; tahun: number; jenis: JenisRka },
  ): Promise<number>;
  daftarRka(
    tx: QueryRunner,
    bumnId: string,
    cabangIds: readonly string[],
    filter: { tahun?: number | null; jenis?: JenisRka | null; status?: StatusRka | null; cabangId?: string | null },
  ): Promise<RkaRow[]>;
  barisRka(tx: QueryRunner, rkaId: string): Promise<BarisRkaRow[]>;

  sisipkanRka(
    tx: QueryRunner,
    input: {
      bumnId: string;
      cabangId: string | null;
      tahun: number;
      jenis: JenisRka;
      versi: number;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  sisipkanBaris(
    tx: QueryRunner,
    rkaId: string,
    baris: {
      akunId: string | null;
      sektorId: string | null;
      bidangId: string | null;
      uraian: string;
      bulan: number | null;
      jumlahAnggaran: string;
      jumlahUnit: number | null;
      keterangan: string | null;
    },
    userId: string,
  ): Promise<void>;
  hapusBaris(tx: QueryRunner, rkaId: string, userId: string): Promise<void>;
  tandaiDiedit(tx: QueryRunner, rkaId: string, userId: string): Promise<void>;
  turunkanKeRevisi(tx: QueryRunner, rkaId: string): Promise<boolean>;
  tandaiDisetujui(
    tx: QueryRunner,
    rkaId: string,
    userId: string,
    saatIni: string,
  ): Promise<boolean>;

  akun(tx: QueryRunner, bumnId: string, ids: readonly string[]): Promise<AkunRow[]>;
  akunUntukLaporan(tx: QueryRunner, bumnId: string, ids: readonly string[]): Promise<DimensiRow[]>;
  sektor(tx: QueryRunner, bumnId: string, ids: readonly string[]): Promise<DimensiRow[]>;
  bidang(tx: QueryRunner, bumnId: string, ids: readonly string[]): Promise<DimensiRow[]>;

  periodeBulan(
    tx: QueryRunner,
    bumnId: string,
    bulan: ReadonlyArray<{ tahun: number; bulan: number }>,
  ): Promise<PeriodeRow[]>;
  periodeById(tx: QueryRunner, periodeId: string, bumnId: string): Promise<PeriodeRow | null>;
  adaSaldoBeku(tx: QueryRunner, periodeId: string): Promise<boolean>;
  adaSaldoBekuDimensi(tx: QueryRunner, periodeId: string, sumbu: "SEKTOR" | "BIDANG"): Promise<boolean>;

  realisasiAkunLedger(
    tx: QueryRunner,
    q: { bumnId: string; cabangIds: readonly string[]; dari: string; sampai: string },
  ): Promise<AgregatRow[]>;
  realisasiAkunBeku(
    tx: QueryRunner,
    q: { periodeId: string; cabangIds: readonly string[] },
  ): Promise<AgregatRow[]>;
  realisasiBidangLedger(
    tx: QueryRunner,
    q: { bumnId: string; cabangIds: readonly string[]; dari: string; sampai: string },
  ): Promise<AgregatRow[]>;
  realisasiSektorLedger(
    tx: QueryRunner,
    q: { bumnId: string; cabangIds: readonly string[]; dari: string; sampai: string },
  ): Promise<AgregatRow[]>;

  konfigurasi(tx: QueryRunner, bumnId: string, grup: string, kunci: string): Promise<string | null>;

  // --- report 24's header (spec 10 preamble) --------------------------------
  bumn(tx: QueryRunner, bumnId: string): Promise<BumnRow | null>;
  pengguna(tx: QueryRunner, userId: string): Promise<PenggunaRow | null>;
  /** Every branch of the entity, in `kode` order. Both the branch NAME and the
   *  question "does the caller's scope cover all of them" are answered from
   *  this one read. */
  cabangBumn(tx: QueryRunner, bumnId: string): Promise<CabangRow[]>;
}

export function buatRepoRka(): RepoRka {
  return {
    rkaById(tx, id) {
      return satu<RkaRow>(
        tx,
        `select ${KOLOM_RKA} from rka where id = $1::uuid and deleted_at is null`,
        [id],
      );
    },

    /**
     * The same row, locked. `setujuiRka` demotes the outgoing baseline and
     * promotes this one in ONE transaction, and `rka_baseline_uq` means the two
     * cannot both be DISETUJUI even for an instant; taking the lock first is
     * what turns a lost race into a wait rather than into BASELINE_GANDA.
     */
    rkaByIdTerkunci(tx, id) {
      return satu<RkaRow>(
        tx,
        `select ${KOLOM_RKA} from rka where id = $1::uuid and deleted_at is null for update`,
        [id],
      );
    },

    rkaByVersi(tx, kunci, versi) {
      return satu<RkaRow>(
        tx,
        `select ${KOLOM_RKA} from rka
          where bumn_id = $1::uuid and cabang_id is not distinct from $2::uuid
            and tahun = $3 and jenis = $4 and versi = $5 and deleted_at is null`,
        [kunci.bumnId, kunci.cabangId, kunci.tahun, kunci.jenis, versi],
      );
    },

    rkaByStatus(tx, kunci, status) {
      return satu<RkaRow>(
        tx,
        `select ${KOLOM_RKA} from rka
          where bumn_id = $1::uuid and cabang_id is not distinct from $2::uuid
            and tahun = $3 and jenis = $4 and status = $5 and deleted_at is null
          order by versi desc limit 1`,
        [kunci.bumnId, kunci.cabangId, kunci.tahun, kunci.jenis, status],
      );
    },

    async versiTertinggi(tx, kunci) {
      const row = await satu<{ versi: number | null }>(
        tx,
        `select max(versi)::int as versi from rka
          where bumn_id = $1::uuid and cabang_id is not distinct from $2::uuid
            and tahun = $3 and jenis = $4 and deleted_at is null`,
        [kunci.bumnId, kunci.cabangId, kunci.tahun, kunci.jenis],
      );
      return row?.versi ?? 0;
    },

    daftarRka(tx, bumnId, cabangIds, filter) {
      const params: unknown[] = [bumnId];
      // A consolidated budget (cabang_id IS NULL) belongs to the entity rather
      // than to a branch, so it is visible to every reader in the entity; a
      // branch budget is visible only to a caller holding that branch.
      let where = ` and (cabang_id is null${
        cabangIds.length > 0 ? ` or cabang_id in (${daftar(params, cabangIds)})` : ""
      })`;
      if (filter.tahun !== undefined && filter.tahun !== null) {
        params.push(filter.tahun);
        where += ` and tahun = $${params.length}`;
      }
      if (filter.jenis !== undefined && filter.jenis !== null) {
        params.push(filter.jenis);
        where += ` and jenis = $${params.length}`;
      }
      if (filter.status !== undefined && filter.status !== null) {
        params.push(filter.status);
        where += ` and status = $${params.length}`;
      }
      if (filter.cabangId !== undefined) {
        params.push(filter.cabangId);
        where += ` and cabang_id is not distinct from $${params.length}::uuid`;
      }
      return tx.query<RkaRow>(
        `select ${KOLOM_RKA} from rka
          where bumn_id = $1::uuid and deleted_at is null${where}
          order by tahun desc, jenis, versi desc`,
        params,
      );
    },

    barisRka(tx, rkaId) {
      return tx.query<BarisRkaRow>(
        `select ${KOLOM_BARIS} from rka_detail
          where rka_id = $1::uuid and deleted_at is null
          order by bulan nulls first, uraian`,
        [rkaId],
      );
    },

    async sisipkanRka(tx, input) {
      const row = await satu<{ id: string }>(
        tx,
        `insert into rka (bumn_id, cabang_id, tahun, jenis, status, versi, keterangan,
                          created_by, updated_by)
         values ($1::uuid, $2::uuid, $3, $4, 'DRAFT', $5, $6, $7::uuid, $7::uuid)
         returning id::text as id`,
        [
          input.bumnId,
          input.cabangId,
          input.tahun,
          input.jenis,
          input.versi,
          input.keterangan,
          input.userId,
        ],
      );
      if (!row) throw new Error("modules/rka: insert rka tidak mengembalikan id");
      return row.id;
    },

    async sisipkanBaris(tx, rkaId, baris, userId) {
      await tx.query(
        `insert into rka_detail (rka_id, akun_id, sektor_id, bidang_id, uraian, bulan,
                                 jumlah_anggaran, jumlah_unit, keterangan, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::numeric(20,2), $8, $9,
                 $10::uuid, $10::uuid)`,
        [
          rkaId,
          baris.akunId,
          baris.sektorId,
          baris.bidangId,
          baris.uraian,
          baris.bulan,
          baris.jumlahAnggaran,
          baris.jumlahUnit,
          baris.keterangan,
          userId,
        ],
      );
    },

    async hapusBaris(tx, rkaId, userId) {
      // Soft delete, never a physical one: the grid of a DRAFT that was saved
      // and re-saved is part of the audit trail of how a budget was arrived at.
      await tx.query(
        `update rka_detail set deleted_at = now(), deleted_by = $2::uuid
          where rka_id = $1::uuid and deleted_at is null`,
        [rkaId, userId],
      );
    },

    async tandaiDiedit(tx, rkaId, userId) {
      await tx.query(
        `update rka set updated_by = $2::uuid, updated_at = now() where id = $1::uuid`,
        [rkaId, userId],
      );
    },

    async turunkanKeRevisi(tx, rkaId) {
      // `approved_by` and `approved_at` are deliberately left in place: a
      // superseded version is the evidence for every report printed while it
      // was in force, and "who approved the budget this report was measured
      // against" is the auditor's first question.
      const rows = await tx.query<{ id: string }>(
        `update rka set status = 'REVISI', updated_at = now()
          where id = $1::uuid and status = 'DISETUJUI' and deleted_at is null
          returning id::text as id`,
        [rkaId],
      );
      return rows.length > 0;
    },

    async tandaiDisetujui(tx, rkaId, userId, saatIni) {
      const rows = await tx.query<{ id: string }>(
        `update rka set status = 'DISETUJUI', approved_by = $2::uuid,
                        approved_at = $3::timestamptz, updated_at = now()
          where id = $1::uuid and status = 'DRAFT' and deleted_at is null
          returning id::text as id`,
        [rkaId, userId, saatIni],
      );
      return rows.length > 0;
    },

    akun(tx, bumnId, ids) {
      if (ids.length === 0) return Promise.resolve([]);
      const params: unknown[] = [bumnId];
      const inList = daftar(params, ids);
      return tx.query<AkunRow>(
        `select id::text as id, kode, nama, tipe, saldo_normal, is_postable
           from akun where bumn_id = $1::uuid and deleted_at is null and id in (${inList})`,
        params,
      );
    },

    akunUntukLaporan(tx, bumnId, ids) {
      if (ids.length === 0) return Promise.resolve([]);
      const params: unknown[] = [bumnId];
      const inList = daftar(params, ids);
      return tx.query<DimensiRow>(
        `select id::text as id, kode, nama from akun
          where bumn_id = $1::uuid and id in (${inList})`,
        params,
      );
    },

    sektor(tx, bumnId, ids) {
      if (ids.length === 0) return Promise.resolve([]);
      const params: unknown[] = [bumnId];
      const inList = daftar(params, ids);
      return tx.query<DimensiRow>(
        `select id::text as id, kode, nama from sektor_pumk
          where bumn_id = $1::uuid and deleted_at is null and id in (${inList})`,
        params,
      );
    },

    bidang(tx, bumnId, ids) {
      if (ids.length === 0) return Promise.resolve([]);
      const params: unknown[] = [bumnId];
      const inList = daftar(params, ids);
      return tx.query<DimensiRow>(
        `select id::text as id, kode, nama from bidang_non_pumk
          where bumn_id = $1::uuid and deleted_at is null and id in (${inList})`,
        params,
      );
    },

    periodeBulan(tx, bumnId, bulan) {
      if (bulan.length === 0) return Promise.resolve([]);
      const params: unknown[] = [bumnId];
      const cocok = bulan
        .map((b) => {
          params.push(b.tahun, b.bulan);
          return `(tahun = $${params.length - 1} and bulan = $${params.length})`;
        })
        .join(" or ");
      return tx.query<PeriodeRow>(
        `select id::text as id, tahun::int as tahun, bulan::int as bulan,
                tanggal_mulai::text as tanggal_mulai, tanggal_akhir::text as tanggal_akhir, status
           from periode
          where bumn_id = $1::uuid and deleted_at is null and (${cocok})`,
        params,
      );
    },

    periodeById(tx, periodeId, bumnId) {
      return satu<PeriodeRow>(
        tx,
        `select id::text as id, tahun::int as tahun, bulan::int as bulan,
                tanggal_mulai::text as tanggal_mulai, tanggal_akhir::text as tanggal_akhir, status
           from periode
          where id = $1::uuid and bumn_id = $2::uuid and deleted_at is null`,
        [periodeId, bumnId],
      );
    },

    async adaSaldoBeku(tx, periodeId) {
      const row = await satu<{ n: string }>(
        tx,
        `select count(*)::text as n from saldo_akun_periode
          where periode_id = $1::uuid and deleted_at is null`,
        [periodeId],
      );
      return Number.parseInt(row?.n ?? "0", 10) > 0;
    },

    /**
     * Is there a FROZEN per-dimension decomposition for this period?
     *
     * migrations/0027 (ADR 0016) added `saldo_akun_dimensi_periode` to hold it,
     * but the closing engine does not yet WRITE it. Asking the data rather than
     * asking the schema is what makes the refusal in `metodeRealisasi` lift by
     * itself the day the close starts producing the rows, instead of needing a
     * second change here that somebody has to remember.
     */
    async adaSaldoBekuDimensi(tx, periodeId, sumbu) {
      const row = await satu<{ n: string }>(
        tx,
        `select count(*)::text as n
           from saldo_akun_dimensi_periode sd
           join saldo_akun_periode s on s.id = sd.saldo_akun_periode_id
          where s.periode_id = $1::uuid and s.deleted_at is null
            and sd.sumbu = $2 and sd.deleted_at is null`,
        [periodeId, sumbu],
      );
      return Number.parseInt(row?.n ?? "0", 10) > 0;
    },

    /**
     * RKA Keuangan, OPEN period: the account's own movement, DEBIT-POSITIVE,
     * from `v_ledger_baris`. The caller flips it into the account's normal
     * direction, because that is how a budget line is written.
     *
     * Restricted to postable BEBAN and PENDAPATAN accounts, which is what spec
     * 9.3 makes budgetable ("anggaran per akun beban dan target pendapatan").
     * Cash moves in every month and cash is not a budget line.
     */
    realisasiAkunLedger(tx, q) {
      const params: unknown[] = [q.bumnId, q.dari, q.sampai];
      const inList = daftar(params, q.cabangIds);
      return tx.query<AgregatRow>(
        `select l.akun_id::text as dimensi_id,
                coalesce(sum(l.debit - l.kredit), 0)::numeric(20,2)::text as nilai,
                null::text as unit
           from v_ledger_baris l
           join akun a on a.id = l.akun_id
          where l.bumn_id = $1::uuid
            and l.tanggal_transaksi between $2::date and $3::date
            and l.cabang_id in (${inList})
            and a.tipe in ('BEBAN', 'PENDAPATAN')
            and a.is_postable
          group by l.akun_id`,
        params,
      );
    },

    /**
     * RKA Keuangan, CLOSED period: the FROZEN movement, debit-positive, from
     * the trial balance the close wrote. Spec 10's rule and invariant 14.
     *
     * The HAVING clause drops accounts whose frozen row exists only because the
     * account moved in an EARLIER period: a zero-movement month is not a report
     * row, and including it would make the live and frozen readings of the same
     * month disagree about which rows exist.
     */
    realisasiAkunBeku(tx, q) {
      const params: unknown[] = [q.periodeId];
      const inList = daftar(params, q.cabangIds);
      return tx.query<AgregatRow>(
        `select s.akun_id::text as dimensi_id,
                coalesce(sum(s.mutasi_debit - s.mutasi_kredit), 0)::numeric(20,2)::text as nilai,
                null::text as unit
           from saldo_akun_periode s
           join akun a on a.id = s.akun_id
          where s.periode_id = $1::uuid and s.deleted_at is null
            and s.cabang_id in (${inList})
            and a.tipe in ('BEBAN', 'PENDAPATAN')
            and a.is_postable
          group by s.akun_id
         having sum(s.mutasi_debit) <> 0 or sum(s.mutasi_kredit) <> 0`,
        params,
      );
    },

    /**
     * RKA Non PUMK, per bidang, from the ledger's OWN dimension.
     *
     * `PENYALURAN_NON_PUMK` puts `bidangId` in `dimensi_json` on the expense
     * leg (the cash leg carries no dimension), and
     * `PENGEMBALIAN_SISA_NON_PUMK` puts it on the expense leg of the refund,
     * which is a CREDIT. So `sum(debit - kredit)` over the lines carrying the
     * bidang is disbursement MINUS refund, which is what was actually spent and
     * therefore what a budget is measured against. Report 13's "Nilai" column
     * is the gross figure; the difference between the two is the refund, and
     * both reports are right at once only under this reading.
     */
    realisasiBidangLedger(tx, q) {
      const params: unknown[] = [q.bumnId, q.dari, q.sampai];
      const inList = daftar(params, q.cabangIds);
      return tx.query<AgregatRow>(
        `select l.dimensi_json ->> 'bidangId' as dimensi_id,
                coalesce(sum(l.debit - l.kredit), 0)::numeric(20,2)::text as nilai,
                null::text as unit
           from v_ledger_baris l
          where l.bumn_id = $1::uuid
            and l.tanggal_transaksi between $2::date and $3::date
            and l.cabang_id in (${inList})
            and l.dimensi_json ->> 'bidangId' is not null
          group by 1`,
        params,
      );
    },

    /**
     * RKA PUMK, per sektor, from the ledger's disbursement lines.
     *
     * `PENCAIRAN_PUMK` carries NO `sektorId` (the fixture pins that as a
     * finding), so the sector is reached through
     * `akad -> proposal.sektor_id`, which is EDITABLE master data. That is
     * exactly why a CLOSED period is refused rather than answered: this join
     * would rewrite a historical month the day somebody reclassifies a partner.
     * For an OPEN period the ledger is live anyway, so the join is no worse
     * than the period it reports on.
     *
     * `referensi_tipe = 'pumk_pencairan'` is the ledger's own back-reference,
     * not this module's opinion about which rows count, and a reversing journal
     * inherits it (modules/jurnal preserves `referensi_tipe`, `mitra_id` and
     * `akad_id` on the pembalik), so a reversed disbursement nets to zero
     * instead of being counted or double counted.
     *
     * `unit` is DISTINCT mitra, spec 9.3's "jumlah mitra target": a second
     * tranche to the same partner is not a second partner.
     */
    realisasiSektorLedger(tx, q) {
      const params: unknown[] = [q.bumnId, q.dari, q.sampai];
      const inList = daftar(params, q.cabangIds);
      return tx.query<AgregatRow>(
        `select p.sektor_id::text as dimensi_id,
                coalesce(sum(l.debit - l.kredit), 0)::numeric(20,2)::text as nilai,
                count(distinct l.mitra_id)::text as unit
           from v_ledger_baris l
           join jurnal j on j.id = l.jurnal_id
           join pumk_akad ak on ak.id = l.akad_id
           join pumk_proposal p on p.id = ak.proposal_id
          where l.bumn_id = $1::uuid
            and l.tanggal_transaksi between $2::date and $3::date
            and l.cabang_id in (${inList})
            and j.referensi_tipe = 'pumk_pencairan'
            and p.sektor_id is not null
          group by p.sektor_id`,
        params,
      );
    },

    async konfigurasi(tx, bumnId, grup, kunci) {
      // A bumn-scoped row overrides the shipped default (bumn_id IS NULL),
      // exactly how modules/konfigurasi resolves a parameter. Read fresh on
      // every call so an accountant's edit takes effect without a deploy.
      const row = await satu<{ nilai: string | null }>(
        tx,
        `select nilai from konfigurasi
          where grup = $1 and kunci = $2 and (bumn_id = $3::uuid or bumn_id is null)
            and deleted_at is null
          order by (bumn_id is null)
          limit 1`,
        [grup, kunci, bumnId],
      );
      return row?.nilai ?? null;
    },

    // --- report 24's header ------------------------------------------------
    //
    // Deliberately the same three reads modules/laporan makes for its own
    // header, with the same predicates, so the two headers cannot disagree
    // about an entity's name or about who printed a page. No `deleted_at`
    // filter on `bumn` or `app_user`, for the reason that module gives: a page
    // printed by a user who has since been deactivated must still say who
    // printed it.
    bumn(tx, bumnId) {
      return satu<BumnRow>(tx, `select nama from bumn where id = $1::uuid`, [bumnId]);
    },

    pengguna(tx, userId) {
      return satu<PenggunaRow>(tx, `select nama from app_user where id = $1::uuid`, [userId]);
    },

    cabangBumn(tx, bumnId) {
      return tx.query<CabangRow>(
        `select id::text as id, kode, nama
           from cabang where bumn_id = $1::uuid and deleted_at is null order by kode`,
        [bumnId],
      );
    },
  };
}

/** The dimension column a budget line of this type is filed against. */
export function kolomDimensi(dimensi: DimensiRka): "akun_id" | "sektor_id" | "bidang_id" {
  return dimensi === "AKUN" ? "akun_id" : dimensi === "SEKTOR" ? "sektor_id" : "bidang_id";
}
