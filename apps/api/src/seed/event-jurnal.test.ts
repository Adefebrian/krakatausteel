// Tests for the spec 6.4 event mapping seed.
//
// The bug these exist to prevent: `event_jurnal_mapping` is read at runtime by
// `postingEvent`, and on a freshly migrated database it is EMPTY, so every
// business event is rejected with EVENT_MAPPING_TIDAK_DITEMUKAN. A mapping
// that is "data, not code" (ADR 0004) still has to be seeded, and the seed has
// to cover all 19 events with the right accounts on the right sides.
import { describe, expect, test } from "bun:test";
import { createDbAdapter } from "../core/adapters/db";
import { AKUN_INTI, BARIS_LAPORAN_INTI, HEADER_AKUN_INTI, seedCoaInti } from "./coa-inti";
import { KATALOG_EVENT_JURNAL, seedCoaDanEventMapping, seedEventJurnalMapping } from "./event-jurnal";

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

/** Every event code spec 6.4 lists, in the spec's own order. */
const EVENT_SPEC_6_4 = [
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

describe("the catalogue matches spec 6.4", () => {
  test("all 19 events, in the spec's order, no extras and none missing", () => {
    expect(KATALOG_EVENT_JURNAL.map((ev) => ev.code)).toEqual(EVENT_SPEC_6_4);
  });

  test("exactly the two 'per bidang / per jenis' events resolve a leg from the payload", () => {
    const dariPayload = KATALOG_EVENT_JURNAL.filter(
      (ev) => ev.debitKode === null || ev.kreditKode === null,
    ).map((ev) => ev.code);
    expect(dariPayload).toEqual(["PENYALURAN_NON_PUMK", "BEBAN_OPERASIONAL"]);
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
  test("seeds all 19 rows, active, with the right accounts on the right sides", async () => {
    const bumnId = await bumnBaru();
    const { event } = await seedCoaDanEventMapping(db, bumnId);
    expect(event).toEqual({ seeded: 19, total: 19 });

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
    expect(rows).toHaveLength(19);
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
    expect(Number(rows[0]!.n)).toBe(19);
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
    for (const row of rows) expect(Number(row.n)).toBe(19);
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
    expect(Number(rows[0]!.n)).toBe(19);
  }, 30_000);
});
