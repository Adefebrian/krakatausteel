// FIXTURE INTEGRITY. The only file in this folder that is expected to be GREEN
// today.
//
// WHY IT EXISTS. Every other file here is a tests-first specification against
// an unimplemented engine, so every other file is RED. That makes a fixture bug
// invisible: "world would not build" and "module not written yet" both show up
// as a red folder. This file separates the two. If it is green and the rest are
// red, the failures are the module. If it is red, nothing else in the folder
// means anything yet and this is the first thing to fix.
//
// It also pins the four things ./test-support.ts promises that a reader would
// otherwise have to take on trust: the permission lists really come from the
// SHIPPED grant matrix in the database (never a literal); `siapkanProposal`
// really leaves the timeline EMPTY so a timeline assertion elsewhere can only
// pass if the ENGINE wrote the row; the disbursement preconditions really went
// through the REAL ledger engine; and the transition table really is spec 9.2's
// diagram rather than a paraphrase of it.
//
// AND IT CARRIES THE THREE FINDINGS of this phase, as assertions rather than as
// prose in a report nobody re-reads. All three were written so that they would
// go RED THE DAY THE GAP CLOSED, and all three did exactly that: the missing
// `nonpumk.lpj.verifikasi` permission, the refund mapping that credited a
// pooled account while the disbursement debited a per-bidang one, and the four
// Non PUMK parameters that no migration shipped. They are now discharged, and
// each one asserts the opposite of what it used to. The notes explaining what
// they used to assert are kept on purpose: they are the recorded argument for
// the shape of the fix, and a fix with no recorded reason is a fix the next
// reader undoes. See the block near the bottom.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canonicalPermission } from "../auth";
import {
  AMBANG_UMUR_LPJ,
  PERMISSION_NONPUMK,
  STATUS_TERMINAL_NON_PUMK,
  TRANSISI_SAH_NON_PUMK,
  type StatusProposalNonPumk,
} from "./contract";
import {
  buatDunia,
  keSen,
  DISETUJUI_BAKU,
  DIAJUKAN_BAKU,
  REALISASI_BAKU,
  SISA_BAKU,
  selisihHari,
  tambahHari,
  HARI_INI_BAKU,
  type DuniaNonPumk,
} from "./test-support";

let d: DuniaNonPumk;

beforeAll(async () => {
  d = await buatDunia();
}, 60_000);

afterAll(async () => {
  if (d) await d.tutup();
});

describe("dunia uji", () => {
  test("izin setiap konteks dibaca dari matriks grant yang dikirim, bukan dari literal", () => {
    // Spec 2's wewenang column, as the database holds it. A fixture that wrote
    // these arrays by hand would assert against its own opinion; that is how
    // `jurnal.update` / `jurnal.delete` being grantable to nobody stayed
    // invisible for a whole phase.
    expect(d.ctx.maker.permissions).toContain(PERMISSION_NONPUMK.CREATE);
    expect(d.ctx.maker.permissions).toContain(PERMISSION_NONPUMK.PENILAIAN);
    expect(d.ctx.maker.permissions).toContain(PERMISSION_NONPUMK.PENYALURAN);
    expect(d.ctx.maker.permissions).toContain(PERMISSION_NONPUMK.LPJ);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_NONPUMK.REVIEW);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_NONPUMK.APPROVE);

    expect(d.ctx.checker.permissions).toContain(PERMISSION_NONPUMK.REVIEW);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.CREATE);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.APPROVE);
    // The Checker cannot file an LPJ either: filing is input, and spec 2 says
    // the Checker inputs nothing.
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.LPJ);

    expect(d.ctx.approver.permissions).toContain(PERMISSION_NONPUMK.APPROVE);
    expect(d.ctx.approver.permissions).not.toContain(PERMISSION_NONPUMK.CREATE);
    expect(d.ctx.approver.permissions).not.toContain(PERMISSION_NONPUMK.REVIEW);

    // Read only PENUH, and nothing else.
    expect(d.ctx.auditor.permissions).toContain(PERMISSION_NONPUMK.VIEW);
    for (const izin of [
      PERMISSION_NONPUMK.CREATE,
      PERMISSION_NONPUMK.PENILAIAN,
      PERMISSION_NONPUMK.REVIEW,
      PERMISSION_NONPUMK.APPROVE,
      PERMISSION_NONPUMK.PENYALURAN,
      PERMISSION_NONPUMK.LPJ,
    ]) {
      expect(d.ctx.auditor.permissions).not.toContain(izin);
    }

    // ADMIN_CABANG is the only shipped role holding create AND review AND
    // approve, which is what makes spec 2 rules 1 and 2 testable at all: the
    // conflict only exists for someone who could legitimately play both parts.
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_NONPUMK.CREATE);
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_NONPUMK.REVIEW);
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_NONPUMK.APPROVE);
  });

  test("scope cabang: hanya Admin Pusat dan Auditor melihat lebih dari satu cabang (spec 2 aturan 3)", () => {
    for (const nama of ["maker", "checker", "approver", "adminCabang"] as const) {
      expect(d.ctx[nama].cabangDalamScope).toEqual([d.cabangId]);
    }
    expect(d.ctx.makerLain.cabangDalamScope).toEqual([d.cabangLainId]);
    for (const nama of ["adminPusat", "auditor"] as const) {
      expect(d.ctx[nama].cabangDalamScope).toEqual([d.cabangId, d.cabangLainId]);
    }
  });

  test("dua bidang, dua akun beban, dan bidang B benar benar punya akunnya sendiri", async () => {
    // Spec 6.4: PENYALURAN_NON_PUMK debits "Beban Penyaluran Non PUMK (PER
    // BIDANG)". Bidang A rides the shipped pooled 5.1.03 so the return journal
    // nets against it; bidang B has its own postable account so the per-bidang
    // DEBIT leg is provable rather than assumed.
    expect(d.bidang.akunBeban.id).toBe(d.akun.bebanNonPumk.id);
    expect(d.bidangLain.akunBeban.id).not.toBe(d.akun.bebanNonPumk.id);

    const akun = await d.db.query<{ tipe: string; is_postable: boolean; level: number }>(
      `select tipe, is_postable, level from akun where id = $1 and deleted_at is null`,
      [d.bidangLain.akunBeban.id],
    );
    expect(akun).toHaveLength(1);
    expect(akun[0].tipe).toBe("BEBAN");
    // Only a postable leaf can carry a journal line, so a fixture account that
    // was not postable would make every bidang-B test fail for the wrong reason.
    expect(akun[0].is_postable).toBe(true);
  });

  test("SDG diambil dari katalog global lewat upsert, jadi dua run berturut turut sama", async () => {
    // `sdg_nomor_uq` is UNIQUE (nomor) with NO bumn scoping, so this is the one
    // key in the fixture that cannot go through `kunci()`. Upserting by nomor
    // and reading back is what makes a second consecutive run without
    // `db:reset` give the identical answer.
    expect(d.sdg.map((s) => s.nomor)).toEqual([1, 4, 13]);
    for (const s of d.sdg) {
      const baris = await d.db.query<{ n: number }>(
        `select count(*)::int as n from sdg where nomor = $1 and deleted_at is null`,
        [s.nomor],
      );
      // Exactly one live row per nomor: a second world must have reused it, not
      // inserted a duplicate.
      expect(baris[0].n).toBe(1);
    }
  });

  test("siapkanProposal membangun setiap status TANPA menulis satu pun baris timeline", async () => {
    // The precondition builder writes business rows in SQL and NO transition
    // row, which is what lets every timeline assertion elsewhere mean "the
    // ENGINE wrote this".
    const semua: StatusProposalNonPumk[] = [
      "DRAFT",
      "PENILAIAN",
      "REVIEW_CHECKER",
      "MENUNGGU_PERSETUJUAN",
      "DISETUJUI",
      "DISALURKAN",
      "MENUNGGU_LPJ",
      "LPJ_DIAJUKAN",
      "SELESAI",
      "TIDAK_DIREKOMENDASIKAN",
      "DITOLAK",
      "LPJ_DITOLAK",
    ];
    for (const status of semua) {
      const f = await d.siapkanProposal(status);
      const p = await d.bacaProposal(f.proposalId);
      expect(p.status).toBe(status);
      expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
      // Spec 9.2's two mandatory mappings are present on every precondition, so
      // a test about something else never trips over a missing one.
      expect(p.bidang_id).toBe(f.bidangId);
      expect((await d.bacaSdg(f.proposalId)).length).toBeGreaterThanOrEqual(1);
      expect(p.penerima_manfaat_estimasi).toBeGreaterThan(0);
    }
  }, 120_000);

  test("prasyarat DISALURKAN memakai ledger nyata: jurnal POSTED, jalur ENGINE, FK terisi", async () => {
    const f = await d.siapkanProposal("DISALURKAN");
    const penyaluran = await d.bacaPenyaluran(f.proposalId);
    expect(penyaluran).toHaveLength(1);
    expect(penyaluran[0].jumlah).toBe(DISETUJUI_BAKU);
    // The FK to `jurnal` is real and NON-DEFERRABLE (migrations/0010), so this
    // id can only have come from a journal that actually exists.
    expect(penyaluran[0].jurnal_id).toBeTruthy();

    const header = await d.bacaJurnal(penyaluran[0].jurnal_id as string);
    expect(header.status).toBe("POSTED");
    // migrations/0020: only the engine's path may stamp ENGINE. A hand-written
    // journal row would have been refused by TJSL-JRN-015 outright.
    expect(header.jalur_posting).toBe("ENGINE");
    expect(header.total_debit).toBe(DISETUJUI_BAKU);
    expect(header.total_kredit).toBe(DISETUJUI_BAKU);

    const efek = await d.efekBukuBesar(f.proposalId);
    expect(efek.beban).toBe(DISETUJUI_BAKU);
    // Money out of the door: the cash side is negative by exactly the same
    // amount.
    expect(keSen(efek.kas)).toBe(-keSen(DISETUJUI_BAKU));
  }, 30_000);

  test("prasyarat SELESAI dengan sisa memasang jurnal pengembalian, dan beban bersih = realisasi", async () => {
    // This is scenario 9's arithmetic, built by the fixture through the REAL
    // ledger so the LPJ tests start from a state the real path produced: 40 juta
    // out, 30 juta realised, 10 juta back, net expense 30 juta.
    const f = await d.siapkanProposal("SELESAI", { jumlahRealisasi: REALISASI_BAKU });
    expect(f.sisaDikembalikan).toBe(SISA_BAKU);

    const lpj = await d.bacaLpj(f.proposalId);
    expect(lpj).toHaveLength(1);
    expect(lpj[0].status).toBe("DIVERIFIKASI");
    expect(lpj[0].jumlah_realisasi).toBe(REALISASI_BAKU);
    expect(lpj[0].jumlah_sisa_dikembalikan).toBe(SISA_BAKU);
    expect(lpj[0].jurnal_id_pengembalian).toBeTruthy();

    const efek = await d.efekBukuBesar(f.proposalId);
    expect(efek.beban).toBe(REALISASI_BAKU);
    expect(keSen(efek.kas)).toBe(-keSen(REALISASI_BAKU));
  }, 30_000);

  test("prasyarat multi termin menulis termin berurutan tanpa melewati pagu", async () => {
    const f = await d.siapkanProposal("MENUNGGU_LPJ", {
      terminPenyaluran: ["15000000.00", "15000000.00", "10000000.00"],
    });
    const penyaluran = await d.bacaPenyaluran(f.proposalId);
    expect(penyaluran.map((p) => p.termin)).toEqual([1, 2, 3]);
    expect(f.totalDisalurkan).toBe(DISETUJUI_BAKU);
    // Three separate journals, one per termin, because each termin is its own
    // business act and its own cash movement.
    expect(new Set(penyaluran.map((p) => p.jurnal_id)).size).toBe(3);
    // TJSL-NPK-002 is DEFERRED, so it fired at COMMIT of the fixture's writes
    // and passing here means the running total really is within the ceiling.
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);
  }, 30_000);

  test("tabel transisi kontrak sama persis dengan diagram spec 9.2", () => {
    // Diffable against the spec line by line. A missing edge is visible here
    // rather than buried in control flow.
    const tepi = TRANSISI_SAH_NON_PUMK.map((t) => `${t.dari} -${t.aksi}-> ${t.ke}`);
    expect(tepi).toEqual([
      "DRAFT -AJUKAN_PENILAIAN-> PENILAIAN",
      "PENILAIAN -INPUT_PENILAIAN-> REVIEW_CHECKER",
      "REVIEW_CHECKER -REKOMENDASI-> MENUNGGU_PERSETUJUAN",
      "REVIEW_CHECKER -TIDAK_REKOMENDASI-> TIDAK_DIREKOMENDASIKAN",
      "REVIEW_CHECKER -MINTA_PERBAIKAN-> PENILAIAN",
      "MENUNGGU_PERSETUJUAN -SETUJU-> DISETUJUI",
      "MENUNGGU_PERSETUJUAN -TOLAK-> DITOLAK",
      "MENUNGGU_PERSETUJUAN -KEMBALIKAN-> REVIEW_CHECKER",
      "DISETUJUI -PENYALURAN-> DISALURKAN",
      "DISALURKAN -PENYALURAN-> DISALURKAN",
      "DISALURKAN -TUTUP_PENYALURAN-> MENUNGGU_LPJ",
      "MENUNGGU_LPJ -AJUKAN_LPJ-> LPJ_DIAJUKAN",
      "LPJ_DIAJUKAN -VERIFIKASI_LPJ-> SELESAI",
      "LPJ_DIAJUKAN -TOLAK_LPJ-> LPJ_DITOLAK",
      "LPJ_DITOLAK -AJUKAN_LPJ-> LPJ_DIAJUKAN",
    ]);
    // The spec's own parenthesis: "LPJ_DITOLAK (kembali ke LPJ_DIAJUKAN)".
    expect(tepi).toContain("LPJ_DITOLAK -AJUKAN_LPJ-> LPJ_DIAJUKAN");

    // Exactly the five edges that reject or send back demand a note.
    const wajib = TRANSISI_SAH_NON_PUMK.filter((t) => t.catatanWajib).map((t) => String(t.aksi));
    expect(wajib.sort()).toEqual(
      ["KEMBALIKAN", "MINTA_PERBAIKAN", "TIDAK_REKOMENDASI", "TOLAK", "TOLAK_LPJ"].sort(),
    );

    // Terminal states have no outgoing edge, and nothing else is terminal.
    expect(STATUS_TERMINAL_NON_PUMK.map(String).sort()).toEqual(
      ["DITOLAK", "SELESAI", "TIDAK_DIREKOMENDASIKAN"].sort(),
    );
    for (const status of STATUS_TERMINAL_NON_PUMK) {
      expect(TRANSISI_SAH_NON_PUMK.filter((t) => t.dari === status)).toHaveLength(0);
    }
  });

  test("ambang aging adalah 30, 60, 90 dari spec, bukan parameter konfigurasi", () => {
    // Spec 9.2 names the three thresholds itself, so they are a constant. The
    // LPJ DEADLINE (which decides `terlambat`) is the undecided policy and IS
    // read from konfigurasi; the two must not be confused.
    expect([...AMBANG_UMUR_LPJ]).toEqual([30, 60, 90]);
  });

  test("aritmetika tanggal fixture konsisten dengan jam yang disuntikkan", () => {
    // The ageing tests count backwards from `HARI_INI_BAKU`, so a drift between
    // that constant and the injected clock would move every bucket by a day.
    expect(d.jam().toISOString().slice(0, 10)).toBe(HARI_INI_BAKU);
    expect(selisihHari(tambahHari(HARI_INI_BAKU, -30), HARI_INI_BAKU)).toBe(30);
    expect(selisihHari(tambahHari(HARI_INI_BAKU, -90), HARI_INI_BAKU)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// The two standing findings of Fase 4
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The three findings of Fase 4, now DISCHARGED
//
// Each of these three tests used to assert THE OPPOSITE of what it asserts now,
// and the note explaining why is kept rather than deleted. That is the point of
// filing a gap as a failing assertion instead of a line in a report: the pin
// went red the day the gap closed, which is what brought anyone back here, and
// the argument for the shape of the fix is the argument that was written down
// while the gap was still open. Deleting it would leave three fixes with no
// recorded reason, which is how a correction gets undone by the next person who
// finds the code surprising.
// ---------------------------------------------------------------------------

describe("temuan yang sudah ditutup", () => {
  test("TEMUAN 1 (ditutup): nonpumk.lpj.verifikasi ada di katalog dan dipegang Checker, bukan Maker", () => {
    // THIS TEST USED TO ASSERT `canonicalPermission(...) === null` FOR EVERY
    // ROLE, including ADMIN_PUSAT, because spec 4.5 gives nonpumk_lpj a
    // DIVERIFIKASI status with verified_by / verified_at and the shipped
    // catalogue had no code for that act. It was filed as a standing demand
    // rather than worked around, the catalogue owner added the code, and the
    // assertion now inverts to the ordinary authorisation rule.
    //
    // The three reuses this suite argued against are still wrong and still
    // absent. `nonpumk.lpj` is the MAKER's own filing code, so reusing it would
    // let the author of a report sign it off. `nonpumk.approve` is the decision
    // to RELEASE the money, so reusing it would make one grant of authority
    // cover both ends of the same transaction. `nonpumk.review` is the proposal
    // review, a different control at a different moment.
    //
    // It went to CHECKER, for the reason `jurnal.verify` did: verifying is a
    // decision ON SOMEONE ELSE'S FILING, not an input, so spec 2's "Checker
    // tidak bisa input data baru" is untouched. ADMIN_CABANG inherits it,
    // ADMIN_PUSAT through the spread of PERMISSIONS.
    expect(canonicalPermission(PERMISSION_NONPUMK.LPJ_VERIFIKASI)).toBe(
      PERMISSION_NONPUMK.LPJ_VERIFIKASI,
    );
    // EVERY code this module guards is now in the catalogue, with no exception
    // left to carve out.
    for (const [nama, kode] of Object.entries(PERMISSION_NONPUMK)) {
      expect(`${nama}:${canonicalPermission(kode)}`).toBe(`${nama}:${kode}`);
    }
  });

  test("TEMUAN 1 (ditutup): hibah itu benar benar sampai ke database, bukan cuma ke katalog", () => {
    // A code in PERMISSIONS that no role holds is exactly the failure mode the
    // finding was about (`jurnal.update` / `jurnal.delete` were in the
    // catalogue and grantable to nobody). So the assertion that matters is not
    // "the constant exists" but "a context built from the SHIPPED grant matrix,
    // read out of the database by `permissionsForRole`, carries it".
    expect(d.ctx.checker.permissions).toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
    expect(d.ctx.adminPusat.permissions).toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);

    // And the two roles that must NOT hold it, which is the whole content of
    // the control: the Maker files the LPJ, the Approver released the money.
    expect(d.ctx.maker.permissions).toContain(PERMISSION_NONPUMK.LPJ);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
    expect(d.ctx.approver.permissions).not.toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
    // Read only stays read only.
    expect(d.ctx.auditor.permissions).not.toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
  });

  test("TEMUAN 2 (ditutup): pengembalian mengkredit akun beban PER BIDANG, simetris dengan penyalurannya", async () => {
    // THIS TEST USED TO ASSERT `kredit_dari_payload = false` AND
    // `akun_kredit_id = 5.1.03`, which is what the shipped row carried. Spec
    // 6.4 makes the DEBIT of PENYALURAN_NON_PUMK an expense account per bidang
    // and the row did that; the refund bound its CREDIT to the pooled account,
    // and modules/jurnal ignores `akunKreditId` unless the row says otherwise.
    // So for a bidang with its own expense account the money went OUT of that
    // account and came BACK into the pooled one: the bidang's expense stayed
    // overstated by exactly the refund and the pooled account drifted negative
    // by exactly the same amount. Both journals balance to the sen, so the
    // trial balance and every closing check passed and the only place it showed
    // was the per-bidang penyaluran report, months later.
    //
    // A PAYLOAD LEG THAT IS NOT MIRRORED BY ITS REVERSE IS A BUG, and that is
    // the rule the corrected catalogue now states. migrations/0023 carries the
    // same correction to databases that had already been seeded, because the
    // seed is ON CONFLICT DO NOTHING and the catalogue change alone would never
    // have reached them.
    const map = await d.db.query<{
      debit_dari_payload: boolean;
      kredit_dari_payload: boolean;
      akun_kredit_id: string | null;
      akun_debit_id: string | null;
    }>(
      `select debit_dari_payload, kredit_dari_payload,
              akun_kredit_id::text as akun_kredit_id, akun_debit_id::text as akun_debit_id
         from event_jurnal_mapping
        where bumn_id = $1 and event_code = 'PENGEMBALIAN_SISA_NON_PUMK'
          and aktif and deleted_at is null`,
      [d.bumnId],
    );
    expect(map).toHaveLength(1);
    expect(map[0].kredit_dari_payload).toBe(true);
    // No account on the row at all: leaving the old 5.1.03 there while the flag
    // says "from payload" would be a value nothing reads, waiting to be
    // believed by the next person who greps for it.
    expect(map[0].akun_kredit_id).toBeNull();
    // The cash leg stays bound, and is overridden per posting by the form.
    expect(map[0].akun_debit_id).toBe(d.akun.kas.id);

    // The disbursement side is unchanged, and the two are now mirror images:
    // one leg from the payload each, on opposite sides.
    const salur = await d.db.query<{ debit_dari_payload: boolean; kredit_dari_payload: boolean }>(
      `select debit_dari_payload, kredit_dari_payload from event_jurnal_mapping
        where bumn_id = $1 and event_code = 'PENYALURAN_NON_PUMK' and aktif and deleted_at is null`,
      [d.bumnId],
    );
    expect(salur).toHaveLength(1);
    expect(salur[0].debit_dari_payload).toBe(true);
    expect(salur[0].kredit_dari_payload).toBe(false);
  });

  test("TEMUAN 2 (ditutup): jalur pengembalian FIXTURE juga per bidang, bukan hanya jalur engine", async () => {
    // The finding was never about a flag; it was about a number in a report.
    // The engine-side discharge lives in ./nonpumk-lpj.test.ts; this one covers
    // the FIXTURE's own `kembalikanSisaLewatEngine`, which is the single test
    // the fix broke (it posted the refund without an `akunKreditId`, which the
    // corrected mapping now rejects as EVENT_PAYLOAD_TIDAK_LENGKAP). A
    // precondition built here has to be indistinguishable in the ledger from
    // one the engine produced, or every SELESAI-based assertion elsewhere is
    // measuring the fixture rather than the module.
    //
    // So: a grant on `bidangLain`, whose expense account is its OWN and not the
    // pooled 5.1.03, must end with its own account carrying exactly the
    // realisation. Under the old mapping this read the full disbursement and
    // the pooled account carried the refund as a negative.
    const f = await d.siapkanProposal("SELESAI", {
      bidang: d.bidangLain,
      jumlahRealisasi: REALISASI_BAKU,
    });
    const bidangSendiri = await d.db.query<{ nilai: string }>(
      `select coalesce(sum(b.debit - b.kredit), 0)::numeric(20,2)::text as nilai
         from jurnal_baris b
         join jurnal j on j.id = b.jurnal_id
        where b.akun_id = $1 and j.status = 'POSTED'
          and j.deleted_at is null and b.deleted_at is null
          and j.referensi_id in (
                select id from nonpumk_penyaluran where proposal_id = $2
                union
                select id from nonpumk_lpj where proposal_id = $2)`,
      [d.bidangLain.akunBeban.id, f.proposalId],
    );
    expect(bidangSendiri[0].nilai).toBe(REALISASI_BAKU);
    // And the pooled account was never touched by this grant at all.
    const kolektif = await d.db.query<{ n: number }>(
      `select count(*)::int as n
         from jurnal_baris b
         join jurnal j on j.id = b.jurnal_id
        where b.akun_id = $1 and b.deleted_at is null
          and j.referensi_id in (
                select id from nonpumk_penyaluran where proposal_id = $2
                union
                select id from nonpumk_lpj where proposal_id = $2)`,
      [d.akun.bebanNonPumk.id, f.proposalId],
    );
    expect(kolektif[0].n).toBe(0);
  }, 30_000);

  test("TEMUAN 3 (ditutup): keempat parameter Non PUMK dikirim sebagai baris global", async () => {
    // THIS TEST USED TO ASSERT `toHaveLength(0)`. Spec 5.5 "Batasan Program"
    // lists only the PUMK limits, so migrations/0004 shipped 21 global rows and
    // not one of them was Non PUMK, which made the whole Non PUMK path
    // unreachable on a fresh install: the engine reads `konfigurasi` and fails
    // closed, correctly, on a row that is not there.
    //
    // migrations/0022 ships the four as GLOBAL rows with
    // `perlu_konfirmasi = true`, and ASSUMPTIONS.md A-41 to A-44 record them as
    // INVENTED values awaiting the client's written confirmation rather than as
    // spec defaults. That distinction is the reason no test in this folder
    // asserts any of the numbers: they assert the mechanic, and this one
    // asserts only that the rows exist and are flagged as undecided.
    const global = await d.db.query<{ kunci: string; tipe_data: string; perlu_konfirmasi: boolean }>(
      `select kunci, tipe_data, perlu_konfirmasi from konfigurasi
        where bumn_id is null and deleted_at is null
          and kunci in ('nilai_min_non_pumk', 'nilai_max_non_pumk',
                        'skor_penilaian_minimum_lolos_non_pumk', 'batas_hari_lpj_non_pumk')
        order by kunci`,
    );
    expect(global.map((r) => r.kunci)).toEqual([
      "batas_hari_lpj_non_pumk",
      "nilai_max_non_pumk",
      "nilai_min_non_pumk",
      "skor_penilaian_minimum_lolos_non_pumk",
    ]);
    for (const r of global) {
      expect(r.tipe_data).toBe("NUMBER");
      // Invented, not confirmed: the Konfigurasi screen has to show them as
      // pending, or an assumption becomes a policy by silence.
      expect(`${r.kunci}:${r.perlu_konfirmasi}`).toBe(`${r.kunci}:true`);
    }

    // The world still seeds its OWN bumn-scoped rows, and those still win. That
    // is what keeps one file's threshold change from leaking into another's.
    const perWorld = await d.db.query<{ n: number }>(
      `select count(*)::int as n from konfigurasi
        where bumn_id = $1 and deleted_at is null
          and kunci in ('nilai_min_non_pumk', 'nilai_max_non_pumk',
                        'skor_penilaian_minimum_lolos_non_pumk', 'batas_hari_lpj_non_pumk')`,
      [d.bumnId],
    );
    expect(perWorld[0].n).toBe(4);
  });
});

describe("konstanta fixture", () => {
  test("angka baku dipilih supaya tidak ada assertion yang butuh kalkulator", () => {
    expect(keSen(DIAJUKAN_BAKU)).toBe(5_000_000_000n);
    expect(keSen(DISETUJUI_BAKU)).toBe(4_000_000_000n);
    // 40 juta disalurkan, 30 juta direalisasi, 10 juta kembali.
    expect(keSen(REALISASI_BAKU) + keSen(SISA_BAKU)).toBe(keSen(DISETUJUI_BAKU));
  });
});
