// apps/api/src/modules/laporan/service-lainnya.ts
//
// REKAP JURNAL (spec 10.3 report 21) AND THE SEVEN REPORTS OF SPEC 10.4
// (25, 26, 27, 28, 29, 30, 31).
//
// The same five rules ./service-pumk.ts states. Four things are specific to
// this file and each is a decision rather than a derivation:
//
//  A. REPORT 21 CUTS ON `tanggal_transaksi` AND CARRIES A SEPARATE POSTED
//     FOOTING. Every other report in this module cuts on the transaction date,
//     and `totalTerbukukan` is the POSTED plus REVERSED subtotal (ADR 0010) so
//     the identity against Neraca Lajur's Mutasi columns is a field comparison
//     rather than arithmetic the reader performs. DRAFT and VOID still print,
//     because "is there a DRAFT left in this month" is the page's main job.
//
//  B. REPORT 28 AND REPORT 29 READ TWO DIFFERENT ARTEFACTS AND MUST AGREE.
//     28 totals `kolektibilitas_snapshot.nilai_penyisihan` per akad; 29 reads
//     `penyisihan_periode.penyisihan_dibutuhkan`, the closing balance the
//     provision journal drove the ledger to. Report 28 carries the comparison
//     as `selisihTerhadapRun`, and this file is where the second figure comes
//     from, so there is ONE reader of `penyisihan_periode` and not two.
//
//  C. REPORTS 25 AND 26 FILTER A TABLE WITH NO BRANCH. `portal_submission` is
//     keyed by `bumn_id` alone; a converted submission inherits the branch of
//     the proposal it became, and an unconverted one belongs to no branch and
//     is therefore visible only to a caller asking for Semua Cabang. Anything
//     else either hides the backlog from everybody or shows one branch another
//     branch's queue.
//
//  D. REPORT 31 REFUSES A BRANCH-SCOPED CALLER OUTRIGHT. `audit_log` carries
//     neither `bumn_id` nor `cabang_id`, and the actor's home branch is not the
//     branch of the row they touched, so a branch-scoped audit trail cannot be
//     built honestly. Filtering by the actor's branch and calling the result
//     "Cabang A's audit trail" is spec 16 scenario 24's wrong answer presented
//     as a right one, so the report requires the scope Semua Cabang requires.
//
// AND IT WRITES NOTHING. ./repo-operasional.ts is SELECTs only, and report 31
// reads a table whose own trigger (`trg_audit_log_90_append_only`) refuses an
// UPDATE or a DELETE from anybody at all.
import {
  KODE_LAPORAN,
  POLA_TANGGAL,
  POLA_UANG,
  type Angka,
  type LaporanContext,
  type StatusPeriode,
} from "./contract";
import { gagal, type DasarLaporan } from "./dasar";
import {
  angkaDb,
  bagiCacah,
  jumlahAngka,
  kurangAngka,
  siapkan,
  type SiapLaporan,
} from "./dasar-operasional";
import {
  BATAS_AUDIT_TRAIL_BAWAAN,
  BATAS_AUDIT_TRAIL_MAKS,
  EMBER_KOSONG,
  KELOMPOK_LAMA_USAHA,
  KELOMPOK_OMZET,
  KELOMPOK_TENAGA_KERJA,
  KELOMPOK_USIA,
  NAMA_LAPORAN_OPERASIONAL,
  type BarisAkrualJasa,
  type BarisAuditTrail,
  type BarisBebanPenyisihan,
  type BarisPortal,
  type BarisRekapJurnal,
  type DistribusiDemografi,
  type EmberDemografi,
  type FilterAuditTrail,
  type FilterPeriodeLaporan,
  type HasilAudit,
  type LaporanAkrualJasa,
  type LaporanAuditTrail,
  type LaporanBebanPenyisihan,
  type LaporanDemografiMitra,
  type LaporanPortal,
  type LaporanRekapJurnal,
  type StatusPortal,
} from "./kontrak-operasional";
import { buatRepoOperasional, type DemografiMitraRow } from "./repo-operasional";
import { NAMA_BULAN, pecahTanggal } from "./tanggal";
import { angka, keSen, uangDariDb } from "./uang";

const repo = buatRepoOperasional();

/** The two journal statuses that ARE the ledger. ADR 0010. */
const STATUS_TERBUKUKAN = new Set(["POSTED", "REVERSED"]);

export interface LayananLainnyaDeps {
  dasar: DasarLaporan;
}

export function buatLayananLainnya({ dasar }: LayananLainnyaDeps) {
  const tx = dasar.tx;

  // -------------------------------------------------------------------------
  // 21. Rekap Jurnal
  // -------------------------------------------------------------------------

  async function rekapJurnal(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapJurnal> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.rekapJurnal(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });

    const baris: BarisRekapJurnal[] = rows.map((r) => ({
      jenis: r.jenis,
      status: r.status,
      jumlahDokumen: Number.parseInt(r.jumlah, 10),
      totalDebit: angkaDb(r.total_debit),
      totalKredit: angkaDb(r.total_kredit),
    }));

    interface Rollup {
      jumlahDokumen: number;
      debit: bigint;
      kredit: bigint;
    }
    const kosong = (): Rollup => ({ jumlahDokumen: 0, debit: 0n, kredit: 0n });
    const perJenis = new Map<string, Rollup>();
    const terbukukan = kosong();
    const semua = kosong();
    for (const b of baris) {
      const debit = keSen(b.totalDebit.nilai);
      const kredit = keSen(b.totalKredit.nilai);
      let j = perJenis.get(b.jenis);
      if (!j) {
        j = kosong();
        perJenis.set(b.jenis, j);
      }
      for (const target of STATUS_TERBUKUKAN.has(b.status)
        ? [j, terbukukan, semua]
        : [j, semua]) {
        target.jumlahDokumen += b.jumlahDokumen;
        target.debit += debit;
        target.kredit += kredit;
      }
    }
    const keCell = (r: Rollup) => ({
      jumlahDokumen: r.jumlahDokumen,
      totalDebit: angka(r.debit),
      totalKredit: angka(r.kredit),
    });

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.REKAP_JURNAL),
      mode: siap.mode,
      baris,
      perJenis: [...perJenis.entries()]
        .map(([jenis, r]) => ({ jenis, ...keCell(r) }))
        .sort((a, b) => (a.jenis < b.jenis ? -1 : a.jenis > b.jenis ? 1 : 0)),
      totalTerbukukan: keCell(terbukukan),
      total: keCell(semua),
    };
  }

  // -------------------------------------------------------------------------
  // 25 and 26. Laporan Portal PUMK / Non PUMK
  // -------------------------------------------------------------------------

  async function portal(
    filter: FilterPeriodeLaporan & { jenis: "PUMK" | "NON_PUMK" },
    ctx: LaporanContext,
  ): Promise<LaporanPortal> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.portal(tx(), {
      bumnId: ctx.bumnId,
      jenis: filter.jenis,
      dari: siap.dari,
      sampai: siap.sampai,
    });

    // Reading C in this file's header. A branch-scoped caller sees the
    // submissions that became THEIR branch's proposals and nothing else; a
    // Semua Cabang caller additionally sees the unconverted backlog, which
    // belongs to no branch at all.
    const semuaCabang = siap.cabangId === null;
    const dalamScope = new Set(siap.cabangIds);
    const terpilih = rows.filter((r) =>
      r.cabang_id === null ? semuaCabang : dalamScope.has(r.cabang_id),
    );

    const baris: BarisPortal[] = terpilih.map((r) => {
      // `data_json` IS NEVER TRUSTED (migrations/0013 says so on the column).
      // The converted proposal wins; the form's own figure is accepted only if
      // it parses as a two-decimal amount and is null otherwise, because zero
      // would print as a real application for nothing.
      let nilaiDiajukan: Angka | null = null;
      let sumberNilai: BarisPortal["sumberNilai"] = "TIDAK_ADA";
      if (r.nilai_proposal !== null && POLA_UANG.test(r.nilai_proposal)) {
        nilaiDiajukan = angkaDb(r.nilai_proposal);
        sumberNilai = "PROPOSAL";
      } else if (r.nilai_dari_json !== null && POLA_UANG.test(r.nilai_dari_json)) {
        nilaiDiajukan = angkaDb(r.nilai_dari_json);
        sumberNilai = "DATA_JSON";
      }
      return {
        submissionId: r.submission_id,
        noTiket: r.no_tiket,
        tanggalSubmit: r.tanggal_submit,
        pemohon: r.nama_proposal ?? r.nama_dari_json ?? "",
        nilaiDiajukan,
        sumberNilai,
        status: r.status as StatusPortal,
        sudahDikonversi: r.converted_proposal_id !== null,
        proposalId: r.converted_proposal_id,
        noProposal: r.no_proposal,
        cabangId: r.cabang_id,
      };
    });

    const statusUrut: StatusPortal[] = ["BARU", "DIPROSES", "DIKONVERSI", "DITOLAK"];
    return {
      header: await siap.header(
        filter.jenis === "PUMK"
          ? NAMA_LAPORAN_OPERASIONAL.PORTAL_PUMK
          : NAMA_LAPORAN_OPERASIONAL.PORTAL_NON_PUMK,
      ),
      jenis: filter.jenis,
      mode: siap.mode,
      baris,
      perStatus: statusUrut.map((s) => ({
        status: s,
        jumlah: baris.filter((b) => b.status === s).length,
      })),
      total: {
        jumlahSubmission: baris.length,
        jumlahDikonversi: baris.filter((b) => b.sudahDikonversi).length,
        nilaiDiajukan: jumlahAngka(
          ...baris.map((b) => b.nilaiDiajukan).filter((n): n is Angka => n !== null),
        ),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 27. Laporan Demografi Mitra Binaan
  // -------------------------------------------------------------------------

  /**
   * Whole years from `lahir` to `sampai`, the way a person's age is read: the
   * birthday must have HAPPENED in the reported year, not merely fallen in it.
   */
  function usiaTahun(lahir: string, sampai: string): number {
    const l = pecahTanggal(lahir);
    const s = pecahTanggal(sampai);
    let tahun = s.tahun - l.tahun;
    if (s.bulan < l.bulan || (s.bulan === l.bulan && s.hari < l.hari)) tahun -= 1;
    return tahun;
  }

  /**
   * A banded distribution. EVERY BAND PRINTS AND SO DOES `BELUM_DIISI`, so the
   * distribution foots to `jumlahMitra` whatever the data looks like; a chart
   * that silently dropped the rows with a null column would show a different
   * population from the chart beside it and nothing on the page would say so.
   */
  function distribusiBand<T extends { kode: string; nama: string; min: number; maks: number | null }>(
    dimensi: string,
    nama: string,
    band: readonly T[],
    total: number,
    nilai: Array<number | null>,
  ): DistribusiDemografi {
    const hitung = new Map<string, number>();
    let kosong = 0;
    for (const n of nilai) {
      if (n === null) {
        kosong += 1;
        continue;
      }
      const cocok = band.find((b) => n >= b.min && (b.maks === null || n <= b.maks));
      if (!cocok) {
        // Outside every band (a negative age, a start year in the future) is
        // NOT dropped: it would leave the distribution short of the population
        // with nothing on the page to say so.
        kosong += 1;
        continue;
      }
      hitung.set(cocok.kode, (hitung.get(cocok.kode) ?? 0) + 1);
    }
    const ember: EmberDemografi[] = band.map((b) => {
      const jumlah = hitung.get(b.kode) ?? 0;
      return { kode: b.kode, nama: b.nama, jumlah, persen: bagiCacah(jumlah, total) };
    });
    ember.push({
      kode: EMBER_KOSONG.kode,
      nama: EMBER_KOSONG.nama,
      jumlah: kosong,
      persen: bagiCacah(kosong, total),
    });
    return { dimensi, nama, ember };
  }

  /** A distribution over a key that is itself data (sector, province, sex). */
  function distribusiKunci(
    dimensi: string,
    nama: string,
    total: number,
    entri: Array<{ kode: string; nama: string }>,
    nilai: Array<string | null>,
  ): DistribusiDemografi {
    const hitung = new Map<string, number>();
    let kosong = 0;
    for (const n of nilai) {
      if (n === null || n === "") {
        kosong += 1;
        continue;
      }
      hitung.set(n, (hitung.get(n) ?? 0) + 1);
    }
    const dikenal = new Set(entri.map((e) => e.kode));
    const tambahan = [...hitung.keys()].filter((k) => !dikenal.has(k)).sort();
    const ember: EmberDemografi[] = [...entri, ...tambahan.map((k) => ({ kode: k, nama: k }))].map(
      (e) => {
        const jumlah = hitung.get(e.kode) ?? 0;
        return { kode: e.kode, nama: e.nama, jumlah, persen: bagiCacah(jumlah, total) };
      },
    );
    ember.push({
      kode: EMBER_KOSONG.kode,
      nama: EMBER_KOSONG.nama,
      jumlah: kosong,
      persen: bagiCacah(kosong, total),
    });
    return { dimensi, nama, ember };
  }

  async function demografiMitra(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanDemografiMitra> {
    // INHERENTLY CUMULATIVE. "Who the partners are" at a date is not a monthly
    // flow, so `mode` is forced the way report 7's is, and the cut-off is the
    // period end.
    const siap = await siapkan(dasar, filter, ctx, {
      sumberData: "LEDGER_LIVE",
      paksaMode: "KUMULATIF_YTD",
    });
    const rows: DemografiMitraRow[] = await repo.demografiMitra(
      tx(),
      siap.cabangIds,
      siap.sampai,
    );
    const master = await repo.sektor(tx(), ctx.bumnId);
    const total = rows.length;

    const provinsi = new Map<string, string>();
    for (const r of rows) {
      if (r.provinsi_id !== null) provinsi.set(r.provinsi_id, r.provinsi_nama ?? r.provinsi_id);
    }

    const distribusi: DistribusiDemografi[] = [
      distribusiKunci(
        "JENIS_KELAMIN",
        "Jenis kelamin",
        total,
        [
          { kode: "L", nama: "Laki laki" },
          { kode: "P", nama: "Perempuan" },
        ],
        rows.map((r) => r.jenis_kelamin),
      ),
      distribusiBand(
        "USIA",
        "Kelompok usia",
        KELOMPOK_USIA,
        total,
        rows.map((r) => (r.tanggal_lahir === null ? null : usiaTahun(r.tanggal_lahir, siap.sampai))),
      ),
      distribusiKunci(
        "SEKTOR",
        "Sektor usaha",
        total,
        master.map((m) => ({ kode: m.id, nama: m.nama })),
        rows.map((r) => r.sektor_id),
      ),
      distribusiKunci(
        "WILAYAH",
        "Provinsi",
        total,
        [...provinsi.entries()]
          .map(([kode, nama]) => ({ kode, nama }))
          .sort((a, b) => (a.nama < b.nama ? -1 : a.nama > b.nama ? 1 : 0)),
        rows.map((r) => r.provinsi_id),
      ),
      distribusiBand(
        "LAMA_USAHA",
        "Lama usaha",
        KELOMPOK_LAMA_USAHA,
        total,
        rows.map((r) =>
          r.tahun_mulai_usaha === null
            ? null
            : pecahTanggal(siap.sampai).tahun - Number(r.tahun_mulai_usaha),
        ),
      ),
      distribusiBand(
        "TENAGA_KERJA",
        "Jumlah tenaga kerja",
        KELOMPOK_TENAGA_KERJA,
        total,
        rows.map((r) => (r.jumlah_tenaga_kerja === null ? null : Number(r.jumlah_tenaga_kerja))),
      ),
      distribusiBand(
        "OMZET",
        "Omzet bulanan",
        KELOMPOK_OMZET,
        total,
        // The bands are whole rupiah, the column is NUMERIC(20,2). Compared in
        // whole rupiah by integer division of the minor units, never through a
        // float.
        rows.map((r) =>
          r.omzet_bulanan === null ? null : Number(uangDariDb(r.omzet_bulanan) / 100n),
        ),
      ),
    ];

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.DEMOGRAFI_MITRA),
      dasarWilayah: "ALAMAT_MITRA_SAAT_INI",
      jumlahMitra: total,
      distribusi,
    };
  }

  // -------------------------------------------------------------------------
  // 28's second figure, and 29
  // -------------------------------------------------------------------------

  /**
   * `penyisihan_periode.penyisihan_dibutuhkan` for the reported period, summed
   * over the branch scope, or null when the provision run has not happened.
   *
   * This is report 28's `penyisihanDibutuhkanRun`, and it is read HERE rather
   * than in ./service-pumk.ts so that `penyisihan_periode` has exactly one
   * reader in this module: two readers with two branch predicates would let
   * report 28's comparison and report 29's rows disagree, which is the one
   * thing spec 16 scenario 17 asks the demo to check.
   */
  async function penyisihanDibutuhkanRun(siap: SiapLaporan): Promise<Angka | null> {
    const rows = await repo.penyisihanPeriode(
      tx(),
      siap.periode.bumn_id,
      siap.cabangIds,
      siap.periode.tanggal_akhir,
      siap.periode.tanggal_akhir,
    );
    if (rows.length === 0) return null;
    let total = 0n;
    for (const r of rows) total += uangDariDb(r.dibutuhkan);
    return angka(total);
  }

  // -------------------------------------------------------------------------
  // 29. Laporan Beban Penyisihan
  // -------------------------------------------------------------------------

  async function bebanPenyisihan(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanBebanPenyisihan> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "SNAPSHOT_PERIODE" });
    const rows = await repo.penyisihanPeriode(
      tx(),
      ctx.bumnId,
      siap.cabangIds,
      siap.dari,
      siap.sampai,
    );
    const tautan = await repo.penyisihanJurnal(tx(), rows.map((r) => r.penyisihan_id));
    const perRun = new Map<string, BarisBebanPenyisihan["jurnal"]>();
    for (const t of tautan) {
      const daftar = perRun.get(t.penyisihan_periode_id) ?? [];
      daftar.push({
        jurnalId: t.jurnal_id,
        noJurnal: t.no_jurnal,
        tanggal: t.tanggal,
        nilai: angkaDb(t.nilai),
      });
      perRun.set(t.penyisihan_periode_id, daftar);
    }

    const baris: BarisBebanPenyisihan[] = rows.map((r) => {
      const saldoAwal = angkaDb(r.saldo_awal);
      const beban = angkaDb(r.beban);
      const jurnal = perRun.get(r.penyisihan_id) ?? [];
      return {
        periodeId: r.periode_id,
        tahun: Number(r.tahun),
        bulan: Number(r.bulan),
        label: `${NAMA_BULAN[Number(r.bulan) - 1]} ${r.tahun}`,
        statusPeriode: r.status_periode as StatusPeriode,
        cabangId: r.cabang_id,
        namaCabang: r.nama_cabang,
        tanggalJalan: r.tanggal,
        saldoAwal,
        penyisihanDibutuhkan: angkaDb(r.dibutuhkan),
        bebanPeriode: beban,
        saldoAkhir: jumlahAngka(saldoAwal, beban),
        jurnal,
        // ZERO, OR THE DATABASE IS BROKEN: a deferred constraint trigger
        // refuses a run whose linked journals do not sum to its own movement.
        // Shown rather than refused on, because a non-zero value here is the
        // finding, and a report that refused would hide it.
        selisihTautanJurnal: kurangAngka(beban, jumlahAngka(...jurnal.map((j) => j.nilai))),
      };
    });

    // THE FOOTING IS NOT THREE COLUMN SUMS. Summing `saldoAwal` across twelve
    // months would count the same balance twelve times. The opening balance of
    // a window is the EARLIEST run per branch and the closing balance is the
    // LATEST, so `saldoAwal + bebanPeriode = saldoAkhir` still holds over the
    // whole window, which is the only arithmetic this total is allowed to
    // claim.
    const pertama = new Map<string, BarisBebanPenyisihan>();
    const terakhir = new Map<string, BarisBebanPenyisihan>();
    for (const b of baris) {
      const urut = b.tahun * 100 + b.bulan;
      const p = pertama.get(b.cabangId);
      if (!p || urut < p.tahun * 100 + p.bulan) pertama.set(b.cabangId, b);
      const t = terakhir.get(b.cabangId);
      if (!t || urut > t.tahun * 100 + t.bulan) terakhir.set(b.cabangId, b);
    }

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.BEBAN_PENYISIHAN),
      mode: siap.mode,
      baris,
      total: {
        saldoAwal: jumlahAngka(...[...pertama.values()].map((b) => b.saldoAwal)),
        bebanPeriode: jumlahAngka(...baris.map((b) => b.bebanPeriode)),
        saldoAkhir: jumlahAngka(...[...terakhir.values()].map((b) => b.saldoAkhir)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 30. Laporan Akrual Piutang Jasa Administrasi
  // -------------------------------------------------------------------------

  async function akrualJasa(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanAkrualJasa> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "SNAPSHOT_PERIODE" });
    const rows = await repo.akrualJasa(tx(), siap.periode.id, siap.cabangIds);

    const baris: BarisAkrualJasa[] = rows.map((r) => ({
      akadId: r.akad_id,
      noAkad: r.no_akad,
      mitraId: r.mitra_id,
      kodeMitra: r.kode_mitra,
      namaMitra: r.nama_mitra,
      cabangId: r.cabang_id,
      kolektibilitas: r.kolektibilitas,
      jasaJatuhTempoPeriode: angkaDb(r.jatuh_tempo),
      jasaDiterimaPeriode: angkaDb(r.diterima),
      jasaDiakrual: angkaDb(r.diakrual),
      metode: r.metode,
      // `kelas_diakrual` is jsonb. An array of strings is what the accrual
      // wrote; anything else is rendered as the empty list rather than
      // crashing a report on a row somebody hand-edited.
      kelasDiakrual: Array.isArray(r.kelas_diakrual)
        ? (r.kelas_diakrual as unknown[]).map((k) => String(k))
        : [],
      jurnalId: r.jurnal_id,
    }));

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.AKRUAL_JASA),
      baris,
      total: {
        jumlahAkad: baris.length,
        jatuhTempo: jumlahAngka(...baris.map((b) => b.jasaJatuhTempoPeriode)),
        diterima: jumlahAngka(...baris.map((b) => b.jasaDiterimaPeriode)),
        diakrual: jumlahAngka(...baris.map((b) => b.jasaDiakrual)),
      },
      // MORE THAN ONE IS A FINDING, and the report states the set rather than
      // picking one: `akuntansi.metode_pengakuan_jasa_adm` is mutated in place,
      // so a period whose rows disagree was accrued across a configuration
      // change and the reader has to know.
      metode: [...new Set(baris.map((b) => b.metode))].sort(),
    };
  }

  // -------------------------------------------------------------------------
  // 31. Laporan Audit Trail
  // -------------------------------------------------------------------------

  async function auditTrail(
    filter: FilterAuditTrail,
    ctx: LaporanContext,
  ): Promise<LaporanAuditTrail> {
    dasar.pastikanIzin(ctx);
    // Reading D. `pastikanCabang(ctx, null)` is the Semua Cabang check, and
    // asking it here rather than inventing a second rule means this report
    // refuses exactly the callers every other report refuses Semua Cabang to.
    const dipilih = await dasar.pastikanCabang(ctx, null);

    for (const [nilai, medan] of [
      [filter.dariTanggal, "dariTanggal"],
      [filter.sampaiTanggal, "sampaiTanggal"],
    ] as const) {
      if (!POLA_TANGGAL.test(nilai ?? "")) {
        gagal(KODE_LAPORAN.TANGGAL_TIDAK_VALID, `Tanggal ${medan} tidak valid.`, { medan, nilai });
      }
    }
    if (filter.sampaiTanggal < filter.dariTanggal) {
      gagal(
        KODE_LAPORAN.TANGGAL_TIDAK_VALID,
        "Tanggal akhir rentang audit mendahului tanggal awalnya.",
        { dariTanggal: filter.dariTanggal, sampaiTanggal: filter.sampaiTanggal },
      );
    }

    const batasDiminta = filter.batas ?? BATAS_AUDIT_TRAIL_BAWAAN;
    const batas =
      Number.isInteger(batasDiminta) && batasDiminta > 0
        ? Math.min(batasDiminta, BATAS_AUDIT_TRAIL_MAKS)
        : BATAS_AUDIT_TRAIL_BAWAAN;
    const offsetDiminta = filter.offset ?? 0;
    const offset = Number.isInteger(offsetDiminta) && offsetDiminta > 0 ? offsetDiminta : 0;

    const { baris: rows, jumlah } = await repo.auditTrail(tx(), {
      bumnId: ctx.bumnId,
      dari: filter.dariTanggal,
      sampai: filter.sampaiTanggal,
      userId: filter.userId ?? null,
      entitas: filter.entitas ?? null,
      aksi: filter.aksi ?? null,
      hasil: filter.hasil ?? null,
      batas,
      offset,
    });

    const baris: BarisAuditTrail[] = rows.map((r) => ({
      id: r.id,
      waktu: r.waktu,
      userId: r.user_id,
      namaUser: r.nama_user,
      ip: r.ip,
      aksi: r.aksi,
      entitas: r.entitas,
      entitasId: r.entitas_id,
      hasil: r.hasil as HasilAudit,
      keterangan: r.keterangan,
    }));

    return {
      header: await dasar.buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN_OPERASIONAL.AUDIT_TRAIL,
        periode: null,
        periodeLabel: `${filter.dariTanggal} s.d. ${filter.sampaiTanggal}`,
        dariTanggal: filter.dariTanggal,
        sampaiTanggal: filter.sampaiTanggal,
        cabangId: dipilih.cabangId,
        namaCabang: dipilih.namaCabang,
        sumberData: "LEDGER_LIVE",
        templat: null,
      }),
      baris,
      jumlahTotal: jumlah,
      batas,
      offset,
    };
  }

  return {
    rekapJurnal,
    portal,
    demografiMitra,
    penyisihanDibutuhkanRun,
    bebanPenyisihan,
    akrualJasa,
    auditTrail,
  };
}
