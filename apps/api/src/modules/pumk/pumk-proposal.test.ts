// SPEC 9.1's entry point: "Form input proposal, dengan fitur cari mitra lama
// dan VALIDASI MAKS PINJAMAN AKTIF PER MITRA", "Form profil jaminan (multi
// jaminan per proposal)", and "Daftar proposal dengan filter tanggal, cabang,
// sektor, status, dan pencarian nama atau NIK".
//
// Scenario 1: "Login sebagai Maker, input proposal PUMK baru, isi hasil survey,
// upload jaminan, ajukan ke Checker."
//
// EVERY LIMIT IN THIS FILE IS READ FROM `konfigurasi`, NEVER ASSERTED AS A
// POLICY NUMBER. docs/REGULASI.md finding 3 and docs/BUILD-PLAN.md "Dampak
// temuan regulasi" both record that the spec's own figures are contested and
// that the decision belongs to the client's accounting team. So each bound is
// tested as a MECHANIC: set the row one way and the input is refused, set it
// the other way and the same input is accepted. No test here claims that
// 1.000.000 or 36 months or one active loan is correct.
//
// WHY THE ACTIVE-LOAN CHECK IS TESTED AT PROPOSAL TIME AND AGAIN AT AKAD TIME.
// `pumk_akad_satu_aktif_per_mitra_uq` is the real guarantee and it fires at the
// akad INSERT, which is four screens and one approval later. Discovering there
// that the mitra was never eligible wastes a survey visit, a checker's review
// and an approver's decision. So the module owes an early refusal as well as
// the late one; ./pumk-akad-jadwal.test.ts holds the late one.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  kunci,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  POKOK_BAKU,
  TANGGAL_PROPOSAL_BAKU,
  TENOR_BAKU,
  type DuniaPumk,
  type MitraFixture,
  type PorterAngsuranUji,
  type PorterJurnalUji,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  angsuran = porterAngsuranUji(d.db, jurnal, d.jam);
  engine = createPumkEngine({ db: d.db, angsuran, jurnal, jam: d.jam });
}, 60_000);

beforeEach(async () => {
  jurnal.reset();
  angsuran.reset();
  await d.setelKonfigurasi("batasan", "plafon_min_pumk", "1000000.00");
  await d.setelKonfigurasi("batasan", "plafon_max_pumk", "250000000.00");
  await d.setelKonfigurasi("batasan", "tenor_min_bulan", "6");
  await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
  await d.setelKonfigurasi("batasan", "wajib_jaminan_di_atas_plafon", "50000000.00");
  await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "1");
});

afterAll(async () => {
  if (d) await d.tutup();
});

function input(mitra: MitraFixture, ubah: Record<string, unknown> = {}) {
  return {
    cabangId: d.cabangId,
    mitraId: mitra.id,
    sektorId: d.sektorId,
    tanggalProposal: TANGGAL_PROPOSAL_BAKU,
    jumlahDiajukan: POKOK_BAKU,
    tenorDiajukan: TENOR_BAKU,
    tujuanPenggunaan: "Tambahan modal kerja",
    ...ubah,
  } as Parameters<PumkEngine["buatProposal"]>[0];
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("buat proposal (spec 9.1, skenario 1)", () => {
  test("proposal baru lahir DRAFT dengan nomor otomatis dan pembuatnya tercatat", async () => {
    const mitra = await d.buatMitra();
    const p = await engine.buatProposal(input(mitra), d.ctx.maker);

    expect(p.status).toBe("DRAFT");
    expect(p.currentStep).toBe(1);
    expect(p.mitraId).toBe(mitra.id);
    expect(p.cabangId).toBe(d.cabangId);
    expect(p.sektorId).toBe(d.sektorId);
    expect(p.jumlahDiajukan).toBe(POKOK_BAKU);
    expect(p.tenorDiajukan).toBe(TENOR_BAKU);
    // Internal until a portal conversion says otherwise, and with no submission
    // behind it. `pumk_proposal_sumber_ck` enforces the pairing.
    expect(p.sumberPengajuan).toBe("INTERNAL");
    expect(p.portalSubmissionId).toBeNull();
    // WHO created it. This is the value the maker/checker segregation rule is
    // later compared against, so a null here disables spec 2 rule 1 silently.
    expect(p.createdBy).toBe(d.userId.maker);

    const baris = await d.bacaProposal(p.id);
    expect(baris.created_by).toBe(d.userId.maker);
    expect(baris.no_proposal).toBe(p.noProposal);
    // Deliberately NOT a format assertion: spec 4.4 says `no_proposal` is
    // "auto, format konfigurable", so pinning a pattern here would pin a
    // policy. What must hold is that the module allocated one and that it is
    // unique (next test).
    expect(p.noProposal.trim().length).toBeGreaterThan(0);

    // Creation is not a transition: `AksiProposal` has no code for it and
    // `pumk_proposal_transisi.aksi` is NOT NULL, so the timeline begins at the
    // first real move (./pumk-state-machine.test.ts).
    expect(await d.bacaTransisi(p.id)).toHaveLength(0);
  });

  test("dua proposal berturut turut mendapat nomor yang berbeda", async () => {
    // `pumk_proposal_no_uq` would catch a collision with a raw constraint name,
    // and a numbering scheme that collides under concurrency is a numbering
    // scheme that stops the branch office.
    const a = await engine.buatProposal(input(await d.buatMitra()), d.ctx.maker);
    const b = await engine.buatProposal(input(await d.buatMitra()), d.ctx.maker);
    expect(a.noProposal).not.toBe(b.noProposal);
  });

  test("mitra dan sektor yang tidak ada ditolak sebelum apa pun ditulis", async () => {
    const mitra = await d.buatMitra();
    await tolakDengan(
      () =>
        engine.buatProposal(
          input(mitra, { mitraId: "00000000-0000-4000-8000-000000000008" }),
          d.ctx.maker,
        ),
      KODE_PUMK.MITRA_TIDAK_DITEMUKAN,
    );
    await tolakDengan(
      () =>
        engine.buatProposal(
          input(mitra, { sektorId: "00000000-0000-4000-8000-000000000009" }),
          d.ctx.maker,
        ),
      KODE_PUMK.SEKTOR_TIDAK_DITEMUKAN,
    );
  });

  test("mitra cabang lain tidak bisa dipakai di proposal cabang ini", async () => {
    // The branch of the proposal and the branch of the mitra have to agree, or
    // a branch can quietly book another branch's mitra onto its own portfolio.
    const mitraB = await d.buatMitra({ cabangId: d.cabangLainId });
    await tolakDengan(
      () => engine.buatProposal(input(mitraB), d.ctx.maker),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
  });

  test("tanggal yang tidak valid ditolak dengan TANGGAL_TIDAK_VALID", async () => {
    const mitra = await d.buatMitra();
    for (const tanggal of ["2026-13-01", "2026-02-30", "05/01/2026", "bukan tanggal"]) {
      await tolakDengan(
        () => engine.buatProposal(input(mitra, { tanggalProposal: tanggal }), d.ctx.maker),
        KODE_PUMK.TANGGAL_TIDAK_VALID,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Bounds, all from configuration
// ---------------------------------------------------------------------------

describe("batasan program dibaca dari konfigurasi (spec 5.5)", () => {
  test("plafon di bawah minimum dan di atas maksimum ditolak; ubah barisnya, hasilnya berubah", async () => {
    await d.setelKonfigurasi("batasan", "plafon_min_pumk", "5000000.00");
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "20000000.00");

    await tolakDengan(
      async () =>
        engine.buatProposal(
          input(await d.buatMitra(), { jumlahDiajukan: rp(4_999_999) }),
          d.ctx.maker,
        ),
      KODE_PUMK.PLAFON_DILUAR_BATAS,
    );
    await tolakDengan(
      async () =>
        engine.buatProposal(
          input(await d.buatMitra(), { jumlahDiajukan: rp(20_000_001) }),
          d.ctx.maker,
        ),
      KODE_PUMK.PLAFON_DILUAR_BATAS,
    );

    // Both boundaries are INCLUSIVE. An off-by-one here rejects an application
    // for exactly the ceiling amount, which is the most common application.
    const bawah = await engine.buatProposal(
      input(await d.buatMitra(), { jumlahDiajukan: rp(5_000_000) }),
      d.ctx.maker,
    );
    expect(bawah.jumlahDiajukan).toBe(rp(5_000_000));
    const atas = await engine.buatProposal(
      input(await d.buatMitra(), { jumlahDiajukan: rp(20_000_000) }),
      d.ctx.maker,
    );
    expect(atas.jumlahDiajukan).toBe(rp(20_000_000));

    // THE MECHANIC: move the row, the same amount that was refused is accepted.
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "30000000.00");
    const sekarang = await engine.buatProposal(
      input(await d.buatMitra(), { jumlahDiajukan: rp(20_000_001) }),
      d.ctx.maker,
    );
    expect(sekarang.jumlahDiajukan).toBe(rp(20_000_001));
  }, 60_000);

  test("tenor di luar batas ditolak; ubah barisnya, hasilnya berubah", async () => {
    await d.setelKonfigurasi("batasan", "tenor_min_bulan", "6");
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "24");
    await tolakDengan(
      async () => engine.buatProposal(input(await d.buatMitra(), { tenorDiajukan: 5 }), d.ctx.maker),
      KODE_PUMK.TENOR_DILUAR_BATAS,
    );
    await tolakDengan(
      async () => engine.buatProposal(input(await d.buatMitra(), { tenorDiajukan: 25 }), d.ctx.maker),
      KODE_PUMK.TENOR_DILUAR_BATAS,
    );
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
    const p = await engine.buatProposal(
      input(await d.buatMitra(), { tenorDiajukan: 36 }),
      d.ctx.maker,
    );
    expect(p.tenorDiajukan).toBe(36);
  }, 30_000);

  test("nilai uang yang bukan desimal dua angka ditolak (invarian 7)", async () => {
    // NUMERIC(20,2) would round or reject at the column, after the row is
    // half-built. A float that arrived as a string is the classic way a rupiah
    // goes missing, so it is refused at the door.
    for (const salah of ["12000000", "12000000.5", "12.000.000,00", "1.2e7", "-12000000.00"]) {
      await tolakDengan(
        async () => engine.buatProposal(input(await d.buatMitra(), { jumlahDiajukan: salah }), d.ctx.maker),
        KODE_PUMK.NILAI_BUKAN_DESIMAL,
      );
    }
  }, 30_000);

  test("konfigurasi yang tidak bisa diurai ditolak dengan KONFIGURASI_TIDAK_VALID, bukan diabaikan", async () => {
    // Fail closed. A ceiling that parses to NaN makes every comparison false
    // and silently disables the limit, which is worse than refusing the input.
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "dua ratus juta");
    await tolakDengan(
      async () => engine.buatProposal(input(await d.buatMitra()), d.ctx.maker),
      KODE_PUMK.KONFIGURASI_TIDAK_VALID,
    );
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "250000000.00");
  });

  test("maks pinjaman aktif per mitra ditegakkan sejak form proposal, bukan menunggu akad", async () => {
    await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "1");
    const mitra = await d.buatMitra();
    const lama = await d.siapkanProposal("DICAIRKAN", { mitra });
    expect(await d.dihitungSebagaiPiutangAktif(lama.akadId as string)).toBe(true);

    const err = await tolakDengan(
      () => engine.buatProposal(input(mitra), d.ctx.maker),
      KODE_PUMK.MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF,
    );
    expect(err.message).not.toContain("pumk_akad_satu_aktif_per_mitra_uq");

    // THE MECHANIC. Spec 5.5 makes the number a program parameter, and a
    // programme that later allows two concurrent loans must not need a deploy.
    await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "2");
    const p = await engine.buatProposal(input(mitra), d.ctx.maker);
    expect(p.mitraId).toBe(mitra.id);
  }, 60_000);

  test("akad BELUM_CAIR juga menghitung sebagai pinjaman aktif", async () => {
    // The partial unique index covers BELUM_CAIR precisely because a signed but
    // undisbursed akad is already a commitment. A module check that only looked
    // at AKTIF would pass the proposal and then hit the index at akad time.
    await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "1");
    const mitra = await d.buatMitra();
    await d.siapkanProposal("AKAD_DIBUAT", { mitra });
    await tolakDengan(
      () => engine.buatProposal(input(mitra), d.ctx.maker),
      KODE_PUMK.MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF,
    );
  }, 30_000);

  test("mitra yang pinjamannya sudah LUNAS boleh mengajukan lagi", async () => {
    // The mirror case, and the one that matters commercially: a repeat borrower
    // in good standing is the programme's best outcome. An over-eager check
    // that counted historical loans would lock them out permanently.
    await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "1");
    const mitra = await d.buatMitra();
    const lama = await d.siapkanProposal("DICAIRKAN", { mitra });
    await angsuran.alokasikanSetoran(
      {
        akadId: lama.akadId as string,
        tanggal: "2026-05-10",
        jumlah: rp(12_360_000),
        akunKasId: d.akun.kas.id,
      },
      d.ctx.maker,
    );
    expect((await d.bacaAkad(lama.akadId as string)).status).toBe("LUNAS");
    expect(await d.dihitungSebagaiPiutangAktif(lama.akadId as string)).toBe(false);
    angsuran.reset();

    const p = await engine.buatProposal(input(mitra), d.ctx.maker);
    expect(p.status).toBe("DRAFT");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Jaminan
// ---------------------------------------------------------------------------

describe("profil jaminan (spec 9.1, spec 4.4)", () => {
  test("beberapa jaminan boleh melekat pada satu proposal", async () => {
    const f = await d.siapkanProposal("DRAFT");
    const bpkb = await engine.tambahJaminan(
      f.proposalId,
      {
        jenis: "BPKB",
        deskripsi: "Sepeda motor Honda 2021",
        nilaiTaksasi: rp(18_000_000),
        nomorDokumen: "BPKB-123",
        atasNama: "Pemohon",
        tanggalTerima: TANGGAL_PROPOSAL_BAKU,
      },
      d.ctx.maker,
    );
    expect(bpkb.id.length).toBeGreaterThan(0);
    await engine.tambahJaminan(
      f.proposalId,
      { jenis: "SHM", deskripsi: "Tanah 90 m2", nilaiTaksasi: rp(120_000_000) },
      d.ctx.maker,
    );

    const daftar = await d.bacaJaminan(f.proposalId);
    expect(daftar).toHaveLength(2);
    expect(daftar.map((j) => j.jenis).sort()).toEqual(["BPKB", "SHM"]);
    expect(daftar.find((j) => j.jenis === "BPKB")?.nilai_taksasi).toBe(rp(18_000_000));
  }, 30_000);

  test("nilai taksasi yang bukan desimal dua angka ditolak", async () => {
    const f = await d.siapkanProposal("DRAFT");
    await tolakDengan(
      () => engine.tambahJaminan(f.proposalId, { jenis: "BPKB", nilaiTaksasi: "18000000" }, d.ctx.maker),
      KODE_PUMK.NILAI_BUKAN_DESIMAL,
    );
    expect(await d.bacaJaminan(f.proposalId)).toHaveLength(0);
  });

  test("di atas ambang konfigurasi, jaminan riil wajib sebelum maju ke checker", async () => {
    // The threshold is a programme parameter (spec 5.5), so the MECHANIC is
    // what is asserted. The check belongs at AJUKAN_CHECKER rather than at
    // creation: jaminan are attached after the proposal exists, so at creation
    // time there are none yet and refusing there would make the form
    // unusable.
    await d.setelKonfigurasi("batasan", "wajib_jaminan_di_atas_plafon", "10000000.00");
    const tanpa = await d.siapkanProposal("SURVEY_SELESAI", {
      jumlahDiajukan: rp(20_000_000),
      jaminan: "TANPA_JAMINAN",
    });
    await tolakDengan(
      () => engine.ajukanKeChecker(tanpa.proposalId, null, d.ctx.maker),
      KODE_PUMK.JAMINAN_WAJIB,
    );
    expect((await d.bacaProposal(tanpa.proposalId)).status).toBe("SURVEY_SELESAI");

    // With a real jaminan the same amount goes through.
    const dengan = await d.siapkanProposal("SURVEY_SELESAI", {
      jumlahDiajukan: rp(20_000_000),
      jaminan: "BPKB",
    });
    const p = await engine.ajukanKeChecker(dengan.proposalId, null, d.ctx.maker);
    expect(p.status).toBe("REVIEW_CHECKER");

    // And below the threshold, TANPA_JAMINAN is fine: raising the row must
    // change the answer for exactly the same proposal shape.
    await d.setelKonfigurasi("batasan", "wajib_jaminan_di_atas_plafon", "50000000.00");
    const kecil = await d.siapkanProposal("SURVEY_SELESAI", {
      jumlahDiajukan: rp(20_000_000),
      jaminan: "TANPA_JAMINAN",
    });
    const q = await engine.ajukanKeChecker(kecil.proposalId, null, d.ctx.maker);
    expect(q.status).toBe("REVIEW_CHECKER");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The list screen
// ---------------------------------------------------------------------------

describe("daftar proposal (spec 9.1)", () => {
  test("filter status, sektor dan rentang tanggal mempersempit hasil", async () => {
    const draft = await d.siapkanProposal("DRAFT", { tanggalProposal: "2026-01-05" });
    const menunggu = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", {
      tanggalProposal: "2026-02-20",
    });

    const hanyaDraft = await engine.daftarProposal({ status: "DRAFT" }, d.ctx.maker);
    expect(hanyaDraft.map((p) => p.id)).toContain(draft.proposalId);
    expect(hanyaDraft.map((p) => p.id)).not.toContain(menunggu.proposalId);
    for (const p of hanyaDraft) expect(p.status).toBe("DRAFT");

    const januari = await engine.daftarProposal(
      { dariTanggal: "2026-01-01", sampaiTanggal: "2026-01-31" },
      d.ctx.maker,
    );
    expect(januari.map((p) => p.id)).toContain(draft.proposalId);
    expect(januari.map((p) => p.id)).not.toContain(menunggu.proposalId);

    const sektor = await engine.daftarProposal({ sektorId: d.sektorId }, d.ctx.maker);
    expect(sektor.map((p) => p.id)).toContain(draft.proposalId);
    for (const p of sektor) expect(p.sektorId).toBe(d.sektorId);
  }, 30_000);

  test("pencarian menemukan proposal lewat nama mitra maupun NIK", async () => {
    // The officer at the counter has one of these two things in hand and
    // usually not both, so both have to work.
    // UNIQUE PER RUN, via the same `kunci()` every other business key in this
    // fixture goes through. `mitra_nik_uq` is GLOBAL and nothing here is
    // cleaned up between runs, so a hardcoded NIK passes once after a reset and
    // then raises 23505 on every re-run. A suite that only works on a fresh
    // database is not repeatable, and a non-repeatable failure reads like a
    // flake, which is worse than a red test because nobody trusts it either way.
    const nik = kunci("NIK").replace(/\D/g, "").padEnd(16, "0").slice(0, 16);
    const nama = `Rohmatul Ummah ${kunci("nm")}`;
    const mitra = await d.buatMitra({ nama, nik });
    const f = await d.siapkanProposal("DRAFT", { mitra });
    const lain = await d.siapkanProposal("DRAFT");

    const lewatNama = await engine.daftarProposal({ cari: nama }, d.ctx.maker);
    expect(lewatNama.map((p) => p.id)).toContain(f.proposalId);
    expect(lewatNama.map((p) => p.id)).not.toContain(lain.proposalId);

    const lewatNik = await engine.daftarProposal({ cari: nik }, d.ctx.maker);
    expect(lewatNik.map((p) => p.id)).toContain(f.proposalId);
    expect(lewatNik.map((p) => p.id)).not.toContain(lain.proposalId);
  }, 30_000);
});
