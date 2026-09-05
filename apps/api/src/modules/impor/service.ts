// The import engine. Framework-agnostic: nothing here imports Hono.
//
// Read ./contract.ts first; its header states the four rules. The shape of the
// code below follows rule 1 exactly:
//
//   pratinjau()  parse -> validate every row -> return the report. NOTHING is
//                written, not even `impor_berkas`. A preview that left a row
//                behind would make "preview" a lie.
//
//   komit()      parse -> validate every row -> REFUSE IF ANY ROW IS BAD ->
//                open ONE transaction -> write the file row, then every data
//                row, then every provenance row -> commit. A failure anywhere
//                after BEGIN rolls the whole file back, which is what makes
//                partial application impossible rather than merely unlikely.
//
// The validation pass is the SAME FUNCTION in both paths (`periksaBerkas`), so
// a preview that says "ready" and a commit that refuses cannot disagree.
import { checksumTeks, KesalahanCsv, parseCsv, type BarisCsv } from "./csv";
import { dariBase64, KesalahanXlsx, parseXlsx } from "./xlsx";
import {
  FORMAT_IMPOR,
  ImporError,
  KODE_IMPOR,
  kolomUntuk,
  MAKS_BARIS,
  MAKS_ISI_BYTE,
  PERMISSION_IMPOR,
  POLA_TANGGAL,
  POLA_UANG,
  POLA_UUID,
  type BarisDiterima,
  type BarisDitolak,
  type HasilKomitAtauTolak,
  type HasilPratinjau,
  type ImporContext,
  type ImporEngine,
  type ImporEngineDeps,
  type JenisImpor,
  type KomponenSaldoAwal,
  type PermintaanImpor,
  type RingkasanSaldoAwal,
  type Uang,
} from "./contract";
import {
  bacaBagian,
  bacaDefinisiAkunBaru,
  bedaDefinisiAkun,
  dariSen,
  definisiKosong,
  EVENT_SALDO_AWAL_DEBIT,
  EVENT_SALDO_AWAL_KREDIT,
  jendelaSaldoAwal,
  keSen,
  rekonsiliasiBerkas,
  type BarisAkadSaldoAwal,
  type BarisAkunSaldoAwal,
  type JendelaSaldoAwal,
  type SisiSaldoAwal,
} from "./saldo-awal";
import { createImporRepo, type ImporRepo } from "./repo";
import type { QueryRunner } from "../../core/ports/db";

const PESAN: Readonly<Record<string, string>> = {
  JENIS_TIDAK_DIKENAL: "Jenis impor tidak dikenal.",
  BERKAS_KOSONG: "Berkas tidak berisi baris data apa pun.",
  BERKAS_TERLALU_BESAR: `Berkas melebihi ${Math.floor(MAKS_ISI_BYTE / 1024)} KB.`,
  FORMAT_TIDAK_DIKENAL: `Format berkas harus salah satu dari: ${FORMAT_IMPOR.join(", ")}.`,
  TERLALU_BANYAK_BARIS: `Berkas melebihi ${MAKS_BARIS} baris data.`,
  HEADER_TIDAK_LENGKAP: "Baris header tidak sesuai dengan format yang diminta.",
  // The message names the offending columns, because core/http.ts does not
  // carry a domain error's `detail` into the response and "header is wrong"
  // with no further word is a support ticket rather than an error.
  ADA_BARIS_DITOLAK:
    "Ada baris yang ditolak, jadi tidak ada satu baris pun yang disimpan. Perbaiki berkasnya lalu unggah ulang.",
  BERKAS_SUDAH_DIIMPOR: "Berkas dengan isi yang sama persis sudah pernah diimpor.",
  CABANG_TIDAK_DITEMUKAN: "Cabang tujuan impor tidak ditemukan.",
  CABANG_DILUAR_SCOPE: "Data ini berada di luar cabang Anda.",
  TIDAK_BERWENANG: "Anda tidak punya wewenang untuk tindakan ini.",
  MAPPING_PIUTANG_TIDAK_ADA:
    "Pemetaan jurnal PENCAIRAN_PUMK belum menyebut akun piutang, jadi saldo sub ledger tidak punya " +
    "akun kontrol untuk dibandingkan. Perbaiki pemetaannya lebih dulu; impor ini menolak alih alih " +
    "melaporkan tidak ada selisih atas perbandingan yang tidak pernah dilakukan.",
};

function tolak(kode: keyof typeof KODE_IMPOR, detail?: Record<string, unknown>): ImporError {
  return new ImporError(KODE_IMPOR[kode], PESAN[kode] ?? kode, detail);
}

const POLA_KENDALI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const POLA_NIK = /^\d{16}$/;
const POLA_EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/;

class Alasan {
  readonly galat: Record<string, string[]> = {};
  tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }
  get gagal(): boolean {
    return Object.keys(this.galat).length > 0;
  }
}

function teks(
  a: Alasan,
  nilai: string | undefined,
  field: string,
  opsi: { wajib: boolean; maks: number },
): string | null {
  const v = (nilai ?? "").trim();
  if (v.length === 0) {
    if (opsi.wajib) a.tolak(field, "wajib diisi");
    return null;
  }
  if (v.length > opsi.maks) {
    a.tolak(field, `maksimal ${opsi.maks} karakter`);
    return null;
  }
  if (POLA_KENDALI.test(v)) {
    a.tolak(field, "memuat karakter kendali yang tidak diizinkan");
    return null;
  }
  return v;
}

function tanggalValid(nilai: string): boolean {
  if (!POLA_TANGGAL.test(nilai)) return false;
  const t = new Date(`${nilai}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === nilai;
}

// ---------------------------------------------------------------------------
// Per-kind row validation
// ---------------------------------------------------------------------------

interface BarisMitra {
  nomorBaris: number;
  kodeMitra: string;
  namaLengkap: string;
  nik: string | null;
  jenisKelamin: string | null;
  tanggalLahir: string | null;
  alamat: string | null;
  telepon: string | null;
  email: string | null;
  namaUsaha: string | null;
  bidangUsaha: string | null;
  kodeMitraLama: string | null;
}

/**
 * Everything the go-live pass produced: the two row lists, the window the
 * journal will land in, and the reconciliation figures that were checked. All
 * of it is derived from the file and the database, and none of it has been
 * written anywhere; `pratinjau` returns the report built from it and `komit`
 * goes on to use the same object, so the two cannot disagree.
 */
interface HasilPeriksaSaldoAwal {
  diterima: BarisDiterima[];
  akun: BarisAkunSaldoAwal[];
  akad: BarisAkadSaldoAwal[];
  jendela: JendelaSaldoAwal;
  akunPiutangId: string;
  kodeAkunPiutang: string;
  tanggalEfektif: string;
  keterangan: string | null;
  totalDebit: Uang;
  totalKredit: Uang;
  saldoKontrolPiutang: Uang;
  totalSubLedgerPiutang: Uang;
}

/** Columns that belong to one section only. A filled cell in the wrong section
 * is REFUSED rather than ignored, for the reason the header check gives: a
 * column that is silently dropped is how an import quietly loses a field. */
const KOLOM_HANYA_AKUN = [
  "kode_akun",
  "nama_akun",
  "tipe",
  "saldo_normal",
  "level",
  "parent_kode",
  "klasifikasi",
  "is_postable",
  "is_kas",
  "is_kontra",
  "klasifikasi_arus_kas",
  "debit",
  "kredit",
] as const;

const KOLOM_HANYA_AKAD = [
  "no_akad",
  "outstanding_pokok",
  "outstanding_jasa",
  "tunggakan_pokok",
  "tunggakan_jasa",
  "angsuran_ke_terakhir",
  "hari_tunggakan",
  "kolektibilitas",
] as const;

function tolakKolomAsing(
  a: Alasan,
  v: Record<string, string>,
  kolom: readonly string[],
  bagianLain: string,
): void {
  for (const k of kolom) {
    if ((v[k] ?? "").trim().length > 0) {
      a.tolak(k, `hanya berlaku untuk baris bagian ${bagianLain}, kosongkan di baris ini`);
    }
  }
}

/** A non-negative whole number in a bounded range, or a rejection. */
function cacah(
  a: Alasan,
  nilai: string | undefined,
  field: string,
  maks: number,
): number | null {
  const v = (nilai ?? "").trim();
  if (v.length === 0) return null;
  if (!/^\d{1,9}$/.test(v)) {
    a.tolak(field, "wajib bilangan bulat tidak negatif");
    return null;
  }
  const n = Number(v);
  if (n > maks) {
    a.tolak(field, `maksimal ${maks}`);
    return null;
  }
  return n;
}

interface BarisAngsuran {
  nomorBaris: number;
  noAkad: string;
  tanggal: string;
  jumlah: Uang;
  kodeAkunKas: string;
  noBukti: string | null;
  tanggalValuta: string | null;
  keterangan: string | null;
  /** Resolved during validation so the commit does not look them up twice. */
  akadId: string;
  akunKasId: string;
}

function bacaBarisMitra(b: BarisCsv): { nilai: BarisMitra | null; alasan: Alasan } {
  const a = new Alasan();
  const v = b.nilai;
  const kodeMitra = teks(a, v.kode_mitra, "kode_mitra", { wajib: true, maks: 40 });
  const namaLengkap = teks(a, v.nama_lengkap, "nama_lengkap", { wajib: true, maks: 120 });

  const nikMentah = (v.nik ?? "").trim();
  let nik: string | null = null;
  if (nikMentah.length > 0) {
    if (!POLA_NIK.test(nikMentah)) a.tolak("nik", "wajib 16 digit angka");
    else nik = nikMentah;
  }

  const jkMentah = (v.jenis_kelamin ?? "").trim().toUpperCase();
  let jenisKelamin: string | null = null;
  if (jkMentah.length > 0) {
    if (jkMentah !== "L" && jkMentah !== "P") a.tolak("jenis_kelamin", "wajib L atau P");
    else jenisKelamin = jkMentah;
  }

  const lahirMentah = (v.tanggal_lahir ?? "").trim();
  let tanggalLahir: string | null = null;
  if (lahirMentah.length > 0) {
    if (!tanggalValid(lahirMentah)) a.tolak("tanggal_lahir", "wajib tanggal YYYY-MM-DD");
    else tanggalLahir = lahirMentah;
  }

  const emailMentah = (v.email ?? "").trim();
  let email: string | null = null;
  if (emailMentah.length > 0) {
    if (!POLA_EMAIL.test(emailMentah) || emailMentah.length > 200) {
      a.tolak("email", "format email tidak valid");
    } else email = emailMentah;
  }

  const alamat = teks(a, v.alamat, "alamat", { wajib: false, maks: 240 });
  const telepon = teks(a, v.telepon, "telepon", { wajib: false, maks: 40 });
  const namaUsaha = teks(a, v.nama_usaha, "nama_usaha", { wajib: false, maks: 120 });
  const bidangUsaha = teks(a, v.bidang_usaha, "bidang_usaha", { wajib: false, maks: 120 });
  const kodeMitraLama = teks(a, v.kode_mitra_lama, "kode_mitra_lama", { wajib: false, maks: 40 });

  if (a.gagal || !kodeMitra || !namaLengkap) return { nilai: null, alasan: a };
  return {
    nilai: {
      nomorBaris: b.nomorBaris,
      kodeMitra,
      namaLengkap,
      nik,
      jenisKelamin,
      tanggalLahir,
      alamat,
      telepon,
      email,
      namaUsaha,
      bidangUsaha,
      kodeMitraLama,
    },
    alasan: a,
  };
}

export function createImporEngine(deps: ImporEngineDeps): ImporEngine {
  const repo: ImporRepo = createImporRepo();

  function wajibIzin(ctx: ImporContext, izin: string): void {
    if (!ctx.permissions.includes(izin)) throw tolak("TIDAK_BERWENANG", { butuh: izin });
  }

  /** The branch every row lands in. Session first, request only within scope. */
  async function cabangTujuan(
    tx: QueryRunner,
    permintaan: PermintaanImpor,
    ctx: ImporContext,
  ): Promise<string> {
    const diminta = permintaan.cabangId?.trim();
    if (!diminta) return ctx.cabangId;
    if (!POLA_UUID.test(diminta)) throw tolak("CABANG_TIDAK_DITEMUKAN", { cabangId: diminta });
    const scope = ctx.cabangDalamScope;
    // Spec 2 rule 3: the SESSION says which branches this caller may act in.
    // An empty list is Admin Pusat / Auditor, i.e. no branch restriction.
    if (scope && scope.length > 0 && !scope.includes(diminta)) {
      throw tolak("CABANG_DILUAR_SCOPE", { cabangId: diminta });
    }
    const baris = await repo.cabang(tx, ctx.bumnId, diminta);
    if (!baris) throw tolak("CABANG_TIDAK_DITEMUKAN", { cabangId: diminta });
    return baris.id;
  }

  /**
   * Parse plus per-row validation, shared by BOTH paths. Reads the database
   * (uniqueness, akad and account lookups) but writes nothing.
   */
  async function periksaBerkas(
    tx: QueryRunner,
    permintaan: PermintaanImpor,
    ctx: ImporContext,
    cabangId: string,
  ): Promise<{
    checksum: string;
    ukuranBytes: number;
    jumlahBaris: number;
    diterima: BarisDiterima[];
    ditolak: BarisDitolak[];
    mitra: BarisMitra[];
    angsuran: BarisAngsuran[];
    saldoAwal: HasilPeriksaSaldoAwal | null;
  }> {
    const jenis = permintaan.jenis;
    const format = permintaan.berkas.format ?? "CSV";
    if (!(FORMAT_IMPOR as readonly string[]).includes(format)) {
      throw tolak("FORMAT_TIDAK_DIKENAL", { format });
    }
    const isi = permintaan.berkas.isi ?? "";
    if (isi.length === 0) throw tolak("BERKAS_KOSONG");

    // THE SIZE IS MEASURED ON THE REAL BYTES IN BOTH PATHS. For CSV that is
    // the UTF-8 encoding of the text; for XLSX it is the DECODED archive, not
    // the base64 that carried it, or a 683 KB body would pass a 512 KB cap.
    let parsed;
    let ukuranBytes: number;
    if (format === "XLSX") {
      let data: Uint8Array;
      try {
        data = dariBase64(isi);
      } catch {
        throw new ImporError(
          KODE_IMPOR.BERKAS_XLSX_DITOLAK,
          "Isi berkas .xlsx tidak terkirim dengan benar (bukan base64 yang sah). Unggah ulang berkasnya.",
        );
      }
      ukuranBytes = data.length;
      if (ukuranBytes === 0) throw tolak("BERKAS_KOSONG");
      if (ukuranBytes > MAKS_ISI_BYTE) throw tolak("BERKAS_TERLALU_BESAR", { ukuranBytes });
      try {
        parsed = parseXlsx(data);
      } catch (err) {
        if (err instanceof KesalahanXlsx) {
          // Translated at the ONE call site, exactly as `KesalahanCsv` is. The
          // MESSAGE is core/xlsx's, already written for an operator; the
          // machine-readable cap that fired travels in `detail` for the log.
          throw new ImporError(KODE_IMPOR.BERKAS_XLSX_DITOLAK, err.message, {
            sebab: err.kode,
            ...(err.batas === undefined ? {} : { batas: err.batas }),
          });
        }
        if (err instanceof KesalahanCsv) throw tolak("BERKAS_KOSONG", { alasan: err.alasan });
        throw err;
      }
    } else {
      ukuranBytes = new TextEncoder().encode(isi).length;
      if (ukuranBytes === 0) throw tolak("BERKAS_KOSONG");
      if (ukuranBytes > MAKS_ISI_BYTE) throw tolak("BERKAS_TERLALU_BESAR", { ukuranBytes });
      try {
        parsed = parseCsv(isi);
      } catch (err) {
        if (err instanceof KesalahanCsv) throw tolak("BERKAS_KOSONG", { alasan: err.alasan });
        throw err;
      }
    }
    if (parsed.baris.length === 0 && parsed.cacat.length === 0) throw tolak("BERKAS_KOSONG");
    if (parsed.baris.length + parsed.cacat.length > MAKS_BARIS) {
      throw tolak("TERLALU_BANYAK_BARIS", { jumlahBaris: parsed.baris.length });
    }

    const kolom = kolomUntuk(jenis);
    const dikenal = new Set<string>([...kolom.wajib, ...kolom.opsional]);
    const hilang = kolom.wajib.filter((k) => !parsed.header.includes(k));
    const asing = parsed.header.filter((h) => !dikenal.has(h));
    if (hilang.length > 0 || asing.length > 0) {
      const bagian = [
        hilang.length > 0 ? `kolom wajib yang hilang: ${hilang.join(", ")}` : null,
        asing.length > 0 ? `kolom yang tidak dikenal: ${asing.join(", ")}` : null,
      ].filter((x): x is string => x !== null);
      throw new ImporError(
        KODE_IMPOR.HEADER_TIDAK_LENGKAP,
        `Baris header tidak sesuai dengan format yang diminta (${bagian.join("; ")}). ` +
          `Kolom yang diterima: ${[...kolom.wajib, ...kolom.opsional].join(", ")}.`,
        { kolomHilang: hilang, kolomTidakDikenal: asing },
      );
    }

    const ditolak: BarisDitolak[] = parsed.cacat.map((c) => ({
      nomorBaris: c.nomorBaris,
      alasan: {
        baris: [`jumlah kolom ${c.jumlahKolom}, seharusnya ${parsed.header.length}`],
      },
    }));
    const diterima: BarisDiterima[] = [];
    const mitra: BarisMitra[] = [];
    const angsuran: BarisAngsuran[] = [];

    // Duplicates WITHIN the file, not only against the database. Two rows with
    // one kode_mitra would otherwise pass validation and fail at COMMIT with a
    // unique violation, which is a 409 the operator cannot act on.
    const kodeDalamBerkas = new Set<string>();
    const nikDalamBerkas = new Set<string>();

    // --- SALDO_AWAL takes its own pass ------------------------------------
    //
    // Not a branch inside the loop below: the go-live file has two SECTIONS
    // with different columns and different rules, and it has file-level
    // reconciliation gates that only mean anything once every row has been
    // read. Mixing that into the per-row loop of the other two kinds would
    // make all three harder to read and none of them safer.
    if (jenis === "SALDO_AWAL") {
      const saldoAwal = await periksaSaldoAwal(tx, parsed.baris, permintaan, ctx, cabangId, ditolak);
      return {
        checksum: await checksumTeks(isi),
        ukuranBytes,
        jumlahBaris: parsed.baris.length + parsed.cacat.length,
        diterima: saldoAwal.diterima,
        ditolak,
        mitra: [],
        angsuran: [],
        saldoAwal,
      };
    }

    for (const b of parsed.baris) {
      if (jenis === "MITRA") {
        const { nilai, alasan } = bacaBarisMitra(b);
        if (nilai) {
          if (kodeDalamBerkas.has(nilai.kodeMitra)) {
            alasan.tolak("kode_mitra", "duplikat di dalam berkas ini");
          } else if (await repo.kodeMitraDipakai(tx, nilai.kodeMitra)) {
            alasan.tolak("kode_mitra", "sudah dipakai mitra lain");
          }
          if (nilai.nik) {
            if (nikDalamBerkas.has(nilai.nik)) alasan.tolak("nik", "duplikat di dalam berkas ini");
            else if (await repo.nikDipakai(tx, nilai.nik)) alasan.tolak("nik", "sudah dipakai mitra lain");
          }
        }
        if (!nilai || alasan.gagal) {
          ditolak.push({ nomorBaris: b.nomorBaris, alasan: alasan.galat });
          continue;
        }
        kodeDalamBerkas.add(nilai.kodeMitra);
        if (nilai.nik) nikDalamBerkas.add(nilai.nik);
        mitra.push(nilai);
        diterima.push({
          nomorBaris: b.nomorBaris,
          ringkasan: { kode_mitra: nilai.kodeMitra, nama_lengkap: nilai.namaLengkap },
        });
        continue;
      }

      // --- ANGSURAN ------------------------------------------------------
      const a = new Alasan();
      const v = b.nilai;
      const noAkad = teks(a, v.no_akad, "no_akad", { wajib: true, maks: 60 });
      const tanggal = (v.tanggal ?? "").trim();
      if (!tanggalValid(tanggal)) a.tolak("tanggal", "wajib tanggal YYYY-MM-DD");
      const jumlah = (v.jumlah ?? "").trim();
      if (!POLA_UANG.test(jumlah)) {
        // A decimal STRING with exactly two fractional digits, never a float:
        // "1500000" and "1.5e6" are both refused here rather than rounded
        // somewhere downstream.
        a.tolak("jumlah", "wajib desimal dengan dua angka di belakang koma, misal 250000.00");
      } else if (BigInt(jumlah.replace(".", "")) <= 0n) {
        a.tolak("jumlah", "wajib lebih besar dari nol");
      }
      const kodeAkunKas = teks(a, v.kode_akun_kas, "kode_akun_kas", { wajib: true, maks: 40 });
      const noBukti = teks(a, v.no_bukti, "no_bukti", { wajib: false, maks: 60 });
      const keterangan = teks(a, v.keterangan, "keterangan", { wajib: false, maks: 240 });
      const valutaMentah = (v.tanggal_valuta ?? "").trim();
      let tanggalValuta: string | null = null;
      if (valutaMentah.length > 0) {
        if (!tanggalValid(valutaMentah)) a.tolak("tanggal_valuta", "wajib tanggal YYYY-MM-DD");
        else tanggalValuta = valutaMentah;
      }

      let akadId: string | null = null;
      if (noAkad) {
        const akad = await repo.akadByNomor(tx, cabangId, noAkad);
        // Same refusal for "no such akad" and "an akad in another branch": the
        // lookup is scoped by branch IN THE QUERY, so the file cannot be used
        // to discover which contract numbers exist elsewhere.
        if (!akad) a.tolak("no_akad", "akad tidak ditemukan di cabang ini");
        else akadId = akad.id;
      }
      let akunKasId: string | null = null;
      if (kodeAkunKas) {
        const akun = await repo.akunKasByKode(tx, ctx.bumnId, kodeAkunKas);
        if (!akun) a.tolak("kode_akun_kas", "akun tidak ditemukan");
        else if (!akun.is_postable) a.tolak("kode_akun_kas", "akun ini bukan akun postable");
        else akunKasId = akun.id;
      }

      if (a.gagal || !noAkad || !kodeAkunKas || !akadId || !akunKasId) {
        ditolak.push({ nomorBaris: b.nomorBaris, alasan: a.galat });
        continue;
      }
      angsuran.push({
        nomorBaris: b.nomorBaris,
        noAkad,
        tanggal,
        jumlah: jumlah as Uang,
        kodeAkunKas,
        noBukti,
        tanggalValuta,
        keterangan,
        akadId,
        akunKasId,
      });
      diterima.push({
        nomorBaris: b.nomorBaris,
        ringkasan: { no_akad: noAkad, tanggal, jumlah },
      });
    }

    return {
      checksum: await checksumTeks(isi),
      ukuranBytes,
      jumlahBaris: parsed.baris.length + parsed.cacat.length,
      diterima,
      ditolak,
      mitra,
      angsuran,
      saldoAwal: null,
    };
  }

  /**
   * The go-live pass: two sections, then the two file-level reconciliation
   * gates. READS THE DATABASE, WRITES NOTHING, and is called by BOTH
   * `pratinjau` and `komit`, so a preview that says "ready" and a commit that
   * refuses cannot disagree.
   *
   * The reconciliation gates THROW rather than adding to `ditolak`, and that
   * is the difference between "this line is wrong" and "this FILE is not an
   * opening balance". A rejection list with a line number is actionable; "your
   * trial balance is out by 1.250.000,00" is a statement about the whole
   * document and belongs in the message, with the numbers in it.
   */
  async function periksaSaldoAwal(
    tx: QueryRunner,
    baris: readonly BarisCsv[],
    permintaan: PermintaanImpor,
    ctx: ImporContext,
    cabangId: string,
    ditolak: BarisDitolak[],
  ): Promise<HasilPeriksaSaldoAwal> {
    const tanggalEfektif = (permintaan.saldoAwal?.tanggalEfektif ?? "").trim();
    if (!tanggalValid(tanggalEfektif)) {
      throw new ImporError(
        KODE_IMPOR.PERIODE_SALDO_AWAL_TIDAK_SIAP,
        "Tanggal efektif saldo awal wajib diisi dengan tanggal YYYY-MM-DD, yaitu tanggal cut off " +
          "pembukuan sistem lama.",
        { tanggalEfektif },
      );
    }

    // The window first, so a file dated at the wrong boundary is refused before
    // a single lookup is spent on its rows.
    const jendela = await jendelaSaldoAwal(tx, repo, ctx.bumnId, tanggalEfektif);

    const piutang = await repo.akunPiutangKontrol(tx, ctx.bumnId);
    if (!piutang) throw tolak("MAPPING_PIUTANG_TIDAK_ADA");

    const diterima: BarisDiterima[] = [];
    const akun: BarisAkunSaldoAwal[] = [];
    const akad: BarisAkadSaldoAwal[] = [];
    const kodeAkunDalamBerkas = new Set<string>();
    const noAkadDalamBerkas = new Set<string>();
    /** Accounts created by EARLIER lines of this same file, so a parent may be
     *  defined one line above its child, which is how a legacy COA arrives. */
    const akunBaruDalamBerkas = new Map<
      string,
      { level: number; tipe: string; isPostable: boolean }
    >();

    for (const b of baris) {
      const a = new Alasan();
      const v = b.nilai;
      const bagian = bacaBagian(v.bagian);
      if (!bagian) {
        a.tolak("bagian", "wajib AKUN atau AKAD");
        ditolak.push({ nomorBaris: b.nomorBaris, alasan: a.galat });
        continue;
      }

      if (bagian === "AKUN") {
        tolakKolomAsing(a, v, KOLOM_HANYA_AKAD, "AKAD");
        const kodeAkun = teks(a, v.kode_akun, "kode_akun", { wajib: true, maks: 40 });

        const debitMentah = (v.debit ?? "").trim();
        const kreditMentah = (v.kredit ?? "").trim();
        let debitSen = 0n;
        let kreditSen = 0n;
        if (debitMentah.length > 0) {
          const sen = keSen(debitMentah);
          if (sen === null) {
            a.tolak("debit", "wajib desimal dengan dua angka di belakang koma, misal 250000.00");
          } else debitSen = sen;
        }
        if (kreditMentah.length > 0) {
          const sen = keSen(kreditMentah);
          if (sen === null) {
            a.tolak("kredit", "wajib desimal dengan dua angka di belakang koma, misal 250000.00");
          } else kreditSen = sen;
        }
        // `akun_saldo_awal_satu_sisi_ck`, checked here so the operator gets a
        // line number rather than a constraint name from mid-commit.
        if (debitSen > 0n && kreditSen > 0n) {
          a.tolak("debit", "isi debit atau kredit, tidak boleh keduanya");
        }
        const punyaSaldo = debitSen > 0n || kreditSen > 0n;

        if (kodeAkun !== null) {
          if (kodeAkunDalamBerkas.has(kodeAkun)) {
            a.tolak("kode_akun", "duplikat di dalam berkas ini");
          } else kodeAkunDalamBerkas.add(kodeAkun);
        }

        let akunId: string | null = null;
        let buat: BarisAkunSaldoAwal["buat"] = null;
        if (kodeAkun !== null && !a.gagal) {
          const ada = await repo.akunByKode(tx, ctx.bumnId, kodeAkun);
          if (ada) {
            // DECISION 3 in ./saldo-awal.ts: blank means "take the definition
            // from the database"; filled-in means "this is what I believe the
            // account is", and a disagreement is refused rather than skipped
            // or applied.
            if (!definisiKosong(v)) {
              for (const beda of bedaDefinisiAkun(ada, v)) {
                a.tolak(
                  beda.kolom,
                  `akun ${kodeAkun} sudah ada dengan nilai "${beda.tersimpan}", berkas menyebut ` +
                    `"${beda.diminta}". Impor saldo awal tidak mengubah akun yang sudah ada: ` +
                    "kosongkan kolom ini untuk memakai definisi yang tersimpan, atau ubah akunnya " +
                    "lewat layar COA lebih dulu.",
                );
              }
            }
            if (punyaSaldo && !ada.is_postable) {
              a.tolak("kode_akun", "akun ini bukan akun postable, jadi tidak bisa membawa saldo");
            }
            if (punyaSaldo && !ada.aktif) a.tolak("kode_akun", "akun ini nonaktif");
            akunId = ada.id;
          } else if (definisiKosong(v)) {
            a.tolak(
              "kode_akun",
              `akun ${kodeAkun} belum ada dan kolom definisinya kosong, jadi tidak ada yang bisa ` +
                "dipakai untuk membuatnya. Isi nama_akun, tipe, saldo_normal, level, parent_kode " +
                "dan klasifikasi, atau perbaiki kodenya.",
            );
          } else {
            const parentKode = (v.parent_kode ?? "").trim();
            const parentDiDb =
              parentKode.length > 0 && !akunBaruDalamBerkas.has(parentKode)
                ? await repo.akunByKode(tx, ctx.bumnId, parentKode)
                : null;
            const klas = (v.klasifikasi ?? "").trim();
            const klasAda =
              klas.length > 0 ? await repo.klasifikasiAkunAda(tx, ctx.bumnId, klas) : false;
            buat = bacaDefinisiAkunBaru(
              a,
              kodeAkun,
              v,
              punyaSaldo,
              akunBaruDalamBerkas,
              parentDiDb,
              klasAda,
            );
          }
        }

        if (!punyaSaldo && buat === null && !a.gagal) {
          // Neither a balance nor a new account: the row states nothing. A
          // definition-only row IS allowed (that is how a header account
          // arrives), which is why this only fires when nothing is created.
          a.tolak(
            "debit",
            "baris ini tidak membawa saldo dan tidak membuat akun baru, jadi tidak ada isinya",
          );
        }

        // Read BEFORE the rejection check, not inside the push below: a
        // `keterangan` that is too long or carries a control character has to
        // be able to reject its own row.
        const keteranganAkun = teks(a, v.keterangan, "keterangan", { wajib: false, maks: 240 });

        if (a.gagal || kodeAkun === null) {
          ditolak.push({ nomorBaris: b.nomorBaris, alasan: a.galat });
          continue;
        }
        if (buat) {
          akunBaruDalamBerkas.set(buat.kode, {
            level: buat.level,
            tipe: buat.tipe,
            isPostable: buat.isPostable,
          });
        }
        akun.push({
          nomorBaris: b.nomorBaris,
          kodeAkun,
          akunId,
          buat,
          debitSen,
          kreditSen,
          keterangan: keteranganAkun,
        });
        diterima.push({
          nomorBaris: b.nomorBaris,
          ringkasan: {
            bagian: "AKUN",
            kode_akun: kodeAkun,
            debit: dariSen(debitSen),
            kredit: dariSen(kreditSen),
            akun_baru: buat ? "Y" : "T",
          },
        });
        continue;
      }

      // --- bagian = AKAD --------------------------------------------------
      tolakKolomAsing(a, v, KOLOM_HANYA_AKUN, "AKUN");
      const noAkad = teks(a, v.no_akad, "no_akad", { wajib: true, maks: 60 });

      const pokokMentah = (v.outstanding_pokok ?? "").trim();
      let outstandingPokokSen = 0n;
      if (pokokMentah.length === 0) a.tolak("outstanding_pokok", "wajib diisi");
      else {
        const sen = keSen(pokokMentah);
        if (sen === null) {
          a.tolak(
            "outstanding_pokok",
            "wajib desimal dengan dua angka di belakang koma, misal 250000.00",
          );
        } else if (sen <= 0n) {
          // An akad with nothing outstanding carries no opening balance and
          // would need a LUNAS transition (with its `tanggal_lunas`) that this
          // tool does not own. Refused rather than half-migrated.
          a.tolak("outstanding_pokok", "wajib lebih besar dari nol");
        } else outstandingPokokSen = sen;
      }

      const uangOpsional = (kolom: string): bigint => {
        const mentah = (v[kolom] ?? "").trim();
        if (mentah.length === 0) return 0n;
        const sen = keSen(mentah);
        if (sen === null) {
          a.tolak(kolom, "wajib desimal dengan dua angka di belakang koma, misal 250000.00");
          return 0n;
        }
        return sen;
      };
      const outstandingJasaSen = uangOpsional("outstanding_jasa");
      const tunggakanPokokSen = uangOpsional("tunggakan_pokok");
      const tunggakanJasaSen = uangOpsional("tunggakan_jasa");
      // `akad_saldo_awal_tunggakan_ck`, ahead of the constraint.
      if (tunggakanPokokSen > outstandingPokokSen) {
        a.tolak("tunggakan_pokok", "tidak boleh melebihi outstanding_pokok");
      }

      const angsuranKeTerakhir = cacah(a, v.angsuran_ke_terakhir, "angsuran_ke_terakhir", 32767);
      const hariTunggakan = cacah(a, v.hari_tunggakan, "hari_tunggakan", 100000);

      const kolMentah = (v.kolektibilitas ?? "").trim().toUpperCase();
      let kolektibilitas: string | null = null;
      if (kolMentah.length > 0) {
        if (!(await repo.kolektibilitasKelasAda(tx, kolMentah))) {
          a.tolak("kolektibilitas", "kelas kolektibilitas ini tidak terdaftar");
        } else kolektibilitas = kolMentah;
      }

      let akadId: string | null = null;
      let mitraId: string | null = null;
      if (noAkad !== null) {
        if (noAkadDalamBerkas.has(noAkad)) a.tolak("no_akad", "duplikat di dalam berkas ini");
        else noAkadDalamBerkas.add(noAkad);

        const row = await repo.akadUntukSaldoAwal(tx, cabangId, noAkad);
        // Same refusal for "no such akad" and "an akad in another branch": the
        // lookup is scoped by branch IN THE QUERY, so an opening-balance file
        // cannot be used to discover contract numbers elsewhere.
        if (!row) a.tolak("no_akad", "akad tidak ditemukan di cabang ini");
        else {
          // AN OPENING BALANCE MAY ONLY OPEN AN AKAD THAT HAS NEVER MOVED IN
          // THIS SYSTEM. Anything else and this import would be ADJUSTING a
          // live receivable from a spreadsheet, which is a correction, not a
          // migration, and corrections go through the operational screens with
          // their own maker-checker.
          if (row.status !== "BELUM_CAIR") {
            a.tolak(
              "no_akad",
              `akad ini berstatus ${row.status}; saldo awal hanya untuk akad warisan yang belum ` +
                "pernah dicairkan di sistem ini",
            );
          }
          if (keSen(row.outstanding_pokok) !== 0n) {
            a.tolak("no_akad", "akad ini sudah punya outstanding di sistem ini");
          }
          if (row.ada_di_ledger) {
            a.tolak("no_akad", "akad ini sudah punya baris di buku besar sistem ini");
          }
          const pokok = keSen(row.pokok_pinjaman) ?? 0n;
          if (outstandingPokokSen > pokok) {
            a.tolak(
              "outstanding_pokok",
              `tidak boleh melebihi pokok pinjaman akad (${row.pokok_pinjaman})`,
            );
          }
          akadId = row.id;
          mitraId = row.mitra_id;
        }
      }

      const keterangan = teks(a, v.keterangan, "keterangan", { wajib: false, maks: 240 });
      if (a.gagal || noAkad === null || akadId === null || mitraId === null) {
        ditolak.push({ nomorBaris: b.nomorBaris, alasan: a.galat });
        continue;
      }
      akad.push({
        nomorBaris: b.nomorBaris,
        noAkad,
        akadId,
        mitraId,
        outstandingPokokSen,
        outstandingJasaSen,
        tunggakanPokokSen,
        tunggakanJasaSen,
        angsuranKeTerakhir,
        hariTunggakan,
        kolektibilitas,
        keterangan,
      });
      diterima.push({
        nomorBaris: b.nomorBaris,
        ringkasan: {
          bagian: "AKAD",
          no_akad: noAkad,
          outstanding_pokok: dariSen(outstandingPokokSen),
        },
      });
    }

    // R1 and R2 (./saldo-awal.ts). Only meaningful over a file whose every row
    // was read, so a file with rejections is answered with the rejection list
    // and the totals are not claimed at all.
    let rekon = {
      totalDebitSen: 0n,
      totalKreditSen: 0n,
      saldoKontrolPiutangSen: 0n,
      totalSubLedgerPiutangSen: 0n,
    };
    if (ditolak.length === 0) {
      rekon = rekonsiliasiBerkas({
        akun,
        akad,
        akunPiutangId: piutang.id,
        kodeAkunPiutang: piutang.kode,
      });
    }

    return {
      diterima,
      akun,
      akad,
      jendela,
      akunPiutangId: piutang.id,
      kodeAkunPiutang: piutang.kode,
      tanggalEfektif,
      keterangan: permintaan.saldoAwal?.keterangan?.trim() || null,
      totalDebit: dariSen(rekon.totalDebitSen),
      totalKredit: dariSen(rekon.totalKreditSen),
      saldoKontrolPiutang: dariSen(rekon.saldoKontrolPiutangSen),
      totalSubLedgerPiutang: dariSen(rekon.totalSubLedgerPiutangSen),
    };
  }

  function namaFileBersih(nama: unknown): string {
    const v = typeof nama === "string" ? nama.trim() : "";
    if (v.length === 0) return "impor.csv";
    // Display text, but one field away from becoming a storage key, so path
    // separators are stripped at the boundary rather than escaped later.
    return v.replace(/[/\\\u0000-\u001F]/g, "_").slice(0, 160);
  }

  function jenisValid(jenis: unknown): JenisImpor {
    if (jenis === "MITRA" || jenis === "ANGSURAN" || jenis === "SALDO_AWAL") return jenis;
    throw tolak("JENIS_TIDAK_DIKENAL", { jenis });
  }

  /**
   * Rule 3 for the go-live import. See `PERMISSION_IMPOR` in ./contract.ts:
   * creating accounts is `konfigurasi.coa` and landing a POSTED journal is
   * `jurnal.post`, so the file may not do either unless its operator could
   * have done it by hand.
   */
  function izinSaldoAwal(ctx: ImporContext): void {
    wajibIzin(ctx, PERMISSION_IMPOR.SALDO_AWAL_COA);
    wajibIzin(ctx, PERMISSION_IMPOR.SALDO_AWAL_POSTING);
  }

  /** Refuses a scope whose books are already open. See `SALDO_AWAL_SUDAH_DIPOSTING`. */
  async function wajibBelumDiposting(
    tx: QueryRunner,
    ctx: ImporContext,
    cabangId: string,
  ): Promise<void> {
    const ada = await repo.batchDipostingAda(tx, ctx.bumnId, cabangId);
    if (!ada) return;
    throw new ImporError(
      KODE_IMPOR.SALDO_AWAL_SUDAH_DIPOSTING,
      `Saldo awal untuk cabang ini sudah pernah diposting (batch per ${ada.tanggal_efektif}, ` +
        `dibuat ${ada.dibuat_pada}). Saldo awal hanya boleh diposting sekali; mengunggah ulang ` +
        "berkas yang sama dengan nama lain, urutan baris lain, atau hasil simpan ulang dari Excel " +
        "akan menggandakan seluruh pembukuan. Kalau isinya memang harus diperbaiki, batalkan batch " +
        "yang lama lebih dulu.",
      { batchId: ada.id, tanggalEfektif: ada.tanggal_efektif },
    );
  }

  return {
    async pratinjau(permintaan, ctx): Promise<HasilPratinjau> {
      wajibIzin(ctx, PERMISSION_IMPOR.UNGGAH);
      const jenis = jenisValid(permintaan.jenis);
      if (jenis === "MITRA") wajibIzin(ctx, PERMISSION_IMPOR.MITRA);
      if (jenis === "SALDO_AWAL") izinSaldoAwal(ctx);
      const cabangId = await cabangTujuan(deps.db, permintaan, ctx);
      // A PREVIEW OF AN OPENING BALANCE FOR A SCOPE THAT IS ALREADY OPEN MUST
      // NOT SAY "READY". It writes nothing either way; what it must not do is
      // tell an operator to go ahead with an upload the commit will refuse.
      if (jenis === "SALDO_AWAL") await wajibBelumDiposting(deps.db, ctx, cabangId);
      const hasil = await periksaBerkas(deps.db, { ...permintaan, jenis }, ctx, cabangId);
      return {
        jenis,
        namaFile: namaFileBersih(permintaan.berkas.namaFile),
        checksum: hasil.checksum,
        ukuranBytes: hasil.ukuranBytes,
        jumlahBaris: hasil.jumlahBaris,
        diterima: hasil.diterima,
        ditolak: hasil.ditolak,
        siapKomit: hasil.ditolak.length === 0 && hasil.diterima.length > 0,
      };
    },

    async komit(permintaan, ctx): Promise<HasilKomitAtauTolak> {
      wajibIzin(ctx, PERMISSION_IMPOR.UNGGAH);
      const jenis = jenisValid(permintaan.jenis);
      if (jenis === "MITRA") wajibIzin(ctx, PERMISSION_IMPOR.MITRA);
      if (jenis === "SALDO_AWAL") izinSaldoAwal(ctx);
      const namaFile = namaFileBersih(permintaan.berkas.namaFile);

      // ONE TRANSACTION FOR THE WHOLE FILE. Everything below either commits
      // together or rolls back together, including the journals the instalment
      // engine posts, because that engine is rebuilt over this same runner.
      return deps.db.transaction(async (tx) => {
        const cabangId = await cabangTujuan(tx, permintaan, ctx);

        // THE DUPLICATE-FILE CHECK COMES FIRST, before the rows are validated.
        // Re-uploading a file that already committed would otherwise be
        // reported as "every row is a duplicate", which is true but useless:
        // the operator needs to be told the FILE was already imported, not
        // handed 200 row-level rejections describing the consequence of that.
        const checksum = await checksumTeks(permintaan.berkas.isi ?? "");
        const kembar = await repo.berkasSudahAda(tx, { bumnId: ctx.bumnId, jenis, checksum });
        if (kembar) {
          // A double click, a retried request, or the same spreadsheet mailed
          // round twice. `impor_berkas_checksum_uq` also enforces this, so a
          // race that beats this read still cannot produce two imports.
          throw tolak("BERKAS_SUDAH_DIIMPOR", {
            berkasId: kembar.id,
            namaFile: kembar.nama_file,
            diunggahPada: kembar.diunggah_pada,
          });
        }

        // THE SECOND HALF OF THE DOUBLE-RUN REFUSAL, and the one that actually
        // holds. `impor_berkas_checksum_uq` above refuses the same BYTES; it
        // cannot refuse the same BALANCES arriving as different bytes, which is
        // what a re-saved .xlsx, a reordered CSV or a renamed file all are. A
        // nervous operator re-running the migration "just to be sure" would
        // otherwise double every opening balance, and the accountant finds out
        // weeks later. `saldo_awal_batch_diposting_uq` (migration 0033) makes
        // this true under a race as well; this read makes it readable.
        if (jenis === "SALDO_AWAL") await wajibBelumDiposting(tx, ctx, cabangId);

        const hasil = await periksaBerkas(tx, { ...permintaan, jenis }, ctx, cabangId);

        if (hasil.ditolak.length > 0) {
          // Spec 9.6: never commit part of a file. Returned rather than
          // thrown, so the whole rejection list reaches the operator; see
          // `HasilKomitAtauTolak` in ./contract.ts. Nothing has been written
          // at this point, and returning out of the transaction callback
          // COMMITS an empty transaction, which is a no-op.
          return {
            ok: false,
            laporan: {
              jenis,
              namaFile,
              checksum: hasil.checksum,
              ukuranBytes: hasil.ukuranBytes,
              jumlahBaris: hasil.jumlahBaris,
              diterima: hasil.diterima,
              ditolak: hasil.ditolak,
              siapKomit: false,
            },
          };
        }
        if (hasil.diterima.length === 0) throw tolak("BERKAS_KOSONG");

        const berkasId = await repo.buatBerkas(tx, {
          bumnId: ctx.bumnId,
          cabangId,
          jenis,
          namaFile,
          ukuranBytes: hasil.ukuranBytes,
          checksum: hasil.checksum,
          jumlahBaris: hasil.jumlahBaris,
          userId: ctx.userId,
        });

        const jurnalIds: string[] = [];
        let jumlahDitulis = 0;
        let ringkasanSaldoAwal: RingkasanSaldoAwal | undefined;

        if (jenis === "SALDO_AWAL") {
          const sa = hasil.saldoAwal;
          if (!sa) throw new Error("impor: SALDO_AWAL tanpa hasil pemeriksaan");
          const jurnal = deps.jurnal;
          if (!jurnal) {
            // Refuses rather than half-working. A batch written with no journal
            // behind it is exactly the half-applied state rule 1 exists to
            // prevent, and it would be invisible until the first close.
            throw new Error(
              "impor: port jurnal belum dipasang, jadi impor saldo awal tidak bisa memposting",
            );
          }

          const batchId = await repo.buatBatchSaldoAwal(tx, {
            bumnId: ctx.bumnId,
            cabangId,
            tanggalEfektif: sa.tanggalEfektif,
            keterangan:
              sa.keterangan ?? `Saldo awal go-live dari ${namaFile} per ${sa.tanggalEfektif}`,
            userId: ctx.userId,
          });

          // 1. THE CHART OF ACCOUNTS FIRST, in file order, so a parent defined
          //    one line above its child already exists when the child is
          //    written and `trg_akun_10_hierarki` sees a complete picture.
          const akunIdByKode = new Map<string, string>();
          const akunDibuat: string[] = [];
          for (const r of sa.akun) {
            if (r.akunId) {
              akunIdByKode.set(r.kodeAkun, r.akunId);
              continue;
            }
            const def = r.buat;
            if (!def) throw new Error("impor: baris akun tanpa id dan tanpa definisi");
            const parentId = def.parentKode
              ? (akunIdByKode.get(def.parentKode) ??
                (await repo.akunByKode(tx, ctx.bumnId, def.parentKode))?.id ??
                null)
              : null;
            const id = await repo.buatAkun(tx, {
              bumnId: ctx.bumnId,
              kode: def.kode,
              nama: def.nama,
              tipe: def.tipe,
              saldoNormal: def.saldoNormal,
              level: def.level,
              parentId,
              klasifikasi: def.klasifikasi,
              isPostable: def.isPostable,
              isKas: def.isKas,
              isKontra: def.isKontra,
              klasifikasiArusKas: def.klasifikasiArusKas,
              userId: ctx.userId,
            });
            akunIdByKode.set(def.kode, id);
            akunDibuat.push(def.kode);
            r.akunId = id;
          }

          // 2. THE TWO HALVES OF THE BATCH. `akun_saldo_awal` only takes rows
          //    that carry a balance (its one-side CHECK forbids a zero row), so
          //    a definition-only line creates its account and nothing else.
          for (const r of sa.akun) {
            if (r.debitSen === 0n && r.kreditSen === 0n) {
              await repo.catatBaris(tx, {
                berkasId,
                nomorBaris: r.nomorBaris,
                entitas: "akun",
                entitasId: r.akunId!,
                jurnalId: null,
                nilai: { kode_akun: r.kodeAkun, akun_baru: true },
                userId: ctx.userId,
              });
              jumlahDitulis += 1;
              continue;
            }
            const barisId = await repo.tulisAkunSaldoAwal(tx, {
              batchId,
              cabangId,
              akunId: r.akunId!,
              debit: dariSen(r.debitSen),
              kredit: dariSen(r.kreditSen),
              keterangan: r.keterangan,
              userId: ctx.userId,
            });
            await repo.catatBaris(tx, {
              berkasId,
              nomorBaris: r.nomorBaris,
              entitas: "akun_saldo_awal",
              entitasId: barisId,
              jurnalId: null,
              nilai: {
                kode_akun: r.kodeAkun,
                debit: dariSen(r.debitSen),
                kredit: dariSen(r.kreditSen),
              },
              userId: ctx.userId,
            });
            jumlahDitulis += 1;
          }

          for (const r of sa.akad) {
            const barisId = await repo.tulisAkadSaldoAwal(tx, {
              batchId,
              akadId: r.akadId,
              outstandingPokok: dariSen(r.outstandingPokokSen),
              outstandingJasa: dariSen(r.outstandingJasaSen),
              tunggakanPokok: dariSen(r.tunggakanPokokSen),
              tunggakanJasa: dariSen(r.tunggakanJasaSen),
              angsuranKeTerakhir: r.angsuranKeTerakhir,
              hariTunggakan: r.hariTunggakan,
              kolektibilitas: r.kolektibilitas,
              keterangan: r.keterangan,
              userId: ctx.userId,
            });
            // The live sub-ledger, without which spec 8.4 check 10 fails on
            // every imported akad. See `setOutstandingAwalAkad` in ./repo.ts.
            await repo.setOutstandingAwalAkad(tx, {
              akadId: r.akadId,
              outstandingPokok: dariSen(r.outstandingPokokSen),
              outstandingJasa: dariSen(r.outstandingJasaSen),
              userId: ctx.userId,
            });
            await repo.catatBaris(tx, {
              berkasId,
              nomorBaris: r.nomorBaris,
              entitas: "akad_saldo_awal",
              entitasId: barisId,
              jurnalId: null,
              nilai: {
                no_akad: r.noAkad,
                outstanding_pokok: dariSen(r.outstandingPokokSen),
              },
              userId: ctx.userId,
            });
            jumlahDitulis += 1;
          }

          // 3. THE JOURNAL, through the engine's own combined posting. The
          //    receivable's control balance is replaced by ONE ENTRY PER AKAD,
          //    carrying the sub-ledger dimensions, which is what makes
          //    `v_rekonsiliasi_piutang` able to attribute the balance at all;
          //    R2 has already proved the two add up to the same figure, so the
          //    trial balance is unchanged by the substitution.
          const debit: SisiSaldoAwal[] = [];
          const kredit: SisiSaldoAwal[] = [];
          for (const r of sa.akun) {
            if (r.akunId === sa.akunPiutangId) continue;
            if (r.debitSen > 0n) {
              debit.push({
                akunId: r.akunId!,
                sen: r.debitSen,
                mitraId: null,
                akadId: null,
                keterangan: `Saldo awal ${r.kodeAkun}`,
              });
            }
            if (r.kreditSen > 0n) {
              kredit.push({
                akunId: r.akunId!,
                sen: r.kreditSen,
                mitraId: null,
                akadId: null,
                keterangan: `Saldo awal ${r.kodeAkun}`,
              });
            }
          }
          for (const r of sa.akad) {
            debit.push({
              akunId: sa.akunPiutangId,
              sen: r.outstandingPokokSen,
              mitraId: r.mitraId,
              akadId: r.akadId,
              keterangan: `Saldo awal piutang akad ${r.noAkad}`,
            });
          }

          // ONE COMPONENT PER IMPORTED BALANCE, each against the clearing
          // account its mapping row fixes. No balance is paired against
          // another, because no such relationship exists; see the two
          // SALDO_AWAL rows in seed/event-jurnal.ts. `postingEventGabungan`
          // merges legs that agree, so the clearing account contributes
          // exactly two lines to the whole journal and nets to zero.
          const komponen: KomponenSaldoAwal[] = [
            ...debit.map((x) => ({
              eventCode: EVENT_SALDO_AWAL_DEBIT,
              nilai: dariSen(x.sen),
              akunDebitId: x.akunId,
              mitraId: x.mitraId,
              akadId: x.akadId,
              keterangan: x.keterangan,
            })),
            ...kredit.map((x) => ({
              eventCode: EVENT_SALDO_AWAL_KREDIT,
              nilai: dariSen(x.sen),
              akunKreditId: x.akunId,
              mitraId: x.mitraId,
              akadId: x.akadId,
              keterangan: x.keterangan,
            })),
          ];
          if (komponen.length === 0) throw tolak("BERKAS_KOSONG");

          const jurnalSaldoAwal = await jurnal.postingEventGabungan(
            {
              cabangId,
              // NOT `tanggalEfektif`. See decision 2 in ./saldo-awal.ts: the
              // cut-off sits in the period BEFORE this system's books, which is
              // absent or CLOSED, and invariant 5 refuses both.
              tanggalTransaksi: sa.jendela.tanggalJurnal,
              komponen,
              keterangan: `Saldo awal go-live per ${sa.tanggalEfektif} (${namaFile})`,
              referensiTipe: "saldo_awal_batch",
              referensiId: batchId,
              // Invariant 13, and a third layer under the double-run refusal: a
              // second journal for this batch is refused by
              // `jurnal_idempotensi_uq` even if everything above were bypassed.
              kunciIdempotensi: `saldo_awal:${batchId}`,
            },
            tx,
            {
              userId: ctx.userId,
              cabangId,
              bumnId: ctx.bumnId,
              permissions: ctx.permissions,
              ...(ctx.cabangDalamScope ? { cabangDalamScope: ctx.cabangDalamScope } : {}),
            },
          );
          jurnalIds.push(jurnalSaldoAwal.id);

          // 4. R3: THE SHIPPED PREDICATE, ON THE ROWS THAT WERE ACTUALLY
          //    WRITTEN, STILL INSIDE THIS TRANSACTION. R1 and R2 are arithmetic
          //    on the file; this is spec 8.4 check 10 itself. If it disagrees
          //    with them, it wins and the whole file rolls back, because it is
          //    the check the monthly close will run.
          const akadIds = sa.akad.map((r) => r.akadId);
          // `numeric(20,2)::text` is exactly "0.00" for no difference and
          // carries a sign otherwise, so the comparison is on the string the
          // database produced rather than on a re-parse of it. `keSen` would
          // refuse a negative difference and reach the same verdict for the
          // wrong reason, which is the kind of accident that survives until
          // somebody widens the parser.
          const selisih = (await repo.rekonsiliasiPiutang(tx, akadIds)).filter(
            (r) => r.selisih !== "0.00",
          );
          if (selisih.length > 0) {
            throw new ImporError(
              KODE_IMPOR.REKONSILIASI_PIUTANG_GAGAL,
              `Setelah semuanya ditulis, v_rekonsiliasi_piutang masih melaporkan selisih pada ` +
                `${selisih.length} akad (pemeriksaan tutup buku butir 10). Tidak ada satu baris pun ` +
                `yang disimpan. Contoh: akad ${selisih[0]!.no_akad} sub ledger ` +
                `${selisih[0]!.saldo_sub_ledger}, buku besar ${selisih[0]!.saldo_buku_besar}.`,
              {
                jumlahAkad: selisih.length,
                contoh: selisih.slice(0, 5),
              },
            );
          }

          await repo.tandaiBatchDiposting(tx, {
            batchId,
            jurnalId: jurnalSaldoAwal.id,
            // ADR 0006 calls these "the batch totals", i.e. the TRIAL BALANCE's
            // own totals. The journal's gross is twice them (each balance is
            // recorded once on its account and once on the clearing account),
            // and writing that here would make the batch row disagree with the
            // report the operator imported from.
            totalDebit: sa.totalDebit,
            totalKredit: sa.totalKredit,
            catatan: {
              checksumBerkas: hasil.checksum,
              namaFile,
              tanggalEfektif: sa.tanggalEfektif,
              tanggalJurnal: sa.jendela.tanggalJurnal,
              totalDebitBerkas: sa.totalDebit,
              totalKreditBerkas: sa.totalKredit,
              kodeAkunPiutang: sa.kodeAkunPiutang,
              saldoKontrolPiutang: sa.saldoKontrolPiutang,
              totalSubLedgerPiutang: sa.totalSubLedgerPiutang,
              brutoJurnalDebit: jurnalSaldoAwal.totalDebit,
              brutoJurnalKredit: jurnalSaldoAwal.totalKredit,
              jumlahAkun: sa.akun.length,
              jumlahAkad: sa.akad.length,
              akunDibuat,
            },
            userId: ctx.userId,
          });

          // The batch, at line 1: the header line, which is the only line
          // number no data row can claim, so `impor_baris_urutan_uq` still
          // holds and the file as a whole has a provenance row of its own.
          await repo.catatBaris(tx, {
            berkasId,
            nomorBaris: 1,
            entitas: "saldo_awal_batch",
            entitasId: batchId,
            jurnalId: jurnalSaldoAwal.id,
            nilai: {
              tanggal_efektif: sa.tanggalEfektif,
              tanggal_jurnal: sa.jendela.tanggalJurnal,
              total_debit: sa.totalDebit,
              total_kredit: sa.totalKredit,
            },
            userId: ctx.userId,
          });

          ringkasanSaldoAwal = {
            batchId,
            jurnalId: jurnalSaldoAwal.id,
            noJurnal: jurnalSaldoAwal.noJurnal,
            tanggalEfektif: sa.tanggalEfektif,
            tanggalJurnal: sa.jendela.tanggalJurnal,
            periodeId: jurnalSaldoAwal.periodeId,
            totalDebit: sa.totalDebit,
            totalKredit: sa.totalKredit,
            brutoJurnalDebit: jurnalSaldoAwal.totalDebit,
            brutoJurnalKredit: jurnalSaldoAwal.totalKredit,
            jumlahAkun: sa.akun.length,
            jumlahAkad: sa.akad.length,
            akunDibuat,
            kodeAkunPiutang: sa.kodeAkunPiutang,
            saldoKontrolPiutang: sa.saldoKontrolPiutang,
            totalSubLedgerPiutang: sa.totalSubLedgerPiutang,
          };
        } else if (jenis === "MITRA") {
          for (const m of hasil.mitra) {
            const mitraId = await repo.buatMitra(tx, { ...m, cabangId, userId: ctx.userId });
            await repo.catatBaris(tx, {
              berkasId,
              nomorBaris: m.nomorBaris,
              entitas: "mitra",
              entitasId: mitraId,
              jurnalId: null,
              nilai: { kode_mitra: m.kodeMitra, nama_lengkap: m.namaLengkap },
              userId: ctx.userId,
            });
            jumlahDitulis += 1;
          }
        } else {
          // The instalment engine, REBUILT over the open transaction. See
          // `PabrikAngsuran` in ./contract.ts: `transaction(fn)` on this port
          // runs `fn(tx)`, so every receipt joins this file's transaction
          // instead of opening its own.
          const angsuran = deps.angsuran({
            query: (sql, params) => tx.query(sql, params),
            transaction: async <T,>(fn: (t: QueryRunner) => Promise<T>): Promise<T> => fn(tx),
          });
          for (const g of hasil.angsuran) {
            const setoran = await angsuran.alokasikanSetoran(
              {
                akadId: g.akadId,
                tanggal: g.tanggal,
                jumlah: g.jumlah,
                akunKasId: g.akunKasId,
                noBukti: g.noBukti,
                tanggalValuta: g.tanggalValuta,
                keterangan: g.keterangan ?? `Impor massal ${namaFile} baris ${g.nomorBaris}`,
              },
              {
                userId: ctx.userId,
                cabangId,
                bumnId: ctx.bumnId,
                // THE CALLER'S REAL PERMISSIONS, not a widened set. Rule 3:
                // an operator without `pumk.angsuran` is refused by the
                // instalment engine itself, and the whole file rolls back.
                permissions: ctx.permissions,
                ...(ctx.cabangDalamScope ? { cabangDalamScope: ctx.cabangDalamScope } : {}),
              },
            );
            jurnalIds.push(setoran.jurnalId);
            await repo.catatBaris(tx, {
              berkasId,
              nomorBaris: g.nomorBaris,
              entitas: "pumk_angsuran",
              entitasId: setoran.angsuranId,
              jurnalId: setoran.jurnalId,
              nilai: { no_akad: g.noAkad, tanggal: g.tanggal, jumlah: g.jumlah },
              userId: ctx.userId,
            });
            jumlahDitulis += 1;
          }
        }

        await deps.audit.record(
          {
            userId: ctx.userId,
            aksi: "impor.komit",
            entitas: "impor_berkas",
            entitasId: berkasId,
            nilaiBaru: {
              jenis,
              namaFile,
              checksum: hasil.checksum,
              cabangId,
              jumlahBaris: hasil.jumlahBaris,
              jumlahDitulis,
              jumlahJurnal: jurnalIds.length,
            },
            hasil: "SUKSES",
            keterangan: `impor ${jenis} ${jumlahDitulis} baris dari ${namaFile}`,
          },
          tx,
        );

        return {
          ok: true,
          hasil: {
            berkasId,
            jenis,
            namaFile,
            checksum: hasil.checksum,
            jumlahBaris: hasil.jumlahBaris,
            jumlahDitulis,
            jurnalIds,
            ...(ringkasanSaldoAwal ? { saldoAwal: ringkasanSaldoAwal } : {}),
          },
        };
      });
    },
  };
}
