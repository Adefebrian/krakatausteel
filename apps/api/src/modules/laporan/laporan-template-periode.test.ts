// A CLOSED PERIOD REPRINTS UNDER THE TEMPLATE IT WAS CLOSED WITH.
//
// THE OTHER HALF OF migrations/0028 AND ADR 0017. `template_laporan` is
// EFFECTIVE DATED over the period being reported on, so "which layout is in
// force for March 2026" has exactly one answer and that answer CHANGES the day
// a client adopts a new one. A reader that resolved by effective date alone
// would therefore reissue every 2026 statement in the 2027 shape, without
// anybody editing anything and without anybody being told. ADR 0017 names that
// as the failure with the widest blast radius and the only one that happens by
// accident.
//
// `periode.template_laporan_id` is what prevents it. modules/closing writes it
// at close, inside the transaction that freezes the balances, and
// ../closing/closing-template-periode.test.ts proves the WRITER. That file
// deliberately asserts nothing about rendering so the two changes stay
// independently releasable; this file is the reader, and it is the half that
// would catch a reader silently ignoring the column.
//
// WHY THE REST OF THIS FOLDER CANNOT CATCH IT. Every other closed-period test
// here closes through the fixture's raw-SQL precondition, which writes no
// stamp, so every one of them exercises the FALLBACK and would stay green
// against a reader that never looks at the column at all. The state that
// distinguishes the two only exists once a SECOND template has been adopted,
// which is what this file builds.
//
// THREE PROPERTIES, AND EACH ONE FAILS A DIFFERENT WRONG READER:
//   1. a stamped CLOSED period ignores the newer template. Fails a reader that
//      resolves by effective date;
//   2. an OPEN period ignores the stamp, even one left on the row. Fails a
//      reader that prefers the column unconditionally, which matters because
//      REOPEN CLEARS the stamp: a reopened period must go back to the
//      effective-dated lookup rather than to a stale one;
//   3. the fallback SAYS it fell back. A null stamp is legitimate, not an
//      error, so a reader cannot tell a legitimate fallback from a reader that
//      ignores the column unless the page says which path it took.
//
// NOTHING HERE ASSERTS WHICH CAPTIONS ARE RIGHT. The second template is named
// after ISAK 335 because that is the migration's own worked example, and its
// lines are the first template's with a suffix, precisely so the assertions are
// about WHICH TEMPLATE WAS USED and not about wording. Which standard the
// client reports under is still their accounting team's decision.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  buatDunia,
  keSen,
  kunci,
  tolakDengan,
  type DuniaLaporan,
  type PeriodeFixture,
} from "./test-support";
import { KODE_LAPORAN } from "./contract";

let d: DuniaLaporan;

/** Suffix on every copied line, so a rendered page names its own template. */
const SUFIKS_BARU = " (template baru)";

beforeEach(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterEach(async () => {
  await d?.tutup();
});

/** The one template `seedTemplateLaporan` gives every world. */
async function templateAwal(): Promise<string> {
  const rows = await d.db.query<{ id: string }>(
    `select id::text as id from template_laporan
      where bumn_id = $1 and deleted_at is null and aktif`,
    [d.bumnId],
  );
  expect(rows, "dunia harus punya tepat satu template di awal").toHaveLength(1);
  return rows[0].id;
}

/**
 * Adopts a SECOND template from `berlakuDari`, the way a client adopting a new
 * standard would: the old one's range is closed the day before, the new one
 * takes over, and every line and mapping is carried across with a renamed
 * caption. Nothing is backdated and no account is reclassified, which is
 * exactly why an effective-date-only reader silently restates history.
 *
 * The old range is closed BEFORE the new row is inserted because 0028's
 * non-overlap trigger is per statement here: this fixture's port autocommits,
 * so the two would otherwise overlap at the moment the second one lands.
 */
async function adopsiTemplateBaru(berlakuDari: string): Promise<string> {
  const lama = await templateAwal();
  const sebelum = new Date(`${berlakuDari}T00:00:00.000Z`);
  sebelum.setUTCDate(sebelum.getUTCDate() - 1);
  await d.db.query(
    `update template_laporan set berlaku_sampai = $2::date, updated_by = $3 where id = $1`,
    [lama, sebelum.toISOString().slice(0, 10), d.userId.adminPusat],
  );
  const baru = await d.db.query<{ id: string }>(
    `insert into template_laporan (bumn_id, kode, nama, dasar, berlaku_dari, created_by, updated_by)
     values ($1, $2, 'Template baru (fixture laporan)', 'ISAK 335', $3::date, $4, $4)
     returning id::text as id`,
    [d.bumnId, kunci("TPL"), berlakuDari, d.userId.adminPusat],
  );
  const baruId = baru[0].id;
  // Lines first. `parent_id` is deliberately dropped rather than remapped: a
  // parent in another template is exactly what 0028's four-column foreign key
  // exists to make impossible, and nothing here reads the nesting.
  await d.db.query(
    `insert into baris_laporan
       (bumn_id, template_id, laporan, kode, nama, parent_id, urutan, level, tipe_baris,
        tanda, seksi, aktif, created_by, updated_by)
     select b.bumn_id, $2, b.laporan, b.kode, b.nama || $4, null, b.urutan, b.level,
            b.tipe_baris, b.tanda, b.seksi, b.aktif, $3, $3
       from baris_laporan b
      where b.bumn_id = $1 and b.template_id = $5 and b.deleted_at is null`,
    [d.bumnId, baruId, d.userId.adminPusat, SUFIKS_BARU, lama],
  );
  // Then the mappings, matched by (kode, laporan) so every classification lands
  // on the same line it landed on before. A template adopted without them would
  // orphan every account and the report would refuse, which is the right
  // behaviour and not what this file is testing.
  await d.db.query(
    `insert into pemetaan_baris_laporan
       (bumn_id, template_id, klasifikasi_id, baris_laporan_id, laporan, created_by, updated_by)
     select p.bumn_id, $2, p.klasifikasi_id, nb.id, p.laporan, $3, $3
       from pemetaan_baris_laporan p
       join baris_laporan ob on ob.id = p.baris_laporan_id
       join baris_laporan nb
         on nb.bumn_id = p.bumn_id and nb.template_id = $2
        and nb.kode = ob.kode and nb.laporan = p.laporan
      where p.bumn_id = $1 and p.template_id = $4 and p.deleted_at is null`,
    [d.bumnId, baruId, d.userId.adminPusat, lama],
  );
  return baruId;
}

/**
 * Stamps a period by hand. A PRECONDITION, not the behaviour under test: the
 * writer is modules/closing's and is proved by its own suite, and driving the
 * ten-item checklist of spec 8.4 to reach one column would make this file fail
 * for reasons that have nothing to do with rendering.
 */
async function capPeriode(p: PeriodeFixture, templateId: string | null): Promise<void> {
  await d.db.query(
    `update periode set template_laporan_id = $2::uuid, updated_by = $3 where id = $1`,
    [p.id, templateId, d.userId.adminPusat],
  );
}

function posisi(p: PeriodeFixture) {
  return d.engine.laporanPosisiKeuangan(
    { periodeId: p.id, cabangId: d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("periode CLOSED dicetak ulang dengan template saat ditutup", () => {
  test("template baru diadopsi setelahnya TIDAK mengubah bentuk periode yang sudah ditutup", async () => {
    const p = d.periodeLaporan();
    const lama = await templateAwal();
    const sebelumAdopsi = await posisi(p);

    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    await capPeriode(p, lama);

    // The client adopts a new template covering the whole of the reporting
    // year, AFTER that year's March has been closed and issued.
    const baru = await adopsiTemplateBaru(`${p.tahun}-01-01`);

    const sesudah = await posisi(p);
    expect(sesudah.header.templateLaporanId).toBe(lama);
    expect(sesudah.header.templateLaporanId).not.toBe(baru);
    expect(sesudah.header.sumberTemplate).toBe("TEMPLATE_PERIODE");
    // The captions are the ones it was closed with, so the reprint IS the
    // statement that was issued.
    expect(sesudah.baris.map((b) => b.nama)).toEqual(sebelumAdopsi.baris.map((b) => b.nama));
    expect(sesudah.baris.every((b) => !b.nama.endsWith(SUFIKS_BARU))).toBe(true);
    // NON-VACUOUS: the page carries money, so this is not a comparison of two
    // empty statements.
    expect(keSen(sesudah.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(sesudah.totalAsetTahunIni.nilai).toBe(HARAPAN.totalAset);
  });

  test("dan periode yang masih OPEN memang memakai template baru itu", async () => {
    // THE OTHER HALF, WITHOUT WHICH THE TEST ABOVE PASSES ON A READER THAT
    // IGNORES THE NEW TEMPLATE ENTIRELY. The adoption has to be real: a later
    // period, still open, must come out in the new shape.
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    await capPeriode(p, await templateAwal());
    const baru = await adopsiTemplateBaru(`${p.tahun}-01-01`);

    const berikutnya = d.periode(p.tahun, p.bulan + 1);
    expect((await d.bacaPeriode(berikutnya.id)).status).toBe("OPEN");
    const terbuka = await posisi(berikutnya);
    expect(terbuka.header.templateLaporanId).toBe(baru);
    expect(terbuka.header.sumberTemplate).toBe("TEMPLATE_BERLAKU");
    expect(terbuka.baris.every((b) => b.nama.endsWith(SUFIKS_BARU))).toBe(true);
    // Same figures, different layout: adopting a template is a presentation
    // change and never a restatement of the ledger.
    expect(keSen(terbuka.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(terbuka.totalAsetTahunIni.nilai).toBe(HARAPAN.totalAset);
  });
});

describe("periode OPEN tidak pernah membaca kolom itu", () => {
  test("cap yang tertinggal di periode OPEN diabaikan, bukan dipakai", async () => {
    // REOPEN CLEARS THE STAMP (modules/closing), so an OPEN period carrying one
    // is a stale value and never an instruction. Reading the STATUS rather than
    // the column being non-null is what makes a reopened period go back to the
    // effective-dated lookup by construction instead of by the writer's good
    // manners.
    const p = d.periodeLaporan();
    const lama = await templateAwal();
    const baru = await adopsiTemplateBaru(`${p.tahun}-01-01`);
    await capPeriode(p, lama);

    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    const l = await posisi(p);
    expect(l.header.templateLaporanId).toBe(baru);
    expect(l.header.sumberTemplate).toBe("TEMPLATE_BERLAKU");
    expect(l.baris.every((b) => b.nama.endsWith(SUFIKS_BARU))).toBe(true);
  });
});

describe("cadangan wajib kelihatan, bukan diam diam", () => {
  test("periode CLOSED tanpa cap memakai template berlaku DAN mengatakannya", async () => {
    // The legitimate null: a period closed before migrations/0028 added the
    // column, or closed when no template was in force. It is not a refusal, so
    // it is a state a reader will genuinely meet, and a fallback nobody can see
    // is indistinguishable from a reader that ignores the column.
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    await capPeriode(p, null);

    const l = await posisi(p);
    expect(l.header.sumberTemplate).toBe("TEMPLATE_BERLAKU");
    expect(l.header.templateLaporanId).toBe(await templateAwal());
    // The two provenance fields answer DIFFERENT questions and move
    // independently: the figures are frozen even though the layout was not.
    expect(l.header.sumberData).toBe("SNAPSHOT_PERIODE");
    expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
  });

  test("laporan tanpa template mengatakan TANPA_TEMPLATE, bukan menyebut yang tidak dipakainya", async () => {
    // Buku Besar and Neraca Lajur are per ACCOUNT: no `baris_laporan` row is
    // involved in what they show, so naming a template would be a claim about
    // reproducibility they do not make.
    const p = d.periodeLaporan();
    const neraca = await d.engine.neracaLajur(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const buku = await d.engine.bukuBesar(
      { periodeId: p.id, cabangId: d.cabangId, akunId: d.akun.kas.id },
      d.ctx.adminPusat,
    );
    for (const l of [neraca, buku]) {
      expect(l.header.sumberTemplate).toBe("TANPA_TEMPLATE");
      expect(l.header.templateLaporanId).toBeNull();
    }
  });
});

describe("cap yang menunjuk template yang sudah tidak ada", () => {
  test("ditolak, bukan diam diam kembali ke template yang berlaku hari ini", async () => {
    // The one state where falling back would be indistinguishable from working
    // correctly AND would reprint an issued statement in today's shape. Refusing
    // is loud and recoverable; the alternative is silent and is not.
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);

    const hilang = await d.db.query<{ id: string }>(
      `insert into template_laporan
         (bumn_id, kode, nama, berlaku_dari, aktif, created_by, updated_by)
       values ($1, $2, 'Template yang kemudian dihapus (fixture laporan)', '1900-01-01', false, $3, $3)
       returning id::text as id`,
      [d.bumnId, kunci("TPL"), d.userId.adminPusat],
    );
    await d.db.query(
      `update template_laporan set deleted_at = now(), deleted_by = $2 where id = $1`,
      [hilang[0].id, d.userId.adminPusat],
    );
    await capPeriode(p, hilang[0].id);

    const err = await tolakDengan(() => posisi(p), KODE_LAPORAN.TEMPLATE_LAPORAN_KOSONG);
    expect(JSON.stringify(err.detail ?? "")).toContain(hilang[0].id);
  });
});
