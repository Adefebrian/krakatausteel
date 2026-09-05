// The personal-data promise, pinned with explicit fixtures.
//
// modules/ai/redaksi.ts states what this system will and will not send to a
// third-party model. A statement like that is worth exactly as much as the test
// under it, so both directions are asserted here:
//
//   NOTHING FORBIDDEN GOES OUT. A NIK, an NPWP, an e-mail, a phone number in
//   any of the three ways Indonesians write one, and any bare run of ten or
//   more digits.
//
//   NOTHING NEEDED IS DESTROYED. `1.000.000.000` is a billion rupiah, and it is
//   the single case that broke the first version of these patterns: a phone
//   regex that accepts a dot between groups matches it, and the Maker gets a
//   placeholder where the loan amount should be. Money, dates, names and
//   addresses survive the redactor untouched.
//
// No database, no network, no model. Pure functions with fixed inputs.
import { describe, expect, test } from "bun:test";
import {
  masihMengandungIdentitas,
  redaksiDokumen,
  rehidrasi,
} from "./redaksi";

describe("ai: redaksi data pribadi", () => {
  test("NIK, NPWP, email dan telepon tidak pernah ikut ke prompt", () => {
    const dokumen = [
      "PROPOSAL PINJAMAN PUMK",
      "Nama: Siti Rahayu",
      "NIK: 3671014509870002",
      "NPWP: 09.254.294.3-407.000",
      "Email: siti.rahayu@contoh.co.id",
      "HP: 0812-3456-7890",
      "Telp rumah: 021 5551234",
      "Rekening: 1234567890123",
    ].join("\n");

    const hasil = redaksiDokumen(dokumen);

    // The identifiers themselves are gone from the text that would be sent.
    expect(hasil.teks).not.toContain("3671014509870002");
    expect(hasil.teks).not.toContain("09.254.294.3-407.000");
    expect(hasil.teks).not.toContain("siti.rahayu@contoh.co.id");
    expect(hasil.teks).not.toContain("0812-3456-7890");
    expect(hasil.teks).not.toContain("021 5551234");
    expect(hasil.teks).not.toContain("1234567890123");

    // The final guard agrees: nothing forbidden survives.
    expect(masihMengandungIdentitas(hasil.teks)).toBe(false);

    // The name stays, because the name is the payload.
    expect(hasil.teks).toContain("Siti Rahayu");

    // And each class is counted, which is what gets persisted.
    expect(hasil.jumlah.NIK).toBe(1);
    expect(hasil.jumlah.NPWP).toBe(1);
    expect(hasil.jumlah.EMAIL).toBe(1);
    expect(hasil.jumlah.TELP).toBe(2);
  });

  test("jumlah rupiah besar TIDAK ikut teredaksi", () => {
    // THE CASE THAT MOTIVATED THE SEPARATOR RULE. A phone pattern that accepts
    // a dot between groups matches `1.000.000.000`, and the assistant then
    // proposes a placeholder as the loan amount.
    const dokumen = [
      "Jumlah diajukan: Rp 1.000.000.000",
      "Omzet bulanan: Rp 1.628.000.000",
      "Plafon lama: Rp 10.000.000",
      "Tanggal: 2026-09-05",
    ].join("\n");

    const hasil = redaksiDokumen(dokumen);

    expect(hasil.teks).toContain("Rp 1.000.000.000");
    expect(hasil.teks).toContain("Rp 1.628.000.000");
    expect(hasil.teks).toContain("Rp 10.000.000");
    expect(hasil.teks).toContain("2026-09-05");
    expect(hasil.jumlah).toEqual({});
  });

  test("nilai yang sama dapat placeholder yang sama, sekali saja", () => {
    const dokumen = "NIK 3671014509870002 diulang: 3671014509870002";
    const hasil = redaksiDokumen(dokumen);
    expect(hasil.jumlah.NIK).toBe(1);
    expect([...hasil.peta.values()]).toEqual(["3671014509870002"]);
    // Two occurrences, one placeholder: the model must not be told there are
    // two different people.
    const kemunculan = hasil.teks.split("[[NIK_1]]").length - 1;
    expect(kemunculan).toBe(2);
  });

  test("rehidrasi mengembalikan nilai asli ke jawaban model", () => {
    const hasil = redaksiDokumen("NIK: 3671014509870002, HP 081234567890");
    const jawabanModel = `{"nik":"[[NIK_1]]","telepon":"[[TELP_1]]"}`;
    const kembali = rehidrasi(jawabanModel, hasil.peta);
    expect(kembali).toContain("3671014509870002");
    expect(kembali).toContain("081234567890");
  });

  test("placeholder yang dikarang model dibiarkan apa adanya, tidak dikosongkan", () => {
    // A fabricated placeholder has to arrive on the screen visibly wrong. If
    // rehidrasi blanked it, a hallucination would look like an empty field,
    // which is indistinguishable from a document that simply did not say.
    const hasil = redaksiDokumen("NIK: 3671014509870002");
    const kembali = rehidrasi(`{"nik":"[[NIK_9]]"}`, hasil.peta);
    expect(kembali).toContain("[[NIK_9]]");
    expect(kembali).not.toContain("3671014509870002");
  });

  test("dokumen tanpa identitas tidak berubah sama sekali", () => {
    const dokumen =
      "Usaha warung kelontong di Jalan Merdeka No. 12, Cilegon. Tenor 24 bulan.";
    const hasil = redaksiDokumen(dokumen);
    expect(hasil.teks).toBe(dokumen);
    expect(hasil.peta.size).toBe(0);
  });
});
