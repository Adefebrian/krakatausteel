// The event-to-journal mappings, as SEEDED DATA: the 19 of spec 6.4 plus 3
// the owner ruled on because the spec has no code for them.
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
// THE THREE EVENTS THAT ARE NOT IN SPEC 6.4, and why they are here rather
// than invented at a call site. Each is a real movement of money that Fase 3
// to 5 cannot record with the spec's 19 codes; the owner's reasoning is in
// docs/BUILD-PLAN.md ("Keputusan sementara: event yang tidak ada di
// spesifikasi Bagian 6.4") and each is logged as an assumption awaiting the
// client's finance team and their KAP (ASSUMPTIONS.md A-38 to A-40). None of
// them is a compliance claim.
//
// They sit at the END of the catalogue, after the 19, so the spec's own list
// stays readable as a block and a diff never mixes "what the spec says" with
// "what we decided". ./event-jurnal.test.ts asserts that split explicitly.
//
// Being wrong here is cheap BY CONSTRUCTION, and that is the whole argument
// for deciding now: the account pair is a row in `event_jurnal_mapping`, so a
// correction is an UPDATE, not a deploy. What would NOT be cheap is the
// alternative that was avoided: business code inventing its own journal
// because no event code existed, which is invariant 11 gone and a mis-posting
// nobody can find later.
//
// PENGHAPUSTAGIHAN DELIBERATELY HAS NO CODE. Penghapusbukuan already removes
// the receivable from the balance sheet while the right to collect survives
// on the extracomptable register, so extinguishing that right later moves no
// balance: it is a memorandum event, not a journal. A case that needs to
// extinguish a claim still on the balance sheet is two steps, hapus buku then
// hapus tagih. Two event codes producing identical journals is a
// reconciliation trap, so there is one. Do not "helpfully" add it.
//
// PAYLOAD LEGS. Three events resolve one leg at runtime rather than from the
// row (the migration's own comment says so): PENYALURAN_NON_PUMK debits a
// per-bidang expense account, PENGEMBALIAN_SISA_NON_PUMK CREDITS that same
// per-bidang account back, and BEBAN_OPERASIONAL debits a per-type expense
// account, all chosen on the form. A `null` code below means exactly that,
// and it is what sets `debit_dari_payload` / `kredit_dari_payload`. The cash
// leg is bound to 1.1.01 here and can be overridden per posting by the
// akun_kas_id the form supplies.
//
// A PAYLOAD LEG THAT IS NOT MIRRORED BY ITS REVERSE IS A BUG, and it is the
// reason the refund row changed. If the money went out through an account the
// FORM chose, then a fixed account on the way back credits a DIFFERENT
// account from the one that was debited, in every case where the two differ.
// The journal still balances, so no invariant catches it; only the per-bidang
// report does, months later. The rest of the catalogue was re-checked for the
// same shape and there is no second instance: the other reversing pairs
// (TERIMA/KEMBALIKAN_KELEBIHAN_ANGSURAN, BEBAN/PEMULIHAN_PENYISIHAN) name
// fixed accounts on both sides, and BEBAN_OPERASIONAL has no reversing event
// at all -- correcting one is `reversalJurnal`, which copies the ORIGINAL
// journal's account ids rather than re-reading this table.
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
  /** Account code, or null when the caller must supply this leg per posting. */
  debitKode: string | null;
  kreditKode: string | null;
  /**
   * "This leg is resolved by the CALLER, not by this row", stated rather than
   * inferred.
   *
   * It used to be derived from `debitKode === null`, which made one null carry
   * two different statements ("may be overridden" and "there is no account
   * here") and meant they could never be separated. They are separable
   * concepts, so they are separate fields now. Defaults to "null means from
   * payload", so the 19 fixed rows say nothing extra.
   *
   * SETTING A FLAG *AND* AN ACCOUNT IS REFUSED BY `seedEventJurnalMapping`,
   * deliberately. modules/jurnal resolves a leg as
   * `dari_payload ? payload.akun : row.akun` -- with NO fallback -- so an
   * account stored next to a raised flag is a value nothing reads, sitting in
   * the exact column where the wrong answer used to be. The next person to
   * grep for "which account does a refund credit" would find it and believe
   * it. If the engine ever gains a `payload ?? row` fallback, that guard is
   * the one place to relax, and the change has to be argued there: a caller
   * that forgets the account would then post to the pooled account silently
   * instead of being refused, which is the class of bug this whole row exists
   * to have fixed.
   */
  debitDariPayload?: boolean;
  kreditDariPayload?: boolean;
  jenis: JenisJurnal;
  deskripsi: string;
}

/** Whether the caller supplies the debit leg of this event. */
export function debitDariPayload(ev: EventJurnalDef): boolean {
  return ev.debitDariPayload ?? ev.debitKode === null;
}

/** Whether the caller supplies the credit leg of this event. */
export function kreditDariPayload(ev: EventJurnalDef): boolean {
  return ev.kreditDariPayload ?? ev.kreditKode === null;
}

/**
 * Spec 6.4 in order, verbatim, then the three owner decisions. Debit and
 * credit are the account CODES from ./coa-inti.ts, never ids: an id is
 * per-database, a code is the contract.
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
    debitDariPayload: true,
    kreditKode: "1.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Penyaluran bantuan Non PUMK, akun beban per bidang dari form",
  },
  {
    code: "PENGEMBALIAN_SISA_NON_PUMK",
    debitKode: "1.1.01",
    // PER BIDANG, and it has to be, because the DEBIT of PENYALURAN_NON_PUMK
    // above is. This row used to bind the credit to the pooled 5.1.03 while
    // the disbursement debited whatever expense account the bidang carries, so
    // a bidang with its own account had THAT account debited on the way out
    // and the POOLED account credited on the way back: the bidang's expense
    // stayed overstated by the refund and the pooled account drifted negative
    // by exactly the same amount. Both journals balance, every balance check
    // passes, and the per-bidang report is wrong. A refund is the reversal of
    // a specific disbursement, so its credit is the account that disbursement
    // debited: the caller passes the termin's own `akun_beban_id` as
    // `akunKreditId` and the engine honours it because of the null here.
    kreditKode: null,
    kreditDariPayload: true,
    jenis: "OTOMATIS",
    deskripsi: "Sisa dana Non PUMK dikembalikan setelah LPJ, akun beban per bidang dari form",
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
    debitDariPayload: true,
    kreditKode: "1.1.01",
    jenis: "OTOMATIS",
    deskripsi: "Beban operasional unit TJSL, akun beban per jenis dari form",
  },

  // --- Beyond spec 6.4: owner decisions, see the file header -------------
  {
    code: "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
    // The spec's HAPUS_BUKU_PIUTANG debits the allowance for the FULL
    // outstanding, which is only true when the allowance covers it. Under the
    // collective-impairment basis docs/REGULASI.md found to be the one in
    // force, it can be smaller, and the spec's journal as written would drive
    // a contra-ASSET account negative. The shortfall is an expense of the
    // current period. Operations that need both consume the allowance first
    // with HAPUS_BUKU_PIUTANG and route only the remainder here.
    debitKode: "5.1.01",
    kreditKode: "1.1.03",
    jenis: "OTOMATIS",
    deskripsi:
      "Hapus buku bagian yang tidak tertutup penyisihan; kekurangannya dibebankan ke periode berjalan",
  },
  {
    code: "RESTRUKTUR_POKOK_NAIK",
    // Principal up with no cash out means an already-recognised claim was
    // capitalised into principal, and accrued-but-unpaid jasa administrasi is
    // the likeliest candidate. If it turns out to be something else, this row
    // changes and no code does.
    debitKode: "1.1.03",
    kreditKode: "1.1.04",
    jenis: "OTOMATIS",
    deskripsi: "Reschedule menaikkan pokok; kapitalisasi jasa administrasi terakrual ke pokok",
  },
  {
    code: "RESTRUKTUR_POKOK_TURUN",
    // Principal down is a reduction of the claim, absorbed by the allowance
    // first; a remainder beyond the allowance goes through
    // HAPUS_BUKU_KEKURANGAN_PENYISIHAN for the same reason as above.
    debitKode: "1.1.05",
    kreditKode: "1.1.03",
    jenis: "OTOMATIS",
    deskripsi: "Reschedule menurunkan pokok; pengurangan tagihan diserap penyisihan lebih dulu",
  },
  {
    code: "SALDO_AWAL_DEBIT",
    // ONE LEG FROM THE FILE, ONE LEG FIXED, and the fixed one is the whole
    // reason there are two rows here instead of one.
    //
    // Spec 9.6's go-live import brings in a legacy TRIAL BALANCE: N accounts,
    // each with a debit or a credit, adding up to zero between them. Those
    // accounts ARE the data, so they cannot live in this table. The obvious
    // shortcut is a single row with BOTH legs from the payload; it is refused
    // by this catalogue's own tests, and rightly, because a mapping row that
    // fixes neither leg decides nothing about accounts and ADR 0004 stops
    // meaning anything for that event.
    //
    // The alternative that was actually tried and rejected: pair the file's
    // debit balances off against its credit balances with a greedy match. It
    // balances, it needs no clearing account, and it is DISHONEST -- a line
    // reading "Dr Kas 450.000.000 / Cr Aset Neto 450.000.000" asserts a
    // relationship between two figures that merely arrived on the same
    // spreadsheet, and which figure ends up against which is an artefact of
    // the matching order.
    //
    // So every imported debit balance is posted against 3.1.02, and every
    // imported credit balance (below) against the same account. The cost is
    // that the opening journal's GROSS totals are twice the trial balance's,
    // because each balance is stated once on its own account and once on the
    // clearing account. The benefit is that no pair is invented, 3.1.02 nets
    // to exactly zero whenever the import was complete, and that zero is a
    // one-query audit check. `postingEventGabungan` merges legs that agree, so
    // this costs TWO extra journal lines in total, not two per account.
    debitKode: null,
    kreditKode: "3.1.02",
    jenis: "SALDO_AWAL",
    deskripsi: "Saldo awal go-live: saldo debit warisan masuk lewat pos transisi saldo awal",
  },
  {
    code: "SALDO_AWAL_KREDIT",
    // The mirror of the row above. Both carry `jenis = 'SALDO_AWAL'`, so a
    // journal built from both is filed as SALDO_AWAL rather than OTOMATIS,
    // which is what ADR 0006 fixed before the import tool existed.
    debitKode: "3.1.02",
    kreditKode: null,
    jenis: "SALDO_AWAL",
    deskripsi: "Saldo awal go-live: saldo kredit warisan masuk lewat pos transisi saldo awal",
  },
];

/** The 19 codes spec 6.4 lists, in the spec's order. */
export const EVENT_SPEC_6_4: readonly string[] = KATALOG_EVENT_JURNAL.slice(0, 19).map(
  (ev) => ev.code,
);

/**
 * The codes that are NOT in the spec, kept nameable so a reader (and a test)
 * can tell a spec obligation from a provisional decision without diffing.
 */
export const EVENT_KEPUTUSAN_PEMILIK: readonly string[] = [
  "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
  "RESTRUKTUR_POKOK_NAIK",
  "RESTRUKTUR_POKOK_TURUN",
  // Named by spec 9.6 and ADR 0006 rather than by spec 6.4, which lists the
  // OPERATIONAL events. They are here because this list is "the codes 6.4 does
  // not name", not because the opening balance is a provisional decision: the
  // schema has carried `jenis_jurnal = 'SALDO_AWAL'` since 0010 and ADR 0006
  // fixed the journal's shape before the tool existed.
  "SALDO_AWAL_DEBIT",
  "SALDO_AWAL_KREDIT",
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

  // A raised flag with an account next to it is refused before anything is
  // written: see the note on EventJurnalDef. This is a catalogue bug, so it
  // throws rather than being silently normalised away.
  const rancu = KATALOG_EVENT_JURNAL.filter(
    (ev) =>
      (debitDariPayload(ev) && ev.debitKode !== null) ||
      (kreditDariPayload(ev) && ev.kreditKode !== null),
  ).map((ev) => ev.code);
  if (rancu.length > 0) {
    throw new Error(
      `seedEventJurnalMapping: event berikut menyatakan kaki dari payload SEKALIGUS akun tetap: ` +
        `${rancu.join(", ")}. modules/jurnal tidak pernah membaca akun itu ketika flagnya menyala, ` +
        "jadi barisnya akan menyimpan nilai yang tidak dibaca siapa pun.",
    );
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
        debitDariPayload(ev),
        kreditDariPayload(ev),
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
