// Spec 6.3 "Aturan posting dan reversal". The menu the deck calls
// "Hapus Jurnal Transaksi" is implemented as: soft delete if DRAFT, reversing
// journal if POSTED.
//
// The last describe block is THE INTEGRATION POINT with the business modules
// (PUMK pencairan/angsuran, Non PUMK penyaluran), which do not exist yet. Spec
// 6.3 is blunt about why it matters: "Jangan pernah reversal jurnal tanpa
// membalik state bisnis, itu sumber data korup nomor satu." So the contract
// takes a `PembalikStateBisnis` registry keyed by `referensi_tipe`, and these
// tests drive it with a fake handler. When the PUMK module lands it registers
// a real handler and these tests keep guarding the same rule.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJurnalEngine,
  KODE_JURNAL,
  type BuatJurnalInput,
  type JurnalEngine,
  type JurnalTx,
  type PembalikStateBisnis,
} from "./contract";
import {
  bacaBarisDb,
  bacaJurnalDb,
  buatDunia,
  rp,
  tolakDengan,
  type DuniaJurnal,
} from "./test-support";

const REF_TIPE = "pumk_pencairan";

let d: DuniaJurnal;
let engine: JurnalEngine;

beforeAll(async () => {
  d = await buatDunia();
  engine = createJurnalEngine({ db: d.db, jam: d.jam });
});

afterAll(async () => {
  if (d) await d.tutup();
});

function jurnalKas(nilai = rp(2_000_000), ubah: Partial<BuatJurnalInput> = {}): BuatJurnalInput {
  return {
    cabangId: d.cabangId,
    jenis: "UMUM",
    tanggalTransaksi: d.tanggalKini,
    keterangan: "jurnal untuk diuji reversal",
    baris: [
      { akunId: d.akun.kas.id, debit: nilai },
      { akunId: d.akun.pendapatanAlokasi.id, kredit: nilai },
    ],
    ...ubah,
  };
}

async function postingBaru(input: BuatJurnalInput) {
  const draft = await engine.buatJurnal(input, d.ctx.approver);
  return engine.postingJurnal(draft.id, d.ctx.approver);
}

describe("spec 6.3 reversal jurnal POSTED", () => {
  test("spec 6.3 reversal mendarat di periode OPEN terkini, bukan di tanggal periode aslinya", async () => {
    // Original is posted in 2026-01 while it is still OPEN, then 2026-01 is
    // closed. A reversal dated back into January would be rejected by the DB
    // (invariant 5), which is exactly why the spec moves the date.
    const asli = await postingBaru(jurnalKas(rp(1_750_000), { tanggalTransaksi: d.tanggalAwal }));
    expect(asli.tanggalTransaksi).toBe(d.tanggalAwal);
    expect(asli.periodeId).toBe(d.periodeAwal.id);
    await d.tutupPeriode(d.periodeAwal);

    const rev = await engine.reversalJurnal(asli.id, "salah periode, dikoreksi", d.ctx.approver);

    expect(rev.periodeId).toBe(d.periodeKini.id);
    expect(rev.tanggalTransaksi).not.toBe(asli.tanggalTransaksi);
    // The injected clock sits inside the current OPEN period, so the contract
    // pins the date exactly rather than leaving it to "today".
    expect(rev.tanggalTransaksi).toBe(d.tanggalKini);
    expect(rev.tanggalTransaksi >= d.periodeKini.tanggalMulai).toBe(true);
    expect(rev.tanggalTransaksi <= d.periodeKini.tanggalAkhir).toBe(true);
  });

  test("spec 6.3 reversal menukar debit dan kredit dan mempertahankan dimensi sub ledger", async () => {
    const nilai = rp(4_000_000);
    const asli = await postingBaru({
      cabangId: d.cabangId,
      jenis: "UMUM",
      tanggalTransaksi: d.tanggalKini,
      keterangan: "pencairan manual dengan dimensi piutang",
      baris: [
        { akunId: d.akun.piutangPokok.id, debit: nilai, mitraId: d.mitraId, akadId: d.akadId },
        { akunId: d.akun.kas.id, kredit: nilai },
      ],
    });

    const rev = await engine.reversalJurnal(asli.id, "pencairan dibatalkan", d.ctx.approver);
    const barisRev = await bacaBarisDb(d.db, rev.id);

    const piutang = barisRev.find((b) => b.akun_id === d.akun.piutangPokok.id);
    expect(piutang?.kredit).toBe(nilai);
    expect(piutang?.debit).toBe(rp(0));
    // Without these the piutang sub-ledger reconciliation (spec 8.4 check 10)
    // would drift by the reversed amount for this akad.
    expect(piutang?.mitra_id).toBe(d.mitraId);
    expect(piutang?.akad_id).toBe(d.akadId);

    const kas = barisRev.find((b) => b.akun_id === d.akun.kas.id);
    expect(kas?.debit).toBe(nilai);
    expect(kas?.kredit).toBe(rp(0));
  });

  test("spec 6.3 keterangan reversal merujuk nomor jurnal asli", async () => {
    const asli = await postingBaru(jurnalKas(rp(900_000)));
    const rev = await engine.reversalJurnal(asli.id, "duplikat input", d.ctx.approver);

    expect(rev.keterangan ?? "").toContain(asli.noJurnal);
    // The reason is part of the audit trail, not just a gate.
    expect(rev.keterangan ?? "").toContain("duplikat input");
  });

  test("spec 6.3 jurnal asli ditandai REVERSED dan kedua jurnal saling menunjuk", async () => {
    const asli = await postingBaru(jurnalKas(rp(1_100_000)));
    const rev = await engine.reversalJurnal(asli.id, "koreksi klasifikasi akun", d.ctx.approver);

    const dbAsli = await bacaJurnalDb(d.db, asli.id);
    const dbRev = await bacaJurnalDb(d.db, rev.id);

    expect(dbAsli?.status).toBe("REVERSED");
    expect(dbAsli?.reversed_by_jurnal_id).toBe(rev.id);
    expect(dbRev?.reversal_of_jurnal_id).toBe(asli.id);
    expect(dbRev?.jenis).toBe("REVERSAL");
    expect(dbRev?.status).toBe("POSTED");
    // A REVERSED original is still in the ledger. It is never soft-deleted:
    // that would silently drop it from every report.
    expect(dbAsli?.deleted_at).toBeNull();
  });

  test("spec 6.3 reversal wajib menyertakan alasan", async () => {
    const asli = await postingBaru(jurnalKas(rp(650_000)));
    for (const alasan of ["", "   ", "\t\n"]) {
      await tolakDengan(engine.reversalJurnal(asli.id, alasan, d.ctx.approver), KODE_JURNAL.ALASAN_WAJIB);
    }
    expect((await bacaJurnalDb(d.db, asli.id))?.status).toBe("POSTED");
  });

  test("spec 6.3 reversal butuh permission jurnal.post", async () => {
    const asli = await postingBaru(jurnalKas(rp(550_000)));
    await tolakDengan(
      engine.reversalJurnal(asli.id, "coba tanpa wewenang", d.ctx.maker),
      KODE_JURNAL.TIDAK_BERWENANG,
    );
    expect((await bacaJurnalDb(d.db, asli.id))?.status).toBe("POSTED");
  });

  test("spec 6.3 jurnal DRAFT dihapus lewat soft delete, bukan lewat reversal", async () => {
    const draft = await engine.buatJurnal(jurnalKas(rp(480_000)), d.ctx.approver);

    // Reversal is only for POSTED journals.
    await tolakDengan(
      engine.reversalJurnal(draft.id, "salah input", d.ctx.approver),
      KODE_JURNAL.JURNAL_BELUM_POSTED,
    );

    await engine.batalkanJurnalDraft(draft.id, d.ctx.approver);
    const db = await bacaJurnalDb(d.db, draft.id);
    expect(db?.deleted_at).not.toBeNull();
    expect(db?.status).toBe("DRAFT");
  });

  test("spec 6.3 jurnal POSTED tidak bisa di-soft-delete, hanya bisa di-reversal", async () => {
    const asli = await postingBaru(jurnalKas(rp(770_000)));
    await tolakDengan(
      engine.batalkanJurnalDraft(asli.id, d.ctx.approver),
      KODE_JURNAL.JURNAL_TIDAK_DRAFT,
    );
    const db = await bacaJurnalDb(d.db, asli.id);
    expect(db?.deleted_at).toBeNull();
    expect(db?.status).toBe("POSTED");
  });
});

describe("spec 6.3 INTEGRATION POINT: reversal harus membalik state bisnis di transaksi yang sama", () => {
  /**
   * Stand-in for the PUMK module's real handler. It records the transaction id
   * it was handed and writes a business-state change through THAT handle, so
   * the test can prove the accounting reversal and the business reversal share
   * one transaction rather than merely happening close together.
   */
  function pembalikPalsu(): PembalikStateBisnis & { dipanggil: number; txid?: string } {
    const p = {
      referensiTipe: REF_TIPE,
      dipanggil: 0,
      txid: undefined as string | undefined,
      async balikkan(_input: { jurnalAsli: unknown; alasan: string }, tx: JurnalTx) {
        p.dipanggil += 1;
        const t = await tx.query<{ txid: string }>(`select txid_current()::text as txid`);
        p.txid = t[0].txid;
        await tx.query(`update pumk_akad set outstanding_pokok = 0 where id = $1`, [d.akadId]);
      },
    };
    return p as PembalikStateBisnis & { dipanggil: number; txid?: string };
  }

  async function outstandingAkad(): Promise<string> {
    const r = await d.db.query<{ o: string }>(
      `select outstanding_pokok::text as o from pumk_akad where id = $1`,
      [d.akadId],
    );
    return r[0].o;
  }

  function jurnalPeristiwaBisnis(nilai: string): BuatJurnalInput {
    return {
      cabangId: d.cabangId,
      jenis: "UMUM",
      tanggalTransaksi: d.tanggalKini,
      keterangan: "pencairan PUMK (stand-in peristiwa bisnis)",
      // referensi_tipe/referensi_id is deliberately NOT a foreign key
      // (migrations/0010): it spans a dozen business tables. Here it points at
      // the akad so the fake handler has something real to revert.
      referensiTipe: REF_TIPE,
      referensiId: d.akadId,
      baris: [
        { akunId: d.akun.piutangPokok.id, debit: nilai, mitraId: d.mitraId, akadId: d.akadId },
        { akunId: d.akun.kas.id, kredit: nilai },
      ],
    };
  }

  test("spec 6.3 reversal jurnal peristiwa bisnis membalik state bisnis dalam SATU transaksi database", async () => {
    const pembalik = pembalikPalsu();
    const mesin = createJurnalEngine({
      db: d.db,
      jam: d.jam,
      pembalikStateBisnis: [pembalik],
    });

    await d.db.query(`update pumk_akad set outstanding_pokok = 10000000.00, status = 'AKTIF' where id = $1`, [
      d.akadId,
    ]);

    const draft = await mesin.buatJurnal(jurnalPeristiwaBisnis(rp(10_000_000)), d.ctx.approver);
    const asli = await mesin.postingJurnal(draft.id, d.ctx.approver);
    const rev = await mesin.reversalJurnal(asli.id, "pencairan salah mitra", d.ctx.approver);

    expect(pembalik.dipanggil).toBe(1);
    expect(await outstandingAkad()).toBe(rp(0));

    // The reversing journal row was INSERTed by the same transaction the
    // handler ran in: its xmin is that transaction's id. This is the assertion
    // the spec's "dalam satu transaksi database yang sama" reduces to.
    const x = await d.db.query<{ xmin: string }>(`select xmin::text as xmin from jurnal where id = $1`, [
      rev.id,
    ]);
    const txidHandler = BigInt(pembalik.txid ?? "0") & 0xffffffffn;
    expect(x[0].xmin).toBe(txidHandler.toString());
  });

  test("spec 6.3 kalau pembalikan state bisnis gagal, reversal jurnal ikut batal (tidak ada setengah reversal)", async () => {
    const pembalikGagal: PembalikStateBisnis = {
      referensiTipe: REF_TIPE,
      async balikkan(_input, tx) {
        await tx.query(`update pumk_akad set outstanding_pokok = 0 where id = $1`, [d.akadId]);
        throw new Error("modul bisnis menolak pembalikan");
      },
    };
    const mesin = createJurnalEngine({ db: d.db, jam: d.jam, pembalikStateBisnis: [pembalikGagal] });

    await d.db.query(`update pumk_akad set outstanding_pokok = 7000000.00, status = 'AKTIF' where id = $1`, [
      d.akadId,
    ]);

    const draft = await mesin.buatJurnal(jurnalPeristiwaBisnis(rp(7_000_000)), d.ctx.approver);
    const asli = await mesin.postingJurnal(draft.id, d.ctx.approver);

    // Asserted on the MESSAGE, not on "something threw": a bare catch also
    // passes when the fixture itself breaks, which would turn this test into a
    // green light for a rollback that never happened. The handler's own message
    // proves the failure came from the business module, and that the engine
    // let it through unchanged instead of dressing it up as a domain code.
    let ditangkap: unknown;
    try {
      await mesin.reversalJurnal(asli.id, "coba reversal", d.ctx.approver);
    } catch (e) {
      ditangkap = e;
    }
    expect(ditangkap).toBeInstanceOf(Error);
    expect((ditangkap as Error).message).toContain("modul bisnis menolak pembalikan");

    // Nothing moved: no reversing journal, original still POSTED, business
    // state exactly as before.
    const jml = await d.db.query<{ n: number }>(
      `select count(*)::int as n from jurnal where reversal_of_jurnal_id = $1`,
      [asli.id],
    );
    expect(jml[0].n).toBe(0);
    const db = await bacaJurnalDb(d.db, asli.id);
    expect(db?.status).toBe("POSTED");
    expect(db?.reversed_by_jurnal_id).toBeNull();
    expect(await outstandingAkad()).toBe(rp(7_000_000));
  });

  test("spec 6.3 reversal ditolak kalau jurnal punya referensi bisnis tapi tidak ada pembalik terdaftar", async () => {
    // The safe failure. Reversing the accounting alone would leave the akad
    // outstanding without the journal that created it: corrupt by design.
    const mesin = createJurnalEngine({ db: d.db, jam: d.jam, pembalikStateBisnis: [] });

    const draft = await mesin.buatJurnal(jurnalPeristiwaBisnis(rp(3_000_000)), d.ctx.approver);
    const asli = await mesin.postingJurnal(draft.id, d.ctx.approver);

    await tolakDengan(
      mesin.reversalJurnal(asli.id, "tanpa pembalik", d.ctx.approver),
      KODE_JURNAL.PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR,
    );
    expect((await bacaJurnalDb(d.db, asli.id))?.status).toBe("POSTED");
  });

  test("spec 6.3 jurnal manual tanpa referensi bisnis tidak butuh pembalik state bisnis", async () => {
    const mesin = createJurnalEngine({ db: d.db, jam: d.jam, pembalikStateBisnis: [] });
    const asli = await postingBaru(jurnalKas(rp(120_000)));
    const rev = await mesin.reversalJurnal(asli.id, "koreksi jurnal umum", d.ctx.approver);
    expect(rev.jenis).toBe("REVERSAL");
    expect(rev.totalDebit).toBe(asli.totalDebit);
  });
});
