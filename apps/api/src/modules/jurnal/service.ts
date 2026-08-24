// The journal engine (spec 6). The single implementation site behind
// `createJurnalEngine` in ./contract.ts.
//
// WHAT THIS FILE OWNS AND WHAT THE DATABASE OWNS
// ADR 0002 makes Postgres the last line of defence for the accounting
// invariants: one side per line, balance and minimum two lines at POST,
// POSTED immutability including no soft delete, no journal dated into a CLOSED
// period, postable accounts only. None of that is duplicated here to be
// clever; it is re-checked here so the CALLER gets a domain error with a
// sentence instead of a trigger string, and so a rejected journal never leaves
// a half-written header behind. When the database refuses anyway,
// ./kesalahan.ts translates the refusal onto the same code.
//
// WHAT IS DELIBERATELY NOT IN THIS FILE
//   - No account codes. Every automatic journal's accounts come from
//     `event_jurnal_mapping` (ADR 0004, invariant 11), including the answer to
//     "which account is Piutang Pinjaman Mitra Binaan" for validation 6.2.8,
//     which is read as the debit leg of PENCAIRAN_PUMK exactly like
//     v_rekonsiliasi_piutang reads it.
//   - No policy numbers or policy lists. docs/REGULASI.md found the spec cites
//     a revoked regulation, and docs/BUILD-PLAN.md's conclusion is that every
//     contested value must be config-driven. The only policy list this engine
//     needs (Pinbuk activity categories) is read from `konfigurasi` on every
//     call, so an accountant's edit takes effect without a deploy.
//   - No document-number formatting. That is modules/nomor, reached through its
//     index.ts and joined to this engine's transaction, so a rolled back
//     journal does not burn a number in an official series.
//
// TRANSACTION DISCIPLINE
// Every mutating method runs inside exactly one `db.transaction`. Three of the
// requirements make this non-negotiable: `postingBatch` is all or nothing, a
// reversal must revert business state in the SAME transaction (spec 6.3 calls
// skipping this the number one source of corrupt data), and the balance guard
// is a DEFERRED constraint trigger that only raises at COMMIT.
import { canonicalPermission } from "../auth";
import { createNomorService } from "../nomor";
import type {
  BarisJurnal,
  BuatJurnalInput,
  BarisJurnalInput,
  DimensiBaris,
  EventPayload,
  JenisJurnal,
  Jurnal,
  JurnalContext,
  JurnalEngine,
  JurnalEngineDeps,
  JurnalGabungan,
  JurnalTx,
  KodeJurnal,
  KomponenEvent,
  PembalikStateBisnis,
  PencatatAudit,
  PostingGabunganInput,
  Uang,
} from "./contract";
import { adalahJurnalError, bersihkanKesalahan, tolak } from "./kesalahan";
import {
  createJurnalRepo,
  type AkunBaris,
  type JurnalBaris,
  type JurnalRepo,
  type PeriodeBaris,
} from "./repo";
import { bacaUang, dariSen } from "./uang";

/**
 * `<JENIS>/<YYYYMM>/<5 digit>`, the shape POLA_NO_JURNAL pins. Spec 4.6 says
 * numbering is per jenis per periode, so the series key is
 * (bumn, jenis, tahun, bulan) with NO branch: two branches of one bumn share
 * one series, otherwise both would allocate `UMUM/202602/00001` and collide on
 * the (bumn_id, no_jurnal) unique index.
 */
const TEMPLATE_NO_JURNAL = "{jenis}/{tahun}{bulan:2}/{urutan:5}";

const PERMISSION = {
  BUAT: "jurnal.create",
  UBAH: "jurnal.update",
  VERIFIKASI: "jurnal.verify",
  POSTING: "jurnal.post",
  HAPUS: "jurnal.delete",
  REVERSAL: "jurnal.reversal",
} as const;

const KONFIGURASI_KATEGORI_PINBUK = { grup: "JURNAL", kunci: "kategori_kegiatan_pinbuk" };

/** Event whose mapping row DEFINES the receivable account (validation 6.2.8). */
const EVENT_PIUTANG_MITRA = "PENCAIRAN_PUMK";
/** Event whose mapping row DEFINES the Pinbuk preset account (spec 6.5). */
const EVENT_PRESET_PINBUK = "PENYALURAN_PINBUK";

const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

/** A line after parsing, with both sides materialised so the DB sees no NULLs. */
interface BarisSiap {
  urutan: number;
  akunId: string;
  debit: Uang;
  kredit: Uang;
  senDebit: bigint;
  senKredit: bigint;
  keterangan: string | null;
  mitraId: string | null;
  akadId: string | null;
  dimensi: DimensiBaris;
}

interface HasilValidasi {
  periode: PeriodeBaris;
  baris: BarisSiap[];
  akun: Map<string, AkunBaris>;
}

function tanggalIso(waktu: Date): string {
  return waktu.toISOString().slice(0, 10);
}

/**
 * Resolves a permission code through the auth catalogue, so a typo
 * ("jurnal.pos") is a loud programming error at the call rather than a 403
 * that reads like a policy decision and locks everyone out.
 */
function izinKanonik(permission: string): string {
  if (canonicalPermission(permission) !== null) return permission;
  throw new Error(
    `Permission "${permission}" tidak dikenal katalog auth. Tambahkan ke PERMISSIONS ` +
      "di apps/api/src/modules/auth/permissions.ts sebelum dipakai sebagai penjaga jurnal.",
  );
}

function wajibPunya(ctx: JurnalContext, permission: string): void {
  const kode = izinKanonik(permission);
  // Compared against the raw code AND its canonical form: a context assembled
  // from RBAC rows carries canonical codes, a context assembled from a spec
  // spelling may carry an alias.
  const kanonik = canonicalPermission(kode) ?? kode;
  if (!ctx.permissions.includes(kode) && !ctx.permissions.includes(kanonik)) {
    throw tolak("TIDAK_BERWENANG", { permission: kanonik });
  }
}

function dalamScope(ctx: JurnalContext, cabangId: string): boolean {
  if (cabangId === ctx.cabangId) return true;
  return (ctx.cabangDalamScope ?? []).includes(cabangId);
}

function bersihkanDimensi(dimensi: DimensiBaris | undefined): DimensiBaris {
  if (!dimensi) return {};
  const keluar: Record<string, unknown> = {};
  for (const [kunci, nilai] of Object.entries(dimensi)) {
    if (nilai !== undefined) keluar[kunci] = nilai;
  }
  return keluar as DimensiBaris;
}

function petaAkun(baris: AkunBaris[]): Map<string, AkunBaris> {
  return new Map(baris.map((a) => [a.id, a]));
}

export function buatEngineJurnal(deps: JurnalEngineDeps): JurnalEngine {
  const db = deps.db;
  const repo: JurnalRepo = createJurnalRepo();
  const jam = deps.jam ?? (() => new Date());
  const pembalikTerdaftar: readonly PembalikStateBisnis[] = deps.pembalikStateBisnis ?? [];
  const audit: PencatatAudit | undefined = deps.audit;
  // The port is structurally the core DbPort (query + transaction), so the
  // numbering service takes it as-is. Every allocation below passes `{ tx }`,
  // which is what makes the number and the journal commit together.
  const nomor = createNomorService({ db });

  /**
   * One audit row per ledger change, on the SAME handle as the change, so a
   * rolled back posting cannot leave a row claiming it happened. Successes
   * only, and no ip/userAgent: see the note on `PencatatAudit`.
   */
  async function catat(
    tx: JurnalTx,
    aksi: string,
    jurnal: Jurnal,
    ctx: JurnalContext,
    tambahan: { nilaiLama?: unknown; keterangan?: string | null } = {},
  ): Promise<void> {
    if (!audit) return;
    await audit.record(
      {
        userId: ctx.userId,
        aksi,
        entitas: "jurnal",
        entitasId: jurnal.id,
        nilaiLama: tambahan.nilaiLama,
        nilaiBaru: {
          noJurnal: jurnal.noJurnal,
          jenis: jurnal.jenis,
          status: jurnal.status,
          tanggalTransaksi: jurnal.tanggalTransaksi,
          totalDebit: jurnal.totalDebit,
          totalKredit: jurnal.totalKredit,
          jumlahBaris: jurnal.baris.length,
        },
        hasil: "SUKSES",
        keterangan: tambahan.keterangan ?? null,
      },
      tx,
    );
  }

  // -------------------------------------------------------------------------
  // Reads that are configuration, not code
  // -------------------------------------------------------------------------

  async function akunDariMapping(
    tx: JurnalTx,
    bumnId: string,
    eventCode: string,
    sisi: "debit" | "kredit",
  ): Promise<string | null> {
    const map = await repo.mappingEvent(tx, bumnId, eventCode);
    if (!map) return null;
    return sisi === "debit" ? map.akun_debit_id : map.akun_kredit_id;
  }

  async function kategoriPinbuk(tx: JurnalTx, bumnId: string): Promise<string[]> {
    const nilai = await repo.konfigurasi(
      tx,
      bumnId,
      KONFIGURASI_KATEGORI_PINBUK.grup,
      KONFIGURASI_KATEGORI_PINBUK.kunci,
    );
    if (nilai === null) {
      // Loud, and deliberately NOT a domain rejection: a missing parameter is a
      // configuration fault, and answering "kategori tidak valid" would blame
      // the operator for it. Same stance as modules/konfigurasi.
      throw new Error(
        `Parameter ${KONFIGURASI_KATEGORI_PINBUK.grup}.${KONFIGURASI_KATEGORI_PINBUK.kunci} belum ada; ` +
          "jurnal Pinbuk tidak bisa divalidasi tanpa daftar kategori kegiatan.",
      );
    }
    let terbaca: unknown;
    try {
      terbaca = JSON.parse(nilai);
    } catch {
      throw new Error(
        `Parameter ${KONFIGURASI_KATEGORI_PINBUK.grup}.${KONFIGURASI_KATEGORI_PINBUK.kunci} bukan JSON yang sah.`,
      );
    }
    if (!Array.isArray(terbaca) || terbaca.some((x) => typeof x !== "string")) {
      throw new Error(
        `Parameter ${KONFIGURASI_KATEGORI_PINBUK.grup}.${KONFIGURASI_KATEGORI_PINBUK.kunci} harus berisi daftar teks.`,
      );
    }
    return terbaca as string[];
  }

  // -------------------------------------------------------------------------
  // Spec 6.2, in the order the spec lists them
  // -------------------------------------------------------------------------

  async function validasi(
    tx: JurnalTx,
    input: BuatJurnalInput,
    ctx: JurnalContext,
    opsi: { jenis: JenisJurnal; manual: boolean },
  ): Promise<HasilValidasi> {
    // 6.2.1 the transaction DATE decides the period, never the input timestamp
    // (invariant 5).
    if (!POLA_TANGGAL.test(input.tanggalTransaksi)) {
      throw tolak("PERIODE_TIDAK_OPEN", { tanggalTransaksi: input.tanggalTransaksi });
    }
    const periode = await repo.periodeUntukTanggal(tx, ctx.bumnId, input.tanggalTransaksi);
    if (!periode || periode.status !== "OPEN") {
      throw tolak("PERIODE_TIDAK_OPEN", {
        tanggalTransaksi: input.tanggalTransaksi,
        status: periode?.status ?? null,
      });
    }

    // 6.2.2
    const masuk: readonly BarisJurnalInput[] = input.baris ?? [];
    if (masuk.length < 2) throw tolak("MINIMAL_DUA_BARIS", { jumlahBaris: masuk.length });

    // Amount shape first: a value that is not a two-decimal string cannot be
    // compared, so it can never be allowed to reach a NUMERIC column.
    for (const [i, b] of masuk.entries()) {
      for (const sisi of ["debit", "kredit"] as const) {
        const nilai = b[sisi];
        if (nilai === undefined || nilai === null) continue;
        if (bacaUang(nilai).bentuk === "rusak") {
          throw tolak("NILAI_BUKAN_DESIMAL", { urutan: i + 1, sisi, nilai });
        }
      }
    }

    const baris: BarisSiap[] = masuk.map((b, i) => {
      const d = bacaUang(b.debit);
      const k = bacaUang(b.kredit);
      const senDebit = d.bentuk === "ok" ? d.sen : 0n;
      const senKredit = k.bentuk === "ok" ? k.sen : 0n;
      return {
        urutan: i + 1,
        akunId: b.akunId,
        debit: dariSen(senDebit),
        kredit: dariSen(senKredit),
        senDebit,
        senKredit,
        keterangan: b.keterangan ?? null,
        mitraId: b.mitraId ?? null,
        akadId: b.akadId ?? null,
        dimensi: bersihkanDimensi(b.dimensi),
      };
    });

    // 6.2.3 exactly one side carries a value. A side counts as filled when it
    // is present and non-zero, which is what makes a NEGATIVE amount fall
    // through to 6.2.4 instead of being reported as a one-side violation.
    for (const b of baris) {
      const adaDebit = b.senDebit !== 0n;
      const adaKredit = b.senKredit !== 0n;
      if (adaDebit === adaKredit) {
        throw tolak("SATU_SISI_PER_BARIS", { urutan: b.urutan });
      }
    }

    // 6.2.4
    for (const b of baris) {
      if (b.senDebit < 0n || b.senKredit < 0n) {
        throw tolak("NILAI_NEGATIF", { urutan: b.urutan });
      }
    }

    // 6.2.5 exact, on BigInt minor units. No tolerance, not even a sen.
    const totalDebit = baris.reduce((a, b) => a + b.senDebit, 0n);
    const totalKredit = baris.reduce((a, b) => a + b.senKredit, 0n);
    if (totalDebit !== totalKredit) {
      throw tolak("TIDAK_BALANCE", {
        totalDebit: dariSen(totalDebit),
        totalKredit: dariSen(totalKredit),
        selisih: dariSen(totalDebit - totalKredit),
      });
    }

    // 6.2.6 every account exists, is active, and is postable.
    const idAkun = [...new Set(baris.map((b) => b.akunId))];
    const akun = petaAkun(await repo.akun(tx, ctx.bumnId, idAkun));
    for (const id of idAkun) {
      const a = akun.get(id);
      if (!a || !a.aktif || !a.is_postable) {
        throw tolak("AKUN_TIDAK_VALID", { akunId: id });
      }
    }

    // 6.2.7 the header branch must be inside the user's scope, and must belong
    // to the user's bumn (the schema checks the second half too, TJSL-JRN-001).
    if (!dalamScope(ctx, input.cabangId)) {
      throw tolak("CABANG_DILUAR_SCOPE", { cabangId: input.cabangId });
    }
    const cabang = await repo.cabang(tx, input.cabangId);
    if (!cabang || cabang.bumn_id !== ctx.bumnId) {
      throw tolak("CABANG_DILUAR_SCOPE", { cabangId: input.cabangId });
    }

    // 6.2.8 the piutang sub-ledger dimensions belong on a receivable line and
    // nowhere else. WHICH account that is comes from the mapping table, so an
    // accountant repointing PENCAIRAN_PUMK moves this rule with it.
    if (baris.some((b) => b.mitraId !== null || b.akadId !== null)) {
      const akunPiutang = await akunDariMapping(tx, ctx.bumnId, EVENT_PIUTANG_MITRA, "debit");
      for (const b of baris) {
        if (b.mitraId === null && b.akadId === null) continue;
        if (akunPiutang === null || b.akunId !== akunPiutang) {
          throw tolak("DIMENSI_PIUTANG_SALAH_AKUN", { urutan: b.urutan, akunId: b.akunId });
        }
      }
    }

    // Spec 6.5 is about the three MANUAL journal types in the UI, so it is
    // skipped for machine-made journals: an automatic PINBUK journal from
    // postingEvent carries the dimensions its own event supplies, and the
    // reversal of a KAS_BANK journal is a REVERSAL, not a cash form.
    if (opsi.manual) {
      await validasiJenisManual(tx, ctx, opsi.jenis, baris, akun);
    }

    return { periode, baris, akun };
  }

  async function validasiJenisManual(
    tx: JurnalTx,
    ctx: JurnalContext,
    jenis: JenisJurnal,
    baris: readonly BarisSiap[],
    akun: Map<string, AkunBaris>,
  ): Promise<void> {
    if (jenis === "KAS_BANK") {
      // "satu sisi wajib akun dengan is_kas = true": the flag, not the name, so
      // any bank account the COA marks as cash satisfies it.
      if (!baris.some((b) => akun.get(b.akunId)?.is_kas === true)) {
        throw tolak("KAS_BANK_TANPA_AKUN_KAS");
      }
      return;
    }

    if (jenis !== "PINBUK") return;

    const preset = await akunDariMapping(tx, ctx.bumnId, EVENT_PRESET_PINBUK, "debit");
    if (preset === null || !baris.some((b) => b.akunId === preset)) {
      throw tolak("PINBUK_AKUN_SALAH", { akunPreset: preset });
    }

    // The Mitra/Cluster link lives in dimensi_json, not in jurnal_baris.mitra_id:
    // that column is the piutang sub-ledger dimension and validation 6.2.8
    // demands a receivable account for it, which a Pinbuk expense line is not.
    const adaTautan = baris.some(
      (b) =>
        typeof b.dimensi.mitraId === "string" ||
        typeof b.dimensi.clusterId === "string",
    );
    if (!adaTautan) throw tolak("PINBUK_TANPA_TAUTAN");

    const kategoriDipakai = baris
      .map((b) => b.dimensi.kategoriKegiatan)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
    if (kategoriDipakai.length === 0) throw tolak("PINBUK_KATEGORI_TIDAK_VALID", { kategori: null });
    const diizinkan = await kategoriPinbuk(tx, ctx.bumnId);
    for (const kategori of kategoriDipakai) {
      if (!diizinkan.includes(kategori)) {
        throw tolak("PINBUK_KATEGORI_TIDAK_VALID", { kategori });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async function alokasiNomor(
    tx: JurnalTx,
    ctx: JurnalContext,
    jenis: JenisJurnal,
    periode: PeriodeBaris,
  ): Promise<string> {
    const hasil = await nomor.generate(
      {
        bumnId: ctx.bumnId,
        cabangId: null,
        jenisDokumen: jenis,
        tahun: periode.tahun,
        bulan: periode.bulan,
        formatTemplate: TEMPLATE_NO_JURNAL,
        userId: ctx.userId,
      },
      { tx },
    );
    return hasil.nomor;
  }

  async function tulisJurnal(
    tx: JurnalTx,
    ctx: JurnalContext,
    header: {
      cabangId: string;
      jenis: JenisJurnal;
      tanggalTransaksi: string;
      periode: PeriodeBaris;
      keterangan: string | null;
      referensiTipe: string | null;
      referensiId: string | null;
      isAutoGenerated: boolean;
      reversalOfJurnalId: string | null;
      kunciIdempotensi: string | null;
    },
    baris: readonly BarisSiap[],
  ): Promise<string> {
    const noJurnal = await alokasiNomor(tx, ctx, header.jenis, header.periode);
    const id = await repo.sisipkanHeader(tx, {
      bumnId: ctx.bumnId,
      cabangId: header.cabangId,
      noJurnal,
      jenis: header.jenis,
      tanggalTransaksi: header.tanggalTransaksi,
      periodeId: header.periode.id,
      keterangan: header.keterangan,
      referensiTipe: header.referensiTipe,
      referensiId: header.referensiId,
      isAutoGenerated: header.isAutoGenerated,
      reversalOfJurnalId: header.reversalOfJurnalId,
      kunciIdempotensi: header.kunciIdempotensi,
      userId: ctx.userId,
    });
    for (const b of baris) {
      await repo.sisipkanBaris(
        tx,
        id,
        {
          urutan: b.urutan,
          akunId: b.akunId,
          debit: b.debit,
          kredit: b.kredit,
          keterangan: b.keterangan,
          mitraId: b.mitraId,
          akadId: b.akadId,
          dimensi: b.dimensi,
        },
        ctx.userId,
      );
    }
    return id;
  }

  async function bacaJurnal(tx: JurnalTx, id: string): Promise<Jurnal> {
    const header = await repo.jurnal(tx, id);
    if (!header) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
    const baris = await repo.baris(tx, id);
    return keJurnal(header, baris);
  }

  function keJurnal(
    header: JurnalBaris,
    baris: ReadonlyArray<{
      id: string;
      urutan: number;
      akun_id: string;
      debit: Uang;
      kredit: Uang;
      keterangan: string | null;
      mitra_id: string | null;
      akad_id: string | null;
      dimensi: DimensiBaris;
    }>,
  ): Jurnal {
    const barisJurnal: BarisJurnal[] = baris.map((b) => ({
      id: b.id,
      urutan: b.urutan,
      akunId: b.akun_id,
      debit: b.debit,
      kredit: b.kredit,
      keterangan: b.keterangan,
      mitraId: b.mitra_id,
      akadId: b.akad_id,
      dimensi: b.dimensi,
    }));
    return {
      id: header.id,
      bumnId: header.bumn_id,
      cabangId: header.cabang_id,
      noJurnal: header.no_jurnal,
      jenis: header.jenis,
      tanggalTransaksi: header.tanggal_transaksi,
      periodeId: header.periode_id,
      keterangan: header.keterangan,
      referensiTipe: header.referensi_tipe,
      referensiId: header.referensi_id,
      totalDebit: header.total_debit,
      totalKredit: header.total_kredit,
      status: header.status,
      isAutoGenerated: header.is_auto_generated,
      reversalOfJurnalId: header.reversal_of_jurnal_id,
      reversedByJurnalId: header.reversed_by_jurnal_id,
      kunciIdempotensi: header.kunci_idempotensi,
      verifiedBy: header.verified_by,
      verifiedAt: header.verified_at,
      postedBy: header.posted_by,
      postedAt: header.posted_at,
      version: header.version,
      baris: barisJurnal,
    };
  }

  /**
   * DRAFT -> POSTED for one journal, inside a caller-owned transaction.
   *
   * WHAT IS GUARANTEED: at most one POSTED outcome. The row lock serialises the
   * contenders and the UPDATE carries `status = 'DRAFT'` in its own predicate,
   * so even if the lock were lost the second write would match no row. Lines
   * are never duplicated, totals never doubled.
   *
   * WHAT IS BEST EFFORT: the LABEL on the loser. The unlocked pre-read before
   * the lock is what separates "this journal was never postable"
   * (JURNAL_TIDAK_DRAFT, which is what spec 6.6.8 wants for a batch member
   * that was posted an hour ago) from "someone else posted it while I waited"
   * (POSTING_BENTROK, spec 6.6.9). Under READ COMMITTED that discrimination is
   * a heuristic, not a proof: a contender whose transaction begins entirely
   * after the winner commits sees POSTED in the pre-read and is told
   * JURNAL_TIDAK_DRAFT, which for it is the truth as it can observe it.
   * Raising the isolation level would move the failure to a serialization
   * error without making the label more informative, so the honest position is
   * that the state is exact and the wording is advisory.
   */
  async function postingSatu(tx: JurnalTx, id: string, ctx: JurnalContext): Promise<Jurnal> {
    const pra = await repo.jurnal(tx, id);
    if (!pra || pra.deleted_at !== null) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
    if (pra.status !== "DRAFT") throw tolak("JURNAL_TIDAK_DRAFT", { id, status: pra.status });

    const terkunci = await repo.jurnalTerkunci(tx, id);
    if (!terkunci || terkunci.deleted_at !== null) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
    if (terkunci.status !== "DRAFT") {
      throw tolak("POSTING_BENTROK", { id, status: terkunci.status });
    }

    if (!dalamScope(ctx, terkunci.cabang_id)) {
      throw tolak("CABANG_DILUAR_SCOPE", { cabangId: terkunci.cabang_id });
    }

    // Invariant 5 again at POST time: the period may have closed since the
    // draft was written (spec 6.6.4).
    const periode = await repo.periodeUntukTanggal(tx, terkunci.bumn_id, terkunci.tanggal_transaksi);
    if (!periode || periode.status !== "OPEN") {
      throw tolak("PERIODE_TIDAK_OPEN", {
        id,
        tanggalTransaksi: terkunci.tanggal_transaksi,
        status: periode?.status ?? null,
      });
    }

    // Invariants 1 and 2 are a DEFERRED trigger, so without this the failure
    // would only surface at COMMIT, taking the whole batch's diagnosis with it.
    const ringkas = await repo.ringkasanBaris(tx, id);
    if (ringkas.jumlah < 2) throw tolak("MINIMAL_DUA_BARIS", { id, jumlahBaris: ringkas.jumlah });
    if (ringkas.debit !== ringkas.kredit) {
      throw tolak("TIDAK_BALANCE", { id, totalDebit: ringkas.debit, totalKredit: ringkas.kredit });
    }

    const berhasil = await repo.tandaiPosted(tx, id, ctx.userId, jam().toISOString());
    if (!berhasil) throw tolak("POSTING_BENTROK", { id });
    const posted = await bacaJurnal(tx, id);
    await catat(tx, "jurnal.post", posted, ctx, { nilaiLama: { status: "DRAFT" } });
    return posted;
  }

  /**
   * Spec 7.2 step 8: SEVERAL mapped events, ONE journal.
   *
   * WHY LEGS ARE MERGED. A deposit is one cash movement. Posting each
   * component as its own two-line journal would produce three journals (what
   * the spec forbids); assembling them without merging would produce one
   * journal that debits cash three times for a single receipt. So legs that
   * agree on account, side and sub-ledger dimensions are summed into one line,
   * which makes a three-component allocation read the way an accountant writes
   * it: one cash receipt against piutang, pendapatan jasa administrasi and
   * kelebihan. Merging only ever combines the SAME SIDE of the SAME account:
   * netting opposite sides would change the journal's gross totals and could
   * produce a zero line, which the schema rejects outright.
   *
   * WHY THIS CANNOT SILENTLY UNBALANCE. Every component contributes a debit
   * and a credit of its own value, so the assembled set balances by
   * construction, and merging preserves sums exactly (BigInt minor units, no
   * float anywhere). The balance is nevertheless ASSERTED over the assembled
   * lines, through the same spec 6.2 validation every other path uses, because
   * "it cannot happen" is not a reason to skip the check that would catch a
   * future mapping row that resolves both legs to one account, or a bug in the
   * merge above.
   */
  async function tulisGabungan(
    tx: JurnalTx,
    input: PostingGabunganInput,
    ctx: JurnalContext,
  ): Promise<JurnalGabungan> {
    const komponen: readonly KomponenEvent[] = input.komponen ?? [];

    // One mapping read per component. The accounts behind every component come
    // from `event_jurnal_mapping` (invariant 11, ADR 0004), so an accountant
    // repointing a row changes the combined journal too, with no redeploy.
    const terpetakan: Array<{
      komponen: KomponenEvent;
      jenis: JenisJurnal;
      akunDebit: string;
      akunKredit: string;
    }> = [];
    for (const k of komponen) {
      const map = await repo.mappingEvent(tx, ctx.bumnId, k.eventCode);
      if (!map) throw tolak("EVENT_MAPPING_TIDAK_DITEMUKAN", { eventCode: k.eventCode });
      const akunDebit = map.debit_dari_payload ? k.akunDebitId : map.akun_debit_id;
      const akunKredit = map.kredit_dari_payload ? k.akunKreditId : map.akun_kredit_id;
      if (!akunDebit || !akunKredit) {
        // A component that can only supply one leg cannot be part of a
        // balanced journal, so it is refused before anything is assembled.
        throw tolak("EVENT_PAYLOAD_TIDAK_LENGKAP", {
          eventCode: k.eventCode,
          butuhDebit: map.debit_dari_payload && !k.akunDebitId,
          butuhKredit: map.kredit_dari_payload && !k.akunKreditId,
        });
      }
      terpetakan.push({ komponen: k, jenis: map.jenis_jurnal, akunDebit, akunKredit });
    }

    const idAkun = new Set<string>();
    for (const t of terpetakan) {
      idAkun.add(t.akunDebit);
      idAkun.add(t.akunKredit);
    }
    if (input.akunKasId) idAkun.add(input.akunKasId);
    const akun = petaAkun(await repo.akun(tx, ctx.bumnId, [...idAkun]));
    const akunPiutang = await akunDariMapping(tx, ctx.bumnId, EVENT_PIUTANG_MITRA, "debit");

    interface Kaki {
      akunId: string;
      sisi: "D" | "K";
      sen: bigint;
      keterangan: string | null;
      mitraId: string | null;
      akadId: string | null;
      dimensi: DimensiBaris;
    }

    const kaki: Kaki[] = [];
    for (const t of terpetakan) {
      const k = t.komponen;
      let debitId = t.akunDebit;
      let kreditId = t.akunKredit;
      // The cash account chosen on the form overrides the cash leg of every
      // component's mapping; a non-cash leg always stays as mapped.
      if (input.akunKasId) {
        if (akun.get(debitId)?.is_kas === true) debitId = input.akunKasId;
        else if (akun.get(kreditId)?.is_kas === true) kreditId = input.akunKasId;
      }

      const nilai = bacaUang(k.nilai);
      if (nilai.bentuk === "rusak") {
        throw tolak("NILAI_BUKAN_DESIMAL", { eventCode: k.eventCode, nilai: k.nilai });
      }
      // Checked per component, BEFORE the merge, not left to the assembled
      // journal: a negative component would cancel against a positive one on
      // the same account and side, and the merged line would then be refused
      // for being zero (validation 6.2.3) while the caller's real mistake, a
      // negative amount, went unnamed.
      if (nilai.negatif) {
        throw tolak("NILAI_NEGATIF", { eventCode: k.eventCode, nilai: k.nilai });
      }

      const adaSubLedger = Boolean(k.mitraId || k.akadId);
      if (adaSubLedger && debitId !== akunPiutang && kreditId !== akunPiutang) {
        throw tolak("DIMENSI_PIUTANG_SALAH_AKUN", { eventCode: k.eventCode, akunPiutang });
      }

      const dimensi = bersihkanDimensi(k.dimensi);
      const kasDebit = akun.get(debitId)?.is_kas === true;
      const kasKredit = akun.get(kreditId)?.is_kas === true;
      const keterangan = k.keterangan ?? null;

      // The piutang sub-ledger dimensions go on the receivable leg ONLY. On the
      // cash leg as well, v_rekonsiliasi_piutang would net the two legs of
      // every component to zero per akad and the most important reconciliation
      // in the system would read "balanced" forever.
      kaki.push({
        akunId: debitId,
        sisi: "D",
        sen: nilai.sen,
        keterangan,
        mitraId: adaSubLedger && debitId === akunPiutang ? (k.mitraId ?? null) : null,
        akadId: adaSubLedger && debitId === akunPiutang ? (k.akadId ?? null) : null,
        dimensi: !kasDebit || kasKredit ? dimensi : {},
      });
      kaki.push({
        akunId: kreditId,
        sisi: "K",
        sen: nilai.sen,
        keterangan,
        mitraId: adaSubLedger && kreditId === akunPiutang ? (k.mitraId ?? null) : null,
        akadId: adaSubLedger && kreditId === akunPiutang ? (k.akadId ?? null) : null,
        dimensi: !kasKredit || kasDebit ? dimensi : {},
      });
    }

    // Group in first-appearance order, so the cash receipt reads first and the
    // line order is deterministic for a given component order.
    const kunciKaki = (k: Kaki): string =>
      [k.akunId, k.sisi, k.mitraId ?? "", k.akadId ?? "", JSON.stringify(k.dimensi)].join("|");
    const grup = new Map<string, Kaki[]>();
    for (const k of kaki) {
      const kunci = kunciKaki(k);
      const ada = grup.get(kunci);
      if (ada) ada.push(k);
      else grup.set(kunci, [k]);
    }

    const baris: BarisJurnalInput[] = [...grup.values()].map((anggota) => {
      const total = anggota.reduce((a, x) => a + x.sen, 0n);
      const pertama = anggota[0];
      // A merged line cannot claim one component's narrative, so it keeps the
      // description only when every member agrees; the header carries the rest.
      const seragam = anggota.every((x) => x.keterangan === pertama.keterangan);
      return {
        akunId: pertama.akunId,
        ...(pertama.sisi === "D" ? { debit: dariSen(total) } : { kredit: dariSen(total) }),
        keterangan: seragam ? pertama.keterangan : null,
        mitraId: pertama.mitraId,
        akadId: pertama.akadId,
        dimensi: pertama.dimensi,
      };
    });

    // The document type comes from the mapping rows, not from this code. A
    // unanimous set keeps its type; a mixed set is filed as OTOMATIS, which is
    // literally what a machine-made combined journal is.
    const jenisTerpakai = new Set(terpetakan.map((t) => t.jenis));
    const jenis: JenisJurnal = jenisTerpakai.size === 1 ? [...jenisTerpakai][0] : "OTOMATIS";
    const ringkasEvent = komponen.map((k) => k.eventCode).join(" + ");

    const inputJurnal: BuatJurnalInput = {
      cabangId: input.cabangId,
      jenis,
      tanggalTransaksi: input.tanggalTransaksi,
      keterangan: input.keterangan ?? ringkasEvent,
      referensiTipe: input.referensiTipe ?? null,
      referensiId: input.referensiId ?? null,
      baris,
      isAutoGenerated: true,
      kunciIdempotensi: input.kunciIdempotensi ?? null,
    };
    const hasil = await validasi(tx, inputJurnal, ctx, { jenis, manual: false });
    const id = await tulisJurnal(
      tx,
      ctx,
      {
        cabangId: inputJurnal.cabangId,
        jenis,
        tanggalTransaksi: inputJurnal.tanggalTransaksi,
        periode: hasil.periode,
        keterangan: inputJurnal.keterangan ?? null,
        referensiTipe: inputJurnal.referensiTipe ?? null,
        referensiId: inputJurnal.referensiId ?? null,
        isAutoGenerated: true,
        reversalOfJurnalId: null,
        kunciIdempotensi: inputJurnal.kunciIdempotensi ?? null,
      },
      hasil.baris,
    );
    const terposting = await repo.tandaiPosted(tx, id, ctx.userId, jam().toISOString());
    if (!terposting) throw tolak("POSTING_BENTROK", { id });

    // The transaction is the caller's, so its COMMIT is out of reach of this
    // module's error translation. Force the deferred guard to speak now, while
    // there is still a `try` around it that can turn a trigger string into a
    // domain code.
    await repo.paksaCekBalance(tx);

    const jurnal = await bacaJurnal(tx, id);
    await catat(tx, "jurnal.post_gabungan", jurnal, ctx, { keterangan: ringkasEvent });
    return { ...jurnal, jurnalId: jurnal.id, jumlahBaris: jurnal.baris.length };
  }

  // -------------------------------------------------------------------------
  // The engine surface (spec 6.1)
  // -------------------------------------------------------------------------

  return {
    async buatJurnal(input, ctx) {
      wajibPunya(ctx, PERMISSION.BUAT);
      return bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          const hasil = await validasi(tx, input, ctx, { jenis: input.jenis, manual: true });
          const id = await tulisJurnal(
            tx,
            ctx,
            {
              cabangId: input.cabangId,
              jenis: input.jenis,
              tanggalTransaksi: input.tanggalTransaksi,
              periode: hasil.periode,
              keterangan: input.keterangan ?? null,
              referensiTipe: input.referensiTipe ?? null,
              referensiId: input.referensiId ?? null,
              isAutoGenerated: input.isAutoGenerated ?? false,
              reversalOfJurnalId: null,
              kunciIdempotensi: input.kunciIdempotensi ?? null,
            },
            hasil.baris,
          );
          const dibuat = await bacaJurnal(tx, id);
          await catat(tx, "jurnal.create", dibuat, ctx);
          return dibuat;
        }),
      );
    },

    async ubahJurnalDraft(id, input, ctx) {
      wajibPunya(ctx, PERMISSION.UBAH);
      return bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          // Read and refuse BEFORE anything is written: spec 6.6.5 requires a
          // POSTED journal to come out of a rejected edit with every column,
          // `version` included, untouched.
          const ada = await repo.jurnal(tx, id);
          if (!ada || ada.deleted_at !== null) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
          if (ada.status !== "DRAFT") throw tolak("JURNAL_TIDAK_DRAFT", { id, status: ada.status });

          // `jenis` and `no_jurnal` are immutable across an edit, so the type
          // that gets validated is the stored one, not whatever the caller sent.
          const hasil = await validasi(tx, input, ctx, { jenis: ada.jenis, manual: true });
          await repo.hapusBarisDraft(tx, id);
          await repo.ubahHeaderDraft(tx, id, {
            cabangId: input.cabangId,
            tanggalTransaksi: input.tanggalTransaksi,
            periodeId: hasil.periode.id,
            keterangan: input.keterangan ?? null,
            referensiTipe: input.referensiTipe ?? null,
            referensiId: input.referensiId ?? null,
            userId: ctx.userId,
          });
          for (const b of hasil.baris) {
            await repo.sisipkanBaris(
              tx,
              id,
              {
                urutan: b.urutan,
                akunId: b.akunId,
                debit: b.debit,
                kredit: b.kredit,
                keterangan: b.keterangan,
                mitraId: b.mitraId,
                akadId: b.akadId,
                dimensi: b.dimensi,
              },
              ctx.userId,
            );
          }
          const diubah = await bacaJurnal(tx, id);
          await catat(tx, "jurnal.update", diubah, ctx, {
            nilaiLama: {
              totalDebit: ada.total_debit,
              totalKredit: ada.total_kredit,
              version: ada.version,
            },
          });
          return diubah;
        }),
      );
    },

    async verifikasiJurnal(id, ctx) {
      wajibPunya(ctx, PERMISSION.VERIFIKASI);
      return bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          const ada = await repo.jurnal(tx, id);
          if (!ada || ada.deleted_at !== null) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
          // Spec 2 rule 1: refuse, do not merely hide the button.
          if (ada.created_by !== null && ada.created_by === ctx.userId) {
            throw tolak("MAKER_TIDAK_BOLEH_CHECKER", { id });
          }
          if (ada.status !== "DRAFT") throw tolak("JURNAL_TIDAK_DRAFT", { id, status: ada.status });
          if (!dalamScope(ctx, ada.cabang_id)) {
            throw tolak("CABANG_DILUAR_SCOPE", { cabangId: ada.cabang_id });
          }
          const berhasil = await repo.tandaiVerified(tx, id, ctx.userId, jam().toISOString());
          if (!berhasil) throw tolak("JURNAL_TIDAK_DRAFT", { id });
          const terverifikasi = await bacaJurnal(tx, id);
          await catat(tx, "jurnal.verify", terverifikasi, ctx);
          return terverifikasi;
        }),
      );
    },

    async postingJurnal(id, ctx) {
      wajibPunya(ctx, PERMISSION.POSTING);
      return bersihkanKesalahan(() => db.transaction((tx) => postingSatu(tx, id, ctx)));
    },

    async batalkanJurnalDraft(id, ctx) {
      wajibPunya(ctx, PERMISSION.HAPUS);
      await bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          const ada = await repo.jurnal(tx, id);
          if (!ada || ada.deleted_at !== null) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
          // A POSTED journal is never soft-deleted: it would vanish from every
          // report while its lines stayed in the ledger. Correction is a
          // reversal, and the schema refuses this too.
          if (ada.status !== "DRAFT") throw tolak("JURNAL_TIDAK_DRAFT", { id, status: ada.status });
          if (!dalamScope(ctx, ada.cabang_id)) {
            throw tolak("CABANG_DILUAR_SCOPE", { cabangId: ada.cabang_id });
          }
          const sebelum = await bacaJurnal(tx, id);
          const berhasil = await repo.softDeleteDraft(tx, id, ctx.userId, jam().toISOString());
          if (!berhasil) throw tolak("JURNAL_TIDAK_DRAFT", { id });
          await catat(tx, "jurnal.cancel", sebelum, ctx, {
            keterangan: "DRAFT dibatalkan lewat soft delete",
          });
          return null;
        }),
      );
    },

    async reversalJurnal(id, alasan, ctx) {
      // `jurnal.reversal`, not `jurnal.post`: reversing a posted journal is its
      // own right in the auth catalogue and drives its own nav item. Checking
      // the posting right instead would leave `jurnal.reversal` granting
      // nothing and hand the power to reverse to everyone who can post.
      wajibPunya(ctx, PERMISSION.REVERSAL);
      const alasanBersih = (alasan ?? "").trim();
      if (alasanBersih.length === 0) throw tolak("ALASAN_WAJIB", { id });

      return bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          const asli = await repo.jurnalTerkunci(tx, id);
          if (!asli || asli.deleted_at !== null) throw tolak("JURNAL_TIDAK_DITEMUKAN", { id });
          if (asli.status === "DRAFT") throw tolak("JURNAL_BELUM_POSTED", { id });
          if (asli.status === "REVERSED") throw tolak("JURNAL_SUDAH_REVERSED", { id });
          if (!dalamScope(ctx, asli.cabang_id)) {
            throw tolak("CABANG_DILUAR_SCOPE", { cabangId: asli.cabang_id });
          }

          // Refusing is the safe failure. Reversing the accounting while
          // leaving the business state as it was is the corruption spec 6.3
          // singles out, so an unregistered referensi_tipe stops the whole
          // operation instead of being skipped.
          const pembalik = asli.referensi_tipe
            ? pembalikTerdaftar.find((p) => p.referensiTipe === asli.referensi_tipe)
            : undefined;
          if (asli.referensi_tipe && !pembalik) {
            throw tolak("PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR", {
              id,
              referensiTipe: asli.referensi_tipe,
            });
          }

          const jurnalAsli = await bacaJurnal(tx, id);

          // The reversal is dated in the CURRENT OPEN period, never on the
          // original date: the original period may already be closed.
          const hariIni = tanggalIso(jam());
          const memuat = await repo.periodeOpenMemuat(tx, asli.bumn_id, hariIni);
          let periode: PeriodeBaris;
          let tanggal: string;
          if (memuat) {
            periode = memuat;
            tanggal = hariIni;
          } else {
            const terakhir = await repo.periodeOpenTerakhir(tx, asli.bumn_id);
            if (!terakhir) throw tolak("TIDAK_ADA_PERIODE_OPEN", { id });
            periode = terakhir;
            tanggal = terakhir.tanggal_akhir;
          }

          // Sides swapped, everything else preserved: same accounts, same
          // amounts to the sen, and the same sub-ledger dimensions. Dropping
          // mitra_id/akad_id here would leave the piutang reconciliation
          // (spec 8.4 check 10) permanently off by the reversed amount.
          const barisBalik: BarisSiap[] = jurnalAsli.baris.map((b, i) => {
            const d = bacaUang(b.debit);
            const k = bacaUang(b.kredit);
            const senDebit = k.bentuk === "ok" ? k.sen : 0n;
            const senKredit = d.bentuk === "ok" ? d.sen : 0n;
            return {
              urutan: i + 1,
              akunId: b.akunId,
              debit: dariSen(senDebit),
              kredit: dariSen(senKredit),
              senDebit,
              senKredit,
              keterangan: b.keterangan,
              mitraId: b.mitraId,
              akadId: b.akadId,
              dimensi: b.dimensi,
            };
          });

          const idReversal = await tulisJurnal(
            tx,
            ctx,
            {
              cabangId: asli.cabang_id,
              jenis: "REVERSAL",
              tanggalTransaksi: tanggal,
              periode,
              keterangan: `Pembalikan jurnal ${asli.no_jurnal}: ${alasanBersih}`,
              referensiTipe: asli.referensi_tipe,
              referensiId: asli.referensi_id,
              isAutoGenerated: true,
              reversalOfJurnalId: asli.id,
              kunciIdempotensi: null,
            },
            barisBalik,
          );
          const terposting = await repo.tandaiPosted(tx, idReversal, ctx.userId, jam().toISOString());
          if (!terposting) throw tolak("POSTING_BENTROK", { id: idReversal });

          const tertandai = await repo.tandaiReversed(tx, asli.id, idReversal, ctx.userId);
          if (!tertandai) throw tolak("JURNAL_SUDAH_REVERSED", { id });

          // Same transaction, by construction: this runs on the same handle
          // that wrote the reversing journal, so either both land or neither
          // does (spec 6.3).
          if (pembalik) {
            await pembalik.balikkan({ jurnalAsli, alasan: alasanBersih }, tx, ctx);
          }

          const reversal = await bacaJurnal(tx, idReversal);
          await catat(tx, "jurnal.reversal", reversal, ctx, {
            nilaiLama: {
              jurnalAsliId: jurnalAsli.id,
              noJurnalAsli: jurnalAsli.noJurnal,
              statusAsliSebelum: "POSTED",
            },
            keterangan: alasanBersih,
          });
          return reversal;
        }),
      );
    },

    async postingBatch(ids, ctx) {
      wajibPunya(ctx, PERMISSION.POSTING);
      if (ids.length === 0) return [];
      // Locks are taken in SORTED id order, not in the order the UI happened to
      // list them. Two overlapping batches selected in opposite orders would
      // otherwise each hold a row the other needs, and Postgres would resolve
      // it by killing one with a deadlock rather than by refusing it cleanly.
      // Duplicates are collapsed: the same journal cannot be posted twice in
      // one batch, and reporting it as a conflict with itself would be noise.
      const unik = [...new Set(ids)];
      const urutKunci = [...unik].sort();
      return bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          const perId = new Map<string, Jurnal>();
          for (const id of urutKunci) {
            try {
              perId.set(id, await postingSatu(tx, id, ctx));
            } catch (err) {
              if (adalahJurnalError(err)) {
                // One transaction wraps the whole batch, so throwing here rolls
                // back the members already posted in this loop. The detail names
                // the member and the reason, because "something in your
                // selection is wrong" is not an actionable message.
                throw tolak("BATCH_GAGAL", {
                  jurnalIdGagal: id,
                  kodePenyebab: err.kode as KodeJurnal,
                  pesanPenyebab: err.message,
                });
              }
              throw err;
            }
          }
          // Returned in the caller's order, which is the order their screen is
          // showing; the sort above is a locking discipline, not an output one.
          return unik.map((id) => perId.get(id)!);
        }),
      );
    },

    async postingEvent(eventCode, payload, ctx) {
      // NO `jurnal.post` GATE HERE. Spec 2 gives Maker "input pencairan, input
      // penerimaan angsuran" while only Approver holds `jurnal.post`, so
      // demanding it would mean no single role can complete a PUMK
      // disbursement: the business action authorised, its ledger consequence
      // refused. An automatic journal is the consequence of an action the
      // caller already authorised. Branch scope (spec 2 rule 3) and every
      // spec 6.2 validation still apply, and manual posting still demands
      // `jurnal.post`, which is where segregation of duties actually lives.
      return bersihkanKesalahan(() =>
        db.transaction(async (tx) => {
          const map = await repo.mappingEvent(tx, ctx.bumnId, eventCode);
          if (!map) throw tolak("EVENT_MAPPING_TIDAK_DITEMUKAN", { eventCode });

          const akunDebit = map.debit_dari_payload ? payload.akunDebitId : map.akun_debit_id;
          const akunKredit = map.kredit_dari_payload ? payload.akunKreditId : map.akun_kredit_id;
          if (!akunDebit || !akunKredit) {
            throw tolak("EVENT_PAYLOAD_TIDAK_LENGKAP", {
              eventCode,
              butuhDebit: map.debit_dari_payload && !payload.akunDebitId,
              butuhKredit: map.kredit_dari_payload && !payload.akunKreditId,
            });
          }

          const kandidat = [akunDebit, akunKredit];
          if (payload.akunKasId) kandidat.push(payload.akunKasId);
          const akun = petaAkun(await repo.akun(tx, ctx.bumnId, [...new Set(kandidat)]));

          // The cash account chosen on the form overrides whichever leg of the
          // mapping is a cash account; a non-cash leg always stays as mapped.
          let debitId = akunDebit;
          let kreditId = akunKredit;
          if (payload.akunKasId) {
            if (akun.get(debitId)?.is_kas === true) debitId = payload.akunKasId;
            else if (akun.get(kreditId)?.is_kas === true) kreditId = payload.akunKasId;
          }

          // The piutang sub-ledger dimensions go on the receivable leg ONLY.
          // On the cash leg as well, v_rekonsiliasi_piutang would net the two
          // legs of every journal to zero per akad and the most important
          // reconciliation in the system would read "balanced" forever.
          const akunPiutang = await akunDariMapping(tx, ctx.bumnId, EVENT_PIUTANG_MITRA, "debit");
          const adaSubLedger = Boolean(payload.mitraId || payload.akadId);
          // Refuse rather than drop: a caller that hands over a mitra or an
          // akad for an event whose legs touch no receivable account has made a
          // mistake, and swallowing the dimension would make the piutang
          // reconciliation disagree with the business record silently.
          if (adaSubLedger && debitId !== akunPiutang && kreditId !== akunPiutang) {
            throw tolak("DIMENSI_PIUTANG_SALAH_AKUN", { eventCode, akunPiutang });
          }
          const dimensi = bersihkanDimensi(payload.dimensi);
          const kasDebit = akun.get(debitId)?.is_kas === true;
          const kasKredit = akun.get(kreditId)?.is_kas === true;
          // Analytic dimensions belong on the leg that carries the economics,
          // not on the cash movement; when both legs are cash, both get them.
          const dimensiDebit = !kasDebit || (kasDebit && kasKredit) ? dimensi : {};
          const dimensiKredit = !kasKredit || (kasDebit && kasKredit) ? dimensi : {};

          const nilai = payload.nilai;
          const baris: BarisJurnalInput[] = [
            {
              akunId: debitId,
              debit: nilai,
              keterangan: payload.keterangan ?? null,
              mitraId: adaSubLedger && debitId === akunPiutang ? (payload.mitraId ?? null) : null,
              akadId: adaSubLedger && debitId === akunPiutang ? (payload.akadId ?? null) : null,
              dimensi: dimensiDebit,
            },
            {
              akunId: kreditId,
              kredit: nilai,
              keterangan: payload.keterangan ?? null,
              mitraId: adaSubLedger && kreditId === akunPiutang ? (payload.mitraId ?? null) : null,
              akadId: adaSubLedger && kreditId === akunPiutang ? (payload.akadId ?? null) : null,
              dimensi: dimensiKredit,
            },
          ];

          const input: BuatJurnalInput = {
            cabangId: payload.cabangId,
            jenis: map.jenis_jurnal,
            tanggalTransaksi: payload.tanggalTransaksi,
            keterangan: payload.keterangan ?? `${eventCode}`,
            referensiTipe: payload.referensiTipe ?? null,
            referensiId: payload.referensiId ?? null,
            baris,
            isAutoGenerated: true,
            kunciIdempotensi: payload.kunciIdempotensi ?? null,
          };
          const hasil = await validasi(tx, input, ctx, { jenis: map.jenis_jurnal, manual: false });
          const id = await tulisJurnal(
            tx,
            ctx,
            {
              cabangId: input.cabangId,
              jenis: map.jenis_jurnal,
              tanggalTransaksi: input.tanggalTransaksi,
              periode: hasil.periode,
              keterangan: input.keterangan ?? null,
              referensiTipe: input.referensiTipe ?? null,
              referensiId: input.referensiId ?? null,
              isAutoGenerated: true,
              reversalOfJurnalId: null,
              kunciIdempotensi: input.kunciIdempotensi ?? null,
            },
            hasil.baris,
          );
          const terposting = await repo.tandaiPosted(tx, id, ctx.userId, jam().toISOString());
          if (!terposting) throw tolak("POSTING_BENTROK", { id });
          const jurnal = await bacaJurnal(tx, id);
          await catat(tx, "jurnal.post_event", jurnal, ctx, { keterangan: eventCode });
          return jurnal;
        }),
      );
    },

    postingEventGabungan(input, tx, ctx) {
      // Same stance as postingEvent on permissions, and for the same reason.
      // No transaction of its own: spec 7.2 requires steps 1 to 8 to be one
      // atomic unit, so the caller owns the boundary and a failure here must
      // take their allocation down with it.
      return bersihkanKesalahan(() => tulisGabungan(tx, input, ctx));
    },
  };
}
