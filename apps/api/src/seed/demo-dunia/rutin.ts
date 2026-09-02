// The routine monthly ledger: funding from the parent BUMN, giro income,
// operating expense, quarterly pembinaan, and one manual three-step journal a
// quarter so the DRAFT -> VERIFIED -> POSTED path of spec 6 has real rows.
//
// FUNDING IS DEMAND DRIVEN, NOT A MAGIC NUMBER. Before each month the
// generator reads the branch's posted cash balance and tops it up only when it
// would otherwise go short. Two reasons: a fixed opening injection either
// leaves an implausible pile of idle cash for two years or runs out halfway and
// trips closing prerequisite 8 (saldo kas negatif); and an allocation that
// arrives when the programme needs it is what the real fund does.
import type { Dunia } from "./dunia";
import { keSen, rp, sen, tanggal, type Dadu } from "./acak";

/** Below this posted cash balance a branch gets another allocation. */
const AMBANG_KAS = 800_000_000;
/** Target balance after a top up, rounded to a round allocation figure. */
const TARGET_KAS = 3_500_000_000;

export interface RingkasanRutin {
  alokasi: number;
  giro: number;
  operasional: number;
  pinbuk: number;
  manual: number;
  suspense: number;
  totalAlokasi: bigint;
}

export function ringkasanRutinBaru(): RingkasanRutin {
  return { alokasi: 0, giro: 0, operasional: 0, pinbuk: 0, manual: 0, suspense: 0, totalAlokasi: 0n };
}

async function saldoKas(dunia: Dunia, cabangId: string): Promise<bigint> {
  const rows = await dunia.db.query<{ saldo: string }>(
    `SELECT coalesce(sum(b.debit - b.kredit), 0)::text AS saldo
       FROM jurnal_baris b
       JOIN jurnal j ON j.id = b.jurnal_id
      WHERE j.status = 'POSTED' AND j.deleted_at IS NULL AND b.deleted_at IS NULL
        AND j.cabang_id = $1::uuid AND b.akun_id = ANY($2::uuid[])`,
    [cabangId, [dunia.akun["1.1.01"], dunia.akun["1.1.02"]]],
  );
  return keSen(rows[0]?.saldo ?? "0.00");
}

/**
 * One month of routine entries for every operational branch.
 *
 * `perluDana` is the amount the month is about to spend, so the top up happens
 * BEFORE the disbursements rather than after the balance has already gone
 * negative.
 */
export async function jurnalRutinBulanan(
  dunia: Dunia,
  periode: { id: string; tahun: number; bulan: number; mulai: string; akhir: string },
  bulanKe: number,
  perluDana: bigint,
  d: Dadu,
  ring: RingkasanRutin,
): Promise<void> {
  const admin = dunia.ctx(dunia.adminPusat);
  const kas = dunia.akun["1.1.01"]!;
  const bank = dunia.akun["1.1.02"]!;

  // Quarterly, and BEFORE the month's petty spending, so the cash box is never
  // asked to pay out of a balance it does not have yet.
  if (bulanKe % 3 === 0) await jurnalManualTriwulan(dunia, periode, d, ring);

  for (const cab of dunia.cabang) {
    // --- allocation from the parent BUMN, when the branch needs it ---------
    const saldo = await saldoKas(dunia, cab.id);
    const dibutuhkan = BigInt(AMBANG_KAS) * 100n + perluDana;
    if (saldo < dibutuhkan) {
      const kurang = BigInt(TARGET_KAS) * 100n + perluDana - saldo;
      // Rounded to the nearest 250 million: an allocation letter names a round
      // figure, never a computed remainder.
      const bulat = ((kurang + 24_999_999_999n) / 25_000_000_000n) * 25_000_000_000n;
      const tgl = tanggal(periode.tahun, periode.bulan, 3);
      dunia.jam.ke(tgl);
      await dunia.jurnal.postingEvent(
        "ALOKASI_DANA_BUMN_PEMBINA",
        {
          cabangId: cab.id,
          tanggalTransaksi: tgl,
          nilai: sen(bulat),
          akunKasId: bank,
          keterangan: `Alokasi dana TJSL dari BUMN Pembina untuk ${cab.nama}`,
          referensiTipe: "ALOKASI_DANA",
          referensiId: periode.id,
        },
        admin,
      );
      ring.alokasi += 1;
      ring.totalAlokasi += bulat;
    }

    // --- giro interest, credited at month end ------------------------------
    const tglGiro = periode.akhir;
    dunia.jam.ke(tglGiro);
    await dunia.jurnal.postingEvent(
      "PENDAPATAN_JASA_GIRO",
      {
        cabangId: cab.id,
        tanggalTransaksi: tglGiro,
        nilai: rp(d.int(180, 950) * 10_000),
        akunKasId: bank,
        keterangan: `Jasa giro rekening TJSL ${cab.nama}`,
      },
      admin,
    );
    ring.giro += 1;

    // --- operating expense, paid by transfer --------------------------------
    // From the BANK account, not from petty cash. A unit that pays two years of
    // salaries and rent out of a cash box would carry a negative Kas balance all
    // the way through, and closing prerequisite 8 would raise a warning on every
    // single month of the demo.
    const tglBeban = tanggal(periode.tahun, periode.bulan, 25);
    dunia.jam.ke(tglBeban);
    await dunia.jurnal.postingEvent(
      "BEBAN_OPERASIONAL",
      {
        cabangId: cab.id,
        tanggalTransaksi: tglBeban,
        nilai: rp(d.int(14, 32) * 1_000_000),
        akunDebitId: dunia.akun["5.1.04"]!,
        akunKasId: bank,
        keterangan: `Beban operasional unit TJSL ${cab.nama} bulan ${periode.bulan}/${periode.tahun}`,
      },
      admin,
    );
    ring.operasional += 1;

    // --- petty cash, so account 1.1.01 is not a dead line -------------------
    // Replenished from the bank once a quarter through the three hand manual
    // journal below, and spent down in small amounts monthly. That is what
    // makes Kas dan Setara Kas and Bank Operasional two different stories in
    // the cash flow statement rather than one account and one unused one.
    const tglKecil = tanggal(periode.tahun, periode.bulan, 12);
    dunia.jam.ke(tglKecil);
    await dunia.jurnal.postingEvent(
      "BEBAN_OPERASIONAL",
      {
        cabangId: cab.id,
        tanggalTransaksi: tglKecil,
        nilai: rp(d.int(120, 380) * 10_000),
        akunDebitId: dunia.akun["5.1.04"]!,
        akunKasId: kas,
        keterangan: `Pengeluaran kas kecil ${cab.nama} bulan ${periode.bulan}/${periode.tahun}`,
      },
      admin,
    );

    // --- an unidentified deposit, in the recent months ----------------------
    // A transfer lands in the TJSL account with no mitra reference. Spec 6.4
    // gives it its own event and its own suspense liability
    // (2.1.02 Angsuran Belum Teridentifikasi) precisely because it happens, and
    // the reconciliation tools of spec 9.6 exist to clear it. A demo with an
    // empty suspense account cannot show either.
    if (bulanKe >= 21) {
      const tglSuspense = tanggal(periode.tahun, periode.bulan, 22);
      dunia.jam.ke(tglSuspense);
      await dunia.jurnal.postingEvent(
        "TERIMA_ANGSURAN_BELUM_TERIDENTIFIKASI",
        {
          cabangId: cab.id,
          tanggalTransaksi: tglSuspense,
          nilai: rp(d.int(45, 320) * 10_000),
          akunKasId: bank,
          keterangan: `Transfer masuk tanpa identitas mitra, ${cab.nama}, menunggu identifikasi`,
        },
        admin,
      );
      ring.suspense += 1;
    }

    // --- pembinaan, quarterly ----------------------------------------------
    if (periode.bulan % 3 === 0) {
      const tglBina = tanggal(periode.tahun, periode.bulan, 18);
      dunia.jam.ke(tglBina);
      await dunia.jurnal.postingEvent(
        "PENYALURAN_PINBUK",
        {
          cabangId: cab.id,
          tanggalTransaksi: tglBina,
          nilai: rp(d.int(20, 85) * 1_000_000),
          akunKasId: bank,
          keterangan: `Pelatihan dan pendampingan mitra binaan ${cab.nama} triwulan ${Math.ceil(
            periode.bulan / 3,
          )}`,
        },
        admin,
      );
      ring.pinbuk += 1;
    }
  }

}

/**
 * A manual journal that walks the whole spec 6 path: the Maker drafts it, the
 * Checker verifies it, the Approver posts it. Nothing else in this generator
 * exercises that trio, because every other entry is an automatic event, and a
 * demo of a maker/checker/approver system with no manual journal in the ledger
 * cannot show the one screen an accountant will ask about first.
 */
export async function jurnalManualTriwulan(
  dunia: Dunia,
  periode: { tahun: number; bulan: number },
  d: Dadu,
  ring: RingkasanRutin,
): Promise<void> {
  for (const cab of dunia.cabang) {
    const trio = dunia.petugas[cab.kode];
    if (!trio) continue;
    const nilai = rp(15_000_000 + d.int(0, 5) * 1_000_000);
    const tgl = tanggal(periode.tahun, periode.bulan, 5);

    dunia.jam.ke(tgl);
    const draft = await dunia.jurnal.buatJurnal(
      {
        cabangId: cab.id,
        jenis: "KAS_BANK",
        tanggalTransaksi: tgl,
        keterangan: `Pengisian kas kecil ${cab.nama} triwulan ${Math.ceil(periode.bulan / 3)}`,
        baris: [
          { akunId: dunia.akun["1.1.01"]!, debit: nilai, keterangan: "Kas kecil unit TJSL" },
          { akunId: dunia.akun["1.1.02"]!, kredit: nilai, keterangan: "Rekening operasional TJSL" },
        ],
      },
      dunia.ctx(trio.maker),
    );
    await dunia.jurnal.verifikasiJurnal(draft.id, dunia.ctx(trio.checker));
    await dunia.jurnal.postingJurnal(draft.id, dunia.ctx(trio.approver));
    ring.manual += 1;
  }
}
