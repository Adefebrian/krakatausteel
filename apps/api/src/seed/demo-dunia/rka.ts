// RKA: two years, all three jenis, each with a DISETUJUI baseline, plus one
// revision so the version history on screen is not a single row.
//
// TWO ACCOUNTS ARE INVOLVED AND THAT IS THE POINT.
// `rka.pemisahan_tugas_persetujuan` ships on, so `setujuiRka` refuses an
// approver who drafted or last edited the version (KONFLIK_MAKER_APPROVER), and
// only ADMIN_PUSAT holds `admin.rka.approve`. `adminpusat` drafts, `adminpusat2`
// approves. Without a DISETUJUI baseline, report 24 refuses outright with
// BASELINE_TIDAK_ADA, so this is not decoration: it is the difference between a
// demonstrable budget report and an error message.
import type { BarisRkaInput, JenisRka } from "../../modules/rka";
import type { Dunia } from "./dunia";
import { rp, type Dadu } from "./acak";

/** Ledger accounts a KEUANGAN budget is set against. */
const AKUN_KEUANGAN: ReadonlyArray<{ kode: string; uraian: string; perBulan: number }> = [
  { kode: "4.1.02", uraian: "Pendapatan jasa administrasi pinjaman", perBulan: 22_000_000 },
  { kode: "4.1.03", uraian: "Pendapatan bunga jasa giro", perBulan: 12_000_000 },
  { kode: "5.1.02", uraian: "Beban pembinaan kemitraan", perBulan: 18_000_000 },
  { kode: "5.1.03", uraian: "Beban penyaluran Non PUMK", perBulan: 165_000_000 },
  { kode: "5.1.04", uraian: "Beban operasional unit TJSL", perBulan: 66_000_000 },
];

export interface HasilRka {
  dibuat: number;
  disetujui: number;
  revisi: number;
  /** Budgets an operator had already entered, left untouched. */
  dilewati: number;
  /**
   * The (tahun, jenis) pairs this seed actually approved a baseline for.
   *
   * Report 24 measures against a DISETUJUI baseline and refuses with
   * BASELINE_TIDAK_ADA without one, so the acceptance check has to know which
   * budgets are the seed's to assert on. On a database where somebody else's
   * DRAFT already occupies version 1 of a year, the seed skips it and does not
   * then claim a report it never made possible.
   */
  baseline: Array<{ tahun: number; jenis: JenisRka }>;
}

/**
 * Any version at all for this (tahun, jenis, entity-level cabang). Read only,
 * and deliberately not filtered by status: a DRAFT somebody is still editing
 * owns the version number just as firmly as an approved one does.
 */
async function rkaSudahAda(dunia: Dunia, tahun: number, jenis: JenisRka): Promise<boolean> {
  const rows = await dunia.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM rka
      WHERE bumn_id = $1::uuid AND tahun = $2::int AND jenis = $3
        AND cabang_id IS NULL AND deleted_at IS NULL`,
    [dunia.bumnId, tahun, jenis],
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

export async function seedRka(dunia: Dunia, d: Dadu): Promise<HasilRka> {
  const penyusun = dunia.ctx(dunia.adminPusat);
  const penyetuju = dunia.ctx(dunia.adminPusatLain);
  const hasil: HasilRka = { dibuat: 0, disetujui: 0, revisi: 0, dilewati: 0, baseline: [] };

  const tahunIni = dunia.bulanBerjalan.tahun;
  const tahunLalu = tahunIni - 1;
  // Only the years the period ladder actually covers can carry a meaningful
  // budget: report 24 reads a period per month and refuses a month with none.
  const tahunTerpakai = [tahunLalu, tahunIni].filter((t) =>
    dunia.periode.some((p) => p.tahun === t),
  );

  for (const tahun of tahunTerpakai) {
    for (const jenis of ["PUMK", "NON_PUMK", "KEUANGAN"] as JenisRka[]) {
      // ALREADY THERE IS A SKIP, NOT AN ERROR. `rka_versi_uq` is unique on
      // (bumn, tahun, jenis, cabang, versi), and a dev database that somebody
      // has already entered a budget into is the normal case rather than the
      // exception. Blowing up with VERSI_GANDA halfway through would leave the
      // world half built, which is the one outcome this generator refuses to
      // produce.
      if (await rkaSudahAda(dunia, tahun, jenis)) {
        hasil.dilewati += 1;
        continue;
      }
      const baris = barisUntuk(dunia, jenis, tahun, d);
      dunia.jam.ke(`${tahun - (tahun === tahunLalu ? 0 : 1)}-12-05`);
      const rka = await dunia.rka.buatRka(
        {
          cabangId: null,
          tahun,
          jenis,
          keterangan: `RKA ${jenis === "NON_PUMK" ? "Non PUMK" : jenis} tahun ${tahun}, tingkat entitas`,
          baris,
        },
        penyusun,
      );
      hasil.dibuat += 1;

      dunia.jam.ke(`${tahun - (tahun === tahunLalu ? 0 : 1)}-12-18`);
      await dunia.rka.setujuiRka(
        {
          rkaId: rka.id,
          catatan: `Disahkan sebagai baseline anggaran ${tahun}`,
        },
        penyetuju,
      );
      hasil.disetujui += 1;
      hasil.baseline.push({ tahun, jenis });

      // One revision, on this year's PUMK budget, approved so the baseline
      // moves to v2 and v1 stays readable as history.
      if (tahun === tahunIni && jenis === "PUMK") {
        dunia.jam.ke(`${tahunIni}-06-10`);
        const revisi = await dunia.rka.buatRevisi(
          {
            rkaId: rka.id,
            keterangan: "Revisi tengah tahun: realokasi pagu antar sektor",
            salinBaris: true,
          },
          penyusun,
        );
        const digeser = revisi.baris.map((b) => ({
          akunId: b.akunId,
          sektorId: b.sektorId,
          bidangId: b.bidangId,
          uraian: b.uraian,
          bulan: b.bulan,
          jumlahAnggaran: b.jumlahAnggaran,
          jumlahUnit: b.jumlahUnit,
          keterangan: b.keterangan,
        }));
        // Move ten percent of the first sector's pagu to the second.
        if (digeser.length >= 2) {
          const nol = digeser[0]!;
          const satu = digeser[1]!;
          const geser = Math.round(Number(nol.jumlahAnggaran.split(".")[0]) * 0.1);
          nol.jumlahAnggaran = rp(Number(nol.jumlahAnggaran.split(".")[0]) - geser);
          satu.jumlahAnggaran = rp(Number(satu.jumlahAnggaran.split(".")[0]) + geser);
        }
        await dunia.rka.simpanBaris({ rkaId: revisi.id, baris: digeser }, penyusun);
        dunia.jam.ke(`${tahunIni}-06-20`);
        await dunia.rka.setujuiRka(
          { rkaId: revisi.id, catatan: "Revisi 1 disahkan" },
          penyetuju,
        );
        hasil.revisi += 1;
        hasil.disetujui += 1;
      }
    }
  }

  return hasil;
}

function barisUntuk(dunia: Dunia, jenis: JenisRka, tahun: number, d: Dadu): BarisRkaInput[] {
  const baris: BarisRkaInput[] = [];
  const musim = (bulan: number): number => (bulan === 12 || bulan === 6 ? 1.25 : bulan === 1 ? 0.6 : 1);

  if (jenis === "PUMK") {
    for (const s of dunia.sektor) {
      const dasar = d.int(60, 260) * 1_000_000;
      for (let bulan = 1; bulan <= 12; bulan += 1) {
        baris.push({
          sektorId: s.id,
          uraian: `Penyaluran pinjaman sektor ${s.nama}`,
          bulan,
          jumlahAnggaran: rp(Math.round((dasar * musim(bulan)) / 500_000) * 500_000),
          jumlahUnit: d.int(1, 6),
          keterangan: bulan === 1 ? `Pagu ${tahun}` : null,
        });
      }
    }
    return baris;
  }

  if (jenis === "NON_PUMK") {
    for (const b of dunia.bidang) {
      const dasar = d.int(30, 180) * 1_000_000;
      for (let bulan = 1; bulan <= 12; bulan += 1) {
        baris.push({
          bidangId: b.id,
          uraian: `Program bidang ${b.nama}`,
          bulan,
          jumlahAnggaran: rp(Math.round((dasar * musim(bulan)) / 500_000) * 500_000),
          jumlahUnit: d.int(1, 4),
          keterangan: bulan === 1 ? `Pagu ${tahun}` : null,
        });
      }
    }
    return baris;
  }

  for (const a of AKUN_KEUANGAN) {
    const akunId = dunia.akun[a.kode];
    if (!akunId) continue;
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      baris.push({
        akunId,
        uraian: a.uraian,
        bulan,
        jumlahAnggaran: rp(Math.round((a.perBulan * musim(bulan)) / 100_000) * 100_000),
        keterangan: bulan === 1 ? `Pagu ${tahun}` : null,
      });
    }
  }
  return baris;
}
