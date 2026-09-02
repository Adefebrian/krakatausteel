// apps/api/src/modules/laporan/test-support-operasional.ts
//
// THE OPERATIONAL WORLD the twenty-three reports of spec 10.1, 10.2, 10.4 and
// report 21 are read against, layered on ./test-support.ts's accounting world
// rather than replacing it: reports 21 and 23 have to agree about the same
// ledger, so there can only be one.
//
// FIVE THINGS THIS FIXTURE IS BUILT TO MAKE FALSIFIABLE. Every figure below is
// chosen so that no assertion in the operational suite can pass vacuously.
//
//  1. THE DISBURSEMENT FIGURE IS THE LEDGER'S, NOT `pumk_pencairan`'s. Akad A6
//     is disbursed 40.000.000 on 28 March and the journal is REVERSED on 31
//     March. Its sector (S03) therefore prints 0,00 in every one of reports 1,
//     2, 3 and 7, while a POSTED-only reading -- the ADR 0010 bug -- would
//     print MINUS 40.000.000, because it drops the original and keeps the
//     reversal. The two readings differ by a number the tests compute, so
//     "this report uses v_ledger_baris" is a measurement and not a claim.
//
//  2. A PARTNER FUNDED TWICE IS ONE PARTNER. M002 settled a 2025 loan (A0) and
//     takes A2 in March, so report 7 has a genuine "mitra lama" and report 9
//     has a card with two contracts on it.
//
//     AND THE SCHEMA IS WHY IT HAD TO BE A SETTLED ONE.
//     `pumk_akad_satu_aktif_per_mitra_uq` is a partial unique index on
//     `mitra_id` over the statuses BELUM_CAIR, AKTIF, RESCHEDULED and MACET, so
//     a partner may hold at most ONE LIVE LOAN. Every akad carrying an
//     outstanding balance is in one of those statuses, which means the case
//     ./kontrak-operasional.ts describes for report 8 -- "a partner holding
//     several akads can therefore legitimately show two [buckets]" -- is NOT
//     reachable on valid data. The report handles it correctly anyway; this
//     fixture does not manufacture it, because a fixture that violates a
//     shipped unique index is not evidence about anything.
//
//  3. A PARTNER WITH NO ADDRESS IS NOT DROPPED. M003 has no `kota_id`, so
//     report 1's total can only tie to report 2's if the unknown-region row is
//     printed rather than silently lost.
//
//  4. A RESCHEDULED AKAD HAS TWO SCHEDULE VERSIONS. A2 carries a SUPERSEDED
//     version 1 whose instalments fall inside report 5's window and an ACTIVE
//     version 2 whose first one falls in the same window. A report that forgot
//     `is_active_version` would print both and double the loan.
//
//  5. AN OVERPAYMENT EXISTS. M001's second receipt allocates 500.000 to
//     `alokasi_kelebihan`, so report 4's Total column can only add up if the
//     third component prints (spec 16 scenario 6).
//
// ONE THING THIS FIXTURE DOES NOT DERIVE, SAID PLAINLY. `hari_tunggakan` and
// `kolektibilitas` on the snapshot rows are CHOSEN to land one akad in each
// aging band, not computed from the instalment schedule. That is honest rather
// than lazy: the reports read those columns verbatim, exactly because one
// closing run produced them together with the rate that used them (ADR 0014),
// so the thing under test is the bucketing and the totalling. Driving
// modules/closing to obtain them would make every report failure a cascade
// through another module's mid-flight work, which is the same argument
// ./test-support.ts's `bekukanDanTutup` makes about freezing balances.
//
// AND IT WRITES NO JOURNAL BY HAND. Every ledger line here goes through the
// REAL journal engine (`postingJurnal`, `reversalJurnal`), so invariant 11 and
// the posting-path trigger hold in the fixture exactly as they do in
// production. The operational TABLES (`pumk_akad`, `kolektibilitas_snapshot`
// and the rest) are inserted directly, because the engines that own them are
// other modules and driving them here would make a report failure a cascade
// through somebody else's mid-flight refactor.
import { createJurnalModule, type Jurnal, type JurnalContext } from "../jurnal/index";
import { buatEngineOperasional } from "./engine-operasional";
import type { LaporanOperasionalEngine } from "./kontrak-operasional";
import type { LaporanTx, Uang } from "./contract";
import { buatDunia, kunci, rp, type DuniaLaporan, type PeriodeFixture } from "./test-support";

// ---------------------------------------------------------------------------
// The numbers, ALL OF THEM, in one place
// ---------------------------------------------------------------------------

/**
 * Every monetary and calendar constant the operational suite asserts against.
 * Exported so a test states `NILAI.pencairanA2` rather than a literal that has
 * to be kept in step with this file by hand, which is how a fixture and its
 * assertions drift into agreeing about the wrong thing.
 */
export const NILAI = {
  // --- disbursements, by akad ---------------------------------------------
  pencairanA1: rp(100_000_000),
  pencairanA2: rp(200_000_000),
  pencairanA3: rp(50_000_000),
  pencairanA4: rp(30_000_000),
  pencairanA5: rp(70_000_000),
  /** Posted then REVERSED. Nets to zero in the ledger; the row survives. */
  pencairanA6: rp(40_000_000),

  /** Cabang A, March 2026: A2 + A3 + A4 + (A6 reversed to nothing). */
  penyaluranMaretCabangA: rp(280_000_000),
  /** The same plus A5, which is in the other branch. */
  penyaluranMaretSemuaCabang: rp(350_000_000),
  /** Cabang A, 1 January to 31 March: the above plus A1 in February. */
  penyaluranYtdCabangA: rp(380_000_000),

  // --- receipts (report 4) -------------------------------------------------
  setoran1Pokok: rp(10_000_000),
  setoran1Jasa: rp(2_000_000),
  setoran1Total: rp(12_000_000),
  setoran2Pokok: rp(5_000_000),
  setoran2Jasa: rp(1_000_000),
  setoran2Kelebihan: rp(500_000),
  setoran2Total: rp(6_500_000),
  setoranMaretPokok: rp(15_000_000),
  setoranMaretJasa: rp(3_000_000),
  setoranMaretKelebihan: rp(500_000),
  setoranMaretTotal: rp(18_500_000),

  // --- proposals (report 6) ------------------------------------------------
  diajukanMaretCabangA: rp(400_000_000),
  disetujuiMaretCabangA: rp(320_000_000),

  // --- collectibility (reports 8, 10, 11, 28) ------------------------------
  outstandingA1: rp(85_000_000),
  outstandingA2: rp(200_000_000),
  outstandingA3: rp(50_000_000),
  outstandingA4: rp(30_000_000),
  outstandingA5: rp(70_000_000),
  outstandingCabangA: rp(365_000_000),
  penyisihanA1: rp(425_000),
  penyisihanA2: rp(20_000_000),
  penyisihanA3: rp(25_000_000),
  penyisihanA4: rp(30_000_000),
  penyisihanCabangA: rp(75_425_000),
  penyisihanSaldoAwalCabangA: rp(5_000_000),
  penyisihanBebanCabangA: rp(70_425_000),
  penyisihanCabangB: rp(350_000),

  // --- accrued fee (report 30) --------------------------------------------
  akrualJatuhTempo: rp(7_000_000),
  akrualDiterima: rp(2_000_000),
  akrualDiakrual: rp(4_000_000),

  // --- Non PUMK (reports 12 to 15) -----------------------------------------
  np1Disetujui: rp(50_000_000),
  np1Termin1: rp(30_000_000),
  np1Termin2: rp(20_000_000),
  np2Disetujui: rp(40_000_000),
  np2Termin1: rp(40_000_000),
  np3Disetujui: rp(20_000_000),
  np3Termin1: rp(20_000_000),
  np4Disetujui: rp(30_000_000),
  np4Termin1: rp(30_000_000),
  nonPumkMaretCabangA: rp(90_000_000),
  np1Realisasi: rp(48_000_000),
  np1Sisa: rp(2_000_000),

  // --- budgets -------------------------------------------------------------
  anggaranSektor1Maret: rp(100_000_000),
  anggaranSektor2Maret: rp(150_000_000),
  anggaranSektor3Maret: rp(20_000_000),
  /** `rka_detail.bulan IS NULL`: a whole-year line, in YTD only. */
  anggaranSektor3Tahunan: rp(500_000_000),
  anggaranBidang1Maret: rp(60_000_000),
  anggaranBidang2Maret: rp(30_000_000),
  anggaranBidang3Tahunan: rp(100_000_000),

  // --- report 21 -----------------------------------------------------------
  /** DRAFT, so it reaches no balance and only Rekap Jurnal can see it. */
  draftBelumDiposting: rp(1_234_567),
  /** Cabang A, March: POSTED plus REVERSED debits, which is the ledger. */
  rekapJurnalTerbukukanMaretCabangA: rp(430_425_000),
} as const;

export const TANGGAL = {
  /** The world's clock, and therefore every `tanggalCetak` and every "today". */
  cetak: "2026-03-31",
  /** Report 5's forward window. */
  jatuhTempoDari: "2026-04-01",
  jatuhTempoSampai: "2026-06-30",
} as const;

/** Report 5's expected window contents, as (due date, days from the clock). */
export const JATUH_TEMPO_HARI = {
  a1Ke2: 1,
  a4Ke1: 15,
  a1Ke3: 31,
  a1Ke4: 62,
  a2V2Ke1: 76,
} as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface WilayahFixture {
  provinsiId: string;
  provinsiNama: string;
  kotaId: string;
  kotaNama: string;
}

export interface MitraFixture {
  id: string;
  kode: string;
  nama: string;
  cabangId: string;
}

export interface AkadFixture {
  id: string;
  noAkad: string;
  proposalId: string;
  mitraId: string;
  cabangId: string;
  /** The POSTED disbursement journal, or the one that was later reversed. */
  jurnalId: string | null;
}

export interface DimensiFixture {
  id: string;
  kode: string;
  nama: string;
}

export interface DuniaOperasional {
  /** The accounting world underneath, with its ledger, users and periods. */
  d: DuniaLaporan;
  engine: LaporanOperasionalEngine;
  buatEngine(opsi?: { jam?: () => Date }): LaporanOperasionalEngine;

  periodeLaporan: PeriodeFixture;
  /** February 2026, for a window a KUMULATIF_YTD run must reach and a BULANAN one must not. */
  periodeSebelum: PeriodeFixture;

  wilayah: Record<"banten" | "jabar", WilayahFixture>;
  /** Banten's second city, where the OTHER branch's partner lives. */
  kotaSerang: { id: string; nama: string };
  sektor: Record<"s1" | "s2" | "s3", DimensiFixture>;
  bidang: Record<"b1" | "b2" | "b3", DimensiFixture>;
  sdgId(nomor: number): string;

  mitra: Record<"m1" | "m2" | "m3" | "m4" | "m5" | "m6", MitraFixture>;
  akad: Record<"a0" | "a1" | "a2" | "a3" | "a4" | "a5" | "a6", AkadFixture>;
  proposal: Record<"p0" | "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7", string>;
  nonpumk: Record<"np1" | "np2" | "np3" | "np4", string>;
  submission: Record<"ps1" | "ps2" | "ps3" | "ps4", string>;

  /** The reversing journal of A6, so a test can name both halves of the pair. */
  jurnalReversalA6: string;
  /** The one DRAFT in the world, which only report 21 may see. */
  jurnalDraftId: string;
  /** `entitas` on the audit rows this fixture wrote, and nothing else's. */
  entitasAudit: string;

  /**
   * The disbursement total a POSTED-ONLY reading would produce for one sector,
   * which is the ADR 0010 bug's own answer. Exists so a test can assert the
   * report DISAGREES with it rather than merely agreeing with the right value
   * on data where both readings coincide.
   */
  penyaluranNaifPostedSaja(
    sektorId: string,
    dari: string,
    sampai: string,
    cabangIds: readonly string[],
  ): Promise<Uang>;

  tutup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export async function buatDuniaOperasional(): Promise<DuniaOperasional> {
  const d = await buatDunia();
  const db = d.db;
  const penulis = d.userId.adminPusat;
  const ctxJurnal = d.ctx.adminPusat as JurnalContext;

  // A SECOND JOURNAL ENGINE, AND ONLY BECAUSE OF THE REVERSAL. Spec 6.3 makes
  // `reversalJurnal` REFUSE a journal with a `referensi_tipe` that has no
  // registered business-state handler, which is right: a half reversal is
  // worse than none. modules/pumk owns the real handler; this one is a no-op
  // that exists so the fixture can produce the POSTED/REVERSED pair the ADR
  // 0010 assertion needs, and it undoes nothing because nothing here depends
  // on `pumk_akad` being rolled back.
  const jurnalOp = createJurnalModule({
    db,
    jam: d.jam,
    pembalikStateBisnis: [
      {
        referensiTipe: "pumk_pencairan",
        async balikkan() {
          /* the akad state this fixture asserts on is written directly below */
        },
      },
    ],
  }).engine;

  const tandai = kunci("op");
  const q = <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (db as LaporanTx).query<T>(sql, params);
  const satu = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
    const rows = await q<T>(sql, params);
    if (rows.length === 0) throw new Error(`fixture operasional: tidak ada baris untuk ${sql}`);
    return rows[0];
  };

  // ------------------------------------------------------------- geography
  //
  // Named so the sort order the reports promise is deterministic: report 1
  // orders provinces by NAME with the unknown bucket last, so "Banten" must
  // sort before "Jawa Barat" and both before "(Wilayah belum diisi)".
  async function buatProvinsi(nama: string): Promise<string> {
    const row = await satu<{ id: string }>(
      `insert into provinsi (kode_bps, nama, created_by, updated_by)
       values ($1, $2, $3, $3) returning id::text as id`,
      [`PRV-${tandai}-${nama.slice(0, 3)}`, nama, penulis],
    );
    return row.id;
  }
  async function buatKota(provinsiId: string, nama: string): Promise<string> {
    const row = await satu<{ id: string }>(
      `insert into kota (provinsi_id, kode_bps, nama, tipe, created_by, updated_by)
       values ($1::uuid, $2, $3, 'KOTA', $4, $4) returning id::text as id`,
      [provinsiId, `KOT-${tandai}-${nama.slice(0, 3)}`, nama, penulis],
    );
    return row.id;
  }

  const provBanten = await buatProvinsi(`Banten ${tandai}`);
  const provJabar = await buatProvinsi(`Jawa Barat ${tandai}`);
  const kotaCilegon = await buatKota(provBanten, `Cilegon ${tandai}`);
  const kotaSerang = await buatKota(provBanten, `Serang ${tandai}`);
  const kotaBandung = await buatKota(provJabar, `Bandung ${tandai}`);

  // ------------------------------------------------------------- dimensions
  async function buatSektor(kode: string, nama: string, urutan: number): Promise<DimensiFixture> {
    const row = await satu<{ id: string }>(
      `insert into sektor_pumk (bumn_id, kode, nama, urutan, created_by, updated_by)
       values ($1::uuid, $2, $3, $4, $5, $5) returning id::text as id`,
      [d.bumnId, kode, nama, urutan, penulis],
    );
    return { id: row.id, kode, nama };
  }
  async function buatBidang(kode: string, nama: string, urutan: number): Promise<DimensiFixture> {
    const row = await satu<{ id: string }>(
      `insert into bidang_non_pumk (bumn_id, kode, nama, urutan, created_by, updated_by)
       values ($1::uuid, $2, $3, $4, $5, $5) returning id::text as id`,
      [d.bumnId, kode, nama, urutan, penulis],
    );
    return { id: row.id, kode, nama };
  }

  const s1 = await buatSektor("S01", "Perdagangan", 1);
  const s2 = await buatSektor("S02", "Industri", 2);
  const s3 = await buatSektor("S03", "Jasa", 3);
  const b1 = await buatBidang("B01", "Pendidikan", 1);
  const b2 = await buatBidang("B02", "Lingkungan", 2);
  const b3 = await buatBidang("B03", "Kesehatan", 3);

  const sdgRows = await q<{ id: string; nomor: number }>(
    `select id::text as id, nomor::int as nomor from sdg where deleted_at is null order by nomor`,
  );
  const petaSdg = new Map(sdgRows.map((s) => [Number(s.nomor), s.id]));

  // ----------------------------------------------------------------- mitra
  async function buatMitra(opsi: {
    kode: string;
    nama: string;
    cabangId: string;
    kotaId: string | null;
    sektorId: string | null;
    jenisKelamin: "L" | "P" | null;
    tanggalLahir: string | null;
    tahunMulaiUsaha: number | null;
    tenagaKerja: number | null;
    omzet: Uang | null;
  }): Promise<MitraFixture> {
    const row = await satu<{ id: string }>(
      `insert into mitra
         (cabang_id, kode_mitra, nama_lengkap, jenis_kelamin, tanggal_lahir, kota_id,
          sektor_id, tahun_mulai_usaha, jumlah_tenaga_kerja, omzet_bulanan, status,
          created_by, updated_by)
       values ($1::uuid, $2, $3, $4, $5::date, $6::uuid, $7::uuid, $8, $9, $10::numeric,
               'AKTIF', $11, $11)
       returning id::text as id`,
      [
        opsi.cabangId,
        opsi.kode,
        opsi.nama,
        opsi.jenisKelamin,
        opsi.tanggalLahir,
        opsi.kotaId,
        opsi.sektorId,
        opsi.tahunMulaiUsaha,
        opsi.tenagaKerja,
        opsi.omzet,
        penulis,
      ],
    );
    return { id: row.id, kode: opsi.kode, nama: opsi.nama, cabangId: opsi.cabangId };
  }

  // Codes are what reports 4, 8 and 9 order by, so they are chosen to sort in
  // the order the tests read them in.
  const m1 = await buatMitra({
    kode: `MTR-${tandai}-001`,
    nama: "Ani Pertiwi",
    cabangId: d.cabangId,
    kotaId: kotaCilegon,
    sektorId: s1.id,
    jenisKelamin: "P",
    tanggalLahir: "1990-05-10",
    tahunMulaiUsaha: 2018,
    tenagaKerja: 3,
    omzet: rp(15_000_000),
  });
  const m2 = await buatMitra({
    kode: `MTR-${tandai}-002`,
    nama: "Budi Santoso",
    cabangId: d.cabangId,
    kotaId: kotaBandung,
    sektorId: s2.id,
    jenisKelamin: "L",
    tanggalLahir: "1975-02-20",
    tahunMulaiUsaha: 2010,
    tenagaKerja: 25,
    omzet: rp(250_000_000),
  });
  // EVERY OPTIONAL COLUMN NULL, on purpose: report 27's seven distributions
  // must still each foot to the same population, and report 1 must still tie.
  const m3 = await buatMitra({
    kode: `MTR-${tandai}-003`,
    nama: "Citra Dewi",
    cabangId: d.cabangId,
    kotaId: null,
    sektorId: null,
    jenisKelamin: null,
    tanggalLahir: null,
    tahunMulaiUsaha: null,
    tenagaKerja: null,
    omzet: null,
  });
  const m4 = await buatMitra({
    kode: `MTR-${tandai}-004`,
    nama: "Dedi Kurnia",
    cabangId: d.cabangLainId,
    kotaId: kotaSerang,
    sektorId: s2.id,
    jenisKelamin: "L",
    tanggalLahir: "1985-08-01",
    tahunMulaiUsaha: 2015,
    tenagaKerja: 8,
    omzet: rp(60_000_000),
  });
  // Two more partners, and they exist because of the one-live-loan index: A4
  // and A6 cannot hang off a partner who already holds a live akad, and every
  // demographic band in report 27 needs an occupant.
  const m5 = await buatMitra({
    kode: `MTR-${tandai}-005`,
    nama: "Eka Lestari",
    cabangId: d.cabangId,
    kotaId: kotaCilegon,
    sektorId: s1.id,
    jenisKelamin: "P",
    tanggalLahir: "1998-11-02",
    tahunMulaiUsaha: 2024,
    tenagaKerja: 0,
    omzet: rp(5_000_000),
  });
  const m6 = await buatMitra({
    kode: `MTR-${tandai}-006`,
    nama: "Fajar Nugroho",
    cabangId: d.cabangId,
    kotaId: kotaBandung,
    sektorId: s3.id,
    jenisKelamin: "L",
    tanggalLahir: "1960-01-15",
    tahunMulaiUsaha: 1995,
    tenagaKerja: 120,
    omzet: rp(900_000_000),
  });

  // ------------------------------------------------------------- proposals
  async function buatProposal(opsi: {
    no: string;
    mitraId: string;
    sektorId: string | null;
    cabangId: string;
    tanggal: string;
    diajukan: Uang;
    status: string;
    submissionId?: string | null;
  }): Promise<string> {
    const row = await satu<{ id: string }>(
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, mitra_id, sektor_id, jumlah_diajukan,
          tenor_diajukan, sumber_pengajuan, portal_submission_id, status, created_by, updated_by)
       values ($1::uuid, $2, $3::date, $4::uuid, $5::uuid, $6::numeric, 12,
               $7, $8::uuid, $9, $10, $10)
       returning id::text as id`,
      [
        opsi.cabangId,
        opsi.no,
        opsi.tanggal,
        opsi.mitraId,
        opsi.sektorId,
        opsi.diajukan,
        opsi.submissionId ? "PORTAL_ONLINE" : "INTERNAL",
        opsi.submissionId ?? null,
        opsi.status,
        penulis,
      ],
    );
    return row.id;
  }

  async function buatApproval(
    proposalId: string,
    tanggal: string,
    keputusan: "SETUJU" | "TOLAK",
    plafon: Uang | null,
  ): Promise<void> {
    await q(
      `insert into pumk_approval
         (proposal_id, approver_user_id, tanggal, keputusan, plafon_disetujui,
          tenor_disetujui, created_by, updated_by)
       values ($1::uuid, $2::uuid, $3::date, $4, $5::numeric, 12, $2, $2)`,
      [proposalId, penulis, tanggal, keputusan, plafon],
    );
  }

  // The portal submissions come first, because two proposals point at them and
  // `pumk_proposal_sumber_ck` makes the pair all-or-nothing.
  async function buatSubmission(opsi: {
    jenis: "PUMK" | "NON_PUMK";
    noTiket: string;
    waktu: string;
    status: "BARU" | "DIPROSES" | "DIKONVERSI" | "DITOLAK";
    dataJson: Record<string, unknown>;
  }): Promise<string> {
    const row = await satu<{ id: string }>(
      // DRIVER FACT: a jsonb parameter bound from a JS string becomes a JSON
      // SCALAR, so `$n::text::jsonb` is the cast, not `$n::jsonb`.
      `insert into portal_submission
         (bumn_id, jenis, no_tiket, tanggal_submit, data_json, status, created_by, updated_by)
       values ($1::uuid, $2, $3, $4::timestamptz, $5::text::jsonb, $6, $7, $7)
       returning id::text as id`,
      [
        d.bumnId,
        opsi.jenis,
        opsi.noTiket,
        opsi.waktu,
        JSON.stringify(opsi.dataJson),
        opsi.status,
        penulis,
      ],
    );
    return row.id;
  }

  const ps1 = await buatSubmission({
    jenis: "PUMK",
    noTiket: `TKT-${tandai}-001`,
    waktu: "2026-03-03T02:00:00Z",
    status: "BARU",
    // The form's own figure is deliberately WRONG. The converted proposal must
    // win, and a test asserts it does.
    dataJson: { namaPemohon: "Budi dari formulir", jumlahDiajukan: "999.00" },
  });
  const ps2 = await buatSubmission({
    jenis: "PUMK",
    noTiket: `TKT-${tandai}-002`,
    waktu: "2026-03-08T02:00:00Z",
    status: "BARU",
    dataJson: { nama: "Calon Belum Diproses", jumlah_diajukan: "75000000.00" },
  });
  const ps3 = await buatSubmission({
    jenis: "PUMK",
    noTiket: `TKT-${tandai}-003`,
    waktu: "2026-03-15T02:00:00Z",
    status: "DITOLAK",
    // Not a two-decimal amount, so the report must print NOTHING rather than
    // zero: zero would read as a real application for nothing.
    dataJson: { namaPemohon: "Pengaju Ditolak", jumlahDiajukan: "seratus juta" },
  });
  const ps4 = await buatSubmission({
    jenis: "NON_PUMK",
    noTiket: `TKT-${tandai}-004`,
    waktu: "2026-03-06T02:00:00Z",
    status: "BARU",
    dataJson: { namaPemohon: "Yayasan dari formulir" },
  });

  // P0 IS 2025's, AND IT IS WHAT MAKES A "MITRA LAMA" POSSIBLE. Its akad was
  // settled, so M002 may take a second live loan in March; report 7 counts a
  // partner as BARU only in the month of their FIRST akad ever.
  const p0 = await buatProposal({
    no: `PRP-${tandai}-000`,
    mitraId: m2.id,
    sektorId: s2.id,
    cabangId: d.cabangId,
    tanggal: "2025-05-20",
    diajukan: rp(20_000_000),
    status: "DICAIRKAN",
  });
  const p1 = await buatProposal({
    no: `PRP-${tandai}-001`,
    mitraId: m1.id,
    sektorId: s1.id,
    cabangId: d.cabangId,
    tanggal: "2026-01-15",
    diajukan: rp(120_000_000),
    status: "DICAIRKAN",
  });
  const p2 = await buatProposal({
    no: `PRP-${tandai}-002`,
    mitraId: m2.id,
    sektorId: s2.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-02",
    diajukan: rp(250_000_000),
    status: "DICAIRKAN",
    submissionId: ps1,
  });
  const p3 = await buatProposal({
    no: `PRP-${tandai}-003`,
    mitraId: m3.id,
    sektorId: s1.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-08",
    diajukan: rp(60_000_000),
    status: "DICAIRKAN",
  });
  const p4 = await buatProposal({
    no: `PRP-${tandai}-004`,
    mitraId: m5.id,
    sektorId: s1.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-14",
    diajukan: rp(30_000_000),
    status: "DICAIRKAN",
  });
  const p5 = await buatProposal({
    no: `PRP-${tandai}-005`,
    mitraId: m4.id,
    sektorId: s2.id,
    cabangId: d.cabangLainId,
    tanggal: "2026-03-18",
    diajukan: rp(80_000_000),
    status: "DICAIRKAN",
  });
  const p6 = await buatProposal({
    no: `PRP-${tandai}-006`,
    mitraId: m6.id,
    sektorId: s3.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-20",
    diajukan: rp(40_000_000),
    status: "DICAIRKAN",
  });
  const p7 = await buatProposal({
    no: `PRP-${tandai}-007`,
    mitraId: m1.id,
    sektorId: s1.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-25",
    diajukan: rp(20_000_000),
    status: "DITOLAK",
  });

  await buatApproval(p0, "2025-05-25", "SETUJU", rp(20_000_000));
  await buatApproval(p1, "2026-01-25", "SETUJU", rp(100_000_000));
  // TWO approvals on one proposal, and the LATER one must win. Spec 16
  // scenario 3 lets an approver change the plafond, so a report that picked an
  // arbitrary row would silently report a superseded figure.
  await buatApproval(p2, "2026-03-03", "SETUJU", rp(180_000_000));
  await buatApproval(p2, "2026-03-05", "SETUJU", rp(200_000_000));
  await buatApproval(p3, "2026-03-09", "SETUJU", rp(50_000_000));
  await buatApproval(p4, "2026-03-15", "SETUJU", rp(30_000_000));
  await buatApproval(p5, "2026-03-19", "SETUJU", rp(70_000_000));
  await buatApproval(p6, "2026-03-21", "SETUJU", rp(40_000_000));
  await buatApproval(p7, "2026-03-26", "TOLAK", null);

  await q(
    `update portal_submission set status = 'DIKONVERSI', converted_proposal_id = $2::uuid
      where id = $1::uuid`,
    [ps1, p2],
  );

  // ------------------------------------------------------------------ akad
  async function buatAkad(opsi: {
    no: string;
    proposalId: string;
    mitraId: string;
    cabangId: string;
    tanggal: string;
    pokok: Uang;
    outstandingPokok: Uang;
    outstandingJasa: Uang;
    status: string;
    mulaiAngsuran: string;
    jatuhTempoAkhir: string;
    tenor: number;
    /** `pumk_akad_lunas_ck` makes this mandatory once the status is LUNAS. */
    tanggalLunas?: string | null;
  }): Promise<string> {
    const row = await satu<{ id: string }>(
      `insert into pumk_akad
         (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
          jasa_adm_rate, tenor_bulan, tanggal_mulai_angsuran, tanggal_jatuh_tempo_akhir,
          status, outstanding_pokok, outstanding_jasa, tanggal_lunas, created_by, updated_by)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::numeric, 0.03, $7,
               $8::date, $9::date, $10, $11::numeric, $12::numeric, $14::date, $13, $13)
       returning id::text as id`,
      [
        opsi.proposalId,
        opsi.mitraId,
        opsi.cabangId,
        opsi.no,
        opsi.tanggal,
        opsi.pokok,
        opsi.tenor,
        opsi.mulaiAngsuran,
        opsi.jatuhTempoAkhir,
        opsi.status,
        opsi.outstandingPokok,
        opsi.outstandingJasa,
        penulis,
        opsi.tanggalLunas ?? null,
      ],
    );
    return row.id;
  }

  // A0: settled in 2025, so it carries no outstanding, appears in no
  // collectibility snapshot, and leaves M002 free to hold A2.
  const a0 = await buatAkad({
    no: `AKD-${tandai}-000`,
    proposalId: p0,
    mitraId: m2.id,
    cabangId: d.cabangId,
    tanggal: "2025-06-01",
    pokok: rp(20_000_000),
    outstandingPokok: rp(0),
    outstandingJasa: rp(0),
    status: "LUNAS",
    mulaiAngsuran: "2025-12-01",
    jatuhTempoAkhir: "2025-12-01",
    tenor: 1,
    tanggalLunas: "2025-12-05",
  });
  const a1 = await buatAkad({
    no: `AKD-${tandai}-001`,
    proposalId: p1,
    mitraId: m1.id,
    cabangId: d.cabangId,
    tanggal: "2026-02-01",
    pokok: NILAI.pencairanA1,
    outstandingPokok: NILAI.outstandingA1,
    outstandingJasa: rp(3_000_000),
    status: "AKTIF",
    mulaiAngsuran: "2026-03-01",
    jatuhTempoAkhir: "2026-12-01",
    tenor: 10,
  });
  const a2 = await buatAkad({
    no: `AKD-${tandai}-002`,
    proposalId: p2,
    mitraId: m2.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-01",
    pokok: NILAI.pencairanA2,
    outstandingPokok: NILAI.outstandingA2,
    outstandingJasa: rp(4_000_000),
    status: "RESCHEDULED",
    mulaiAngsuran: "2026-04-15",
    jatuhTempoAkhir: "2026-07-15",
    tenor: 4,
  });
  const a3 = await buatAkad({
    no: `AKD-${tandai}-003`,
    proposalId: p3,
    mitraId: m3.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-10",
    pokok: NILAI.pencairanA3,
    outstandingPokok: NILAI.outstandingA3,
    outstandingJasa: rp(1_000_000),
    status: "AKTIF",
    mulaiAngsuran: "2026-09-01",
    jatuhTempoAkhir: "2026-09-01",
    tenor: 1,
  });
  const a4 = await buatAkad({
    no: `AKD-${tandai}-004`,
    proposalId: p4,
    mitraId: m5.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-15",
    pokok: NILAI.pencairanA4,
    outstandingPokok: NILAI.outstandingA4,
    outstandingJasa: rp(500_000),
    status: "MACET",
    mulaiAngsuran: "2026-04-15",
    jatuhTempoAkhir: "2026-04-15",
    tenor: 1,
  });
  const a5 = await buatAkad({
    no: `AKD-${tandai}-005`,
    proposalId: p5,
    mitraId: m4.id,
    cabangId: d.cabangLainId,
    tanggal: "2026-03-20",
    pokok: NILAI.pencairanA5,
    outstandingPokok: NILAI.outstandingA5,
    outstandingJasa: rp(0),
    status: "AKTIF",
    mulaiAngsuran: "2026-05-10",
    jatuhTempoAkhir: "2026-05-10",
    tenor: 1,
  });
  // REVERSED. The akad never really left BELUM_CAIR and owes nothing; the
  // journal pair is what the reports have to net to zero.
  const a6 = await buatAkad({
    no: `AKD-${tandai}-006`,
    proposalId: p6,
    mitraId: m6.id,
    cabangId: d.cabangId,
    tanggal: "2026-03-25",
    pokok: NILAI.pencairanA6,
    outstandingPokok: rp(0),
    outstandingJasa: rp(0),
    status: "BELUM_CAIR",
    mulaiAngsuran: "2026-10-01",
    jatuhTempoAkhir: "2026-10-01",
    tenor: 1,
  });

  // ------------------------------------------------------- schedule versions
  async function buatVersiJadwal(
    akadId: string,
    versi: number,
    aktif: boolean,
    berlaku: string,
    rescheduleId: string | null,
  ): Promise<void> {
    await q(
      `insert into pumk_jadwal_versi
         (akad_id, versi, is_active_version, status, tanggal_berlaku, reschedule_id,
          created_by, updated_by)
       values ($1::uuid, $2, $3, $4, $5::date, $6::uuid, $7, $7)`,
      [akadId, versi, aktif, aktif ? "ACTIVE" : "SUPERSEDED", berlaku, rescheduleId, penulis],
    );
  }

  interface BarisJadwal {
    ke: number;
    jatuhTempo: string;
    pokok: Uang;
    jasa: Uang;
    total: Uang;
    saldoSetelah: Uang;
    status: string;
    pokokTerbayar?: Uang;
    jasaTerbayar?: Uang;
    tanggalLunas?: string | null;
  }

  /**
   * ONE MULTI-ROW INSERT PER VERSION. `trg_pumk_jadwal_50_total_pokok` is a
   * DEFERRED constraint trigger that checks the version's instalments against
   * `pumk_akad.pokok_pinjaman`, so a half-inserted version is refused; writing
   * the rows one statement at a time would work only by accident of the
   * deferral.
   */
  async function buatJadwal(akadId: string, versi: number, baris: BarisJadwal[]): Promise<void> {
    const params: unknown[] = [akadId, penulis];
    const nilai = baris.map((b) => {
      params.push(
        versi,
        b.ke,
        b.jatuhTempo,
        b.pokok,
        b.jasa,
        b.total,
        b.saldoSetelah,
        b.status,
        b.pokokTerbayar ?? rp(0),
        b.jasaTerbayar ?? rp(0),
        b.tanggalLunas ?? null,
      );
      const n = params.length;
      return `($1::uuid, $${n - 10}, $${n - 9}, $${n - 8}::date, $${n - 7}::numeric,
               $${n - 6}::numeric, $${n - 5}::numeric, $${n - 4}::numeric, $${n - 3},
               $${n - 2}::numeric, $${n - 1}::numeric, $${n}::date, $2, $2)`;
    });
    await q(
      `insert into pumk_jadwal_angsuran
         (akad_id, versi, angsuran_ke, tanggal_jatuh_tempo, pokok, jasa_adm, total,
          saldo_pokok_setelah, status, pokok_terbayar, jasa_terbayar, tanggal_lunas,
          created_by, updated_by)
       values ${nilai.join(", ")}`,
      params,
    );
  }

  await buatVersiJadwal(a0, 1, true, "2025-12-01", null);
  await buatJadwal(a0, 1, [
    {
      ke: 1,
      jatuhTempo: "2025-12-01",
      pokok: rp(20_000_000),
      jasa: rp(600_000),
      total: rp(20_600_000),
      saldoSetelah: rp(0),
      status: "LUNAS",
      pokokTerbayar: rp(20_000_000),
      jasaTerbayar: rp(600_000),
      tanggalLunas: "2025-12-05",
    },
  ]);

  await buatVersiJadwal(a1, 1, true, "2026-03-01", null);
  await buatJadwal(a1, 1, [
    {
      ke: 1,
      jatuhTempo: "2026-03-01",
      pokok: rp(10_000_000),
      jasa: rp(2_000_000),
      total: rp(12_000_000),
      saldoSetelah: rp(90_000_000),
      status: "LUNAS",
      pokokTerbayar: rp(10_000_000),
      jasaTerbayar: rp(2_000_000),
      tanggalLunas: "2026-03-08",
    },
    {
      ke: 2,
      jatuhTempo: "2026-04-01",
      pokok: rp(10_000_000),
      jasa: rp(2_000_000),
      total: rp(12_000_000),
      saldoSetelah: rp(80_000_000),
      status: "SEBAGIAN",
      pokokTerbayar: rp(5_000_000),
      jasaTerbayar: rp(1_000_000),
    },
    // Instalment 1 falls due in March and one a month after that, so 3, 4 and 5
    // land inside report 5's 1 April to 30 June window and 6 to 10 do not.
    ...[3, 4, 5, 6, 7, 8, 9, 10].map((ke) => ({
      ke,
      jatuhTempo: `2026-${String(ke + 2).padStart(2, "0")}-01`,
      pokok: rp(10_000_000),
      jasa: rp(2_000_000),
      total: rp(12_000_000),
      saldoSetelah: rp((10 - ke) * 10_000_000),
      status: "BELUM_JATUH_TEMPO",
    })),
  ]);

  // A2 IS RESCHEDULED, and both versions have instalments inside report 5's
  // window. Version 1 must not print.
  const reschedule = await satu<{ id: string }>(
    `insert into pumk_reschedule
       (akad_id, tanggal_pengajuan, alasan, jenis, tenor_baru, jadwal_versi_lama,
        jadwal_versi_baru, status, approved_by, approved_at, outstanding_pokok_sebelum,
        created_by, updated_by)
     values ($1::uuid, '2026-03-26'::date, 'Perpanjangan tenor (fixture operasional)',
             'PERPANJANG_TENOR', 4, 1, 2, 'DISETUJUI', $2::uuid, now(), $3::numeric, $2, $2)
     returning id::text as id`,
    [a2, penulis, NILAI.pencairanA2],
  );
  await buatVersiJadwal(a2, 1, false, "2026-04-15", null);
  await buatJadwal(a2, 1, [
    {
      ke: 1,
      jatuhTempo: "2026-04-15",
      pokok: rp(100_000_000),
      jasa: rp(20_000_000),
      total: rp(120_000_000),
      saldoSetelah: rp(100_000_000),
      status: "BELUM_JATUH_TEMPO",
    },
    {
      ke: 2,
      jatuhTempo: "2026-05-15",
      pokok: rp(100_000_000),
      jasa: rp(20_000_000),
      total: rp(120_000_000),
      saldoSetelah: rp(0),
      status: "BELUM_JATUH_TEMPO",
    },
  ]);
  await buatVersiJadwal(a2, 2, true, "2026-06-15", reschedule.id);
  await buatJadwal(a2, 2, [
    {
      ke: 1,
      jatuhTempo: "2026-06-15",
      pokok: rp(100_000_000),
      jasa: rp(4_000_000),
      total: rp(104_000_000),
      saldoSetelah: rp(100_000_000),
      status: "BELUM_JATUH_TEMPO",
    },
    {
      ke: 2,
      jatuhTempo: "2026-07-15",
      pokok: rp(100_000_000),
      jasa: rp(4_000_000),
      total: rp(104_000_000),
      saldoSetelah: rp(0),
      status: "BELUM_JATUH_TEMPO",
    },
  ]);

  for (const [akadId, jatuhTempo, pokok, jasa] of [
    [a3, "2026-09-01", NILAI.pencairanA3, rp(1_000_000)],
    [a4, "2026-04-15", NILAI.pencairanA4, rp(600_000)],
    [a5, "2026-05-10", NILAI.pencairanA5, rp(1_400_000)],
    [a6, "2026-10-01", NILAI.pencairanA6, rp(800_000)],
  ] as const) {
    await buatVersiJadwal(akadId, 1, true, jatuhTempo, null);
    await buatJadwal(akadId, 1, [
      {
        ke: 1,
        jatuhTempo,
        pokok,
        jasa,
        total: rp(Number(pokok.split(".")[0]) + Number(jasa.split(".")[0])),
        saldoSetelah: rp(0),
        status: "BELUM_JATUH_TEMPO",
      },
    ]);
  }

  // ------------------------------------------------------------ disbursement
  //
  // THROUGH THE REAL JOURNAL ENGINE. The receivable leg carries `akadId`, and
  // the header carries `referensiTipe = 'pumk_pencairan'`; together they are
  // exactly what reports 1, 2, 3 and 7 select on and what modules/rka reads for
  // report 24, so the two can be asserted equal instead of merely coincident.
  async function postingPencairan(
    akadId: string,
    mitraId: string,
    tanggal: string,
    jumlah: Uang,
    diCabangLain = false,
  ): Promise<Jurnal> {
    return d.postingJurnal({
      tanggal,
      jenis: "KAS_BANK",
      keterangan: `Pencairan PUMK ${tanggal} (fixture operasional)`,
      diCabangLain,
      referensiTipe: "pumk_pencairan",
      referensiId: akadId,
      baris: [
        { akun: "piutangPokok", debit: jumlah, mitraId, akadId },
        { akun: "kas", kredit: jumlah },
      ],
    });
  }

  const jurnalA0 = await postingPencairan(a0, m2.id, "2025-06-05", rp(20_000_000));
  const jurnalA1 = await postingPencairan(a1, m1.id, "2026-02-10", NILAI.pencairanA1);
  const jurnalA2 = await postingPencairan(a2, m2.id, "2026-03-05", NILAI.pencairanA2);
  const jurnalA3 = await postingPencairan(a3, m3.id, "2026-03-12", NILAI.pencairanA3);
  const jurnalA4 = await postingPencairan(a4, m1.id, "2026-03-20", NILAI.pencairanA4);
  const jurnalA5 = await postingPencairan(a5, m4.id, "2026-03-25", NILAI.pencairanA5, true);
  const jurnalA6 = await postingPencairan(a6, m2.id, "2026-03-28", NILAI.pencairanA6);
  const reversalA6 = await jurnalOp.reversalJurnal(
    jurnalA6.id,
    "Pencairan dibatalkan (fixture operasional)",
    ctxJurnal,
  );

  async function buatPencairan(
    akadId: string,
    tanggal: string,
    jumlah: Uang,
    jurnalId: string,
    no: string,
  ): Promise<void> {
    await q(
      `insert into pumk_pencairan
         (akad_id, tanggal_pencairan, jumlah, akun_kas_id, no_bukti, jurnal_id,
          created_by, updated_by)
       values ($1::uuid, $2::date, $3::numeric, $4::uuid, $5, $6::uuid, $7, $7)`,
      [akadId, tanggal, jumlah, d.akun.kas.id, no, jurnalId, penulis],
    );
  }
  await buatPencairan(a0, "2025-06-05", rp(20_000_000), jurnalA0.id, `PC-${tandai}-000`);
  await buatPencairan(a1, "2026-02-10", NILAI.pencairanA1, jurnalA1.id, `PC-${tandai}-001`);
  await buatPencairan(a2, "2026-03-05", NILAI.pencairanA2, jurnalA2.id, `PC-${tandai}-002`);
  await buatPencairan(a3, "2026-03-12", NILAI.pencairanA3, jurnalA3.id, `PC-${tandai}-003`);
  await buatPencairan(a4, "2026-03-20", NILAI.pencairanA4, jurnalA4.id, `PC-${tandai}-004`);
  await buatPencairan(a5, "2026-03-25", NILAI.pencairanA5, jurnalA5.id, `PC-${tandai}-005`);
  // NOTHING FOR A6. Its journal was reversed, so the money never left; a
  // `pumk_pencairan` row would make report 9's card claim a disbursement the
  // ledger says did not happen.

  // ---------------------------------------------------------------- receipts
  async function buatAngsuran(opsi: {
    akadId: string;
    tanggal: string;
    diterima: Uang;
    pokok: Uang;
    jasa: Uang;
    kelebihan: Uang;
    no: string;
  }): Promise<void> {
    await q(
      `insert into pumk_angsuran
         (akad_id, tanggal_terima, tanggal_valuta, jumlah_diterima, alokasi_pokok,
          alokasi_jasa, alokasi_kelebihan, akun_kas_id, no_bukti, created_by, updated_by)
       values ($1::uuid, $2::date, $2::date, $3::numeric, $4::numeric, $5::numeric,
               $6::numeric, $7::uuid, $8, $9, $9)`,
      [
        opsi.akadId,
        opsi.tanggal,
        opsi.diterima,
        opsi.pokok,
        opsi.jasa,
        opsi.kelebihan,
        d.akun.kas.id,
        opsi.no,
        penulis,
      ],
    );
  }

  // 2025, and it settles A0 in full. Outside every 2026 window this suite
  // reports on, and the reason report 9's card for M002 has a closed contract
  // above a live one.
  await buatAngsuran({
    akadId: a0,
    tanggal: "2025-12-05",
    diterima: rp(20_600_000),
    pokok: rp(20_000_000),
    jasa: rp(600_000),
    kelebihan: rp(0),
    no: `BKT-${tandai}-000`,
  });
  await buatAngsuran({
    akadId: a1,
    tanggal: "2026-03-08",
    diterima: NILAI.setoran1Total,
    pokok: NILAI.setoran1Pokok,
    jasa: NILAI.setoran1Jasa,
    kelebihan: rp(0),
    no: `BKT-${tandai}-001`,
  });
  // THE OVERPAYMENT. `pumk_angsuran_alokasi_ck` makes the three components add
  // up to what was received, so report 4's Total column only foots if the
  // third one prints.
  await buatAngsuran({
    akadId: a1,
    tanggal: "2026-03-18",
    diterima: NILAI.setoran2Total,
    pokok: NILAI.setoran2Pokok,
    jasa: NILAI.setoran2Jasa,
    kelebihan: NILAI.setoran2Kelebihan,
    no: `BKT-${tandai}-002`,
  });
  // February, so a BULANAN March run must NOT see it and a KUMULATIF_YTD one
  // must. ALLOCATED ENTIRELY TO `kelebihan`, because it arrived before the
  // first instalment fell due: nothing was owed yet, so nothing could be
  // allocated to principal or fee. That also keeps report 9's card arithmetic
  // exact -- the akad's own `outstanding_pokok` moves only when principal is
  // allocated, so a prepayment must not move the card's running balance either.
  await buatAngsuran({
    akadId: a1,
    tanggal: "2026-02-20",
    diterima: rp(3_000_000),
    pokok: rp(0),
    jasa: rp(0),
    kelebihan: rp(3_000_000),
    no: `BKT-${tandai}-003`,
  });
  // The other branch, so a branch-scoped run must not see it.
  await buatAngsuran({
    akadId: a5,
    tanggal: "2026-03-22",
    diterima: rp(1_000_000),
    pokok: rp(1_000_000),
    jasa: rp(0),
    kelebihan: rp(0),
    no: `BKT-${tandai}-004`,
  });

  // ------------------------------------------------- collectibility snapshot
  const periodeLaporan = d.periodeLaporan();
  const periodeSebelum = d.periode(2026, 2);

  async function buatSnapshot(opsi: {
    akadId: string;
    mitraId: string;
    cabangId: string;
    sektorId: string | null;
    hari: number;
    kelas: string;
    outstandingPokok: Uang;
    outstandingJasa: Uang;
    tunggakanPokok: Uang;
    rate: string;
    penyisihan: Uang;
    kelasLalu: string | null;
  }): Promise<void> {
    await q(
      `insert into kolektibilitas_snapshot
         (periode_id, akad_id, mitra_id, cabang_id, sektor_id,
          tanggal_jatuh_tempo_tertunggak_tertua, hari_tunggakan, kolektibilitas,
          outstanding_pokok, outstanding_jasa, tunggakan_pokok, tunggakan_jasa,
          rate_penyisihan, dasar_perhitungan, nilai_penyisihan,
          kolektibilitas_periode_lalu, sumber_rate, created_by, updated_by)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7, $8,
               $9::numeric, $10::numeric, $11::numeric, 0, $12::numeric,
               'OUTSTANDING_POKOK', $13::numeric, $14, 'TABEL_KONFIGURASI', $15, $15)`,
      [
        periodeLaporan.id,
        opsi.akadId,
        opsi.mitraId,
        opsi.cabangId,
        opsi.sektorId,
        opsi.hari === 0 ? null : "2026-01-15",
        opsi.hari,
        opsi.kelas,
        opsi.outstandingPokok,
        opsi.outstandingJasa,
        opsi.tunggakanPokok,
        opsi.rate,
        opsi.penyisihan,
        opsi.kelasLalu,
        penulis,
      ],
    );
  }

  // One akad per aging bucket, so every band in report 8 is non-empty except
  // 91-180, which stays empty on purpose: an empty band must still print 0,00.
  await buatSnapshot({
    akadId: a1,
    mitraId: m1.id,
    cabangId: d.cabangId,
    sektorId: s1.id,
    hari: 15,
    kelas: "LANCAR",
    outstandingPokok: NILAI.outstandingA1,
    outstandingJasa: rp(3_000_000),
    tunggakanPokok: rp(5_000_000),
    rate: "0.005000",
    penyisihan: NILAI.penyisihanA1,
    kelasLalu: null,
  });
  await buatSnapshot({
    akadId: a2,
    mitraId: m2.id,
    cabangId: d.cabangId,
    sektorId: s2.id,
    hari: 45,
    kelas: "KURANG_LANCAR",
    outstandingPokok: NILAI.outstandingA2,
    outstandingJasa: rp(4_000_000),
    tunggakanPokok: rp(20_000_000),
    rate: "0.100000",
    penyisihan: NILAI.penyisihanA2,
    kelasLalu: "LANCAR",
  });
  await buatSnapshot({
    akadId: a3,
    mitraId: m3.id,
    cabangId: d.cabangId,
    sektorId: s1.id,
    hari: 200,
    kelas: "DIRAGUKAN",
    outstandingPokok: NILAI.outstandingA3,
    outstandingJasa: rp(1_000_000),
    tunggakanPokok: rp(10_000_000),
    rate: "0.500000",
    penyisihan: NILAI.penyisihanA3,
    kelasLalu: "KURANG_LANCAR",
  });
  await buatSnapshot({
    akadId: a4,
    mitraId: m5.id,
    cabangId: d.cabangId,
    sektorId: s1.id,
    hari: 300,
    kelas: "MACET",
    outstandingPokok: NILAI.outstandingA4,
    outstandingJasa: rp(500_000),
    tunggakanPokok: rp(30_000_000),
    rate: "1.000000",
    penyisihan: NILAI.penyisihanA4,
    kelasLalu: "DIRAGUKAN",
  });
  await buatSnapshot({
    akadId: a5,
    mitraId: m4.id,
    cabangId: d.cabangLainId,
    sektorId: s2.id,
    hari: 5,
    kelas: "LANCAR",
    outstandingPokok: NILAI.outstandingA5,
    outstandingJasa: rp(0),
    tunggakanPokok: rp(2_000_000),
    rate: "0.005000",
    penyisihan: NILAI.penyisihanCabangB,
    kelasLalu: null,
  });

  // -------------------------------------------------- the provision run (29)
  //
  // ONE TRANSACTION PER RUN. `trg_penyisihan_periode_30_total_jurnal` is a
  // DEFERRED constraint trigger that refuses a run whose linked journals do not
  // sum to its stated movement, so the run and its links commit together or
  // not at all -- which is exactly the property report 29's
  // `selisihTautanJurnal` is allowed to assume is zero.
  const jurnalPenyisihanA = await d.postingJurnal({
    tanggal: "2026-03-31",
    jenis: "UMUM",
    keterangan: "Beban penyisihan Maret 2026 (fixture operasional)",
    baris: [
      { akun: "bebanPenyisihan", debit: NILAI.penyisihanBebanCabangA },
      { akun: "penyisihan", kredit: NILAI.penyisihanBebanCabangA },
    ],
  });
  const jurnalPenyisihanB = await d.postingJurnal({
    tanggal: "2026-03-31",
    jenis: "UMUM",
    keterangan: "Beban penyisihan Maret 2026 cabang lain (fixture operasional)",
    diCabangLain: true,
    baris: [
      { akun: "bebanPenyisihan", debit: NILAI.penyisihanCabangB },
      { akun: "penyisihan", kredit: NILAI.penyisihanCabangB },
    ],
  });

  async function buatRunPenyisihan(
    cabangId: string,
    saldoAwal: Uang,
    dibutuhkan: Uang,
    beban: Uang,
    jurnalId: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const row = await tx.query<{ id: string }>(
        `insert into penyisihan_periode
           (periode_id, cabang_id, saldo_penyisihan_awal, penyisihan_dibutuhkan,
            beban_penyisihan_periode, dijalankan_oleh, tanggal, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $6::uuid,
                 '2026-03-31'::date, $6, $6)
         returning id::text as id`,
        [periodeLaporan.id, cabangId, saldoAwal, dibutuhkan, beban, penulis],
      );
      await tx.query(
        `insert into penyisihan_periode_jurnal
           (penyisihan_periode_id, jurnal_id, nilai, created_by, updated_by)
         values ($1::uuid, $2::uuid, $3::numeric, $4, $4)`,
        [row[0].id, jurnalId, beban, penulis],
      );
    });
  }

  await buatRunPenyisihan(
    d.cabangId,
    NILAI.penyisihanSaldoAwalCabangA,
    NILAI.penyisihanCabangA,
    NILAI.penyisihanBebanCabangA,
    jurnalPenyisihanA.id,
  );
  await buatRunPenyisihan(
    d.cabangLainId,
    rp(0),
    NILAI.penyisihanCabangB,
    NILAI.penyisihanCabangB,
    jurnalPenyisihanB.id,
  );

  // ---------------------------------------------------- accrued fee (30)
  async function buatAkrual(
    akadId: string,
    cabangId: string,
    kelas: string,
    jatuhTempo: Uang,
    diterima: Uang,
    diakrual: Uang,
  ): Promise<void> {
    await q(
      `insert into akrual_jasa_snapshot
         (periode_id, akad_id, cabang_id, kolektibilitas, jasa_jatuh_tempo_periode,
          jasa_diterima_periode, jasa_diakrual, metode, kelas_diakrual,
          created_by, updated_by)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric,
               'ACCRUAL', $8::text::jsonb, $9, $9)`,
      [
        periodeLaporan.id,
        akadId,
        cabangId,
        kelas,
        jatuhTempo,
        diterima,
        diakrual,
        JSON.stringify(["LANCAR", "KURANG_LANCAR"]),
        penulis,
      ],
    );
  }
  await buatAkrual(a1, d.cabangId, "LANCAR", rp(2_000_000), rp(2_000_000), rp(0));
  await buatAkrual(a2, d.cabangId, "KURANG_LANCAR", rp(4_000_000), rp(0), rp(4_000_000));
  // Outside the accrued classes: a zero row that must still print, or a period
  // where the step ran and produced nothing looks like a period where it never ran.
  await buatAkrual(a3, d.cabangId, "DIRAGUKAN", rp(1_000_000), rp(0), rp(0));

  // ----------------------------------------------------------- Non PUMK
  async function buatProposalNonPumk(opsi: {
    no: string;
    pemohon: string;
    judul: string;
    bidangId: string;
    cabangId: string;
    tanggal: string;
    diajukan: Uang;
    disetujui: Uang;
    manfaat: number;
    status: string;
    submissionId?: string | null;
  }): Promise<string> {
    const row = await satu<{ id: string }>(
      `insert into nonpumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, nama_pemohon, bidang_id, judul_program,
          jumlah_diajukan, jumlah_disetujui, penerima_manfaat_estimasi, sumber_pengajuan,
          portal_submission_id, status, created_by, updated_by)
       values ($1::uuid, $2, $3::date, $4, $5::uuid, $6, $7::numeric, $8::numeric, $9,
               $10, $11::uuid, $12, $13, $13)
       returning id::text as id`,
      [
        opsi.cabangId,
        opsi.no,
        opsi.tanggal,
        opsi.pemohon,
        opsi.bidangId,
        opsi.judul,
        opsi.diajukan,
        opsi.disetujui,
        opsi.manfaat,
        opsi.submissionId ? "PORTAL_ONLINE" : "INTERNAL",
        opsi.submissionId ?? null,
        opsi.status,
        penulis,
      ],
    );
    return row.id;
  }

  const np1 = await buatProposalNonPumk({
    no: `NPK-${tandai}-001`,
    pemohon: "Yayasan Cerdas",
    judul: "Beasiswa Anak Pesisir",
    bidangId: b1.id,
    cabangId: d.cabangId,
    tanggal: "2026-02-01",
    diajukan: rp(60_000_000),
    disetujui: NILAI.np1Disetujui,
    manfaat: 100,
    status: "SELESAI",
    submissionId: ps4,
  });
  const np2 = await buatProposalNonPumk({
    no: `NPK-${tandai}-002`,
    pemohon: "Komunitas Hijau",
    judul: "Bank Sampah Warga",
    bidangId: b2.id,
    cabangId: d.cabangId,
    tanggal: "2026-02-05",
    diajukan: rp(40_000_000),
    disetujui: NILAI.np2Disetujui,
    manfaat: 50,
    status: "MENUNGGU_LPJ",
  });
  const np3 = await buatProposalNonPumk({
    no: `NPK-${tandai}-003`,
    pemohon: "Posyandu Sehat",
    judul: "Perbaikan Gizi Balita",
    bidangId: b1.id,
    cabangId: d.cabangId,
    tanggal: "2026-01-20",
    diajukan: rp(20_000_000),
    disetujui: NILAI.np3Disetujui,
    manfaat: 30,
    status: "MENUNGGU_LPJ",
  });
  const np4 = await buatProposalNonPumk({
    no: `NPK-${tandai}-004`,
    pemohon: "Sekolah Serang",
    judul: "Ruang Baca",
    bidangId: b2.id,
    cabangId: d.cabangLainId,
    tanggal: "2026-02-10",
    diajukan: rp(30_000_000),
    disetujui: NILAI.np4Disetujui,
    manfaat: 20,
    status: "MENUNGGU_LPJ",
  });

  await q(
    `update portal_submission set status = 'DIKONVERSI', converted_proposal_id = $2::uuid
      where id = $1::uuid`,
    [ps4, np1],
  );

  async function buatPenyaluranNonPumk(
    proposalId: string,
    termin: number,
    tanggal: string,
    jumlah: Uang,
    no: string,
  ): Promise<void> {
    await q(
      `insert into nonpumk_penyaluran
         (proposal_id, termin, tanggal_penyaluran, jumlah, akun_kas_id, akun_beban_id,
          no_bukti, created_by, updated_by)
       values ($1::uuid, $2, $3::date, $4::numeric, $5::uuid, $6::uuid, $7, $8, $8)`,
      [proposalId, termin, tanggal, jumlah, d.akun.kas.id, d.akun.bebanNonPumk.id, no, penulis],
    );
  }

  // NP1 IS PAID IN TWO TERMIN, which is why report 12 prints termin rows and
  // reports 13 and 14 count PROGRAMMES.
  await buatPenyaluranNonPumk(np1, 1, "2026-03-05", NILAI.np1Termin1, `NPB-${tandai}-001`);
  await buatPenyaluranNonPumk(np1, 2, "2026-03-20", NILAI.np1Termin2, `NPB-${tandai}-002`);
  await buatPenyaluranNonPumk(np2, 1, "2026-03-10", NILAI.np2Termin1, `NPB-${tandai}-003`);
  // February: inside a KUMULATIF_YTD window, outside a BULANAN one.
  await buatPenyaluranNonPumk(np3, 1, "2026-02-15", NILAI.np3Termin1, `NPB-${tandai}-004`);
  await buatPenyaluranNonPumk(np4, 1, "2026-03-12", NILAI.np4Termin1, `NPB-${tandai}-005`);

  await q(
    `insert into nonpumk_lpj
       (proposal_id, tanggal_lpj, jumlah_realisasi, jumlah_sisa_dikembalikan,
        penerima_manfaat_aktual, uraian_realisasi, status, verified_by, verified_at,
        created_by, updated_by)
     values ($1::uuid, '2026-03-25'::date, $2::numeric, $3::numeric, 120,
             'Realisasi beasiswa (fixture operasional)', 'DIVERIFIKASI', $4::uuid, now(),
             $4, $4)`,
    [np1, NILAI.np1Realisasi, NILAI.np1Sisa, penulis],
  );

  async function petakanSdg(proposalId: string, nomor: number[]): Promise<void> {
    for (const n of nomor) {
      await q(
        `insert into nonpumk_proposal_sdg (proposal_id, sdg_id, bobot, created_by)
         values ($1::uuid, $2::uuid, 1, $3)`,
        [proposalId, petaSdg.get(n), penulis],
      );
    }
  }
  // NP1 REACHES TWO GOALS, which is why report 14's `jumlahProgram` column sums
  // to more than `totalProgramUnik` and why it carries no money column at all.
  await petakanSdg(np1, [4, 10]);
  await petakanSdg(np2, [13]);
  await petakanSdg(np4, [4]);
  // NP3 is deliberately mapped to nothing, for the "(Belum dipetakan)" bucket.

  // --------------------------------------------------------------- budgets
  async function buatRka(jenis: "PUMK" | "NON_PUMK"): Promise<string> {
    const row = await satu<{ id: string }>(
      `insert into rka
         (bumn_id, cabang_id, tahun, jenis, status, versi, approved_by, approved_at,
          created_by, updated_by)
       values ($1::uuid, $2::uuid, 2026, $3, 'DISETUJUI', 1, $4::uuid, now(), $4, $4)
       returning id::text as id`,
      [d.bumnId, d.cabangId, jenis, penulis],
    );
    return row.id;
  }
  async function buatRkaDetail(
    rkaId: string,
    kolom: "sektor_id" | "bidang_id",
    dimensiId: string,
    bulan: number | null,
    jumlah: Uang,
  ): Promise<void> {
    await q(
      `insert into rka_detail (rka_id, ${kolom}, uraian, bulan, jumlah_anggaran, created_by, updated_by)
       values ($1::uuid, $2::uuid, 'Anggaran fixture operasional', $3, $4::numeric, $5, $5)`,
      [rkaId, dimensiId, bulan, jumlah, penulis],
    );
  }

  const rkaPumk = await buatRka("PUMK");
  await buatRkaDetail(rkaPumk, "sektor_id", s1.id, 3, NILAI.anggaranSektor1Maret);
  await buatRkaDetail(rkaPumk, "sektor_id", s2.id, 3, NILAI.anggaranSektor2Maret);
  await buatRkaDetail(rkaPumk, "sektor_id", s3.id, 3, NILAI.anggaranSektor3Maret);
  // `bulan IS NULL` is a WHOLE-YEAR line: excluded from a single month,
  // included in a year-to-date window. The rule modules/rka states for report
  // 24, pinned here on the same arithmetic.
  await buatRkaDetail(rkaPumk, "sektor_id", s3.id, null, NILAI.anggaranSektor3Tahunan);

  const rkaNonPumk = await buatRka("NON_PUMK");
  await buatRkaDetail(rkaNonPumk, "bidang_id", b1.id, 3, NILAI.anggaranBidang1Maret);
  await buatRkaDetail(rkaNonPumk, "bidang_id", b2.id, 3, NILAI.anggaranBidang2Maret);
  await buatRkaDetail(rkaNonPumk, "bidang_id", b3.id, null, NILAI.anggaranBidang3Tahunan);

  // ------------------------------------------------- a DRAFT, for report 21
  //
  // INVISIBLE TO EVERY OTHER REPORT AND THE POINT OF THIS ONE. `v_ledger_baris`
  // is POSTED plus REVERSED, so a DRAFT reaches no balance anywhere; report 21
  // prints it because "is there a DRAFT left in this month" is the question
  // closing check 1 refuses on and the main operational use of that page.
  const jurnalDraft = await d.buatJurnalDraft({
    tanggal: "2026-03-30",
    jenis: "UMUM",
    keterangan: "Draft yang belum diposting (fixture operasional)",
    baris: [
      { akun: "bebanOperasional", debit: NILAI.draftBelumDiposting },
      { akun: "kas", kredit: NILAI.draftBelumDiposting },
    ],
  });

  // ---------------------------------------------------------- audit trail
  //
  // `entitas` IS UNIQUE TO THIS WORLD. `bun test` runs files in parallel and
  // the journal engine writes audit rows of its own, so an assertion on a bare
  // row count would be a race. Every count in the report 31 tests filters on
  // this entity name.
  const entitasAudit = `laporan_op_${tandai}`;
  await q(
    `insert into audit_log (waktu, user_id, ip, aksi, entitas, entitas_id, hasil, keterangan)
     values
       ('2026-03-05T02:00:00Z'::timestamptz, $1::uuid, '10.0.0.1'::inet, 'BUAT', $3, 'x1', 'SUKSES', 'satu'),
       ('2026-03-10T02:00:00Z'::timestamptz, $1::uuid, '10.0.0.1'::inet, 'UBAH', $3, 'x2', 'SUKSES', 'dua'),
       ('2026-03-15T02:00:00Z'::timestamptz, $2::uuid, '10.0.0.2'::inet, 'HAPUS', $3, 'x3', 'DITOLAK', 'tiga'),
       ('2026-02-20T02:00:00Z'::timestamptz, $1::uuid, '10.0.0.1'::inet, 'BUAT', $3, 'x4', 'SUKSES', 'di luar jendela'),
       ('2026-03-12T02:00:00Z'::timestamptz, null, '10.0.0.9'::inet, 'LOGIN', $3, null, 'DITOLAK', 'tanpa user')`,
    [d.userId.adminPusat, d.userId.auditor, entitasAudit],
  );

  // ------------------------------------------------------------------ engine
  const engine = buatEngineOperasional({ db, jam: d.jam });

  const akad = (
    id: string,
    no: string,
    proposalId: string,
    mitraId: string,
    cabangId: string,
    jurnalId: string | null,
  ): AkadFixture => ({ id, noAkad: no, proposalId, mitraId, cabangId, jurnalId });

  return {
    d,
    engine,
    buatEngine: (opsi) => buatEngineOperasional({ db, jam: opsi?.jam ?? d.jam }),

    periodeLaporan,
    periodeSebelum,

    wilayah: {
      banten: {
        provinsiId: provBanten,
        provinsiNama: `Banten ${tandai}`,
        kotaId: kotaCilegon,
        kotaNama: `Cilegon ${tandai}`,
      },
      jabar: {
        provinsiId: provJabar,
        provinsiNama: `Jawa Barat ${tandai}`,
        kotaId: kotaBandung,
        kotaNama: `Bandung ${tandai}`,
      },
    },
    kotaSerang: { id: kotaSerang, nama: `Serang ${tandai}` },
    sektor: { s1, s2, s3 },
    bidang: { b1, b2, b3 },
    sdgId: (nomor) => {
      const id = petaSdg.get(nomor);
      if (!id) throw new Error(`fixture operasional: SDG ${nomor} tidak ada di master`);
      return id;
    },

    mitra: { m1, m2, m3, m4, m5, m6 },
    akad: {
      a0: akad(a0, `AKD-${tandai}-000`, p0, m2.id, d.cabangId, jurnalA0.id),
      a1: akad(a1, `AKD-${tandai}-001`, p1, m1.id, d.cabangId, jurnalA1.id),
      a2: akad(a2, `AKD-${tandai}-002`, p2, m2.id, d.cabangId, jurnalA2.id),
      a3: akad(a3, `AKD-${tandai}-003`, p3, m3.id, d.cabangId, jurnalA3.id),
      a4: akad(a4, `AKD-${tandai}-004`, p4, m5.id, d.cabangId, jurnalA4.id),
      a5: akad(a5, `AKD-${tandai}-005`, p5, m4.id, d.cabangLainId, jurnalA5.id),
      a6: akad(a6, `AKD-${tandai}-006`, p6, m6.id, d.cabangId, jurnalA6.id),
    },
    proposal: { p0, p1, p2, p3, p4, p5, p6, p7 },
    nonpumk: { np1, np2, np3, np4 },
    submission: { ps1, ps2, ps3, ps4 },
    jurnalReversalA6: reversalA6.id,
    jurnalDraftId: jurnalDraft.id,
    entitasAudit,

    async penyaluranNaifPostedSaja(sektorId, dari, sampai, cabangIds) {
      const params: unknown[] = [d.bumnId, dari, sampai, sektorId];
      const daftar = cabangIds
        .map((id) => {
          params.push(id);
          return `$${params.length}::uuid`;
        })
        .join(", ");
      const row = await satu<{ nilai: Uang }>(
        // THE ADR 0010 BUG, WRITTEN OUT. `status = 'POSTED'` alone drops the
        // reversed original and keeps its reversal, so a cancelled
        // disbursement leaves a NEGATIVE figure behind.
        `select coalesce(sum(b.debit - b.kredit), 0)::numeric(20,2)::text as nilai
           from jurnal_baris b
           join jurnal j on j.id = b.jurnal_id
           join pumk_akad ak on ak.id = b.akad_id
           join pumk_proposal pr on pr.id = ak.proposal_id
          where j.bumn_id = $1::uuid and j.status = 'POSTED' and j.deleted_at is null
            and b.deleted_at is null
            and j.tanggal_transaksi >= $2::date and j.tanggal_transaksi <= $3::date
            and j.referensi_tipe = 'pumk_pencairan'
            and pr.sektor_id = $4::uuid
            and j.cabang_id in (${daftar || "null::uuid"})`,
        params,
      );
      return row.nilai;
    },

    tutup: () => d.tutup(),
  };
}
