// SCENARIO 6, verbatim: "Input tiga penerimaan angsuran: satu tepat jumlah,
// satu kurang, satu lebih. Konfirmasi alokasi ke pokok dan jasa benar, dan yang
// lebih masuk ke Kelebihan Pembayaran."
//
// Plus invariant 10: "Piutang tidak boleh negatif. Setoran melebihi kewajiban
// masuk ke akun Kelebihan Pembayaran Angsuran, bukan mengurangi piutang di
// bawah nol."
//
// THE THREE RECEIPTS ARE A SEQUENCE ON ONE AKAD, not three isolated cases.
// That is what the scenario describes and it is also where the interesting
// defects live: a short payment leaves arrears that change how the NEXT
// payment is allocated, and the surplus only exists once every obligation of
// the active version is met. Three independent fixtures would test three easy
// cases and miss the interaction.
//
//   akad     12.000.000 over 12 months, FLAT 3 percent, rounding 0
//            twelve rows of pokok 1.000.000,00 + jasa 30.000,00
//   total obligation 12.360.000,00
//
//   1  2026-03-10  1.030.000  EXACT   row 1 LUNAS
//   2  2026-04-10    500.000  SHORT   row 2 SEBAGIAN (jasa first, then pokok)
//   3  2026-05-10 11.000.000  OVER    everything settled, 170.000 left over
//
// WHAT THIS MODULE IS AND IS NOT RESPONSIBLE FOR.
// The waterfall itself is spec 7.2 and belongs to modules/angsuran, whose own
// tests pin it row by row. What THIS file pins is that the PUMK module
// DELEGATES rather than reimplements, that the akad and the ledger stay in
// step after every receipt, and that the surplus lands where invariant 10 says
// it lands. The allocation runs through `porterAngsuranUji`, a recording
// wrapper around the REAL engine: only the real engine writes a `pumk_kelebihan`
// row and only the real ledger engine posts the single combined journal of
// spec 7.2 step 8.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  jumlahUang,
  keSen,
  periksaRekonsiliasiNol,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  MULAI_ANGSURAN_BAKU,
  POKOK_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
  type ProposalFixture,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

const TEPAT = rp(1_030_000);
const KURANG = rp(500_000);
/** Everything still owed after receipts 1 and 2, plus 170.000 too much. */
const LEBIH = rp(11_000_000);
const SURPLUS = rp(170_000);

const TGL_1 = MULAI_ANGSURAN_BAKU; // 2026-03-10
const TGL_2 = "2026-04-10";
const TGL_3 = "2026-05-10";

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  angsuran = porterAngsuranUji(d.db, jurnal, d.jam);
  engine = createPumkEngine({ db: d.db, angsuran, jurnal, jam: d.jam });
}, 60_000);

beforeEach(async () => {
  jurnal.reset();
  angsuran.reset();
  // Spec 5.4's waterfall is configuration. Restored before each test so a
  // preset test cannot leak into the sequence tests.
  await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** A disbursed akad with a live 12-row schedule and a clean reconciliation. */
async function akadSiapAngsur(): Promise<ProposalFixture> {
  const f = await d.siapkanProposal("DICAIRKAN");
  periksaRekonsiliasiNol(await d.rekonsiliasi(f.akadId as string), POKOK_BAKU);
  return f;
}

function terima(akadId: string, tanggal: string, jumlah: string, noBukti: string) {
  return engine.terimaAngsuran(
    { akadId, tanggalTerima: tanggal, jumlah, akunKasId: d.akun.kas.id, noBukti },
    d.ctx.maker,
  );
}

// ---------------------------------------------------------------------------
// The three cases of scenario 6
// ---------------------------------------------------------------------------

describe("tiga penerimaan angsuran (skenario 6)", () => {
  test("setoran TEPAT JUMLAH melunasi satu baris dan tidak menyentuh baris berikutnya", async () => {
    const f = await akadSiapAngsur();
    const akadId = f.akadId as string;

    const hasil = await terima(akadId, TGL_1, TEPAT, "BKM-001");

    expect(hasil.jumlahDiterima).toBe(TEPAT);
    expect(hasil.alokasiPokok).toBe(rp(1_000_000));
    expect(hasil.alokasiJasa).toBe(rp(30_000));
    expect(hasil.alokasiKelebihan).toBe("0.00");
    expect(hasil.kelebihanId).toBeNull();
    // pumk_angsuran_alokasi_ck: the three parts sum to what was received.
    expect(jumlahUang(hasil.alokasiPokok, hasil.alokasiJasa, hasil.alokasiKelebihan)).toBe(TEPAT);

    const baris = await d.bacaJadwal(akadId);
    expect(baris[0].status).toBe("LUNAS");
    expect(baris[0].pokok_terbayar).toBe(rp(1_000_000));
    expect(baris[0].jasa_terbayar).toBe(rp(30_000));
    expect(baris[0].tanggal_lunas).toBe(TGL_1);
    // "Tepat" means exactly one row moved.
    expect(baris[1].pokok_terbayar).toBe("0.00");
    expect(baris[1].status).toBe("BELUM_JATUH_TEMPO");

    const akad = await d.bacaAkad(akadId);
    expect(akad.outstanding_pokok).toBe(rp(11_000_000));
    expect(akad.outstanding_jasa).toBe(rp(330_000));
    expect(akad.status).toBe("AKTIF");

    // Sub-ledger and buku besar moved TOGETHER. The receipt credits Piutang by
    // exactly the principal it allocated, so the difference stays zero.
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), rp(11_000_000));

    const setoran = await d.bacaAngsuran(akadId);
    expect(setoran).toHaveLength(1);
    expect(setoran[0].jumlah_diterima).toBe(TEPAT);
    expect(setoran[0].alokasi_pokok).toBe(rp(1_000_000));
    expect(setoran[0].alokasi_jasa).toBe(rp(30_000));
    expect(setoran[0].alokasi_kelebihan).toBe("0.00");
    // Spec 7.2 step 8: ONE journal for the whole receipt, however many
    // components moved.
    expect(setoran[0].jurnal_id).toBe(hasil.jurnalId);
  }, 30_000);

  test("setoran KURANG membayar jasa dulu lalu pokok, baris jadi SEBAGIAN, tanpa kelebihan", async () => {
    const f = await akadSiapAngsur();
    const akadId = f.akadId as string;
    await terima(akadId, TGL_1, TEPAT, "BKM-001");
    jurnal.reset();
    angsuran.reset();

    const hasil = await terima(akadId, TGL_2, KURANG, "BKM-002");

    // The DEFAULT preset walks jasa before pokok, so 500.000 covers row 2's
    // 30.000 of jasa and 470.000 of its principal. The ORDER is configuration
    // (spec 5.4), asserted as a mechanic further down; the SUM is arithmetic.
    expect(jumlahUang(hasil.alokasiPokok, hasil.alokasiJasa, hasil.alokasiKelebihan)).toBe(KURANG);
    expect(hasil.alokasiJasa).toBe(rp(30_000));
    expect(hasil.alokasiPokok).toBe(rp(470_000));
    // A short payment can never produce a surplus.
    expect(hasil.alokasiKelebihan).toBe("0.00");
    expect(hasil.kelebihanId).toBeNull();
    expect(await d.bacaKelebihan(akadId)).toHaveLength(0);

    const baris = await d.bacaJadwal(akadId);
    expect(baris[1].status).toBe("SEBAGIAN");
    expect(baris[1].pokok_terbayar).toBe(rp(470_000));
    expect(baris[1].jasa_terbayar).toBe(rp(30_000));
    expect(baris[1].tanggal_lunas).toBeNull();
    // Nothing spilled forward onto row 3.
    expect(baris[2].pokok_terbayar).toBe("0.00");

    const akad = await d.bacaAkad(akadId);
    expect(akad.outstanding_pokok).toBe(rp(10_530_000));
    expect(akad.outstanding_jasa).toBe(rp(300_000));
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), rp(10_530_000));
  }, 30_000);

  test("setoran LEBIH melunasi semua kewajiban dan sisanya masuk Kelebihan Pembayaran (invarian 10)", async () => {
    const f = await akadSiapAngsur();
    const akadId = f.akadId as string;
    await terima(akadId, TGL_1, TEPAT, "BKM-001");
    await terima(akadId, TGL_2, KURANG, "BKM-002");
    jurnal.reset();
    angsuran.reset();

    // 10.530.000 of principal and 300.000 of jasa are still owed: 10.830.000.
    // Paying 11.000.000 leaves 170.000 with nowhere legal to go.
    const hasil = await terima(akadId, TGL_3, LEBIH, "BKM-003");

    expect(hasil.alokasiPokok).toBe(rp(10_530_000));
    expect(hasil.alokasiJasa).toBe(rp(300_000));
    expect(hasil.alokasiKelebihan).toBe(SURPLUS);
    expect(jumlahUang(hasil.alokasiPokok, hasil.alokasiJasa, hasil.alokasiKelebihan)).toBe(LEBIH);

    // THE INVARIANT. Not "small", not "close to zero": exactly zero, and never
    // below it. `pumk_akad` has a CHECK for the same thing, and reaching that
    // CHECK would mean the surplus rule was skipped.
    const akad = await d.bacaAkad(akadId);
    expect(akad.outstanding_pokok).toBe("0.00");
    expect(akad.outstanding_jasa).toBe("0.00");
    expect(keSen(akad.outstanding_pokok) >= 0n).toBe(true);
    expect(akad.status).toBe("LUNAS");
    expect(akad.tanggal_lunas).toBe(TGL_3);

    // The surplus is a LIABILITY held for the mitra, not a negative asset.
    const kelebihan = await d.bacaKelebihan(akadId);
    expect(kelebihan).toHaveLength(1);
    expect(kelebihan[0].jumlah).toBe(SURPLUS);
    expect(kelebihan[0].status).toBe("TERTAHAN");
    expect(kelebihan[0].tanggal).toBe(TGL_3);
    expect(hasil.kelebihanId).toBe(kelebihan[0].id);
    // The same single journal carries the surplus leg.
    expect(kelebihan[0].jurnal_id_terima).toBe(hasil.jurnalId);

    const baris = await d.bacaJadwal(akadId);
    expect(baris.every((b) => b.status === "LUNAS")).toBe(true);
    const totalPokokTerbayar = baris.reduce((acc, b) => acc + keSen(b.pokok_terbayar), 0n);
    expect(totalPokokTerbayar).toBe(keSen(POKOK_BAKU));

    // A fully repaid loan reconciles at zero on both sides, and the surplus
    // sits in a different account so it cannot mask a receivable difference.
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
    expect(await d.akadTidakRekonsiliasi()).toHaveLength(0);
  }, 60_000);

  test("ketiga setoran berurutan: piutang turun monoton dan tidak pernah negatif", async () => {
    // The scenario as one story. Each step is checked against the LEDGER, so a
    // receipt that updated the akad without posting (or posted without
    // updating) is caught at the step that caused it rather than at the end.
    const f = await akadSiapAngsur();
    const akadId = f.akadId as string;

    const langkah: Array<[string, string, string]> = [
      [TGL_1, TEPAT, rp(11_000_000)],
      [TGL_2, KURANG, rp(10_530_000)],
      [TGL_3, LEBIH, "0.00"],
    ];
    let sebelumnya = keSen(POKOK_BAKU);
    for (const [tanggal, jumlah, sisaHarap] of langkah) {
      const hasil = await terima(akadId, tanggal, jumlah, `BKM-${tanggal}`);
      // Exactly one journal per receipt, always.
      expect(hasil.jurnalId).toBeTruthy();

      const akad = await d.bacaAkad(akadId);
      expect(akad.outstanding_pokok).toBe(sisaHarap);
      const sekarang = keSen(akad.outstanding_pokok);
      expect(sekarang <= sebelumnya).toBe(true);
      expect(sekarang >= 0n).toBe(true);
      sebelumnya = sekarang;

      periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), sisaHarap);
    }

    expect(await d.bacaAngsuran(akadId)).toHaveLength(3);
    expect(await d.bacaKelebihan(akadId)).toHaveLength(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Delegation and configuration
// ---------------------------------------------------------------------------

describe("modul PUMK mendelegasikan alokasi, tidak menghitungnya sendiri", () => {
  test("terimaAngsuran memanggil engine angsuran tepat sekali, dengan input yang diteruskan apa adanya", async () => {
    // Invariants 9 and 10 live in modules/angsuran. A second allocation
    // implementation here would be a second source of truth for how a rupiah
    // is split, and the two would diverge on the first rounding change.
    const f = await akadSiapAngsur();
    const akadId = f.akadId as string;
    await engine.terimaAngsuran(
      {
        akadId,
        tanggalTerima: TGL_1,
        jumlah: TEPAT,
        akunKasId: d.akun.kas.id,
        noBukti: "BKM-009",
        tanggalValuta: "2026-03-11",
        keterangan: "Setoran tunai",
      },
      d.ctx.maker,
    );
    expect(angsuran.panggilan).toHaveLength(1);
    expect(angsuran.panggilan[0].metode).toBe("alokasikanSetoran");
    expect(angsuran.panggilan[0].argumen).toEqual({
      akadId,
      tanggal: TGL_1,
      jumlah: TEPAT,
      akunKasId: d.akun.kas.id,
      noBukti: "BKM-009",
      tanggalValuta: "2026-03-11",
      keterangan: "Setoran tunai",
    });
  }, 30_000);

  test("urutan alokasi datang dari konfigurasi preset, bukan dari bentuk kode (spec 5.4)", async () => {
    // The MECHANIC, not the policy: `alokasi_setoran_preset` is a table and
    // `angsuran.urutan_alokasi_setoran_preset` picks the row set. Switching the
    // preset must visibly change how the same rupiah is split.
    const a = await akadSiapAngsur();
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const bawaan = await terima(a.akadId as string, TGL_1, KURANG, "BKM-D");
    expect(bawaan.urutanKomponenDipakai[0]).toBe("TUNGGAKAN_JASA");
    expect(bawaan.alokasiJasa).toBe(rp(30_000));
    expect(bawaan.alokasiPokok).toBe(rp(470_000));

    const b = await akadSiapAngsur();
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "POKOK_DULU");
    const pokokDulu = await terima(b.akadId as string, TGL_1, KURANG, "BKM-P");
    expect(pokokDulu.urutanKomponenDipakai[0]).toBe("TUNGGAKAN_POKOK");
    // Same date, same amount, same schedule: only the preset changed, and the
    // whole 500.000 now goes to principal.
    expect(pokokDulu.alokasiPokok).toBe(KURANG);
    expect(pokokDulu.alokasiJasa).toBe("0.00");
  }, 60_000);

  test("kegagalan engine angsuran membatalkan setoran dan tidak membocorkan teks trigger", async () => {
    const f = await akadSiapAngsur();
    const akadId = f.akadId as string;
    angsuran.gagalkan("alokasikanSetoran");

    const err = await tolakDengan(
      () => terima(akadId, TGL_1, TEPAT, "BKM-GAGAL"),
      KODE_PUMK.SETORAN_GAGAL,
    );
    expect(err.message).not.toContain("TJSL-JDW-001");

    expect(await d.bacaAngsuran(akadId)).toHaveLength(0);
    expect((await d.bacaAkad(akadId)).outstanding_pokok).toBe(POKOK_BAKU);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), POKOK_BAKU);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("penolakan penerimaan angsuran", () => {
  test("setoran atas akad yang belum cair ditolak, dan tidak ada jurnal yang terbentuk", async () => {
    // KODE_PUMK has no dedicated "akad belum bisa diangsur" code; the
    // instalment engine owns that judgement (AKAD_TIDAK_BISA_DIANGSUR) and this
    // module surfaces its refusal as SETORAN_GAGAL with the cause preserved for
    // the log. Reported as a gap rather than papered over with a new code
    // invented at a call site.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    await tolakDengan(
      () => terima(f.akadId as string, TGL_1, TEPAT, "BKM-X"),
      KODE_PUMK.SETORAN_GAGAL,
    );
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaAngsuran(f.akadId as string)).toHaveLength(0);
  });

  test("nilai setoran yang bukan desimal dua angka ditolak sebelum menyentuh ledger (invarian 7)", async () => {
    const f = await akadSiapAngsur();
    for (const salah of ["1030000", "1030000.5", "-1030000.00", "0.00"]) {
      await tolakDengan(
        () => terima(f.akadId as string, TGL_1, salah, "BKM-X"),
        KODE_PUMK.NILAI_BUKAN_DESIMAL,
      );
    }
    expect(angsuran.panggilan).toHaveLength(0);
  }, 30_000);

  test("akun kas yang bukan akun kas ditolak", async () => {
    const f = await akadSiapAngsur();
    await tolakDengan(
      () =>
        engine.terimaAngsuran(
          {
            akadId: f.akadId as string,
            tanggalTerima: TGL_1,
            jumlah: TEPAT,
            akunKasId: d.akun.piutangPokok.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.AKUN_KAS_TIDAK_VALID,
    );
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("akad yang tidak ada ditolak dengan AKAD_TIDAK_DITEMUKAN", async () => {
    await tolakDengan(
      () => terima("00000000-0000-4000-8000-000000000003", TGL_1, TEPAT, "BKM-X"),
      KODE_PUMK.AKAD_TIDAK_DITEMUKAN,
    );
  });
});
