// BAGAN AKUN (spec 10.3 report 16): "Tree COA dengan kode, nama, tipe, saldo
// normal, status".
//
// The simplest of the seven, and the one every other report depends on being
// right: `is_kas` is the definition of Kas Akhir (report 18),
// `klasifikasi_laporan` is the definition of every line of reports 17 and 19,
// `is_postable` is the definition of which accounts appear on the Neraca
// Lajur, and `is_kontra` plus the `tanda` on the line it points at are the
// definition of how the allowance is presented. So this report is not just a
// listing; it is the place a reader checks WHY another report printed what it
// printed, and every one of those flags is asserted here.
//
// NO PERIOD, NO BRANCH SCOPE ON THE DATA. The chart of accounts belongs to the
// bumn, not to a month or a branch. It still carries the spec 10 header,
// because spec 10's preamble makes that header a property of every report.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KODE_BARIS, buatDunia, headerSah, type DuniaLaporan } from "./test-support";
import { NAMA_LAPORAN, type LaporanBaganAkun } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
});
afterAll(async () => {
  await d?.tutup();
});

function bagan(hanyaAktif = false): Promise<LaporanBaganAkun> {
  return d.engine.baganAkun({ hanyaAktif }, d.ctx.adminPusat);
}

describe("isi dan urutan tree", () => {
  test("memuat setiap akun bumn ini, header maupun daun, dalam urutan kode", async () => {
    const l = await bagan();
    const dbKode = await d.db.query<{ kode: string }>(
      `select kode from akun where bumn_id = $1 and deleted_at is null order by kode`,
      [d.bumnId],
    );
    expect(l.baris.map((b) => b.kode)).toEqual(dbKode.map((r) => r.kode));
    expect(l.baris.length).toBeGreaterThan(15);
  });

  test("parent dan level menggambarkan hierarki yang sesungguhnya", async () => {
    const l = await bagan();
    const byId = new Map(l.baris.map((b) => [b.akunId, b]));
    for (const b of l.baris) {
      if (b.parentId === null) {
        expect(b.level, `akun ${b.kode} tanpa parent harus level 1`).toBe(1);
        continue;
      }
      const induk = byId.get(b.parentId);
      expect(induk, `parent akun ${b.kode} tidak ikut tercetak`).toBeDefined();
      // migrations/0005 trg_akun_10_hierarki enforces both of these in the
      // database; the report must not contradict the database.
      expect(induk!.level).toBe(b.level - 1);
      expect(induk!.tipe).toBe(b.tipe);
      expect(induk!.isPostable, `parent ${induk!.kode} tidak boleh postable`).toBe(false);
      // Parents print before their children, which is what makes a flat list
      // renderable as a tree without a second sort.
      expect(l.baris.indexOf(induk!)).toBeLessThan(l.baris.indexOf(b));
    }
  });

  test("hanya daun yang postable", async () => {
    const l = await bagan();
    const punyaAnak = new Set(l.baris.map((b) => b.parentId).filter((x): x is string => !!x));
    for (const b of l.baris) {
      expect(b.isPostable, `akun ${b.kode}`).toBe(!punyaAnak.has(b.akunId));
    }
  });
});

describe("kolom yang diminta spec 10.3 laporan 16", () => {
  test("kode, nama, tipe, saldo normal dan status ada dan cocok dengan tabel", async () => {
    const l = await bagan();
    const kas = l.baris.find((b) => b.kode === d.akun.kas.kode)!;
    expect(kas.nama).toBe(d.akun.kas.nama);
    expect(kas.tipe).toBe("ASET");
    expect(kas.saldoNormal).toBe("D");
    expect(kas.aktif).toBe(true);
    expect(kas.status.length).toBeGreaterThan(0);

    const nonaktif = l.baris.find((b) => b.kode === d.akun.bebanNonaktif.kode)!;
    expect(nonaktif.aktif).toBe(false);
    // The two statuses must be distinguishable in print, which is the whole
    // point of the column.
    expect(nonaktif.status).not.toBe(kas.status);
  });

  test("akun kontra: tipe ASET dengan saldo normal K, dan baris laporan bertanda -1", async () => {
    // The single most misread row in the chart. It is an ASSET whose normal
    // balance is a CREDIT, presented as a deduction. Report 19 depends on
    // both halves; getting either wrong moves total assets by twice the
    // allowance.
    const l = await bagan();
    const penyisihan = l.baris.find((b) => b.kode === d.akun.penyisihan.kode)!;
    expect(penyisihan.tipe).toBe("ASET");
    expect(penyisihan.saldoNormal).toBe("K");
    expect(penyisihan.isKontra).toBe(true);
    expect(penyisihan.klasifikasiLaporan).toBe(KODE_BARIS.penyisihanKontra);
    const baris = await d.bacaBarisLaporan("POSISI_KEUANGAN");
    expect(baris.find((b) => b.kode === KODE_BARIS.penyisihanKontra)!.tanda).toBe(-1);
  });

  test("is_kas hanya pada akun kas, dan itulah himpunan yang Kas Akhir dijumlahkan", async () => {
    const l = await bagan();
    const kas = l.baris.filter((b) => b.isKas);
    expect(kas.map((b) => b.kode)).toEqual(["1.1.01", "1.1.02"]);
    // `akun_is_kas_hanya_aset_ck` (migrations/0005) exists because report 18
    // defines its closing balance as the sum of these.
    expect(kas.every((b) => b.tipe === "ASET")).toBe(true);
  });

  test("klasifikasi arus kas dilaporkan apa adanya, termasuk yang null", async () => {
    const l = await bagan();
    expect(l.baris.find((b) => b.kode === d.akun.asetTetap.kode)!.klasifikasiArusKas).toBe(
      "INVESTASI",
    );
    expect(l.baris.find((b) => b.kode === d.akun.pendapatanTerikat.kode)!.klasifikasiArusKas).toBe(
      "PENDANAAN",
    );
    // Non-cash accounts carry no classification, and the report says so rather
    // than inventing OPERASI. That null is exactly what makes report 18 refuse
    // when such an account turns up opposite cash.
    expect(l.baris.find((b) => b.kode === d.akun.penyisihan.kode)!.klasifikasiArusKas).toBeNull();
  });

  test("setiap akun menyebut baris laporan tempat ia dicetak", async () => {
    const l = await bagan();
    const kodeBaris = new Set((await d.bacaBarisLaporan()).map((b) => b.kode));
    for (const b of l.baris) {
      expect(kodeBaris.has(b.klasifikasiLaporan), `akun ${b.kode} -> ${b.klasifikasiLaporan}`).toBe(
        true,
      );
    }
  });
});

describe("filter status", () => {
  test("hanyaAktif membuang akun nonaktif, default menyertakannya", async () => {
    const semua = await bagan(false);
    const aktifSaja = await bagan(true);
    expect(semua.baris.map((b) => b.kode)).toContain(d.akun.bebanNonaktif.kode);
    expect(aktifSaja.baris.map((b) => b.kode)).not.toContain(d.akun.bebanNonaktif.kode);
    expect(aktifSaja.baris.every((b) => b.aktif)).toBe(true);
    expect(aktifSaja.baris.length).toBeLessThan(semua.baris.length);
  });
});

describe("bagan akun mengikuti data, bukan kode", () => {
  test("akun yang ditambahkan muncul tanpa perubahan kode", async () => {
    const sebelum = await bagan();
    const kode = "5.1.08";
    const parent = await d.db.query<{ id: string }>(
      `select id::text as id from akun where bumn_id = $1 and kode = '5'`,
      [d.bumnId],
    );
    await d.db.query(
      `insert into akun
         (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal, is_postable,
          klasifikasi_laporan, created_by, updated_by)
       values ($1, $2, 'Beban Bunga (ditambahkan runtime)', $3, 2, 'BEBAN', 'D', true, $4, $5, $5)`,
      [d.bumnId, kode, parent[0].id, KODE_BARIS.beban, d.userId.adminPusat],
    );
    const sesudah = await bagan();
    expect(sesudah.baris.length).toBe(sebelum.baris.length + 1);
    const baru = sesudah.baris.find((b) => b.kode === kode)!;
    expect(baru.nama).toBe("Beban Bunga (ditambahkan runtime)");
    expect(baru.tipe).toBe("BEBAN");
    expect(baru.isPostable).toBe(true);
  });
});

describe("header", () => {
  test("header spec 10 lengkap meski laporan ini tidak punya periode", async () => {
    const l = await bagan();
    headerSah(l.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.BAGAN_AKUN,
      cabangId: null,
      sumberData: "LEDGER_LIVE",
    });
    expect(l.header.periodeId).toBeNull();
    expect(l.header.dicetakOleh).toBe(d.namaUser.adminPusat);
  });
});
