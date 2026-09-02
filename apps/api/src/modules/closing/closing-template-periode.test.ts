// MIGRATIONS/0028 AND ADR 0017: A CLOSED PERIOD RECORDS THE TEMPLATE IT WAS
// CLOSED UNDER.
//
// WHY THIS FILE EXISTS. `template_laporan` is EFFECTIVE DATED over the period
// being reported on, so "which template is in force for January 2026" has
// exactly one answer, and that answer can CHANGE. A client adopting ISAK 335
// from 2027 backdates nothing and edits nothing, and yet, if a reprint resolved
// its template by effective date alone, every 2026 statement already issued
// would come back in the 2027 shape. That is the failure ADR 0017 names as
// having the widest blast radius and as the only one that would happen by
// accident.
//
// `periode.template_laporan_id` is what prevents it, and the column is only a
// promise until the closing engine writes it. So the tests below are about the
// WRITER, and they are deliberately blind to how a report later reads it:
// modules/laporan owns the reader, and pointing this file at a rendered
// statement would make the two changes one change and neither one releasable.
//
// WHAT IS ASSERTED, AND WHY EACH ONE IS A SEPARATE TEST.
//   1. the stamp is written at all, and it is the template in force;
//   2. it comes from the PERIOD'S END DATE, not from wall clock time, so a
//      January close executed in March is still a January statement;
//   3. adopting a new template AFTERWARDS does not move an already-closed
//      period's stamp, and the next period picks the new one up. That pair is
//      the whole point of the column: either half alone passes on an
//      implementation that is wrong in the other direction;
//   4. no template in force is a NULL stamp and NOT a refusal to close. Spec
//      8.4's checklist has ten items and this is not an eleventh;
//   5. reopening CLEARS the stamp, and a re-close re-resolves it.
//
// ON 5, WHICH WAS A CHOICE. A reopen already DELETES the frozen balances,
// because they are the product of a close that has been undone. The stamp is
// the same category of thing: the figures, and the shape they were presented
// in, are the two halves of one answer to "what was reported". Clearing it
// keeps that one rule instead of one rule with an exception, and stops an OPEN
// period from asserting a close that no longer exists. The fact is not lost:
// the reopen's audit record carries the old template in `nilai_lama_json`, and
// the last test here reads it out of `audit_log` to prove the decision is
// reversible in evidence rather than merely defensible in prose.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buatDunia, rp, type DuniaClosing, type PeriodeFixture } from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/** The BAWAAN template `seedCoaInti` gives every world (apps/api/src/seed/coa-inti.ts). */
async function templateBawaan(): Promise<{ id: string; kode: string }> {
  const rows = await d.db.query<{ id: string; kode: string }>(
    `select id::text as id, kode from template_laporan
      where bumn_id = $1 and deleted_at is null`,
    [d.bumnId],
  );
  if (rows.length !== 1) {
    throw new Error(
      `fixture: dunia closing seharusnya punya tepat satu template bawaan, ada ${rows.length}`,
    );
  }
  return rows[0]!;
}

/** `periode.template_laporan_id` as the database holds it. */
async function stempel(periodeId: string): Promise<string | null> {
  const rows = await d.db.query<{ id: string | null }>(
    `select template_laporan_id::text as id from periode where id = $1`,
    [periodeId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Adopts a NEW template from `dari`, closing the incumbent's range the day
 * before, IN ONE TRANSACTION.
 *
 * One transaction is not tidiness: TJSL-TPL-001 is a DEFERRABLE INITIALLY
 * DEFERRED constraint trigger, so the moment where the old open-ended range and
 * the new one overlap is legal until COMMIT and illegal after it. Doing it in
 * two statements outside a transaction is refused, which is the migration
 * working as designed.
 */
async function berlakukanTemplateBaru(kode: string, dari: string): Promise<string> {
  return d.db.transaction(async (tx) => {
    const sebelum = new Date(`${dari}T00:00:00.000Z`);
    sebelum.setUTCDate(sebelum.getUTCDate() - 1);
    await tx.query(
      `update template_laporan set berlaku_sampai = $2::date
        where bumn_id = $1 and berlaku_sampai is null and deleted_at is null`,
      [d.bumnId, sebelum.toISOString().slice(0, 10)],
    );
    const rows = await tx.query<{ id: string }>(
      `insert into template_laporan (bumn_id, kode, nama, dasar, berlaku_dari)
       values ($1, $2, $3, 'ISAK 335 (uji)', $4::date)
       returning id::text as id`,
      [d.bumnId, kode, `Template ${kode} (uji)`, dari],
    );
    return rows[0]!.id;
  });
}

/**
 * A period with all ten prerequisites satisfied, closable as it stands. Same
 * shape as `siapkan` in closing-periode.test.ts, and deliberately built through
 * the engines rather than with raw SQL: a period closed past a checklist
 * nothing satisfied would let this file assert a stamp on a close that could
 * not happen.
 */
async function siapkan(tahun: number, bulan: number): Promise<PeriodeFixture> {
  const p = d.periode(tahun, bulan);
  await d.tutupPeriodeSampai(p);
  d.setelJam(p.tanggalMulai);
  // Without funding the disbursement below drives cash negative, and check 8
  // becomes a warning every test here would have to confirm around.
  await d.postingAlokasiDana(p.tanggalMulai, rp(100_000_000));
  await d.buatAkad({
    hariTunggakan: null,
    padaTanggal: p.tanggalAkhir,
    tanggalPencairan: p.tanggalMulai,
  });
  d.setelJam(p.tanggalAkhir);
  await d.siapkanTutup(p);
  return p;
}

describe("tutupPeriode menulis template laporan yang dipakai (migrasi 0028)", () => {
  test("periode yang ditutup menyimpan template yang berlaku, bukan NULL", async () => {
    const bawaan = await templateBawaan();
    const p = await siapkan(2026, 1);
    expect(await stempel(p.id)).toBeNull();

    const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    // Both the row and the value the engine hands back, because a caller that
    // trusts the return value must not have to re-read the period to learn
    // what was recorded.
    expect(await stempel(p.id)).toBe(bawaan.id);
    expect(hasil.periode.templateLaporanId).toBe(bawaan.id);
  });

  test("stempel diambil dari tanggal akhir periode, bukan dari jam dinding", async () => {
    // Adopted from 2026-06-01. The January period is entirely before it, so the
    // template in force FOR JANUARY is still the incumbent, whatever month the
    // close is executed in.
    const bawaan = await templateBawaan();
    await berlakukanTemplateBaru("ISAK335", "2026-06-01");

    const p = await siapkan(2026, 1);
    // Close January while the clock reads August: a late close is the ordinary
    // case in a finance department, not an exotic one.
    d.setelJam("2026-08-20");

    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    expect(await stempel(p.id)).toBe(bawaan.id);
  });

  test("memberlakukan template baru tidak mengubah stempel periode yang sudah ditutup", async () => {
    const bawaan = await templateBawaan();
    const jan = await siapkan(2026, 1);
    await d.engine.tutupPeriode({ periodeId: jan.id }, d.ctx.approver);
    expect(await stempel(jan.id)).toBe(bawaan.id);

    // The adoption. Nothing about January is edited, and nothing about January
    // may move.
    const baru = await berlakukanTemplateBaru("ISAK335", "2026-02-01");

    expect(await stempel(jan.id)).toBe(bawaan.id);

    // ...and the other half, which is what makes the first half meaningful: the
    // NEXT period does pick the new template up. Without this, an engine that
    // simply never wrote the column would pass the assertion above.
    const feb = await siapkan(2026, 2);
    await d.engine.tutupPeriode({ periodeId: feb.id }, d.ctx.approver);

    expect(await stempel(feb.id)).toBe(baru);
    expect(await stempel(jan.id)).toBe(bawaan.id);
  });

  test("tanpa template yang berlaku, periode tetap bisa ditutup dan stempelnya NULL", async () => {
    // The template exists but only takes effect in 2027, so no template covers
    // January 2026. Closing must still succeed: whether a BUMN has configured a
    // presentation layout is not one of spec 8.4's ten prerequisites, and a
    // reprint of such a period falls back to the effective-dated lookup and
    // says that it did (ADR 0017).
    await d.db.query(
      `update template_laporan set berlaku_dari = '2027-01-01'::date
        where bumn_id = $1 and deleted_at is null`,
      [d.bumnId],
    );

    const p = await siapkan(2026, 1);
    const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    expect(hasil.periode.status).toBe("CLOSED");
    expect(hasil.periode.templateLaporanId).toBeNull();
    expect(await stempel(p.id)).toBeNull();
  });

  test("template nonaktif tidak dipakai sebagai stempel", async () => {
    // `aktif = false` is how a template is withdrawn without deleting the lines
    // a closed period may still need. It must not be stamped onto a NEW close,
    // for the same reason `templateBerlaku` in the reader excludes it.
    await d.db.query(
      `update template_laporan set aktif = false where bumn_id = $1 and deleted_at is null`,
      [d.bumnId],
    );

    const p = await siapkan(2026, 1);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    expect(await stempel(p.id)).toBeNull();
  });
});

describe("bukaKembaliPeriode menghapus stempel, dan menyimpannya di audit", () => {
  test("periode yang dibuka kembali tidak lagi mengaku ditutup di bawah template mana pun", async () => {
    const bawaan = await templateBawaan();
    const p = await siapkan(2026, 1);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    expect(await stempel(p.id)).toBe(bawaan.id);

    const dibuka = await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Koreksi jurnal Januari" },
      d.ctx.adminPusat,
    );

    // Same rule as the frozen balances, which the reopen also deletes: an OPEN
    // period holds nothing that a close produced.
    expect(dibuka.status).toBe("OPEN");
    expect(dibuka.templateLaporanId).toBeNull();
    expect(await stempel(p.id)).toBeNull();
  });

  test("audit reopen menyimpan template yang dipakai close yang dibatalkan", async () => {
    // What makes clearing the column a reversible decision rather than a lost
    // fact. Read out of `audit_log` itself, because the point is that the
    // ANSWER SURVIVES somewhere durable, not that the service happened to build
    // the right object.
    const bawaan = await templateBawaan();
    const p = await siapkan(2026, 1);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Koreksi jurnal Januari" },
      d.ctx.adminPusat,
    );

    const baris = await d.db.query<{ lama: string | null; baru: string | null }>(
      `select nilai_lama_json->>'templateLaporanId' as lama,
              nilai_baru_json->>'templateLaporanId' as baru
         from audit_log
        where aksi = 'periode.reopen' and entitas = 'periode' and entitas_id = $1
        order by id desc
        limit 1`,
      [p.id],
    );
    expect(baris).toHaveLength(1);
    expect(baris[0]!.lama).toBe(bawaan.id);
    expect(baris[0]!.baru).toBeNull();
  });

  test("menutup ulang setelah reopen mengambil template yang berlaku sekarang", async () => {
    // The half of the reopen decision that has to be TESTABLE rather than
    // merely defensible: because the stamp was cleared, a re-close re-resolves
    // it, so a template adopted while the period was open is picked up instead
    // of being masked by the previous close's stamp.
    const bawaan = await templateBawaan();
    const p = await siapkan(2026, 1);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    expect(await stempel(p.id)).toBe(bawaan.id);

    await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Adopsi standar baru, Januari disajikan ulang" },
      d.ctx.adminPusat,
    );

    // A restatement: the new template now covers January too.
    // No second `siapkanTutup`: a reopen deletes the frozen balances and
    // nothing else, so the kolektibilitas, penyisihan and akrual runs checks 4,
    // 5 and 6 look for are still there. Re-running them would be testing the
    // fixture, not the stamp.
    const baru = await berlakukanTemplateBaru("ISAK335", "2026-01-01");
    d.setelJam(p.tanggalAkhir);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    expect(await stempel(p.id)).toBe(baru);
  });
});
