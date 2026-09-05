// apps/api/src/modules/ai/anomali.ts
//
// SPEC 12 PRIORITY 2: order a period's posted journals by how much they deserve
// a second look. A REVIEW QUEUE, and nothing else.
//
// WHAT IT IS NOT. It is not a control, not a gate, and not an opinion about
// whether an entry is wrong. Nothing here blocks a posting, a close or an
// approval; the closing checklist (spec 8.4) does not consult this file and
// must never start to. A flagged journal is a valid journal that somebody
// should read first.
//
// NO MODEL IS CALLED, AND THAT IS THE RIGHT ANSWER RATHER THAN A SHORTCUT.
// Everything spec 12 asks for here -- an outlier against an account's history,
// a round number, an odd date, a duplicate, a never-before-seen account pair --
// is arithmetic over `v_ledger_baris`. Handing it to a language model would
// make the same books rank differently on Tuesday, would make it impossible to
// satisfy spec 12's own requirement that every suggestion show "dasar
// perhitungan atau sumber data secara eksplisit", would cost money per close,
// and would be the only place in this system where a borrower's balance is sent
// to a third party. So: deterministic, and every finding carries the numbers it
// fired on.
//
// EVERY FIGURE IS A BigInt OF SEN (invariant 7). Money arrives from the
// repository as `numeric(20,2)::text` and is converted by `keSen`; no ratio,
// threshold or score in this file passes through a float. The robust z-score
// comparison is done by cross-multiplication precisely so that it does not have
// to.
import {
  ATURAN_ANOMALI,
  KATALOG_ANOMALI,
  type JurnalDitandai,
  type KodeAnomali,
  type TemuanAnomali,
} from "./contract";
import type { BarisJurnalScan, RiwayatAkun } from "./repo";

// ---------------------------------------------------------------------------
// Money as integers
// ---------------------------------------------------------------------------

/**
 * `numeric(20,2)` text to BigInt sen. Refuses anything that is not that shape
 * by returning 0n rather than guessing, because a silently mis-parsed rupiah is
 * worse than a rule that does not fire.
 */
export function keSen(teks: string | null | undefined): bigint {
  if (!teks) return 0n;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(teks.trim());
  if (!m) return 0n;
  const tanda = m[1] === "-" ? -1n : 1n;
  const utuh = BigInt(m[2]!);
  const pecahan = BigInt((m[3] ?? "").padEnd(2, "0"));
  return tanda * (utuh * 100n + pecahan);
}

/** BigInt sen back to `numeric(20,2)` text, for `dasar`. Never a float. */
export function dariSen(sen: bigint): string {
  const negatif = sen < 0n;
  const abs = negatif ? -sen : sen;
  const utuh = abs / 100n;
  const pecahan = abs % 100n;
  return `${negatif ? "-" : ""}${utuh}.${pecahan.toString().padStart(2, "0")}`;
}

function absolut(n: bigint): bigint {
  return n < 0n ? -n : n;
}

// ---------------------------------------------------------------------------
// Thresholds. All integers, all named, none of them buried in an expression.
// ---------------------------------------------------------------------------

/**
 * The modified z-score cut-off, times 1000 so the comparison stays integral.
 * 3.5 is Iglewicz and Hoaglin's conventional value and is the number a
 * reviewer will find if they go looking for where it came from.
 */
const AMBANG_Z_MILI = 3500n;

/** The 0.6745 constant of the modified z-score, times 10000. */
const KONSTANTA_Z = 6745n;
const SKALA_Z = 10000n;

/** An account needs this much history before its median means anything. */
export const MIN_RIWAYAT_OUTLIER = 12;

/** "Round" means an exact multiple of Rp 1.000.000. */
export const KELIPATAN_BULAT_SEN = 100_000_000n;
/** The same figure as `numeric` rupiah, for the SQL side. */
export const KELIPATAN_BULAT_RUPIAH = "1000000";

/** An account needs this much history before "it is never round" is a claim. */
export const MIN_RIWAYAT_BULAT = 20;
/** Round in fewer than 1 line in 10 historically: then a round one is notable. */
const BULAT_PEMBILANG = 1;
const BULAT_PENYEBUT = 10;

/** Shorter than this, or all one character, and a description explains nothing. */
export const MIN_KARAKTER_KETERANGAN = 10;

/**
 * Weights, read from the catalogue LAZILY.
 *
 * ./contract.ts imports ./service.ts (the factory lives there) and ./service.ts
 * imports this file, so the cycle contract -> service -> anomali -> contract is
 * closed at module-evaluation time and reading `KATALOG_ANOMALI` HERE, at
 * module scope, throws "Cannot access before initialization".
 * modules/tools/service.ts and modules/rka/kesalahan.ts hit the same trap and
 * both note it. Deferring the read to first CALL is the fix; the catalogue is
 * fully evaluated by then, and the table is built once.
 */
let bobotCache: Record<KodeAnomali, number> | undefined;
function bobot(kode: KodeAnomali): number {
  if (!bobotCache) {
    bobotCache = Object.fromEntries(
      KATALOG_ANOMALI.map((k) => [k.kode, k.bobot]),
    ) as Record<KodeAnomali, number>;
  }
  return bobotCache[kode];
}

// ---------------------------------------------------------------------------
// One journal, assembled from its lines
// ---------------------------------------------------------------------------

export interface JurnalScan {
  jurnalId: string;
  noJurnal: string;
  cabangId: string;
  tanggalTransaksi: string;
  jenis: string;
  keterangan: string | null;
  totalDebit: string;
  baris: readonly BarisJurnalScan[];
}

/** Groups the flat line list into journals, preserving repository order. */
export function kelompokkanJurnal(baris: readonly BarisJurnalScan[]): JurnalScan[] {
  const urutan: string[] = [];
  const peta = new Map<string, BarisJurnalScan[]>();
  for (const b of baris) {
    let daftar = peta.get(b.jurnalId);
    if (!daftar) {
      daftar = [];
      peta.set(b.jurnalId, daftar);
      urutan.push(b.jurnalId);
    }
    daftar.push(b);
  }
  return urutan.map((id) => {
    const daftar = peta.get(id)!;
    const kepala = daftar[0]!;
    return {
      jurnalId: id,
      noJurnal: kepala.noJurnal,
      cabangId: kepala.cabangId,
      tanggalTransaksi: kepala.tanggalTransaksi,
      jenis: kepala.jenis,
      keterangan: kepala.keterangan,
      totalDebit: kepala.totalDebit,
      baris: daftar,
    };
  });
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

/**
 * Weekend, decided from the DATE TEXT rather than from a Date object.
 *
 * `new Date("2026-09-05")` is parsed as UTC midnight and then read back in the
 * host's local zone, so on a machine west of Greenwich a Saturday becomes a
 * Friday. That is exactly the class of bug that makes an accounting figure move
 * when the server moves. Zeller's congruence over the three integers in the
 * string has no timezone at all.
 */
export function hariDalamMinggu(tanggalIso: string): number {
  const th = Number(tanggalIso.slice(0, 4));
  const bl = Number(tanggalIso.slice(5, 7));
  const hr = Number(tanggalIso.slice(8, 10));
  const m = bl < 3 ? bl + 12 : bl;
  const y = bl < 3 ? th - 1 : th;
  const k = y % 100;
  const j = Math.floor(y / 100);
  const h =
    (hr + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;
  // Zeller: 0 = Saturday, 1 = Sunday, ... 6 = Friday.
  return h;
}

export function akhirPekan(tanggalIso: string): boolean {
  const h = hariDalamMinggu(tanggalIso);
  return h === 0 || h === 1;
}

/** Blank, too short, or one character repeated: "-", "xxx", "1111". */
export function keteranganTidakBermakna(keterangan: string | null): boolean {
  const teks = (keterangan ?? "").trim();
  if (teks.length < MIN_KARAKTER_KETERANGAN) return true;
  const unik = new Set(teks.replace(/\s+/g, "")).size;
  return unik <= 2;
}

/**
 * A duplicate signature: same branch, same date, same total, same accounts in
 * the same debit/credit position.
 *
 * WITHIN THE SCANNED PERIOD ONLY, and that is a stated limit rather than an
 * oversight: a genuine duplicate of an entry posted last month is a different
 * question (it is a reconciliation, and modules/tools already answers it), and
 * widening this to the whole ledger would turn a per-period scan into a
 * self-join over everything the entity has ever posted.
 */
export function tandaTanganJurnal(j: JurnalScan): string {
  const akun = j.baris
    .map((b) => `${b.akunId}:${keSen(b.debit) > 0n ? "D" : "K"}`)
    .sort()
    .join(",");
  return `${j.cabangId}|${j.tanggalTransaksi}|${j.totalDebit}|${akun}`;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface KonteksAnomali {
  periodeMulai: string;
  periodeAkhir: string;
  riwayatAkun: ReadonlyMap<string, RiwayatAkun>;
  pasanganAkunHistoris: ReadonlySet<string>;
  pasanganMitraHistoris: ReadonlySet<string>;
}

/**
 * Runs every rule over every journal and returns the flagged ones, ordered by
 * score descending. Pure: same inputs, same output, every time.
 */
export function nilaiJurnal(
  jurnal: readonly JurnalScan[],
  konteks: KonteksAnomali,
): JurnalDitandai[] {
  // Signature counts first: the duplicate rule needs to know about the whole
  // scanned set before it can say anything about one journal.
  const hitungTandaTangan = new Map<string, number>();
  for (const j of jurnal) {
    const t = tandaTanganJurnal(j);
    hitungTandaTangan.set(t, (hitungTandaTangan.get(t) ?? 0) + 1);
  }

  const keluar: JurnalDitandai[] = [];

  for (const j of jurnal) {
    const temuan: TemuanAnomali[] = [];

    // --- dates -------------------------------------------------------------
    if (akhirPekan(j.tanggalTransaksi)) {
      temuan.push({
        kode: ATURAN_ANOMALI.TANGGAL_AKHIR_PEKAN,
        bobot: bobot(ATURAN_ANOMALI.TANGGAL_AKHIR_PEKAN),
        alasan: "Tanggal transaksi jatuh pada Sabtu atau Minggu.",
        dasar: { tanggalTransaksi: j.tanggalTransaksi },
      });
    }
    if (j.tanggalTransaksi < konteks.periodeMulai || j.tanggalTransaksi > konteks.periodeAkhir) {
      temuan.push({
        kode: ATURAN_ANOMALI.TANGGAL_LUAR_PERIODE,
        bobot: bobot(ATURAN_ANOMALI.TANGGAL_LUAR_PERIODE),
        alasan: "Tanggal transaksi berada di luar rentang tanggal periodenya.",
        dasar: {
          tanggalTransaksi: j.tanggalTransaksi,
          periodeMulai: konteks.periodeMulai,
          periodeAkhir: konteks.periodeAkhir,
        },
      });
    }

    // --- description -------------------------------------------------------
    if (keteranganTidakBermakna(j.keterangan)) {
      temuan.push({
        kode: ATURAN_ANOMALI.KETERANGAN_TIDAK_BERMAKNA,
        bobot: bobot(ATURAN_ANOMALI.KETERANGAN_TIDAK_BERMAKNA),
        alasan: "Keterangan kosong, terlalu pendek, atau hanya karakter berulang.",
        dasar: {
          keterangan: j.keterangan,
          panjang: String((j.keterangan ?? "").trim().length),
          minimal: String(MIN_KARAKTER_KETERANGAN),
        },
      });
    }

    // --- duplicate ---------------------------------------------------------
    const tanda = tandaTanganJurnal(j);
    if ((hitungTandaTangan.get(tanda) ?? 0) > 1) {
      temuan.push({
        kode: ATURAN_ANOMALI.JURNAL_KEMBAR,
        bobot: bobot(ATURAN_ANOMALI.JURNAL_KEMBAR),
        alasan:
          "Ada jurnal lain di periode ini dengan cabang, tanggal, total dan susunan akun yang identik.",
        dasar: {
          jumlahKembar: String(hitungTandaTangan.get(tanda) ?? 0),
          tanggalTransaksi: j.tanggalTransaksi,
          totalDebit: j.totalDebit,
        },
      });
    }

    // --- account pairs -----------------------------------------------------
    const akunDebit = [...new Set(j.baris.filter((b) => keSen(b.debit) > 0n).map((b) => b.akunId))];
    const akunKredit = [
      ...new Set(j.baris.filter((b) => keSen(b.kredit) > 0n).map((b) => b.akunId)),
    ];
    const pasanganBaru: string[] = [];
    for (const d of akunDebit) {
      for (const k of akunKredit) {
        if (!konteks.pasanganAkunHistoris.has(`${d}>${k}`)) {
          const kodeD = j.baris.find((b) => b.akunId === d)?.kodeAkun ?? d;
          const kodeK = j.baris.find((b) => b.akunId === k)?.kodeAkun ?? k;
          pasanganBaru.push(`${kodeD} > ${kodeK}`);
        }
      }
    }
    if (pasanganBaru.length > 0) {
      temuan.push({
        kode: ATURAN_ANOMALI.PASANGAN_AKUN_BARU,
        bobot: bobot(ATURAN_ANOMALI.PASANGAN_AKUN_BARU),
        alasan: "Kombinasi akun debit dan kredit ini belum pernah dipakai entitas ini.",
        dasar: {
          pasangan: pasanganBaru.slice(0, 5).join("; "),
          jumlahPasanganBaru: String(pasanganBaru.length),
        },
      });
    }

    // --- per line: outlier, roundness, counterparty ------------------------
    let sudahOutlier = false;
    let sudahBulat = false;
    let sudahMitra = false;
    for (const b of j.baris) {
      const nilai = keSen(b.debit) + keSen(b.kredit);
      const riwayat = konteks.riwayatAkun.get(b.akunId);

      if (
        !sudahOutlier &&
        riwayat &&
        riwayat.jumlahBaris >= MIN_RIWAYAT_OUTLIER &&
        keSen(riwayat.mad) > 0n
      ) {
        const median = keSen(riwayat.median);
        const mad = keSen(riwayat.mad);
        const selisih = absolut(nilai - median);
        // 0.6745 * selisih / mad > 3.5, cross-multiplied so no float appears:
        //   KONSTANTA_Z * selisih * 1000 > AMBANG_Z_MILI * mad * SKALA_Z
        const kiri = KONSTANTA_Z * selisih * 1000n;
        const kanan = AMBANG_Z_MILI * mad * SKALA_Z;
        if (kiri > kanan) {
          sudahOutlier = true;
          // The score itself, also integral: z * 1000, rounded down.
          const zMili = (KONSTANTA_Z * selisih * 1000n) / (mad * SKALA_Z);
          temuan.push({
            kode: ATURAN_ANOMALI.NOMINAL_OUTLIER,
            bobot: bobot(ATURAN_ANOMALI.NOMINAL_OUTLIER),
            alasan: `Nilai baris pada akun ${b.kodeAkun} jauh dari median historis akun itu.`,
            dasar: {
              akun: b.kodeAkun,
              nilai: dariSen(nilai),
              medianHistoris: riwayat.median,
              madHistoris: riwayat.mad,
              jumlahBarisHistoris: String(riwayat.jumlahBaris),
              // Presented as a string with three decimals, assembled from
              // integers, so the page can print it without a float ever
              // existing.
              zScore: `${zMili / 1000n}.${(zMili % 1000n).toString().padStart(3, "0")}`,
              ambangZScore: "3.500",
            },
          });
        }
      }

      if (
        !sudahBulat &&
        riwayat &&
        riwayat.jumlahBaris >= MIN_RIWAYAT_BULAT &&
        nilai > 0n &&
        nilai % KELIPATAN_BULAT_SEN === 0n &&
        riwayat.jumlahBulat * BULAT_PENYEBUT < riwayat.jumlahBaris * BULAT_PEMBILANG
      ) {
        sudahBulat = true;
        temuan.push({
          kode: ATURAN_ANOMALI.NOMINAL_BULAT_TIDAK_LAZIM,
          bobot: bobot(ATURAN_ANOMALI.NOMINAL_BULAT_TIDAK_LAZIM),
          alasan: `Nilai bulat pada akun ${b.kodeAkun}, yang riwayatnya hampir tidak pernah bulat.`,
          dasar: {
            akun: b.kodeAkun,
            nilai: dariSen(nilai),
            kelipatan: `${KELIPATAN_BULAT_RUPIAH}.00`,
            barisBulatHistoris: String(riwayat.jumlahBulat),
            jumlahBarisHistoris: String(riwayat.jumlahBaris),
          },
        });
      }

      if (
        !sudahMitra &&
        b.mitraId !== null &&
        !konteks.pasanganMitraHistoris.has(`${b.mitraId}@${b.akunId}`)
      ) {
        sudahMitra = true;
        temuan.push({
          kode: ATURAN_ANOMALI.MITRA_AKUN_BARU,
          bobot: bobot(ATURAN_ANOMALI.MITRA_AKUN_BARU),
          alasan: `Mitra ini belum pernah muncul pada akun ${b.kodeAkun}.`,
          dasar: { akun: b.kodeAkun, mitraId: b.mitraId, nilai: dariSen(nilai) },
        });
      }
    }

    if (temuan.length === 0) continue;
    keluar.push({
      jurnalId: j.jurnalId,
      noJurnal: j.noJurnal,
      cabangId: j.cabangId,
      tanggalTransaksi: j.tanggalTransaksi,
      jenis: j.jenis,
      keterangan: j.keterangan,
      totalDebit: j.totalDebit,
      skor: temuan.reduce((acc, t) => acc + t.bobot, 0),
      temuan,
    });
  }

  // Score descending, then journal number, so the order is total and a rerun
  // over unchanged books produces byte-identical output.
  keluar.sort((a, b) => (b.skor - a.skor) || a.noJurnal.localeCompare(b.noJurnal));
  return keluar;
}
