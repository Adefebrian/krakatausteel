// Spec 7.2 "Alokasi Setoran": the eight-step waterfall, in one transaction.
//
// THE FIXTURE, ONCE, FOR THE WHOLE FILE.
// Every test builds an akad of 12.000.000 over 12 months, FLAT at 3 percent,
// rounding 0, first due date 10 March 2026. That schedule is exactly twelve
// identical rows of pokok 1.000.000,00 + jasa 30.000,00 = 1.030.000,00, due on
// the 10th of each month through 10 February 2027, and the whole obligation is
// 12.000.000,00 + 360.000,00 = 12.360.000,00. Round numbers on purpose: the
// rounding rules are spec 7.1's problem and are tested there, and an allocation
// test whose expected values need arithmetic to check is a test nobody will
// trust when it fails.
//
// The schedule rows are written by the fixture, not by generateJadwal. Both
// engine surfaces are unimplemented right now, and a failure in this file has
// to mean "allocation is wrong", not "schedule generation is also missing".
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createAngsuranEngine,
  KODE_ANGSURAN,
  type AngsuranEngine,
  type KomponenAlokasi,
} from "./contract";
import {
  buatDunia,
  jumlahUang,
  porterJurnalUji,
  rp,
  tambahBulan,
  tolakDengan,
  type AkadFixture,
  type DuniaAngsuran,
  type PorterUji,
} from "./test-support";

let d: DuniaAngsuran;
let engine: AngsuranEngine;
let porter: PorterUji;

const POKOK_BARIS = rp(1_000_000);
const JASA_BARIS = rp(30_000);
const ANGSURAN_BARIS = rp(1_030_000);
const POKOK_AKAD = rp(12_000_000);
const JASA_AKAD = rp(360_000);
const TOTAL_KEWAJIBAN = rp(12_360_000);
const MULAI = "2026-03-10";
/** Due date of the twelfth and last row. */
const JATUH_TEMPO_TERAKHIR = "2027-02-10";

const URUTAN_DEFAULT: KomponenAlokasi[] = [
  "TUNGGAKAN_JASA",
  "TUNGGAKAN_POKOK",
  "JASA_BERJALAN",
  "POKOK_BERJALAN",
  "KELEBIHAN",
];
const URUTAN_POKOK_DULU: KomponenAlokasi[] = [
  "TUNGGAKAN_POKOK",
  "TUNGGAKAN_JASA",
  "POKOK_BERJALAN",
  "JASA_BERJALAN",
  "KELEBIHAN",
];

beforeAll(async () => {
  d = await buatDunia();
  porter = porterJurnalUji(d.db, d.jam);
  engine = createAngsuranEngine({ db: d.db, jurnal: porter, jam: d.jam });
});

beforeEach(() => {
  porter.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** An akad that is AKTIF, disbursed, and carrying the twelve-row schedule above. */
async function akadSiapAngsur(): Promise<AkadFixture> {
  const akad = await d.buatAkad({
    pokok: POKOK_AKAD,
    rate: "0.030000",
    metode: "FLAT",
    tenorBulan: 12,
    tanggalMulaiAngsuran: MULAI,
  });
  await d.cairkan(akad.id, POKOK_AKAD, JASA_AKAD);
  await d.pasangJadwal(
    akad.id,
    1,
    Array.from({ length: 12 }, (_, i) => ({
      angsuranKe: i + 1,
      tanggalJatuhTempo: tambahBulan(MULAI, i),
      pokok: POKOK_BARIS,
      jasaAdm: JASA_BARIS,
      saldoPokokSetelah: rp(12_000_000 - 1_000_000 * (i + 1)),
    })),
  );
  return akad;
}

describe("spec 7.2 alokasi setoran, langkah 1 sampai 7", () => {
  test("spec 7.2.4: setoran tepat sebesar satu angsuran melunasi tepat satu baris", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiPokok).toBe(POKOK_BARIS);
    expect(hasil.alokasiJasa).toBe(JASA_BARIS);
    expect(hasil.alokasiKelebihan).toBe("0.00");
    expect(hasil.rincian).toEqual([
      {
        jadwalId: expect.any(String),
        angsuranKe: 1,
        pokokDialokasikan: POKOK_BARIS,
        jasaDialokasikan: JASA_BARIS,
        statusSetelah: "LUNAS",
      },
    ]);

    // Step 4, read back from the table rather than trusted from the response.
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris[0].status).toBe("LUNAS");
    expect(baris[0].pokok_terbayar).toBe(POKOK_BARIS);
    expect(baris[0].jasa_terbayar).toBe(JASA_BARIS);
    expect(baris[0].tanggal_lunas).toBe(MULAI);
    // "Tepat satu baris": row 2 must be completely untouched.
    expect(baris[1].pokok_terbayar).toBe("0.00");
    expect(baris[1].jasa_terbayar).toBe("0.00");
    expect(baris[1].status).toBe("BELUM_JATUH_TEMPO");

    // Step 6.
    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.outstanding_pokok).toBe(rp(11_000_000));
    expect(akadDb.outstanding_jasa).toBe(rp(330_000));
    expect(akadDb.status).toBe("AKTIF");
    expect(akadDb.tanggal_lunas).toBeNull();
    expect(hasil.akadSetelah).toEqual({
      outstandingPokok: rp(11_000_000),
      outstandingJasa: rp(330_000),
      status: "AKTIF",
      tanggalLunas: null,
    });

    // The receipt itself (pumk_angsuran), whose CHECK requires the three
    // allocations to add back up to the amount received.
    const angsuran = await d.bacaAngsuran(akad.id);
    expect(angsuran.length).toBe(1);
    expect(angsuran[0].jumlah_diterima).toBe(ANGSURAN_BARIS);
    expect(angsuran[0].alokasi_pokok).toBe(POKOK_BARIS);
    expect(angsuran[0].alokasi_jasa).toBe(JASA_BARIS);
    expect(angsuran[0].alokasi_kelebihan).toBe("0.00");
    expect(angsuran[0].jurnal_id).toBe(hasil.jurnalId);
  });

  test("spec 7.2.4: setoran sebagian membuat baris SEBAGIAN dengan angka terbayar yang benar", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: rp(500_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    // DEFAULT preset: jasa of the arrears row first (30.000), then its pokok
    // (470.000). Nothing reaches row 2.
    expect(hasil.alokasiJasa).toBe(JASA_BARIS);
    expect(hasil.alokasiPokok).toBe(rp(470_000));
    expect(hasil.alokasiKelebihan).toBe("0.00");

    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris[0].status).toBe("SEBAGIAN");
    expect(baris[0].pokok_terbayar).toBe(rp(470_000));
    expect(baris[0].jasa_terbayar).toBe(JASA_BARIS);
    expect(baris[0].tanggal_lunas).toBeNull();
    expect(baris[1].status).toBe("BELUM_JATUH_TEMPO");

    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.outstanding_pokok).toBe(rp(11_530_000));
    expect(akadDb.outstanding_jasa).toBe(rp(330_000));
  });

  test("spec 7.2.2: tunggakan dihabiskan lebih dulu, komponen per komponen, lintas baris", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();

    // 10 April 2026: rows 1 and 2 are both due (tanggal_jatuh_tempo <= tanggal
    // setoran). 60.000 is exactly the jasa of BOTH arrears rows, and the
    // waterfall must exhaust TUNGGAKAN_JASA across every arrears row before it
    // touches TUNGGAKAN_POKOK on the first one.
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-10", jumlah: rp(60_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiJasa).toBe(rp(60_000));
    expect(hasil.alokasiPokok).toBe("0.00");
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris[0].jasa_terbayar).toBe(JASA_BARIS);
    expect(baris[0].pokok_terbayar).toBe("0.00");
    expect(baris[0].status).toBe("SEBAGIAN");
    expect(baris[1].jasa_terbayar).toBe(JASA_BARIS);
    expect(baris[1].pokok_terbayar).toBe("0.00");
    expect(baris[1].status).toBe("SEBAGIAN");
    expect(baris[2].jasa_terbayar).toBe("0.00");
  });

  test("spec 7.2.7: akad jadi LUNAS dengan tanggal_lunas saat kedua outstanding nol", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();

    const hasil = await engine.alokasikanSetoran(
      {
        akadId: akad.id,
        tanggal: JATUH_TEMPO_TERAKHIR,
        jumlah: TOTAL_KEWAJIBAN,
        akunKasId: d.akun.kas.id,
      },
      d.ctx.maker,
    );

    expect(hasil.alokasiPokok).toBe(POKOK_AKAD);
    expect(hasil.alokasiJasa).toBe(JASA_AKAD);
    expect(hasil.alokasiKelebihan).toBe("0.00");
    expect(hasil.kelebihanId).toBeNull();
    expect(hasil.rincian.length).toBe(12);

    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.outstanding_pokok).toBe("0.00");
    expect(akadDb.outstanding_jasa).toBe("0.00");
    expect(akadDb.status).toBe("LUNAS");
    expect(akadDb.tanggal_lunas).toBe(JATUH_TEMPO_TERAKHIR);
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris.every((b) => b.status === "LUNAS")).toBe(true);
    // Paid to the rupiah and no further: nothing spilled into kelebihan.
    expect(await d.bacaKelebihan(akad.id)).toEqual([]);
  });
});

describe("spec 7.2.3 urutan alokasi adalah konfigurasi, bukan kode", () => {
  test("spec 5.4: urutan yang dipakai diambil dari preset DEFAULT di alokasi_setoran_preset", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: rp(500_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    // The engine reports the waterfall it walked, and it must be the ROWS of
    // alokasi_setoran_preset in their `urutan`, not a list in the source.
    expect(hasil.urutanKomponenDipakai).toEqual(URUTAN_DEFAULT);
  });

  test("spec 5.4: preset POKOK_DULU mengubah hasil untuk setoran yang sama persis", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "POKOK_DULU");
    const akad = await akadSiapAngsur();

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: rp(500_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    // Same akad, same date, same 500.000 as the SEBAGIAN test above, opposite
    // split. This is the test that proves the order is data: if the waterfall
    // were hardcoded, both tests could not pass at once.
    expect(hasil.urutanKomponenDipakai).toEqual(URUTAN_POKOK_DULU);
    expect(hasil.alokasiPokok).toBe(rp(500_000));
    expect(hasil.alokasiJasa).toBe("0.00");
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris[0].pokok_terbayar).toBe(rp(500_000));
    expect(baris[0].jasa_terbayar).toBe("0.00");
    expect(baris[0].status).toBe("SEBAGIAN");
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
  });

  test("spec 5.4: preset yang tidak ada di tabel ditolak, tidak jatuh ke urutan bawaan", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "PRESET_KLIEN_BARU");
    const akad = await akadSiapAngsur();
    // Falling back to a built-in order here would silently allocate a real
    // payment by a rule nobody chose. Refuse instead.
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.PRESET_ALOKASI_TIDAK_DITEMUKAN,
    );
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
  });
});

describe("spec 7.2.5 kelebihan pembayaran, invarian 10", () => {
  test("invarian 10: setoran melebihi seluruh kewajiban masuk Kelebihan Pembayaran, piutang tidak negatif", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();

    // 12.500.000 against a 12.360.000 obligation: 140.000 has nowhere legal to
    // go except pumk_kelebihan.
    const hasil = await engine.alokasikanSetoran(
      {
        akadId: akad.id,
        tanggal: JATUH_TEMPO_TERAKHIR,
        jumlah: rp(12_500_000),
        akunKasId: d.akun.kas.id,
      },
      d.ctx.maker,
    );

    expect(hasil.alokasiPokok).toBe(POKOK_AKAD);
    expect(hasil.alokasiJasa).toBe(JASA_AKAD);
    expect(hasil.alokasiKelebihan).toBe(rp(140_000));
    expect(jumlahUang(hasil.alokasiPokok, hasil.alokasiJasa, hasil.alokasiKelebihan)).toBe(
      rp(12_500_000),
    );

    const kelebihan = await d.bacaKelebihan(akad.id);
    expect(kelebihan.length).toBe(1);
    expect(hasil.kelebihanId).toBe(kelebihan[0].id);
    expect(kelebihan[0].jumlah).toBe(rp(140_000));
    expect(kelebihan[0].status).toBe("TERTAHAN");
    expect(kelebihan[0].tanggal).toBe(JATUH_TEMPO_TERAKHIR);
    expect(kelebihan[0].jurnal_id_terima).toBe(hasil.jurnalId);

    // The receivable stopped at zero. `outstanding_pokok >= 0` is also a CHECK,
    // so the point of this assertion is that the engine got there by design
    // rather than by the database refusing the UPDATE.
    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.outstanding_pokok).toBe("0.00");
    expect(akadDb.outstanding_jasa).toBe("0.00");
    expect(akadDb.status).toBe("LUNAS");
  });

  test("spec 7.2: tidak ada baris jadwal yang terbayar melebihi nilainya sendiri", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();
    await engine.alokasikanSetoran(
      {
        akadId: akad.id,
        tanggal: JATUH_TEMPO_TERAKHIR,
        jumlah: rp(20_000_000),
        akunKasId: d.akun.kas.id,
      },
      d.ctx.maker,
    );
    // pumk_jadwal_terbayar_ck says the same thing in SQL; asserted here because
    // an engine that leans on the CHECK produces a driver error, not a receipt.
    const baris = await d.bacaJadwal(akad.id, 1);
    for (const b of baris) {
      expect(b.pokok_terbayar).toBe(b.pokok);
      expect(b.jasa_terbayar).toBe(b.jasa_adm);
    }
    const kelebihan = await d.bacaKelebihan(akad.id);
    expect(kelebihan[0].jumlah).toBe(rp(7_640_000));
  });
});

describe("spec 7.2.8 satu jurnal, beberapa baris", () => {
  test("spec 7.2.8: pokok, jasa dan kelebihan masuk SATU jurnal, bukan tiga jurnal terpisah", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();

    const hasil = await engine.alokasikanSetoran(
      {
        akadId: akad.id,
        tanggal: JATUH_TEMPO_TERAKHIR,
        jumlah: rp(12_500_000),
        akunKasId: d.akun.kas.id,
      },
      d.ctx.maker,
    );

    // ONE posting call carrying every component. Three calls would be three
    // journals, which is what spec 7.2 step 8 forbids in as many words.
    expect(porter.panggilan.length).toBe(1);
    const panggilan = porter.panggilan[0];
    expect(panggilan.komponen.length).toBe(3);
    expect(panggilan.tanggalTransaksi).toBe(JATUH_TEMPO_TERAKHIR);
    expect(panggilan.cabangId).toBe(d.cabangId);
    expect(panggilan.akunKasId).toBe(d.akun.kas.id);
    expect(panggilan.referensiId).toBe(hasil.angsuranId);

    const perEvent = new Map(panggilan.komponen.map((k) => [k.eventCode, k]));
    expect(perEvent.get("ANGSURAN_POKOK")?.nilai).toBe(POKOK_AKAD);
    expect(perEvent.get("TERIMA_KELEBIHAN_ANGSURAN")?.nilai).toBe(rp(140_000));
    // WHICH jasa event applies (ANGSURAN_JASA_ADM against income, or
    // ANGSURAN_JASA_ADM_AKRUAL against Piutang Jasa Administrasi) follows from
    // konfigurasi akuntansi.metode_pengakuan_jasa_adm and the accrual engine of
    // spec 8.3, which is Fase 3 and another agent's scope. This test therefore
    // pins the AMOUNT and that there is exactly one jasa leg, and deliberately
    // does not pin the choice.
    const kakiJasa = panggilan.komponen.filter((k) => k.eventCode.startsWith("ANGSURAN_JASA_ADM"));
    expect(kakiJasa.length).toBe(1);
    expect(kakiJasa[0].nilai).toBe(JASA_AKAD);

    // Invariant 11 lives on the other side of this port: the ACCOUNTS come from
    // event_jurnal_mapping, so what this engine may pass is an event code and a
    // sub-ledger dimension, never an account id.
    expect(perEvent.get("ANGSURAN_POKOK")?.akadId).toBe(akad.id);
    expect(perEvent.get("ANGSURAN_POKOK")?.mitraId).toBe(akad.mitraId);

    // ...and ONLY on that component. The sub-ledger dimension belongs to the
    // receivable, so tagging the jasa or kelebihan component with it makes the
    // journal engine refuse the whole posting with DIMENSI_PIUTANG_SALAH_AKUN
    // (spec 6.2 validation 8), which rolls back the allocation. This is asserted
    // explicitly rather than left implied, because an earlier version of the
    // engine did tag all three and the suite could not see it: the fixture used
    // to stub the journal engine out, and a stub does not validate dimensions.
    for (const k of panggilan.komponen) {
      if (k.eventCode === "ANGSURAN_POKOK") continue;
      expect(k.akadId ?? null).toBeNull();
      expect(k.mitraId ?? null).toBeNull();
    }

    // The same rule, one level down, on the rows that actually reached the
    // ledger. Spec 8.4 check 10 sums jurnal_baris per akad_id, so a dimension on
    // the cash leg would net the two legs of every deposit to zero and the
    // piutang reconciliation would read as permanently balanced.
    const [angsuran] = await d.bacaAngsuran(akad.id);
    expect(angsuran.jurnal_id).not.toBeNull();
    const baris = await d.db.query<{ akun_id: string; akad_id: string | null; mitra_id: string | null }>(
      `select akun_id, akad_id, mitra_id from jurnal_baris
        where jurnal_id = $1 and deleted_at is null order by urutan`,
      [angsuran.jurnal_id],
    );
    // Four lines, not six: one cash receipt against piutang, pendapatan jasa
    // and kelebihan, because legs that agree are merged.
    expect(baris.length).toBe(4);
    const berdimensi = baris.filter((b) => b.akad_id !== null);
    expect(berdimensi.length).toBe(1);
    expect(berdimensi[0].akad_id).toBe(akad.id);
    expect(berdimensi[0].mitra_id).toBe(akad.mitraId);
    expect(berdimensi[0].akun_id).toBe(d.akun.piutangPokok.id);
    for (const b of baris) {
      if (b.akad_id !== null) continue;
      expect(b.mitra_id).toBeNull();
    }
  });

  test("spec 7.2: setoran yang hanya menyentuh satu komponen tetap satu jurnal", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "POKOK_DULU");
    const akad = await akadSiapAngsur();
    await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: rp(100_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    expect(porter.panggilan.length).toBe(1);
    expect(porter.panggilan[0].komponen.map((k) => k.eventCode)).toEqual(["ANGSURAN_POKOK"]);
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
  });
});

describe("spec 7.2 satu transaksi database", () => {
  test("spec 7.2: kalau jurnal gagal, seluruh alokasi rollback dan tidak ada yang setengah jadi", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();
    porter.gagalkan();

    const err = await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.JURNAL_GAGAL,
    );
    // The double throws a string shaped like a raw Postgres trigger message.
    // tolakDengan already asserts it did not reach `message`; this asserts it
    // was kept where a log can still use it.
    expect(err.penyebabDb ?? "").toContain("TJSL-JRN-031");

    // Nothing applied: no receipt, no row progress, no outstanding movement,
    // no kelebihan. "Kalau jurnal gagal, alokasi harus rollback."
    expect(await d.bacaAngsuran(akad.id)).toEqual([]);
    expect(await d.bacaKelebihan(akad.id)).toEqual([]);
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris.length).toBe(12);
    for (const b of baris) {
      expect(b.pokok_terbayar).toBe("0.00");
      expect(b.jasa_terbayar).toBe("0.00");
      expect(b.status).toBe("BELUM_JATUH_TEMPO");
      expect(b.tanggal_lunas).toBeNull();
    }
    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.outstanding_pokok).toBe(POKOK_AKAD);
    expect(akadDb.outstanding_jasa).toBe(JASA_AKAD);
    expect(akadDb.status).toBe("AKTIF");
    expect(akadDb.tanggal_lunas).toBeNull();
  });

  test("spec 7.2: setoran berikutnya setelah rollback tetap bisa diproses normal", async () => {
    await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
    const akad = await akadSiapAngsur();
    porter.gagalkan();
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.JURNAL_GAGAL,
    );
    porter.reset();

    // A failed allocation must not poison the akad: no half-written version, no
    // stuck lock, no consumed receipt number.
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    expect(hasil.alokasiPokok).toBe(POKOK_BARIS);
    expect((await d.bacaAngsuran(akad.id)).length).toBe(1);
  });
});

describe("spec 7.2 penjagaan alokasi setoran", () => {
  test("spec 7.2: setoran nol ditolak", async () => {
    const akad = await akadSiapAngsur();
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: "0.00", akunKasId: d.akun.kas.id },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.SETORAN_TIDAK_POSITIF,
    );
    // pumk_angsuran.jumlah_diterima > 0 is a CHECK; the engine owes the clean
    // error before the driver produces its own.
    expect(await d.bacaAngsuran(akad.id)).toEqual([]);
  });

  test("spec 7.2: nilai setoran yang bukan desimal dua digit ditolak", async () => {
    const akad = await akadSiapAngsur();
    // A `number` that leaked through a JSON body and got stringified, which is
    // exactly the shape of the float bug invariant 7 exists to prevent.
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: "1030000", akunKasId: d.akun.kas.id },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.NILAI_BUKAN_DESIMAL,
    );
  });

  test("spec 7.2: akad tanpa jadwal aktif ditolak", async () => {
    const akad = await d.buatAkad({
      pokok: POKOK_AKAD,
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: MULAI,
    });
    await d.cairkan(akad.id, POKOK_AKAD, JASA_AKAD);
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.JADWAL_TIDAK_DITEMUKAN,
    );
  });

  test("spec 2: user tanpa permission pumk.angsuran tidak boleh mengalokasikan setoran", async () => {
    const akad = await akadSiapAngsur();
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.auditor,
      ),
      KODE_ANGSURAN.TIDAK_BERWENANG,
    );
    expect(porter.panggilan.length).toBe(0);
  });

  test("spec 2.3: setoran untuk akad di luar scope cabang user ditolak", async () => {
    const akad = await akadSiapAngsur();
    await tolakDengan(
      engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        // Has pumk.angsuran, so the only thing that can stop this call is the
        // branch scope; using a user without the permission would prove nothing.
        d.ctx.makerCabangLain,
      ),
      KODE_ANGSURAN.CABANG_DILUAR_SCOPE,
    );
  });
});
