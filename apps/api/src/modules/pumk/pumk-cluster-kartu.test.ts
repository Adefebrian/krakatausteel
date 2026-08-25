// SPEC 9.1's two read-heavy screens:
//
//   "Halaman cluster: kelola kelompok, tambah dan keluarkan anggota, lihat
//    performa kolektibilitas per cluster."
//   "Kartu Piutang per Mitra: satu halaman menampilkan data mitra, akad, jadwal
//    lengkap, semua setoran, riwayat kolektibilitas per periode, dan outstanding
//    terkini. Ini halaman yang paling sering dibuka petugas, buat sebaik
//    mungkin."
//
// Plus scenario 7: "Buka Kartu Piutang mitra tersebut, konfirmasi jadwal,
// setoran, dan outstanding KONSISTEN."
//
// WHY THE KARTU PIUTANG IS ASSERTED AGAINST THE LEDGER AND NOT AGAINST ITSELF.
// A read model is the easiest place in a system to introduce a second, quietly
// diverging source of truth: it is "just a query", it is written last, and it
// is the screen everyone actually looks at. If the kartu recomputes the
// outstanding from the schedule while the akad holds a different figure, the
// officer reads one number, the report reads another, and both look
// authoritative. So every number below is checked against the akad row, the
// setoran rows, and `v_rekonsiliasi_piutang`, three sources the kartu did not
// write.
//
// A NOTE ON HOW THE CLUSTER TESTS GOT HERE, because it is the argument for
// writing them before the permission existed. `pumk.cluster` was NOT in the
// shipped catalogue (apps/api/src/modules/auth/permissions.ts), so no role could
// hold it and every operation below had to fail closed with
// IZIN_BELUM_TERDAFTAR. The behaviour was specified anyway and the tests were
// left red as a standing demand on the catalogue owner, rather than made green
// by reusing `pumk.create` or `konfigurasi.master` (both wrong, for the reasons
// in ./contract.ts). The code has since been added, granted to ADMIN_CABANG and
// inherited by ADMIN_PUSAT, and these went green unchanged. The authorisation
// rule itself is pinned in ./pumk-otorisasi.test.ts; what is tested here is the
// membership behaviour.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  jumlahUang,
  keSen,
  kurangUang,
  periksaRekonsiliasiNol,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  POKOK_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

const ANGSURAN_BARIS = rp(1_030_000);

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

// ---------------------------------------------------------------------------
// Kartu piutang
// ---------------------------------------------------------------------------

describe("kartu piutang (spec 9.1, skenario 7)", () => {
  test("satu panggilan mengembalikan mitra, akad, jadwal, setoran, kelebihan dan outstanding", async () => {
    // "Satu halaman", so one call: an officer who has to stitch four endpoints
    // together will eventually stitch two of them from different moments.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    for (const tanggal of ["2026-03-10", "2026-04-10"]) {
      await angsuran.alokasikanSetoran(
        { akadId, tanggal, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      );
    }
    angsuran.reset();

    const kartu = await engine.kartuPiutang(akadId, d.ctx.maker);

    expect(kartu.mitra.id).toBe(f.mitraId);
    expect(kartu.mitra.namaLengkap.length).toBeGreaterThan(0);
    expect(kartu.mitra.kodeMitra.length).toBeGreaterThan(0);
    expect(kartu.mitra.status).toBe("AKTIF");

    expect(kartu.akad.id).toBe(akadId);
    expect(kartu.akad.pokokPinjaman).toBe(POKOK_BAKU);
    expect(kartu.akad.status).toBe("AKTIF");

    expect(kartu.setoran).toHaveLength(2);
    expect(kartu.setoran[0].jumlahDiterima).toBe(ANGSURAN_BARIS);
    expect(kartu.setoran[0].alokasiPokok).toBe(rp(1_000_000));
    expect(kartu.setoran[0].alokasiJasa).toBe(rp(30_000));
    // Every receipt names its journal, so the officer can drill from the kartu
    // into the buku besar without a second lookup.
    for (const s of kartu.setoran) expect(s.jurnalId).toBeTruthy();

    expect(kartu.kelebihan).toHaveLength(0);
    // Kolektibilitas snapshots are written by the closing engine (spec 8.1,
    // Fase 4). Empty here, but the SHAPE is part of this contract so the page
    // does not have to be rebuilt when closing lands.
    expect(Array.isArray(kartu.riwayatKolektibilitas)).toBe(true);
    expect(kartu.riwayatKolektibilitas).toHaveLength(0);
  }, 60_000);

  test("angka kartu piutang cocok dengan akad, dengan setoran, dan dengan buku besar", async () => {
    // Scenario 7's "konsisten", made precise. Four independent sources have to
    // agree: the akad row, the sum of the receipts, the reconciliation view,
    // and the kartu itself.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    for (const tanggal of ["2026-03-10", "2026-04-10", "2026-05-10"]) {
      await angsuran.alokasikanSetoran(
        { akadId, tanggal, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      );
    }
    angsuran.reset();

    const kartu = await engine.kartuPiutang(akadId, d.ctx.maker);
    const akad = await d.bacaAkad(akadId);
    const setoran = await d.bacaAngsuran(akadId);
    const rekon = await d.rekonsiliasi(akadId);

    // 1. The kartu's outstanding is the akad's outstanding, not a recomputation.
    expect(kartu.outstanding.pokok).toBe(akad.outstanding_pokok);
    expect(kartu.outstanding.jasa).toBe(akad.outstanding_jasa);
    expect(kartu.outstanding.pokok).toBe(rp(9_000_000));

    // 2. Principal repaid plus principal outstanding is the original loan.
    const totalPokokSetoran = jumlahUang(...setoran.map((s) => s.alokasi_pokok));
    expect(totalPokokSetoran).toBe(rp(3_000_000));
    expect(jumlahUang(totalPokokSetoran, kartu.outstanding.pokok)).toBe(POKOK_BAKU);
    expect(kurangUang(POKOK_BAKU, totalPokokSetoran)).toBe(kartu.outstanding.pokok);

    // 3. The kartu's own ledger balance matches the SHIPPED reconciliation view.
    expect(kartu.saldoBukuBesar).toBe(rekon.saldoBukuBesar);
    expect(kartu.saldoBukuBesar).toBe(kartu.outstanding.pokok);

    // 4. Spec 8.4 check 10, ON THE PAGE ITSELF. The screen an officer opens
    // every day is the screen that reports the drift, instead of the drift
    // waiting for a month-end tool run.
    expect(kartu.selisihRekonsiliasi).toBe("0.00");
    expect(kartu.selisihRekonsiliasi).toBe(rekon.selisih);
    periksaRekonsiliasiNol(rekon, rp(9_000_000));

    // 5. And the schedule's paid columns agree with the receipts, so the table
    // the officer reads row by row adds up to the totals above.
    const jadwal = await d.bacaJadwal(akadId);
    const terbayar = jadwal.reduce((acc, b) => acc + keSen(b.pokok_terbayar), 0n);
    expect(terbayar).toBe(keSen(totalPokokSetoran));
  }, 60_000);

  test("jadwal memuat SEMUA versi, terbaru dulu, dan tepat satu yang aktif", async () => {
    // "Halaman jadwal angsuran (tampilkan semua versi, tandai yang aktif)."
    // After a reschedule the officer needs both: the version being collected
    // now, and the one the earlier payments were made against.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    for (const tanggal of ["2026-03-10", "2026-04-10", "2026-05-10"]) {
      await angsuran.alokasikanSetoran(
        { akadId, tanggal, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
        d.ctx.maker,
      );
    }
    // The reschedule is a PRECONDITION here, so it runs through the real
    // instalment engine rather than through the unimplemented PUMK method.
    const r = await angsuran.ajukanReschedule(
      {
        akadId,
        tanggalPengajuan: "2026-06-20",
        alasan: "Omzet turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: 18,
      },
      d.ctx.maker,
    );
    await angsuran.setujuiReschedule(r.id, d.ctx.approver);
    angsuran.reset();

    const kartu = await engine.kartuPiutang(akadId, d.ctx.maker);
    expect(kartu.jadwal).toHaveLength(2);
    // Newest first: the version being collected is what the page opens on.
    expect(kartu.jadwal.map((j) => j.versi)).toEqual([2, 1]);
    expect(kartu.jadwal[0].isActiveVersion).toBe(true);
    expect(kartu.jadwal[1].isActiveVersion).toBe(false);
    expect(kartu.jadwal.filter((j) => j.isActiveVersion)).toHaveLength(1);

    // Version 1 is still readable IN FULL, all twelve rows, with its history.
    expect(kartu.jadwal[1].baris).toHaveLength(12);
    expect(kartu.jadwal[1].ringkasan.totalPokok).toBe(POKOK_BAKU);
    // Version 2 was built from the outstanding, not from the original loan.
    expect(kartu.jadwal[0].baris).toHaveLength(18);
    expect(kartu.jadwal[0].ringkasan.totalPokok).toBe(rp(9_000_000));

    // And the numbers still tie out across the reschedule.
    expect(kartu.outstanding.pokok).toBe(rp(9_000_000));
    expect(kartu.selisihRekonsiliasi).toBe("0.00");
  }, 90_000);

  test("kelebihan pembayaran tampil di kartu, bukan disembunyikan sebagai piutang negatif", async () => {
    // Invariant 10 from the officer's side. The mitra who overpaid will ask
    // where the money went, and the answer has to be on this page.
    const f = await d.siapkanProposal("DICAIRKAN");
    const akadId = f.akadId as string;
    await angsuran.alokasikanSetoran(
      { akadId, tanggal: "2026-05-10", jumlah: rp(12_500_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    angsuran.reset();

    const kartu = await engine.kartuPiutang(akadId, d.ctx.maker);
    expect(kartu.kelebihan).toHaveLength(1);
    expect(kartu.kelebihan[0].jumlah).toBe(rp(140_000));
    expect(kartu.kelebihan[0].status).toBe("TERTAHAN");
    expect(kartu.outstanding.pokok).toBe("0.00");
    expect(keSen(kartu.outstanding.pokok) >= 0n).toBe(true);
    expect(kartu.akad.status).toBe("LUNAS");
    expect(kartu.selisihRekonsiliasi).toBe("0.00");
  }, 60_000);

  test("kartu piutang menyertakan cluster mitra saat ada", async () => {
    // The cluster is what the kolektibilitas-per-cluster report groups on, so
    // the officer must be able to see it from the mitra's own page.
    const f = await d.siapkanProposal("DICAIRKAN");
    await engine.tambahAnggotaCluster(
      { clusterId: d.clusterId, mitraId: f.mitraId, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    const kartu = await engine.kartuPiutang(f.akadId as string, d.ctx.maker);
    expect(kartu.mitra.clusterId).toBe(d.clusterId);
  }, 30_000);

  test("kartu piutang akad yang tidak ada ditolak dengan AKAD_TIDAK_DITEMUKAN", async () => {
    await tolakDengan(
      () => engine.kartuPiutang("00000000-0000-4000-8000-000000000004", d.ctx.maker),
      KODE_PUMK.AKAD_TIDAK_DITEMUKAN,
    );
  });
});

// ---------------------------------------------------------------------------
// Cluster membership
// ---------------------------------------------------------------------------

describe("keanggotaan cluster (spec 9.1)", () => {
  // A CLUSTER OF ITS OWN, PER TEST.
  //
  // These tests assert on ROSTER SIZES (`toHaveLength(1)`), and the world's two
  // shared clusters are written to by the kartu piutang describe above and then
  // by each of these in turn. Nothing is cleaned up between tests, by design, so
  // a shared cluster turns every length assertion into an assertion about test
  // ORDER: the same code saw 1, then 2, then 4. That is not a stricter test, it
  // is a test that reports its neighbours.
  //
  // Same rule as every other business key in this fixture: unique per call.
  let klaster: string;
  let klasterLain: string;

  beforeEach(async () => {
    klaster = (await d.buatCluster()).id;
    klasterLain = (await d.buatCluster()).id;
  });

  test("menambah anggota menulis riwayat dan menunjuk cluster aktif mitra", async () => {
    const mitra = await d.buatMitra();
    const anggota = await engine.tambahAnggotaCluster(
      { clusterId: klaster, mitraId: mitra.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    expect(anggota.clusterId).toBe(klaster);
    expect(anggota.mitraId).toBe(mitra.id);
    expect(anggota.tanggalMasuk).toBe("2026-01-05");
    expect(anggota.tanggalKeluar).toBeNull();

    const baris = await d.bacaAnggotaCluster(klaster);
    expect(baris).toHaveLength(1);
    expect(baris[0].mitra_id).toBe(mitra.id);
    // `cluster_anggota` is the HISTORY and `mitra.cluster_id` is the
    // denormalised current pointer. Both have to move, or the two disagree
    // about who is in the group today.
    expect((await d.bacaMitra(mitra.id)).cluster_id).toBe(klaster);
  });

  test("mitra hanya boleh di satu cluster pada satu waktu, ditolak di depan indeks unik", async () => {
    // `cluster_anggota_aktif_uq` enforces it, with a raw constraint name. The
    // module must say it in Indonesian first.
    const mitra = await d.buatMitra();
    await engine.tambahAnggotaCluster(
      { clusterId: klaster, mitraId: mitra.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    const err = await tolakDengan(
      () =>
        engine.tambahAnggotaCluster(
          { clusterId: klasterLain, mitraId: mitra.id, tanggalMasuk: "2026-02-05" },
          d.ctx.adminPusat,
        ),
      KODE_PUMK.MITRA_SUDAH_DI_CLUSTER,
    );
    expect(err.message).not.toContain("cluster_anggota_aktif_uq");
    expect(await d.bacaAnggotaCluster(klasterLain)).toHaveLength(0);
  }, 30_000);

  test("mengeluarkan anggota menutup riwayat dengan tanggal dan alasan, lalu mitra bisa pindah", async () => {
    // Leaving is a dated fact, not a deletion: a cluster's past performance has
    // to stay attributable to the members it actually had.
    const mitra = await d.buatMitra();
    await engine.tambahAnggotaCluster(
      { clusterId: klaster, mitraId: mitra.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    const keluar = await engine.keluarkanAnggotaCluster(
      {
        clusterId: klaster,
        mitraId: mitra.id,
        tanggalKeluar: "2026-04-30",
        alasan: "Pindah domisili",
      },
      d.ctx.adminPusat,
    );
    expect(keluar.tanggalKeluar).toBe("2026-04-30");
    expect(keluar.alasanKeluar).toBe("Pindah domisili");

    const baris = await d.bacaAnggotaCluster(klaster);
    expect(baris).toHaveLength(1);
    expect(baris[0].tanggal_keluar).toBe("2026-04-30");
    expect((await d.bacaMitra(mitra.id)).cluster_id).toBeNull();

    // And now the mitra may join another cluster.
    await engine.tambahAnggotaCluster(
      { clusterId: klasterLain, mitraId: mitra.id, tanggalMasuk: "2026-05-01" },
      d.ctx.adminPusat,
    );
    expect(await d.bacaAnggotaCluster(klasterLain)).toHaveLength(1);
    // The old membership is still on the record, closed.
    expect(await d.bacaAnggotaCluster(klaster)).toHaveLength(1);
  }, 30_000);

  test("mengeluarkan mitra yang bukan anggota ditolak", async () => {
    const mitra = await d.buatMitra();
    await tolakDengan(
      () =>
        engine.keluarkanAnggotaCluster(
          {
            clusterId: klaster,
            mitraId: mitra.id,
            tanggalKeluar: "2026-04-30",
            alasan: "Tidak pernah masuk",
          },
          d.ctx.adminPusat,
        ),
      KODE_PUMK.MITRA_BUKAN_ANGGOTA_CLUSTER,
    );
  });

  test("alasan keluar wajib diisi", async () => {
    const mitra = await d.buatMitra();
    await engine.tambahAnggotaCluster(
      { clusterId: klaster, mitraId: mitra.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    await tolakDengan(
      () =>
        engine.keluarkanAnggotaCluster(
          { clusterId: klaster, mitraId: mitra.id, tanggalKeluar: "2026-04-30", alasan: "  " },
          d.ctx.adminPusat,
        ),
      KODE_PUMK.CATATAN_WAJIB,
    );
    expect((await d.bacaAnggotaCluster(klaster))[0].tanggal_keluar).toBeNull();
  }, 30_000);

  test("daftar anggota bisa dibaca per tanggal, sehingga roster masa lalu tetap benar", async () => {
    // Membership as dated history. Without `padaTanggal` a cluster performance
    // report for March would be computed against today's roster, which is
    // invariant 14 (reproducible reports) broken on the cluster page.
    const tetap = await d.buatMitra();
    const pindah = await d.buatMitra();
    await engine.tambahAnggotaCluster(
      { clusterId: klaster, mitraId: tetap.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    await engine.tambahAnggotaCluster(
      { clusterId: klaster, mitraId: pindah.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminPusat,
    );
    await engine.keluarkanAnggotaCluster(
      {
        clusterId: klaster,
        mitraId: pindah.id,
        tanggalKeluar: "2026-04-30",
        alasan: "Keluar kelompok",
      },
      d.ctx.adminPusat,
    );

    const sekarang = await engine.daftarAnggotaCluster(klaster, d.ctx.maker);
    expect(sekarang.filter((a) => a.tanggalKeluar === null).map((a) => a.mitraId)).toEqual([
      tetap.id,
    ]);

    const bulanMaret = await engine.daftarAnggotaCluster(klaster, d.ctx.maker, {
      padaTanggal: "2026-03-31",
    });
    expect(bulanMaret.map((a) => a.mitraId).sort()).toEqual([tetap.id, pindah.id].sort());

    const bulanMei = await engine.daftarAnggotaCluster(klaster, d.ctx.maker, {
      padaTanggal: "2026-05-31",
    });
    expect(bulanMei.map((a) => a.mitraId)).toEqual([tetap.id]);
  }, 30_000);

  test("cluster yang tidak ada ditolak dengan CLUSTER_TIDAK_DITEMUKAN", async () => {
    const mitra = await d.buatMitra();
    await tolakDengan(
      () =>
        engine.tambahAnggotaCluster(
          {
            clusterId: "00000000-0000-4000-8000-000000000005",
            mitraId: mitra.id,
            tanggalMasuk: "2026-01-05",
          },
          d.ctx.adminPusat,
        ),
      KODE_PUMK.CLUSTER_TIDAK_DITEMUKAN,
    );
  });

  test("mitra yang tidak ada ditolak dengan MITRA_TIDAK_DITEMUKAN", async () => {
    await tolakDengan(
      () =>
        engine.tambahAnggotaCluster(
          {
            clusterId: klaster,
            mitraId: "00000000-0000-4000-8000-000000000006",
            tanggalMasuk: "2026-01-05",
          },
          d.ctx.adminPusat,
        ),
      KODE_PUMK.MITRA_TIDAK_DITEMUKAN,
    );
  });
});
