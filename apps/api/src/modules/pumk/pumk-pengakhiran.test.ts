// SPEC 9.1 "Halaman pengakhiran dan hapus buku" and "Halaman pengaturan mitra
// bermasalah ... dengan catatan tindak lanjut penagihan".
//
// THREE KINDS OF ENDING, AND THEY ARE NOT VARIANTS OF EACH OTHER.
//
//   LUNAS_DIPERCEPAT      The mitra settled early. The money already moved
//                         through the allocation, so this records a fact and
//                         posts NOTHING. A journal here would double-count the
//                         repayment.
//   HAPUS_BUKU            SK-277/MBU/10/2023 penghapusbukuan: the receivable
//                         leaves the balance sheet, the RIGHT TO COLLECT
//                         SURVIVES on the extracomptable register. So the
//                         collection trail must keep working afterwards.
//   PENGHAPUSAN_BERSYARAT Penghapustagihan, a legally distinct act.
//                         docs/BUILD-PLAN.md decided DELIBERATELY that it gets
//                         NO event code: once a debt is written off it is
//                         already off the balance sheet, so extinguishing the
//                         claim moves no balance and is a MEMORANDUM event.
//                         This module must fail closed rather than borrow
//                         HAPUS_BUKU_PIUTANG, because two event codes producing
//                         identical journals is a reconciliation trap.
//
// THE ALLOWANCE SHORTFALL, AND WHY IT IS NOT OPTIONAL.
// Spec 6.4's HAPUS_BUKU_PIUTANG debits Penyisihan for the FULL outstanding.
// That is only correct when the allowance actually covers it, which is true
// only at a 100 percent Macet rate. Under the collective-impairment basis
// docs/REGULASI.md found to be in force, the allowance can be smaller, and the
// spec's journal as written would drive a CONTRA-ASSET account negative.
// docs/BUILD-PLAN.md "Keputusan sementara" decided the split:
//
//   consume the allowance first with HAPUS_BUKU_PIUTANG,
//   route ONLY the remainder through HAPUS_BUKU_KEKURANGAN_PENYISIHAN.
//
// The tests below assert THAT MECHANIC. They do not assert that any particular
// allowance rate is correct: that is the client's accounting team's decision
// and is recorded as an assumption, not as compliance.
//
// NOTE ON WHY THE ALLOWANCE IS POOLED. `BEBAN_PENYISIHAN` debits Beban and
// credits Penyisihan; neither leg is the receivable account, so the ledger
// engine REFUSES a mitra or akad dimension on it (spec 6.2.8,
// DIMENSI_PIUTANG_SALAH_AKUN). The allowance is therefore a portfolio balance,
// not a per-akad one, which is exactly the collective basis the regulation
// review described.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, PERMISSION_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  keSen,
  periksaRekonsiliasiNol,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  sen,
  tolakDengan,
  POKOK_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
  type ProposalFixture,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

const TOTAL_KEWAJIBAN = rp(12_360_000);
const TANGGAL_HAPUS_BUKU = "2026-06-10";

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  angsuran = porterAngsuranUji(d.db, jurnal, d.jam);
  engine = createPumkEngine({ db: d.db, angsuran, jurnal, jam: d.jam });
}, 60_000);

beforeEach(async () => {
  jurnal.reset();
  angsuran.reset();
  await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
  // THE ALLOWANCE IS A PORTFOLIO BALANCE, so one test's penyisihan is the next
  // test's starting balance and the allowance-shortfall cases would depend on
  // the order `bun test` happens to run them in. Reset it to zero through the
  // sanctioned ledger path (PEMULIHAN_PENYISIHAN, spec 6.4), never with a
  // DELETE: journals are immutable (invariant 4) and migrations/0020 refuses a
  // hand-written row anyway.
  await nolkanPenyisihan();
  jurnal.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** Balance of the allowance account, credit-normal, as the ledger holds it. */
async function saldoPenyisihan(): Promise<bigint> {
  const baris = await d.db.query<{ saldo: string }>(
    `select coalesce(sum(b.kredit - b.debit), 0)::numeric(20,2)::text as saldo
       from jurnal_baris b
       join jurnal j on j.id = b.jurnal_id
      where b.akun_id = $1 and j.status = 'POSTED'
        and j.bumn_id = $2 and j.deleted_at is null and b.deleted_at is null`,
    [d.akun.penyisihan.id, d.bumnId],
  );
  return keSen(baris[0].saldo);
}

/**
 * Brings the allowance back to exactly zero, through the real ledger engine.
 * Called before every test so each allowance case states its own precondition
 * instead of inheriting one.
 */
async function nolkanPenyisihan(): Promise<void> {
  const saldo = await saldoPenyisihan();
  if (saldo === 0n) return;
  if (saldo < 0n) throw new Error(`fixture: saldo penyisihan negatif (${saldo}), ini bug nyata`);
  await jurnal.postingEvent(
    "PEMULIHAN_PENYISIHAN",
    {
      cabangId: d.cabangId,
      tanggalTransaksi: "2026-05-31",
      nilai: sen(saldo),
      keterangan: "Reset penyisihan antar test (prasyarat uji)",
    },
    d.ctx.approver,
  );
  expect(await saldoPenyisihan()).toBe(0n);
}

/** Total credited to the receivable account for one akad, POSTED only. */
async function kreditPiutang(akadId: string): Promise<bigint> {
  const baris = await d.db.query<{ nilai: string }>(
    `select coalesce(sum(b.kredit), 0)::numeric(20,2)::text as nilai
       from jurnal_baris b
       join jurnal j on j.id = b.jurnal_id
      where b.akad_id = $1 and b.akun_id = $2 and j.status = 'POSTED'
        and j.deleted_at is null and b.deleted_at is null`,
    [akadId, d.akun.piutangPokok.id],
  );
  return keSen(baris[0].nilai);
}

// ---------------------------------------------------------------------------
// LUNAS_DIPERCEPAT
// ---------------------------------------------------------------------------

describe("pengakhiran LUNAS_DIPERCEPAT", () => {
  test("pelunasan dipercepat dicatat tanpa jurnal apa pun: uangnya sudah lewat alokasi", async () => {
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    // Settled in one payment, well before the final due date, through the REAL
    // allocation engine so the ledger really moved.
    await angsuran.alokasikanSetoran(
      { akadId, tanggal: "2026-05-10", jumlah: TOTAL_KEWAJIBAN, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    expect((await d.bacaAkad(akadId)).status).toBe("LUNAS");
    jurnal.reset();
    angsuran.reset();

    const hasil = await engine.catatPengakhiran(
      {
        akadId,
        jenis: "LUNAS_DIPERCEPAT",
        tanggal: "2026-05-11",
        dasarKeputusan: "Pelunasan dipercepat atas permintaan mitra",
      },
      d.ctx.approver,
    );

    expect(hasil.jenis).toBe("LUNAS_DIPERCEPAT");
    // The whole point: NO journal. Posting one here would credit the receivable
    // a second time and drive the ledger below the sub-ledger.
    expect(hasil.jurnalId).toBeNull();
    expect(jurnal.panggilan).toHaveLength(0);

    const baris = await d.bacaPengakhiran(akadId);
    expect(baris).toHaveLength(1);
    expect(baris[0].jenis).toBe("LUNAS_DIPERCEPAT");
    expect(baris[0].jurnal_id).toBeNull();
    // Frozen at decision time, so the record is reconstructable later even
    // though the akad columns are now zero.
    expect(baris[0].outstanding_pokok_saat_itu).toBe("0.00");
    expect(baris[0].outstanding_jasa_saat_itu).toBe("0.00");

    expect(hasil.akadSetelah.status).toBe("LUNAS");
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
  }, 60_000);

  test("akad yang masih punya outstanding tidak bisa diakhiri sebagai LUNAS_DIPERCEPAT", async () => {
    // "Lunas" is a fact about the balance, not a button. Recording it while
    // 12.000.000 is still owed would take a live receivable off the ageing.
    const f = await d.siapkanProposal("DICAIRKAN");
    await tolakDengan(
      () =>
        engine.catatPengakhiran(
          {
            akadId: f.akadId as string,
            jenis: "LUNAS_DIPERCEPAT",
            tanggal: "2026-05-11",
            dasarKeputusan: "Belum lunas sebenarnya",
          },
          d.ctx.approver,
        ),
      KODE_PUMK.AKAD_TIDAK_BISA_DIAKHIRI,
    );
    expect(await d.bacaPengakhiran(f.akadId as string)).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// HAPUS_BUKU
// ---------------------------------------------------------------------------

describe("hapus buku (SK-277/MBU/10/2023)", () => {
  test("penyisihan mencukupi: satu jurnal HAPUS_BUKU_PIUTANG sebesar outstanding", async () => {
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;

    // Build an allowance big enough to absorb the whole write-off, through the
    // real ledger engine. No akad dimension: the allowance is a portfolio
    // balance (see the file header).
    await jurnal.postingEvent(
      "BEBAN_PENYISIHAN",
      {
        cabangId: f.cabangId,
        tanggalTransaksi: "2026-05-31",
        nilai: rp(15_000_000),
        keterangan: "Pembentukan penyisihan (prasyarat uji)",
      },
      d.ctx.approver,
    );
    expect(await saldoPenyisihan()).toBe(keSen(rp(15_000_000)));
    jurnal.reset();

    const hasil = await engine.catatPengakhiran(
      {
        akadId,
        jenis: "HAPUS_BUKU",
        tanggal: TANGGAL_HAPUS_BUKU,
        dasarKeputusan: "Macet lebih dari 12 bulan, mitra tidak ditemukan",
        noSk: "SK-HB-2026-001",
      },
      d.ctx.approver,
    );

    // One event, for the whole outstanding, because the allowance covers it.
    expect(jurnal.panggilan).toHaveLength(1);
    expect(jurnal.panggilan[0].eventCode).toBe("HAPUS_BUKU_PIUTANG");
    expect(jurnal.panggilan[0].nilai).toBe(POKOK_BAKU);
    expect(jurnal.panggilan[0].akadId).toBe(akadId);
    expect(jurnal.panggilan[0].mitraId).toBe(f.mitraId);

    const baris = await d.bacaPengakhiran(akadId);
    expect(baris).toHaveLength(1);
    expect(baris[0].jenis).toBe("HAPUS_BUKU");
    expect(baris[0].no_sk).toBe("SK-HB-2026-001");
    expect(baris[0].approved_by).toBe(d.userId.approver);
    // Frozen at decision time, before the akad columns were zeroed.
    expect(baris[0].outstanding_pokok_saat_itu).toBe(POKOK_BAKU);
    expect(baris[0].jurnal_id).toBe(hasil.jurnalId);

    const akad = await d.bacaAkad(akadId);
    expect(akad.status).toBe("HAPUS_BUKU");
    expect(akad.outstanding_pokok).toBe("0.00");
    // Out of the active book: it must stop counting as a receivable in the
    // ageing, the penyisihan basis and the reconciliation list.
    expect(await d.dihitungSebagaiPiutangAktif(akadId)).toBe(false);

    // Sub-ledger and ledger both fall to zero TOGETHER. The pencairan debited
    // 12.000.000 and the write-off credited exactly that back.
    expect(await kreditPiutang(akadId)).toBe(keSen(POKOK_BAKU));
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
    // The allowance was consumed, not driven negative.
    expect(await saldoPenyisihan()).toBe(keSen(rp(3_000_000)));
  }, 60_000);

  test("penyisihan KURANG: sisanya lewat HAPUS_BUKU_KEKURANGAN_PENYISIHAN, akun kontra tidak negatif", async () => {
    // docs/BUILD-PLAN.md "Keputusan sementara", row 1. This is the case spec
    // 6.4 does not cover and the one that actually happens under a collective
    // allowance basis.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;

    // Only 5.000.000 of allowance against a 12.000.000 write-off.
    await jurnal.postingEvent(
      "BEBAN_PENYISIHAN",
      {
        cabangId: f.cabangId,
        tanggalTransaksi: "2026-05-31",
        nilai: rp(5_000_000),
        keterangan: "Penyisihan kolektif (prasyarat uji)",
      },
      d.ctx.approver,
    );
    jurnal.reset();

    await engine.catatPengakhiran(
      {
        akadId,
        jenis: "HAPUS_BUKU",
        tanggal: TANGGAL_HAPUS_BUKU,
        dasarKeputusan: "Macet, penyisihan tidak menutup seluruh outstanding",
        noSk: "SK-HB-2026-002",
      },
      d.ctx.approver,
    );

    // TWO events, in the decided order: consume the allowance first, expense
    // the remainder to the current period.
    expect(jurnal.panggilan.map((p) => p.eventCode)).toEqual([
      "HAPUS_BUKU_PIUTANG",
      "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
    ]);
    expect(jurnal.panggilan[0].nilai).toBe(rp(5_000_000));
    expect(jurnal.panggilan[1].nilai).toBe(rp(7_000_000));
    // Both legs carry the akad, so both reduce the SAME sub-ledger balance.
    for (const p of jurnal.panggilan) {
      expect(p.akadId).toBe(akadId);
      expect(p.mitraId).toBe(f.mitraId);
    }

    // THE INVARIANT THE SPLIT EXISTS FOR: the contra-asset lands exactly on
    // zero, never below it.
    expect(await saldoPenyisihan()).toBe(0n);

    // And the receivable is fully relieved: 5.000.000 + 7.000.000 = 12.000.000.
    expect(await kreditPiutang(akadId)).toBe(keSen(POKOK_BAKU));
    expect((await d.bacaAkad(akadId)).outstanding_pokok).toBe("0.00");
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
  }, 60_000);

  test("penyisihan NOL: seluruh hapus buku lewat jalur kekurangan, tanpa jurnal bernilai nol", async () => {
    // The degenerate end of the same rule. A HAPUS_BUKU_PIUTANG of 0.00 would
    // be refused by the ledger anyway (a journal line must have a value), so
    // "consume the allowance first" has to mean "consume what there is".
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    expect(await saldoPenyisihan()).toBe(0n);

    await engine.catatPengakhiran(
      {
        akadId,
        jenis: "HAPUS_BUKU",
        tanggal: TANGGAL_HAPUS_BUKU,
        dasarKeputusan: "Macet, belum ada penyisihan terbentuk",
        noSk: "SK-HB-2026-003",
      },
      d.ctx.approver,
    );

    expect(jurnal.panggilan.map((p) => p.eventCode)).toEqual([
      "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
    ]);
    expect(jurnal.panggilan[0].nilai).toBe(POKOK_BAKU);
    expect(await saldoPenyisihan()).toBe(0n);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
  }, 30_000);

  test("hapus buku kedua atas akad yang sama ditolak dengan PENGAKHIRAN_SUDAH_ADA", async () => {
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    await engine.catatPengakhiran(
      {
        akadId,
        jenis: "HAPUS_BUKU",
        tanggal: TANGGAL_HAPUS_BUKU,
        dasarKeputusan: "Macet",
        noSk: "SK-HB-2026-004",
      },
      d.ctx.approver,
    );
    jurnal.reset();

    await tolakDengan(
      () =>
        engine.catatPengakhiran(
          {
            akadId,
            jenis: "HAPUS_BUKU",
            tanggal: TANGGAL_HAPUS_BUKU,
            dasarKeputusan: "Macet lagi",
            noSk: "SK-HB-2026-005",
          },
          d.ctx.approver,
        ),
      KODE_PUMK.PENGAKHIRAN_SUDAH_ADA,
    );
    // A second write-off would credit the receivable below zero and put the
    // reconciliation permanently in deficit.
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaPengakhiran(akadId)).toHaveLength(1);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
  }, 60_000);

  test("akad yang belum cair tidak bisa dihapus buku", async () => {
    const f = await d.siapkanProposal("JADWAL_SIAP");
    await tolakDengan(
      () =>
        engine.catatPengakhiran(
          {
            akadId: f.akadId as string,
            jenis: "HAPUS_BUKU",
            tanggal: TANGGAL_HAPUS_BUKU,
            dasarKeputusan: "Belum cair",
          },
          d.ctx.approver,
        ),
      KODE_PUMK.AKAD_TIDAK_BISA_DIAKHIRI,
    );
    expect(jurnal.panggilan).toHaveLength(0);
  });

  test("dasar keputusan wajib: hapus buku tanpa alasan ditolak", async () => {
    // `pumk_pengakhiran.dasar_keputusan` is nullable in the schema, which makes
    // this the module's job. A write-off with no stated basis is the one record
    // an auditor will always ask for.
    const f = await d.siapkanProposal("DICAIRKAN");
    for (const kosong of ["", "   "]) {
      await tolakDengan(
        () =>
          engine.catatPengakhiran(
            {
              akadId: f.akadId as string,
              jenis: "HAPUS_BUKU",
              tanggal: TANGGAL_HAPUS_BUKU,
              dasarKeputusan: kosong,
              noSk: "SK-HB-2026-006",
            },
            d.ctx.approver,
          ),
        KODE_PUMK.CATATAN_WAJIB,
      );
    }
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// PENGHAPUSAN_BERSYARAT: fail closed, on purpose
// ---------------------------------------------------------------------------

describe("penghapustagihan sengaja tidak punya kode event", () => {
  test("PENGHAPUSAN_BERSYARAT ditolak dengan EVENT_MAPPING_BELUM_ADA dan tidak memposting apa pun", async () => {
    // docs/BUILD-PLAN.md, verbatim in substance: penghapusbukuan already took
    // the receivable off the balance sheet while the right to collect survived
    // on the extracomptable register, so extinguishing that right later shifts
    // no balance. It is a MEMORANDUM event, not a journal.
    //
    // The failure mode this test prevents is specific and tempting: reusing
    // HAPUS_BUKU_PIUTANG "because it is close enough". That merges two events
    // which differ in WHETHER THE DEBT STILL EXISTS, and no reconciliation can
    // separate them afterwards. Refuse until the owner decides how a
    // memorandum register is modelled.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;

    await tolakDengan(
      () =>
        engine.catatPengakhiran(
          {
            akadId,
            jenis: "PENGHAPUSAN_BERSYARAT",
            tanggal: TANGGAL_HAPUS_BUKU,
            dasarKeputusan: "Hak tagih dihapuskan sesuai SK",
            noSk: "SK-HT-2026-001",
          },
          d.ctx.approver,
        ),
      KODE_PUMK.EVENT_MAPPING_BELUM_ADA,
    );

    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaPengakhiran(akadId)).toHaveLength(0);
    // The akad is untouched, which is the correct outcome: nothing has been
    // decided, so nothing has changed.
    expect((await d.bacaAkad(akadId)).status).toBe("AKTIF");
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), POKOK_BAKU);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The collection trail
// ---------------------------------------------------------------------------

describe("tindak lanjut penagihan (spec 9.1 mitra bermasalah)", () => {
  async function akadBermasalah(): Promise<ProposalFixture> {
    return d.siapkanProposal("DICAIRKAN");
  }

  test("empat jenis tindak lanjut tercatat dengan petugas, hasil dan catatan", async () => {
    const f = await akadBermasalah();
    const akadId = f.akadId as string;
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.PENAGIHAN);

    const rencana = [
      { tanggal: "2026-06-01", jenis: "TELEPON" as const, hasil: "Tidak diangkat" },
      { tanggal: "2026-06-05", jenis: "KUNJUNGAN" as const, hasil: "Mitra berjanji bayar" },
      { tanggal: "2026-06-15", jenis: "SURAT_PERINGATAN" as const, hasil: "SP-1 diterima" },
      { tanggal: "2026-06-30", jenis: "SOMASI" as const, hasil: "Somasi dikirim" },
    ];
    for (const r of rencana) {
      const hasil = await engine.catatTindakLanjut(
        {
          akadId,
          tanggal: r.tanggal,
          jenis: r.jenis,
          hasil: r.hasil,
          petugasKaryawanId: d.karyawanId,
          catatan: `Catatan ${r.jenis}`,
        },
        d.ctx.maker,
      );
      expect(hasil.jenis).toBe(r.jenis);
      expect(hasil.akadId).toBe(akadId);
    }

    // The trail is a chronology: the escalation from a phone call to a somasi
    // is the evidence a write-off later depends on, so ORDER is the point.
    const daftar = await engine.daftarTindakLanjut(akadId, d.ctx.maker);
    expect(daftar.map((t) => t.jenis)).toEqual([
      "TELEPON",
      "KUNJUNGAN",
      "SURAT_PERINGATAN",
      "SOMASI",
    ]);
    expect(daftar.map((t) => t.tanggal)).toEqual(rencana.map((r) => r.tanggal));
    expect(daftar[1].hasil).toBe("Mitra berjanji bayar");
    expect(daftar[1].petugasKaryawanId).toBe(d.karyawanId);
    expect(daftar[3].catatan).toBe("Catatan SOMASI");

    const baris = await d.bacaTindakLanjut(akadId);
    expect(baris).toHaveLength(4);
  }, 60_000);

  test("jejak penagihan TETAP BISA ditambah setelah hapus buku (hak tagih belum hapus)", async () => {
    // The distinction that makes penghapusbukuan and penghapustagihan two
    // different acts. If the trail closed at write-off, the system would be
    // asserting the claim was extinguished, which SK-277/MBU/10/2023 says it
    // was not, and any later recovery (PENERIMAAN_HAPUS_BUKU) would have no
    // supporting record.
    const f = await akadBermasalah();
    const akadId = f.akadId as string;
    await engine.catatPengakhiran(
      {
        akadId,
        jenis: "HAPUS_BUKU",
        tanggal: TANGGAL_HAPUS_BUKU,
        dasarKeputusan: "Macet",
        noSk: "SK-HB-2026-007",
      },
      d.ctx.approver,
    );

    const hasil = await engine.catatTindakLanjut(
      {
        akadId,
        tanggal: "2026-07-01",
        jenis: "KUNJUNGAN",
        hasil: "Penagihan ekstrakomtabel, mitra mulai mencicil",
        petugasKaryawanId: d.karyawanId,
      },
      d.ctx.maker,
    );
    expect(hasil.tanggal).toBe("2026-07-01");
    expect(await d.bacaTindakLanjut(akadId)).toHaveLength(1);
  }, 60_000);

  test("Checker dan Auditor tidak bisa menulis jejak penagihan", async () => {
    const f = await akadBermasalah();
    for (const ctx of [d.ctx.checker, d.ctx.auditor]) {
      expect(ctx.permissions).not.toContain(PERMISSION_PUMK.PENAGIHAN);
      await tolakDengan(
        () =>
          engine.catatTindakLanjut(
            { akadId: f.akadId as string, tanggal: "2026-06-01", jenis: "TELEPON" },
            ctx,
          ),
        KODE_PUMK.TIDAK_BERWENANG,
      );
    }
    expect(await d.bacaTindakLanjut(f.akadId as string)).toHaveLength(0);
  }, 30_000);

  test("jejak penagihan akad cabang lain tidak bisa dibaca atau ditulis dari cabang ini", async () => {
    const b = await d.siapkanProposal("DICAIRKAN", {
      cabangId: d.cabangLainId,
      makerUserId: d.userId.makerLain,
    });
    await tolakDengan(
      () =>
        engine.catatTindakLanjut(
          { akadId: b.akadId as string, tanggal: "2026-06-01", jenis: "TELEPON" },
          d.ctx.maker,
        ),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
    await tolakDengan(
      () => engine.daftarTindakLanjut(b.akadId as string, d.ctx.maker),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
  }, 30_000);
});
