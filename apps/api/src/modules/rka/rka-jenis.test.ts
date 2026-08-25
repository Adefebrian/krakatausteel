// SPEC 9.3'S THREE BUDGET TYPES, AND THE DIMENSION EACH ONE IS FILED AGAINST.
//
//   "Input RKA PUMK: target penyaluran per sektor per bulan, jumlah mitra target."
//   "Input RKA Non PUMK: anggaran per bidang per bulan."
//   "Input RKA Keuangan: anggaran per akun beban dan target pendapatan per bulan."
//
// The three sentences differ in exactly one thing that matters downstream: the
// dimension. Spec 10.3 report 24 repeats it ("per akun untuk RKA Keuangan, per
// sektor untuk RKA PUMK, per bidang untuk RKA Non PUMK") and migrations/0012
// enforces it with `trg_rka_detail_10_dimensi`, which raises TJSL-RKA-001,
// -002 and -003.
//
// WHY THE DIMENSION RULE IS WORTH ITS OWN FILE. A budget line filed against
// the wrong dimension is not a validation nicety: it is a line that is
// INVISIBLE to the report that should have shown it and simultaneously absent
// from every other report, because report 24 selects by (jenis, dimensi). The
// money is budgeted, the total on the entry screen is right, and no report
// anywhere shows the line. There is no balance to check and nothing to
// reconcile it against, so nothing detects it.
//
// So the engine must refuse FIRST, with a domain error, and the trigger must
// remain as the last line of defence. `tolakDengan` asserts `instanceof
// RkaError`, which the raw trigger text can never satisfy: if these tests ever
// go green by letting Postgres do the rejecting, the message an operator sees
// is 'TJSL-RKA-001: baris RKA PUMK wajib punya sektor_id'.
//
// EVERY RKA IN THIS FILE IS CREATED BY THE ENGINE UNDER TEST. There is no raw
// SQL shortcut, deliberately: an engine that never wrote the row cannot be
// said to have accepted it. That is why these tests currently fail inside
// `buatRka`, and the failure names the missing method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DIMENSI_UNTUK_JENIS, KODE_RKA } from "./contract";
import {
  PENCAIRAN_SEKTOR_A,
  TAHUN_RKA,
  buatDunia,
  jumlahUang,
  kodeAda,
  rp,
  tolakDengan,
  uangValid,
  type DuniaRka,
} from "./test-support";

let d: DuniaRka;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

describe("spec 9.3: RKA PUMK, target penyaluran per sektor per bulan plus jumlah mitra target", () => {
  test("menyimpan satu baris per sektor per bulan, dengan jumlah unit sebagai target mitra", async () => {
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Target penyaluran Perdagangan",
            bulan: 2,
            jumlahAnggaran: rp(8_000_000),
            jumlahUnit: 3,
          },
          {
            sektorId: d.sektor.b.id,
            uraian: "Target penyaluran Industri",
            bulan: 3,
            jumlahAnggaran: rp(5_000_000),
            jumlahUnit: 2,
          },
        ],
      },
      d.ctx.adminPusat,
    );

    expect(rka.jenis).toBe("PUMK");
    expect(rka.status).toBe("DRAFT");
    expect(rka.versi).toBe(1);
    expect(rka.baris).toHaveLength(2);
    uangValid(rka.totalAnggaran, "totalAnggaran");
    expect(rka.totalAnggaran).toBe(jumlahUang(rp(8_000_000), rp(5_000_000)));

    // Stored where the report will look for it, with the dimension the trigger
    // demands and NOTHING in the other two columns: a row carrying both a
    // sektor and an akun would be counted twice by two different reports.
    const db = await d.bacaBarisRkaDb(rka.id);
    expect(db).toHaveLength(2);
    for (const b of db) {
      expect(b.sektor_id).not.toBeNull();
      expect(b.akun_id).toBeNull();
      expect(b.bidang_id).toBeNull();
      uangValid(b.jumlah_anggaran, "jumlah_anggaran");
    }
    expect(db.map((b) => b.jumlah_unit).sort()).toEqual([2, 3]);
  });

  test("jumlah mitra target adalah angka tersendiri, bukan uang, dan boleh nol", async () => {
    // Spec 9.3 names it as a separate quantity. A month with a rupiah target
    // and no partner target (a top-up to existing partners) is legitimate, so
    // zero must be storable and distinguishable from "not stated".
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Tambahan modal mitra lama",
            bulan: 4,
            jumlahAnggaran: rp(2_000_000),
            jumlahUnit: 0,
          },
          {
            sektorId: d.sektor.b.id,
            uraian: "Belum ditetapkan targetnya",
            bulan: 4,
            jumlahAnggaran: rp(1_000_000),
            jumlahUnit: null,
          },
        ],
      },
      d.ctx.adminPusat,
    );
    const unit = rka.baris.map((b) => b.jumlahUnit).sort((a, b) => (a ?? -1) - (b ?? -1));
    expect(unit).toEqual([null, 0]);
  });

  test("baris RKA PUMK tanpa sektor ditolak oleh mesin, bukan oleh trigger database", async () => {
    kodeAda(KODE_RKA.DIMENSI_TIDAK_SESUAI_JENIS);
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "PUMK",
            baris: [{ uraian: "Tanpa sektor", bulan: 1, jumlahAnggaran: rp(1_000_000) }],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.DIMENSI_TIDAK_SESUAI_JENIS,
    );
    // Nothing partially written: the header must not survive a rejected grid.
    expect(await d.daftarRkaDb({ tahun: TAHUN_RKA, jenis: "PUMK" })).toHaveLength(0);
  });

  test("baris RKA PUMK yang memakai akun beban ditolak, karena akan hilang dari kedua laporan", async () => {
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "PUMK",
            baris: [
              {
                akunId: d.akun.bebanOperasional.id,
                uraian: "Sektor diisi sebagai akun",
                bulan: 1,
                jumlahAnggaran: rp(1_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.DIMENSI_TIDAK_SESUAI_JENIS,
    );
  });
});

describe("spec 9.3: RKA Non PUMK, anggaran per bidang per bulan", () => {
  test("menyimpan satu baris per bidang per bulan", async () => {
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Anggaran Pendidikan",
            bulan: 2,
            jumlahAnggaran: rp(6_500_000),
          },
          {
            bidangId: d.bidang.b.id,
            uraian: "Anggaran Kesehatan",
            bulan: 2,
            jumlahAnggaran: rp(3_500_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    expect(rka.jenis).toBe("NON_PUMK");
    for (const b of await d.bacaBarisRkaDb(rka.id)) {
      expect(b.bidang_id).not.toBeNull();
      expect(b.sektor_id).toBeNull();
      expect(b.akun_id).toBeNull();
    }
  });

  test("baris RKA Non PUMK tanpa bidang ditolak", async () => {
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: [
              {
                sektorId: d.sektor.a.id,
                uraian: "Sektor di RKA Non PUMK",
                bulan: 1,
                jumlahAnggaran: rp(1_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.DIMENSI_TIDAK_SESUAI_JENIS,
    );
  });
});

describe("spec 9.3: RKA Keuangan, anggaran per akun beban DAN target pendapatan", () => {
  test("beban dan pendapatan hidup di satu RKA Keuangan, dua akun dengan saldo normal berbeda", async () => {
    // The sentence in spec 9.3 covers both sides in one budget type, so this
    // is one RKA with two kinds of line rather than two budgets. It matters
    // for report 24: an expense line and a revenue line must both read as a
    // POSITIVE achievement against a POSITIVE target, even though the ledger
    // moves them in opposite directions.
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "KEUANGAN",
        baris: [
          {
            akunId: d.akun.bebanOperasional.id,
            uraian: "Beban operasional Februari",
            bulan: 2,
            jumlahAnggaran: rp(4_000_000),
          },
          {
            akunId: d.akun.pendapatanJasaGiro.id,
            uraian: "Target pendapatan jasa giro Februari",
            bulan: 2,
            jumlahAnggaran: rp(1_500_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );

    expect(d.akun.bebanOperasional.saldoNormal).toBe("D");
    expect(d.akun.pendapatanJasaGiro.saldoNormal).toBe("K");
    expect(rka.baris).toHaveLength(2);
    for (const b of await d.bacaBarisRkaDb(rka.id)) {
      expect(b.akun_id).not.toBeNull();
      expect(b.sektor_id).toBeNull();
      expect(b.bidang_id).toBeNull();
    }
  });

  test("akun yang bukan beban dan bukan pendapatan ditolak", async () => {
    // Spec 9.3 says "akun beban dan target pendapatan", and there is a reason
    // beyond obedience: report 24 compares a budget against a PERIOD MOVEMENT.
    // A balance-sheet account's movement is not an achievement against a
    // target, so budgeting cash or receivables produces a percentage that
    // reads as performance and means nothing.
    kodeAda(KODE_RKA.AKUN_TIDAK_DAPAT_DIANGGARKAN);
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "KEUANGAN",
            baris: [
              {
                akunId: d.akun.kas.id,
                uraian: "Anggaran kas",
                bulan: 1,
                jumlahAnggaran: rp(1_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.AKUN_TIDAK_DAPAT_DIANGGARKAN,
    );
  });

  test("baris RKA Keuangan tanpa akun ditolak", async () => {
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "KEUANGAN",
            baris: [
              {
                bidangId: d.bidang.a.id,
                uraian: "Bidang di RKA Keuangan",
                bulan: 1,
                jumlahAnggaran: rp(1_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.DIMENSI_TIDAK_SESUAI_JENIS,
    );
  });
});

describe("aturan baris yang berlaku untuk ketiga jenis", () => {
  test("bulan boleh 1 sampai 12 atau kosong untuk angka tahunan", async () => {
    // migrations/0012 allows NULL and documents it as "an annual figure with
    // no monthly breakdown". Report 24 has a monthly form, so an annual line
    // has to be handled somewhere; the contract records that it is spread or
    // reported apart, and this test only pins that it can be STORED, which is
    // the prerequisite for either.
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: [
          {
            bidangId: d.bidang.a.id,
            uraian: "Anggaran tahunan Pendidikan",
            bulan: null,
            jumlahAnggaran: rp(12_000_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    expect(rka.baris[0].bulan).toBeNull();
    expect((await d.bacaBarisRkaDb(rka.id))[0].bulan).toBeNull();
  });

  test("bulan 0 dan bulan 13 ditolak", async () => {
    kodeAda(KODE_RKA.BULAN_TIDAK_VALID);
    for (const bulan of [0, 13, -1]) {
      await tolakDengan(
        () =>
          d.engine.buatRka(
            {
              cabangId: d.cabangId,
              tahun: TAHUN_RKA,
              jenis: "NON_PUMK",
              baris: [
                {
                  bidangId: d.bidang.a.id,
                  uraian: `Bulan ${bulan}`,
                  bulan,
                  jumlahAnggaran: rp(1_000_000),
                },
              ],
            },
            d.ctx.adminPusat,
          ),
        KODE_RKA.BULAN_TIDAK_VALID,
      );
    }
  });

  test("dua baris untuk dimensi dan bulan yang sama ditolak, karena laporan akan menjumlah keduanya diam diam", async () => {
    kodeAda(KODE_RKA.BARIS_DUPLIKAT);
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: [
              {
                bidangId: d.bidang.a.id,
                uraian: "Pendidikan Februari",
                bulan: 2,
                jumlahAnggaran: rp(3_000_000),
              },
              {
                bidangId: d.bidang.a.id,
                uraian: "Pendidikan Februari (salah ketik kedua)",
                bulan: 2,
                jumlahAnggaran: rp(3_000_000),
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.BARIS_DUPLIKAT,
    );
  });

  test("anggaran negatif ditolak, dan nilai yang bukan desimal dua angka ditolak", async () => {
    kodeAda(KODE_RKA.NILAI_NEGATIF);
    kodeAda(KODE_RKA.NILAI_BUKAN_DESIMAL);
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: [
              {
                bidangId: d.bidang.a.id,
                uraian: "Negatif",
                bulan: 1,
                jumlahAnggaran: "-1000000.00",
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.NILAI_NEGATIF,
    );
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: [
              {
                bidangId: d.bidang.a.id,
                uraian: "Bukan dua desimal",
                bulan: 1,
                // Invariant 7: a float would have arrived here as 1000000 or
                // 1e6 and been stored as a plausible wrong number.
                jumlahAnggaran: "1000000",
              },
            ],
          },
          d.ctx.adminPusat,
        ),
      KODE_RKA.NILAI_BUKAN_DESIMAL,
    );
  });

  test("dimensi milik BUMN lain ditolak, bukan disimpan sebagai FK yang tidak pernah muncul di laporan", async () => {
    const lain = await buatDunia();
    try {
      kodeAda(KODE_RKA.SEKTOR_TIDAK_DITEMUKAN);
      await tolakDengan(
        () =>
          d.engine.buatRka(
            {
              cabangId: d.cabangId,
              tahun: TAHUN_RKA,
              jenis: "PUMK",
              baris: [
                {
                  sektorId: lain.sektor.a.id,
                  uraian: "Sektor milik BUMN lain",
                  bulan: 1,
                  jumlahAnggaran: rp(1_000_000),
                },
              ],
            },
            d.ctx.adminPusat,
          ),
        KODE_RKA.SEKTOR_TIDAK_DITEMUKAN,
      );
    } finally {
      await lain.tutup();
    }
  });

  test("DIMENSI_UNTUK_JENIS adalah satu satunya tempat pemetaan itu dinyatakan", () => {
    // A guard on the contract rather than on the engine. Report 24 groups by
    // this map and the entry screens validate against it; a second copy
    // somewhere else is how a budget type quietly starts accepting two
    // dimensions.
    expect(DIMENSI_UNTUK_JENIS.PUMK).toBe("SEKTOR");
    expect(DIMENSI_UNTUK_JENIS.NON_PUMK).toBe("BIDANG");
    expect(DIMENSI_UNTUK_JENIS.KEUANGAN).toBe("AKUN");
  });
});

describe("satu RKA per (cabang, tahun, jenis) per versi", () => {
  test("tiga jenis untuk tahun dan cabang yang sama hidup berdampingan", async () => {
    // `rka_versi_uq` includes `jenis`, so the three budget types are three
    // independent documents. A test is worth having because the natural
    // reading of "the 2026 RKA" is one document.
    for (const [jenis, baris] of [
      ["PUMK", { sektorId: d.sektor.a.id }],
      ["NON_PUMK", { bidangId: d.bidang.a.id }],
      ["KEUANGAN", { akunId: d.akun.bebanOperasional.id }],
    ] as const) {
      await d.engine.buatRka(
        {
          cabangId: d.cabangId,
          tahun: TAHUN_RKA,
          jenis,
          baris: [{ ...baris, uraian: `Baris ${jenis}`, bulan: 1, jumlahAnggaran: rp(1_000_000) }],
        },
        d.ctx.adminPusat,
      );
    }
    const semua = await d.daftarRkaDb({ tahun: TAHUN_RKA });
    expect(semua.map((r) => r.jenis).sort()).toEqual(["KEUANGAN", "NON_PUMK", "PUMK"]);
    expect(semua.every((r) => r.versi === 1 && r.status === "DRAFT")).toBe(true);
  });

  test("RKA konsolidasi (cabang null) berbeda dokumen dari RKA cabang", async () => {
    // migrations/0012's own comment: a NULL cabang_id is "a consolidated
    // (entity-wide) budget rather than a branch budget", and `rka_versi_uq` is
    // NULLS NOT DISTINCT so there can be exactly one of each per year and
    // type. Without this, a consolidated budget and a branch budget would
    // silently be the same row.
    await d.engine.buatRka(
      {
        cabangId: null,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Konsolidasi",
            bulan: 1,
            jumlahAnggaran: PENCAIRAN_SEKTOR_A,
          },
        ],
      },
      d.ctx.adminPusat,
    );
    await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Cabang pusat",
            bulan: 1,
            jumlahAnggaran: rp(2_000_000),
          },
        ],
      },
      d.ctx.adminPusat,
    );
    const semua = await d.daftarRkaDb({ tahun: TAHUN_RKA, jenis: "PUMK" });
    expect(semua).toHaveLength(2);
    expect(semua.filter((r) => r.cabang_id === null)).toHaveLength(1);
  });
});
