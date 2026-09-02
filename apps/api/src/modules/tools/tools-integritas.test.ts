// Spec 9.6, "Tools cek integritas", at the ENGINE surface.
//
// WHAT THIS FILE IS FOR, in one sentence: every check must be observed
// CATCHING a deliberately broken row, and must be observed agreeing with the
// seed's own implementation of the same invariant.
//
// A health check nobody has watched catch anything is a query somebody hopes
// is right. So `duniaRusak` breaks one invariant per check, by the smallest
// edit that produces it, and each test names the row it broke and the number
// the check must report. The two checks the shipped schema makes UNBREAKABLE
// are covered the only honest way: by asserting the database refuses the bad
// state, which is the claim "this check can never fire" made testable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { periksaIntegritas } from "../../seed/demo-dunia/periksa";
import type { Dunia } from "../../seed/demo-dunia/dunia";
import { PEMERIKSAAN_INTEGRITAS, ToolsError } from "./contract";
import {
  buatDuniaTools,
  keSen,
  rp,
  type AkadFixture,
  type DuniaTools,
} from "./test-support";

// --- the numbers every assertion below refers to ---------------------------
const POKOK_A1 = rp(12_000_000);
const POKOK_A2 = rp(7_500_000);
const POKOK_A3 = rp(5_000_000);
const POKOK_B1 = rp(9_000_000);

/** The sub ledger drops below the ledger by this, per akad. */
const DRIFT_A2 = rp(-1_250_000);
const DRIFT_B1 = rp(-400_000);
/** The akad principal is raised, leaving version 1's schedule short by this. */
const KEKURANGAN_JADWAL = rp(2_000_000);

const NILAI_DRAFT_RUSAK = rp(3_300_000);
const NILAI_DRAFT_DI_CLOSED = rp(1_100_000);
const NILAI_DIBALIK = rp(4_000_000);

/**
 * `periksaIntegritas` reads only `dunia.db` and `dunia.bumnId`. Calling it with
 * exactly those two is deliberate: it proves the seed's SQL and this module's
 * SQL are looking at the same database and reaching the same verdict, without
 * this file having to build the seed's whole demo world.
 */
function sebagaiDunia(d: DuniaTools): Dunia {
  return { db: d.db, bumnId: d.bumnId } as unknown as Dunia;
}

describe("tools: cek integritas pada dunia yang sehat", () => {
  let d: DuniaTools;

  beforeAll(async () => {
    d = await buatDuniaTools();
    const a1 = await d.buatAkad({ cabangId: d.cabangA.id, pokok: POKOK_A1 });
    await d.cairkan(a1);
    const b1 = await d.buatAkad({ cabangId: d.cabangB.id, pokok: POKOK_B1 });
    await d.cairkan(b1);
    // A posted journal AND its reversal, so the ADR 0010 predicate is exercised
    // rather than assumed: both stay in `v_ledger_baris` and cancel.
    await d.postingLaluReversal({ cabangId: d.cabangA.id, nilai: NILAI_DIBALIK });
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("setiap pemeriksaan lulus dan laporan menyatakan dunia sehat", async () => {
    const laporan = await d.engine.jalankanIntegritas({}, d.ctx.adminPusat);
    const gagal = laporan.hasil.filter((h) => !h.lulus);
    expect(gagal.map((h) => `${h.kode}: ${h.detail}`)).toEqual([]);
    expect(laporan.sehat).toBe(true);
    expect(laporan.hasil).toHaveLength(9);
    expect(laporan.hasil.every((h) => h.baris.length === 0)).toBe(true);
  });

  test("katalog menyebut dua pemeriksaan yang sudah dijaga constraint database", async () => {
    const katalog = await d.engine.katalogPemeriksaan(d.ctx.adminPusat);
    const dijaga = katalog.filter((k) => k.dijagaDatabase).map((k) => k.kode);
    expect(dijaga.sort()).toEqual([
      PEMERIKSAAN_INTEGRITAS.OUTSTANDING_POKOK_NEGATIF,
      PEMERIKSAAN_INTEGRITAS.SNAPSHOT_KOLEKTIBILITAS_GANDA,
    ]);
    // The ladder is entity-wide configuration, so a branch filter cannot narrow
    // it and the page has to be able to say so.
    const tangga = katalog.find(
      (k) => k.kode === PEMERIKSAAN_INTEGRITAS.TANGGA_KOLEKTIBILITAS,
    );
    expect(tangga?.terikatCabang).toBe(false);
  });

  /**
   * THE ANTI-DRIFT ASSERTION. `apps/api/src/seed/demo-dunia/periksa.ts` is the
   * other implementation of spec 9.6 in this repository and the demo seed fails
   * when one of its checks returns a non-zero count. If somebody renames or
   * reorders a check there and not here, the two pages stop being recognisably
   * the same check, and this fails.
   */
  test("delapan nama pemeriksaan sama persis dengan periksaIntegritas milik seed", async () => {
    const dariSeed = (await periksaIntegritas(sebagaiDunia(d))).map((p) => p.nama);
    const katalog = await d.engine.katalogPemeriksaan(d.ctx.adminPusat);
    expect(katalog.slice(0, dariSeed.length).map((k) => k.nama)).toEqual(dariSeed);
    // The ninth is the trial balance, which the seed keeps in
    // `periksaAkuntansi` rather than `periksaIntegritas` and states with a
    // POSTED-only predicate. This module reads `v_ledger_baris` instead
    // (ADR 0010), so its NAME differs on purpose, and the next test proves the
    // difference does not change the verdict.
    expect(katalog[8]?.kode).toBe(PEMERIKSAAN_INTEGRITAS.NERACA_SALDO_TIDAK_SEIMBANG);
    expect(katalog[8]?.sumber).toBe("v_ledger_baris");
  });

  /**
   * The one deliberate divergence from the seed, pinned. `v_ledger_baris`
   * includes the REVERSED original and its reversal; `status = 'POSTED'` alone
   * drops the original. Both must report a zero difference -- each journal
   * balances on its own -- while the TOTALS differ by exactly the reversed
   * pair, which is why this module shows the ledger and says so.
   */
  test("neraca saldo: v_ledger_baris dan predikat POSTED-only sepakat selisih nol", async () => {
    const laporan = await d.engine.jalankanIntegritas({}, d.ctx.adminPusat);
    const neraca = laporan.hasil.find(
      (h) => h.kode === PEMERIKSAAN_INTEGRITAS.NERACA_SALDO_TIDAK_SEIMBANG,
    );
    expect(neraca?.lulus).toBe(true);

    const ledger = await d.db.query<{ debit: string; kredit: string }>(
      `select coalesce(sum(l.debit), 0)::numeric(20,2)::text as debit,
              coalesce(sum(l.kredit), 0)::numeric(20,2)::text as kredit
         from v_ledger_baris l where l.bumn_id = $1`,
      [d.bumnId],
    );
    const posted = await d.db.query<{ debit: string; kredit: string }>(
      `select coalesce(sum(b.debit), 0)::numeric(20,2)::text as debit,
              coalesce(sum(b.kredit), 0)::numeric(20,2)::text as kredit
         from jurnal_baris b join jurnal j on j.id = b.jurnal_id
        where j.bumn_id = $1 and j.status = 'POSTED'
          and j.deleted_at is null and b.deleted_at is null`,
      [d.bumnId],
    );
    const selisih = (r: { debit: string; kredit: string } | undefined): bigint =>
      keSen(r?.debit ?? "0.00") - keSen(r?.kredit ?? "0.00");
    expect(selisih(ledger[0])).toBe(0n);
    expect(selisih(posted[0])).toBe(0n);
    // The reversed original is in one total and not the other, by exactly its
    // own value. That is the difference the header of ./contract.ts describes.
    expect(keSen(ledger[0]?.debit ?? "0.00") - keSen(posted[0]?.debit ?? "0.00")).toBe(
      keSen(NILAI_DIBALIK),
    );
  });

  test("peran tanpa tools.integritas ditolak, dan penolakannya berkode", async () => {
    // MAKER holds tools.import and neither of this module's codes.
    expect(d.ctx.maker.permissions).not.toContain("tools.integritas");
    const gagal = await d.engine
      .jalankanIntegritas({}, d.ctx.maker)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(gagal).toBeInstanceOf(ToolsError);
    expect((gagal as ToolsError).kode).toBe("TIDAK_BERWENANG");
  });
});

const JASA_TANPA_AKRUAL = "750000.00";

describe("tools: cek integritas menangkap baris yang sengaja dirusak", () => {
  let d: DuniaTools;
  let jurnalJasaKreditId: string;
  let akadA2: AkadFixture;
  let akadA3: AkadFixture;
  let akadB1: AkadFixture;
  let jurnalRusakId: string;
  let jurnalDraftDiClosedId: string;
  let rangeRusakId: string;

  beforeAll(async () => {
    d = await buatDuniaTools();

    const akadA1 = await d.buatAkad({ cabangId: d.cabangA.id, pokok: POKOK_A1 });
    await d.cairkan(akadA1);

    akadA2 = await d.buatAkad({ cabangId: d.cabangA.id, pokok: POKOK_A2 });
    await d.cairkan(akadA2);
    await d.rusakkanRekonsiliasi(akadA2, DRIFT_A2);

    akadB1 = await d.buatAkad({ cabangId: d.cabangB.id, pokok: POKOK_B1 });
    await d.cairkan(akadB1);
    await d.rusakkanRekonsiliasi(akadB1, DRIFT_B1);

    akadA3 = await d.buatAkad({ cabangId: d.cabangA.id, pokok: POKOK_A3 });
    await d.cairkan(akadA3);
    await d.rusakkanJadwal(akadA3, KEKURANGAN_JADWAL);

    jurnalRusakId = await d.buatJurnalDraft({
      cabangId: d.cabangA.id,
      nilai: NILAI_DRAFT_RUSAK,
      bulan: 3,
    });
    await d.rusakkanJurnal(jurnalRusakId);

    jurnalDraftDiClosedId = await d.buatJurnalDraft({
      cabangId: d.cabangA.id,
      nilai: NILAI_DRAFT_DI_CLOSED,
      bulan: 1,
    });
    rangeRusakId = await d.rusakkanTanggaKolektibilitas();
    jurnalJasaKreditId = await d.rusakkanPiutangJasaKredit({
      cabangId: d.cabangA.id,
      nilai: JASA_TANPA_AKRUAL,
      bulan: 3,
    });
    // Closed LAST, so every posting above lands in an OPEN period.
    await d.tutupPeriode(1);
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("v_integritas_jurnal menemukan jurnal DRAFT yang tinggal satu baris", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.JURNAL_TIDAK_BALANCE,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(false);
    expect(h.jumlah).toBe(1);
    expect(h.detail).toBe("1 baris");
    expect(h.baris).toHaveLength(1);
    expect(h.baris[0]?.id).toBe(jurnalRusakId);
    expect(h.baris[0]?.entitas).toBe("jurnal");
    expect(h.baris[0]?.fakta.jumlahBaris).toBe("1");
  });

  test("v_integritas_jadwal menemukan akad yang pokoknya dinaikkan", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.JADWAL_POKOK_TIDAK_COCOK,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(false);
    expect(h.jumlah).toBe(1);
    expect(h.detail).toBe("1 akad");
    expect(h.baris[0]?.id).toBe(akadA3.akadId);
    expect(h.baris[0]?.label).toBe(akadA3.noAkad);
    expect(h.baris[0]?.fakta.pokokPinjaman).toBe(rp(7_000_000));
    expect(h.baris[0]?.fakta.totalPokokJadwal).toBe(POKOK_A3);
    expect(h.baris[0]?.fakta.selisih).toBe(KEKURANGAN_JADWAL);
  });

  test("v_rekonsiliasi_piutang menemukan dua akad, dengan selisih per akad", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(false);
    expect(h.jumlah).toBe(2);
    expect(h.detail).toBe("2 akad selisih");
    const perAkad = new Map(h.baris.map((b) => [b.id, b.fakta.selisih]));
    expect(perAkad.get(akadA2.akadId)).toBe(DRIFT_A2);
    expect(perAkad.get(akadB1.akadId)).toBe(DRIFT_B1);
  });

  test("tangga kolektibilitas menemukan sambungan yang tidak nyambung", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.TANGGA_KOLEKTIBILITAS,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(false);
    expect(h.jumlah).toBe(1);
    expect(h.detail).toBe("1 sambungan salah");
    // The failing junction is the band whose `hari_max` is open ended and which
    // is nonetheless followed by another band: MACET 271..NULL, then the row
    // the fixture inserted at 5000.
    expect(h.baris[0]?.fakta.hariMin).toBe("271");
    expect(h.baris[0]?.fakta.hariMax).toBeNull();
    expect(h.baris[0]?.fakta.hariMinBerikutnya).toBe("5000");
    expect(h.baris[0]?.cabangId).toBeNull();
    expect(rangeRusakId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("jurnal DRAFT di periode CLOSED ditemukan dengan periodenya", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.JURNAL_DRAFT_DI_PERIODE_CLOSED,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(false);
    expect(h.jumlah).toBe(1);
    expect(h.detail).toBe("1 jurnal");
    expect(h.baris[0]?.id).toBe(jurnalDraftDiClosedId);
    expect(h.baris[0]?.fakta.periode).toBe(`${d.tahun}-01`);
    expect(h.baris[0]?.fakta.totalDebit).toBe(NILAI_DRAFT_DI_CLOSED);
  });

  /**
   * THE CHECK THE SHIPPED DEFECT WALKED PAST. A balanced, posted, entirely
   * legal journal drove an asset account to a credit balance. The trial
   * balance stays even, the sub ledger reconciles, `v_integritas_jurnal` is
   * empty: every other check in this catalogue reports green, which is exactly
   * what happened for twenty four months in the demo world (ADR 0018).
   */
  test("piutang jasa bersaldo kredit tertangkap, dan menyebut bulannya", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.PIUTANG_JASA_BERSALDO_KREDIT,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(false);
    // Every month end from the posting onward carries the credit balance, so
    // the check names each of them rather than only the latest: the operator
    // needs to know WHEN it started.
    expect(h.jumlah).toBeGreaterThan(0);
    expect(h.baris.every((b) => b.entitas === "periode")).toBe(true);
    // Cumulative, and nothing debits 1.1.04 in this world, so the balance is
    // exactly the amount posted, negated.
    expect(h.baris[0]?.fakta.saldo).toBe(`-${JASA_TANPA_AKRUAL}`);
    expect(h.baris[0]?.fakta.akun).toBe("1.1.04");
    expect(h.detail).toContain(h.baris[0]?.label ?? "");
    // The journal that caused it is an ordinary posted journal, which is the
    // point: no constraint could have refused it.
    expect(jurnalJasaKreditId).toBeTruthy();
  });

  test("laporan lengkap menandai dunia tidak sehat dan menyebut enam kegagalan", async () => {
    const laporan = await d.engine.jalankanIntegritas({}, d.ctx.adminPusat);
    expect(laporan.sehat).toBe(false);
    expect(laporan.hasil.filter((h) => !h.lulus).map((h) => h.kode).sort()).toEqual(
      [
        PEMERIKSAAN_INTEGRITAS.JADWAL_POKOK_TIDAK_COCOK,
        PEMERIKSAAN_INTEGRITAS.JURNAL_DRAFT_DI_PERIODE_CLOSED,
        PEMERIKSAAN_INTEGRITAS.JURNAL_TIDAK_BALANCE,
        PEMERIKSAAN_INTEGRITAS.PIUTANG_JASA_BERSALDO_KREDIT,
        PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
        PEMERIKSAAN_INTEGRITAS.TANGGA_KOLEKTIBILITAS,
      ].sort(),
    );
    // The three that stayed green: the two the schema makes unbreakable, and
    // the trial balance, which neither a reversal pair nor a balanced journal
    // posted to the wrong asset can unbalance. That last point is the whole
    // reason PIUTANG_JASA_BERSALDO_KREDIT exists.
    expect(laporan.hasil.filter((h) => h.lulus).map((h) => h.kode).sort()).toEqual(
      [
        PEMERIKSAAN_INTEGRITAS.NERACA_SALDO_TIDAK_SEIMBANG,
        PEMERIKSAAN_INTEGRITAS.OUTSTANDING_POKOK_NEGATIF,
        PEMERIKSAAN_INTEGRITAS.SNAPSHOT_KOLEKTIBILITAS_GANDA,
      ].sort(),
    );
  });

  /**
   * The seed's own checks, run over the SAME database, must reach the same
   * verdict on the same four invariants. This is what stops the two
   * implementations drifting into a state where each says the books are fine
   * for a different reason.
   *
   * Only the FAILING direction is asserted, and deliberately: `periksaIntegritas`
   * counts globally (it owns the whole database in a seed run), so another
   * fixture's leftovers could make a check fail there while this world is
   * clean. A failure caused by THIS world, however, must be visible to both.
   */
  test("periksaIntegritas milik seed setuju bahwa dunia ini rusak", async () => {
    const dariSeed = await periksaIntegritas(sebagaiDunia(d));
    const gagalDiSeed = new Set(dariSeed.filter((p) => !p.lulus).map((p) => p.nama));
    const katalog = await d.engine.katalogPemeriksaan(d.ctx.adminPusat);
    const namaUntuk = new Map(katalog.map((k) => [k.kode as string, k.nama]));
    for (const kode of [
      PEMERIKSAAN_INTEGRITAS.JURNAL_TIDAK_BALANCE,
      PEMERIKSAAN_INTEGRITAS.JADWAL_POKOK_TIDAK_COCOK,
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
      PEMERIKSAAN_INTEGRITAS.TANGGA_KOLEKTIBILITAS,
      PEMERIKSAAN_INTEGRITAS.JURNAL_DRAFT_DI_PERIODE_CLOSED,
    ]) {
      expect(gagalDiSeed.has(namaUntuk.get(kode) as string)).toBe(true);
    }
  });

  // --- the two checks the schema makes unbreakable ---------------------------

  test("outstanding negatif ditolak database, jadi pemeriksaannya memang selalu hijau", async () => {
    const pesan = await d.cobaOutstandingNegatif(akadA2);
    expect(pesan).toContain("pumk_akad_outstanding_pokok_check");
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.OUTSTANDING_POKOK_NEGATIF,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(true);
    expect(h.dijagaDatabase).toBe(true);
  });

  test("snapshot kolektibilitas ganda ditolak database, jadi pemeriksaannya selalu hijau", async () => {
    const pesan = await d.cobaSnapshotGanda(akadA2, 2);
    expect(pesan).toContain("kolektibilitas_snapshot_uq");
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.SNAPSHOT_KOLEKTIBILITAS_GANDA,
      {},
      d.ctx.adminPusat,
    );
    expect(h.lulus).toBe(true);
    expect(h.dijagaDatabase).toBe(true);
  });

  // --- branch scope (spec 2 rule 3, spec 16 scenario 24) ---------------------

  test("peran terikat cabang hanya melihat kerusakan di cabangnya sendiri", async () => {
    const a = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
      {},
      d.ctx.adminCabangA,
    );
    expect(a.jumlah).toBe(1);
    expect(a.baris.map((b) => b.id)).toEqual([akadA2.akadId]);

    const b = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
      {},
      d.ctx.adminCabangB,
    );
    expect(b.jumlah).toBe(1);
    expect(b.baris.map((x) => x.id)).toEqual([akadB1.akadId]);
  });

  test("cabang di luar scope DITOLAK, bukan dijawab dengan halaman kosong", async () => {
    const gagal = await d.engine
      .jalankanIntegritas({ cabangId: d.cabangB.id }, d.ctx.adminCabangA)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(gagal).toBeInstanceOf(ToolsError);
    expect((gagal as ToolsError).kode).toBe("CABANG_DILUAR_SCOPE");
  });

  test("admin pusat boleh memfilter satu cabang, dan filternya menyempitkan", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
      { cabangId: d.cabangB.id },
      d.ctx.adminPusat,
    );
    expect(h.jumlah).toBe(1);
    expect(h.baris.map((x) => x.id)).toEqual([akadB1.akadId]);
  });

  test("batasBaris memotong daftar dan laporannya mengatakan terpotong", async () => {
    const h = await d.engine.jalankanPemeriksaan(
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
      { batasBaris: 1 },
      d.ctx.adminPusat,
    );
    expect(h.jumlah).toBe(2);
    expect(h.baris).toHaveLength(1);
    expect(h.terpotong).toBe(true);
  });

  test("kode pemeriksaan yang tidak dikenal ditolak, bukan dianggap lulus", async () => {
    const gagal = await d.engine
      .jalankanPemeriksaan(
        "TIDAK_ADA_INI" as never,
        {},
        d.ctx.adminPusat,
      )
      .then(() => null)
      .catch((err: unknown) => err);
    expect(gagal).toBeInstanceOf(ToolsError);
    expect((gagal as ToolsError).kode).toBe("PEMERIKSAAN_TIDAK_DIKENAL");
  });
});
