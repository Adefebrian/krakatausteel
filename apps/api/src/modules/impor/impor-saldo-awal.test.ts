// The go-live migration: spec 9.6 "Import Saldo Awal", ADR 0006, over the SAME
// app `createApp` builds for the server (testing/harness.ts rule 1).
//
// FIVE CLAIMS, WITH THE NUMBERS WRITTEN OUT RATHER THAN COMPUTED. Every figure
// below is a literal, so a test that goes green because the code and the test
// share a bug is not possible here: the trial balance adds up on paper.
//
//   THE WORLD, once, and every assertion refers back to it:
//
//     1.1.01  Kas dan Setara Kas .................. D   450.000.000,00
//     1.1.90  Kas Bank Warisan (CREATED BY THE FILE) D    50.000.000,00
//     1.1.03  Piutang Pinjaman Mitra Binaan ....... D   300.000.000,00
//     3.1.01  Aset Neto ........................... K   800.000.000,00
//                                                   -----------------
//                                          debit  =  800.000.000,00
//                                          kredit =  800.000.000,00
//
//     akad A ... 200.000.000,00  |
//     akad B ... 100.000.000,00  |  = 300.000.000,00 = the 1.1.03 line
//
//   1. IT RECONCILES BEFORE IT COMMITS. Three refusals, each with the wrong
//      number stated explicitly: an unbalanced trial balance, a sub-ledger that
//      does not add up to its control account, and (after everything is
//      written, inside the transaction) `v_rekonsiliasi_piutang` itself.
//   2. IT IS ONE DATED EVENT. The batch carries the legacy cut-off; the JOURNAL
//      carries the first day of the earliest OPEN period, because invariant 5
//      will not accept anything else. A cut-off that is not the day before that
//      is refused.
//   3. THE JOURNAL GOES THROUGH THE ENGINE. `jenis = 'SALDO_AWAL'` off the
//      mapping row, `jalur_posting = 'ENGINE'` off migration 0020's trigger,
//      and one receivable line per akad so check 10 can attribute it.
//   4. IT RUNS EXACTLY ONCE. The same bytes are refused by the checksum; the
//      same BALANCES under a different filename, in a different row order, are
//      refused by the batch rule, which is the case a checksum cannot see.
//   5. AN IMPORTED ACCOUNT DOES NOT SILENTLY COLLIDE WITH A SEEDED ONE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { buatAkadBelumCair, buatPeriodeOpen, csv, type AkadWarisan } from "./test-support";

const HEADER = [
  "bagian",
  "kode_akun",
  "nama_akun",
  "tipe",
  "saldo_normal",
  "level",
  "parent_kode",
  "klasifikasi",
  "is_postable",
  "is_kas",
  "is_kontra",
  "klasifikasi_arus_kas",
  "debit",
  "kredit",
  "no_akad",
  "outstanding_pokok",
  "outstanding_jasa",
  "tunggakan_pokok",
  "tunggakan_jasa",
  "angsuran_ke_terakhir",
  "hari_tunggakan",
  "kolektibilitas",
  "keterangan",
] as const;

type Sel = Partial<Record<(typeof HEADER)[number], string>>;

/** One row, named by column, so a reader sees the DATA and not the padding. */
function baris(sel: Sel): string[] {
  return HEADER.map((k) => sel[k] ?? "");
}

/** The earliest OPEN period this fixture will have. The journal's home. */
const PERIODE_AWAL = { tahun: 2026, bulan: 2 } as const;
const TANGGAL_JURNAL = "2026-02-01";
/** The day before it. The only cut-off the import accepts. */
const CUT_OFF = "2026-01-31";

const KAS = "450000000.00";
const KAS_WARISAN = "50000000.00";
const PIUTANG = "300000000.00";
const ASET_NETO = "800000000.00";
const AKAD_A = "200000000.00";
const AKAD_B = "100000000.00";
/** The JOURNAL's gross total: every balance once on its account, once on 3.1.02. */
const BRUTO_JURNAL = "1600000000.00";

describe("impor saldo awal: go-live (spec 9.6, ADR 0006)", () => {
  let f: Fixture;
  let cookieAdmin = "";
  let cookieMaker = "";
  let akadA: AkadWarisan;
  let akadB: AkadWarisan;
  let kodeAkunBaru = "";
  let cabangId = "";

  async function kirim(
    jalur: "pratinjau" | "komit",
    isi: string,
    opsi: { cookie?: string; namaFile?: string; tanggalEfektif?: string } = {},
  ): Promise<Response> {
    return f.request(`/impor/SALDO_AWAL/${jalur}`, {
      cookie: opsi.cookie ?? cookieAdmin,
      method: "POST",
      body: {
        namaFile: opsi.namaFile ?? "saldo-awal.csv",
        isi,
        cabangId,
        saldoAwal: { tanggalEfektif: opsi.tanggalEfektif ?? CUT_OFF },
      },
    });
  }

  /** The account half. Amounts are parameters so a test can break ONE number. */
  function barisAkun(opsi: { kas?: string; piutang?: string; asetNeto?: string } = {}): string[][] {
    return [
      baris({ bagian: "AKUN", kode_akun: "1.1.01", debit: opsi.kas ?? KAS }),
      baris({
        bagian: "AKUN",
        kode_akun: kodeAkunBaru,
        nama_akun: "Kas Bank Warisan",
        tipe: "ASET",
        saldo_normal: "D",
        level: "2",
        parent_kode: "1",
        klasifikasi: "ASET",
        is_kas: "Y",
        klasifikasi_arus_kas: "OPERASI",
        debit: KAS_WARISAN,
      }),
      baris({ bagian: "AKUN", kode_akun: "1.1.03", debit: opsi.piutang ?? PIUTANG }),
      baris({ bagian: "AKUN", kode_akun: "3.1.01", kredit: opsi.asetNeto ?? ASET_NETO }),
    ];
  }

  function barisAkad(opsi: { a?: string; b?: string } = {}): string[][] {
    return [
      baris({
        bagian: "AKAD",
        no_akad: akadA.noAkad,
        outstanding_pokok: opsi.a ?? AKAD_A,
        tunggakan_pokok: "20000000.00",
        hari_tunggakan: "45",
        angsuran_ke_terakhir: "6",
      }),
      baris({ bagian: "AKAD", no_akad: akadB.noAkad, outstanding_pokok: opsi.b ?? AKAD_B }),
    ];
  }

  function berkasBenar(): string {
    return csv(HEADER, [...barisAkun(), ...barisAkad()]);
  }

  async function cacahBatch(): Promise<number> {
    const r = await f.db.query<{ n: string }>(
      `select count(*)::text as n from saldo_awal_batch where bumn_id = $1::uuid`,
      [f.bumnId],
    );
    return Number(r[0]?.n ?? "0");
  }

  async function cacahJurnalSaldoAwal(): Promise<number> {
    const r = await f.db.query<{ n: string }>(
      `select count(*)::text as n from jurnal
        where bumn_id = $1::uuid and jenis = 'SALDO_AWAL' and deleted_at is null`,
      [f.bumnId],
    );
    return Number(r[0]?.n ?? "0");
  }

  beforeAll(async () => {
    f = await createFixture();
    await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
    await buatPeriodeOpen(f.db, f.bumnId, PERIODE_AWAL.tahun, PERIODE_AWAL.bulan);
    cookieAdmin = await f.login(f.users.ADMIN_PUSAT.username);
    cookieMaker = await f.login(f.users.MAKER.username);
    cabangId = f.users.MAKER.cabang.id;
    // The account code is fixture-unique: `akun_kode_uq` is per bumn and a
    // rerun of the suite must not collide with the row a previous run created.
    kodeAkunBaru = `1.9.${f.suffix.slice(-4).toUpperCase()}`;
    akadA = await buatAkadBelumCair(f.db, {
      cabangId,
      suffix: f.suffix,
      pokok: "250000000.00",
    });
    akadB = await buatAkadBelumCair(f.db, {
      cabangId,
      suffix: f.suffix,
      pokok: "150000000.00",
    });
  });

  afterAll(async () => {
    await f.tutup();
  });

  // ------------------------------------------------------------------ 5.
  // Authorisation, before anything writes.

  test("tanpa sesi: 401", async () => {
    const r = await f.request("/impor/SALDO_AWAL/komit", {
      method: "POST",
      body: { isi: berkasBenar(), saldoAwal: { tanggalEfektif: CUT_OFF } },
    });
    expect(r.status).toBe(401);
  });

  test("Maker punya tools.import tapi tidak boleh membuka buku: 403", async () => {
    // Rule 3 (contract.ts): the file may not do what its operator could not do
    // by hand. Creating accounts is `konfigurasi.coa`, landing a POSTED journal
    // is `jurnal.post`, and the Maker holds neither.
    const r = await kirim("komit", berkasBenar(), { cookie: cookieMaker });
    expect(r.status).toBe(403);
    expect(await cacahBatch()).toBe(0);
  });

  // ------------------------------------------------------------------ 1.
  // It reconciles before it commits.

  test("R1: debit 800.000.000,00 lawan kredit 799.000.000,00 ditolak, tanpa menulis apa pun", async () => {
    const isi = csv(HEADER, [...barisAkun({ asetNeto: "799000000.00" }), ...barisAkad()]);
    const r = await kirim("komit", isi);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { kodeDomain?: string; error: string };
    expect(body.kodeDomain).toBe("SALDO_AWAL_TIDAK_BALANCE");
    // The refusal states BOTH numbers and the difference, because "not
    // balanced" with no figures is a support ticket.
    expect(body.error).toContain("800000000.00");
    expect(body.error).toContain("799000000.00");
    expect(body.error).toContain("1000000.00");
    expect(await cacahBatch()).toBe(0);
    expect(await cacahJurnalSaldoAwal()).toBe(0);
  });

  test("R2: akun kontrol 300.000.000,00 lawan sub ledger 280.000.000,00 ditolak", async () => {
    // Still balanced as a trial balance (the akad rows are not part of it), so
    // R1 passes and only the sub-ledger comparison can catch this. That is the
    // whole reason it is a separate rule.
    const isi = csv(HEADER, [...barisAkun(), ...barisAkad({ b: "80000000.00" })]);
    const r = await kirim("komit", isi);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { kodeDomain?: string; error: string };
    expect(body.kodeDomain).toBe("SUBLEDGER_PIUTANG_TIDAK_COCOK");
    expect(body.error).toContain("300000000.00");
    expect(body.error).toContain("280000000.00");
    expect(await cacahBatch()).toBe(0);
    expect(await cacahJurnalSaldoAwal()).toBe(0);
  });

  test("R2: baris akad tanpa saldo akun kontrolnya juga ditolak", async () => {
    // The other direction, and the one a "warning" would wave through: the
    // akad half arrives, the control account does not, and the ledger would
    // carry a receivable no account admits to.
    const isi = csv(HEADER, [
      baris({ bagian: "AKUN", kode_akun: "1.1.01", debit: "300000000.00" }),
      baris({ bagian: "AKUN", kode_akun: "3.1.01", kredit: "300000000.00" }),
      ...barisAkad(),
    ]);
    const r = await kirim("komit", isi);
    expect(r.status).toBe(400);
    expect((await r.json()).kodeDomain).toBe("SUBLEDGER_PIUTANG_TIDAK_COCOK");
    expect(await cacahBatch()).toBe(0);
  });

  // ------------------------------------------------------------------ 2.
  // One dated event, and the date is not the operator's choice.

  test("tanggal efektif yang bukan sehari sebelum periode OPEN pertama ditolak, 409", async () => {
    const r = await kirim("komit", berkasBenar(), { tanggalEfektif: "2025-12-31" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { kodeDomain?: string; error: string };
    expect(body.kodeDomain).toBe("PERIODE_SALDO_AWAL_TIDAK_SIAP");
    // The message names the date the system expects, so the fix is obvious.
    expect(body.error).toContain(CUT_OFF);
    expect(body.error).toContain(TANGGAL_JURNAL);
    expect(await cacahBatch()).toBe(0);
  });

  // ------------------------------------------------------------------ 5.
  // The chart of accounts.

  test("baris yang menyatakan ulang akun seeded dengan tipe lain ditolak per baris", async () => {
    const isi = csv(HEADER, [
      // 1.1.01 is seeded as ASET / D. The file calls it a LIABILITAS.
      baris({
        bagian: "AKUN",
        kode_akun: "1.1.01",
        tipe: "LIABILITAS",
        saldo_normal: "K",
        debit: KAS,
      }),
      ...barisAkun().slice(1),
      ...barisAkad(),
    ]);
    const r = await kirim("komit", isi);
    expect(r.status).toBe(400);
    const body = (await r.json()) as {
      kodeDomain?: string;
      laporan: { ditolak: { nomorBaris: number; alasan: Record<string, string[]> }[] };
    };
    expect(body.kodeDomain).toBe("ADA_BARIS_DITOLAK");
    expect(body.laporan.ditolak).toHaveLength(1);
    // Line 2: line 1 is the header, so the number is the one in the operator's
    // spreadsheet.
    expect(body.laporan.ditolak[0]!.nomorBaris).toBe(2);
    const alasan = body.laporan.ditolak[0]!.alasan;
    expect(Object.keys(alasan).sort()).toEqual(["saldo_normal", "tipe"]);
    expect(alasan.tipe!.join(" ")).toContain("ASET");
    expect(alasan.tipe!.join(" ")).toContain("LIABILITAS");
    // The account was NOT rewritten, which is the whole point of refusing.
    const akun = await f.db.query<{ tipe: string }>(
      `select tipe from akun where bumn_id = $1::uuid and kode = '1.1.01' and deleted_at is null`,
      [f.bumnId],
    );
    expect(akun[0]!.tipe).toBe("ASET");
    expect(await cacahBatch()).toBe(0);
  });

  test("akad yang sudah hidup di sistem ini ditolak per baris", async () => {
    const isi = csv(HEADER, [
      ...barisAkun(),
      baris({ bagian: "AKAD", no_akad: akadA.noAkad, outstanding_pokok: AKAD_A }),
      baris({ bagian: "AKAD", no_akad: "AKAD-YANG-TIDAK-ADA", outstanding_pokok: AKAD_B }),
    ]);
    const r = await kirim("komit", isi);
    expect(r.status).toBe(400);
    const body = (await r.json()) as {
      laporan: { ditolak: { nomorBaris: number; alasan: Record<string, string[]> }[] };
    };
    expect(body.laporan.ditolak).toHaveLength(1);
    expect(body.laporan.ditolak[0]!.alasan.no_akad!.join(" ")).toContain("tidak ditemukan");
    expect(await cacahBatch()).toBe(0);
  });

  // ------------------------------------------------------------------ 1-3.
  // The happy path, and everything it must have produced.

  test("pratinjau berkas yang benar: siap komit, tanpa menulis apa pun", async () => {
    const r = await kirim("pratinjau", berkasBenar());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      siapKomit: boolean;
      ditolak: unknown[];
      diterima: { nomorBaris: number; ringkasan: Record<string, string> }[];
    };
    expect(body.ditolak).toHaveLength(0);
    expect(body.siapKomit).toBe(true);
    expect(body.diterima).toHaveLength(6);
    expect(await cacahBatch()).toBe(0);
    expect(await cacahJurnalSaldoAwal()).toBe(0);
  });

  test("komit: satu batch, satu jurnal SALDO_AWAL lewat engine, tujuh baris", async () => {
    const r = await kirim("komit", berkasBenar());
    expect(r.status).toBe(201);
    const hasil = (await r.json()) as {
      jurnalIds: string[];
      saldoAwal: {
        batchId: string;
        jurnalId: string;
        tanggalEfektif: string;
        tanggalJurnal: string;
        totalDebit: string;
        totalKredit: string;
        brutoJurnalDebit: string;
        brutoJurnalKredit: string;
        jumlahAkun: number;
        jumlahAkad: number;
        akunDibuat: string[];
        kodeAkunPiutang: string;
        saldoKontrolPiutang: string;
        totalSubLedgerPiutang: string;
      };
    };

    expect(hasil.jurnalIds).toHaveLength(1);
    expect(hasil.saldoAwal.tanggalEfektif).toBe(CUT_OFF);
    expect(hasil.saldoAwal.tanggalJurnal).toBe(TANGGAL_JURNAL);
    // The TRIAL BALANCE's totals, which is what the old system's report says.
    expect(hasil.saldoAwal.totalDebit).toBe(ASET_NETO);
    expect(hasil.saldoAwal.totalKredit).toBe(ASET_NETO);
    // The JOURNAL's gross, always exactly twice, and reported separately so
    // the two can never be mistaken for each other.
    expect(hasil.saldoAwal.brutoJurnalDebit).toBe(BRUTO_JURNAL);
    expect(hasil.saldoAwal.brutoJurnalKredit).toBe(BRUTO_JURNAL);
    expect(hasil.saldoAwal.jumlahAkun).toBe(4);
    expect(hasil.saldoAwal.jumlahAkad).toBe(2);
    expect(hasil.saldoAwal.akunDibuat).toEqual([kodeAkunBaru]);
    expect(hasil.saldoAwal.kodeAkunPiutang).toBe("1.1.03");
    expect(hasil.saldoAwal.saldoKontrolPiutang).toBe(PIUTANG);
    expect(hasil.saldoAwal.totalSubLedgerPiutang).toBe(PIUTANG);

    // THE JOURNAL. `jenis` comes off the mapping row (ADR 0006 fixed it before
    // the tool existed), `jalur_posting` off migration 0020's trigger, and the
    // date is the period's first day, NOT the cut-off.
    const j = await f.db.query<{
      jenis: string;
      status: string;
      jalur_posting: string;
      tanggal_transaksi: string;
      total_debit: string;
      total_kredit: string;
      kunci_idempotensi: string | null;
    }>(
      `select jenis, status, jalur_posting, tanggal_transaksi::text as tanggal_transaksi,
              total_debit::numeric(20,2)::text as total_debit,
              total_kredit::numeric(20,2)::text as total_kredit, kunci_idempotensi
         from jurnal where id = $1::uuid`,
      [hasil.saldoAwal.jurnalId],
    );
    expect(j[0]!.jenis).toBe("SALDO_AWAL");
    expect(j[0]!.status).toBe("POSTED");
    expect(j[0]!.jalur_posting).toBe("ENGINE");
    expect(j[0]!.tanggal_transaksi).toBe(TANGGAL_JURNAL);
    // GROSS totals are TWICE the trial balance, and that is the stated price of
    // refusing to invent pairs: every balance is recorded once on its own
    // account and once on the clearing account. The batch below still carries
    // the TRIAL BALANCE's own totals, which is what an accountant reads.
    expect(j[0]!.total_debit).toBe(BRUTO_JURNAL);
    expect(j[0]!.total_kredit).toBe(BRUTO_JURNAL);
    expect(j[0]!.kunci_idempotensi).toBe(`saldo_awal:${hasil.saldoAwal.batchId}`);

    // SEVEN LINES: one per imported balance (four debit entries once the
    // receivable is expanded per akad, one credit entry) plus the clearing
    // account's two, which are the ONLY two lines the design adds however many
    // accounts arrive, because `postingEventGabungan` merges legs that agree.
    //
    // The two receivable lines carry their akad, which is what
    // `v_rekonsiliasi_piutang` joins on. A single lumped 300.000.000,00 line
    // would balance and would make check 10 unattributable forever.
    const lines = await f.db.query<{
      kode: string;
      debit: string;
      kredit: string;
      akad_id: string | null;
    }>(
      `select a.kode,
              b.debit::numeric(20,2)::text as debit,
              b.kredit::numeric(20,2)::text as kredit,
              b.akad_id::text as akad_id
         from jurnal_baris b join akun a on a.id = b.akun_id
        where b.jurnal_id = $1::uuid
        order by a.kode, b.debit desc`,
      [hasil.saldoAwal.jurnalId],
    );
    expect(lines).toHaveLength(7);
    const piutangLines = lines.filter((l) => l.kode === "1.1.03");
    expect(piutangLines.map((l) => l.debit).sort()).toEqual([AKAD_B, AKAD_A].sort());
    expect(piutangLines.map((l) => l.akad_id).sort()).toEqual([akadA.akadId, akadB.akadId].sort());
    expect(lines.find((l) => l.kode === "1.1.01")!.debit).toBe(KAS);
    expect(lines.find((l) => l.kode === kodeAkunBaru)!.debit).toBe(KAS_WARISAN);
    expect(lines.find((l) => l.kode === "3.1.01")!.kredit).toBe(ASET_NETO);

    // NO INVENTED PAIRS, AND THE CLEARING ACCOUNT NETS TO ZERO. That zero is
    // the audit check the paired design could not have offered: it is true
    // only if every imported balance went in exactly once.
    const transisi = lines.filter((l) => l.kode === "3.1.02");
    expect(transisi).toHaveLength(2);
    expect(transisi.find((l) => l.debit !== "0.00")!.debit).toBe(ASET_NETO);
    expect(transisi.find((l) => l.kredit !== "0.00")!.kredit).toBe(ASET_NETO);
    const saldoTransisi = await f.db.query<{ saldo: string }>(
      `select coalesce(sum(l.nilai_debit_positif), 0)::numeric(20,2)::text as saldo
         from v_ledger_baris l join akun a on a.id = l.akun_id
        where l.bumn_id = $1::uuid and a.kode = '3.1.02'`,
      [f.bumnId],
    );
    expect(saldoTransisi[0]!.saldo).toBe("0.00");

    // R3, from the outside now: the shipped predicate, spec 8.4 check 10.
    const rekon = await f.db.query<{ no_akad: string; selisih: string }>(
      `select no_akad, selisih::numeric(20,2)::text as selisih
         from v_rekonsiliasi_piutang where akad_id in ($1::uuid, $2::uuid)`,
      [akadA.akadId, akadB.akadId],
    );
    expect(rekon).toHaveLength(2);
    for (const row of rekon) expect(row.selisih).toBe("0.00");

    // The sub-ledger the check reads on the other side.
    const akad = await f.db.query<{ no_akad: string; status: string; outstanding_pokok: string }>(
      `select no_akad, status, outstanding_pokok::numeric(20,2)::text as outstanding_pokok
         from pumk_akad where id in ($1::uuid, $2::uuid) order by outstanding_pokok desc`,
      [akadA.akadId, akadB.akadId],
    );
    expect(akad.map((x) => x.status)).toEqual(["AKTIF", "AKTIF"]);
    expect(akad.map((x) => x.outstanding_pokok)).toEqual([AKAD_A, AKAD_B]);

    // The batch, and the two halves hanging off it.
    const batch = await f.db.query<{
      status: string;
      tanggal_efektif: string;
      total_debit: string;
      jurnal_id: string;
    }>(
      `select status, tanggal_efektif::text as tanggal_efektif,
              total_debit::numeric(20,2)::text as total_debit, jurnal_id::text as jurnal_id
         from saldo_awal_batch where id = $1::uuid`,
      [hasil.saldoAwal.batchId],
    );
    expect(batch[0]!.status).toBe("DIPOSTING");
    expect(batch[0]!.tanggal_efektif).toBe(CUT_OFF);
    expect(batch[0]!.total_debit).toBe(ASET_NETO);
    expect(batch[0]!.jurnal_id).toBe(hasil.saldoAwal.jurnalId);

    const halves = await f.db.query<{ akun: string; akad: string }>(
      `select (select count(*)::text from akun_saldo_awal where batch_id = $1::uuid) as akun,
              (select count(*)::text from akad_saldo_awal where batch_id = $1::uuid) as akad`,
      [hasil.saldoAwal.batchId],
    );
    expect(halves[0]!.akun).toBe("4");
    expect(halves[0]!.akad).toBe("2");

    // The account the file created: postable, because it carries a balance.
    const baru = await f.db.query<{ is_postable: boolean; is_kas: boolean; tipe: string }>(
      `select is_postable, is_kas, tipe from akun
        where bumn_id = $1::uuid and kode = $2 and deleted_at is null`,
      [f.bumnId, kodeAkunBaru],
    );
    expect(baru[0]!.is_postable).toBe(true);
    expect(baru[0]!.is_kas).toBe(true);
    expect(baru[0]!.tipe).toBe("ASET");

    // Provenance: the batch is tied to line 1 of a named file (rule 4).
    const prov = await f.db.query<{ entitas: string; nomor_baris: number; jurnal_id: string }>(
      `select r.entitas, r.nomor_baris, r.jurnal_id::text as jurnal_id
         from impor_baris r join impor_berkas k on k.id = r.berkas_id
        where k.bumn_id = $1::uuid and k.jenis = 'SALDO_AWAL'
          and r.entitas = 'saldo_awal_batch'`,
      [f.bumnId],
    );
    expect(prov).toHaveLength(1);
    expect(prov[0]!.nomor_baris).toBe(1);
    expect(prov[0]!.jurnal_id).toBe(hasil.saldoAwal.jurnalId);
  });

  // ------------------------------------------------------------------ 4.
  // It runs exactly once. THIS IS THE TEST THE FEATURE EXISTS FOR.

  test("unggah ulang berkas yang identik byte demi byte: 409, checksum", async () => {
    const r = await kirim("komit", berkasBenar());
    expect(r.status).toBe(409);
    expect((await r.json()).kodeDomain).toBe("BERKAS_SUDAH_DIIMPOR");
    expect(await cacahJurnalSaldoAwal()).toBe(1);
  });

  test("SALDO YANG SAMA, NAMA BERKAS LAIN, URUTAN BARIS LAIN: tetap 409", async () => {
    // The case the checksum CANNOT see, and the one a nervous operator
    // actually produces: they re-save the spreadsheet (a .xlsx zip carries
    // timestamps), or sort it differently, or rename it, and re-upload "just
    // to be sure". Without the batch rule this doubles the entire opening
    // balance sheet and nothing refuses it.
    const dibalik = csv(HEADER, [...barisAkad().reverse(), ...barisAkun().reverse()]);
    expect(dibalik).not.toBe(berkasBenar());

    const r = await kirim("komit", dibalik, { namaFile: "saldo-awal-final-REVISI-2.csv" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { kodeDomain?: string; error: string };
    expect(body.kodeDomain).toBe("SALDO_AWAL_SUDAH_DIPOSTING");
    expect(body.error).toContain(CUT_OFF);

    // NOTHING MOVED. One journal, one batch, and the receivable is still
    // 300.000.000,00 rather than 600.000.000,00.
    expect(await cacahJurnalSaldoAwal()).toBe(1);
    expect(await cacahBatch()).toBe(1);
    const piutang = await f.db.query<{ saldo: string }>(
      `select coalesce(sum(l.nilai_debit_positif), 0)::numeric(20,2)::text as saldo
         from v_ledger_baris l join akun a on a.id = l.akun_id
        where l.bumn_id = $1::uuid and a.kode = '1.1.03'`,
      [f.bumnId],
    );
    expect(piutang[0]!.saldo).toBe(PIUTANG);
  });

  test("pratinjau pun menolak setelah buku dibuka, alih alih bilang siap komit", async () => {
    const r = await kirim("pratinjau", berkasBenar(), { namaFile: "coba-lagi.csv" });
    expect(r.status).toBe(409);
    expect((await r.json()).kodeDomain).toBe("SALDO_AWAL_SUDAH_DIPOSTING");
  });
});
