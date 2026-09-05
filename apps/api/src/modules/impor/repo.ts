// Every SQL statement this module issues.
//
// NO STATEMENT HERE TOUCHES `jurnal` OR `jurnal_baris`, and none ever may.
// The receipt import moves money through the instalment engine (see
// `PabrikAngsuran` in ./contract.ts); the opening-balance import moves it
// through the journal engine's own combined posting (`PorterJurnalSaldoAwal`).
// Both reach the ledger through the one central path invariant 11 rests on. A
// repair statement added to this file would be the moment that stopped being
// true, and `bun run check:boundaries` fails the build if one appears.
//
// THE WRITE TARGETS, in full: `mitra`, `impor_berkas`, `impor_baris`, and for
// the go-live import `akun`, `saldo_awal_batch`, `akun_saldo_awal`,
// `akad_saldo_awal`, plus ONE update of the opening outstanding on
// `pumk_akad`. That last one is the only write into a live row another module
// owns; `setOutstandingAwalAkad` below argues it where it happens, and there
// is no statement here that touches `pumk_jadwal_angsuran` or `pumk_angsuran`.
//
// Driver facts, from the top of modules/jurnal/repo.ts: a JS array binds as a
// comma-joined string so `= ANY($n::text[])` fails 22P02; a jsonb param bound
// from a JS string becomes a JSON string SCALAR so it needs `$n::text::jsonb`;
// DATE columns come back as JS `Date`, so every date is selected `::text`.
import type { QueryRunner } from "../../core/ports/db";
import type { JenisImpor } from "./contract";

export interface ImporRepo {
  cabang(
    tx: QueryRunner,
    bumnId: string,
    cabangId: string,
  ): Promise<{ id: string; kode: string } | null>;

  berkasSudahAda(
    tx: QueryRunner,
    q: { bumnId: string; jenis: JenisImpor; checksum: string },
  ): Promise<{ id: string; nama_file: string; diunggah_pada: string } | null>;

  buatBerkas(
    tx: QueryRunner,
    input: {
      bumnId: string;
      cabangId: string;
      jenis: JenisImpor;
      namaFile: string;
      ukuranBytes: number;
      checksum: string;
      jumlahBaris: number;
      userId: string;
    },
  ): Promise<string>;

  catatBaris(
    tx: QueryRunner,
    input: {
      berkasId: string;
      nomorBaris: number;
      entitas: string;
      entitasId: string;
      jurnalId: string | null;
      nilai: Record<string, unknown>;
      userId: string;
    },
  ): Promise<void>;

  // --- MITRA ------------------------------------------------------------
  kodeMitraDipakai(tx: QueryRunner, kode: string): Promise<boolean>;
  nikDipakai(tx: QueryRunner, nik: string): Promise<boolean>;
  buatMitra(
    tx: QueryRunner,
    input: {
      cabangId: string;
      kodeMitra: string;
      namaLengkap: string;
      nik: string | null;
      jenisKelamin: string | null;
      tanggalLahir: string | null;
      alamat: string | null;
      telepon: string | null;
      email: string | null;
      namaUsaha: string | null;
      bidangUsaha: string | null;
      kodeMitraLama: string | null;
      userId: string;
    },
  ): Promise<string>;

  // --- ANGSURAN ---------------------------------------------------------
  akadByNomor(
    tx: QueryRunner,
    cabangId: string,
    noAkad: string,
  ): Promise<{ id: string; cabang_id: string; status: string } | null>;
  akunKasByKode(
    tx: QueryRunner,
    bumnId: string,
    kode: string,
  ): Promise<{ id: string; is_postable: boolean } | null>;

  // --- SALDO_AWAL (spec 9.6, ADR 0006) ----------------------------------
  akunByKode(tx: QueryRunner, bumnId: string, kode: string): Promise<AkunAdaBaris | null>;
  klasifikasiAkunAda(tx: QueryRunner, bumnId: string, kode: string): Promise<boolean>;
  kolektibilitasKelasAda(tx: QueryRunner, kode: string): Promise<boolean>;
  /** The earliest OPEN period of this entity. The opening journal's home. */
  periodeOpenPertama(tx: QueryRunner, bumnId: string): Promise<PeriodeAwalBaris | null>;
  /**
   * The receivable control account, resolved the way `v_rekonsiliasi_piutang`
   * resolves it: the debit leg of the active `PENCAIRAN_PUMK` mapping.
   */
  akunPiutangKontrol(
    tx: QueryRunner,
    bumnId: string,
  ): Promise<{ id: string; kode: string } | null>;
  akadUntukSaldoAwal(
    tx: QueryRunner,
    cabangId: string,
    noAkad: string,
  ): Promise<AkadAwalBaris | null>;
  batchDipostingAda(
    tx: QueryRunner,
    bumnId: string,
    cabangId: string,
  ): Promise<{ id: string; tanggal_efektif: string; dibuat_pada: string } | null>;
  buatAkun(
    tx: QueryRunner,
    input: {
      bumnId: string;
      kode: string;
      nama: string;
      tipe: string;
      saldoNormal: string;
      level: number;
      parentId: string | null;
      klasifikasi: string;
      isPostable: boolean;
      isKas: boolean;
      isKontra: boolean;
      klasifikasiArusKas: string | null;
      userId: string;
    },
  ): Promise<string>;
  buatBatchSaldoAwal(
    tx: QueryRunner,
    input: {
      bumnId: string;
      cabangId: string;
      tanggalEfektif: string;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  tulisAkunSaldoAwal(
    tx: QueryRunner,
    input: {
      batchId: string;
      cabangId: string;
      akunId: string;
      debit: string;
      kredit: string;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  tulisAkadSaldoAwal(
    tx: QueryRunner,
    input: {
      batchId: string;
      akadId: string;
      outstandingPokok: string;
      outstandingJasa: string;
      tunggakanPokok: string;
      tunggakanJasa: string;
      angsuranKeTerakhir: number | null;
      hariTunggakan: number | null;
      kolektibilitas: string | null;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  setOutstandingAwalAkad(
    tx: QueryRunner,
    input: {
      akadId: string;
      outstandingPokok: string;
      outstandingJasa: string;
      userId: string;
    },
  ): Promise<void>;
  tandaiBatchDiposting(
    tx: QueryRunner,
    input: {
      batchId: string;
      jurnalId: string;
      totalDebit: string;
      totalKredit: string;
      catatan: Record<string, unknown>;
      userId: string;
    },
  ): Promise<void>;
  /** Spec 8.4 check 10, read for the akad this batch touched. THE SHIPPED VIEW. */
  rekonsiliasiPiutang(
    tx: QueryRunner,
    akadIds: readonly string[],
  ): Promise<
    Array<{
      no_akad: string;
      saldo_sub_ledger: string;
      saldo_buku_besar: string;
      selisih: string;
    }>
  >;
}

/** An account that already exists, in the shape the collision rule compares. */
export interface AkunAdaBaris {
  id: string;
  kode: string;
  nama: string;
  tipe: string;
  saldo_normal: string;
  level: number;
  parent_kode: string | null;
  klasifikasi_akun: string;
  is_postable: boolean;
  is_kas: boolean;
  is_kontra: boolean;
  klasifikasi_arus_kas: string | null;
  aktif: boolean;
}

export interface PeriodeAwalBaris {
  id: string;
  tahun: number;
  bulan: number;
  tanggal_mulai: string;
  tanggal_akhir: string;
}

export interface AkadAwalBaris {
  id: string;
  no_akad: string;
  mitra_id: string;
  cabang_id: string;
  status: string;
  pokok_pinjaman: string;
  outstanding_pokok: string;
  /** True when this akad already has a line in the ledger, on any account. */
  ada_di_ledger: boolean;
}

export function createImporRepo(): ImporRepo {
  return {
    async cabang(tx, bumnId, cabangId) {
      const r = await tx.query<{ id: string; kode: string }>(
        `select id::text as id, kode from cabang
          where id = $1::uuid and bumn_id = $2::uuid and aktif and deleted_at is null
          limit 1`,
        [cabangId, bumnId],
      );
      return r[0] ?? null;
    },

    async berkasSudahAda(tx, q) {
      const r = await tx.query<{ id: string; nama_file: string; diunggah_pada: string }>(
        `select id::text as id, nama_file,
                to_char(diunggah_pada, 'YYYY-MM-DD"T"HH24:MI:SSOF') as diunggah_pada
           from impor_berkas
          where bumn_id = $1::uuid and jenis = $2 and checksum = $3 and deleted_at is null
          limit 1`,
        [q.bumnId, q.jenis, q.checksum],
      );
      return r[0] ?? null;
    },

    async buatBerkas(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into impor_berkas
           (bumn_id, cabang_id, jenis, nama_file, ukuran_bytes, checksum, jumlah_baris,
            diunggah_oleh, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $8::uuid, $8::uuid)
         returning id::text as id`,
        [
          input.bumnId,
          input.cabangId,
          input.jenis,
          input.namaFile,
          input.ukuranBytes,
          input.checksum,
          input.jumlahBaris,
          input.userId,
        ],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("impor: insert berkas tidak mengembalikan baris");
      return id;
    },

    async catatBaris(tx, input) {
      await tx.query(
        `insert into impor_baris
           (berkas_id, nomor_baris, entitas, entitas_id, jurnal_id, nilai_json,
            created_by, updated_by)
         values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::text::jsonb, $7::uuid, $7::uuid)`,
        [
          input.berkasId,
          input.nomorBaris,
          input.entitas,
          input.entitasId,
          input.jurnalId,
          JSON.stringify(input.nilai),
          input.userId,
        ],
      );
    },

    async kodeMitraDipakai(tx, kode) {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from mitra where kode_mitra = $1 and deleted_at is null`,
        [kode],
      );
      return Number(r[0]?.n ?? "0") > 0;
    },

    async nikDipakai(tx, nik) {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from mitra where nik = $1 and deleted_at is null`,
        [nik],
      );
      return Number(r[0]?.n ?? "0") > 0;
    },

    async buatMitra(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into mitra
           (cabang_id, kode_mitra, nama_lengkap, nik, jenis_kelamin, tanggal_lahir,
            alamat, telepon, email, nama_usaha, bidang_usaha, kode_mitra_lama,
            is_mitra_lama, status, aktif, created_by, updated_by)
         values ($1::uuid, $2, $3, $4::text, $5::text, $6::date, $7::text, $8::text,
                 $9::text, $10::text, $11::text, $12::text,
                 ($12::text is not null), 'CALON', true, $13::uuid, $13::uuid)
         returning id::text as id`,
        [
          input.cabangId,
          input.kodeMitra,
          input.namaLengkap,
          input.nik,
          input.jenisKelamin,
          input.tanggalLahir,
          input.alamat,
          input.telepon,
          input.email,
          input.namaUsaha,
          input.bidangUsaha,
          input.kodeMitraLama,
          input.userId,
        ],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("impor: insert mitra tidak mengembalikan baris");
      return id;
    },

    async akadByNomor(tx, cabangId, noAkad) {
      // Scoped to the FILE's branch in the query: a receipt file uploaded for
      // branch A cannot reach an akad of branch B by naming its number.
      const r = await tx.query<{ id: string; cabang_id: string; status: string }>(
        `select id::text as id, cabang_id::text as cabang_id, status
           from pumk_akad
          where no_akad = $1 and cabang_id = $2::uuid and deleted_at is null
          limit 1`,
        [noAkad, cabangId],
      );
      return r[0] ?? null;
    },

    async akunKasByKode(tx, bumnId, kode) {
      const r = await tx.query<{ id: string; is_postable: boolean }>(
        `select id::text as id, is_postable from akun
          where bumn_id = $1::uuid and kode = $2 and deleted_at is null
          limit 1`,
        [bumnId, kode],
      );
      return r[0] ?? null;
    },

    // --- SALDO_AWAL -------------------------------------------------------

    async akunByKode(tx, bumnId, kode) {
      // `parent_kode` rather than `parent_id`: the file speaks codes, and the
      // collision rule compares what the operator wrote against what is
      // stored, so both sides have to be in the same vocabulary.
      const r = await tx.query<AkunAdaBaris>(
        `select a.id::text as id, a.kode, a.nama, a.tipe, a.saldo_normal,
                a.level::int as level, p.kode as parent_kode, a.klasifikasi_akun,
                a.is_postable, a.is_kas, a.is_kontra, a.klasifikasi_arus_kas, a.aktif
           from akun a
           left join akun p on p.id = a.parent_id
          where a.bumn_id = $1::uuid and a.kode = $2 and a.deleted_at is null
          limit 1`,
        [bumnId, kode],
      );
      return r[0] ?? null;
    },

    async klasifikasiAkunAda(tx, bumnId, kode) {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from klasifikasi_akun
          where bumn_id = $1::uuid and kode = $2 and deleted_at is null`,
        [bumnId, kode],
      );
      return Number(r[0]?.n ?? "0") > 0;
    },

    async kolektibilitasKelasAda(tx, kode) {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from kolektibilitas_kelas where kode = $1`,
        [kode],
      );
      return Number(r[0]?.n ?? "0") > 0;
    },

    async periodeOpenPertama(tx, bumnId) {
      // DATE columns come back as JS `Date`, so both are selected ::text.
      const r = await tx.query<PeriodeAwalBaris>(
        `select id::text as id, tahun::int as tahun, bulan::int as bulan,
                tanggal_mulai::text as tanggal_mulai, tanggal_akhir::text as tanggal_akhir
           from periode
          where bumn_id = $1::uuid and status = 'OPEN' and deleted_at is null
          order by tanggal_mulai asc
          limit 1`,
        [bumnId],
      );
      return r[0] ?? null;
    },

    async akunPiutangKontrol(tx, bumnId) {
      // THE SAME RESOLUTION `v_rekonsiliasi_piutang` USES, statement for
      // statement: the debit leg of the active PENCAIRAN_PUMK mapping. Naming
      // an account code here instead would let this check and the close's
      // check drift apart the first time an accountant repoints the mapping.
      const r = await tx.query<{ id: string; kode: string }>(
        `select k.id::text as id, k.kode
           from event_jurnal_mapping m
           join akun k on k.postable_id = m.akun_debit_id
          where m.bumn_id = $1::uuid and m.event_code = 'PENCAIRAN_PUMK'
            and m.aktif and m.deleted_at is null
          limit 1`,
        [bumnId],
      );
      return r[0] ?? null;
    },

    async akadUntukSaldoAwal(tx, cabangId, noAkad) {
      // Scoped to the FILE's branch in the query, exactly as `akadByNomor` is:
      // an opening-balance file for branch A cannot reach an akad of branch B
      // by naming its number.
      const r = await tx.query<AkadAwalBaris>(
        `select a.id::text as id, a.no_akad, a.mitra_id::text as mitra_id,
                a.cabang_id::text as cabang_id, a.status,
                a.pokok_pinjaman::numeric(20,2)::text as pokok_pinjaman,
                a.outstanding_pokok::numeric(20,2)::text as outstanding_pokok,
                exists (
                  select 1 from v_ledger_baris l where l.akad_id = a.id
                ) as ada_di_ledger
           from pumk_akad a
          where a.no_akad = $1 and a.cabang_id = $2::uuid and a.deleted_at is null
          limit 1`,
        [noAkad, cabangId],
      );
      return r[0] ?? null;
    },

    async batchDipostingAda(tx, bumnId, cabangId) {
      // The DOMAIN half of the double-run refusal. The DATABASE half is
      // `saldo_awal_batch_diposting_uq` (migration 0033), which is what makes
      // it true under a race; this read is what makes the refusal readable.
      const r = await tx.query<{ id: string; tanggal_efektif: string; dibuat_pada: string }>(
        `select id::text as id, tanggal_efektif::text as tanggal_efektif,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as dibuat_pada
           from saldo_awal_batch
          where bumn_id = $1::uuid and status = 'DIPOSTING' and deleted_at is null
            and (cabang_id = $2::uuid or cabang_id is null)
          order by created_at asc
          limit 1`,
        [bumnId, cabangId],
      );
      return r[0] ?? null;
    },

    async buatAkun(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into akun
           (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal, is_postable,
            is_kas, is_kontra, klasifikasi_arus_kas, klasifikasi_akun, aktif,
            created_by, updated_by)
         values ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11::text, $12,
                 true, $13::uuid, $13::uuid)
         returning id::text as id`,
        [
          input.bumnId,
          input.kode,
          input.nama,
          input.parentId,
          input.level,
          input.tipe,
          input.saldoNormal,
          input.isPostable,
          input.isKas,
          input.isKontra,
          input.klasifikasiArusKas,
          input.klasifikasi,
          input.userId,
        ],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("impor: insert akun tidak mengembalikan baris");
      return id;
    },

    async buatBatchSaldoAwal(tx, input) {
      // Born DRAFT and moved to DIPOSTING only once the journal exists, so a
      // rolled back import leaves no batch claiming to have been posted, and
      // `saldo_awal_batch_diposting_uq` is only ever tested against real ones.
      const r = await tx.query<{ id: string }>(
        `insert into saldo_awal_batch
           (bumn_id, cabang_id, tanggal_efektif, keterangan, sumber, status,
            created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4::text, 'IMPORT_EXCEL', 'DRAFT',
                 $5::uuid, $5::uuid)
         returning id::text as id`,
        [input.bumnId, input.cabangId, input.tanggalEfektif, input.keterangan, input.userId],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("impor: insert saldo_awal_batch tidak mengembalikan baris");
      return id;
    },

    async tulisAkunSaldoAwal(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into akun_saldo_awal
           (batch_id, cabang_id, akun_id, saldo_debit, saldo_kredit, keterangan,
            created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric, $6::text,
                 $7::uuid, $7::uuid)
         returning id::text as id`,
        [
          input.batchId,
          input.cabangId,
          input.akunId,
          input.debit,
          input.kredit,
          input.keterangan,
          input.userId,
        ],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("impor: insert akun_saldo_awal tidak mengembalikan baris");
      return id;
    },

    async tulisAkadSaldoAwal(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into akad_saldo_awal
           (batch_id, akad_id, outstanding_pokok_awal, outstanding_jasa_awal,
            tunggakan_pokok_awal, tunggakan_jasa_awal, angsuran_ke_terakhir_dibayar,
            hari_tunggakan_awal, kolektibilitas_awal, keterangan, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $6::numeric,
                 $7::smallint, $8::int, $9::text, $10::text, $11::uuid, $11::uuid)
         returning id::text as id`,
        [
          input.batchId,
          input.akadId,
          input.outstandingPokok,
          input.outstandingJasa,
          input.tunggakanPokok,
          input.tunggakanJasa,
          input.angsuranKeTerakhir,
          input.hariTunggakan,
          input.kolektibilitas,
          input.keterangan,
          input.userId,
        ],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("impor: insert akad_saldo_awal tidak mengembalikan baris");
      return id;
    },

    async setOutstandingAwalAkad(tx, input) {
      // THE ONE WRITE THIS MODULE MAKES INTO ANOTHER MODULE'S LIVE ROW, and it
      // is not optional: `v_rekonsiliasi_piutang` compares
      // `pumk_akad.outstanding_pokok` against the ledger, so an opening
      // balance that posted the ledger half and left the sub-ledger at zero
      // would fail the close's check 10 on every imported akad, which is
      // precisely the outcome this import exists to prevent. The engine only
      // reaches here for an akad it has already proved is BELUM_CAIR with a
      // zero outstanding and no ledger line, so this sets a value, it never
      // adjusts one.
      await tx.query(
        `update pumk_akad
            set status = 'AKTIF',
                outstanding_pokok = $2::numeric,
                outstanding_jasa = $3::numeric,
                updated_by = $4::uuid, updated_at = now()
          where id = $1::uuid`,
        [input.akadId, input.outstandingPokok, input.outstandingJasa, input.userId],
      );
    },

    async tandaiBatchDiposting(tx, input) {
      await tx.query(
        `update saldo_awal_batch
            set status = 'DIPOSTING', jurnal_id = $2::uuid,
                total_debit = $3::numeric, total_kredit = $4::numeric,
                catatan_validasi_json = $5::text::jsonb,
                divalidasi_by = $6::uuid, divalidasi_at = now(),
                updated_by = $6::uuid, updated_at = now()
          where id = $1::uuid`,
        [
          input.batchId,
          input.jurnalId,
          input.totalDebit,
          input.totalKredit,
          JSON.stringify(input.catatan),
          input.userId,
        ],
      );
    },

    async rekonsiliasiPiutang(tx, akadIds) {
      if (akadIds.length === 0) return [];
      // A JS array binds as a comma-joined string, which `uuid[]` rejects
      // (driver fact 3 at the top of modules/jurnal/repo.ts), so the id list
      // is a placeholder list rather than `= any($1::uuid[])`.
      const params = akadIds.map((_, i) => `$${i + 1}::uuid`).join(", ");
      return tx.query<{
        no_akad: string;
        saldo_sub_ledger: string;
        saldo_buku_besar: string;
        selisih: string;
      }>(
        `select no_akad,
                saldo_sub_ledger::numeric(20,2)::text as saldo_sub_ledger,
                saldo_buku_besar::numeric(20,2)::text as saldo_buku_besar,
                selisih::numeric(20,2)::text as selisih
           from v_rekonsiliasi_piutang
          where akad_id in (${params})`,
        [...akadIds],
      );
    },
  };
}
