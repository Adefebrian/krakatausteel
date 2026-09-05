// The three rules that decide whether one module may re-raise another's
// refusal, pinned one by one.
//
// This file is the unit half. The end-to-end half is in
// ../penerimaan/spec16.test.ts scenario 13 (a receipt back-dated into a CLOSED
// period, refused through two layers of wrapping and still arriving with
// `PERIODE_TIDAK_OPEN`) and in ../modules/pumk/pumk-rute-alur.test.ts.
import { describe, expect, test } from "bun:test";
import { KODE_KE_HTTP, NAMA_ERROR_BERKODE, httpUntukKodeDomain } from "./http";
import { penyebabTeks, sebabYangBolehLolos } from "./sebab-kolaborator";

/** Stands in for any module's error class. The NAME is what the registry keys on. */
function berkode(name: string, kode: string, penyebabDb?: string): Error {
  const err = new Error(`pesan katalog untuk ${kode}`) as Error & {
    kode: string;
    penyebabDb?: string;
  };
  err.name = name;
  err.kode = kode;
  if (penyebabDb !== undefined) err.penyebabDb = penyebabDb;
  return err;
}

describe("apa yang boleh lolos", () => {
  test("PERIODE_TIDAK_OPEN lolos utuh: inilah cacat yang ditutup berkas ini", () => {
    const asli = berkode("JurnalError", "PERIODE_TIDAK_OPEN", "TJSL-JRN-002: ...");
    const lolos = sebabYangBolehLolos(asli);
    // The SAME object, not a copy: the code, the catalogue message and the
    // server-log cause all travel together.
    expect(lolos).toBe(asli as never);
    expect(lolos?.kode).toBe("PERIODE_TIDAK_OPEN");
    expect(lolos?.penyebabDb).toBe("TJSL-JRN-002: ...");
  });

  test("penolakan lain yang punya langkah berikutnya untuk operator ikut lolos", () => {
    for (const kode of [
      // No open period at all, so a reversal cannot even be dated.
      "TIDAK_ADA_PERIODE_OPEN",
      // The account mapping is incomplete: an accountant's next action.
      "EVENT_MAPPING_TIDAK_DITEMUKAN",
      "EVENT_MAPPING_BELUM_ADA",
      // Already posted, so a retry adds nothing. Invariant 13.
      "JURNAL_IDEMPOTENSI_DUPLIKAT",
      // Another request is holding the row: reload and look.
      "POSTING_BENTROK",
      // Policy says form the allowance before writing the loan off.
      "PENYISIHAN_TIDAK_CUKUP",
      // The system is not configured, and no rewriting of the form helps.
      "KONFIGURASI_TIDAK_ADA",
      "KONFIGURASI_TIDAK_VALID",
      "KEBIJAKAN_BELUM_DIPUTUSKAN",
    ]) {
      expect([kode, sebabYangBolehLolos(berkode("JurnalError", kode))?.kode ?? null]).toEqual([
        kode,
        kode,
      ]);
    }
  });
});

describe("aturan 1: arti HTTP yang menjawab soal identitas tidak boleh lolos", () => {
  test("CABANG_DILUAR_SCOPE tertahan, karena itu justru orakel yang dijaga lingkup cabang", () => {
    // `assertCabangAllowed` refuses without naming the row's branch so a 403
    // does not become a way to enumerate another branch's data. Letting it out
    // through an OUTER module rebuilds that oracle one level up: the caller
    // asked about a receipt and would learn from the status alone that the akad
    // it names is real and belongs to somebody else.
    expect(sebabYangBolehLolos(berkode("PumkError", "CABANG_DILUAR_SCOPE"))).toBeNull();
    expect(httpUntukKodeDomain("CABANG_DILUAR_SCOPE")).toBe("TIDAK_BERWENANG");
  });

  test("wewenang, segregasi tugas dan 'tidak ditemukan' tertahan", () => {
    for (const kode of [
      "TIDAK_BERWENANG",
      "IZIN_BELUM_TERDAFTAR",
      "MAKER_TIDAK_BOLEH_CHECKER",
      "APPROVER_TIDAK_BOLEH_MAKER",
      "JURNAL_TIDAK_DITEMUKAN",
      "AKAD_TIDAK_DITEMUKAN",
      "JADWAL_TIDAK_DITEMUKAN",
    ]) {
      expect([kode, sebabYangBolehLolos(berkode("AngsuranError", kode))]).toEqual([kode, null]);
    }
  });

  test("aturannya diturunkan dari tabel HTTP, bukan dari daftar kedua yang harus diingat", () => {
    // Every code core/http.ts maps to an identity answer is blocked, whichever
    // module it came from. A code added to that table is classified by the line
    // that already decides its status.
    const identitas = ["TIDAK_BERWENANG", "SEGREGASI_TUGAS", "TIDAK_DITEMUKAN", "TIDAK_TERAUTENTIKASI"];
    const bocor = Object.keys(KODE_KE_HTTP)
      .filter((kode) => identitas.includes(httpUntukKodeDomain(kode)))
      .filter((kode) => sebabYangBolehLolos(berkode("JurnalError", kode)) !== null);
    expect(bocor).toEqual([]);
  });
});

describe("aturan 2: kesalahan bentuk dokumen yang tidak pernah diketik pemanggil tertahan", () => {
  test("validasi bentuk jurnal tidak boleh sampai ke petugas yang mengetik kuitansi", () => {
    // These are correct and specific and useful to whoever CALLED the ledger
    // with a malformed journal, and that caller is a business module, not a
    // person. "Jumlah debit dan jumlah kredit harus sama persis" told to a
    // clerk blames them for arithmetic they did not do and cannot reach.
    for (const kode of [
      "MINIMAL_DUA_BARIS",
      "SATU_SISI_PER_BARIS",
      "NILAI_NEGATIF",
      "TIDAK_BALANCE",
      "NILAI_BUKAN_DESIMAL",
      "DIMENSI_PIUTANG_SALAH_AKUN",
      "NOMOR_JURNAL_DUPLIKAT",
      "EVENT_PAYLOAD_TIDAK_LENGKAP",
      "KAS_BANK_TANPA_AKUN_KAS",
      "PINBUK_AKUN_SALAH",
      "PINBUK_TANPA_TAUTAN",
      "PINBUK_KATEGORI_TIDAK_VALID",
      "BATCH_GAGAL",
      "PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR",
    ]) {
      expect([kode, sebabYangBolehLolos(berkode("JurnalError", kode))]).toEqual([kode, null]);
    }
  });
});

describe("aturan 3: kode pembungkus tidak boleh lolos", () => {
  test("mengganti satu 409 anonim dengan 409 anonim lain bukan kemajuan", () => {
    for (const kode of ["JURNAL_GAGAL", "SETORAN_GAGAL", "JADWAL_GAGAL"]) {
      expect([kode, sebabYangBolehLolos(berkode("AngsuranError", kode))]).toEqual([kode, null]);
    }
  });
});

describe("apa yang bukan penolakan domain sama sekali", () => {
  test("kelas error yang tidak terdaftar tidak pernah lolos, meski punya field kode", () => {
    // The same allowlist core/http.ts matches on. Without it, an unrelated
    // library error that happens to carry a `kode` would be re-raised to a
    // caller as a business refusal.
    expect(NAMA_ERROR_BERKODE.has("PustakaAcakError")).toBe(false);
    expect(sebabYangBolehLolos(berkode("PustakaAcakError", "PERIODE_TIDAK_OPEN"))).toBeNull();
  });

  test("error driver mentah, string, dan null tidak lolos", () => {
    const driver = new Error("connection terminated unexpectedly") as Error & { code: string };
    driver.code = "57P01";
    expect(sebabYangBolehLolos(driver)).toBeNull();
    expect(sebabYangBolehLolos("gagal")).toBeNull();
    expect(sebabYangBolehLolos(null)).toBeNull();
    // A registered class with no `kode` at all is not a coded refusal either.
    const tanpaKode = new Error("apa saja");
    tanpaKode.name = "JurnalError";
    expect(sebabYangBolehLolos(tanpaKode)).toBeNull();
  });

  test("penyebabTeks mengambil pesan dari apa pun, untuk log saja", () => {
    expect(penyebabTeks(new Error("TJSL-JRN-031: tidak balance"))).toBe(
      "TJSL-JRN-031: tidak balance",
    );
    expect(penyebabTeks("teks polos")).toBe("teks polos");
  });
});
