// SPESIFIKASI BAGIAN 16, "DEFINISI SELESAI", DIJALANKAN SEBAGAI BUKTI.
//
// Bagian 16 lists 24 scenarios and says the prototype is done when all of them
// "bisa dijalankan tanpa intervensi manual di database". This file runs them.
//
// FIVE RULES IT FOLLOWS, and each one is there because breaking it would make
// the run worth less than not doing it.
//
//   1. THROUGH THE SHIPPED SURFACE. Where an HTTP route exists, the scenario
//      goes through the route, with a real login, a real session cookie and the
//      real guard chain, against the app `core/app.ts` assembles for the server.
//      A scenario that passes through an engine and fails through its route is
//      exactly the defect this exercise exists to catch, and this repository has
//      already shipped modules whose error class was unregistered so that every
//      refusal became an anonymous 500 with no audit row.
//
//   2. WHERE THE SCENARIO NAMES A FIGURE, THE FIGURE IS ASSERTED. Where it
//      describes an outcome in words, the reading taken is written down in the
//      test name and in a comment, so a reader can disagree with the reading
//      rather than guess at it.
//
//   3. NO SCENARIO IS ASSERTED AS "DID NOT THROW". Every test below either
//      compares a number, a status, a state, or an explicit refusal code.
//
//   4. A SCENARIO WITH NO SHIPPED SURFACE IS A FINDING, NOT A SKIP. Scenario 10
//      was the case: there was no `/jurnal` router in `core/app.ts` at all, so
//      it was written below as a test that PROVED the absence, and the gap was
//      visible in the suite instead of being quietly missing from it.
//      `modules/jurnal/routes.ts` has since landed and the test is now the
//      scenario, run end to end. `test.skip` is not used anywhere in this file,
//      deliberately: a silent skip in an acceptance run is worse than a red
//      line, and a finding written as a passing test is worth more than either.
//
//   5. ONE WORLD, IN SCENARIO ORDER. Bagian 16's list is a narrative. Scenario 7
//      reads the card of the loan scenario 4 created; scenario 14 reads the
//      balance sheet of the month scenario 12 closed. `bun test` runs the tests
//      of one file in declaration order, and that order is the scenario order.
//
// RE-RUN: `bun test apps/api/src/penerimaan` from the REPO ROOT (the root
// bunfig.toml preload is what points the suite at `tjsl_test`). The world is
// built from nothing on every run, so it needs no seed and no demo data.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaSpec16, rp, tutupSemuaFixture, type DuniaSpec16, type MitraUji } from "./dunia";

let d: DuniaSpec16;

// --------------------------------------------------------------------------
// The figures this file asserts against, stated once, up front.
// --------------------------------------------------------------------------

/** What the Maker asks for, and what the Approver actually grants. */
const DIAJUKAN = rp(20_000_000);
const DISETUJUI = rp(12_000_000);
const TENOR = 12;

// FLAT at the shipped default rate (`jasa_adm.jasa_adm_rate_default` = 3%):
//   jasa  = 12.000.000 x 3%              =    360.000
//   total = 12.000.000 + 360.000         = 12.360.000
//   bulan = 12.360.000 / 12              =  1.030.000  (pokok 1.000.000 + jasa 30.000)
const TOTAL_KEWAJIBAN = 12_360_000;
const ANGSURAN_BULANAN = 1_030_000;
const SETORAN_KURANG = 500_000;
const KELEBIHAN = 100_000;

// Non PUMK, scenario 9.
const NP_DIAJUKAN = rp(50_000_000);
const NP_DISETUJUI = rp(40_000_000);
const NP_TERMIN_1 = rp(25_000_000);
const NP_TERMIN_2 = rp(15_000_000);
const NP_REALISASI = rp(32_000_000);
const NP_SISA = rp(8_000_000);

// The month every scenario 1..13 transaction lands in, and the month the
// reports of scenario 14..20 are read for.
const BULAN_TRANSAKSI = "2026-01";
const BULAN_LAPORAN = "2026-06";

interface Proposal {
  id: string;
  noProposal: string;
  status: string;
  currentStep: number;
  jumlahDiajukan?: string;
  tenorDiajukan?: number;
  sumberPengajuan?: string;
  portalSubmissionId?: string | null;
}
interface Akad {
  id: string;
  noAkad: string;
  pokokPinjaman: string;
  tenorBulan: number;
  jasaAdmRate: string;
  status: string;
  outstandingPokok: string;
  outstandingJasa: string;
}
interface Angka {
  nilai: string;
  tampil: string;
}
interface JurnalUmum {
  id: string;
  noJurnal: string;
  jenis: string;
  status: string;
  keterangan: string | null;
  totalDebit: string;
  totalKredit: string;
  reversalOfJurnalId: string | null;
  baris: Array<{ akunId: string; debit: string; kredit: string }>;
}

// State handed from one scenario to the next, exactly as an operator's day is.
let mitra1: MitraUji;
let proposal1 = "";
let akad1 = "";
let jurnalPencairan1 = "";
let akad2 = "";
let akad3 = "";
let proposalNonPumk = "";
let periodeTransaksi = "";
let periodeLaporan = "";

beforeAll(async () => {
  d = await buatDuniaSpec16();
  periodeTransaksi = d.periode.get(BULAN_TRANSAKSI)!;
  periodeLaporan = d.periode.get(BULAN_LAPORAN)!;
});

afterAll(async () => {
  await tutupSemuaFixture();
});

// ===========================================================================
// 1..4  Satu proposal PUMK, dari formulir Maker sampai uang keluar
// ===========================================================================

describe("Bagian 16", () => {
  test("skenario 1: Login sebagai Maker, input proposal PUMK baru, isi hasil survey, upload jaminan, ajukan ke Checker", async () => {
    mitra1 = await d.buatMitra({ nama: "Siti Rahmawati" });

    const proposal = await d.ok<Proposal>("MAKER", "/pumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        mitraId: mitra1.id,
        sektorId: d.sektorId,
        tanggalProposal: "2026-01-05",
        jumlahDiajukan: DIAJUKAN,
        tenorDiajukan: TENOR,
        tujuanPenggunaan: "Tambahan modal kerja warung sembako",
      },
    });
    expect(proposal.status).toBe("DRAFT");
    proposal1 = proposal.id;

    // "isi hasil survey": SURVEY_PENDING -> survey -> SURVEY_SELESAI.
    expect(
      (await d.ok<Proposal>("MAKER", `/pumk/proposal/${proposal1}/submit-survey`, {
        body: { catatan: "Berkas lengkap" },
      })).status,
    ).toBe("SURVEY_PENDING");

    expect(
      (await d.ok<Proposal>("MAKER", "/pumk/survey", {
        body: {
          proposalId: proposal1,
          tanggalSurvey: "2026-01-06",
          petugasKaryawanId: d.f.karyawanA,
          hasil: { karakter: 4, kapasitasUsaha: 4, tempatUsaha: 4, agunan: 3, riwayat: 4 },
          skorTotal: "85",
          plafonRekomendasi: rp(18_000_000),
          tenorRekomendasi: TENOR,
          catatan: "Usaha berjalan tiga tahun, omzet stabil",
        },
      })).status,
    ).toBe("SURVEY_SELESAI");

    // "upload jaminan". THE READING TAKEN: the scenario says upload a
    // collateral document, and the shipped surface for that is
    // `POST /pumk/proposal/:id/jaminan` recording the collateral plus
    // `POST /pumk/lampiran` for the file itself. The file half needs an object
    // store, so what is asserted here is the COLLATERAL ROW: after the call the
    // proposal's collateral list contains it with the value that was sent.
    await d.ok("MAKER", `/pumk/proposal/${proposal1}/jaminan`, {
      body: {
        jenis: "BPKB",
        deskripsi: "BPKB sepeda motor Honda Vario 2021",
        nilaiTaksasi: rp(9_000_000),
      },
    });
    const jaminan = await d.ok<{ data: Array<{ jenis: string; nilaiTaksasi: string }> }>(
      "MAKER",
      `/pumk/proposal/${proposal1}/jaminan`,
    );
    expect(jaminan.data).toHaveLength(1);
    expect(jaminan.data[0]!.jenis).toBe("BPKB");
    expect(jaminan.data[0]!.nilaiTaksasi).toBe(rp(9_000_000));

    expect(
      (await d.ok<Proposal>("MAKER", `/pumk/proposal/${proposal1}/ajukan-checker`, {
        body: { catatan: null },
      })).status,
    ).toBe("REVIEW_CHECKER");
  });

  test("skenario 2: Login sebagai Checker, review, beri rekomendasi", async () => {
    const direkomendasi = await d.ok<Proposal>("CHECKER", `/pumk/proposal/${proposal1}/review`, {
      body: {
        tanggal: "2026-01-07",
        keputusan: "REKOMENDASI",
        catatan: "Layak, plafon disarankan diturunkan",
      },
    });
    expect(direkomendasi.status).toBe("MENUNGGU_PERSETUJUAN");

    // Spec 2 rule 1, and the half of scenario 2 that matters: the Maker who
    // filed it cannot review it, and the refusal is the system's, not a hidden
    // button.
    const sendiri = await d.tolak("MAKER", `/pumk/proposal/${proposal1}/review`, {
      body: { tanggal: "2026-01-07", keputusan: "REKOMENDASI" },
    });
    expect(sendiri.status).toBeGreaterThanOrEqual(400);
  });

  test("skenario 3: Login sebagai Approver, setujui dengan plafon yang DIUBAH dari pengajuan", async () => {
    const disetujui = await d.ok<Proposal>("APPROVER", `/pumk/proposal/${proposal1}/persetujuan`, {
      body: {
        tanggal: "2026-01-08",
        keputusan: "SETUJU",
        plafonDisetujui: DISETUJUI,
        tenorDisetujui: TENOR,
        catatan: "Disetujui sebagian sesuai kapasitas angsuran",
      },
    });
    expect(disetujui.status).toBe("DISETUJUI");

    const detail = await d.ok<{
      proposal: { jumlahDiajukan: string };
      approval: { plafonDisetujui: string; tenorDisetujui: number };
    }>("MAKER", `/pumk/proposal/${proposal1}`);
    // The proposal still says what was ASKED (20.000.000); the approval carries
    // what was GRANTED (12.000.000). Both are on the screen, which is what lets
    // an officer explain the cut to the mitra.
    expect(detail.proposal.jumlahDiajukan).toBe(DIAJUKAN);
    expect(detail.approval.plafonDisetujui).toBe(DISETUJUI);
  });

  test("skenario 4: Login sebagai Maker, buat akad, generate jadwal angsuran, input pencairan", async () => {
    const akad = await d.ok<Akad>("MAKER", "/pumk/akad", {
      body: {
        proposalId: proposal1,
        tanggalAkad: "2026-01-09",
        tanggalMulaiAngsuran: "2026-02-10",
        gracePeriodBulan: 0,
      },
    });
    akad1 = akad.id;
    // The akad is built from the APPROVAL, not from the application.
    expect(akad.pokokPinjaman).toBe(DISETUJUI);
    expect(akad.pokokPinjaman).not.toBe(DIAJUKAN);
    expect(akad.jasaAdmRate).toBe("0.030000");
    expect(akad.status).toBe("BELUM_CAIR");

    const jadwal = await d.ok<{
      versi: number;
      baris: Array<{ angsuranKe: number; pokok: string; jasaAdm: string; total: string }>;
      ringkasan: { totalPokok: string; totalJasa: string; totalBayar: string };
    }>("MAKER", `/pumk/akad/${akad1}/jadwal`, { method: "POST" });
    expect(jadwal.versi).toBe(1);
    expect(jadwal.baris).toHaveLength(TENOR);
    expect(jadwal.ringkasan.totalPokok).toBe(DISETUJUI);
    expect(jadwal.ringkasan.totalJasa).toBe(rp(360_000));
    expect(jadwal.ringkasan.totalBayar).toBe(rp(TOTAL_KEWAJIBAN));
    expect(jadwal.baris[0]!.total).toBe(rp(ANGSURAN_BULANAN));
    expect(jadwal.baris[0]!.pokok).toBe(rp(1_000_000));
    expect(jadwal.baris[0]!.jasaAdm).toBe(rp(30_000));

    const pencairan = await d.ok<{ jurnalId: string; akad: Akad; proposal: Proposal }>(
      "MAKER",
      "/pumk/pencairan",
      {
        body: {
          akadId: akad1,
          tanggalPencairan: "2026-01-10",
          jumlah: DISETUJUI,
          akunKasId: d.akunKasId,
          noBukti: "BKK-SPEC16-001",
          keterangan: "Pencairan PUMK skenario 4",
        },
      },
    );
    jurnalPencairan1 = pencairan.jurnalId;
    expect(pencairan.akad.status).toBe("AKTIF");
    expect(pencairan.akad.outstandingPokok).toBe(DISETUJUI);
    expect(pencairan.proposal.status).toBe("DICAIRKAN");
  });

  test("skenario 5: Buka Buku Besar, konfirmasi jurnal pencairan muncul dengan akun yang benar", async () => {
    // The reading taken: "the right accounts" for a PUMK disbursement is
    // Piutang PUMK (1.1.03) DEBIT 12.000.000 against Kas (1.1.01) CREDIT
    // 12.000.000, and both legs must carry the journal id the disbursement
    // returned. Read through the report an officer opens, not off the table.
    const piutang = await d.ok<{
      akunKode: string;
      mutasi: Array<{ jurnalId: string; debit: Angka; kredit: Angka; noJurnal: string }>;
    }>(
      "ADMIN_PUSAT",
      `/laporan/buku-besar?periodeId=${periodeTransaksi}&akunId=${d.akunPiutangId}`,
    );
    const barisPiutang = piutang.mutasi.filter((b) => b.jurnalId === jurnalPencairan1);
    expect(piutang.akunKode).toBe("1.1.03");
    expect(barisPiutang).toHaveLength(1);
    expect(barisPiutang[0]!.debit.nilai).toBe(DISETUJUI);
    expect(barisPiutang[0]!.kredit.nilai).toBe(rp(0));
    expect(barisPiutang[0]!.noJurnal.length).toBeGreaterThan(0);

    const kas = await d.ok<{
      akunKode: string;
      mutasi: Array<{ jurnalId: string; debit: Angka; kredit: Angka }>;
    }>("ADMIN_PUSAT", `/laporan/buku-besar?periodeId=${periodeTransaksi}&akunId=${d.akunKasId}`);
    const barisKas = kas.mutasi.filter((b) => b.jurnalId === jurnalPencairan1);
    expect(kas.akunKode).toBe("1.1.01");
    expect(barisKas).toHaveLength(1);
    expect(barisKas[0]!.kredit.nilai).toBe(DISETUJUI);
    expect(barisKas[0]!.debit.nilai).toBe(rp(0));
  });

  test("skenario 6: tiga penerimaan angsuran, satu tepat, satu kurang, satu lebih; yang lebih masuk ke Kelebihan Pembayaran", async () => {
    // (a) TEPAT JUMLAH: exactly one instalment.
    const pas = await d.ok<{
      alokasiPokok: string;
      alokasiJasa: string;
      alokasiKelebihan: string;
      kelebihanId: string | null;
      akadSetelah: { outstandingPokok: string };
    }>("MAKER", "/pumk/angsuran", {
      body: {
        akadId: akad1,
        tanggalTerima: "2026-02-10",
        jumlah: rp(ANGSURAN_BULANAN),
        akunKasId: d.akunKasId,
        noBukti: "BKM-SPEC16-001",
      },
    });
    expect(pas.alokasiPokok).toBe(rp(1_000_000));
    expect(pas.alokasiJasa).toBe(rp(30_000));
    expect(pas.alokasiKelebihan).toBe(rp(0));
    expect(pas.kelebihanId).toBeNull();
    expect(pas.akadSetelah.outstandingPokok).toBe(rp(11_000_000));

    // (b) KURANG: the waterfall clears the due jasa first, then principal.
    const kurang = await d.ok<{
      alokasiPokok: string;
      alokasiJasa: string;
      alokasiKelebihan: string;
      urutanKomponenDipakai: string[];
      akadSetelah: { outstandingPokok: string };
    }>("MAKER", "/pumk/angsuran", {
      body: {
        akadId: akad1,
        tanggalTerima: "2026-03-10",
        jumlah: rp(SETORAN_KURANG),
        akunKasId: d.akunKasId,
        noBukti: "BKM-SPEC16-002",
      },
    });
    expect(kurang.alokasiJasa).toBe(rp(30_000));
    expect(kurang.alokasiPokok).toBe(rp(470_000));
    expect(kurang.alokasiKelebihan).toBe(rp(0));
    expect(kurang.urutanKomponenDipakai[0]).toBe("TUNGGAKAN_JASA");
    expect(kurang.akadSetelah.outstandingPokok).toBe(rp(10_530_000));

    // (c) LEBIH: everything still owed, plus 100.000.
    const sisaKewajiban = TOTAL_KEWAJIBAN - ANGSURAN_BULANAN - SETORAN_KURANG;
    const lebih = await d.ok<{
      alokasiKelebihan: string;
      kelebihanId: string | null;
      akadSetelah: { outstandingPokok: string; outstandingJasa: string; status: string };
    }>("MAKER", "/pumk/angsuran", {
      body: {
        akadId: akad1,
        tanggalTerima: "2027-01-10",
        jumlah: rp(sisaKewajiban + KELEBIHAN),
        akunKasId: d.akunKasId,
        noBukti: "BKM-SPEC16-003",
      },
    });
    // The surplus is a liability of its own. It is NOT a negative receivable:
    // invariant 10, and the whole point of this scenario.
    expect(lebih.alokasiKelebihan).toBe(rp(KELEBIHAN));
    expect(lebih.kelebihanId).not.toBeNull();
    expect(lebih.akadSetelah.outstandingPokok).toBe(rp(0));
    expect(lebih.akadSetelah.outstandingJasa).toBe(rp(0));
    expect(lebih.akadSetelah.status).toBe("LUNAS");
  });

  test("skenario 7: Buka Kartu Piutang mitra tersebut, konfirmasi jadwal, setoran, dan outstanding konsisten", async () => {
    const kartu = await d.ok<{
      akad: Akad;
      jadwal: Array<{ versi: number; isActiveVersion: boolean; baris: Array<{ total: string }> }>;
      setoran: Array<{ jumlahDiterima: string; jurnalId: string | null }>;
      kelebihan: Array<{ jumlah: string; status: string }>;
      outstanding: { pokok: string; jasa: string };
      saldoBukuBesar: string;
      selisihRekonsiliasi: string;
    }>("MAKER", `/pumk/kartu-piutang/${akad1}`);

    // The three things the scenario names, and the one that proves them.
    // `jadwal` is a list of VERSIONS; this loan has one, of twelve rows.
    expect(kartu.jadwal).toHaveLength(1);
    expect(kartu.jadwal[0]!.isActiveVersion).toBe(true);
    expect(kartu.jadwal[0]!.baris).toHaveLength(TENOR);
    expect(kartu.setoran).toHaveLength(3);
    for (const s of kartu.setoran) expect(s.jurnalId).not.toBeNull();
    const diterima = kartu.setoran.reduce((n, s) => n + Number(s.jumlahDiterima), 0);
    expect(diterima).toBe(TOTAL_KEWAJIBAN + KELEBIHAN);
    expect(kartu.outstanding.pokok).toBe(rp(0));
    expect(kartu.outstanding.jasa).toBe(rp(0));
    expect(kartu.kelebihan).toHaveLength(1);
    expect(kartu.kelebihan[0]!.jumlah).toBe(rp(KELEBIHAN));
    expect(kartu.kelebihan[0]!.status).toBe("TERTAHAN");
    // CONSISTENT means the sub-ledger and the posted general ledger agree.
    expect(kartu.saldoBukuBesar).toBe(rp(0));
    expect(kartu.selisihRekonsiliasi).toBe(rp(0));
  });

  test("skenario 8: ajukan reschedule untuk satu akad lain, setujui, jadwal versi baru terbentuk dan riwayat versi lama utuh", async () => {
    // "satu akad lain": a second borrower, disbursed the same way.
    const mitra2 = await d.buatMitra({ nama: "Budi Santoso" });
    akad2 = await jalurAkadPenuh(mitra2, {
      pokok: rp(24_000_000),
      tenor: 12,
      tanggalDasar: "2026-01",
      mulaiAngsuran: "2026-02-15",
      bukti: "BKK-SPEC16-002",
    });

    const jadwalLama = await d.ok<{
      data: Array<{ versi: number; isActiveVersion: boolean; baris: unknown[] }>;
    }>("MAKER", `/pumk/akad/${akad2}/jadwal`);
    expect(jadwalLama.data).toHaveLength(1);
    expect(jadwalLama.data[0]!.versi).toBe(1);
    const barisVersi1 = jadwalLama.data[0]!.baris.length;
    expect(barisVersi1).toBe(12);

    const usul = await d.ok<{ id: string; status: string }>("MAKER", "/pumk/reschedule", {
      body: {
        akadId: akad2,
        tanggalPengajuan: "2026-02-20",
        alasan: "Omzet turun karena renovasi pasar, mohon perpanjangan tenor",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: 18,
      },
    });
    expect(usul.status).toBe("DRAFT");

    const disetujui = await d.ok<{
      reschedule: { status: string };
      versiLama: number;
      versiBaru: number;
      jadwalBaru: { versi: number; baris: unknown[] };
      pokokTerbayarHistoris: string;
      outstandingBaru: string;
    }>("APPROVER", `/pumk/reschedule/${usul.id}/setujui`, { method: "POST" });
    expect(disetujui.reschedule.status).toBe("DISETUJUI");
    expect(disetujui.versiLama).toBe(1);
    expect(disetujui.versiBaru).toBe(2);
    // Spec 7.5 item 10: the restructure moves the schedule, never the contract
    // amount. What was already repaid plus what is still owed is still 24 juta.
    const pokokAsli =
      BigInt(disetujui.pokokTerbayarHistoris.replace(".", "")) +
      BigInt(disetujui.outstandingBaru.replace(".", ""));
    expect(pokokAsli).toBe(BigInt(rp(24_000_000).replace(".", "")));

    const jadwalBaru = await d.ok<{
      data: Array<{ versi: number; isActiveVersion: boolean; baris: Array<{ status?: string }> }>;
    }>("MAKER", `/pumk/akad/${akad2}/jadwal`);
    // TWO versions exist. The new one is live and has the new tenor; the old
    // one is still readable, row for row, which is what "riwayat versi lama
    // utuh" means.
    expect(jadwalBaru.data).toHaveLength(2);
    const v2 = jadwalBaru.data.find((v) => v.versi === 2)!;
    const v1 = jadwalBaru.data.find((v) => v.versi === 1)!;
    expect(v2.isActiveVersion).toBe(true);
    expect(v1.isActiveVersion).toBe(false);
    expect(v1.baris).toHaveLength(barisVersi1);
    expect(v2.baris.length).toBeGreaterThan(0);
  });

  test("skenario 9: proposal Non PUMK sampai disalurkan, LPJ dengan realisasi lebih kecil, jurnal pengembalian sisa terbentuk", async () => {
    const proposal = await d.ok<Proposal>("MAKER", "/nonpumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        tanggalProposal: "2026-01-05",
        namaPemohon: "Yayasan Cahaya Ilmu",
        atasNama: "Yayasan Cahaya Ilmu",
        bidangId: d.bidangA,
        sdg: [
          { sdgId: d.sdg1, bobot: "0.700000" },
          { sdgId: d.sdg2, bobot: "0.300000" },
        ],
        judulProgram: "Renovasi ruang kelas dan bantuan alat belajar",
        deskripsiProgram: "Perbaikan dua ruang kelas dan pengadaan alat belajar",
        jumlahDiajukan: NP_DIAJUKAN,
        penerimaManfaatEstimasi: 180,
      },
    });
    proposalNonPumk = proposal.id;

    await d.ok("MAKER", `/nonpumk/proposal/${proposalNonPumk}/ajukan-penilaian`, { body: {} });
    await d.ok("MAKER", `/nonpumk/proposal/${proposalNonPumk}/penilaian`, {
      body: {
        tanggal: "2026-01-06",
        skorTotal: "82.500000",
        nilaiRekomendasi: rp(45_000_000),
        hasil: { kelayakan: 4, urgensi: 5, dampak: 4, kesesuaianBidang: 5, kesesuaianSdg: 4 },
        catatan: "Sekolah aktif, proposal lengkap",
      },
    });
    await d.ok("CHECKER", `/nonpumk/proposal/${proposalNonPumk}/review`, {
      body: { tanggal: "2026-01-07", keputusan: "REKOMENDASI", catatan: "Layak" },
    });
    const disetujui = await d.ok<Proposal & { jumlahDisetujui: string }>(
      "APPROVER",
      `/nonpumk/proposal/${proposalNonPumk}/persetujuan`,
      {
        body: {
          tanggal: "2026-01-08",
          keputusan: "SETUJU",
          jumlahDisetujui: NP_DISETUJUI,
          catatan: "Disetujui dengan penyesuaian nilai",
        },
      },
    );
    expect(disetujui.jumlahDisetujui).toBe(NP_DISETUJUI);

    for (const [tanggal, jumlah, bukti] of [
      ["2026-01-12", NP_TERMIN_1, "BKK-NP-001"],
      ["2026-01-20", NP_TERMIN_2, "BKK-NP-002"],
    ] as const) {
      const t = await d.ok<{ jurnalId: string }>(
        "MAKER",
        `/nonpumk/proposal/${proposalNonPumk}/penyaluran`,
        {
          body: {
            tanggalPenyaluran: tanggal,
            jumlah,
            akunKasId: d.akunKasId,
            akunBebanId: d.akunBebanId,
            noBukti: bukti,
          },
        },
      );
      expect(t.jurnalId).toMatch(/^[0-9a-f-]{36}$/);
    }

    await d.ok("MAKER", `/nonpumk/proposal/${proposalNonPumk}/tutup-penyaluran`, {
      body: { catatan: "Seluruh termin selesai" },
    });

    const lpj = await d.ok<{ jumlahRealisasi: string; jumlahSisaDikembalikan: string; status: string }>(
      "MAKER",
      `/nonpumk/proposal/${proposalNonPumk}/lpj`,
      {
        body: {
          tanggalLpj: "2026-01-25",
          jumlahRealisasi: NP_REALISASI,
          penerimaManfaatAktual: 175,
          uraianRealisasi: "Dua ruang kelas selesai, sisa dana dikembalikan",
        },
      },
    );
    // 40.000.000 out, 32.000.000 spent, so 8.000.000 must come back. COMPUTED
    // by the engine, never taken from the form.
    expect(lpj.jumlahRealisasi).toBe(NP_REALISASI);
    expect(lpj.jumlahSisaDikembalikan).toBe(NP_SISA);
    expect(lpj.status).toBe("DIAJUKAN");

    const diverifikasi = await d.ok<{ status: string; jurnalIdPengembalian: string | null }>(
      "CHECKER",
      `/nonpumk/proposal/${proposalNonPumk}/lpj/verifikasi`,
      {
        body: {
          tanggalVerifikasi: "2026-01-28",
          akunKasId: d.akunKasId,
          catatan: "LPJ lengkap, sisa dana sudah masuk rekening",
        },
      },
    );
    expect(diverifikasi.status).toBe("DIVERIFIKASI");
    // THE FIGURE SCENARIO 9 NAMES: the return journal exists.
    expect(diverifikasi.jurnalIdPengembalian).toMatch(/^[0-9a-f-]{36}$/);

    const detail = await d.ok<{
      proposal: { status: string };
      bebanBersihBukuBesar: string;
      kasBersihBukuBesar: string;
    }>("MAKER", `/nonpumk/proposal/${proposalNonPumk}`);
    expect(detail.proposal.status).toBe("SELESAI");
    // Read from the POSTED ledger, not recomputed: what the entity actually
    // spent on this programme is the realisation, not the disbursement.
    expect(detail.bebanBersihBukuBesar).toBe(NP_REALISASI);
    expect(detail.kasBersihBukuBesar).toBe(`-${NP_REALISASI}`);
  });

  // =========================================================================
  // 10  Jurnal Umum manual, lalu "Hapus Jurnal Transaksi"
  // =========================================================================

  test("skenario 10: input Jurnal Umum manual, posting, lalu Hapus Jurnal Transaksi menghasilkan jurnal PEMBALIK, bukan penghapusan", async () => {
    // WAS A FINDING, NOW A SCENARIO. Until `modules/jurnal/routes.ts` landed,
    // `core/app.ts` mounted fifteen routers and `/jurnal` was not among them,
    // so spec 9.4's "Input Jurnal Umum", its posting and the "Hapus Jurnal
    // Transaksi" utility had no shipped surface at all: the single most
    // important accounting control in the product could not be reached by a
    // person, and this test asserted the four 404s that proved it. It now runs
    // the scenario through the door instead.
    //
    // Three roles, three acts, because that is what the control IS: the Maker
    // files, the Checker verifies, the Approver posts. None of the three can do
    // another's part, and ../modules/jurnal/jurnal-rute-otorisasi.test.ts pins
    // each refusal; what is asserted here is the happy path an operator walks.
    const dibuat = await d.ok<JurnalUmum>("MAKER", "/jurnal", {
      body: {
        cabangId: d.f.cabangA.id,
        jenis: "UMUM",
        tanggalTransaksi: "2026-01-29",
        keterangan: "Reklasifikasi beban administrasi Januari (skenario 10)",
        baris: [
          { akunId: d.akunBebanId, debit: rp(750_000), keterangan: "Beban administrasi" },
          { akunId: d.akunKasId, kredit: rp(750_000), keterangan: "Kas keluar" },
        ],
      },
    });
    expect(dibuat.status).toBe("DRAFT");
    expect(dibuat.jenis).toBe("UMUM");
    expect(dibuat.noJurnal).toMatch(/^UMUM\/202601\/\d{5}$/);
    expect(dibuat.totalDebit).toBe(rp(750_000));
    expect(dibuat.totalKredit).toBe(rp(750_000));

    await d.ok<JurnalUmum>("CHECKER", `/jurnal/${dibuat.id}/verifikasi`, { body: {} });
    const diposting = await d.ok<JurnalUmum>("APPROVER", `/jurnal/${dibuat.id}/posting`, {
      body: {},
    });
    expect(diposting.status).toBe("POSTED");

    // "HAPUS JURNAL TRANSAKSI". The screen is called delete; what the system
    // does is spec 6.3's correction by reversing entry, and the 201 says so: a
    // document EXISTS afterwards that did not before.
    const res = await d.panggil("APPROVER", `/jurnal/${dibuat.id}/pembalik`, {
      body: { alasan: "Salah akun beban, dikoreksi lewat jurnal pembalik (skenario 10)" },
    });
    expect(res.status).toBe(201);
    const pembalik = (await res.json()) as JurnalUmum;

    expect(pembalik.jenis).toBe("REVERSAL");
    expect(pembalik.status).toBe("POSTED");
    expect(pembalik.reversalOfJurnalId).toBe(dibuat.id);
    // Same amounts to the sen, sides swapped line for line, and the original's
    // document number quoted so the pair is readable on paper.
    expect(pembalik.totalDebit).toBe(rp(750_000));
    expect(pembalik.totalKredit).toBe(rp(750_000));
    expect(pembalik.keterangan).toContain(dibuat.noJurnal);
    const bebanDibalik = pembalik.baris.find((b) => b.akunId === d.akunBebanId)!;
    expect([bebanDibalik.debit, bebanDibalik.kredit]).toEqual([rp(0), rp(750_000)]);

    // AND THE ORIGINAL IS STILL THERE. ADR 0010: two rows added, none removed.
    // A deletion would have taken the document out of every report while its
    // lines stayed in the ledger; this is why the screen is not a delete.
    const asli = await d.ok<JurnalUmum & { dibalikOleh: { noJurnal: string } | null }>(
      "AUDITOR",
      `/jurnal/${dibuat.id}`,
    );
    expect(asli.status).toBe("REVERSED");
    expect(asli.dibalikOleh?.noJurnal).toBe(pembalik.noJurnal);

    // Reversing it a second time is refused, by name (spec 6.6.7).
    const lagi = await d.tolak("APPROVER", `/jurnal/${dibuat.id}/pembalik`, {
      body: { alasan: "Percobaan membalik dokumen yang sudah dibalik" },
    });
    expect([lagi.status, lagi.kodeDomain]).toEqual([409, "JURNAL_SUDAH_REVERSED"]);
  });

  // =========================================================================
  // 11..13  Closing
  // =========================================================================

  test("skenario 11: Closing Kolektibilitas dengan preview dulu, lihat ringkasan perpindahan klasifikasi, lalu commit", async () => {
    // A third borrower who never pays, so the classification has something to
    // move and the allowance of scenario 17 is not identically zero.
    const mitra3 = await d.buatMitra({ nama: "Rina Kusuma" });
    akad3 = await jalurAkadPenuh(mitra3, {
      pokok: rp(15_000_000),
      tenor: 12,
      tanggalDasar: "2026-01",
      mulaiAngsuran: "2026-02-05",
      bukti: "BKK-SPEC16-003",
    });

    const sebelum = await hitungSnapshot(periodeTransaksi);

    const pratinjau = await d.ok<{
      tersimpan: boolean;
      totalAkadDiproses: number;
      matriks: Array<{ dari: string | null; ke: string; jumlahAkad: number }>;
      ringkasanPerKelas: Array<{ kelas: string; jumlahAkad: number }>;
      baris: Array<{ akadId: string; kolektibilitas: string }>;
    }>("APPROVER", `/closing/periode/${periodeTransaksi}/kolektibilitas/pratinjau`, { body: {} });
    expect(pratinjau.tersimpan).toBe(false);
    // TWO, not three: akad 1 was settled by scenario 6's over-payment, and the
    // classification only measures LIVE loans. Recorded rather than asserted
    // away, because it is a real property of this engine: kolektibilitas is
    // computed from the akad as it stands NOW, so a loan settled in a later
    // month leaves no row in an earlier month's snapshot.
    expect(pratinjau.totalAkadDiproses).toBe(2);
    expect(pratinjau.baris.map((b) => b.akadId).sort()).toEqual([akad2, akad3].sort());
    // "ringkasan perpindahan klasifikasi": every akad is new, so every cell
    // moves from nothing into LANCAR (nothing is yet due on 2026-01-31).
    expect(pratinjau.matriks.length).toBeGreaterThan(0);
    for (const sel of pratinjau.matriks) expect(sel.dari).toBeNull();
    expect(pratinjau.matriks.map((s) => s.ke)).toContain("LANCAR");
    // A PREVIEW WRITES NOTHING. That is the whole difference between the two
    // calls, and it is the reason spec 8.1 makes the preview mandatory.
    expect(await hitungSnapshot(periodeTransaksi)).toBe(sebelum);

    const komit = await d.panggil("APPROVER", `/closing/periode/${periodeTransaksi}/kolektibilitas`, {
      body: {},
    });
    expect(komit.status).toBe(201);
    const hasil = (await komit.json()) as { tersimpan: boolean; closingId: string };
    expect(hasil.tersimpan).toBe(true);
    expect(await hitungSnapshot(periodeTransaksi)).toBe(pratinjau.totalAkadDiproses);
  });

  test("skenario 12: Closing Periode ditolak karena satu jurnal DRAFT, dengan alasan yang jelas; setelah diposting, closing berhasil", async () => {
    // Steps 8.2 and 8.3 first: the checklist demands them and this scenario is
    // about check 2, not about a half-prepared month.
    await d.ok("APPROVER", `/closing/periode/${periodeTransaksi}/penyisihan`, { body: {} });
    await d.ok("APPROVER", `/closing/periode/${periodeTransaksi}/akrual`, { body: {} });

    // THIS USED TO BE THE ONE PLACE THE FILE LEFT HTTP, AND IT WAS FORCED:
    // there was no route that created a journal (see scenario 10), so the DRAFT
    // this scenario needs had to be made by reaching past the app into the
    // engine. `modules/jurnal/routes.ts` has landed, so it is a Maker filing a
    // form now, exactly as an operator would leave one unposted at month end.
    const draft = await d.ok<JurnalUmum>("MAKER", "/jurnal", {
      body: {
        cabangId: d.f.cabangA.id,
        jenis: "UMUM",
        tanggalTransaksi: "2026-01-30",
        keterangan: "Jurnal umum manual yang sengaja ditinggal DRAFT (skenario 12)",
        baris: [
          { akunId: d.akunBebanId, debit: rp(250_000), keterangan: "Beban operasional" },
          { akunId: d.akunKasId, kredit: rp(250_000), keterangan: "Kas keluar" },
        ],
      },
    });
    expect(draft.status).toBe("DRAFT");

    const prasyaratMerah = await d.ok<{
      boleh: boolean;
      hasil: Array<{ nomor: number; kode: string; status: string; alasan: string; detail: Record<string, unknown> }>;
    }>("ADMIN_PUSAT", `/closing/periode/${periodeTransaksi}/prasyarat`);
    expect(prasyaratMerah.hasil).toHaveLength(10);
    const cek2 = prasyaratMerah.hasil.find((h) => h.kode === "ADA_JURNAL_DRAFT")!;
    expect(cek2.nomor).toBe(2);
    expect(cek2.status).toBe("GAGAL");
    // "dengan alasan yang jelas": readable Indonesian that names the document,
    // not a trigger code.
    expect(cek2.alasan.length).toBeGreaterThan(10);
    expect(JSON.stringify(cek2.detail)).toContain(draft.noJurnal);
    expect(prasyaratMerah.boleh).toBe(false);

    const ditolak = await d.tolak("ADMIN_PUSAT", `/closing/periode/${periodeTransaksi}/tutup`, {
      body: { konfirmasiKasNegatif: true },
    });
    expect(ditolak.status).toBeGreaterThanOrEqual(400);
    expect(ditolak.status).toBeLessThan(500);
    expect(ditolak.kodeDomain).toBe("PRASYARAT_GAGAL");

    // Post it, through the shipped route and as the role that holds the code,
    // and the month closes.
    await d.ok("CHECKER", `/jurnal/${draft.id}/verifikasi`, { body: {} });
    const diposting = await d.ok<JurnalUmum>("APPROVER", `/jurnal/${draft.id}/posting`, {
      body: {},
    });
    expect(diposting.status).toBe("POSTED");

    const prasyaratHijau = await d.ok<{
      boleh: boolean;
      perluKonfirmasi: boolean;
      hasil: Array<{ kode: string; status: string }>;
    }>("ADMIN_PUSAT", `/closing/periode/${periodeTransaksi}/prasyarat`);
    expect(prasyaratHijau.boleh).toBe(true);
    expect(prasyaratHijau.hasil.filter((h) => h.status === "GAGAL")).toEqual([]);

    const hasil = await d.ok<{
      periode: { status: string; closedAt: string | null };
      prasyarat: { boleh: boolean };
      saldo: Array<{ akunKode: string }>;
    }>("ADMIN_PUSAT", `/closing/periode/${periodeTransaksi}/tutup`, {
      body: { konfirmasiKasNegatif: true },
    });
    expect(hasil.periode.status).toBe("CLOSED");
    expect(hasil.periode.closedAt).not.toBeNull();
    expect(hasil.saldo.length).toBeGreaterThan(0);
  });

  test("skenario 13: posting jurnal bertanggal di periode yang sudah ditutup ditolak", async () => {
    // Through a shipped write route, because that is where an operator would
    // hit it: a receipt back-dated into January, which is now closed.
    const ditolak = await d.tolak("MAKER", "/pumk/angsuran", {
      body: {
        akadId: akad2,
        tanggalTerima: "2026-01-20",
        jumlah: rp(1_000_000),
        akunKasId: d.akunKasId,
        noBukti: "BKM-SPEC16-TOLAK",
      },
    });
    expect(ditolak.status).toBe(409);

    // WAS A TEMUAN, NOW CLOSED, AND THE INVERTED ASSERTION IS THE PROOF.
    //
    // The scenario always asked for a refusal and always got one. What the
    // operator was TOLD was another matter: `modules/angsuran` turned the
    // ledger's refusal into `JURNAL_GAGAL` and `modules/pumk`'s `lewatSetoran`
    // turned THAT into `SETORAN_GAGAL`, so the journal engine's
    // `PERIODE_TIDAK_OPEN` -- the one fact that tells the clerk to ask head
    // office to reopen January rather than to retype the receipt and fail again
    // -- was confined to `penyebabDb`, which is server-log only. Two layers of
    // flattening, and the refusal arrived anonymous.
    //
    // Both layers now re-raise a refusal that is safe to re-raise
    // (`core/sebab-kolaborator.ts`, three rules, and the codes that must NOT
    // travel are named there: a branch-scope refusal, because it would rebuild
    // the enumeration oracle one module up, and a malformed-journal refusal,
    // because it blames an operator for arithmetic they did not do). So the
    // ledger's own code crosses two module boundaries without either module
    // knowing the other exists.
    expect(ditolak.kodeDomain).toBe("PERIODE_TIDAK_OPEN");
    // And the sentence with it, which is what the clerk actually reads.
    expect(ditolak.error).toContain("periode yang masih terbuka");
    // Still free of driver and trigger internals: `penyebabDb` never leaves the
    // server log.
    expect(ditolak.error).not.toContain("TJSL-");

    // AND THE PROOF THAT THE CLOSED PERIOD IS WHAT REFUSED IT. The same date,
    // straight at the ledger engine the route reaches through: the engine names
    // the reason, and it is the route that loses it on the way out.
    let kodeEngine = "";
    try {
      await d.f.ctx.jurnal.buatJurnal(
        {
          cabangId: d.f.cabangA.id,
          jenis: "UMUM",
          tanggalTransaksi: "2026-01-20",
          keterangan: "Percobaan menulis ke periode tertutup",
          baris: [
            { akunId: d.akunBebanId, debit: rp(1_000) },
            { akunId: d.akunKasId, kredit: rp(1_000) },
          ],
        },
        {
          userId: d.f.users.MAKER.id,
          cabangId: d.f.cabangA.id,
          bumnId: d.f.bumnId,
          permissions: ["jurnal.create"],
          cabangDalamScope: [d.f.cabangA.id],
        },
      );
    } catch (err) {
      kodeEngine = (err as { kode?: string }).kode ?? "";
    }
    expect(kodeEngine).toBe("PERIODE_TIDAK_OPEN");
  });

  // =========================================================================
  // 14..20  Laporan
  // =========================================================================

  test("prasyarat 14..20: lima bulan berikutnya ditutup, supaya laporan dibaca di bulan yang punya tunggakan", async () => {
    // Not a scenario of its own. Scenario 17 is only meaningful once an akad
    // has aged into a class with a non-zero allowance rate, and that needs the
    // calendar to move. Each month goes through the SAME four HTTP calls an
    // operator makes: kolektibilitas, penyisihan, akrual, tutup.
    for (const bulan of ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
      const id = d.periode.get(bulan)!;
      const kol = await d.panggil("APPROVER", `/closing/periode/${id}/kolektibilitas`, { body: {} });
      expect(kol.status).toBe(201);
      await d.ok("APPROVER", `/closing/periode/${id}/penyisihan`, { body: {} });
      await d.ok("APPROVER", `/closing/periode/${id}/akrual`, { body: {} });
      const tutup = await d.panggil("ADMIN_PUSAT", `/closing/periode/${id}/tutup`, {
        body: { konfirmasiKasNegatif: true },
      });
      expect([bulan, tutup.status]).toEqual([bulan, 200]);
    }
    const periode = await d.ok<{ data: Array<{ id: string; status: string }> }>(
      "AUDITOR",
      "/laporan/periode?tahun=2026",
    );
    expect(periode.data.find((p) => p.id === periodeLaporan)!.status).toBe("CLOSED");
  });

  test("skenario 14: Laporan Posisi Keuangan, Total Aset = Total Liabilitas + Aset Neto", async () => {
    const l = await d.ok<{
      header: { sumberData: string };
      totalAsetTahunIni: Angka;
      totalLiabilitasTahunIni: Angka;
      totalAsetNetoTahunIni: Angka;
      totalLiabilitasDanAsetNetoTahunIni: Angka;
    }>("AUDITOR", `/laporan/posisi-keuangan?periodeId=${periodeLaporan}`);

    // A closed month is read from the frozen balances, not recomputed.
    expect(l.header.sumberData).toBe("SNAPSHOT_PERIODE");
    // THE IDENTITY, on the decimal strings, not on floats.
    expect(l.totalAsetTahunIni.nilai).toBe(l.totalLiabilitasDanAsetNetoTahunIni.nilai);
    const kiri = BigInt(l.totalAsetTahunIni.nilai.replace(".", ""));
    const kanan =
      BigInt(l.totalLiabilitasTahunIni.nilai.replace(".", "")) +
      BigInt(l.totalAsetNetoTahunIni.nilai.replace(".", ""));
    expect(kiri).toBe(kanan);
  });

  test("skenario 15: Laporan Arus Kas, Kas Akhir = saldo Kas dan Setara Kas di Laporan Posisi Keuangan", async () => {
    const arus = await d.ok<{ kasAkhirTahunIni: Angka }>(
      "AUDITOR",
      `/laporan/arus-kas?periodeId=${periodeLaporan}`,
    );
    const posisi = await d.ok<{ kasDanSetaraKasTahunIni: Angka }>(
      "AUDITOR",
      `/laporan/posisi-keuangan?periodeId=${periodeLaporan}`,
    );
    expect(arus.kasAkhirTahunIni.nilai).toBe(posisi.kasDanSetaraKasTahunIni.nilai);
  });

  test("skenario 16: Buka Neraca Lajur, konfirmasi ketiga pasang kolom balance", async () => {
    const n = await d.ok<{
      baris: unknown[];
      total: {
        saldoAwalDebit: Angka;
        saldoAwalKredit: Angka;
        mutasiDebit: Angka;
        mutasiKredit: Angka;
        saldoAkhirDebit: Angka;
        saldoAkhirKredit: Angka;
      };
    }>("AUDITOR", `/laporan/neraca-lajur?periodeId=${periodeLaporan}`);
    expect(n.baris.length).toBeGreaterThan(0);
    expect(n.total.saldoAwalDebit.nilai).toBe(n.total.saldoAwalKredit.nilai);
    expect(n.total.mutasiDebit.nilai).toBe(n.total.mutasiKredit.nilai);
    expect(n.total.saldoAkhirDebit.nilai).toBe(n.total.saldoAkhirKredit.nilai);
  });

  test("skenario 17: Laporan Perhitungan Penyisihan, totalnya merekonstruksi nilai jurnal penyisihan periode itu", async () => {
    const l = await d.ok<{
      total: { jumlahAkad: number; nilaiPenyisihan: Angka };
      penyisihanDibutuhkanRun: Angka;
      selisihTerhadapRun: Angka;
    }>("ADMIN_PUSAT", `/laporan/perhitungan-penyisihan?periodeId=${periodeLaporan}`);

    // The report footing and the closing run that produced the journal agree.
    expect(l.selisihTerhadapRun.nilai).toBe(rp(0));
    expect(l.total.nilaiPenyisihan.nilai).toBe(l.penyisihanDibutuhkanRun.nilai);
    // And it is not vacuous: by June the never-paying akad has aged out of
    // LANCAR, so the allowance is a real number.
    expect(Number(l.total.nilaiPenyisihan.nilai)).toBeGreaterThan(0);

    // RECONSTRUCT IT FROM THE LEDGER, which is what the scenario actually asks:
    // the cumulative balance of the allowance account at period end must equal
    // the report's footing.
    const akunPenyisihan = d.akunKode.get("1.1.05");
    expect(akunPenyisihan).toBeTruthy();
    const saldo = await d.f.db.query<{ saldo: string }>(
      `SELECT COALESCE(SUM(v.kredit - v.debit), 0)::text AS saldo
         FROM v_ledger_baris v
        WHERE v.akun_id = $1::uuid
          AND v.cabang_id = ANY($2::uuid[])
          AND v.tanggal_transaksi <= $3::date`,
      [akunPenyisihan, [d.f.cabangA.id, d.f.cabangB.id, d.f.pusat.id], "2026-06-30"],
    );
    expect(Number(saldo[0]!.saldo)).toBeCloseTo(Number(l.total.nilaiPenyisihan.nilai), 2);
  });

  test("skenario 18: Laporan RKA versus Realisasi, angka realisasi cocok dengan total di laporan penyaluran", async () => {
    // A budget has to exist before it can be compared against. Drafted by one
    // head-office account and approved by the OTHER, because
    // `rka.pemisahan_tugas_persetujuan` refuses a self-approval.
    const rka = await d.ok<{ id: string; versi: number; status: string }>("ADMIN_PUSAT", "/rka", {
      body: {
        tahun: 2026,
        jenis: "PUMK",
        keterangan: "RKA PUMK 2026 (spec 16 skenario 18)",
        baris: [
          {
            sektorId: d.sektorId,
            uraian: "Penyaluran PUMK sektor perdagangan",
            bulan: 1,
            jumlahAnggaran: rp(60_000_000),
            jumlahUnit: 4,
          },
        ],
      },
    });
    const disetujui = await d.ok<{ status: string }>(
      "ADMIN_PUSAT_2",
      `/rka/${rka.id}/setujui`,
      { body: { tanggal: "2026-01-02", catatan: "Disahkan" } },
    );
    expect(disetujui.status).toBe("DISETUJUI");

    const laporan24 = await d.ok<{
      statusRka: string;
      total: { anggaran: string; realisasi: string };
      baris: Array<{ sumberRealisasi: string }>;
    }>("ADMIN_PUSAT", `/rka/laporan/realisasi?tahun=2026&jenis=PUMK&mode=BULANAN&bulan=1`);
    expect(laporan24.statusRka).toBe("DISETUJUI");

    const penyaluran = await d.ok<{ totalKeseluruhan: { nilai: Angka } }>(
      "ADMIN_PUSAT",
      `/laporan/penyaluran-nasional?periodeId=${periodeTransaksi}&mode=BULANAN`,
    );

    // THE FIGURE: three loans were disbursed in January for 12.000.000 +
    // 24.000.000 + 15.000.000 = 51.000.000, and report 24's realisation column
    // must be that same number, read from the FROZEN dimension balances of a
    // closed month rather than re-derived from master data.
    expect(penyaluran.totalKeseluruhan.nilai.nilai).toBe(rp(51_000_000));
    expect(laporan24.total.realisasi).toBe(penyaluran.totalKeseluruhan.nilai.nilai);
    expect(laporan24.total.anggaran).toBe(rp(60_000_000));
  });

  test("skenario 19: Buka Tools Rekonsiliasi, sub ledger piutang cocok dengan buku besar, selisih nol", async () => {
    const rek = await d.ok<{
      cocok: boolean;
      jumlahAkadDiperiksa: number;
      jumlahAkadSelisih: number;
      totalSubLedger: string;
      totalBukuBesar: string;
      totalSelisih: string;
      baris: unknown[];
    }>("ADMIN_CABANG", "/tools/rekonsiliasi/piutang");
    expect(rek.jumlahAkadDiperiksa).toBeGreaterThanOrEqual(2);
    expect(rek.totalSelisih).toBe(rp(0));
    expect(rek.totalSubLedger).toBe(rek.totalBukuBesar);
    expect(rek.jumlahAkadSelisih).toBe(0);
    expect(rek.baris).toEqual([]);
    expect(rek.cocok).toBe(true);
  });

  test("skenario 19b: Auditor boleh membuka Rekonsiliasi dan Integritas, dan TETAP tidak boleh impor", async () => {
    // This ran as a FINDING and is now the inverted assertion. The Auditor
    // held neither code, so the reconciliation an auditor asks for first was
    // the one read-only screen refused to the role scenario 23 describes as
    // opening everything. Granted 2026-09-02: every route on modules/tools is
    // a GET and the module is composed with no journal port and no audit port,
    // so there was no write path being withheld.
    expect((await d.panggil("AUDITOR", "/tools/rekonsiliasi/piutang")).status).toBe(200);
    expect((await d.panggil("AUDITOR", "/tools/integritas")).status).toBe(200);

    // The half that must NOT move. `tools.import` is the WRITING half of spec
    // 9.6 and stays with the Maker, so widening the read did not widen the
    // role. Asserted in the same test as the grant, because a grant and the
    // boundary it must not cross belong in one place.
    const impor = await d.panggil("AUDITOR", "/impor/MITRA/pratinjau", {
      method: "POST",
      body: { namaBerkas: "x.csv", isiBase64: btoa("a\n") },
    });
    expect(impor.status).toBe(403);
  });

  test("skenario 20: export lima laporan ke Excel, dan ke PDF", async () => {
    const lima = [
      ["POSISI_KEUANGAN", `periodeId=${periodeLaporan}`],
      ["ARUS_KAS", `periodeId=${periodeLaporan}`],
      ["NERACA_LAJUR", `periodeId=${periodeLaporan}`],
      ["PERHITUNGAN_PENYISIHAN", `periodeId=${periodeLaporan}`],
      ["PENERIMAAN_ANGSURAN", `periodeId=${periodeLaporan}&mode=BULANAN`],
    ] as const;

    for (const [kode, filter] of lima) {
      const xlsx = await d.panggil("AUDITOR", `/laporan/ekspor/${kode}?${filter}&format=xlsx`);
      expect([kode, xlsx.status]).toEqual([kode, 200]);
      expect(xlsx.headers.get("content-disposition")).toContain("attachment");
      const isi = new Uint8Array(await xlsx.arrayBuffer());
      // A real .xlsx is a ZIP: "PK\x03\x04". An empty or HTML body would not be.
      expect([kode, isi[0], isi[1]]).toEqual([kode, 0x50, 0x4b]);
      expect(isi.byteLength).toBeGreaterThan(1000);

      const html = await d.panggil("AUDITOR", `/laporan/ekspor/${kode}?${filter}&format=html`);
      expect([kode, html.status]).toEqual([kode, 200]);
      expect((await html.text()).toLowerCase()).toContain("<table");
    }

    // PDF. On a host with no browser binary the adapter reports unavailable and
    // the route answers 503 with the instruction to print the HTML export; on a
    // host with `CHROMIUM_PATH` it answers 200 with a PDF. BOTH are accepted
    // here and the branch taken is asserted, because "export to PDF" as a
    // shippable feature depends on an image that does not yet carry Chromium.
    const pdf = await d.panggil(
      "AUDITOR",
      `/laporan/ekspor/POSISI_KEUANGAN?periodeId=${periodeLaporan}&format=pdf`,
    );
    if (pdf.status === 200) {
      const isi = new Uint8Array(await pdf.arrayBuffer());
      expect(new TextDecoder().decode(isi.slice(0, 5))).toBe("%PDF-");
    } else {
      expect(pdf.status).toBe(503);
      const body = (await pdf.json()) as { kodeDomain?: string; error?: string };
      expect(body.kodeDomain).toBe("EKSPOR_PDF_TIDAK_TERSEDIA");
      expect((body.error ?? "").toLowerCase()).toContain("html");
    }
  });

  test("skenario 20b: angka ringkasan tercetak sebagai angka, dan kolom internal MASIH ikut tercetak", async () => {
    // THIS IS THE HALF OF SCENARIO 20 THAT FAILS. The scenario does not stop at
    // "the file downloads": it says "buka hasilnya, konfirmasi formatnya layak
    // diserahkan ke manajemen".
    //
    // Open one. Every TOP-LEVEL figure of the statement -- Total Aset, Total
    // Liabilitas, Aset Neto, Kas dan Setara Kas, and their comparatives --
    // prints as the literal text `[object Object]`, in the Excel file and in
    // the HTML (and therefore in the PDF, on a host that can make one).
    //
    // WHERE IT IS. `core/ekspor/dokumen.ts`, `dokumenDariLaporan`. Its
    // `objekBiasa()` deliberately EXCLUDES an `Angka` (`!adalahAngka(v)`), so a
    // money object sitting directly on the result -- rather than inside a
    // nested object or a row array -- misses the `ratakan()` branch and falls
    // through to the last line of the loop, which is
    // `String(v)` for a scalar. `String({nilai, tampil})` is `[object Object]`.
    // Six of the thirty reports are hit, and they are the six an entity hands
    // upward: 17 Aktivitas, 18 Arus Kas, 19 Posisi Keuangan, 20 Perubahan Aset
    // Neto, 22 Buku Besar, 28 Perhitungan Penyisihan.
    //
    // CLOSED 2026-09-02 in `core/ekspor/dokumen.ts`, by giving a top-level
    // `Angka` its own branch ahead of the scalar fallback. This assertion is
    // the inverted one: no exported statement may contain that string, and the
    // headline figure must print as a formatted number.
    //
    // Kept in the acceptance suite rather than deleted. The defect was
    // invisible to every test that read the engine's JSON, because the engine
    // was always right; only opening the FILE showed it. A regression would be
    // invisible the same way.
    const kena: string[] = [];
    for (const kode of [
      "AKTIVITAS",
      "ARUS_KAS",
      "POSISI_KEUANGAN",
      "PERUBAHAN_ASET_NETO",
      "PERHITUNGAN_PENYISIHAN",
    ]) {
      const res = await d.panggil(
        "AUDITOR",
        `/laporan/ekspor/${kode}?periodeId=${periodeLaporan}&format=html`,
      );
      expect([kode, res.status]).toEqual([kode, 200]);
      const html = await res.text();
      if (html.includes("[object Object]")) kena.push(kode);
    }
    expect(kena).toEqual([]);

    // Not merely "the bad string is gone": the figure has to be THERE. A
    // formatter that dropped the value entirely would also pass the check
    // above, and would be a worse defect than the one being fixed.
    const posisi = await (
      await d.panggil(
        "AUDITOR",
        `/laporan/ekspor/POSISI_KEUANGAN?periodeId=${periodeLaporan}&format=html`,
      )
    ).text();
    const totalAset = /<td>Total Aset[^<]*<\/td><td[^>]*>([^<]*)<\/td>/.exec(posisi)?.[1] ?? "";
    // A leading minus is allowed and a leading APOSTROPHE is not. The formula
    // guard used to prefix every negative figure, so a loss printed as
    // `'-41.842.500,00` on the face of a statement handed to management. The
    // guard now skips a value that is a formatted number and nothing else,
    // which leaves every actual payload still prefixed.
    expect([totalAset, /^-?[0-9]/.test(totalAset)]).toEqual([totalAset, true]);

    // WAS THE OTHER HALF OF WHY THE EXPORT WAS NOT FIT TO SEND UPWARD, NOW
    // CLOSED, AND THIS ASSERTION IS INVERTED.
    //
    // The statement used to dump the TEMPLATE's own schema into the management
    // copy -- the caption's raw UUID, the parent code, the sort order, the
    // nesting level, the row type, the section and the arithmetic sign, nine
    // columns before the first figure -- and then print the same rows three
    // more times under `Baris Aset`, `Baris Liabilitas` and `Baris Aset Neto`.
    // `core/ekspor/dokumen.ts` now drops the machinery (rule 5), turns nesting
    // and weight into LAYOUT rather than columns (rule 6), and suppresses a
    // table that only repeats one already printed (rule 7).
    const html = await (
      await d.panggil(
        "AUDITOR",
        `/laporan/ekspor/POSISI_KEUANGAN?periodeId=${periodeLaporan}&format=html`,
      )
    ).text();
    for (const kolom of [
      "Baris Laporan Id",
      "Parent Kode",
      "Urutan",
      "Level",
      "Tipe Baris",
      "Seksi",
      "Tanda",
      "Cetak Tebal",
    ]) {
      expect([kolom, html.includes(kolom)]).toEqual([kolom, false]);
    }

    // WHAT IS KEPT, because "the schema is gone" is not the same as "the
    // statement is there". A balance sheet still has to carry its line codes,
    // its captions, the accounts that fed each line, and both comparative
    // columns.
    for (const kolom of ["Kode", "Nama", "Akun Kode", "Nilai Tahun Ini", "Nilai Tahun Lalu"]) {
      expect([kolom, html.includes(`<th>${kolom}</th>`)]).toEqual([kolom, true]);
    }

    // THE LAYOUT THE DROPPED COLUMNS BECAME IS NOT ASSERTED HERE, AND THAT IS
    // A FINDING RATHER THAN AN OMISSION. `level` now indents a caption and
    // `cetakTebal` now bolds a row, but the SHIPPED core template exercises
    // neither: apps/api/src/seed/coa-inti.ts writes a literal `level = 1` and
    // `tipe_baris = 'DETAIL'` for every line and never sets `cetak_tebal`, so
    // this statement is four flat, unweighted lines with no total row at all.
    // Indentation is relative to the table's own shallowest row, so a flat
    // template correctly indents nothing; the rules themselves are pinned over
    // a nested, bolded statement in ../core/ekspor/ekspor-dokumen.test.ts.
    // What is asserted here is that no caption was mangled on the way.
    expect(html).toContain("<td>Aset</td>");

    // AND IT IS PRINTED ONCE. The three per-section repeats are gone; only the
    // statement in template order survives.
    expect(html).not.toContain("<h2>Baris Aset</h2>");
    expect(html).not.toContain("<h2>Baris Liabilitas</h2>");
    expect(html).not.toContain("<h2>Baris Aset Neto</h2>");
  });

  // =========================================================================
  // 21..24
  // =========================================================================

  test("skenario 21: submit proposal dari Portal Online, konversi jadi proposal internal, data ter-copy dengan benar", async () => {
    const nik = crypto.randomUUID().replace(/\D/g, "").padEnd(16, "5").slice(0, 16);
    const formulir = {
      nama_lengkap: "Dewi Anggraini",
      nama_usaha: "Katering Dewi",
      alamat: "Jl. Melati 12",
      jumlah_diajukan: rp(9_000_000),
      tenor_diajukan: 18,
      tujuan_penggunaan: "Tambahan peralatan katering",
    };

    // The PUBLIC surface: no session at all.
    const res = await d.f.request("/portal/pengajuan", {
      method: "POST",
      body: {
        kodeEntitas: d.kodeEntitas,
        jenis: "PUMK",
        emailKontak: "dewi@contoh.local",
        nik,
        formulir,
      },
    });
    expect(res.status).toBe(201);
    const { noTiket } = (await res.json()) as { noTiket: string };
    expect(noTiket.length).toBeGreaterThan(0);

    const antrean = await d.ok<{ data: Array<{ id: string; noTiket: string; status: string }> }>(
      "MAKER",
      "/portal/submission",
    );
    const submission = antrean.data.find((s) => s.noTiket === noTiket)!;
    expect(submission.status).toBe("BARU");

    const mitraPortal = await d.buatMitra({ nama: formulir.nama_lengkap, nik });
    const proposal = await d.ok<Proposal>("MAKER", "/pumk/portal/konversi", {
      body: {
        submissionId: submission.id,
        cabangId: d.f.cabangA.id,
        mitraId: mitraPortal.id,
        sektorId: d.sektorId,
        tanggalProposal: "2026-07-01",
        catatanPetugas: "Data cocok dengan KTP terlampir",
      },
    });

    // "data ter-copy dengan benar", read as: the internal proposal carries the
    // amount and the tenor the public typed, it says where it came from, it
    // points back at the ticket, and it starts at the BEGINNING of the state
    // machine rather than skipping survey because it arrived online.
    expect(proposal.jumlahDiajukan).toBe(rp(9_000_000));
    expect(proposal.tenorDiajukan).toBe(18);
    expect(proposal.sumberPengajuan).toBe("PORTAL_ONLINE");
    expect(proposal.portalSubmissionId).toBe(submission.id);
    expect(proposal.status).toBe("DRAFT");

    const sesudah = await d.ok<{ data: Array<{ noTiket: string; status: string; sudahDikonversi: boolean }> }>(
      "MAKER",
      "/portal/submission",
    );
    const tiket = sesudah.data.find((s) => s.noTiket === noTiket)!;
    expect(tiket.status).toBe("DIKONVERSI");
    expect(tiket.sudahDikonversi).toBe(true);
  });

  test("skenario 22: Buka Dashboard, klik satu KPI, drill down ke data sumber yang benar", async () => {
    const periodeBerjalan = periodeLaporan;
    const dash = await d.ok<{
      metrik: Array<{ kunci: string; nilai: string; rincian: string | null }>;
    }>("ADMIN_CABANG", `/dashboard?periodeId=${periodeBerjalan}`);

    const kpi = dash.metrik.find((m) => m.kunci === "OUTSTANDING_PUMK")!;
    const kunciRincian = kpi.rincian;
    expect(kunciRincian).toBeTruthy();
    if (kunciRincian === null) throw new Error("KPI tanpa kunci drill down");

    const rincian = await d.ok<{
      kunci: string;
      total: string;
      jumlah: number;
      baris: Array<{ entitas: string; id: string; nilai: string }>;
    }>("ADMIN_CABANG", `/dashboard/rincian?periodeId=${periodeBerjalan}&kunci=${kunciRincian}`);

    // "data sumber yang benar", read as: the drill-down foots to the KPI, and
    // every row is a real akad of this world rather than a label.
    expect(rincian.kunci).toBe(kunciRincian);
    expect(rincian.total).toBe(kpi.nilai);
    expect(rincian.jumlah).toBeGreaterThan(0);
    for (const b of rincian.baris) expect(b.entitas).toBe("pumk_akad");
    const idAkad = rincian.baris.map((b) => b.id);
    expect(idAkad).toContain(akad3);
    const jumlahBaris = rincian.baris.reduce((n, b) => n + Number(b.nilai), 0);
    expect(jumlahBaris).toBeCloseTo(Number(rincian.total), 2);
  });

  test("skenario 23: Login sebagai Auditor, semua laporan terbuka dan tidak ada satu pun tombol yang mengubah data", async () => {
    // EVERY report in the shipped catalogue, by its own route, as the Auditor.
    const katalog = await d.ok<{ data: Array<{ nomor: number; kode: string; nama: string }> }>(
      "AUDITOR",
      "/laporan/katalog",
    );
    expect(katalog.data.length).toBeGreaterThanOrEqual(30);

    const bacaan: Array<[string, string]> = [
      ["bagan akun", "/laporan/bagan-akun"],
      ["aktivitas", `/laporan/aktivitas?periodeId=${periodeLaporan}`],
      ["arus kas", `/laporan/arus-kas?periodeId=${periodeLaporan}`],
      ["posisi keuangan", `/laporan/posisi-keuangan?periodeId=${periodeLaporan}`],
      ["perubahan aset neto", `/laporan/perubahan-aset-neto?periodeId=${periodeLaporan}`],
      ["neraca lajur", `/laporan/neraca-lajur?periodeId=${periodeLaporan}`],
      ["buku besar", `/laporan/buku-besar?periodeId=${periodeLaporan}&akunId=${d.akunKasId}`],
      ["realisasi wilayah", `/laporan/realisasi-wilayah?periodeId=${periodeLaporan}`],
      ["realisasi sektor", `/laporan/realisasi-sektor?periodeId=${periodeLaporan}`],
      ["penyaluran nasional", `/laporan/penyaluran-nasional?periodeId=${periodeLaporan}`],
      ["penerimaan angsuran", `/laporan/penerimaan-angsuran?periodeId=${periodeLaporan}`],
      ["jatuh tempo", "/laporan/jatuh-tempo?dariTanggal=2026-01-01&sampaiTanggal=2026-12-31"],
      ["rekap permohonan", `/laporan/rekap-permohonan?periodeId=${periodeLaporan}`],
      ["rekap realisasi", `/laporan/rekap-realisasi?periodeId=${periodeLaporan}`],
      ["aging piutang", `/laporan/aging-piutang?periodeId=${periodeLaporan}`],
      ["kartu piutang", `/laporan/kartu-piutang?periodeId=${periodeLaporan}&mitraId=${mitra1.id}`],
      ["kolektibilitas", `/laporan/kolektibilitas?periodeId=${periodeLaporan}`],
      ["perpindahan kolektibilitas", `/laporan/perpindahan-kolektibilitas?periodeId=${periodeLaporan}`],
      ["penyaluran non pumk", `/laporan/penyaluran-non-pumk?periodeId=${periodeLaporan}`],
      ["rekap bidang", `/laporan/rekap-bidang?periodeId=${periodeLaporan}`],
      ["pemetaan sdg", `/laporan/pemetaan-sdg?periodeId=${periodeLaporan}`],
      ["monitoring lpj", `/laporan/monitoring-lpj?periodeId=${periodeLaporan}`],
      ["rekap jurnal", `/laporan/rekap-jurnal?periodeId=${periodeLaporan}`],
      ["portal pumk", `/laporan/portal-pumk?periodeId=${periodeLaporan}`],
      ["portal non pumk", `/laporan/portal-non-pumk?periodeId=${periodeLaporan}`],
      ["demografi mitra", `/laporan/demografi-mitra?periodeId=${periodeLaporan}`],
      ["perhitungan penyisihan", `/laporan/perhitungan-penyisihan?periodeId=${periodeLaporan}`],
      ["beban penyisihan", `/laporan/beban-penyisihan?periodeId=${periodeLaporan}`],
      ["akrual jasa", `/laporan/akrual-jasa?periodeId=${periodeLaporan}`],
      ["audit trail", "/laporan/audit-trail?dariTanggal=2026-01-01&sampaiTanggal=2027-12-31"],
      // The ledger itself, which the Auditor could not open at all until
      // `modules/jurnal/routes.ts` landed (see scenario 10). `jurnal.view` is
      // the only journal code the role holds, and it grants no power to create,
      // verify, post or reverse anything.
      ["daftar jurnal", "/jurnal?status=POSTED"],
      ["detail jurnal", `/jurnal/${jurnalPencairan1}`],
      ["rka versus realisasi", "/rka/laporan/realisasi?tahun=2026&jenis=PUMK&mode=BULANAN&bulan=1"],
    ];
    const gagal: string[] = [];
    for (const [nama, path] of bacaan) {
      const res = await d.panggil("AUDITOR", path);
      if (res.status !== 200) gagal.push(`${nama} -> ${res.status} ${await res.text()}`);
    }
    expect(gagal).toEqual([]);

    // AND NOT ONE WRITE, across every module that has one. The refusal must be
    // the system's (403), not a hidden button.
    const tulisan: Array<[string, string, unknown]> = [
      ["buat proposal PUMK", "/pumk/proposal", { cabangId: d.f.cabangA.id }],
      ["survey", "/pumk/survey", { proposalId: proposal1 }],
      ["review", `/pumk/proposal/${proposal1}/review`, { keputusan: "REKOMENDASI" }],
      ["persetujuan", `/pumk/proposal/${proposal1}/persetujuan`, { keputusan: "SETUJU" }],
      ["buat akad", "/pumk/akad", { proposalId: proposal1 }],
      ["pencairan", "/pumk/pencairan", { akadId: akad1 }],
      ["angsuran", "/pumk/angsuran", { akadId: akad1 }],
      ["reschedule", "/pumk/reschedule", { akadId: akad2 }],
      ["konversi portal", "/pumk/portal/konversi", { submissionId: proposal1 }],
      ["buat proposal Non PUMK", "/nonpumk/proposal", { cabangId: d.f.cabangA.id }],
      ["penyaluran", `/nonpumk/proposal/${proposalNonPumk}/penyaluran`, { jumlah: rp(1) }],
      ["lpj", `/nonpumk/proposal/${proposalNonPumk}/lpj`, { jumlahRealisasi: rp(1) }],
      ["kolektibilitas", `/closing/periode/${periodeLaporan}/kolektibilitas`, {}],
      ["penyisihan", `/closing/periode/${periodeLaporan}/penyisihan`, {}],
      ["akrual", `/closing/periode/${periodeLaporan}/akrual`, {}],
      ["tutup periode", `/closing/periode/${periodeLaporan}/tutup`, {}],
      ["buka periode", `/closing/periode/${periodeLaporan}/buka`, { alasan: "coba coba saja" }],
      ["buat RKA", "/rka", { tahun: 2026, jenis: "PUMK" }],
      ["impor", "/impor/ANGSURAN/komit", {}],
      // Every write on the ledger surface, including the reversal, which is the
      // one act that could change a POSTED figure.
      ["buat jurnal", "/jurnal", { cabangId: d.f.cabangA.id, jenis: "UMUM" }],
      ["posting jurnal", `/jurnal/${jurnalPencairan1}/posting`, {}],
      ["batal jurnal", `/jurnal/${jurnalPencairan1}/batal`, {}],
      ["pembalik jurnal", `/jurnal/${jurnalPencairan1}/pembalik`, { alasan: "coba coba saja" }],
    ];
    const lolos: string[] = [];
    for (const [nama, path, body] of tulisan) {
      const res = await d.panggil("AUDITOR", path, { body });
      if (res.status !== 403) lolos.push(`${nama} -> ${res.status}`);
    }
    expect(lolos).toEqual([]);
  });

  test("skenario 24: Maker dari Cabang A tidak bisa melihat atau mengubah data Cabang B, termasuk lewat manipulasi ID di URL atau request API langsung", async () => {
    // The counterpart lives in branch B and is a Maker there, so this is a
    // scope refusal and not a role refusal.
    const bacaLintas = [
      `/pumk/proposal/${proposal1}`,
      `/pumk/proposal/${proposal1}/timeline`,
      `/pumk/akad/${akad1}`,
      `/pumk/kartu-piutang/${akad1}`,
      `/nonpumk/proposal/${proposalNonPumk}`,
    ];
    for (const path of bacaLintas) {
      const res = await d.panggil("MAKER_B", path);
      expect([path, res.status >= 400 && res.status < 500]).toEqual([path, true]);
      expect([path, res.status]).not.toEqual([path, 200]);
    }

    // MUTATION, not just reading.
    const ubah = await d.tolak("MAKER_B", "/pumk/angsuran", {
      body: {
        akadId: akad2,
        tanggalTerima: "2026-08-10",
        jumlah: rp(500_000),
        akunKasId: d.akunKasId,
        noBukti: "BKM-LINTAS",
      },
    });
    expect(ubah.status).toBeGreaterThanOrEqual(400);
    expect(ubah.status).toBeLessThan(500);

    // Naming branch A in the BODY does not buy access either.
    const buatDiA = await d.tolak("MAKER_B", "/pumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        mitraId: mitra1.id,
        sektorId: d.sektorId,
        tanggalProposal: "2026-08-05",
        jumlahDiajukan: rp(6_000_000),
        tenorDiajukan: 12,
        tujuanPenggunaan: "Percobaan lintas cabang",
      },
    });
    expect(buatDiA.status).toBe(403);

    // And a LIST does not leak: branch A's proposal is not in branch B's list,
    // and asking for branch A by query string does not widen it.
    const daftar = await d.ok<{ data: Array<{ id: string }> }>("MAKER_B", "/pumk/proposal");
    expect(daftar.data.map((p) => p.id)).not.toContain(proposal1);
    const dipaksa = await d.panggil("MAKER_B", `/pumk/proposal?cabangId=${d.f.cabangA.id}`);
    if (dipaksa.status === 200) {
      const body = (await dipaksa.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((p) => p.id)).not.toContain(proposal1);
    } else {
      expect(dipaksa.status).toBe(403);
    }

    // Spec 2 rule 5: a refused cross-branch attempt leaves a DITOLAK audit row.
    const rows = await d.f.auditRows({ hasil: "DITOLAK", userId: d.f.users.MAKER_B.id });
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers. Nothing here asserts a business rule; each one is a sequence of the
// same HTTP calls the scenarios above make, so a second borrower costs one line
// instead of forty.
// ---------------------------------------------------------------------------

async function jalurAkadPenuh(
  mitra: MitraUji,
  opsi: {
    pokok: string;
    tenor: number;
    tanggalDasar: string;
    mulaiAngsuran: string;
    bukti: string;
  },
): Promise<string> {
  const t = (hari: string): string => `${opsi.tanggalDasar}-${hari}`;
  const proposal = await d.ok<Proposal>("MAKER", "/pumk/proposal", {
    body: {
      cabangId: d.f.cabangA.id,
      mitraId: mitra.id,
      sektorId: d.sektorId,
      tanggalProposal: t("05"),
      jumlahDiajukan: opsi.pokok,
      tenorDiajukan: opsi.tenor,
      tujuanPenggunaan: "Modal kerja",
    },
  });
  await d.ok("MAKER", `/pumk/proposal/${proposal.id}/submit-survey`, { body: { catatan: null } });
  await d.ok("MAKER", "/pumk/survey", {
    body: {
      proposalId: proposal.id,
      tanggalSurvey: t("06"),
      petugasKaryawanId: d.f.karyawanA,
      hasil: { karakter: 4, kapasitasUsaha: 4, tempatUsaha: 4, agunan: 4, riwayat: 4 },
      skorTotal: "80",
      plafonRekomendasi: opsi.pokok,
      tenorRekomendasi: opsi.tenor,
      catatan: null,
    },
  });
  await d.ok("MAKER", `/pumk/proposal/${proposal.id}/ajukan-checker`, { body: { catatan: null } });
  await d.ok("CHECKER", `/pumk/proposal/${proposal.id}/review`, {
    body: { tanggal: t("07"), keputusan: "REKOMENDASI", catatan: null },
  });
  await d.ok("APPROVER", `/pumk/proposal/${proposal.id}/persetujuan`, {
    body: {
      tanggal: t("08"),
      keputusan: "SETUJU",
      plafonDisetujui: opsi.pokok,
      tenorDisetujui: opsi.tenor,
      catatan: null,
    },
  });
  const akad = await d.ok<Akad>("MAKER", "/pumk/akad", {
    body: {
      proposalId: proposal.id,
      tanggalAkad: t("09"),
      tanggalMulaiAngsuran: opsi.mulaiAngsuran,
      gracePeriodBulan: 0,
    },
  });
  await d.ok("MAKER", `/pumk/akad/${akad.id}/jadwal`, { method: "POST" });
  await d.ok("MAKER", "/pumk/pencairan", {
    body: {
      akadId: akad.id,
      tanggalPencairan: t("10"),
      jumlah: opsi.pokok,
      akunKasId: d.akunKasId,
      noBukti: opsi.bukti,
      keterangan: null,
    },
  });
  return akad.id;
}

/** How many kolektibilitas snapshots this period holds. Proves a preview wrote none. */
async function hitungSnapshot(periodeId: string): Promise<number> {
  const rows = await d.f.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM kolektibilitas_snapshot
      WHERE periode_id = $1::uuid AND cabang_id = ANY($2::uuid[])`,
    [periodeId, [d.f.cabangA.id, d.f.cabangB.id, d.f.pusat.id]],
  );
  return Number(rows[0]!.n);
}
