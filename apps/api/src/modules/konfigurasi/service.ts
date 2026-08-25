// Typed, cached, fail-loud access to every business parameter (spec 5) plus
// the config-driven capabilities the regulation review added
// (docs/BUILD-PLAN.md, "Dampak temuan regulasi ke kemampuan engine").
//
// FOUR PROPERTIES
//
// 1. TYPED. Nothing outside this module reads `konfigurasi.nilai`. Callers ask
//    for `konfigurasi.jasaAdm()` and get a validated object, so a rate cannot
//    reach a journal as the string "0.03" or as NaN. Money and rates come back
//    as decimal STRINGS (invariant 7 bans float for amounts).
//
// 2. CACHED IN REDIS, INVALIDATED EXPLICITLY. Every read of every parameter
//    would otherwise be a query, and the journal engine reads several per
//    posting. The cache is keyed per bumn, holds the whole resolved scalar map
//    as one JSON blob, and is deleted on write BEFORE and AFTER the
//    transaction commits (see `update`). A 60 second TTL bounds the damage of
//    a delete that fails anyway. Spec rule 3: a parameter change takes effect
//    without a deploy.
//
// 3. FAILS LOUDLY. A missing row or a malformed value throws. There is no
//    `?? default` anywhere in this file: a silent default inside a financial
//    calculation is the single most expensive bug this system can have,
//    because it produces plausible wrong numbers for months. The defaults live
//    in the seed (which writes rows), never in the read path.
//
// 4. CACHE READS DEGRADE, CACHE WRITES DO NOT. A failed Redis GET falls back
//    to Postgres, in the open, at the call site. A failed DEL is an error the
//    caller sees, because a stale rate is worse than a failed request.
import { AppError, badRequest, conflict, notFound } from "../../core/http";
import type { AuditService } from "../audit";
import {
  compareDesimal,
  KATALOG,
  katalogKey,
  lookupKatalog,
  periksaNilai,
  tipeDataUntuk,
  type KatalogEntri,
} from "./katalog";
import type { DbPort, KeyValueStorePort, QueryRunner } from "./ports";
import {
  createKonfigurasiRepo,
  type AlokasiPresetRow,
  type KolektibilitasRangeRow,
  type KonfigurasiRepo,
  type KonfigurasiRow,
  type PenyisihanRateRow,
  type ReferensiRow,
} from "./repo";

const CACHE_PREFIX = "tjsl:cfg:";
export const CACHE_TTL_SECONDS = 60;

/** A resolved parameter: its raw text plus where it came from. */
export interface NilaiResolusi {
  grup: string;
  kunci: string;
  nilai: string;
  /** true when this value comes from an entity override, not the shipped default. */
  override: boolean;
  version: number;
  diubahAt: string;
  diubahOleh: string | null;
  perluKonfirmasi: boolean;
  /** true when no catalogue entry describes this row (added outside this module). */
  diLuarKatalog: boolean;
}

export interface JasaAdmConfig {
  /** Decimal string, e.g. "0.030000". Never a float. */
  rateDefault: string;
  metodeDefault: "FLAT" | "EFEKTIF" | "ANUITAS";
  basisHari: 360 | 365;
  /** BUILD-PLAN: derive the flat rate from an effective rate instead of typing it. */
  turunkanFlatDariEfektif: boolean;
  rateEfektifAcuan: string;
}

export interface AngsuranConfig {
  pembulatan: 0 | 100 | 1000;
  presetAlokasi: string;
  /** Ordered waterfall from alokasi_setoran_preset (spec 5.4). */
  urutanAlokasi: readonly string[];
}

export interface BatasanConfig {
  plafonMin: string;
  plafonMax: string;
  tenorMinBulan: number;
  tenorMaxBulan: number;
  gracePeriodMaxBulan: number;
  wajibJaminanDiAtas: string;
  maksPinjamanAktifPerMitra: number;
  skorSurveyMinimum: number;
  izinkanTopupJangkaPendek: boolean;
  plafonTopupJangkaPendek: string;
}

export interface AkuntansiConfig {
  metodePengakuanJasaAdm: "CASH_BASIS" | "ACCRUAL";
  akrualHanyaUntukKolektibilitas: readonly string[];
  jasaGracePeriod: "TIDAK_DIHITUNG" | "DIHITUNG_DITANGGUHKAN" | "DIHITUNG_DIBAYAR";
  tahunBukuMulaiBulan: number;
  izinkanReopenPeriode: boolean;
  dasarPerhitunganPenyisihan: "OUTSTANDING_POKOK" | "OUTSTANDING_POKOK_PLUS_JASA";
  modePenyisihan: "RATE_TABLE" | "KOLEKTIF_HISTORIS";
  penyisihanMinBulanHistori: number;
  pisahkanPenghapustagihan: boolean;
  kekuranganPenyisihanHapusBuku: "BEBAN_PERIODE" | "TOLAK";
  templateLaporanAktif: "PSAK45" | "ISAK335";
}

export interface KonfigurasiUpdateInput {
  bumnId: string;
  grup: string;
  kunci: string;
  nilai: string;
  userId: string;
  /** Optimistic concurrency, ADR 0005. Omit to accept the current row. */
  version?: number | undefined;
  ip?: string | null;
  userAgent?: string | null;
  alasan?: string | null;
}

export interface KonfigurasiService {
  /** Every parameter visible to this bumn, resolved. */
  semua(bumnId: string | null): Promise<NilaiResolusi[]>;
  satu(bumnId: string | null, grup: string, kunci: string): Promise<NilaiResolusi>;

  getInteger(bumnId: string | null, grup: string, kunci: string): Promise<number>;
  /** Fixed-precision decimal as a STRING. Never a float (invariant 7). */
  getDesimal(bumnId: string | null, grup: string, kunci: string): Promise<string>;
  getBoolean(bumnId: string | null, grup: string, kunci: string): Promise<boolean>;
  getString(bumnId: string | null, grup: string, kunci: string): Promise<string>;
  getEnum<T extends string>(bumnId: string | null, grup: string, kunci: string): Promise<T>;
  getArray(bumnId: string | null, grup: string, kunci: string): Promise<string[]>;

  jasaAdm(bumnId: string | null): Promise<JasaAdmConfig>;
  angsuran(bumnId: string | null): Promise<AngsuranConfig>;
  batasan(bumnId: string | null): Promise<BatasanConfig>;
  akuntansi(bumnId: string | null): Promise<AkuntansiConfig>;
  kolektibilitasRanges(bumnId: string | null, perTanggal: string): Promise<KolektibilitasRangeRow[]>;
  /**
   * Reference lists the operational screens pick from. Master data, so they
   * live with the parameters rather than in the module that happens to render
   * them: `sektor_pumk` is spec 4.3 master data and the cash accounts are the
   * Bagan Akun of spec 4.2.
   */
  sektor(bumnId: string): Promise<ReferensiRow[]>;
  akunKas(bumnId: string): Promise<ReferensiRow[]>;
  penyisihanRates(bumnId: string | null, perTanggal: string): Promise<PenyisihanRateRow[]>;

  update(input: KonfigurasiUpdateInput): Promise<NilaiResolusi>;
  invalidate(bumnId: string | null): Promise<void>;
}

export interface KonfigurasiServiceDeps {
  db: DbPort;
  kv: KeyValueStorePort;
  audit: AuditService;
  repo?: KonfigurasiRepo;
  cacheTtlSeconds?: number;
  /** Namespace for cache keys; the test harness gives each run its own. */
  keyPrefix?: string;
}

/** Thrown when a parameter is absent or unusable. Always a loud 500. */
export function konfigurasiRusak(pesan: string): AppError {
  return new AppError("KESALAHAN_SERVER", `Konfigurasi tidak dapat dipakai: ${pesan}`);
}

function resolveRows(rows: KonfigurasiRow[]): Map<string, NilaiResolusi> {
  const out = new Map<string, NilaiResolusi>();
  for (const row of rows) {
    const key = katalogKey(row.grup, row.kunci);
    const isOverride = row.bumn_id !== null;
    const existing = out.get(key);
    // An override always wins over the shipped default, whatever order the
    // rows arrived in.
    if (existing && existing.override && !isOverride) continue;
    out.set(key, {
      grup: row.grup,
      kunci: row.kunci,
      nilai: row.nilai ?? "",
      override: isOverride,
      version: row.version,
      diubahAt: row.diubah_at,
      diubahOleh: row.diubah_oleh,
      perluKonfirmasi: row.perlu_konfirmasi,
      diLuarKatalog: lookupKatalog(row.grup, row.kunci) === null,
    });
  }
  return out;
}

export function createKonfigurasiService({
  db,
  kv,
  audit,
  repo = createKonfigurasiRepo(),
  cacheTtlSeconds = CACHE_TTL_SECONDS,
  keyPrefix = CACHE_PREFIX,
}: KonfigurasiServiceDeps): KonfigurasiService {
  const cacheKey = (bumnId: string | null): string => `${keyPrefix}${bumnId ?? "global"}`;

  async function loadFromDb(bumnId: string | null): Promise<Map<string, NilaiResolusi>> {
    return resolveRows(await repo.listForBumn(db, bumnId));
  }

  async function resolved(bumnId: string | null): Promise<Map<string, NilaiResolusi>> {
    let cached: string | null = null;
    try {
      cached = await kv.get(cacheKey(bumnId));
    } catch {
      // Cache READ degradation is deliberate and explicit: Redis being down
      // must not stop a journal from being posted, and Postgres is the source
      // of truth anyway. The write path does NOT degrade; see `update`.
      cached = null;
    }
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as NilaiResolusi[];
        return new Map(parsed.map((item) => [katalogKey(item.grup, item.kunci), item]));
      } catch {
        // Poisoned cache entry: fall through to Postgres and overwrite it.
      }
    }
    const fresh = await loadFromDb(bumnId);
    try {
      await kv.set(cacheKey(bumnId), JSON.stringify([...fresh.values()]), cacheTtlSeconds);
    } catch {
      // Best effort: a cache that cannot be filled just means every read hits
      // Postgres, which is correct, only slower.
    }
    return fresh;
  }

  /** Reads one parameter and validates it against the catalogue. */
  async function ambil(
    bumnId: string | null,
    grup: string,
    kunci: string,
  ): Promise<{ entri: KatalogEntri; nilai: string; resolusi: NilaiResolusi }> {
    const key = katalogKey(grup, kunci);
    const entri = KATALOG[key];
    if (!entri) {
      throw konfigurasiRusak(`kunci "${key}" tidak ada di katalog konfigurasi`);
    }
    const map = await resolved(bumnId);
    const resolusi = map.get(key);
    if (!resolusi) {
      throw konfigurasiRusak(
        `kunci "${key}" tidak ada di tabel konfigurasi. ` +
          "Jalankan `bun run db:seed` atau tambahkan barisnya; nilai default TIDAK diasumsikan di kode.",
      );
    }
    const masalah = periksaNilai(entri, resolusi.nilai);
    if (masalah.length > 0) {
      throw konfigurasiRusak(`nilai "${resolusi.nilai}" untuk "${key}" tidak valid: ${masalah.join("; ")}`);
    }
    return { entri, nilai: resolusi.nilai.trim(), resolusi };
  }

  const service: KonfigurasiService = {
    async semua(bumnId) {
      return [...(await resolved(bumnId)).values()].sort((a, b) =>
        katalogKey(a.grup, a.kunci).localeCompare(katalogKey(b.grup, b.kunci)),
      );
    },

    async satu(bumnId, grup, kunci) {
      const map = await resolved(bumnId);
      const found = map.get(katalogKey(grup, kunci));
      if (!found) throw notFound(`Parameter ${grup}.${kunci} tidak ditemukan`);
      return found;
    },

    async getInteger(bumnId, grup, kunci) {
      const { nilai } = await ambil(bumnId, grup, kunci);
      return Number(nilai);
    },

    async getDesimal(bumnId, grup, kunci) {
      return (await ambil(bumnId, grup, kunci)).nilai;
    },

    async getBoolean(bumnId, grup, kunci) {
      return (await ambil(bumnId, grup, kunci)).nilai === "true";
    },

    async getString(bumnId, grup, kunci) {
      return (await ambil(bumnId, grup, kunci)).nilai;
    },

    async getEnum<T extends string>(bumnId: string | null, grup: string, kunci: string): Promise<T> {
      return (await ambil(bumnId, grup, kunci)).nilai as T;
    },

    async getArray(bumnId, grup, kunci) {
      const { nilai } = await ambil(bumnId, grup, kunci);
      return JSON.parse(nilai) as string[];
    },

    async jasaAdm(bumnId) {
      const [rateDefault, metodeDefault, basisHari, turunkan, rateEfektif] = await Promise.all([
        service.getDesimal(bumnId, "jasa_adm", "jasa_adm_rate_default"),
        service.getEnum<"FLAT" | "EFEKTIF" | "ANUITAS">(bumnId, "jasa_adm", "jasa_adm_metode_default"),
        service.getEnum<"360" | "365">(bumnId, "jasa_adm", "jasa_adm_basis_hari"),
        service.getBoolean(bumnId, "jasa_adm", "turunkan_flat_dari_efektif"),
        service.getDesimal(bumnId, "jasa_adm", "rate_efektif_acuan"),
      ]);
      return {
        rateDefault,
        metodeDefault,
        basisHari: Number(basisHari) as 360 | 365,
        turunkanFlatDariEfektif: turunkan,
        rateEfektifAcuan: rateEfektif,
      };
    },

    async angsuran(bumnId) {
      const [pembulatan, preset] = await Promise.all([
        service.getEnum<"0" | "100" | "1000">(bumnId, "angsuran", "pembulatan_angsuran"),
        service.getEnum<string>(bumnId, "angsuran", "urutan_alokasi_setoran_preset"),
      ]);
      const rows: AlokasiPresetRow[] = await repo.alokasiPreset(db, preset);
      if (rows.length === 0) {
        throw konfigurasiRusak(
          `preset alokasi setoran "${preset}" tidak punya baris di alokasi_setoran_preset`,
        );
      }
      return {
        pembulatan: Number(pembulatan) as 0 | 100 | 1000,
        presetAlokasi: preset,
        urutanAlokasi: rows.map((row) => row.komponen),
      };
    },

    async batasan(bumnId) {
      const [
        plafonMin,
        plafonMax,
        tenorMin,
        tenorMax,
        grace,
        wajibJaminan,
        maksAktif,
        skor,
        izinkanTopup,
        plafonTopup,
      ] = await Promise.all([
        service.getDesimal(bumnId, "batasan", "plafon_min_pumk"),
        service.getDesimal(bumnId, "batasan", "plafon_max_pumk"),
        service.getInteger(bumnId, "batasan", "tenor_min_bulan"),
        service.getInteger(bumnId, "batasan", "tenor_max_bulan"),
        service.getInteger(bumnId, "batasan", "grace_period_max_bulan"),
        service.getDesimal(bumnId, "batasan", "wajib_jaminan_di_atas_plafon"),
        service.getInteger(bumnId, "batasan", "maks_pinjaman_aktif_per_mitra"),
        service.getInteger(bumnId, "batasan", "skor_survey_minimum_lolos"),
        service.getBoolean(bumnId, "batasan", "izinkan_topup_jangka_pendek"),
        service.getDesimal(bumnId, "batasan", "plafon_topup_jangka_pendek"),
      ]);
      // Cross-field coherence: an operator can save each of these
      // individually and still end up with a range that cannot be satisfied.
      if (compareDesimal(plafonMin, plafonMax) > 0) {
        throw konfigurasiRusak(`plafon_min_pumk (${plafonMin}) lebih besar dari plafon_max_pumk (${plafonMax})`);
      }
      if (tenorMin > tenorMax) {
        throw konfigurasiRusak(`tenor_min_bulan (${tenorMin}) lebih besar dari tenor_max_bulan (${tenorMax})`);
      }
      return {
        plafonMin,
        plafonMax,
        tenorMinBulan: tenorMin,
        tenorMaxBulan: tenorMax,
        gracePeriodMaxBulan: grace,
        wajibJaminanDiAtas: wajibJaminan,
        maksPinjamanAktifPerMitra: maksAktif,
        skorSurveyMinimum: skor,
        izinkanTopupJangkaPendek: izinkanTopup,
        plafonTopupJangkaPendek: plafonTopup,
      };
    },

    async akuntansi(bumnId) {
      const [
        metode,
        akrualKelas,
        grace,
        tahunBuku,
        reopen,
        dasar,
        mode,
        minHistori,
        pisahkan,
        kekurangan,
        template,
      ] = await Promise.all([
        service.getEnum<"CASH_BASIS" | "ACCRUAL">(bumnId, "akuntansi", "metode_pengakuan_jasa_adm"),
        service.getArray(bumnId, "akuntansi", "akrual_hanya_untuk_kolektibilitas"),
        service.getEnum<"TIDAK_DIHITUNG" | "DIHITUNG_DITANGGUHKAN" | "DIHITUNG_DIBAYAR">(
          bumnId,
          "akuntansi",
          "jasa_grace_period",
        ),
        service.getInteger(bumnId, "akuntansi", "tahun_buku_mulai_bulan"),
        service.getBoolean(bumnId, "akuntansi", "izinkan_reopen_periode"),
        service.getEnum<"OUTSTANDING_POKOK" | "OUTSTANDING_POKOK_PLUS_JASA">(
          bumnId,
          "akuntansi",
          "dasar_perhitungan_penyisihan",
        ),
        service.getEnum<"RATE_TABLE" | "KOLEKTIF_HISTORIS">(bumnId, "akuntansi", "mode_penyisihan"),
        service.getInteger(bumnId, "akuntansi", "penyisihan_min_bulan_histori"),
        service.getBoolean(bumnId, "akuntansi", "pisahkan_penghapustagihan"),
        service.getEnum<"BEBAN_PERIODE" | "TOLAK">(bumnId, "akuntansi", "kekurangan_penyisihan_hapus_buku"),
        service.getEnum<"PSAK45" | "ISAK335">(bumnId, "laporan", "template_laporan_aktif"),
      ]);
      return {
        metodePengakuanJasaAdm: metode,
        akrualHanyaUntukKolektibilitas: akrualKelas,
        jasaGracePeriod: grace,
        tahunBukuMulaiBulan: tahunBuku,
        izinkanReopenPeriode: reopen,
        dasarPerhitunganPenyisihan: dasar,
        modePenyisihan: mode,
        penyisihanMinBulanHistori: minHistori,
        pisahkanPenghapustagihan: pisahkan,
        kekuranganPenyisihanHapusBuku: kekurangan,
        templateLaporanAktif: template,
      };
    },

    async sektor(bumnId) {
      return repo.listSektor(db, bumnId);
    },

    async akunKas(bumnId) {
      return repo.listAkunKas(db, bumnId);
    },

    async kolektibilitasRanges(bumnId, perTanggal) {
      const rows = await repo.kolektibilitasRanges(db, bumnId, perTanggal);
      if (rows.length === 0) {
        throw konfigurasiRusak(`tidak ada kolektibilitas_range yang berlaku pada ${perTanggal}`);
      }
      // The ladder must cover 0..infinity with no gap, or a mitra with 200
      // days overdue silently gets no classification at all.
      const sorted = [...rows].sort((a, b) => a.hari_min - b.hari_min);
      let expected = 0;
      for (const row of sorted) {
        if (row.hari_min !== expected) {
          throw konfigurasiRusak(
            `kolektibilitas_range tidak kontinu: kelas ${row.kelas_kode} mulai di hari ` +
              `${row.hari_min}, seharusnya ${expected}`,
          );
        }
        if (row.hari_max === null) return sorted;
        expected = row.hari_max + 1;
      }
      throw konfigurasiRusak("kolektibilitas_range tidak punya kelas terbuka (hari_max NULL) di ujung");
    },

    async penyisihanRates(bumnId, perTanggal) {
      const rows = await repo.penyisihanRates(db, bumnId, perTanggal);
      if (rows.length === 0) {
        throw konfigurasiRusak(`tidak ada penyisihan_rate yang berlaku pada ${perTanggal}`);
      }
      return rows;
    },

    async invalidate(bumnId) {
      // Strict: throws if Redis refuses. A silently skipped invalidation is
      // exactly the "parameter changed but nothing happened" bug spec rule 3
      // is about.
      await kv.del(cacheKey(bumnId));
    },

    async update(input) {
      const key = katalogKey(input.grup, input.kunci);
      const entri = KATALOG[key];
      if (!entri) {
        throw badRequest(`Parameter ${key} tidak dikenal`, { kunci: ["tidak ada di katalog konfigurasi"] });
      }
      const nilai = input.nilai.trim();
      const masalah = periksaNilai(entri, nilai);
      if (masalah.length > 0) {
        throw badRequest(`Nilai untuk ${key} tidak valid`, { nilai: masalah });
      }

      // Delete first: if the write succeeds but the post-write delete fails,
      // the cache is at least not holding a value from BEFORE the change for
      // the whole TTL.
      await service.invalidate(input.bumnId);

      const hasil = await db.transaction(async (tx: QueryRunner) => {
        const existing = await repo.lockOverride(tx, input.bumnId, input.grup, input.kunci);
        const global = existing ? null : await repo.findGlobal(tx, input.grup, input.kunci);
        const nilaiLama = existing?.nilai ?? global?.nilai ?? null;

        let row: KonfigurasiRow;
        if (existing) {
          const updated = await repo.updateOverride(tx, {
            id: existing.id,
            nilai,
            userId: input.userId,
            version: input.version,
          });
          if (!updated) {
            throw conflict(
              `Parameter ${key} sudah diubah oleh pengguna lain (versi ${existing.version}). ` +
                "Muat ulang lalu coba lagi.",
            );
          }
          row = updated;
        } else {
          row = await repo.insertOverride(tx, {
            bumnId: input.bumnId,
            grup: input.grup,
            kunci: input.kunci,
            nilai,
            tipeData: tipeDataUntuk(entri.bentuk),
            pilihan: entri.pilihan ?? null,
            deskripsi: entri.deskripsi,
            userId: input.userId,
          });
        }

        // In the SAME transaction as the change: a rolled-back write must not
        // leave a SUKSES row claiming the parameter changed.
        await audit.recordFor(
          { userId: input.userId, ip: input.ip ?? null, userAgent: input.userAgent ?? null },
          {
            aksi: "konfigurasi.update",
            entitas: "konfigurasi",
            entitasId: row.id,
            nilaiLama: { grup: input.grup, kunci: input.kunci, nilai: nilaiLama },
            nilaiBaru: { grup: input.grup, kunci: input.kunci, nilai },
            hasil: "SUKSES",
            keterangan: input.alasan ?? null,
          },
          tx,
        );

        return row;
      });

      // Delete again after commit: between the first delete and the commit,
      // a concurrent reader may have repopulated the cache with the old value.
      await service.invalidate(input.bumnId);

      return {
        grup: hasil.grup,
        kunci: hasil.kunci,
        nilai: hasil.nilai ?? "",
        override: hasil.bumn_id !== null,
        version: hasil.version,
        diubahAt: hasil.diubah_at,
        diubahOleh: hasil.diubah_oleh,
        perluKonfirmasi: hasil.perlu_konfirmasi,
        diLuarKatalog: false,
      };
    },
  };

  return service;
}
