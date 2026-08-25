// SPEC 8.4, CLOSING PERIODE: THE TEN PREREQUISITE CHECKS, THE EXECUTION, AND
// THE REOPEN RULES.
//
// HOW THE CHECKLIST IS TESTED, AND WHY IT IS EVERY CHECK EVERY TIME.
// Spec 8.4 asks for the prerequisites "sebagai daftar dengan status di UI".
// An accountant closing a month needs to see all ten and fix them together;
// a checklist that stops at the first failure turns one closing attempt into
// ten, each a day apart. So `periksaPrasyarat` always returns ten results, in
// the spec's own numbering, and `tutupPeriode` reports every failing one at
// once. The tests below break checks INDIVIDUALLY, so a failure names the check
// rather than "closing was refused".
//
// THREE OF THE TEN CANNOT BE MADE TO FAIL, AND THAT IS STATED RATHER THAN
// QUIETLY OMITTED:
//   check 3, every journal balances    a DEFERRED CONSTRAINT TRIGGER
//                                      (migrations/0010) refuses an unbalanced
//                                      journal at COMMIT, and migrations/0020
//                                      tripwires any ledger write that did not
//                                      come through the engine. There is no
//                                      legitimate way to construct the state.
//   check 7, whole-ledger balance      follows from check 3, per journal.
//   check 9, no negative outstanding   `pumk_akad.outstanding_pokok` carries
//                                      `CHECK (outstanding_pokok >= 0)`.
// They are tested for PASS and for presence in the list. Deleting them from the
// checklist because a database guard currently covers them would remove the
// operator's evidence that the guard held, and would silently drop the check if
// a future migration ever relaxed the constraint.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_CLOSING, PRASYARAT_CLOSING, type KodePrasyarat } from "./contract";
import {
  alasanTerbaca,
  buatDunia,
  keSen,
  rp,
  tolakDengan,
  type DuniaClosing,
  type PeriodeFixture,
} from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/**
 * A period with every prerequisite satisfied EXCEPT the ones a test then
 * breaks. `langkah: false` leaves the three closing steps unrun, which is how
 * checks 4, 5 and 6 are exercised.
 */
async function siapkan(
  opsi: { tahun?: number; bulan?: number; langkah?: boolean; danai?: boolean } = {},
): Promise<PeriodeFixture> {
  const p = d.periode(opsi.tahun ?? 2026, opsi.bulan ?? 1);
  await d.tutupPeriodeSampai(p);
  d.setelJam(p.tanggalMulai);
  if (opsi.danai !== false) {
    // Otherwise the disbursement below drives cash negative and check 8 becomes
    // a warning every unrelated test would have to confirm around.
    await d.postingAlokasiDana(p.tanggalMulai, rp(100_000_000));
  }
  await d.buatAkad({
    hariTunggakan: null,
    padaTanggal: p.tanggalAkhir,
    tanggalPencairan: p.tanggalMulai,
  });
  d.setelJam(p.tanggalAkhir);
  if (opsi.langkah !== false) await d.siapkanTutup(p);
  return p;
}

function ambil<T extends { kode: KodePrasyarat }>(hasil: readonly T[], kode: KodePrasyarat): T {
  const cek = hasil.find((h) => h.kode === kode);
  if (!cek) throw new Error(`prasyarat ${kode} tidak ada di daftar spec 8.4`);
  return cek;
}

describe("spec 8.4: bentuk daftar prasyarat", () => {
  test("periksaPrasyarat mengembalikan SEPULUH hasil, bernomor sesuai spec, tanpa short circuit", async () => {
    const p = await siapkan({ langkah: false });
    await d.buatJurnalDraft(p.tanggalAkhir, rp(100_000));

    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);

    expect(daftar.periodeId).toBe(p.id);
    expect(daftar.hasil).toHaveLength(10);
    expect(daftar.hasil.map((h) => h.nomor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const h of daftar.hasil) {
      expect(h.nomor).toBe(PRASYARAT_CLOSING[h.kode]);
      expect(["PASS", "GAGAL", "PERINGATAN"]).toContain(h.status);
      alasanTerbaca(h.alasan);
    }

    // FOUR things are wrong at once here (a DRAFT journal, and steps 4, 5, 6
    // unrun) and all four are reported. An accountant fixing them one build at
    // a time is the cost of a short-circuiting checklist.
    expect(ambil(daftar.hasil, "ADA_JURNAL_DRAFT").status).toBe("GAGAL");
    expect(ambil(daftar.hasil, "KOLEKTIBILITAS_BELUM_DIJALANKAN").status).toBe("GAGAL");
    expect(ambil(daftar.hasil, "PENYISIHAN_BELUM_POSTED").status).toBe("GAGAL");
    expect(ambil(daftar.hasil, "AKRUAL_BELUM_POSTED").status).toBe("GAGAL");
    expect(daftar.boleh).toBe(false);
  });

  test("periksaPrasyarat murni membaca: tidak menulis apa pun, termasuk status periode", async () => {
    const p = await siapkan();
    const jurnalSebelum = await d.jumlahJurnalPeriode(p.id);

    await d.engine.periksaPrasyarat(p.id, d.ctx.approver);

    // Not even a CLOSING_IN_PROGRESS marker. A checklist that moves the period
    // is a checklist an operator cannot run twice without consequences, and the
    // UI runs it on every page load.
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    expect(await d.jumlahJurnalPeriode(p.id)).toBe(jurnalSebelum);
    expect(await d.bacaSaldoAkunPeriode(p.id)).toHaveLength(0);
  });

  test("semua prasyarat terpenuhi menghasilkan boleh = true dan tidak ada yang GAGAL", async () => {
    const p = await siapkan();
    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);

    expect(daftar.hasil.filter((h) => h.status === "GAGAL")).toEqual([]);
    expect(daftar.boleh).toBe(true);
    expect(daftar.perluKonfirmasi).toBe(false);
  });
});

describe("spec 8.4: setiap prasyarat menolak sendiri sendiri", () => {
  test("butir 1: periode sebelumnya belum CLOSED", async () => {
    const feb = d.periode(2026, 2);
    const mar = d.periode(2026, 3);
    await d.tutupPeriodeLangsung(d.periode(2026, 1));
    d.setelJam(mar.tanggalAkhir);
    await d.siapkanTutup(mar);

    const daftar = await d.engine.periksaPrasyarat(mar.id, d.ctx.approver);
    const cek = ambil(daftar.hasil, "PERIODE_SEBELUMNYA_BELUM_CLOSED");
    expect(cek.status).toBe("GAGAL");
    alasanTerbaca(cek.alasan);
    // Invariant 6, and the reason it is check 1: it is the only failure whose
    // fix is another closing, so an operator needs it at the top of the list.
    expect(JSON.stringify(cek.detail)).toContain(feb.id);
    expect(daftar.boleh).toBe(false);
  });

  test("butir 2: ada jurnal DRAFT bertanggal di periode ini", async () => {
    const p = await siapkan();
    const draft = await d.buatJurnalDraft(p.tanggalAkhir, rp(750_000));

    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);
    const cek = ambil(daftar.hasil, "ADA_JURNAL_DRAFT");
    expect(cek.status).toBe("GAGAL");
    alasanTerbaca(cek.alasan);
    expect(JSON.stringify(cek.detail)).toContain(draft.noJurnal);
    // A DRAFT in a NEIGHBOURING period is not this period's problem: the check
    // is on the transaction date, not on the input date (invariant 5).
    const lain = d.periode(2026, 5);
    d.setelJam(lain.tanggalAkhir);
    await d.buatJurnalDraft(lain.tanggalAkhir, rp(10_000));
    d.setelJam(p.tanggalAkhir);
    const lagi = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);
    expect(
      (ambil(lagi.hasil, "ADA_JURNAL_DRAFT").detail.jurnal as unknown[]),
    ).toHaveLength(1);
  });

  test("butir 3: seluruh jurnal balance (hanya bisa PASS, dijaga trigger DEFERRED)", async () => {
    const p = await siapkan();
    const cek = ambil(
      (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
      "JURNAL_TIDAK_BALANCE",
    );
    expect(cek.nomor).toBe(3);
    expect(cek.status).toBe("PASS");
    // spec 8.4: "query verifikasi, jangan percaya kolom total". The claim is
    // about the SOURCE, so the check must agree with the shipped integrity view
    // that reads lines, not with `jurnal.total_debit`.
    const menyimpang = await d.db.query<{ n: string }>(
      `select count(*)::text as n from v_integritas_jurnal v
         join jurnal j on j.id = v.jurnal_id
        where j.periode_id = $1`,
      [p.id],
    );
    expect(menyimpang[0].n).toBe("0");
  });

  test("butir 4: closing kolektibilitas belum dijalankan", async () => {
    const p = await siapkan({ langkah: false });
    const cek = ambil(
      (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
      "KOLEKTIBILITAS_BELUM_DIJALANKAN",
    );
    expect(cek.status).toBe("GAGAL");
    alasanTerbaca(cek.alasan);

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    expect(
      ambil(
        (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
        "KOLEKTIBILITAS_BELUM_DIJALANKAN",
      ).status,
    ).toBe("PASS");
  });

  test("butir 5: jurnal penyisihan belum POSTED, atau dinyatakan nol secara eksplisit", async () => {
    const p = await siapkan({ langkah: false });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    const belum = ambil(
      (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
      "PENYISIHAN_BELUM_POSTED",
    );
    expect(belum.status).toBe("GAGAL");
    alasanTerbaca(belum.alasan);

    // The akad here is LANCAR, so the allowance is genuinely zero and no
    // journal is posted. spec 8.4 check 5 says "atau eksplisit dinyatakan nol":
    // the `penyisihan_periode` row IS that statement, which is why spec 8.2
    // writes it even when the movement is nothing.
    const [pen] = await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);
    expect(pen.jurnalId).toBeNull();
    expect(pen.bebanPenyisihanPeriode).toBe("0.00");
    expect(
      ambil(
        (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
        "PENYISIHAN_BELUM_POSTED",
      ).status,
    ).toBe("PASS");
  });

  test("butir 6: jurnal akrual belum POSTED kalau mode akrual aktif; PASS kalau CASH_BASIS", async () => {
    const p = await siapkan({ langkah: false });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);

    expect(
      ambil(
        (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
        "AKRUAL_BELUM_POSTED",
      ).status,
    ).toBe("GAGAL");

    // spec 8.4 check 6 is conditional on the method: under CASH_BASIS there is
    // nothing to post, so the check must PASS rather than block every closing
    // forever. This is the check reading configuration, not the engine
    // deciding accounting policy.
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "CASH_BASIS");
    const kas = ambil(
      (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
      "AKRUAL_BELUM_POSTED",
    );
    expect(kas.status).toBe("PASS");
    expect(JSON.stringify(kas.detail)).toContain("CASH_BASIS");
  });

  test("butir 7: neraca lajur balance (hanya bisa PASS, konsekuensi butir 3)", async () => {
    const p = await siapkan();
    const cek = ambil(
      (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
      "NERACA_LAJUR_TIDAK_BALANCE",
    );
    expect(cek.nomor).toBe(7);
    expect(cek.status).toBe("PASS");
    // The number the check is about, read the correct way: over the whole
    // ledger up to period end, POSTED and REVERSED (ADR 0010).
    expect(await d.selisihLedger()).toBe("0.00");
  });

  test("butir 8: saldo kas negatif adalah PERINGATAN, dan closing menuntut konfirmasi", async () => {
    // Funded deliberately NOT at all, so the disbursement leaves cash negative.
    const p = await siapkan({ danai: false });
    expect(keSen(await d.saldoLedger(d.akun.kas.id, p.tanggalAkhir))).toBeLessThan(0n);

    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);
    const cek = ambil(daftar.hasil, "SALDO_KAS_NEGATIF");
    // Neither PASS nor GAGAL. spec 8.4: "warning, bukan blocker, tapi wajib
    // dikonfirmasi user", which is a third state and needs a third value.
    expect(cek.status).toBe("PERINGATAN");
    alasanTerbaca(cek.alasan);
    expect(daftar.boleh).toBe(true);
    expect(daftar.perluKonfirmasi).toBe(true);

    // Unconfirmed, the close is refused: a confirmation that can be skipped by
    // not passing a flag is not a confirmation.
    await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.KONFIRMASI_KAS_NEGATIF_WAJIB,
    );
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");

    const hasil = await d.engine.tutupPeriode(
      { periodeId: p.id, konfirmasiKasNegatif: true },
      d.ctx.approver,
    );
    expect(hasil.periode.status).toBe("CLOSED");
    // The confirmation is evidence, so it lands in the audit trail rather than
    // only in a request that is gone.
    const audit = d.audit.panggilan.filter((a) => a.hasil === "SUKSES");
    expect(JSON.stringify(audit)).toContain("SALDO_KAS_NEGATIF");
  });

  test("butir 9: outstanding pokok negatif (hanya bisa PASS, dijaga CHECK kolom)", async () => {
    const p = await siapkan();
    const cek = ambil(
      (await d.engine.periksaPrasyarat(p.id, d.ctx.approver)).hasil,
      "OUTSTANDING_POKOK_NEGATIF",
    );
    expect(cek.nomor).toBe(9);
    expect(cek.status).toBe("PASS");

    // The guard that makes it unfalsifiable, asserted so that removing the
    // constraint makes THIS test fail and prompts a real test for check 9.
    let ditolakDb = false;
    try {
      await d.db.query(
        `update pumk_akad set outstanding_pokok = -1 where cabang_id = $1`,
        [d.cabangId],
      );
    } catch {
      ditolakDb = true;
    }
    expect(ditolakDb).toBe(true);
  });

  test("butir 10: sub ledger piutang tidak cocok dengan buku besar, dengan daftar akadnya", async () => {
    const p = await siapkan();
    const akad = await d.buatAkad({
      hariTunggakan: 10,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: p.tanggalMulai,
    });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    await d.rusakSubLedger(akad.akadId, rp(3_000_000));

    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);
    const cek = ambil(daftar.hasil, "SUB_LEDGER_TIDAK_COCOK");
    expect(cek.status).toBe("GAGAL");
    alasanTerbaca(cek.alasan);
    // "Ini rekonsiliasi paling penting di seluruh sistem. Kalau tidak cocok,
    // blok closing dan tampilkan daftar akad yang menyebabkan selisih."
    // The list is the check; a bare boolean leaves the operator blocked with
    // nowhere to look.
    expect(JSON.stringify(cek.detail)).toContain(akad.akadId);
    expect(JSON.stringify(cek.detail)).toContain(akad.noAkad);
    expect(daftar.boleh).toBe(false);
  });
});

describe("spec 16 skenario 12: DRAFT memblokir, lalu diposting, lalu closing berhasil", () => {
  test("closing ditolak dengan alasan jelas, jurnal diposting, closing berhasil", async () => {
    const p = await siapkan();
    const draft = await d.buatJurnalDraft(p.tanggalAkhir, rp(1_250_000));

    // 1. Refused, with a reason an accountant can act on: which document.
    const err = await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.PRASYARAT_GAGAL,
    );
    const gagal = err.detail.gagal as Array<{ kode: string; alasan: string }>;
    expect(gagal.map((g) => g.kode)).toContain("ADA_JURNAL_DRAFT");
    alasanTerbaca(gagal.find((g) => g.kode === "ADA_JURNAL_DRAFT")?.alasan ?? "");
    expect(JSON.stringify(err.detail)).toContain(draft.noJurnal);
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");

    // 2. The journal is posted, through the real ledger engine.
    const posted = await d.postingJurnalDraft(draft.id);
    expect(posted.status).toBe("POSTED");

    // 3. The prerequisite that blocked is now satisfied. The allowance and the
    //    accrual were computed before this journal existed, and this journal
    //    touches neither receivables nor the allowance, so nothing has to be
    //    re-run; but the checklist is re-evaluated INSIDE the close either way.
    const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    expect(hasil.periode.status).toBe("CLOSED");
    expect(
      hasil.prasyarat.hasil.filter((h) => h.status === "GAGAL"),
    ).toEqual([]);
    // The posted journal is inside the frozen figures, which is the whole point
    // of having refused a moment ago.
    const saldo = await d.bacaSaldoAkunPeriode(p.id);
    const beban = saldo.find((s) => s.akun_kode === d.akun.bebanOperasional.kode);
    expect(keSen(beban?.mutasi_debit ?? "0.00")).toBeGreaterThanOrEqual(keSen(rp(1_250_000)));
  });
});

describe("spec 8.4: eksekusi", () => {
  test("closing menandai periode, mencatat pelakunya, menulis audit log dan membekukan saldo", async () => {
    const p = await siapkan();
    d.audit.reset();

    const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    expect(hasil.periode.status).toBe("CLOSED");
    expect(hasil.periode.closedBy).toBe(d.userId.approver);
    expect(hasil.periode.closedAt).not.toBeNull();
    const row = await d.bacaPeriode(p.id);
    expect(row.status).toBe("CLOSED");
    expect(row.closed_by).toBe(d.userId.approver);

    // spec 8.4: "tulis audit log". The checklist as it stood travels with it,
    // so the record says what was true when the decision was made rather than
    // what is true whenever someone next looks.
    const audit = d.audit.panggilan.filter((a) => a.hasil === "SUKSES");
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((a) => a.entitas === "periode" && a.entitasId === p.id)).toBe(true);

    // The frozen trial balance exists and is not empty.
    expect(hasil.saldo.length).toBeGreaterThan(0);
    const tersimpan = await d.bacaSaldoAkunPeriode(p.id);
    expect(tersimpan.length).toBe(hasil.saldo.length);
  });

  test("checklist dievaluasi ULANG di dalam transaksi closing, bukan dipercaya dari panggilan sebelumnya", async () => {
    const p = await siapkan();
    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.approver);
    expect(daftar.boleh).toBe(true);

    // The world moves between the check and the close, which is the ordinary
    // case in a multi-user system rather than an exotic one: a Maker saves a
    // draft while the Approver is looking at a green checklist.
    const draft = await d.buatJurnalDraft(p.tanggalAkhir, rp(90_000));

    const err = await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.PRASYARAT_GAGAL,
    );
    expect(JSON.stringify(err.detail)).toContain(draft.noJurnal);
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
  });

  test("periode yang sudah CLOSED tidak bisa ditutup lagi", async () => {
    const p = await siapkan();
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
    const saldoPertama = await d.bacaSaldoAkunPeriode(p.id);

    await tolakDengan(
      () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.PERIODE_SUDAH_CLOSED,
    );
    // A second close that silently rewrote the frozen balances would be
    // invariant 14 broken with no trace, because both runs would look
    // identical in the audit log.
    expect(await d.bacaSaldoAkunPeriode(p.id)).toEqual(saldoPertama);
  });

  test("periode yang tidak ada ditolak dengan kode domain, bukan crash", async () => {
    await tolakDengan(
      () =>
        d.engine.tutupPeriode(
          { periodeId: "00000000-0000-4000-8000-000000000000" },
          d.ctx.approver,
        ),
      KODE_CLOSING.PERIODE_TIDAK_DITEMUKAN,
    );
  });
});

describe("spec 8.4: reopen", () => {
  async function tutupTiga(): Promise<PeriodeFixture[]> {
    const hasil: PeriodeFixture[] = [];
    for (const bulan of [1, 2, 3]) {
      const p = d.periode(2026, bulan);
      d.setelJam(p.tanggalMulai);
      if (bulan === 1) await d.postingAlokasiDana(p.tanggalMulai, rp(200_000_000));
      d.setelJam(p.tanggalAkhir);
      await d.siapkanTutup(p);
      await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
      hasil.push(p);
    }
    return hasil;
  }

  test("reopen hanya untuk periode terakhir yang CLOSED, tidak bisa melompat", async () => {
    const [jan, , mar] = await tutupTiga();

    // Reopening January while March is closed would leave two closed periods
    // whose figures were computed on top of a period that is open again, and
    // invariant 6 would be violated from the inside.
    await tolakDengan(
      () =>
        d.engine.bukaKembaliPeriode(
          { periodeId: jan.id, alasan: "Koreksi klasifikasi beban (fixture)" },
          d.ctx.adminPusat,
        ),
      KODE_CLOSING.REOPEN_BUKAN_PERIODE_TERAKHIR,
    );
    expect((await d.bacaPeriode(jan.id)).status).toBe("CLOSED");
    expect(await d.bacaSaldoAkunPeriode(jan.id)).not.toHaveLength(0);

    // The latest one is allowed.
    await d.engine.bukaKembaliPeriode(
      { periodeId: mar.id, alasan: "Koreksi klasifikasi beban (fixture)" },
      d.ctx.adminPusat,
    );
    expect((await d.bacaPeriode(mar.id)).status).toBe("OPEN");
  });

  test("reopen wajib menyertakan alasan tertulis, dan alasannya tersimpan", async () => {
    const [, , mar] = await tutupTiga();

    for (const alasan of ["", "   "]) {
      await tolakDengan(
        () => d.engine.bukaKembaliPeriode({ periodeId: mar.id, alasan }, d.ctx.adminPusat),
        KODE_CLOSING.ALASAN_WAJIB,
      );
    }
    expect((await d.bacaPeriode(mar.id)).status).toBe("CLOSED");

    const alasan = "Permintaan KAP: reklasifikasi beban pembinaan ke akun yang benar";
    d.audit.reset();
    const hasil = await d.engine.bukaKembaliPeriode(
      { periodeId: mar.id, alasan },
      d.ctx.adminPusat,
    );

    expect(hasil.status).toBe("OPEN");
    expect(hasil.alasanReopen).toBe(alasan);
    expect(hasil.reopenedBy).toBe(d.userId.adminPusat);
    const row = await d.bacaPeriode(mar.id);
    expect(row.alasan_reopen).toBe(alasan);
    expect(row.reopened_by).toBe(d.userId.adminPusat);
    // spec 8.4: "Semua tercatat di audit log."
    expect(JSON.stringify(d.audit.panggilan)).toContain(alasan);
  });

  test("reopen menghapus snapshot saldo periode itu", async () => {
    const [, , mar] = await tutupTiga();
    expect(await d.bacaSaldoAkunPeriode(mar.id)).not.toHaveLength(0);

    await d.engine.bukaKembaliPeriode(
      { periodeId: mar.id, alasan: "Koreksi (fixture)" },
      d.ctx.adminPusat,
    );

    // Safe precisely because these rows are DERIVED and fully regenerable from
    // the ledger, which is also why deleting a jurnal row never is. Leaving
    // them would let a report read a frozen balance for a period that is open
    // and moving.
    expect(await d.bacaSaldoAkunPeriode(mar.id)).toHaveLength(0);
  });

  test("reopen ditolak kalau konfigurasi mematikannya", async () => {
    const [, , mar] = await tutupTiga();
    await d.setelKonfigurasi("akuntansi", "izinkan_reopen_periode", "false");

    // spec 5.6 ships this as true, and it is still a parameter. A client whose
    // policy forbids reopening a filed period must be able to enforce it
    // without a code change.
    await tolakDengan(
      () =>
        d.engine.bukaKembaliPeriode(
          { periodeId: mar.id, alasan: "Koreksi (fixture)" },
          d.ctx.adminPusat,
        ),
      KODE_CLOSING.REOPEN_TIDAK_DIIZINKAN,
    );
    expect((await d.bacaPeriode(mar.id)).status).toBe("CLOSED");
  });

  test("reopen periode yang tidak pernah ditutup ditolak", async () => {
    const p = d.periode(2027, 9);
    await tolakDengan(
      () =>
        d.engine.bukaKembaliPeriode(
          { periodeId: p.id, alasan: "Koreksi (fixture)" },
          d.ctx.adminPusat,
        ),
      KODE_CLOSING.PERIODE_BELUM_CLOSED,
    );
  });

  test("setelah reopen, periode itu bisa menerima jurnal lagi lalu ditutup ulang", async () => {
    const [, , mar] = await tutupTiga();
    await d.engine.bukaKembaliPeriode(
      { periodeId: mar.id, alasan: "Koreksi beban operasional (fixture)" },
      d.ctx.adminPusat,
    );

    // The whole reason a reopen exists: something has to change.
    d.setelJam(mar.tanggalAkhir);
    await d.postingBebanOperasional(mar.tanggalAkhir, rp(4_000_000));

    await d.siapkanTutup(mar);
    const hasil = await d.engine.tutupPeriode({ periodeId: mar.id }, d.ctx.approver);
    expect(hasil.periode.status).toBe("CLOSED");

    const saldo = await d.bacaSaldoAkunPeriode(mar.id);
    const beban = saldo.find((s) => s.akun_kode === d.akun.bebanOperasional.kode);
    expect(keSen(beban?.mutasi_debit ?? "0.00")).toBeGreaterThanOrEqual(keSen(rp(4_000_000)));
  });
});
