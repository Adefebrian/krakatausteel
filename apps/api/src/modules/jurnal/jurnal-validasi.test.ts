// Spec 6.2 "Validasi wajib di buatJurnal", all nine, one test each, in the
// order the spec lists them. Plus the spec 6.3 / spec 2 authorisation rules
// that guard the same surface.
//
// THE POINT OF THESE TESTS IS NOT ONLY "IT IS REJECTED".
// Validations 1, 2, 3, 5 and 6 are also enforced by Postgres (CHECK
// constraints and triggers, see migrations/0010_jurnal.sql and ADR 0002). It
// would be easy to "pass" them by doing nothing in the app layer and letting
// the driver throw. That is not acceptable: the caller would receive
//   'TJSL-JRN-031: jurnal UMUM/202602/00007 tidak balance: total debit ...'
// or a bare `duplicate key value violates unique constraint`. So `tolakDengan`
// asserts three things at once: the rejection happened, it carries the right
// domain code, and the message is free of driver/trigger internals. The DB
// stays the last line of defence; the engine still owes a clean error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJurnalEngine,
  KODE_JURNAL,
  POLA_NO_JURNAL,
  type BuatJurnalInput,
  type JurnalEngine,
} from "./contract";
import {
  bacaJurnalDb,
  buatDunia,
  rp,
  sen,
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

function dasar(baris: BuatJurnalInput["baris"], ubah: Partial<BuatJurnalInput> = {}): BuatJurnalInput {
  return {
    cabangId: d.cabangId,
    jenis: "UMUM",
    tanggalTransaksi: d.tanggalKini,
    keterangan: "uji validasi 6.2",
    baris,
    ...ubah,
  };
}

describe("spec 6.2 validasi buatJurnal", () => {
  test("spec 6.2.1 tanggal transaksi harus jatuh di periode yang OPEN", async () => {
    await d.tutupPeriode(d.periodeAwal);

    // Dated into a CLOSED period. Note the guard is on tanggal_transaksi, not
    // on the input timestamp (invariant 5).
    await tolakDengan(
      engine.buatJurnal(
        dasar(
          [
            { akunId: d.akun.kas.id, debit: rp(100_000) },
            { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) },
          ],
          { tanggalTransaksi: d.tanggalAwal },
        ),
        d.ctx.maker,
      ),
      KODE_JURNAL.PERIODE_TIDAK_OPEN,
    );

    // Dated where no periode row exists at all: same rejection, not a crash.
    await tolakDengan(
      engine.buatJurnal(
        dasar(
          [
            { akunId: d.akun.kas.id, debit: rp(100_000) },
            { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) },
          ],
          { tanggalTransaksi: "2031-07-09" },
        ),
        d.ctx.maker,
      ),
      KODE_JURNAL.PERIODE_TIDAK_OPEN,
    );
  });

  test("spec 6.2.2 minimal 2 baris", async () => {
    await tolakDengan(
      engine.buatJurnal(dasar([{ akunId: d.akun.kas.id, debit: rp(100_000) }]), d.ctx.maker),
      KODE_JURNAL.MINIMAL_DUA_BARIS,
    );
    await tolakDengan(engine.buatJurnal(dasar([]), d.ctx.maker), KODE_JURNAL.MINIMAL_DUA_BARIS);
  });

  test("spec 6.2.3 setiap baris punya nilai di debit atau kredit, tidak keduanya, tidak nol keduanya", async () => {
    const pasangan = { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) };

    // both sides filled
    await tolakDengan(
      engine.buatJurnal(
        dasar([{ akunId: d.akun.kas.id, debit: rp(100_000), kredit: rp(100_000) }, pasangan]),
        d.ctx.maker,
      ),
      KODE_JURNAL.SATU_SISI_PER_BARIS,
    );
    // neither side present
    await tolakDengan(
      engine.buatJurnal(dasar([{ akunId: d.akun.kas.id }, pasangan]), d.ctx.maker),
      KODE_JURNAL.SATU_SISI_PER_BARIS,
    );
    // both sides zero: a placeholder line must not be storable
    await tolakDengan(
      engine.buatJurnal(
        dasar([{ akunId: d.akun.kas.id, debit: rp(0), kredit: rp(0) }, pasangan]),
        d.ctx.maker,
      ),
      KODE_JURNAL.SATU_SISI_PER_BARIS,
    );
  });

  test("spec 6.2.4 semua nilai tidak negatif", async () => {
    await tolakDengan(
      engine.buatJurnal(
        dasar([
          { akunId: d.akun.kas.id, debit: "-1000.00" },
          { akunId: d.akun.pendapatanAlokasi.id, kredit: "-1000.00" },
        ]),
        d.ctx.maker,
      ),
      KODE_JURNAL.NILAI_NEGATIF,
    );
    // A negative on one line only would also be unbalanced; this variant keeps
    // the sums equal so the negative check is what has to fire, not 6.2.5.
    await tolakDengan(
      engine.buatJurnal(
        dasar([
          { akunId: d.akun.kas.id, debit: rp(200_000) },
          { akunId: d.akun.kasKedua.id, debit: "-100000.00" },
          { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) },
        ]),
        d.ctx.maker,
      ),
      KODE_JURNAL.NILAI_NEGATIF,
    );
  });

  test("spec 6.2.5 SUM(debit) = SUM(kredit) persis, selisih 1 sen pun ditolak", async () => {
    // 1.000.000,00 debit against 999.999,99 credit. "Tanpa toleransi" is the
    // spec's word, so the fixture is deliberately off by the smallest unit the
    // NUMERIC(20,2) column can express.
    await tolakDengan(
      engine.buatJurnal(
        dasar([
          { akunId: d.akun.kas.id, debit: sen(100_000_000n) },
          { akunId: d.akun.pendapatanAlokasi.id, kredit: sen(99_999_999n) },
        ]),
        d.ctx.maker,
      ),
      KODE_JURNAL.TIDAK_BALANCE,
    );
  });

  test("spec 6.2.6 semua akun ada, aktif, dan is_postable = true", async () => {
    const pasangan = { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) };

    // (a) account does not exist
    await tolakDengan(
      engine.buatJurnal(
        dasar([{ akunId: crypto.randomUUID(), debit: rp(100_000) }, pasangan]),
        d.ctx.maker,
      ),
      KODE_JURNAL.AKUN_TIDAK_VALID,
    );
    // (b) account exists and is postable but is deactivated
    await tolakDengan(
      engine.buatJurnal(
        dasar([{ akunId: d.akun.bebanNonAktif.id, debit: rp(100_000) }, pasangan]),
        d.ctx.maker,
      ),
      KODE_JURNAL.AKUN_TIDAK_VALID,
    );
    // (c) header account: is_postable = false, so postable_id is NULL and the
    // FK in migrations/0010 can never resolve it. Must still be a clean
    // domain error, not a foreign_key_violation from the driver.
    await tolakDengan(
      engine.buatJurnal(
        dasar([{ akunId: d.akunHeaderId, debit: rp(100_000) }, pasangan]),
        d.ctx.maker,
      ),
      KODE_JURNAL.AKUN_TIDAK_VALID,
    );
  });

  test("spec 6.2.7 cabang di header harus sama dengan scope user", async () => {
    await tolakDengan(
      engine.buatJurnal(
        dasar(
          [
            { akunId: d.akun.kas.id, debit: rp(100_000) },
            { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) },
          ],
          { cabangId: d.cabangLainId },
        ),
        d.ctx.maker,
      ),
      KODE_JURNAL.CABANG_DILUAR_SCOPE,
    );

    // Control: the same input is accepted for a user whose scope IS that
    // branch, which proves the rejection was about scope and not about the
    // branch row being unusable.
    const sah = await engine.buatJurnal(
      dasar(
        [
          { akunId: d.akun.kas.id, debit: rp(100_000) },
          { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(100_000) },
        ],
        { cabangId: d.cabangLainId },
      ),
      d.ctx.approverCabangLain,
    );
    expect(sah.cabangId).toBe(d.cabangLainId);
    expect(sah.status).toBe("DRAFT");
  });

  test("spec 6.2.8 baris dengan mitra_id atau akad_id harus memakai akun piutang mitra binaan", async () => {
    // (a) sub-ledger dimension on a cash line
    await tolakDengan(
      engine.buatJurnal(
        dasar([
          { akunId: d.akun.kas.id, debit: rp(500_000), mitraId: d.mitraId },
          { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(500_000) },
        ]),
        d.ctx.maker,
      ),
      KODE_JURNAL.DIMENSI_PIUTANG_SALAH_AKUN,
    );
    // (b) akad_id on a revenue line
    await tolakDengan(
      engine.buatJurnal(
        dasar([
          { akunId: d.akun.kas.id, debit: rp(500_000) },
          { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(500_000), akadId: d.akadId },
        ]),
        d.ctx.maker,
      ),
      KODE_JURNAL.DIMENSI_PIUTANG_SALAH_AKUN,
    );
    // (c) accepted on the receivable account
    const sah = await engine.buatJurnal(
      dasar([
        { akunId: d.akun.piutangPokok.id, debit: rp(500_000), mitraId: d.mitraId, akadId: d.akadId },
        { akunId: d.akun.kas.id, kredit: rp(500_000) },
      ]),
      d.ctx.maker,
    );
    expect(sah.baris.find((b) => b.akunId === d.akun.piutangPokok.id)?.akadId).toBe(d.akadId);

    // (d) WHICH account counts as "piutang mitra binaan" is configuration, not
    // code: it is the debit leg of PENCAIRAN_PUMK in event_jurnal_mapping,
    // exactly as v_rekonsiliasi_piutang reads it (migrations/0015). Repoint the
    // mapping row and the answer must move with it, with no redeploy.
    await d.gantiAkunMapping("PENCAIRAN_PUMK", "akun_debit_id", d.akun.piutangAlternatif.id);
    try {
      await tolakDengan(
        engine.buatJurnal(
          dasar([
            { akunId: d.akun.piutangPokok.id, debit: rp(500_000), mitraId: d.mitraId },
            { akunId: d.akun.kas.id, kredit: rp(500_000) },
          ]),
          d.ctx.maker,
        ),
        KODE_JURNAL.DIMENSI_PIUTANG_SALAH_AKUN,
      );
      const sahBaru = await engine.buatJurnal(
        dasar([
          { akunId: d.akun.piutangAlternatif.id, debit: rp(500_000), mitraId: d.mitraId },
          { akunId: d.akun.kas.id, kredit: rp(500_000) },
        ]),
        d.ctx.maker,
      );
      expect(sahBaru.status).toBe("DRAFT");
    } finally {
      await d.gantiAkunMapping("PENCAIRAN_PUMK", "akun_debit_id", d.akun.piutangPokok.id);
    }
  });

  test("spec 6.2.9 nomor jurnal digenerate atomik, tidak boleh duplikat", async () => {
    const PARALEL = 12;
    const hasil = await Promise.all(
      Array.from({ length: PARALEL }, (_, i) =>
        engine.buatJurnal(
          dasar(
            [
              { akunId: d.akun.kas.id, debit: rp(10_000 + i) },
              { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(10_000 + i) },
            ],
            { keterangan: `paralel ${i}` },
          ),
          d.ctx.maker,
        ),
      ),
    );

    const nomor = hasil.map((j) => j.noJurnal);
    expect(new Set(nomor).size).toBe(PARALEL);
    for (const n of nomor) expect(n).toMatch(POLA_NO_JURNAL);

    // Spec 4.6: numbering is per jenis per periode, so all twelve share one
    // series prefix and differ only in the sequence.
    const prefix = new Set(nomor.map((n) => n.slice(0, n.lastIndexOf("/"))));
    expect(prefix.size).toBe(1);

    const db = await d.db.query<{ n: number }>(
      `select count(distinct no_jurnal)::int as n from jurnal where bumn_id = $1`,
      [d.bumnId],
    );
    const total = await d.db.query<{ n: number }>(
      `select count(*)::int as n from jurnal where bumn_id = $1`,
      [d.bumnId],
    );
    expect(db[0].n).toBe(total[0].n);
  });

  // Not one of the nine, but the contract carries the code, so it carries a
  // test: an amount that is not a two-decimal string never reaches the DB.
  test("spec 6.2 tambahan: nilai uang yang bukan desimal dua digit ditolak sebagai domain error", async () => {
    for (const buruk of ["1000", "1000.5", "1e6", "abc", "1,000.00"]) {
      await tolakDengan(
        engine.buatJurnal(
          dasar([
            { akunId: d.akun.kas.id, debit: buruk },
            { akunId: d.akun.pendapatanAlokasi.id, kredit: buruk },
          ]),
          d.ctx.maker,
        ),
        KODE_JURNAL.NILAI_BUKAN_DESIMAL,
      );
    }
  });
});

describe("spec 6.3 otorisasi di surface jurnal", () => {
  test("spec 6.3 posting tanpa permission jurnal.post ditolak dan jurnal tetap DRAFT", async () => {
    const draft = await engine.buatJurnal(
      dasar([
        { akunId: d.akun.kas.id, debit: rp(400_000) },
        { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(400_000) },
      ]),
      d.ctx.maker,
    );

    // Maker has jurnal.create but not jurnal.post.
    await tolakDengan(engine.postingJurnal(draft.id, d.ctx.maker), KODE_JURNAL.TIDAK_BERWENANG);
    // Auditor is read-only.
    await tolakDengan(engine.postingJurnal(draft.id, d.ctx.auditor), KODE_JURNAL.TIDAK_BERWENANG);

    expect((await bacaJurnalDb(d.db, draft.id))?.status).toBe("DRAFT");
  });

  test("spec 2 aturan 1: pembuat jurnal tidak boleh memverifikasi jurnalnya sendiri", async () => {
    const draft = await engine.buatJurnal(
      dasar([
        { akunId: d.akun.kas.id, debit: rp(300_000) },
        { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(300_000) },
      ]),
      d.ctx.approver,
    );

    // Same person as created_by, even though they hold jurnal.verify.
    const ctxMakerSekaligusChecker = {
      ...d.ctx.approver,
      permissions: [...d.ctx.approver.permissions, "jurnal.verify"],
    };
    await tolakDengan(
      engine.verifikasiJurnal(draft.id, ctxMakerSekaligusChecker),
      KODE_JURNAL.MAKER_TIDAK_BOLEH_CHECKER,
    );

    // A different user holding jurnal.verify succeeds.
    const terverifikasi = await engine.verifikasiJurnal(draft.id, d.ctx.checker);
    expect(terverifikasi.verifiedBy).toBe(d.ctx.checker.userId);
    expect(terverifikasi.status).toBe("DRAFT");
  });
});
