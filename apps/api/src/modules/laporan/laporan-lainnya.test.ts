// apps/api/src/modules/laporan/laporan-lainnya.test.ts
//
// REKAP JURNAL (spec 10.3 report 21) AND THE SEVEN REPORTS OF SPEC 10.4
// (25, 26, 27, 29, 30, 31; report 28 is tested with the collectibility family
// it reads, in ./laporan-pumk.test.ts).
//
// FOUR THINGS THESE TESTS EXIST TO PIN, none of them "it returned rows":
//
//   REPORT 21 AGREES WITH REPORT 23. `totalTerbukukan` is the POSTED plus
//   REVERSED subtotal (ADR 0010) and it must equal Neraca Lajur's Mutasi
//   columns for the same window. Two engines, two queries, one number: that is
//   the check, and the DRAFT in the world is what stops it being satisfied by
//   an implementation that simply summed everything.
//
//   REPORT 29's ARITHMETIC IS THE RUN'S OWN. `saldoAwal + bebanPeriode =
//   saldoAkhir = penyisihanDibutuhkan`, and `bebanPeriode` equals the sum of
//   the linked journals, which a deferred constraint trigger already
//   guarantees -- so a non-zero `selisihTautanJurnal` would be a database
//   defect the report SHOWS.
//
//   REPORTS 25 AND 26 NEVER TRUST `data_json`. The fixture's converted
//   submission carries a deliberately wrong amount in the form, and the report
//   must print the proposal's; the rejected one carries an unparsable amount,
//   and the report must print NOTHING rather than zero.
//
//   REPORT 27's SEVEN DISTRIBUTIONS FOOT TO ONE POPULATION. Every one of them
//   carries a "Belum diisi" bucket, and the partner with every optional column
//   null is what makes that bucket non-empty in all seven.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KODE_LAPORAN, type LaporanContext } from "./contract";
import {
  BATAS_AUDIT_TRAIL_BAWAAN,
  BATAS_AUDIT_TRAIL_MAKS,
  EMBER_KOSONG,
  NAMA_LAPORAN_OPERASIONAL,
} from "./kontrak-operasional";
import {
  buatDuniaOperasional,
  NILAI,
  TANGGAL,
  type DuniaOperasional,
} from "./test-support-operasional";
import { headerSah, jumlahUang, kodeAda, semuaAngkaSah, tolakDengan, rp } from "./test-support";

let w: DuniaOperasional;
let pusat: LaporanContext;
let cabang: LaporanContext;

beforeAll(async () => {
  w = await buatDuniaOperasional();
  pusat = w.d.ctx.adminPusat;
  cabang = w.d.ctx.adminCabang;
});

afterAll(async () => {
  await w?.tutup();
});

const bulanan = () => ({ periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId });
const semuaCabang = () => ({ periodeId: w.periodeLaporan.id, cabangId: null });
const jendelaAudit = { dariTanggal: "2026-03-01", sampaiTanggal: "2026-03-31" };

// ---------------------------------------------------------------------------
// 21. Rekap Jurnal
// ---------------------------------------------------------------------------

describe("Laporan 21: rekap jurnal", () => {
  test("satu baris per (jenis, status), DRAFT ikut tercetak", async () => {
    const l = await w.engine.rekapJurnal(bulanan(), pusat);
    headerSah(l.header as unknown as { [k: string]: unknown }, w.d, {
      namaLaporan: NAMA_LAPORAN_OPERASIONAL.REKAP_JURNAL,
      cabangId: w.d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    semuaAngkaSah(l);
    expect(l.baris.map((b) => [b.jenis, b.status, b.jumlahDokumen])).toEqual([
      ["KAS_BANK", "POSTED", 3],
      ["KAS_BANK", "REVERSED", 1],
      ["REVERSAL", "POSTED", 1],
      ["UMUM", "DRAFT", 1],
      ["UMUM", "POSTED", 1],
    ]);
    const draft = l.baris.find((b) => b.status === "DRAFT");
    expect(draft?.totalDebit.nilai).toBe(NILAI.draftBelumDiposting);
  });

  test("setiap jurnal berimbang, jadi debit dan kredit sama di setiap baris", async () => {
    const l = await w.engine.rekapJurnal(bulanan(), pusat);
    for (const b of l.baris) expect(b.totalDebit.nilai).toBe(b.totalKredit.nilai);
    for (const j of l.perJenis) expect(j.totalDebit.nilai).toBe(j.totalKredit.nilai);
  });

  test("totalTerbukukan = POSTED + REVERSED, dan itu BUKAN total keseluruhan", async () => {
    const l = await w.engine.rekapJurnal(bulanan(), pusat);
    expect(l.totalTerbukukan.jumlahDokumen).toBe(6);
    expect(l.totalTerbukukan.totalDebit.nilai).toBe(
      NILAI.rekapJurnalTerbukukanMaretCabangA,
    );
    expect(l.total.jumlahDokumen).toBe(7);
    // The DRAFT is the difference, and it must be the ONLY difference.
    expect(l.total.totalDebit.nilai).toBe(
      jumlahUang(l.totalTerbukukan.totalDebit.nilai, NILAI.draftBelumDiposting),
    );
    expect(l.total.totalDebit.nilai).not.toBe(l.totalTerbukukan.totalDebit.nilai);
  });

  test("perJenis berkaki ke total keseluruhan", async () => {
    const l = await w.engine.rekapJurnal(bulanan(), pusat);
    expect(l.perJenis.map((j) => j.jenis)).toEqual(["KAS_BANK", "REVERSAL", "UMUM"]);
    expect(l.perJenis.reduce((t, j) => t + j.jumlahDokumen, 0)).toBe(l.total.jumlahDokumen);
    expect(jumlahUang(...l.perJenis.map((j) => j.totalDebit.nilai))).toBe(
      l.total.totalDebit.nilai,
    );
  });

  test("IDENTITAS: totalTerbukukan laporan 21 = kolom Mutasi laporan 23", async () => {
    // Two engines, two queries, one number. Report 21 cuts on
    // `tanggal_transaksi` precisely so this holds; cutting it on `periode_id`
    // would make the equality a coincidence.
    for (const filter of [bulanan(), semuaCabang()]) {
      const [duaSatu, duaTiga] = await Promise.all([
        w.engine.rekapJurnal(filter, pusat),
        w.d.engine.neracaLajur(filter, pusat),
      ]);
      expect(duaSatu.totalTerbukukan.totalDebit.nilai).toBe(duaTiga.total.mutasiDebit.nilai);
      expect(duaSatu.totalTerbukukan.totalKredit.nilai).toBe(duaTiga.total.mutasiKredit.nilai);
      // And the DRAFT really is excluded from both.
      expect(duaSatu.total.totalDebit.nilai).not.toBe(duaTiga.total.mutasiDebit.nilai);
    }
  });
});

// ---------------------------------------------------------------------------
// 25 and 26. Laporan Portal
// ---------------------------------------------------------------------------

describe("Laporan 25 dan 26: portal", () => {
  test("submission belum dikonversi hanya terlihat pada Semua Cabang", async () => {
    // `portal_submission` has no branch. A converted submission belongs to the
    // branch of the proposal it became; an unconverted one belongs to nobody,
    // and showing it to every branch user is the thing spec 16 scenario 24 is
    // about.
    const semua = await w.engine.portal({ ...semuaCabang(), jenis: "PUMK" }, pusat);
    expect(semua.baris.map((b) => b.submissionId)).toEqual([
      w.submission.ps1,
      w.submission.ps2,
      w.submission.ps3,
    ]);
    const satuCabang = await w.engine.portal({ ...bulanan(), jenis: "PUMK" }, pusat);
    expect(satuCabang.baris.map((b) => b.submissionId)).toEqual([w.submission.ps1]);
    expect(satuCabang.baris[0].cabangId).toBe(w.d.cabangId);
  });

  test("nilai diajukan diambil dari PROPOSAL, bukan dari data_json", async () => {
    const l = await w.engine.portal({ ...semuaCabang(), jenis: "PUMK" }, pusat);
    semuaAngkaSah(l);
    const ps1 = l.baris.find((b) => b.submissionId === w.submission.ps1)!;
    // The form says 999,00 and the proposal says 250.000.000. The proposal wins.
    expect(ps1.sumberNilai).toBe("PROPOSAL");
    expect(ps1.nilaiDiajukan?.nilai).toBe(rp(250_000_000));
    expect(ps1.pemohon).toBe("Budi Santoso");
    expect(ps1.sudahDikonversi).toBe(true);
    expect(ps1.proposalId).toBe(w.proposal.p2);
    expect(ps1.status).toBe("DIKONVERSI");
  });

  test("data_json dipakai HANYA kalau belum ada proposal DAN nilainya sah", async () => {
    const l = await w.engine.portal({ ...semuaCabang(), jenis: "PUMK" }, pusat);
    const ps2 = l.baris.find((b) => b.submissionId === w.submission.ps2)!;
    expect(ps2.sumberNilai).toBe("DATA_JSON");
    expect(ps2.nilaiDiajukan?.nilai).toBe(rp(75_000_000));
    expect(ps2.pemohon).toBe("Calon Belum Diproses");
    expect(ps2.sudahDikonversi).toBe(false);
    expect(ps2.cabangId).toBeNull();

    // "seratus juta" is not a two-decimal amount. NOTHING is printed, because
    // zero would read as a real application for nothing.
    const ps3 = l.baris.find((b) => b.submissionId === w.submission.ps3)!;
    expect(ps3.sumberNilai).toBe("TIDAK_ADA");
    expect(ps3.nilaiDiajukan).toBeNull();
    expect(ps3.status).toBe("DITOLAK");
  });

  test("per status dan total, dengan yang tidak punya nilai tidak dihitung nol", async () => {
    const l = await w.engine.portal({ ...semuaCabang(), jenis: "PUMK" }, pusat);
    expect(l.perStatus.map((s) => [s.status, s.jumlah])).toEqual([
      ["BARU", 1],
      ["DIPROSES", 0],
      ["DIKONVERSI", 1],
      ["DITOLAK", 1],
    ]);
    expect(l.perStatus.reduce((t, s) => t + s.jumlah, 0)).toBe(l.total.jumlahSubmission);
    expect(l.total.jumlahDikonversi).toBe(1);
    expect(l.total.nilaiDiajukan.nilai).toBe(rp(325_000_000));
  });

  test("laporan 26 adalah laporan yang sama atas jenis yang lain", async () => {
    const l = await w.engine.portal({ ...semuaCabang(), jenis: "NON_PUMK" }, pusat);
    expect(l.jenis).toBe("NON_PUMK");
    expect(l.header.namaLaporan).toBe(NAMA_LAPORAN_OPERASIONAL.PORTAL_NON_PUMK);
    expect(l.baris.map((b) => b.submissionId)).toEqual([w.submission.ps4]);
    expect(l.baris[0].pemohon).toBe("Yayasan Cerdas");
    expect(l.baris[0].sumberNilai).toBe("PROPOSAL");
    expect(l.baris[0].nilaiDiajukan?.nilai).toBe(rp(60_000_000));
    expect(l.baris[0].proposalId).toBe(w.nonpumk.np1);
    // The two reports never see each other's rows.
    const pumk = await w.engine.portal({ ...semuaCabang(), jenis: "PUMK" }, pusat);
    expect(pumk.baris.map((b) => b.submissionId)).not.toContain(w.submission.ps4);
  });
});

// ---------------------------------------------------------------------------
// 27. Laporan Demografi Mitra Binaan
// ---------------------------------------------------------------------------

describe("Laporan 27: demografi mitra binaan", () => {
  test("populasinya mitra yang punya akad, bukan setiap baris mitra", async () => {
    const l = await w.engine.demografiMitra(bulanan(), pusat);
    // Five partners hold an akad in this branch on or before the period end.
    // M004 belongs to the other branch and is not counted here.
    expect(l.jumlahMitra).toBe(5);
    expect(l.dasarWilayah).toBe("ALAMAT_MITRA_SAAT_INI");
    // An analytical report, not a financial one: there is no money on it.
    semuaAngkaSah(l, "$", { tanpaUang: true });
  });

  test("KETUJUH DISTRIBUSI BERKAKI KE POPULASI YANG SAMA", async () => {
    const l = await w.engine.demografiMitra(bulanan(), pusat);
    expect(l.distribusi.map((d) => d.dimensi)).toEqual([
      "JENIS_KELAMIN",
      "USIA",
      "SEKTOR",
      "WILAYAH",
      "LAMA_USAHA",
      "TENAGA_KERJA",
      "OMZET",
    ]);
    for (const d of l.distribusi) {
      expect(d.ember.reduce((t, e) => t + e.jumlah, 0), d.dimensi).toBe(l.jumlahMitra);
      // Every distribution carries the empty bucket, LAST, and here it is
      // non-empty in all seven because one partner has every optional column
      // null. A chart that dropped those rows would show a different
      // population from the chart beside it.
      const kosong = d.ember[d.ember.length - 1];
      expect(kosong.kode, d.dimensi).toBe(EMBER_KOSONG.kode);
      expect(kosong.jumlah, d.dimensi).toBe(1);
      const total = d.ember
        .map((e) => Number(e.persen))
        .reduce((t, n) => t + n, 0);
      expect(total, d.dimensi).toBeCloseTo(100, 1);
    }
  });

  test("setiap ember mendarat di band yang benar pada tanggal akhir periode", async () => {
    const l = await w.engine.demografiMitra(bulanan(), pusat);
    const ember = (dimensi: string) => {
      const d = l.distribusi.find((x) => x.dimensi === dimensi)!;
      return Object.fromEntries(d.ember.map((e) => [e.kode, e.jumlah]));
    };
    expect(ember("JENIS_KELAMIN")).toMatchObject({ L: 2, P: 2, BELUM_DIISI: 1 });
    // Ages at 31 March 2026: 35, 51, 27, 66, and one unknown. The 1990 birthday
    // falls in May, so that partner is 35 and not 36.
    expect(ember("USIA")).toMatchObject({
      U_LT_25: 0,
      U_25_34: 1,
      U_35_44: 1,
      U_45_54: 1,
      U_55_PLUS: 1,
      BELUM_DIISI: 1,
    });
    expect(ember("LAMA_USAHA")).toMatchObject({
      L_LT_2: 0,
      L_2_5: 1,
      L_6_10: 1,
      L_GT_10: 2,
      BELUM_DIISI: 1,
    });
    expect(ember("TENAGA_KERJA")).toMatchObject({
      T_0: 1,
      T_1_4: 1,
      T_5_19: 0,
      T_20_PLUS: 2,
      BELUM_DIISI: 1,
    });
    expect(ember("OMZET")).toMatchObject({
      O_LT_10JT: 1,
      O_10_50JT: 1,
      O_50_200JT: 0,
      O_GT_200JT: 2,
      BELUM_DIISI: 1,
    });
    const sektor = ember("SEKTOR");
    expect(sektor[w.sektor.s1.id]).toBe(2);
    expect(sektor[w.sektor.s2.id]).toBe(1);
    expect(sektor[w.sektor.s3.id]).toBe(1);
    const wilayah = ember("WILAYAH");
    expect(wilayah[w.wilayah.banten.provinsiId]).toBe(2);
    expect(wilayah[w.wilayah.jabar.provinsiId]).toBe(2);
  });

  test("Semua Cabang menambahkan mitra cabang lain", async () => {
    const l = await w.engine.demografiMitra(semuaCabang(), pusat);
    expect(l.jumlahMitra).toBe(6);
    for (const d of l.distribusi) {
      expect(d.ember.reduce((t, e) => t + e.jumlah, 0), d.dimensi).toBe(6);
    }
  });
});

// ---------------------------------------------------------------------------
// 29. Laporan Beban Penyisihan
// ---------------------------------------------------------------------------

describe("Laporan 29: beban penyisihan", () => {
  test("aritmetika run-nya sendiri, dan tautan jurnalnya berkaki", async () => {
    const l = await w.engine.bebanPenyisihan(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris).toHaveLength(1);
    const b = l.baris[0];
    expect(b.label).toBe("Maret 2026");
    expect(b.statusPeriode).toBe("OPEN");
    expect(b.saldoAwal.nilai).toBe(NILAI.penyisihanSaldoAwalCabangA);
    expect(b.penyisihanDibutuhkan.nilai).toBe(NILAI.penyisihanCabangA);
    expect(b.bebanPeriode.nilai).toBe(NILAI.penyisihanBebanCabangA);
    // saldoAwal + beban = saldoAkhir = penyisihanDibutuhkan.
    expect(b.saldoAkhir.nilai).toBe(
      jumlahUang(b.saldoAwal.nilai, b.bebanPeriode.nilai),
    );
    expect(b.saldoAkhir.nilai).toBe(b.penyisihanDibutuhkan.nilai);
  });

  test("TAUTAN KE JURNAL ADALAH SEBUAH DAFTAR, dan jumlahnya = beban periode", async () => {
    const l = await w.engine.bebanPenyisihan(bulanan(), pusat);
    const b = l.baris[0];
    // ADR 0015 dropped the singular `jurnal_id` because a corrected re-run
    // posts a SECOND journal for the delta.
    expect(b.jurnal).toHaveLength(1);
    expect(b.jurnal[0].nilai.nilai).toBe(NILAI.penyisihanBebanCabangA);
    expect(b.jurnal[0].noJurnal.length).toBeGreaterThan(0);
    expect(b.jurnal[0].tanggal).toBe("2026-03-31");
    expect(jumlahUang(...b.jurnal.map((j) => j.nilai.nilai))).toBe(b.bebanPeriode.nilai);
    // Zero, or a deferred constraint trigger would have refused the run.
    expect(b.selisihTautanJurnal.nilai).toBe(rp(0));
  });

  test("kaki jendela BUKAN tiga jumlah kolom: awal yang paling awal, akhir yang paling akhir", async () => {
    const l = await w.engine.bebanPenyisihan(semuaCabang(), pusat);
    expect(l.baris).toHaveLength(2);
    expect(l.total.saldoAwal.nilai).toBe(NILAI.penyisihanSaldoAwalCabangA);
    expect(l.total.bebanPeriode.nilai).toBe(
      jumlahUang(NILAI.penyisihanBebanCabangA, NILAI.penyisihanCabangB),
    );
    // The identity the footing is allowed to claim, over the whole window.
    expect(l.total.saldoAkhir.nilai).toBe(
      jumlahUang(l.total.saldoAwal.nilai, l.total.bebanPeriode.nilai),
    );
  });

  test("periode tanpa run penyisihan menghasilkan halaman kosong, bukan penolakan", async () => {
    // Nothing was run in February, and there is nothing to reconstruct: unlike
    // the collectibility snapshot, an absent provision run is not a claim about
    // figures that already exist.
    const l = await w.engine.bebanPenyisihan(
      { periodeId: w.periodeSebelum.id, cabangId: w.d.cabangId },
      pusat,
    );
    expect(l.baris).toHaveLength(0);
    expect(l.total.bebanPeriode.tampil).toBe("0,00");
  });
});

// ---------------------------------------------------------------------------
// 30. Laporan Akrual Piutang Jasa Administrasi
// ---------------------------------------------------------------------------

describe("Laporan 30: akrual piutang jasa administrasi", () => {
  test("per akad, dengan provenansi metode dan kelas yang diakrual", async () => {
    const l = await w.engine.akrualJasa(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris).toHaveLength(3);
    const a2 = l.baris.find((b) => b.akadId === w.akad.a2.id)!;
    expect(a2.jasaJatuhTempoPeriode.nilai).toBe(rp(4_000_000));
    expect(a2.jasaDiterimaPeriode.nilai).toBe(rp(0));
    expect(a2.jasaDiakrual.nilai).toBe(rp(4_000_000));
    // migrations/0025 and ADR 0015: `konfigurasi` is mutated in place, so the
    // per-row copy is the only way a closed period can say why its population
    // was its population.
    expect(a2.metode).toBe("ACCRUAL");
    expect(a2.kelasDiakrual).toEqual(["LANCAR", "KURANG_LANCAR"]);
    expect(l.metode).toEqual(["ACCRUAL"]);
  });

  test("baris dengan akrual NOL tetap tercetak", async () => {
    const l = await w.engine.akrualJasa(bulanan(), pusat);
    const a3 = l.baris.find((b) => b.akadId === w.akad.a3.id)!;
    // DIRAGUKAN is outside the accrued classes, so nothing accrued. Filtering
    // the row out would make a period where the step RAN and produced nothing
    // indistinguishable from a period where it never ran.
    expect(a3.kolektibilitas).toBe("DIRAGUKAN");
    expect(a3.jasaJatuhTempoPeriode.nilai).toBe(rp(1_000_000));
    expect(a3.jasaDiakrual.nilai).toBe(rp(0));
    expect(a3.jasaDiakrual.tampil).toBe("0,00");
  });

  test("total berkaki dan cocok dengan angka fixture", async () => {
    const l = await w.engine.akrualJasa(bulanan(), pusat);
    expect(l.total.jumlahAkad).toBe(3);
    expect(l.total.jatuhTempo.nilai).toBe(NILAI.akrualJatuhTempo);
    expect(l.total.diterima.nilai).toBe(NILAI.akrualDiterima);
    expect(l.total.diakrual.nilai).toBe(NILAI.akrualDiakrual);
    expect(jumlahUang(...l.baris.map((b) => b.jasaDiakrual.nilai))).toBe(
      l.total.diakrual.nilai,
    );
  });
});

// ---------------------------------------------------------------------------
// 31. Laporan Audit Trail
// ---------------------------------------------------------------------------

describe("Laporan 31: audit trail", () => {
  const filterDasar = () => ({ ...jendelaAudit, entitas: w.entitasAudit });

  test("terbaru dulu, dengan jumlah total sebelum paging", async () => {
    const l = await w.engine.auditTrail(filterDasar(), pusat);
    expect(l.header.namaLaporan).toBe(NAMA_LAPORAN_OPERASIONAL.AUDIT_TRAIL);
    expect(l.header.namaCabang).toBe("Semua Cabang");
    expect(l.baris.map((b) => b.entitasId)).toEqual(["x3", "x2", "x1"]);
    expect(l.baris.map((b) => b.aksi)).toEqual(["HAPUS", "UBAH", "BUAT"]);
    expect(l.jumlahTotal).toBe(3);
    expect(l.batas).toBe(BATAS_AUDIT_TRAIL_BAWAAN);
    expect(l.offset).toBe(0);
    expect(l.baris[0].waktu).toBe("2026-03-15T02:00:00Z");
    expect(l.baris[0].namaUser).toBe(w.d.namaUser.auditor);
    expect(l.baris[0].hasil).toBe("DITOLAK");
  });

  test("baris tanpa user DIKECUALIKAN, karena tidak bisa dikaitkan ke entitas", async () => {
    const l = await w.engine.auditTrail(filterDasar(), pusat);
    // `audit_log` carries neither `bumn_id` nor `cabang_id`; the actor's branch
    // is the only tie there is, so a NULL `user_id` belongs to no entity.
    // Including it would show one client's failed-login noise to another.
    expect(l.baris.every((b) => b.userId !== null)).toBe(true);
    expect(l.baris.map((b) => b.entitasId)).not.toContain(null);
  });

  test("jendela tanggal benar-benar memotong", async () => {
    const l = await w.engine.auditTrail(filterDasar(), pusat);
    expect(l.baris.map((b) => b.entitasId)).not.toContain("x4");
    const lebar = await w.engine.auditTrail(
      { ...filterDasar(), dariTanggal: "2026-02-01" },
      pusat,
    );
    expect(lebar.jumlahTotal).toBe(4);
  });

  test("filter user, aksi dan hasil masing-masing menyempitkan", async () => {
    const perUser = await w.engine.auditTrail(
      { ...filterDasar(), userId: w.d.userId.adminPusat },
      pusat,
    );
    expect(perUser.jumlahTotal).toBe(2);
    const perAksi = await w.engine.auditTrail({ ...filterDasar(), aksi: "UBAH" }, pusat);
    expect(perAksi.jumlahTotal).toBe(1);
    const perHasil = await w.engine.auditTrail({ ...filterDasar(), hasil: "DITOLAK" }, pusat);
    expect(perHasil.jumlahTotal).toBe(1);
    expect(perHasil.baris[0].entitasId).toBe("x3");
  });

  test("paging memotong halaman tapi TIDAK memotong jumlah total", async () => {
    const halaman = await w.engine.auditTrail({ ...filterDasar(), batas: 2 }, pusat);
    expect(halaman.baris).toHaveLength(2);
    expect(halaman.jumlahTotal).toBe(3);
    const berikutnya = await w.engine.auditTrail(
      { ...filterDasar(), batas: 2, offset: 2 },
      pusat,
    );
    expect(berikutnya.baris.map((b) => b.entitasId)).toEqual(["x1"]);
    expect(berikutnya.jumlahTotal).toBe(3);
    // The cap is the engine's own, not the caller's.
    const rakus = await w.engine.auditTrail({ ...filterDasar(), batas: 100_000 }, pusat);
    expect(rakus.batas).toBe(BATAS_AUDIT_TRAIL_MAKS);
  });

  test("PEMANGGIL SELINGKUP CABANG DITOLAK, bukan diberi jejak audit palsu", async () => {
    // There is no branch on a log row and the actor's branch is not the branch
    // of the row they touched, so a branch-scoped audit trail cannot be built
    // honestly. Filtering by the actor's home branch and calling the result
    // "Cabang A's audit trail" is a wrong answer presented as a right one.
    await tolakDengan(
      () => w.engine.auditTrail(filterDasar(), cabang),
      kodeAda(KODE_LAPORAN.CABANG_DILUAR_SCOPE),
    );
  });

  test("jendela terbalik dan tanggal tidak sah DITOLAK", async () => {
    await tolakDengan(
      () =>
        w.engine.auditTrail(
          { ...filterDasar(), dariTanggal: "2026-03-31", sampaiTanggal: "2026-03-01" },
          pusat,
        ),
      kodeAda(KODE_LAPORAN.TANGGAL_TIDAK_VALID),
    );
    await tolakDengan(
      () => w.engine.auditTrail({ ...filterDasar(), sampaiTanggal: "kemarin" }, pusat),
      kodeAda(KODE_LAPORAN.TANGGAL_TIDAK_VALID),
    );
  });

  test("tanggal cetak dan pencetaknya tetap dari jam dan sesi, bukan dari permintaan", async () => {
    const l = await w.engine.auditTrail(filterDasar(), pusat);
    expect(l.header.tanggalCetak).toBe(TANGGAL.cetak);
    expect(l.header.dicetakOleh).toBe(w.d.namaUser.adminPusat);
    expect(l.header.periodeId).toBeNull();
  });
});
