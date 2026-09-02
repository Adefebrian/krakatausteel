// PUMK: 150 proposals across EVERY state, 90 live contracts, and twenty four
// months of repayment behaviour.
//
// EVERY ROW HERE IS PRODUCED BY THE PUMK STATE MACHINE. There is no shortcut
// path that writes `pumk_proposal` with a status of DICAIRKAN: a proposal that
// reaches disbursement walks DRAFT to SURVEY_PENDING to SURVEY_SELESAI to
// REVIEW_CHECKER to MENUNGGU_PERSETUJUAN to DISETUJUI to AKAD_DIBUAT to
// JADWAL_SIAP to DICAIRKAN, with a different account acting at each step
// because the segregation triggers refuse anything else. That is slower than
// an INSERT by two orders of magnitude and it is the only way the demo's
// timeline, approval trail and journal set are real.
import type { MetodePerhitungan, StatusProposal } from "../../modules/pumk";
import type { Dunia } from "./dunia";
import type { MitraDemo } from "./mitra";
import {
  keSen,
  pokokWajar,
  rp,
  sen,
  tanggal,
  tanggalTambahHari,
  type Dadu,
  type Uang,
} from "./acak";

export type Perilaku =
  | "TEPAT_WAKTU"
  | "SERING_TERLAMBAT"
  | "MACET"
  | "LUNAS_DIPERCEPAT"
  | "RESCHEDULE"
  | "KELEBIHAN";

/** Spec 13: 150 proposals, 90 of them disbursed. */
export const JUMLAH_PROPOSAL = 150;
export const JUMLAH_AKAD = 90;

/**
 * `batasan.tenor_max_bulan`, the shipped default (36 months, PER-1/MBU/03/2023
 * Pasal 22). Mirrored here rather than read, because this is PLANNING: the
 * engine reads the configuration row and is the authority, and this constant
 * only keeps the generator from proposing a combination the engine will
 * rightly refuse. If an operator lowers the row, the engine still wins and the
 * plan simply proposes more than it needs to.
 */
const TENOR_MAKS = 36;

/**
 * How the 150 spread across the states. EVERY state of the spec 9.1 machine is
 * represented, including the two that a happy-path seed always forgets:
 * TIDAK_DIREKOMENDASIKAN (the Checker said no) and DITOLAK (the Approver said
 * no). A demo whose pipeline has no rejections cannot show the control the
 * client is buying.
 */
export const SEBARAN_STATUS: ReadonlyArray<{ status: StatusProposal; jumlah: number }> = [
  { status: "DRAFT", jumlah: 8 },
  { status: "SURVEY_PENDING", jumlah: 7 },
  { status: "SURVEY_SELESAI", jumlah: 7 },
  { status: "REVIEW_CHECKER", jumlah: 7 },
  { status: "MENUNGGU_PERSETUJUAN", jumlah: 6 },
  { status: "DISETUJUI", jumlah: 5 },
  { status: "AKAD_DIBUAT", jumlah: 4 },
  { status: "JADWAL_SIAP", jumlah: 4 },
  { status: "TIDAK_DIREKOMENDASIKAN", jumlah: 6 },
  { status: "DITOLAK", jumlah: 6 },
  { status: "DICAIRKAN", jumlah: JUMLAH_AKAD },
];

export interface RencanaProposal {
  mitra: MitraDemo;
  status: StatusProposal;
  /** Index into `dunia.periode`: the month every date of this proposal lives in. */
  bulanIdx: number;
  hari: number;
  pokok: number;
  tenor: number;
  metode: MetodePerhitungan;
  grace: number;
  perilaku: Perilaku;
  tujuan: string;
  /** Set when the proposal is a converted portal submission (spec 9.5). */
  submissionId: string | null;
}

const TUJUAN = [
  "Tambahan modal kerja pembelian bahan baku",
  "Pembelian mesin jahit dan peralatan produksi",
  "Renovasi kios dan penambahan etalase",
  "Pembelian bibit dan pakan ternak",
  "Modal kerja musim panen",
  "Pengadaan kendaraan angkut roda tiga",
  "Penambahan stok dagangan menjelang hari raya",
  "Pembelian freezer dan alat pendingin",
];

const CATATAN_TOLAK = [
  "Kapasitas usaha belum memadai untuk plafon yang diajukan",
  "Agunan tidak memenuhi ketentuan dan omzet tidak terverifikasi",
  "Mitra masih memiliki tunggakan di lembaga lain",
];

const CATATAN_TIDAK_REKOMENDASI = [
  "Skor survey di bawah ambang minimum dan tempat usaha tidak aktif",
  "Data usaha tidak konsisten dengan hasil kunjungan lapangan",
  "Legalitas usaha belum lengkap saat verifikasi",
];

/**
 * The plan, built once and deterministically.
 *
 * MITRA ALLOCATION IS A CONSTRAINT, NOT A PREFERENCE.
 * `maks_pinjaman_aktif_per_mitra` is 1 and `pumk_akad_satu_aktif_per_mitra_uq`
 * covers BELUM_CAIR as well, so a mitra can hold at most one akad in the whole
 * world. The 90 disbursed and the 8 akad-stage proposals therefore need 98
 * distinct partners, and the 52 proposals that never reach an akad are shared
 * out over the remaining 22.
 */
export function rencanakanPumk(
  mitra: readonly MitraDemo[],
  jumlahBulan: number,
  d: Dadu,
): RencanaProposal[] {
  const perluAkad: StatusProposal[] = ["AKAD_DIBUAT", "JADWAL_SIAP", "DICAIRKAN"];
  const urutan: StatusProposal[] = [];
  for (const s of SEBARAN_STATUS) for (let i = 0; i < s.jumlah; i += 1) urutan.push(s.status);
  if (urutan.length !== JUMLAH_PROPOSAL) {
    throw new Error(`seed demo: sebaran status berjumlah ${urutan.length}, bukan ${JUMLAH_PROPOSAL}`);
  }
  // Akad-bearing states first, so each one gets a partner of its own.
  urutan.sort((a, b) => Number(perluAkad.includes(b)) - Number(perluAkad.includes(a)));

  const butuhMitraSendiri = urutan.filter((s) => perluAkad.includes(s)).length;
  const sisaMitra = mitra.slice(butuhMitraSendiri);
  if (sisaMitra.length === 0) throw new Error("seed demo: mitra habis sebelum proposal tanpa akad");

  const rencana: RencanaProposal[] = [];
  urutan.forEach((status, i) => {
    const m = perluAkad.includes(status) ? mitra[i]! : sisaMitra[(i - butuhMitraSendiri) % sisaMitra.length]!;
    const pokok = pokokWajar(d);
    // Disbursed loans spread over the whole window, up to and including last
    // month, so the portfolio has both two year old loans deep in their
    // schedule and freshly signed ones, and so the CURRENT month's budget
    // realisation is not a row of zeroes. Everything still in the pipeline
    // clusters in the recent months, which is what a live pipeline looks like.
    const bulanIdx =
      status === "DICAIRKAN"
        ? d.int(0, Math.max(0, jumlahBulan - 2))
        : d.int(Math.max(0, jumlahBulan - 5), jumlahBulan - 1);
    const tenor = d.pilih([12, 12, 18, 24, 24, 24, 36]);
    // GRACE IS CLAMPED TO THE TENOR CEILING, not drawn independently.
    // `tenor_max_bulan` is 36 and the instalment engine checks GRACE + TENOR
    // against it, so a 36 month loan with a 3 month grace is refused at
    // schedule generation. Drawing the two independently makes that a rare,
    // seed-dependent explosion twenty months into a replay, which is the worst
    // kind of defect a generator can have.
    const grace = d.peluang(0.15) ? Math.max(0, Math.min(d.int(1, 3), TENOR_MAKS - tenor)) : 0;
    rencana.push({
      mitra: m,
      status,
      bulanIdx,
      hari: d.int(1, 12),
      pokok,
      tenor,
      metode: d.pilih<MetodePerhitungan>(["FLAT", "FLAT", "FLAT", "FLAT", "EFEKTIF", "ANUITAS"]),
      grace,
      perilaku: d.bobot<Perilaku>({
        TEPAT_WAKTU: 34,
        SERING_TERLAMBAT: 24,
        MACET: 12,
        LUNAS_DIPERCEPAT: 12,
        RESCHEDULE: 12,
        KELEBIHAN: 6,
      }),
      tujuan: d.pilih(TUJUAN),
      submissionId: null,
    });
  });

  // Four disbursements pinned to the two most recent months, so the CURRENT
  // month's budget-versus-realisation row is never an accidental zero. Left to
  // the dice, a uniform draw over twenty four months puts nothing in the last
  // one about a third of the time, and "realisasi Rp 0" on the one screen a
  // budget holder opens first reads as a broken report rather than as a quiet
  // month.
  const dicairkan = rencana.filter((r) => r.status === "DICAIRKAN");
  const terbaru = [jumlahBulan - 1, jumlahBulan - 1, jumlahBulan - 2, jumlahBulan - 2];
  terbaru.forEach((bulanIdx, i) => {
    const target = dicairkan[dicairkan.length - 1 - i];
    if (target && bulanIdx >= 0) target.bulanIdx = bulanIdx;
  });

  return rencana;
}

export interface AkadHidup {
  akadId: string;
  proposalId: string;
  mitraId: string;
  cabangKode: string;
  perilaku: Perilaku;
  pokok: number;
  tenor: number;
  grace: number;
  /** The tenor a restructure may extend to, capped by `tenor_max_bulan`. */
  tenorReschedule: number;
  /** Instalments settled so far, used to time the behaviour switches. */
  dibayar: number;
  lagHari: number;
  berhentiSetelah: number;
  pelunasanKe: number;
  rescheduleSetelah: number;
  sudahReschedule: boolean;
  kelebihanKe: number;
  ditagih: boolean;
  selesai: boolean;
}

/** Runs one proposal from DRAFT to its target status, all inside one month. */
export async function jalankanProposal(
  dunia: Dunia,
  r: RencanaProposal,
  d: Dadu,
): Promise<AkadHidup | null> {
  const periode = dunia.periode[r.bulanIdx];
  if (!periode) throw new Error(`seed demo: periode index ${r.bulanIdx} tidak ada`);
  const trio = dunia.petugas[r.mitra.cabangKode];
  if (!trio) throw new Error(`seed demo: cabang ${r.mitra.cabangKode} tanpa petugas`);
  const maker = dunia.ctx(trio.maker);
  const checker = dunia.ctx(trio.checker);
  const approver = dunia.ctx(trio.approver);

  const hari = (offset: number): string =>
    tanggal(periode.tahun, periode.bulan, r.hari + offset);

  // --- DRAFT -------------------------------------------------------------
  dunia.jam.ke(hari(0));
  const proposal =
    r.submissionId === null
      ? await dunia.pumk.buatProposal(
          {
            cabangId: r.mitra.cabangId,
            mitraId: r.mitra.id,
            sektorId: r.mitra.sektorId,
            tanggalProposal: hari(0),
            jumlahDiajukan: rp(r.pokok),
            tenorDiajukan: r.tenor,
            tujuanPenggunaan: r.tujuan,
          },
          maker,
        )
      : await dunia.pumk.konversiSubmissionPortal(
          {
            submissionId: r.submissionId,
            cabangId: r.mitra.cabangId,
            mitraId: r.mitra.id,
            sektorId: r.mitra.sektorId,
            tanggalProposal: hari(0),
            catatanPetugas: "Dikonversi dari pengajuan portal setelah verifikasi berkas",
          },
          maker,
        );

  await dunia.pumk.tambahJaminan(
    proposal.id,
    r.pokok > 50_000_000
      ? {
          jenis: d.pilih(["BPKB", "SHM", "SHGB"]),
          deskripsi: "Agunan diterima dan diverifikasi petugas",
          nilaiTaksasi: rp(Math.round((r.pokok * 1.4) / 1_000_000) * 1_000_000),
          nomorDokumen: `AG-${proposal.noProposal.replace(/\W+/g, "")}`,
          atasNama: r.mitra.nama,
          lokasi: r.mitra.cabangKode === "01" ? "Cilegon" : "Serang",
          tanggalTerima: hari(0),
        }
      : { jenis: "TANPA_JAMINAN", deskripsi: "Plafon di bawah ambang wajib jaminan" },
    maker,
  );
  if (r.status === "DRAFT") return null;

  // --- SURVEY ------------------------------------------------------------
  dunia.jam.ke(hari(1));
  await dunia.pumk.submitUntukSurvey(proposal.id, "Berkas lengkap, dijadwalkan survey lapangan", maker);
  if (r.status === "SURVEY_PENDING") return null;

  const gagalSurvey = r.status === "TIDAK_DIREKOMENDASIKAN";
  const skor = gagalSurvey ? d.int(70, 78) : d.int(76, 94);
  dunia.jam.ke(hari(3));
  await dunia.pumk.inputSurvey(
    {
      proposalId: proposal.id,
      tanggalSurvey: hari(3),
      petugasKaryawanId: dunia.karyawan[r.mitra.cabangKode] ?? null,
      hasil: {
        karakter: d.pilih(["BAIK", "BAIK", "CUKUP"]),
        kapasitas_usaha: d.pilih(["BAIK", "CUKUP", "CUKUP"]),
        tempat_usaha: d.pilih(["MILIK_SENDIRI", "SEWA"]),
        agunan: r.pokok > 50_000_000 ? "ADA" : "TIDAK_ADA",
        riwayat_pinjaman: d.pilih(["LANCAR", "BARU", "LANCAR"]),
        catatan_lapangan: "Usaha berjalan, stok terlihat, pembukuan sederhana ada",
      },
      skorTotal: `${skor}`,
      plafonRekomendasi: rp(r.pokok),
      tenorRekomendasi: r.tenor,
      catatan: "Hasil kunjungan lapangan terlampir",
    },
    maker,
  );
  if (r.status === "SURVEY_SELESAI") return null;

  dunia.jam.ke(hari(4));
  await dunia.pumk.ajukanKeChecker(proposal.id, "Diteruskan untuk review", maker);
  if (r.status === "REVIEW_CHECKER") return null;

  // --- REVIEW ------------------------------------------------------------
  dunia.jam.ke(hari(5));
  if (r.status === "TIDAK_DIREKOMENDASIKAN") {
    await dunia.pumk.review(
      {
        proposalId: proposal.id,
        tanggal: hari(5),
        keputusan: "TIDAK_REKOMENDASI",
        catatan: d.pilih(CATATAN_TIDAK_REKOMENDASI),
      },
      checker,
    );
    return null;
  }
  await dunia.pumk.review(
    {
      proposalId: proposal.id,
      tanggal: hari(5),
      keputusan: "REKOMENDASI",
      catatan: "Data survey konsisten, direkomendasikan sesuai plafon usulan",
    },
    checker,
  );
  if (r.status === "MENUNGGU_PERSETUJUAN") return null;

  // --- APPROVAL ----------------------------------------------------------
  dunia.jam.ke(hari(7));
  if (r.status === "DITOLAK") {
    await dunia.pumk.putuskanPersetujuan(
      {
        proposalId: proposal.id,
        tanggal: hari(7),
        keputusan: "TOLAK",
        catatan: d.pilih(CATATAN_TOLAK),
      },
      approver,
    );
    return null;
  }
  // A quarter of approvals cut the plafon, which is what makes the approval
  // row worth reading: the akad is built from the DECISION, not the request.
  const dipotong = d.peluang(0.25);
  const disetujui = dipotong ? Math.round((r.pokok * 0.8) / 500_000) * 500_000 : r.pokok;
  await dunia.pumk.putuskanPersetujuan(
    {
      proposalId: proposal.id,
      tanggal: hari(7),
      keputusan: "SETUJU",
      plafonDisetujui: rp(disetujui),
      tenorDisetujui: r.tenor,
      catatan: dipotong ? "Disetujui dengan penyesuaian plafon sesuai kapasitas usaha" : null,
    },
    approver,
  );
  if (r.status === "DISETUJUI") return null;

  // --- AKAD --------------------------------------------------------------
  const tanggalAkad = hari(9);
  const mulaiAngsuran = tanggalTambahHari(tanggalAkad, 30 * (r.grace + 1));
  dunia.jam.ke(tanggalAkad);
  const akad = await dunia.pumk.buatAkad(
    {
      proposalId: proposal.id,
      tanggalAkad,
      tanggalMulaiAngsuran: mulaiAngsuran,
      gracePeriodBulan: r.grace,
      metodePerhitungan: r.metode,
      pathDokumenAkad: `akad/${proposal.noProposal.replace(/\W+/g, "-")}.pdf`,
    },
    maker,
  );
  if (r.status === "AKAD_DIBUAT") return null;

  await dunia.pumk.generateJadwal(akad.id, maker);
  if (r.status === "JADWAL_SIAP") return null;

  // --- PENCAIRAN ---------------------------------------------------------
  const tanggalCair = hari(11);
  dunia.jam.ke(tanggalCair);
  await dunia.pumk.catatPencairan(
    {
      akadId: akad.id,
      tanggalPencairan: tanggalCair,
      jumlah: akad.pokokPinjaman,
      akunKasId: dunia.akun["1.1.02"]!,
      noBukti: `BKK/${proposal.noProposal.split("/").pop() ?? "0001"}`,
      keterangan: `Pencairan PUMK ${r.mitra.nama} (${r.mitra.namaUsaha})`,
    },
    maker,
  );

  // `tenor_max_bulan` is 36 (PER-1/MBU/03/2023 caps PUMK at three years) and
  // the instalment engine checks grace + tenor against it, so a restructure
  // that would blow through the ceiling is not a restructure at all. A loan
  // with no headroom simply carries a different behaviour instead of being
  // pushed into a refusal the demo would have to explain.
  const tenorReschedule = Math.min(akad.tenorBulan + 6, TENOR_MAKS - r.grace);
  const perilaku: Perilaku =
    r.perilaku === "RESCHEDULE" && tenorReschedule <= akad.tenorBulan
      ? "SERING_TERLAMBAT"
      : r.perilaku;

  return {
    akadId: akad.id,
    proposalId: proposal.id,
    mitraId: r.mitra.id,
    cabangKode: r.mitra.cabangKode,
    perilaku,
    pokok: keSen(akad.pokokPinjaman) === 0n ? r.pokok : Number(keSen(akad.pokokPinjaman) / 100n),
    tenor: akad.tenorBulan,
    grace: r.grace,
    tenorReschedule,
    dibayar: 0,
    lagHari: d.int(8, 40),
    berhentiSetelah: d.int(1, 3),
    pelunasanKe: Math.max(2, Math.round(akad.tenorBulan * 0.55)),
    rescheduleSetelah: Math.max(2, Math.round(akad.tenorBulan * 0.3)),
    sudahReschedule: false,
    kelebihanKe: d.int(2, 5),
    ditagih: false,
    selesai: false,
  };
}

interface BarisJadwalDb {
  id: string;
  angsuran_ke: number;
  jt: string;
  sisa: string;
}

async function jadwalTertunggak(dunia: Dunia, akadId: string, sampai: string): Promise<BarisJadwalDb[]> {
  return dunia.db.query<BarisJadwalDb>(
    `SELECT id::text AS id, angsuran_ke::int AS angsuran_ke,
            tanggal_jatuh_tempo::text AS jt,
            (total - pokok_terbayar - jasa_terbayar)::text AS sisa
       FROM pumk_jadwal_angsuran
      WHERE akad_id = $1::uuid AND deleted_at IS NULL AND is_active_version
        AND status NOT IN ('LUNAS', 'DIRESCHEDULE')
        AND tanggal_jatuh_tempo <= $2::date
      ORDER BY angsuran_ke`,
    [akadId, sampai],
  );
}

async function sisaSeluruhnya(dunia: Dunia, akadId: string): Promise<Uang> {
  const rows = await dunia.db.query<{ sisa: string }>(
    `SELECT coalesce(sum(total - pokok_terbayar - jasa_terbayar), 0)::text AS sisa
       FROM pumk_jadwal_angsuran
      WHERE akad_id = $1::uuid AND deleted_at IS NULL AND is_active_version
        AND status NOT IN ('LUNAS', 'DIRESCHEDULE')`,
    [akadId],
  );
  return rows[0]?.sisa ?? "0.00";
}

async function outstandingAkad(
  dunia: Dunia,
  akadId: string,
): Promise<{ status: string; pokok: Uang; jasa: Uang }> {
  const rows = await dunia.db.query<{ status: string; pokok: string; jasa: string }>(
    `SELECT status, outstanding_pokok::text AS pokok, outstanding_jasa::text AS jasa
       FROM pumk_akad WHERE id = $1::uuid`,
    [akadId],
  );
  const r = rows[0];
  if (!r) throw new Error(`seed demo: akad ${akadId} hilang`);
  return { status: r.status, pokok: r.pokok, jasa: r.jasa };
}

export interface RingkasanBulan {
  setoran: number;
  reschedule: number;
  pelunasan: number;
  hapusBuku: number;
  tindakLanjut: number;
}

/**
 * One month of an akad's life. Called for every live akad, in the month whose
 * period is OPEN, so every receipt is dated inside a period the ledger accepts.
 */
export async function langkahBulananAkad(
  dunia: Dunia,
  st: AkadHidup,
  periode: { mulai: string; akhir: string },
  d: Dadu,
  ring: RingkasanBulan,
): Promise<void> {
  if (st.selesai) return;
  const trio = dunia.petugas[st.cabangKode];
  if (!trio) return;
  const maker = dunia.ctx(trio.maker);
  const approver = dunia.ctx(trio.approver);

  const bayar = async (tgl: string, jumlah: Uang, catatan: string): Promise<void> => {
    if (keSen(jumlah) <= 0n) return;
    const tanggalBayar = tgl < periode.mulai ? periode.mulai : tgl > periode.akhir ? periode.akhir : tgl;
    dunia.jam.ke(tanggalBayar);
    await dunia.pumk.terimaAngsuran(
      {
        akadId: st.akadId,
        tanggalTerima: tanggalBayar,
        jumlah,
        akunKasId: dunia.akun["1.1.02"]!,
        noBukti: `BKM/${tanggalBayar.replace(/-/g, "")}/${st.akadId.slice(0, 6)}`,
        keterangan: catatan,
      },
      maker,
    );
    ring.setoran += 1;
  };

  const jatuhTempo = await jadwalTertunggak(dunia, st.akadId, periode.akhir);

  switch (st.perilaku) {
    case "TEPAT_WAKTU": {
      for (const b of jatuhTempo) {
        if (b.jt < periode.mulai) continue;
        await bayar(b.jt, b.sisa, `Angsuran ke ${b.angsuran_ke}`);
        st.dibayar += 1;
      }
      break;
    }

    case "KELEBIHAN": {
      // Pays on time, then settles the whole loan early and OVERSHOOTS.
      //
      // Overpaying a single instalment produces no `pumk_kelebihan` row at all:
      // the allocation order (tunggakan jasa, tunggakan pokok, jasa berjalan,
      // pokok berjalan, kelebihan) simply pushes the surplus onto the next
      // instalment. A genuine overpayment is one that exceeds EVERY remaining
      // obligation, which is also what really happens: a mitra rounds the
      // payoff figure up. Without this the demo's Kelebihan Pembayaran
      // Angsuran account, and with it the entire Liabilitas section of the
      // statement of financial position, is a row of zeroes.
      for (const b of jatuhTempo) {
        if (b.jt < periode.mulai) continue;
        await bayar(b.jt, b.sisa, `Angsuran ke ${b.angsuran_ke}`);
        st.dibayar += 1;
      }
      if (st.dibayar >= st.kelebihanKe) {
        const sisa = await sisaSeluruhnya(dunia, st.akadId);
        if (keSen(sisa) > 0n) {
          const lebih = BigInt(500_000 + (st.kelebihanKe % 4) * 500_000) * 100n;
          await bayar(
            tanggalTambahHari(periode.akhir, -3),
            sen(keSen(sisa) + lebih),
            "Pelunasan dibulatkan ke atas oleh mitra, selisihnya jadi kelebihan pembayaran",
          );
        }
        st.selesai = true;
      }
      break;
    }

    case "SERING_TERLAMBAT": {
      // Pays, but always after the due date, so the akad carries a real
      // ageing bucket instead of a cosmetic one.
      for (const b of jatuhTempo) {
        const bayarPada = tanggalTambahHari(b.jt, st.lagHari);
        if (bayarPada < periode.mulai || bayarPada > periode.akhir) continue;
        await bayar(bayarPada, b.sisa, `Angsuran ke ${b.angsuran_ke} (terlambat ${st.lagHari} hari)`);
        st.dibayar += 1;
      }
      break;
    }

    case "MACET": {
      for (const b of jatuhTempo) {
        if (b.jt < periode.mulai) continue;
        if (st.dibayar >= st.berhentiSetelah) break;
        await bayar(b.jt, b.sisa, `Angsuran ke ${b.angsuran_ke}`);
        st.dibayar += 1;
      }
      if (st.dibayar >= st.berhentiSetelah && jatuhTempo.length > 0) {
        const tertua = jatuhTempo[0]!;
        const umur = hariAntara(tertua.jt, periode.akhir);
        if (!st.ditagih && umur >= 60) {
          dunia.jam.ke(periode.akhir);
          await dunia.pumk.catatTindakLanjut(
            {
              akadId: st.akadId,
              tanggal: periode.akhir,
              jenis: umur >= 180 ? "SOMASI" : "SURAT_PERINGATAN",
              hasil: "Belum ada realisasi pembayaran",
              petugasKaryawanId: dunia.karyawan[st.cabangKode] ?? null,
              catatan: `Tunggakan ${umur} hari sejak angsuran ke ${tertua.angsuran_ke}`,
            },
            maker,
          );
          st.ditagih = true;
          ring.tindakLanjut += 1;
        }
        // Written off only once the arrears are unambiguously MACET, which is
        // what SK-277/MBU/10/2023 and the kolektibilitas ladder both require.
        if (umur >= 300) {
          dunia.jam.ke(periode.akhir);
          await dunia.pumk.catatPengakhiran(
            {
              akadId: st.akadId,
              jenis: "HAPUS_BUKU",
              tanggal: periode.akhir,
              dasarKeputusan: `Tunggakan ${umur} hari, upaya penagihan tidak berhasil`,
              noSk: `SK-HB/${periode.akhir.slice(0, 7).replace("-", "")}/${st.akadId.slice(0, 4)}`,
            },
            approver,
          );
          st.selesai = true;
          ring.hapusBuku += 1;
        }
      }
      break;
    }

    case "RESCHEDULE": {
      if (!st.sudahReschedule && st.dibayar >= st.rescheduleSetelah) {
        // Two missed instalments, then a restructure, which is the sequence
        // the reschedule screen exists for.
        const tertunggak = jatuhTempo.filter((b) => b.jt < periode.mulai).length;
        if (tertunggak >= 2) {
          const tglAjukan = tanggal(
            Number(periode.mulai.slice(0, 4)),
            Number(periode.mulai.slice(5, 7)),
            10,
          );
          dunia.jam.ke(tglAjukan);
          const r = await dunia.pumk.ajukanReschedule(
            {
              akadId: st.akadId,
              tanggalPengajuan: tglAjukan,
              alasan: "Omzet usaha turun, mitra mengajukan perpanjangan tenor",
              jenis: "PERPANJANG_TENOR",
              tenorBaru: st.tenorReschedule,
              catatan: "Disetujui setelah kunjungan dan verifikasi kemampuan bayar",
            },
            maker,
          );
          const tglSetuju = tanggalTambahHari(tglAjukan, 4);
          dunia.jam.ke(tglSetuju);
          await dunia.pumk.setujuiReschedule(r.id, approver);
          st.sudahReschedule = true;
          st.tenor = st.tenorReschedule;
          ring.reschedule += 1;
          break;
        }
      }
      if (!st.sudahReschedule && st.dibayar >= st.rescheduleSetelah) break; // arrears building
      for (const b of jatuhTempo) {
        if (b.jt < periode.mulai) continue;
        await bayar(b.jt, b.sisa, `Angsuran ke ${b.angsuran_ke}`);
        st.dibayar += 1;
      }
      break;
    }

    case "LUNAS_DIPERCEPAT": {
      for (const b of jatuhTempo) {
        if (b.jt < periode.mulai) continue;
        await bayar(b.jt, b.sisa, `Angsuran ke ${b.angsuran_ke}`);
        st.dibayar += 1;
      }
      if (st.dibayar >= st.pelunasanKe) {
        const sisa = await sisaSeluruhnya(dunia, st.akadId);
        if (keSen(sisa) > 0n) {
          const tglLunas =
            periode.akhir < periode.mulai ? periode.mulai : tanggalTambahHari(periode.akhir, -2);
          await bayar(tglLunas, sisa, "Pelunasan dipercepat atas permintaan mitra");
        }
        const setelah = await outstandingAkad(dunia, st.akadId);
        if (setelah.status === "LUNAS" && keSen(setelah.pokok) === 0n && keSen(setelah.jasa) === 0n) {
          dunia.jam.ke(periode.akhir);
          await dunia.pumk.catatPengakhiran(
            {
              akadId: st.akadId,
              jenis: "LUNAS_DIPERCEPAT",
              tanggal: periode.akhir,
              dasarKeputusan: "Seluruh kewajiban pokok dan jasa administrasi telah diterima",
            },
            approver,
          );
          ring.pelunasan += 1;
        }
        st.selesai = true;
      }
      break;
    }
  }

  if (!st.selesai) {
    const akad = await outstandingAkad(dunia, st.akadId);
    if (akad.status === "LUNAS" || akad.status === "HAPUS_BUKU") st.selesai = true;
  }
}

function hariAntara(dari: string, sampai: string): number {
  const a = Date.parse(`${dari}T00:00:00.000Z`);
  const b = Date.parse(`${sampai}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}
