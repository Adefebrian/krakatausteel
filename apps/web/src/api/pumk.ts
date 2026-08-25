// Typed client for the Pendanaan UMK module, spec 9.1.
//
// TYPES COME FROM THE CONTRACT, NOT FROM THIS FILE. Everything the engine
// already names is imported, type only, from
// apps/api/src/modules/pumk/contract.ts (and from modules/angsuran through
// it), exactly the way ../client.ts imports `AppType`: `import type` is
// erased by Bun's transpiler, so no server code, no pg, no Redis client
// reaches the bundle, and a drift in the contract becomes a type error here
// instead of a wrong screen.
//
// THE ENDPOINTS DO NOT EXIST YET, AND THAT IS VISIBLE. At the time these
// screens were built, modules/pumk deliberately has no routes.ts (its own
// index.ts says so) while its tests-first suite is written. So every function
// below currently answers 404, every page renders `ErrorState` with the real
// status in it, and nothing on any screen shows a number that did not come
// from the server. There is no stub, no sample row, and no offline mode:
// a fixture may stand in for a FAILURE, never for a VALIDATION.
//
// The paths follow the conventions the modules that DO have routes already
// use (apps/api/src/modules/organisasi/routes.ts): a list answers
// `{ data: [...] }`, a single resource answers the object itself, a command is
// a POST on the noun it changes.
import type {
  Akad,
  AnggotaCluster,
  BuatAkadInput,
  BuatProposalInput,
  FilterProposal,
  HasilPencairan,
  InputSurveyInput,
  JaminanInput,
  JenisTindakLanjut,
  KartuPiutang,
  KeputusanApprovalInput,
  KeputusanChecker,
  PencairanInput,
  Pengakhiran,
  PengakhiranInput,
  Proposal,
  StatusProposal,
  SumberPengajuan,
  Survey,
  TerimaAngsuranInput,
  TindakLanjut,
  TindakLanjutInput,
  TransisiProposal,
} from "@krakatausteel/api/src/modules/pumk/contract";
import type {
  HasilAlokasi,
  HasilReschedule,
  Jadwal,
  JenisReschedule,
  MetodePerhitungan,
  RateTahunan,
  Reschedule,
  SimulasiInput,
  TabelJadwal,
  Uang,
} from "@krakatausteel/api/src/modules/angsuran/contract";
import { apiGet, apiPost, apiUpload, buildQuery } from "./http";

export type {
  Akad,
  AnggotaCluster,
  HasilAlokasi,
  HasilPencairan,
  HasilReschedule,
  Jadwal,
  JenisReschedule,
  JenisTindakLanjut,
  KartuPiutang,
  KeputusanChecker,
  MetodePerhitungan,
  Pengakhiran,
  Proposal,
  RateTahunan,
  Reschedule,
  StatusProposal,
  SumberPengajuan,
  Survey,
  TabelJadwal,
  TindakLanjut,
  TransisiProposal,
  Uang,
};

interface Daftar<T> {
  data: T[];
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------
//
// The engine contract describes what is STORED. A list screen also needs the
// labels next to the ids: spec 9.1 asks for a proposal list searchable by
// "nama atau NIK" and filterable by sektor, which only means anything if the
// row carries the mitra's name, the mitra's NIK and the sektor's name. These
// interfaces name that read model. They add no field the spec's own tables
// (4.3, 4.4) do not already hold.

/**
 * One timeline row with the actor's NAME, not only the id spec 4.4 stores.
 * Spec 9.1 asks the timeline to show "siapa, kapan, catatan apa"; a page that
 * printed a UUID would satisfy none of that, so the read model joins the user.
 */
export interface BarisTransisi extends TransisiProposal {
  olehNama: string | null;
  olehRole: string | null;
}

export interface BarisProposal extends Proposal {
  mitraKode: string;
  mitraNama: string;
  mitraNik: string | null;
  sektorNama: string | null;
  cabangNama: string;
  /** Days since tanggal_proposal. Spec 9.1 list column "umur dokumen". */
  umurHari: number;
}

/** Everything the detail page and the checker's side by side view read. */
export interface DetailProposal {
  proposal: BarisProposal;
  survey: Survey | null;
  jaminan: BarisJaminan[];
  timeline: BarisTransisi[];
  /**
   * The checker's trail (spec 4.4 `pumk_review`). The approval screen needs
   * `reviewerUserId` to warn BEFORE the click that spec 2 rule 2 will refuse
   * an approver who reviewed the same document; the engine and the trigger
   * refuse it regardless.
   */
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

export interface BarisJaminan {
  id: string;
  proposalId: string;
  jenis: JaminanInput["jenis"];
  deskripsi: string | null;
  nilaiTaksasi: Uang | null;
  nomorDokumen: string | null;
  atasNama: string | null;
  lokasi: string | null;
  statusFisik: "DITERIMA" | "DIKEMBALIKAN" | null;
  tanggalTerima: string | null;
}

/** Spec 4.3 `mitra`, the fields the proposal form prefills from. */
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
  /** Live akad count. Spec 5.5 `maks_pinjaman_aktif_per_mitra`, default 1. */
  jumlahPinjamanAktif: number;
  /** Loans already settled. Drives the "mitra lama" prefill of spec 9.1. */
  jumlahPinjamanSelesai: number;
  outstandingPokok: Uang | null;
  kolektibilitasTerakhir: string | null;
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
  /** Outstanding split by kolektibilitas class, spec 5.1. */
  komposisiKolektibilitas: Array<{ kelas: string; jumlahAkad: number; outstandingPokok: Uang }>;
}

export interface BarisAnggotaCluster extends AnggotaCluster {
  mitraKode: string;
  mitraNama: string;
  kolektibilitas: string | null;
  outstandingPokok: Uang | null;
}

export interface OpsiReferensi {
  id: string;
  kode: string;
  nama: string;
}

/**
 * Spec 5.5's program bounds, read from `konfigurasi` and never from code. The
 * proposal form validates against these BEFORE submit, which is the whole
 * point of the endpoint: rejecting a plafon after a whole form has been typed
 * is the behaviour spec 9.1 complains about.
 */
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

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export function daftarProposal(filter: FilterProposal): Promise<Daftar<BarisProposal>> {
  return apiGet(
    `/pumk/proposal${buildQuery({
      cabangId: filter.cabangId,
      sektorId: filter.sektorId,
      status: filter.status,
      sumberPengajuan: filter.sumberPengajuan,
      dariTanggal: filter.dariTanggal,
      sampaiTanggal: filter.sampaiTanggal,
      cari: filter.cari,
    })}`,
  );
}

export function detailProposal(proposalId: string): Promise<DetailProposal> {
  return apiGet(`/pumk/proposal/${encodeURIComponent(proposalId)}`);
}

export function timelineProposal(proposalId: string): Promise<Daftar<BarisTransisi>> {
  return apiGet(`/pumk/proposal/${encodeURIComponent(proposalId)}/timeline`);
}

export function buatProposal(input: BuatProposalInput): Promise<Proposal> {
  return apiPost("/pumk/proposal", input);
}

export function submitUntukSurvey(proposalId: string, catatan: string | null): Promise<Proposal> {
  return apiPost(`/pumk/proposal/${encodeURIComponent(proposalId)}/submit-survey`, { catatan });
}

export function ajukanKeChecker(proposalId: string, catatan: string | null): Promise<Proposal> {
  return apiPost(`/pumk/proposal/${encodeURIComponent(proposalId)}/ajukan-checker`, { catatan });
}

export function tambahJaminan(proposalId: string, input: JaminanInput): Promise<{ id: string }> {
  return apiPost(`/pumk/proposal/${encodeURIComponent(proposalId)}/jaminan`, input);
}

export function daftarJaminan(proposalId: string): Promise<Daftar<BarisJaminan>> {
  return apiGet(`/pumk/proposal/${encodeURIComponent(proposalId)}/jaminan`);
}

export function inputSurvey(input: InputSurveyInput): Promise<Proposal> {
  return apiPost("/pumk/survey", input);
}

export function review(input: {
  proposalId: string;
  tanggal: string;
  keputusan: KeputusanChecker;
  catatan?: string | null;
}): Promise<Proposal> {
  return apiPost(`/pumk/proposal/${encodeURIComponent(input.proposalId)}/review`, input);
}

export function putuskanPersetujuan(input: KeputusanApprovalInput): Promise<Proposal> {
  return apiPost(`/pumk/proposal/${encodeURIComponent(input.proposalId)}/persetujuan`, input);
}

export function konversiSubmissionPortal(input: {
  submissionId: string;
  cabangId: string;
  mitraId: string;
  sektorId?: string | null;
  tanggalProposal: string;
  catatanPetugas?: string | null;
}): Promise<Proposal> {
  return apiPost("/pumk/portal/konversi", input);
}

// ---------------------------------------------------------------------------
// Akad, jadwal, pencairan, angsuran
// ---------------------------------------------------------------------------

export function daftarAkad(filter: {
  cabangId?: string | null;
  status?: string | null;
  kolektibilitas?: string | null;
  cari?: string | null;
}): Promise<Daftar<BarisAkad>> {
  return apiGet(`/pumk/akad${buildQuery(filter)}`);
}

export function detailAkad(akadId: string): Promise<BarisAkad> {
  return apiGet(`/pumk/akad/${encodeURIComponent(akadId)}`);
}

export function buatAkad(input: BuatAkadInput): Promise<Akad> {
  return apiPost("/pumk/akad", input);
}

export function generateJadwal(akadId: string): Promise<Jadwal> {
  return apiPost(`/pumk/akad/${encodeURIComponent(akadId)}/jadwal`);
}

/** Every version, newest first, with `isActiveVersion` marking the live one. */
export function riwayatJadwal(akadId: string): Promise<Daftar<Jadwal>> {
  return apiGet(`/pumk/akad/${encodeURIComponent(akadId)}/jadwal`);
}

export function catatPencairan(input: PencairanInput): Promise<HasilPencairan> {
  return apiPost("/pumk/pencairan", input);
}

export function terimaAngsuran(input: TerimaAngsuranInput): Promise<HasilAlokasi> {
  return apiPost("/pumk/angsuran", input);
}

/**
 * Spec 7.4's calculator. It goes through the API rather than being computed in
 * the browser on purpose: spec 7.5 item 11 requires the simulated table and
 * the generated table to be IDENTICAL, which only holds if one engine produces
 * both. A second implementation in the SPA would be a second answer.
 */
export function simulasiJadwal(input: SimulasiInput): Promise<TabelJadwal> {
  return apiPost("/pumk/simulasi", input);
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

export interface PratinjauReschedule {
  jadwalBerjalan: Jadwal;
  jadwalUsulan: TabelJadwal;
  pokokTerbayarHistoris: Uang;
  outstandingSaatIni: Uang;
}

/**
 * The preview spec 9.1 requires BEFORE submit. It stores nothing: it is the
 * same read the reschedule itself would produce, run without writing a
 * version, so the operator sees the new schedule next to the running one
 * before anything is recorded.
 */
export function pratinjauReschedule(input: {
  akadId: string;
  jenis: JenisReschedule;
  tenorBaru?: number | null;
  graceBaru?: number | null;
  jasaRateBaru?: RateTahunan | null;
}): Promise<PratinjauReschedule> {
  return apiPost("/pumk/reschedule/pratinjau", input);
}

export function ajukanReschedule(input: {
  akadId: string;
  tanggalPengajuan: string;
  alasan: string;
  jenis: JenisReschedule;
  tenorBaru?: number | null;
  graceBaru?: number | null;
  jasaRateBaru?: RateTahunan | null;
  catatan?: string | null;
}): Promise<Reschedule> {
  return apiPost("/pumk/reschedule", input);
}

export function setujuiReschedule(rescheduleId: string): Promise<HasilReschedule> {
  return apiPost(`/pumk/reschedule/${encodeURIComponent(rescheduleId)}/setujui`);
}

export function daftarReschedule(filter: {
  akadId?: string | null;
  status?: string | null;
}): Promise<Daftar<Reschedule>> {
  return apiGet(`/pumk/reschedule${buildQuery(filter)}`);
}

// ---------------------------------------------------------------------------
// Pengakhiran, penagihan, cluster
// ---------------------------------------------------------------------------

/**
 * What a pengakhiran WOULD record, computed without writing anything.
 *
 * A write-off is not one figure. The journal engine consumes the allowance
 * already carried for this receivable FIRST and routes only the remainder to a
 * shortfall event, so the screen has to show both components: an operator who
 * is told only "hapus buku 10.000.000,00" cannot tell whether the allowance
 * covered it, and a write-off presented as if the allowance always covers it
 * is a misstatement of what hits the ledger.
 *
 * `penolakan` carries the server's refusal when the operation has no
 * sanctioned event mapping (spec 6.4, ADR 0011): PENGHAPUSAN_BERSYARAT has
 * none, and the honest answer is to say so before the button, not after.
 */
export interface PratinjauPengakhiran {
  akadId: string;
  jenis: PengakhiranInput["jenis"];
  outstandingPokok: Uang;
  outstandingJasa: Uang;
  /** Allowance carried for this receivable at the moment of the preview. */
  penyisihanTersedia: Uang;
  /** Part of the outstanding principal the allowance absorbs. */
  penyisihanDipakai: Uang;
  /** Remainder that becomes a shortfall, charged as its own event. */
  kekuranganPenyisihan: Uang;
  /** Event codes that will be posted, in order. */
  eventJurnal: string[];
  /** Non null when the server will refuse this operation, with its reason. */
  penolakan: string | null;
}

export function pratinjauPengakhiran(input: {
  akadId: string;
  jenis: PengakhiranInput["jenis"];
  tanggal: string;
}): Promise<PratinjauPengakhiran> {
  return apiPost("/pumk/pengakhiran/pratinjau", input);
}

export function catatPengakhiran(input: PengakhiranInput): Promise<Pengakhiran> {
  return apiPost("/pumk/pengakhiran", input);
}

export function daftarPengakhiran(filter: { cabangId?: string | null }): Promise<Daftar<Pengakhiran>> {
  return apiGet(`/pumk/pengakhiran${buildQuery(filter)}`);
}

export function daftarTindakLanjut(akadId: string): Promise<Daftar<TindakLanjut>> {
  return apiGet(`/pumk/akad/${encodeURIComponent(akadId)}/tindak-lanjut`);
}

export function catatTindakLanjut(input: TindakLanjutInput): Promise<TindakLanjut> {
  return apiPost(`/pumk/akad/${encodeURIComponent(input.akadId)}/tindak-lanjut`, input);
}

export function daftarCluster(filter: { cabangId?: string | null; cari?: string | null }): Promise<
  Daftar<BarisCluster>
> {
  return apiGet(`/pumk/cluster${buildQuery(filter)}`);
}

export function detailCluster(clusterId: string): Promise<BarisCluster> {
  return apiGet(`/pumk/cluster/${encodeURIComponent(clusterId)}`);
}

export function anggotaCluster(
  clusterId: string,
  opsi: { padaTanggal?: string | null } = {},
): Promise<Daftar<BarisAnggotaCluster>> {
  return apiGet(`/pumk/cluster/${encodeURIComponent(clusterId)}/anggota${buildQuery(opsi)}`);
}

export function tambahAnggotaCluster(input: {
  clusterId: string;
  mitraId: string;
  tanggalMasuk: string;
}): Promise<AnggotaCluster> {
  return apiPost(`/pumk/cluster/${encodeURIComponent(input.clusterId)}/anggota`, input);
}

export function keluarkanAnggotaCluster(input: {
  clusterId: string;
  mitraId: string;
  tanggalKeluar: string;
  alasan: string;
}): Promise<AnggotaCluster> {
  return apiPost(`/pumk/cluster/${encodeURIComponent(input.clusterId)}/anggota/keluar`, input);
}

// ---------------------------------------------------------------------------
// Read models and references
// ---------------------------------------------------------------------------

/** Spec 9.1's Kartu Piutang, one call, one akad. */
export function kartuPiutang(akadId: string): Promise<KartuPiutang> {
  return apiGet(`/pumk/kartu-piutang/${encodeURIComponent(akadId)}`);
}

export function cariMitra(cari: string, cabangId?: string | null): Promise<Daftar<RingkasanMitra>> {
  return apiGet(`/pumk/mitra${buildQuery({ cari, cabangId })}`);
}

export function detailMitra(mitraId: string): Promise<RingkasanMitra> {
  return apiGet(`/pumk/mitra/${encodeURIComponent(mitraId)}`);
}

export function daftarSektor(): Promise<Daftar<OpsiReferensi>> {
  return apiGet("/konfigurasi/sektor");
}

/**
 * The cash and bank accounts a disbursement or a receipt may name. Spec 4.2
 * marks them with `is_kas` on the Bagan Akun, and the engine refuses any other
 * account with AKUN_KAS_TIDAK_VALID, so the form offers only these.
 */
export function daftarAkunKas(): Promise<Daftar<OpsiReferensi>> {
  return apiGet("/konfigurasi/akun?kas=true");
}

export function batasanPumk(): Promise<BatasanPumk> {
  return apiGet("/pumk/batasan");
}

/**
 * Stores one attachment and answers the path the engine's `lampiranFoto` and
 * `pathDokumen` columns hold. Called on submit, never earlier: a record must
 * not carry a filename for a file that was never stored.
 */
export function unggahLampiran(file: File, konteks: string): Promise<{ path: string }> {
  const form = new FormData();
  form.set("file", file);
  form.set("konteks", konteks);
  return apiUpload("/pumk/lampiran", form);
}
