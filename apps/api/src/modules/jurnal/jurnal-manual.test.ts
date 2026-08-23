// Spec 6.5 "Jenis Jurnal Manual di UI". Three journal types that differ only
// in UX and default accounts: "Bedakan hanya di UX dan default akun,
// engine-nya sama."
//
// That last clause is the load-bearing one, so it gets its own describe block
// at the bottom: the shared validations of spec 6.2 must behave IDENTICALLY
// for all three, with the same error codes. Three code paths that happen to
// agree today would drift apart on the first bug fix, and the ledger is the
// one place in this system where drift is unrecoverable.
//
// WHERE POLICY IS READ, NOT ASSERTED. Two values here are configuration, not
// law, and the tests assert the MECHANIC instead of the value:
//   - the Pinbuk preset account is the debit leg of PENYALURAN_PINBUK in
//     `event_jurnal_mapping`, so an accountant can repoint it (ADR 0004);
//   - the allowed activity categories come from the `konfigurasi` row named by
//     KUNCI_KONFIGURASI.KATEGORI_PINBUK. Spec 5's preamble marks every default
//     in it as awaiting client confirmation, and docs/BUILD-PLAN.md's
//     regulation review is a standing reminder that a spec default is not a
//     rule. So the test edits the row and asserts the engine follows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJurnalEngine,
  KODE_JURNAL,
  POLA_NO_JURNAL,
  type BuatJurnalInput,
  type JenisJurnal,
  type JurnalEngine,
} from "./contract";
import {
  bacaBarisDb,
  buatDunia,
  KATEGORI_PINBUK_AWAL,
  rp,
  tolakDengan,
  type DuniaJurnal,
} from "./test-support";

let d: DuniaJurnal;
let engine: JurnalEngine;

beforeAll(async () => {
  d = await buatDunia();
  engine = createJurnalEngine({ db: d.db, jam: d.jam });
});

afterAll(async () => {
  if (d) await d.tutup();
});

function input(jenis: JenisJurnal, baris: BuatJurnalInput["baris"], keterangan: string): BuatJurnalInput {
  return {
    cabangId: d.cabangId,
    jenis,
    tanggalTransaksi: d.tanggalKini,
    keterangan,
    baris,
  };
}

/** Reads the Pinbuk preset account from the mapping table, never from a literal. */
async function akunPresetPinbuk(): Promise<string> {
  const r = await d.db.query<{ akun_debit_id: string }>(
    `select akun_debit_id from event_jurnal_mapping
      where bumn_id = $1 and event_code = 'PENYALURAN_PINBUK' and aktif and deleted_at is null`,
    [d.bumnId],
  );
  return r[0].akun_debit_id;
}

describe("spec 6.5 Jurnal Kas Bank", () => {
  test("spec 6.5 KAS_BANK wajib punya satu sisi berupa akun is_kas = true", async () => {
    // Two non-cash accounts: balanced, valid as a Jurnal Umum, but not a cash
    // receipt or disbursement, so it must not pass as KAS_BANK.
    await tolakDengan(
      engine.buatJurnal(
        input(
          "KAS_BANK",
          [
            { akunId: d.akun.bebanOperasional.id, debit: rp(1_000_000) },
            { akunId: d.akun.kelebihanAngsuran.id, kredit: rp(1_000_000) },
          ],
          "tanpa akun kas sama sekali",
        ),
        d.ctx.maker,
      ),
      KODE_JURNAL.KAS_BANK_TANPA_AKUN_KAS,
    );
  });

  test("spec 6.5 KAS_BANK diterima untuk penerimaan kas (kas di sisi debit)", async () => {
    const j = await engine.buatJurnal(
      input(
        "KAS_BANK",
        [
          { akunId: d.akun.kas.id, debit: rp(2_000_000), keterangan: "terima setoran" },
          { akunId: d.akun.pendapatanJasaGiro.id, kredit: rp(2_000_000) },
        ],
        "penerimaan kas",
      ),
      d.ctx.maker,
    );
    expect(j.jenis).toBe("KAS_BANK");
    expect(j.status).toBe("DRAFT");
    const baris = await bacaBarisDb(d.db, j.id);
    expect(baris.find((b) => b.akun_id === d.akun.kas.id)?.debit).toBe(rp(2_000_000));
  });

  test("spec 6.5 KAS_BANK diterima untuk pengeluaran kas (kas di sisi kredit), termasuk akun kas kedua", async () => {
    const j = await engine.buatJurnal(
      input(
        "KAS_BANK",
        [
          { akunId: d.akun.bebanOperasional.id, debit: rp(450_000) },
          { akunId: d.akun.kasKedua.id, kredit: rp(450_000), keterangan: "bayar via bank operasional" },
        ],
        "pengeluaran kas",
      ),
      d.ctx.maker,
    );
    expect(j.status).toBe("DRAFT");
    // The rule is "an is_kas account on one side", not "the account named Kas",
    // so any account flagged is_kas satisfies it.
    const baris = await bacaBarisDb(d.db, j.id);
    expect(baris.find((b) => b.akun_id === d.akun.kasKedua.id)?.kredit).toBe(rp(450_000));
  });
});

describe("spec 6.5 Jurnal Umum", () => {
  test("spec 6.5 UMUM bebas multi baris tanpa akun kas, untuk koreksi dan reklasifikasi", async () => {
    // Four lines, no cash account anywhere: a reclassification between two
    // expense accounts and two liability accounts.
    const j = await engine.buatJurnal(
      input(
        "UMUM",
        [
          { akunId: d.akun.bebanPinbuk.id, debit: rp(1_500_000), keterangan: "reklas ke pinbuk" },
          { akunId: d.akun.bebanNonPumk.id, debit: rp(500_000) },
          { akunId: d.akun.bebanOperasional.id, kredit: rp(1_800_000), keterangan: "dari beban operasional" },
          { akunId: d.akun.kelebihanAngsuran.id, kredit: rp(200_000) },
        ],
        "reklasifikasi beban",
      ),
      d.ctx.maker,
    );
    expect(j.jenis).toBe("UMUM");
    expect(j.baris).toHaveLength(4);
    expect(j.totalDebit).toBe(rp(2_000_000));
    expect(j.totalKredit).toBe(rp(2_000_000));
  });

  test("spec 6.5 UMUM tidak menuntut akun kas, jadi larangan KAS_BANK tidak boleh bocor ke sini", async () => {
    const j = await engine.buatJurnal(
      input(
        "UMUM",
        [
          { akunId: d.akun.bebanOperasional.id, debit: rp(100_000) },
          { akunId: d.akun.kelebihanAngsuran.id, kredit: rp(100_000) },
        ],
        "dua akun non kas",
      ),
      d.ctx.maker,
    );
    expect(j.status).toBe("DRAFT");
  });
});

describe("spec 6.5 Jurnal Pinbuk", () => {
  /** A valid Pinbuk journal, with the preset account resolved from the mapping. */
  async function pinbukSah(
    ubahDimensi: Record<string, unknown> = {},
    nilai = rp(3_000_000),
  ): Promise<BuatJurnalInput> {
    return input(
      "PINBUK",
      [
        {
          akunId: await akunPresetPinbuk(),
          debit: nilai,
          dimensi: { mitraId: d.mitraId, kategoriKegiatan: "PELATIHAN", ...ubahDimensi },
        },
        { akunId: d.akun.kas.id, kredit: nilai },
      ],
      "pinbuk pelatihan",
    );
  }

  test("spec 6.5 PINBUK memakai preset akun Beban Pembinaan Kemitraan yang dibaca dari mapping", async () => {
    const preset = await akunPresetPinbuk();
    // Sanity on the fixture, not on the engine: the preset really is the
    // Beban Pembinaan Kemitraan account.
    expect(preset).toBe(d.akun.bebanPinbuk.id);

    const j = await engine.buatJurnal(await pinbukSah(), d.ctx.maker);
    expect(j.jenis).toBe("PINBUK");
    const baris = await bacaBarisDb(d.db, j.id);
    expect(baris.find((b) => b.debit !== rp(0))?.akun_id).toBe(preset);
  });

  test("spec 6.5 PINBUK menolak jurnal yang tidak menyentuh akun preset", async () => {
    await tolakDengan(
      engine.buatJurnal(
        input(
          "PINBUK",
          [
            {
              akunId: d.akun.bebanNonPumk.id,
              debit: rp(1_000_000),
              dimensi: { mitraId: d.mitraId, kategoriKegiatan: "PELATIHAN" },
            },
            { akunId: d.akun.kas.id, kredit: rp(1_000_000) },
          ],
          "akun beban yang salah",
        ),
        d.ctx.maker,
      ),
      KODE_JURNAL.PINBUK_AKUN_SALAH,
    );
  });

  test("spec 6.5 PINBUK wajib tautkan ke Mitra Binaan atau Cluster", async () => {
    // Neither link present.
    await tolakDengan(
      engine.buatJurnal(
        await pinbukSah({ mitraId: undefined }),
        d.ctx.maker,
      ),
      KODE_JURNAL.PINBUK_TANPA_TAUTAN,
    );

    // Either one is enough: mitra...
    const denganMitra = await engine.buatJurnal(await pinbukSah(), d.ctx.maker);
    expect(denganMitra.status).toBe("DRAFT");

    // ...or cluster.
    const denganCluster = await engine.buatJurnal(
      await pinbukSah({ mitraId: undefined, clusterId: d.clusterId }),
      d.ctx.maker,
    );
    const barisCluster = await bacaBarisDb(d.db, denganCluster.id);
    // The link lives in dimensi_json, NOT in jurnal_baris.mitra_id: that
    // column is the piutang sub-ledger dimension and validation 6.2.8 requires
    // a receivable account for it. A Pinbuk expense line is not a receivable,
    // so the two rules would be mutually unsatisfiable otherwise.
    const barisPreset = barisCluster.find((b) => b.debit !== rp(0));
    expect(barisPreset?.dimensi_json.clusterId).toBe(d.clusterId);
    expect(barisPreset?.mitra_id).toBeNull();
  });

  test("spec 6.5 PINBUK wajib ada kategori kegiatan, dan daftarnya dibaca dari konfigurasi", async () => {
    // Missing entirely.
    await tolakDengan(
      engine.buatJurnal(await pinbukSah({ kategoriKegiatan: undefined }), d.ctx.maker),
      KODE_JURNAL.PINBUK_KATEGORI_TIDAK_VALID,
    );
    // Present but not in the configured list.
    await tolakDengan(
      engine.buatJurnal(await pinbukSah({ kategoriKegiatan: "STUDI_BANDING" }), d.ctx.maker),
      KODE_JURNAL.PINBUK_KATEGORI_TIDAK_VALID,
    );

    // Every category the fixture configured is accepted. The list is the
    // fixture's, read back from the config row, not a literal in the engine.
    for (const kategori of KATEGORI_PINBUK_AWAL) {
      const j = await engine.buatJurnal(await pinbukSah({ kategoriKegiatan: kategori }), d.ctx.maker);
      expect(j.status).toBe("DRAFT");
    }
  });

  test("spec 6.5 mengubah daftar kategori di konfigurasi mengubah validasi, tanpa redeploy", async () => {
    // The mechanic, not the policy: PAMERAN is valid only because a config row
    // says so today. Drop it and the same input must be rejected, in the same
    // process, with no restart.
    const sebelum = await engine.buatJurnal(
      await pinbukSah({ kategoriKegiatan: "PAMERAN" }),
      d.ctx.maker,
    );
    expect(sebelum.status).toBe("DRAFT");

    await d.setelKategoriPinbuk(KATEGORI_PINBUK_AWAL.filter((k) => k !== "PAMERAN"));
    try {
      await tolakDengan(
        engine.buatJurnal(await pinbukSah({ kategoriKegiatan: "PAMERAN" }), d.ctx.maker),
        KODE_JURNAL.PINBUK_KATEGORI_TIDAK_VALID,
      );
      // A category added at runtime is accepted just as readily.
      await d.setelKategoriPinbuk([...KATEGORI_PINBUK_AWAL, "STUDI_BANDING"]);
      const sesudah = await engine.buatJurnal(
        await pinbukSah({ kategoriKegiatan: "STUDI_BANDING" }),
        d.ctx.maker,
      );
      expect(sesudah.status).toBe("DRAFT");
    } finally {
      await d.setelKategoriPinbuk(KATEGORI_PINBUK_AWAL);
    }
  });
});

describe("spec 6.5 satu engine untuk ketiga jenis jurnal manual", () => {
  const JENIS_MANUAL: JenisJurnal[] = ["KAS_BANK", "UMUM", "PINBUK"];

  /**
   * A minimal valid journal per type, so the shared-validation tests below
   * differ ONLY in the thing being tested.
   */
  async function sahUntuk(jenis: JenisJurnal, nilai: string): Promise<BuatJurnalInput["baris"]> {
    if (jenis === "PINBUK") {
      return [
        {
          akunId: await akunPresetPinbuk(),
          debit: nilai,
          dimensi: { mitraId: d.mitraId, kategoriKegiatan: "PELATIHAN" },
        },
        { akunId: d.akun.kas.id, kredit: nilai },
      ];
    }
    return [
      { akunId: d.akun.kas.id, debit: nilai },
      { akunId: d.akun.pendapatanJasaGiro.id, kredit: nilai },
    ];
  }

  for (const jenis of JENIS_MANUAL) {
    test(`spec 6.5 ${jenis} lahir DRAFT dengan nomor jurnal berformat sama`, async () => {
      const j = await engine.buatJurnal(
        input(jenis, await sahUntuk(jenis, rp(1_000_000)), `minimal sah ${jenis}`),
        d.ctx.maker,
      );
      expect(j.status).toBe("DRAFT");
      expect(j.jenis).toBe(jenis);
      expect(j.noJurnal).toMatch(POLA_NO_JURNAL);
      // Spec 4.6: numbering is per jenis per periode, so the series carries the
      // type. This is the one place the three types are allowed to differ.
      expect(j.noJurnal.startsWith(`${jenis}/`)).toBe(true);
    });

    test(`spec 6.5 ${jenis} tunduk pada validasi balance yang sama (6.2.5)`, async () => {
      const baris = await sahUntuk(jenis, rp(1_000_000));
      baris[baris.length - 1] = { ...baris[baris.length - 1], kredit: rp(900_000) };
      await tolakDengan(
        engine.buatJurnal(input(jenis, baris, `tidak balance ${jenis}`), d.ctx.maker),
        KODE_JURNAL.TIDAK_BALANCE,
      );
    });

    test(`spec 6.5 ${jenis} tunduk pada validasi minimal dua baris yang sama (6.2.2)`, async () => {
      const baris = await sahUntuk(jenis, rp(1_000_000));
      await tolakDengan(
        engine.buatJurnal(input(jenis, [baris[0]], `satu baris ${jenis}`), d.ctx.maker),
        KODE_JURNAL.MINIMAL_DUA_BARIS,
      );
    });

    test(`spec 6.5 ${jenis} tunduk pada validasi periode OPEN yang sama (6.2.1)`, async () => {
      const baris = await sahUntuk(jenis, rp(1_000_000));
      await tolakDengan(
        engine.buatJurnal(
          { ...input(jenis, baris, `periode mati ${jenis}`), tanggalTransaksi: "2031-07-09" },
          d.ctx.maker,
        ),
        KODE_JURNAL.PERIODE_TIDAK_OPEN,
      );
    });

    test(`spec 6.5 ${jenis} tunduk pada validasi akun postable yang sama (6.2.6)`, async () => {
      const baris = await sahUntuk(jenis, rp(1_000_000));
      baris[baris.length - 1] = { akunId: d.akunHeaderId, kredit: rp(1_000_000) };
      await tolakDengan(
        engine.buatJurnal(input(jenis, baris, `akun header ${jenis}`), d.ctx.maker),
        KODE_JURNAL.AKUN_TIDAK_VALID,
      );
    });
  }
});
