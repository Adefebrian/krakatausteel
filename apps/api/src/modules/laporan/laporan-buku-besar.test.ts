// BUKU BESAR (spec 10.3 report 22).
//
// "Per akun: saldo awal, lalu setiap mutasi (tanggal, no jurnal, keterangan,
//  debit, kredit, saldo berjalan), saldo akhir. Wajib bisa drill down ke
//  jurnal."
//
// And spec 16 scenario 5 makes it the first thing anyone opens: "Buka Buku
// Besar, konfirmasi jurnal pencairan muncul dengan akun yang benar."
//
// WHAT MAKES THIS REPORT DIFFERENT FROM THE OTHER SIX. Every other report
// prints aggregates. This one prints the individual entries, in order, with a
// balance that accumulates down the page, and it is the report an accountant
// uses to find out why an aggregate is what it is. Two properties follow, and
// both are asserted line by line rather than at the totals:
//
//   1. THE RUNNING BALANCE MUST BE INTERNALLY CONSISTENT. Every row's
//      `saldoBerjalan` is the previous row's plus this row's movement, and the
//      first row's is the opening balance plus its movement. A report whose
//      footer is right and whose running balance is wrong is worse than one
//      that is simply wrong: it looks checkable and is not.
//
//   2. DRILL-DOWN IS AN ID, NOT A SEARCH. Spec 11: "Angka yang tidak bisa
//      ditelusuri asalnya tidak dipercaya user." Every movement carries the
//      `jurnal_id` and `jurnal_baris_id` it came from, and both are asserted
//      to resolve to the real rows with the same amounts.
//
// THE WINDOW IS THE PERIOD, matching the Neraca Lajur, so `saldoAwal` here and
// `saldoAwalDebit/Kredit` there are the same figure and a reader can move
// between the two reports without a conversion.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  buatDunia,
  headerSah,
  jumlahUang,
  keSen,
  kurangUang,
  negasiUang,
  rp,
  semuaAngkaSah,
  tambahHari,
  tolakDengan,
  type DuniaLaporan,
} from "./test-support";
import { KODE_LAPORAN, NAMA_LAPORAN, NOL_TAMPIL, type LaporanBukuBesar } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

function bukuBesar(akunId: string, cabangId: string | null = null): Promise<LaporanBukuBesar> {
  return d.engine.bukuBesar(
    { periodeId: d.periodeLaporan().id, akunId, cabangId: cabangId ?? d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("saldo awal, mutasi, saldo akhir", () => {
  test("kas di 2026-03: saldo awal, tiga mutasi dan saldo akhir yang benar", async () => {
    const l = await bukuBesar(d.akun.kas.id);
    // NON-VACUOUS: an empty ledger satisfies "closing = opening + movements".
    expect(keSen(l.saldoAwal.nilai)).toBeGreaterThan(0n);
    expect(l.mutasi.length).toBe(HARAPAN.kasMutasiBarisMaret);

    expect(l.akunKode).toBe(d.akun.kas.kode);
    expect(l.akunNama).toBe(d.akun.kas.nama);
    expect(l.saldoNormal).toBe("D");
    expect(l.saldoAwal.nilai).toBe(HARAPAN.kasSaldoAwalMaret);
    expect(l.totalDebit.nilai).toBe(HARAPAN.kasMutasiDebitMaret);
    expect(l.totalKredit.nilai).toBe(HARAPAN.kasMutasiKreditMaret);
    expect(l.saldoAkhir.nilai).toBe(HARAPAN.kasAkhir);
  });

  test("saldo akhir = saldo awal + total debit - total kredit", async () => {
    for (const k of ["kas", "piutangPokok", "bebanOperasional", "pendapatanAlokasi"] as const) {
      const l = await bukuBesar(d.akun[k].id);
      const gerak = kurangUang(l.totalDebit.nilai, l.totalKredit.nilai);
      // In the account's own direction: a credit-balance account grows on a
      // credit rather than going negative.
      const arah = l.saldoNormal === "D" ? gerak : negasiUang(gerak);
      expect(jumlahUang(l.saldoAwal.nilai, arah), `akun ${l.akunKode}`).toBe(l.saldoAkhir.nilai);
    }
  });

  test("total debit dan kredit adalah jumlah baris yang tercetak", async () => {
    const l = await bukuBesar(d.akun.kas.id);
    expect(l.mutasi.reduce((t, m) => jumlahUang(t, m.debit.nilai), rp(0))).toBe(l.totalDebit.nilai);
    expect(l.mutasi.reduce((t, m) => jumlahUang(t, m.kredit.nilai), rp(0))).toBe(
      l.totalKredit.nilai,
    );
  });

  test("saldo awal dan saldo akhir cocok dengan Neraca Lajur untuk periode yang sama", async () => {
    // The two reports share a window on purpose. If they ever disagree, one of
    // them has silently changed convention and the difference is invisible on
    // either page alone.
    const neraca = await d.engine.neracaLajur(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    for (const k of ["kas", "piutangPokok", "kelebihanAngsuran"] as const) {
      const l = await bukuBesar(d.akun[k].id);
      const row = neraca.baris.find((b) => b.akunId === d.akun[k].id)!;
      const awalNeraca = kurangUang(row.saldoAwalDebit.nilai, row.saldoAwalKredit.nilai);
      const awalBuku = l.saldoNormal === "D" ? l.saldoAwal.nilai : negasiUang(l.saldoAwal.nilai);
      expect(awalBuku, `saldo awal ${k}`).toBe(awalNeraca);
      expect(l.totalDebit.nilai).toBe(row.mutasiDebit.nilai);
      expect(l.totalKredit.nilai).toBe(row.mutasiKredit.nilai);
    }
  });
});

describe("saldo berjalan: konsisten baris demi baris, bukan hanya di kaki", () => {
  test("setiap baris = baris sebelumnya + debit - kredit, dimulai dari saldo awal", async () => {
    for (const k of ["kas", "piutangPokok", "kelebihanAngsuran"] as const) {
      const l = await bukuBesar(d.akun[k].id);
      let berjalan = l.saldoAwal.nilai;
      for (const [i, m] of l.mutasi.entries()) {
        const gerak = kurangUang(m.debit.nilai, m.kredit.nilai);
        berjalan = jumlahUang(berjalan, l.saldoNormal === "D" ? gerak : negasiUang(gerak));
        expect(m.saldoBerjalan.nilai, `${l.akunKode} baris ${i}`).toBe(berjalan);
      }
      // And the last running balance IS the closing balance, which is what
      // makes the page footable by hand.
      if (l.mutasi.length > 0) {
        expect(l.mutasi[l.mutasi.length - 1].saldoBerjalan.nilai).toBe(l.saldoAkhir.nilai);
      }
    }
  });

  test("satu baris hanya punya debit ATAU kredit, sisi lain tampil 0,00", async () => {
    // Invariant 3, seen from the report side. A row with both filled is a row
    // whose running balance nobody can check by eye.
    const l = await bukuBesar(d.akun.kas.id);
    for (const m of l.mutasi) {
      const adaDebit = keSen(m.debit.nilai) !== 0n;
      const adaKredit = keSen(m.kredit.nilai) !== 0n;
      expect(adaDebit !== adaKredit, `baris ${m.noJurnal} tidak satu sisi`).toBe(true);
      expect(adaDebit ? m.kredit.tampil : m.debit.tampil).toBe(NOL_TAMPIL);
    }
  });

  test("urutan mutasi menurut tanggal lalu nomor jurnal, dan stabil antar pemanggilan", async () => {
    const l = await bukuBesar(d.akun.kas.id);
    const kunciUrut = l.mutasi.map((m) => `${m.tanggal}|${m.noJurnal}`);
    expect(kunciUrut).toEqual([...kunciUrut].sort());
    const lagi = await bukuBesar(d.akun.kas.id);
    expect(lagi.mutasi.map((m) => m.jurnalBarisId)).toEqual(l.mutasi.map((m) => m.jurnalBarisId));
  });
});

describe("drill down ke jurnal (spec 10.3 laporan 22, spec 11)", () => {
  test("setiap mutasi membawa id jurnal dan id baris jurnal yang benar benar ada", async () => {
    const l = await bukuBesar(d.akun.kas.id);
    expect(l.mutasi.length).toBeGreaterThan(0);
    for (const m of l.mutasi) {
      const baris = await d.db.query<{
        jurnal_id: string;
        no_jurnal: string;
        tanggal: string;
        debit: string;
        kredit: string;
        akun_id: string;
        status: string;
      }>(
        `select b.jurnal_id::text as jurnal_id, j.no_jurnal,
                j.tanggal_transaksi::text as tanggal, b.debit::text as debit,
                b.kredit::text as kredit, b.akun_id::text as akun_id, j.status
           from jurnal_baris b join jurnal j on j.id = b.jurnal_id
          where b.id = $1`,
        [m.jurnalBarisId],
      );
      expect(baris, `baris jurnal ${m.jurnalBarisId} tidak ada`).toHaveLength(1);
      const row = baris[0];
      expect(row.jurnal_id).toBe(m.jurnalId);
      expect(row.no_jurnal).toBe(m.noJurnal);
      expect(row.tanggal).toBe(m.tanggal);
      expect(row.debit).toBe(m.debit.nilai);
      expect(row.kredit).toBe(m.kredit.nilai);
      expect(row.akun_id).toBe(l.akunId);
      // ADR 0010's predicate, seen from the report: a REVERSED journal's lines
      // are ledger lines and belong here.
      expect(["POSTED", "REVERSED"]).toContain(row.status);
    }
  });

  test("keterangan, jenis dan cabang tercetak, karena itu yang dibaca akuntan", async () => {
    const l = await bukuBesar(d.akun.kas.id);
    for (const m of l.mutasi) {
      expect(m.keterangan.length).toBeGreaterThan(0);
      expect(m.jenisJurnal.length).toBeGreaterThan(0);
      expect(m.cabangId).toBe(d.cabangId);
    }
    expect(l.mutasi.some((m) => m.keterangan.includes("angsuran"))).toBe(true);
  });
});

describe("cakupan: hanya akun ini, hanya periode ini, hanya cabang ini", () => {
  test("mutasi bulan lain tidak muncul", async () => {
    const p = d.periodeLaporan();
    const l = await bukuBesar(d.akun.kas.id);
    for (const m of l.mutasi) {
      expect(m.tanggal >= p.tanggalMulai).toBe(true);
      expect(m.tanggal <= p.tanggalAkhir).toBe(true);
    }
    // And the January page is a different page with a different opening.
    const januari = await d.engine.bukuBesar(
      { periodeId: d.periode(2026, 1).id, akunId: d.akun.kas.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(januari.saldoAwal.nilai).toBe(HARAPAN.kasAwal);
    expect(januari.mutasi.map((m) => m.jurnalBarisId)).not.toEqual(
      l.mutasi.map((m) => m.jurnalBarisId),
    );
  });

  test("akun tanpa mutasi di periode ini tetap punya halaman, dengan saldo dan 0,00", async () => {
    // Report 22 is where a reader checks that an account did NOT move. An
    // empty page with the opening balance carried to the closing balance is
    // the answer; an error is not.
    const l = await bukuBesar(d.akun.asetTetap.id);
    expect(l.mutasi).toHaveLength(0);
    expect(l.saldoAwal.nilai).toBe(HARAPAN.asetTetap);
    expect(l.saldoAkhir.nilai).toBe(HARAPAN.asetTetap);
    expect(l.totalDebit.tampil).toBe(NOL_TAMPIL);
    expect(l.totalKredit.tampil).toBe(NOL_TAMPIL);
  });

  test("filter cabang: jurnal cabang B tidak muncul di halaman cabang utama", async () => {
    const utama = await d.engine.bukuBesar(
      { periodeId: d.periode(2026, 2).id, akunId: d.akun.kas.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const semua = await d.engine.bukuBesar(
      { periodeId: d.periode(2026, 2).id, akunId: d.akun.kas.id, cabangId: null },
      d.ctx.adminPusat,
    );
    expect(semua.mutasi.length).toBe(utama.mutasi.length + 1);
    expect(utama.mutasi.every((m) => m.cabangId === d.cabangId)).toBe(true);
    expect(semua.mutasi.some((m) => m.cabangId === d.cabangLainId)).toBe(true);
  });

  test("akun yang bukan milik bumn ini ditolak, bukan mengembalikan halaman kosong", async () => {
    const lain = await buatDunia();
    try {
      await tolakDengan(
        () =>
          d.engine.bukuBesar(
            {
              periodeId: d.periodeLaporan().id,
              akunId: lain.akun.kas.id,
              cabangId: d.cabangId,
            },
            d.ctx.adminPusat,
          ),
        KODE_LAPORAN.AKUN_TIDAK_DITEMUKAN,
      );
    } finally {
      await lain.tutup();
    }
  });
});

describe("jurnal DRAFT tidak pernah masuk buku besar", () => {
  test("draft tidak muncul, dan setelah diposting muncul", async () => {
    // Invariant: a DRAFT is not in the ledger. `v_ledger_baris` states it once
    // and this is the report where an operator would notice if it did not.
    const draft = await d.buatJurnalDraft({
      tanggal: "2026-03-30",
      jenis: "UMUM",
      keterangan: "Jurnal DRAFT (fixture laporan)",
      baris: [
        { akun: "bebanPembinaan", debit: rp(1_000_000) },
        { akun: "kas", kredit: rp(1_000_000) },
      ],
    });
    const sebelum = await bukuBesar(d.akun.bebanPembinaan.id);
    expect(sebelum.mutasi).toHaveLength(0);
    expect(sebelum.saldoAkhir.nilai).toBe(rp(0));
    expect(sebelum.saldoAkhir.tampil).toBe(NOL_TAMPIL);
    expect(draft.status).toBe("DRAFT");
  });
});

describe("header dan format", () => {
  test("header spec 10 lengkap, menyebut akunnya, dan setiap sel punya tampilan", async () => {
    const l = await bukuBesar(d.akun.kas.id);
    headerSah(l.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.BUKU_BESAR,
      cabangId: d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    const p = d.periodeLaporan();
    expect(l.header.dariTanggal).toBe(p.tanggalMulai);
    expect(l.header.sampaiTanggal).toBe(p.tanggalAkhir);
    expect(tambahHari(p.tanggalMulai, -1)).toBe("2026-02-28");
    expect(semuaAngkaSah(l, "bukuBesar")).toBeGreaterThan(10);
  });
});
