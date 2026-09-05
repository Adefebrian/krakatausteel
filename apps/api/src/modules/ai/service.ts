// The AI engine (spec 12, Fase 8). Authorises, scopes, rate-limits, and shapes
// what ./ekstraksi.ts and ./anomali.ts produce.
//
// IT WRITES ONE TABLE, `ai_saran`, AND NOTHING ELSE. No journal port, no pumk
// port, no mitra port, no angsuran port (contract.ts rule 1). An extraction
// becoming a proposal, or an anomaly blocking a close, would require adding a
// dependency to this file first, which is a change nobody makes by accident.
//
// PERMISSIONS ARE RESOLVED THROUGH `canonicalPermission`, so a code the shipped
// catalogue does not carry FAILS CLOSED with `IZIN_BELUM_TERDAFTAR` instead of
// being treated as granted.
//
// BRANCH SCOPE IS THE SESSION'S, NEVER THE REQUEST'S (spec 2 rule 3, spec 16
// scenario 24). A `cabangId` filter NARROWS; a branch outside the session's set
// is REFUSED rather than silently producing an empty review queue, because an
// empty queue reads as "that branch is clean".
//
// THE ONE THING THIS FILE DOES THAT NO OTHER ENGINE IN THIS REPOSITORY DOES:
// it declines to throw when its dependency fails. A provider that is slow,
// absent, misconfigured or babbling produces `status: "GAGAL"` with an empty
// field list and a sentence for the operator. That asymmetry is deliberate and
// it is the owner's rule: an accounting system that cannot record a receipt
// because an LLM is down is worse than one with no AI at all. Authorisation,
// validation, branch scope and the rate limit still throw, because those are
// refusals by this system rather than failures of somebody else's.
import { canonicalPermission } from "../auth/index";
import {
  BATAS_ANOMALI_PER_USER,
  BATAS_EKSTRAKSI_PER_USER,
  BATAS_TEMUAN_BAWAAN,
  BATAS_TEMUAN_MAKS,
  BATAS_WAKTU_MS,
  BULAN_RIWAYAT_ANOMALI,
  JENDELA_ANOMALI_DETIK,
  JENDELA_EKSTRAKSI_DETIK,
  JENIS_DOKUMEN,
  KATALOG_ANOMALI,
  KODE_AI,
  MAKS_KARAKTER_DOKUMEN,
  PERMISSION_AI,
  AiError,
  type AiContext,
  type AiEngine,
  type AiEngineDeps,
  type FilterAnomali,
  type HasilEkstraksi,
  type HasilKonfirmasi,
  type JenisDokumen,
  type KatalogAnomali,
  type KeputusanSaran,
  type LaporanAnomali,
  type PermintaanEkstraksi,
  type StatusAi,
} from "./contract";
import {
  ambilObjekJson,
  bangunPrompt,
  panggilModel,
  petakanJawaban,
} from "./ekstraksi";
import { redaksiDokumen } from "./redaksi";
import {
  KELIPATAN_BULAT_RUPIAH,
  kelompokkanJurnal,
  nilaiJurnal,
} from "./anomali";
import * as repo from "./repo";

/** Lines pulled by one scan. A ceiling on the thing that actually grows. */
const BATAS_BARIS_SCAN = 20_000;

export function buatEngineAi(deps: AiEngineDeps): AiEngine {
  const { db, pembatas } = deps;
  const jam = deps.jam ?? (() => new Date());
  const prefix = deps.keyPrefix ?? "tjsl";
  // THE FLAG. False unless the composition root was told otherwise, AND false
  // whenever no port was wired, so "enabled with nothing behind it" is not a
  // reachable state.
  const aktif = (deps.aktif ?? false) && deps.ai !== undefined;

  function tolak(
    kode: (typeof KODE_AI)[keyof typeof KODE_AI],
    pesan: string,
    detail: Record<string, unknown> = {},
  ): AiError {
    return new AiError(kode, pesan, detail);
  }

  function wajibIzin(ctx: AiContext, kode: string): void {
    const kanonik = canonicalPermission(kode);
    if (!kanonik) {
      throw tolak(
        KODE_AI.IZIN_BELUM_TERDAFTAR,
        `Permission "${kode}" belum terdaftar di katalog; operasi ditolak (fail closed)`,
        { permission: kode },
      );
    }
    if (!ctx.permissions.includes(kanonik)) {
      throw tolak(KODE_AI.TIDAK_BERWENANG, "Akses ditolak", { permission: kanonik });
    }
  }

  /** Every branch the SESSION resolved. Never empty. */
  function cabangTerlihat(ctx: AiContext): string[] {
    return [...new Set<string>([ctx.cabangId, ...(ctx.cabangDalamScope ?? [])])];
  }

  function lingkupCabang(ctx: AiContext, cabangId: string | null | undefined): string[] {
    const terlihat = cabangTerlihat(ctx);
    if (cabangId === null || cabangId === undefined) return terlihat;
    if (!terlihat.includes(cabangId)) {
      throw tolak(KODE_AI.CABANG_DILUAR_SCOPE, "Cabang ini berada di luar scope Anda", {
        cabangId,
      });
    }
    return [cabangId];
  }

  /**
   * Spends one unit of the caller's budget, or refuses.
   *
   * FAIL CLOSED, and the argument is in contract.ts's `AiEngineDeps`: refusing
   * an extraction costs a Maker one form typed by hand, which is exactly what
   * the whole feature being switched off costs them, while an uncounted
   * extraction endpoint is a bill with no ceiling.
   */
  async function pakaiJatah(
    ctx: AiContext,
    ruang: string,
    batas: number,
    jendela: number,
  ): Promise<void> {
    const kunci = `${prefix}:ai:${ruang}:${ctx.userId}`;
    const hasil = await pembatas.consume(kunci, batas, jendela);
    if (!hasil.allowed) {
      throw tolak(
        KODE_AI.TERLALU_BANYAK_PERMINTAAN,
        "Batas pemakaian asisten untuk periode ini sudah tercapai. Lanjutkan manual.",
        { retryAfterSeconds: Math.max(1, hasil.retryAfterSeconds) },
      );
    }
  }

  function statusSekarang(): StatusAi {
    return {
      aktif,
      model: aktif ? (deps.ai?.model ?? null) : null,
      kemampuan: { ekstraksiDokumen: aktif, deteksiAnomali: aktif },
      batas: {
        maksKarakterDokumen: MAKS_KARAKTER_DOKUMEN,
        ekstraksiPerUser: BATAS_EKSTRAKSI_PER_USER,
        jendelaDetik: JENDELA_EKSTRAKSI_DETIK,
      },
      jenisDokumen: JENIS_DOKUMEN,
    };
  }

  /** The empty, well-formed answer. Returned whenever nothing was extracted. */
  function hasilKosong(
    jenis: JenisDokumen,
    status: "GAGAL" | "NONAKTIF",
    alasan: string,
    karakterDokumen: number,
  ): HasilEkstraksi {
    return {
      saranId: null,
      jenis,
      status,
      sumber: "AI",
      model: null,
      dibuatPada: jam().toISOString(),
      perluKonfirmasi: true,
      field: [],
      alasan,
      ringkasanMasukan: {
        karakterDokumen,
        karakterDikirim: 0,
        redaksi: {},
        hashPrompt: null,
      },
    };
  }

  return {
    status(ctx: AiContext): StatusAi {
      // No permission gate: knowing WHETHER the assistant is on is not a
      // privilege, and every screen that might offer a button needs the answer
      // before it can decide not to draw one. A session is still required, by
      // the route.
      void ctx;
      return statusSekarang();
    },

    async ekstrakDokumen(
      input: PermintaanEkstraksi,
      ctx: AiContext,
    ): Promise<HasilEkstraksi> {
      wajibIzin(ctx, PERMISSION_AI.EKSTRAKSI);

      const teks = typeof input.teks === "string" ? input.teks : "";
      // Validated at the route AND again here, so a future caller that skips
      // the router still cannot spend more than the ceiling.
      if (teks.trim().length === 0) {
        throw tolak(KODE_AI.DOKUMEN_KOSONG, "Teks dokumen kosong", {});
      }
      if (teks.length > MAKS_KARAKTER_DOKUMEN) {
        throw tolak(
          KODE_AI.DOKUMEN_TERLALU_BESAR,
          `Teks dokumen melebihi ${MAKS_KARAKTER_DOKUMEN} karakter`,
          { panjang: teks.length, maksimal: MAKS_KARAKTER_DOKUMEN },
        );
      }

      // THE FLAG, CHECKED BEFORE THE BUDGET IS SPENT. With the layer off there
      // is no provider to call, so a caller must not lose a unit of quota for
      // asking, and nothing is written: an `ai_saran` row for a suggestion that
      // was never made would be a log entry claiming an event that did not
      // happen.
      if (!aktif || !deps.ai) {
        return hasilKosong(
          input.jenis,
          "NONAKTIF",
          "Asisten dokumen sedang dimatikan. Isi form seperti biasa.",
          teks.length,
        );
      }

      await pakaiJatah(ctx, "ekstraksi", BATAS_EKSTRAKSI_PER_USER, JENDELA_EKSTRAKSI_DETIK);

      const redaksi = redaksiDokumen(teks);
      const prompt = bangunPrompt(input.jenis, redaksi.teks);
      const panggilan = await panggilModel(deps.ai, prompt, BATAS_WAKTU_MS);

      const ringkasanMasukan = {
        karakterDokumen: teks.length,
        karakterDikirim: panggilan.karakterDikirim,
        redaksi: redaksi.jumlah,
        hashPrompt: panggilan.hashPrompt,
      };

      if (panggilan.jawaban === null) {
        // FAIL OPEN. The row is still written, because "the assistant was asked
        // and could not answer" is exactly the kind of thing an operator
        // chasing a complaint needs to be able to see.
        const saranId = await repo.simpanSaran(db, {
          bumnId: ctx.bumnId,
          cabangId: ctx.cabangId,
          jenis: "EKSTRAKSI_DOKUMEN",
          model: deps.ai.model,
          status: "GAGAL",
          hasil: {},
          masukan: ringkasanMasukan,
          konteksTipe: input.konteksTipe ?? null,
          konteksId: input.konteksId ?? null,
          userId: ctx.userId,
        });
        return {
          ...hasilKosong(input.jenis, "GAGAL", panggilan.alasan ?? "Asisten gagal menjawab.", teks.length),
          saranId,
          model: deps.ai.model,
          ringkasanMasukan,
        };
      }

      const objek = ambilObjekJson(panggilan.jawaban);
      if (objek === null) {
        const saranId = await repo.simpanSaran(db, {
          bumnId: ctx.bumnId,
          cabangId: ctx.cabangId,
          jenis: "EKSTRAKSI_DOKUMEN",
          model: deps.ai.model,
          status: "GAGAL",
          hasil: {},
          masukan: ringkasanMasukan,
          konteksTipe: input.konteksTipe ?? null,
          konteksId: input.konteksId ?? null,
          userId: ctx.userId,
        });
        return {
          ...hasilKosong(
            input.jenis,
            "GAGAL",
            "Jawaban asisten tidak terbaca. Isi form manual.",
            teks.length,
          ),
          saranId,
          model: deps.ai.model,
          ringkasanMasukan,
        };
      }

      const field = petakanJawaban(objek, input.jenis, redaksi, teks);
      const saranId = await repo.simpanSaran(db, {
        bumnId: ctx.bumnId,
        cabangId: ctx.cabangId,
        jenis: "EKSTRAKSI_DOKUMEN",
        model: deps.ai.model,
        status: "BERHASIL",
        // The MAPPED result, not the raw answer: the raw answer is an untrusted
        // string of unbounded length over which this system has made no
        // promises, and storing it would put unvalidated model text into a
        // JSONB column that a report could later render. What is stored is what
        // was shown, which is also what makes the row usable as evidence.
        hasil: { field },
        masukan: ringkasanMasukan,
        konteksTipe: input.konteksTipe ?? null,
        konteksId: input.konteksId ?? null,
        userId: ctx.userId,
      });

      return {
        saranId,
        jenis: input.jenis,
        status: "BERHASIL",
        sumber: "AI",
        model: deps.ai.model,
        dibuatPada: jam().toISOString(),
        perluKonfirmasi: true,
        field,
        alasan: null,
        ringkasanMasukan,
      };
    },

    async konfirmasiSaran(
      saranId: string,
      keputusan: KeputusanSaran,
      ctx: AiContext,
    ): Promise<HasilKonfirmasi> {
      wajibIzin(ctx, PERMISSION_AI.EKSTRAKSI);
      const saran = await repo.ambilSaran(db, saranId, ctx.bumnId);
      if (!saran) {
        throw tolak(KODE_AI.SARAN_TIDAK_DITEMUKAN, "Saran tidak ditemukan", { saranId });
      }
      // The suggestion belongs to a branch, and reading somebody else's is the
      // same refusal as reading their journals.
      if (!cabangTerlihat(ctx).includes(saran.cabangId)) {
        throw tolak(KODE_AI.CABANG_DILUAR_SCOPE, "Saran ini berada di luar scope Anda", {
          saranId,
        });
      }
      if (saran.keputusan !== null) {
        throw tolak(
          KODE_AI.SARAN_SUDAH_DIKONFIRMASI,
          "Saran ini sudah dikonfirmasi sebelumnya",
          { saranId, keputusan: saran.keputusan },
        );
      }
      const pada = jam();
      const menang = await repo.tandaiKonfirmasi(db, {
        saranId,
        bumnId: ctx.bumnId,
        keputusan,
        userId: ctx.userId,
        pada,
      });
      if (!menang) {
        throw tolak(
          KODE_AI.SARAN_SUDAH_DIKONFIRMASI,
          "Saran ini sudah dikonfirmasi sebelumnya",
          { saranId },
        );
      }
      return {
        saranId,
        keputusan,
        dikonfirmasiOleh: ctx.userId,
        dikonfirmasiPada: pada.toISOString(),
      };
    },

    katalogAnomali(ctx: AiContext): readonly KatalogAnomali[] {
      wajibIzin(ctx, PERMISSION_AI.ANOMALI);
      return KATALOG_ANOMALI;
    },

    async deteksiAnomali(filter: FilterAnomali, ctx: AiContext): Promise<LaporanAnomali> {
      wajibIzin(ctx, PERMISSION_AI.ANOMALI);
      const cabangIds = lingkupCabang(ctx, filter.cabangId);

      const periode = await repo.ambilPeriode(db, filter.periodeId, ctx.bumnId);
      if (!periode) {
        throw tolak(KODE_AI.PERIODE_TIDAK_DITEMUKAN, "Periode tidak ditemukan", {
          periodeId: filter.periodeId,
        });
      }

      const batas = Math.min(
        Math.max(1, filter.batas ?? BATAS_TEMUAN_BAWAAN),
        BATAS_TEMUAN_MAKS,
      );

      const kosong: LaporanAnomali = {
        dijalankanPada: jam().toISOString(),
        periodeId: periode.id,
        aktif: false,
        model: null,
        sumber: "AI",
        hanyaSaran: true,
        cabangDiperiksa: cabangIds,
        jumlahJurnalDiperiksa: 0,
        jumlahDitandai: 0,
        terpotong: false,
        jurnal: [],
      };
      // Off means off, for both halves. The anomaly scan reaches no provider,
      // but it is part of the AI layer spec 12 makes optional, so one switch
      // turns the whole layer off rather than half of it.
      if (!aktif) return kosong;

      await pakaiJatah(ctx, "anomali", BATAS_ANOMALI_PER_USER, JENDELA_ANOMALI_DETIK);

      const baris = await repo.ambilBarisPeriode(db, {
        periodeId: periode.id,
        bumnId: ctx.bumnId,
        cabangIds,
        batasBaris: BATAS_BARIS_SCAN,
      });
      const jurnal = kelompokkanJurnal(baris);

      const akunIds = [...new Set(baris.map((b) => b.akunId))];
      const mitraIds = [
        ...new Set(baris.map((b) => b.mitraId).filter((m): m is string => m !== null)),
      ];
      // History is everything strictly BEFORE this period's first day, back
      // `BULAN_RIWAYAT_ANOMALI` months. Bounded on both ends: an unbounded
      // baseline over a decade of ledger is a scan that grows without limit and
      // a median that stops describing how the entity works today.
      const sejak = mundurBulan(periode.tanggalMulai, BULAN_RIWAYAT_ANOMALI);
      const [riwayat, pasanganAkun, pasanganMitra] = await Promise.all([
        repo.ambilRiwayatAkun(db, {
          bumnId: ctx.bumnId,
          sebelum: periode.tanggalMulai,
          sejak,
          akunIds,
          pembulatan: KELIPATAN_BULAT_RUPIAH,
        }),
        repo.ambilPasanganAkunHistoris(db, {
          bumnId: ctx.bumnId,
          sebelum: periode.tanggalMulai,
          sejak,
          akunIds,
        }),
        repo.ambilPasanganMitraHistoris(db, {
          bumnId: ctx.bumnId,
          sebelum: periode.tanggalMulai,
          sejak,
          mitraIds,
        }),
      ]);

      const ditandai = nilaiJurnal(jurnal, {
        periodeMulai: periode.tanggalMulai,
        periodeAkhir: periode.tanggalAkhir,
        riwayatAkun: new Map(riwayat.map((r) => [r.akunId, r])),
        pasanganAkunHistoris: pasanganAkun,
        pasanganMitraHistoris: pasanganMitra,
      });

      const laporan: LaporanAnomali = {
        dijalankanPada: jam().toISOString(),
        periodeId: periode.id,
        aktif: true,
        // NULL, ALWAYS. No model answered, and writing one here would be a
        // provenance claim that is not true.
        model: null,
        sumber: "AI",
        hanyaSaran: true,
        cabangDiperiksa: cabangIds,
        jumlahJurnalDiperiksa: jurnal.length,
        jumlahDitandai: ditandai.length,
        terpotong: ditandai.length > batas || baris.length >= BATAS_BARIS_SCAN,
        jurnal: ditandai.slice(0, batas),
      };

      // One row per scan, recording that it ran and what it said. Written after
      // the answer is complete, and it changes nothing about the answer.
      await repo.simpanSaran(db, {
        bumnId: ctx.bumnId,
        cabangId: ctx.cabangId,
        jenis: "ANOMALI_JURNAL",
        model: null,
        status: "BERHASIL",
        hasil: {
          periodeId: periode.id,
          jumlahJurnalDiperiksa: laporan.jumlahJurnalDiperiksa,
          jumlahDitandai: laporan.jumlahDitandai,
          jurnal: laporan.jurnal,
        },
        masukan: {
          periodeId: periode.id,
          cabangDiperiksa: cabangIds,
          bulanRiwayat: BULAN_RIWAYAT_ANOMALI,
          barisDibaca: baris.length,
        },
        konteksTipe: "periode",
        konteksId: periode.id,
        userId: ctx.userId,
      });

      return laporan;
    },
  };
}

/**
 * `YYYY-MM-DD` minus n whole months, as TEXT.
 *
 * Arithmetic on the three integers in the string rather than on a `Date`: a
 * `Date` built from a bare ISO date is UTC midnight and is read back in the
 * host's zone, so the same books would produce a different baseline window on a
 * server in Jakarta and a laptop in London. The day is clamped to the target
 * month's length, and this is a WINDOW BOUND rather than a business date, so
 * clamping cannot move a figure.
 */
export function mundurBulan(tanggalIso: string, bulan: number): string {
  const th = Number(tanggalIso.slice(0, 4));
  const bl = Number(tanggalIso.slice(5, 7));
  const hr = Number(tanggalIso.slice(8, 10));
  const totalBulan = th * 12 + (bl - 1) - bulan;
  const thBaru = Math.floor(totalBulan / 12);
  const blBaru = (totalBulan % 12) + 1;
  const hariMaks = hariDalamBulan(thBaru, blBaru);
  const hrBaru = Math.min(hr, hariMaks);
  return `${String(thBaru).padStart(4, "0")}-${String(blBaru).padStart(2, "0")}-${String(hrBaru).padStart(2, "0")}`;
}

function hariDalamBulan(tahun: number, bulan: number): number {
  if (bulan === 2) {
    const kabisat = (tahun % 4 === 0 && tahun % 100 !== 0) || tahun % 400 === 0;
    return kabisat ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(bulan) ? 30 : 31;
}
