// The demo world: engines wired with a MOVABLE clock, plus every id the
// generator needs resolved once.
//
// WHY THIS IS ITS OWN COMPOSITION ROOT AND NOT `createApp`
// `createApp` builds the shipped app, and the shipped app takes its `jam` from
// the wall clock, which is correct for a server and useless here: this
// generator replays twenty four months, and a proposal timeline whose every
// transition is stamped "now" is a timeline that tells the demo audience
// nothing. Every engine below declares an injectable `jam` (see each module's
// *EngineDeps), so the generator owns one mutable instant and sets it to the
// business date before each call. That is the injectable-clock convention the
// engines already have, used rather than reinvented.
//
// WHAT IS NOT SUBSTITUTED: the engines themselves. Every proposal moves through
// the PUMK state machine, every rupiah is posted by `postingEvent`, every
// schedule comes from the instalment engine and every close runs the closing
// engine's own checklist. Spec 13's rule is that a seed producing an
// unbalanced balance sheet is worse than no seed at all, and the only way to
// keep that promise is to never write a `jurnal` row from here. Migration 0020
// and tools/check-boundaries.ts both refuse it anyway.
import type { DbPort } from "../../core/ports/db";
import { createAuditService, type AuditService } from "../../modules/audit";
import { createAngsuranModule, type AngsuranEngine } from "../../modules/angsuran";
import { createClosingModule, type ClosingEngine } from "../../modules/closing";
import { createJurnalModule, type JurnalEngine } from "../../modules/jurnal";
import { createLaporanModule, type LaporanEngine } from "../../modules/laporan";
import { createNonPumkModule, type NonPumkEngine } from "../../modules/nonpumk";
import { createPumkModule, type PumkEngine } from "../../modules/pumk";
import { createRkaModule, type RkaEngine } from "../../modules/rka";
import { PERMISSIONS_BY_ROLE, type RoleCode } from "../../modules/auth";
import { DEMO_BUMN_KODE, DEMO_PETUGAS_CABANG } from "../demo";
import { bulanDariIso, bulanTambah, hariTerakhir, saatDari, type Bulan } from "./acak";

/** A single mutable instant, shared by every engine in the world. */
export interface JamGeser {
  saat: Date;
  /** Points the world's clock at midday of an ISO business date. */
  ke(iso: string): void;
  now(): Date;
}

export function jamGeser(mulai: Date): JamGeser {
  const jam: JamGeser = {
    saat: mulai,
    ke(iso: string) {
      jam.saat = saatDari(iso);
    },
    now: () => jam.saat,
  };
  return jam;
}

export interface CabangDemo {
  id: string;
  kode: string;
  nama: string;
  isPusat: boolean;
}

export interface AktorDemo {
  userId: string;
  role: RoleCode;
  cabangId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own; Admin Pusat and Auditor see them all. */
  cabangDalamScope: readonly string[];
}

/** The one context shape every engine takes (they are structurally identical). */
export interface KonteksDemo {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  cabangDalamScope: readonly string[];
}

export interface PeriodeDemo {
  id: string;
  tahun: number;
  bulan: number;
  mulai: string;
  akhir: string;
  status: string;
}

export interface Dunia {
  db: DbPort;
  audit: AuditService;
  jam: JamGeser;
  jurnal: JurnalEngine;
  angsuran: AngsuranEngine;
  pumk: PumkEngine;
  nonpumk: NonPumkEngine;
  closing: ClosingEngine;
  rka: RkaEngine;
  laporan: LaporanEngine;

  bumnId: string;
  pusat: CabangDemo;
  /** The operational branches, in code order. No transactions live at pusat. */
  cabang: CabangDemo[];
  /** Every branch including pusat, keyed by code. */
  semuaCabang: Record<string, CabangDemo>;

  /** Per branch code: the maker / checker / approver trio and the branch admin. */
  petugas: Record<string, { maker: AktorDemo; checker: AktorDemo; approver: AktorDemo }>;
  adminPusat: AktorDemo;
  adminPusatLain: AktorDemo;
  /** karyawan id per branch code, used as the survey officer. */
  karyawan: Record<string, string>;

  /** akun id by kode, e.g. akun["1.1.02"]. */
  akun: Record<string, string>;
  sektor: Array<{ id: string; kode: string; nama: string }>;
  bidang: Array<{ id: string; kode: string; nama: string }>;
  sdg: Array<{ id: string; kode: string }>;
  kota: Array<{ id: string; nama: string }>;

  /** Oldest first. The last entry is the OPEN period, the current month. */
  periode: PeriodeDemo[];
  bulanBerjalan: Bulan;

  ctx(aktor: AktorDemo): KonteksDemo;
  log(line: string): void;
}

export interface OpsiDunia {
  db: DbPort;
  /** Wall clock. Injected so the whole world can be built at a fixed instant. */
  sekarang?: Date;
  /** How many monthly periods to build, the last of which stays OPEN. */
  bulanRiwayat?: number;
  log?: (line: string) => void;
}

export const BULAN_RIWAYAT_BAKU = 24;

/** Accounts the generator names directly. Every one is seeded by coa-inti.ts. */
export const AKUN_DIPAKAI = [
  "1.1.01", // Kas dan Setara Kas
  "1.1.02", // Bank Operasional TJSL
  "1.1.03", // Piutang Pinjaman Mitra Binaan
  "1.1.04", // Piutang Jasa Administrasi
  "1.1.05", // Penyisihan Penurunan Nilai Piutang
  "2.1.01", // Kelebihan Pembayaran Angsuran
  "3.1.01", // Aset Neto
  "4.1.01", // Pendapatan Alokasi Dana BUMN Pembina
  "4.1.02", // Pendapatan Jasa Administrasi Pinjaman
  "4.1.03", // Pendapatan Bunga Jasa Giro
  "4.1.04", // Pendapatan Lain lain
  "5.1.01", // Beban Penyisihan
  "5.1.02", // Beban Pembinaan Kemitraan
  "5.1.03", // Beban Penyaluran Non PUMK
  "5.1.04", // Beban Operasional
] as const;

function aktor(userId: string, role: RoleCode, cabangId: string, scope: readonly string[]): AktorDemo {
  return {
    userId,
    role,
    cabangId,
    permissions: PERMISSIONS_BY_ROLE[role],
    cabangDalamScope: scope,
  };
}

export async function bangunDunia(opsi: OpsiDunia): Promise<Dunia> {
  const db = opsi.db;
  const log = opsi.log ?? ((line: string) => console.log(line));
  const sekarang = opsi.sekarang ?? new Date();
  const jam = jamGeser(sekarang);
  const audit = createAuditService({ db });

  // ONE journal engine, handed to everyone. That is what invariant 11 rests
  // on: a second instance would be a second posting path.
  const jurnal = createJurnalModule({ db, audit, jam: jam.now });
  const angsuran = createAngsuranModule({ db, jurnal: jurnal.engine, jam: jam.now });
  const pumk = createPumkModule({
    db,
    angsuran: angsuran.engine,
    jurnal: jurnal.engine,
    jam: jam.now,
  });
  const nonpumk = createNonPumkModule({ db, jurnal: jurnal.engine, jam: jam.now });
  const closing = createClosingModule({ db, jurnal: jurnal.engine, audit, jam: jam.now });
  const rka = createRkaModule({ db, audit, jam: jam.now });
  const laporan = createLaporanModule({ db, jam: jam.now });

  const bumn = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM bumn WHERE kode = $1 AND deleted_at IS NULL`,
    [DEMO_BUMN_KODE],
  );
  const bumnId = bumn[0]?.id;
  if (!bumnId) {
    throw new Error(
      `BUMN ${DEMO_BUMN_KODE} tidak ada. Jalankan "bun run db:seed" (atau db:seed:dev) lebih dulu: ` +
        "generator ini menambah transaksi di atas dunia Fase 0, bukan menggantikannya.",
    );
  }

  const barisCabang = await db.query<{ id: string; kode: string; nama: string; is_pusat: boolean }>(
    `SELECT id::text AS id, kode, nama, is_pusat FROM cabang
      WHERE bumn_id = $1::uuid AND deleted_at IS NULL ORDER BY kode`,
    [bumnId],
  );
  const semuaCabang: Record<string, CabangDemo> = {};
  for (const c of barisCabang) {
    semuaCabang[c.kode] = { id: c.id, kode: c.kode, nama: c.nama, isPusat: c.is_pusat };
  }
  const pusat = Object.values(semuaCabang).find((c) => c.isPusat);
  if (!pusat) throw new Error("seed demo: tidak ada kantor pusat");
  const cabang = Object.values(semuaCabang)
    .filter((c) => !c.isPusat)
    .sort((a, b) => a.kode.localeCompare(b.kode));
  const semuaId = Object.values(semuaCabang).map((c) => c.id);

  const barisUser = await db.query<{ id: string; username: string; role: string; cabang_kode: string }>(
    `SELECT u.id::text AS id, u.username, r.kode AS role, c.kode AS cabang_kode
       FROM app_user u
       JOIN cabang c ON c.id = u.cabang_id
       JOIN user_role ur ON ur.user_id = u.id
       JOIN app_role r ON r.id = ur.role_id
      WHERE c.bumn_id = $1::uuid AND u.deleted_at IS NULL AND u.email LIKE '%@demo.tjsl.local'`,
    [bumnId],
  );
  const perUsername = new Map(barisUser.map((u) => [u.username, u]));
  const cari = (username: string): AktorDemo => {
    const u = perUsername.get(username);
    if (!u) throw new Error(`seed demo: akun "${username}" tidak ada; jalankan db:seed lebih dulu`);
    const cab = semuaCabang[u.cabang_kode];
    if (!cab) throw new Error(`seed demo: cabang ${u.cabang_kode} tidak ada`);
    const lintas = u.role === "ADMIN_PUSAT" || u.role === "AUDITOR";
    return aktor(u.id, u.role as RoleCode, cab.id, lintas ? semuaId : []);
  };

  const petugas: Dunia["petugas"] = {};
  for (const c of cabang) {
    const trio = DEMO_PETUGAS_CABANG[c.kode];
    if (!trio) throw new Error(`seed demo: cabang ${c.kode} tidak punya trio maker/checker/approver`);
    petugas[c.kode] = {
      maker: cari(trio.maker),
      checker: cari(trio.checker),
      approver: cari(trio.approver),
    };
  }

  const barisKaryawan = await db.query<{ id: string; kode: string }>(
    `SELECT DISTINCT ON (c.kode) k.id::text AS id, c.kode
       FROM karyawan k JOIN cabang c ON c.id = k.cabang_id
      WHERE c.bumn_id = $1::uuid AND k.deleted_at IS NULL AND k.aktif
      ORDER BY c.kode, k.nip`,
    [bumnId],
  );
  const karyawan: Record<string, string> = {};
  for (const k of barisKaryawan) karyawan[k.kode] = k.id;

  const barisAkun = await db.query<{ id: string; kode: string }>(
    `SELECT id::text AS id, kode FROM akun
      WHERE bumn_id = $1::uuid AND deleted_at IS NULL AND kode = ANY($2::text[])`,
    [bumnId, [...AKUN_DIPAKAI]],
  );
  const akun: Record<string, string> = {};
  for (const a of barisAkun) akun[a.kode] = a.id;
  const hilang = AKUN_DIPAKAI.filter((k) => !akun[k]);
  if (hilang.length > 0) {
    throw new Error(`seed demo: akun inti belum ada (${hilang.join(", ")}); jalankan db:seed lebih dulu`);
  }

  const sektor = await db.query<{ id: string; kode: string; nama: string }>(
    `SELECT id::text AS id, kode, nama FROM sektor_pumk
      WHERE bumn_id = $1::uuid AND deleted_at IS NULL AND aktif ORDER BY urutan, kode`,
    [bumnId],
  );
  const bidang = await db.query<{ id: string; kode: string; nama: string }>(
    `SELECT id::text AS id, kode, nama FROM bidang_non_pumk
      WHERE bumn_id = $1::uuid AND deleted_at IS NULL AND aktif ORDER BY urutan, kode`,
    [bumnId],
  );
  // `sdg` is keyed by `nomor` (1..17), not by a code column: spec 4.1 names the
  // seventeen goals by number, and master-program.ts seeds them that way.
  const sdg = await db.query<{ id: string; kode: string }>(
    `SELECT id::text AS id, nomor::text AS kode FROM sdg
      WHERE deleted_at IS NULL AND aktif ORDER BY nomor`,
  );
  if (sektor.length === 0 || bidang.length === 0 || sdg.length === 0) {
    throw new Error("seed demo: master program (sektor / bidang / SDG) kosong; jalankan db:seed lebih dulu");
  }

  const kota = await pastikanWilayah(db);

  const bulanBerjalan = bulanDariIso(sekarang.toISOString().slice(0, 10));
  const jumlah = opsi.bulanRiwayat ?? BULAN_RIWAYAT_BAKU;
  const periode = await pastikanPeriode(db, bumnId, bulanBerjalan, jumlah);

  const adminPusat = cari("adminpusat");
  const adminPusatLain = cari("adminpusat2");

  return {
    db,
    audit,
    jam,
    jurnal: jurnal.engine,
    angsuran: angsuran.engine,
    pumk: pumk.engine,
    nonpumk: nonpumk.engine,
    closing: closing.engine,
    rka: rka.engine,
    laporan: laporan.engine,
    bumnId,
    pusat,
    cabang,
    semuaCabang,
    petugas,
    adminPusat,
    adminPusatLain,
    karyawan,
    akun,
    sektor,
    bidang,
    sdg,
    kota,
    periode,
    bulanBerjalan,
    ctx: (a: AktorDemo) => ({
      userId: a.userId,
      cabangId: a.cabangId,
      bumnId,
      permissions: a.permissions,
      cabangDalamScope: a.cabangDalamScope,
    }),
    log,
  };
}

/**
 * Banten and five of its cities. Spec 9.6 lists wilayah as a CRUD master, and
 * `mitra.kota_id` is the dimension every demographic breakdown in spec 10 uses,
 * so a demo world without it shows "Belum diisi" in every regional column.
 * Idempotent on `kode_bps`.
 */
async function pastikanWilayah(db: DbPort): Promise<Array<{ id: string; nama: string }>> {
  const KOTA = [
    { kode: "3672", nama: "Kota Cilegon", tipe: "KOTA" },
    { kode: "3673", nama: "Kota Serang", tipe: "KOTA" },
    { kode: "3604", nama: "Kabupaten Serang", tipe: "KABUPATEN" },
    { kode: "3601", nama: "Kabupaten Pandeglang", tipe: "KABUPATEN" },
    { kode: "3602", nama: "Kabupaten Lebak", tipe: "KABUPATEN" },
  ] as const;

  return db.transaction(async (tx) => {
    const prov = await tx.query<{ id: string }>(
      `INSERT INTO provinsi (kode_bps, nama, aktif) VALUES ('36', 'Banten', true)
       ON CONFLICT (kode_bps) WHERE deleted_at IS NULL DO UPDATE SET nama = EXCLUDED.nama
       RETURNING id::text AS id`,
    );
    const provinsiId = prov[0]?.id;
    if (!provinsiId) throw new Error("seed demo: provinsi gagal dibuat");

    const hasil: Array<{ id: string; nama: string }> = [];
    for (const k of KOTA) {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO kota (provinsi_id, kode_bps, nama, tipe, aktif)
         VALUES ($1::uuid, $2, $3, $4, true)
         ON CONFLICT (kode_bps) WHERE deleted_at IS NULL
         DO UPDATE SET nama = EXCLUDED.nama, provinsi_id = EXCLUDED.provinsi_id
         RETURNING id::text AS id`,
        [provinsiId, k.kode, k.nama, k.tipe],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`seed demo: kota ${k.nama} gagal dibuat`);
      hasil.push({ id, nama: k.nama });
    }
    return hasil;
  });
}

/**
 * The period ladder, oldest first, ending at the CURRENT calendar month.
 *
 * This is the fix for the defect recorded in the task brief: the Fase 0 demo
 * seeds only the current month, so report 24's cumulative year-to-date mode
 * refuses with PERIODE_TIDAK_DITEMUKAN for every earlier month of the fiscal
 * year. A ledger cannot be written into a month that has no period either
 * (`PERIODE_TIDAK_OPEN`), so the history has to exist before any transaction
 * can be dated into it.
 *
 * Every period is created OPEN. The generator closes them one at a time,
 * through the closing engine, as it walks forward.
 */
async function pastikanPeriode(
  db: DbPort,
  bumnId: string,
  berjalan: Bulan,
  jumlah: number,
): Promise<PeriodeDemo[]> {
  const awal = bulanTambah(berjalan, -(jumlah - 1));
  await db.query(
    `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
     SELECT $1::uuid,
            extract(year from m)::smallint,
            extract(month from m)::smallint,
            m::date,
            (m + interval '1 month' - interval '1 day')::date,
            'OPEN'
       FROM generate_series(make_date($2::int, $3::int, 1),
                            make_date($4::int, $5::int, 1),
                            interval '1 month') AS m
     ON CONFLICT (bumn_id, tahun, bulan) DO NOTHING`,
    [bumnId, awal.tahun, awal.bulan, berjalan.tahun, berjalan.bulan],
  );

  const rows = await db.query<PeriodeDemo>(
    `SELECT id::text AS id, tahun::int AS tahun, bulan::int AS bulan,
            tanggal_mulai::text AS mulai, tanggal_akhir::text AS akhir, status
       FROM periode
      WHERE bumn_id = $1::uuid AND deleted_at IS NULL
      ORDER BY tahun, bulan`,
    [bumnId],
  );
  const terakhir = rows[rows.length - 1];
  if (!terakhir || terakhir.tahun !== berjalan.tahun || terakhir.bulan !== berjalan.bulan) {
    throw new Error("seed demo: periode berjalan tidak berada di akhir tangga periode");
  }
  return rows;
}

/** Last day of a period, as the engines expect it. */
export function akhirBulan(p: Bulan): string {
  return `${p.tahun}-${p.bulan.toString().padStart(2, "0")}-${hariTerakhir(p.tahun, p.bulan)}`;
}
