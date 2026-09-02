// The tools engine (spec 9.6). Authorises, scopes, and shapes what ./repo.ts
// reads. It decides NOTHING about what "broken" means -- the predicates are
// the seed's and they live in the repo beside the seed check each one mirrors.
//
// EVERY METHOD IS A READ. There is no journal port, no audit port and no
// transaction in this file, so a repair path cannot be added here without
// first adding a dependency, which is a change nobody makes by accident.
//
// PERMISSIONS ARE RESOLVED THROUGH `canonicalPermission`, so a code the shipped
// catalogue does not carry FAILS CLOSED with `IZIN_BELUM_TERDAFTAR` instead of
// being treated as granted. Both codes this module needs (`tools.integritas`,
// `tools.rekonsiliasi`) ship today; the guard stays because the next missing
// code is the one it exists for.
//
// BRANCH SCOPE IS THE SESSION'S, NEVER THE REQUEST'S (spec 2 rule 3, spec 16
// scenario 24). `cabangId` on a filter NARROWS the answer, and a branch outside
// the session's set is REFUSED with `CABANG_DILUAR_SCOPE` rather than silently
// producing an empty page: an empty health check reads as "that branch is
// clean", which is a wrong answer presented as a right one, and it is exactly
// the answer somebody would act on.
import { canonicalPermission } from "../auth/index";
import {
  BATAS_BARIS_BAWAAN,
  BATAS_BARIS_MAKS,
  KODE_TOOLS,
  PEMERIKSAAN_INTEGRITAS,
  PERMISSION_TOOLS,
  POLA_UANG,
  ToolsError,
  type BarisPemeriksaan,
  type BarisRekonsiliasiPiutang,
  type FilterIntegritas,
  type FilterRekonsiliasi,
  type HasilPemeriksaan,
  type KatalogPemeriksaan,
  type KodePemeriksaan,
  type KodeTools,
  type LaporanIntegritas,
  type LaporanRekonsiliasiPiutang,
  type ToolsContext,
  type ToolsEngine,
  type ToolsEngineDeps,
  type Uang,
} from "./contract";
import * as repo from "./repo";
import type { Lingkup } from "./repo";

// ---------------------------------------------------------------------------
// The catalogue. `nama` is the wording apps/api/src/seed/demo-dunia/periksa.ts
// prints, so the health check page and the seed's own report read alike and a
// failure found in one is recognisable in the other.
// ---------------------------------------------------------------------------

// `kode` is written as a STRING LITERAL rather than as `PEMERIKSAAN_INTEGRITAS.X`
// on purpose. ./contract.ts imports this file (the factory lives there), so the
// cycle contract -> service -> contract is closed at module-evaluation time and
// reading a runtime binding of ./contract.ts HERE, at module scope, throws
// "Cannot access before initialization". modules/rka/kesalahan.ts keys its
// message catalogue with literals for exactly the same reason. The literals are
// still type checked: the array is annotated `KatalogPemeriksaan[]`, whose
// `kode` is `KodePemeriksaan`, so a typo is a compile error.
const KATALOG: readonly KatalogPemeriksaan[] = Object.freeze([
  {
    kode: "JURNAL_TIDAK_BALANCE",
    nama: "v_integritas_jurnal (jurnal tidak balance / kurang baris)",
    sumber: "v_integritas_jurnal",
    entitas: "jurnal",
    dijagaDatabase: false,
    terikatCabang: true,
  },
  {
    kode: "JADWAL_POKOK_TIDAK_COCOK",
    nama: "v_integritas_jadwal (total pokok jadwal <> pokok akad)",
    sumber: "v_integritas_jadwal",
    entitas: "pumk_akad",
    dijagaDatabase: false,
    terikatCabang: true,
  },
  {
    kode: "SNAPSHOT_KOLEKTIBILITAS_GANDA",
    nama: "v_integritas_snapshot (snapshot kolektibilitas ganda)",
    sumber: "v_integritas_snapshot",
    entitas: "kolektibilitas_snapshot",
    // `kolektibilitas_snapshot_uq` is a TOTAL unique index on
    // (periode_id, akad_id), with no partial predicate, so a duplicate cannot
    // be committed at all. See ./contract.ts's header.
    dijagaDatabase: true,
    terikatCabang: true,
  },
  {
    kode: "SUB_LEDGER_PIUTANG_TIDAK_COCOK",
    nama: "v_rekonsiliasi_piutang (sub ledger piutang vs buku besar, spec 8.4 butir 10)",
    sumber: "v_rekonsiliasi_piutang",
    entitas: "pumk_akad",
    dijagaDatabase: false,
    terikatCabang: true,
  },
  {
    kode: "TANGGA_KOLEKTIBILITAS",
    nama: "tangga kolektibilitas (tanpa celah, tanpa tumpang tindih)",
    sumber: "kolektibilitas_range",
    entitas: "kolektibilitas_range",
    dijagaDatabase: false,
    // Configuration for the whole entity: there is no branch on the rows, so a
    // branch filter cannot narrow this one and the page says why.
    terikatCabang: false,
  },
  {
    kode: "JURNAL_DRAFT_DI_PERIODE_CLOSED",
    nama: "tidak ada jurnal DRAFT di periode CLOSED",
    sumber: "jurnal",
    entitas: "jurnal",
    dijagaDatabase: false,
    terikatCabang: true,
  },
  {
    kode: "OUTSTANDING_POKOK_NEGATIF",
    nama: "tidak ada akad dengan outstanding negatif (invarian 10)",
    sumber: "pumk_akad",
    entitas: "pumk_akad",
    // Also `pumk_akad_outstanding_pokok_check`. See ./contract.ts's header.
    dijagaDatabase: true,
    terikatCabang: true,
  },
  {
    kode: "PIUTANG_JASA_BERSALDO_KREDIT",
    // Character for character the seed's own wording, per this module's rule:
    // the health check page and the seed's acceptance gate must not be able to
    // describe the same invariant two different ways.
    nama: "Piutang Jasa Administrasi (1.1.04) tidak pernah bersaldo kredit di akhir bulan mana pun",
    sumber: "v_ledger_baris",
    entitas: "periode",
    // Nothing in the schema prevents it: an asset account carrying a credit
    // balance is a legal set of journal lines. See ./repo.ts's Check 9 header
    // for the defect that made this check necessary.
    dijagaDatabase: false,
    terikatCabang: true,
  },
  {
    kode: "NERACA_SALDO_TIDAK_SEIMBANG",
    nama: "buku besar seimbang (total debit = total kredit, seluruh baris ledger)",
    sumber: "v_ledger_baris",
    entitas: "buku_besar",
    dijagaDatabase: false,
    terikatCabang: true,
  },
]);

const KATALOG_INDEKS: ReadonlyMap<string, KatalogPemeriksaan> = new Map(
  KATALOG.map((k) => [k.kode as string, k]),
);

// ---------------------------------------------------------------------------
// Money, at the boundary
// ---------------------------------------------------------------------------

/**
 * Normalises what Postgres handed back. Every query in ./repo.ts casts
 * `::numeric(20,2)` BEFORE `::text`; this is the second line of defence, and it
 * fails LOUDLY rather than letting a bare '0' reach a page as if it were money.
 */
function uang(nilai: string | null | undefined): Uang {
  if (nilai === null || nilai === undefined) return "0.00";
  if (!POLA_UANG.test(nilai)) {
    throw new Error(
      `modules/tools: nilai uang dari database bukan numeric(20,2)::text: ${JSON.stringify(nilai)}. ` +
        "Cast ke ::numeric(20,2) SEBELUM ::text (lihat catatan driver di modules/jurnal/repo.ts).",
    );
  }
  return nilai;
}

const POLA_SEN = /^(-?)(\d+)\.(\d{2})$/;

function keSen(nilai: string): bigint {
  const m = POLA_SEN.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2] as string) * 100n + BigInt(m[3] as string);
  return m[1] === "-" ? -besar : besar;
}

function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/**
 * `1.234.567,89` for a message an operator reads. Formatting only; the machine
 * readable value beside it is always the two-decimal string.
 */
function rupiah(nilai: Uang): string {
  const m = POLA_SEN.exec(nilai);
  if (!m) return nilai;
  const ribuan = (m[2] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${m[1]}${ribuan},${m[3]}`;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEngineTools(deps: ToolsEngineDeps): ToolsEngine {
  const db = deps.db;
  const jam = deps.jam ?? (() => new Date());

  function tolak(
    kode: KodeTools,
    pesan: string,
    detail: Record<string, unknown> = {},
  ): ToolsError {
    return new ToolsError(kode, pesan, detail);
  }

  function wajibIzin(ctx: ToolsContext, kode: string): void {
    const kanonik = canonicalPermission(kode);
    if (!kanonik) {
      throw tolak(
        KODE_TOOLS.IZIN_BELUM_TERDAFTAR,
        `Permission "${kode}" belum terdaftar di katalog; operasi ditolak (fail closed)`,
        { permission: kode },
      );
    }
    if (!ctx.permissions.includes(kanonik)) {
      throw tolak(KODE_TOOLS.TIDAK_BERWENANG, "Akses ditolak", { permission: kanonik });
    }
  }

  /** Every branch the SESSION resolved. Never empty. */
  function cabangTerlihat(ctx: ToolsContext): string[] {
    return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
  }

  /**
   * Turns a context plus an optional branch FILTER into the population the
   * queries run over. A branch outside the session's set is refused, not
   * ignored; and the filter can only ever narrow.
   */
  async function lingkup(
    ctx: ToolsContext,
    cabangId: string | null | undefined,
  ): Promise<Lingkup> {
    const terlihat = cabangTerlihat(ctx);
    if (cabangId === null || cabangId === undefined) {
      return { bumnId: ctx.bumnId, cabangIds: terlihat };
    }
    if (!terlihat.includes(cabangId)) {
      throw tolak(
        KODE_TOOLS.CABANG_DILUAR_SCOPE,
        "Cabang ini berada di luar scope Anda",
        { cabangId },
      );
    }
    const baris = await repo.cabang(db, ctx.bumnId, cabangId);
    if (!baris) {
      throw tolak(KODE_TOOLS.CABANG_TIDAK_DITEMUKAN, "Cabang tidak ditemukan", {
        cabangId,
      });
    }
    return { bumnId: ctx.bumnId, cabangIds: [cabangId] };
  }

  function batasBaris(nilai: number | null | undefined): number {
    if (nilai === null || nilai === undefined) return BATAS_BARIS_BAWAAN;
    if (!Number.isInteger(nilai) || nilai < 1) return BATAS_BARIS_BAWAAN;
    return Math.min(nilai, BATAS_BARIS_MAKS);
  }

  function katalogUntuk(kode: KodePemeriksaan): KatalogPemeriksaan {
    const entri = KATALOG_INDEKS.get(kode);
    if (!entri) {
      throw tolak(
        KODE_TOOLS.PEMERIKSAAN_TIDAK_DIKENAL,
        `Pemeriksaan "${kode}" tidak dikenal`,
        { kode },
      );
    }
    return entri;
  }

  // --- one check ------------------------------------------------------------

  async function jalankanSatu(
    kode: KodePemeriksaan,
    l: Lingkup,
    batas: number,
  ): Promise<HasilPemeriksaan> {
    const entri = katalogUntuk(kode);
    const bungkus = (
      jumlah: number,
      detail: string,
      baris: BarisPemeriksaan[],
      lulus = jumlah === 0,
    ): HasilPemeriksaan => ({
      ...entri,
      lulus,
      jumlah,
      detail,
      baris,
      terpotong: jumlah > baris.length,
    });

    switch (kode) {
      case PEMERIKSAAN_INTEGRITAS.JURNAL_TIDAK_BALANCE: {
        const jumlah = await repo.hitungJurnalRusak(db, l);
        const baris = jumlah === 0 ? [] : await repo.baris_jurnalRusak(db, l, batas);
        return bungkus(
          jumlah,
          `${jumlah} baris`,
          baris.map((b) => ({
            id: b.jurnal_id,
            entitas: "jurnal",
            label: b.no_jurnal,
            cabangId: b.cabang_id,
            fakta: {
              status: b.status,
              tanggalTransaksi: b.tanggal_transaksi,
              jumlahBaris: b.jumlah_baris,
              totalDebitBaris: uang(b.total_debit_baris),
              totalKreditBaris: uang(b.total_kredit_baris),
              selisih: uang(b.selisih),
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.JADWAL_POKOK_TIDAK_COCOK: {
        const jumlah = await repo.hitungJadwalRusak(db, l);
        const baris = jumlah === 0 ? [] : await repo.baris_jadwalRusak(db, l, batas);
        return bungkus(
          jumlah,
          `${jumlah} akad`,
          baris.map((b) => ({
            id: b.akad_id,
            entitas: "pumk_akad",
            label: b.no_akad,
            cabangId: b.cabang_id,
            fakta: {
              versi: b.versi,
              pokokPinjaman: uang(b.pokok_pinjaman),
              totalPokokJadwal: uang(b.total_pokok_jadwal),
              selisih: uang(b.selisih),
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.SNAPSHOT_KOLEKTIBILITAS_GANDA: {
        const jumlah = await repo.hitungSnapshotGanda(db, l);
        const baris = jumlah === 0 ? [] : await repo.baris_snapshotGanda(db, l, batas);
        return bungkus(
          jumlah,
          `${jumlah} pasangan periode/akad`,
          baris.map((b) => ({
            id: b.akad_id,
            entitas: "kolektibilitas_snapshot",
            label: b.no_akad,
            cabangId: b.cabang_id,
            fakta: {
              periodeId: b.periode_id,
              tahun: b.tahun,
              bulan: b.bulan,
              jumlahSnapshot: b.jumlah,
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK: {
        const jumlah = await repo.hitungRekonRusak(db, l);
        const baris =
          jumlah === 0
            ? []
            : await repo.baris_rekon(db, l, { hanyaSelisih: true, batas });
        return bungkus(
          jumlah,
          `${jumlah} akad selisih`,
          baris.map((b) => ({
            id: b.akad_id,
            entitas: "pumk_akad",
            label: b.no_akad,
            cabangId: b.cabang_id,
            fakta: {
              mitraId: b.mitra_id,
              namaMitra: b.nama_mitra,
              statusAkad: b.status,
              saldoSubLedger: uang(b.saldo_sub_ledger),
              saldoBukuBesar: uang(b.saldo_buku_besar),
              selisih: uang(b.selisih),
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.TANGGA_KOLEKTIBILITAS: {
        const jumlah = await repo.hitungTanggaRusak(db, l);
        const baris = jumlah === 0 ? [] : await repo.baris_tanggaRusak(db, l, batas);
        return bungkus(
          jumlah,
          `${jumlah} sambungan salah`,
          baris.map((b) => ({
            id: b.id,
            entitas: "kolektibilitas_range",
            label: b.kelas_kode,
            cabangId: null,
            fakta: {
              hariMin: b.hari_min,
              hariMax: b.hari_max,
              hariMinBerikutnya: b.berikut,
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.JURNAL_DRAFT_DI_PERIODE_CLOSED: {
        const jumlah = await repo.hitungDraftDiClosed(db, l);
        const baris = jumlah === 0 ? [] : await repo.baris_draftDiClosed(db, l, batas);
        return bungkus(
          jumlah,
          `${jumlah} jurnal`,
          baris.map((b) => ({
            id: b.jurnal_id,
            entitas: "jurnal",
            label: b.no_jurnal,
            cabangId: b.cabang_id,
            fakta: {
              periode: `${b.tahun}-${String(b.bulan).padStart(2, "0")}`,
              tanggalTransaksi: b.tanggal_transaksi,
              totalDebit: uang(b.total_debit),
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.OUTSTANDING_POKOK_NEGATIF: {
        const jumlah = await repo.hitungOutstandingNegatif(db, l);
        const baris =
          jumlah === 0 ? [] : await repo.baris_outstandingNegatif(db, l, batas);
        return bungkus(
          jumlah,
          `${jumlah} akad`,
          baris.map((b) => ({
            id: b.akad_id,
            entitas: "pumk_akad",
            label: b.no_akad,
            cabangId: b.cabang_id,
            fakta: {
              outstandingPokok: uang(b.outstanding_pokok),
              outstandingJasa: uang(b.outstanding_jasa),
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.PIUTANG_JASA_BERSALDO_KREDIT: {
        const akun = await repo.akunPiutangJasa(db, l.bumnId);
        // A check that cannot run must not report green. Without the accrual
        // mapping there is no account whose sign to judge, and answering
        // "lulus" would tell an operator the books were verified when nothing
        // was read at all.
        if (!akun) {
          return bungkus(
            1,
            "pemetaan event AKRUAL_JASA_ADM tidak ada, saldo piutang jasa tidak dapat diperiksa",
            [
              {
                id: l.bumnId,
                entitas: "event_jurnal_mapping",
                label: "AKRUAL_JASA_ADM",
                cabangId: null,
                fakta: { eventCode: "AKRUAL_JASA_ADM", akunDebit: null },
              },
            ],
            false,
          );
        }
        // No separate COUNT: the offending set is one row per month end and
        // the page shows them all, so a second query would only be a chance
        // for the two to disagree. `batas` still caps it.
        const baris = await repo.barisPiutangJasaKredit(db, l, akun.akun_id, batas);
        return bungkus(
          baris.length,
          baris.length === 0
            ? "0 bulan negatif"
            : baris.map((b) => `${b.bulan} ${rupiah(uang(b.saldo))}`).join(", "),
          baris.map((b) => ({
            id: b.periode_id,
            entitas: "periode",
            label: b.bulan,
            // The rows are periods, and a period belongs to the entity rather
            // than to a branch. null, never a guessed branch: `terikatCabang`
            // stays true because the SCOPE still narrows which lines are
            // summed, which is a different question from what the row is.
            cabangId: null,
            fakta: {
              akun: akun.kode,
              tanggalAkhir: b.tanggal_akhir,
              saldo: uang(b.saldo),
            },
          })),
        );
      }
      case PEMERIKSAAN_INTEGRITAS.NERACA_SALDO_TIDAK_SEIMBANG: {
        const total = await repo.totalNeracaSaldo(db, l);
        const debit = uang(total.debit);
        const kredit = uang(total.kredit);
        const selisih = sen(keSen(debit) - keSen(kredit));
        const seimbang = keSen(selisih) === 0n;
        // `jumlah` is the count of OFFENDING things, and an unbalanced ledger
        // is exactly one finding, not one per line. Zero when it balances, so
        // `lulus` stays derivable the same way as every other check.
        return bungkus(
          seimbang ? 0 : 1,
          `debit ${rupiah(debit)}, kredit ${rupiah(kredit)}, selisih ${rupiah(selisih)}`,
          seimbang
            ? []
            : [
                {
                  id: l.bumnId,
                  entitas: "buku_besar",
                  label: "Buku besar",
                  cabangId: l.cabangIds.length === 1 ? (l.cabangIds[0] as string) : null,
                  fakta: {
                    totalDebit: debit,
                    totalKredit: kredit,
                    selisih,
                    jumlahJurnal: total.jumlah_jurnal,
                  },
                },
              ],
          seimbang,
        );
      }
      default: {
        // Unreachable while `KodePemeriksaan` and KATALOG agree; kept so adding
        // a code without a branch is a compile error rather than a silent pass.
        const tidakTerjangkau: never = kode;
        throw tolak(
          KODE_TOOLS.PEMERIKSAAN_TIDAK_DIKENAL,
          `Pemeriksaan "${String(tidakTerjangkau)}" tidak dikenal`,
        );
      }
    }
  }

  return {
    async katalogPemeriksaan(ctx) {
      wajibIzin(ctx, PERMISSION_TOOLS.INTEGRITAS);
      return KATALOG.map((k) => ({ ...k }));
    },

    async jalankanIntegritas(filter, ctx): Promise<LaporanIntegritas> {
      wajibIzin(ctx, PERMISSION_TOOLS.INTEGRITAS);
      const l = await lingkup(ctx, filter.cabangId);
      const batas = batasBaris(filter.batasBaris);
      const hasil: HasilPemeriksaan[] = [];
      // Sequential rather than Promise.all: a health check that opens eight
      // connections at once on a database somebody is already worried about is
      // the wrong shape of diagnostic.
      for (const entri of KATALOG) {
        hasil.push(await jalankanSatu(entri.kode, l, batas));
      }
      return {
        dijalankanPada: jam().toISOString(),
        cabangDiperiksa: l.cabangIds,
        sehat: hasil.every((h) => h.lulus),
        hasil,
      };
    },

    async jalankanPemeriksaan(kode, filter, ctx): Promise<HasilPemeriksaan> {
      wajibIzin(ctx, PERMISSION_TOOLS.INTEGRITAS);
      katalogUntuk(kode);
      const l = await lingkup(ctx, filter.cabangId);
      return jalankanSatu(kode, l, batasBaris(filter.batasBaris));
    },

    async rekonsiliasiPiutang(
      filter: FilterRekonsiliasi,
      ctx,
    ): Promise<LaporanRekonsiliasiPiutang> {
      wajibIzin(ctx, PERMISSION_TOOLS.REKONSILIASI);
      const l = await lingkup(ctx, filter.cabangId);
      const akun = await repo.akunPiutang(db, ctx.bumnId);
      if (!akun) {
        // Refused rather than answered with zeroes. See KODE_TOOLS.
        throw tolak(
          KODE_TOOLS.MAPPING_PIUTANG_TIDAK_ADA,
          "Belum ada event_jurnal_mapping aktif untuk PENCAIRAN_PUMK, sehingga akun piutang " +
            "yang direkonsiliasi tidak bisa ditentukan",
          { eventCode: "PENCAIRAN_PUMK" },
        );
      }
      const batas = batasBaris(filter.batasBaris);
      const hanyaSelisih = filter.hanyaSelisih ?? true;
      const ringkasan = await repo.ringkasanCabangRekon(db, l);
      const baris = await repo.baris_rekon(db, l, { hanyaSelisih, batas });

      let subLedger = 0n;
      let bukuBesar = 0n;
      let selisih = 0n;
      let jumlahAkad = 0;
      let jumlahAkadSelisih = 0;
      const perCabang = ringkasan.map((r) => {
        const s = uang(r.total_sub_ledger);
        const bb = uang(r.total_buku_besar);
        const sel = uang(r.total_selisih);
        subLedger += keSen(s);
        bukuBesar += keSen(bb);
        selisih += keSen(sel);
        jumlahAkad += Number(r.jumlah_akad);
        jumlahAkadSelisih += Number(r.jumlah_akad_selisih);
        return {
          cabangId: r.cabang_id,
          kodeCabang: r.kode,
          namaCabang: r.nama,
          jumlahAkad: Number(r.jumlah_akad),
          jumlahAkadSelisih: Number(r.jumlah_akad_selisih),
          totalSubLedger: s,
          totalBukuBesar: bb,
          totalSelisih: sel,
        };
      });

      const drill: BarisRekonsiliasiPiutang[] = baris.map((b) => ({
        akadId: b.akad_id,
        noAkad: b.no_akad,
        cabangId: b.cabang_id,
        mitraId: b.mitra_id,
        namaMitra: b.nama_mitra,
        statusAkad: b.status,
        saldoSubLedger: uang(b.saldo_sub_ledger),
        saldoBukuBesar: uang(b.saldo_buku_besar),
        selisih: uang(b.selisih),
      }));

      return {
        dijalankanPada: jam().toISOString(),
        akunPiutangId: akun.akun_id,
        akunPiutangKode: akun.kode,
        cocok: jumlahAkadSelisih === 0,
        jumlahAkadDiperiksa: jumlahAkad,
        jumlahAkadSelisih,
        totalSubLedger: sen(subLedger),
        totalBukuBesar: sen(bukuBesar),
        totalSelisih: sen(selisih),
        perCabang,
        baris: drill,
        terpotong: hanyaSelisih
          ? jumlahAkadSelisih > drill.length
          : jumlahAkad > drill.length,
      };
    },
  };
}
