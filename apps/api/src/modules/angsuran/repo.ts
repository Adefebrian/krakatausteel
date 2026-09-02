// Every statement the instalment engine issues, in one file. No business rules
// live here; the engine decides, the repo reads and writes.
//
// THE DRIVER FACTS THIS FILE IS BUILT AROUND, verified against the Bun
// Postgres client the same way modules/jurnal/repo.ts documents them:
//
//  1. DATE and TIMESTAMPTZ come back as a JS `Date`, while NUMERIC comes back
//     as a string. So every date column is selected `::text`, which keeps
//     `tanggal_jatuh_tempo` a plain 'YYYY-MM-DD' end to end and keeps money as
//     the decimal strings `Uang` promises. A `Date` here would silently become
//     '2026-03-09T17:00:00.000Z' in a schedule table.
//  2. A JS array is serialised as a bare comma-joined string, which `uuid[]`
//     and `text[]` reject, so nothing below binds an array. Multi-row inserts
//     are issued one statement at a time inside the caller's transaction.
//  3. A `jsonb` parameter bound from a JS string is stored as a JSON string
//     scalar, so it would need `$n::text::jsonb`. This module writes no jsonb
//     column today; the note is kept because the next column added here will
//     hit it.
//
// SCHEDULE ROWS ARE NEVER UPDATED IN THEIR PRICED COLUMNS. Invariant 8 and
// trg_pumk_jadwal_10_immutable both say so, so the only UPDATE below touches
// the payment-progress columns.
import type { AngsuranTx } from "./contract";

export interface AkadBaris {
  id: string;
  cabang_id: string;
  mitra_id: string;
  no_akad: string;
  status: string;
  pokok_pinjaman: string;
  pokok_pinjaman_efektif: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
  jasa_adm_rate: string;
  metode_perhitungan: string;
  tenor_bulan: number;
  grace_period_bulan: number;
  tanggal_mulai_angsuran: string;
  tanggal_lunas: string | null;
  bumn_id: string;
}

export interface VersiBaris {
  akad_id: string;
  versi: number;
  is_active_version: boolean;
  status: string;
  reschedule_id: string | null;
}

export interface JadwalBaris {
  id: string;
  akad_id: string;
  versi: number;
  angsuran_ke: number;
  tanggal_jatuh_tempo: string;
  pokok: string;
  jasa_adm: string;
  total: string;
  saldo_pokok_setelah: string;
  status: string;
  pokok_terbayar: string;
  jasa_terbayar: string;
  tanggal_lunas: string | null;
  is_active_version: boolean;
  /**
   * Jasa on this row already accrued into Piutang Jasa Administrasi by the
   * closing engine (spec 8.3) and not yet collected. migrations/0030: this is
   * what lets a receipt decide, per rupiah, whether its jasa leg CLEARS the
   * receivable or RECOGNISES income.
   */
  jasa_akrual_belum_tertagih: string;
}

/** One receipt's consumption of accrued jasa, per schedule row (0030). */
export interface KonsumsiAkrualBaris {
  id: string;
  angsuran_id: string;
  jadwal_id: string;
  nilai: string;
  dipulihkan_at: string | null;
}

export interface RescheduleBaris {
  id: string;
  akad_id: string;
  tanggal_pengajuan: string;
  alasan: string;
  jenis: string;
  tenor_baru: number | null;
  grace_baru: number | null;
  jasa_rate_baru: string | null;
  jadwal_versi_lama: number;
  jadwal_versi_baru: number | null;
  status: string;
  created_by: string | null;
  approved_by: string | null;
  outstanding_pokok_sebelum: string | null;
  outstanding_jasa_sebelum: string | null;
  pokok_baru: string | null;
}

export interface AkunBaris {
  id: string;
  aktif: boolean;
  is_postable: boolean;
  is_kas: boolean;
  bumn_id: string;
}

const KOLOM_AKAD = `
  a.id, a.cabang_id, a.mitra_id, a.no_akad, a.status,
  a.pokok_pinjaman::text as pokok_pinjaman,
  a.pokok_pinjaman_efektif::text as pokok_pinjaman_efektif,
  a.outstanding_pokok::text as outstanding_pokok,
  a.outstanding_jasa::text as outstanding_jasa,
  a.jasa_adm_rate::text as jasa_adm_rate,
  a.metode_perhitungan, a.tenor_bulan, a.grace_period_bulan,
  a.tanggal_mulai_angsuran::text as tanggal_mulai_angsuran,
  a.tanggal_lunas::text as tanggal_lunas,
  c.bumn_id`;

const KOLOM_JADWAL = `
  id, akad_id, versi, angsuran_ke,
  tanggal_jatuh_tempo::text as tanggal_jatuh_tempo,
  pokok::text as pokok, jasa_adm::text as jasa_adm, total::text as total,
  saldo_pokok_setelah::text as saldo_pokok_setelah, status,
  pokok_terbayar::text as pokok_terbayar, jasa_terbayar::text as jasa_terbayar,
  tanggal_lunas::text as tanggal_lunas, is_active_version,
  jasa_akrual_belum_tertagih::text as jasa_akrual_belum_tertagih`;

const KOLOM_RESCHEDULE = `
  id, akad_id, tanggal_pengajuan::text as tanggal_pengajuan, alasan, jenis,
  tenor_baru, grace_baru, jasa_rate_baru::text as jasa_rate_baru,
  jadwal_versi_lama, jadwal_versi_baru, status, created_by, approved_by,
  outstanding_pokok_sebelum::text as outstanding_pokok_sebelum,
  outstanding_jasa_sebelum::text as outstanding_jasa_sebelum,
  pokok_baru::text as pokok_baru`;

export interface AngsuranRepo {
  akad(tx: AngsuranTx, akadId: string): Promise<AkadBaris | null>;
  /** Same row, locked for the life of the transaction (spec 7.2 step 1 to 8). */
  akadUntukDiubah(tx: AngsuranTx, akadId: string): Promise<AkadBaris | null>;
  konfigurasi(tx: AngsuranTx, bumnId: string, grup: string, kunci: string): Promise<string | null>;
  presetAlokasi(tx: AngsuranTx, kode: string): Promise<string[]>;
  akun(tx: AngsuranTx, akunId: string): Promise<AkunBaris | null>;

  versiAktif(tx: AngsuranTx, akadId: string): Promise<VersiBaris | null>;
  semuaVersi(tx: AngsuranTx, akadId: string): Promise<VersiBaris[]>;
  versiTerbesar(tx: AngsuranTx, akadId: string): Promise<number | null>;
  buatVersi(
    tx: AngsuranTx,
    input: {
      akadId: string;
      versi: number;
      tanggalBerlaku: string | null;
      rescheduleId: string | null;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<void>;
  nonaktifkanVersi(
    tx: AngsuranTx,
    input: { akadId: string; versi: number; rescheduleId: string; userId: string },
  ): Promise<void>;
  buatBarisJadwal(
    tx: AngsuranTx,
    input: {
      akadId: string;
      versi: number;
      angsuranKe: number;
      tanggalJatuhTempo: string;
      pokok: string;
      jasaAdm: string;
      total: string;
      saldoPokokSetelah: string;
      userId: string;
    },
  ): Promise<void>;
  barisJadwal(tx: AngsuranTx, akadId: string, versi?: number): Promise<JadwalBaris[]>;
  /** Unpaid rows of the active version, oldest due date first (spec 7.2 step 1). */
  barisBelumLunas(tx: AngsuranTx, akadId: string): Promise<JadwalBaris[]>;
  totalPokokVersi(tx: AngsuranTx, akadId: string, versi: number): Promise<string>;
  perbaruiPembayaranBaris(
    tx: AngsuranTx,
    input: {
      jadwalId: string;
      pokokTerbayar: string;
      jasaTerbayar: string;
      status: string;
      tanggalLunas: string | null;
      /**
       * What is LEFT accrued on this row after the receipt consumed part of
       * it. Written in the SAME statement as `jasaTerbayar` on purpose:
       * `pumk_jadwal_akrual_ck` compares the two, so splitting them into two
       * UPDATEs would make a legal end state fail on the intermediate row.
       */
      jasaAkrualBelumTertagih: string;
      userId: string;
    },
  ): Promise<void>;
  /**
   * Sets the accrued balance alone, for the two paths that move it without a
   * payment: a reschedule carrying it onto the new version, and a reversal
   * putting it back (migrations/0030).
   */
  setAkrualBaris(
    tx: AngsuranTx,
    input: { jadwalId: string; nilai: string; userId: string },
  ): Promise<void>;
  /** Active-version rows, oldest first, for placing a carried accrual. */
  barisAktif(tx: AngsuranTx, akadId: string): Promise<JadwalBaris[]>;
  catatKonsumsiAkrual(
    tx: AngsuranTx,
    input: {
      angsuranId: string;
      userId: string;
      baris: ReadonlyArray<{ jadwalId: string; nilai: string }>;
    },
  ): Promise<void>;
  /** The receipt header, for the scope check on a reversal. */
  angsuran(tx: AngsuranTx, angsuranId: string): Promise<{ id: string; akad_id: string } | null>;
  konsumsiAkrual(tx: AngsuranTx, angsuranId: string): Promise<KonsumsiAkrualBaris[]>;
  tandaiKonsumsiDipulihkan(tx: AngsuranTx, ids: readonly string[], userId: string): Promise<void>;

  buatAngsuran(
    tx: AngsuranTx,
    input: {
      akadId: string;
      tanggal: string;
      tanggalValuta: string | null;
      jumlah: string;
      alokasiPokok: string;
      alokasiJasa: string;
      alokasiKelebihan: string;
      akunKasId: string;
      noBukti: string | null;
      metodeAlokasi: string;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  setJurnalAngsuran(tx: AngsuranTx, angsuranId: string, jurnalId: string): Promise<void>;
  buatKelebihan(
    tx: AngsuranTx,
    input: {
      akadId: string;
      angsuranId: string;
      tanggal: string;
      jumlah: string;
      userId: string;
    },
  ): Promise<string>;
  setJurnalKelebihan(tx: AngsuranTx, kelebihanId: string, jurnalId: string): Promise<void>;

  perbaruiOutstanding(
    tx: AngsuranTx,
    input: {
      akadId: string;
      outstandingPokok: string;
      outstandingJasa: string;
      status: string;
      tanggalLunas: string | null;
      userId: string;
    },
  ): Promise<void>;

  buatReschedule(
    tx: AngsuranTx,
    input: {
      akadId: string;
      tanggalPengajuan: string;
      alasan: string;
      jenis: string;
      tenorBaru: number | null;
      graceBaru: number | null;
      jasaRateBaru: string | null;
      pokokBaru: string | null;
      jadwalVersiLama: number;
      catatan: string | null;
      userId: string;
    },
  ): Promise<string>;
  reschedule(tx: AngsuranTx, id: string): Promise<RescheduleBaris | null>;
  setujuiReschedule(
    tx: AngsuranTx,
    input: {
      id: string;
      versiBaru: number;
      outstandingPokokSebelum: string;
      outstandingJasaSebelum: string;
      userId: string;
      waktu: string;
    },
  ): Promise<number>;
}

export function createAngsuranRepo(): AngsuranRepo {
  return {
    async akad(tx, akadId) {
      const r = await tx.query<AkadBaris>(
        `select ${KOLOM_AKAD}
           from pumk_akad a join cabang c on c.id = a.cabang_id
          where a.id = $1::uuid and a.deleted_at is null`,
        [akadId],
      );
      return r[0] ?? null;
    },

    async akadUntukDiubah(tx, akadId) {
      // FOR UPDATE on the akad is the serialisation point of an allocation:
      // two deposits on one akad must not both read the same outstanding and
      // both subtract from it. `of a` keeps the lock off `cabang`.
      const r = await tx.query<AkadBaris>(
        `select ${KOLOM_AKAD}
           from pumk_akad a join cabang c on c.id = a.cabang_id
          where a.id = $1::uuid and a.deleted_at is null
          for update of a`,
        [akadId],
      );
      return r[0] ?? null;
    },

    async konfigurasi(tx, bumnId, grup, kunci) {
      // A bumn-scoped row overrides the shipped default (bumn_id IS NULL),
      // exactly how modules/konfigurasi resolves a parameter. Read fresh on
      // every call so an accountant's edit takes effect without a deploy.
      const r = await tx.query<{ nilai: string | null }>(
        `select nilai
           from konfigurasi
          where grup = $1 and kunci = $2
            and (bumn_id = $3::uuid or bumn_id is null)
            and deleted_at is null
          order by (bumn_id is null)
          limit 1`,
        [grup, kunci, bumnId],
      );
      return r[0]?.nilai ?? null;
    },

    async presetAlokasi(tx, kode) {
      const r = await tx.query<{ komponen: string }>(
        `select komponen from alokasi_setoran_preset
          where kode = $1 and aktif order by urutan`,
        [kode],
      );
      return r.map((x) => x.komponen);
    },

    async akun(tx, akunId) {
      const r = await tx.query<AkunBaris>(
        `select id, aktif, is_postable, is_kas, bumn_id
           from akun where id = $1::uuid and deleted_at is null`,
        [akunId],
      );
      return r[0] ?? null;
    },

    async versiAktif(tx, akadId) {
      const r = await tx.query<VersiBaris>(
        `select akad_id, versi, is_active_version, status, reschedule_id
           from pumk_jadwal_versi
          where akad_id = $1::uuid and is_active_version and deleted_at is null`,
        [akadId],
      );
      return r[0] ?? null;
    },

    async semuaVersi(tx, akadId) {
      return tx.query<VersiBaris>(
        `select akad_id, versi, is_active_version, status, reschedule_id
           from pumk_jadwal_versi
          where akad_id = $1::uuid and deleted_at is null
          order by versi desc`,
        [akadId],
      );
    },

    async versiTerbesar(tx, akadId) {
      const r = await tx.query<{ versi: number | null }>(
        `select max(versi) as versi from pumk_jadwal_versi
          where akad_id = $1::uuid and deleted_at is null`,
        [akadId],
      );
      return r[0]?.versi ?? null;
    },

    async buatVersi(tx, input) {
      await tx.query(
        `insert into pumk_jadwal_versi
           (akad_id, versi, is_active_version, status, tanggal_berlaku, reschedule_id,
            keterangan, created_by, updated_by)
         values ($1::uuid, $2, true, 'ACTIVE', $3::date, $4::uuid, $5, $6::uuid, $6::uuid)`,
        [
          input.akadId,
          input.versi,
          input.tanggalBerlaku,
          input.rescheduleId,
          input.keterangan,
          input.userId,
        ],
      );
    },

    async nonaktifkanVersi(tx, input) {
      // The row-level `is_active_version` and the DIRESCHEDULE status of every
      // unpaid row are set by trg_pumk_jadwal_versi_50_propagasi, which also
      // leaves LUNAS rows alone (spec 7.3 item 5). Doing it here as well would
      // duplicate the rule in two places and risk them disagreeing.
      await tx.query(
        `update pumk_jadwal_versi
            set is_active_version = false, status = 'SUPERSEDED',
                reschedule_id = $3::uuid, updated_by = $4::uuid, updated_at = now()
          where akad_id = $1::uuid and versi = $2`,
        [input.akadId, input.versi, input.rescheduleId, input.userId],
      );
    },

    async buatBarisJadwal(tx, input) {
      await tx.query(
        `insert into pumk_jadwal_angsuran
           (akad_id, versi, angsuran_ke, tanggal_jatuh_tempo, pokok, jasa_adm, total,
            saldo_pokok_setelah, status, created_by, updated_by)
         values ($1::uuid, $2, $3, $4::date, $5::numeric, $6::numeric, $7::numeric,
                 $8::numeric, 'BELUM_JATUH_TEMPO', $9::uuid, $9::uuid)`,
        [
          input.akadId,
          input.versi,
          input.angsuranKe,
          input.tanggalJatuhTempo,
          input.pokok,
          input.jasaAdm,
          input.total,
          input.saldoPokokSetelah,
          input.userId,
        ],
      );
    },

    async barisJadwal(tx, akadId, versi) {
      return tx.query<JadwalBaris>(
        `select ${KOLOM_JADWAL}
           from pumk_jadwal_angsuran
          where akad_id = $1::uuid and ($2::int is null or versi = $2) and deleted_at is null
          order by versi, angsuran_ke`,
        [akadId, versi ?? null],
      );
    },

    async barisBelumLunas(tx, akadId) {
      return tx.query<JadwalBaris>(
        `select ${KOLOM_JADWAL}
           from pumk_jadwal_angsuran
          where akad_id = $1::uuid and is_active_version and deleted_at is null
            and status <> 'LUNAS' and status <> 'DIRESCHEDULE'
          order by tanggal_jatuh_tempo, angsuran_ke
          for update`,
        [akadId],
      );
    },

    async totalPokokVersi(tx, akadId, versi) {
      const r = await tx.query<{ total: string }>(
        `select coalesce(sum(pokok), 0)::text as total
           from pumk_jadwal_angsuran
          where akad_id = $1::uuid and versi = $2 and deleted_at is null`,
        [akadId, versi],
      );
      return r[0]?.total ?? "0";
    },

    async perbaruiPembayaranBaris(tx, input) {
      await tx.query(
        `update pumk_jadwal_angsuran
            set pokok_terbayar = $2::numeric, jasa_terbayar = $3::numeric,
                status = $4, tanggal_lunas = $5::date,
                jasa_akrual_belum_tertagih = $6::numeric,
                updated_by = $7::uuid, updated_at = now()
          where id = $1::uuid`,
        [
          input.jadwalId,
          input.pokokTerbayar,
          input.jasaTerbayar,
          input.status,
          input.tanggalLunas,
          input.jasaAkrualBelumTertagih,
          input.userId,
        ],
      );
    },

    async setAkrualBaris(tx, input) {
      await tx.query(
        `update pumk_jadwal_angsuran
            set jasa_akrual_belum_tertagih = $2::numeric,
                updated_by = $3::uuid, updated_at = now()
          where id = $1::uuid`,
        [input.jadwalId, input.nilai, input.userId],
      );
    },

    async barisAktif(tx, akadId) {
      return tx.query<JadwalBaris>(
        `select ${KOLOM_JADWAL}
           from pumk_jadwal_angsuran
          where akad_id = $1::uuid and is_active_version and deleted_at is null
          order by tanggal_jatuh_tempo, angsuran_ke
          for update`,
        [akadId],
      );
    },

    async catatKonsumsiAkrual(tx, input) {
      // Driver fact 2: no arrays are bound, so the rows go in one statement at
      // a time inside the caller's transaction, exactly as buatBarisJadwal does.
      for (const b of input.baris) {
        await tx.query(
          `insert into pumk_angsuran_akrual
             (angsuran_id, jadwal_id, nilai, created_by, updated_by)
           values ($1::uuid, $2::uuid, $3::numeric, $4::uuid, $4::uuid)`,
          [input.angsuranId, b.jadwalId, b.nilai, input.userId],
        );
      }
    },

    async angsuran(tx, angsuranId) {
      const r = await tx.query<{ id: string; akad_id: string }>(
        `select id::text as id, akad_id::text as akad_id
           from pumk_angsuran
          where id = $1::uuid and deleted_at is null`,
        [angsuranId],
      );
      return r[0] ?? null;
    },

    async konsumsiAkrual(tx, angsuranId) {
      return tx.query<KonsumsiAkrualBaris>(
        `select id::text as id, angsuran_id::text as angsuran_id,
                jadwal_id::text as jadwal_id, nilai::text as nilai,
                dipulihkan_at::text as dipulihkan_at
           from pumk_angsuran_akrual
          where angsuran_id = $1::uuid and deleted_at is null
          order by created_at, id
          for update`,
        [angsuranId],
      );
    },

    async tandaiKonsumsiDipulihkan(tx, ids, userId) {
      for (const id of ids) {
        await tx.query(
          `update pumk_angsuran_akrual
              set dipulihkan_at = now(), dipulihkan_by = $2::uuid,
                  updated_by = $2::uuid, updated_at = now()
            where id = $1::uuid and dipulihkan_at is null`,
          [id, userId],
        );
      }
    },

    async buatAngsuran(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_angsuran
           (akad_id, tanggal_terima, tanggal_valuta, jumlah_diterima, alokasi_pokok,
            alokasi_jasa, alokasi_kelebihan, akun_kas_id, no_bukti, metode_alokasi,
            keterangan, created_by, updated_by)
         values ($1::uuid, $2::date, $3::date, $4::numeric, $5::numeric, $6::numeric,
                 $7::numeric, $8::uuid, $9, $10, $11, $12::uuid, $12::uuid)
         returning id`,
        [
          input.akadId,
          input.tanggal,
          input.tanggalValuta,
          input.jumlah,
          input.alokasiPokok,
          input.alokasiJasa,
          input.alokasiKelebihan,
          input.akunKasId,
          input.noBukti,
          input.metodeAlokasi,
          input.keterangan,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async setJurnalAngsuran(tx, angsuranId, jurnalId) {
      await tx.query(
        `update pumk_angsuran set jurnal_id = $2::uuid, updated_at = now() where id = $1::uuid`,
        [angsuranId, jurnalId],
      );
    },

    async buatKelebihan(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_kelebihan
           (akad_id, angsuran_id, tanggal, jumlah, status, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4::numeric, 'TERTAHAN', $5::uuid, $5::uuid)
         returning id`,
        [input.akadId, input.angsuranId, input.tanggal, input.jumlah, input.userId],
      );
      return r[0].id;
    },

    async setJurnalKelebihan(tx, kelebihanId, jurnalId) {
      await tx.query(
        `update pumk_kelebihan set jurnal_id_terima = $2::uuid, updated_at = now()
          where id = $1::uuid`,
        [kelebihanId, jurnalId],
      );
    },

    async perbaruiOutstanding(tx, input) {
      await tx.query(
        `update pumk_akad
            set outstanding_pokok = $2::numeric, outstanding_jasa = $3::numeric,
                status = $4, tanggal_lunas = $5::date,
                updated_by = $6::uuid, updated_at = now()
          where id = $1::uuid`,
        [
          input.akadId,
          input.outstandingPokok,
          input.outstandingJasa,
          input.status,
          input.tanggalLunas,
          input.userId,
        ],
      );
    },

    async buatReschedule(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_reschedule
           (akad_id, tanggal_pengajuan, alasan, jenis, tenor_baru, grace_baru,
            jasa_rate_baru, pokok_baru, jadwal_versi_lama, status, catatan,
            created_by, updated_by)
         values ($1::uuid, $2::date, $3, $4, $5, $6, $7::numeric, $8::numeric, $9,
                 'DRAFT', $10, $11::uuid, $11::uuid)
         returning id`,
        [
          input.akadId,
          input.tanggalPengajuan,
          input.alasan,
          input.jenis,
          input.tenorBaru,
          input.graceBaru,
          input.jasaRateBaru,
          input.pokokBaru,
          input.jadwalVersiLama,
          input.catatan,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async reschedule(tx, id) {
      const r = await tx.query<RescheduleBaris>(
        `select ${KOLOM_RESCHEDULE} from pumk_reschedule
          where id = $1::uuid and deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async setujuiReschedule(tx, input) {
      // Guarded on status DRAFT inside the UPDATE as well as in the engine, so
      // two approvals racing on one draft cannot both build a version.
      const r = await tx.query<{ id: string }>(
        `update pumk_reschedule
            set status = 'DISETUJUI', approved_by = $3::uuid, approved_at = $4::timestamptz,
                jadwal_versi_baru = $2, outstanding_pokok_sebelum = $5::numeric,
                outstanding_jasa_sebelum = $6::numeric, updated_by = $3::uuid, updated_at = now()
          where id = $1::uuid and status = 'DRAFT' and deleted_at is null
          returning id`,
        [
          input.id,
          input.versiBaru,
          input.userId,
          input.waktu,
          input.outstandingPokokSebelum,
          input.outstandingJasaSebelum,
        ],
      );
      return r.length;
    },
  };
}
