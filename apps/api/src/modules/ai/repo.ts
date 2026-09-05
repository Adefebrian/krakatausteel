// apps/api/src/modules/ai/repo.ts
//
// EVERY STATEMENT IN THIS FILE IS EITHER A SELECT OR A WRITE TO `ai_saran`.
// There is no other table this module may touch, and the module holds no
// journal port, so invariant 11 is unreachable from here rather than merely
// respected (contract.ts rule 1). A repair path, a proposal insert or a mitra
// update invented in this file would be the moment the assistant acquired write
// authority, which is the one thing the repo owner ruled out.
//
// BALANCES AND LINES COME FROM `v_ledger_baris`, NEVER FROM A `status = POSTED`
// FILTER OF MY OWN (ADR 0010): a REVERSED journal is still in the ledger and
// its lines are offset by its reversal's. The one place this file narrows the
// view is the SCAN POPULATION, which is `status_jurnal = 'POSTED'` on purpose:
// a REVERSED entry has already been corrected by a human, and putting it at the
// top of a review queue would spend a reviewer's attention on work somebody has
// already done. The HISTORY the scan is measured against uses the whole view.
import type { QueryRunner } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

export interface BarisPeriode {
  id: string;
  bumnId: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: string;
}

export async function ambilPeriode(
  db: QueryRunner,
  periodeId: string,
  bumnId: string,
): Promise<BarisPeriode | null> {
  const rows = await db.query<{
    id: string;
    bumn_id: string;
    tahun: string;
    bulan: string;
    tanggal_mulai: string;
    tanggal_akhir: string;
    status: string;
  }>(
    `SELECT id::text AS id,
            bumn_id::text AS bumn_id,
            tahun::text AS tahun,
            bulan::text AS bulan,
            tanggal_mulai::text AS tanggal_mulai,
            tanggal_akhir::text AS tanggal_akhir,
            status
       FROM periode
      WHERE id = $1::uuid AND bumn_id = $2::uuid AND deleted_at IS NULL`,
    [periodeId, bumnId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    bumnId: r.bumn_id,
    tahun: Number(r.tahun),
    bulan: Number(r.bulan),
    tanggalMulai: r.tanggal_mulai,
    tanggalAkhir: r.tanggal_akhir,
    status: r.status,
  };
}

// ---------------------------------------------------------------------------
// The scan population
// ---------------------------------------------------------------------------

/**
 * One ledger line of one journal in the scanned period.
 *
 * EVERY MONEY FIELD IS `numeric(20,2)::text`. It becomes a BigInt of sen in
 * ./anomali.ts and never a JS number anywhere in between (invariant 7).
 */
export interface BarisJurnalScan {
  jurnalId: string;
  noJurnal: string;
  cabangId: string;
  tanggalTransaksi: string;
  jenis: string;
  keterangan: string | null;
  totalDebit: string;
  urutan: number;
  akunId: string;
  kodeAkun: string;
  debit: string;
  kredit: string;
  mitraId: string | null;
}

/**
 * `batas` caps LINES, not journals, because a runaway period is a runaway line
 * count and the ceiling has to bind the thing that actually grows. The caller
 * reports `terpotong` when the cap bites.
 */
export async function ambilBarisPeriode(
  db: QueryRunner,
  args: {
    periodeId: string;
    bumnId: string;
    cabangIds: readonly string[];
    batasBaris: number;
  },
): Promise<BarisJurnalScan[]> {
  const rows = await db.query<{
    jurnal_id: string;
    no_jurnal: string;
    cabang_id: string;
    tanggal_transaksi: string;
    jenis: string;
    keterangan: string | null;
    total_debit: string;
    urutan: string;
    akun_id: string;
    kode_akun: string;
    debit: string;
    kredit: string;
    mitra_id: string | null;
  }>(
    `SELECT v.jurnal_id::text     AS jurnal_id,
            v.no_jurnal           AS no_jurnal,
            v.cabang_id::text     AS cabang_id,
            v.tanggal_transaksi::text AS tanggal_transaksi,
            v.jenis               AS jenis,
            j.keterangan          AS keterangan,
            j.total_debit::text   AS total_debit,
            v.urutan::text        AS urutan,
            v.akun_id::text       AS akun_id,
            a.kode                AS kode_akun,
            v.debit::text         AS debit,
            v.kredit::text        AS kredit,
            v.mitra_id::text      AS mitra_id
       FROM v_ledger_baris v
       JOIN jurnal j ON j.id = v.jurnal_id
       JOIN akun a ON a.postable_id = v.akun_id
      WHERE v.periode_id = $1::uuid
        AND v.bumn_id = $2::uuid
        AND v.status_jurnal = 'POSTED'
        AND v.cabang_id = ANY($3::uuid[])
      ORDER BY v.jurnal_id, v.urutan
      LIMIT $4`,
    [args.periodeId, args.bumnId, [...args.cabangIds], args.batasBaris],
  );
  return rows.map((r) => ({
    jurnalId: r.jurnal_id,
    noJurnal: r.no_jurnal,
    cabangId: r.cabang_id,
    tanggalTransaksi: r.tanggal_transaksi,
    jenis: r.jenis,
    keterangan: r.keterangan,
    totalDebit: r.total_debit,
    urutan: Number(r.urutan),
    akunId: r.akun_id,
    kodeAkun: r.kode_akun,
    debit: r.debit,
    kredit: r.kredit,
    mitraId: r.mitra_id,
  }));
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/**
 * Per-account history, summarised ROBUSTLY and WITHOUT A FLOAT.
 *
 * `percentile_disc`, not `percentile_cont`: the continuous form takes the
 * midpoint of two neighbours and Postgres computes it in double precision, so
 * asking for a median of `numeric` money would hand back a float. The discrete
 * form returns an actual element of the set and keeps the `numeric` type, which
 * is what lets ./anomali.ts read every figure here as a BigInt of sen.
 *
 * MEDIAN AND MAD RATHER THAN MEAN AND STANDARD DEVIATION, because the thing
 * being looked for IS the outlier: one 5-billion-rupiah entry drags a mean and
 * inflates a standard deviation until it hides itself. The median absolute
 * deviation does not move.
 */
export interface RiwayatAkun {
  akunId: string;
  jumlahBaris: number;
  /** Median line amount, `numeric(20,2)` as text. */
  median: string;
  /** Median absolute deviation, `numeric(20,2)` as text. */
  mad: string;
  /** How many historical lines were exact multiples of `pembulatan`. */
  jumlahBulat: number;
}

export async function ambilRiwayatAkun(
  db: QueryRunner,
  args: {
    bumnId: string;
    /** Exclusive upper bound: history is everything BEFORE the scanned period. */
    sebelum: string;
    /** Inclusive lower bound, so the baseline window is finite and cheap. */
    sejak: string;
    akunIds: readonly string[];
    /** Multiple that counts as "round", in rupiah units (numeric, not sen). */
    pembulatan: string;
  },
): Promise<RiwayatAkun[]> {
  if (args.akunIds.length === 0) return [];
  const rows = await db.query<{
    akun_id: string;
    n: string;
    median: string | null;
    mad: string | null;
    n_bulat: string;
  }>(
    `WITH riwayat AS (
        SELECT v.akun_id, (v.debit + v.kredit) AS nilai
          FROM v_ledger_baris v
         WHERE v.bumn_id = $1::uuid
           AND v.tanggal_transaksi < $2::date
           AND v.tanggal_transaksi >= $3::date
           AND v.akun_id = ANY($4::uuid[])
     ),
     med AS (
        SELECT akun_id,
               count(*) AS n,
               percentile_disc(0.5) WITHIN GROUP (ORDER BY nilai) AS median,
               count(*) FILTER (WHERE nilai > 0 AND mod(nilai, $5::numeric) = 0) AS n_bulat
          FROM riwayat
         GROUP BY akun_id
     ),
     dev AS (
        SELECT r.akun_id,
               percentile_disc(0.5) WITHIN GROUP (ORDER BY abs(r.nilai - m.median)) AS mad
          FROM riwayat r
          JOIN med m ON m.akun_id = r.akun_id
         GROUP BY r.akun_id
     )
     SELECT m.akun_id::text AS akun_id,
            m.n::text       AS n,
            m.median::text  AS median,
            d.mad::text     AS mad,
            m.n_bulat::text AS n_bulat
       FROM med m
       JOIN dev d ON d.akun_id = m.akun_id`,
    [args.bumnId, args.sebelum, args.sejak, [...args.akunIds], args.pembulatan],
  );
  return rows.map((r) => ({
    akunId: r.akun_id,
    jumlahBaris: Number(r.n),
    median: r.median ?? "0.00",
    mad: r.mad ?? "0.00",
    jumlahBulat: Number(r.n_bulat),
  }));
}

/**
 * Every (debit account, credit account) pair this entity has used before,
 * restricted to the accounts that actually appear in the scanned period.
 *
 * The restriction is what keeps the result bounded: without it this is the
 * cross product of the whole chart of accounts with itself, and the rule only
 * ever asks about pairs the period contains.
 */
export async function ambilPasanganAkunHistoris(
  db: QueryRunner,
  args: { bumnId: string; sebelum: string; sejak: string; akunIds: readonly string[] },
): Promise<Set<string>> {
  if (args.akunIds.length === 0) return new Set();
  const rows = await db.query<{ debit_akun: string; kredit_akun: string }>(
    `SELECT DISTINCT d.akun_id::text AS debit_akun, k.akun_id::text AS kredit_akun
       FROM v_ledger_baris d
       JOIN v_ledger_baris k ON k.jurnal_id = d.jurnal_id
      WHERE d.bumn_id = $1::uuid
        AND d.tanggal_transaksi < $2::date
        AND d.tanggal_transaksi >= $3::date
        AND d.debit > 0
        AND k.kredit > 0
        AND d.akun_id = ANY($4::uuid[])
        AND k.akun_id = ANY($4::uuid[])`,
    [args.bumnId, args.sebelum, args.sejak, [...args.akunIds]],
  );
  return new Set(rows.map((r) => `${r.debit_akun}>${r.kredit_akun}`));
}

/**
 * Every (mitra, account) pairing this entity has used before, restricted to the
 * counterparties that appear in the scanned period. Same bounding argument as
 * the account pairs above.
 */
export async function ambilPasanganMitraHistoris(
  db: QueryRunner,
  args: { bumnId: string; sebelum: string; sejak: string; mitraIds: readonly string[] },
): Promise<Set<string>> {
  if (args.mitraIds.length === 0) return new Set();
  const rows = await db.query<{ mitra_id: string; akun_id: string }>(
    `SELECT DISTINCT v.mitra_id::text AS mitra_id, v.akun_id::text AS akun_id
       FROM v_ledger_baris v
      WHERE v.bumn_id = $1::uuid
        AND v.tanggal_transaksi < $2::date
        AND v.tanggal_transaksi >= $3::date
        AND v.mitra_id = ANY($4::uuid[])`,
    [args.bumnId, args.sebelum, args.sejak, [...args.mitraIds]],
  );
  return new Set(rows.map((r) => `${r.mitra_id}@${r.akun_id}`));
}

// ---------------------------------------------------------------------------
// ai_saran (migration 0034). A LOG, NOT BUSINESS STATE.
// ---------------------------------------------------------------------------

export interface SaranBaru {
  bumnId: string;
  cabangId: string;
  jenis: "EKSTRAKSI_DOKUMEN" | "ANOMALI_JURNAL";
  model: string | null;
  status: "BERHASIL" | "GAGAL" | "NONAKTIF";
  hasil: unknown;
  masukan: unknown;
  konteksTipe: string | null;
  konteksId: string | null;
  userId: string;
}

/**
 * Writes one suggestion row and returns its id.
 *
 * `hasil` is a model's output over an applicant's document, so it goes in as
 * JSONB DATA through a bound parameter and is never interpolated, never
 * inspected for control flow, and never read back by any other module.
 */
export async function simpanSaran(db: QueryRunner, s: SaranBaru): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO ai_saran
       (bumn_id, cabang_id, jenis, sumber, model, status,
        hasil_json, masukan_json, konteks_tipe, konteks_id, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $3, 'AI', $4, $5,
             $6::jsonb, $7::jsonb, $8, $9::uuid, $10::uuid, $10::uuid)
     RETURNING id::text AS id`,
    [
      s.bumnId,
      s.cabangId,
      s.jenis,
      s.model,
      s.status,
      JSON.stringify(s.hasil ?? {}),
      JSON.stringify(s.masukan ?? {}),
      s.konteksTipe,
      s.konteksId,
      s.userId,
    ],
  );
  return rows[0]!.id;
}

export interface SaranTersimpan {
  id: string;
  bumnId: string;
  cabangId: string;
  jenis: string;
  keputusan: string | null;
}

export async function ambilSaran(
  db: QueryRunner,
  saranId: string,
  bumnId: string,
): Promise<SaranTersimpan | null> {
  const rows = await db.query<{
    id: string;
    bumn_id: string;
    cabang_id: string;
    jenis: string;
    keputusan: string | null;
  }>(
    `SELECT id::text AS id, bumn_id::text AS bumn_id, cabang_id::text AS cabang_id,
            jenis, keputusan
       FROM ai_saran
      WHERE id = $1::uuid AND bumn_id = $2::uuid AND deleted_at IS NULL`,
    [saranId, bumnId],
  );
  const r = rows[0];
  return r
    ? { id: r.id, bumnId: r.bumn_id, cabangId: r.cabang_id, jenis: r.jenis, keputusan: r.keputusan }
    : null;
}

/**
 * Records who confirmed a suggestion and what they decided (spec 12: "siapa
 * yang mengonfirmasi").
 *
 * THE `keputusan IS NULL` PREDICATE IS THE CONCURRENCY CONTROL. Two people
 * clicking at once produce one winner and one `SARAN_SUDAH_DIKONFIRMASI`,
 * rather than a silently overwritten trail. It updates `ai_saran` and nothing
 * else: confirming a suggestion creates no proposal, no mitra and no journal,
 * because the Maker does that themselves through the ordinary form.
 */
export async function tandaiKonfirmasi(
  db: QueryRunner,
  args: { saranId: string; bumnId: string; keputusan: string; userId: string; pada: Date },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE ai_saran
        SET keputusan = $3,
            dikonfirmasi_oleh = $4::uuid,
            dikonfirmasi_at = $5::timestamptz,
            updated_by = $4::uuid,
            updated_at = now(),
            version = version + 1
      WHERE id = $1::uuid
        AND bumn_id = $2::uuid
        AND deleted_at IS NULL
        AND keputusan IS NULL
      RETURNING id::text AS id`,
    [args.saranId, args.bumnId, args.keputusan, args.userId, args.pada.toISOString()],
  );
  return rows.length > 0;
}
