// Spec 6.6 items 8 and 9: batch atomicity and concurrent posting. Split out of
// jurnal-invarian.test.ts because both need genuinely parallel calls on
// separate connections, which is also why the engine's port has
// `transaction()` at all (see the port note in ./contract.ts).
//
// These two are the tests that a "works on my machine" engine fails. Both
// invariants are unreachable with autocommit queries or with an application
// level "check then write": the first needs one transaction spanning every
// member of the batch, the second needs a row lock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJurnalEngine,
  JurnalError,
  KODE_JURNAL,
  type BuatJurnalInput,
  type JurnalEngine,
} from "./contract";
import {
  bacaJurnalDb,
  buatDunia,
  kunci,
  rp,
  selisihLedger,
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

function seimbang(nilai: string, keterangan: string): BuatJurnalInput {
  return {
    cabangId: d.cabangId,
    jenis: "UMUM",
    tanggalTransaksi: d.tanggalKini,
    keterangan,
    baris: [
      { akunId: d.akun.kas.id, debit: nilai },
      { akunId: d.akun.pendapatanAlokasi.id, kredit: nilai },
    ],
  };
}

async function jumlahPosted(): Promise<number> {
  const r = await d.db.query<{ n: number }>(
    `select count(*)::int as n from jurnal where bumn_id = $1 and status = 'POSTED'`,
    [d.bumnId],
  );
  return r[0].n;
}

/**
 * Inserts an UNBALANCED DRAFT straight through SQL.
 *
 * This is not a hack around the engine, it is the only honest way to build the
 * "one invalid member" of spec 6.6.8: the schema deliberately ALLOWS an
 * unbalanced DRAFT (a maker types one line at a time, so the balance trigger is
 * deferred and only fires when a journal is left POSTED, see
 * migrations/0010_jurnal.sql). `buatJurnal` would reject this input at the
 * door, so the only way a batch can meet an unbalanced member is for it to
 * already be sitting in the table, which is exactly the production scenario:
 * a draft edited by someone else between selection and posting.
 */
async function sisipkanDraftTidakBalance(debit: string, kredit: string): Promise<string> {
  // The document number is uniquified by `kunci()` rather than shaped like a
  // real one on purpose: this row is not something the numbering service
  // produced, and giving it a plausible sequence number could collide with one
  // the engine allocates later in the same run.
  const j = await d.db.query<{ id: string }>(
    `insert into jurnal (bumn_id, cabang_id, no_jurnal, jenis, tanggal_transaksi, periode_id, keterangan, status)
     values ($1, $2, $3, 'UMUM', $4, $5, 'draft tidak balance (disisipkan test)', 'DRAFT')
     returning id`,
    [d.bumnId, d.cabangId, kunci("RAW-DRAFT"), d.tanggalKini, d.periodeKini.id],
  );
  await d.db.query(
    `insert into jurnal_baris (jurnal_id, urutan, akun_id, debit) values ($1, 1, $2, $3)`,
    [j[0].id, d.akun.kas.id, debit],
  );
  await d.db.query(
    `insert into jurnal_baris (jurnal_id, urutan, akun_id, kredit) values ($1, 2, $2, $3)`,
    [j[0].id, d.akun.pendapatanAlokasi.id, kredit],
  );
  return j[0].id;
}

describe("spec 6.6.8 postingBatch atomik, semua atau tidak ada", () => {
  test("spec 6.6.8 batch dengan satu jurnal tidak balance membuat SELURUH batch gagal, tidak ada yang ter-posting", async () => {
    const sah1 = await engine.buatJurnal(seimbang(rp(1_000_000), "anggota batch 1"), d.ctx.approver);
    const sah2 = await engine.buatJurnal(seimbang(rp(2_000_000), "anggota batch 2"), d.ctx.approver);
    const rusak = await sisipkanDraftTidakBalance(rp(3_000_000), rp(2_999_999));

    const postedSebelum = await jumlahPosted();
    const selisihSebelum = await selisihLedger(d.db);

    const err = await tolakDengan(
      engine.postingBatch([sah1.id, rusak, sah2.id], d.ctx.approver),
      KODE_JURNAL.BATCH_GAGAL,
    );
    // The batch error must name the member that failed and why, otherwise the
    // UI can only say "something in your selection is wrong".
    expect(err.detail.jurnalIdGagal).toBe(rusak);
    expect(err.detail.kodePenyebab).toBe(KODE_JURNAL.TIDAK_BALANCE);

    // Nothing moved. Note the two valid members were listed BEFORE and AFTER
    // the broken one, so an engine that posts as it goes fails here whichever
    // order it iterates in.
    expect((await bacaJurnalDb(d.db, sah1.id))?.status).toBe("DRAFT");
    expect((await bacaJurnalDb(d.db, sah2.id))?.status).toBe("DRAFT");
    expect((await bacaJurnalDb(d.db, rusak))?.status).toBe("DRAFT");
    expect(await jumlahPosted()).toBe(postedSebelum);
    expect(await selisihLedger(d.db)).toBe(selisihSebelum);
  });

  test("spec 6.6.8 batch dengan satu anggota yang sudah POSTED juga gagal seluruhnya", async () => {
    const sah = await engine.buatJurnal(seimbang(rp(400_000), "anggota batch sah"), d.ctx.approver);
    const sudah = await engine.buatJurnal(seimbang(rp(500_000), "anggota sudah posted"), d.ctx.approver);
    await engine.postingJurnal(sudah.id, d.ctx.approver);

    const err = await tolakDengan(
      engine.postingBatch([sah.id, sudah.id], d.ctx.approver),
      KODE_JURNAL.BATCH_GAGAL,
    );
    expect(err.detail.jurnalIdGagal).toBe(sudah.id);
    expect(err.detail.kodePenyebab).toBe(KODE_JURNAL.JURNAL_TIDAK_DRAFT);

    expect((await bacaJurnalDb(d.db, sah.id))?.status).toBe("DRAFT");
  });

  test("spec 6.6.8 kontrol: batch yang seluruhnya sah mem-posting semuanya", async () => {
    // Without this control the two tests above could pass on an engine whose
    // postingBatch always throws.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const j = await engine.buatJurnal(seimbang(rp(100_000 + i), `batch sah ${i}`), d.ctx.approver);
      ids.push(j.id);
    }

    const hasil = await engine.postingBatch(ids, d.ctx.approver);
    expect(hasil).toHaveLength(3);
    for (const j of hasil) {
      expect(j.status).toBe("POSTED");
      expect(j.postedBy).toBe(d.ctx.approver.userId);
    }
    for (const id of ids) {
      expect((await bacaJurnalDb(d.db, id))?.status).toBe("POSTED");
    }
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("spec 6.6.8 batch juga butuh permission jurnal.post, dan menolak tanpa mem-posting apa pun", async () => {
    const a = await engine.buatJurnal(seimbang(rp(210_000), "batch tanpa wewenang a"), d.ctx.maker);
    const b = await engine.buatJurnal(seimbang(rp(220_000), "batch tanpa wewenang b"), d.ctx.maker);

    await tolakDengan(engine.postingBatch([a.id, b.id], d.ctx.maker), KODE_JURNAL.TIDAK_BERWENANG);

    expect((await bacaJurnalDb(d.db, a.id))?.status).toBe("DRAFT");
    expect((await bacaJurnalDb(d.db, b.id))?.status).toBe("DRAFT");
  });
});

describe("spec 6.6.9 dua posting bersamaan untuk jurnal yang sama", () => {
  test("spec 6.6.9 dua request posting bersamaan hanya menghasilkan satu posting", async () => {
    const draft = await engine.buatJurnal(seimbang(rp(7_777_000), "uji dua posting bersamaan"), d.ctx.approver);

    // Both calls are in flight before either resolves. The port hands each
    // transaction its own connection, so this is a real race against the
    // database, not two awaits in a row.
    const hasil = await Promise.allSettled([
      engine.postingJurnal(draft.id, d.ctx.approver),
      engine.postingJurnal(draft.id, d.ctx.approver),
    ]);

    const berhasil = hasil.filter((h) => h.status === "fulfilled");
    const gagal = hasil.filter((h) => h.status === "rejected");
    expect(berhasil).toHaveLength(1);
    expect(gagal).toHaveLength(1);

    // The loser must lose cleanly: a domain error, not a driver deadlock or a
    // leaked trigger message.
    const alasan = (gagal[0] as PromiseRejectedResult).reason;
    expect(alasan).toBeInstanceOf(JurnalError);
    expect((alasan as JurnalError).kode).toBe(KODE_JURNAL.POSTING_BENTROK);

    const db = await bacaJurnalDb(d.db, draft.id);
    expect(db?.status).toBe("POSTED");
    expect(db?.posted_by).toBe(d.ctx.approver.userId);
  });

  test("spec 6.6.9 posting bersamaan tidak menduplikasi baris jurnal dan tidak menggandakan ledger", async () => {
    const nilai = rp(1_234_500);
    const draft = await engine.buatJurnal(seimbang(nilai, "uji tanpa duplikasi baris"), d.ctx.approver);

    await Promise.allSettled([
      engine.postingJurnal(draft.id, d.ctx.approver),
      engine.postingJurnal(draft.id, d.ctx.approver),
      engine.postingJurnal(draft.id, d.ctx.approver),
    ]);

    const baris = await d.db.query<{ n: number }>(
      `select count(*)::int as n from jurnal_baris where jurnal_id = $1 and deleted_at is null`,
      [draft.id],
    );
    expect(baris[0].n).toBe(2);

    const db = await bacaJurnalDb(d.db, draft.id);
    expect(db?.status).toBe("POSTED");
    expect(db?.total_debit).toBe(nilai);
    expect(db?.total_kredit).toBe(nilai);
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("spec 6.6.9 sepuluh posting bersamaan atas sepuluh jurnal berbeda semuanya berhasil", async () => {
    // The lock must be per journal, not a global one: a correct-but-serialised
    // engine that locks the whole table would pass the race tests above and
    // still be unusable at closing time.
    const draft = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        engine.buatJurnal(seimbang(rp(50_000 + i), `paralel beda jurnal ${i}`), d.ctx.approver),
      ),
    );
    const hasil = await Promise.all(draft.map((j) => engine.postingJurnal(j.id, d.ctx.approver)));

    expect(hasil).toHaveLength(10);
    expect(new Set(hasil.map((j) => j.noJurnal)).size).toBe(10);
    for (const j of hasil) expect(j.status).toBe("POSTED");
    expect(await selisihLedger(d.db)).toBe("0.00");
  });
});
