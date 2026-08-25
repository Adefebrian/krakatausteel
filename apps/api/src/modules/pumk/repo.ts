// Every statement the PUMK module issues, in one file. No business rules live
// here; ./service.ts decides, this reads and writes.
//
// WHAT IS DELIBERATELY ABSENT
//   - `jurnal` and `jurnal_baris`. Invariant 11: the ledger is reached only
//     through modules/jurnal, and migrations/0020's posting-path tripwire plus
//     tools/check-boundaries.ts both refuse any other route. The only ledger
//     SQL below is a READ (`saldoNormalAkun`, `rekonsiliasi`), which moves no
//     money and is what the kartu piutang and the write-off split are measured
//     against.
//   - `pumk_jadwal_angsuran` and `pumk_jadwal_versi` writes. Invariant 8: the
//     schedule belongs to modules/angsuran. The reads below are for the
//     disbursement's jasa total and the kartu piutang.
//
// THE DRIVER FACTS THIS FILE IS BUILT AROUND, identical to the ones
// modules/jurnal/repo.ts and modules/angsuran/repo.ts document, because the
// same Bun Postgres client is underneath:
//
//  1. DATE and TIMESTAMPTZ come back as a JS `Date` while NUMERIC comes back as
//     a string, so every date column is selected `::text`. A `Date` here would
//     turn '2026-03-10' into '2026-03-09T17:00:00.000Z' on a schedule table.
//  2. A JS array is serialised as a bare comma-joined string, which `text[]`
//     and `uuid[]` reject with 22P02 "malformed array literal". Nothing below
//     binds an array; the branch-scope filter expands to one placeholder per
//     branch instead of `= ANY($n::text[])`.
//  3. A `jsonb` parameter bound from a JS string is stored as a JSON STRING
//     SCALAR, so `hasil_json` and `lampiran_json` are written `$n::text::jsonb`
//     and read back `::text`.
import type { PumkTx } from "./contract";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ProposalBaris {
  id: string;
  cabang_id: string;
  no_proposal: string;
  tanggal_proposal: string;
  mitra_id: string;
  sektor_id: string | null;
  jumlah_diajukan: string;
  tenor_diajukan: number;
  tujuan_penggunaan: string | null;
  sumber_pengajuan: string;
  portal_submission_id: string | null;
  status: string;
  current_step: number;
  created_by: string | null;
  bumn_id: string;
}

export interface AkadBaris {
  id: string;
  proposal_id: string;
  mitra_id: string;
  cabang_id: string;
  no_akad: string;
  tanggal_akad: string;
  pokok_pinjaman: string;
  jasa_adm_rate: string;
  metode_perhitungan: string;
  tenor_bulan: number;
  grace_period_bulan: number;
  tanggal_mulai_angsuran: string;
  tanggal_jatuh_tempo_akhir: string;
  status: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
  tanggal_lunas: string | null;
  bumn_id: string;
}

export interface TransisiBaris {
  status_dari: string | null;
  status_ke: string;
  aksi: string;
  oleh_user_id: string | null;
  waktu: string;
  catatan: string | null;
}

export interface ApprovalBaris {
  id: string;
  approver_user_id: string;
  keputusan: string;
  plafon_disetujui: string | null;
  tenor_disetujui: number | null;
  jasa_adm_rate: string | null;
}

export interface AkunBaris {
  id: string;
  aktif: boolean;
  is_postable: boolean;
  is_kas: boolean;
  bumn_id: string;
}

export interface MitraBaris {
  id: string;
  cabang_id: string;
  kode_mitra: string;
  nama_lengkap: string;
  status: string;
  cluster_id: string | null;
}

export interface SubmissionBaris {
  id: string;
  bumn_id: string;
  jenis: string;
  status: string;
  converted_proposal_id: string | null;
  data_json: string;
}

export interface AnggotaBaris {
  cluster_id: string;
  mitra_id: string;
  tanggal_masuk: string;
  tanggal_keluar: string | null;
  alasan_keluar: string | null;
}

export interface TindakLanjutBaris {
  id: string;
  akad_id: string;
  tanggal: string;
  jenis: string;
  hasil: string | null;
  petugas_karyawan_id: string | null;
  catatan: string | null;
}

export interface PengakhiranBaris {
  id: string;
  akad_id: string;
  jenis: string;
  tanggal: string;
  outstanding_pokok_saat_itu: string;
  outstanding_jasa_saat_itu: string;
  no_sk: string | null;
  jurnal_id: string | null;
}

export interface SetoranBaris {
  id: string;
  tanggal_terima: string;
  jumlah_diterima: string;
  alokasi_pokok: string;
  alokasi_jasa: string;
  alokasi_kelebihan: string;
  jurnal_id: string | null;
}

export interface KelebihanBaris {
  id: string;
  tanggal: string;
  jumlah: string;
  status: string;
}

export interface KolektibilitasBaris {
  periode_id: string;
  kelas: string;
  hari_tunggakan: number;
}

export interface FilterDaftar {
  cabangIds: readonly string[];
  sektorId?: string | null;
  status?: string | null;
  sumberPengajuan?: string | null;
  dariTanggal?: string | null;
  sampaiTanggal?: string | null;
  cari?: string | null;
}

const KOLOM_PROPOSAL = `p.id::text as id, p.cabang_id::text as cabang_id, p.no_proposal,
  p.tanggal_proposal::text as tanggal_proposal, p.mitra_id::text as mitra_id,
  p.sektor_id::text as sektor_id, p.jumlah_diajukan::text as jumlah_diajukan,
  p.tenor_diajukan, p.tujuan_penggunaan, p.sumber_pengajuan,
  p.portal_submission_id::text as portal_submission_id, p.status, p.current_step,
  p.created_by::text as created_by, c.bumn_id::text as bumn_id`;

const KOLOM_AKAD = `a.id::text as id, a.proposal_id::text as proposal_id, a.mitra_id::text as mitra_id,
  a.cabang_id::text as cabang_id, a.no_akad, a.tanggal_akad::text as tanggal_akad,
  a.pokok_pinjaman::text as pokok_pinjaman, a.jasa_adm_rate::text as jasa_adm_rate,
  a.metode_perhitungan, a.tenor_bulan, a.grace_period_bulan,
  a.tanggal_mulai_angsuran::text as tanggal_mulai_angsuran,
  a.tanggal_jatuh_tempo_akhir::text as tanggal_jatuh_tempo_akhir, a.status,
  a.outstanding_pokok::text as outstanding_pokok, a.outstanding_jasa::text as outstanding_jasa,
  a.tanggal_lunas::text as tanggal_lunas, c.bumn_id::text as bumn_id`;

export interface PumkRepo {
  konfigurasi(tx: PumkTx, bumnId: string, grup: string, kunci: string): Promise<string | null>;
  cabang(tx: PumkTx, id: string): Promise<{ kode: string; bumn_id: string } | null>;

  proposal(tx: PumkTx, id: string): Promise<ProposalBaris | null>;
  proposalUntukDiubah(tx: PumkTx, id: string): Promise<ProposalBaris | null>;
  proposalDariAkad(tx: PumkTx, akadId: string): Promise<ProposalBaris | null>;
  daftarProposal(tx: PumkTx, filter: FilterDaftar): Promise<ProposalBaris[]>;
  buatProposal(
    tx: PumkTx,
    input: {
      cabangId: string;
      noProposal: string;
      tanggalProposal: string;
      tanggalDaftar: string | null;
      mitraId: string;
      sektorId: string | null;
      jumlahDiajukan: string;
      tenorDiajukan: number;
      tujuanPenggunaan: string | null;
      sumberPengajuan: string;
      portalSubmissionId: string | null;
      userId: string;
    },
  ): Promise<string>;
  setStatusProposal(
    tx: PumkTx,
    input: { id: string; status: string; currentStep: number; userId: string },
  ): Promise<void>;

  transisiTerakhir(tx: PumkTx, proposalId: string): Promise<string | null>;
  catatTransisi(
    tx: PumkTx,
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
  timeline(tx: PumkTx, proposalId: string): Promise<TransisiBaris[]>;

  mitra(tx: PumkTx, id: string): Promise<MitraBaris | null>;
  sektorAda(tx: PumkTx, bumnId: string, id: string): Promise<boolean>;
  setStatusMitra(tx: PumkTx, id: string, status: string, userId: string): Promise<void>;
  setClusterMitra(tx: PumkTx, id: string, clusterId: string | null, userId: string): Promise<void>;
  /** Akad rows that still count as a live loan (pumk_akad_satu_aktif_per_mitra_uq). */
  jumlahPinjamanAktif(tx: PumkTx, mitraId: string): Promise<number>;

  surveyAda(tx: PumkTx, proposalId: string): Promise<boolean>;
  skorSurvey(tx: PumkTx, proposalId: string): Promise<string | null>;
  buatSurvey(
    tx: PumkTx,
    input: {
      proposalId: string;
      tanggalSurvey: string;
      petugasKaryawanId: string | null;
      hasilJson: string;
      skorTotal: string;
      plafonRekomendasi: string;
      tenorRekomendasi: number;
      catatan: string | null;
      lampiranJson: string;
      userId: string;
    },
  ): Promise<string>;

  buatJaminan(
    tx: PumkTx,
    input: {
      proposalId: string;
      jenis: string;
      deskripsi: string | null;
      nilaiTaksasi: string | null;
      nomorDokumen: string | null;
      atasNama: string | null;
      lokasi: string | null;
      tanggalTerima: string | null;
      userId: string;
    },
  ): Promise<string>;
  adaJaminanRiil(tx: PumkTx, proposalId: string): Promise<boolean>;

  buatReview(
    tx: PumkTx,
    input: {
      proposalId: string;
      reviewerUserId: string;
      tanggal: string;
      keputusan: string;
      catatan: string | null;
    },
  ): Promise<string>;
  /** Spec 2 rule 2, checked ahead of trg_pumk_approval_10_sod. */
  sudahMereview(tx: PumkTx, proposalId: string, userId: string): Promise<boolean>;

  buatApproval(
    tx: PumkTx,
    input: {
      proposalId: string;
      approverUserId: string;
      tanggal: string;
      keputusan: string;
      plafonDisetujui: string | null;
      tenorDisetujui: number | null;
      jasaAdmRate: string | null;
      catatan: string | null;
    },
  ): Promise<string>;
  approvalDisetujui(tx: PumkTx, proposalId: string): Promise<ApprovalBaris | null>;

  akad(tx: PumkTx, id: string): Promise<AkadBaris | null>;
  akadDariReschedule(tx: PumkTx, rescheduleId: string): Promise<AkadBaris | null>;
  akadDariProposal(tx: PumkTx, proposalId: string): Promise<AkadBaris | null>;
  buatAkad(
    tx: PumkTx,
    input: {
      proposalId: string;
      mitraId: string;
      cabangId: string;
      noAkad: string;
      tanggalAkad: string;
      pokokPinjaman: string;
      jasaAdmRate: string;
      metodePerhitungan: string;
      tenorBulan: number;
      gracePeriodBulan: number;
      tanggalMulaiAngsuran: string;
      tanggalJatuhTempoAkhir: string;
      pathDokumenAkad: string | null;
      userId: string;
    },
  ): Promise<string>;
  setAkadCair(
    tx: PumkTx,
    input: {
      akadId: string;
      outstandingPokok: string;
      outstandingJasa: string;
      userId: string;
    },
  ): Promise<void>;
  setAkadHapusBuku(tx: PumkTx, akadId: string, userId: string): Promise<void>;
  setTenorAkad(
    tx: PumkTx,
    input: {
      akadId: string;
      tenorBulan: number;
      gracePeriodBulan: number;
      tanggalJatuhTempoAkhir: string;
      userId: string;
    },
  ): Promise<void>;

  adaVersiJadwal(tx: PumkTx, akadId: string): Promise<boolean>;
  totalJasaAktif(tx: PumkTx, akadId: string): Promise<string>;

  akun(tx: PumkTx, akunId: string): Promise<AkunBaris | null>;

  pencairanAda(tx: PumkTx, akadId: string): Promise<boolean>;
  buatPencairan(
    tx: PumkTx,
    input: {
      akadId: string;
      tanggalPencairan: string;
      jumlah: string;
      akunKasId: string;
      noBukti: string | null;
      keterangan: string | null;
      userId: string;
    },
  ): Promise<string>;
  setJurnalPencairan(tx: PumkTx, id: string, jurnalId: string): Promise<void>;

  pengakhiranAda(tx: PumkTx, akadId: string): Promise<boolean>;
  buatPengakhiran(
    tx: PumkTx,
    input: {
      akadId: string;
      jenis: string;
      tanggal: string;
      outstandingPokok: string;
      outstandingJasa: string;
      dasarKeputusan: string;
      noSk: string | null;
      userId: string;
      waktu: string;
    },
  ): Promise<string>;
  setJurnalPengakhiran(tx: PumkTx, id: string, jurnalId: string): Promise<void>;
  pengakhiran(tx: PumkTx, id: string): Promise<PengakhiranBaris | null>;

  buatTindakLanjut(
    tx: PumkTx,
    input: {
      akadId: string;
      tanggal: string;
      jenis: string;
      hasil: string | null;
      petugasKaryawanId: string | null;
      catatan: string | null;
      lampiranJson: string;
      userId: string;
    },
  ): Promise<string>;
  daftarTindakLanjut(tx: PumkTx, akadId: string): Promise<TindakLanjutBaris[]>;

  clusterCabang(tx: PumkTx, clusterId: string): Promise<string | null>;
  keanggotaanAktif(tx: PumkTx, mitraId: string): Promise<AnggotaBaris | null>;
  buatAnggotaCluster(
    tx: PumkTx,
    input: { clusterId: string; mitraId: string; tanggalMasuk: string; userId: string },
  ): Promise<AnggotaBaris>;
  tutupAnggotaCluster(
    tx: PumkTx,
    input: {
      clusterId: string;
      mitraId: string;
      tanggalKeluar: string;
      alasan: string;
      userId: string;
    },
  ): Promise<AnggotaBaris | null>;
  daftarAnggotaCluster(
    tx: PumkTx,
    clusterId: string,
    padaTanggal: string | null,
  ): Promise<AnggotaBaris[]>;

  setoran(tx: PumkTx, akadId: string): Promise<SetoranBaris[]>;
  kelebihan(tx: PumkTx, akadId: string): Promise<KelebihanBaris[]>;
  riwayatKolektibilitas(tx: PumkTx, akadId: string): Promise<KolektibilitasBaris[]>;
  /** Spec 8.4 check 10, read from the shipped view rather than recomputed. */
  rekonsiliasi(tx: PumkTx, akadId: string): Promise<{ buku_besar: string; selisih: string } | null>;

  submission(tx: PumkTx, id: string): Promise<SubmissionBaris | null>;
  tandaiSubmissionDikonversi(
    tx: PumkTx,
    input: { id: string; proposalId: string; catatan: string | null; userId: string },
  ): Promise<number>;

  /** The account whose balance a write-off may consume, from the mapping row. */
  akunPenyisihan(tx: PumkTx, bumnId: string, eventCode: string): Promise<string | null>;
  /** Normal-side balance of one account at a date, over the canonical ledger. */
  saldoNormalAkun(tx: PumkTx, bumnId: string, akunId: string, tanggal: string): Promise<string>;
}

export function createPumkRepo(): PumkRepo {
  return {
    async konfigurasi(tx, bumnId, grup, kunci) {
      // A bumn-scoped row overrides the shipped default (bumn_id IS NULL),
      // exactly how modules/konfigurasi resolves a parameter and exactly how
      // modules/angsuran reads one. Read fresh on every call so an
      // accountant's edit takes effect without a deploy.
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

    async proposal(tx, id) {
      const r = await tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from pumk_proposal p join cabang c on c.id = p.cabang_id
          where p.id = $1::uuid and p.deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async proposalUntukDiubah(tx, id) {
      // FOR UPDATE on the proposal is the serialisation point of a transition:
      // two approvals racing on one proposal must not both read
      // MENUNGGU_PERSETUJUAN. `of p` keeps the lock off `cabang`.
      const r = await tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from pumk_proposal p join cabang c on c.id = p.cabang_id
          where p.id = $1::uuid and p.deleted_at is null
          for update of p`,
        [id],
      );
      return r[0] ?? null;
    },

    async proposalDariAkad(tx, akadId) {
      const r = await tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from pumk_akad a
           join pumk_proposal p on p.id = a.proposal_id
           join cabang c on c.id = p.cabang_id
          where a.id = $1::uuid and a.deleted_at is null and p.deleted_at is null`,
        [akadId],
      );
      return r[0] ?? null;
    },

    async daftarProposal(tx, filter) {
      const params: unknown[] = [];
      const syarat: string[] = ["p.deleted_at is null"];

      // Driver fact 2: no array binding. One placeholder per branch, so the
      // scope list cannot become '22P02 malformed array literal' in a screen
      // an operator uses every day.
      if (filter.cabangIds.length === 0) return [];
      const kolomCabang = filter.cabangIds.map((id) => {
        params.push(id);
        return `$${params.length}::uuid`;
      });
      syarat.push(`p.cabang_id in (${kolomCabang.join(", ")})`);

      if (filter.sektorId) {
        params.push(filter.sektorId);
        syarat.push(`p.sektor_id = $${params.length}::uuid`);
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
        params.push(`%${filter.cari.toLowerCase()}%`);
        syarat.push(
          `(lower(m.nama_lengkap) like $${params.length} or lower(coalesce(m.nik, '')) like $${params.length})`,
        );
      }

      return tx.query<ProposalBaris>(
        `select ${KOLOM_PROPOSAL}
           from pumk_proposal p
           join cabang c on c.id = p.cabang_id
           join mitra m on m.id = p.mitra_id
          where ${syarat.join(" and ")}
          order by p.tanggal_proposal desc, p.created_at desc`,
        params,
      );
    },

    async buatProposal(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_proposal
           (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, mitra_id, sektor_id,
            jumlah_diajukan, tenor_diajukan, tujuan_penggunaan, sumber_pengajuan,
            portal_submission_id, status, current_step, created_by, updated_by)
         values ($1::uuid, $2, $3::date, $4::date, $5::uuid, $6::uuid, $7::numeric, $8, $9,
                 $10, $11::uuid, 'DRAFT', 1, $12::uuid, $12::uuid)
         returning id::text as id`,
        [
          input.cabangId,
          input.noProposal,
          input.tanggalProposal,
          input.tanggalDaftar,
          input.mitraId,
          input.sektorId,
          input.jumlahDiajukan,
          input.tenorDiajukan,
          input.tujuanPenggunaan,
          input.sumberPengajuan,
          input.portalSubmissionId,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async setStatusProposal(tx, input) {
      await tx.query(
        `update pumk_proposal
            set status = $2, current_step = $3, updated_by = $4::uuid, updated_at = now()
          where id = $1::uuid`,
        [input.id, input.status, input.currentStep, input.userId],
      );
    },

    async transisiTerakhir(tx, proposalId) {
      const r = await tx.query<{ waktu: string | null }>(
        `select max(waktu)::text as waktu from pumk_proposal_transisi where proposal_id = $1::uuid`,
        [proposalId],
      );
      return r[0]?.waktu ?? null;
    },

    async catatTransisi(tx, input) {
      await tx.query(
        `insert into pumk_proposal_transisi
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
      // to the OUTPUT ALIAS, which is `waktu::text`, so the timeline would be
      // sorted as a STRING under the database collation instead of as an
      // instant. That is a real reordering, not a theoretical one: under a
      // non-C collation '11:00:00.001+07' sorts before '11:00:00+07'.
      return tx.query<TransisiBaris>(
        `select t.status_dari, t.status_ke, t.aksi, t.oleh_user_id::text as oleh_user_id,
                t.waktu::text as waktu, t.catatan
           from pumk_proposal_transisi t
          where t.proposal_id = $1::uuid
          order by t.waktu, t.aksi`,
        [proposalId],
      );
    },

    async mitra(tx, id) {
      const r = await tx.query<MitraBaris>(
        `select id::text as id, cabang_id::text as cabang_id, kode_mitra, nama_lengkap, status,
                cluster_id::text as cluster_id
           from mitra where id = $1::uuid and deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async sektorAda(tx, bumnId, id) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from sektor_pumk
          where id = $1::uuid and bumn_id = $2::uuid and deleted_at is null`,
        [id, bumnId],
      );
      return r.length > 0;
    },

    async setStatusMitra(tx, id, status, userId) {
      await tx.query(
        `update mitra set status = $2, updated_by = $3::uuid, updated_at = now()
          where id = $1::uuid`,
        [id, status, userId],
      );
    },

    async setClusterMitra(tx, id, clusterId, userId) {
      await tx.query(
        `update mitra set cluster_id = $2::uuid, updated_by = $3::uuid, updated_at = now()
          where id = $1::uuid`,
        [id, clusterId, userId],
      );
    },

    async jumlahPinjamanAktif(tx, mitraId) {
      // Mirrors pumk_akad_satu_aktif_per_mitra_uq's predicate exactly, BELUM_CAIR
      // included: a signed but undisbursed akad is already a commitment, and a
      // check that only looked at AKTIF would pass the proposal and then hit the
      // index four screens later.
      const r = await tx.query<{ jumlah: string }>(
        `select count(*)::text as jumlah from pumk_akad
          where mitra_id = $1::uuid and deleted_at is null
            and status in ('BELUM_CAIR', 'AKTIF', 'RESCHEDULED', 'MACET')`,
        [mitraId],
      );
      return Number(r[0]?.jumlah ?? "0");
    },

    async surveyAda(tx, proposalId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from pumk_survey
          where proposal_id = $1::uuid and deleted_at is null`,
        [proposalId],
      );
      return r.length > 0;
    },

    async skorSurvey(tx, proposalId) {
      const r = await tx.query<{ skor: string | null }>(
        `select skor_total::text as skor from pumk_survey
          where proposal_id = $1::uuid and deleted_at is null`,
        [proposalId],
      );
      return r.length === 0 ? null : (r[0].skor ?? null);
    },

    async buatSurvey(tx, input) {
      // Driver fact 3: `$n::text::jsonb`, never a bare `$n::jsonb`, which would
      // store the whole object as a JSON string scalar.
      const r = await tx.query<{ id: string }>(
        `insert into pumk_survey
           (proposal_id, tanggal_survey, petugas_karyawan_id, hasil_json, skor_total,
            plafon_rekomendasi, tenor_rekomendasi, catatan, lampiran_foto_json,
            created_by, updated_by)
         values ($1::uuid, $2::date, $3::uuid, $4::text::jsonb, $5::numeric, $6::numeric, $7,
                 $8, $9::text::jsonb, $10::uuid, $10::uuid)
         returning id::text as id`,
        [
          input.proposalId,
          input.tanggalSurvey,
          input.petugasKaryawanId,
          input.hasilJson,
          input.skorTotal,
          input.plafonRekomendasi,
          input.tenorRekomendasi,
          input.catatan,
          input.lampiranJson,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async buatJaminan(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_jaminan
           (proposal_id, jenis, deskripsi, nilai_taksasi, nomor_dokumen, atas_nama, lokasi,
            status_fisik, tanggal_terima, created_by, updated_by)
         values ($1::uuid, $2, $3, $4::numeric, $5, $6, $7, 'DITERIMA', $8::date,
                 $9::uuid, $9::uuid)
         returning id::text as id`,
        [
          input.proposalId,
          input.jenis,
          input.deskripsi,
          input.nilaiTaksasi,
          input.nomorDokumen,
          input.atasNama,
          input.lokasi,
          input.tanggalTerima,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async adaJaminanRiil(tx, proposalId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from pumk_jaminan
          where proposal_id = $1::uuid and deleted_at is null
            and jenis <> 'TANPA_JAMINAN' and status_fisik = 'DITERIMA'`,
        [proposalId],
      );
      return r.length > 0;
    },

    async buatReview(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_review
           (proposal_id, reviewer_user_id, tanggal, keputusan, catatan, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4, $5, $2::uuid, $2::uuid)
         returning id::text as id`,
        [input.proposalId, input.reviewerUserId, input.tanggal, input.keputusan, input.catatan],
      );
      return r[0].id;
    },

    async sudahMereview(tx, proposalId, userId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from pumk_review
          where proposal_id = $1::uuid and reviewer_user_id = $2::uuid and deleted_at is null`,
        [proposalId, userId],
      );
      return r.length > 0;
    },

    async buatApproval(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_approval
           (proposal_id, approver_user_id, tanggal, keputusan, plafon_disetujui, tenor_disetujui,
            jasa_adm_rate, catatan, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4, $5::numeric, $6, $7::numeric, $8,
                 $2::uuid, $2::uuid)
         returning id::text as id`,
        [
          input.proposalId,
          input.approverUserId,
          input.tanggal,
          input.keputusan,
          input.plafonDisetujui,
          input.tenorDisetujui,
          input.jasaAdmRate,
          input.catatan,
        ],
      );
      return r[0].id;
    },

    async approvalDisetujui(tx, proposalId) {
      const r = await tx.query<ApprovalBaris>(
        `select id::text as id, approver_user_id::text as approver_user_id, keputusan,
                plafon_disetujui::text as plafon_disetujui, tenor_disetujui,
                jasa_adm_rate::text as jasa_adm_rate
           from pumk_approval
          where proposal_id = $1::uuid and keputusan = 'SETUJU' and deleted_at is null
          order by created_at desc
          limit 1`,
        [proposalId],
      );
      return r[0] ?? null;
    },

    async akad(tx, id) {
      const r = await tx.query<AkadBaris>(
        `select ${KOLOM_AKAD}
           from pumk_akad a join cabang c on c.id = a.cabang_id
          where a.id = $1::uuid and a.deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async akadDariReschedule(tx, rescheduleId) {
      const r = await tx.query<AkadBaris>(
        `select ${KOLOM_AKAD}
           from pumk_reschedule r
           join pumk_akad a on a.id = r.akad_id
           join cabang c on c.id = a.cabang_id
          where r.id = $1::uuid and r.deleted_at is null and a.deleted_at is null`,
        [rescheduleId],
      );
      return r[0] ?? null;
    },

    async akadDariProposal(tx, proposalId) {
      const r = await tx.query<AkadBaris>(
        `select ${KOLOM_AKAD}
           from pumk_akad a join cabang c on c.id = a.cabang_id
          where a.proposal_id = $1::uuid and a.deleted_at is null`,
        [proposalId],
      );
      return r[0] ?? null;
    },

    async buatAkad(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_akad
           (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
            jasa_adm_rate, metode_perhitungan, tenor_bulan, grace_period_bulan,
            tanggal_mulai_angsuran, tanggal_jatuh_tempo_akhir, status, path_dokumen_akad,
            created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::numeric, $7::numeric, $8, $9,
                 $10, $11::date, $12::date, 'BELUM_CAIR', $13, $14::uuid, $14::uuid)
         returning id::text as id`,
        [
          input.proposalId,
          input.mitraId,
          input.cabangId,
          input.noAkad,
          input.tanggalAkad,
          input.pokokPinjaman,
          input.jasaAdmRate,
          input.metodePerhitungan,
          input.tenorBulan,
          input.gracePeriodBulan,
          input.tanggalMulaiAngsuran,
          input.tanggalJatuhTempoAkhir,
          input.pathDokumenAkad,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async setAkadCair(tx, input) {
      await tx.query(
        `update pumk_akad
            set status = 'AKTIF', outstanding_pokok = $2::numeric, outstanding_jasa = $3::numeric,
                updated_by = $4::uuid, updated_at = now()
          where id = $1::uuid`,
        [input.akadId, input.outstandingPokok, input.outstandingJasa, input.userId],
      );
    },

    async setAkadHapusBuku(tx, akadId, userId) {
      await tx.query(
        `update pumk_akad
            set status = 'HAPUS_BUKU', outstanding_pokok = 0, outstanding_jasa = 0,
                updated_by = $2::uuid, updated_at = now()
          where id = $1::uuid`,
        [akadId, userId],
      );
    },

    async setTenorAkad(tx, input) {
      await tx.query(
        `update pumk_akad
            set tenor_bulan = $2, grace_period_bulan = $3, tanggal_jatuh_tempo_akhir = $4::date,
                updated_by = $5::uuid, updated_at = now()
          where id = $1::uuid`,
        [
          input.akadId,
          input.tenorBulan,
          input.gracePeriodBulan,
          input.tanggalJatuhTempoAkhir,
          input.userId,
        ],
      );
    },

    async adaVersiJadwal(tx, akadId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from pumk_jadwal_versi
          where akad_id = $1::uuid and is_active_version and deleted_at is null`,
        [akadId],
      );
      return r.length > 0;
    },

    async totalJasaAktif(tx, akadId) {
      const r = await tx.query<{ jasa: string }>(
        `select coalesce(sum(jasa_adm), 0)::numeric(20,2)::text as jasa
           from pumk_jadwal_angsuran
          where akad_id = $1::uuid and is_active_version and deleted_at is null`,
        [akadId],
      );
      return r[0]?.jasa ?? "0.00";
    },

    async akun(tx, akunId) {
      const r = await tx.query<AkunBaris>(
        `select id::text as id, aktif, is_postable, is_kas, bumn_id::text as bumn_id
           from akun where id = $1::uuid and deleted_at is null`,
        [akunId],
      );
      return r[0] ?? null;
    },

    async pencairanAda(tx, akadId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from pumk_pencairan
          where akad_id = $1::uuid and deleted_at is null`,
        [akadId],
      );
      return r.length > 0;
    },

    async buatPencairan(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_pencairan
           (akad_id, tanggal_pencairan, jumlah, akun_kas_id, no_bukti, keterangan,
            created_by, updated_by)
         values ($1::uuid, $2::date, $3::numeric, $4::uuid, $5, $6, $7::uuid, $7::uuid)
         returning id::text as id`,
        [
          input.akadId,
          input.tanggalPencairan,
          input.jumlah,
          input.akunKasId,
          input.noBukti,
          input.keterangan,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async setJurnalPencairan(tx, id, jurnalId) {
      await tx.query(
        `update pumk_pencairan set jurnal_id = $2::uuid, updated_at = now() where id = $1::uuid`,
        [id, jurnalId],
      );
    },

    async pengakhiranAda(tx, akadId) {
      const r = await tx.query<{ ada: boolean }>(
        `select true as ada from pumk_pengakhiran
          where akad_id = $1::uuid and deleted_at is null`,
        [akadId],
      );
      return r.length > 0;
    },

    async buatPengakhiran(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into pumk_pengakhiran
           (akad_id, jenis, tanggal, outstanding_pokok_saat_itu, outstanding_jasa_saat_itu,
            dasar_keputusan, no_sk, approved_by, approved_at, created_by, updated_by)
         values ($1::uuid, $2, $3::date, $4::numeric, $5::numeric, $6, $7, $8::uuid,
                 $9::timestamptz, $8::uuid, $8::uuid)
         returning id::text as id`,
        [
          input.akadId,
          input.jenis,
          input.tanggal,
          input.outstandingPokok,
          input.outstandingJasa,
          input.dasarKeputusan,
          input.noSk,
          input.userId,
          input.waktu,
        ],
      );
      return r[0].id;
    },

    async setJurnalPengakhiran(tx, id, jurnalId) {
      await tx.query(
        `update pumk_pengakhiran set jurnal_id = $2::uuid, updated_at = now() where id = $1::uuid`,
        [id, jurnalId],
      );
    },

    async pengakhiran(tx, id) {
      const r = await tx.query<PengakhiranBaris>(
        `select id::text as id, akad_id::text as akad_id, jenis, tanggal::text as tanggal,
                outstanding_pokok_saat_itu::text as outstanding_pokok_saat_itu,
                outstanding_jasa_saat_itu::text as outstanding_jasa_saat_itu, no_sk,
                jurnal_id::text as jurnal_id
           from pumk_pengakhiran where id = $1::uuid and deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async buatTindakLanjut(tx, input) {
      const r = await tx.query<{ id: string }>(
        `insert into tindak_lanjut_penagihan
           (akad_id, tanggal, jenis, hasil, petugas_karyawan_id, catatan, lampiran_json,
            created_by, updated_by)
         values ($1::uuid, $2::date, $3, $4, $5::uuid, $6, $7::text::jsonb, $8::uuid, $8::uuid)
         returning id::text as id`,
        [
          input.akadId,
          input.tanggal,
          input.jenis,
          input.hasil,
          input.petugasKaryawanId,
          input.catatan,
          input.lampiranJson,
          input.userId,
        ],
      );
      return r[0].id;
    },

    async daftarTindakLanjut(tx, akadId) {
      return tx.query<TindakLanjutBaris>(
        `select id::text as id, akad_id::text as akad_id, tanggal::text as tanggal, jenis, hasil,
                petugas_karyawan_id::text as petugas_karyawan_id, catatan
           from tindak_lanjut_penagihan
          where akad_id = $1::uuid and deleted_at is null
          order by tanggal, created_at`,
        [akadId],
      );
    },

    async clusterCabang(tx, clusterId) {
      const r = await tx.query<{ cabang_id: string }>(
        `select cabang_id::text as cabang_id from cluster
          where id = $1::uuid and deleted_at is null`,
        [clusterId],
      );
      return r[0]?.cabang_id ?? null;
    },

    async keanggotaanAktif(tx, mitraId) {
      const r = await tx.query<AnggotaBaris>(
        `select cluster_id::text as cluster_id, mitra_id::text as mitra_id,
                tanggal_masuk::text as tanggal_masuk, tanggal_keluar::text as tanggal_keluar,
                alasan_keluar
           from cluster_anggota
          where mitra_id = $1::uuid and tanggal_keluar is null and deleted_at is null`,
        [mitraId],
      );
      return r[0] ?? null;
    },

    async buatAnggotaCluster(tx, input) {
      const r = await tx.query<AnggotaBaris>(
        `insert into cluster_anggota
           (cluster_id, mitra_id, tanggal_masuk, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::date, $4::uuid, $4::uuid)
         returning cluster_id::text as cluster_id, mitra_id::text as mitra_id,
                   tanggal_masuk::text as tanggal_masuk,
                   tanggal_keluar::text as tanggal_keluar, alasan_keluar`,
        [input.clusterId, input.mitraId, input.tanggalMasuk, input.userId],
      );
      return r[0];
    },

    async tutupAnggotaCluster(tx, input) {
      const r = await tx.query<AnggotaBaris>(
        `update cluster_anggota
            set tanggal_keluar = $3::date, alasan_keluar = $4,
                updated_by = $5::uuid, updated_at = now()
          where cluster_id = $1::uuid and mitra_id = $2::uuid
            and tanggal_keluar is null and deleted_at is null
        returning cluster_id::text as cluster_id, mitra_id::text as mitra_id,
                  tanggal_masuk::text as tanggal_masuk,
                  tanggal_keluar::text as tanggal_keluar, alasan_keluar`,
        [input.clusterId, input.mitraId, input.tanggalKeluar, input.alasan, input.userId],
      );
      return r[0] ?? null;
    },

    async daftarAnggotaCluster(tx, clusterId, padaTanggal) {
      // Membership as DATED HISTORY: a cluster's past performance has to stay
      // attributable to the members it actually had (invariant 14).
      return tx.query<AnggotaBaris>(
        `select cluster_id::text as cluster_id, mitra_id::text as mitra_id,
                tanggal_masuk::text as tanggal_masuk, tanggal_keluar::text as tanggal_keluar,
                alasan_keluar
           from cluster_anggota
          where cluster_id = $1::uuid and deleted_at is null
            and ($2::date is null
                 or (tanggal_masuk <= $2::date
                     and (tanggal_keluar is null or tanggal_keluar > $2::date)))
          order by tanggal_masuk, created_at`,
        [clusterId, padaTanggal],
      );
    },

    async setoran(tx, akadId) {
      return tx.query<SetoranBaris>(
        `select id::text as id, tanggal_terima::text as tanggal_terima,
                jumlah_diterima::text as jumlah_diterima, alokasi_pokok::text as alokasi_pokok,
                alokasi_jasa::text as alokasi_jasa, alokasi_kelebihan::text as alokasi_kelebihan,
                jurnal_id::text as jurnal_id
           from pumk_angsuran
          where akad_id = $1::uuid and deleted_at is null
          order by tanggal_terima, created_at`,
        [akadId],
      );
    },

    async kelebihan(tx, akadId) {
      return tx.query<KelebihanBaris>(
        `select id::text as id, tanggal::text as tanggal, jumlah::text as jumlah, status
           from pumk_kelebihan
          where akad_id = $1::uuid and deleted_at is null
          order by tanggal, created_at`,
        [akadId],
      );
    },

    async riwayatKolektibilitas(tx, akadId) {
      return tx.query<KolektibilitasBaris>(
        `select s.periode_id::text as periode_id, s.kolektibilitas as kelas, s.hari_tunggakan
           from kolektibilitas_snapshot s
           join periode pr on pr.id = s.periode_id
          where s.akad_id = $1::uuid and s.deleted_at is null
          order by pr.tahun, pr.bulan`,
        [akadId],
      );
    },

    async rekonsiliasi(tx, akadId) {
      const r = await tx.query<{ buku_besar: string; selisih: string }>(
        `select saldo_buku_besar::text as buku_besar, selisih::text as selisih
           from v_rekonsiliasi_piutang where akad_id = $1::uuid`,
        [akadId],
      );
      return r[0] ?? null;
    },

    async submission(tx, id) {
      const r = await tx.query<SubmissionBaris>(
        `select id::text as id, bumn_id::text as bumn_id, jenis, status,
                converted_proposal_id::text as converted_proposal_id,
                data_json::text as data_json
           from portal_submission where id = $1::uuid and deleted_at is null`,
        [id],
      );
      return r[0] ?? null;
    },

    async tandaiSubmissionDikonversi(tx, input) {
      // Guarded on the current status inside the UPDATE as well as in the
      // engine, so two conversions racing on one ticket cannot both win.
      const r = await tx.query<{ id: string }>(
        `update portal_submission
            set status = 'DIKONVERSI', converted_proposal_id = $2::uuid,
                catatan_petugas = coalesce($3, catatan_petugas),
                updated_by = $4::uuid, updated_at = now()
          where id = $1::uuid and status <> 'DIKONVERSI' and converted_proposal_id is null
            and deleted_at is null
        returning id::text as id`,
        [input.id, input.proposalId, input.catatan, input.userId],
      );
      return r.length;
    },

    async akunPenyisihan(tx, bumnId, eventCode) {
      // The allowance account is whatever the write-off mapping row DEBITS, so
      // repointing that row moves the balance this module measures with it and
      // no account code enters this module (invariant 11, ADR 0004).
      const r = await tx.query<{ akun_debit_id: string | null; debit_dari_payload: boolean }>(
        `select akun_debit_id::text as akun_debit_id, debit_dari_payload
           from event_jurnal_mapping
          where bumn_id = $1::uuid and event_code = $2 and aktif and deleted_at is null`,
        [bumnId, eventCode],
      );
      const baris = r[0];
      if (!baris || baris.debit_dari_payload) return null;
      return baris.akun_debit_id;
    },

    async saldoNormalAkun(tx, bumnId, akunId, tanggal) {
      // The same rule modules/jurnal uses for the same purpose: POSTED or
      // REVERSED, nothing soft-deleted. Filtering POSTED alone double-counts
      // every correction (migrations/0018).
      const r = await tx.query<{ saldo: string }>(
        `select coalesce(sum(
                  case when a.saldo_normal = 'K' then b.kredit - b.debit
                       else b.debit - b.kredit end
                ), 0)::numeric(20,2)::text as saldo
           from jurnal_baris b
           join jurnal j on j.id = b.jurnal_id
           join akun a on a.id = b.akun_id
          where b.akun_id = $2::uuid
            and j.bumn_id = $1::uuid
            and j.status in ('POSTED', 'REVERSED')
            and j.tanggal_transaksi <= $3::date
            and j.deleted_at is null
            and b.deleted_at is null`,
        [bumnId, akunId, tanggal],
      );
      return r[0]?.saldo ?? "0.00";
    },
  };
}
