// Fixtures for the mitra tests.
//
// The rows are inserted with plain SQL rather than driven through the PUMK
// engines, and that is deliberate: what is under test here is READ ISOLATION
// between two borrowers, so the fixture only has to produce two akad that
// really exist, in the branches it says, with a schedule and a receipt each.
// Driving the whole proposal -> survey -> review -> approval -> akad ->
// disbursement chain would make the isolation test depend on six other
// modules' rules and would prove nothing extra about who may read what.
//
// NOTHING HERE WRITES A LEDGER ROW. There is no `insert into jurnal` or
// `jurnal_baris` in this file, so `bun run check:boundaries` needs no
// exemption for it: `pumk_angsuran.jurnal_id` is left NULL, which is legal in
// the schema and is all a read test needs.
import type { DbPort } from "../../core/ports/db";

export interface MitraUji {
  mitraId: string;
  kodeMitra: string;
  nama: string;
  nik: string;
  cabangId: string;
}

export interface AkadUji {
  akadId: string;
  proposalId: string;
  noAkad: string;
}

let urut = 0;
function seri(): string {
  urut += 1;
  return `${Date.now().toString(36)}${urut.toString(36)}`.slice(-10).toUpperCase();
}

export async function buatMitraUji(
  db: DbPort,
  input: { cabangId: string; nama: string; suffix: string },
): Promise<MitraUji> {
  const tag = seri();
  const kodeMitra = `M-${input.suffix}-${tag}`;
  // 16 digits, unique per fixture: `mitra_nik_uq` is a real unique index and
  // two fixtures running in one database must not collide on it.
  const nik = `32${tag.replace(/[^0-9]/g, "0").padEnd(8, "7").slice(0, 8)}${Math.floor(
    Math.random() * 1_000_000,
  )
    .toString()
    .padStart(6, "0")}`.slice(0, 16);
  const rows = await db.query<{ id: string }>(
    `insert into mitra (cabang_id, kode_mitra, nama_lengkap, nik, status, aktif)
     values ($1::uuid, $2, $3, $4, 'AKTIF', true)
     returning id::text as id`,
    [input.cabangId, kodeMitra, input.nama, nik],
  );
  return { mitraId: rows[0]!.id, kodeMitra, nama: input.nama, nik, cabangId: input.cabangId };
}

/**
 * A proposal, an akad, a one-row active schedule whose principal equals the
 * akad's (TJSL-JDW-001 is a DEFERRED constraint trigger and fires at COMMIT),
 * and one receipt against it.
 */
export async function buatAkadUji(
  db: DbPort,
  input: { cabangId: string; mitraId: string; suffix: string; pokok?: string },
): Promise<AkadUji> {
  const tag = seri();
  const pokok = input.pokok ?? "1000000.00";
  const noProposal = `P-${input.suffix}-${tag}`;
  const noAkad = `AK-${input.suffix}-${tag}`;

  return db.transaction(async (tx) => {
    const p = await tx.query<{ id: string }>(
      `insert into pumk_proposal
         (cabang_id, no_proposal, tanggal_proposal, tanggal_daftar, mitra_id,
          jumlah_diajukan, tenor_diajukan, sumber_pengajuan, status, current_step)
       values ($1::uuid, $2, date '2026-01-05', date '2026-01-05', $3::uuid,
               $4::numeric, 12, 'INTERNAL', 'DICAIRKAN', 9)
       returning id::text as id`,
      [input.cabangId, noProposal, input.mitraId, pokok],
    );
    const proposalId = p[0]!.id;

    const a = await tx.query<{ id: string }>(
      `insert into pumk_akad
         (proposal_id, mitra_id, cabang_id, no_akad, tanggal_akad, pokok_pinjaman,
          jasa_adm_rate, metode_perhitungan, tenor_bulan, tanggal_mulai_angsuran,
          tanggal_jatuh_tempo_akhir, status, outstanding_pokok, outstanding_jasa)
       values ($1::uuid, $2::uuid, $3::uuid, $4, date '2026-01-10', $5::numeric,
               0.06, 'FLAT', 12, date '2026-02-10', date '2027-01-10',
               'AKTIF', $5::numeric, '60000.00')
       returning id::text as id`,
      [proposalId, input.mitraId, input.cabangId, noAkad, pokok],
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
       values ($1::uuid, 1, 1, date '2026-02-10', $2::numeric, '60000.00',
               ($2::numeric + 60000.00), 0, 'BELUM_JATUH_TEMPO')`,
      [akadId, pokok],
    );
    await tx.query(
      `insert into pumk_angsuran
         (akad_id, tanggal_terima, jumlah_diterima, alokasi_pokok, alokasi_jasa,
          alokasi_kelebihan, akun_kas_id, no_bukti)
       select $1::uuid, date '2026-02-10', '100000.00', '95000.00', '5000.00', '0.00',
              k.id, $3
         from akun k
        where k.bumn_id = (select c.bumn_id from cabang c where c.id = $2::uuid)
          and k.is_postable and k.deleted_at is null
        limit 1`,
      [akadId, input.cabangId, `BKT-${tag}`],
    );

    return { akadId, proposalId, noAkad };
  });
}
