// Spec 6.4 "Event to Journal Mapping". One central path, `postingEvent`, and
// the accounts behind every automatic journal come from the
// `event_jurnal_mapping` TABLE, not from TypeScript (invariant 11, ADR 0004).
//
// HOW THESE TESTS AVOID BECOMING A COPY OF THE CODE.
// Each per-event test reads the mapping row from the database and asserts the
// produced journal against THAT ROW, not against a literal in this file. So a
// hardcoded account map inside the engine fails these tests even if the
// hardcoded values happen to agree with the seed, because the last test in the
// file rewrites a row and inserts an event code that did not exist when the
// process started.
//
// COUNTING NOTE: the spec 6.4 table has NINETEEN rows, not twenty. All
// nineteen are covered below. docs/BUILD-PLAN.md notes a twentieth event is
// needed for penghapustagihan (SK-277/MBU/10/2023 distinguishes it from
// penghapusbukuan), but the spec does not name it, so it is not invented here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJurnalEngine, KODE_JURNAL, type JenisJurnal, type JurnalEngine } from "./contract";
import {
  bacaBarisDb,
  buatDunia,
  KATALOG_EVENT_6_4,
  keSen,
  kunci,
  rp,
  selisihLedger,
  tolakDengan,
  type DuniaJurnal,
} from "./test-support";

interface BarisMapping {
  akun_debit_id: string | null;
  akun_kredit_id: string | null;
  debit_dari_payload: boolean;
  kredit_dari_payload: boolean;
  // Narrowed to the union rather than left as `string`: the column is TEXT
  // with a CHECK listing exactly these values (migrations/0010_jurnal.sql), so
  // `jurnal.jenis` and this column are the same closed set. Widening
  // `JenisJurnal` to `string` on the contract side would have thrown away the
  // one thing that makes an invalid jenis a compile error.
  jenis_jurnal: JenisJurnal;
}

let d: DuniaJurnal;
let engine: JurnalEngine;

beforeAll(async () => {
  d = await buatDunia();
  engine = createJurnalEngine({ db: d.db, jam: d.jam });
});

afterAll(async () => {
  if (d) await d.tutup();
});

async function bacaMapping(eventCode: string): Promise<BarisMapping> {
  const r = await d.db.query<BarisMapping>(
    `select akun_debit_id, akun_kredit_id, debit_dari_payload, kredit_dari_payload, jenis_jurnal
       from event_jurnal_mapping
      where bumn_id = $1 and event_code = $2 and aktif and deleted_at is null`,
    [d.bumnId, eventCode],
  );
  if (r.length !== 1) throw new Error(`fixture: mapping ${eventCode} tidak tunggal (${r.length} baris)`);
  return r[0];
}

/**
 * Balance of the contra-asset account, credit-positive (its normal balance is
 * credit). Read as a baseline-and-delta pair by the caller; see the note in the
 * contra-asset test for why an absolute figure would be meaningless in a world
 * shared with the 19-event loop.
 */
async function saldoPenyisihan(): Promise<string> {
  const r = await d.db.query<{ saldo: string }>(
    `select coalesce(sum(b.kredit) - sum(b.debit), 0)::numeric(20,2)::text as saldo
       from jurnal_baris b join jurnal j on j.id = b.jurnal_id
      where b.akun_id = $1 and j.status in ('POSTED', 'REVERSED')
        and j.deleted_at is null and b.deleted_at is null`,
    [d.akun.penyisihan.id],
  );
  return r[0].saldo;
}

describe("spec 6.4 postingEvent membaca event_jurnal_mapping", () => {
  test("katalog event adalah data: 19 baris spec 6.4 ada di tabel, satu baris aktif per event", async () => {
    const r = await d.db.query<{ event_code: string }>(
      `select event_code from event_jurnal_mapping
        where bumn_id = $1 and aktif and deleted_at is null order by event_code`,
      [d.bumnId],
    );
    expect(r.map((x) => x.event_code)).toEqual(
      KATALOG_EVENT_6_4.map((e) => e.code).sort((a, b) => a.localeCompare(b)),
    );
    expect(r).toHaveLength(19);
  });

  // One test per spec 6.4 row, named by event code so a failure names the
  // event that broke.
  for (const ev of KATALOG_EVENT_6_4) {
    test(`spec 6.4 ${ev.code} memakai akun dari baris mapping-nya`, async () => {
      const map = await bacaMapping(ev.code);
      const nilai = rp(2_500_000);

      // Legs the mapping marks as runtime-resolved are supplied by the caller:
      // PENYALURAN_NON_PUMK debits a per-bidang expense account and
      // BEBAN_OPERASIONAL a per-type one (migrations/0010 says so).
      const akunDebitDiharapkan = map.debit_dari_payload
        ? ev.code === "PENYALURAN_NON_PUMK"
          ? d.akun.bebanNonPumk.id
          : d.akun.bebanOperasional.id
        : map.akun_debit_id!;
      const akunKreditDiharapkan = map.kredit_dari_payload
        ? d.akun.kas.id
        : map.akun_kredit_id!;

      const menyentuhPiutangMitra =
        akunDebitDiharapkan === d.akun.piutangPokok.id ||
        akunKreditDiharapkan === d.akun.piutangPokok.id;

      const jurnal = await engine.postingEvent(
        ev.code,
        {
          cabangId: d.cabangId,
          tanggalTransaksi: d.tanggalKini,
          nilai,
          keterangan: `uji ${ev.code}`,
          akunDebitId: map.debit_dari_payload ? akunDebitDiharapkan : undefined,
          akunKreditId: map.kredit_dari_payload ? akunKreditDiharapkan : undefined,
          mitraId: menyentuhPiutangMitra ? d.mitraId : undefined,
          akadId: menyentuhPiutangMitra ? d.akadId : undefined,
          dimensi: { bidangId: d.bidangNonPumkId },
        },
        d.ctx.approver,
      );

      // An automatic journal is born and posted in one go, and is flagged as
      // machine-made so the audit trail can tell it from a manual entry.
      expect(jurnal.status).toBe("POSTED");
      expect(jurnal.isAutoGenerated).toBe(true);
      // jenis also comes from the mapping row, not from the event code.
      expect(jurnal.jenis).toBe(map.jenis_jurnal);
      expect(jurnal.totalDebit).toBe(nilai);
      expect(jurnal.totalKredit).toBe(nilai);

      const baris = await bacaBarisDb(d.db, jurnal.id);
      expect(baris).toHaveLength(2);
      const sisiDebit = baris.find((b) => b.debit !== rp(0));
      const sisiKredit = baris.find((b) => b.kredit !== rp(0));
      expect(sisiDebit?.akun_id).toBe(akunDebitDiharapkan);
      expect(sisiKredit?.akun_id).toBe(akunKreditDiharapkan);
      expect(sisiDebit?.debit).toBe(nilai);
      expect(sisiKredit?.kredit).toBe(nilai);

      // The piutang sub-ledger dimension goes on the receivable leg only;
      // tagging the cash leg would double-count in spec 8.4 check 10.
      if (menyentuhPiutangMitra) {
        const piutang = baris.find((b) => b.akun_id === d.akun.piutangPokok.id);
        const lawan = baris.find((b) => b.akun_id !== d.akun.piutangPokok.id);
        expect(piutang?.akad_id).toBe(d.akadId);
        expect(piutang?.mitra_id).toBe(d.mitraId);
        expect(lawan?.akad_id).toBeNull();
      }

      expect(await selisihLedger(d.db)).toBe("0.00");
    });
  }

  test("spec 6.4 catatan kontra aset: Penyisihan Penurunan Nilai Piutang bersaldo normal Kredit dan disajikan sebagai pengurang Piutang", async () => {
    // NOTE ON WHY THIS TEST MEASURES A DELTA, NOT AN ABSOLUTE BALANCE.
    // The world is built once in `beforeAll` and shared with the 19-event loop
    // above, and HAPUS_BUKU_PIUTANG in that loop debits this very account. An
    // absolute balance assertion here would therefore be asserting the sum of
    // this test AND whatever else happened to post into the shared world,
    // which is not a property of the contra account at all. The invariant the
    // spec 6.4 note actually states is directional: crediting increases the
    // allowance, debiting releases it, and the net of the two moves the
    // account by the difference. That is what is asserted below.
    // The account itself: an ASSET whose normal balance is CREDIT.
    const akun = await d.db.query<{
      tipe: string;
      saldo_normal: string;
      is_kontra: boolean;
      klasifikasi_laporan: string;
    }>(
      `select tipe, saldo_normal, is_kontra, klasifikasi_laporan from akun where id = $1`,
      [d.akun.penyisihan.id],
    );
    expect(akun[0].tipe).toBe("ASET");
    expect(akun[0].saldo_normal).toBe("K");
    expect(akun[0].is_kontra).toBe(true);

    // Presentation as a deduction is data too: baris_laporan.tanda = -1 is
    // what produces the "Piutang Pinjaman Mitra Binaan - Bersih" line.
    const baris = await d.db.query<{ tanda: number }>(
      `select tanda from baris_laporan where bumn_id = $1 and kode = $2`,
      [d.bumnId, akun[0].klasifikasi_laporan],
    );
    expect(baris[0].tanda).toBe(-1);

    // Baseline BEFORE this test posts anything, credit-positive because the
    // account's normal balance is credit.
    const saldoAwal = await saldoPenyisihan();

    // BEBAN_PENYISIHAN credits it (increasing the allowance)...
    const beban = await engine.postingEvent(
      "BEBAN_PENYISIHAN",
      { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(1_250_000) },
      d.ctx.approver,
    );
    const barisBeban = await bacaBarisDb(d.db, beban.id);
    const kreditPenyisihan = barisBeban.find((b) => b.akun_id === d.akun.penyisihan.id);
    expect(kreditPenyisihan?.kredit).toBe(rp(1_250_000));
    expect(kreditPenyisihan?.debit).toBe(rp(0));

    // ...and PEMULIHAN_PENYISIHAN debits it (releasing part of it). Spec 8.5.7
    // calls the release a negative expense; the mechanic here is that the same
    // contra account moves in the opposite direction, and NEITHER journal ever
    // carries a negative amount on a line (validation 6.2.4).
    const pemulihan = await engine.postingEvent(
      "PEMULIHAN_PENYISIHAN",
      { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(400_000) },
      d.ctx.approver,
    );
    const barisPemulihan = await bacaBarisDb(d.db, pemulihan.id);
    const debitPenyisihan = barisPemulihan.find((b) => b.akun_id === d.akun.penyisihan.id);
    expect(debitPenyisihan?.debit).toBe(rp(400_000));
    expect(debitPenyisihan?.kredit).toBe(rp(0));

    // Net movement of the two journals on the contra account, credit-positive:
    // 1.250.000 credited minus 400.000 released = 850.000. Asserted as a delta
    // against the baseline, so nothing else posting into the shared world can
    // change the answer.
    const saldoAkhir = await saldoPenyisihan();
    expect(keSen(saldoAkhir) - keSen(saldoAwal)).toBe(keSen(rp(850_000)));
  });

  test("spec 6.4 leg yang ditandai dari payload wajib disuplai pemanggil", async () => {
    await tolakDengan(
      engine.postingEvent(
        "PENYALURAN_NON_PUMK",
        { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(1_000_000) },
        d.ctx.approver,
      ),
      KODE_JURNAL.EVENT_PAYLOAD_TIDAK_LENGKAP,
    );
  });

  test("spec 6.4 akun kas dari form menimpa akun kas di mapping, akun non-kas tetap dari mapping", async () => {
    const jurnal = await engine.postingEvent(
      "ALOKASI_DANA_BUMN_PEMBINA",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(5_000_000),
        akunKasId: d.akun.kasKedua.id,
      },
      d.ctx.approver,
    );
    const baris = await bacaBarisDb(d.db, jurnal.id);
    expect(baris.find((b) => b.debit !== rp(0))?.akun_id).toBe(d.akun.kasKedua.id);
    expect(baris.find((b) => b.kredit !== rp(0))?.akun_id).toBe(d.akun.pendapatanAlokasi.id);
  });

  test("spec 6.4 event tanpa baris mapping aktif ditolak", async () => {
    await tolakDengan(
      engine.postingEvent(
        "EVENT_YANG_TIDAK_PERNAH_ADA",
        { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(100_000) },
        d.ctx.approver,
      ),
      KODE_JURNAL.EVENT_MAPPING_TIDAK_DITEMUKAN,
    );

    await d.db.query(
      `update event_jurnal_mapping set aktif = false where bumn_id = $1 and event_code = 'PENDAPATAN_JASA_GIRO'`,
      [d.bumnId],
    );
    try {
      await tolakDengan(
        engine.postingEvent(
          "PENDAPATAN_JASA_GIRO",
          { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(100_000) },
          d.ctx.approver,
        ),
        KODE_JURNAL.EVENT_MAPPING_TIDAK_DITEMUKAN,
      );
    } finally {
      await d.db.query(
        `update event_jurnal_mapping set aktif = true where bumn_id = $1 and event_code = 'PENDAPATAN_JASA_GIRO'`,
        [d.bumnId],
      );
    }
  });

  // Kept last: it mutates the mapping table on purpose.
  test("spec 6.4 mengubah baris mapping mengubah jurnal yang dihasilkan, tanpa redeploy", async () => {
    const sebelum = await engine.postingEvent(
      "PENCAIRAN_PUMK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(6_000_000),
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );
    const barisSebelum = await bacaBarisDb(d.db, sebelum.id);
    expect(barisSebelum.find((b) => b.debit !== rp(0))?.akun_id).toBe(d.akun.piutangPokok.id);

    // An accountant edits the mapping row. Same process, same code, no restart.
    await d.gantiAkunMapping("PENCAIRAN_PUMK", "akun_debit_id", d.akun.piutangAlternatif.id);
    try {
      const sesudah = await engine.postingEvent(
        "PENCAIRAN_PUMK",
        { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(6_000_000) },
        d.ctx.approver,
      );
      const barisSesudah = await bacaBarisDb(d.db, sesudah.id);
      expect(barisSesudah.find((b) => b.debit !== rp(0))?.akun_id).toBe(d.akun.piutangAlternatif.id);
    } finally {
      await d.gantiAkunMapping("PENCAIRAN_PUMK", "akun_debit_id", d.akun.piutangPokok.id);
    }
  });

  test("spec 6.4 event code baru yang disisipkan saat runtime langsung bisa diposting, tanpa perubahan kode", async () => {
    // The strongest form of "mapping is data": this event code did not exist
    // in any TypeScript file, in the seed, or in the process, when the test
    // run started.
    const kodeBaru = kunci("EVENT_RUNTIME").toUpperCase().replace(/-/g, "_");
    await d.db.query(
      `insert into event_jurnal_mapping
         (bumn_id, event_code, deskripsi, akun_debit_id, akun_kredit_id, jenis_jurnal, aktif)
       values ($1, $2, 'disisipkan saat test berjalan', $3, $4, 'OTOMATIS', true)`,
      [d.bumnId, kodeBaru, d.akun.bebanOperasional.id, d.akun.kasKedua.id],
    );

    const jurnal = await engine.postingEvent(
      kodeBaru,
      { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(333_000) },
      d.ctx.approver,
    );
    const baris = await bacaBarisDb(d.db, jurnal.id);
    expect(baris.find((b) => b.debit !== rp(0))?.akun_id).toBe(d.akun.bebanOperasional.id);
    expect(baris.find((b) => b.kredit !== rp(0))?.akun_id).toBe(d.akun.kasKedua.id);
    expect(jurnal.status).toBe("POSTED");
  });
});
