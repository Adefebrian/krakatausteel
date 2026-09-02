// Every statement the tools engine issues, in one file. No business rules live
// here; the service authorises and shapes, the repo reads. NOTHING IN THIS FILE
// WRITES: there is no INSERT, UPDATE or DELETE anywhere below, which is what
// makes "these endpoints diagnose, they never repair" a property of the code
// rather than a promise in a comment.
//
// THE PREDICATES ARE COPIED FROM apps/api/src/seed/demo-dunia/periksa.ts.
// That file is spec 9.6 implemented as SQL and the demo seed fails when one of
// its checks returns a non-zero count. Re-deriving them here would give the
// system two definitions of "the books are intact". Each function below names
// the seed check it mirrors and every deviation is a SCOPE clause, never a
// change to what counts as broken. See ./contract.ts's header for the two
// deliberate differences and why they are deliberate.
//
// DRIVER FACTS THIS FILE IS BUILT AROUND (see modules/jurnal/repo.ts, which
// states them at length):
//   - a JS array binds as a comma-joined string, so `= ANY($n::uuid[])` fails
//     with 22P02. Branch scoping below therefore builds an explicit
//     placeholder list.
//   - DATE and TIMESTAMPTZ come back as JS `Date`, so every one of them is
//     selected `::text`.
//   - `coalesce(sum(x), 0)` comes back as '0', not '0.00'. Every money value is
//     cast `::numeric(20,2)` BEFORE `::text`, or it fails `POLA_UANG` in the
//     service and the failure surfaces three layers from its cause.
import type { QueryRunner } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Branch scoping
// ---------------------------------------------------------------------------

export interface Lingkup {
  bumnId: string;
  /**
   * Empty = no branch restriction (Admin Pusat, Auditor). Non-empty = exactly
   * these branches, which the SERVICE resolved from the session and never from
   * the request.
   */
  cabangIds: readonly string[];
}

/**
 * `column IN ($n, $n+1, ...)`, or `TRUE` when unrestricted. Explicit
 * placeholders rather than `= ANY($n::uuid[])`, per this file's driver notes.
 */
function filterCabang(
  kolom: string,
  cabangIds: readonly string[],
  params: unknown[],
): string {
  if (cabangIds.length === 0) return "TRUE";
  const mulai = params.length + 1;
  params.push(...cabangIds);
  const tempat = cabangIds.map((_, i) => `$${mulai + i}`).join(", ");
  return `${kolom} IN (${tempat})`;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface HitunganBaris {
  n: string;
}

export interface BarisJurnalRusak {
  jurnal_id: string;
  no_jurnal: string;
  cabang_id: string | null;
  status: string;
  tanggal_transaksi: string;
  jumlah_baris: string;
  total_debit_baris: string;
  total_kredit_baris: string;
  selisih: string;
}

export interface BarisJadwalRusak {
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  versi: string;
  pokok_pinjaman: string;
  total_pokok_jadwal: string;
  selisih: string;
}

export interface BarisSnapshotGanda {
  periode_id: string;
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  tahun: string;
  bulan: string;
  jumlah: string;
}

export interface BarisRekonRusak {
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  mitra_id: string;
  nama_mitra: string;
  status: string;
  saldo_sub_ledger: string;
  saldo_buku_besar: string;
  selisih: string;
}

export interface BarisTanggaRusak {
  id: string;
  kelas_kode: string;
  hari_min: string;
  hari_max: string | null;
  berikut: string | null;
}

export interface BarisDraftDiClosed {
  jurnal_id: string;
  no_jurnal: string;
  cabang_id: string;
  tahun: string;
  bulan: string;
  tanggal_transaksi: string;
  total_debit: string;
}

export interface BarisOutstandingNegatif {
  akad_id: string;
  no_akad: string;
  cabang_id: string;
  outstanding_pokok: string;
  outstanding_jasa: string;
}

export interface TotalNeracaSaldo {
  debit: string;
  kredit: string;
  selisih: string;
  jumlah_jurnal: string;
}

export interface AkunPiutangBaris {
  akun_id: string;
  kode: string;
}

export interface BarisPiutangJasaKredit {
  periode_id: string;
  bulan: string;
  tanggal_akhir: string;
  saldo: string;
}

export interface CabangBaris {
  id: string;
  kode: string;
  nama: string;
}

export interface RingkasanCabangBaris {
  cabang_id: string;
  kode: string;
  nama: string;
  jumlah_akad: string;
  jumlah_akad_selisih: string;
  total_sub_ledger: string;
  total_buku_besar: string;
  total_selisih: string;
}

// ---------------------------------------------------------------------------
// Check 1 -- v_integritas_jurnal
// Seed: "v_integritas_jurnal (jurnal tidak balance / kurang baris)"
// ---------------------------------------------------------------------------

const DARI_JURNAL_RUSAK = `
  FROM v_integritas_jurnal v
  JOIN jurnal j ON j.id = v.jurnal_id
 WHERE j.bumn_id = $1`;

export async function hitungJurnalRusak(db: QueryRunner, l: Lingkup): Promise<number> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("v.cabang_id", l.cabangIds, params);
  const rows = await db.query<HitunganBaris>(
    `SELECT count(*)::text AS n ${DARI_JURNAL_RUSAK} AND ${scope}`,
    params,
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_jurnalRusak(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisJurnalRusak[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("v.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisJurnalRusak>(
    `SELECT v.jurnal_id::text AS jurnal_id,
            v.no_jurnal,
            v.cabang_id::text AS cabang_id,
            v.status,
            v.tanggal_transaksi::text AS tanggal_transaksi,
            v.jumlah_baris::text AS jumlah_baris,
            v.total_debit_baris::numeric(20,2)::text AS total_debit_baris,
            v.total_kredit_baris::numeric(20,2)::text AS total_kredit_baris,
            v.selisih::numeric(20,2)::text AS selisih
       ${DARI_JURNAL_RUSAK} AND ${scope}
      ORDER BY abs(v.selisih) DESC, v.tanggal_transaksi DESC
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Check 2 -- v_integritas_jadwal
// Seed: "v_integritas_jadwal (total pokok jadwal <> pokok akad)"
// ---------------------------------------------------------------------------

const DARI_JADWAL_RUSAK = `
  FROM v_integritas_jadwal v
  JOIN cabang c ON c.id = v.cabang_id
 WHERE c.bumn_id = $1`;

export async function hitungJadwalRusak(db: QueryRunner, l: Lingkup): Promise<number> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("v.cabang_id", l.cabangIds, params);
  const rows = await db.query<HitunganBaris>(
    `SELECT count(*)::text AS n ${DARI_JADWAL_RUSAK} AND ${scope}`,
    params,
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_jadwalRusak(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisJadwalRusak[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("v.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisJadwalRusak>(
    `SELECT v.akad_id::text AS akad_id,
            v.no_akad,
            v.cabang_id::text AS cabang_id,
            v.versi::text AS versi,
            v.pokok_pinjaman::numeric(20,2)::text AS pokok_pinjaman,
            v.total_pokok_jadwal::numeric(20,2)::text AS total_pokok_jadwal,
            v.selisih::numeric(20,2)::text AS selisih
       ${DARI_JADWAL_RUSAK} AND ${scope}
      ORDER BY abs(v.selisih) DESC, v.no_akad
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Check 3 -- v_integritas_snapshot
// Seed: "v_integritas_snapshot (snapshot kolektibilitas ganda)"
//
// The view carries only (periode_id, akad_id, jumlah), so the branch comes from
// the akad and the tenant from the period. Both joins NARROW the population;
// neither touches the HAVING count(*) > 1 that defines a duplicate.
// ---------------------------------------------------------------------------

const DARI_SNAPSHOT_GANDA = `
  FROM v_integritas_snapshot v
  JOIN periode p ON p.id = v.periode_id
  JOIN pumk_akad a ON a.id = v.akad_id
 WHERE p.bumn_id = $1`;

export async function hitungSnapshotGanda(db: QueryRunner, l: Lingkup): Promise<number> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("a.cabang_id", l.cabangIds, params);
  const rows = await db.query<HitunganBaris>(
    `SELECT count(*)::text AS n ${DARI_SNAPSHOT_GANDA} AND ${scope}`,
    params,
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_snapshotGanda(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisSnapshotGanda[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("a.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisSnapshotGanda>(
    `SELECT v.periode_id::text AS periode_id,
            v.akad_id::text AS akad_id,
            a.no_akad,
            a.cabang_id::text AS cabang_id,
            p.tahun::text AS tahun,
            p.bulan::text AS bulan,
            v.jumlah::text AS jumlah
       ${DARI_SNAPSHOT_GANDA} AND ${scope}
      ORDER BY v.jumlah DESC, p.tahun DESC, p.bulan DESC
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Check 4 -- v_rekonsiliasi_piutang, spec 8.4 check 10
// Seed: "v_rekonsiliasi_piutang (sub ledger piutang vs buku besar)"
//
// Shared with `rekonsiliasiPiutang` below on purpose: the health check row and
// the reconciliation page must not be able to disagree about how many akad are
// wrong.
// ---------------------------------------------------------------------------

const DARI_REKON = `
  FROM v_rekonsiliasi_piutang r
  JOIN cabang c ON c.id = r.cabang_id
  JOIN mitra m ON m.id = r.mitra_id
 WHERE c.bumn_id = $1`;

export async function hitungRekonRusak(db: QueryRunner, l: Lingkup): Promise<number> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("r.cabang_id", l.cabangIds, params);
  const rows = await db.query<HitunganBaris>(
    `SELECT count(*)::text AS n ${DARI_REKON} AND ${scope} AND r.selisih <> 0`,
    params,
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_rekon(
  db: QueryRunner,
  l: Lingkup,
  opsi: { hanyaSelisih: boolean; batas: number },
): Promise<BarisRekonRusak[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("r.cabang_id", l.cabangIds, params);
  params.push(opsi.batas);
  return db.query<BarisRekonRusak>(
    `SELECT r.akad_id::text AS akad_id,
            r.no_akad,
            r.cabang_id::text AS cabang_id,
            r.mitra_id::text AS mitra_id,
            m.nama_lengkap AS nama_mitra,
            r.status,
            r.saldo_sub_ledger::numeric(20,2)::text AS saldo_sub_ledger,
            r.saldo_buku_besar::numeric(20,2)::text AS saldo_buku_besar,
            r.selisih::numeric(20,2)::text AS selisih
       ${DARI_REKON} AND ${scope}${opsi.hanyaSelisih ? " AND r.selisih <> 0" : ""}
      ORDER BY abs(r.selisih) DESC, r.no_akad
      LIMIT $${params.length}`,
    params,
  );
}

/** Per branch totals for the reconciliation page. Same view, same predicate. */
export async function ringkasanCabangRekon(
  db: QueryRunner,
  l: Lingkup,
): Promise<RingkasanCabangBaris[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("r.cabang_id", l.cabangIds, params);
  return db.query<RingkasanCabangBaris>(
    `SELECT r.cabang_id::text AS cabang_id,
            c.kode,
            c.nama,
            count(*)::text AS jumlah_akad,
            count(*) FILTER (WHERE r.selisih <> 0)::text AS jumlah_akad_selisih,
            coalesce(sum(r.saldo_sub_ledger), 0)::numeric(20,2)::text AS total_sub_ledger,
            coalesce(sum(r.saldo_buku_besar), 0)::numeric(20,2)::text AS total_buku_besar,
            coalesce(sum(r.selisih), 0)::numeric(20,2)::text AS total_selisih
       FROM v_rekonsiliasi_piutang r
       JOIN cabang c ON c.id = r.cabang_id
      WHERE c.bumn_id = $1 AND ${scope}
      GROUP BY r.cabang_id, c.kode, c.nama
      ORDER BY c.kode`,
    params,
  );
}

/**
 * The receivable account the reconciliation runs against. Read from
 * `event_jurnal_mapping`, exactly as `v_rekonsiliasi_piutang` itself does, so
 * the page names the account the view actually used and never a literal.
 */
export async function akunPiutang(
  db: QueryRunner,
  bumnId: string,
): Promise<AkunPiutangBaris | null> {
  const rows = await db.query<AkunPiutangBaris>(
    `SELECT e.akun_debit_id::text AS akun_id, a.kode
       FROM event_jurnal_mapping e
       JOIN akun a ON a.id = e.akun_debit_id
      WHERE e.bumn_id = $1
        AND e.event_code = 'PENCAIRAN_PUMK'
        AND e.aktif
        AND e.deleted_at IS NULL
      LIMIT 1`,
    [bumnId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Check 5 -- the kolektibilitas ladder
// Seed: "tangga kolektibilitas (tanpa celah, tanpa tumpang tindih)"
//
// Migration 0004 leaves this to the spec 9.6 tool on purpose: an exclusion
// constraint would block a valid mid-edit state in the configuration screen.
//
// The CTE selects `id` and `kelas_kode` in ADDITION to the seed's three
// columns so a failing junction can be pointed at. The window frame
// (`ORDER BY hari_min`) and the WHERE predicate are byte-for-byte the seed's.
//
// NOT BRANCH BOUND: `kolektibilitas_range` is configuration for the whole
// entity, resolved bumn-scoped-then-global, so there is nothing to scope by
// branch and `terikatCabang` on the catalogue entry says so.
// ---------------------------------------------------------------------------

const TANGGA_CTE = `
  WITH r AS (
    SELECT id, kelas_kode, hari_min, hari_max,
           lead(hari_min) OVER (ORDER BY hari_min) AS berikut
      FROM kolektibilitas_range
     WHERE deleted_at IS NULL AND (bumn_id IS NULL OR bumn_id = $1::uuid)
  )`;

const TANGGA_PREDIKAT = `
  (hari_max IS NULL AND berikut IS NOT NULL)
  OR (hari_max IS NOT NULL AND berikut IS NOT NULL AND berikut <> hari_max + 1)`;

export async function hitungTanggaRusak(db: QueryRunner, l: Lingkup): Promise<number> {
  const rows = await db.query<HitunganBaris>(
    `${TANGGA_CTE} SELECT count(*)::text AS n FROM r WHERE ${TANGGA_PREDIKAT}`,
    [l.bumnId],
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_tanggaRusak(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisTanggaRusak[]> {
  return db.query<BarisTanggaRusak>(
    `${TANGGA_CTE}
     SELECT id::text AS id, kelas_kode,
            hari_min::text AS hari_min,
            hari_max::text AS hari_max,
            berikut::text AS berikut
       FROM r WHERE ${TANGGA_PREDIKAT}
      ORDER BY hari_min
      LIMIT $2`,
    [l.bumnId, batas],
  );
}

// ---------------------------------------------------------------------------
// Check 6 -- DRAFT journals inside a CLOSED period
// Seed: "tidak ada jurnal DRAFT di periode CLOSED"
// ---------------------------------------------------------------------------

const DARI_DRAFT_CLOSED = `
  FROM jurnal j
  JOIN periode p ON p.id = j.periode_id
 WHERE j.status = 'DRAFT' AND j.deleted_at IS NULL AND p.status = 'CLOSED'
   AND j.bumn_id = $1`;

export async function hitungDraftDiClosed(db: QueryRunner, l: Lingkup): Promise<number> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("j.cabang_id", l.cabangIds, params);
  const rows = await db.query<HitunganBaris>(
    `SELECT count(*)::text AS n ${DARI_DRAFT_CLOSED} AND ${scope}`,
    params,
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_draftDiClosed(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisDraftDiClosed[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("j.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisDraftDiClosed>(
    `SELECT j.id::text AS jurnal_id,
            j.no_jurnal,
            j.cabang_id::text AS cabang_id,
            p.tahun::text AS tahun,
            p.bulan::text AS bulan,
            j.tanggal_transaksi::text AS tanggal_transaksi,
            j.total_debit::numeric(20,2)::text AS total_debit
       ${DARI_DRAFT_CLOSED} AND ${scope}
      ORDER BY p.tahun DESC, p.bulan DESC, j.no_jurnal
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Check 7 -- negative outstanding, invariant 10
// Seed: "tidak ada akad dengan outstanding negatif (invarian 10)"
//
// Also enforced by `pumk_akad_outstanding_pokok_check`, so this cannot fail on
// the shipped schema. Kept for the reason the seed keeps it; the catalogue
// entry carries `dijagaDatabase: true` so the page explains itself.
// ---------------------------------------------------------------------------

const DARI_OUTSTANDING_NEGATIF = `
  FROM pumk_akad a
  JOIN cabang c ON c.id = a.cabang_id
 WHERE a.deleted_at IS NULL
   AND (a.outstanding_pokok < 0 OR a.outstanding_jasa < 0)
   AND c.bumn_id = $1`;

export async function hitungOutstandingNegatif(
  db: QueryRunner,
  l: Lingkup,
): Promise<number> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("a.cabang_id", l.cabangIds, params);
  const rows = await db.query<HitunganBaris>(
    `SELECT count(*)::text AS n ${DARI_OUTSTANDING_NEGATIF} AND ${scope}`,
    params,
  );
  return Number(rows[0]?.n ?? "0");
}

export async function baris_outstandingNegatif(
  db: QueryRunner,
  l: Lingkup,
  batas: number,
): Promise<BarisOutstandingNegatif[]> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("a.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisOutstandingNegatif>(
    `SELECT a.id::text AS akad_id,
            a.no_akad,
            a.cabang_id::text AS cabang_id,
            a.outstanding_pokok::numeric(20,2)::text AS outstanding_pokok,
            a.outstanding_jasa::numeric(20,2)::text AS outstanding_jasa
       ${DARI_OUTSTANDING_NEGATIF} AND ${scope}
      ORDER BY a.outstanding_pokok, a.no_akad
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Check 8 -- the trial balance
// Seed: "buku besar seimbang (total debit = total kredit, seluruh jurnal POSTED)"
//
// READ FROM `v_ledger_baris`, not from a POSTED-only filter. ADR 0010 and
// migrations/0018: a REVERSED journal's lines are still ledger entries and are
// offset by its reversal's lines, and every balance read in this repository
// must use the shipped view rather than restate the predicate. See
// ./contract.ts's header for why this is the one deliberate divergence from
// the seed and how the test pins it.
// ---------------------------------------------------------------------------

export async function totalNeracaSaldo(
  db: QueryRunner,
  l: Lingkup,
): Promise<TotalNeracaSaldo> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("l.cabang_id", l.cabangIds, params);
  const rows = await db.query<TotalNeracaSaldo>(
    `SELECT coalesce(sum(l.debit), 0)::numeric(20,2)::text AS debit,
            coalesce(sum(l.kredit), 0)::numeric(20,2)::text AS kredit,
            (coalesce(sum(l.debit), 0) - coalesce(sum(l.kredit), 0))::numeric(20,2)::text AS selisih,
            count(DISTINCT l.jurnal_id)::text AS jumlah_jurnal
       FROM v_ledger_baris l
      WHERE l.bumn_id = $1 AND ${scope}`,
    params,
  );
  return (
    rows[0] ?? { debit: "0.00", kredit: "0.00", selisih: "0.00", jumlah_jurnal: "0" }
  );
}

/**
 * The SEED'S OWN predicate for check 8, POSTED only, offered beside the
 * ledger reading rather than instead of it.
 *
 * Exists so ./tools-integritas.test.ts can assert the two agree on the
 * DIFFERENCE on a world that contains a reversal, which is what makes the
 * divergence in ./contract.ts's header a stated, proven-immaterial one instead
 * of a silent fork. Not reachable from any route.
 */
export async function totalNeracaSaldoPostedSaja(
  db: QueryRunner,
  l: Lingkup,
): Promise<TotalNeracaSaldo> {
  const params: unknown[] = [l.bumnId];
  const scope = filterCabang("j.cabang_id", l.cabangIds, params);
  const rows = await db.query<TotalNeracaSaldo>(
    `SELECT coalesce(sum(b.debit), 0)::numeric(20,2)::text AS debit,
            coalesce(sum(b.kredit), 0)::numeric(20,2)::text AS kredit,
            (coalesce(sum(b.debit), 0) - coalesce(sum(b.kredit), 0))::numeric(20,2)::text AS selisih,
            count(DISTINCT j.id)::text AS jumlah_jurnal
       FROM jurnal_baris b
       JOIN jurnal j ON j.id = b.jurnal_id
      WHERE j.status = 'POSTED' AND j.deleted_at IS NULL AND b.deleted_at IS NULL
        AND j.bumn_id = $1 AND ${scope}`,
    params,
  );
  return (
    rows[0] ?? { debit: "0.00", kredit: "0.00", selisih: "0.00", jumlah_jurnal: "0" }
  );
}

// ---------------------------------------------------------------------------
// Check 9 -- Piutang Jasa Administrasi must never carry a credit balance
//
// NOT COPIED FROM THE SEED: the seed has no such check, which is exactly why
// this one exists. The 24 month demo world ran all 46 of the seed's checks
// green while Piutang Jasa Administrasi sat at roughly Rp -86.700.000, because
// the matching understatement of Pendapatan Jasa Administrasi kept the ledger
// in balance. Every check that looks for a DIFFERENCE was therefore blind to
// it: what was wrong was the classification, and only an account whose sign is
// known can catch that.
//
// An asset account with a credit balance is not a rounding problem, it is a
// posting rule pointing at the wrong leg. Reported PER BRANCH, because one
// branch running negative is invisible in an entity-wide total that another
// branch's debit balance covers.
//
// The account is resolved from `event_jurnal_mapping`, never from the literal
// '1.1.04': the chart is per tenant and configurable, and a hard-coded code
// would quietly check nothing on an entity that renumbered its accounts.
// ---------------------------------------------------------------------------

/**
 * The receivable this check watches: the DEBIT leg of the monthly accrual, so
 * the check follows whatever account the accrual actually posts to.
 */
export async function akunPiutangJasa(
  db: QueryRunner,
  bumnId: string,
): Promise<AkunPiutangBaris | null> {
  const rows = await db.query<AkunPiutangBaris>(
    `SELECT e.akun_debit_id::text AS akun_id, a.kode
       FROM event_jurnal_mapping e
       JOIN akun a ON a.id = e.akun_debit_id
      WHERE e.bumn_id = $1
        AND e.event_code = 'AKRUAL_JASA_ADM'
        AND e.aktif
        AND e.deleted_at IS NULL
      LIMIT 1`,
    [bumnId],
  );
  return rows[0] ?? null;
}

/**
 * One row per MONTH END at which the account carried a credit balance,
 * earliest first, with the cumulative balance as at that date.
 *
 * Per month end rather than as-at-today, exactly as the seed does it: the
 * shipped defect drifted negative gradually, so a single current-balance check
 * would have reported one number without ever saying which month broke, and a
 * defect already corrected in a later month would hide entirely.
 *
 * Reads `v_ledger_baris` rather than a POSTED-only filter, per ADR 0010: a
 * reversal's lines are ledger entries too, and dropping them would invent a
 * credit balance the books do not have.
 *
 * The one deviation from the seed's predicate is the branch scope, which is
 * this module's rule for every check: scope narrows WHICH rows are judged and
 * never WHAT counts as broken.
 */
export async function barisPiutangJasaKredit(
  db: QueryRunner,
  l: Lingkup,
  akunId: string,
  batas: number,
): Promise<BarisPiutangJasaKredit[]> {
  const params: unknown[] = [l.bumnId, akunId];
  const scope = filterCabang("v.cabang_id", l.cabangIds, params);
  params.push(batas);
  return db.query<BarisPiutangJasaKredit>(
    `SELECT p.id::text AS periode_id,
            p.tahun || '-' || lpad(p.bulan::text, 2, '0') AS bulan,
            p.tanggal_akhir::text AS tanggal_akhir,
            s.saldo::numeric(20,2)::text AS saldo
       FROM periode p
       JOIN LATERAL (
         SELECT coalesce(sum(v.nilai_debit_positif), 0) AS saldo
           FROM v_ledger_baris v
          WHERE v.bumn_id = $1
            AND v.akun_id = $2
            AND v.tanggal_transaksi <= p.tanggal_akhir
            AND ${scope}
       ) s ON true
      WHERE p.bumn_id = $1 AND p.deleted_at IS NULL AND s.saldo < 0
      ORDER BY p.tahun, p.bulan
      LIMIT $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Reference reads
// ---------------------------------------------------------------------------

/** One branch, for validating a `cabangId` filter against the tenant. */
export async function cabang(
  db: QueryRunner,
  bumnId: string,
  cabangId: string,
): Promise<CabangBaris | null> {
  const rows = await db.query<CabangBaris>(
    `SELECT id::text AS id, kode, nama
       FROM cabang
      WHERE id = $1 AND bumn_id = $2 AND deleted_at IS NULL`,
    [cabangId, bumnId],
  );
  return rows[0] ?? null;
}
