// LAYOUT IS DATA. THE MECHANIC, NOT THE CAPTIONS.
//
// Spec 4.2, verbatim: "`klasifikasi_laporan` adalah kunci pemetaan ke format
// laporan. Buat tabel referensi `baris_laporan` agar format laporan bisa
// diubah tanpa deploy." migrations/0005 implemented it as a real composite
// foreign key straight into the printed line; migrations/0028 split the
// vocabulary off that line, so it is now `akun.klasifikasi_akun ->
// klasifikasi_akun(bumn_id, kode)` plus a `pemetaan_baris_laporan` row per
// statement. Same reason `event_jurnal_mapping` exists (ADR 0004): an
// accountant must be able to correct a statement without a release.
//
// WHY THIS FILE IS THE ONE THAT MAKES THE PSAK 45 / ISAK 335 QUESTION SAFE TO
// LEAVE OPEN. docs/REGULASI.md finding 1: PSAK 45 was withdrawn, ISAK 335
// renamed the categories, an amendment effective 2027 changes the format
// again, audited BUMN practice is split, and the decision belongs to the
// client's accounting team together with their KAP. docs/BUILD-PLAN.md
// requires two templates to be able to live side by side.
//
// NOT ONE TEST BELOW ASSERTS WHICH READING IS CORRECT. Every one asserts that
// the STRUCTURE FOLLOWS THE DATA: add a row and a line appears, reorder rows
// and the page reorders, deactivate a row and the line stops printing, repoint
// an account and its balance moves with it, flip `tanda` and the presentation
// inverts. A module that passes these can be re-templated with an UPDATE.
//
// AND THE GAPS IN THE SHIPPED SEED ARE PINNED AS REFUSALS. apps/api/src/seed/
// coa-inti.ts is explicitly the journal engine's minimum, not a chart a
// statement can be printed from. Where it is short, the report must fail
// closed and say so, never invent a default: an invented layout is a statement
// nobody configured and nobody can correct.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  KODE_BARIS,
  SEKSI,
  buatDunia,
  jumlahUang,
  keSen,
  negasiUang,
  rp,
  tolakDengan,
  type DuniaLaporan,
} from "./test-support";
import { KODE_LAPORAN, NOL_TAMPIL } from "./contract";

let d: DuniaLaporan;

beforeEach(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterEach(async () => {
  await d?.tutup();
});

function posisi() {
  return d.engine.laporanPosisiKeuangan(
    { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
    d.ctx.adminPusat,
  );
}
function aktivitas() {
  return d.engine.laporanAktivitas(
    { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("menambah baris laporan mengubah laporan, tanpa deploy", () => {
  test("baris baru plus satu akun yang menunjuknya: baris itu muncul dengan saldonya", async () => {
    const sebelum = await posisi();
    const asetSemula = sebelum.totalAsetTahunIni.nilai;
    expect(sebelum.baris.map((b) => b.kode)).not.toContain("ASET_TETAP");

    // A statement change as a pair of INSERTs and an UPDATE. No code moves.
    await d.tambahBarisLaporan({
      kode: "ASET_TETAP",
      nama: "Aset Tetap Bersih",
      laporan: "POSISI_KEUANGAN",
      urutan: 15,
      seksi: SEKSI.aset,
    });
    await d.petakanAkun(d.akun.asetTetap.id, "ASET_TETAP");

    const sesudah = await posisi();
    const baru = sesudah.baris.find((b) => b.kode === "ASET_TETAP");
    expect(baru, "baris baru tidak dicetak").toBeDefined();
    expect(baru!.nama).toBe("Aset Tetap Bersih");
    expect(baru!.nilaiTahunIni.nilai).toBe(HARAPAN.asetTetap);
    expect(baru!.akunKode).toEqual([d.akun.asetTetap.kode]);
    // The account left the line it used to be on, so the total is unchanged
    // and the money moved between lines rather than being counted twice.
    expect(sesudah.totalAsetTahunIni.nilai).toBe(asetSemula);
    const aset = sesudah.baris.find((b) => b.kode === KODE_BARIS.aset)!;
    expect(aset.akunKode).not.toContain(d.akun.asetTetap.kode);
    const asetSebelum = sebelum.baris.find((b) => b.kode === KODE_BARIS.aset)!.nilaiTahunIni.nilai;
    expect(aset.nilaiTahunIni.nilai).toBe(
      jumlahUang(asetSebelum, negasiUang(HARAPAN.asetTetap)),
    );
  });

  test("urutan baris di laporan adalah urutan di tabel", async () => {
    await d.tambahBarisLaporan({
      kode: "ASET_TETAP",
      nama: "Aset Tetap Bersih",
      laporan: "POSISI_KEUANGAN",
      urutan: 15,
      seksi: SEKSI.aset,
    });
    await d.petakanAkun(d.akun.asetTetap.id, "ASET_TETAP");
    const awal = (await posisi()).baris.map((b) => b.kode);
    expect(awal.indexOf("ASET_TETAP")).toBe(awal.indexOf(KODE_BARIS.aset) + 1);

    // Move it to the top. A hardcoded order cannot follow this.
    await d.setelBarisLaporan("ASET_TETAP", { urutan: 5 });
    const sesudah = (await posisi()).baris.map((b) => b.kode);
    expect(sesudah[0]).toBe("ASET_TETAP");
    expect(sesudah).not.toEqual(awal);
    expect([...sesudah].sort()).toEqual([...awal].sort());
  });

  test("mengganti nama baris mengganti judul yang tercetak", async () => {
    // The whole PSAK 45 versus ISAK 335 question, reduced to an UPDATE.
    await d.setelBarisLaporan(KODE_BARIS.asetNetoTidakTerikat, {
      nama: "Aset Neto Tanpa Pembatasan",
    });
    const l = await posisi();
    const baris = l.baris.find((b) => b.kode === KODE_BARIS.asetNetoTidakTerikat)!;
    expect(baris.nama).toBe("Aset Neto Tanpa Pembatasan");
    // And the figure did not move, because renaming is not reclassifying.
    expect(baris.nilaiTahunIni.nilai).toBe(HARAPAN.asetNetoTidakTerikatAkhir);

    const perubahan = await d.engine.laporanPerubahanAsetNeto(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(perubahan.baris.find((b) => b.kategoriKode === KODE_BARIS.asetNetoTidakTerikat)!.nama).toBe(
      "Aset Neto Tanpa Pembatasan",
    );
  });

  test("menonaktifkan baris tanpa akun menghentikan pencetakannya", async () => {
    const sebelum = await posisi();
    expect(sebelum.baris.map((b) => b.kode)).toContain(KODE_BARIS.asetNeto);
    await d.setelBarisLaporan(KODE_BARIS.asetNeto, { aktif: false });
    const sesudah = await posisi();
    expect(sesudah.baris.map((b) => b.kode)).not.toContain(KODE_BARIS.asetNeto);
    // Nothing pointed at it that carries a balance, so the totals are intact.
    expect(sesudah.totalAsetNetoTahunIni.nilai).toBe(sebelum.totalAsetNetoTahunIni.nilai);
  });
});

describe("memindahkan akun ke baris lain memindahkan angkanya", () => {
  test("piutang dipindah ke baris kontra: saldonya berpindah baris, total tetap", async () => {
    const sebelum = await posisi();
    const asetSemula = sebelum.totalAsetTahunIni.nilai;
    await d.tambahBarisLaporan({
      kode: "PIUTANG_BRUTO",
      nama: "Piutang Pinjaman Mitra Binaan Bruto",
      laporan: "POSISI_KEUANGAN",
      urutan: 18,
      seksi: SEKSI.aset,
    });
    await d.petakanAkun(d.akun.piutangPokok.id, "PIUTANG_BRUTO");

    const sesudah = await posisi();
    expect(sesudah.baris.find((b) => b.kode === "PIUTANG_BRUTO")!.nilaiTahunIni.nilai).toBe(
      HARAPAN.piutangPokok,
    );
    expect(sesudah.totalAsetTahunIni.nilai).toBe(asetSemula);
    expect(keSen(asetSemula)).toBeGreaterThan(0n);
  });

  test("memindahkan akun pendapatan antar seksi memindahkan kenaikan aset netonya", async () => {
    // The mechanic report 20 rests on. Moving the restricted contribution to
    // the unrestricted section must move 25 juta between categories in BOTH
    // report 17 and report 20, with the total unchanged.
    const sebelum = await d.engine.laporanPerubahanAsetNeto(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    await d.setelBarisLaporan(KODE_BARIS.pendapatanTerikat, { seksi: SEKSI.tidakTerikat });

    const akt = await aktivitas();
    const tidakTerikat = akt.seksi.find((s) => s.kode === SEKSI.tidakTerikat)!;
    expect(tidakTerikat.kenaikanAsetNetoTahunIni.nilai).toBe(HARAPAN.kenaikanAsetNetoTahunIni);
    expect(akt.kenaikanAsetNetoTahunIni.nilai).toBe(HARAPAN.kenaikanAsetNetoTahunIni);

    const sesudah = await d.engine.laporanPerubahanAsetNeto(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(sesudah.totalPerubahanTahunIni.nilai).toBe(sebelum.totalPerubahanTahunIni.nilai);
    expect(
      sesudah.baris.find((b) => b.kategoriKode === KODE_BARIS.asetNetoTerikat)!.perubahanTahunIni
        .nilai,
    ).toBe(rp(0));
    expect(
      sesudah.baris.find((b) => b.kategoriKode === KODE_BARIS.asetNetoTidakTerikat)!
        .perubahanTahunIni.nilai,
    ).toBe(HARAPAN.kenaikanAsetNetoTahunIni);
  });
});

describe("tanda: penyajian sebagai pengurang juga data", () => {
  test("membalik tanda baris kontra membalik penyajiannya dan menggeser total", async () => {
    // migrations/0005 ships `tanda = -1` on the allowance line precisely so
    // this is a configuration question. Flipping it here is not a claim that
    // either presentation is right; it is proof that the code has no opinion.
    const sebelum = await posisi();
    const kontraSebelum = sebelum.baris.find((b) => b.kode === KODE_BARIS.penyisihanKontra)!;
    expect(kontraSebelum.nilaiTahunIni.nilai).toBe(negasiUang(HARAPAN.penyisihan));

    await d.setelBarisLaporan(KODE_BARIS.penyisihanKontra, { tanda: 1 });
    const sesudah = await posisi();
    const kontra = sesudah.baris.find((b) => b.kode === KODE_BARIS.penyisihanKontra)!;
    expect(kontra.tanda).toBe(1);
    expect(kontra.nilaiTahunIni.nilai).toBe(HARAPAN.penyisihan);
    // The line moved by twice the allowance, which is exactly the error a
    // report that ignored `tanda` would make silently.
    expect(sesudah.totalAsetTahunIni.nilai).toBe(
      jumlahUang(sebelum.totalAsetTahunIni.nilai, HARAPAN.penyisihan, HARAPAN.penyisihan),
    );
  });
});

describe("tahun buku bukan Januari: rentang dan pembanding ikut konfigurasi", () => {
  test("mengubah tahun_buku_mulai_bulan menggeser rentang Laporan Aktivitas", async () => {
    const januari = await aktivitas();
    expect(januari.kolom.dariTahunIni).toBe("2026-01-01");
    expect(januari.kenaikanAsetNetoTahunIni.nilai).toBe(HARAPAN.kenaikanAsetNetoTahunIni);

    // A financial year starting in April. An implementation with a hardcoded
    // January prints the wrong comparative for every client on a non-calendar
    // year and nothing downstream detects it.
    await d.setelKonfigurasi("akuntansi", "tahun_buku_mulai_bulan", "4");
    const april = await aktivitas();
    expect(april.kolom.dariTahunIni).toBe("2025-04-01");
    expect(april.kolom.sampaiTahunIni).toBe("2026-03-31");
    expect(april.kolom.dariTahunLalu).toBe("2024-04-01");
    expect(april.kenaikanAsetNetoTahunIni.nilai).not.toBe(januari.kenaikanAsetNetoTahunIni.nilai);
  });

  test("menghapus baris bumn saja TIDAK menolak: default global yang menjawab", async () => {
    // THE RESOLUTION ORDER, ASSERTED RATHER THAN ASSUMED. `hapusKonfigurasi`
    // removes THIS WORLD'S row only, `akuntansi.tahun_buku_mulai_bulan` has a
    // global row from migrations/0004, and resolution is bumn-scoped THEN
    // global everywhere in this system. So the statement is produced on the
    // shipped default, which is January.
    await d.hapusKonfigurasi("akuntansi", "tahun_buku_mulai_bulan");
    const l = await aktivitas();
    expect(l.kolom.dariTahunIni).toBe("2026-01-01");
  });

  test("parameter yang hilang ditolak, bukan diganti nilai tebakan", async () => {
    // A defaulted fiscal year is a wrong comparative in an audited statement
    // that nobody can trace to a decision. Same rule modules/closing follows
    // for its rates.
    //
    // FIXED TEST, NOT A FIXED ENGINE. This used to call `hapusKonfigurasi`,
    // which removes one level, and then demand a refusal that bumn-then-global
    // resolution cannot produce. Rather than being wrong, it was worse: it
    // pushed this module into resolving THIS ONE KEY branch-only, so the same
    // question got two answers depending on whether modules/laporan or
    // modules/rka asked it. `tanpaKonfigurasi` removes BOTH levels, so
    // "hilang" means what the title always claimed and this module can go back
    // to the one resolution order the rest of the system uses.
    await d.tanpaKonfigurasi("akuntansi", "tahun_buku_mulai_bulan", () =>
      tolakDengan(() => aktivitas(), KODE_LAPORAN.KONFIGURASI_TIDAK_ADA),
    );
  });
});

describe("celah di seed terkirim: gagal tertutup, bukan format karangan", () => {
  test("template kosong ditolak, dan pesannya menyebut laporannya", async () => {
    // The state a client reaches by deactivating a template while switching to
    // another one. A code fallback here would defeat the whole "tanpa deploy"
    // requirement of spec 4.2.
    for (const kode of Object.values(KODE_BARIS)) {
      await d.setelBarisLaporan(kode, { aktif: false });
    }
    await tolakDengan(() => posisi(), KODE_LAPORAN.TEMPLATE_LAPORAN_KOSONG);
    await tolakDengan(() => aktivitas(), KODE_LAPORAN.TEMPLATE_LAPORAN_KOSONG);
  });

  test("akun bersaldo yang barisnya dinonaktifkan ditolak, bukan hilang diam diam", async () => {
    // Deactivating a line that accounts still point at would make their
    // balances vanish and the statement stop adding up. `klasifikasi_akun`
    // is NOT NULL and a real FK, so this is the only way to reach that state,
    // and it is exactly the operator mistake worth refusing on.
    await d.setelBarisLaporan(KODE_BARIS.liabilitas, { aktif: false });
    const err = await tolakDengan(() => posisi(), KODE_LAPORAN.AKUN_TIDAK_TERPETAKAN);
    expect(JSON.stringify(err.detail ?? "")).toContain(d.akun.kelebihanAngsuran.kode);
  });

  test("seksi baris aktivitas yang tidak dikenal ditolak (celah seksi di seed)", async () => {
    // THE SHIPPED SEED USED TO BE IN EXACTLY THIS STATE:
    // apps/api/src/seed/coa-inti.ts wrote `seksi = laporan`, i.e. 'AKTIVITAS',
    // which names no net-asset category. It now writes a real section name, so
    // this test WRITES the bad value itself rather than inheriting it. Report
    // 20 cannot attribute a movement to a category that does not exist, and
    // dropping it would break saldoAwal + perubahan = saldoAkhir.
    await d.setelBarisLaporan(KODE_BARIS.pendapatan, { seksi: "AKTIVITAS" });
    const err = await tolakDengan(
      () =>
        d.engine.laporanPerubahanAsetNeto(
          { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
          d.ctx.adminPusat,
        ),
      KODE_LAPORAN.SEKSI_ASET_NETO_TIDAK_DIKENAL,
    );
    expect(JSON.stringify(err.detail ?? "")).toContain("AKTIVITAS");
  });

  test("baris laporan yang tidak dipakai tetap dicetak sebagai 0,00", async () => {
    // The other half of the rule: an EMPTY line is not an error, it prints.
    // Spec 10: "Nilai nol ditampilkan sebagai 0,00 bukan kosong, karena tim
    // akuntansi memakainya untuk cross check."
    await d.tambahBarisLaporan({
      kode: "DEPOSITO",
      nama: "Deposito Berjangka",
      laporan: "POSISI_KEUANGAN",
      urutan: 12,
      seksi: SEKSI.aset,
    });
    const l = await posisi();
    const kosong = l.baris.find((b) => b.kode === "DEPOSITO")!;
    expect(kosong.akunKode).toEqual([]);
    expect(kosong.nilaiTahunIni.nilai).toBe(rp(0));
    expect(kosong.nilaiTahunIni.tampil).toBe(NOL_TAMPIL);
    expect(kosong.nilaiTahunLalu.tampil).toBe(NOL_TAMPIL);
  });
});
