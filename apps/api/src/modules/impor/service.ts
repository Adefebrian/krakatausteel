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
import {
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
  type PermintaanImpor,
  type Uang,
} from "./contract";
import { createImporRepo, type ImporRepo } from "./repo";
import type { QueryRunner } from "../../core/ports/db";

const PESAN: Readonly<Record<string, string>> = {
  JENIS_TIDAK_DIKENAL: "Jenis impor tidak dikenal.",
  BERKAS_KOSONG: "Berkas tidak berisi baris data apa pun.",
  BERKAS_TERLALU_BESAR: `Berkas melebihi ${Math.floor(MAKS_ISI_BYTE / 1024)} KB.`,
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
  }> {
    const jenis = permintaan.jenis;
    const isi = permintaan.berkas.isi ?? "";
    const ukuranBytes = new TextEncoder().encode(isi).length;
    if (ukuranBytes === 0) throw tolak("BERKAS_KOSONG");
    if (ukuranBytes > MAKS_ISI_BYTE) throw tolak("BERKAS_TERLALU_BESAR", { ukuranBytes });

    let parsed;
    try {
      parsed = parseCsv(isi);
    } catch (err) {
      if (err instanceof KesalahanCsv) throw tolak("BERKAS_KOSONG", { alasan: err.alasan });
      throw err;
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
    if (jenis === "MITRA" || jenis === "ANGSURAN") return jenis;
    throw tolak("JENIS_TIDAK_DIKENAL", { jenis });
  }

  return {
    async pratinjau(permintaan, ctx): Promise<HasilPratinjau> {
      wajibIzin(ctx, PERMISSION_IMPOR.UNGGAH);
      const jenis = jenisValid(permintaan.jenis);
      if (jenis === "MITRA") wajibIzin(ctx, PERMISSION_IMPOR.MITRA);
      const cabangId = await cabangTujuan(deps.db, permintaan, ctx);
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

        if (jenis === "MITRA") {
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
          },
        };
      });
    },
  };
}
