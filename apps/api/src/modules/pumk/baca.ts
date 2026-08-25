// Read models for the PUMK HTTP surface (spec 9.1), plus the two previews the
// screens need BEFORE they will let an operator commit anything.
//
// WHY THIS FILE EXISTS SEPARATELY FROM ./service.ts
// `PumkEngine` is the WRITE side: it owns the state machine, the segregation
// rules and the two collaborating engines, and its read methods answer with
// what is STORED (`Proposal`, `Akad`, `TransisiProposal`). A list screen needs
// the labels next to the ids -- spec 9.1 asks for a proposal list searchable by
// "nama atau NIK" and filterable by sektor, which means nothing unless the row
// carries the mitra's name, the mitra's NIK and the sektor's name. Those joins
// are a projection, not behaviour, so they live here rather than widening an
// engine whose 161 tests pin its current shape.
//
// THE THREE RULES THIS FILE OBEYS, same as the engine's:
//
// 1. BRANCH SCOPE IS ENFORCED HERE, IN THE SERVICE LAYER, AGAINST THE BRANCH
//    THE ROW REPORTS (spec 2 rule 3, spec 16 scenario 24). A list is filtered
//    by `cabang_id = ANY(visible)`; a by-id read loads the row, asks the ROW
//    which branch it is in, and refuses with `CABANG_DILUAR_SCOPE` when that
//    branch is out of scope. A `cabangId` that arrives in a query string is
//    INTERSECTED with the visible set, never trusted, so editing the id in the
//    URL selects a row that then refuses on its own evidence.
//
// 2. NO ARITHMETIC OF ITS OWN. `pratinjauReschedule` calls the instalment
//    engine's `simulasiJadwal` through a port; it does not re-derive an
//    amortisation table, because spec 7.5 item 11 requires the simulated table
//    and the generated table to be identical, and a second implementation is a
//    second answer. `pratinjauPengakhiran` reads the allowance balance through
//    the same repo query the write path uses and applies the same
//    "consume the allowance first, the remainder is a shortfall" split.
//
// 3. IT WRITES NOTHING. Every function here is a SELECT plus, for the two
//    previews, a pure calculation. Nothing in this module implies the system
//    moves money: it records journals for events that happened outside it, and
//    a preview does not even do that.
import type {
  Jadwal,
  RateTahunan,
  Reschedule,
  SimulasiInput,
  TabelJadwal,
  Uang,
} from "../angsuran/index";
import type {
  Akad,
  JenisPengakhiran,
  JenisTindakLanjut,
  MetodePerhitungan,
  Pengakhiran,
  PumkContext,
  PumkDbPort,
  PumkTx,
  StatusAkad,
  StatusProposal,
  SumberPengajuan,
  Survey,
} from "./contract";
import { tolak } from "./kesalahan";
import { createPumkRepo } from "./repo";
import { bacaUang, dariSen } from "./uang";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The instalment engine, as the SUBSET the read side uses. Structurally
 * satisfied by `AngsuranEngine`, so the composition root passes the same
 * instance the write path drives and the preview cannot drift from the
 * schedule that would actually be produced.
 */
export interface PorterAngsuranBaca {
  simulasiJadwal(input: SimulasiInput, ctx: PumkContext): Promise<TabelJadwal>;
  riwayatJadwal(akadId: string, ctx: PumkContext): Promise<Jadwal[]>;
}

/**
 * The configuration service, as the SUBSET the read side uses. Structurally
 * satisfied by `KonfigurasiService`. `GET /pumk/batasan` answers from these
 * rows and NEVER from a literal: spec 5.5's bounds are the client's accounting
 * team's decision (docs/REGULASI.md), so a number typed into this repo would
 * be an opinion shipped as a fact.
 */
export interface PorterKonfigurasiPumk {
  batasan(bumnId: string | null): Promise<{
    plafonMin: string;
    plafonMax: string;
    tenorMinBulan: number;
    tenorMaxBulan: number;
    gracePeriodMaxBulan: number;
    wajibJaminanDiAtas: string;
    maksPinjamanAktifPerMitra: number;
    skorSurveyMinimum: number;
  }>;
  jasaAdm(bumnId: string | null): Promise<{
    rateDefault: string;
    metodeDefault: "FLAT" | "EFEKTIF" | "ANUITAS";
  }>;
}

export interface PumkBacaDeps {
  db: PumkDbPort;
  angsuran: PorterAngsuranBaca;
  konfigurasi: PorterKonfigurasiPumk;
}

// ---------------------------------------------------------------------------
// View shapes. These mirror apps/web/src/api/pumk.ts field for field; that file
// is the consumer and it was written first, so the names here follow it.
// ---------------------------------------------------------------------------

export interface BatasanPumk {
  plafonMin: Uang;
  plafonMax: Uang;
  tenorMin: number;
  tenorMax: number;
  gracePeriodMax: number;
  wajibJaminanDiAtasPlafon: Uang;
  maksPinjamanAktifPerMitra: number;
  skorSurveyMinimumLolos: string;
  jasaAdmRateDefault: RateTahunan;
  jasaAdmMetodeDefault: MetodePerhitungan;
}

export interface BarisProposal {
  id: string;
  cabangId: string;
  noProposal: string;
  tanggalProposal: string;
  mitraId: string;
  sektorId: string | null;
  jumlahDiajukan: Uang;
  tenorDiajukan: number;
  tujuanPenggunaan: string | null;
  sumberPengajuan: SumberPengajuan;
  portalSubmissionId: string | null;
  status: StatusProposal;
  currentStep: number;
  createdBy: string | null;
  mitraKode: string;
  mitraNama: string;
  mitraNik: string | null;
  sektorNama: string | null;
  cabangNama: string;
  umurHari: number;
}

export interface BarisTransisi {
  statusDari: StatusProposal | null;
  statusKe: StatusProposal;
  aksi: string;
  olehUserId: string | null;
  waktu: string;
  catatan: string | null;
  olehNama: string | null;
  olehRole: string | null;
}

export interface BarisJaminan {
  id: string;
  proposalId: string;
  jenis: string;
  deskripsi: string | null;
  nilaiTaksasi: Uang | null;
  nomorDokumen: string | null;
  atasNama: string | null;
  lokasi: string | null;
  statusFisik: "DITERIMA" | "DIKEMBALIKAN" | null;
  tanggalTerima: string | null;
}

export interface DetailProposal {
  proposal: BarisProposal;
  survey: Survey | null;
  jaminan: BarisJaminan[];
  timeline: BarisTransisi[];
  review: {
    reviewerUserId: string | null;
    reviewerNama: string | null;
    tanggal: string | null;
    keputusan: string | null;
    catatan: string | null;
  } | null;
  approval: {
    plafonDisetujui: Uang | null;
    tenorDisetujui: number | null;
    jasaAdmRate: RateTahunan | null;
    keputusan: string | null;
    catatan: string | null;
  } | null;
  akad: Akad | null;
}

export interface BarisAkad extends Akad {
  mitraKode: string;
  mitraNama: string;
  noProposal: string;
  kolektibilitas: string | null;
  hariTunggakan: number;
  cabangNama: string;
}

export interface BarisCluster {
  id: string;
  kode: string;
  nama: string;
  cabangId: string;
  cabangNama: string;
  jumlahAnggota: number;
  outstandingPokok: Uang;
  komposisiKolektibilitas: Array<{ kelas: string; jumlahAkad: number; outstandingPokok: Uang }>;
}

export interface BarisAnggotaCluster {
  clusterId: string;
  mitraId: string;
  tanggalMasuk: string;
  tanggalKeluar: string | null;
  alasanKeluar: string | null;
  mitraKode: string;
  mitraNama: string;
  kolektibilitas: string | null;
  outstandingPokok: Uang | null;
}

export interface RingkasanMitra {
  id: string;
  kodeMitra: string;
  namaLengkap: string;
  nik: string | null;
  telepon: string | null;
  alamat: string | null;
  namaUsaha: string | null;
  sektorId: string | null;
  sektorNama: string | null;
  bidangUsaha: string | null;
  kotaNama: string | null;
  status: string;
  isMitraLama: boolean;
  clusterId: string | null;
  clusterNama: string | null;
  jumlahPinjamanAktif: number;
  jumlahPinjamanSelesai: number;
  outstandingPokok: Uang | null;
  kolektibilitasTerakhir: string | null;
}

export interface OpsiReferensi {
  id: string;
  kode: string;
  nama: string;
}

export interface PratinjauReschedule {
  jadwalBerjalan: Jadwal;
  jadwalUsulan: TabelJadwal;
  pokokTerbayarHistoris: Uang;
  outstandingSaatIni: Uang;
}

export interface PratinjauPengakhiran {
  akadId: string;
  jenis: JenisPengakhiran;
  outstandingPokok: Uang;
  outstandingJasa: Uang;
  penyisihanTersedia: Uang;
  penyisihanDipakai: Uang;
  kekuranganPenyisihan: Uang;
  eventJurnal: string[];
  penolakan: string | null;
}

export interface BarisTindakLanjut {
  id: string;
  akadId: string;
  tanggal: string;
  jenis: JenisTindakLanjut;
  hasil: string | null;
  petugasKaryawanId: string | null;
  catatan: string | null;
}

export interface FilterProposalBaca {
  cabangId?: string | null;
  sektorId?: string | null;
  status?: string | null;
  sumberPengajuan?: string | null;
  dariTanggal?: string | null;
  sampaiTanggal?: string | null;
  cari?: string | null;
}

export interface FilterAkadBaca {
  cabangId?: string | null;
  status?: string | null;
  kolektibilitas?: string | null;
  cari?: string | null;
}

// ---------------------------------------------------------------------------
// Scope, spec 2 rule 3
// ---------------------------------------------------------------------------

/**
 * The branches this caller may see. Same derivation as ./service.ts's
 * `cabangTerlihat`, deliberately duplicated rather than exported from there:
 * that file is the write path and this one must not be able to widen it.
 */
function cabangTerlihat(ctx: PumkContext): string[] {
  return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
}

/** Refuses a row whose OWN branch is outside the caller's scope. */
function wajibScope(ctx: PumkContext, cabangId: string): void {
  if (cabangId === ctx.cabangId) return;
  if (ctx.cabangDalamScope?.includes(cabangId)) return;
  throw tolak("CABANG_DILUAR_SCOPE", { cabangId });
}

/**
 * A branch filter that arrived in a query string, INTERSECTED with what the
 * caller may see. An id the caller cannot reach narrows the answer to nothing
 * rather than widening it, and never leaks whether that branch exists.
 */
function cabangDiminta(ctx: PumkContext, diminta: string | null | undefined): string[] {
  const terlihat = cabangTerlihat(ctx);
  if (!diminta) return terlihat;
  return terlihat.includes(diminta) ? [diminta] : [];
}

// ---------------------------------------------------------------------------
// Row shapes and mappers
// ---------------------------------------------------------------------------

const KOLOM_AKAD = `a.id::text as id, a.proposal_id::text as proposal_id, a.mitra_id::text as mitra_id,
  a.cabang_id::text as cabang_id, a.no_akad, a.tanggal_akad::text as tanggal_akad,
  a.pokok_pinjaman::text as pokok_pinjaman, a.jasa_adm_rate::text as jasa_adm_rate,
  a.metode_perhitungan, a.tenor_bulan, a.grace_period_bulan,
  a.tanggal_mulai_angsuran::text as tanggal_mulai_angsuran,
  a.tanggal_jatuh_tempo_akhir::text as tanggal_jatuh_tempo_akhir, a.status,
  a.outstanding_pokok::text as outstanding_pokok, a.outstanding_jasa::text as outstanding_jasa`;

interface AkadRow {
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
}

function akadDari(b: AkadRow): Akad {
  return {
    id: b.id,
    proposalId: b.proposal_id,
    mitraId: b.mitra_id,
    cabangId: b.cabang_id,
    noAkad: b.no_akad,
    tanggalAkad: b.tanggal_akad,
    pokokPinjaman: b.pokok_pinjaman as Uang,
    jasaAdmRate: b.jasa_adm_rate as RateTahunan,
    metodePerhitungan: b.metode_perhitungan as MetodePerhitungan,
    tenorBulan: b.tenor_bulan,
    gracePeriodBulan: b.grace_period_bulan,
    tanggalMulaiAngsuran: b.tanggal_mulai_angsuran,
    tanggalJatuhTempoAkhir: b.tanggal_jatuh_tempo_akhir,
    status: b.status as StatusAkad,
    outstandingPokok: b.outstanding_pokok as Uang,
    outstandingJasa: b.outstanding_jasa as Uang,
  };
}

interface ProposalRow {
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
  mitra_kode: string;
  mitra_nama: string;
  mitra_nik: string | null;
  sektor_nama: string | null;
  cabang_nama: string;
  umur_hari: number;
}

function proposalDari(b: ProposalRow): BarisProposal {
  return {
    id: b.id,
    cabangId: b.cabang_id,
    noProposal: b.no_proposal,
    tanggalProposal: b.tanggal_proposal,
    mitraId: b.mitra_id,
    sektorId: b.sektor_id,
    jumlahDiajukan: b.jumlah_diajukan as Uang,
    tenorDiajukan: b.tenor_diajukan,
    tujuanPenggunaan: b.tujuan_penggunaan,
    sumberPengajuan: b.sumber_pengajuan === "PORTAL_ONLINE" ? "PORTAL_ONLINE" : "INTERNAL",
    portalSubmissionId: b.portal_submission_id,
    status: b.status as StatusProposal,
    currentStep: b.current_step,
    createdBy: b.created_by,
    mitraKode: b.mitra_kode,
    mitraNama: b.mitra_nama,
    mitraNik: b.mitra_nik,
    sektorNama: b.sektor_nama,
    cabangNama: b.cabang_nama,
    umurHari: Number(b.umur_hari ?? 0),
  };
}

const PILIH_PROPOSAL = `select p.id::text as id, p.cabang_id::text as cabang_id, p.no_proposal,
    p.tanggal_proposal::text as tanggal_proposal, p.mitra_id::text as mitra_id,
    p.sektor_id::text as sektor_id, p.jumlah_diajukan::text as jumlah_diajukan,
    p.tenor_diajukan, p.tujuan_penggunaan, p.sumber_pengajuan,
    p.portal_submission_id::text as portal_submission_id, p.status, p.current_step,
    p.created_by::text as created_by,
    m.kode_mitra as mitra_kode, m.nama_lengkap as mitra_nama, m.nik as mitra_nik,
    s.nama as sektor_nama, c.nama as cabang_nama,
    (current_date - p.tanggal_proposal)::int as umur_hari
  from pumk_proposal p
  join mitra m on m.id = p.mitra_id
  join cabang c on c.id = p.cabang_id
  left join sektor_pumk s on s.id = p.sektor_id`;

const PILIH_AKAD = `select ${KOLOM_AKAD},
    m.kode_mitra as mitra_kode, m.nama_lengkap as mitra_nama,
    p.no_proposal as no_proposal, c.nama as cabang_nama,
    k.kolektibilitas as kolektibilitas, coalesce(k.hari_tunggakan, 0)::int as hari_tunggakan
  from pumk_akad a
  join mitra m on m.id = a.mitra_id
  join pumk_proposal p on p.id = a.proposal_id
  join cabang c on c.id = a.cabang_id
  left join lateral (
    select ks.kolektibilitas, ks.hari_tunggakan
      from kolektibilitas_snapshot ks
      join periode pr on pr.id = ks.periode_id
     where ks.akad_id = a.id and ks.deleted_at is null
     order by pr.tahun desc, pr.bulan desc
     limit 1
  ) k on true`;

// ---------------------------------------------------------------------------
// The read service
// ---------------------------------------------------------------------------

export interface PumkBaca {
  batasan(ctx: PumkContext): Promise<BatasanPumk>;
  daftarProposal(filter: FilterProposalBaca, ctx: PumkContext): Promise<BarisProposal[]>;
  detailProposal(proposalId: string, ctx: PumkContext): Promise<DetailProposal>;
  timeline(proposalId: string, ctx: PumkContext): Promise<BarisTransisi[]>;
  daftarJaminan(proposalId: string, ctx: PumkContext): Promise<BarisJaminan[]>;
  daftarAkad(filter: FilterAkadBaca, ctx: PumkContext): Promise<BarisAkad[]>;
  detailAkad(akadId: string, ctx: PumkContext): Promise<BarisAkad>;
  riwayatJadwal(akadId: string, ctx: PumkContext): Promise<Jadwal[]>;
  /** Spec 7.4's calculator, straight through to the instalment engine. */
  simulasiJadwal(input: SimulasiInput, ctx: PumkContext): Promise<TabelJadwal>;
  daftarReschedule(
    filter: { akadId?: string | null; status?: string | null },
    ctx: PumkContext,
  ): Promise<Reschedule[]>;
  pratinjauReschedule(
    input: {
      akadId: string;
      jenis: string;
      tenorBaru?: number | null;
      graceBaru?: number | null;
      jasaRateBaru?: RateTahunan | null;
    },
    ctx: PumkContext,
  ): Promise<PratinjauReschedule>;
  daftarPengakhiran(filter: { cabangId?: string | null }, ctx: PumkContext): Promise<Pengakhiran[]>;
  pratinjauPengakhiran(
    input: { akadId: string; jenis: JenisPengakhiran; tanggal: string },
    ctx: PumkContext,
  ): Promise<PratinjauPengakhiran>;
  daftarCluster(
    filter: { cabangId?: string | null; cari?: string | null },
    ctx: PumkContext,
  ): Promise<BarisCluster[]>;
  detailCluster(clusterId: string, ctx: PumkContext): Promise<BarisCluster>;
  anggotaCluster(
    clusterId: string,
    ctx: PumkContext,
    opsi?: { padaTanggal?: string | null },
  ): Promise<BarisAnggotaCluster[]>;
  cariMitra(
    input: { cari?: string | null; cabangId?: string | null },
    ctx: PumkContext,
  ): Promise<RingkasanMitra[]>;
  detailMitra(mitraId: string, ctx: PumkContext): Promise<RingkasanMitra>;
  daftarSektor(ctx: PumkContext): Promise<OpsiReferensi[]>;
  daftarAkunKas(ctx: PumkContext): Promise<OpsiReferensi[]>;
}

/** Spec 6.4's write-off pair, as CODES. No account ever appears in this module. */
const EVENT_HAPUS_BUKU = "HAPUS_BUKU_PIUTANG";
const EVENT_HAPUS_BUKU_KEKURANGAN = "HAPUS_BUKU_KEKURANGAN_PENYISIHAN";

const STATUS_PIUTANG_AKTIF = new Set<string>(["AKTIF", "RESCHEDULED", "MACET"]);

export function buatPumkBaca(deps: PumkBacaDeps): PumkBaca {
  const repo = createPumkRepo();
  const db = deps.db;

  /** The timeline rows for a proposal whose scope has ALREADY been checked. */
  async function timelineDari(proposalId: string): Promise<BarisTransisi[]> {
    const rows = await db.query<{
      status_dari: string | null;
      status_ke: string;
      aksi: string;
      oleh_user_id: string | null;
      waktu: string;
      catatan: string | null;
      oleh_nama: string | null;
      oleh_role: string | null;
    }>(
      `select t.status_dari, t.status_ke, t.aksi, t.oleh_user_id::text as oleh_user_id,
              to_char(t.waktu at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as waktu,
              t.catatan, u.nama as oleh_nama,
              (select r.kode from user_role ur join app_role r on r.id = ur.role_id
                where ur.user_id = t.oleh_user_id order by r.kode limit 1) as oleh_role
         from pumk_proposal_transisi t
         left join app_user u on u.id = t.oleh_user_id
        where t.proposal_id = $1::uuid
        order by t.waktu asc, t.id asc`,
      [proposalId],
    );
    return rows.map((b) => ({
      statusDari: (b.status_dari ?? null) as StatusProposal | null,
      statusKe: b.status_ke as StatusProposal,
      aksi: b.aksi,
      olehUserId: b.oleh_user_id,
      waktu: b.waktu,
      catatan: b.catatan,
      olehNama: b.oleh_nama,
      olehRole: b.oleh_role,
    }));
  }

  /** The jaminan rows for a proposal whose scope has ALREADY been checked. */
  async function jaminanDari(proposalId: string): Promise<BarisJaminan[]> {
    const rows = await db.query<{
      id: string;
      proposal_id: string;
      jenis: string;
      deskripsi: string | null;
      nilai_taksasi: string | null;
      nomor_dokumen: string | null;
      atas_nama: string | null;
      lokasi: string | null;
      status_fisik: string | null;
      tanggal_terima: string | null;
    }>(
      `select id::text as id, proposal_id::text as proposal_id, jenis, deskripsi,
              nilai_taksasi::text as nilai_taksasi, nomor_dokumen, atas_nama, lokasi,
              status_fisik, tanggal_terima::text as tanggal_terima
         from pumk_jaminan where proposal_id = $1::uuid and deleted_at is null
        order by created_at asc`,
      [proposalId],
    );
    return rows.map((b) => ({
      id: b.id,
      proposalId: b.proposal_id,
      jenis: b.jenis,
      deskripsi: b.deskripsi,
      nilaiTaksasi: (b.nilai_taksasi ?? null) as Uang | null,
      nomorDokumen: b.nomor_dokumen,
      atasNama: b.atas_nama,
      lokasi: b.lokasi,
      statusFisik: (b.status_fisik ?? null) as "DITERIMA" | "DIKEMBALIKAN" | null,
      tanggalTerima: b.tanggal_terima,
    }));
  }

  /** The branch of a proposal, refused when the ROW says another branch. */
  async function cabangProposal(proposalId: string, ctx: PumkContext): Promise<string> {
    const rows = await db.query<{ cabang_id: string }>(
      `select cabang_id::text as cabang_id from pumk_proposal
        where id = $1::uuid and deleted_at is null`,
      [proposalId],
    );
    const row = rows[0];
    if (!row) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId });
    wajibScope(ctx, row.cabang_id);
    return row.cabang_id;
  }

  /** Outstanding per kolektibilitas class, for the clusters named. */
  async function komposisiUntuk(
    clusterIds: readonly string[],
  ): Promise<Map<string, Array<{ kelas: string; jumlahAkad: number; outstandingPokok: Uang }>>> {
    const out = new Map<
      string,
      Array<{ kelas: string; jumlahAkad: number; outstandingPokok: Uang }>
    >();
    if (clusterIds.length === 0) return out;
    const rows = await db.query<{
      cluster_id: string;
      kelas: string;
      jumlah_akad: number;
      outstanding_pokok: string;
    }>(
      `select ca.cluster_id::text as cluster_id,
              coalesce(k.kolektibilitas, 'BELUM_DINILAI') as kelas,
              count(*)::int as jumlah_akad,
              sum(a.outstanding_pokok)::numeric(20,2)::text as outstanding_pokok
         from cluster_anggota ca
         join pumk_akad a on a.mitra_id = ca.mitra_id and a.deleted_at is null
          and a.status in ('AKTIF','RESCHEDULED','MACET')
         left join lateral (
           select ks.kolektibilitas from kolektibilitas_snapshot ks
            join periode pr on pr.id = ks.periode_id
           where ks.akad_id = a.id and ks.deleted_at is null
           order by pr.tahun desc, pr.bulan desc limit 1
         ) k on true
        where ca.cluster_id = any($1::uuid[]) and ca.tanggal_keluar is null
          and ca.deleted_at is null
        group by 1, 2
        order by 2 asc`,
      [clusterIds],
    );
    for (const b of rows) {
      const daftar = out.get(b.cluster_id) ?? [];
      daftar.push({
        kelas: b.kelas,
        jumlahAkad: Number(b.jumlah_akad ?? 0),
        outstandingPokok: b.outstanding_pokok as Uang,
      });
      out.set(b.cluster_id, daftar);
    }
    return out;
  }

  async function clusterDalamCabang(
    filter: { cabangId?: string | null; cari?: string | null },
    ctx: PumkContext,
  ): Promise<BarisCluster[]> {
    const cabangIds = cabangDiminta(ctx, filter.cabangId);
    if (cabangIds.length === 0) return [];
    const rows = await db.query<{
      id: string;
      kode: string;
      nama: string;
      cabang_id: string;
      cabang_nama: string;
      jumlah_anggota: number;
      outstanding_pokok: string;
    }>(
      `select cl.id::text as id, cl.kode, cl.nama, cl.cabang_id::text as cabang_id,
              c.nama as cabang_nama,
              (select count(*)::int from cluster_anggota ca
                where ca.cluster_id = cl.id and ca.tanggal_keluar is null
                  and ca.deleted_at is null) as jumlah_anggota,
              coalesce((select sum(a.outstanding_pokok) from pumk_akad a
                 join cluster_anggota ca on ca.mitra_id = a.mitra_id
                  and ca.cluster_id = cl.id and ca.tanggal_keluar is null
                  and ca.deleted_at is null
                where a.deleted_at is null
                  and a.status in ('AKTIF','RESCHEDULED','MACET')), 0)::numeric(20,2)::text
                as outstanding_pokok
         from cluster cl
         join cabang c on c.id = cl.cabang_id
        where cl.deleted_at is null
          and cl.cabang_id = any($1::uuid[])
          and ($2::text is null or cl.nama ilike '%' || $2 || '%' or cl.kode ilike '%' || $2 || '%')
        order by cl.kode asc
        limit 500`,
      [cabangIds, filter.cari ?? null],
    );
    const komposisi = await komposisiUntuk(rows.map((r) => r.id));
    return rows.map((b) => ({
      id: b.id,
      kode: b.kode,
      nama: b.nama,
      cabangId: b.cabang_id,
      cabangNama: b.cabang_nama,
      jumlahAnggota: Number(b.jumlah_anggota ?? 0),
      outstandingPokok: b.outstanding_pokok as Uang,
      komposisiKolektibilitas: komposisi.get(b.id) ?? [],
    }));
  }

  /** The akad row plus its labels, scope-checked against the ROW's branch. */
  async function akadTerlihat(tx: PumkTx, akadId: string, ctx: PumkContext): Promise<AkadRow & {
    mitra_kode: string;
    mitra_nama: string;
    no_proposal: string;
    cabang_nama: string;
    kolektibilitas: string | null;
    hari_tunggakan: number;
  }> {
    const baris = await tx.query<AkadRow & {
      mitra_kode: string;
      mitra_nama: string;
      no_proposal: string;
      cabang_nama: string;
      kolektibilitas: string | null;
      hari_tunggakan: number;
    }>(`${PILIH_AKAD} where a.id = $1::uuid and a.deleted_at is null`, [akadId]);
    const row = baris[0];
    if (!row) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
    wajibScope(ctx, row.cabang_id);
    return row;
  }

  return {
    async batasan(ctx): Promise<BatasanPumk> {
      // Read through modules/konfigurasi, which resolves a bumn override over
      // the shipped default and caches it. Never a literal here.
      const [batas, jasa] = await Promise.all([
        deps.konfigurasi.batasan(ctx.bumnId),
        deps.konfigurasi.jasaAdm(ctx.bumnId),
      ]);
      return {
        plafonMin: batas.plafonMin as Uang,
        plafonMax: batas.plafonMax as Uang,
        tenorMin: batas.tenorMinBulan,
        tenorMax: batas.tenorMaxBulan,
        gracePeriodMax: batas.gracePeriodMaxBulan,
        wajibJaminanDiAtasPlafon: batas.wajibJaminanDiAtas as Uang,
        maksPinjamanAktifPerMitra: batas.maksPinjamanAktifPerMitra,
        skorSurveyMinimumLolos: String(batas.skorSurveyMinimum),
        jasaAdmRateDefault: jasa.rateDefault as RateTahunan,
        jasaAdmMetodeDefault: jasa.metodeDefault,
      };
    },

    async daftarProposal(filter, ctx): Promise<BarisProposal[]> {
      const cabangIds = cabangDiminta(ctx, filter.cabangId);
      if (cabangIds.length === 0) return [];
      const rows = await db.query<ProposalRow>(
        `${PILIH_PROPOSAL}
          where p.deleted_at is null
            and p.cabang_id = any($1::uuid[])
            and ($2::uuid is null or p.sektor_id = $2::uuid)
            and ($3::text is null or p.status = $3)
            and ($4::text is null or p.sumber_pengajuan = $4)
            and ($5::date is null or p.tanggal_proposal >= $5::date)
            and ($6::date is null or p.tanggal_proposal <= $6::date)
            and ($7::text is null
                 or m.nama_lengkap ilike '%' || $7 || '%'
                 or m.nik ilike '%' || $7 || '%'
                 or p.no_proposal ilike '%' || $7 || '%')
          order by p.tanggal_proposal desc, p.no_proposal desc
          limit 500`,
        [
          cabangIds,
          filter.sektorId ?? null,
          filter.status ?? null,
          filter.sumberPengajuan ?? null,
          filter.dariTanggal ?? null,
          filter.sampaiTanggal ?? null,
          filter.cari ?? null,
        ],
      );
      return rows.map(proposalDari);
    },

    async detailProposal(proposalId, ctx): Promise<DetailProposal> {
      const rows = await db.query<ProposalRow>(
        `${PILIH_PROPOSAL} where p.id = $1::uuid and p.deleted_at is null`,
        [proposalId],
      );
      const row = rows[0];
      if (!row) throw tolak("PROPOSAL_TIDAK_DITEMUKAN", { proposalId });
      wajibScope(ctx, row.cabang_id);

      const [survey, jaminan, timeline, review, approval, akad] = await Promise.all([
        db.query<{
          id: string;
          proposal_id: string;
          tanggal_survey: string;
          petugas_karyawan_id: string | null;
          skor_total: string | null;
          plafon_rekomendasi: string | null;
          tenor_rekomendasi: number | null;
          catatan: string | null;
        }>(
          `select id::text as id, proposal_id::text as proposal_id,
                  tanggal_survey::text as tanggal_survey,
                  petugas_karyawan_id::text as petugas_karyawan_id,
                  skor_total::text as skor_total,
                  plafon_rekomendasi::text as plafon_rekomendasi,
                  tenor_rekomendasi, catatan
             from pumk_survey where proposal_id = $1::uuid and deleted_at is null limit 1`,
          [proposalId],
        ),
        jaminanDari(proposalId),
        timelineDari(proposalId),
        db.query<{
          reviewer_user_id: string;
          reviewer_nama: string | null;
          tanggal: string;
          keputusan: string;
          catatan: string | null;
        }>(
          `select r.reviewer_user_id::text as reviewer_user_id, u.nama as reviewer_nama,
                  r.tanggal::text as tanggal, r.keputusan, r.catatan
             from pumk_review r
             left join app_user u on u.id = r.reviewer_user_id
            where r.proposal_id = $1::uuid and r.deleted_at is null
            order by r.created_at desc limit 1`,
          [proposalId],
        ),
        db.query<{
          plafon_disetujui: string | null;
          tenor_disetujui: number | null;
          jasa_adm_rate: string | null;
          keputusan: string;
          catatan: string | null;
        }>(
          `select plafon_disetujui::text as plafon_disetujui, tenor_disetujui,
                  jasa_adm_rate::text as jasa_adm_rate, keputusan, catatan
             from pumk_approval where proposal_id = $1::uuid
            order by created_at desc limit 1`,
          [proposalId],
        ),
        db.query<AkadRow>(
          `select ${KOLOM_AKAD} from pumk_akad a
            where a.proposal_id = $1::uuid and a.deleted_at is null limit 1`,
          [proposalId],
        ),
      ]);

      const s = survey[0];
      const rv = review[0];
      const ap = approval[0];
      const ak = akad[0];
      return {
        proposal: proposalDari(row),
        survey: s
          ? {
              id: s.id,
              proposalId: s.proposal_id,
              tanggalSurvey: s.tanggal_survey,
              petugasKaryawanId: s.petugas_karyawan_id,
              skorTotal: s.skor_total,
              plafonRekomendasi: (s.plafon_rekomendasi ?? null) as Uang | null,
              tenorRekomendasi: s.tenor_rekomendasi,
              catatan: s.catatan,
            }
          : null,
        jaminan,
        timeline,
        review: rv
          ? {
              reviewerUserId: rv.reviewer_user_id,
              reviewerNama: rv.reviewer_nama,
              tanggal: rv.tanggal,
              keputusan: rv.keputusan,
              catatan: rv.catatan,
            }
          : null,
        approval: ap
          ? {
              plafonDisetujui: (ap.plafon_disetujui ?? null) as Uang | null,
              tenorDisetujui: ap.tenor_disetujui,
              jasaAdmRate: (ap.jasa_adm_rate ?? null) as RateTahunan | null,
              keputusan: ap.keputusan,
              catatan: ap.catatan,
            }
          : null,
        akad: ak ? akadDari(ak) : null,
      };
    },

    async timeline(proposalId, ctx): Promise<BarisTransisi[]> {
      await cabangProposal(proposalId, ctx);
      return timelineDari(proposalId);
    },

    async daftarJaminan(proposalId, ctx): Promise<BarisJaminan[]> {
      await cabangProposal(proposalId, ctx);
      return jaminanDari(proposalId);
    },

    async daftarAkad(filter, ctx): Promise<BarisAkad[]> {
      const cabangIds = cabangDiminta(ctx, filter.cabangId);
      if (cabangIds.length === 0) return [];
      const rows = await db.query<AkadRow & {
        mitra_kode: string;
        mitra_nama: string;
        no_proposal: string;
        cabang_nama: string;
        kolektibilitas: string | null;
        hari_tunggakan: number;
      }>(
        `${PILIH_AKAD}
          where a.deleted_at is null
            and a.cabang_id = any($1::uuid[])
            and ($2::text is null or a.status = $2)
            and ($3::text is null or k.kolektibilitas = $3)
            and ($4::text is null
                 or m.nama_lengkap ilike '%' || $4 || '%'
                 or m.nik ilike '%' || $4 || '%'
                 or a.no_akad ilike '%' || $4 || '%')
          order by a.tanggal_akad desc, a.no_akad desc
          limit 500`,
        [cabangIds, filter.status ?? null, filter.kolektibilitas ?? null, filter.cari ?? null],
      );
      return rows.map((b) => ({
        ...akadDari(b),
        mitraKode: b.mitra_kode,
        mitraNama: b.mitra_nama,
        noProposal: b.no_proposal,
        kolektibilitas: b.kolektibilitas,
        hariTunggakan: Number(b.hari_tunggakan ?? 0),
        cabangNama: b.cabang_nama,
      }));
    },

    async detailAkad(akadId, ctx): Promise<BarisAkad> {
      const b = await akadTerlihat(db, akadId, ctx);
      return {
        ...akadDari(b),
        mitraKode: b.mitra_kode,
        mitraNama: b.mitra_nama,
        noProposal: b.no_proposal,
        kolektibilitas: b.kolektibilitas,
        hariTunggakan: Number(b.hari_tunggakan ?? 0),
        cabangNama: b.cabang_nama,
      };
    },

    async riwayatJadwal(akadId, ctx): Promise<Jadwal[]> {
      await akadTerlihat(db, akadId, ctx);
      // Through the instalment engine, never by reading pumk_jadwal_angsuran
      // here: one schedule reader, one answer (invariant 8).
      return deps.angsuran.riwayatJadwal(akadId, ctx);
    },

    async simulasiJadwal(input, ctx): Promise<TabelJadwal> {
      // Straight through, on purpose: spec 7.5 item 11 requires the simulated
      // table and the generated table to be IDENTICAL, which only holds if one
      // engine produces both. Nothing is stored and nothing is posted.
      return deps.angsuran.simulasiJadwal(input, ctx);
    },

    async daftarReschedule(filter, ctx): Promise<Reschedule[]> {
      const cabangIds = cabangTerlihat(ctx);
      const rows = await db.query<{
        id: string;
        akad_id: string;
        status: string;
        jenis: string;
        jadwal_versi_lama: number;
        jadwal_versi_baru: number | null;
        tenor_baru: number | null;
        grace_baru: number | null;
        jasa_rate_baru: string | null;
      }>(
        `select r.id::text as id, r.akad_id::text as akad_id, r.status, r.jenis,
                r.jadwal_versi_lama, r.jadwal_versi_baru, r.tenor_baru, r.grace_baru,
                r.jasa_rate_baru::text as jasa_rate_baru
           from pumk_reschedule r
           join pumk_akad a on a.id = r.akad_id
          where r.deleted_at is null
            and a.cabang_id = any($1::uuid[])
            and ($2::uuid is null or r.akad_id = $2::uuid)
            and ($3::text is null or r.status = $3)
          order by r.tanggal_pengajuan desc, r.created_at desc
          limit 500`,
        [cabangIds, filter.akadId ?? null, filter.status ?? null],
      );
      return rows.map((b) => ({
        id: b.id,
        akadId: b.akad_id,
        status: b.status as Reschedule["status"],
        jenis: b.jenis as Reschedule["jenis"],
        jadwalVersiLama: b.jadwal_versi_lama,
        jadwalVersiBaru: b.jadwal_versi_baru,
        tenorBaru: b.tenor_baru,
        graceBaru: b.grace_baru,
        jasaRateBaru: (b.jasa_rate_baru ?? null) as RateTahunan | null,
      }));
    },

    async pratinjauReschedule(input, ctx): Promise<PratinjauReschedule> {
      const akad = await akadTerlihat(db, input.akadId, ctx);
      const versi = await deps.angsuran.riwayatJadwal(akad.id, ctx);
      const berjalan = versi.find((v) => v.isActiveVersion);
      if (!berjalan) throw tolak("JADWAL_BELUM_SIAP", { akadId: akad.id });

      // The SAME derivation the approval performs (modules/angsuran, spec 7.3):
      // the basis is the outstanding as it stands now, the new version's dates
      // start at the EARLIEST UNPAID due date of the version being superseded,
      // and an absent tenor means "as many instalments as are still unpaid".
      // Duplicating the FORMULA would be a second answer; duplicating this
      // parameter derivation is unavoidable for a preview that stores nothing,
      // so it is written to read line for line like the approval path.
      //
      // The per-row PAYMENT STATE is the one thing `Jadwal` does not carry
      // (`BarisJadwal` is the table, not its settlement), so the two figures
      // that depend on it are read from the schedule table directly. This is a
      // SELECT: invariant 8 forbids this module WRITING a schedule row, and
      // every schedule it produces still comes from the instalment engine.
      const sisa = await db.query<{ jumlah: number; mulai: string | null }>(
        `select count(*)::int as jumlah, min(tanggal_jatuh_tempo)::text as mulai
           from pumk_jadwal_angsuran
          where akad_id = $1::uuid and versi = $2 and deleted_at is null
            and status <> 'LUNAS'`,
        [akad.id, berjalan.versi],
      );
      const belumLunas = Number(sisa[0]?.jumlah ?? 0);
      const mulai = sisa[0]?.mulai ?? akad.tanggal_mulai_angsuran;

      const outstanding = bacaUang(akad.outstanding_pokok);
      const outstandingSen = outstanding.bentuk === "ok" ? outstanding.sen : 0n;
      const pokok = bacaUang(akad.pokok_pinjaman);
      const pokokSen = pokok.bentuk === "ok" ? pokok.sen : 0n;

      const jadwalUsulan = await deps.angsuran.simulasiJadwal(
        {
          pokok: dariSen(outstandingSen),
          rate: (input.jasaRateBaru ?? akad.jasa_adm_rate) as RateTahunan,
          metode: akad.metode_perhitungan as MetodePerhitungan,
          tenorBulan: input.tenorBaru ?? Math.max(belumLunas, 1),
          gracePeriodBulan: input.graceBaru ?? 0,
          tanggalMulaiAngsuran: mulai,
        },
        ctx,
      );

      return {
        jadwalBerjalan: berjalan,
        jadwalUsulan,
        pokokTerbayarHistoris: dariSen(pokokSen - outstandingSen),
        outstandingSaatIni: dariSen(outstandingSen),
      };
    },

    async daftarPengakhiran(filter, ctx): Promise<Pengakhiran[]> {
      const cabangIds = cabangDiminta(ctx, filter.cabangId);
      if (cabangIds.length === 0) return [];
      const rows = await db.query<AkadRow & {
        pg_id: string;
        pg_jenis: string;
        pg_tanggal: string;
        pg_pokok: string;
        pg_jasa: string;
        pg_no_sk: string | null;
        pg_jurnal_id: string | null;
      }>(
        `select ${KOLOM_AKAD},
                g.id::text as pg_id, g.jenis as pg_jenis, g.tanggal::text as pg_tanggal,
                g.outstanding_pokok_saat_itu::text as pg_pokok,
                g.outstanding_jasa_saat_itu::text as pg_jasa,
                g.no_sk as pg_no_sk, g.jurnal_id::text as pg_jurnal_id
           from pumk_pengakhiran g
           join pumk_akad a on a.id = g.akad_id
          where g.deleted_at is null and a.cabang_id = any($1::uuid[])
          order by g.tanggal desc, g.created_at desc
          limit 500`,
        [cabangIds],
      );
      return rows.map((b) => ({
        id: b.pg_id,
        akadId: b.id,
        jenis: b.pg_jenis as JenisPengakhiran,
        tanggal: b.pg_tanggal,
        outstandingPokokSaatItu: b.pg_pokok as Uang,
        outstandingJasaSaatItu: b.pg_jasa as Uang,
        noSk: b.pg_no_sk,
        jurnalId: b.pg_jurnal_id,
        akadSetelah: akadDari(b),
      }));
    },

    async pratinjauPengakhiran(input, ctx): Promise<PratinjauPengakhiran> {
      const akad = await akadTerlihat(db, input.akadId, ctx);
      const pokok = bacaUang(akad.outstanding_pokok);
      const jasa = bacaUang(akad.outstanding_jasa);
      const pokokSen = pokok.bentuk === "ok" ? pokok.sen : 0n;
      const jasaSen = jasa.bentuk === "ok" ? jasa.sen : 0n;

      const kosong = {
        akadId: akad.id,
        jenis: input.jenis,
        outstandingPokok: dariSen(pokokSen),
        outstandingJasa: dariSen(jasaSen),
        penyisihanTersedia: dariSen(0n),
        penyisihanDipakai: dariSen(0n),
        kekuranganPenyisihan: dariSen(0n),
        eventJurnal: [] as string[],
      };

      // The refusals the write path makes, said BEFORE the button rather than
      // after it. `penolakan` is prose, not a thrown error: a preview that
      // 409s cannot show the operator the four figures it exists to show.
      if (input.jenis === "PENGHAPUSAN_BERSYARAT") {
        return {
          ...kosong,
          penolakan:
            "Belum ada pemetaan jurnal yang disahkan untuk penghapusan bersyarat, " +
            "jadi tindakan ini akan ditolak dan tidak akan ditebak.",
        };
      }
      if (await repo.pengakhiranAda(db, akad.id)) {
        return { ...kosong, penolakan: "Akad ini sudah punya catatan pengakhiran." };
      }
      if (input.jenis === "LUNAS_DIPERCEPAT") {
        const bisa = akad.status === "LUNAS" && pokokSen === 0n && jasaSen === 0n;
        return {
          ...kosong,
          penolakan: bisa
            ? null
            : "Akad ini belum lunas, jadi pengakhiran lunas dipercepat akan ditolak.",
        };
      }
      if (!STATUS_PIUTANG_AKTIF.has(akad.status)) {
        return {
          ...kosong,
          penolakan: `Status akad ${akad.status} tidak bisa dihapusbukukan.`,
        };
      }

      // HAPUS_BUKU. The SAME split the write path applies: the allowance
      // already carried is consumed FIRST, and only the remainder becomes a
      // shortfall charged as its own event. Four figures, never one.
      const akunPenyisihan = await repo.akunPenyisihan(db, ctx.bumnId, EVENT_HAPUS_BUKU);
      if (!akunPenyisihan) {
        return {
          ...kosong,
          penolakan:
            "Belum ada pemetaan jurnal yang disahkan untuk hapus buku, jadi tindakan ini akan ditolak.",
        };
      }
      const saldo = bacaUang(
        await repo.saldoNormalAkun(db, ctx.bumnId, akunPenyisihan, input.tanggal),
      );
      const saldoSen = saldo.bentuk === "ok" ? saldo.sen : 0n;
      const tersedia = saldoSen > 0n ? saldoSen : 0n;
      const dipakai = tersedia < pokokSen ? tersedia : pokokSen;
      const kekurangan = pokokSen - dipakai;

      const eventJurnal: string[] = [];
      if (dipakai > 0n) eventJurnal.push(EVENT_HAPUS_BUKU);
      if (kekurangan > 0n) eventJurnal.push(EVENT_HAPUS_BUKU_KEKURANGAN);

      return {
        akadId: akad.id,
        jenis: input.jenis,
        outstandingPokok: dariSen(pokokSen),
        outstandingJasa: dariSen(jasaSen),
        penyisihanTersedia: dariSen(tersedia),
        penyisihanDipakai: dariSen(dipakai),
        kekuranganPenyisihan: dariSen(kekurangan),
        eventJurnal,
        penolakan: null,
      };
    },

    async daftarCluster(filter, ctx): Promise<BarisCluster[]> {
      return clusterDalamCabang(filter, ctx);
    },

    async detailCluster(clusterId, ctx): Promise<BarisCluster> {
      const cabangRows = await db.query<{ cabang_id: string }>(
        `select cabang_id::text as cabang_id from cluster where id = $1::uuid and deleted_at is null`,
        [clusterId],
      );
      const row = cabangRows[0];
      if (!row) throw tolak("CLUSTER_TIDAK_DITEMUKAN", { clusterId });
      wajibScope(ctx, row.cabang_id);
      const semua = await clusterDalamCabang({ cabangId: row.cabang_id }, ctx);
      const satu = semua.find((c) => c.id === clusterId);
      if (!satu) throw tolak("CLUSTER_TIDAK_DITEMUKAN", { clusterId });
      return satu;
    },

    async anggotaCluster(clusterId, ctx, opsi): Promise<BarisAnggotaCluster[]> {
      const cabangRows = await db.query<{ cabang_id: string }>(
        `select cabang_id::text as cabang_id from cluster where id = $1::uuid and deleted_at is null`,
        [clusterId],
      );
      const row = cabangRows[0];
      if (!row) throw tolak("CLUSTER_TIDAK_DITEMUKAN", { clusterId });
      wajibScope(ctx, row.cabang_id);

      const rows = await db.query<{
        cluster_id: string;
        mitra_id: string;
        tanggal_masuk: string;
        tanggal_keluar: string | null;
        alasan_keluar: string | null;
        mitra_kode: string;
        mitra_nama: string;
        kolektibilitas: string | null;
        outstanding_pokok: string | null;
      }>(
        `select ca.cluster_id::text as cluster_id, ca.mitra_id::text as mitra_id,
                ca.tanggal_masuk::text as tanggal_masuk, ca.tanggal_keluar::text as tanggal_keluar,
                ca.alasan_keluar, m.kode_mitra as mitra_kode, m.nama_lengkap as mitra_nama,
                k.kolektibilitas, a.outstanding_pokok::text as outstanding_pokok
           from cluster_anggota ca
           join mitra m on m.id = ca.mitra_id
           left join lateral (
             select * from pumk_akad ak
              where ak.mitra_id = ca.mitra_id and ak.deleted_at is null
                and ak.status in ('AKTIF','RESCHEDULED','MACET')
              order by ak.tanggal_akad desc limit 1
           ) a on true
           left join lateral (
             select ks.kolektibilitas from kolektibilitas_snapshot ks
              join periode pr on pr.id = ks.periode_id
             where ks.akad_id = a.id and ks.deleted_at is null
             order by pr.tahun desc, pr.bulan desc limit 1
           ) k on true
          where ca.cluster_id = $1::uuid and ca.deleted_at is null
            and ($2::date is null
                 or (ca.tanggal_masuk <= $2::date
                     and (ca.tanggal_keluar is null or ca.tanggal_keluar > $2::date)))
          order by m.kode_mitra asc`,
        [clusterId, opsi?.padaTanggal ?? null],
      );
      return rows.map((b) => ({
        clusterId: b.cluster_id,
        mitraId: b.mitra_id,
        tanggalMasuk: b.tanggal_masuk,
        tanggalKeluar: b.tanggal_keluar,
        alasanKeluar: b.alasan_keluar,
        mitraKode: b.mitra_kode,
        mitraNama: b.mitra_nama,
        kolektibilitas: b.kolektibilitas,
        outstandingPokok: (b.outstanding_pokok ?? null) as Uang | null,
      }));
    },

    async cariMitra(input, ctx): Promise<RingkasanMitra[]> {
      const cabangIds = cabangDiminta(ctx, input.cabangId);
      if (cabangIds.length === 0) return [];
      const rows = await db.query<MitraRow>(
        `${PILIH_MITRA}
          where m.deleted_at is null
            and m.cabang_id = any($1::uuid[])
            and ($2::text is null
                 or m.nama_lengkap ilike '%' || $2 || '%'
                 or m.nik ilike '%' || $2 || '%'
                 or m.kode_mitra ilike '%' || $2 || '%')
          order by m.nama_lengkap asc
          limit 50`,
        [cabangIds, input.cari ?? null],
      );
      return rows.map(mitraDari);
    },

    async detailMitra(mitraId, ctx): Promise<RingkasanMitra> {
      const rows = await db.query<MitraRow & { cabang_id: string }>(
        `${PILIH_MITRA} where m.id = $1::uuid and m.deleted_at is null`,
        [mitraId],
      );
      const row = rows[0];
      if (!row) throw tolak("MITRA_TIDAK_DITEMUKAN", { mitraId });
      wajibScope(ctx, row.cabang_id);
      return mitraDari(row);
    },

    async daftarSektor(ctx): Promise<OpsiReferensi[]> {
      return db.query<OpsiReferensi>(
        `select id::text as id, kode, nama from sektor_pumk
          where bumn_id = $1::uuid and aktif and deleted_at is null
          order by urutan asc, kode asc`,
        [ctx.bumnId],
      );
    },

    async daftarAkunKas(ctx): Promise<OpsiReferensi[]> {
      // Spec 4.2 marks them with `is_kas`, and the engine refuses any other
      // account with AKUN_KAS_TIDAK_VALID, so the picker offers only these.
      return db.query<OpsiReferensi>(
        `select id::text as id, kode, nama from akun
          where bumn_id = $1::uuid and is_kas and is_postable and aktif and deleted_at is null
          order by kode asc`,
        [ctx.bumnId],
      );
    },
  };
}

interface MitraRow {
  id: string;
  cabang_id: string;
  kode_mitra: string;
  nama_lengkap: string;
  nik: string | null;
  telepon: string | null;
  alamat: string | null;
  nama_usaha: string | null;
  sektor_id: string | null;
  sektor_nama: string | null;
  bidang_usaha: string | null;
  kota_nama: string | null;
  status: string;
  is_mitra_lama: boolean;
  cluster_id: string | null;
  cluster_nama: string | null;
  jumlah_pinjaman_aktif: number;
  jumlah_pinjaman_selesai: number;
  outstanding_pokok: string | null;
  kolektibilitas_terakhir: string | null;
}

const PILIH_MITRA = `select m.id::text as id, m.cabang_id::text as cabang_id, m.kode_mitra,
    m.nama_lengkap, m.nik, m.telepon, m.alamat, m.nama_usaha,
    m.sektor_id::text as sektor_id, s.nama as sektor_nama, m.bidang_usaha,
    kt.nama as kota_nama, m.status, m.is_mitra_lama,
    m.cluster_id::text as cluster_id, cl.nama as cluster_nama,
    (select count(*)::int from pumk_akad a
      where a.mitra_id = m.id and a.deleted_at is null
        and a.status in ('BELUM_CAIR','AKTIF','RESCHEDULED','MACET')) as jumlah_pinjaman_aktif,
    (select count(*)::int from pumk_akad a
      where a.mitra_id = m.id and a.deleted_at is null
        and a.status in ('LUNAS','HAPUS_BUKU')) as jumlah_pinjaman_selesai,
    aktif.outstanding_pokok::text as outstanding_pokok,
    kol.kolektibilitas as kolektibilitas_terakhir
  from mitra m
  left join sektor_pumk s on s.id = m.sektor_id
  left join kota kt on kt.id = m.kota_id
  left join cluster cl on cl.id = m.cluster_id
  left join lateral (
    select * from pumk_akad a
     where a.mitra_id = m.id and a.deleted_at is null
       and a.status in ('AKTIF','RESCHEDULED','MACET')
     order by a.tanggal_akad desc limit 1
  ) aktif on true
  left join lateral (
    select ks.kolektibilitas from kolektibilitas_snapshot ks
     join periode pr on pr.id = ks.periode_id
    where ks.akad_id = aktif.id and ks.deleted_at is null
    order by pr.tahun desc, pr.bulan desc limit 1
  ) kol on true`;

function mitraDari(b: MitraRow): RingkasanMitra {
  return {
    id: b.id,
    kodeMitra: b.kode_mitra,
    namaLengkap: b.nama_lengkap,
    nik: b.nik,
    telepon: b.telepon,
    alamat: b.alamat,
    namaUsaha: b.nama_usaha,
    sektorId: b.sektor_id,
    sektorNama: b.sektor_nama,
    bidangUsaha: b.bidang_usaha,
    kotaNama: b.kota_nama,
    status: b.status,
    isMitraLama: b.is_mitra_lama,
    clusterId: b.cluster_id,
    clusterNama: b.cluster_nama,
    jumlahPinjamanAktif: Number(b.jumlah_pinjaman_aktif ?? 0),
    jumlahPinjamanSelesai: Number(b.jumlah_pinjaman_selesai ?? 0),
    outstandingPokok: (b.outstanding_pokok ?? null) as Uang | null,
    kolektibilitasTerakhir: b.kolektibilitas_terakhir,
  };
}
