// The fixture, tested before anything is tested THROUGH the fixture.
//
// A tests-first suite is only worth its red as long as every red means "the
// engine is missing". These tests pin the other half: that the world builds,
// that the arrears this fixture manufactures are the arrears it claims, that
// the two ledger readings really do diverge on a reversal (so the ADR 0010
// test cannot pass vacuously), and that the shipped catalogues carry what the
// engine will read. They pass TODAY, against an unimplemented engine, and if
// one of them ever goes red the failure is in the scaffolding, not in spec 8.
//
// Two of them are deliberate FINDINGS and are red on purpose. They are marked
// TEMUAN and each says what is missing and why inventing it here would be
// worse than leaving the test red.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canonicalPermission } from "../auth";
import {
  EVENT_CLOSING,
  KUNCI_KONFIGURASI_CLOSING,
  PERMISSION_CLOSING,
  POLA_RATE,
  POLA_UANG,
} from "./contract";
import { JurnalError } from "../jurnal/index";
import {
  buatDunia,
  kaliRate,
  keSen,
  rp,
  selisihHari,
  tambahHari,
  type DuniaClosing,
} from "./test-support";

let d: DuniaClosing;

beforeAll(async () => {
  d = await buatDunia();
});
afterAll(async () => {
  await d?.tutup();
});

describe("fixture closing: dunia", () => {
  test("dunia punya periode bulanan berurutan, semuanya OPEN, mulai dari yang paling awal", async () => {
    const p1 = d.periode(2026, 1);
    expect(p1.tanggalMulai).toBe("2026-01-01");
    expect(p1.tanggalAkhir).toBe("2026-01-31");
    const feb = d.periode(2026, 2);
    expect(feb.tanggalAkhir).toBe("2026-02-28");
    // 2026-01 being the EARLIEST period of this bumn is what makes closing it
    // legal at all: invariant 6 has nothing earlier to complain about.
    const lebihAwal = await d.db.query<{ n: string }>(
      `select count(*)::text as n from periode
        where bumn_id = $1 and (tahun, bulan) < (2026, 1)`,
      [d.bumnId],
    );
    expect(lebihAwal[0]?.n).toBe("0");
    expect((await d.bacaPeriode(p1.id)).status).toBe("OPEN");
  });

  test("konteks memakai izin dari katalog terkirim, bukan literal di fixture", () => {
    // If this ever passes because someone typed the strings into the fixture,
    // the two findings that this mechanism caught (`pumk.cluster`,
    // `nonpumk.lpj.verifikasi`) become invisible again.
    expect(d.ctx.approver.permissions).toContain(PERMISSION_CLOSING.KOLEKTIBILITAS);
    expect(d.ctx.approver.permissions).toContain(PERMISSION_CLOSING.PERIODE);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_CLOSING.PERIODE);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_CLOSING.PERIODE);
    // spec 2: reopen is Admin Pusat only, and the shipped matrix agrees.
    expect(d.ctx.adminPusat.permissions).toContain(PERMISSION_CLOSING.REOPEN);
    expect(d.ctx.approver.permissions).not.toContain(PERMISSION_CLOSING.REOPEN);
    expect(d.ctx.adminCabang.permissions).not.toContain(PERMISSION_CLOSING.REOPEN);
    // spec 2: the Auditor changes nothing.
    expect(d.ctx.auditor.permissions).not.toContain(PERMISSION_CLOSING.KOLEKTIBILITAS);
    expect(d.ctx.auditor.permissions).not.toContain(PERMISSION_CLOSING.PERIODE);
  });

  test("setiap event yang akan diposting closing sudah ada mapping aktifnya", async () => {
    for (const kode of Object.values(EVENT_CLOSING)) {
      const baris = await d.db.query<{ n: string }>(
        `select count(*)::text as n from event_jurnal_mapping
          where bumn_id = $1 and event_code = $2 and aktif and deleted_at is null`,
        [d.bumnId, kode],
      );
      expect(`${kode}:${baris[0]?.n}`).toBe(`${kode}:1`);
    }
  });

  test("setiap kunci konfigurasi yang dibaca closing punya baris di dunia ini", async () => {
    for (const { grup, kunci } of Object.values(KUNCI_KONFIGURASI_CLOSING)) {
      const nilai = await d.bacaKonfigurasi(grup, kunci);
      expect(`${grup}.${kunci}=${nilai === null ? "TIDAK ADA" : "ada"}`).toBe(
        `${grup}.${kunci}=ada`,
      );
    }
  });

  test("rentang hari dan rate penyisihan adalah DATA per bumn, bisa dibaca dan diubah", async () => {
    const rate = await d.bacaRate("MACET");
    expect(rate).toMatch(POLA_RATE);
    // Deliberately NOT the spec's 1.000000: a fixture that seeded the spec's
    // table would let an implementation with those numbers hardcoded pass
    // every rate test in this folder. See RATE_AWAL in test-support.ts.
    expect(rate).not.toBe("1.000000");

    await d.setelRate("MACET", "0.910000");
    expect(await d.bacaRate("MACET")).toBe("0.910000");
    await d.setelRate("MACET", rate);

    const rentang = await d.db.query<{ kelas_kode: string; hari_min: number; hari_max: number | null }>(
      `select kelas_kode, hari_min, hari_max from kolektibilitas_range
        where bumn_id = $1 and deleted_at is null order by hari_min`,
      [d.bumnId],
    );
    expect(rentang.map((r) => r.kelas_kode)).toEqual([
      "LANCAR",
      "KURANG_LANCAR",
      "DIRAGUKAN",
      "MACET",
    ]);
    expect(rentang.at(-1)?.hari_max).toBeNull();
  });

  test("kaliRate membulatkan sama seperti CHECK di kolektibilitas_snapshot", async () => {
    // The fixture's arithmetic and the database's `round(x * rate, 2)` must
    // agree to the sen, or every penyisihan expectation in this folder would be
    // asserting the fixture's opinion against the schema's.
    const kasus: Array<[string, string]> = [
      [rp(12_000_000), "0.850000"],
      ["1234567.89", "0.370000"],
      ["999999.99", "0.620000"],
      ["1.01", "0.005000"],
    ];
    for (const [nilai, rate] of kasus) {
      const baris = await d.db.query<{ hasil: string }>(
        `select round($1::numeric(20,2) * $2::numeric(9,6), 2)::text as hasil`,
        [nilai, rate],
      );
      expect(`${nilai}*${rate}=${kaliRate(nilai, rate)}`).toBe(
        `${nilai}*${rate}=${baris[0]?.hasil}`,
      );
    }
  });
});

describe("fixture closing: akad dan tunggakan", () => {
  test("hariTunggakan n menaruh baris jatuh tempo terlama tepat n hari sebelum akhir periode", async () => {
    const p = d.periode(2027, 6);
    const akad = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    const jadwal = await d.bacaJadwal(akad.akadId);

    expect(jadwal).toHaveLength(12);
    expect(jadwal[0].tanggal_jatuh_tempo).toBe(akad.tanggalMulaiAngsuran);
    expect(selisihHari(jadwal[0].tanggal_jatuh_tempo, p.tanggalAkhir)).toBe(45);

    // The oldest unpaid row that is already due at period end is row 1, which
    // is what spec 8.1 step 2 asks for and what makes `hari_tunggakan` exactly
    // the number this fixture was asked for.
    const terlama = jadwal.find(
      (r) => r.tanggal_jatuh_tempo <= p.tanggalAkhir && r.status !== "LUNAS",
    );
    expect(terlama?.angsuran_ke).toBe(1);
  });

  test("hariTunggakan null berarti belum ada baris yang jatuh tempo di akhir periode", async () => {
    const p = d.periode(2027, 6);
    const akad = await d.buatAkad({ hariTunggakan: null, padaTanggal: p.tanggalAkhir });
    const jadwal = await d.bacaJadwal(akad.akadId);
    const jatuhTempo = jadwal.filter((r) => r.tanggal_jatuh_tempo <= p.tanggalAkhir);
    expect(jatuhTempo).toHaveLength(0);
  });

  test("akad yang dicairkan lewat engine nyata langsung rekonsiliasi nol", async () => {
    const p = d.periode(2027, 6);
    const akad = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    const r = await d.rekonsiliasi(akad.akadId);
    expect(r.saldoSubLedger).toBe(akad.pokok);
    expect(r.saldoBukuBesar).toBe(akad.pokok);
    // spec 8.4 check 10, the reconciliation the spec calls the most important
    // in the whole system. It starts at zero or no closing test means anything.
    expect(r.selisih).toBe("0.00");
    expect((await d.bacaAkad(akad.akadId)).status).toBe("AKTIF");
  });

  test("akad janganCairkan tetap BELUM_CAIR: di luar populasi spec 8.1 langkah 1", async () => {
    const p = d.periode(2027, 6);
    const akad = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      janganCairkan: true,
    });
    const row = await d.bacaAkad(akad.akadId);
    expect(row.status).toBe("BELUM_CAIR");
    expect(row.outstanding_pokok).toBe("0.00");
    expect(akad.jurnalPencairanId).toBeNull();
    // ...and it still has a schedule, so activating it later gives it a real
    // arrears history without a second generation.
    expect(await d.bacaJadwal(akad.akadId)).toHaveLength(12);
  });

  test("melunasi seluruh tunggakan lewat engine angsuran nyata membuat hari tunggakan jatuh ke nol", async () => {
    const p = d.periode(2027, 6);
    const akad = await d.buatAkad({
      hariTunggakan: 100,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    // Four rows are already due at 100 days of arrears (E-100, E-70, E-40,
    // E-10). `totalJadwalSampai(3)` would NOT clear them: the allocation pays
    // the jasa of every overdue row before any pokok (spec 5.4), so the third
    // row would end SEBAGIAN and the akad would still be in arrears. This is
    // the figure that actually clears them.
    const tanggalBayar = tambahHari(p.tanggalAkhir, -5);
    const tertunggak = await d.totalTertunggak(akad.akadId, p.tanggalAkhir);
    expect(tertunggak).toMatch(POLA_UANG);
    expect(tertunggak).not.toBe(await d.totalJadwalSampai(akad.akadId, 3));

    d.setelJam(tanggalBayar);
    await d.bayarSetoran(akad.akadId, tanggalBayar, tertunggak);

    const jadwal = await d.bacaJadwal(akad.akadId);
    const masihTertunggak = jadwal.filter(
      (r) => r.tanggal_jatuh_tempo <= p.tanggalAkhir && r.status !== "LUNAS",
    );
    expect(masihTertunggak).toHaveLength(0);
    expect((await d.rekonsiliasi(akad.akadId)).selisih).toBe("0.00");
  });
});

describe("fixture closing: dua pembacaan ledger yang tidak boleh tertukar", () => {
  test("tanpa reversal kedua predikat setuju; SETELAH reversal keduanya berbeda", async () => {
    const p = d.periode(2027, 11);
    const tanggal = `${p.tanggalMulai.slice(0, 8)}10`;
    d.setelJam(tanggal);

    const sebelumBenar = await d.saldoLedger(d.akun.bebanOperasional.id, p.tanggalAkhir);
    const sebelumNaif = await d.saldoLedgerNaifPostedSaja(
      d.akun.bebanOperasional.id,
      p.tanggalAkhir,
    );
    expect(sebelumBenar).toBe(sebelumNaif);

    const j = await d.postingBebanOperasional(tanggal, rp(5_000_000));
    await d.reversalJurnal(j.id, "Koreksi (fixture): salah akun beban");

    const benar = await d.saldoLedger(d.akun.bebanOperasional.id, p.tanggalAkhir);
    const naif = await d.saldoLedgerNaifPostedSaja(d.akun.bebanOperasional.id, p.tanggalAkhir);

    // A reversal ADDS two rows and REMOVES none, so the correct reading is
    // unchanged and the POSTED-only reading has subtracted 5.000.000 without
    // ever adding it. If these two were ever equal, the ADR 0010 test would be
    // passing vacuously.
    expect(benar).toBe(sebelumBenar);
    expect(naif).toBe("-5000000.00");
    expect(benar).not.toBe(naif);
  });

  test("seluruh ledger dunia ini tetap balance setelah posting dan reversal", async () => {
    expect(await d.selisihLedger()).toBe("0.00");
  });
});

describe("fixture closing: prasyarat yang harus bisa dirusak", () => {
  // Its own world. Everything here CLOSES a period or breaks a reconciliation,
  // and both are global to a world; sharing one with the classification tests
  // above would make their results depend on execution order.
  //
  // WHY THESE EXIST AT ALL. Six of the ten checks in spec 8.4 are only testable
  // if the fixture can manufacture the condition they refuse. Those paths sit
  // AFTER a call into the unimplemented engine, so they are unreachable from
  // ./closing-periode.test.ts today, and an unreachable fixture path is an
  // untested one that will be blamed on the engine the day it finally runs.
  // These exercise them now, without the engine.
  let w: DuniaClosing;

  beforeAll(async () => {
    w = await buatDunia();
  });
  afterAll(async () => {
    await w?.tutup();
  });

  test("tutupPeriodeSampai menutup pendahulunya berurutan dan berhenti sebelum target", async () => {
    const mar = w.periode(2026, 3);
    await w.tutupPeriodeSampai(mar);
    expect((await w.bacaPeriode(w.periode(2026, 1).id)).status).toBe("CLOSED");
    expect((await w.bacaPeriode(w.periode(2026, 2).id)).status).toBe("CLOSED");
    expect((await w.bacaPeriode(mar.id)).status).toBe("OPEN");
  });

  test("periode CLOSED benar benar menolak jurnal bertanggal di dalamnya (invarian 5)", async () => {
    // The state ./closing-wajib-8-5.test.ts item 11 will reach through the
    // engine. Pinned here against a period this fixture closed directly, so the
    // refusal is known to be the ledger's and not something the closing engine
    // will have to arrange separately.
    const jan = w.periode(2026, 1);
    let ditangkap: unknown;
    try {
      await w.postingBebanOperasional(jan.tanggalAkhir, rp(1_000_000));
    } catch (e) {
      ditangkap = e;
    }
    expect(ditangkap).toBeInstanceOf(JurnalError);
    expect((ditangkap as JurnalError).kode).toBe("PERIODE_TIDAK_OPEN");
  });

  test("buatJurnalDraft menghasilkan DRAFT di periode yang diminta (spec 8.4 butir 2)", async () => {
    const p = w.periode(2026, 4);
    const draft = await w.buatJurnalDraft(p.tanggalAkhir, rp(250_000));
    expect(draft.status).toBe("DRAFT");
    expect(draft.periodeId).toBe(p.id);
    const jurnal = await w.jurnalPeriode(p.id);
    expect(jurnal.filter((j) => j.status === "DRAFT").map((j) => j.id)).toContain(draft.id);

    // ...and posting it clears the condition, which is the second half of spec
    // 16 scenario 12.
    const posted = await w.postingJurnalDraft(draft.id);
    expect(posted.status).toBe("POSTED");
    expect((await w.jurnalPeriode(p.id)).filter((j) => j.status === "DRAFT")).toHaveLength(0);
  });

  test("rusakSubLedger membuat selisih rekonsiliasi yang bisa dilihat lewat view terkirim (spec 8.4 butir 10)", async () => {
    const p = w.periode(2026, 5);
    const akad = await w.buatAkad({
      hariTunggakan: 20,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: p.tanggalMulai,
    });
    expect((await w.rekonsiliasi(akad.akadId)).selisih).toBe("0.00");
    expect(await w.akadTidakRekonsiliasi()).toHaveLength(0);

    await w.rusakSubLedger(akad.akadId, rp(7_500_000));

    const r = await w.rekonsiliasi(akad.akadId);
    expect(r.saldoSubLedger).toBe(rp(7_500_000));
    expect(r.saldoBukuBesar).toBe(akad.pokok);
    expect(r.selisih).toBe("-4500000.00");
    const menyimpang = await w.akadTidakRekonsiliasi();
    expect(menyimpang.map((x) => x.akad_id)).toContain(akad.akadId);

    // Put it back, so nothing later in this world inherits a broken ledger.
    await w.rusakSubLedger(akad.akadId, akad.pokok);
    expect(await w.akadTidakRekonsiliasi()).toHaveLength(0);
  });

  test("saldo kas bisa dibuat negatif, yang spec 8.4 butir 8 sebut peringatan", async () => {
    const p = w.periode(2026, 6);
    w.setelJam(p.tanggalMulai);
    const sebelum = await w.saldoLedger(w.akun.kas.id, p.tanggalAkhir);
    // A disbursement with no funding credits cash. The check exists because
    // this is a real operational state, not an impossible one.
    expect(keSen(sebelum)).toBeLessThan(0n);

    await w.postingAlokasiDana(p.tanggalMulai, rp(500_000_000));
    expect(keSen(await w.saldoLedger(w.akun.kas.id, p.tanggalAkhir))).toBeGreaterThan(0n);
  });

  test("hapusBukuLewatEngine memakai penyisihan yang ADA dan membebankan sisanya", async () => {
    // The path ./closing-penyisihan.test.ts depends on and cannot reach until
    // the engine exists. Pinned here so the day it runs, a red test means the
    // closing engine read the wrong opening balance and not that this helper
    // was broken all along.
    const p = w.periode(2026, 7);
    w.setelJam(p.tanggalMulai);
    const akad = await w.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: p.tanggalMulai,
    });

    // An allowance deliberately SMALLER than the outstanding, which is the case
    // spec 6.4's HAPUS_BUKU_PIUTANG does not handle (docs/REGULASI.md #4).
    await w.postingBebanPenyisihan(p.tanggalMulai, rp(5_000_000));
    expect(await w.saldoLedger(w.akun.penyisihan.id, p.tanggalAkhir)).toBe("-5000000.00");

    const hasil = await w.hapusBukuLewatEngine(akad.akadId, p.tanggalAkhir);

    expect(hasil.penyisihanTersedia).toBe(rp(5_000_000));
    expect(hasil.dariPenyisihan).toBe(rp(5_000_000));
    expect(hasil.kekurangan).toBe(rp(7_000_000));
    // The contra-asset reached zero and did NOT cross it. The spec's single
    // event would have driven it to +7.000.000 debit, i.e. a balance sheet
    // overstating receivables by exactly the amount just written off.
    expect(await w.saldoLedger(w.akun.penyisihan.id, p.tanggalAkhir)).toBe("0.00");
    expect((await w.bacaAkad(akad.akadId)).outstanding_pokok).toBe("0.00");
    expect((await w.rekonsiliasi(akad.akadId)).selisih).toBe("0.00");
    expect(await w.selisihLedger()).toBe("0.00");
  });

  test("hapusKonfigurasi menyisakan baris global, bukan tidak ada baris sama sekali", async () => {
    // A parameter an operator removes at bumn level FALLS BACK to the global
    // row migrations/0004 ships. That is the shape an engine has to handle, and
    // it is not the same as "no row anywhere", which is the refusal case.
    await w.hapusKonfigurasi("akuntansi", "mode_penyisihan");
    expect(await w.bacaKonfigurasi("akuntansi", "mode_penyisihan")).toBeNull();
    const global = await w.db.query<{ nilai: string }>(
      `select nilai from konfigurasi
        where bumn_id is null and grup = 'akuntansi' and kunci = 'mode_penyisihan'
          and deleted_at is null`,
    );
    expect(global).toHaveLength(1);
  });
});

describe("fixture closing: temuan yang belum ditutup", () => {
  test("TEMUAN: kolektibilitas_snapshot belum punya kolom sumber_rate", async () => {
    // docs/REGULASI.md is explicit: "Tambahkan kolom `sumber_rate`". With two
    // penyisihan modes live (docs/BUILD-PLAN.md), `rate_penyisihan` alone
    // cannot say whether 0.850000 was typed into `penyisihan_rate` or derived
    // from collection history. The moment the mode is switched, a closed
    // period's Laporan Perhitungan Penyisihan stops being reconstructible,
    // which breaks invariant 14 for the one report whose whole job is to
    // reconstruct the allowance journal.
    //
    // migrations/0011 ships `dasar_perhitungan` and stops there. This module
    // must NOT invent the column in a fixture: the fix is a migration, and
    // until it lands the engine has to refuse rather than write a snapshot it
    // cannot later explain (KODE_CLOSING.SKEMA_BELUM_LENGKAP exists for that).
    expect(await d.kolomAda("kolektibilitas_snapshot", "dasar_perhitungan")).toBe(true);
    expect(await d.kolomAda("kolektibilitas_snapshot", "sumber_rate")).toBe(true);
  });

  test("TEMUAN: katalog izin belum punya kode baca-saja untuk layar closing", () => {
    // The three write codes are there and correctly granted.
    expect(canonicalPermission(PERMISSION_CLOSING.KOLEKTIBILITAS)).toBe(
      PERMISSION_CLOSING.KOLEKTIBILITAS,
    );
    expect(canonicalPermission(PERMISSION_CLOSING.PERIODE)).toBe(PERMISSION_CLOSING.PERIODE);
    expect(canonicalPermission(PERMISSION_CLOSING.REOPEN)).toBe(PERMISSION_CLOSING.REOPEN);

    // The read code is not. Spec 2 gives the Auditor "read only penuh termasuk
    // semua laporan dan audit trail" and spec 16 scenario 23 tests it; how a
    // period was closed, and against which checklist, is the auditor's primary
    // object and is not one of the 31 reports, so `laporan.view` does not reach
    // it. With no read-only code the only options are to grant a WRITE code to
    // a role that must never write, or to lock the auditor out of the evidence.
    //
    // Same shape as `pumk.cluster` and `nonpumk.lpj.verifikasi`: the module
    // names the code it needs and fails closed until the catalogue carries it.
    // Adding the string to a fixture's permission list would make this green
    // and the gap invisible, which is the move both earlier findings survived.
    const kodeLihat: string = PERMISSION_CLOSING.LIHAT;
    expect(canonicalPermission(kodeLihat) as string | null).toBe(kodeLihat);
  });
});
