// Tests for the spec 6.4 event mapping seed.
//
// The bug these exist to prevent: `event_jurnal_mapping` is read at runtime by
// `postingEvent`, and on a freshly migrated database it is EMPTY, so every
// business event is rejected with EVENT_MAPPING_TIDAK_DITEMUKAN. A mapping
// that is "data, not code" (ADR 0004) still has to be seeded, and the seed has
// to cover every event with the right accounts on the right sides.
//
// The catalogue is 19 spec 6.4 codes PLUS 3 the owner ruled on (see the header
// of ./event-jurnal.ts and docs/BUILD-PLAN.md). The split is asserted here as
// two NAMED lists rather than as one total, so nobody can quietly slip a
// twenty-third event in as "one of the spec's": a new code has to be added to
// EVENT_KEPUTUSAN_PEMILIK, where it is visibly a decision and not an
// obligation.
import { describe, expect, test } from "bun:test";
import { createDbAdapter } from "../core/adapters/db";
import { AKUN_INTI, BARIS_LAPORAN_INTI, HEADER_AKUN_INTI, seedCoaInti } from "./coa-inti";
import {
  EVENT_KEPUTUSAN_PEMILIK,
  EVENT_SPEC_6_4,
  KATALOG_EVENT_JURNAL,
  debitDariPayload,
  kreditDariPayload,
  seedCoaDanEventMapping,
  seedEventJurnalMapping,
} from "./event-jurnal";

const db = createDbAdapter();

/** A fresh, isolated bumn per test: other agents reset this database mid-run. */
async function bumnBaru(): Promise<string> {
  const kode = `EV${crypto.randomUUID().slice(0, 6)}`;
  const rows = await db.query<{ id: string }>(
    "INSERT INTO bumn (kode, nama) VALUES ($1, $2) RETURNING id::text AS id",
    [kode, `BUMN uji event ${kode}`],
  );
  return rows[0]!.id;
}

/**
 * Every event code spec 6.4 lists, in the spec's own order. Transcribed, so the
 * catalogue is checked against the spec rather than against itself.
 */
const KODE_SPEC_6_4 = [
  "ALOKASI_DANA_BUMN_PEMBINA",
  "PENCAIRAN_PUMK",
  "ANGSURAN_POKOK",
  "ANGSURAN_JASA_ADM",
  "ANGSURAN_JASA_ADM_AKRUAL",
  "TERIMA_KELEBIHAN_ANGSURAN",
  "KEMBALIKAN_KELEBIHAN_ANGSURAN",
  "TERIMA_ANGSURAN_BELUM_TERIDENTIFIKASI",
  "IDENTIFIKASI_ANGSURAN",
  "PENYALURAN_NON_PUMK",
  "PENGEMBALIAN_SISA_NON_PUMK",
  "PENYALURAN_PINBUK",
  "AKRUAL_JASA_ADM",
  "BEBAN_PENYISIHAN",
  "PEMULIHAN_PENYISIHAN",
  "HAPUS_BUKU_PIUTANG",
  "PENERIMAAN_HAPUS_BUKU",
  "PENDAPATAN_JASA_GIRO",
  "BEBAN_OPERASIONAL",
];

/** The codes the owner ruled on, which the spec does not name. */
const KODE_KEPUTUSAN_PEMILIK = [
  "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
  "RESTRUKTUR_POKOK_NAIK",
  "RESTRUKTUR_POKOK_TURUN",
];

describe("the catalogue matches spec 6.4, plus the owner's three decisions", () => {
  test("the spec's 19 come first, in the spec's order, none missing and none renamed", () => {
    expect(EVENT_SPEC_6_4).toEqual(KODE_SPEC_6_4);
    expect(KATALOG_EVENT_JURNAL.slice(0, 19).map((ev) => ev.code)).toEqual(KODE_SPEC_6_4);
  });

  test("the three non-spec codes are named as decisions, and are the only extras", () => {
    expect(EVENT_KEPUTUSAN_PEMILIK).toEqual(KODE_KEPUTUSAN_PEMILIK);
    expect(KATALOG_EVENT_JURNAL.map((ev) => ev.code)).toEqual([
      ...KODE_SPEC_6_4,
      ...KODE_KEPUTUSAN_PEMILIK,
    ]);
    expect(KATALOG_EVENT_JURNAL).toHaveLength(22);
  });

  test("penghapustagihan has NO event code, on purpose", () => {
    // Penghapusbukuan already removes the receivable from the balance sheet
    // while the right to collect survives extracomptably, so extinguishing
    // that right moves no balance: it is a memorandum event on that register.
    // A second code producing a journal identical to HAPUS_BUKU_PIUTANG would
    // be a reconciliation trap. If a later agent "helpfully" adds one, this
    // test is where they find out it was deliberate.
    const kode = KATALOG_EVENT_JURNAL.map((ev) => ev.code);
    expect(kode.filter((k) => /HAPUS_TAGIH|PENGHAPUSTAGIHAN/.test(k))).toEqual([]);
  });

  test("the owner's three decisions post the accounts docs/BUILD-PLAN.md names", () => {
    const byCode = new Map(KATALOG_EVENT_JURNAL.map((ev) => [ev.code, ev]));
    // A write-off the allowance does not cover charges the shortfall to
    // expense instead of driving the contra-asset negative.
    expect(byCode.get("HAPUS_BUKU_KEKURANGAN_PENYISIHAN")).toMatchObject({
      debitKode: "5.1.01",
      kreditKode: "1.1.03",
    });
    // Principal up with no cash out capitalises accrued jasa administrasi.
    expect(byCode.get("RESTRUKTUR_POKOK_NAIK")).toMatchObject({
      debitKode: "1.1.03",
      kreditKode: "1.1.04",
    });
    // Principal down is a reduction of the claim, absorbed by the allowance.
    expect(byCode.get("RESTRUKTUR_POKOK_TURUN")).toMatchObject({
      debitKode: "1.1.05",
      kreditKode: "1.1.03",
    });
    // None of them touches cash: a restructure and a write-off are book
    // entries, and a cash leg appearing here would mean the wrong event.
    for (const kode of KODE_KEPUTUSAN_PEMILIK) {
      const ev = byCode.get(kode)!;
      expect(ev.debitKode).not.toBe("1.1.01");
      expect(ev.kreditKode).not.toBe("1.1.01");
    }
  });

  test("exactly the three 'per bidang / per jenis' events resolve a leg from the payload", () => {
    const dariPayload = KATALOG_EVENT_JURNAL.filter(
      (ev) => debitDariPayload(ev) || kreditDariPayload(ev),
    ).map((ev) => ev.code);
    expect(dariPayload).toEqual([
      "PENYALURAN_NON_PUMK",
      "PENGEMBALIAN_SISA_NON_PUMK",
      "BEBAN_OPERASIONAL",
    ]);
  });

  test("the Non PUMK refund credits back the SAME per-bidang account the disbursement debited", () => {
    // The bug this pins: the disbursement's debit came from the form (per
    // bidang, spec 6.4) while the refund's credit was bound to the pooled
    // 5.1.03. A bidang with its own expense account therefore had that account
    // debited on the way out and the POOLED account credited on the way back,
    // overstating the bidang's expense by the refund and driving the pooled
    // account negative by the same amount, with both journals balancing.
    const byCode = new Map(KATALOG_EVENT_JURNAL.map((ev) => [ev.code, ev]));
    const salur = byCode.get("PENYALURAN_NON_PUMK")!;
    const kembali = byCode.get("PENGEMBALIAN_SISA_NON_PUMK")!;
    // Cash on the opposite side of each, and the expense leg from the payload
    // on BOTH, which is what makes them each other's reverse.
    expect(salur).toMatchObject({ debitKode: null, kreditKode: "1.1.01" });
    expect(kembali).toMatchObject({ debitKode: "1.1.01", kreditKode: null });
  });

  test("no event takes a leg from the payload on one side and pins its reverse to a fixed account", () => {
    // Generalised from the refund bug: for every pair of events that reverse
    // each other, a payload leg on one side must be a payload leg on the other.
    // Kept as a list, so adding a reversing pair means declaring it here.
    const byCode = new Map(KATALOG_EVENT_JURNAL.map((ev) => [ev.code, ev]));
    const pasangan: ReadonlyArray<[string, string]> = [
      ["PENYALURAN_NON_PUMK", "PENGEMBALIAN_SISA_NON_PUMK"],
      ["TERIMA_KELEBIHAN_ANGSURAN", "KEMBALIKAN_KELEBIHAN_ANGSURAN"],
      ["BEBAN_PENYISIHAN", "PEMULIHAN_PENYISIHAN"],
    ];
    for (const [maju, mundur] of pasangan) {
      const a = byCode.get(maju)!;
      const b = byCode.get(mundur)!;
      // The non-cash leg of one is the non-cash leg of the other, swapped.
      expect(debitDariPayload(a)).toBe(kreditDariPayload(b));
      expect(kreditDariPayload(a)).toBe(debitDariPayload(b));
      if (a.debitKode !== null && b.kreditKode !== null) {
        expect(a.debitKode).toBe(b.kreditKode);
        expect(a.kreditKode).toBe(b.debitKode);
      }
    }
  });

  test("a payload leg never ships with a fixed account beside it", () => {
    // The rejected alternative, argued on EventJurnalDef: keep the pooled
    // 5.1.03 on PENGEMBALIAN_SISA_NON_PUMK as a "default" while the flag says
    // the caller supplies the leg. modules/jurnal resolves a leg as
    // `dari_payload ? payload.akun : row.akun`, with no fallback, so that
    // account would be read by nothing and would sit in the exact column where
    // the wrong answer used to be, ready to be believed. Either the row decides
    // the account or the caller does.
    for (const ev of KATALOG_EVENT_JURNAL) {
      expect(`${ev.code}:${debitDariPayload(ev) && ev.debitKode !== null}`).toBe(`${ev.code}:false`);
      expect(`${ev.code}:${kreditDariPayload(ev) && ev.kreditKode !== null}`).toBe(`${ev.code}:false`);
    }
  });

  test("the flag is stated on the payload rows, not inferred from a null", () => {
    // One null used to mean two things at once ("may be overridden" and "no
    // account here"), which is why they could not be discussed separately.
    const byCode = new Map(KATALOG_EVENT_JURNAL.map((ev) => [ev.code, ev]));
    expect(byCode.get("PENYALURAN_NON_PUMK")!.debitDariPayload).toBe(true);
    expect(byCode.get("PENGEMBALIAN_SISA_NON_PUMK")!.kreditDariPayload).toBe(true);
    expect(byCode.get("BEBAN_OPERASIONAL")!.debitDariPayload).toBe(true);
  });

  test("no event has both legs from the payload, and no event debits its own credit", () => {
    for (const ev of KATALOG_EVENT_JURNAL) {
      expect(ev.debitKode === null && ev.kreditKode === null).toBe(false);
      if (ev.debitKode && ev.kreditKode) expect(ev.debitKode).not.toBe(ev.kreditKode);
    }
  });

  test("every account a mapping names exists in the core COA", () => {
    const kodeAkun = new Set(AKUN_INTI.map((a) => a.kode));
    for (const ev of KATALOG_EVENT_JURNAL) {
      for (const kode of [ev.debitKode, ev.kreditKode]) {
        if (kode !== null) expect(kodeAkun.has(kode)).toBe(true);
      }
    }
  });

  test("the accounting direction of the money-moving events is the spec's", () => {
    const byCode = new Map(KATALOG_EVENT_JURNAL.map((ev) => [ev.code, ev]));
    // Disbursement increases receivables and decreases cash.
    expect(byCode.get("PENCAIRAN_PUMK")).toMatchObject({ debitKode: "1.1.03", kreditKode: "1.1.01" });
    // Repayment is the exact reverse.
    expect(byCode.get("ANGSURAN_POKOK")).toMatchObject({ debitKode: "1.1.01", kreditKode: "1.1.03" });
    // Overpayment becomes a liability, never a negative receivable (invariant 10).
    expect(byCode.get("TERIMA_KELEBIHAN_ANGSURAN")).toMatchObject({ kreditKode: "2.1.01" });
    // Allowance is a contra ASSET, credited when formed and debited on write-off.
    expect(byCode.get("BEBAN_PENYISIHAN")).toMatchObject({ debitKode: "5.1.01", kreditKode: "1.1.05" });
    expect(byCode.get("HAPUS_BUKU_PIUTANG")).toMatchObject({ debitKode: "1.1.05", kreditKode: "1.1.03" });
    // Accrual recognises revenue against a receivable, not against cash.
    expect(byCode.get("AKRUAL_JASA_ADM")).toMatchObject({ debitKode: "1.1.04", kreditKode: "4.1.02" });
  });

  test("jenis_jurnal is the one the closing and Pinbuk reports filter on", () => {
    const byCode = new Map(KATALOG_EVENT_JURNAL.map((ev) => [ev.code, ev]));
    expect(byCode.get("PENYALURAN_PINBUK")!.jenis).toBe("PINBUK");
    expect(byCode.get("AKRUAL_JASA_ADM")!.jenis).toBe("AKRUAL");
    expect(byCode.get("BEBAN_PENYISIHAN")!.jenis).toBe("PENYISIHAN");
    expect(byCode.get("PEMULIHAN_PENYISIHAN")!.jenis).toBe("PENYISIHAN");
  });
});

describe("seedCoaInti", () => {
  test("creates the report lines, the headers and the postable accounts", async () => {
    const bumnId = await bumnBaru();
    const byKode = await seedCoaInti(db, bumnId);
    expect(byKode.size).toBe(HEADER_AKUN_INTI.length + AKUN_INTI.length);

    const baris = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM baris_laporan WHERE bumn_id = $1",
      [bumnId],
    );
    expect(Number(baris[0]!.n)).toBe(BARIS_LAPORAN_INTI.length);
  });

  test("only leaves are postable, so a journal line cannot name a header", async () => {
    const bumnId = await bumnBaru();
    await seedCoaInti(db, bumnId);
    const rows = await db.query<{ kode: string; is_postable: boolean; postable_id: string | null }>(
      "SELECT kode, is_postable, postable_id::text AS postable_id FROM akun WHERE bumn_id = $1 ORDER BY kode",
      [bumnId],
    );
    for (const row of rows) {
      const isHeader = !row.kode.includes(".");
      expect(row.is_postable).toBe(!isHeader);
      // postable_id is the generated FK target; NULL means "unpostable", and
      // that is what makes it a plain FK violation rather than a trigger.
      expect(row.postable_id === null).toBe(isHeader);
    }
  });

  test("the contra asset is an ASSET with a CREDIT normal balance, shown as a deduction", async () => {
    const bumnId = await bumnBaru();
    await seedCoaInti(db, bumnId);
    const rows = await db.query<{ tipe: string; saldo_normal: string; is_kontra: boolean; tanda: number }>(
      `SELECT a.tipe, a.saldo_normal, a.is_kontra, b.tanda
         FROM akun a JOIN baris_laporan b ON b.bumn_id = a.bumn_id AND b.kode = a.klasifikasi_laporan
        WHERE a.bumn_id = $1 AND a.kode = '1.1.05'`,
      [bumnId],
    );
    expect(rows[0]).toMatchObject({ tipe: "ASET", saldo_normal: "K", is_kontra: true, tanda: -1 });
  });

  test("exactly the cash accounts carry is_kas, because Arus Kas is defined by it", async () => {
    const bumnId = await bumnBaru();
    await seedCoaInti(db, bumnId);
    const rows = await db.query<{ kode: string }>(
      "SELECT kode FROM akun WHERE bumn_id = $1 AND is_kas ORDER BY kode",
      [bumnId],
    );
    expect(rows.map((r) => r.kode)).toEqual(["1.1.01", "1.1.02"]);
  });

  test("is idempotent, and returns the same ids on a second run", async () => {
    const bumnId = await bumnBaru();
    const first = await seedCoaInti(db, bumnId);
    const second = await seedCoaInti(db, bumnId);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM akun WHERE bumn_id = $1",
      [bumnId],
    );
    expect(Number(rows[0]!.n)).toBe(first.size);
  });
});

describe("seedEventJurnalMapping", () => {
  test("seeds all 22 rows, active, with the right accounts on the right sides", async () => {
    const bumnId = await bumnBaru();
    const { event } = await seedCoaDanEventMapping(db, bumnId);
    expect(event).toEqual({ seeded: 22, total: 22 });

    const rows = await db.query<{
      event_code: string;
      debit_kode: string | null;
      kredit_kode: string | null;
      debit_dari_payload: boolean;
      kredit_dari_payload: boolean;
      jenis_jurnal: string;
      aktif: boolean;
    }>(
      `SELECT m.event_code, d.kode AS debit_kode, k.kode AS kredit_kode,
              m.debit_dari_payload, m.kredit_dari_payload, m.jenis_jurnal, m.aktif
         FROM event_jurnal_mapping m
         LEFT JOIN akun d ON d.postable_id = m.akun_debit_id
         LEFT JOIN akun k ON k.postable_id = m.akun_kredit_id
        WHERE m.bumn_id = $1`,
      [bumnId],
    );
    expect(rows).toHaveLength(22);
    const byCode = new Map(rows.map((row) => [row.event_code, row]));
    for (const ev of KATALOG_EVENT_JURNAL) {
      const row = byCode.get(ev.code);
      expect(row).toBeDefined();
      expect(row!.aktif).toBe(true);
      expect(row!.jenis_jurnal).toBe(ev.jenis);
      expect(row!.debit_kode).toBe(ev.debitKode);
      expect(row!.kredit_kode).toBe(ev.kreditKode);
      expect(row!.debit_dari_payload).toBe(ev.debitKode === null);
      expect(row!.kredit_dari_payload).toBe(ev.kreditKode === null);
    }
  });

  test("refuses loudly when the accounts are missing, instead of writing null legs", async () => {
    // A mapping row with a silently-null leg would look seeded and then fail
    // at posting time, far from the cause.
    const bumnId = await bumnBaru();
    await expect(seedEventJurnalMapping(db, bumnId)).rejects.toThrow(/belum ada untuk bumn/);
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event_jurnal_mapping WHERE bumn_id = $1",
      [bumnId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test("is idempotent: a second run adds nothing and changes nothing", async () => {
    const bumnId = await bumnBaru();
    await seedCoaDanEventMapping(db, bumnId);
    const again = await seedCoaDanEventMapping(db, bumnId);
    expect(again.event.seeded).toBe(0);
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event_jurnal_mapping WHERE bumn_id = $1",
      [bumnId],
    );
    expect(Number(rows[0]!.n)).toBe(22);
  });

  test("never overwrites an account an accountant corrected (ADR 0004)", async () => {
    const bumnId = await bumnBaru();
    const { akun } = await seedCoaDanEventMapping(db, bumnId);
    // Point PENCAIRAN_PUMK's credit leg at the second cash account, the way
    // the Konfigurasi screen will.
    await db.query(
      `UPDATE event_jurnal_mapping SET akun_kredit_id = $2
        WHERE bumn_id = $1 AND event_code = 'PENCAIRAN_PUMK'`,
      [bumnId, akun.get("1.1.02")],
    );
    await seedCoaDanEventMapping(db, bumnId);
    const rows = await db.query<{ kode: string }>(
      `SELECT k.kode FROM event_jurnal_mapping m JOIN akun k ON k.postable_id = m.akun_kredit_id
        WHERE m.bumn_id = $1 AND m.event_code = 'PENCAIRAN_PUMK'`,
      [bumnId],
    );
    expect(rows[0]!.kode).toBe("1.1.02");
  });

  test("mappings are per bumn, so one entity's correction cannot touch another's", async () => {
    const a = await bumnBaru();
    const b = await bumnBaru();
    await seedCoaDanEventMapping(db, a);
    await seedCoaDanEventMapping(db, b);
    const rows = await db.query<{ bumn_id: string; n: string }>(
      `SELECT bumn_id::text AS bumn_id, count(*)::text AS n FROM event_jurnal_mapping
        WHERE bumn_id = ANY($1::uuid[]) GROUP BY bumn_id`,
      [[a, b]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Number(row.n)).toBe(22);
  });
});

describe("seedFase0 leaves a database that can actually post", () => {
  test("every bumn present ends up with a full mapping set", async () => {
    const { seedFase0 } = await import("./index");
    const extra = await bumnBaru();
    await seedFase0({ db, log: () => {} });
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event_jurnal_mapping WHERE bumn_id = $1 AND aktif",
      [extra],
    );
    expect(Number(rows[0]!.n)).toBe(22);
  }, 30_000);
});
