// Every SQL statement this module issues.
//
// THREE WRITE TARGETS, AND NO OTHERS: `mitra`, `impor_berkas`, `impor_baris`.
// There is no statement here that touches `jurnal`, `jurnal_baris`,
// `pumk_akad`, `pumk_jadwal_angsuran` or `pumk_angsuran`. The receipt import
// moves money through the instalment engine (see `PabrikAngsuran` in
// ./contract.ts), which reaches the ledger through the journal engine, which
// is the single posting path invariant 11 rests on. A repair statement added
// to this file would be the moment that stopped being true.
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
  };
}
