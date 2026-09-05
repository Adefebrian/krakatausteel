// Fixtures for the import tests.
//
// The receipt import drives the REAL instalment engine, so its fixture has to
// produce a world that engine will accept: an OPEN period, a postable cash
// account, an akad whose schedule totals its principal, and a live outstanding
// to allocate against. Those rows are inserted with plain SQL because the
// subject under test is the IMPORT's transaction boundary and its rejection
// reporting, not the proposal workflow that would otherwise produce them.
//
// NOTHING HERE WRITES A LEDGER ROW. There is no `insert into jurnal` or
// `jurnal_baris` in this file, so `bun run check:boundaries` needs no
// exemption: every journal in these tests is produced by the instalment
// engine, through `postingEvent`, which is the whole point of the import
// tests.
import type { DbPort } from "../../core/ports/db";

export interface DuniaImpor {
  mitraId: string;
  kodeMitra: string;
  akadId: string;
  noAkad: string;
  kodeAkunKas: string;
}

let urut = 0;
function seri(): string {
  urut += 1;
  return `${Date.now().toString(36)}${urut.toString(36)}`.slice(-10).toUpperCase();
}

/** An OPEN period, so the instalment engine's journal has somewhere to land. */
export async function buatPeriodeOpen(
  db: DbPort,
  bumnId: string,
  tahun: number,
  bulan: number,
): Promise<void> {
  const mulai = `${tahun}-${String(bulan).padStart(2, "0")}-01`;
  const akhirDate = new Date(Date.UTC(tahun, bulan, 0));
  const akhir = akhirDate.toISOString().slice(0, 10);
  await db.query(
    `insert into periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
     values ($1::uuid, $2, $3, $4::date, $5::date, 'OPEN')
     on conflict (bumn_id, tahun, bulan) do nothing`,
    [bumnId, tahun, bulan, mulai, akhir],
  );
}

/**
 * A mitra, a proposal, an akad with a two-row active schedule, and the code of
 * a postable cash account. `pokok` is split across the two rows exactly, which
 * is what TJSL-JDW-001 (a DEFERRED constraint trigger) checks at COMMIT.
 */
export async function buatDuniaImpor(
  db: DbPort,
  input: { bumnId: string; cabangId: string; suffix: string },
): Promise<DuniaImpor> {
  const tag = seri();
  const kodeMitra = `IM-${input.suffix}-${tag}`;
  const noAkad = `AKI-${input.suffix}-${tag}`;
  const pokok = "1000000.00";
  const separuh = "500000.00";

  const kas = await db.query<{ kode: string }>(
    `select kode from akun
      where bumn_id = $1::uuid and is_kas and is_postable and deleted_at is null
      order by kode limit 1`,
    [input.bumnId],
  );
  const kodeAkunKas = kas[0]?.kode;
  if (!kodeAkunKas) throw new Error("impor test-support: tidak ada akun kas postable");

  return db.transaction(async (tx) => {
    const m = await tx.query<{ id: string }>(
      `insert into mitra (cabang_id, kode_mitra, nama_lengkap, status, aktif)
       values ($1::uuid, $2, $3, 'AKTIF', true) returning id::text as id`,
      [input.cabangId, kodeMitra, `Mitra Impor ${tag}`],
    );
    const mitraId = m[0]!.id;

    const p = await tx.query<{ id: string }>(
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, mitra_id,
          jumlah_diajukan, tenor_diajukan, sumber_pengajuan, status, current_step)
       values ($1::uuid, $2, date '2026-01-05', date '2026-01-05', $3::uuid,
               $4::numeric, 12, 'INTERNAL', 'DICAIRKAN', 9)
       returning id::text as id`,
      [input.cabangId, `PI-${input.suffix}-${tag}`, mitraId, pokok],
    );

    const a = await tx.query<{ id: string }>(
      `insert into pumk_akad
         (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
          jasa_adm_rate, metode_perhitungan, tenor_bulan, tanggal_mulai_angsuran,
          tanggal_jatuh_tempo_akhir, status, outstanding_pokok, outstanding_jasa)
       values ($1::uuid, $2::uuid, $3::uuid, $4, date '2026-01-10', $5::numeric,
               0.06, 'FLAT', 2, date '2026-02-10', date '2026-03-10',
               'AKTIF', $5::numeric, '60000.00')
       returning id::text as id`,
      [p[0]!.id, mitraId, input.cabangId, noAkad, pokok],
    );
    const akadId = a[0]!.id;

    await tx.query(
      `insert into pumk_jadwal_versi (akad_id, versi, is_active_version, status, tanggal_berlaku)
       values ($1::uuid, 1, true, 'ACTIVE', date '2026-01-10')`,
      [akadId],
    );
    await tx.query(
      `insert into pumk_jadwal_angsuran
         (akad_id, versi, angsuran_ke, tanggal_jatuh_tempo, pokok, jasa_adm, total,
          saldo_pokok_setelah, status)
       values
         ($1::uuid, 1, 1, date '2026-02-10', $2::numeric, '30000.00', ($2::numeric + 30000.00),
          $2::numeric, 'JATUH_TEMPO'),
         ($1::uuid, 1, 2, date '2026-03-10', $2::numeric, '30000.00', ($2::numeric + 30000.00),
          0, 'BELUM_JATUH_TEMPO')`,
      [akadId, separuh],
    );

    return { mitraId, kodeMitra, akadId, noAkad, kodeAkunKas };
  });
}

export interface AkadWarisan {
  mitraId: string;
  kodeMitra: string;
  akadId: string;
  noAkad: string;
}

/**
 * A LEGACY AKAD AS IT ARRIVES AT GO-LIVE: signed, never disbursed IN THIS
 * SYSTEM, so `status = 'BELUM_CAIR'`, `outstanding_pokok = 0` and no ledger
 * line anywhere. That is exactly the state the opening-balance import demands
 * (an import that could adjust a live receivable would be a correction from a
 * spreadsheet, not a migration), so the fixture has to be able to produce it.
 *
 * NO SCHEDULE, deliberately, and it is the honest shape rather than a
 * shortcut: ADR 0006 leaves "whether the legacy arrears history needs to be
 * reconstructed as schedule rows" open, so a migrated akad has aggregate
 * opening arrears and no instalment rows. `v_integritas_jadwal` joins
 * `pumk_jadwal_versi`, so an akad with no version never appears there and the
 * integrity check stays honest about what it did and did not look at.
 */
export async function buatAkadBelumCair(
  db: DbPort,
  input: { cabangId: string; suffix: string; pokok: string },
): Promise<AkadWarisan> {
  const tag = seri();
  const kodeMitra = `SA-${input.suffix}-${tag}`;
  const noAkad = `AKS-${input.suffix}-${tag}`;

  return db.transaction(async (tx) => {
    const m = await tx.query<{ id: string }>(
      `insert into mitra (cabang_id, kode_mitra, nama_lengkap, status, aktif)
       values ($1::uuid, $2, $3, 'AKTIF', true) returning id::text as id`,
      [input.cabangId, kodeMitra, `Mitra Warisan ${tag}`],
    );
    const mitraId = m[0]!.id;

    const p = await tx.query<{ id: string }>(
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, mitra_id,
          jumlah_diajukan, tenor_diajukan, sumber_pengajuan, status, current_step)
       values ($1::uuid, $2, date '2025-06-05', date '2025-06-05', $3::uuid,
               $4::numeric, 12, 'INTERNAL', 'DICAIRKAN', 9)
       returning id::text as id`,
      [input.cabangId, `PS-${input.suffix}-${tag}`, mitraId, input.pokok],
    );

    const a = await tx.query<{ id: string }>(
      `insert into pumk_akad
         (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
          jasa_adm_rate, metode_perhitungan, tenor_bulan, tanggal_mulai_angsuran,
          tanggal_jatuh_tempo_akhir, status, outstanding_pokok, outstanding_jasa)
       values ($1::uuid, $2::uuid, $3::uuid, $4, date '2025-06-10', $5::numeric,
               0.06, 'FLAT', 24, date '2025-07-10', date '2027-06-10',
               'BELUM_CAIR', 0, 0)
       returning id::text as id`,
      [p[0]!.id, mitraId, input.cabangId, noAkad, input.pokok],
    );

    return { mitraId, kodeMitra, akadId: a[0]!.id, noAkad };
  });
}

/** A CSV body from a header row and data rows, the way a spreadsheet exports. */
export function csv(header: readonly string[], baris: readonly (readonly string[])[]): string {
  const sel = (v: string): string =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [header.map(sel).join(","), ...baris.map((r) => r.map(sel).join(","))].join("\n");
}
