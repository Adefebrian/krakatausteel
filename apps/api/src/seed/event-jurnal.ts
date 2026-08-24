// The 19 event-to-journal mappings of spec 6.4, as SEEDED DATA.
//
// WHY THIS FILE IS NOT OPTIONAL
// Spec invariant 11 says every financial event may only create a journal
// through one central path, and ADR 0004 makes that path read
// `event_jurnal_mapping` at runtime so an accountant can correct the account
// behind an event without a deploy. The engine honours that: `postingEvent`
// rejects an unknown event with EVENT_MAPPING_TIDAK_DITEMUKAN.
//
// The consequence, which was missed until review: on a freshly migrated
// database the table is EMPTY, so every single event is rejected. No
// pencairan, no angsuran, no penyaluran, no penyisihan. "The mapping is data"
// and "the data is seeded" are two separate obligations and only the first had
// been discharged. This is that second half.
//
// ONE CATALOGUE, TWO CONSUMERS. `seedFase0` seeds a real database from it, and
// the journal engine's test fixture builds its world from it. Anything that
// exists in only one of those two places drifts, and a drifted event mapping
// is not a failing test, it is a journal that posts to the wrong account.
//
// PAYLOAD LEGS. Three events resolve one leg at runtime rather than from the
// row (the migration's own comment says so): PENYALURAN_NON_PUMK debits a
// per-bidang expense account and BEBAN_OPERASIONAL debits a per-type expense
// account, both chosen on the form. A `null` code below means exactly that,
// and it is what sets `debit_dari_payload` / `kredit_dari_payload`. The cash
// leg is bound to 1.1.01 here and can be overridden per posting by the
// akun_kas_id the form supplies.
import type { QueryRunner } from "../core/ports/db";
import { seedCoaInti, type AkunIdByKode } from "./coa-inti";

export type JenisJurnal =
  | "KAS_BANK"
  | "UMUM"
  | "PINBUK"
  | "OTOMATIS"
  | "PENYISIHAN"
  | "AKRUAL"
  | "REVERSAL"
  | "CLOSING"
  | "SALDO_AWAL";

export interface EventJurnalDef {
  code: string;
  /** Account code, or null when the posting engine must supply this leg. */
  debitKode: string | null;
  kreditKode: string | null;
  jenis: JenisJurnal;
  deskripsi: string;
}

/**
 * Spec 6.4 in order, verbatim. Debit and credit are the account CODES from
 * ./coa-inti.ts, never ids: an id is per-database, a code is the contract.
 */
export const KATALOG_EVENT_JURNAL: readonly EventJurnalDef[] = [
  {
    code: "ALOKASI_DANA_BUMN_PEMBINA",
    debitKode: "1.1.01",
    kreditKode: "4.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Terima alokasi dana dari BUMN Pembina",
  },
  {
    code: "PENCAIRAN_PUMK",
    debitKode: "1.1.03",
    kreditKode: "1.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Pencairan pinjaman PUMK ke mitra binaan",
  },
  {
    code: "ANGSURAN_POKOK",
    debitKode: "1.1.01",
    kreditKode: "1.1.03",
    jenis: "OTOMATIS",
    deskripsi: "Penerimaan angsuran pokok pinjaman",
  },
  {
    code: "ANGSURAN_JASA_ADM",
    debitKode: "1.1.01",
    kreditKode: "4.1.02",
    jenis: "OTOMATIS",
    deskripsi: "Penerimaan jasa administrasi, pengakuan cash basis",
  },
  {
    code: "ANGSURAN_JASA_ADM_AKRUAL",
    debitKode: "1.1.01",
    kreditKode: "1.1.04",
    jenis: "OTOMATIS",
    deskripsi: "Penerimaan jasa administrasi yang sudah diakrual sebelumnya",
  },
  {
    code: "TERIMA_KELEBIHAN_ANGSURAN",
    debitKode: "1.1.01",
    kreditKode: "2.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Setoran melebihi kewajiban; invarian 10, piutang tidak boleh negatif",
  },
  {
    code: "KEMBALIKAN_KELEBIHAN_ANGSURAN",
    debitKode: "2.1.01",
    kreditKode: "1.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Pengembalian kelebihan pembayaran angsuran ke mitra",
  },
  {
    code: "TERIMA_ANGSURAN_BELUM_TERIDENTIFIKASI",
    debitKode: "1.1.01",
    kreditKode: "2.1.02",
    jenis: "OTOMATIS",
    deskripsi: "Setoran masuk rekening tanpa identitas mitra",
  },
  {
    code: "IDENTIFIKASI_ANGSURAN",
    debitKode: "2.1.02",
    kreditKode: "1.1.03",
    jenis: "OTOMATIS",
    deskripsi: "Setoran belum teridentifikasi berhasil dicocokkan ke akad",
  },
  {
    code: "PENYALURAN_NON_PUMK",
    // Per bidang: the expense account comes from the form (spec 6.4 "per bidang").
    debitKode: null,
    kreditKode: "1.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Penyaluran bantuan Non PUMK, akun beban per bidang dari form",
  },
  {
    code: "PENGEMBALIAN_SISA_NON_PUMK",
    debitKode: "1.1.01",
    kreditKode: "5.1.03",
    jenis: "OTOMATIS",
    deskripsi: "Sisa dana Non PUMK dikembalikan setelah LPJ",
  },
  {
    code: "PENYALURAN_PINBUK",
    debitKode: "5.1.02",
    kreditKode: "1.1.01",
    jenis: "PINBUK",
    deskripsi: "Beban pembinaan kemitraan (pelatihan, pameran, sertifikasi)",
  },
  {
    code: "AKRUAL_JASA_ADM",
    debitKode: "1.1.04",
    kreditKode: "4.1.02",
    jenis: "AKRUAL",
    deskripsi: "Akrual jasa administrasi bulanan saat closing",
  },
  {
    code: "BEBAN_PENYISIHAN",
    debitKode: "5.1.01",
    kreditKode: "1.1.05",
    jenis: "PENYISIHAN",
    deskripsi: "Pembentukan penyisihan penurunan nilai piutang",
  },
  {
    code: "PEMULIHAN_PENYISIHAN",
    debitKode: "1.1.05",
    kreditKode: "5.1.01",
    jenis: "PENYISIHAN",
    deskripsi: "Pemulihan penyisihan saat kolektibilitas membaik",
  },
  {
    code: "HAPUS_BUKU_PIUTANG",
    debitKode: "1.1.05",
    kreditKode: "1.1.03",
    jenis: "OTOMATIS",
    deskripsi: "Penghapusbukuan piutang macet (SK-277/MBU/10/2023)",
  },
  {
    code: "PENERIMAAN_HAPUS_BUKU",
    debitKode: "1.1.01",
    kreditKode: "4.1.04",
    jenis: "OTOMATIS",
    deskripsi: "Penerimaan atas piutang yang sudah dihapus buku",
  },
  {
    code: "PENDAPATAN_JASA_GIRO",
    debitKode: "1.1.01",
    kreditKode: "4.1.03",
    jenis: "OTOMATIS",
    deskripsi: "Pendapatan bunga jasa giro rekening TJSL",
  },
  {
    code: "BEBAN_OPERASIONAL",
    // Per jenis: the expense account comes from the form (spec 6.4 "per jenis").
    debitKode: null,
    kreditKode: "1.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Beban operasional unit TJSL, akun beban per jenis dari form",
  },
];

export interface SeedEventJurnalResult {
  seeded: number;
  total: number;
}

/**
 * Seeds every spec 6.4 mapping for one bumn, idempotently.
 *
 * Resolves accounts by CODE against `akun`, and refuses loudly when one is
 * missing rather than writing a mapping with a null leg: a mapping row whose
 * debit silently became "from payload" would post a one-sided journal request
 * that fails much later, far from the cause. Pass `akunIdByKode` when the
 * caller already has the ids (the seed does), otherwise it reads them.
 */
export async function seedEventJurnalMapping(
  runner: QueryRunner,
  bumnId: string,
  options: { akunIdByKode?: AkunIdByKode; userId?: string | null } = {},
): Promise<SeedEventJurnalResult> {
  const userId = options.userId ?? null;
  let byKode = options.akunIdByKode;
  if (!byKode) {
    const rows = await runner.query<{ kode: string; id: string }>(
      `SELECT kode, id::text AS id FROM akun WHERE bumn_id = $1 AND deleted_at IS NULL`,
      [bumnId],
    );
    byKode = new Map(rows.map((row) => [row.kode, row.id]));
  }

  const perlu = new Set(
    KATALOG_EVENT_JURNAL.flatMap((ev) => [ev.debitKode, ev.kreditKode]).filter(
      (kode): kode is string => kode !== null,
    ),
  );
  const hilang = [...perlu].filter((kode) => !byKode!.has(kode)).sort();
  if (hilang.length > 0) {
    throw new Error(
      `seedEventJurnalMapping: akun berikut belum ada untuk bumn ${bumnId}: ${hilang.join(", ")}. ` +
        "Jalankan seedCoaInti lebih dulu.",
    );
  }

  let seeded = 0;
  for (const ev of KATALOG_EVENT_JURNAL) {
    const rows = await runner.query<{ id: string }>(
      `INSERT INTO event_jurnal_mapping
         (bumn_id, event_code, deskripsi, akun_debit_id, akun_kredit_id,
          debit_dari_payload, kredit_dari_payload, jenis_jurnal, aktif, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)
       ON CONFLICT (bumn_id, event_code) WHERE aktif AND deleted_at IS NULL DO NOTHING
       RETURNING id::text AS id`,
      [
        bumnId,
        ev.code,
        ev.deskripsi,
        ev.debitKode ? byKode.get(ev.debitKode) : null,
        ev.kreditKode ? byKode.get(ev.kreditKode) : null,
        ev.debitKode === null,
        ev.kreditKode === null,
        ev.jenis,
        userId,
      ],
    );
    if (rows.length > 0) seeded += 1;
  }
  return { seeded, total: KATALOG_EVENT_JURNAL.length };
}

/**
 * Convenience for a caller that wants a complete, postable world for one bumn:
 * the core COA plus every event mapping. Used by `seedFase0` and available to
 * the engine's test fixture so the two cannot describe different worlds.
 */
export async function seedCoaDanEventMapping(
  runner: QueryRunner,
  bumnId: string,
  userId: string | null = null,
): Promise<{ akun: AkunIdByKode; event: SeedEventJurnalResult }> {
  const akun = await seedCoaInti(runner, bumnId, userId);
  const event = await seedEventJurnalMapping(runner, bumnId, { akunIdByKode: akun, userId });
  return { akun, event };
}
