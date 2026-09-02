// DEMO ONLY. One account per role in spec 2, plus a second Maker for the
// cross-branch scenario, a SECOND Admin Pusat so a four-eyes approval has a
// second pair of eyes, and a Mitra portal account.
//
// EVERY CREDENTIAL BELOW IS PUBLIC AND MUST NEVER EXIST ON A PRODUCTION
// DATABASE. They are here so "bisa login dengan semua role" (the Fase 0 done
// criterion) is demonstrable in one command, and so the authorisation tests
// have a fixed cast of characters. The shared password is deliberately printed
// in SEED.md and by `db:seed` itself: a demo credential that looks like a
// secret is worse than one that is obviously not.
//
// Usernames match the demo stub in apps/web/src/api/auth.ts, so the SPA
// behaves identically whether it is talking to the stub or to this API. NOTE:
// `adminpusat2` is newer than that stub and is API-side only until somebody
// adds it there; nothing breaks meanwhile, the stub simply cannot log that one
// account in.
//
// Branch layout matches spec 13 and the SPA stub: one pusat plus branches, so
// the cross-branch scenario (spec 16 #24, a Maker from cabang A refused
// cabang B) has real data on both sides.
import type { DbPort, QueryRunner } from "../core/ports/db";

/** DEMO ONLY. Same password for every demo account, on purpose. */
export const DEMO_PASSWORD = "TjslDemo#2026";
export const DEMO_BUMN_KODE = "KRAS";

export interface DemoUserSpec {
  username: string;
  nama: string;
  email: string;
  nip: string;
  role: string;
  cabangKode: string;
  catatan: string;
}

export const DEMO_CABANG = [
  { kode: "00", nama: "Kantor Pusat", isPusat: true },
  { kode: "01", nama: "Cabang Cilegon", isPusat: false },
  { kode: "02", nama: "Cabang Serang", isPusat: false },
] as const;

export const DEMO_USERS: readonly DemoUserSpec[] = [
  {
    username: "maker",
    nama: "Demo Maker Cilegon",
    email: "maker@demo.tjsl.local",
    nip: "D-0001",
    role: "MAKER",
    cabangKode: "01",
    catatan: "Input proposal, survey, akad, pencairan, angsuran, jurnal DRAFT",
  },
  {
    username: "checker",
    nama: "Demo Checker Cilegon",
    email: "checker@demo.tjsl.local",
    nip: "D-0002",
    role: "CHECKER",
    cabangKode: "01",
    catatan: "Review dan rekomendasi, verifikasi jurnal DRAFT",
  },
  {
    username: "approver",
    nama: "Demo Approver Cilegon",
    email: "approver@demo.tjsl.local",
    nip: "D-0003",
    role: "APPROVER",
    cabangKode: "01",
    catatan: "Setujui proposal, posting jurnal, eksekusi closing",
  },
  {
    username: "admincabang",
    nama: "Demo Admin Cabang Cilegon",
    email: "admincabang@demo.tjsl.local",
    nip: "D-0004",
    role: "ADMIN_CABANG",
    cabangKode: "01",
    catatan: "Semua kewenangan operasional, tetap terikat scope Cabang Cilegon",
  },
  {
    username: "maker.serang",
    nama: "Demo Maker Serang",
    email: "maker.serang@demo.tjsl.local",
    nip: "D-0005",
    role: "MAKER",
    cabangKode: "02",
    catatan: "Ada supaya skenario lintas cabang (spec 16 #24) punya data di kedua sisi",
  },
  {
    username: "adminpusat",
    nama: "Demo Admin Pusat",
    email: "adminpusat@demo.tjsl.local",
    nip: "D-0006",
    role: "ADMIN_PUSAT",
    cabangKode: "00",
    catatan: "Lintas cabang, master data, COA, konfigurasi, reopen periode",
  },
  {
    // A SECOND ADMIN PUSAT, AND IT IS NOT A DUPLICATE ACCOUNT.
    //
    // `rka.pemisahan_tugas_persetujuan` ships ON (ASSUMPTIONS.md A-31), so
    // `setujuiRka` refuses an approver who created or last edited the version
    // (KONFLIK_MAKER_APPROVER). `admin.rka` (enter a budget) and
    // `admin.rka.approve` (bless it) are both held by ADMIN_PUSAT alone, by
    // deliberate decision recorded in modules/auth/permissions.ts and
    // OPEN-QUESTIONS 26: an Admin Cabang may READ a budget, never approve one.
    //
    // With ONE Admin Pusat account, the drafter is therefore always the only
    // possible approver, every approval is refused, and no demo database can
    // ever hold a DISETUJUI baseline. Report 24 defaults to that baseline and
    // refuses with BASELINE_TIDAK_ADA without one, so the budget-versus-
    // realisation report could not be demonstrated at all.
    //
    // The fix belongs HERE, in the cast of characters, not in the control. The
    // alternatives were considered and rejected: turning the segregation key
    // off for the demo would demonstrate a system that does not have the
    // control the client is buying; granting `admin.rka.approve` to APPROVER or
    // ADMIN_CABANG would hand budget approval to a branch, which is the exact
    // question OPEN-QUESTIONS 26 answered the other way. A second holder of the
    // same role is also what the real installation looks like: an entity with
    // one head-office administrator cannot operate ANY four-eyes rule.
    //
    // modules/rka's own fixture reached the same conclusion first and calls it
    // `adminPusatLain` (see apps/api/src/modules/rka/test-support.ts): "with
    // one holder of the approval right there is nobody for a 'someone else must
    // approve' rule to hand the document to, and the test would be asserting
    // the absence of a control rather than the control".
    username: "adminpusat2",
    nama: "Demo Admin Pusat Dua",
    email: "adminpusat2@demo.tjsl.local",
    nip: "D-0008",
    role: "ADMIN_PUSAT",
    cabangKode: "00",
    catatan:
      "Admin Pusat kedua, supaya persetujuan RKA punya pihak kedua (pemisahan tugas maker/approver)",
  },
  {
    username: "auditor",
    nama: "Demo Auditor",
    email: "auditor@demo.tjsl.local",
    nip: "D-0007",
    role: "AUDITOR",
    cabangKode: "00",
    catatan: "Lintas cabang, read only penuh termasuk audit trail. Tidak bisa mengubah apa pun",
  },
];

/** DEMO ONLY. Mitra portal login (portal_akun_mitra, spec 4.9 / 9.5). */
export const DEMO_MITRA = {
  kodeMitra: "MTR-DEMO-0001",
  nama: "Warung Sembako Demo",
  email: "mitra@demo.tjsl.local",
  cabangKode: "01",
} as const;

export interface SeedDemoResult {
  bumnId: string;
  cabang: Record<string, string>;
  users: Record<string, string>;
  mitraId: string;
  portalAkunId: string;
  password: string;
}

export interface SeedDemoOptions {
  /** argon2id cost. Lowered only by the test harness. */
  passwordOptions?: { memoryCost?: number; timeCost?: number };
  /** Seeds the current calendar month as an OPEN periode. */
  withPeriode?: boolean;
  /**
   * Connection string of the target, checked against the production guard
   * below. Omit only when the caller has already established that the target
   * is disposable (the test harness has).
   */
  targetUrl?: string;
}

/**
 * Databases this seed may write to: a name that ends in `_dev`, `_test`,
 * `_local` or `_demo`.
 *
 * WHY A NAME CHECK AND NOT A FLAG. Every "are you sure" flag is one
 * copy-pasted command away from being set in the wrong shell. The database
 * NAME travels with the target, so a production URL simply cannot satisfy this
 * regardless of which flags an operator passes or which env file got sourced.
 * `tools/db.ts` uses the same idea for its destructive commands.
 */
const NAMA_DB_BOLEH_DEMO = /_(dev|test|local|demo)$/;

export function databaseBolehDemo(connectionString: string): boolean {
  const withoutQuery = connectionString.split("?")[0] ?? "";
  const name = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return NAMA_DB_BOLEH_DEMO.test(name);
}

/** Marks a row as belonging to this seed, so it is never confused with a real one. */
const DEMO_EMAIL_DOMAIN = "@demo.tjsl.local";

async function upsertBumn(tx: QueryRunner): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO bumn (kode, nama, npwp, alamat, tahun_buku_mulai_bulan)
     VALUES ($1, 'PT Krakatau Steel (Persero) Tbk', '00.000.000.0-000.000', 'Cilegon, Banten', 1)
     ON CONFLICT (kode) WHERE deleted_at IS NULL DO UPDATE SET nama = EXCLUDED.nama
     RETURNING id::text AS id`,
    [DEMO_BUMN_KODE],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("seed demo: bumn gagal dibuat");
  return id;
}

export async function seedDemo(db: DbPort, options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  if (options.targetUrl !== undefined && !databaseBolehDemo(options.targetUrl)) {
    throw new Error(
      "Menolak menulis akun demo ke database ini: namanya tidak berakhiran " +
        "_dev, _test, _local atau _demo. Kredensial demo di file ini publik " +
        "(SEED.md mencantumkannya), jadi menuliskannya ke database produksi " +
        "sama dengan memberi akses Admin Pusat ke siapa pun yang bisa membaca repo.",
    );
  }

  const passwordHash = await Bun.password.hash(DEMO_PASSWORD, {
    algorithm: "argon2id",
    ...options.passwordOptions,
  });

  return db.transaction(async (tx) => {
    const bumnId = await upsertBumn(tx);

    const cabang: Record<string, string> = {};
    for (const entry of DEMO_CABANG) {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO cabang (bumn_id, kode, nama, alamat, is_pusat, aktif)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (bumn_id, kode) WHERE deleted_at IS NULL
         DO UPDATE SET nama = EXCLUDED.nama, aktif = true
         RETURNING id::text AS id`,
        [bumnId, entry.kode, entry.nama, `${entry.nama}, Banten`, entry.isPusat],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`seed demo: cabang ${entry.kode} gagal dibuat`);
      cabang[entry.kode] = id;
    }

    const users: Record<string, string> = {};
    for (const spec of DEMO_USERS) {
      const cabangId = cabang[spec.cabangKode];
      if (!cabangId) throw new Error(`seed demo: cabang ${spec.cabangKode} tidak ada`);

      // NEVER OVERWRITE AN ACCOUNT THIS SEED DOES NOT OWN. The usernames here
      // are ordinary words (`maker`, `auditor`, `admincabang`), so a real
      // deployment can easily already have one. Re-running the seed used to
      // reset that person's PASSWORD to the public demo password and replace
      // their roles. A row is ours only if its email is in the demo domain.
      const existing = await tx.query<{ email: string }>(
        `SELECT email FROM app_user WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
        [spec.username],
      );
      const email = existing[0]?.email;
      if (email !== undefined && !email.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN)) {
        throw new Error(
          `Menolak menimpa akun "${spec.username}" (${email}): akun itu bukan milik seed demo. ` +
            "Hapus atau ganti nama akun tersebut lebih dulu, atau jalankan seed tanpa data demo.",
        );
      }

      const rows = await tx.query<{ id: string }>(
        `INSERT INTO app_user (cabang_id, nip, nama, email, username, password_hash, aktif)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (lower(username)) WHERE deleted_at IS NULL
         DO UPDATE SET password_hash = EXCLUDED.password_hash,
                       nama = EXCLUDED.nama,
                       cabang_id = EXCLUDED.cabang_id,
                       aktif = true
         RETURNING id::text AS id`,
        [cabangId, spec.nip, spec.nama, spec.email, spec.username, passwordHash],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`seed demo: user ${spec.username} gagal dibuat`);
      users[spec.username] = id;

      await tx.query(
        `INSERT INTO user_role (user_id, role_id)
         SELECT $1, r.id FROM app_role r WHERE r.kode = $2 AND r.deleted_at IS NULL
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [id, spec.role],
      );
      // A demo account holds exactly the role it is named after: leaving a
      // stale second role behind would quietly break the very authorisation
      // demo these accounts exist for.
      await tx.query(
        `DELETE FROM user_role
          WHERE user_id = $1
            AND role_id <> (SELECT id FROM app_role WHERE kode = $2 AND deleted_at IS NULL)`,
        [id, spec.role],
      );

      // Every demo user is also a karyawan, so they can be picked as a survey
      // officer in Fase 3 without a second seed.
      await tx.query(
        `INSERT INTO karyawan (cabang_id, nip, nama, jabatan, unit, aktif)
         VALUES ($1, $2, $3, $4, 'TJSL', true)
         ON CONFLICT (nip) WHERE nip IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET nama = EXCLUDED.nama, cabang_id = EXCLUDED.cabang_id`,
        [cabangId, spec.nip, spec.nama, spec.role],
      );
    }

    const cabangMitra = cabang[DEMO_MITRA.cabangKode];
    if (!cabangMitra) throw new Error("seed demo: cabang mitra tidak ada");
    const mitraRows = await tx.query<{ id: string }>(
      `INSERT INTO mitra (cabang_id, kode_mitra, nama_lengkap, nama_usaha, email, telepon, status, aktif)
       VALUES ($1, $2, $3, $4, $5, '0800-0000-0000', 'CALON', true)
       ON CONFLICT (kode_mitra) WHERE deleted_at IS NULL
       DO UPDATE SET nama_lengkap = EXCLUDED.nama_lengkap
       RETURNING id::text AS id`,
      [cabangMitra, DEMO_MITRA.kodeMitra, "Demo Mitra Binaan", DEMO_MITRA.nama, DEMO_MITRA.email],
    );
    const mitraId = mitraRows[0]?.id;
    if (!mitraId) throw new Error("seed demo: mitra gagal dibuat");

    const portalRows = await tx.query<{ id: string }>(
      `INSERT INTO portal_akun_mitra (mitra_id, email, password_hash, verified_at, aktif)
       VALUES ($1, $2, $3, now(), true)
       ON CONFLICT (mitra_id) WHERE deleted_at IS NULL
       DO UPDATE SET password_hash = EXCLUDED.password_hash, email = EXCLUDED.email, aktif = true
       RETURNING id::text AS id`,
      [mitraId, DEMO_MITRA.email, passwordHash],
    );
    const portalAkunId = portalRows[0]?.id;
    if (!portalAkunId) throw new Error("seed demo: portal_akun_mitra gagal dibuat");

    if (options.withPeriode !== false) {
      const now = new Date();
      await tx.query(
        // Explicit ::int casts: make_date() takes integer while periode.tahun
        // is smallint, and Postgres refuses to deduce one type for a parameter
        // used in both places.
        `INSERT INTO periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
         VALUES ($1, $2::int, $3::int, make_date($2::int, $3::int, 1),
                 (make_date($2::int, $3::int, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date, 'OPEN')
         ON CONFLICT (bumn_id, tahun, bulan) DO NOTHING`,
        [bumnId, now.getFullYear(), now.getMonth() + 1],
      );
    }

    return { bumnId, cabang, users, mitraId, portalAkunId, password: DEMO_PASSWORD };
  });
}
