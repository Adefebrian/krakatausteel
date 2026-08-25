// Every SQL statement modules/closing issues. Private to the module.
//
// THE DRIVER FACTS THIS FILE IS WRITTEN AGAINST, all four learned the hard way
// in the ledger module's repo and restated here because forgetting any one of
// them produces a wrong number rather than an error:
//
//   1. A JS ARRAY BINDS AS A COMMA-JOINED STRING under `bun:sql`, so
//      `= ANY($n::uuid[])` fails with 22P02 "malformed array literal". Every
//      "in this set of branches" filter below therefore expands into explicit
//      `$3, $4, ...` placeholders built by `daftarPlaceholder`.
//   2. A JSONB PARAMETER BOUND FROM A JS STRING becomes a JSON string SCALAR,
//      so `ringkasan_json` is written `$n::text::jsonb`.
//   3. DATES COME BACK AS `Date` OBJECTS, so every date column is selected
//      `::text` and every date parameter is cast `::date`.
//   4. `coalesce(sum(x), 0)` YIELDS '0', NOT '0.00'. Every money aggregate is
//      cast `::numeric(20,2)` BEFORE `::text`, or the value fails `POLA_UANG`
//      and every equality assertion against it.
//
// AND THE ONE RULE THAT OUTRANKS ALL FOUR (ADR 0010, migrations/0018): every
// ledger aggregate here reads `v_ledger_baris`, whose predicate is
// `status IN ('POSTED','REVERSED')`. Never `status = 'POSTED'`. A reversal adds
// two rows and removes none; a POSTED-only sum drops the original while the
// reversing journal still subtracts, so it counts the correction twice. Closing
// FREEZES that number, so the error is permanent and invisible: the wrong trial
// balance still satisfies the row identity, still sums to zero, and still
// passes all ten prerequisite checks.
import type { QueryRunner } from "../../core/ports/db";
import type { DasarPerhitunganPenyisihan, KelasKolektibilitas, SumberRate } from "./contract";

// ---------------------------------------------------------------------------
// Row shapes, as they come back from Postgres
// ---------------------------------------------------------------------------

export interface PeriodeRow {
  id: string;
  bumn_id: string;
  tahun: number;
  bulan: number;
  tanggal_mulai: string;
  tanggal_akhir: string;
  status: string;
  closed_by: string | null;
  closed_at: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
  alasan_reopen: string | null;
}

export interface RangeRow {
  kelas_kode: KelasKolektibilitas;
  hari_min: number;
  hari_max: number | null;
  berlaku_dari: string;
}

export interface RateRow {
  kelas_kode: KelasKolektibilitas;
  rate: string;
  dasar_perhitungan: DasarPerhitunganPenyisihan;
  berlaku_dari: string;
}

export interface AkadRow {
  akad_id: string;
  no_akad: string;
  mitra_id: string;
  cabang_id: string;
  sektor_id: string | null;
  outstanding_pokok: string;
  outstanding_jasa: string;
  tanggal_tertua: string | null;
  tunggakan_pokok: string;
  tunggakan_jasa: string;
}

export interface SnapshotBarisDb {
  akad_id: string;
  no_akad: string;
  mitra_id: string;
  cabang_id: string;
  sektor_id: string | null;
  tanggal_jatuh_tempo_tertunggak_tertua: string | null;
  hari_tunggakan: number;
  kolektibilitas: KelasKolektibilitas;
  kolektibilitas_periode_lalu: KelasKolektibilitas | null;
  outstanding_pokok: string;
  outstanding_jasa: string;
  tunggakan_pokok: string;
  tunggakan_jasa: string;
  rate_penyisihan: string;
  dasar_perhitungan: DasarPerhitunganPenyisihan;
  sumber_rate: SumberRate;
  nilai_penyisihan: string;
}

export interface BarisSnapshotTulis {
  akadId: string;
  mitraId: string;
  cabangId: string;
  sektorId: string | null;
  tanggalTertua: string | null;
  hariTunggakan: number;
  kolektibilitas: string;
  outstandingPokok: string;
  outstandingJasa: string;
  tunggakanPokok: string;
  tunggakanJasa: string;
  ratePenyisihan: string;
  dasarPerhitungan: string;
  nilaiPenyisihan: string;
  kolektibilitasPeriodeLalu: string | null;
  sumberRate: string;
  historiDari: string | null;
  historiSampai: string | null;
}

export interface PenyisihanRow {
  id: string;
  cabang_id: string;
  saldo_penyisihan_awal: string;
  penyisihan_dibutuhkan: string;
  beban_penyisihan_periode: string;
  jurnal_id: string | null;
  tanggal: string;
}

export interface AkrualRow {
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  kolektibilitas: KelasKolektibilitas;
  jasa_jatuh_tempo_periode: string;
  jasa_diterima_periode: string;
  jasa_diakrual: string;
  jurnal_id: string | null;
}

export interface SaldoRow {
  cabang_id: string;
  akun_id: string;
  akun_kode: string;
  saldo_awal: string;
  mutasi_debit: string;
  mutasi_kredit: string;
  saldo_akhir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `$3, $4, $5` for an in-list, because driver fact 1 rules out `ANY($n::uuid[])`. */
function daftarPlaceholder(mulai: number, jumlah: number, cast = "::uuid"): string {
  return Array.from({ length: jumlah }, (_, i) => `$${mulai + i}${cast}`).join(", ");
}

async function satu<T>(tx: QueryRunner, sql: string, params: unknown[]): Promise<T | null> {
  const rows = await tx.query<T>(sql, params);
  return rows[0] ?? null;
}

const KOLOM_PERIODE = `
  p.id::text as id, p.bumn_id::text as bumn_id, p.tahun, p.bulan,
  p.tanggal_mulai::text as tanggal_mulai, p.tanggal_akhir::text as tanggal_akhir,
  p.status, p.closed_by::text as closed_by, p.closed_at::text as closed_at,
  p.reopened_by::text as reopened_by, p.reopened_at::text as reopened_at, p.alasan_reopen`;

// ---------------------------------------------------------------------------
// The repo
// ---------------------------------------------------------------------------

export function buatRepoClosing() {
  return {
    // --- periode ----------------------------------------------------------

    periode(tx: QueryRunner, periodeId: string): Promise<PeriodeRow | null> {
      return satu<PeriodeRow>(
        tx,
        `select ${KOLOM_PERIODE} from periode p where p.id = $1::uuid and p.deleted_at is null`,
        [periodeId],
      );
    },

    /** Spec 8.4 check 1 and invariant 6: everything earlier that is still open. */
    periodeSebelumnyaBelumTutup(
      tx: QueryRunner,
      bumnId: string,
      tahun: number,
      bulan: number,
    ): Promise<Array<{ id: string; tahun: number; bulan: number; status: string }>> {
      return tx.query(
        `select id::text as id, tahun, bulan, status
           from periode
          where bumn_id = $1::uuid and status <> 'CLOSED' and deleted_at is null
            and (tahun, bulan) < ($2::int, $3::int)
          order by tahun, bulan`,
        [bumnId, tahun, bulan],
      );
    },

    /** Spec 8.4 reopen: only the most recently closed period may be reopened. */
    periodeClosedLebihBaru(
      tx: QueryRunner,
      bumnId: string,
      tahun: number,
      bulan: number,
    ): Promise<Array<{ id: string; tahun: number; bulan: number }>> {
      return tx.query(
        `select id::text as id, tahun, bulan
           from periode
          where bumn_id = $1::uuid and status = 'CLOSED' and deleted_at is null
            and (tahun, bulan) > ($2::int, $3::int)
          order by tahun, bulan`,
        [bumnId, tahun, bulan],
      );
    },

    async tandaiClosed(
      tx: QueryRunner,
      periodeId: string,
      userId: string,
      saatIni: string,
    ): Promise<PeriodeRow> {
      const row = await satu<PeriodeRow>(
        tx,
        `update periode p
            set status = 'CLOSED', closed_by = $2::uuid, closed_at = $3::timestamptz,
                updated_by = $2::uuid
          where p.id = $1::uuid
        returning ${KOLOM_PERIODE}`,
        [periodeId, userId, saatIni],
      );
      if (!row) throw new Error("modules/closing: UPDATE periode CLOSED tidak mengembalikan baris");
      return row;
    },

    async tandaiOpenKembali(
      tx: QueryRunner,
      periodeId: string,
      userId: string,
      alasan: string,
      saatIni: string,
    ): Promise<PeriodeRow> {
      // ONE statement, because `trg_periode_10_transisi` is a BEFORE UPDATE OF
      // status that reads `NEW.alasan_reopen` and `NEW.reopened_by`: setting
      // them afterwards would be refused by TJSL-PER-003 / TJSL-PER-004.
      const row = await satu<PeriodeRow>(
        tx,
        `update periode p
            set status = 'OPEN', reopened_by = $2::uuid, reopened_at = $4::timestamptz,
                alasan_reopen = $3, updated_by = $2::uuid
          where p.id = $1::uuid
        returning ${KOLOM_PERIODE}`,
        [periodeId, userId, alasan, saatIni],
      );
      if (!row) throw new Error("modules/closing: UPDATE periode OPEN tidak mengembalikan baris");
      return row;
    },

    // --- configuration ----------------------------------------------------

    async konfigurasi(
      tx: QueryRunner,
      bumnId: string,
      grup: string,
      kunci: string,
    ): Promise<string | null> {
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

    /**
     * Spec 5.1 day bands, resolved AS A SET rather than row by row.
     *
     * A bumn that carries its own ladder owns the WHOLE ladder; the shipped
     * global rows are used only when it carries none. Falling back per class
     * would silently repair a ladder an operator is halfway through editing:
     * deleting the DIRAGUKAN band would leave the global 181..270 in force, so
     * the gap the engine must refuse would never be visible, and mixing two
     * ladders manufactures overlaps that belong to neither.
     */
    async rangeKolektibilitas(
      tx: QueryRunner,
      bumnId: string,
      padaTanggal: string,
    ): Promise<RangeRow[]> {
      return tx.query<RangeRow>(
        `select r.kelas_kode, r.hari_min, r.hari_max, r.berlaku_dari::text as berlaku_dari
           from kolektibilitas_range r
          where r.deleted_at is null and r.aktif and r.berlaku_dari <= $2::date
            and r.bumn_id is not distinct from (
              case when exists (
                select 1 from kolektibilitas_range x
                 where x.bumn_id = $1::uuid and x.deleted_at is null and x.aktif
              ) then $1::uuid else null::uuid end)
          order by r.hari_min, r.berlaku_dari`,
        [bumnId, padaTanggal],
      );
    },

    /** Spec 5.2 allowance rates, resolved as a set for the same reason. */
    async ratePenyisihan(
      tx: QueryRunner,
      bumnId: string,
      padaTanggal: string,
    ): Promise<RateRow[]> {
      return tx.query<RateRow>(
        `select r.kelas_kode, r.rate::text as rate, r.dasar_perhitungan,
                r.berlaku_dari::text as berlaku_dari
           from penyisihan_rate r
          where r.deleted_at is null and r.aktif and r.berlaku_dari <= $2::date
            and r.bumn_id is not distinct from (
              case when exists (
                select 1 from penyisihan_rate x
                 where x.bumn_id = $1::uuid and x.deleted_at is null and x.aktif
              ) then $1::uuid else null::uuid end)
          order by r.kelas_kode, r.berlaku_dari`,
        [bumnId, padaTanggal],
      );
    },

    // --- organisation -----------------------------------------------------

    cabangBumn(tx: QueryRunner, bumnId: string): Promise<Array<{ id: string }>> {
      return tx.query(
        `select id::text as id from cabang where bumn_id = $1::uuid and deleted_at is null order by kode`,
        [bumnId],
      );
    },

    /** The account the given event's mapping row debits / credits. */
    async akunEvent(
      tx: QueryRunner,
      bumnId: string,
      eventCode: string,
    ): Promise<{ akun_debit_id: string; akun_kredit_id: string } | null> {
      return satu(
        tx,
        `select akun_debit_id::text as akun_debit_id, akun_kredit_id::text as akun_kredit_id
           from event_jurnal_mapping
          where bumn_id = $1::uuid and event_code = $2 and aktif and deleted_at is null
          limit 1`,
        [bumnId, eventCode],
      );
    },

    // --- spec 8.1 population ---------------------------------------------

    /**
     * Spec 8.1 step 1. Only akads that represent money actually out the door:
     * a BELUM_CAIR akad has a schedule but no receivable, so however overdue
     * that (unfunded) schedule looks it must not carry an allowance.
     */
    akadPopulasi(
      tx: QueryRunner,
      bumnId: string,
      cabangIds: readonly string[],
      tanggalAkhir: string,
    ): Promise<AkadRow[]> {
      return tx.query<AkadRow>(
        `select a.id::text as akad_id, a.no_akad, a.mitra_id::text as mitra_id,
                a.cabang_id::text as cabang_id, m.sektor_id::text as sektor_id,
                a.outstanding_pokok::numeric(20,2)::text as outstanding_pokok,
                a.outstanding_jasa::numeric(20,2)::text as outstanding_jasa,
                t.tanggal_tertua::text as tanggal_tertua,
                t.tunggakan_pokok::text as tunggakan_pokok,
                t.tunggakan_jasa::text as tunggakan_jasa
           from pumk_akad a
           join cabang c on c.id = a.cabang_id and c.bumn_id = $1::uuid
           join mitra m on m.id = a.mitra_id
           left join lateral (
             select min(j.tanggal_jatuh_tempo) as tanggal_tertua,
                    coalesce(sum(j.pokok - j.pokok_terbayar), 0)::numeric(20,2) as tunggakan_pokok,
                    coalesce(sum(j.jasa_adm - j.jasa_terbayar), 0)::numeric(20,2) as tunggakan_jasa
               from pumk_jadwal_angsuran j
              where j.akad_id = a.id and j.is_active_version and j.deleted_at is null
                and j.tanggal_jatuh_tempo <= $2::date and j.status <> 'LUNAS'
           ) t on true
          where a.deleted_at is null
            and a.status in ('AKTIF', 'RESCHEDULED', 'MACET')
            and a.cabang_id in (${daftarPlaceholder(3, cabangIds.length)})
          order by a.id`,
        [bumnId, tanggalAkhir, ...cabangIds],
      );
    },

    /**
     * Spec 8.1 step 6: the class each akad carried the last time it was
     * snapshotted in an EARLIER period. Keyed on the akad rather than on
     * "the previous calendar month" so a gap in the closing history reads the
     * last known class instead of inventing "no previous class".
     */
    kelasPeriodeLalu(
      tx: QueryRunner,
      bumnId: string,
      tahun: number,
      bulan: number,
    ): Promise<Array<{ akad_id: string; kolektibilitas: KelasKolektibilitas }>> {
      return tx.query(
        `select distinct on (s.akad_id)
                s.akad_id::text as akad_id, s.kolektibilitas
           from kolektibilitas_snapshot s
           join periode pp on pp.id = s.periode_id
          where s.deleted_at is null and pp.bumn_id = $1::uuid
            and (pp.tahun, pp.bulan) < ($2::int, $3::int)
          order by s.akad_id, pp.tahun desc, pp.bulan desc`,
        [bumnId, tahun, bulan],
      );
    },

    // --- spec 8.1 writes --------------------------------------------------

    async hapusSnapshot(
      tx: QueryRunner,
      periodeId: string,
      cabangIds: readonly string[],
    ): Promise<void> {
      // PHYSICAL delete, deliberately: `kolektibilitas_snapshot_uq` is
      // (periode_id, akad_id) with NO `deleted_at IS NULL` predicate, so a
      // soft-deleted row would still block the rewrite invariant 13 requires.
      // The table carries no delete block for exactly this reason: a snapshot
      // is derived data, regenerable from the akad and the schedule.
      await tx.query(
        `delete from kolektibilitas_snapshot
          where periode_id = $1::uuid and cabang_id in (${daftarPlaceholder(2, cabangIds.length)})`,
        [periodeId, ...cabangIds],
      );
    },

    async tulisSnapshot(
      tx: QueryRunner,
      periodeId: string,
      closingId: string,
      userId: string,
      baris: readonly BarisSnapshotTulis[],
    ): Promise<void> {
      if (baris.length === 0) return;
      const params: unknown[] = [periodeId, closingId, userId];
      const values: string[] = [];
      for (const b of baris) {
        const i = params.length + 1;
        values.push(
          `($1::uuid, $2::uuid, $${i}::uuid, $${i + 1}::uuid, $${i + 2}::uuid, $${i + 3}::uuid,` +
            ` $${i + 4}::date, $${i + 5}::int, $${i + 6},` +
            ` $${i + 7}::numeric(20,2), $${i + 8}::numeric(20,2), $${i + 9}::numeric(20,2),` +
            ` $${i + 10}::numeric(20,2), $${i + 11}::numeric(9,6), $${i + 12},` +
            ` $${i + 13}::numeric(20,2), $${i + 14}, $${i + 15}, $${i + 16}::date,` +
            ` $${i + 17}::date, $3::uuid, $3::uuid)`,
        );
        params.push(
          b.akadId,
          b.mitraId,
          b.cabangId,
          b.sektorId,
          b.tanggalTertua,
          b.hariTunggakan,
          b.kolektibilitas,
          b.outstandingPokok,
          b.outstandingJasa,
          b.tunggakanPokok,
          b.tunggakanJasa,
          b.ratePenyisihan,
          b.dasarPerhitungan,
          b.nilaiPenyisihan,
          b.kolektibilitasPeriodeLalu,
          b.sumberRate,
          b.historiDari,
          b.historiSampai,
        );
      }
      await tx.query(
        `insert into kolektibilitas_snapshot
           (periode_id, closing_id, akad_id, mitra_id, cabang_id, sektor_id,
            tanggal_jatuh_tempo_tertunggak_tertua, hari_tunggakan, kolektibilitas,
            outstanding_pokok, outstanding_jasa, tunggakan_pokok, tunggakan_jasa,
            rate_penyisihan, dasar_perhitungan, nilai_penyisihan,
            kolektibilitas_periode_lalu, sumber_rate, rate_histori_dari,
            rate_histori_sampai, created_by, updated_by)
         values ${values.join(", ")}`,
        params,
      );
    },

    bacaSnapshot(
      tx: QueryRunner,
      periodeId: string,
      cabangIds: readonly string[] | null,
    ): Promise<SnapshotBarisDb[]> {
      const filter =
        cabangIds === null
          ? ""
          : ` and s.cabang_id in (${daftarPlaceholder(2, cabangIds.length)})`;
      return tx.query<SnapshotBarisDb>(
        `select s.akad_id::text as akad_id, a.no_akad, s.mitra_id::text as mitra_id,
                s.cabang_id::text as cabang_id, s.sektor_id::text as sektor_id,
                s.tanggal_jatuh_tempo_tertunggak_tertua::text as tanggal_jatuh_tempo_tertunggak_tertua,
                s.hari_tunggakan, s.kolektibilitas, s.kolektibilitas_periode_lalu,
                s.outstanding_pokok::text as outstanding_pokok,
                s.outstanding_jasa::text as outstanding_jasa,
                s.tunggakan_pokok::text as tunggakan_pokok,
                s.tunggakan_jasa::text as tunggakan_jasa,
                s.rate_penyisihan::text as rate_penyisihan, s.dasar_perhitungan,
                s.sumber_rate, s.nilai_penyisihan::text as nilai_penyisihan
           from kolektibilitas_snapshot s
           join pumk_akad a on a.id = s.akad_id
          where s.periode_id = $1::uuid and s.deleted_at is null${filter}
          order by s.akad_id`,
        cabangIds === null ? [periodeId] : [periodeId, ...cabangIds],
      );
    },

    async runSelesai(
      tx: QueryRunner,
      periodeId: string,
      cabangId: string | null,
    ): Promise<{ id: string } | null> {
      return satu(
        tx,
        `select id::text as id from closing_kolektibilitas
          where periode_id = $1::uuid and cabang_id is not distinct from $2::uuid
            and status = 'SELESAI' and deleted_at is null
          limit 1`,
        [periodeId, cabangId],
      );
    },

    async adaRunSelesai(tx: QueryRunner, periodeId: string): Promise<boolean> {
      const row = await satu<{ n: string }>(
        tx,
        `select count(*)::text as n from closing_kolektibilitas
          where periode_id = $1::uuid and status = 'SELESAI' and deleted_at is null`,
        [periodeId],
      );
      return Number.parseInt(row?.n ?? "0", 10) > 0;
    },

    async simpanRun(
      tx: QueryRunner,
      input: {
        id: string | null;
        periodeId: string;
        cabangId: string | null;
        userId: string;
        total: number;
        ringkasan: string;
      },
    ): Promise<string> {
      if (input.id) {
        // UPDATE IN PLACE rather than soft-delete-and-insert: invariant 13 says
        // a re-run leaves ONE committed run for the scope, and
        // `closing_kolektibilitas_selesai_uq` enforces it. Rewriting the row
        // also keeps `closingId` stable for the snapshots that point at it.
        await tx.query(
          `update closing_kolektibilitas
              set tanggal_jalan = now(), dijalankan_oleh = $2::uuid,
                  total_akad_diproses = $3::int, ringkasan_json = $4::text::jsonb,
                  updated_by = $2::uuid
            where id = $1::uuid`,
          [input.id, input.userId, input.total, input.ringkasan],
        );
        return input.id;
      }
      const row = await satu<{ id: string }>(
        tx,
        `insert into closing_kolektibilitas
           (periode_id, cabang_id, status, dijalankan_oleh, total_akad_diproses,
            ringkasan_json, created_by, updated_by)
         values ($1::uuid, $2::uuid, 'SELESAI', $3::uuid, $4::int, $5::text::jsonb, $3::uuid, $3::uuid)
         returning id::text as id`,
        [input.periodeId, input.cabangId, input.userId, input.total, input.ringkasan],
      );
      if (!row) throw new Error("modules/closing: INSERT closing_kolektibilitas tidak mengembalikan id");
      return row.id;
    },

    riwayatRun(
      tx: QueryRunner,
      periodeId: string,
    ): Promise<
      Array<{
        id: string;
        periode_id: string;
        cabang_id: string | null;
        tanggal_jalan: string;
        status: string;
        dijalankan_oleh: string | null;
        total_akad_diproses: number;
      }>
    > {
      return tx.query(
        `select id::text as id, periode_id::text as periode_id, cabang_id::text as cabang_id,
                tanggal_jalan::text as tanggal_jalan, status,
                dijalankan_oleh::text as dijalankan_oleh, total_akad_diproses
           from closing_kolektibilitas
          where periode_id = $1::uuid and deleted_at is null
          order by tanggal_jalan`,
        [periodeId],
      );
    },

    /** Spec 8.1 step 7. Only a mitra that is currently AKTIF is moved. */
    async tandaiMitraBermasalah(
      tx: QueryRunner,
      mitraIds: readonly string[],
      userId: string,
    ): Promise<string[]> {
      if (mitraIds.length === 0) return [];
      const rows = await tx.query<{ id: string }>(
        `update mitra set status = 'BERMASALAH', updated_by = $1::uuid
          where id in (${daftarPlaceholder(2, mitraIds.length)})
            and status = 'AKTIF' and deleted_at is null
        returning id::text as id`,
        [userId, ...mitraIds],
      );
      return rows.map((r) => r.id);
    },

    // --- spec 8.2 ---------------------------------------------------------

    /**
     * The allowance account balance, debit-positive, FROM THE LEDGER.
     *
     * `kecualiJurnalIds` exists so a re-run can measure the opening position it
     * measured the first time: the allowance journal this very step posted is
     * excluded, and the arithmetic reproduces instead of compounding.
     */
    async saldoAkun(
      tx: QueryRunner,
      input: {
        bumnId: string;
        akunId: string;
        sampaiTanggal: string;
        cabangId?: string | null;
        kecualiJurnalIds?: readonly string[];
      },
    ): Promise<string> {
      const params: unknown[] = [input.akunId, input.sampaiTanggal, input.bumnId];
      let filter = "";
      if (input.cabangId) {
        params.push(input.cabangId);
        filter += ` and l.cabang_id = $${params.length}::uuid`;
      }
      const kecuali = input.kecualiJurnalIds ?? [];
      if (kecuali.length > 0) {
        filter += ` and l.jurnal_id not in (${daftarPlaceholder(params.length + 1, kecuali.length)})`;
        params.push(...kecuali);
      }
      const row = await satu<{ saldo: string }>(
        tx,
        `select coalesce(sum(l.debit - l.kredit), 0)::numeric(20,2)::text as saldo
           from v_ledger_baris l
          where l.akun_id = $1::uuid and l.tanggal_transaksi <= $2::date
            and l.bumn_id = $3::uuid${filter}`,
        params,
      );
      return row?.saldo ?? "0.00";
    },

    async totalPenyisihanDibutuhkan(
      tx: QueryRunner,
      periodeId: string,
      cabangId: string,
    ): Promise<string> {
      const row = await satu<{ total: string }>(
        tx,
        `select coalesce(sum(nilai_penyisihan), 0)::numeric(20,2)::text as total
           from kolektibilitas_snapshot
          where periode_id = $1::uuid and cabang_id = $2::uuid and deleted_at is null`,
        [periodeId, cabangId],
      );
      return row?.total ?? "0.00";
    },

    penyisihanPeriode(tx: QueryRunner, periodeId: string): Promise<PenyisihanRow[]> {
      return tx.query<PenyisihanRow>(
        `select id::text as id, cabang_id::text as cabang_id,
                saldo_penyisihan_awal::text as saldo_penyisihan_awal,
                penyisihan_dibutuhkan::text as penyisihan_dibutuhkan,
                beban_penyisihan_periode::text as beban_penyisihan_periode,
                jurnal_id::text as jurnal_id, tanggal::text as tanggal
           from penyisihan_periode
          where periode_id = $1::uuid and deleted_at is null
          order by cabang_id`,
        [periodeId],
      );
    },

    async simpanPenyisihan(
      tx: QueryRunner,
      input: {
        id: string | null;
        periodeId: string;
        cabangId: string;
        saldoAwal: string;
        dibutuhkan: string;
        beban: string;
        jurnalId: string | null;
        tanggal: string;
        userId: string;
      },
    ): Promise<string> {
      if (input.id) {
        await tx.query(
          `update penyisihan_periode
              set saldo_penyisihan_awal = $2::numeric(20,2),
                  penyisihan_dibutuhkan = $3::numeric(20,2),
                  beban_penyisihan_periode = $4::numeric(20,2),
                  jurnal_id = $5::uuid, tanggal = $6::date, dijalankan_oleh = $7::uuid,
                  updated_by = $7::uuid
            where id = $1::uuid`,
          [
            input.id,
            input.saldoAwal,
            input.dibutuhkan,
            input.beban,
            input.jurnalId,
            input.tanggal,
            input.userId,
          ],
        );
        return input.id;
      }
      const row = await satu<{ id: string }>(
        tx,
        `insert into penyisihan_periode
           (periode_id, cabang_id, saldo_penyisihan_awal, penyisihan_dibutuhkan,
            beban_penyisihan_periode, jurnal_id, dijalankan_oleh, tanggal,
            created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::numeric(20,2), $4::numeric(20,2),
                 $5::numeric(20,2), $6::uuid, $7::uuid, $8::date, $7::uuid, $7::uuid)
         returning id::text as id`,
        [
          input.periodeId,
          input.cabangId,
          input.saldoAwal,
          input.dibutuhkan,
          input.beban,
          input.jurnalId,
          input.userId,
          input.tanggal,
        ],
      );
      if (!row) throw new Error("modules/closing: INSERT penyisihan_periode tidak mengembalikan id");
      return row.id;
    },

    // --- spec 8.3 ---------------------------------------------------------

    /**
     * Jasa administrasi falling due INSIDE the period, and how much of it the
     * ACTIVE schedule version already records as received, per akad. Restricted
     * to the akads this period's snapshot classified into the accrual classes,
     * because spec 8.3's population is defined by class.
     */
    akrualKandidat(
      tx: QueryRunner,
      input: {
        periodeId: string;
        cabangIds: readonly string[];
        kelas: readonly string[];
        mulai: string;
        akhir: string;
      },
    ): Promise<
      Array<{
        akad_id: string;
        no_akad: string;
        cabang_id: string;
        kolektibilitas: KelasKolektibilitas;
        jasa_jatuh_tempo: string;
        jasa_diterima: string;
      }>
    > {
      const params: unknown[] = [input.periodeId, input.mulai, input.akhir];
      const phCabang = daftarPlaceholder(params.length + 1, input.cabangIds.length);
      params.push(...input.cabangIds);
      const phKelas = daftarPlaceholder(params.length + 1, input.kelas.length, "::text");
      params.push(...input.kelas);
      return tx.query(
        `select s.akad_id::text as akad_id, a.no_akad, s.cabang_id::text as cabang_id,
                s.kolektibilitas,
                j.jasa_jatuh_tempo::text as jasa_jatuh_tempo,
                j.jasa_diterima::text as jasa_diterima
           from kolektibilitas_snapshot s
           join pumk_akad a on a.id = s.akad_id
           join lateral (
             select coalesce(sum(r.jasa_adm), 0)::numeric(20,2) as jasa_jatuh_tempo,
                    coalesce(sum(r.jasa_terbayar), 0)::numeric(20,2) as jasa_diterima
               from pumk_jadwal_angsuran r
              where r.akad_id = s.akad_id and r.is_active_version and r.deleted_at is null
                and r.tanggal_jatuh_tempo between $2::date and $3::date
           ) j on true
          where s.periode_id = $1::uuid and s.deleted_at is null
            and s.cabang_id in (${phCabang})
            and s.kolektibilitas in (${phKelas})
          order by s.akad_id`,
        params,
      );
    },

    /** Spec 8.4 check 6: is any akad even eligible for an accrual this period? */
    async adaKandidatAkrual(
      tx: QueryRunner,
      periodeId: string,
      kelas: readonly string[],
    ): Promise<boolean> {
      if (kelas.length === 0) return false;
      const row = await satu<{ n: string }>(
        tx,
        `select count(*)::text as n from kolektibilitas_snapshot
          where periode_id = $1::uuid and deleted_at is null
            and kolektibilitas in (${daftarPlaceholder(2, kelas.length, "::text")})`,
        [periodeId, ...kelas],
      );
      return Number.parseInt(row?.n ?? "0", 10) > 0;
    },

    akrualSnapshot(tx: QueryRunner, periodeId: string): Promise<AkrualRow[]> {
      return tx.query<AkrualRow>(
        `select s.akad_id::text as akad_id, a.no_akad, s.cabang_id::text as cabang_id,
                s.kolektibilitas,
                s.jasa_jatuh_tempo_periode::text as jasa_jatuh_tempo_periode,
                s.jasa_diterima_periode::text as jasa_diterima_periode,
                s.jasa_diakrual::text as jasa_diakrual, s.jurnal_id::text as jurnal_id
           from akrual_jasa_snapshot s
           join pumk_akad a on a.id = s.akad_id
          where s.periode_id = $1::uuid and s.deleted_at is null
          order by s.akad_id`,
        [periodeId],
      );
    },

    async hapusAkrual(
      tx: QueryRunner,
      periodeId: string,
      cabangIds: readonly string[],
    ): Promise<void> {
      // Physical, for the same reason as the kolektibilitas snapshot:
      // `akrual_jasa_snapshot_uq` is (periode_id, akad_id) with no
      // `deleted_at IS NULL` predicate, so invariant 13's rewrite needs the row
      // actually gone.
      await tx.query(
        `delete from akrual_jasa_snapshot
          where periode_id = $1::uuid and cabang_id in (${daftarPlaceholder(2, cabangIds.length)})`,
        [periodeId, ...cabangIds],
      );
    },

    async tulisAkrual(
      tx: QueryRunner,
      periodeId: string,
      userId: string,
      baris: ReadonlyArray<{
        akadId: string;
        cabangId: string;
        kolektibilitas: string;
        jatuhTempo: string;
        diterima: string;
        diakrual: string;
        jurnalId: string | null;
      }>,
    ): Promise<void> {
      if (baris.length === 0) return;
      const params: unknown[] = [periodeId, userId];
      const values: string[] = [];
      for (const b of baris) {
        const i = params.length + 1;
        values.push(
          `($1::uuid, $${i}::uuid, $${i + 1}::uuid, $${i + 2}, $${i + 3}::numeric(20,2),` +
            ` $${i + 4}::numeric(20,2), $${i + 5}::numeric(20,2), $${i + 6}::uuid, $2::uuid, $2::uuid)`,
        );
        params.push(
          b.akadId,
          b.cabangId,
          b.kolektibilitas,
          b.jatuhTempo,
          b.diterima,
          b.diakrual,
          b.jurnalId,
        );
      }
      await tx.query(
        `insert into akrual_jasa_snapshot
           (periode_id, akad_id, cabang_id, kolektibilitas, jasa_jatuh_tempo_periode,
            jasa_diterima_periode, jasa_diakrual, jurnal_id, created_by, updated_by)
         values ${values.join(", ")}`,
        params,
      );
    },

    // --- spec 8.4 prerequisites ------------------------------------------

    jurnalDraftPeriode(
      tx: QueryRunner,
      bumnId: string,
      mulai: string,
      akhir: string,
    ): Promise<Array<{ id: string; no_jurnal: string; tanggal_transaksi: string }>> {
      return tx.query(
        `select id::text as id, no_jurnal, tanggal_transaksi::text as tanggal_transaksi
           from jurnal
          where bumn_id = $1::uuid and status = 'DRAFT' and deleted_at is null
            and tanggal_transaksi between $2::date and $3::date
          order by no_jurnal`,
        [bumnId, mulai, akhir],
      );
    },

    jurnalTidakBalance(
      tx: QueryRunner,
      periodeId: string,
    ): Promise<Array<{ no_jurnal: string; selisih: string }>> {
      // Reads the SHIPPED integrity view, which computes from the LINES.
      // spec 8.4: "query verifikasi, jangan percaya kolom total".
      return tx.query(
        `select v.no_jurnal, v.selisih::numeric(20,2)::text as selisih
           from v_integritas_jurnal v
           join jurnal j on j.id = v.jurnal_id
          where j.periode_id = $1::uuid
          order by v.no_jurnal`,
        [periodeId],
      );
    },

    async selisihLedger(tx: QueryRunner, bumnId: string, sampaiTanggal: string): Promise<string> {
      const row = await satu<{ selisih: string }>(
        tx,
        `select coalesce(sum(l.debit) - sum(l.kredit), 0)::numeric(20,2)::text as selisih
           from v_ledger_baris l
          where l.bumn_id = $1::uuid and l.tanggal_transaksi <= $2::date`,
        [bumnId, sampaiTanggal],
      );
      return row?.selisih ?? "0.00";
    },

    /** Spec 8.4 check 8. Every account the COA marks `is_kas`, at period end. */
    saldoKas(
      tx: QueryRunner,
      bumnId: string,
      sampaiTanggal: string,
    ): Promise<Array<{ akun_kode: string; akun_nama: string; saldo: string }>> {
      return tx.query(
        `select a.kode as akun_kode, a.nama as akun_nama,
                coalesce(sum(l.debit - l.kredit), 0)::numeric(20,2)::text as saldo
           from akun a
           left join v_ledger_baris l
             on l.akun_id = a.id and l.tanggal_transaksi <= $2::date and l.bumn_id = $1::uuid
          where a.bumn_id = $1::uuid and a.is_kas and a.deleted_at is null
          group by a.kode, a.nama
          order by a.kode`,
        [bumnId, sampaiTanggal],
      );
    },

    outstandingNegatif(
      tx: QueryRunner,
      bumnId: string,
    ): Promise<Array<{ akad_id: string; no_akad: string; outstanding_pokok: string }>> {
      return tx.query(
        `select a.id::text as akad_id, a.no_akad,
                a.outstanding_pokok::numeric(20,2)::text as outstanding_pokok
           from pumk_akad a
           join cabang c on c.id = a.cabang_id and c.bumn_id = $1::uuid
          where a.deleted_at is null and a.outstanding_pokok < 0
          order by a.no_akad`,
        [bumnId],
      );
    },

    /** Spec 8.4 check 10, from the SHIPPED reconciliation view. */
    subLedgerTidakCocok(
      tx: QueryRunner,
      bumnId: string,
    ): Promise<
      Array<{
        akad_id: string;
        no_akad: string;
        saldo_sub_ledger: string;
        saldo_buku_besar: string;
        selisih: string;
      }>
    > {
      return tx.query(
        `select r.akad_id::text as akad_id, r.no_akad,
                r.saldo_sub_ledger::text as saldo_sub_ledger,
                r.saldo_buku_besar::text as saldo_buku_besar,
                r.selisih::text as selisih
           from v_rekonsiliasi_piutang r
           join cabang c on c.id = r.cabang_id
          where c.bumn_id = $1::uuid and r.selisih <> 0
          order by r.no_akad`,
        [bumnId],
      );
    },

    // --- spec 8.4 frozen trial balance -----------------------------------

    /**
     * THE NUMBER THIS MODULE MUST NOT GET WRONG (ADR 0010).
     *
     * Read from `v_ledger_baris`, whose predicate is
     * `status IN ('POSTED','REVERSED')`. A `status = 'POSTED'` variant would
     * drop a reversed journal's original lines while keeping the reversing
     * journal's, i.e. subtract a correction it never added; and because closing
     * FREEZES this, the error would be permanent and undetectable (the identity
     * still holds, the trial balance still sums to zero, all ten prerequisites
     * still pass).
     *
     * Debit-positive for every account type, which is the convention
     * `saldo_akun_periode_identitas_ck` enforces.
     */
    saldoAkunUntukPeriode(
      tx: QueryRunner,
      bumnId: string,
      mulai: string,
      akhir: string,
    ): Promise<SaldoRow[]> {
      return tx.query<SaldoRow>(
        `with gerak as (
           select l.cabang_id, l.akun_id,
                  coalesce(sum(case when l.tanggal_transaksi < $2::date
                                    then l.debit - l.kredit else 0 end), 0)::numeric(20,2) as saldo_awal,
                  coalesce(sum(case when l.tanggal_transaksi >= $2::date
                                    then l.debit else 0 end), 0)::numeric(20,2) as mutasi_debit,
                  coalesce(sum(case when l.tanggal_transaksi >= $2::date
                                    then l.kredit else 0 end), 0)::numeric(20,2) as mutasi_kredit
             from v_ledger_baris l
            where l.bumn_id = $1::uuid and l.tanggal_transaksi <= $3::date
            group by l.cabang_id, l.akun_id
         )
         select g.cabang_id::text as cabang_id, g.akun_id::text as akun_id, a.kode as akun_kode,
                g.saldo_awal::text as saldo_awal,
                g.mutasi_debit::text as mutasi_debit,
                g.mutasi_kredit::text as mutasi_kredit,
                (g.saldo_awal + g.mutasi_debit - g.mutasi_kredit)::numeric(20,2)::text as saldo_akhir
           from gerak g
           join akun a on a.id = g.akun_id
          where g.saldo_awal <> 0 or g.mutasi_debit <> 0 or g.mutasi_kredit <> 0
          order by a.kode, g.cabang_id`,
        [bumnId, mulai, akhir],
      );
    },

    async hapusSaldoAkunPeriode(tx: QueryRunner, periodeId: string): Promise<void> {
      // Spec 8.4: reopening a period DELETES its frozen balances. Safe
      // precisely because they are derived and fully regenerable from the
      // ledger, which is exactly why deleting a `jurnal` row never is.
      await tx.query(`delete from saldo_akun_periode where periode_id = $1::uuid`, [periodeId]);
    },

    async tulisSaldoAkunPeriode(
      tx: QueryRunner,
      periodeId: string,
      userId: string,
      baris: readonly SaldoRow[],
    ): Promise<void> {
      if (baris.length === 0) return;
      const params: unknown[] = [periodeId, userId];
      const values: string[] = [];
      for (const b of baris) {
        const i = params.length + 1;
        values.push(
          `($1::uuid, $${i}::uuid, $${i + 1}::uuid, $${i + 2}::numeric(20,2),` +
            ` $${i + 3}::numeric(20,2), $${i + 4}::numeric(20,2), $${i + 5}::numeric(20,2), $2::uuid, $2::uuid)`,
        );
        params.push(
          b.cabang_id,
          b.akun_id,
          b.saldo_awal,
          b.mutasi_debit,
          b.mutasi_kredit,
          b.saldo_akhir,
        );
      }
      await tx.query(
        `insert into saldo_akun_periode
           (periode_id, cabang_id, akun_id, saldo_awal, mutasi_debit, mutasi_kredit,
            saldo_akhir, created_by, updated_by)
         values ${values.join(", ")}`,
        params,
      );
    },

    bacaSaldoAkunPeriode(
      tx: QueryRunner,
      filter: { periodeId: string; cabangId?: string | null; akunId?: string | null },
    ): Promise<SaldoRow[]> {
      const params: unknown[] = [filter.periodeId];
      let where = "";
      if (filter.cabangId) {
        params.push(filter.cabangId);
        where += ` and s.cabang_id = $${params.length}::uuid`;
      }
      if (filter.akunId) {
        params.push(filter.akunId);
        where += ` and s.akun_id = $${params.length}::uuid`;
      }
      return tx.query<SaldoRow>(
        `select s.cabang_id::text as cabang_id, s.akun_id::text as akun_id, a.kode as akun_kode,
                s.saldo_awal::text as saldo_awal, s.mutasi_debit::text as mutasi_debit,
                s.mutasi_kredit::text as mutasi_kredit, s.saldo_akhir::text as saldo_akhir
           from saldo_akun_periode s
           join akun a on a.id = s.akun_id
          where s.periode_id = $1::uuid and s.deleted_at is null${where}
          order by a.kode, s.cabang_id`,
        params,
      );
    },

    // --- KOLEKTIF_HISTORIS ------------------------------------------------

    /** Earliest ledger activity for this bumn: how far back the history goes. */
    async awalHistori(tx: QueryRunner, bumnId: string, sampai: string): Promise<string | null> {
      const row = await satu<{ awal: string | null }>(
        tx,
        `select min(l.tanggal_transaksi)::text as awal
           from v_ledger_baris l
          where l.bumn_id = $1::uuid and l.tanggal_transaksi <= $2::date`,
        [bumnId, sampai],
      );
      return row?.awal ?? null;
    },

    /**
     * Collective non-collection, per class, over a window: of everything that
     * fell due inside the window on akads carrying that class, how much was
     * never collected. Expressed in millionths so the caller can build a
     * NUMERIC(9,6) rate without touching a float.
     */
    kolektifHistoris(
      tx: QueryRunner,
      input: { bumnId: string; dari: string; sampai: string },
    ): Promise<Array<{ kelas: KelasKolektibilitas; jatuh_tempo: string; tertagih: string }>> {
      return tx.query(
        `select s.kelas as kelas,
                coalesce(sum(s.jatuh_tempo), 0)::numeric(20,2)::text as jatuh_tempo,
                coalesce(sum(s.tertagih), 0)::numeric(20,2)::text as tertagih
           from (
             select k.kolektibilitas as kelas,
                    (r.pokok + r.jasa_adm) as jatuh_tempo,
                    (r.pokok_terbayar + r.jasa_terbayar) as tertagih
               from pumk_jadwal_angsuran r
               join pumk_akad a on a.id = r.akad_id
               join cabang c on c.id = a.cabang_id and c.bumn_id = $1::uuid
               join lateral (
                 select ks.kolektibilitas
                   from kolektibilitas_snapshot ks
                   join periode pp on pp.id = ks.periode_id
                  where ks.akad_id = a.id and ks.deleted_at is null
                    and pp.tanggal_akhir <= $3::date
                  order by pp.tahun desc, pp.bulan desc
                  limit 1
               ) k on true
              where r.is_active_version and r.deleted_at is null
                and r.tanggal_jatuh_tempo between $2::date and $3::date
           ) s
          group by s.kelas`,
        [input.bumnId, input.dari, input.sampai],
      );
    },
  };
}

export type RepoClosing = ReturnType<typeof buatRepoClosing>;
