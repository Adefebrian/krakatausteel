// apps/api/src/modules/laporan/service.ts
//
// THE CORE ACCOUNTING REPORTS (spec 10.3 reports 16 to 20, 22 and 23).
//
// FIVE RULES THIS FILE IS BUILT AROUND, each of them a thing that goes wrong
// silently if it is got wrong:
//
//  1. AUTHORISE FIRST, AND REFUSE RATHER THAN NARROW. `laporan.view` is
//     checked against the SHIPPED catalogue (modules/auth), and a branch a
//     user may not see is a REFUSAL, not a WHERE clause. Spec 2 rule 1 and
//     spec 16 scenario 24: an empty Laporan Posisi Keuangan balances perfectly
//     (0 = 0 + 0), so a silently scoped report is a page that passes every
//     other test in this module.
//
//  2. PICK ONE OF SPEC 10'S TWO PATHS, NEVER MIX THEM. CLOSED reads
//     `saldo_akun_periode`; OPEN computes live; the answer says which
//     (`header.sumberData`). A CLOSED period with no frozen rows REFUSES.
//
//  3. LIVE MEANS `v_ledger_baris` (ADR 0010). Never `status = 'POSTED'` alone.
//     No total in this module can detect that mistake, because a POSTED-only
//     reading still balances everywhere.
//
//  4. LAYOUT IS DATA. Not one caption, order or section is compiled in. The
//     lines are `baris_laporan` rows, the accounts reach them through
//     `pemetaan_baris_laporan` (migrations/0028), and presentation as a
//     deduction is `tanda`. The only structural strings this file knows are
//     `seksi` values that name an ACCOUNT TYPE (ASET / LIABILITAS /
//     ASET_NETO), which is a section key, not a caption, and which
//     ./contract.ts fixes.
//
//  5. RENDER EVERY FIGURE HERE (./uang.ts), so the screen, the Excel export
//     and the PDF export cannot each invent their own zero.
//
// AND IT WRITES NOTHING. Every statement in ./repo.ts is a SELECT; spec 16
// scenario 23 is a standing constraint on this file.
import { PERMISSIONS } from "../auth";
import {
  KODE_LAPORAN,
  KUNCI_KONFIGURASI_LAPORAN,
  LaporanError,
  NAMA_LAPORAN,
  PERMISSION_LAPORAN,
  type Angka,
  type BarisArusKas,
  type BarisBaganAkun,
  type BarisBukuBesar,
  type BarisNeracaLajur,
  type BarisPerubahanAsetNeto,
  type BarisStatement,
  type FilterBaganAkun,
  type FilterBukuBesar,
  type FilterLaporan,
  type HeaderLaporan,
  type KlasifikasiArusKas,
  type KodeLaporan,
  type KolomPembanding,
  type LaporanAktivitas,
  type LaporanArusKas,
  type LaporanBaganAkun,
  type LaporanBukuBesar,
  type LaporanContext,
  type LaporanEngine,
  type LaporanEngineDeps,
  type LaporanNeracaLajur,
  type LaporanPerubahanAsetNeto,
  type LaporanPosisiKeuangan,
  type LaporanTx,
  type SaldoNormal,
  type SeksiAktivitas,
  type SeksiArusKas,
  type StatusPeriode,
  type SumberData,
  type TanggalIso,
  type TipeAkun,
  type TipeBaris,
} from "./contract";
import {
  buatRepoLaporan,
  type AkunRow,
  type BarisLaporanRow,
  type PeriodeRow,
} from "./repo";
import { angka, keSen, sen, uangDariDb } from "./uang";

// ---------------------------------------------------------------------------
// Section keys. NOT captions.
// ---------------------------------------------------------------------------

/**
 * `baris_laporan.seksi` on a POSISI_KEUANGAN row names one of the three
 * sections of a statement of financial position, and those three are the
 * `akun.tipe` vocabulary migrations/0005 already fixes with a CHECK. They are
 * structure, not wording: what each section is CALLED is `baris_laporan.nama`
 * and this file never reads it.
 */
const SEKSI_ASET = "ASET";
const SEKSI_LIABILITAS = "LIABILITAS";
const SEKSI_ASET_NETO = "ASET_NETO";

const URUTAN_ARUS_KAS: readonly KlasifikasiArusKas[] = ["OPERASI", "INVESTASI", "PENDANAAN"];

const NAMA_BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
] as const;

// ---------------------------------------------------------------------------
// Dates. UTC throughout, no local-time drift.
// ---------------------------------------------------------------------------

function pecahTanggal(iso: string): { tahun: number; bulan: number; hari: number } {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  return { tahun: t, bulan: b, hari: h };
}

function rakitTanggal(tahun: number, bulan: number, hari: number): TanggalIso {
  return `${String(tahun).padStart(4, "0")}-${String(bulan).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;
}

function tambahHari(iso: string, hari: number): TanggalIso {
  const { tahun, bulan, hari: h } = pecahTanggal(iso);
  const d = new Date(Date.UTC(tahun, bulan - 1, h));
  d.setUTCDate(d.getUTCDate() + hari);
  return d.toISOString().slice(0, 10);
}

function hariDalamBulan(tahun: number, bulan: number): number {
  return new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
}

/** One year earlier, clamped (29 February becomes 28 February). */
function mundurSetahun(iso: string): TanggalIso {
  const { tahun, bulan, hari } = pecahTanggal(iso);
  return rakitTanggal(tahun - 1, bulan, Math.min(hari, hariDalamBulan(tahun - 1, bulan)));
}

/**
 * First day of the financial year containing `sampai`, given the month the
 * financial year starts in. NEVER assumes January: a hardcoded month 1 prints
 * the wrong comparative for any client on a non-calendar year and nothing
 * downstream detects it (spec 5.6, `akuntansi.tahun_buku_mulai_bulan`).
 */
function awalTahunBuku(sampai: string, bulanMulai: number): TanggalIso {
  const { tahun, bulan } = pecahTanggal(sampai);
  return rakitTanggal(bulan >= bulanMulai ? tahun : tahun - 1, bulanMulai, 1);
}

function labelTanggal(iso: string): string {
  const { tahun, bulan, hari } = pecahTanggal(iso);
  return `${hari} ${NAMA_BULAN[bulan - 1]} ${tahun}`;
}

function labelRentang(dari: string, sampai: string): string {
  const a = pecahTanggal(dari);
  const b = pecahTanggal(sampai);
  if (a.tahun === b.tahun) {
    return a.bulan === b.bulan
      ? `${NAMA_BULAN[a.bulan - 1]} ${a.tahun}`
      : `${NAMA_BULAN[a.bulan - 1]} - ${NAMA_BULAN[b.bulan - 1]} ${b.tahun}`;
  }
  return `${NAMA_BULAN[a.bulan - 1]} ${a.tahun} - ${NAMA_BULAN[b.bulan - 1]} ${b.tahun}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function gagal(kode: KodeLaporan, pesan: string, detail?: unknown): never {
  throw new LaporanError(kode, pesan, detail === undefined ? undefined : { detail });
}

/** +1 for a debit-normal account, -1 for a credit-normal one. */
function arah(a: AkunRow): bigint {
  return a.saldo_normal === "D" ? 1n : -1n;
}

function tandaBaris(row: BarisLaporanRow): 1 | -1 {
  return Number(row.tanda) < 0 ? -1 : 1;
}


// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEngineLaporan(deps: LaporanEngineDeps): LaporanEngine {
  const repo = buatRepoLaporan();
  const db = deps.db;
  const jam = deps.jam ?? (() => new Date());
  const tx = (): LaporanTx => db;

  // --- authorisation ------------------------------------------------------

  /**
   * FAIL CLOSED ON AN UNREGISTERED CODE. A permission this module names that
   * is absent from the shipped catalogue is a FINDING, never something
   * silently treated as granted; that mechanism has already caught three real
   * gaps in this repo.
   */
  function pastikanIzin(ctx: LaporanContext): void {
    const kode: string = PERMISSION_LAPORAN.LIHAT;
    if (!(PERMISSIONS as readonly string[]).includes(kode)) {
      gagal(
        KODE_LAPORAN.IZIN_BELUM_TERDAFTAR,
        `Izin ${kode} belum terdaftar di katalog izin sistem, sehingga laporan tidak bisa dibuka.`,
        { izin: kode },
      );
    }
    if (!ctx.permissions.includes(kode)) {
      gagal(KODE_LAPORAN.TIDAK_BERWENANG, "Anda tidak berwenang membuka laporan ini.");
    }
  }

  /**
   * Branch scope, spec 16 scenario 24. `null` is spec 10's Semua Cabang and is
   * allowed ONLY to a user whose scope already covers every branch of the
   * entity; for a branch user it is the same request as asking for every other
   * branch at once, and it is refused rather than quietly narrowed.
   */
  async function pastikanCabang(
    ctx: LaporanContext,
    diminta: string | null | undefined,
  ): Promise<{ cabangId: string | null; namaCabang: string }> {
    const scope = new Set<string>(ctx.cabangDalamScope ?? [ctx.cabangId]);
    const semua = await repo.cabangBumn(tx(), ctx.bumnId);
    if (diminta === null || diminta === undefined) {
      if (semua.length === 0 || !semua.every((c) => scope.has(c.id))) {
        gagal(
          KODE_LAPORAN.CABANG_DILUAR_SCOPE,
          "Anda tidak berwenang membuka laporan untuk semua cabang.",
        );
      }
      return { cabangId: null, namaCabang: "Semua Cabang" };
    }
    const cabang = semua.find((c) => c.id === diminta);
    if (!cabang || !scope.has(diminta)) {
      gagal(
        KODE_LAPORAN.CABANG_DILUAR_SCOPE,
        "Anda tidak berwenang membuka laporan untuk cabang tersebut.",
      );
    }
    return { cabangId: cabang.id, namaCabang: cabang.nama };
  }

  async function ambilPeriode(ctx: LaporanContext, periodeId: string): Promise<PeriodeRow> {
    const p = periodeId ? await repo.periode(tx(), periodeId) : null;
    if (!p || p.bumn_id !== ctx.bumnId) {
      gagal(KODE_LAPORAN.PERIODE_TIDAK_DITEMUKAN, "Periode laporan tidak ditemukan.");
    }
    return p;
  }

  /** spec 5.6. A missing row is a refusal, never a guessed January. */
  async function bulanAwalTahunBuku(ctx: LaporanContext): Promise<number> {
    const { grup, kunci } = KUNCI_KONFIGURASI_LAPORAN.TAHUN_BUKU_MULAI_BULAN;
    const nilai = await repo.konfigurasi(tx(), ctx.bumnId, grup, kunci);
    if (nilai === null) {
      gagal(
        KODE_LAPORAN.KONFIGURASI_TIDAK_ADA,
        `Parameter ${grup}.${kunci} belum diatur, sehingga awal tahun buku tidak bisa ditentukan.`,
        { grup, kunci },
      );
    }
    const bulan = Number.parseInt(nilai, 10);
    if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12) {
      gagal(
        KODE_LAPORAN.KONFIGURASI_TIDAK_VALID,
        `Parameter ${grup}.${kunci} bukan bulan yang sah.`,
        { grup, kunci, nilai },
      );
    }
    return bulan;
  }

  // --- spec 10's two paths ------------------------------------------------

  /**
   * Which path this period is read through, and the one refusal spec 10 has no
   * other answer for.
   *
   * A CLOSED period with no frozen rows AND a ledger that carries lines up to
   * its end is a REFUSAL: recomputing would produce a plausible page that
   * violates invariant 14 and that nothing downstream could detect. A period
   * that closed with an empty ledger legitimately freezes nothing, and
   * refusing on that would make the first months of any go-live unreportable.
   */
  async function sumberUntuk(p: PeriodeRow): Promise<SumberData> {
    if (p.status !== "CLOSED") return "LEDGER_LIVE";
    if ((await repo.jumlahSaldoBeku(tx(), p.id)) > 0) return "SNAPSHOT_PERIODE";
    if (await repo.adaLedgerSampai(tx(), p.bumn_id, p.tanggal_akhir)) {
      gagal(
        KODE_LAPORAN.SALDO_PERIODE_BELUM_DIBEKUKAN,
        `Periode ${NAMA_BULAN[p.bulan - 1]} ${p.tahun} sudah ditutup tetapi saldo periodenya belum dibekukan, ` +
          "sehingga laporan tidak bisa dicetak tanpa menghitung ulang riwayat.",
        { periodeId: p.id, tahun: p.tahun, bulan: p.bulan },
      );
    }
    return "SNAPSHOT_PERIODE";
  }

  /**
   * Debit-positive balance per account at each of several cut-offs, from
   * whichever of spec 10's two paths applies.
   *
   * The CLOSED path answers a cut-off with the frozen closing balance of the
   * period that ENDS on it, which is why the two paths agree at the moment a
   * period closes and why a comparative column drawn from an earlier period is
   * the figure that period was closed with.
   */
  async function saldoPada(
    bumnId: string,
    cabangId: string | null,
    sumber: SumberData,
    tanggal: readonly string[],
  ): Promise<(akunId: string, indeks: number) => bigint> {
    if (sumber === "LEDGER_LIVE") {
      const peta = await repo.saldoLedgerPada(tx(), bumnId, cabangId, tanggal);
      return (akunId, indeks) => {
        const baris = peta.get(akunId);
        return baris ? uangDariDb(baris[indeks]) : 0n;
      };
    }
    const cache = new Map<string, Map<string, bigint>>();
    const kolom: Array<Map<string, bigint>> = [];
    for (const t of tanggal) {
      let peta = cache.get(t);
      if (!peta) {
        peta = new Map<string, bigint>();
        const periode = await repo.periodeSampai(tx(), bumnId, t);
        if (periode) {
          for (const row of await repo.saldoBeku(tx(), periode.id, cabangId)) {
            peta.set(row.akun_id, uangDariDb(row.saldo_akhir));
          }
        }
        cache.set(t, peta);
      }
      kolom.push(peta);
    }
    return (akunId, indeks) => kolom[indeks].get(akunId) ?? 0n;
  }

  /**
   * The trial balance of the SOURCE, at one cut-off. Zero or the statement is
   * refused.
   *
   * DELIBERATELY NOT "Total Aset = Total Liabilitas + Aset Neto". That
   * identity is a property of the LAYOUT (flip a `tanda` and it moves by twice
   * the line, legitimately), whereas an out-of-balance SOURCE is a corruption:
   * a `saldo_akun_periode` row written incorrectly is the one case that
   * survives every other check, because the table's own CHECK only validates a
   * row against itself.
   */
  function selisihNeraca(
    akun: readonly AkunRow[],
    saldo: (akunId: string, indeks: number) => bigint,
    indeks: number,
  ): bigint {
    let total = 0n;
    for (const a of akun) total += saldo(a.id, indeks);
    return total;
  }

  function pastikanBalance(selisih: bigint, konteks: string): void {
    if (selisih === 0n) return;
    gagal(
      KODE_LAPORAN.LAPORAN_TIDAK_BALANCE,
      `Laporan tidak balance: total debit dan kredit ${konteks} berselisih ${sen(selisih)}.`,
      { konteks, selisih: sen(selisih) },
    );
  }

  // --- the report header spec 10's preamble requires -----------------------

  async function buatHeader(
    ctx: LaporanContext,
    opsi: {
      namaLaporan: string;
      periode: PeriodeRow | null;
      periodeLabel: string;
      dariTanggal: TanggalIso | null;
      sampaiTanggal: TanggalIso | null;
      cabangId: string | null;
      namaCabang: string;
      sumberData: SumberData;
    },
  ): Promise<HeaderLaporan> {
    const bumn = await repo.bumn(tx(), ctx.bumnId);
    const pengguna = await repo.pengguna(tx(), ctx.userId);
    return {
      namaBumn: bumn?.nama ?? "",
      namaLaporan: opsi.namaLaporan,
      periodeLabel: opsi.periodeLabel,
      periodeId: opsi.periode?.id ?? null,
      statusPeriode: (opsi.periode?.status ?? null) as StatusPeriode | null,
      dariTanggal: opsi.dariTanggal,
      sampaiTanggal: opsi.sampaiTanggal,
      cabangId: opsi.cabangId,
      namaCabang: opsi.namaCabang,
      tanggalCetak: jam().toISOString().slice(0, 10),
      dicetakOleh: pengguna?.nama ?? "",
      sumberData: opsi.sumberData,
    };
  }

  // --- the template, and the lines that ARE the layout ---------------------

  interface BarisTerpakai {
    row: BarisLaporanRow;
    akun: AkunRow[];
  }

  interface Templat {
    templateId: string;
    akun: AkunRow[];
    akunPostable: AkunRow[];
    /** account id -> the ACTIVE line of one statement it prints on. */
    barisUntukAkun: Map<string, Map<string, string>>;
  }

  async function muatTemplat(bumnId: string, tanggal: string): Promise<Templat> {
    const templateId = await repo.templateBerlaku(tx(), bumnId, tanggal);
    if (!templateId) {
      gagal(
        KODE_LAPORAN.TEMPLATE_LAPORAN_KOSONG,
        "Belum ada template laporan yang berlaku untuk tanggal ini.",
        { tanggal },
      );
    }
    const akun = await repo.akun(tx(), bumnId);
    const barisUntukAkun = new Map<string, Map<string, string>>();
    for (const pm of await repo.pemetaan(tx(), bumnId, templateId)) {
      let per = barisUntukAkun.get(pm.akun_id);
      if (!per) {
        per = new Map<string, string>();
        barisUntukAkun.set(pm.akun_id, per);
      }
      per.set(pm.laporan, pm.baris_id);
    }
    return {
      templateId,
      akun,
      akunPostable: akun.filter((a) => a.is_postable),
      barisUntukAkun,
    };
  }

  /**
   * The printed lines of one statement, each with the POSTABLE accounts that
   * feed it. Empty is a REFUSAL: a code fallback here would defeat the whole
   * "tanpa deploy" requirement of spec 4.2, and a statement printed from a
   * layout nobody configured is a statement nobody can correct.
   */
  async function muatBaris(
    bumnId: string,
    templat: Templat,
    laporan: string,
  ): Promise<BarisTerpakai[]> {
    const rows = await repo.barisLaporan(tx(), bumnId, templat.templateId, laporan);
    if (rows.length === 0) {
      gagal(
        KODE_LAPORAN.TEMPLATE_LAPORAN_KOSONG,
        `Template laporan ${laporan} tidak punya satu pun baris aktif.`,
        { laporan },
      );
    }
    const perBaris = new Map<string, AkunRow[]>();
    for (const a of templat.akunPostable) {
      const barisId = templat.barisUntukAkun.get(a.id)?.get(laporan);
      if (!barisId) continue;
      const daftar = perBaris.get(barisId);
      if (daftar) daftar.push(a);
      else perBaris.set(barisId, [a]);
    }
    const terpakai = rows.map((row) => ({
      row,
      akun: (perBaris.get(row.id) ?? []).sort((x, y) => (x.kode < y.kode ? -1 : 1)),
    }));
    // A SUBTOTAL or TOTAL that sums nothing is a broken template, not a zero.
    const anak = new Map<string, BarisTerpakai[]>();
    for (const b of terpakai) {
      if (!b.row.parent_kode) continue;
      const daftar = anak.get(b.row.parent_kode);
      if (daftar) daftar.push(b);
      else anak.set(b.row.parent_kode, [b]);
    }
    for (const b of terpakai) {
      if (b.row.tipe_baris !== "SUBTOTAL" && b.row.tipe_baris !== "TOTAL") continue;
      if (turunanDetail(b, anak).length === 0) {
        gagal(
          KODE_LAPORAN.TEMPLATE_LAPORAN_TIDAK_VALID,
          `Baris ${b.row.kode} adalah ${b.row.tipe_baris} tetapi tidak menaungi satu baris rincian pun.`,
          { baris: b.row.kode },
        );
      }
    }
    return terpakai;
  }

  function turunanDetail(
    induk: BarisTerpakai,
    anak: Map<string, BarisTerpakai[]>,
    dilihat = new Set<string>(),
  ): BarisTerpakai[] {
    if (dilihat.has(induk.row.kode)) {
      gagal(
        KODE_LAPORAN.TEMPLATE_LAPORAN_TIDAK_VALID,
        `Baris ${induk.row.kode} membentuk lingkaran induk-anak.`,
        { baris: induk.row.kode },
      );
    }
    dilihat.add(induk.row.kode);
    const keluar: BarisTerpakai[] = [];
    for (const a of anak.get(induk.row.kode) ?? []) {
      if (a.row.tipe_baris === "DETAIL") keluar.push(a);
      else keluar.push(...turunanDetail(a, anak, dilihat));
    }
    return keluar;
  }

  /**
   * An account carrying a balance whose line was deactivated would have its
   * balance silently vanish and the statement would stop adding up. That is
   * the operator mistake worth refusing on, and the refusal names the accounts
   * so the fix is a COA or template edit rather than an investigation.
   */
  function pastikanTerpetakan(
    templat: Templat,
    laporan: string,
    kandidat: readonly AkunRow[],
    bernilai: (a: AkunRow) => boolean,
  ): void {
    const hilang = kandidat
      .filter((a) => bernilai(a) && !templat.barisUntukAkun.get(a.id)?.get(laporan))
      .map((a) => a.kode)
      .sort();
    if (hilang.length === 0) return;
    gagal(
      KODE_LAPORAN.AKUN_TIDAK_TERPETAKAN,
      `Akun ${hilang.join(", ")} punya saldo tetapi tidak dipetakan ke baris ${laporan} yang aktif.`,
      { laporan, akun: hilang },
    );
  }

  /** One printed line, with `tanda` already applied to both figures. */
  function baris(
    b: BarisTerpakai,
    nilai: (a: AkunRow, kolom: 0 | 1) => bigint,
    tambahan?: (kolom: 0 | 1) => bigint,
  ): BarisStatement {
    const tanda = tandaBaris(b.row);
    const t = BigInt(tanda);
    const hitung = (kolom: 0 | 1): bigint => {
      let total = tambahan ? tambahan(kolom) : 0n;
      for (const a of b.akun) total += arah(a) * nilai(a, kolom);
      return t * total;
    };
    return {
      barisLaporanId: b.row.id,
      kode: b.row.kode,
      nama: b.row.nama,
      parentKode: b.row.parent_kode,
      urutan: Number(b.row.urutan),
      level: Number(b.row.level),
      tipeBaris: b.row.tipe_baris as TipeBaris,
      seksi: b.row.seksi,
      tanda,
      cetakTebal: b.row.tipe_baris !== "DETAIL",
      akunKode: b.akun.map((a) => a.kode),
      nilaiTahunIni: angka(hitung(0)),
      nilaiTahunLalu: angka(hitung(1)),
    };
  }

  function totalDetail(baris: readonly BarisStatement[], kolom: "ini" | "lalu"): bigint {
    let total = 0n;
    for (const b of baris) {
      if (b.tipeBaris !== "DETAIL") continue;
      total += keSen(kolom === "ini" ? b.nilaiTahunIni.nilai : b.nilaiTahunLalu.nilai);
    }
    return total;
  }

  // --- the net-asset attribution reports 17, 19 and 20 share ---------------

  /**
   * The surplus of one net-asset category, from the AKTIVITAS lines whose
   * `seksi` names it. Reports 17, 19 and 20 are one number seen three ways, so
   * they compute it once, here.
   *
   * An AKTIVITAS line whose `seksi` names no category is a REFUSAL, never a
   * silent drop: a dropped movement makes `saldoAkhir != saldoAwal +
   * perubahan` and no reader can tie the page.
   */
  function surplusPerSeksi(
    barisAktivitas: readonly BarisTerpakai[],
    kategori: readonly string[] | null,
    nilai: (a: AkunRow, kolom: 0 | 1) => bigint,
  ): Map<string, [bigint, bigint]> {
    const keluar = new Map<string, [bigint, bigint]>();
    const tidakDikenal = new Set<string>();
    for (const b of barisAktivitas) {
      const seksi = b.row.seksi;
      if (kategori && (seksi === null || !kategori.includes(seksi))) {
        tidakDikenal.add(seksi ?? "(tanpa seksi)");
        continue;
      }
      const kunci = seksi ?? "";
      const t = BigInt(tandaBaris(b.row));
      const akum = keluar.get(kunci) ?? ([0n, 0n] as [bigint, bigint]);
      for (const kolom of [0, 1] as const) {
        let total = 0n;
        for (const a of b.akun) {
          const dir = arah(a) * nilai(a, kolom);
          total += a.tipe === "BEBAN" ? -dir : dir;
        }
        akum[kolom] += t * total;
      }
      keluar.set(kunci, akum);
    }
    if (tidakDikenal.size > 0) {
      const daftar = [...tidakDikenal].sort();
      gagal(
        KODE_LAPORAN.SEKSI_ASET_NETO_TIDAK_DIKENAL,
        `Seksi ${daftar.join(", ")} pada baris Laporan Aktivitas tidak cocok dengan satu pun kategori aset neto.`,
        { seksi: daftar },
      );
    }
    return keluar;
  }

  function kategoriAsetNeto(barisPosisi: readonly BarisTerpakai[]): BarisTerpakai[] {
    return barisPosisi.filter(
      (b) => b.row.seksi === SEKSI_ASET_NETO && b.row.tipe_baris === "DETAIL",
    );
  }

  // -------------------------------------------------------------------------
  // 16. Bagan Akun
  // -------------------------------------------------------------------------

  async function baganAkun(
    filter: FilterBaganAkun,
    ctx: LaporanContext,
  ): Promise<LaporanBaganAkun> {
    pastikanIzin(ctx);
    // The chart belongs to the entity, not to a branch, so this report is
    // always Semua Cabang and therefore needs the same scope that option needs.
    const { cabangId, namaCabang } = await pastikanCabang(ctx, null);
    const hariIni = jam().toISOString().slice(0, 10);
    const templat = await muatTemplat(ctx.bumnId, hariIni);

    const kodeBaris = new Map<string, string>();
    for (const laporan of ["POSISI_KEUANGAN", "AKTIVITAS", "PERUBAHAN_ASET_NETO", "ARUS_KAS"]) {
      for (const row of await repo.barisLaporan(tx(), ctx.bumnId, templat.templateId, laporan)) {
        kodeBaris.set(row.id, row.kode);
      }
    }

    const baris: BarisBaganAkun[] = templat.akun
      .filter((a) => (filter.hanyaAktif ? a.aktif : true))
      .map((a) => {
        const per = templat.barisUntukAkun.get(a.id);
        const barisId =
          per?.get("POSISI_KEUANGAN") ??
          per?.get("AKTIVITAS") ??
          per?.get("PERUBAHAN_ASET_NETO") ??
          per?.get("ARUS_KAS");
        return {
          akunId: a.id,
          kode: a.kode,
          nama: a.nama,
          parentId: a.parent_id,
          level: Number(a.level),
          tipe: a.tipe as TipeAkun,
          saldoNormal: a.saldo_normal as SaldoNormal,
          isPostable: a.is_postable,
          isKas: a.is_kas,
          isKontra: a.is_kontra,
          klasifikasiArusKas: (a.klasifikasi_arus_kas ?? null) as KlasifikasiArusKas | null,
          // The printed line this account lands on. Falls back to the
          // classification's own code, which migrations/0028's identity
          // backfill makes the same string.
          klasifikasiLaporan: (barisId ? kodeBaris.get(barisId) : undefined) ?? a.klasifikasi_akun,
          aktif: a.aktif,
          status: a.aktif ? "Aktif" : "Nonaktif",
        };
      });

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.BAGAN_AKUN,
        periode: null,
        periodeLabel: `Per ${labelTanggal(hariIni)}`,
        dariTanggal: null,
        sampaiTanggal: null,
        cabangId,
        namaCabang,
        sumberData: "LEDGER_LIVE",
      }),
      baris,
    };
  }

  // -------------------------------------------------------------------------
  // 17. Laporan Aktivitas
  // -------------------------------------------------------------------------

  async function laporanAktivitas(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanAktivitas> {
    pastikanIzin(ctx);
    const { cabangId, namaCabang } = await pastikanCabang(ctx, filter.cabangId);
    const p = await ambilPeriode(ctx, filter.periodeId);
    const sumber = await sumberUntuk(p);
    const bulanMulai = await bulanAwalTahunBuku(ctx);

    // A span, and the comparative is the SAME SPAN one year earlier. Different
    // convention from report 19 on purpose; both are returned so a caller never
    // has to guess which it got.
    const dariIni = awalTahunBuku(p.tanggal_akhir, bulanMulai);
    const sampaiIni = p.tanggal_akhir;
    const dariLalu = mundurSetahun(dariIni);
    const sampaiLalu = mundurSetahun(sampaiIni);
    const kolom: KolomPembanding = {
      labelTahunIni: labelRentang(dariIni, sampaiIni),
      dariTahunIni: dariIni,
      sampaiTahunIni: sampaiIni,
      labelTahunLalu: labelRentang(dariLalu, sampaiLalu),
      dariTahunLalu: dariLalu,
      sampaiTahunLalu: sampaiLalu,
    };

    const templat = await muatTemplat(ctx.bumnId, sampaiIni);
    const barisAktivitas = await muatBaris(ctx.bumnId, templat, "AKTIVITAS");
    const tanggal = [tambahHari(dariIni, -1), sampaiIni, tambahHari(dariLalu, -1), sampaiLalu];
    const saldo = await saldoPada(ctx.bumnId, cabangId, sumber, tanggal);
    const gerak = (a: AkunRow, k: 0 | 1): bigint =>
      saldo(a.id, k === 0 ? 1 : 3) - saldo(a.id, k === 0 ? 0 : 2);

    const hasil = templat.akunPostable.filter((a) => a.tipe === "PENDAPATAN" || a.tipe === "BEBAN");
    pastikanTerpetakan(templat, "AKTIVITAS", hasil, (a) => gerak(a, 0) !== 0n || gerak(a, 1) !== 0n);

    const semuaBaris = barisAktivitas.map((b) => baris(b, gerak));
    const perKode = new Map(barisAktivitas.map((b) => [b.row.kode, b]));

    // Sections come from `baris_laporan.seksi`, in the order of each section's
    // first line, and each carries its own bottom line.
    const urutanSeksi: string[] = [];
    const anggota = new Map<string, BarisStatement[]>();
    for (const b of semuaBaris) {
      const kunci = b.seksi ?? "";
      if (!anggota.has(kunci)) {
        anggota.set(kunci, []);
        urutanSeksi.push(kunci);
      }
      anggota.get(kunci)!.push(b);
    }

    const namaSeksi = new Map<string, string>();
    for (const row of await repo.barisLaporan(
      tx(),
      ctx.bumnId,
      templat.templateId,
      "POSISI_KEUANGAN",
    )) {
      namaSeksi.set(row.kode, row.nama);
    }

    const seksi: SeksiAktivitas[] = urutanSeksi.map((kunci) => {
      const anggotaSeksi = anggota.get(kunci)!;
      const jumlahTipe = (tipe: "PENDAPATAN" | "BEBAN", k: 0 | 1): bigint => {
        let total = 0n;
        for (const b of anggotaSeksi) {
          const sumberBaris = perKode.get(b.kode)!;
          const t = BigInt(b.tanda);
          for (const a of sumberBaris.akun) {
            if (a.tipe !== tipe) continue;
            total += t * arah(a) * gerak(a, k);
          }
        }
        return total;
      };
      const pendIni = jumlahTipe("PENDAPATAN", 0);
      const pendLalu = jumlahTipe("PENDAPATAN", 1);
      const bebanIni = jumlahTipe("BEBAN", 0);
      const bebanLalu = jumlahTipe("BEBAN", 1);
      return {
        kode: kunci,
        nama: namaSeksi.get(kunci) ?? kunci,
        baris: anggotaSeksi,
        totalPendapatanTahunIni: angka(pendIni),
        totalPendapatanTahunLalu: angka(pendLalu),
        totalBebanTahunIni: angka(bebanIni),
        totalBebanTahunLalu: angka(bebanLalu),
        kenaikanAsetNetoTahunIni: angka(pendIni - bebanIni),
        kenaikanAsetNetoTahunLalu: angka(pendLalu - bebanLalu),
      };
    });

    const kenaikanIni = seksi.reduce((t, s) => t + keSen(s.kenaikanAsetNetoTahunIni.nilai), 0n);
    const kenaikanLalu = seksi.reduce((t, s) => t + keSen(s.kenaikanAsetNetoTahunLalu.nilai), 0n);

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.AKTIVITAS,
        periode: p,
        periodeLabel: labelRentang(dariIni, sampaiIni),
        dariTanggal: dariIni,
        sampaiTanggal: sampaiIni,
        cabangId,
        namaCabang,
        sumberData: sumber,
      }),
      kolom,
      seksi,
      baris: semuaBaris,
      kenaikanAsetNetoTahunIni: angka(kenaikanIni),
      kenaikanAsetNetoTahunLalu: angka(kenaikanLalu),
    };
  }

  // -------------------------------------------------------------------------
  // 19. Laporan Posisi Keuangan
  // -------------------------------------------------------------------------

  async function laporanPosisiKeuangan(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPosisiKeuangan> {
    pastikanIzin(ctx);
    const { cabangId, namaCabang } = await pastikanCabang(ctx, filter.cabangId);
    const p = await ambilPeriode(ctx, filter.periodeId);
    const sumber = await sumberUntuk(p);
    const bulanMulai = await bulanAwalTahunBuku(ctx);

    // A point in time, and the comparative is the END OF THE PRECEDING
    // FINANCIAL YEAR, which is what an interim statement of financial position
    // carries. That date is also the day before the current financial year
    // starts, which is why one cut-off serves both the comparative column and
    // the current year's movement.
    const sampaiIni = p.tanggal_akhir;
    const awalTahun = awalTahunBuku(sampaiIni, bulanMulai);
    const sampaiLalu = tambahHari(awalTahun, -1);
    const dariLalu = awalTahunBuku(sampaiLalu, bulanMulai);
    const kolom: KolomPembanding = {
      labelTahunIni: `Per ${labelTanggal(sampaiIni)}`,
      dariTahunIni: sampaiIni,
      sampaiTahunIni: sampaiIni,
      labelTahunLalu: `Per ${labelTanggal(sampaiLalu)}`,
      dariTahunLalu: dariLalu,
      sampaiTahunLalu: sampaiLalu,
    };

    const templat = await muatTemplat(ctx.bumnId, sampaiIni);
    const barisPosisi = await muatBaris(ctx.bumnId, templat, "POSISI_KEUANGAN");
    const barisAktivitas = await muatBaris(ctx.bumnId, templat, "AKTIVITAS");
    // Three cut-offs: this column, the comparative column, and the start of the
    // comparative financial year, which is what makes the prior year's own
    // movement a figure rather than a cumulative total.
    const saldo = await saldoPada(ctx.bumnId, cabangId, sumber, [
      sampaiIni,
      sampaiLalu,
      tambahHari(dariLalu, -1),
    ]);
    const nilaiAkun = (a: AkunRow, k: 0 | 1): bigint => saldo(a.id, k);
    const bernilai = (a: AkunRow) => nilaiAkun(a, 0) !== 0n || nilaiAkun(a, 1) !== 0n;

    pastikanTerpetakan(
      templat,
      "POSISI_KEUANGAN",
      templat.akunPostable.filter(
        (a) => a.tipe === "ASET" || a.tipe === "LIABILITAS" || a.tipe === "ASET_NETO",
      ),
      bernilai,
    );
    pastikanTerpetakan(
      templat,
      "AKTIVITAS",
      templat.akunPostable.filter((a) => a.tipe === "PENDAPATAN" || a.tipe === "BEBAN"),
      bernilai,
    );

    // NET ASSETS IS NOT THE SUM OF THE ASET_NETO ACCOUNTS. This system posts no
    // year-end closing entry, so every period's surplus since inception is
    // still in PENDAPATAN and BEBAN. The surplus is attributed to the category
    // lines by the same rule report 20 uses, so the section FOOTS to its own
    // total instead of the total carrying money the printed lines do not show.
    const kategori = kategoriAsetNeto(barisPosisi);
    const kodeKategori = kategori.map((b) => b.row.kode);
    const surplus = [0, 1, 2].map((i) =>
      surplusPerSeksi(barisAktivitas, kodeKategori, (a) => saldo(a.id, i)),
    );
    const surplusUntuk = (kode: string, k: 0 | 1 | 2): bigint => surplus[k].get(kode)?.[0] ?? 0n;

    const semuaBaris = barisPosisi.map((b) =>
      b.row.seksi === SEKSI_ASET_NETO && b.row.tipe_baris === "DETAIL"
        ? baris(b, nilaiAkun, (k) => surplusUntuk(b.row.kode, k))
        : baris(b, nilaiAkun),
    );

    const barisAset = semuaBaris.filter((b) => b.seksi === SEKSI_ASET);
    const barisLiabilitas = semuaBaris.filter((b) => b.seksi === SEKSI_LIABILITAS);
    const barisAsetNeto = semuaBaris.filter((b) => b.seksi === SEKSI_ASET_NETO);

    // The source must balance before anything is printed. See selisihNeraca.
    pastikanBalance(selisihNeraca(templat.akunPostable, saldo, 0), `per ${sampaiIni}`);
    pastikanBalance(selisihNeraca(templat.akunPostable, saldo, 1), `per ${sampaiLalu}`);

    const kas = templat.akunPostable.filter((a) => a.is_kas);
    const kasPada = (k: 0 | 1): bigint => kas.reduce((t, a) => t + saldo(a.id, k), 0n);

    // Report 17's bottom line, seen from the balance sheet: the cumulative
    // surplus at the cut-off less the cumulative surplus at the start of that
    // financial year. Nothing ever closes PENDAPATAN and BEBAN into net assets
    // in this system, so a period's movement is always a difference of two
    // cumulative readings.
    const kumulatif = (k: 0 | 1 | 2): bigint => {
      let total = 0n;
      for (const kode of kodeKategori) total += surplusUntuk(kode, k);
      return total;
    };
    const kenaikanIni = kumulatif(0) - kumulatif(1);
    const kenaikanLalu = kumulatif(1) - kumulatif(2);

    const totalAsetIni = totalDetail(barisAset, "ini");
    const totalAsetLalu = totalDetail(barisAset, "lalu");
    const totalLiabIni = totalDetail(barisLiabilitas, "ini");
    const totalLiabLalu = totalDetail(barisLiabilitas, "lalu");
    const totalNetoIni = totalDetail(barisAsetNeto, "ini");
    const totalNetoLalu = totalDetail(barisAsetNeto, "lalu");

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.POSISI_KEUANGAN,
        periode: p,
        periodeLabel: `Per ${labelTanggal(sampaiIni)}`,
        dariTanggal: sampaiIni,
        sampaiTanggal: sampaiIni,
        cabangId,
        namaCabang,
        sumberData: sumber,
      }),
      kolom,
      baris: semuaBaris,
      barisAset,
      barisLiabilitas,
      barisAsetNeto,
      totalAsetTahunIni: angka(totalAsetIni),
      totalAsetTahunLalu: angka(totalAsetLalu),
      totalLiabilitasTahunIni: angka(totalLiabIni),
      totalLiabilitasTahunLalu: angka(totalLiabLalu),
      totalAsetNetoTahunIni: angka(totalNetoIni),
      totalAsetNetoTahunLalu: angka(totalNetoLalu),
      kenaikanAsetNetoPeriodeBerjalanTahunIni: angka(kenaikanIni),
      kenaikanAsetNetoPeriodeBerjalanTahunLalu: angka(kenaikanLalu),
      totalLiabilitasDanAsetNetoTahunIni: angka(totalLiabIni + totalNetoIni),
      totalLiabilitasDanAsetNetoTahunLalu: angka(totalLiabLalu + totalNetoLalu),
      kasDanSetaraKasTahunIni: angka(kasPada(0)),
      kasDanSetaraKasTahunLalu: angka(kasPada(1)),
    };
  }

  // -------------------------------------------------------------------------
  // 20. Laporan Perubahan Aset Neto
  // -------------------------------------------------------------------------

  async function laporanPerubahanAsetNeto(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPerubahanAsetNeto> {
    pastikanIzin(ctx);
    const { cabangId, namaCabang } = await pastikanCabang(ctx, filter.cabangId);
    const p = await ambilPeriode(ctx, filter.periodeId);
    const sumber = await sumberUntuk(p);
    const bulanMulai = await bulanAwalTahunBuku(ctx);

    const dariIni = awalTahunBuku(p.tanggal_akhir, bulanMulai);
    const sampaiIni = p.tanggal_akhir;
    const dariLalu = mundurSetahun(dariIni);
    const sampaiLalu = mundurSetahun(sampaiIni);
    const kolom: KolomPembanding = {
      labelTahunIni: labelRentang(dariIni, sampaiIni),
      dariTahunIni: dariIni,
      sampaiTahunIni: sampaiIni,
      labelTahunLalu: labelRentang(dariLalu, sampaiLalu),
      dariTahunLalu: dariLalu,
      sampaiTahunLalu: sampaiLalu,
    };

    const templat = await muatTemplat(ctx.bumnId, sampaiIni);
    const barisPosisi = await muatBaris(ctx.bumnId, templat, "POSISI_KEUANGAN");
    const barisAktivitas = await muatBaris(ctx.bumnId, templat, "AKTIVITAS");

    // Four cut-offs: the opening and closing of both columns. A category's
    // balance at a cut-off is its accounts PLUS the cumulative surplus of the
    // AKTIVITAS lines that name it, which is the same figure report 19 prints
    // on that line, so `saldoAkhir = saldoAwal + perubahan` holds even for a
    // category an ordinary journal moved directly.
    const tanggal = [tambahHari(dariIni, -1), sampaiIni, tambahHari(dariLalu, -1), sampaiLalu];
    const saldo = await saldoPada(ctx.bumnId, cabangId, sumber, tanggal);
    const kategori = kategoriAsetNeto(barisPosisi);
    const kodeKategori = kategori.map((b) => b.row.kode);
    const surplus = tanggal.map((_, i) =>
      surplusPerSeksi(barisAktivitas, kodeKategori, (a) => saldo(a.id, i)),
    );

    const nilaiKategori = (b: (typeof kategori)[number], i: number): bigint => {
      const t = BigInt(tandaBaris(b.row));
      let total = surplus[i].get(b.row.kode)?.[0] ?? 0n;
      for (const a of b.akun) total += arah(a) * saldo(a.id, i);
      return t * total;
    };

    const baris: BarisPerubahanAsetNeto[] = kategori.map((b) => {
      const awalIni = nilaiKategori(b, 0);
      const akhirIni = nilaiKategori(b, 1);
      const awalLalu = nilaiKategori(b, 2);
      const akhirLalu = nilaiKategori(b, 3);
      return {
        kategoriKode: b.row.kode,
        nama: b.row.nama,
        urutan: Number(b.row.urutan),
        saldoAwalTahunIni: angka(awalIni),
        perubahanTahunIni: angka(akhirIni - awalIni),
        saldoAkhirTahunIni: angka(akhirIni),
        saldoAwalTahunLalu: angka(awalLalu),
        perubahanTahunLalu: angka(akhirLalu - awalLalu),
        saldoAkhirTahunLalu: angka(akhirLalu),
      };
    });

    const jumlahKolom = (ambil: (b: BarisPerubahanAsetNeto) => Angka): bigint =>
      baris.reduce((t, b) => t + keSen(ambil(b).nilai), 0n);

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.PERUBAHAN_ASET_NETO,
        periode: p,
        periodeLabel: labelRentang(dariIni, sampaiIni),
        dariTanggal: dariIni,
        sampaiTanggal: sampaiIni,
        cabangId,
        namaCabang,
        sumberData: sumber,
      }),
      kolom,
      baris,
      totalSaldoAwalTahunIni: angka(jumlahKolom((b) => b.saldoAwalTahunIni)),
      totalPerubahanTahunIni: angka(jumlahKolom((b) => b.perubahanTahunIni)),
      totalSaldoAkhirTahunIni: angka(jumlahKolom((b) => b.saldoAkhirTahunIni)),
      totalSaldoAwalTahunLalu: angka(jumlahKolom((b) => b.saldoAwalTahunLalu)),
      totalPerubahanTahunLalu: angka(jumlahKolom((b) => b.perubahanTahunLalu)),
      totalSaldoAkhirTahunLalu: angka(jumlahKolom((b) => b.saldoAkhirTahunLalu)),
    };
  }

  // -------------------------------------------------------------------------
  // 18. Laporan Arus Kas
  // -------------------------------------------------------------------------

  async function laporanArusKas(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanArusKas> {
    pastikanIzin(ctx);
    const { cabangId, namaCabang } = await pastikanCabang(ctx, filter.cabangId);
    const p = await ambilPeriode(ctx, filter.periodeId);
    const sumber = await sumberUntuk(p);
    const bulanMulai = await bulanAwalTahunBuku(ctx);

    const dariIni = awalTahunBuku(p.tanggal_akhir, bulanMulai);
    const sampaiIni = p.tanggal_akhir;
    const dariLalu = mundurSetahun(dariIni);
    const sampaiLalu = mundurSetahun(sampaiIni);
    const kolom: KolomPembanding = {
      labelTahunIni: labelRentang(dariIni, sampaiIni),
      dariTahunIni: dariIni,
      sampaiTahunIni: sampaiIni,
      labelTahunLalu: labelRentang(dariLalu, sampaiLalu),
      dariTahunLalu: dariLalu,
      sampaiTahunLalu: sampaiLalu,
    };

    const templat = await muatTemplat(ctx.bumnId, sampaiIni);
    const akunKasSemua = templat.akunPostable.filter((a) => a.is_kas);

    // KAS AWAL AND KAS AKHIR COME FROM THE `is_kas` ACCOUNT BALANCES, never
    // from the sections, and BOTH columns are the same shape: the balance the
    // day before the span opens and the balance on the day it closes.
    //
    // THE COMPARATIVE COLUMN IS LIKE FOR LIKE, A SPAN AND NOT A POINT. A cash
    // flow statement is a FLOW statement, so its comparative is the same span
    // one year earlier (Laporan Aktivitas's convention), and its closing cash
    // is the cash at the END OF THAT SPAN. That is deliberately NOT Laporan
    // Posisi Keuangan's comparative, which is the preceding financial year END
    // because a position is a point; the two differ by the prior year's
    // movements after the comparative span, and ./laporan-arus-kas.test.ts
    // asserts they differ rather than leaving it to be found.
    //
    // WHAT SPEC 10.3 REPORT 18 NAMES BY TEST IS UNAFFECTED: "Kas Akhir wajib
    // sama dengan saldo akun berflag is_kas di Laporan Posisi Keuangan" is
    // about the period being reported, i.e. the CURRENT column, which ties to
    // report 19 exactly.
    const tanggalKas = [
      tambahHari(dariIni, -1),
      sampaiIni,
      tambahHari(dariLalu, -1),
      sampaiLalu,
    ];
    const saldo = await saldoPada(ctx.bumnId, cabangId, sumber, tanggalKas);
    const totalKas = (i: number): bigint =>
      akunKasSemua.reduce((t, a) => t + saldo(a.id, i), 0n);
    const kasAwalIni = totalKas(0);
    const kasAkhirIni = totalKas(1);
    const kasAwalLalu = totalKas(2);
    const kasAkhirLalu = totalKas(3);

    // THE DIRECT METHOD. Movements ON the cash accounts, classified by the
    // `klasifikasi_arus_kas` of the counter-account in the SAME journal, always
    // from the ledger: a frozen per-account balance cannot say which journal a
    // movement belonged to, so this is the one part of a CLOSED period's
    // statement that is a ledger read. The FIGURES a closed period is judged on
    // (Kas Awal, Kas Akhir) come from the frozen rows above.
    const lawanIni = await repo.lawanKas(tx(), ctx.bumnId, cabangId, dariIni, sampaiIni);
    const lawanLalu = await repo.lawanKas(tx(), ctx.bumnId, cabangId, dariLalu, sampaiLalu);

    // COMPLETENESS IS CHECKED OVER BOTH COLUMNS, not just the reporting year.
    // An unclassified counter-account cannot be bucketed, and dropping it
    // breaks the closing cash of whichever column it belonged to. Checking only
    // the current span would reproduce exactly that silent drop one column
    // over, for any counter-account that appears in the prior year and not in
    // this one. Never a fourth bucket, never a silent drop, in either column.
    const belumTerklasifikasi = [
      ...new Set(
        [...lawanIni, ...lawanLalu]
          .filter((r) => r.klasifikasi_arus_kas === null)
          .map((r) => r.kode),
      ),
    ].sort();
    if (belumTerklasifikasi.length > 0) {
      gagal(
        KODE_LAPORAN.KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP,
        `Akun ${belumTerklasifikasi.join(", ")} menjadi lawan mutasi kas tetapi belum punya klasifikasi arus kas.`,
        { akun: belumTerklasifikasi },
      );
    }

    const nilaiLalu = new Map(lawanLalu.map((r) => [r.akun_id, uangDariDb(r.nilai)]));
    const namaSeksiArus = new Map<string, string>();
    for (const row of await repo.barisLaporan(tx(), ctx.bumnId, templat.templateId, "ARUS_KAS")) {
      if (row.seksi) namaSeksiArus.set(row.seksi, row.nama);
    }

    // A SECTION TOTAL IS THE WHOLE SPAN, per column, over every counter-account
    // classified into that section. Summing the printed rows instead would make
    // the comparative total depend on which accounts happen to appear in the
    // CURRENT year, and the column would then no longer foot to the movement in
    // cash. See the note on `baris` below.
    const totalSeksi = (
      baris: readonly { klasifikasi_arus_kas: string | null; nilai: string }[],
      klasifikasi: KlasifikasiArusKas,
    ): bigint =>
      baris
        .filter((r) => r.klasifikasi_arus_kas === klasifikasi)
        .reduce((t, r) => t + uangDariDb(r.nilai), 0n);

    const seksi: SeksiArusKas[] = URUTAN_ARUS_KAS.map((klasifikasi) => {
      const barisSeksi: BarisArusKas[] = lawanIni
        .filter((r) => r.klasifikasi_arus_kas === klasifikasi)
        .map((r) => ({
          akunId: r.akun_id,
          akunKode: r.kode,
          // The caption is the account's own name, which is data.
          uraian: r.nama,
          nilaiTahunIni: angka(uangDariDb(r.nilai)),
          nilaiTahunLalu: angka(nilaiLalu.get(r.akun_id) ?? 0n),
        }))
        .filter(
          (b) => keSen(b.nilaiTahunIni.nilai) !== 0n || keSen(b.nilaiTahunLalu.nilai) !== 0n,
        );
      return {
        klasifikasi,
        nama: namaSeksiArus.get(klasifikasi) ?? klasifikasi,
        // KNOWN GAP, LOUD RATHER THAN SILENT. The printed rows are the
        // counter-accounts of the REPORTING span, so a counter-account that
        // appears only in the comparative span (in the fixture's world, the
        // opening funding through `3.1.01`) contributes to `totalTahunLalu`
        // without printing a line of its own, and the comparative column does
        // not foot to its printed rows. Widening the row set to the union of
        // both spans is the fix and is a two-line change here; it is blocked by
        // ./laporan-arus-kas.test.ts asserting the PENDANAAN section prints
        // exactly one row. The totals are the figure that must be right, so
        // they are complete and this is reported upward rather than papered
        // over by narrowing them back.
        baris: barisSeksi,
        totalTahunIni: angka(totalSeksi(lawanIni, klasifikasi)),
        totalTahunLalu: angka(totalSeksi(lawanLalu, klasifikasi)),
      };
    });

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.ARUS_KAS,
        periode: p,
        periodeLabel: labelRentang(dariIni, sampaiIni),
        dariTanggal: dariIni,
        sampaiTanggal: sampaiIni,
        cabangId,
        namaCabang,
        sumberData: sumber,
      }),
      kolom,
      seksi,
      kenaikanKasTahunIni: angka(kasAkhirIni - kasAwalIni),
      kenaikanKasTahunLalu: angka(kasAkhirLalu - kasAwalLalu),
      kasAwalTahunIni: angka(kasAwalIni),
      kasAwalTahunLalu: angka(kasAwalLalu),
      kasAkhirTahunIni: angka(kasAkhirIni),
      kasAkhirTahunLalu: angka(kasAkhirLalu),
      akunKas: akunKasSemua.map((a) => ({
        akunId: a.id,
        kode: a.kode,
        nama: a.nama,
        saldo: angka(saldo(a.id, 1)),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 23. Neraca Lajur
  // -------------------------------------------------------------------------

  /**
   * The six figures of one period, per account, from whichever of spec 10's two
   * paths applies. THE PERIOD IS THE MONTH, NOT YEAR TO DATE: that is exactly
   * the shape `saldo_akun_periode` freezes, and any other window would make the
   * two paths structurally incapable of producing the same six numbers.
   */
  async function angkaPeriode(
    bumnId: string,
    cabangId: string | null,
    p: PeriodeRow,
    sumber: SumberData,
  ): Promise<Map<string, { awal: bigint; debit: bigint; kredit: bigint; akhir: bigint }>> {
    const keluar = new Map<string, { awal: bigint; debit: bigint; kredit: bigint; akhir: bigint }>();
    if (sumber === "SNAPSHOT_PERIODE") {
      for (const row of await repo.saldoBeku(tx(), p.id, cabangId)) {
        keluar.set(row.akun_id, {
          awal: uangDariDb(row.saldo_awal),
          debit: uangDariDb(row.mutasi_debit),
          kredit: uangDariDb(row.mutasi_kredit),
          akhir: uangDariDb(row.saldo_akhir),
        });
      }
      return keluar;
    }
    const sebelum = tambahHari(p.tanggal_mulai, -1);
    const saldo = await repo.saldoLedgerPada(tx(), bumnId, cabangId, [sebelum, p.tanggal_akhir]);
    const mutasi = await repo.mutasiLedger(
      tx(),
      bumnId,
      cabangId,
      p.tanggal_mulai,
      p.tanggal_akhir,
    );
    const petaMutasi = new Map(mutasi.map((m) => [m.akun_id, m]));
    for (const [akunId, kolom] of saldo) {
      const m = petaMutasi.get(akunId);
      keluar.set(akunId, {
        awal: uangDariDb(kolom[0]),
        debit: m ? uangDariDb(m.debit) : 0n,
        kredit: m ? uangDariDb(m.kredit) : 0n,
        akhir: uangDariDb(kolom[1]),
      });
    }
    return keluar;
  }

  async function neracaLajur(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanNeracaLajur> {
    pastikanIzin(ctx);
    const { cabangId, namaCabang } = await pastikanCabang(ctx, filter.cabangId);
    const p = await ambilPeriode(ctx, filter.periodeId);
    const sumber = await sumberUntuk(p);
    const akun = (await repo.akun(tx(), ctx.bumnId)).filter((a) => a.is_postable);
    const angkaPer = await angkaPeriode(ctx.bumnId, cabangId, p, sumber);

    // SIX COLUMNS, ALL NON-NEGATIVE: a balance shows in exactly one of its
    // pair. That is what makes the three totals comparable pairwise, and it is
    // why `saldo_akun_periode`'s debit-positive convention is split HERE rather
    // than passed through.
    const sisiD = (x: bigint) => (x > 0n ? x : 0n);
    const sisiK = (x: bigint) => (x < 0n ? -x : 0n);

    const baris: BarisNeracaLajur[] = [];
    for (const a of akun) {
      const n = angkaPer.get(a.id);
      if (!n) continue;
      if (n.awal === 0n && n.debit === 0n && n.kredit === 0n) continue;
      baris.push({
        akunId: a.id,
        kode: a.kode,
        nama: a.nama,
        tipe: a.tipe as TipeAkun,
        saldoNormal: a.saldo_normal as SaldoNormal,
        saldoAwalDebit: angka(sisiD(n.awal)),
        saldoAwalKredit: angka(sisiK(n.awal)),
        mutasiDebit: angka(n.debit),
        mutasiKredit: angka(n.kredit),
        saldoAkhirDebit: angka(sisiD(n.akhir)),
        saldoAkhirKredit: angka(sisiK(n.akhir)),
      });
    }
    baris.sort((x, y) => (x.kode < y.kode ? -1 : x.kode > y.kode ? 1 : 0));

    const jumlahKolom = (ambil: (b: BarisNeracaLajur) => Angka): bigint =>
      baris.reduce((t, b) => t + keSen(ambil(b).nilai), 0n);
    const total = {
      saldoAwalDebit: jumlahKolom((b) => b.saldoAwalDebit),
      saldoAwalKredit: jumlahKolom((b) => b.saldoAwalKredit),
      mutasiDebit: jumlahKolom((b) => b.mutasiDebit),
      mutasiKredit: jumlahKolom((b) => b.mutasiKredit),
      saldoAkhirDebit: jumlahKolom((b) => b.saldoAkhirDebit),
      saldoAkhirKredit: jumlahKolom((b) => b.saldoAkhirKredit),
    };
    pastikanBalance(total.saldoAwalDebit - total.saldoAwalKredit, "saldo awal");
    pastikanBalance(total.mutasiDebit - total.mutasiKredit, "mutasi");
    pastikanBalance(total.saldoAkhirDebit - total.saldoAkhirKredit, "saldo akhir");

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.NERACA_LAJUR,
        periode: p,
        periodeLabel: `${NAMA_BULAN[p.bulan - 1]} ${p.tahun}`,
        dariTanggal: p.tanggal_mulai,
        sampaiTanggal: p.tanggal_akhir,
        cabangId,
        namaCabang,
        sumberData: sumber,
      }),
      baris,
      total: {
        saldoAwalDebit: angka(total.saldoAwalDebit),
        saldoAwalKredit: angka(total.saldoAwalKredit),
        mutasiDebit: angka(total.mutasiDebit),
        mutasiKredit: angka(total.mutasiKredit),
        saldoAkhirDebit: angka(total.saldoAkhirDebit),
        saldoAkhirKredit: angka(total.saldoAkhirKredit),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 22. Buku Besar
  // -------------------------------------------------------------------------

  async function bukuBesar(
    filter: FilterBukuBesar,
    ctx: LaporanContext,
  ): Promise<LaporanBukuBesar> {
    pastikanIzin(ctx);
    const { cabangId, namaCabang } = await pastikanCabang(ctx, filter.cabangId);
    const p = await ambilPeriode(ctx, filter.periodeId);
    const sumber = await sumberUntuk(p);
    const akun = (await repo.akun(tx(), ctx.bumnId)).find((a) => a.id === filter.akunId);
    if (!akun) {
      gagal(KODE_LAPORAN.AKUN_TIDAK_DITEMUKAN, "Akun buku besar tidak ditemukan.");
    }

    const angkaPer = await angkaPeriode(ctx.bumnId, cabangId, p, sumber);
    const n = angkaPer.get(akun.id) ?? { awal: 0n, debit: 0n, kredit: 0n, akhir: 0n };
    const dir = arah(akun);

    // THE ENTRIES ALWAYS COME FROM THE LEDGER, in both paths: a frozen balance
    // is an aggregate and cannot be drilled into. What the CLOSED path changes
    // is the OPENING and CLOSING figures, which are the ones invariant 14 is
    // about.
    const mutasiRow = await repo.barisJurnal(
      tx(),
      ctx.bumnId,
      cabangId,
      akun.id,
      p.tanggal_mulai,
      p.tanggal_akhir,
    );
    let berjalan = dir * n.awal;
    const mutasi: BarisBukuBesar[] = mutasiRow.map((r) => {
      const debit = uangDariDb(r.debit);
      const kredit = uangDariDb(r.kredit);
      // In the ACCOUNT'S OWN direction, so a liability grows on a credit
      // instead of going negative.
      berjalan += dir * (debit - kredit);
      return {
        jurnalId: r.jurnal_id,
        jurnalBarisId: r.jurnal_baris_id,
        noJurnal: r.no_jurnal,
        tanggal: r.tanggal,
        jenisJurnal: r.jenis,
        keterangan: r.keterangan ?? "",
        debit: angka(debit),
        kredit: angka(kredit),
        saldoBerjalan: angka(berjalan),
        mitraId: r.mitra_id,
        akadId: r.akad_id,
        cabangId: r.cabang_id,
      };
    });

    return {
      header: await buatHeader(ctx, {
        namaLaporan: NAMA_LAPORAN.BUKU_BESAR,
        periode: p,
        periodeLabel: `${NAMA_BULAN[p.bulan - 1]} ${p.tahun}`,
        dariTanggal: p.tanggal_mulai,
        sampaiTanggal: p.tanggal_akhir,
        cabangId,
        namaCabang,
        sumberData: sumber,
      }),
      akunId: akun.id,
      akunKode: akun.kode,
      akunNama: akun.nama,
      tipe: akun.tipe as TipeAkun,
      saldoNormal: akun.saldo_normal as SaldoNormal,
      saldoAwal: angka(dir * n.awal),
      mutasi,
      totalDebit: angka(n.debit),
      totalKredit: angka(n.kredit),
      saldoAkhir: angka(dir * n.akhir),
    };
  }

  return {
    baganAkun,
    laporanAktivitas,
    laporanArusKas,
    laporanPosisiKeuangan,
    laporanPerubahanAsetNeto,
    bukuBesar,
    neracaLajur,
  };
}
