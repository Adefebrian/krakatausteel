// SPEC 9.1 "Form pencairan", scenario 4 and 5, and the reconciliation the spec
// calls the most important check in the system.
//
//   scenario 4  "input pencairan"
//   scenario 5  "Buka Buku Besar, konfirmasi jurnal pencairan muncul dengan
//                akun yang benar"
//   scenario 19 "konfirmasi sub ledger piutang cocok dengan buku besar,
//                selisih nol"  (spec 8.4 check 10)
//
// WHAT MAKES THIS THE HIGHEST-VALUE FILE IN THE FOLDER.
// The disbursement is the moment a receivable comes into existence in TWO
// places at once: `pumk_akad.outstanding_pokok` (the sub-ledger) and the
// Piutang account in the general ledger. Every later report, the penyisihan,
// the kolektibilitas closing and the period close all assume those two agree.
// They can only drift apart HERE, and they drift silently: a disbursement that
// wrote the akad but not the journal looks perfect on the akad screen and is
// only visible in `v_rekonsiliasi_piutang`, which is exactly why spec 8.4 makes
// it check 10 and why closing is blocked on it.
//
// SO THE ASSERTION IS THE VIEW, NOT A RECOMPUTATION. `d.rekonsiliasi` reads
// the SHIPPED `v_rekonsiliasi_piutang`. A test that recomputed the balance
// with its own query would only prove the test agrees with itself.
//
// AND THE JOURNAL IS WRITTEN BY THE REAL LEDGER ENGINE. `porterJurnalUji`
// records the call and delegates; it never answers in the engine's place. That
// matters concretely here: `pumk_pencairan.jurnal_id` carries a real
// non-deferrable foreign key, so a double returning a synthetic uuid would
// raise 23503 and roll the whole disbursement back in production while every
// test stayed green. modules/angsuran/test-support.ts records that exact
// incident.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  jumlahUang,
  periksaRekonsiliasiNol,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  JASA_BAKU,
  POKOK_BAKU,
  TANGGAL_AKAD_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  angsuran = porterAngsuranUji(d.db, jurnal, d.jam);
  engine = createPumkEngine({ db: d.db, angsuran, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
  angsuran.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** The account pair `event_jurnal_mapping` names for PENCAIRAN_PUMK, read from
 *  the database rather than typed here. ADR 0004: the mapping is DATA, so a
 *  test that hardcoded "1.1.03" would stop being a test of the mapping and
 *  start being a second, silently diverging copy of it. */
async function akunPencairan(): Promise<{ debit: string; kredit: string | null }> {
  const baris = await d.db.query<{ debit: string; kredit: string | null }>(
    `select m.akun_debit_id::text as debit, m.akun_kredit_id::text as kredit
       from event_jurnal_mapping m
      where m.bumn_id = $1 and m.event_code = 'PENCAIRAN_PUMK'
        and m.aktif and m.deleted_at is null`,
    [d.bumnId],
  );
  expect(baris).toHaveLength(1);
  return baris[0];
}

// ---------------------------------------------------------------------------
// The happy path, end to end
// ---------------------------------------------------------------------------

describe("pencairan (spec 9.1, skenario 4 dan 5)", () => {
  test("pencairan mengubah akad jadi AKTIF dengan outstanding sebesar pokok yang dicairkan", async () => {
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const akadId = f.akadId as string;

    const hasil = await engine.catatPencairan(
      {
        akadId,
        tanggalPencairan: TANGGAL_AKAD_BAKU,
        jumlah: POKOK_BAKU,
        akunKasId: d.akun.kas.id,
        noBukti: "BKK-2026-02-0001",
        keterangan: "Pencairan PUMK",
      },
      d.ctx.maker,
    );

    expect(hasil.jumlah).toBe(POKOK_BAKU);
    expect(hasil.akad.status).toBe("AKTIF");
    expect(hasil.proposal.status).toBe("DICAIRKAN");
    // A disbursement without a journal is not a disbursement.
    expect(hasil.jurnalId).toBeTruthy();

    const akad = await d.bacaAkad(akadId);
    expect(akad.status).toBe("AKTIF");
    // THE SUB-LEDGER RECEIVABLE EQUALS THE DISBURSED PRINCIPAL.
    expect(akad.outstanding_pokok).toBe(POKOK_BAKU);
    // And the jasa side equals the schedule's total jasa, so the two
    // outstanding columns describe the same schedule.
    const jadwal = await d.bacaJadwal(akadId);
    expect(akad.outstanding_jasa).toBe(jumlahUang(...jadwal.map((b) => b.jasa_adm)));
    expect(akad.outstanding_jasa).toBe(JASA_BAKU);

    const pencairan = await d.bacaPencairan(akadId);
    expect(pencairan).toHaveLength(1);
    expect(pencairan[0].jumlah).toBe(POKOK_BAKU);
    expect(pencairan[0].tanggal_pencairan).toBe(TANGGAL_AKAD_BAKU);
    expect(pencairan[0].akun_kas_id).toBe(d.akun.kas.id);
    expect(pencairan[0].no_bukti).toBe("BKK-2026-02-0001");
    expect(pencairan[0].created_by).toBe(d.userId.maker);
    // The FK is real and non-deferrable: this id had to come from the engine.
    expect(pencairan[0].jurnal_id).toBe(hasil.jurnalId);

    // Spec 4.3: the mitra stops being a CALON at disbursement.
    expect((await d.bacaMitra(f.mitraId)).status).toBe("AKTIF");
  }, 30_000);

  test("SATU jurnal PENCAIRAN_PUMK, dengan akun dari event_jurnal_mapping dan dimensi sub ledger", async () => {
    // Scenario 5. Invariant 11 and ADR 0004: this module names NO account pair
    // of its own; it names an EVENT, and the mapping row decides the accounts.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const akadId = f.akadId as string;
    const hasil = await engine.catatPencairan(
      { akadId, tanggalPencairan: TANGGAL_AKAD_BAKU, jumlah: POKOK_BAKU, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    // ONE business act, ONE journal. Three journals here would be three rows in
    // the buku besar for one disbursement.
    expect(jurnal.panggilan).toHaveLength(1);
    expect(jurnal.panggilan[0].eventCode).toBe("PENCAIRAN_PUMK");
    expect(jurnal.panggilan[0].nilai).toBe(POKOK_BAKU);
    expect(jurnal.panggilan[0].cabangId).toBe(f.cabangId);
    expect(jurnal.panggilan[0].tanggalTransaksi).toBe(TANGGAL_AKAD_BAKU);
    // The sub-ledger dimensions the reconciliation view joins on. Without
    // `akadId` on the line, `v_rekonsiliasi_piutang` cannot attribute the
    // balance to an akad at all and every akad reads as a difference.
    expect(jurnal.panggilan[0].mitraId).toBe(f.mitraId);
    expect(jurnal.panggilan[0].akadId).toBe(akadId);
    expect(jurnal.panggilan[0].referensiTipe).toBe("pumk_pencairan");

    const header = await d.bacaJurnal(hasil.jurnalId);
    expect(header.status).toBe("POSTED");
    expect(header.total_debit).toBe(POKOK_BAKU);
    expect(header.total_kredit).toBe(POKOK_BAKU);
    expect(header.tanggal_transaksi).toBe(TANGGAL_AKAD_BAKU);
    // migrations/0020: only the engine's path may stamp ENGINE.
    expect(header.jalur_posting).toBe("ENGINE");

    const baris = await d.bacaBarisJurnal(hasil.jurnalId);
    expect(baris).toHaveLength(2);
    const map = await akunPencairan();
    const debit = baris.find((b) => b.debit !== "0.00");
    const kredit = baris.find((b) => b.kredit !== "0.00");
    expect(debit?.akun_id).toBe(map.debit);
    expect(debit?.debit).toBe(POKOK_BAKU);
    expect(kredit?.akun_id).toBe(d.akun.kas.id);
    expect(kredit?.kredit).toBe(POKOK_BAKU);
    // Piutang is a sub-ledger account, so its line carries the mitra and the
    // akad. This is the join `v_rekonsiliasi_piutang` depends on.
    expect(debit?.mitra_id).toBe(f.mitraId);
    expect(debit?.akad_id).toBe(akadId);
  }, 30_000);

  test("akun kas dari form dipakai sebagai kaki kredit, menggantikan kas default pemetaan", async () => {
    // The mapping binds the cash leg to 1.1.01 and the form overrides it per
    // posting. A disbursement paid out of Bank that posts to Kas makes the cash
    // reconciliation wrong in two accounts at once.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const hasil = await engine.catatPencairan(
      {
        akadId: f.akadId as string,
        tanggalPencairan: TANGGAL_AKAD_BAKU,
        jumlah: POKOK_BAKU,
        akunKasId: d.akun.bank.id,
      },
      d.ctx.maker,
    );
    const baris = await d.bacaBarisJurnal(hasil.jurnalId);
    const kredit = baris.find((b) => b.kredit !== "0.00");
    expect(kredit?.akun_id).toBe(d.akun.bank.id);
    expect(kredit?.akun_kode).toBe(d.akun.bank.kode);
  }, 30_000);

  test("SELISIH REKONSILIASI NOL setelah pencairan (spec 8.4 pemeriksaan 10, skenario 19)", async () => {
    // The single most important assertion in this module. Read from the SHIPPED
    // view, not recomputed.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const akadId = f.akadId as string;
    await engine.catatPencairan(
      { akadId, tanggalPencairan: TANGGAL_AKAD_BAKU, jumlah: POKOK_BAKU, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    const r = await d.rekonsiliasi(akadId);
    periksaRekonsiliasiNol(r, POKOK_BAKU);
    // sub-ledger == general ledger == the amount actually disbursed. All three,
    // so a test cannot pass by having two wrong numbers agree.
    expect(r.saldoSubLedger).toBe(POKOK_BAKU);
    expect(r.saldoBukuBesar).toBe(POKOK_BAKU);

    // And nothing ELSE in this world drifted either: a disbursement that fixed
    // its own akad by disturbing another would still be a defect.
    expect(await d.akadTidakRekonsiliasi()).toHaveLength(0);
  }, 30_000);

  test("beberapa pencairan di dunia yang sama tetap rekonsiliasi nol satu per satu", async () => {
    // Each akad has its OWN mitra (one live loan per mitra), and each must
    // reconcile independently. An engine that posted without the akad dimension
    // would pool every balance onto one akad and this is where that shows.
    const akadIds: string[] = [];
    for (const pokok of [rp(6_000_000), rp(9_000_000), POKOK_BAKU]) {
      const f = await d.siapkanProposal("JADWAL_SIAP", {
        jumlahDiajukan: pokok,
        plafonDisetujui: pokok,
      });
      await engine.catatPencairan(
        {
          akadId: f.akadId as string,
          tanggalPencairan: TANGGAL_AKAD_BAKU,
          jumlah: pokok,
          akunKasId: d.akun.kas.id,
        },
        d.ctx.maker,
      );
      akadIds.push(f.akadId as string);
      periksaRekonsiliasiNol(await d.rekonsiliasi(f.akadId as string), pokok);
    }
    expect(akadIds).toHaveLength(3);
    expect(await d.akadTidakRekonsiliasi()).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe("pencairan bersifat semua atau tidak sama sekali", () => {
  test("jurnal gagal membatalkan pencairan, akad, dan status proposal sekaligus", async () => {
    // The reason `PumkDbPort.transaction` is not optional. Half of this on disk
    // is a receivable with no ledger entry, i.e. exactly the drift
    // `v_rekonsiliasi_piutang` exists to detect, created by the very code that
    // is supposed to keep the two in step.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const akadId = f.akadId as string;
    jurnal.gagalkan();

    const err = await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: POKOK_BAKU,
            akunKasId: d.akun.kas.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.JURNAL_GAGAL,
    );
    // The armed message is shaped like a raw balance-trigger string. It must
    // stay in `penyebabDb` and out of the user-facing message.
    expect(err.message).not.toContain("TJSL-JRN-031");
    expect(err.penyebabDb ?? "").toContain("TJSL-JRN-031");

    expect(await d.bacaPencairan(akadId)).toHaveLength(0);
    const akad = await d.bacaAkad(akadId);
    expect(akad.status).toBe("BELUM_CAIR");
    expect(akad.outstanding_pokok).toBe("0.00");
    expect((await d.bacaProposal(f.proposalId)).status).toBe("JADWAL_SIAP");
    expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    // Nothing is outstanding and nothing is posted, so the akad reconciles at
    // zero rather than being left mid-flight.
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), "0.00");
  }, 30_000);

  test("pencairan kedua atas akad yang sama ditolak dengan PENCAIRAN_SUDAH_ADA", async () => {
    // A retried request or a double click. Two disbursements would double the
    // ledger balance while the sub-ledger stayed put, which the view would then
    // report as a difference on a loan nobody touched twice.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: POKOK_BAKU,
            akunKasId: d.akun.kas.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.STATUS_TERMINAL,
    );
    expect(jurnal.panggilan).toHaveLength(0);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), POKOK_BAKU);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("penolakan pencairan", () => {
  test("nilai pencairan yang tidak sama dengan pokok akad ditolak", async () => {
    // The akad, the schedule and the journal all describe the same principal.
    // Disbursing a different amount desynchronises all three at once and there
    // is no partial-disbursement concept in spec 9.1.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const akadId = f.akadId as string;
    for (const salah of [rp(11_999_999), rp(12_000_001), rp(6_000_000)]) {
      await tolakDengan(
        () =>
          engine.catatPencairan(
            {
              akadId,
              tanggalPencairan: TANGGAL_AKAD_BAKU,
              jumlah: salah,
              akunKasId: d.akun.kas.id,
            },
            d.ctx.maker,
          ),
        KODE_PUMK.NILAI_PENCAIRAN_TIDAK_COCOK,
      );
    }
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaPencairan(akadId)).toHaveLength(0);
  }, 30_000);

  test("nilai yang bukan desimal dua angka ditolak sebelum menyentuh ledger (invarian 7)", async () => {
    const f = await d.siapkanProposal("JADWAL_SIAP");
    for (const salah of ["12000000", "12000000.5", "12.000.000,00", "1.2e7"]) {
      await tolakDengan(
        () =>
          engine.catatPencairan(
            {
              akadId: f.akadId as string,
              tanggalPencairan: TANGGAL_AKAD_BAKU,
              jumlah: salah,
              akunKasId: d.akun.kas.id,
            },
            d.ctx.maker,
          ),
        KODE_PUMK.NILAI_BUKAN_DESIMAL,
      );
    }
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("akun kas yang bukan akun kas ditolak dengan AKUN_KAS_TIDAK_VALID", async () => {
    // Crediting Piutang instead of Kas balances perfectly and is nonsense: the
    // receivable would net to zero on the day it was created.
    const f = await d.siapkanProposal("JADWAL_SIAP");
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId: f.akadId as string,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: POKOK_BAKU,
            akunKasId: d.akun.piutangPokok.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.AKUN_KAS_TIDAK_VALID,
    );
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId: f.akadId as string,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: POKOK_BAKU,
            akunKasId: "00000000-0000-4000-8000-000000000000",
          },
          d.ctx.maker,
        ),
      KODE_PUMK.AKUN_KAS_TIDAK_VALID,
    );
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("pencairan sebelum jadwal siap ditolak dengan JADWAL_BELUM_SIAP", async () => {
    // Spec 9.1 orders the steps: generate the schedule, THEN disburse. Money
    // out with no schedule leaves a receivable nobody can bill and no due date
    // for kolektibilitas to measure against.
    const f = await d.siapkanProposal("AKAD_DIBUAT");
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId: f.akadId as string,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: POKOK_BAKU,
            akunKasId: d.akun.kas.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.JADWAL_BELUM_SIAP,
    );
    expect(jurnal.panggilan).toHaveLength(0);
    expect((await d.bacaAkad(f.akadId as string)).status).toBe("BELUM_CAIR");
  });

  test("akad yang tidak ada ditolak dengan AKAD_TIDAK_DITEMUKAN", async () => {
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId: "00000000-0000-4000-8000-000000000002",
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: POKOK_BAKU,
            akunKasId: d.akun.kas.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.AKAD_TIDAK_DITEMUKAN,
    );
  });
});
