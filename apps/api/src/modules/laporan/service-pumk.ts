// apps/api/src/modules/laporan/service-pumk.ts
//
// THE ELEVEN PUMK REPORTS (spec 10.1, numbers 1 to 11).
//
// FIVE RULES, four of them inherited from ./service.ts because they are rules
// about this module rather than about the accounting statements, and one new:
//
//  1. AUTHORISE FIRST, AND REFUSE RATHER THAN NARROW. Every entry point goes
//     through `siapkan`, which goes through ./dasar.ts. A branch a user may not
//     see is a REFUSAL, never a WHERE clause. spec 16 scenario 24, and it
//     matters here more than on the balance sheet: an empty Laporan Aging
//     Piutang looks exactly like a branch with no arrears.
//
//  2. LIVE MEANS `v_ledger_baris` (ADR 0010). Never `status = 'POSTED'` alone.
//     A reversed disbursement must leave the sector it was booked in.
//
//  3. THE DISBURSEMENT FIGURE HAS ONE SOURCE, the ledger's `pumk_pencairan`
//     lines, which is the same source modules/rka reads for report 24. Reports
//     1, 2, 3 and 7 are four views of that one figure, and the tests assert
//     they agree with each other and with report 24 rather than trusting four
//     implementations. See ./kontrak-operasional.ts reading A.
//
//  4. CLASSIFICATION, DAYS OVERDUE AND PROVISION COME FROM
//     `kolektibilitas_snapshot` AND NOTHING ELSE, and a period with no snapshot
//     is refused rather than recomputed. Reading C in that same file, and the
//     reason spec 16 scenario 17's reconciliation is worth anything.
//
//  5. A DISTINCT PARTNER COUNT IS COUNTED AT THE LEVEL IT PRINTS AT. `count
//     (distinct mitra)` per province cannot be summed into a national figure
//     without counting twice anybody who moved, and cannot be summed into a
//     sector figure at all. So the repository returns the partner grain and
//     every count in this file is a `Set.size`.
//
// AND IT WRITES NOTHING. ./repo-operasional.ts is SELECTs only.
import {
  KODE_LAPORAN,
  type Angka,
  type LaporanContext,
} from "./contract";
import { gagal, type DasarLaporan } from "./dasar";
import {
  angkaDb,
  bagi,
  bagiCacah,
  jumlahAngka,
  kurangAngka,
  nol,
  siapkan,
  tambahKe,
  tambahKeSet,
  type SiapLaporan,
} from "./dasar-operasional";
import {
  BUCKET_AGING,
  KELAS_BARU,
  NAMA_LAPORAN_OPERASIONAL,
  WILAYAH_TIDAK_DIKETAHUI,
  type BarisAging,
  type BarisJadwalKartu,
  type BarisJatuhTempo,
  type BarisKolektibilitas,
  type BarisKolektibilitasSektor,
  type BarisMatriks,
  type BarisPenerimaanAngsuran,
  type BarisPerhitunganPenyisihan,
  type BarisRekapPermohonan,
  type BarisRekapRealisasi,
  type BarisSektor,
  type BarisSetoranKartu,
  type BarisWilayah,
  type FilterJatuhTempo,
  type FilterKartuPiutang,
  type FilterPeriodeLaporan,
  type KartuAkad,
  type KodeBucketAging,
  type KolomMatriks,
  type LaporanAgingPiutang,
  type LaporanJatuhTempo,
  type LaporanKartuPiutang,
  type LaporanKolektibilitas,
  type LaporanPenerimaanAngsuran,
  type LaporanPenyaluranNasional,
  type LaporanPerhitunganPenyisihan,
  type LaporanPerpindahanKolektibilitas,
  type LaporanRealisasiSektor,
  type LaporanRealisasiWilayah,
  type LaporanRekapPermohonan,
  type LaporanRekapRealisasi,
  type SelMatriks,
  type SelPerpindahan,
  type StatusAkad,
  type StatusJadwal,
} from "./kontrak-operasional";
import {
  buatRepoOperasional,
  type PencairanDimensiRow,
  type SnapshotKolektibilitasRow,
} from "./repo-operasional";
import { NAMA_BULAN, awalTahunBuku, pecahTanggal, selisihHari } from "./tanggal";
import { angka, keSen, uangDariDb } from "./uang";

const repo = buatRepoOperasional();

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A grouping key plus the running money and partner set behind it. */
interface Akumulasi {
  nilai: bigint;
  mitra: Set<string>;
}

function akum(): Akumulasi {
  return { nilai: 0n, mitra: new Set<string>() };
}

function ambil(peta: Map<string, Akumulasi>, kunci: string): Akumulasi {
  let a = peta.get(kunci);
  if (!a) {
    a = akum();
    peta.set(kunci, a);
  }
  return a;
}

/** Sorts by name with the "not filled in" bucket last, wherever it appears. */
function urutNama(a: { nama: string; id: string | null }, b: { nama: string; id: string | null }): number {
  if (a.id === null && b.id !== null) return 1;
  if (a.id !== null && b.id === null) return -1;
  return a.nama < b.nama ? -1 : a.nama > b.nama ? 1 : 0;
}

/**
 * The calendar months a window covers. A financial year that starts in April
 * makes February's year-to-date window months 4..12 plus 1..2, which is a list
 * and not a range; modules/rka states the same rule for report 24 and this is
 * the same arithmetic so the two budget columns cannot disagree.
 */
function bulanDalamRentang(siap: SiapLaporan, bulanMulaiTahunBuku: number): number[] {
  if (siap.mode === "BULANAN") return [siap.periode.bulan];
  const akhir = siap.periode.bulan;
  const out: number[] = [];
  if (akhir >= bulanMulaiTahunBuku) {
    for (let b = bulanMulaiTahunBuku; b <= akhir; b += 1) out.push(b);
    return out;
  }
  for (let b = bulanMulaiTahunBuku; b <= 12; b += 1) out.push(b);
  for (let b = 1; b <= akhir; b += 1) out.push(b);
  return out;
}

export interface LayananPumkDeps {
  dasar: DasarLaporan;
}

export function buatLayananPumk({ dasar }: LayananPumkDeps) {
  const tx = dasar.tx;

  // -------------------------------------------------------------------------
  // The one disbursement read, shared by reports 1, 2, 3 and 7
  // -------------------------------------------------------------------------

  function bacaPencairan(siap: SiapLaporan, ctx: LaporanContext): Promise<PencairanDimensiRow[]> {
    return repo.pencairanDimensi(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });
  }

  /**
   * Reports 2 and 13 share this: the approved RKA baseline for the window's
   * year, and the budget per dimension inside it. Returns nulls rather than
   * refusing when no approved version exists -- see `BarisSektor.anggaran` in
   * ./kontrak-operasional.ts for why a missing budget must not cost the client
   * their disbursement report.
   */
  async function anggaranUntuk(
    siap: SiapLaporan,
    ctx: LaporanContext,
    jenis: "PUMK" | "NON_PUMK",
    kolom: "sektor_id" | "bidang_id",
  ): Promise<{ rkaId: string | null; rkaVersi: number | null; peta: Map<string, bigint> }> {
    const baseline = await repo.baselineRka(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      tahun: siap.periode.tahun,
      jenis,
    });
    const peta = new Map<string, bigint>();
    if (!baseline) return { rkaId: null, rkaVersi: null, peta };
    const bulanMulai = await dasar.bulanAwalTahunBuku(ctx);
    const rows = await repo.anggaranDimensi(tx(), {
      rkaId: baseline.id,
      kolom,
      bulan: bulanDalamRentang(siap, bulanMulai),
      sertakanTanpaBulan: siap.mode === "KUMULATIF_YTD",
    });
    for (const r of rows) tambahKe(peta, r.dimensi_id ?? "", uangDariDb(r.jumlah));
    return { rkaId: baseline.id, rkaVersi: baseline.versi, peta };
  }

  // -------------------------------------------------------------------------
  // 1. Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten
  // -------------------------------------------------------------------------

  async function realisasiWilayah(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRealisasiWilayah> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await bacaPencairan(siap, ctx);

    // Two levels, both accumulated from the partner grain so a partner funded
    // in two cities counts once in the province and once nationally.
    const provinsi = new Map<string, Akumulasi>();
    const kota = new Map<string, Akumulasi>();
    const namaProvinsi = new Map<string, string>();
    const namaKota = new Map<string, { provinsiKunci: string; nama: string; id: string | null }>();
    const semuaMitra = new Set<string>();
    let totalNilai = 0n;

    for (const r of rows) {
      const kunciProv = r.provinsi_id ?? "";
      const kunciKota = `${kunciProv}|${r.kota_id ?? ""}`;
      namaProvinsi.set(kunciProv, r.provinsi_nama ?? WILAYAH_TIDAK_DIKETAHUI);
      namaKota.set(kunciKota, {
        provinsiKunci: kunciProv,
        nama: r.kota_nama ?? WILAYAH_TIDAK_DIKETAHUI,
        id: r.kota_id,
      });
      const nilai = uangDariDb(r.nilai);
      const ap = ambil(provinsi, kunciProv);
      ap.nilai += nilai;
      ap.mitra.add(r.mitra_id);
      const ak = ambil(kota, kunciKota);
      ak.nilai += nilai;
      ak.mitra.add(r.mitra_id);
      semuaMitra.add(r.mitra_id);
      totalNilai += nilai;
    }

    const total = { jumlahMitra: semuaMitra.size, jumlahPenyaluran: angka(totalNilai) };
    const persenDari = (nilai: bigint) => bagi(angka(nilai), total.jumlahPenyaluran);

    const urutanProvinsi = [...provinsi.keys()]
      .map((k) => ({ kunci: k, id: k === "" ? null : k, nama: namaProvinsi.get(k)! }))
      .sort(urutNama);

    const baris: BarisWilayah[] = [];
    for (const p of urutanProvinsi) {
      const ap = provinsi.get(p.kunci)!;
      baris.push({
        tipeBaris: "PROVINSI",
        provinsiId: p.id,
        provinsiNama: p.nama,
        kotaId: null,
        kotaNama: null,
        jumlahMitra: ap.mitra.size,
        jumlahPenyaluran: angka(ap.nilai),
        persenDariTotal: persenDari(ap.nilai),
      });
      const anak = [...namaKota.entries()]
        .filter(([, v]) => v.provinsiKunci === p.kunci)
        .map(([kunci, v]) => ({ kunci, id: v.id, nama: v.nama }))
        .sort(urutNama);
      for (const k of anak) {
        const ak = kota.get(k.kunci)!;
        baris.push({
          tipeBaris: "KOTA",
          provinsiId: p.id,
          provinsiNama: p.nama,
          kotaId: k.id,
          kotaNama: k.nama,
          jumlahMitra: ak.mitra.size,
          jumlahPenyaluran: angka(ak.nilai),
          persenDariTotal: persenDari(ak.nilai),
        });
      }
    }

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.REALISASI_WILAYAH),
      mode: siap.mode,
      dasarWilayah: "ALAMAT_MITRA_SAAT_INI",
      baris,
      total,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Laporan Realisasi Penyaluran berdasarkan Sektor
  // -------------------------------------------------------------------------

  async function realisasiSektor(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRealisasiSektor> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await bacaPencairan(siap, ctx);
    const master = await repo.sektor(tx(), ctx.bumnId);
    const { rkaId, rkaVersi, peta: anggaran } = await anggaranUntuk(siap, ctx, "PUMK", "sektor_id");

    const per = new Map<string, Akumulasi>();
    const nama = new Map<string, { kode: string; nama: string }>();
    const semuaMitra = new Set<string>();
    let totalNilai = 0n;
    for (const r of rows) {
      const kunci = r.sektor_id ?? "";
      nama.set(kunci, {
        kode: r.sektor_kode ?? "-",
        nama: r.sektor_nama ?? "(Sektor belum diisi)",
      });
      const nilai = uangDariDb(r.nilai);
      const a = ambil(per, kunci);
      a.nilai += nilai;
      a.mitra.add(r.mitra_id);
      semuaMitra.add(r.mitra_id);
      totalNilai += nilai;
    }

    // EVERY SECTOR IN THE MASTER PRINTS, and so does every sector the budget
    // knows about, even with nothing disbursed: spec 10's zero rule exists
    // because the accounting team cross-checks against it, and a sector that
    // disappears in the months it had no activity is a sector nobody can find.
    const kunciSemua = new Set<string>([
      ...master.map((m) => m.id),
      ...per.keys(),
      ...anggaran.keys(),
    ]);
    kunciSemua.delete("");
    if (per.has("") || anggaran.has("")) kunciSemua.add("");

    const totalPenyaluran = angka(totalNilai);
    const adaAnggaran = rkaId !== null;
    let totalAnggaran = 0n;

    const baris: BarisSektor[] = [...kunciSemua]
      .map((kunci) => {
        const m = master.find((x) => x.id === kunci);
        const label = nama.get(kunci);
        const a = per.get(kunci) ?? akum();
        const nilaiAnggaran = anggaran.get(kunci) ?? 0n;
        totalAnggaran += nilaiAnggaran;
        const penyaluran = angka(a.nilai);
        const cellAnggaran: Angka | null = adaAnggaran ? angka(nilaiAnggaran) : null;
        return {
          sektorId: kunci === "" ? null : kunci,
          kode: m?.kode ?? label?.kode ?? "-",
          nama: m?.nama ?? label?.nama ?? "(Sektor belum diisi)",
          jumlahMitra: a.mitra.size,
          jumlahPenyaluran: penyaluran,
          persenDariTotal: bagi(penyaluran, totalPenyaluran),
          anggaran: cellAnggaran,
          selisih: cellAnggaran ? kurangAngka(cellAnggaran, penyaluran) : null,
          persenCapaian: cellAnggaran ? bagi(penyaluran, cellAnggaran) : null,
        };
      })
      .sort((x, y) => (x.kode < y.kode ? -1 : x.kode > y.kode ? 1 : 0));

    const totalAnggaranCell: Angka | null = adaAnggaran ? angka(totalAnggaran) : null;

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.REALISASI_SEKTOR),
      mode: siap.mode,
      rkaId,
      rkaVersi,
      baris,
      total: {
        jumlahMitra: semuaMitra.size,
        jumlahPenyaluran: totalPenyaluran,
        anggaran: totalAnggaranCell,
        selisih: totalAnggaranCell ? kurangAngka(totalAnggaranCell, totalPenyaluran) : null,
        persenCapaian: totalAnggaranCell ? bagi(totalPenyaluran, totalAnggaranCell) : null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 3. Laporan Penyaluran Nasional (matriks Provinsi x Sektor)
  // -------------------------------------------------------------------------

  async function penyaluranNasional(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPenyaluranNasional> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await bacaPencairan(siap, ctx);

    // Columns are the sectors that actually appear, in code order, with the
    // unclassified bucket last. A matrix over every sector in the master would
    // be mostly empty columns on a client with forty of them; the row and
    // column footings still tie to reports 1 and 2 because the same rows feed
    // all three.
    const kolomKunci = new Map<string, KolomMatriks>();
    const barisKunci = new Map<string, string>();
    const sel = new Map<string, Akumulasi>();
    const perProvinsi = new Map<string, Akumulasi>();
    const perSektor = new Map<string, Akumulasi>();
    const semuaMitra = new Set<string>();
    let totalNilai = 0n;

    for (const r of rows) {
      const kolom = r.sektor_id ?? "";
      const brs = r.provinsi_id ?? "";
      kolomKunci.set(kolom, {
        sektorId: r.sektor_id,
        kode: r.sektor_kode ?? "-",
        nama: r.sektor_nama ?? "(Sektor belum diisi)",
      });
      barisKunci.set(brs, r.provinsi_nama ?? WILAYAH_TIDAK_DIKETAHUI);
      const nilai = uangDariDb(r.nilai);
      for (const [peta, kunci] of [
        [sel, `${brs}|${kolom}`],
        [perProvinsi, brs],
        [perSektor, kolom],
      ] as const) {
        const a = ambil(peta, kunci);
        a.nilai += nilai;
        a.mitra.add(r.mitra_id);
      }
      semuaMitra.add(r.mitra_id);
      totalNilai += nilai;
    }

    const kolom = [...kolomKunci.entries()]
      .map(([kunci, v]) => ({ kunci, ...v }))
      .sort((a, b) => {
        if (a.sektorId === null && b.sektorId !== null) return 1;
        if (a.sektorId !== null && b.sektorId === null) return -1;
        return a.kode < b.kode ? -1 : a.kode > b.kode ? 1 : 0;
      });

    const urutanBaris = [...barisKunci.entries()]
      .map(([kunci, nama]) => ({ kunci, id: kunci === "" ? null : kunci, nama }))
      .sort(urutNama);

    const kosong = (): SelMatriks => ({ jumlahMitra: 0, nilai: nol() });
    const dariAkum = (a: Akumulasi | undefined): SelMatriks =>
      a ? { jumlahMitra: a.mitra.size, nilai: angka(a.nilai) } : kosong();

    const baris: BarisMatriks[] = urutanBaris.map((p) => ({
      provinsiId: p.id,
      provinsiNama: p.nama,
      // DENSE: every column gets a cell, zeros included (spec 10's zero rule).
      sel: kolom.map((k) => dariAkum(sel.get(`${p.kunci}|${k.kunci}`))),
      total: dariAkum(perProvinsi.get(p.kunci)),
    }));

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.PENYALURAN_NASIONAL),
      mode: siap.mode,
      dasarWilayah: "ALAMAT_MITRA_SAAT_INI",
      kolom: kolom.map(({ sektorId, kode, nama }) => ({ sektorId, kode, nama })),
      baris,
      totalKolom: kolom.map((k) => dariAkum(perSektor.get(k.kunci))),
      totalKeseluruhan: { jumlahMitra: semuaMitra.size, nilai: angka(totalNilai) },
    };
  }

  // -------------------------------------------------------------------------
  // 4. Laporan Penerimaan Angsuran
  // -------------------------------------------------------------------------

  async function penerimaanAngsuran(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPenerimaanAngsuran> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.penerimaanAngsuran(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });

    const baris: BarisPenerimaanAngsuran[] = rows.map((r) => ({
      angsuranId: r.angsuran_id,
      tanggalTerima: r.tanggal_terima,
      tanggalValuta: r.tanggal_valuta,
      mitraId: r.mitra_id,
      kodeMitra: r.kode_mitra,
      namaMitra: r.nama_mitra,
      akadId: r.akad_id,
      noAkad: r.no_akad,
      pokok: angkaDb(r.pokok),
      jasaAdm: angkaDb(r.jasa),
      kelebihan: angkaDb(r.kelebihan),
      total: angkaDb(r.total),
      noBukti: r.no_bukti,
      jurnalId: r.jurnal_id,
      cabangId: r.cabang_id,
    }));

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.PENERIMAAN_ANGSURAN),
      mode: siap.mode,
      baris,
      total: {
        jumlahSetoran: baris.length,
        pokok: jumlahAngka(...baris.map((b) => b.pokok)),
        jasaAdm: jumlahAngka(...baris.map((b) => b.jasaAdm)),
        kelebihan: jumlahAngka(...baris.map((b) => b.kelebihan)),
        total: jumlahAngka(...baris.map((b) => b.total)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 5. Laporan Jatuh Tempo
  // -------------------------------------------------------------------------

  async function jatuhTempo(
    filter: FilterJatuhTempo,
    ctx: LaporanContext,
  ): Promise<LaporanJatuhTempo> {
    dasar.pastikanIzin(ctx);
    const dipilih = await dasar.pastikanCabang(ctx, filter.cabangId);
    const cabangIds = await dasar.cabangUntukQuery(ctx, dipilih);
    // NO PERIOD HERE, so the two dates are validated on their own: a window
    // whose end precedes its start silently returns nothing, and an empty
    // collections worksheet reads as "nothing falls due", which is the class of
    // wrong-answer-presented-as-right this module refuses everywhere else.
    for (const [nilai, medan] of [
      [filter.dariTanggal, "dariTanggal"],
      [filter.sampaiTanggal, "sampaiTanggal"],
    ] as const) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nilai ?? "")) {
        gagal(KODE_LAPORAN.TANGGAL_TIDAK_VALID, `Tanggal ${medan} tidak valid.`, { medan, nilai });
      }
    }
    if (filter.sampaiTanggal < filter.dariTanggal) {
      gagal(
        KODE_LAPORAN.TANGGAL_TIDAK_VALID,
        "Tanggal akhir rentang jatuh tempo mendahului tanggal awalnya.",
        { dariTanggal: filter.dariTanggal, sampaiTanggal: filter.sampaiTanggal },
      );
    }

    const acuan = dasar.hariIni();
    const rows = await repo.jatuhTempo(tx(), {
      bumnId: ctx.bumnId,
      cabangIds,
      dari: filter.dariTanggal,
      sampai: filter.sampaiTanggal,
    });

    const baris: BarisJatuhTempo[] = rows.map((r) => {
      const pokok = angkaDb(r.pokok);
      const jasa = angkaDb(r.jasa);
      return {
        jadwalId: r.jadwal_id,
        mitraId: r.mitra_id,
        kodeMitra: r.kode_mitra,
        namaMitra: r.nama_mitra,
        akadId: r.akad_id,
        noAkad: r.no_akad,
        angsuranKe: Number(r.angsuran_ke),
        tanggalJatuhTempo: r.tanggal_jatuh_tempo,
        status: r.status as StatusJadwal,
        pokok,
        jasaAdm: jasa,
        total: jumlahAngka(pokok, jasa),
        hariSampaiJatuhTempo: selisihHari(acuan, r.tanggal_jatuh_tempo),
        cabangId: r.cabang_id,
      };
    });

    return {
      header: await dasar.buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN_OPERASIONAL.JATUH_TEMPO,
        periode: null,
        periodeLabel: `${filter.dariTanggal} s.d. ${filter.sampaiTanggal}`,
        dariTanggal: filter.dariTanggal,
        sampaiTanggal: filter.sampaiTanggal,
        cabangId: dipilih.cabangId,
        namaCabang: dipilih.namaCabang,
        sumberData: "LEDGER_LIVE",
        templat: null,
      }),
      tanggalAcuan: acuan,
      baris,
      total: {
        jumlahAngsuran: baris.length,
        pokok: jumlahAngka(...baris.map((b) => b.pokok)),
        jasaAdm: jumlahAngka(...baris.map((b) => b.jasaAdm)),
        total: jumlahAngka(...baris.map((b) => b.total)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 6. Rekap Permohonan PUMK
  // -------------------------------------------------------------------------

  async function rekapPermohonanPumk(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapPermohonan> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const rows = await repo.permohonan(tx(), {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    });
    const master = await repo.sektor(tx(), ctx.bumnId);

    interface Ember {
      nama: string;
      jumlah: number;
      disetujui: number;
      diajukan: bigint;
      nilaiDisetujui: bigint;
    }
    const kosong = (nama: string): Ember => ({
      nama,
      jumlah: 0,
      disetujui: 0,
      diajukan: 0n,
      nilaiDisetujui: 0n,
    });
    const perStatus = new Map<string, Ember>();
    const perSektor = new Map<string, Ember>();
    for (const m of master) perSektor.set(m.id, kosong(m.nama));

    let jumlah = 0;
    let disetujui = 0;
    let diajukan = 0n;
    let nilaiDisetujui = 0n;

    for (const r of rows) {
      const nilaiAjuan = uangDariDb(r.jumlah_diajukan);
      const nilaiSetuju = r.jumlah_disetujui === null ? 0n : uangDariDb(r.jumlah_disetujui);
      const adaPersetujuan = r.jumlah_disetujui !== null;
      for (const [peta, kunci, nama] of [
        [perStatus, r.status, r.status],
        [
          perSektor,
          r.sektor_id ?? "",
          r.sektor_nama ?? "(Sektor belum diisi)",
        ],
      ] as const) {
        let e = peta.get(kunci);
        if (!e) {
          e = kosong(nama);
          peta.set(kunci, e);
        }
        e.jumlah += 1;
        e.diajukan += nilaiAjuan;
        if (adaPersetujuan) {
          e.disetujui += 1;
          e.nilaiDisetujui += nilaiSetuju;
        }
      }
      jumlah += 1;
      diajukan += nilaiAjuan;
      if (adaPersetujuan) {
        disetujui += 1;
        nilaiDisetujui += nilaiSetuju;
      }
    }

    const keBaris = (peta: Map<string, Ember>): BarisRekapPermohonan[] =>
      [...peta.entries()]
        .map(([kunci, e]) => ({
          kunci,
          nama: e.nama,
          jumlahProposal: e.jumlah,
          jumlahDisetujui: e.disetujui,
          nilaiDiajukan: angka(e.diajukan),
          nilaiDisetujui: angka(e.nilaiDisetujui),
          rasioPersetujuan: bagi(angka(e.nilaiDisetujui), angka(e.diajukan)),
        }))
        .sort((a, b) => (a.nama < b.nama ? -1 : a.nama > b.nama ? 1 : 0));

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.REKAP_PERMOHONAN_PUMK),
      mode: siap.mode,
      perStatus: keBaris(perStatus),
      perSektor: keBaris(perSektor),
      total: {
        jumlahProposal: jumlah,
        jumlahDisetujui: disetujui,
        nilaiDiajukan: angka(diajukan),
        nilaiDisetujui: angka(nilaiDisetujui),
        rasioPersetujuan: bagi(angka(nilaiDisetujui), angka(diajukan)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 7. Rekap Realisasi PUMK
  // -------------------------------------------------------------------------

  async function rekapRealisasiPumk(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapRealisasi> {
    // ALWAYS YEAR TO DATE. A table whose first column is "Bulan" and which
    // holds one month is not the report spec 10.1 describes, so `mode` is
    // forced rather than honoured, and the footing is therefore the same figure
    // reports 1, 2 and 3 produce in KUMULATIF_YTD.
    const siap = await siapkan(dasar, filter, ctx, {
      sumberData: "LEDGER_LIVE",
      paksaMode: "KUMULATIF_YTD",
    });
    const q = {
      bumnId: ctx.bumnId,
      cabangIds: siap.cabangIds,
      dari: siap.dari,
      sampai: siap.sampai,
    };
    const akad = await repo.akadPerBulan(tx(), q);
    const pencairan = await bacaPencairan(siap, ctx);
    const pertama = await repo.akadPertamaMitra(
      tx(),
      [...new Set(akad.map((a) => a.mitra_id))],
    );
    const petaPertama = new Map(pertama.map((p) => [p.mitra_id, p.tanggal_pertama]));

    // The month buckets are built from the WINDOW, not from the data, so a
    // month with no activity prints its zero row instead of vanishing.
    const bulanWindow: Array<{ tahun: number; bulan: number }> = [];
    {
      const a = pecahTanggal(siap.dari);
      const b = pecahTanggal(siap.sampai);
      let tahun = a.tahun;
      let bulan = a.bulan;
      while (tahun < b.tahun || (tahun === b.tahun && bulan <= b.bulan)) {
        bulanWindow.push({ tahun, bulan });
        bulan += 1;
        if (bulan > 12) {
          bulan = 1;
          tahun += 1;
        }
      }
    }

    const kunciBulan = (t: number, b: number) => `${t}-${b}`;
    const nilaiAkad = new Map<string, bigint>();
    const jumlahAkad = new Map<string, number>();
    const mitraBaru = new Map<string, Set<string>>();
    const mitraLama = new Map<string, Set<string>>();
    for (const a of akad) {
      const k = kunciBulan(a.tahun, a.bulan);
      tambahKe(nilaiAkad, k, uangDariDb(a.pokok));
      jumlahAkad.set(k, (jumlahAkad.get(k) ?? 0) + 1);
      const awal = petaPertama.get(a.mitra_id);
      const baru = awal !== undefined && pecahTanggal(awal).tahun === a.tahun &&
        pecahTanggal(awal).bulan === a.bulan;
      tambahKeSet(baru ? mitraBaru : mitraLama, k, a.mitra_id);
    }

    // The disbursement figure comes from the ledger, like reports 1 to 3, and
    // is bucketed by the JOURNAL's month rather than the akad's: money paid in
    // April against a March contract is April's disbursement.
    const nilaiCair = new Map<string, bigint>();
    {
      // `pencairanDimensi` aggregates away the date, so the per-month split is
      // taken from a second pass over the same predicate, one month at a time.
      // Cheap (twelve small aggregates) and, more importantly, provably the
      // same predicate: a different one would let the rows and the footing
      // disagree.
      //
      // The whole-window read that used to sit here was issued, discarded and
      // `void`-ed. It cost a full aggregate per call and proved nothing; the
      // footing is `baris.reduce`, so the window total comes from the months.
      for (const b of bulanWindow) {
        const mulai = `${b.tahun}-${String(b.bulan).padStart(2, "0")}-01`;
        const akhirHari = new Date(Date.UTC(b.tahun, b.bulan, 0)).getUTCDate();
        const akhir = `${b.tahun}-${String(b.bulan).padStart(2, "0")}-${String(akhirHari).padStart(2, "0")}`;
        const rows = await repo.pencairanDimensi(tx(), {
          bumnId: ctx.bumnId,
          cabangIds: siap.cabangIds,
          dari: mulai < siap.dari ? siap.dari : mulai,
          sampai: akhir > siap.sampai ? siap.sampai : akhir,
        });
        let total = 0n;
        for (const r of rows) total += uangDariDb(r.nilai);
        nilaiCair.set(kunciBulan(b.tahun, b.bulan), total);
      }
    }

    const baris: BarisRekapRealisasi[] = bulanWindow.map((b) => {
      const k = kunciBulan(b.tahun, b.bulan);
      return {
        tahun: b.tahun,
        bulan: b.bulan,
        label: `${NAMA_BULAN[b.bulan - 1]} ${b.tahun}`,
        jumlahAkad: jumlahAkad.get(k) ?? 0,
        nilaiAkad: angka(nilaiAkad.get(k) ?? 0n),
        nilaiDicairkan: angka(nilaiCair.get(k) ?? 0n),
        mitraBaru: mitraBaru.get(k)?.size ?? 0,
        mitraLama: mitraLama.get(k)?.size ?? 0,
      };
    });

    // Partner counts are DISTINCT over the whole window, not the sum of the
    // month columns: a partner who took a loan in March and another in June is
    // one BARU and one LAMA, and adding the columns would say two people.
    const baruSemua = new Set<string>();
    const lamaSemua = new Set<string>();
    for (const s of mitraBaru.values()) for (const m of s) baruSemua.add(m);
    for (const s of mitraLama.values()) for (const m of s) lamaSemua.add(m);

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.REKAP_REALISASI_PUMK),
      baris,
      total: {
        jumlahAkad: baris.reduce((t, b) => t + b.jumlahAkad, 0),
        nilaiAkad: jumlahAngka(...baris.map((b) => b.nilaiAkad)),
        nilaiDicairkan: jumlahAngka(...baris.map((b) => b.nilaiDicairkan)),
        mitraBaru: baruSemua.size,
        mitraLama: lamaSemua.size,
      },
    };
  }

  // -------------------------------------------------------------------------
  // The snapshot the four collectibility reports share
  // -------------------------------------------------------------------------

  /**
   * `kolektibilitas_snapshot` for the reported period, or a refusal.
   *
   * THE REFUSAL IS CONDITIONAL ON THERE BEING SOMETHING TO CLASSIFY, the same
   * shape `sumberUntuk` uses one table over: an entity with no live loans
   * legitimately produces no snapshot rows, and refusing on that would make the
   * first months of any go-live unreportable. With outstanding akads present
   * and no snapshot, the Closing Kolektibilitas run has simply not happened and
   * the report says exactly that.
   */
  async function snapshotWajib(
    siap: SiapLaporan,
    ctx: LaporanContext,
  ): Promise<SnapshotKolektibilitasRow[]> {
    const rows = await repo.snapshotKolektibilitas(tx(), siap.periode.id, siap.cabangIds);
    if (rows.length > 0) return rows;
    if (await repo.adaAkadOutstanding(tx(), siap.cabangIds)) {
      gagal(
        KODE_LAPORAN.SNAPSHOT_KOLEKTIBILITAS_BELUM_ADA,
        `Closing Kolektibilitas belum dijalankan untuk periode ${NAMA_BULAN[siap.periode.bulan - 1]} ` +
          `${siap.periode.tahun}, sehingga klasifikasi, hari tunggakan dan penyisihan periode ini belum ada.`,
        { periodeId: siap.periode.id, tahun: siap.periode.tahun, bulan: siap.periode.bulan },
      );
    }
    void ctx;
    return rows;
  }

  // -------------------------------------------------------------------------
  // 8. Laporan Aging Piutang
  // -------------------------------------------------------------------------

  function bucketUntuk(hari: number): KodeBucketAging {
    for (const b of BUCKET_AGING) {
      if (hari >= b.hariMin && (b.hariMaks === null || hari <= b.hariMaks)) return b.kode;
    }
    // Unreachable while the bands start at 0 and end open, but a negative
    // `hari_tunggakan` would otherwise land nowhere and silently vanish from
    // every bucket while staying in the total.
    return BUCKET_AGING[0].kode;
  }

  function bucketKosong(): Record<KodeBucketAging, Angka> {
    const out = {} as Record<KodeBucketAging, Angka>;
    for (const b of BUCKET_AGING) out[b.kode] = nol();
    return out;
  }

  async function agingPiutang(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanAgingPiutang> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "SNAPSHOT_PERIODE" });
    const rows = await snapshotWajib(siap, ctx);

    interface AkumMitra {
      kodeMitra: string;
      namaMitra: string;
      cabangId: string;
      namaCabang: string;
      pokok: bigint;
      jasa: bigint;
      bucket: Map<KodeBucketAging, bigint>;
    }
    const perMitra = new Map<string, AkumMitra>();
    const perBucketMitra = new Map<KodeBucketAging, Set<string>>();
    const perBucketNilai = new Map<KodeBucketAging, bigint>();
    const perCabang = new Map<
      string,
      { nama: string; mitra: Set<string>; pokok: bigint; bucket: Map<KodeBucketAging, bigint> }
    >();
    let totalPokok = 0n;
    let totalJasa = 0n;

    for (const r of rows) {
      const pokok = uangDariDb(r.outstanding_pokok);
      const jasa = uangDariDb(r.outstanding_jasa);
      const kode = bucketUntuk(Number(r.hari_tunggakan));
      let m = perMitra.get(r.mitra_id);
      if (!m) {
        m = {
          kodeMitra: r.kode_mitra,
          namaMitra: r.nama_mitra,
          cabangId: r.cabang_id,
          namaCabang: r.nama_cabang,
          pokok: 0n,
          jasa: 0n,
          bucket: new Map(),
        };
        perMitra.set(r.mitra_id, m);
      }
      m.pokok += pokok;
      m.jasa += jasa;
      m.bucket.set(kode, (m.bucket.get(kode) ?? 0n) + pokok);

      let c = perCabang.get(r.cabang_id);
      if (!c) {
        c = { nama: r.nama_cabang, mitra: new Set(), pokok: 0n, bucket: new Map() };
        perCabang.set(r.cabang_id, c);
      }
      c.mitra.add(r.mitra_id);
      c.pokok += pokok;
      c.bucket.set(kode, (c.bucket.get(kode) ?? 0n) + pokok);

      let s = perBucketMitra.get(kode);
      if (!s) {
        s = new Set<string>();
        perBucketMitra.set(kode, s);
      }
      s.add(r.mitra_id);
      perBucketNilai.set(kode, (perBucketNilai.get(kode) ?? 0n) + pokok);
      totalPokok += pokok;
      totalJasa += jasa;
    }

    const isiBucket = (peta: Map<KodeBucketAging, bigint>): Record<KodeBucketAging, Angka> => {
      const out = bucketKosong();
      for (const b of BUCKET_AGING) out[b.kode] = angka(peta.get(b.kode) ?? 0n);
      return out;
    };

    const baris: BarisAging[] = [...perMitra.entries()]
      .map(([mitraId, m]) => ({
        mitraId,
        kodeMitra: m.kodeMitra,
        namaMitra: m.namaMitra,
        cabangId: m.cabangId,
        namaCabang: m.namaCabang,
        outstanding: angka(m.pokok),
        outstandingJasa: angka(m.jasa),
        bucket: isiBucket(m.bucket),
      }))
      .sort((a, b) => (a.kodeMitra < b.kodeMitra ? -1 : a.kodeMitra > b.kodeMitra ? 1 : 0));

    const totalPokokCell = angka(totalPokok);

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.AGING_PIUTANG),
      baris,
      perBucket: BUCKET_AGING.map((b) => {
        const nilai = angka(perBucketNilai.get(b.kode) ?? 0n);
        return {
          kode: b.kode,
          nama: b.nama,
          jumlahMitra: perBucketMitra.get(b.kode)?.size ?? 0,
          outstanding: nilai,
          persenDariTotal: bagi(nilai, totalPokokCell),
        };
      }),
      perCabang: [...perCabang.entries()]
        .map(([cabangId, c]) => ({
          cabangId,
          namaCabang: c.nama,
          jumlahMitra: c.mitra.size,
          outstanding: angka(c.pokok),
          bucket: isiBucket(c.bucket),
        }))
        .sort((a, b) => (a.namaCabang < b.namaCabang ? -1 : 1)),
      total: {
        jumlahMitra: perMitra.size,
        outstanding: totalPokokCell,
        outstandingJasa: angka(totalJasa),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 9. Kartu Piutang Mitra Binaan
  // -------------------------------------------------------------------------

  async function kartuPiutang(
    filter: FilterKartuPiutang,
    ctx: LaporanContext,
  ): Promise<LaporanKartuPiutang> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "LEDGER_LIVE" });
    const mitra = await repo.mitra(tx(), filter.mitraId);
    if (!mitra) {
      gagal(KODE_LAPORAN.MITRA_TIDAK_DITEMUKAN, "Mitra binaan tidak ditemukan.");
    }
    // THE PARTNER'S OWN BRANCH IS CHECKED AGAINST THE REQUEST, not merely
    // against the session: asking for a partner of another branch is spec 16
    // scenario 24's "manipulasi ID di URL", and an empty card would read as a
    // partner who never borrowed.
    if (!siap.cabangIds.includes(mitra.cabang_id)) {
      gagal(
        KODE_LAPORAN.CABANG_DILUAR_SCOPE,
        "Anda tidak berwenang membuka kartu piutang mitra di cabang tersebut.",
      );
    }

    const akadRows = await repo.kartuAkad(tx(), mitra.id, siap.sampai);
    const akadIds = akadRows.map((a) => a.akad_id);
    const jadwalRows = await repo.kartuJadwal(tx(), akadIds, siap.sampai);
    const setoranRows = await repo.kartuSetoran(tx(), akadIds, siap.sampai);

    const akad: KartuAkad[] = akadRows.map((a) => {
      const jadwal: BarisJadwalKartu[] = jadwalRows
        .filter((j) => j.akad_id === a.akad_id)
        .map((j) => ({
          jadwalId: j.jadwal_id,
          angsuranKe: Number(j.angsuran_ke),
          tanggalJatuhTempo: j.tanggal_jatuh_tempo,
          pokok: angkaDb(j.pokok),
          jasaAdm: angkaDb(j.jasa_adm),
          total: angkaDb(j.total),
          pokokTerbayar: angkaDb(j.pokok_terbayar),
          jasaTerbayar: angkaDb(j.jasa_terbayar),
          status: j.status as StatusJadwal,
          tanggalLunas: j.tanggal_lunas,
        }));

      const dicairkan = uangDariDb(a.dicairkan);
      let berjalan = dicairkan;
      const setoran: BarisSetoranKartu[] = setoranRows
        .filter((s) => s.akad_id === a.akad_id)
        .map((s) => {
          const pokok = uangDariDb(s.pokok);
          berjalan -= pokok;
          return {
            angsuranId: s.angsuran_id,
            tanggalTerima: s.tanggal_terima,
            jumlahDiterima: angkaDb(s.jumlah_diterima),
            pokok: angka(pokok),
            jasaAdm: angkaDb(s.jasa),
            kelebihan: angkaDb(s.kelebihan),
            noBukti: s.no_bukti,
            jurnalId: s.jurnal_id,
            saldoPokokBerjalan: angka(berjalan),
          };
        });

      const totalPokokDibayar = jumlahAngka(...setoran.map((s) => s.pokok));
      const outstandingKartu = angka(dicairkan - keSen(totalPokokDibayar.nilai));
      const outstandingAkad = angkaDb(a.outstanding_pokok);
      return {
        akadId: a.akad_id,
        noAkad: a.no_akad,
        tanggalAkad: a.tanggal_akad,
        status: a.status as StatusAkad,
        pokokPinjaman: angkaDb(a.pokok_pinjaman),
        pokokDicairkan: angka(dicairkan),
        jadwal,
        setoran,
        totalPokokDibayar,
        totalJasaDibayar: jumlahAngka(...setoran.map((s) => s.jasaAdm)),
        totalKelebihan: jumlahAngka(...setoran.map((s) => s.kelebihan)),
        outstandingPokokAkad: outstandingAkad,
        outstandingJasaAkad: angkaDb(a.outstanding_jasa),
        outstandingPokokKartu: outstandingKartu,
        selisihOutstandingPokok: kurangAngka(outstandingAkad, outstandingKartu),
      };
    });

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.KARTU_PIUTANG),
      mitraId: mitra.id,
      kodeMitra: mitra.kode_mitra,
      namaMitra: mitra.nama_lengkap,
      cabangId: mitra.cabang_id,
      akad,
      total: {
        pokokDicairkan: jumlahAngka(...akad.map((a) => a.pokokDicairkan)),
        totalPokokDibayar: jumlahAngka(...akad.map((a) => a.totalPokokDibayar)),
        outstandingPokokAkad: jumlahAngka(...akad.map((a) => a.outstandingPokokAkad)),
        outstandingPokokKartu: jumlahAngka(...akad.map((a) => a.outstandingPokokKartu)),
        selisihOutstandingPokok: jumlahAngka(...akad.map((a) => a.selisihOutstandingPokok)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 10. Laporan Kolektibilitas
  // -------------------------------------------------------------------------

  async function kolektibilitas(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanKolektibilitas> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "SNAPSHOT_PERIODE" });
    const rows = await snapshotWajib(siap, ctx);
    const kelas = await repo.kelasKolektibilitas(tx(), ctx.bumnId);

    interface AkumKelas {
      mitra: Set<string>;
      akad: number;
      pokok: bigint;
      jasa: bigint;
      penyisihan: bigint;
    }
    const perKelas = new Map<string, AkumKelas>();
    const perSektor = new Map<
      string,
      {
        kode: string;
        nama: string;
        mitra: Set<string>;
        pokok: bigint;
        penyisihan: bigint;
        perKelas: Map<string, bigint>;
      }
    >();
    const mitraSemua = new Set<string>();
    let totalAkad = 0;
    let totalPokok = 0n;
    let totalJasa = 0n;
    let totalPenyisihan = 0n;

    for (const r of rows) {
      const pokok = uangDariDb(r.outstanding_pokok);
      const jasa = uangDariDb(r.outstanding_jasa);
      const penyisihan = uangDariDb(r.nilai_penyisihan);
      let k = perKelas.get(r.kolektibilitas);
      if (!k) {
        k = { mitra: new Set(), akad: 0, pokok: 0n, jasa: 0n, penyisihan: 0n };
        perKelas.set(r.kolektibilitas, k);
      }
      k.mitra.add(r.mitra_id);
      k.akad += 1;
      k.pokok += pokok;
      k.jasa += jasa;
      k.penyisihan += penyisihan;

      const kunciSektor = r.sektor_id ?? "";
      let s = perSektor.get(kunciSektor);
      if (!s) {
        s = {
          kode: r.sektor_kode ?? "-",
          nama: r.sektor_nama ?? "(Sektor belum diisi)",
          mitra: new Set(),
          pokok: 0n,
          penyisihan: 0n,
          perKelas: new Map(),
        };
        perSektor.set(kunciSektor, s);
      }
      s.mitra.add(r.mitra_id);
      s.pokok += pokok;
      s.penyisihan += penyisihan;
      s.perKelas.set(r.kolektibilitas, (s.perKelas.get(r.kolektibilitas) ?? 0n) + pokok);

      mitraSemua.add(r.mitra_id);
      totalAkad += 1;
      totalPokok += pokok;
      totalJasa += jasa;
      totalPenyisihan += penyisihan;
    }

    // The ladder decides the rows, so a class with no akad in it still prints
    // its zero (spec 10's zero rule). A class present in the snapshot but
    // absent from the ladder would otherwise disappear along with its money, so
    // it is appended rather than dropped.
    const kodeLadder = kelas.map((k) => k.kode);
    const tambahan = [...perKelas.keys()].filter((k) => !kodeLadder.includes(k)).sort();
    const urutan = [
      ...kelas.map((k) => ({ kode: k.kode, nama: k.nama, urutan: Number(k.urutan) })),
      ...tambahan.map((k, i) => ({ kode: k, nama: k, urutan: 1000 + i })),
    ];

    const totalPokokCell = angka(totalPokok);
    const baris: BarisKolektibilitas[] = urutan.map((k) => {
      const a = perKelas.get(k.kode);
      const pokok = angka(a?.pokok ?? 0n);
      return {
        klasifikasi: k.kode,
        nama: k.nama,
        urutan: k.urutan,
        jumlahMitra: a?.mitra.size ?? 0,
        jumlahAkad: a?.akad ?? 0,
        outstandingPokok: pokok,
        outstandingJasa: angka(a?.jasa ?? 0n),
        nilaiPenyisihan: angka(a?.penyisihan ?? 0n),
        persenDariTotal: bagi(pokok, totalPokokCell),
      };
    });

    const barisSektor: BarisKolektibilitasSektor[] = [...perSektor.entries()]
      .map(([kunci, s]) => ({
        sektorId: kunci === "" ? null : kunci,
        kode: s.kode,
        nama: s.nama,
        jumlahMitra: s.mitra.size,
        outstandingPokok: angka(s.pokok),
        nilaiPenyisihan: angka(s.penyisihan),
        perKlasifikasi: urutan.map((k) => angka(s.perKelas.get(k.kode) ?? 0n)),
      }))
      .sort((a, b) => (a.kode < b.kode ? -1 : a.kode > b.kode ? 1 : 0));

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.KOLEKTIBILITAS),
      baris,
      perSektor: barisSektor,
      total: {
        jumlahMitra: mitraSemua.size,
        jumlahAkad: totalAkad,
        outstandingPokok: totalPokokCell,
        outstandingJasa: angka(totalJasa),
        nilaiPenyisihan: angka(totalPenyisihan),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 11. Laporan Perpindahan Kolektibilitas
  // -------------------------------------------------------------------------

  async function perpindahanKolektibilitas(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPerpindahanKolektibilitas> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "SNAPSHOT_PERIODE" });
    const rows = await snapshotWajib(siap, ctx);
    const kelas = await repo.kelasKolektibilitas(tx(), ctx.bumnId);

    const kolom = kelas.map((k) => ({ kode: k.kode, nama: k.nama }));
    const barisKode = [{ kode: KELAS_BARU, nama: "Akad baru periode ini" }, ...kolom];

    const sel = new Map<string, { akad: number; pokok: bigint }>();
    const ambilSel = (dari: string, ke: string) => {
      const kunci = `${dari}|${ke}`;
      let s = sel.get(kunci);
      if (!s) {
        s = { akad: 0, pokok: 0n };
        sel.set(kunci, s);
      }
      return s;
    };

    let totalAkad = 0;
    let totalPokok = 0n;
    for (const r of rows) {
      // A null `kolektibilitas_periode_lalu` is an akad the previous run never
      // saw. "Moved from nothing" is a real movement and gets its own row
      // rather than being dropped, which would make the matrix stop footing to
      // report 10.
      const dari = r.kolektibilitas_periode_lalu ?? KELAS_BARU;
      const s = ambilSel(dari, r.kolektibilitas);
      const pokok = uangDariDb(r.outstanding_pokok);
      s.akad += 1;
      s.pokok += pokok;
      totalAkad += 1;
      totalPokok += pokok;
    }

    const kosong = (): SelPerpindahan => ({ jumlahAkad: 0, outstandingPokok: nol() });
    const bacaSel = (dari: string, ke: string): SelPerpindahan => {
      const s = sel.get(`${dari}|${ke}`);
      return s ? { jumlahAkad: s.akad, outstandingPokok: angka(s.pokok) } : kosong();
    };

    const baris = barisKode.map((b) => {
      const isi = kolom.map((k) => bacaSel(b.kode, k.kode));
      return {
        kode: b.kode,
        nama: b.nama,
        sel: isi,
        total: {
          jumlahAkad: isi.reduce((t, s) => t + s.jumlahAkad, 0),
          outstandingPokok: jumlahAngka(...isi.map((s) => s.outstandingPokok)),
        },
      };
    });

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.PERPINDAHAN_KOLEKTIBILITAS),
      kolom,
      baris,
      totalKolom: kolom.map((k, i) => {
        const isi = baris.map((b) => b.sel[i]);
        return {
          jumlahAkad: isi.reduce((t, s) => t + s.jumlahAkad, 0),
          outstandingPokok: jumlahAngka(...isi.map((s) => s.outstandingPokok)),
        };
      }),
      totalKeseluruhan: { jumlahAkad: totalAkad, outstandingPokok: angka(totalPokok) },
    };
  }

  // -------------------------------------------------------------------------
  // 28. Laporan Perhitungan Penyisihan
  // -------------------------------------------------------------------------
  //
  // Lives here rather than in ./service-lainnya.ts because it reads exactly the
  // rows reports 8, 10 and 11 read, through the same `snapshotWajib`, and a
  // second reader with a second refusal would be the drift this file exists to
  // prevent.

  /**
   * `bacaRun` IS A RESOLVER, NOT A VALUE, and that is a deliberate change from
   * the shape this function was first written with. The run total it compares
   * against is `penyisihan_periode` for THIS period and THIS branch list, and
   * both of those are decided by `siapkan`; taking the figure as a parameter
   * meant the caller had to run the whole authorisation, branch resolution and
   * period lookup a second time to get them. One `siapkan` per printed page.
   */
  async function perhitunganPenyisihan(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
    bacaRun: (siap: SiapLaporan) => Promise<Angka | null>,
  ): Promise<LaporanPerhitunganPenyisihan> {
    const siap = await siapkan(dasar, filter, ctx, { sumberData: "SNAPSHOT_PERIODE" });
    const rows = await snapshotWajib(siap, ctx);
    const kelas = await repo.kelasKolektibilitas(tx(), ctx.bumnId);
    const dibutuhkanRun = await bacaRun(siap);

    const baris: BarisPerhitunganPenyisihan[] = rows.map((r) => ({
      akadId: r.akad_id,
      noAkad: r.no_akad,
      mitraId: r.mitra_id,
      kodeMitra: r.kode_mitra,
      namaMitra: r.nama_mitra,
      sektorNama: r.sektor_nama,
      cabangId: r.cabang_id,
      outstandingPokok: angkaDb(r.outstanding_pokok),
      outstandingJasa: angkaDb(r.outstanding_jasa),
      tunggakanPokok: angkaDb(r.tunggakan_pokok),
      tunggakanJasa: angkaDb(r.tunggakan_jasa),
      hariTunggakan: Number(r.hari_tunggakan),
      klasifikasi: r.kolektibilitas,
      ratePenyisihan: r.rate_penyisihan,
      dasarPerhitungan: r.dasar_perhitungan,
      sumberRate: r.sumber_rate,
      rateHistoriDari: r.rate_histori_dari,
      rateHistoriSampai: r.rate_histori_sampai,
      nilaiPenyisihan: angkaDb(r.nilai_penyisihan),
    }));

    const perKlasifikasi = kelas.map((k) => {
      const anggota = baris.filter((b) => b.klasifikasi === k.kode);
      return {
        klasifikasi: k.kode,
        nama: k.nama,
        urutan: Number(k.urutan),
        jumlahAkad: anggota.length,
        outstandingPokok: jumlahAngka(...anggota.map((b) => b.outstandingPokok)),
        nilaiPenyisihan: jumlahAngka(...anggota.map((b) => b.nilaiPenyisihan)),
      };
    });

    const totalPenyisihan = jumlahAngka(...baris.map((b) => b.nilaiPenyisihan));

    return {
      header: await siap.header(NAMA_LAPORAN_OPERASIONAL.PERHITUNGAN_PENYISIHAN),
      baris,
      perKlasifikasi,
      total: {
        jumlahAkad: baris.length,
        outstandingPokok: jumlahAngka(...baris.map((b) => b.outstandingPokok)),
        nilaiPenyisihan: totalPenyisihan,
      },
      // SPEC 16 SCENARIO 17, AS A FIELD. "Buka Laporan Perhitungan Penyisihan,
      // konfirmasi totalnya merekonstruksi nilai jurnal penyisihan periode
      // itu." The run's `penyisihan_dibutuhkan` is the closing balance the
      // provision journal drove the ledger to; a non-zero difference means the
      // snapshot and the run disagree, which is a finding rather than a
      // rounding artefact, so it is SHOWN and not refused on.
      penyisihanDibutuhkanRun: dibutuhkanRun,
      selisihTerhadapRun: dibutuhkanRun ? kurangAngka(totalPenyisihan, dibutuhkanRun) : null,
    };
  }

  return {
    realisasiWilayah,
    realisasiSektor,
    penyaluranNasional,
    penerimaanAngsuran,
    jatuhTempo,
    rekapPermohonanPumk,
    rekapRealisasiPumk,
    agingPiutang,
    kartuPiutang,
    kolektibilitas,
    perpindahanKolektibilitas,
    perhitunganPenyisihan,
    anggaranUntuk,
  };
}

// Re-exported for ./service-nonpumk.ts, which shares the budget lookup and the
// fiscal-month window with reports 2 and 13's identical "versus RKA" column.
export { bulanDalamRentang, urutNama };
export type { Akumulasi };
export { akum, ambil };
export { awalTahunBuku, bagiCacah };
