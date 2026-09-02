// apps/api/src/modules/laporan/repo.ts
//
// EVERY SQL STATEMENT THIS MODULE ISSUES, AND NOTHING ELSE. All of them are
// SELECTs: spec 16 scenario 23 requires an Auditor to open every report and
// change nothing, so an INSERT, UPDATE or DELETE in this file would be a
// defect, not a feature.
//
// THE ONE PREDICATE THAT MATTERS (ADR 0010). A live figure is read from
// `v_ledger_baris`, whose predicate is `status IN ('POSTED','REVERSED')`.
// NEVER `status = 'POSTED'` alone: a reversal ADDS two lines and REMOVES none,
// so marking the original REVERSED drops its lines out of a POSTED-only sum
// while the reversing journal keeps subtracting, and the correction is counted
// twice. The error is invisible to every balance check this module has,
// because both journals balance.
//
// DRIVER FACTS, from modules/jurnal/repo.ts, all three of which bite here:
//   1. a JS array binds as a comma-joined string, so `= ANY($n::text[])` fails
//      22P02. Nothing below binds an array; branch scope is one id or null.
//   2. `coalesce(sum(x), 0)` yields the string '0', not '0.00'. Every
//      aggregate casts `::numeric(20,2)` BEFORE `::text`, or the value fails
//      POLA_UANG at the boundary (./uang.ts refuses it loudly).
//   3. a DATE comes back as a JS `Date`. Every date column is selected
//      `::text` so an ISO string is what the engine compares and prints.
import type { QueryRunner } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface BumnRow {
  nama: string;
}

export interface PenggunaRow {
  nama: string;
}

export interface CabangRow {
  id: string;
  bumn_id: string;
  nama: string;
}

export interface PeriodeRow {
  id: string;
  bumn_id: string;
  tahun: number;
  bulan: number;
  tanggal_mulai: string;
  tanggal_akhir: string;
  status: string;
}

export interface AkunRow {
  id: string;
  kode: string;
  nama: string;
  parent_id: string | null;
  level: number;
  tipe: string;
  saldo_normal: string;
  is_postable: boolean;
  is_kas: boolean;
  is_kontra: boolean;
  klasifikasi_arus_kas: string | null;
  klasifikasi_akun: string;
  aktif: boolean;
}

export interface BarisLaporanRow {
  id: string;
  laporan: string;
  kode: string;
  nama: string;
  parent_kode: string | null;
  urutan: number;
  level: number;
  tipe_baris: string;
  tanda: number;
  seksi: string | null;
}

export interface PemetaanRow {
  akun_id: string;
  laporan: string;
  baris_id: string;
  baris_kode: string;
}

export interface MutasiRow {
  akun_id: string;
  debit: string;
  kredit: string;
}

export interface SaldoBekuRow {
  akun_id: string;
  saldo_awal: string;
  mutasi_debit: string;
  mutasi_kredit: string;
  saldo_akhir: string;
}

export interface BarisJurnalRow {
  jurnal_id: string;
  jurnal_baris_id: string;
  no_jurnal: string;
  tanggal: string;
  jenis: string;
  keterangan: string | null;
  debit: string;
  kredit: string;
  mitra_id: string | null;
  akad_id: string | null;
  cabang_id: string;
}

export interface LawanKasRow {
  akun_id: string;
  kode: string;
  nama: string;
  klasifikasi_arus_kas: string | null;
  nilai: string;
}

async function satu<T>(tx: QueryRunner, sql: string, params: unknown[]): Promise<T | null> {
  const baris = await tx.query<T>(sql, params);
  return baris.length > 0 ? baris[0] : null;
}

/**
 * Branch scope as a SQL fragment. `null` means Semua Cabang, which the service
 * has ALREADY authorised (spec 16 scenario 24 makes an out-of-scope request a
 * refusal, never a silently narrowed WHERE clause), so this helper never
 * decides policy; it only renders the predicate the service decided on.
 */
function filterCabang(alias: string, cabangId: string | null, params: unknown[]): string {
  if (cabangId === null) return "";
  params.push(cabangId);
  return ` and ${alias}.cabang_id = $${params.length}::uuid`;
}

export interface LaporanRepo {
  bumn(tx: QueryRunner, bumnId: string): Promise<BumnRow | null>;
  pengguna(tx: QueryRunner, userId: string): Promise<PenggunaRow | null>;
  cabang(tx: QueryRunner, cabangId: string): Promise<CabangRow | null>;
  cabangBumn(tx: QueryRunner, bumnId: string): Promise<CabangRow[]>;
  periode(tx: QueryRunner, periodeId: string): Promise<PeriodeRow | null>;
  periodeSampai(tx: QueryRunner, bumnId: string, tanggal: string): Promise<PeriodeRow | null>;
  jumlahSaldoBeku(tx: QueryRunner, periodeId: string): Promise<number>;
  adaLedgerSampai(tx: QueryRunner, bumnId: string, tanggal: string): Promise<boolean>;
  akun(tx: QueryRunner, bumnId: string): Promise<AkunRow[]>;
  templateBerlaku(tx: QueryRunner, bumnId: string, tanggal: string): Promise<string | null>;
  barisLaporan(
    tx: QueryRunner,
    bumnId: string,
    templateId: string,
    laporan: string,
  ): Promise<BarisLaporanRow[]>;
  pemetaan(tx: QueryRunner, bumnId: string, templateId: string): Promise<PemetaanRow[]>;
  saldoLedgerPada(
    tx: QueryRunner,
    bumnId: string,
    cabangId: string | null,
    tanggal: readonly string[],
  ): Promise<Map<string, string[]>>;
  mutasiLedger(
    tx: QueryRunner,
    bumnId: string,
    cabangId: string | null,
    dari: string,
    sampai: string,
  ): Promise<MutasiRow[]>;
  saldoBeku(
    tx: QueryRunner,
    periodeId: string,
    cabangId: string | null,
  ): Promise<SaldoBekuRow[]>;
  barisJurnal(
    tx: QueryRunner,
    bumnId: string,
    cabangId: string | null,
    akunId: string,
    dari: string,
    sampai: string,
  ): Promise<BarisJurnalRow[]>;
  lawanKas(
    tx: QueryRunner,
    bumnId: string,
    cabangId: string | null,
    dari: string,
    sampai: string,
  ): Promise<LawanKasRow[]>;
  konfigurasi(
    tx: QueryRunner,
    bumnId: string,
    grup: string,
    kunci: string,
  ): Promise<string | null>;
}

export function buatRepoLaporan(): LaporanRepo {
  return {
    bumn(tx, bumnId) {
      return satu<BumnRow>(tx, `select nama from bumn where id = $1::uuid`, [bumnId]);
    },

    pengguna(tx, userId) {
      return satu<PenggunaRow>(tx, `select nama from app_user where id = $1::uuid`, [userId]);
    },

    cabang(tx, cabangId) {
      return satu<CabangRow>(
        tx,
        `select id::text as id, bumn_id::text as bumn_id, nama
           from cabang where id = $1::uuid and deleted_at is null`,
        [cabangId],
      );
    },

    cabangBumn(tx, bumnId) {
      return tx.query<CabangRow>(
        `select id::text as id, bumn_id::text as bumn_id, nama
           from cabang where bumn_id = $1::uuid and deleted_at is null order by kode`,
        [bumnId],
      );
    },

    periode(tx, periodeId) {
      return satu<PeriodeRow>(
        tx,
        `select id::text as id, bumn_id::text as bumn_id, tahun, bulan,
                tanggal_mulai::text as tanggal_mulai, tanggal_akhir::text as tanggal_akhir, status
           from periode where id = $1::uuid and deleted_at is null`,
        [periodeId],
      );
    },

    /**
     * The latest period that ENDS on or before `tanggal`, i.e. the one whose
     * frozen closing balance IS the balance at that cut-off. This is how the
     * CLOSED path answers "the balance on 2025-12-31" without recomputing:
     * `saldo_akun_periode.saldo_akhir` of that period, and nothing else.
     */
    periodeSampai(tx, bumnId, tanggal) {
      return satu<PeriodeRow>(
        tx,
        `select id::text as id, bumn_id::text as bumn_id, tahun, bulan,
                tanggal_mulai::text as tanggal_mulai, tanggal_akhir::text as tanggal_akhir, status
           from periode
          where bumn_id = $1::uuid and deleted_at is null and tanggal_akhir <= $2::date
          order by tanggal_akhir desc
          limit 1`,
        [bumnId, tanggal],
      );
    },

    async jumlahSaldoBeku(tx, periodeId) {
      const row = await satu<{ n: string }>(
        tx,
        `select count(*)::text as n from saldo_akun_periode
          where periode_id = $1::uuid and deleted_at is null`,
        [periodeId],
      );
      return Number.parseInt(row?.n ?? "0", 10);
    },

    async adaLedgerSampai(tx, bumnId, tanggal) {
      const row = await satu<{ ada: boolean }>(
        tx,
        `select true as ada from v_ledger_baris
          where bumn_id = $1::uuid and tanggal_transaksi <= $2::date limit 1`,
        [bumnId, tanggal],
      );
      return row !== null;
    },

    akun(tx, bumnId) {
      return tx.query<AkunRow>(
        `select id::text as id, kode, nama, parent_id::text as parent_id, level, tipe,
                saldo_normal, is_postable, is_kas, is_kontra, klasifikasi_arus_kas,
                klasifikasi_akun, aktif
           from akun
          where bumn_id = $1::uuid and deleted_at is null
          order by kode`,
        [bumnId],
      );
    },

    /**
     * The template in force for the date being REPORTED ON (migrations/0028:
     * the effective range is over the reported period, not over wall clock).
     * Exactly one can match, because 0028's trigger forbids overlapping ranges.
     */
    async templateBerlaku(tx, bumnId, tanggal) {
      const row = await satu<{ id: string }>(
        tx,
        `select id::text as id from template_laporan
          where bumn_id = $1::uuid and deleted_at is null and aktif
            and berlaku_dari <= $2::date
            and (berlaku_sampai is null or berlaku_sampai >= $2::date)
          order by berlaku_dari desc
          limit 1`,
        [bumnId, tanggal],
      );
      if (row) return row.id;
      // No template covers this date. Fall back to the entity's single active
      // template if it has exactly one, so a client whose template was entered
      // with a later `berlaku_dari` gets a statement rather than a riddle; if
      // it has none, the caller refuses with TEMPLATE_LAPORAN_KOSONG.
      const satuSaja = await tx.query<{ id: string }>(
        `select id::text as id from template_laporan
          where bumn_id = $1::uuid and deleted_at is null and aktif
          order by berlaku_dari desc`,
        [bumnId],
      );
      return satuSaja.length === 1 ? satuSaja[0].id : null;
    },

    /**
     * The ACTIVE printed lines of one statement, in the table's own order.
     * `aktif = false` stops a line printing (spec 4.2, no deploy), which is why
     * it is a WHERE clause here rather than a filter in the engine.
     */
    barisLaporan(tx, bumnId, templateId, laporan) {
      return tx.query<BarisLaporanRow>(
        `select b.id::text as id, b.laporan, b.kode, b.nama, p.kode as parent_kode,
                b.urutan, b.level, b.tipe_baris, b.tanda, b.seksi
           from baris_laporan b
           left join baris_laporan p on p.id = b.parent_id and p.deleted_at is null
          where b.bumn_id = $1::uuid and b.template_id = $2::uuid and b.laporan = $3
            and b.deleted_at is null and b.aktif
          order by b.urutan, b.kode`,
        [bumnId, templateId, laporan],
      );
    },

    /**
     * account -> printed line, per statement (migrations/0028). The account
     * names a CLASSIFICATION; the classification reaches a line of each
     * statement through `pemetaan_baris_laporan`. Only ACTIVE lines are
     * returned, so a deactivated line orphans the accounts pointing at it and
     * the engine can refuse instead of losing their balances.
     */
    pemetaan(tx, bumnId, templateId) {
      return tx.query<PemetaanRow>(
        `select a.id::text as akun_id, pm.laporan, bl.id::text as baris_id,
                bl.kode as baris_kode
           from akun a
           join klasifikasi_akun k
             on k.bumn_id = a.bumn_id and k.kode = a.klasifikasi_akun
           join pemetaan_baris_laporan pm
             on pm.klasifikasi_id = k.id and pm.template_id = $2::uuid
            and pm.deleted_at is null
           join baris_laporan bl
             on bl.id = pm.baris_laporan_id and bl.deleted_at is null and bl.aktif
          where a.bumn_id = $1::uuid and a.deleted_at is null`,
        [bumnId, templateId],
      );
    },

    /**
     * Debit-positive balance per account at EACH of several cut-offs, in ONE
     * pass over the ledger. Several cut-offs because every statement here
     * carries a comparative column and an opening balance, and a query per
     * date would read the same lines four times.
     *
     * `v_ledger_baris`, ADR 0010. `::numeric(20,2)` before `::text`, driver
     * fact 2.
     */
    async saldoLedgerPada(tx, bumnId, cabangId, tanggal) {
      const params: unknown[] = [bumnId];
      const kolom = tanggal.map((t, i) => {
        params.push(t);
        return `coalesce(sum(case when l.tanggal_transaksi <= $${params.length}::date
                                  then l.debit - l.kredit else 0 end), 0)::numeric(20,2)::text as d${i}`;
      });
      const cabang = filterCabang("l", cabangId, params);
      const baris = await tx.query<Record<string, string>>(
        `select l.akun_id::text as akun_id, ${kolom.join(", ")}
           from v_ledger_baris l
          where l.bumn_id = $1::uuid${cabang}
          group by l.akun_id`,
        params,
      );
      const keluar = new Map<string, string[]>();
      for (const row of baris) {
        keluar.set(
          row.akun_id,
          tanggal.map((_, i) => row[`d${i}`]),
        );
      }
      return keluar;
    },

    mutasiLedger(tx, bumnId, cabangId, dari, sampai) {
      const params: unknown[] = [bumnId, dari, sampai];
      const cabang = filterCabang("l", cabangId, params);
      return tx.query<MutasiRow>(
        `select l.akun_id::text as akun_id,
                coalesce(sum(l.debit), 0)::numeric(20,2)::text as debit,
                coalesce(sum(l.kredit), 0)::numeric(20,2)::text as kredit
           from v_ledger_baris l
          where l.bumn_id = $1::uuid
            and l.tanggal_transaksi >= $2::date and l.tanggal_transaksi <= $3::date${cabang}
          group by l.akun_id`,
        params,
      );
    },

    /**
     * The FROZEN figures spec 10 requires a CLOSED period to be read from,
     * aggregated over the branch scope. Never recomputed from the ledger:
     * a silent recomputation is invariant 14's failure mode and it would be
     * invisible in the output.
     */
    saldoBeku(tx, periodeId, cabangId) {
      const params: unknown[] = [periodeId];
      const cabang = filterCabang("s", cabangId, params);
      return tx.query<SaldoBekuRow>(
        `select s.akun_id::text as akun_id,
                coalesce(sum(s.saldo_awal), 0)::numeric(20,2)::text as saldo_awal,
                coalesce(sum(s.mutasi_debit), 0)::numeric(20,2)::text as mutasi_debit,
                coalesce(sum(s.mutasi_kredit), 0)::numeric(20,2)::text as mutasi_kredit,
                coalesce(sum(s.saldo_akhir), 0)::numeric(20,2)::text as saldo_akhir
           from saldo_akun_periode s
          where s.periode_id = $1::uuid and s.deleted_at is null${cabang}
          group by s.akun_id`,
        params,
      );
    },

    /**
     * The individual entries of one account, for Buku Besar. Joined back to
     * `jurnal_baris` and `jurnal` for the description a reader actually reads;
     * the VIEW still decides which lines exist, so the ADR 0010 predicate is
     * not restated here.
     *
     * Ordered (tanggal, no_jurnal, urutan): stable, reproducible, and the
     * order the running balance is defined against.
     */
    barisJurnal(tx, bumnId, cabangId, akunId, dari, sampai) {
      const params: unknown[] = [bumnId, akunId, dari, sampai];
      const cabang = filterCabang("l", cabangId, params);
      return tx.query<BarisJurnalRow>(
        `select l.jurnal_id::text as jurnal_id, l.jurnal_baris_id::text as jurnal_baris_id,
                l.no_jurnal, l.tanggal_transaksi::text as tanggal, l.jenis,
                coalesce(nullif(b.keterangan, ''), j.keterangan) as keterangan,
                l.debit::text as debit, l.kredit::text as kredit,
                l.mitra_id::text as mitra_id, l.akad_id::text as akad_id,
                l.cabang_id::text as cabang_id
           from v_ledger_baris l
           join jurnal_baris b on b.id = l.jurnal_baris_id
           join jurnal j on j.id = l.jurnal_id
          where l.bumn_id = $1::uuid and l.akun_id = $2::uuid
            and l.tanggal_transaksi >= $3::date and l.tanggal_transaksi <= $4::date${cabang}
          order by l.tanggal_transaksi, l.no_jurnal, l.urutan`,
        params,
      );
    },

    /**
     * THE DIRECT METHOD, in one query. Take every journal in the span that
     * touches an `is_kas` account, then sum the NON-cash lines of those
     * journals per counter-account, credit-positive (`kredit - debit`), which
     * is the movement seen from the CASH side: an inflow is positive.
     *
     * Two consequences fall out of the shape rather than out of a rule:
     *   - a journal that touches no cash account contributes nothing, so the
     *     allowance entry is absent from this statement while being real
     *     expense in report 17 (a statement derived from the income statement
     *     gets that wrong and Kas Akhir misses by exactly that);
     *   - a cash-to-cash transfer has no non-cash line, so it produces no row
     *     in any section and nets to zero inside the cash pool.
     * A journal with several counter-accounts splits by its own line amounts,
     * because the lines ARE the split.
     */
    lawanKas(tx, bumnId, cabangId, dari, sampai) {
      const params: unknown[] = [bumnId, dari, sampai];
      const cabangKas = filterCabang("k", cabangId, params);
      const cabangLawan = filterCabang("l", cabangId, params);
      return tx.query<LawanKasRow>(
        `with jurnal_kas as (
           select distinct k.jurnal_id
             from v_ledger_baris k
             join akun ak on ak.id = k.akun_id
            where k.bumn_id = $1::uuid and ak.is_kas
              and k.tanggal_transaksi >= $2::date and k.tanggal_transaksi <= $3::date${cabangKas}
         )
         select l.akun_id::text as akun_id, a.kode, a.nama, a.klasifikasi_arus_kas,
                coalesce(sum(l.kredit - l.debit), 0)::numeric(20,2)::text as nilai
           from v_ledger_baris l
           join jurnal_kas jk on jk.jurnal_id = l.jurnal_id
           join akun a on a.id = l.akun_id
          where l.bumn_id = $1::uuid and not a.is_kas
            and l.tanggal_transaksi >= $2::date and l.tanggal_transaksi <= $3::date${cabangLawan}
          group by l.akun_id, a.kode, a.nama, a.klasifikasi_arus_kas
          order by a.kode`,
        params,
      );
    },

    /**
     * BUMN-SCOPED FIRST, THEN THE SHIPPED GLOBAL DEFAULT (`bumn_id IS NULL`).
     * One resolution order, the same one modules/konfigurasi, modules/closing
     * and modules/rka use.
     *
     * THIS USED TO BE BUMN-SCOPED ONLY, and it was a mistake worth recording.
     * A refusal test soft-deleted this entity's row and demanded
     * KONFIGURASI_TIDAK_ADA, which bumn-then-global resolution cannot produce
     * while migrations/0004 ships a global row; satisfying it here made ONE
     * key answer differently depending on which module asked, which is a trap
     * for whoever debugs a wrong fiscal year later and is worse than either
     * order on its own. The test now removes the key at BOTH levels
     * (`tanpaKonfigurasi`), so "hilang" means absent, and the refusal below
     * still fires when the key genuinely is not configured anywhere.
     *
     * `order by (bumn_id is null)` puts the entity's own row first: false
     * sorts before true.
     */
    async konfigurasi(tx, bumnId, grup, kunci) {
      const row = await satu<{ nilai: string | null }>(
        tx,
        `select nilai from konfigurasi
          where grup = $2 and kunci = $3 and deleted_at is null
            and (bumn_id = $1::uuid or bumn_id is null)
          order by (bumn_id is null)
          limit 1`,
        [bumnId, grup, kunci],
      );
      return row?.nilai ?? null;
    },
  };
}
