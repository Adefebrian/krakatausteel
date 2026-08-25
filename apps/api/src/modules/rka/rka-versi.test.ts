// SPEC 9.3'S VERSIONING SENTENCE, WHICH IS THE MOST SPECIFIC IN THAT SECTION:
//
//   "RKA punya versi dan status. RKA DISETUJUI jadi baseline pembanding.
//    Revisi membuat versi baru, laporan bisa memilih versi mana yang
//    dibandingkan."
//
// Four claims, and each one is a test below:
//   1. an approved version cannot be edited;
//   2. a revision creates a NEW version and leaves the original intact and
//      readable;
//   3. two versions coexist with EXACTLY ONE baseline;
//   4. a report can name which version it compares against.
//
// WHY THIS IS NOT DECORATION. Report 24, report 2 ("versus RKA") and report 13
// ("versus RKA") all measure performance against the approved baseline. If an
// approved version could be edited in place, last quarter's report becomes
// unreproducible the moment somebody adjusts a target, and the adjustment
// leaves no trace: the numbers simply improve. Invariant 14 forbids exactly
// that ("Laporan periode lampau yang dibuka hari ini harus menghasilkan angka
// yang sama dengan saat periode itu ditutup"), and spec 16 scenario 8 asks the
// same question of a rescheduled instalment plan, where the answer is a new
// version with the old one kept whole.
//
// THE SCHEMA HELPS BUT DOES NOT SUFFICE. `rka_baseline_uq` is a partial unique
// index over `status = 'DISETUJUI'`, so the database refuses a second approved
// version. It does NOT refuse an UPDATE of an approved version's amounts, and
// it does not decide what happens to the outgoing baseline. Both are the
// engine's, and both are tested here through the engine rather than by writing
// rows.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_RKA } from "./contract";
import {
  TAHUN_RKA,
  buatDunia,
  jumlahUang,
  kodeAda,
  rp,
  tolakDengan,
  type DuniaRka,
} from "./test-support";

let d: DuniaRka;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/**
 * A Non PUMK budget with one line per bidang in February. Non PUMK is used
 * throughout this file on purpose: its dimension travels on the ledger line,
 * so a version test never trips over the per-sector schema gap that
 * ./rka-realisasi-sumber.test.ts files.
 */
async function buatDraft(anggaranA: string, anggaranB: string) {
  return d.engine.buatRka(
    {
      cabangId: d.cabangId,
      tahun: TAHUN_RKA,
      jenis: "NON_PUMK",
      baris: [
        {
          bidangId: d.bidang.a.id,
          uraian: "Anggaran Pendidikan Februari",
          bulan: 2,
          jumlahAnggaran: anggaranA,
        },
        {
          bidangId: d.bidang.b.id,
          uraian: "Anggaran Kesehatan Februari",
          bulan: 2,
          jumlahAnggaran: anggaranB,
        },
      ],
    },
    d.ctx.adminPusat,
  );
}

describe("spec 9.3 klaim 1: RKA yang sudah disetujui tidak bisa diubah", () => {
  test("simpanBaris pada versi DISETUJUI ditolak, dan barisnya tidak bergerak satu sen pun", async () => {
    kodeAda(KODE_RKA.RKA_SUDAH_DISETUJUI);
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);

    await tolakDengan(
      () =>
        d.engine.simpanBaris(
          {
            rkaId: v1.id,
            baris: [
              {
                bidangId: d.bidang.a.id,
                uraian: "Dinaikkan diam diam",
                bulan: 2,
                jumlahAnggaran: rp(9_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.RKA_SUDAH_DISETUJUI,
    );

    // The refusal is only half the requirement. What matters is that nothing
    // moved: a guard that raises AFTER writing is indistinguishable from no
    // guard once the transaction commits.
    const baris = await d.bacaBarisRkaDb(v1.id);
    expect(baris).toHaveLength(2);
    expect(jumlahUang(...baris.map((b) => b.jumlah_anggaran))).toBe(rp(10_000_000));
  });

  test("versi REVISI (baseline lama) juga tidak bisa diubah, karena ia adalah riwayat", async () => {
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    await d.engine.setujuiRka({ rkaId: v2.id }, d.ctx.adminPusatLain);

    expect((await d.bacaRkaDb(v1.id)).status).toBe("REVISI");
    // A superseded version is the evidence for every report printed while it
    // was in force. Editable history is worse than no history.
    await tolakDengan(
      () =>
        d.engine.simpanBaris(
          {
            rkaId: v1.id,
            baris: [
              {
                bidangId: d.bidang.a.id,
                uraian: "Mengubah riwayat",
                bulan: 2,
                jumlahAnggaran: rp(1_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.RKA_SUDAH_DISETUJUI,
    );
  });

  test("versi DRAFT memang bisa diubah, jadi larangan di atas adalah tentang persetujuan", async () => {
    // The control half of the two tests above. Without it, an engine that
    // refused every edit would pass them both.
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    const sesudah = await d.engine.simpanBaris(
      {
        rkaId: v1.id,
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Anggaran Pendidikan Februari (revisi draft)",
            bulan: 2,
            jumlahAnggaran: rp(7_250_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    expect(sesudah.baris).toHaveLength(1);
    expect(sesudah.totalAnggaran).toBe(rp(7_250_000));
    // simpanBaris REPLACES the grid: the bidang B row is gone, not orphaned.
    expect(await d.bacaBarisRkaDb(v1.id)).toHaveLength(1);
  });

  test("menyetujui sesuatu yang bukan DRAFT ditolak", async () => {
    kodeAda(KODE_RKA.RKA_BUKAN_DRAFT);
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    await tolakDengan(
      () => d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain),
      KODE_RKA.RKA_BUKAN_DRAFT,
    );
  });
});

describe("spec 9.3 klaim 2: revisi membuat versi baru, versi lama tetap utuh dan bisa dibaca", () => {
  test("revisi menaikkan nomor versi, menyalin barisnya, dan tidak menyentuh versi asal", async () => {
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const barisV1Sebelum = await d.bacaBarisRkaDb(v1.id);

    const v2 = await d.engine.buatRevisi(
      { rkaId: v1.id, keterangan: "Realokasi kuartal 2" },
      d.ctx.adminPusat,
    );

    expect(v2.id).not.toBe(v1.id);
    expect(v2.versi).toBe(2);
    expect(v2.status).toBe("DRAFT");
    expect(v2.versiSebelumnya).toBe(1);
    expect(v2.tahun).toBe(v1.tahun);
    expect(v2.jenis).toBe(v1.jenis);
    expect(v2.cabangId).toBe(v1.cabangId);
    // Copied by default: a revision is an edit of the numbers in force, and an
    // empty grid invites re-keying a budget that already exists.
    expect(v2.baris).toHaveLength(2);
    expect(v2.totalAnggaran).toBe(v1.totalAnggaran);

    // THE CLAIM THAT MATTERS: version 1 is untouched, still approved, still
    // the baseline, still carrying its own rows with their own ids.
    const v1Sesudah = await d.bacaRkaDb(v1.id);
    expect(v1Sesudah.status).toBe("DISETUJUI");
    expect(v1Sesudah.versi).toBe(1);
    const barisV1Sesudah = await d.bacaBarisRkaDb(v1.id);
    expect(barisV1Sesudah.map((b) => `${b.id}:${b.jumlah_anggaran}`)).toEqual(
      barisV1Sebelum.map((b) => `${b.id}:${b.jumlah_anggaran}`),
    );
    // And the copies are NEW rows, not the same rows re-pointed.
    const idV2 = new Set((await d.bacaBarisRkaDb(v2.id)).map((b) => b.id));
    for (const b of barisV1Sesudah) expect(idV2.has(b.id)).toBe(false);
  });

  test("mengubah versi 2 tidak mengubah versi 1, yang tetap bisa dibaca lewat mesin", async () => {
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);

    await d.engine.simpanBaris(
      {
        rkaId: v2.id,
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Pendidikan naik",
            bulan: 2,
            jumlahAnggaran: rp(9_500_000),
          },
          {
            bidangId: d.bidang.b.id,
            uraian: "Kesehatan turun",
            bulan: 2,
            jumlahAnggaran: rp(500_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );

    const bacaV1 = await d.engine.bacaRka(v1.id, d.ctx.adminPusat);
    expect(bacaV1.totalAnggaran).toBe(rp(10_000_000));
    expect(bacaV1.status).toBe("DISETUJUI");
    const bacaV2 = await d.engine.bacaRka(v2.id, d.ctx.adminPusat);
    expect(bacaV2.totalAnggaran).toBe(rp(10_000_000));
    expect(bacaV2.baris.find((b) => b.bidangId === d.bidang.a.id)?.jumlahAnggaran).toBe(
      rp(9_500_000),
    );
  });

  test("revisi tanpa salinan baris memberi grid kosong, tanpa merusak versi asal", async () => {
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id, salinBaris: false }, d.ctx.adminPusat);
    expect(v2.baris).toHaveLength(0);
    expect(v2.totalAnggaran).toBe("0.00");
    expect(await d.bacaBarisRkaDb(v1.id)).toHaveLength(2);
  });

  test("revisi dari versi yang belum pernah disetujui ditolak", async () => {
    kodeAda(KODE_RKA.REVISI_HARUS_DARI_DISETUJUI);
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    // A DRAFT is simply edited. Allowing a revision of one would produce a
    // second unapproved version for the same scope, and then two candidates
    // where spec 9.3 expects one baseline and one open revision.
    await tolakDengan(
      () => d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat),
      KODE_RKA.REVISI_HARUS_DARI_DISETUJUI,
    );
  });

  test("revisi kedua ditolak selama revisi pertama masih DRAFT", async () => {
    kodeAda(KODE_RKA.REVISI_MASIH_TERBUKA);
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    await tolakDengan(
      () => d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat),
      KODE_RKA.REVISI_MASIH_TERBUKA,
    );
  });
});

describe("spec 9.3 klaim 3: dua versi hidup berdampingan dengan tepat satu baseline", () => {
  test("menyetujui versi 2 memindahkan versi 1 ke REVISI, dalam satu transaksi", async () => {
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    await d.engine.simpanBaris(
      {
        rkaId: v2.id,
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Pendidikan revisi",
            bulan: 2,
            jumlahAnggaran: rp(8_000_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: v2.id }, d.ctx.adminPusatLain);

    const semua = await d.daftarRkaDb({ tahun: TAHUN_RKA, jenis: "NON_PUMK" });
    expect(semua).toHaveLength(2);
    expect(semua.filter((r) => r.status === "DISETUJUI")).toHaveLength(1);
    expect(semua.find((r) => r.versi === 1)?.status).toBe("REVISI");
    expect(semua.find((r) => r.versi === 2)?.status).toBe("DISETUJUI");

    // `rka_baseline_uq` means the two cannot both be DISETUJUI even for an
    // instant, so the ordering inside `setujuiRka` is not a preference. If the
    // engine approved first and demoted second, this test would fail with
    // BASELINE_GANDA rather than pass, which is the point.
    expect(semua.every((r) => r.deleted_at === null)).toBe(true);
  });

  test("versi lama tetap punya approved_by dan approved_at setelah digeser ke REVISI", async () => {
    // Otherwise nobody can answer "who approved the budget this report was
    // printed against", which is the auditor's first question and the reason
    // `admin.rka.view` is a finding in ./rka-fixture.test.ts.
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    await d.engine.setujuiRka({ rkaId: v2.id }, d.ctx.adminPusatLain);

    const lama = await d.bacaRkaDb(v1.id);
    expect(lama.approved_by).toBe(d.userId.adminPusatLain);
    expect(lama.approved_at).not.toBeNull();
  });

  test("baseline() mengembalikan versi DISETUJUI, dan null ketika belum ada", async () => {
    kodeAda(KODE_RKA.BASELINE_TIDAK_ADA);
    const kunciScope = { tahun: TAHUN_RKA, jenis: "NON_PUMK" as const, cabangId: d.cabangId };

    // Nothing approved yet: null, not the newest draft. A draft is somebody's
    // proposal, and reporting against it presents an unapproved target as
    // performance.
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    expect(await d.engine.baseline(kunciScope, d.ctx.adminPusat)).toBeNull();

    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    expect((await d.engine.baseline(kunciScope, d.ctx.adminPusat))?.id).toBe(v1.id);

    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    // An open revision does not move the baseline. This is the case that
    // matters in practice: budgets spend months in revision, and every report
    // printed meanwhile must still measure against what is in force.
    expect((await d.engine.baseline(kunciScope, d.ctx.adminPusat))?.id).toBe(v1.id);

    await d.engine.setujuiRka({ rkaId: v2.id }, d.ctx.adminPusatLain);
    expect((await d.engine.baseline(kunciScope, d.ctx.adminPusat))?.id).toBe(v2.id);
  });

  test("daftarRka menampilkan setiap versi dengan status dan nomornya", async () => {
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);

    const daftar = await d.engine.daftarRka(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK" },
      d.ctx.adminPusat,
    );
    expect(daftar).toHaveLength(2);
    // Newest first: the screen's first row is the one being worked on.
    expect(daftar.map((r) => r.versi)).toEqual([2, 1]);
    expect(daftar.map((r) => r.status)).toEqual(["DRAFT", "DISETUJUI"]);
  });
});

describe("spec 9.3 klaim 4: laporan bisa memilih versi mana yang dibandingkan", () => {
  test("versi 1 dan versi 2 memberi anggaran berbeda untuk realisasi yang sama", async () => {
    // The whole point of the sentence, as one experiment. The ledger is
    // arranged ONCE; only the budget changes between the two calls, so any
    // difference in `realisasi` would mean the report is reading the version
    // for something it should not.
    d.setelJam("2026-04-15");
    const salur = await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.a.id,
      jumlah: rp(5_000_000),
    });

    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    await d.engine.simpanBaris(
      {
        rkaId: v2.id,
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Pendidikan revisi",
            bulan: 2,
            jumlahAnggaran: rp(10_000_000),
          },
          {
            bidangId: d.bidang.b.id,
            uraian: "Kesehatan revisi",
            bulan: 2,
            jumlahAnggaran: rp(4_000_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: v2.id }, d.ctx.adminPusatLain);

    const filter = {
      tahun: TAHUN_RKA,
      jenis: "NON_PUMK" as const,
      cabangId: d.cabangId,
      mode: "BULANAN" as const,
      bulan: 2,
    };
    const pakaiV1 = await d.engine.laporanRkaVsRealisasi(
      { ...filter, versi: 1 },
      d.ctx.adminPusat,
    );
    const pakaiV2 = await d.engine.laporanRkaVsRealisasi(
      { ...filter, versi: 2 },
      d.ctx.adminPusat,
    );

    expect(pakaiV1.versi).toBe(1);
    expect(pakaiV1.statusRka).toBe("REVISI");
    expect(pakaiV2.versi).toBe(2);
    expect(pakaiV2.statusRka).toBe("DISETUJUI");

    const barisA = (l: typeof pakaiV1) => l.baris.find((b) => b.dimensiId === d.bidang.a.id)!;
    expect(barisA(pakaiV1).anggaran).toBe(rp(6_000_000));
    expect(barisA(pakaiV2).anggaran).toBe(rp(10_000_000));
    // Same ledger, so the same realisation, whichever version was chosen.
    expect(barisA(pakaiV1).realisasi).toBe(salur.jumlah);
    expect(barisA(pakaiV2).realisasi).toBe(barisA(pakaiV1).realisasi);
    // And therefore a different verdict on the same performance, which is what
    // makes choosing the version a real decision rather than a display option.
    expect(barisA(pakaiV1).persenCapaian).not.toBe(barisA(pakaiV2).persenCapaian);
  });

  test("tanpa menyebut versi, laporan memakai baseline DISETUJUI", async () => {
    d.setelJam("2026-04-15");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.a.id,
      jumlah: rp(5_000_000),
    });
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    // An OPEN revision with wildly different numbers, which must NOT be used.
    const v2 = await d.engine.buatRevisi({ rkaId: v1.id }, d.ctx.adminPusat);
    await d.engine.simpanBaris(
      {
        rkaId: v2.id,
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Usulan revisi",
            bulan: 2,
            jumlahAnggaran: rp(99_000_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );

    const laporan = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(laporan.versi).toBe(1);
    expect(laporan.rkaId).toBe(v1.id);
    expect(laporan.statusRka).toBe("DISETUJUI");
  });

  test("tanpa baseline dan tanpa versi yang disebut, laporan menolak alih alih memakai draft", async () => {
    await buatDraft(rp(6_000_000), rp(4_000_000));
    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
          d.ctx.adminPusat,
        ),
      KODE_RKA.BASELINE_TIDAK_ADA,
    );
  });

  test("versi yang tidak ada ditolak, bukan diam diam jatuh ke baseline", async () => {
    kodeAda(KODE_RKA.VERSI_TIDAK_DITEMUKAN);
    const v1 = await buatDraft(rp(6_000_000), rp(4_000_000));
    await d.engine.setujuiRka({ rkaId: v1.id }, d.ctx.adminPusatLain);
    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          {
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            cabangId: d.cabangId,
            versi: 7,
            mode: "BULANAN",
            bulan: 2,
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.VERSI_TIDAK_DITEMUKAN,
    );
  });
});
