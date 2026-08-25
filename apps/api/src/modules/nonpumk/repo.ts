// Every statement the Non PUMK module issues, in one file. No business rules
// live here; ./service.ts decides, this reads and writes.
//
// WHAT IS DELIBERATELY ABSENT
//   - `jurnal` and `jurnal_baris` WRITES. Invariant 11: the ledger is reached
//     only through modules/jurnal, and migrations/0020's posting-path tripwire
//     plus tools/check-boundaries.ts both refuse any other route. The only
//     ledger SQL below is a READ (`efekBukuBesar`), which moves no money and is
//     what the detail page's "the books agree with the sub-ledger" assertion is
//     measured against.
//   - any policy number. Every bound, threshold and deadline arrives as a
//     parameter from ./service.ts, which read it from `konfigurasi`.
//
// THE DRIVER FACTS THIS FILE IS BUILT AROUND, identical to the ones
// modules/jurnal/repo.ts and modules/pumk/repo.ts document, because the same
// Bun Postgres client is underneath:
//
//  1. DATE and TIMESTAMPTZ come back as a JS `Date` while NUMERIC comes back as
//     a string, so every date column is selected `::text`. A `Date` here would
//     turn '2026-04-10' into '2026-04-09T17:00:00.000Z' and move an ageing
//     bucket by a day.
//  2. A JS array is serialised as a bare comma-joined string, which `text[]`
//     and `uuid[]` reject with 22P02 "malformed array literal". Nothing below
//     binds an array; the branch-scope filter and the SDG lookup expand to one
//     placeholder per element instead of `= ANY($n::uuid[])`.
//  3. A `jsonb` parameter bound from a JS string is stored as a JSON STRING
//     SCALAR, so `hasil_json` and `lampiran_json` are written `$n::text::jsonb`.
//
// AND ONE THIS MODULE ADDS
//  4. `coalesce(sum(numeric_col), 0)::text` yields '0' rather than '0.00' on an
//     empty set, because the literal 0 carries scale 0. Every money aggregate
//     below is therefore cast `::numeric(20,2)` BEFORE `::text`, so a caller
//     never has to guess whether a zero is a `Uang` or not.
import type { NonPumkTx } from "./contract";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ProposalBaris {
  id: string;
  cabang_id: string;
  bumn_id: string;
  no_proposal: string;
  tanggal_proposal: string;
  nama_pemohon: string;
  atas_nama: string | null;
  bidang_id: string;
  judul_program: string;
  deskripsi_program: string | null;
  jumlah_diajukan: string;
  jumlah_disetujui: string | null;
  penerima_manfaat_estimasi: number | null;
  sumber_pengajuan: string;
  status: string;
  current_step: number;
  created_by: string | null;
}

export interface TransisiBaris {
  status_dari: string | null;
  status_ke: string;
  aksi: string;
  oleh_user_id: string | null;
  waktu: string;
  catatan: string | null;
}

export interface SdgBaris {
  sdg_id: string;
  nomor: number;
  nama: string;
  bobot: string;
}

export interface PenilaianBaris {
  id: string;
  proposal_id: string;
  tanggal: string;
  petugas_karyawan_id: string | null;
  skor_total: string | null;
  nilai_rekomendasi: string | null;
  catatan: string | null;
}

export interface PenyaluranBaris {
  id: string;
  proposal_id: string;
  termin: number;
  tanggal_penyaluran: string;
  jumlah: string;
  akun_kas_id: string;
  akun_beban_id: string;
  no_bukti: string | null;
  keterangan: string | null;
  jurnal_id: string | null;
}

export interface LpjBaris {
  id: string;
  proposal_id: string;
  tanggal_lpj: string;
  jumlah_realisasi: string;
  jumlah_sisa_dikembalikan: string;
  penerima_manfaat_aktual: number | null;
  uraian_realisasi: string | null;
  status: string;
  verified_by: string | null;
  verified_at: string | null;
  jurnal_id_pengembalian: string | null;
}

export interface AkunBaris {
  id: string;
  aktif: boolean;
  is_postable: boolean;
  is_kas: boolean;
  tipe: string;
  bumn_id: string;
}

export interface MonitoringBaris {
  proposal_id: string;
  no_proposal: string;
  cabang_id: string;
  bidang_id: string;
  nama_pemohon: string;
  judul_program: string;
  status: string;
  total_disalurkan: string;
  tanggal_penyaluran_terakhir: string;
}

/** Filter shape as ./service.ts hands it over, already scope-narrowed. */
export interface FilterDaftar {
  cabangIds: readonly string[];
  bidangId?: string | null;
  sdgId?: string | null;
  status?: string | null;
  sumberPengajuan?: string | null;
  dariTanggal?: string | null;
  sampaiTanggal?: string | null;
  cari?: string | null;
}

// ---------------------------------------------------------------------------
// Column lists, written once
// ---------------------------------------------------------------------------

/**
 * `waktu` is rendered as an UNAMBIGUOUS UTC ISO instant rather than
 * `::text`. Postgres renders a timestamptz in the SESSION timezone with a
 * space separator and a two-digit offset ('2026-09-15 11:00:00+07'), which
 * `Date.parse` accepts only by leniency and which no two runtimes agree on.
 * The timeline is a read model an HTTP client parses, so it leaves here as
 * something with exactly one reading.
 */
const KOLOM_WAKTU =
  `to_char(t.waktu at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as waktu`;

const KOLOM_PROPOSAL = `
  p.id::text as id,
  p.cabang_id::text as cabang_id,
  c.bumn_id::text as bumn_id,
  p.no_proposal,
  p.tanggal_proposal::text as tanggal_proposal,
  p.nama_pemohon,
  p.atas_nama,
  p.bidang_id::text as bidang_id,
  p.judul_program,
  p.deskripsi_program,
  p.jumlah_diajukan::text as jumlah_diajukan,
  p.jumlah_disetujui::text as jumlah_disetujui,
  p.penerima_manfaat_estimasi,
  p.sumber_pengajuan,
  p.status,
  p.current_step,
  p.created_by::text as created_by`;

const KOLOM_PENYALURAN = `
  s.id::text as id,
  s.proposal_id::text as proposal_id,
  s.termin,
  s.tanggal_penyaluran::text as tanggal_penyaluran,
  s.jumlah::text as jumlah,
  s.akun_kas_id::text as akun_kas_id,
  s.akun_beban_id::text as akun_beban_id,
  s.no_bukti,
  s.keterangan,
  s.jurnal_id::text as jurnal_id`;

const KOLOM_LPJ = `
  l.id::text as id,
  l.proposal_id::text as proposal_id,
  l.tanggal_lpj::text as tanggal_lpj,
  l.jumlah_realisasi::text as jumlah_realisasi,
  l.jumlah_sisa_dikembalikan::text as jumlah_sisa_dikembalikan,
  l.penerima_manfaat_aktual,
  l.uraian_realisasi,
  l.status,
  l.verified_by::text as verified_by,
  to_char(l.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as verified_at,
  l.jurnal_id_pengembalian::text as jurnal_id_pengembalian`;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface NonPumkRepo {
  konfigurasi(tx: NonPumkTx, bumnId: string, grup: string, kunci: string): Promise<string | null>;
  cabang(tx: NonPumkTx, id: string): Promise<{ kode: string; bumn_id: string } | null>;
  bidangAda(tx: NonPumkTx, bumnId: string, bidangId: string): Promise<boolean>;
  /** The subset of `ids` that exist and are live. Order is not meaningful. */
  sdgYangAda(tx: NonPumkTx, ids: readonly string[]): Promise<string[]>;

  buatProposal(
    tx: NonPumkTx,
    input: {
      cabangId: string;
      noProposal: string;
      tanggalProposal: string;
      tanggalDaftar: string;
      namaPemohon: string;
      atasNama: string | null;
      alamat: string | null;
      kelurahan: string | null;
      kecamatan: string | null;
      kotaId: string | null;
      telepon: string | null;
      email: string | null;
      bidangId: string;
      judulProgram: string;
      deskripsiProgram: string | null;
      jumlahDiajukan: string;
      penerimaManfaatEstimasi: number;
      sumberPengajuan: string;
      portalSubmissionId: string | null;
      currentStep: number;
      userId: string;
    },
  ): Promise<string>;
  tambahSdg(
    tx: NonPumkTx,
    input: { proposalId: string; sdgId: string; bobot: string; userId: string },
  ): Promise<void>;

  proposal(tx: NonPumkTx, id: string): Promise<ProposalBaris | null>;
  proposalUntukDiubah(tx: NonPumkTx, id: string): Promise<ProposalBaris | null>;
  daftarProposal(tx: NonPumkTx, filter: FilterDaftar): Promise<ProposalBaris[]>;
  setStatusProposal(
    tx: NonPumkTx,
    input: { id: string; status: string; currentStep: number; userId: string },
  ): Promise<void>;
  setJumlahDisetujui(
    tx: NonPumkTx,
    input: { id: string; jumlahDisetujui: string; userId: string },
  ): Promise<void>;

  transisiTerakhir(tx: NonPumkTx, proposalId: string): Promise<string | null>;
  catatTransisi(
    tx: NonPumkTx,
    input: {
      proposalId: string;
      dari: string | null;
      ke: string;
      aksi: string;
      userId: string;
      waktu: string;
      catatan: string | null;
    },
  ): Promise<void>;
  timeline(tx: NonPumkTx, proposalId: string): Promise<TransisiBaris[]>;

  sdgProposal(tx: NonPumkTx, proposalId: string): Promise<SdgBaris[]>;

  simpanPenilaian(
    tx: NonPumkTx,
    input: {
      proposalId: string;
      tanggal: string;
      petugasKaryawanId: string | null;
      hasilJson: string;
      skorTotal: string;
      nilaiRekomendasi: string;
      catatan: string | null;
      lampiranJson: string;
      userId: string;
    },
  ): Promise<void>;
  penilaian(tx: NonPumkTx, proposalId: string): Promise<PenilaianBaris | null>;

  buatReview(
    tx: NonPumkTx,
    input: {
      proposalId: string;
      reviewerUserId: string;
      tanggal: string;
      keputusan: string;
      catatan: string | null;
    },
  ): Promise<void>;
  sudahMereview(tx: NonPumkTx, proposalId: string, userId: string): Promise<boolean>;

  buatApproval(
    tx: NonPumkTx,
    input: {
      proposalId: string;
      approverUserId: string;
      tanggal: string;
      keputusan: string;
      jumlahDisetujui: string | null;
      catatan: string | null;
    },
  ): Promise<void>;

  akun(tx: NonPumkTx, akunId: string): Promise<AkunBaris | null>;

  totalPenyaluran(tx: NonPumkTx, proposalId: string): Promise<string>;
  terminBerikutnya(tx: NonPumkTx, proposalId: string): Promise<number>;
  buatPenyaluran(
    tx: NonPumkTx,
    input: {
      proposalId: string;
      termin: number;
      tanggalPenyaluran: string;
      jumlah: string;
      akunKasId: string;
      akunBebanId: string;
      noBukti: string | null;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  setJurnalPenyaluran(
    tx: NonPumkTx,
    id: string,
    jurnalId: string,
    userId: string,
  ): Promise<void>;
  penyaluran(tx: NonPumkTx, id: string): Promise<PenyaluranBaris | null>;
  daftarPenyaluran(tx: NonPumkTx, proposalId: string): Promise<PenyaluranBaris[]>;
  /** The expense account of the LATEST live termin: the leg a refund reverses. */
  akunBebanTerakhir(tx: NonPumkTx, proposalId: string): Promise<string | null>;

  lpj(tx: NonPumkTx, proposalId: string): Promise<LpjBaris | null>;
  simpanLpj(
    tx: NonPumkTx,
    input: {
      proposalId: string;
      tanggalLpj: string;
      jumlahRealisasi: string;
      jumlahSisaDikembalikan: string;
      penerimaManfaatAktual: number;
      uraianRealisasi: string | null;
      lampiranJson: string;
      userId: string;
    },
  ): Promise<string>;
  setLpjDiverifikasi(
    tx: NonPumkTx,
    input: { id: string; verifiedBy: string; verifiedAt: string },
  ): Promise<void>;
  setLpjDitolak(tx: NonPumkTx, input: { id: string; userId: string }): Promise<void>;
  setJurnalPengembalian(
    tx: NonPumkTx,
    id: string,
    jurnalId: string,
    userId: string,
  ): Promise<void>;

  /**
   * The LEDGER effect of one proposal: SUM(debit - kredit) over BEBAN accounts
   * and over is_kas accounts, across every POSTED journal this proposal's rows
   * point at. Read from the ledger rather than recomputed from the business
   * rows, so the detail page PROVES the two agree instead of asserting it.
   */
  efekBukuBesar(tx: NonPumkTx, proposalId: string): Promise<{ beban: string; kas: string }>;

  monitoring(
    tx: NonPumkTx,
    input: { cabangIds: readonly string[]; bidangId?: string | null; status: readonly string[] },
  ): Promise<MonitoringBaris[]>;
}

// ---------------------------------------------------------------------------
// Small helpers for the dynamic filters
// ---------------------------------------------------------------------------

/**
 * Expands a list into `$3, $4, $5` and pushes the values, because driver fact
 * 2 makes `= ANY($n::uuid[])` fail with 22P02. Returns `null` for an empty
 * list so the caller can short-circuit rather than emit `in ()`.
 */
function daftarPlaceholder(
  nilai: readonly string[],
  params: unknown[],
  cast = "::uuid",
): string | null {
  if (nilai.length === 0) return null;
  const mulai = params.length + 1;
  params.push(...nilai);
  return nilai.map((_, i) => `$${mulai + i}${cast}`).join(", ");
}

export function createNonPumkRepo(): NonPumkRepo {
  return {
    async konfigurasi(tx, bumnId, grup, kunci) {
      // A bumn-scoped row overrides the shipped default (bumn_id IS NULL),
      // exactly how modules/konfigurasi resolves a parameter and exactly how
      // modules/pumk reads one. Read fresh on every call so an accountant's
      // edit takes effect without a deploy.
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

    async cabang(tx, id) {
      const r = await tx.query<{ kode: string; bumn_id: string }>(
        `select kode, bumn_id::text as bumn_id from cabang where id = $1::uuid and deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async bidangAda(tx, bumnId, bidangId) {
      // SCOPED BY bumn_id, which the foreign key on nonpumk_proposal is not:
      // `bidang_non_pumk_kode_uq` is on (bumn_id, kode), so Postgres would
      // happily accept another tenant's bidang id. This is a rule only the
      // module can enforce, and it is invisible until two BUMN share an
      // installation.
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from bidang_non_pumk
          where id = $1::uuid and bumn_id = $2::uuid and deleted_at is null`,
        [bidangId, bumnId],
      );
      return r.length > 0;
    },

    async sdgYangAda(tx, ids) {
      const params: unknown[] = [];
      const daftar = daftarPlaceholder(ids, params);
      if (!daftar) return [];
      const r = await tx.query<{ id: string }>(
        `select id::text as id from sdg where id in (${daftar}) and deleted_at is null`,
        params,
      );
      return r.map((x) => x.id);
    },

    async buatProposal(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into nonpumk_proposal
           (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, nama_pemohon, atas_nama,
            alamat, kelurahan, kecamatan, kota_id, telepon, email, bidang_id, judul_program,
            deskripsi_program, jumlah_diajukan, penerima_manfaat_estimasi, sumber_pengajuan,
            portal_submission_id, status, current_step, created_by, updated_by)
         values ($1::uuid, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10::uuid, $11, $12,
                 $13::uuid, $14, $15, $16::numeric, $17, $18, $19::uuid, 'DRAFT', $20, $21::uuid, $21::uuid)
         returning id::text as id`,
        [
          input.cabangId,
          input.noProposal,
          input.tanggalProposal,
          input.tanggalDaftar,
          input.namaPemohon,
          input.atasNama,
          input.alamat,
          input.kelurahan,
          input.kecamatan,
          input.kotaId,
          input.telepon,
          input.email,
          input.bidangId,
          input.judulProgram,
          input.deskripsiProgram,
          input.jumlahDiajukan,
          input.penerimaManfaatEstimasi,
          input.sumberPengajuan,
          input.portalSubmissionId,
          input.currentStep,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async tambahSdg(tx, input) {
      await tx.query(
        `insert into nonpumk_proposal_sdg (proposal_id, sdg_id, bobot, created_by)
         values ($1::uuid, $2::uuid, $3::numeric, $4::uuid)`,
        [input.proposalId, input.sdgId, input.bobot, input.userId],
      );
    },

    async proposal(tx, id) {
      const r = await tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from nonpumk_proposal p join cabang c on c.id = p.cabang_id
          where p.id = $1::uuid and p.deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async proposalUntukDiubah(tx, id) {
      // FOR UPDATE on the proposal is the serialisation point of a transition
      // AND of the staged-disbursement guard: two termin racing on one proposal
      // must not both read the same running total. `of p` keeps the lock off
      // `cabang`.
      const r = await tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from nonpumk_proposal p join cabang c on c.id = p.cabang_id
          where p.id = $1::uuid and p.deleted_at is null
          for update of p`,
        [id],
      );
      return r[0] ?? null;
    },

    async daftarProposal(tx, filter) {
      const params: unknown[] = [];
      const cabang = daftarPlaceholder(filter.cabangIds, params);
      // A user with no branch in scope sees nothing. Returning early rather
      // than emitting `in ()` keeps the refusal a fact about the data instead
      // of a syntax error.
      if (!cabang) return [];

      const syarat = [`p.deleted_at is null`, `p.cabang_id in (${cabang})`];
      if (filter.bidangId) {
        params.push(filter.bidangId);
        syarat.push(`p.bidang_id = $${params.length}::uuid`);
      }
      if (filter.status) {
        params.push(filter.status);
        syarat.push(`p.status = $${params.length}`);
      }
      if (filter.sumberPengajuan) {
        params.push(filter.sumberPengajuan);
        syarat.push(`p.sumber_pengajuan = $${params.length}`);
      }
      if (filter.dariTanggal) {
        params.push(filter.dariTanggal);
        syarat.push(`p.tanggal_proposal >= $${params.length}::date`);
      }
      if (filter.sampaiTanggal) {
        params.push(filter.sampaiTanggal);
        syarat.push(`p.tanggal_proposal <= $${params.length}::date`);
      }
      if (filter.cari) {
        params.push(`%${filter.cari}%`);
        syarat.push(
          `(p.nama_pemohon ilike $${params.length} or p.judul_program ilike $${params.length})`,
        );
      }
      if (filter.sdgId) {
        params.push(filter.sdgId);
        // EXISTS rather than a join: a proposal mapped to several SDG must
        // appear once, and a join would multiply it by its mapping count and
        // silently inflate every count built on this list.
        syarat.push(
          `exists (select 1 from nonpumk_proposal_sdg s
                    where s.proposal_id = p.id and s.sdg_id = $${params.length}::uuid)`,
        );
      }

      return tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from nonpumk_proposal p join cabang c on c.id = p.cabang_id
          where ${syarat.join(" and ")}
          order by p.tanggal_proposal desc, p.no_proposal desc`,
        params,
      );
    },

    async setStatusProposal(tx, input) {
      await tx.query(
        `update nonpumk_proposal
            set status = $2, current_step = $3, updated_by = $4::uuid
          where id = $1::uuid`,
        [input.id, input.status, input.currentStep, input.userId],
      );
    },

    async setJumlahDisetujui(tx, input) {
      await tx.query(
        `update nonpumk_proposal
            set jumlah_disetujui = $2::numeric, updated_by = $3::uuid
          where id = $1::uuid`,
        [input.id, input.jumlahDisetujui, input.userId],
      );
    },

    async transisiTerakhir(tx, proposalId) {
      const r = await tx.query<{ waktu: string | null }>(
        `select to_char(max(waktu) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as waktu
           from nonpumk_proposal_transisi where proposal_id = $1::uuid`,
        [proposalId],
      );
      return r[0]?.waktu ?? null;
    },

    async catatTransisi(tx, input) {
      await tx.query(
        `insert into nonpumk_proposal_transisi
           (proposal_id, status_dari, status_ke, aksi, oleh_user_id, waktu, catatan)
         values ($1::uuid, $2, $3, $4, $5::uuid, $6::timestamptz, $7)`,
        [
          input.proposalId,
          input.dari,
          input.ke,
          input.aksi,
          input.userId,
          input.waktu,
          input.catatan,
        ],
      );
    },

    async timeline(tx, proposalId) {
      // ORDER BY IS QUALIFIED (`t.waktu`) ON PURPOSE. A bare `waktu` would bind
      // to the OUTPUT ALIAS, which is a rendered string, so the timeline would
      // be ordered by text under the database's collation rather than by
      // instant. `t.id` breaks a tie deterministically.
      return tx.query<TransisiBaris>(
        `select t.status_dari, t.status_ke, t.aksi, t.oleh_user_id::text as oleh_user_id,
                ${KOLOM_WAKTU}, t.catatan
           from nonpumk_proposal_transisi t
          where t.proposal_id = $1::uuid
          order by t.waktu, t.id`,
        [proposalId],
      );
    },

    async sdgProposal(tx, proposalId) {
      return tx.query<SdgBaris>(
        `select s.sdg_id::text as sdg_id, g.nomor, g.nama, s.bobot::text as bobot
           from nonpumk_proposal_sdg s join sdg g on g.id = s.sdg_id
          where s.proposal_id = $1::uuid
          order by g.nomor`,
        [proposalId],
      );
    },

    async simpanPenilaian(tx, input) {
      // ONE live assessment per proposal (nonpumk_penilaian_proposal_uq), so a
      // proposal sent back by MINTA_PERBAIKAN and reassessed UPDATES this row.
      // A second insert would raise 23505 and the caller would see a constraint
      // name; silently dropping the correction would leave the checker looking
      // at the score they already rejected. `created_by` is deliberately NOT
      // touched on the update: the first assessor stays on the record.
      //
      // The conflict target repeats the INDEX PREDICATE (`where deleted_at is
      // null`), because the index is partial and Postgres will not infer a
      // partial index without it.
      await tx.query(
        `insert into nonpumk_penilaian
           (proposal_id, tanggal, petugas_karyawan_id, hasil_json, skor_total,
            nilai_rekomendasi, catatan, lampiran_json, created_by, updated_by)
         values ($1::uuid, $2::date, $3::uuid, $4::text::jsonb, $5::numeric, $6::numeric,
                 $7, $8::text::jsonb, $9::uuid, $9::uuid)
         on conflict (proposal_id) where deleted_at is null do update
            set tanggal = excluded.tanggal,
                petugas_karyawan_id = excluded.petugas_karyawan_id,
                hasil_json = excluded.hasil_json,
                skor_total = excluded.skor_total,
                nilai_rekomendasi = excluded.nilai_rekomendasi,
                catatan = excluded.catatan,
                lampiran_json = excluded.lampiran_json,
                updated_by = excluded.updated_by`,
        [
          input.proposalId,
          input.tanggal,
          input.petugasKaryawanId,
          input.hasilJson,
          input.skorTotal,
          input.nilaiRekomendasi,
          input.catatan,
          input.lampiranJson,
          input.userId,
        ],
      );
    },

    async penilaian(tx, proposalId) {
      const r = await tx.query<PenilaianBaris>(
        `select id::text as id, proposal_id::text as proposal_id, tanggal::text as tanggal,
                petugas_karyawan_id::text as petugas_karyawan_id,
                skor_total::text as skor_total,
                nilai_rekomendasi::text as nilai_rekomendasi, catatan
           from nonpumk_penilaian
          where proposal_id = $1::uuid and deleted_at is null`,
        [proposalId],
      );
      return r[0] ?? null;
    },

    async buatReview(tx, input) {
      await tx.query(
        `insert into nonpumk_review
           (proposal_id, reviewer_user_id, tanggal, keputusan, catatan, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4, $5, $2::uuid, $2::uuid)`,
        [input.proposalId, input.reviewerUserId, input.tanggal, input.keputusan, input.catatan],
      );
    },

    async sudahMereview(tx, proposalId, userId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from nonpumk_review
          where proposal_id = $1::uuid and reviewer_user_id = $2::uuid and deleted_at is null`,
        [proposalId, userId],
      );
      return r.length > 0;
    },

    async buatApproval(tx, input) {
      await tx.query(
        `insert into nonpumk_approval
           (proposal_id, approver_user_id, tanggal, keputusan, jumlah_disetujui, catatan,
            created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4, $5::numeric, $6, $2::uuid, $2::uuid)`,
        [
          input.proposalId,
          input.approverUserId,
          input.tanggal,
          input.keputusan,
          input.jumlahDisetujui,
          input.catatan,
        ],
      );
    },

    async akun(tx, akunId) {
      const r = await tx.query<AkunBaris>(
        `select id::text as id, aktif, is_postable, is_kas, tipe, bumn_id::text as bumn_id
           from akun where id = $1::uuid and deleted_at is null`,
        [akunId],
      );
      return r[0] ?? null;
    },

    async totalPenyaluran(tx, proposalId) {
      // Driver fact 4: cast to numeric(20,2) BEFORE text, so an empty set
      // answers '0.00' rather than '0'.
      const r = await tx.query<{ total: string }>(
        `select coalesce(sum(jumlah), 0)::numeric(20,2)::text as total
           from nonpumk_penyaluran
          where proposal_id = $1::uuid and deleted_at is null`,
        [proposalId],
      );
      return r[0]?.total ?? "0.00";
    },

    async terminBerikutnya(tx, proposalId) {
      const r = await tx.query<{ termin: number }>(
        `select coalesce(max(termin), 0) + 1 as termin
           from nonpumk_penyaluran
          where proposal_id = $1::uuid and deleted_at is null`,
        [proposalId],
      );
      return Number(r[0]?.termin ?? 1);
    },

    async buatPenyaluran(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into nonpumk_penyaluran
           (proposal_id, termin, tanggal_penyaluran, jumlah, akun_kas_id, akun_beban_id,
            no_bukti, keterangan, created_by, updated_by)
         values ($1::uuid, $2, $3::date, $4::numeric, $5::uuid, $6::uuid, $7, $8,
                 $9::uuid, $9::uuid)
         returning id::text as id`,
        [
          input.proposalId,
          input.termin,
          input.tanggalPenyaluran,
          input.jumlah,
          input.akunKasId,
          input.akunBebanId,
          input.noBukti,
          input.keterangan,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async setJurnalPenyaluran(tx, id, jurnalId, userId) {
      await tx.query(
        `update nonpumk_penyaluran set jurnal_id = $2::uuid, updated_by = $3::uuid where id = $1::uuid`,
        [id, jurnalId, userId],
      );
    },

    async penyaluran(tx, id) {
      const r = await tx.query<PenyaluranBaris>(
        `select ${KOLOM_PENYALURAN} from nonpumk_penyaluran s
          where s.id = $1::uuid and s.deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async daftarPenyaluran(tx, proposalId) {
      return tx.query<PenyaluranBaris>(
        `select ${KOLOM_PENYALURAN} from nonpumk_penyaluran s
          where s.proposal_id = $1::uuid and s.deleted_at is null
          order by s.termin`,
        [proposalId],
      );
    },

    async akunBebanTerakhir(tx, proposalId) {
      const r = await tx.query<{ akun_beban_id: string }>(
        `select akun_beban_id::text as akun_beban_id
           from nonpumk_penyaluran
          where proposal_id = $1::uuid and deleted_at is null
          order by termin desc
          limit 1`,
        [proposalId],
      );
      return r[0]?.akun_beban_id ?? null;
    },

    async lpj(tx, proposalId) {
      const r = await tx.query<LpjBaris>(
        `select ${KOLOM_LPJ} from nonpumk_lpj l
          where l.proposal_id = $1::uuid and l.deleted_at is null`,
        [proposalId],
      );
      return r[0] ?? null;
    },

    async simpanLpj(tx, input) {
      // ONE live LPJ per proposal (nonpumk_lpj_proposal_uq), so a resubmission
      // after LPJ_DITOLAK UPDATES this row rather than inserting a second one.
      // `verified_by` / `verified_at` / `jurnal_id_pengembalian` are cleared on
      // the way back to DIAJUKAN: a rejected report that kept a verifier's
      // stamp would read as accepted on every screen that shows one.
      const r = await tx.query<{ id: string }>(
        `insert into nonpumk_lpj
           (proposal_id, tanggal_lpj, jumlah_realisasi, jumlah_sisa_dikembalikan,
            penerima_manfaat_aktual, uraian_realisasi, status, lampiran_json,
            created_by, updated_by)
         values ($1::uuid, $2::date, $3::numeric, $4::numeric, $5, $6, 'DIAJUKAN',
                 $7::text::jsonb, $8::uuid, $8::uuid)
         on conflict (proposal_id) where deleted_at is null do update
            set tanggal_lpj = excluded.tanggal_lpj,
                jumlah_realisasi = excluded.jumlah_realisasi,
                jumlah_sisa_dikembalikan = excluded.jumlah_sisa_dikembalikan,
                penerima_manfaat_aktual = excluded.penerima_manfaat_aktual,
                uraian_realisasi = excluded.uraian_realisasi,
                status = 'DIAJUKAN',
                lampiran_json = excluded.lampiran_json,
                verified_by = null,
                verified_at = null,
                jurnal_id_pengembalian = null,
                updated_by = excluded.updated_by
         returning id::text as id`,
        [
          input.proposalId,
          input.tanggalLpj,
          input.jumlahRealisasi,
          input.jumlahSisaDikembalikan,
          input.penerimaManfaatAktual,
          input.uraianRealisasi,
          input.lampiranJson,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async setLpjDiverifikasi(tx, input) {
      await tx.query(
        `update nonpumk_lpj
            set status = 'DIVERIFIKASI', verified_by = $2::uuid, verified_at = $3::timestamptz,
                updated_by = $2::uuid
          where id = $1::uuid`,
        [input.id, input.verifiedBy, input.verifiedAt],
      );
    },

    async setLpjDitolak(tx, input) {
      await tx.query(
        `update nonpumk_lpj
            set status = 'DITOLAK', verified_by = null, verified_at = null, updated_by = $2::uuid
          where id = $1::uuid`,
        [input.id, input.userId],
      );
    },

    async setJurnalPengembalian(tx, id, jurnalId, userId) {
      await tx.query(
        `update nonpumk_lpj
            set jurnal_id_pengembalian = $2::uuid, updated_by = $3::uuid
          where id = $1::uuid`,
        [id, jurnalId, userId],
      );
    },

    async efekBukuBesar(tx, proposalId) {
      // A SUBQUERY, not `= ANY($2::uuid[])`: driver fact 2. The journal ids
      // therefore never leave the database. READ ONLY over the ledger, which is
      // what invariant 11 permits outside modules/jurnal.
      const r = await tx.query<{ beban: string; kas: string }>(
        `with j as (
           select s.jurnal_id as id
             from nonpumk_penyaluran s
            where s.proposal_id = $1::uuid and s.jurnal_id is not null and s.deleted_at is null
           union
           select l.jurnal_id_pengembalian as id
             from nonpumk_lpj l
            where l.proposal_id = $1::uuid and l.jurnal_id_pengembalian is not null
              and l.deleted_at is null
         )
         select coalesce(sum(case when a.tipe = 'BEBAN' then b.debit - b.kredit else 0 end), 0)
                  ::numeric(20,2)::text as beban,
                coalesce(sum(case when a.is_kas then b.debit - b.kredit else 0 end), 0)
                  ::numeric(20,2)::text as kas
           from jurnal_baris b
           join jurnal jr on jr.id = b.jurnal_id
           join akun a on a.id = b.akun_id
          where b.jurnal_id in (select id from j)
            and jr.status = 'POSTED' and jr.deleted_at is null and b.deleted_at is null`,
        [proposalId],
      );
      return { beban: r[0]?.beban ?? "0.00", kas: r[0]?.kas ?? "0.00" };
    },

    async monitoring(tx, input) {
      const params: unknown[] = [];
      const cabang = daftarPlaceholder(input.cabangIds, params);
      if (!cabang) return [];
      // `status` values are enum-like TEXT, so they take no cast at all.
      const status = daftarPlaceholder(input.status.map(String), params, "");
      if (!status) return [];

      const syarat = [
        `p.deleted_at is null`,
        `p.cabang_id in (${cabang})`,
        `p.status in (${status})`,
      ];
      if (input.bidangId) {
        params.push(input.bidangId);
        syarat.push(`p.bidang_id = $${params.length}::uuid`);
      }

      // INNER JOIN on the aggregate, so a proposal that has disbursed nothing
      // is absent rather than present with a null age: a monitoring row whose
      // age is unknown is how a monitoring list stops being trusted.
      return tx.query<MonitoringBaris>(
        `select p.id::text as proposal_id, p.no_proposal, p.cabang_id::text as cabang_id,
                p.bidang_id::text as bidang_id, p.nama_pemohon, p.judul_program, p.status,
                s.total::text as total_disalurkan,
                s.terakhir::text as tanggal_penyaluran_terakhir
           from nonpumk_proposal p
           join (
             select proposal_id,
                    coalesce(sum(jumlah), 0)::numeric(20,2) as total,
                    max(tanggal_penyaluran) as terakhir
               from nonpumk_penyaluran
              where deleted_at is null
              group by proposal_id
           ) s on s.proposal_id = p.id
          where ${syarat.join(" and ")}
          order by s.terakhir asc, p.no_proposal asc`,
        params,
      );
    },
  };
}
