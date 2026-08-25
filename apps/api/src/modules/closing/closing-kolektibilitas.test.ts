// SPEC 8.1, CLOSING KOLEKTIBILITAS.
//
// Four claims this file exists to pin, in descending order of how expensive
// they are to get wrong:
//
//   1. THE DAY BANDS ARE DATA. spec 5.1 says "Simpan sebagai tabel range yang
//      bisa diedit, bukan if else di kode", and spec 5's preamble makes the
//      numbers themselves a default awaiting the client's confirmation. So the
//      tests below change a row and assert the classification moves. An `if
//      (hari <= 30)` passes the spec's four example cases and fails every one
//      of these.
//   2. PREVIEW WRITES NOTHING. spec 8.1 calls this "fitur yang paling
//      dihargai user akuntansi": the accountant sees the classification
//      movement matrix BEFORE committing. A preview that quietly writes is not
//      a preview, and the damage is invisible until the period is closed on
//      numbers nobody approved.
//   3. RE-RUNNING IS IDEMPOTENT (invariant 13), and re-running after the
//      period closes is REFUSED, because a closed period's numbers are frozen.
//   4. A CLASSIFICATION THE CONFIGURATION CANNOT PRODUCE IS A REFUSAL, not a
//      default. A gap in the bands must not silently resolve to LANCAR: that
//      under-provisions the whole portfolio and every journal still balances.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_CLOSING } from "./contract";
import {
  buatDunia,
  jumlahUang,
  kaliRate,
  rp,
  tolakDengan,
  type DuniaClosing,
} from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

describe("spec 8.1: rentang hari dibaca dari tabel konfigurasi", () => {
  test("akad yang sama berpindah kelas ketika baris rentang diubah, tanpa deploy", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    expect((await d.bacaSnapshot(p.id))[0].kolektibilitas).toBe("KURANG_LANCAR");

    // Widen LANCAR past 45 days and narrow the next band. Nothing about the
    // akad changes; only the table does.
    await d.setelRange("LANCAR", 0, 60);
    await d.setelRange("KURANG_LANCAR", 61, 180);
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    const sesudah = await d.bacaSnapshot(p.id);
    expect(sesudah).toHaveLength(1);
    expect(sesudah[0].akad_id).toBe(akad.akadId);
    expect(sesudah[0].hari_tunggakan).toBe(45);
    expect(sesudah[0].kolektibilitas).toBe("LANCAR");
    expect(sesudah[0].nilai_penyisihan).toBe("0.00");
  });

  test("hari tunggakan yang tidak tercakup rentang mana pun ditolak, bukan dianggap LANCAR", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 200, padaTanggal: p.tanggalAkhir });

    // A gap at 181..270: the class that covered it is gone. migrations/0004
    // deliberately does not constrain this, because the config screen must be
    // allowed to pass through a half-edited state.
    await d.hapusRange("DIRAGUKAN");

    // Refusing is the only safe answer. Defaulting to LANCAR would mark a
    // 200-day arrears as performing and provision it at zero, and nothing
    // downstream would ever disagree.
    await tolakDengan(
      () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP,
    );
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
  });

  test("rentang yang tumpang tindih ditolak, karena klasifikasinya tidak tunggal", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    // 31..180 and 20..90 both cover 45. Whichever the engine picked would be an
    // accident of row order, and the same closing run could classify the same
    // akad differently after an unrelated UPDATE reordered the heap.
    await d.setelRange("DIRAGUKAN", 20, 90);

    await tolakDengan(
      () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH,
    );
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
  });

  test("rate yang tidak ada untuk kelas yang dipakai ditolak, bukan diperlakukan nol", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    await d.hapusRate("MACET");

    // Treating a missing rate as zero is the same failure as the missing band:
    // it silently reports the worst part of the portfolio as fully provisioned
    // at nothing.
    await tolakDengan(
      () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.RATE_PENYISIHAN_TIDAK_ADA,
    );
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
  });

  test("dasar perhitungan OUTSTANDING_POKOK_PLUS_JASA mengubah basisnya, bukan ratenya", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    const rate = await d.bacaRate("MACET");
    const outstandingJasa = (await d.bacaAkad(akad.akadId)).outstanding_jasa;
    expect(outstandingJasa).not.toBe("0.00");

    await d.setelKonfigurasi(
      "akuntansi",
      "dasar_perhitungan_penyisihan",
      "OUTSTANDING_POKOK_PLUS_JASA",
    );
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    const baris = (await d.bacaSnapshot(p.id))[0];
    expect(baris.dasar_perhitungan).toBe("OUTSTANDING_POKOK_PLUS_JASA");
    expect(baris.rate_penyisihan).toBe(rate);
    expect(baris.nilai_penyisihan).toBe(
      kaliRate(jumlahUang(akad.pokok, outstandingJasa), rate),
    );
  });

  test("mode KOLEKTIF_HISTORIS dengan histori kurang dari minimum ditolak, bukan diam diam jatuh ke tabel rate", async () => {
    // docs/BUILD-PLAN.md requires BOTH modes as capabilities. A world that is
    // two months old cannot satisfy `penyisihan_min_bulan_histori`, and
    // quietly falling back to RATE_TABLE would report a collectively-impaired
    // allowance that was in fact a rate table, in a period an auditor will
    // later ask about.
    const p = d.periode(2026, 3);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({
      hariTunggakan: 20,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.setelKonfigurasi("akuntansi", "mode_penyisihan", "KOLEKTIF_HISTORIS");

    await tolakDengan(
      () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.HISTORI_TIDAK_CUKUP,
    );
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
  });
});

describe("spec 8.1: preview sebelum commit", () => {
  test("preview menghitung penuh dan MENULIS NOL BARIS", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 200, padaTanggal: p.tanggalAkhir });

    const preview = await d.engine.previewKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    expect(preview.tersimpan).toBe(false);
    expect(preview.totalAkadDiproses).toBe(1);
    expect(preview.baris).toHaveLength(1);
    expect(preview.baris[0].akadId).toBe(akad.akadId);
    expect(preview.baris[0].kolektibilitas).toBe("DIRAGUKAN");
    expect(preview.tanggalAkhirPeriode).toBe(p.tanggalAkhir);

    // NOTHING on disk: no snapshot, no committed run, no mitra flipped.
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
    expect((await d.bacaRunKolektibilitas(p.id)).filter((r) => r.status === "SELESAI")).toHaveLength(0);
    const mitra = await d.db.query<{ status: string }>(
      `select status from mitra where id = $1`,
      [akad.mitraId],
    );
    expect(mitra[0].status).toBe("AKTIF");
  });

  test("preview menampilkan matriks perpindahan klasifikasi terhadap periode sebelumnya", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    const akad = await d.buatAkad({
      hariTunggakan: 45,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    d.setelJam(p1.tanggalAkhir);
    await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    expect((await d.bacaSnapshot(p1.id))[0].kolektibilitas).toBe("KURANG_LANCAR");

    // A month later, unpaid, so the arrears have grown by one month.
    d.setelJam(p2.tanggalAkhir);
    const preview = await d.engine.previewKolektibilitas({ periodeId: p2.id }, d.ctx.approver);

    expect(preview.baris[0].kolektibilitasPeriodeLalu).toBe("KURANG_LANCAR");
    expect(preview.baris[0].kolektibilitas).toBe("KURANG_LANCAR");
    // THE MATRIX. One cell, from -> to, with the akad count and the exposure
    // that moved. This is the summary spec 8.1 says accounting users value most,
    // and it must be available BEFORE the commit, not reconstructed after.
    expect(preview.matriks).toEqual([
      {
        dari: "KURANG_LANCAR",
        ke: "KURANG_LANCAR",
        jumlahAkad: 1,
        outstandingPokok: akad.pokok,
      },
    ]);
    expect(preview.ringkasanPerKelas).toContainEqual({
      kelas: "KURANG_LANCAR",
      jumlahAkad: 1,
      outstandingPokok: akad.pokok,
      nilaiPenyisihan: kaliRate(akad.pokok, await d.bacaRate("KURANG_LANCAR")),
    });
    expect(await d.jumlahSnapshot(p2.id)).toBe(0);
  });

  test("akad yang belum pernah disnapshot masuk matriks dengan dari = null", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });

    const preview = await d.engine.previewKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    expect(preview.baris[0].kolektibilitasPeriodeLalu).toBeNull();
    expect(preview.matriks).toEqual([
      { dari: null, ke: "MACET", jumlahAkad: 1, outstandingPokok: akad.pokok },
    ]);
  });

  test("preview dan commit menghasilkan angka yang sama persis", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.buatAkad({ hariTunggakan: 300, padaTanggal: p.tanggalAkhir });
    await d.buatAkad({ hariTunggakan: null, padaTanggal: p.tanggalAkhir });

    const preview = await d.engine.previewKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const hasil = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    // A preview an accountant approved and a commit that produced something
    // else is worse than no preview at all.
    expect(hasil.baris).toEqual(preview.baris);
    expect(hasil.matriks).toEqual(preview.matriks);
    expect(hasil.ringkasanPerKelas).toEqual(preview.ringkasanPerKelas);
    expect(hasil.totalPenyisihanDibutuhkan).toBe(preview.totalPenyisihanDibutuhkan);
    expect(hasil.tersimpan).toBe(true);
  });
});

describe("spec 8.1: idempotensi dan snapshot per akad per periode", () => {
  test("re-run menulis ulang snapshot periode itu, tidak menggandakannya", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    const pertama = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    expect(pertama.menggantikanRunSebelumnya).toBe(false);
    expect(await d.jumlahSnapshot(p.id)).toBe(1);

    // A new akad appears, so the SECOND run has genuinely different work to do.
    // Idempotency is not "the second run does nothing", it is "the second run
    // leaves one correct set of rows, not two".
    await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    const kedua = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    expect(kedua.menggantikanRunSebelumnya).toBe(true);
    expect(await d.jumlahSnapshot(p.id)).toBe(2);
    const snapshot = await d.bacaSnapshot(p.id);
    expect(snapshot.filter((s) => s.akad_id === akad.akadId)).toHaveLength(1);
    expect((await d.bacaRunKolektibilitas(p.id)).filter((r) => r.status === "SELESAI")).toHaveLength(1);
  });

  test("satu akad hanya boleh punya satu snapshot per periode, dijaga skema juga", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    const indeks = await d.db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'kolektibilitas_snapshot' and indexname = 'kolektibilitas_snapshot_uq'`,
    );
    expect(indeks).toHaveLength(1);
    expect(indeks[0].indexdef).toContain("periode_id");
    expect(indeks[0].indexdef).toContain("akad_id");

    const baris = await d.bacaSnapshot(p.id);
    expect(baris.filter((s) => s.akad_id === akad.akadId)).toHaveLength(1);
    expect(baris[0].periode_id).toBe(p.id);
  });

  test("re-run ditolak begitu periodenya CLOSED", async () => {
    // spec 8.1: "Batasi: hanya boleh dijalankan ulang selama periode masih
    // OPEN." A closed period's snapshot is what its penyisihan journal and its
    // frozen trial balance were built from; rewriting it would make a filed
    // period disagree with itself.
    const p = d.periode(2026, 1);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({
      hariTunggakan: 20,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: p.tanggalMulai,
    });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const sebelum = await d.bacaSnapshot(p.id);

    await d.tutupPeriodeLangsung(p);

    await tolakDengan(
      () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver),
      KODE_CLOSING.PERIODE_TIDAK_OPEN,
    );
    expect(await d.bacaSnapshot(p.id)).toEqual(sebelum);
  });
});

describe("spec 8.1: populasi, penandaan mitra dan scope cabang", () => {
  test("hanya akad AKTIF, RESCHEDULED atau MACET yang masuk populasi", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const aktif = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    const belumCair = await d.buatAkad({
      hariTunggakan: 45,
      padaTanggal: p.tanggalAkhir,
      janganCairkan: true,
    });

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const akadDisnapshot = (await d.bacaSnapshot(p.id)).map((s) => s.akad_id);
    expect(akadDisnapshot).toContain(aktif.akadId);
    // Money that was never disbursed is not a receivable and must not carry an
    // allowance, however overdue its (unfunded) schedule looks.
    expect(akadDisnapshot).not.toContain(belumCair.akadId);
  });

  test("mitra ditandai BERMASALAH hanya kalau konfigurasi mengizinkan", async () => {
    const p1 = d.periode(2027, 6);
    const p2 = d.periode(2027, 7);
    d.setelJam(p1.tanggalAkhir);
    await d.setelKonfigurasi("kolektibilitas", "tandai_mitra_bermasalah_saat_macet", "false");
    const akad = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p1.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    const mati = await d.engine.jalankanKolektibilitas({ periodeId: p1.id }, d.ctx.approver);
    expect(mati.mitraDitandaiBermasalah).toEqual([]);
    let mitra = await d.db.query<{ status: string }>(`select status from mitra where id = $1`, [
      akad.mitraId,
    ]);
    expect(mitra[0].status).toBe("AKTIF");

    await d.setelKonfigurasi("kolektibilitas", "tandai_mitra_bermasalah_saat_macet", "true");
    d.setelJam(p2.tanggalAkhir);
    const hidup = await d.engine.jalankanKolektibilitas({ periodeId: p2.id }, d.ctx.approver);
    expect(hidup.mitraDitandaiBermasalah).toEqual([akad.mitraId]);
    mitra = await d.db.query<{ status: string }>(`select status from mitra where id = $1`, [
      akad.mitraId,
    ]);
    expect(mitra[0].status).toBe("BERMASALAH");
  });

  test("run per cabang hanya menyentuh cabang itu; run tanpa cabang menyentuh semuanya", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const a = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    const b = await d.buatAkad({
      hariTunggakan: 45,
      padaTanggal: p.tanggalAkhir,
      cabangId: d.cabangLainId,
    });

    // spec 8.1 opening line: "per periode per cabang, atau semua cabang
    // sekaligus". Admin Pusat, because a per-branch user cannot see the other.
    const satuCabang = await d.engine.jalankanKolektibilitas(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(satuCabang.baris.map((x) => x.akadId)).toEqual([a.akadId]);
    expect((await d.bacaSnapshot(p.id)).map((s) => s.akad_id)).toEqual([a.akadId]);

    const semua = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.adminPusat);
    expect(semua.baris.map((x) => x.akadId).sort()).toEqual([a.akadId, b.akadId].sort());
    expect(await d.jumlahSnapshot(p.id)).toBe(2);
  });

  test("tunggakan pokok dan jasa dicatat terpisah dari outstanding", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const akad = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    const jadwal = await d.bacaJadwal(akad.akadId);
    const tertunggak = jadwal.filter((r) => r.tanggal_jatuh_tempo <= p.tanggalAkhir);
    expect(tertunggak).toHaveLength(2);

    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const baris = (await d.bacaSnapshot(p.id))[0];

    // The snapshot is the source for Laporan Kolektibilitas and for the aging
    // reports, so arrears and outstanding are different columns and must not be
    // conflated: the akad owes 12.000.000 in total and is BEHIND on two rows.
    expect(baris.outstanding_pokok).toBe(akad.pokok);
    expect(baris.tunggakan_pokok).toBe(
      jumlahUang(...tertunggak.map((r) => r.pokok)),
    );
    expect(baris.tunggakan_jasa).toBe(
      jumlahUang(...tertunggak.map((r) => r.jasa_adm)),
    );
    expect(baris.tanggal_jatuh_tempo_tertunggak_tertua).toBe(jadwal[0].tanggal_jatuh_tempo);
  });

  test("run dicatat di closing_kolektibilitas dengan jumlah akad dan ringkasan", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    const hasil = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const run = await d.bacaRunKolektibilitas(p.id);
    const selesai = run.filter((r) => r.status === "SELESAI");
    expect(selesai).toHaveLength(1);
    expect(selesai[0].id).toBe(hasil.closingId);
    expect(selesai[0].total_akad_diproses).toBe(2);
    // The migration matrix lives on the run row so the summary screen does not
    // re-aggregate thousands of snapshots to draw one table.
    expect(JSON.stringify(selesai[0].ringkasan_json)).toContain("MACET");

    const riwayat = await d.engine.riwayatKolektibilitas(p.id, d.ctx.approver);
    expect(riwayat.map((r) => r.id)).toContain(hasil.closingId);
  });

  test("total penyisihan dibutuhkan adalah jumlah baris, dan itulah yang dikonsumsi spec 8.2", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const a = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    const b = await d.buatAkad({
      hariTunggakan: 300,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });

    const hasil = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    const diharapkan = jumlahUang(
      kaliRate(a.pokok, await d.bacaRate("KURANG_LANCAR")),
      kaliRate(b.pokok, await d.bacaRate("MACET")),
      rp(0),
    );
    expect(hasil.totalPenyisihanDibutuhkan).toBe(diharapkan);
    expect(
      jumlahUang(...(await d.bacaSnapshot(p.id)).map((s) => s.nilai_penyisihan)),
    ).toBe(diharapkan);
  });
});
