// Tests for the spec 4.1 programme master seed.
//
// The bug they exist to prevent is the one that was found in the browser
// rather than here: `db:seed:dev` created no `sektor_pumk` row, so the live
// Daftar Proposal screen printed "Belum diisi" in the Sektor column of every
// row and `GET /konfigurasi/sektor` answered `[]`. `bidang_non_pumk` and `sdg`
// were empty for the same reason, and spec 9.2 makes BOTH mandatory on a Non
// PUMK proposal, so that form could not be submitted at all.
//
// The lists are asserted against the SPEC's own wording, transcribed here, so
// the catalogue is checked against spec 4.1 rather than against itself.
import { afterAll, describe, expect, test } from "bun:test";
import { createDbAdapter } from "../core/adapters/db";
import { tandaiBumnUjiTerhapus } from "../testing/harness";
import { BIDANG_NON_PUMK, SDG, SEKTOR_PUMK, seedMasterProgram, seedSdg } from "./master-program";

const db = createDbAdapter();

/** Every bumn this file created, so `afterAll` can close them. */
const bumnDibuat: string[] = [];

/** A fresh, isolated bumn per test: other agents reset this database mid-run. */
async function bumnBaru(): Promise<string> {
  const kode = `MP${crypto.randomUUID().slice(0, 6)}`;
  const rows = await db.query<{ id: string }>(
    "INSERT INTO bumn (kode, nama) VALUES ($1, $2) RETURNING id::text AS id",
    [kode, `BUMN uji master ${kode}`],
  );
  bumnDibuat.push(rows[0]!.id);
  return rows[0]!.id;
}

// Marks this file's entities closed once it is done, so seed/event-jurnal's
// per-bumn sweep stays bounded. See the FIXTURE LEAK note in
// apps/api/src/testing/harness.ts.
afterAll(async () => {
  for (const id of bumnDibuat) {
    await tandaiBumnUjiTerhapus(db, id).catch(() => {});
  }
});

describe("the catalogue is spec 4.1's own list", () => {
  test("the eight sektor PUMK, in the spec's order", () => {
    expect(SEKTOR_PUMK.map((s) => s.nama)).toEqual([
      "Industri",
      "Perdagangan",
      "Pertanian",
      "Peternakan",
      "Perkebunan",
      "Perikanan",
      "Jasa",
      "Lainnya",
    ]);
    // Spec 13: "8 sektor PUMK, 7 bidang Non PUMK, 17 SDG".
    expect(SEKTOR_PUMK).toHaveLength(8);
    expect(new Set(SEKTOR_PUMK.map((s) => s.kode)).size).toBe(8);
  });

  test("the seven bidang Non PUMK, in the spec's order", () => {
    expect(BIDANG_NON_PUMK.map((b) => b.nama)).toEqual([
      "Pendidikan",
      "Kesehatan",
      "Sarana Ibadah",
      "Sarana Umum",
      "Bencana Alam",
      "Pelestarian Alam",
      "Pengentasan Kemiskinan",
    ]);
    expect(new Set(BIDANG_NON_PUMK.map((b) => b.kode)).size).toBe(7);
  });

  test("all seventeen SDG, numbered 1..17 with no gap and no duplicate", () => {
    // `sdg.nomor` is CHECK (nomor BETWEEN 1 AND 17), so a gap here would be a
    // goal no programme could ever be mapped to.
    expect(SDG.map((s) => s.nomor)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(new Set(SDG.map((s) => s.nama)).size).toBe(17);
  });
});

describe("seedMasterProgram", () => {
  test("fills the three tables the proposal forms depend on", async () => {
    const bumnId = await bumnBaru();
    const hasil = await seedMasterProgram(db, bumnId);
    expect(hasil.sektor).toBe(8);
    expect(hasil.bidang).toBe(7);

    // Ordered the way modules/konfigurasi/repo.ts `listSektor` reads them
    // (urutan, then kode), which is what the dropdown shows.
    const sektor = await db.query<{ kode: string; nama: string }>(
      `SELECT kode, nama FROM sektor_pumk
        WHERE bumn_id = $1 AND aktif AND deleted_at IS NULL ORDER BY urutan ASC, kode ASC`,
      [bumnId],
    );
    expect(sektor.map((s) => s.nama)).toEqual(SEKTOR_PUMK.map((s) => s.nama));

    const bidang = await db.query<{ nama: string }>(
      `SELECT nama FROM bidang_non_pumk
        WHERE bumn_id = $1 AND aktif AND deleted_at IS NULL ORDER BY urutan ASC, kode ASC`,
      [bumnId],
    );
    expect(bidang.map((b) => b.nama)).toEqual(BIDANG_NON_PUMK.map((b) => b.nama));

    const sdg = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM sdg WHERE deleted_at IS NULL",
    );
    // Global table shared with every other test's world, so the assertion is
    // "at least the seventeen", never an exact count.
    expect(Number(sdg[0]!.n)).toBeGreaterThanOrEqual(17);
  }, 30_000);

  test("SDG are global and stay exactly one row per nomor across repeated runs", async () => {
    await seedSdg(db);
    await seedSdg(db);
    const rows = await db.query<{ nomor: number; n: string }>(
      `SELECT nomor, count(*)::text AS n FROM sdg WHERE deleted_at IS NULL GROUP BY nomor ORDER BY nomor`,
    );
    expect(rows.map((r) => r.nomor)).toEqual(SDG.map((s) => s.nomor));
    for (const row of rows) expect(Number(row.n)).toBe(1);
  }, 30_000);

  test("is idempotent: a second run inserts nothing", async () => {
    const bumnId = await bumnBaru();
    await seedMasterProgram(db, bumnId);
    const lagi = await seedMasterProgram(db, bumnId);
    expect(lagi).toEqual({ sektor: 0, bidang: 0, sdg: 0 });
  }, 30_000);

  test("never overwrites a rename or a deactivation an operator made", async () => {
    // Konfigurasi > Master is a CRUD screen (spec 9.6), so these rows belong to
    // the accountant once they exist. A seed that re-asserted its own names
    // would undo their edit on the next deploy.
    const bumnId = await bumnBaru();
    await seedMasterProgram(db, bumnId);
    await db.query(
      `UPDATE sektor_pumk SET nama = 'Sektor Lain lain', aktif = false
        WHERE bumn_id = $1 AND kode = 'LNY'`,
      [bumnId],
    );
    await seedMasterProgram(db, bumnId);
    const rows = await db.query<{ nama: string; aktif: boolean }>(
      "SELECT nama, aktif FROM sektor_pumk WHERE bumn_id = $1 AND kode = 'LNY'",
      [bumnId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nama: "Sektor Lain lain", aktif: false });
  }, 30_000);

  test("master data is per bumn, so one entity's edit cannot touch another's", async () => {
    const a = await bumnBaru();
    const b = await bumnBaru();
    await seedMasterProgram(db, a);
    await seedMasterProgram(db, b);
    const rows = await db.query<{ bumn_id: string; n: string }>(
      `SELECT bumn_id::text AS bumn_id, count(*)::text AS n FROM sektor_pumk
        WHERE bumn_id = ANY($1::uuid[]) GROUP BY bumn_id`,
      [[a, b]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Number(row.n)).toBe(8);
  }, 30_000);
});

describe("seedFase0 leaves a database whose proposal forms can be filled in", () => {
  test("every bumn present ends up with the full sektor and bidang set", async () => {
    const { seedFase0 } = await import("./index");
    const extra = await bumnBaru();
    await seedFase0({ db, log: () => {} });
    const rows = await db.query<{ sektor: string; bidang: string }>(
      `SELECT (SELECT count(*)::text FROM sektor_pumk WHERE bumn_id = $1 AND deleted_at IS NULL) AS sektor,
              (SELECT count(*)::text FROM bidang_non_pumk WHERE bumn_id = $1 AND deleted_at IS NULL) AS bidang`,
      [extra],
    );
    expect(Number(rows[0]!.sektor)).toBe(8);
    expect(Number(rows[0]!.bidang)).toBe(7);
  }, 60_000);
});
