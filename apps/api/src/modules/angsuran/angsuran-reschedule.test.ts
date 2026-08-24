// Spec 7.3 "Reschedule": approval first, then a new schedule version built
// from the current outstanding, with the old version's history intact.
//
// THE FIXTURE, ONCE, FOR THE WHOLE FILE.
// An akad of 12.000.000 over 12 months, FLAT 3 percent, rounding 0, first due
// date 10 March 2026: twelve rows of pokok 1.000.000,00 + jasa 30.000,00.
// Instalments 1, 2 and 3 are already LUNAS, so 3.000.000,00 of principal is
// history and 9.000.000,00 is outstanding when the reschedule lands.
// Rescheduling to 18 months keeps the arithmetic exact: 9.000.000 / 18 =
// 500.000,00 of pokok per row, and 9.000.000 x 3% x 18/12 = 405.000,00 of jasa,
// which is 22.500,00 per row. Nothing here needs a calculator to check.
//
// The paid rows are marked paid by the fixture rather than by the allocation
// engine: "three instalments already settled" is a PRECONDITION of a
// reschedule test, and routing it through a second unimplemented engine would
// turn one failure into two.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createAngsuranEngine, KODE_ANGSURAN, type AngsuranEngine } from "./contract";
import {
  buatDunia,
  jumlahUang,
  keSen,
  porterJurnalUji,
  rp,
  sen,
  tambahBulan,
  tolakDengan,
  type AkadFixture,
  type BarisJadwalDb,
  type DuniaAngsuran,
  type PorterUji,
} from "./test-support";

let d: DuniaAngsuran;
let engine: AngsuranEngine;
let porter: PorterUji;

const POKOK_AKAD = rp(12_000_000);
const JASA_AKAD = rp(360_000);
const MULAI = "2026-03-10";
/** Rows 1..3 fall due here; row 4, the first unpaid one, falls due 2026-06-10. */
const JATUH_TEMPO_PERTAMA_BELUM_BAYAR = "2026-06-10";
const TANGGAL_PENGAJUAN = "2026-06-20";

beforeAll(async () => {
  d = await buatDunia();
  porter = porterJurnalUji(d.db, d.jam);
  engine = createAngsuranEngine({ db: d.db, jurnal: porter, jam: d.jam });
});

beforeEach(() => {
  porter.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** An AKTIF akad with 3 of its 12 instalments already LUNAS. */
async function akadSetengahJalan(): Promise<AkadFixture> {
  await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
  await d.setelKonfigurasi("akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG");
  await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
  const akad = await d.buatAkad({
    pokok: POKOK_AKAD,
    rate: "0.030000",
    metode: "FLAT",
    tenorBulan: 12,
    tanggalMulaiAngsuran: MULAI,
  });
  await d.cairkan(akad.id, POKOK_AKAD, JASA_AKAD);
  await d.pasangJadwal(
    akad.id,
    1,
    Array.from({ length: 12 }, (_, i) => ({
      angsuranKe: i + 1,
      tanggalJatuhTempo: tambahBulan(MULAI, i),
      pokok: rp(1_000_000),
      jasaAdm: rp(30_000),
      saldoPokokSetelah: rp(12_000_000 - 1_000_000 * (i + 1)),
    })),
  );
  for (const ke of [1, 2, 3]) {
    await d.tandaiLunas(akad.id, 1, ke, tambahBulan(MULAI, ke - 1));
  }
  return akad;
}

function ringkasBaris(b: BarisJadwalDb): Record<string, unknown> {
  // Everything except is_active_version, which is a VERSION-level flag: the
  // trigger trg_pumk_jadwal_versi_50_propagasi flips it on every row of a
  // superseded version, LUNAS rows included, and that is correct. Spec 7.3.5's
  // "tetap utuh dan tidak diubah" is about the priced columns and the payment
  // record, which is what this captures.
  return {
    angsuran_ke: b.angsuran_ke,
    tanggal_jatuh_tempo: b.tanggal_jatuh_tempo,
    pokok: b.pokok,
    jasa_adm: b.jasa_adm,
    total: b.total,
    saldo_pokok_setelah: b.saldo_pokok_setelah,
    status: b.status,
    pokok_terbayar: b.pokok_terbayar,
    jasa_terbayar: b.jasa_terbayar,
    tanggal_lunas: b.tanggal_lunas,
  };
}

async function ajukan(akad: AkadFixture, tenorBaru = 18) {
  return engine.ajukanReschedule(
    {
      akadId: akad.id,
      tanggalPengajuan: TANGGAL_PENGAJUAN,
      alasan: "Omzet usaha mitra turun, angsuran diperpanjang",
      jenis: "PERPANJANG_TENOR",
      tenorBaru,
    },
    d.ctx.maker,
  );
}

describe("spec 7.3.1 reschedule butuh persetujuan sebelum berlaku", () => {
  test("spec 7.3.1: pengajuan lahir DRAFT dan tidak mengubah jadwal apa pun", async () => {
    const akad = await akadSetengahJalan();
    const sebelum = (await d.bacaJadwal(akad.id, 1)).map(ringkasBaris);

    const reschedule = await ajukan(akad);

    expect(reschedule.status).toBe("DRAFT");
    expect(reschedule.jadwalVersiLama).toBe(1);
    expect(reschedule.jadwalVersiBaru).toBeNull();
    // Nothing may move on a DRAFT: version 1 is still the active version, there
    // is no version 2, no row changed, and the akad is still AKTIF.
    expect(await d.bacaVersi(akad.id)).toEqual([
      { versi: 1, is_active_version: true, status: "ACTIVE", reschedule_id: null },
    ]);
    expect((await d.bacaJadwal(akad.id, 1)).map(ringkasBaris)).toEqual(sebelum);
    expect((await d.bacaAkad(akad.id)).status).toBe("AKTIF");
    expect(porter.panggilan.length).toBe(0);
  });

  test("spec 7.3.1: alasan wajib diisi", async () => {
    const akad = await akadSetengahJalan();
    await tolakDengan(
      engine.ajukanReschedule(
        {
          akadId: akad.id,
          tanggalPengajuan: TANGGAL_PENGAJUAN,
          alasan: "   ",
          jenis: "PERPANJANG_TENOR",
          tenorBaru: 18,
        },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.ALASAN_WAJIB,
    );
    expect(await d.bacaReschedule(akad.id)).toEqual([]);
  });

  test("spec 2.1: pengaju tidak boleh menyetujui reschedule-nya sendiri", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);
    // Spec 2: reject, do not merely hide the button. The maker here even holds
    // pumk.approve in this call's context, so only the maker-is-not-approver
    // rule can stop it.
    await tolakDengan(
      engine.setujuiReschedule(reschedule.id, {
        ...d.ctx.maker,
        permissions: [...d.ctx.maker.permissions, "pumk.approve"],
      }),
      KODE_ANGSURAN.APPROVER_TIDAK_BOLEH_MAKER,
    );
    expect(await d.bacaVersi(akad.id)).toEqual([
      { versi: 1, is_active_version: true, status: "ACTIVE", reschedule_id: null },
    ]);
  });

  test("spec 2: user tanpa permission pumk.approve tidak boleh menyetujui", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);
    await tolakDengan(
      engine.setujuiReschedule(reschedule.id, d.ctx.maker),
      KODE_ANGSURAN.TIDAK_BERWENANG,
    );
  });

  test("spec 7.3: persetujuan kedua atas reschedule yang sama ditolak", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);
    await engine.setujuiReschedule(reschedule.id, d.ctx.approver);
    // A second approval would build a third version out of an outstanding that
    // has already been restructured.
    await tolakDengan(
      engine.setujuiReschedule(reschedule.id, d.ctx.approver),
      KODE_ANGSURAN.RESCHEDULE_SUDAH_DIPROSES,
    );
    expect((await d.bacaVersi(akad.id)).length).toBe(2);
  });
});

describe("spec 7.3.2 sampai 7.3.8 reschedule yang disetujui", () => {
  test("spec 7.3.3: versi lama dinonaktifkan dan baris belum lunasnya jadi DIRESCHEDULE", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);

    await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    const versi = await d.bacaVersi(akad.id);
    expect(versi.length).toBe(2);
    expect(versi[0]).toEqual({
      versi: 1,
      is_active_version: false,
      status: "SUPERSEDED",
      reschedule_id: reschedule.id,
    });
    expect(versi[1].versi).toBe(2);
    expect(versi[1].is_active_version).toBe(true);
    expect(versi[1].status).toBe("ACTIVE");
    expect(versi[1].reschedule_id).toBe(reschedule.id);
    // pumk_jadwal_versi_aktif_uq enforces this in SQL too; asserted here so a
    // "two active versions" defect fails as a test, not as a driver error.
    expect(versi.filter((v) => v.is_active_version).length).toBe(1);

    const lama = await d.bacaJadwal(akad.id, 1);
    expect(lama.slice(3).every((b) => b.status === "DIRESCHEDULE")).toBe(true);
    expect(lama.every((b) => b.is_active_version === false)).toBe(true);
  });

  test("spec 7.3.5: baris yang sudah LUNAS di versi lama tetap utuh, tidak satu kolom pun berubah", async () => {
    const akad = await akadSetengahJalan();
    const sebelum = (await d.bacaJadwal(akad.id, 1)).slice(0, 3).map(ringkasBaris);
    const reschedule = await ajukan(akad);

    await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    const sesudah = (await d.bacaJadwal(akad.id, 1)).slice(0, 3).map(ringkasBaris);
    expect(sesudah).toEqual(sebelum);
    // Explicitly: they are still LUNAS, not swept into DIRESCHEDULE with the
    // rest of the version. Losing this is how a paid instalment gets billed
    // twice.
    expect(sesudah.map((b) => b.status)).toEqual(["LUNAS", "LUNAS", "LUNAS"]);
  });

  test("spec 7.3.4: versi baru dihitung dari outstanding saat ini dengan parameter baru", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad, 18);

    const hasil = await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    expect(hasil.versiLama).toBe(1);
    expect(hasil.versiBaru).toBe(2);
    expect(hasil.jadwalBaru.versi).toBe(2);
    expect(hasil.jadwalBaru.isActiveVersion).toBe(true);
    expect(hasil.jadwalBaru.baris.length).toBe(18);

    // 9.000.000 over 18 months, jasa 9.000.000 x 3% x 18/12 = 405.000 at
    // 22.500 a month. Every row identical because nothing needs rounding.
    for (const b of hasil.jadwalBaru.baris) {
      expect(b.pokok).toBe(rp(500_000));
      expect(b.jasaAdm).toBe(rp(22_500));
      expect(b.total).toBe(rp(522_500));
    }
    expect(hasil.jadwalBaru.baris[17].saldoPokokSetelah).toBe("0.00");
    expect(hasil.jadwalBaru.ringkasan.totalPokok).toBe(rp(9_000_000));
    expect(hasil.jadwalBaru.ringkasan.totalJasa).toBe(rp(405_000));

    // Due dates resume at the earliest unpaid instalment of the old version,
    // not at the approval date (see the note on setujuiReschedule in
    // ./contract.ts).
    expect(hasil.jadwalBaru.baris[0].tanggalJatuhTempo).toBe(JATUH_TEMPO_PERTAMA_BELUM_BAYAR);
    expect(hasil.jadwalBaru.baris[17].tanggalJatuhTempo).toBe(
      tambahBulan(JATUH_TEMPO_PERTAMA_BELUM_BAYAR, 17),
    );

    const tersimpan = await d.bacaJadwal(akad.id, 2);
    expect(tersimpan.length).toBe(18);
    expect(tersimpan.every((b) => b.is_active_version)).toBe(true);
    expect(tersimpan.every((b) => b.pokok_terbayar === "0.00")).toBe(true);
  });

  test("spec 7.3.6: akad jadi RESCHEDULED tapi tetap dihitung sebagai piutang aktif", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);

    await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.status).toBe("RESCHEDULED");
    expect(akadDb.outstanding_pokok).toBe(rp(9_000_000));
    // RESCHEDULED is inside the "active receivable" predicate that
    // pumk_akad_outstanding_idx and the spec 8.4 check 10 reconciliation both
    // use. A reschedule must never make an outstanding loan disappear from the
    // receivables list.
    expect(await d.dihitungSebagaiPiutangAktif(akad.id)).toBe(true);
    const rekon = await d.db.query<{ saldo_sub_ledger: string; status: string }>(
      `select saldo_sub_ledger::text as saldo_sub_ledger, status
         from v_rekonsiliasi_piutang where akad_id = $1`,
      [akad.id],
    );
    expect(rekon[0].saldo_sub_ledger).toBe(rp(9_000_000));
    expect(rekon[0].status).toBe("RESCHEDULED");
  });

  test("spec 7.3.7: tidak ada jurnal kalau nilai pokok tidak berubah", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);

    const hasil = await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    // A term extension moves nothing between accounts: the receivable is the
    // same 9.000.000 before and after. Posting a journal here would double the
    // receivable or invent income.
    expect(hasil.jurnalId).toBeNull();
    expect(porter.panggilan).toEqual([]);
    expect(hasil.outstandingBaru).toBe(rp(9_000_000));
  });

  test("spec 7.3.8: riwayat lengkap tersimpan, kartu piutang bisa menampilkan semua versi", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);
    await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    const riwayat = await engine.riwayatJadwal(akad.id, d.ctx.maker);

    // Spec 9.1 calls the Kartu Piutang the page staff open most; it needs every
    // version, with the active one identifiable, and version 1's twelve rows
    // still readable after being superseded.
    expect(riwayat.map((j) => j.versi)).toEqual([2, 1]);
    expect(riwayat.map((j) => j.isActiveVersion)).toEqual([true, false]);
    expect(riwayat[0].baris.length).toBe(18);
    expect(riwayat[1].baris.length).toBe(12);
    expect(riwayat[1].baris[0].pokok).toBe(rp(1_000_000));
    const semuaBaris = await d.bacaJadwal(akad.id);
    expect(semuaBaris.length).toBe(30);
  });

  test("spec 7.5.10: pokok terbayar historis + outstanding baru = pokok asli", async () => {
    const akad = await akadSetengahJalan();
    const reschedule = await ajukan(akad);

    const hasil = await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    // The arithmetic invariant of a reschedule, stated three ways so a failure
    // says which side moved: what the engine reports, what the new schedule
    // totals, and what the akad now carries.
    expect(hasil.pokokTerbayarHistoris).toBe(rp(3_000_000));
    expect(hasil.outstandingBaru).toBe(rp(9_000_000));
    expect(jumlahUang(hasil.pokokTerbayarHistoris, hasil.outstandingBaru)).toBe(POKOK_AKAD);
    expect(hasil.jadwalBaru.ringkasan.totalPokok).toBe(hasil.outstandingBaru);
    expect((await d.bacaAkad(akad.id)).outstanding_pokok).toBe(hasil.outstandingBaru);

    // And the same identity read straight from the rows: paid principal across
    // every version, plus the unpaid principal of the active one.
    const baris = await d.bacaJadwal(akad.id);
    const terbayar = baris.reduce((acc, b) => acc + keSen(b.pokok_terbayar), 0n);
    const sisaAktif = baris
      .filter((b) => b.is_active_version)
      .reduce((acc, b) => acc + keSen(b.pokok) - keSen(b.pokok_terbayar), 0n);
    expect(sen(terbayar + sisaAktif)).toBe(POKOK_AKAD);
  });
});

describe("spec 7.3 penjagaan reschedule", () => {
  test("spec 7.3 + BUILD-PLAN: tenor baru di atas batasan.tenor_max_bulan ditolak", async () => {
    const akad = await akadSetengahJalan();
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "24");
    // The 36-month ceiling of PER-1/MBU/03/2023 pasal 22(2) is not something a
    // reschedule gets to exceed, and the bound itself is configuration.
    await tolakDengan(ajukan(akad, 30), KODE_ANGSURAN.TENOR_DILUAR_BATAS);
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
  });

  test("spec 7.3: reschedule yang tidak ada ditolak dengan error domain", async () => {
    await tolakDengan(
      engine.setujuiReschedule("00000000-0000-0000-0000-000000000000", d.ctx.approver),
      KODE_ANGSURAN.RESCHEDULE_TIDAK_DITEMUKAN,
    );
  });

  test("spec 7.3: akad yang sudah LUNAS tidak bisa direschedule", async () => {
    const akad = await d.buatAkad({
      pokok: rp(6_000_000),
      metode: "FLAT",
      tenorBulan: 6,
      tanggalMulaiAngsuran: "2026-03-10",
    });
    await d.db.query(
      `update pumk_akad set status = 'LUNAS', tanggal_lunas = '2026-08-10',
              outstanding_pokok = 0, outstanding_jasa = 0 where id = $1`,
      [akad.id],
    );
    await tolakDengan(
      engine.ajukanReschedule(
        {
          akadId: akad.id,
          tanggalPengajuan: TANGGAL_PENGAJUAN,
          alasan: "salah input",
          jenis: "PERPANJANG_TENOR",
          tenorBaru: 12,
        },
        d.ctx.maker,
      ),
      KODE_ANGSURAN.AKAD_TIDAK_BISA_DIANGSUR,
    );
  });
});
