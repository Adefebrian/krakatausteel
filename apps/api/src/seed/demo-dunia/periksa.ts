// Spec 13's own acceptance rule, implemented.
//
//   "Sesudah seeding, jalankan semua pemeriksaan integritas Bagian 9.6 dan
//    semua prasyarat closing. Kalau ada yang gagal, seed GAGAL."
//
// A seed that reports success on data the system's own checks reject is worse
// than no seed at all: it teaches everyone downstream to distrust the checks
// rather than the data. So every one of these returns a row count or a
// difference, and a single non-zero result fails the run with a non-zero exit
// code.
//
// The four `v_integritas_*` / `v_rekonsiliasi_*` views are the artefacts spec
// 9.6 names (migration 0015). The accounting identities below them are spec 10:
// report 19's Total Aset = Liabilitas + Aset Neto, report 23's balanced trial
// balance, and report 18's closing cash tying to report 19's cash line.
import type { DbPort } from "../../core/ports/db";
import type { JenisRka } from "../../modules/rka";
import type { Dunia } from "./dunia";
import { keSen, rupiahTampil } from "./acak";

export interface Pemeriksaan {
  nama: string;
  lulus: boolean;
  detail: string;
}

async function hitung(db: DbPort, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await db.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? "0");
}

/** Spec 9.6 integrity tools, every one of them, against the seeded world. */
export async function periksaIntegritas(dunia: Dunia): Promise<Pemeriksaan[]> {
  const db = dunia.db;
  const out: Pemeriksaan[] = [];

  const jurnalRusak = await hitung(db, `SELECT count(*)::text AS n FROM v_integritas_jurnal`);
  out.push({
    nama: "v_integritas_jurnal (jurnal tidak balance / kurang baris)",
    lulus: jurnalRusak === 0,
    detail: `${jurnalRusak} baris`,
  });

  const jadwalRusak = await hitung(db, `SELECT count(*)::text AS n FROM v_integritas_jadwal`);
  out.push({
    nama: "v_integritas_jadwal (total pokok jadwal <> pokok akad)",
    lulus: jadwalRusak === 0,
    detail: `${jadwalRusak} akad`,
  });

  const snapshotDobel = await hitung(db, `SELECT count(*)::text AS n FROM v_integritas_snapshot`);
  out.push({
    nama: "v_integritas_snapshot (snapshot kolektibilitas ganda)",
    lulus: snapshotDobel === 0,
    detail: `${snapshotDobel} pasangan periode/akad`,
  });

  const rekonRusak = await hitung(
    db,
    `SELECT count(*)::text AS n FROM v_rekonsiliasi_piutang WHERE selisih <> 0`,
  );
  out.push({
    nama: "v_rekonsiliasi_piutang (sub ledger piutang vs buku besar, spec 8.4 butir 10)",
    lulus: rekonRusak === 0,
    detail: `${rekonRusak} akad selisih`,
  });

  // Kolektibilitas ladder: no gaps, no overlaps. Migration 0004 leaves this to
  // the spec 9.6 tool on purpose (an exclusion constraint would block a valid
  // mid-edit state in the config screen), so it is checked here.
  const tanggaRusak = await hitung(
    db,
    `WITH r AS (
       SELECT hari_min, hari_max,
              lead(hari_min) OVER (ORDER BY hari_min) AS berikut
         FROM kolektibilitas_range
        WHERE deleted_at IS NULL AND (bumn_id IS NULL OR bumn_id = $1::uuid)
     )
     SELECT count(*)::text AS n FROM r
      WHERE (hari_max IS NULL AND berikut IS NOT NULL)
         OR (hari_max IS NOT NULL AND berikut IS NOT NULL AND berikut <> hari_max + 1)`,
    [dunia.bumnId],
  );
  out.push({
    nama: "tangga kolektibilitas (tanpa celah, tanpa tumpang tindih)",
    lulus: tanggaRusak === 0,
    detail: `${tanggaRusak} sambungan salah`,
  });

  const jurnalDraft = await hitung(
    db,
    `SELECT count(*)::text AS n FROM jurnal j
       JOIN periode p ON p.id = j.periode_id
      WHERE j.status = 'DRAFT' AND j.deleted_at IS NULL AND p.status = 'CLOSED'`,
  );
  out.push({
    nama: "tidak ada jurnal DRAFT di periode CLOSED",
    lulus: jurnalDraft === 0,
    detail: `${jurnalDraft} jurnal`,
  });

  const outstandingNegatif = await hitung(
    db,
    `SELECT count(*)::text AS n FROM pumk_akad
      WHERE deleted_at IS NULL AND (outstanding_pokok < 0 OR outstanding_jasa < 0)`,
  );
  out.push({
    nama: "tidak ada akad dengan outstanding negatif (invarian 10)",
    lulus: outstandingNegatif === 0,
    detail: `${outstandingNegatif} akad`,
  });

  // THE CHECK THAT WAS MISSING WHEN THE DEFECT SHIPPED (ADR 0018,
  // migrations/0030). Piutang Jasa Administrasi was minus Rp 86,7 juta for
  // twenty four months and every check above stayed green, because the income
  // was missing by the same amount and the balance sheet still balanced. An
  // asset with a credit balance is not an accounting opinion, so it gets a
  // check of its own, at every month end rather than only at the last one: the
  // defect drifted negative gradually and a final-month-only test would have
  // reported a smaller number without ever saying which month broke it.
  const bulanPiutangNegatif = await db.query<{ bulan: string; saldo: string }>(
    `SELECT p.tahun || '-' || lpad(p.bulan::text, 2, '0') AS bulan,
            s.saldo::numeric(20,2)::text AS saldo
       FROM periode p
       JOIN LATERAL (
         SELECT coalesce(sum(l.nilai_debit_positif), 0) AS saldo
           FROM v_ledger_baris l
           JOIN akun a ON a.id = l.akun_id
          WHERE a.kode = '1.1.04' AND l.tanggal_transaksi <= p.tanggal_akhir
       ) s ON true
      WHERE p.bumn_id = $1::uuid AND p.deleted_at IS NULL AND s.saldo < 0
      ORDER BY p.tahun, p.bulan`,
    [dunia.bumnId],
  );
  out.push({
    nama: "Piutang Jasa Administrasi (1.1.04) tidak pernah bersaldo kredit di akhir bulan mana pun",
    lulus: bulanPiutangNegatif.length === 0,
    detail:
      bulanPiutangNegatif.length === 0
        ? "0 bulan negatif"
        : bulanPiutangNegatif
            .map((b) => `${b.bulan} ${rupiahTampil(b.saldo)}`)
            .join(", "),
  });

  return out;
}

/** Every closing prerequisite, for every period, including the OPEN one. */
export async function periksaPrasyaratSemuaPeriode(dunia: Dunia): Promise<Pemeriksaan[]> {
  const ctx = dunia.ctx(dunia.adminPusat);
  const out: Pemeriksaan[] = [];
  for (const p of dunia.periode) {
    const label = `${p.tahun}-${String(p.bulan).padStart(2, "0")}`;
    const pra = await dunia.closing.periksaPrasyarat(p.id, ctx);
    const gagal = pra.hasil.filter((h) => h.status === "GAGAL");
    out.push({
      nama: `prasyarat closing ${label} (${p.status})`,
      lulus: gagal.length === 0,
      detail:
        gagal.length === 0
          ? `${pra.hasil.length} pemeriksaan PASS`
          : gagal.map((g) => `[${g.nomor}] ${g.kode}`).join(", "),
    });
  }
  return out;
}

/** Report 19, 23 and 18's identities on the seeded ledger. */
export async function periksaAkuntansi(
  dunia: Dunia,
  baselineRka: ReadonlyArray<{ tahun: number; jenis: JenisRka }>,
): Promise<Pemeriksaan[]> {
  const ctx = dunia.ctx(dunia.adminPusat);
  const out: Pemeriksaan[] = [];

  // Whole-ledger trial balance, independent of any report.
  const rows = await dunia.db.query<{ debit: string; kredit: string }>(
    `SELECT coalesce(sum(b.debit), 0)::text AS debit, coalesce(sum(b.kredit), 0)::text AS kredit
       FROM jurnal_baris b
       JOIN jurnal j ON j.id = b.jurnal_id
      WHERE j.status = 'POSTED' AND j.deleted_at IS NULL AND b.deleted_at IS NULL`,
  );
  const debit = rows[0]?.debit ?? "0.00";
  const kredit = rows[0]?.kredit ?? "0.00";
  const selisih = keSen(debit) - keSen(kredit);
  out.push({
    nama: "buku besar seimbang (total debit = total kredit, seluruh jurnal POSTED)",
    lulus: selisih === 0n,
    detail: `debit ${rupiahTampil(debit)}, kredit ${rupiahTampil(kredit)}, selisih ${selisih}`,
  });

  const terakhir = dunia.periode[dunia.periode.length - 1];
  const sebelumTerakhir = dunia.periode[dunia.periode.length - 2];
  for (const p of [sebelumTerakhir, terakhir]) {
    if (!p) continue;
    const label = `${p.tahun}-${String(p.bulan).padStart(2, "0")} (${p.status})`;

    const posisi = await dunia.laporan.laporanPosisiKeuangan({ periodeId: p.id, cabangId: null }, ctx);
    const beda =
      keSen(posisi.totalAsetTahunIni.nilai) - keSen(posisi.totalLiabilitasDanAsetNetoTahunIni.nilai);
    out.push({
      nama: `Laporan 19 ${label}: Total Aset = Liabilitas + Aset Neto`,
      lulus: beda === 0n,
      detail: `aset ${posisi.totalAsetTahunIni.tampil} vs liabilitas+aset neto ${posisi.totalLiabilitasDanAsetNetoTahunIni.tampil}`,
    });

    const lajur = await dunia.laporan.neracaLajur({ periodeId: p.id, cabangId: null }, ctx);
    const bedaLajur = keSen(lajur.total.saldoAkhirDebit.nilai) - keSen(lajur.total.saldoAkhirKredit.nilai);
    const bedaMutasi = keSen(lajur.total.mutasiDebit.nilai) - keSen(lajur.total.mutasiKredit.nilai);
    out.push({
      nama: `Laporan 23 ${label}: neraca lajur balance (saldo akhir dan mutasi)`,
      lulus: bedaLajur === 0n && bedaMutasi === 0n,
      detail: `saldo akhir selisih ${bedaLajur}, mutasi selisih ${bedaMutasi}`,
    });

    const arus = await dunia.laporan.laporanArusKas({ periodeId: p.id, cabangId: null }, ctx);
    const bedaKas = keSen(arus.kasAkhirTahunIni.nilai) - keSen(posisi.kasDanSetaraKasTahunIni.nilai);
    out.push({
      nama: `Laporan 18 ${label}: Kas Akhir = Kas dan Setara Kas di Laporan 19`,
      lulus: bedaKas === 0n,
      detail: `arus kas ${arus.kasAkhirTahunIni.tampil} vs posisi ${posisi.kasDanSetaraKasTahunIni.tampil}`,
    });

    const aktivitas = await dunia.laporan.laporanAktivitas({ periodeId: p.id, cabangId: null }, ctx);
    const perubahan = await dunia.laporan.laporanPerubahanAsetNeto(
      { periodeId: p.id, cabangId: null },
      ctx,
    );
    const bedaAktivitas =
      keSen(aktivitas.kenaikanAsetNetoTahunIni.nilai) - keSen(perubahan.totalPerubahanTahunIni.nilai);
    out.push({
      nama: `Laporan 17 dan 20 ${label}: kenaikan aset neto konsisten`,
      lulus: bedaAktivitas === 0n,
      detail: `aktivitas ${aktivitas.kenaikanAsetNetoTahunIni.tampil} vs perubahan ${perubahan.totalPerubahanTahunIni.tampil}`,
    });
  }

  // Report 24 is the reason the period ladder exists: prove the cumulative
  // year-to-date mode answers instead of refusing with PERIODE_TIDAK_DITEMUKAN
  // for a month of the fiscal year that has no period row.
  //
  // WHICH COMBINATIONS ARE ASSERTED, AND WHY NOT ALL OF THEM.
  // `laporanRkaVsRealisasi` refuses jenis PUMK and NON_PUMK outright
  // (SKEMA_BELUM_LENGKAP) as soon as the window contains a CLOSED month:
  // migration 0027 added `saldo_akun_dimensi_periode` to hold the frozen
  // per-sektor and per-bidang figures, but nothing writes it yet, and
  // modules/rka's own header records the refusal as deliberate rather than
  // recomputing a closed month from live master data. So the cumulative mode is
  // asserted on KEUANGAN, where the frozen source does exist, and the monthly
  // mode on PUMK against the OPEN period, where the live ledger answers. That
  // covers both sources and both modes without asserting a capability the
  // system does not claim to have. See SEED.md.
  const akhir = dunia.periode[dunia.periode.length - 1];
  const tertutup = [...dunia.periode].reverse().find((p) => p.status === "CLOSED");
  out.push({
    nama: "seed punya baseline RKA sendiri untuk diuji Laporan 24",
    lulus: baselineRka.length > 0,
    detail: baselineRka.map((b) => `${b.jenis} ${b.tahun}`).join(", ") || "tidak ada",
  });
  if (akhir) {
    const rkaCtx = dunia.ctx(dunia.adminPusat);
    const punya = (jenis: JenisRka, tahun: number): boolean =>
      baselineRka.some((b) => b.jenis === jenis && b.tahun === tahun);
    const kombinasi: Array<{
      jenis: JenisRka;
      mode: "BULANAN" | "KUMULATIF_YTD";
      tahun: number;
      bulan: number;
    }> = [];
    // The live-ledger source, on a dimension the module can answer for an OPEN
    // month.
    if (punya("PUMK", akhir.tahun)) {
      kombinasi.push({ jenis: "PUMK", mode: "BULANAN", tahun: akhir.tahun, bulan: akhir.bulan });
    }
    if (punya("KEUANGAN", akhir.tahun)) {
      kombinasi.push({ jenis: "KEUANGAN", mode: "BULANAN", tahun: akhir.tahun, bulan: akhir.bulan });
      kombinasi.push({
        jenis: "KEUANGAN",
        mode: "KUMULATIF_YTD",
        tahun: akhir.tahun,
        bulan: akhir.bulan,
      });
      // The frozen source: a month that has already been closed.
      if (tertutup && punya("KEUANGAN", tertutup.tahun)) {
        kombinasi.push({
          jenis: "KEUANGAN",
          mode: "BULANAN",
          tahun: tertutup.tahun,
          bulan: tertutup.bulan,
        });
      }
    }
    for (const k of kombinasi) {
      const label = `Laporan 24 ${k.jenis} ${k.mode} ${k.tahun}-${String(k.bulan).padStart(2, "0")}`;
      try {
        const lap = await dunia.rka.laporanRkaVsRealisasi(
          { tahun: k.tahun, jenis: k.jenis, cabangId: null, mode: k.mode, bulan: k.bulan },
          rkaCtx,
        );
        out.push({
          nama: label,
          lulus: lap.baris.length > 0,
          detail: `${lap.baris.length} baris, anggaran ${rupiahTampil(lap.total.anggaran)}, realisasi ${rupiahTampil(
            lap.total.realisasi,
          )}`,
        });
      } catch (err) {
        out.push({ nama: label, lulus: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return out;
}

/**
 * The report-template trap recorded in docs/DEV.md: a template with two or zero
 * net-asset categories makes reports 17, 19 and 20 refuse with
 * SEKSI_ASET_NETO_TIDAK_DIKENAL. The demo entity must not be one of those, and
 * checking it here means the failure is named rather than discovered on stage.
 */
export async function periksaTemplateLaporan(dunia: Dunia): Promise<Pemeriksaan[]> {
  const rows = await dunia.db.query<{ kode: string; jumlah: string }>(
    `SELECT t.kode, count(*) FILTER (
              WHERE l.laporan = 'PERUBAHAN_ASET_NETO' AND l.deleted_at IS NULL
            )::text AS jumlah
       FROM template_laporan t
       LEFT JOIN baris_laporan l ON l.template_id = t.id
      WHERE t.bumn_id = $1::uuid AND t.deleted_at IS NULL AND t.aktif
      GROUP BY t.kode
      ORDER BY t.kode`,
    [dunia.bumnId],
  );
  return rows.map((r) => ({
    nama: `template laporan "${r.kode}": tepat satu kategori aset neto`,
    lulus: Number(r.jumlah) === 1,
    detail: `${r.jumlah} kategori`,
  }));
}

export function cetakPemeriksaan(hasil: readonly Pemeriksaan[], log: (l: string) => void): boolean {
  let semuaLulus = true;
  for (const h of hasil) {
    if (!h.lulus) semuaLulus = false;
    log(`  ${h.lulus ? "PASS" : "GAGAL"}  ${h.nama} :: ${h.detail}`);
  }
  return semuaLulus;
}
