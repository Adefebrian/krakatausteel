// apps/api/src/modules/laporan/repo-operasional.ts
//
// EVERY SQL STATEMENT THE OPERATIONAL REPORTS ISSUE (spec 10.1, 10.2, 10.4 and
// report 21), AND NOTHING ELSE. All of them are SELECTs, for the reason
// ./repo.ts gives: spec 16 scenario 23 requires an Auditor to open every
// report and change nothing, so an INSERT, UPDATE or DELETE in this file would
// be a defect rather than a feature.
//
// FOUR THINGS THAT BITE HERE, THREE OF THEM DRIVER FACTS FROM
// modules/jurnal/repo.ts:
//
//   1. A JS ARRAY BINDS AS A COMMA-JOINED STRING, so `= ANY($n::uuid[])` fails
//      22P02. Every branch list below goes through `daftar()`, which pushes one
//      parameter per id and renders explicit placeholders. This file cannot use
//      ./repo.ts's `filterCabang` helper, which takes one nullable id: the
//      operational tables have no `bumn_id` column (see 4), so "Semua Cabang"
//      has to be an explicit list rather than the absence of a predicate.
//
//   2. `coalesce(sum(x), 0)` YIELDS THE STRING '0', NOT '0.00'. Every monetary
//      aggregate casts `::numeric(20,2)` BEFORE `::text`, or ./uang.ts's
//      `uangDariDb` refuses it loudly at the boundary. Non-aggregated
//      NUMERIC(20,2) columns are already two-decimal and are cast `::text`
//      directly.
//
//   3. A DATE COMES BACK AS A JS `Date`. Every date column is selected `::text`
//      so an ISO string is what the engine compares and prints. TIMESTAMPTZ is
//      different: `tanggal_submit` and `audit_log.waktu` are instants, and they
//      are rendered explicitly rather than left to the driver.
//
//   4. THE OPERATIONAL TABLES HAVE NO `bumn_id`. `pumk_akad`, `mitra`,
//      `nonpumk_proposal`, `jurnal` and the rest are tied to the entity only
//      through `cabang_id`, so the branch list IS the entity filter and there
//      is no second predicate that would catch a mistake in it. That is why
//      ./dasar.ts's `cabangUntukQuery` builds the list from `cabang` rows of
//      this entity and never from the request.
//
// AND THE LEDGER PREDICATE, ADR 0010. Every figure derived from the ledger
// reads `v_ledger_baris` (`status IN ('POSTED','REVERSED')`), never
// `status = 'POSTED'` alone. It matters more here than in the statements: a
// reversed disbursement must leave a sector's realisation, and a POSTED-only
// read would leave it there while the reversing journal subtracted it again
// somewhere else, which balances and is wrong.
import type { QueryRunner } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

/**
 * Renders `$3::uuid, $4::uuid, ...` for an id list, pushing each id as its own
 * parameter. Driver fact 1. An EMPTY list renders `null::uuid`, which matches
 * nothing rather than being a syntax error: a caller with no branches in scope
 * gets an empty report, and `pastikanCabang` has already refused the cases
 * where that would be a wrong answer rather than a true one.
 */
function daftar(params: unknown[], ids: readonly string[]): string {
  if (ids.length === 0) return "null::uuid";
  return ids
    .map((id) => {
      params.push(id);
      return `$${params.length}::uuid`;
    })
    .join(", ");
}

async function satu<T>(tx: QueryRunner, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await tx.query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface RentangCabang {
  bumnId: string;
  cabangIds: readonly string[];
  dari: string;
  sampai: string;
}

/** One (sektor, provinsi, kota, mitra) cell of the disbursement ledger. */
export interface PencairanDimensiRow {
  sektor_id: string | null;
  sektor_kode: string | null;
  sektor_nama: string | null;
  provinsi_id: string | null;
  provinsi_nama: string | null;
  kota_id: string | null;
  kota_nama: string | null;
  mitra_id: string;
  nilai: string;
}

export interface PenerimaanAngsuranRow {
  angsuran_id: string;
  tanggal_terima: string;
  tanggal_valuta: string | null;
  mitra_id: string;
  kode_mitra: string;
  nama_mitra: string;
  akad_id: string;
  no_akad: string;
  pokok: string;
  jasa: string;
  kelebihan: string;
  total: string;
  no_bukti: string | null;
  jurnal_id: string | null;
  cabang_id: string;
}

export interface JatuhTempoRow {
  jadwal_id: string;
  mitra_id: string;
  kode_mitra: string;
  nama_mitra: string;
  akad_id: string;
  no_akad: string;
  angsuran_ke: number;
  tanggal_jatuh_tempo: string;
  status: string;
  pokok: string;
  jasa: string;
  cabang_id: string;
}

export interface PermohonanRow {
  proposal_id: string;
  status: string;
  sektor_id: string | null;
  sektor_kode: string | null;
  sektor_nama: string | null;
  jumlah_diajukan: string;
  jumlah_disetujui: string | null;
}

export interface AkadBulanRow {
  tahun: number;
  bulan: number;
  akad_id: string;
  mitra_id: string;
  pokok: string;
}

export interface AkadPertamaRow {
  mitra_id: string;
  tanggal_pertama: string;
}

export interface SnapshotKolektibilitasRow {
  akad_id: string;
  no_akad: string;
  mitra_id: string;
  kode_mitra: string;
  nama_mitra: string;
  cabang_id: string;
  nama_cabang: string;
  sektor_id: string | null;
  sektor_kode: string | null;
  sektor_nama: string | null;
  hari_tunggakan: number;
  kolektibilitas: string;
  kolektibilitas_periode_lalu: string | null;
  outstanding_pokok: string;
  outstanding_jasa: string;
  tunggakan_pokok: string;
  tunggakan_jasa: string;
  rate_penyisihan: string;
  dasar_perhitungan: string;
  sumber_rate: string | null;
  rate_histori_dari: string | null;
  rate_histori_sampai: string | null;
  nilai_penyisihan: string;
}

export interface KelasKolektibilitasRow {
  kode: string;
  nama: string;
  urutan: number;
}

export interface MitraRow {
  id: string;
  kode_mitra: string;
  nama_lengkap: string;
  cabang_id: string;
}

export interface KartuAkadRow {
  akad_id: string;
  no_akad: string;
  tanggal_akad: string;
  status: string;
  pokok_pinjaman: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
  dicairkan: string;
}

export interface KartuJadwalRow {
  akad_id: string;
  jadwal_id: string;
  angsuran_ke: number;
  tanggal_jatuh_tempo: string;
  pokok: string;
  jasa_adm: string;
  total: string;
  pokok_terbayar: string;
  jasa_terbayar: string;
  status: string;
  tanggal_lunas: string | null;
}

export interface KartuSetoranRow {
  akad_id: string;
  angsuran_id: string;
  tanggal_terima: string;
  jumlah_diterima: string;
  pokok: string;
  jasa: string;
  kelebihan: string;
  no_bukti: string | null;
  jurnal_id: string | null;
}

export interface PenyaluranNonPumkRow {
  penyaluran_id: string;
  proposal_id: string;
  no_proposal: string;
  nama_pemohon: string;
  judul_program: string;
  bidang_id: string;
  bidang_kode: string;
  bidang_nama: string;
  termin: number;
  tanggal_penyaluran: string;
  jumlah: string;
  jumlah_disetujui: string;
  status_lpj: string | null;
  penerima_manfaat: number | null;
  no_bukti: string | null;
  jurnal_id: string | null;
  cabang_id: string;
}

export interface ProposalSdgRow {
  proposal_id: string;
  sdg_id: string;
  nomor: number;
  nama: string;
}

export interface MonitoringLpjRow {
  proposal_id: string;
  no_proposal: string;
  nama_pemohon: string;
  judul_program: string;
  bidang_nama: string;
  cabang_id: string;
  tanggal_salur_terakhir: string | null;
  nilai_disalurkan: string;
  status_lpj: string | null;
  tanggal_lpj: string | null;
  jumlah_realisasi: string;
  jumlah_sisa: string;
  penerima_manfaat_estimasi: number | null;
  penerima_manfaat_aktual: number | null;
}

export interface RekapJurnalRow {
  jenis: string;
  status: string;
  jumlah: string;
  total_debit: string;
  total_kredit: string;
}

export interface PortalRow {
  submission_id: string;
  no_tiket: string;
  tanggal_submit: string;
  status: string;
  converted_proposal_id: string | null;
  nama_dari_json: string | null;
  nilai_dari_json: string | null;
  nama_proposal: string | null;
  no_proposal: string | null;
  nilai_proposal: string | null;
  cabang_id: string | null;
}

export interface DemografiMitraRow {
  mitra_id: string;
  jenis_kelamin: string | null;
  tanggal_lahir: string | null;
  sektor_id: string | null;
  sektor_kode: string | null;
  sektor_nama: string | null;
  provinsi_id: string | null;
  provinsi_nama: string | null;
  tahun_mulai_usaha: number | null;
  jumlah_tenaga_kerja: number | null;
  omzet_bulanan: string | null;
}

export interface PenyisihanPeriodeRow {
  penyisihan_id: string;
  periode_id: string;
  tahun: number;
  bulan: number;
  status_periode: string;
  cabang_id: string;
  nama_cabang: string;
  tanggal: string;
  saldo_awal: string;
  dibutuhkan: string;
  beban: string;
}

export interface PenyisihanJurnalRow {
  penyisihan_periode_id: string;
  jurnal_id: string;
  no_jurnal: string;
  tanggal: string;
  nilai: string;
}

export interface AkrualJasaRow {
  akad_id: string;
  no_akad: string;
  mitra_id: string;
  kode_mitra: string;
  nama_mitra: string;
  cabang_id: string;
  kolektibilitas: string;
  jatuh_tempo: string;
  diterima: string;
  diakrual: string;
  metode: string;
  kelas_diakrual: unknown;
  jurnal_id: string | null;
}

export interface AuditTrailRow {
  id: string;
  waktu: string;
  user_id: string | null;
  nama_user: string | null;
  ip: string | null;
  aksi: string;
  entitas: string;
  entitas_id: string | null;
  hasil: string;
  keterangan: string | null;
}

export interface AnggaranDimensiRow {
  dimensi_id: string | null;
  jumlah: string;
}

export interface BaselineRkaRow {
  id: string;
  versi: number;
}

export interface DimensiMasterRow {
  id: string;
  kode: string;
  nama: string;
}

export interface SdgMasterRow {
  id: string;
  nomor: number;
  nama: string;
}

export interface CabangNamaRow {
  id: string;
  kode: string;
  nama: string;
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export interface LaporanOperasionalRepo {
  pencairanDimensi(tx: QueryRunner, q: RentangCabang): Promise<PencairanDimensiRow[]>;
  penerimaanAngsuran(tx: QueryRunner, q: RentangCabang): Promise<PenerimaanAngsuranRow[]>;
  jatuhTempo(tx: QueryRunner, q: RentangCabang): Promise<JatuhTempoRow[]>;
  permohonan(tx: QueryRunner, q: RentangCabang): Promise<PermohonanRow[]>;
  akadPerBulan(tx: QueryRunner, q: RentangCabang): Promise<AkadBulanRow[]>;
  akadPertamaMitra(tx: QueryRunner, mitraIds: readonly string[]): Promise<AkadPertamaRow[]>;
  snapshotKolektibilitas(
    tx: QueryRunner,
    periodeId: string,
    cabangIds: readonly string[],
  ): Promise<SnapshotKolektibilitasRow[]>;
  adaAkadOutstanding(tx: QueryRunner, cabangIds: readonly string[]): Promise<boolean>;
  kelasKolektibilitas(tx: QueryRunner, _bumnId: string): Promise<KelasKolektibilitasRow[]>;
  mitra(tx: QueryRunner, mitraId: string): Promise<MitraRow | null>;
  kartuAkad(
    tx: QueryRunner,
    mitraId: string,
    sampai: string,
  ): Promise<KartuAkadRow[]>;
  /** `sampai` is deliberately unused; a card shows the whole schedule. */
  kartuJadwal(tx: QueryRunner, akadIds: readonly string[], sampai: string): Promise<KartuJadwalRow[]>;
  kartuSetoran(tx: QueryRunner, akadIds: readonly string[], sampai: string): Promise<KartuSetoranRow[]>;
  penyaluranNonPumk(tx: QueryRunner, q: RentangCabang): Promise<PenyaluranNonPumkRow[]>;
  sdgProposal(tx: QueryRunner, proposalIds: readonly string[]): Promise<ProposalSdgRow[]>;
  monitoringLpj(tx: QueryRunner, q: RentangCabang): Promise<MonitoringLpjRow[]>;
  rekapJurnal(tx: QueryRunner, q: RentangCabang): Promise<RekapJurnalRow[]>;
  portal(
    tx: QueryRunner,
    q: { bumnId: string; jenis: string; dari: string; sampai: string },
  ): Promise<PortalRow[]>;
  demografiMitra(
    tx: QueryRunner,
    cabangIds: readonly string[],
    sampai: string,
  ): Promise<DemografiMitraRow[]>;
  penyisihanPeriode(
    tx: QueryRunner,
    bumnId: string,
    cabangIds: readonly string[],
    dari: string,
    sampai: string,
  ): Promise<PenyisihanPeriodeRow[]>;
  penyisihanJurnal(
    tx: QueryRunner,
    penyisihanIds: readonly string[],
  ): Promise<PenyisihanJurnalRow[]>;
  akrualJasa(
    tx: QueryRunner,
    periodeId: string,
    cabangIds: readonly string[],
  ): Promise<AkrualJasaRow[]>;
  auditTrail(
    tx: QueryRunner,
    q: {
      bumnId: string;
      dari: string;
      sampai: string;
      userId: string | null;
      entitas: string | null;
      aksi: string | null;
      hasil: string | null;
      batas: number;
      offset: number;
    },
  ): Promise<{ baris: AuditTrailRow[]; jumlah: number }>;
  baselineRka(
    tx: QueryRunner,
    q: { bumnId: string; cabangIds: readonly string[]; tahun: number; jenis: string },
  ): Promise<BaselineRkaRow | null>;
  anggaranDimensi(
    tx: QueryRunner,
    q: {
      rkaId: string;
      kolom: "sektor_id" | "bidang_id";
      /** The calendar months of the window. */
      bulan: readonly number[];
      /** Whether budget lines with no month (annual figures) are included. */
      sertakanTanpaBulan: boolean;
    },
  ): Promise<AnggaranDimensiRow[]>;
  sektor(tx: QueryRunner, bumnId: string): Promise<DimensiMasterRow[]>;
  bidang(tx: QueryRunner, bumnId: string): Promise<DimensiMasterRow[]>;
  sdg(tx: QueryRunner): Promise<SdgMasterRow[]>;
  cabang(tx: QueryRunner, bumnId: string): Promise<CabangNamaRow[]>;
}

export function buatRepoOperasional(): LaporanOperasionalRepo {
  return {
    /**
     * THE DISBURSEMENT FIGURE, AND THE ONLY PLACE IT IS READ FROM.
     *
     * `v_ledger_baris` restricted to `jurnal.referensi_tipe = 'pumk_pencairan'`
     * and to lines carrying an `akad_id`, which on that event is the receivable
     * leg. Summed `debit - kredit`, so a reversing journal (which inherits
     * `referensi_tipe`, `mitra_id` and `akad_id`) nets its original to zero
     * instead of leaving it standing. `pumk_pencairan` itself is deliberately
     * NOT the source: the row survives a reversal.
     *
     * ONE ROW PER (sektor, provinsi, kota, mitra), NOT PER GROUP. Reports 1, 2
     * and 3 need DISTINCT partner counts at three different groupings, and
     * `count(distinct ...)` computed per group cannot be summed into the level
     * above without double counting a partner who appears in two of them. The
     * grain is therefore the partner, and the engine aggregates.
     *
     * The geography is the mitra's CURRENT address (ADR 0016 names this as a
     * decision to be taken; ./kontrak-operasional.ts reading B takes it and the
     * reports say so in `dasarWilayah`).
     */
    pencairanDimensi(tx, q) {
      const params: unknown[] = [q.bumnId, q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<PencairanDimensiRow>(
        `select s.id::text as sektor_id, s.kode as sektor_kode, s.nama as sektor_nama,
                pv.id::text as provinsi_id, pv.nama as provinsi_nama,
                kt.id::text as kota_id, kt.nama as kota_nama,
                m.id::text as mitra_id,
                coalesce(sum(l.debit - l.kredit), 0)::numeric(20,2)::text as nilai
           from v_ledger_baris l
           join jurnal j on j.id = l.jurnal_id
           join pumk_akad ak on ak.id = l.akad_id
           join pumk_proposal pr on pr.id = ak.proposal_id
           join mitra m on m.id = ak.mitra_id
           left join sektor_pumk s on s.id = pr.sektor_id and s.deleted_at is null
           left join kota kt on kt.id = m.kota_id and kt.deleted_at is null
           left join provinsi pv on pv.id = kt.provinsi_id and pv.deleted_at is null
          where l.bumn_id = $1::uuid
            and l.tanggal_transaksi >= $2::date and l.tanggal_transaksi <= $3::date
            and l.cabang_id in (${cabang})
            and j.referensi_tipe = 'pumk_pencairan'
          group by s.id, s.kode, s.nama, pv.id, pv.nama, kt.id, kt.nama, m.id`,
        params,
      );
    },

    /**
     * Report 4. `pumk_angsuran` rows, not ledger lines: the report's columns
     * ARE the allocation (`alokasi_pokok`, `alokasi_jasa`,
     * `alokasi_kelebihan`), which the ledger spreads across three accounts and
     * two events, and `pumk_angsuran_alokasi_ck` already guarantees they add
     * up to what was received.
     *
     * Windowed on `tanggal_terima`, which is the date the report prints and the
     * date a cashier reconciles against.
     */
    penerimaanAngsuran(tx, q) {
      const params: unknown[] = [q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<PenerimaanAngsuranRow>(
        `select a.id::text as angsuran_id,
                a.tanggal_terima::text as tanggal_terima,
                a.tanggal_valuta::text as tanggal_valuta,
                m.id::text as mitra_id, m.kode_mitra, m.nama_lengkap as nama_mitra,
                ak.id::text as akad_id, ak.no_akad,
                a.alokasi_pokok::text as pokok,
                a.alokasi_jasa::text as jasa,
                a.alokasi_kelebihan::text as kelebihan,
                a.jumlah_diterima::text as total,
                a.no_bukti, a.jurnal_id::text as jurnal_id,
                ak.cabang_id::text as cabang_id
           from pumk_angsuran a
           join pumk_akad ak on ak.id = a.akad_id and ak.deleted_at is null
           join mitra m on m.id = ak.mitra_id
          where a.deleted_at is null
            and a.tanggal_terima >= $1::date and a.tanggal_terima <= $2::date
            and ak.cabang_id in (${cabang})
          order by a.tanggal_terima, ak.no_akad, a.id`,
        params,
      );
    },

    /**
     * Report 5. THE ACTIVE SCHEDULE VERSION ONLY (invariant 8: a rescheduled
     * akad keeps its superseded version as history, and listing both would
     * double every instalment of every rescheduled loan). Settled rows are
     * excluded; the amounts are what is STILL owed on the instalment, so a
     * partially paid row shows the collectable remainder.
     */
    jatuhTempo(tx, q) {
      const params: unknown[] = [q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<JatuhTempoRow>(
        `select jd.id::text as jadwal_id,
                m.id::text as mitra_id, m.kode_mitra, m.nama_lengkap as nama_mitra,
                ak.id::text as akad_id, ak.no_akad,
                jd.angsuran_ke::int as angsuran_ke,
                jd.tanggal_jatuh_tempo::text as tanggal_jatuh_tempo,
                jd.status,
                (jd.pokok - jd.pokok_terbayar)::numeric(20,2)::text as pokok,
                (jd.jasa_adm - jd.jasa_terbayar)::numeric(20,2)::text as jasa,
                ak.cabang_id::text as cabang_id
           from pumk_jadwal_angsuran jd
           join pumk_akad ak on ak.id = jd.akad_id and ak.deleted_at is null
           join mitra m on m.id = ak.mitra_id
          where jd.deleted_at is null and jd.is_active_version
            and jd.status not in ('LUNAS', 'DIRESCHEDULE')
            and jd.tanggal_jatuh_tempo >= $1::date and jd.tanggal_jatuh_tempo <= $2::date
            and ak.cabang_id in (${cabang})
          order by jd.tanggal_jatuh_tempo, ak.no_akad, jd.angsuran_ke`,
        params,
      );
    },

    /**
     * Report 6. `jumlah_disetujui` comes from the LATEST SETUJU row of
     * `pumk_approval`, because `pumk_proposal` carries no approved amount and
     * spec 16 scenario 3 requires the approver to be able to change the
     * plafond. A lateral is used rather than a group-by so the tie-break
     * (`tanggal desc, created_at desc`) is stated once and cannot pick a
     * different row for the amount than for the date.
     */
    permohonan(tx, q) {
      const params: unknown[] = [q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<PermohonanRow>(
        `select p.id::text as proposal_id, p.status,
                s.id::text as sektor_id, s.kode as sektor_kode, s.nama as sektor_nama,
                p.jumlah_diajukan::text as jumlah_diajukan,
                ap.plafon_disetujui::text as jumlah_disetujui
           from pumk_proposal p
           left join sektor_pumk s on s.id = p.sektor_id and s.deleted_at is null
           left join lateral (
             select a.plafon_disetujui
               from pumk_approval a
              where a.proposal_id = p.id and a.deleted_at is null and a.keputusan = 'SETUJU'
              order by a.tanggal desc, a.created_at desc
              limit 1
           ) ap on true
          where p.deleted_at is null
            and p.tanggal_proposal >= $1::date and p.tanggal_proposal <= $2::date
            and p.cabang_id in (${cabang})
          order by p.tanggal_proposal, p.no_proposal`,
        params,
      );
    },

    /** Report 7. One row per akad signed in the window, with its month. */
    akadPerBulan(tx, q) {
      const params: unknown[] = [q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<AkadBulanRow>(
        `select extract(year from ak.tanggal_akad)::int as tahun,
                extract(month from ak.tanggal_akad)::int as bulan,
                ak.id::text as akad_id, ak.mitra_id::text as mitra_id,
                ak.pokok_pinjaman::text as pokok
           from pumk_akad ak
          where ak.deleted_at is null
            and ak.tanggal_akad >= $1::date and ak.tanggal_akad <= $2::date
            and ak.cabang_id in (${cabang})
          order by ak.tanggal_akad, ak.no_akad`,
        params,
      );
    },

    /**
     * Report 7's "Mitra Baru versus Lama". The first akad a partner ever took,
     * UNBOUNDED BY THE REPORT WINDOW and unbounded by branch: a partner funded
     * last year is not new this year, and a partner funded by another branch is
     * not new here either. Bounding it would make "baru" mean "new to this
     * page", which is a different and much less useful claim.
     */
    akadPertamaMitra(tx, mitraIds) {
      if (mitraIds.length === 0) return Promise.resolve([]);
      const params: unknown[] = [];
      const ids = daftar(params, mitraIds);
      return tx.query<AkadPertamaRow>(
        `select ak.mitra_id::text as mitra_id,
                min(ak.tanggal_akad)::text as tanggal_pertama
           from pumk_akad ak
          where ak.deleted_at is null and ak.mitra_id in (${ids})
          group by ak.mitra_id`,
        params,
      );
    },

    /**
     * Reports 8, 10, 11 and 28, all four from one read. See reading C in
     * ./kontrak-operasional.ts: this is the ONLY source of a classification, a
     * days-overdue count and a provision, because one run produced all three
     * together with the rate that computed them (ADR 0014).
     *
     * `rate_penyisihan` is NUMERIC(9,6) as a FRACTION in the snapshot; it is
     * cast to a two-decimal PERCENT here so the report prints "5,00" rather
     * than "0.050000", and the multiplication back to `nilai_penyisihan` is
     * never redone (the stored value is the one the journal used).
     */
    snapshotKolektibilitas(tx, periodeId, cabangIds) {
      const params: unknown[] = [periodeId];
      const cabang = daftar(params, cabangIds);
      return tx.query<SnapshotKolektibilitasRow>(
        `select ks.akad_id::text as akad_id, ak.no_akad,
                m.id::text as mitra_id, m.kode_mitra, m.nama_lengkap as nama_mitra,
                ks.cabang_id::text as cabang_id, cb.nama as nama_cabang,
                s.id::text as sektor_id, s.kode as sektor_kode, s.nama as sektor_nama,
                ks.hari_tunggakan::int as hari_tunggakan,
                ks.kolektibilitas, ks.kolektibilitas_periode_lalu,
                ks.outstanding_pokok::text as outstanding_pokok,
                ks.outstanding_jasa::text as outstanding_jasa,
                ks.tunggakan_pokok::text as tunggakan_pokok,
                ks.tunggakan_jasa::text as tunggakan_jasa,
                (ks.rate_penyisihan * 100)::numeric(12,2)::text as rate_penyisihan,
                ks.dasar_perhitungan, ks.sumber_rate,
                ks.rate_histori_dari::text as rate_histori_dari,
                ks.rate_histori_sampai::text as rate_histori_sampai,
                ks.nilai_penyisihan::text as nilai_penyisihan
           from kolektibilitas_snapshot ks
           join pumk_akad ak on ak.id = ks.akad_id
           join mitra m on m.id = ks.mitra_id
           join cabang cb on cb.id = ks.cabang_id
           left join sektor_pumk s on s.id = ks.sektor_id and s.deleted_at is null
          where ks.deleted_at is null and ks.periode_id = $1::uuid
            and ks.cabang_id in (${cabang})
          order by m.kode_mitra, ak.no_akad`,
        params,
      );
    },

    /**
     * Is there anything to classify at all? Asked before refusing a period with
     * no snapshot, for the same reason `sumberUntuk` asks whether the ledger is
     * empty before refusing an unfrozen close: an entity with no live loans
     * legitimately produces no snapshot rows, and refusing on that would make
     * the first months of any go-live unreportable.
     */
    async adaAkadOutstanding(tx, cabangIds) {
      const params: unknown[] = [];
      const cabang = daftar(params, cabangIds);
      const row = await satu<{ ada: boolean }>(
        tx,
        `select true as ada from pumk_akad
          where deleted_at is null and cabang_id in (${cabang})
            and (outstanding_pokok > 0 or outstanding_jasa > 0)
          limit 1`,
        params,
      );
      return row !== null;
    },

    /**
     * The class ladder. `kolektibilitas_kelas` is GLOBAL: migrations/0004 gives
     * it no `bumn_id`, because the four classes are a regulatory vocabulary
     * rather than a client parameter (what IS per-client is the day ladder in
     * `kolektibilitas_range` and the rates in `penyisihan_rate`). `bumnId` is
     * still taken so the signature does not have to change the day that stops
     * being true, and it is deliberately unused today rather than silently
     * absent from the interface.
     *
     * `urutan` is the printed order, so a client that gains a fifth class gets
     * it in the right place without a deploy.
     */
    kelasKolektibilitas(tx, _bumnId) {
      return tx.query<KelasKolektibilitasRow>(
        `select kode, nama, urutan::int as urutan
           from kolektibilitas_kelas
          where aktif
          order by urutan, kode`,
      );
    },

    mitra(tx, mitraId) {
      return satu<MitraRow>(
        tx,
        `select id::text as id, kode_mitra, nama_lengkap, cabang_id::text as cabang_id
           from mitra where id = $1::uuid and deleted_at is null`,
        [mitraId],
      );
    },

    /**
     * Report 9. Every akad of one partner signed on or before the cut-off, with
     * the principal ACTUALLY PAID OUT (`pumk_pencairan` up to the cut-off), not
     * the contracted principal: a card runs down from what was disbursed, and
     * an akad still BELUM_CAIR must show a zero balance rather than a debt.
     */
    kartuAkad(tx, mitraId, sampai) {
      return tx.query<KartuAkadRow>(
        `select ak.id::text as akad_id, ak.no_akad,
                ak.tanggal_akad::text as tanggal_akad, ak.status,
                ak.pokok_pinjaman::text as pokok_pinjaman,
                ak.outstanding_pokok::text as outstanding_pokok,
                ak.outstanding_jasa::text as outstanding_jasa,
                coalesce((
                  select sum(pc.jumlah) from pumk_pencairan pc
                   where pc.akad_id = ak.id and pc.deleted_at is null
                     and pc.tanggal_pencairan <= $2::date
                ), 0)::numeric(20,2)::text as dicairkan
           from pumk_akad ak
          where ak.deleted_at is null and ak.mitra_id = $1::uuid
            and ak.tanggal_akad <= $2::date
          order by ak.tanggal_akad, ak.no_akad`,
        [mitraId, sampai],
      );
    },

    /**
     * THE WHOLE PLAN, NOT THE PART OF IT THAT HAS FALLEN DUE. A card shows what
     * is owed and when, so an instalment dated after the cut-off is still part
     * of the schedule; cutting it off would make the card's own jadwal
     * disagree with the akad's principal.
     *
     * `sampai` is therefore ACCEPTED AND UNUSED, which the signature says out
     * loud. It used to be bound as `$1` and never referenced, and Postgres
     * refuses a statement whose parameter type it cannot infer
     * (42P18 "could not determine data type of parameter $1") -- so this was
     * not a harmless leftover, it was every call to report 9 failing.
     */
    kartuJadwal(tx, akadIds, _sampai) {
      if (akadIds.length === 0) return Promise.resolve([]);
      const params: unknown[] = [];
      const ids = daftar(params, akadIds);
      return tx.query<KartuJadwalRow>(
        `select jd.akad_id::text as akad_id, jd.id::text as jadwal_id,
                jd.angsuran_ke::int as angsuran_ke,
                jd.tanggal_jatuh_tempo::text as tanggal_jatuh_tempo,
                jd.pokok::text as pokok, jd.jasa_adm::text as jasa_adm,
                jd.total::text as total,
                jd.pokok_terbayar::text as pokok_terbayar,
                jd.jasa_terbayar::text as jasa_terbayar,
                jd.status, jd.tanggal_lunas::text as tanggal_lunas
           from pumk_jadwal_angsuran jd
          where jd.deleted_at is null and jd.is_active_version
            and jd.akad_id in (${ids})
          order by jd.akad_id, jd.angsuran_ke`,
        params,
      );
    },

    kartuSetoran(tx, akadIds, sampai) {
      if (akadIds.length === 0) return Promise.resolve([]);
      const params: unknown[] = [sampai];
      const ids = daftar(params, akadIds);
      return tx.query<KartuSetoranRow>(
        `select a.akad_id::text as akad_id, a.id::text as angsuran_id,
                a.tanggal_terima::text as tanggal_terima,
                a.jumlah_diterima::text as jumlah_diterima,
                a.alokasi_pokok::text as pokok, a.alokasi_jasa::text as jasa,
                a.alokasi_kelebihan::text as kelebihan,
                a.no_bukti, a.jurnal_id::text as jurnal_id
           from pumk_angsuran a
          where a.deleted_at is null and a.tanggal_terima <= $1::date
            and a.akad_id in (${ids})
          order by a.akad_id, a.tanggal_terima, a.id`,
        params,
      );
    },

    /**
     * Report 12. ONE ROW PER DISBURSEMENT TERMIN, because spec 9.2 makes
     * disbursement multi-termin and "Tanggal" has no single value for a
     * proposal paid in three instalments. The proposal-level columns repeat on
     * each termin, the way a printed statement repeats them.
     */
    penyaluranNonPumk(tx, q) {
      const params: unknown[] = [q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<PenyaluranNonPumkRow>(
        `select ps.id::text as penyaluran_id, p.id::text as proposal_id,
                p.no_proposal, p.nama_pemohon, p.judul_program,
                b.id::text as bidang_id, b.kode as bidang_kode, b.nama as bidang_nama,
                ps.termin::int as termin,
                ps.tanggal_penyaluran::text as tanggal_penyaluran,
                ps.jumlah::text as jumlah,
                coalesce(p.jumlah_disetujui, 0)::numeric(20,2)::text as jumlah_disetujui,
                lp.status as status_lpj,
                coalesce(lp.penerima_manfaat_aktual, p.penerima_manfaat_estimasi)::int
                  as penerima_manfaat,
                ps.no_bukti, ps.jurnal_id::text as jurnal_id,
                p.cabang_id::text as cabang_id
           from nonpumk_penyaluran ps
           join nonpumk_proposal p on p.id = ps.proposal_id and p.deleted_at is null
           join bidang_non_pumk b on b.id = p.bidang_id
           left join nonpumk_lpj lp on lp.proposal_id = p.id and lp.deleted_at is null
          where ps.deleted_at is null
            and ps.tanggal_penyaluran >= $1::date and ps.tanggal_penyaluran <= $2::date
            and p.cabang_id in (${cabang})
          order by ps.tanggal_penyaluran, p.no_proposal, ps.termin`,
        params,
      );
    },

    sdgProposal(tx, proposalIds) {
      if (proposalIds.length === 0) return Promise.resolve([]);
      const params: unknown[] = [];
      const ids = daftar(params, proposalIds);
      return tx.query<ProposalSdgRow>(
        `select ps.proposal_id::text as proposal_id, s.id::text as sdg_id,
                s.nomor::int as nomor, s.nama
           from nonpumk_proposal_sdg ps
           join sdg s on s.id = ps.sdg_id and s.deleted_at is null
          where ps.proposal_id in (${ids})
          order by s.nomor`,
        params,
      );
    },

    /**
     * Report 15. One row per PROPOSAL that has been disbursed at all, with the
     * LAST termin's date: the LPJ clock starts when the money finished
     * arriving, not when the first instalment did.
     *
     * The window is on the proposal's own disbursement dates, so a proposal
     * disbursed before the window and still without an LPJ inside it does not
     * appear -- which is deliberate: this is a report about a period's
     * obligations, and the standing backlog is what the KUMULATIF_YTD mode is
     * for.
     */
    monitoringLpj(tx, q) {
      const params: unknown[] = [q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<MonitoringLpjRow>(
        `select p.id::text as proposal_id, p.no_proposal, p.nama_pemohon,
                p.judul_program, b.nama as bidang_nama, p.cabang_id::text as cabang_id,
                max(ps.tanggal_penyaluran)::text as tanggal_salur_terakhir,
                coalesce(sum(ps.jumlah), 0)::numeric(20,2)::text as nilai_disalurkan,
                min(lp.status) as status_lpj,
                min(lp.tanggal_lpj)::text as tanggal_lpj,
                coalesce(min(lp.jumlah_realisasi), 0)::numeric(20,2)::text as jumlah_realisasi,
                coalesce(min(lp.jumlah_sisa_dikembalikan), 0)::numeric(20,2)::text as jumlah_sisa,
                p.penerima_manfaat_estimasi::int as penerima_manfaat_estimasi,
                min(lp.penerima_manfaat_aktual)::int as penerima_manfaat_aktual
           from nonpumk_proposal p
           join bidang_non_pumk b on b.id = p.bidang_id
           join nonpumk_penyaluran ps
             on ps.proposal_id = p.id and ps.deleted_at is null
            and ps.tanggal_penyaluran >= $1::date and ps.tanggal_penyaluran <= $2::date
           left join nonpumk_lpj lp on lp.proposal_id = p.id and lp.deleted_at is null
          where p.deleted_at is null and p.cabang_id in (${cabang})
          group by p.id, p.no_proposal, p.nama_pemohon, p.judul_program, b.nama,
                   p.cabang_id, p.penerima_manfaat_estimasi
          order by max(ps.tanggal_penyaluran), p.no_proposal`,
        params,
      );
    },

    /**
     * Report 21. Windowed on `tanggal_transaksi`, NOT on `periode_id`, so the
     * posted footing lines up with Neraca Lajur's Mutasi columns for the same
     * window; those two figures are asserted equal, and cutting them on
     * different columns would make the assertion a coincidence.
     *
     * EVERY STATUS, DRAFT INCLUDED. The main operational use of this page is
     * "is there a DRAFT left in this month", which closing check 1 refuses on.
     */
    rekapJurnal(tx, q) {
      const params: unknown[] = [q.bumnId, q.dari, q.sampai];
      const cabang = daftar(params, q.cabangIds);
      return tx.query<RekapJurnalRow>(
        `select j.jenis, j.status, count(*)::text as jumlah,
                coalesce(sum(j.total_debit), 0)::numeric(20,2)::text as total_debit,
                coalesce(sum(j.total_kredit), 0)::numeric(20,2)::text as total_kredit
           from jurnal j
          where j.deleted_at is null and j.bumn_id = $1::uuid
            and j.tanggal_transaksi >= $2::date and j.tanggal_transaksi <= $3::date
            and j.cabang_id in (${cabang})
          group by j.jenis, j.status
          order by j.jenis, j.status`,
        params,
      );
    },

    /**
     * Reports 25 and 26. `portal_submission` is keyed by `bumn_id` and has NO
     * branch, so the branch decision is the engine's (an unconverted submission
     * belongs to no branch and is visible only to Semua Cabang); this query
     * returns the converted proposal's branch and lets the engine filter.
     *
     * `data_json` IS READ BUT NOT TRUSTED. migrations/0013 says so on the
     * column: it is the form exactly as submitted. The two `->>`s below extract
     * text, the engine validates the amount against `POLA_UANG` and treats
     * anything else as absent, and the converted proposal always wins.
     */
    portal(tx, q) {
      return tx.query<PortalRow>(
        `select ps.id::text as submission_id, ps.no_tiket,
                to_char(ps.tanggal_submit, 'YYYY-MM-DD') as tanggal_submit,
                ps.status, ps.converted_proposal_id::text as converted_proposal_id,
                coalesce(ps.data_json ->> 'namaPemohon', ps.data_json ->> 'nama_pemohon',
                         ps.data_json ->> 'nama') as nama_dari_json,
                coalesce(ps.data_json ->> 'jumlahDiajukan',
                         ps.data_json ->> 'jumlah_diajukan') as nilai_dari_json,
                coalesce(pp.nama_lengkap, np.nama_pemohon) as nama_proposal,
                coalesce(pu.no_proposal, np.no_proposal) as no_proposal,
                coalesce(pu.jumlah_diajukan, np.jumlah_diajukan)::text as nilai_proposal,
                coalesce(pu.cabang_id, np.cabang_id)::text as cabang_id
           from portal_submission ps
           left join pumk_proposal pu
             on pu.portal_submission_id = ps.id and pu.deleted_at is null
           left join mitra pp on pp.id = pu.mitra_id
           left join nonpumk_proposal np
             on np.portal_submission_id = ps.id and np.deleted_at is null
          where ps.deleted_at is null and ps.bumn_id = $1::uuid and ps.jenis = $2
            and ps.tanggal_submit >= $3::date
            and ps.tanggal_submit < ($4::date + interval '1 day')
          order by ps.tanggal_submit, ps.no_tiket`,
        [q.bumnId, q.jenis, q.dari, q.sampai],
      );
    },

    /**
     * Report 27. THE POPULATION IS PARTNERS WITH AT LEAST ONE AKAD on or before
     * the cut-off, scoped by THAT AKAD's branch, not by `mitra.cabang_id`: an
     * akad's branch is the branch that funded it and is the one every other
     * PUMK report uses, while `mitra.cabang_id` is where the partner was
     * registered. `distinct` on the mitra, so a partner with three akads is one
     * person.
     */
    demografiMitra(tx, cabangIds, sampai) {
      const params: unknown[] = [sampai];
      const cabang = daftar(params, cabangIds);
      return tx.query<DemografiMitraRow>(
        `select distinct m.id::text as mitra_id, m.jenis_kelamin,
                m.tanggal_lahir::text as tanggal_lahir,
                s.id::text as sektor_id, s.kode as sektor_kode, s.nama as sektor_nama,
                pv.id::text as provinsi_id, pv.nama as provinsi_nama,
                m.tahun_mulai_usaha::int as tahun_mulai_usaha,
                m.jumlah_tenaga_kerja::int as jumlah_tenaga_kerja,
                m.omzet_bulanan::text as omzet_bulanan
           from mitra m
           join pumk_akad ak
             on ak.mitra_id = m.id and ak.deleted_at is null
            and ak.tanggal_akad <= $1::date and ak.cabang_id in (${cabang})
           left join sektor_pumk s on s.id = m.sektor_id and s.deleted_at is null
           left join kota kt on kt.id = m.kota_id and kt.deleted_at is null
           left join provinsi pv on pv.id = kt.provinsi_id and pv.deleted_at is null
          where m.deleted_at is null`,
        params,
      );
    },

    /** Report 29. The provision runs whose period falls in the window. */
    penyisihanPeriode(tx, bumnId, cabangIds, dari, sampai) {
      const params: unknown[] = [bumnId, dari, sampai];
      const cabang = daftar(params, cabangIds);
      return tx.query<PenyisihanPeriodeRow>(
        `select pp.id::text as penyisihan_id, p.id::text as periode_id,
                p.tahun::int as tahun, p.bulan::int as bulan, p.status as status_periode,
                pp.cabang_id::text as cabang_id, cb.nama as nama_cabang,
                pp.tanggal::text as tanggal,
                pp.saldo_penyisihan_awal::text as saldo_awal,
                pp.penyisihan_dibutuhkan::text as dibutuhkan,
                pp.beban_penyisihan_periode::text as beban
           from penyisihan_periode pp
           join periode p on p.id = pp.periode_id and p.deleted_at is null
           join cabang cb on cb.id = pp.cabang_id
          where pp.deleted_at is null and p.bumn_id = $1::uuid
            and p.tanggal_akhir >= $2::date and p.tanggal_akhir <= $3::date
            and pp.cabang_id in (${cabang})
          order by p.tahun, p.bulan, cb.kode`,
        params,
      );
    },

    /**
     * The provision's journals. A SET, not a column: ADR 0015 dropped the
     * singular `jurnal_id` because a corrected re-run posts a SECOND journal
     * for the delta, and a report that followed one link would reconstruct the
     * delta against the stated total and fail spec 16 scenario 17's check.
     */
    penyisihanJurnal(tx, penyisihanIds) {
      if (penyisihanIds.length === 0) return Promise.resolve([]);
      const params: unknown[] = [];
      const ids = daftar(params, penyisihanIds);
      return tx.query<PenyisihanJurnalRow>(
        `select pj.penyisihan_periode_id::text as penyisihan_periode_id,
                j.id::text as jurnal_id, j.no_jurnal,
                j.tanggal_transaksi::text as tanggal,
                pj.nilai::text as nilai
           from penyisihan_periode_jurnal pj
           join jurnal j on j.id = pj.jurnal_id
          where pj.deleted_at is null and pj.penyisihan_periode_id in (${ids})
          order by j.tanggal_transaksi, j.no_jurnal`,
        params,
      );
    },

    /**
     * Report 30. `metode` and `kelas_diakrual` are per-row copies of the two
     * configuration values that decided the population (migrations/0025, ADR
     * 0015): `konfigurasi` is mutated in place, so without them a closed period
     * could not say why its population was its population.
     */
    akrualJasa(tx, periodeId, cabangIds) {
      const params: unknown[] = [periodeId];
      const cabang = daftar(params, cabangIds);
      return tx.query<AkrualJasaRow>(
        `select aj.akad_id::text as akad_id, ak.no_akad,
                m.id::text as mitra_id, m.kode_mitra, m.nama_lengkap as nama_mitra,
                aj.cabang_id::text as cabang_id, aj.kolektibilitas,
                aj.jasa_jatuh_tempo_periode::text as jatuh_tempo,
                aj.jasa_diterima_periode::text as diterima,
                aj.jasa_diakrual::text as diakrual,
                aj.metode, aj.kelas_diakrual,
                aj.jurnal_id::text as jurnal_id
           from akrual_jasa_snapshot aj
           join pumk_akad ak on ak.id = aj.akad_id
           join mitra m on m.id = ak.mitra_id
          where aj.deleted_at is null and aj.periode_id = $1::uuid
            and aj.cabang_id in (${cabang})
          order by m.kode_mitra, ak.no_akad`,
        params,
      );
    },

    /**
     * Report 31. Two statements against one predicate: the page and the count
     * behind it, so a screen can say "1-100 of 4.312" without guessing.
     *
     * THE ENTITY FILTER IS THE ACTOR'S BRANCH's ENTITY. `audit_log` carries
     * neither `bumn_id` nor `cabang_id`, so `app_user -> cabang.bumn_id` is the
     * only tie there is, and a row with a NULL `user_id` (an unauthenticated
     * refusal) belongs to no entity and is EXCLUDED rather than shown to
     * everybody. Excluding is the conservative direction and it is stated in
     * ./kontrak-operasional.ts so nobody mistakes it for an oversight.
     */
    async auditTrail(tx, q) {
      const kondisi: string[] = [
        `a.waktu >= $2::date`,
        `a.waktu < ($3::date + interval '1 day')`,
      ];
      const params: unknown[] = [q.bumnId, q.dari, q.sampai];
      if (q.userId !== null) {
        params.push(q.userId);
        kondisi.push(`a.user_id = $${params.length}::uuid`);
      }
      if (q.entitas !== null) {
        params.push(q.entitas);
        kondisi.push(`a.entitas = $${params.length}`);
      }
      if (q.aksi !== null) {
        params.push(q.aksi);
        kondisi.push(`a.aksi = $${params.length}`);
      }
      if (q.hasil !== null) {
        params.push(q.hasil);
        kondisi.push(`a.hasil = $${params.length}`);
      }
      const where = `from audit_log a
           join app_user u on u.id = a.user_id
           join cabang cb on cb.id = u.cabang_id and cb.bumn_id = $1::uuid
          where ${kondisi.join(" and ")}`;
      const jumlahRow = await satu<{ n: string }>(
        tx,
        `select count(*)::text as n ${where}`,
        params,
      );
      const paramsHalaman = [...params, q.batas, q.offset];
      const baris = await tx.query<AuditTrailRow>(
        `select a.id::text as id,
                to_char(a.waktu at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as waktu,
                a.user_id::text as user_id, u.nama as nama_user,
                host(a.ip) as ip, a.aksi, a.entitas, a.entitas_id, a.hasil, a.keterangan
           ${where}
          order by a.waktu desc, a.id desc
          limit $${paramsHalaman.length - 1} offset $${paramsHalaman.length}`,
        paramsHalaman,
      );
      return { baris, jumlah: Number.parseInt(jumlahRow?.n ?? "0", 10) };
    },

    /**
     * Reports 2 and 13's budget column. THE DISETUJUI BASELINE, which is what
     * spec 9.3 makes the default ("RKA DISETUJUI jadi baseline pembanding"),
     * and NEVER a fall back to the newest draft: a draft is somebody's
     * proposal, and reporting against it would present an unapproved target as
     * performance. The highest approved version wins, which is the same rule
     * modules/rka applies.
     *
     * `cabang_id IS NULL` on an `rka` row is an entity-wide budget. It is
     * included when the caller asked for Semua Cabang and excluded when they
     * asked for one branch, because an entity-wide target is not that branch's
     * target and comparing one branch's spend against it would read as massive
     * underspend.
     */
    baselineRka(tx, q) {
      const params: unknown[] = [q.bumnId, q.tahun, q.jenis];
      const cabang = daftar(params, q.cabangIds);
      const scopeCabang =
        q.cabangIds.length === 1
          ? `r.cabang_id in (${cabang})`
          : `(r.cabang_id is null or r.cabang_id in (${cabang}))`;
      return satu<BaselineRkaRow>(
        tx,
        `select r.id::text as id, r.versi::int as versi
           from rka r
          where r.deleted_at is null and r.bumn_id = $1::uuid
            and r.tahun = $2 and r.jenis = $3 and r.status = 'DISETUJUI'
            and ${scopeCabang}
          order by r.versi desc
          limit 1`,
        params,
      );
    },

    /**
     * The budget per dimension, for the months of the window.
     *
     * `rka_detail.bulan` IS NULLABLE and a null means "the whole year, not
     * allocated by month". Such a line is included in a YEAR-TO-DATE window and
     * EXCLUDED from a single-month one, which is exactly the rule modules/rka
     * applies for report 24 and is stated there in the same words: spreading it
     * evenly would be this module inventing a phasing the client did not enter,
     * and including it whole would make every month look twelvefold over
     * budget.
     *
     * A MONTH LIST, NOT A RANGE. A financial year starting in April makes the
     * year-to-date window of February months 4..12 and 1..2, which is two
     * ranges and one list. `q.kolom` is a literal chosen by the caller from a
     * two-member union, never a string from a request.
     */
    anggaranDimensi(tx, q) {
      const params: unknown[] = [q.rkaId];
      const daftarBulan = q.bulan
        .map((b) => {
          params.push(b);
          return `$${params.length}`;
        })
        .join(", ");
      const cocokBulan = q.bulan.length > 0 ? `d.bulan in (${daftarBulan})` : "false";
      const predikat = q.sertakanTanpaBulan
        ? `(d.bulan is null or ${cocokBulan})`
        : `(d.bulan is not null and ${cocokBulan})`;
      return tx.query<AnggaranDimensiRow>(
        `select d.${q.kolom}::text as dimensi_id,
                coalesce(sum(d.jumlah_anggaran), 0)::numeric(20,2)::text as jumlah
           from rka_detail d
          where d.deleted_at is null and d.rka_id = $1::uuid and ${predikat}
          group by d.${q.kolom}`,
        params,
      );
    },

    sektor(tx, bumnId) {
      return tx.query<DimensiMasterRow>(
        `select id::text as id, kode, nama from sektor_pumk
          where bumn_id = $1::uuid and deleted_at is null
          order by urutan, kode`,
        [bumnId],
      );
    },

    bidang(tx, bumnId) {
      return tx.query<DimensiMasterRow>(
        `select id::text as id, kode, nama from bidang_non_pumk
          where bumn_id = $1::uuid and deleted_at is null
          order by urutan, kode`,
        [bumnId],
      );
    },

    sdg(tx) {
      return tx.query<SdgMasterRow>(
        `select id::text as id, nomor::int as nomor, nama from sdg
          where deleted_at is null order by nomor`,
      );
    },

    cabang(tx, bumnId) {
      return tx.query<CabangNamaRow>(
        `select id::text as id, kode, nama from cabang
          where bumn_id = $1::uuid and deleted_at is null order by kode`,
        [bumnId],
      );
    },
  };
}
