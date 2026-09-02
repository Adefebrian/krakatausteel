// apps/api/src/modules/laporan/service-nonpumk.ts
//
// THE FOUR NON PUMK REPORTS (spec 10.2, numbers 12 to 15).
//
// THE SAME FIVE RULES ./service-pumk.ts states, and one grain decision that is
// specific to this half of the catalogue:
//
//   THE MONEY GRAIN IS A DISBURSEMENT TERMIN, THE PROGRAMME GRAIN IS A
//   PROPOSAL, AND THE TWO ARE NEVER MIXED. spec 9.2 makes a Non PUMK
//   disbursement multi-termin, so "Tanggal" and "Nilai Disalurkan" belong to a
//   termin while "Bidang", "SDG", "Nilai Disetujui" and "Penerima Manfaat"
//   belong to the proposal. Report 12 prints one row per termin and repeats
//   the proposal columns the way a printed statement does; reports 13 and 14
//   count PROGRAMMES, which is `distinct proposal_id`, because a proposal paid
//   in three instalments is one programme and counting it three times would
//   make every "Jumlah Program" column a disguised termin count.
//
//   BENEFICIARIES ARE COUNTED ONCE PER PROGRAMME for exactly the same reason,
//   and reports 12, 13 and 14 all take them from the same per-proposal map so
//   the three pages cannot disagree about how many people a month reached.
//
// AND REPORT 14 HAS NO MONEY COLUMN ON PURPOSE. ADR 0016: an SDG mapping is
// many to many, so a rupiah split by it needs an allocation rule the client
// has not supplied. `nonpumk_proposal_sdg.bobot` exists and is deliberately
// not used: a weight somebody typed into a form is not an accounting
// allocation basis and a figure derived from it would be read as one.
import type { LaporanContext } from "./contract";
import type { DasarLaporan } from "./dasar";
import {
  angkaDb,
  bagi,
  jumlahAngka,
  kurangAngka,
  siapkan,
  tambahKe,
  tambahKeSet,
} from "./dasar-operasional";
import {
  NAMA_LAPORAN_OPERASIONAL,
  SDG_TIDAK_DIPETAKAN,
  type BarisBidang,
  type BarisMonitoringLpj,
  type BarisPenyaluranNonPumk,
  type BarisSdg,
  type FilterPeriodeLaporan,
  type LaporanMonitoringLpj,
  type LaporanPemetaanSdg,
  type LaporanPenyaluranNonPumk,
  type LaporanRekapBidang,
  type StatusLpj,
} from "./kontrak-operasional";
import { buatRepoOperasional } from "./repo-operasional";
import { selisihHari } from "./tanggal";
import { angka, uangDariDb } from "./uang";
import type { buatLayananPumk } from "./service-pumk";

const repo = buatRepoOperasional();

/**
 * `nonpumk_lpj.status` is null on a proposal with no LPJ row at all, and spec
 * 10.2 report 15's own vocabulary calls that BELUM. Stated once here so
 * reports 12 and 15 cannot answer the question differently on the same
 * proposal.
 */
function statusLpj(nilai: string | null): StatusLpj {
  return (nilai ?? "BELUM") as StatusLpj;
}

export interface LayananNonPumkDeps {
  dasar: DasarLaporan;
  /** Reports 13 and 2 share one budget lookup; see ./service-pumk.ts. */
  anggaranUntuk: ReturnType<typeof buatLayananPumk>["anggaranUntuk"];
}

export function buatLayananNonPumk({ dasar, anggaranUntuk }: LayananNonPumkDeps) {
  const tx = dasar.tx;

  // -------------------------------------------------------------------------
  // 12. Laporan Penyaluran Non PUMK
  // -------------------------------------------------------------------------

  async function penyaluranNonPumk(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPenyaluranNonPumk> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.penyaluranNonPumk(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });
    const sdgRows = await repo.sdgProposal(
      tx(),
      [...new Set(rows.map((r) => r.proposal_id))],
    );
    const sdgPerProposal = new Map<string, Array<{ sdgId: string; nomor: number; nama: string }>>();
    for (const s of sdgRows) {
      const daftar = sdgPerProposal.get(s.proposal_id) ?? [];
      daftar.push({ sdgId: s.sdg_id, nomor: Number(s.nomor), nama: s.nama });
      sdgPerProposal.set(s.proposal_id, daftar);
    }

    const baris: BarisPenyaluranNonPumk[] = rows.map((r) => ({
      penyaluranId: r.penyaluran_id,
      proposalId: r.proposal_id,
      noProposal: r.no_proposal,
      namaPemohon: r.nama_pemohon,
      bidangId: r.bidang_id,
      bidangKode: r.bidang_kode,
      bidangNama: r.bidang_nama,
      sdg: sdgPerProposal.get(r.proposal_id) ?? [],
      judulProgram: r.judul_program,
      termin: Number(r.termin),
      tanggalPenyaluran: r.tanggal_penyaluran,
      nilaiDisetujui: angkaDb(r.jumlah_disetujui),
      nilaiDisalurkan: angkaDb(r.jumlah),
      statusLpj: statusLpj(r.status_lpj),
      penerimaManfaat: r.penerima_manfaat === null ? null : Number(r.penerima_manfaat),
      noBukti: r.no_bukti,
      jurnalId: r.jurnal_id,
      cabangId: r.cabang_id,
    }));

    // BENEFICIARIES ONCE PER PROGRAMME. The column repeats on every termin of a
    // proposal, so summing the rows would multiply a programme's reach by the
    // number of instalments it happened to be paid in.
    const manfaatPerProposal = new Map<string, number>();
    for (const b of baris) {
      if (b.penerimaManfaat !== null) manfaatPerProposal.set(b.proposalId, b.penerimaManfaat);
    }

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.PENYALURAN_NON_PUMK),
      mode: siap.mode,
      baris,
      total: {
        jumlahPenyaluran: baris.length,
        jumlahProposal: new Set(baris.map((b) => b.proposalId)).size,
        nilaiDisalurkan: jumlahAngka(...baris.map((b) => b.nilaiDisalurkan)),
        penerimaManfaat: [...manfaatPerProposal.values()].reduce((t, n) => t + n, 0),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 13. Rekap Penyaluran Non PUMK per Bidang
  // -------------------------------------------------------------------------

  async function rekapBidang(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapBidang> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.penyaluranNonPumk(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });
    const master = await repo.bidang(tx(), ctx.bumnId);
    const {
      rkaId,
      rkaVersi,
      peta: anggaran,
    } = await anggaranUntuk(siap, ctx, "NON_PUMK", "bidang_id");

    const nilaiPer = new Map<string, bigint>();
    const programPer = new Map<string, Set<string>>();
    const label = new Map<string, { kode: string; nama: string }>();
    const programSemua = new Set<string>();
    let totalNilai = 0n;
    for (const r of rows) {
      const kunci = r.bidang_id;
      label.set(kunci, { kode: r.bidang_kode, nama: r.bidang_nama });
      const nilai = uangDariDb(r.jumlah);
      tambahKe(nilaiPer, kunci, nilai);
      tambahKeSet(programPer, kunci, r.proposal_id);
      programSemua.add(r.proposal_id);
      totalNilai += nilai;
    }

    // EVERY BIDANG IN THE MASTER PRINTS, and so does every bidang the budget
    // knows about: spec 10's zero rule, the same treatment report 2 gives a
    // sector that had no disbursement this month.
    const kunciSemua = new Set<string>([
      ...master.map((m) => m.id),
      ...nilaiPer.keys(),
      ...[...anggaran.keys()].filter((k) => k !== ""),
    ]);

    const totalNilaiCell = angka(totalNilai);
    const adaAnggaran = rkaId !== null;
    let totalAnggaran = 0n;

    const baris: BarisBidang[] = [...kunciSemua]
      .map((kunci) => {
        const m = master.find((x) => x.id === kunci);
        const l = label.get(kunci);
        const nilai = angka(nilaiPer.get(kunci) ?? 0n);
        const nilaiAnggaran = anggaran.get(kunci) ?? 0n;
        totalAnggaran += nilaiAnggaran;
        const cellAnggaran = adaAnggaran ? angka(nilaiAnggaran) : null;
        return {
          bidangId: kunci,
          kode: m?.kode ?? l?.kode ?? "-",
          nama: m?.nama ?? l?.nama ?? "(Bidang belum diisi)",
          jumlahProgram: programPer.get(kunci)?.size ?? 0,
          nilai,
          persenDariTotal: bagi(nilai, totalNilaiCell),
          anggaran: cellAnggaran,
          selisih: cellAnggaran ? kurangAngka(cellAnggaran, nilai) : null,
          persenCapaian: cellAnggaran ? bagi(nilai, cellAnggaran) : null,
        };
      })
      .sort((a, b) => (a.kode < b.kode ? -1 : a.kode > b.kode ? 1 : 0));

    const totalAnggaranCell = adaAnggaran ? angka(totalAnggaran) : null;

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.REKAP_BIDANG),
      mode: siap.mode,
      rkaId,
      rkaVersi,
      baris,
      total: {
        // DISTINCT ACROSS THE WHOLE REPORT, not the sum of the rows: a proposal
        // belongs to exactly one bidang, so the two agree today, and stating it
        // as a distinct count keeps them agreeing if that ever stops being true.
        jumlahProgram: programSemua.size,
        nilai: totalNilaiCell,
        anggaran: totalAnggaranCell,
        selisih: totalAnggaranCell ? kurangAngka(totalAnggaranCell, totalNilaiCell) : null,
        persenCapaian: totalAnggaranCell ? bagi(totalNilaiCell, totalAnggaranCell) : null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 14. Laporan Pemetaan SDGs
  // -------------------------------------------------------------------------

  async function pemetaanSdg(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPemetaanSdg> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.penyaluranNonPumk(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });
    const master = await repo.sdg(tx());

    // The population is PROGRAMMES disbursed in the window, each counted once
    // however many termin it was paid in.
    const manfaat = new Map<string, number>();
    for (const r of rows) {
      manfaat.set(r.proposal_id, r.penerima_manfaat === null ? 0 : Number(r.penerima_manfaat));
    }
    const proposalIds = [...manfaat.keys()];
    const petaan = await repo.sdgProposal(tx(), proposalIds);

    const perSdg = new Map<string, Set<string>>();
    const dipetakan = new Set<string>();
    for (const p of petaan) {
      if (!manfaat.has(p.proposal_id)) continue;
      tambahKeSet(perSdg, p.sdg_id, p.proposal_id);
      dipetakan.add(p.proposal_id);
    }
    const belum = proposalIds.filter((id) => !dipetakan.has(id));

    const manfaatDari = (ids: Iterable<string>): number => {
      let t = 0;
      for (const id of ids) t += manfaat.get(id) ?? 0;
      return t;
    };

    const baris: BarisSdg[] = master.map((s) => {
      const anggota = perSdg.get(s.id) ?? new Set<string>();
      return {
        sdgId: s.id,
        nomor: Number(s.nomor),
        nama: s.nama,
        jumlahProgram: anggota.size,
        penerimaManfaat: manfaatDari(anggota),
      };
    });
    // THE UNMAPPED BUCKET ALWAYS PRINTS, zero included. A programme that
    // reaches no goal is the finding this report exists to surface, and a
    // bucket that appears only when it is non-empty cannot be cross-checked.
    baris.push({
      sdgId: null,
      nomor: null,
      nama: SDG_TIDAK_DIPETAKAN,
      jumlahProgram: belum.length,
      penerimaManfaat: manfaatDari(belum),
    });

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.PEMETAAN_SDG),
      mode: siap.mode,
      baris,
      // DELIBERATELY NOT the sum of `jumlahProgram`: the buckets overlap, and
      // that overlap is the reason report 14 carries no money column at all.
      totalProgramUnik: proposalIds.length,
      totalPenerimaManfaatUnik: manfaatDari(proposalIds),
    };
  }

  // -------------------------------------------------------------------------
  // 15. Laporan Monitoring LPJ
  // -------------------------------------------------------------------------

  async function monitoringLpj(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanMonitoringLpj> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.monitoringLpj(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });
    const hariIni = dasar.hariIni();

    const baris: BarisMonitoringLpj[] = rows.map((r) => {
      const disalurkan = angkaDb(r.nilai_disalurkan);
      const realisasi = angkaDb(r.jumlah_realisasi);
      const sisa = angkaDb(r.jumlah_sisa);
      // AGE TO THE LPJ WHEN THERE IS ONE, TO TODAY WHEN THERE IS NOT. Measuring
      // both to today would make a programme that reported on time look worse
      // every day afterwards.
      const sampai = r.tanggal_lpj ?? hariIni;
      return {
        proposalId: r.proposal_id,
        noProposal: r.no_proposal,
        namaPemohon: r.nama_pemohon,
        judulProgram: r.judul_program,
        bidangNama: r.bidang_nama,
        tanggalSalurTerakhir: r.tanggal_salur_terakhir,
        nilaiDisalurkan: disalurkan,
        statusLpj: statusLpj(r.status_lpj),
        tanggalLpj: r.tanggal_lpj,
        jumlahRealisasi: realisasi,
        jumlahSisaDikembalikan: sisa,
        selisihRealisasi: kurangAngka(disalurkan, jumlahAngka(realisasi, sisa)),
        umurHari:
          r.tanggal_salur_terakhir === null
            ? null
            : selisihHari(r.tanggal_salur_terakhir, sampai),
        penerimaManfaatEstimasi:
          r.penerima_manfaat_estimasi === null ? null : Number(r.penerima_manfaat_estimasi),
        penerimaManfaatAktual:
          r.penerima_manfaat_aktual === null ? null : Number(r.penerima_manfaat_aktual),
        cabangId: r.cabang_id,
      };
    });

    // OLDEST OBLIGATION FIRST, so the worklist reads top down. `umurHari` is
    // the age of the obligation, so a null (nothing disbursed) sorts last.
    const diurutkan = [...baris].sort((a, b) => {
      const ua = a.umurHari ?? -1;
      const ub = b.umurHari ?? -1;
      if (ua !== ub) return ub - ua;
      return a.noProposal < b.noProposal ? -1 : a.noProposal > b.noProposal ? 1 : 0;
    });

    const statusUrut: StatusLpj[] = ["BELUM", "DIAJUKAN", "DIVERIFIKASI", "DITOLAK"];
    const perStatus = statusUrut.map((s) => {
      const anggota = diurutkan.filter((b) => b.statusLpj === s);
      return {
        status: s,
        jumlah: anggota.length,
        nilaiDisalurkan: jumlahAngka(...anggota.map((b) => b.nilaiDisalurkan)),
      };
    });

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.MONITORING_LPJ),
      mode: siap.mode,
      baris: diurutkan,
      perStatus,
      total: {
        jumlahProposal: diurutkan.length,
        nilaiDisalurkan: jumlahAngka(...diurutkan.map((b) => b.nilaiDisalurkan)),
        jumlahRealisasi: jumlahAngka(...diurutkan.map((b) => b.jumlahRealisasi)),
        selisihRealisasi: jumlahAngka(...diurutkan.map((b) => b.selisihRealisasi)),
      },
    };
  }

  return { penyaluranNonPumk, rekapBidang, pemetaanSdg, monitoringLpj };
}
