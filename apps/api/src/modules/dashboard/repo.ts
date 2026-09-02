// Every statement the dashboard engine issues, in one file. No business rules
// live here; the service authorises, chooses the SOURCE and shapes, the repo
// reads.
//
// NOTHING IN THIS FILE WRITES. There is no INSERT, UPDATE or DELETE anywhere
// below, which is what makes "the dashboard is the one screen with no reason
// ever to write" a property of the code rather than a promise in a comment.
//
// TWO READINGS OF THE SAME FIGURE, SIDE BY SIDE, ON PURPOSE.
// Every money query below comes in a pair: `*Ledger` reads `v_ledger_baris`
// (an OPEN period) and `*Beku` reads `saldo_akun_periode` (a CLOSED one). They
// are written next to each other so the arithmetic can be compared by eye,
// because the two MUST agree on a month that is closed and re-read:
//
//   `saldo_akun_periode.mutasi_debit` is, by the closing engine's own freeze
//   query (modules/closing/repo.ts `saldoAkunUntukPeriode`),
//   `sum(l.debit) FROM v_ledger_baris WHERE tanggal_transaksi >= mulai` for the
//   period, and `saldo_akhir` is the debit-positive running balance at period
//   end. So `sum(debit)` here and `sum(mutasi_debit)` there are the same
//   number, and `sum(debit - kredit) up to tanggal_akhir` here is
//   `sum(saldo_akhir)` there.
//
// If those two ever stop agreeing, the dashboard for a closed month stops
// agreeing with the statements for that month, which is the failure this whole
// module is arranged around.
//
// ALWAYS `v_ledger_baris`, NEVER a POSTED-only filter (ADR 0010,
// migrations/0018): a REVERSED journal's lines are still ledger entries and are
// offset by its reversal's. This file reads the shipped view rather than
// restating the predicate, exactly like modules/tools, modules/rka and
// modules/laporan do.
//
// DRIVER FACTS THIS FILE IS BUILT AROUND (modules/jurnal/repo.ts states them at
// length):
//   - a JS array binds as a comma-joined string, so `= ANY($n::uuid[])` fails
//     with 22P02. Branch and account scoping below build explicit placeholder
//     lists.
//   - DATE and TIMESTAMPTZ come back as JS `Date`, so every one of them is
//     selected `::text`.
//   - `coalesce(sum(x), 0)` comes back as '0', not '0.00'. Every money value is
//     cast `::numeric(20,2)` BEFORE `::text`, or it fails `POLA_UANG` in the
//     service and the failure surfaces three layers from its cause.
import type { QueryRunner } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

export interface Lingkup {
  bumnId: string;
  /**
   * The branches this answer covers. NEVER empty: the service resolves it from
   * the SESSION and intersects the request's filter with it, so "no branch"
   * would be a bug rather than "every branch".
   */
  cabangIds: readonly string[];
}

/**
 * `column IN ($n, $n+1, ...)`. Explicit placeholders rather than
 * `= ANY($n::uuid[])`, per this file's driver notes.
 *
 * An EMPTY list produces `FALSE`, not `TRUE`. The difference matters: this
 * helper is used for account sets as well as branches, and an entity that has
 * never disbursed Non PUMK has an empty account set. `TRUE` there would sum
 * the WHOLE ledger into the Non PUMK metric.
 */
function daftar(kolom: string, nilai: readonly string[], params: unknown[]): string {
  if (nilai.length === 0) return "FALSE";
  const mulai = params.length + 1;
  params.push(...nilai);
  return `${kolom} IN (${nilai.map((_, i) => `$${mulai + i}`).join(", ")})`;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PeriodeRow {
  id: string;
  tahun: number;
  bulan: number;
  status: string;
  tanggal_mulai: string;
  tanggal_akhir: string;
  closed_at: string | null;
}

export interface CabangRow {
  id: string;
  kode: string;
  nama: string;
}

export interface AkunRow {
  id: string;
  kode: string;
  nama: string;
}

export interface HitungRow {
  n: string;
}

/** A money aggregate, in all three readings a metric might want. */
export interface GerakRow {
  debit: string;
  kredit: string;
  neto: string;
}

export interface BarisAkunRow {
  id: string;
  akun_id: string;
  kode: string;
  nama: string;
  cabang_id: string;
  nilai: string;
}

export interface BarisLedgerRow {
  id: string;
  jurnal_id: string;
  no_jurnal: string;
  cabang_id: string;
  tanggal_transaksi: string;
  akun_kode: string;
  keterangan: string | null;
  nilai: string;
}

export interface BarisAkadRow {
  id: string;
  no_akad: string;
  cabang_id: string;
  mitra_id: string;
  nama_mitra: string;
  status: string;
  tanggal_akad: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
}

export interface BarisSnapshotRow {
  id: string;
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  mitra_id: string;
  nama_mitra: string;
  kolektibilitas: string;
  hari_tunggakan: string;
  outstanding_pokok: string;
}

export interface KelasRow {
  kode: string;
  nama: string;
  urutan: number;
  is_bermasalah: boolean;
}

export interface RingkasKelasRow {
  kolektibilitas: string;
  jumlah_akad: string;
  outstanding_pokok: string;
}

export interface PortofolioRow {
  outstanding_pokok: string;
  jumlah_akad: string;
  jumlah_mitra: string;
}

export interface PengembalianRow {
  jatuh_tempo: string;
  terbayar: string;
  jumlah_baris: string;
}

export interface BarisJadwalRow {
  id: string;
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  angsuran_ke: string;
  tanggal_jatuh_tempo: string;
  total: string;
  terbayar: string;
  status: string;
}

export interface AnggaranRow {
  total: string;
  jumlah_baris: string;
}

export interface BarisAnggaranRow {
  id: string;
  uraian: string;
  bidang: string | null;
  bulan: string | null;
  jumlah_anggaran: string;
}

export interface AntrianRow {
  status: string;
  n: string;
}

export interface BarisProposalRow {
  id: string;
  no_proposal: string;
  cabang_id: string;
  tanggal_proposal: string;
  label: string;
  status: string;
  nilai: string;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const KOLOM_PERIODE = `p.id::text AS id, p.tahun::int AS tahun, p.bulan::int AS bulan,
       p.status, p.tanggal_mulai::text AS tanggal_mulai,
       p.tanggal_akhir::text AS tanggal_akhir, p.closed_at::text AS closed_at`;

export function daftarPeriode(
  db: QueryRunner,
  bumnId: string,
  tahun: number | null,
): Promise<PeriodeRow[]> {
  const params: unknown[] = [bumnId];
  let filter = "";
  if (tahun !== null) {
    params.push(tahun);
    filter = ` AND p.tahun = $${params.length}`;
  }
  return db.query<PeriodeRow>(
    `SELECT ${KOLOM_PERIODE}
       FROM periode p
      WHERE p.bumn_id = $1 AND p.deleted_at IS NULL${filter}
      ORDER BY p.tahun DESC, p.bulan DESC`,
    params,
  );
}

export async function periodeById(
  db: QueryRunner,
  bumnId: string,
  periodeId: string,
): Promise<PeriodeRow | null> {
  const rows = await db.query<PeriodeRow>(
    `SELECT ${KOLOM_PERIODE}
       FROM periode p
      WHERE p.id = $1 AND p.bumn_id = $2 AND p.deleted_at IS NULL`,
    [periodeId, bumnId],
  );
  return rows[0] ?? null;
}

export async function periodeByBulan(
  db: QueryRunner,
  bumnId: string,
  tahun: number,
  bulan: number,
): Promise<PeriodeRow | null> {
  const rows = await db.query<PeriodeRow>(
    `SELECT ${KOLOM_PERIODE}
       FROM periode p
      WHERE p.bumn_id = $1 AND p.tahun = $2 AND p.bulan = $3 AND p.deleted_at IS NULL`,
    [bumnId, tahun, bulan],
  );
  return rows[0] ?? null;
}

/**
 * The default period: the newest OPEN one, and only if there is none, the
 * newest period of any status.
 *
 * `ORDER BY (status = 'OPEN') DESC` rather than two queries, so the tie break
 * is stated once. A dashboard that defaulted to the newest period FULL STOP
 * would open on a month nobody is working in the moment a future period is
 * created ahead of time, which the seed does.
 */
export async function periodeBawaan(
  db: QueryRunner,
  bumnId: string,
  tahun: number | null,
): Promise<PeriodeRow | null> {
  const params: unknown[] = [bumnId];
  let filter = "";
  if (tahun !== null) {
    params.push(tahun);
    filter = ` AND p.tahun = $${params.length}`;
  }
  const rows = await db.query<PeriodeRow>(
    `SELECT ${KOLOM_PERIODE}
       FROM periode p
      WHERE p.bumn_id = $1 AND p.deleted_at IS NULL${filter}
      ORDER BY (p.status = 'OPEN') DESC, p.tahun DESC, p.bulan DESC
      LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Reference reads
// ---------------------------------------------------------------------------

export async function cabang(
  db: QueryRunner,
  bumnId: string,
  cabangId: string,
): Promise<CabangRow | null> {
  const rows = await db.query<CabangRow>(
    `SELECT id::text AS id, kode, nama
       FROM cabang
      WHERE id = $1 AND bumn_id = $2 AND deleted_at IS NULL`,
    [cabangId, bumnId],
  );
  return rows[0] ?? null;
}

export function cabangDalam(db: QueryRunner, l: Lingkup): Promise<CabangRow[]> {
  const params: unknown[] = [l.bumnId];
  const scope = daftar("c.id", l.cabangIds, params);
  return db.query<CabangRow>(
    `SELECT c.id::text AS id, c.kode, c.nama
       FROM cabang c
      WHERE c.bumn_id = $1 AND c.deleted_at IS NULL AND ${scope}
      ORDER BY c.kode`,
    params,
  );
}

export function kelasKolektibilitas(db: QueryRunner): Promise<KelasRow[]> {
  return db.query<KelasRow>(
    `SELECT kode, nama, urutan::int AS urutan, is_bermasalah
       FROM kolektibilitas_kelas
      WHERE aktif
      ORDER BY urutan`,
  );
}

/**
 * The receivable account, from the SANCTIONED event mapping and never from a
 * hard coded `1.1.03`. Exactly the read `v_rekonsiliasi_piutang`
 * (migrations/0018) makes, so the dashboard's PUMK figure and spec 8.4 check 10
 * are talking about the same account.
 */
export async function akunPiutangPumk(
  db: QueryRunner,
  bumnId: string,
): Promise<AkunRow | null> {
  const rows = await db.query<AkunRow>(
    `SELECT a.id::text AS id, a.kode, a.nama
       FROM event_jurnal_mapping m
       JOIN akun a ON a.id = m.akun_debit_id
      WHERE m.bumn_id = $1 AND m.event_code = 'PENCAIRAN_PUMK'
        AND m.aktif AND m.deleted_at IS NULL
      LIMIT 1`,
    [bumnId],
  );
  return rows[0] ?? null;
}

/**
 * THE NON PUMK EXPENSE ACCOUNTS, DISCOVERED FROM THE DATA rather than declared.
 *
 * `PENYALURAN_NON_PUMK` resolves its debit leg FROM THE PAYLOAD (see
 * apps/api/src/seed/event-jurnal.ts: `debit_dari_payload`), because spec 6.4
 * puts the expense account per bidang and the form chooses it. There is
 * therefore no single mapped account to read, and no `bidang_non_pumk.akun_id`
 * column to join: the only record of which accounts Non PUMK spends through is
 * `nonpumk_penyaluran.akun_beban_id` itself.
 *
 * ENTITY WIDE, NOT SCOPE WIDE, deliberately. The set answers "which accounts
 * does this entity spend Non PUMK through", and the branch filter is then
 * applied to the MOVEMENT. Deriving the set per branch instead would make
 * branch A's figure depend on whether branch A happens to have used an account
 * yet, so a refund landing in a month with no disbursement would vanish.
 *
 * `PENGEMBALIAN_SISA_NON_PUMK` credits back the SAME account the disbursement
 * debited (migrations/0023, and the seed's note on why that had to be fixed),
 * so `debit - kredit` over this set is disbursement NET of post-LPJ refunds,
 * which is the figure spec 11 measures against the budget.
 */
export function akunBebanNonPumk(db: QueryRunner, bumnId: string): Promise<AkunRow[]> {
  return db.query<AkunRow>(
    `SELECT DISTINCT a.id::text AS id, a.kode, a.nama
       FROM nonpumk_penyaluran np
       JOIN nonpumk_proposal p ON p.id = np.proposal_id
       JOIN cabang c ON c.id = p.cabang_id
       JOIN akun a ON a.id = np.akun_beban_id
      WHERE c.bumn_id = $1 AND np.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY a.kode`,
    [bumnId],
  );
}

/**
 * Does this period have frozen balances at all?
 *
 * Asked SEPARATELY from summing them, because zero and absent are different
 * answers and a `sum()` cannot tell them apart. A CLOSED period with no
 * `saldo_akun_periode` rows is a period whose freeze did not happen, and the
 * metric says so instead of showing 0.00.
 */
export async function adaSaldoBeku(db: QueryRunner, periodeId: string): Promise<boolean> {
  const rows = await db.query<HitungRow>(
    `SELECT count(*)::text AS n
       FROM saldo_akun_periode
      WHERE periode_id = $1 AND deleted_at IS NULL`,
    [periodeId],
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

export async function adaSnapshotKolektibilitas(
  db: QueryRunner,
  periodeId: string,
): Promise<boolean> {
  const rows = await db.query<HitungRow>(
    `SELECT count(*)::text AS n
       FROM kolektibilitas_snapshot
      WHERE periode_id = $1 AND deleted_at IS NULL`,
    [periodeId],
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

// ---------------------------------------------------------------------------
// Money: closing balance (DANA_TERSEDIA)
// ---------------------------------------------------------------------------

const NOL_GERAK: GerakRow = { debit: "0.00", kredit: "0.00", neto: "0.00" };

/**
 * Cash and cash equivalents AT PERIOD END, from the live ledger.
 *
 * `akun.is_kas` is the definition spec 10.3 report 18 uses for the Arus Kas
 * closing balance, and `akun_is_kas_hanya_aset_ck` keeps it to asset accounts,
 * so `debit - kredit` is the balance in its natural direction with no sign flip
 * to get wrong.
 */
export async function saldoKasLedger(
  db: QueryRunner,
  l: Lingkup,
  sampai: string,
): Promise<GerakRow> {
  const params: unknown[] = [l.bumnId, sampai];
  const scope = daftar("v.cabang_id", l.cabangIds, params);
  const rows = await db.query<GerakRow>(
    `SELECT coalesce(sum(v.debit), 0)::numeric(20,2)::text AS debit,
            coalesce(sum(v.kredit), 0)::numeric(20,2)::text AS kredit,
            coalesce(sum(v.debit - v.kredit), 0)::numeric(20,2)::text AS neto
       FROM v_ledger_baris v
       JOIN akun a ON a.id = v.akun_id
      WHERE v.bumn_id = $1 AND v.tanggal_transaksi <= $2::date
        AND a.is_kas AND a.deleted_at IS NULL AND ${scope}`,
    params,
  );
  return rows[0] ?? NOL_GERAK;
}

/** The same balance for a CLOSED period, from the frozen trial balance. */
export async function saldoKasBeku(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
): Promise<GerakRow> {
  const params: unknown[] = [periodeId];
  const scope = daftar("s.cabang_id", l.cabangIds, params);
  const rows = await db.query<GerakRow>(
    `SELECT coalesce(sum(s.mutasi_debit), 0)::numeric(20,2)::text AS debit,
            coalesce(sum(s.mutasi_kredit), 0)::numeric(20,2)::text AS kredit,
            coalesce(sum(s.saldo_akhir), 0)::numeric(20,2)::text AS neto
       FROM saldo_akun_periode s
       JOIN akun a ON a.id = s.akun_id
      WHERE s.periode_id = $1 AND s.deleted_at IS NULL
        AND a.is_kas AND a.deleted_at IS NULL AND ${scope}`,
    params,
  );
  return rows[0] ?? NOL_GERAK;
}

export function barisSaldoKasLedger(
  db: QueryRunner,
  l: Lingkup,
  sampai: string,
  batas: number,
): Promise<BarisAkunRow[]> {
  const params: unknown[] = [l.bumnId, sampai];
  const scope = daftar("v.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisAkunRow>(
    `SELECT (v.akun_id::text || ':' || v.cabang_id::text) AS id,
            v.akun_id::text AS akun_id, a.kode, a.nama,
            v.cabang_id::text AS cabang_id,
            coalesce(sum(v.debit - v.kredit), 0)::numeric(20,2)::text AS nilai
       FROM v_ledger_baris v
       JOIN akun a ON a.id = v.akun_id
      WHERE v.bumn_id = $1 AND v.tanggal_transaksi <= $2::date
        AND a.is_kas AND a.deleted_at IS NULL AND ${scope}
      GROUP BY v.akun_id, a.kode, a.nama, v.cabang_id
     HAVING sum(v.debit - v.kredit) <> 0
      ORDER BY a.kode, v.cabang_id
      LIMIT $${params.length}`,
    params,
  );
}

export function barisSaldoKasBeku(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
  batas: number,
): Promise<BarisAkunRow[]> {
  const params: unknown[] = [periodeId];
  const scope = daftar("s.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisAkunRow>(
    `SELECT s.id::text AS id, s.akun_id::text AS akun_id, a.kode, a.nama,
            s.cabang_id::text AS cabang_id,
            s.saldo_akhir::numeric(20,2)::text AS nilai
       FROM saldo_akun_periode s
       JOIN akun a ON a.id = s.akun_id
      WHERE s.periode_id = $1 AND s.deleted_at IS NULL
        AND a.is_kas AND a.deleted_at IS NULL AND ${scope}
        AND s.saldo_akhir <> 0
      ORDER BY a.kode, s.cabang_id
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Money: movement over the period (PENYALURAN_PUMK, REALISASI_NON_PUMK)
// ---------------------------------------------------------------------------

/**
 * Movement on a SET of accounts, within the period's own date window, from the
 * live ledger. The caller picks which of the three columns is its metric:
 * `debit` for "penyaluran PUMK" (a disbursement debits the receivable) and
 * `neto` for "realisasi Non PUMK" (a refund credits the account it was
 * disbursed from, so net is what was actually spent).
 */
export async function gerakAkunLedger(
  db: QueryRunner,
  l: Lingkup,
  akunIds: readonly string[],
  dari: string,
  sampai: string,
): Promise<GerakRow> {
  if (akunIds.length === 0) return NOL_GERAK;
  const params: unknown[] = [l.bumnId, dari, sampai];
  const scope = daftar("v.cabang_id", l.cabangIds, params);
  const akun = daftar("v.akun_id", akunIds, params);
  const rows = await db.query<GerakRow>(
    `SELECT coalesce(sum(v.debit), 0)::numeric(20,2)::text AS debit,
            coalesce(sum(v.kredit), 0)::numeric(20,2)::text AS kredit,
            coalesce(sum(v.debit - v.kredit), 0)::numeric(20,2)::text AS neto
       FROM v_ledger_baris v
      WHERE v.bumn_id = $1
        AND v.tanggal_transaksi BETWEEN $2::date AND $3::date
        AND ${scope} AND ${akun}`,
    params,
  );
  return rows[0] ?? NOL_GERAK;
}

/**
 * The same movement for a CLOSED period, from the frozen trial balance.
 *
 * `mutasi_debit` here IS `sum(debit)` above, by the closing engine's freeze
 * query. That equality is what makes the OPEN and CLOSED readings of a metric
 * the same number, and `./dashboard-sumber-periode.test.ts` closes a period and
 * asserts it on real figures rather than trusting this comment.
 */
export async function gerakAkunBeku(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
  akunIds: readonly string[],
): Promise<GerakRow> {
  if (akunIds.length === 0) return NOL_GERAK;
  const params: unknown[] = [periodeId];
  const scope = daftar("s.cabang_id", l.cabangIds, params);
  const akun = daftar("s.akun_id", akunIds, params);
  const rows = await db.query<GerakRow>(
    `SELECT coalesce(sum(s.mutasi_debit), 0)::numeric(20,2)::text AS debit,
            coalesce(sum(s.mutasi_kredit), 0)::numeric(20,2)::text AS kredit,
            coalesce(sum(s.mutasi_debit - s.mutasi_kredit), 0)::numeric(20,2)::text AS neto
       FROM saldo_akun_periode s
      WHERE s.periode_id = $1 AND s.deleted_at IS NULL
        AND ${scope} AND ${akun}`,
    params,
  );
  return rows[0] ?? NOL_GERAK;
}

/**
 * The LINES behind a movement figure, with their journal ids. This is the
 * drill-down spec 11 makes structural: a number nobody can trace to the rows
 * behind it is a number nobody trusts.
 */
export function barisGerakLedger(
  db: QueryRunner,
  l: Lingkup,
  akunIds: readonly string[],
  dari: string,
  sampai: string,
  sisi: "DEBIT" | "NETO",
  batas: number,
): Promise<BarisLedgerRow[]> {
  if (akunIds.length === 0) return Promise.resolve([]);
  const params: unknown[] = [l.bumnId, dari, sampai];
  const scope = daftar("v.cabang_id", l.cabangIds, params);
  const akun = daftar("v.akun_id", akunIds, params);
  // DEBIT drops the credit-only lines, so the rows add up to the debit figure
  // and not to something else that happens to be on the same accounts.
  const sisiFilter = sisi === "DEBIT" ? " AND v.debit <> 0" : "";
  const nilai = sisi === "DEBIT" ? "v.debit" : "(v.debit - v.kredit)";
  params.push(batas);
  return db.query<BarisLedgerRow>(
    `SELECT v.jurnal_baris_id::text AS id, v.jurnal_id::text AS jurnal_id,
            v.no_jurnal, v.cabang_id::text AS cabang_id,
            v.tanggal_transaksi::text AS tanggal_transaksi,
            a.kode AS akun_kode, j.keterangan,
            ${nilai}::numeric(20,2)::text AS nilai
       FROM v_ledger_baris v
       JOIN akun a ON a.id = v.akun_id
       JOIN jurnal j ON j.id = v.jurnal_id
      WHERE v.bumn_id = $1
        AND v.tanggal_transaksi BETWEEN $2::date AND $3::date
        AND ${scope} AND ${akun}${sisiFilter}
      ORDER BY v.tanggal_transaksi, v.no_jurnal, v.urutan
      LIMIT $${params.length}`,
    params,
  );
}

/**
 * The frozen rows behind a CLOSED period's movement figure.
 *
 * A frozen row is per (period, branch, account), so the drill-down is coarser
 * than the ledger's. That is the honest shape: a closed month HAS no finer
 * frozen record, and offering per-journal rows here would mean reading the live
 * ledger for a closed month, which is the one thing this module refuses to do.
 */
export function barisGerakBeku(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
  akunIds: readonly string[],
  sisi: "DEBIT" | "NETO",
  batas: number,
): Promise<BarisAkunRow[]> {
  if (akunIds.length === 0) return Promise.resolve([]);
  const params: unknown[] = [periodeId];
  const scope = daftar("s.cabang_id", l.cabangIds, params);
  const akun = daftar("s.akun_id", akunIds, params);
  const nilai = sisi === "DEBIT" ? "s.mutasi_debit" : "(s.mutasi_debit - s.mutasi_kredit)";
  params.push(batas);
  return db.query<BarisAkunRow>(
    `SELECT s.id::text AS id, s.akun_id::text AS akun_id, a.kode, a.nama,
            s.cabang_id::text AS cabang_id,
            ${nilai}::numeric(20,2)::text AS nilai
       FROM saldo_akun_periode s
       JOIN akun a ON a.id = s.akun_id
      WHERE s.periode_id = $1 AND s.deleted_at IS NULL
        AND ${scope} AND ${akun} AND ${nilai} <> 0
      ORDER BY a.kode, s.cabang_id
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// The PUMK portfolio
// ---------------------------------------------------------------------------

/**
 * Statuses that still carry a live receivable. The same set
 * `pumk_akad_outstanding_idx` and modules/pumk's `STATUS_PIUTANG_AKTIF` use;
 * BELUM_CAIR has no money out yet, LUNAS and HAPUS_BUKU have none left.
 */
const STATUS_AKAD_HIDUP = ["AKTIF", "RESCHEDULED", "MACET"] as const;

export async function portofolioSubLedger(
  db: QueryRunner,
  l: Lingkup,
): Promise<PortofolioRow> {
  const params: unknown[] = [];
  const scope = daftar("a.cabang_id", l.cabangIds, params);
  const status = daftar("a.status", STATUS_AKAD_HIDUP, params);
  const rows = await db.query<PortofolioRow>(
    `SELECT coalesce(sum(a.outstanding_pokok), 0)::numeric(20,2)::text AS outstanding_pokok,
            count(*)::text AS jumlah_akad,
            count(DISTINCT a.mitra_id)::text AS jumlah_mitra
       FROM pumk_akad a
      WHERE a.deleted_at IS NULL AND ${scope} AND ${status}`,
    params,
  );
  return (
    rows[0] ?? { outstanding_pokok: "0.00", jumlah_akad: "0", jumlah_mitra: "0" }
  );
}

export async function portofolioSnapshot(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
): Promise<PortofolioRow> {
  const params: unknown[] = [periodeId];
  const scope = daftar("k.cabang_id", l.cabangIds, params);
  const rows = await db.query<PortofolioRow>(
    `SELECT coalesce(sum(k.outstanding_pokok), 0)::numeric(20,2)::text AS outstanding_pokok,
            count(*)::text AS jumlah_akad,
            count(DISTINCT k.mitra_id)::text AS jumlah_mitra
       FROM kolektibilitas_snapshot k
      WHERE k.periode_id = $1 AND k.deleted_at IS NULL AND ${scope}`,
    params,
  );
  return (
    rows[0] ?? { outstanding_pokok: "0.00", jumlah_akad: "0", jumlah_mitra: "0" }
  );
}

export function barisAkadHidup(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisAkadRow[]> {
  const params: unknown[] = [];
  const scope = daftar("a.cabang_id", l.cabangIds, params);
  const status = daftar("a.status", STATUS_AKAD_HIDUP, params);
  params.push(batas);
  return db.query<BarisAkadRow>(
    `SELECT a.id::text AS id, a.no_akad, a.cabang_id::text AS cabang_id,
            a.mitra_id::text AS mitra_id, m.nama_lengkap AS nama_mitra,
            a.status, a.tanggal_akad::text AS tanggal_akad,
            a.outstanding_pokok::numeric(20,2)::text AS outstanding_pokok,
            a.outstanding_jasa::numeric(20,2)::text AS outstanding_jasa
       FROM pumk_akad a
       JOIN mitra m ON m.id = a.mitra_id
      WHERE a.deleted_at IS NULL AND ${scope} AND ${status}
      ORDER BY a.outstanding_pokok DESC, a.no_akad
      LIMIT $${params.length}`,
    params,
  );
}

export function barisSnapshot(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
  kelas: string | null,
  batas: number,
): Promise<BarisSnapshotRow[]> {
  const params: unknown[] = [periodeId];
  const scope = daftar("k.cabang_id", l.cabangIds, params);
  let filterKelas = "";
  if (kelas !== null) {
    params.push(kelas);
    filterKelas = ` AND k.kolektibilitas = $${params.length}`;
  }
  params.push(batas);
  return db.query<BarisSnapshotRow>(
    `SELECT k.id::text AS id, k.akad_id::text AS akad_id, a.no_akad,
            k.cabang_id::text AS cabang_id, k.mitra_id::text AS mitra_id,
            m.nama_lengkap AS nama_mitra, k.kolektibilitas,
            k.hari_tunggakan::text AS hari_tunggakan,
            k.outstanding_pokok::numeric(20,2)::text AS outstanding_pokok
       FROM kolektibilitas_snapshot k
       JOIN pumk_akad a ON a.id = k.akad_id
       JOIN mitra m ON m.id = k.mitra_id
      WHERE k.periode_id = $1 AND k.deleted_at IS NULL AND ${scope}${filterKelas}
      ORDER BY k.outstanding_pokok DESC, a.no_akad
      LIMIT $${params.length}`,
    params,
  );
}

export function ringkasKolektibilitas(
  db: QueryRunner,
  l: Lingkup,
  periodeId: string,
): Promise<RingkasKelasRow[]> {
  const params: unknown[] = [periodeId];
  const scope = daftar("k.cabang_id", l.cabangIds, params);
  return db.query<RingkasKelasRow>(
    `SELECT k.kolektibilitas,
            count(*)::text AS jumlah_akad,
            coalesce(sum(k.outstanding_pokok), 0)::numeric(20,2)::text AS outstanding_pokok
       FROM kolektibilitas_snapshot k
      WHERE k.periode_id = $1 AND k.deleted_at IS NULL AND ${scope}
      GROUP BY k.kolektibilitas`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Collection ratio
// ---------------------------------------------------------------------------

/**
 * "Tingkat Pengembalian": of what fell due IN THIS MONTH, how much has been
 * collected.
 *
 * BOTH LEGS COME FROM THE SAME ROWS. `pumk_jadwal_angsuran` carries the amount
 * due (`total`) and the amount collected against that instalment
 * (`pokok_terbayar + jasa_terbayar`, kept by modules/angsuran and bounded above
 * by `pumk_jadwal_terbayar_ck`). Taking the numerator from `pumk_angsuran`
 * instead would compare money received in the month against instalments due in
 * the month, which are two different populations: a partner paying three months
 * of arrears in one go would push the ratio above 100 percent in a month whose
 * own instalments went unpaid.
 *
 * `is_active_version` only: a rescheduled instalment is superseded and its
 * replacement carries the obligation (invariant 8).
 *
 * THERE IS NO FROZEN ARTEFACT FOR THIS ONE, and the service says so by
 * reporting `sumber: "SUB_LEDGER"` for a CLOSED period as well as an OPEN one.
 * `saldo_akun_periode` freezes accounts and `kolektibilitas_snapshot` freezes
 * the portfolio; neither freezes a schedule row, so a reschedule can still move
 * a past month's denominator. That is a stated limitation, not a silent one.
 */
export async function pengembalian(
  db: QueryRunner,
  l: Lingkup,
  dari: string,
  sampai: string,
): Promise<PengembalianRow> {
  const params: unknown[] = [dari, sampai];
  const scope = daftar("a.cabang_id", l.cabangIds, params);
  const rows = await db.query<PengembalianRow>(
    `SELECT coalesce(sum(j.total), 0)::numeric(20,2)::text AS jatuh_tempo,
            coalesce(sum(j.pokok_terbayar + j.jasa_terbayar), 0)::numeric(20,2)::text AS terbayar,
            count(*)::text AS jumlah_baris
       FROM pumk_jadwal_angsuran j
       JOIN pumk_akad a ON a.id = j.akad_id
      WHERE j.is_active_version AND j.deleted_at IS NULL AND a.deleted_at IS NULL
        AND j.tanggal_jatuh_tempo BETWEEN $1::date AND $2::date
        AND ${scope}`,
    params,
  );
  return rows[0] ?? { jatuh_tempo: "0.00", terbayar: "0.00", jumlah_baris: "0" };
}

export function barisPengembalian(
  db: QueryRunner,
  l: Lingkup,
  dari: string,
  sampai: string,
  batas: number,
): Promise<BarisJadwalRow[]> {
  const params: unknown[] = [dari, sampai];
  const scope = daftar("a.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisJadwalRow>(
    `SELECT j.id::text AS id, j.akad_id::text AS akad_id, a.no_akad,
            a.cabang_id::text AS cabang_id, j.angsuran_ke::text AS angsuran_ke,
            j.tanggal_jatuh_tempo::text AS tanggal_jatuh_tempo,
            j.total::numeric(20,2)::text AS total,
            (j.pokok_terbayar + j.jasa_terbayar)::numeric(20,2)::text AS terbayar,
            j.status
       FROM pumk_jadwal_angsuran j
       JOIN pumk_akad a ON a.id = j.akad_id
      WHERE j.is_active_version AND j.deleted_at IS NULL AND a.deleted_at IS NULL
        AND j.tanggal_jatuh_tempo BETWEEN $1::date AND $2::date
        AND ${scope}
      ORDER BY j.tanggal_jatuh_tempo, a.no_akad, j.angsuran_ke
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// The RKA baseline's lines
// ---------------------------------------------------------------------------
//
// WHICH document is the baseline is modules/rka's answer, reached through
// `PorterRkaDashboard`. What is below is arithmetic on the LINES of the
// document that module already named, which is why it is a query here and not
// a second opinion about the budget.

export async function anggaranBulan(
  db: QueryRunner,
  rkaId: string,
  bulan: number,
): Promise<AnggaranRow> {
  const rows = await db.query<AnggaranRow>(
    `SELECT coalesce(sum(d.jumlah_anggaran), 0)::numeric(20,2)::text AS total,
            count(*)::text AS jumlah_baris
       FROM rka_detail d
      WHERE d.rka_id = $1 AND d.deleted_at IS NULL AND d.bulan = $2`,
    [rkaId, bulan],
  );
  return rows[0] ?? { total: "0.00", jumlah_baris: "0" };
}

/**
 * Does the baseline carry ANY line at all?
 *
 * Asked so `ANGGARAN_TIDAK_PER_BULAN` can be distinguished from "the budget for
 * this month is genuinely zero". `rka_detail.bulan` is nullable by design (an
 * annual figure with no monthly breakdown), and a page that showed 0.00 for a
 * branch whose whole year IS budgeted would be reporting a data-entry
 * convention as a management fact.
 */
export async function adaBarisAnggaran(db: QueryRunner, rkaId: string): Promise<boolean> {
  const rows = await db.query<HitungRow>(
    `SELECT count(*)::text AS n
       FROM rka_detail d
      WHERE d.rka_id = $1 AND d.deleted_at IS NULL`,
    [rkaId],
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

export function barisAnggaran(
  db: QueryRunner,
  rkaId: string,
  bulan: number,
  batas: number,
): Promise<BarisAnggaranRow[]> {
  return db.query<BarisAnggaranRow>(
    `SELECT d.id::text AS id, d.uraian, b.nama AS bidang, d.bulan::text AS bulan,
            d.jumlah_anggaran::numeric(20,2)::text AS jumlah_anggaran
       FROM rka_detail d
       LEFT JOIN bidang_non_pumk b ON b.id = d.bidang_id
      WHERE d.rka_id = $1 AND d.deleted_at IS NULL AND d.bulan = $2
      ORDER BY b.nama NULLS LAST, d.uraian
      LIMIT $3`,
    [rkaId, bulan, batas],
  );
}

// ---------------------------------------------------------------------------
// The work queue (spec 11 panel 7)
// ---------------------------------------------------------------------------
//
// A COUNT OF DOCUMENTS PARKED IN A STATE, and nothing more. The states are
// modules/pumk's and modules/nonpumk's `TRANSISI_SAH` tables read as data (the
// service holds the map); this file only counts rows by `status`, so a state
// machine change is a one-line edit THERE and not a query rewrite here.

export function antrianPumk(db: QueryRunner, l: Lingkup): Promise<AntrianRow[]> {
  const params: unknown[] = [];
  const scope = daftar("p.cabang_id", l.cabangIds, params);
  return db.query<AntrianRow>(
    `SELECT p.status, count(*)::text AS n
       FROM pumk_proposal p
      WHERE p.deleted_at IS NULL AND ${scope}
      GROUP BY p.status`,
    params,
  );
}

export function antrianNonPumk(db: QueryRunner, l: Lingkup): Promise<AntrianRow[]> {
  const params: unknown[] = [];
  const scope = daftar("p.cabang_id", l.cabangIds, params);
  return db.query<AntrianRow>(
    `SELECT p.status, count(*)::text AS n
       FROM nonpumk_proposal p
      WHERE p.deleted_at IS NULL AND ${scope}
      GROUP BY p.status`,
    params,
  );
}

export function barisAntrianPumk(
  db: QueryRunner,
  l: Lingkup,
  status: readonly string[],
  batas: number,
): Promise<BarisProposalRow[]> {
  const params: unknown[] = [];
  const scope = daftar("p.cabang_id", l.cabangIds, params);
  const st = daftar("p.status", status, params);
  params.push(batas);
  return db.query<BarisProposalRow>(
    `SELECT p.id::text AS id, p.no_proposal, p.cabang_id::text AS cabang_id,
            p.tanggal_proposal::text AS tanggal_proposal,
            m.nama_lengkap AS label, p.status,
            p.jumlah_diajukan::numeric(20,2)::text AS nilai
       FROM pumk_proposal p
       JOIN mitra m ON m.id = p.mitra_id
      WHERE p.deleted_at IS NULL AND ${scope} AND ${st}
      ORDER BY p.tanggal_proposal, p.no_proposal
      LIMIT $${params.length}`,
    params,
  );
}

export function barisAntrianNonPumk(
  db: QueryRunner,
  l: Lingkup,
  status: readonly string[],
  batas: number,
): Promise<BarisProposalRow[]> {
  const params: unknown[] = [];
  const scope = daftar("p.cabang_id", l.cabangIds, params);
  const st = daftar("p.status", status, params);
  params.push(batas);
  return db.query<BarisProposalRow>(
    `SELECT p.id::text AS id, p.no_proposal, p.cabang_id::text AS cabang_id,
            p.tanggal_proposal::text AS tanggal_proposal,
            p.judul_program AS label, p.status,
            coalesce(p.jumlah_disetujui, p.jumlah_diajukan)::numeric(20,2)::text AS nilai
       FROM nonpumk_proposal p
      WHERE p.deleted_at IS NULL AND ${scope} AND ${st}
      ORDER BY p.tanggal_proposal, p.no_proposal
      LIMIT $${params.length}`,
    params,
  );
}
