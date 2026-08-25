// SPEC 9.2's TWO MANDATORY MAPPINGS AND THE BENEFICIARY FIELDS.
//
//   "Wajib pemetaan ke bidang Non PUMK dan minimal satu SDG."
//   "Field penerima manfaat (estimasi saat proposal, aktual saat LPJ)."
//
// These are the two things that make a Non PUMK grant REPORTABLE. Spec 10.2's
// "Laporan Penyaluran per Bidang" and "Laporan Kontribusi SDG" are both
// group-bys over data that only exists if it was refused at input time; a
// proposal that reached DISALURKAN without a bidang or without an SDG is a row
// that will be missing from a report the BUMN files with its regulator, and by
// then the money has gone.
//
// So every rule here is enforced AT CREATION, and the refusal is asserted
// together with the absence of the row: an engine that writes the proposal and
// then complains has already lost.
//
// WHAT IS DELIBERATELY NOT HERE. The state machine is ./nonpumk-state-machine
// .test.ts's; the authorisation is ./nonpumk-otorisasi.test.ts's. This file is
// about the CONTENT of a proposal and the configuration it is validated
// against.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createNonPumkEngine,
  KODE_NONPUMK,
  KUNCI_KONFIGURASI_NONPUMK,
  type BuatProposalNonPumkInput,
  type NonPumkEngine,
} from "./contract";
import {
  buatDunia,
  porterJurnalUji,
  rp,
  tolakDengan,
  DIAJUKAN_BAKU,
  PENERIMA_ESTIMASI_BAKU,
  TANGGAL_PROPOSAL_BAKU,
  type DuniaNonPumk,
  type PorterJurnalUji,
} from "./test-support";

let d: DuniaNonPumk;
let engine: NonPumkEngine;
let jurnal: PorterJurnalUji;

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  engine = createNonPumkEngine({ db: d.db, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

function input(ubah: Partial<BuatProposalNonPumkInput> = {}): BuatProposalNonPumkInput {
  return {
    cabangId: d.cabangId,
    tanggalProposal: TANGGAL_PROPOSAL_BAKU,
    namaPemohon: "Yayasan Cahaya Bangsa",
    atasNama: "Ketua Yayasan",
    alamat: "Jl. Merdeka No. 10",
    kelurahan: "Kebondalem",
    kecamatan: "Purwakarta",
    kotaId: d.kotaId,
    telepon: "081200000003",
    email: "cahaya@example.test",
    bidangId: d.bidang.id,
    sdg: [{ sdgId: d.sdg[0].id }, { sdgId: d.sdg[1].id, bobot: "0.400000" }],
    judulProgram: "Renovasi ruang kelas dan pengadaan buku",
    deskripsiProgram: "Renovasi tiga ruang kelas dan pengadaan 500 buku bacaan",
    jumlahDiajukan: DIAJUKAN_BAKU,
    penerimaManfaatEstimasi: PENERIMA_ESTIMASI_BAKU,
    ...ubah,
  };
}

/** How many live proposals this world holds; used to prove nothing was written. */
async function jumlahProposal(): Promise<number> {
  const baris = await d.db.query<{ n: number }>(
    `select count(*)::int as n from nonpumk_proposal p
       join cabang c on c.id = p.cabang_id
      where c.bumn_id = $1 and p.deleted_at is null`,
    [d.bumnId],
  );
  return baris[0].n;
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("buat proposal (spec 4.5, spec 9.2)", () => {
  test("proposal DRAFT tersimpan lengkap dengan bidang, SDG berbobot, dan penerima manfaat estimasi", async () => {
    const p = await engine.buatProposal(input(), d.ctx.maker);

    expect(p.status).toBe("DRAFT");
    expect(p.cabangId).toBe(d.cabangId);
    expect(p.bidangId).toBe(d.bidang.id);
    expect(p.jumlahDiajukan).toBe(DIAJUKAN_BAKU);
    // A brand new proposal has no ceiling: that only exists after an approval.
    expect(p.jumlahDisetujui).toBeNull();
    expect(p.penerimaManfaatEstimasi).toBe(PENERIMA_ESTIMASI_BAKU);
    expect(p.sumberPengajuan).toBe("INTERNAL");
    expect(p.createdBy).toBe(d.userId.maker);
    // Numbered through modules/nomor inside the same transaction, so a rolled
    // back proposal does not burn a number and a committed one always has one.
    expect(p.noProposal.length).toBeGreaterThan(0);

    const db = await d.bacaProposal(p.id);
    expect(db.nama_pemohon).toBe("Yayasan Cahaya Bangsa");
    expect(db.judul_program).toBe("Renovasi ruang kelas dan pengadaan buku");
    expect(db.penerima_manfaat_estimasi).toBe(PENERIMA_ESTIMASI_BAKU);

    // spec 4.5's `sdg_ids`, realised as a weighted relation (ASSUMPTIONS.md
    // A-09 / A-13): an array column could not carry the bobot and could not be
    // joined for the SDG contribution report.
    const sdg = await d.bacaSdg(p.id);
    expect(sdg.map((s) => s.nomor)).toEqual([1, 4]);
    expect(sdg.find((s) => s.nomor === 4)?.bobot).toBe("0.400000");
    // Default weight is 1, not 0: an unweighted mapping still contributes fully.
    expect(sdg.find((s) => s.nomor === 1)?.bobot).toBe("1.000000");

    // Creating a proposal moves no money.
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("dua proposal berturut turut dapat nomor berbeda", async () => {
    // Spec 4.10 calls the numbering "aman dari race condition", and a duplicate
    // would be refused by nonpumk_proposal_no_uq anyway. What this pins is that
    // the engine ALLOCATES rather than reusing, which a naive implementation
    // that derives the number from the date would get wrong.
    const a = await engine.buatProposal(input(), d.ctx.maker);
    const b = await engine.buatProposal(input(), d.ctx.maker);
    expect(a.noProposal).not.toBe(b.noProposal);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Mandatory bidang (spec 9.2)
// ---------------------------------------------------------------------------

describe("pemetaan bidang wajib (spec 9.2)", () => {
  test("bidang yang tidak ada ditolak dengan BIDANG_TIDAK_DITEMUKAN, tanpa menulis proposal", async () => {
    const sebelum = await jumlahProposal();
    await tolakDengan(
      () =>
        engine.buatProposal(
          input({ bidangId: "00000000-0000-4000-8000-000000000009" }),
          d.ctx.maker,
        ),
      KODE_NONPUMK.BIDANG_TIDAK_DITEMUKAN,
    );
    expect(await jumlahProposal()).toBe(sebelum);
  });

  test("bidang milik BUMN lain ditolak, walau id-nya nyata", async () => {
    // `bidang_non_pumk` is scoped per bumn (bidang_non_pumk_kode_uq is on
    // (bumn_id, kode)), and the FK on nonpumk_proposal is not: Postgres would
    // happily accept another tenant's bidang. So this is a rule only the module
    // can enforce, and it is the kind that is invisible until two BUMN share an
    // installation.
    const lain = await d.db.query<{ id: string }>(
      `insert into bumn (kode, nama, tahun_buku_mulai_bulan) values ($1, $2, 1) returning id::text as id`,
      [`BUMN-LAIN-${Date.now()}-${Math.floor(Math.random() * 100000)}`, "BUMN lain (uji bidang)"],
    );
    const bidangAsing = await d.db.query<{ id: string }>(
      `insert into bidang_non_pumk (bumn_id, kode, nama) values ($1, 'BDG-ASING', 'Bidang BUMN lain')
       returning id::text as id`,
      [lain[0].id],
    );
    await tolakDengan(
      () => engine.buatProposal(input({ bidangId: bidangAsing[0].id }), d.ctx.maker),
      KODE_NONPUMK.BIDANG_TIDAK_DITEMUKAN,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Mandatory SDG (spec 9.2)
// ---------------------------------------------------------------------------

describe("pemetaan SDG wajib, minimal satu (spec 9.2)", () => {
  test("daftar SDG kosong ditolak dengan SDG_WAJIB, dan tidak ada proposal yatim", async () => {
    // Nothing in the schema enforces this: nonpumk_proposal_sdg is a separate
    // table with no "at least one" constraint, so an engine that simply skipped
    // the loop would leave a proposal that is invisible to the SDG report and
    // perfectly valid to the database.
    const sebelum = await jumlahProposal();
    await tolakDengan(() => engine.buatProposal(input({ sdg: [] }), d.ctx.maker), KODE_NONPUMK.SDG_WAJIB);
    expect(await jumlahProposal()).toBe(sebelum);
  });

  test("satu SDG cukup: aturannya MINIMAL satu, bukan tepat dua", async () => {
    // The boundary on the permissive side. Without it, an engine that demanded
    // two would pass the test above and be wrong.
    const p = await engine.buatProposal(input({ sdg: [{ sdgId: d.sdg[2].id }] }), d.ctx.maker);
    const sdg = await d.bacaSdg(p.id);
    expect(sdg.map((s) => s.nomor)).toEqual([13]);
  }, 30_000);

  test("SDG yang tidak ada ditolak dengan SDG_TIDAK_DITEMUKAN, dan proposal ikut batal", async () => {
    // All or nothing: the proposal and its mappings commit together, so a bad
    // SDG in position two must not leave a proposal carrying only position one.
    const sebelum = await jumlahProposal();
    await tolakDengan(
      () =>
        engine.buatProposal(
          input({ sdg: [{ sdgId: d.sdg[0].id }, { sdgId: "00000000-0000-4000-8000-00000000000a" }] }),
          d.ctx.maker,
        ),
      KODE_NONPUMK.SDG_TIDAK_DITEMUKAN,
    );
    expect(await jumlahProposal()).toBe(sebelum);
  });

  test("SDG ganda ditolak dengan SDG_DUPLIKAT, bukan dibiarkan meledak di primary key", async () => {
    // nonpumk_proposal_sdg's PK is (proposal_id, sdg_id), so the second insert
    // raises 23505. The caller must see a domain error, not a constraint name,
    // and the duplicate is almost always a double-clicked chip in the form.
    const err = await tolakDengan(
      () =>
        engine.buatProposal(
          input({ sdg: [{ sdgId: d.sdg[0].id }, { sdgId: d.sdg[0].id }] }),
          d.ctx.maker,
        ),
      KODE_NONPUMK.SDG_DUPLIKAT,
    );
    expect(err.message).not.toContain("nonpumk_proposal_sdg_pkey");
  });

  test("bobot di luar 0 sampai 1 ditolak, di kedua ujungnya, AT the boundary", async () => {
    // ASSUMPTIONS.md A-09: 0 < bobot <= 1, and the CHECK constraint says the
    // same. Asserted AT the boundary rather than near it, because "greater than
    // zero" and "at least zero" differ by exactly one value and that value is
    // the one a form submits when the field is left empty.
    for (const bobot of ["0.000000", "1.000001", "-0.500000"]) {
      await tolakDengan(
        () => engine.buatProposal(input({ sdg: [{ sdgId: d.sdg[0].id, bobot }] }), d.ctx.maker),
        KODE_NONPUMK.BOBOT_SDG_TIDAK_VALID,
      );
    }
    // Exactly 1 is the inclusive upper bound and must be accepted.
    const p = await engine.buatProposal(
      input({ sdg: [{ sdgId: d.sdg[0].id, bobot: "1.000000" }] }),
      d.ctx.maker,
    );
    expect((await d.bacaSdg(p.id))[0].bobot).toBe("1.000000");
  }, 30_000);

  test("bobot TIDAK dipaksa berjumlah satu", async () => {
    // ASSUMPTIONS.md A-09 says so explicitly: a programme can be partially
    // attributable to several goals, and normalising would be an invented rule
    // that quietly changes every SDG contribution figure.
    const p = await engine.buatProposal(
      input({
        sdg: [
          { sdgId: d.sdg[0].id, bobot: "0.800000" },
          { sdgId: d.sdg[1].id, bobot: "0.800000" },
        ],
      }),
      d.ctx.maker,
    );
    const sdg = await d.bacaSdg(p.id);
    expect(sdg.map((s) => s.bobot)).toEqual(["0.800000", "0.800000"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Beneficiaries (spec 9.2)
// ---------------------------------------------------------------------------

describe("penerima manfaat, estimasi saat proposal (spec 9.2)", () => {
  test("estimasi wajib ada saat proposal", async () => {
    // The column is nullable, because spec 4.5 allows an imported legacy row to
    // lack it. That makes this the module's rule and nobody else's, and it is
    // the number every "penerima manfaat" figure in spec 10.2 and the dashboard
    // is built from.
    const sebelum = await jumlahProposal();
    await tolakDengan(
      () =>
        engine.buatProposal(
          input({ penerimaManfaatEstimasi: undefined as unknown as number }),
          d.ctx.maker,
        ),
      KODE_NONPUMK.PENERIMA_MANFAAT_WAJIB,
    );
    expect(await jumlahProposal()).toBe(sebelum);
  });

  test("estimasi negatif atau bukan bilangan bulat ditolak", async () => {
    for (const nilai of [-1, 12.5]) {
      await tolakDengan(
        () => engine.buatProposal(input({ penerimaManfaatEstimasi: nilai }), d.ctx.maker),
        KODE_NONPUMK.PENERIMA_MANFAAT_WAJIB,
      );
    }
  }, 30_000);

  test("estimasi nol diterima: sebuah program bisa punya penerima yang belum terhitung", async () => {
    // The permissive boundary, and a real case: an environmental programme's
    // beneficiaries may genuinely not be countable at proposal time. The CHECK
    // constraint allows >= 0, so refusing zero would be the module inventing a
    // rule the schema does not have.
    const p = await engine.buatProposal(input({ penerimaManfaatEstimasi: 0 }), d.ctx.maker);
    expect(p.penerimaManfaatEstimasi).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Amount bounds, READ from configuration
// ---------------------------------------------------------------------------

describe("batas nilai dibaca dari konfigurasi, bukan dari kode", () => {
  test("nilai di luar batas ditolak, dan batasnya bisa diubah lewat baris konfigurasi", async () => {
    // Spec 5's preamble makes every parameter the client's, and spec 5.5 does
    // not even list a Non PUMK bound (TEMUAN 3). So this asserts the MECHANIC:
    // change the row, change the outcome. It never asserts that 1 juta or 500
    // juta is the right number, because nobody has decided that.
    await d.denganKonfigurasi("batasan", "nilai_max_non_pumk", "100000000.00", async () => {
      await d.denganKonfigurasi("batasan", "nilai_min_non_pumk", "1000000.00", async () => {
        await tolakDengan(
          () => engine.buatProposal(input({ jumlahDiajukan: rp(999_999) }), d.ctx.maker),
          KODE_NONPUMK.NILAI_DILUAR_BATAS,
        );
        await tolakDengan(
          () => engine.buatProposal(input({ jumlahDiajukan: "100000000.01" }), d.ctx.maker),
          KODE_NONPUMK.NILAI_DILUAR_BATAS,
        );
        // AT the boundary, both ends inclusive.
        const min = await engine.buatProposal(input({ jumlahDiajukan: rp(1_000_000) }), d.ctx.maker);
        expect(min.jumlahDiajukan).toBe(rp(1_000_000));
        const max = await engine.buatProposal(input({ jumlahDiajukan: rp(100_000_000) }), d.ctx.maker);
        expect(max.jumlahDiajukan).toBe(rp(100_000_000));
      });
    });

    // Raise the ceiling: the SAME amount that was refused is now accepted.
    const lagi = await d.denganKonfigurasi("batasan", "nilai_max_non_pumk", "200000000.00", () =>
      engine.buatProposal(input({ jumlahDiajukan: "100000000.01" }), d.ctx.maker),
    );
    expect(lagi.jumlahDiajukan).toBe("100000000.01");
  }, 60_000);

  test("konfigurasi yang hilang ditolak dengan KONFIGURASI_TIDAK_ADA, bukan diganti angka bawaan", async () => {
    // TEMUAN 3: migrations/0004 ships NO Non PUMK parameter, so this is the
    // state a fresh installation is actually in. Falling back to a literal would
    // mean the first grant of a new tenant is validated against a number nobody
    // chose, and the fallback would be invisible in every screenshot.
    const err = await d.tanpaKonfigurasi(
      KUNCI_KONFIGURASI_NONPUMK.NILAI_MAX.grup,
      KUNCI_KONFIGURASI_NONPUMK.NILAI_MAX.kunci,
      () => tolakDengan(() => engine.buatProposal(input(), d.ctx.maker), KODE_NONPUMK.KONFIGURASI_TIDAK_ADA),
    );
    // The message has to name the key, or the operator cannot fix it.
    expect(err.message).toContain(KUNCI_KONFIGURASI_NONPUMK.NILAI_MAX.kunci);
  }, 30_000);

  test("nilai yang bukan desimal dua angka ditolak sebelum menyentuh NUMERIC", async () => {
    // Invariant 7: money is a fixed-precision decimal string at every edge,
    // never a float. Postgres would round "1000000.005" silently into
    // NUMERIC(20,2); the module must refuse it, because a rounded grant amount
    // is a grant amount nobody typed.
    for (const nilai of ["1000000", "1000000.5", "1000000.005", "1e6", "abc"]) {
      await tolakDengan(
        () => engine.buatProposal(input({ jumlahDiajukan: nilai as never }), d.ctx.maker),
        KODE_NONPUMK.NILAI_BUKAN_DESIMAL,
      );
    }
  }, 30_000);

  test("nilai nol atau negatif ditolak sebelum CHECK jumlah_diajukan > 0", async () => {
    for (const nilai of ["0.00", "-1000000.00"]) {
      const err = await tolakDengan(
        () => engine.buatProposal(input({ jumlahDiajukan: nilai }), d.ctx.maker),
        KODE_NONPUMK.NILAI_DILUAR_BATAS,
      );
      expect(err.message).not.toContain("jumlah_diajukan");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Listing and filtering (spec 9.2's daftar proposal)
// ---------------------------------------------------------------------------

describe("daftar proposal", () => {
  test("filter bidang dan SDG benar benar menyaring, karena itulah gunanya pemetaan wajib", async () => {
    // The payoff of the two mandatory mappings. If either filter silently
    // ignores its argument, every per-bidang and per-SDG report built on top of
    // this reads the whole population instead of the slice it claims.
    const a = await d.siapkanProposal("DISETUJUI", { bidang: d.bidang, sdgIds: [d.sdg[0].id] });
    const b = await d.siapkanProposal("DISETUJUI", { bidang: d.bidangLain, sdgIds: [d.sdg[2].id] });

    const perBidang = await engine.daftarProposal({ bidangId: d.bidangLain.id }, d.ctx.maker);
    expect(perBidang.map((p) => p.id)).toContain(b.proposalId);
    expect(perBidang.map((p) => p.id)).not.toContain(a.proposalId);

    const perSdg = await engine.daftarProposal({ sdgId: d.sdg[0].id }, d.ctx.maker);
    expect(perSdg.map((p) => p.id)).toContain(a.proposalId);
    expect(perSdg.map((p) => p.id)).not.toContain(b.proposalId);
  }, 60_000);

  test("filter status dan rentang tanggal menyaring, dan keduanya berlaku bersamaan", async () => {
    const lama = await d.siapkanProposal("DRAFT", { tanggalProposal: "2026-01-10" });
    const baru = await d.siapkanProposal("DRAFT", { tanggalProposal: "2026-05-10" });
    const lainStatus = await d.siapkanProposal("DISETUJUI", { tanggalProposal: "2026-05-11" });

    const hasil = await engine.daftarProposal(
      { status: "DRAFT", dariTanggal: "2026-05-01", sampaiTanggal: "2026-05-31" },
      d.ctx.maker,
    );
    const ids = hasil.map((p) => p.id);
    expect(ids).toContain(baru.proposalId);
    expect(ids).not.toContain(lama.proposalId);
    expect(ids).not.toContain(lainStatus.proposalId);
  }, 60_000);

  test("ringkasan() menyatukan pemetaan, penilaian dan penerima manfaat dalam satu panggilan", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    const r = await engine.ringkasan(f.proposalId, d.ctx.maker);
    expect(r.proposal.id).toBe(f.proposalId);
    expect(r.proposal.bidangId).toBe(d.bidang.id);
    expect(r.sdg.map((s) => s.nomor)).toEqual([1, 4]);
    expect(r.penilaian?.skorTotal).toBe("82.000000");
    expect(r.proposal.penerimaManfaatEstimasi).toBe(PENERIMA_ESTIMASI_BAKU);
    // Nothing disbursed yet: the headroom is the whole approved amount.
    expect(r.totalDisalurkan).toBe("0.00");
    expect(r.sisaPagu).toBe(f.jumlahDisetujui as string);
    expect(r.lpj).toBeNull();
    expect(r.bebanBersihBukuBesar).toBe("0.00");
  }, 30_000);
});
