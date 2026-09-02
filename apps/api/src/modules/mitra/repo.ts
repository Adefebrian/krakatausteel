// Every SQL statement this module issues.
//
// THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL: every mitra-facing read
// carries `mitra_id = $n::uuid` IN THE WHERE CLAUSE, bound from the SESSION,
// and no function here accepts a mitra id from anywhere else. There is no
// "read this akad" that later checks ownership; the ownership IS the query. A
// row belonging to somebody else is not found, so a not-found and a
// not-yours are literally the same code path and cannot drift apart.
//
// Driver facts, from the top of modules/jurnal/repo.ts: a JS array binds as a
// comma-joined string so `= ANY($n::text[])` fails 22P02; a jsonb param bound
// from a JS string becomes a JSON string SCALAR so it needs `$n::text::jsonb`;
// DATE columns come back as JS `Date`, so every date is selected `::text`.
import type { QueryRunner } from "../../core/ports/db";
import type {
  AkadMitra,
  BarisJadwalMitra,
  PembayaranMitra,
  ProfilMitra,
} from "./contract";

export interface BarisAkun {
  akun_id: string;
  mitra_id: string;
  email: string;
  password_hash: string;
  aktif: boolean;
  harus_ganti_sandi: boolean;
  mitra_aktif: boolean;
  kode_mitra: string;
  nama_lengkap: string;
  nama_usaha: string | null;
  status_mitra: string;
  cabang_id: string;
  cabang_kode: string;
  cabang_nama: string;
  bumn_id: string;
}

export interface MitraRepo {
  /** The login lookup. Case-insensitive, matching `portal_akun_mitra_email_uq`. */
  akunByEmail(tx: QueryRunner, email: string): Promise<BarisAkun | null>;
  /** Re-read on EVERY request: deactivating an account takes effect at once. */
  akunById(tx: QueryRunner, akunId: string): Promise<BarisAkun | null>;
  catatMasuk(tx: QueryRunner, akunId: string): Promise<void>;
  simpanSandi(tx: QueryRunner, akunId: string, hash: string): Promise<number>;

  daftarAkad(tx: QueryRunner, mitraId: string): Promise<AkadMitra[]>;
  akadMilik(
    tx: QueryRunner,
    mitraId: string,
    akadId: string,
  ): Promise<{ id: string; no_akad: string; versi: number; outstanding_pokok: string; outstanding_jasa: string } | null>;
  jadwalAkad(tx: QueryRunner, mitraId: string, akadId: string): Promise<BarisJadwalMitra[]>;
  pembayaranAkad(tx: QueryRunner, mitraId: string, akadId: string): Promise<PembayaranMitra[]>;

  // --- staff side --------------------------------------------------------
  mitraUntukAkun(
    tx: QueryRunner,
    bumnId: string,
    mitraId: string,
  ): Promise<{ id: string; cabang_id: string; nama_lengkap: string } | null>;
  akunByMitra(tx: QueryRunner, mitraId: string): Promise<BarisAkun | null>;
  buatAkun(
    tx: QueryRunner,
    input: { mitraId: string; email: string; hash: string; userId: string },
  ): Promise<string>;
  setAktif(
    tx: QueryRunner,
    input: { mitraId: string; aktif: boolean; userId: string },
  ): Promise<number>;
}

const KOLOM_AKUN = `
  a.id::text as akun_id, a.mitra_id::text as mitra_id, a.email, a.password_hash,
  a.aktif, a.harus_ganti_sandi,
  m.aktif as mitra_aktif, m.kode_mitra, m.nama_lengkap, m.nama_usaha,
  m.status as status_mitra,
  c.id::text as cabang_id, c.kode as cabang_kode, c.nama as cabang_nama,
  c.bumn_id::text as bumn_id`;

const DARI_AKUN = `
  from portal_akun_mitra a
  join mitra m on m.id = a.mitra_id and m.deleted_at is null
  join cabang c on c.id = m.cabang_id and c.deleted_at is null`;

export function createMitraRepo(): MitraRepo {
  return {
    async akunByEmail(tx, email) {
      const r = await tx.query<BarisAkun>(
        `select ${KOLOM_AKUN} ${DARI_AKUN}
          where lower(a.email) = lower($1) and a.deleted_at is null
          limit 1`,
        [email],
      );
      return r[0] ?? null;
    },

    async akunById(tx, akunId) {
      const r = await tx.query<BarisAkun>(
        `select ${KOLOM_AKUN} ${DARI_AKUN}
          where a.id = $1::uuid and a.deleted_at is null
          limit 1`,
        [akunId],
      );
      return r[0] ?? null;
    },

    async catatMasuk(tx, akunId) {
      await tx.query(`update portal_akun_mitra set last_login_at = now() where id = $1::uuid`, [
        akunId,
      ]);
    },

    async simpanSandi(tx, akunId, hash) {
      const r = await tx.query<{ id: string }>(
        `update portal_akun_mitra
            set password_hash = $2, harus_ganti_sandi = false, updated_at = now()
          where id = $1::uuid and deleted_at is null
        returning id::text as id`,
        [akunId, hash],
      );
      return r.length;
    },

    async daftarAkad(tx, mitraId) {
      const rows = await tx.query<{
        id: string;
        no_akad: string;
        tanggal_akad: string;
        pokok_pinjaman: string;
        tenor_bulan: number;
        metode_perhitungan: string;
        tanggal_mulai_angsuran: string;
        tanggal_jatuh_tempo_akhir: string;
        status: string;
        outstanding_pokok: string;
        outstanding_jasa: string;
        tanggal_lunas: string | null;
      }>(
        `select k.id::text as id, k.no_akad,
                k.tanggal_akad::text as tanggal_akad,
                k.pokok_pinjaman::text as pokok_pinjaman,
                k.tenor_bulan, k.metode_perhitungan,
                k.tanggal_mulai_angsuran::text as tanggal_mulai_angsuran,
                k.tanggal_jatuh_tempo_akhir::text as tanggal_jatuh_tempo_akhir,
                k.status,
                k.outstanding_pokok::text as outstanding_pokok,
                k.outstanding_jasa::text as outstanding_jasa,
                k.tanggal_lunas::text as tanggal_lunas
           from pumk_akad k
          where k.mitra_id = $1::uuid and k.deleted_at is null
          order by k.tanggal_akad desc, k.no_akad desc`,
        [mitraId],
      );
      return rows.map(
        (b): AkadMitra => ({
          id: b.id,
          noAkad: b.no_akad,
          tanggalAkad: b.tanggal_akad,
          pokokPinjaman: b.pokok_pinjaman,
          tenorBulan: b.tenor_bulan,
          metodePerhitungan: b.metode_perhitungan,
          tanggalMulaiAngsuran: b.tanggal_mulai_angsuran,
          tanggalJatuhTempoAkhir: b.tanggal_jatuh_tempo_akhir,
          status: b.status,
          outstandingPokok: b.outstanding_pokok,
          outstandingJasa: b.outstanding_jasa,
          tanggalLunas: b.tanggal_lunas,
        }),
      );
    },

    async akadMilik(tx, mitraId, akadId) {
      // BOTH ids in the WHERE clause. An akad belonging to another mitra
      // simply is not selected, so the caller cannot tell "does not exist"
      // from "is not yours" -- and neither can an attacker.
      const r = await tx.query<{
        id: string;
        no_akad: string;
        versi: number;
        outstanding_pokok: string;
        outstanding_jasa: string;
      }>(
        `select k.id::text as id, k.no_akad,
                coalesce(v.versi, 1) as versi,
                k.outstanding_pokok::text as outstanding_pokok,
                k.outstanding_jasa::text as outstanding_jasa
           from pumk_akad k
           left join pumk_jadwal_versi v
             on v.akad_id = k.id and v.is_active_version and v.deleted_at is null
          where k.id = $1::uuid and k.mitra_id = $2::uuid and k.deleted_at is null
          limit 1`,
        [akadId, mitraId],
      );
      return r[0] ?? null;
    },

    async jadwalAkad(tx, mitraId, akadId) {
      const rows = await tx.query<{
        angsuran_ke: number;
        tanggal_jatuh_tempo: string;
        pokok: string;
        jasa_adm: string;
        total: string;
        pokok_terbayar: string;
        jasa_terbayar: string;
        status: string;
        tanggal_lunas: string | null;
      }>(
        `select j.angsuran_ke,
                j.tanggal_jatuh_tempo::text as tanggal_jatuh_tempo,
                j.pokok::text as pokok, j.jasa_adm::text as jasa_adm,
                j.total::text as total,
                j.pokok_terbayar::text as pokok_terbayar,
                j.jasa_terbayar::text as jasa_terbayar,
                j.status, j.tanggal_lunas::text as tanggal_lunas
           from pumk_jadwal_angsuran j
           join pumk_akad k on k.id = j.akad_id and k.deleted_at is null
          where j.akad_id = $1::uuid and k.mitra_id = $2::uuid
            and j.is_active_version and j.deleted_at is null
          order by j.angsuran_ke`,
        [akadId, mitraId],
      );
      return rows.map(
        (b): BarisJadwalMitra => ({
          angsuranKe: b.angsuran_ke,
          tanggalJatuhTempo: b.tanggal_jatuh_tempo,
          pokok: b.pokok,
          jasaAdm: b.jasa_adm,
          total: b.total,
          pokokTerbayar: b.pokok_terbayar,
          jasaTerbayar: b.jasa_terbayar,
          status: b.status,
          tanggalLunas: b.tanggal_lunas,
        }),
      );
    },

    async pembayaranAkad(tx, mitraId, akadId) {
      const rows = await tx.query<{
        tanggal_terima: string;
        jumlah_diterima: string;
        alokasi_pokok: string;
        alokasi_jasa: string;
        alokasi_kelebihan: string;
        no_bukti: string | null;
      }>(
        `select g.tanggal_terima::text as tanggal_terima,
                g.jumlah_diterima::text as jumlah_diterima,
                g.alokasi_pokok::text as alokasi_pokok,
                g.alokasi_jasa::text as alokasi_jasa,
                g.alokasi_kelebihan::text as alokasi_kelebihan,
                g.no_bukti
           from pumk_angsuran g
           join pumk_akad k on k.id = g.akad_id and k.deleted_at is null
          where g.akad_id = $1::uuid and k.mitra_id = $2::uuid and g.deleted_at is null
          order by g.tanggal_terima, g.created_at`,
        [akadId, mitraId],
      );
      return rows.map(
        (b): PembayaranMitra => ({
          tanggalTerima: b.tanggal_terima,
          jumlahDiterima: b.jumlah_diterima,
          alokasiPokok: b.alokasi_pokok,
          alokasiJasa: b.alokasi_jasa,
          alokasiKelebihan: b.alokasi_kelebihan,
          noBukti: b.no_bukti,
        }),
      );
    },

    async mitraUntukAkun(tx, bumnId, mitraId) {
      const r = await tx.query<{ id: string; cabang_id: string; nama_lengkap: string }>(
        `select m.id::text as id, m.cabang_id::text as cabang_id, m.nama_lengkap
           from mitra m
           join cabang c on c.id = m.cabang_id and c.deleted_at is null
          where m.id = $1::uuid and c.bumn_id = $2::uuid and m.deleted_at is null
          limit 1`,
        [mitraId, bumnId],
      );
      return r[0] ?? null;
    },

    async akunByMitra(tx, mitraId) {
      const r = await tx.query<BarisAkun>(
        `select ${KOLOM_AKUN} ${DARI_AKUN}
          where a.mitra_id = $1::uuid and a.deleted_at is null
          limit 1`,
        [mitraId],
      );
      return r[0] ?? null;
    },

    async buatAkun(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into portal_akun_mitra
           (mitra_id, email, password_hash, harus_ganti_sandi, aktif, created_by, updated_by)
         values ($1::uuid, $2, $3, true, true, $4::uuid, $4::uuid)
         returning id::text as id`,
        [input.mitraId, input.email, input.hash, input.userId],
      );
      const id = r[0]?.id;
      if (!id) throw new Error("mitra: insert akun tidak mengembalikan baris");
      return id;
    },

    async setAktif(tx, input) {
      const r = await tx.query<{ id: string }>(
        `update portal_akun_mitra
            set aktif = $2, updated_by = $3::uuid, updated_at = now()
          where mitra_id = $1::uuid and deleted_at is null
        returning id::text as id`,
        [input.mitraId, input.aktif, input.userId],
      );
      return r.length;
    },
  };
}

/** Shapes a `BarisAkun` into the profile a mitra sees of itself. */
export function profilDari(b: BarisAkun): ProfilMitra {
  return {
    kodeMitra: b.kode_mitra,
    namaLengkap: b.nama_lengkap,
    namaUsaha: b.nama_usaha,
    email: b.email,
    cabang: { kode: b.cabang_kode, nama: b.cabang_nama },
    status: b.status_mitra,
    harusGantiSandi: b.harus_ganti_sandi,
  };
}
