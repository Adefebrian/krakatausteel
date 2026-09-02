// Non PUMK: 60 proposals across every state of the spec 9.2 machine, with the
// LPJ half of the life deliberately trailing the disbursement half by one to
// three months so the ageing monitor has real buckets, and with some reports
// never filed at all so the "terlambat" column is not decorative.
import type { StatusProposalNonPumk } from "../../modules/nonpumk";
import type { Dunia } from "./dunia";
import { PROGRAM_NON_PUMK, hibahWajar, keSen, rp, sen, tanggal, type Dadu } from "./acak";

export const JUMLAH_NON_PUMK = 60;

export const SEBARAN_NON_PUMK: ReadonlyArray<{ status: StatusProposalNonPumk; jumlah: number }> = [
  { status: "DRAFT", jumlah: 4 },
  { status: "PENILAIAN", jumlah: 4 },
  { status: "REVIEW_CHECKER", jumlah: 4 },
  { status: "MENUNGGU_PERSETUJUAN", jumlah: 4 },
  { status: "DISETUJUI", jumlah: 4 },
  { status: "DISALURKAN", jumlah: 5 },
  { status: "MENUNGGU_LPJ", jumlah: 8 },
  { status: "LPJ_DIAJUKAN", jumlah: 5 },
  { status: "SELESAI", jumlah: 14 },
  { status: "TIDAK_DIREKOMENDASIKAN", jumlah: 3 },
  { status: "DITOLAK", jumlah: 3 },
  { status: "LPJ_DITOLAK", jumlah: 2 },
];

export interface RencanaNonPumk {
  status: StatusProposalNonPumk;
  cabangKode: string;
  bidangKode: string;
  judul: string;
  namaPemohon: string;
  jumlah: number;
  penerima: number;
  bulanIdx: number;
  hari: number;
  /** Month index in which the LPJ half runs. Beyond the window = never filed. */
  bulanLpj: number;
  /** Two tranches rather than one, which is what spec 9.2's staging is for. */
  bertahap: boolean;
  /** Fraction of the disbursed amount actually spent; the rest comes back. */
  realisasiPersen: number;
  sdgKode: string[];
  proposalId?: string;
}

const PEMOHON = [
  "Yayasan Cahaya Banten", "Karang Taruna Ciwaduk", "PKK Kelurahan Masigit",
  "Pondok Pesantren Al Hikmah", "Kelompok Tani Makmur", "Posyandu Melati",
  "Komite SDN 3 Jombang", "DKM Masjid Al Ikhlas", "Forum RW Grogol",
  "Yayasan Peduli Pesisir", "Koperasi Wanita Serang", "Panti Asuhan Harapan",
  "Kelompok Sadar Wisata Anyer", "Bank Sampah Bersih", "Rumah Baca Cinangka",
];

export function rencanakanNonPumk(
  dunia: Dunia,
  jumlahBulan: number,
  d: Dadu,
): RencanaNonPumk[] {
  const kodeBidang = dunia.bidang.map((b) => b.kode);
  const kodeSdg = dunia.sdg.map((s) => s.kode);
  const daftar: StatusProposalNonPumk[] = [];
  for (const s of SEBARAN_NON_PUMK) for (let i = 0; i < s.jumlah; i += 1) daftar.push(s.status);
  if (daftar.length !== JUMLAH_NON_PUMK) {
    throw new Error(`seed demo: sebaran Non PUMK berjumlah ${daftar.length}, bukan ${JUMLAH_NON_PUMK}`);
  }

  const sudahDisalurkan = new Set<StatusProposalNonPumk>([
    "DISALURKAN", "MENUNGGU_LPJ", "LPJ_DIAJUKAN", "SELESAI", "LPJ_DITOLAK",
  ]);

  return daftar.map((status, i) => {
    const bidangKode = kodeBidang[i % kodeBidang.length]!;
    const judulPool = PROGRAM_NON_PUMK[bidangKode] ?? ["Program Bantuan Sosial"];
    // Disbursed programmes sit back in the window so their LPJ clock has run;
    // everything still in the pipeline is recent.
    const bulanIdx = sudahDisalurkan.has(status)
      ? d.int(0, Math.max(0, jumlahBulan - 5))
      : d.int(Math.max(0, jumlahBulan - 4), jumlahBulan - 1);
    // MENUNGGU_LPJ means the report is genuinely outstanding: half of them are
    // pushed past the end of the window so the monitor shows real lateness.
    const lag = status === "MENUNGGU_LPJ" ? jumlahBulan + 5 : d.int(1, 3);
    return {
      status,
      cabangKode: dunia.cabang[i % dunia.cabang.length]!.kode,
      bidangKode,
      judul: d.pilih(judulPool),
      namaPemohon: d.pilih(PEMOHON),
      jumlah: hibahWajar(d),
      penerima: d.int(25, 900),
      bulanIdx,
      hari: d.int(1, 10),
      bulanLpj: bulanIdx + lag,
      bertahap: d.peluang(0.35),
      realisasiPersen: d.peluang(0.4) ? d.int(72, 94) : 100,
      sdgKode: [kodeSdg[i % kodeSdg.length]!, kodeSdg[(i + 5) % kodeSdg.length]!],
    };
  });
}

/** Everything up to and including the disbursement half. */
export async function jalankanNonPumkAwal(dunia: Dunia, r: RencanaNonPumk, d: Dadu): Promise<void> {
  const periode = dunia.periode[r.bulanIdx];
  if (!periode) throw new Error(`seed demo: periode index ${r.bulanIdx} tidak ada`);
  const trio = dunia.petugas[r.cabangKode];
  const cabang = dunia.semuaCabang[r.cabangKode];
  if (!trio || !cabang) throw new Error(`seed demo: cabang ${r.cabangKode} tanpa petugas`);
  const maker = dunia.ctx(trio.maker);
  const checker = dunia.ctx(trio.checker);
  const approver = dunia.ctx(trio.approver);
  const bidang = dunia.bidang.find((b) => b.kode === r.bidangKode) ?? dunia.bidang[0]!;
  const hari = (o: number): string => tanggal(periode.tahun, periode.bulan, r.hari + o);

  dunia.jam.ke(hari(0));
  const p = await dunia.nonpumk.buatProposal(
    {
      cabangId: cabang.id,
      tanggalProposal: hari(0),
      namaPemohon: r.namaPemohon,
      atasNama: r.namaPemohon,
      alamat: `Sekretariat ${r.namaPemohon}`,
      kelurahan: "Masigit",
      kecamatan: cabang.nama.replace("Cabang ", ""),
      kotaId: dunia.kota[0]?.id ?? null,
      telepon: `0254${d.int(100000, 999999)}`,
      bidangId: bidang.id,
      sdg: r.sdgKode
        .map((k) => dunia.sdg.find((s) => s.kode === k)?.id)
        .filter((x): x is string => Boolean(x))
        .map((sdgId, idx) => ({ sdgId, bobot: idx === 0 ? "0.600000" : "0.400000" })),
      judulProgram: r.judul,
      deskripsiProgram: `${r.judul} di wilayah ${cabang.nama.replace("Cabang ", "")}`,
      jumlahDiajukan: rp(r.jumlah),
      penerimaManfaatEstimasi: r.penerima,
    },
    maker,
  );
  r.proposalId = p.id;
  if (r.status === "DRAFT") return;

  dunia.jam.ke(hari(1));
  await dunia.nonpumk.ajukanPenilaian(p.id, "Berkas proposal lengkap", maker);
  if (r.status === "PENILAIAN") return;

  const gagal = r.status === "TIDAK_DIREKOMENDASIKAN";
  dunia.jam.ke(hari(3));
  await dunia.nonpumk.inputPenilaian(
    {
      proposalId: p.id,
      tanggal: hari(3),
      petugasKaryawanId: dunia.karyawan[r.cabangKode] ?? null,
      hasil: {
        kelayakan_program: gagal ? "CUKUP" : "BAIK",
        dampak_penerima_manfaat: gagal ? "TERBATAS" : "LUAS",
        kesiapan_pelaksana: gagal ? "KURANG" : "SIAP",
        kesesuaian_sdg: "SESUAI",
      },
      skorTotal: `${gagal ? d.int(70, 76) : d.int(78, 95)}`,
      nilaiRekomendasi: rp(r.jumlah),
      catatan: "Verifikasi lapangan dan wawancara pengurus selesai",
    },
    maker,
  );
  if (r.status === "REVIEW_CHECKER") return;

  dunia.jam.ke(hari(4));
  if (r.status === "TIDAK_DIREKOMENDASIKAN") {
    await dunia.nonpumk.review(
      {
        proposalId: p.id,
        tanggal: hari(4),
        keputusan: "TIDAK_REKOMENDASI",
        catatan: "Dampak program belum sebanding dengan nilai yang diajukan",
      },
      checker,
    );
    return;
  }
  await dunia.nonpumk.review(
    { proposalId: p.id, tanggal: hari(4), keputusan: "REKOMENDASI", catatan: "Direkomendasikan" },
    checker,
  );
  if (r.status === "MENUNGGU_PERSETUJUAN") return;

  dunia.jam.ke(hari(6));
  if (r.status === "DITOLAK") {
    await dunia.nonpumk.putuskanPersetujuan(
      {
        proposalId: p.id,
        tanggal: hari(6),
        keputusan: "TOLAK",
        catatan: "Anggaran bidang untuk periode ini sudah terserap penuh",
      },
      approver,
    );
    return;
  }
  const disetujui = d.peluang(0.3)
    ? Math.round((r.jumlah * 0.85) / 5_000_000) * 5_000_000
    : r.jumlah;
  await dunia.nonpumk.putuskanPersetujuan(
    {
      proposalId: p.id,
      tanggal: hari(6),
      keputusan: "SETUJU",
      jumlahDisetujui: rp(Math.max(disetujui, 5_000_000)),
      catatan: disetujui === r.jumlah ? null : "Disetujui sebagian sesuai pagu bidang",
    },
    approver,
  );
  r.jumlah = Math.max(disetujui, 5_000_000);
  if (r.status === "DISETUJUI") return;

  // --- penyaluran ---------------------------------------------------------
  const kas = dunia.akun["1.1.02"]!;
  const beban = dunia.akun["5.1.03"]!;
  const tahap1 = r.bertahap ? Math.round(r.jumlah * 0.6) : r.jumlah;
  dunia.jam.ke(hari(8));
  await dunia.nonpumk.catatPenyaluran(
    {
      proposalId: p.id,
      tanggalPenyaluran: hari(8),
      jumlah: rp(tahap1),
      akunKasId: kas,
      akunBebanId: beban,
      noBukti: `BKK-NP/${hari(8).replace(/-/g, "")}`,
      keterangan: r.bertahap ? `${r.judul} (tahap 1)` : r.judul,
    },
    maker,
  );
  if (r.bertahap) {
    dunia.jam.ke(hari(14));
    await dunia.nonpumk.catatPenyaluran(
      {
        proposalId: p.id,
        tanggalPenyaluran: hari(14),
        jumlah: rp(r.jumlah - tahap1),
        akunKasId: kas,
        akunBebanId: beban,
        noBukti: `BKK-NP/${hari(14).replace(/-/g, "")}`,
        keterangan: `${r.judul} (tahap 2)`,
      },
      maker,
    );
  }
  if (r.status === "DISALURKAN") return;

  dunia.jam.ke(hari(16));
  await dunia.nonpumk.tutupPenyaluran(p.id, "Penyaluran selesai, menunggu LPJ", maker);
}

/** The LPJ half, run in a later month so the ageing monitor means something. */
export async function jalankanNonPumkLpj(dunia: Dunia, r: RencanaNonPumk, d: Dadu): Promise<void> {
  // Only the three states that actually have a report to file. Everything else
  // either never reached MENUNGGU_LPJ (rejected, still in the pipeline) or is
  // deliberately sitting there without one, which is what makes the ageing
  // monitor's "terlambat" column real.
  const PUNYA_LPJ = new Set<StatusProposalNonPumk>(["LPJ_DIAJUKAN", "SELESAI", "LPJ_DITOLAK"]);
  if (!r.proposalId || !PUNYA_LPJ.has(r.status)) return;
  const periode = dunia.periode[r.bulanLpj];
  if (!periode) return;
  const trio = dunia.petugas[r.cabangKode];
  if (!trio) return;
  const maker = dunia.ctx(trio.maker);
  const checker = dunia.ctx(trio.checker);
  const hari = (o: number): string => tanggal(periode.tahun, periode.bulan, 8 + o);

  const realisasi = Math.round((r.jumlah * r.realisasiPersen) / 100 / 1000) * 1000;
  dunia.jam.ke(hari(0));
  await dunia.nonpumk.ajukanLpj(
    {
      proposalId: r.proposalId,
      tanggalLpj: hari(0),
      jumlahRealisasi: rp(realisasi),
      penerimaManfaatAktual: Math.max(1, Math.round((r.penerima * d.int(85, 115)) / 100)),
      uraianRealisasi: `Realisasi ${r.judul}: pengadaan, pelaksanaan dan dokumentasi kegiatan`,
      lampiran: [`lpj/${r.proposalId.slice(0, 8)}-nota.pdf`, `lpj/${r.proposalId.slice(0, 8)}-foto.jpg`],
    },
    maker,
  );
  if (r.status === "LPJ_DIAJUKAN") return;

  dunia.jam.ke(hari(4));
  if (r.status === "LPJ_DITOLAK") {
    await dunia.nonpumk.tolakLpj(
      {
        proposalId: r.proposalId,
        tanggal: hari(4),
        catatan: "Bukti pengeluaran tidak lengkap, mohon dilengkapi nota dan berita acara",
      },
      checker,
    );
    return;
  }
  await dunia.nonpumk.verifikasiLpj(
    {
      proposalId: r.proposalId,
      tanggalVerifikasi: hari(4),
      akunKasId: dunia.akun["1.1.02"]!,
      catatan:
        r.realisasiPersen === 100
          ? "LPJ lengkap, realisasi sesuai penyaluran"
          : "LPJ lengkap, sisa dana dikembalikan ke rekening TJSL",
    },
    checker,
  );
}

/** Total value handed out, for the log line. */
export function totalPenyaluran(rencana: readonly RencanaNonPumk[]): string {
  const disalurkan = new Set<StatusProposalNonPumk>([
    "DISALURKAN", "MENUNGGU_LPJ", "LPJ_DIAJUKAN", "SELESAI", "LPJ_DITOLAK",
  ]);
  return sen(
    rencana
      .filter((r) => disalurkan.has(r.status))
      .reduce((s, r) => s + keSen(rp(r.jumlah)), 0n),
  );
}
