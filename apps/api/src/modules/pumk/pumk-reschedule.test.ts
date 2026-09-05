// SCENARIO 8: "Ajukan reschedule untuk satu akad lain, setujui, konfirmasi
// jadwal versi baru terbentuk dan RIWAYAT VERSI LAMA UTUH."
//
// Spec 9.1 "Halaman reschedule dengan preview jadwal baru sebelum submit", and
// invariant 8: "Jadwal angsuran yang sudah di-generate bersifat immutable.
// Perubahan hanya lewat reschedule yang membuat jadwal baru dan menandai jadwal
// lama sebagai SUPERSEDED."
//
// THE DEFECT THIS FILE GUARDS AGAINST. The obvious implementation of a
// reschedule is to rewrite the remaining rows in place. Every screen then looks
// right, and the payment history is gone: the three instalments the mitra
// already settled no longer exist anywhere, so the kolektibilitas history, the
// kartu piutang and any report covering a past period all change retroactively
// (invariant 14). migrations/0008 refuses the in-place rewrite with
// trg_pumk_jadwal_10_immutable, but it cannot refuse "insert a new version and
// forget the old one", which is what these tests hold.
//
// THE NUMBERS.
//   akad     12.000.000 over 12 months, FLAT 3 percent, rounding 0
//   paid     instalments 1, 2 and 3, in full, through the REAL allocation
//            engine, so the payments are real ledger events and not a fixture's
//            opinion about what a payment looks like
//   left     9.000.000 of principal, 270.000 of jasa
//   new      18 months: pokok 500.000,00 and jasa 22.500,00 per row
//            (9.000.000 x 3% x 18/12 = 405.000, over 18 rows)
//
// A RESCHEDULE THAT DOES NOT MOVE THE PRINCIPAL MOVES NO MONEY, so it posts no
// journal and the reconciliation must be unchanged on both sides of it. That is
// asserted before and after.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, PERMISSION_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  jumlahUang,
  keSen,
  periksaRekonsiliasiNol,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  tolakDenganKodeKolaborator,
  MULAI_ANGSURAN_BAKU,
  POKOK_BAKU,
  type BarisJadwalDb,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

const ANGSURAN_BARIS = rp(1_030_000);
const SISA_POKOK = rp(9_000_000);
const TENOR_BARU = 18;
const POKOK_BARIS_BARU = rp(500_000);
const JASA_BARIS_BARU = rp(22_500);
const TANGGAL_PENGAJUAN = "2026-06-20";
/** Rows 1..3 fall due 10 Mar, 10 Apr, 10 May 2026. */
const TANGGAL_BAYAR = ["2026-03-10", "2026-04-10", "2026-05-10"];

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
  await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
});

afterAll(async () => {
  if (d) await d.tutup();
});

/**
 * The columns on which two schedule rows differ, sorted. Named so a failure
 * reads "expected [is_active_version], got [is_active_version, pokok_terbayar]"
 * instead of a whole-object diff the reader has to scan.
 */
function kolomBerubah(sebelum: BarisJadwalDb, sesudah: BarisJadwalDb): string[] {
  const kunciKolom = new Set([...Object.keys(sebelum), ...Object.keys(sesudah)]);
  return [...kunciKolom]
    .filter(
      (k) =>
        (sebelum as unknown as Record<string, unknown>)[k] !==
        (sesudah as unknown as Record<string, unknown>)[k],
    )
    .sort();
}

/**
 * A disbursed akad with instalments 1, 2 and 3 genuinely settled.
 *
 * THE PAYMENTS GO THROUGH THE REAL ALLOCATION ENGINE, not through hand-written
 * UPDATEs, because "three instalments already paid" has to be true in the
 * ledger as well as in the schedule for the reconciliation assertions below to
 * mean anything. It does NOT go through `engine.terimaAngsuran`: the PUMK
 * module is unimplemented, and routing a precondition through it would turn one
 * failure into a cascade.
 */
async function akadSetengahJalan(): Promise<{ akadId: string; proposalId: string }> {
  const f = await d.siapkanProposal("DICAIRKAN");
  const akadId = f.akadId as string;
  for (const tanggal of TANGGAL_BAYAR) {
    await angsuran.alokasikanSetoran(
      { akadId, tanggal, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
  }
  const akad = await d.bacaAkad(akadId);
  expect(akad.outstanding_pokok).toBe(SISA_POKOK);
  expect(akad.outstanding_jasa).toBe(rp(270_000));
  periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), SISA_POKOK);
  angsuran.reset();
  jurnal.reset();
  return { akadId, proposalId: f.proposalId };
}

// ---------------------------------------------------------------------------
// Propose, then approve (spec 7.3 step 1)
// ---------------------------------------------------------------------------

describe("pengajuan reschedule (spec 7.3, spec 9.1)", () => {
  test("pengajuan membuat DRAFT dan TIDAK mengubah jadwal apa pun", async () => {
    // The preview screen the spec asks for is a preview: nothing is committed
    // until an approver says so, so version 1 must still be the active version
    // and every row must still be where it was.
    const { akadId } = await akadSetengahJalan();

    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet usaha turun setelah kebakaran pasar",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );

    expect(r.status).toBe("DRAFT");
    expect(r.jenis).toBe("PERPANJANG_TENOR");
    expect(r.jadwalVersiLama).toBe(1);
    expect(r.jadwalVersiBaru).toBeNull();
    expect(r.tenorBaru).toBe(TENOR_BARU);

    const versi = await d.bacaVersi(akadId);
    expect(versi).toHaveLength(1);
    expect(versi[0].is_active_version).toBe(true);
    expect(await d.bacaJadwal(akadId)).toHaveLength(12);
    expect((await d.bacaAkad(akadId)).tenor_bulan).toBe(12);
    // No money moved, so no journal.
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("pengajuan didelegasikan ke engine angsuran, bukan dihitung ulang di sini", async () => {
    const { akadId } = await akadSetengahJalan();
    await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
        catatan: "Disepakati dalam kunjungan",
      },
      d.ctx.maker,
    );
    expect(angsuran.panggilan).toHaveLength(1);
    expect(angsuran.panggilan[0].metode).toBe("ajukanReschedule");
    expect(angsuran.panggilan[0].argumen).toEqual({
      akadId,
      tanggalPengajuan: TANGGAL_PENGAJUAN,
      alasan: "Omzet turun",
      jenis: "PERPANJANG_TENOR",
      tenorBaru: TENOR_BARU,
      graceBaru: null,
      jasaRateBaru: null,
      catatan: "Disepakati dalam kunjungan",
    });
  }, 30_000);

  test("Maker mengajukan, tapi hanya pemegang pumk.approve yang boleh menyetujui", async () => {
    // Spec 7.3 step 1 and spec 2: a reschedule is a credit decision, so the
    // maker/approver split applies to it exactly as it applies to the proposal.
    const { akadId } = await akadSetengahJalan();
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.RESCHEDULE);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_PUMK.APPROVE);

    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );
    await tolakDengan(() => engine.setujuiReschedule(r.id, d.ctx.maker), KODE_PUMK.TIDAK_BERWENANG);

    // Refused means still DRAFT and still one version.
    expect((await d.bacaReschedule(akadId))[0].status).toBe("DRAFT");
    expect(await d.bacaVersi(akadId)).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Approval: the new version, with the old one intact
// ---------------------------------------------------------------------------

describe("persetujuan reschedule: versi baru terbentuk, versi lama utuh (skenario 8)", () => {
  test("versi 2 menjadi aktif dan dibangun dari outstanding, bukan dari pokok asli", async () => {
    const { akadId } = await akadSetengahJalan();
    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );
    const hasil = await engine.setujuiReschedule(r.id, d.ctx.approver);

    expect(hasil.versiLama).toBe(1);
    expect(hasil.versiBaru).toBe(2);
    expect(hasil.reschedule.status).toBe("DISETUJUI");
    expect(hasil.jadwalBaru.isActiveVersion).toBe(true);
    expect(hasil.jadwalBaru.baris).toHaveLength(TENOR_BARU);

    // Spec 7.5 item 10's arithmetic: what was already paid plus what is left
    // must still be the original principal. A new schedule built from 12.000.000
    // instead of 9.000.000 would re-lend money that was already repaid.
    expect(hasil.pokokTerbayarHistoris).toBe(rp(3_000_000));
    expect(hasil.outstandingBaru).toBe(SISA_POKOK);
    expect(jumlahUang(hasil.pokokTerbayarHistoris, hasil.outstandingBaru)).toBe(POKOK_BAKU);

    const versi = await d.bacaVersi(akadId);
    expect(versi).toHaveLength(2);
    expect(versi[0].versi).toBe(1);
    expect(versi[0].is_active_version).toBe(false);
    expect(versi[1].versi).toBe(2);
    expect(versi[1].is_active_version).toBe(true);
    expect(versi[1].reschedule_id).toBe(r.id);

    const baru = await d.bacaJadwal(akadId, 2);
    expect(baru).toHaveLength(TENOR_BARU);
    expect(baru[0].pokok).toBe(POKOK_BARIS_BARU);
    expect(baru[0].jasa_adm).toBe(JASA_BARIS_BARU);
    expect(baru[TENOR_BARU - 1].saldo_pokok_setelah).toBe("0.00");
    // Invariant 9 again, on the new version: it sums to the outstanding it was
    // built from, exactly.
    const totalBaru = baru.reduce((acc, b) => acc + keSen(b.pokok), 0n);
    expect(totalBaru).toBe(keSen(SISA_POKOK));
  }, 60_000);

  test("baris yang sudah dibayar di versi lama TIDAK berubah sedikit pun", async () => {
    // The heart of scenario 8. Read from the table, per row, because "the
    // history is intact" is not something a return value can promise.
    const { akadId } = await akadSetengahJalan();
    const sebelum = await d.bacaJadwal(akadId, 1);

    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );
    await engine.setujuiReschedule(r.id, d.ctx.approver);

    const sesudah = await d.bacaJadwal(akadId, 1);
    expect(sesudah).toHaveLength(12);
    for (let i = 0; i < 3; i += 1) {
      // EVERY COLUMN IDENTICAL EXCEPT ONE, and the exception is named rather
      // than waved at.
      //
      // `is_active_version` is SUPPOSED to move here: superseding version 1 is
      // the whole operation, and `trg_pumk_jadwal_versi_50_propagasi` flips the
      // flag on every row of the old version, correctly. Comparing the raw rows
      // asserted the opposite of the "semua baris versi lama non aktif" check
      // twenty lines below, so no implementation could satisfy both and the
      // test was unsatisfiable rather than strict.
      //
      // Asserting the DIFF instead of excluding the column keeps the coverage:
      // if a second column ever moves, `kolomBerubah` names it and this fails.
      // A bare `toEqual(tanpaFlag(...))` would silently tolerate the flag going
      // the wrong way, which the explicit assertion below still catches.
      expect(kolomBerubah(sebelum[i], sesudah[i])).toEqual(["is_active_version"]);
      expect(sesudah[i].status).toBe("LUNAS");
      expect(sesudah[i].pokok_terbayar).toBe(rp(1_000_000));
      expect(sesudah[i].jasa_terbayar).toBe(rp(30_000));
      expect(sesudah[i].tanggal_lunas).toBe(TANGGAL_BAYAR[i]);
    }
    // The unpaid rows of version 1 are superseded, not deleted: the version is
    // still readable in full, which is what "tampilkan semua versi" needs.
    expect(sesudah.every((b) => b.is_active_version === false)).toBe(true);
    expect(sesudah[3].status).toBe("DIRESCHEDULE");
  }, 60_000);

  test("akad tetap dihitung sebagai piutang aktif dan rekonsiliasinya tetap nol", async () => {
    // A rescheduled loan is still money owed. An implementation that parked the
    // akad in a non-receivable status would quietly remove it from the ageing,
    // from the penyisihan basis and from the reconciliation, which is how a
    // restructured portfolio disappears from a report.
    const { akadId } = await akadSetengahJalan();
    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );
    await engine.setujuiReschedule(r.id, d.ctx.approver);

    const akad = await d.bacaAkad(akadId);
    expect(["AKTIF", "RESCHEDULED"]).toContain(akad.status);
    expect(await d.dihitungSebagaiPiutangAktif(akadId)).toBe(true);
    // The principal did not move, so the outstanding is untouched.
    expect(akad.outstanding_pokok).toBe(SISA_POKOK);
    expect(akad.tenor_bulan).toBe(TENOR_BARU);

    // Spec 7.3 step 7: no principal change, no correction journal.
    expect(jurnal.panggilan).toHaveLength(0);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), SISA_POKOK);
    expect(await d.akadTidakRekonsiliasi()).toHaveLength(0);
  }, 60_000);

  test("angsuran setelah reschedule jatuh ke versi 2, versi 1 tetap beku", async () => {
    // The reschedule is only real if the next payment behaves. 522.500 is one
    // row of the NEW schedule (500.000 + 22.500); under the old schedule it
    // would have been a short payment against a 1.030.000 row.
    const { akadId } = await akadSetengahJalan();
    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );
    const hasil = await engine.setujuiReschedule(r.id, d.ctx.approver);
    const jatuhTempoBaru = hasil.jadwalBaru.baris[0].tanggalJatuhTempo;

    const setoran = await engine.terimaAngsuran(
      {
        akadId,
        tanggalTerima: jatuhTempoBaru,
        jumlah: rp(522_500),
        akunKasId: d.akun.kas.id,
      },
      d.ctx.maker,
    );
    expect(setoran.alokasiPokok).toBe(POKOK_BARIS_BARU);
    expect(setoran.alokasiJasa).toBe(JASA_BARIS_BARU);
    expect(setoran.alokasiKelebihan).toBe("0.00");

    const v2 = await d.bacaJadwal(akadId, 2);
    expect(v2[0].status).toBe("LUNAS");
    const v1 = await d.bacaJadwal(akadId, 1);
    expect(v1[3].pokok_terbayar).toBe("0.00");

    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), rp(8_500_000));
  }, 60_000);

  test("persetujuan kedua atas reschedule yang sama ditolak, versi tidak bertambah", async () => {
    const { akadId } = await akadSetengahJalan();
    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: TENOR_BARU,
      },
      d.ctx.maker,
    );
    await engine.setujuiReschedule(r.id, d.ctx.approver);
    // INVERTED. This used to assert `JADWAL_GAGAL`, this module's own "the
    // schedule engine refused something", which told an approver clicking twice
    // nothing at all. The instalment engine's `RESCHEDULE_SUDAH_DIPROSES` now
    // crosses the boundary intact and says which of the two clicks landed.
    await tolakDenganKodeKolaborator(
      () => engine.setujuiReschedule(r.id, d.ctx.approver),
      "RESCHEDULE_SUDAH_DIPROSES",
    );
    expect(await d.bacaVersi(akadId)).toHaveLength(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The principal restructure, still closed
// ---------------------------------------------------------------------------

describe("restruktur pokok (ADR 0011)", () => {
  test("TEMUAN: restruktur pokok masih ditolak walau kode eventnya sudah diputuskan", async () => {
    // docs/BUILD-PLAN.md "Keputusan sementara" now names both directions,
    // RESTRUKTUR_POKOK_NAIK and RESTRUKTUR_POKOK_TURUN, and
    // apps/api/src/seed/event-jurnal.ts seeds both. The instalment engine was
    // written BEFORE that decision and still refuses the whole jenis, and
    // `AjukanRescheduleInput` still carries no new principal, so there is no way
    // to express one.
    //
    // This test pins the CURRENT closed seam rather than pretending it is open.
    // It also still asserts the FLATTENED code, deliberately, while three of
    // its neighbours were inverted: `POKOK_TIDAK_VALID` is a schedule-SHAPE
    // code (core/sebab-kolaborator.ts rule 2), and telling an operator who
    // asked to restructure a loan that "pokok pinjaman harus lebih besar dari
    // nol" sends them looking for a principal field their form does not have.
    // `JADWAL_GAGAL` with the real cause in `penyebabDb` is the honest answer
    // until the seam opens.
    // What it must NOT do is let this module invent a principal correction of
    // its own: that would be invariant 11 gone, and a journal nobody sanctioned.
    // When the instalment engine opens the seam, this test is the one that has
    // to change, deliberately, in the same commit.
    const { akadId } = await akadSetengahJalan();
    await tolakDengan(
      () =>
        engine.ajukanReschedule(
          {
            akadId,
            tanggalPengajuan: TANGGAL_PENGAJUAN,
            alasan: "Sebagian tagihan diturunkan sesuai SK",
            jenis: "RESTRUKTUR_POKOK",
          },
          d.ctx.maker,
        ),
      KODE_PUMK.JADWAL_GAGAL,
    );
    // Nothing was posted and nothing was versioned.
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaReschedule(akadId)).toHaveLength(0);
    expect(await d.bacaVersi(akadId)).toHaveLength(1);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), SISA_POKOK);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("penolakan reschedule", () => {
  test("tenor baru di luar batas konfigurasi ditolak, dan batasnya dibaca dari konfigurasi", async () => {
    const { akadId } = await akadSetengahJalan();
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "24");
    // INVERTED. `TENOR_DILUAR_BATAS` is exactly the refusal an operator can act
    // on -- lower the tenor, or have the parameter raised -- and flattening it
    // into `JADWAL_GAGAL` turned a configurable policy limit into an
    // unexplained failure. It travels now; the schedule-SHAPE codes next to it
    // in that engine (`POKOK_TIDAK_VALID` and friends) deliberately do not, and
    // the restructure test below still asserts the flattened code for that
    // reason.
    await tolakDenganKodeKolaborator(
      () =>
        engine.ajukanReschedule(
          {
            akadId,
            tanggalPengajuan: TANGGAL_PENGAJUAN,
            alasan: "Omzet turun",
            jenis: "PERPANJANG_TENOR",
            tenorBaru: 36,
          },
          d.ctx.maker,
        ),
      "TENOR_DILUAR_BATAS",
    );
    // Raise the ceiling and the same request goes through: the mechanic, not
    // the number.
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
    const r = await engine.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: TANGGAL_PENGAJUAN,
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: 36,
      },
      d.ctx.maker,
    );
    expect(r.status).toBe("DRAFT");
  }, 60_000);

  test("reschedule atas akad yang belum cair ditolak dan tidak membocorkan teks trigger", async () => {
    const f = await d.siapkanProposal("JADWAL_SIAP");
    // INVERTED, same reason as the setoran case in ./pumk-angsuran.test.ts: the
    // instalment engine owns "this akad cannot be rescheduled" and its sentence
    // says why. It used to arrive as `JADWAL_GAGAL` with the reason in
    // `penyebabDb`, server-log only.
    const err = await tolakDenganKodeKolaborator(
      () =>
        engine.ajukanReschedule(
          {
            akadId: f.akadId as string,
            tanggalPengajuan: TANGGAL_PENGAJUAN,
            alasan: "Belum cair tapi minta diperpanjang",
            jenis: "PERPANJANG_TENOR",
            tenorBaru: TENOR_BARU,
          },
          d.ctx.maker,
        ),
      "AKAD_TIDAK_BISA_DIANGSUR",
    );
    expect(err.message).not.toMatch(/TJSL-[A-Z]{3}-\d{3}/);
    expect(await d.bacaReschedule(f.akadId as string)).toHaveLength(0);
  });

  test("akad cabang lain tidak bisa direschedule dari cabang ini", async () => {
    // Scope again, on the akad path: a reschedule is a credit decision on
    // another branch's book.
    const f = await d.siapkanProposal("DICAIRKAN", {
      cabangId: d.cabangLainId,
      makerUserId: d.userId.makerLain,
    });
    await tolakDengan(
      () =>
        engine.ajukanReschedule(
          {
            akadId: f.akadId as string,
            tanggalPengajuan: TANGGAL_PENGAJUAN,
            alasan: "Lintas cabang",
            jenis: "PERPANJANG_TENOR",
            tenorBaru: TENOR_BARU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
    expect(angsuran.panggilan).toHaveLength(0);
  }, 30_000);
});
