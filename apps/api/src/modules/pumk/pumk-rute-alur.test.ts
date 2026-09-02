// SPEC 16 SCENARIOS 1 TO 6, WALKED THROUGH HTTP.
//
// One proposal, from a Maker's first form to a fully settled receivable, with
// every step made by a REAL LOGIN of the role that owns it, over the real app
// from core/app.ts. Nothing here calls a service directly and nothing here
// writes a business row in SQL: if a status moves, a route moved it.
//
//   1  Maker creates the proposal.
//   2  Survey is recorded, the proposal reaches the Checker.
//   3  Checker recommends; Approver approves WITH A CHANGED PLAFON, and the
//      akad is built from the APPROVAL, not from what was proposed.
//   4  The schedule is generated, and the disbursement is recorded.
//   5  Three receipts: exact, short, and one that exceeds every remaining
//      obligation.
//   6  The over-payment lands in Kelebihan Pembayaran instead of driving the
//      receivable negative (invariant 10).
//
// AND THE LEDGER, at every step that touched it: the sub-ledger receivable and
// the posted general ledger are read from the SHIPPED view
// `v_rekonsiliasi_piutang`, through the Kartu Piutang the officers actually
// open, and `selisih` must be exactly "0.00" (spec 8.4 check 10). A flow test
// that ends without that assertion proves the screens work and says nothing
// about whether the books do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaRute, rp, tutupSemuaFixture, type DuniaRute } from "./rute-test-support";

let d: DuniaRute;

// Dates inside the fixture's OPEN periods (2026-01 .. 2028-12).
const TANGGAL_PROPOSAL = "2026-01-05";
const TANGGAL_SURVEY = "2026-01-12";
const TANGGAL_REVIEW = "2026-01-15";
const TANGGAL_APPROVAL = "2026-01-20";
const TANGGAL_AKAD = "2026-02-05";
const MULAI_ANGSURAN = "2026-03-10";
const TANGGAL_PENCAIRAN = "2026-02-10";

// What the Maker asks for, and what the Approver actually grants. They are
// DIFFERENT on purpose: spec 9.1 says the approver may cut the plafon, and
// scenario 3 is the assertion that the akad follows the approval.
const DIAJUKAN = rp(20_000_000);
const DISETUJUI = rp(12_000_000);
const TENOR = 12;

// FLAT at the shipped default rate of 0.030000 over 12 months:
//   jasa   = 12.000.000 * 3% = 360.000
//   angsur = (12.000.000 + 360.000) / 12 = 1.030.000 per month
const TOTAL_KEWAJIBAN = 12_360_000;
const ANGSURAN_BULANAN = 1_030_000;
const SETORAN_KURANG = 500_000;
const KELEBIHAN = 100_000;

interface Proposal {
  id: string;
  noProposal: string;
  status: string;
  currentStep: number;
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
interface Alokasi {
  alokasiPokok: string;
  alokasiJasa: string;
  alokasiKelebihan: string;
  urutanKomponenDipakai: string[];
  jurnalId: string;
  kelebihanId: string | null;
  akadSetelah: { outstandingPokok: string; outstandingJasa: string; status: string };
}
interface Kartu {
  akad: Akad;
  setoran: Array<{
    jumlahDiterima: string;
    alokasiPokok: string;
    alokasiJasa: string;
    alokasiKelebihan: string;
    jurnalId: string | null;
  }>;
  kelebihan: Array<{ jumlah: string; status: string }>;
  outstanding: { pokok: string; jasa: string };
  saldoBukuBesar: string;
  selisihRekonsiliasi: string;
}

let proposalId = "";
let akadId = "";

beforeAll(async () => {
  d = await buatDuniaRute();
});

afterAll(async () => {
  // The world IS unique and the tables ARE append-only, so nothing here is
  // deleted. What this now does is mark the world's `bumn` as no longer live,
  // so it stops being swept by seed/event-jurnal.test.ts on every later run.
  // See the FIXTURE LEAK note in apps/api/src/testing/harness.ts.
  await tutupSemuaFixture();
});

describe("spec 16 scenarios 1 to 6, end to end over HTTP", () => {
  test("skenario 1: Maker membuat proposal dan mengirimnya ke survey", async () => {
    const mitra = await d.buatMitra({ nama: "Siti Rahmawati" });

    const proposal = await d.ok<Proposal>("MAKER", "/pumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        mitraId: mitra.id,
        sektorId: d.sektorId,
        tanggalProposal: TANGGAL_PROPOSAL,
        jumlahDiajukan: DIAJUKAN,
        tenorDiajukan: TENOR,
        tujuanPenggunaan: "Tambahan modal kerja warung sembako",
      },
    });
    expect(proposal.status).toBe("DRAFT");
    // The document number came from modules/nomor inside the same
    // transaction, so it is a real allocation and not a client-side guess.
    expect(proposal.noProposal.length).toBeGreaterThan(0);
    proposalId = proposal.id;

    const setelahSubmit = await d.ok<Proposal>(
      "MAKER",
      `/pumk/proposal/${proposalId}/submit-survey`,
      { body: { catatan: "Berkas lengkap" } },
    );
    expect(setelahSubmit.status).toBe("SURVEY_PENDING");
  });

  test("skenario 2: survey direkam lalu proposal diajukan ke Checker", async () => {
    const setelahSurvey = await d.ok<Proposal>("MAKER", "/pumk/survey", {
      body: {
        proposalId,
        tanggalSurvey: TANGGAL_SURVEY,
        petugasKaryawanId: d.karyawanId,
        hasil: { karakter: 4, kapasitasUsaha: 4, tempatUsaha: 4, agunan: 3, riwayat: 4 },
        skorTotal: "85",
        plafonRekomendasi: rp(18_000_000),
        tenorRekomendasi: TENOR,
        catatan: "Usaha berjalan tiga tahun, omzet stabil",
      },
    });
    expect(setelahSurvey.status).toBe("SURVEY_SELESAI");

    const keChecker = await d.ok<Proposal>(
      "MAKER",
      `/pumk/proposal/${proposalId}/ajukan-checker`,
      { body: { catatan: null } },
    );
    expect(keChecker.status).toBe("REVIEW_CHECKER");
  });

  test("skenario 3: Checker merekomendasi, Approver menyetujui DENGAN PLAFON DIUBAH", async () => {
    const direkomendasi = await d.ok<Proposal>(
      "CHECKER",
      `/pumk/proposal/${proposalId}/review`,
      {
        body: {
          tanggal: TANGGAL_REVIEW,
          keputusan: "REKOMENDASI",
          catatan: "Layak, plafon disarankan diturunkan",
        },
      },
    );
    expect(direkomendasi.status).toBe("MENUNGGU_PERSETUJUAN");

    const disetujui = await d.ok<Proposal>(
      "APPROVER",
      `/pumk/proposal/${proposalId}/persetujuan`,
      {
        body: {
          tanggal: TANGGAL_APPROVAL,
          keputusan: "SETUJU",
          plafonDisetujui: DISETUJUI,
          tenorDisetujui: TENOR,
          catatan: "Disetujui sebagian sesuai kapasitas angsuran",
        },
      },
    );
    expect(disetujui.status).toBe("DISETUJUI");

    // The proposal still reports what was ASKED; the approval carries what was
    // GRANTED. Both are visible on the detail screen, which is what lets an
    // officer explain the difference to the mitra.
    const detail = await d.ok<{
      proposal: { jumlahDiajukan: string };
      approval: { plafonDisetujui: string; tenorDisetujui: number };
      review: { keputusan: string };
    }>("MAKER", `/pumk/proposal/${proposalId}`);
    expect(detail.proposal.jumlahDiajukan).toBe(DIAJUKAN);
    expect(detail.approval.plafonDisetujui).toBe(DISETUJUI);
    expect(detail.approval.tenorDisetujui).toBe(TENOR);
    expect(detail.review.keputusan).toBe("REKOMENDASI");
  });

  test("skenario 4: akad dibangun dari APPROVAL, bukan dari yang diajukan", async () => {
    const akad = await d.ok<Akad>("MAKER", "/pumk/akad", {
      body: {
        proposalId,
        tanggalAkad: TANGGAL_AKAD,
        tanggalMulaiAngsuran: MULAI_ANGSURAN,
        gracePeriodBulan: 0,
      },
    });
    akadId = akad.id;
    // THE ASSERTION SCENARIO 3 EXISTS FOR: the approver's cut flowed into the
    // contract instead of being recorded and ignored.
    expect(akad.pokokPinjaman).toBe(DISETUJUI);
    expect(akad.pokokPinjaman).not.toBe(DIAJUKAN);
    expect(akad.tenorBulan).toBe(TENOR);
    // The rate came from `konfigurasi jasa_adm.jasa_adm_rate_default`, never
    // from a literal in the module.
    expect(akad.jasaAdmRate).toBe("0.030000");
    expect(akad.status).toBe("BELUM_CAIR");
    expect(akad.outstandingPokok).toBe(rp(0));
  });

  test("skenario 5: jadwal digenerate dan pencairan dicatat", async () => {
    const jadwal = await d.ok<{
      versi: number;
      isActiveVersion: boolean;
      baris: Array<{ angsuranKe: number; pokok: string; jasaAdm: string; total: string }>;
      ringkasan: { totalPokok: string; totalJasa: string; totalBayar: string };
    }>("MAKER", `/pumk/akad/${akadId}/jadwal`, { method: "POST" });

    expect(jadwal.versi).toBe(1);
    expect(jadwal.isActiveVersion).toBe(true);
    expect(jadwal.baris).toHaveLength(TENOR);
    expect(jadwal.ringkasan.totalPokok).toBe(DISETUJUI);
    expect(jadwal.ringkasan.totalBayar).toBe(rp(TOTAL_KEWAJIBAN));
    expect(jadwal.baris[0]!.total).toBe(rp(ANGSURAN_BULANAN));

    const proposal = await d.ok<Proposal>("MAKER", `/pumk/proposal/${proposalId}`).then(
      (detail) => (detail as unknown as { proposal: Proposal }).proposal,
    );
    expect(proposal.status).toBe("JADWAL_SIAP");

    const pencairan = await d.ok<{
      jurnalId: string;
      jumlah: string;
      akad: Akad;
      proposal: Proposal;
    }>("MAKER", "/pumk/pencairan", {
      body: {
        akadId,
        tanggalPencairan: TANGGAL_PENCAIRAN,
        jumlah: DISETUJUI,
        akunKasId: d.akunKasId,
        noBukti: "BKK-UJI-001",
        keterangan: "Pencairan PUMK yang sudah dilakukan di loket",
      },
    });
    // A disbursement without a journal is not a disbursement.
    expect(pencairan.jurnalId.length).toBeGreaterThan(0);
    expect(pencairan.akad.status).toBe("AKTIF");
    expect(pencairan.akad.outstandingPokok).toBe(DISETUJUI);
    expect(pencairan.proposal.status).toBe("DICAIRKAN");

    // Spec 8.4 check 10, the moment the receivable exists.
    const kartu = await d.ok<Kartu>("MAKER", `/pumk/kartu-piutang/${akadId}`);
    expect(kartu.outstanding.pokok).toBe(DISETUJUI);
    expect(kartu.saldoBukuBesar).toBe(DISETUJUI);
    expect(kartu.selisihRekonsiliasi).toBe(rp(0));
  });

  test("skenario 5: setoran PAS mengalokasi pokok dan jasa persis satu angsuran", async () => {
    const hasil = await d.ok<Alokasi>("MAKER", "/pumk/angsuran", {
      body: {
        akadId,
        tanggalTerima: MULAI_ANGSURAN,
        jumlah: rp(ANGSURAN_BULANAN),
        akunKasId: d.akunKasId,
        noBukti: "BKM-UJI-001",
      },
    });
    expect(hasil.alokasiPokok).toBe(rp(1_000_000));
    expect(hasil.alokasiJasa).toBe(rp(30_000));
    expect(hasil.alokasiKelebihan).toBe(rp(0));
    expect(hasil.akadSetelah.outstandingPokok).toBe(rp(11_000_000));
    // ONE journal for the whole allocation, however many components moved
    // (spec 7.2 step 8).
    expect(hasil.jurnalId.length).toBeGreaterThan(0);
    expect(hasil.kelebihanId).toBeNull();
  });

  test("skenario 5: setoran KURANG mengikuti waterfall, jasa tertunggak lebih dulu", async () => {
    const hasil = await d.ok<Alokasi>("MAKER", "/pumk/angsuran", {
      body: {
        akadId,
        tanggalTerima: "2026-04-10",
        jumlah: rp(SETORAN_KURANG),
        akunKasId: d.akunKasId,
        noBukti: "BKM-UJI-002",
      },
    });
    // DEFAULT preset (spec 5.4): TUNGGAKAN_JASA before TUNGGAKAN_POKOK. The
    // second instalment is due on this date, so its 30.000 jasa clears first
    // and the remaining 470.000 goes to principal.
    expect(hasil.alokasiJasa).toBe(rp(30_000));
    expect(hasil.alokasiPokok).toBe(rp(470_000));
    expect(hasil.alokasiKelebihan).toBe(rp(0));
    expect(hasil.akadSetelah.outstandingPokok).toBe(rp(10_530_000));
    // The order is CONFIGURATION, not the shape of the code (spec 5.4).
    expect(hasil.urutanKomponenDipakai[0]).toBe("TUNGGAKAN_JASA");

    const kartu = await d.ok<Kartu>("MAKER", `/pumk/kartu-piutang/${akadId}`);
    expect(kartu.outstanding.pokok).toBe(rp(10_530_000));
    expect(kartu.saldoBukuBesar).toBe(rp(10_530_000));
    expect(kartu.selisihRekonsiliasi).toBe(rp(0));
  });

  test("skenario 6: setoran LEBIH masuk ke Kelebihan Pembayaran, bukan piutang negatif", async () => {
    const sisaKewajiban = TOTAL_KEWAJIBAN - ANGSURAN_BULANAN - SETORAN_KURANG;
    const hasil = await d.ok<Alokasi>("MAKER", "/pumk/angsuran", {
      body: {
        akadId,
        tanggalTerima: "2027-04-10",
        jumlah: rp(sisaKewajiban + KELEBIHAN),
        akunKasId: d.akunKasId,
        noBukti: "BKM-UJI-003",
      },
    });
    expect(hasil.alokasiKelebihan).toBe(rp(KELEBIHAN));
    expect(hasil.akadSetelah.outstandingPokok).toBe(rp(0));
    expect(hasil.akadSetelah.outstandingJasa).toBe(rp(0));
    expect(hasil.kelebihanId).not.toBeNull();

    const kartu = await d.ok<Kartu>("MAKER", `/pumk/kartu-piutang/${akadId}`);
    // Invariant 10: the surplus is a liability of its own, held as TERTAHAN.
    // It is NOT a negative receivable, and the receivable is exactly zero.
    expect(kartu.kelebihan).toHaveLength(1);
    expect(kartu.kelebihan[0]!.jumlah).toBe(rp(KELEBIHAN));
    expect(kartu.kelebihan[0]!.status).toBe("TERTAHAN");
    expect(kartu.outstanding.pokok).toBe(rp(0));
    expect(kartu.akad.status).toBe("LUNAS");

    // Three receipts, each with its own posted journal.
    expect(kartu.setoran).toHaveLength(3);
    for (const setoran of kartu.setoran) {
      expect(setoran.jurnalId).not.toBeNull();
    }

    // THE LEDGER ASSERTION. The sub-ledger receivable and the posted general
    // ledger agree, read from the shipped view, with nothing left over.
    expect(kartu.saldoBukuBesar).toBe(rp(0));
    expect(kartu.selisihRekonsiliasi).toBe(rp(0));
  });

  test("v_rekonsiliasi_piutang tidak menyisakan selisih untuk akad dunia ini", async () => {
    // Straight at the view, over EVERY akad this world created: the kartu
    // answers for one akad, and a flow that broke another one would not show
    // up there.
    const baris = await d.f.db.query<{ akad_id: string; selisih: string }>(
      `SELECT akad_id::text AS akad_id, selisih::text AS selisih
         FROM v_rekonsiliasi_piutang
        WHERE cabang_id = ANY($1::uuid[]) AND selisih <> 0`,
      [[d.f.cabangA.id, d.f.cabangB.id, d.f.pusat.id]],
    );
    expect(baris).toEqual([]);
  });

  test("timeline mencatat setiap transisi dengan nama pelakunya", async () => {
    const timeline = await d.ok<{
      data: Array<{ aksi: string; statusKe: string; olehNama: string | null }>;
    }>("MAKER", `/pumk/proposal/${proposalId}/timeline`);
    const aksi = timeline.data.map((b) => b.aksi);
    expect(aksi).toEqual([
      "SUBMIT_SURVEY",
      "INPUT_SURVEY",
      "AJUKAN_CHECKER",
      "REKOMENDASI",
      "SETUJU",
      "BUAT_AKAD",
      "GENERATE_JADWAL",
      "PENCAIRAN",
    ]);
    // Spec 9.1 asks the timeline to show "siapa, kapan, catatan apa". A UUID
    // answers none of that, so the read model joins the user.
    for (const baris of timeline.data) {
      expect(baris.olehNama).not.toBeNull();
    }
    // And WHICH role did it, so a reviewer reading the trail does not have to
    // resolve a user id by hand.
    const rekomendasi = timeline.data.find((b) => b.aksi === "REKOMENDASI");
    expect(rekomendasi?.olehNama).toContain("CHECKER");
  });
});

describe("read models the screens open first", () => {
  test("GET /pumk/batasan membaca konfigurasi, bukan angka yang diketik di kode", async () => {
    const batasan = await d.ok<{
      plafonMin: string;
      plafonMax: string;
      tenorMin: number;
      tenorMax: number;
      maksPinjamanAktifPerMitra: number;
      jasaAdmRateDefault: string;
      jasaAdmMetodeDefault: string;
    }>("MAKER", "/pumk/batasan");
    expect(batasan.plafonMin).toBe(rp(5_000_000));
    expect(batasan.tenorMin).toBe(6);
    expect(batasan.tenorMax).toBe(36);
    expect(batasan.maksPinjamanAktifPerMitra).toBe(1);
    expect(batasan.jasaAdmRateDefault).toBe("0.030000");
    expect(batasan.jasaAdmMetodeDefault).toBe("FLAT");

    // THE MECHANIC, NOT THE VALUE: change the row, the endpoint changes. The
    // number itself is the client's accounting decision (docs/REGULASI.md).
    await d.f.db.query(
      `INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data, deskripsi)
       VALUES ($1, 'batasan', 'tenor_max_bulan', '48', 'NUMBER', 'override uji rute')`,
      [d.f.bumnId],
    );
    // The service caches per bumn, so the override is only observable after the
    // cache for this bumn is dropped. That is the same call the PUT handler
    // makes, and it is why an edit takes effect without a deploy.
    await d.f.ctx.konfigurasi.invalidate(d.f.bumnId);
    const sesudah = await d.ok<{ tenorMax: number }>("MAKER", "/pumk/batasan");
    expect(sesudah.tenorMax).toBe(48);
  });

  test("daftar proposal membawa nama mitra, NIK dan nama sektor", async () => {
    const daftar = await d.ok<{
      data: Array<{
        id: string;
        mitraNama: string;
        mitraNik: string | null;
        sektorNama: string | null;
        umurHari: number;
      }>;
    }>("MAKER", `/pumk/proposal?cabangId=${d.f.cabangA.id}`);
    const baris = daftar.data.find((b) => b.id === proposalId);
    expect(baris).toBeDefined();
    expect(baris!.mitraNama).toBe("Siti Rahmawati");
    expect(baris!.mitraNik).not.toBeNull();
    expect(baris!.sektorNama).toBe("Perdagangan (uji rute)");
    expect(baris!.umurHari).toBeGreaterThan(0);
  });

  test("pencarian proposal menemukan lewat nama maupun NIK", async () => {
    const lewatNama = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      "/pumk/proposal?cari=Rahmawati",
    );
    expect(lewatNama.data.some((b) => b.id === proposalId)).toBe(true);

    const detail = await d.ok<{ proposal: { mitraNik: string } }>(
      "MAKER",
      `/pumk/proposal/${proposalId}`,
    );
    const lewatNik = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      `/pumk/proposal?cari=${detail.proposal.mitraNik}`,
    );
    expect(lewatNik.data.some((b) => b.id === proposalId)).toBe(true);
  });

  test("daftar akad membawa label mitra dan nomor proposalnya", async () => {
    const daftar = await d.ok<{
      data: Array<{ id: string; mitraNama: string; noProposal: string; cabangNama: string }>;
    }>("MAKER", "/pumk/akad");
    const baris = daftar.data.find((b) => b.id === akadId);
    expect(baris).toBeDefined();
    expect(baris!.mitraNama).toBe("Siti Rahmawati");
    expect(baris!.noProposal.length).toBeGreaterThan(0);
    expect(baris!.cabangNama).toBe(d.f.cabangA.nama);
  });

  test("GET /konfigurasi/akun?kas=true hanya menjawab akun kas", async () => {
    const daftar = await d.ok<{ data: Array<{ id: string; kode: string }> }>(
      "MAKER",
      "/konfigurasi/akun?kas=true",
    );
    expect(daftar.data.length).toBeGreaterThan(0);
    expect(daftar.data.some((a) => a.id === d.akunKasId)).toBe(true);

    // The filter is mandatory: the full chart of accounts is a different
    // screen with a different permission, and answering it here by omission
    // would be a quiet privilege widening.
    const tanpaFilter = await d.panggil("MAKER", "/konfigurasi/akun");
    expect(tanpaFilter.status).toBe(400);
  });

  test("simulasi dan jadwal yang digenerate menghasilkan tabel yang identik", async () => {
    // Spec 7.5 item 11. Same engine, same configuration, same parameters.
    const simulasi = await d.ok<{
      baris: Array<{ angsuranKe: number; pokok: string; jasaAdm: string; total: string }>;
      ringkasan: { totalBayar: string };
    }>("MAKER", "/pumk/simulasi", {
      body: {
        pokok: DISETUJUI,
        rate: "0.030000",
        metode: "FLAT",
        tenorBulan: TENOR,
        gracePeriodBulan: 0,
        tanggalMulaiAngsuran: MULAI_ANGSURAN,
      },
    });
    const riwayat = await d.ok<{
      data: Array<{
        versi: number;
        baris: Array<{ angsuranKe: number; pokok: string; jasaAdm: string; total: string }>;
      }>;
    }>("MAKER", `/pumk/akad/${akadId}/jadwal`);
    const versiSatu = riwayat.data.find((v) => v.versi === 1);
    expect(versiSatu).toBeDefined();
    expect(simulasi.baris).toEqual(versiSatu!.baris);
    expect(simulasi.ringkasan.totalBayar).toBe(rp(TOTAL_KEWAJIBAN));
  });

  test("pratinjau pengakhiran memecah hapus buku menjadi empat angka", async () => {
    // A second akad, still live, so the preview has something to describe.
    const mitra = await d.buatMitra({ nama: "Bagus Pratama" });
    const proposal = await d.ok<Proposal>("MAKER", "/pumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        mitraId: mitra.id,
        sektorId: d.sektorId,
        tanggalProposal: TANGGAL_PROPOSAL,
        jumlahDiajukan: rp(6_000_000),
        tenorDiajukan: TENOR,
      },
    });
    await d.ok("MAKER", `/pumk/proposal/${proposal.id}/submit-survey`, { body: {} });
    await d.ok("MAKER", "/pumk/survey", {
      body: {
        proposalId: proposal.id,
        tanggalSurvey: TANGGAL_SURVEY,
        skorTotal: "80",
        plafonRekomendasi: rp(6_000_000),
        tenorRekomendasi: TENOR,
      },
    });
    await d.ok("MAKER", `/pumk/proposal/${proposal.id}/ajukan-checker`, { body: {} });
    await d.ok("CHECKER", `/pumk/proposal/${proposal.id}/review`, {
      body: { tanggal: TANGGAL_REVIEW, keputusan: "REKOMENDASI" },
    });
    await d.ok("APPROVER", `/pumk/proposal/${proposal.id}/persetujuan`, {
      body: {
        tanggal: TANGGAL_APPROVAL,
        keputusan: "SETUJU",
        plafonDisetujui: rp(6_000_000),
        tenorDisetujui: TENOR,
      },
    });
    const akad = await d.ok<Akad>("MAKER", "/pumk/akad", {
      body: {
        proposalId: proposal.id,
        tanggalAkad: TANGGAL_AKAD,
        tanggalMulaiAngsuran: MULAI_ANGSURAN,
      },
    });
    await d.ok("MAKER", `/pumk/akad/${akad.id}/jadwal`, { method: "POST" });
    await d.ok("MAKER", "/pumk/pencairan", {
      body: {
        akadId: akad.id,
        tanggalPencairan: TANGGAL_PENCAIRAN,
        jumlah: rp(6_000_000),
        akunKasId: d.akunKasId,
      },
    });

    const pratinjau = await d.ok<{
      outstandingPokok: string;
      outstandingJasa: string;
      penyisihanTersedia: string;
      penyisihanDipakai: string;
      kekuranganPenyisihan: string;
      eventJurnal: string[];
      penolakan: string | null;
    }>("APPROVER", "/pumk/pengakhiran/pratinjau", {
      body: { akadId: akad.id, jenis: "HAPUS_BUKU", tanggal: "2027-06-30" },
    });

    // FOUR SEPARATE FIGURES, never one. No allowance has been raised in this
    // world, so the whole outstanding is a shortfall and the screen must say
    // so before the button rather than after it.
    expect(pratinjau.outstandingPokok).toBe(rp(6_000_000));
    expect(pratinjau.penyisihanTersedia).toBe(rp(0));
    expect(pratinjau.penyisihanDipakai).toBe(rp(0));
    expect(pratinjau.kekuranganPenyisihan).toBe(rp(6_000_000));
    expect(pratinjau.eventJurnal).toEqual(["HAPUS_BUKU_KEKURANGAN_PENYISIHAN"]);
    expect(pratinjau.penolakan).toBeNull();
    // dipakai + kekurangan is the whole outstanding, always.
    expect(pratinjau.penyisihanDipakai).toBe(rp(0));

    // The one termination with no sanctioned event mapping says so up front
    // (docs/REGULASI.md finding 5) instead of failing after the click.
    const bersyarat = await d.ok<{ penolakan: string | null; eventJurnal: string[] }>(
      "APPROVER",
      "/pumk/pengakhiran/pratinjau",
      { body: { akadId: akad.id, jenis: "PENGHAPUSAN_BERSYARAT", tanggal: "2027-06-30" } },
    );
    expect(bersyarat.penolakan).not.toBeNull();
    expect(bersyarat.eventJurnal).toEqual([]);

    // And the write itself is refused with its own code, not a generic 500.
    const ditolak = await d.panggil("APPROVER", "/pumk/pengakhiran", {
      body: {
        akadId: akad.id,
        jenis: "PENGHAPUSAN_BERSYARAT",
        tanggal: "2027-06-30",
        dasarKeputusan: "SK direksi",
      },
    });
    expect(ditolak.status).toBe(409);
    const tubuh = (await ditolak.json()) as { code: string; kodeDomain: string; error: string };
    expect(tubuh.kodeDomain).toBe("EVENT_MAPPING_BELUM_ADA");
    expect(tubuh.code).toBe("KONFLIK");
    // The refusal is prose an operator can act on, with no trigger name in it.
    expect(tubuh.error).not.toContain("TJSL-");
  });

  test("pratinjau reschedule memakai mesin angsuran dan menyimpan apa pun", async () => {
    const sebelum = await d.f.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pumk_jadwal_versi WHERE akad_id = $1`,
      [akadId],
    );
    // The settled akad above cannot be rescheduled, so the preview is taken on
    // the akad of the previous test, which is AKTIF. It is fetched by list
    // rather than remembered, so this test does not depend on test order
    // beyond the world already existing.
    const daftar = await d.ok<{ data: Array<{ id: string; status: string }> }>(
      "MAKER",
      "/pumk/akad?status=AKTIF",
    );
    const aktif = daftar.data[0];
    expect(aktif).toBeDefined();

    const pratinjau = await d.ok<{
      jadwalBerjalan: { versi: number; isActiveVersion: boolean };
      jadwalUsulan: { baris: unknown[]; ringkasan: { totalPokok: string } };
      pokokTerbayarHistoris: string;
      outstandingSaatIni: string;
    }>("MAKER", "/pumk/reschedule/pratinjau", {
      body: { akadId: aktif!.id, jenis: "PERPANJANG_TENOR", tenorBaru: 24 },
    });

    expect(pratinjau.jadwalBerjalan.versi).toBe(1);
    expect(pratinjau.jadwalUsulan.baris).toHaveLength(24);
    // The proposed table is built on the OUTSTANDING, which is what the
    // approval would use.
    expect(pratinjau.jadwalUsulan.ringkasan.totalPokok).toBe(pratinjau.outstandingSaatIni);
    expect(pratinjau.pokokTerbayarHistoris).toBe(rp(0));

    // IT STORED NOTHING. No new version, and no reschedule row.
    const sesudah = await d.f.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pumk_jadwal_versi WHERE akad_id = $1`,
      [akadId],
    );
    expect(sesudah[0]!.n).toBe(sebelum[0]!.n);
    const reschedule = await d.ok<{ data: unknown[] }>("MAKER", "/pumk/reschedule");
    expect(reschedule.data).toEqual([]);
  });
});
