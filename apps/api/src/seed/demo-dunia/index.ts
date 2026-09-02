// Spec 13's demo data generator: twenty four months of a TJSL unit, replayed
// month by month through the real engines.
//
// THE ONE RULE THAT DECIDED THE DESIGN, in the specification's own words: a
// seed that produces an unbalanced balance sheet is worse than no seed at all.
// So there is exactly one shape of loop here and it is the shape the business
// actually has:
//
//   for each month, oldest first:
//     top the branch cash up if the month is about to outspend it
//     run the routine entries (giro, operating expense, quarterly pembinaan)
//     start the proposals whose month this is, and walk each to its own state
//     disburse the ones that reach DICAIRKAN
//     take this month's instalments, per akad, per behaviour
//     run kolektibilitas, penyisihan and akrual
//     check the ten closing prerequisites, and CLOSE only if they all pass
//
// Every one of those steps is an engine call. Nothing here writes a `jurnal`
// row, a `jurnal_baris` row, a `pumk_jadwal_angsuran` row, a
// `kolektibilitas_snapshot` row or a `saldo_akun_periode` row: those are all
// side effects of the calls above. Migration 0020's posting-path trigger and
// tools/check-boundaries.ts both refuse the alternative, which is the point.
//
// IDEMPOTENCY, and what it can and cannot mean here.
// The ledger refuses physical deletion by design (migration 0002), so "run it
// again and get the same world" cannot be implemented as delete-and-rebuild.
// What is implemented instead:
//   - a COMPLETE world is detected and the run is a no-op, so `db:seed:demo`
//     twice in a row is safe and fast;
//   - a PARTIAL world (some akad, but not the full set) is refused with an
//     instruction, because resuming a half-replayed twenty four months would
//     produce a plausible-looking ledger that nobody could reconcile;
//   - everything upstream of the ledger (mitra, cluster, wilayah, portal
//     submissions, periods) is written with ON CONFLICT DO UPDATE, so those
//     halves genuinely are idempotent.
// See SEED.md for the operator-facing version of this.
import { createDbAdapter } from "../../core/adapters/db";
import type { DbPort } from "../../core/ports/db";
import { dadu, keSen, rp, rupiahTampil, tanggal } from "./acak";
import { bangunDunia, BULAN_RIWAYAT_BAKU, type Dunia } from "./dunia";
import { JUMLAH_MITRA, pastikanCluster, pastikanMitra } from "./mitra";
import {
  JUMLAH_AKAD,
  JUMLAH_PROPOSAL,
  jalankanProposal,
  langkahBulananAkad,
  rencanakanPumk,
  type AkadHidup,
  type RingkasanBulan,
} from "./pumk";
import {
  JUMLAH_NON_PUMK,
  jalankanNonPumkAwal,
  jalankanNonPumkLpj,
  rencanakanNonPumk,
} from "./nonpumk";
import { jurnalRutinBulanan, ringkasanRutinBaru } from "./rutin";
import { seedSubmissionPortal, JUMLAH_SUBMISSION } from "./portal";
import { seedRka } from "./rka";
import { hasilTutupBaru, jalankanPipelineClosing, tutupPeriodeDemo } from "./tutup";
import {
  cetakPemeriksaan,
  periksaAkuntansi,
  periksaIntegritas,
  periksaPrasyaratSemuaPeriode,
  periksaTemplateLaporan,
  type Pemeriksaan,
} from "./periksa";

/** Fixed seed. Two runs of this generator produce the same world. */
const BENIH = 20260913;

/** Akad rows a complete world holds: 90 disbursed plus 8 still at akad stage. */
const AKAD_TOTAL = JUMLAH_AKAD + 8;

export interface OpsiSeedDemoTransaksi {
  db?: DbPort;
  /** Wall clock. The last period is the month this lands in. */
  sekarang?: Date;
  bulanRiwayat?: number;
  log?: (line: string) => void;
}

export interface HasilSeedDemoTransaksi {
  dilewati: boolean;
  detikBerjalan: number;
  mitra: number;
  proposal: number;
  akad: number;
  nonPumk: number;
  submission: number;
  periodeDitutup: number;
  setoran: number;
  lulus: boolean;
}

export async function seedDemoTransaksi(
  opsi: OpsiSeedDemoTransaksi = {},
): Promise<HasilSeedDemoTransaksi> {
  const mulaiJalan = Date.now();
  const db = opsi.db ?? createDbAdapter();
  const log = opsi.log ?? ((line: string) => console.log(line));

  const dunia = await bangunDunia({
    db,
    sekarang: opsi.sekarang,
    bulanRiwayat: opsi.bulanRiwayat ?? BULAN_RIWAYAT_BAKU,
    log,
  });
  const jumlahBulan = dunia.periode.length;

  const sudahAda = await hitungAkad(dunia);
  if (sudahAda >= AKAD_TOTAL) {
    log(`  dunia demo sudah lengkap (${sudahAda} akad, ${jumlahBulan} periode); tidak diulang.`);
    return {
      dilewati: true,
      detikBerjalan: (Date.now() - mulaiJalan) / 1000,
      mitra: 0,
      proposal: 0,
      akad: sudahAda,
      nonPumk: 0,
      submission: 0,
      periodeDitutup: 0,
      setoran: 0,
      lulus: true,
    };
  }
  if (sudahAda > 0) {
    throw new Error(
      `Dunia demo separuh jadi: ada ${sudahAda} akad dari ${AKAD_TOTAL}. Generator ini tidak ` +
        "melanjutkan replay yang terputus, karena hasilnya adalah buku besar yang tampak wajar " +
        "tapi tidak bisa direkonsiliasi. Bangun ulang databasenya lebih dulu " +
        "(bun run db:reset untuk test DB, atau dropdb/createdb + db:migrate untuk dev), " +
        "lalu bun run db:seed dan bun run db:seed:demo.",
    );
  }

  const d = dadu(BENIH);

  // --- master and pipeline data ------------------------------------------
  const mitra = await pastikanMitra(dunia, d);
  log(`  mitra       ${mitra.length} mitra binaan di ${dunia.cabang.length} cabang`);

  const portal = await seedSubmissionPortal(dunia, d);
  log(`  portal      ${portal.semua.length} pengajuan online (${portal.untukKonversi.length} menunggu konversi)`);

  const cluster = await pastikanCluster(dunia, mitra, dunia.periode[0]!.mulai);
  log(`  cluster     ${cluster.length} kelompok binaan dengan keanggotaan lewat engine PUMK`);

  const rencanaPumk = rencanakanPumk(mitra, jumlahBulan, d);
  lekatkanSubmission(rencanaPumk, portal.untukKonversi, jumlahBulan);
  await selaraskanSubmission(dunia, rencanaPumk);

  const rencanaNonPumk = rencanakanNonPumk(dunia, jumlahBulan, d);

  const rkaHasil = await seedRka(dunia, d);
  log(
    `  rka         ${rkaHasil.dibuat} RKA (${rkaHasil.disetujui} disetujui, ${rkaHasil.revisi} revisi` +
      `${rkaHasil.dilewati > 0 ? `, ${rkaHasil.dilewati} dilewati karena sudah ada` : ""}) ` +
      "disusun adminpusat, disahkan adminpusat2",
  );

  // --- the month loop -----------------------------------------------------
  const akadHidup: AkadHidup[] = [];
  const rutin = ringkasanRutinBaru();
  const tutup = hasilTutupBaru();
  const ring: RingkasanBulan = {
    setoran: 0,
    reschedule: 0,
    pelunasan: 0,
    hapusBuku: 0,
    tindakLanjut: 0,
  };
  let proposalDibuat = 0;

  for (let i = 0; i < jumlahBulan; i += 1) {
    const periode = dunia.periode[i]!;
    const label = `${periode.tahun}-${String(periode.bulan).padStart(2, "0")}`;
    const bulanMulai = Date.now();

    const pumkBulanIni = rencanaPumk.filter((r) => r.bulanIdx === i);
    const nonPumkBulanIni = rencanaNonPumk.filter((r) => r.bulanIdx === i);
    const lpjBulanIni = rencanaNonPumk.filter((r) => r.bulanLpj === i);

    // What this month is about to spend, so the allocation lands ahead of it.
    const perluDana =
      pumkBulanIni
        .filter((r) => r.status === "DICAIRKAN")
        .reduce((s, r) => s + keSen(rp(r.pokok)), 0n) +
      nonPumkBulanIni.reduce((s, r) => s + keSen(rp(r.jumlah)), 0n);

    await jurnalRutinBulanan(dunia, periode, i, perluDana, d, rutin);

    for (const r of pumkBulanIni) {
      const hidup = await jalankanProposal(dunia, r, d);
      proposalDibuat += 1;
      if (hidup) akadHidup.push(hidup);
    }

    for (const r of nonPumkBulanIni) await jalankanNonPumkAwal(dunia, r, d);
    for (const r of lpjBulanIni) await jalankanNonPumkLpj(dunia, r, d);

    for (const st of akadHidup) {
      await langkahBulananAkad(dunia, st, periode, d, ring);
    }

    await jalankanPipelineClosing(dunia, periode, tutup);
    const terakhir = i === jumlahBulan - 1;
    if (!terakhir) await tutupPeriodeDemo(dunia, periode, tutup);

    log(
      `  ${label}   ${terakhir ? "OPEN  " : "CLOSED"} ` +
        `proposal ${pumkBulanIni.length.toString().padStart(2)}, ` +
        `non pumk ${nonPumkBulanIni.length.toString().padStart(2)}, ` +
        `akad hidup ${akadHidup.filter((a) => !a.selesai).length.toString().padStart(3)}, ` +
        `setoran kumulatif ${ring.setoran.toString().padStart(4)}, ` +
        `${((Date.now() - bulanMulai) / 1000).toFixed(1)}s`,
    );
  }

  log("");
  log(
    `  pumk        ${proposalDibuat} proposal, ${akadHidup.length} akad dicairkan, ` +
      `${ring.setoran} setoran, ${ring.reschedule} reschedule, ${ring.pelunasan} lunas dipercepat, ` +
      `${ring.hapusBuku} hapus buku, ${ring.tindakLanjut} tindak lanjut penagihan`,
  );
  log(
    `  non pumk    ${rencanaNonPumk.length} proposal, ` +
      `${rencanaNonPumk.filter((r) => r.status === "SELESAI").length} LPJ diverifikasi, ` +
      `${rencanaNonPumk.filter((r) => r.status === "MENUNGGU_LPJ").length} LPJ menunggak`,
  );
  log(
    `  rutin       ${rutin.alokasi} alokasi dana (${rupiahTampil(
      `${rutin.totalAlokasi / 100n}.${(rutin.totalAlokasi % 100n).toString().padStart(2, "0")}`,
    )}), ${rutin.giro} jasa giro, ${rutin.operasional} beban operasional, ` +
      `${rutin.pinbuk} pembinaan, ${rutin.manual} jurnal manual tiga tangan, ` +
      `${rutin.suspense} setoran belum teridentifikasi`,
  );
  log(
    `  closing     ${tutup.periodeDitutup} periode CLOSED + 1 OPEN, ` +
      `${tutup.akadDinilai} penilaian kolektibilitas, ${tutup.jurnalPenyisihan} jurnal penyisihan, ` +
      `${tutup.jurnalAkrual} jurnal akrual`,
  );
  for (const p of tutup.peringatan.slice(0, 5)) log(`  peringatan  ${p}`);

  // --- spec 13's acceptance rule -----------------------------------------
  log("");
  log("  PEMERIKSAAN INTEGRITAS (Bagian 9.6) DAN PRASYARAT CLOSING");
  const pemeriksaan: Pemeriksaan[] = [
    ...(await periksaTemplateLaporan(dunia)),
    ...(await periksaIntegritas(dunia)),
    ...(await periksaAkuntansi(dunia, rkaHasil.baseline)),
    ...(await periksaPrasyaratSemuaPeriode(dunia)),
  ];
  const lulus = cetakPemeriksaan(pemeriksaan, log);
  const detik = (Date.now() - mulaiJalan) / 1000;

  if (!lulus) {
    throw new Error(
      `SEED GAGAL: ${pemeriksaan.filter((p) => !p.lulus).length} pemeriksaan tidak lulus. ` +
        "Spesifikasi Bagian 13: seed yang menghasilkan neraca tidak balance lebih buruk " +
        "daripada tidak ada seed sama sekali, jadi run ini dinyatakan gagal, bukan sukses bersyarat.",
    );
  }

  log("");
  log(`  SEMUA ${pemeriksaan.length} PEMERIKSAAN LULUS dalam ${detik.toFixed(1)} detik.`);

  return {
    dilewati: false,
    detikBerjalan: detik,
    mitra: mitra.length,
    proposal: proposalDibuat,
    akad: akadHidup.length,
    nonPumk: rencanaNonPumk.length,
    submission: portal.semua.length,
    periodeDitutup: tutup.periodeDitutup,
    setoran: ring.setoran,
    lulus,
  };
}

async function hitungAkad(dunia: Dunia): Promise<number> {
  const rows = await dunia.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pumk_akad a
       JOIN cabang c ON c.id = a.cabang_id
      WHERE c.bumn_id = $1::uuid AND a.deleted_at IS NULL`,
    [dunia.bumnId],
  );
  return Number(rows[0]?.n ?? "0");
}

/**
 * Hands the five conversion-bound submissions to five recent plan entries.
 * Recent on purpose: a portal queue that converted a submission twenty months
 * ago and none since would look abandoned.
 */
function lekatkanSubmission(
  rencana: ReturnType<typeof rencanakanPumk>,
  submission: ReadonlyArray<{ id: string }>,
  jumlahBulan: number,
): void {
  const batas = Math.max(0, jumlahBulan - 7);
  const kandidat = rencana.filter(
    (r) => r.bulanIdx >= batas && r.submissionId === null && r.status !== "DRAFT",
  );
  submission.forEach((s, i) => {
    const target = kandidat[i * 3];
    if (target) target.submissionId = s.id;
  });
}

/**
 * A converted proposal copies the submission's form data, so the ticket has to
 * carry the same figures the plan is about to approve. Otherwise the approval
 * step raises a plafon nobody ever asked for, which is exactly the sort of
 * detail that makes a demo audience stop trusting the screen.
 */
async function selaraskanSubmission(
  dunia: Dunia,
  rencana: ReturnType<typeof rencanakanPumk>,
): Promise<void> {
  for (const r of rencana) {
    if (!r.submissionId) continue;
    const p = dunia.periode[r.bulanIdx]!;
    await dunia.db.query(
      `UPDATE portal_submission
          SET data_json = data_json
                          || jsonb_build_object('jumlah_diajukan', $2::text,
                                                'tenor_diajukan', $3::int,
                                                'nama_lengkap', $4::text,
                                                'nama_usaha', $5::text),
              tanggal_submit = $6::timestamptz
        WHERE id = $1::uuid`,
      [
        r.submissionId,
        rp(r.pokok),
        r.tenor,
        r.mitra.nama,
        r.mitra.namaUsaha,
        `${tanggal(p.tahun, p.bulan, 1)}T02:00:00Z`,
      ],
    );
  }
}

export { JUMLAH_MITRA, JUMLAH_PROPOSAL, JUMLAH_AKAD, JUMLAH_NON_PUMK, JUMLAH_SUBMISSION };
